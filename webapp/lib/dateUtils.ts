const VN_TZ = 'Asia/Ho_Chi_Minh'

// Lấy giờ VN local từ UTC timestamp — dùng internal so không phụ thuộc locale rendering
function vnHour(dateStr: string): number {
  return new Date(new Date(dateStr).getTime() + 7 * 60 * 60 * 1000).getUTCHours()
}

export function getWorkShift(dateStr: string): 'Ca 1' | 'Ca 2' | 'Ca 3' {
  const h = vnHour(dateStr)
  if (h >= 6 && h < 14) return 'Ca 1'
  if (h >= 14 && h < 22) return 'Ca 2'
  return 'Ca 3'
}

// compact=false (default): "Ca 2 · Nộp 15:54 09/06/2026" — dialog, list subtext
// compact=true:            "Ca 2 · 15:54 09/06/2026"      — card trigger, badge
export function formatShiftTime(dateStr: string, compact = false): string {
  const time = new Date(dateStr).toLocaleTimeString('vi-VN', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: VN_TZ,
  })
  const shift = getWorkShift(dateStr)
  const date  = formatDate(dateStr)
  return compact ? `${shift} · ${time} ${date}` : `${shift} · Nộp ${time} ${date}`
}

export function formatDistanceToNow(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = date.getTime() - now.getTime()
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays === 0) return 'Hôm nay'
  if (diffDays === 1) return 'Ngày mai'
  if (diffDays === -1) return 'Hôm qua'
  if (diffDays < 0) return `${Math.abs(diffDays)} ngày trước`
  return `Còn ${diffDays} ngày`
}

export function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('vi-VN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: VN_TZ,
  })
}

export function formatDateTime(dateStr: string): string {
  return new Date(dateStr).toLocaleString('vi-VN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: VN_TZ,
  })
}

export function toDatetimeLocal(dateStr: string): string {
  // Shift UTC to VN local (+7h) before formatting for datetime-local input
  const d = new Date(dateStr)
  const vn = new Date(d.getTime() + 7 * 60 * 60 * 1000)
  return vn.toISOString().slice(0, 16)
}

export function getEffectiveStatus(deadline: string | null, status: string): string {
  if (status === 'done' || status === 'overdue') return status
  if (deadline && new Date(deadline) < new Date()) return 'overdue'
  return status
}

// Format an already-VN-local timestamp string (e.g. company POS "completed_at_vn"
// like "2026-05-30T23:30:00") to "DD/MM/YYYY HH:mm". Never parses via Date() —
// avoids a UTC shift when the server runs in UTC. Returns '—' for empty input.
export function formatVnLocalDateTimeString(value: string | null | undefined): string {
  if (!value) return '—'
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : String(value)
}

// KPI week end (ISO 'YYYY-MM-DD') for a week starting on the given Monday.
// Normally Monday + 6 (Sunday). BUT the LAST partial week of a month absorbs the
// leftover days to month-end: if the tail after Sunday is a stub (< 7 days), the
// week extends to the last day of the month (e.g. 2026-06-22 → 2026-06-30, while
// 2026-06-15 stays 2026-06-21). All UTC to avoid timezone drift; the input is a
// pure date. Management sets the BigQuery target for the extended period.
export function weekEndISO(weekStart: string): string {
  const start = Date.parse(`${weekStart}T00:00:00Z`)
  if (Number.isNaN(start)) return weekStart
  const DAY = 86400_000
  const normalEnd = new Date(start + 6 * DAY)
  const monthEnd = new Date(Date.UTC(normalEnd.getUTCFullYear(), normalEnd.getUTCMonth() + 1, 0))
  // month-end of the week's START month (so a Sun spilling into next month doesn't
  // mis-target); compare leftover against the start month's end.
  const startMonthEnd = new Date(Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth() + 1, 0))
  const leftoverDays = Math.round((startMonthEnd.getTime() - normalEnd.getTime()) / DAY)
  const end = leftoverDays > 0 && leftoverDays < 7 ? startMonthEnd : (normalEnd <= monthEnd ? normalEnd : monthEnd)
  return end.toISOString().slice(0, 10)
}

// Pick the KPI week that is CURRENT for `todayISO` ('YYYY-MM-DD'): the week whose
// [week_start, weekEndISO] range contains today. On the month-end overlap (e.g.
// 22/06's extended week 22–30 vs a 29/06 week), prefer the EARLIEST week_start so
// the extended last-of-month week wins through month-end (stakeholder intent).
//
// ⚠ BQ-V2 r1 (audit P1#1): CONTAINMENT-ONLY — BỎ fallback "tuần gần nhất ≤
// hôm nay". Fallback đó hợp lý khi nguồn luôn có tuần hiện tại (chỉ trễ vài
// giờ đầu tuần); sau cutover bảng mới CHƯA có dữ liệu WEEK, fallback sẽ đem
// tuần THÁNG TRƯỚC ra hiển thị như tuần hiện tại (màn tiền). Không có tuần
// chứa hôm nay → undefined → UI hiện "Chưa có dữ liệu" (fail-visible).
export function currentWeekStart(weekStarts: string[], todayISO: string): string | undefined {
  const uniq = [...new Set(weekStarts.filter(Boolean))]
  if (!uniq.length) return undefined
  const today = Date.parse(`${todayISO}T00:00:00Z`)
  const inRange = uniq.filter((ws) => {
    const s = Date.parse(`${ws}T00:00:00Z`)
    const e = Date.parse(`${weekEndISO(ws)}T00:00:00Z`)
    return s <= today && today <= e
  })
  if (inRange.length) return inRange.reduce((a, b) => (a <= b ? a : b)) // earliest
  return undefined
}

// Inclusive length in days of the KPI week (7 normally, more for an extended
// last-of-month week).
export function weekLenDays(weekStart: string): number {
  const start = Date.parse(`${weekStart}T00:00:00Z`)
  const end = Date.parse(`${weekEndISO(weekStart)}T00:00:00Z`)
  if (Number.isNaN(start) || Number.isNaN(end)) return 7
  return Math.round((end - start) / 86400_000) + 1
}
