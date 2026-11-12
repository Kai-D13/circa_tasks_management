import fs from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import { resolveActiveHref } from '../lib/layout/sidebarNav'
import { MANAGER_STATE, SM_STATE } from './authState'
import { trapWrites } from './fixtureGuard'

// Unit thuần (không cần browser/server) khoá contract active-state của Sidebar
// sau audit UI-fluid-sidebar-r1 (P1#1): "đúng 1 nền active".
// Rule cũ so khớp từng item bằng `startsWith(href)` nên ở /tasks/schedules cả
// "Tasks" lẫn "Định kỳ" cùng sáng; nút CHA accordion còn tint bằng
// `startsWith('/inventory')` nên ở /inventory/trf cha và con cùng nền.
// Bộ href dưới đây là TẬP THẬT của sidebar (mọi item role + 2 link con
// accordion + nhóm Chiến dịch KPI / Affiliate / CMS — UI-NAV U1) — super admin thấy nhiều nhất.
const HREFS = [
  '/dashboard',
  '/tasks',
  '/tasks/schedules',
  '/targets',
  '/targets/campaigns',
  '/targets/campaigns/affiliate',
  '/targets/campaigns/cms',
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
    await page.getByRole('button', { name: /^đăng nhập$/i }).click()
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
  // UI-NAV U1: super CÓ mục "Affiliate" trong nhóm "Chiến dịch" (cờ KPI + Affiliate của server gate bật) ⇒ con Affiliate active,
  // nút cha "Chiến dịch" chỉ tint. (Trước UI-NAV super không có mục này — kỳ vọng cũ đã bỏ theo spec §6.)
  { route: '/targets/campaigns', expect: ['/targets/campaigns'], parent: 'Chiến dịch' },
  { route: '/targets/campaigns/affiliate', expect: ['/targets/campaigns/affiliate'], parent: 'Chiến dịch' },
  // Nhãn cha đổi 'Inventory' → 'Tồn kho' ở sidebar r2 (chỉ NHÃN — href và gating
  // y nguyên); test tìm nút accordion bằng textContent nên phải đi cùng.
  { route: '/inventory/trf', expect: ['/inventory/trf'], parent: 'Tồn kho' },
  { route: '/fs/products',   expect: ['/fs/products'],   parent: 'Quản lý FS' },
  // CMS: route chỉ tồn tại khi server bật CMS_PROGRAM_ENABLED (E2E_CMS_ENABLED=1); chi tiết = chương trình T11 (đọc).
  ...(process.env.E2E_CMS_ENABLED === '1' ? [
    { route: '/targets/campaigns/cms', expect: ['/targets/campaigns/cms'], parent: 'Chiến dịch' },
    { route: '/targets/campaigns/cms/942194ce-893f-4f62-a88a-bd9efa464bae', expect: ['/targets/campaigns/cms'], parent: 'Chiến dịch' },
  ] : []),
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

// ─────────────────────────────────────────────────────────────────────────────
// UI-NAV U1 (PM spec planning/research/ui-nav-spec-implementation-2026-11-08.md §3, AC01–AC04, AC09, AC11): nhóm Sidebar
// "Chiến dịch" trên DOM thật theo vai + hàng tab trong trang. Chỉ đọc (không bấm nút ghi). Cờ server gate: KPI + Affiliate bật;
// CMS theo E2E_CMS_ENABLED (route CMS chỉ kiểm khi bật).
// ─────────────────────────────────────────────────────────────────────────────
const CMS_ON = process.env.E2E_CMS_ENABLED === '1'
const GROUP_BTN = '#sidebar-nav [data-sidebar-group="campaigns"] button'
const SUB = '#sidebar-campaigns-sub'
const subLabels = (page: Page) => page.locator(`${SUB} a`).evaluateAll((as) => as.map((a) => ({ text: (a.textContent ?? '').trim(), href: a.getAttribute('href'), cur: a.getAttribute('aria-current') })))
const tabsRow = (page: Page) => page.locator('main [data-campaigns-tabs]').first()
const asideWidth = (page: Page) => page.locator('aside').evaluate((e) => Math.round(e.getBoundingClientRect().width))

test.describe('UI-NAV nhóm "Chiến dịch" — super @desktop', () => {
  test.skip(!SUPER.email || !SUPER.password, 'E2E_SUPER_* not set')

  test('mục con theo cờ, mở sẵn trên route module, đúng một con active; cha không nền / không aria-current', async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width: 1280, height: 900 })
    await login(page)
    const want = [
      { text: 'Chiến dịch KPI', href: '/targets/campaigns' },
      { text: 'Affiliate', href: '/targets/campaigns/affiliate' },
      ...(CMS_ON ? [{ text: 'CMS sản phẩm', href: '/targets/campaigns/cms' }] : []),
    ]
    // Route ngoài module: nhóm đóng (không tự mở), không con nào active.
    await page.goto('/tasks')
    const btn = page.locator(GROUP_BTN).first()
    await expect(btn).toBeVisible()
    await expect(btn).toHaveText(/^Chiến dịch$/)
    await expect(btn).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator(SUB)).toHaveCount(0)
    await page.goto('/targets/campaigns')
    await expect(btn).toHaveAttribute('aria-expanded', 'true')
    await expect(btn).toHaveAttribute('aria-controls', 'sidebar-campaigns-sub')
    expect((await subLabels(page)).map(({ text, href }) => ({ text, href })), 'mục con / thứ tự').toEqual(want)
    // KPI chi tiết = thẻ đầu danh sách (nếu có): con KPI active, Sidebar không có href chi tiết riêng.
    const detail = await page.locator('main a[href^="/targets/campaigns/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? '')
      .find((h) => /^\/targets\/campaigns\/[0-9a-f-]{36}$/.test(h)) ?? null)
    const routes = ['/targets/campaigns', '/targets/campaigns/affiliate', ...(detail ? [detail] : []), ...(CMS_ON ? ['/targets/campaigns/cms', '/targets/campaigns/cms/942194ce-893f-4f62-a88a-bd9efa464bae'] : [])]
    for (const route of routes) {
      await page.goto(route)
      await expect(page).toHaveURL(new RegExp(`${route}(\\?|$)`))
      await expect(btn, `${route}: nhóm phải mở sẵn khi tải thẳng URL module`).toHaveAttribute('aria-expanded', 'true')
      const subs = await subLabels(page)
      const cur = subs.filter((x) => x.cur === 'page')
      const expectHref = resolveActiveHref(route, subs.map((x) => x.href ?? ''))
      expect(cur.map((x) => x.href), `${route}: đúng một con aria-current`).toEqual([expectHref])
      await expect(page.locator('aside [aria-current="page"]'), `${route}: số aria-current trong Sidebar`).toHaveCount(1)
      expect(await btn.getAttribute('aria-current'), `${route}: cha không được aria-current`).toBeNull()
      expect(await btn.evaluate((e) => getComputedStyle(e).backgroundColor), `${route}: cha mang nền`).toBe(NO_BG)
    }
    if (!detail) test.info().annotations.push({ type: 'ui-nav', description: 'không có thẻ chiến dịch KPI để mở chi tiết — CHƯA KIỂM route chi tiết KPI' })
  })

  test('thu / mở bằng chuột + Enter + Space; Back vào module tự mở lại; route ngoài không ép mở', async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 1280, height: 900 })
    await login(page)
    await page.goto('/targets/campaigns/affiliate')
    const btn = page.locator(GROUP_BTN).first()
    await expect(btn).toHaveAttribute('aria-expanded', 'true')
    await btn.click()
    await expect(btn, 'user thu nhóm khi đang ở trong module').toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator(SUB)).toHaveCount(0)
    await page.waitForTimeout(500)
    await expect(btn, 'nhóm tự mở lại dù route không đổi').toHaveAttribute('aria-expanded', 'false')
    await btn.focus()
    await page.keyboard.press('Enter')
    await expect(btn).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Space')
    await expect(btn).toHaveAttribute('aria-expanded', 'false')
    const ring = await btn.evaluate((e) => getComputedStyle(e).boxShadow !== 'none')
    expect(ring, 'focus ring của nút cha khi dùng bàn phím').toBe(true)
    // Rời module bằng Sidebar (điều hướng client) rồi Back ⇒ vào lại module ⇒ tự mở.
    await page.locator('#sidebar-nav a[href="/tasks"]').first().click()
    await expect(page).toHaveURL(/\/tasks(\?|$)/)
    await expect(btn).toHaveAttribute('aria-expanded', 'false')
    await page.goBack()
    await expect(page).toHaveURL(/\/targets\/campaigns\/affiliate$/)
    await expect(btn, 'Back vào module: nhóm tự mở').toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator(`${SUB} a[aria-current="page"]`)).toHaveAttribute('href', '/targets/campaigns/affiliate')
  })

  test('rail 64px: bấm icon nhóm ⇒ mở Sidebar (cookie) + bung nhóm, KHÔNG điều hướng; tải lại giữ; HTML đầu không nháy', async ({ page, baseURL }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 1280, height: 900 })
    await login(page)
    await page.context().addCookies([{ name: 'sidebar_collapsed', value: '1', url: baseURL! }])
    await page.goto('/tasks')
    expect(await asideWidth(page)).toBe(64)
    const btn = page.locator(GROUP_BTN).first()
    await expect(btn).toHaveAttribute('aria-label', 'Chiến dịch')
    await btn.click()
    await expect.poll(() => asideWidth(page)).toBe(232)
    await expect(page).toHaveURL(/\/tasks(\?|$)/)
    await expect(btn).toHaveAttribute('aria-expanded', 'true')
    expect((await page.context().cookies()).find((c) => c.name === 'sidebar_collapsed')?.value).toBe('0')
    await page.reload()
    expect(await asideWidth(page), 'tải lại giữ mở rộng (cookie)').toBe(232)
    // HTML server (trước hydrate) của route module đã có nhóm mở + con active ⇒ không nháy first paint.
    const html = await (await page.request.get('/targets/campaigns/affiliate')).text()
    expect(html, 'SSR: nhóm chưa mở sẵn').toContain('id="sidebar-campaigns-sub"')
    expect(html, 'SSR: thiếu nhóm').toContain('data-sidebar-group="campaigns"')
    await page.context().addCookies([{ name: 'sidebar_collapsed', value: '1', url: baseURL! }])
    const htmlRail = await (await page.request.get('/targets/campaigns/affiliate')).text()
    expect(htmlRail, 'SSR rail: bề rộng 64px ngay HTML đầu').toContain('w-[64px]')
    await page.context().addCookies([{ name: 'sidebar_collapsed', value: '0', url: baseURL! }])
  })

  test('hàng tab chuyển module: ẩn từ 768px khi Sidebar thay thế đủ; 767px vẫn hiện', async ({ page }) => {
    test.setTimeout(120_000)
    await login(page)
    for (const route of ['/targets/campaigns', '/targets/campaigns/affiliate', ...(CMS_ON ? ['/targets/campaigns/cms'] : [])]) {
      await page.setViewportSize({ width: 1280, height: 900 })
      await page.goto(route)
      await expect(tabsRow(page), `${route}: thiếu hàng tab trong DOM`).toHaveAttribute('data-campaigns-tabs', 'mobile-only')
      await expect(tabsRow(page), `${route} @1280: hàng tab còn hiện`).toBeHidden()
      for (const [w, visible] of [[768, false], [767, true]] as const) {
        await page.setViewportSize({ width: w, height: 900 })
        if (visible) await expect(tabsRow(page), `${route} @${w}: mobile phải còn hàng tab`).toBeVisible()
        else await expect(tabsRow(page), `${route} @${w}: hàng tab còn hiện`).toBeHidden()
      }
      // Mobile vẫn đi được giữa các module bằng tab (Sidebar ẩn < 768).
      await expect(page.locator('aside')).toBeHidden()
      await expect(tabsRow(page).locator('a', { hasText: 'Affiliate' })).toHaveAttribute('href', '/targets/campaigns/affiliate')
    }
  })
})

// SM-CAMPAIGN-NAV-1 (work order PM 12/11, SM-NAV-D01 thay nhánh SM của UI-NAV-D03): SM nhận nhóm "Chiến dịch" (KPI · Affiliate ·
// CMS theo cờ ∩ quyền hiện có), GIỮ mục Doanh số + trang tổng hợp + hai nút header; BottomNav không đổi. Chỉ đọc: 0 request ghi.
// Affiliate của SM 404 khi tài khoản không có nhà thuốc OS active (cổng cũ) ⇒ ghi nhánh, không coi là đạt nhánh có view.
test.describe('UI-NAV — SM nhóm "Chiến dịch" (SM-NAV-D01) @desktop', () => {
  test.skip(!fs.existsSync(SM_STATE), 'chưa có phiên SM')
  test.use({ storageState: SM_STATE })
  const want = [
    { text: 'Chiến dịch KPI', href: '/targets/campaigns' },
    { text: 'Affiliate', href: '/targets/campaigns/affiliate' },
    ...(CMS_ON ? [{ text: 'CMS sản phẩm', href: '/targets/campaigns/cms' }] : []),
  ]
  const notFound = (page: Page) => page.locator('main').getByText('This page could not be found.')
  const doanhSo = (page: Page) => page.locator('#sidebar-nav a[href="/targets"]')

  test('desktop 1280: Doanh số giữ nguyên; nhóm đúng mục theo cờ; đúng một aria-current (Doanh số không cùng sáng); tabs chỉ còn ở mobile', async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width: 1280, height: 900 })
    const writes = await trapWrites(page)
    // Landing tổng hợp: Doanh số sáng, nhóm đóng, hai nút header còn nguyên.
    await page.goto('/targets')
    await expect(page.locator('main [data-sm-targets]')).toHaveAttribute('data-sm-targets', 'landing', { timeout: 20_000 })
    await expect(doanhSo(page)).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('aside [aria-current="page"]'), '/targets: số aria-current trong Sidebar').toHaveCount(1)
    await expect(page.locator('main [data-sm-targets]').getByRole('link', { name: 'Lịch sử chiến dịch' })).toHaveAttribute('href', '/targets/campaigns?status=ended')
    await expect(page.locator('main [data-sm-cms-entry]'), 'nút CMS landing theo cờ CMS').toHaveCount(CMS_ON ? 1 : 0)
    const btn = page.locator(GROUP_BTN).first()
    await expect(btn).toHaveText(/^Chiến dịch$/)
    await expect(btn, 'route ngoài module: nhóm không tự mở').toHaveAttribute('aria-expanded', 'false')
    // Bàn phím: Enter mở nhóm, đúng mục / thứ tự, chưa mục con nào sáng.
    await btn.focus()
    await page.keyboard.press('Enter')
    await expect(btn).toHaveAttribute('aria-expanded', 'true')
    const subs0 = await subLabels(page)
    expect(subs0.map(({ text, href }) => ({ text, href })), 'mục con / thứ tự').toEqual(want)
    expect(subs0.filter((x) => x.cur === 'page'), '/targets: không mục con nào sáng').toEqual([])
    // Từng route module: nhóm mở sẵn, đúng một con sáng, Doanh số không sáng, cha không nền / aria-current; tabs mobile-only.
    const visited: string[] = []
    for (const route of want.map((w) => w.href)) {
      await page.goto(route)
      await expect(page).toHaveURL(new RegExp(`${route}(\\?|$)`))
      if (route.endsWith('/affiliate') && await notFound(page).isVisible({ timeout: 5_000 }).catch(() => false)) {
        test.info().annotations.push({ type: 'nhánh', description: 'SM Affiliate 404 (không có nhà thuốc OS active) — CHƯA KIỂM nhánh có view' })
        continue
      }
      visited.push(route)
      await expect(btn, `${route}: nhóm phải mở sẵn`).toHaveAttribute('aria-expanded', 'true')
      const subs = await subLabels(page)
      expect(subs.filter((x) => x.cur === 'page').map((x) => x.href), `${route}: đúng một con aria-current`).toEqual([route])
      await expect(page.locator('aside [aria-current="page"]'), `${route}: số aria-current trong Sidebar`).toHaveCount(1)
      expect(await doanhSo(page).getAttribute('aria-current'), `${route}: Doanh số không được cùng sáng`).toBeNull()
      expect(await btn.getAttribute('aria-current'), `${route}: cha không được aria-current`).toBeNull()
      expect(await btn.evaluate((e) => getComputedStyle(e).backgroundColor), `${route}: cha mang nền`).toBe(NO_BG)
      await expect(tabsRow(page), `${route}: hàng tab phải còn trong DOM, chỉ cho mobile`).toHaveAttribute('data-campaigns-tabs', 'mobile-only')
      await expect(tabsRow(page), `${route} @1280: hàng tab còn hiện`).toBeHidden()
    }
    // Chi tiết KPI (thẻ đầu danh sách nếu có) ⇒ con KPI sáng, Doanh số không.
    await page.goto('/targets/campaigns')
    const detail = await page.locator('main a[href^="/targets/campaigns/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? '')
      .find((h) => /^\/targets\/campaigns\/[0-9a-f-]{36}$/.test(h)) ?? null)
    if (detail) {
      await page.goto(detail)
      expect((await subLabels(page)).filter((x) => x.cur === 'page').map((x) => x.href), 'chi tiết KPI: con KPI sáng').toEqual(['/targets/campaigns'])
      expect(await doanhSo(page).getAttribute('aria-current')).toBeNull()
    } else test.info().annotations.push({ type: 'nhánh', description: 'SM không có thẻ chiến dịch KPI — CHƯA KIỂM chi tiết KPI' })
    // Điều hướng client bằng Sidebar rồi Back: về đúng route, đúng mục sáng.
    const last = visited[visited.length - 1]
    await page.goto('/targets')
    await btn.click()
    await page.locator(`${SUB} a[href="${last}"]`).click()
    await expect(page).toHaveURL(new RegExp(`${last}(\\?|$)`))
    await expect(page.locator(`${SUB} a[aria-current="page"]`)).toHaveAttribute('href', last)
    await page.goBack()
    await expect(page).toHaveURL(/\/targets$/)
    await expect(doanhSo(page)).toHaveAttribute('aria-current', 'page')
    expect(writes, 'SM chỉ đọc: không request ghi').toEqual([])
  })

  test('rail 64px: nhóm SM có tên truy cập; bấm ⇒ mở Sidebar + bung nhóm, không điều hướng', async ({ page, baseURL }) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.context().addCookies([{ name: 'sidebar_collapsed', value: '1', url: baseURL! }])
    await page.goto('/targets')
    expect(await asideWidth(page)).toBe(64)
    const btn = page.locator(GROUP_BTN).first()
    await expect(btn).toHaveAttribute('aria-label', 'Chiến dịch')
    await btn.click()
    await expect.poll(() => asideWidth(page)).toBe(232)
    await expect(page).toHaveURL(/\/targets$/)
    await expect(btn).toHaveAttribute('aria-expanded', 'true')
    await page.context().addCookies([{ name: 'sidebar_collapsed', value: '0', url: baseURL! }])
  })

  test('mobile 390: không Sidebar; ba trang module có hàng tab chung (Affiliate kèm "← Doanh số"); BottomNav giữ Doanh số', async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 390, height: 844 })
    const writes = await trapWrites(page)
    const tabLabels = ['Chiến dịch', 'Affiliate', ...(CMS_ON ? ['CMS sản phẩm'] : [])]
    const active: Record<string, string> = { '/targets/campaigns': 'Chiến dịch', '/targets/campaigns/affiliate': 'Affiliate', '/targets/campaigns/cms': 'CMS sản phẩm' }
    for (const route of want.map((w) => w.href)) {
      await page.goto(route)
      if (route.endsWith('/affiliate') && await notFound(page).isVisible({ timeout: 5_000 }).catch(() => false)) {
        test.info().annotations.push({ type: 'nhánh', description: 'SM Affiliate 404 (không có nhà thuốc OS active) — CHƯA KIỂM tab mobile Affiliate' })
        continue
      }
      await expect(page.locator('aside')).toBeHidden()
      await expect(tabsRow(page), `${route} @390: hàng tab phải hiện`).toBeVisible()
      expect(await tabsRow(page).locator('a').evaluateAll((as) => as.map((a) => (a.textContent ?? '').trim())), `${route}: nhãn tab`).toEqual(tabLabels)
      await expect(tabsRow(page).locator('a[aria-current="page"]'), `${route}: tab đang chọn`).toHaveText(active[route])
      if (route.endsWith('/affiliate')) await expect(page.locator('main').getByRole('link', { name: '← Doanh số' })).toHaveAttribute('href', '/targets')
      const nav = page.locator('[data-bottom-nav]')
      await expect(nav).toBeVisible()
      await expect(nav.locator('a[href="/targets"]'), 'BottomNav giữ mục Doanh số').toHaveCount(1)
      await expect(nav.locator('a[href^="/targets/campaigns"]'), 'BottomNav không nhận mục Chiến dịch').toHaveCount(0)
    }
    expect(writes, 'SM chỉ đọc: không request ghi').toEqual([])
  })
})

test.describe('UI-NAV — QLCH không nhận nhóm @desktop', () => {
  test.skip(!fs.existsSync(MANAGER_STATE), 'chưa có phiên QLCH')
  test.use({ storageState: MANAGER_STATE })
  test('QLCH: Sidebar không có nhóm / link Chiến dịch; /targets/campaigns ⇒ 404 như cũ', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/tasks')
    await expect(page.locator('aside')).toBeVisible()
    await expect(page.locator('#sidebar-nav [data-sidebar-group="campaigns"]')).toHaveCount(0)
    await expect(page.locator('#sidebar-nav a[href^="/targets/campaigns"]')).toHaveCount(0)
    await page.goto('/targets/campaigns')
    await expect(page.locator('main').getByText('This page could not be found.')).toBeVisible({ timeout: 15_000 })
  })
})

const MKT = { email: process.env.E2E_MKT_ADMIN_EMAIL, password: process.env.E2E_MKT_ADMIN_PASSWORD }
test.describe('UI-NAV — admin không super (MKT) @desktop', () => {
  test.skip(!MKT.email || !MKT.password, 'E2E_MKT_ADMIN_* not set')
  test('admin không super: không KPI / CMS; Affiliate chỉ là link đơn khi phòng được cấp quyền; deep link KPI / CMS ⇒ 404', async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/login')
    await page.fill('#email', MKT.email!)
    await page.fill('#password', MKT.password!)
    await page.getByRole('button', { name: /^đăng nhập$/i }).click()
    await page.waitForURL(/\/(tasks|dashboard|targets|fs)/, { timeout: 20_000 })
    await expect(page.locator('aside')).toBeVisible()
    await expect(page.locator('#sidebar-nav [data-sidebar-group="campaigns"]'), 'admin không super không được có accordion').toHaveCount(0)
    const hrefs = await page.locator('#sidebar-nav a[href^="/targets/campaigns"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')))
    expect(hrefs.every((h) => h === '/targets/campaigns/affiliate'), `mục chiến dịch ngoài Affiliate: ${hrefs.join(', ')}`).toBe(true)
    test.info().annotations.push({ type: 'ui-nav', description: `MKT admin: ${hrefs.length ? 'link đơn Affiliate (phòng được cấp quyền)' : 'không mục chiến dịch (admin thường)'}` })
    for (const route of ['/targets/campaigns', ...(CMS_ON ? ['/targets/campaigns/cms'] : [])]) {
      await page.goto(route)
      await expect(page.locator('main').getByText('This page could not be found.'), `${route}: admin không super phải 404`).toBeVisible({ timeout: 15_000 })
    }
    if (hrefs.length) {
      await page.goto('/targets/campaigns/affiliate')
      await expect(page.locator('#sidebar-nav a[aria-current="page"]')).toHaveAttribute('href', '/targets/campaigns/affiliate')
      await expect(page.locator('main [data-campaigns-tabs]'), 'admin phòng: trang Affiliate không có hàng tab').toHaveCount(0)
    }
  })
})
