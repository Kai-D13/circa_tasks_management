import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { redirectIfFsStaff } from '@/lib/fs/isolation'
import { isSuperAdminEmail, getSmStoreIds } from '@/lib/authz'
import { Card, CardContent } from '@/components/ui/card'
import { PageHeader } from '@/components/ds/PageHeader'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { EmptyState } from '@/components/ds/EmptyState'
import { ErrorState } from '@/components/ds/ErrorState'
import { PeriodTabs, type TargetPeriod } from '@/components/targets/PeriodTabs'
import { CampaignCardList } from '@/components/kpi/CampaignCardList'
import { CampaignKpiView, type CampaignView } from '@/components/kpi/CampaignKpiView'
import { CampaignResultSummary } from '@/components/kpi/CampaignResultSummary'
import { isKpiCampaignEnabled, isKpiAffiliateEnabled } from '@/lib/kpi/flags'
import { isReferralEnabled } from '@/lib/affiliate/flags'
import { AffiliateQrCard } from '@/components/affiliate/AffiliateQrCard'
import { AffiliateGmvCard } from '@/components/affiliate/AffiliateGmvCard'
import { AFFILIATE_QR_FILTER, qrCardVisible, qrCardKey, qrEligibleRole } from '@/lib/affiliate/qrDisplay'
import { CampaignResultDashboard } from '@/components/kpi/CampaignResultDashboard'
import { buildCampaignResultModel, smScopeState, type ResultActualRow, type ResultCampaign, type ResultTargetRow } from '@/lib/kpi/resultModel'
import { reduceAffiliateAgg, currentVnMonthISO, overviewVisibleFor, canShowOwnOsGmv, type AffiliateAggInput } from '@/lib/affiliate/overview'
import { vnDayRange } from '@/lib/kpi/engine'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { getAffiliateSyncHealth, supabaseAffiliateHealthDb } from '@/lib/affiliate/health'
import { ReferralCard, type ReferralItem } from '@/components/referral/ReferralCard'
import { formatDate, formatDateTime, currentWeekStart } from '@/lib/dateUtils'
import { cn } from '@/lib/utils'
import { Target, TrendingUp } from 'lucide-react'

// KPI v2 (migration 067): Day / Week / Month sales targets from the daily
// BigQuery feed (store_kpi_targets, fed by /api/cron/pull-kpi-targets).
//   staff       → their store's card for the selected period (?period=)
//   super admin → all-stores table for the selected period
//   everyone else (PIC / store_manager / SM) → no access per spec
// All 3 periods (day/week/month) display UNIFORMLY: one KPI summary card =
// actual vs target (SUM of daily final_target) + run-rate + remaining + status.
// (The old week-only "pace" card was removed — there's no weekly-specific target
// anymore; every grain just sums the daily final_target.)

const vnd = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : `${new Intl.NumberFormat('vi-VN').format(Math.round(n))}₫`

const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`

// Subtitle for the current-period card. Week range comes straight from the data
// (period_start – period_end), so it always matches the aggregated grain.
function currentLabel(period: TargetPeriod, start: string, end: string): string {
  if (period === 'day') return `Hôm nay · ${dmy(start)}`
  if (period === 'month') return `Tháng ${start.slice(5, 7)}/${start.slice(0, 4)}`
  return `Tuần ${start.slice(8, 10)}/${start.slice(5, 7)} – ${end.slice(8, 10)}/${end.slice(5, 7)}`
}

const NOUN: Record<TargetPeriod, string> = { day: 'ngày', week: 'tuần', month: 'tháng' }
const TITLE: Record<TargetPeriod, string> = { day: 'Doanh số hôm nay', week: 'Doanh số tuần', month: 'Doanh số tháng' }

// KPI goal badge. Sits on the coral gradient hero, so it keeps its own
// high-contrast white treatment there (DS status tokens are tuned for neutral
// surfaces); wording + the "no target → never đã/chưa đạt" rule are unchanged.
function GoalBadge({ status, hasGoal = true }: { status: string | null; hasGoal?: boolean }) {
  const s = status?.toLowerCase()
  const known = s === 'achieved' || s === 'not achieved'
  // No target set (or unknown status) → neutral, never "đã/chưa đạt".
  if (!hasGoal || !known) {
    return (
      <span className="text-xs px-2 py-0.5 rounded font-medium bg-white/20 text-white whitespace-nowrap">
        Chưa có mục tiêu
      </span>
    )
  }
  const achieved = s === 'achieved'
  return (
    <span className={cn(
      'text-xs px-2 py-0.5 rounded font-medium whitespace-nowrap',
      achieved ? 'bg-white text-primary' : 'bg-white/20 text-white',
    )}>
      {achieved ? 'Đã đạt mục tiêu' : 'Chưa đạt mục tiêu'}
    </span>
  )
}

interface KpiRecord {
  period_type:      TargetPeriod
  period_start:     string
  period_end:       string
  actual:           number
  target:           number
  run_rate:         number | null
  status:           string | null
  remaining_target: number | null
  refreshed_at:     string
  stores?:          { name: string } | null
}

// KPI summary (gradient) card — shared by all three periods.
function KpiSummaryCard({
  noun, label, status, hasGoal, actual, goal, pct, remaining, achieved,
}: {
  noun: string; label: string; status: string | null; hasGoal: boolean
  actual: number; goal: number; pct: number; remaining: number | null; achieved: boolean
}) {
  return (
    <div className="rounded-xl bg-gradient-to-br from-primary to-orange-600 text-white p-4 space-y-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="flex items-center gap-1.5 font-semibold text-sm uppercase tracking-wide">
            <Target className="h-4 w-4" />
            KPI {noun}
          </p>
          <p className="text-xs text-white/80 mt-0.5">{label}</p>
        </div>
        <GoalBadge status={status} hasGoal={hasGoal} />
      </div>

      <div>
        <p className="text-xs uppercase text-white/80">Còn thiếu</p>
        <p className="text-3xl font-bold leading-tight">
          {!hasGoal ? '—' : achieved ? '0₫' : vnd(remaining)}
        </p>
        <p className="text-xs text-white/80 mt-0.5">để đạt mục tiêu {noun}</p>
      </div>

      <div className="space-y-1.5">
        <p className="text-right text-xs font-semibold">{pct.toFixed(1)}%</p>
        <div className="h-2.5 w-full rounded-full bg-white/25 overflow-hidden">
          <div className="h-full rounded-full bg-white" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
        </div>
        <div className="flex items-end justify-between text-xs">
          <div>
            <p className="font-semibold text-sm">{vnd(actual)}</p>
            <p className="text-white/80">Đã đạt</p>
          </div>
          <div className="text-right">
            <p className="font-semibold text-sm">{hasGoal ? vnd(goal) : 'Chưa cập nhật'}</p>
            <p className="text-white/80">Mục tiêu {noun}</p>
          </div>
        </div>
      </div>
    </div>
  )
}

function parsePeriod(v: string | undefined): TargetPeriod {
  return v === 'day' || v === 'month' ? v : 'week'
}

// SM's assigned stores (id + name) for the store selector. getSmStoreIds reads
// sm_store_assignments (RLS ssa_select_sm) → then resolve names.
// H1.2 (27/07): CHỈ store OS đang ACTIVE — store soft-deactivate (mig 074, vd
// Belvita) lọt vào sẽ đứng đầu theo sort tên → thành store mặc định rỗng
// khiến SM kẹt; khớp luôn boundary os+active của Affiliate Overview (r1.2b).
// r3 (27/07): trả error tách bạch — lỗi DB/RLS không được giả dạng "0 store"
// (trước đây [] khi lỗi → redirect /tasks che mất sự cố).
async function fetchSmStores(
  supabase: Awaited<ReturnType<typeof createClient>>,
  smUserId: string,
): Promise<{ stores: { id: string; name: string }[]; error: string | null }> {
  const ids = await getSmStoreIds(supabase, smUserId)
  if (ids.length === 0) return { stores: [], error: null }
  const { data, error } = await supabase
    .from('stores').select('id, name')
    .in('id', ids)
    .eq('is_active', true)
    .eq('store_type', 'os')
    .order('name')
  if (error) return { stores: [], error: error.message }
  return { stores: (data ?? []) as { id: string; name: string }[], error: null }
}

// Fetch the store's ACTIVE campaigns (RLS: kct_read_store + can_read_kpi_campaign
// scopes to own store + active + non-test) joined with tiers + actual snapshots.
async function fetchCampaignViews(
  supabase: Awaited<ReturnType<typeof createClient>>,
  storeId: string,
): Promise<CampaignView[]> {
  const [{ data: targets, error: tErr }, { data: actuals, error: aErr }] = await Promise.all([
    supabase
      .from('kpi_campaign_store_targets')
      .select('kpi_target, store_kpi_group, campaign:kpi_campaigns!inner(id, name, start_date, end_date, metric_offline, metric_affiliate), kpi_campaign_store_tiers(tier_order, threshold_pct, commission_amount)')
      .eq('store_id', storeId),
    supabase
      .from('kpi_campaign_store_actuals')
      .select('campaign_id, actual_value, actual_offline, actual_affiliate, run_rate, remaining_target, achieved_tier_order, store_commission_pool, offline_synced_at, affiliate_synced_at, synced_at')
      .eq('store_id', storeId),
  ])
  if (tErr || aErr) {
    // Campaign read failure must never take down the whole Doanh số page — log
    // and fall back to the period view.
    console.error('[targets] campaign query failed:', tErr?.message ?? aErr?.message)
    return []
  }
  const actualByCampaign = new Map(
    ((actuals ?? []) as { campaign_id: string; actual_value: number; actual_offline: number | null; actual_affiliate: number | null; run_rate: number | null; remaining_target: number | null; achieved_tier_order: number | null; store_commission_pool: number | null; offline_synced_at: string | null; affiliate_synced_at: string | null; synced_at: string }[])
      .map((a) => [a.campaign_id, a]),
  )
  return ((targets ?? []) as unknown as {
    kpi_target: number
    store_kpi_group: string | null
    campaign: { id: string; name: string; start_date: string; end_date: string; metric_offline: boolean; metric_affiliate: boolean }
    kpi_campaign_store_tiers: { tier_order: number; threshold_pct: number; commission_amount: number }[]
  }[])
    .map((t) => {
      const a = actualByCampaign.get(t.campaign.id)
      return {
        id: t.campaign.id,
        name: t.campaign.name,
        start_date: t.campaign.start_date,
        end_date: t.campaign.end_date,
        kpi_target: Number(t.kpi_target) || 0,
        store_kpi_group: t.store_kpi_group ?? null,
        tiers: t.kpi_campaign_store_tiers ?? [],
        actual_value: a ? Number(a.actual_value) : null,
        run_rate: a?.run_rate ?? null,
        remaining_target: a?.remaining_target ?? null,
        achieved_tier_order: a?.achieved_tier_order ?? null,
        store_commission_pool: a?.store_commission_pool ?? null,
        synced_at: a?.synced_at ?? null,
        metric_offline: t.campaign.metric_offline === true,
        metric_affiliate: t.campaign.metric_affiliate === true,
        actual_offline: a?.actual_offline !== null && a?.actual_offline !== undefined ? Number(a.actual_offline) : null,
        actual_affiliate: a?.actual_affiliate !== null && a?.actual_affiliate !== undefined ? Number(a.actual_affiliate) : null,
        offline_synced_at: a?.offline_synced_at ?? null,
        affiliate_synced_at: a?.affiliate_synced_at ?? null,
      }
    })
    .sort((a, b) => a.end_date.localeCompare(b.end_date)) // nearest deadline first
}

export default async function TargetsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; campaign?: string; store?: string }>
}) {
  const params = await searchParams
  const period = parsePeriod(params.period)

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('users').select('role, store_id, phone_number, stores!users_store_id_fkey(name)').eq('id', user.id).single()
  await redirectIfFsStaff(supabase, profile) // FS staff never see OS surfaces

  const isSuper = profile?.role === 'admin' && isSuperAdminEmail(user.email)
  const isStaff = profile?.role === 'staff'
  const isStoreMgr = profile?.role === 'store_manager'
  const isSm = profile?.role === 'sm'
  const campaignEnabled = isKpiCampaignEnabled()

  // SM (area manager) manages several stores via sm_store_assignments (store_id
  // is null). They get a campaign VIEW scoped to a chosen store (store selector).
  const smStoresRes = isSm && campaignEnabled
    ? await fetchSmStores(supabase, user.id)
    : { stores: [] as { id: string; name: string }[], error: null as string | null }
  const smStores = smStoresRes.stores

  // Store managers/SM only have a Doanh số view through campaigns (no day/week/
  // month RLS access) — without the flag they keep the old redirect. SM needs at
  // least one assigned store.
  if (!isStaff && !isSuper
      && !(isStoreMgr && campaignEnabled)
      // r3 (27/07): SM có LỖI query store vẫn vào branch để thấy ErrorState —
      // không redirect /tasks che sự cố; chỉ redirect khi query sạch + 0 store.
      && !(isSm && campaignEnabled && (smStores.length > 0 || smStoresRes.error !== null))) redirect('/tasks')

  const vnTodayISO = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)

  // Store scope cho QR/GMV landing: staff/store_manager → store mình. SM KHÔNG
  // còn chọn-1-store (SM Dashboard r2 = regional multi-store, branch riêng dưới).
  const resolvedStoreId = isSm ? undefined : (profile?.store_id ?? undefined)

  // ── Campaign mode (Staff + Store Manager): active campaigns REPLACE the
  //    Ngày/Tuần/Tháng tabs; no campaign → staff falls back to the period view,
  //    manager gets an empty state. (SM dùng regional dashboard riêng.) ───────
  const campaignViews = campaignEnabled && (isStaff || isStoreMgr) && resolvedStoreId
    ? await fetchCampaignViews(supabase, resolvedStoreId)
    : []

  // Campaign LIST landing (stakeholder): /targets is always the campaign card
  // list when the store has any active campaign; a ?campaign=<id> opens detail.
  const showCampaignList = campaignViews.length > 0 && !params.campaign
  const campaignHref = (cid: string) => `/targets?campaign=${cid}`
  const campaignListHref = '/targets'

  // Daily GMV series for the SELECTED campaign (drives the chart + "GMV hôm nay").
  // Selection resolved here so the fetch matches what the component will render.
  let selectedCampaignId: string | undefined
  let campaignDaily: { date: string; gmv: number; gmv_affiliate: number }[] = []
  let campaignDailyError = false
  if (campaignViews.length > 0 && resolvedStoreId && !showCampaignList) {
    selectedCampaignId = (campaignViews.find((c) => c.id === params.campaign) ?? campaignViews[0]).id
    const { data: dailyRows, error: dErr } = await supabase
      .from('kpi_campaign_store_daily_actuals')
      .select('date, gmv, gmv_affiliate')
      .eq('campaign_id', selectedCampaignId)
      .eq('store_id', resolvedStoreId)
      .order('date')
    if (dErr) {
      // Degrade with a visible hint (not silently as "no data yet").
      console.error('[targets] daily query failed:', dErr.message)
      campaignDailyError = true
    }
    campaignDaily = ((dailyRows ?? []) as { date: string; gmv: number; gmv_affiliate: number | null }[])
      .map((r) => ({ date: r.date, gmv: Number(r.gmv) || 0, gmv_affiliate: Number(r.gmv_affiliate) || 0 }))
  }

  // ── P3-H: QR Affiliate của store — CHỈ landing (không hiện trong ?campaign=),
  //    chỉ khi KPI_AFFILIATE_ENABLED bật; 1 query mapping RLS-scoped (session
  //    client — staff/SM/store_manager đọc qua policy apm_select_store_qr, mig
  //    095); ảnh tĩnh public GCS, KHÔNG gọi Mongo. Hiện CẢ khi store không có
  //    campaign active (giới thiệu khách không phụ thuộc vòng đời campaign). ──
  type AffiliateQrRow = { partner_code: string; qr_image_url: string | null; qr_destination_url: string | null }
  // Contract query/render/trạng thái = lib/affiliate/qrDisplay (thuần, có test).
  // Slice C (audit 24/07): SM KHÔNG thấy QR — qrEligibleRole chỉ nhận staff/
  // store_manager (app không query; RLS 097 chặn tầng DB). SM giữ card GMV +
  // link Overview phía dưới.
  const showAffiliateQr = qrCardVisible({
    flagEnabled: isKpiAffiliateEnabled(),
    eligibleRole: qrEligibleRole(profile?.role),
    storeResolved: !!resolvedStoreId,
    inCampaignDetail: !!params.campaign,
  })

  // ── P3-I: GMV Affiliate tháng hiện tại cho SM/QLCH (own OS store) — CHỈ ĐỌC
  //    snapshot Supabase (RPC service_role qua admin; authz app-layer:
  //    resolvedStoreId đã derive server-side từ profile/sm assignments). Staff
  //    KHÔNG thấy (overviewVisibleFor='none'). KHÔNG nút đồng bộ. ──
  const gmvAccess = overviewVisibleFor({
    isSuper: false, // các nhánh landing dưới đây chỉ dành cho staff/sm/store_manager
    role: profile?.role,
    flagEnabled: isKpiAffiliateEnabled(),
  })
  let showAffiliateGmv = gmvAccess === 'own-os' && !!resolvedStoreId && !params.campaign
  const gmvMonth = currentVnMonthISO(vnTodayISO)
  const gmvMonthLabel = `Tháng ${gmvMonth.from.slice(5, 7)}/${gmvMonth.from.slice(0, 4)}`
  let affiliateGmv = { gmv: 0, orders: 0 }
  let affiliateGmvError = false
  let affiliateGmvSyncedAt: string | null = null
  let affiliateGmvWarning: string | null = null
  if (showAffiliateGmv && resolvedStoreId) {
    // r1 (audit P1#1): RPC chạy service-role — RLS không cứu được lớp này nên
    // BẮT BUỘC verify store là OS + active TRƯỚC khi gọi (canShowOwnOsGmv, có
    // test). FS Store Manager / SM gán nhầm FS → ẩn card, 0 call RPC.
    const { data: gmvStoreRow } = await supabase
      .from('stores').select('store_type, is_active').eq('id', resolvedStoreId).maybeSingle()
    if (!canShowOwnOsGmv(gmvStoreRow as { store_type: string; is_active: boolean } | null)) {
      showAffiliateGmv = false
    } else {
      // r1.1 (audit HEALTH FAIL-CLOSED): health TRƯỚC (đầy đủ — r1 P2#5), CHỈ
      // gọi RPC khi nguồn READY; !ready → không aggregate, card hiện '—' +
      // lý do cụ thể + lần sync thành công gần nhất — không bao giờ 0 giả.
      const health = await getAffiliateSyncHealth(supabaseAffiliateHealthDb(supabaseAdmin), [resolvedStoreId])
      affiliateGmvSyncedAt = health.lastSuccessAt
      if (!health.ready) {
        affiliateGmvWarning = health.reason
      } else {
        const range = vnDayRange(gmvMonth.from, gmvMonth.to)
        const { data: aggData, error: aggErr } = await supabaseAdmin
          .rpc('rpc_aggregate_affiliate_gmv', { p_store_ids: [resolvedStoreId], p_from: range.from, p_to: range.to })
        if (aggErr) {
          // Gồm cả fail-closed (đơn DELIVERED thiếu completed_time) — card hiện lỗi gọn.
          console.error('[targets] affiliate gmv query failed:', aggErr.message)
          affiliateGmvError = true
        } else {
          const r = reduceAffiliateAgg((aggData ?? []) as AffiliateAggInput[])
          const a = r.byStore.get(resolvedStoreId)
          affiliateGmv = { gmv: a?.gmv ?? 0, orders: a?.orders ?? 0 }
        }
      }
    }
  }
  let affiliateQr: AffiliateQrRow | null = null
  let affiliateQrError = false
  if (showAffiliateQr && resolvedStoreId) {
    const { data: qrRow, error: qrErr } = await supabase
      .from('affiliate_partner_mappings')
      .select('partner_code, qr_image_url, qr_destination_url')
      .eq('store_id', resolvedStoreId)
      .match(AFFILIATE_QR_FILTER)
      .not('qr_image_url', 'is', null)
      .limit(1)
      .maybeSingle()
    if (qrErr) {
      // r1 (audit P2 #3): lỗi DB/RLS/migration ≠ "chưa cấu hình" — card hiện
      // "Không tải được mã QR", không giả dạng missing.
      console.error('[targets] affiliate qr query failed:', qrErr.message)
      affiliateQrError = true
    }
    affiliateQr = (qrRow as AffiliateQrRow | null) ?? null
  }

  // ── SM REGIONAL DASHBOARD (r2, stakeholder 27/07): thay store-view cũ bằng
  //    dashboard vùng DÙNG CHUNG model/component với Super — read-only, không
  //    action quản trị. Data = 2 query session-client: RLS 075 tự scope về
  //    store được phân công + campaign active/!is_test (KHÔNG loop per store,
  //    KHÔNG supabaseAdmin). ────────────────────────────────────────────────
  if (isSm) {
    // r3: lỗi query store → ErrorState, không redirect che sự cố.
    if (smStoresRes.error) {
      return (
        <div className="p-4 md:p-6 space-y-4 max-w-5xl">
          <PageHeader title="Doanh số chiến dịch" icon={TrendingUp} />
          <ErrorState message="Không tải được danh sách cửa hàng được phân công" hint={`${smStoresRes.error} — thử tải lại hoặc báo Admin.`} />
        </div>
      )
    }

    type SmTargetJoinRow = ResultTargetRow & { campaign_id: string; kpi_campaigns: ResultCampaign | null }
    type SmActualJoinRow = ResultActualRow & { campaign_id: string }
    const [tRes, aRes] = await Promise.all([
      supabase
        .from('kpi_campaign_store_targets')
        .select('id, campaign_id, store_id, pos_code, kpi_target, store_kpi_group, stores(name), kpi_campaign_store_tiers(tier_order, threshold_pct, commission_amount), kpi_campaigns(id, name, start_date, end_date, status, metric_offline, metric_affiliate)')
        .order('pos_code'),
      supabase
        .from('kpi_campaign_store_actuals')
        .select('campaign_id, store_id, actual_value, actual_offline, actual_affiliate, run_rate, remaining_target, achieved_tier_order, store_commission_pool, offline_synced_at, affiliate_synced_at, synced_at'),
    ])
    // r3: lỗi DB/RLS → ErrorState — KHÔNG render "chưa có chiến dịch" giả.
    if (tRes.error || aRes.error) {
      const msg = (tRes.error ?? aRes.error)!.message
      console.error('[targets] sm dashboard query failed:', msg)
      return (
        <div className="p-4 md:p-6 space-y-4 max-w-5xl">
          <PageHeader title="Doanh số chiến dịch" icon={TrendingUp} />
          <ErrorState message="Không tải được dữ liệu chiến dịch" hint={`${msg} — thử tải lại hoặc báo Admin.`} />
        </div>
      )
    }
    const smTargetRows = (tRes.data ?? []) as unknown as SmTargetJoinRow[]
    const smActualRows = (aRes.data ?? []) as unknown as SmActualJoinRow[]

    // Gom theo campaign — rows đã được RLS scope đúng phạm vi SM.
    const byCampaign = new Map<string, { campaign: ResultCampaign; targets: ResultTargetRow[]; actuals: ResultActualRow[] }>()
    for (const t of smTargetRows) {
      if (!t.kpi_campaigns) continue
      const e = byCampaign.get(t.campaign_id) ?? { campaign: t.kpi_campaigns, targets: [], actuals: [] }
      e.targets.push(t)
      byCampaign.set(t.campaign_id, e)
    }
    for (const a of smActualRows) byCampaign.get(a.campaign_id)?.actuals.push(a)

    // ── Detail (?campaign=) — dashboard read-only + filter store ──
    if (params.campaign) {
      const entry = byCampaign.get(params.campaign)
      const storeParam = params.store
      const storeParamInScope = !!storeParam && smStores.some((s) => s.id === storeParam)
      const scope = smScopeState(!!entry, storeParam, storeParamInScope)
      if (scope !== 'ok' || !entry) {
        // r3: campaign/store ngoài scope → forbidden, KHÔNG fallback dữ liệu khác.
        return (
          <div className="p-4 md:p-6 space-y-4 max-w-5xl">
            <PageHeader title="Doanh số chiến dịch" icon={TrendingUp} />
            <Link href="/targets" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground min-h-[44px] md:min-h-0">← Danh sách chiến dịch</Link>
            <ErrorState
              message={scope === 'store-out-of-scope'
                ? 'Cửa hàng không thuộc phạm vi quản lý của bạn'
                : 'Chiến dịch không thuộc phạm vi quản lý của bạn'}
              hint="Kiểm tra lại đường dẫn hoặc quay về danh sách chiến dịch."
            />
          </div>
        )
      }
      // Filter store — mặc định TẤT CẢ cửa hàng được phân công trong campaign.
      const fTargets = storeParam ? entry.targets.filter((t) => t.store_id === storeParam) : entry.targets
      const fActuals = storeParam ? entry.actuals.filter((a) => a.store_id === storeParam) : entry.actuals
      const model = buildCampaignResultModel(entry.campaign, fTargets, fActuals, vnTodayISO)
      const scopeStores = smStores.filter((s) => entry.targets.some((t) => t.store_id === s.id))
      return (
        <div className="p-4 md:p-6 space-y-4 max-w-5xl">
          <PageHeader title="Doanh số chiến dịch" icon={TrendingUp} />
          <div>
            <Link href="/targets" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground min-h-[44px] md:min-h-0">← Danh sách chiến dịch</Link>
            <div className="flex items-center gap-2 flex-wrap mt-1">
              <h2 className="text-lg font-bold">{entry.campaign.name}</h2>
              <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">{model.deadlineLabel}</span>
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">
              {formatDate(entry.campaign.start_date)} – {formatDate(entry.campaign.end_date)} · {entry.targets.length} cửa hàng thuộc phạm vi bạn quản lý
            </p>
          </div>
          {scopeStores.length > 1 && (
            <div className="flex gap-2 overflow-x-auto pb-1 -mb-1">
              <Link
                href={`/targets?campaign=${entry.campaign.id}`}
                className={cn(
                  'shrink-0 whitespace-nowrap text-xs px-3 inline-flex items-center min-h-[44px] md:min-h-0 md:py-1.5 rounded-full border font-medium transition-colors',
                  !storeParam ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                              : 'border-border text-muted-foreground hover:text-primary hover:bg-primary/5',
                )}
              >
                Tất cả cửa hàng
              </Link>
              {scopeStores.map((s) => (
                <Link
                  key={s.id}
                  href={`/targets?campaign=${entry.campaign.id}&store=${s.id}`}
                  className={cn(
                    'shrink-0 whitespace-nowrap text-xs px-3 inline-flex items-center min-h-[44px] md:min-h-0 md:py-1.5 rounded-full border font-medium transition-colors',
                    storeParam === s.id ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                                        : 'border-border text-muted-foreground hover:text-primary hover:bg-primary/5',
                  )}
                >
                  {s.name}
                </Link>
              ))}
            </div>
          )}
          <CampaignResultDashboard model={model} emptyHint="Chưa có dữ liệu kết quả trong phạm vi của bạn." />
          <p className="text-[11px] text-muted-foreground">Chế độ xem Quản lý vùng — chỉ đọc · số liệu giới hạn trong các cửa hàng bạn quản lý.</p>
        </div>
      )
    }

    // ── LIST landing: campaign nào áp dụng ≥1 store SM quản lý; deadline gần
    //    nhất lên đầu (chốt stakeholder: list trước, click mở Result). ──
    const smCampaigns = [...byCampaign.values()]
      .map((e) => ({ id: e.campaign.id, model: buildCampaignResultModel(e.campaign, e.targets, e.actuals, vnTodayISO) }))
      .sort((x, y) => x.model.campaign.end_date.localeCompare(y.model.campaign.end_date))
    return (
      <div className="p-4 md:p-6 space-y-4 max-w-5xl">
        <PageHeader
          title="Doanh số chiến dịch"
          icon={TrendingUp}
          subtitle={`Phạm vi: ${smStores.length} cửa hàng bạn quản lý`}
        />
        {smCampaigns.length === 0 ? (
          <EmptyState className="py-12" icon={TrendingUp} title="Chưa có chiến dịch nào áp dụng cho các cửa hàng bạn quản lý." />
        ) : (
          <div className="space-y-3">
            {smCampaigns.map(({ id: cid, model }) => {
              const synced = model.lastSyncedAt !== null
              const pct = model.completionPct
              return (
                <Link key={cid} href={`/targets?campaign=${cid}`} className="block">
                  <Card className="hover:border-primary/40 transition-colors">
                    <CardContent className="p-4 space-y-2">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <p className="font-semibold">{model.campaign.name}</p>
                        <span className="text-xs text-muted-foreground">{model.deadlineLabel}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {formatDate(model.campaign.start_date)} – {formatDate(model.campaign.end_date)} · {model.storeCount} cửa hàng
                      </p>
                      <p className="text-sm">
                        <span className="text-muted-foreground">Mục tiêu </span><span className="font-semibold">{vnd(model.totalTarget)}</span>
                        <span className="text-muted-foreground"> · Đã đạt </span><span className="font-semibold">{synced ? vnd(model.totalActual) : '—'}</span>
                      </p>
                      {/* Money-screen rule: xám tới khi sync (0% không được đọc như kết quả thật) */}
                      <div className="flex items-center gap-2">
                        <div className="h-2 flex-1 rounded-full bg-muted overflow-hidden">
                          <div
                            className={cn('h-full rounded-full', !synced ? 'bg-muted-foreground/30' : pct >= 100 ? 'bg-green-500' : 'bg-primary')}
                            style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
                          />
                        </div>
                        <span className={cn('text-xs font-semibold w-11 text-right', !synced ? 'text-muted-foreground' : pct >= 100 ? 'text-green-600' : 'text-primary')}>
                          {synced ? `${pct.toFixed(1)}%` : '—'}
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              )
            })}
          </div>
        )}
        {/* SM regional không còn card GMV per-store — Affiliate xem tại màn tổng
            hợp (scope các store phân công); giữ đường vào. */}
        {isKpiAffiliateEnabled() && (
          <Card>
            <CardContent className="p-4 flex items-center justify-between gap-2 flex-wrap">
              <p className="text-sm font-medium">Doanh số Affiliate — Circa Online</p>
              <Link href="/targets/campaigns/affiliate" className="text-xs font-medium text-primary hover:underline inline-flex items-center min-h-[44px] md:min-h-0">
                Xem chi tiết Affiliate →
              </Link>
            </CardContent>
          </Card>
        )}
      </div>
    )
  }

  if (isStoreMgr) {
    const storeName = (profile?.stores as unknown as { name: string } | null)?.name ?? 'Cửa hàng của bạn'
    // H2 (stakeholder 27/07): desktop shell chuẩn admin (max-w-5xl); landing
    // md+ = grid 2 cột (nội dung campaign + cột phụ QR/GMV); mobile giữ 1 cột
    // đúng thứ tự cũ (content → QR → GMV).
    const mgrSideCards = (showAffiliateQr || showAffiliateGmv) ? (
      <>
        {showAffiliateQr && (
          <AffiliateQrCard
            key={qrCardKey(resolvedStoreId ?? null, affiliateQr?.qr_image_url ?? null)}
            storeName={storeName}
            partnerCode={affiliateQr?.partner_code ?? null}
            imageUrl={affiliateQr?.qr_image_url ?? null}
            destinationUrl={affiliateQr?.qr_destination_url ?? null}
            queryError={affiliateQrError}
          />
        )}
        {showAffiliateGmv && (
          <AffiliateGmvCard
            monthLabel={gmvMonthLabel}
            gmv={affiliateGmv.gmv}
            orders={affiliateGmv.orders}
            syncedAt={affiliateGmvSyncedAt}
            error={affiliateGmvError}
            sourceWarning={affiliateGmvWarning}
            detailHref="/targets/campaigns/affiliate"
          />
        )}
      </>
    ) : null
    return (
      <div className="p-4 md:p-6 space-y-4 max-w-5xl">
        <PageHeader
          title="Doanh số chiến dịch"
          icon={TrendingUp}
          /* Campaign view carries its own store pill (r3) — avoid duplicating */
          actions={campaignViews.length === 0 ? <span className="text-sm text-muted-foreground">{storeName}</span> : undefined}
        />
        <div className={cn('grid grid-cols-1 gap-4 items-start', mgrSideCards && 'md:grid-cols-[minmax(0,1fr)_340px]')}>
          <div className="space-y-4 min-w-0">
            {campaignViews.length === 0 ? (
              <EmptyState className="py-12" icon={TrendingUp} title="Hiện chưa có chiến dịch doanh số đang áp dụng." />
            ) : showCampaignList ? (
              <CampaignCardList items={campaignViews} hrefFor={campaignHref} />
            ) : (
              <>
                <Link href={campaignListHref} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground min-h-[44px] md:min-h-0 -my-2.5 md:my-0">← Danh sách chiến dịch</Link>
                <CampaignResultSummary
                  campaign={campaignViews.find((c) => c.id === selectedCampaignId) ?? campaignViews[0]}
                  todayISO={vnTodayISO}
                />
                <CampaignKpiView items={campaignViews} selectedId={selectedCampaignId} daily={campaignDaily} dailyError={campaignDailyError} roleLabel="Quản lý" todayISO={vnTodayISO} storeName={storeName} />
              </>
            )}
          </div>
          {mgrSideCards && <div className="space-y-4 min-w-0">{mgrSideCards}</div>}
        </div>
      </div>
    )
  }

  // ── Staff: own store's card for the selected period (store_kpi_targets,
  //    fed by the BigQuery cron "Pull KPI targets") ──────────────────────────
  if (isStaff) {
    if (!profile?.store_id) {
      return (
        <div className="p-4 space-y-4">
          <PageHeader title="Doanh số" icon={TrendingUp} />
          <EmptyState title="Tài khoản chưa được gán cửa hàng" hint="Vui lòng liên hệ Admin." />
        </div>
      )
    }
    const { data: rows, error: rowsError } = await supabase
      .from('store_kpi_targets')
      .select('period_type, period_start, period_end, actual, target, run_rate, status, remaining_target, refreshed_at')
      .eq('store_id', profile.store_id)
      .eq('period_type', period)
      .order('period_start', { ascending: false })
      .limit(6)
    if (rowsError) {
      console.error('[targets] staff query failed:', rowsError.message)
      return (
        <div className="p-4 space-y-4">
          <PageHeader title="Doanh số" icon={TrendingUp} />
          <ErrorState message="Không tải được dữ liệu doanh số" hint="Vui lòng thử lại sau hoặc báo Admin." />
        </div>
      )
    }

    const allRows = (rows ?? []) as KpiRecord[]
    // Current period: day = today, month = first-of-month, week = the row whose
    // [start, weekEnd] range contains today (handles the month-end extended week).
    const currentStart = period === 'day'
      ? vnTodayISO
      : period === 'month'
        ? `${vnTodayISO.slice(0, 7)}-01`
        : currentWeekStart(allRows.map((r) => r.period_start), vnTodayISO)
    const current = allRows.find((r) => r.period_start === currentStart)
    const storeName = (profile.stores as unknown as { name: string } | null)?.name ?? 'Cửa hàng của bạn'

    // Referral campaign card (staff_referrals; RLS filters to this staff's phone).
    // REFERRAL_ENABLED=false (chương trình đã ngưng) → không query, không render
    // card lẫn prompt SĐT — Affiliate thế chỗ, code/data referral giữ nguyên.
    const referralOn = isReferralEnabled()
    const staffPhone = (profile as { phone_number?: string | null }).phone_number ?? null
    let referral: { total: number; success: number; sameDay: number; noOrder: number; items: ReferralItem[] } | null = null
    let referralError = false
    if (referralOn && staffPhone) {
      const { data: refRows, error: refErr } = await supabase
        .from('staff_referrals')
        .select('referred_phone, status, referral_date, same_day_order')
        .order('referral_date', { ascending: false, nullsFirst: false })
      if (refErr) {
        console.error('[referral] staff query failed:', refErr.message)
        referralError = true
      } else if (refRows && refRows.length > 0) {
        const items = (refRows as ReferralItem[]).filter((r) => r.referred_phone)
        const success = items.filter((r) => (r.status ?? '').toUpperCase() === 'SUCCESS').length
        const sameDay = items.filter((r) => r.same_day_order).length
        referral = { total: items.length, success, sameDay, noOrder: items.length - sameDay, items }
      }
    }

    // ── Campaign mode: active campaigns REPLACE the Ngày/Tuần/Tháng tabs ─────
    if (campaignViews.length > 0) {
      return (
        <div className="p-4 space-y-4 max-w-xl mx-auto">
          <PageHeader title="Doanh số chiến dịch" icon={TrendingUp} />
          {/* Card list to pick a campaign (stakeholder); a picked/single one → detail */}
          {showCampaignList ? (
            <CampaignCardList items={campaignViews} hrefFor={campaignHref} />
          ) : (
            <>
              <Link href={campaignListHref} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground min-h-[44px] md:min-h-0 -my-2.5 md:my-0">← Danh sách chiến dịch</Link>
              <CampaignKpiView items={campaignViews} selectedId={selectedCampaignId} daily={campaignDaily} dailyError={campaignDailyError} roleLabel="Dược sĩ" todayISO={vnTodayISO} storeName={storeName} />
            </>
          )}
          {/* "Giới thiệu bạn bè" belongs on the /targets landing (list / single-
              campaign home) — hidden inside a drilled-in campaign detail (?campaign). */}
          {!params.campaign && (
            <>
              {/* P3-H: QR ngay dưới danh sách chiến dịch */}
              {showAffiliateQr && (
                <AffiliateQrCard
                  key={qrCardKey(resolvedStoreId ?? null, affiliateQr?.qr_image_url ?? null)}
                  storeName={storeName}
                  partnerCode={affiliateQr?.partner_code ?? null}
                  imageUrl={affiliateQr?.qr_image_url ?? null}
                  destinationUrl={affiliateQr?.qr_destination_url ?? null}
                  queryError={affiliateQrError}
                />
              )}
              {referral && <ReferralCard {...referral} />}
              {referralError && (
                <ErrorState message="Không tải được dữ liệu chương trình giới thiệu" hint="Vui lòng thử lại sau hoặc báo Admin." />
              )}
              {referralOn && staffPhone === null && (
                <Card className="rounded-lg">
                  <CardContent className="py-4 text-sm text-muted-foreground">
                    Cập nhật <span className="font-medium">số điện thoại</span> (biểu tượng &ldquo;Sửa thông tin&rdquo; ở đầu trang) để xem chương trình giới thiệu bạn bè.
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </div>
      )
    }

    // KPI v2 uniform rule: target = SUM(final_target), no separate weekly min.
    const hasGoal = (current?.target ?? 0) > 0
    const goal = hasGoal ? (current!.target as number) : 0
    const pct = hasGoal ? (current!.actual / goal) * 100 : 0
    const remaining = hasGoal
      ? (current!.remaining_target ?? Math.max(goal - (current!.actual ?? 0), 0))
      : null
    const achieved = hasGoal && (remaining ?? 1) <= 0

    const emptyMsg = period === 'day'
      ? 'Chưa có dữ liệu doanh số hôm nay (dữ liệu cập nhật trong ngày).'
      : `Chưa có dữ liệu doanh số ${NOUN[period]} cho cửa hàng của bạn.`

    return (
      <div className="p-4 space-y-4 max-w-xl mx-auto">
        <PageHeader
          title={TITLE[period]}
          icon={TrendingUp}
          actions={<span className="text-sm text-muted-foreground">{storeName}</span>}
        />

        <PeriodTabs period={period} />

        {!current ? (
          <EmptyState className="py-12" icon={TrendingUp} title={emptyMsg} />
        ) : (
          <>
            {/* KPI summary card — identical for day / week / month */}
            <KpiSummaryCard
              noun={NOUN[period]}
              label={currentLabel(period, current.period_start, current.period_end)}
              status={current.status}
              hasGoal={hasGoal}
              actual={current.actual}
              goal={goal}
              pct={pct}
              remaining={remaining}
              achieved={achieved}
            />

            <p className="text-[11px] text-muted-foreground">
              Cập nhật lúc {formatDateTime(current.refreshed_at)} · Nguồn: báo cáo BI · * Không bao gồm đơn online
            </p>
          </>
        )}

        {/* P3-H: QR hiện cả khi store chưa có campaign active (giới thiệu khách
            không phụ thuộc vòng đời campaign) */}
        {showAffiliateQr && (
          <AffiliateQrCard
            key={qrCardKey(resolvedStoreId ?? null, affiliateQr?.qr_image_url ?? null)}
            storeName={storeName}
            partnerCode={affiliateQr?.partner_code ?? null}
            imageUrl={affiliateQr?.qr_image_url ?? null}
            destinationUrl={affiliateQr?.qr_destination_url ?? null}
            queryError={affiliateQrError}
          />
        )}

        {/* Referral campaign ("Giới thiệu bạn bè") — under Doanh số */}
        {referral && <ReferralCard {...referral} />}
        {referralError && (
          <ErrorState message="Không tải được dữ liệu chương trình giới thiệu" hint="Vui lòng thử lại sau hoặc báo Admin." />
        )}
        {referralOn && staffPhone === null && (
          <Card className="rounded-lg">
            <CardContent className="py-4 text-sm text-muted-foreground">
              Cập nhật <span className="font-medium">số điện thoại</span> (biểu tượng &ldquo;Sửa thông tin&rdquo; ở đầu trang) để xem chương trình giới thiệu bạn bè.
            </CardContent>
          </Card>
        )}
      </div>
    )
  }

  // ── Super admin: all stores for the selected period ────────────────────────
  const { data: allRows, error: allRowsError } = await supabase
    .from('store_kpi_targets')
    .select('period_type, period_start, period_end, actual, target, run_rate, status, remaining_target, refreshed_at, stores(name)')
    .eq('period_type', period)
    .order('period_start', { ascending: false })
    .order('refreshed_at', { ascending: false })
    .limit(200)

  const allTargetRows = (allRows ?? []) as unknown as KpiRecord[]
  const currentStart = period === 'day'
    ? vnTodayISO
    : period === 'month'
      ? `${vnTodayISO.slice(0, 7)}-01`
      : currentWeekStart(allTargetRows.map((r) => r.period_start), vnTodayISO)
  const periodRows = allTargetRows
    .filter((r) => r.period_start === currentStart)
    .sort((a, b) => (a.stores?.name ?? '').localeCompare(b.stores?.name ?? '', 'vi'))

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-5xl">
      <PageHeader
        title={`${TITLE[period]} theo cửa hàng`}
        icon={TrendingUp}
        subtitle={periodRows.length > 0 && currentStart
          ? `${currentLabel(period, currentStart, periodRows[0]?.period_end ?? currentStart)} · ${periodRows.length} cửa hàng · cập nhật ${formatDateTime(periodRows[0]?.refreshed_at ?? '')}`
          : 'Chưa có dữ liệu cho kỳ này — kiểm tra cron /api/cron/pull-kpi-targets đã chạy chưa.'}
      />
      {allRowsError && (
        <ErrorState
          message="Lỗi truy vấn dữ liệu doanh số"
          hint={`${allRowsError.message} — kiểm tra migration 067 đã apply chưa.`}
        />
      )}

      <PeriodTabs period={period} />

      {periodRows.length > 0 && (
        <Card className="rounded-lg">
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="border-b">
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Cửa hàng</th>
                  <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">Mục tiêu</th>
                  <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">Thực đạt</th>
                  <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">% Run rate</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Trạng thái</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {periodRows.map((r) => (
                  <tr key={`${r.period_start}-${r.stores?.name}`} className="hover:bg-muted/30">
                    <td className="px-4 py-2.5 font-medium">{r.stores?.name ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right text-muted-foreground">{vnd(r.target)}</td>
                    <td className="px-4 py-2.5 text-right">{vnd(r.actual)}</td>
                    <td className="px-4 py-2.5 text-right">
                      {r.run_rate !== null ? `${r.run_rate.toFixed(1)}%` : '—'}
                    </td>
                    {/* Neutral surface → DS status tokens (the hero's GoalBadge
                        is white-on-coral and would vanish here). */}
                    <td className="px-4 py-2.5">
                      {(r.target ?? 0) > 0 && (r.status?.toLowerCase() === 'achieved' || r.status?.toLowerCase() === 'not achieved') ? (
                        <StatusBadge tone={r.status?.toLowerCase() === 'achieved' ? 'success' : 'warning'}>
                          {r.status?.toLowerCase() === 'achieved' ? 'Đã đạt mục tiêu' : 'Chưa đạt mục tiêu'}
                        </StatusBadge>
                      ) : (
                        <StatusBadge tone="neutral">Chưa có mục tiêu</StatusBadge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
