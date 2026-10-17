import { notFound } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { createClient } from '@/lib/supabase/server'
import { canManageCampaign, canViewCampaignDashboard } from '@/lib/kpi/campaignAccess'
import { isKpiAffiliateEnabled, isKpiCampaignEnabled } from '@/lib/kpi/flags'
import { CampaignDetailView, type DetailCampaign, type DetailRun, type DetailTargetRow } from '@/components/kpi/CampaignDetailView'
import { parseCampaignRange, rangeFilterVisibleForRole } from '@/lib/kpi/campaignDateRange'
import { createRangeReadDeps } from '@/lib/kpi/campaignRangeDeps'
import { loadCampaignRangeActuals } from '@/lib/kpi/campaignRangeServer'
import { buildCampaignResultModel, type ResultActualRow, type ResultCampaign, type ResultTargetRow } from '@/lib/kpi/resultModel'

// Campaign detail — ONE url, TWO tabs (?tab=):
//   config → campaign info + import + the IMPORTED configuration only
//   result → synced actuals: summary cards + per-store results + sync button
// Default tab follows the lifecycle: draft/paused → config, active/ended → result.
// UI v2 Phase 2 · K-2: phần trình bày ở components/kpi/CampaignDetailView (dùng chung fixture catalog); page giữ
// cổng quyền, chọn tab, 3 truy vấn, lọc khoảng và dựng model — không đổi.

type TargetRow = DetailTargetRow
interface ActualRow {
  store_id: string; actual_value: number; run_rate: number | null
  remaining_target: number | null; achieved_tier_order: number | null
  store_commission_pool: number | null; synced_at: string
  actual_offline: number | null; actual_affiliate: number | null
  offline_order_count: number | null
  offline_synced_at: string | null; affiliate_synced_at: string | null
  // Mig 112 — snapshot toàn kỳ do RPC tự tính (bộ lọc khoảng KHÔNG ghi đè).
  affiliate_order_count: number | null
  bonus_order_count: number | null
  order_bonus_achieved: boolean | null
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
  // 111: SM vào được, CHỈ ĐỌC. Campaign ngoài phạm vi/trạng thái cho phép sẽ
  // không đọc nổi qua RLS ⇒ `!c` bên dưới trả 404 — không cần nhánh riêng.
  if (!(isKpiCampaignEnabled() && canViewCampaignDashboard(profile?.role, user.email))) notFound()
  const canManage = canManageCampaign(profile?.role, user.email)

  const supabase = await createClient()
  const { data: c } = await supabase
    .from('kpi_campaigns').select('id, name, start_date, end_date, status, is_test, updated_at, archived_at, metric_type, metric_offline, metric_affiliate').eq('id', id).single()
  if (!c) notFound()
  // Archive (098): URL campaign đã lưu trữ → 404 (biến mất khỏi mọi UI).
  if (c.archived_at !== null) notFound()

  // SM bị ép sang 'result' kể cả khi tự gõ ?tab=config — tab Cấu hình là màn
  // quản trị (import target, sửa chỉ số), không phải chỗ chỉ-xem.
  const tab: 'config' | 'result' = !canManage
    ? 'result'
    : sp.tab === 'config' || sp.tab === 'result'
      ? sp.tab
      : (c.status === 'active' || c.status === 'ended') ? 'result' : 'config'

  const [
    { data: targetsRaw, error: targetsErr },
    { data: runs, error: runsErr },
    { data: actualsRaw, error: actualsErr },
  ] = await Promise.all([
    supabase
      .from('kpi_campaign_store_targets')
      .select('id, store_id, pos_code, kpi_target, store_kpi_group, order_target, aov_target, minimum_order_target, order_bonus_per_staff, stores(name), kpi_campaign_store_tiers(tier_order, threshold_pct, commission_amount)')
      .eq('campaign_id', id)
      .order('pos_code'),
    // kpi_campaign_import_runs là bảng super-only: với SM nó luôn trả rỗng kèm
    // lỗi RLS, và lỗi đó sẽ nhuộm đỏ banner `queryError` của cả trang. Bỏ hẳn
    // truy vấn thay vì nuốt lỗi.
    canManage
      ? supabase
          .from('kpi_campaign_import_runs')
          .select('file_name, row_count, success_count, created_at')
          .eq('campaign_id', id).order('created_at', { ascending: false }).limit(5)
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from('kpi_campaign_store_actuals')
      .select('store_id, actual_value, actual_offline, actual_affiliate, offline_order_count, actual_customer_count, run_rate, remaining_target, achieved_tier_order, store_commission_pool, offline_synced_at, affiliate_synced_at, synced_at, affiliate_order_count, bonus_order_count, order_bonus_achieved')
      .eq('campaign_id', id),
  ])
  const queryError = targetsErr?.message ?? runsErr?.message ?? actualsErr?.message ?? null
  if (queryError) console.error('[campaign-detail] query failed:', queryError)

  const targets = (targetsRaw ?? []) as unknown as TargetRow[]
  const actuals = (actualsRaw ?? []) as ActualRow[]
  const actualByStore = new Map(actuals.map((a) => [a.store_id, a]))
  const lastSynced = actuals.reduce<string | null>((max, a) => (!max || a.synced_at > max ? a.synced_at : max), null)

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
          // 112: object này dựng MỚI (không spread) — quên copy là khối thưởng
          // thêm biến mất khi bật bộ lọc. Luôn toàn kỳ, nguyên từ snapshot.
          affiliate_order_count: snap?.affiliate_order_count ?? null,
          bonus_order_count: snap?.bonus_order_count ?? null,
          order_bonus_achieved: snap?.order_bonus_achieved ?? null,
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

  return (
    // Toàn trang fluid (r1.6 / batch UI 15/08): bảng N cột cuộn ngang TRONG khung, body không cuộn ngang.
    <CampaignDetailView
      campaign={c as DetailCampaign}
      canManage={canManage}
      tab={tab}
      targets={targets}
      runs={(runs ?? []) as DetailRun[]}
      queryError={queryError}
      affiliateEnabled={isKpiAffiliateEnabled()}
      model={resultModel}
      lastSynced={lastSynced}
      filter={canFilter ? { range, note: rangeError } : null}
    />
  )
}
