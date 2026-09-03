import { test, expect } from '@playwright/test'
import {
  SOURCE_COLUMNS, RETIRED_SOURCE_COLUMNS,
  parseSourceNumber, roundRevenue, affiliateDayState, offlineDayState,
} from '@/lib/kpi/revenueSource'

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT NGUỒN BQ TÁCH OFFLINE/AFFILIATE (112.1) — thuần, không chạm mạng.
//
// Điều đắt nhất phải khoá ở đây: null KHÔNG được biến thành 0. Cả sự cố
// 05/08→04/09 (landing đứng im) lẫn rủi ro lớn nhất của lần cutover này đều
// nằm ở chỗ một ô thiếu dữ liệu bị đọc thành "0đ" trên màn tiền.
// ─────────────────────────────────────────────────────────────────────────────

test.describe('contract nguồn doanh thu BQ @desktop', () => {
  test('tên cột mới đúng bộ; identifier cũ được đánh dấu đã khai tử', () => {
    expect(Object.values(SOURCE_COLUMNS)).toEqual([
      'offline_net_revenue', 'offline_no_order', 'affiliate_net_revenue', 'affiliate_no_order',
    ])
    expect([...RETIRED_SOURCE_COLUMNS]).toEqual(['net_revenue', 'no_order'])
  })

  test('parse: chuỗi FLOAT64 của BQ ra số; null GIỮ null; rác ra undefined', () => {
    // BigQuery REST trả mọi giá trị dạng chuỗi, kể cả ký pháp khoa học.
    expect(parseSourceNumber('1.3406148E7')).toBe(13406148)
    expect(parseSourceNumber('116')).toBe(116)
    expect(parseSourceNumber('0')).toBe(0)
    // Doanh thu ÂM là hợp lệ (hoàn/điều chỉnh) — không được coi là rác.
    expect(parseSourceNumber('-250000')).toBe(-250000)
    // null = ô trống thật; KHÁC hẳn "không đọc được".
    expect(parseSourceNumber(null)).toBeNull()
    for (const bad of [undefined, '', 'abc', 'NaN', 'Infinity', '-Infinity', {}]) {
      expect(parseSourceNumber(bad), `giá trị rác phải ra undefined: ${String(bad)}`).toBeUndefined()
    }
  })

  test('làm tròn về đồng: nửa đơn vị ra XA số 0, khớp ROUND() của BigQuery', () => {
    // Float artifact có thật trong nguồn: affiliate_net_revenue 260000.00000000003.
    expect(roundRevenue(260000.00000000003)).toBe(260000)
    expect(roundRevenue(2.5)).toBe(3)
    expect(roundRevenue(-2.5)).toBe(-3)   // BigQuery ROUND(-2.5) = -3, KHÔNG phải -2
    expect(roundRevenue(-250000.4)).toBe(-250000)
    expect(roundRevenue(0)).toBe(0)
  })

  test('Affiliate: cả hai NULL = KHÔNG PHÁT SINH (nghiệp vụ tính 0)', () => {
    expect(affiliateDayState(null, null)).toEqual({ kind: 'none' })
  })

  test('Affiliate: chỉ MỘT field NULL = mâu thuẫn nguồn, fail-closed', () => {
    const a = affiliateDayState('156600', null)
    expect(a.kind, 'có tiền mà không có đơn phải là invalid').toBe('invalid')
    const b = affiliateDayState(null, '2')
    expect(b.kind, 'có đơn mà không có tiền phải là invalid').toBe('invalid')
  })

  test('Affiliate: đủ hai field → dùng bình thường; số đơn phải nguyên >= 0', () => {
    expect(affiliateDayState('408200', '2')).toEqual({ kind: 'value', revenue: 408200, orders: 2 })
    expect(affiliateDayState('0', '0')).toEqual({ kind: 'value', revenue: 0, orders: 0 })
    expect(affiliateDayState('100', '-1').kind).toBe('invalid')
    expect(affiliateDayState('100', '1.5').kind).toBe('invalid')
  })

  test('Offline: NULL là NGUỒN CHƯA HỢP LỆ — không phải 0', () => {
    // Đây là khác biệt cốt lõi với Affiliate: cửa hàng luôn có doanh thu
    // offline (kể cả 0đ), nên NULL = nguồn hỏng ⇒ giữ snapshot cũ.
    const r = offlineDayState(null, '116')
    expect(r.kind).toBe('invalid')
    expect(r.kind === 'invalid' && r.detail).toContain('NULL')
    expect(offlineDayState('13406148', null).kind).toBe('invalid')
  })

  test('Offline: giá trị hợp lệ gồm cả 0đ và số ÂM; số đơn phải nguyên >= 0', () => {
    expect(offlineDayState('13406148', '116')).toEqual({ kind: 'value', revenue: 13406148, orders: 116 })
    expect(offlineDayState('0', '0')).toEqual({ kind: 'value', revenue: 0, orders: 0 })
    expect(offlineDayState('-250000', '3')).toEqual({ kind: 'value', revenue: -250000, orders: 3 })
    expect(offlineDayState('100', '2.5').kind).toBe('invalid')
    expect(offlineDayState('100', '-2').kind).toBe('invalid')
  })

  test('không nhánh nào biến thiếu dữ liệu thành 0', () => {
    // Quét chéo: mọi input "trống/rác" đều KHÔNG được ra revenue = 0.
    for (const bad of [null, undefined, '', 'abc']) {
      const off = offlineDayState(bad, '1')
      expect(off.kind, `offline ${String(bad)} phải invalid`).toBe('invalid')
      const aff = affiliateDayState(bad, '1')
      expect(aff.kind, `affiliate ${String(bad)} (lệch cặp) phải invalid`).toBe('invalid')
    }
  })
})
