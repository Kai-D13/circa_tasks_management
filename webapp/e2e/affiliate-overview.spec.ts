import { test, expect } from '@playwright/test'
import {
  reduceAffiliateAgg, currentVnMonthISO, overviewVisibleFor,
  type AffiliateAggInput,
} from '../lib/affiliate/overview'

// P3-I unit gate — khóa contract Affiliate Overview: reduce per-store/totals,
// cửa sổ tháng VN, và ma trận quyền xem (user chốt 24/07: super full OS+FS ·
// sm/store_manager own-os · staff none · flag off none).

const ROWS: AffiliateAggInput[] = [
  { store_id: 's-a', vn_date: '2026-07-03', gmv: 500_000, order_count: 2 },
  { store_id: 's-a', vn_date: '2026-07-10', gmv: -50_000, order_count: 1 },  // đơn âm GIỮ trong SUM
  { store_id: 's-b', vn_date: '2026-07-05', gmv: 200_000, order_count: 1 },
  { store_id: 's-a', vn_date: '2026-07-07', gmv: 100_000, order_count: 1 },
]

test.describe('affiliate overview contract @desktop', () => {
  test('reduceAffiliateAgg: cộng dồn nhiều ngày/store; lastDate = MAX; âm giữ nguyên; totals đúng', () => {
    const { byStore, totals } = reduceAffiliateAgg(ROWS)
    expect(byStore.get('s-a')).toEqual({ gmv: 550_000, orders: 4, lastDate: '2026-07-10' })
    expect(byStore.get('s-b')).toEqual({ gmv: 200_000, orders: 1, lastDate: '2026-07-05' })
    expect(totals).toEqual({ gmv: 750_000, orders: 5, storesWithSales: 2 })
  })

  test('reduceAffiliateAgg: rỗng → totals 0; store 0 đơn không tính storesWithSales', () => {
    expect(reduceAffiliateAgg([]).totals).toEqual({ gmv: 0, orders: 0, storesWithSales: 0 })
    const r = reduceAffiliateAgg([{ store_id: 's-x', vn_date: '2026-07-01', gmv: 0, order_count: 0 }])
    expect(r.totals.storesWithSales).toBe(0)
  })

  test('currentVnMonthISO: giữa tháng / tháng 2 nhuận / tháng 12', () => {
    expect(currentVnMonthISO('2026-07-24')).toEqual({ from: '2026-07-01', to: '2026-07-31' })
    expect(currentVnMonthISO('2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' }) // 2028 nhuận
    expect(currentVnMonthISO('2026-02-01')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(currentVnMonthISO('2026-12-31')).toEqual({ from: '2026-12-01', to: '2026-12-31' })
  })

  test('overviewVisibleFor: super full · sm/store_manager own-os · staff/admin thường none · flag off none', () => {
    expect(overviewVisibleFor({ isSuper: true, role: 'admin', flagEnabled: true })).toBe('full')
    expect(overviewVisibleFor({ isSuper: false, role: 'sm', flagEnabled: true })).toBe('own-os')
    expect(overviewVisibleFor({ isSuper: false, role: 'store_manager', flagEnabled: true })).toBe('own-os')
    expect(overviewVisibleFor({ isSuper: false, role: 'staff', flagEnabled: true })).toBe('none')
    expect(overviewVisibleFor({ isSuper: false, role: 'admin', flagEnabled: true })).toBe('none')
    expect(overviewVisibleFor({ isSuper: false, role: null, flagEnabled: true })).toBe('none')
    // FLAG OFF → none cho TẤT CẢ (kể cả super)
    expect(overviewVisibleFor({ isSuper: true, role: 'admin', flagEnabled: false })).toBe('none')
    expect(overviewVisibleFor({ isSuper: false, role: 'sm', flagEnabled: false })).toBe('none')
  })
})
