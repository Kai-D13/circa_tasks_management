import { test, expect, type Page } from '@playwright/test'

// UI-program ROUTE-SHELL baseline (Phase 0 r2) — LOCAL-ONLY, gitignored:
// screenshots chứa dữ liệu PRODUCTION (PII) nên KHÔNG BAO GIỜ commit (r2A).
// Shell = header/toolbar/tabs/pagination-frame; vùng DATA bị mask toàn bộ.
// Regression dài hạn thật sự = component catalog /__ui với fixtures (Phase 1).
// - Theme DETERMINISTIC: set localStorage.theme rồi verify class html.dark
//   trước khi chụp; tên snapshot chứa theme (light/dark).
// - Stable wait: heading đặc trưng TỪNG ROUTE (không networkidle, không
//   fixed-timeout làm điều kiện chính).
// - Mask (r2/r2.1): TOÀN BỘ vùng data (tbody + list rows) + tên user ở header
//   (PII) + badge đếm — GIỮ visible shell/toolbar/tabs/action UI; không mask
//   nguyên header.
// - SHELL-CLIP screenshot (r2.2): chụp dải TRÊN ổn định (header/tabs/toolbar/
//   table-header) — mask không chống được LAYOUT SHIFT khi số row đổi (drift
//   gate bắt được: dải đỏ mép dưới tbody + badge sidebar). Pagination frame
//   giao cho CATALOG snapshot (regression chính, fixtures cố định).
// Tạo baseline: `npm run build; npm start` (PowerShell — `&&` không tồn tại
// trong Windows PowerShell 5.1), rồi chạy với --update-snapshots;
// gate Phase 0 = chạy lần 2 KHÔNG flag → no-diff toàn bộ projects.
// Env: E2E_STAFF_EMAIL/PASSWORD + E2E_SUPER_EMAIL/PASSWORD (thiếu → skip).

const STAFF = { email: process.env.E2E_STAFF_EMAIL, password: process.env.E2E_STAFF_PASSWORD }
const SUPER = { email: process.env.E2E_SUPER_EMAIL, password: process.env.E2E_SUPER_PASSWORD }
const THEMES = ['light', 'dark'] as const

// route → heading substring (stable locator). So sánh sau khi normalize('NFC')
// — chuỗi tiếng Việt NFD/NFC khác codepoint dù nhìn giống nhau (bẫy run 1).
// [route, heading, maskSelector?] — maskSelector BỔ SUNG theo route (ngoài
// DATA_MASKS toàn cục) cho vùng động đặc thù.
const STAFF_ROUTES: [string, string, string?][] = [
  ['/tasks', 'Danh sách Tasks'],
  ['/prescriptions', 'Toa thuốc'],
  ['/targets', 'Doanh số'],
  ['/announcements', 'Bảng tin'],
  ['/inventory', 'Tồn kho'],
]
const SUPER_ROUTES: [string, string, string?][] = [
  ['/dashboard', 'Tổng quan'],
  ['/tasks', 'Danh sách Tasks'],
  ['/stores', 'Danh sách cửa hàng'],
  ['/users', 'Người dùng'],
  ['/logs', 'Nhật ký hoạt động', 'main tbody'],
  ['/prescriptions', 'Toa thuốc'],
  ['/fs/products', 'Quản lý FS · Sản phẩm'],
  ['/targets/campaigns', 'Chiến dịch KPI'],
]

async function login(page: Page, email: string, password: string) {
  await page.goto('/login')
  await page.fill('#email', email)
  await page.fill('#password', password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL(/\/(tasks|dashboard|targets|fs)/, { timeout: 20_000 })
}

async function setTheme(page: Page, theme: (typeof THEMES)[number]) {
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
}

// Vùng data mask MỌI route: bảng (tbody) + list rows (divide-y) + tên user trong
// header (PII, r2B) + badge đếm trên nav (đổi theo dữ liệu sống) — giữ shell.
const DATA_MASKS = [
  'main tbody', 'main .divide-y',            // bảng + list rows
  'main [class*="md:hidden"]',               // mobile data card lists (prescriptions…)
  'main div.grid',                           // strip/summary grids (counts = data sống)
  'header p',                                // tên user (PII)
  'nav span.absolute', 'aside span.absolute' // badge đếm (bottom-nav + sidebar)
]

async function snap(page: Page, route: string, heading: string, name: string, theme: string, maskSel?: string) {
  await page.goto(route)
  // next-themes applies the class after hydration — assert it matches the theme
  await page.waitForFunction(
    (t) => document.documentElement.classList.contains('dark') === (t === 'dark'),
    theme,
    { timeout: 10_000 },
  )
  await page.waitForFunction(
    (h) => [...document.querySelectorAll('h1')].some((el) => (el.textContent ?? '').normalize('NFC').toLowerCase().includes(h)),
    heading.normalize('NFC').toLowerCase(),
    { timeout: 15_000 },
  )
  // Hydration settle (webkit race, gate 2 caught it): header title flips from the
  // SSR fallback 'Circa Tasks' to the user's name only after the client store
  // hydrates — wait for that signal (or no header <p> at all), then fonts.
  await page.waitForFunction(() => {
    const el = document.querySelector('header p')
    return !el || (!!el.textContent && el.textContent !== 'Circa Tasks')
  }, { timeout: 10_000 })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(250) // paint settle AFTER all conditions (secondary only)
  const vp = page.viewportSize()
  const clipH = Math.min(vp?.height ?? 800, (vp?.width ?? 0) >= 768 ? 560 : 430)
  expect(await page.screenshot({
    clip: { x: 0, y: 0, width: vp?.width ?? 800, height: clipH },
    mask: [
      page.locator('header span.absolute'),                    // badge chuông
      ...DATA_MASKS.map((m) => page.locator(m)),               // vùng data (PII/drift)
      ...(maskSel ? [page.locator(maskSel)] : []),             // mask riêng theo route
    ],
  })).toMatchSnapshot(`${name}-${theme}.png`, { maxDiffPixelRatio: 0.01 })
}

test.describe('baseline staff @mobile', () => {
  test.skip(!STAFF.email || !STAFF.password, 'E2E_STAFF_* not set')
  test('staff routes light+dark', async ({ page }) => {
    test.setTimeout(240_000)
    await login(page, STAFF.email!, STAFF.password!)
    for (const theme of THEMES) {
      await setTheme(page, theme)
      for (const [r, h, m] of STAFF_ROUTES) await snap(page, r, h, `staff${r.replace(/\//g, '-')}`, theme, m)
    }
  })
})

test.describe('baseline super admin @desktop', () => {
  test.skip(!SUPER.email || !SUPER.password, 'E2E_SUPER_* not set')
  test('super routes light+dark', async ({ page }) => {
    test.setTimeout(240_000)
    await login(page, SUPER.email!, SUPER.password!)
    for (const theme of THEMES) {
      await setTheme(page, theme)
      for (const [r, h, m] of SUPER_ROUTES) await snap(page, r, h, `super${r.replace(/\//g, '-')}`, theme, m)
    }
  })
})
