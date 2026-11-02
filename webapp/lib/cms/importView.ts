// CMS P1-c — kiểu phản hồi Route Handler import (lib/cms/import/handler.ts, P1-b) phía client + nhãn hiển thị. Thuần,
// không import server code (client component dùng được).

export interface CmsPreviewIssue {
  excelRow: number | null
  column: string | null
  code: string
  message: string
  fix: string
}

export interface CmsPreviewGroupOk {
  productId: string
  gmvBasis: 'product' | 'catalog' | 'none'
  targetGmv: string | null
  unitCms: string
  baseQuantityCms: string
  nameSnapshot: string
  imageUrlSnapshot: string | null
  priceSnapshot: string | null
  tiers: { order: number; from: number; to: number | null; amount: string }[]
  excelRows: number[]
  warnings: CmsPreviewIssue[]
  advicePreview: string
}

export interface CmsPreviewGroupRejected { key: string; excelRows: number[]; errors: CmsPreviewIssue[] }

export interface CmsPreviewStats {
  rowsTotal: number; rowsOk: number; rowsRejected: number; productsOk: number; productsRejected: number; warnings: number
}

export interface CmsPreviewResult {
  ok: true
  runId: string
  sha256: string
  mode: 'replace' | 'append'
  configVersion: number
  catalogTarget: string | null
  ignoredFromRow: number | null
  stats: CmsPreviewStats
  groupsOk: CmsPreviewGroupOk[]
  groupsRejected: CmsPreviewGroupRejected[]
}

export interface CmsRouteError { ok: false; code: string; message: string | null; missing?: string[] }

/** Nhãn nút xác nhận ghi theo chế độ (U16; SPEC §4.7). N = 0 ⇒ null (ẩn nút). */
export function cmsCommitLabel(mode: 'replace' | 'append', n: number): string | null {
  if (n <= 0) return null
  return mode === 'replace' ? `Nạp danh mục (thay toàn bộ, ${n} sản phẩm)` : `Thêm ${n} sản phẩm`
}

/** Mã lỗi phải quay về bước Upload (dữ liệu / file đã đổi so với lần kiểm tra — SPEC §4.5). */
export const CMS_REUPLOAD_CODES = new Set(['PREVIEW_STALE', 'SHA_MISMATCH', 'RUN_NOT_FOUND', 'NOT_EDITABLE'])

/** 9 cột hợp đồng (SPEC §4.1) — mô tả cho bước Upload. */
export const CMS_IMPORT_COLUMN_HELP: [string, string][] = [
  ['ProductID', 'Mã product_id trên POS (số nguyên)'],
  ['KPI_Target_GMV_VND', 'Target GMV (VND) — trống nếu không xét target'],
  ['Loai_CMS_GMV', 'GMV_THEO_PRODUCTID / GMV_TOAN_DANH_MUC'],
  ['Tu_SL_ban', 'Bậc: từ (đơn vị CMS)'],
  ['Den_SL_ban', 'Bậc: đến — trống ở bậc cuối = không giới hạn'],
  ['CMS_VND_SP', 'CMS mỗi đơn vị CMS ở bậc'],
  ['Noi_dung_tu_van', 'Nội dung tư vấn đã kiểm duyệt'],
  ['unit_CMS', 'Đơn vị hưởng CMS (hộp, chai…)'],
  ['base_quantity_CMS', 'Số đơn vị cơ sở = 1 đơn vị CMS'],
]

/** Luật kiểm nhóm (SPEC §4.4) — cột "Hệ thống sẽ kiểm tra". */
export const CMS_IMPORT_CHECKS: string[] = [
  'ProductID có trên Product Master',
  'Cùng ProductID: target, loại, đơn vị, quy cách, tư vấn thống nhất',
  'Bậc bắt đầu từ 1, liên tục, không chồng; chỉ bậc cuối để trống "đến"',
  'Có target thì phải có loại (và ngược lại); mọi dòng danh mục cùng một target',
  'Không trùng sản phẩm với chương trình khác đang chạy cùng thời gian',
  'Ô công thức / ô ngày / chữ có dấu phân cách trong cột số ⇒ lỗi',
]
