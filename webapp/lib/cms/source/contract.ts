// CMS — hợp đồng hai nguồn logic (docs/cms/SPEC.md §1): Product Master và dòng
// đơn. Mọi giá trị vào dạng chuỗi (BigQuery trả NUMERIC/TIMESTAMP là chuỗi;
// adapter SQL ép kiểu chuẩn). Thiếu trường bắt buộc ⇒ lỗi dòng (adapter
// production TỪ CHỐI, không tự điền mặc định — vd. không gán OFFLINE theo tiền
// tố mã đơn). Không mang thông tin khách hàng. Text bị cắt ký tự điều khiển và
// giới hạn độ dài (quá ⇒ lỗi, không cắt). Ảnh qua allow-list (lib/cms/image.ts).
// Issue chỉ mang TÊN trường, không mang giá trị. Hàm thuần, không I/O.

import { CMS_DEC_FACTOR, parseCmsDecimal, type CmsDecError } from '../decimal'
import { cmsSafeImageUrl } from '../image'
import { canonicalProductId } from '../productId'
import { parseUtcMicros } from '../time'

export type CmsRawRow = Record<string, string | null | undefined>

/** Trần giá tham khảo khớp CHECK DB cms_product_master.reference_price < 1e15 (migration 120). */
export const CMS_REFERENCE_PRICE_MAX_EXCLUSIVE = BigInt('1000000000000000') * CMS_DEC_FACTOR

export type CmsRowIssue =
  | { kind: 'MISSING_FIELD'; field: string }
  | { kind: 'BAD_PRODUCT_ID'; field: string }
  | { kind: 'BAD_NUMBER'; field: string; error: CmsDecError }
  | { kind: 'BAD_TIMESTAMP'; field: string }
  | { kind: 'BAD_BOOLEAN'; field: string }
  | { kind: 'BAD_TEXT'; field: string }

export type CmsNormalizeResult<T> = { ok: true; value: T } | { ok: false; issues: CmsRowIssue[] }

// Ký tự điều khiển C0 + DEL + C1 (U+0080–009F) ⇒ khoảng trắng (không lưu / xuất ký tự điều khiển). Cùng lớp với regex stage
// của migration 122 (db-reviewer P2-3) — lệch lớp ⇒ một dòng nguồn có C1 làm run kẹt lỗi mãi.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/g

const text = (v: string | null | undefined): string | null => {
  if (v === null || v === undefined) return null
  const t = v.replace(CONTROL_RE, ' ').trim()
  return t === '' ? null : t
}

/** Đọc text có trần độ dài; quá trần ⇒ issue BAD_TEXT (không cắt ngầm). */
function cappedText(raw: CmsRawRow, field: string, max: number, issues: CmsRowIssue[]): string | null {
  const t = text(raw[field])
  if (t !== null && t.length > max) {
    issues.push({ kind: 'BAD_TEXT', field })
    return null
  }
  return t
}

export function normalizeCmsEmail(v: string | null | undefined): string | null {
  const t = text(v)
  return t === null ? null : t.toLowerCase()
}

// ── Dòng đơn ────────────────────────────────────────────────────────────────

/** Cột chuẩn của nguồn dòng đơn (view BI / adapter). */
export const CMS_SALES_COLUMNS = [
  'order_line_id', 'order_id', 'order_code', 'product_id', 'seller_email', 'pos_code', 'order_type',
  'order_status', 'completed_at', 'quantity_raw', 'uom_raw', 'base_quantity', 'gmv_amount', 'source_updated_at',
] as const

const SALES_REQUIRED = [
  'order_line_id', 'order_id', 'order_code', 'product_id', 'order_type', 'order_status', 'completed_at',
  'base_quantity', 'gmv_amount', 'source_updated_at',
] as const

const SALES_TEXT_MAX: Record<string, number> = {
  order_line_id: 100, order_id: 100, order_code: 100, seller_email: 320, pos_code: 50,
  order_type: 30, order_status: 30, quantity_raw: 50, uom_raw: 50,
}

export interface CmsSalesLine {
  orderLineId: string
  orderId: string
  orderCode: string
  productId: string
  /** trim + lowercase; null khi nguồn không có email (⇒ "Chưa gán dược sĩ"). */
  sellerEmail: string | null
  posCode: string | null
  orderType: string
  orderStatus: string
  completedAtMicros: bigint
  quantityRaw: string | null
  uomRaw: string | null
  /** Tổng số lượng cơ sở của cả dòng, scale 9 (không nhân lại với quantity). */
  baseQuantityUnits: bigint
  /** Nguyên `item.amount`, scale 9 (giữ VAT, không phân bổ voucher). */
  gmvUnits: bigint
  sourceUpdatedAtMicros: bigint
}

export function normalizeSalesRow(raw: CmsRawRow): CmsNormalizeResult<CmsSalesLine> {
  const issues: CmsRowIssue[] = []
  for (const f of SALES_REQUIRED) if (text(raw[f]) === null) issues.push({ kind: 'MISSING_FIELD', field: f })
  if (issues.length) return { ok: false, issues }

  const t: Record<string, string | null> = {}
  for (const [f, max] of Object.entries(SALES_TEXT_MAX)) t[f] = cappedText(raw, f, max, issues)
  const pid = canonicalProductId(text(raw.product_id))
  if (!pid.ok) issues.push({ kind: 'BAD_PRODUCT_ID', field: 'product_id' })
  // Số âm ở base_quantity / amount được ĐỌC (không clamp) để engine/quality quyết
  // định; quy thuộc trả hàng vẫn HOLD Q-206 — không suy dòng âm từ status.
  const bq = parseCmsDecimal(text(raw.base_quantity)!, { allowNegative: true })
  if (!bq.ok) issues.push({ kind: 'BAD_NUMBER', field: 'base_quantity', error: bq.error })
  const gmv = parseCmsDecimal(text(raw.gmv_amount)!, { allowNegative: true })
  if (!gmv.ok) issues.push({ kind: 'BAD_NUMBER', field: 'gmv_amount', error: gmv.error })
  const completed = parseUtcMicros(text(raw.completed_at)!)
  if (completed === null) issues.push({ kind: 'BAD_TIMESTAMP', field: 'completed_at' })
  const updated = parseUtcMicros(text(raw.source_updated_at)!)
  if (updated === null) issues.push({ kind: 'BAD_TIMESTAMP', field: 'source_updated_at' })
  if (issues.length || !pid.ok || !bq.ok || !gmv.ok || completed === null || updated === null) {
    return { ok: false, issues }
  }
  return {
    ok: true,
    value: {
      orderLineId: t.order_line_id!,
      orderId: t.order_id!,
      orderCode: t.order_code!,
      productId: pid.id,
      sellerEmail: t.seller_email === null ? null : t.seller_email.toLowerCase(),
      posCode: t.pos_code,
      orderType: t.order_type!,
      orderStatus: t.order_status!,
      completedAtMicros: completed,
      quantityRaw: t.quantity_raw,
      uomRaw: t.uom_raw,
      baseQuantityUnits: bq.units,
      gmvUnits: gmv.units,
      sourceUpdatedAtMicros: updated,
    },
  }
}

/** Dòng ứng viên tính CMS theo loại/trạng thái đơn (plan §2.5 điều kiện 1–2). */
export function isEligibleOrder(line: Pick<CmsSalesLine, 'orderType' | 'orderStatus'>): boolean {
  return line.orderType === 'OFFLINE' && line.orderStatus === 'COMPLETED'
}

// ── Product Master ──────────────────────────────────────────────────────────

export const CMS_PRODUCT_COLUMNS = [
  'product_id', 'product_name', 'image_url', 'is_active', 'source_updated_at', 'reference_price', 'price_unit',
] as const

export interface CmsProductMasterRow {
  productId: string
  productName: string
  /** Chỉ URL qua allow-list (lib/cms/image.ts); ngoài allow-list ⇒ null. */
  imageUrl: string | null
  /** Nguồn có URL ảnh nhưng ngoài allow-list ⇒ cảnh báo cho operator kiểm nguồn (không loại dòng). */
  imageRejected: boolean
  isActive: boolean
  sourceUpdatedAtMicros: bigint
  /** Tùy chọn (chỉ hiển thị/ước tính); null khi nguồn không có. */
  referencePriceUnits: bigint | null
  priceUnit: string | null
}

export function normalizeProductRow(raw: CmsRawRow): CmsNormalizeResult<CmsProductMasterRow> {
  const issues: CmsRowIssue[] = []
  for (const f of ['product_id', 'product_name', 'is_active', 'source_updated_at'] as const) {
    if (text(raw[f]) === null) issues.push({ kind: 'MISSING_FIELD', field: f })
  }
  if (issues.length) return { ok: false, issues }
  const pid = canonicalProductId(text(raw.product_id))
  if (!pid.ok) issues.push({ kind: 'BAD_PRODUCT_ID', field: 'product_id' })
  const name = cappedText(raw, 'product_name', 500, issues)
  const priceUnit = cappedText(raw, 'price_unit', 50, issues)
  const activeRaw = text(raw.is_active)!.toLowerCase()
  if (activeRaw !== 'true' && activeRaw !== 'false') issues.push({ kind: 'BAD_BOOLEAN', field: 'is_active' })
  const updated = parseUtcMicros(text(raw.source_updated_at)!)
  if (updated === null) issues.push({ kind: 'BAD_TIMESTAMP', field: 'source_updated_at' })
  let price: bigint | null = null
  const priceText = text(raw.reference_price)
  if (priceText !== null) {
    const p = parseCmsDecimal(priceText)
    if (!p.ok) issues.push({ kind: 'BAD_NUMBER', field: 'reference_price', error: p.error })
    // ≥ 1e15 vượt CHECK DB ⇒ lỗi dòng ở app (held, không ghi) thay vì vỡ RPC giữa lượt (UPSERT_FAILED ghi dở).
    else if (p.units >= CMS_REFERENCE_PRICE_MAX_EXCLUSIVE) issues.push({ kind: 'BAD_NUMBER', field: 'reference_price', error: 'RANGE' })
    else price = p.units
  }
  if (issues.length || !pid.ok || name === null || updated === null) return { ok: false, issues }
  const imageRaw = text(raw.image_url)
  const imageUrl = cmsSafeImageUrl(imageRaw)
  return {
    ok: true,
    value: {
      productId: pid.id,
      productName: name,
      imageUrl,
      imageRejected: imageRaw !== null && imageUrl === null,
      isActive: activeRaw === 'true',
      sourceUpdatedAtMicros: updated,
      referencePriceUnits: price,
      priceUnit,
    },
  }
}
