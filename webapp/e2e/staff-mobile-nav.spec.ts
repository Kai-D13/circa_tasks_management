import { test, expect } from '@playwright/test'

// Staff mobile smoke: login → tap all 5 bottom-nav tabs → each navigates,
// marks itself aria-current="page", and the page never scrolls horizontally.
// Requires a STAFF test account via env: E2E_STAFF_EMAIL / E2E_STAFF_PASSWORD
// (optional E2E_BASE_URL, default http://localhost:3000). Without them the
// suite skips instead of failing — safe on CI until the account is provisioned.

const EMAIL = process.env.E2E_STAFF_EMAIL
const PASSWORD = process.env.E2E_STAFF_PASSWORD

const TABS = [
  { label: 'Tasks', path: '/tasks' },
  { label: 'Doanh số', path: '/targets' },
  { label: 'Toa thuốc', path: '/prescriptions' },
  { label: 'Bảng tin', path: '/announcements' },
  { label: 'Tồn kho', path: '/inventory' },
]

test.describe('staff bottom nav', () => {
  test.skip(!EMAIL || !PASSWORD, 'E2E_STAFF_EMAIL / E2E_STAFF_PASSWORD not set')

  test('5 tabs navigate, mark active, no horizontal overflow', async ({ page }) => {
    await page.goto('/login')
    await page.fill('#email', EMAIL!)
    await page.fill('#password', PASSWORD!)
    await page.getByRole('button', { name: /sign in/i }).click()
    await page.waitForURL(/\/(tasks|dashboard|targets)/, { timeout: 20_000 })

    const nav = page.getByRole('navigation', { name: 'Điều hướng chính' })
    await expect(nav).toBeVisible()
    // Staff must NOT have a "Thêm" overflow button (5 direct tabs).
    await expect(nav.getByRole('button', { name: 'Thêm' })).toHaveCount(0)

    for (const tab of TABS) {
      // force: true — in `next dev` the dev-tools portal (<nextjs-portal>) floats
      // over the bottom-left, intercepting clicks on the first tab. It doesn't
      // exist in production, so a forced click reflects the real prod behaviour.
      await nav.getByRole('link', { name: tab.label }).click({ force: true })
      await page.waitForURL(`**${tab.path}**`)
      await expect(nav.getByRole('link', { name: tab.label })).toHaveAttribute('aria-current', 'page')
      const noOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      )
      expect(noOverflow, `horizontal overflow on ${tab.path}`).toBe(true)
    }
  })
})
