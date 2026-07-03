import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { createClient } from '@/lib/supabase/server'
import { isSuperAdminEmail } from '@/lib/authz'
import { isKpiCampaignEnabled } from '@/lib/kpi/flags'
import { Card, CardContent } from '@/components/ui/card'
import { buttonVariants } from '@/components/ui/button'
import { CampaignStatusButton } from '@/components/kpi/CampaignStatusButton'
import { STATUS_META } from '@/lib/kpi/status'
import { formatDate, formatDateTime } from '@/lib/dateUtils'
import { cn } from '@/lib/utils'
import { Plus, Megaphone, ChevronRight } from 'lucide-react'

// Super-admin campaign dashboard (mockup "Các chiến dịch KPI đang áp dụng"):
// each campaign row shows Mục tiêu (SUM kpi_target) / Đã đạt (SUM actual_value)
// / % + progress bar / store count / last sync. Aggregates are computed
// app-side from two light queries (few campaigns × ≤26 stores).

const vnd = (n: number) => `${new Intl.NumberFormat('vi-VN').format(Math.round(n))}₫`
const drange = (s: string, e: string) => `${formatDate(s)} – ${formatDate(e)}`

export default async function CampaignsPage() {
  const { user, profile } = await getSessionProfile()
  if (!user) notFound()
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email) && isKpiCampaignEnabled())) notFound()

  const supabase = await createClient()
  const [{ data: campaigns }, { data: targets }, { data: actuals }] = await Promise.all([
    supabase.from('kpi_campaigns')
      .select('id, name, start_date, end_date, status, is_test, updated_at')
      .order('created_at', { ascending: false }),
    supabase.from('kpi_campaign_store_targets').select('campaign_id, kpi_target'),
    supabase.from('kpi_campaign_store_actuals').select('campaign_id, actual_value, synced_at'),
  ])

  const agg = new Map<string, { stores: number; target: number; actual: number; lastSync: string | null }>()
  for (const t of (targets ?? [])) {
    const a = agg.get(t.campaign_id as string) ?? { stores: 0, target: 0, actual: 0, lastSync: null }
    a.stores += 1
    a.target += Number(t.kpi_target) || 0
    agg.set(t.campaign_id as string, a)
  }
  for (const r of (actuals ?? [])) {
    const a = agg.get(r.campaign_id as string) ?? { stores: 0, target: 0, actual: 0, lastSync: null }
    a.actual += Number(r.actual_value) || 0
    if (!a.lastSync || (r.synced_at as string) > a.lastSync) a.lastSync = r.synced_at as string
    agg.set(r.campaign_id as string, a)
  }

  const list = (campaigns ?? []) as { id: string; name: string; start_date: string; end_date: string; status: string; is_test: boolean; updated_at: string }[]

  return (
    <div className="p-4 md:p-6 max-w-5xl space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Megaphone className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold">Chiến dịch KPI</h1>
        </div>
        <Link href="/targets/campaigns/new" className={cn(buttonVariants({ size: 'sm' }))}>
          <Plus className="h-4 w-4 mr-1" /> Tạo chiến dịch
        </Link>
      </div>

      {list.length === 0 ? (
        <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">Chưa có chiến dịch nào. Bấm “Tạo chiến dịch” để bắt đầu.</CardContent></Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            {list.map((c) => {
              const s = STATUS_META[c.status] ?? STATUS_META.draft
              const a = agg.get(c.id) ?? { stores: 0, target: 0, actual: 0, lastSync: null }
              const pct = a.target > 0 ? (a.actual / a.target) * 100 : 0
              return (
                <div key={c.id} className="flex items-center gap-4 px-4 py-3.5 border-t first:border-t-0 hover:bg-muted/30 transition-colors">
                  {/* Name + range + status */}
                  <div className="min-w-0 flex-[1.4]">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link href={`/targets/campaigns/${c.id}`} className="font-medium hover:text-primary hover:underline truncate">
                        {c.name}
                      </Link>
                      <span className={cn('text-[11px] px-2 py-0.5 rounded font-medium shrink-0', s.cls)}>{s.label}</span>
                      {c.is_test && <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 shrink-0">TEST</span>}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {drange(c.start_date, c.end_date)} · {a.stores} cửa hàng
                      {a.lastSync ? ` · Đồng bộ ${formatDateTime(a.lastSync)}` : ' · Chưa đồng bộ'}
                    </p>
                  </div>

                  {/* Targets + actual */}
                  <div className="hidden sm:block flex-1 text-sm">
                    <p><span className="text-muted-foreground">Mục tiêu: </span><span className="font-semibold">{vnd(a.target)}</span></p>
                    <p><span className="text-muted-foreground">Đã đạt: </span><span className="font-semibold">{a.lastSync ? vnd(a.actual) : '—'}</span></p>
                  </div>

                  {/* Progress */}
                  <div className="hidden md:flex items-center gap-2 w-40 shrink-0">
                    <div className="h-2 flex-1 rounded-full bg-muted overflow-hidden">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
                    </div>
                    <span className="text-xs font-semibold text-primary w-11 text-right">{pct.toFixed(1)}%</span>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <CampaignStatusButton id={c.id} status={c.status} />
                    <Link href={`/targets/campaigns/${c.id}`} aria-label={`Xem ${c.name}`} className="text-muted-foreground hover:text-primary">
                      <ChevronRight className="h-4 w-4" />
                    </Link>
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
