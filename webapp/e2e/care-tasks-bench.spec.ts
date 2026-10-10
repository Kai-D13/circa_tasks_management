import fs from 'node:fs'
import path from 'node:path'
import { test } from '@playwright/test'
import { STAFF_STATE } from './authState'

// CRM-CSKH B4 — ĐO /tasks của dược sĩ trước/sau CTA "Chăm sóc khách hàng →" (SPEC B4 §4).
// Chỉ chạy khi CARE_TASKS_BENCH=1: cùng build, cùng DB, cùng tài khoản staff; A = server cờ OFF
// (không CTA), B = server cờ ON (có CTA). Đo xen kẽ A/B để triệt nhiễu mạng/DB. Ghi JSON vào
// qa-artifacts/care-b4-bench/ (gitignored). Không assert ngưỡng — số đo để PM đánh giá.

const A = process.env.E2E_BASE_URL ?? 'http://localhost:3010'
const B = process.env.E2E_CARE_ON_URL
const RUNS = Number(process.env.CARE_TASKS_BENCH_RUNS ?? 15)

test.describe('care B4 — đo /tasks staff trước/sau CTA @desktop', () => {
  test.skip(process.env.CARE_TASKS_BENCH !== '1' || !B || !fs.existsSync(STAFF_STATE), 'bench: CARE_TASKS_BENCH=1 + E2E_CARE_ON_URL + storageState staff')

  test('TTFB + DOMContentLoaded + load, xen kẽ OFF/ON', async ({ browser }) => {
    test.setTimeout(600_000)
    const res: Record<'off' | 'on', { ttfb: number; dcl: number; load: number; cta: boolean }[]> = { off: [], on: [] }
    for (let i = 0; i < RUNS + 2; i++) {
      for (const [key, base] of [['off', A], ['on', B!]] as const) {
        const ctx = await browser.newContext({ baseURL: base, storageState: STAFF_STATE, viewport: { width: 393, height: 851 } })
        const page = await ctx.newPage()
        await page.goto('/tasks', { waitUntil: 'load' })
        const t = await page.evaluate(() => {
          const n = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming
          return { ttfb: n.responseStart - n.requestStart, dcl: n.domContentLoadedEventEnd - n.startTime, load: n.loadEventEnd - n.startTime }
        })
        const cta = await page.locator('[data-testid="care-cta"]').count() > 0
        if (i >= 2) res[key].push({ ...t, cta })          // 2 vòng đầu = khởi động (cache/JIT), bỏ
        await ctx.close()
      }
    }
    const stat = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b)
      const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]
      return { p50: Math.round(q(0.5)), p95: Math.round(q(0.95)), min: Math.round(s[0]), max: Math.round(s[s.length - 1]) }
    }
    const out = Object.fromEntries((['off', 'on'] as const).map((k) => [k, {
      runs: res[k].length, cta: res[k].every((r) => r.cta), ttfb: stat(res[k].map((r) => r.ttfb)), dcl: stat(res[k].map((r) => r.dcl)), load: stat(res[k].map((r) => r.load)),
    }]))
    const dir = path.resolve(__dirname, '..', 'qa-artifacts', 'care-b4-bench')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tasks-cta.json'), JSON.stringify(out, null, 2))
    console.log('BENCH', JSON.stringify(out))
  })
})
