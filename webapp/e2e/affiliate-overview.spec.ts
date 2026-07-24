import { test, expect } from '@playwright/test'
import {
  reduceAffiliateAgg, currentVnMonthISO, overviewVisibleFor,
  canShowOwnOsGmv, isRealISODate, parseOverviewRange, overviewDataState,
  overviewPageScope,
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

  test('r1.1 HEALTH FAIL-CLOSED overviewDataState: !ready → source-not-ready (KHÔNG aggregate, không số 0 giả); ready+lỗi → aggregate-error; ready+sạch → ok', () => {
    // Health !ready bao trùm MỌI trạng thái chặn (run running/failed · stale
    // >180' · rejected>0 · unmatched/unknown · note · canary completed_time ·
    // lỗi lookup) — evaluate từng trạng thái đã khóa ở affiliate-health.spec
    // (25 test); contract này khóa MAPPING sang hiển thị: page chỉ được
    // aggregate khi 'ok'-đường-dẫn, mọi state khác → '—' + lý do.
    expect(overviewDataState(false, false)).toBe('source-not-ready')
    expect(overviewDataState(false, true)).toBe('source-not-ready')  // nguồn thắng
    expect(overviewDataState(true, true)).toBe('aggregate-error')
    expect(overviewDataState(true, false)).toBe('ok')
  })

  test('rule số âm ĐÃ CHỐT 24/07: đơn DELIVERED total_price < 0 GIẢM GMV nhưng VẪN tính vào số đơn', () => {
    const r = reduceAffiliateAgg([
      { store_id: 's-n', vn_date: '2026-07-01', gmv: 300_000, order_count: 2 },
      { store_id: 's-n', vn_date: '2026-07-02', gmv: -120_000, order_count: 1 }, // đơn âm
    ])
    expect(r.byStore.get('s-n')).toEqual({ gmv: 180_000, orders: 3, lastDate: '2026-07-02' })
    expect(r.totals).toEqual({ gmv: 180_000, orders: 3, storesWithSales: 1 })
  })

  test('r1 P1#1 canShowOwnOsGmv: CHỈ os + active — FS QLCH/SM gán nhầm FS bị chặn trước RPC service-role', () => {
    expect(canShowOwnOsGmv({ store_type: 'os', is_active: true })).toBe(true)
    expect(canShowOwnOsGmv({ store_type: 'fs', is_active: true })).toBe(false)   // FS → chặn
    expect(canShowOwnOsGmv({ store_type: 'os', is_active: false })).toBe(false)  // ngưng hoạt động → chặn
    expect(canShowOwnOsGmv({ store_type: 'external' as string, is_active: true })).toBe(false)
    expect(canShowOwnOsGmv(null)).toBe(false)      // store không tồn tại / query miss
    expect(canShowOwnOsGmv(undefined)).toBe(false)
  })

  test('r1 P2#3 isRealISODate: loại ngày không có thật trên lịch', () => {
    expect(isRealISODate('2026-07-24')).toBe(true)
    expect(isRealISODate('2026-02-31')).toBe(false) // format đúng, lịch sai
    expect(isRealISODate('2026-99-99')).toBe(false)
    expect(isRealISODate('2028-02-29')).toBe(true)  // nhuận
    expect(isRealISODate('2026-02-29')).toBe(false) // không nhuận
    expect(isRealISODate('abc')).toBe(false)
    expect(isRealISODate(undefined)).toBe(false)
  })

  test('r1 P2#3 parseOverviewRange: sai → default tháng; ngược → hoán vị; >366 ngày → clamp; URL rác không phá range', () => {
    // sai/thiếu → default tháng hiện tại
    expect(parseOverviewRange(undefined, undefined, '2026-07-24'))
      .toEqual({ from: '2026-07-01', to: '2026-07-31', clamped: false })
    expect(parseOverviewRange('2026-02-31', '2026-99-99', '2026-07-24'))
      .toEqual({ from: '2026-07-01', to: '2026-07-31', clamped: false })
    // from > to → hoán vị
    expect(parseOverviewRange('2026-07-20', '2026-07-05', '2026-07-24'))
      .toEqual({ from: '2026-07-05', to: '2026-07-20', clamped: false })
    // range hợp lệ giữ nguyên
    expect(parseOverviewRange('2026-06-01', '2026-07-24', '2026-07-24'))
      .toEqual({ from: '2026-06-01', to: '2026-07-24', clamped: false })
    // > 366 ngày → clamp from = to − 365, có cờ clamped
    const r = parseOverviewRange('2020-01-01', '2026-07-24', '2026-07-24')
    expect(r.to).toBe('2026-07-24')
    expect(r.clamped).toBe(true)
    expect(r.from).toBe('2025-07-24') // đúng 366 ngày
  })

  test('P3-I.2 overviewPageScope: super os-fs · admin phòng cấp quyền os-all · sm os-assigned · qlch os-own · staff/admin thường denied · flag off denied TẤT CẢ', () => {
    const base = { flagEnabled: true, isSuper: false, isAffiliateDeptAdmin: false }
    expect(overviewPageScope({ ...base, isSuper: true, role: 'admin' })).toBe('os-fs')
    expect(overviewPageScope({ ...base, isAffiliateDeptAdmin: true, role: 'admin' })).toBe('os-all')
    expect(overviewPageScope({ ...base, role: 'sm' })).toBe('os-assigned')
    expect(overviewPageScope({ ...base, role: 'store_manager' })).toBe('os-own')
    expect(overviewPageScope({ ...base, role: 'staff' })).toBe('denied')          // Staff GIỮ ngoài (user 24/07)
    expect(overviewPageScope({ ...base, role: 'admin' })).toBe('denied')          // admin thường
    // dept-admin flag không cứu role khác admin (membership chỉ có nghĩa với admin)
    expect(overviewPageScope({ ...base, isAffiliateDeptAdmin: true, role: 'staff' })).toBe('denied')
    // FLAG OFF → denied tất cả
    expect(overviewPageScope({ flagEnabled: false, isSuper: true, isAffiliateDeptAdmin: true, role: 'admin' })).toBe('denied')
    expect(overviewPageScope({ flagEnabled: false, isSuper: false, isAffiliateDeptAdmin: false, role: 'sm' })).toBe('denied')
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
