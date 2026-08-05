import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { currentWeekStart, weekEndISO } from '../lib/dateUtils'

// BQ-V2 r1 (audit P1#1) — tab Tuần KHÔNG được hiển thị tuần cũ như tuần hiện
// tại khi nguồn chưa có dữ liệu WEEK: currentWeekStart giờ CONTAINMENT-ONLY
// (bỏ fallback "tuần gần nhất ≤ hôm nay"). Không có tuần chứa hôm nay →
// undefined → cả staff card lẫn bảng super rơi vào empty state "Chưa có dữ
// liệu" (fail-visible, không stale trên màn tiền).

test.describe('kpi landing week containment @desktop', () => {
  test('P1#1: chỉ còn tuần THÁNG TRƯỚC (20/07 gộp đến 31/07) → 04/08 trả undefined — KHÔNG fallback tuần cũ', () => {
    // Rule gộp cuối tháng: tuần 20/07 (+6 = 26/07, stub còn 5 ngày) nuốt luôn
    // đến 31/07 — nên dữ liệu cũ KHÔNG có tuần 27/07; sang tháng 8 không tuần
    // nào chứa hôm nay → undefined (trước fix: fallback trả 20/07 → stale).
    expect(weekEndISO('2026-07-20')).toBe('2026-07-31')
    expect(currentWeekStart(['2026-07-13', '2026-07-20'], '2026-08-04')).toBeUndefined()
  })

  test('tuần CHỨA hôm nay → chọn đúng; biên: ngày đầu + ngày cuối tuần đều thuộc tuần đó', () => {
    const starts = ['2026-08-03', '2026-07-27']
    expect(currentWeekStart(starts, '2026-08-03')).toBe('2026-08-03')
    expect(currentWeekStart(starts, '2026-08-05')).toBe('2026-08-03')
    expect(currentWeekStart(starts, '2026-08-09')).toBe('2026-08-03') // end = start+6
    expect(currentWeekStart(starts, '2026-08-10')).toBeUndefined()    // tuần kế chưa có row
  })

  test('tuần cuối tháng MỞ RỘNG vẫn thắng qua hết tháng (overlap chọn tuần SỚM hơn — giữ hành vi cũ)', () => {
    // 22/06 gộp 22–30/06; row 29/06 (nếu nguồn có) không được lấn
    expect(currentWeekStart(['2026-06-22', '2026-06-29'], '2026-06-30')).toBe('2026-06-22')
  })

  test('danh sách rỗng/blank → undefined (không nổ, không bịa tuần)', () => {
    expect(currentWeekStart([], '2026-08-04')).toBeUndefined()
    expect(currentWeekStart(['', ''], '2026-08-04')).toBeUndefined()
  })

  test('P2#3 (source-text): kpi.ts TỪ CHỐI row có raw_row_count != 1 — nguồn trùng dòng không được ghi đè', () => {
    // lib/targets/kpi.ts import 'server-only' → không import runtime trong test;
    // khóa guard bằng source-text như kpi-net-revenue-source.spec.
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'targets', 'kpi.ts'), 'utf8')
    expect(src).toContain('rawRowCount !== 1')
    expect(src).toContain('bỏ qua, không ghi')
  })
})
