import { test, expect } from '@playwright/test'
import { resultTableColumns, resultTableDesktopMinPx, RESULT_COL_PX } from '../lib/kpi/resultTableLayout'

// r1.6 (P1 UI responsive 29/07) — unit gate WIDTH CONTRACT bảng Kết quả
// campaign (Super + SM dùng chung): cột có min-width cố định (không đổi theo
// dữ liệu), N cột Bậc động không hardcode 3, mobile giữ cột gộp cũ, khoảng px
// đúng audit. Hành vi scroll/sticky là CSS (QA browser theo acceptance:
// 1366/1440/1920 @100%, light/dark, 1/3/5 tiers).

test.describe('kpi result table layout contract @desktop', () => {
  test('cột ĐỘNG theo maxTierCount: 1/3/5 bậc → đúng số cột desktop, không hardcode 3', () => {
    for (const n of [1, 3, 5]) {
      const cols = resultTableColumns(n, false)
      expect(cols.filter((c) => c.scope === 'desktop')).toHaveLength(n)
      expect(cols.filter((c) => c.scope === 'desktop').map((c) => c.label)).toEqual(
        Array.from({ length: n }, (_, i) => `Bậc ${i + 1}`),
      )
    }
    expect(resultTableColumns(0, false).filter((c) => c.scope === 'desktop')).toHaveLength(0)
  })

  test('mobile GIỮ UI cũ: đúng 1 cột gộp "Bậc đạt · Commission" scope mobile, mọi cấu hình', () => {
    for (const n of [1, 3, 5]) {
      const mob = resultTableColumns(n, true).filter((c) => c.scope === 'mobile')
      expect(mob).toHaveLength(1)
      expect(mob[0].label).toBe('Bậc đạt · Commission')
    }
  })

  test('breakdown (hybrid Offline+Affiliate) thêm ĐÚNG 2 cột GMV, thứ tự ngay sau Actual GMV', () => {
    const without = resultTableColumns(3, false)
    const withBd = resultTableColumns(3, true)
    expect(withBd).toHaveLength(without.length + 2)
    const idx = withBd.findIndex((c) => c.key === 'actual')
    expect(withBd[idx + 1].key).toBe('offline')
    expect(withBd[idx + 2].key).toBe('affiliate')
  })

  test('width contract trong KHOẢNG audit: store 160–180 · group 90–110 · money 130–150 · %/nhịp độ 100–120 · trung bình/ngày 140 · bậc 170–190', () => {
    expect(RESULT_COL_PX.store).toBeGreaterThanOrEqual(160)
    expect(RESULT_COL_PX.store).toBeLessThanOrEqual(180)
    expect(RESULT_COL_PX.group).toBeGreaterThanOrEqual(90)
    expect(RESULT_COL_PX.group).toBeLessThanOrEqual(110)
    expect(RESULT_COL_PX.money).toBeGreaterThanOrEqual(130)
    expect(RESULT_COL_PX.money).toBeLessThanOrEqual(150)
    expect(RESULT_COL_PX.pct).toBeGreaterThanOrEqual(100)
    expect(RESULT_COL_PX.pct).toBeLessThanOrEqual(120)
    expect(RESULT_COL_PX.pace).toBeGreaterThanOrEqual(100)
    expect(RESULT_COL_PX.pace).toBeLessThanOrEqual(120)
    expect(RESULT_COL_PX.perDay).toBe(140)   // 10/08: 'Trung bình/ngày' thay 'Còn thiếu'
    expect(RESULT_COL_PX.tier).toBeGreaterThanOrEqual(170)
    expect(RESULT_COL_PX.tier).toBeLessThanOrEqual(190)
    // Mọi cột đều có min-width dương (browser không còn tự co theo dữ liệu)
    expect(resultTableColumns(5, true).every((c) => c.minPx > 0)).toBe(true)
  })

  test('desktopMinPx = tổng đúng công thức cột; mỗi bậc thêm +176px — 1366@100% dùng scroll TRONG bảng (sticky store), không cắt dữ liệu', () => {
    // Công thức: store + group + 2×money (KPI/Actual) + (breakdown? 2×money)
    // + pct + pace + perDay + n×tier
    const fixed = RESULT_COL_PX.store + RESULT_COL_PX.group + 2 * RESULT_COL_PX.money
      + RESULT_COL_PX.pct + RESULT_COL_PX.pace + RESULT_COL_PX.perDay
    expect(resultTableDesktopMinPx(3, false)).toBe(fixed + 3 * RESULT_COL_PX.tier)   // 1438
    expect(resultTableDesktopMinPx(5, true)).toBe(fixed + 2 * RESULT_COL_PX.money + 5 * RESULT_COL_PX.tier)
    expect(resultTableDesktopMinPx(4, false) - resultTableDesktopMinPx(3, false)).toBe(RESULT_COL_PX.tier)
    // ≥3 bậc luôn vượt 1366 → contract là SCROLL NỘI BỘ + sticky cột Cửa hàng
    // (acceptance: cột cuối truy cập được bằng table scroll, store luôn thấy)
    expect(resultTableDesktopMinPx(3, false)).toBeGreaterThan(1366 - 313) // 313px = sidebar
  })

  // ── Mig 103 ──
  test('GMV label BẤT BIẾN (không truyền metricType / truyền gmv): mảng label y hệt trước 103', () => {
    for (const cols of [resultTableColumns(2, true), resultTableColumns(2, true, 'gmv')]) {
      expect(cols.map((c) => c.label)).toEqual([
        'Cửa hàng', 'Phân loại', 'KPI target', 'Actual GMV', 'GMV Offline', 'GMV Affiliate',
        '%', 'Nhịp độ', 'Trung bình/ngày', 'Bậc đạt · Commission', 'Bậc 1', 'Bậc 2',
      ])
    }
  })

  test('customer: DUY NHẤT label actual đổi thành "Số khách"; width contract giữ nguyên', () => {
    const gmv = resultTableColumns(2, false)
    const cust = resultTableColumns(2, false, 'affiliate_customer_count')
    expect(cust.map((c) => c.label)).toEqual(gmv.map((c) => c.label === 'Actual GMV' ? 'Số khách' : c.label))
    expect(cust.map((c) => c.minPx)).toEqual(gmv.map((c) => c.minPx))
    expect(cust.map((c) => c.key)).toEqual(gmv.map((c) => c.key))
  })

  // ── Mig 106 r1.1: Chất lượng bán hàng — bảng GỌN, không cột trùng số ──────
  test('order_aov: bỏ KPI target / % / Trung bình-ngày, thêm 2 cột Order·AOV + Trạng thái', () => {
    const keys = resultTableColumns(3, false, 'offline_order_aov').map((c) => c.key)
    expect(keys).toEqual([
      'store', 'group', 'actual', 'orderAov', 'quality', 'pace',
      'tierCombined', 'tier-1', 'tier-2', 'tier-3',
    ])
    const cols = resultTableColumns(3, false, 'offline_order_aov')
    expect(cols.find((c) => c.key === 'actual')!.label).toBe('Hoàn thành')
    expect(cols.find((c) => c.key === 'orderAov')!.scope).toBe('all')
    // KHÔNG có cột GMV Offline/Affiliate (loại này không bật affiliate)
    expect(keys).not.toContain('affiliate')
    // 'KPI target' luôn = 100% ⇒ bỏ; '%' trùng chính cột Hoàn thành ⇒ bỏ;
    // 'Trung bình/ngày' (điểm %/ngày) không có nghĩa nghiệp vụ ⇒ bỏ.
    for (const dead of ['kpiTarget', 'pct', 'perDay']) expect(keys).not.toContain(dead)
  })

  test('GMV/khách: mảng cột GIỮ NGUYÊN (zero-touch khi thêm loại mới)', () => {
    expect(resultTableColumns(2, false, 'gmv').map((c) => c.label))
      .toEqual(resultTableColumns(2, false).map((c) => c.label))
    expect(resultTableColumns(2, false, 'gmv').map((c) => c.key)).toEqual([
      'store', 'group', 'kpiTarget', 'actual', 'pct', 'pace', 'perDay',
      'tierCombined', 'tier-1', 'tier-2',
    ])
  })

  test('desktopMinPx PHẢI theo metricType (bảng order_aov hẹp hơn nhờ bỏ 3 cột)', () => {
    const aov = resultTableDesktopMinPx(3, false, 'offline_order_aov')
    const gmv = resultTableDesktopMinPx(3, false)
    // +orderAov +quality −kpiTarget −pct −perDay
    expect(aov - gmv).toBe(
      RESULT_COL_PX.orderAov + RESULT_COL_PX.quality
      - RESULT_COL_PX.money - RESULT_COL_PX.pct - RESULT_COL_PX.perDay,
    )
    expect(aov).toBeLessThan(gmv)
  })
})
