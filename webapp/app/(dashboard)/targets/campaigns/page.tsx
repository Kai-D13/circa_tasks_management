import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { createClient } from '@/lib/supabase/server'
import { isSuperAdminEmail } from '@/lib/authz'
import { isKpiCampaignEnabled, isKpiAffiliateEnabled } from '@/lib/kpi/flags'
import { CampaignsTabs } from '@/components/kpi/CampaignsTabs'
import { Card, CardContent } from '@/components/ui/card'
import { buttonVariants } from '@/components/ui/button'
import { CampaignStatusButton } from '@/components/kpi/CampaignStatusButton'
import { STATUS_META, TEST_BADGE_CLS } from '@/lib/kpi/status'
import { qualityKpiPass } from '@/lib/kpi/orderAov'
import { campaignOverviewValue } from '@/lib/kpi/campaignDisplay'
import { formatDate, formatDateTime } from '@/lib/dateUtils'
import { cn } from '@/lib/utils'
import { Plus, Megaphone, ChevronRight } from 'lucide-react'

// Super-admin campaign dashboard (mockup "Các chiến dịch KPI đang áp dụng"):
// each campaign row shows Mục tiêu (SUM kpi_target) / Đã đạt (SUM actual_value)
// / % + progress bar / store count / last sync. Aggregates are computed
// app-side from two light queries (few campaigns × ≤26 stores).

// Mig 103: 'Mục tiêu/Đã đạt' theo đơn vị metric của TỪNG campaign (khách/₫)
// qua metricPresentation — gmv byte-equal formatter cũ.
const drange = (s: string, e: string) => `${formatDate(s)} – ${formatDate(e)}`

export default async function CampaignsPage() {
  const { user, profile } = await getSessionProfile()
  if (!user) notFound()
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email) && isKpiCampaignEnabled())) notFound()

  const supabase = await createClient()
  const [
    { data: campaigns, error: campaignsErr },
    { data: targets, error: targetsErr },
    { data: actuals, error: actualsErr },
  ] = await Promise.all([
    supabase.from('kpi_campaigns')
      .select('id, name, start_date, end_date, status, is_test, updated_at, metric_type')
      .is('archived_at', null) // Archive (098): campaign lưu trữ biến mất khỏi list
      .order('created_at', { ascending: false }),
    supabase.from('kpi_campaign_store_targets').select('campaign_id, kpi_target'),
    supabase.from('kpi_campaign_store_actuals').select('campaign_id, actual_value, synced_at'),
  ])
  // A failed side-query must NOT render as "0đ / chưa đồng bộ" — that reads as
  // real data on a money screen. Surface it like the detail page does.
  const queryError = campaignsErr?.message ?? targetsErr?.message ?? actualsErr?.message ?? null
  if (queryError) console.error('[campaigns-list] query failed:', queryError)

  const agg = new Map<string, { stores: number; target: number; actual: number; pass: number; lastSync: string | null }>()
  const blank = () => ({ stores: 0, target: 0, actual: 0, pass: 0, lastSync: null as string | null })
  for (const t of (targets ?? [])) {
    const a = agg.get(t.campaign_id as string) ?? blank()
    a.stores += 1
    a.target += Number(t.kpi_target) || 0
    agg.set(t.campaign_id as string, a)
  }
  for (const r of (actuals ?? [])) {
    const a = agg.get(r.campaign_id as string) ?? blank()
    a.actual += Number(r.actual_value) || 0
    // 106: đạt KPI = completion >= 100 ⟺ đạt CẢ HAI mục tiêu (KHÔNG suy từ bậc).
    if (qualityKpiPass(r.actual_value as number | null)) a.pass += 1
    if (!a.lastSync || (r.synced_at as string) > a.lastSync) a.lastSync = r.synced_at as string
    agg.set(r.campaign_id as string, a)
  }

  const list = (campaigns ?? []) as { id: string; name: string; start_date: string; end_date: string; status: string; is_test: boolean; updated_at: string; metric_type?: string }[]
  const counts = {
    total: list.length,
    active: list.filter((c) => c.status === 'active').length,
    paused: list.filter((c) => c.status === 'paused').length,
    draft: list.filter((c) => c.status === 'draft').length,
  }

  return (
    <div data-layout-width="fluid" className="p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Megaphone className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold">Chiến dịch KPI</h1>
        </div>
        <Link href="/targets/campaigns/new" className={cn(buttonVariants({ size: 'sm' }))}>
          <Plus className="h-4 w-4 mr-1" /> Tạo chiến dịch
        </Link>
      </div>

      {/* P3-I: tab Affiliate overview — chỉ render khi KPI_AFFILIATE_ENABLED */}
      <CampaignsTabs active="campaigns" affiliateEnabled={isKpiAffiliateEnabled()} />

      {queryError && (
        <p className="text-sm text-destructive">
          Lỗi truy vấn dữ liệu campaign: {queryError} — kiểm tra migration 070/071/072 đã apply chưa.
        </p>
      )}

      {/* Summary strip — dashboard feel: how many campaigns, in which states */}
      {list.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[
            { label: 'Tổng chiến dịch', value: counts.total, dot: 'bg-primary' },
            { label: 'Đang chạy', value: counts.active, dot: 'bg-status-success' },
            { label: 'Tạm dừng', value: counts.paused, dot: 'bg-status-warning' },
            { label: 'Nháp', value: counts.draft, dot: 'bg-muted-foreground/40' },
          ].map((s) => (
            <Card key={s.label}>
              <CardContent className="px-3 py-2.5 flex items-center gap-2.5">
                <span className={cn('h-2 w-2 rounded-full shrink-0', s.dot)} />
                <div className="min-w-0">
                  <p className="text-lg font-bold leading-tight">{s.value}</p>
                  <p className="text-[11px] text-muted-foreground truncate">{s.label}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {list.length === 0 ? (
        <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">Chưa có chiến dịch nào. Bấm “Tạo chiến dịch” để bắt đầu.</CardContent></Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            {list.map((c) => {
              const s = STATUS_META[c.status] ?? STATUS_META.draft
              const a = agg.get(c.id) ?? blank()
              const synced = a.lastSync !== null
              // Step 5.1: dòng giá trị + % lấy TỪ CONTRACT dùng chung
              // (campaignOverviewValue) thay vì tự dựng tại chỗ. Chính hàm này
              // đang phục vụ màn tổng hợp của SM, nên Super và SM không thể đọc
              // ra hai con số khác nhau cho cùng một chiến dịch. Nó cũng tự lo
              // ca 106: "Mục tiêu/Đã đạt" bằng tiền là vô nghĩa với Chất lượng
              // bán hàng (kpi_target là điểm 100 chuẩn hoá) ⇒ đổi sang số cửa
              // hàng ĐẠT KPI.
              const ov = campaignOverviewValue({
                metricType: c.metric_type,
                synced,
                storeCount: a.stores,
                totalTarget: a.target,
                totalActual: a.actual,
                qualityPassCount: a.pass,
              })
              const pct = ov.pct
              // Luật màu màn tiền: xám khi chưa đồng bộ (0% không được đọc như
              // kết quả thật), cam thương hiệu khi đang chạy, xanh chỉ khi ≥100%
              // (brand guide: xanh giữ vai trò điểm nhấn nhỏ).
              const barCls = !synced ? 'bg-muted-foreground/30' : pct >= 100 ? 'bg-status-success' : 'bg-primary'
              const pctCls = !synced ? 'text-muted-foreground' : pct >= 100 ? 'text-status-success' : 'text-primary'
              const progress = (
                <div className="flex items-center gap-2">
                  <div className="h-2 flex-1 rounded-full bg-muted overflow-hidden">
                    <div className={cn('h-full rounded-full', barCls)} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
                  </div>
                  <span className={cn('text-xs font-semibold w-11 text-right', pctCls)}>{ov.pctText}</span>
                </div>
              )
              // Một nguồn cho cả hai bố cục — mobile và desktop KHÔNG được tự
              // format lại rồi lệch nhau.
              const valueLines = (
                <>
                  {ov.lines.map((l) => (
                    <p key={l.label}>
                      <span className="text-muted-foreground">{l.label}: </span>
                      <span className="font-semibold">{l.value}</span>
                    </p>
                  ))}
                </>
              )
              return (
                <div key={c.id} className="px-4 py-3.5 border-t first:border-t-0 hover:bg-muted/30 transition-colors">
                  <div className="flex items-start md:items-center gap-3">
                    <span
                      className={cn(
                        'hidden sm:flex h-10 w-10 rounded-lg items-center justify-center shrink-0',
                        c.status === 'active' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
                      )}
                    >
                      <Megaphone className="h-5 w-5" />
                    </span>

                    {/* Name + range + status */}
                    <div className="min-w-0 flex-[1.4]">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Link href={`/targets/campaigns/${c.id}`} className="text-[15px] font-semibold hover:text-primary hover:underline truncate">
                          {c.name}
                        </Link>
                        <span className={cn('text-[11px] px-2 py-0.5 rounded-full font-medium shrink-0', s.cls)}>{s.label}</span>
                        {c.is_test && <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full shrink-0', TEST_BADGE_CLS)}>TEST</span>}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {drange(c.start_date, c.end_date)} · {a.stores} cửa hàng
                        {a.lastSync ? ` · Đồng bộ ${formatDateTime(a.lastSync)}` : ' · Chưa đồng bộ'}
                      </p>
                      {/* Mobile: money + progress stay visible — this is a money screen */}
                      <div className="mt-2 md:hidden space-y-1.5">
                        <div className="text-sm space-y-0.5">{valueLines}</div>
                        {progress}
                      </div>
                    </div>

                    {/* Targets + actual (desktop) */}
                    <div className="hidden md:block flex-1 text-sm">
                      {valueLines}
                    </div>

                    {/* Progress (desktop) */}
                    <div className="hidden md:block w-40 shrink-0">{progress}</div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <CampaignStatusButton id={c.id} status={c.status} name={c.name} />
                      <Link href={`/targets/campaigns/${c.id}`} aria-label={`Xem ${c.name}`} className="text-muted-foreground hover:text-primary">
                        <ChevronRight className="h-4 w-4" />
                      </Link>
                    </div>
                  </div>
                </div>
              )
            })}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
