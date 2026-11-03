// CMS P1-d — logic thuần cho màn staff / QLCH (D1 / D2), test được không cần server.
// P3a r2 (PM r1 PKG-P1-1, blueprint P3 §3 "D1 / D2 / D3 / A3 đọc run đóng băng"): danh sách chương trình gồm cả Chờ chốt kỳ và
// Đã chốt (nhóm "Đã kết thúc" trong bộ chọn — H5: bộ lọc P1 không dùng để giấu lịch sử); số của chương trình đã chốt là kết quả
// của run ĐÓNG BĂNG (pointer không đổi sau chốt — guard 123), nhãn "đã chốt", không gợi ý / mô phỏng bán thêm.
import { cmsAmountPerUnit, cmsDateTime, cmsTierRange } from './display'
import { cmsDisplayStatus, type CmsDisplayStatus } from './programStatus'
import type { CmsProgramRowView, CmsTierView } from './server/catalog'

/** Đã kết thúc (chờ chốt / đã chốt — chỉ xem lại số, không còn bán để tính thêm). */
export const cmsIsClosedDisplay = (d: CmsDisplayStatus | null): boolean => d === 'waiting_close' || d === 'locked'

/** Nhóm cho bộ chọn D1: Đang áp dụng (đang chạy kết thúc sớm trước, rồi sắp diễn ra) · Đã kết thúc (kết thúc gần nhất trước). */
export function cmsGroupStaffPrograms(programs: CmsProgramRowView[], today: string): { current: CmsProgramRowView[]; ended: CmsProgramRowView[] } {
  const d = (p: CmsProgramRowView) => cmsDisplayStatus(p, today)
  const running = programs.filter((p) => d(p) === 'running').sort((x, y) => x.endDate.localeCompare(y.endDate) || x.id.localeCompare(y.id))
  const upcoming = programs.filter((p) => d(p) === 'upcoming').sort((x, y) => x.startDate.localeCompare(y.startDate) || x.id.localeCompare(y.id))
  const ended = programs.filter((p) => cmsIsClosedDisplay(d(p))).sort((x, y) => y.endDate.localeCompare(x.endDate) || x.id.localeCompare(y.id))
  return { current: [...running, ...upcoming], ended }
}

/** Chương trình mặc định: theo `?program=` nếu người xem đọc được; khác ⇒ đang chạy kết thúc sớm nhất; khác ⇒ sắp diễn ra
 *  bắt đầu sớm nhất; khác ⇒ chương trình đã kết thúc gần nhất (Chờ chốt kỳ / Đã chốt — vẫn xem được lịch sử sau hết kỳ). */
export function cmsPickStaffProgram(programs: CmsProgramRowView[], today: string, programId: string | null): CmsProgramRowView | null {
  const asked = programs.find((p) => p.id === programId)
  if (asked) return asked
  const g = cmsGroupStaffPrograms(programs, today)
  return g.current[0] ?? g.ended[0] ?? null
}

/** Tiêu đề khối số: tạm tính (đang chạy / chờ chốt) hay đã chốt. */
export function cmsStaffAmountTitle(display: CmsDisplayStatus | null, who: 'own' | 'store' | 'product'): string {
  const locked = display === 'locked'
  if (who === 'own') return locked ? 'CMS đã chốt của bạn' : 'CMS tạm tính của bạn'
  if (who === 'store') return locked ? 'CMS đã chốt của nhà thuốc' : 'CMS tạm tính của nhà thuốc'
  return locked ? 'CMS đã chốt' : 'CMS tạm tính'
}

/** Dòng trạng thái số liệu theo trạng thái chương trình (UI §4.3: Tạm tính / Chờ chốt kỳ / Đã chốt). */
export function cmsStaffUpdatedText(display: CmsDisplayStatus | null, publishedAt: string | null | undefined): string {
  const at = cmsDateTime(publishedAt)
  if (display === 'locked') return `Đã chốt kỳ · số theo lần tính ${at} (không đổi sau chốt)`
  if (display === 'waiting_close') return `Cập nhật ${at} · chờ chốt kỳ — số tạm tính, có thể đổi khi chốt`
  return `Cập nhật ${at} · chưa chốt kỳ`
}

/** Thang bậc rút gọn trên thẻ D1 (UI §4.1 P1, r2 `đ/unit_CMS`): "1–9: 15.000₫/hộp · 10–19: 20.000₫/hộp · 20+: 25.000₫/hộp". */
export function cmsTierSummary(tiers: CmsTierView[], unit: string): string {
  return tiers.map((t) => `${cmsTierRange(t.from, t.to)}: ${cmsAmountPerUnit(t.amount, unit)}`).join(' · ')
}

/** Href D1 / D2 (giữ chương trình đang xem). */
export const cmsStaffHref = (programId?: string | null) => (programId ? `/targets?tab=cms&program=${encodeURIComponent(programId)}` : '/targets?tab=cms')
export const cmsProductHref = (programProductId: string) => `/targets/cms/products/${encodeURIComponent(programProductId)}`
