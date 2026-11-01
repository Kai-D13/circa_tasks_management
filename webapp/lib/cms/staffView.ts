// CMS P1-d — logic thuần cho màn staff / QLCH (D1 / D2), test được không cần server.
import { cmsAmountPerUnit, cmsTierRange } from './display'
import type { CmsProgramRowView, CmsTierView } from './server/catalog'

/** Chương trình mặc định: theo `?program=` nếu người xem đọc được; khác ⇒ đang chạy kết thúc sớm nhất; khác ⇒ sắp diễn ra
 *  bắt đầu sớm nhất. Danh sách vào đã lọc Sắp diễn ra / Đang chạy (H5). */
export function cmsPickStaffProgram(programs: CmsProgramRowView[], today: string, programId: string | null): CmsProgramRowView | null {
  const asked = programs.find((p) => p.id === programId)
  if (asked) return asked
  const running = programs.filter((p) => p.startDate <= today).sort((x, y) => x.endDate.localeCompare(y.endDate) || x.id.localeCompare(y.id))
  return running[0] ?? [...programs].sort((x, y) => x.startDate.localeCompare(y.startDate) || x.id.localeCompare(y.id))[0] ?? null
}

/** Thang bậc rút gọn trên thẻ D1 (UI §4.1 P1, r2 `đ/unit_CMS`): "1–9: 15.000₫/hộp · 10–19: 20.000₫/hộp · 20+: 25.000₫/hộp". */
export function cmsTierSummary(tiers: CmsTierView[], unit: string): string {
  return tiers.map((t) => `${cmsTierRange(t.from, t.to)}: ${cmsAmountPerUnit(t.amount, unit)}`).join(' · ')
}

/** Href D1 / D2 (giữ chương trình đang xem). */
export const cmsStaffHref = (programId?: string | null) => (programId ? `/targets?tab=cms&program=${encodeURIComponent(programId)}` : '/targets?tab=cms')
export const cmsProductHref = (programProductId: string) => `/targets/cms/products/${encodeURIComponent(programProductId)}`
