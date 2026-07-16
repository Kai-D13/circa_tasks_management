import { defineConfig, devices } from '@playwright/test'

// Projects split by surface (UI-program r1): desktop tests (@desktop) never run
// in a mobile device context and vice versa (@mobile). mobile-webkit approximates
// iOS Safari — requires a one-time `npx playwright install webkit`.
// `npm run test:e2e` — see e2e/*.spec.ts for the required E2E_* env vars.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  // Explicit snapshot home (docs/ui reference this path): one folder per spec,
  // snapshot name carries theme (from the test) + project (added here).
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFileName}/{arg}-{projectName}{ext}',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
  },
  projects: [
    { name: 'desktop-chromium', grep: /@desktop/, use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } } },
    { name: 'mobile-390', grep: /@mobile/, use: { ...devices['Pixel 5'] } },
    { name: 'mobile-360', grep: /@mobile/, use: { ...devices['Galaxy S9+'], viewport: { width: 360, height: 800 } } },
    // WebKit engine (closest to Safari) — OPT-IN (@webkit tag): authed flows
    // over http://localhost fail on WebKit because it refuses to SEND the
    // Secure Supabase auth cookie over http (Chromium trusts localhost).
    // Verified 2026-07-15: cookie stored (secure=true) but never attached →
    // every authed request bounces to /login. Re-enable for @mobile once an
    // https staging target exists; until then Safari coverage = real-iPhone
    // QA per wave (UI_VISUAL_QA).
    { name: 'mobile-webkit', grep: /@webkit/, use: { ...devices['iPhone 12'] } },
  ],
})
