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
import { STATUS_META } from '@/lib/kpi/status'
import { formatDate, formatDateTime } from '@/lib/dateUtils'
import { cn } from '@/lib/utils'
import { ChevronLeft, Target, TrendingUp, Percent, Wallet, Award, CalendarDays, Gauge, SlidersHorizontal, BarChart3, Store as StoreIcon, Link2 as LinkIcon, type LucideIcon } from 'lucide-react'
import { campaignPerformance, performanceTone } from '@/lib/kpi/performance'

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
}
interface ActualRow {
  store_id: string; actual_value: number; run_rate: number | null
  remaining_target: number | null; achieved_tier_order: number | null
  store_commission_pool: number | null; synced_at: string
  actual_offline: number | null; actual_affiliate: number | null
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
  searchParams: Promise<{ tab?: string }>
}) {
  const { id } = await params
  const sp = await searchParams
  const { user, profile } = await getSessionProfile()
  if (!user) notFound()
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email) && isKpiCampaignEnabled())) notFound()

  const supabase = await createClient()
  const { data: c } = await supabase
    .from('kpi_campaigns').select('id, name, start_date, end_date, status, is_test, updated_at, metric_offline, metric_affiliate').eq('id', id).single()
  if (!c) notFound()

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
      .select('id, store_id, pos_code, kpi_target, store_kpi_group, stores(name), kpi_campaign_store_tiers(tier_order, threshold_pct, commission_amount)')
      .eq('campaign_id', id)
      .order('pos_code'),
    supabase
      .from('kpi_campaign_import_runs')
      .select('file_name, row_count, success_count, created_at')
      .eq('campaign_id', id).order('created_at', { ascending: false }).limit(5),
    supabase
      .from('kpi_campaign_store_actuals')
      .select('store_id, actual_value, actual_offline, actual_affiliate, run_rate, remaining_target, achieved_tier_order, store_commission_pool, offline_synced_at, affiliate_synced_at, synced_at')
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

  // Thời hạn (result summary): paused → Tạm dừng; past end/ended → Đã kết thúc;
  // else "Còn N ngày" (today counts).
  const vnTodayISO = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)
  const daysLeft = Math.floor((Date.parse(c.end_date) - Date.parse(vnTodayISO)) / 86400_000) + 1
  const deadlineLabel = c.status === 'paused'
    ? 'Tạm dừng'
    : (c.status === 'ended' || daysLeft <= 0) ? 'Đã kết thúc' : `Còn ${daysLeft} ngày`

  // Result summary aggregates.
  const totalTarget = targets.reduce((sum, t) => sum + (Number(t.kpi_target) || 0), 0)
  const totalActual = actuals.reduce((sum, a) => sum + (Number(a.actual_value) || 0), 0)
  // P3-E: breakdown 2 nguồn — CHỈ render khi campaign bật cả 2 chỉ số.
  const showBreakdown = c.metric_offline === true && c.metric_affiliate === true
  const totalOffline = actuals.reduce((sum, a) => sum + (Number(a.actual_offline) || 0), 0)
  const totalAffiliate = actuals.reduce((sum, a) => sum + (Number(a.actual_affiliate) || 0), 0)
  const totalPct = totalTarget > 0 ? (totalActual / totalTarget) * 100 : 0
  const totalPool = actuals.reduce((sum, a) => sum + (Number(a.store_commission_pool) || 0), 0)
  const reachedCount = actuals.filter((a) => a.achieved_tier_order !== null).length
  // Campaign pace: whole-campaign actual/target normalized by elapsed vs total days.
  const totalPerformance = lastSynced
    ? campaignPerformance(totalTarget, totalActual, c.start_date, c.end_date, vnTodayISO)
    : null

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
    <div className="p-4 md:p-6 max-w-5xl space-y-4">
      <div>
        <Link href="/targets/campaigns" className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1">
          <ChevronLeft className="h-3.5 w-3.5" /> Chiến dịch KPI
        </Link>
        <div className="flex items-center justify-between gap-3 flex-wrap mt-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-semibold">{c.name}</h1>
            <span className={cn('text-xs px-2 py-0.5 rounded-full font-medium', s.cls)}>{s.label}</span>
            {c.is_test && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700">TEST</span>}
          </div>
          <CampaignStatusButton id={c.id} status={c.status} />
        </div>
        <p className="text-sm text-muted-foreground mt-0.5">
          {formatDate(c.start_date)} – {formatDate(c.end_date)} · {targets.length} cửa hàng · {deadlineLabel}
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
              <p className="text-sm font-medium mb-2">Chỉ số doanh số</p>
              <CampaignMetricEditor
                campaignId={c.id}
                status={c.status}
                metricOffline={c.metric_offline === true}
                metricAffiliate={c.metric_affiliate === true}
                affiliateEnabled={isKpiAffiliateEnabled()}
              />
            </CardContent>
          </Card>

          {canImport && (
            <Card>
              <CardContent className="p-4">
                <p className="text-sm font-medium mb-2">Nạp / cập nhật target (thay toàn bộ)</p>
                <CampaignImport campaignId={c.id} guideDefaultOpen={targets.length === 0} />
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
                        <td className="px-4 py-2.5 text-right">{vnd(t.kpi_target)}</td>
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
              <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', lastSynced ? 'bg-green-500' : 'bg-amber-500')} />
              {lastSynced ? `Doanh số đồng bộ ${formatDateTime(lastSynced)}` : 'Chưa đồng bộ doanh số'}
            </span>
            <div className="flex items-center gap-2">
              <CampaignExportButton campaignId={c.id} />
              <SyncActualsButton campaignId={c.id} />
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {([
              { label: 'Tổng KPI target', value: vnd(totalTarget), icon: Target, tile: 'bg-primary/10 text-primary' },
              { label: 'Tổng actual GMV', value: lastSynced ? vnd(totalActual) : '—', icon: TrendingUp,
                tile: lastSynced && totalActual > 0 ? 'bg-green-100 text-green-600' : 'bg-muted text-muted-foreground' },
              // P3-E: breakdown tổng 2 nguồn (chỉ khi campaign bật cả 2)
              ...(showBreakdown ? [
                { label: 'GMV Offline', value: lastSynced ? vnd(totalOffline) : '—', icon: StoreIcon,
                  tile: 'bg-primary/10 text-primary' },
                { label: 'GMV Affiliate', value: lastSynced ? vnd(totalAffiliate) : '—', icon: LinkIcon,
                  tile: 'bg-muted text-muted-foreground' },
              ] : []),
              { label: 'Hoàn thành', value: lastSynced ? `${totalPct.toFixed(1)}%` : '—', icon: Percent,
                tile: 'bg-primary/10 text-primary', bar: true,
                valueCls: !lastSynced ? undefined : totalPct >= 100 ? 'text-green-600' : 'text-primary' },
              { label: 'Tổng commission đạt', value: lastSynced ? vnd(totalPool) : '—', icon: Wallet,
                tile: lastSynced && totalPool > 0 ? 'bg-green-100 text-green-600' : 'bg-muted text-muted-foreground',
                valueCls: lastSynced && totalPool > 0 ? 'text-green-600' : undefined },
              { label: 'Store đạt bậc', value: lastSynced ? `${reachedCount}/${targets.length}` : '—', icon: Award, tile: 'bg-primary/10 text-primary' },
              { label: 'Nhịp độ (Performance)', value: totalPerformance != null ? `${totalPerformance.toFixed(1)}%` : '—', icon: Gauge,
                tile: 'bg-primary/10 text-primary',
                valueCls: totalPerformance != null ? performanceTone(totalPerformance) : undefined },
              { label: 'Thời hạn', value: deadlineLabel, icon: CalendarDays, tile: 'bg-muted text-muted-foreground' },
            ] as { label: string; value: string; icon: LucideIcon; tile: string; valueCls?: string; bar?: boolean }[]).map((card) => (
              <Card key={card.label}>
                <CardContent className="p-3">
                  <div className="flex items-start gap-2.5">
                    <span className={cn('h-8 w-8 rounded-full flex items-center justify-center shrink-0', card.tile)}>
                      <card.icon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] text-muted-foreground uppercase truncate">{card.label}</p>
                      <p className={cn('text-lg font-bold mt-0.5 leading-tight', card.valueCls)}>{card.value}</p>
                      {card.bar && lastSynced && (
                        <div className="mt-1.5 h-1.5 rounded-full bg-muted overflow-hidden">
                          <div
                            className={cn('h-full rounded-full', totalPct >= 100 ? 'bg-green-500' : 'bg-primary')}
                            style={{ width: `${Math.min(100, Math.max(0, totalPct))}%` }}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {targets.length > 0 ? (
            <Card>
              <CardContent className="p-0 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-xs text-muted-foreground">
                      <th className="text-left px-4 py-2.5">Cửa hàng</th>
                      <th className="text-left px-4 py-2.5">Phân loại</th>
                      <th className="text-right px-4 py-2.5">KPI target</th>
                      <th className="text-right px-4 py-2.5">Actual GMV</th>
                      {showBreakdown && <th className="text-right px-4 py-2.5">GMV Offline</th>}
                      {showBreakdown && <th className="text-right px-4 py-2.5">GMV Affiliate</th>}
                      <th className="text-right px-4 py-2.5">%</th>
                      <th className="text-right px-4 py-2.5">Nhịp độ</th>
                      <th className="text-right px-4 py-2.5">Còn thiếu</th>
                      <th className="text-left px-4 py-2.5">Bậc đạt · Commission</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {targets.map((t) => {
                      const a = actualByStore.get(t.store_id)
                      const remaining = a?.remaining_target ?? null
                      const perf = campaignPerformance(t.kpi_target, a?.actual_value ?? null, c.start_date, c.end_date, vnTodayISO)
                      return (
                        <tr key={t.id} className="hover:bg-muted/30">
                          <td className="px-4 py-2.5 font-medium">{t.stores?.name ?? '—'}{t.pos_code ? ` · ${t.pos_code}` : ''}</td>
                          <td className="px-4 py-2.5 text-xs">{t.store_kpi_group ?? '—'}</td>
                          <td className="px-4 py-2.5 text-right">{vnd(t.kpi_target)}</td>
                          <td className="px-4 py-2.5 text-right">{a ? vnd(a.actual_value) : '—'}</td>
                          {showBreakdown && <td className="px-4 py-2.5 text-right text-muted-foreground">{a?.actual_offline != null ? vnd(a.actual_offline) : '—'}</td>}
                          {showBreakdown && <td className="px-4 py-2.5 text-right text-muted-foreground">{a?.actual_affiliate != null ? vnd(a.actual_affiliate) : '—'}</td>}
                          <td className="px-4 py-2.5">
                            {a?.run_rate != null ? (
                              <div className="flex items-center justify-end gap-2">
                                <div className="h-1.5 w-14 rounded-full bg-muted overflow-hidden shrink-0">
                                  <div
                                    className={cn('h-full rounded-full', a.run_rate >= 100 ? 'bg-green-500' : 'bg-primary')}
                                    style={{ width: `${Math.min(100, Math.max(0, a.run_rate))}%` }}
                                  />
                                </div>
                                <span className={cn('text-xs font-semibold', a.run_rate >= 100 ? 'text-green-600' : 'text-primary')}>
                                  {a.run_rate.toFixed(1)}%
                                </span>
                              </div>
                            ) : <span className="block text-right">—</span>}
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            {perf != null
                              ? <span className={cn('text-xs font-semibold', performanceTone(perf))}>{perf.toFixed(1)}%</span>
                              : '—'}
                          </td>
                          <td className="px-4 py-2.5 text-right">{remaining != null ? vnd(remaining) : '—'}</td>
                          <td className="px-4 py-2.5">
                            {a?.achieved_tier_order != null
                              ? (
                                <span className="inline-flex items-center whitespace-nowrap rounded-full bg-green-100 text-green-700 px-2 py-0.5 text-[11px] font-medium">
                                  Bậc {a.achieved_tier_order} · {vnd(a.store_commission_pool ?? 0)}
                                </span>
                              )
                              : a ? (
                                <span className="inline-flex items-center whitespace-nowrap rounded-full bg-muted text-muted-foreground px-2 py-0.5 text-[11px]">
                                  Chưa đạt bậc
                                </span>
                              ) : '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          ) : (
            <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">Chưa có target — nạp file ở tab Cấu hình trước.</CardContent></Card>
          )}
        </>
      )}
    </div>
  )
}
