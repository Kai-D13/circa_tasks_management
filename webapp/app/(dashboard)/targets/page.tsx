import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { redirectIfFsStaff } from '@/lib/fs/isolation'
import { isSuperAdminEmail, getSmStoreIds } from '@/lib/authz'
import { Card, CardContent } from '@/components/ui/card'
import { PeriodTabs, type TargetPeriod } from '@/components/targets/PeriodTabs'
import { CampaignCardList } from '@/components/kpi/CampaignCardList'
import { CampaignKpiView, type CampaignView } from '@/components/kpi/CampaignKpiView'
import { CampaignResultSummary } from '@/components/kpi/CampaignResultSummary'
import { isKpiCampaignEnabled } from '@/lib/kpi/flags'
import { ReferralCard, type ReferralItem } from '@/components/referral/ReferralCard'
import { formatDateTime, currentWeekStart } from '@/lib/dateUtils'
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

function StatusBadge({ status, hasGoal = true }: { status: string | null; hasGoal?: boolean }) {
  const s = status?.toLowerCase()
  const known = s === 'achieved' || s === 'not achieved'
  // No target set (or unknown status) → neutral, never "đã/chưa đạt".
  if (!hasGoal || !known) {
    return (
      <span className="text-xs px-2 py-0.5 rounded font-medium bg-muted text-muted-foreground">
        Chưa có mục tiêu
      </span>
    )
  }
  const achieved = s === 'achieved'
  return (
    <span className={cn(
      'text-xs px-2 py-0.5 rounded font-medium',
      achieved ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700',
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
        <StatusBadge status={status} hasGoal={hasGoal} />
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
async function fetchSmStores(
  supabase: Awaited<ReturnType<typeof createClient>>,
  smUserId: string,
): Promise<{ id: string; name: string }[]> {
  const ids = await getSmStoreIds(supabase, smUserId)
  if (ids.length === 0) return []
  const { data } = await supabase.from('stores').select('id, name').in('id', ids).order('name')
  return (data ?? []) as { id: string; name: string }[]
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
      .select('kpi_target, store_kpi_group, campaign:kpi_campaigns!inner(id, name, start_date, end_date), kpi_campaign_store_tiers(tier_order, threshold_pct, commission_amount)')
      .eq('store_id', storeId),
    supabase
      .from('kpi_campaign_store_actuals')
      .select('campaign_id, actual_value, run_rate, remaining_target, achieved_tier_order, store_commission_pool, synced_at')
      .eq('store_id', storeId),
  ])
  if (tErr || aErr) {
    // Campaign read failure must never take down the whole Doanh số page — log
    // and fall back to the period view.
    console.error('[targets] campaign query failed:', tErr?.message ?? aErr?.message)
    return []
  }
  const actualByCampaign = new Map(
    ((actuals ?? []) as { campaign_id: string; actual_value: number; run_rate: number | null; remaining_target: number | null; achieved_tier_order: number | null; store_commission_pool: number | null; synced_at: string }[])
      .map((a) => [a.campaign_id, a]),
  )
  return ((targets ?? []) as unknown as {
    kpi_target: number
    store_kpi_group: string | null
    campaign: { id: string; name: string; start_date: string; end_date: string }
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
  const smStores = isSm && campaignEnabled ? await fetchSmStores(supabase, user.id) : []

  // Store managers/SM only have a Doanh số view through campaigns (no day/week/
  // month RLS access) — without the flag they keep the old redirect. SM needs at
  // least one assigned store.
  if (!isStaff && !isSuper
      && !(isStoreMgr && campaignEnabled)
      && !(isSm && campaignEnabled && smStores.length > 0)) redirect('/tasks')

  const vnTodayISO = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)

  // The store whose campaigns we render: staff/store_manager → own store; SM →
  // the selected store (?store=, else the first assigned one).
  const smSelectedStoreId = isSm && smStores.length > 0
    ? (smStores.find((s) => s.id === params.store)?.id ?? smStores[0].id)
    : undefined
  const resolvedStoreId = isSm ? smSelectedStoreId : (profile?.store_id ?? undefined)

  // ── Campaign mode (Staff + Store Manager + SM): active campaigns REPLACE the
  //    Ngày/Tuần/Tháng tabs; no campaign → staff falls back to the period view,
  //    manager/SM get an empty state. ─────────────────────────────────────────
  const campaignViews = campaignEnabled && (isStaff || isStoreMgr || isSm) && resolvedStoreId
    ? await fetchCampaignViews(supabase, resolvedStoreId)
    : []

  // Campaign LIST landing (stakeholder): with >1 active campaign and none picked,
  // show tappable cards; a ?campaign=<id> (or a single active campaign) → detail.
  const showCampaignList = campaignViews.length > 1 && !params.campaign
  const campaignHref = (cid: string) => isSm ? `/targets?store=${smSelectedStoreId}&campaign=${cid}` : `/targets?campaign=${cid}`
  const campaignListHref = isSm ? `/targets?store=${smSelectedStoreId}` : '/targets'

  // Daily GMV series for the SELECTED campaign (drives the chart + "GMV hôm nay").
  // Selection resolved here so the fetch matches what the component will render.
  let selectedCampaignId: string | undefined
  let campaignDaily: { date: string; gmv: number }[] = []
  let campaignDailyError = false
  if (campaignViews.length > 0 && resolvedStoreId && !showCampaignList) {
    selectedCampaignId = (campaignViews.find((c) => c.id === params.campaign) ?? campaignViews[0]).id
    const { data: dailyRows, error: dErr } = await supabase
      .from('kpi_campaign_store_daily_actuals')
      .select('date, gmv')
      .eq('campaign_id', selectedCampaignId)
      .eq('store_id', resolvedStoreId)
      .order('date')
    if (dErr) {
      // Degrade with a visible hint (not silently as "no data yet").
      console.error('[targets] daily query failed:', dErr.message)
      campaignDailyError = true
    }
    campaignDaily = ((dailyRows ?? []) as { date: string; gmv: number }[])
      .map((r) => ({ date: r.date, gmv: Number(r.gmv) || 0 }))
  }

  // ── SM render branch: store selector + the store's campaign view ────────────
  if (isSm) {
    const selStore = smStores.find((s) => s.id === smSelectedStoreId)
    return (
      <div className="p-4 space-y-4 max-w-xl mx-auto">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold">Doanh số chiến dịch</h1>
        </div>

        {/* Store selector — SM manages several stores */}
        {smStores.length > 1 && (
          <div className="flex gap-2 overflow-x-auto pb-1 -mb-1">
            {smStores.map((s) => {
              const active = s.id === smSelectedStoreId
              return (
                <Link
                  key={s.id}
                  href={`/targets?store=${s.id}`}
                  className={cn(
                    'shrink-0 whitespace-nowrap text-xs px-3 py-1.5 rounded-full border font-medium transition-colors',
                    active ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                           : 'border-border text-muted-foreground hover:text-primary hover:bg-primary/5',
                  )}
                >
                  {s.name}
                </Link>
              )
            })}
          </div>
        )}

        {campaignViews.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              <TrendingUp className="h-8 w-8 mx-auto mb-3 opacity-30" />
              {selStore ? `Cửa hàng ${selStore.name} hiện chưa có chiến dịch đang áp dụng.` : 'Chưa có chiến dịch.'}
            </CardContent>
          </Card>
        ) : showCampaignList ? (
          <CampaignCardList items={campaignViews} hrefFor={campaignHref} />
        ) : (
          <>
            {campaignViews.length > 1 && (
              <Link href={campaignListHref} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">← Danh sách chiến dịch</Link>
            )}
            <CampaignResultSummary
              campaign={campaignViews.find((c) => c.id === selectedCampaignId) ?? campaignViews[0]}
              todayISO={vnTodayISO}
            />
            <CampaignKpiView items={campaignViews} selectedId={selectedCampaignId} daily={campaignDaily}
              dailyError={campaignDailyError} roleLabel="Quản lý vùng" todayISO={vnTodayISO}
              storeName={selStore?.name ?? 'Cửa hàng'} />
          </>
        )}
      </div>
    )
  }

  if (isStoreMgr) {
    const storeName = (profile?.stores as unknown as { name: string } | null)?.name ?? 'Cửa hàng của bạn'
    return (
      <div className="p-4 space-y-4 max-w-xl mx-auto">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-primary" />
            <h1 className="text-xl font-semibold">Doanh số chiến dịch</h1>
          </div>
          {/* Campaign view carries its own store pill (r3) — avoid duplicating */}
          {campaignViews.length === 0 && <span className="text-sm text-muted-foreground">{storeName}</span>}
        </div>
        {campaignViews.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              <TrendingUp className="h-8 w-8 mx-auto mb-3 opacity-30" />
              Hiện chưa có chiến dịch doanh số đang áp dụng.
            </CardContent>
          </Card>
        ) : showCampaignList ? (
          <CampaignCardList items={campaignViews} hrefFor={campaignHref} />
        ) : (
          <>
            {campaignViews.length > 1 && (
              <Link href={campaignListHref} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">← Danh sách chiến dịch</Link>
            )}
            <CampaignResultSummary
              campaign={campaignViews.find((c) => c.id === selectedCampaignId) ?? campaignViews[0]}
              todayISO={vnTodayISO}
            />
            <CampaignKpiView items={campaignViews} selectedId={selectedCampaignId} daily={campaignDaily} dailyError={campaignDailyError} roleLabel="Quản lý" todayISO={vnTodayISO} storeName={storeName} />
          </>
        )}
      </div>
    )
  }

  // ── Staff: own store's card for the selected period (store_kpi_targets,
  //    fed by the BigQuery cron "Pull KPI targets") ──────────────────────────
  if (isStaff) {
    if (!profile?.store_id) {
      return (
        <div className="p-4">
          <p className="text-sm text-muted-foreground">Tài khoản chưa được gán cửa hàng. Vui lòng liên hệ Admin.</p>
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
        <div className="p-4">
          <p className="text-sm text-destructive">
            Không tải được dữ liệu doanh số. Vui lòng thử lại sau hoặc báo Admin.
          </p>
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
    const staffPhone = (profile as { phone_number?: string | null }).phone_number ?? null
    let referral: { total: number; success: number; sameDay: number; noOrder: number; items: ReferralItem[] } | null = null
    let referralError = false
    if (staffPhone) {
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
          <div className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-primary" />
            <h1 className="text-xl font-semibold">Doanh số chiến dịch</h1>
          </div>
          {/* Card list to pick a campaign (stakeholder); a picked/single one → detail */}
          {showCampaignList ? (
            <CampaignCardList items={campaignViews} hrefFor={campaignHref} />
          ) : (
            <>
              {campaignViews.length > 1 && (
                <Link href={campaignListHref} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">← Danh sách chiến dịch</Link>
              )}
              <CampaignKpiView items={campaignViews} selectedId={selectedCampaignId} daily={campaignDaily} dailyError={campaignDailyError} roleLabel="Dược sĩ" todayISO={vnTodayISO} storeName={storeName} />
            </>
          )}
          {referral && <ReferralCard {...referral} />}
          {referralError && (
            <Card>
              <CardContent className="py-4 text-sm text-destructive">
                Không tải được dữ liệu chương trình giới thiệu. Vui lòng thử lại sau hoặc báo Admin.
              </CardContent>
            </Card>
          )}
          {staffPhone === null && (
            <Card>
              <CardContent className="py-4 text-sm text-muted-foreground">
                Cập nhật <span className="font-medium">số điện thoại</span> (biểu tượng &ldquo;Sửa thông tin&rdquo; ở đầu trang) để xem chương trình giới thiệu bạn bè.
              </CardContent>
            </Card>
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
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-primary" />
            <h1 className="text-xl font-semibold">{TITLE[period]}</h1>
          </div>
          <span className="text-sm text-muted-foreground">{storeName}</span>
        </div>

        <PeriodTabs period={period} />

        {!current ? (
          <Card>
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              <TrendingUp className="h-8 w-8 mx-auto mb-3 opacity-30" />
              {emptyMsg}
            </CardContent>
          </Card>
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

        {/* Referral campaign ("Giới thiệu bạn bè") — under Doanh số */}
        {referral && <ReferralCard {...referral} />}
        {referralError && (
          <Card>
            <CardContent className="py-4 text-sm text-destructive">
              Không tải được dữ liệu chương trình giới thiệu. Vui lòng thử lại sau hoặc báo Admin.
            </CardContent>
          </Card>
        )}
        {staffPhone === null && (
          <Card>
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
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold">{TITLE[period]} theo cửa hàng</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {periodRows.length > 0 && currentStart
              ? `${currentLabel(period, currentStart, periodRows[0]?.period_end ?? currentStart)} · ${periodRows.length} cửa hàng · cập nhật ${formatDateTime(periodRows[0]?.refreshed_at ?? '')}`
              : 'Chưa có dữ liệu cho kỳ này — kiểm tra cron /api/cron/pull-kpi-targets đã chạy chưa.'}
          </p>
          {allRowsError && (
            <p className="text-sm text-destructive mt-1">
              Lỗi truy vấn dữ liệu: {allRowsError.message} — kiểm tra migration 067 đã apply chưa.
            </p>
          )}
        </div>
      </div>

      <PeriodTabs period={period} />

      {periodRows.length > 0 && (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
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
                    <td className="px-4 py-2.5"><StatusBadge status={r.status} hasGoal={(r.target ?? 0) > 0} /></td>
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
