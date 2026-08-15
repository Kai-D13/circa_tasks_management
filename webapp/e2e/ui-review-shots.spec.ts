import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

// ─────────────────────────────────────────────────────────────────────────────
// BỘ CHỤP ẢNH REVIEW r2 CHO STAKEHOLDER (yêu cầu auditor r2.7)
//
// Sáu ảnh, mỗi ảnh MỘT test, mỗi role MỘT bộ credential riêng. Không phải
// snapshot so sánh: `page.screenshot({ path })` LUÔN ghi đè, không có ngưỡng
// diff nào — ảnh cũ không thể giả làm bằng chứng "sau khi sửa" (bài học
// e2e/ui-pilot-capture.spec.ts). Chụp VIEWPORT (không `fullPage`): người duyệt
// cần thấy sidebar + nội dung đúng khung màn hình, không phải một dải dọc dài.
//
// ── CHẠY ────────────────────────────────────────────────────────────────────
// 1) Dựng server TỪ CHÍNH BRANCH đang review (đừng chụp trên server cũ):
//      cd webapp && npm run build && PORT=3010 npm start
// 2) Chạy spec ở terminal KHÁC:
//      E2E_BASE_URL=http://localhost:3010 \
//      E2E_SM_EMAIL=… E2E_SM_PASSWORD=… \
//      E2E_QLCH_EMAIL=… E2E_QLCH_PASSWORD=… \
//      E2E_ADMIN_EMAIL=… E2E_ADMIN_PASSWORD=… \
//      E2E_SUPER_EMAIL=… E2E_SUPER_PASSWORD=… \
//      npx playwright test e2e/ui-review-shots.spec.ts
//
// QUAN TRỌNG — playwright.config.ts KHÔNG tự nạp .env.local: config không
// import dotenv và không có globalSetup, nó chỉ đọc `process.env.E2E_BASE_URL`.
// Next.js đọc .env.local cho TIẾN TRÌNH SERVER, còn tiến trình playwright thì
// không thấy gì cả ⇒ 8 biến trên phải export ở shell (hoặc thêm dotenv vào
// config sau này). Thiếu bộ env của role nào thì ĐÚNG các test của role đó
// skip, các role khác vẫn chạy — không có test nào đỏ vì thiếu credential.
//
// ── ẢNH RA ĐÂU ──────────────────────────────────────────────────────────────
// docs/ui/review-r2/ — ĐÃ CHO VÀO .gitignore. Ảnh có tên/email người thật
// (sidebar footer, cột người thực hiện) ⇒ TUYỆT ĐỐI KHÔNG commit; gửi
// stakeholder qua kênh nội bộ.
// ─────────────────────────────────────────────────────────────────────────────

const OUT_DIR = process.env.UI_REVIEW_DIR ?? path.join(__dirname, '..', '..', 'docs', 'ui', 'review-r2')

type Cred = { email?: string; password?: string }
const SM: Cred = { email: process.env.E2E_SM_EMAIL, password: process.env.E2E_SM_PASSWORD }
const QLCH: Cred = { email: process.env.E2E_QLCH_EMAIL, password: process.env.E2E_QLCH_PASSWORD }
const ADMIN: Cred = { email: process.env.E2E_ADMIN_EMAIL, password: process.env.E2E_ADMIN_PASSWORD }
const SUPER: Cred = { email: process.env.E2E_SUPER_EMAIL, password: process.env.E2E_SUPER_PASSWORD }
const missing = (c: Cred) => !c.email || !c.password

// Hình học sidebar r2 — pixel literal, giống e2e/sidebar-r2.spec.ts.
const W_EXPANDED = 232
const W_COLLAPSED = 64
const TOL = 1

// Login lấy nguyên pattern của e2e/sidebar-r2.spec.ts: fill → verify → submit →
// chờ redirect, bọc trong toPass, vì hydration dưới tải có thể reset input SAU
// khi fill (nhìn như đã thành công rồi mới rơi).
async function login(page: Page, who: Cred) {
  await page.goto('/login')
  await page.waitForLoadState('networkidle')
  await expect(async () => {
    await page.fill('#email', who.email!)
    await page.fill('#password', who.password!)
    await page.waitForTimeout(150)
    expect(await page.inputValue('#email')).toBe(who.email)
    expect(await page.inputValue('#password')).toBe(who.password)
    await page.getByRole('button', { name: /sign in/i }).click()
    await page.waitForURL(/\/(tasks|dashboard|targets|fs)/, { timeout: 10_000, waitUntil: 'commit' })
  }).toPass({ timeout: 60_000, intervals: [1_000, 2_000, 3_000] })
}

// Theme: localStorage `theme` + reload, KHÔNG dùng emulateMedia — ThemeProvider
// dựng next-themes với attribute="class" + enableSystem={false} nên app không
// hề đọc prefers-color-scheme (cùng lý do đã ghi ở e2e/sidebar-r2.spec.ts).
async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction(
    (t) => document.documentElement.classList.contains('dark') === (t === 'dark'),
    theme, { timeout: 10_000 },
  )
}

async function gotoRoute(page: Page, route: string, heading: string) {
  await page.goto(route)
  await expect(page, `${route}: bị redirect ⇒ tài khoản dùng để chụp thiếu quyền?`)
    .toHaveURL(new RegExp(`${route.replace(/\//g, '\\/')}(\\?|$)`))
  await page.waitForFunction(
    (h) => [...document.querySelectorAll('h1')].some((el) => (el.textContent ?? '').normalize('NFC').toLowerCase().includes(h)),
    heading.normalize('NFC').toLowerCase(), { timeout: 15_000 },
  )
}

const aside = (page: Page) => page.locator('aside')
// Nút thu gọn nhận diện bằng `aria-controls` chứ không bằng aria-label: nhãn
// ĐỔI theo trạng thái (xem e2e/sidebar-r2.spec.ts).
const toggle = (page: Page) => page.locator('aside button[aria-controls="sidebar-nav"]')

// Chờ bề rộng aside ỔN ĐỊNH: `transition-[width] duration-200` nên một mẫu đo
// ngay sau click có thể bắt được giá trị giữa chừng. Mỗi vòng poll lấy HAI mẫu
// cách nhau 1 frame ngay trong trang, chỉ chấp nhận khi hai mẫu bằng nhau.
async function expectAsideWidth(page: Page, expected: number, label: string) {
  await expect(async () => {
    const [a, b] = await aside(page).evaluate(
      (el) => new Promise<[number, number]>((resolve) => {
        const first = el.getBoundingClientRect().width
        requestAnimationFrame(() => requestAnimationFrame(
          () => resolve([first, el.getBoundingClientRect().width]),
        ))
      }),
    )
    expect(Math.abs(b - a), `${label}: bề rộng còn đang chạy transition (${a} → ${b})`).toBeLessThan(0.5)
    expect(Math.abs(b - expected), `${label}: aside ${b}px, mong đợi ${expected}±${TOL}`).toBeLessThanOrEqual(TOL)
  }).toPass({ timeout: 10_000, intervals: [100, 150, 250] })
}

// Đưa sidebar về đúng trạng thái cần chụp. Context mới không có cookie
// `sidebar_collapsed` nên mặc định là mở rộng, nhưng vẫn đo trước rồi mới bấm:
// test chụp ảnh không được phụ thuộc vào giả định trạng thái. Sau khi bấm phải
// rời chuột khỏi nút — ở trạng thái thu gọn nút có IconTooltip, con trỏ nằm lại
// đó sẽ bung tooltip vào đúng tấm ảnh.
async function ensureCollapsed(page: Page, want: boolean) {
  const width = await aside(page).evaluate((el) => el.getBoundingClientRect().width)
  const isCollapsed = Math.abs(width - W_COLLAPSED) <= TOL
  if (isCollapsed !== want) {
    await toggle(page).click()
    await page.mouse.move(1_100, 600)
  }
  await expectAsideWidth(page, want ? W_COLLAPSED : W_EXPANDED, want ? 'sidebar thu gọn' : 'sidebar mở rộng')
}

// Chụp đúng khung viewport. Ẩn overlay của Next dev (nếu chạy `npm run dev`)
// để nó không đóng dấu vào ảnh gửi stakeholder; chờ font xong để chữ không bị
// bắt ở trạng thái fallback (ảnh sẽ khác hẳn về nhịp chữ).
async function shot(page: Page, name: string) {
  await page.evaluate(() => {
    document.querySelectorAll('nextjs-portal').forEach((el) => { (el as HTMLElement).style.display = 'none' })
  })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(250)
  await page.screenshot({ path: path.join(OUT_DIR, name) })
}

// BẰNG CHỨNG "không có dấu …" mà auditor đòi (r2.7 P1): dải GMV Affiliate là
// màn TIỀN, một chữ số mất là sai số liệu. Đo trực tiếp trên phần tử giá trị —
// `scrollWidth > clientWidth` nghĩa là nội dung rộng hơn ô, tức đang bị cắt
// (đúng phép thử mà e2e/ui-pilot-capture.spec.ts dùng để CHỨNG MINH truncate).
// Cộng 1px dung sai cho làm tròn sub-pixel của layout engine.
async function expectStripValuesNotClipped(page: Page, where: string) {
  const values = await page.$$eval(
    '[data-affiliate-strip] [data-affiliate-stat-value]',
    (els) => els.map((el) => ({
      text: (el.textContent ?? '').trim(),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    })),
  )
  expect(values.length,
    `${where}: không thấy phần tử giá trị nào của dải Affiliate ⇒ tài khoản E2E_SM_* không có GMV Affiliate (nguồn chưa READY / ngoài phạm vi OS)? Không có gì để chứng minh.`)
    .toBeGreaterThan(0)
  for (const v of values) {
    expect(v.scrollWidth,
      `${where}: giá trị "${v.text}" bị cắt (nội dung ${v.scrollWidth}px > ô ${v.clientWidth}px)`)
      .toBeLessThanOrEqual(v.clientWidth + 1)
  }
  const docOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(docOverflow, `${where}: document cuộn ngang`).toBeLessThanOrEqual(1)
}

test.describe('ảnh review r2 @desktop', () => {
  // 1 ── SM, /targets, 1440×900, sidebar mở, light.
  test('sm-targets-1440-expanded-light', async ({ page }) => {
    test.skip(missing(SM), 'E2E_SM_* chưa set')
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    await login(page, SM)
    await setTheme(page, 'light')
    await gotoRoute(page, '/targets', 'doanh số')
    await ensureCollapsed(page, false)
    await shot(page, 'sm-targets-1440-expanded-light.png')
    // Chụp TRƯỚC, assert SAU: nếu dải Affiliate lệch thì vẫn còn tấm ảnh làm
    // bằng chứng thay vì mất cả hai.
    await expectStripValuesNotClipped(page, 'SM /targets @1440 (sidebar mở)')
  })

  // 2 ── SM, /targets, 1920×900, sidebar THU GỌN (bấm nút, chờ 64px ổn định).
  test('sm-targets-1920-collapsed-light', async ({ page }) => {
    test.skip(missing(SM), 'E2E_SM_* chưa set')
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 1920, height: 900 })
    await login(page, SM)
    await setTheme(page, 'light')
    await gotoRoute(page, '/targets', 'doanh số')
    await ensureCollapsed(page, true)
    await shot(page, 'sm-targets-1920-collapsed-light.png')
    await expectStripValuesNotClipped(page, 'SM /targets @1920 (sidebar thu gọn)')
  })

  // 3 ── Store Manager (QLCH), /targets, 1440×900, light.
  test('qlch-targets-1440-light', async ({ page }) => {
    test.skip(missing(QLCH), 'E2E_QLCH_* chưa set')
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    await login(page, QLCH)
    await setTheme(page, 'light')
    await gotoRoute(page, '/targets', 'doanh số')
    await shot(page, 'qlch-targets-1440-light.png')
  })

  // 4 ── Store Manager (QLCH), /targets, 1440×900, DARK.
  test('qlch-targets-1440-dark', async ({ page }) => {
    test.skip(missing(QLCH), 'E2E_QLCH_* chưa set')
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    await login(page, QLCH)
    await setTheme(page, 'dark')
    await gotoRoute(page, '/targets', 'doanh số')
    await shot(page, 'qlch-targets-1440-dark.png')
    // Trả theme về light: context bị huỷ sau test, nhưng nếu ai đó chạy spec
    // này với storageState dùng chung thì tấm dark sẽ rò sang test khác.
    await page.evaluate(() => localStorage.setItem('theme', 'light'))
  })

  // 5 ── Admin thường, /tasks, 1366×768 (laptop 13" phổ biến nhất), sidebar mở.
  test('admin-tasks-1366x768-expanded', async ({ page }) => {
    test.skip(missing(ADMIN), 'E2E_ADMIN_* chưa set')
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 1366, height: 768 })
    await login(page, ADMIN)
    await setTheme(page, 'light')
    await gotoRoute(page, '/tasks', 'danh sách tasks')
    await ensureCollapsed(page, false)
    await shot(page, 'admin-tasks-1366x768-expanded.png')
  })

  // 6 ── Super, /targets/campaigns, 2560×1000 (zoom-out 60% trên màn 1440 —
  // đúng dải viewport mà stakeholder khiếu nại dải trắng bên phải).
  test('super-campaigns-2560', async ({ page }) => {
    test.skip(missing(SUPER), 'E2E_SUPER_* chưa set')
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 2560, height: 1000 })
    await login(page, SUPER)
    await setTheme(page, 'light')
    await gotoRoute(page, '/targets/campaigns', 'chiến dịch kpi')
    await shot(page, 'super-campaigns-2560.png')
  })

  // 7 ── Contract r2.7 (không chụp ảnh): số tiền trong dải Affiliate KHÔNG bao
  // giờ cụt, ở đúng dải viewport hẹp nơi cụm 3 chỉ số phải xuống hàng riêng.
  // 768 = md vừa bật (sidebar 232px xuất hiện ⇒ chỗ cho nội dung hụt đột ngột,
  // đây là ca xấu nhất), 1024 = lg, 1366 = laptop phổ biến nhất.
  test('sm-strip-no-clip', async ({ page }) => {
    test.skip(missing(SM), 'E2E_SM_* chưa set')
    test.setTimeout(120_000)
    await login(page, SM)
    await setTheme(page, 'light')
    await gotoRoute(page, '/targets', 'doanh số')
    for (const width of [768, 1024, 1366]) {
      await page.setViewportSize({ width, height: 900 })
      // Đổi viewport là đổi layout — chờ một frame để reflow xong rồi mới đo.
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
      await expectStripValuesNotClipped(page, `SM /targets @${width}`)
    }
  })
})
