import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { STAFF_STATE } from './authState'

// ─────────────────────────────────────────────────────────────────────────────
// BASELINE MOBILE STAFF (M0-a) — ảnh TRƯỚC/SAU của batch Mobile Staff
//
// Bốn màn staff (/tasks · /targets · /prescriptions · /announcements) × ba
// viewport (360 · 390 · 430), mỗi màn hai tấm: đầu trang và CUỐI trang (đã cuộn
// hết) để nhìn thấy bottom nav đè lên phần tử cuối.
//
// ── ĐĂNG NHẬP MỘT LẦN ───────────────────────────────────────────────────────
// M1.2 (audit P2). 12 test × 2 project mà mỗi test tự login ⇒ auth bắt đầu
// timeout ở /login. Giờ dùng `storageState` từ e2e/auth.setup.ts: vẫn MỘT
// CONTEXT RIÊNG cho mỗi (màn × viewport) — chỉ bỏ phần login lặp.
//
// ── MỘT TEST = MỘT (MÀN × VIEWPORT) ─────────────────────────────────────────
// M1.1 (audit P1#1). Bản trước gộp cả ba viewport vào một test và đổi
// `setViewportSize` giữa chừng. Hai vấn đề:
//   1. Đổi viewport SAU khi trang đã render là đổi layout trên một cây DOM đã
//      dựng ở bề ngang khác — không giống máy staff mở app ở đúng bề ngang đó.
//      Giờ viewport set từ lúc TẠO CONTEXT (`test.use`), trước mọi điều hướng.
//   2. Một viewport hỏng là mất ảnh của các viewport sau trong cùng test.
// Đổi lại: 12 test độc lập, mỗi test một context riêng (không login lặp — xem
// khối trên). Chậm hơn một chút, nhưng ảnh của màn này không phụ thuộc màn kia.
//
// ── GATE TRƯỚC, CHỤP SAU ────────────────────────────────────────────────────
// M1.1 (audit P1#1). Trước đây tấm "bottom" được chụp TRƯỚC khi assert clearance
// với lý do "giữ bằng chứng". Sai hướng: `page.screenshot({ path })` luôn ghi
// đè, nên một tấm chụp màn hình HỎNG sẽ nằm im trong thư mục review và được
// đọc như ảnh "sau khi sửa". Giờ mọi assert chạy trước; assert đỏ ⇒ KHÔNG có
// ảnh mới, người review thấy test đỏ thay vì một tấm ảnh nói dối.
//
// ── CHẠY DƯỚI PROJECT NÀO ───────────────────────────────────────────────────
// playwright.config.ts: `mobile-390` VÀ `mobile-360` cùng grep /@mobile/. Tag
// @mobile ⇒ mọi test chạy HAI lần, hai worker ghi đè cùng một đường dẫn ảnh
// (đua ghi file). Viewport giờ do `test.use` quyết định nên hai project cho ra
// ảnh y hệt ⇒ giữ tag @mobile (context điện thoại thật: isMobile/hasTouch)
// nhưng CHỈ chụp dưới `mobile-390`, project kia skip tường minh.
//
// ── CHẠY (PowerShell — shell của máy dev này) ───────────────────────────────
// KHÔNG dùng cú pháp Bash `PORT=3010 npm start`: PowerShell không có tiền tố
// biến môi trường trước lệnh, và `&&` cũng không tồn tại trong Windows
// PowerShell 5.1.
//
// 1) Dựng server PRODUCTION từ chính branch đang review:
//      cd C:\webapp_management\webapp
//      npm run build
//      $env:PORT='3010'; npm start
//    `output: 'standalone'` trong next.config.ts KHÔNG cản `next start` —
//    standalone chỉ là artifact THÊM cho Docker (đã verify: CSS trả 200).
//    ĐỪNG đổi sang `npm run dev`: dev-overlay, double-render của StrictMode và
//    CSS chưa tối ưu làm ảnh lệch khỏi thứ stakeholder thật sự nhìn thấy — mà
//    đây chính là bộ ảnh để họ duyệt.
//
// 2) Terminal khác:
//      cd C:\webapp_management\webapp
//      $env:E2E_BASE_URL='http://localhost:3010'
//      $env:E2E_STAFF_EMAIL='…'; $env:E2E_STAFF_PASSWORD='…'
//      npx playwright test e2e/ui-mobile-baseline.spec.ts --project=mobile-390 --workers=1
//
// Dùng localhost, KHÔNG phải 127.0.0.1 — cookie Supabase đặt cờ Secure và chỉ
// localhost mới được coi là secure context (auth.setup.ts fail sớm nếu sai).
// playwright.config.ts KHÔNG nạp .env.local (không dotenv, không globalSetup) ⇒
// phải set biến ở shell. Thiếu credential thì skip, không đỏ.
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
// đã dùng). Ranh giới che nội dung là VÙNG THỊ GIÁC của nút giữa nổi — vòng
// tròn CỘNG quầng ring — chứ không phải mép trên pill: nút nhô lên khỏi pill.
// `[data-nav-center-zone]` là hộp vô hình bao trọn vùng đó (xem NavCenterBtn).
const NAV = 'nav[aria-label="Điều hướng chính"]'
const NAV_CENTER_ZONE = '[data-nav-center-zone]'

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

// M1.1 (audit P1#1): header mobile phải CÓ MẶT và ĐỦ NỘI DUNG trong mọi tấm ảnh
// baseline. Header rỗng (profile chưa nạp) hay mất nút Tài khoản vẫn chụp ra
// một tấm ảnh "trông được" — chính là loại ảnh không nên tồn tại.
async function expectMobileHeader(page: Page, where: string) {
  const header = page.locator('header').first()
  await expect(header, `${where}: không thấy header mobile`).toBeVisible()

  await expect(
    page.getByRole('button', { name: 'Tài khoản' }),
    `${where}: mất nút mở account sheet (avatar)`,
  ).toBeVisible()

  // M1.3: header top-level là NHẬN DIỆN, không phải danh tính — đúng chuỗi
  // 'Circa Tasks', không còn `profile.full_name`. Khoá bằng toBe (không phải
  // toContain) nên tên người dùng quay lại là đỏ ngay, không cần biết tên đó
  // là gì. CHỈ <p>: chữ "C" trong ô avatar là <span>, luôn khác rỗng nên đo
  // span thì assert không bao giờ bắt được gì.
  const title = (await header.locator('p').first().textContent())?.trim() ?? ''
  expect(title, `${where}: tiêu đề header phải là "Circa Tasks" (M1.3 bỏ tên người dùng khỏi header)`)
    .toBe('Circa Tasks')
}

// Phần tử cuối cùng của <main> KHÔNG được nằm dưới vùng thị giác của nút giữa —
// đo SAU KHI đã cuộn hết xuống (lúc đó phần tử cuối ở vị trí thấp nhất trên màn
// hình). Đây chính là invariant mà `--bottom-nav-clearance` phải bảo đảm: đổi
// chiều cao nav / quầng nút giữa mà quên đổi token thì đỏ ở đây.
async function expectLastElementNotUnderNav(page: Page, where: string) {
  const geom = await page.evaluate((zoneSel) => {
    const main = document.querySelector('main')
    const zone = document.querySelector(zoneSel)
    if (!main || !zone) return null
    const last = [...main.children]
      .filter((el) => el.getBoundingClientRect().height > 0)
      .pop()
    if (!last) return null
    return {
      lastBottom: last.getBoundingClientRect().bottom,
      lastDesc: `${last.tagName.toLowerCase()}.${(last.className || '').toString().split(' ').slice(0, 3).join('.')}`,
      zoneTop: zone.getBoundingClientRect().top,
    }
  }, NAV_CENTER_ZONE)

  expect(geom, `${where}: không đo được (thiếu <main>, vùng nút giữa, hoặc main rỗng)`).not.toBeNull()
  expect(
    geom!.lastBottom,
    `${where}: phần tử cuối (${geom!.lastDesc}) chạm đáy ${geom!.lastBottom}px, bị nút giữa (vùng thị giác từ ${geom!.zoneTop}px) che`,
  ).toBeLessThanOrEqual(geom!.zoneTop)
}

for (const vp of VIEWPORTS) {
  test.describe(`baseline mobile staff ${vp.w} @mobile`, () => {
    // Viewport set lúc tạo context ⇒ render đầu tiên đã ở đúng bề ngang.
    test.use({ viewport: { width: vp.w, height: vp.h }, storageState: STAFF_STATE })

    test.skip(!EMAIL || !PASSWORD, 'E2E_STAFF_EMAIL / E2E_STAFF_PASSWORD chưa set')

    test.beforeEach(async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== CAPTURE_PROJECT, `chỉ chụp dưới project ${CAPTURE_PROJECT}`)
      test.setTimeout(90_000)
    })

    for (const route of ROUTES) {
      test(`${route.name} @${vp.w}`, async ({ page }) => {
        const where = `${route.path} @${vp.w}`

        await page.goto(route.path)
        await expect(page, `${where}: bị redirect ⇒ storageState hết hạn (xoá e2e/.auth rồi chạy lại) hoặc tài khoản chụp không phải staff OS`)
          .toHaveURL(new RegExp(`${route.path.replace(/\//g, '\\/')}(\\?|$)`))
        await settle(page)

        const nav = page.locator(NAV)

        // ── Đầu trang: gate rồi mới chụp ──────────────────────────────────
        await scrollMain(page, 'top')
        await expect(nav, `${where}: không thấy bottom nav`).toBeVisible()
        await expectMobileHeader(page, where)
        await expectNoHorizontalOverflow(page, where)
        await shot(page, `${route.name}-${vp.w}-top.png`)

        // ── Cuối trang: gate rồi mới chụp ─────────────────────────────────
        await scrollMain(page, 'bottom')
        await expectNoHorizontalOverflow(page, `${where} (đáy)`)
        await expectLastElementNotUnderNav(page, where)
        await shot(page, `${route.name}-${vp.w}-bottom.png`)
      })
    }
  })
}
