// QA migration 126 (CMS sales-only — PM 06/11 đổi phạm vi: cổng kết quả bán tạm tính tách khỏi trả hàng) trên chuỗi migration THẬT
// 120 → 125 → 126 + tầng app MỚI (releaseGate SALES_ONLY_V1). Hai backend: PGlite (mặc định, Postgres 16 WASM) và PostgreSQL 15 thật
// (embedded: `--pg15 <embedded-postgres-dir> <data-root>`).
//   §0 generator ↔ file · md5 thân 122 = ma trận VERIFY · hằng app (mode SALES_ONLY_V1, trả hàng HOLD, mã held chung)
//   §1 DB 125 (cổng DB đóng) + app mới: chương trình thật đồng bộ ⇒ publish held RESULTS_RELEASE_GATE ở DB (lớp 2), pointer null
//   §2 áp 126: marker + inventory · cổng mở · policy chốt thật vẫn false · ACL / SECDEF / volatility · tổng hàm 68 · md5 thân · chạy lại bị chặn
//   §3 sau 126: AC03 / AC04 thật dương qua nguồn → engine → stage → seal → publish → đọc lại, tiền = oracle độc lập (Q 9/10/19/20/50/100,
//      K lẻ) + dấu results_basis · AC06 replay cùng tập = cùng tiền, không cộng dồn · AC05 dòng âm (INCLUDED / chưa gán) ⇒ app held
//      0 stage; RPC TRỰC TIẾP (bỏ qua app) cũng held, pointer giữ; totals hỏng ⇒ fail-closed · QA điều chỉnh vẫn công bố · AC08 nguồn qa
//      vào chương trình thật ⇒ 0 run · AC09 chốt thật vẫn bị policy chặn (không còn blocker cổng) · AC06 cấu hình đổi giữa seal / publish
//   §4 VERIFY phase 126 đạt · phase 125 trên DB 126 đỏ · đột biến (grant helper / thân publish lạ) đỏ
//   §5 rollback 126 ⇒ cổng đóng, thân 122 nguyên văn, run đã công bố giữ, VERIFY 125 ĐẠT · preflight rollback / 126 dừng khi thân lạ ·
//      áp lại 126
//   §6 (chỉ --pg15) race: 126 × giao dịch đang ghi bảng run ⇒ hết lock_timeout rồi áp lại được; 2 publish đồng thời cùng run ⇒ đúng 1
//      công bố · benchmark ở TRẦN nguồn 200.000 dòng (19 % chưa gán) — mỗi RPC stage / seal / publish < 8 s (statement_timeout 8 s)
// KHÔNG chạm DB thật / nguồn thật / mạng (PG15 chỉ 127.0.0.1).
//   npm i --no-save @electric-sql/pglite@0.2.17 ; node scripts/qa-cms-126.mjs
//   node scripts/qa-cms-126.mjs --pg15 <embedded-postgres-dir> <data-root> [--bench-rows=200000]
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createJiti } from 'jiti'
import * as L from './lib-care-pglite.mjs'
import { buildCms126, CMS_126_FILE, CMS_126_ROLLBACK_FILE, CMS_126_HELD_CODE } from './gen-cms-126.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIG = path.join(HERE, '..', '..', 'supabase', 'migrations')
const SQL = (f) => fs.readFileSync(path.join(MIG, f), 'utf8')
const SQL_126 = fs.readFileSync(CMS_126_FILE, 'utf8')
const RB_126 = fs.readFileSync(CMS_126_ROLLBACK_FILE, 'utf8')
const jiti = createJiti(import.meta.url, { interopDefault: true, alias: { '@': path.join(HERE, '..') } })
const lib = (p) => jiti.import(path.join(HERE, '..', p))
const T = await lib('e2e/cmsQaTooling.ts')
const C = await lib('lib/cms/source/contract.ts')
const SS = await lib('lib/cms/salesSync.ts')
const RG = await lib('lib/cms/releaseGate.ts')
const RS = await lib('lib/cms/resultStage.ts')
const EN = await lib('lib/cms/engine/compute.ts')
const FX = await lib('e2e/cmsFixtureRunner.ts')
const QR = await lib('e2e/cmsQaResults.ts')
const { U, storeId, STORES, sha } = L

const argv = process.argv.slice(2)
const PG15 = argv[0] === '--pg15'
const BENCH_ROWS = Number((argv.find((a) => a.startsWith('--bench-rows=')) ?? '--bench-rows=200000').split('=')[1])
const BENCH_ONLY = argv.includes('--bench-only')
let pass = 0, fail = 0
const ok = (c, name, extra = '') => { if (c) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) } }
const section = (s) => console.log(`\n${s}`)
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, err: String(e?.message ?? e), code: e?.code }))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const execFail = async (db, sql) => { const r = await settle(db.exec(sql)); if (!r.ok) await db.exec('ROLLBACK').catch(() => {}); return r }
const lastRows = (results) => { for (let i = results.length - 1; i >= 0; i--) if (results[i].rows?.length) return results[i].rows; return [] }
const B = (x) => BigInt(x)
/** Oracle ĐỘC LẬP bậc 1–9 @15.000 · 10–19 @20.000 · từ 20 @25.000 (không dùng tiers.ts / SQL seal). */
const stakeF = (q) => { q = B(q); const mn = (a, b) => (a < b ? a : b), mx = (a, b) => (a > b ? a : b); return B(15000) * mn(q, B(9)) + B(20000) * mn(mx(q - B(9), B(0)), B(10)) + B(25000) * mx(q - B(19), B(0)) }
const HELD = RG.CMS_RETURNS_NOT_SUPPORTED

// ── §0 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
section('0. Generator ↔ file · md5 nền 122 · hằng app')
const GEN = buildCms126()
ok(GEN.migration === SQL_126 && GEN.rollback === RB_126, 'scripts/gen-cms-126.mjs sinh ĐÚNG byte 126 + rollback trên đĩa')
ok(!SQL_126.includes('\r') && !RB_126.includes('\r'), '126 + rollback giữ LF (md5 thân bỏ \\r như VERIFY)')
ok(GEN.md5s.gate122 === T.CMS_FN_MATRIX.cms__results_release_open.src && GEN.md5s.publish122 === T.CMS_FN_MATRIX.rpc_cms_sales_run_publish.src,
  'preflight md5 = thân 122 trong ma trận VERIFY (không ghi đè thân lạ)')
if (T.CMS_FN_SRC_126) {
  ok(GEN.md5s.gate126 === T.CMS_FN_SRC_126.cms__results_release_open && GEN.md5s.publish126 === T.CMS_FN_SRC_126.rpc_cms_sales_run_publish,
    'thân 126 sinh từ generator = CMS_FN_SRC_126 của VERIFY')
} else ok(false, 'CMS_FN_SRC_126 có trong cmsQaTooling.ts')
ok(RG.CMS_RESULTS_RELEASE_MODE === 'SALES_ONLY_V1' && RG.CMS_Q206_RETURNS_CONTRACT === 'HOLD' && RG.cmsCanPublishResults(false) && RG.cmsAdjustmentBlocksRelease(false)
  && HELD === CMS_126_HELD_CODE, 'app: cổng kết quả SALES_ONLY_V1, trả hàng HOLD (không APPROVED), mã held app = mã held DB 126')
ok(/SELECT true/.test(GEN.replaced.gate) && GEN.replaced.publish.includes(`THEN '${HELD}'`) && GEN.replaced.publish.includes("'results_basis', 'sales_only_v1'"),
  'thân 126: cổng true · nhánh held điều chỉnh · dấu results_basis')

// ── backend ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
let cluster = null, pgMod = null, PORT = 0, PASS = ''
const closers = []
async function makeDb(tag) {
  if (!PG15) {
    let PGlite
    try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { console.error('FAIL: thiếu @electric-sql/pglite — npm i --no-save @electric-sql/pglite@0.2.17'); process.exit(2) }
    const db = await L.freshDb(PGlite)
    closers.push(() => db.close())
    return { db, label: 'PGlite (Postgres 16 WASM)', conn: null }
  }
  if (!cluster) {
    const [, modDir, dataRoot] = argv
    if (!modDir || !dataRoot) { console.error('dùng: --pg15 <embedded-postgres-dir> <data-root>'); process.exit(2) }
    const req = createRequire(path.join(path.resolve(modDir), 'package.json'))
    const EmbeddedPostgres = (await import(pathToFileURL(req.resolve('embedded-postgres')).href)).default
    pgMod = (await import(pathToFileURL(req.resolve('pg')).href)).default
    PORT = 54356; PASS = 'qa-local-only'
    cluster = new EmbeddedPostgres({ databaseDir: path.join(path.resolve(dataRoot), `pgdata-cms126-${Date.now()}`), user: 'postgres', password: PASS, port: PORT,
      persistent: true, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {}, onError: () => {} })
    await cluster.initialise(); await cluster.start()
  }
  const name = `rpgcms126_${tag}`
  const conn = async (d = name) => { const c = new pgMod.Client({ host: '127.0.0.1', port: PORT, user: 'postgres', password: PASS, database: d }); c.on('error', () => {}); await c.connect(); closers.push(() => c.end().catch(() => {})); return c }
  const admin = await conn('postgres')
  await admin.query(`CREATE DATABASE ${name} ENCODING 'UTF8' TEMPLATE template0`)
  const c = await conn()
  const wrap = { exec: (sql) => c.query(sql).then((r) => (Array.isArray(r) ? r : [r])), query: (sql, p) => c.query(sql, p), close: () => c.end() }
  const rolesExist = (await c.query(`SELECT count(*)::int n FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')`)).rows[0].n === 3
  const ROLES = 'CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;'
  function FakePGlite() { return rolesExist ? { ...wrap, exec: (sql) => wrap.exec(sql.split(ROLES).join('')) } : wrap }
  await L.freshDb(FakePGlite, { through: '116' })
  const ver = (await c.query('SHOW server_version')).rows[0].server_version
  return { db: wrap, label: `PostgreSQL ${ver} (embedded)`, conn }
}

/** Môi trường một DB: chuỗi 120 → 125 (PRE chụp ngay trước 125 / 126), helper chương trình / bán / đồng bộ / stage trực tiếp. */
async function env(tag) {
  const { db, label, conn } = await makeDb(tag)
  const one = async (sql, p = []) => (await db.query(sql, p)).rows[0]
  const all = async (sql, p = []) => (await db.query(sql, p)).rows
  const lastQ = (sql) => db.exec(T.pgMetaReadOnly(sql)).then(lastRows)
  const svc = (sql, params = []) => L.as(db, null, () => db.query(sql, params), 'service_role')
  const snapshot = async () => { const r = (await lastQ(T.cmsVerifyAclSql()))[0]; await sleep(20); return r }
  await db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('117','t'),('118','t'),('118a','t'),('119','t'),('119a','t') ON CONFLICT DO NOTHING`)
  for (const f of ['120_cms_foundation.sql', '121_cms_import_activation.sql', '122_cms_results.sql', '123_cms_payouts.sql', '124_cms_source_attestation.sql']) { await db.exec(SQL(f)); await sleep(20) }
  const pre125 = await snapshot()
  await db.exec(SQL('125_cms_uncapped_last_tier.sql')); await sleep(20)
  const pre126 = await snapshot()
  await db.query(`INSERT INTO public.cms_product_master (product_id, product_name, is_active, source_updated_at)
    SELECT g::text, 'SP giả ' || g, true, now() FROM generate_series(936001, 938200) g`)
  await db.query(`INSERT INTO public.cms_qa_access (user_id, granted_by, expires_at) VALUES ($1, 'qa-script:cms-126', now() + interval '6 hours')`, [U.super])
  let pidNext = 936001, seqf = 0, lineSeq = 0
  const pid = () => String(pidNext++)
  const day = async (n) => { const t = (await one(`SELECT public.cms__vn_today()::text d`)).d; const d = new Date(`${t}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
  const prodPayload = (p) => ({ product_id: p.pid, gmv_basis: p.basis ?? 'none', target_gmv: p.target ?? null, base_quantity_cms: p.k ?? '1', tiers: p.tiers,
    unit_cms: 'hộp', advice_text: 'QA', name_snapshot: 'SP giả', image_url_snapshot: null, price_snapshot: null })
  async function preview(id, mode = 'replace') {
    const fileSha = sha(`f126-${tag}-${++seqf}`), digest = sha(`d126-${tag}-${seqf}`)
    const run = (await svc(`SELECT public.rpc_cms_import_preview_save($1::jsonb) id`, [JSON.stringify({ program_id: id, mode, file_name: 'qa.xlsx', file_sha256: fileSha,
      file_bytes: 10, actor: U.super, stats: { rowsTotal: 1, rowsOk: 1, rowsRejected: 0, warnings: 0, productsOk: 1, productsRejected: 0 }, result: { digest } })])).rows[0].id
    return { run, fileSha, digest }
  }
  const commit = async (pr, mode, products) => (await svc(`SELECT public.rpc_cms_import_commit($1, $2, $3, $4::jsonb, $5) r`,
    [pr.run, pr.fileSha, pr.digest, JSON.stringify({ mode, catalog_target: null, products: products.map(prodPayload) }), U.super])).rows[0].r
  async function makeProgram({ name = 'QA CMS 126', isTest = true, products }) {
    const start = await day(-20), end = await day(-1)
    const id = (await svc(`SELECT public.rpc_cms_program_save($1::jsonb) id`, [JSON.stringify({ actor: U.super, name, start_date: start, end_date: end,
      scope: 'stores', store_ids: [storeId(1), storeId(2)], is_test: isTest })])).rows[0].id
    await commit(await preview(id), 'replace', products)
    await svc(`SELECT public.rpc_cms_program_activate($1, $2)`, [id, U.super])
    return { id, products, start, end, isTest }
  }
  const SELLERS = [STORES[0].assigneeEmails[0], STORES[0].assigneeEmails[1], STORES[1].assigneeEmails[0], STORES[1].assigneeEmails[1]]
  const SELLER_IDS = [L.staffId(1, 'a'), L.staffId(1, 'b'), L.staffId(2, 'a'), L.staffId(2, 'b')]
  /** Dòng nguồn giả trong kỳ: specs [{ pid, s (người bán 0…3) | email, base, gmv, n, type, status }]. */
  function rows(p, specs) {
    const out = []
    const t0 = Date.parse(`${p.start}T01:00:00Z`)
    for (const sp of specs) for (let i = 0; i < (sp.n ?? 1); i++) {
      const id = ++lineSeq
      const at = new Date(t0 + id * 1000).toISOString().replace('Z', '').padEnd(23, '0') + `${String(id % 1000).padStart(3, '0')}Z`
      out.push({ order_line_id: String(936000000 + id), order_id: `O${id}`, order_code: `QA-${id}`, product_id: sp.pid, seller_email: sp.email ?? SELLERS[sp.s ?? 0], pos_code: 'QAOS01',
        order_type: sp.type ?? 'OFFLINE', order_status: sp.status ?? 'COMPLETED', completed_at: at, quantity_raw: '1', uom_raw: 'Hộp', base_quantity: String(sp.base ?? 1),
        gmv_amount: String(sp.gmv ?? 10000), source_updated_at: at })
    }
    for (const r of out) if (!C.normalizeSalesRow(r).ok) throw new Error('dòng giả lỗi')
    return out
  }
  const rpc = async (sql, params) => { try { return (await svc(sql, params)).rows[0].r } catch (e) { const m = /\bCMS_[A-Z0-9_]+\b/.exec(String(e.message)); throw new Error(m ? m[0] : `RPC_FAILED ${String(e.message).slice(0, 120)}`) } }
  const timings = []
  const timed = (fn, label) => async (...a) => { const t = Date.now(); try { return await fn(...a) } finally { timings.push({ label, ms: Date.now() - t }) } }
  const syncDeps = (rws) => ({
    table: QR.CMS_QA_FAKE_TABLE, runner: FX.createCmsFixtureRunner({ sales: rws }),
    loadSnapshot: (id) => rpc(`SELECT public.rpc_cms_sales_snapshot($1) r`, [id]),
    openRun: (id, detail) => rpc(`SELECT public.rpc_cms_sales_run_open($1, $2::jsonb) r`, [id, JSON.stringify(detail)]),
    stage: async (runId, part, chunkNo, x) => { const t = Date.now(); try { return Number(await rpc(`SELECT public.rpc_cms_sales_run_stage($1, $2, $3, $4::jsonb) r`, [runId, part, chunkNo, JSON.stringify(x)])) } finally { timings.push({ label: 'stage', part, chunkNo, ms: Date.now() - t }) } },
    sealBegin: timed((runId, expect) => rpc(`SELECT public.rpc_cms_sales_run_seal_begin($1, $2::jsonb) r`, [runId, JSON.stringify(expect)]), 'seal_begin'),
    sealStep: timed((runId, step) => rpc(`SELECT public.rpc_cms_sales_run_seal_step($1, $2) r`, [runId, step]), 'seal_step'),
    publish: timed((runId) => rpc(`SELECT public.rpc_cms_sales_run_publish($1) r`, [runId]), 'publish'),
    finish: async (runId, status, detail) => { await rpc(`SELECT public.rpc_cms_sales_run_finish($1, $2, $3::jsonb) r`, [runId, status, JSON.stringify(detail)]) },
    cleanup: (id, max) => rpc(`SELECT public.rpc_cms_sales_run_cleanup($1, $2) r`, [id, max]),
    now: () => Date.now(),
  })
  const sync = (p, rws, source = 'cron') => SS.runCmsSalesSync(syncDeps(rws), p.id, { dryRun: false, source, sourceCapture: true })
  /** Stage + seal TRỰC TIẾP qua RPC (bỏ qua kiểm dòng âm của app — mô phỏng caller service_role gọi thẳng), KHÔNG publish. */
  async function stageDirect(p, rws) {
    const raw = await rpc(`SELECT public.rpc_cms_sales_run_open($1, $2::jsonb) r`, [p.id, JSON.stringify({ source: 'operator' })])
    const snap = RS.parseCmsSalesSnapshot(raw)
    const lines = rws.map((r) => { const n = C.normalizeSalesRow(r); if (!n.ok) throw new Error('dòng lỗi'); return n.value })
    const ei = RS.cmsSnapshotToEngineInput(snap)
    const out = EN.computeCmsProgram({ program: ei.program, lines, sellers: ei.sellers })
    const payload = RS.buildCmsStagePayload(snap, lines, out, { rowsRead: rws.length, rowsRejected: 0, bytesProcessed: null })
    for (const part of RS.CMS_STAGE_PARTS) {
      const chunks = RS.chunkCmsStageRows(payload.parts[part])
      for (let i = 0; i < chunks.length; i++) await rpc(`SELECT public.rpc_cms_sales_run_stage($1, $2, $3, $4::jsonb) r`, [snap.runId, part, i, JSON.stringify(chunks[i])])
    }
    const seal = await SS.runCmsSealSteps({ begin: () => rpc(`SELECT public.rpc_cms_sales_run_seal_begin($1, $2::jsonb) r`, [snap.runId, JSON.stringify(payload.expect)]),
      step: (n) => rpc(`SELECT public.rpc_cms_sales_run_seal_step($1, $2) r`, [snap.runId, n]) })
    return { runId: snap.runId, sealed: seal.sealed, code: seal.code, out, expect: payload.expect }
  }
  const publishRpc = (runId) => rpc(`SELECT public.rpc_cms_sales_run_publish($1) r`, [runId])
  const prog = (id) => one(`SELECT status, config_version v, current_result_run_id::text ptr, is_test FROM public.cms_programs WHERE id = $1`, [id])
  const runRow = (id) => one(`SELECT status, error_code, detail, amount_vnd::text amt, published_at FROM public.cms_sync_runs WHERE id = $1`, [id])
  const results = (runId) => all(`SELECT r.user_id::text u, pp.product_id pid, r.cms_quantity::text q, r.amount_vnd::text amt FROM public.cms_results r
    JOIN public.cms_program_products pp ON pp.id = r.program_product_id WHERE r.run_id = $1 ORDER BY 1, 2`, [runId])
  const lockEval = async (id) => (await one(`SELECT public.cms__lock_eval($1, NULL, NULL, NULL, false) r`, [id])).r
  const fnState = async () => (await all(`SELECT p.proname, md5(replace(p.prosrc, E'\\r', '')) src, p.prosecdef, p.provolatile, p.proconfig,
      has_function_privilege('anon', p.oid, 'EXECUTE') a, has_function_privilege('authenticated', p.oid, 'EXECUTE') u, has_function_privilege('service_role', p.oid, 'EXECUTE') s
    FROM pg_proc p WHERE p.oid IN ('public.cms__results_release_open()'::regprocedure, 'public.rpc_cms_sales_run_publish(uuid)'::regprocedure) ORDER BY 1`))
  const fnCount = async () => Number((await one(`SELECT count(*)::int n FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND (proname LIKE 'cms\\_%' OR proname LIKE 'rpc\\_cms\\_%')`)).n)
  async function postInput(phase, aclPre) {
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
    input.p123 = { owners: (await lastQ(q.owners))[0], isolation123: (await lastQ(q.isolation123))[0], triggerFns: await lastQ(q.triggerFns),
      lockPolicy: (await lastQ(q.lockPolicy))[0], payoutAcl: await lastQ(q.payoutAcl), invPayout: (await lastQ(q.invPayout))[0] ?? { n: 0, bad: 0 },
      invLocked: (await lastQ(q.invLocked))[0], invPayoutStaff: (await lastQ(q.invPayoutStaff))[0] ?? { n: 0, bad: 0 },
      invRunFrozen: (await lastQ(q.invRunFrozen))[0] ?? { n: 0, bad: 0 }, payoutReach: await lastQ(q.payoutReach), lockPreview: (await lastQ(q.lockPreview))[0] ?? { n_real: 0, open_n: 0 } }
    input.p124 = { invAttest: (await lastQ(q.invAttest))[0] ?? { n: 0, bad: 0 } }
    input.p125 = { invLastTier: await lastQ(q.inv125LastTier), invCurrentCap: await lastQ(q.inv125CurrentCap), current: (await lastQ(q.inv125Current))[0] }
    if (P_ >= 126) input.p126 = { invRealBasis: (await lastQ(q.inv126RealBasis))[0] }
    return input
  }
  const ENV_ONLY = new Set(['v7-isolation-123', 'isolation'])
  const bad = (cs) => cs.filter((c) => !c.ok && !ENV_ONLY.has(c.id))
  const show = (cs) => bad(cs).map((c) => `${c.id}: ${c.detail}`).slice(0, 5).join(' | ')
  const verify = async (phase, aclPre) => T.evaluateCmsVerify(await postInput(phase, aclPre))
  return { db, label, conn, one, all, lastQ, svc, pre125, pre126, pid, day, preview, commit, makeProgram, rows, sync, stageDirect, publishRpc, prog, runRow,
    results, lockEval, fnState, fnCount, verify, bad, show, SELLER_IDS, timings, syncDeps }
}

const T3 = [{ order: 1, from: 1, to: 9, amount: '15000' }, { order: 2, from: 10, to: 19, amount: '20000' }, { order: 3, from: 20, to: null, amount: '25000' }]

async function main() {
  const E = await env('main')
  console.log(`QA migration 126 — ${E.label}`)
  if (PG15) ok(E.label.startsWith('PostgreSQL 15.'), 'PostgreSQL 15')
  const { db, one } = E

  // ── §1 ──
  section('1. DB 125 (cổng DB đóng) + app mới (SALES_ONLY_V1): lớp DB vẫn chặn chương trình thật')
  const a1 = E.pid(), a2 = E.pid(), a3 = E.pid()
  const R = await E.makeProgram({ name: 'THẬT CMS 126', isTest: false, products: [{ pid: a1, tiers: T3 }, { pid: a2, k: '24', tiers: T3 }, { pid: a3, tiers: T3 }] })
  // AC04: Q 9 / 10 / 19 / 20 (a1, K = 1) · 50 / 100 (a3) · K lẻ 24: base 50 ⇒ Q 2, base 23 ⇒ Q 0 (a2).
  const POS = E.rows(R, [{ pid: a1, s: 0, base: 9 }, { pid: a1, s: 1, base: 4, n: 2 }, { pid: a1, s: 1, base: 2 }, { pid: a1, s: 2, base: 19 }, { pid: a1, s: 3, base: 20 },
    { pid: a2, s: 0, base: 50 }, { pid: a2, s: 1, base: 23 }, { pid: a3, s: 0, base: 50 }, { pid: a3, s: 1, base: 100 }, { pid: a1, s: 0, base: 1, type: 'ONLINE' }])
  const r0 = await E.sync(R, POS)
  ok(r0.status === 'held' && r0.code === 'RESULTS_RELEASE_GATE' && (await E.prog(R.id)).ptr === null && (await E.runRow(r0.runId)).error_code === 'RESULTS_RELEASE_GATE',
    'app mở + DB 125 đóng ⇒ publish held RESULTS_RELEASE_GATE ở DB, pointer null (lớp 2 độc lập)', JSON.stringify([r0.status, r0.code]))
  const le0 = await E.lockEval(R.id)
  ok(le0.blockers.includes('CMS_LOCK_RELEASE_GATE'), 'trước 126: chốt thật có blocker CMS_LOCK_RELEASE_GATE', JSON.stringify(le0.blockers))

  // ── §2 ──
  section('2. Áp 126')
  const before126 = await E.fnState()
  await db.exec(SQL_126); await sleep(20)
  const mk = await one(`SELECT name, notes FROM public.app_migrations WHERE version = '126'`)
  ok(mk?.name === 'cms_sales_only_results_release' && /inventory \{.*"programs_real": 1/.test(mk.notes ?? ''), 'marker 126 + notes inventory (1 chương trình thật)', mk?.notes)
  ok((await one(`SELECT public.cms__results_release_open() o`)).o === true, 'cổng cms__results_release_open() = true')
  ok((await one(`SELECT public.cms__lock_policy() -> 'real' ->> 'ready' r`)).r === 'false', 'policy chốt thật VẪN false (126 không mở chốt / chi trả)')
  const fs126 = await E.fnState()
  const g = fs126.find((x) => x.proname === 'cms__results_release_open'), p = fs126.find((x) => x.proname === 'rpc_cms_sales_run_publish')
  ok(g && !g.a && !g.u && !g.s && g.prosecdef && g.provolatile === 'i' && g.src === GEN.md5s.gate126, 'helper: chỉ owner (anon / authenticated / service_role đều không), SECDEF, IMMUTABLE, md5 126', JSON.stringify(g))
  ok(p && !p.a && !p.u && p.s && p.prosecdef && p.provolatile === 'v' && p.proconfig.includes('lock_timeout=5s') && p.src === GEN.md5s.publish126,
    'publish: chỉ service_role, SECDEF, lock_timeout 5s, md5 126', JSON.stringify(p))
  ok(before126.every((x) => x.src === (x.proname === 'rpc_cms_sales_run_publish' ? GEN.md5s.publish122 : GEN.md5s.gate122)), 'trước 126 hai hàm đúng thân 122')
  ok(await E.fnCount() === 68, 'tổng hàm CMS vẫn 68')
  const again = await execFail(db, SQL_126)
  ok(!again.ok && /đã có marker 126/.test(again.err), 'chạy lại 126 ⇒ preflight dừng (không chạy chồng)', again.err)

  // ── §3 ──
  section('3. Sau 126 — sales-only')
  const r1 = await E.sync(R, POS)
  const run1 = await E.runRow(r1.runId)
  const res1 = await E.results(r1.runId)
  const want = new Map([[`${E.SELLER_IDS[0]}|${a1}`, 9], [`${E.SELLER_IDS[1]}|${a1}`, 10], [`${E.SELLER_IDS[2]}|${a1}`, 19], [`${E.SELLER_IDS[3]}|${a1}`, 20],
    [`${E.SELLER_IDS[0]}|${a2}`, 2], [`${E.SELLER_IDS[1]}|${a2}`, 0], [`${E.SELLER_IDS[0]}|${a3}`, 50], [`${E.SELLER_IDS[1]}|${a3}`, 100]])
  const resOk = res1.length === want.size && res1.every((x) => want.get(`${x.u}|${x.pid}`) === Number(x.q) && x.amt === String(stakeF(x.q)))
  const total = [...want.values()].reduce((s, q) => s + stakeF(q), B(0))
  ok(r1.status === 'published' && (await E.prog(R.id)).ptr === r1.runId, 'AC03 chương trình thật: nguồn → engine → stage → seal → publish, pointer = run', JSON.stringify([r1.status, r1.code]))
  ok(resOk && run1.amt === String(total) && r1.amountVnd === String(total), `AC04 đọc lại: Q 9/10/19/20/50/100 + K 24 lẻ, tiền = oracle độc lập (tổng ${total})`, JSON.stringify(res1))
  ok(run1.detail?.results_basis === 'sales_only_v1' && run1.detail?.results_gate === '126', 'dấu căn cứ do DB đóng: results_basis sales_only_v1 · results_gate 126', JSON.stringify(run1.detail))
  const r2 = await E.sync(R, POS)
  const res2 = await E.results(r2.runId)
  ok(r2.status === 'published' && JSON.stringify(res2) === JSON.stringify(res1) && (await E.runRow(r2.runId)).amt === run1.amt && (await E.prog(R.id)).ptr === r2.runId
    && (await E.runRow(r1.runId)).status === 'ok', 'AC06 replay cùng tập ⇒ snapshot mới cùng tiền / kết quả (tính lại, không cộng dồn); run trước vẫn ok')

  // AC05 app: dòng âm INCLUDED / chưa gán ⇒ held trước stage, pointer giữ.
  const NEG_INC = E.rows(R, [{ pid: a1, s: 0, base: -2, gmv: -20000 }])
  const NEG_UNA = E.rows(R, [{ pid: a1, email: 'khong.co.tai.khoan@example.invalid', base: -1, gmv: -10000 }])
  for (const [neg, label] of [[NEG_INC, 'INCLUDED'], [NEG_UNA, 'chưa gán']]) {
    const rn = await E.sync(R, [...POS, ...neg])
    const staged = Number((await one(`SELECT count(*)::int n FROM public.cms_sales_lines WHERE run_id = $1`, [rn.runId])).n)
    ok(rn.status === 'held' && rn.code === HELD && (await E.runRow(rn.runId)).error_code === HELD && staged === 0 && (await E.prog(R.id)).ptr === r2.runId,
      `AC05 app: dòng âm ${label} ⇒ held ${HELD}, 0 dòng stage, pointer giữ run trước`, JSON.stringify([rn.status, rn.code, staged]))
  }
  // AC05 RPC trực tiếp (bỏ qua app): seal đạt nhưng publish vẫn held.
  for (const [neg, label, adj] of [[NEG_INC, 'INCLUDED', 1], [NEG_UNA, 'chưa gán', 0]]) {
    const s = await E.stageDirect(R, [...POS, ...neg])
    const pub = s.sealed ? await E.publishRpc(s.runId) : null
    ok(s.sealed && s.expect.totals.adjustment_lines === adj && pub?.published === false && pub.code === HELD && (await E.runRow(s.runId)).status === 'held'
      && (await E.prog(R.id)).ptr === r2.runId, `AC05 RPC trực tiếp: dòng âm ${label} (adjustment_lines ${adj}) seal đạt ⇒ publish held ${HELD}, pointer giữ`, JSON.stringify([s.sealed, s.code, pub]))
  }
  // Fail-closed: totals.adjustment_lines hỏng sau seal (owner sửa) ⇒ coi như có điều chỉnh.
  for (const [v, label] of [[`'"0"'::jsonb`, 'chuỗi'], [`'null'::jsonb`, 'null'], [`'-1'::jsonb`, 'âm']]) {
    const s = await E.stageDirect(R, POS)
    await db.query(`UPDATE public.cms_sync_runs SET seal_expect = jsonb_set(seal_expect, '{totals,adjustment_lines}', ${v}) WHERE id = $1`, [s.runId])
    const pub = await E.publishRpc(s.runId)
    ok(s.sealed && pub.published === false && pub.code === HELD && (await E.prog(R.id)).ptr === r2.runId, `fail-closed: totals.adjustment_lines ${label} ⇒ held`, JSON.stringify(pub))
  }
  // Đối chứng: RPC trực tiếp dương ⇒ công bố được.
  const sPos = await E.stageDirect(R, POS)
  const pPos = await E.publishRpc(sPos.runId)
  ok(pPos.published === true && (await E.prog(R.id)).ptr === sPos.runId && (await E.runRow(sPos.runId)).detail.results_basis === 'sales_only_v1', 'đối chứng: RPC trực tiếp tập dương ⇒ công bố + dấu căn cứ')
  const pAgain = await E.publishRpc(sPos.runId)
  ok(pAgain.published === true && pAgain.already === true, 'publish lặp cùng run ⇒ already (idempotent)')

  // QA: fixture điều chỉnh vẫn công bố, không dấu sales-only.
  const q1 = E.pid()
  const Q = await E.makeProgram({ name: 'QA CMS 126', isTest: true, products: [{ pid: q1, tiers: T3 }] })
  const rq = await E.sync(Q, E.rows(Q, [{ pid: q1, s: 0, base: 12 }, { pid: q1, s: 0, base: -2, gmv: -20000 }]), 'qa')
  const rqRun = rq.runId ? await E.runRow(rq.runId) : null
  const adjQ = rq.runId ? Number((await one(`SELECT count(*)::int n FROM public.cms_result_lines WHERE run_id = $1 AND status = 'ADJUSTMENT'`, [rq.runId])).n) : -1
  ok(rq.status === 'published' && adjQ === 1 && rqRun?.detail?.results_basis === undefined, 'QA (is_test): dòng điều chỉnh vẫn công bố trong namespace test, không dấu sales-only', JSON.stringify([rq.status, rq.code, adjQ]))

  // AC08: nguồn qa vào chương trình thật ⇒ 0 run.
  const runsBefore = Number((await one(`SELECT count(*)::int n FROM public.cms_sync_runs WHERE program_id = $1`, [R.id])).n)
  const rqa = await E.sync(R, POS, 'qa')
  ok(rqa.status === 'held' && rqa.code === SS.CMS_QA_SOURCE_REAL_PROGRAM && rqa.runId === null
    && Number((await one(`SELECT count(*)::int n FROM public.cms_sync_runs WHERE program_id = $1`, [R.id])).n) === runsBefore,
    'AC08 nguồn qa vào chương trình thật ⇒ held QA_SOURCE_REAL_PROGRAM, 0 run mới', JSON.stringify([rqa.status, rqa.code]))

  // AC09: chốt thật vẫn bị policy chặn.
  const le1 = await E.lockEval(R.id)
  ok(!le1.blockers.includes('CMS_LOCK_RELEASE_GATE') && le1.blockers.includes('CMS_LOCK_POLICY_PENDING'), 'AC09 sau 126: không còn blocker cổng, VẪN CMS_LOCK_POLICY_PENDING', JSON.stringify(le1.blockers))
  const lk = await settle(E.svc(`SELECT public.rpc_cms_program_lock($1, $2, $3, $4, $5) r`, [R.id, sPos.runId, le1.policy_version ?? 1, U.super, 'QA thử chốt thật']))
  const payouts = Number((await one(`SELECT count(*)::int n FROM public.cms_payouts WHERE program_id = $1`, [R.id])).n)
  ok((await E.prog(R.id)).status === 'active' && payouts === 0 && (!lk.ok || lk.v.rows[0].r?.locked !== true), 'AC09 gọi RPC chốt thật ⇒ không chốt, 0 payout', lk.ok ? JSON.stringify(lk.v.rows[0].r) : lk.err)

  // AC06: cấu hình đổi giữa seal và publish ⇒ CONFIG_CHANGED, pointer giữ.
  const a4 = E.pid()
  const R2 = await E.makeProgram({ name: 'THẬT CMS 126 cấu hình', isTest: false, products: [{ pid: a4, tiers: T3 }] })
  const r2pos = E.rows(R2, [{ pid: a4, s: 0, base: 12 }])
  const r2a = await E.sync(R2, r2pos)
  // Preview lấy TRƯỚC khi mở run (preview bị chặn khi có run đang chạy); commit sau seal ⇒ config_version + 1 giữa seal và publish.
  const prCfg = await E.preview(R2.id, 'append')   // chương trình đã bắt đầu chỉ nhận append
  const sCfg = await E.stageDirect(R2, r2pos)
  let upd = await settle(E.commit(prCfg, 'append', [{ pid: E.pid(), tiers: T3 }]))
  if (!upd.ok) upd = await settle(db.query(`UPDATE public.cms_programs SET config_version = config_version + 1 WHERE id = $1`, [R2.id]))
  const pCfg = upd.ok ? await E.publishRpc(sCfg.runId) : null
  ok(r2a.status === 'published' && upd.ok && pCfg?.published === false && pCfg.code === 'CONFIG_CHANGED' && (await E.prog(R2.id)).ptr === r2a.runId, 'AC06 cấu hình đổi sau seal ⇒ publish held CONFIG_CHANGED, pointer giữ', upd.ok ? JSON.stringify(pCfg) : upd.err)

  // ── §4 VERIFY ──
  section('4. VERIFY phase 126')
  const v126 = await E.verify('126', E.pre126)
  ok(E.bad(v126).length === 0, `VERIFY phase 126 ĐẠT (${v126.length} mục)`, E.show(v126))
  ok(v126.some((c) => /release-gate/.test(c.id) && c.ok), 'có mục kiểm cổng kết quả mở ở phase 126')
  const v125on126 = await E.verify('125', E.pre125)
  ok(E.bad(v125on126).length > 0, 'VERIFY phase 125 trên DB 126 ĐỎ (phase-match / cổng / thân)', E.show(v125on126))
  await db.exec(`GRANT EXECUTE ON FUNCTION public.cms__results_release_open() TO authenticated`)
  const vm1 = await E.verify('126', E.pre126)
  ok(E.bad(vm1).length > 0, 'đột biến: grant helper cho authenticated ⇒ VERIFY 126 đỏ', E.show(vm1))
  await db.exec(`REVOKE ALL ON FUNCTION public.cms__results_release_open() FROM authenticated`)
  await db.exec(GEN.replaced.publish.split("'RETURNS_NOT_SUPPORTED_THIS_PHASE'").join("'RETURNS_X'"))
  const vm2 = await E.verify('126', E.pre126)
  ok(E.bad(vm2).length > 0, 'đột biến: thân publish lạ ⇒ VERIFY 126 đỏ', E.show(vm2))
  await db.exec(GEN.replaced.publish)
  ok(E.bad(await E.verify('126', E.pre126)).length === 0, 'khôi phục thân publish ⇒ VERIFY 126 lại đạt')
  const vb = (await E.verify('126', E.pre126)).find((c) => c.id === 'v126-real-basis')
  ok(vb?.ok === true && vb.proven === true, 'v126-real-basis ĐẠT và đã chứng minh (có run thật công bố sau 126)', JSON.stringify(vb))
  for (const [expr, label] of [[`detail - 'results_gate'`, 'thiếu results_gate'], [`detail || '{"results_basis":"khac"}'::jsonb`, 'results_basis lạ']]) {
    const saved = await one(`SELECT detail FROM public.cms_sync_runs WHERE id = $1`, [sPos.runId])
    await db.query(`UPDATE public.cms_sync_runs SET detail = ${expr} WHERE id = $1`, [sPos.runId])
    const vx = (await E.verify('126', E.pre126)).find((c) => c.id === 'v126-real-basis')
    await db.query(`UPDATE public.cms_sync_runs SET detail = $2::jsonb WHERE id = $1`, [sPos.runId, JSON.stringify(saved.detail)])
    ok(vx?.ok === false, `đột biến run thật công bố ${label} ⇒ v126-real-basis đỏ`, JSON.stringify(vx))
  }

  // ── §5 rollback ──
  section('5. Rollback 126 · preflight thân lạ · áp lại')
  await db.exec(GEN.replaced.publish.split('-- 126: đóng dấu').join('-- 126 (sửa tay): đóng dấu'))
  const rbBad = await execFail(db, RB_126)
  ok(!rbBad.ok && /rollback 126 preflight/.test(rbBad.err), 'rollback dừng khi thân hiện tại khác bản 126 đã sinh', rbBad.err)
  await db.exec(GEN.replaced.publish)
  const ptrBefore = (await E.prog(R.id)).ptr
  await db.exec(RB_126); await sleep(20)
  const fsRb = await E.fnState()
  ok((await one(`SELECT public.cms__results_release_open() o`)).o === false && fsRb.every((x) => x.src === (x.proname === 'rpc_cms_sales_run_publish' ? GEN.md5s.publish122 : GEN.md5s.gate122))
    && !(await one(`SELECT 1 x FROM public.app_migrations WHERE version = '126'`)) && await E.fnCount() === 68,
    'rollback: cổng false, thân 122 nguyên văn, marker xoá, 68 hàm')
  ok((await E.prog(R.id)).ptr === ptrBefore && (await E.runRow(ptrBefore)).status === 'ok', 'rollback GIỮ run / snapshot đã công bố (pointer không đổi)')
  const v125 = await E.verify('125', E.pre125)
  ok(E.bad(v125).length === 0, 'VERIFY phase 125 sau rollback ĐẠT (126 không để phần dư)', E.show(v125))
  const rAfterRb = await E.sync(R, POS)
  ok(rAfterRb.status === 'held' && rAfterRb.code === 'RESULTS_RELEASE_GATE' && (await E.prog(R.id)).ptr === ptrBefore, 'sau rollback app mở vẫn bị DB chặn (held RESULTS_RELEASE_GATE)')
  await db.exec(GEN.originals.gate.split('CREATE FUNCTION').join('CREATE OR REPLACE FUNCTION').split('SELECT false').join('SELECT false -- sửa tay'))
  const preBad = await execFail(db, SQL_126)
  ok(!preBad.ok && /126 preflight/.test(preBad.err), 'áp 126 dừng khi thân 122 nền lạ (md5)', preBad.err)
  await db.exec(GEN.originals.gate.split('CREATE FUNCTION').join('CREATE OR REPLACE FUNCTION'))
  await db.exec(SQL_126); await sleep(20)
  const rRe = await E.sync(R, POS)
  ok(rRe.status === 'published' && E.bad(await E.verify('126', E.pre126)).length === 0, 'áp lại 126 ⇒ công bố lại được + VERIFY 126 đạt')

  if (PG15) await pg15Extra()
}

async function pg15Extra() {
  section('6. PG15: race + plan cache + benchmark ở trần nguồn')
  const E = await env('race')
  // Plan cache (db-reviewer P2): phiên A đã gọi cms__lock_eval (plpgsql cache plan, helper IMMUTABLE) TRƯỚC 126 phải thấy cổng mới
  // SAU 126 / sau rollback mà không cần kết nối lại.
  const z1 = E.pid()
  const PZ = await E.makeProgram({ name: 'THẬT plan cache', isTest: false, products: [{ pid: z1, tiers: T3 }] })
  const cA = await E.conn()
  const evalA = async () => (await cA.query(`SELECT public.cms__lock_eval($1, NULL, NULL, NULL, false) -> 'blockers' b`, [PZ.id])).rows[0].b
  const bz0 = await evalA(); await evalA()
  const c2 = await E.conn()
  await c2.query('BEGIN')
  await c2.query(`UPDATE public.cms_sync_runs SET detail = detail WHERE false`)
  await c2.query(`LOCK TABLE public.cms_sync_runs IN ROW EXCLUSIVE MODE`)
  const t0 = Date.now()
  const blocked = await execFail(E.db, SQL_126)
  const waited = Date.now() - t0
  await c2.query('ROLLBACK')
  ok(!blocked.ok && /lock timeout|canceling statement due to lock timeout/i.test(blocked.err) && waited >= 4500 && waited < 9000,
    `126 × giao dịch đang ghi bảng run ⇒ hết lock_timeout 5s (${waited} ms), rollback sạch`, blocked.err)
  ok(!(await E.one(`SELECT 1 x FROM public.app_migrations WHERE version = '126'`)) && (await E.one(`SELECT public.cms__results_release_open() o`)).o === false, 'không áp nửa chừng')
  await E.db.exec(SQL_126)
  ok((await E.one(`SELECT public.cms__results_release_open() o`)).o === true, 'áp lại sau khi giải phóng khoá ⇒ đạt')
  const bz1 = await evalA()
  await E.db.exec(RB_126)
  const bz2 = await evalA()
  await E.db.exec(SQL_126)
  const bz3 = await evalA()
  ok(bz0.includes('CMS_LOCK_RELEASE_GATE') && !bz1.includes('CMS_LOCK_RELEASE_GATE') && bz1.includes('CMS_LOCK_POLICY_PENDING')
    && bz2.includes('CMS_LOCK_RELEASE_GATE') && !bz3.includes('CMS_LOCK_RELEASE_GATE'),
    'plan cache: cùng phiên đọc đúng cổng trước 126 / sau 126 / sau rollback / áp lại (không cần kết nối lại)', JSON.stringify([bz0, bz1, bz2, bz3]))

  // 2 publish đồng thời cùng run.
  const x1 = E.pid()
  const P = await E.makeProgram({ name: 'THẬT race', isTest: false, products: [{ pid: x1, tiers: T3 }] })
  const s = await E.stageDirect(P, E.rows(P, [{ pid: x1, s: 0, base: 12 }]))
  const ca = await E.conn(), cb = await E.conn()
  const call = (c) => c.query(`SET ROLE service_role; SELECT public.rpc_cms_sales_run_publish('${s.runId}') r`).then((r) => (Array.isArray(r) ? r[1] : r).rows[0].r)
  const [ra, rb] = await Promise.all([call(ca), call(cb)])
  ok([ra, rb].filter((r) => r.published && !r.already).length === 1 && [ra, rb].filter((r) => r.already).length === 1, '2 publish đồng thời cùng run ⇒ đúng 1 công bố, 1 already', JSON.stringify([ra, rb]))

  // Benchmark ở trần nguồn: 19 % chưa gán (không âm) ⇒ guard EXISTS quét hết tập không INCLUDED.
  const b1 = E.pid(), b2 = E.pid()
  const PB = await E.makeProgram({ name: 'THẬT bench', isTest: false, products: [{ pid: b1, tiers: T3 }, { pid: b2, k: '24', tiers: T3 }] })
  const una = Math.floor(BENCH_ROWS * 0.19)
  const specs = [{ pid: b1, s: 0, base: 1, n: Math.floor((BENCH_ROWS - una) / 4) }, { pid: b2, s: 1, base: 3, n: Math.floor((BENCH_ROWS - una) / 4) },
    { pid: b1, s: 2, base: 2, n: Math.floor((BENCH_ROWS - una) / 4) }, { pid: b2, s: 3, base: 5, n: BENCH_ROWS - una - 3 * Math.floor((BENCH_ROWS - una) / 4) },
    { pid: b1, email: 'chua.gan.bench@example.invalid', base: 1, n: una }]
  const rowsB = E.rows(PB, specs)
  await E.db.query(`SET statement_timeout = '8s'`)
  E.timings.length = 0
  const tb = Date.now()
  const rB = await E.sync(PB, rowsB)
  const totalMs = Date.now() - tb
  const mx = (l) => Math.max(0, ...E.timings.filter((t) => t.label === l).map((t) => t.ms))
  const parts = [...new Set(E.timings.filter((t) => t.label === 'stage').map((t) => t.part))]
  for (const part of parts) {
    const xs = E.timings.filter((t) => t.label === 'stage' && t.part === part).sort((a, b) => a.chunkNo - b.chunkNo)
    const ms = xs.map((x) => x.ms).sort((a, b) => a - b)
    const q = (p) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))]
    const firstTen = xs.slice(0, 10).reduce((s, x) => s + x.ms, 0) / Math.max(1, Math.min(10, xs.length))
    const lastTen = xs.slice(-10).reduce((s, x) => s + x.ms, 0) / Math.max(1, Math.min(10, xs.length))
    const slow = xs.filter((x) => x.ms >= 2000).map((x) => `#${x.chunkNo}:${x.ms}`).slice(0, 8).join(' ')
    console.log(`    stage ${part}: ${xs.length} khối · p50 ${q(0.5)} · p95 ${q(0.95)} · max ${ms.at(-1)} ms · TB 10 khối đầu ${Math.round(firstTen)} / 10 khối cuối ${Math.round(lastTen)} ms${slow ? ' · ≥2s ' + slow : ''}`)
  }
  for (const l of ['seal_begin', 'seal_step', 'publish']) console.log(`    ${l}: max ${mx(l)} ms (${E.timings.filter((t) => t.label === l).length} lần)`)
  const pubMs = mx('publish'), sealMs = Math.max(mx('seal_begin'), mx('seal_step')), stageMs = mx('stage')
  console.log(`    bench ${rowsB.length} dòng (${una} chưa gán): tổng ${totalMs} ms · stage max ${stageMs} ms · seal max ${sealMs} ms · publish ${pubMs} ms`)
  ok(rB.status === 'published' && rB.rowsRead === BENCH_ROWS, `benchmark: ${BENCH_ROWS} dòng nguồn công bố được`, JSON.stringify([rB.status, rB.code, rB.rowsRead]))
  ok(pubMs < 8000 && sealMs < 8000 && stageMs < 8000, `mỗi RPC < 8 s (publish ${pubMs} · seal ${sealMs} · stage ${stageMs} ms)`)
  await E.db.query(`SET statement_timeout = 0`)
  // AC11 (db-reviewer P2-2): guard EXISTS dùng partial index excluded theo run_id khi bảng có nhiều run (generic plan như plpgsql).
  for (let i = 0; i < 2; i++) await E.sync(P, E.rows(P, [{ pid: x1, s: 1, base: 5, n: 50 }, { pid: x1, email: 'chua.gan.plan@example.invalid', base: 1, n: 5 }]))
  const runs = Number((await E.one(`SELECT count(DISTINCT run_id)::int n FROM public.cms_sales_lines`)).n)
  await E.db.query(`SET plan_cache_mode = force_generic_plan`)
  await E.db.query(`PREPARE p126(uuid) AS SELECT EXISTS (SELECT 1 FROM public.cms_sales_lines sl WHERE sl.run_id = $1
    AND sl.disposition <> 'INCLUDED' AND (sl.base_quantity < 0 OR sl.gmv_amount < 0))`)
  const plan = (await E.db.query(`EXPLAIN EXECUTE p126('${rB.runId}')`)).rows.map((r) => r['QUERY PLAN']).join(' | ')
  await E.db.query(`DEALLOCATE p126`); await E.db.query(`RESET plan_cache_mode`)
  ok(runs >= 3 && /cms_sales_lines_excluded_idx/.test(plan) && !/Seq Scan/.test(plan), `guard EXISTS: generic plan dùng cms_sales_lines_excluded_idx (${runs} run trong bảng)`, plan)
}

let rc = 0
try {
  if (BENCH_ONLY && PG15) await pg15Extra()
  else await main()
} catch (e) {
  fail++; console.log(`  ✗ LỖI KHÔNG BẮT: ${e?.stack ?? e}`)
} finally {
  for (const c of closers.reverse()) await Promise.resolve().then(c).catch(() => {})
  if (cluster) await cluster.stop().catch(() => {})
}
console.log(`\nQA 126: ${pass} đạt / ${fail} lỗi`)
rc = fail ? 1 : 0
process.exitCode = rc
// async-exit-hook của embedded-postgres tự gọi process.exit() ⇒ mất exitCode; thoát tường minh để rc phản ánh đúng số lỗi.
if (PG15) process.exit(rc)
