import { defineConfig, devices } from '@playwright/test'

// Mobile smoke config. Runs the staff-nav spec at two viewports so the
// no-horizontal-overflow assertion covers both the common 390px and the
// narrowest 360px (where the 5-tab bottom nav is most at risk of cramping).
// `npm run test:e2e` — see e2e/*.spec.ts for the required E2E_* env vars.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
  },
  projects: [
    // Chromium-engine devices so only `npx playwright install chromium` is needed.
    // (For real iOS Safari testing, add a webkit device + `install webkit`.)
    { name: 'mobile-390', use: { ...devices['Pixel 5'] } },
    { name: 'mobile-360', use: { ...devices['Galaxy S9+'], viewport: { width: 360, height: 800 } } },
  ],
})
