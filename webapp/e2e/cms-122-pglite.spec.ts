import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test, expect } from '@playwright/test'

// CMS P2-b — chạy QA migration 122 trên PGlite (scripts/qa-cms-122.mjs) trong full suite: ACL 23 hàm, open / stage / seal /
// publish với engine + bộ dựng payload THẬT, seal bắt từng loại giả mạo, lỗi thời cấu hình / mapping, pointer, đọc theo vai
// (phạm vi hiện tại, marker QA), ghim run, dọn dữ liệu, rollback. Không DB thật.
// Cần `npm i --no-save @electric-sql/pglite@0.2.17`; thiếu ⇒ script thoát 2 ⇒ FAIL rõ.

test('CMS 122 — QA PGlite (snapshot kết quả / công bố atomic / đọc theo vai / rollback) @desktop', () => {
  test.setTimeout(300_000)
  const r = spawnSync(process.execPath, [path.resolve(__dirname, '..', 'scripts', 'qa-cms-122.mjs')], { encoding: 'utf8', timeout: 290_000 })
  const out = `${r.stdout}\n${r.stderr}`
  expect(out, out.slice(-2000)).toMatch(/\n\d+ đạt · 0 lỗi/)
  expect(r.status).toBe(0)
})
