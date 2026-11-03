import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test, expect } from '@playwright/test'

// CMS P3a — chạy QA migration 123 trên PGlite (scripts/qa-cms-123.mjs) trong full suite: áp 120 → 121 → 122 → 123, công bố
// run QA qua engine THẬT, lõi action chốt (lib/cms/lockAction.ts) trên JSON DB thật, payout theo vai (Q-208 / Q-217), XLSX chi
// trả, blocker chương trình thật (policy pending), guard ghi trực tiếp (run / cấu hình / payout / TRUNCATE), rollback + chạy lại.
// Không DB thật. Cần `npm i --no-save @electric-sql/pglite@0.2.17`; thiếu ⇒ script thoát 2 ⇒ FAIL rõ.

test('CMS 123 — QA PGlite (chốt kỳ / payout theo vai / guard đóng băng / rollback) @desktop', () => {
  test.setTimeout(300_000)
  const r = spawnSync(process.execPath, [path.resolve(__dirname, '..', 'scripts', 'qa-cms-123.mjs')], { encoding: 'utf8', timeout: 290_000 })
  const out = `${r.stdout}\n${r.stderr}`
  expect(out, out.slice(-2000)).toMatch(/\n\d+ đạt · 0 lỗi/)
  expect(r.status).toBe(0)
})
