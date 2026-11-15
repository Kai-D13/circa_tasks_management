// CMS-CALC-RET-2 — thứ tự ID / sự kiện của CONTRACT MỚI (`cms-calc-ret2-v1`; PM review P1/P2 r1 13/11 D1). Engine legacy
// (`engine/compute.ts` — `compareCmsLineId` so code unit UTF-16) GIỮ NGUYÊN cho run legacy; module này chỉ phục vụ net.ts và phải
// khớp SQL của migration contract (cùng quy tắc, so text bằng `COLLATE "C"` = byte UTF-8).
//  · SALE–SALE (order_line_id): ID toàn chữ số ASCII đứng trước ID có ký tự khác; hai ID số so theo GIÁ TRỊ (bỏ số 0 đầu → độ dài →
//    chữ số), cùng giá trị thì so cả chuỗi (`007` < `07` < `7`); hai ID text so theo CODE POINT ≡ byte UTF-8 (ngoài BMP vẫn đúng).
//  · RETURN–RETURN (return_event_id): byte UTF-8 thuần, không nhánh số.
//  · Sự kiện: mốc µs → cùng mốc SALE trước RETURN → ID theo nhánh trên.
// Fingerprint / keyset export nguồn vẫn dùng byte thuần — không dùng thứ tự sự kiện này cho chúng.

const DIGITS_RE = /^[0-9]+$/

/**
 * So theo thứ tự BYTE UTF-8 (cùng `bytea` / COLLATE "C" của SQL) — kể cả ký tự ngoài BMP (code unit UTF-16 sắp khác). Thứ tự byte
 * UTF-8 ≡ thứ tự code point, nên so code point (không cần Buffer — dùng được ngoài Node). ID nguồn là chuỗi Unicode hợp lệ (không
 * surrogate lẻ).
 */
export function compareUtf8Bytes(a: string, b: string): number {
  if (a === b) return 0
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i)!
    const cb = b.codePointAt(j)!
    if (ca !== cb) return ca < cb ? -1 : 1
    i += ca > 0xffff ? 2 : 1
    j += cb > 0xffff ? 2 : 1
  }
  return i < a.length ? 1 : j < b.length ? -1 : 0
}

/** Thứ tự order_line_id của contract: số (theo giá trị, tie theo chuỗi) trước text; text theo byte UTF-8. */
export function compareCmsContractLineId(a: string, b: string): number {
  const da = DIGITS_RE.test(a)
  const db = DIGITS_RE.test(b)
  if (da !== db) return da ? -1 : 1
  if (da) {
    const ta = a.replace(/^0+(?=[0-9])/, '')
    const tb = b.replace(/^0+(?=[0-9])/, '')
    if (ta.length !== tb.length) return ta.length < tb.length ? -1 : 1
    if (ta !== tb) return ta < tb ? -1 : 1
  }
  return compareUtf8Bytes(a, b)
}

/** Thứ tự dòng bán của contract: completed_at (µs) rồi order_line_id. */
export function compareCmsContractLines(
  a: { completedAtMicros: bigint; orderLineId: string },
  b: { completedAtMicros: bigint; orderLineId: string },
): number {
  if (a.completedAtMicros !== b.completedAtMicros) return a.completedAtMicros < b.completedAtMicros ? -1 : 1
  return compareCmsContractLineId(a.orderLineId, b.orderLineId)
}

/** Thứ tự sự kiện lịch sử: µs → SALE trước RETURN → ID (SALE: compareCmsContractLineId; RETURN: byte UTF-8). */
export function compareCmsCalcEvents(
  a: { kind: 'SALE' | 'RETURN'; at: bigint; id: string },
  b: { kind: 'SALE' | 'RETURN'; at: bigint; id: string },
): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1
  if (a.kind !== b.kind) return a.kind === 'SALE' ? -1 : 1
  return a.kind === 'SALE' ? compareCmsContractLineId(a.id, b.id) : compareUtf8Bytes(a.id, b.id)
}
