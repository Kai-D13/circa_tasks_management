// CMS-CALC-RET-2 (planning/research/cms-calculation-modes-returns-spec-2026-11-13.md §2, §6.1, §7; Q-231 / Q-232 / Q-229 / Q-230)
// — định danh kỹ thuật của hai trục chính sách tính, KHÔNG phải dữ liệu admin gõ vào file:
//  · Cách tính lượng (quantity_basis) — một lựa chọn cho CẢ chương trình (radio / select trên UI, không cột Excel):
//      pos_base  "Tính lẻ — cộng dồn quy đổi"   Q = floor(ΣB / K) (Q-227; T11 giữ mode này)
//      cms_unit  "Tính nguyên — đúng đơn vị CMS" chỉ dòng đúng ĐV CMS + lượng nguyên dương; dòng lẻ bỏ cả dòng khỏi lượng (Q-231)
//  · Chính sách trả hàng của run (returns_policy):
//      sales_only_v1   lịch sử — run chỉ đọc nguồn bán (nhãn results_basis của migration 126)
//      net_returns_v1  run đọc cả nguồn trả COMPLETED, tính ròng theo người / kỳ bán gốc (Q-230 / Q-232) — lượng trả = lượng BI
//      full_line_qty_refund_v1  Q-236 (18/11): phiếu COMPLETED hợp lệ trỏ dòng bán i ⇒ trừ ĐỦ B_i / E_i của dòng đó MỘT lần (bỏ qua lượng
//                      BI), GMV trừ refund_amount TỪNG phiếu; hợp đồng run v2 + từ điển trạng thái v2 (design r1 §1–§3)
// Ba trục KHÁC NHAU, không dùng chung tên biến `mode`: import mode (replace / append), format file (tiers / simple) và quantity_basis.
// Parse CHÍNH XÁC (không trim / hạ chữ): giá trị lạ ⇒ null để caller fail-closed (không fallback pos_base / sales_only).
// Hàm thuần, không I/O.

export const CMS_QUANTITY_BASES = ['pos_base', 'cms_unit'] as const
export type CmsQuantityBasis = (typeof CMS_QUANTITY_BASES)[number]

/** Nhãn UI do PM chốt (spec §2). */
export const CMS_QUANTITY_BASIS_LABEL: Readonly<Record<CmsQuantityBasis, string>> = {
  pos_base: 'Tính lẻ — cộng dồn quy đổi',
  cms_unit: 'Tính nguyên — đúng đơn vị CMS',
}

/**
 * Phiên bản luật lượng ghim vào run / fingerprint. `cms_unit_v2` CỐ Ý khác `cms_unit_v1` của nhánh CMS-UNIT đã bỏ (v1: lượng lẻ đúng ĐV
 * ⇒ HOLD cả lượt; v2 — Q-231: dòng lẻ là FRACTIONAL_QUANTITY, không thưởng, vẫn tính GMV) để không đọc nhầm dữ liệu / tài liệu cũ.
 */
export const CMS_QUANTITY_POLICY_VERSION: Readonly<Record<CmsQuantityBasis, string>> = {
  pos_base: 'pos_base_v1',
  cms_unit: 'cms_unit_v2',
}

export const CMS_RETURNS_POLICIES = ['sales_only_v1', 'net_returns_v1', 'full_line_qty_refund_v1'] as const
export type CmsReturnsPolicy = (typeof CMS_RETURNS_POLICIES)[number]
/** Policy có đọc nguồn trả (khác sales-only). */
export type CmsReturnProfile = Exclude<CmsReturnsPolicy, 'sales_only_v1'>
export const cmsPolicyReadsReturns = (p: CmsReturnsPolicy): p is CmsReturnProfile => p !== 'sales_only_v1'

/**
 * Phiên bản hợp đồng phép tính ròng (lib/cms/calc/net.ts) — ghim vào run cùng hai trục trên. v1 = run contract 130 (sales-only cms_unit /
 * net_returns_v1, KHÔNG đổi nghĩa); v2 = run của chương trình full_line_qty_refund_v1 (migration 132). Bộ (policy, hợp đồng, từ điển) cố
 * định theo policy — CHECK cms_sync_runs_contract_shape ép cùng bộ.
 */
export const CMS_CALC_CONTRACT_VERSION = 'cms-calc-ret2-v1'
export const CMS_CALC_CONTRACT_VERSION_V2 = 'cms-calc-ret2-v2'
/** Mọi hợp đồng run app này hiểu (khai ở open: `calc_contracts`). */
export const CMS_CALC_CONTRACT_VERSIONS = [CMS_CALC_CONTRACT_VERSION, CMS_CALC_CONTRACT_VERSION_V2] as const
export type CmsCalcContractVersion = (typeof CMS_CALC_CONTRACT_VERSIONS)[number]
export const cmsCalcContractVersionFor = (p: CmsReturnsPolicy): CmsCalcContractVersion =>
  p === 'full_line_qty_refund_v1' ? CMS_CALC_CONTRACT_VERSION_V2 : CMS_CALC_CONTRACT_VERSION

export function parseCmsQuantityBasis(v: unknown): CmsQuantityBasis | null {
  return typeof v === 'string' && (CMS_QUANTITY_BASES as readonly string[]).includes(v) ? (v as CmsQuantityBasis) : null
}

export function parseCmsReturnsPolicy(v: unknown): CmsReturnsPolicy | null {
  return typeof v === 'string' && (CMS_RETURNS_POLICIES as readonly string[]).includes(v) ? (v as CmsReturnsPolicy) : null
}
