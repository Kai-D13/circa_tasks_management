import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test, expect } from '@playwright/test'

// CMS P1-a — chạy QA migration 120 trên PGlite (scripts/qa-cms-120.mjs) trong full suite: preflight, idempotent,
// ma trận ACL, RLS theo vai + marker QA (H9b), RPC service_role, CHECK, rollback. Không DB thật, không mạng.
// Cần `npm i --no-save @electric-sql/pglite@0.2.17` (như các spec CRM dùng PGlite); thiếu ⇒ script thoát 2 ⇒ FAIL rõ.

test('CMS 120 — QA PGlite (RLS/ACL/RPC/rollback) @desktop', () => {
  test.setTimeout(180_000)
  const r = spawnSync(process.execPath, [path.resolve(__dirname, '..', 'scripts', 'qa-cms-120.mjs')], { encoding: 'utf8', timeout: 170_000 })
  const out = `${r.stdout}\n${r.stderr}`
  expect(out, out.slice(-2000)).toMatch(/\n\d+ đạt · 0 lỗi/)
  expect(r.status).toBe(0)
})
