import { test, expect } from '@playwright/test'
import {
  SOURCE_COLUMNS, RETIRED_SOURCE_COLUMNS,
  parseSourceNumber, roundRevenue, snapRevenue, REVENUE_SNAP_EPSILON,
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
    expect(roundRevenue(260000.00000000003)).toBe(260000)
    expect(roundRevenue(2.5)).toBe(3)
    expect(roundRevenue(-2.5)).toBe(-3)   // BigQuery ROUND(-2.5) = -3, KHÔNG phải -2
    expect(roundRevenue(-250000.4)).toBe(-250000)
    expect(roundRevenue(0)).toBe(0)
  })

  // ── 112.4: SNAP thay cho phân bổ phần dư (audit P1#1) ─────────────────────
  // Đo trên toàn bộ view 04/09: lệch tối đa 9,3e-10đ / 7.139 dòng DAY, grain
  // MONTH+WEEK lệch đúng 0 ⇒ nguồn KHÔNG có phần lẻ VND thật.
  test('nhiễu FLOAT64 → về đúng số nguyên (giá trị THẬT lấy từ view)', () => {
    expect(snapRevenue(310999.99999999994)).toBe(311000)   // POS0069 01/09, quan sát thật
    expect(snapRevenue(260000.00000000003)).toBe(260000)
    expect(snapRevenue(156599.99999999997)).toBe(156600)
  })

  test('giá trị đã nguyên → giữ nguyên; 0 và số ÂM đều hợp lệ', () => {
    for (const v of [0, 13406148, -250000, 1]) expect(snapRevenue(v)).toBe(v)
  })

  test('phần lẻ VND THẬT → undefined để caller fail-closed (KHÔNG tự làm tròn tiền)', () => {
    // Chính ca 0,4 + 0,4 của audit: nguồn như vậy nghĩa là BI đã đổi contract.
    for (const v of [0.4, -0.4, 2.5, 0.5, -250000.4, 1000.001]) {
      expect(snapRevenue(v), `phải từ chối phần lẻ thật: ${v}`).toBeUndefined()
    }
    for (const v of [NaN, Infinity, -Infinity]) expect(snapRevenue(v)).toBeUndefined()
  })

  test('tolerance: trong ngưỡng thì snap, ngoài ngưỡng thì từ chối', () => {
    expect(REVENUE_SNAP_EPSILON).toBe(1e-6)
    expect(snapRevenue(100000 + 5e-7)).toBe(100000)      // trong ngưỡng
    expect(snapRevenue(100000 + 1e-5)).toBeUndefined()   // ngoài ngưỡng
  })

  // ⚠ Đây là bài toán audit P1#1 nêu: bản 112.3 làm tròn TỔNG rồi dồn phần dư
  // vào ngày cuối ⇒ tổng cả kỳ đúng nhưng MỌI khoảng con lệch. Snap từng ngày
  // thì tổng của mọi khoảng con đều bằng ROUND(SUM(raw)) của chính khoảng đó.
  test('BẤT BIẾN khoảng con: SUM(daily đã snap) == ROUND(SUM(raw)) cho MỌI [i..j]', () => {
    const raw = [
      13406148.000000002, 0, -250000, 260000.00000000003,
      156599.99999999997, 311000, 847167, 29501209.999999996,
    ]
    const snapped = raw.map((v) => snapRevenue(v))
    expect(snapped.every((v) => v !== undefined && Number.isInteger(v))).toBe(true)
    const nums = snapped as number[]

    for (let i = 0; i < raw.length; i++) {
      for (let j = i; j < raw.length; j++) {
        const daily = nums.slice(i, j + 1).reduce((x, y) => x + y, 0)
        const expected = roundRevenue(raw.slice(i, j + 1).reduce((a, b) => a + b, 0))
        expect(daily, `khoảng con [${i}..${j}] phải khớp ROUND(SUM(raw))`).toBe(expected)
      }
    }
  })
})
