import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test, expect } from '@playwright/test'

// CMS P1-b — chạy QA migration 121 trên PGlite (scripts/qa-cms-121.mjs) trong full suite: preflight, ACL, RPC lưu / preview /
// commit (replace / append, idempotent, CONFLICT) / kích hoạt (H7), trùng ProductID theo namespace is_test, rollback. Không DB thật.
// Cần `npm i --no-save @electric-sql/pglite@0.2.17` (như các spec CRM dùng PGlite); thiếu ⇒ script thoát 2 ⇒ FAIL rõ.

test('CMS 121 — QA PGlite (RPC import / kích hoạt / rollback) @desktop', () => {
  test.setTimeout(180_000)
  const r = spawnSync(process.execPath, [path.resolve(__dirname, '..', 'scripts', 'qa-cms-121.mjs')], { encoding: 'utf8', timeout: 170_000 })
  const out = `${r.stdout}\n${r.stderr}`
  expect(out, out.slice(-2000)).toMatch(/\n\d+ đạt · 0 lỗi/)
  expect(r.status).toBe(0)
})
