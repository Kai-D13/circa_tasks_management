// CRM-CSKH B0 — kỳ chăm sóc theo giờ Việt Nam (SPEC B0 mục 2).
//
// Kỳ = THÁNG IMPORT theo Asia/Ho_Chi_Minh (CONTRACT/Q-43): task tạo trong tháng
// nào thì hạn là ngày cuối tháng đó; sang tháng mới task cũ còn mở bị đóng kỳ.
// `period` luôn biểu diễn bằng ngày đầu tháng 'YYYY-MM-01' (khớp cột date
// `period_month` dự kiến ở B1).
//
// ⚠ KHÔNG dùng `new Date().toISOString().slice(0, 10)` hay getUTC*() để lấy
// ngày VN: 00:00–06:59 giờ VN vẫn là ngày hôm trước theo UTC ⇒ đầu tháng VN sẽ
// bị tính vào tháng trước. Mọi chuyển đổi instant → ngày đi qua `vnDateISO`.
//
// Module thuần (không IO, không server-only) để Playwright test trực tiếp.

export const CARE_TZ = 'Asia/Ho_Chi_Minh'

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

const vnDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: CARE_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
})

/** Ngày lịch (YYYY-MM-DD) có thật không — chặn '2026-02-30', '2026-13-01'. */
export function isValidIsoDate(value: string): boolean {
  const m = ISO_DATE_RE.exec(value)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (mo < 1 || mo > 12 || d < 1) return false
  return d <= daysInMonth(y, mo)
}

function assertIsoDate(value: string, label: string): void {
  if (!isValidIsoDate(value)) throw new Error(`${label}: ngày không hợp lệ (${value})`)
}

function daysInMonth(year: number, month: number): number {
  // Date.UTC(year, month, 0) = ngày cuối của `month` (1-based) — xử lý năm nhuận.
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** Ngày VN (YYYY-MM-DD) của một thời điểm. */
export function vnDateISO(instant: Date): string {
  if (Number.isNaN(instant.getTime())) throw new Error('vnDateISO: thời điểm không hợp lệ')
  return vnDateFormatter.format(instant)
}

/** Kỳ (YYYY-MM-01) chứa một ngày lịch YYYY-MM-DD. */
export function periodOfDate(dateISO: string): string {
  assertIsoDate(dateISO, 'periodOfDate')
  return `${dateISO.slice(0, 7)}-01`
}

/** Kỳ VN của một thời điểm — dùng khi import: kỳ = tháng import theo giờ VN. */
export function carePeriodOf(instant: Date): string {
  return periodOfDate(vnDateISO(instant))
}

/** `period` có đúng dạng ngày đầu tháng không. */
export function isCarePeriod(value: string): boolean {
  return isValidIsoDate(value) && value.endsWith('-01')
}

function assertPeriod(period: string, label: string): void {
  if (!isCarePeriod(period)) throw new Error(`${label}: kỳ phải là ngày đầu tháng YYYY-MM-01 (${period})`)
}

/** Ngày cuối kỳ = hạn chăm sóc của task import trong kỳ (Q-43). */
export function periodLastDay(period: string): string {
  assertPeriod(period, 'periodLastDay')
  const y = Number(period.slice(0, 4))
  const mo = Number(period.slice(5, 7))
  return `${period.slice(0, 7)}-${pad2(daysInMonth(y, mo))}`
}

/** Kỳ kế tiếp (rollover năm). */
export function nextPeriod(period: string): string {
  assertPeriod(period, 'nextPeriod')
  const y = Number(period.slice(0, 4))
  const mo = Number(period.slice(5, 7))
  return mo === 12 ? `${y + 1}-01-01` : `${y}-${pad2(mo + 1)}-01`
}

/** Ngày lịch có nằm trong kỳ không — kiểm ngày hẹn lại chỉ trong tháng task (Q-48). */
export function isDateInPeriod(dateISO: string, period: string): boolean {
  assertPeriod(period, 'isDateInPeriod')
  if (!isValidIsoDate(dateISO)) return false
  return periodOfDate(dateISO) === period
}

/**
 * Mốc "từng trễ hẹn trong kỳ" (Q-62, redline PM r1.3 §2.8) — MIRROR của SQL
 * `public.care_overdue_stamp(next, due, today)` (migration 114); spec parity ép
 * hai bên trả cùng kết quả.
 *
 * Trả `next + 1 ngày` khi: có ngày hẹn, ngày hẹn đã qua (`next < today`) VÀ
 * ngày bắt đầu trễ còn thuộc kỳ (`next + 1 <= due`, tức `next < due`). Hẹn đúng
 * ngày cuối kỳ mà không gọi ⇒ null: hôm sau task chỉ là Không hoàn thành trong
 * kỳ, không đếm Quá hạn. Ngược lại ⇒ null.
 */
export function overdueStampDate(nextActionDate: string | null, dueDate: string, todayISO: string): string | null {
  if (nextActionDate === null) return null
  for (const [v, l] of [[nextActionDate, 'next'], [dueDate, 'due'], [todayISO, 'today']] as const) assertIsoDate(v, `overdueStampDate.${l}`)
  if (!(nextActionDate < todayISO) || !(nextActionDate < dueDate)) return null
  const [y, m, d] = nextActionDate.split('-').map(Number)
  const next = new Date(Date.UTC(y, m - 1, d + 1))
  return `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}-${pad2(next.getUTCDate())}`
}

/**
 * Khoảng thời gian tuyệt đối của kỳ: [00:00 VN ngày đầu kỳ, 00:00 VN ngày đầu kỳ sau).
 * Trả chuỗi ISO có offset +07:00 (Postgres/BigQuery đều hiểu); `to` là EXCLUSIVE.
 */
export function periodRange(period: string): { from: string; to: string } {
  assertPeriod(period, 'periodRange')
  return { from: `${period}T00:00:00+07:00`, to: `${nextPeriod(period)}T00:00:00+07:00` }
}
