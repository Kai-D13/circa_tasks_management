import { test, expect } from '@playwright/test'
import {
  ORDERS_PAGE_SIZE, nextCursorFrom, drilldownEnabled, reconcileState,
  validOrdersRange, groupMappingsByStore,
} from '../lib/affiliate/orders'

// Drill-down đơn Affiliate (contract 28/07) — unit gate cho contract thuần:
// keyset cursor, điều kiện mở chevron (fail-closed theo health), đối soát
// parent-child chính xác (kể cả đơn âm — rule LOCK).

const row = (i: number, time: string) => ({ id: `id-${i}`, completed_time: time })

test.describe('affiliate orders drill-down contract @desktop', () => {
  test('nextCursorFrom: trang ĐẦY (== pageSize) → cursor = row cuối; trang vơi/rỗng → null (hết dữ liệu)', () => {
    const full = Array.from({ length: ORDERS_PAGE_SIZE }, (_, i) => row(i, `2026-07-${String(28 - (i % 27)).padStart(2, '0')}T10:00:00Z`))
    const c = nextCursorFrom(full, ORDERS_PAGE_SIZE)
    expect(c).toEqual({ completedTime: full[full.length - 1].completed_time, id: full[full.length - 1].id })
    expect(nextCursorFrom(full.slice(0, 49), ORDERS_PAGE_SIZE)).toBeNull()
    expect(nextCursorFrom([], ORDERS_PAGE_SIZE)).toBeNull()
  })

  test('drilldownEnabled FAIL-CLOSED: nguồn !ready (blocked) → KHÔNG mở dù có đơn; 0 đơn → không mở; đủ điều kiện → mở', () => {
    expect(drilldownEnabled({ blocked: true, orders: 12 })).toBe(false)   // health gate khóa cùng parent
    expect(drilldownEnabled({ blocked: false, orders: 0 })).toBe(false)
    expect(drilldownEnabled({ blocked: false, orders: 1 })).toBe(true)
  })

  test('reconcileState: chưa tải hết → loading (không phán khớp/lệch từ dữ liệu thiếu)', () => {
    expect(reconcileState({ loadedAll: false, loadedCount: 50, loadedSum: 1_000_000, expectedOrders: 120, expectedGmv: 3_000_000 }))
      .toBe('loading')
  })

  test('reconcileState: tải hết + count và GMV khớp (gồm đơn ÂM trong tổng) → match', () => {
    // 3 đơn: 500k + 300k + (-50k) = 750k — đơn âm giữ nguyên theo rule LOCK
    expect(reconcileState({ loadedAll: true, loadedCount: 3, loadedSum: 750_000, expectedOrders: 3, expectedGmv: 750_000 }))
      .toBe('match')
    // epsilon float qua JSON numeric
    expect(reconcileState({ loadedAll: true, loadedCount: 3, loadedSum: 750_000.001, expectedOrders: 3, expectedGmv: 750_000 }))
      .toBe('match')
  })

  test('reconcileState: lệch count HOẶC lệch GMV → mismatch (fail-visible, không im lặng)', () => {
    expect(reconcileState({ loadedAll: true, loadedCount: 2, loadedSum: 750_000, expectedOrders: 3, expectedGmv: 750_000 }))
      .toBe('mismatch')
    expect(reconcileState({ loadedAll: true, loadedCount: 3, loadedSum: 700_000, expectedOrders: 3, expectedGmv: 750_000 }))
      .toBe('mismatch')
  })

  test('r1 P2#3 validOrdersRange: ngày LỊCH thật (2026-02-31 fail dù đúng regex) · from>to fail · >366 ngày fail · hợp lệ ok', () => {
    expect(validOrdersRange('2026-02-31', '2026-03-01').ok).toBe(false)  // ngày không tồn tại
    expect(validOrdersRange('2026-13-01', '2026-12-31').ok).toBe(false)  // tháng không tồn tại
    expect(validOrdersRange('26-07-01', '2026-07-28').ok).toBe(false)    // sai format
    expect(validOrdersRange('2026-07-28', '2026-07-01').ok).toBe(false)  // đảo ngược
    expect(validOrdersRange('2025-01-01', '2026-07-28').ok).toBe(false)  // >366 ngày
    expect(validOrdersRange('2026-07-01', '2026-07-28')).toEqual({ ok: true })
    expect(validOrdersRange('2026-07-28', '2026-07-28')).toEqual({ ok: true }) // 1 ngày
    expect(validOrdersRange('2025-07-28', '2026-07-28')).toEqual({ ok: true }) // đúng biên 366
  })

  test('r1 P2#4 groupMappingsByStore: 1 store 2 partner code → 1 DÒNG mang đủ codes (hết lặp store/số/key); store khác giữ riêng; FS flag đúng', () => {
    const g = groupMappingsByStore([
      { partner_code: 'CIRCA-A1', partner_type: 'os', store_id: 's1', stores: { name: 'Store 1', code: 'POS0001' } },
      { partner_code: 'CIRCA-A2', partner_type: 'os', store_id: 's1', stores: { name: 'Store 1', code: 'POS0001' } },
      { partner_code: 'CIRCA-B', partner_type: 'fs', store_id: 's2', stores: { name: 'Store FS', code: 'POS0090' } },
    ])
    expect(g).toHaveLength(2)
    const s1 = g.find((x) => x.store_id === 's1')!
    expect(s1.partnerCodes).toEqual(['CIRCA-A1', 'CIRCA-A2'])
    expect(s1.name).toBe('Store 1')
    expect(s1.hasFs).toBe(false)
    expect(g.find((x) => x.store_id === 's2')!.hasFs).toBe(true)
    // Mapping trùng hệt (duplicate row) không nhân đôi code
    const dup = groupMappingsByStore([
      { partner_code: 'CIRCA-A1', partner_type: 'os', store_id: 's1', stores: { name: 'Store 1', code: null } },
      { partner_code: 'CIRCA-A1', partner_type: 'os', store_id: 's1', stores: { name: 'Store 1', code: null } },
    ])
    expect(dup[0].partnerCodes).toEqual(['CIRCA-A1'])
  })
})

// ── FS-expansion (06/08): row model 2 entity + filter Loại ──────────────────
import { buildOverviewEntities, filterEntitiesByType, type OverviewMappingRow } from '../lib/affiliate/orders'

const M = (code: string, type: string, storeId: string | null, name = '', display: string | null = null): OverviewMappingRow => ({
  partner_code: code, partner_type: type, store_id: storeId,
  display_name: display,
  stores: storeId ? { name: name || `Store ${storeId}`, code: `POS-${storeId}` } : null,
})

test.describe('affiliate overview entities (FS-expansion) @desktop', () => {
  test('buildOverviewEntities: OS/FS-có-store group theo STORE; fs store_id NULL → 1 row/partner; display_name trống → fallback partner_code', () => {
    const es = buildOverviewEntities([
      M('CIRCA-A1', 'os', 's1'), M('CIRCA-A2', 'os', 's1'),   // 1 store 2 code
      M('CIRCA-FS', 'fs', 's2'),                               // fs CÓ store
      M('NT-YEN-HUONG', 'fs', null, '', 'Nhà thuốc Yến Hường'),
      M('NT-MOI', 'fs', null, '', ''),                         // display trống
    ])
    expect(es).toHaveLength(4)
    const s1 = es.find((e) => e.kind === 'store' && e.store_id === 's1')
    expect(s1 && s1.kind === 'store' && s1.partnerCodes).toEqual(['CIRCA-A1', 'CIRCA-A2'])
    const p1 = es.find((e) => e.kind === 'partner' && e.partner_code === 'NT-YEN-HUONG')
    expect(p1 && p1.kind === 'partner' && p1.display_name).toBe('Nhà thuốc Yến Hường')
    const p2 = es.find((e) => e.kind === 'partner' && e.partner_code === 'NT-MOI')
    expect(p2 && p2.kind === 'partner' && p2.display_name).toBe('NT-MOI') // fallback chốt 06/08
  })

  test('filterEntitiesByType: os → store thuần OS; fs → partner + store có mapping fs; all → tất cả', () => {
    const es = buildOverviewEntities([
      M('CIRCA-OS', 'os', 's1'),
      M('CIRCA-FS', 'fs', 's2'),
      M('NT-P', 'fs', null),
    ])
    expect(filterEntitiesByType(es, 'all')).toHaveLength(3)
    const os = filterEntitiesByType(es, 'os')
    expect(os).toHaveLength(1)
    expect(os[0].kind === 'store' && os[0].store_id).toBe('s1')
    const fs = filterEntitiesByType(es, 'fs')
    expect(fs.map((e) => (e.kind === 'store' ? e.store_id : e.partner_code)).sort()).toEqual(['NT-P', 's2'])
  })
})
