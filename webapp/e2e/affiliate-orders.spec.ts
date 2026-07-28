import { test, expect } from '@playwright/test'
import {
  ORDERS_PAGE_SIZE, nextCursorFrom, drilldownEnabled, reconcileState,
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
})
