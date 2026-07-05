import { defineConfig, devices } from '@playwright/test'

// Mobile smoke config — one project, iPhone-class viewport (390×844).
// Run against a local dev/prod build: `npm run test:e2e` (see e2e/*.spec.ts
// for the required E2E_* env vars).
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
  },
  projects: [
    { name: 'mobile', use: { ...devices['iPhone 12'] } },
  ],
})
