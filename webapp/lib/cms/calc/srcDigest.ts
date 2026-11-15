// CMS-CALC-RET-2 — digest pin nguồn `cms-src-digest-v1` (thiết kế Dev r2 §4.3; PM r2: staged_digest DB tự tính, rejected do worker
// chứng thực). Cùng hợp đồng SQL seal N9 của migration 130 (gen-cms-130.mjs ghim version) — mọi thay đổi phải đổi version + chạy lại
// harness parity TS ↔ PGlite ↔ PG15.
//  · token trường: `<số byte UTF-8>:<giá trị>`; NULL ⇒ `-` (token giá trị luôn mở đầu bằng chữ số ⇒ không lẫn).
//  · số thập phân ⇒ chuỗi số nguyên đơn vị 10⁻⁹; thời điểm ⇒ µs UTC số nguyên.
//  · hash dòng = sha256 hex của các token nối liền; digest tập = sha256 hex của
//    `<version>\n<loại>\n<số dòng>\n<hash dòng nối bằng \n theo thứ tự BYTE UTF-8 của ID>`.
//  · tập SP (products_hash): `<version>\nproducts\n<số SP>\n<ProductID nối bằng \n theo byte>`.
// Chỉ dùng phía server (node:crypto).

import { createHash } from 'node:crypto'
import { compareUtf8Bytes } from './order'

export const CMS_SRC_DIGEST_VERSION = 'cms-src-digest-v1'

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const utf8Len = (s: string) => Buffer.byteLength(s, 'utf8')

export const cmsDigestToken = (v: string | null): string => (v === null ? '-' : `${utf8Len(v)}:${v}`)
export const cmsDigestRowHash = (fields: readonly (string | null)[]): string => sha(fields.map(cmsDigestToken).join(''))

export type CmsDigestKind = 'sales' | 'returns' | 'rejected'

/** Digest một tập dòng: mỗi phần tử = ID (khoá sắp byte, duy nhất) + hash dòng. */
export function cmsDigestSet(kind: CmsDigestKind, rows: readonly { id: string; hash: string }[]): string {
  const sorted = [...rows].sort((a, b) => compareUtf8Bytes(a.id, b.id))
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i - 1].id === sorted[i].id) throw new Error(`CMS digest: ID trùng trong tập ${kind}`)
  }
  return sha(`${CMS_SRC_DIGEST_VERSION}\n${kind}\n${rows.length}\n${sorted.map((r) => r.hash).join('\n')}`)
}

export function cmsProductsHash(productIds: readonly string[]): string {
  const sorted = [...productIds].sort(compareUtf8Bytes)
  return sha(`${CMS_SRC_DIGEST_VERSION}\nproducts\n${sorted.length}\n${sorted.join('\n')}`)
}

/** 16 trường dòng nguồn bán (thứ tự cố định — khớp SQL N9). Chuỗi đã ở dạng stage (số / thời điểm chuyển sẵn). */
export interface CmsSalesDigestFields {
  orderLineId: string; orderId: string; orderCode: string; productId: string; sellerEmail: string | null; posCode: string | null
  orderType: string; orderStatus: string; completedAtMicros: bigint; sourceUpdatedAtMicros: bigint
  quantitySrc: string | null; uomSrc: string | null; quantitySrcFlag: string | null; uomSrcFlag: string | null
  baseQuantityUnits: bigint; gmvUnits: bigint
}
export const cmsSalesDigestHash = (x: CmsSalesDigestFields): string => cmsDigestRowHash([
  x.orderLineId, x.orderId, x.orderCode, x.productId, x.sellerEmail, x.posCode, x.orderType, x.orderStatus,
  x.completedAtMicros.toString(), x.sourceUpdatedAtMicros.toString(), x.quantitySrc, x.uomSrc, x.quantitySrcFlag, x.uomSrcFlag,
  x.baseQuantityUnits.toString(), x.gmvUnits.toString(),
])

/** 22 trường phiếu trả (thứ tự cố định — khớp SQL N9). Phiếu chưa hiệu lực: chỉ ID + trạng thái, còn lại null. */
export interface CmsReturnDigestFields {
  returnEventId: string; returnStatus: string; returnDocumentId: string | null; returnCode: string | null; recordedAtMicros: bigint | null
  originalOrderLineId: string | null; originalOrderId: string | null; productId: string | null
  baseQuantityUnits: bigint | null; gmvUnits: bigint | null; originalCompletedAtMicros: bigint | null
  originalOrderType: string | null; originalOrderStatus: string | null; originalSellerEmail: string | null; originalPosCode: string | null
  originalBaseQuantityUnits: bigint | null; originalGmvUnits: bigint | null
  originalQuantitySrc: string | null; originalUomSrc: string | null; originalQuantitySrcFlag: string | null; originalUomSrcFlag: string | null
  sourceUpdatedAtMicros: bigint | null
}
const n = (v: bigint | null) => (v === null ? null : v.toString())
export const cmsReturnDigestHash = (x: CmsReturnDigestFields): string => cmsDigestRowHash([
  x.returnEventId, x.returnStatus, x.returnDocumentId, x.returnCode, n(x.recordedAtMicros), x.originalOrderLineId, x.originalOrderId,
  x.productId, n(x.baseQuantityUnits), n(x.gmvUnits), n(x.originalCompletedAtMicros), x.originalOrderType, x.originalOrderStatus,
  x.originalSellerEmail, x.originalPosCode, n(x.originalBaseQuantityUnits), n(x.originalGmvUnits), x.originalQuantitySrc, x.originalUomSrc,
  x.originalQuantitySrcFlag, x.originalUomSrcFlag, n(x.sourceUpdatedAtMicros),
])
