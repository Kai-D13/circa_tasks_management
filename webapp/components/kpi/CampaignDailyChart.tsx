// "Tiến độ theo ngày" — daily GMV bars over the campaign range. Server-rendered
// SVG (no chart lib, no client JS — native <title> tooltips per bar). Single
// series → brand primary hue, no legend (the card title names it); thin
// baseline-anchored bars with a 2px slot gap and rounded data-ends; recessive
// grid; sparse day ticks; today's bar accented. Theme-aware via Tailwind
// fill-/stroke- color tokens (works in dark mode without extra CSS).

interface DailyPoint { date: string; gmv: number }

const W = 360
const H = 170
const PAD_L = 34
const PAD_B = 18
const PAD_T = 16 // room for the value callout above today's bar

const compactVnd = (v: number) =>
  v >= 1_000_000_000 ? `${(v / 1_000_000_000).toFixed(1)}tỷ`
  : v >= 1_000_000 ? `${Math.round(v / 1_000_000)}tr`
  : v >= 1_000 ? `${Math.round(v / 1_000)}k`
  : `${Math.round(v)}`

const fullVnd = (v: number) => `${new Intl.NumberFormat('vi-VN').format(Math.round(v))}₫`

// Round up to a "nice" axis max (1/2/5 × 10^n).
function niceMax(v: number): number {
  if (v <= 0) return 1_000_000
  const exp = Math.pow(10, Math.floor(Math.log10(v)))
  const f = v / exp
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp
}

export function CampaignDailyChart({
  start, end, daily, todayISO,
}: {
  start: string; end: string; daily: DailyPoint[]; todayISO: string
}) {
  // Full day axis across the campaign range (future days render empty).
  const gmvByDate = new Map(daily.map((d) => [d.date, d.gmv]))
  const days: string[] = []
  const DAY = 86400_000
  const endMs = Date.parse(`${end}T00:00:00Z`)
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= endMs && days.length < 92; t += DAY) {
    days.push(new Date(t).toISOString().slice(0, 10))
  }
  if (days.length === 0) return null

  const max = niceMax(Math.max(0, ...daily.map((d) => d.gmv)))
  const plotW = W - PAD_L - 4
  const plotH = H - PAD_T - PAD_B
  const slot = plotW / days.length
  const barW = Math.max(3, Math.min(12, slot - 2)) // ≥3px bar, 2px slot gap
  const y = (v: number) => PAD_T + plotH - (v / max) * plotH

  // Sparse day ticks: ~6 evenly spaced, always first + last.
  const tickEvery = Math.max(1, Math.ceil(days.length / 6))
  const gridVals = [max / 2, max]

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Biểu đồ GMV theo ngày">
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
                <title>{`${dayNo}/${d.slice(5, 7)}: ${fullVnd(v)}`}</title>
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
