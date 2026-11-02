import { test, expect } from '@playwright/test'
import {
  CMS_DEC_FACTOR, cmsDecimalToInteger, cmsIntegerToDecimal, cmsUnitsFloorDiv, formatCmsDecimal, parseCmsDecimal,
} from '../lib/cms/decimal'
import { canonicalProductId } from '../lib/cms/productId'

// CMS P0-a — unit gate THUẦN (không DB, không mạng, không BigQuery thật).
// Map docs/cms/SPEC.md §1.3 (chuẩn hóa biên), §2 (số học scale 9), DECISIONS H4 (ProductID).

const dec = (s: string) => {
  const r = parseCmsDecimal(s)
  if (!r.ok) throw new Error(`parse ${s}: ${r.error}`)
  return r.units
}

test.describe('CMS P0-a · số thập phân scale 9 @desktop', () => {
  test('đọc chính xác tới 9 chữ số, không float', () => {
    expect(dec('0.000000001')).toBe(BigInt(1))
    expect(dec('24')).toBe(BigInt(24) * CMS_DEC_FACTOR)
    expect(dec(' 1.5 ')).toBe(BigInt(1500000000))
    // 0.1 + 0.2 trong float = 0.30000000000000004; bigint thì đúng tuyệt đối.
    expect(dec('0.1') + dec('0.2')).toBe(dec('0.3'))
    expect(dec('99999999999999999999999999999.999999999')).toBe(BigInt('99999999999999999999999999999999999999'))
  })

  test('lỗi rõ ràng, không cắt / làm tròn / thay bằng 0', () => {
    expect(parseCmsDecimal('1.0000000001')).toEqual({ ok: false, error: 'SCALE' })
    expect(parseCmsDecimal('')).toEqual({ ok: false, error: 'EMPTY' })
    expect(parseCmsDecimal('   ')).toEqual({ ok: false, error: 'EMPTY' })
    for (const bad of ['1,5', '10,000,000', '10.000.000', '1e3', '1E-2', '.5', '5.', 'abc', '1 000', '+1', '0x10']) {
      expect(parseCmsDecimal(bad), bad).toEqual({ ok: false, error: 'FORMAT' })
    }
    expect(parseCmsDecimal('100000000000000000000000000000')).toEqual({ ok: false, error: 'RANGE' })
    expect(parseCmsDecimal('-1')).toEqual({ ok: false, error: 'NEGATIVE' })
    expect(parseCmsDecimal('-1', { allowNegative: true })).toEqual({ ok: true, units: -CMS_DEC_FACTOR })
    expect(parseCmsDecimal('-0')).toEqual({ ok: true, units: BigInt(0) })
  })

  test('0 hợp lệ khác thiếu dữ liệu', () => {
    expect(parseCmsDecimal('0')).toEqual({ ok: true, units: BigInt(0) })
    expect(parseCmsDecimal('0.000')).toEqual({ ok: true, units: BigInt(0) })
    expect(parseCmsDecimal('').ok).toBe(false)
  })

  test('định dạng chuẩn và đổi sang số nguyên VND', () => {
    expect(formatCmsDecimal(BigInt(1500000000))).toBe('1.5')
    expect(formatCmsDecimal(-BigInt(1))).toBe('-0.000000001')
    expect(formatCmsDecimal(BigInt(0))).toBe('0')
    expect(cmsDecimalToInteger(dec('14400'))).toBe(BigInt(14400))
    expect(cmsDecimalToInteger(dec('14400.5'))).toBeNull()
    expect(cmsIntegerToDecimal(BigInt(15000))).toBe(dec('15000'))
  })

  test('Q = floor(max(0, B) / K), cộng dồn rồi mới floor', () => {
    const K = dec('100') // 1 hộp = 100 viên
    expect(cmsUnitsFloorDiv(dec('50'), K)).toBe(BigInt(0))
    expect(cmsUnitsFloorDiv(dec('100'), K)).toBe(BigInt(1))
    expect(cmsUnitsFloorDiv(dec('150'), K)).toBe(BigInt(1))
    // Hai lần nửa hộp = một hộp (cộng cơ sở trước khi floor).
    expect(cmsUnitsFloorDiv(dec('50') + dec('50'), K)).toBe(BigInt(1))
    // Không âm.
    expect(cmsUnitsFloorDiv(-dec('30'), K)).toBe(BigInt(0))
    // K thập phân 9 chữ số: 1 đơn vị CMS = 2.5 ml.
    expect(cmsUnitsFloorDiv(dec('7.499999999'), dec('2.5'))).toBe(BigInt(2))
    expect(cmsUnitsFloorDiv(dec('7.5'), dec('2.5'))).toBe(BigInt(3))
    expect(() => cmsUnitsFloorDiv(dec('1'), BigInt(0))).toThrow(RangeError)
  })
})

test.describe('CMS P0-a · ProductID canonical @desktop', () => {
  test('số nguyên từ số hoặc text chữ số', () => {
    expect(canonicalProductId(12345)).toEqual({ ok: true, id: '12345' })
    expect(canonicalProductId(' 12345 ')).toEqual({ ok: true, id: '12345' })
    expect(canonicalProductId('0012345')).toEqual({ ok: true, id: '12345' })
    expect(canonicalProductId(BigInt(12345))).toEqual({ ok: true, id: '12345' })
    expect(canonicalProductId('9223372036854775807')).toEqual({ ok: true, id: '9223372036854775807' })
  })

  test('từ chối sku/phân số/số mũ/ô mất độ chính xác', () => {
    expect(canonicalProductId('SKU001')).toEqual({ ok: false, error: 'NOT_INTEGER' })
    expect(canonicalProductId('1.5')).toEqual({ ok: false, error: 'NOT_INTEGER' })
    expect(canonicalProductId(1.5)).toEqual({ ok: false, error: 'NOT_INTEGER' })
    expect(canonicalProductId('1.2E+5')).toEqual({ ok: false, error: 'NOT_INTEGER' })
    expect(canonicalProductId(2 ** 53)).toEqual({ ok: false, error: 'UNSAFE_NUMBER' })
    expect(canonicalProductId(Number.NaN)).toEqual({ ok: false, error: 'NOT_INTEGER' })
    expect(canonicalProductId('')).toEqual({ ok: false, error: 'EMPTY' })
    expect(canonicalProductId(null)).toEqual({ ok: false, error: 'EMPTY' })
    expect(canonicalProductId('0')).toEqual({ ok: false, error: 'OUT_OF_RANGE' })
    expect(canonicalProductId('9223372036854775808')).toEqual({ ok: false, error: 'OUT_OF_RANGE' })
    expect(canonicalProductId({})).toEqual({ ok: false, error: 'NOT_INTEGER' })
  })
})
