import { test, expect, type Browser, type Locator, type Page, type Request } from '@playwright/test'
import { STAFF_STATE } from './authState'
import { must, sessionDb } from './dbFixtures'
import { NAV_WATCHDOG_MS, internalTarget, isAtTarget } from '../lib/nav/watchdog'

// ─────────────────────────────────────────────────────────────────────────────
// NAV-1 (PM 26/10/2026 — planning/reviews/2026-10-26-kpi-nav-pk1-audit-pm.md §1): watchdog thẻ chiến dịch staff /targets.
// Lỗi gốc (report 2026-10-26-kpi-nav-trace-pk1 §3): chạm thẻ → RSC về đủ nhưng React giữ transition treo vô hạn, URL không đổi —
// nhất là khi access token vừa hết hạn. Watchdog: link pending quá NAV_WATCHDOG_MS lúc trang hiển thị ⇒ tải cứng đích MỘT lần.
//
// "Treo" được dựng TẤT ĐỊNH bằng cách giữ request RSC tới chi tiết (page.route không trả) — điều hướng mềm pending mãi, đúng
// trạng thái người dùng thấy; request TÀI LIỆU (tải cứng) vẫn đi qua. Đếm tải cứng = số request document tới `?campaign=`.
// Ca "phiên hết hạn" chạy lỗi THẬT (không giữ RSC) nhiều lượt: lượt nào treo phải được watchdog gỡ.
// ─────────────────────────────────────────────────────────────────────────────

const STAFF = { email: process.env.E2E_STAFF_EMAIL, password: process.env.E2E_STAFF_PASSWORD }
const RUN_PROJECT = 'mobile-390'   // viewport do test đặt — chạy một project là đủ (cùng lý do campaign-detail-mobile)
const VIEWPORT = { width: 390, height: 844 }
const CARD = 'main [data-campaign-card-list] a[href*="campaign="]'
const TO_DETAIL = /[?&]campaign=/

const isRsc = (r: Request) => r.headers()['rsc'] === '1'
// Chỉ tài liệu /targets?…campaign= — proxy chuyển /login GIỮ query (`/login?campaign=…`), không được tính là tải cứng tới đích.
const isCampaignDoc = (r: Request) => r.resourceType() === 'document' && new URL(r.url()).pathname === '/targets' && TO_DETAIL.test(r.url())

/** Chiến dịch đang chạy của store staff QA theo RLS của chính phiên staff — chỉ dùng để quyết skip ca cần ≥ 2 thẻ. */
async function rlsActiveCampaigns(): Promise<number> {
  const sb = await sessionDb(STAFF.email!, STAFF.password!)
  const { data: { user } } = await sb.auth.getUser()
  const me = must(await sb.from('users').select('store_id').eq('id', user!.id).single(), 'users (tự đọc)') as { store_id: string | null }
  expect(me.store_id, 'tài khoản staff QA không gắn cửa hàng').toBeTruthy()
  const rows = must(await sb.from('kpi_campaign_store_targets').select('campaign:kpi_campaigns!inner(id)')
    .eq('store_id', me.store_id!).is('campaign.archived_at', null), 'kpi_campaign_store_targets (RLS staff)')
  return rows.length
}

async function landing(page: Page): Promise<Locator> {
  await page.goto('/targets')
  await expect(page, 'bị đẩy về /login ⇒ storageState hết hạn').toHaveURL(/\/targets(\?|$)/)
  const cards = page.locator(CARD)
  await expect(cards.first(), '/targets không hiện thẻ chiến dịch').toBeAttached({ timeout: 20_000 })
  return cards
}
async function tap(card: Locator) {
  await card.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await card.click()
}
/** Ghi query của mọi lần tải cứng tới chi tiết (request document `?campaign=`). */
function hardLoads(page: Page): string[] {
  const out: string[] = []
  page.on('request', (r) => { if (isCampaignDoc(r)) out.push(new URL(r.url()).search) })
  return out
}
/** Giữ RSC tới chi tiết ⇒ điều hướng mềm treo vô hạn; tài liệu (tải cứng) đi qua. `delayMs` ⇒ chậm rồi mới cho qua. */
async function holdDetailRsc(page: Page, delayMs?: number) {
  await page.route(TO_DETAIL, async (route) => {
    if (!isRsc(route.request())) return route.continue()
    if (delayMs === undefined) return   // không trả ⇒ treo
    await new Promise((r) => setTimeout(r, delayMs))
    return route.continue().catch(() => {})
  })
}
async function setVisibility(page: Page, state: 'hidden' | 'visible') {
  await page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => s === 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)
}
const searchOf = (href: string) => new URL(href, 'http://x').search

test.describe('NAV-1 watchdog thẻ chiến dịch @mobile', () => {
  test.use({ storageState: STAFF_STATE, viewport: VIEWPORT })
  test.skip(!STAFF.email || !STAFF.password, 'E2E_STAFF_* chưa set')
  test.beforeEach(async ({}, testInfo) => {
    testInfo.skip(testInfo.project.name !== RUN_PROJECT, `chỉ chạy dưới project ${RUN_PROJECT}`)
    testInfo.setTimeout(120_000)
  })

  test('hàm thuần: chỉ href nội bộ cùng origin; đích = path + query', async () => {
    const o = 'http://localhost:3130'
    expect(internalTarget('/targets?campaign=1', o)?.pathname).toBe('/targets')
    for (const bad of ['https://zalo.me/123', '//evil.example/x', 'tel:0900000000', 'sms:0900000000', 'targets?x=1', 'javascript:alert(1)',
      '/.//evil.example', '/\\evil.example', '/\t/evil.example']) {
      expect(internalTarget(bad, o), bad).toBeNull()
    }
    const t = internalTarget('/targets?campaign=1', o)!
    expect(isAtTarget(t, { pathname: '/targets', search: '?campaign=1' })).toBe(true)
    expect(isAtTarget(t, { pathname: '/targets', search: '' })).toBe(false)
    expect(NAV_WATCHDOG_MS).toBe(6000)
  })

  test('điều hướng mềm bình thường: không tải cứng', async ({ page }) => {
    const loads = hardLoads(page)
    const cards = await landing(page)
    const t0 = Date.now()
    await tap(cards.first())
    await expect(page).toHaveURL(TO_DETAIL, { timeout: NAV_WATCHDOG_MS + 15_000 })
    const dt = Date.now() - t0
    await page.waitForTimeout(NAV_WATCHDOG_MS + 1_500)
    // Lỗi treo thật vẫn có thể rơi đúng lượt này (~2 % phiên mới) — khi đó URL chỉ đổi nhờ watchdog (≥ 6 s, đúng 1 tải cứng).
    if (dt < NAV_WATCHDOG_MS) expect(loads, `điều hướng mềm xong sau ${dt} ms mà vẫn tải cứng`).toEqual([])
    else expect(loads.length, `URL đổi sau ${dt} ms — phải là đúng một tải cứng của watchdog`).toBe(1)
  })

  test('mạng chậm 3 s nhưng điều hướng mềm xong ⇒ huỷ timer, không tải cứng', async ({ page }) => {
    await holdDetailRsc(page, 3_000)
    const loads = hardLoads(page)
    const cards = await landing(page)
    const t0 = Date.now()
    await tap(cards.first())
    await expect(cards.first().locator('[data-nav-pending]'), 'không hiện trạng thái chờ khi pending').toBeAttached({ timeout: 2_000 })
    await expect(page).toHaveURL(TO_DETAIL, { timeout: NAV_WATCHDOG_MS + 15_000 })
    const dt = Date.now() - t0
    await page.waitForTimeout(Math.max(0, NAV_WATCHDOG_MS + 2_000 - (Date.now() - t0)))
    if (dt < NAV_WATCHDOG_MS) expect(loads, `điều hướng mềm xong sau ${dt} ms mà vẫn tải cứng`).toEqual([])
    else expect(loads.length).toBe(1)
  })

  test('RSC treo ⇒ sau 6 s tải cứng đúng MỘT lần tới đích; quay lại về danh sách', async ({ page }) => {
    await holdDetailRsc(page)
    const loads = hardLoads(page)
    const cards = await landing(page)
    const href = (await cards.first().getAttribute('href'))!
    const t0 = Date.now()
    await tap(cards.first())
    await expect(cards.first().locator('[data-nav-pending]'), 'không hiện trạng thái chờ khi pending').toBeAttached({ timeout: 2_000 })
    await page.waitForTimeout(NAV_WATCHDOG_MS - 1_000)
    expect(loads, 'tải cứng sớm hơn mốc watchdog').toEqual([])
    await expect(page).toHaveURL(TO_DETAIL, { timeout: 15_000 })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(NAV_WATCHDOG_MS - 200)
    await expect(page.getByRole('link', { name: /Danh sách chiến dịch/ }).first(), 'tải cứng không tới trang chi tiết').toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(2_000)
    expect(loads, 'phải đúng một tải cứng, đúng đích').toEqual([searchOf(href)])
    await page.goBack()
    await expect(page).toHaveURL(/\/targets$/, { timeout: 15_000 })
    await expect(page.locator(CARD).first()).toBeAttached({ timeout: 20_000 })
  })

  test('chạm thẻ A rồi thẻ B khi cả hai treo ⇒ chỉ B được tải cứng', async ({ page }) => {
    const n = await rlsActiveCampaigns()
    test.skip(n < 2, `store staff QA có ${n} chiến dịch đang chạy (RLS) — ca cần ≥ 2 thẻ`)
    await holdDetailRsc(page)
    const loads = hardLoads(page)
    const cards = await landing(page)
    await expect(cards, `RLS thấy ${n} chiến dịch mà trang không đủ thẻ`).toHaveCount(n, { timeout: 20_000 })
    const hrefB = (await cards.nth(1).getAttribute('href'))!
    await tap(cards.nth(0))
    await page.waitForTimeout(2_000)
    const tB = Date.now()
    await tap(cards.nth(1))
    await expect(page).toHaveURL(new RegExp(searchOf(hrefB).replace(/[?]/g, '\\?')), { timeout: NAV_WATCHDOG_MS + 15_000 })
    expect(Date.now() - tB).toBeGreaterThanOrEqual(NAV_WATCHDOG_MS - 200)
    await page.waitForTimeout(2_000)
    expect(loads, 'chỉ link chạm sau cùng được tải cứng').toEqual([searchOf(hrefB)])
  })

  test('tab ẩn ⇒ huỷ đếm; hiện lại ⇒ đếm lại đủ 6 s rồi mới tải cứng', async ({ page }) => {
    await holdDetailRsc(page)
    const loads = hardLoads(page)
    const cards = await landing(page)
    await tap(cards.first())
    await page.waitForTimeout(1_000)
    await setVisibility(page, 'hidden')
    await page.waitForTimeout(NAV_WATCHDOG_MS + 1_000)
    expect(loads, 'tab ẩn mà vẫn tải cứng').toEqual([])
    const tV = Date.now()
    await setVisibility(page, 'visible')
    await expect(page).toHaveURL(TO_DETAIL, { timeout: NAV_WATCHDOG_MS + 15_000 })
    expect(Date.now() - tV).toBeGreaterThanOrEqual(NAV_WATCHDOG_MS - 200)
    expect(loads.length).toBe(1)
  })

  test('phiên bị thu hồi lúc đang treo ⇒ tải cứng một lần, dừng ở /login, không lặp', async ({ page }) => {
    await holdDetailRsc(page)
    const loads = hardLoads(page)
    const cards = await landing(page)
    await tap(cards.first())
    await page.waitForTimeout(1_000)
    await page.context().clearCookies()
    await expect(page).toHaveURL(/\/login/, { timeout: NAV_WATCHDOG_MS + 15_000 })
    await page.waitForTimeout(4_000)
    expect(loads.length, 'tải cứng phải đúng một lần').toBe(1)
    await expect(page).toHaveURL(/\/login/)
  })
})

// Lỗi THẬT (không giữ RSC): phiên đánh dấu hết hạn (expires_at quá khứ) — điều kiện làm lỗi treo tăng mạnh. Mỗi lượt context
// mới + đăng nhập mới (không đụng storageState dùng chung). Lượt nào treo thì watchdog phải đưa tới chi tiết.
test.describe('NAV-1 phiên hết hạn — chạm một lần luôn tới chi tiết @mobile', () => {
  test.skip(!STAFF.email || !STAFF.password, 'E2E_STAFF_* chưa set')
  test.beforeEach(async ({}, testInfo) => {
    testInfo.skip(testInfo.project.name !== RUN_PROJECT, `chỉ chạy dưới project ${RUN_PROJECT}`)
    testInfo.setTimeout(300_000)
  })

  async function expiredContext(browser: Browser, baseURL: string) {
    const sb = await sessionDb(STAFF.email!, STAFF.password!)
    const { data: { session } } = await sb.auth.getSession()
    expect(session, 'không lấy được phiên staff QA').toBeTruthy()
    const value = 'base64-' + Buffer.from(JSON.stringify({ ...session, expires_at: Math.floor(Date.now() / 1000) - 60 })).toString('base64url')
    const name = `sb-${new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split('.')[0]}-auth-token`
    const MAX = 3180   // @supabase/ssr chia cookie dài thành <tên>.0, <tên>.1, …
    const cookies = value.length <= MAX ? [{ name, value, url: baseURL }]
      : Array.from({ length: Math.ceil(value.length / MAX) }, (_, i) => ({ name: `${name}.${i}`, value: value.slice(i * MAX, (i + 1) * MAX), url: baseURL }))
    const ctx = await browser.newContext({ viewport: VIEWPORT, isMobile: true, hasTouch: true, baseURL })
    await ctx.addCookies(cookies)
    return ctx
  }

  test('6 lượt phiên hết hạn: mỗi lượt chạm một lần đều tới chi tiết', async ({ browser }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL!
    const rounds: string[] = []
    for (let i = 0; i < 6; i++) {
      const ctx = await expiredContext(browser, baseURL)
      const page = await ctx.newPage()
      const loads = hardLoads(page)
      const cards = await landing(page)
      const t0 = Date.now()
      await tap(cards.first())
      await expect(page, `lượt ${i + 1}: chạm không tới chi tiết`).toHaveURL(TO_DETAIL, { timeout: NAV_WATCHDOG_MS + 15_000 })
      const dt = Date.now() - t0
      await expect(page.getByRole('link', { name: /Danh sách chiến dịch/ }).first()).toBeVisible({ timeout: 20_000 })
      if (dt < NAV_WATCHDOG_MS) expect(loads, `lượt ${i + 1}: điều hướng mềm ${dt} ms mà vẫn tải cứng`).toEqual([])
      else expect(loads.length, `lượt ${i + 1}: treo ${dt} ms — phải đúng một tải cứng`).toBe(1)
      rounds.push(`${dt}ms${loads.length ? '+tải cứng' : ''}`)
      await ctx.close()
    }
    testInfo.annotations.push({ type: 'nav-1 lượt', description: rounds.join(' · ') })
  })
})
