import { test, expect } from '@playwright/test'
import { dedupeByOrderId, isCountedStatus, normalizeStatus, validateSourceOrder } from '../lib/affiliate/normalize'

// Unit gate F2 (chạy không cần browser/server — logic thuần). Case theo QA
// checklist stakeholder 22/07: status normalization, BSON number/date,
// duplicate IDs, unknown status, invalid price. total_price ÂM hợp lệ
// (user chốt 22/07 — giữ để phát hiện QA thực tế).

const base = {
  order_id: 23261,
  order_code: 'DH023261',
  pos_order_code: 'DHC01023742',
  affiliate_partner_code: 'CIRCA-TAMVIET',
  status: 'DELIVERED',
  sale_order_status: 'PROCESSING',
  total_price: 126000,
  total_item: 1,
  first_item: { product_name: 'Kẹo the Play Candy JJW vị dưa hấu (Hũ 22 gram)' },
  customer_name: 'Vũ',
  customer_phone: '0935680630',
  created_time: new Date('2026-07-21T07:32:23.491Z'), // BSON Date qua driver = JS Date
  confirmed_time: '2026-07-21T07:35:04.448Z',          // fixture JSON = chuỗi ISO
  last_updated_time: new Date('2026-07-21T08:40:35.909Z'),
}

test.describe('affiliate normalize @desktop', () => {
  test('doc hợp lệ (BSON Date + ISO string) → row đầy đủ', () => {
    const r = validateSourceOrder(base)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.row.order_id).toBe(23261)
    expect(r.row.partner_code).toBe('CIRCA-TAMVIET')
    expect(r.row.status_norm).toBe('delivered')
    expect(r.row.total_price).toBe(126000)
    expect(r.row.created_time).toBe('2026-07-21T07:32:23.491Z')
    expect(r.row.confirmed_time).toBe('2026-07-21T07:35:04.448Z')
    expect(r.row.first_product_name).toContain('Kẹo the Play')
  })

  test('normalize status: known-set 7 giá trị + lạ → other', () => {
    expect(normalizeStatus('DELIVERED')).toBe('delivered')
    expect(normalizeStatus('DELIVERING')).toBe('delivering')
    expect(normalizeStatus('WAIT_FOR_PAYMENT')).toBe('waiting')
    expect(normalizeStatus('WAIT_FOR_PURCHASE')).toBe('waiting')
    expect(normalizeStatus('PROCESSING')).toBe('processing')
    expect(normalizeStatus('FAIL_TO_DELIVER')).toBe('fail_to_deliver')
    expect(normalizeStatus('CANCELED')).toBe('canceled')
    expect(normalizeStatus('SOME_NEW_STATUS')).toBe('other')
  })

  test('quy tắc đếm: trừ CANCELED; FAIL_TO_DELIVER + status lạ VẪN tính', () => {
    expect(isCountedStatus('CANCELED')).toBe(false)
    expect(isCountedStatus('DELIVERED')).toBe(true)
    expect(isCountedStatus('FAIL_TO_DELIVER')).toBe(true)
    expect(isCountedStatus('SOME_NEW_STATUS')).toBe(true)
  })

  test('reject: thiếu/sai field bắt buộc — không bao giờ ghi 0 âm thầm', () => {
    const bad = (patch: object, reasonPart: string) => {
      const r = validateSourceOrder({ ...base, ...patch })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain(reasonPart)
    }
    bad({ order_id: undefined }, 'order_id')
    bad({ order_id: 'x' }, 'order_id')
    bad({ order_id: 1.5 }, 'order_id')
    bad({ affiliate_partner_code: '' }, 'affiliate_partner_code')
    bad({ affiliate_partner_code: undefined }, 'affiliate_partner_code')
    bad({ status: '' }, 'status')
    bad({ created_time: undefined }, 'created_time')
    bad({ created_time: 'not-a-date' }, 'created_time')
    bad({ total_price: undefined }, 'total_price')
    bad({ total_price: 'abc' }, 'total_price')
    bad({ total_price: NaN }, 'total_price')
  })

  test('total_price ÂM hợp lệ (user 22/07)', () => {
    const r = validateSourceOrder({ ...base, total_price: -5000 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.row.total_price).toBe(-5000)
  })

  test('field optional hỏng → null, KHÔNG reject', () => {
    const r = validateSourceOrder({
      ...base,
      order_code: undefined,
      confirmed_time: 'garbage',
      total_item: 1.7,
      first_item: null,
      customer_name: '   ',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.row.order_code).toBeNull()
    expect(r.row.confirmed_time).toBeNull()
    expect(r.row.total_item).toBeNull()
    expect(r.row.first_product_name).toBeNull()
    expect(r.row.customer_name).toBeNull()
  })

  test('dedupe theo order_id: giữ bản last_updated_time mới nhất', () => {
    const older = { ...base, total_price: 111, last_updated_time: new Date('2026-07-20T00:00:00Z') }
    const newer = { ...base, total_price: 222, last_updated_time: new Date('2026-07-21T00:00:00Z') }
    const other = { ...base, order_id: 99999 }
    const { unique, duplicates } = dedupeByOrderId([older, newer, other])
    expect(duplicates).toBe(1)
    expect(unique.length).toBe(2)
    const kept = unique.find((d) => d.order_id === 23261)
    expect(kept?.total_price).toBe(222)
    // thứ tự đảo — bản mới đứng trước vẫn phải thắng
    const r2 = dedupeByOrderId([newer, older, other])
    expect(r2.unique.find((d) => d.order_id === 23261)?.total_price).toBe(222)
  })
})
