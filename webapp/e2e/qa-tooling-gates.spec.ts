import { test, expect } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'

// Mig 103 r1.1 (audit P1 tooling) — gate an toàn của 2 script QA/proof phải
// FAIL-FAST trước mọi kết nối/ghi. Test bằng cách SPAWN node thật: các exit
// đều xảy ra TRƯỚC khi client Supabase/Mongo được dùng → không network, không
// DB. Cần .env.local (URL/key kết nối) — thiếu thì skip (máy dev/QA luôn có).
// + SOURCE-TEXT lock (pattern kpi-net-revenue-source): safety flag phải đọc
// từ process.env (không phải env-file object) và schema preflight phải abort.

const execFileP = promisify(execFile)
const HAS_ENV_LOCAL = fs.existsSync('.env.local')

// Strip mọi QA_* khỏi env kế thừa — test kiểm soát chính xác biến nào có mặt.
function baseEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(e)) if (k.startsWith('QA_')) delete e[k]
  return e
}
async function runScript(script: string, extra: Record<string, string> = {}) {
  try {
    const r = await execFileP('node', [script], { env: { ...baseEnv(), ...extra }, timeout: 30_000 })
    return { code: 0, out: r.stdout + r.stderr }
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string }
    return { code: err.code ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

test.describe('qa tooling safety gates (mig 103 r1.1) @desktop', () => {
  test('qa-kpi-customer-103: thiếu TỪNG safety flag (process env) → exit 2 fail-fast, thông điệp đúng biến', async () => {
    test.skip(!HAS_ENV_LOCAL, 'cần .env.local (URL/key) — script đọc file trước khi tới gate')
    const a = await runScript('scripts/qa-kpi-customer-103.mjs')
    expect(a.code).toBe(2)
    expect(a.out).toContain('QA_KPI_CUSTOMER_FIXTURE_ALLOWED')

    const b = await runScript('scripts/qa-kpi-customer-103.mjs', { QA_KPI_CUSTOMER_FIXTURE_ALLOWED: 'YES' })
    expect(b.code).toBe(2)
    expect(b.out).toContain('QA_AFFILIATE_CRON_PAUSED')

    const c = await runScript('scripts/qa-kpi-customer-103.mjs', {
      QA_KPI_CUSTOMER_FIXTURE_ALLOWED: 'YES',
      QA_AFFILIATE_CRON_PAUSED: 'YES',
      QA_EXPECTED_SUPABASE_URL: 'https://sai-project.example.com',
    })
    expect(c.code).toBe(2)
    expect(c.out).toContain('QA_EXPECTED_SUPABASE_URL')
  })

  test('proof script: QA_CUSTOMER_FROM/TO không hợp lệ → exit 1 fail-fast TRƯỚC khi kết nối', async () => {
    test.skip(!HAS_ENV_LOCAL, 'cần .env.local — script check URI trước khi tới validate range')
    // range đảo
    const a = await runScript('scripts/proof-affiliate-account-id.mjs',
      { QA_CUSTOMER_FROM: '2026-08-10', QA_CUSTOMER_TO: '2026-08-01' })
    expect(a.code).toBe(1)
    expect(a.out).toContain('QA_CUSTOMER_FROM')
    // thiếu 1 nửa cặp
    const b = await runScript('scripts/proof-affiliate-account-id.mjs', { QA_CUSTOMER_FROM: '2026-08-01' })
    expect(b.code).toBe(1)
    expect(b.out).toContain('đi CẶP')
    // ngày lịch không tồn tại
    const c = await runScript('scripts/proof-affiliate-account-id.mjs',
      { QA_CUSTOMER_FROM: '2026-02-31', QA_CUSTOMER_TO: '2026-03-05' })
    expect(c.code).toBe(1)
    expect(c.out).toContain('sai định dạng')
  })

  test('SOURCE-TEXT lock: safety flags đọc từ PROCESS ENV; schema preflight ABORT (không out-rồi-chạy-tiếp)', () => {
    const qa = fs.readFileSync('scripts/qa-kpi-customer-103.mjs', 'utf8')
    for (const flag of ['QA_KPI_CUSTOMER_FIXTURE_ALLOWED', 'QA_AFFILIATE_CRON_PAUSED', 'QA_EXPECTED_SUPABASE_URL']) {
      expect(qa).toContain(`process.env.${flag}`)
      // không còn đọc từ env-file object (env.QA_* mà không có tiền tố process.)
      expect(new RegExp(`(?<!process\\.)env\\.${flag}`).test(qa), `${flag} không được đọc từ .env.local`).toBe(false)
    }
    expect(qa).toContain("abort('preflight schema:")
    expect(qa).toContain('không đếm được delivered thiếu account_id')

    const proof = fs.readFileSync('scripts/proof-affiliate-account-id.mjs', 'utf8')
    expect(proof).toContain('process.env.QA_CUSTOMER_FROM')
    expect(proof).toContain('process.env.QA_CUSTOMER_TO')
    // exact-range dedup toàn range (mirror RPC) + monthly chỉ là diagnostic
    expect(proof).toContain('EXACT RANGE')
    expect(proof).toContain('DIAGNOSTIC theo tháng VN')
    // r1.3: phân loại missing_account + cross-store in-range + JSON summary
    expect(proof).toContain('os_in_range_qualifying')
    expect(proof).toContain('R1.3 DIAGNOSTIC')
    expect(proof).toContain('=== JSON SUMMARY ===')
  })
})
