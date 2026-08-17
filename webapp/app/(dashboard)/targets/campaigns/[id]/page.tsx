import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { createClient } from '@/lib/supabase/server'
import { isSuperAdminEmail } from '@/lib/authz'
import { isKpiAffiliateEnabled, isKpiCampaignEnabled } from '@/lib/kpi/flags'
import { Card, CardContent } from '@/components/ui/card'
import { CampaignStatusButton } from '@/components/kpi/CampaignStatusButton'
import { CampaignImport } from '@/components/kpi/CampaignImport'
import { CampaignMetricEditor } from '@/components/kpi/CampaignMetricEditor'
import { SyncActualsButton } from '@/components/kpi/SyncActualsButton'
import { CampaignExportButton } from '@/components/kpi/CampaignExportButton'
import { CampaignResultDashboard } from '@/components/kpi/CampaignResultDashboard'
import { CampaignDateRangeFilter } from '@/components/kpi/CampaignDateRangeFilter'
import { parseCampaignRange, rangeFilterVisibleForRole } from '@/lib/kpi/campaignDateRange'
import { createRangeReadDeps } from '@/lib/kpi/campaignRangeDeps'
import { loadCampaignRangeActuals } from '@/lib/kpi/campaignRangeServer'
import { metricPresentation } from '@/lib/kpi/campaignDisplay'
import { buildCampaignResultModel, type ResultActualRow, type ResultCampaign, type ResultTargetRow } from '@/lib/kpi/resultModel'
import { STATUS_META, TEST_BADGE_CLS } from '@/lib/kpi/status'
import { formatDate, formatDateTime } from '@/lib/dateUtils'
import { cn } from '@/lib/utils'
import { ChevronLeft, SlidersHorizontal, BarChart3, type LucideIcon } from 'lucide-react'

// Campaign detail — ONE url, TWO tabs (?tab=):
//   config → campaign info + import + the IMPORTED configuration only
//   result → synced actuals: summary cards + per-store results + sync button
// Default tab follows the lifecycle: draft/paused → config, active/ended → result.

const vnd = (n: number) => `${new Intl.NumberFormat('vi-VN').format(Math.round(n))}₫`

interface TierRow { tier_order: number; threshold_pct: number; commission_amount: number }
interface TargetRow {
  id: string; store_id: string; pos_code: string | null; kpi_target: number
  store_kpi_group: string | null
  stores: { name: string } | null
  kpi_campaign_store_tiers: TierRow[]
  // Mig 106 — chỉ campaign Chất lượng bán hàng (NULL với 2 loại cũ).
  order_target: number | null; aov_target: number | null
}
interface ActualRow {
  store_id: string; actual_value: number; run_rate: number | null
  remaining_target: number | null; achieved_tier_order: number | null
  store_commission_pool: number | null; synced_at: string
  actual_offline: number | null; actual_affiliate: number | null
  offline_order_count: number | null
  offline_synced_at: string | null; affiliate_synced_at: string | null
}

function TierChips({ tiers }: { tiers: TierRow[] }) {
  if (tiers.length === 0) return <span className="text-xs text-muted-foreground">—</span>
  return (
    <div className="flex flex-wrap gap-1">
      {[...tiers].sort((a, b) => a.tier_order - b.tier_order).map((t) => (
        <span key={t.tier_order} className="inline-flex whitespace-nowrap rounded-full bg-muted px-2 py-0.5 text-[11px]">
          {t.threshold_pct}% → {vnd(t.commission_amount)}
        </span>
      ))}
    </div>
  )
}

export default async function CampaignDetailPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string; from?: string; to?: string }>
}) {
  const { id } = await params
  const sp = await searchParams
  const { user, profile } = await getSessionProfile()
  if (!user) notFound()
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email) && isKpiCampaignEnabled())) notFound()

  const supabase = await createClient()
  const { data: c } = await supabase
    .from('kpi_campaigns').select('id, name, start_date, end_date, status, is_test, updated_at, archived_at, metric_type, metric_offline, metric_affiliate').eq('id', id).single()
  if (!c) notFound()
  // Archive (098): URL campaign đã lưu trữ → 404 (biến mất khỏi mọi UI).
  if (c.archived_at !== null) notFound()

  const tab: 'config' | 'result' = sp.tab === 'config' || sp.tab === 'result'
    ? sp.tab
    : (c.status === 'active' || c.status === 'ended') ? 'result' : 'config'

  const [
    { data: targetsRaw, error: targetsErr },
    { data: runs, error: runsErr },
    { data: actualsRaw, error: actualsErr },
  ] = await Promise.all([
    supabase
      .from('kpi_campaign_store_targets')
      .select('id, store_id, pos_code, kpi_target, store_kpi_group, order_target, aov_target, stores(name), kpi_campaign_store_tiers(tier_order, threshold_pct, commission_amount)')
      .eq('campaign_id', id)
      .order('pos_code'),
    supabase
      .from('kpi_campaign_import_runs')
      .select('file_name, row_count, success_count, created_at')
      .eq('campaign_id', id).order('created_at', { ascending: false }).limit(5),
    supabase
      .from('kpi_campaign_store_actuals')
      .select('store_id, actual_value, actual_offline, actual_affiliate, offline_order_count, actual_customer_count, run_rate, remaining_target, achieved_tier_order, store_commission_pool, offline_synced_at, affiliate_synced_at, synced_at')
      .eq('campaign_id', id),
  ])
  const queryError = targetsErr?.message ?? runsErr?.message ?? actualsErr?.message ?? null
  if (queryError) console.error('[campaign-detail] query failed:', queryError)

  const targets = (targetsRaw ?? []) as unknown as TargetRow[]
  const actuals = (actualsRaw ?? []) as ActualRow[]
  const actualByStore = new Map(actuals.map((a) => [a.store_id, a]))
  const lastSynced = actuals.reduce<string | null>((max, a) => (!max || a.synced_at > max ? a.synced_at : max), null)

  const s = STATUS_META[c.status] ?? STATUS_META.draft
  const canImport = c.status === 'draft' || c.status === 'paused'
  // Mig 103: KPI target theo đơn vị metric (khách/₫); TierChips (commission)
  // vẫn dùng vnd tiền module-level.
  const targetFmt = (n: number) => metricPresentation(c.metric_type as string | undefined).value(n)

  // SM Dashboard r1 (27/07): TOÀN BỘ công thức Kết quả chuyển vào
  // lib/kpi/resultModel (dùng chung Super ↔ SM — một nguồn số duy nhất, test
  // khóa cùng-input-cùng-output); markup summary + bảng → CampaignResultDashboard.
  const vnTodayISO = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)

  // ── Lọc theo khoảng (17/08) — CHỈ ĐỂ XEM ──────────────────────────────────
  // Trang này vốn đã super-only, nhưng vẫn hỏi contract vai trò thay vì suy từ
  // "đã vào được đây": quyền hiển thị filter là một quyết định riêng, có test.
  const canFilter = rangeFilterVisibleForRole({ role: profile?.role, isSuperAdmin: true })
  const range = parseCampaignRange({
    from: canFilter ? sp.from : undefined,
    to: canFilter ? sp.to : undefined,
    campaignStart: c.start_date as string,
    campaignEnd: c.end_date as string,
    metricType: c.metric_type as string | undefined,
  })

  // actuals dùng để HIỂN THỊ. Mặc định = snapshot toàn kỳ (đường production cũ,
  // zero-touch). Chỉ khi range active mới thay phần THỰC ĐẠT.
  let viewActuals = actuals
  let rangeError: string | null = null
  if (range.active) {
    const read = await loadCampaignRangeActuals(createRangeReadDeps(supabase), {
      campaignId: id,
      range,
      metricType: c.metric_type as string | undefined,
    })
    if (!read.ok) {
      // FAIL-VISIBLE: giữ số toàn kỳ nhưng NÓI RÕ là chưa lọc được, không im
      // lặng để người dùng tưởng đang xem khoảng mình chọn.
      rangeError = read.error
    } else {
      const snapshotByStore = actualByStore
      viewActuals = (read.mode === 'daily' ? read.stores : read.stores).map((st) => {
        const snap = snapshotByStore.get(st.store_id)
        const isDaily = read.mode === 'daily'
        const actualValue = isDaily
          ? (st as { actual: number }).actual
          : (st as { customers: number }).customers
        return {
          store_id: st.store_id,
          actual_value: actualValue,
          // run_rate / remaining_target để NULL ⇒ model tự tính lại theo target
          // TOÀN KỲ. Đúng contract: completion = actual khoảng / target toàn kỳ.
          run_rate: null,
          remaining_target: null,
          // Bậc thưởng + commission LUÔN là của toàn kỳ, lấy nguyên từ snapshot.
          // Tuyệt đối không suy lại từ số khoảng.
          achieved_tier_order: snap?.achieved_tier_order ?? null,
          store_commission_pool: snap?.store_commission_pool ?? null,
          synced_at: snap?.synced_at ?? '',
          actual_offline: isDaily ? (st as { offline: number }).offline : null,
          actual_affiliate: isDaily ? (st as { affiliate: number }).affiliate : null,
          offline_order_count: isDaily ? (st as { orders: number | null }).orders : null,
          offline_synced_at: snap?.offline_synced_at ?? null,
          affiliate_synced_at: snap?.affiliate_synced_at ?? null,
        } satisfies ActualRow
      })
    }
  }

  const resultModel = buildCampaignResultModel(
    c as ResultCampaign,
    targets as unknown as ResultTargetRow[],
    viewActuals as ResultActualRow[],
    vnTodayISO,
  )

  // Branded segmented control (review r2): active = Circa coral, inactive =
  // coral text on the tinted track; ~36px touch target.
  const tabLink = (t: 'config' | 'result', label: string, Icon: LucideIcon) => (
    <Link
      href={`/targets/campaigns/${c.id}?tab=${t}`}
      className={cn(
        'inline-flex items-center gap-1.5 px-4 py-2 rounded-md font-medium text-sm transition-colors',
        tab === t
          ? 'bg-primary text-primary-foreground shadow-sm'
          : 'text-primary/80 hover:bg-primary/10 hover:text-primary',
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
    </Link>
  )

  return (
    // r1.6 (P1 UI 29/07): tab Kết quả dùng TOÀN BỘ chiều rộng main content
    // (bảng N cột Bậc động cần chỗ; scroll ngang còn lại nằm TRONG bảng —
    // body không bao giờ scroll ngang).
    // Batch UI 15/08: bỏ ternary — TOÀN TRANG fluid, tab Cấu hình cũng vậy vì
    // trung tâm của nó là bảng nhiều cột; hết dải trắng phải khi zoom-out.
    <div data-layout-width="fluid" className="p-4 md:p-6 space-y-4">
      <div>
        <Link href="/targets/campaigns" className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1">
          <ChevronLeft className="h-3.5 w-3.5" /> Chiến dịch KPI
        </Link>
        <div className="flex items-center justify-between gap-3 flex-wrap mt-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-semibold">{c.name}</h1>
            <span className={cn('text-xs px-2 py-0.5 rounded-full font-medium', s.cls)}>{s.label}</span>
            {c.is_test && <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full', TEST_BADGE_CLS)}>TEST</span>}
          </div>
          <CampaignStatusButton id={c.id} status={c.status} name={c.name} />
        </div>
        <p className="text-sm text-muted-foreground mt-0.5">
          {formatDate(c.start_date)} – {formatDate(c.end_date)} · {targets.length} cửa hàng · {resultModel.deadlineLabel}
        </p>
        {queryError && (
          <p className="text-sm text-destructive mt-1">
            Lỗi truy vấn dữ liệu: {queryError} — kiểm tra migration 070/071/072/092/093 đã apply chưa.
          </p>
        )}
      </div>

      {/* Tabs — one URL, two views */}
      <div className="inline-flex rounded-lg border border-primary/20 bg-secondary p-0.5">
        {tabLink('config', 'Cấu hình', SlidersHorizontal)}
        {tabLink('result', 'Kết quả', BarChart3)}
      </div>

      {tab === 'config' ? (
        <>
          {/* P3-E3: chỉ số doanh số của campaign — sửa khi draft/paused,
              read-only khi active/ended; server action là boundary cuối. */}
          <Card>
            <CardContent className="p-4">
              <p className="text-sm font-medium mb-2">{c.metric_type === 'affiliate_customer_count' ? 'Loại chỉ số' : 'Chỉ số doanh số'}</p>
              <CampaignMetricEditor
                campaignId={c.id}
                status={c.status}
                metricOffline={c.metric_offline === true}
                metricAffiliate={c.metric_affiliate === true}
                affiliateEnabled={isKpiAffiliateEnabled()}
                metricType={c.metric_type as string | undefined}
              />
            </CardContent>
          </Card>

          {canImport && (
            <Card>
              <CardContent className="p-4">
                <p className="text-sm font-medium mb-2">Nạp / cập nhật target (thay toàn bộ)</p>
                <CampaignImport campaignId={c.id} guideDefaultOpen={targets.length === 0} metricType={c.metric_type as string | undefined} />
              </CardContent>
            </Card>
          )}

          {targets.length > 0 ? (
            <Card>
              <CardContent className="p-0 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-xs text-muted-foreground">
                      <th className="text-left px-4 py-2.5">Cửa hàng</th>
                      <th className="text-left px-4 py-2.5">Phân loại</th>
                      <th className="text-right px-4 py-2.5">KPI target</th>
                      <th className="text-left px-4 py-2.5">Bậc (mốc % → Commission)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {targets.map((t) => (
                      <tr key={t.id} className="hover:bg-muted/30">
                        <td className="px-4 py-2.5 font-medium">{t.stores?.name ?? '—'}{t.pos_code ? ` · ${t.pos_code}` : ''}</td>
                        <td className="px-4 py-2.5 text-xs">{t.store_kpi_group ?? '—'}</td>
                        <td className="px-4 py-2.5 text-right">{targetFmt(t.kpi_target)}</td>
                        <td className="px-4 py-2.5"><TierChips tiers={t.kpi_campaign_store_tiers} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          ) : (
            <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">Chưa có target. Nạp file để thêm.</CardContent></Card>
          )}

          {(runs ?? []).length > 0 && (
            <Card>
              <CardContent className="p-4">
                <p className="text-sm font-medium mb-2">Lịch sử nạp file</p>
                <ul className="text-xs text-muted-foreground space-y-1">
                  {(runs ?? []).map((r, i) => (
                    <li key={i}>{formatDateTime(r.created_at as string)} · {r.file_name ?? '—'} · {r.success_count}/{r.row_count} dòng</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </>
      ) : (
        <>
          {/* ── Kết quả ── */}
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs text-muted-foreground">
              <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', lastSynced ? 'bg-status-success' : 'bg-status-warning')} />
              {lastSynced ? `Doanh số đồng bộ ${formatDateTime(lastSynced)}` : 'Chưa đồng bộ doanh số'}
            </span>
            <div className="flex items-center gap-2">
              <CampaignExportButton campaignId={c.id} />
              <SyncActualsButton campaignId={c.id} metricType={c.metric_type as string | undefined} />
            </div>
          </div>

          {/* SM Dashboard r1: summary + bảng chuyển vào CampaignResultDashboard
              (dùng chung SM — model lib/kpi/resultModel, một nguồn số duy nhất) */}
          {canFilter && (
            <CampaignDateRangeFilter
              action={`/targets/campaigns/${c.id}`}
              campaignStart={c.start_date as string}
              campaignEnd={c.end_date as string}
              range={range}
              keepParams={{ tab: 'result' }}
              note={rangeError}
            />
          )}
          <CampaignResultDashboard
            model={resultModel}
            emptyHint="Chưa có target — nạp file ở tab Cấu hình trước."
          />
        </>
      )}
    </div>
  )
}
