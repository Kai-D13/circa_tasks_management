import { test, expect, type Page } from '@playwright/test'

// Component-catalog visual baseline (P1.4) — the COMMITTED long-term visual
// regression. /ui-catalog renders 100% mock fixtures (no PII) and is deterministic,
// so fullPage snapshots are stable across days (unlike route-shell baseline).
// Server must run with UI_CATALOG=1 (production/Coolify never sets it → 404).
// Env: E2E_SUPER_EMAIL/PASSWORD (the page is super-admin-gated); skips if unset.

const SUPER = { email: process.env.E2E_SUPER_EMAIL, password: process.env.E2E_SUPER_PASSWORD }
const STAFF = { email: process.env.E2E_STAFF_EMAIL, password: process.env.E2E_STAFF_PASSWORD }
const THEMES = ['light', 'dark'] as const

async function login(page: Page) {
  // Hydration under 4 parallel browser projects can reset controlled inputs
  // AFTER a successful-looking fill (webkit caught submitting an empty form).
  // /login is pre-auth → no pollers → networkidle is safe here as a hydration
  // signal; then the whole fill→verify→submit→redirect block retries as one
  // unit until the redirect actually happens.
  await page.goto('/login')
  await page.waitForLoadState('networkidle')
  await expect(async () => {
    await page.fill('#email', SUPER.email!)
    await page.fill('#password', SUPER.password!)
    await page.waitForTimeout(150)
    expect(await page.inputValue('#email')).toBe(SUPER.email)
    expect(await page.inputValue('#password')).toBe(SUPER.password)
    await page.getByRole('button', { name: /sign in/i }).click()
    // 'commit' — URL change is enough; super lands on /dashboard (heaviest
    // page) and webkit under 4-project load can exceed a 'load' wait.
    await page.waitForURL(/\/(tasks|dashboard|targets|fs)/, { timeout: 10_000, waitUntil: 'commit' })
  }).toPass({ timeout: 60_000, intervals: [1_000, 2_000, 3_000] })
}


async function snapCatalog(page: Page, theme: (typeof THEMES)[number]) {
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.goto('/ui-catalog')
  await page.waitForFunction(
    (t) => document.documentElement.classList.contains('dark') === (t === 'dark'),
    theme, { timeout: 10_000 },
  )
  const cat = page.getByTestId('ui-catalog')
  await cat.waitFor({ state: 'visible', timeout: 15_000 })
  // r1.2 (P0): capture ONLY the catalog root element — the app shell
  // (sidebar/header) renders the REAL logged-in profile (name/email = PII)
  // and leaked into the committed desktop snapshot. Shell bars are hidden
  // test-only: the fixed BottomNav overlays the element region while the tall
  // capture scrolls (P1). NOTE: only the SHELL bars — the catalog itself has a
  // <nav> (FilterTabs), so we target the app bars precisely.
  await page.evaluate(() => {
    // nextjs-portal = the black "N" Next.js indicator (renders even on npm
    // start locally) — an environment artifact, not app UI; hide it too.
    // Precise SHELL selectors only (r1.3): a future catalog demo could use
    // <header>/<aside> itself — target the app bars by their identity classes.
    document.querySelectorAll('header.bg-primary, aside.bg-sidebar, nav[aria-label="Điều hướng chính"], nextjs-portal').forEach((el) => {
      ;(el as HTMLElement).style.display = 'none'
    })
    const main = document.querySelector('main')
    const outer = main?.parentElement
    if (outer instanceof HTMLElement) { outer.style.height = 'auto'; outer.style.overflow = 'visible' }
    if (main instanceof HTMLElement) { main.style.overflow = 'visible' }
  })
  // r1.2 (P2): hard guards so viewport-only capture can never regress silently:
  // the LAST section (DetailPageShell) must exist inside the catalog root, and
  // the catalog must be taller than the viewport BEFORE we screenshot it.
  await cat.getByRole('heading', { name: /DetailPageShell/ }).waitFor({ timeout: 10_000 })
  const vp = page.viewportSize()!
  const box = await cat.boundingBox()
  expect(box!.height).toBeGreaterThan(vp.height)
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(250) // paint settle AFTER conditions (secondary only)
  expect(await cat.screenshot()).toMatchSnapshot(`catalog-${theme}.png`, {
    maxDiffPixelRatio: 0.01,
  })
}


for (const tag of ['@desktop', '@mobile'] as const) {
  test.describe(`ui catalog ${tag}`, () => {
    test.skip(!SUPER.email || !SUPER.password, 'E2E_SUPER_* not set')
    test(`catalog light+dark ${tag}`, async ({ page }) => {
      test.setTimeout(120_000)
      await login(page)
      for (const theme of THEMES) await snapCatalog(page, theme)
    })
  })
}

// ── DS guardrail assertions (P1 r1) — computed values, not class names ──────
test.describe('ds guardrails @mobile', () => {
  test.skip(!SUPER.email || !SUPER.password, 'E2E_SUPER_* not set')
  test('touch targets ≥44px + card radius ≤8px on mobile', async ({ page }) => {
    test.setTimeout(120_000)
    await login(page)
    await page.goto('/ui-catalog')
    await page.getByTestId('ui-catalog').waitFor({ state: 'visible', timeout: 15_000 })

    // FilterTabs pill (mobile): real height ≥44px
    const tab = page.locator('nav[aria-label="Bộ lọc"] a').first()
    expect((await tab.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    // Simple-pagination Trước/Tiếp: ≥44px
    const prev = page.getByRole('link', { name: 'Trang trước' }).last()
    expect((await prev.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    // ALL DS card surfaces on the catalog: computed border-radius ≤8px (r1.1)
    const radii = await page
      .locator('[data-slot="card"]')
      .evaluateAll((els) => els.map((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius)))
    expect(radii.length).toBeGreaterThan(0)
    for (const r of radii) expect(r).toBeLessThanOrEqual(8)
    // DetailPageShell back-link hit area ≥44px on mobile (r1.1)
    const back = page.getByRole('link', { name: 'Danh sách phiếu' })
    expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    // aria-current="page" semantics on the active tab
    await page.locator('nav[aria-label="Bộ lọc"] a[aria-current="page"]').first().waitFor()
    // r1.3: EVERY form control on the catalog must render ≥16px real font on
    // mobile (root is 15px — iOS zooms anything under 16).
    const fonts = await page
      .locator('main input, main select, main textarea')
      .evaluateAll((els) => els.map((el) => parseFloat(getComputedStyle(el).fontSize)))
    expect(fonts.length).toBeGreaterThan(0)
    for (const f of fonts) expect(f).toBeGreaterThanOrEqual(16)
    // r1.3: action buttons (PageHeader + DataToolbar) ≥44px on mobile
    const actionBtn = page.getByRole('button', { name: 'Action' })
    expect((await actionBtn.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    const apply = page.getByText('Áp dụng', { exact: true })
    expect((await apply.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  })
})

// Access guardrail: even WITH UI_CATALOG=1 on the server, a non-super user
// must get a 404 (the env-absent → 404 case is covered by the prod-like
// manual check in UI_VISUAL_QA — a same-server test can't unset server env).
test.describe('catalog access @desktop', () => {
  test.skip(!STAFF.email || !STAFF.password, 'E2E_STAFF_* not set')
  test('staff gets 404 on /ui-catalog', async ({ page }) => {
    await page.goto('/login')
    await expect(async () => {
      await page.fill('#email', STAFF.email!)
      await page.fill('#password', STAFF.password!)
      await page.waitForTimeout(150)
      expect(await page.inputValue('#email')).toBe(STAFF.email)
      await page.getByRole('button', { name: /sign in/i }).click()
      await page.waitForURL(/\/(tasks|dashboard|targets|fs)/, { timeout: 8_000, waitUntil: 'commit' })
    }).toPass({ timeout: 60_000, intervals: [1_000, 2_000] })
    await page.goto('/ui-catalog')
    await page.getByRole('heading', { name: '404' }).waitFor({ timeout: 15_000 })
  })
})
