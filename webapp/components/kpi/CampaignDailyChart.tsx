// "Tiến độ theo ngày" — daily GMV bars over the campaign range. Server-rendered
// SVG (no chart lib, no client JS — native <title> tooltips per bar). Single
// series → brand primary hue, no legend (the card title names it); thin
// baseline-anchored bars with a 2px slot gap and rounded data-ends; recessive
// grid; sparse day ticks; today's bar accented. Theme-aware via Tailwind
// fill-/stroke- color tokens (works in dark mode without extra CSS).

// P3-E: gmv = Offline, gmv_affiliate = Affiliate. Cột hiển thị TỔNG; tooltip
// (<title>) breakdown 2 nguồn khi campaign có affiliate.
// Mig 103: campaign Số khách — cột = affiliate_customer_count, format 'N khách'
// qua metricPresentation (GMV path dùng cùng module, format byte-equal cũ).
import { metricPresentation, orderAxisTicks } from '@/lib/kpi/campaignDisplay'

interface DailyPoint {
  date: string
  gmv: number
  gmv_affiliate: number
  affiliate_customer_count?: number
  // Mig 106: số đơn Offline của NGÀY (null = nguồn chưa có số đơn ⇒ chart vẽ
  // GAP, không phải cột 0). Khớp structurally với DailyPoint của CampaignKpiView.
  offline_order_count?: number | null
}
type DailySeries = 'orders' | 'aov'

const W = 360
const H = 170
const PAD_L = 34
const PAD_B = 18
const PAD_T = 16 // room for the value callout above today's bar

// Round up to a "nice" axis max (1/2/5 × 10^n).
function niceMax(v: number): number {
  if (v <= 0) return 1_000_000
  const exp = Math.pow(10, Math.floor(Math.log10(v)))
  const f = v / exp
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp
}

export function CampaignDailyChart({
  start, end, daily, todayISO, breakdown = false, metricType, series = 'orders',
}: {
  start: string; end: string; daily: DailyPoint[]; todayISO: string
  breakdown?: boolean // campaign có CẢ 2 chỉ số → tooltip tách Offline/Affiliate
  metricType?: string // mig 103: 'affiliate_customer_count' → trục/tooltip 'N khách'
  series?: DailySeries // mig 106: Chất lượng bán hàng — 'orders' | 'aov'
}) {
  const pres = metricPresentation(metricType)
  const isCustomer = pres.kind === 'affiliate_customer_count'
  // Mig 106: campaign Chất lượng bán hàng KHÔNG vẽ tiền — cột là SỐ ĐƠN/ngày
  // (mặc định) hoặc AOV/ngày = net ngày / số đơn ngày. Ngày không có đơn →
  // null ⇒ KHÔNG vẽ cột (gap), tuyệt đối không quy về 0₫/0 đơn.
  const isOrderAov = pres.kind === 'offline_order_aov'
  const nfInt = new Intl.NumberFormat('vi-VN')
  const pointValue = (d: DailyPoint): number | null => {
    if (isOrderAov) {
      const ord = d.offline_order_count
      if (ord === null || ord === undefined) return null
      if (series === 'orders') return ord
      return ord > 0 ? d.gmv / ord : null            // AOV ngày (0 đơn → gap)
    }
    return isCustomer ? (d.affiliate_customer_count ?? 0) : d.gmv + d.gmv_affiliate
  }
  // Trục/nhãn: số đơn là ĐẾM (không phải tiền); AOV là tiền.
  const compactVnd = isOrderAov && series === 'orders'
    ? (n: number) => nfInt.format(Math.round(n))
    : isOrderAov ? metricPresentation('gmv').compact : pres.compact
  const ariaLabel = !isOrderAov ? pres.chartAriaLabel
    : series === 'aov' ? 'Biểu đồ AOV theo ngày' : 'Biểu đồ số đơn theo ngày'
  const fullVnd = isOrderAov && series === 'orders'
    ? (n: number) => `${nfInt.format(Math.round(n))} đơn`
    : isOrderAov ? metricPresentation('gmv').value : pres.value
  // Full day axis across the campaign range (future days render empty).
  // Giá trị cột = TỔNG 2 nguồn; point gốc giữ lại cho tooltip breakdown.
  const pointByDate = new Map(daily.map((d) => [d.date, d]))
  const gmvByDate = new Map<string, number>()
  for (const d of daily) {
    const v = pointValue(d)
    if (v !== null) gmvByDate.set(d.date, v)          // null = gap, không set
  }
  const days: string[] = []
  const DAY = 86400_000
  const endMs = Date.parse(`${end}T00:00:00Z`)
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= endMs && days.length < 92; t += DAY) {
    days.push(new Date(t).toISOString().slice(0, 10))
  }
  if (days.length === 0) return null

  // r1.2 (audit P2): mọi ngày = 0 đơn thì trục KHÔNG được nhảy lên thang tiền
  // mặc định (1.000.000) — số đơn là ĐẾM, thang tối thiểu là 1.
  const rawMax = Math.max(0, ...[...gmvByDate.values()])
  const max = isOrderAov && series === 'orders'
    ? Math.max(1, Math.ceil(rawMax))
    : niceMax(rawMax)
  const plotW = W - PAD_L - 4
  const plotH = H - PAD_T - PAD_B
  const slot = plotW / days.length
  const barW = Math.max(3, Math.min(12, slot - 2)) // ≥3px bar, 2px slot gap
  const y = (v: number) => PAD_T + plotH - (v / max) * plotH

  // Sparse day ticks: ~6 evenly spaced, always first + last.
  const tickEvery = Math.max(1, Math.ceil(days.length / 6))
  // r1.2.1 (audit P2): chuỗi SỐ ĐƠN là số nguyên — max/2 = 2,5 mà nhãn làm
  // tròn thành '3' sẽ đặt sai vị trí lưới. Dùng tick nguyên + khử trùng.
  const gridVals = isOrderAov && series === 'orders' ? orderAxisTicks(max) : [max / 2, max]

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={ariaLabel}>
      {/* Recessive grid + y labels (text tokens, never series color) */}
      {gridVals.map((v) => (
        <g key={v}>
          <line x1={PAD_L} x2={W - 4} y1={y(v)} y2={y(v)} className="stroke-border" strokeWidth="0.5" strokeDasharray="2 3" />
          <text x={PAD_L - 4} y={y(v) + 3} textAnchor="end" fontSize="8" className="fill-muted-foreground">{compactVnd(v)}</text>
        </g>
      ))}
      {/* Baseline */}
      <line x1={PAD_L} x2={W - 4} y1={PAD_T + plotH} y2={PAD_T + plotH} className="stroke-border" strokeWidth="1" />

      {/* Bars — one per realized day; today accented, native tooltip per bar */}
      {days.map((d, i) => {
        const v = gmvByDate.get(d)
        const cx = PAD_L + i * slot + slot / 2
        const dayNo = d.slice(8, 10)
        const showTick = i === 0 || i === days.length - 1 || i % tickEvery === 0
        return (
          <g key={d}>
            {v !== undefined && v > 0 && (
              <rect
                x={cx - barW / 2}
                y={y(v)}
                width={barW}
                height={Math.max(1.5, PAD_T + plotH - y(v))}
                rx={Math.min(2, barW / 2)}
                className={d === todayISO ? 'fill-primary' : 'fill-primary/70'}
              >
                <title>{isOrderAov && pointByDate.get(d)
                  // Tooltip Chất lượng bán hàng: đủ 3 số để đối soát.
                  ? (() => {
                    const p = pointByDate.get(d)!
                    const ord = p.offline_order_count ?? 0
                    const aov = ord > 0 ? p.gmv / ord : null
                    const money = metricPresentation('gmv').value
                    return `${dayNo}/${d.slice(5, 7)}: ${nfInt.format(ord)} đơn · AOV ${aov === null ? '—' : money(aov)} · Net ${money(p.gmv)}`
                  })()
                  : breakdown && pointByDate.get(d)
                  ? `${dayNo}/${d.slice(5, 7)}: ${fullVnd(v)} (Offline ${fullVnd(pointByDate.get(d)!.gmv)} · Affiliate ${fullVnd(pointByDate.get(d)!.gmv_affiliate)})`
                  : `${dayNo}/${d.slice(5, 7)}: ${fullVnd(v)}`}</title>
              </rect>
            )}
            {/* Selective label: only today's value gets a callout (template) */}
            {v !== undefined && v > 0 && d === todayISO && (
              <text
                x={Math.min(Math.max(cx, PAD_L + 14), W - 18)}
                y={y(v) - 4}
                textAnchor="middle"
                fontSize="8"
                fontWeight="600"
                className="fill-primary"
              >
                {compactVnd(v)}
              </text>
            )}
            {showTick && (
              <text x={cx} y={H - 4} textAnchor="middle" fontSize="8" className="fill-muted-foreground">{dayNo}</text>
            )}
          </g>
        )
      })}
    </svg>
  )
}
