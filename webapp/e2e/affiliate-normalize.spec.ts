import { test, expect } from '@playwright/test'
import { dedupeByOrderId, isKpiAffiliateCountedStatus, normalizeStatus, resolveStores, sourceIssueCodes, validateSourceOrder, type PartnerMappingRow } from '../lib/affiliate/normalize'

// Unit gate F2 (chạy không cần browser/server — logic thuần). Case theo QA
// checklist stakeholder 22/07: status normalization, BSON number/date,
// duplicate IDs, unknown status, invalid price. total_price ÂM hợp lệ
// (user chốt 22/07 — giữ để phát hiện QA thực tế).

const base = {
  order_id: 23261,
  order_code: 'DH023261',
  pos_order_code: 'DHC01023742',
  account_id: 1185465, // identity khách (mig 103 — join proof 06/08)
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
  completed_time: new Date('2026-07-21T08:40:35.909Z'), // mốc giao thành công (KPI date basis)
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
    expect(r.row.completed_time).toBe('2026-07-21T08:40:35.909Z')
    expect(r.row.first_product_name).toContain('Kẹo the Play')
    expect(r.row.account_id).toBe(1185465)
  })

  // Mig 103 (metric Số khách): account_id NULLABLE — thiếu/hỏng KHÔNG reject
  // (mirror completed_time); fail-closed ở RPC aggregate customers + canary
  // report cron, KHÔNG ở validate ingestion.
  test('account_id (mig 103): Long duck-type OK; thiếu/unsafe/không dương → null KHÔNG reject', () => {
    const longLike = { toNumber: () => 1185465, toString: () => '1185465', _bsontype: 'Long' }
    const r1 = validateSourceOrder({ ...base, account_id: longLike })
    expect(r1.ok).toBe(true)
    if (r1.ok) expect(r1.row.account_id).toBe(1185465)

    for (const [label, v] of [
      ['thiếu', undefined],
      ['null', null],
      ['unsafe Long', { toNumber: () => 2 ** 53 + 2, toString: () => 'x', _bsontype: 'Long' }],
      ['chuỗi', 'abc'],
      ['số 0', 0],
      ['số âm', -5],
      ['thập phân', 1.5],
    ] as const) {
      const r = validateSourceOrder({ ...base, account_id: v })
      expect(r.ok, `account_id ${label} phải vẫn ok`).toBe(true)
      if (r.ok) expect(r.row.account_id, `account_id ${label} → null`).toBeNull()
    }
    // DELIVERED thiếu account_id: vẫn ingest (canary cron cảnh báo, RPC chặn)
    const rd = validateSourceOrder({ ...base, status: 'DELIVERED', account_id: undefined })
    expect(rd.ok).toBe(true)
    if (rd.ok) expect(rd.row.status_norm).toBe('delivered')
  })

  test('normalize status: known-set 8 giá trị + lạ → other', () => {
    expect(normalizeStatus('DELIVERED')).toBe('delivered')
    expect(normalizeStatus('DELIVERING')).toBe('delivering')
    expect(normalizeStatus('WAIT_FOR_PAYMENT')).toBe('waiting')
    expect(normalizeStatus('WAIT_FOR_PURCHASE')).toBe('waiting')
    // H1.1 (27/07): status mới xuất hiện trong nguồn — chờ giao, không tính GMV
    expect(normalizeStatus('WAIT_TO_DELIVER')).toBe('waiting')
    expect(normalizeStatus('PROCESSING')).toBe('processing')
    expect(normalizeStatus('FAIL_TO_DELIVER')).toBe('fail_to_deliver')
    expect(normalizeStatus('CANCELED')).toBe('canceled')
    expect(normalizeStatus('SOME_NEW_STATUS')).toBe('other')
  })

  test('quy tắc đếm KPI (audit 22/07): CHỈ DELIVERED tính; mọi status khác KHÔNG', () => {
    expect(isKpiAffiliateCountedStatus('DELIVERED')).toBe(true)
    expect(isKpiAffiliateCountedStatus('CANCELED')).toBe(false)
    expect(isKpiAffiliateCountedStatus('FAIL_TO_DELIVER')).toBe(false)
    expect(isKpiAffiliateCountedStatus('DELIVERING')).toBe(false)
    expect(isKpiAffiliateCountedStatus('PROCESSING')).toBe(false)
    expect(isKpiAffiliateCountedStatus('WAIT_FOR_PAYMENT')).toBe(false)
    expect(isKpiAffiliateCountedStatus('WAIT_TO_DELIVER')).toBe(false) // H1.1
    expect(isKpiAffiliateCountedStatus('SOME_NEW_STATUS')).toBe(false)
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
      completed_time: undefined, // đơn chưa giao — không reject, KPI tự loại
      total_item: 1.7,
      first_item: null,
      customer_name: '   ',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.row.order_code).toBeNull()
    expect(r.row.confirmed_time).toBeNull()
    expect(r.row.completed_time).toBeNull()
    expect(r.row.total_item).toBeNull()
    expect(r.row.first_product_name).toBeNull()
    expect(r.row.customer_name).toBeNull()
  })

  test('BSON types (r1): Long/Int32 qua toNumber, Decimal128 qua toString, unsafe Long → reject', () => {
    // promoteLongs:false → Long tới normalize dạng object duck-type
    const longLike = { toNumber: () => 23261, toString: () => '23261', _bsontype: 'Long' }
    const r1 = validateSourceOrder({ ...base, order_id: longLike })
    expect(r1.ok).toBe(true)
    if (r1.ok) expect(r1.row.order_id).toBe(23261)

    const dec = { toString: () => '126000.5', _bsontype: 'Decimal128' }
    const r2 = validateSourceOrder({ ...base, total_price: dec })
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.row.total_price).toBe(126000.5)

    const unsafe = { toNumber: () => 2 ** 53 + 2, toString: () => String(2 ** 53 + 2), _bsontype: 'Long' }
    const r3 = validateSourceOrder({ ...base, order_id: unsafe })
    expect(r3.ok).toBe(false)
    if (!r3.ok) expect(r3.reason).toContain('safe integer')

    const badDec = { toString: () => 'not-a-number', _bsontype: 'Decimal128' }
    const r4 = validateSourceOrder({ ...base, total_price: badDec })
    expect(r4.ok).toBe(false)
  })

  test('resolveStores (FS-expansion 06/08): os/fs-store/fs-partner(NULL)/unmatched/inactive + type sót → unmatched + giá âm', () => {
    const mappings: PartnerMappingRow[] = [
      { partner_code: 'CODE-OS', store_id: 'uuid-os', partner_type: 'os', is_active: true },
      { partner_code: 'CODE-FS', store_id: 'uuid-fs', partner_type: 'fs', is_active: true },
      // FS-partner: mapping fs KHÔNG có store (đối tác ngoài hệ thống store)
      { partner_code: 'CODE-FSP', store_id: null, partner_type: 'fs', is_active: true },
      // external còn SÓT sau 102 = sai cấu hình → unmatched (fail-visible)
      { partner_code: 'CODE-EXT', store_id: null, partner_type: 'external', is_active: true },
      { partner_code: 'CODE-OFF', store_id: 'uuid-off', partner_type: 'os', is_active: false },
    ]
    const mk = (id: number, code: string, price = 1000) => {
      const r = validateSourceOrder({ ...base, order_id: id, affiliate_partner_code: code, total_price: price })
      if (!r.ok) throw new Error('fixture invalid')
      return r.row
    }
    const rows = [
      mk(1, 'CODE-OS'), mk(2, 'CODE-FS'), mk(3, 'CODE-EXT'),
      mk(4, 'CODE-OFF'), mk(5, 'CODE-MOI'), mk(6, 'CODE-OS', -500),
      mk(7, 'CODE-FSP'),
    ]
    const { resolved, report } = resolveStores(rows, mappings)
    expect(report.matched_os).toBe(2)            // #1 + #6
    expect(report.matched_fs).toBe(2)            // #2 (có store) + #7 (fs-partner NULL)
    expect(report.unmatched_codes.sort()).toEqual(['CODE-EXT', 'CODE-MOI']) // type sót + chưa map
    expect(report.inactive_codes).toEqual(['CODE-OFF'])
    expect(report.null_store_orders).toBe(4)     // fs-partner + ext-sót + inactive + unmatched
    expect(report.negative_price_count).toBe(1)
    expect(report.negative_price_sample).toEqual([6])
    expect(resolved.find((r) => r.order_id === 1)?.store_id).toBe('uuid-os')
    expect(resolved.find((r) => r.order_id === 2)?.store_id).toBe('uuid-fs')  // fs có store giữ store
    expect(resolved.find((r) => r.order_id === 7)?.store_id).toBeNull()       // fs-partner giữ NULL
    expect(resolved.find((r) => r.order_id === 4)?.store_id).toBeNull()       // inactive KHÔNG map
    // P3-A r2: unmatched + inactive HỢP NHẤT vào sync_runs.unmatched_codes → health chặn
    expect(sourceIssueCodes(report).sort()).toEqual(['CODE-EXT', 'CODE-MOI', 'CODE-OFF'])
  })

  test('dedupe canonical hóa key (r1.1): Long/number cùng giá trị chung 1 key', () => {
    const longA = { toNumber: () => 23261, toString: () => '23261', _bsontype: 'Long' }
    const longB = { toNumber: () => 23261, toString: () => '23261', _bsontype: 'Long' }
    const older = { ...base, order_id: longA, total_price: 111, last_updated_time: new Date('2026-07-20T00:00:00Z') }
    const newer = { ...base, order_id: longB, total_price: 222, last_updated_time: new Date('2026-07-21T00:00:00Z') }
    // 2 Long object khác reference, cùng ID → PHẢI dedupe (raw-key thì không)
    const r1 = dedupeByOrderId([older, newer])
    expect(r1.duplicates).toBe(1)
    expect(r1.unique.length).toBe(1)
    expect(r1.unique[0].total_price).toBe(222)
    // number + Long cùng ID → PHẢI dedupe
    const numNewer = { ...base, order_id: 23261, total_price: 333, last_updated_time: new Date('2026-07-22T00:00:00Z') }
    const r2 = dedupeByOrderId([older, numNewer])
    expect(r2.duplicates).toBe(1)
    expect(r2.unique.length).toBe(1)
    expect(r2.unique[0].total_price).toBe(333)
  })

  test('dedupe giữ RIÊNG row không có order_id hợp lệ (r1.1) → đếm đủ rejected', () => {
    const bad1 = { ...base, order_id: undefined }
    const bad2 = { ...base, order_id: 'x' }
    const { unique, duplicates } = dedupeByOrderId([bad1, bad2, base])
    expect(duplicates).toBe(0)
    expect(unique.length).toBe(3) // 2 row hỏng KHÔNG bị gom chung 1 key undefined
    const rejected = unique.map((d) => validateSourceOrder(d)).filter((r) => !r.ok)
    expect(rejected.length).toBe(2)
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
