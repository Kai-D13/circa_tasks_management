// CMS P1-d — dữ liệu GIẢ cho fixture /ui-catalog/cms-v2/{staff,product,history} (dev-only, UI_CATALOG=1). CMS-UI-1: chương
// trình / SP lấy từ CÙNG kịch bản (lib/cms/fixtureScenario) với A1 / A3 — mỗi chương trình có danh mục riêng của nó.
import { CMS_FX_ADVICE_4000, CMS_FX_PG, CMS_FX_PG_SIMPLE, CMS_FX_TODAY, cmsFxProgram, cmsFxRowView } from './fixtureScenario'
import type { CmsProductView, CmsProgramRowView } from './server/catalog'

export { CMS_FX_TODAY }
const row = (id: string): CmsProgramRowView => { const p = cmsFxProgram(id); if (!p) throw new Error('fx program'); return cmsFxRowView(p.row) }

/** Nhà thuốc 01 (dược sĩ A / QLCH) đang thấy: 2 đang chạy (PG1 kết thúc +15, PG7 +40) + 1 sắp diễn ra (PG2). */
export const CMS_FX_STAFF_PROGRAMS: CmsProgramRowView[] = [row(CMS_FX_PG.PG1), row(CMS_FX_PG.PG7), row(CMS_FX_PG.PG2)]

/** P3a r2 (PM r1 PKG-P1-1): chương trình ĐÃ KẾT THÚC — [0] Chờ chốt kỳ (PG4), [1] Đã chốt (PG5, run đóng băng). */
export const CMS_FX_STAFF_ENDED: CmsProgramRowView[] = [row(CMS_FX_PG.PG4), row(CMS_FX_PG.PG5)]

/** CMS đơn giản (PM r1 08/11 §6, fx=simple): [0] PG10 đang chạy · [1] PG11 sắp diễn ra · [2] PG12 hết kỳ chờ chốt — mỗi SP một mức / hộp. */
export const CMS_FX_STAFF_SIMPLE: CmsProgramRowView[] = [row(CMS_FX_PG_SIMPLE.PG10), row(CMS_FX_PG_SIMPLE.PG11), row(CMS_FX_PG_SIMPLE.PG12)]

/** Tư vấn nhiều dòng (D2 ?fx=long). Bản ~4.000 ký tự: CMS_FX_ADVICE_4000 (SP thứ 3 của PG5). */
export const CMS_FX_LONG_ADVICE = [
  'Hỏi nhu cầu và đối tượng dùng (người lớn, trẻ em, phụ nữ có thai) trước khi tư vấn.',
  'Liều dùng theo hướng dẫn trên nhãn; không dùng quá liều khuyến cáo.',
  'Nhắc khách đọc kỹ hướng dẫn sử dụng trước khi dùng; ngưng dùng và hỏi ý kiến bác sĩ nếu có dấu hiệu bất thường.',
  '',
  'Gợi ý bán kèm: nước muối sinh lý, khẩu trang — chỉ khi khách có nhu cầu.',
  'Nội dung mẫu cho fixture — dòng dài để kiểm tra xuống dòng trong khung trên màn hình 360px mà không cuộn ngang trang.',
].join('\n')
export { CMS_FX_ADVICE_4000 }

/** Danh mục của CHÍNH chương trình (không gán chung một bộ SP cho mọi program_id). */
export function cmsFxStaffProducts(programId: string): CmsProductView[] {
  return cmsFxProgram(programId)?.products ?? []
}
