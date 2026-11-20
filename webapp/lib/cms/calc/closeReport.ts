// CMS-CALC-RET-2 — payload BÁO CÁO TRẢ HÀNG SAU CHỐT (PM D11; thiết kế Dev r2 §6.6 + r2.1 §14.2; migration 130
// `rpc_cms_return_close_report_save`). Hàm thuần: payload chỉ gồm pin `cms-source-pin-v1` + phiếu trả đã chuẩn hoá (normalizeReturnRow).
// DB tự suy disposition / dược sĩ / SP / vân tay / số tiền từ dòng bán ĐÃ ĐÓNG BĂNG của run chốt và tính lại digest
// `cms-src-digest-v1` (cùng công thức seal N9) — app không gửi con số nào để DB tin. Báo cáo KHÔNG phải lệnh thu / chi.
// Chỉ dùng phía server.

import { formatCmsDecimal } from '../decimal'
import { formatUtcMicros } from '../time'
import { CMS_SOURCE_PIN_VERSION } from './contractStage'
import { compareUtf8Bytes } from './order'
import type { CmsReturnProfile } from './policy'
import { CMS_RETURN_EFFECTIVE_STATUS, type CmsReturnRecord } from './returns'
import { cmsCaptureSrc } from './src'
import { cmsDigestSet, cmsProductsHash, cmsReturnDigestHash } from './srcDigest'

/** Trần số phiếu / lượt của profile v1 (= DB `CMS_REPORT_TOO_LARGE`, 130 — giữ hợp đồng cũ). */
export const CMS_CLOSE_REPORT_MAX_RETURNS = 100_000
/**
 * Trần phiếu / báo cáo của profile full_line VÀ mọi run chốt contract, cùng DB. PM 18/11 audit r0 §3.3 đặt 20.000 kèm điều kiện bench
 * < 8 s; bench PG15 r1 (200.000 dòng bán, statement_timeout prod 8 s của authenticated / authenticator) đo 20.000 phiếu = 8,0–9,6 s ⇒ Dev
 * đề xuất 10.000 (TODO(Q-238): PM chốt; đổi hằng này + 2 chỗ SQL trong gen-cms-132.mjs). Vượt ⇒ dừng rõ `CMS_REPORT_TOO_LARGE`, 0 ghi —
 * KHÔNG cắt N đầu, không chia báo cáo (baseline sẽ thiếu).
 */
export const CMS_CLOSE_REPORT_MAX_RETURNS_FULL_LINE = 10_000
export const cmsCloseReportMaxReturns = (p: CmsReturnProfile): number =>
  p === 'full_line_qty_refund_v1' ? CMS_CLOSE_REPORT_MAX_RETURNS_FULL_LINE : CMS_CLOSE_REPORT_MAX_RETURNS

/** Quá trần phiếu / lượt của profile — người gọi map sang `CMS_REPORT_TOO_LARGE` (held, 0 ghi). */
export class CmsCloseReportTooLargeError extends Error {
  constructor(readonly rows: number, readonly max: number) { super('CMS close report: quá trần phiếu / lượt') }
}

/** 22 trường phiếu theo đúng tên cột `cms_return_lines` (không seq / disposition / sale_ref — DB tự suy). */
export type CmsCloseReportRow = Record<string, string | null>

const dec = (u: bigint) => formatCmsDecimal(u)
/** full_line: lượng BI / B / G gốc không thuộc hợp đồng ⇒ NULL (CHECK hình dạng 132). */
const decN = (u: bigint | null) => (u === null ? null : formatCmsDecimal(u))

/** Phiếu ↦ dòng payload. Chưa hiệu lực ⇒ chỉ ID + trạng thái thô (CHECK hình dạng của DB). */
export function cmsCloseReportReturnRow(r: CmsReturnRecord): CmsCloseReportRow {
  if (r.kind === 'NOT_EFFECTIVE') {
    return {
      return_event_id: r.returnEventId, return_status: r.status, return_document_id: null, return_code: null, recorded_at: null,
      original_order_line_id: null, original_order_id: null, product_id: null, return_base_quantity: null, return_gmv_amount: null,
      original_completed_at: null, original_order_type: null, original_order_status: null, original_seller_email: null, original_pos_code: null,
      original_base_quantity: null, original_gmv_amount: null, original_quantity_src: null, original_uom_src: null,
      original_quantity_src_flag: null, original_uom_src_flag: null, source_updated_at: null,
    }
  }
  const q = cmsCaptureSrc(r.original.quantityRaw)
  const u = cmsCaptureSrc(r.original.uomRaw)
  return {
    return_event_id: r.returnEventId, return_status: CMS_RETURN_EFFECTIVE_STATUS, return_document_id: r.returnDocumentId, return_code: r.returnCode,
    recorded_at: formatUtcMicros(r.recordedAtMicros), original_order_line_id: r.originalOrderLineId, original_order_id: r.originalOrderId,
    product_id: r.productId, return_base_quantity: decN(r.baseQuantityUnits), return_gmv_amount: dec(r.gmvUnits),
    original_completed_at: formatUtcMicros(r.original.completedAtMicros), original_order_type: r.original.orderType,
    original_order_status: r.original.orderStatus, original_seller_email: r.original.sellerEmail, original_pos_code: r.original.posCode,
    original_base_quantity: decN(r.original.baseQuantityUnits), original_gmv_amount: decN(r.original.gmvUnits),
    original_quantity_src: q.src, original_uom_src: u.src, original_quantity_src_flag: q.flag, original_uom_src_flag: u.flag,
    source_updated_at: r.sourceUpdatedAtMicros === null ? null : formatUtcMicros(r.sourceUpdatedAtMicros),
  }
}

/** Hash dòng `cms-src-digest-v1` của một phiếu (cùng contractStage / seal N9 / `cms__report_rows`). */
export function cmsCloseReportRowHash(r: CmsReturnRecord): string {
  if (r.kind === 'NOT_EFFECTIVE') {
    return cmsReturnDigestHash({
      returnEventId: r.returnEventId, returnStatus: r.status, returnDocumentId: null, returnCode: null, recordedAtMicros: null,
      originalOrderLineId: null, originalOrderId: null, productId: null, baseQuantityUnits: null, gmvUnits: null,
      originalCompletedAtMicros: null, originalOrderType: null, originalOrderStatus: null, originalSellerEmail: null, originalPosCode: null,
      originalBaseQuantityUnits: null, originalGmvUnits: null, originalQuantitySrc: null, originalUomSrc: null,
      originalQuantitySrcFlag: null, originalUomSrcFlag: null, sourceUpdatedAtMicros: null,
    })
  }
  const q = cmsCaptureSrc(r.original.quantityRaw)
  const u = cmsCaptureSrc(r.original.uomRaw)
  return cmsReturnDigestHash({
    returnEventId: r.returnEventId, returnStatus: CMS_RETURN_EFFECTIVE_STATUS, returnDocumentId: r.returnDocumentId, returnCode: r.returnCode,
    recordedAtMicros: r.recordedAtMicros, originalOrderLineId: r.originalOrderLineId, originalOrderId: r.originalOrderId, productId: r.productId,
    baseQuantityUnits: r.baseQuantityUnits, gmvUnits: r.gmvUnits, originalCompletedAtMicros: r.original.completedAtMicros,
    originalOrderType: r.original.orderType, originalOrderStatus: r.original.orderStatus, originalSellerEmail: r.original.sellerEmail,
    originalPosCode: r.original.posCode, originalBaseQuantityUnits: r.original.baseQuantityUnits, originalGmvUnits: r.original.gmvUnits,
    originalQuantitySrc: q.src, originalUomSrc: u.src, originalQuantitySrcFlag: q.flag, originalUomSrcFlag: u.flag,
    sourceUpdatedAtMicros: r.sourceUpdatedAtMicros,
  })
}

export interface CmsCloseReportProgram {
  startDate: string
  endDate: string
  productIds: readonly string[]
}

export interface CmsCloseReportMeta {
  provider: 'bq' | 'fixture'
  jobId?: string
  snapshotId?: string
  asOfMicros: bigint
  /** Super bấm tay (server action đã kiểm quyền); job định kỳ để trống ⇒ created_via cron. */
  actor?: string | null
  /**
   * Profile báo cáo (migration 132). Bỏ trống ⇒ net_returns_v1 (payload như 130, không có khoá `profile`). full_line ⇒ khoá `profile`
   * — chỉ gửi khi đường năng lực `full_line` bật (DB 130 không biết khoá này).
   */
  profile?: CmsReturnProfile
}

export interface CmsCloseReportPayload {
  pin: Record<string, unknown>
  returns: CmsCloseReportRow[]
  actor?: string
  profile?: 'full_line_qty_refund_v1'
}

/**
 * Payload `rpc_cms_return_close_report_save`. `returns` = MỌI phiếu provider trả cho snapshot (kể cả chưa hiệu lực) — thiếu nguồn ≠ 0
 * phiếu: người gọi KHÔNG được gọi hàm này khi provider lỗi. Sắp theo byte ID (DB tự sắp lại khi tính digest, thứ tự chỉ để ổn định).
 */
export function buildCmsCloseReportPayload(program: CmsCloseReportProgram, returns: readonly CmsReturnRecord[],
  meta: CmsCloseReportMeta): CmsCloseReportPayload {
  if ((meta.jobId === undefined) === (meta.snapshotId === undefined)) throw new Error('CMS close report: cần đúng một job_id / snapshot_id')
  const profile: CmsReturnProfile = meta.profile ?? 'net_returns_v1'
  const max = cmsCloseReportMaxReturns(profile)
  if (returns.length > max) throw new CmsCloseReportTooLargeError(returns.length, max)
  const sorted = [...returns].sort((a, b) => compareUtf8Bytes(a.returnEventId, b.returnEventId))
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].returnEventId === sorted[i - 1].returnEventId) throw new Error('CMS close report: trùng ID phiếu')
  }
  for (const r of sorted) {
    if (r.kind === 'COMPLETED' && r.profile !== profile) throw new Error('CMS close report: phiếu chuẩn hoá khác profile báo cáo')
  }
  const pin: Record<string, unknown> = {
    protocol: CMS_SOURCE_PIN_VERSION, provider: meta.provider,
    ...(meta.jobId !== undefined ? { job_id: meta.jobId } : { snapshot_id: meta.snapshotId }),
    as_of: formatUtcMicros(meta.asOfMicros),
    scope: { from: program.startDate, to: program.endDate, products_hash: cmsProductsHash(program.productIds) },
    returns: { rows: sorted.length, digest: cmsDigestSet('returns', sorted.map((r) => ({ id: r.returnEventId, hash: cmsCloseReportRowHash(r) }))) },
  }
  return {
    pin, returns: sorted.map(cmsCloseReportReturnRow), ...(meta.actor ? { actor: meta.actor } : {}),
    ...(profile === 'full_line_qty_refund_v1' ? { profile } : {}),
  }
}
