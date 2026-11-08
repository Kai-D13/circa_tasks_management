// CMS P1-c — kiểu phản hồi Route Handler import (lib/cms/import/handler.ts, P1-b) phía client + nhãn hiển thị. Thuần,
// không import server code (client component dùng được).
// CMS đơn giản S1 / S2 (PM r1 08/11 §4–§5): loại file 'simple' (7 cột mức cố định) + kết quả kiểm K theo dữ liệu bán (khi cờ
// CMS_IMPORT_V2_ENABLED bật). Nhãn trạng thái K: xác nhận tay KHÔNG bao giờ hiện là "KHỚP".
import type { StatusTone } from '@/components/ds/StatusBadge'

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
  /** Bậc canonical đã chuẩn hoá — bậc cuối luôn to = null (CMS-Q-220). */
  tiers: { order: number; from: number; to: number | null; amount: string }[]
  /** Cận cuối hữu hạn trong file đã được bỏ (null = file vốn trống) — chỉ hiển thị cảnh báo, không ghi. */
  normalizedLastTo?: number | null
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
  /** Chính sách bậc của lần kiểm (CMS-Q-220: 'uncapped_last_v1'). */
  tierPolicy?: string
  ignoredFromRow: number | null
  stats: CmsPreviewStats
  groupsOk: CmsPreviewGroupOk[]
  groupsRejected: CmsPreviewGroupRejected[]
  /** CMS đơn giản S1: loại file của lần kiểm (thiếu ⇒ tiers). */
  format?: 'tiers' | 'simple'
  /** File mức cố định có cột bổ sung K / tư vấn không. */
  supplement?: { baseQuantity: boolean; advice: boolean }
  /** S2: kết quả kiểm K (chỉ khi cờ v2). */
  kCheck?: CmsPreviewKCheck
}

export type CmsKStatusView = 'MATCH' | 'PROPOSED' | 'MISMATCH' | 'SOURCE_CONFLICT' | 'SOURCE_ERROR' | 'NO_EVIDENCE' | 'UNAVAILABLE'
export interface CmsPreviewKResult {
  productId: string
  unit: string
  k: string | null
  status: CmsKStatusView
  proposedK: string | null
  seen: { unit: string; ratio: string | null; lines: number }[]
  note: string
  ack: { source: string; at: string } | null
  ok: boolean
}
export interface CmsPreviewKCheck { asOf: string | null; available: boolean; reason: string | null; products: CmsPreviewKResult[] }

export interface CmsRouteError { ok: false; code: string; message: string | null; missing?: string[]; duplicate?: string[] }

export const CMS_K_VIEW: Record<CmsKStatusView, { label: string; tone: StatusTone }> = {
  MATCH: { label: 'KHỚP', tone: 'success' },
  PROPOSED: { label: 'ĐỀ XUẤT K', tone: 'info' },
  MISMATCH: { label: 'LỆCH', tone: 'danger' },
  SOURCE_CONFLICT: { label: 'NGUỒN XUNG ĐỘT', tone: 'danger' },
  SOURCE_ERROR: { label: 'NGUỒN LỖI', tone: 'danger' },
  NO_EVIDENCE: { label: 'CHƯA CÓ BẰNG CHỨNG', tone: 'warning' },
  UNAVAILABLE: { label: 'KHÔNG KIỂM ĐƯỢC', tone: 'warning' },
}
/** Nhãn kết quả K của một SP: đã xác nhận tay ⇒ nhãn riêng, KHÔNG đổi thành "KHỚP". */
export function cmsKView(x: Pick<CmsPreviewKResult, 'status' | 'ack'>): { label: string; tone: StatusTone } {
  return x.ack ? { label: `${CMS_K_VIEW[x.status].label} · ĐÃ XÁC NHẬN TAY`, tone: 'neutral' } : CMS_K_VIEW[x.status]
}
/** SP được phép xác nhận tay: CHƯA CÓ BẰNG CHỨNG / KHÔNG KIỂM ĐƯỢC và file có K (LỆCH / NGUỒN LỖI không bao giờ). */
export const cmsKAckable = (x: Pick<CmsPreviewKResult, 'status' | 'k' | 'ack'>): boolean =>
  (x.status === 'NO_EVIDENCE' || x.status === 'UNAVAILABLE') && x.k !== null && x.ack === null

/** Dòng tóm tắt file mức cố định (PM r1 §4). */
export const cmsSimpleSummary = (n: number): string => `${n} sản phẩm · mỗi sản phẩm một mức / đơn vị · không target`

/** File mức cố định — cột hướng dẫn bước Upload. */
export const CMS_SIMPLE_COLUMN_HELP: [string, string][] = [
  ['product_id', 'Mã product_id trên POS (số nguyên) — mỗi sản phẩm một dòng'],
  ['product_name · brand_name', 'Tham khảo — tên / ảnh hiển thị theo Product Master'],
  ['ĐV tính CMS (1 item)', 'Đơn vị hưởng CMS (hộp, chai…)'],
  ['Giá bán / item (đ) · CTKM', 'Tham khảo — KHÔNG dùng trong công thức CMS'],
  ['CMS proposal', 'Mức CMS cố định cho mỗi đơn vị CMS (VND, số nguyên)'],
  ['base_quantity_CMS', 'Cột bổ sung, bắt buộc để ghi: số đơn vị cơ sở = 1 đơn vị CMS (K)'],
  ['Noi_dung_tu_van', 'Cột bổ sung, bắt buộc để ghi: nội dung tư vấn đã kiểm duyệt'],
]
export const CMS_SIMPLE_CHECKS: string[] = [
  'Đủ 7 cột (tên cột theo mẫu; khoảng trắng / hoa thường không ảnh hưởng); không có hai cột cùng ý nghĩa',
  'ProductID có trên Product Master; mỗi sản phẩm một dòng',
  'CMS proposal là số nguyên VND > 0 (đọc giá trị ô, không đoán theo giá / CTKM)',
  'Có K (base_quantity_CMS) và nội dung tư vấn — thiếu thì đọc được nhưng chưa ghi được',
  'Không trùng sản phẩm với chương trình khác đang chạy cùng thời gian',
]

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
  ['Den_SL_ban', 'Bậc: đến — bậc cuối để trống: tính từ mốc đó trở lên, không giới hạn'],
  ['CMS_VND_SP', 'CMS mỗi đơn vị CMS ở bậc'],
  ['Noi_dung_tu_van', 'Nội dung tư vấn đã kiểm duyệt'],
  ['unit_CMS', 'Đơn vị hưởng CMS (hộp, chai…)'],
  ['base_quantity_CMS', 'Số đơn vị cơ sở = 1 đơn vị CMS'],
]

/** Luật kiểm nhóm (SPEC §4.4) — cột "Hệ thống sẽ kiểm tra". */
export const CMS_IMPORT_CHECKS: string[] = [
  'ProductID có trên Product Master',
  'Cùng ProductID: target, loại, đơn vị, quy cách, tư vấn thống nhất',
  'Bậc bắt đầu từ 1, liên tục, không chồng; bậc cuối không giới hạn (số ở "đến" bậc cuối được bỏ, có cảnh báo)',
  'Có target thì phải có loại (và ngược lại); mọi dòng danh mục cùng một target',
  'Không trùng sản phẩm với chương trình khác đang chạy cùng thời gian',
  'Ô công thức / ô ngày / chữ có dấu phân cách trong cột số ⇒ lỗi',
]
