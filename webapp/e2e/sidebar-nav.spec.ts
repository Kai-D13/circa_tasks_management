import { test, expect, type Page } from '@playwright/test'
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

// ─────────────────────────────────────────────────────────────────────────────
// DOM SINGLE-ACTIVE (audit test-tooling, P2#4)
//
// Mọi test ở trên chỉ chứng minh HÀM THUẦN trả về đúng một href. Chúng KHÔNG
// chứng minh cái người dùng nhìn thấy: Sidebar vẫn có thể quên truyền prop
// `active` cho một NavLink, quên `aria-current`, hoặc tô nền cho nút CHA
// accordion — hàm thuần vẫn xanh trong khi màn hình sáng hai chỗ. Block này mở
// trình duyệt thật, đăng nhập super admin, và soi <aside> trên 4 route lồng nhau.
//
// Env: E2E_SUPER_EMAIL/PASSWORD + một server đang chạy (E2E_BASE_URL) — thiếu
// thì skip, CÙNG cơ chế với e2e/ui-catalog.spec.ts. Login flow cũng lấy nguyên
// từ đó (fill → verify → submit → chờ redirect, bọc trong toPass): hydration
// dưới tải nhiều project có thể reset input SAU khi fill nhìn như đã thành công.
// ─────────────────────────────────────────────────────────────────────────────

const SUPER = { email: process.env.E2E_SUPER_EMAIL, password: process.env.E2E_SUPER_PASSWORD }

async function login(page: Page) {
  await page.goto('/login')
  await page.waitForLoadState('networkidle')
  await expect(async () => {
    await page.fill('#email', SUPER.email!)
    await page.fill('#password', SUPER.password!)
    await page.waitForTimeout(150)
    expect(await page.inputValue('#email')).toBe(SUPER.email)
    expect(await page.inputValue('#password')).toBe(SUPER.password)
    await page.getByRole('button', { name: /sign in/i }).click()
    await page.waitForURL(/\/(tasks|dashboard|targets|fs)/, { timeout: 10_000, waitUntil: 'commit' })
  }).toPass({ timeout: 60_000, intervals: [1_000, 2_000, 3_000] })
}

// Chromium trả về ĐÚNG chuỗi này cho phần tử không đặt background-color (giá
// trị initial là `transparent`) — không phụ thuộc token màu đang là oklch hay
// rgb, nên so sánh chuỗi ở đây bền hơn mọi cách parse alpha.
const NO_BG = 'rgba(0, 0, 0, 0)'

type NestedCase = {
  route: string
  /** Các href có thể nhận nền active, XẾP TỪ DÀI ĐẾN NGẮN. */
  expect: string[]
  /** Nhãn nút CHA accordion chứa route này (nếu có). */
  parent?: string
}

const NESTED: NestedCase[] = [
  { route: '/tasks/schedules', expect: ['/tasks/schedules'] },
  // Super admin KHÔNG có mục nav "Affiliate" (chỉ admin phòng được cấp quyền
  // mới có — prop `affiliateOverviewNav`), nên trên route này href DÀI NHẤT
  // ĐANG HIỂN THỊ là '/targets/campaigns'. Liệt kê cả hai theo thứ tự dài→ngắn
  // rồi lấy cái đầu tiên thực sự có trong sidebar: contract "con thắng cha" vẫn
  // bị khoá chặt, mà test không vỡ chỉ vì role/flag đổi tập nav.
  { route: '/targets/campaigns/affiliate', expect: ['/targets/campaigns/affiliate', '/targets/campaigns'] },
  // Nhãn cha đổi 'Inventory' → 'Tồn kho' ở sidebar r2 (chỉ NHÃN — href và gating
  // y nguyên); test tìm nút accordion bằng textContent nên phải đi cùng.
  { route: '/inventory/trf', expect: ['/inventory/trf'], parent: 'Tồn kho' },
  { route: '/fs/products',   expect: ['/fs/products'],   parent: 'Quản lý FS' },
]

test.describe('sidebar active-state trên DOM thật @desktop', () => {
  test.skip(!SUPER.email || !SUPER.password, 'E2E_SUPER_* not set')

  test('đúng 1 aria-current + đúng 1 nền active trên route lồng nhau', async ({ page }) => {
    test.setTimeout(180_000)
    await login(page)

    for (const { route, expect: candidates, parent } of NESTED) {
      await page.goto(route)
      // Route phải render THẬT. Nếu bị redirect vì thiếu quyền thì mọi khẳng
      // định bên dưới đang nói về sidebar của một trang khác — im lặng pass.
      await expect(page, `${route}: bị redirect ⇒ tài khoản E2E_SUPER_* thiếu quyền?`)
        .toHaveURL(new RegExp(`${route}(\\?|$)`))

      const aside = page.locator('aside')
      await expect(aside, `${route}: không thấy <aside> (viewport < md?)`).toBeVisible()
      // Chờ trạng thái active xuất hiện trước khi đo, để không bắt được DOM ở
      // giữa chừng hydration.
      await expect(aside.locator('[aria-current="page"]')).toHaveCount(1)

      const rows = await aside.evaluate((el) =>
        // Chỉ các HÀNG điều hướng trong vùng nav (link + nút accordion) — logo
        // bar, avatar, nút footer đều có nền riêng và không dính contract này.
        [...el.querySelectorAll<HTMLElement>('#sidebar-nav a, #sidebar-nav button')].map((r) => ({
          href:  r.getAttribute('href'),
          label: (r.textContent ?? '').trim(),
          current: r.getAttribute('aria-current'),
          // ĐO NỀN BẰNG COMPUTED STYLE, KHÔNG bằng chuỗi class: hàng active mang
          // 'bg-sidebar-accent', hàng idle/context mang 'hover:bg-sidebar-accent/60'
          // — chuỗi trước là CON của chuỗi sau, nên đếm bằng
          // [class*="bg-sidebar-accent"] sẽ đếm luôn cả hàng chỉ-hover (Tailwind
          // giữ nguyên literal '/60' trong class attribute). Computed style chỉ
          // trả về nền ĐANG SƠN — biến thể hover không áp khi con trỏ không nằm
          // trên phần tử — nên nó đúng cả khi tên token màu đổi.
          bg:    getComputedStyle(r).backgroundColor,
          color: getComputedStyle(r).color,
        })),
      )

      const hrefs = rows.map((r) => r.href).filter((h): h is string => h !== null)
      const expected = candidates.find((h) => hrefs.includes(h))
      expect(expected, `${route}: sidebar không render mục nav nào trong [${candidates.join(', ')}] — có ${hrefs.join(', ')}`)
        .toBeTruthy()

      // (1) ĐÚNG 1 aria-current, và nó nằm trên href dài nhất đang hiển thị.
      const current = rows.filter((r) => r.current === 'page')
      expect(current.map((r) => r.href), `${route}: số hàng aria-current="page"`).toHaveLength(1)
      expect(current[0].href, `${route}: aria-current đặt sai hàng`).toBe(expected)
      // Và DOM khớp đúng contract của hàm thuần trên TẬP HREF THẬT của sidebar.
      expect(resolveActiveHref(route, hrefs), `${route}: DOM lệch khỏi resolveActiveHref`).toBe(expected)

      // (2) ĐÚNG 1 hàng thực sự được sơn nền, và chính là hàng aria-current —
      // đây là phần mà unit test không bao giờ chạm tới được.
      const painted = rows.filter((r) => r.bg !== NO_BG)
      expect(painted.map((r) => r.href ?? r.label), `${route}: số hàng có nền active`).toHaveLength(1)
      expect(painted[0].href, `${route}: nền active nằm sai hàng`).toBe(expected)

      // (3) Nút CHA accordion: KHÔNG nền, chỉ tint MÀU CHỮ (cùng text-primary
      //     với hàng active). Cha có nền ⇒ cha và con cùng sáng, người dùng
      //     không còn biết mình đang đứng ở trang nào.
      if (parent) {
        const parentRow = rows.find((r) => r.href === null && r.label.startsWith(parent))
        expect(parentRow, `${route}: không tìm thấy nút accordion "${parent}"`).toBeTruthy()
        expect(parentRow!.bg, `${route}: nút cha "${parent}" đang mang nền active`).toBe(NO_BG)
        expect(parentRow!.color, `${route}: nút cha "${parent}" thiếu tint text-primary`).toBe(painted[0].color)
      }
    }
  })
})
