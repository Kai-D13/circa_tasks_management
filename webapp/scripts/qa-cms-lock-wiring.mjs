#!/usr/bin/env node
// CMS P3a r2 (PM r1 PKG-P1-2 / PKG-P1-3) — kiểm WIRING THẬT của server action chốt: nạp nguyên `app/actions/cmsPayouts.ts` +
// `lib/cms/server/payouts.ts` (cmsLockDeps thật: cờ từ process.env, chế độ server QA CMS_QA_SERVER) + lõi lib/cms/lockAction.
// Chỉ thay các module IO ở đáy (Supabase session / service_role, quyền session, đọc chương trình, next/cache) bằng stub ghi
// lại lời gọi — không mạng, không DB, không prod. Khẳng định:
//   · server QA (CMS_QA_SERVER=1) + super + is_test + cờ ON ⇒ lockCmsProgram từ chối QA_SERVER_READONLY, 0 RPC, 0 revalidate;
//     previewCmsLock vẫn đọc (đường chỉ đọc giữ nguyên);
//   · app thường (không CMS_QA_SERVER) ⇒ chốt gọi RPC đúng 1 lần, revalidate 1 lần;
//   · revalidatePath ném SAU commit ⇒ action vẫn trả ok (không biến đã chốt thành lỗi / Promise reject);
//   · cờ OFF ⇒ LOCK_DISABLED, 0 RPC.
//   node scripts/qa-cms-lock-wiring.mjs      # kỳ vọng: N đạt · 0 lỗi
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const P = '00000000-0000-4000-8000-000000000001', R = '00000000-0000-4000-8000-000000000002', ACTOR = '00000000-0000-4000-8000-000000000009'
let pass = 0, fail = 0
const ok = (c, name, extra = '') => { if (c) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name} ${extra}`) } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-lock-wiring-'))
const stub = (name, src) => { const f = path.join(tmp, `${name}.mjs`); fs.writeFileSync(f, src); return f }
const PREVIEW = {
  program_id: P, found: true, status: 'active', is_test: true, end_date: '2026-11-14', config_version: 1, run_id: R,
  run_started_at: '2026-11-15T02:10:00.000000Z', amount_vnd: '42000', results_amount_vnd: '42000', staff_rows: 2, staff_paid: 1,
  candidate_lines: 10, candidate_gmv: '100000', unassigned_lines: 0, unassigned_gmv: '0', unassigned_over: false, needs_ack: false,
  policy: { label: 'QA_ONLY_ASSUMPTION', ready: true, pending: [] }, policy_version: 1, mapping_fp_run: 'a'.repeat(32), mapping_fp_now: 'a'.repeat(32),
  source_complete_basis: 'qa_assumption', earliest_lock_at: '2026-11-15T00:00:00.000000Z', blockers: [],
}
const aliases = {
  'server-only': path.join(HERE, 'cms-server-only-stub.mjs'),
  '@/lib/supabase/admin': stub('admin', `
export const supabaseAdmin = { rpc: async (fn, args) => {
  globalThis.__cmsWiring.rpc.push(fn)
  if (fn === 'rpc_cms_lock_preview') return { data: ${JSON.stringify(PREVIEW)}, error: null }
  return { data: { locked: true, already: false, program_id: args.p_program_id, run_id: args.p_expected_run_id, amount_vnd: '42000', policy_version: 1 }, error: null }
} }`),
  '@/lib/supabase/server': stub('server', `export async function createClient() { throw new Error('không dùng session client trong đường chốt') }`),
  '@/lib/cms/server/access': stub('access', `export async function getCmsAdminAccess() { return { kind: 'ok', actorId: '${ACTOR}', qa: true } }`),
  '@/lib/cms/server/importRepo': stub('importRepo', `export const supabaseCmsImportRepo = { getProgram: async () => ({ isTest: true }) }`),
  '@/lib/cms/server/results': stub('results', `export const cmsSafeErrorCode = (c) => String(c ?? '')`),
  'next/cache': stub('cache', `export function revalidatePath() { globalThis.__cmsWiring.reval++; if (globalThis.__cmsWiring.revalThrow) throw new Error('revalidate lỗi sau commit') }`),
  '@': ROOT,
}
try {
  const jiti = createJiti(import.meta.url, { alias: aliases, interopDefault: true, moduleCache: false })
  const action = await jiti.import(path.join(ROOT, 'app/actions/cmsPayouts.ts'))
  const INPUT = { programId: P, expectedRunId: R, expectedPolicyVersion: 1 }
  const reset = () => { globalThis.__cmsWiring = { rpc: [], reval: 0, revalThrow: false } }
  const setEnv = (o) => {
    for (const k of ['CMS_PROGRAM_ENABLED', 'CMS_EARNINGS_ENABLED', 'CMS_LOCK_ENABLED', 'CMS_QA_SERVER']) delete process.env[k]
    Object.assign(process.env, o)
  }
  const ON = { CMS_PROGRAM_ENABLED: 'true', CMS_EARNINGS_ENABLED: 'true', CMS_LOCK_ENABLED: 'true' }
  console.log('\nCMS P3a r2 — wiring server action chốt (module thật, stub IO đáy)')

  reset(); setEnv({ ...ON, CMS_QA_SERVER: '1' })
  let r = await action.lockCmsProgram(INPUT)
  ok(!r.ok && r.code === 'QA_SERVER_READONLY' && globalThis.__cmsWiring.rpc.length === 0 && globalThis.__cmsWiring.reval === 0,
    'server QA (CMS_QA_SERVER=1) + super + is_test + cờ ON ⇒ QA_SERVER_READONLY, 0 RPC, 0 revalidate', JSON.stringify({ r, w: globalThis.__cmsWiring }))
  reset()
  const pv = await action.previewCmsLock(P)
  ok(pv.ok === true && globalThis.__cmsWiring.rpc.join() === 'rpc_cms_lock_preview', 'server QA: preview vẫn đọc được (chỉ rpc_cms_lock_preview)', JSON.stringify(pv))

  reset(); setEnv(ON)
  r = await action.lockCmsProgram(INPUT)
  ok(r.ok === true && globalThis.__cmsWiring.rpc.join() === 'rpc_cms_program_lock' && globalThis.__cmsWiring.reval === 1,
    'app thường (không CMS_QA_SERVER) ⇒ chốt: 1 RPC rpc_cms_program_lock, revalidate 1 lần', JSON.stringify({ r, w: globalThis.__cmsWiring }))

  reset(); setEnv(ON); globalThis.__cmsWiring.revalThrow = true
  let rejected = false
  try { r = await action.lockCmsProgram(INPUT) } catch { rejected = true }
  ok(!rejected && r.ok === true && globalThis.__cmsWiring.rpc.length === 1, 'revalidatePath ném SAU commit ⇒ action vẫn trả ok (không reject, không thành lỗi)', JSON.stringify({ rejected, r }))

  reset(); setEnv({ CMS_PROGRAM_ENABLED: 'true', CMS_EARNINGS_ENABLED: 'true', CMS_QA_SERVER: '1' })
  r = await action.lockCmsProgram(INPUT)
  ok(!r.ok && r.code === 'LOCK_DISABLED' && globalThis.__cmsWiring.rpc.length === 0, 'cờ LOCK OFF ⇒ LOCK_DISABLED, 0 RPC (cổng cờ đứng trước chế độ QA)')
} catch (e) {
  fail++
  console.log(`  ✗ lỗi nạp / chạy: ${e instanceof Error ? e.stack?.split('\n').slice(0, 3).join(' | ') : e}`)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
console.log(`\n${pass} đạt · ${fail} lỗi`)
process.exitCode = fail ? 1 : 0
