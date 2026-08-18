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

  // ── Mig 103 · nhãn cập nhật 17/08 ──
  // Thuật ngữ đổi GMV → Doanh thu (chốt stakeholder): "GMV" là từ nội bộ của
  // BI. Cấu trúc cột (key/thứ tự/width) KHÔNG đổi — chỉ chữ hiển thị. Tên cột
  // EXCEL vẫn giữ 'Actual GMV' (literal trong exportRows, Power Query bám vào).
  test('nhãn doanh thu (không truyền metricType / truyền gmv): mảng label khớp contract', () => {
    for (const cols of [resultTableColumns(2, true), resultTableColumns(2, true, 'gmv')]) {
      expect(cols.map((c) => c.label)).toEqual([
        'Cửa hàng', 'Phân loại', 'KPI target', 'Doanh thu thực tế',
        'Doanh thu thuần tại cửa hàng', 'Doanh thu Affiliate',
        '%', 'Nhịp độ', 'Trung bình/ngày', 'Bậc đạt · Commission', 'Bậc 1', 'Bậc 2',
      ])
      // không còn chữ GMV trên header bảng
      for (const c of cols) expect(c.label, c.key).not.toContain('GMV')
    }
  })

  test('customer: DUY NHẤT label actual đổi thành "Số khách"; width contract giữ nguyên', () => {
    const gmv = resultTableColumns(2, false)
    const cust = resultTableColumns(2, false, 'affiliate_customer_count')
    expect(cust.map((c) => c.label)).toEqual(gmv.map((c) => c.label === 'Doanh thu thực tế' ? 'Số khách' : c.label))
    expect(cust.map((c) => c.minPx)).toEqual(gmv.map((c) => c.minPx))
    expect(cust.map((c) => c.key)).toEqual(gmv.map((c) => c.key))
  })

  // ── Commit 5 (17/08): Chất lượng bán hàng — HAI chỉ số độc lập ────────────
  test('order_aov: bỏ điểm gộp + Nhịp độ, thay bằng 2 cột Số đơn / AOV', () => {
    const keys = resultTableColumns(3, false, 'offline_order_aov').map((c) => c.key)
    expect(keys).toEqual([
      'store', 'group', 'order', 'aov', 'quality',
      'tierCombined', 'tier-1', 'tier-2', 'tier-3',
    ])
    const cols = resultTableColumns(3, false, 'offline_order_aov')
    expect(cols.find((c) => c.key === 'order')!.label).toBe('Số đơn (thực tế / mục tiêu)')
    expect(cols.find((c) => c.key === 'aov')!.label).toBe('AOV (thực tế / mục tiêu)')
    expect(cols.find((c) => c.key === 'order')!.scope).toBe('all')
    expect(cols.find((c) => c.key === 'aov')!.scope).toBe('all')
    // KHÔNG có cột GMV Offline/Affiliate (loại này không bật affiliate)
    expect(keys).not.toContain('affiliate')
    // Điểm gộp min(order%, aov%) BIẾN MẤT khỏi bảng (vẫn còn trong DB/export):
    // 'actual' = cột điểm, 'orderAov' = cột gộp cũ, 'pace' = run_rate của điểm.
    // 'kpiTarget' luôn 100 ⇒ bỏ; 'pct' trùng điểm ⇒ bỏ; 'perDay' = điểm %/ngày.
    for (const dead of ['actual', 'orderAov', 'pace', 'kpiTarget', 'pct', 'perDay']) {
      expect(keys, `cột '${dead}' phải biến mất khỏi Chất lượng bán hàng`).not.toContain(dead)
    }
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
    // +order +aov +quality −kpiTarget −actual −pct −pace −perDay
    expect(aov - gmv).toBe(
      2 * RESULT_COL_PX.metricPair + RESULT_COL_PX.quality
      - 2 * RESULT_COL_PX.money - RESULT_COL_PX.pct - RESULT_COL_PX.pace - RESULT_COL_PX.perDay,
    )
    expect(aov).toBeLessThan(gmv)
  })
})

// ── 107: cột 'Phân loại' tùy chọn ───────────────────────────────────────────
test.describe('kpi result table — showGroup (107) @desktop', () => {
  test('mặc định GIỮ cột (mọi caller cũ zero-touch)', () => {
    expect(resultTableColumns(2, false).map((c) => c.key)).toContain('group')
    expect(resultTableColumns(2, false, 'gmv', true).map((c) => c.key)).toContain('group')
  })

  test('showGroup=false → cột biến mất khỏi MỌI loại chiến dịch', () => {
    for (const metric of [undefined, 'gmv', 'affiliate_customer_count', 'offline_order_aov']) {
      const keys = resultTableColumns(2, false, metric, false).map((c) => c.key)
      expect(keys, `metric=${metric}`).not.toContain('group')
      // và không kéo theo cột nào khác biến mất
      expect(keys).toContain('store')
    }
  })

  test('ẩn cột giảm ĐÚNG 100px bề rộng desktop, không hơn không kém', () => {
    const withGroup = resultTableDesktopMinPx(3, false, 'gmv', true)
    const without = resultTableDesktopMinPx(3, false, 'gmv', false)
    expect(withGroup - without).toBe(RESULT_COL_PX.group)
    expect(RESULT_COL_PX.group).toBe(100)
  })

  test('thứ tự cột còn lại KHÔNG đổi khi ẩn (chỉ mất đúng một phần tử)', () => {
    const a = resultTableColumns(2, false, 'gmv', true).map((c) => c.key).filter((k) => k !== 'group')
    const b = resultTableColumns(2, false, 'gmv', false).map((c) => c.key)
    expect(b).toEqual(a)
  })
})
