// CMS — ProductID canonical (DECISIONS H4; SPEC §1.3, §4.2): ProductID =
// item.product_id POS, số nguyên dương (INT64). Canonical = text số nguyên đã
// chuẩn hóa (bỏ số 0 đầu bằng BigInt, không qua float), so sánh chính xác.
// Không nhận sku_code / product_code, phân số, số mũ, ô mất độ chính xác.

const INT64_MAX = BigInt('9223372036854775807')
const DIGITS_RE = /^[0-9]+$/

export type CmsProductIdError = 'EMPTY' | 'NOT_INTEGER' | 'UNSAFE_NUMBER' | 'OUT_OF_RANGE'
export type CmsProductIdResult = { ok: true; id: string } | { ok: false; error: CmsProductIdError }

export function canonicalProductId(input: unknown): CmsProductIdResult {
  if (input === null || input === undefined) return { ok: false, error: 'EMPTY' }
  let n: bigint
  if (typeof input === 'number') {
    // Ô numeric Excel / số JSON: chỉ nhận số nguyên an toàn (≤ 2^53 − 1).
    if (!Number.isFinite(input) || !Number.isInteger(input)) return { ok: false, error: 'NOT_INTEGER' }
    if (!Number.isSafeInteger(input)) return { ok: false, error: 'UNSAFE_NUMBER' }
    n = BigInt(input)
  } else if (typeof input === 'bigint') {
    n = input
  } else if (typeof input === 'string') {
    const s = input.trim()
    if (s === '') return { ok: false, error: 'EMPTY' }
    if (!DIGITS_RE.test(s)) return { ok: false, error: 'NOT_INTEGER' }
    // Bỏ số 0 đầu rồi chặn độ dài TRƯỚC BigInt (INT64 tối đa 19 chữ số) — tránh chuỗi số rất dài.
    const digits = s.replace(/^0+(?=[0-9])/, '')
    if (digits.length > 19) return { ok: false, error: 'OUT_OF_RANGE' }
    n = BigInt(digits)
  } else {
    return { ok: false, error: 'NOT_INTEGER' }
  }
  if (n <= BigInt(0) || n > INT64_MAX) return { ok: false, error: 'OUT_OF_RANGE' }
  return { ok: true, id: n.toString() }
}
