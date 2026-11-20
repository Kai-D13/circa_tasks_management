// CMS-CALC-RET-2 P5.1 — trình bày + đầu vào của hai trục chính sách cấp CHƯƠNG TRÌNH (spec §2, §8.1; PM work order P5 14/11 §4).
// Thuần, an toàn ở client. Định danh kỹ thuật + nhãn chốt ở `policy.ts`; file này chỉ thêm ví dụ / nguồn / nhãn chính sách trả và luật
// đầu vào của form (radio bắt buộc — không checkbox, không cột Excel).

import {
  CMS_QUANTITY_BASIS_LABEL, CMS_QUANTITY_BASES, parseCmsQuantityBasis, parseCmsReturnsPolicy,
  type CmsQuantityBasis, type CmsReturnsPolicy,
} from './policy'

export { CMS_QUANTITY_BASIS_LABEL, CMS_QUANTITY_BASES, parseCmsQuantityBasis }
export type { CmsQuantityBasis, CmsReturnsPolicy }

/** Nguồn của cách tính (cột quantity_basis_source, migration 130). */
export type CmsBasisSource = 'legacy_migration' | 'legacy_compat' | 'admin' | 'pending'
const SOURCES: readonly CmsBasisSource[] = ['legacy_migration', 'legacy_compat', 'admin', 'pending']

/** Cách tính + chính sách trả của một chương trình, đọc từ DB (chỉ khi DB có đường program_modes). */
export interface CmsProgramBasis {
  /** null ⇔ source = 'pending' (nháp chưa chọn). */
  basis: CmsQuantityBasis | null
  source: CmsBasisSource
  returnsPolicy: CmsReturnsPolicy
}

/** Ví dụ ngắn đi kèm từng lựa chọn (Q-227 / Q-231 / Q-232; K100, mức theo thang). */
export const CMS_QUANTITY_BASIS_HINT: Readonly<Record<CmsQuantityBasis, string>> = {
  pos_base: 'Cộng toàn bộ lượng bán quy đổi ra đơn vị cơ sở của dược sĩ trong kỳ rồi mới chia K. Ví dụ K = 100 viên/hộp: 20 đơn × 5 viên = 100 viên ⇒ 1 hộp được tính.',
  cms_unit: 'Chỉ tính dòng bán đúng đơn vị CMS với số lượng nguyên. Dòng khác đơn vị hoặc có số lẻ (ví dụ 1,5 hộp) không được tính lượng thưởng — cả dòng — nhưng vẫn vào GMV. Ví dụ 20 đơn × 5 viên ⇒ 0 hộp.',
}

/** Chương trình không do admin chọn qua lựa chọn mới. */
export const CMS_BASIS_SOURCE_NOTE: Readonly<Record<CmsBasisSource, string | null>> = {
  legacy_migration: 'Chương trình có trước khi có lựa chọn cách tính — giữ cộng dồn',
  legacy_compat: 'Tạo khi chưa bật lựa chọn cách tính — mặc định cộng dồn, chưa được xác nhận',
  admin: null,
  pending: 'Chưa chọn cách tính',
}

export const CMS_RETURNS_POLICY_LABEL: Readonly<Record<CmsReturnsPolicy, string>> = {
  sales_only_v1: 'Chưa trừ trả hàng',
  net_returns_v1: 'Trừ trả hàng hoàn tất',
  // Q-236 / BR12 — nhãn PM chốt; không mô tả là số hàng thực nhập lại kho.
  full_line_qty_refund_v1: 'Trừ đủ lượng dòng bán khi có trả; GMV theo tiền hoàn',
}

export function parseCmsBasisSource(v: unknown): CmsBasisSource | null {
  return typeof v === 'string' && (SOURCES as readonly string[]).includes(v) ? (v as CmsBasisSource) : null
}

/** Đọc một dòng DB (quantity_basis, quantity_basis_source, returns_policy) — lạ / lệch cặp ⇒ null (caller fail-closed). */
export function parseCmsProgramBasisRow(r: { quantity_basis?: unknown; quantity_basis_source?: unknown; returns_policy?: unknown }): CmsProgramBasis | null {
  const source = parseCmsBasisSource(r.quantity_basis_source)
  if (!source) return null
  const basis = r.quantity_basis === null ? null : parseCmsQuantityBasis(r.quantity_basis)
  if ((source === 'pending') !== (basis === null)) return null
  if (r.quantity_basis !== null && basis === null) return null
  const rp = parseCmsReturnsPolicy(r.returns_policy)
  if (!rp) return null
  return { basis, source, returnsPolicy: rp }
}

/**
 * Cách tính đã được admin chọn tường minh qua lựa chọn mới. Khi bật lựa chọn mode, kích hoạt một NHÁP cần điều này (spec §2, §6.1.1):
 * nháp legacy_compat (tạo khi cờ OFF) / legacy_migration (nháp có trước 130) / pending đều phải chọn lại trước khi kích hoạt.
 */
export function cmsBasisConfirmed(b: CmsProgramBasis): boolean {
  return b.source === 'admin'
}

/** Giá trị form gửi lên: chỉ hai định danh; trống / lạ ⇒ lỗi (radio bắt buộc, không mặc định). */
export function normalizeCmsBasisInput(raw: unknown): { ok: true; value: CmsQuantityBasis } | { ok: false; error: string } {
  const b = parseCmsQuantityBasis(raw)
  return b ? { ok: true, value: b } : { ok: false, error: 'Chọn cách tính lượng cho chương trình' }
}

// Cột "Cách tính" tự thêm vào file import: cách tính là lựa chọn cấp chương trình (spec §8.5) — không bỏ qua im lặng.
const strip = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
  .toLowerCase().replace(/[\s_\-./]+/g, ' ').trim()
const BASIS_HEADER_RE = /^(cach tinh( luong| cms)?|quantity basis|che do tinh|kieu tinh|tinh le|tinh nguyen|mode tinh|calc mode|basis)$/

/** Tiêu đề cột là cột "Cách tính" (không phân biệt dấu / hoa thường / khoảng trắng / gạch dưới). */
export function cmsIsBasisHeader(text: unknown): boolean {
  return typeof text === 'string' && text.length <= 100 && BASIS_HEADER_RE.test(strip(text))
}
