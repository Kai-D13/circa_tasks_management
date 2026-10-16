import { test, expect } from '@playwright/test'
import { normalizeProgress } from '../lib/ui/progress'

// PM audit P1.0 (P2): ProgressBar phải an toàn ở giá trị biên trước khi dùng trên route thật (P1.2).
// Logic thuần — không cần server.

test.describe('normalizeProgress @desktop', () => {
  test('giá trị thường', () => {
    expect(normalizeProgress(18, 25)).toEqual({ valid: true, value: 18, max: 25, pct: 72 })
    expect(normalizeProgress(0, 10)).toEqual({ valid: true, value: 0, max: 10, pct: 0 })
    expect(normalizeProgress(10, 10)).toEqual({ valid: true, value: 10, max: 10, pct: 100 })
  })
  test('value ngoài khoảng ⇒ kẹp (ARIA cũng nhận giá trị đã kẹp)', () => {
    expect(normalizeProgress(30, 25)).toEqual({ valid: true, value: 25, max: 25, pct: 100 })
    expect(normalizeProgress(-3, 25)).toEqual({ valid: true, value: 0, max: 25, pct: 0 })
    expect(normalizeProgress(Number.NaN, 25)).toEqual({ valid: true, value: 0, max: 25, pct: 0 })
  })
  test('max không hợp lệ ⇒ không vẽ thanh', () => {
    for (const max of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(normalizeProgress(5, max).valid, `max=${max}`).toBe(false)
    }
  })
  test('làm tròn phần trăm', () => {
    expect(normalizeProgress(1, 3).pct).toBe(33)
    expect(normalizeProgress(2, 3).pct).toBe(67)
  })
})
