// CMS P1-c — dữ liệu GIẢ cho fixture /ui-catalog/cms-v2 (dev-only, UI_CATALOG=1). CMS-UI-1 (PM 04/11 §6): mọi chương trình /
// SP / lần import đến từ MỘT kịch bản (lib/cms/fixtureScenario — dòng bán giả ⇒ engine thật). Danh sách A1 = chi tiết A3 = D1:
// số SP của chương trình = số SP trong danh mục, lần import khớp từng chương trình. ProductID giả 9xxxxx, không tên người /
// nhà thuốc thật, không ảnh CDN thật (ảnh dự phòng chữ cái đầu — fixture không gọi mạng ngoài).
import type { CmsProgramDetail } from '@/lib/cms/server/catalog'
import type { CmsPreviewResult } from '@/lib/cms/importView'
import { CMS_FX_PG, CMS_FX_TODAY, cmsFxDay, cmsFxDetailOf, cmsFxListItems, cmsFxProgram, cmsFxUid, type CmsFxProgram } from './fixtureScenario'

export { CMS_FX_TODAY }
const pg = (id: string): CmsFxProgram => { const p = cmsFxProgram(id); if (!p) throw new Error('fx program'); return p }

export const CMS_FX_LIST = cmsFxListItems()
/** SP của chương trình chính (PG1 — Vitamin, đang chạy). */
export const CMS_FX_PRODUCTS = pg(CMS_FX_PG.PG1).products

/**
 * A3 theo trạng thái (P1 / P3a). `running` = PG1 · `upcoming` = PG2 · `draft-empty` = PG3 · `ended` = PG8 (QA hết kỳ) · `locked` =
 * PG9 (QA đã chốt) — đều là chương trình có trong danh sách A1. `draft` / `retro` = PG1 TRƯỚC khi kích hoạt (cùng id / danh mục /
 * cấu hình, chỉ lùi trạng thái + ngày) để xem nút Sửa / Nạp lại / Kích hoạt và hộp xác nhận hồi tố.
 */
export function cmsFxDetail(kind: 'draft' | 'draft-empty' | 'running' | 'upcoming' | 'retro' | 'ended' | 'locked'): CmsProgramDetail {
  if (kind === 'upcoming') return cmsFxDetailOf(pg(CMS_FX_PG.PG2))
  if (kind === 'draft-empty') return cmsFxDetailOf(pg(CMS_FX_PG.PG3))
  if (kind === 'ended') return cmsFxDetailOf(pg(CMS_FX_PG.PG8))
  if (kind === 'locked') return cmsFxDetailOf(pg(CMS_FX_PG.PG9))
  const d = cmsFxDetailOf(pg(CMS_FX_PG.PG1))
  if (kind === 'running') return d
  return {
    ...d, storeCount: 0, storeNames: null,
    program: { ...d.program, status: 'draft', activatedAt: null, startDate: kind === 'retro' ? cmsFxDay(-3) : cmsFxDay(16), endDate: kind === 'retro' ? cmsFxDay(27) : cmsFxDay(46) },
  }
}

const P1 = CMS_FX_PRODUCTS
/** Kết quả "Kiểm tra file" (A2) — nhóm hợp lệ là 3 SP đầu của PG1 (cùng tên / quy cách / bậc), 2 nhóm lỗi mẫu. */
export const CMS_FX_PREVIEW: CmsPreviewResult = {
  ok: true, runId: cmsFxUid(9100), sha256: 'a'.repeat(64), mode: 'replace', configVersion: 1, catalogTarget: '1500000', ignoredFromRow: 48,
  stats: { rowsTotal: 8, rowsOk: 5, rowsRejected: 3, productsOk: 3, productsRejected: 2, warnings: 2 },
  groupsOk: [
    { productId: P1[0].productId, gmvBasis: P1[0].gmvBasis, targetGmv: P1[0].targetGmv, unitCms: P1[0].unitCms, baseQuantityCms: P1[0].baseQuantityCms, nameSnapshot: P1[0].nameSnapshot, imageUrlSnapshot: null, priceSnapshot: P1[0].priceSnapshot, tiers: P1[0].tiers, excelRows: [5, 6, 7], warnings: [], advicePreview: P1[0].adviceText },
    { productId: P1[1].productId, gmvBasis: P1[1].gmvBasis, targetGmv: null, unitCms: P1[1].unitCms, baseQuantityCms: P1[1].baseQuantityCms, nameSnapshot: P1[1].nameSnapshot, imageUrlSnapshot: null, priceSnapshot: P1[1].priceSnapshot, tiers: P1[1].tiers, excelRows: [8], warnings: [{ excelRow: 8, column: 'ProductID', code: 'IMAGE_MISSING', message: 'Sản phẩm chưa có ảnh trên Product Master', fix: 'Vẫn nạp; ảnh dự phòng sẽ hiển thị' }], advicePreview: P1[1].adviceText },
    { productId: P1[2].productId, gmvBasis: P1[2].gmvBasis, targetGmv: null, unitCms: P1[2].unitCms, baseQuantityCms: P1[2].baseQuantityCms, nameSnapshot: P1[2].nameSnapshot, imageUrlSnapshot: null, priceSnapshot: P1[2].priceSnapshot, tiers: P1[2].tiers, excelRows: [9], warnings: [{ excelRow: 9, column: 'ProductID', code: 'IMAGE_NOT_ALLOWED', message: 'Ảnh sản phẩm ngoài nguồn được duyệt', fix: 'Vẫn nạp; báo operator kiểm nguồn ảnh' }], advicePreview: P1[2].adviceText },
  ],
  groupsRejected: [
    { key: '900009', excelRows: [10, 11], errors: [{ excelRow: 10, column: 'ProductID', code: 'PRODUCT_NOT_FOUND', message: 'ProductID không có trên Product Master', fix: 'Kiểm tra lại mã hoặc chờ Product Master đồng bộ' }] },
    { key: 'raw:SKU-ABC', excelRows: [12], errors: [{ excelRow: 12, column: 'ProductID', code: 'PRODUCT_ID_INVALID', message: 'ProductID phải là số nguyên dương (mã product_id trên POS)', fix: 'Nhập đúng ProductID dạng số, không dùng SKU / mã hàng' }] },
  ],
}
