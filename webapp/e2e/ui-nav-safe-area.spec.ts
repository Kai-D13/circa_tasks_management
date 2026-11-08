import { test, expect } from '@playwright/test'
import { STAFF_STATE, MANAGER_STATE, SM_STATE, SUPER_STATE } from './authState'
import { setSafeArea, envInset, settle, geometry, attachJson as attach, expectMobileShell, navItems, expectTargets, type Geo } from './uiNavGeometry'
import { bottomNavLayout, pillHeight } from '../lib/layout/bottomNavReflow'

// ─────────────────────────────────────────────────────────────────────────────
// UI-NAV r1 (PM audit planning/reviews/2026-11-08-ui-nav-candidate-pm.md §3 UINAV-P1-2): safe-area 0 và 34 px trên TRANG THẬT
// theo vai, bằng giả lập CHỈ ở lớp môi trường CSS — CDP `Emulation.setSafeAreaInsetsOverride` đổi giá trị
// `env(safe-area-inset-bottom)`; công thức token (globals.css) và markup (layout / BottomNav) giữ nguyên, test không đặt
// padding nào. Kỳ vọng: <main> staff OS 75.5 / 109.5 px, vai khác 97.5 / 131.5 px; pill dịch lên đúng inset; phần tử cuối cách mép
// trên pill ≥ 8 px; trang CSKH ẩn thanh tab chỉ chừa safe-area; desktop không chừa khoảng mobile.
// Giả lập 34 px KHÔNG phải iPhone thật (WebKit / máy thật / OS text scaling vẫn là rủi ro thiết bị còn lại).
// r2 — UI-NAV-D07 (PM r1 §5): thêm khung CSS hẹp (zoom 200 % ⇒ 195 / 180 / 160) trên trang thật: pill 2 hàng (98 px) ⇒ <main> tăng
// CÙNG (staff 113.5, vai khác 135.5, + inset một lần); chuyển sang màn CSKH không nav rồi quay lại không để sót chiều cao / đệm.
// ─────────────────────────────────────────────────────────────────────────────

const RUN_PROJECT = 'mobile-390'   // viewport do test đặt — một project là đủ
const INSETS = [0, 34] as const
const CARE = process.env.E2E_CARE_ENABLED === '1'

const MOBILE: { who: string; state: string; route: string; width: number; height: number; flat: boolean }[] = [
  { who: 'staff OS', state: STAFF_STATE, route: '/tasks', width: 390, height: 844, flat: true },
  { who: 'staff OS', state: STAFF_STATE, route: '/targets', width: 360, height: 800, flat: true },
  { who: 'QLCH', state: MANAGER_STATE, route: '/tasks', width: 390, height: 844, flat: false },
  { who: 'SM', state: SM_STATE, route: '/dashboard', width: 390, height: 844, flat: false },
  { who: 'super (admin mobile)', state: SUPER_STATE, route: '/tasks', width: 390, height: 844, flat: false },
  // UI-NAV-D07 khung hẹp (zoom 200 %).
  { who: 'staff OS', state: STAFF_STATE, route: '/tasks', width: 180, height: 400, flat: true },
  { who: 'QLCH', state: MANAGER_STATE, route: '/tasks', width: 180, height: 400, flat: false },
  { who: 'SM', state: SM_STATE, route: '/dashboard', width: 160, height: 284, flat: false },
  { who: 'super (admin mobile)', state: SUPER_STATE, route: '/tasks', width: 195, height: 422, flat: false },
]
const pillFor = (w: number) => pillHeight(bottomNavLayout(w, 'os').rows)
const pbLabel = (w: number, flat: boolean) => { const b = pillFor(w) + 7.5 + 8 + (flat ? 0 : 22); return `${b} / ${b + 34}` }

test.describe('UI-NAV safe-area theo vai — trang thật @mobile', () => {
  test.beforeEach(async ({}, testInfo) => {
    testInfo.skip(testInfo.project.name !== RUN_PROJECT, `chỉ chạy dưới project ${RUN_PROJECT}`)
    testInfo.setTimeout(120_000)
  })

  for (const c of MOBILE) {
    test.describe(`${c.who} ${c.route} @${c.width}`, () => {
      test.use({ storageState: c.state, viewport: { width: c.width, height: c.height } })
      test(`safe-area 0 / 34 px: pill ${pillFor(c.width)} px, <main> ${pbLabel(c.width, c.flat)} px, pill dịch lên, cuối trang ≥ 8 px`, async ({ page }, testInfo) => {
        const rows: unknown[] = []
        for (const inset of INSETS) {
          await setSafeArea(page, inset)
          await settle(page, c.route, true)
          const env = await envInset(page)
          const g = await geometry(page)
          rows.push({ inset, env, ...g })
          await attach(testInfo, `geo-${inset}`, { inset, env, ...g })
          expect(env, `giả lập safe-area ${inset}px không tới được CSS env()`).toBeCloseTo(inset, 1)
          expectMobileShell(g, inset, c.flat, `${c.who} ${c.route} inset ${inset}`, pillFor(c.width))
          const m = await navItems(page)
          await attach(testInfo, `nav-${inset}`, m)
          expectTargets(m!, `${c.who} ${c.route} @${c.width} inset ${inset}`)
        }
        testInfo.annotations.push({ type: 'safe-area', description: JSON.stringify(rows.map((r) => {
          const x = r as { inset: number; mainPb: number; pillTop: number; lastBottom: number }
          return `${x.inset}: pb ${x.mainPb} · pillTop ${x.pillTop} · cuối→pill ${(x.pillTop - x.lastBottom).toFixed(1)}`
        })) })
      })
    })
  }

  test.describe('staff OS — màn CSKH ẩn thanh tab', () => {
    test.use({ storageState: STAFF_STATE, viewport: { width: 390, height: 844 } })
    test('safe-area 0 / 34 px: không thanh tab, <main> chỉ chừa safe-area; CTA dính đáy không nằm dưới vùng home indicator', async ({ page }, testInfo) => {
      test.skip(!CARE, 'cần server CARE_ENABLED=true + E2E_CARE_ENABLED=1')
      await page.goto('/care/my')
      await expect(page).toHaveURL(/\/care\/my/)
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
      // Ưu tiên chi tiết khách THẬT của dược sĩ QA (có thanh hành động dính đáy); không có thì dùng một UUID không tồn tại —
      // điều kiện ẩn thanh tab chỉ phụ thuộc pathname (`careMyBackTarget`), nên vẫn kiểm được phần chừa của <main>. Chỉ đọc.
      const href = await page.locator('main a[href^="/care/my/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href') || '')
        .find((h) => /^\/care\/my\/[0-9a-f-]{36}$/i.test(h)) ?? null)
      const route = href ?? '/care/my/00000000-0000-4000-8000-000000000000'
      const rows: unknown[] = []
      for (const inset of INSETS) {
        await setSafeArea(page, inset)
        await settle(page, route, false)
        const env = await envInset(page)
        const g = await geometry(page)
        rows.push({ inset, env, route: href ? 'chi tiết thật' : 'UUID không tồn tại', ...g })
        await attach(testInfo, `care-geo-${inset}`, rows[rows.length - 1])
        expect(env).toBeCloseTo(inset, 1)
        expect(g.nav, 'màn con CSKH không được có thanh tab').toBe(false)
        expect(g.mainPb, '<main> màn ẩn nav chỉ chừa safe-area').toBeCloseTo(inset, 1)
        if (g.ctaBottom !== null) expect(g.ctaBottom, 'CTA dính đáy nằm dưới vùng safe-area').toBeLessThanOrEqual(g.vh - inset + 0.5)
      }
      testInfo.annotations.push({ type: 'care no-nav', description: `${href ? 'chi tiết thật' : 'UUID không tồn tại (không có thanh dính đáy)'} · ${JSON.stringify(rows.map((r) => { const x = r as Geo & { inset: number }; return { inset: x.inset, mainPb: x.mainPb, sticky: x.sticky, ctaBottom: x.ctaBottom, vh: x.vh } }))}` })
    })
  })

  test.describe('staff OS khung hẹp 180 — sang màn CSKH không nav rồi quay lại', () => {
    test.use({ storageState: STAFF_STATE, viewport: { width: 180, height: 400 } })
    test('reflow 2 hàng ⇒ CSKH: không nav, <main> chỉ safe-area, :root về 1 hàng ⇒ quay lại: reflow đúng (safe-area 34)', async ({ page }, testInfo) => {
      test.skip(!CARE, 'cần server CARE_ENABLED=true + E2E_CARE_ENABLED=1')
      await setSafeArea(page, 34)
      const pill = pillFor(180)
      const rows = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bottom-nav-rows').trim())
      await settle(page, '/tasks', true)
      const g1 = await geometry(page)
      expectMobileShell(g1, 34, true, 'staff /tasks @180 trước', pill)
      expect(await rows()).toBe('2')
      await page.goto('/care/my')
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
      const href = await page.locator('main a[href^="/care/my/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href') || '')
        .find((h) => /^\/care\/my\/[0-9a-f-]{36}$/i.test(h)) ?? null)
      await settle(page, href ?? '/care/my/00000000-0000-4000-8000-000000000000', false)
      const g2 = await geometry(page)
      expect(g2.nav, 'màn con CSKH không có thanh tab').toBe(false)
      expect(g2.mainPb, '<main> màn ẩn nav chỉ chừa safe-area — không sót clearance reflow').toBeCloseTo(34, 1)
      expect(await rows(), ':root không giữ số hàng reflow khi không có nav').toBe('1')
      await settle(page, '/tasks', true)
      const g3 = await geometry(page)
      expectMobileShell(g3, 34, true, 'staff /tasks @180 sau CSKH', pill)
      expect(await rows()).toBe('2')
      await attach(testInfo, 'narrow-care-roundtrip', { route: href ? 'chi tiết thật' : 'UUID không tồn tại', g1, g2, g3 })
    })
  })

  // r2 continuation B1 (PM planning/reviews/2026-11-08-ui-nav-r2-pm.md §6 B1; AC D07 §5.3-2): active + CHẠM THẬT ở khung hẹp
  // trên trang thật. Tab thứ năm (CSKH khi CARE ON, Tồn kho khi OFF) là đích từng nằm ngoài khung nhìn trước D07 (UINAV-Z1).
  // Chạm bằng touchscreen.tap vào TÂM ô (không force, không goto thay cú chạm); request ghi của app (cùng origin, non-GET hoặc
  // header next-action) chỉ GHI LẠI rồi assert rỗng — không chặn để không làm sai hành vi điều hướng.
  test.describe('staff OS khung hẹp 180 — active + chạm thật tab thứ năm (safe-area 34)', () => {
    test.use({ storageState: STAFF_STATE, viewport: { width: 180, height: 400 } })
    test('/targets: chỉ Doanh số aria-current=page ⇒ chạm tâm tab thứ năm ⇒ tới đích + nội dung, active chuyển ⇒ Back: Doanh số active lại; 0 request ghi app', async ({ page }, testInfo) => {
      const names = ['Tasks', 'Toa thuốc', 'Doanh số', 'Bảng tin', CARE ? 'CSKH' : 'Tồn kho']
      const hrefs = ['/tasks', '/prescriptions', '/targets', '/announcements', CARE ? '/care/my' : '/inventory']
      const fifth = { name: names[4], href: hrefs[4], heading: CARE ? 'Khách hàng của tôi' : 'Tồn kho' }
      const origin = new URL(process.env.E2E_BASE_URL || 'http://localhost:3000').origin
      const writes: string[] = []
      page.on('request', (r) => {
        const u = new URL(r.url())
        if (u.origin === origin && (!['GET', 'HEAD'].includes(r.method()) || r.headers()['next-action'])) writes.push(`${r.method()} ${u.pathname}`)
      })
      const t0 = Date.now(), marks: Record<string, number> = {}
      const mark = (k: string) => { marks[k] = Date.now() - t0 }
      const navLinks = page.locator('[data-bottom-nav] [data-nav-item]')
      const currentOf = () => navLinks.evaluateAll((els) => els.map((el) => el.getAttribute('aria-current')))

      await setSafeArea(page, 34)
      await page.goto('/targets')
      await expect(page, 'bị đẩy về /login ⇒ storageState hết hạn').not.toHaveURL(/\/login/)
      await expect(navLinks).toHaveCount(5, { timeout: 20_000 })
      // Link đã hydrate (React gắn props) ⇒ cú chạm đi đường client như người dùng thật, không phải tải lại tài liệu do chưa hydrate.
      await expect.poll(() => navLinks.nth(4).evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactProps'))), { timeout: 20_000 }).toBe(true)
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
      mark('ready')
      expect(await envInset(page), 'safe-area giả lập chưa áp dụng').toBeCloseTo(34, 0)

      const before = await navItems(page)
      expect(before, 'không thấy thanh tab').not.toBeNull()
      expect(before!.items.map((i) => i.name), 'tên accessible + thứ tự DOM').toEqual(names)
      expect(before!.items.map((i) => i.href), 'href').toEqual(hrefs)
      expect(before!.items.map((i) => i.current), '/targets: chỉ Doanh số aria-current=page').toEqual([null, null, 'page', null, null])
      expect(before!.perRow, '180 px ⇒ lưới 3 + 2 (tab thứ năm ở hàng hai)').toEqual([3, 2])
      expectTargets(before!, 'staff /targets @180 trước chạm')
      const t5 = before!.items[4]
      expect(t5.hitOk, `${fifth.name}: tâm ô không trúng chính control`).toBe(true)
      await page.screenshot({ path: testInfo.outputPath('narrow-180-active-targets.png') })

      const cx = t5.x + t5.w / 2, cy = t5.y + t5.h / 2
      mark('tap')
      await page.touchscreen.tap(cx, cy)
      await expect(page, `chạm ${fifth.name} ⇒ ${fifth.href}`).toHaveURL(new RegExp(`${fifth.href.replace(/\//g, '\\/')}(\\?|$)`), { timeout: 20_000 })
      mark('urlCommit')
      // PageHeader desktop cùng chữ bị `hidden md:flex` ⇒ chỉ lấy bản đang hiện (header mobile của trang).
      await expect(page.getByText(fifth.heading, { exact: true }).filter({ visible: true }).first(), `nội dung đích: "${fifth.heading}"`).toBeVisible({ timeout: 20_000 })
      mark('content')
      await expect.poll(currentOf, { timeout: 10_000, message: `active chuyển sang ${fifth.name}, Doanh số thôi active` }).toEqual([null, null, null, null, 'page'])
      mark('activeMoved')
      const after = await navItems(page)
      expectTargets(after!, `staff ${fifth.href} @180 sau chạm`)
      await page.screenshot({ path: testInfo.outputPath('narrow-180-active-fifth.png') })

      await page.goBack()
      await expect(page, 'Back ⇒ /targets').toHaveURL(/\/targets(\?|$)/, { timeout: 20_000 })
      await expect.poll(currentOf, { timeout: 10_000, message: 'Back: Doanh số active lại' }).toEqual([null, null, 'page', null, null])
      mark('back')

      await attach(testInfo, 'narrow-180-active-tap', {
        care: CARE, tap: { x: cx, y: cy, cell: { w: t5.w, h: t5.h } }, marks, writes,
        before: before!.items.map((i) => ({ name: i.name, current: i.current, y: i.y })), after: after!.items.map((i) => ({ name: i.name, current: i.current })),
      })
      expect(writes, 'request ghi của app trong hành trình chạm').toEqual([])
    })
  })

  for (const d of [{ who: 'QLCH', state: MANAGER_STATE, route: '/tasks' }, { who: 'super', state: SUPER_STATE, route: '/targets/campaigns' }]) {
    test.describe(`desktop ${d.who}`, () => {
      test.use({ storageState: d.state, viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false })
      test(`desktop 1280 + safe-area 34 px: <main> không chừa khoảng mobile, thanh tab ẩn`, async ({ page }, testInfo) => {
        await setSafeArea(page, 34)
        await settle(page, d.route, false)
        const g = await geometry(page)
        await attach(testInfo, 'desktop-geo', g)
        expect(await envInset(page)).toBeCloseTo(34, 1)
        expect(g.mainPb, 'desktop không có bottom nav ⇒ <main> pb 0').toBe(0)
        expect(g.navVisible, 'thanh tab mobile phải ẩn ở desktop').toBe(false)
      })
    })
  }
})
