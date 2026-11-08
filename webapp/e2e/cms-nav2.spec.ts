import fs from 'node:fs'
import { test, expect, type Browser, type BrowserContext, type Locator, type Page, type Request } from '@playwright/test'
import { MANAGER_STATE, STAFF_STATE, SUPER_STATE } from './authState'
import { sessionDb } from './dbFixtures'
import { trapWrites, type TrappedRequest } from './fixtureGuard'
import { NAV_WATCHDOG_MS } from '../lib/nav/watchdog'

// ─────────────────────────────────────────────────────────────────────────────
// NAV-2 (PM 08/11/2026 — planning/research/cms-nav2-guides-next-actions-2026-11-08.md §1–3, AC NAV2-01…10): segment
// "KPI chiến dịch | CMS sản phẩm" (CmsTargetsSegment) trên /targets của dược sĩ / QLCH có lúc treo như NAV-1 (RSC về đủ, URL đứng
// yên — prod 6/50 lượt KPI→CMS). Mỗi link có NavWatchdog: pending quá NAV_WATCHDOG_MS lúc trang hiển thị ⇒ tải cứng đích MỘT lần.
//
// "Treo" dựng TẤT ĐỊNH bằng cách giữ request RSC tới đích (page.route không trả); request TÀI LIỆU (tải cứng) đi qua. Hai biến thể:
//   cold — giữ cả RSC prefetch ngay từ lúc tải trang nguồn (đích chưa prefetch);
//   warm — cho prefetch tự động (link trong viewport) xong rồi mới giữ RSC điều hướng (docs useLinkStatus: đích đã prefetch có
//          thể bỏ qua pending ⇒ phải chứng minh watchdog vẫn kích hoạt).
// Đếm tải cứng = số request document tới đúng đích. Route thật cần server bật CMS_PROGRAM_ENABLED (E2E_CMS_ENABLED=1); chỉ
// đọc — mọi request ghi của app bị chặn + ghi nhận (trapWrites) và phải bằng 0. Fixture /ui-catalog/cms-v2 (super, UI_CATALOG=1,
// không DB) dùng cho các ca cần thời gian tất định chiều CMS→KPI.
// ─────────────────────────────────────────────────────────────────────────────

const RUN_PROJECT = 'mobile-390'   // viewport do test đặt — một project là đủ (cùng lý do nav-watchdog.spec)
const CMS_ON = process.env.E2E_CMS_ENABLED === '1'
const STAFF = { email: process.env.E2E_STAFF_EMAIL, password: process.env.E2E_STAFF_PASSWORD }
const VW = { m390: { width: 390, height: 844 }, m360: { width: 360, height: 800 } } as const

type Dir = 'kpi2cms' | 'cms2kpi'
const DIRS = {
  kpi2cms: { from: '/targets', seg: 'kpi', label: 'CMS sản phẩm', href: '/targets?tab=cms', done: 'main [data-cms-staff]',
    isTarget: (u: URL) => u.pathname === '/targets' && u.searchParams.get('tab') === 'cms' },
  cms2kpi: { from: '/targets?tab=cms', seg: 'cms', label: 'KPI chiến dịch', href: '/targets', done: 'main [data-cms-targets-segment="kpi"]',
    isTarget: (u: URL) => u.pathname === '/targets' && !u.searchParams.has('tab') },
} as const
const FX = { from: '/ui-catalog/cms-v2/staff?fx=simple', href: '/ui-catalog/kpi-v2/staff', done: 'main [data-testid="ui-catalog-kpi-staff"]',
  isTarget: (u: URL) => u.pathname === '/ui-catalog/kpi-v2/staff' }

const isRsc = (r: Request) => r.headers()['rsc'] === '1'
const isPrefetch = (r: Request) => r.headers()['next-router-prefetch'] === '1'
const urlOf = (s: string) => new URL(s)

/**
 * Thời điểm (ms từ `start()`) của mọi request document tới đích SAU `start()` (lượt goto mở trang nguồn không tính) — proxy chuyển
 * /login giữ query nhưng đổi pathname ⇒ không tính.
 */
function hardLoads(page: Page, isTarget: (u: URL) => boolean) {
  const at: number[] = []
  const log: string[] = []   // chẩn đoán: loại request / phản hồi tới đích theo thời gian (không URL đầy đủ / payload)
  let t0 = 0
  const kind = (r: Request) => r.resourceType() === 'document' ? 'doc' : isRsc(r) ? (isPrefetch(r) ? 'prefetch' : 'rsc') : r.resourceType()
  page.on('request', (r) => {
    if (!t0 || !isTarget(urlOf(r.url()))) return
    if (r.resourceType() === 'document') at.push(Date.now() - t0)
    log.push(`${Date.now() - t0}:req/${kind(r)}`)
  })
  page.on('response', (r) => { if (t0 && isTarget(urlOf(r.url()))) log.push(`${Date.now() - t0}:res/${kind(r.request())}/${r.status()}`) })
  page.on('framenavigated', (f) => { if (t0 && f === page.mainFrame()) log.push(`${Date.now() - t0}:url ${urlOf(f.url()).pathname}${urlOf(f.url()).search}`) })
  return { at, start: () => { t0 = Date.now() }, log }
}
/**
 * Chẩn đoán timer watchdog KHÔNG đổi app: init script bọc setTimeout / clearTimeout của trang, ghi lúc đặt / huỷ / chạy timer đúng
 * NAV_WATCHDOG_MS (pending → arm; hết pending / tới đích / unmount → clear). Mất khi trang tải lại (tải cứng). Chỉ dùng trong thông báo lỗi.
 */
async function timerTrace(page: Page) {
  await page.addInitScript((ms) => {
    const w = window as unknown as { __wd: string[] }
    // Kiểu lỏng có chủ đích: chạy trong trình duyệt (không có kiểu Node Timeout), chỉ để chẩn đoán.
    const st = window.setTimeout as unknown as (...a: unknown[]) => number
    const ct = window.clearTimeout as unknown as (id?: number) => void
    const live = new Set<number>()
    w.__wd = []
    const stamp = (e: string) => w.__wd.push(`${Math.round(performance.now())}:${e}`)
    const wrapped = (fn: unknown, delay?: number, ...a: unknown[]): number => {
      if (delay !== ms) return st.call(window, fn, delay, ...a)
      const id: number = st.call(window, () => { live.delete(id); stamp('fire'); if (typeof fn === 'function') (fn as () => void)() }, delay)
      live.add(id); stamp('arm'); return id
    }
    window.setTimeout = wrapped as unknown as typeof window.setTimeout
    window.clearTimeout = ((id?: number) => { if (id !== undefined && live.has(id)) { live.delete(id); stamp('clear') } return ct.call(window, id) }) as unknown as typeof window.clearTimeout
  }, NAV_WATCHDOG_MS)
  return async () => `timer[${await page.evaluate(() => (window as unknown as { __wd?: string[] }).__wd?.join(' ') ?? '—').catch(() => '—')}]`
}
/** Chờ URL tới đích; hết hạn ⇒ lỗi kèm chẩn đoán (dòng thời gian request + timer). */
async function reach(page: Page, isTarget: (u: URL) => boolean, timeout: number, loads: { log: string[] }, timers?: () => Promise<string>) {
  try {
    await expect(page).toHaveURL((u) => isTarget(u), { timeout })
  } catch {
    throw new Error(`không tới đích sau ${timeout} ms · url ${urlOf(page.url()).pathname}${urlOf(page.url()).search} · ${loads.log.join(' ')} · ${timers ? await timers() : ''}`)
  }
}
/**
 * Giữ RSC tới đích. mode 'cold' = đích chưa prefetch: prefetch không bao giờ trả; 'warm' = prefetch qua bình thường; 'inflight' =
 * prefetch cũng chậm như RSC điều hướng (về GIỮA lúc điều hướng). Không delayMs ⇒ RSC điều hướng treo; delayMs ⇒ chậm rồi cho qua.
 * Trả `prefetched()` — đã có ít nhất một phản hồi prefetch tới đích chưa.
 */
async function holdRsc(page: Page, isTarget: (u: URL) => boolean, mode: 'cold' | 'warm' | 'inflight', delayMs?: number) {
  let prefetchOk = 0
  page.on('response', (r) => { if (isTarget(urlOf(r.url())) && isRsc(r.request()) && isPrefetch(r.request())) prefetchOk++ })
  await page.route((u) => isTarget(u), async (route) => {
    const r = route.request()
    if (r.resourceType() === 'document' || !isRsc(r)) return route.continue()
    if (mode === 'warm' && isPrefetch(r)) return route.continue()
    if (mode === 'cold' && isPrefetch(r)) return   // đích chưa bao giờ prefetch xong
    if (delayMs === undefined) return   // không trả ⇒ treo
    // "Chậm delayMs rồi xong" = phản hồi hoàn tất đúng delayMs sau khi request đi (đã gồm thời gian render của server — route thật
    // đọc DB prod dao động 1–2,5 s, cộng dồn sẽ làm ca không tất định).
    const t = Date.now()
    try {
      const res = await route.fetch()
      const body = await res.body()
      await new Promise((ok) => setTimeout(ok, Math.max(0, delayMs - (Date.now() - t))))
      await route.fulfill({ response: res, body })
    } catch { /* trang đã đóng / điều hướng đi */ }
  })
  return { prefetched: () => prefetchOk > 0 }
}
async function openSegment(page: Page, from: string, seg: 'kpi' | 'cms'): Promise<Locator> {
  await page.goto(from)
  await expect(page, 'bị đẩy về /login ⇒ storageState hết hạn').not.toHaveURL(/\/login/)
  return segmentReady(page, seg, from)
}
/** Segment hiển thị + đã hydrate (chạm trước khi React gắn handler = tải trang thường, không đo được điều hướng mềm). */
async function segmentReady(page: Page, seg: 'kpi' | 'cms', where: string): Promise<Locator> {
  const nav = page.locator(`main [data-cms-targets-segment="${seg}"]`)
  await expect(nav, `${where}: không có segment ${seg}`).toBeVisible({ timeout: 30_000 })
  await page.waitForFunction((s) => { const a = document.querySelector(`main [data-cms-targets-segment="${s}"] a`); return !!a && Object.keys(a).some((k) => k.startsWith('__reactProps')) }, seg, { timeout: 30_000 })
  return nav
}
const segLink = (page: Page, seg: 'kpi' | 'cms', label: string) => page.locator(`main [data-cms-targets-segment="${seg}"] a`, { hasText: label }).first()
async function waitPrefetch(page: Page, h: { prefetched: () => boolean }) {
  await expect.poll(h.prefetched, { timeout: 15_000, message: 'link trong viewport không prefetch đích (ca warm vô nghĩa)' }).toBe(true)
}
async function setVisibility(page: Page, state: 'hidden' | 'visible') {
  await page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => s === 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)
}
/** Dấu hiệu nội dung CMS (để so tải cứng với tải trực tiếp — cùng chương trình / phạm vi / run, không 0 giả). */
async function cmsSignature(page: Page) {
  const root = page.locator('main [data-cms-staff]')
  await expect(root).toBeVisible({ timeout: 30_000 })
  return {
    kind: await root.getAttribute('data-cms-staff'),
    results: await root.getAttribute('data-cms-results'),
    program: (await page.locator('main [data-cms-program-label], main [data-cms-program-picker]').first().innerText().catch(() => '')).trim(),
    hero: (await page.locator('main [data-cms-hero-amount]').allInnerTexts()).join('|'),
    store: (await page.locator('main [data-cms-store-amount]').allInnerTexts()).join('|'),
    cards: await page.locator('main [data-cms-staff-product]').count(),
  }
}
function noWrites(seen: TrappedRequest[]) {
  expect(seen, 'request ghi của app trong luồng điều hướng chỉ đọc').toEqual([])
}

const ROLES = [
  { who: 'staff', state: STAFF_STATE, vw: VW.m390 },
  { who: 'QLCH', state: MANAGER_STATE, vw: VW.m360 },
] as const

for (const role of ROLES) {
  test.describe(`NAV-2 segment KPI ↔ CMS — ${role.who} @mobile`, () => {
    test.use({ storageState: role.state, viewport: role.vw, isMobile: true, hasTouch: true })
    test.skip(!CMS_ON, 'server chưa bật CMS_PROGRAM_ENABLED (E2E_CMS_ENABLED=1)')
    test.skip(!fs.existsSync(role.state), `chưa có phiên ${role.who}`)
    test.beforeEach(async ({}, testInfo) => {
      testInfo.skip(testInfo.project.name !== RUN_PROJECT, `chỉ chạy dưới project ${RUN_PROJECT}`)
      testInfo.setTimeout(120_000)
    })

    test('NAV2-01 href / nhãn / aria-current không đổi; watchdog không thêm DOM', async ({ page }) => {
      const seen = await trapWrites(page)
      for (const [dir, active] of [['kpi2cms', 'KPI chiến dịch'], ['cms2kpi', 'CMS sản phẩm']] as const) {
        const d = DIRS[dir]
        const nav = await openSegment(page, d.from, d.seg)
        const links = nav.locator('a')
        await expect(links).toHaveCount(2)
        expect(await links.evaluateAll((as) => as.map((a) => ({ href: a.getAttribute('href'), text: a.textContent, kids: a.childElementCount, cur: a.getAttribute('aria-current') }))))
          .toEqual([
            { href: '/targets', text: 'KPI chiến dịch', kids: 0, cur: active === 'KPI chiến dịch' ? 'page' : null },
            { href: '/targets?tab=cms', text: 'CMS sản phẩm', kids: 0, cur: active === 'CMS sản phẩm' ? 'page' : null },
          ])
      }
      noWrites(seen)
    })

    for (const dir of ['kpi2cms', 'cms2kpi'] as const) {
      const d = DIRS[dir]
      test(`NAV2-02 ${dir}: điều hướng mềm bình thường tới đúng URL + nội dung, 0 tải cứng`, async ({ page }) => {
        const seen = await trapWrites(page)
        const timers = await timerTrace(page)
        const loads = hardLoads(page, d.isTarget)
        await openSegment(page, d.from, d.seg)
        loads.start()
        const t0 = Date.now()
        await segLink(page, d.seg, d.label).click()
        await reach(page, d.isTarget, NAV_WATCHDOG_MS + 10_000, loads, timers)
        const dt = Date.now() - t0
        await expect(page.locator(d.done).first()).toBeVisible({ timeout: 20_000 })
        await page.waitForTimeout(Math.max(0, NAV_WATCHDOG_MS + 1_500 - (Date.now() - t0)))
        // Không hợp thức hoá tải cứng: lượt bình thường phải xong mềm trước mốc. Lỗi treo thật rơi vào đây = đỏ, phân loại bằng trace.
        expect(dt, `điều hướng mềm mất ${dt} ms — chạm mốc watchdog`).toBeLessThan(NAV_WATCHDOG_MS)
        expect(loads.at, 'điều hướng mềm xong mà vẫn tải cứng').toEqual([])
        noWrites(seen)
      })

      for (const mode of ['cold', 'warm'] as const) {
        test(`NAV2-03 ${dir} ${mode}: RSC treo ⇒ không tải cứng trước mốc, sau 6 s đúng MỘT document tới đích, nội dung đúng`, async ({ page }) => {
          const seen = await trapWrites(page)
          const timers = await timerTrace(page)
          const h = await holdRsc(page, d.isTarget, mode)
          const loads = hardLoads(page, d.isTarget)
          await openSegment(page, d.from, d.seg)
          if (mode === 'warm') await waitPrefetch(page, h)
          loads.start()
          const t0 = Date.now()
          await segLink(page, d.seg, d.label).click()
          await page.waitForTimeout(NAV_WATCHDOG_MS - 1_000)
          expect(loads.at, 'tải cứng sớm hơn mốc watchdog').toEqual([])
          expect(d.isTarget(urlOf(page.url())), 'RSC đang giữ mà URL đã đổi — giả lập treo không đúng').toBe(false)
          const before = await timers()   // trước khi tải cứng xoá dấu timer của trang cũ
          await reach(page, d.isTarget, 15_000, loads, async () => before)
          await expect(page.locator(d.done).first(), 'tải cứng không hiện nội dung đích').toBeVisible({ timeout: 20_000 })
          const dt = Date.now() - t0
          expect(dt, `tới đích sau ${dt} ms (hạn 15 s)`).toBeLessThan(15_000)
          await page.waitForTimeout(2_000)
          expect(loads.at.length, `phải đúng một tải cứng (${loads.at.join(', ')} ms)`).toBe(1)
          expect(loads.at[0], 'tải cứng trước mốc').toBeGreaterThanOrEqual(NAV_WATCHDOG_MS - 200)
          if (dir === 'kpi2cms') {
            // NAV2-08: tải cứng cho đúng màn CMS như tải trực tiếp (cùng chương trình / phạm vi / run, không 0 giả).
            const viaWatchdog = await cmsSignature(page)
            await page.goto('/targets?tab=cms')
            expect(viaWatchdog, 'màn CMS sau tải cứng khác tải trực tiếp').toEqual(await cmsSignature(page))
            expect(viaWatchdog.results, 'kết quả CMS lỗi').not.toBe('error')
          }
          noWrites(seen)
        })
      }
    }

    for (const mode of ['cold', 'warm'] as const) {
      test(`NAV2-04 kpi2cms ${mode}: RSC chậm 3 s rồi xong ⇒ huỷ timer, không tải cứng trễ`, async ({ page }) => {
        const d = DIRS.kpi2cms
        const seen = await trapWrites(page)
        const timers = await timerTrace(page)
        const h = await holdRsc(page, d.isTarget, mode, 3_000)
        const loads = hardLoads(page, d.isTarget)
        await openSegment(page, d.from, d.seg)
        if (mode === 'warm') await waitPrefetch(page, h)
        loads.start()
        const t0 = Date.now()
        await segLink(page, d.seg, d.label).click()
        await reach(page, d.isTarget, 15_000, loads, timers)
        const dt = Date.now() - t0
        expect(dt, 'RSC chậm 3 s mà URL đổi sớm hơn — không chậm thật').toBeGreaterThanOrEqual(3_000)
        expect(dt, `điều hướng mềm mất ${dt} ms — chạm mốc watchdog, ca không kiểm được huỷ timer`).toBeLessThan(NAV_WATCHDOG_MS - 500)
        await expect(page.locator(d.done)).toBeVisible({ timeout: 20_000 })
        await page.waitForTimeout(NAV_WATCHDOG_MS + 2_000 - dt)
        expect(loads.at, 'đã tới đích bằng điều hướng mềm mà vẫn tải cứng').toEqual([])
        noWrites(seen)
      })
    }
  })
}

test.describe('NAV-2 segment — luồng hủy / đổi hướng / tab ẩn / Back / phiên (staff) @mobile', () => {
  test.use({ storageState: STAFF_STATE, viewport: VW.m390, isMobile: true, hasTouch: true })
  test.skip(!CMS_ON, 'server chưa bật CMS_PROGRAM_ENABLED (E2E_CMS_ENABLED=1)')
  test.skip(!fs.existsSync(STAFF_STATE), 'chưa có phiên staff')
  test.beforeEach(async ({}, testInfo) => {
    testInfo.skip(testInfo.project.name !== RUN_PROJECT, `chỉ chạy dưới project ${RUN_PROJECT}`)
    testInfo.setTimeout(120_000)
  })
  const d = DIRS.kpi2cms

  test('NAV2-05 chạm CMS (treo) rồi chạm lại KPI đang chọn ⇒ không tải cứng CMS, không tải lại KPI', async ({ page }) => {
    const seen = await trapWrites(page)
    await holdRsc(page, d.isTarget, 'cold')
    const toCms = hardLoads(page, d.isTarget)
    const toKpi = hardLoads(page, DIRS.cms2kpi.isTarget)
    await openSegment(page, d.from, d.seg)
    toCms.start(); toKpi.start()
    await segLink(page, 'kpi', 'CMS sản phẩm').click()
    await page.waitForTimeout(1_500)
    await segLink(page, 'kpi', 'KPI chiến dịch').click()
    await page.waitForTimeout(NAV_WATCHDOG_MS + 3_000)
    expect(toCms.at, 'link bị bỏ vẫn kéo về CMS').toEqual([])
    expect(toKpi.at, 'nhấn tab đang chọn mà tải lại trang').toEqual([])
    await expect(page).toHaveURL(/\/targets$/)
    await expect(page.locator('main [data-cms-targets-segment="kpi"]')).toBeVisible()
    noWrites(seen)
  })

  test('NAV2-05 chạm CMS (treo) rồi đổi hướng sang Tasks ⇒ chỉ đích cuối, timer cũ không kéo về CMS', async ({ page }) => {
    const seen = await trapWrites(page)
    await holdRsc(page, d.isTarget, 'cold')
    const toCms = hardLoads(page, d.isTarget)
    await openSegment(page, d.from, d.seg)
    toCms.start()
    await segLink(page, 'kpi', 'CMS sản phẩm').click()
    await page.waitForTimeout(1_500)
    await page.locator('[data-bottom-nav] a[href="/tasks"]').first().click()
    await expect(page).toHaveURL(/\/tasks(\?|$)/, { timeout: 15_000 })
    await page.waitForTimeout(NAV_WATCHDOG_MS + 2_000)
    expect(toCms.at, 'timer cũ kéo về CMS sau khi đã đổi hướng').toEqual([])
    await expect(page).toHaveURL(/\/tasks(\?|$)/)
    noWrites(seen)
  })

  test('NAV2-05 nhấn tab CMS đang chọn khi RSC treo ⇒ không tải lại oan', async ({ page }) => {
    const seen = await trapWrites(page)
    await holdRsc(page, d.isTarget, 'cold')
    const loads = hardLoads(page, d.isTarget)
    await openSegment(page, DIRS.cms2kpi.from, 'cms')
    loads.start()
    await segLink(page, 'cms', 'CMS sản phẩm').click()
    await page.waitForTimeout(NAV_WATCHDOG_MS + 3_000)
    expect(loads.at, 'đã ở đích mà vẫn tải cứng').toEqual([])
    noWrites(seen)
  })

  test('NAV2-06 tab ẩn ⇒ không tải cứng; hiện lại ⇒ đếm lại đủ 6 s rồi mới tải cứng; Back / Forward dùng được', async ({ page }) => {
    const seen = await trapWrites(page)
    await holdRsc(page, d.isTarget, 'cold')
    const loads = hardLoads(page, d.isTarget)
    await openSegment(page, d.from, d.seg)
    loads.start()
    await segLink(page, 'kpi', 'CMS sản phẩm').click()
    await page.waitForTimeout(1_000)
    await setVisibility(page, 'hidden')
    await page.waitForTimeout(NAV_WATCHDOG_MS + 1_000)
    expect(loads.at, 'tab ẩn mà vẫn tải cứng').toEqual([])
    const tV = Date.now()
    await setVisibility(page, 'visible')
    await expect(page).toHaveURL((u) => d.isTarget(u), { timeout: NAV_WATCHDOG_MS + 15_000 })
    expect(Date.now() - tV, 'hiện lại chưa đủ mốc đã tải cứng').toBeGreaterThanOrEqual(NAV_WATCHDOG_MS - 200)
    await expect(page.locator(d.done)).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(1_500)
    expect(loads.at.length).toBe(1)
    await page.goBack()
    await expect(page).toHaveURL(/\/targets$/, { timeout: 15_000 })
    await expect(page.locator('main [data-cms-targets-segment="kpi"]')).toBeVisible({ timeout: 20_000 })
    await page.goForward()
    await expect(page).toHaveURL((u) => d.isTarget(u), { timeout: 15_000 })
    await expect(page.locator(d.done)).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(NAV_WATCHDOG_MS + 1_000)
    expect(loads.at.length, 'Back / Forward kéo theo tải cứng lặp').toBeLessThanOrEqual(2)
    await expect(page).toHaveURL((u) => d.isTarget(u))
    noWrites(seen)
  })

  test('NAV2-06 chạm CMS (treo) rồi Back về trang trước ⇒ segment unmount, không tải cứng CMS', async ({ page }) => {
    const seen = await trapWrites(page)
    await holdRsc(page, d.isTarget, 'cold')
    const loads = hardLoads(page, d.isTarget)
    await page.goto('/tasks')
    await expect(page, 'bị đẩy về /login ⇒ storageState hết hạn').toHaveURL(/\/tasks(\?|$)/)
    await page.waitForFunction(() => { const a = document.querySelector('[data-bottom-nav] a[href="/targets"]'); return !!a && Object.keys(a).some((k) => k.startsWith('__reactProps')) }, null, { timeout: 30_000 })
    await page.locator('[data-bottom-nav] a[href="/targets"]').first().click()   // vào /targets bằng điều hướng mềm ⇒ Back là traverse trong app
    await expect(page).toHaveURL(/\/targets$/, { timeout: 20_000 })
    await segmentReady(page, 'kpi', '/targets (từ BottomNav)')
    loads.start()
    await segLink(page, 'kpi', 'CMS sản phẩm').click()
    await page.waitForTimeout(1_000)
    await page.goBack()
    await expect(page).toHaveURL(/\/tasks(\?|$)/, { timeout: 15_000 })
    await page.waitForTimeout(NAV_WATCHDOG_MS + 2_000)
    expect(loads.at, 'đã Back mà timer vẫn tải cứng CMS').toEqual([])
    await expect(page).toHaveURL(/\/tasks(\?|$)/)
    noWrites(seen)
  })

  test('NAV2-07 phiên bị thu hồi lúc đang treo ⇒ tải cứng một lần, dừng ở /login, không lặp', async ({ page }) => {
    await holdRsc(page, d.isTarget, 'cold')
    const loads = hardLoads(page, d.isTarget)
    const logins: string[] = []
    page.on('request', (r) => { if (r.resourceType() === 'document' && urlOf(r.url()).pathname === '/login') logins.push(r.url()) })
    await openSegment(page, d.from, d.seg)
    loads.start()
    await segLink(page, 'kpi', 'CMS sản phẩm').click()
    await page.waitForTimeout(1_000)
    await page.context().clearCookies()
    await expect(page).toHaveURL(/\/login/, { timeout: NAV_WATCHDOG_MS + 15_000 })
    await page.waitForTimeout(5_000)
    expect(loads.at.length, 'tải cứng phải đúng một lần').toBe(1)
    expect(logins.length, 'vòng lặp /login').toBe(1)
    await expect(page).toHaveURL(/\/login/)
  })

  test('NAV2-07 chạm có phím bổ trợ (tab mới) ⇒ tab gốc không bị kéo sau mốc', async ({ page, context }) => {
    const seen = await trapWrites(page)
    const loads = hardLoads(page, d.isTarget)
    await openSegment(page, d.from, d.seg)
    loads.start()
    const popup = context.waitForEvent('page', { timeout: 10_000 }).catch(() => null)
    await segLink(page, 'kpi', 'CMS sản phẩm').click({ modifiers: ['Control'] })
    const p2 = await popup
    await p2?.close().catch(() => {})
    await page.waitForTimeout(NAV_WATCHDOG_MS + 2_000)
    expect(loads.at, 'tab gốc bị tải cứng sau chạm có phím bổ trợ').toEqual([])
    await expect(page).toHaveURL(/\/targets$/)
    noWrites(seen)
  })
})

// Lỗi THẬT (không giữ RSC): phiên đánh dấu hết hạn (expires_at quá khứ) — điều kiện NAV-1 làm treo tăng mạnh. Mỗi lượt context
// mới; chạm một lần phải tới CMS (mềm, hoặc watchdog gỡ treo đúng một lần), không lặp /login.
test.describe('NAV2-07 phiên hết hạn thật — chạm segment một lần luôn tới CMS @mobile', () => {
  test.skip(!CMS_ON, 'server chưa bật CMS_PROGRAM_ENABLED (E2E_CMS_ENABLED=1)')
  test.skip(!STAFF.email || !STAFF.password, 'E2E_STAFF_* chưa set')
  test.beforeEach(async ({}, testInfo) => {
    testInfo.skip(testInfo.project.name !== RUN_PROJECT, `chỉ chạy dưới project ${RUN_PROJECT}`)
    testInfo.setTimeout(300_000)
  })
  async function expiredContext(browser: Browser, baseURL: string): Promise<BrowserContext> {
    const sb = await sessionDb(STAFF.email!, STAFF.password!)
    const { data: { session } } = await sb.auth.getSession()
    expect(session, 'không lấy được phiên staff QA').toBeTruthy()
    const value = 'base64-' + Buffer.from(JSON.stringify({ ...session, expires_at: Math.floor(Date.now() / 1000) - 60 })).toString('base64url')
    const name = `sb-${new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split('.')[0]}-auth-token`
    const MAX = 3180
    const cookies = value.length <= MAX ? [{ name, value, url: baseURL }]
      : Array.from({ length: Math.ceil(value.length / MAX) }, (_, i) => ({ name: `${name}.${i}`, value: value.slice(i * MAX, (i + 1) * MAX), url: baseURL }))
    const ctx = await browser.newContext({ viewport: VW.m390, isMobile: true, hasTouch: true, baseURL })
    await ctx.addCookies(cookies)
    return ctx
  }
  test('4 lượt phiên hết hạn: mỗi lượt chạm KPI→CMS một lần đều tới CMS', async ({ browser }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL!
    const d = DIRS.kpi2cms
    const rounds: string[] = []
    for (let i = 0; i < 4; i++) {
      const ctx = await expiredContext(browser, baseURL)
      const page = await ctx.newPage()
      const seen = await trapWrites(page)
      const loads = hardLoads(page, d.isTarget)
      const logins: string[] = []
      page.on('request', (r) => { if (r.resourceType() === 'document' && urlOf(r.url()).pathname === '/login') logins.push(r.url()) })
      await openSegment(page, d.from, d.seg)
      loads.start()
      const t0 = Date.now()
      await segLink(page, d.seg, d.label).click()
      await expect(page, `lượt ${i + 1}: chạm không tới CMS`).toHaveURL((u) => d.isTarget(u), { timeout: NAV_WATCHDOG_MS + 15_000 })
      const dt = Date.now() - t0
      await expect(page.locator(d.done)).toBeVisible({ timeout: 20_000 })
      await page.waitForTimeout(1_500)
      if (dt < NAV_WATCHDOG_MS) expect(loads.at, `lượt ${i + 1}: điều hướng mềm ${dt} ms mà vẫn tải cứng`).toEqual([])
      else expect(loads.at.length, `lượt ${i + 1}: treo ${dt} ms — phải đúng một tải cứng`).toBe(1)
      expect(logins, `lượt ${i + 1}: bị đẩy /login`).toEqual([])
      noWrites(seen)
      rounds.push(`${dt}ms${loads.at.length ? '+tải cứng' : ''}`)
      await ctx.close()
    }
    testInfo.annotations.push({ type: 'nav-2 phiên hết hạn', description: rounds.join(' · ') })
  })
})

// Fixture (super, UI_CATALOG=1, dữ liệu giả, không DB) — chiều CMS→KPI có thời gian tất định cho ca mềm / chậm 3 s.
test.describe('NAV-2 segment — fixture /ui-catalog/cms-v2 (CMS→KPI tất định) @mobile', () => {
  test.use({ storageState: SUPER_STATE, viewport: VW.m390, isMobile: true, hasTouch: true })
  test.skip(!fs.existsSync(SUPER_STATE), 'chưa có phiên super')
  test.beforeEach(async ({}, testInfo) => {
    testInfo.skip(testInfo.project.name !== RUN_PROJECT, `chỉ chạy dưới project ${RUN_PROJECT}`)
    testInfo.setTimeout(120_000)
  })
  for (const delay of [undefined, 3_000] as const) {
    for (const mode of (delay === undefined ? ['cold'] : ['cold', 'warm']) as ('cold' | 'warm')[]) {
      test(`NAV2-0${delay === undefined ? 2 : 4} fixture CMS→KPI ${delay === undefined ? 'bình thường' : `chậm 3 s ${mode}`}: 0 tải cứng`, async ({ page }) => {
        const seen = await trapWrites(page)
        const h = delay === undefined ? null : await holdRsc(page, FX.isTarget, mode, delay)
        const loads = hardLoads(page, FX.isTarget)
        await openSegment(page, FX.from, 'cms')
        const link = segLink(page, 'cms', 'KPI chiến dịch')
        await expect(link).toHaveAttribute('href', FX.href)
        if (h && mode === 'warm') await waitPrefetch(page, h)
        loads.start()
        const t0 = Date.now()
        await link.click()
        await expect(page).toHaveURL((u) => FX.isTarget(u), { timeout: 15_000 })
        const dt = Date.now() - t0
        if (delay) expect(dt, 'RSC chậm 3 s mà URL đổi sớm hơn').toBeGreaterThanOrEqual(delay)
        expect(dt, `điều hướng mềm mất ${dt} ms — chạm mốc watchdog`).toBeLessThan(NAV_WATCHDOG_MS - 500)
        await expect(page.locator(FX.done)).toBeVisible({ timeout: 20_000 })
        await page.waitForTimeout(NAV_WATCHDOG_MS + 2_000 - dt)
        expect(loads.at, 'đã tới đích bằng điều hướng mềm mà vẫn tải cứng').toEqual([])
        noWrites(seen)
      })
    }
  }
  // Quan sát trace 08/11: prefetch về GIỮA lúc điều hướng ⇒ Next gửi lại RSC điều hướng lần hai ⇒ mềm ≈ 2 × độ trễ (> 6 s khi mỗi
  // request chậm 3 s) ⇒ watchdog tải cứng là ĐÚNG thiết kế (pending > mốc), không phải tải cứng trễ sau khi đã tới đích. Ca này
  // khoá: luôn tới đích, tải cứng ≤ 1, không lặp, không rời đích sau khi tới.
  test('NAV2-04 fixture CMS→KPI prefetch + RSC cùng chậm 3 s (prefetch về giữa chừng) ⇒ tới đích, tải cứng ≤ 1, không lặp', async ({ page }, testInfo) => {
    const seen = await trapWrites(page)
    await holdRsc(page, FX.isTarget, 'inflight', 3_000)
    const loads = hardLoads(page, FX.isTarget)
    await openSegment(page, FX.from, 'cms')
    loads.start()
    const t0 = Date.now()
    await segLink(page, 'cms', 'KPI chiến dịch').click()
    await expect(page).toHaveURL((u) => FX.isTarget(u), { timeout: 15_000 })
    const dt = Date.now() - t0
    await expect(page.locator(FX.done)).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(NAV_WATCHDOG_MS + 2_000)
    expect(loads.at.length, `tải cứng lặp (${loads.at.join(', ')} ms)`).toBeLessThanOrEqual(1)
    if (loads.at.length) expect(loads.at[0], 'tải cứng trước mốc').toBeGreaterThanOrEqual(NAV_WATCHDOG_MS - 200)
    else expect(dt, 'không tải cứng mà mềm vượt mốc').toBeLessThan(NAV_WATCHDOG_MS + 500)
    await expect(page).toHaveURL((u) => FX.isTarget(u))
    testInfo.annotations.push({ type: 'nav-2 prefetch giữa chừng', description: `tới đích ${dt} ms · tải cứng ${loads.at.length ? loads.at[0] + ' ms' : 'không'}` })
    noWrites(seen)
  })
})
