// CMS-CALC-RET-2 §4.1 / §5 (Q-229 / Q-230; planning/research/cms-returns-source-confirmed-r2-2026-11-13.md) — hợp đồng chuẩn của
// nguồn TRẢ HÀNG (một dòng = một item phiếu trả, kèm ngữ cảnh dòng bán gốc để đối chiếu lớp bán đã lưu). Tên cột chuẩn của app; tên
// vật lý / FQN view cuối do BI chốt (chưa có — adapter thật CHƯA viết). Mọi giá trị vào là chuỗi (INT64 / NUMERIC / TIMESTAMP đã CAST
// STRING ở SQL), không Number.
//  · Trạng thái theo TỪ ĐIỂN có version (PM D13, review P1/P2 r1): chỉ đúng chuỗi COMPLETED có hiệu lực; APPROVED = chưa hiệu lực đã
//    biết ⇒ NOT_EFFECTIVE, KHÔNG đòi completed_at (APPROVED có ngày NULL là hợp lệ — r2 §7.1). Mọi giá trị khác — trạng thái lạ, sai
//    hoa / thường, có khoảng trắng / ký tự điều khiển / vô hình — ⇒ issue UNKNOWN_STATUS (lỗi nguồn ⇒ HOLD cả lượt), so trên chuỗi THÔ,
//    không trim / uppercase / đoán. Thiếu ⇒ MISSING_FIELD. BI bổ sung trạng thái chưa hiệu lực khác ⇒ tăng version từ điển, không
//    wildcard. Không thêm điều kiện approved_at / OTP / payment_status.
//  · COMPLETED thiếu / hỏng trường bắt buộc ⇒ issue (lỗi nguồn ⇒ HOLD cả lượt) — không giả 0, không bỏ dòng.
//  · Lượng trả = item.base_quantity — TỔNG base cả dòng, số nguyên > 0 (INT64); không nhân quantity / received_quantity. ≤ 0 ⇒ issue
//    (hoàn tiền không lượng / đổi hàng nằm ngoài contract).
//  · GMV trả = item.refund_amount — decimal ≥ 0, ≤ 9 chữ số lẻ; không amount / base_amount / header total, không phân bổ giá gốc.
//  · Ngữ cảnh dòng gốc (original_*) chỉ để kiểm lineage / nhất quán snapshot với lớp bán; người hưởng = người bán GỐC — không có cột
//    người xử lý phiếu trả (created_by / approved_by) trong hợp đồng.
// Issue chỉ mang TÊN trường, không mang giá trị. Hàm thuần, không I/O.

import { CMS_DEC_FACTOR, parseCmsDecimal, type CmsDecError } from '../decimal'
import { canonicalProductId } from '../productId'
import type { CmsRawRow } from '../source/contract'
import { parseUtcMicros } from '../time'

const ZERO = BigInt(0)

export const CMS_RETURN_COLUMNS = [
  'return_event_id', 'return_document_id', 'return_code', 'return_status', 'return_recorded_at',
  'original_order_line_id', 'original_order_id', 'product_id', 'return_base_quantity', 'return_gmv_amount',
  'original_completed_at', 'original_order_type', 'original_order_status', 'original_seller_email', 'original_pos_code',
  'original_base_quantity', 'original_gmv_amount', 'original_quantity_raw', 'original_uom_raw', 'source_updated_at',
] as const

/** Trạng thái header có hiệu lực điều chỉnh CMS (Q-230 A). */
export const CMS_RETURN_EFFECTIVE_STATUS = 'COMPLETED'

/** Từ điển trạng thái phiếu trả của contract (D13). Đổi / thêm trạng thái ⇒ tăng version (pin theo run). */
export const CMS_RETURN_STATUS_DICTIONARY_VERSION = 'cms-return-status-v1'
export type CmsReturnStatusEffect = 'EFFECTIVE' | 'NOT_EFFECTIVE'
/** Map (không phải object literal) để khoá như `constructor` / `__proto__` không lọt qua tra cứu. */
export const CMS_RETURN_STATUS_DICTIONARY: ReadonlyMap<string, CmsReturnStatusEffect> = new Map<string, CmsReturnStatusEffect>([
  [CMS_RETURN_EFFECTIVE_STATUS, 'EFFECTIVE'],
  ['APPROVED', 'NOT_EFFECTIVE'],
])

const COMPLETED_REQUIRED = [
  'return_document_id', 'return_recorded_at', 'original_order_line_id', 'original_order_id', 'product_id',
  'return_base_quantity', 'return_gmv_amount', 'original_completed_at', 'original_order_type', 'original_order_status',
  'original_base_quantity', 'original_gmv_amount',
] as const

const TEXT_MAX: Record<string, number> = {
  return_event_id: 100, return_document_id: 100, return_code: 100, return_status: 30, original_order_line_id: 100,
  original_order_id: 100, original_order_type: 30, original_order_status: 30, original_seller_email: 320, original_pos_code: 50,
}

export type CmsReturnIssue =
  | { kind: 'MISSING_FIELD'; field: string }
  | { kind: 'BAD_TEXT'; field: string }
  | { kind: 'UNKNOWN_STATUS'; field: 'return_status' }
  | { kind: 'BAD_PRODUCT_ID'; field: string }
  | { kind: 'BAD_TIMESTAMP'; field: string }
  | { kind: 'BAD_NUMBER'; field: string; error: CmsDecError | 'NOT_INTEGER' }
  | { kind: 'RETURN_QTY_NOT_POSITIVE'; field: 'return_base_quantity' }

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/g
const text = (v: string | null | undefined): string | null => {
  if (v === null || v === undefined) return null
  const t = v.replace(CONTROL_RE, ' ').trim()
  return t === '' ? null : t
}

export interface CmsReturnOriginalContext {
  completedAtMicros: bigint
  orderType: string
  orderStatus: string
  /** trim + lowercase; null ⇒ không có email người bán gốc. */
  sellerEmail: string | null
  posCode: string | null
  baseQuantityUnits: bigint
  gmvUnits: bigint
  /** Chuỗi THÔ (chỉ so ở mode cms_unit). */
  quantityRaw: string | null
  uomRaw: string | null
}

export interface CmsReturnCompleted {
  kind: 'COMPLETED'
  returnEventId: string
  returnDocumentId: string
  returnCode: string | null
  recordedAtMicros: bigint
  originalOrderLineId: string
  originalOrderId: string
  productId: string
  /** Tổng base trả của dòng, scale 9 (nguồn INT64 × 10^9). */
  baseQuantityUnits: bigint
  /** refund_amount, scale 9, ≥ 0. */
  gmvUnits: bigint
  original: CmsReturnOriginalContext
  sourceUpdatedAtMicros: bigint | null
}

export interface CmsReturnNotEffective {
  kind: 'NOT_EFFECTIVE'
  returnEventId: string
  status: string
}

export type CmsReturnRecord = CmsReturnCompleted | CmsReturnNotEffective

export type CmsReturnNormalizeResult = { ok: true; value: CmsReturnRecord } | { ok: false; issues: CmsReturnIssue[] }

const INT_RE = /^-?[0-9]+$/

export function normalizeReturnRow(raw: CmsRawRow): CmsReturnNormalizeResult {
  const issues: CmsReturnIssue[] = []
  const t: Record<string, string | null> = {}
  for (const [f, max] of Object.entries(TEXT_MAX)) {
    const v = text(raw[f])
    if (v !== null && v.length > max) { issues.push({ kind: 'BAD_TEXT', field: f }); t[f] = null } else t[f] = v
  }
  for (const f of ['return_event_id', 'return_status'] as const) if (text(raw[f]) === null) issues.push({ kind: 'MISSING_FIELD', field: f })
  if (issues.length) return { ok: false, issues }
  // So chuỗi THÔ với từ điển: `Completed`, ` COMPLETED`, `COMPLETED\u0000`, `REJECTED`… đều là lỗi nguồn — không im lặng thành "không có
  // trả" (bỏ sót trả làm CMS cao hơn).
  const status = raw.return_status as string
  const effect = CMS_RETURN_STATUS_DICTIONARY.get(status)
  if (effect === undefined) return { ok: false, issues: [{ kind: 'UNKNOWN_STATUS', field: 'return_status' }] }
  if (effect === 'NOT_EFFECTIVE') return { ok: true, value: { kind: 'NOT_EFFECTIVE', returnEventId: t.return_event_id!, status } }

  for (const f of COMPLETED_REQUIRED) if (text(raw[f]) === null) issues.push({ kind: 'MISSING_FIELD', field: f })
  if (issues.length) return { ok: false, issues }

  const pid = canonicalProductId(text(raw.product_id))
  if (!pid.ok) issues.push({ kind: 'BAD_PRODUCT_ID', field: 'product_id' })
  const recorded = parseUtcMicros(text(raw.return_recorded_at)!)
  if (recorded === null) issues.push({ kind: 'BAD_TIMESTAMP', field: 'return_recorded_at' })
  const origAt = parseUtcMicros(text(raw.original_completed_at)!)
  if (origAt === null) issues.push({ kind: 'BAD_TIMESTAMP', field: 'original_completed_at' })
  const updText = text(raw.source_updated_at)
  const updated = updText === null ? null : parseUtcMicros(updText)
  if (updText !== null && updated === null) issues.push({ kind: 'BAD_TIMESTAMP', field: 'source_updated_at' })

  let baseUnits = ZERO
  const bqText = text(raw.return_base_quantity)!
  if (!INT_RE.test(bqText)) issues.push({ kind: 'BAD_NUMBER', field: 'return_base_quantity', error: 'NOT_INTEGER' })
  else {
    const bq = parseCmsDecimal(bqText, { allowNegative: true })
    if (!bq.ok) issues.push({ kind: 'BAD_NUMBER', field: 'return_base_quantity', error: bq.error })
    else if (bq.units <= ZERO) issues.push({ kind: 'RETURN_QTY_NOT_POSITIVE', field: 'return_base_quantity' })
    else baseUnits = bq.units
  }
  const refund = parseCmsDecimal(text(raw.return_gmv_amount)!)
  if (!refund.ok) issues.push({ kind: 'BAD_NUMBER', field: 'return_gmv_amount', error: refund.error })
  const ob = parseCmsDecimal(text(raw.original_base_quantity)!, { allowNegative: true })
  if (!ob.ok) issues.push({ kind: 'BAD_NUMBER', field: 'original_base_quantity', error: ob.error })
  const og = parseCmsDecimal(text(raw.original_gmv_amount)!, { allowNegative: true })
  if (!og.ok) issues.push({ kind: 'BAD_NUMBER', field: 'original_gmv_amount', error: og.error })

  // Không đặt trần độ dài ở đây: q / u gốc chỉ được so ở mode cms_unit (net.ts, so bằng chuỗi thô của lớp bán — lớp bán đã giới hạn 50
  // ký tự ⇒ chuỗi dài hơn tự lệch ⇒ HOLD); pos_base không dùng q / u nên không được HOLD vì chúng (A09).
  const rawStr = (f: 'original_quantity_raw' | 'original_uom_raw'): string | null => {
    const v = raw[f]
    return v === null || v === undefined ? null : v
  }
  const qRaw = rawStr('original_quantity_raw')
  const uRaw = rawStr('original_uom_raw')

  if (issues.length || !pid.ok || recorded === null || origAt === null || !refund.ok || !ob.ok || !og.ok) return { ok: false, issues }
  return {
    ok: true,
    value: {
      kind: 'COMPLETED',
      returnEventId: t.return_event_id!,
      returnDocumentId: t.return_document_id!,
      returnCode: t.return_code,
      recordedAtMicros: recorded,
      originalOrderLineId: t.original_order_line_id!,
      originalOrderId: t.original_order_id!,
      productId: pid.id,
      baseQuantityUnits: baseUnits,
      gmvUnits: refund.units,
      original: {
        completedAtMicros: origAt,
        orderType: t.original_order_type!,
        orderStatus: t.original_order_status!,
        sellerEmail: t.original_seller_email === null ? null : t.original_seller_email.toLowerCase(),
        posCode: t.original_pos_code,
        baseQuantityUnits: ob.units,
        gmvUnits: og.units,
        quantityRaw: qRaw,
        uomRaw: uRaw,
      },
      sourceUpdatedAtMicros: updated,
    },
  }
}


/** Lượng base INT64 ⇒ units scale 9 (tiện cho fixture). */
export const cmsReturnBaseUnits = (n: bigint): bigint => n * CMS_DEC_FACTOR
