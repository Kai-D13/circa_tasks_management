import { expect, test, type Page } from '@playwright/test'

// PILOT AFTER-CAPTURE (QA-process fix, Pilot-1 review P1): writes standalone
// PNGs via page.screenshot({ path }) — ALWAYS overwrites, no comparison
// threshold, so an unchanged-looking baseline can never masquerade as "after"
// evidence (--update-snapshots only rewrites FAILING snapshots; a sub-1% diff
// silently kept the old file → before/after hashes were identical).
// Run against a DEDICATED fresh server to guarantee the commit being captured:
//   npm run build && ($env:PORT='3010'; $env:UI_CATALOG='1'; npm start)
//   $env:E2E_BASE_URL='http://localhost:3010'; npx playwright test e2e/ui-pilot-capture.spec.ts
// Output: e2e/__screenshots__/pilot-after/<route>-<theme>.png (gitignored,
// local evidence).
//
// COMPARABLE before/after (Pilot-1 review r1.4 P1): the BEFORE set must be
// produced by THIS SAME spec (same <main> element crop, same themes, same DB)
// against a server built from the pre-migration commit:
//   git checkout <main-commit> && npm run build && PORT=3011 npm start
//   PILOT_CAPTURE_DIR=e2e/__screenshots__/pilot-before E2E_BASE_URL=http://localhost:3011 \
//     npx playwright test e2e/ui-pilot-capture.spec.ts -g "capture pilot routes"
// Only then are dimensions/hashes meaningful. A viewport shot vs an element
// shot ALWAYS hash-differs and proves nothing.

const SUPER = { email: process.env.E2E_SUPER_EMAIL, password: process.env.E2E_SUPER_PASSWORD }
const STAFF = { email: process.env.E2E_STAFF_EMAIL, password: process.env.E2E_STAFF_PASSWORD }
const OUT_DIR = process.env.PILOT_CAPTURE_DIR ?? 'e2e/__screenshots__/pilot-after'
const THEMES = ['light', 'dark'] as const
// Pilot routes — extend per pilot/wave.
const ROUTES: [string, string, string][] = [
  ['/stores', 'stores', 'Danh sách cửa hàng'],
  ['/tasks', 'tasks', 'Danh sách Tasks'],
]

async function login(page: Page, who: { email?: string; password?: string } = SUPER) {
  await page.goto('/login')
  await page.waitForLoadState('networkidle')
  await page.fill('#email', who.email!)
  await page.fill('#password', who.password!)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL(/\/(tasks|dashboard|targets|fs)/, { timeout: 20_000, waitUntil: 'commit' })
}

// Test-only: unlock the nested dashboard scroll so <main> captures full-height,
// and hide overlays that would bake into the element shot (Next dev indicator;
// on mobile the fixed BottomNav, which would smear mid-image once main grows).
async function unlockForCapture(page: Page, { hideBottomNav = false } = {}) {
  await page.evaluate((hideNav) => {
    const main = document.querySelector('main')
    const outer = main?.parentElement
    if (outer instanceof HTMLElement) { outer.style.height = 'auto'; outer.style.overflow = 'visible' }
    if (main instanceof HTMLElement) { main.style.overflow = 'visible' }
    document.querySelectorAll('nextjs-portal').forEach((el) => { (el as HTMLElement).style.display = 'none' })
    if (hideNav) {
      document.querySelectorAll<HTMLElement>('nav[aria-label="Điều hướng chính"]').forEach((el) => { el.style.display = 'none' })
    }
  }, hideBottomNav)
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(250)
}

test.describe('pilot after-capture @desktop', () => {
  test.skip(!SUPER.email || !SUPER.password, 'E2E_SUPER_* not set')
  test('capture pilot routes light+dark', async ({ page }) => {
    test.setTimeout(180_000)
    await login(page)
    for (const theme of THEMES) {
      await page.evaluate((t) => localStorage.setItem('theme', t), theme)
      for (const [route, name, heading] of ROUTES) {
        await page.goto(route)
        await page.waitForFunction(
          (t) => document.documentElement.classList.contains('dark') === (t === 'dark'),
          theme, { timeout: 10_000 },
        )
        await page.waitForFunction(
          (h) => [...document.querySelectorAll('h1')].some((el) => (el.textContent ?? '').normalize('NFC').toLowerCase().includes(h)),
          heading.normalize('NFC').toLowerCase(), { timeout: 15_000 },
        )
        // Shoot <main> only (excludes sidebar profile).
        await unlockForCapture(page)
        await page.locator('main').screenshot({ path: `${OUT_DIR}/${name}-${theme}.png` })
      }
    }
  })

  // Long-text proof (review r1.4 P2): real data has no 120-char store name, so
  // simulate one via TEST-ONLY DOM mutation (server-rendered page — no React
  // re-render will undo it; production data untouched). Targets rows that
  // already carry badges so name+badge coexistence is exercised.
  test('long store name + badges: truncate, no body overflow', async ({ page }) => {
    test.setTimeout(120_000)
    await login(page)
    await page.goto('/stores')
    await page.waitForFunction(
      () => [...document.querySelectorAll('h1')].some((el) => (el.textContent ?? '').normalize('NFC').toLowerCase().includes('danh sách cửa hàng')),
      undefined, { timeout: 15_000 },
    )
    const LONG = 'Nhà thuốc CIRCA chi nhánh Vinhomes Grand Park phân khu The Rainbow toà S1.01 khối đế thương mại số 120-122 đường Nguyễn Xiển nối dài'
    const mutated = await page.evaluate((longName) => {
      // Name spans carry title= (truncate contract). Mutate the first row plus
      // every row that has a badge next to the name (FS / Ngừng hoạt động).
      const spans = [...document.querySelectorAll<HTMLElement>('main tbody span.truncate[title]')]
      const targets = spans.filter((s, i) => i === 0 || s.parentElement!.querySelector('span:not(.truncate)'))
      targets.forEach((s) => { s.textContent = longName; s.title = longName; s.dataset.longtext = '1' })
      return targets.length
    }, LONG)
    expect(mutated).toBeGreaterThan(0)
    // Truncation must engage on EVERY mutated row (content wider than the box) …
    const truncating = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('main tbody span.truncate[data-longtext]')]
        .filter((s) => s.scrollWidth > s.clientWidth + 1).length,
    )
    expect(truncating).toBe(mutated)
    // … and the BODY must not scroll horizontally (the table wrapper may).
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }))
    expect(overflow.doc).toBeLessThanOrEqual(1)
    await unlockForCapture(page)
    await page.locator('main').screenshot({ path: `${OUT_DIR}/stores-longtext-light.png` })
  })
})

// Pilot 2: staff on mobile is THE primary persona for /tasks. Captures the
// staff flat list (pending + done) on the mobile-390 project. BottomNav is
// hidden test-only (fixed overlay would smear into the tall element shot);
// no-horizontal-overflow is asserted before hiding anything.
test.describe('pilot after-capture staff @mobile', () => {
  test.skip(!STAFF.email || !STAFF.password, 'E2E_STAFF_* not set')
  test('capture /tasks staff mobile light+dark + done view', async ({ page }) => {
    // Both mobile projects match @mobile; capture once at the canonical 390
    // width (360/430 = manual stakeholder QA per the Pilot-2 review).
    test.skip(test.info().project.name !== 'mobile-390', 'mobile-390 captures only')
    test.setTimeout(180_000)
    await login(page, STAFF)
    for (const theme of THEMES) {
      await page.evaluate((t) => localStorage.setItem('theme', t), theme)
      await page.goto('/tasks')
      await page.waitForFunction(
        (t) => document.documentElement.classList.contains('dark') === (t === 'dark'),
        theme, { timeout: 10_000 },
      )
      await page.waitForFunction(
        () => [...document.querySelectorAll('h1')].some((el) => (el.textContent ?? '').normalize('NFC').toLowerCase().includes('danh sách tasks')),
        undefined, { timeout: 15_000 },
      )
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow).toBeLessThanOrEqual(1)
      await unlockForCapture(page, { hideBottomNav: true })
      await page.locator('main').screenshot({ path: `${OUT_DIR}/tasks-staff-390-${theme}.png` })
    }
    // Done view, light only — enough to show the history layout + pager.
    await page.evaluate(() => localStorage.setItem('theme', 'light'))
    await page.goto('/tasks?view=done')
    await page.waitForFunction(
      () => [...document.querySelectorAll('h1')].some((el) => (el.textContent ?? '').normalize('NFC').toLowerCase().includes('danh sách tasks')),
      undefined, { timeout: 15_000 },
    )
    await unlockForCapture(page, { hideBottomNav: true })
    await page.locator('main').screenshot({ path: `${OUT_DIR}/tasks-staff-390-done-light.png` })
  })
})
