// 113.11 (audit P1#1): kỳ vọng Offline tính THẲNG từ dòng BigQuery thô — không
// dùng code engine. Thuần (không IO) để qa-tooling-gates test được bằng dữ
// liệu tổng hợp. Diễn giải bám đúng contract nguồn (lib/kpi/offlineSource.ts,
// campaign GMV = strict:false):
//   · doanh thu + số đơn CÙNG NULL  → ngày không giao dịch: 0đ / 0 đơn
//   · doanh thu NULL, số đơn có      → engine phải GIỮ snapshot cũ ⇒ không thể có actuals
//   · có doanh thu, số đơn hỏng      → số đơn CẢ KỲ của POS = NULL (degrade), tiền vẫn ghi
//     (hỏng = NULL · không nguyên · âm · 0 đơn mà doanh thu ≠ 0)
//   · thiếu hoặc trùng dòng ngày     → engine phải GIỮ snapshot cũ ⇒ không thể có actuals

export interface BqDayRow {
  pos_code: string | null
  d: string | null
  offline_no_order: string | null
  offline_net_revenue: string | null
}

export interface DayExpectation { revenue: number; orders: number | null }
export interface PosExpectation {
  pos: string
  revenue: number
  orders: number | null
  degraded: string | null
  byDay: Map<string, DayExpectation>
}

const DAY = 86_400_000
export function daysInclusive(startISO: string, endISO: string): string[] {
  const out: string[] = []
  for (let t = Date.parse(`${startISO}T00:00:00Z`); t <= Date.parse(`${endISO}T00:00:00Z`); t += DAY) {
    out.push(new Date(t).toISOString().slice(0, 10))
  }
  return out
}

function num(v: string | null, what: string): number | null {
  if (v === null) return null
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`${what}: giá trị BigQuery không phải số (${v})`)
  return n
}

export function expectOffline(rows: BqDayRow[], posList: string[], startISO: string, endISO: string): Map<string, PosExpectation> {
  const days = daysInclusive(startISO, endISO)
  const out = new Map<string, PosExpectation>()
  for (const pos of posList) {
    const mine = rows.filter((r) => (r.pos_code ?? '').trim().toUpperCase() === pos)
    const byDay = new Map<string, DayExpectation>()
    let revenue = 0
    let orders = 0
    let degraded: string | null = null
    for (const d of days) {
      const hit = mine.filter((r) => (r.d ?? '').slice(0, 10) === d)
      if (hit.length !== 1) {
        throw new Error(`${pos}/${d}: BigQuery có ${hit.length} dòng DAY (phải đúng 1) — engine lẽ ra đã giữ snapshot cũ, không thể có actuals`)
      }
      const rev = num(hit[0].offline_net_revenue, `${pos}/${d} offline_net_revenue`)
      const ord = num(hit[0].offline_no_order, `${pos}/${d} offline_no_order`)
      if (rev === null && ord === null) {
        byDay.set(d, { revenue: 0, orders: 0 })
        continue
      }
      if (rev === null) {
        throw new Error(`${pos}/${d}: có ${ord} đơn mà doanh thu NULL — engine lẽ ra đã giữ snapshot cũ, không thể có actuals`)
      }
      const dayRev = Math.round(rev)
      revenue += dayRev
      let issue: string | null = null
      if (ord === null) issue = 'thiếu số đơn trong khi có doanh thu'
      else if (!Number.isInteger(ord)) issue = `số đơn không nguyên (${ord})`
      else if (ord < 0) issue = `số đơn âm (${ord})`
      else if (ord === 0 && dayRev !== 0) issue = 'có doanh thu nhưng 0 đơn'
      if (issue !== null) {
        degraded = degraded ?? `${pos}/${d}: ${issue}`
        byDay.set(d, { revenue: dayRev, orders: null })
      } else {
        orders += ord as number
        byDay.set(d, { revenue: dayRev, orders: ord })
      }
    }
    if (degraded !== null) for (const [d, v] of byDay) byDay.set(d, { ...v, orders: null })
    out.set(pos, { pos, revenue, orders: degraded === null ? orders : null, degraded, byDay })
  }
  return out
}

/** So 2 lần đọc BigQuery (trước/sau đồng bộ): nguồn phải đứng yên trong lúc sync. */
export function sameBqRows(a: BqDayRow[], b: BqDayRow[]): boolean {
  const key = (rows: BqDayRow[]) => JSON.stringify(
    [...rows].map((r) => [r.pos_code, r.d, r.offline_no_order, r.offline_net_revenue]).sort(),
  )
  return key(a) === key(b)
}
