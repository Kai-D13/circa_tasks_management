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

// ─── COPY NGUYÊN VĂN từ components/affiliate/AffiliateGmvCard.tsx ───────────
// Không diễn giải lại, không viết tắt: nếu copy bên component đổi thì các assert
// dưới phải ĐỎ (chuỗi không còn khớp), chứ không được âm thầm bỏ qua. Gom một
// chỗ để lần sau sửa component là biết ngay phải sửa cái gì ở đây.
const CARD_TITLE = 'GMV Affiliate — Circa Online'
// Nhánh sourceWarning: `Nguồn dữ liệu chưa sẵn sàng: {reason} — số liệu tạm ẩn`
// (bản strip) / `Nguồn dữ liệu chưa sẵn sàng: {reason}` (bản card). Lý do là
// biến ⇒ chỉ khớp phần tĩnh đầu chuỗi.
const MSG_SOURCE_NOT_READY = 'Nguồn dữ liệu chưa sẵn sàng:'
// Nhánh error (RPC lỗi, kể cả fail-closed thiếu completed_time).
const MSG_LOAD_ERROR = 'Không tải được dữ liệu Affiliate. Vui lòng thử lại sau hoặc báo Admin.'

// Nhãn 3 ô của dải, đúng thứ tự render trong `stats` của AffiliateGmvCard. Map
// giá trị ↔ regex BẰNG NHÃN chứ không bằng index: strip đổi thứ tự cột (chuyện
// layout, xảy ra thật ở r2.4/r2.7) không được biến assert "tiền" thành assert
// "số đơn" mà vẫn xanh.
const STRIP_FIELDS = [
  {
    label: 'GMV Affiliate',
    // Tiền VN: nhóm nghìn bằng dấu chấm + ₫ (Intl vi-VN), vd "10.218.500₫".
    re: /^[\d.]+₫$/,
    want: 'số tiền dạng "10.218.500₫"',
  },
  {
    label: 'Đơn thành công',
    // nf.format(orders) — số nguyên, có thể có dấu chấm ngăn nghìn.
    re: /^[\d.]+$/,
    want: 'một con số, vd "1.204"',
  },
  {
    label: 'Store có doanh số',
    // `${storesWithSales}/${storeCount}` — phải có MẪU SỐ: nhánh thiếu storeCount
    // chỉ in tử số, khi đó ảnh review mất ngữ cảnh "bao nhiêu trên tổng bao nhiêu".
    re: /^\d+\/\d+$/,
    want: 'dạng "X/Y", vd "12/23"',
  },
] as const

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
// màn TIỀN, một chữ số mất là sai số liệu.
//
// r2.8 (auditor P1) — TRƯỚC KHI ĐO KÍCH THƯỚC, PHẢI CÓ SỐ THẬT ĐỂ ĐO.
// AffiliateGmvCard fail-closed: `blocked = error || sourceWarning !== null` ⇒ cả
// ba ô in '—'. Phiên bản cũ chỉ đòi "có > 0 phần tử" rồi so scrollWidth, mà một
// dấu '—' thì đời nào tràn ⇒ test XANH trong khi dải Affiliate không có lấy một
// con số nào. Đó là false-pass đúng nghĩa: bộ ảnh review được đóng dấu "đã
// chứng minh không cụt số" bằng một tấm ảnh toàn dấu gạch.
//
// Vì vậy test này CHỦ ĐÍCH ĐỎ khi nguồn Affiliate không READY. Nguồn READY là
// ĐIỀU KIỆN TIÊN QUYẾT của cả bộ ảnh, không phải môi trường tuỳ hoàn cảnh: ảnh
// strip toàn '—' vô giá trị với stakeholder — họ duyệt cách trình bày SỐ TIỀN,
// không duyệt trạng thái rỗng. Đỏ ở đây = "đi sửa/đợi nguồn rồi chụp lại", chứ
// không phải "nới assert".
async function expectStripValuesNotClipped(page: Page, where: string) {
  // (1) Không có thông báo fail-closed nào trên trang. `toHaveCount(0)` chặt hơn
  // `not.toBeVisible()` (không dính strict-mode nếu lỡ render nhiều card) và
  // cũng bắt luôn ca thông báo bị ẩn bằng CSS.
  await expect(page.getByText(MSG_SOURCE_NOT_READY),
    `${where}: card Affiliate đang báo "${MSG_SOURCE_NOT_READY} …" ⇒ health nguồn chưa READY, số liệu bị ẩn ('—'). Không chụp/duyệt được — chờ sync xong rồi chạy lại.`)
    .toHaveCount(0)
  await expect(page.getByText(MSG_LOAD_ERROR),
    `${where}: card Affiliate đang báo lỗi tải dữ liệu ⇒ RPC hỏng, số liệu bị ẩn ('—').`)
    .toHaveCount(0)

  // (2) Đúng BA ô — không nhiều, không ít. Ít hơn = mất chỉ số; nhiều hơn =
  // trang render hai card Affiliate và phép đo dưới đang trộn hai nguồn.
  const valueLoc = page.locator('[data-affiliate-strip] [data-affiliate-stat-value]')
  await expect(valueLoc,
    `${where}: dải Affiliate phải có ĐÚNG 3 ô giá trị (GMV · Đơn thành công · Store có doanh số)`)
    .toHaveCount(3)

  // Lấy kèm NHÃN của từng ô (thẻ <p> anh em, không mang data-affiliate-stat-value)
  // để map theo nhãn thay vì theo vị trí.
  const cells = await page.$$eval(
    '[data-affiliate-strip] [data-affiliate-stat-value]',
    (els) => els.map((el) => ({
      label: (el.parentElement?.querySelector('p:not([data-affiliate-stat-value])')?.textContent ?? '').trim(),
      text: (el.textContent ?? '').trim(),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    })),
  )

  // (3) Từng ô: khác '—' và đúng ĐỊNH DẠNG của chính chỉ số đó.
  for (const field of STRIP_FIELDS) {
    const cell = cells.find((c) => c.label.normalize('NFC') === field.label.normalize('NFC'))
    expect(cell,
      `${where}: không thấy ô "${field.label}" trong dải Affiliate (nhãn đã đổi bên AffiliateGmvCard? nhãn đọc được: ${cells.map((c) => `"${c.label}"`).join(', ')})`)
      .toBeTruthy()
    expect(cell!.text,
      `${where}: ô "${field.label}" đang là '—' ⇒ nguồn Affiliate fail-closed, chưa có số thật nào để duyệt.`)
      .not.toBe('—')
    expect(cell!.text,
      `${where}: ô "${field.label}" = "${cell!.text}", mong đợi ${field.want}`)
      .toMatch(field.re)
  }

  // (4) CHỈ KHI đã chắc là số thật mới đo cắt chữ — đo trên '—' thì phép đo vô
  // nghĩa. `scrollWidth > clientWidth` = nội dung rộng hơn ô, tức đang bị cắt
  // (đúng phép thử mà e2e/ui-pilot-capture.spec.ts dùng để CHỨNG MINH truncate).
  // Cộng 1px dung sai cho làm tròn sub-pixel của layout engine.
  for (const c of cells) {
    expect(c.scrollWidth,
      `${where}: giá trị "${c.text}" (${c.label}) bị cắt (nội dung ${c.scrollWidth}px > ô ${c.clientWidth}px)`)
      .toBeLessThanOrEqual(c.clientWidth + 1)
  }
  const docOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(docOverflow, `${where}: document cuộn ngang`).toBeLessThanOrEqual(1)
}

// r2.8 (auditor P2) — CỔNG TRƯỚC MỖI TẤM ẢNH, cho MỌI role (Admin/SM/QLCH/Super),
// không riêng SM. Một tấm ảnh chỉ dùng được để duyệt UI khi cái khung của nó
// đúng: có sidebar, đúng MỘT mục nav sáng, và trang không cuộn ngang. Thiếu một
// trong ba thì ảnh đang mô tả một màn hình khác với màn hình thật.
async function expectShellReady(page: Page, where: string) {
  await expect(aside(page), `${where}: không thấy sidebar trong khung ảnh`).toBeVisible()
  // Contract Sidebar: `resolveActiveHref` chọn ĐÚNG MỘT href ⇒ đúng một
  // aria-current="page". 0 = nav không nhận ra route (ảnh chụp trang "mồ côi"),
  // >1 = hai hàng cùng sáng.
  await expect(page.locator('aside a[aria-current="page"]'),
    `${where}: sidebar phải có ĐÚNG 1 mục đang active (aria-current="page")`)
    .toHaveCount(1)
  const docOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(docOverflow, `${where}: document cuộn ngang ${docOverflow}px ⇒ ảnh sẽ thiếu phần bên phải`)
    .toBeLessThanOrEqual(1)
}

// SM/QLCH: đúng component cần duyệt PHẢI có mặt. Không có nó thì tấm ảnh vẫn là
// một trang /targets hợp lệ — và hoàn toàn vô dụng với người duyệt dải Affiliate.
async function expectAffiliateCardVisible(page: Page, where: string) {
  await expect(page.getByText(CARD_TITLE).first(),
    `${where}: không thấy card "${CARD_TITLE}" ⇒ tài khoản chụp ngoài phạm vi Affiliate hoặc card bị gate ẩn.`)
    .toBeVisible()
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
    await expectShellReady(page, 'SM /targets @1440 (sidebar mở)')
    await expectAffiliateCardVisible(page, 'SM /targets @1440 (sidebar mở)')
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
    await expectShellReady(page, 'SM /targets @1920 (sidebar thu gọn)')
    await expectAffiliateCardVisible(page, 'SM /targets @1920 (sidebar thu gọn)')
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
    await expectShellReady(page, 'QLCH /targets @1440 light')
    await expectAffiliateCardVisible(page, 'QLCH /targets @1440 light')
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
    await expectShellReady(page, 'QLCH /targets @1440 dark')
    await expectAffiliateCardVisible(page, 'QLCH /targets @1440 dark')
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
    // Admin/tasks không có card Affiliate ⇒ chỉ cổng khung ảnh.
    await expectShellReady(page, 'Admin /tasks @1366 (sidebar mở)')
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
    // Super không có card Affiliate trên màn này; cổng khung ảnh vẫn áp dụng —
    // 2560 chính là dải viewport stakeholder khiếu nại nên "không cuộn ngang"
    // phải được KHẲNG ĐỊNH, không suy ra từ mắt nhìn tấm ảnh.
    await expectShellReady(page, 'Super /targets/campaigns @2560')
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
