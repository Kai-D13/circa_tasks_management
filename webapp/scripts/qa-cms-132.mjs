// QA candidate migration 132 (Q-236 — profile full_line_qty_refund_v1; design Dev r1 18/11) trên chuỗi THẬT 120 → 126 + marker 127 + 130 +
// 131. PGlite (Postgres 16 WASM). KHÔNG chạm DB thật / nguồn thật / mạng. Số kỳ vọng tính TAY trong file (oracle độc lập với net.ts / SQL).
//   §0 generator ↔ file · LF · không DISABLE TRIGGER / CASCADE
//   §1 áp 132: marker; capabilities qua parser THẬT của app (5 đường cũ + full_line); ACL ma trận; chạy lại bị chặn; chương trình không đổi
//   §2 F08 worker cũ (chỉ khai v1) trên chương trình full_line ⇒ held CMS_WORKER_UNSUPPORTED; worker mới ⇒ run cms-calc-ret2-v2 / status-v2
//   §3 F01–F05 tiền qua worker TS + provider fixture (BI 7/10 → trừ 10; 2/4 → 4; B40 hai phiếu 310k → 40 một lần + 620k; cùng đơn cùng SP
//      hai dòng / hai người bán chỉ dòng ref; dòng không đụng giữ nguyên) + cms_unit OTHER_UNIT / FRACTIONAL / COUNTED
//   §4 F02 / F07 replay + bất biến: chạy lại CLEAN cùng số; đổi lượng BI (0 / rỗng / rác) không đổi gì; đổi refund ⇒ CONFLICT; mất phiếu ⇒ CONFLICT
//   §5 F06 / F11 dữ liệu xấu fail-closed (status lạ, CANCELED / PENDING chưa hiệu lực, origin thiếu, ngữ cảnh lệch, refund > GMV, sau as_of,
//      trùng ID)
//   §6 F09 seal SQL độc lập bắt app sai (đột biến payload: trừ hai lần, lượng BI, GMV gốc, chỉ refund đầu, tổng nhóm, totals, lượng BI stage)
//   §7 policy: sales_only → full_line; full_line ↛ net / sales_only; net ↛ full_line; owner UPDATE thẳng bị guard; run net v1 vẫn đúng 130
//   §8 F12 báo cáo sau chốt profile full_line trên run legacy đã chốt; replay; sổ trộn version bị chặn
//   §8d r2 (PM 19/11 §4.2) chương trình THẬT: chứng nhận decision10 / decision_unit14 qua lõi CLI → RPC → eval → preview → chốt → reader /
//      parser / XLSX → báo cáo; chỉ đổi q / u ⇒ bị từ chối; bị chặn (version / cách tính / cấu hình / mapping / phạm vi / hạn / thu hồi /
//      thay thế / quyền); rollback dừng khi có decision_unit14 · ca 1r sales-only thật có SP retire (revision 131) · ca 2v parity byte
//      vân tay TS ↔ SQL vector khó · §12c (PG15) race chứng nhận (m / n: decision_unit14). Đột biến r2 KHÔNG ở đây: chạy qua generator bằng
//      C:/circa-gate-logs/cms-ret-r2-20261119/mut-r2.cjs (sha ghi trong gate-final/SUMMARY.txt)
//   §9 rollback: dừng khi có dữ liệu full_line; gỡ về nền (md5 / capability) rồi áp lại được · §10 CRLF · §11 preflight dừng 0 delta
//   §12 (PG15) hai phiên: đổi policy × mở run (hai chiều) · báo cáo cùng snapshot · báo cáo v1 × full_line trên sổ rỗng
//   §13 (PG15) bench: run full_line 200.000 dòng bán / 20.000 phiếu (2 phiếu / dòng ref) × 2 mode + báo cáo sau chốt ở trần báo cáo (10.000); < 8 s / lời gọi
//   PGlite: cp -r <cây chính>/webapp/node_modules/@electric-sql/pglite node_modules/@electric-sql/ ; node scripts/qa-cms-132.mjs
//   PG15 thật: node scripts/qa-cms-132.mjs --pg15 <embedded-postgres-dir> <data-root>   (CMS132_ONLY=bench ⇒ chỉ §13)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'
import * as L from './lib-care-pglite.mjs'
import { buildCms132, CMS_132_FILE, CMS_132_ROLLBACK_FILE, CMS_132_REPLACED, CMS_132_NEW, CMS_132_ROLLBACK_CONSTRAINTS } from './gen-cms-132.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIG = path.join(HERE, '..', '..', 'supabase', 'migrations')
const SQL = (f) => fs.readFileSync(path.join(MIG, f), 'utf8')
const SQL_132 = fs.readFileSync(CMS_132_FILE, 'utf8')
const RB_132 = fs.readFileSync(CMS_132_ROLLBACK_FILE, 'utf8')
const jiti = createJiti(import.meta.url, { interopDefault: true, alias: { '@': path.join(HERE, '..') } })
const lib = (p) => jiti.import(path.join(HERE, '..', p))
const C = await lib('lib/cms/source/contract.ts')
const SS = await lib('lib/cms/salesSync.ts')
const FX = await lib('e2e/cmsFixtureRunner.ts')
const QR = await lib('e2e/cmsQaResults.ts')
const CF = await lib('e2e/cmsContractFixture.ts')
const CAP = await lib('lib/cms/calc/capabilities.ts')
const RV = await lib('lib/cms/resultView.ts')
const RT = await lib('lib/cms/calc/returns.ts')
const CR = await lib('lib/cms/calc/closeReport.ts')
const LA = await lib('lib/cms/lockAction.ts')
const NET = await lib('lib/cms/calc/net.ts')
const CS = await lib('lib/cms/calc/contractStage.ts')
const SD = await lib('lib/cms/calc/srcDigest.ts')
const RS = await lib('lib/cms/resultStage.ts')
const { U, storeId, STORES, sha } = L
// Ghim nguồn của lượt chạy (db-reviewer r2 vòng 4 P2-2): sha256 BYTE tệp 132 / rollback / harness in ở đầu log.
{
  const { createHash } = await import('node:crypto')
  const h = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex')
  console.log(`ghim lượt: 132 ${h(CMS_132_FILE)} · rollback ${h(CMS_132_ROLLBACK_FILE)} · harness ${h(fileURLToPath(import.meta.url))}`)
}

let pass = 0, fail = 0
const ok = (c, name, extra = '') => { if (c) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) } }
const section = (s) => console.log(`\n${s}`)
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, err: String(e?.message ?? e) }))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** exec một script BEGIN…COMMIT; lỗi ⇒ ROLLBACK để phiên PGlite dùng tiếp (prod: Studio / psql tự huỷ transaction lỗi). */
const execTx = (db, sql) => settle(db.exec(sql)).then(async (r) => { if (!r.ok) { try { await db.exec('ROLLBACK') } catch { /* */ } } return r })
const CRLF = (s) => s.split('\n').join('\r\n')
const code = (r) => (r.ok ? 'OK' : (/\bCMS_[A-Z0-9_]+\b/.exec(r.err)?.[0] ?? r.err.slice(0, 160)))
const T1 = (amount) => [{ order: 1, from: 1, to: null, amount: String(amount) }]
const FULL = 'full_line_qty_refund_v1'
const ON = { modes: true, returns: true }

// ── §0 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
section('0. Generator ↔ file · LF')
const GEN = buildCms132()
ok(GEN.migration === SQL_132 && GEN.rollback === RB_132, 'scripts/gen-cms-132.mjs sinh ĐÚNG byte 132 + rollback trên đĩa')
ok(!SQL_132.includes('\r') && !RB_132.includes('\r'), '132 + rollback giữ LF')
const CODE_132 = SQL_132.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
ok(!/DISABLE TRIGGER|session_replication_role/i.test(CODE_132) && !/\bCASCADE\b/i.test(CODE_132) && !/\bUPDATE public\.cms_programs\b(?![\s\S]*?WHERE)/.test(CODE_132),
  '132 không DISABLE TRIGGER / session_replication_role / CASCADE')
ok(!/\bUPDATE public\.(cms_programs|cms_sync_runs)\s+SET\s+returns_policy/i.test(CODE_132.replace(/CREATE OR REPLACE FUNCTION[\s\S]*?\$\$;/g, '')),
  '132 schema-only: không UPDATE policy chương trình / run ngoài thân hàm')

// ── backend ── (PGlite mặc định; --pg15 ⇒ PostgreSQL 15 nhúng, roles anon / authenticated / service_role như Supabase)
const PG15 = process.argv[2] === '--pg15'
let PGlite = null, cluster = null, pgMod = null
const PG_PORT = 54358, PG_PASS = 'qa-local-only'
if (!PG15) {
  try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { console.error('FAIL: thiếu @electric-sql/pglite'); process.exit(2) }
}
const closers = []
let dbSeq = 0
async function pgConn(name) {
  const c = new pgMod.Client({ host: '127.0.0.1', port: PG_PORT, user: 'postgres', password: PG_PASS, database: name })
  c.on('error', () => {})
  await c.connect()
  closers.push(() => c.end().catch(() => {}))
  return c
}
async function makeDb(tag) {
  if (!PG15) {
    const db = await L.freshDb(PGlite)
    closers.push(() => db.close())
    return { db, dbName: null }
  }
  if (!cluster) {
    const [, , , modDir, dataRoot] = process.argv
    if (!modDir || !dataRoot) { console.error('dùng: --pg15 <embedded-postgres-dir> <data-root>'); process.exit(2) }
    const { createRequire } = await import('node:module')
    const { pathToFileURL } = await import('node:url')
    const req = createRequire(path.join(path.resolve(modDir), 'package.json'))
    const EmbeddedPostgres = (await import(pathToFileURL(req.resolve('embedded-postgres')).href)).default
    pgMod = (await import(pathToFileURL(req.resolve('pg')).href)).default
    cluster = new EmbeddedPostgres({ databaseDir: path.join(path.resolve(dataRoot), `pgdata-cms132-${Date.now()}`), user: 'postgres', password: PG_PASS,
      port: PG_PORT, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {}, onError: () => {} })
    await cluster.initialise(); await cluster.start()
    closers.unshift(() => cluster.stop())
  }
  const name = `rpgcms132_${tag.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_${++dbSeq}`
  const admin = await pgConn('postgres')
  await admin.query(`CREATE DATABASE ${name} ENCODING 'UTF8' TEMPLATE template0`)
  const c = await pgConn(name)
  const wrap = { exec: (sql) => c.query(sql).then((r) => (Array.isArray(r) ? r : [r])), query: (sql, p) => c.query(sql, p), close: () => c.end(), client: c }
  const rolesExist = (await c.query(`SELECT count(*)::int n FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')`)).rows[0].n === 3
  const ROLES = 'CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;'
  function FakePGlite() { return rolesExist ? { ...wrap, exec: (sql) => wrap.exec(sql.split(ROLES).join('')) } : wrap }
  await L.freshDb(FakePGlite)
  return { db: wrap, dbName: name }
}

/** DB nền 131 (120 → 126 thật + marker 127 + 130 + 131 thật). apply ⇒ áp 132. */
async function env(tag, { apply = true, crlf = false, before = null } = {}) {
  const { db, dbName } = await makeDb(tag)
  const one = async (sql, p = []) => (await db.query(sql, p)).rows[0]
  const all = async (sql, p = []) => (await db.query(sql, p)).rows
  const svc = (sql, params = []) => L.as(db, null, () => db.query(sql, params), 'service_role')
  await db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('117','t'),('118','t'),('118a','t'),('119','t'),('119a','t') ON CONFLICT DO NOTHING`)
  for (const f of ['120_cms_foundation.sql', '121_cms_import_activation.sql', '122_cms_results.sql', '123_cms_payouts.sql', '124_cms_source_attestation.sql',
    '125_cms_uncapped_last_tier.sql', '126_cms_sales_only_results_release.sql']) { await db.exec(SQL(f)); await sleep(5) }
  await db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('127', 'cms_t11_flat_amounts')`)
  await db.exec(SQL('130_cms_calculation_modes_returns.sql'))
  await db.exec(SQL('131_cms_program_revision.sql'))
  await db.query(`INSERT INTO public.cms_product_master (product_id, product_name, is_active, source_updated_at)
    SELECT g::text, 'SP giả ' || g, true, now() FROM generate_series(948001, 948400) g`)
  await db.query(`INSERT INTO public.cms_qa_access (user_id, granted_by, expires_at) VALUES ($1, 'qa-script:cms-132', now() + interval '6 hours')`, [U.super])
  let pidNext = 948001, seqf = 0, lineSeq = 0
  const pid = () => String(pidNext++)
  const day = async (n) => { const t = (await one(`SELECT public.cms__vn_today()::text d`)).d; const d = new Date(`${t}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
  const prodPayload = (p) => ({ product_id: p.pid, gmv_basis: p.basis ?? 'none', target_gmv: p.target ?? null, base_quantity_cms: p.k ?? '1', tiers: p.tiers ?? T1(100),
    unit_cms: p.unit ?? 'hộp', advice_text: `Tư vấn QA ${p.pid}`, name_snapshot: `SP giả ${p.pid}`, image_url_snapshot: null, price_snapshot: null })
  async function preview(id) {
    const fileSha = sha(`f132-${tag}-${++seqf}`), digest = sha(`d132-${tag}-${seqf}`)
    const run = (await svc(`SELECT public.rpc_cms_import_preview_save($1::jsonb) id`, [JSON.stringify({ program_id: id, mode: 'replace', file_name: 'qa.xlsx', file_sha256: fileSha,
      file_bytes: 10, actor: U.super, stats: { rowsTotal: 1, rowsOk: 1, rowsRejected: 0, warnings: 0, productsOk: 1, productsRejected: 0 }, result: { digest } })])).rows[0].id
    return { run, fileSha, digest }
  }
  const commit = async (pr, products) => (await svc(`SELECT public.rpc_cms_import_commit($1, $2, $3, $4::jsonb, $5) r`,
    [pr.run, pr.fileSha, pr.digest, JSON.stringify({ mode: 'replace', catalog_target: null, products: products.map(prodPayload) }), U.super])).rows[0].r
  async function makeProgram({ name, isTest = true, products, v2 = null, dates = null, storeCount = 2 }) {
    const payload = { actor: U.super, name, start_date: dates?.[0] ?? await day(-7), end_date: dates?.[1] ?? await day(22), scope: 'stores',
      store_ids: Array.from({ length: storeCount }, (_, i) => storeId(i + 1)), is_test: isTest, ...(v2 ? { quantity_basis: v2 } : {}) }
    const id = (await svc(`SELECT public.${v2 ? 'rpc_cms_program_save_v2' : 'rpc_cms_program_save'}($1::jsonb) id`, [JSON.stringify(payload)])).rows[0].id
    await commit(await preview(id), products)
    await svc(`SELECT public.rpc_cms_program_activate($1, $2)`, [id, U.super])
    const p = await one(`SELECT start_date::text s, end_date::text e FROM public.cms_programs WHERE id = $1`, [id])
    return { id, products, start: p.s, end: p.e, isTest }
  }
  const SEL = [STORES[0].assigneeEmails[0], STORES[0].assigneeEmails[1], STORES[1].assigneeEmails[0], 'nobody.qa@example.invalid']
  const at = (P, min) => new Date(Date.parse(`${P.start}T02:00:00Z`) + min * 60000).toISOString()
  /** Dòng bán thô. o: pid, s (người bán), base, gmv, q, u, order, min. */
  const srow = (P, o) => {
    const id = ++lineSeq
    const ts = at(P, o.min ?? id)
    const r = { order_line_id: String(952000000 + id), order_id: o.order ?? `FO${id}`, order_code: `FQA-${id}`, product_id: o.pid, seller_email: SEL[o.s ?? 0],
      pos_code: 'QAOS01', order_type: 'OFFLINE', order_status: 'COMPLETED', completed_at: ts, quantity_raw: o.q ?? '1', uom_raw: o.u === undefined ? 'Hộp' : o.u,
      base_quantity: String(o.base), gmv_amount: o.gmv ?? '100000', source_updated_at: ts }
    if (!C.normalizeSalesRow(r).ok) throw new Error('dòng giả lỗi')
    return r
  }
  /** Phiếu trả thô (đủ 20 cột như view BI; full_line bỏ qua lượng / ngữ cảnh người). o: id, bi (lượng BI thô), refund, min, status. */
  const rrow = (P, sale, o) => ({ return_event_id: o.id, return_document_id: `RD-${o.id}`, return_code: `RC-${o.id}`, return_status: o.status ?? 'COMPLETED',
    return_recorded_at: at(P, o.min), original_order_line_id: o.line ?? sale.order_line_id, original_order_id: o.order ?? sale.order_id,
    product_id: o.pid ?? sale.product_id, return_base_quantity: o.bi === undefined ? '1' : o.bi, return_gmv_amount: o.refund ?? '10000',
    original_completed_at: o.oc ?? sale.completed_at, original_order_type: sale.order_type, original_order_status: sale.order_status,
    original_seller_email: o.seller === undefined ? sale.seller_email : o.seller, original_pos_code: sale.pos_code,
    original_base_quantity: sale.base_quantity, original_gmv_amount: sale.gmv_amount, original_quantity_raw: sale.quantity_raw,
    original_uom_raw: sale.uom_raw, source_updated_at: at(P, o.min) })
  const lastErr = { v: null }
  const rpc = async (sql, params) => { try { return (await svc(sql, params)).rows[0].r } catch (e) { lastErr.v = String(e.message); const m = /\bCMS_[A-Z0-9_]+\b/.exec(String(e.message)); throw new Error(m ? m[0] : `RPC_FAILED ${String(e.message).slice(0, 160)}`) } }
  const deps = (provider, hooks = {}) => ({
    table: QR.CMS_QA_FAKE_TABLE, runner: FX.createCmsFixtureRunner({ sales: hooks.legacyRows ?? [] }),
    loadSnapshot: (id) => rpc(`SELECT public.rpc_cms_sales_snapshot($1) r`, [id]),
    openRun: (id, detail) => rpc(`SELECT public.rpc_cms_sales_run_open($1, $2::jsonb) r`, [id, JSON.stringify(hooks.openDetail ? hooks.openDetail(detail) : detail)]),
    stage: async (runId, part, chunkNo, x) => Number(await rpc(`SELECT public.rpc_cms_sales_run_stage($1, $2, $3, $4::jsonb) r`,
      [runId, part, chunkNo, JSON.stringify(hooks.stage ? hooks.stage(part, x) : x)])),
    sealBegin: (runId, expect) => rpc(`SELECT public.rpc_cms_sales_run_seal_begin($1, $2::jsonb) r`, [runId, JSON.stringify(hooks.expect ? hooks.expect(expect) : expect)]),
    sealStep: (runId, step) => rpc(`SELECT public.rpc_cms_sales_run_seal_step($1, $2) r`, [runId, step]),
    publish: (runId) => rpc(`SELECT public.rpc_cms_sales_run_publish($1) r`, [runId]),
    finish: async (runId, status, detail) => { await rpc(`SELECT public.rpc_cms_sales_run_finish($1, $2, $3::jsonb) r`, [runId, status, JSON.stringify(detail)]) },
    cleanup: (id, max) => rpc(`SELECT public.rpc_cms_sales_run_cleanup($1, $2) r`, [id, max]),
    now: () => Date.now(),
    contractProvider: provider,
  })
  const run = (P, sales, returns, hooks = {}) => SS.runCmsSalesSync(deps(CF.createCmsContractFixtureProvider({ sales, returns }), hooks), P.id,
    { dryRun: false, source: 'qa', sourceCapture: true, chunkSize: 3, calcFlags: hooks.flags ?? ON })
  const syncLegacy = (P, sales) => SS.runCmsSalesSync(deps(undefined, { legacyRows: sales }), P.id, { dryRun: false, source: P.isTest ? 'qa' : 'cron', sourceCapture: true })
  const setPolicy = (P, policy, o = {}) => settle(svc(`SELECT public.rpc_cms_program_set_returns_policy($1, $2, $3, $4) r`,
    [P.id, policy, o.cv, o.actor ?? U.super]).then((x) => x.rows[0].r))
  const prog = (id) => one(`SELECT status, config_version v, current_result_run_id::text ptr, returns_policy pol FROM public.cms_programs WHERE id = $1`, [id])
  const runRow = (id) => one(`SELECT status, error_code, calc_contract_version cc, status_dictionary_version sdv, returns_policy pol, ledger_verdict lv,
    ledger_eval_seq::int les, amount_vnd::text amt, seal_step, detail -> 'totals' tot, detail ->> 'hold_codes' hc FROM public.cms_sync_runs WHERE id = $1`, [id])
  const progsBefore = await all(`SELECT id::text, config_version, current_result_run_id::text ptr, status, returns_policy FROM public.cms_programs ORDER BY id`)
  if (before) await before({ db, one, all, svc })
  let applied = null
  if (apply) applied = await execTx(db, crlf ? CRLF(SQL_132) : SQL_132)
  return { db, one, all, svc, rpc, pid, day, makeProgram, srow, rrow, at, run, syncLegacy, setPolicy, prog, runRow, deps, applied, progsBefore, SEL, lastErr, dbName }
}

/** Kết quả nhóm của run (dược sĩ theo email người bán). */
async function groups(E, runId) {
  return E.all(`SELECT lower(u.email) email, r.product_id p, r.sale_base::text sb, r.return_base::text rb, r.base_quantity::text nb, r.eligible_base::text eb,
    r.sale_gmv::text sg, r.return_gmv::text rg, r.gmv_amount::text ng, r.cms_quantity::text q, r.amount_vnd::text a, r.return_count n
    FROM public.cms_results r JOIN public.users u ON u.id = r.user_id WHERE r.run_id = $1 ORDER BY u.email, r.product_id`, [runId])
}
const dnum = (s) => (s === null || s === undefined ? s : String(Number(s)))

async function main() {
  if (process.env.CMS132_ONLY === 'lockprobe') {
    section('Chẩn đoán lockedProgram')
    const X = await env('probe')
    const LC = await lockedProgram(X, 'QA probe', [{ p: X.pid(), base: 20 }, { p: X.pid(), s: 1, base: 5 }])
    ok(LC.ok, 'lockedProgram chốt được', JSON.stringify(LC.diag))
    return
  }
  // Lặp nhanh khi phát triển (KHÔNG thay lượt đầy đủ ở gate): chỉ §8b + §8c.
  if (process.env.CMS132_ONLY === 'r1') { await contractLockSection(); await manualSection(); await realAttestSection(); return }
  if (process.env.CMS132_ONLY === 'real') { await realAttestSection(); return }
  if (process.env.CMS132_ONLY === 'rb') { await rollbackSection(); return }
  // r3 (PM 20/11): §8e kiểm nguồn theo run + §8f số dòng đọc theo run (PGlite / PG15).
  if (process.env.CMS132_ONLY === 'r3') { await r3CheckSection(); await r3ScaleSection(); return }
  // r2: lặp nhanh §12 / §12b / §12c (CHỈ PG15 — cần hai phiên thật).
  if (PG15 && process.env.CMS132_ONLY === 'race') { await raceSection(); return }
  // Lặp nhanh bench chốt contract cỡ nhỏ (PGlite / PG15) — KHÔNG thay §13 ở gate.
  if (process.env.CMS132_ONLY === 'benchct') {
    section('13c. Bench chốt contract (CHỈ — lặp nhanh)')
    const X = await env('benchct')
    ok(X.applied.ok, 'DB bench chốt contract: áp 132', X.applied.err)
    await benchContractReport(X, Number(process.env.CMS132_BENCH_SALES ?? 2000), Number(process.env.CMS132_BENCH_RETURNS ?? 200), process.env.CMS132_BENCH_CT_MODE ?? 'cms_unit')
    return
  }
  if (process.env.CMS132_ONLY === 'benchreal') {
    section('13b. Bench chương trình thật (CHỈ — lặp nhanh cỡ nhỏ, KHÔNG thay gate)')
    const X = await env('benchreal')
    ok(X.applied.ok, 'DB bench thật: áp 132', X.applied.err)
    await benchRealAll(X, Number(process.env.CMS132_BENCH_SALES ?? 2000), Number(process.env.CMS132_BENCH_RETURNS ?? 200))
    return
  }
  if (PG15 && process.env.CMS132_ONLY === 'bench') { section('13. Bench PG15 (CHỈ bench)'); await benchSection(); return }
  // ── §1 ──
  section(`1. Áp 132 trên nền 131 (${PG15 ? 'PostgreSQL 15 nhúng' : 'PGlite'})`)
  const E = await env('main')
  const ver = await E.one(`SELECT current_setting('server_version') v, current_setting('server_version_num')::int n`)
  console.log(`  · backend: PostgreSQL ${ver.v}${PG15 ? ' (embedded, 127.0.0.1)' : ' (PGlite WASM)'}`)
  if (PG15) ok(ver.n >= 150000 && ver.n < 160000, `PostgreSQL 15 thật (${ver.v})`)
  ok(E.applied.ok, 'áp 132 thành công', E.applied.err)
  const mk = await E.one(`SELECT name FROM public.app_migrations WHERE version = '132'`)
  ok(mk?.name === 'cms_returns_full_line', 'marker 132 cms_returns_full_line')
  const capRaw = (await E.svc(`SELECT public.rpc_cms_capabilities() c`)).rows[0].c
  const cap = CAP.parseCmsCapabilities(capRaw)
  ok(cap.versionsOk && cap.paths.program_modes && cap.paths.contract_run && cap.paths.readers_v2 && cap.paths.returns_ledger && cap.paths.close_report
    && cap.paths.full_line && cap.paths.lock_contract && cap.paths.manual_report,
  'capabilities qua parser THẬT của app: 5 đường cũ + full_line + lock_contract + manual_report (r1) bật', JSON.stringify(cap.off))
  // App cũ (e74a220) so đúng 6 khoá cũ + danh sách RPC 5 đường cũ — mô phỏng: bỏ đường full_line khỏi danh sách app ⇒ vẫn bật đủ.
  const oldPaths = ['program_modes', 'contract_run', 'readers_v2', 'returns_ledger', 'close_report']
  ok(oldPaths.every((p) => JSON.stringify([...capRaw.paths[p].rpcs].sort()) === JSON.stringify([...CAP.CMS_CAPABILITY_RPCS[p]].sort()))
    && capRaw.calc_contract === 'cms-calc-ret2-v1' && capRaw.status_dictionary === 'cms-return-status-v1' && capRaw.fp === 'cms-return-fp-v1',
  'app cũ: khoá version v1 + danh sách RPC 5 đường cũ KHÔNG đổi (so tuyệt đối vẫn đạt)')
  const capOld = CAP.parseCmsCapabilities({ ...capRaw, calc_contract_v2: 'x' })
  ok(capOld.paths.contract_run && !capOld.paths.full_line && capOld.off.full_line === 'VERSION' && !capOld.paths.lock_contract && !capOld.paths.manual_report,
    'khoá v2 lệch ⇒ chỉ các đường 132 (full_line / lock_contract / manual_report) tắt')
  const acl = await E.all(`SELECT m.sig, has_function_privilege('anon', to_regprocedure('public.' || m.sig), 'EXECUTE') a,
      has_function_privilege('authenticated', to_regprocedure('public.' || m.sig), 'EXECUTE') u, has_function_privilege('service_role', to_regprocedure('public.' || m.sig), 'EXECUTE') s
    FROM (VALUES ${[...CMS_132_NEW, ...CMS_132_REPLACED].map((x) => `('${x.sig}')`).join(', ')}) m(sig)`)
  const want = Object.fromEntries([...CMS_132_NEW, ...CMS_132_REPLACED].map((x) => [x.sig, x.grant ?? '']))
  const aclBad = acl.filter((r) => r.a || r.u !== want[r.sig].includes('authenticated') || r.s !== want[r.sig].includes('service_role'))
  ok(acl.length === CMS_132_NEW.length + CMS_132_REPLACED.length && aclBad.length === 0,
    `ACL ${acl.length} hàm đúng ma trận (anon false mọi dòng; authenticated / service_role theo 130)`, JSON.stringify(aclBad))
  // VERIFY cuối file 132 (db-reviewer 18/11 P1): chạy NGUYÊN VĂN (bỏ tiền tố "--   ") và ra đúng số kỳ vọng ghi ở dòng tiêu đề khối.
  const vblock = (tag) => {
    const ls = SQL_132.slice(SQL_132.indexOf(`\n-- ${tag} `) + 1).split('\n')
    const body = []
    for (const l of ls.slice(1)) { if (!l.startsWith('--   ')) break; body.push(l.slice(5)) }
    return { head: ls[0], sql: body.join('\n') }
  }
  const v2 = vblock('V2'), v2want = Object.fromEntries([...v2.head.matchAll(/(\w+) = (\d+)/g)].map((m) => [m[1], Number(m[2])]))
  const v2got = await settle(E.one(v2.sql))
  ok(v2got.ok && Object.keys(v2want).length === 6 && v2want.n === CMS_132_NEW.length + CMS_132_REPLACED.length
    && Object.entries(v2want).every(([k, v]) => Number(v2got.v[k]) === v), `VERIFY V2 (ACL) chạy nguyên văn: ${v2.head.replace(/^-- V2 [^—]*— /, '')}`,
  JSON.stringify([v2want, v2got.ok ? v2got.v : v2got.err]))
  const v4 = await settle(E.one(vblock('V4').sql))
  ok(v4.ok && ['prog_fl', 'run_v2', 'rl_non_net', 'rp_non_net', 'bl_v2'].every((k) => Number(v4.v[k]) === 0), 'VERIFY V4 (dữ liệu sau migrate) = 0 cả 5', JSON.stringify(v4.ok ? v4.v : v4.err))
  const v5 = await settle(E.all(vblock('V5').sql))
  ok(v5.ok && v5.v.length === 9, 'VERIFY V5 (ràng buộc mới) = 9 dòng', JSON.stringify(v5.ok ? v5.v : v5.err))
  const v6 = await settle(E.one(vblock('V6').sql))
  ok(v6.ok && v6.v.v1_call === false && v6.v.v2_call === true && v6.v.cron_wrap === true,
    'VERIFY V6: lõi báo cáo kiểm trạng thái theo từ điển profile; wrapper cron gọi lõi', JSON.stringify(v6.ok ? v6.v : v6.err))
  const v7 = await settle(E.one(vblock('V7').sql))
  ok(v7.ok && ['payout_ct', 'rp_manual', 'line_ct', 'ev_pre'].every((k) => Number(v7.v[k]) === 0), 'VERIFY V7 (r1, dữ liệu sau migrate) = 0 cả 4', JSON.stringify(v7.ok ? v7.v : v7.err))
  // r2 (PM 19/11 §4.2 ca 6): VERIFY kiểm năng lực chứng nhận cms_unit thật (capability, ràng buộc bộ ba, header vân tay v2, kiểm unit), không tìm chuỗi.
  const v8 = await settle(E.one(vblock('V8').sql))
  ok(v8.ok && v8.v.unit_ok === true && Number(v8.v.c_ver) === 1 && Number(v8.v.c_old) === 0 && v8.v.hdr_ok === true && v8.v.probe === 'RUN_NOT_FOUND'
    && Number(v8.v.att_u14) === 0, 'VERIFY V8 (r2) chạy nguyên văn: unit_attest ok · bộ ba version · 3 CHECK cũ gỡ · header vân tay v2 · kiểm unit RUN_NOT_FOUND · 0 decision_unit14',
  JSON.stringify(v8.ok ? v8.v : v8.err))
  // r2 (db-reviewer r2 P2-5 / P2-6 / N2): V9 md5 thân hàm SAU COMMIT; V9b / V0c chạy được (DB thử chưa có chứng nhận ⇒ 0 dòng). V9b có dữ
  // liệu chạy lại cuối §8d (N5).
  const v9 = vblock('V9'), v9want = Number((/n = (\d+)/.exec(v9.head) ?? [])[1])
  const v9got = await settle(E.one(v9.sql))
  const v9b = await settle(E.all(vblock('V9b').sql)), v0c = await settle(E.all(vblock('V0c').sql))
  ok(v9got.ok && v9want === CMS_132_NEW.length + CMS_132_REPLACED.length && Number(v9got.v.n) === v9want && Number(v9got.v.bad) === 0
    && v9b.ok && v9b.v.length === 0 && v0c.ok && v0c.v.length === 0,
  `VERIFY V9 (r2) chạy nguyên văn: md5 ${v9want} thân hàm sau COMMIT = bản sinh (bad 0) · V9b / V0c chạy được, 0 chứng nhận`,
  JSON.stringify({ v9: v9got.ok ? v9got.v : v9got.err, v9want, v9b: v9b.ok ? v9b.v : v9b.err, v0c: v0c.ok ? v0c.v : v0c.err }))
  const progsAfter = await E.all(`SELECT id::text, config_version, current_result_run_id::text ptr, status, returns_policy FROM public.cms_programs ORDER BY id`)
  ok(JSON.stringify(progsAfter) === JSON.stringify(E.progsBefore), 'chương trình không đổi config_version / pointer / trạng thái / policy')
  const again = await execTx(E.db, SQL_132)
  ok(!again.ok && /đã có marker 132/.test(again.err), 'chạy lại 132 bị preflight chặn', again.err?.slice(0, 120))

  await policySection(E)
  await lockGateSection(E)
  await workerVersionSection(E)
  await moneySection(E)
  await replaySection(E)
  await badDataSection(E)
  await mutationSection(E)
  await reportSection()
  await contractLockSection()
  await manualSection()
  await realAttestSection()
  await r3CheckSection()
  await r3ScaleSection()
  await rollbackSection()
  await crlfSection()
  await preflightSection()
  // r1: CMS132_SKIP_BENCH=1 ⇒ lượt chức năng PG15 (gate 4) không kèm §13 — bench chạy riêng ở gate 6 (--bench).
  if (PG15) { await raceSection(); if (process.env.CMS132_SKIP_BENCH !== '1') await benchSection() }
}

// ── §7 policy ──
async function policySection(E) {
  section('7. Policy: chuyển một chiều, guard owner, net v1 giữ nguyên')
  const p = E.pid()
  const P = await E.makeProgram({ name: 'QA policy FL', products: [{ pid: p, k: '10' }] })
  const v0 = (await E.prog(P.id)).v
  ok(code(await E.setPolicy(P, 'x_v9', { cv: v0 })) === 'CMS_RETURNS_POLICY_INVALID', 'policy lạ ⇒ CMS_RETURNS_POLICY_INVALID')
  ok(code(await E.setPolicy(P, FULL, { cv: v0 - 1 })) === 'CMS_CONFIG_STALE', 'config cũ ⇒ CMS_CONFIG_STALE')
  const s1 = await E.setPolicy(P, FULL, { cv: v0 })
  const g1 = await E.one(`SELECT returns_policy pol, returns_policy_set_by::text by, config_version v FROM public.cms_programs WHERE id = $1`, [P.id])
  ok(s1.ok && s1.v.returns_policy === FULL && g1.pol === FULL && g1.by === U.super && g1.v === v0 + 1, 'sales_only → full_line: actor + config_version +1', JSON.stringify([s1, g1]))
  const s2 = await E.setPolicy(P, FULL, { cv: g1.v })
  ok(s2.ok && s2.v.already === true, 'đặt lại cùng policy ⇒ already')
  ok(code(await E.setPolicy(P, 'net_returns_v1', { cv: g1.v })) === 'CMS_RETURNS_POLICY_REGRESSION', 'full_line → net ⇒ CMS_RETURNS_POLICY_REGRESSION')
  const up = await settle(E.db.query(`UPDATE public.cms_programs SET returns_policy = 'sales_only_v1', returns_policy_set_by = NULL, returns_policy_set_at = NULL,
    config_version = config_version + 1 WHERE id = $1`, [P.id]))
  ok(!up.ok && code(up) === 'CMS_RETURNS_POLICY_REGRESSION', 'owner UPDATE thẳng full_line → sales_only bị guard (ENABLE ALWAYS)', code(up))
  const pn = E.pid()
  const PN = await E.makeProgram({ name: 'QA policy net', products: [{ pid: pn, k: '10' }] })
  await E.setPolicy(PN, 'net_returns_v1', { cv: (await E.prog(PN.id)).v })
  ok(code(await E.setPolicy(PN, FULL, { cv: (await E.prog(PN.id)).v })) === 'CMS_RETURNS_POLICY_REGRESSION', 'net → full_line ⇒ CMS_RETURNS_POLICY_REGRESSION')
  // Run net v1 vẫn theo 130: hợp đồng v1, lượng BI, EXCEEDS_SALE_BASE.
  const s = E.srow(PN, { pid: pn, base: 10, gmv: '100000' })
  const okRun = await E.run(PN, [s], [E.rrow(PN, s, { id: 'NV1', bi: '4', refund: '40000', min: 300 })])
  const rr = okRun.runId ? await E.runRow(okRun.runId) : null
  const g = rr ? await groups(E, okRun.runId) : []
  ok(okRun.status === 'published' && rr.cc === 'cms-calc-ret2-v1' && rr.sdv === 'cms-return-status-v1' && g.length === 1 && dnum(g[0].rb) === '4' && dnum(g[0].nb) === '6',
    'run net_returns_v1 sau 132: hợp đồng v1 / từ điển v1 / lượng trả = lượng BI (4) — không đổi nghĩa', JSON.stringify([okRun.status, okRun.code, rr, g]))
  const ex = await E.run(PN, [s], [E.rrow(PN, s, { id: 'NV1', bi: '4', refund: '40000', min: 300 }), E.rrow(PN, s, { id: 'NV2', bi: '7', refund: '1000', min: 301 })])
  ok(ex.status === 'held' && /RETURN_EXCEEDS_SALE_BASE/.test(ex.code ?? ''), 'net v1: Σ lượng BI 11 > 10 vẫn HOLD EXCEEDS_SALE_BASE', `${ex.status} ${ex.code}`)
}

// ── §7b chốt: pointer cũ / chưa hết kỳ vẫn bị chặn (r1 thay cms__lock_eval — vòng đời chốt run contract ở §8b) ──
async function lockGateSection(E) {
  section('7b. Chốt chương trình full_line: pointer cũ / chưa hết kỳ bị chặn')
  const LD = lockDepsOf(E)
  // (a) run legacy đã công bố rồi chuyển full_line ⇒ pointer còn run sales-only ⇒ POLICY_POINTER_MISMATCH; RPC chốt từ chối.
  const pa = E.pid()
  const PA = await E.makeProgram({ name: 'QA chốt FL pointer cũ', products: [{ pid: pa, k: '1' }], dates: [await E.day(-40), await E.day(-10)] })
  const sy = await E.syncLegacy(PA, [E.srow(PA, { pid: pa, base: 5, min: 60 })])
  await E.setPolicy(PA, FULL, { cv: (await E.prog(PA.id)).v })
  const pva = await LA.runCmsLockPreview(LD, PA.id)
  const ba = pva.ok ? pva.preview.blockers : []
  ok(sy.status === 'published' && ba.includes('CMS_LOCK_POLICY_POINTER_MISMATCH'),
    'legacy đã công bố → chuyển full_line ⇒ xem trước chốt có CMS_LOCK_POLICY_POINTER_MISMATCH', JSON.stringify([sy.status, sy.code ?? null, pva.ok ? ba : pva]))
  const lka = await LA.runCmsLock(LD, { programId: PA.id, expectedRunId: sy.runId, expectedPolicyVersion: pva.ok ? pva.preview.policyVersion : 0, ackReason: 'QA chốt full_line pointer cũ' })
  ok(!lka.ok && (await E.prog(PA.id)).status !== 'locked', 'RPC chốt từ chối, chương trình không locked', JSON.stringify(lka))
  // (b) r1 (Q-237): run contract full_line là pointer ⇒ KHÔNG còn CMS_LOCK_CONTRACT_UNSUPPORTED; chương trình chưa hết kỳ ⇒ NOT_ENDED, RPC chốt từ chối.
  const pb = E.pid()
  const PB = await E.makeProgram({ name: 'QA chốt FL run contract', products: [{ pid: pb, k: '10' }] })
  await E.setPolicy(PB, FULL, { cv: (await E.prog(PB.id)).v })
  const nb = await E.run(PB, [E.srow(PB, { pid: pb, base: 10 })], [])
  const pvb = await LA.runCmsLockPreview(LD, PB.id)
  const bb = pvb.ok ? pvb.preview.blockers : []
  ok(nb.status === 'published' && !bb.includes('CMS_LOCK_CONTRACT_UNSUPPORTED') && bb.includes('CMS_LOCK_NOT_ENDED'),
    'run contract full_line là pointer ⇒ không còn CONTRACT_UNSUPPORTED (r1); chưa hết kỳ ⇒ NOT_ENDED', JSON.stringify([nb.status, nb.code ?? null, pvb.ok ? bb : pvb]))
  const lkb = await LA.runCmsLock(LD, { programId: PB.id, expectedRunId: nb.runId, expectedPolicyVersion: pvb.ok ? pvb.preview.policyVersion : 0, ackReason: 'QA chốt run contract full_line' })
  ok(!lkb.ok && (await E.prog(PB.id)).status !== 'locked', 'RPC chốt từ chối run contract chưa hết kỳ, chương trình không locked', JSON.stringify(lkb))
}

// ── §2 ──
async function workerVersionSection(E) {
  section('2. F08 worker cũ / mới trên chương trình full_line')
  const p = E.pid()
  const P = await E.makeProgram({ name: 'QA worker FL', products: [{ pid: p, k: '10' }] })
  await E.setPolicy(P, FULL, { cv: (await E.prog(P.id)).v })
  const s = E.srow(P, { pid: p, base: 10 })
  const old = await E.run(P, [s], [], { openDetail: (d) => { const { calc_contracts: _c, ...rest } = d; return rest } })
  const or = old.runId ? await E.runRow(old.runId) : null
  ok(old.status === 'held' && or?.status === 'held' && or.error_code === 'CMS_WORKER_UNSUPPORTED' && or.cc === 'cms-calc-ret2-v2' && (await E.prog(P.id)).ptr === null,
    'worker chỉ khai calc_contract v1 ⇒ run (vết) held CMS_WORKER_UNSUPPORTED ngay ở open, pointer giữ', JSON.stringify([old.status, old.code, or]))
  const nw = await E.run(P, [s], [])
  const nr = nw.runId ? await E.runRow(nw.runId) : null
  ok(nw.status === 'published' && nr.cc === 'cms-calc-ret2-v2' && nr.sdv === 'cms-return-status-v2' && nr.pol === FULL && nr.lv === 'CLEAN' && nr.les >= 1,
    'worker mới (calc_contracts [v1, v2]) ⇒ run cms-calc-ret2-v2 / status-v2, ledger CLEAN có eval', JSON.stringify([nw.status, nw.code, nr]))
  const hdr = await settle(L.as(E.db, U.super, () => E.db.query(`SELECT public.rpc_cms_result_header_v2($1) r`, [P.id]), 'authenticated'))
  let parsed = null
  try { parsed = hdr.ok ? RV.parseCmsResultHeader(hdr.v.rows[0].r, 2) : null } catch (e) { parsed = String(e.message) }
  ok(parsed && typeof parsed === 'object' && parsed.run?.contract.returnsPolicy === FULL && parsed.run.contract.calcContractVersion === 'cms-calc-ret2-v2'
    && parsed.run.ledger?.evalSeq >= 1, 'reader v2 qua parser THẬT: run full_line đọc được (không DTO_INVALID), ledger eval_seq có', JSON.stringify(parsed).slice(0, 200))
  let bad = null
  try { RV.parseCmsRunContract({ ...hdr.v.rows[0].r.run.contract, calc_contract_version: 'cms-calc-ret2-v1' }) } catch (e) { bad = e.message }
  ok(bad !== null, 'parser: full_line với hợp đồng v1 (lệch cặp) ⇒ DTO_INVALID', bad ?? '')
}

// ── §3 ──
async function moneySection(E) {
  section('3. F01–F05 tiền (worker TS + seal SQL, số tính tay)')
  const a = E.pid(), b = E.pid()
  const P = await E.makeProgram({ name: 'QA tiền FL', products: [{ pid: a, k: '10' }, { pid: b, k: '1' }] })
  await E.setPolicy(P, FULL, { cv: (await E.prog(P.id)).v })
  // Người 0 / SP a: s1 B10 G120k (BI 7, hoàn 84k) · s2 B4 G20k (BI 2, hoàn 10k) · s3 B40 G640k (hai phiếu 310k, BI 40 + 20) ·
  // s4 B40 G400 đơn X (hoàn 100) · s6 B30 không trả. Người 1 / SP a: s5 B20 G200 CÙNG đơn X (không phiếu). Người 0 / SP b: s7 B5 không trả.
  const s1 = E.srow(P, { pid: a, base: 10, gmv: '120000' })
  const s2 = E.srow(P, { pid: a, base: 4, gmv: '20000' })
  const s3 = E.srow(P, { pid: a, base: 40, gmv: '640000' })
  const s4 = E.srow(P, { pid: a, base: 40, gmv: '400', order: 'FO-X' })
  const s5 = E.srow(P, { pid: a, base: 20, gmv: '200', order: 'FO-X', s: 1 })
  const s6 = E.srow(P, { pid: a, base: 30 })
  const s7 = E.srow(P, { pid: b, base: 5, gmv: '50000' })
  const S = [s1, s2, s3, s4, s5, s6, s7]
  const R = [
    E.rrow(P, s1, { id: 'RT01333633', bi: '7', refund: '84000', min: 300 }),
    E.rrow(P, s2, { id: 'RT01360606', bi: '2', refund: '10000', min: 301 }),
    E.rrow(P, s3, { id: 'RT00991650', bi: '20', refund: '310000', min: 303 }),
    E.rrow(P, s3, { id: 'RT00991636', bi: '40', refund: '310000', min: 302 }),
    E.rrow(P, s4, { id: 'RTX', bi: '5', refund: '100', min: 304 }),
  ]
  const r1 = await E.run(P, S, R)
  const rr = r1.runId ? await E.runRow(r1.runId) : null
  ok(r1.status === 'published' && rr?.status === 'ok' && rr.cc === 'cms-calc-ret2-v2', 'run full_line công bố (seal 13 bước SQL độc lập đồng ý với TS)', JSON.stringify([r1.status, r1.code, rr?.error_code]))
  const g = await groups(E, r1.runId)
  const g0a = g.find((x) => x.email === E.SEL[0] && x.p === a), g1a = g.find((x) => x.email === E.SEL[1] && x.p === a), g0b = g.find((x) => x.email === E.SEL[0] && x.p === b)
  // Oracle tay: người 0 / a bán 10+4+40+40+30 = 124, trừ 10+4+40+40 = 94 ⇒ 30 ⇒ Q3 ⇒ 300đ; GMV 120000+20000+640000+400+100000 = 880400,
  // hoàn 84000+10000+310000+310000+100 = 714100 ⇒ 166300. Người 1 / a: B20 nguyên ⇒ Q2 ⇒ 200đ. Người 0 / b: B5 ⇒ Q5 ⇒ 500đ.
  ok(g0a && dnum(g0a.sb) === '124' && dnum(g0a.rb) === '94' && dnum(g0a.nb) === '30' && dnum(g0a.eb) === '30' && g0a.q === '3' && g0a.a === '300'
    && dnum(g0a.sg) === '880400' && dnum(g0a.rg) === '714100' && dnum(g0a.ng) === '166300' && g0a.n === 5,
  'F01 / F02 / F03 người 0 · SP a: lượng trừ 94 (10 + 4 + 40 MỘT lần + 40), Q3 / 300đ; GMV trừ 714.100 = Σ refund từng phiếu (620.000 cho hai phiếu cùng dòng)',
  JSON.stringify(g0a))
  ok(g1a && dnum(g1a.sb) === '20' && dnum(g1a.rb) === '0' && g1a.q === '2' && g1a.a === '200' && g1a.n === 0,
    'F05 cùng đơn cùng SP, người bán khác (dòng j) KHÔNG bị trừ: B20 / Q2 / 200đ', JSON.stringify(g1a))
  ok(g0b && dnum(g0b.rb) === '0' && g0b.a === '500', 'SP khác của cùng người không bị chạm', JSON.stringify(g0b))
  ok(r1.amountVnd === '1000' && rr.amt === '1000', 'tổng run 300 + 200 + 500 = 1.000đ', `${r1.amountVnd} ${rr.amt}`)
  const ev = await E.all(`SELECT return_event_id id, order_line_id l, base_delta::text bd, eligible_delta::text ed, gmv_delta::text gd FROM public.cms_result_events
    WHERE run_id = $1 AND kind = 'RETURN' ORDER BY return_event_id COLLATE "C"`, [r1.runId])
  const evm = Object.fromEntries(ev.map((e) => [e.id, [dnum(e.bd), dnum(e.ed), dnum(e.gd)]]))
  ok(JSON.stringify(evm.RT00991636) === '["-40","-40","-310000"]' && JSON.stringify(evm.RT00991650) === '["0","0","-310000"]'
    && JSON.stringify(evm.RT01333633) === '["-10","-10","-84000"]' && JSON.stringify(evm.RT01360606) === '["-4","-4","-10000"]',
  'F02 lịch sử: phiếu sớm hơn (RT00991636, 302′) mang −40; phiếu sau (RT00991650) lượng 0, GMV −310.000; BI 7/10 → −10; 2/4 → −4', JSON.stringify(evm))
  const tot = rr.tot
  ok(tot && dnum(tot.return_base_applied) === '94' && dnum(tot.return_gmv_applied) === '714100' && tot.returns_applied === 5,
    'totals: return_base_applied = Σ B_i dòng khác nhau (94), GMV 714.100, 5 phiếu', JSON.stringify(tot))
  const rl = await E.all(`SELECT return_event_id id, returns_policy pol, return_base_quantity rb, original_seller_email se, original_base_quantity ob FROM public.cms_return_lines WHERE run_id = $1`, [r1.runId])
  ok(rl.length === 5 && rl.every((x) => x.pol === FULL && x.rb === null && x.se === null && x.ob === null),
    'phiếu stage full_line KHÔNG lưu lượng BI / email / B gốc (CHECK hình dạng 132)', JSON.stringify(rl[0]))
  const bl = await E.all(`SELECT fp_version v, base_quantity b FROM public.cms_return_baselines WHERE program_id = $1`, [P.id])
  ok(bl.length === 5 && bl.every((x) => x.v === 'cms-return-fp-v2' && x.b === null), 'sổ: 5 baseline fp v2, không lượng', JSON.stringify(bl[0]))

  // F04 cms_unit: COUNTED / OTHER_UNIT / FRACTIONAL.
  const u = E.pid()
  const PU = await E.makeProgram({ name: 'QA tiền FL unit', products: [{ pid: u, k: '10', unit: 'Hộp' }], v2: 'cms_unit' })
  await E.setPolicy(PU, FULL, { cv: (await E.prog(PU.id)).v })
  const c1 = E.srow(PU, { pid: u, q: '3', u: 'Hộp', base: 30, gmv: '300000' })       // COUNTED E30
  const c2 = E.srow(PU, { pid: u, q: '15', u: 'Viên', base: 15, gmv: '150000' })     // OTHER_UNIT E0
  const c3 = E.srow(PU, { pid: u, q: '1.5', u: 'hộp', base: 15, gmv: '150000' })     // FRACTIONAL E0
  const c4 = E.srow(PU, { pid: u, q: '2', u: 'Hộp', base: 20, gmv: '200000' })       // COUNTED E20
  const ru = await E.run(PU, [c1, c2, c3, c4], [E.rrow(PU, c2, { id: 'RU2', bi: '3', refund: '30000', min: 300 }),
    E.rrow(PU, c3, { id: 'RU3', bi: '1', refund: '5000', min: 301 }), E.rrow(PU, c4, { id: 'RU4', bi: '1', refund: '100000', min: 302 })])
  const gu = ru.runId ? (await groups(E, ru.runId))[0] : null
  // E bán = 30 + 20 = 50; trả E: c4 → 20 (OTHER / FRACTIONAL E = 0 không lấy của dòng khác) ⇒ E ròng 30 ⇒ Q3; B thật trừ 15 + 15 + 20 = 50;
  // GMV 800000 − 135000 = 665000.
  ok(ru.status === 'published' && gu && dnum(gu.eb) === '30' && gu.q === '3' && dnum(gu.rb) === '50' && dnum(gu.ng) === '665000',
    'F04 cms_unit: trả OTHER_UNIT / FRACTIONAL không trừ lượng thưởng của dòng COUNTED khác; COUNTED trừ đủ E_i; GMV theo refund',
    JSON.stringify([ru.status, ru.code, gu]))
}

// ── §4 ──
async function replaySection(E) {
  section('4. F02 / F07 replay + bất biến')
  const a = E.pid()
  const P = await E.makeProgram({ name: 'QA replay FL', products: [{ pid: a, k: '10' }] })
  await E.setPolicy(P, FULL, { cv: (await E.prog(P.id)).v })
  const s1 = E.srow(P, { pid: a, base: 40, gmv: '640000' }), s2 = E.srow(P, { pid: a, base: 25 })
  const R = [E.rrow(P, s1, { id: 'RP1', bi: '40', refund: '310000', min: 300 }), E.rrow(P, s1, { id: 'RP2', bi: '20', refund: '310000', min: 301 })]
  const r1 = await E.run(P, [s1, s2], R)
  const r2 = await E.run(P, [s1, s2], R)
  const a1 = r1.runId ? await E.runRow(r1.runId) : null, a2 = r2.runId ? await E.runRow(r2.runId) : null
  const nb = async () => Number((await E.one(`SELECT count(*)::int n FROM public.cms_return_baselines WHERE program_id = $1`, [P.id])).n)
  ok(r1.status === 'published' && r2.status === 'published' && a1.amt === a2.amt && a1.amt === '200' && a2.lv === 'CLEAN' && a2.les === a1.les + 1 && (await nb()) === 2,
    'replay cùng input: cùng tiền (B 65 − 40 = 25 ⇒ Q2 ⇒ 200đ), ledger CLEAN eval +1, không thêm baseline', JSON.stringify([a1, a2]))
  for (const [lbl, bi] of [['lượng BI 0', '0'], ['lượng BI rỗng', null], ['lượng BI rác', 'abc'], ['lượng BI 999', '999']]) {
    const R2 = [{ ...R[0], return_base_quantity: bi }, R[1]]
    const x = await E.run(P, [s1, s2], R2)
    const xr = x.runId ? await E.runRow(x.runId) : null
    ok(x.status === 'published' && xr.amt === '200' && xr.lv === 'CLEAN', `F07 ${lbl}: không lỗi nguồn, fp không đổi ⇒ CLEAN, cùng tiền`, JSON.stringify([x.status, x.code, xr?.lv]))
  }
  // Phiếu sớm hơn đến muộn (late arrival): hiệu lực lượng chuyển sang phiếu sớm hơn, tổng không đổi; fp phiếu đã nhận không đổi.
  const R3 = [...R, E.rrow(P, s1, { id: 'RP0', bi: '1', refund: '1000', min: 299 })]
  const l3 = await E.run(P, [s1, s2], R3)
  const evs = l3.runId ? await E.all(`SELECT return_event_id id, base_delta::text bd FROM public.cms_result_events WHERE run_id = $1 AND kind = 'RETURN' ORDER BY 1`, [l3.runId]) : []
  ok(l3.status === 'published' && JSON.stringify(evs.map((e) => [e.id, dnum(e.bd)])) === '[["RP0","-40"],["RP1","0"],["RP2","0"]]' && (await E.runRow(l3.runId)).amt === '200',
    'late arrival: phiếu sớm hơn RP0 nhận −40, RP1 / RP2 lượng 0; tiền giữ 200đ; ledger CLEAN (fp phiếu cũ không chứa phân bổ)', JSON.stringify([l3.status, l3.code, evs]))
  const pr = (await E.prog(P.id)).ptr
  const rc = await E.run(P, [s1, s2], [{ ...R[0], return_gmv_amount: '300000' }, R[1], R3[2]])
  ok(rc.status === 'held' && rc.code === 'CMS_RETURN_LEDGER_CONFLICT' && (await E.prog(P.id)).ptr === pr, 'F07 đổi refund phiếu đã nhận ⇒ CMS_RETURN_LEDGER_CONFLICT, pointer giữ', `${rc.status} ${rc.code}`)
}

// ── §5 ──
async function badDataSection(E) {
  section('5. F06 / F11 dữ liệu xấu fail-closed')
  // Mỗi ca một chương trình + cặp SP riêng (SP không được trùng giữa hai chương trình active chồng ngày — CMS_IMPORT_PRODUCT_CONFLICT).
  const mkP = async (n) => {
    const a = E.pid(), b = E.pid()
    const P = await E.makeProgram({ name: `QA xấu ${n}`, products: [{ pid: a, k: '10' }, { pid: b, k: '1' }] })
    await E.setPolicy(P, FULL, { cv: (await E.prog(P.id)).v })
    return { P, a, b, s: E.srow(P, { pid: a, base: 10, gmv: '100000', min: 120 }) }
  }
  const cases = [
    ['trạng thái lạ "Completed"', (P, s) => [{ ...E.rrow(P, s, { id: 'B1', min: 300 }), return_status: 'Completed' }], /RETURN_ROW_ISSUES/],
    ['refund thiếu', (P, s) => [{ ...E.rrow(P, s, { id: 'B2', min: 300 }), return_gmv_amount: null }], /RETURN_ROW_ISSUES/],
    ['Σ refund 110.000 > GMV dòng 100.000', (P, s) => [E.rrow(P, s, { id: 'B3', refund: '60000', min: 300 }), E.rrow(P, s, { id: 'B3b', refund: '50000', min: 301 })],
      /RETURN_EXCEEDS_SALE_GMV/],
    ['sai đơn gốc', (P, s) => [E.rrow(P, s, { id: 'B4', order: 'KHAC', min: 300 })], /RETURN_CONTEXT_MISMATCH/],
    ['sai SP gốc', (P, s, b) => [E.rrow(P, s, { id: 'B5', pid: b, min: 300 })], /RETURN_CONTEXT_MISMATCH/],
    ['sai ngày bán gốc', (P, s) => [E.rrow(P, s, { id: 'B5c', oc: E.at(P, 121), min: 300 })], /RETURN_CONTEXT_MISMATCH/],
    ['dòng gốc thuộc catalogue nhưng thiếu trong snapshot bán (F11)', (P, s) => [E.rrow(P, s, { id: 'B6', line: '952999001', min: 300 })], /RETURN_ORIGIN_MISSING/],
    ['trả trước giờ bán', (P, s) => [E.rrow(P, s, { id: 'B7', min: 60 })], /RETURN_BEFORE_SALE/],
    ['trùng ID', (P, s) => [E.rrow(P, s, { id: 'B8', min: 300 }), E.rrow(P, s, { id: 'B8', min: 301 })], /RETURN_DUPLICATE_ID/],
  ]
  for (const [lbl, mkR, re] of cases) {
    const { P, b, s } = await mkP(lbl)
    const x = await E.run(P, [s], mkR(P, s, b))
    const xr = x.runId ? await E.runRow(x.runId) : null
    ok(x.status === 'held' && re.test(`${x.code} ${xr?.hc ?? ''} ${JSON.stringify(x.reasons ?? x.detail ?? [])}`) && (await E.prog(P.id)).ptr === null,
      `F06 ${lbl} ⇒ held, pointer giữ`, `${x.status} ${x.code} ${xr?.hc ?? ''}`)
  }
  // Ngữ cảnh người bán / POS / B / G trên phiếu lệch snapshot: KHÔNG phải lỗi ở full_line (lấy từ snapshot).
  const C3 = await mkP('ctx')
  const ctx = await E.run(C3.P, [C3.s], [{ ...E.rrow(C3.P, C3.s, { id: 'B9', min: 300 }), original_seller_email: null, original_pos_code: 'KHAC',
    original_base_quantity: '999', original_gmv_amount: null }])
  ok(ctx.status === 'published', 'người / POS / B / G gốc trên phiếu sai hoặc NULL không chặn full_line (dùng dòng bán của snapshot)', `${ctx.status} ${ctx.code}`)
  // Từ điển v2: CANCELED / PENDING / REJECTED / WAITING_APPROVAL / APPROVED chưa hiệu lực.
  const C4 = await mkP('v2')
  const s = C4.s, P4 = C4.P
  const ne = ['CANCELED', 'PENDING', 'REJECTED', 'WAITING_APPROVAL', 'APPROVED'].map((st2, i) => ({ ...E.rrow(P4, s, { id: `NE${i}`, min: 300 + i }), return_status: st2 }))
  const nx = await E.run(P4, [s], ne)
  const nr = nx.runId ? await E.runRow(nx.runId) : null
  ok(nx.status === 'published' && nr.tot?.returns_not_effective === 5 && nr.tot?.returns_applied === 0 && nr.amt === '100',
    'từ điển v2: 5 trạng thái chưa hiệu lực ⇒ NOT_COMPLETED, không trừ (Q1 / 100đ)', JSON.stringify([nx.status, nx.code, nr?.tot]))
}

// ── §6 ──
async function mutationSection(E) {
  section('6. F09 seal SQL độc lập bắt payload app sai')
  const mk = async (n) => {
    const a = E.pid()
    const P = await E.makeProgram({ name: `QA đột biến ${n}`, products: [{ pid: a, k: '10' }] })
    await E.setPolicy(P, FULL, { cv: (await E.prog(P.id)).v })
    return { ...P, a }
  }
  const base = async (P) => {
    const s1 = E.srow(P, { pid: P.a, base: 40, gmv: '640000' }), s2 = E.srow(P, { pid: P.a, base: 30 })
    return { S: [s1, s2], R: [E.rrow(P, s1, { id: 'M1', bi: '40', refund: '310000', min: 300 }), E.rrow(P, s1, { id: 'M2', bi: '20', refund: '310000', min: 301 })] }
  }
  const evMut = (fn) => ({ stage: (part, rows) => (part === 'result_events' ? rows.map((r) => (r.kind === 'RETURN' ? fn({ ...r }) : r)) : rows) })
  const muts = [
    ['trừ lượng hai lần (phiếu sau −B)', evMut((r) => (r.return_event_id === 'M2' ? { ...r, base_delta: '-40' } : r)), /SEAL_N3/],
    ['lượng BI thay B_i (−20 đủ điều kiện ở phiếu đầu)', evMut((r) => (r.return_event_id === 'M1'
      ? { ...r, eligible_delta: '-20', eligible_after: String(Number(r.eligible_before) - 20) } : r)), /SEAL_N3|SEAL_RESULT|SEAL_N[0-9]/],
    ['GMV gốc thay refund', evMut((r) => (r.return_event_id === 'M1' ? { ...r, gmv_delta: '-640000' } : r)), /SEAL_N3/],
    ['chỉ refund phiếu đầu', evMut((r) => (r.return_event_id === 'M2' ? { ...r, gmv_delta: '0' } : r)), /SEAL_N3/],
    ['tổng nhóm return_base sai', { stage: (part, rows) => (part === 'results' ? rows.map((r) => ({ ...r, return_base: '60', base_quantity: '10' })) : rows) }, /SEAL_RESULT|SEAL_N[0-9]/],
    ['totals return_base_applied = Σ lượng BI', { expect: (x) => ({ ...x, totals: { ...x.totals, return_base_applied: '60' } }) }, /SEAL_TOTALS/],
    ['stage lượng BI vào phiếu full_line', { stage: (part, rows) => (part === 'return_lines' ? rows.map((r) => (r.return_event_id === 'M1' ? { ...r, return_base_quantity: '40' } : r)) : rows) },
      /STAGE|check constraint|cms_return_lines_shape|STAGE_FAILED/],
  ]
  for (const [lbl, hooks, re] of muts) {
    const P = await mk(lbl)
    const { S, R } = await base(P)
    E.lastErr.v = null
    const x = await E.run(P, S, R, hooks)
    if (/STAGE/.test(String(x.code))) ok(/cms_return_lines_shape/.test(E.lastErr.v ?? ''), `F09 ${lbl}: lỗi gốc là CHECK cms_return_lines_shape (không phải lỗi khác)`, (E.lastErr.v ?? '').slice(0, 160))
    const xr = x.runId ? await E.runRow(x.runId) : null
    ok(x.status !== 'published' && xr?.status !== 'ok' && (await E.prog(P.id)).ptr === null && re.test(`${x.code} ${xr?.error_code}`),
      `F09 ${lbl} ⇒ không công bố (${x.code ?? xr?.error_code})`, JSON.stringify([x.status, x.code, xr?.error_code]))
  }
  // Đối chứng dương: cùng nguồn, không đột biến ⇒ công bố.
  const P0 = await mk('đối chứng')
  const { S, R } = await base(P0)
  const y = await E.run(P0, S, R)
  ok(y.status === 'published' && (await E.runRow(y.runId)).amt === '300', 'đối chứng không đột biến ⇒ công bố (B 70 − 40 = 30 ⇒ 300đ)', `${y.status} ${y.code}`)
}

// ── §8 ──
async function reportSection() {
  section('8. F12 báo cáo sau chốt profile full_line (run legacy đã chốt)')
  const X = await env('report')
  ok(X.applied.ok, 'DB báo cáo: áp 132', X.applied.err)
  const LD = {
    lockEnabled: () => true, qaReadonly: () => false, access: async () => ({ kind: 'ok', actorId: U.super, qa: true }),
    program: async (id) => { const r = await X.one(`SELECT is_test FROM public.cms_programs WHERE id = $1`, [id]); return r ? { isTest: r.is_test } : null },
    rpc: async (fn, args) => {
      const named = Object.keys(args).map((k, i) => `${k} => $${i + 1}`).join(', ')
      try { return { data: (await X.svc(`SELECT public.${fn}(${named}) r`, Object.values(args))).rows[0].r, error: null } } catch (e) { LD.lastErr = `${fn}: ${e.message}`; return { data: null, error: { code: e.code, message: e.message } } }
    },
  }
  const pa = X.pid(), pb = X.pid()
  const P = await X.makeProgram({ name: 'QA báo cáo FL', products: [{ pid: pa, k: '2' }, { pid: pb, k: '1' }], dates: [await X.day(-40), await X.day(-10)] })
  const S = [X.srow(P, { pid: pa, s: 0, base: 24 }), X.srow(P, { pid: pa, s: 1, base: 6 }), X.srow(P, { pid: pb, s: 2, base: 10 }), X.srow(P, { pid: pa, s: 0, base: 2 })]
  const sy = await X.syncLegacy(P, S)
  const pv = await LA.runCmsLockPreview(LD, P.id)
  const lk = pv.ok ? await LA.runCmsLock(LD, { programId: P.id, expectedRunId: sy.runId, expectedPolicyVersion: pv.preview.policyVersion, ackReason: 'QA giả chốt thử báo cáo Q-236' }) : { ok: false }
  ok(sy.status === 'published' && lk.ok && (await X.prog(P.id)).status === 'locked', 'nền: chương trình QA legacy đồng bộ + CHỐT (lockAction thật) — (0,a)=26⇒Q13, (1,a)=6⇒Q3, (2,b)=10⇒Q10',
    JSON.stringify([sy.status, sy.code, pv.ok ? pv.preview.blockers : pv, lk, LD.lastErr ?? null]))
  const end = P.end
  const rat = (min) => new Date(Date.parse(`${end}T05:00:00Z`) + min * 60000).toISOString()
  const rr = (sale, o) => ({ ...X.rrow(P, sale, o), return_recorded_at: rat(o.min), source_updated_at: rat(o.min) })
  const recs = (raws, profile) => raws.map((r) => { const n = RT.normalizeReturnRow(r, profile); if (!n.ok) throw new Error('phiếu giả lỗi ' + JSON.stringify(n.issues)); return n.value })
  let tick = BigInt(Date.now()) * BigInt(1000)
  const PROG = { startDate: P.start, endDate: P.end, productIds: [pa, pb] }
  const pl = (raws, profile, o = {}) => CR.buildCmsCloseReportPayload(PROG, recs(raws, profile), { provider: 'fixture', snapshotId: 'qa-close-fl',
    asOfMicros: o.asOf ?? (tick += BigInt(1000)), actor: o.actor, profile })
  const save = async (payload) => { const r = await settle(X.rpc(`SELECT public.rpc_cms_return_close_report_save($1, $2, $3::jsonb) r`, [P.id, sy.runId, JSON.stringify(payload)])); return r.ok ? r.v : { err: code(r) } }
  const saveSuper = async (payload, reason, req) => {
    const r = await settle(L_AS(X, U.super, `SELECT public.rpc_cms_return_close_report_save_super($1, $2, $3::jsonb, $4, $5) r`, [P.id, sy.runId, JSON.stringify(payload), reason, req]))
    return r.ok ? r.v.rows[0].r : { err: code(r) }
  }
  const RAW = [rr(S[0], { id: 'CR1', bi: '4', refund: '10000', min: 1 }), rr(S[0], { id: 'CR2', bi: '9', refund: '5000', min: 2 })]
  const p1 = pl(RAW, FULL)
  // r1 (PM r0 P1-04 / §3.1): run legacy chưa có báo cáo ⇒ cron không tự chọn profile; super chọn full_line ở lần lập tay đầu (phiên).
  const s0 = await save(p1)
  const s1 = await saveSuper(p1, 'Lập tay ngày 31 — chọn trừ đủ dòng (QA §8)', '00000000-0000-4000-8000-0000000008a1')
  ok(s0.err === 'CMS_REPORT_POLICY_UNSELECTED', 'run legacy chưa có lựa chọn: cron ⇒ CMS_REPORT_POLICY_UNSELECTED (0 ghi)', JSON.stringify(s0))
  const hd = s1.report_id ? await X.one(`SELECT returns_profile pr, calc_contract_version cc, fp_version fv, status_dictionary_version sd, frozen_amount::text f,
    recomputed_amount::text rc, delta_amount::text d, created_via cv FROM public.cms_return_close_reports WHERE id = $1`, [s1.report_id]) : null
  const ln = s1.report_id ? await X.one(`SELECT return_base::text rb, return_events n, return_gmv::text rg, recomputed_qty::text q FROM public.cms_return_close_report_lines l
    JOIN public.users u ON u.id = l.user_id WHERE l.report_id = $1 AND lower(u.email) = $2 AND l.product_id = $3`, [s1.report_id, X.SEL[0], pa]) : null
  const ev = s1.report_id ? await X.all(`SELECT return_event_id id, base, qty_effect::text q, returns_profile pr FROM public.cms_return_close_report_events WHERE report_id = $1 ORDER BY 1`, [s1.report_id]) : []
  // Oracle tay: (0,a) 26 − 24 (một lần, BI 4 + 9 bỏ qua) = 2 ⇒ Q1 ⇒ 100đ; chốt 1300 + 300 + 1000 = 2600 ⇒ tính lại 100 + 300 + 1000 = 1400 ⇒ Δ −1200.
  ok(s1.saved === true && hd?.pr === FULL && hd.cc === 'cms-calc-ret2-v2' && hd.fv === 'cms-return-fp-v2' && hd.sd === 'cms-return-status-v2'
    && hd.f === '2600' && hd.rc === '1400' && hd.d === '-1200' && hd.cv === 'super',
  'báo cáo full_line: chốt 2.600 → tính lại 1.400 (Δ −1.200), profile / version v2, super tay (đường ngày 31)', JSON.stringify([s1, hd]))
  ok(ln && dnum(ln.rb) === '24' && ln.n === 2 && dnum(ln.rg) === '15000' && ln.q === '1', 'dòng báo cáo (0,a): trừ 24 MỘT lần, 2 phiếu, GMV 15.000, Q1', JSON.stringify(ln))
  ok(ev.length === 2 && ev[0].id === 'CR1' && dnum(ev[0].q) === '24' && dnum(ev[1].q) === '0' && ev.every((e) => e.base === null && e.pr === FULL),
    'sự kiện báo cáo: CR1 qty_effect 24, CR2 0, không lưu lượng BI', JSON.stringify(ev))
  const s2 = await save(p1)
  ok(s2.saved === true && s2.already === true && s2.report_id === s1.report_id, 'replay cùng snapshot ⇒ báo cáo cũ (không trừ kép)', JSON.stringify(s2))
  const v1 = await save(CR.buildCmsCloseReportPayload(PROG, recs(RAW, 'net_returns_v1'), { provider: 'fixture', snapshotId: 'qa-close-v1', asOfMicros: (tick += BigInt(1000)) }))
  ok(v1.err === 'CMS_REPORT_PROFILE_LEDGER_MISMATCH', 'báo cáo profile v1 trên sổ đã có fp v2 ⇒ CMS_REPORT_PROFILE_LEDGER_MISMATCH (0 ghi)', JSON.stringify(v1))
  // db-reviewer 18/11 P0: phiếu chưa hiệu lực theo từ điển v2 (dữ liệu thật R0 có CANCELED / PENDING) ⇒ báo cáo full_line LƯU được,
  // các phiếu đó không trừ; v1 gặp CANCELED vẫn CMS_RETURN_STATUS_UNKNOWN (nghĩa 130 giữ nguyên).
  const NE = ['CANCELED', 'PENDING', 'REJECTED', 'WAITING_APPROVAL', 'APPROVED']
  const RAW2 = [...RAW, ...NE.map((st, i) => rr(S[1], { id: `NE${i}`, status: st, bi: '1', refund: '1000', min: 10 + i }))]
  const s3 = await save(pl(RAW2, FULL))
  const ev3 = s3.report_id ? await X.all(`SELECT return_event_id id, disposition d, qty_effect::text q FROM public.cms_return_close_report_events WHERE report_id = $1 ORDER BY 1`, [s3.report_id]) : []
  const ln3 = s3.report_id ? await X.one(`SELECT return_events n, recomputed_qty::text q FROM public.cms_return_close_report_lines l
    JOIN public.users u ON u.id = l.user_id WHERE l.report_id = $1 AND lower(u.email) = $2 AND l.product_id = $3`, [s3.report_id, X.SEL[1], pa]) : null
  const hd3 = s3.report_id ? await X.one(`SELECT recomputed_amount::text rc, created_via cv FROM public.cms_return_close_reports WHERE id = $1`, [s3.report_id]) : null
  // Sự kiện báo cáo chỉ ghi phiếu EFFECTIVE (như 130) ⇒ đúng CR1 / CR2, không NE*.
  ok(s3.saved === true && s3.already !== true && ev3.map((e) => e.id).join(',') === 'CR1,CR2'
    && (!ln3 || ln3.n === 0) && hd3?.rc === '1400' && hd3.cv === 'cron',
  'full_line + 5 trạng thái chưa hiệu lực (CANCELED / PENDING / REJECTED / WAITING_APPROVAL / APPROVED) ⇒ LƯU được, không trừ; tiền tính lại giữ 1.400',
  JSON.stringify([s3, ev3, ln3, hd3]))
  const bad1 = JSON.parse(JSON.stringify(CR.buildCmsCloseReportPayload(PROG, recs(RAW, 'net_returns_v1'), { provider: 'fixture', snapshotId: 'qa-close-v1c', asOfMicros: (tick += BigInt(1000)) })))
  bad1.returns[1].return_status = 'CANCELED'
  const v1c = await save(bad1)
  ok(v1c.err === 'CMS_RETURN_STATUS_UNKNOWN', 'profile v1 gặp CANCELED ⇒ CMS_RETURN_STATUS_UNKNOWN (từ điển v1 như 130)', JSON.stringify(v1c))
  // Chặn trộn profile kể cả khi báo cáo đầu KHÔNG tạo baseline (mọi phiếu chưa hiệu lực): v1 lưu trước ⇒ full_line sau bị chặn, và ngược lại.
  const pm = X.pid(), pn = X.pid()
  const LM = await lockedProgram(X, 'QA báo cáo trộn profile v1 → full_line', [{ p: pm, base: 5 }])
  const LN = await lockedProgram(X, 'QA báo cáo trộn profile full_line → v1', [{ p: pn, base: 5 }])
  const mixSave = async (L, pid, profile, id, st) => {
    const sale = L.S[0]
    const raw = [{ ...X.rrow(L.P, sale, { id, status: st, bi: '1', refund: '1000', min: 1 }), return_recorded_at: new Date(Date.parse(`${L.P.end}T05:00:00Z`) + 60000).toISOString(),
      source_updated_at: new Date(Date.parse(`${L.P.end}T05:00:00Z`) + 60000).toISOString() }]
    const payload = CR.buildCmsCloseReportPayload({ startDate: L.P.start, endDate: L.P.end, productIds: [pid] }, recs(raw, profile),
      { provider: 'fixture', snapshotId: `qa-mix-${id}`, asOfMicros: (tick += BigInt(1000)), profile })
    const first = !(await X.one(`SELECT 1 x FROM public.cms_return_close_reports WHERE program_id = $1 LIMIT 1`, [L.P.id]))
    const r = first
      ? await settle(L_AS(X, U.super, `SELECT public.rpc_cms_return_close_report_save_super($1, $2, $3::jsonb, $4, $5) r`,
        [L.P.id, L.runId, JSON.stringify(payload), 'Lập tay chọn profile báo cáo (QA trộn)', crypto.randomUUID()]).then((x) => x.rows[0].r))
      : await settle(X.rpc(`SELECT public.rpc_cms_return_close_report_save($1, $2, $3::jsonb) r`, [L.P.id, L.runId, JSON.stringify(payload)]))
    return r.ok ? r.v : { err: code(r) }
  }
  const m1 = await mixSave(LM, pm, 'net_returns_v1', 'MX1', 'APPROVED')
  const bl1 = await X.one(`SELECT count(*)::int n FROM public.cms_return_baselines WHERE program_id = $1`, [LM.P.id])
  const m2 = await mixSave(LM, pm, FULL, 'MX2', 'COMPLETED')
  const n1 = await mixSave(LN, pn, FULL, 'NX1', 'CANCELED')
  const n2 = await mixSave(LN, pn, 'net_returns_v1', 'NX2', 'COMPLETED')
  ok(LM.ok && LN.ok && m1.saved === true && bl1.n === 0 && m2.err === 'CMS_REPORT_PROFILE_LEDGER_MISMATCH' && n1.saved === true && n2.err === 'CMS_REPORT_PROFILE_LEDGER_MISMATCH',
    'báo cáo đầu không tạo baseline vẫn ghim profile: v1 → full_line và full_line → v1 đều CMS_REPORT_PROFILE_LEDGER_MISMATCH (0 ghi)',
    JSON.stringify([LM.diag, LN.diag, m1, bl1, m2, n1, n2]))
  const rd = await settle(L.as(X.db, U.super, () => X.db.query(`SELECT public.rpc_cms_return_close_reports($1) r`, [P.id]), 'authenticated'))
  ok(rd.ok && rd.v.rows[0].r.reports[0].returns_profile === FULL, 'reader danh sách báo cáo trả returns_profile', JSON.stringify(rd.ok ? rd.v.rows[0].r.reports[0] : rd.err).slice(0, 200))
}

// ── §9 ──
// ── §8e / §8f r3 (PM 20/11 `planning/reviews/2026-11-20-cms-returns-r2-audit-pm.md` §4.1.1–§4.1.2, §4.2) ───────────────────────────
/** Bộ đọc của bảng + MỌI index của nó trong transaction HIỆN TẠI (pg_stat_get_xact_*: dòng trả từ quét tuần tự / index + dòng heap lấy qua
 *  index). Không phụ thuộc thời gian / máy ⇒ đo được "mỗi bảng run một lượt" thay cho bấm giờ. */
const ROWS_READ_SQL = (t) => `SELECT COALESCE(sum(pg_stat_get_xact_tuples_returned(c.oid) + pg_stat_get_xact_tuples_fetched(c.oid)), 0)::bigint n
  FROM pg_catalog.pg_class c WHERE c.oid = 'public.${t}'::regclass
     OR c.oid IN (SELECT i.indexrelid FROM pg_catalog.pg_index i WHERE i.indrelid = 'public.${t}'::regclass)`
/** Câu dùng $n tuỳ ý trong vals ⇒ [câu đánh số lại $1…$k theo thứ tự dùng, tham số tương ứng]. */
function bindParams(q, vals) {
  const used = [...new Set((q.match(/\$\d+/g) ?? []).map((x) => Number(x.slice(1))))].sort((a, b) => a - b)
  return [q.replace(/\$(\d+)/g, (_, n) => `$${used.indexOf(Number(n)) + 1}`), used.map((n) => vals[n - 1])]
}
async function rowsRead(X, tables) { const o = {}; for (const t of tables) o[t] = Number((await X.one(ROWS_READ_SQL(t))).n); return o }
/**
 * fn trong BEGIN … ROLLBACK (owner, DB THỬ). hide = index ẩn khỏi planner (pg_index.indisvalid = false, hoàn khi ROLLBACK; DISCARD PLANS ⇒
 * kế hoạch đã cache của plpgsql lập lại) — mô phỏng TẤT ĐỊNH lựa chọn index (run_id, seq) mà planner chọn khi thống kê chưa biết run (r3
 * khảo sát); replica = tắt trigger để ghi thẳng dữ liệu đóng băng. Trả { v, read: Δ bộ đọc theo bảng } hoặc { err }.
 */
async function inTx(X, { hide = [], replica = false, stmts = [], tables = [] }, fn) {
  await X.db.exec('BEGIN')
  try {
    if (replica) await X.db.exec('SET LOCAL session_replication_role = replica')
    for (const ix of hide) await X.db.query(`UPDATE pg_catalog.pg_index SET indisvalid = false WHERE indexrelid = 'public.${ix}'::regclass`)
    if (hide.length) await X.db.exec('DISCARD PLANS')
    for (const [sql, p] of stmts) await X.db.query(sql, p)
    const r0 = await rowsRead(X, tables)
    const v = await fn()
    const r1 = await rowsRead(X, tables)
    return { v, read: Object.fromEntries(tables.map((t) => [t, r1[t] - r0[t]])) }
  } catch (e) { return { err: String(e?.message ?? e).slice(0, 200) } } finally { await X.db.exec('ROLLBACK') }
}
/** Thân 124 cms__run_source_check NGUYÊN VĂN, đổi tên ⇒ đối chứng (chỉ DB thử). */
async function createSourceCheck124Ref(X) {
  const s = SQL('124_cms_source_attestation.sql')
  const a = s.indexOf('CREATE FUNCTION public.cms__run_source_check(p_run_id uuid)')
  const z = a < 0 ? -1 : s.indexOf('\n$$;', a)
  if (a < 0 || z < 0 || s.indexOf('CREATE FUNCTION public.cms__run_source_check(', a + 1) >= 0) throw new Error('không thấy thân 124 cms__run_source_check')
  await X.db.exec(s.slice(a, z + 4).replace('CREATE FUNCTION public.cms__run_source_check(', 'CREATE FUNCTION public.qa_r3_source_check_124('))
}

async function r3CheckSection() {
  section('8e. r3 — cms__run_source_check theo RUN (B): ca âm từng mệnh đề SOURCE_*, biên kỳ, NULL, thứ tự ưu tiên; run contract + run legacy decision10 — đối chứng thân 124; cms__ledger_drift ≡ biểu thức r2')
  const X = await env('r3chk')
  ok(X.applied.ok, 'DB r3 kiểm nguồn: áp 132', X.applied.err)
  await createSourceCheck124Ref(X)
  // SP riêng cho từng chương trình (một SP không thuộc hai chương trình trùng kỳ — CMS_IMPORT_PRODUCT_CONFLICT).
  const pc = [X.pid(), X.pid()], pl = [X.pid(), X.pid()]
  const mk = (P, [pa, pb]) => [X.srow(P, { pid: pa, s: 0, base: 10, gmv: '100000', min: 60 }), X.srow(P, { pid: pa, s: 1, base: 6, gmv: '60000', min: 61 }),
    X.srow(P, { pid: pb, s: 2, base: 4, gmv: '40000', min: 62 })]
  // run contract (net_returns_v1, có phiếu trước chốt ⇒ có baseline) + run legacy (decision10 pos_base, sales-only).
  const PC = await X.makeProgram({ name: 'QA r3 kiểm nguồn contract', products: pc.map((pid) => ({ pid, k: '1' })), dates: [await X.day(-40), await X.day(-10)], v2: 'pos_base' })
  const polC = await X.setPolicy(PC, 'net_returns_v1', { cv: (await X.prog(PC.id)).v })
  const SC = mk(PC, pc)
  const syC = await X.run(PC, SC, [X.rrow(PC, SC[0], { id: 'R3C1', bi: '2', refund: '20000', min: 300 }), X.rrow(PC, SC[1], { id: 'R3C2', bi: '1', refund: '10000', min: 301 })])
  const PL = await X.makeProgram({ name: 'QA r3 kiểm nguồn legacy', products: pl.map((pid) => ({ pid, k: '1' })), dates: [await X.day(-40), await X.day(-10)] })
  const SL = mk(PL, pl)
  const syL = await X.syncLegacy(PL, SL)
  const rC = syC.runId ? await X.one(`SELECT calc_contract_version cc, source_schema ss FROM public.cms_sync_runs WHERE id = $1`, [syC.runId]) : null
  const rL = syL.runId ? await X.one(`SELECT calc_contract_version cc, source_schema ss FROM public.cms_sync_runs WHERE id = $1`, [syL.runId]) : null
  ok(polC.ok && syC.status === 'published' && rC?.cc === 'cms-calc-ret2-v1' && rC.ss === 1 && syL.status === 'published' && rL?.cc === null && rL.ss === 1,
    'nền: run contract (net, có phiếu trả) + run legacy decision10 đều công bố, có lớp nguồn (source_schema 1)', JSON.stringify({ polC, syC: [syC.status, syC.code], rC, syL: [syL.status, syL.code], rL }))
  const SRC = 'public.cms_sales_source_lines', ENG = 'public.cms_sales_lines', RUNS = 'public.cms_sync_runs'
  const W1 = 'WHERE run_id = $1 AND order_line_id = $2'
  const win = (end) => `(SELECT (p.${end ? 'end_date + 1' : 'start_date'})::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh' FROM public.cms_programs p
    JOIN public.cms_sync_runs r ON r.program_id = p.id WHERE r.id = $1)`
  const rowsRead1 = `UPDATE ${RUNS} SET seal_expect = jsonb_set(seal_expect, '{rows_read}', to_jsonb((seal_expect ->> 'rows_read')::bigint + 1)) WHERE id = $1`
  const dup = (o) => `INSERT INTO ${SRC} SELECT (jsonb_populate_record(s, jsonb_build_object(${o}))).* FROM ${SRC} s ${W1.replace(/run_id|order_line_id/g, (m) => `s.${m}`)}`
  const FIELD = [['order_type', `'ONLINE'`], ['order_status', `'CANCELLED'`], ['order_id', `order_id || 'x'`], ['order_code', `order_code || 'x'`],
    ['product_id', '$4'], ['seller_email', 'NULL'], ['seller_email', `'x' || seller_email`], ['pos_code', 'NULL'], ['pos_code', `pos_code || 'x'`],
    ['completed_at', `completed_at + interval '1 microsecond'`], ['source_updated_at', `source_updated_at + interval '1 microsecond'`],
    ['quantity_raw', 'NULL'], ['quantity_raw', `quantity_raw || '0'`], ['uom_raw', 'NULL'], ['uom_raw', `uom_raw || 'x'`],
    ['base_quantity', 'base_quantity + 1'], ['gmv_amount', 'gmv_amount + 1']]
  const CASES = [
    ['nền: hai lớp khớp', [], null],
    ['run không có', null, 'RUN_NOT_FOUND'],
    ['run trước 124 (source_schema NULL)', [`UPDATE ${RUNS} SET source_schema = NULL WHERE id = $1`], 'LEGACY_RUN'],
    ['run đã dọn (purged_at)', [`UPDATE ${RUNS} SET purged_at = now() WHERE id = $1`], 'RUN_GONE'],
    ['seal ghi có dòng nguồn bị từ chối', [`UPDATE ${RUNS} SET seal_expect = jsonb_set(seal_expect, '{rows_rejected}', '1') WHERE id = $1`], 'SOURCE_REJECTED'],
    ['mất một dòng nguồn', [`DELETE FROM ${SRC} WHERE run_id = $1 AND order_line_id = $3`], 'SOURCE_COUNT'],
    ['seal kỳ vọng thừa một dòng đọc', [rowsRead1], 'SOURCE_COUNT'],
    ['SP ngoài chương trình', [`UPDATE ${SRC} SET product_id = '987654321987' ${W1}`], 'SOURCE_SCOPE'],
    ['trước đầu kỳ 1 µs', [`UPDATE ${SRC} SET completed_at = ${win(false)} - interval '1 microsecond' ${W1}`], 'SOURCE_SCOPE'],
    ['đúng mốc cuối kỳ (loại trừ)', [`UPDATE ${SRC} SET completed_at = ${win(true)} ${W1}`], 'SOURCE_SCOPE'],
    ['đúng mốc đầu kỳ (thuộc kỳ) ⇒ chỉ lệch lớp bán', [`UPDATE ${SRC} SET completed_at = ${win(false)} ${W1}`], 'SOURCE_ENGINE_MISMATCH'],
    ['dòng bán không còn dòng nguồn cùng ID', [`UPDATE ${SRC} SET order_line_id = order_line_id || '9' ${W1}`], 'SOURCE_ENGINE_MISMATCH'],
    ...FIELD.map(([c, v]) => [`lớp nguồn ${c} := ${v === '$4' ? 'SP khác của chương trình' : v}`, [`UPDATE ${SRC} SET ${c} = ${v} ${W1}`], 'SOURCE_ENGINE_MISMATCH']),
    ['NULL ở CẢ hai lớp (pos_code — IS DISTINCT FROM; lớp bán INCLUDED bắt buộc người bán) ⇒ đạt', [`UPDATE ${SRC} SET pos_code = NULL ${W1}`,
      `UPDATE ${ENG} SET pos_code = NULL ${W1}`], null],
    ['thêm dòng nguồn ĐỦ điều kiện không có ở lớp bán (+ kỳ vọng seal)', [dup(`'order_line_id', s.order_line_id || '7'`), rowsRead1], 'SOURCE_ELIGIBLE_MISMATCH'],
    ['thêm dòng nguồn KHÔNG đủ điều kiện (ONLINE, + kỳ vọng seal) ⇒ đạt', [dup(`'order_line_id', s.order_line_id || '8', 'order_type', 'ONLINE'`), rowsRead1], null],
    ['ưu tiên: từ chối + mất dòng ⇒ SOURCE_REJECTED', [`UPDATE ${RUNS} SET seal_expect = jsonb_set(seal_expect, '{rows_rejected}', '1') WHERE id = $1`,
      `DELETE FROM ${SRC} WHERE run_id = $1 AND order_line_id = $3`], 'SOURCE_REJECTED'],
    ['ưu tiên: mất dòng + SP ngoài chương trình ⇒ SOURCE_COUNT', [`DELETE FROM ${SRC} WHERE run_id = $1 AND order_line_id = $3`,
      `UPDATE ${SRC} SET product_id = '987654321987' ${W1}`], 'SOURCE_COUNT'],
    ['ưu tiên: ngoài kỳ + lệch lớp bán dòng khác ⇒ SOURCE_SCOPE', [`UPDATE ${SRC} SET completed_at = ${win(true)} ${W1}`,
      `UPDATE ${SRC} SET order_id = order_id || 'x' WHERE run_id = $1 AND order_line_id = $3`], 'SOURCE_SCOPE'],
    ['ưu tiên: lệch lớp bán + thiếu dòng đủ điều kiện ⇒ SOURCE_ENGINE_MISMATCH', [`UPDATE ${SRC} SET order_type = 'ONLINE' ${W1}`], 'SOURCE_ENGINE_MISMATCH'],
  ]
  for (const [tag, sy, S, pp] of [['contract', syC, SC, pc], ['legacy', syL, SL, pl]]) {
    if (!sy.runId) { ok(false, `8e [${tag}]: không có run`); continue }
    const bad = []
    for (const [why, stmts, want] of CASES) {
      const rid = stmts === null ? crypto.randomUUID() : sy.runId
      const t = await inTx(X, { replica: true, stmts: (stmts ?? []).map((q) => bindParams(q, [rid, S[0].order_line_id, S[1].order_line_id, pp[1]])) },
        () => X.one(`SELECT public.cms__run_source_check($1) n, public.qa_r3_source_check_124($1) r`, [rid]))
      if (t.err || t.v.n !== want || t.v.r !== want) bad.push({ why, want, got: t.err ?? t.v })
    }
    ok(bad.length === 0, `8e [${tag}]: ${CASES.length} ca — mã 132 = mã thân 124 = kỳ vọng (${CASES.filter((c) => c[2]).length} ca âm, ${CASES.filter((c) => !c[2]).length} ca đạt; mỗi mệnh đề SOURCE_* + biên + NULL + ưu tiên)`,
      JSON.stringify(bad).slice(0, 900))
  }
  // Hồi quy legacy decision10 (PM §4.1.2): run legacy sau r3 vẫn chứng nhận / eval được như 124 — vân tay decision10 không đổi, kiểm nguồn NULL.
  if (syL.runId) {
    const fp = await X.one(`SELECT public.cms__run_source_fp($1, 'decision10') f, public.cms__run_source_check($1) k`, [syL.runId])
    ok(/^[0-9a-f]{64}$/.test(fp?.f ?? '') && fp.k === null, 'hồi quy legacy decision10: kiểm nguồn NULL + vân tay decision10 tính được (chuỗi CLI → eval → chốt: §8d ca 1r [pos])', JSON.stringify(fp))
  }
  // cms__ledger_drift ≡ biểu thức r2 (EXISTS + truy vấn con PK) trên run contract có baseline.
  if (syC.runId) {
    const nb = (await X.one(`SELECT count(*)::int n FROM public.cms_return_baselines WHERE program_id = $1`, [PC.id])).n
    const D = [
      ['nền: baseline ↔ phiếu hiệu lực trong run', [], false],
      ['phiếu của baseline không còn trong run', [`DELETE FROM public.cms_return_lines WHERE run_id = $1 AND return_event_id = 'R3C1'`], true],
      ['một trong hai baseline mất phiếu trong run', [`DELETE FROM public.cms_return_lines WHERE run_id = $1 AND return_event_id = 'R3C2'`], true],
      ['run khác (run legacy, không phiếu)', 'other', true],
    ]
    const bad = []
    for (const [why, stmts, want] of D) {
      const rid = stmts === 'other' ? syL.runId : syC.runId
      const t = await inTx(X, { replica: true, stmts: (Array.isArray(stmts) ? stmts : []).map((q) => bindParams(q, [syC.runId, PC.id])) },
        () => X.one(`SELECT public.cms__ledger_drift($2, $1) n, EXISTS (SELECT 1 FROM public.cms_return_baselines b WHERE b.program_id = $2
          AND (SELECT rl.status_effect FROM public.cms_return_lines rl WHERE rl.run_id = $1 AND rl.return_event_id = b.return_event_id) IS DISTINCT FROM 'EFFECTIVE') o`, [rid, PC.id]))
      if (t.err || t.v.n !== want || t.v.o !== want) bad.push({ why, want, got: t.err ?? t.v })
    }
    ok(nb >= 2 && bad.length === 0, `cms__ledger_drift ≡ biểu thức r2 của lock_eval (${D.length} ca; chương trình có ${nb} baseline)`, JSON.stringify(bad))
  }
}

async function r3ScaleSection() {
  section('8f. r3 — số dòng đọc theo RUN (S2 / B, PM 20/11 §4.1.1 / §4.2): ẩn PK (planner chọn index (run_id, seq) như khi thống kê chưa biết run) ⇒ báo cáo / kiểm lệch sổ vẫn đọc mỗi bảng run MỘT lượt, kết quả không đổi; kiểm nguồn / vân tay theo run khi bảng có lịch sử')
  const X = await env('r3scale')
  ok(X.applied.ok, 'DB r3 số dòng đọc: áp 132', X.applied.err)
  await createSourceCheck124Ref(X)
  if (!PG15) await X.db.exec('SET enable_seqscan = on')   // PGlite 0.2 mặc định tắt seqscan (feedback_pglite_seqscan_off) — đo như PG thường
  const N = Number(process.env.CMS132_R3_SALES ?? 6000), M = Number(process.env.CMS132_R3_RETURNS ?? 1200), K = 8
  // Một LƯỢT qua bảng run = mỗi dòng 1 mục index + 1 dòng heap (hoặc 1 dòng quét tuần tự) ⇒ ngưỡng ${K} lượt = 2 × K × dòng run + 1000.
  const lim = (rows) => 2 * K * rows + 1000
  const NP = 20
  const gen = (P, products, tag) => {
    const t0 = Date.parse(`${P.start}T02:00:00Z`), span = 6 * 24 * 3600 * 1000
    const salesRaw = Array.from({ length: N }, (_, i) => {
      const t = new Date(t0 + Math.floor((i / N) * span)).toISOString()
      const qi = 1 + (i % 50_000), half = i % 13 === 0, base = qi * 10 + (half ? 5 : 0)
      return { order_line_id: String(tag * 10_000_000 + 980000000 + i), order_id: `RO${tag}-${Math.floor(i / 3)}`, order_code: `RQA-${tag}-${Math.floor(i / 3)}`,
        product_id: products[i % NP].pid, seller_email: X.SEL[i % 3], pos_code: `QAOS${String(i % 7).padStart(2, '0')}`, order_type: 'OFFLINE',
        order_status: 'COMPLETED', completed_at: t, quantity_raw: half ? `${qi}.5` : String(qi), uom_raw: BENCH_UNITS[i % BENCH_UNITS.length], base_quantity: String(base),
        gmv_amount: String(base * 1000 + (i % 997)), source_updated_at: t }
    })
    const pre = benchReturns(salesRaw, Math.floor(M / 2), (s, j) => new Date(Date.parse(s.completed_at) + 60_000 * (1 + (j % 2))).toISOString())
    const endMs = Date.parse(`${P.end}T05:00:00Z`)
    const post = benchReturns(salesRaw.slice(1), M - Math.floor(M / 2), (_s, j) => new Date(endMs + j * 1000).toISOString()).map((r) => ({ ...r,
      return_event_id: r.return_event_id.replace(/^BR/, 'BP'),
      ...(r.return_document_id ? { return_document_id: r.return_document_id.replace(/^BRD/, 'BPD'), return_code: r.return_code.replace(/^BRC/, 'BPC') } : {}) }))
    return { salesRaw, pre, post }
  }
  const sync = (P, d) => SS.runCmsSalesSync(X.deps(CF.createCmsContractFixtureProvider({ sales: d.salesRaw, returns: d.pre, snapshotId: `qa-r3-${P.id}` })), P.id,
    { dryRun: false, source: 'qa', sourceCapture: true, chunkSize: 2000, calcFlags: ON })
  const SAVE = `SELECT public.rpc_cms_return_close_report_save($1, $2, $3::jsonb) r`
  const runRows = async (t, runId) => Number((await X.one(`SELECT count(*)::bigint n FROM public.${t} WHERE run_id = $1`, [runId])).n)
  const tabRows = async (t) => Number((await X.one(`SELECT count(*)::bigint n FROM public.${t}`)).n)
  let tag = 0
  for (const mode of ['pos_base', 'cms_unit']) {
    tag++
    const products = Array.from({ length: NP }, () => ({ pid: X.pid(), k: '10', unit: 'Hộp' }))
    const P = await X.makeProgram({ name: `QA r3 số dòng đọc ${mode}`, products, dates: [await X.day(-40), await X.day(-10)], v2: mode })
    const pol = await X.setPolicy(P, FULL, { cv: (await X.prog(P.id)).v })
    const d = gen(P, products, tag)
    const sy = await sync(P, d)
    if (!pol.ok || sy.status !== 'published' || !sy.runId) { ok(false, `8f [${mode}] nền: công bố run`, JSON.stringify({ pol, sy: [sy.status, sy.code] })); continue }
    const nRL = await runRows('cms_return_lines', sy.runId), nSL = await runRows('cms_sales_lines', sy.runId)
    const nB = Number((await X.one(`SELECT count(*)::bigint n FROM public.cms_return_baselines WHERE program_id = $1`, [P.id])).n)
    // (1) kiểm lệch sổ của lock_eval (preview / chốt) — trước chốt, chương trình đã có baseline từ lúc công bố.
    const LE = () => X.one(`SELECT public.cms__lock_eval($1, $2, 1, NULL, false) -> 'blockers' b`, [P.id, sy.runId])
    const leN = await inTx(X, { tables: ['cms_return_lines'] }, LE)
    const leH = await inTx(X, { hide: ['cms_return_lines_pkey'], tables: ['cms_return_lines'] }, LE)
    ok(!leN.err && !leH.err && nB >= 100 && JSON.stringify(leN.v.b) === JSON.stringify(leH.v.b)
      && leN.read.cms_return_lines <= lim(nRL) && leH.read.cms_return_lines <= lim(nRL),
    `8f [${mode}] lock_eval (kiểm lệch sổ ${nB} baseline): dòng đọc cms_return_lines ${leN.err ? '—' : leN.read.cms_return_lines} (tự nhiên) / ${leH.err ? '—' : leH.read.cms_return_lines} (ẩn PK) ≤ ${K} lượt × ${nRL} dòng run; blocker như nhau`,
    JSON.stringify({ leN, leH }).slice(0, 600))
    // (2) báo cáo sau chốt (lõi + cms__close_report_scan) ở trần cỡ probe: tự nhiên vs ẩn PK dòng bán + phiếu run.
    const LD = lockDepsOf(X)
    const pv = await LA.runCmsLockPreview(LD, P.id)
    const lk = pv.ok ? await LA.runCmsLock(LD, { programId: P.id, expectedRunId: sy.runId, expectedPolicyVersion: pv.preview.policyVersion,
      ackReason: 'QA r3 chốt run contract đo số dòng đọc' }) : { ok: false }
    if (!lk.ok) { ok(false, `8f [${mode}] chốt`, JSON.stringify(pv.ok ? lk : pv)); continue }
    const recs = (raws) => raws.map((r) => { const n = RT.normalizeReturnRow(r, FULL); if (!n.ok) throw new Error('phiếu r3 lỗi'); return n.value })
    const PROG = { startDate: P.start, endDate: P.end, productIds: products.map((p) => p.pid) }
    const asOf = BigInt(Date.now()) * BigInt(1000)
    const pl = (raws, snap, k) => JSON.stringify(CR.buildCmsCloseReportPayload(PROG, recs(raws), { provider: 'fixture', snapshotId: snap, asOfMicros: asOf + BigInt(k), profile: FULL }))
    const s0 = await settle(X.rpc(SAVE, [P.id, sy.runId, pl(d.pre, 'qa-r3-s0', 0)]))
    const p1 = pl([...d.pre, ...d.post], 'qa-r3-s1', 1000)
    const T = ['cms_sales_lines', 'cms_return_lines']
    const sv = () => X.rpc(SAVE, [P.id, sy.runId, p1])
    const rN = await inTx(X, { tables: T }, sv)
    const rH = await inTx(X, { hide: ['cms_sales_lines_pkey', 'cms_return_lines_pkey'], tables: T }, sv)
    const pick = (r) => (r?.v ? { saved: r.v.saved, f: r.v.frozen_amount, rc: r.v.recomputed_amount, d: r.v.delta_amount, n: r.v.return_events, l: r.v.line_count, b: r.v.baselines_new } : r)
    ok(s0.ok && s0.v.saved === true && !rN.err && !rH.err && rN.v.saved === true && JSON.stringify(pick(rN)) === JSON.stringify(pick(rH))
      && rN.v.return_events === [...d.pre, ...d.post].filter((r) => r.return_status === 'COMPLETED').length && rN.read.cms_sales_lines <= lim(nSL) && rH.read.cms_sales_lines <= lim(nSL)
      && rN.read.cms_return_lines <= lim(nRL) && rH.read.cms_return_lines <= lim(nRL),
    `8f [${mode}] báo cáo ${M} phiếu / ${nSL} dòng bán: đọc cms_sales_lines ${rN.read?.cms_sales_lines ?? '—'} / ${rH.read?.cms_sales_lines ?? '—'} (ẩn PK) ≤ ${K} lượt × ${nSL}, cms_return_lines ${rN.read?.cms_return_lines ?? '—'} / ${rH.read?.cms_return_lines ?? '—'} ≤ ${K} lượt × ${nRL}; số báo cáo như nhau`,
    JSON.stringify({ s0: s0.ok ? s0.v.saved : s0.err, rN: pick(rN), rH: pick(rH), readN: rN.read, readH: rH.read }).slice(0, 700))
  }
  // (3) B (PM §4.1.2 / §4.2 "chi phí kiểm theo run"): bảng có lịch sử nhiều run, thống kê mới (ANALYZE). Đo cùng run hai lần — trước và
  //     SAU khi thêm 4 run lịch sử của chương trình khác: hàm theo RUN đọc KHÔNG thêm dòng nào (≤ +1000), và ≤ K lượt × dòng run. Thân 124
  //     (EXISTS — r2 đo 0,7–1,0 s ở 1,8–2,0 triệu dòng, tăng theo cỡ bảng) chạy cùng làm đối chứng (in số, không chặn; đột biến M20 đưa
  //     EXISTS trở lại phải bị bắt ở đây).
  const addHistory = async (n, label) => {
    const out = []
    for (let i = 0; i < n; i++) {
      tag++
      const products = Array.from({ length: NP }, () => ({ pid: X.pid(), k: '10', unit: 'Hộp' }))
      const P = await X.makeProgram({ name: `QA r3 lịch sử ${label} ${i}`, products, dates: [await X.day(-40), await X.day(-10)], v2: i % 2 ? 'cms_unit' : 'pos_base' })
      const pol = await X.setPolicy(P, FULL, { cv: (await X.prog(P.id)).v })
      out.push({ P, sy: pol.ok ? await sync(P, gen(P, products, tag)) : { status: 'policy' }, unit: i % 2 === 1 })
    }
    return out
  }
  const H = await addHistory(4, 'A')
  if (H.some((h) => h.sy.status !== 'published')) { ok(false, '8f B: lịch sử 4 run công bố', JSON.stringify(H.map((h) => h.sy.status))); return }
  const U1 = H[3], P1 = H[2]
  const TB = ['cms_sales_source_lines', 'cms_sales_lines']
  const FNS = [['source_check', 'SELECT public.cms__run_source_check($1) v', P1], ['source_check_124', 'SELECT public.qa_r3_source_check_124($1) v', P1],
    ['source_fp', `SELECT public.cms__run_source_fp($1, 'decision10') v`, P1], ['unit_check', 'SELECT public.cms__run_unit_check($1, true) v', U1],
    ['unit_fp', 'SELECT public.cms__run_unit_fp($1) v', U1]]
  const measureAll = async () => {
    await X.db.exec('ANALYZE public.cms_sales_source_lines, public.cms_sales_lines')
    const o = { size: { src: await tabRows('cms_sales_source_lines'), sl: await tabRows('cms_sales_lines') } }
    for (const [k, sql, h] of FNS) {
      const r = await inTx(X, { tables: TB }, () => X.one(sql, [h.sy.runId]))
      o[k] = r.err ? { err: r.err } : { v: typeof r.v.v === 'string' && r.v.v.length === 64 ? 'fp' : r.v.v, src: r.read.cms_sales_source_lines, sl: r.read.cms_sales_lines }
    }
    return o
  }
  const m1 = await measureAll()
  const H2 = await addHistory(4, 'B')
  if (H2.some((h) => h.sy.status !== 'published')) { ok(false, '8f B: thêm 4 run lịch sử công bố', JSON.stringify(H2.map((h) => h.sy.status))); return }
  const m2 = await measureAll()
  const nRun = await runRows('cms_sales_source_lines', P1.sy.runId)
  const fnOk = (k) => !m1[k].err && !m2[k].err && m1[k].v === m2[k].v && m2[k].src <= m1[k].src + 1000 && m2[k].sl <= m1[k].sl + 1000
    && m2[k].src <= lim(nRun) && m2[k].sl <= lim(nRun)
  const show = (k) => `${k} ${m1[k].err || m2[k].err ? 'LỖI' : `${m1[k].src}/${m1[k].sl} → ${m2[k].src}/${m2[k].sl}`}`
  ok(m2.size.src >= m1.size.src + 4 * nRun && m1.source_check.v === null && m1.unit_check.v === null && m1.source_fp.v === 'fp' && m1.unit_fp.v === 'fp'
    && ['source_check', 'source_fp', 'unit_check', 'unit_fp'].every(fnOk),
  `8f B: bảng ${m1.size.src} → ${m2.size.src} dòng nguồn (run ${nRun} dòng): hàm kiểm / vân tay theo RUN đọc KHÔNG thêm khi bảng tăng và ≤ ${K} lượt run — ${['source_check', 'source_fp', 'unit_check', 'unit_fp'].map(show).join(' · ')} (nguồn/bán)`,
  JSON.stringify({ m1, m2, nRun }).slice(0, 900))
  const g = m2.source_check_124.err || m1.source_check_124.err ? null : (m2.source_check_124.src + m2.source_check_124.sl) - (m1.source_check_124.src + m1.source_check_124.sl)
  console.log(`  · đối chứng thân 124 (EXISTS, không chặn): ${show('source_check_124')} — ${g === null ? 'lỗi' : g > 1000 ? `đọc thêm ${g} dòng khi bảng tăng (phụ thuộc cỡ bảng)` : 'không đọc thêm ở cỡ này'}`)
}

async function rollbackSection() {
  section('9. Rollback 132')
  const X = await env('rollback')
  const md5Of = async (sig) => (await X.one(`SELECT md5(replace(prosrc, E'\\r', '')) m FROM pg_catalog.pg_proc WHERE oid = to_regprocedure($1)`, [`public.${sig}`])).m
  const r1 = await execTx(X.db, RB_132)
  const md5ok = (await Promise.all(GEN.replaced.map(async (x) => (await md5Of(x.sig)) === x.base))).every(Boolean)
  const cap = (await X.svc(`SELECT public.rpc_cms_capabilities() c`)).rows[0].c
  const mk = await X.one(`SELECT count(*)::int n FROM public.app_migrations WHERE version = '132'`)
  const cons = await X.all(`SELECT conrelid::regclass::text rel, conname, pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname = ANY ($1)`,
    [Object.keys(CMS_132_ROLLBACK_CONSTRAINTS).map((k) => k.split('.')[1])])
  ok(r1.ok && md5ok && !('full_line' in cap.paths) && mk.n === 0 && cons.length === Object.keys(CMS_132_ROLLBACK_CONSTRAINTS).length,
    'rollback trước dữ liệu full_line: thân 130 khôi phục (md5), capability không còn full_line, ràng buộc 130 dựng lại, marker xoá', r1.err ?? JSON.stringify(cons.length))
  // VERIFY cuối file rollback chạy NGUYÊN VĂN (db-reviewer 18/11 P2-4).
  const rblock = (tag) => {
    const ls = RB_132.slice(RB_132.indexOf(`\n-- ${tag} `) + 1).split('\n')
    const body = []
    for (const l of ls.slice(1)) { if (!l.startsWith('--   ')) break; body.push(l.slice(5)) }
    return { head: ls[0], sql: body.join('\n') }
  }
  const rv1 = await settle(X.all(rblock('R1').sql))
  const r2b = rblock('R2'), r2want = Object.fromEntries([...r2b.head.matchAll(/(\w+) = (\d+)/g)].map((m) => [m[1], Number(m[2])]))
  const r2got = await settle(X.one(r2b.sql))
  ok(rv1.ok && rv1.v.map((r) => r.version).join(',') === '131' && r2got.ok && Object.keys(r2want).length === 7 && r2want.n === GEN.replaced.length
    && Object.entries(r2want).every(([k, v]) => Number(r2got.v[k]) === v),
  `VERIFY rollback R1 / R2 chạy nguyên văn: chỉ marker 131 · ${r2b.head.replace(/^-- R2 [^—]*— /, '')}`, JSON.stringify([rv1.ok ? rv1.v : rv1.err, r2want, r2got.ok ? r2got.v : r2got.err]))
  // Ràng buộc dựng lại ≡ bản 130 thật (so pg_get_constraintdef với DB 131 chưa áp 132).
  const Y = await env('rb-ref', { apply: false })
  const ref = await Y.all(`SELECT conrelid::regclass::text rel, conname, pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname = ANY ($1)`,
    [Object.keys(CMS_132_ROLLBACK_CONSTRAINTS).map((k) => k.split('.')[1])])
  const key = (rows) => JSON.stringify(rows.map((r) => [r.rel, r.conname, r.d]).sort())
  ok(key(cons) === key(ref), 'ràng buộc sau rollback = định nghĩa 130 trên DB nền (pg_get_constraintdef)', key(cons) === key(ref) ? '' : 'lệch')
  const re = await execTx(X.db, SQL_132)
  ok(re.ok, 'áp lại 132 sau rollback được', re.err)
  const a = X.pid()
  const P = await X.makeProgram({ name: 'QA rb data', products: [{ pid: a, k: '10' }] })
  await X.setPolicy(P, FULL, { cv: (await X.prog(P.id)).v })
  const r2 = await execTx(X.db, RB_132)
  ok(!r2.ok && /đã có dữ liệu full_line/.test(r2.err), 'rollback sau khi có chương trình full_line ⇒ DỪNG (sàn = app bridge)', r2.err?.slice(0, 120))
  // Hai chặn mới chạy TRƯỚC chặn dữ liệu (db-reviewer 18/11 P2-4): adhoc 132x ⇒ dừng; thân hàm khác bản 132 (hotfix tay) ⇒ dừng.
  await X.db.query(`INSERT INTO public.app_migrations (version, name, notes) VALUES ('132a', 'qa_adhoc_after_132', 'QA')`)
  const r3 = await execTx(X.db, RB_132)
  await X.db.query(`DELETE FROM public.app_migrations WHERE version = '132a'`)
  ok(!r3.ok && /migration sau 132/.test(r3.err), 'rollback khi có adhoc 132a ⇒ DỪNG (không chỉ nhận số thuần)', r3.err?.slice(0, 140))
  const def = (await X.one(`SELECT pg_get_functiondef('public.cms__ledger_eval_guard()'::regprocedure) d`)).d
  const hot = def.replace(/\nBEGIN\n/, '\nBEGIN\n  -- QA hotfix tay\n')
  await X.db.query(hot)
  const r4 = await execTx(X.db, RB_132)
  ok(hot !== def && !r4.ok && /khác bản 132 \(md5\)/.test(r4.err), 'rollback khi thân hàm bị sửa tay sau 132 ⇒ DỪNG trước khi ghi đè (md5)', r4.err?.slice(0, 140))
  // r1: dữ liệu r1 KHÔNG full_line vẫn là lịch sử tài chính 130 không đọc được ⇒ DỪNG (guard riêng, chạy sau guard full_line).
  //   (i) chốt run contract net_returns_v1 ⇒ cms_payouts.calc_contract_version
  const Y1 = await env('rollback-r1-net')
  const pn = Y1.pid()
  const PN = await Y1.makeProgram({ name: 'QA rb chốt contract net', products: [{ pid: pn, k: '1' }], dates: [await Y1.day(-40), await Y1.day(-10)] })
  await Y1.setPolicy(PN, 'net_returns_v1', { cv: (await Y1.prog(PN.id)).v })
  const nS = [Y1.srow(PN, { pid: pn, base: 10, min: 60 })]
  const ny = await Y1.run(PN, nS, [Y1.rrow(PN, nS[0], { id: 'RBN1', bi: '2', refund: '10000', min: 300 })])
  const LDn = lockDepsOf(Y1)
  const pvn = await LA.runCmsLockPreview(LDn, PN.id)
  const lkn = pvn.ok ? await LA.runCmsLock(LDn, { programId: PN.id, expectedRunId: ny.runId, expectedPolicyVersion: pvn.preview.policyVersion, ackReason: 'QA rollback guard r1 — chốt run contract net' }) : { ok: false }
  const rbN = await execTx(Y1.db, RB_132)
  const fnN = await Y1.one(`SELECT to_regprocedure('public.rpc_cms_return_close_report_save_super(uuid,uuid,jsonb,text,uuid)') IS NOT NULL f`)
  ok(lkn.ok && !rbN.ok && /đã có chốt run contract/.test(rbN.err) && fnN.f === true,
    'rollback sau khi chốt run contract net (không full_line) ⇒ DỪNG (guard r1), 132 còn nguyên', JSON.stringify([ny.status, ny.code ?? null, pvn.ok ? pvn.preview.blockers : pvn, lkn, LDn.lastErr ?? null, rbN.err?.slice(0, 140)]))
  //   (ii) báo cáo phiên super (lý do) trên run legacy chọn net v1 ⇒ cms_return_close_reports.manual_reason
  const Y2 = await env('rollback-r1-manual')
  const pm2 = Y2.pid()
  const LM = await lockedProgram(Y2, 'QA rb báo cáo phiên super', [{ p: pm2, base: 10 }])
  const mRaw = [{ ...Y2.rrow(LM.P, LM.S[0], { id: 'RBM1', bi: '2', min: 0 }), return_recorded_at: new Date(Date.parse(`${LM.P.end}T05:00:00Z`) + 60000).toISOString(), source_updated_at: null }]
  const mRec = mRaw.map((x) => RT.normalizeReturnRow(x, 'net_returns_v1').value)
  const mPl = CR.buildCmsCloseReportPayload({ startDate: LM.P.start, endDate: LM.P.end, productIds: [pm2] }, mRec,
    { provider: 'fixture', snapshotId: 'qa-rb-manual', asOfMicros: BigInt(Date.now()) * BigInt(1000) })
  const ms2 = await settle(L_AS(Y2, U.super, `SELECT public.rpc_cms_return_close_report_save_super($1, $2, $3::jsonb, $4, $5) r`,
    [LM.P.id, LM.runId, JSON.stringify(mPl), 'QA rollback — báo cáo lập tay net v1', crypto.randomUUID()]).then((x) => x.rows[0].r))
  const rbM = await execTx(Y2.db, RB_132)
  ok(LM.ok && ms2.ok && ms2.v.saved === true && !rbM.ok && /đã có chốt run contract \/ báo cáo phiên super/.test(rbM.err),
    'rollback sau báo cáo phiên super (lý do, profile net v1) ⇒ DỪNG (guard r1)', JSON.stringify([ms2.ok ? ms2.v.saved : ms2.err, rbM.err?.slice(0, 140)]))
}

async function crlfSection() {
  section('10. Dán CRLF (Studio)')
  const X = await env('crlf', { crlf: true })
  ok(X.applied.ok, 'áp 132 dạng CRLF thành công (md5 thân bỏ CR)', X.applied.err)
}

async function preflightSection() {
  section('11. Preflight dừng, 0 delta')
  const X = await env('preflight', { apply: false })
  await X.db.exec(`CREATE OR REPLACE FUNCTION public.cms__as_of_floor(p_program_id uuid) RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT NULL::timestamptz $$`)
  const r = await execTx(X.db, SQL_132)
  const mk = await X.one(`SELECT count(*)::int n FROM public.app_migrations WHERE version = '132'`)
  const col = await X.one(`SELECT count(*)::int n FROM pg_attribute WHERE attrelid = 'public.cms_return_lines'::regclass AND attname = 'returns_policy' AND NOT attisdropped`)
  ok(!r.ok && /preflight/.test(r.err) && mk.n === 0 && col.n === 0, 'thân hàm nền lệch md5 ⇒ preflight RAISE, không marker / cột', r.err?.slice(0, 120))
}

// ── §12 (PG15) hai phiên ──────────────────────────────────────────────────────────────────────────────────────────────────────────

// ── §8b (r1 — Q-237 / PM r0 §3.2 + P1-01): chốt RUN CONTRACT → payout RÒNG đóng băng → báo cáo sau chốt đọc hợp đồng đóng băng ──
// Oracle TAY từng ca (không gọi net.ts / SQL): số gộp đóng băng + MỌI phiếu APPLIED của snapshot ⇒ tính lại; so số RÒNG đã chốt.
async function contractLockSection() {
  section('8b. Chốt run contract + báo cáo sau chốt từ hợp đồng đóng băng (Q-237)')
  const X = await env('ctlock')
  ok(X.applied.ok, 'DB chốt contract: áp 132', X.applied.err)
  const LD = lockDepsOf(X)
  let tick = BigInt(Date.now()) * BigInt(1000)
  /** as_of báo cáo = max(đồng hồ, tick + 1 ms): không lùi dưới mốc trả của run công bố sau khi khởi tạo (sàn cms__as_of_floor). */
  const nextAsOf = () => { const now = BigInt(Date.now()) * BigInt(1000); tick = now > tick + BigInt(1000) ? now : tick + BigInt(1000); return tick }
  const recs = (raws, profile) => raws.map((r) => { const n = RT.normalizeReturnRow(r, profile); if (!n.ok) throw new Error('phiếu giả lỗi ' + JSON.stringify(n.issues)); return n.value })
  const after = (P, min) => new Date(Date.parse(`${P.end}T05:00:00Z`) + min * 60000).toISOString()
  /** Phiếu SAU kỳ (recorded sau ngày kết thúc). */
  const late = (P, sale, o) => ({ ...X.rrow(P, sale, o), return_recorded_at: after(P, o.min), source_updated_at: after(P, o.min) })
  /** Chương trình QA đã hết kỳ, policy `policy`, run contract công bố với phiếu TRƯỚC chốt `pre`, rồi CHỐT bằng lockAction thật. */
  async function locked(name, { products, policy = FULL, v2 = null, sales, pre = [] }) {
    const P = await X.makeProgram({ name, products, dates: [await X.day(-40), await X.day(-10)], ...(v2 ? { v2 } : {}) })
    if (policy !== 'sales_only_v1') await X.setPolicy(P, policy, { cv: (await X.prog(P.id)).v })
    const S = sales(P)
    const R = pre.map((f) => f(P, S))
    const sy = await X.run(P, S, R)
    const pv = await LA.runCmsLockPreview(LD, P.id)
    const lk = pv.ok ? await LA.runCmsLock(LD, { programId: P.id, expectedRunId: sy.runId, expectedPolicyVersion: pv.preview.policyVersion,
      ackReason: 'QA chốt run contract Q-237' }) : { ok: false }
    return { P, S, R, runId: sy.runId, ok: sy.status === 'published' && lk.ok && (await X.prog(P.id)).status === 'locked',
      diag: { sy: sy.status, code: sy.code ?? null, pv: pv.ok ? pv.preview.blockers : pv, lk, err: LD.lastErr ?? null } }
  }
  const payload = (L, raws, profile, o = {}) => CR.buildCmsCloseReportPayload({ startDate: L.P.start, endDate: L.P.end, productIds: L.P.products.map((x) => x.pid) },
    recs(raws, profile), { provider: 'fixture', snapshotId: o.snap ?? `qa-ct-${tick}`, asOfMicros: nextAsOf(), ...(profile === FULL ? { profile } : {}) })
  const cron = async (L, pl) => { const r = await settle(X.svc(`SELECT public.rpc_cms_return_close_report_save($1, $2, $3::jsonb) r`, [L.P.id, L.runId, JSON.stringify(pl)])); return r.ok ? r.v.rows[0].r : { err: code(r) } }
  const asSuper = async (L, pl, reason, req) => {
    const r = await settle(L_AS(X, U.super, `SELECT public.rpc_cms_return_close_report_save_super($1, $2, $3::jsonb, $4, $5) r`, [L.P.id, L.runId, JSON.stringify(pl), reason, req]))
    return r.ok ? r.v.rows[0].r : { err: code(r) }
  }
  const head = (id) => X.one(`SELECT frozen_amount::text f, recomputed_amount::text rc, delta_amount::text d, created_via cv, returns_profile pr FROM public.cms_return_close_reports WHERE id = $1`, [id])
  const line = (id, pid) => X.one(`SELECT frozen_base::text fb, return_base::text rb, eligible_base::text eb, frozen_gmv::text fg, return_gmv::text rg,
    net_gmv::text ng, frozen_return_base::text frb, frozen_return_gmv::text frg, return_events n, recomputed_qty::text q, gate_met g, delta::text d
    FROM public.cms_return_close_report_lines WHERE report_id = $1 AND product_id = $2`, [id, pid])
  const evs = (id) => X.all(`SELECT return_event_id id, qty_effect::text q, pre_lock pre FROM public.cms_return_close_report_events WHERE report_id = $1 ORDER BY 1`, [id])
  const T1K = (amount) => T1(amount)

  // ── T1 / T2 / T3: pos_base full_line, K = 2, gate SP 120.000; a(B10, G100k), b(B6, G60k); RT1 → a hoàn 30k TRƯỚC chốt.
  //    Seal: E = 16 − 10 = 6, G = 130k ≥ 120k ⇒ Q3 ⇒ 3.000 (số gộp sẽ là Q8 ⇒ 8.000) — payout = số RÒNG 3.000.
  const pa = X.pid()
  const A = await locked('QA chốt contract FL gate', { products: [{ pid: pa, k: '2', basis: 'product', target: '120000', tiers: T1K(1000) }],
    sales: (P) => [X.srow(P, { pid: pa, base: 10, gmv: '100000', min: 60 }), X.srow(P, { pid: pa, base: 6, gmv: '60000', min: 61 })],
    pre: [(P, S) => X.rrow(P, S[0], { id: 'CT1', refund: '30000', min: 300 })] })
  const payA = await X.one(`SELECT amount_vnd::text a, calc_contract_version cc, quantity_basis qb, returns_policy rp, returns_as_of IS NOT NULL ao,
    returns_digest IS NOT NULL rd, ledger_eval_seq IS NOT NULL ls FROM public.cms_payouts WHERE program_id = $1`, [A.P.id])
  ok(A.ok && payA?.a === '3000' && payA.cc === 'cms-calc-ret2-v2' && payA.qb === 'pos_base' && payA.rp === FULL && payA.ao && payA.rd && payA.ls,
    'T1 chốt run contract full_line: payout = số RÒNG đã seal 3.000 (gộp sẽ là 8.000); payout ghi hợp đồng v2 / policy / mốc trả / sổ', JSON.stringify([A.diag, payA]))
  const staffA = await X.one(`SELECT count(*)::int n, sum(amount_vnd)::text s FROM public.cms_payout_staff WHERE program_id = $1`, [A.P.id])
  const prA = await settle(L_AS(X, U.super, `SELECT public.rpc_cms_payout($1) r`, [A.P.id]))
  const prAv = prA.ok ? prA.v.rows[0].r : null
  ok(staffA.n === 1 && staffA.s === '3000' && prAv?.program_total === '3000' && prAv.contract?.calc_contract_version === 'cms-calc-ret2-v2'
    && prAv.contract.returns_policy === FULL && prAv.returns?.return_count === 1 && dnum(prAv.returns.return_gmv) === '30000' && dnum(prAv.returns.eligible_return_base) === '10',
  'payout reader (super): khối hợp đồng + tổng trả ĐÃ TRỪ (1 phiếu / 30.000 / đủ điều kiện 10); dòng dược sĩ 3.000', JSON.stringify([staffA, prA.ok ? prAv : prA.err]))
  // T2 phát lại RT1 (cron — run đọc trả ⇒ profile theo policy run): tính lại = 3.000, Δ 0 — KHÔNG trừ kép.
  const r2 = await cron(A, payload(A, [A.R[0]], FULL))
  const h2 = r2.report_id ? await head(r2.report_id) : null
  const l2 = r2.report_id ? await line(r2.report_id, pa) : null
  const e2 = r2.report_id ? await evs(r2.report_id) : []
  ok(r2.saved === true && r2.baselines_new === 0 && h2?.f === '3000' && h2.rc === '3000' && h2.d === '0' && h2.cv === 'cron' && h2.pr === FULL
    && dnum(l2?.fb) === '16' && dnum(l2.rb) === '10' && dnum(l2.eb) === '6' && dnum(l2.frb) === '10' && dnum(l2.frg) === '30000' && dnum(l2.ng) === '130000'
    && e2.length === 1 && e2[0].pre === true && dnum(e2[0].q) === '10',
  'T2 phát lại phiếu đã trừ trước chốt ⇒ Δ 0 (gộp 16 − 10 = 6 = số đã chốt), sự kiện đánh dấu đã trừ trước chốt, 0 baseline mới', JSON.stringify([r2, h2, l2, e2]))
  // T3 RT2 CÙNG dòng a, hoàn 20k sau chốt: E giữ 6 (B_i một lần), G 110k < 120k ⇒ gate rớt ⇒ 0, Δ −3.000 (phi tuyến chỉ do tiền hoàn).
  const r3 = await cron(A, payload(A, [A.R[0], late(A.P, A.S[0], { id: 'CT2', refund: '20000', min: 30 })], FULL))
  const h3 = r3.report_id ? await head(r3.report_id) : null
  const l3 = r3.report_id ? await line(r3.report_id, pa) : null
  const e3 = r3.report_id ? await evs(r3.report_id) : []
  ok(r3.saved === true && r3.baselines_new === 1 && h3?.rc === '0' && h3.d === '-3000' && dnum(l3?.eb) === '6' && l3.g === false && dnum(l3.ng) === '110000'
    && e3.map((e) => `${e.id}:${dnum(e.q)}:${e.pre}`).join(',') === 'CT1:10:true,CT2:0:false',
  'T3 phiếu sau chốt cùng dòng: lượng 0 (đã trừ ở phiếu trước), chỉ thêm tiền hoàn ⇒ gate rớt ⇒ Δ −3.000', JSON.stringify([r3, h3, l3, e3]))
  const fullOnNet = await cron(A, payload(A, [A.R[0]], 'net_returns_v1'))
  ok(fullOnNet.err === 'CMS_REPORT_PROFILE_MISMATCH', 'run chốt full_line + payload profile net ⇒ CMS_REPORT_PROFILE_MISMATCH (0 ghi)', JSON.stringify(fullOnNet))

  // ── T4: K = 1, không gate; a10 b6; RT1 → a trước chốt ⇒ E 6 ⇒ 6.000. Sau chốt: RT2 cùng a ⇒ Δ 0 (chỉ hoàn); RT3 → b ⇒ E 0 ⇒ Δ −6.000.
  const pb = X.pid()
  const B = await locked('QA chốt contract FL dòng khác', { products: [{ pid: pb, k: '1', tiers: T1K(1000) }],
    sales: (P) => [X.srow(P, { pid: pb, base: 10, gmv: '100000', min: 60 }), X.srow(P, { pid: pb, base: 6, gmv: '60000', min: 61 })],
    pre: [(P, S) => X.rrow(P, S[0], { id: 'CB1', refund: '10000', min: 300 })] })
  const b2 = late(B.P, B.S[0], { id: 'CB2', refund: '5000', min: 30 })
  const r4a = await cron(B, payload(B, [B.R[0], b2], FULL))
  const r4b = await cron(B, payload(B, [B.R[0], b2, late(B.P, B.S[1], { id: 'CB3', refund: '1000', min: 31 })], FULL))
  const h4a = r4a.report_id ? await head(r4a.report_id) : null
  const h4b = r4b.report_id ? await head(r4b.report_id) : null
  const l4b = r4b.report_id ? await line(r4b.report_id, pb) : null
  ok(B.ok && h4a?.f === '6000' && h4a.d === '0' && h4b?.rc === '0' && h4b.d === '-6000' && dnum(l4b?.rb) === '16' && dnum(l4b.eb) === '0' && l4b.n === 3,
    'T4 phiếu sau chốt cùng dòng ⇒ Δ 0 (không gate); phiếu trên dòng KHÁC trừ E của dòng đó ⇒ E 0 ⇒ Δ −6.000', JSON.stringify([B.diag, h4a, h4b, l4b]))

  // ── T5: bậc phi tuyến (K = 1; 1–10 @1.000, từ 11 @2.000); a8 b6 c4; RT → c trước chốt ⇒ F(14) = 18.000; sau chốt RT → b ⇒ F(8) = 8.000, Δ −10.000.
  const pc = X.pid()
  const TT = [{ order: 1, from: 1, to: 10, amount: '1000' }, { order: 2, from: 11, to: null, amount: '2000' }]
  const C5 = await locked('QA chốt contract FL bậc', { products: [{ pid: pc, k: '1', tiers: TT }],
    sales: (P) => [X.srow(P, { pid: pc, base: 8, min: 60 }), X.srow(P, { pid: pc, base: 6, min: 61 }), X.srow(P, { pid: pc, base: 4, min: 62 })],
    pre: [(P, S) => X.rrow(P, S[2], { id: 'CC1', refund: '1000', min: 300 })] })
  const payC = await X.one(`SELECT amount_vnd::text a FROM public.cms_payouts WHERE program_id = $1`, [C5.P.id])
  const r5 = await cron(C5, payload(C5, [C5.R[0], late(C5.P, C5.S[1], { id: 'CC2', refund: '1000', min: 30 })], FULL))
  const h5 = r5.report_id ? await head(r5.report_id) : null
  ok(C5.ok && payC?.a === '18000' && h5?.f === '18000' && h5.rc === '8000' && h5.d === '-10000',
    'T5 thang phi tuyến: chốt F(14) = 18.000; phiếu sau chốt trên dòng b ⇒ F(8) = 8.000, Δ −10.000', JSON.stringify([C5.diag, payC, h5]))

  // ── T6: cms_unit full_line; c1 COUNTED E30, c2 OTHER_UNIT E0, c3 COUNTED E20; RT → c2 trước chốt ⇒ E 50 ⇒ Q5 ⇒ 500.
  //    Sau chốt: RT lặp trên c2 ⇒ Δ 0 (nhóm có phiếu mà lượng đủ điều kiện trừ 0 — ràng buộc 132 r1); RT → c1 ⇒ E 20 ⇒ Q2 ⇒ Δ −300.
  const pu = X.pid()
  const D = await locked('QA chốt contract FL unit', { v2: 'cms_unit', products: [{ pid: pu, k: '10', unit: 'Hộp' }],
    sales: (P) => [X.srow(P, { pid: pu, q: '3', u: 'Hộp', base: 30, gmv: '300000', min: 60 }), X.srow(P, { pid: pu, q: '15', u: 'Viên', base: 15, gmv: '150000', min: 61 }),
      X.srow(P, { pid: pu, q: '2', u: 'Hộp', base: 20, gmv: '200000', min: 62 })],
    pre: [(P, S) => X.rrow(P, S[1], { id: 'CU1', refund: '30000', min: 300 })] })
  const payD = await X.one(`SELECT amount_vnd::text a, quantity_basis qb FROM public.cms_payouts WHERE program_id = $1`, [D.P.id])
  const u2 = late(D.P, D.S[1], { id: 'CU2', refund: '1000', min: 30 })
  const r6a = await cron(D, payload(D, [D.R[0], u2], FULL))
  const l6a = r6a.report_id ? await line(r6a.report_id, pu) : null
  const r6b = await cron(D, payload(D, [D.R[0], u2, late(D.P, D.S[0], { id: 'CU3', refund: '1000', min: 31 })], FULL))
  const h6b = r6b.report_id ? await head(r6b.report_id) : null
  ok(D.ok && payD?.a === '500' && payD.qb === 'cms_unit' && r6a.saved === true && dnum(l6a?.rb) === '0' && l6a.n === 2 && dnum(l6a.frb) === '0'
    && h6b?.rc === '200' && h6b.d === '-300',
  'T6 cms_unit: phiếu trên dòng OTHER_UNIT (E 0) ⇒ Δ 0, nhóm 2 phiếu / trừ đủ điều kiện 0 hợp lệ; phiếu trên dòng COUNTED c1 ⇒ Q2, Δ −300',
  JSON.stringify([D.diag, payD, r6a, l6a, h6b]))

  // ── T7: net_returns_v1 contract (pos_base, K = 1): a B10; RT BI 3 trước chốt ⇒ E 7 ⇒ 700. Phát lại ⇒ Δ 0; BI 2 thêm cùng dòng ⇒ E 5 ⇒ Δ −200.
  const pn = X.pid()
  const N = await locked('QA chốt contract net', { policy: 'net_returns_v1', products: [{ pid: pn, k: '1' }],
    sales: (P) => [X.srow(P, { pid: pn, base: 10, gmv: '100000', min: 60 })],
    pre: [(P, S) => X.rrow(P, S[0], { id: 'CN1', bi: '3', refund: '30000', min: 300 })] })
  const payN = await X.one(`SELECT amount_vnd::text a, calc_contract_version cc, returns_policy rp FROM public.cms_payouts WHERE program_id = $1`, [N.P.id])
  const r7a = await cron(N, payload(N, [N.R[0]], 'net_returns_v1'))
  const r7b = await cron(N, payload(N, [N.R[0], late(N.P, N.S[0], { id: 'CN2', bi: '2', refund: '20000', min: 30 })], 'net_returns_v1'))
  const h7a = r7a.report_id ? await head(r7a.report_id) : null
  const h7b = r7b.report_id ? await head(r7b.report_id) : null
  const netFull = await cron(N, payload(N, [N.R[0]], FULL))
  ok(N.ok && payN?.a === '700' && payN.cc === 'cms-calc-ret2-v1' && payN.rp === 'net_returns_v1' && h7a?.d === '0' && h7a.pr === 'net_returns_v1'
    && h7b?.rc === '500' && h7b.d === '-200' && netFull.err === 'CMS_REPORT_PROFILE_MISMATCH',
  'T7 net contract: chốt 700 (ròng BI 3); phát lại Δ 0; BI 2 thêm ⇒ 500, Δ −200; payload full_line ⇒ PROFILE_MISMATCH', JSON.stringify([N.diag, payN, h7a, h7b, netFull]))

  // ── T8: cms_unit SALES-ONLY đã chốt (contract, không đọc trả): cron KHÔNG tự chọn ⇒ CMS_REPORT_POLICY_UNSELECTED (0 ghi); super chọn
  //    full_line ở lần lập tay đầu tiên ⇒ ghim; trừ đúng E dòng (c1 E30 ⇒ 0) ⇒ Δ −300.
  const pg = X.pid()
  const G = await locked('QA chốt contract sales-only', { policy: 'sales_only_v1', v2: 'cms_unit', products: [{ pid: pg, k: '10', unit: 'Hộp' }],
    sales: (P) => [X.srow(P, { pid: pg, q: '3', u: 'Hộp', base: 30, gmv: '300000', min: 60 })] })
  const payG = await X.one(`SELECT amount_vnd::text a, returns_policy rp, returns_as_of IS NULL ao, ledger_eval_seq IS NULL ls FROM public.cms_payouts WHERE program_id = $1`, [G.P.id])
  const gRaw = [late(G.P, G.S[0], { id: 'CG1', refund: '1000', min: 30 })]
  const g0 = await cron(G, payload(G, gRaw, FULL))
  const g0n = await X.one(`SELECT count(*)::int n FROM public.cms_return_close_reports WHERE program_id = $1`, [G.P.id])
  const g1 = await asSuper(G, payload(G, gRaw, FULL), 'Lập tay ngày 31 — chọn trừ đủ dòng (QA)', '00000000-0000-4000-8000-00000000c301')
  const hg = g1.report_id ? await head(g1.report_id) : null
  const g2 = await cron(G, payload(G, gRaw, 'net_returns_v1'))
  ok(G.ok && payG?.a === '300' && payG.rp === 'sales_only_v1' && payG.ao && payG.ls && g0.err === 'CMS_REPORT_POLICY_UNSELECTED' && g0n.n === 0
    && g1.saved === true && hg?.pr === FULL && hg.cv === 'super' && hg.d === '-300' && g2.err === 'CMS_REPORT_PROFILE_LEDGER_MISMATCH',
  'T8 sales-only đã chốt: cron ⇒ POLICY_UNSELECTED (0 báo cáo); super chọn full_line ⇒ ghim (Δ −300); sau đó v1 ⇒ LEDGER_MISMATCH',
  JSON.stringify([G.diag, payG, g0, g0n, g1, hg, g2]))

  // ── T9: dữ liệu run contract đã chốt bất biến (owner ghi thẳng / TRUNCATE ⇒ CMS_PAYOUT_FROZEN).
  const fz = []
  for (const sql of [`DELETE FROM public.cms_result_events WHERE run_id = $1`, `UPDATE public.cms_return_lines SET return_gmv_amount = return_gmv_amount WHERE run_id = $1`,
    `DELETE FROM public.cms_sales_source_lines WHERE run_id = $1`, `UPDATE public.cms_results SET amount_vnd = amount_vnd WHERE run_id = $1`]) {
    fz.push(code(await settle(X.db.query(sql, [A.runId]))))
  }
  fz.push(code(await settle(X.db.query(`UPDATE public.cms_payouts SET amount_vnd = amount_vnd WHERE program_id = $1`, [A.P.id]))))
  ok(fz.every((c) => c === 'CMS_PAYOUT_FROZEN' || c === 'CMS_PAYOUT_IMMUTABLE'), 'T9 run contract đã chốt: sự kiện / phiếu trả / lớp nguồn / kết quả / payout bất biến', JSON.stringify(fz))

  // ── T10: preview run contract chưa hết kỳ ⇒ không còn CONTRACT_UNSUPPORTED (blocker thường: NOT_ENDED); version lạ không tạo được (CHECK).
  const pq = X.pid()
  const Q = await X.makeProgram({ name: 'QA preview contract', products: [{ pid: pq, k: '1' }] })
  await X.setPolicy(Q, FULL, { cv: (await X.prog(Q.id)).v })
  const qs = await X.run(Q, [X.srow(Q, { pid: pq, base: 5 })], [])
  const pvq = await LA.runCmsLockPreview(LD, Q.id)
  const bq = pvq.ok ? pvq.preview.blockers : []
  ok(qs.status === 'published' && !bq.includes('CMS_LOCK_CONTRACT_UNSUPPORTED') && bq.includes('CMS_LOCK_NOT_ENDED'),
    'T10 preview run contract: không còn CONTRACT_UNSUPPORTED; chưa hết kỳ ⇒ NOT_ENDED', JSON.stringify([qs.status, bq]))
  // ── T11 (PM r0 P1-01 "phạm vi theo SP hiệu lực"): revision 131 bỏ SP có dữ liệu (retire) → sync lại → chốt legacy → báo cáo sau chốt.
  //    Phạm vi báo cáo = SP hiệu lực: phiếu trên dòng SP retire ⇒ ORIGIN_NOT_IN_PROGRAM (không HOLD), báo cáo lưu; pin còn SP retire ⇒ từ chối.
  const ra = X.pid(), rb = X.pid()
  const PR = await X.makeProgram({ name: 'QA retire → chốt → báo cáo', products: [{ pid: ra, k: '1' }, { pid: rb, k: '1' }], dates: [await X.day(-40), await X.day(-10)] })
  const rS = [X.srow(PR, { pid: ra, base: 4, min: 60 }), X.srow(PR, { pid: rb, base: 3, min: 61 })]
  const rs0 = await X.syncLegacy(PR, rS)
  const st0 = await X.prog(PR.id)
  const prodA = { product_id: ra, gmv_basis: 'none', target_gmv: null, base_quantity_cms: '1', tiers: T1(100), unit_cms: 'hộp', advice_text: `Tư vấn QA ${ra}`,
    name_snapshot: `SP giả ${ra}`, image_url_snapshot: null, price_snapshot: null }
  const mfp = (await X.one(`SELECT public.cms__mapping_fp() m`)).m
  const revPv = await settle(L_AS(X, U.super, `SELECT public.rpc_cms_program_revision_preview($1::jsonb) r`, [JSON.stringify({ program_id: PR.id,
    file_sha256: sha(`rev-132-${PR.id}`), catalog_target: null, products: [prodA], expected_run_id: st0.ptr, source: { mapping_fp: mfp, rows_read: 0 },
    impact: { status: 'ok', from_config_version: st0.v, totals: { before_vnd: '0', after_vnd: '0', delta_vnd: '0', people_up: 0, people_down: 0, published_vnd: null,
      published_run_id: st0.ptr } } })]).then((x) => x.rows[0].r))
  const revCm = revPv.ok ? await settle(L_AS(X, U.super, `SELECT public.rpc_cms_program_revision_commit($1, $2, $3, $4, $5, $6::jsonb) r`, [revPv.v.revision_id,
    revPv.v.from_config_version, revPv.v.payload_digest, crypto.randomUUID(), 'QA bỏ SP có dữ liệu trước khi chốt (132 r1)',
    JSON.stringify({ whole_period: true, may_decrease: true, removed: [rb] })]).then((x) => x.rows[0].r)) : revPv
  const retired = await X.one(`SELECT retired_at IS NOT NULL r FROM public.cms_program_products WHERE program_id = $1 AND product_id = $2`, [PR.id, rb])
  const rs1 = await X.syncLegacy(PR, [rS[0]])
  const pvR = await LA.runCmsLockPreview(LD, PR.id)
  const lkR = pvR.ok ? await LA.runCmsLock(LD, { programId: PR.id, expectedRunId: rs1.runId, expectedPolicyVersion: pvR.preview.policyVersion,
    ackReason: 'QA chốt sau retire (132 r1)' }) : { ok: false }
  const LR = { P: { ...PR, products: [{ pid: ra }] }, runId: rs1.runId }
  const rRaw = [late(PR, rS[0], { id: 'CR1', refund: '1000', min: 30 }), late(PR, rS[1], { id: 'CR2', refund: '1000', min: 31 })]
  const withRetired = CR.buildCmsCloseReportPayload({ startDate: PR.start, endDate: PR.end, productIds: [ra, rb] }, recs(rRaw, FULL),
    { provider: 'fixture', snapshotId: 'qa-ct-retired-pin', asOfMicros: nextAsOf(), profile: FULL })
  const badPin = await asSuper(LR, withRetired, 'Lập tay — pin còn SP đã retire (QA)', crypto.randomUUID())
  const rr1 = await asSuper(LR, payload(LR, rRaw, FULL), 'Lập tay sau khi bỏ SP — phạm vi SP hiệu lực (QA)', crypto.randomUUID())
  const ev11 = rr1.report_id ? await X.all(`SELECT return_event_id id, disposition d FROM public.cms_return_close_report_events WHERE report_id = $1 ORDER BY 1`, [rr1.report_id]) : []
  ok(rs0.status === 'published' && revCm.ok && revCm.v?.retired === 1 && retired?.r === true && rs1.status === 'published' && lkR.ok
    && badPin.err === 'CMS_REPORT_PIN_SCOPE' && rr1.saved === true && ev11.map((e) => `${e.id}:${e.d}`).join(',') === 'CR1:APPLIED,CR2:ORIGIN_NOT_IN_PROGRAM',
  'T11 SP retire (131) không vào phạm vi: pin còn SP retire ⇒ CMS_REPORT_PIN_SCOPE (0 ghi); phiếu trên dòng SP retire ⇒ ORIGIN_NOT_IN_PROGRAM (không HOLD), báo cáo lưu',
  JSON.stringify({ rs0: rs0.status, rev: revCm.ok ? revCm.v : revCm.err, retired, rs1: rs1.status, lk: lkR.ok ?? lkR, badPin, rr1, ev11 }))

  // ── T12 (r1): chốt run contract chỉ khi sổ trả / mốc trả của run còn khớp. Run contract hết kỳ, công bố sạch; giả lập trong DB THỬ
  //    (trigger tắt trong phiên harness, khôi phục ngay): sổ có baseline không hiệu lực trong run ⇒ preview CMS_LOCK_LEDGER_DRIFT, chốt bị
  //    từ chối (0 payout); mốc trả của run trước mốc sớm nhất ⇒ CMS_LOCK_RETURNS_TOO_EARLY; khôi phục ⇒ blocker như ban đầu.
  const pd = X.pid()
  const PD = await X.makeProgram({ name: 'QA chốt contract lệch sổ', products: [{ pid: pd, k: '1', tiers: T1K(1000) }], dates: [await X.day(-40), await X.day(-10)] })
  await X.setPolicy(PD, FULL, { cv: (await X.prog(PD.id)).v })
  const dS = [X.srow(PD, { pid: pd, base: 5, min: 60 })]
  const ds = await X.run(PD, dS, [X.rrow(PD, dS[0], { id: 'CD1', refund: '1000', min: 300 })])
  const tamper = async (sql, params) => {
    await X.db.query(`SET session_replication_role = replica`)
    try { await X.db.query(sql, params) } finally { await X.db.query(`SET session_replication_role = origin`) }
  }
  const dbl = async () => { const p = await LA.runCmsLockPreview(LD, PD.id); return p.ok ? [...p.preview.blockers].sort() : [`ERR:${p.code ?? '?'}`] }
  const d0 = await dbl()
  const asOf0 = (await X.one(`SELECT returns_as_of::text a FROM public.cms_sync_runs WHERE id = $1`, [ds.runId])).a
  // Run công bố luôn CLEAN (CHECK contract_ok) ⇒ giả lập lệch bằng cách bỏ dòng phiếu CD1 khỏi run (baseline CD1 còn) rồi chép lại nguyên dòng.
  const rl0 = (await X.one(`SELECT to_jsonb(rl) j FROM public.cms_return_lines rl WHERE rl.run_id = $1 AND rl.return_event_id = 'CD1'`, [ds.runId]))?.j ?? null
  await tamper(`DELETE FROM public.cms_return_lines WHERE run_id = $1 AND return_event_id = 'CD1'`, [ds.runId])
  const d1 = await dbl()
  const pv1 = await LA.runCmsLockPreview(LD, PD.id)
  const lk1 = pv1.ok ? await LA.runCmsLock(LD, { programId: PD.id, expectedRunId: ds.runId, expectedPolicyVersion: pv1.preview.policyVersion,
    ackReason: 'QA thử chốt khi sổ trả lệch run (132 r1)' }) : { ok: false, code: 'PREVIEW_FAILED' }
  await tamper(`INSERT INTO public.cms_return_lines SELECT (jsonb_populate_record(NULL::public.cms_return_lines, $1::jsonb)).*`, [JSON.stringify(rl0)])
  await tamper(`UPDATE public.cms_sync_runs SET returns_as_of = $2::timestamptz WHERE id = $1`, [ds.runId, `${PD.end}T00:00:00Z`])
  const d2 = await dbl()
  await tamper(`UPDATE public.cms_sync_runs SET returns_as_of = $2::timestamptz WHERE id = $1`, [ds.runId, asOf0])
  const d3 = await dbl()
  const nPayD = (await X.one(`SELECT count(*)::int n, bool_or(status = 'locked') l FROM public.cms_payouts p JOIN public.cms_programs g ON g.id = p.program_id WHERE p.program_id = $1`, [PD.id]))
  ok(ds.status === 'published' && rl0 !== null && !d0.includes('CMS_LOCK_LEDGER_DRIFT') && !d0.includes('CMS_LOCK_RETURNS_TOO_EARLY') && d1.includes('CMS_LOCK_LEDGER_DRIFT')
    && !lk1.ok && d2.includes('CMS_LOCK_RETURNS_TOO_EARLY') && JSON.stringify(d3) === JSON.stringify(d0) && nPayD.n === 0 && (await X.prog(PD.id)).status !== 'locked',
  'T12 chốt run contract: baseline của sổ không còn là phiếu hiệu lực trong run ⇒ LEDGER_DRIFT, chốt bị từ chối (0 payout); mốc trả trước mốc sớm nhất ⇒ RETURNS_TOO_EARLY; khôi phục ⇒ như ban đầu',
  JSON.stringify({ ds: ds.status, d0, d1, lk1, d2, d3, nPayD }))

  // capability qua parser THẬT: lock_contract + manual_report bật.
  const capRaw = (await X.svc(`SELECT public.rpc_cms_capabilities() c`)).rows[0].c
  const cap = CAP.parseCmsCapabilities(capRaw)
  ok(cap.paths.lock_contract === true && cap.paths.manual_report === true, 'capability (parser app): lock_contract + manual_report bật', JSON.stringify(cap.off))
}

// ── §8c (r1 — PM r0 P1-04): đường ngày 31 bằng PHIÊN super; actor từ phiên; lý do + khoá yêu cầu lưu cùng báo cáo; trần CAP (10.000, Q-238) ─────
async function manualSection() {
  section(`8c. Báo cáo ngày 31 qua phiên super + trần full_line ${CR.CMS_CLOSE_REPORT_MAX_RETURNS_FULL_LINE} (PM r0 P1-04 / §3.3, r1 P1-2)`)
  const X = await env('manual')
  ok(X.applied.ok, 'DB thủ công: áp 132', X.applied.err)
  const pm = X.pid()
  const L = await lockedProgram(X, 'QA ngày 31 phiên super', [{ p: pm, base: 20 }, { p: pm, s: 1, base: 5 }])
  let tick = BigInt(Date.now()) * BigInt(1000)
  const recs = (raws, profile) => raws.map((r) => { const n = RT.normalizeReturnRow(r, profile); if (!n.ok) throw new Error('phiếu giả lỗi'); return n.value })
  const late = (sale, id, min) => ({ ...X.rrow(L.P, sale, { id, min: 0 }), return_recorded_at: new Date(Date.parse(`${L.P.end}T05:00:00Z`) + min * 60000).toISOString(), source_updated_at: null })
  const pl = (raws, profile = FULL) => CR.buildCmsCloseReportPayload({ startDate: L.P.start, endDate: L.P.end, productIds: [pm] }, recs(raws, profile),
    { provider: 'fixture', snapshotId: `qa-m-${tick}`, asOfMicros: (tick = BigInt(Date.now()) * BigInt(1000) > tick + BigInt(1000) ? BigInt(Date.now()) * BigInt(1000) : tick + BigInt(1000)), ...(profile === FULL ? { profile } : {}) })
  const SUPER = `SELECT public.rpc_cms_return_close_report_save_super($1, $2, $3::jsonb, $4, $5) r`
  const as = async (uid, role, payload, reason, req) => {
    const x = await settle(L_AS(X, uid, SUPER, [L.P.id, L.runId, JSON.stringify(payload), reason, req], role))
    return x.ok ? x.v.rows[0].r : { err: code(x) }
  }
  const nRep = async () => (await X.one(`SELECT count(*)::int n FROM public.cms_return_close_reports WHERE program_id = $1`, [L.P.id])).n
  const RAW = [late(L.S[0], 'M31A', 1)]
  const REQ = '00000000-0000-4000-8000-0000000003a1'
  const REASON = 'Phiếu hoàn tất sau ngày 30 — đối soát ngày 31'
  // Không phiên / không super / phiên hết hạn / anon ⇒ chặn, 0 ghi.
  const cronNo = await settle(X.svc(`SELECT public.rpc_cms_return_close_report_save($1, $2, $3::jsonb) r`, [L.P.id, L.runId, JSON.stringify(pl(RAW))]))
  const forged = await settle(X.svc(`SELECT public.rpc_cms_return_close_report_save($1, $2, $3::jsonb) r`,
    [L.P.id, L.runId, JSON.stringify({ ...pl(RAW), actor: U.super })]))
  const admin = await as(U.ops, 'authenticated', pl(RAW), REASON, REQ)
  const expired = await as(null, 'authenticated', pl(RAW), REASON, REQ)
  const anon = await as(null, 'anon', pl(RAW), REASON, REQ)
  const shortR = await as(U.super, 'authenticated', pl(RAW), 'ngắn quá', REQ)
  const ctrlR = await as(U.super, 'authenticated', pl(RAW), 'lý do có \u0007 điều khiển', REQ)
  const padR = await as(U.super, 'authenticated', pl(RAW), `  ${REASON}  `, REQ)
  const noReq = await as(U.super, 'authenticated', pl(RAW), REASON, null)
  const n0 = await nRep()
  ok(L.ok && code(cronNo) === 'CMS_REPORT_POLICY_UNSELECTED' && code(forged) === 'CMS_REPORT_BAD_INPUT' && admin.err === 'CMS_REPORT_FORBIDDEN'
    && expired.err === 'CMS_REPORT_FORBIDDEN' && /permission denied/i.test(anon.err ?? '') && shortR.err === 'CMS_REPORT_BAD_INPUT' && ctrlR.err === 'CMS_REPORT_BAD_INPUT'
    && padR.err === 'CMS_REPORT_BAD_INPUT' && noReq.err === 'CMS_REPORT_BAD_INPUT' && n0 === 0,
  'chặn trước mọi ghi: cron chưa chọn ⇒ UNSELECTED; body khai actor ⇒ BAD_INPUT; admin thường / phiên hết hạn ⇒ FORBIDDEN; anon ⇒ không EXECUTE; lý do sai ⇒ BAD_INPUT',
  JSON.stringify([L.diag, code(cronNo), code(forged), admin, expired, anon, shortR, ctrlR, padR, noReq, n0]))
  // Super hợp lệ ⇒ lưu: người lập = PHIÊN, lý do + khoá yêu cầu lưu cùng báo cáo.
  const ok1 = await as(U.super, 'authenticated', pl(RAW), REASON, REQ)
  const h1 = ok1.report_id ? await X.one(`SELECT created_via cv, created_by::text by, manual_reason mr, manual_request::text rq, returns_profile pr FROM public.cms_return_close_reports WHERE id = $1`, [ok1.report_id]) : null
  // Phát lại cùng khoá (snapshot mới) ⇒ báo cáo đã lập; khoá mới cùng snapshot ⇒ idem snapshot ⇒ already (không nhân bản).
  const again = await as(U.super, 'authenticated', pl(RAW), REASON, REQ)
  const n1 = await nRep()
  ok(ok1.saved === true && h1?.cv === 'super' && h1.by === U.super && h1.mr === REASON && h1.rq === REQ && h1.pr === FULL
    && again.saved === true && again.already === true && again.report_id === ok1.report_id && n1 === 1,
  'super hợp lệ ⇒ lưu (created_by = phiên, lý do + khoá yêu cầu); phát lại cùng khoá ⇒ báo cáo cũ, không nhân bản', JSON.stringify([ok1, h1, again, n1]))
  const rd = await settle(L_AS(X, U.super, `SELECT public.rpc_cms_return_close_reports($1) r`, [L.P.id]))
  ok(rd.ok && rd.v.rows[0].r.reports[0].manual_reason === REASON && rd.v.rows[0].r.reports[0].created_via === 'super'
    && rd.v.rows[0].r.reports[0].created_by === U.super && !('manual_request' in rd.v.rows[0].r.reports[0]),
    'reader danh sách báo cáo (super) trả người lập (phiên) + lý do lập tay; không lộ khoá yêu cầu', JSON.stringify(rd.ok ? rd.v.rows[0].r.reports[0] : rd.err).slice(0, 300))
  // Trần full_line CAP (= TS CMS_CLOSE_REPORT_MAX_RETURNS_FULL_LINE — r1 P1-2 đề xuất 10.000, Q-238): CAP + 1 ⇒ CMS_REPORT_TOO_LARGE trước mọi
  // khoá / ghi; CAP phiếu chưa hiệu lực ⇒ lưu được. Số lấy từ hằng TS ⇒ SQL lệch TS là đỏ.
  const CAP = CR.CMS_CLOSE_REPORT_MAX_RETURNS_FULL_LINE
  const ne = (n) => Array.from({ length: n }, (_, i) => ({ ...late(L.S[0], `NE${String(i).padStart(6, '0')}`, 2), return_status: 'CANCELED' }))
  // Snapshot phải giữ phiếu đã APPLIED ở báo cáo trước (M31A) — thiếu ⇒ baseline mất; CAP − 1 phiếu huỷ + M31A = CAP.
  const fitCap = pl([...RAW, ...ne(CAP - 1)])
  let tsCap = null
  try { pl([...RAW, ...ne(CAP)]) } catch (e) { tsCap = e instanceof CR.CmsCloseReportTooLargeError ? 'TS_TOO_LARGE' : String(e) }
  // r1 gate 5: payload CAP + 1 phải HỢP LỆ (pin đúng) để chỉ trần SQL chặn được (bản ghép tay lệch pin ⇒ đột biến trần vẫn bị BAD_PIN chặn,
  // không chứng minh trần). Dựng lại ĐÚNG công thức buildCmsCloseReportPayload (khối pin.returns + returns) — bỏ kiểm trần TS; tự kiểm khớp
  // builder thật ở CAP phiếu.
  const plOver = (raws) => {
    const base = pl(raws.slice(0, CAP))
    const sorted = recs(raws, FULL).sort((a, b) => Buffer.compare(Buffer.from(a.returnEventId, 'utf8'), Buffer.from(b.returnEventId, 'utf8')))
    return { ...base, pin: { ...base.pin, returns: { rows: sorted.length,
      digest: SD.cmsDigestSet('returns', sorted.map((r) => ({ id: r.returnEventId, hash: CR.cmsCloseReportRowHash(r) }))) } },
      returns: sorted.map(CR.cmsCloseReportReturnRow) }
  }
  const same = plOver([...RAW, ...ne(CAP - 1)])
  const formulaOk = JSON.stringify(same.returns) === JSON.stringify(fitCap.returns) && JSON.stringify(same.pin.returns) === JSON.stringify(fitCap.pin.returns)
  const big = plOver([...RAW, ...ne(CAP)])
  const nRep0 = (await X.one(`SELECT count(*)::int n FROM public.cms_return_close_reports WHERE program_id = $1`, [L.P.id])).n
  const tl = await settle(X.svc(`SELECT public.rpc_cms_return_close_report_save($1, $2, $3::jsonb) r`, [L.P.id, L.runId, JSON.stringify(big)]))
  const t0 = Date.now()
  const fit = await settle(X.svc(`SELECT public.rpc_cms_return_close_report_save($1, $2, $3::jsonb) r`, [L.P.id, L.runId, JSON.stringify(fitCap)]))
  const ms = Date.now() - t0
  // db-reviewer r1 P2: run chốt CONTRACT ⇒ cùng trần CAP cả với payload net_returns_v1 (đường hợp đồng đóng băng mới ở r1); run chốt LEGACY
  // giữ trần v1 100.000 (CAP + 1 không chạm trần — dừng ở mã khác).
  // Payload v1 HỢP LỆ hình dạng (phiếu APPROVED — từ điển v1 không biết CANCELED — chỉ ID + trạng thái; pin.returns.rows = CAP + 1) ⇒ qua
  // mọi kiểm trước khoá, tới đúng bước trần run contract (sau khi đọc run, trước pin / mọi ghi).
  const v1pl = JSON.stringify({ pin: { ...big.pin }, returns: Array.from({ length: CAP + 1 }, (_, i) => ({ return_event_id: `AP${String(i).padStart(6, '0')}`,
    return_status: 'APPROVED' })) })
  // L (§8c) là chương trình LEGACY đã có báo cáo full_line ⇒ v1 không chạm trần (dừng ở mã khác).
  const v1big = await settle(X.svc(`SELECT public.rpc_cms_return_close_report_save($1, $2, $3::jsonb) r`, [L.P.id, L.runId, v1pl]))
  const LG = await lockedProgram(X, 'QA trần v1 legacy', [{ p: X.pid(), base: 20 }])
  const v1legacy = LG.ok ? await settle(X.svc(`SELECT public.rpc_cms_return_close_report_save($1, $2, $3::jsonb) r`, [LG.P.id, LG.runId, v1pl]))
    : { ok: false, err: 'LG' }
  // PM 19/11 §5 bước 4: legacy giữ trần v1 100.000 (tương thích, KHÔNG phải quy mô đã chứng minh) — 100.001 phiếu ⇒ TOO_LARGE (0 ghi).
  const v1max = JSON.stringify({ pin: { ...big.pin, returns: { ...big.pin.returns, rows: 100_001 } }, returns: Array.from({ length: 100_001 }, (_, i) => ({
    return_event_id: `AX${String(i).padStart(6, '0')}`, return_status: 'APPROVED' })) })
  const v1legacyMax = LG.ok ? await settle(X.svc(`SELECT public.rpc_cms_return_close_report_save($1, $2, $3::jsonb) r`, [LG.P.id, LG.runId, v1max]))
    : { ok: false, err: 'LG' }
  // Trần theo PROFILE (trước khoá) vẫn tự đứng được: payload full_line CAP + 1 trên run LEGACY (trần run contract không áp) ⇒ TOO_LARGE.
  const flLegacy = LG.ok ? await settle(X.svc(`SELECT public.rpc_cms_return_close_report_save($1, $2, $3::jsonb) r`, [LG.P.id, LG.runId, JSON.stringify(big)]))
    : { ok: false, err: 'LG' }
  // Chương trình QA run CONTRACT net_returns_v1 đã chốt (lockAction thật) ⇒ payload v1 CAP + 1 (khớp policy run) ⇒ TOO_LARGE ở trần run contract.
  const pc = X.pid()
  const PC = await X.makeProgram({ name: 'QA trần run contract net', products: [{ pid: pc, k: '1' }], dates: [await X.day(-40), await X.day(-10)] })
  const polc = await X.setPolicy(PC, 'net_returns_v1', { cv: (await X.prog(PC.id)).v })
  const syc = await X.run(PC, [X.srow(PC, { pid: pc, base: 5, min: 60 })], [])
  const LDc = lockDepsOf(X)
  const pvc = await LA.runCmsLockPreview(LDc, PC.id)
  const lkc = pvc.ok ? await LA.runCmsLock(LDc, { programId: PC.id, expectedRunId: syc.runId, expectedPolicyVersion: pvc.preview.policyVersion,
    ackReason: 'QA chốt run contract net — trần báo cáo' }) : { ok: false }
  const v1ct = lkc.ok ? await settle(X.svc(`SELECT public.rpc_cms_return_close_report_save($1, $2, $3::jsonb) r`, [PC.id, syc.runId, v1pl])) : { ok: false, err: 'LKC' }
  const nTl = (await X.one(`SELECT count(*)::int n FROM public.cms_return_close_reports WHERE program_id = ANY($1::uuid[])`, [[L.P.id, LG.P.id, PC.id]])).n
  ok(formulaOk && big.returns.length === CAP + 1 && big.pin.returns.rows === CAP + 1 && tsCap === 'TS_TOO_LARGE' && code(tl) === 'CMS_REPORT_TOO_LARGE'
    && fit.ok && fit.v.rows[0].r.saved === true && LG.ok && polc.ok && lkc.ok
    && code(v1big) !== 'CMS_REPORT_TOO_LARGE' && !v1big.ok && code(v1legacy) !== 'CMS_REPORT_TOO_LARGE' && !v1legacy.ok
    && code(flLegacy) === 'CMS_REPORT_TOO_LARGE' && code(v1ct) === 'CMS_REPORT_TOO_LARGE' && code(v1legacyMax) === 'CMS_REPORT_TOO_LARGE' && nTl === nRep0 + 1,
    `trần (CAP ${CAP}): TS chặn CAP + 1 full_line; SQL CAP + 1 pin HỢP LỆ ⇒ TOO_LARGE (0 ghi); CAP phiếu ⇒ lưu (${ms} ms); run LEGACY: v1 CAP + 1 không chạm trần (100.000), v1 100.001 ⇒ TOO_LARGE, full_line CAP + 1 ⇒ TOO_LARGE; run CONTRACT net đã chốt: v1 CAP + 1 ⇒ TOO_LARGE`,
    JSON.stringify([formulaOk, tsCap, code(tl), fit.ok ? fit.v.rows[0].r : fit.err, code(v1big), LG.ok ? code(v1legacy) : LG.diag, code(flLegacy),
      polc.ok ? 'pol' : polc.err, lkc.ok ? 'lk' : [syc.status, syc.code, pvc.ok ? pvc.preview.blockers : pvc, lkc], code(v1ct), code(v1legacyMax), nTl, nRep0]))
}

// ── §8d r2 (PM 19/11 `planning/reviews/2026-11-19-cms-returns-r1-audit-pm.md` §4.2 — RET-R2-01, Q-238 b) ─────────────────────────────
//    Chương trình THẬT (policy thật giả lập ready + operator_reconciliation CHỈ trong DB thử; prod real.ready = false — Q-206 / Q-213 /
//    Q-216 — r2 không mở cổng đó): chứng nhận nguồn có VERSION theo cách tính — pos_base ⇒ decision10 / v1; cms_unit ⇒ decision_unit14
//    (thô q / u + cờ) / v2 — đi qua lõi CLI THẬT (xuất trang rpc_cms_run_source_export bằng phiên super → cmsAttestExportPage → CSV 14 / 18
//    cột → đọc lại → compare TÍNH LẠI đúng chế độ → payload) → rpc_cms_source_attest → cms__attest_eval → preview → chốt (lockAction thật)
//    → reader đóng băng / parser payout / XLSX → báo cáo sau chốt. Ca 1 (2 basis × net / full_line) · ca 5 (báo cáo so số RÒNG đóng băng)
//    · ca 2 (chỉ đổi q / u, B / G + decision10 giữ) · ca 3 (bị chặn) · rollback dừng khi đã có decision_unit14. Ca 4 (race): §12c PG15.
//    Ca 6 (đột biến qua generator): §8e.

/** Helper báo cáo sau chốt (cùng ngữ nghĩa §8b). */
/** o.provider: chương trình thật ⇒ 'bq' (DB ghim provider báo cáo — CMS_REPORT_PIN_PROVIDER). */
function ctHelpers(X, o0 = {}) {
  let tick = BigInt(Date.now()) * BigInt(1000)
  const nextAsOf = () => { const now = BigInt(Date.now()) * BigInt(1000); tick = now > tick + BigInt(1000) ? now : tick + BigInt(1000); return tick }
  const recs = (raws, profile) => raws.map((r) => { const n = RT.normalizeReturnRow(r, profile); if (!n.ok) throw new Error('phiếu giả lỗi ' + JSON.stringify(n.issues)); return n.value })
  const after = (P, min) => new Date(Date.parse(`${P.end}T05:00:00Z`) + min * 60000).toISOString()
  const late = (P, sale, o) => ({ ...X.rrow(P, sale, o), return_recorded_at: after(P, o.min), source_updated_at: after(P, o.min) })
  const payload = (L, raws, profile, o = {}) => CR.buildCmsCloseReportPayload({ startDate: L.P.start, endDate: L.P.end, productIds: L.P.products.map((x) => x.pid) },
    recs(raws, profile), { provider: o0.provider ?? 'fixture', snapshotId: o.snap ?? `qa-r2-${tick}`, asOfMicros: nextAsOf(), ...(profile === FULL ? { profile } : {}) })
  const cron = async (L, pl) => {
    const r = await settle(X.svc(`SELECT public.rpc_cms_return_close_report_save($1, $2, $3::jsonb) r`, [L.P.id, L.runId, JSON.stringify(pl)]))
    return r.ok ? r.v.rows[0].r : { err: code(r) }
  }
  const asSuper = async (L, pl, reason, req) => {
    const r = await settle(L_AS(X, U.super, `SELECT public.rpc_cms_return_close_report_save_super($1, $2, $3::jsonb, $4, $5) r`, [L.P.id, L.runId, JSON.stringify(pl), reason, req]))
    return r.ok ? r.v.rows[0].r : { err: code(r) }
  }
  const head = (id) => X.one(`SELECT frozen_amount::text f, recomputed_amount::text rc, delta_amount::text d, created_via cv, returns_profile pr
    FROM public.cms_return_close_reports WHERE id = $1`, [id])
  return { nextAsOf, recs, late, payload, cron, asSuper, head }
}

/** Chương trình thật + lõi CLI chứng nhận (dùng chung §8d / §8e / §12c). */
async function realKit(X) {
  const AT = await lib('e2e/cmsSourceAttest.ts')
  const CI = await lib('e2e/cmsI4CompareSource.ts')
  const I4 = await lib('e2e/cmsI4Offline.ts')
  const fakePolicy = `CREATE OR REPLACE FUNCTION public.cms__lock_policy() RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public AS $f$
    SELECT jsonb_build_object('version', 1, 'real', jsonb_build_object('ready', true, 'unassigned_max_gmv_bp', 200, 'unassigned_max_lines', 20, 'wait_hours', 0,
      'completeness', 'operator_reconciliation'), 'qa', jsonb_build_object('label', 'QA_ONLY_ASSUMPTION', 'unassigned_max_gmv_bp', 200, 'unassigned_max_lines', 20,
      'wait_hours', 0, 'completeness', 'qa_assumption')) $f$`
  // Fixture tự chặn chương trình thật (worker FIXTURE_REAL_PROGRAM + DB SEAL_PIN_PROVIDER) ⇒ DB THỬ: bọc thành provider 'bq' (đứng thay
  // adapter BigQuery — cùng hợp đồng read(), dữ liệu giả); chỉ trong harness, không đường nào của app dùng.
  const syncReal = (P, S, R) => {
    const fx = CF.createCmsContractFixtureProvider({ sales: S, returns: R })
    const bq = { kind: 'bq', read: async (scope) => { const r = await fx.read(scope); return r.ok ? { ...r, provider: 'bq' } : r } }
    return SS.runCmsSalesSync(X.deps(bq), P.id, { dryRun: false, source: 'cron', sourceCapture: true, chunkSize: 3, calcFlags: ON })
  }
  const dbNow = async () => (await X.one(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') t`)).t
  const progOf = async (id) => AT.parseCmsAttestProgram((await X.svc(AT.cmsAttestProgramSql(id))).rows[0])
  /** Xuất run như CLI export-run: phiên `uid`, trang 2 dòng (đủ nhiều trang), kiểm từng trang bằng lõi CLI. */
  async function exportRun(P, runId, uid = U.super) {
    let st = AT.newCmsAttestExportState(P.id, runId)
    for (let after = null; ;) {
      const r = await settle(L_AS(X, uid, `SELECT public.rpc_cms_run_source_export($1, $2, $3, 2) r`, [P.id, runId, after]))
      if (!r.ok) return { ok: false, code: code(r) }
      const pg = AT.cmsAttestExportPage(st, r.v.rows[0].r, 2)
      if (!pg.ok) return { ok: false, code: pg.code }
      st = pg.state
      if (pg.done) return { ok: true, st }
      after = st.lastId
    }
  }
  /**
   * Lõi CLI attest: tham chiếu = dòng nguồn THÔ (CSV 14 cột như BQ); run = file xuất (18 cột khi unit14). Chế độ theo cmsAttestModeOf
   * (o.mode ép — đối chứng âm); o.send false ⇒ chỉ dựng payload.
   */
  async function cliAttest(P, runId, refRows, o = {}) {
    const prog = await progOf(P.id)
    const md = AT.cmsAttestModeOf(prog)
    const mode = o.mode ?? (md.ok ? md.mode : 'decision10')
    const ex = await exportRun(P, runId)
    if (!ex.ok) return { ok: false, why: `export ${ex.code}`, prog, md, mode }
    const unit = mode === 'unit14'
    const appCsv = AT.cmsAttestExportCsv(ex.st.rows, unit)
    const refCsv = AT.cmsAttestExportCsv(refRows)
    const refSha = sha(refCsv), appSha = sha(appCsv)
    const refRead = I4.cmsI4ReadCsv(new Uint8Array(Buffer.from(refCsv, 'utf8')), C.CMS_SALES_COLUMNS)
    const appRead = I4.cmsI4ReadCsv(new Uint8Array(Buffer.from(appCsv, 'utf8')), unit ? [...C.CMS_SALES_COLUMNS, ...CI.CMS_I4_UNIT_APP_COLUMNS] : C.CMS_SALES_COLUMNS)
    if (!refRead.ok || !appRead.ok) return { ok: false, why: `csv ${refRead.reason ?? ''} ${appRead.reason ?? ''}`, prog, md, mode }
    const at = await dbNow()
    const side = (kind, s) => ({ inputKind: kind, source: kind === 'reference_source' ? 'Nguồn độc lập giả — QA r2' : 'rpc_cms_run_source_export', exportedAt: at, asOf: at,
      fileSha256: s, scope: { startDate: prog.startDate, endDate: prog.endDate, productIds: prog.productIds }, runId: kind === 'published_run' ? runId : null })
    const meta = CI.cmsI4ParseEvidenceMeta({ version: 1, reference: side('reference_source', refSha), app: side('published_run', appSha) })
    const compare = CI.cmsI4CompareSource({ context: AT.cmsAttestContext(prog), reference: { rows: refRead.rows, fileSha256: refSha },
      app: { rows: appRead.rows, fileSha256: appSha }, meta: meta.value, mode })
    const built = AT.cmsAttestBuildPayload({ program: prog, runId, compare, meta: meta.value, refSha, appSha, ack: 'Đã đối soát nguồn độc lập toàn kỳ (QA r2)' })
    let att = null
    if (built.ok && o.send !== false) {
      att = await settle(L_AS(X, o.uid ?? U.super, `SELECT public.rpc_cms_source_attest($1, $2, $3::jsonb, $4) r`,
        [P.id, runId, JSON.stringify(built.payload), o.idem ?? crypto.randomUUID()]).then((x) => x.rows[0].r))
    }
    return { ok: built.ok && (o.send === false || att?.ok === true), prog, md, mode, unitCols: ex.st.unitCols, pages: ex.st.pages, compare, built, att,
      attId: att?.ok ? att.v.id : null }
  }
  const evalOf = async (P, runId) => (await X.one(`SELECT public.cms__attest_eval($1, $2) e`, [P.id, runId])).e
  const sendRaw = (P, runId, payload, uid = U.super, idem = crypto.randomUUID()) => settle(L_AS(X, uid, `SELECT public.rpc_cms_source_attest($1, $2, $3::jsonb, $4) r`,
    [P.id, runId, JSON.stringify(payload), idem]).then((x) => x.rows[0].r))
  const fps = (runId) => X.one(`SELECT public.cms__run_unit_fp($1) u, public.cms__run_source_fp($1, 'decision10') d`, [runId])
  /** Ghi thẳng (owner, trigger tắt) trong transaction rồi ROLLBACK — chỉ đo bằng câu owner (eval / vân tay / lock_eval). */
  async function tamper(stmts, probe) {
    await X.db.exec('BEGIN')
    try {
      await X.db.exec(`SET LOCAL session_replication_role = replica`)
      for (const [sql, p] of stmts) await X.db.query(sql, p)
      return await probe()
    } catch (e) { return { err: String(e.message).slice(0, 160) } } finally { await X.db.exec('ROLLBACK') }
  }
  const blockersOwner = async (P, runId) => (await X.one(`SELECT public.cms__lock_eval($1, $2, 1, NULL, false) -> 'blockers' b`, [P.id, runId])).b
  return { AT, CI, I4, fakePolicy, syncReal, dbNow, progOf, exportRun, cliAttest, evalOf, sendRaw, fps, tamper, blockersOwner }
}

const unitSalesOf = (X) => (P, p) => [X.srow(P, { pid: p, q: '3', u: 'Hộp', base: 30, gmv: '300000', min: 60 }),
  X.srow(P, { pid: p, q: '15', u: 'Viên', base: 15, gmv: '150000', min: 61 }), X.srow(P, { pid: p, q: '2', u: 'Hộp', base: 20, gmv: '200000', min: 62 })]

async function realAttestSection() {
  section('8d. r2 — chương trình thật: chứng nhận decision10 / decision_unit14 qua lõi CLI ⇒ chốt ⇒ báo cáo (PM 19/11 §4.2 ca 1 / 2 / 3 / 5)')
  const X = await env('ctreal')
  ok(X.applied.ok, 'DB chốt thật: áp 132', X.applied.err)
  const LD = lockDepsOf(X)
  const K = await realKit(X)
  const PV = await lib('lib/cms/payoutView.ts')
  const EXP = await lib('lib/cms/exportPayouts.ts')
  const XM = await import('xlsx')
  const XLSX = XM.read ? XM : XM.default
  const H = ctHelpers(X, { provider: 'bq' })
  const polOrig = (await X.one(`SELECT pg_get_functiondef('public.cms__lock_policy()'::regprocedure) d`)).d
  await X.db.exec(K.fakePolicy)
  try {
    const unitSales = unitSalesOf(X)
    const posSales = (P, p) => [X.srow(P, { pid: p, base: 10, gmv: '100000', min: 60 }), X.srow(P, { pid: p, base: 6, gmv: '60000', min: 61 })]
    // Oracle TAY (T1 100 đ / đơn vị CMS):
    //  pos_full  K 1: a10 b6; RT → a trước chốt ⇒ E 6 ⇒ 600.          pos_net  K 1: a10 b6; RT BI 3 → a ⇒ E 13 ⇒ 1.300.
    //  unit_full K 10 Hộp: c1 COUNTED E30, c2 OTHER_UNIT E0, c3 COUNTED E20; RT → c2 ⇒ E 50 ⇒ Q5 ⇒ 500 (như T6 §8b).
    //  unit_net  K 10 Hộp: cùng dòng, không phiếu trước chốt ⇒ E 50 ⇒ Q5 ⇒ 500.
    const COMBOS = [
      { key: 'pos_full', basis: null, policy: FULL, prod: (p) => [{ pid: p, k: '1' }], sales: posSales, amount: '600', fs: 'decision10',
        pre: (P, S) => [X.rrow(P, S[0], { id: 'R2PF1', refund: '30000', min: 300 })] },
      { key: 'pos_net', basis: null, policy: 'net_returns_v1', prod: (p) => [{ pid: p, k: '1' }], sales: posSales, amount: '1300', fs: 'decision10',
        pre: (P, S) => [X.rrow(P, S[0], { id: 'R2PN1', bi: '3', refund: '30000', min: 300 })] },
      { key: 'unit_full', basis: 'cms_unit', policy: FULL, prod: (p) => [{ pid: p, k: '10', unit: 'Hộp' }], sales: unitSales, amount: '500', fs: 'decision_unit14',
        pre: (P, S) => [X.rrow(P, S[1], { id: 'R2UF1', refund: '30000', min: 300 })] },
      { key: 'unit_net', basis: 'cms_unit', policy: 'net_returns_v1', prod: (p) => [{ pid: p, k: '10', unit: 'Hộp' }], sales: unitSales, amount: '500', fs: 'decision_unit14',
        pre: () => [] },
    ]
    const done = {}
    for (const c of COMBOS) {
      const p = X.pid()
      const P = await X.makeProgram({ name: `Thật r2 ${c.key}`, isTest: false, products: c.prod(p), dates: [await X.day(-40), await X.day(-10)], ...(c.basis ? { v2: c.basis } : {}) })
      const pol = await X.setPolicy(P, c.policy, { cv: (await X.prog(P.id)).v })
      const S = c.sales(P, p)
      const R = c.pre(P, S)
      const sy = await K.syncReal(P, S, R)
      const run = sy.runId ? await X.runRow(sy.runId) : null
      const pv0 = await LA.runCmsLockPreview(LD, P.id)
      const b0 = pv0.ok ? pv0.preview.blockers : [`ERR:${pv0.code}`]
      const a = sy.runId ? await K.cliAttest(P, sy.runId, S) : { ok: false, why: 'no run' }
      const ev = sy.runId ? await K.evalOf(P, sy.runId) : null
      const row = a.attId ? await X.one(`SELECT field_set fs, fp_version fv, tool_version tv, run_rows_fp fp, lines_compared::int n FROM public.cms_source_attestations WHERE id = $1`, [a.attId]) : null
      const dbFp = sy.runId ? await K.fps(sy.runId) : null
      const wantFp = c.fs === 'decision_unit14' ? dbFp?.u : dbFp?.d
      const pv1 = await LA.runCmsLockPreview(LD, P.id)
      const b1 = pv1.ok ? pv1.preview.blockers : [`ERR:${pv1.code}`]
      const lk = pv1.ok ? await LA.runCmsLock(LD, { programId: P.id, expectedRunId: sy.runId, expectedPolicyVersion: pv1.preview.policyVersion,
        expectedAttestationId: PV.cmsLockExpectedAttestation(pv1.preview), ackReason: `QA r2 chốt chương trình thật ${c.key}` }) : { ok: false }
      const pay = await X.one(`SELECT amount_vnd::text a, quantity_basis qb, returns_policy rp, source_complete_basis b, source_attestation_id::text att
        FROM public.cms_payouts WHERE program_id = $1`, [P.id])
      const wantMode = c.fs === 'decision_unit14' ? 'unit14' : 'decision10'
      const wantVer = c.fs === 'decision_unit14' ? ['cms-rows-fp-v2', 'cms-i4-compare-v2'] : ['cms-rows-fp-v1', 'cms-i4-compare-v1']
      ok(pol.ok && sy.status === 'published' && run?.amt === c.amount && b0.includes('CMS_LOCK_SOURCE_INCOMPLETE') && pv0.ok && pv0.preview.sourceCompleteBasis === null
        && a.ok && a.mode === wantMode && a.unitCols === true && a.pages >= 2 && a.compare.verdict === 'MATCH'
        && row?.fs === c.fs && row.fv === wantVer[0] && row.tv === wantVer[1] && row.fp === wantFp && /^[0-9a-f]{64}$/.test(wantFp ?? '') && row.n === S.length
        && ev?.code === null && ev.field_set === c.fs && pv1.ok && pv1.preview.sourceCompleteBasis === 'operator_reconciliation' && b1.length === 0
        && lk.ok && pay?.a === c.amount && pay.b === 'operator_reconciliation' && pay.att === a.attId && pay.rp === c.policy && pay.qb === (c.basis ?? 'pos_base'),
      `ca 1 [${c.key}]: chưa chứng nhận ⇒ SOURCE_INCOMPLETE; lõi CLI (trang 18 khoá → CSV ${wantMode === 'unit14' ? 18 : 14} cột → compare ${wantMode}) ⇒ ${c.fs} = vân tay DB; eval NULL ⇒ operator_reconciliation, 0 blocker; chốt RÒNG ${c.amount} gắn đúng chứng nhận`,
      JSON.stringify({ pol: pol.ok ? 'ok' : pol.err, sy: [sy.status, sy.code ?? null], run, b0, a: { ok: a.ok, why: a.why, mode: a.mode, pages: a.pages, verdict: a.compare?.verdict,
        di: a.compare?.dataIssues, reasons: a.built?.reasons, att: a.att?.ok ? 'ok' : a.att?.err }, row, ev, b1, lk, pay }))

      // Reader đóng băng (service_role) · parser payout super · XLSX.
      const fz = await settle(X.svc(`SELECT public.rpc_cms_frozen_sales_lines($1, NULL, 1000) r`, [P.id]))
      const fzv = fz.ok ? fz.v.rows[0].r : null
      const prRaw = await settle(L_AS(X, U.super, `SELECT public.rpc_cms_payout($1) r`, [P.id]))
      let dto = null, dtoErr = null
      try { dto = prRaw.ok ? PV.parseCmsPayout(prRaw.v.rows[0].r) : null } catch (e) { dtoErr = String(e.message) }
      const wb = dto ? EXP.buildCmsPayoutWorkbook({ program: { id: P.id, name: `Thật r2 ${c.key}`, startDate: P.start, endDate: P.end, status: 'locked', isTest: false },
        payout: dto, exportedAt: new Date(), scope: 'super' }) : { ok: false, error: dtoErr ?? (prRaw.ok ? 'dto' : prRaw.err) }
      const cells = wb.ok ? (() => { const w = XLSX.read(wb.bytes, { type: 'array' }); return w.SheetNames.map((n) => XLSX.utils.sheet_to_csv(w.Sheets[n])).join('\n') })() : ''
      ok(fz.ok && fzv?.payout_run_id === sy.runId && fzv.payout_amount_vnd === c.amount && fzv.contract?.returns_policy === c.policy && Array.isArray(fzv.rows) && fzv.rows.length > 0
        && dto?.super?.sourceAttestationId === a.attId && dto.super.sourceAttestation?.fieldSet === c.fs && dto.super.sourceAttestation.runRowsFp === wantFp
        && dto.contract?.quantityBasis === (c.basis ?? 'pos_base') && wb.ok && cells.includes(`Vân tay ${c.fs} của lần tính`) && cells.includes(wantFp),
      `ca 1 [${c.key}]: reader đóng băng (run / số chốt / policy) · parser payout super (chứng nhận ${c.fs} + vân tay) · XLSX ghi "Vân tay ${c.fs}"`,
      JSON.stringify({ fz: fz.ok ? { run: fzv?.payout_run_id === sy.runId, amt: fzv?.payout_amount_vnd, ct: fzv?.contract, n: fzv?.rows?.length } : fz.err,
        att: dto?.super?.sourceAttestation ?? dtoErr, wb: wb.ok ? 'ok' : wb.error }))
      done[c.key] = { P, S, R, runId: sy.runId, attId: a.attId, L: { P, runId: sy.runId } }
    }

    // ── Ca 1r (db-reviewer r2 P1-1 + P2-3): chương trình thật SALES-ONLY (131: revision chỉ khi sales_only_v1; có SP retire thì không đổi
    //    returns_policy được nữa).
    //    [pos] run LEGACY (sales_only + pos_base ⇒ syncLegacy; syncReal chỉ cấp provider contract): revision bỏ SP có dữ liệu ⇒ RETIRE →
    //      đồng bộ lại (nguồn BQ lọc SP hiệu lực ⇒ chỉ dòng a) → chứng nhận qua lõi CLI: phạm vi = SP hiệu lực = cms__program_scope_hash 131;
    //      dòng SP retire trong tham chiếu nằm ngoài phạm vi ⇒ decision10 MATCH → eval NULL → chốt. (Trước sửa: CLI ghim cả SP retire ⇒ MISMATCH.)
    //    [unit] 131 KHÔNG cho bỏ SP có dữ liệu ở cms_unit (CMS_REVISION_REMOVE_UNSUPPORTED) ⇒ không có SP retire; ca này chứng minh chương trình
    //      thật cms_unit + sales_only_v1 (run contract) chứng nhận decision_unit14 → chốt (db-reviewer r2 P2-3).
    //    Oracle tay (T1 100 đ / đơn vị CMS): pos K 1 chỉ a: 10 + 6 ⇒ 1.600; unit K 10 Hộp a + b: (E30 + E0 + E20) × 2 ⇒ Q10 ⇒ 1.000.
    for (const c of [{ key: 'pos', basis: null, k: '1', unit: 'hộp', sales: posSales, fs: 'decision10', amount: '1600', retire: true, sync: (P, S) => X.syncLegacy(P, S) },
      { key: 'unit', basis: 'cms_unit', k: '10', unit: 'Hộp', sales: unitSales, fs: 'decision_unit14', amount: '1000', retire: false, sync: (P, S) => K.syncReal(P, S, []) }]) {
      const pa = X.pid(), pb = X.pid()
      const P = await X.makeProgram({ name: `Thật r2 retire ${c.key}`, isTest: false, products: [{ pid: pa, k: c.k, unit: c.unit }, { pid: pb, k: c.k, unit: c.unit }],
        dates: [await X.day(-40), await X.day(-10)], ...(c.basis ? { v2: c.basis } : {}) })
      const SA = c.sales(P, pa), SB = c.sales(P, pb)
      const sy0 = await c.sync(P, [...SA, ...SB])
      const st0 = await X.prog(P.id)
      const prodA = { product_id: pa, gmv_basis: 'none', target_gmv: null, base_quantity_cms: c.k, tiers: T1(100), unit_cms: c.unit, advice_text: `Tư vấn QA ${pa}`,
        name_snapshot: `SP giả ${pa}`, image_url_snapshot: null, price_snapshot: null }
      const mfp = (await X.one(`SELECT public.cms__mapping_fp() m`)).m
      const revPv = await settle(L_AS(X, U.super, `SELECT public.rpc_cms_program_revision_preview($1::jsonb) r`, [JSON.stringify({ program_id: P.id,
        file_sha256: sha(`rev-132r2-${P.id}`), catalog_target: null, products: [prodA], expected_run_id: st0.ptr, source: { mapping_fp: mfp, rows_read: 0 },
        impact: { status: 'ok', from_config_version: st0.v, totals: { before_vnd: '0', after_vnd: '0', delta_vnd: '0', people_up: 0, people_down: 0, published_vnd: null,
          published_run_id: st0.ptr } } })]).then((x) => x.rows[0].r))
      const revCm = revPv.ok ? await settle(L_AS(X, U.super, `SELECT public.rpc_cms_program_revision_commit($1, $2, $3, $4, $5, $6::jsonb) r`, [revPv.v.revision_id,
        revPv.v.from_config_version, revPv.v.payload_digest, crypto.randomUUID(), 'QA r2 bỏ SP có dữ liệu trước khi chứng nhận',
        JSON.stringify({ whole_period: true, may_decrease: true, removed: [pb] })]).then((x) => x.rows[0].r)) : revPv
      const retired = await X.one(`SELECT retired_at IS NOT NULL r FROM public.cms_program_products WHERE program_id = $1 AND product_id = $2`, [P.id, pb])
      const sy1 = await c.sync(P, c.retire ? SA : [...SA, ...SB])
      const run = sy1.runId ? await X.runRow(sy1.runId) : null
      const a = sy1.runId ? await K.cliAttest(P, sy1.runId, [...SA, ...SB]) : { ok: false, why: 'no run' }
      const dbScope = (await X.one(`SELECT public.cms__program_scope_hash($1) h`, [P.id])).h
      const ev = sy1.runId ? await K.evalOf(P, sy1.runId) : null
      const pv = await LA.runCmsLockPreview(LD, P.id)
      const bl = pv.ok ? pv.preview.blockers : [`ERR:${pv.code}`]
      const lk = pv.ok ? await LA.runCmsLock(LD, { programId: P.id, expectedRunId: sy1.runId, expectedPolicyVersion: pv.preview.policyVersion,
        expectedAttestationId: PV.cmsLockExpectedAttestation(pv.preview), ackReason: `QA r2 chốt sau retire ${c.key}` }) : { ok: false }
      const pay = await X.one(`SELECT amount_vnd::text a, source_complete_basis b, source_attestation_id::text att FROM public.cms_payouts WHERE program_id = $1`, [P.id])
      const revOk = c.retire ? revCm.ok && revCm.v?.retired === 1 && revCm.v.deleted === 0 && retired?.r === true
        : !revCm.ok && code(revCm) === 'CMS_REVISION_REMOVE_UNSUPPORTED' && retired?.r === false
      const wantIds = c.retire ? [pa] : [pa, pb].sort()
      ok(sy0.status === 'published' && revOk && sy1.status === 'published' && run?.amt === c.amount
        && JSON.stringify(a.prog?.productIds) === JSON.stringify(wantIds) && a.ok && a.mode === (c.basis ? 'unit14' : 'decision10') && a.compare.verdict === 'MATCH'
        && a.compare.reference.outOfScope === (c.retire ? SB.length : 0) && a.built.payload.scope_hash === dbScope && ev?.code === null && ev.field_set === c.fs
        && pv.ok && pv.preview.sourceCompleteBasis === 'operator_reconciliation' && bl.length === 0 && lk.ok
        && pay?.a === c.amount && pay.b === 'operator_reconciliation' && pay.att === a.attId,
      c.retire ? `ca 1r [${c.key}]: sales-only thật (legacy), revision RETIRE SP có dữ liệu → đồng bộ lại → lõi CLI phạm vi = SP hiệu lực (= scope_hash DB 131; dòng SP retire của tham chiếu ngoài phạm vi) ⇒ ${c.fs} MATCH, eval NULL ⇒ chốt ${c.amount} gắn đúng chứng nhận`
        : `ca 1r [${c.key}]: cms_unit + sales_only_v1 thật: bỏ SP có dữ liệu ⇒ REMOVE_UNSUPPORTED (131, không có SP retire); run contract ⇒ ${c.fs} MATCH, eval NULL ⇒ chốt ${c.amount} gắn đúng chứng nhận`,
      JSON.stringify({ sy0: [sy0.status, sy0.code ?? null], rev: revCm.ok ? revCm.v : revCm.err, retired, sy1: [sy1.status, sy1.code ?? null], run,
        a: { ok: a.ok, why: a.why, mode: a.mode, ids: a.prog?.productIds, verdict: a.compare?.verdict, oos: a.compare?.reference?.outOfScope, di: a.compare?.dataIssues,
          reasons: a.built?.reasons, att: a.att?.ok ? 'ok' : a.att?.err, sh: a.built?.payload?.scope_hash === dbScope }, ev, bl, lk, pay }))
    }

    // ── Ca 2v (db-reviewer r2 P2-2): parity BYTE văn bản vân tay unit14 TS ↔ SQL với vector khó (điều khiển / CR LF / nháy / gạch chéo /
    //    U+0085 / BOM / ZWSP / NFD / U+2028 / emoji / số toàn chiều rộng / rỗng / OVERSIZE) trên lớp nguồn THẬT. Dòng vector là đơn ONLINE (không đủ
    //    điều kiện ⇒ chỉ ở lớp nguồn, không vào lớp bán / seal phân loại) nên run vẫn công bố; cms__run_unit_fp_text phải trùng TỪNG BYTE văn
    //    bản TS dựng từ ô tham chiếu (capture), và chuỗi CLI vẫn MATCH + eval NULL.
    {
      const VEC = ['2.0', '02', ' 2', '2 ', '\t2\t', '2\r\n', '2,5', '"2"', '1e2', '٢', '２', 'a\\b', 'Hộp', 'hộp', 'HỘP', 'Hộp​', '﻿Hộp',
        'Viên\u0085', 'Gói\u0007', '🧪', 'x,y', 'Hộp', 'Hộp ', '',
        // db-reviewer r2 vòng 2 N4: thô > CMS_SRC_MAX code point, làm sạch ≤ 50 ⇒ src NULL + cờ OVERSIZE qua stage CHECK 130 → seal N1(a) → xuất.
        '2' + ' '.repeat(70), ' '.repeat(70) + 'Hộp']
      const p = X.pid()
      const P = await X.makeProgram({ name: 'Thật r2 vector', isTest: false, products: [{ pid: p, k: '10', unit: 'Hộp' }], dates: [await X.day(-40), await X.day(-10)],
        v2: 'cms_unit' })
      const S = [...unitSales(P, p), ...VEC.map((v, i) => ({ ...X.srow(P, { pid: p, q: v, u: VEC[VEC.length - 1 - i], base: 1, min: 70 + i }), order_type: 'ONLINE' }))]
      const sy = await K.syncReal(P, S, [])
      const run = sy.runId ? await X.runRow(sy.runId) : null
      const dbText = sy.runId ? (await X.one(`SELECT public.cms__run_unit_fp_text($1) t`, [sy.runId])).t : null
      const pairs = S.map((r) => { const n = C.normalizeSalesRow(r); return n.ok ? [n.value, K.CI.cmsI4UnitSrcFromReference(r)] : null })
      const um = new Map(pairs.filter(Boolean))
      const tsText = K.CI.cmsI4UnitRowsFpText([...um.keys()], (l) => um.get(l))
      const firstDiff = dbText === null ? -1 : [...tsText].findIndex((ch, i) => ch !== [...dbText][i])
      const a = sy.runId ? await K.cliAttest(P, sy.runId, S) : { ok: false, why: 'no run' }
      const dbFp = sy.runId ? await K.fps(sy.runId) : null
      const ev = sy.runId ? await K.evalOf(P, sy.runId) : null
      const nOver = (tsText.match(/OVERSIZE/g) ?? []).length // q và u của 2 vector mới ⇒ 4 cờ
      ok(sy.status === 'published' && run?.amt === '500' && pairs.every(Boolean) && um.size === S.length && dbText !== null && dbText === tsText && nOver === 4
        && a.ok && a.mode === 'unit14' && a.compare.verdict === 'MATCH' && a.built.payload.run_rows_fp === dbFp?.u && ev?.code === null && ev.field_set === 'decision_unit14',
      `ca 2v: ${VEC.length} vector khó ở q / u (dòng ONLINE, lớp nguồn thật; 4 cờ OVERSIZE) ⇒ cms__run_unit_fp_text trùng TỪNG BYTE văn bản TS; CLI MATCH, vân tay = DB, eval NULL`,
      JSON.stringify({ sy: [sy.status, sy.code ?? null], run, n: [um.size, S.length], nOver, eq: dbText === tsText, lens: [tsText.length, dbText?.length ?? null], firstDiff,
        around: firstDiff >= 0 ? [[...tsText].slice(Math.max(0, firstDiff - 20), firstDiff + 20).join(''), [...(dbText ?? '')].slice(Math.max(0, firstDiff - 20), firstDiff + 20).join('')] : null,
        a: { ok: a.ok, why: a.why, mode: a.mode, verdict: a.compare?.verdict, di: a.compare?.dataIssues, cbf: a.compare?.compare?.changedByField, reasons: a.built?.reasons,
          att: a.att?.ok ? 'ok' : a.att?.err }, ev }))
    }

    // ── Ca 5: báo cáo sau chốt so với số RÒNG đóng băng — chương trình thật đã chứng nhận ──
    {
      const D = done.pos_full
      const same = H.late(D.P, D.S[0], { id: 'R2PF2', refund: '5000', min: 30 })
      const other = H.late(D.P, D.S[1], { id: 'R2PF3', refund: '1000', min: 31 })
      const x1 = await H.cron(D.L, H.payload(D.L, [D.R[0]], FULL))
      const x2 = await H.cron(D.L, H.payload(D.L, [D.R[0], same], FULL))
      const x3 = await H.cron(D.L, H.payload(D.L, [D.R[0], same, other], FULL))
      const x4 = await H.asSuper(D.L, H.payload(D.L, [D.R[0], same, other], FULL), 'Lập tay ngày 31 — chương trình thật đã chứng nhận (QA r2)', crypto.randomUUID())
      const h = []
      for (const x of [x1, x2, x3, x4]) h.push(x.report_id ? await H.head(x.report_id) : null)
      ok(h[0]?.f === '600' && h[0].rc === '600' && h[0].d === '0' && h[1]?.rc === '600' && h[1].d === '0' && h[2]?.rc === '0' && h[2].d === '-600'
        && h[3]?.cv === 'super' && h[3].d === '-600',
      'ca 5 [pos_full]: phát lại phiếu đã trừ trước chốt ⇒ Δ 0; phiếu mới CÙNG dòng ⇒ chỉ thêm hoàn, Δ 0; dòng KHÁC ⇒ E 0, Δ −600; ngày 31 lập tay (super) vẫn lập được',
      JSON.stringify([x1, x2, x3, x4, h]))
    }
    {
      const D = done.pos_net
      const x1 = await H.cron(D.L, H.payload(D.L, [D.R[0]], 'net_returns_v1'))
      const x2 = await H.cron(D.L, H.payload(D.L, [D.R[0], H.late(D.P, D.S[0], { id: 'R2PN2', bi: '2', refund: '20000', min: 30 })], 'net_returns_v1'))
      const h1 = x1.report_id ? await H.head(x1.report_id) : null
      const h2 = x2.report_id ? await H.head(x2.report_id) : null
      ok(h1?.f === '1300' && h1.d === '0' && h1.pr === 'net_returns_v1' && h2?.rc === '1100' && h2.d === '-200',
        'ca 5 [pos_net]: phát lại ⇒ Δ 0; BI 2 thêm cùng dòng ⇒ E 11 ⇒ 1.100, Δ −200', JSON.stringify([x1, x2, h1, h2]))
    }
    {
      const D = done.unit_full
      const u2 = H.late(D.P, D.S[1], { id: 'R2UF2', refund: '1000', min: 30 })
      const x1 = await H.cron(D.L, H.payload(D.L, [D.R[0]], FULL))
      const x2 = await H.cron(D.L, H.payload(D.L, [D.R[0], u2], FULL))
      const x3 = await H.cron(D.L, H.payload(D.L, [D.R[0], u2, H.late(D.P, D.S[0], { id: 'R2UF3', refund: '1000', min: 31 })], FULL))
      const h = []
      for (const x of [x1, x2, x3]) h.push(x.report_id ? await H.head(x.report_id) : null)
      ok(h[0]?.f === '500' && h[0].d === '0' && h[1]?.d === '0' && h[2]?.rc === '200' && h[2].d === '-300',
        'ca 5 [unit_full]: phát lại ⇒ Δ 0; phiếu mới trên dòng OTHER_UNIT (E 0) ⇒ Δ 0; dòng COUNTED c1 ⇒ Q2, Δ −300', JSON.stringify([x1, x2, x3, h]))
    }
    {
      const D = done.unit_net
      const x1 = await H.cron(D.L, H.payload(D.L, [], 'net_returns_v1'))
      const x2 = await H.cron(D.L, H.payload(D.L, [H.late(D.P, D.S[0], { id: 'R2UN1', bi: '30', refund: '300000', min: 30 })], 'net_returns_v1'))
      const h1 = x1.report_id ? await H.head(x1.report_id) : null
      const h2 = x2.report_id ? await H.head(x2.report_id) : null
      ok(h1?.f === '500' && h1.d === '0' && h2?.rc === '200' && h2.d === '-300',
        'ca 5 [unit_net]: 0 phiếu ⇒ Δ 0; trả đủ dòng COUNTED c1 (BI 30 = E30) ⇒ E 20 ⇒ Q2, Δ −300', JSON.stringify([x1, x2, h1, h2]))
    }

    // ── Ca 2: chỉ đổi q / u (B / G + decision10 giữ) ⇒ chứng nhận cũ bị từ chối ─────────────────────────────────────────────────────
    const pu = X.pid()
    const U2 = await X.makeProgram({ name: 'Thật r2 đổi q/u', isTest: false, v2: 'cms_unit', products: [{ pid: pu, k: '10', unit: 'Hộp' }], dates: [await X.day(-40), await X.day(-10)] })
    await X.setPolicy(U2, FULL, { cv: (await X.prog(U2.id)).v })
    const S2 = unitSales(U2, pu)
    const sy2 = await K.syncReal(U2, S2, [])
    const a2 = await K.cliAttest(U2, sy2.runId, S2)
    const ev2 = await K.evalOf(U2, sy2.runId)
    const f2 = await K.fps(sy2.runId)
    ok(sy2.status === 'published' && a2.ok && ev2.code === null && ev2.field_set === 'decision_unit14',
      'ca 2 nền: chương trình thật cms_unit chứng nhận decision_unit14 ⇒ eval NULL', JSON.stringify({ sy: sy2.status, a: a2.built?.reasons ?? a2.why ?? a2.att?.err, ev2 }))
    // 2a. Tham chiếu khác q / u (B / G giữ): compare unit14 ⇒ MISMATCH (không payload); ép decision10 ⇒ compare MATCH nhưng payload bị từ chối.
    for (const [why, o, f] of [['COUNTED→FRACTIONAL', { quantity_raw: '2.5' }, 'quantity_src'], ['COUNTED→OTHER_UNIT', { uom_raw: 'Viên' }, 'uom_src'],
      ['cùng lớp, chỉ khác chuỗi ("3.0")', { quantity_raw: '3.0' }, 'quantity_src']]) {
      const ref = [{ ...S2[0], ...o }, ...S2.slice(1)]
      const m = await K.cliAttest(U2, sy2.runId, ref, { send: false })
      const d = await K.cliAttest(U2, sy2.runId, ref, { send: false, mode: 'decision10' })
      ok(m.compare?.verdict === 'MISMATCH' && m.compare.compare.changedByField[f] === 1 && !m.built.ok
        && d.compare?.verdict === 'MATCH' && !d.built.ok && d.built.reasons.some((r) => /chế độ decision10/.test(r)),
      `ca 2a ${why}: lõi CLI unit14 bắt lệch ${f} (không payload); decision10 sẽ MATCH nhưng bị từ chối vì sai chế độ`,
      JSON.stringify({ m: [m.compare?.verdict, m.compare?.compare?.changedByField, m.built?.reasons], d: [d.compare?.verdict, d.built?.reasons] }))
    }
    // 2b. Payload decision10 (vân tay decision10 THẬT của run) gửi thẳng RPC cho run cms_unit ⇒ BASIS_MISMATCH, 0 ghi.
    const nAtt0 = (await X.one(`SELECT count(*)::int n FROM public.cms_source_attestations WHERE program_id = $1`, [U2.id])).n
    const p2b = { ...a2.built.payload, field_set: 'decision10', fp_version: 'cms-rows-fp-v1', tool_version: 'cms-i4-compare-v1', run_rows_fp: f2.d, reference_rows_fp: f2.d }
    const r2b = await K.sendRaw(U2, sy2.runId, p2b)
    const p2m = { ...a2.built.payload, fp_version: 'cms-rows-fp-v1' }
    const r2m = await K.sendRaw(U2, sy2.runId, p2m)
    const nAtt1 = (await X.one(`SELECT count(*)::int n FROM public.cms_source_attestations WHERE program_id = $1`, [U2.id])).n
    ok(code(r2b) === 'CMS_ATTEST_BASIS_MISMATCH' && code(r2m) === 'CMS_ATTEST_BAD_INPUT' && nAtt1 === nAtt0,
      'ca 2b / 3: RPC — bộ decision10 (vân tay decision10 đúng) trên run cms_unit ⇒ BASIS_MISMATCH; bộ trộn version ⇒ BAD_INPUT; 0 ghi', JSON.stringify([code(r2b), code(r2m), nAtt0, nAtt1]))
    // 2c. DB thử, owner ghi thẳng (trigger tắt, ROLLBACK): đổi thô q / u ở CẢ hai lớp (raw đi theo — B / G / decision10 giữ nguyên).
    //     N1(c) có luật B = q·K ⇒ COUNTED→FRACTIONAL với B giữ nguyên thành dòng phải TẠM GIỮ (UNIT_CLASS_HOLD) — vẫn là bị từ chối.
    const line0 = S2[0].order_line_id
    const both = (col, raw, v) => [[`UPDATE public.cms_sales_source_lines SET ${col} = $3, ${raw} = $3 WHERE run_id = $1 AND order_line_id = $2`, [sy2.runId, line0, v]],
      [`UPDATE public.cms_sales_lines SET ${col} = $3, ${raw} = $3 WHERE run_id = $1 AND order_line_id = $2`, [sy2.runId, line0, v]]]
    const probe = async () => ({ code: (await K.evalOf(U2, sy2.runId)).code, ...(await K.fps(sy2.runId)), b: await K.blockersOwner(U2, sy2.runId) })
    const T2 = [
      ['COUNTED→FRACTIONAL (q 2.5, B giữ)', both('quantity_src', 'quantity_raw', '2.5'), ['UNIT_CLASS_HOLD']],
      ['COUNTED→OTHER_UNIT (u Viên)', both('uom_src', 'uom_raw', 'Viên'), ['UNIT_CLASS']],
      ['cùng lớp COUNTED (q "3.0")', both('quantity_src', 'quantity_raw', '3.0'), ['FP_CHANGED']],
      ['cùng lớp COUNTED (u "hộp")', both('uom_src', 'uom_raw', 'hộp'), ['FP_CHANGED']],
      ['chỉ lớp bán đổi thô q (raw giữ)', [[`UPDATE public.cms_sales_lines SET quantity_src = '3.0' WHERE run_id = $1 AND order_line_id = $2`, [sy2.runId, line0]]], ['UNIT_SRC_ENGINE']],
      ['lớp nguồn: thô ≠ raw làm sạch', [[`UPDATE public.cms_sales_source_lines SET quantity_src = '3.0' WHERE run_id = $1 AND order_line_id = $2`, [sy2.runId, line0]]], ['UNIT_SRC_CLEAN']],
      ['chỉ lớp / E đã tính đổi (thô giữ)', [[`UPDATE public.cms_sales_lines SET quantity_class = 'FRACTIONAL_QUANTITY', eligible_base = 0 WHERE run_id = $1 AND order_line_id = $2`, [sy2.runId, line0]]], ['UNIT_CLASS']],
      // Gate G6 lượt c (20/11): kiểm src_v viết lại thành phép gộp ⇒ ca âm cho CẢ hai lớp (trước đây chưa có).
      //   Dòng "chưa capture" hợp lệ theo CHECK 130 cms_sales_*_src: src_v NULL kéo theo mọi thô / cờ (lớp bán: + lớp / E) NULL.
      ['lớp nguồn: một dòng chưa capture (src_v NULL)', [[`UPDATE public.cms_sales_source_lines SET src_v = NULL, quantity_src = NULL, uom_src = NULL, quantity_src_flag = NULL,
        uom_src_flag = NULL WHERE run_id = $1 AND order_line_id = $2`, [sy2.runId, line0]]], ['UNIT_SRC_V']],
      ['lớp bán: một dòng chưa capture (src_v NULL)', [[`UPDATE public.cms_sales_lines SET src_v = NULL, quantity_src = NULL, uom_src = NULL, quantity_src_flag = NULL,
        uom_src_flag = NULL, quantity_class = NULL, eligible_base = NULL WHERE run_id = $1 AND order_line_id = $2`, [sy2.runId, line0]]], ['UNIT_SRC_V']],
    ]
    for (const [why, stmts, want] of T2) {
      const t = await K.tamper(stmts, probe)
      ok(!t.err && want.includes(t.code) && t.d === f2.d && Array.isArray(t.b) && t.b.includes('CMS_LOCK_ATTEST_INVALID'),
        `ca 2c ${why}: vân tay decision10 KHÔNG đổi nhưng eval ⇒ ${want.join(' / ')} ⇒ preview ATTEST_INVALID`, JSON.stringify({ t, d0: f2.d }))
    }
    const evBack = await K.evalOf(U2, sy2.runId)
    ok(evBack.code === null, 'ca 2c: sau ROLLBACK chứng nhận dùng lại được (eval NULL)', JSON.stringify(evBack))
    // 2d. Đồng bộ lại với nguồn chỉ khác chuỗi q của c1 ("3.0", cùng lớp COUNTED, cùng B / G): run mới công bố; decision10 của hai run
    //     TRÙNG nhưng decision_unit14 khác ⇒ chứng nhận cũ không áp run mới (NONE); phát lại payload cũ lên run mới ⇒ FP_MISMATCH.
    const S2b = [{ ...S2[0], quantity_raw: '3.0' }, ...S2.slice(1)]
    const sy2b = await K.syncReal(U2, S2b, [])
    const f2b = sy2b.runId ? await K.fps(sy2b.runId) : null
    const ev2b = sy2b.runId ? await K.evalOf(U2, sy2b.runId) : null
    const pvb = await LA.runCmsLockPreview(LD, U2.id)
    const now2 = await K.dbNow()
    const replay = sy2b.runId ? await K.sendRaw(U2, sy2b.runId, { ...a2.built.payload, run_exported_at: now2, reference_exported_at: now2 }) : { ok: false, err: 'no run' }
    ok(sy2b.status === 'published' && f2b?.d === f2.d && f2b.u !== f2.u && ev2b?.code === 'NONE' && pvb.ok && pvb.preview.blockers.includes('CMS_LOCK_SOURCE_INCOMPLETE')
      && code(replay) === 'CMS_ATTEST_FP_MISMATCH',
    'ca 2d: run mới chỉ khác chuỗi q (decision10 trùng, decision_unit14 khác) ⇒ chứng nhận run cũ không áp (NONE ⇒ SOURCE_INCOMPLETE); payload cũ lên run mới ⇒ FP_MISMATCH',
    JSON.stringify({ sy: sy2b.status, d: [f2.d === f2b?.d, f2.u === f2b?.u], ev2b, b: pvb.ok ? pvb.preview.blockers : pvb, replay: code(replay) }))

    // ── Ca 3: bị chặn ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
    // Chứng nhận đúng cho run mới rồi đo từng điều kiện chặn.
    const a3 = await K.cliAttest(U2, sy2b.runId, S2b)
    const ev3 = await K.evalOf(U2, sy2b.runId)
    ok(a3.ok && ev3.code === null, 'ca 3 nền: chứng nhận lại run mới (decision_unit14) ⇒ eval NULL', JSON.stringify({ a: a3.built?.reasons ?? a3.att?.err, ev3 }))
    const probe3 = async () => ({ code: (await K.evalOf(U2, sy2b.runId)).code, b: await K.blockersOwner(U2, sy2b.runId) })
    const T3 = [
      ['sai version (bộ trộn v2 / v1 trên dòng)', [[`ALTER TABLE public.cms_source_attestations DISABLE TRIGGER USER`, []], [`UPDATE public.cms_source_attestations SET fp_version = 'cms-rows-fp-v1' WHERE id = $1`, [a3.attId]]], 'ERR:cms_source_attest_version'],
      ['sai cách tính (bộ decision10 hợp lệ trên run cms_unit)', [[`ALTER TABLE public.cms_source_attestations DISABLE TRIGGER USER`, []], [`UPDATE public.cms_source_attestations SET field_set = 'decision10', fp_version = 'cms-rows-fp-v1', tool_version = 'cms-i4-compare-v1' WHERE id = $1`, [a3.attId]]], 'FIELD_SET_BASIS'],
      ['cấu hình đổi', [[`UPDATE public.cms_programs SET config_version = config_version + 1 WHERE id = $1`, [U2.id]]], 'STALE_CONFIG'],
      ['mapping đổi', [[`UPDATE public.users SET email = email || '.x' WHERE id = $1`, [U.mkt]]], 'STALE_MAPPING'],
      ['phạm vi đổi', [[`UPDATE public.cms_programs SET end_date = end_date - 1 WHERE id = $1`, [U2.id]]], 'STALE_SCOPE'],
      ['mốc dữ liệu trước hết kỳ (hết hạn)', [[`ALTER TABLE public.cms_source_attestations DISABLE TRIGGER USER`, []], [`UPDATE public.cms_source_attestations SET as_of = as_of - interval '400 days' WHERE id = $1`, [a3.attId]]], 'AS_OF'],
      ['số dòng đối soát lệch', [[`ALTER TABLE public.cms_source_attestations DISABLE TRIGGER USER`, []], [`UPDATE public.cms_source_attestations SET lines_compared = lines_compared + 1 WHERE id = $1`, [a3.attId]]], 'COUNT'],
      ['vân tay ghi lệch', [[`ALTER TABLE public.cms_source_attestations DISABLE TRIGGER USER`, []], [`UPDATE public.cms_source_attestations SET run_rows_fp = $2, reference_rows_fp = $2 WHERE id = $1`, [a3.attId, 'f'.repeat(64)]]], 'FP_CHANGED'],
    ]
    for (const [why, stmts, want] of T3) {
      const t = await K.tamper(stmts, probe3)
      const okk = want.startsWith('ERR:') ? String(t.err ?? '').includes(want.slice(4)) : (!t.err && t.code === want && t.b.includes('CMS_LOCK_ATTEST_INVALID'))
      ok(okk, `ca 3 ${why} ⇒ ${want.startsWith('ERR:') ? `CHECK ${want.slice(4)} chặn ghi` : `eval ${want} ⇒ ATTEST_INVALID`}`, JSON.stringify(t))
    }
    // Quyền: admin thường / SM / không phiên ⇒ không xuất / không chứng nhận / không thu hồi; 0 ghi.
    const nA = async () => (await X.one(`SELECT count(*)::int n FROM public.cms_source_attestations WHERE program_id = $1`, [U2.id])).n
    const n30 = await nA()
    const exMkt = await K.exportRun(U2, sy2b.runId, U.mkt)
    const exSm = await K.exportRun(U2, sy2b.runId, U.sm)
    const atMkt = await K.sendRaw(U2, sy2b.runId, a3.built.payload, U.mkt)
    const atAnon = await settle(L_AS(X, null, `SELECT public.rpc_cms_source_attest($1, $2, $3::jsonb, $4) r`, [U2.id, sy2b.runId, JSON.stringify(a3.built.payload), crypto.randomUUID()], 'anon'))
    const rvMkt = await settle(L_AS(X, U.mkt, `SELECT public.rpc_cms_source_attest_revoke($1, $2, $3) r`, [a3.attId, 'QA thử thu hồi không quyền', crypto.randomUUID()]))
    ok(!exMkt.ok && !exSm.ok && !atMkt.ok && !atAnon.ok && !rvMkt.ok && (await nA()) === n30 && (await K.evalOf(U2, sy2b.runId)).code === null,
      'ca 3 quyền: admin thường / SM không xuất được; admin / anon không chứng nhận; admin không thu hồi; 0 ghi, chứng nhận còn hiệu lực',
      JSON.stringify([exMkt.code, exSm.code, code(atMkt), code(atAnon), code(rvMkt)]))
    // Thay thế (supersede) + phát lại khoá idem: chứng nhận lại cùng run ⇒ id mới, cũ superseded; cùng khoá ⇒ already (không bản kép);
    // chốt với id CŨ (preview cũ) ⇒ từ chối, 0 payout.
    const pvOld = await LA.runCmsLockPreview(LD, U2.id)
    const idem = crypto.randomUUID()
    const a3b = await K.cliAttest(U2, sy2b.runId, S2b, { idem })
    const a3c = await K.sendRaw(U2, sy2b.runId, a3b.built.payload, U.super, idem)
    const sup = await X.one(`SELECT (SELECT superseded_by::text FROM public.cms_source_attestations WHERE id = $1) s,
      (SELECT count(*)::int FROM public.cms_source_attestations WHERE program_id = $2 AND run_id = $3 AND revoked_at IS NULL AND superseded_by IS NULL) live`, [a3.attId, U2.id, sy2b.runId])
    const lkOld = pvOld.ok ? await LA.runCmsLock(LD, { programId: U2.id, expectedRunId: sy2b.runId, expectedPolicyVersion: pvOld.preview.policyVersion,
      expectedAttestationId: PV.cmsLockExpectedAttestation(pvOld.preview), ackReason: 'QA r2 chốt bằng chứng nhận đã bị thay' }) : { ok: false }
    const nPay0 = (await X.one(`SELECT count(*)::int n FROM public.cms_payouts WHERE program_id = $1`, [U2.id])).n
    ok(a3b.ok && a3b.attId !== a3.attId && sup.s === a3b.attId && sup.live === 1 && a3c.ok && a3c.v.already === true && a3c.v.id === a3b.attId
      && PV.cmsLockExpectedAttestation(pvOld.preview) === a3.attId && !lkOld.ok && nPay0 === 0,
    'ca 3 thay thế: chứng nhận lại ⇒ id mới, bản cũ superseded (1 bản sống); phát lại cùng khoá idem ⇒ already, không bản kép; chốt bằng id cũ ⇒ từ chối, 0 payout',
    JSON.stringify({ a3b: a3b.attId === a3.attId, sup, a3c: a3c.ok ? a3c.v : a3c.err, exp: PV.cmsLockExpectedAttestation(pvOld.preview) === a3.attId, lkOld, nPay0 }))
    // Thu hồi (super) ⇒ eval NONE ⇒ SOURCE_INCOMPLETE; phát lại cùng khoá ⇒ already.
    const ridem = crypto.randomUUID()
    const rv = await settle(L_AS(X, U.super, `SELECT public.rpc_cms_source_attest_revoke($1, $2, $3) r`, [a3b.attId, 'QA r2 thu hồi chứng nhận decision_unit14', ridem]).then((x) => x.rows[0].r))
    const rv2 = await settle(L_AS(X, U.super, `SELECT public.rpc_cms_source_attest_revoke($1, $2, $3) r`, [a3b.attId, 'QA r2 thu hồi chứng nhận decision_unit14', ridem]).then((x) => x.rows[0].r))
    const evR = await K.evalOf(U2, sy2b.runId)
    const pvR = await LA.runCmsLockPreview(LD, U2.id)
    ok(rv.ok && rv.v.revoked === true && rv2.ok && rv2.v.already === true && evR.code === 'NONE' && pvR.ok && pvR.preview.blockers.includes('CMS_LOCK_SOURCE_INCOMPLETE')
      && pvR.preview.sourceCompleteBasis === null,
    'ca 3 thu hồi: super thu hồi ⇒ eval NONE ⇒ SOURCE_INCOMPLETE, basis NULL; phát lại cùng khoá ⇒ already', JSON.stringify({ rv: rv.ok ? rv.v : rv.err, rv2: rv2.ok ? rv2.v : rv2.err, evR, b: pvR.ok ? pvR.preview.blockers : pvR }))
    // Chứng nhận lại sau thu hồi ⇒ chốt được (đường hồi phục).
    const a3d = await K.cliAttest(U2, sy2b.runId, S2b)
    const pvD = await LA.runCmsLockPreview(LD, U2.id)
    const lkD = pvD.ok ? await LA.runCmsLock(LD, { programId: U2.id, expectedRunId: sy2b.runId, expectedPolicyVersion: pvD.preview.policyVersion,
      expectedAttestationId: PV.cmsLockExpectedAttestation(pvD.preview), ackReason: 'QA r2 chốt sau chứng nhận lại' }) : { ok: false }
    const payD = await X.one(`SELECT amount_vnd::text a, source_attestation_id::text att FROM public.cms_payouts WHERE program_id = $1`, [U2.id])
    ok(a3d.ok && lkD.ok && payD?.att === a3d.attId && payD.a === '500', 'ca 3: chứng nhận lại sau thu hồi ⇒ chốt được (500, gắn chứng nhận mới)', JSON.stringify({ lkD, payD }))
    // Chứng nhận bộ decision_unit14 cho run pos_base ⇒ BASIS_MISMATCH (chiều ngược).
    const pp = X.pid()
    const P3 = await X.makeProgram({ name: 'Thật r2 pos_base sai bộ', isTest: false, products: [{ pid: pp, k: '1' }], dates: [await X.day(-40), await X.day(-10)] })
    await X.setPolicy(P3, FULL, { cv: (await X.prog(P3.id)).v })
    const S3 = [X.srow(P3, { pid: pp, base: 4, min: 60 })]
    const sy3 = await K.syncReal(P3, S3, [])
    const b3 = await K.cliAttest(P3, sy3.runId, S3, { send: false })
    const f3 = sy3.runId ? await K.fps(sy3.runId) : null
    const r3u = b3.built?.ok ? await K.sendRaw(P3, sy3.runId, { ...b3.built.payload, field_set: 'decision_unit14', fp_version: 'cms-rows-fp-v2', tool_version: 'cms-i4-compare-v2',
      run_rows_fp: f3.u, reference_rows_fp: f3.u }) : { ok: false, err: 'no payload' }
    const u3 = await K.cliAttest(P3, sy3.runId, S3, { send: false, mode: 'unit14' })
    ok(b3.built?.ok && b3.mode === 'decision10' && code(r3u) === 'CMS_ATTEST_BASIS_MISMATCH' && !u3.built.ok,
      'ca 3 chiều ngược: run pos_base — RPC từ chối bộ decision_unit14 (BASIS_MISMATCH); lõi CLI ép unit14 ⇒ không payload',
      JSON.stringify({ b3: b3.built?.reasons, r3u: code(r3u), u3: u3.built?.reasons }))

    // VERIFY V-124 của cms-verify (e2e/cmsQaTooling.ts) trên DB 132 r2: 5 payout chốt bằng chứng nhận (2 decision10 + 3 decision_unit14)
    // — bộ trường theo cách tính của run chốt ⇒ 0 lệch (bản 124 coi mọi field_set ≠ decision10 là lệch ⇒ sẽ báo đỏ oan 3).
    const QT = await lib('e2e/cmsQaTooling.ts')
    const ia = await X.one(QT.CMS_VERIFY_SQL.invAttest)
    const nUnitPay = (await X.one(`SELECT count(*)::int n FROM public.cms_payouts p JOIN public.cms_source_attestations a ON a.id = p.source_attestation_id
      WHERE a.field_set = 'decision_unit14'`)).n
    // 20/11: + ca 1r [pos] (decision10) + ca 1r [unit] (decision_unit14) ⇒ 7 payout (4 decision_unit14).
    ok(ia?.n === 7 && ia.bad === 0 && nUnitPay === 4, 'VERIFY V-124 (cms-verify) trên DB 132 r2: 7 payout chốt bằng chứng nhận (4 decision_unit14) ⇒ 0 lệch',
      JSON.stringify({ ia, nUnitPay }))

    // db-reviewer r2 vòng 2 N5 / N2: V9b + V0c chạy NGUYÊN VĂN trên DB đã có chứng nhận thật (decision10 + decision_unit14, live / thu hồi /
    // thay thế): đường gọi cms__attest_eval trong VERIFY chạy với dữ liệu; mọi chứng nhận còn hiệu lực trên run cms_unit là decision_unit14.
    const vsql = (tag) => { const ls = SQL_132.slice(SQL_132.indexOf(`\n-- ${tag} `) + 1).split('\n'); const b = []
      for (const l of ls.slice(1)) { if (!l.startsWith('--   ')) break; b.push(l.slice(5)) } return b.join('\n') }
    const v9bd = await settle(X.all(vsql('V9b'))), v0cd = await settle(X.all(vsql('V0c')))
    const noMix = (rows) => !rows.some((r) => r.qb === 'cms_unit' && r.fs !== 'decision_unit14') && !rows.some((r) => r.qb === 'pos_base' && r.fs !== 'decision10')
    ok(v9bd.ok && v0cd.ok && v9bd.v.some((r) => r.qb === 'cms_unit' && r.fs === 'decision_unit14') && v9bd.v.some((r) => r.fs === 'decision10')
      && noMix(v9bd.v) && v0cd.v.some((r) => r.qb === 'cms_unit') && noMix(v0cd.v),
    'VERIFY V9b / V0c (r2) chạy nguyên văn trên dữ liệu thật của §8d: eval chạy được; không chứng nhận còn hiệu lực nào trộn bộ ↔ cách tính (cms_unit chỉ decision_unit14)',
    JSON.stringify({ v9b: v9bd.ok ? v9bd.v : v9bd.err, v0c: v0cd.ok ? v0cd.v : v0cd.err }))
  } finally {
    await X.db.exec(polOrig)
  }
  await realAttestRollbackCase()
}

/**
 * Rollback 132 với chứng nhận có version (DB riêng; chỉ chương trình THẬT net — run contract v1 — chưa chốt; không full_line / chốt
 * contract): (1) chỉ decision10 ⇒ rollback gỡ được, 3 CHECK 124 khôi phục, dòng chứng nhận giữ nguyên, áp lại 132 được; (2) có
 * decision_unit14 ⇒ rollback DỪNG đúng điều kiện đó, 0 thay đổi.
 */
async function realAttestRollbackCase() {
  const X = await env('ctrb')
  ok(X.applied.ok, 'DB rollback r2: áp 132', X.applied.err)
  const K = await realKit(X)
  const polOrig = (await X.one(`SELECT pg_get_functiondef('public.cms__lock_policy()'::regprocedure) d`)).d
  await X.db.exec(K.fakePolicy)
  try {
    const pp = X.pid()
    const P = await X.makeProgram({ name: 'Thật r2 rollback pos net', isTest: false, products: [{ pid: pp, k: '1' }], dates: [await X.day(-40), await X.day(-10)] })
    await X.setPolicy(P, 'net_returns_v1', { cv: (await X.prog(P.id)).v })
    const S = [X.srow(P, { pid: pp, base: 4, min: 60 })]
    const sy = await K.syncReal(P, S, [])
    const a = await K.cliAttest(P, sy.runId, S)
    await X.db.exec(polOrig)
    const rb1 = await execTx(X.db, RB_132)
    const chk = await X.all(`SELECT conname n FROM pg_constraint WHERE conrelid = 'public.cms_source_attestations'::regclass AND contype = 'c'
      AND conname IN ('cms_source_attestations_fp_version_check', 'cms_source_attestations_field_set_check', 'cms_source_attestations_tool_version_check', 'cms_source_attest_version') ORDER BY 1`)
    const kept = await X.one(`SELECT count(*)::int n FROM public.cms_source_attestations WHERE id = $1 AND field_set = 'decision10'`, [a.attId])
    const re = await execTx(X.db, SQL_132)
    ok(sy.status === 'published' && a.ok && a.mode === 'decision10' && rb1.ok && chk.map((x) => x.n).join(',') === 'cms_source_attestations_field_set_check,cms_source_attestations_fp_version_check,cms_source_attestations_tool_version_check'
      && kept.n === 1 && re.ok,
    'rollback r2: chỉ có chứng nhận decision10 (run net v1) ⇒ gỡ 132 được, 3 CHECK 124 khôi phục, dòng chứng nhận giữ; áp lại 132 được',
    JSON.stringify({ sy: sy.status, a: a.built?.reasons ?? a.att?.err, rb1: rb1.ok || String(rb1.err).slice(0, 160), chk, kept, re: re.ok || String(re.err).slice(0, 160) }))
    await X.db.exec(K.fakePolicy)
    const pu = X.pid()
    const PU = await X.makeProgram({ name: 'Thật r2 rollback unit net', isTest: false, v2: 'cms_unit', products: [{ pid: pu, k: '10', unit: 'Hộp' }], dates: [await X.day(-40), await X.day(-10)] })
    await X.setPolicy(PU, 'net_returns_v1', { cv: (await X.prog(PU.id)).v })
    const SU = unitSalesOf(X)(PU, pu)
    const syU = await K.syncReal(PU, SU, [])
    const aU = await K.cliAttest(PU, syU.runId, SU)
    await X.db.exec(polOrig)
    const md5a = (await X.one(`SELECT md5(string_agg(md5(prosrc), '' ORDER BY oid)) m FROM pg_proc WHERE pronamespace = 'public'::regnamespace`)).m
    const rb2 = await execTx(X.db, RB_132)
    const md5b = (await X.one(`SELECT md5(string_agg(md5(prosrc), '' ORDER BY oid)) m FROM pg_proc WHERE pronamespace = 'public'::regnamespace`)).m
    const nU = (await X.one(`SELECT count(*)::int n FROM public.cms_source_attestations WHERE field_set = 'decision_unit14'`)).n
    ok(syU.status === 'published' && aU.ok && aU.mode === 'unit14' && !rb2.ok && /decision_unit14/.test(String(rb2.err)) && md5a === md5b && nU === 1,
      'rollback r2: đã có chứng nhận decision_unit14 (không full_line / chốt) ⇒ rollback DỪNG đúng điều kiện decision_unit14, 0 thay đổi',
      JSON.stringify({ syU: syU.status, aU: aU.built?.reasons ?? aU.att?.err, rb2: String(rb2.err ?? '').slice(0, 160), same: md5a === md5b, nU }))
  } finally {
    await X.db.exec(polOrig)
  }
}

/** Gọi SQL dưới vai trò (mặc định authenticated) với JWT sub = uid (null ⇒ không phiên). */
function L_AS(X, uid, sql, params = [], role = 'authenticated') { return L.as(X.db, uid, () => X.db.query(sql, params), role) }

function lockDepsOf(X) {
  return {
    lockEnabled: () => true, qaReadonly: () => false, access: async () => ({ kind: 'ok', actorId: U.super, qa: true }),
    program: async (id) => { const r = await X.one(`SELECT is_test FROM public.cms_programs WHERE id = $1`, [id]); return r ? { isTest: r.is_test } : null },
    rpc: async (fn, args) => {
      const named = Object.keys(args).map((k, i) => `${k} => $${i + 1}`).join(', ')
      try { return { data: (await X.svc(`SELECT public.${fn}(${named}) r`, Object.values(args))).rows[0].r, error: null } } catch (e) { return { data: null, error: { code: e.code, message: e.message } } }
    },
  }
}
/** Chương trình QA legacy (sales-only) trong quá khứ, đồng bộ legacy + CHỐT bằng lockAction thật. */
async function lockedProgram(X, name, specs) {
  const prods = [...new Set(specs.map((x) => x.p))].map((p) => ({ pid: p, k: '1' }))
  const P = await X.makeProgram({ name, products: prods, dates: [await X.day(-40), await X.day(-10)] })
  const S = specs.map((x, i) => X.srow(P, { pid: x.p, s: x.s ?? 0, base: x.base, min: x.min ?? (60 + i) }))
  const sy = await X.syncLegacy(P, S)
  const LD = lockDepsOf(X)
  const pv = await LA.runCmsLockPreview(LD, P.id)
  const lk = pv.ok ? await LA.runCmsLock(LD, { programId: P.id, expectedRunId: sy.runId, expectedPolicyVersion: pv.preview.policyVersion, ackReason: 'QA giả chốt thử Q-236' }) : { ok: false }
  return { P, S, runId: sy.runId, ok: sy.status === 'published' && lk.ok, diag: { sy: sy.status, code: sy.code ?? null, pv: pv.ok ? pv.preview.blockers : pv, lk } }
}
const RUN_OPEN = `SELECT public.rpc_cms_sales_run_open($1, $2::jsonb) r`
const OPEN_V2 = JSON.stringify({ source: 'qa', calc_contract: 'cms-calc-ret2-v1', calc_contracts: ['cms-calc-ret2-v1', 'cms-calc-ret2-v2'] })

async function raceSection() {
  section('12. Hai phiên (PG15)')
  const X = await env('race')
  ok(X.applied.ok, 'DB race: áp 132', X.applied.err)
  const Bc = await pgConn(X.dbName)
  const asB = async (role, sql, params, uid = '') => {
    await Bc.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [uid ?? ''])
    await Bc.query(`SET ROLE ${role}`)
    try { return (await Bc.query(sql, params)).rows[0].r } catch (e) { return { err: /\bCMS_[A-Z0-9_]+\b/.exec(String(e.message))?.[0] ?? String(e.message).slice(0, 120) } } finally {
      await Bc.query('RESET ROLE'); await Bc.query(`SELECT set_config('request.jwt.claim.sub', '', false)`)
    }
  }
  const SETP = `SELECT public.rpc_cms_program_set_returns_policy($1, $2, $3, $4) r`
  // (a) A đổi policy giữ khoá; B mở run ⇒ chờ; sau COMMIT run ghim policy MỚI (full_line, hợp đồng v2) — không run v1 dưới chương trình full_line.
  const pa = X.pid()
  const PA = await X.makeProgram({ name: 'QA race policy × open', products: [{ pid: pa, k: '10' }] })
  const vA = (await X.prog(PA.id)).v
  await X.db.query('BEGIN')
  await X.db.query('SET LOCAL ROLE service_role')
  const ra = (await X.db.query(SETP, [PA.id, FULL, vA, U.super])).rows[0].r
  let bDone = false
  const bp = asB('service_role', RUN_OPEN, [PA.id, OPEN_V2]).then((x) => { bDone = true; return x })
  await sleep(600)
  const waited = !bDone
  await X.db.query('COMMIT')
  const rb = await bp
  const runA = rb?.run_id ? await X.runRow(rb.run_id) : null
  ok(ra.returns_policy === FULL && waited && runA?.pol === FULL && runA.cc === 'cms-calc-ret2-v2' && runA.sdv === 'cms-return-status-v2',
    'A đổi policy giữ khoá; B mở run CHỜ rồi ghim policy mới (full_line / v2 / status-v2)', JSON.stringify({ ra, waited, rb: rb?.err ?? rb?.run_id, runA }))
  // (b) A mở run giữ khoá; B đổi policy ⇒ chờ rồi CMS_SYNC_RUN_BUSY; policy giữ.
  const pb = X.pid()
  const PB = await X.makeProgram({ name: 'QA race open × policy', products: [{ pid: pb, k: '10' }] })
  const vB = (await X.prog(PB.id)).v
  await X.db.query('BEGIN')
  await X.db.query('SET LOCAL ROLE service_role')
  await X.db.query(RUN_OPEN, [PB.id, OPEN_V2])
  let cDone = false
  const cp = asB('service_role', SETP, [PB.id, FULL, vB, U.super]).then((x) => { cDone = true; return x })
  await sleep(600)
  const w2 = !cDone
  await X.db.query('COMMIT')
  const rc = await cp
  ok(w2 && rc?.err === 'CMS_SYNC_RUN_BUSY' && (await X.prog(PB.id)).pol === 'sales_only_v1',
    'mở run giữ khoá; đổi policy CHỜ rồi CMS_SYNC_RUN_BUSY, policy giữ sales_only (không đổi policy dưới run đang tính)', JSON.stringify({ w2, rc }))
  await X.db.query(`UPDATE public.cms_sync_runs SET status = 'error', finished_at = now(), error_code = 'QA_STOP' WHERE program_id = $1 AND status = 'running'`, [PB.id])
  // (c) Báo cáo full_line cùng snapshot hai phiên ⇒ một ghi + một already (cùng report_id).
  const pc = X.pid()
  const LC = await lockedProgram(X, 'QA race báo cáo cùng snapshot', [{ p: pc, base: 20 }, { p: pc, s: 1, base: 5 }])
  const endMs = Date.parse(`${LC.P.end}T05:00:00Z`)
  const rr = (sale, id, min) => ({ ...X.rrow(LC.P, sale, { id, min: 0 }), return_recorded_at: new Date(endMs + min * 60000).toISOString(), source_updated_at: null })
  const PROG = (P) => ({ startDate: P.start, endDate: P.end, productIds: P.products.map((x) => x.pid) })
  const recs = (raws, profile) => raws.map((r) => { const n = RT.normalizeReturnRow(r, profile); if (!n.ok) throw new Error('phiếu race lỗi'); return n.value })
  const asOf = BigInt(Date.now() - 60_000) * BigInt(1000)
  const SAVE = `SELECT public.rpc_cms_return_close_report_save($1, $2, $3::jsonb) r`
  const pl = CR.buildCmsCloseReportPayload(PROG(LC.P), recs([rr(LC.S[0], 'RC1', 1), rr(LC.S[0], 'RC2', 2)], FULL), { provider: 'fixture', snapshotId: 'qa-race', asOfMicros: asOf, profile: FULL })
  const SUPER = `SELECT public.rpc_cms_return_close_report_save_super($1, $2, $3::jsonb, $4, $5) r`
  const pin = await settle(L_AS(X, U.super, SUPER, [LC.P.id, LC.runId, JSON.stringify(CR.buildCmsCloseReportPayload(PROG(LC.P), recs([rr(LC.S[0], 'RC1', 1)], FULL),
    { provider: 'fixture', snapshotId: 'qa-race-pin', asOfMicros: asOf - BigInt(1000), profile: FULL })), 'QA ghim profile trước khi đua', crypto.randomUUID()]))
  if (!pin.ok || pin.v.rows[0].r.saved !== true) console.log('  · ghim profile (c) lỗi: ' + JSON.stringify(pin.ok ? pin.v.rows[0].r : pin.err))
  const [x1, x2] = await Promise.all([settle(X.svc(SAVE, [LC.P.id, LC.runId, JSON.stringify(pl)]).then((r) => r.rows[0].r)), asB('service_role', SAVE, [LC.P.id, LC.runId, JSON.stringify(pl)])])
  const xs = [x1.ok ? x1.v : { err: code(x1) }, x2]
  ok(LC.ok && xs.filter((x) => x?.saved === true && x.already === false).length === 1 && xs.filter((x) => x?.saved === true && x.already === true).length === 1
    && xs[0].report_id === xs[1].report_id, 'báo cáo full_line cùng snapshot song song (sau khi super ghim profile) ⇒ đúng một ghi + một already (cùng report_id)', JSON.stringify(xs))
  // (d) Sổ rỗng: báo cáo v1 × full_line song song ⇒ đúng một ghi; phiên còn lại CMS_REPORT_PROFILE_LEDGER_MISMATCH (sổ một version / chương trình).
  const pd = X.pid()
  const LD2 = await lockedProgram(X, 'QA race báo cáo v1 × full_line', [{ p: pd, base: 20 }])
  const rr2 = (id) => ({ ...X.rrow(LD2.P, LD2.S[0], { id, min: 0, bi: '2' }), return_recorded_at: new Date(Date.parse(`${LD2.P.end}T05:00:00Z`) + 60000).toISOString(), source_updated_at: null })
  const plF = CR.buildCmsCloseReportPayload(PROG(LD2.P), recs([rr2('RD1')], FULL), { provider: 'fixture', snapshotId: 'qa-race-f', asOfMicros: asOf, profile: FULL })
  const plV = CR.buildCmsCloseReportPayload(PROG(LD2.P), recs([rr2('RD1')], 'net_returns_v1'), { provider: 'fixture', snapshotId: 'qa-race-v', asOfMicros: asOf + BigInt(1) })
  const [y1, y2] = await Promise.all([
    settle(L_AS(X, U.super, SUPER, [LD2.P.id, LD2.runId, JSON.stringify(plF), 'QA đua chọn profile full_line', crypto.randomUUID()]).then((r) => r.rows[0].r)),
    asB('authenticated', SUPER, [LD2.P.id, LD2.runId, JSON.stringify(plV), 'QA đua chọn profile net v1', crypto.randomUUID()], U.super)])
  const ys = [y1.ok ? y1.v : { err: code(y1) }, y2]
  const fpv = await X.all(`SELECT DISTINCT fp_version v FROM public.cms_return_baselines WHERE program_id = $1`, [LD2.P.id])
  ok(LD2.ok && ys.filter((x) => x?.saved === true).length === 1 && ys.filter((x) => x?.err === 'CMS_REPORT_PROFILE_LEDGER_MISMATCH').length === 1 && fpv.length === 1,
    'sổ rỗng: hai phiên super chọn v1 × full_line song song ⇒ đúng một ghi, phiên kia LEDGER_MISMATCH; sổ chỉ một fp_version', JSON.stringify({ ys, fpv }))
  await raceContractSection(X, Bc, asB)
  await raceAttestSection(X, Bc)
}

// ── §12b (PG15, r1 — PM r0 §5 bước 4): chốt run contract × publish run mới · chốt × báo cáo phiên super ───────────────────────────
async function raceContractSection(X, Bc, asB) {
  const LD = lockDepsOf(X)
  const LOCK = `SELECT public.rpc_cms_program_lock($1, $2, $3, $4, $5, NULL) r`
  const ended = async (name, pid, extra = {}) => {
    const P = await X.makeProgram({ name, products: [{ pid, k: '1', ...extra }], dates: [await X.day(-40), await X.day(-10)] })
    await X.setPolicy(P, FULL, { cv: (await X.prog(P.id)).v })
    return P
  }
  // (e) B giữ khoá chương trình bằng lần CHỐT run 1; A publish run 2 (đã seal) ⇒ CHỜ rồi held PROGRAM_LOCKED; pointer / payout = run 1.
  const pe = X.pid()
  const PE = await ended('QA race chốt contract × publish', pe)
  const eS = [X.srow(PE, { pid: pe, base: 10, min: 60 })]
  const e1 = await X.run(PE, eS, [])
  const pvE = await LA.runCmsLockPreview(LD, PE.id)
  let release = null, reached = null
  const gate = new Promise((res) => { release = res })
  const atPub = new Promise((res) => { reached = res })
  const d2 = X.deps(CF.createCmsContractFixtureProvider({ sales: [...eS, X.srow(PE, { pid: pe, base: 5, min: 61 })], returns: [] }))
  const pub0 = d2.publish
  d2.publish = async (runId) => { reached(runId); await gate; return pub0(runId) }
  const e2p = settle(SS.runCmsSalesSync(d2, PE.id, { dryRun: false, source: 'qa', sourceCapture: true, chunkSize: 3, calcFlags: ON }))
  const run2 = await Promise.race([atPub, sleep(60_000).then(() => null)])
  await Bc.query('BEGIN')
  await Bc.query('SET LOCAL ROLE service_role')
  const lkE = await settle(Bc.query(LOCK, [PE.id, e1.runId, pvE.ok ? pvE.preview.policyVersion : -1, U.super, 'QA race chốt × publish']).then((x) => x.rows[0].r))
  let pDone = false
  release()
  const e2w = e2p.then((x) => { pDone = true; return x })
  await sleep(600)
  const waitedE = !pDone
  await Bc.query(lkE.ok ? 'COMMIT' : 'ROLLBACK')
  const e2 = await e2w
  const pE = await X.prog(PE.id)
  const r2row = run2 ? await X.runRow(run2) : null
  const payE = await X.one(`SELECT run_id::text r, amount_vnd::text a, calc_contract_version cc FROM public.cms_payouts WHERE program_id = $1`, [PE.id])
  ok(e1.status === 'published' && run2 && lkE.ok && waitedE && pE.status === 'locked' && pE.ptr === e1.runId && r2row?.status === 'held'
    && r2row.error_code === 'PROGRAM_LOCKED' && payE?.r === e1.runId && payE.a === '1000' && payE.cc === 'cms-calc-ret2-v2',
  'B chốt run contract 1 giữ khoá; A publish run 2 CHỜ rồi held PROGRAM_LOCKED; pointer + payout = run 1 (1.000, v2)',
  JSON.stringify({ e1: e1.status, run2: !!run2, lk: lkE.ok ? lkE.v.ok : lkE.err, waitedE, prog: pE, r2row: r2row && [r2row.status, r2row.error_code], payE, e2: e2.ok ? e2.v.status : e2.err }))
  // (f) B giữ khoá bằng lần CHỐT; A lập báo cáo phiên super ⇒ CHỜ rồi thấy chương trình đã chốt ⇒ lưu, số đóng băng = payout, phát lại Δ 0.
  const pf = X.pid()
  const PF = await ended('QA race chốt contract × báo cáo', pf)
  const fS = [X.srow(PF, { pid: pf, base: 10, gmv: '100000', min: 60 })]
  const fR = [X.rrow(PF, fS[0], { id: 'RF1', refund: '10000', min: 300 })]
  const f1 = await X.run(PF, fS, fR)
  const pvF = await LA.runCmsLockPreview(LD, PF.id)
  await Bc.query('BEGIN')
  await Bc.query('SET LOCAL ROLE service_role')
  const lkF = await settle(Bc.query(LOCK, [PF.id, f1.runId, pvF.ok ? pvF.preview.policyVersion : -1, U.super, 'QA race chốt × báo cáo']).then((x) => x.rows[0].r))
  const recs = (raws) => raws.map((x) => { const n = RT.normalizeReturnRow(x, FULL); if (!n.ok) throw new Error('phiếu race f lỗi'); return n.value })
  const plF = CR.buildCmsCloseReportPayload({ startDate: PF.start, endDate: PF.end, productIds: [pf] }, recs(fR),
    { provider: 'fixture', snapshotId: 'qa-race-lock-report', asOfMicros: BigInt(Date.now()) * BigInt(1000), profile: FULL })
  let fDone = false
  const fp = settle(L_AS(X, U.super, `SELECT public.rpc_cms_return_close_report_save_super($1, $2, $3::jsonb, $4, $5) r`,
    [PF.id, f1.runId, JSON.stringify(plF), 'QA đua chốt × báo cáo ngày 31', crypto.randomUUID()]).then((x) => x.rows[0].r)).then((x) => { fDone = true; return x })
  await sleep(600)
  const waitedF = !fDone
  await Bc.query(lkF.ok ? 'COMMIT' : 'ROLLBACK')
  const rf = await fp
  const hF = rf.ok && rf.v.report_id ? await X.one(`SELECT frozen_amount::text f, delta_amount::text d FROM public.cms_return_close_reports WHERE id = $1`, [rf.v.report_id]) : null
  const payF = await X.one(`SELECT amount_vnd::text a FROM public.cms_payouts WHERE program_id = $1`, [PF.id])
  ok(f1.status === 'published' && lkF.ok && waitedF && rf.ok && rf.v.saved === true && hF?.f === payF?.a && hF.d === '0',
    'B chốt run contract giữ khoá; A lập báo cáo phiên super CHỜ rồi lưu trên hợp đồng vừa chốt (đóng băng = payout, phát lại phiếu đã trừ Δ 0)',
    JSON.stringify({ f1: f1.status, lk: lkF.ok ? lkF.v.ok : lkF.err, waitedF, rf: rf.ok ? rf.v : rf.err, hF, payF }))
}

// ── §12c (PG15, r2 — PM 19/11 §4.2 ca 4): chứng nhận / preview / chốt chen với publish / revision / thu hồi; phát lại không tạo bản kép ──
// Chương trình THẬT (policy giả lập ready + operator_reconciliation CHỈ trong DB thử). Phiên B (Bc) giữ giao dịch; phiên A (X.db) chen vào.
async function raceAttestSection(X, Bc) {
  const LD = lockDepsOf(X)
  const K = await realKit(X)
  const PV = await lib('lib/cms/payoutView.ts')
  const polOrig = (await X.one(`SELECT pg_get_functiondef('public.cms__lock_policy()'::regprocedure) d`)).d
  await X.db.exec(K.fakePolicy)
  /** B: BEGIN + jwt + vai, chạy MỘT câu và GIỮ giao dịch (người gọi COMMIT / ROLLBACK). */
  const bTx = async (uid, role, sql, params) => {
    await Bc.query('BEGIN')
    await Bc.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [uid ?? ''])
    await Bc.query(`SET LOCAL ROLE ${role}`)
    return settle(Bc.query(sql, params).then((x) => x.rows[0].r))
  }
  /** policy null ⇒ giữ sales_only_v1 (revision 131 chỉ hỗ trợ policy này — CMS_REVISION_NET_UNSUPPORTED). */
  // r2 (db-reviewer r2 P2-3): basis 'cms_unit' ⇒ chương trình cms_unit (chứng nhận decision_unit14) — ca (m) / (n).
  const real = async (name, products, policy = FULL, basis = null) => {
    const p = X.pid(), p2 = X.pid()
    const P = await X.makeProgram({ name, isTest: false, products: products ? products(p, p2) : [{ pid: p, k: '1' }], dates: [await X.day(-40), await X.day(-10)],
      ...(basis ? { v2: basis } : {}) })
    if (policy) await X.setPolicy(P, policy, { cv: (await X.prog(P.id)).v })
    return { P, p, p2 }
  }
  const ATTEST = `SELECT public.rpc_cms_source_attest($1, $2, $3::jsonb, $4) r`
  const REVOKE = `SELECT public.rpc_cms_source_attest_revoke($1, $2, $3) r`
  const LOCKQ = `SELECT public.rpc_cms_program_lock($1, $2, $3, $4, $5, $6) r`
  const nPay = async (P) => (await X.one(`SELECT count(*)::int n FROM public.cms_payouts WHERE program_id = $1`, [P.id])).n
  try {
    // (g) B chứng nhận run 1 giữ khoá; A publish run 2 ⇒ CHỜ rồi công bố; chứng nhận run 1 không áp run 2 (NONE ⇒ SOURCE_INCOMPLETE).
    {
      const { P, p } = await real('QA race chứng nhận × publish')
      const S = [X.srow(P, { pid: p, base: 10, min: 60 })]
      const s1 = await K.syncReal(P, S, [])
      const b1 = await K.cliAttest(P, s1.runId, S, { send: false })
      let release = null, reached = null
      const gate = new Promise((res) => { release = res })
      const atPub = new Promise((res) => { reached = res })
      const fx = CF.createCmsContractFixtureProvider({ sales: [...S, X.srow(P, { pid: p, base: 5, min: 61 })], returns: [] })
      const d2 = X.deps({ kind: 'bq', read: async (scope) => { const r = await fx.read(scope); return r.ok ? { ...r, provider: 'bq' } : r } })
      const pub0 = d2.publish
      d2.publish = async (runId) => { reached(runId); await gate; return pub0(runId) }
      const s2p = settle(SS.runCmsSalesSync(d2, P.id, { dryRun: false, source: 'cron', sourceCapture: true, chunkSize: 3, calcFlags: ON }))
      const run2 = await Promise.race([atPub, sleep(60_000).then(() => null)])
      const at = b1.built?.ok ? await bTx(U.super, 'authenticated', ATTEST, [P.id, s1.runId, JSON.stringify(b1.built.payload), crypto.randomUUID()]) : { ok: false, err: 'no payload' }
      let pDone = false
      release()
      const s2w = s2p.then((x) => { pDone = true; return x })
      await sleep(600)
      const waited = !pDone
      await Bc.query(at.ok ? 'COMMIT' : 'ROLLBACK')
      const s2 = await s2w
      const pg = await X.prog(P.id)
      const ev2 = run2 ? await K.evalOf(P, run2) : null
      const pv = await LA.runCmsLockPreview(LD, P.id)
      ok(s1.status === 'published' && b1.built?.ok && at.ok && at.v.attested === true && run2 && waited && s2.ok && s2.v.status === 'published' && pg.ptr === run2
        && ev2?.code === 'NONE' && pv.ok && pv.preview.blockers.includes('CMS_LOCK_SOURCE_INCOMPLETE'),
      'ca 4 (g): B chứng nhận run 1 giữ khoá; A publish run 2 CHỜ rồi công bố; chứng nhận run 1 không áp run 2 (NONE ⇒ SOURCE_INCOMPLETE)',
      JSON.stringify({ s1: s1.status, at: at.ok ? at.v : at.err, run2: !!run2, waited, s2: s2.ok ? s2.v.status : s2.err, ptr: pg.ptr === run2, ev2,
        b: pv.ok ? pv.preview.blockers : pv }))
    }
    // (h) A publish run 2 giữ khoá (B phiên service_role); A' chứng nhận run 1 ⇒ CHỜ rồi CMS_ATTEST_RUN_NOT_CURRENT, 0 ghi.
    {
      const { P, p } = await real('QA race publish × chứng nhận')
      const S = [X.srow(P, { pid: p, base: 10, min: 60 })]
      const s1 = await K.syncReal(P, S, [])
      const b1 = await K.cliAttest(P, s1.runId, S, { send: false })
      let release = null, reached = null
      const gate = new Promise((res) => { release = res })
      const atPub = new Promise((res) => { reached = res })
      const fx = CF.createCmsContractFixtureProvider({ sales: [...S, X.srow(P, { pid: p, base: 5, min: 61 })], returns: [] })
      const d2 = X.deps({ kind: 'bq', read: async (scope) => { const r = await fx.read(scope); return r.ok ? { ...r, provider: 'bq' } : r } })
      // publish của run 2 chạy ở phiên B (giữ giao dịch) thay cho phiên A — worker nhận đúng kết quả RPC sau COMMIT.
      d2.publish = async (runId) => { reached(runId); await gate; return d2.__pub }
      const s2p = settle(SS.runCmsSalesSync(d2, P.id, { dryRun: false, source: 'cron', sourceCapture: true, chunkSize: 3, calcFlags: ON }))
      const run2 = await Promise.race([atPub, sleep(60_000).then(() => null)])
      const pb = run2 ? await bTx(null, 'service_role', `SELECT public.rpc_cms_sales_run_publish($1) r`, [run2]) : { ok: false, err: 'no run2' }
      let aDone = false
      const ap = b1.built?.ok ? K.sendRaw(P, s1.runId, b1.built.payload).then((x) => { aDone = true; return x }) : Promise.resolve({ ok: false, err: 'no payload' })
      await sleep(600)
      const waited = !aDone
      await Bc.query(pb.ok ? 'COMMIT' : 'ROLLBACK')
      const ar = await ap
      d2.__pub = pb.ok ? pb.v : null
      release()
      const s2 = await s2p
      const n = (await X.one(`SELECT count(*)::int n FROM public.cms_source_attestations WHERE program_id = $1`, [P.id])).n
      const pg = await X.prog(P.id)
      ok(s1.status === 'published' && pb.ok && waited && code(ar) === 'CMS_ATTEST_RUN_NOT_CURRENT' && n === 0 && pg.ptr === run2,
        'ca 4 (h): B publish run 2 giữ khoá; A chứng nhận run 1 CHỜ rồi CMS_ATTEST_RUN_NOT_CURRENT, 0 ghi; pointer = run 2',
        JSON.stringify({ pb: pb.ok ? 'ok' : pb.err, waited, ar: code(ar), n, ptr: pg.ptr === run2, s2: s2.ok ? s2.v.status : s2.err }))
    }
    // (i) Phát lại đồng thời: A và B gửi CÙNG khoá idem + payload ⇒ B ghi (giữ khoá); A CHỜ rồi already, cùng id — 1 bản.
    {
      const { P, p } = await real('QA race phát lại chứng nhận')
      const S = [X.srow(P, { pid: p, base: 7, min: 60 })]
      const s1 = await K.syncReal(P, S, [])
      const b1 = await K.cliAttest(P, s1.runId, S, { send: false })
      const idem = crypto.randomUUID()
      const bt = await bTx(U.super, 'authenticated', ATTEST, [P.id, s1.runId, JSON.stringify(b1.built.payload), idem])
      let aDone = false
      const ap = K.sendRaw(P, s1.runId, b1.built.payload, U.super, idem).then((x) => { aDone = true; return x })
      await sleep(600)
      const waited = !aDone
      await Bc.query(bt.ok ? 'COMMIT' : 'ROLLBACK')
      const ar = await ap
      const rows = await X.all(`SELECT id::text FROM public.cms_source_attestations WHERE program_id = $1`, [P.id])
      ok(bt.ok && bt.v.attested === true && waited && ar.ok && ar.v.already === true && ar.v.id === bt.v.id && rows.length === 1,
        'ca 4 (i): hai phiên cùng khoá idem ⇒ một ghi, phiên kia CHỜ rồi already cùng id (1 bản)', JSON.stringify({ bt: bt.ok ? bt.v : bt.err, waited, ar: ar.ok ? ar.v : ar.err, n: rows.length }))
    }
    // (j) Preview thấy chứng nhận; B thu hồi (giữ khoá) ⇒ A chốt bằng id preview CHỜ rồi bị từ chối; 0 payout.
    {
      const { P, p } = await real('QA race chốt × thu hồi')
      const S = [X.srow(P, { pid: p, base: 9, min: 60 })]
      const s1 = await K.syncReal(P, S, [])
      const a1 = await K.cliAttest(P, s1.runId, S)
      const pv = await LA.runCmsLockPreview(LD, P.id)
      const exp = pv.ok ? PV.cmsLockExpectedAttestation(pv.preview) : null
      const rv = await bTx(U.super, 'authenticated', REVOKE, [a1.attId, 'QA race thu hồi trong lúc chốt', crypto.randomUUID()])
      let aDone = false
      const ap = LA.runCmsLock(LD, { programId: P.id, expectedRunId: s1.runId, expectedPolicyVersion: pv.ok ? pv.preview.policyVersion : -1, expectedAttestationId: exp,
        ackReason: 'QA race chốt trong lúc thu hồi' }).then((x) => { aDone = true; return x })
      await sleep(600)
      const waited = !aDone
      await Bc.query(rv.ok ? 'COMMIT' : 'ROLLBACK')
      const lk = await ap
      const pg = await X.prog(P.id)
      // db-reviewer r2 vòng 2 N3: đúng mã do chứng nhận đã thu hồi (eval NONE ⇒ SOURCE_INCOMPLETE), không phải BUSY / lock_timeout / lý do khác.
      ok(a1.ok && exp === a1.attId && rv.ok && rv.v.revoked === true && waited && !lk.ok && lk.code === 'CMS_LOCK_SOURCE_INCOMPLETE' && (await nPay(P)) === 0 && pg.status !== 'locked',
        'ca 4 (j): preview thấy chứng nhận; B thu hồi giữ khoá; A chốt bằng id đó CHỜ rồi CMS_LOCK_SOURCE_INCOMPLETE — 0 payout, chương trình chưa chốt',
        JSON.stringify({ a1: a1.ok, exp: exp === a1.attId, rv: rv.ok ? rv.v : rv.err, waited, lk, st: pg.status }))
    }
    // (k) B CHỐT (giữ khoá); A thu hồi chứng nhận đang dùng ⇒ CHỜ rồi CMS_PROGRAM_LOCKED; payout giữ đúng chứng nhận.
    {
      const { P, p } = await real('QA race thu hồi × chốt')
      const S = [X.srow(P, { pid: p, base: 8, min: 60 })]
      const s1 = await K.syncReal(P, S, [])
      const a1 = await K.cliAttest(P, s1.runId, S)
      const pv = await LA.runCmsLockPreview(LD, P.id)
      const lb = await bTx(null, 'service_role', LOCKQ, [P.id, s1.runId, pv.ok ? pv.preview.policyVersion : -1, U.super, 'QA race chốt giữ khoá', a1.attId])
      let aDone = false
      const ap = settle(L_AS(X, U.super, REVOKE, [a1.attId, 'QA race thu hồi sau chốt', crypto.randomUUID()]).then((x) => x.rows[0].r)).then((x) => { aDone = true; return x })
      await sleep(600)
      const waited = !aDone
      await Bc.query(lb.ok ? 'COMMIT' : 'ROLLBACK')
      const ar = await ap
      const pay = await X.one(`SELECT source_attestation_id::text att, source_complete_basis b FROM public.cms_payouts WHERE program_id = $1`, [P.id])
      const live = await X.one(`SELECT revoked_at IS NULL l FROM public.cms_source_attestations WHERE id = $1`, [a1.attId])
      ok(a1.ok && lb.ok && waited && code(ar) === 'CMS_PROGRAM_LOCKED' && pay?.att === a1.attId && pay.b === 'operator_reconciliation' && live.l === true,
        'ca 4 (k): B chốt giữ khoá; A thu hồi CHỜ rồi CMS_PROGRAM_LOCKED; payout giữ đúng chứng nhận (không thu hồi được sau chốt)',
        JSON.stringify({ lb: lb.ok ? 'ok' : lb.err, waited, ar: code(ar), pay, live }))
    }
    // (m) / (n) r2 (db-reviewer r2 P2-3): như (j) / (k) trên chương trình cms_unit — chứng nhận decision_unit14 qua lõi CLI (18 cột / unit14).
    const unitReal = (name) => real(name, (p) => [{ pid: p, k: '10', unit: 'Hộp' }], FULL, 'cms_unit')
    const fsOf = async (id) => (id ? (await X.one(`SELECT field_set fs FROM public.cms_source_attestations WHERE id = $1`, [id])).fs : null)
    {
      const { P, p } = await unitReal('QA race chốt × thu hồi (unit14)')
      const S = unitSalesOf(X)(P, p)
      const s1 = await K.syncReal(P, S, [])
      const a1 = await K.cliAttest(P, s1.runId, S)
      const fs1 = await fsOf(a1.attId)
      const pv = await LA.runCmsLockPreview(LD, P.id)
      const exp = pv.ok ? PV.cmsLockExpectedAttestation(pv.preview) : null
      const rv = await bTx(U.super, 'authenticated', REVOKE, [a1.attId, 'QA race thu hồi trong lúc chốt (unit14)', crypto.randomUUID()])
      let aDone = false
      const ap = LA.runCmsLock(LD, { programId: P.id, expectedRunId: s1.runId, expectedPolicyVersion: pv.ok ? pv.preview.policyVersion : -1, expectedAttestationId: exp,
        ackReason: 'QA race chốt trong lúc thu hồi (unit14)' }).then((x) => { aDone = true; return x })
      await sleep(600)
      const waited = !aDone
      await Bc.query(rv.ok ? 'COMMIT' : 'ROLLBACK')
      const lk = await ap
      const pg = await X.prog(P.id)
      ok(s1.status === 'published' && a1.ok && a1.mode === 'unit14' && fs1 === 'decision_unit14' && exp === a1.attId && rv.ok && rv.v.revoked === true && waited && !lk.ok
        && lk.code === 'CMS_LOCK_SOURCE_INCOMPLETE' && (await nPay(P)) === 0 && pg.status !== 'locked',
        'ca 4 (m): cms_unit — preview thấy chứng nhận decision_unit14; B thu hồi giữ khoá; A chốt bằng id đó CHỜ rồi CMS_LOCK_SOURCE_INCOMPLETE — 0 payout, chưa chốt',
        JSON.stringify({ s1: s1.status, a1: { ok: a1.ok, why: a1.why, mode: a1.mode }, fs1, exp: exp === a1.attId, rv: rv.ok ? rv.v : rv.err, waited, lk, st: pg.status }))
    }
    {
      const { P, p } = await unitReal('QA race thu hồi × chốt (unit14)')
      const S = unitSalesOf(X)(P, p)
      const s1 = await K.syncReal(P, S, [])
      const a1 = await K.cliAttest(P, s1.runId, S)
      const fs1 = await fsOf(a1.attId)
      const pv = await LA.runCmsLockPreview(LD, P.id)
      const lb = await bTx(null, 'service_role', LOCKQ, [P.id, s1.runId, pv.ok ? pv.preview.policyVersion : -1, U.super, 'QA race chốt giữ khoá (unit14)', a1.attId])
      let aDone = false
      const ap = settle(L_AS(X, U.super, REVOKE, [a1.attId, 'QA race thu hồi sau chốt (unit14)', crypto.randomUUID()]).then((x) => x.rows[0].r)).then((x) => { aDone = true; return x })
      await sleep(600)
      const waited = !aDone
      await Bc.query(lb.ok ? 'COMMIT' : 'ROLLBACK')
      const ar = await ap
      const pay = await X.one(`SELECT source_attestation_id::text att, source_complete_basis b, amount_vnd::text a FROM public.cms_payouts WHERE program_id = $1`, [P.id])
      const live = await X.one(`SELECT revoked_at IS NULL l FROM public.cms_source_attestations WHERE id = $1`, [a1.attId])
      ok(a1.ok && fs1 === 'decision_unit14' && lb.ok && waited && code(ar) === 'CMS_PROGRAM_LOCKED' && pay?.att === a1.attId && pay.b === 'operator_reconciliation'
        && pay.a === '500' && live.l === true,
        'ca 4 (n): cms_unit — B chốt giữ khoá bằng chứng nhận decision_unit14; A thu hồi CHỜ rồi CMS_PROGRAM_LOCKED; payout 500 giữ đúng chứng nhận',
        JSON.stringify({ a1: { ok: a1.ok, why: a1.why }, fs1, lb: lb.ok ? 'ok' : lb.err, waited, ar: code(ar), pay, live }))
    }
    // (l) Revision 131 × chứng nhận / chốt. 131 chặn revision khi chương trình ĐÃ có chứng nhận (kể cả đã thu hồi — CMS_REVISION_ATTESTED) hoặc
    // payout, và chỉ cho sales_only_v1 ⇒ race thực tế là chứng nhận × revision, hai chiều (cả hai khoá cms_programs FOR UPDATE):
    //   (l1) B commit revision (bỏ SP) giữ khoá; A gửi chứng nhận dựng TRƯỚC revision ⇒ CHỜ rồi bị từ chối, 0 ghi; chốt bằng preview cũ ⇒ từ chối, 0 payout.
    //   (l2) B chứng nhận giữ khoá; A commit revision (preview trước chứng nhận) ⇒ CHỜ rồi CMS_REVISION_ATTESTED; cấu hình giữ, chứng nhận vẫn hợp lệ.
    const revPreview = async (P, keep) => {
      const st0 = await X.prog(P.id)
      const prodA = { product_id: keep, gmv_basis: 'none', target_gmv: null, base_quantity_cms: '1', tiers: T1(100), unit_cms: 'hộp', advice_text: `Tư vấn QA ${keep}`,
        name_snapshot: `SP giả ${keep}`, image_url_snapshot: null, price_snapshot: null }
      const mfp = (await X.one(`SELECT public.cms__mapping_fp() m`)).m
      return settle(L_AS(X, U.super, `SELECT public.rpc_cms_program_revision_preview($1::jsonb) r`, [JSON.stringify({ program_id: P.id,
        file_sha256: sha(`rev-132r2-${P.id}`), catalog_target: null, products: [prodA], expected_run_id: st0.ptr, source: { mapping_fp: mfp, rows_read: 0 },
        impact: { status: 'ok', from_config_version: st0.v, totals: { before_vnd: '0', after_vnd: '0', delta_vnd: '0', people_up: 0, people_down: 0, published_vnd: null,
          published_run_id: st0.ptr } } })]).then((x) => x.rows[0].r))
    }
    const REV_COMMIT = `SELECT public.rpc_cms_program_revision_commit($1, $2, $3, $4, $5, $6::jsonb) r`
    const revArgs = (rv, drop) => [rv.revision_id, rv.from_config_version, rv.payload_digest, crypto.randomUUID(), 'QA race revision × chứng nhận (132 r2)',
      JSON.stringify({ whole_period: true, may_decrease: true, removed: [drop] })]
    const nAtt = async (P) => (await X.one(`SELECT count(*)::int n FROM public.cms_source_attestations WHERE program_id = $1`, [P.id])).n
    // sales_only ⇒ run LEGACY (runner legacy) — syncReal chỉ cấp provider contract nên run legacy ra 0 dòng.
    {
      const { P, p, p2 } = await real('QA race revision × chứng nhận', (a, b) => [{ pid: a, k: '1' }, { pid: b, k: '1' }], null)
      const S = [X.srow(P, { pid: p, base: 6, min: 60 }), X.srow(P, { pid: p2, base: 3, min: 61 })]
      const s1 = await X.syncLegacy(P, S)
      const b1 = await K.cliAttest(P, s1.runId, S, { send: false })
      const pv = await LA.runCmsLockPreview(LD, P.id)
      const st0 = await X.prog(P.id)
      const rp = await revPreview(P, p)
      const rc = rp.ok ? await bTx(U.super, 'authenticated', REV_COMMIT, revArgs(rp.v, p2)) : rp
      let aDone = false
      const ap = K.sendRaw(P, s1.runId, b1.built?.payload ?? {}).then((x) => { aDone = true; return x })
      await sleep(600)
      const waited = !aDone
      if (rp.ok) await Bc.query(rc.ok ? 'COMMIT' : 'ROLLBACK')
      const ar = await ap
      const n = await nAtt(P)
      const lk = await LA.runCmsLock(LD, { programId: P.id, expectedRunId: s1.runId, expectedPolicyVersion: pv.ok ? pv.preview.policyVersion : -1,
        expectedAttestationId: null, ackReason: 'QA chốt bằng preview trước revision' })
      const st1 = await X.prog(P.id)
      ok(s1.status === 'published' && b1.built?.ok && rp.ok && rc.ok && waited && !ar.ok && /^CMS_ATTEST_/.test(code(ar)) && n === 0 && st1.v > st0.v
        && !lk.ok && (await nPay(P)) === 0 && st1.status !== 'locked',
        `ca 4 (l1): B commit revision (bỏ SP) giữ khoá; A chứng nhận dựng trước revision CHỜ rồi ${code(ar)}, 0 ghi; chốt bằng preview cũ bị từ chối — 0 payout`,
        JSON.stringify({ s1: [s1.status, s1.code ?? null], b1: b1.built?.ok || b1.built?.reasons, rp: rp.ok ? 'ok' : rp.err, rc: rc.ok ? 'ok' : rc.err, waited,
          ar: ar.ok ? ar.v : code(ar), n, v: [st0.v, st1.v], lk }))
    }
    {
      const { P, p, p2 } = await real('QA race chứng nhận × revision', (a, b) => [{ pid: a, k: '1' }, { pid: b, k: '1' }], null)
      const S = [X.srow(P, { pid: p, base: 6, min: 60 }), X.srow(P, { pid: p2, base: 3, min: 61 })]
      const s1 = await X.syncLegacy(P, S)
      const b1 = await K.cliAttest(P, s1.runId, S, { send: false })
      const st0 = await X.prog(P.id)
      const rp = await revPreview(P, p)
      const bt = b1.built?.ok ? await bTx(U.super, 'authenticated', ATTEST, [P.id, s1.runId, JSON.stringify(b1.built.payload), crypto.randomUUID()]) : { ok: false, err: 'no payload' }
      let aDone = false
      const ap = rp.ok ? settle(L_AS(X, U.super, REV_COMMIT, revArgs(rp.v, p2)).then((x) => x.rows[0].r)).then((x) => { aDone = true; return x }) : Promise.resolve(rp)
      await sleep(600)
      const waited = !aDone
      await Bc.query(bt.ok ? 'COMMIT' : 'ROLLBACK')
      const ar = await ap
      const st1 = await X.prog(P.id)
      const ev = await K.evalOf(P, s1.runId)
      ok(s1.status === 'published' && rp.ok && bt.ok && bt.v.attested === true && waited && code(ar) === 'CMS_REVISION_ATTESTED' && st1.v === st0.v
        && (await nAtt(P)) === 1 && ev.code === null,
        'ca 4 (l2): B chứng nhận giữ khoá; A commit revision (preview trước chứng nhận) CHỜ rồi CMS_REVISION_ATTESTED; cấu hình giữ, chứng nhận vẫn hợp lệ',
        JSON.stringify({ s1: [s1.status, s1.code ?? null], rp: rp.ok ? 'ok' : rp.err, bt: bt.ok ? bt.v.attested : bt.err, waited, ar: ar.ok ? ar.v : code(ar),
          v: [st0.v, st1.v], ev: ev.code }))
    }
  } finally {
    await X.db.exec(polOrig)
  }
}

// ── §13b (r2 — PM 19/11 §5 bước 4–5): bench chương trình THẬT — 2 cách tính × net / full_line ──────────────────────────────────────
// Mỗi tổ hợp: sync N_SALES dòng (provider 'bq' đứng thay) → chứng nhận qua lõi CLI THẬT (xuất trang 5.000 bằng phiên super → CSV → compare
// TÍNH LẠI → RPC chứng nhận) → preview → chốt (lockAction) → báo cáo sau chốt ở trần (N_REP = 10.000: s0 phát lại phiếu trước chốt Δ 0,
// s1 cron đủ trần, s2 super, s3 phát lại) → payout super. Lời gọi chứng nhận / preview / chốt / báo cáo / reader chạy dưới
// statement_timeout 8 s (như vai PostgREST prod); timeout ⇒ hậu kiểm 0 ghi (atomic) rồi ĐỎ. Mọi lời gọi < 8 s.
async function benchRealCombo(X, basis, policy, N_SALES, N_REP, opts = {}) {
  const K = await realKit(X)
  const polOrig = (await X.one(`SELECT pg_get_functiondef('public.cms__lock_policy()'::regprocedure) d`)).d
  await X.db.exec(K.fakePolicy)
  const tag = `${basis}/${policy === FULL ? 'full' : 'net'}${opts.stale ? ' thống kê cũ' : ''}`
  let sh = null
  try {
    const NP = 20
    const products = Array.from({ length: NP }, () => (basis === 'cms_unit' ? { pid: X.pid(), k: '10', unit: 'Hộp' } : { pid: X.pid(), k: '1' }))
    const P = await X.makeProgram({ name: `QA bench thật ${tag}`, isTest: false, products, dates: [await X.day(-40), await X.day(-10)], ...(basis === 'cms_unit' ? { v2: basis } : {}) })
    const pol = await X.setPolicy(P, policy, { cv: (await X.prog(P.id)).v })
    const t0 = Date.parse(`${P.start}T02:00:00Z`)
    const span = 6 * 24 * 3600 * 1000
    const off = (basis === 'cms_unit' ? (policy === FULL ? 0 : 1) : (policy === FULL ? 2 : 3)) + (opts.stale ? 4 : 0)
    const salesRaw = new Array(N_SALES)
    for (let i = 0; i < N_SALES; i++) {
      const t = new Date(t0 + Math.floor((i / N_SALES) * span)).toISOString()
      const qi = 1 + (i % 50_000)
      const half = basis === 'cms_unit' && i % 13 === 0
      const base = basis === 'cms_unit' ? qi * 10 + (half ? 5 : 0) : 10 + (i % 9)
      salesRaw[i] = { order_line_id: String(980000000 + off * 1_000_000 + i), order_id: `RO${off}-${Math.floor(i / 3)}`, order_code: `RQA-${off}-${Math.floor(i / 3)}`,
        product_id: products[i % NP].pid, seller_email: X.SEL[i % 3], pos_code: `QAOS${String(i % 7).padStart(2, '0')}`, order_type: 'OFFLINE',
        order_status: 'COMPLETED', completed_at: t, quantity_raw: basis === 'cms_unit' ? (half ? `${qi}.5` : String(qi)) : String(1 + (i % 4)),
        uom_raw: BENCH_UNITS[i % BENCH_UNITS.length], base_quantity: String(base), gmv_amount: String(base * 1000 + (i % 997)), source_updated_at: t }
    }
    // net v1 đọc ngữ cảnh dòng gốc trên phiếu (người bán / POS / B / G / thô q-u) — full_line bỏ qua các cột này. Từ điển v1 chỉ có
    // COMPLETED / APPROVED (v2 thêm CANCELED / PENDING / REJECTED / WAITING_APPROVAL) ⇒ phiếu chưa hiệu lực của net dùng APPROVED.
    const byId = new Map(salesRaw.map((s) => [s.order_line_id, s]))
    const withCtx = (r0) => {
      const r = policy !== FULL && r0.return_status !== 'COMPLETED' ? { ...r0, return_status: 'APPROVED' } : r0
      const s = policy === FULL || !r.original_order_line_id ? null : byId.get(r.original_order_line_id)
      return s ? { ...r, original_seller_email: s.seller_email, original_pos_code: s.pos_code, original_base_quantity: s.base_quantity,
        original_gmv_amount: s.gmv_amount, original_quantity_raw: s.quantity_raw, original_uom_raw: s.uom_raw } : r
    }
    const nPre = Math.floor(N_REP / 2)
    const pre = benchReturns(salesRaw, nPre, (s, j) => new Date(Date.parse(s.completed_at) + 60_000 * (1 + (j % 2))).toISOString()).map(withCtx)
    const endMs = Date.parse(`${P.end}T05:00:00Z`)
    const post = benchReturns(salesRaw.slice(1), N_REP - nPre, (_s, j) => new Date(endMs + j * 1000).toISOString()).map((r) => withCtx({ ...r,
      return_event_id: r.return_event_id.replace(/^BR/, 'BP'),
      ...(r.return_document_id ? { return_document_id: r.return_document_id.replace(/^BRD/, 'BPD'), return_code: r.return_code.replace(/^BRC/, 'BPC') } : {}) }))
    const calls = []
    const timedFn = (what, f) => async (...a) => { const s = performance.now(); try { return await f(...a) } finally { calls.push({ what: what(a), ms: Math.round(performance.now() - s) }) } }
    const fx = CF.createCmsContractFixtureProvider({ sales: salesRaw, returns: pre, snapshotId: `qa-bench-real-${off}` })
    const d = X.deps({ kind: 'bq', read: async (scope) => { const r = await fx.read(scope); return r.ok ? { ...r, provider: 'bq' } : r } })
    d.openRun = timedFn(() => 'open', d.openRun)
    d.stage = timedFn((a) => `stage ${a[1]}#${a[2]}`, d.stage)
    d.sealBegin = timedFn(() => 'seal_begin', d.sealBegin)
    d.sealStep = timedFn((a) => `seal ${a[1]}`, d.sealStep)
    d.publish = timedFn(() => 'publish', d.publish)
    if (opts.stale) sh = await staleHold(X)
    const tSync = performance.now()
    const sy = await SS.runCmsSalesSync(d, P.id, { dryRun: false, source: 'cron', sourceCapture: true, chunkSize: 5000, calcFlags: ON })
    if (sh) await staleRelease(X, sh)
    const syncMs = Math.round(performance.now() - tSync)
    const run = sy.runId ? await X.runRow(sy.runId) : null

    // Chẩn đoán G6 lượt c 20/11 (CHỈ khi đặt CMS132_DIAG_REAL = thư mục, PG15; gate KHÔNG đặt): thời gian từng hàm con của đường
    // chứng nhận / eval trên run vừa công bố + kế hoạch câu lồng (auto_explain ≥ 100 ms, analyze + buffers) + cỡ bảng / thống kê run_id.
    if (PG15 && process.env.CMS132_DIAG_REAL && sy.runId) {
      const out = [`[${tag}] run ${sy.runId}`], notes = []
      const onN = (m) => notes.push(String(m.message))
      const q = async (label, sql, p = []) => {
        const t = performance.now()
        try { const r = await X.db.query(sql, p); out.push(`${label}: ${Math.round(performance.now() - t)} ms → ${JSON.stringify(r.rows[0] ?? null).slice(0, 300)}`) }
        catch (e) { out.push(`${label}: LỖI ${String(e?.message ?? e).slice(0, 200)}`) }
      }
      await q('cỡ bảng', `SELECT (SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = 'cms_sales_source_lines') src,
        (SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = 'cms_sales_lines') sl, (SELECT count(*) FROM public.cms_sync_runs) runs,
        (SELECT last_autoanalyze::text FROM pg_stat_user_tables WHERE relname = 'cms_sales_source_lines') an_src,
        (SELECT last_autoanalyze::text FROM pg_stat_user_tables WHERE relname = 'cms_sales_lines') an_sl`)
      await q('pg_stats run_id', `SELECT json_agg(json_build_object('t', tablename, 'nd', n_distinct)) j FROM pg_stats
        WHERE schemaname = 'public' AND tablename IN ('cms_sales_source_lines', 'cms_sales_lines') AND attname = 'run_id'`)
      X.db.client.on('notice', onN)
      for (const c of ["LOAD 'auto_explain'", 'SET auto_explain.log_min_duration = 100', 'SET auto_explain.log_nested_statements = on',
        'SET auto_explain.log_analyze = on', 'SET auto_explain.log_buffers = on', 'SET auto_explain.log_timing = on', "SET auto_explain.log_level = 'notice'"]) await X.db.query(c)
      try {
        await q('source_check', 'SELECT public.cms__run_source_check($1) r', [sy.runId])
        await q('unit_check(false)', 'SELECT public.cms__run_unit_check($1, false) r', [sy.runId])
        await q('unit_check(true)', 'SELECT public.cms__run_unit_check($1, true) r', [sy.runId])
        await q('unit_fp', 'SELECT length(public.cms__run_unit_fp($1)) r', [sy.runId])
        await q('source_fp decision10', "SELECT length(public.cms__run_source_fp($1, 'decision10')) r", [sy.runId])
        await q('count source', 'SELECT count(*) r FROM public.cms_sales_source_lines WHERE run_id = $1', [sy.runId])
        await q('scope_hash', 'SELECT length(public.cms__program_scope_hash($1)) r', [P.id])
        await q('mapping_fp', 'SELECT length(public.cms__mapping_fp()) r')
      } finally {
        await X.db.query('SET auto_explain.log_min_duration = -1')
        X.db.client.off('notice', onN)
      }
      fs.writeFileSync(path.join(process.env.CMS132_DIAG_REAL, `diag-real-${tag.replace('/', '-')}.txt`), [...out, '', '===== auto_explain (≥ 100 ms) =====', ...notes].join('\n\n'))
    }

    // Từ đây: statement_timeout 8 s cho MỌI câu của phiên (như vai PostgREST); đo từng lời gọi. Chẩn đoán (CHỈ khi đặt CMS132_PROFILE_OUT, PG15,
    // ca thống kê cũ; gate KHÔNG đặt): auto_explain câu lồng ≥ 200 ms và trần 120 s để GHI được kế hoạch xấu — số đo lượt đó không phải gate.
    const PROF_R = PG15 && opts.stale && process.env.CMS132_PROFILE_OUT ? process.env.CMS132_PROFILE_OUT : null
    const profR = []
    const onR = (m) => profR.push(String(m.message))
    if (PROF_R) {
      X.db.client.on('notice', onR)
      for (const q of ["LOAD 'auto_explain'", 'SET auto_explain.log_min_duration = 200', 'SET auto_explain.log_nested_statements = on',
        'SET auto_explain.log_analyze = on', 'SET auto_explain.log_timing = on', "SET auto_explain.log_level = 'notice'"]) await X.db.query(q)
    }
    await X.db.query(PROF_R ? `SET statement_timeout = '120s'` : `SET statement_timeout = '8s'`)
    const nAtt = async () => (await X.one(`SELECT count(*)::int n FROM public.cms_source_attestations WHERE program_id = $1`, [P.id])).n
    const nPay = async () => (await X.one(`SELECT count(*)::int n FROM public.cms_payouts WHERE program_id = $1`, [P.id])).n
    const nRep = async () => (await X.one(`SELECT count(*)::int n FROM public.cms_return_close_reports WHERE program_id = $1`, [P.id])).n
    const timeouts = []
    // Xuất trang (phiên super, 5.000 dòng / trang) — đo từng trang.
    const exportMs = []
    const tCli = performance.now()
    let st = K.AT.newCmsAttestExportState(P.id, sy.runId)
    let exOk = true
    for (let after = null; ;) {
      const s = performance.now()
      const r = await settle(L_AS(X, U.super, `SELECT public.rpc_cms_run_source_export($1, $2, $3, 5000) r`, [P.id, sy.runId, after]))
      exportMs.push(Math.round(performance.now() - s))
      if (!r.ok) { exOk = false; if (/statement timeout/.test(r.err)) timeouts.push('export'); break }
      const pg = K.AT.cmsAttestExportPage(st, r.v.rows[0].r, 5000)
      if (!pg.ok) { exOk = false; break }
      st = pg.state
      if (pg.done) break
      after = st.lastId
    }
    calls.push({ what: `export trang chậm nhất (${exportMs.length} trang)`, ms: Math.max(0, ...exportMs) })
    // Lõi CLI: CSV → đọc lại → compare TÍNH LẠI (không đo — offline ở máy operator) → payload.
    const prog = await K.progOf(P.id)
    const md = K.AT.cmsAttestModeOf(prog)
    const unit = md.ok && md.mode === 'unit14'
    let built = { ok: false, reasons: ['export'] }, cmpV = null
    if (exOk) {
      const appCsv = K.AT.cmsAttestExportCsv(st.rows, unit)
      const refCsv = K.AT.cmsAttestExportCsv(salesRaw)
      const refSha = sha(refCsv), appSha = sha(appCsv)
      const refRead = K.I4.cmsI4ReadCsv(new Uint8Array(Buffer.from(refCsv, 'utf8')), C.CMS_SALES_COLUMNS)
      const appRead = K.I4.cmsI4ReadCsv(new Uint8Array(Buffer.from(appCsv, 'utf8')), unit ? [...C.CMS_SALES_COLUMNS, ...K.CI.CMS_I4_UNIT_APP_COLUMNS] : C.CMS_SALES_COLUMNS)
      const at = await K.dbNow()
      const side = (kind, s) => ({ inputKind: kind, source: kind === 'reference_source' ? 'Nguồn độc lập giả — bench r2' : 'rpc_cms_run_source_export', exportedAt: at, asOf: at,
        fileSha256: s, scope: { startDate: prog.startDate, endDate: prog.endDate, productIds: prog.productIds }, runId: kind === 'published_run' ? sy.runId : null })
      const meta = K.CI.cmsI4ParseEvidenceMeta({ version: 1, reference: side('reference_source', refSha), app: side('published_run', appSha) })
      const compare = K.CI.cmsI4CompareSource({ context: K.AT.cmsAttestContext(prog), reference: { rows: refRead.rows, fileSha256: refSha },
        app: { rows: appRead.rows, fileSha256: appSha }, meta: meta.value, mode: md.ok ? md.mode : 'decision10' })
      cmpV = compare.verdict
      built = K.AT.cmsAttestBuildPayload({ program: prog, runId: sy.runId, compare, meta: meta.value, refSha, appSha, ack: 'Đã đối soát nguồn độc lập toàn kỳ (bench r2)' })
    }
    const cliMs = Math.round(performance.now() - tCli)
    const nA0 = await nAtt()
    let att = { ok: false, err: 'no payload' }
    if (built.ok) {
      const s = performance.now()
      att = await K.sendRaw(P, sy.runId, built.payload)
      calls.push({ what: 'rpc_cms_source_attest', ms: Math.round(performance.now() - s) })
      if (!att.ok && /statement timeout/.test(att.err)) timeouts.push(`attest (ghi ${(await nAtt()) - nA0})`)
    }
    const evS = performance.now()
    const ev = await settle(K.evalOf(P, sy.runId))
    calls.push({ what: 'cms__attest_eval (owner)', ms: Math.round(performance.now() - evS) })
    const LD = lockDepsOf(X)
    const rpc0 = LD.rpc
    LD.rpc = timedFn((a) => a[0], rpc0)
    const PV = await lib('lib/cms/payoutView.ts')
    const pv = await LA.runCmsLockPreview(LD, P.id)
    const lk = pv.ok ? await LA.runCmsLock(LD, { programId: P.id, expectedRunId: sy.runId, expectedPolicyVersion: pv.preview.policyVersion,
      expectedAttestationId: PV.cmsLockExpectedAttestation(pv.preview), ackReason: `QA bench r2 chốt chương trình thật ${tag}` }) : { ok: false }
    if (!lk.ok && /statement timeout|57014/.test(JSON.stringify(lk))) timeouts.push(`lock (payout ${await nPay()})`)
    const pay = await X.one(`SELECT amount_vnd::text a, returns_policy rp, quantity_basis qb, source_complete_basis b, source_attestation_id::text att FROM public.cms_payouts WHERE program_id = $1`, [P.id])
    // Báo cáo sau chốt ở trần N_REP.
    const prof = policy === FULL ? FULL : 'net_returns_v1'
    const recs = (raws) => raws.map((r) => { const n = RT.normalizeReturnRow(r, prof); if (!n.ok) throw new Error('phiếu bench thật lỗi'); return n.value })
    const PROG = { startDate: P.start, endDate: P.end, productIds: products.map((p) => p.pid) }
    let tick = BigInt(Date.now()) * BigInt(1000)
    const nextAsOf = () => { const now = BigInt(Date.now()) * BigInt(1000); tick = now > tick + BigInt(1000) ? now : tick + BigInt(1000); return tick }
    const payload = (raws, snap) => JSON.stringify(CR.buildCmsCloseReportPayload(PROG, recs(raws), { provider: 'bq', snapshotId: snap, asOfMicros: nextAsOf(),
      ...(prof === FULL ? { profile: FULL } : {}) }))
    const SAVE = `SELECT public.rpc_cms_return_close_report_save($1, $2, $3::jsonb) r`
    const SAVE_SUPER = `SELECT public.rpc_cms_return_close_report_save_super($1, $2, $3::jsonb, $4, $5) r`
    const timedCall = async (what, f) => {
      const n0 = await nRep()
      const s = performance.now()
      const r = await settle(f())
      calls.push({ what, ms: Math.round(performance.now() - s) })
      if (!r.ok) { if (/statement timeout/.test(r.err)) timeouts.push(`${what} (báo cáo mới ${(await nRep()) - n0})`); return { err: code(r) } }
      return r.v.rows[0].r
    }
    const REASON = 'Bench r2 lập tay ngày 31 — chương trình thật'
    const REQ = crypto.randomUUID()
    const stS0 = await staleStats(X)
    const s0 = lk.ok ? await timedCall('report_save s0 (phát lại trước chốt)', () => X.svc(SAVE, [P.id, sy.runId, payload(pre, `qa-bench-real-${off}-s0`)])) : {}
    const s1 = lk.ok ? await timedCall(`report_save s1 (đủ trần ${N_REP})`, () => X.svc(SAVE, [P.id, sy.runId, payload([...pre, ...post], `qa-bench-real-${off}-s1`)])) : {}
    const s2 = lk.ok ? await timedCall('report_save_super s2', () => L_AS(X, U.super, SAVE_SUPER, [P.id, sy.runId, payload([...pre, ...post], `qa-bench-real-${off}-s2`), REASON, REQ])) : {}
    const s3 = lk.ok ? await timedCall('report_save_super s3 (phát lại)', () => L_AS(X, U.super, SAVE_SUPER, [P.id, sy.runId, payload([...pre, ...post], `qa-bench-real-${off}-s3`), REASON, REQ])) : {}
    const prS = performance.now()
    const pr = await settle(L_AS(X, U.super, `SELECT public.rpc_cms_payout($1) r`, [P.id]))
    calls.push({ what: 'payout super', ms: Math.round(performance.now() - prS) })
    await X.db.query('RESET statement_timeout')
    if (PROF_R) {
      await X.db.query('SET auto_explain.log_min_duration = -1')
      X.db.client.off('notice', onR)
      fs.writeFileSync(path.join(PROF_R, `prof-real-${tag.replace(/[^a-z0-9]+/gi, '-')}.txt`), profR.join('\n\n=====\n\n'))
    }
    const h0 = s0.report_id ? await X.one(`SELECT frozen_amount::text f, delta_amount::text d FROM public.cms_return_close_reports WHERE id = $1`, [s0.report_id]) : null
    const worst = calls.reduce((m, c) => (c.ms > m.ms ? c : m), { what: '-', ms: 0 })
    const by = (rx) => calls.filter((c) => rx.test(c.what)).reduce((m, c) => (c.ms > m.ms ? c : m), { what: '-', ms: 0 })
    console.log(`  · [thật ${tag}] ${N_SALES} dòng bán; sync ${syncMs} ms (${sy.status}); lõi CLI offline (xuất + CSV + compare) ${cliMs} ms, compare ${cmpV}`)
    console.log(`  · [thật ${tag}] cỡ bảng trước báo cáo: ${JSON.stringify(stS0)}`)
    console.log(`  · [thật ${tag}] chậm nhất ${worst.what} ${worst.ms} ms; seal ${by(/^seal /).what} ${by(/^seal /).ms} · xuất ${by(/^export/).ms} · chứng nhận ${by(/source_attest$/).ms} · eval ${by(/attest_eval/).ms} · preview ${by(/lock_preview/).ms} · chốt ${by(/program_lock$/).ms} · báo cáo ${by(/report_save/).what} ${by(/report_save/).ms} ms`)
    ok(pol.ok && sy.status === 'published' && exOk && built.ok && att.ok && ev.ok && ev.v.code === null && pv.ok && pv.preview.sourceCompleteBasis === 'operator_reconciliation'
      && pv.preview.blockers.length === 0 && lk.ok && pay?.a === run?.amt && pay.rp === policy && pay.qb === basis && pay.att === att.v?.id && pay.b === 'operator_reconciliation'
      && s0.saved === true && h0?.d === '0' && h0.f === pay.a && s1.saved === true && s2.saved === true && s2.already === false && s3.saved === true && s3.already === true
      && pr.ok && pr.v.rows[0].r?.program_total === pay.a && timeouts.length === 0 && worst.ms < 8000
      && (!opts.stale || (stS0.sl_mod >= N_SALES && stS0.src_mod >= N_SALES)),
    `bench thật [${tag}] ${N_SALES} dòng / báo cáo ${N_REP} phiếu${opts.stale ? ' (seal BỎ QUA ANALYZE — thống kê chưa biết run mới, không chữa trước báo cáo)' : ''}: chứng nhận ${unit ? 'decision_unit14' : 'decision10'} qua lõi CLI → eval → preview → chốt (RÒNG) → báo cáo s0 Δ 0 / s1 đủ trần / s2 super / s3 phát lại → payout; statement_timeout 8 s, mọi lời gọi < 8 s (chậm nhất ${worst.what} ${worst.ms} ms)`,
    JSON.stringify({ pol: pol.ok ? 'ok' : pol.err, sy: [sy.status, sy.code ?? null], amt: run?.amt, exOk, pages: exportMs.length, cmpV, built: built.ok || built.reasons?.slice(0, 3),
      att: att.ok ? 'ok' : att.err, ev: ev.ok ? ev.v.code : ev.err, pv: pv.ok ? [pv.preview.sourceCompleteBasis, pv.preview.blockers] : pv, lk, pay,
      s: [s0.saved ?? s0.err, s1.saved ?? s1.err, s2.saved ?? s2.err, s3.already ?? s3.err], h0, timeouts, worst, st: stS0 }).slice(0, 1400))
  } finally {
    try { await X.db.query('RESET statement_timeout') } catch { /* */ }
    if (sh && !sh.released) { try { await staleRelease(X, sh) } catch { /* */ } }
    if (sh) await staleRestore(X, sh)
    await X.db.exec(polOrig)
  }
}

// ── §13 (PG15) bench ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const BENCH_UNITS = ['Hộp', 'hộp', 'HỘP', ' Hộp', 'Hộp ', '  hộp  ', 'Ho\u0323\u0302p', 'Viên', 'viên', 'Vỉ', 'Chai', 'Tuýp']
async function benchSection() {
  const N_SALES = Number(process.env.CMS132_BENCH_SALES ?? 200_000), N_RET = Number(process.env.CMS132_BENCH_RETURNS ?? 20_000)
  const X = await env('bench')
  ok(X.applied.ok, 'DB bench: áp 132', X.applied.err)
  const modes = (process.env.CMS132_BENCH_MODES ?? 'pos_base,cms_unit').split(',').filter((m) => m && m !== 'none')
  for (const mode of modes) await benchMode(X, mode, N_SALES, N_RET)
  // Báo cáo sau chốt đo ĐÚNG trần báo cáo (r1 P1-2: CAP = 10.000 < N_RET 20.000 của run seal); run seal giữ N_RET.
  const N_REP = Math.min(N_RET, CR.CMS_CLOSE_REPORT_MAX_RETURNS_FULL_LINE)
  if (process.env.CMS132_BENCH_REPORT !== '0') await benchReport(X, N_SALES, N_REP)
  if (process.env.CMS132_BENCH_CT !== '0') await benchContractReport(X, N_SALES, N_REP, process.env.CMS132_BENCH_CT_MODE ?? 'cms_unit')
  // r2 (PM 19/11 §5 bước 4): chương trình THẬT — 2 cách tính × net / full_line; chứng nhận qua lõi CLI → preview → chốt → báo cáo ở trần.
  if (process.env.CMS132_BENCH_REAL !== '0') await benchRealAll(X, N_SALES, N_REP)
}
async function benchRealAll(X, N_SALES, N_REP) {
  for (const c of (process.env.CMS132_BENCH_REAL_COMBOS ?? 'pos_base:net,pos_base:full,cms_unit:net,cms_unit:full').split(',').filter(Boolean)) {
    const [b, p] = c.split(':')
    await benchRealCombo(X, b, p === 'full' ? FULL : 'net_returns_v1', N_SALES, N_REP)
  }
  // r3 RET-R3-01 (PM 20/11 §4.2): cùng 4 tổ hợp khi seal BỎ QUA ANALYZE — bảng đã tích luỹ các run trước, thống kê không biết run mới.
  if (PG15 && process.env.CMS132_BENCH_STALE !== '0') {
    for (const c of (process.env.CMS132_BENCH_STALE_COMBOS ?? 'pos_base:net,pos_base:full,cms_unit:net,cms_unit:full').split(',').filter(Boolean)) {
      const [b, p] = c.split(':')
      await benchRealCombo(X, b, p === 'full' ? FULL : 'net_returns_v1', N_SALES, N_REP, { stale: true })
    }
  }
}
// Thống kê cũ (r3): seal_begin_contract chạy `ANALYZE (SKIP_LOCKED)` đúng 6 bảng này ⇒ phiên 2 giữ SHARE UPDATE EXCLUSIVE (khoá autovacuum /
// ANALYZE khác giữ) trong lúc sync ⇒ seal bỏ qua. Autovacuum mọi bảng cms_* TẮT trong ca để thống kê không được chữa trước báo cáo (làm ca
// KHÓ hơn, không làm xanh); sau ca RESET (không ANALYZE). lock_timeout 30 s cho phiên bench trong lúc giữ khoá: sync không được treo.
const STALE_TABLES = ['cms_sales_lines', 'cms_results', 'cms_result_catalog', 'cms_sales_source_lines', 'cms_return_lines', 'cms_result_events']
async function staleHold(X) {
  const tb = (await X.db.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'cms\\_%' ORDER BY 1`)).rows.map((r) => r.relname)
  for (const t of tb) await X.db.query(`ALTER TABLE public.${t} SET (autovacuum_enabled = false)`)
  const c = await pgConn(X.dbName)
  await c.query('BEGIN')
  await c.query(`LOCK TABLE ${STALE_TABLES.map((t) => `public.${t}`).join(', ')} IN SHARE UPDATE EXCLUSIVE MODE`)
  await X.db.query(`SET lock_timeout = '30s'`)
  return { c, tb, released: false }
}
async function staleRelease(X, h) {
  h.released = true
  await h.c.query('COMMIT')
  await h.c.end()
  await X.db.query('RESET lock_timeout')
}
async function staleRestore(X, h) { for (const t of h.tb) await X.db.query(`ALTER TABLE public.${t} RESET (autovacuum_enabled)`) }
/** Ảnh thống kê (PG15): n_mod_since_analyze ≥ cỡ run ⇒ thống kê chưa biết run mới. PGlite ⇒ null. */
async function staleStats(X) {
  if (!PG15) return null
  const r = (await X.db.query(`SELECT relname, n_live_tup::bigint n, n_mod_since_analyze::bigint m FROM pg_stat_user_tables
    WHERE schemaname = 'public' AND relname IN ('cms_sales_lines', 'cms_sales_source_lines', 'cms_result_events', 'cms_return_lines')`)).rows
  const g = (t, k) => Number(r.find((x) => x.relname === t)?.[k] ?? -1)
  const runs = Number((await X.db.query(`SELECT count(*)::int n FROM public.cms_sync_runs WHERE kind = 'sales'`)).rows[0].n)
  return { sl: g('cms_sales_lines', 'n'), sl_mod: g('cms_sales_lines', 'm'), src: g('cms_sales_source_lines', 'n'), src_mod: g('cms_sales_source_lines', 'm'),
    ev: g('cms_result_events', 'n'), ev_mod: g('cms_result_events', 'm'), rl: g('cms_return_lines', 'n'), rl_mod: g('cms_return_lines', 'm'), runs }
}
/** Phiếu bench: N_RET phiếu trên N_RET / 2 dòng ref (2 phiếu / dòng, phiếu thứ hai muộn hơn); 1 / 20 phiếu chưa hiệu lực (v2). */
function benchReturns(salesRaw, N_RET, atOf) {
  const lines = Math.floor(N_RET / 2), step = Math.floor(salesRaw.length / lines)
  const out = new Array(N_RET)
  for (let j = 0; j < N_RET; j++) {
    const s = salesRaw[Math.floor(j / 2) * step]
    const at = atOf(s, j)
    out[j] = j % 20 === 19 ? { return_event_id: `BR${j}`, return_status: ['CANCELED', 'PENDING', 'REJECTED', 'WAITING_APPROVAL', 'APPROVED'][Math.floor(j / 20) % 5] } : {
      return_event_id: `BR${j}`, return_document_id: `BRD${j}`, return_code: `BRC${j}`, return_status: 'COMPLETED', return_recorded_at: at,
      original_order_line_id: s.order_line_id, original_order_id: s.order_id, product_id: s.product_id, return_base_quantity: String(1 + (j % 3)),
      return_gmv_amount: String(100 + (j % 37)), original_completed_at: s.completed_at, original_order_type: 'OFFLINE', original_order_status: 'COMPLETED',
      original_seller_email: null, original_pos_code: null, original_base_quantity: null, original_gmv_amount: null, original_quantity_raw: null, original_uom_raw: null,
      source_updated_at: at }
  }
  return out
}
async function benchMode(X, mode, N_SALES, N_RET) {
  const NP = 20
  const products = Array.from({ length: NP }, () => ({ pid: X.pid(), k: '10', unit: 'Hộp' }))
  const P = await X.makeProgram({ name: `QA bench full_line ${mode}`, products, v2: mode })
  await X.svc(`SELECT public.rpc_cms_program_set_returns_policy($1, $2, $3, $4)`, [P.id, FULL, (await X.prog(P.id)).v, U.super])
  const SEL = [...STORES[0].assigneeEmails, ...STORES[1].assigneeEmails, STORES[2].assigneeEmails[0], 'nobody.qa@example.invalid']
  const t0 = Date.parse(`${P.start}T02:00:00Z`)
  const span = 6 * 24 * 3600 * 1000
  const salesRaw = new Array(N_SALES)
  for (let i = 0; i < N_SALES; i++) {
    const t = new Date(t0 + Math.floor((i / N_SALES) * span)).toISOString()
    const qi = 1 + (i % 50_000)
    const half = i % 13 === 0
    const base = qi * 10 + (half ? 5 : 0)
    salesRaw[i] = { order_line_id: String(960000000 + i), order_id: `BO${Math.floor(i / 3)}`, order_code: `BQA-${Math.floor(i / 3)}`,
      product_id: products[i % NP].pid, seller_email: SEL[i % SEL.length], pos_code: `QAOS${String(i % 7).padStart(2, '0')}`, order_type: 'OFFLINE',
      order_status: 'COMPLETED', completed_at: t, quantity_raw: half ? `${qi}.5` : String(qi), uom_raw: BENCH_UNITS[i % BENCH_UNITS.length], base_quantity: String(base),
      gmv_amount: String(base * 1000 + (i % 997)), source_updated_at: t }
  }
  const retRaw = benchReturns(salesRaw, N_RET, (s, j) => new Date(Date.parse(s.completed_at) + 60_000 * (1 + (j % 2))).toISOString())
  const T = {}
  const timed = async (k, fn) => { const a = performance.now(); try { return await fn() } finally { T[k] = Math.round(performance.now() - a) } }
  const calls = []
  const call = async (what, sql, p) => { const a = performance.now(); const r = await X.rpc(sql, p); calls.push({ what, ms: Math.round(performance.now() - a) }); return r }
  const asSuper = async (what, sql, p) => {
    const a = performance.now()
    const r = (await L.as(X.db, U.super, () => X.db.query(sql, p), 'authenticated')).rows[0].r
    calls.push({ what, ms: Math.round(performance.now() - a) })
    return r
  }
  async function brun(asOfMicros) {
    const opened = await call('open', RUN_OPEN, [P.id, OPEN_V2])
    const runId = opened.run_id
    const snap = CS.parseCmsContractSnapshot(opened)
    const sales = await timed('ts_normalize', () => salesRaw.map((r) => { const n = C.normalizeSalesRow(r); if (!n.ok) throw new Error('dòng bán bench lỗi'); return NET.cmsCalcSaleLine(r, n.value) }))
    const rets = retRaw.map((r) => { const n = RT.normalizeReturnRow(r, FULL); if (!n.ok) throw new Error('phiếu bench lỗi ' + JSON.stringify(n.issues)); return n.value })
    const out = await timed('ts_compute', () => NET.computeCmsNet(CS.cmsContractCalcInput(snap, sales, rets, asOfMicros)))
    if (!out.ok) throw new Error('bench compute held ' + JSON.stringify(out.holds).slice(0, 200))
    const payload = await timed('ts_payload', () => CS.buildCmsContractStagePayload(snap, sales, rets, out, { rowsRead: sales.length, rowsRejected: 0,
      bytesProcessed: null, provider: 'fixture', snapshotId: 'qa-bench', asOfMicros, rejectedDigest: SD.cmsDigestSet('rejected', []), chunkSize: 5000 }))
    await timed('stage', async () => {
      for (const part of payload.stageParts) {
        const chunks = RS.chunkCmsStageRows(payload.parts[part], 5000)
        for (let i = 0; i < chunks.length; i++) await call(`stage ${part}#${i}`, `SELECT public.rpc_cms_sales_run_stage($1, $2, $3, $4::jsonb) r`, [runId, part, i, JSON.stringify(chunks[i])])
      }
    })
    const begin = await timed('seal_begin', () => call('seal_begin', `SELECT public.rpc_cms_sales_run_seal_begin($1, $2::jsonb) r`, [runId, JSON.stringify(payload.expect)]))
    if (!begin.ok) throw new Error('bench seal_begin ' + JSON.stringify(begin).slice(0, 200))
    let last = null
    for (let i = 1; i <= 13; i++) {
      last = await timed(`seal_${i}`, () => call(`seal ${i}`, `SELECT public.rpc_cms_sales_run_seal_step($1, $2) r`, [runId, i]))
      if (last.sealed || !last.ok) break
    }
    if (!last?.sealed) throw new Error('bench seal ' + JSON.stringify(last).slice(0, 300))
    const pub = await timed('publish', () => call('publish', `SELECT public.rpc_cms_sales_run_publish($1) r`, [runId]))
    return { runId, pub, out, parts: Object.fromEntries(payload.stageParts.map((p) => [p, payload.parts[p].length])) }
  }
  const asOf1 = BigInt(Date.now() - 60_000) * BigInt(1000)
  const b1 = await brun(asOf1)
  const T1r = { ...T }
  const nb = Number((await X.one(`SELECT count(*)::int n FROM public.cms_return_baselines WHERE program_id = $1 AND fp_version = 'cms-return-fp-v2' AND base_quantity IS NULL`, [P.id])).n)
  const b2 = await brun(asOf1 + BigInt(1000))
  const T2r = { ...T }
  const ev = await X.all(`SELECT eval_seq::int s, verdict v, baselines::int b FROM public.cms_return_ledger_evals WHERE program_id = $1 ORDER BY eval_seq`, [P.id])
  const zero = Number((await X.one(`SELECT count(*)::int n FROM public.cms_result_events WHERE run_id = $1 AND kind = 'RETURN' AND base_delta = 0`, [b2.runId])).n)
  const tot = (await X.runRow(b2.runId)).tot
  let more = true, nClean = 0
  await timed('cleanup_total', async () => { for (let i = 0; i < 60 && more; i++) { more = (await call(`cleanup#${i}`, `SELECT public.rpc_cms_sales_run_cleanup($1, 50000) r`, [P.id])).more; nClean++ } })
  const nEv = Number((await X.one(`SELECT count(*)::int n FROM public.cms_result_events WHERE run_id = $1`, [b2.runId])).n)
  const nRl = Number((await X.one(`SELECT count(*)::int n FROM public.cms_return_lines WHERE run_id = $1`, [b2.runId])).n)
  const rd = {}
  rd.header = await asSuper('header_v2', `SELECT public.rpc_cms_result_header_v2($1) r`, [P.id])
  rd.rows = await asSuper('rows_v2', `SELECT public.rpc_cms_result_rows_v2($1, $2) r`, [P.id, b2.runId])
  rd.ev0 = await asSuper('events_v2 đầu', `SELECT public.rpc_cms_result_events_v2($1, $2, NULL, NULL, NULL, 500) r`, [P.id, b2.runId])
  rd.evDeep = await asSuper('events_v2 sâu', `SELECT public.rpc_cms_result_events_v2($1, $2, NULL, NULL, $3, 500) r`, [P.id, b2.runId, Math.max(nEv - 600, 0)])
  rd.rt0 = await asSuper('returns_v2 đầu', `SELECT public.rpc_cms_result_returns_v2($1, $2, NULL, 500) r`, [P.id, b2.runId])
  rd.rtDeep = await asSuper('returns_v2 sâu', `SELECT public.rpc_cms_result_returns_v2($1, $2, $3, 500) r`, [P.id, b2.runId, Math.max(nRl - 600, 0)])
  rd.cf = await asSuper('return_conflicts', `SELECT public.rpc_cms_return_conflicts($1) r`, [P.id])
  const worst = calls.reduce((m, c) => (c.ms > m.ms ? c : m), { what: '-', ms: 0 })
  const by = (re) => calls.filter((c) => re.test(c.what)).reduce((m, c) => (c.ms > m.ms ? c : m), { what: '-', ms: 0 })
  console.log(`  · [${mode}] ${N_SALES} dòng bán / ${N_RET} phiếu trên ${Math.floor(N_RET / 2)} dòng ref (${b1.parts.return_lines} return_lines, ${b1.parts.result_events} sự kiện, ${nb} baseline v2, ${zero} sự kiện RETURN lượng 0)`)
  console.log(`  · [${mode}] lượt 1 (ms): ${JSON.stringify(T1r)}`)
  console.log(`  · [${mode}] lượt 2 (ms): ${JSON.stringify(T2r)}`)
  console.log(`  · [${mode}] cleanup ${nClean} lời gọi, chậm nhất ${by(/^cleanup/).ms} ms; reader (ms): ${JSON.stringify(Object.fromEntries(calls.filter((c) => /_v2|conflicts/.test(c.what)).map((c) => [c.what, c.ms])))}`)
  console.log(`  · [${mode}] chậm nhất: ${worst.what} ${worst.ms} ms; stage chậm nhất ${by(/^stage/).ms} ms; seal chậm nhất ${by(/^seal /).what} ${by(/^seal /).ms} ms`)
  const nEff = retRaw.filter((r) => r.return_status === 'COMPLETED').length
  const readersOk = rd.header?.run?.id === b2.runId && rd.rows?.results?.length > 0 && rd.ev0?.rows?.length === 500 && rd.evDeep?.rows?.length > 0
    && rd.rt0?.rows?.length === 500 && rd.rtDeep?.rows?.length > 0 && rd.cf?.open_count === 0
  ok(b1.pub?.published === true && b2.pub?.published === true && nb > 0 && ev.length === 2 && ev.every((x) => x.v === 'CLEAN') && ev[1].b === nb
    && zero > 0 && tot?.returns_applied > 0 && tot.returns_applied <= nEff && readersOk && !more && worst.ms < 8000,
    `bench full_line [${mode}] ${N_SALES} / ${N_RET} (2 phiếu / dòng): 2 run seal 13 bước + publish (CLEAN, ${nb} baseline v2) + cleanup + reader; mọi lời gọi < 8 s (chậm nhất ${worst.what} ${worst.ms} ms)`,
    JSON.stringify({ p1: b1.pub, p2: b2.pub, ev, zero, tot, readersOk, more, worst }).slice(0, 600))
}
async function benchReport(X, N_SALES, N_RET) {
  const NP = 20
  const products = Array.from({ length: NP }, () => ({ pid: X.pid(), k: '10' }))
  const start = await X.day(-40), end = await X.day(-10)
  const P = await X.makeProgram({ name: 'QA bench báo cáo full_line', products, dates: [start, end] })
  const S = Array.from({ length: N_SALES }, (_, i) => X.srow(P, { pid: products[i % NP].pid, s: i % 3, base: 10, min: 60 + Math.floor(i / 6) }))
  const calls = []
  const call = async (what, sql, p) => { const a = performance.now(); const r = await X.rpc(sql, p); calls.push({ what, ms: Math.round(performance.now() - a) }); return r }
  const asSuper = async (what, sql, p) => {
    const a = performance.now()
    const r = (await L.as(X.db, U.super, () => X.db.query(sql, p), 'authenticated')).rows[0].r
    calls.push({ what, ms: Math.round(performance.now() - a) })
    return r
  }
  const sy = await X.syncLegacy(P, S)
  const LD = lockDepsOf(X)
  const pv = await LA.runCmsLockPreview(LD, P.id)
  const lk = pv.ok ? await LA.runCmsLock(LD, { programId: P.id, expectedRunId: sy.runId, expectedPolicyVersion: pv.preview.policyVersion, ackReason: 'QA bench chốt thử báo cáo Q-236' }) : { ok: false }
  const endMs = Date.parse(`${end}T05:00:00Z`)
  const raws = benchReturns(S, N_RET, (_s, j) => new Date(endMs + j * 1000).toISOString())
  const recs = raws.map((r) => { const n = RT.normalizeReturnRow(r, FULL); if (!n.ok) throw new Error('phiếu bench báo cáo lỗi'); return n.value })
  const PROG = { startDate: start, endDate: end, productIds: products.map((p) => p.pid) }
  const asOf = BigInt(Date.now() - 60_000) * BigInt(1000)
  const SAVE = `SELECT public.rpc_cms_return_close_report_save($1, $2, $3::jsonb) r`
  // Gate cuối r2 lượt b (20/11): chương trình legacy / sales-only CHƯA có báo cáo ⇒ cron (không người lập) KHÔNG tự chọn profile
  // (CMS_REPORT_POLICY_UNSELECTED — PM r0 §3.1). Lần 1 = super chọn full_line (lý do + khoá yêu cầu) như vận hành; lần 2 = cron trên
  // profile đã ghim. Bản trước gọi cron ở cả hai lần ⇒ SQL từ chối đúng luật (lỗi harness, không phải sản phẩm).
  const SAVE_SUPER = `SELECT public.rpc_cms_return_close_report_save_super($1, $2, $3::jsonb, $4, $5) r`
  const r1 = await asSuper('report_save 1', SAVE_SUPER, [P.id, sy.runId, JSON.stringify(CR.buildCmsCloseReportPayload(PROG, recs, { provider: 'fixture', snapshotId: 'qa-bench-report', asOfMicros: asOf, profile: FULL })),
    'QA bench báo cáo legacy — super chọn full_line', '00000000-0000-4000-8000-0000000b3b01'])
  const r2 = await call('report_save 2', SAVE, [P.id, sy.runId, JSON.stringify(CR.buildCmsCloseReportPayload(PROG, recs, { provider: 'fixture', snapshotId: 'qa-bench-report', asOfMicros: asOf + BigInt(1000), profile: FULL }))])
  const zero = r2.report_id ? Number((await X.one(`SELECT count(*)::int n FROM public.cms_return_close_report_events WHERE report_id = $1 AND qty_effect = 0`, [r2.report_id])).n) : -1
  const d1 = r2.report_id ? await asSuper('close_report dòng', `SELECT public.rpc_cms_return_close_report($1, NULL, 1000) r`, [r2.report_id]) : null
  const e1 = r2.report_id ? await asSuper('close_report sự kiện đầu', `SELECT public.rpc_cms_return_close_report_events($1, NULL, 1000) r`, [r2.report_id]) : null
  const worst = calls.reduce((m, c) => (c.ms > m.ms ? c : m), { what: '-', ms: 0 })
  const nEff = raws.filter((r) => r.return_status === 'COMPLETED').length
  console.log(`  · [báo cáo full_line] save 1 ${calls.find((c) => c.what === 'report_save 1')?.ms} ms (${r1.return_events} sự kiện, ${r1.baselines_new} baseline); save 2 ${calls.find((c) => c.what === 'report_save 2')?.ms} ms; sự kiện qty_effect 0: ${zero}; reader ${JSON.stringify(Object.fromEntries(calls.filter((c) => /^close_report/.test(c.what)).map((c) => [c.what, c.ms])))}`)
  ok(sy.status === 'published' && lk.ok && r1.saved === true && r1.return_events === nEff && r1.baselines_new === nEff && r2.saved === true && r2.already === false
    && r2.baselines_new === 0 && zero > 0 && d1?.lines?.length > 0 && e1?.events?.length === 1000 && worst.ms < 8000,
    `bench báo cáo full_line (legacy): ${N_SALES} dòng chốt + ${N_RET} phiếu (2 / dòng) — save 1 super chọn profile / save 2 cron / reader; mọi lời gọi < 8 s (chậm nhất ${worst.what} ${worst.ms} ms)`,
    JSON.stringify({ sy: sy.status, lk: lk.ok, r1: { s: r1.saved, n: r1.return_events, b: r1.baselines_new, c: r1.code }, r2: { s: r2.saved, a: r2.already, b: r2.baselines_new, c: r2.code }, zero, worst }).slice(0, 600))
}

/**
 * r1 (PM 18/11 P1-05): bench CHỐT RUN CONTRACT + báo cáo sau chốt từ hợp đồng đóng băng — đường thật (runCmsSalesSync chunk 5.000 →
 * lockAction → rpc_cms_return_close_report_save / _save_super → reader). N_SALES dòng bán, N_RET / 2 phiếu TRƯỚC chốt (đã trừ ở run,
 * 2 phiếu / dòng ref, 1/20 status v2 chưa hiệu lực) + N_RET / 2 phiếu SAU chốt (dòng lệch 1 ⇒ một phần trùng dòng ref của phiếu trước).
 * Báo cáo: s0 chỉ phiếu trước chốt ⇒ Δ 0 (không trừ kép); s1 cron đủ N_RET (= trần báo cáo CAP); s2 super (lý do + khoá yêu cầu, mốc
 * mới); s3 super phát lại cùng khoá ⇒ báo cáo cũ. Không ANALYZE sau nạp (thống kê như lúc ghi). Mọi lời gọi < 8 s.
 */
async function benchContractReport(X, N_SALES, N_RET, mode) {
  const NP = 20
  const products = Array.from({ length: NP }, () => ({ pid: X.pid(), k: '10', unit: 'Hộp' }))
  const P = await X.makeProgram({ name: `QA bench chốt contract full_line ${mode}`, products, dates: [await X.day(-40), await X.day(-10)], v2: mode })
  const pol = await X.setPolicy(P, FULL, { cv: (await X.prog(P.id)).v })
  const t0 = Date.parse(`${P.start}T02:00:00Z`)
  const span = 6 * 24 * 3600 * 1000
  const salesRaw = new Array(N_SALES)
  for (let i = 0; i < N_SALES; i++) {
    const t = new Date(t0 + Math.floor((i / N_SALES) * span)).toISOString()
    const qi = 1 + (i % 50_000)
    const half = i % 13 === 0
    const base = qi * 10 + (half ? 5 : 0)
    salesRaw[i] = { order_line_id: String(970000000 + i), order_id: `CO${Math.floor(i / 3)}`, order_code: `CQA-${Math.floor(i / 3)}`,
      product_id: products[i % NP].pid, seller_email: X.SEL[i % 3], pos_code: `QAOS${String(i % 7).padStart(2, '0')}`, order_type: 'OFFLINE',
      order_status: 'COMPLETED', completed_at: t, quantity_raw: half ? `${qi}.5` : String(qi), uom_raw: BENCH_UNITS[i % BENCH_UNITS.length], base_quantity: String(base),
      gmv_amount: String(base * 1000 + (i % 997)), source_updated_at: t }
  }
  const nPre = Math.floor(N_RET / 2)
  const pre = benchReturns(salesRaw, nPre, (s, j) => new Date(Date.parse(s.completed_at) + 60_000 * (1 + (j % 2))).toISOString())
  const endMs = Date.parse(`${P.end}T05:00:00Z`)
  const post = benchReturns(salesRaw.slice(1), N_RET - nPre, (_s, j) => new Date(endMs + j * 1000).toISOString()).map((r) => ({ ...r,
    return_event_id: r.return_event_id.replace(/^BR/, 'BP'),
    ...(r.return_document_id ? { return_document_id: r.return_document_id.replace(/^BRD/, 'BPD'), return_code: r.return_code.replace(/^BRC/, 'BPC') } : {}) }))
  const preRefs = new Set(pre.filter((r) => r.original_order_line_id).map((r) => r.original_order_line_id))
  const postSameRef = post.filter((r) => r.return_status === 'COMPLETED' && preRefs.has(r.original_order_line_id)).length
  const calls = []
  const timedFn = (what, f) => async (...a) => { const s = performance.now(); try { return await f(...a) } finally { calls.push({ what: what(a), ms: Math.round(performance.now() - s) }) } }
  const d = X.deps(CF.createCmsContractFixtureProvider({ sales: salesRaw, returns: pre, snapshotId: 'qa-bench-ct' }))
  d.openRun = timedFn(() => 'open', d.openRun)
  d.stage = timedFn((a) => `stage ${a[1]}#${a[2]}`, d.stage)
  d.sealBegin = timedFn(() => 'seal_begin', d.sealBegin)
  d.sealStep = timedFn((a) => `seal ${a[1]}`, d.sealStep)
  d.publish = timedFn(() => 'publish', d.publish)
  const tSync = performance.now()
  const sy = await SS.runCmsSalesSync(d, P.id, { dryRun: false, source: 'qa', sourceCapture: true, chunkSize: 5000, calcFlags: ON })
  const syncMs = Math.round(performance.now() - tSync)
  const run = sy.runId ? await X.runRow(sy.runId) : null
  const nSaleEv = sy.runId ? Number((await X.one(`SELECT count(*)::int n FROM public.cms_result_events WHERE run_id = $1 AND kind = 'SALE'`, [sy.runId])).n) : 0
  const LD = lockDepsOf(X)
  const rpc0 = LD.rpc
  LD.rpc = timedFn((a) => a[0], rpc0)
  const pv = await LA.runCmsLockPreview(LD, P.id)
  const lk = pv.ok ? await LA.runCmsLock(LD, { programId: P.id, expectedRunId: sy.runId, expectedPolicyVersion: pv.preview.policyVersion,
    ackReason: 'QA bench chốt run contract Q-237' }) : { ok: false }
  const pay = await X.one(`SELECT amount_vnd::text a, returns_policy rp, calc_contract_version cc FROM public.cms_payouts WHERE program_id = $1`, [P.id])
  const recs = (raws) => raws.map((r) => { const n = RT.normalizeReturnRow(r, FULL); if (!n.ok) throw new Error('phiếu bench contract lỗi'); return n.value })
  const PROG = { startDate: P.start, endDate: P.end, productIds: products.map((p) => p.pid) }
  let tick = BigInt(Date.now()) * BigInt(1000)
  const nextAsOf = () => { const now = BigInt(Date.now()) * BigInt(1000); tick = now > tick + BigInt(1000) ? now : tick + BigInt(1000); return tick }
  const payload = (raws, snap) => JSON.stringify(CR.buildCmsCloseReportPayload(PROG, recs(raws), { provider: 'fixture', snapshotId: snap, asOfMicros: nextAsOf(), profile: FULL }))
  const call = async (what, sql, p) => { const s = performance.now(); const r = await X.rpc(sql, p); calls.push({ what, ms: Math.round(performance.now() - s) }); return r }
  const asSuper = async (what, sql, p) => {
    const s = performance.now()
    const r = (await L.as(X.db, U.super, () => X.db.query(sql, p), 'authenticated')).rows[0].r
    calls.push({ what, ms: Math.round(performance.now() - s) })
    return r
  }
  const SAVE = `SELECT public.rpc_cms_return_close_report_save($1, $2, $3::jsonb) r`
  const SAVE_SUPER = `SELECT public.rpc_cms_return_close_report_save_super($1, $2, $3::jsonb, $4, $5) r`
  const head = (id) => X.one(`SELECT frozen_amount::text f, recomputed_amount::text rc, delta_amount::text d, return_events::int n FROM public.cms_return_close_reports WHERE id = $1`, [id])
  // Chẩn đoán (CHỈ khi đặt CMS132_PROFILE_OUT, PG15): auto_explain câu lồng ≥ 150 ms của lõi báo cáo ⇒ tệp prof-<tag>.txt. Không đổi số đo gate
  // (gate 6 không đặt biến này; log_analyze làm chậm thêm).
  const PROF = PG15 && process.env.CMS132_PROFILE_OUT ? process.env.CMS132_PROFILE_OUT : null
  const profBuf = []
  const onNotice = (m) => profBuf.push(String(m.message))
  const prof = async (tag, fn) => {
    if (!PROF) return fn()
    X.db.client.on('notice', onNotice)
    for (const q of ["LOAD 'auto_explain'", 'SET auto_explain.log_min_duration = 150', 'SET auto_explain.log_nested_statements = on',
      'SET auto_explain.log_analyze = on', 'SET auto_explain.log_timing = on', "SET auto_explain.log_level = 'notice'"]) await X.db.query(q)
    try { return await fn() } finally {
      await X.db.query('SET auto_explain.log_min_duration = -1')
      X.db.client.off('notice', onNotice)
      fs.writeFileSync(path.join(PROF, `prof-${tag}.txt`), profBuf.splice(0).join('\n\n=====\n\n'))
    }
  }
  const s0 = lk.ok ? await call('report_save s0 (trước chốt)', SAVE, [P.id, sy.runId, payload(pre, 'qa-bench-ct-s0')]) : {}
  const h0 = s0.report_id ? await head(s0.report_id) : null
  const s1 = lk.ok ? await prof('s1', () => call('report_save s1 (đủ trần)', SAVE, [P.id, sy.runId, payload([...pre, ...post], 'qa-bench-ct-s1')])) : {}
  const h1 = s1.report_id ? await head(s1.report_id) : null
  const ev1 = s1.report_id ? await X.one(`SELECT count(*) FILTER (WHERE pre_lock)::int pre, count(*) FILTER (WHERE qty_effect = 0)::int z, count(*)::int n
    FROM public.cms_return_close_report_events WHERE report_id = $1`, [s1.report_id]) : null
  const REQ = '00000000-0000-4000-8000-0000000b3c01'
  const REASON = 'Bench lập tay ngày 31 — đối soát phiếu sau chốt'
  const s2 = lk.ok ? await asSuper('report_save_super s2', SAVE_SUPER, [P.id, sy.runId, payload([...pre, ...post], 'qa-bench-ct-s2'), REASON, REQ]) : {}
  const s3 = lk.ok ? await prof('s3', () => asSuper('report_save_super s3 (phát lại)', SAVE_SUPER, [P.id, sy.runId, payload([...pre, ...post], 'qa-bench-ct-s3'), REASON, REQ])) : {}
  const rl = s1.report_id ? await asSuper('close_report dòng', `SELECT public.rpc_cms_return_close_report($1, NULL, 1000) r`, [s1.report_id]) : null
  const re = s1.report_id ? await asSuper('close_report sự kiện đầu', `SELECT public.rpc_cms_return_close_report_events($1, NULL, 1000) r`, [s1.report_id]) : null
  const rs = await asSuper('close_reports danh sách', `SELECT public.rpc_cms_return_close_reports($1) r`, [P.id])
  const pr = await asSuper('payout super', `SELECT public.rpc_cms_payout($1) r`, [P.id])
  // db-reviewer r1 P1-2: đường lập tay chạy dưới vai authenticated qua PostgREST ⇒ statement_timeout của vai (Supabase mặc định 8 s) bao CẢ chờ
  // khoá chương trình (lock_timeout 5 s của wrapper) + tính. PG15: s4 không tranh chấp; s5 phiên khác giữ khoá chương trình đúng bằng thời lượng
  // lõi báo cáo cron s1 (bên giữ khoá lâu nhất trong vận hành thường) rồi COMMIT. Không nới timeout; vượt ⇒ đỏ (hạ trần / báo PM).
  let s4 = null, s5 = null, hold = null
  if (PG15 && lk.ok) {
    const at8 = async (what, pl, req) => {
      await X.db.query(`SET statement_timeout = '8s'`)
      const s = performance.now()
      try {
        const r = await settle(L.as(X.db, U.super, () => X.db.query(SAVE_SUPER, [P.id, sy.runId, pl, REASON, req]), 'authenticated'))
        return r.ok ? r.v.rows[0].r : { err: /CMS_[A-Z0-9_]+/.exec(r.err)?.[0] ?? r.err.slice(0, 120) }
      } finally { calls.push({ what, ms: Math.round(performance.now() - s) }); await X.db.query('RESET statement_timeout') }
    }
    s4 = await at8('report_save_super s4 (statement_timeout 8 s)', payload([...pre, ...post], 'qa-bench-ct-s4'), '00000000-0000-4000-8000-0000000b3c04')
    hold = calls.find((c) => c.what.startsWith('report_save s1'))?.ms ?? 0
    const Bc = await pgConn(X.dbName)
    await Bc.query('BEGIN')
    await Bc.query('SELECT 1 FROM public.cms_programs WHERE id = $1 FOR UPDATE', [P.id])
    const release = new Promise((r) => setTimeout(() => { Bc.query('COMMIT').then(r, r) }, hold))
    const nRep = async () => (await X.one(`SELECT count(*)::int n FROM public.cms_return_close_reports WHERE program_id = $1`, [P.id])).n
    const n5 = await nRep()
    s5 = await at8(`report_save_super s5 (chờ khoá ${hold} ms, statement_timeout 8 s)`, payload([...pre, ...post], 'qa-bench-ct-s5'), '00000000-0000-4000-8000-0000000b3c05')
    await release
    // Chờ khoá + tính vượt 8 s ⇒ CHẤP NHẬN khi hỏng SẠCH: hết lock_timeout / statement_timeout (app map CMS_LOCK_TIMEOUT / CMS_STATEMENT_TIMEOUT),
    // 0 báo cáo mới; khoá nhả ⇒ lập lại ngay được dưới 8 s. Không nới timeout.
    if (s5?.saved !== true) {
      s5.clean = /lock timeout|statement timeout/.test(String(s5?.err ?? '')) && (await nRep()) === n5
      s5.retry = await at8('report_save_super s5r (lập lại sau khi khoá nhả)', payload([...pre, ...post], 'qa-bench-ct-s5r'), '00000000-0000-4000-8000-0000000b3c06')
    }
  }
  // s5 có tiêu chí riêng (chờ khoá của bên khác nằm trong số đo) ⇒ không tính vào "chậm nhất".
  const worst = calls.filter((c) => !/^report_save_super s5 \(/.test(c.what)).reduce((m, c) => (c.ms > m.ms ? c : m), { what: '-', ms: 0 })
  const by = (rx) => calls.filter((c) => rx.test(c.what)).reduce((m, c) => (c.ms > m.ms ? c : m), { what: '-', ms: 0 })
  const nEffPre = pre.filter((r) => r.return_status === 'COMPLETED').length, nEffPost = post.filter((r) => r.return_status === 'COMPLETED').length
  console.log(`  · [chốt contract ${mode}] ${N_SALES} dòng bán (${nSaleEv} sự kiện bán) / ${pre.length} phiếu trước chốt (${nEffPre} hiệu lực) + ${post.length} sau chốt (${nEffPost} hiệu lực, ${postSameRef} cùng dòng ref phiếu trước); sync ${syncMs} ms (${sy.status})`)
  console.log(`  · [chốt contract ${mode}] chậm nhất: ${worst.what} ${worst.ms} ms; stage ${by(/^stage/).ms} · seal ${by(/^seal /).what} ${by(/^seal /).ms} · publish ${by(/^publish/).ms} · preview ${by(/lock_preview/).ms} · chốt ${by(/program_lock$/).ms} ms`)
  console.log(`  · [chốt contract ${mode}] báo cáo / reader (ms): ${JSON.stringify(Object.fromEntries(calls.filter((c) => /report|payout/.test(c.what)).map((c) => [c.what, c.ms])))}`)
  ok(pol.ok && sy.status === 'published' && run?.cc === 'cms-calc-ret2-v2' && lk.ok && pay?.a === run.amt && pay.rp === FULL && nSaleEv > 0
    && s0.saved === true && s0.baselines_new === 0 && h0?.d === '0' && h0.f === pay.a
    && s1.saved === true && s1.baselines_new === nEffPost && h1?.n === nEffPre + nEffPost && h1.f === pay.a && ev1?.pre === nEffPre && ev1.z > 0
    && s2.saved === true && s2.already === false && s3.saved === true && s3.already === true && s3.report_id === s2.report_id
    && rl?.lines?.length > 0 && re?.events?.length === Math.min(1000, h1?.n ?? -1) && rs?.reports?.length === 3 && pr?.program_total === pay.a && pr.returns?.return_count > 0
    && (!PG15 || (s4?.saved === true && s4.already === false
      && ((s5?.saved === true && s5.already === false && (calls.find((c) => c.what.startsWith('report_save_super s5 ('))?.ms ?? 1e9) < 8000)
          || (s5?.clean === true && s5.retry?.saved === true && s5.retry.already === false))))
    && worst.ms < 8000,
  `bench chốt run contract full_line [${mode}] ${N_SALES} dòng / ${N_RET} phiếu: sync + chốt (payout = số RÒNG đã seal) + báo cáo s0 Δ 0 / s1 cron đủ trần / s2 super / s3 phát lại + reader${PG15 ? ` + s4 super dưới statement_timeout 8 s / s5 chờ khoá ${hold} ms rồi lập (8 s bao cả chờ)` : ''}; mọi lời gọi < 8 s (chậm nhất ${worst.what} ${worst.ms} ms)`,
  JSON.stringify({ pol: pol.ok ? 'ok' : pol.err, sy: [sy.status, sy.code ?? null], cc: run?.cc, lk, pv: pv.ok ? pv.preview.blockers : pv, pay, nSaleEv,
    s0: [s0.saved, s0.baselines_new, s0.code], h0, s1: [s1.saved, s1.baselines_new, s1.code], h1, ev1, s2: [s2.saved, s2.already, s2.code], s3: [s3.saved, s3.already, s3.report_id === s2.report_id], ev: re?.events?.length,
    rs: rs?.reports?.length, pt: pr?.program_total, s4: s4 && [s4.saved, s4.already, s4.err], s5: s5 && [s5.saved, s5.already, s5.err, s5.clean, s5.retry?.saved], hold, worst }).slice(0, 900))
}

try {
  await main()
} catch (e) {
  fail++
  console.error('LỖI HARNESS:', e?.stack ?? e)
} finally {
  for (const c of closers.reverse()) { try { await c() } catch { /* */ } }
}
console.log(`\n${fail === 0 ? 'ĐẠT' : 'ĐỎ'} — ${pass} đạt · ${fail} đỏ`)
// embedded-postgres gắn async-exit-hook (beforeExit ⇒ exit 0) — chờ stdout xả rồi thoát TƯỜNG MINH theo kết quả (bài học r4 §5).
await new Promise((r) => process.stdout.write('', r))
process.exit(fail === 0 ? 0 : 1)
