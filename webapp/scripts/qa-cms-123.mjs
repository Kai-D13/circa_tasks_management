// QA migration 123 (CMS P3a — chốt kỳ / chi trả) + tầng app (DTO / lõi action / XLSX) trên PGlite (Postgres 16 WASM):
// nền 114–116 + 120 + 121 + 122 + 123 NGUYÊN VĂN từ supabase/migrations. Run công bố dựng bằng engine + payload THẬT (jiti).
// Kiểm phần app đọc JSON THẬT của RPC 123 (không chỉ fixture tay): parseCmsLockPreview / parseCmsPayout, lõi action chốt
// (lib/cms/lockAction — deps nối PGlite, actor từ "session"), XLSX chi trả theo vai, Q-217, chương trình thật bị chặn, cờ.
// GIỚI HẠN: PGlite một session ⇒ race / isolation nhiều kết nối / ACL default privileges như prod / benchmark ở PG15 thật
// (planning/research/dev-tools/cms/draft-p3/123-realpg-test.mjs). KHÔNG chạm DB thật.
//   npm i --no-save @electric-sql/pglite@0.2.17     # một lần, trong webapp/
//   node scripts/qa-cms-123.mjs                     # kỳ vọng: N đạt · 0 lỗi
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'
import * as XLSX from 'xlsx'
import * as L from './lib-care-pglite.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIG = path.join(HERE, '..', '..', 'supabase', 'migrations')
const SQL = (f) => fs.readFileSync(path.join(MIG, f), 'utf8')
const SQL_123 = SQL('123_cms_payouts.sql')
const RB_123 = SQL(path.join('rollback', '123_cms_payouts_rollback.sql'))

let PGlite
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch {
  console.error('FAIL: thiếu @electric-sql/pglite — chạy: npm i --no-save @electric-sql/pglite@0.2.17 (trong webapp/)')
  process.exit(2)
}
const jiti = createJiti(import.meta.url, { interopDefault: true, alias: { '@': path.join(HERE, '..') } })
const lib = (p) => jiti.import(path.join(HERE, '..', 'lib', 'cms', p))
const E = await lib('engine/compute.ts')
const RS = await lib('resultStage.ts')
const C = await lib('source/contract.ts')
const PV = await lib('payoutView.ts')
const LA = await lib('lockAction.ts')
const XP = await lib('exportPayouts.ts')

const bail = (e) => { console.error(`\nLỖI NGOÀI DỰ KIẾN: ${e?.stack ?? e}`); process.exit(1) }
process.on('uncaughtException', bail)
process.on('unhandledRejection', bail)
let pass = 0, fail = 0
const ok = (c, name, extra = '') => { if (c) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name} ${extra}`) } }
const section = (s) => console.log(`\n${s}`)
const { U, storeId, STORES, one, as, sha } = L

const db = await L.freshDb(PGlite)
await db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('117','t'),('118','t'),('118a','t'),('119','t'),('119a','t') ON CONFLICT DO NOTHING`)
for (const f of ['120_cms_foundation.sql', '121_cms_import_activation.sql', '122_cms_results.sql']) await db.exec(SQL(f))
await db.query(`INSERT INTO public.cms_product_master (product_id, product_name, is_active, source_updated_at)
  SELECT g::text, 'SP giả ' || g, true, now() FROM generate_series(912001, 912040) g`)

const svc = (sql, params = []) => as(db, null, () => db.query(sql, params), 'service_role')
const userQ = (who, sql, params = []) => as(db, who, () => db.query(sql, params))
const today = (await one(db, `SELECT public.cms__vn_today()::text d`)).d
const day = (n) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
let pidNext = 912001, seqf = 0, lineSeq = 0
const T_ONE = [{ order: 1, from: 1, to: null, amount: '1000' }]
const EM = (i, ab = 'a') => STORES[i - 1].assigneeEmails[ab === 'a' ? 0 : 1]
const IN_SCOPE = [EM(1, 'a'), EM(1, 'b'), EM(2, 'a'), EM(2, 'b')]

async function makeProgram({ isTest = true, start = -20, end = -1, stores = [storeId(1), storeId(2)] } = {}) {
  const pid = String(pidNext++)
  const id = (await svc(`SELECT public.rpc_cms_program_save($1::jsonb) id`, [JSON.stringify({
    actor: U.super, name: 'QA CMS 123', start_date: day(start), end_date: day(end), scope: 'stores', store_ids: stores, is_test: isTest })])).rows[0].id
  const fileSha = sha(`f${++seqf}`), digest = sha(`d${seqf}`)
  const run = (await svc(`SELECT public.rpc_cms_import_preview_save($1::jsonb) id`, [JSON.stringify({ program_id: id, mode: 'replace', file_name: 'qa.xlsx',
    file_sha256: fileSha, file_bytes: 10, actor: U.super, stats: { rowsTotal: 1, rowsOk: 1, rowsRejected: 0, warnings: 0, productsOk: 1, productsRejected: 0 },
    result: { digest } })])).rows[0].id
  await svc(`SELECT public.rpc_cms_import_commit($1, $2, $3, $4::jsonb, $5)`, [run, fileSha, digest, JSON.stringify({ mode: 'replace', catalog_target: null,
    products: [{ product_id: pid, gmv_basis: 'none', target_gmv: null, base_quantity_cms: '2', tiers: T_ONE, unit_cms: 'hộp', advice_text: 'QA',
      name_snapshot: 'SP giả', image_url_snapshot: null, price_snapshot: null }] }), U.super])
  await svc(`SELECT public.rpc_cms_program_activate($1, $2)`, [id, U.super])
  return { id, pid }
}
function lines(pid, specs, start = -20) {
  const out = []
  const base = Date.parse(`${day(start)}T01:00:00Z`)
  for (const s of specs) for (let i = 0; i < s.n; i++) {
    const id = ++lineSeq
    const at = new Date(base + id * 3_600_000).toISOString().replace('Z', '').padEnd(23, '0') + `${String(id % 1000).padStart(3, '0')}Z`
    const r = C.normalizeSalesRow({ order_line_id: String(910000000 + id), order_id: `O${id}`, order_code: `QA-${id}`, product_id: pid,
      seller_email: s.emails ? s.emails[i % s.emails.length] : s.email, pos_code: 'QAOS01', order_type: 'OFFLINE', order_status: 'COMPLETED',
      completed_at: at, quantity_raw: '1', uom_raw: 'Hộp', base_quantity: '2', gmv_amount: String(s.gmv ?? 10000), source_updated_at: at })
    if (!r.ok) throw new Error('dòng giả lỗi')
    out.push(r.value)
  }
  return out
}
async function publishRun(programId, ls) {
  const snap = RS.parseCmsSalesSnapshot((await svc(`SELECT public.rpc_cms_sales_run_open($1, '{"source":"qa"}'::jsonb) s`, [programId])).rows[0].s)
  const input = RS.cmsSnapshotToEngineInput(snap)
  const out = E.computeCmsProgram({ program: input.program, lines: ls, sellers: input.sellers })
  const payload = RS.buildCmsStagePayload(snap, ls, out, { rowsRead: ls.length, rowsRejected: 0, bytesProcessed: null, chunkSize: 5000 })
  for (const part of RS.CMS_STAGE_PARTS) {
    const chunks = RS.chunkCmsStageRows(payload.parts[part], 5000)
    for (let i = 0; i < chunks.length; i++) await svc(`SELECT public.rpc_cms_sales_run_stage($1, $2, $3, $4::jsonb)`, [snap.runId, part, i, JSON.stringify(chunks[i])])
  }
  const b = (await svc(`SELECT public.rpc_cms_sales_run_seal_begin($1, $2::jsonb) r`, [snap.runId, JSON.stringify(payload.expect)])).rows[0].r
  if (!b.ok) throw new Error('seal_begin ' + JSON.stringify(b))
  for (let i = 1; i <= 10; i++) {
    const r = (await svc(`SELECT public.rpc_cms_sales_run_seal_step($1, $2) r`, [snap.runId, i])).rows[0].r
    if (!r.ok && !r.sealed) throw new Error('seal ' + JSON.stringify(r))
  }
  const pub = (await svc(`SELECT public.rpc_cms_sales_run_publish($1) r`, [snap.runId])).rows[0].r
  if (!pub.published) throw new Error('publish ' + JSON.stringify(pub))
  return { runId: snap.runId, amount: payload.expect.amount_vnd }
}
/** Deps của lõi action nối PGlite: RPC chạy vai service_role (như supabaseAdmin), "session" = super có marker QA. */
const lockDeps = (o = {}) => {
  const calls = []
  return {
    calls,
    deps: {
      lockEnabled: () => true,
      qaReadonly: () => false,
      access: async () => ({ kind: 'ok', actorId: U.super, qa: true }),
      program: async (id) => { const r = await one(db, `SELECT is_test FROM public.cms_programs WHERE id = $1`, [id]); return r ? { isTest: r.is_test } : null },
      rpc: async (fn, args) => {
        calls.push(fn)
        const sql = fn === 'rpc_cms_lock_preview'
          ? `SELECT public.rpc_cms_lock_preview(p_program_id => $1) r`
          : `SELECT public.rpc_cms_program_lock(p_program_id => $1, p_expected_run_id => $2, p_expected_policy_version => $3, p_actor => $4, p_ack_reason => $5) r`
        const params = fn === 'rpc_cms_lock_preview' ? [args.p_program_id]
          : [args.p_program_id, args.p_expected_run_id, args.p_expected_policy_version, args.p_actor, args.p_ack_reason]
        try { return { data: (await svc(sql, params)).rows[0].r, error: null } } catch (e) { return { data: null, error: { code: e.code, message: e.message } } }
      },
      ...o,
    },
  }
}

section('1. Chạy 123 trên nền 120–122 (hậu kiểm trong transaction)')
{
  const r = await db.exec(SQL_123).then(() => null, (e) => e.message)
  ok(r === null, 'chạy 123 nguyên văn (18 hàm, 46 trigger ALWAYS, ACL, RLS, TRUNCATE)', r)
  ok((await one(db, `SELECT name FROM public.app_migrations WHERE version = '123'`))?.name === 'cms_payouts', 'marker 123 = cms_payouts')
}

section('2. Preview + lõi action chốt trên JSON THẬT (chương trình QA đã hết kỳ, 4 dược sĩ, 3 dòng chưa gán)')
const P1 = await makeProgram()
const R1 = await publishRun(P1.id, lines(P1.pid, [{ n: 40, emails: IN_SCOPE }, { n: 3, email: 'khong.co@example.invalid', gmv: 100 }]))
let preview
{
  const { deps, calls } = lockDeps()
  const pv = await LA.runCmsLockPreview(deps, P1.id)
  ok(pv.ok, 'preview: lõi action đọc rpc_cms_lock_preview, parseCmsLockPreview nhận JSON thật', JSON.stringify(pv).slice(0, 200))
  preview = pv.ok ? pv.preview : null
  ok(preview && preview.runId === R1.runId && preview.amountVnd === R1.amount && preview.staffRows === 4 && preview.unassignedLines === 3
    && preview.needsAck && preview.blockers.length === 0 && preview.policy.label === 'QA_ONLY_ASSUMPTION' && PV.cmsLockReady(preview),
  `preview khớp run vừa công bố (tổng ${R1.amount}, 4 dược sĩ, 3 dòng chưa gán ⇒ cần lý do, nhãn QA)`, JSON.stringify(preview).slice(0, 300))
  ok(calls.length === 1, 'preview gọi đúng 1 RPC')
}
{
  // Không lý do (rỗng ⇒ null) ⇒ DB từ chối CMS_LOCK_ACK_REQUIRED (mã DB thật, không message thô).
  let r = await LA.runCmsLock(lockDeps().deps, { programId: P1.id, expectedRunId: preview.runId, expectedPolicyVersion: preview.policyVersion, ackReason: '' })
  ok(!r.ok && r.code === 'CMS_LOCK_ACK_REQUIRED', 'thiếu lý do ⇒ CMS_LOCK_ACK_REQUIRED (từ DB)', JSON.stringify(r))
  r = await LA.runCmsLock(lockDeps().deps, { programId: P1.id, expectedRunId: L.uid(999), expectedPolicyVersion: 1, ackReason: 'Đã đối soát dòng chưa gán (QA)' })
  ok(!r.ok && r.code === 'CMS_LOCK_RUN_CHANGED', 'expected run khác run hiện hành ⇒ CMS_LOCK_RUN_CHANGED', JSON.stringify(r))
  r = await LA.runCmsLock(lockDeps().deps, { programId: P1.id, expectedRunId: preview.runId, expectedPolicyVersion: 2, ackReason: 'Đã đối soát dòng chưa gán (QA)' })
  ok(!r.ok && r.code === 'CMS_LOCK_POLICY_CHANGED', 'policy version lệch ⇒ CMS_LOCK_POLICY_CHANGED', JSON.stringify(r))
  const noMarker = lockDeps({ access: async () => ({ kind: 'ok', actorId: U.super, qa: false }) })
  r = await LA.runCmsLock(noMarker.deps, { programId: P1.id, expectedRunId: preview.runId, expectedPolicyVersion: 1, ackReason: 'Đã đối soát dòng chưa gán (QA)' })
  ok(!r.ok && r.code === 'NOT_FOUND' && noMarker.calls.length === 0, 'super không marker QA ⇒ NOT_FOUND, 0 RPC (không lộ chương trình QA)')
  const off = lockDeps({ lockEnabled: () => false })
  r = await LA.runCmsLock(off.deps, { programId: P1.id, expectedRunId: preview.runId, expectedPolicyVersion: 1 })
  ok(!r.ok && r.code === 'LOCK_DISABLED' && off.calls.length === 0, 'cờ OFF ⇒ LOCK_DISABLED, 0 RPC')
  // Chốt đạt; actor = "session" (form gửi actor khác bị bỏ qua).
  r = await LA.runCmsLock(lockDeps().deps, { programId: P1.id, expectedRunId: preview.runId, expectedPolicyVersion: 1, ackReason: '  Đã đối soát dòng chưa gán (QA)  ', actor: U.sm })
  ok(r.ok && !r.already && r.amountVnd === R1.amount, `chốt đạt: ${r.amountVnd} đ = engine ${R1.amount} đ`, JSON.stringify(r))
  const pay = await one(db, `SELECT locked_by, ack_reason, amount_vnd::text a FROM public.cms_payouts WHERE program_id = $1`, [P1.id])
  ok(pay?.locked_by === U.super && pay.ack_reason === 'Đã đối soát dòng chưa gán (QA)' && pay.a === R1.amount, 'payout: người chốt từ session, lý do đã cắt khoảng trắng')
  r = await LA.runCmsLock(lockDeps().deps, { programId: P1.id, expectedRunId: preview.runId, expectedPolicyVersion: 1, ackReason: 'Đã đối soát dòng chưa gán (QA)' })
  ok(r.ok && r.already, 'bấm lại / gọi lại cùng run ⇒ already (idempotent)')
  const pv2 = await LA.runCmsLockPreview(lockDeps().deps, P1.id)
  ok(pv2.ok && pv2.preview.status === 'locked' && pv2.preview.blockers[0] === 'CMS_PROGRAM_LOCKED', 'preview sau chốt ⇒ CMS_PROGRAM_LOCKED')
}

section('3. Đọc số đã chốt theo vai (rpc_cms_payout JSON thật ⇒ parseCmsPayout) + XLSX chi trả')
await db.query(`INSERT INTO public.cms_qa_access (user_id, granted_by, expires_at) SELECT x, 'qa-script:123', now() + interval '2 hours'
  FROM unnest($1::uuid[]) x`, [[U.super, U.sm, U.sm2, U.qlch1, U.A, U.mkt]])
const payoutOf = async (who) => {
  try { return { ok: true, dto: PV.parseCmsPayout((await userQ(who, `SELECT public.rpc_cms_payout($1) r`, [P1.id])).rows[0].r) } } catch (e) { return { ok: false, err: e.message } }
}
let superPay
{
  const s = await payoutOf(U.super)
  ok(s.ok && s.dto.viewer === 'super' && s.dto.rows.length === 4 && s.dto.programTotal === R1.amount && s.dto.rows.every((r) => r.email !== null) && s.dto.super?.ackReason,
    `super: 4 dòng, program_total = ${R1.amount}, có email + lý do`, s.err ?? '')
  superPay = s.dto
  const sm = await payoutOf(U.sm)
  ok(sm.ok && sm.dto.viewer === 'sm' && sm.dto.programTotal === null && sm.dto.rows.length === 4 && sm.dto.rows.every((r) => r.email === null),
    'SM (NT1 + NT2): 4 dòng, program_total null, không email', sm.err ?? '')
  const sm2 = await payoutOf(U.sm2)
  ok(sm2.ok && sm2.dto.rows.length === 2 && sm2.dto.scopeTotal !== R1.amount, `SM một phần (NT2): 2 dòng, scope_total ${sm2.dto?.scopeTotal} ≠ tổng chương trình`, sm2.err ?? '')
  const ql = await payoutOf(U.qlch1)
  ok(ql.ok && ql.dto.viewer === 'store_manager' && ql.dto.rows.length === 2, 'QLCH NT1: 2 dòng', ql.err ?? '')
  const st = await payoutOf(U.A)
  ok(st.ok && st.dto.rows.length === 1 && st.dto.rows[0].userId === U.A, 'staff: chỉ dòng của mình', st.err ?? '')
  const adm = await payoutOf(U.mkt)
  ok(!adm.ok && /CMS_RESULT_FORBIDDEN/.test(adm.err), 'admin thường ⇒ CMS_RESULT_FORBIDDEN')
  // Q-217: staff chuyển sang nhà thuốc NGOÀI chương trình ⇒ không đọc; trở lại ⇒ đọc lại, snapshot không đổi.
  const before = superPay.rows.find((r) => r.userId === U.A)
  await db.query(`UPDATE public.users SET store_id = $2 WHERE id = $1`, [U.A, storeId(5)])
  const out = await payoutOf(U.A)
  ok(!out.ok && /CMS_RESULT_FORBIDDEN/.test(out.err), 'Q-217: staff chuyển ra ngoài chương trình ⇒ CMS_RESULT_FORBIDDEN')
  await db.query(`UPDATE public.users SET store_id = $2, full_name = 'Tên đổi sau chốt' WHERE id = $1`, [U.A, storeId(2)])
  const moved = await payoutOf(U.A)
  ok(moved.ok && moved.dto.rows[0].name === before.name && moved.dto.rows[0].storeName === before.storeName,
    'staff chuyển sang nhà thuốc khác TRONG chương trình + đổi tên ⇒ vẫn đọc, định danh snapshot không đổi', moved.err ?? '')
  await db.query(`UPDATE public.users SET store_id = $2, full_name = 'QA staff 1a' WHERE id = $1`, [U.A, storeId(1)])

  const prog = { id: P1.id, name: 'QA CMS 123', startDate: day(-20), endDate: day(-1), status: 'locked', isTest: true }
  const wbS = XP.buildCmsPayoutWorkbook({ program: prog, payout: superPay, exportedAt: new Date(), scope: 'super' })
  const wbM = XP.buildCmsPayoutWorkbook({ program: prog, payout: sm2.dto, exportedAt: new Date(), scope: 'sm' })
  const cells = (b) => XLSX.utils.sheet_to_json(XLSX.read(b.bytes, { type: 'array' }).Sheets['Chi tra'], { header: 1, defval: '' })
  ok(wbS.ok && wbS.totalVnd === BigInt(R1.amount) && cells(wbS)[0].includes('Email (lúc chốt)'), `XLSX super: Σ = ${R1.amount} đ, có cột email`)
  ok(wbM.ok && wbM.totalVnd === BigInt(sm2.dto.scopeTotal) && !cells(wbM)[0].includes('Email (lúc chốt)') && !JSON.stringify(cells(wbM)).includes('@'),
    'XLSX SM một phần: Σ = scope_total, không cột / không giá trị email')
  // AC XLSX (work order §6): đổi tên / email / tên nhà thuốc SAU chốt ⇒ file chi trả đọc lại vẫn là định danh snapshot lúc chốt.
  const orig = (await db.query(`SELECT u.full_name, u.email, s.name AS store FROM public.users u JOIN public.stores s ON s.id = u.store_id WHERE u.id = $1`, [U.A])).rows[0]
  await db.query(`UPDATE public.users SET full_name = 'Tên đổi sau chốt', email = 'doi.sau.chot@example.invalid' WHERE id = $1`, [U.A])
  await db.query(`UPDATE public.stores SET name = 'Nhà thuốc đổi tên sau chốt' WHERE id = $1`, [storeId(1)])
  const after = await payoutOf(U.super)
  const wbAfter = after.ok ? XP.buildCmsPayoutWorkbook({ program: prog, payout: after.dto, exportedAt: new Date(), scope: 'super' }) : { ok: false }
  const flat = wbAfter.ok ? JSON.stringify(cells(wbAfter)) : ''
  ok(wbAfter.ok && wbAfter.totalVnd === BigInt(R1.amount) && flat.includes(before.name) && flat.includes(before.email) && flat.includes(before.storeName)
    && !flat.includes('Tên đổi sau chốt') && !flat.includes('doi.sau.chot@') && !flat.includes('Nhà thuốc đổi tên sau chốt'),
    'XLSX super sau khi đổi tên / email / tên nhà thuốc ⇒ vẫn định danh snapshot lúc chốt, Σ không đổi', after.err ?? '')
  await db.query(`UPDATE public.users SET full_name = $2, email = $3 WHERE id = $1`, [U.A, orig.full_name, orig.email])
  await db.query(`UPDATE public.stores SET name = $2 WHERE id = $1`, [storeId(1), orig.store])
}

section('4. Chương trình THẬT: preview đọc được nhưng luôn chặn (Q-206 / policy thật pending)')
{
  const PR = await makeProgram({ isTest: false })
  const { deps, calls } = lockDeps()
  const pv = await LA.runCmsLockPreview(deps, PR.id)
  ok(pv.ok && pv.preview.blockers.includes('CMS_LOCK_RELEASE_GATE') && pv.preview.blockers.includes('CMS_LOCK_POLICY_PENDING')
    && pv.preview.blockers.includes('CMS_LOCK_NO_RESULT') && !PV.cmsLockReady(pv.preview),
  'chương trình thật: blocker RELEASE_GATE + POLICY_PENDING + NO_RESULT, không chốt được', JSON.stringify(pv).slice(0, 200))
  ok(calls.length === 1, 'preview chương trình thật: 1 RPC đọc')
  const lbl = PV.cmsLockCodeLabel('CMS_LOCK_POLICY_PENDING')
  ok(/Q-213/.test(lbl), 'nhãn POLICY_PENDING nêu Q-213 / Q-216')
}

section('5. Chặn ghi ngoài RPC (guard 123) — service_role')
{
  const r1 = await svc(`UPDATE public.cms_program_tiers SET amount_per_unit = amount_per_unit * 2 WHERE program_id = $1`, [P1.id]).then(() => 'LỌT', (e) => e.message)
  ok(/CMS_CONFIG_RPC_ONLY/.test(r1), 'service_role đổi tiền bậc trực tiếp ⇒ CMS_CONFIG_RPC_ONLY', r1)
  const r2 = await svc(`UPDATE public.cms_results SET amount_vnd = amount_vnd WHERE run_id = $1`, [R1.runId]).then(() => 'LỌT', (e) => e.message)
  ok(/CMS_RUN_RPC_ONLY/.test(r2), 'service_role sửa dữ liệu run trực tiếp ⇒ CMS_RUN_RPC_ONLY', r2)
}

section('6. Rollback 123 + chạy lại')
{
  const r = await db.exec(RB_123).then(() => null, (e) => e.message)
  ok(r === null, 'rollback 123 (chỉ QA locked) đạt', r)
  ok((await one(db, `SELECT status FROM public.cms_programs WHERE id = $1`, [P1.id]))?.status === 'locked', 'chương trình QA đã chốt GIỮ locked (H8)')
  const again = await db.exec(SQL_123).then(() => null, (e) => e.message)
  ok(again === null, 'chạy lại 123 sau rollback đạt', again)
}

await db.close()
console.log(`\n${pass} đạt · ${fail} lỗi`)
process.exitCode = fail ? 1 : 0
