import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { CMS_TABLE_SHAPE_123, CMS_TABLE_SHAPE_124, CMS_VERIFY_PROFILE_PHASES, CMS_VERIFY_PROFILE_RESIDUAL, cmsVerifyProfileValid } from './cmsQaTooling'

// PM 2026-11-05-cms-candidate-inventory-runbook-pm.md §3 INV-P1-1 — profile VERIFY hậu rollback 124 (chỉ đọc, không đổi SQL).
// Kịch bản PGlite trên chuỗi THẬT 120 → 124 → rollback 124 → rollback 123 ở scripts/qa-cms-rollback-profile.mjs (PG15: --pg15).
const WEBAPP = path.join(__dirname, '..')

test.describe('CMS VERIFY — profile hậu rollback 124 @desktop', () => {
  test('hằng: chỉ phase nền 123 / 122; phần dư = đúng ràng buộc part 124 của cms_sync_run_chunks, khác bản nền', () => {
    expect(CMS_VERIFY_PROFILE_PHASES['after-rollback-124']).toEqual(['123', '122'])
    for (const ph of ['120', '121', '124', '125', '126', '']) expect(cmsVerifyProfileValid('after-rollback-124', ph)).toBe(false)
    expect(cmsVerifyProfileValid('after-rollback-124', '123')).toBe(true)
    expect(cmsVerifyProfileValid('after-rollback-123', '122')).toBe(false)
    const res = CMS_VERIFY_PROFILE_RESIDUAL['after-rollback-124']
    expect(Object.keys(res)).toEqual(['cms_sync_run_chunks'])
    expect(res.cms_sync_run_chunks.con).toBe(CMS_TABLE_SHAPE_124.cms_sync_run_chunks.con)
    expect(res.cms_sync_run_chunks.con).not.toBe(CMS_TABLE_SHAPE_123.cms_sync_run_chunks.con)
    // index ghim bản NỀN (không theo 124) — db-reviewer P2-1
    expect(res.cms_sync_run_chunks.idx).toBe(CMS_TABLE_SHAPE_123.cms_sync_run_chunks.idx)
  })

  test('chuỗi thật PGlite: phase 123 / 122 thường đỏ đúng 1 mục, profile đạt, không che lệch ACL / thân / shape; CLI sai ⇒ 2', () => {
    test.setTimeout(240_000)
    const r = spawnSync(process.execPath, [path.join(WEBAPP, 'scripts', 'qa-cms-rollback-profile.mjs')], { encoding: 'utf8', timeout: 230_000 })
    const out = `${r.stdout}\n${r.stderr}`
    // Ghim số mục (PGlite: 30) — một mục bị rút khỏi kịch bản không được vẫn xanh (db-reviewer P2-3).
    expect(out, out.slice(-2000)).toMatch(/\n30 đạt · 0 lỗi/)
    expect(out).toContain('phase 123 THƯỜNG: đỏ ĐÚNG table-shape:cms_sync_run_chunks')
    expect(out).toContain('phase 122 THƯỜNG: đỏ ĐÚNG table-shape:cms_sync_run_chunks')
    expect(r.status).toBe(0)
  })
})
