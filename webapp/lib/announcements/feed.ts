// UI v2 Phase 3 · Bảng tin (A0) — helper THUẦN cho danh sách tin, chỉ trên dữ liệu ĐÃ TẢI (≤ 100 tin, PM spec §3.1).
// Không truy vấn, không đổi thứ tự gốc. Nhận `now` để test qua nửa đêm và ranh giới tuần.

export type AnnouncementTimeGroupKey = 'today' | 'week' | 'earlier'

export const ANNOUNCEMENT_TIME_GROUP_LABEL: Record<AnnouncementTimeGroupKey, string> = {
  today: 'Hôm nay',
  week: 'Tuần này',
  earlier: 'Trước đó',
}

// Asia/Ho_Chi_Minh = UTC+7 cố định (Việt Nam không có giờ mùa hè).
const VN_OFFSET_MS = 7 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/** Số thứ tự NGÀY theo lịch Việt Nam (0 = 01/01/1970 giờ VN). NaN nếu thời điểm không hợp lệ. */
export function vnDayIndex(at: string | number | Date): number {
  const ms = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(at)
  return Number.isFinite(ms) ? Math.floor((ms + VN_OFFSET_MS) / DAY_MS) : NaN
}

/** Ngày đầu tuần (thứ Hai) chứa ngày `day` (theo vnDayIndex). 01/01/1970 là thứ Năm ⇒ (day + 3) % 7 = số ngày kể từ thứ Hai. */
export function vnWeekStart(day: number): number {
  return day - (((day + 3) % 7) + 7) % 7
}

/** Nhóm của một tin: Hôm nay = cùng ngày VN (tin hẹn giờ tương lai cũng vào đây); Tuần này = từ thứ Hai tuần này tới
 *  trước hôm nay; còn lại (kể cả thời điểm không hợp lệ) = Trước đó. Ba nhóm không chồng lấn. */
export function announcementTimeGroup(publishedAt: string, now: Date | string | number): AnnouncementTimeGroupKey {
  const d = vnDayIndex(publishedAt)
  const today = vnDayIndex(now)
  if (!Number.isFinite(d) || !Number.isFinite(today)) return 'earlier'
  if (d >= today) return 'today'
  if (d >= vnWeekStart(today)) return 'week'
  return 'earlier'
}

/** Chia danh sách đã tải thành các nhóm CÓ dữ liệu, theo thứ tự Hôm nay → Tuần này → Trước đó; trong nhóm giữ thứ tự gốc. */
export function groupAnnouncementsByTime<T extends { publishedAt: string }>(
  items: T[],
  now: Date | string | number,
): { key: AnnouncementTimeGroupKey; label: string; items: T[] }[] {
  const buckets: Record<AnnouncementTimeGroupKey, T[]> = { today: [], week: [], earlier: [] }
  for (const it of items) buckets[announcementTimeGroup(it.publishedAt, now)].push(it)
  return (['today', 'week', 'earlier'] as const)
    .filter((k) => buckets[k].length > 0)
    .map((k) => ({ key: k, label: ANNOUNCEMENT_TIME_GROUP_LABEL[k], items: buckets[k] }))
}

/** Phần trăm đã xem để HIỂN THỊ: làm tròn XUỐNG — không bao giờ ghi 100% khi còn người chưa xem. null khi không có mẫu số hợp lệ. */
export function readPercent(read: number, total: number): number | null {
  if (!Number.isFinite(read) || !Number.isFinite(total) || total <= 0) return null
  const v = Math.min(total, Math.max(0, read))
  return Math.floor((v / total) * 100)
}
