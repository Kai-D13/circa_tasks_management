import { test, type Page } from '@playwright/test'

// PILOT AFTER-CAPTURE (QA-process fix, Pilot-1 review P1): writes standalone
// PNGs via page.screenshot({ path }) — ALWAYS overwrites, no comparison
// threshold, so an unchanged-looking baseline can never masquerade as "after"
// evidence (--update-snapshots only rewrites FAILING snapshots; a sub-1% diff
// silently kept the old file → before/after hashes were identical).
// Run against a DEDICATED fresh server to guarantee the commit being captured:
//   npm run build && ($env:PORT='3010'; $env:UI_CATALOG='1'; npm start)
//   $env:E2E_BASE_URL='http://localhost:3010'; npx playwright test e2e/ui-pilot-capture.spec.ts
// Output: e2e/__screenshots__/pilot-after/<route>-<theme>.png (gitignored,
// local evidence). Verify SHA-256 differs from pilot-before before review.

const SUPER = { email: process.env.E2E_SUPER_EMAIL, password: process.env.E2E_SUPER_PASSWORD }
const THEMES = ['light', 'dark'] as const
// Pilot routes — extend per pilot/wave.
const ROUTES: [string, string, string][] = [
  ['/stores', 'stores', 'Danh sách cửa hàng'],
]

async function login(page: Page) {
  await page.goto('/login')
  await page.waitForLoadState('networkidle')
  await page.fill('#email', SUPER.email!)
  await page.fill('#password', SUPER.password!)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL(/\/(tasks|dashboard|targets|fs)/, { timeout: 20_000, waitUntil: 'commit' })
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
        // Unlock the nested dashboard scroll (test-only) so the full route
        // content is captured, then shoot <main> (excludes sidebar profile).
        await page.evaluate(() => {
          const main = document.querySelector('main')
          const outer = main?.parentElement
          if (outer instanceof HTMLElement) { outer.style.height = 'auto'; outer.style.overflow = 'visible' }
          if (main instanceof HTMLElement) { main.style.overflow = 'visible' }
          document.querySelectorAll('nextjs-portal').forEach((el) => { (el as HTMLElement).style.display = 'none' })
        })
        await page.evaluate(() => document.fonts.ready)
        await page.waitForTimeout(250)
        await page.locator('main').screenshot({ path: `e2e/__screenshots__/pilot-after/${name}-${theme}.png` })
      }
    }
  })
})
