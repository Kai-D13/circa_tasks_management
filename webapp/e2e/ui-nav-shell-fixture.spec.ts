import fs from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import { SUPER_STATE, STAFF_STATE, MANAGER_STATE, SM_STATE } from './authState'
import { trapWrites, type TrappedRequest } from './fixtureGuard'
import { setSafeArea, envInset, settle, geometry, attachJson, expectMobileShell, navItems, expectTargets, type NavItems } from './uiNavGeometry'
import { BOTTOM_NAV_BREAKPOINTS, NAV_OS_CONTROLS, bottomNavLayout, pillHeight } from '../lib/layout/bottomNavReflow'

// ─────────────────────────────────────────────────────────────────────────────
// UI-NAV r1 (PM audit planning/reviews/2026-11-08-ui-nav-candidate-pm.md §3 UINAV-P1-2) — các vai KHÔNG có tài khoản QA (admin phòng
// được / không được cấp quyền Affiliate, FS staff, FS QLCH; r2 thêm SM cho reflow) kiểm bằng fixture `/ui-catalog-shell/nav`: render
// CHÍNH DashboardShell của (dashboard)/layout.tsx (Sidebar + <main> + BottomNav thật) với hồ sơ giả; props qua đúng hàm thuần layout
// dùng (opsSidebarVisible → campaignNavItems, canViewCmsAdmin). Đây là bằng chứng TRÌNH BÀY — quyền route thật của các vai này vẫn
// CHƯA KIỂM trên trình duyệt (không có tài khoản; không tạo account / store / marker prod). Trang fixture tự nó không query dữ liệu
// nghiệp vụ, nhưng cổng dùng phiên / hồ sơ thật và NotificationProvider (vai khác staff) vẫn poll SELECT notifications của PHIÊN super.
// Mọi request ghi trong trình duyệt bị chặn (trapWrites) và danh sách bị chặn PHẢI rỗng ở cuối mỗi ca (afterEach) — chặn không được
// âm thầm cho qua.
// r2 — UI-NAV-D07 (PM r1 §5): khung CSS rất hẹp (zoom 200 % của máy 390 / 360 / 320 ⇒ 195 / 180 / 160 CSS px) ⇒ icon-only + lưới
// 3 + 2 / 2 cột; mọi ô ≥ 44 × 44 CSS px (getBoundingClientRect, KHÔNG nhân DPR), nằm trong viewport + pill, tâm ô trúng chính control;
// chiều cao pill và đệm <main> tăng cùng nhau. Không giả lập được OS text scaling / iOS thật — rủi ro thiết bị còn lại.
// ─────────────────────────────────────────────────────────────────────────────

const RUN_PROJECT = 'mobile-390'
const HAS_SUPER = fs.existsSync(SUPER_STATE)
const FX = '/ui-catalog-shell/nav'
const CAMP = 'a[href^="/targets/campaigns"]'
/** Server THỨ HAI cùng build, KHÔNG đặt UI_CATALOG (gate r2 chạy kèm) — kiểm cổng cờ OFF. */
const CATALOG_OFF = process.env.E2E_CATALOG_OFF_BASE_URL

async function open(page: Page, query: string, withNav = true) {
  await settle(page, `${FX}?${query}`, withNav)
  await expect(page.locator('[data-testid="nav-shell-fixture"]'), `fixture không render (${query}) — server có UI_CATALOG=1?`).toBeAttached({ timeout: 20_000 })
}
const sidebarHrefs = (page: Page) => page.locator('#sidebar-nav a[href]').evaluateAll((as) => as.map((a) => a.getAttribute('href')))
async function items(page: Page): Promise<NavItems> {
  const m = await navItems(page)
  expect(m, 'không thấy thanh tab').not.toBeNull()
  return m!
}

// Thanh OS (luôn 5 ô) theo vai — tên accessible theo THỨ TỰ DOM (khoá luôn thứ tự đọc / focus). Doanh số của staff là ô thứ ba.
const OS_BARS = [
  { key: 'staff-care', q: 'as=staff-os&care=1&badge=12', flat: true, names: ['Tasks', 'Toa thuốc', 'Doanh số', 'Bảng tin', 'CSKH'], badges: ['9+', '9+'] },
  { key: 'staff', q: 'as=staff-os&care=0', flat: true, names: ['Tasks', 'Toa thuốc', 'Doanh số', 'Bảng tin', 'Tồn kho'], badges: [] },
  { key: 'qlch', q: 'as=qlch-os&badge=12', flat: false, names: ['Tổng quan', 'Tasks', 'Toa thuốc', 'Bảng tin', 'Thêm'], badges: ['9+'] },
  { key: 'sm', q: 'as=sm', flat: false, names: ['Tổng quan', 'Doanh số', 'Users', 'Cửa hàng', 'Thêm'], badges: [] },
  { key: 'admin', q: 'as=dept-affiliate', flat: false, names: ['Tổng quan', 'Tasks', 'Toa thuốc', 'Users', 'Thêm'], badges: [] },
] as const
/** Số ô từng hàng mong đợi với 5 ô. */
const perRow = (cols: number) => (cols >= NAV_OS_CONTROLS ? [5] : cols === 3 ? [3, 2] : [2, 2, 1])

/** So bố cục render thật với hàm TS (nguồn mốc) ở viewport hiện tại — nhãn / số hàng / ô mỗi hàng / chiều cao pill / đệm <main>. */
async function expectLayout(page: Page, kind: 'os' | 'fs', flat: boolean, where: string) {
  const m = await items(page)
  const want = bottomNavLayout(m.vw, kind)
  const g = await geometry(page)
  expect(m.items.filter((i) => i.labelShown).length, `${where}: số nhãn đang hiện`).toBe(want.labels ? m.items.length : 0)
  expect(m.perRow, `${where}: ô mỗi hàng`).toEqual(kind === 'fs' ? [1] : perRow(want.cols))
  expect(m.pill.h, `${where}: chiều cao pill`).toBeCloseTo(pillHeight(want.rows), 1)
  expect(m.rootRows, `${where}: --bottom-nav-rows tại :root`).toBe(String(kind === 'fs' ? 1 : want.rows))
  expect(g.mainPb, `${where}: <main> phải tăng CÙNG pill`).toBeCloseTo(pillHeight(want.rows) + 7.5 + 8 + (flat ? 0 : 22), 1)
  expectTargets(m, where)
  return { m, want, mainPb: g.mainPb }
}

let trapped: TrappedRequest[] = []

test.describe('UI-NAV fixture khung điều hướng — vai không có tài khoản QA @mobile', () => {
  test.use({ storageState: SUPER_STATE })
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.beforeEach(async ({ page }, testInfo) => {
    testInfo.skip(testInfo.project.name !== RUN_PROJECT, `chỉ chạy dưới project ${RUN_PROJECT}`)
    testInfo.setTimeout(180_000)
    trapped = await trapWrites(page)
  })
  test.afterEach(async ({}, testInfo) => {
    await attachJson(testInfo, 'trapWrites', trapped)
    expect(trapped, 'fixture / khung điều hướng không được phát request ghi nào (đã chặn ở trình duyệt)').toEqual([])
  })

  test.describe('Sidebar desktop 1280', () => {
    test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false })

    test('admin phòng ĐƯỢC cấp quyền Affiliate: đúng một link đơn "Affiliate", 0 accordion, không KPI / CMS', async ({ page }) => {
      for (const collapsed of ['0', '1']) {
        await open(page, `as=dept-affiliate&collapsed=${collapsed}`, false)
        await expect(page.locator('#sidebar-nav [data-sidebar-group="campaigns"]'), `rail ${collapsed}: không được có accordion`).toHaveCount(0)
        await expect(page.locator(`#sidebar-nav ${CAMP}`), `rail ${collapsed}: chỉ một link chiến dịch`).toHaveCount(1)
        const link = page.locator('#sidebar-nav a[href="/targets/campaigns/affiliate"]')
        await expect(link).toHaveCount(1)
        if (collapsed === '0') await expect(link).toHaveText(/^\s*Affiliate\s*$/)
        else await expect(link, 'rail: link đơn vẫn có tên truy cập').toHaveAccessibleName(/Affiliate/)
        await expect(page.locator('#sidebar-nav button', { hasText: 'Chiến dịch' })).toHaveCount(0)
      }
    })

    test('admin phòng KHÔNG được cấp quyền: không có link / nhóm Chiến dịch', async ({ page }) => {
      await open(page, 'as=dept-plain', false)
      await expect(page.locator(`#sidebar-nav ${CAMP}`)).toHaveCount(0)
      await expect(page.locator('#sidebar-nav [data-sidebar-group="campaigns"]')).toHaveCount(0)
      expect((await sidebarHrefs(page)).length, 'Sidebar admin thường vẫn có mục vận hành').toBeGreaterThan(0)
    })

    test('cờ OFF: admin phòng được cấp quyền mất link Affiliate khi tắt KPI hoặc Affiliate; CMS tắt không ảnh hưởng', async ({ page }) => {
      for (const [q, n] of [['kpi=0', 0], ['aff=0', 0], ['kpi=0&aff=0&cms=0', 0], ['cms=0', 1]] as const) {
        await open(page, `as=dept-affiliate&${q}`, false)
        await expect(page.locator(`#sidebar-nav ${CAMP}`), `${q}`).toHaveCount(n)
        await expect(page.locator('#sidebar-nav [data-sidebar-group="campaigns"]'), `${q}`).toHaveCount(0)
      }
    })

    test('FS QLCH: Sidebar chỉ còn mục FS — không nhóm Chiến dịch, không mục OS', async ({ page }) => {
      await open(page, 'as=fs-qlch', false)
      const hrefs = await sidebarHrefs(page)
      expect(hrefs, 'FS QLCH phải còn mục /fs/products').toContain('/fs/products')
      expect(hrefs.filter((h) => !h?.startsWith('/fs')), 'không được có mục OS nào').toEqual([])
      await expect(page.locator('#sidebar-nav [data-sidebar-group="campaigns"]')).toHaveCount(0)
    })

    test('FS staff: không render Sidebar (staff mobile-only)', async ({ page }) => {
      await open(page, 'as=fs-staff', false)
      await expect(page.locator('#sidebar-nav')).toHaveCount(0)
    })

    // SM-CAMPAIGN-NAV-1 (work order PM 12/11, SM-NAV-D01): SM nhận nhóm "Chiến dịch" theo cờ ∩ quyền hiện có; Doanh số giữ nguyên.
    // AC02: 0 mục ⇒ không nhóm rỗng · 1 mục ⇒ link đơn đúng tên · ≥ 2 ⇒ accordion. Bằng chứng TRÌNH BÀY (hồ sơ SM giả).
    test('SM: nhóm "Chiến dịch" theo cờ — ≥ 2 mục accordion, 1 mục link đơn, 0 mục không nhóm; Doanh số luôn còn; rail có tên truy cập', async ({ page }) => {
      const K = '/targets/campaigns', A = '/targets/campaigns/affiliate', C = '/targets/campaigns/cms'
      const cases: [string, string[], 'group' | 'single' | 'none'][] = [
        ['', [K, A, C], 'group'],
        ['cms=0', [K, A], 'group'],
        ['aff=0', [K, C], 'group'],
        ['kpi=0', [C], 'single'], // Affiliate cần cả KPI ⇒ chỉ còn CMS
        ['kpi=0&cms=0', [], 'none'],
        ['kpi=0&aff=0&cms=0', [], 'none'],
      ]
      for (const [q, hrefs, kind] of cases) {
        await open(page, `as=sm${q ? `&${q}` : ''}`, false)
        const group = page.locator('#sidebar-nav [data-sidebar-group="campaigns"]')
        await expect(page.locator('#sidebar-nav a[href="/targets"]'), `${q || 'mọi cờ bật'}: mục Doanh số phải còn`).toHaveCount(1)
        if (kind === 'group') {
          await expect(group, `${q || 'mọi cờ bật'}: accordion`).toHaveCount(1)
          const btn = group.locator('button').first()
          await expect(btn).toHaveText(/^Chiến dịch$/)
          await expect(btn, 'trang ngoài module: nhóm đóng').toHaveAttribute('aria-expanded', 'false')
          await btn.click()
          await expect(btn).toHaveAttribute('aria-expanded', 'true')
          expect(await page.locator('#sidebar-campaigns-sub a').evaluateAll((as) => as.map((a) => a.getAttribute('href'))), `${q || 'mọi cờ bật'}: mục con`).toEqual(hrefs)
        } else {
          await expect(group, `${q}: không accordion`).toHaveCount(0)
          expect(await page.locator(`#sidebar-nav ${CAMP}`).evaluateAll((as) => as.map((a) => a.getAttribute('href'))), `${q}: link chiến dịch`).toEqual(hrefs)
          if (kind === 'single') await expect(page.locator(`#sidebar-nav a[href="${C}"]`)).toHaveText(/^\s*CMS sản phẩm\s*$/)
        }
      }
      // Rail 64 px: nút nhóm có tên truy cập; bấm ⇒ mở Sidebar + bung nhóm (không điều hướng).
      await open(page, 'as=sm&collapsed=1', false)
      const btn = page.locator('#sidebar-nav [data-sidebar-group="campaigns"] button').first()
      await expect(btn).toHaveAttribute('aria-label', 'Chiến dịch')
      const url = page.url()
      await btn.click()
      await expect(btn).toHaveAttribute('aria-expanded', 'true')
      expect(page.url(), 'bấm nút nhóm không được điều hướng').toBe(url)
      expect(await page.locator('#sidebar-campaigns-sub a').evaluateAll((as) => as.map((a) => a.getAttribute('href')))).toEqual([K, A, C])
    })
  })

  test.describe('BottomNav + <main> mobile 390, safe-area 0 / 34', () => {
    test.use({ viewport: { width: 390, height: 844 } })
    for (const c of [
      { as: 'fs-staff', flat: false, tabs: ['/fs/products'], more: false },
      { as: 'fs-qlch', flat: false, tabs: ['/fs/products'], more: false },
      { as: 'dept-affiliate', flat: false, tabs: null, more: true },
      { as: 'staff-os', flat: true, tabs: ['/tasks', '/prescriptions', '/targets', '/announcements', '/inventory'], more: false },
    ]) {
      test(`${c.as}: thanh tab đúng vai, <main> ${c.flat ? '75.5 / 109.5' : '97.5 / 131.5'} px, pill dịch lên, cuối trang ≥ 8 px`, async ({ page }, testInfo) => {
        for (const inset of [0, 34]) {
          await setSafeArea(page, inset)
          await open(page, `as=${c.as}&rows=30`)
          const env = await envInset(page)
          const g = await geometry(page)
          await attachJson(testInfo, `${c.as}-${inset}`, { inset, env, ...g })
          expect(env, 'giả lập safe-area không tới CSS env()').toBeCloseTo(inset, 1)
          expectMobileShell(g, inset, c.flat, `${c.as} inset ${inset}`)
          const hrefs = g.tabs.map((t) => t.href)
          if (c.tabs) expect(hrefs, `${c.as}: tab`).toEqual(c.tabs)
          expect(hrefs.some((h) => h?.startsWith('/targets/campaigns')), `${c.as}: BottomNav không có mục Chiến dịch`).toBe(false)
          expect(g.tabs.some((t) => t.label === 'Thêm'), `${c.as}: nút Thêm`).toBe(c.more)
          if (c.as.startsWith('fs-')) {
            expect(g.tabs.map((t) => t.label), 'FS chỉ một tab "Quản lý sản phẩm"').toEqual(['Quản lý sản phẩm'])
            await expect(page.locator('[data-testid="bottom-nav-center"], [data-nav-center-zone]')).toHaveCount(0)
          }
        }
      })
    }
  })

  // ── UI-NAV-D07: zoom 200 % ⇒ khung CSS 195 / 180 / 160 (máy 390 / 360 / 320). ───────────────────────────────────────────────
  for (const [vw, vh] of [[195, 422], [180, 400], [160, 284]] as const) {
    test.describe(`D07 reflow @${vw} CSS px (zoom 200 % máy ${vw * 2})`, () => {
      test.use({ viewport: { width: vw, height: vh } })
      for (const bar of OS_BARS) {
        test(`${bar.key}: 5 ô icon-only, lưới đúng mốc, mỗi ô ≥ 44 × 44 CSS px trong viewport + pill, hit-test, <main> tăng cùng pill (safe-area 0 / 34)`, async ({ page }, testInfo) => {
          const want = bottomNavLayout(vw, 'os')
          expect(want.labels, 'bảng mốc: khung này phải icon-only').toBe(false)
          for (const inset of [0, 34]) {
            await setSafeArea(page, inset)
            await open(page, `${bar.q}&rows=30`)
            const m = await items(page)
            const g = await geometry(page)
            await attachJson(testInfo, `${bar.key}-${vw}-${inset}`, { inset, want, m, g })
            const where = `${bar.key} @${vw} inset ${inset}`
            expect(m.reflow, `${where}: thanh OS phải gắn data-nav-reflow`).toBe(true)
            expect(m.controls, `${where}: thanh OS luôn ${NAV_OS_CONTROLS} ô`).toBe(NAV_OS_CONTROLS)
            expect(m.items.map((i) => i.name), `${where}: tên accessible + thứ tự DOM`).toEqual([...bar.names])
            expect(m.items.filter((i) => i.labelShown), `${where}: nhãn phải ẩn (icon-only)`).toEqual([])
            expect(m.perRow, `${where}: ô mỗi hàng`).toEqual(perRow(want.cols))
            expect(m.pill.h, `${where}: chiều cao pill`).toBeCloseTo(pillHeight(want.rows), 1)
            expectTargets(m, where)
            expect(m.items.filter((i) => i.badge).map((i) => i.badge!.text), `${where}: badge`).toEqual([...bar.badges])
            // <main> và pill cùng nguồn chiều cao; safe-area một lần; phần tử cuối không bị hàng thứ hai che.
            expectMobileShell(g, inset, bar.flat, where, pillHeight(want.rows))
          }
        })
      }

      test('FS staff / FS QLCH: giữ MỘT tab có nhãn, không reflow, pill 60 px, ô ≥ 44 px trong viewport', async ({ page }, testInfo) => {
        for (const as of ['fs-staff', 'fs-qlch']) {
          await open(page, `as=${as}&rows=30`)
          const m = await items(page)
          await attachJson(testInfo, `${as}-${vw}`, m)
          expect(m.reflow, `${as}: FS không gắn data-nav-reflow`).toBe(false)
          expect(m.items.map((i) => i.name)).toEqual(['Quản lý sản phẩm'])
          expect(m.items[0].labelShown, `${as}: FS giữ nhãn`).toBe(true)
          expect(m.pill.h).toBeCloseTo(60, 1)
          expect(m.rootRows).toBe('1')
          expectTargets(m, `${as} @${vw}`)
          expectMobileShell(await geometry(page), 0, false, `${as} @${vw}`)
        }
      })
    })
  }

  test.describe('D07 bàn phím + Thêm ở khung hẹp 180', () => {
    test.use({ viewport: { width: 180, height: 400 } })
    for (const bar of OS_BARS) {
      test(`${bar.key}: Tab đi qua đúng 5 ô theo thứ tự, ring trong ô${(bar.names as readonly string[]).includes('Thêm') ? '; Thêm mở / đóng menu' : ''}`, async ({ page }) => {
        await open(page, `${bar.q}&rows=6`)
        const seen: string[] = []
        for (let i = 0; i < 120 && seen.length < NAV_OS_CONTROLS; i++) {
          await page.keyboard.press('Tab')
          const f = await page.evaluate(() => {
            const a = document.activeElement as HTMLElement | null
            if (!a?.closest('[data-bottom-nav]')) return null
            const r = a.getBoundingClientRect()
            return { name: a.getAttribute('aria-label'), ring: getComputedStyle(a).boxShadow, w: r.width, h: r.height }
          })
          if (f) {
            expect(f.ring, `${f.name}: focus phải có ring`).not.toBe('none')
            expect(f.w >= 44 && f.h >= 44, `${f.name}: ô focus ≥ 44 CSS px`).toBe(true)
            seen.push(f.name!)
          }
        }
        expect(seen, 'thứ tự focus = thứ tự DOM / đọc').toEqual([...bar.names])
        if ((bar.names as readonly string[]).includes('Thêm')) {
          const more = page.locator('[data-bottom-nav] button[aria-label="Thêm"]')
          const box = (await more.boundingBox())!
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)   // chạm đúng tâm ô
          const dlg = page.getByRole('dialog', { name: 'Thêm' })
          await expect(dlg, 'Thêm phải mở menu').toBeVisible()
          expect(await dlg.locator('a[href]').count(), 'menu Thêm có mục').toBeGreaterThan(0)
          await page.keyboard.press('Escape')
          await expect(dlg, 'Escape phải đóng menu').toBeHidden()
        }
      })
    }
  })

  test.describe('D07 mốc TS ↔ CSS + resize không để sót trạng thái', () => {
    test.use({ viewport: { width: 390, height: 700 } })
    const b = BOTTOM_NAV_BREAKPOINTS
    // Hai phía mỗi mốc, rồi resize ngược lại (CSS thuần ⇒ phải phục hồi đúng), rồi desktop.
    const WIDTHS = [390, 320, b.labels, b.labels - 1, b.oneRow, b.oneRow - 1, 195, 180, 160, b.threeCols, b.threeCols - 1, 140, 180, 390]
    for (const c of [
      { key: 'staff-care', q: 'as=staff-os&care=1&badge=12', kind: 'os' as const, flat: true },
      { key: 'sm', q: 'as=sm', kind: 'os' as const, flat: false },
      { key: 'fs-staff', q: 'as=fs-staff', kind: 'fs' as const, flat: false },
    ]) {
      test(`${c.key}: ${WIDTHS.join(' → ')} → desktop 1280 → 180`, async ({ page }, testInfo) => {
        await open(page, `${c.q}&rows=30`)
        const log: unknown[] = []
        for (const w of WIDTHS) {
          await page.setViewportSize({ width: w, height: 700 })
          await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
          const { want, mainPb, m } = await expectLayout(page, c.kind, c.flat, `${c.key} @${w}`)
          log.push({ w, want, pillH: m.pill.h, perRow: m.perRow, mainPb, minW: Math.min(...m.items.map((i) => i.w)) })
        }
        // Desktop: thanh tab ẩn, <main> không chừa khoảng mobile, :root về một hàng.
        await page.setViewportSize({ width: 1280, height: 800 })
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
        const g = await geometry(page)
        const root = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bottom-nav-rows').trim())
        log.push({ w: 1280, navVisible: g.navVisible, mainPb: g.mainPb, rootRows: root })
        expect(g.navVisible, 'desktop: thanh tab ẩn').toBe(false)
        expect(g.mainPb, 'desktop: <main> pb 0').toBe(0)
        expect(root, 'desktop: :root không giữ số hàng reflow').toBe('1')
        // Quay lại khung hẹp: reflow trở lại đúng.
        await page.setViewportSize({ width: 180, height: 700 })
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
        await expectLayout(page, c.kind, c.flat, `${c.key} @180 sau desktop`)
        await attachJson(testInfo, `resize-${c.key}`, log)
      })
    }
  })

  test.describe('cổng fixture', () => {
    for (const [who, state] of [['staff', STAFF_STATE], ['QLCH', MANAGER_STATE], ['SM', SM_STATE]] as const) {
      test.describe(who, () => {
        test.use({ storageState: state })
        test(`${who} (không phải super) mở fixture ⇒ 404`, async ({ page }) => {
          test.skip(!fs.existsSync(state), `chưa có phiên ${who}`)
          const r = await page.goto(FX + '?as=staff-os')
          expect(r!.status(), `${who} không được thấy fixture`).toBe(404)
          await expect(page.locator('[data-testid="nav-shell-fixture"]')).toHaveCount(0)
        })
      })
    }

    test.describe('không đăng nhập', () => {
      test.use({ storageState: { cookies: [], origins: [] } })
      test('không phiên ⇒ không thấy fixture (về /login)', async ({ page }) => {
        await page.goto(FX + '?as=staff-os')
        await expect(page).toHaveURL(/\/login/)
        await expect(page.locator('[data-testid="nav-shell-fixture"]')).toHaveCount(0)
      })
    })

    test('super: ?as= chỉ nhận khoá riêng của FX — tên thuộc prototype / lạ / lặp ⇒ staff-os, không 500', async ({ page }, testInfo) => {
      const rows: { q: string; status: number; as: string | null }[] = []
      for (const q of ['as=__proto__', 'as=constructor', 'as=toString', 'as=hasOwnProperty', 'as=valueOf', 'as=', 'as=STAFF-OS', 'as=sm&as=qlch-os', 'as=sm']) {
        const r = await page.goto(`${FX}?${q}&rows=1`)
        const as = await page.locator('[data-testid="nav-shell-fixture"]').getAttribute('data-fixture-as', { timeout: 20_000 }).catch(() => null)
        rows.push({ q, status: r!.status(), as })
      }
      await attachJson(testInfo, 'own-key', rows)
      expect(rows).toEqual([
        ...['as=__proto__', 'as=constructor', 'as=toString', 'as=hasOwnProperty', 'as=valueOf', 'as=', 'as=STAFF-OS', 'as=sm&as=qlch-os'].map((q) => ({ q, status: 200, as: 'staff-os' })),
        { q: 'as=sm', status: 200, as: 'sm' },
      ])
    })

    test('cờ OFF (server cùng build, không UI_CATALOG): super ⇒ 404, không phiên ⇒ không thấy fixture', async ({ page, browser }) => {
      test.skip(!CATALOG_OFF, 'E2E_CATALOG_OFF_BASE_URL chưa đặt — gate r2 PHẢI chạy kèm server thứ hai không UI_CATALOG')
      const r = await page.goto(`${CATALOG_OFF}${FX}?as=staff-os`)
      expect(r!.status(), 'super + cờ OFF ⇒ 404').toBe(404)
      await expect(page.locator('[data-testid="nav-shell-fixture"]')).toHaveCount(0)
      const anon = await browser.newContext()
      try {
        const p = await anon.newPage()
        const r2 = await p.goto(`${CATALOG_OFF}${FX}?as=staff-os`)
        expect(r2!.status() === 404 || /\/login/.test(p.url()), `không phiên + cờ OFF ⇒ 404 hoặc /login (thực tế ${r2!.status()} ${p.url()})`).toBe(true)
        await expect(p.locator('[data-testid="nav-shell-fixture"]')).toHaveCount(0)
      } finally { await anon.close() }
    })
  })

  test.describe('staff OS zoom 100 % (đối chứng)', () => {
    test.use({ viewport: { width: 360, height: 800 } })
    test('360: năm tab bằng nhau có nhãn, một hàng, nằm trọn trong pill và khung nhìn', async ({ page }) => {
      await open(page, 'as=staff-os&badge=12&care=1&rows=30')
      const m = await items(page)
      const ws = m.items.map((t) => t.w)
      expect(Math.max(...ws) - Math.min(...ws)).toBeLessThanOrEqual(1)
      expect(m.items.every((i) => i.labelShown), 'zoom 100 %: đủ nhãn').toBe(true)
      expect(m.perRow).toEqual([5])
      expect(m.pill.h).toBeCloseTo(60, 1)
      expectTargets(m, 'staff 360')
    })
  })
})
