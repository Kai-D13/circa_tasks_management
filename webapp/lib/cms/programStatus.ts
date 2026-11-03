// CMS — trạng thái HIỂN THỊ của chương trình và quyền hành động theo SPEC §4.7 (thuần, test được; dùng ở server lẫn
// client). DB chỉ có draft / active / locked; "Sắp diễn ra / Đang chạy / Chờ chốt kỳ" suy từ ngày VN (UI §2.1).
// Quyền ở đây CHỈ quyết định render nút — RPC 121 kiểm lại trạng thái + ngày trong transaction.
import type { StatusTone } from '@/components/ds/StatusBadge'

export type CmsProgramDbStatus = 'draft' | 'active' | 'locked'
export type CmsDisplayStatus = 'draft' | 'upcoming' | 'running' | 'waiting_close' | 'locked'

export const CMS_STATUS_LABEL: Record<CmsDisplayStatus, string> = {
  draft: 'Nháp', upcoming: 'Sắp diễn ra', running: 'Đang chạy', waiting_close: 'Chờ chốt kỳ', locked: 'Đã chốt',
}
export const CMS_STATUS_TONE: Record<CmsDisplayStatus, StatusTone> = {
  draft: 'neutral', upcoming: 'info', running: 'success', waiting_close: 'warning', locked: 'neutral',
}
/** Thứ tự tab lọc A1; SM không có Nháp (RLS không trả nháp cho SM — H6). */
export const CMS_STATUS_ORDER: CmsDisplayStatus[] = ['running', 'upcoming', 'waiting_close', 'draft', 'locked']
/** Tab lọc theo quyền: super đủ 5; SM không có Nháp (U8 / H6). P3a r2 (PM r1 §4 Q-219, blueprint §3 "A1 tách đã chốt"): SM có
 *  thêm Đã chốt — từ 123 `cms_readable_program_ids` trả 'locked' cho SM trong phạm vi nhà thuốc được phân công. */
export function cmsStatusesFor(canManage: boolean): CmsDisplayStatus[] {
  return canManage ? CMS_STATUS_ORDER : CMS_STATUS_ORDER.filter((s) => s !== 'draft')
}

/** Ngày VN (UTC+7, không DST) dạng YYYY-MM-DD — cùng quy ước RPC 121 (`cms__vn_today`). */
export function cmsTodayVn(now: Date): string {
  return new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 10)
}

export interface CmsProgramDates { status: CmsProgramDbStatus; startDate: string; endDate: string }

export function cmsDisplayStatus(p: CmsProgramDates, today: string): CmsDisplayStatus {
  if (p.status === 'draft') return 'draft'
  if (p.status === 'locked') return 'locked'
  if (today < p.startDate) return 'upcoming'
  if (today > p.endDate) return 'waiting_close'
  return 'running'
}

const dayNo = (iso: string) => Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86_400_000)

/** Số ngày còn lại tính cả hôm nay (chỉ khi đang chạy); khác ⇒ null. */
export function cmsDaysLeft(p: CmsProgramDates, today: string): number | null {
  if (cmsDisplayStatus(p, today) !== 'running') return null
  return dayNo(p.endDate) - dayNo(today) + 1
}

/** Số ngày tới ngày bắt đầu (chỉ khi sắp diễn ra); khác ⇒ null. */
export function cmsDaysToStart(p: CmsProgramDates, today: string): number | null {
  if (cmsDisplayStatus(p, today) !== 'upcoming') return null
  return dayNo(p.startDate) - dayNo(today)
}

export interface CmsProgramActions {
  /** Sửa tên / ngày / phạm vi (nháp hoặc đã kích hoạt chưa bắt đầu). */
  edit: boolean
  /** Chế độ import được phép: nháp / chưa bắt đầu ⇒ replace; đã bắt đầu ⇒ append; đã chốt ⇒ null. */
  importMode: 'replace' | 'append' | null
  /** Kích hoạt: chỉ nháp có ≥ 1 sản phẩm. */
  activate: boolean
}

export function cmsProgramActions(p: CmsProgramDates, today: string, productCount: number, canManage: boolean): CmsProgramActions {
  if (!canManage) return { edit: false, importMode: null, activate: false }
  const notStarted = p.status === 'draft' || (p.status === 'active' && today < p.startDate)
  return {
    edit: notStarted,
    importMode: notStarted ? 'replace' : p.status === 'active' ? 'append' : null,
    activate: p.status === 'draft' && productCount > 0,
  }
}
