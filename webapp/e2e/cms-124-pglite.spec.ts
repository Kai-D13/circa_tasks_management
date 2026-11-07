import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test, expect } from '@playwright/test'

// CMS COMP-INT — chạy QA migration 124 trên PGlite (scripts/qa-cms-124.mjs) trong full suite: generator ↔ file, áp 120 → 124,
// VERIFY phase 124 (POST + đột biến + V8), lõi đồng bộ capture ON / OFF / thiếu source_schema, chứng nhận decision10 qua lõi CLI
// (tái hiện PM COMP-P1-1), chốt 6 tham số + payout / XLSX, rollback / áp lại, CLI đầu-cuối qua shim HTTP (vận hành §7 + run QA §8
// trên bản sao cô lập trong qa-artifacts/: guard hai pha, revoke đúng chương trình, close đủ bộ, biên lỗi entrypoint — PM
// COMPINT-P1-1/2/3). Không DB thật.
// Cần `npm i --no-save @electric-sql/pglite@0.2.17`; thiếu ⇒ script thoát 2 ⇒ FAIL rõ.

test('CMS 124 — QA PGlite (chứng nhận nguồn / VERIFY 124 / capture / chốt / rollback / CLI) @desktop', () => {
  test.setTimeout(600_000)
  const r = spawnSync(process.execPath, [path.resolve(__dirname, '..', 'scripts', 'qa-cms-124.mjs')], { encoding: 'utf8', timeout: 590_000 })
  const out = `${r.stdout}\n${r.stderr}`
  expect(out, out.slice(-2000)).toMatch(/\n\d+ đạt · 0 lỗi/)
  expect(r.status).toBe(0)
})
