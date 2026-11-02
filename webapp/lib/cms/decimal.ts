// CMS — số thập phân chính xác scale cố định 9 (docs/cms/SPEC.md §1.3, §2).
// Giá trị thực = units / 10^9, units là bigint. Không float, không làm tròn,
// không cắt: chuỗi có > 9 chữ số sau dấu chấm ⇒ lỗi SCALE; phần nguyên vượt
// 29 chữ số (giới hạn NUMERIC BigQuery) ⇒ lỗi RANGE. Hàm thuần, không I/O.

export const CMS_DEC_SCALE = 9
export const CMS_DEC_FACTOR = BigInt(10) ** BigInt(9)
/** Phần nguyên tối đa của BigQuery NUMERIC (precision 38, scale 9). */
export const CMS_DEC_MAX_INT_DIGITS = 29

export type CmsDecError = 'EMPTY' | 'FORMAT' | 'SCALE' | 'RANGE' | 'NEGATIVE'
export type CmsDecResult = { ok: true; units: bigint } | { ok: false; error: CmsDecError }

const DEC_RE = /^(-)?([0-9]+)(?:\.([0-9]+))?$/

/**
 * Đọc chuỗi thập phân dạng `123`, `-4.5`, `0.000000001` (dấu chấm thập phân,
 * không phân cách nghìn, không số mũ). Mặc định không nhận số âm.
 */
export function parseCmsDecimal(input: string, opts: { allowNegative?: boolean } = {}): CmsDecResult {
  const s = input.trim()
  if (s === '') return { ok: false, error: 'EMPTY' }
  const m = DEC_RE.exec(s)
  if (!m) return { ok: false, error: 'FORMAT' }
  const [, minus, intPart, fracPart = ''] = m
  if (fracPart.length > CMS_DEC_SCALE) return { ok: false, error: 'SCALE' }
  const intDigits = intPart.replace(/^0+(?=[0-9])/, '')
  if (intDigits.length > CMS_DEC_MAX_INT_DIGITS) return { ok: false, error: 'RANGE' }
  const units = BigInt(intDigits) * CMS_DEC_FACTOR + BigInt(fracPart.padEnd(CMS_DEC_SCALE, '0'))
  if (minus && units !== BigInt(0)) {
    if (!opts.allowNegative) return { ok: false, error: 'NEGATIVE' }
    return { ok: true, units: -units }
  }
  return { ok: true, units }
}

/**
 * Số JS (ô numeric Excel) ⇒ chuỗi thập phân bằng xử lý chữ số, kể cả khi JS in
 * dạng số mũ (SPEC §4.2: `1e-9` ⇒ `0.000000001`). Dùng biểu diễn ngắn nhất
 * round-trip của JS (`String(n)`), không qua phép nhân/chia float. Không hữu
 * hạn ⇒ null. Precision/scale kiểm SAU bằng parseCmsDecimal.
 */
export function cmsNumberToDecimalString(n: number): string | null {
  if (!Number.isFinite(n)) return null
  const s = String(n)
  const m = /^(-)?([0-9]+)(?:\.([0-9]+))?(?:e([+-][0-9]+))?$/.exec(s)
  if (!m) return null
  const [, minus = '', intPart, fracPart = '', expRaw] = m
  if (expRaw === undefined) return s
  const exp = Number(expRaw)
  const digits = (intPart + fracPart).replace(/^0+(?=[0-9])/, '')
  const point = intPart.replace(/^0+(?=[0-9])/, '').length + exp // vị trí dấu chấm tính từ đầu `digits`
  let out: string
  if (point <= 0) out = `0.${'0'.repeat(-point)}${digits}`
  else if (point >= digits.length) out = digits + '0'.repeat(point - digits.length)
  else out = `${digits.slice(0, point)}.${digits.slice(point)}`
  out = out.includes('.') ? out.replace(/0+$/, '').replace(/\.$/, '') : out
  return minus + out
}

/** Chuỗi chuẩn (bỏ số 0 thừa sau dấu chấm): BigInt(1500000000) ⇒ "1.5". */
export function formatCmsDecimal(units: bigint): string {
  const neg = units < BigInt(0)
  const abs = neg ? -units : units
  const intPart = abs / CMS_DEC_FACTOR
  const frac = (abs % CMS_DEC_FACTOR).toString().padStart(CMS_DEC_SCALE, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${intPart}${frac ? `.${frac}` : ''}`
}

/** Số nguyên VND từ units khi không có phần lẻ; có phần lẻ ⇒ null (không làm tròn). */
export function cmsDecimalToInteger(units: bigint): bigint | null {
  return units % CMS_DEC_FACTOR === BigInt(0) ? units / CMS_DEC_FACTOR : null
}

export function cmsIntegerToDecimal(n: bigint): bigint {
  return n * CMS_DEC_FACTOR
}

/**
 * Q = floor(max(0, B) / K) với B, K cùng scale (docs/plan §2.7). Scale triệt
 * tiêu nên phép chia bigint là chia nguyên chính xác. K phải > 0.
 */
export function cmsUnitsFloorDiv(baseUnits: bigint, perUnit: bigint): bigint {
  if (perUnit <= BigInt(0)) throw new RangeError('CMS: base_quantity_CMS phải > 0')
  if (baseUnits <= BigInt(0)) return BigInt(0)
  return baseUnits / perUnit
}
