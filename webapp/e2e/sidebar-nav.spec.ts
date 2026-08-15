import { test, expect } from '@playwright/test'
import { resolveActiveHref } from '../lib/layout/sidebarNav'

// Unit thuần (không cần browser/server) khoá contract active-state của Sidebar
// sau audit UI-fluid-sidebar-r1 (P1#1): "đúng 1 nền active".
// Rule cũ so khớp từng item bằng `startsWith(href)` nên ở /tasks/schedules cả
// "Tasks" lẫn "Định kỳ" cùng sáng; nút CHA accordion còn tint bằng
// `startsWith('/inventory')` nên ở /inventory/trf cha và con cùng nền.
// Bộ href dưới đây là TẬP THẬT của sidebar (mọi item role + 2 link con
// accordion + 2 link gated KPI/Affiliate) — super admin thấy nhiều nhất.
const HREFS = [
  '/dashboard',
  '/tasks',
  '/tasks/schedules',
  '/targets',
  '/targets/campaigns',
  '/targets/campaigns/affiliate',
  '/users',
  '/stores',
  '/prescriptions',
  '/announcements',
  '/gioi-thieu',
  '/logs',
  '/inventory/trf',
  '/fs/products',
]

test.describe('sidebar active-state contract @desktop', () => {
  test('longest-match: con thắng cha trên mọi nhánh lồng nhau', () => {
    // Nhánh /tasks — bug gốc của finding.
    expect(resolveActiveHref('/tasks/schedules', HREFS)).toBe('/tasks/schedules')
    expect(resolveActiveHref('/tasks/schedules/abc123', HREFS)).toBe('/tasks/schedules')
    // Nhánh /targets 3 tầng.
    expect(resolveActiveHref('/targets/campaigns/affiliate', HREFS)).toBe('/targets/campaigns/affiliate')
    expect(resolveActiveHref('/targets/campaigns/affiliate/xyz', HREFS)).toBe('/targets/campaigns/affiliate')
    expect(resolveActiveHref('/targets/campaigns/xyz', HREFS)).toBe('/targets/campaigns')
    expect(resolveActiveHref('/targets/campaigns', HREFS)).toBe('/targets/campaigns')
    expect(resolveActiveHref('/targets', HREFS)).toBe('/targets')
  })

  test('link con của accordion: chính nó active, không phải section cha', () => {
    // Section /inventory và /fs KHÔNG có href trong tập — cha chỉ được tint
    // "context" (màu chữ), nền active thuộc về đúng link con này.
    expect(resolveActiveHref('/inventory/trf', HREFS)).toBe('/inventory/trf')
    expect(resolveActiveHref('/inventory/trf/POS0059', HREFS)).toBe('/inventory/trf')
    expect(resolveActiveHref('/fs/products/abc', HREFS)).toBe('/fs/products')
    expect(resolveActiveHref('/fs/products', HREFS)).toBe('/fs/products')
    // Hub /inventory không có mục nav ⇒ không mục nào mang nền active.
    expect(resolveActiveHref('/inventory', HREFS)).toBeNull()
  })

  test('trang con thường + pathname lạ', () => {
    expect(resolveActiveHref('/tasks/abc', HREFS)).toBe('/tasks')
    expect(resolveActiveHref('/tasks', HREFS)).toBe('/tasks')
    expect(resolveActiveHref('/khong-ton-tai', HREFS)).toBeNull()
    expect(resolveActiveHref('/', HREFS)).toBeNull()
  })

  test('so khớp theo RANH GIỚI "/" — không phải prefix chuỗi', () => {
    // Cùng predicate với BottomNav: '/tasks-archive' không được sáng "Tasks".
    expect(resolveActiveHref('/tasks-archive', HREFS)).toBeNull()
    expect(resolveActiveHref('/users-import', HREFS)).toBeNull()
    expect(resolveActiveHref('/logs2', HREFS)).toBeNull()
  })

  test('LUÔN đúng 1 kết quả: kiểu trả về là string đơn, và là href dài nhất', () => {
    // Nhiều href cùng khớp một pathname là chuyện bình thường (cha + con);
    // contract nằm ở chỗ hàm CHỈ trả một — không có đường nào ra 2 mục sáng.
    const paths = [
      '/dashboard', '/tasks', '/tasks/abc', '/tasks/schedules', '/tasks/schedules/abc123',
      '/targets', '/targets/campaigns', '/targets/campaigns/xyz',
      '/targets/campaigns/affiliate', '/users', '/stores', '/prescriptions/1',
      '/announcements/2/edit', '/gioi-thieu', '/logs', '/inventory', '/inventory/trf',
      '/fs', '/fs/products', '/fs/products/abc/process', '/khong-ton-tai',
    ]
    for (const p of paths) {
      const result = resolveActiveHref(p, HREFS)
      const matches = HREFS.filter((h) => p === h || p.startsWith(h + '/'))
      if (matches.length === 0) {
        expect(result, p).toBeNull()
      } else {
        expect(typeof result, p).toBe('string')
        // Đúng href dài nhất trong các href khớp — và duy nhất một.
        const longest = matches.reduce((a, b) => (b.length > a.length ? b : a))
        expect(result, p).toBe(longest)
        expect(HREFS.filter((h) => h === result), p).toHaveLength(1)
      }
    }
  })

  test('tập href rỗng (staff không có sidebar desktop) → null', () => {
    expect(resolveActiveHref('/tasks', [])).toBeNull()
  })
})
