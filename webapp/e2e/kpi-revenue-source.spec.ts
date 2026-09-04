import { test, expect } from '@playwright/test'
import {
  SOURCE_COLUMNS, RETIRED_SOURCE_COLUMNS,
  parseSourceNumber, roundRevenue, allocateRoundedDaily,
} from '@/lib/kpi/revenueSource'

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT NGUỒN BQ TÁCH OFFLINE/AFFILIATE (112.1, siết ở 112.3) — thuần.
//
// Điều đắt nhất phải khoá: null KHÔNG được biến thành 0. Cả sự cố 05/08→04/09
// (landing đứng im) lẫn rủi ro lớn nhất của lần cutover này đều nằm ở chỗ một
// ô thiếu dữ liệu bị đọc thành "0đ" trên màn tiền.
//
// Mọi hàm ở đây đều CÓ caller production (offlineSource) — không giữ helper
// chỉ để test gọi, vì đó là cách contract xanh trong khi production drift.
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
    // Float artifact có thật trong nguồn: 260000.00000000003.
    expect(roundRevenue(260000.00000000003)).toBe(260000)
    expect(roundRevenue(2.5)).toBe(3)
    expect(roundRevenue(-2.5)).toBe(-3)   // BigQuery ROUND(-2.5) = -3, KHÔNG phải -2
    expect(roundRevenue(-250000.4)).toBe(-250000)
    expect(roundRevenue(0)).toBe(0)
  })

  // ── Làm tròn theo TOÀN KHOẢNG (contract 04/09 điểm 3) ─────────────────────
  const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0)

  test('0,4 + 0,4: tổng phải là 1đ — làm tròn từng ngày rồi cộng sẽ ra 0đ', () => {
    const out = allocateRoundedDaily(new Map([['2026-08-01', 0.4], ['2026-08-02', 0.4]]))
    expect(sum(out), 'tổng phải bằng ROUND(SUM(cả khoảng))').toBe(1)
    // Phần dư dồn vào NGÀY CUỐI — xác định, không rải ngẫu nhiên.
    expect(out.get('2026-08-01')).toBe(0)
    expect(out.get('2026-08-02')).toBe(1)
  })

  test('số ÂM: cùng quy tắc, không FLOOR', () => {
    const out = allocateRoundedDaily(new Map([['2026-08-01', -0.4], ['2026-08-02', -0.4]]))
    expect(sum(out)).toBe(-1)
    expect(out.get('2026-08-02')).toBe(-1)
  })

  test('mọi ngày đã nguyên → không đụng gì; tổng vẫn khớp', () => {
    const raw = new Map([['2026-08-01', 13406148], ['2026-08-02', 0], ['2026-08-03', -250000]])
    const out = allocateRoundedDaily(raw)
    expect([...out.entries()]).toEqual([...raw.entries()])
    expect(sum(out)).toBe(roundRevenue(13406148 + 0 - 250000))
  })

  test('nhiễu FLOAT64 nhiều ngày vẫn cho tổng đúng và daily nguyên', () => {
    const raw = new Map([
      ['2026-08-01', 260000.00000000003],
      ['2026-08-02', 156599.99999999997],
      ['2026-08-03', 0.5],
    ])
    const out = allocateRoundedDaily(raw)
    for (const [d, v] of out) expect(Number.isInteger(v), `${d} phải là số nguyên`).toBe(true)
    expect(sum(out)).toBe(roundRevenue(260000.00000000003 + 156599.99999999997 + 0.5))
  })

  test('ngày không sắp xếp sẵn: "ngày cuối" vẫn theo thứ tự ngày, không theo thứ tự insert', () => {
    const out = allocateRoundedDaily(new Map([['2026-08-03', 0.4], ['2026-08-01', 0.4]]))
    expect(out.get('2026-08-03'), 'phần dư phải rơi vào ngày lớn nhất').toBe(1)
    expect(out.get('2026-08-01')).toBe(0)
  })

  test('map rỗng → map rỗng (không tự sinh ngày)', () => {
    expect(allocateRoundedDaily(new Map()).size).toBe(0)
  })
})
