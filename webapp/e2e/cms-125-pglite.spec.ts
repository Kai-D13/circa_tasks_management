import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test, expect } from '@playwright/test'

// CMS-UNCAPPED-1 (CMS-Q-220 bỏ trần) — chạy QA migration 125 trên PGlite (scripts/qa-cms-125.mjs) trong full suite: generator ↔ file,
// dữ liệu "trước 125" dựng bằng app CŨ (git 60a2231, engine còn trần), chuyển đổi đúng phạm vi (bậc cuối / version / pointer / QA đã
// chốt byte-giống), VERIFY phase 125 + đột biến + V8, RPC import / kích hoạt / guard deferred, header config_reset, đồng bộ app mới
// (Q100 2.360.000 qua seal SQL), dừng fail-closed, rollback 125 → VERIFY 124 / áp lại / rollback chuỗi → profile. Không DB thật.
// Race 2 kết nối + đo chạy riêng trên PG15 thật (`--pg15`, xem đầu script). Cần `npm i --no-save @electric-sql/pglite@0.2.17`;
// thiếu ⇒ script thoát 2 ⇒ FAIL rõ.

test('CMS 125 — QA PGlite (bỏ trần: chuyển đổi / VERIFY 125 / guard / app / rollback) @desktop', () => {
  test.setTimeout(600_000)
  const r = spawnSync(process.execPath, [path.resolve(__dirname, '..', 'scripts', 'qa-cms-125.mjs')], { encoding: 'utf8', timeout: 590_000 })
  const out = `${r.stdout}\n${r.stderr}`
  expect(out, out.slice(-2000)).toMatch(/ĐẠT: \d+ đạt · 0 lỗi/)
  expect(r.status).toBe(0)
})
