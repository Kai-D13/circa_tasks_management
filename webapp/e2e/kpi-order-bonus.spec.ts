import { test, expect } from '@playwright/test'
import { orderBonusView, orderBonusExportLabel } from '../lib/kpi/orderBonus'

// Mig 112 — contract thuần của khối "Thưởng thêm theo số đơn".
// Điều cần khoá nhất: helper CHỈ đọc 4 field snapshot mà RPC 112 tự tính —
// không nhận actual_value, nên bộ lọc khoảng ngày không thể lật trạng thái.

const CFG = { minimum_order_target: 710, order_bonus_per_staff: 200_000 }

test.describe('orderBonusView (112) @desktop', () => {
  test('campaign KHÔNG áp dụng (thiếu 1 trong 2 cấu hình) → null, mọi màn ẩn khối', () => {
    expect(orderBonusView({})).toBeNull()
    expect(orderBonusView({ minimum_order_target: 710 })).toBeNull()
    expect(orderBonusView({ order_bonus_per_staff: 200_000 })).toBeNull()
    expect(orderBonusView({ minimum_order_target: null, order_bonus_per_staff: null })).toBeNull()
  })

  test('ĐẠT: nhãn mang đúng mức thưởng/dược sĩ, không gợi ý', () => {
    const v = orderBonusView({ ...CFG, bonus_order_count: 720, order_bonus_achieved: true })!
    expect(v.status).toBe('achieved')
    expect(v.tone).toBe('success')
    expect(v.statusLabel).toBe('Đã đạt 200.000₫/dược sĩ')
    expect(v.ordersLine).toBe('720 / 710 đơn')
    expect(v.shortfall).toBe(0)
    expect(v.hint).toBeNull()
  })

  test('BẰNG ĐÚNG ngưỡng: ordersMet = true (>=), shortfall 0', () => {
    const v = orderBonusView({ ...CFG, bonus_order_count: 710, order_bonus_achieved: true })!
    expect(v.ordersMet).toBe(true)
    expect(v.shortfall).toBe(0)
    expect(v.pct).toBe(100)
  })

  test('CHƯA ĐẠT vì thiếu đơn: gợi ý đúng số đơn còn thiếu', () => {
    const v = orderBonusView({ ...CFG, bonus_order_count: 680, order_bonus_achieved: false })!
    expect(v.status).toBe('not_achieved')
    expect(v.tone).toBe('neutral')
    expect(v.statusLabel).toBe('Chưa đạt thưởng thêm')
    expect(v.shortfall).toBe(30)
    expect(v.hint).toBe('Còn thiếu 30 đơn')
  })

  test('CHƯA ĐẠT dù ĐỦ đơn ⇒ suy ra doanh thu là điều kiện đang thiếu (không cần actual_value)', () => {
    const v = orderBonusView({ ...CFG, bonus_order_count: 800, order_bonus_achieved: false })!
    expect(v.ordersMet).toBe(true)
    expect(v.hint).toBe('Đã đủ số đơn — còn cần đạt KPI doanh thu')
  })

  test('CHƯA ĐỦ DỮ LIỆU (RPC ghi NULL vì số đơn Offline bị degrade) — KHÔNG phải "chưa đạt"', () => {
    const v = orderBonusView({ ...CFG, bonus_order_count: null, order_bonus_achieved: null })!
    expect(v.status).toBe('unknown')
    expect(v.tone).toBe('warning')
    expect(v.statusLabel).toBe('Chưa đủ dữ liệu số đơn')
    expect(v.ordersLine).toBe('— / 710 đơn')
    expect(v.shortfall).toBeNull()
    expect(v.pct).toBeNull()
  })

  test('CHƯA ĐỒNG BỘ (vừa nạp lại target, snapshot bị xoá) — khác "chưa đủ dữ liệu"', () => {
    const v = orderBonusView({ ...CFG, synced: false })!
    expect(v.status).toBe('not_synced')
    expect(v.statusLabel).toBe('Chưa đồng bộ')
    expect(v.tone).toBe('neutral')
  })

  test('vượt ngưỡng: % KHÔNG cap ở 100', () => {
    const v = orderBonusView({ ...CFG, bonus_order_count: 1065, order_bonus_achieved: true })!
    expect(v.pct).toBeCloseTo(150, 5)
  })

  test('chữ ký hàm KHÔNG nhận actual_value — bộ lọc khoảng không lật được trạng thái', () => {
    // Truyền thêm field lạ (như code lọc khoảng ghi đè) cũng không đổi kết quả.
    const snap = { ...CFG, bonus_order_count: 720, order_bonus_achieved: true }
    const withRangeNoise = { ...snap, actual_value: 1, offline_order_count: 3 } as Parameters<typeof orderBonusView>[0]
    expect(orderBonusView(withRangeNoise)).toEqual(orderBonusView(snap))
  })

  test('nhãn export: Đạt / Chưa đạt / Chưa đủ dữ liệu / Chưa đồng bộ / rỗng khi không áp dụng', () => {
    expect(orderBonusExportLabel(orderBonusView({ ...CFG, bonus_order_count: 720, order_bonus_achieved: true }))).toBe('Đạt')
    expect(orderBonusExportLabel(orderBonusView({ ...CFG, bonus_order_count: 1, order_bonus_achieved: false }))).toBe('Chưa đạt')
    expect(orderBonusExportLabel(orderBonusView({ ...CFG }))).toBe('Chưa đủ dữ liệu')
    expect(orderBonusExportLabel(orderBonusView({ ...CFG, synced: false }))).toBe('Chưa đồng bộ')
    expect(orderBonusExportLabel(orderBonusView({}))).toBe('')
  })
})
