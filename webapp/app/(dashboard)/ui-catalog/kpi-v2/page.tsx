import { notFound, redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { PageHeader } from '@/components/ds/PageHeader'
import { Panel } from '@/components/ds/Panel'
import { StatusBadge, type StatusTone } from '@/components/ds/StatusBadge'
import { TagBadge, type TagHue } from '@/components/ds/TagBadge'
import { StatCard } from '@/components/ds/StatCard'
import { ProgressBar } from '@/components/ds/ProgressBar'
import { KpiProgressMeter } from '@/components/kpi/KpiProgressMeter'
import { TierTrack, type TierTrackTier } from '@/components/kpi/TierTrack'
import { PaceBadge } from '@/components/kpi/PaceBadge'
import { CampaignDailyChart } from '@/components/kpi/CampaignDailyChart'
import { STATUS_META, TEST_BADGE_CLS } from '@/lib/kpi/status'
import { kpiProgressTone } from '@/lib/kpi/progressTone'
import { metricPresentation } from '@/lib/kpi/campaignDisplay'
import { requiredPerDay } from '@/lib/kpi/performance'
import { cn } from '@/lib/utils'

// Dev-only catalog UI v2 Phase 2 "Chiến dịch KPI" (canvas K0) — render ĐÚNG component KPI thật với fixture giả
// cố định (không truy vấn). Gốc data-ui-v2="page" ⇒ token v2 + KPI (series/ok) có hiệu lực. Cổng như /ui-catalog:
// UI_CATALOG=1 (Coolify không đặt ⇒ prod 404) + super admin. Ảnh catalog commit được (100% fixture).

const money = metricPresentation('gmv').value
const pctText = (n: number) => `${n.toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%`
const TIERS3: TierTrackTier[] = [
  { tier_order: 1, threshold_pct: 90, commission_amount: 15_000_000 },
  { tier_order: 2, threshold_pct: 100, commission_amount: 25_000_000 },
  { tier_order: 3, threshold_pct: 110, commission_amount: 35_000_000 },
]
const TIERS5: TierTrackTier[] = [70, 80, 90, 100, 120].map((p, i) => ({ tier_order: i + 1, threshold_pct: p, commission_amount: (i + 1) * 5_000_000 }))
const TARGET = 393_000_000
const ACTUAL = 157_921_521
// Dòng "còn thiếu" của thẻ bậc — CÙNG wording CampaignKpiView.tierRemainingLine (fixture).
const remaining = (pct: number | null, tiers: TierTrackTier[]) => (order: number) => {
  const t = tiers.find((x) => x.tier_order === order)!
  if (pct === null) return <p className="text-[11px] text-muted-foreground">Còn thiếu: —</p>
  const need = Math.ceil((TARGET * t.threshold_pct) / 100) - (TARGET * pct) / 100
  return need <= 0
    ? <p className="text-[11px] font-semibold text-status-success">Đã đạt</p>
    : <p className="text-[11px] text-muted-foreground">Còn thiếu: <span className="font-semibold text-foreground tabular-nums">{money(need)}</span></p>
}

// Ngày giả: kỳ 01–31/01/2026, hôm nay 15/01 — 15 ngày có số (GMV offline + affiliate), ngày 06 trống (gap).
const START = '2026-01-01'
const END = '2026-01-31'
const TODAY = '2026-01-15'
const GMV = [9.8, 11.2, 12.6, 8.4, 9.1, null, 12.2, 10.5, 11.8, 9.6, 8.9, 12.4, 13.1, 10.7, 14.2]
const DAILY = GMV.flatMap((v, i) => v === null ? [] : [{
  date: `2026-01-${String(i + 1).padStart(2, '0')}`,
  gmv: Math.round(v * 0.92 * 1_000_000),
  gmv_affiliate: Math.round(v * 0.08 * 1_000_000),
  affiliate_customer_count: Math.round(v * 2),
  offline_order_count: Math.round(v * 9),
}])
const REQ = requiredPerDay({ kpiTarget: TARGET, actual: ACTUAL, endISO: END, todayISO: TODAY })
// r1.1 (PM P1): ngày đã đồng bộ nhưng doanh thu thật bằng 0 — KHÁC "chưa có dữ liệu ngày" (daily rỗng).
const DAILY_ZERO = Array.from({ length: 15 }, (_, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, gmv: 0, gmv_affiliate: 0 }))

const STATUS_TONE: Record<string, StatusTone> = { draft: 'neutral', active: 'success', paused: 'warning', ended: 'neutral' }
const TYPES: [string, TagHue][] = [['Doanh số', 'blue'], ['Số khách', 'teal'], ['Chất lượng bán hàng', 'indigo']]

function Fx({ id, title, children, className }: { id: string; title: string; children: React.ReactNode; className?: string }) {
  return (
    <div data-testid={id} className={cn('min-w-0 space-y-2', className)}>
      <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-v2-text-3">{title}</p>
      {children}
    </div>
  )
}

export default async function UiCatalogKpiV2Page() {
  if (process.env.UI_CATALOG !== '1') notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()

  return (
    <div data-ui-v2="page" data-testid="ui-catalog-kpi-v2" className="p-4 md:p-6 space-y-6">
      <PageHeader title="UI v2 · Chiến dịch KPI (K0)" subtitle="Dev-only · fixture giả 100% · phạm vi [data-ui-v2]" />

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="ProgressMeter — 4 trạng thái">
          <div className="space-y-4">
            {([
              ['fx-meter-series', 'Đang chạy, dưới mục tiêu', 40.2, { synced: true, ended: false, reached: false }],
              ['fx-meter-ok', 'Đã đạt mục tiêu', 101.4, { synced: true, ended: false, reached: true }],
              ['fx-meter-ended', 'Chiến dịch đã kết thúc', 84, { synced: true, ended: true, reached: false }],
              ['fx-meter-unsynced', 'Chưa đồng bộ', null, { synced: false, ended: false, reached: false }],
            ] as const).map(([id, label, pct, flags]) => (
              <div key={id} data-testid={id}>
                <KpiProgressMeter
                  label={label}
                  valueText={pct === null ? '—' : pctText(pct)}
                  pct={pct}
                  tone={kpiProgressTone(flags)}
                  ariaLabel={`${label}: ${pct === null ? 'chưa đồng bộ' : pctText(pct)}`}
                />
              </div>
            ))}
            <Fx id="fx-meter-edge" title="Biên (PM P1): null · NaN · Infinity · tone unsynced — caller truyền '0%'">
              {([
                ['fx-meter-edge-null', null, 'series'],
                ['fx-meter-edge-nan', Number.NaN, 'series'],
                ['fx-meter-edge-inf', Number.POSITIVE_INFINITY, 'series'],
                ['fx-meter-edge-tone', 40, 'unsynced'],
              ] as const).map(([id, pct, tone]) => (
                <div key={id} data-testid={id}>
                  <KpiProgressMeter label={id} valueText="0%" pct={pct} tone={tone} ariaLabel={id} />
                </div>
              ))}
            </Fx>
            <Fx id="fx-meter-sizes" title="Cỡ thanh 5 · 6 · 8 · 10 · 12px">
              {([5, 6, 8, 10, 12] as const).map((size) => (
                <ProgressBar key={size} value={62} max={100} tone="series" size={size} ariaLabel={`Thanh ${size}px`} />
              ))}
            </Fx>
          </div>
        </Panel>

        <Panel title="TierTrack — tiến độ + mốc thưởng">
          <div className="space-y-6">
            <Fx id="fx-tier-next" title="Đang chạy · bậc kế tiếp 90%">
              <TierTrack
                pct={40.2} pctText={pctText(40.2)} tone="series" tiers={TIERS3} reachedOrder={null} nextTierOrder={1}
                money={money} remainingLine={remaining(40.2, TIERS3)} ariaLabel="Hoàn thành 40,2%"
                aside={<>Commission Store dự kiến: <span className="font-semibold text-foreground tabular-nums">{money(0)}</span></>}
              />
            </Fx>
            <Fx id="fx-tier-reached" title="Đạt cả 3 bậc">
              <TierTrack
                pct={112.5} pctText={pctText(112.5)} tone="ok" tiers={TIERS3} reachedOrder={3} nextTierOrder={null}
                money={money} remainingLine={remaining(112.5, TIERS3)} ariaLabel="Hoàn thành 112,5%"
              />
            </Fx>
            <Fx id="fx-tier-unsynced" title="Chưa đồng bộ">
              <TierTrack
                pct={null} pctText="—" tone="unsynced" tiers={TIERS3} reachedOrder={null} nextTierOrder={null}
                money={money} remainingLine={remaining(null, TIERS3)} ariaLabel="Chưa đồng bộ"
              />
            </Fx>
            <Fx id="fx-tier-edge-nan" title="Biên: pct NaN + pctText '0%'">
              <TierTrack pct={Number.NaN} pctText="0%" tone="series" tiers={TIERS3} reachedOrder={null} nextTierOrder={null} money={money} ariaLabel="biên NaN" />
            </Fx>
            <Fx id="fx-tier-edge-tone" title="Biên: tone unsynced + pct 40 + pctText '0%'">
              <TierTrack pct={40} pctText="0%" tone="unsynced" tiers={TIERS3} reachedOrder={null} nextTierOrder={null} money={money} ariaLabel="biên tone" />
            </Fx>
            <Fx id="fx-tier-five" title="5 bậc ⇒ danh sách dọc">
              <TierTrack
                pct={86} pctText={pctText(86)} tone="series" tiers={TIERS5} reachedOrder={2} nextTierOrder={3}
                money={money} remainingLine={remaining(86, TIERS5)} ariaLabel="Hoàn thành 86%"
              />
            </Fx>
          </div>
        </Panel>
      </div>

      <Panel title="Tiến độ theo ngày (CampaignDailyChart)">
        <div className="grid gap-6 lg:grid-cols-2">
          <Fx id="fx-chart-gmv-required" title={`GMV + Trung bình/ngày cần đạt (${money(REQ ?? 0)})`}>
            <CampaignDailyChart start={START} end={END} todayISO={TODAY} daily={DAILY} breakdown requiredPerDay={REQ} />
          </Fx>
          <Fx id="fx-chart-gmv-null" title="GMV · requiredPerDay null ⇒ không vẽ đường">
            <CampaignDailyChart start={START} end={END} todayISO={TODAY} daily={DAILY} requiredPerDay={null} />
          </Fx>
          <Fx id="fx-chart-gmv-zero" title="GMV · đã đạt (0) ⇒ không vẽ đường">
            <CampaignDailyChart start={START} end={END} todayISO={TODAY} daily={DAILY} requiredPerDay={0} />
          </Fx>
          <Fx id="fx-chart-gmv-empty-daily" title="GMV · daily RỖNG + requiredPerDay > 0 ⇒ không vẽ đường">
            <CampaignDailyChart start={START} end={END} todayISO={TODAY} daily={[]} requiredPerDay={REQ} />
          </Fx>
          <Fx id="fx-chart-gmv-real-zero" title="GMV · ngày đã đồng bộ, doanh thu 0 thật ⇒ vẫn vẽ đường">
            <CampaignDailyChart start={START} end={END} todayISO={TODAY} daily={DAILY_ZERO} requiredPerDay={REQ} />
          </Fx>
          <Fx id="fx-chart-orders" title="Chất lượng bán hàng · Số đơn (bỏ qua requiredPerDay)">
            <CampaignDailyChart start={START} end={END} todayISO={TODAY} daily={DAILY} metricType="offline_order_aov" series="orders" requiredPerDay={5} />
          </Fx>
          <Fx id="fx-chart-aov" title="Chất lượng bán hàng · AOV (bỏ qua requiredPerDay)">
            <CampaignDailyChart start={START} end={END} todayISO={TODAY} daily={DAILY} metricType="offline_order_aov" series="aov" requiredPerDay={150_000} />
          </Fx>
          <Fx id="fx-chart-customer" title="Số khách (bỏ qua requiredPerDay)">
            <CampaignDailyChart start={START} end={END} todayISO={TODAY} daily={DAILY} metricType="affiliate_customer_count" requiredPerDay={10} />
          </Fx>
        </div>
      </Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Badge">
          <div className="space-y-3">
            <Fx id="fx-badge-status" title="Trạng thái chiến dịch">
              <div className="flex flex-wrap gap-2">
                {Object.entries(STATUS_META).map(([k, m]) => <StatusBadge key={k} tone={STATUS_TONE[k]}>{m.label}</StatusBadge>)}
                <span className={cn('inline-flex rounded px-2 py-0.5 text-[11px] font-medium v2:rounded-v2-chip', TEST_BADGE_CLS)}>TEST</span>
              </div>
            </Fx>
            <Fx id="fx-badge-pace" title="Nhịp độ (≥100 · ≥80 · <80 · chưa có)">
              <div className="flex flex-wrap gap-2">
                <PaceBadge pct={120.3}>120,3%</PaceBadge>
                <PaceBadge pct={86.4}>86,4%</PaceBadge>
                <PaceBadge pct={54.2}>54,2%</PaceBadge>
                <PaceBadge pct={null} />
              </div>
            </Fx>
            <Fx id="fx-badge-type" title="Loại chiến dịch (TagBadge)">
              <div className="flex flex-wrap gap-2">
                {TYPES.map(([label, hue]) => <TagBadge key={label} hue={hue}>{label}</TagBadge>)}
              </div>
            </Fx>
          </div>
        </Panel>

        <Panel title="Định dạng số (metricPresentation hiện có)">
          <dl data-testid="fx-numbers" className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-y-2 text-[13px]">
            <dt className="text-muted-foreground">Tiền đầy đủ</dt><dd className="tabular-nums">{money(ACTUAL)}</dd>
            <dt className="text-muted-foreground">Tiền rút gọn (trục)</dt><dd className="tabular-nums">{metricPresentation('gmv').compact(ACTUAL)} · {metricPresentation('gmv').compact(1_200_000_000)}</dd>
            <dt className="text-muted-foreground">Số khách</dt><dd className="tabular-nums">{metricPresentation('affiliate_customer_count').value(244)}</dd>
            <dt className="text-muted-foreground">Chưa đồng bộ</dt><dd className="tabular-nums">{money(null as unknown as number)}</dd>
          </dl>
        </Panel>
      </div>

      <div data-testid="fx-tiles" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Số ngày bán còn lại" value="17" hint="đến 31/01/2026" />
        <StatCard label="Trung bình/ngày cần đạt" value={money(REQ ?? 0)} />
        <StatCard label="Doanh thu hôm nay" value={money(14_215_000)} />
        <StatCard label="Nhịp độ (Performance)" value="86,4%" tone="warning" />
      </div>
    </div>
  )
}
