import { test, expect } from '@playwright/test'
import { CMS_DEC_FACTOR } from '../lib/cms/decimal'
import { normalizeSalesRow } from '../lib/cms/source/contract'
import { CMS_RETURN_FP_VERSION, CMS_SRC_MAX, cmsCaptureSrc, cmsLenPrefixed, cmsReturnFinancialFp, cmsSrcClean } from '../lib/cms/calc/fp'

// CMS-CALC-RET-2 (thiết kế Dev r2 §4.1 / §6.1) — helper thuần dùng chung với SQL 130: financial_fp canonical sha256 và capture /
// làm sạch chuỗi thô q / u. Vector sha256 tính ĐỘC LẬP bằng `printf … | sha256sum` (không qua code app). Không DB / mạng.

const P = '11111111-1111-1111-1111-111111111111'
const base = {
  programId: P, returnEventId: 'RT1', returnDocumentId: 'D1', originalOrderLineId: '9001', originalOrderId: 'O1', productId: '2004764',
  baseUnits: BigInt(6) * CMS_DEC_FACTOR, refundUnits: BigInt(53500) * CMS_DEC_FACTOR, recordedAtMicros: BigInt('1763000000000000'),
}

test.describe('CMS-CALC-RET-2 r2 · financial_fp / capture thô @desktop', () => {
  test('financial_fp: vector độc lập (sha256sum) ASCII và ngoài BMP; tiền tố độ dài theo BYTE UTF-8', () => {
    expect(CMS_RETURN_FP_VERSION).toBe('cms-return-fp-v1')
    expect(cmsReturnFinancialFp(base)).toBe('a7de0c1a1b3a63ff9d20aa1205c7f4546fe4c40046974038a414015d3d1469e1')
    expect(cmsReturnFinancialFp({ ...base, returnEventId: '\u{1F600}ä' })).toBe('0a9f1e30bdf0259fdc447308a309d2c03904ebe3351064d305c297d486c8a057')
    expect(cmsLenPrefixed(['\u{1F600}ä', ''])).toBe('6:\u{1F600}ä0:')
  })

  test('financial_fp: không mơ hồ khi dời ranh giới trường; mỗi trường tài chính / lineage đổi ⇒ fp đổi', () => {
    const a = cmsReturnFinancialFp({ ...base, returnEventId: 'RT1', returnDocumentId: 'D1' })
    const b = cmsReturnFinancialFp({ ...base, returnEventId: 'RT', returnDocumentId: '1D1' })
    expect(a).not.toBe(b)
    const fields: Partial<typeof base>[] = [
      { programId: '22222222-2222-2222-2222-222222222222' }, { returnEventId: 'RT2' }, { returnDocumentId: 'D2' }, { originalOrderLineId: '9002' },
      { originalOrderId: 'O2' }, { productId: '2004765' }, { baseUnits: base.baseUnits + BigInt(1) }, { refundUnits: base.refundUnits - BigInt(1) },
      { recordedAtMicros: base.recordedAtMicros + BigInt(1) },
    ]
    const seen = new Set([a])
    for (const f of fields) {
      const h = cmsReturnFinancialFp({ ...base, ...f })
      expect(seen.has(h), JSON.stringify(f, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(false)
      seen.add(h)
    }
    expect(cmsReturnFinancialFp({ ...base })).toBe(a)
  })

  test('capture thô: NULL giữ NULL; NUL ⇒ cờ NUL; > 64 code point ⇒ OVERSIZE; giữ nguyên khoảng trắng / điều khiển / vô hình', () => {
    expect(CMS_SRC_MAX).toBe(64)
    expect(cmsCaptureSrc(null)).toEqual({ src: null, flag: null })
    expect(cmsCaptureSrc(undefined)).toEqual({ src: null, flag: null })
    expect(cmsCaptureSrc('h\u0000p')).toEqual({ src: null, flag: 'NUL' })
    for (const v of [' hộp ', 'hộp​', '﻿hộp', '2\t', '']) expect(cmsCaptureSrc(v)).toEqual({ src: v, flag: null })
    expect(cmsCaptureSrc('\u{1F600}'.repeat(64))).toEqual({ src: '\u{1F600}'.repeat(64), flag: null }) // 64 code point = 128 code unit
    expect(cmsCaptureSrc('a'.repeat(65))).toEqual({ src: null, flag: 'OVERSIZE' })
  })

  test('làm sạch = đúng text() của lớp nguồn (contract.ts) trên mọi ký tự trắng / điều khiển; tập trim cố định cho SQL', () => {
    const viaSource = (v: string | null) => {
      const r = normalizeSalesRow({
        order_line_id: 'x', order_id: 'o', order_code: 'c', product_id: '1', seller_email: null, pos_code: null, order_type: 'OFFLINE',
        order_status: 'COMPLETED', completed_at: '2026-12-01T00:00:00Z', quantity_raw: v, uom_raw: null, base_quantity: '1', gmv_amount: '1',
        source_updated_at: '2026-12-01T00:00:00Z',
      })
      if (!r.ok) throw new Error(JSON.stringify(r.issues))
      return r.value.quantityRaw
    }
    // Mọi code point trắng / điều khiển / định dạng đáng ngờ quanh "2": parity tuyệt đối với lớp nguồn hiện hành.
    const cps = [0x01, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1f, 0x20, 0x7f, 0x85, 0x9f, 0xa0, 0x1680, 0x180e, 0x2000, 0x2005, 0x200a, 0x200b,
      0x2028, 0x2029, 0x202f, 0x205f, 0x2060, 0x3000, 0xfeff]
    const trimmed: number[] = []
    for (const cp of cps) {
      const ch = String.fromCodePoint(cp)
      for (const v of [`${ch}2${ch}`, `2${ch}2`, ch]) expect(cmsSrcClean(v), cp.toString(16)).toBe(viaSource(v))
      if (cmsSrcClean(`${ch}2`) === '2') trimmed.push(cp)
    }
    // Tập SQL `cms__src_clean` phải bỏ đúng các code point này ở hai đầu (sau khi điều khiển → space); U+180E / 200B / 2060 KHÔNG bị cắt.
    expect(trimmed.map((c) => c.toString(16))).toEqual(['1', '9', 'a', 'b', 'c', 'd', '1f', '20', '7f', '85', '9f', 'a0', '1680', '2000', '2005', '200a',
      '2028', '2029', '202f', '205f', '3000', 'feff'])
    expect(cmsSrcClean(null)).toBeNull()
    expect(cmsSrcClean('  ')).toBeNull()
  })
})
