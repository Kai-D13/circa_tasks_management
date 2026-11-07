// QA profile VERIFY hậu rollback 124 (PM 2026-11-05-cms-candidate-inventory-runbook-pm.md §3 INV-P1-1) trên chuỗi migration THẬT.
// Một kịch bản, hai backend: PGlite (mặc định) và PostgreSQL 15 thật (embedded, `--pg15 <embedded-postgres-dir> <data-root>`).
//   §0 chuỗi 120 → 121 → PRE122 → 122 → PRE123 → 123 → PRE124 → 124 (PRE chụp NGAY TRƯỚC từng phase, như runbook REL2)
//   §1 dữ liệu: chương trình QA đồng bộ capture ON (khối part 'source_lines') rồi CHỐT qa_assumption (run đóng băng gồm khối nguồn) +
//      chương trình QA thứ hai capture ON chưa chốt
//   §2 POST 124 đạt · profile dùng sai (phase 124 / DB còn 124) ⇒ đỏ
//   §3 rollback 124 đạt (QA chốt qa_assumption không chặn) · phần dư có chủ đích: ràng buộc part còn 'source_lines' + khối nguồn còn
//   §4 POST phase 123 THƯỜNG đỏ đúng 1 mục table-shape:cms_sync_run_chunks (tái hiện INV-P1-1) · profile ⇒ đạt
//   §5 profile KHÔNG che lệch khác: ACL (GRANT anon) · thân hàm · ràng buộc chunks về bản nền · ràng buộc bảng khác ⇒ đỏ
//   §6 rollback 123 tiếp · POST phase 122 THƯỜNG đỏ đúng 1 mục · profile ⇒ đạt · profile trên phase không hỗ trợ ⇒ đỏ
//   §7 CLI cms-verify: --profile sai lệnh / sai phase / tên lạ ⇒ mã 2 trước mọi IO
// Payout operator_reconciliation (kể cả chương trình QA) chặn rollback 124: bằng chứng ở scripts/qa-cms-124.mjs §6 (P1 is_test).
// KHÔNG chạm DB thật / nguồn thật / mạng (PG15 chỉ 127.0.0.1).
//   npm i --no-save @electric-sql/pglite@0.2.17 ; node scripts/qa-cms-rollback-profile.mjs
//   node scripts/qa-cms-rollback-profile.mjs --pg15 <embedded-postgres-dir> <data-root>
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createJiti } from 'jiti'
import * as L from './lib-care-pglite.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIG = path.join(HERE, '..', '..', 'supabase', 'migrations')
const SQL = (f) => fs.readFileSync(path.join(MIG, f), 'utf8')
const RB = (f) => fs.readFileSync(path.join(MIG, 'rollback', f), 'utf8')
const jiti = createJiti(import.meta.url, { interopDefault: true, alias: { '@': path.join(HERE, '..') } })
const lib = (p) => jiti.import(path.join(HERE, '..', p))
const T = await lib('e2e/cmsQaTooling.ts')
const C = await lib('lib/cms/source/contract.ts')
const SS = await lib('lib/cms/salesSync.ts')
const LA = await lib('lib/cms/lockAction.ts')
const FX = await lib('e2e/cmsFixtureRunner.ts')
const QR = await lib('e2e/cmsQaResults.ts')
const { U, storeId, STORES, sha } = L

const argv = process.argv.slice(2)
const PG15 = argv[0] === '--pg15'
let pass = 0, fail = 0
const ok = (c, name, extra = '') => { if (c) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) } }
const section = (s) => console.log(`\n${s}`)
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, err: String(e?.message ?? e) }))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const lastRows = (results) => { for (let i = results.length - 1; i >= 0; i--) if (results[i].rows?.length) return results[i].rows; return [] }

// ── backend ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
let cluster = null, closeDb = async () => {}
async function makeDb() {
  if (!PG15) {
    let PGlite
    try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { console.error('FAIL: thiếu @electric-sql/pglite — npm i --no-save @electric-sql/pglite@0.2.17'); process.exit(2) }
    const db = await L.freshDb(PGlite)
    closeDb = () => db.close()
    return { db, label: 'PGlite (Postgres 16 WASM)' }
  }
  const [, modDir, dataRoot] = argv
  if (!modDir || !dataRoot) { console.error('dùng: --pg15 <embedded-postgres-dir> <data-root>'); process.exit(2) }
  const req = createRequire(path.join(path.resolve(modDir), 'package.json'))
  const EmbeddedPostgres = (await import(pathToFileURL(req.resolve('embedded-postgres')).href)).default
  const pg = (await import(pathToFileURL(req.resolve('pg')).href)).default
  const PORT = 54353, PASS = 'qa-local-only', NAME = 'rpgcms_rbprofile'
  const dataDir = path.join(path.resolve(dataRoot), `pgdata-cms-rbprofile-${Date.now()}`)
  cluster = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: PASS, port: PORT, persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {}, onError: () => {} })
  await cluster.initialise(); await cluster.start()
  const conn = async (d) => { const c = new pg.Client({ host: '127.0.0.1', port: PORT, user: 'postgres', password: PASS, database: d }); c.on('error', () => {}); await c.connect(); return c }
  const admin = await conn('postgres')
  await admin.query(`CREATE DATABASE ${NAME} ENCODING 'UTF8' TEMPLATE template0`)
  await admin.end()
  const c = await conn(NAME)
  const wrap = { exec: (sql) => c.query(sql).then((r) => (Array.isArray(r) ? r : [r])), query: (sql, p) => c.query(sql, p), close: () => c.end() }
  function FakePGlite() { return wrap }
  await L.freshDb(FakePGlite, { through: '116' })
  closeDb = () => c.end()
  const ver = (await c.query('SHOW server_version')).rows[0].server_version
  return { db: wrap, label: `PostgreSQL ${ver} (embedded)` }
}

async function main() {
  const { db, label } = await makeDb()
  console.log(`QA profile VERIFY hậu rollback 124 — ${label}`)
  if (PG15) ok(label.startsWith('PostgreSQL 15.'), 'PostgreSQL 15')
  const one = async (sql, p = []) => (await db.query(sql, p)).rows[0]
  const lastQ = (sql) => db.exec(T.pgMetaReadOnly(sql)).then(lastRows)
  const svc = (sql, params = []) => L.as(db, null, () => db.query(sql, params), 'service_role')
  const snapshot = async () => { const r = (await lastQ(T.cmsVerifyAclSql()))[0]; await sleep(20); return r }

  section('0. Chuỗi 120 → 124 với PRE chụp ngay trước từng phase')
  await db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('117','t'),('118','t'),('118a','t'),('119','t'),('119a','t') ON CONFLICT DO NOTHING`)
  await db.exec(SQL('120_cms_foundation.sql')); await sleep(20)
  await db.exec(SQL('121_cms_import_activation.sql')); await sleep(20)
  const pre122 = await snapshot(); await db.exec(SQL('122_cms_results.sql')); await sleep(20)
  const pre123 = await snapshot(); await db.exec(SQL('123_cms_payouts.sql')); await sleep(20)
  const pre124 = await snapshot(); await db.exec(SQL('124_cms_source_attestation.sql')); await sleep(20)
  ok((await one(`SELECT max(version) v FROM public.app_migrations WHERE version ~ '^12[0-9]$'`)).v === '124', 'áp đủ 120 → 124 nguyên văn từ supabase/migrations')
  await db.query(`INSERT INTO public.cms_product_master (product_id, product_name, is_active, source_updated_at)
    SELECT g::text, 'SP giả ' || g, true, now() FROM generate_series(925001, 925040) g`)
  await db.query(`INSERT INTO public.cms_qa_access (user_id, granted_by, expires_at) VALUES ($1, 'qa-script:rollback-profile', now() + interval '6 hours')`, [U.super])

  // ── helper chương trình / đồng bộ / chốt (mẫu scripts/qa-cms-124.mjs; RPC THẬT vai service_role) ──
  let pidNext = 925001, seqf = 0, lineSeq = 0
  const day = async (n) => { const t = (await one(`SELECT public.cms__vn_today()::text d`)).d; const d = new Date(`${t}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
  async function makeProgram() {
    const pids = [String(pidNext++), String(pidNext++)]
    const start = await day(-20), end = await day(-1)
    const id = (await svc(`SELECT public.rpc_cms_program_save($1::jsonb) id`, [JSON.stringify({ actor: U.super, name: 'QA rollback profile', start_date: start, end_date: end,
      scope: 'stores', store_ids: [storeId(1), storeId(2)], is_test: true })])).rows[0].id
    const fileSha = sha(`frb-${++seqf}`), digest = sha(`drb-${seqf}`)
    const run = (await svc(`SELECT public.rpc_cms_import_preview_save($1::jsonb) id`, [JSON.stringify({ program_id: id, mode: 'replace', file_name: 'qa.xlsx',
      file_sha256: fileSha, file_bytes: 10, actor: U.super, stats: { rowsTotal: 1, rowsOk: 1, rowsRejected: 0, warnings: 0, productsOk: 1, productsRejected: 0 }, result: { digest } })])).rows[0].id
    await svc(`SELECT public.rpc_cms_import_commit($1, $2, $3, $4::jsonb, $5)`, [run, fileSha, digest, JSON.stringify({ mode: 'replace', catalog_target: null,
      products: pids.map((product_id) => ({ product_id, gmv_basis: 'none', target_gmv: null, base_quantity_cms: '2', tiers: [{ order: 1, from: 1, to: null, amount: '1000' }],
        unit_cms: 'hộp', advice_text: 'QA', name_snapshot: 'SP giả', image_url_snapshot: null, price_snapshot: null })) }), U.super])
    await svc(`SELECT public.rpc_cms_program_activate($1, $2)`, [id, U.super])
    return { id, pids, start, end }
  }
  const EM = (i, ab) => STORES[i - 1].assigneeEmails[ab === 'a' ? 0 : 1]
  function rawRows(p, n, extra = []) {
    const out = []
    const base = Date.parse(`${p.start}T01:00:00Z`)
    const specs = [{ n }, ...extra]
    for (const s of specs) for (let i = 0; i < s.n; i++) {
      const id = ++lineSeq
      const at = new Date(base + id * 3_600_000).toISOString().replace('Z', '').padEnd(23, '0') + `${String(id % 1000).padStart(3, '0')}Z`
      out.push({ order_line_id: String(925000000 + id), order_id: `O${id}`, order_code: `QA-${id}`, product_id: p.pids[i % p.pids.length],
        seller_email: [EM(1, 'a'), EM(1, 'b'), EM(2, 'a'), EM(2, 'b')][i % 4], pos_code: 'QAOS01', order_type: s.type ?? 'OFFLINE',
        order_status: 'COMPLETED', completed_at: at, quantity_raw: '1', uom_raw: 'Hộp', base_quantity: String(1 + (i % 3)),
        gmv_amount: String(10000 + i * 100), source_updated_at: at })
    }
    for (const r of out) if (!C.normalizeSalesRow(r).ok) throw new Error('dòng giả lỗi')
    return out
  }
  const rpc = async (sql, params) => { try { return (await svc(sql, params)).rows[0].r } catch (e) { const m = /\bCMS_[A-Z0-9_]+\b/.exec(String(e.message)); throw new Error(m ? m[0] : 'RPC_FAILED') } }
  const syncDeps = (rows) => ({
    table: QR.CMS_QA_FAKE_TABLE, runner: FX.createCmsFixtureRunner({ sales: rows }),
    loadSnapshot: (id) => rpc(`SELECT public.rpc_cms_sales_snapshot($1) r`, [id]),
    openRun: (id, detail) => rpc(`SELECT public.rpc_cms_sales_run_open($1, $2::jsonb) r`, [id, JSON.stringify(detail)]),
    stage: async (runId, part, chunkNo, rws) => Number(await rpc(`SELECT public.rpc_cms_sales_run_stage($1, $2, $3, $4::jsonb) r`, [runId, part, chunkNo, JSON.stringify(rws)])),
    sealBegin: (runId, expect) => rpc(`SELECT public.rpc_cms_sales_run_seal_begin($1, $2::jsonb) r`, [runId, JSON.stringify(expect)]),
    sealStep: (runId, step) => rpc(`SELECT public.rpc_cms_sales_run_seal_step($1, $2) r`, [runId, step]),
    publish: (runId) => rpc(`SELECT public.rpc_cms_sales_run_publish($1) r`, [runId]),
    finish: async (runId, status, detail) => { await rpc(`SELECT public.rpc_cms_sales_run_finish($1, $2, $3::jsonb) r`, [runId, status, JSON.stringify(detail)]) },
    cleanup: (id, max) => rpc(`SELECT public.rpc_cms_sales_run_cleanup($1, $2) r`, [id, max]),
    now: () => Date.now(),
  })
  const lockDeps = {
    lockEnabled: () => true, qaReadonly: () => false, access: async () => ({ kind: 'ok', actorId: U.super, qa: true }),
    program: async (id) => { const r = await one(`SELECT is_test FROM public.cms_programs WHERE id = $1`, [id]); return r ? { isTest: r.is_test } : null },
    rpc: async (fn, args) => {
      const named = Object.keys(args).map((k, i) => `${k} => $${i + 1}`).join(', ')
      try { return { data: (await svc(`SELECT public.${fn}(${named}) r`, Object.values(args))).rows[0].r, error: null } } catch (e) { return { data: null, error: { code: e.code, message: e.message } } }
    },
  }
  const srcChunks = async (runId) => Number((await one(`SELECT count(*)::int n FROM public.cms_sync_run_chunks WHERE run_id = $1 AND part = 'source_lines'`, [runId])).n)

  section('1. Dữ liệu: QA chốt qa_assumption có khối nguồn (run đóng băng) + QA có khối nguồn chưa chốt')
  const P = await makeProgram()
  const rP = await SS.runCmsSalesSync(syncDeps(rawRows(P, 30, [{ n: 4, type: 'ONLINE' }])), P.id, { dryRun: false, source: 'qa', sourceCapture: true })
  ok(rP.status === 'published' && (await srcChunks(rP.runId)) > 0, `QA-1 capture ON: công bố, ${await srcChunks(rP.runId)} khối part source_lines`, JSON.stringify([rP.status, rP.code]))
  const pv = await LA.runCmsLockPreview(lockDeps, P.id)
  ok(pv.ok && pv.preview.sourceCompleteBasis === 'qa_assumption', 'preview QA-1 (không chứng nhận): basis qa_assumption', JSON.stringify(pv.ok ? pv.preview.sourceCompleteBasis : pv))
  const lk = pv.ok ? await LA.runCmsLock(lockDeps, { programId: P.id, expectedRunId: rP.runId, expectedPolicyVersion: pv.preview.policyVersion, ackReason: 'Đã soát dòng chưa gán (QA giả rollback profile)' }) : { ok: false }
  const pay = await one(`SELECT source_complete_basis b, run_id::text r FROM public.cms_payouts WHERE program_id = $1`, [P.id])
  ok(lk.ok && pay?.b === 'qa_assumption' && pay?.r === rP.runId, 'QA-1 chốt qa_assumption ⇒ payout + run đóng băng (gồm khối source_lines)', JSON.stringify(lk))
  const Q = await makeProgram()
  const rQ = await SS.runCmsSalesSync(syncDeps(rawRows(Q, 12)), Q.id, { dryRun: false, source: 'qa', sourceCapture: true })
  ok(rQ.status === 'published' && (await srcChunks(rQ.runId)) > 0, 'QA-2 capture ON chưa chốt: có khối source_lines', JSON.stringify([rQ.status, rQ.code]))

  // PGlite / PG15 nhúng: owner hàm SECDEF = postgres, isolation mặc định ⇒ 2 mục môi trường (như qa-cms-124 / qa-cms-qa-tooling).
  const ENV_ONLY = new Set(['v7-isolation-123', 'isolation'])
  async function postInput(phase, aclPre, profile) {
    const q = T.CMS_VERIFY_SQL
    const P_ = Number(phase)
    const input = {
      phase, whoami: (await lastQ(q.whoami))[0], markers: await lastQ(q.markers), maxNumeric: (await lastQ(q.maxNumeric))[0],
      functions: await lastQ(q.functions), policies: await lastQ(q.policies), triggers: await lastQ(q.triggers), tableShape: await lastQ(q.tableShape),
      tables: await lastQ(q.tables), roles: await lastQ(q.roles), oneRunningIndex: await lastQ(q.oneRunningIndex),
      aclPost: (await lastQ(T.cmsVerifyAclSql()))[0], aclPre,
      inv121: { overlap: await lastQ(q.inv121Overlap), tiers: await lastQ(q.inv121Tiers), catalog: await lastQ(q.inv121Catalog) },
      isolation: (await lastQ(q.isolation))[0],
      p122: { tiersUnique: await lastQ(q.tiersUnique), pointerFk: await lastQ(q.pointerFk), releaseGate: (await lastQ(q.releaseGate))[0],
        inv122Pointer: await lastQ(q.inv122Pointer), fnDefs: await lastQ(q.fnDefs), columns: await lastQ(q.columns) },
    }
    if (P_ >= 123) {
      input.p123 = { owners: (await lastQ(q.owners))[0], isolation123: (await lastQ(q.isolation123))[0], triggerFns: await lastQ(q.triggerFns),
        lockPolicy: (await lastQ(q.lockPolicy))[0], payoutAcl: await lastQ(q.payoutAcl), invPayout: (await lastQ(q.invPayout))[0] ?? { n: 0, bad: 0 },
        invLocked: (await lastQ(q.invLocked))[0], invPayoutStaff: (await lastQ(q.invPayoutStaff))[0] ?? { n: 0, bad: 0 },
        invRunFrozen: (await lastQ(q.invRunFrozen))[0] ?? { n: 0, bad: 0 }, payoutReach: await lastQ(q.payoutReach), lockPreview: (await lastQ(q.lockPreview))[0] ?? { n_real: 0, open_n: 0 } }
    }
    if (phase === '124') input.p124 = { invAttest: (await lastQ(q.invAttest))[0] ?? { n: 0, bad: 0 } }
    if (profile) input.profile = profile
    return input
  }
  const bad = (cs) => cs.filter((c) => !c.ok && !ENV_ONLY.has(c.id))
  const ids = (cs) => bad(cs).map((c) => c.id)
  const show = (cs) => bad(cs).map((c) => `${c.id}: ${c.detail}`).slice(0, 5).join(' | ')
  const PROF = 'after-rollback-124'

  section('2. POST 124 (DB 124) đạt · profile dùng sai ⇒ đỏ')
  const post124 = T.evaluateCmsVerify(await postInput('124', pre124))
  ok(bad(post124).length === 0, `POST phase 124: ${post124.length} mục, lệch ${bad(post124).length} (ngoài 2 mục môi trường)`, show(post124))
  const misuse124 = T.evaluateCmsVerify(await postInput('124', pre124, PROF))
  ok(ids(misuse124).includes('profile') && ids(misuse124).includes('profile-124-absent'), 'profile với --phase=124 ⇒ mục profile + profile-124-absent ĐỎ (không áp phần dư)', ids(misuse124).join(','))
  const early = T.evaluateCmsVerify(await postInput('123', pre123, PROF))
  ok(ids(early).includes('phase-match') && ids(early).includes('profile-124-absent'), 'profile phase 123 trên DB CÒN 124 ⇒ phase-match + profile-124-absent ĐỎ', ids(early).join(','))

  section('3. Rollback 124 (QA chốt qa_assumption không chặn) · phần dư có chủ đích')
  const rb124 = await settle(db.exec(RB('124_cms_source_attestation_rollback.sql')))
  if (!rb124.ok) await db.exec('ROLLBACK').catch(() => {})
  ok(rb124.ok, 'rollback 124 đạt khi chỉ có payout qa_assumption', rb124.err)
  const resid = await one(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname = 'cms_sync_run_chunks_part_check'`)
  ok(/source_lines/.test(String(resid?.d)), 'ràng buộc part cms_sync_run_chunks vẫn nhận source_lines (giữ có chủ đích — header rollback 124)', String(resid?.d))
  ok((await srcChunks(rP.runId)) > 0 && (await srcChunks(rQ.runId)) > 0, 'khối source_lines của run đã chốt (đóng băng) và run chưa chốt vẫn còn')
  const gone = await one(`SELECT to_regclass('public.cms_source_attestations') a, to_regclass('public.cms_sales_source_lines') s,
    (SELECT count(*)::int FROM public.app_migrations WHERE version = '124') m,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cms_sync_runs' AND column_name = 'source_schema') c`)
  ok(gone.a === null && gone.s === null && gone.m === 0 && gone.c === 0, 'đã gỡ: 2 bảng 124, cột source_schema, marker 124')

  section('4. POST phase 123 sau rollback 124: thường ⇒ đỏ đúng 1 mục (INV-P1-1) · profile ⇒ đạt')
  const n123 = T.evaluateCmsVerify(await postInput('123', pre123))
  ok(JSON.stringify(ids(n123)) === JSON.stringify(['table-shape:cms_sync_run_chunks']), 'phase 123 THƯỜNG: đỏ ĐÚNG table-shape:cms_sync_run_chunks (không nới baseline)', ids(n123).join(',') || '(không đỏ)')
  const p123 = T.evaluateCmsVerify(await postInput('123', pre123, PROF))
  ok(bad(p123).length === 0 && p123.some((c) => c.id === 'profile' && c.ok) && p123.some((c) => c.id === 'profile-124-absent' && c.ok),
    `phase 123 + profile ${PROF}: ${p123.length} mục đạt (ACL mọi hàm có trước = PRE123, thân 5 hàm khôi phục, trigger / bảng / cột theo 123)`, show(p123))
  ok(p123.some((c) => c.id === 'v5-payout-invariants' && c.ok && c.proven === true) && p123.some((c) => c.id === 'v5-run-frozen' && c.ok && c.proven === true),
    'V5 payout QA + run đóng băng còn nguyên sau rollback 124 (đã chứng minh trên payout qa_assumption)')

  section('5. Profile KHÔNG che lệch khác')
  await db.exec(`GRANT EXECUTE ON FUNCTION public.rpc_cms_payout(uuid) TO anon`)
  const dAcl = ids(T.evaluateCmsVerify(await postInput('123', pre123, PROF)))
  ok(dAcl.includes('fn-exec:rpc_cms_payout') && dAcl.includes('fn-acl:rpc_cms_payout'), 'GRANT EXECUTE anon rpc_cms_payout ⇒ fn-acl / fn-exec ĐỎ dưới profile', dAcl.join(','))
  await db.exec(`REVOKE EXECUTE ON FUNCTION public.rpc_cms_payout(uuid) FROM anon`)
  const def = (await one(`SELECT pg_get_functiondef('public.cms__lock_eval(uuid, uuid, integer, text, boolean)'::regprocedure) d`)).d
  await db.exec(def.replace(/\nBEGIN\n/, '\nBEGIN\n  -- lệch giả (QA profile)\n'))
  const dSrc = ids(T.evaluateCmsVerify(await postInput('123', pre123, PROF)))
  ok(dSrc.includes('fn-src:cms__lock_eval'), 'thân cms__lock_eval bị sửa ⇒ fn-src ĐỎ dưới profile', dSrc.join(','))
  await db.exec(def)
  const tamper = async (t, con) => { const inp = await postInput('123', pre123, PROF); inp.tableShape = inp.tableShape.map((r) => (String(r.t) === t ? { ...r, con_md5: con } : r)); return ids(T.evaluateCmsVerify(inp)) }
  const dBase = await tamper('cms_sync_run_chunks', T.CMS_TABLE_SHAPE_123.cms_sync_run_chunks.con)
  ok(dBase.includes('table-shape:cms_sync_run_chunks'), 'ràng buộc chunks = bản NỀN 4 part ⇒ ĐỎ dưới profile (chỉ nhận đúng phần dư)', dBase.join(','))
  const tamperIdx = async (t, idx) => { const inp = await postInput('123', pre123, PROF); inp.tableShape = inp.tableShape.map((r) => (String(r.t) === t ? { ...r, idx_md5: idx } : r)); return ids(T.evaluateCmsVerify(inp)) }
  const dIdx = await tamperIdx('cms_sync_run_chunks', '0'.repeat(32))
  ok(dIdx.includes('table-shape:cms_sync_run_chunks'), 'index cms_sync_run_chunks lệch bản nền ⇒ ĐỎ dưới profile (phần dư chỉ là ràng buộc, index ghim nền)', dIdx.join(','))
  const dOther = await tamper('cms_payouts', T.CMS_TABLE_SHAPE_124.cms_payouts.con)
  ok(dOther.includes('table-shape:cms_payouts'), 'ràng buộc cms_payouts mang bản 124 ⇒ ĐỎ dưới profile (phần dư chỉ một bảng)', dOther.join(','))
  const clean = bad(T.evaluateCmsVerify(await postInput('123', pre123, PROF)))
  ok(clean.length === 0, 'khôi phục ACL / thân ⇒ profile lại đạt', clean.map((c) => c.id).join(','))

  section('6. Rollback 123 tiếp · POST phase 122: thường ⇒ đỏ đúng 1 mục · profile ⇒ đạt')
  const rb123 = await settle(db.exec(RB('123_cms_payouts_rollback.sql')))
  if (!rb123.ok) await db.exec('ROLLBACK').catch(() => {})
  ok(rb123.ok, 'rollback 123 đạt (chỉ chương trình QA locked — H8 giữ locked)', rb123.err)
  const n122 = T.evaluateCmsVerify(await postInput('122', pre122))
  ok(JSON.stringify(ids(n122)) === JSON.stringify(['table-shape:cms_sync_run_chunks']), 'phase 122 THƯỜNG: đỏ ĐÚNG table-shape:cms_sync_run_chunks', ids(n122).join(',') || '(không đỏ)')
  const p122 = T.evaluateCmsVerify(await postInput('122', pre122, PROF))
  ok(bad(p122).length === 0 && p122.some((c) => c.id === 'profile' && c.ok), `phase 122 + profile ${PROF}: ${p122.length} mục đạt`, show(p122))
  const p121 = T.evaluateCmsVerify(await postInput('121', pre122, PROF))
  ok(ids(p121).includes('profile'), 'profile với phase 121 (không hỗ trợ) ⇒ mục profile ĐỎ', ids(p121).join(','))

  section('7. CLI cms-verify: --profile sai ⇒ mã 2 trước mọi IO')
  // Các ca đều dừng ở kiểm --profile TRƯỚC khi đọc env / mạng (cms-verify.mjs); nếu kiểm đó hỏng, chốt --expect-host (không truyền) vẫn
  // dừng mã 2 trước mọi IO — không có đường gọi pg-meta từ test này.
  const cli = (args) => spawnSync(process.execPath, [path.join(HERE, 'cms-verify.mjs'), ...args], { encoding: 'utf8' })
  for (const [args, why] of [
    [['post', '--phase=124', `--profile=${PROF}`], 'phase 124'],
    [['post', '--phase=121', `--profile=${PROF}`], 'phase 121'],
    [['post', '--phase=123', '--profile=after-rollback-999'], 'tên lạ'],
    [['v8', '--phase=123', `--profile=${PROF}`], 'lệnh v8'],
    [['acl-snapshot', `--profile=${PROF}`], 'lệnh acl-snapshot'],
  ]) {
    const r = cli(args)
    ok(r.status === 2 && /--profile/.test(`${r.stdout}${r.stderr}`), `--profile ${why} ⇒ mã 2`, `rc ${r.status} ${(r.stdout + r.stderr).slice(0, 160)}`)
  }
}

try { await main() } catch (e) { fail++; console.log(`\nLỖI NGOÀI DỰ KIẾN: ${e?.stack ?? e}`) } finally {
  try { await closeDb() } catch {}
  if (cluster) { try { await cluster.stop() } catch {} }
}
console.log(`\n${pass} đạt · ${fail} lỗi`)
process.exitCode = fail ? 1 : 0
