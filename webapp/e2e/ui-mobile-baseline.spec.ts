import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'

// ─────────────────────────────────────────────────────────────────────────────
// BASELINE MOBILE STAFF (M0-a) — ảnh TRƯỚC của batch Mobile Staff
//
// Bốn màn staff (/tasks · /targets · /prescriptions · /announcements) × ba
// viewport (360 · 390 · 430), mỗi màn hai tấm: đầu trang và CUỐI trang (đã cuộn
// hết) để nhìn thấy bottom nav đè lên phần tử cuối. Ảnh dùng để so trước/sau khi
// M1-M3 đổi nav + header + chi tiết toa.
//
// ── MỖI MÀN MỘT TEST (capture isolation) ────────────────────────────────────
// Bài học e2e/ui-review-shots.spec.ts: gộp nhiều màn vào một test thì một màn
// hỏng là mất sạch ảnh của các màn sau. Đây KHÔNG phải snapshot so sánh —
// `page.screenshot({ path })` luôn ghi đè, không có ngưỡng diff, nên ảnh cũ
// không thể giả làm bằng chứng "sau khi sửa".
//
// ── CHẠY DƯỚI PROJECT NÀO ───────────────────────────────────────────────────
// playwright.config.ts: `mobile-390` VÀ `mobile-360` cùng grep /@mobile/. Tag
// @mobile ⇒ mọi test chạy HAI lần, hai worker ghi đè cùng một đường dẫn ảnh
// (đua ghi file) và tốn gấp đôi thời gian login — trong khi test tự set viewport
// nên hai project cho ra ảnh y hệt. Vì vậy: giữ tag @mobile (context điện thoại
// thật: isMobile/hasTouch/không có thanh cuộn chiếm chỗ) nhưng CHỈ chụp dưới
// `mobile-390`, project kia skip tường minh. Không thêm project mới vào config.
//
// ── CHẠY ────────────────────────────────────────────────────────────────────
// 1) Dựng server từ chính branch đang review:
//      cd webapp && npm run build && PORT=3010 npm start
// 2) Terminal khác:
//      E2E_BASE_URL=http://localhost:3010 \
//      E2E_STAFF_EMAIL=… E2E_STAFF_PASSWORD=… \
//      npx playwright test e2e/ui-mobile-baseline.spec.ts --project=mobile-390
// playwright.config.ts KHÔNG nạp .env.local (không dotenv, không globalSetup) ⇒
// phải export biến ở shell. Thiếu credential thì skip, không đỏ.
//
// ── ẢNH RA ĐÂU ──────────────────────────────────────────────────────────────
// docs/ui/mobile-baseline/ — ĐÃ CHO VÀO .gitignore (root). Ảnh chụp dữ liệu
// thật: tên/email nhân viên, tên khách trên toa ⇒ TUYỆT ĐỐI KHÔNG commit.
// ─────────────────────────────────────────────────────────────────────────────

const EMAIL = process.env.E2E_STAFF_EMAIL
const PASSWORD = process.env.E2E_STAFF_PASSWORD
const OUT_DIR = process.env.UI_MOBILE_BASELINE_DIR
  ?? path.join(__dirname, '..', '..', 'docs', 'ui', 'mobile-baseline')

// Project duy nhất được phép chụp (xem khối "CHẠY DƯỚI PROJECT NÀO" ở trên).
const CAPTURE_PROJECT = 'mobile-390'

// Ba bề ngang thật của máy staff đang dùng; chiều cao lấy đúng tỉ lệ máy đó để
// số lần cuộn trong ảnh giống thực tế.
const VIEWPORTS = [
  { w: 360, h: 800 }, // Android phổ thông (Galaxy A / Redmi) — hẹp nhất
  { w: 390, h: 844 }, // iPhone 12/13/14
  { w: 430, h: 932 }, // iPhone 14/15 Pro Max
] as const

const ROUTES = [
  { name: 'tasks',         path: '/tasks' },
  { name: 'targets',       path: '/targets' },
  { name: 'prescriptions', path: '/prescriptions' },
  { name: 'announcements', path: '/announcements' },
] as const

// Bottom nav: <nav aria-label> là hợp đồng ổn định (e2e/staff-mobile-nav.spec.ts
// đã dùng). "Pill" = div con trực tiếp — phần TÔ MÀU thật sự che nội dung; thẻ
// <nav> ngoài cùng trải hết đáy màn và `pointer-events-none`, đo nó thì mọi
// trang đều "bị che". M1 dựng nút giữa nổi vẫn giữ cấu trúc nav > div này.
const NAV = 'nav[aria-label="Điều hướng chính"]'
const NAV_PILL = `${NAV} > div`

// Login: nguyên pattern e2e/staff-mobile-nav.spec.ts (cùng tài khoản staff).
async function login(page: Page) {
  await page.goto('/login')
  await page.fill('#email', EMAIL!)
  await page.fill('#password', PASSWORD!)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL(/\/(tasks|dashboard|targets)/, { timeout: 20_000 })
}

// Chụp đúng khung viewport (KHÔNG fullPage): cần thấy bottom nav nằm đâu so với
// nội dung, ảnh fullPage duỗi thẳng cả trang thì mất chính thông tin đó.
async function shot(page: Page, name: string) {
  await page.evaluate(() => {
    document.querySelectorAll('nextjs-portal').forEach((el) => { (el as HTMLElement).style.display = 'none' })
  })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(250)
  await page.screenshot({ path: path.join(OUT_DIR, name) })
}

// Đổi viewport là đổi layout — chờ hai frame cho reflow xong rồi mới đo/chụp.
async function settle(page: Page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
}

// Vùng cuộn của app là <main> (overflow-y-auto trong khung h-[100dvh]), KHÔNG
// phải window — cuộn window ở đây không nhúc nhích gì.
async function scrollMain(page: Page, to: 'top' | 'bottom') {
  await page.evaluate((where) => {
    const main = document.querySelector('main')
    if (main) main.scrollTop = where === 'top' ? 0 : main.scrollHeight
  }, to)
  await settle(page)
}

async function expectNoHorizontalOverflow(page: Page, where: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow, `${where}: trang cuộn ngang ${overflow}px`).toBeLessThanOrEqual(1)
}

// Phần tử cuối cùng của <main> KHÔNG được nằm dưới mép trên của pill — đo SAU
// KHI đã cuộn hết xuống (lúc đó phần tử cuối ở vị trí thấp nhất trên màn hình).
// Đây chính là invariant mà padding-bottom của <main> phải bảo đảm; M0-b token
// hoá nó (--bottom-nav-clearance) nên test này canh cả hai đầu: đổi chiều cao
// nav mà quên đổi inset thì đỏ ở đây.
async function expectLastElementNotUnderNav(page: Page, where: string) {
  const geom = await page.evaluate((pillSel) => {
    const main = document.querySelector('main')
    const pill = document.querySelector(pillSel)
    if (!main || !pill) return null
    const last = [...main.children]
      .filter((el) => el.getBoundingClientRect().height > 0)
      .pop()
    if (!last) return null
    return {
      lastBottom: last.getBoundingClientRect().bottom,
      lastDesc: `${last.tagName.toLowerCase()}.${(last.className || '').toString().split(' ').slice(0, 3).join('.')}`,
      pillTop: pill.getBoundingClientRect().top,
    }
  }, NAV_PILL)

  expect(geom, `${where}: không đo được (thiếu <main>, pill nav, hoặc main rỗng)`).not.toBeNull()
  expect(
    geom!.lastBottom,
    `${where}: phần tử cuối (${geom!.lastDesc}) chạm đáy ${geom!.lastBottom}px, bị bottom nav (mép trên ${geom!.pillTop}px) che`,
  ).toBeLessThanOrEqual(geom!.pillTop)
}

test.describe('baseline mobile staff @mobile', () => {
  test.skip(!EMAIL || !PASSWORD, 'E2E_STAFF_EMAIL / E2E_STAFF_PASSWORD chưa set')

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== CAPTURE_PROJECT, `chỉ chụp dưới project ${CAPTURE_PROJECT}`)
    test.setTimeout(150_000)
    await login(page)
  })

  for (const route of ROUTES) {
    test(`${route.name} — 360/390/430`, async ({ page }) => {
      await page.goto(route.path)
      await expect(page, `${route.path}: bị redirect ⇒ tài khoản chụp không phải staff OS?`)
        .toHaveURL(new RegExp(`${route.path.replace(/\//g, '\\/')}(\\?|$)`))

      const nav = page.locator(NAV)

      for (const vp of VIEWPORTS) {
        const where = `${route.path} @${vp.w}`
        await page.setViewportSize({ width: vp.w, height: vp.h })
        await settle(page)
        await scrollMain(page, 'top')

        // Ba assert nền — nếu một trong ba sai thì tấm ảnh đang mô tả một màn
        // hình hỏng, không dùng để so trước/sau được.
        await expect(nav, `${where}: không thấy bottom nav`).toBeVisible()
        await expectNoHorizontalOverflow(page, where)

        await shot(page, `${route.name}-${vp.w}-top.png`)

        await scrollMain(page, 'bottom')
        // Chụp TRƯỚC, assert SAU: nếu clearance sai thì vẫn còn tấm ảnh làm
        // bằng chứng thay vì mất cả hai.
        await shot(page, `${route.name}-${vp.w}-bottom.png`)
        await expectLastElementNotUnderNav(page, where)
      }
    })
  }
})
