// CMS-CALC-RET-2 — dấu vân tay tài chính của phiếu trả và capture chuỗi thô q / u (thiết kế Dev r2 §4.1 / §6.1; review PM P1/P2 r1
// RET2-DB-01 / RET2-DB-04 / D2). Cùng hợp đồng với SQL migration 130 (`cms__return_fp`, `cms__src_clean`) — mọi thay đổi phải đổi
// version và chạy lại harness parity TS ↔ PGlite ↔ PG15.
//  · financial_fp = sha256 hex của tuple chuẩn có version; mỗi trường mã hoá `<độ dài byte UTF-8>:<giá trị>` nối liền (không mơ hồ
//    delimiter, không escape); số thập phân → chuỗi số nguyên đơn vị 10⁻⁹; thời điểm → µs UTC số nguyên. KHÔNG gồm email / user /
//    store (mapping trôi không được làm "đổi tiền").
//  · capture thô: trước MỌI làm sạch; NUL ⇒ NULL + cờ NUL (PG text / jsonb không chứa U+0000); > 64 code point ⇒ NULL + cờ OVERSIZE.
//  · làm sạch = đúng `text()` của lớp nguồn (source/contract.ts): ký tự điều khiển → space, `String.prototype.trim()`, rỗng ⇒ null.
// Chỉ dùng phía server (node:crypto).

import { createHash } from 'node:crypto'

export const CMS_RETURN_FP_VERSION = 'cms-return-fp-v1'
// Capture / làm sạch chuỗi thô ở module thuần ./src (classify.ts dùng được không kéo node:crypto); re-export giữ API cũ.
export { CMS_SRC_MAX, cmsCaptureSrc, cmsSrcClean, type CmsSrcCapture, type CmsSrcFlag } from './src'

const utf8Len = (s: string) => Buffer.byteLength(s, 'utf8')
/** Mã hoá tuple: mỗi phần `<byte UTF-8>:<giá trị>`, nối liền. */
export function cmsLenPrefixed(parts: readonly string[]): string {
  let out = ''
  for (const p of parts) out += `${utf8Len(p)}:${p}`
  return out
}

export interface CmsReturnFpInput {
  programId: string
  returnEventId: string
  returnDocumentId: string
  originalOrderLineId: string
  originalOrderId: string
  productId: string
  /** base_quantity × 10⁹ (bigint scale 9). */
  baseUnits: bigint
  /** refund_amount × 10⁹. */
  refundUnits: bigint
  recordedAtMicros: bigint
}

export function cmsReturnFinancialFp(x: CmsReturnFpInput): string {
  const canon = cmsLenPrefixed([
    CMS_RETURN_FP_VERSION, x.programId, x.returnEventId, x.returnDocumentId, x.originalOrderLineId, x.originalOrderId, x.productId,
    x.baseUnits.toString(), x.refundUnits.toString(), x.recordedAtMicros.toString(),
  ])
  return createHash('sha256').update(canon, 'utf8').digest('hex')
}
