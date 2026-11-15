// QA candidate migration 130 (CMS-CALC-RET-2 — thiết kế Dev r2) trên chuỗi migration THẬT 120 → 126 + marker 127 giả lập (127 là datafix
// ghim đúng chương trình T11 thật — không áp được lên DB thử; 127 không đổi schema / hàm). PGlite (mặc định, Postgres 16 WASM);
// PG15 thật: `--pg15 <embedded-postgres-dir> <data-root>` (lát sau). KHÔNG chạm DB thật / nguồn thật / mạng.
//   §0 generator ↔ file (byte) · LF · thân nền 25 hàm = md5 ma trận VERIFY (bản cuối 120–126)
//   §1 áp 130: backfill chương trình (pos_base / legacy_migration / sales_only_v1), không đổi config_version / pointer; ACL ma trận;
//      tổng hàm; trigger ALWAYS; marker
//   §2 parity TS ↔ SQL: cms__src_clean (quét toàn BMP × 3 mẫu + ngoài BMP) · cms__unit_key (quét toàn BMP × 3 mẫu + case / NFC) ·
//      cms__qty_dec (vector + fuzz) · cms__return_status_effect · cms__return_fp (vector độc lập + fuzz ngoài BMP / scale 9 / µs)
//   §3 tương thích chương trình: save 121 ⇒ legacy_compat · import / kích hoạt 125 · save_v2 (pos_base / cms_unit / pending; thiếu / sai;
//      đổi ngoài nháp) · trigger (INSERT mang basis · UPDATE ngoài nháp · không bump · về legacy) · SP vào pending · đơn vị vô hình
//      cms_unit (import / kích hoạt) · set_returns_policy (stale / ok / already / lùi / thiếu basis) · capabilities theo vai trò ·
//      đồng bộ legacy công bố qua basis guard
//   §4 rollback: dừng khi có chế độ mới; gỡ về nền (68 hàm, không cột, không marker); áp lại được
//   §5 dán CRLF (Studio) ≡ LF
//   §6 preflight dừng, 0 delta: thiếu 127 · có số > 127 · run running · thân ghim lệch · ACL hàm thay lệch · đã có cột 130
//   npm i --no-save @electric-sql/pglite@0.2.17 ; node scripts/qa-cms-130.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'
import * as L from './lib-care-pglite.mjs'
import { buildCms130, CMS_130_FILE, CMS_130_ROLLBACK_FILE, CMS_130_NEW, CMS_130_REPLACED, CMS_130_PINNED, CMS_130_FN_BEFORE, CMS_130_SRC_TRIM } from './gen-cms-130.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIG = path.join(HERE, '..', '..', 'supabase', 'migrations')
const SQL = (f) => fs.readFileSync(path.join(MIG, f), 'utf8')
const SQL_130 = fs.readFileSync(CMS_130_FILE, 'utf8')
const RB_130 = fs.readFileSync(CMS_130_ROLLBACK_FILE, 'utf8')
const jiti = createJiti(import.meta.url, { interopDefault: true, alias: { '@': path.join(HERE, '..') } })
const lib = (p) => jiti.import(path.join(HERE, '..', p))
const T = await lib('e2e/cmsQaTooling.ts')
const C = await lib('lib/cms/source/contract.ts')
const SS = await lib('lib/cms/salesSync.ts')
const FX = await lib('e2e/cmsFixtureRunner.ts')
const QR = await lib('e2e/cmsQaResults.ts')
const UK = await lib('lib/cms/unitKey.ts')
const FP = await lib('lib/cms/calc/fp.ts')
const RT = await lib('lib/cms/calc/returns.ts')
const DEC = await lib('lib/cms/decimal.ts')
const NET = await lib('lib/cms/calc/net.ts')
const CS = await lib('lib/cms/calc/contractStage.ts')
const SD = await lib('lib/cms/calc/srcDigest.ts')
const RS = await lib('lib/cms/resultStage.ts')
const TM = await lib('lib/cms/time.ts')
const PLc = await lib('lib/cms/calc/policy.ts')
const LA = await lib('lib/cms/lockAction.ts')
const CR = await lib('lib/cms/calc/closeReport.ts')
const CF = await lib('e2e/cmsContractFixture.ts')
const { U, storeId, STORES, sha } = L

let pass = 0, fail = 0
const ok = (c, name, extra = '') => { if (c) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) } }
const section = (s) => console.log(`\n${s}`)
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, err: String(e?.message ?? e) }))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CRLF = (s) => s.split('\n').join('\r\n')
const T3 = [{ order: 1, from: 1, to: 9, amount: '15000' }, { order: 2, from: 10, to: null, amount: '20000' }]
/** JSON khoá sắp (jsonb tự sắp khoá ⇒ so nội dung, không so thứ tự khoá). */
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x))
const code = (r) => (r.ok ? 'OK' : (/\bCMS_[A-Z0-9_]+\b/.exec(r.err)?.[0] ?? r.err.slice(0, 160)))

// ── §0 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
section('0. Generator ↔ file · LF · md5 thân nền')
const GEN = buildCms130()
ok(GEN.migration === SQL_130 && GEN.rollback === RB_130, 'scripts/gen-cms-130.mjs sinh ĐÚNG byte 130 + rollback trên đĩa')
ok(!SQL_130.includes('\r') && !RB_130.includes('\r'), '130 + rollback giữ LF')
const expectSrc = (name) => T.CMS_FN_SRC_126?.[name] ?? T.CMS_FN_SRC_125?.[name] ?? T.CMS_FN_SRC_124?.[name] ?? T.CMS_FN_SRC_123?.[name] ?? T.CMS_FN_MATRIX[name]?.src
const baseBad = [...CMS_130_REPLACED, ...CMS_130_PINNED].filter((x) => GEN.md5s.base[x.name].md5 !== expectSrc(x.name))
ok(CMS_130_REPLACED.length === 13 && CMS_130_PINNED.length === 12 && baseBad.length === 0,
  `25 thân nền (13 thay + 7 ghim + 5 guard 127) = md5 ma trận VERIFY bản cuối`, baseBad.map((x) => `${x.name} ${GEN.md5s.base[x.name].md5.slice(0, 8)}/${String(expectSrc(x.name)).slice(0, 8)}`).join(' '))
ok(['cms__programs_result_guard', 'cms__programs_guard', 'cms__config_auth_guard', 'cms__config_lock_guard', 'cms__programs_lock_guard',
  'cms__tiers_last_open_guard'].every((g) => CMS_130_PINNED.some((x) => x.name === g)), '6 guard 127 đều trong nhóm ghim')
const CODE_130 = SQL_130.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
ok(!/\bUPDATE public\.cms_programs\b(?![\s\S]{0,40}SET (quantity_basis|returns_policy))/.test(CODE_130.split('CREATE FUNCTION')[0])
  && !/DISABLE TRIGGER|session_replication_role/.test(CODE_130), 'phần DDL không UPDATE cms_programs / không DISABLE TRIGGER / session_replication_role')

// ── backend ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// PGlite (mặc định) hoặc PostgreSQL 15 thật nhúng (`--pg15 <thư mục có embedded-postgres + pg> <data-root>`; chỉ 127.0.0.1, dữ liệu tạm).
const PG15 = process.argv[2] === '--pg15'
let PGlite = null, cluster = null, pgMod = null
const PG_PORT = 54356, PG_PASS = 'qa-local-only'
if (!PG15) {
  try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { console.error('FAIL: thiếu @electric-sql/pglite — npm i --no-save @electric-sql/pglite@0.2.17'); process.exit(2) }
}
const closers = []
let dbSeq = 0
/** Kết nối thêm vào cùng DB PG15 (race 2 kết nối). */
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
    cluster = new EmbeddedPostgres({ databaseDir: path.join(path.resolve(dataRoot), `pgdata-cms130-${Date.now()}`), user: 'postgres', password: PG_PASS,
      port: PG_PORT, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
      onLog: (m) => { if (process.env.CMS130_PGLOG) fs.appendFileSync(process.env.CMS130_PGLOG, `${m}\n`) },
      onError: (m) => { if (process.env.CMS130_PGLOG) fs.appendFileSync(process.env.CMS130_PGLOG, `${m}\n`) } })
    await cluster.initialise(); await cluster.start()
    closers.unshift(() => cluster.stop())
  }
  const name = `rpgcms130_${tag.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_${++dbSeq}`
  const admin = await pgConn('postgres')
  await admin.query(`CREATE DATABASE ${name} ENCODING 'UTF8' TEMPLATE template0`)
  const c = await pgConn(name)
  const wrap = { exec: (sql) => c.query(sql).then((r) => (Array.isArray(r) ? r : [r])), query: (sql, p) => c.query(sql, p), close: () => c.end() }
  // Role là đối tượng CẤP CLUSTER: DB thứ 2+ bỏ 3 lệnh CREATE ROLE của freshDb (như qa-cms-125).
  const rolesExist = (await c.query(`SELECT count(*)::int n FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')`)).rows[0].n === 3
  const ROLES = 'CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;'
  function FakePGlite() { return rolesExist ? { ...wrap, exec: (sql) => wrap.exec(sql.split(ROLES).join('')) } : wrap }
  await L.freshDb(FakePGlite)
  return { db: wrap, dbName: name }
}

/** DB nền 127 (120 → 126 thật + marker 127), chương trình legacy có run công bố + nháp legacy. */
async function env(tag, { apply = true, crlf = false } = {}) {
  const { db, dbName } = await makeDb(tag)
  const one = async (sql, p = []) => (await db.query(sql, p)).rows[0]
  const all = async (sql, p = []) => (await db.query(sql, p)).rows
  const svc = (sql, params = []) => L.as(db, null, () => db.query(sql, params), 'service_role')
  await db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('117','t'),('118','t'),('118a','t'),('119','t'),('119a','t') ON CONFLICT DO NOTHING`)
  for (const f of ['120_cms_foundation.sql', '121_cms_import_activation.sql', '122_cms_results.sql', '123_cms_payouts.sql', '124_cms_source_attestation.sql',
    '125_cms_uncapped_last_tier.sql', '126_cms_sales_only_results_release.sql']) { await db.exec(SQL(f)); await sleep(10) }
  // 127 = datafix ghim T11 thật (không áp được trên DB thử, không đổi schema / hàm) ⇒ chỉ marker để preflight 130 thấy nền 127.
  await db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('127', 'cms_t11_flat_amounts')`)
  await db.query(`INSERT INTO public.cms_product_master (product_id, product_name, is_active, source_updated_at)
    SELECT g::text, 'SP giả ' || g, true, now() FROM generate_series(948001, 948200) g`)
  await db.query(`INSERT INTO public.cms_qa_access (user_id, granted_by, expires_at) VALUES ($1, 'qa-script:cms-130', now() + interval '6 hours')`, [U.super])
  let pidNext = 948001, seqf = 0, lineSeq = 0
  const pid = () => String(pidNext++)
  const day = async (n) => { const t = (await one(`SELECT public.cms__vn_today()::text d`)).d; const d = new Date(`${t}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
  const prodPayload = (p) => ({ product_id: p.pid, gmv_basis: p.basis ?? 'none', target_gmv: p.target ?? null, base_quantity_cms: p.k ?? '1', tiers: p.tiers ?? T3,
    unit_cms: p.unit ?? 'hộp', advice_text: `Tư vấn QA ${p.pid}`, name_snapshot: `SP giả ${p.pid}`, image_url_snapshot: null, price_snapshot: null })
  async function preview(id, mode = 'replace') {
    const fileSha = sha(`f130-${tag}-${++seqf}`), digest = sha(`d130-${tag}-${seqf}`)
    const run = (await svc(`SELECT public.rpc_cms_import_preview_save($1::jsonb) id`, [JSON.stringify({ program_id: id, mode, file_name: 'qa.xlsx', file_sha256: fileSha,
      file_bytes: 10, actor: U.super, stats: { rowsTotal: 1, rowsOk: 1, rowsRejected: 0, warnings: 0, productsOk: 1, productsRejected: 0 }, result: { digest } })])).rows[0].id
    return { run, fileSha, digest }
  }
  const commit = async (pr, mode, products, catalogTarget = null) => (await svc(`SELECT public.rpc_cms_import_commit($1, $2, $3, $4::jsonb, $5) r`,
    [pr.run, pr.fileSha, pr.digest, JSON.stringify({ mode, catalog_target: catalogTarget, products: products.map(prodPayload) }), U.super])).rows[0].r
  const progPayload = async (name, isTest, extra = {}) => ({ actor: U.super, name, start_date: await day(-7), end_date: await day(22),
    scope: 'stores', store_ids: [storeId(1), storeId(2)], is_test: isTest, ...extra })
  async function makeProgram({ name, isTest = false, products, activate = true, v2 = null, dates = null, catalogTarget = null }) {
    const payload = await progPayload(name, isTest, { ...(v2 ? { quantity_basis: v2 } : {}), ...(dates ? { start_date: dates[0], end_date: dates[1] } : {}) })
    const id = (await svc(`SELECT public.${v2 ? 'rpc_cms_program_save_v2' : 'rpc_cms_program_save'}($1::jsonb) id`, [JSON.stringify(payload)])).rows[0].id
    if (products) await commit(await preview(id), 'replace', products, catalogTarget)
    if (activate) await svc(`SELECT public.rpc_cms_program_activate($1, $2)`, [id, U.super])
    const p = await one(`SELECT start_date::text s, end_date::text e FROM public.cms_programs WHERE id = $1`, [id])
    return { id, products, start: p.s, end: p.e, isTest }
  }
  const SELLERS = [STORES[0].assigneeEmails[0], STORES[0].assigneeEmails[1], STORES[1].assigneeEmails[0]]
  function rows(p, specs) {
    const t0 = Date.parse(`${p.start}T01:00:00Z`)
    const out = specs.map((sp) => {
      const id = ++lineSeq
      const at = new Date(t0 + id * 1000).toISOString()
      return { order_line_id: String(948000000 + id), order_id: `O${id}`, order_code: `QA-${id}`, product_id: sp.pid, seller_email: SELLERS[sp.s], pos_code: 'QAOS01',
        order_type: 'OFFLINE', order_status: 'COMPLETED', completed_at: at, quantity_raw: '1', uom_raw: 'Hộp', base_quantity: String(sp.base), gmv_amount: sp.gmv ?? '100000', source_updated_at: at }
    })
    for (const r of out) if (!C.normalizeSalesRow(r).ok) throw new Error('dòng giả lỗi')
    return out
  }
  const rpc = async (sql, params) => { try { return (await svc(sql, params)).rows[0].r } catch (e) { const m = /\bCMS_[A-Z0-9_]+\b/.exec(String(e.message)); throw new Error(m ? m[0] : `RPC_FAILED ${String(e.message).slice(0, 120)}`) } }
  const syncDeps = (rws) => ({
    table: QR.CMS_QA_FAKE_TABLE, runner: FX.createCmsFixtureRunner({ sales: rws }),
    loadSnapshot: (id) => rpc(`SELECT public.rpc_cms_sales_snapshot($1) r`, [id]),
    openRun: (id, detail) => rpc(`SELECT public.rpc_cms_sales_run_open($1, $2::jsonb) r`, [id, JSON.stringify(detail)]),
    stage: async (runId, part, chunkNo, x) => Number(await rpc(`SELECT public.rpc_cms_sales_run_stage($1, $2, $3, $4::jsonb) r`, [runId, part, chunkNo, JSON.stringify(x)])),
    sealBegin: (runId, expect) => rpc(`SELECT public.rpc_cms_sales_run_seal_begin($1, $2::jsonb) r`, [runId, JSON.stringify(expect)]),
    sealStep: (runId, step) => rpc(`SELECT public.rpc_cms_sales_run_seal_step($1, $2) r`, [runId, step]),
    publish: (runId) => rpc(`SELECT public.rpc_cms_sales_run_publish($1) r`, [runId]),
    finish: async (runId, status, detail) => { await rpc(`SELECT public.rpc_cms_sales_run_finish($1, $2, $3::jsonb) r`, [runId, status, JSON.stringify(detail)]) },
    cleanup: (id, max) => rpc(`SELECT public.rpc_cms_sales_run_cleanup($1, $2) r`, [id, max]),
    now: () => Date.now(),
  })
  const sync = (p, rws) => SS.runCmsSalesSync(syncDeps(rws), p.id, { dryRun: false, source: 'cron', sourceCapture: true })
  const syncQa = (p, rws) => SS.runCmsSalesSync(syncDeps(rws), p.id, { dryRun: false, source: 'qa', sourceCapture: true })
  const prog = (id) => one(`SELECT status, config_version v, current_result_run_id::text ptr, quantity_basis b, quantity_basis_source src,
    returns_policy pol, quantity_basis_set_by::text sb, returns_policy_set_by::text pb FROM public.cms_programs WHERE id = $1`, [id])

  // Trước 130: chương trình thật có run công bố, nháp legacy, QA.
  const LIVE = await makeProgram({ name: 'QA thật trước 130', products: [{ pid: pid(), k: '10' }, { pid: pid(), k: '1' }] })
  const DRAFT0 = await makeProgram({ name: 'QA nháp trước 130', products: [{ pid: pid(), k: '2' }], activate: false })
  const LIVE_ROWS = rows(LIVE, [{ pid: LIVE.products[0].pid, s: 0, base: 120 }, { pid: LIVE.products[1].pid, s: 1, base: 7 }])
  const r0 = await sync(LIVE, LIVE_ROWS)
  if (r0.status !== 'published') throw new Error('nền: đồng bộ trước 130 không công bố ' + JSON.stringify(r0).slice(0, 200))
  const before = {
    progs: await all(`SELECT id::text, config_version, current_result_run_id::text ptr, status FROM public.cms_programs ORDER BY id`),
  }
  let applied = null
  if (apply) applied = await settle(db.exec(crlf ? CRLF(SQL_130) : SQL_130))
  return { db, dbName, one, all, svc, rpc, sync, syncQa, rows, prog, pid, preview, commit, makeProgram, progPayload, LIVE, DRAFT0, LIVE_ROWS, before, applied, day }
}

const aclMatrix = async (E) => E.all(`SELECT p.oid::regprocedure::text sig, has_function_privilege('anon', p.oid, 'EXECUTE') a,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') u, has_function_privilege('service_role', p.oid, 'EXECUTE') s, p.prosecdef d,
  p.proconfig cfg FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY ($1)`, [CMS_130_NEW.map((x) => x.name)])
const cmsFnCount = async (E) => Number((await E.one(`SELECT count(*)::int n FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND (proname LIKE 'cms\\_%' OR proname LIKE 'rpc\\_cms\\_%')`)).n)

async function main() {
  // Chẩn đoán hiệu năng: chỉ §10 (không phải gate — lượt gate luôn chạy đủ).
  if (PG15 && process.env.CMS130_ONLY === 'bench') {
    section('10. Bench PG15 (CHỈ bench — chẩn đoán, không phải gate)')
    await benchSection()
    return
  }
  // Lượt đột biến: chỉ một mục độc lập (env riêng). Không phải gate.
  if (process.env.CMS130_ONLY === 'contract') { section('7. (CHỈ §7 — lượt đột biến)'); await contractSection(); return }
  if (process.env.CMS130_ONLY === 'report') { section('8. (CHỈ §8 — lượt đột biến)'); await reportSection(); return }
  if (process.env.CMS130_ONLY === 'worker') { section('11. (CHỈ §11)'); await workerSection(); return }
  // ── §1 ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section(`1. Áp 130 trên nền 127 (${PG15 ? 'PostgreSQL 15 nhúng' : 'PGlite'})`)
  const E = await env('main')
  const ver = (await E.one(`SELECT current_setting('server_version_num')::int n, current_setting('server_version') v`))
  console.log(`  · backend: PostgreSQL ${ver.v}${PG15 ? ' (embedded, 127.0.0.1)' : ' (PGlite WASM)'}`)
  if (PG15) ok(ver.n >= 150000 && ver.n < 160000, `PostgreSQL 15 thật (${ver.v}) — RET2-R2-04`)
  ok(E.applied.ok, 'áp 130 thành công', E.applied.err)
  const after = await E.all(`SELECT id::text, config_version, current_result_run_id::text ptr, status, quantity_basis b, quantity_basis_source src,
    returns_policy pol, quantity_basis_set_by sb, quantity_basis_set_at sa, returns_policy_set_by pb FROM public.cms_programs ORDER BY id`)
  ok(after.length === E.before.progs.length && after.every((r, i) => r.config_version === E.before.progs[i].config_version && r.ptr === E.before.progs[i].ptr
    && r.status === E.before.progs[i].status), 'config_version / pointer / trạng thái mọi chương trình KHÔNG đổi')
  ok(after.every((r) => r.b === 'pos_base' && r.src === 'legacy_migration' && r.pol === 'sales_only_v1' && r.sb === null && r.sa === null && r.pb === null),
    'backfill: mọi chương trình có sẵn = pos_base / legacy_migration / sales_only_v1, không actor')
  const acl = await aclMatrix(E)
  const aclBad = CMS_130_NEW.filter((x) => { const r = acl.find((a) => a.sig.startsWith(`${x.name}(`)); return !r || r.a || r.u !== x.grant.includes('authenticated') || r.s !== x.grant.includes('service_role') || !r.d || !(r.cfg ?? []).includes('search_path=public') })
  ok(acl.length === CMS_130_NEW.length && aclBad.length === 0, `ACL ${CMS_130_NEW.length} hàm mới đúng ma trận (anon 0; SECDEF; search_path)`, aclBad.map((x) => x.name).join(' '))
  const dash = await E.all(`SELECT p.proname FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE p.proname = ANY ($1) AND a.grantee = 'dashboard_qa'::regrole`, [CMS_130_NEW.map((x) => x.name)])
  ok(dash.length === 0, 'default privileges kiểu Supabase (dashboard_qa) bị thu hồi trên mọi hàm mới')
  ok(await cmsFnCount(E) === CMS_130_FN_BEFORE + CMS_130_NEW.length, `tổng hàm CMS = ${CMS_130_FN_BEFORE} + ${CMS_130_NEW.length}`)
  const trg = await E.all(`SELECT tgname, tgenabled FROM pg_trigger WHERE tgname IN ('cms_programs_basis_guard', 'cms_products_basis_guard') ORDER BY 1`)
  ok(trg.length === 2 && trg.every((t) => t.tgenabled === 'A'), '2 trigger basis ENABLE ALWAYS')
  const mk = await E.one(`SELECT name, notes FROM public.app_migrations WHERE version = '130'`)
  ok(mk?.name === 'cms_calculation_modes_returns' && JSON.parse(mk.notes).new_functions === CMS_130_NEW.length, 'marker 130 + notes JSON')
  const again = await settle(E.db.exec(SQL_130))
  ok(!again.ok && /đã có marker 130/.test(again.err), 'chạy lại 130 bị chặn (marker)', again.err?.slice(0, 120))
  await E.db.exec('ROLLBACK').catch(() => {})

  // ── §2 parity ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section('2. Parity TS ↔ SQL (PGlite)')
  const sqlMap = async (fn, inputs, cast = 'text') => {
    const out = []
    for (let i = 0; i < inputs.length; i += 20000) {
      const part = inputs.slice(i, i + 20000)
      const rs = await E.all(`SELECT t.i, public.${fn}(t.v)::text r FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS t0(e, i)
        CROSS JOIN LATERAL (SELECT t0.i, CASE WHEN jsonb_typeof(t0.e) = 'null' THEN NULL ELSE (t0.e #>> '{}')::${cast} END v) t ORDER BY t.i`, [JSON.stringify(part)])
      for (const r of rs) out.push(r.r)
    }
    return out
  }
  const BMP = []
  for (let cp = 1; cp <= 0xffff; cp++) if (cp < 0xd800 || cp > 0xdfff) BMP.push(String.fromCodePoint(cp))
  const ASTRAL = ['\u{1F600}', '\u{10000}', '\u{E0001}', '\u{E0020}', '\u{1D173}', '\u{10FFFF}', '\u{20000}']
  // cms__src_clean
  {
    const inputs = []
    for (const ch of [...BMP, ...ASTRAL]) inputs.push(`${ch}2${ch}`, `2${ch}2`, ch)
    inputs.push(null, '', ' ', '  hộp  ', '\t2\n', '​', '﻿2﻿', '᠎2', '\u0085x\u0085')
    const got = await sqlMap('cms__src_clean', inputs)
    const bad = inputs.map((v, i) => [v, got[i], FP.cmsSrcClean(v)]).filter(([, g, w]) => g !== w)
    ok(bad.length === 0, `cms__src_clean = cmsSrcClean trên ${inputs.length} chuỗi (toàn BMP × 3 mẫu + ngoài BMP + biên)`,
      bad.slice(0, 3).map(([v, g, w]) => `${JSON.stringify(v)}: sql ${JSON.stringify(g)} ts ${JSON.stringify(w)}`).join(' | '))
    // Tập cắt của generator = tập đo bằng JS (tự kiểm lại, không tin hằng).
    const measured = BMP.filter((ch) => FP.cmsSrcClean(`${ch}2`) === '2' && !/[\u0000-\u001F\u007F-\u009F]/.test(ch)).map((c) => c.codePointAt(0))
    ok(JSON.stringify(measured) === JSON.stringify([...CMS_130_SRC_TRIM]), 'CMS_130_SRC_TRIM = tập trim đo trên toàn BMP', measured.map((c) => c.toString(16)).join(','))
  }
  // cms__unit_key
  {
    const inputs = []
    for (const ch of [...BMP, ...ASTRAL]) inputs.push(ch, `Hộp${ch}`, `${ch}viên${ch}`)
    inputs.push('HỘP', 'Hộp', '  Vỉ　', 'BOX', 'hộp hộp', '', '  ', '­hộp', 'ẠẢẤẦẨẪẬ', 'Ỹ', 'ǅ', 'İ', 'ß', 'Σ')
    const got = await sqlMap('cms__unit_key', inputs)
    const bad = inputs.map((v, i) => [v, got[i], UK.cmsUnitKey(v)]).filter(([, g, w]) => g !== w)
    ok(bad.length === 0, `cms__unit_key = cmsUnitKey (${UK.CMS_UNIT_KEY_VERSION}) trên ${inputs.length} chuỗi (toàn BMP × 3 mẫu + case / NFC)`,
      bad.slice(0, 3).map(([v, g, w]) => `${JSON.stringify(v)}: sql ${JSON.stringify(g)} ts ${JSON.stringify(w)}`).join(' | '))
  }
  // cms__qty_dec
  {
    const fixed = ['0', '-0', '00', '007', '1', '-1', '2.5', '2.50', '0.000000001', '0.0000000001', '-0.000000001', '1.', '.5', '+1', ' 1', '1 ', '1e3',
      '1,5', '١٢', '12345678901234567890123456789', '123456789012345678901234567890', '000123456789012345678901234567890', '-12345678901234567890123456789.123456789',
      '9223372036854775807', '9223372036854775808', '1.0000000000', '', '−1', '0x10', 'NaN', 'Infinity', '1_000']
    let seed = 130
    const R = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const fuzz = Array.from({ length: 3000 }, () => {
      const sign = R() < 0.2 ? '-' : ''
      const int = '0'.repeat(R() < 0.2 ? 2 : 0) + String(Math.floor(R() * 10 ** Math.floor(R() * 12)))
      const frac = R() < 0.5 ? '' : '.' + String(Math.floor(R() * 10 ** 12)).padStart(Math.floor(R() * 12) + 1, '0').slice(0, Math.floor(R() * 12) + 1)
      return sign + int + frac
    })
    const inputs = [...fixed, ...fuzz]
    const got = await sqlMap('cms__qty_dec', inputs)
    const want = inputs.map((v) => { const q = UK.cmsUnitQuantity(v); return q.ok ? DEC.formatCmsDecimal(q.units) : null })
    const norm = (s) => (s === null ? null : DEC.formatCmsDecimal(DEC.parseCmsDecimal(s, { allowNegative: true }).units))
    const bad = inputs.map((v, i) => [v, got[i], want[i]]).filter(([, g, w]) => norm(g) !== w)
    ok(bad.length === 0, `cms__qty_dec ≡ cmsUnitQuantity trên ${inputs.length} chuỗi (biên + fuzz; NULL ⇔ lỗi)`,
      bad.slice(0, 4).map(([v, g, w]) => `${JSON.stringify(v)}: sql ${g} ts ${w}`).join(' | '))
  }
  // cms__return_status_effect
  {
    const inputs = ['COMPLETED', 'APPROVED', 'completed', 'Completed', ' COMPLETED', 'COMPLETED ', 'COMPLETED​', 'COMPLETED\t', 'APPROVED\u0085',
      'REJECTED', 'CANCELLED', '', null, 'constructor', '__proto__', 'toString', 'ＣＯＭＰＬＥＴＥＤ', 'COMPLETE', 'APPROVE']
    const got = await sqlMap('cms__return_status_effect', inputs)
    const want = inputs.map((v) => (v === null ? null : RT.CMS_RETURN_STATUS_DICTIONARY.get(v) ?? null))
    const bad = inputs.map((v, i) => [v, got[i], want[i]]).filter(([, g, w]) => g !== w)
    ok(bad.length === 0, `cms__return_status_effect = từ điển ${RT.CMS_RETURN_STATUS_DICTIONARY_VERSION} (khớp byte, ${inputs.length} biến thể)`, JSON.stringify(bad.slice(0, 3)))
  }
  // cms__return_fp
  {
    const P = '11111111-1111-1111-1111-111111111111'
    const base = { programId: P, returnEventId: 'RT1', returnDocumentId: 'D1', originalOrderLineId: '9001', originalOrderId: 'O1', productId: '2004764',
      baseUnits: BigInt(6) * DEC.CMS_DEC_FACTOR, refundUnits: BigInt(53500) * DEC.CMS_DEC_FACTOR, recordedAtMicros: BigInt('1763000000000000') }
    const cases = [base, { ...base, returnEventId: '\u{1F600}ä' }]
    let seed = 7
    const R = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const pick = (a) => a[Math.floor(R() * a.length)]
    const IDS = ['RT1', '007', '7', 'ä', '\u{1F600}', 'a\u0000'.slice(0, 1), 'x'.repeat(100), '\u{10FFFF}z', 'Ω≈ç√', '0']
    for (let i = 0; i < 400; i++) {
      const micros = BigInt(1700000000000000 + Math.floor(R() * 1e14)) * (R() < 0.1 ? BigInt(1) : BigInt(1))
      cases.push({ programId: R() < 0.5 ? P : '22222222-2222-4222-8222-222222222222', returnEventId: pick(IDS) + i, returnDocumentId: pick(IDS),
        originalOrderLineId: pick(IDS), originalOrderId: pick(IDS), productId: String(1 + Math.floor(R() * 1e7)),
        baseUnits: BigInt(1 + Math.floor(R() * 1e6)) * DEC.CMS_DEC_FACTOR, refundUnits: BigInt(Math.floor(R() * 1e15)), recordedAtMicros: micros })
    }
    const toTs = (us) => { const ms = us / BigInt(1000); const rem = us % BigInt(1000); return new Date(Number(ms)).toISOString().replace('Z', String(rem).padStart(3, '0') + 'Z') }
    const rs = await E.all(`SELECT t.i, public.cms__return_fp('cms-return-fp-v1', (e->>'p')::uuid, e->>'id', e->>'doc', e->>'ol', e->>'o', e->>'pid',
        (e->>'b')::numeric, (e->>'r')::numeric, (e->>'at')::timestamptz) fp
      FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS t(e, i) ORDER BY t.i`,
      [JSON.stringify(cases.map((c) => ({ p: c.programId, id: c.returnEventId, doc: c.returnDocumentId, ol: c.originalOrderLineId, o: c.originalOrderId, pid: c.productId,
        b: DEC.formatCmsDecimal(c.baseUnits), r: DEC.formatCmsDecimal(c.refundUnits), at: toTs(c.recordedAtMicros) })))])
    const bad = cases.filter((c, i) => rs[i].fp !== FP.cmsReturnFinancialFp(c))
    ok(rs[0].fp === 'a7de0c1a1b3a63ff9d20aa1205c7f4546fe4c40046974038a414015d3d1469e1' && rs[1].fp === '0a9f1e30bdf0259fdc447308a309d2c03904ebe3351064d305c297d486c8a057',
      'cms__return_fp = vector độc lập sha256sum (ASCII / ngoài BMP)', `${rs[0].fp} ${rs[1].fp}`)
    ok(bad.length === 0, `cms__return_fp = cmsReturnFinancialFp trên ${cases.length} phiếu (fuzz ID ngoài BMP / refund scale 9 / µs)`, String(bad.length))
    const nul = await E.one(`SELECT public.cms__return_fp('cms-return-fp-v2', $1, 'a', 'b', 'c', 'd', '1', 1, 1, now()) v2,
      public.cms__return_fp('cms-return-fp-v1', $1, NULL, 'b', 'c', 'd', '1', 1, 1, now()) nid,
      public.cms__return_fp('cms-return-fp-v1', $1, 'a', 'b', 'c', 'd', '1', 1, 1, 'infinity') inf`, [P])
    ok(nul.v2 === null && nul.nid === null && nul.inf === null, 'cms__return_fp: version lạ / thiếu trường / thời điểm vô hạn ⇒ NULL')
  }

  // ── §3 tương thích chương trình ───────────────────────────────────────────────────────────────────────────────────────────────────
  section('3. Tương thích tạo / import / kích hoạt / mode / policy')
  {
    // App cũ / cờ OFF: save 121 ⇒ legacy_compat; import + kích hoạt 125 chạy.
    const P1 = await E.makeProgram({ name: 'QA cũ sau 130', products: [{ pid: E.pid(), k: '5' }] })
    const g1 = await E.prog(P1.id)
    ok(g1.b === 'pos_base' && g1.src === 'legacy_compat' && g1.status === 'active' && g1.sb === null, 'save 121 sau 130 ⇒ pos_base / legacy_compat; import + kích hoạt 125 OK', JSON.stringify(g1))
    // Đồng bộ legacy trên chương trình legacy_compat: publish (UPDATE pointer) đi qua basis guard.
    const rws = E.rows(P1, [{ pid: P1.products[0].pid, s: 0, base: 12 }])
    const s1 = await E.sync(P1, rws)
    ok(s1.status === 'published' && (await E.prog(P1.id)).ptr !== null, 'đồng bộ legacy sau 130 ⇒ công bố (pointer qua basis guard)', JSON.stringify(s1).slice(0, 160))
    // Chương trình có sẵn trước 130 đồng bộ lại vẫn công bố.
    const s0 = await E.sync(E.LIVE, E.LIVE_ROWS)
    ok(s0.status === 'published', 'chương trình có sẵn (legacy_migration) đồng bộ lại ⇒ công bố', JSON.stringify(s0).slice(0, 160))

    // save_v2
    const V = await E.makeProgram({ name: 'QA v2 pos_base', products: null, activate: false, v2: 'pos_base' })
    let g = await E.prog(V.id)
    ok(g.b === 'pos_base' && g.src === 'admin' && g.sb === U.super && g.v === 2, 'save_v2 tạo pos_base ⇒ admin + actor, config_version 2', JSON.stringify(g))
    const VU = await E.makeProgram({ name: 'QA v2 cms_unit', products: [{ pid: E.pid(), k: '10', unit: 'Hộp' }], activate: true, v2: 'cms_unit' })
    g = await E.prog(VU.id)
    ok(g.b === 'cms_unit' && g.src === 'admin' && g.status === 'active', 'save_v2 cms_unit + import + kích hoạt', JSON.stringify(g))
    const VP = await E.makeProgram({ name: 'QA v2 pending', products: null, activate: false, v2: 'pending' })
    g = await E.prog(VP.id)
    ok(g.b === null && g.src === 'pending' && g.sb === U.super, 'save_v2 pending ⇒ basis NULL / pending + actor', JSON.stringify(g))
    const impPending = await settle(E.commit(await E.preview(VP.id), 'replace', [{ pid: E.pid(), k: '1' }]))
    ok(code(impPending) === 'CMS_BASIS_NOT_SET', 'import vào nháp pending ⇒ CMS_BASIS_NOT_SET', code(impPending))
    const actPending = await settle(E.svc(`SELECT public.rpc_cms_program_activate($1, $2)`, [VP.id, U.super]))
    ok(!actPending.ok, 'kích hoạt nháp pending bị chặn', code(actPending))
    const pay = async (id, b, extra = {}) => settle(E.svc(`SELECT public.rpc_cms_program_save_v2($1::jsonb) id`, [JSON.stringify({ ...(await E.progPayload('QA sửa', false, extra)), id, ...(b === undefined ? {} : { quantity_basis: b }) })]))
    const toUnit = await pay(VP.id, 'cms_unit')
    g = await E.prog(VP.id)
    ok(toUnit.ok && g.b === 'cms_unit' && g.src === 'admin', 'nháp pending → cms_unit qua save_v2', code(toUnit))
    ok(code(await pay(VP.id, undefined)) === 'CMS_BASIS_REQUIRED' && code(await pay(VP.id, 'CMS_UNIT')) === 'CMS_BASIS_REQUIRED'
      && code(await pay(VP.id, 'legacy_compat')) === 'CMS_BASIS_REQUIRED', 'save_v2 thiếu / sai basis ⇒ CMS_BASIS_REQUIRED')
    const nm0 = (await E.one(`SELECT name FROM public.cms_programs WHERE id = $1`, [VU.id])).name
    const imm = await settle(E.svc(`SELECT public.rpc_cms_program_save_v2($1::jsonb) id`, [JSON.stringify({ ...(await E.progPayload('QA đổi tên', false)), id: VU.id, start_date: await E.day(1), quantity_basis: 'pos_base' })]))
    // (VU đã bắt đầu ⇒ 121 có thể chặn trước bằng NOT_EDITABLE; cả hai đều là "không đổi")
    ok(!imm.ok && ['CMS_BASIS_IMMUTABLE', 'CMS_PROGRAM_NOT_EDITABLE'].includes(code(imm)) && (await E.one(`SELECT name FROM public.cms_programs WHERE id = $1`, [VU.id])).name === nm0,
      'save_v2 đổi basis chương trình active ⇒ chặn, không đổi gì (rollback cả phần 121)', code(imm))
    // Active chưa bắt đầu: 121 cho sửa, v2 chặn đổi basis ⇒ rollback cả 121.
    const FUT = await E.makeProgram({ name: 'QA tương lai', products: null, activate: false, v2: 'pos_base' })
    await E.svc(`SELECT public.rpc_cms_program_save_v2($1::jsonb)`, [JSON.stringify({ ...(await E.progPayload('QA tương lai', false)), id: FUT.id, start_date: await E.day(3), end_date: await E.day(30), quantity_basis: 'pos_base' })])
    await E.commit(await E.preview(FUT.id), 'replace', [{ pid: E.pid(), k: '1' }])
    await E.svc(`SELECT public.rpc_cms_program_activate($1, $2)`, [FUT.id, U.super])
    const cvF = (await E.prog(FUT.id)).v
    const immF = await settle(E.svc(`SELECT public.rpc_cms_program_save_v2($1::jsonb)`, [JSON.stringify({ ...(await E.progPayload('QA tương lai đổi', false)), id: FUT.id, start_date: await E.day(4), end_date: await E.day(30), quantity_basis: 'cms_unit' })]))
    const gF = await E.one(`SELECT name, config_version v, start_date::text s FROM public.cms_programs WHERE id = $1`, [FUT.id])
    ok(code(immF) === 'CMS_BASIS_IMMUTABLE' && gF.name === 'QA tương lai' && gF.v === cvF && gF.s === await E.day(3),
      'active chưa bắt đầu: save_v2 đổi basis ⇒ CMS_BASIS_IMMUTABLE, phần sửa 121 rollback', `${code(immF)} ${JSON.stringify(gF)}`)
    const sameF = await settle(E.svc(`SELECT public.rpc_cms_program_save_v2($1::jsonb)`, [JSON.stringify({ ...(await E.progPayload('QA tương lai 2', false)), id: FUT.id, start_date: await E.day(4), end_date: await E.day(30), quantity_basis: 'pos_base' })]))
    ok(sameF.ok && (await E.prog(FUT.id)).src === 'admin', 'active chưa bắt đầu: save_v2 cùng basis ⇒ sửa được (121)', code(sameF))
    const LF = await E.makeProgram({ name: 'QA legacy tương lai', products: [{ pid: E.pid(), k: '1' }], dates: [await E.day(3), await E.day(30)] })
    const lf0 = await E.prog(LF.id)
    const sameL = await settle(E.svc(`SELECT public.rpc_cms_program_save_v2($1::jsonb)`, [JSON.stringify({ ...(await E.progPayload('QA legacy tương lai 2', false)), id: LF.id, start_date: await E.day(4), end_date: await E.day(30), quantity_basis: 'pos_base' })]))
    const lf1 = await E.prog(LF.id)
    const immL = await settle(E.svc(`SELECT public.rpc_cms_program_save_v2($1::jsonb)`, [JSON.stringify({ ...(await E.progPayload('QA legacy đổi', false)), id: LF.id, start_date: await E.day(4), end_date: await E.day(30), quantity_basis: 'cms_unit' })]))
    ok(lf0.status === 'active' && lf0.src === 'legacy_compat' && sameL.ok && lf1.src === 'legacy_compat' && lf1.b === 'pos_base' && code(immL) === 'CMS_BASIS_IMMUTABLE',
      'legacy active chưa bắt đầu: save_v2 cùng basis (pos_base) ⇒ sửa được, giữ nguồn legacy_compat; đổi basis ⇒ IMMUTABLE', JSON.stringify({ lf0, sameL: code(sameL), lf1, immL: code(immL) }))
    const actS = await settle(E.svc(`SELECT public.rpc_cms_program_save_v2($1::jsonb)`, [JSON.stringify({ ...(await E.progPayload('QA actor QLCH', false)), actor: U.qlch1, quantity_basis: 'pos_base' })]))
    const actP = await settle(E.svc(`SELECT public.rpc_cms_program_set_returns_policy($1, 'net_returns_v1', $2, $3)`, [FUT.id, (await E.prog(FUT.id)).v, U.qlch1]))
    ok(code(actS) === 'CMS_ACTOR_FORBIDDEN' && code(actP) === 'CMS_ACTOR_FORBIDDEN' && (await E.prog(FUT.id)).pol === 'sales_only_v1',
      'actor không phải admin (QLCH) ⇒ save_v2 / set_returns_policy CMS_ACTOR_FORBIDDEN, không đổi gì', `${code(actS)} ${code(actP)}`)

    // Trigger trực tiếp (owner).
    const ins = await settle(E.db.query(`INSERT INTO public.cms_programs (name, start_date, end_date, scope, is_test, created_by, updated_by, quantity_basis, quantity_basis_source)
      VALUES ('x', current_date, current_date, 'all', false, $1, $1, 'cms_unit', 'admin')`, [U.super]))
    ok(code(ins) === 'CMS_BASIS_INVALID', 'INSERT mang basis ⇒ CMS_BASIS_INVALID', code(ins))
    const insPol = await settle(E.db.query(`INSERT INTO public.cms_programs (name, start_date, end_date, scope, is_test, created_by, updated_by, returns_policy)
      VALUES ('x', current_date, current_date, 'all', false, $1, $1, 'net_returns_v1')`, [U.super]))
    ok(code(insPol) === 'CMS_RETURNS_POLICY_INVALID', 'INSERT mang net_returns_v1 ⇒ CMS_RETURNS_POLICY_INVALID', code(insPol))
    const updAct = await settle(E.db.query(`UPDATE public.cms_programs SET quantity_basis = 'cms_unit', quantity_basis_source = 'admin', quantity_basis_set_by = $2,
      quantity_basis_set_at = now(), config_version = config_version + 1 WHERE id = $1`, [E.LIVE.id, U.super]))
    ok(code(updAct) === 'CMS_BASIS_IMMUTABLE', 'UPDATE basis chương trình active ⇒ CMS_BASIS_IMMUTABLE', code(updAct))
    const updNoBump = await settle(E.db.query(`UPDATE public.cms_programs SET quantity_basis = 'cms_unit', quantity_basis_source = 'admin', quantity_basis_set_by = $2,
      quantity_basis_set_at = now() WHERE id = $1`, [E.DRAFT0.id, U.super]))
    ok(code(updNoBump) === 'CMS_BASIS_IMMUTABLE', 'UPDATE basis nháp không tăng config_version ⇒ CMS_BASIS_IMMUTABLE', code(updNoBump))
    const updLegacy = await settle(E.db.query(`UPDATE public.cms_programs SET quantity_basis_source = 'legacy_compat', config_version = config_version + 1 WHERE id = $1`, [V.id]))
    ok(code(updLegacy) === 'CMS_BASIS_INVALID', 'UPDATE về legacy_* ⇒ CMS_BASIS_INVALID', code(updLegacy))
    const updSet = await settle(E.db.query(`UPDATE public.cms_programs SET quantity_basis = NULL, quantity_basis_source = 'pending', quantity_basis_set_by = NULL,
      quantity_basis_set_at = NULL, config_version = config_version + 1 WHERE id = $1`, [V.id]))
    ok(!updSet.ok, 'UPDATE pending thiếu actor ⇒ CHECK chặn', code(updSet))

    // cms_unit + đơn vị vô hình: import vào nháp cms_unit bị chặn; nháp pos_base có SP vô hình chuyển cms_unit rồi kích hoạt bị chặn.
    const DU = await E.makeProgram({ name: 'QA unit vô hình', products: null, activate: false, v2: 'cms_unit' })
    const impInv = await settle(E.commit(await E.preview(DU.id), 'replace', [{ pid: E.pid(), k: '1', unit: 'hộp​' }]))
    ok(code(impInv) === 'CMS_UNIT_CMS_INVALID', 'import SP đơn vị vô hình vào nháp cms_unit ⇒ CMS_UNIT_CMS_INVALID', code(impInv))
    const DP = await E.makeProgram({ name: 'QA unit vô hình 2', products: [{ pid: E.pid(), k: '1', unit: 'hộp​' }], activate: false, v2: 'pos_base' })
    ok((await pay(DP.id, 'cms_unit')).ok, 'nháp pos_base có SP đơn vị vô hình → cms_unit (nháp được)')
    const actInv = await settle(E.svc(`SELECT public.rpc_cms_program_activate($1, $2)`, [DP.id, U.super]))
    ok(code(actInv) === 'CMS_UNIT_CMS_INVALID' && (await E.prog(DP.id)).status === 'draft', 'kích hoạt cms_unit có đơn vị vô hình ⇒ CMS_UNIT_CMS_INVALID', code(actInv))
    const appendInv = await settle(E.commit(await E.preview(VU.id, 'append'), 'append', [{ pid: E.pid(), k: '1', unit: '⁠viên' }]))
    ok(code(appendInv) === 'CMS_UNIT_CMS_INVALID', 'append SP đơn vị vô hình vào cms_unit active ⇒ CMS_UNIT_CMS_INVALID', code(appendInv))

    // set_returns_policy
    const cv = (await E.prog(VU.id)).v
    const pol = (pid0, p, v) => settle(E.svc(`SELECT public.rpc_cms_program_set_returns_policy($1, $2, $3, $4) r`, [pid0, p, v, U.super]))
    ok(code(await pol(VU.id, 'net_returns_v1', cv - 1)) === 'CMS_CONFIG_STALE', 'set_returns_policy config cũ ⇒ CMS_CONFIG_STALE')
    ok(code(await pol(VU.id, 'sales_only_v1', cv)) === 'CMS_RETURNS_POLICY_INVALID', 'set_returns_policy giá trị khác net ⇒ CMS_RETURNS_POLICY_INVALID')
    const setOk = await pol(VU.id, 'net_returns_v1', cv)
    g = await E.prog(VU.id)
    ok(setOk.ok && g.pol === 'net_returns_v1' && g.pb === U.super && g.v === cv + 1, 'set_returns_policy ⇒ net + actor + config_version +1', code(setOk))
    const setAgain = await pol(VU.id, 'net_returns_v1', cv)
    ok(setAgain.ok && setAgain.v.rows[0].r.already === true && (await E.prog(VU.id)).v === cv + 1, 'gọi lại ⇒ already, không tăng version')
    const back = await settle(E.db.query(`UPDATE public.cms_programs SET returns_policy = 'sales_only_v1', returns_policy_set_by = NULL, returns_policy_set_at = NULL,
      config_version = config_version + 1 WHERE id = $1`, [VU.id]))
    ok(code(back) === 'CMS_RETURNS_POLICY_REGRESSION', 'lùi net → sales_only (owner) ⇒ CMS_RETURNS_POLICY_REGRESSION', code(back))
    const VP2 = await E.makeProgram({ name: 'QA pending policy', products: null, activate: false, v2: 'pending' })
    ok(code(await pol(VP2.id, 'net_returns_v1', (await E.prog(VP2.id)).v)) === 'CMS_BASIS_NOT_SET', 'set_returns_policy khi basis pending ⇒ CMS_BASIS_NOT_SET')

    // capabilities theo vai trò
    const capA = await settle(L.as(E.db, U.A, () => E.db.query(`SELECT public.rpc_cms_capabilities() c`)))
    const capAnon = await settle(L.as(E.db, null, () => E.db.query(`SELECT public.rpc_cms_capabilities() c`), 'anon'))
    const save2Auth = await settle(L.as(E.db, U.super, () => E.db.query(`SELECT public.rpc_cms_program_save_v2('{}'::jsonb)`)))
    ok(capA.ok && capA.v.rows[0].c.calc_contract === 'cms-calc-ret2-v1' && capA.v.rows[0].c.status_dictionary === RT.CMS_RETURN_STATUS_DICTIONARY_VERSION
      && capA.v.rows[0].c.fp === FP.CMS_RETURN_FP_VERSION && capA.v.rows[0].c.unit_key === UK.CMS_UNIT_KEY_VERSION, 'capabilities: authenticated đọc được, đúng version hợp đồng')
    ok(!capAnon.ok && /permission denied/.test(capAnon.err) && !save2Auth.ok && /permission denied/.test(save2Auth.err),
      'anon không gọi capabilities; authenticated không gọi save_v2 (permission denied)')

    // capabilities THẬT (PM r2): suy từ catalog; TS fail-closed; mọi RPC của đường được quảng bá phải được harness này GỌI.
    const capRaw = capA.v.rows[0].c
    const capSvc = (await E.svc(`SELECT public.rpc_cms_capabilities() c`)).rows[0].c
    const CAPS = await lib('lib/cms/calc/capabilities.ts')
    const cap = CAPS.parseCmsCapabilities(capRaw)
    const onPaths = CAPS.CMS_CAPABILITY_PATHS.filter((p) => cap.paths[p])
    ok(cap.versionsOk && canon(onPaths) === canon(['program_modes', 'contract_run', 'readers_v2', 'returns_ledger', 'close_report'])
      && cap.off.lock_contract === 'NOT_IN_BATCH' && capRaw.paths?.lock_contract?.ok === false && canon(capSvc) === canon(capRaw),
      'capabilities: 5 đường bật (chế độ / run contract / reader v2 / sổ trả / báo cáo sau chốt), chốt contract TẮT tường minh; service_role = authenticated',
      JSON.stringify({ off: cap.off, paths: capRaw.paths }).slice(0, 400))
    const SELF = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
    const notCalled = onPaths.flatMap((p) => capRaw.paths[p].rpcs).filter((fn) => !SELF.includes(`public.${fn}(`))
    ok(notCalled.length === 0, 'mọi RPC của đường được quảng bá đều được harness gọi thật (quét mã harness)', notCalled.join(' '))
    const capIn = async (label, ddl) => {
      await E.db.exec('BEGIN')
      try { await E.db.exec(ddl); return CAPS.parseCmsCapabilities((await E.one(`SELECT public.rpc_cms_capabilities() c`)).c) } finally { await E.db.exec('ROLLBACK') }
    }
    const offOnly = (c, p, why) => c.off[p] === why && CAPS.CMS_CAPABILITY_PATHS.filter((x) => x !== p && x !== 'lock_contract').every((x) => c.paths[x])
    const der = [
      ['thu EXECUTE save báo cáo của service_role', await capIn('a', `REVOKE EXECUTE ON FUNCTION public.rpc_cms_return_close_report_save(uuid, uuid, jsonb) FROM service_role`), 'close_report'],
      ['thu EXECUTE reader rows_v2 của authenticated', await capIn('b', `REVOKE EXECUTE ON FUNCTION public.rpc_cms_result_rows_v2(uuid, uuid) FROM authenticated`), 'readers_v2'],
      ['đổi tên cột sự kiện báo cáo', await capIn('c', `ALTER TABLE public.cms_return_close_report_events RENAME COLUMN disposition TO disposition_x`), 'close_report'],
      ['xoá hàm nội bộ seal contract', await capIn('d', `DROP FUNCTION public.cms__seal_contract_step(uuid, integer)`), 'contract_run'],
      ['xoá cột quantity_basis', await capIn('e', `ALTER TABLE public.cms_programs RENAME COLUMN quantity_basis TO quantity_basis_x`), 'program_modes'],
    ].filter(([, c, p]) => !offOnly(c, p, 'DB_OFF')).map(([l, c]) => `${l}: ${JSON.stringify(c.off)}`)
    const drift = [
      CAPS.parseCmsCapabilities({ ...capRaw, calc_contract: 'cms-calc-ret2-v2' }),
      CAPS.parseCmsCapabilities({ ...capRaw, paths: { ...capRaw.paths, close_report: { ok: true, rpcs: [...capRaw.paths.close_report.rpcs, 'rpc_cms_x'] } } }),
      CAPS.parseCmsCapabilities({ ...capRaw, paths: { ...capRaw.paths, readers_v2: { ok: 'true', rpcs: capRaw.paths.readers_v2.rpcs } } }),
      CAPS.parseCmsCapabilities(null),
    ]
    ok(der.length === 0 && CAPS.CMS_CAPABILITY_PATHS.every((p) => !drift[0].paths[p] && !drift[3].paths[p]) && drift[1].off.close_report === 'RPC_LIST'
      && drift[1].paths.contract_run && drift[2].off.readers_v2 === 'DB_OFF',
      'suy dẫn thật: thu quyền / đổi cột / xoá hàm nội bộ ⇒ ĐÚNG đường đó tắt (DB_OFF), đường khác giữ; TS: lệch version ⇒ tắt hết, lệch danh sách RPC ⇒ RPC_LIST, ok không phải true / dữ liệu rỗng ⇒ tắt',
      der.join(' · '))
  }

  // ── §4 rollback ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section('4. Rollback')
  {
    const rbBlocked = await settle(E.db.exec(RB_130))
    ok(!rbBlocked.ok && /chế độ mới/.test(rbBlocked.err), 'rollback dừng khi đã có chương trình chế độ mới (admin / pending / cms_unit / net)', rbBlocked.err?.slice(0, 120))
    await E.db.exec('ROLLBACK').catch(() => {})
    ok((await E.one(`SELECT count(*)::int n FROM public.app_migrations WHERE version = '130'`)).n === 1, 'rollback dừng ⇒ 0 delta (marker còn)')
    const R = await env('rb')
    ok(R.applied.ok, 'DB 2: áp 130')
    const P1 = await R.makeProgram({ name: 'QA cũ sau 130 (rb)', products: [{ pid: R.pid(), k: '5' }] })
    const rb = await settle(R.db.exec(RB_130))
    ok(rb.ok, 'rollback khi chỉ có legacy_migration / legacy_compat ⇒ chạy', rb.err)
    const cols = await R.one(`SELECT count(*)::int n FROM pg_attribute WHERE attrelid = 'public.cms_programs'::regclass AND attname LIKE ANY (ARRAY['quantity_basis%', 'returns_policy%']) AND NOT attisdropped`)
    ok(cols.n === 0 && await cmsFnCount(R) === CMS_130_FN_BEFORE && (await R.one(`SELECT count(*)::int n FROM public.app_migrations WHERE version = '130'`)).n === 0
      && (await R.one(`SELECT count(*)::int n FROM pg_trigger WHERE tgname IN ('cms_programs_basis_guard', 'cms_products_basis_guard')`)).n === 0,
      `rollback ⇒ không cột / trigger 130, ${CMS_130_FN_BEFORE} hàm, không marker`)
    ok((await R.one(`SELECT status FROM public.cms_programs WHERE id = $1`, [P1.id])).status === 'active', 'chương trình tạo sau 130 còn nguyên sau rollback')
    const re = await settle(R.db.exec(SQL_130))
    ok(re.ok && (await R.prog(P1.id)).src === 'legacy_migration', 'áp lại 130 sau rollback ⇒ chạy; chương trình đó thành legacy_migration', re.err)
  }

  // ── §5 CRLF ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section('5. Dán CRLF (Studio)')
  {
    const X = await env('crlf', { crlf: true })
    ok(X.applied.ok, '130 dán CRLF ⇒ chạy (md5 bỏ \\r)', X.applied.err)
    const md5Crlf = await X.all(`SELECT proname, md5(replace(prosrc, E'\\r', '')) m FROM pg_proc WHERE proname = ANY ($1) ORDER BY 1`, [CMS_130_NEW.map((x) => x.name)])
    ok(md5Crlf.every((r) => r.m === GEN.md5s.new[r.proname]), 'md5 thân (bỏ \\r) bản CRLF = bản sinh')
    const rbc = await settle(X.db.exec(CRLF(RB_130)))
    ok(rbc.ok, 'rollback dán CRLF ⇒ chạy', rbc.err)
  }

  // ── §6 preflight âm ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section('6. Preflight dừng, 0 delta')
  const neg = async (label, prep, needle) => {
    const X = await env('neg', { apply: false })
    await prep(X)
    const nCols = async () => (await X.one(`SELECT count(*)::int n FROM pg_attribute WHERE attrelid = 'public.cms_programs'::regclass AND NOT attisdropped AND attnum > 0`)).n
    const c0 = await nCols()
    const r = await settle(X.db.exec(SQL_130))
    await X.db.exec('ROLLBACK').catch(() => {})
    ok(!r.ok && needle.test(r.err) && await nCols() === c0 && await cmsFnCount(X) === CMS_130_FN_BEFORE
      && (await X.one(`SELECT count(*)::int n FROM public.app_migrations WHERE version = '130'`)).n === 0, label, r.err?.slice(0, 140))
  }
  await neg('thiếu marker 127 ⇒ dừng', (X) => X.db.query(`DELETE FROM public.app_migrations WHERE version = '127'`), /thiếu migration nền 127/)
  await neg('có marker 128 ⇒ dừng (128 / 129 bỏ)', (X) => X.db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('128', 'x')`), /số > 127/)
  await neg('run đang chạy ⇒ dừng', (X) => X.db.query(`INSERT INTO public.cms_sync_runs (kind, program_id, config_version, is_test, mapping_fp, status)
    SELECT 'sales', id, config_version, is_test, repeat('0', 32), 'running' FROM public.cms_programs WHERE id = $1`, [X.LIVE.id]), /run đang chạy/)
  await neg('thân hàm ghim lệch (save 121) ⇒ dừng', async (X) => {
    const t = (await X.one(`SELECT pg_get_functiondef('public.rpc_cms_program_save(jsonb)'::regprocedure) d`)).d
    await X.db.exec(t.replace('-- Cắt mọi khoảng trắng', '-- sửa tay; Cắt mọi khoảng trắng'))
  }, /hàm ghim/)
  await neg('thân hàm sắp thay lệch (publish 126) ⇒ dừng', async (X) => {
    const t = (await X.one(`SELECT pg_get_functiondef('public.rpc_cms_sales_run_publish(uuid)'::regprocedure) d`)).d
    await X.db.exec(t.replace("'RESULTS_RELEASE_GATE'", "'RESULTS_RELEASE_GATE' /* sửa tay */"))
  }, /sắp thay/)
  await neg('ACL hàm thay lệch (anon EXECUTE publish) ⇒ dừng', (X) => X.db.exec(`GRANT EXECUTE ON FUNCTION public.rpc_cms_sales_run_publish(uuid) TO anon`), /ACL nền/)
  await neg('đã có cột quantity_basis ⇒ dừng', (X) => X.db.exec(`ALTER TABLE public.cms_programs ADD COLUMN quantity_basis text`), /đã có cột/)

  // ── §7 run contract ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section('7. Run contract: open → stage → seal 13 bước (TS writer ↔ SQL tự tính) · đột biến từng mã · NULL probe · cleanup')
  await contractSection()

  // ── §8 báo cáo trả hàng sau chốt ────────────────────────────────────────────────────────────────────────────────────────────────
  section('8. Báo cáo trả hàng sau chốt (D11): chương trình QA đã chốt legacy · số tính lại độc lập · mã đầu vào 0 ghi · sổ receipt chung · reader')
  await reportSection()

  // ── §11 worker TS ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section('11. Worker TS (runCmsSalesSync → nhánh contract, provider fixture): cờ · open held · provider lỗi · phiếu lỗi · engine HOLD · công bố + ledger')
  await workerSection()

  if (PG15) {
    section('9. Race 2 kết nối (PG15): báo cáo cùng snapshot · sàn as_of khi commit đảo · confirm trên proof cũ · chốt lại × báo cáo')
    await raceSection()
  }
  if (PG15 && process.argv.includes('--bench')) {
    section('10. Bench PG15: run contract net 200.000 dòng bán / 20.000 phiếu × 2 mode (stage · seal 13 · publish ×2 · cleanup · reader; trần 8 s)')
    await benchSection()
  }
}

/** Run contract đủ bước (open → stage → seal 13 → publish tuỳ chọn) trên env X — dùng ở §7 và §9. */
function contractKit(X) {
  const runRow = (id) => X.one(`SELECT status, error_code, seal_step, sealed_at IS NOT NULL sealed, quantity_basis b, quantity_policy_version qpv,
    returns_policy pol, calc_contract_version cc, unit_key_version uk, status_dictionary_version sd, source_pin pin, sales_src_digest sdg,
    returns_digest rdg, returns_as_of IS NOT NULL has_asof, returns_rows_read rrr, amount_vnd::text amt FROM public.cms_sync_runs WHERE id = $1`, [id])
  const close = async (runId) => { if ((await runRow(runId)).status === 'running') await X.rpc(`SELECT public.rpc_cms_sales_run_finish($1, 'error', '{"error_code":"QA_DONE"}'::jsonb) r`, [runId]) }
  const MUT_SIZE = 3
  async function crun(P, salesRaw, returnsRaw, o = {}) {
    const opened = await X.rpc(`SELECT public.rpc_cms_sales_run_open($1, $2::jsonb) r`, [P.id, JSON.stringify(o.detail ?? { source: 'qa', calc_contract: 'cms-calc-ret2-v1' })])
    if (opened.held) return { opened, runId: opened.run_id }
    const runId = opened.run_id
    const snap = CS.parseCmsContractSnapshot(opened)
    const sales = salesRaw.map((r) => { const n = C.normalizeSalesRow(r); if (!n.ok) throw new Error('dòng bán giả lỗi'); return NET.cmsCalcSaleLine(r, n.value) })
    const rets = returnsRaw.map((r) => { const n = RT.normalizeReturnRow(r); if (!n.ok) throw new Error('phiếu giả lỗi ' + JSON.stringify(n.issues)); return n.value })
    const asOf = o.asOf ?? BigInt(Date.now()) * BigInt(1000)
    const out = NET.computeCmsNet(CS.cmsContractCalcInput(snap, sales, rets, asOf))
    if (!out.ok) { await close(runId); return { opened, runId, snap, out } }
    const provider = o.provider ?? (P.isTest ? 'fixture' : 'bq')
    const payload = CS.buildCmsContractStagePayload(snap, sales, rets, out, { rowsRead: sales.length, rowsRejected: 0, bytesProcessed: null, provider,
      ...(provider === 'bq' ? { jobId: 'qa-proj:asia-southeast1.job_qa1' } : { snapshotId: 'qa-snap-1' }), asOfMicros: asOf,
      rejectedDigest: SD.cmsDigestSet('rejected', []), chunkSize: MUT_SIZE })
    if (o.mutate) {
      o.mutate(payload, { asOf, out })
      if (!o.keepExpect) for (const p of payload.stageParts) { payload.expect[p] = payload.parts[p].length; payload.expect.chunks[p] = Math.ceil(payload.parts[p].length / MUT_SIZE) }
    }
    for (const part of o.parts ?? payload.stageParts) {
      const chunks = RS.chunkCmsStageRows(payload.parts[part], MUT_SIZE)
      for (let i = 0; i < chunks.length; i++) {
        const r = await settle(X.rpc(`SELECT public.rpc_cms_sales_run_stage($1, $2, $3, $4::jsonb) r`, [runId, part, i, JSON.stringify(chunks[i])]))
        if (!r.ok) { await close(runId); return { opened, runId, snap, out, payload, stageErr: code(r) } }
      }
    }
    const begin = await settle(X.rpc(`SELECT public.rpc_cms_sales_run_seal_begin($1, $2::jsonb) r`, [runId, JSON.stringify(o.expect ?? payload.expect)]))
    if (!begin.ok || !begin.v.ok) { await close(runId); return { opened, runId, snap, out, payload, begin: begin.ok ? begin.v : { err: code(begin) } } }
    let last = null
    for (let i = 1; i <= 13; i++) {
      last = await X.rpc(`SELECT public.rpc_cms_sales_run_seal_step($1, $2) r`, [runId, i])
      if (last.sealed || !last.ok) break
    }
    let pub = null
    if (o.publish && last?.sealed) {
      const p = await settle(o.publishVia ? o.publishVia(runId) : X.rpc(`SELECT public.rpc_cms_sales_run_publish($1) r`, [runId]))
      pub = p.ok ? p.v : { err: code(p) }
    }
    const row = await runRow(runId)
    await close(runId)
    return { opened, runId, snap, out, payload, begin: begin.v, last, row, pub, asOf }
  }
  return { runRow, close, crun, MUT_SIZE }
}

async function contractSection() {
  const X = await env('contract')
  ok(X.applied.ok, 'DB 3: áp 130', X.applied.err)
  const SEL = [STORES[0].assigneeEmails[0], STORES[0].assigneeEmails[1], STORES[1].assigneeEmails[0], STORES[2].assigneeEmails[0], 'nobody.qa@example.invalid']
  const setNet = async (P) => X.svc(`SELECT public.rpc_cms_program_set_returns_policy($1, 'net_returns_v1', $2, $3)`, [P.id, (await X.prog(P.id)).v, U.super])
  // CN: cms_unit + net (thử) · CU: cms_unit + sales-only (thử) · PB: pos_base + net (THẬT — provider bq).
  const CN = await X.makeProgram({ name: 'QA contract unit net', isTest: true, products: [{ pid: X.pid(), k: '10', unit: 'Hộp' }, { pid: X.pid(), k: '1', unit: 'Viên' }], v2: 'cms_unit' })
  await setNet(CN)
  const CU = await X.makeProgram({ name: 'QA contract unit sales', isTest: true, products: [{ pid: X.pid(), k: '10', unit: 'Hộp' }], v2: 'cms_unit' })
  const PB = await X.makeProgram({ name: 'QA contract pos net', isTest: false, products: [{ pid: X.pid(), k: '2', unit: 'Hộp' }], v2: 'pos_base' })
  await setNet(PB)

  let ln = 0
  const at = (P, min) => new Date(Date.parse(`${P.start}T02:00:00Z`) + min * 60000).toISOString()
  const srow = (P, o) => {
    const id = ++ln
    const t = at(P, o.min ?? id)
    return { order_line_id: String(949000000 + id), order_id: `CO${id}`, order_code: `CQA-${id}`, product_id: o.pid, seller_email: SEL[o.s ?? 0],
      pos_code: 'QAOS01', order_type: o.type ?? 'OFFLINE', order_status: 'COMPLETED', completed_at: t, quantity_raw: o.q ?? '1', uom_raw: o.u ?? 'Hộp',
      base_quantity: String(o.base), gmv_amount: o.gmv ?? '100000', source_updated_at: t }
  }
  const rrow = (P, sale, o) => ({ return_event_id: o.id, return_document_id: `RD-${o.id}`, return_code: `RC-${o.id}`, return_status: o.status ?? 'COMPLETED',
    return_recorded_at: at(P, o.min), original_order_line_id: sale.order_line_id, original_order_id: sale.order_id, product_id: sale.product_id,
    return_base_quantity: String(o.base), return_gmv_amount: o.gmv ?? '10000', original_completed_at: sale.completed_at,
    original_order_type: sale.order_type, original_order_status: sale.order_status, original_seller_email: sale.seller_email,
    original_pos_code: sale.pos_code, original_base_quantity: sale.base_quantity, original_gmv_amount: sale.gmv_amount,
    original_quantity_raw: sale.quantity_raw, original_uom_raw: sale.uom_raw, source_updated_at: at(P, o.min) })

  const { runRow, close, crun } = contractKit(X)

  // ── Kịch bản CN: cms_unit + net ──
  const [p1, p2] = CN.products.map((p) => p.pid)
  const S = {
    s1: srow(CN, { pid: p1, q: '3', u: 'Hộp', base: 30, gmv: '300000' }),            // COUNTED 3
    s2: srow(CN, { pid: p1, q: '15', u: 'Viên', base: 15, gmv: '150000' }),          // OTHER_UNIT
    s3: srow(CN, { pid: p1, q: '1.5', u: ' hộp ', base: 15, gmv: '150000' }),        // FRACTIONAL (khoá hộp)
    s4: srow(CN, { pid: p2, q: '7', u: 'viên', base: 7, gmv: '70000' }),             // COUNTED 7
    s5: srow(CN, { pid: p1, q: '2', u: 'Hộp', base: 20, gmv: '200000', s: 2 }),       // COUNTED, store 2
    s6: srow(CN, { pid: p1, q: '1', u: 'Hộp', base: 10, s: 4 }),                      // UNASSIGNED
    s7: srow(CN, { pid: p1, q: '1', u: 'Hộp', base: 10, type: 'ONLINE' }),            // không ứng viên
    s8: srow(CN, { pid: p1, q: '1', u: 'Hộp', base: 10, s: 3 }),                      // OUT_OF_SCOPE
    s9: srow(CN, { pid: p1, q: '0', u: 'Hộp', base: 0, gmv: '0' }),                   // ZERO_QUANTITY
    s10: srow(CN, { pid: p1, q: '1', u: 'Hộp', base: 10, s: 4 }),                     // UNASSIGNED (không phiếu)
  }
  const SALES = Object.values(S)
  const RETS = [
    rrow(CN, S.s1, { id: 'R1', base: 10, gmv: '100000', min: 100 }),                  // APPLIED, giảm 1 hộp
    { return_event_id: 'R2', return_status: 'APPROVED' },                              // NOT_COMPLETED
    rrow(CN, S.s2, { id: 'R3', base: 5, gmv: '50000', min: 101 }),                     // APPLIED, gốc OTHER_UNIT ⇒ không đổi lượng
    rrow(CN, S.s6, { id: 'R4', base: 10, min: 102 }),                                  // ORIGIN_UNASSIGNED
    rrow(CN, S.s7, { id: 'R5', base: 10, min: 103 }),                                  // ORIGIN_NOT_ELIGIBLE
    rrow(CN, S.s8, { id: 'R6', base: 10, min: 104 }),                                  // ORIGIN_OUT_OF_SCOPE
  ]
  const A = await crun(CN, SALES, RETS)
  ok(A.out?.ok === true && A.last?.sealed === true && A.row?.seal_step === 13,
    'CN cms_unit + net: TS writer stage 6 part ⇒ DB seal ĐỦ 13 bước (N1–N10 tự tính khớp)', JSON.stringify(A.last ?? A.begin ?? A.stageErr ?? A.out?.holds))
  if (A.row) {
    ok(A.row.b === 'cms_unit' && A.row.pol === 'net_returns_v1' && A.row.cc === 'cms-calc-ret2-v1' && A.row.qpv === PLc.CMS_QUANTITY_POLICY_VERSION.cms_unit
      && A.row.uk === UK.CMS_UNIT_KEY_VERSION && A.row.sd === RT.CMS_RETURN_STATUS_DICTIONARY_VERSION, 'run ghim 6 cột hợp đồng từ CHƯƠNG TRÌNH')
    ok(A.row.amt === A.out.totals.amountVnd.toString() && A.row.sdg === A.payload.expect.pin.sales.staged_digest
      && A.row.rdg === A.payload.expect.pin.returns.digest && A.row.has_asof && A.row.rrr === RETS.length
      && canon(A.row.pin) === canon(A.payload.expect.pin), 'seal ghi tiền / pin / digest bán + trả / as_of / số phiếu = TS (digest DB tự tính = TS)',
      JSON.stringify({ amt: [A.row.amt, A.out.totals.amountVnd.toString()], rrr: A.row.rrr, asof: A.row.has_asof, pin: canon(A.row.pin) === canon(A.payload.expect.pin) }))
    const cls = Object.fromEntries((await X.all(`SELECT order_line_id i, quantity_class c FROM public.cms_sales_lines WHERE run_id = $1`, [A.runId])).map((r) => [r.i, r.c]))
    ok(cls[S.s1.order_line_id] === 'COUNTED' && cls[S.s2.order_line_id] === 'OTHER_UNIT' && cls[S.s3.order_line_id] === 'FRACTIONAL_QUANTITY'
      && cls[S.s4.order_line_id] === 'COUNTED' && cls[S.s9.order_line_id] === 'ZERO_QUANTITY' && cls[S.s6.order_line_id] === 'COUNTED'
      && cls[S.s7.order_line_id] === undefined, 'lớp lượng 5 loại (kể cả ứng viên chưa gán); dòng ONLINE chỉ ở lớp nguồn', JSON.stringify(cls))
    const disp = Object.fromEntries((await X.all(`SELECT return_event_id i, disposition d FROM public.cms_return_lines WHERE run_id = $1`, [A.runId])).map((r) => [r.i, r.d]))
    ok(disp.R1 === 'APPLIED' && disp.R2 === 'NOT_COMPLETED' && disp.R3 === 'APPLIED' && disp.R4 === 'ORIGIN_UNASSIGNED' && disp.R5 === 'ORIGIN_NOT_ELIGIBLE'
      && disp.R6 === 'ORIGIN_OUT_OF_SCOPE', 'disposition 6 phiếu DB tự suy = TS', JSON.stringify(disp))
    const ev = await X.all(`SELECT event_key k, status s, amount_vnd::text a FROM public.cms_result_events WHERE run_id = $1 ORDER BY seq`, [A.runId])
    ok(ev.length === A.out.history.length && ev.some((e) => e.k === 'RETURN:R1' && e.s === 'RETURN_REDUCED' && Number(e.a) < 0)
      && ev.some((e) => e.k === 'RETURN:R3' && e.s === 'RETURN_NO_CHANGE' && e.a === '0'), 'sự kiện: R1 giảm tiền, R3 (gốc OTHER_UNIT) không đổi', JSON.stringify(ev.slice(-3)))
  }

  // ── Đột biến: mỗi lần một lỗi, DB dừng đúng bước / mã ──
  const find = (rows, k, v) => rows.find((r) => r[k] === v)
  const MUTS = [
    ['lớp lượng khai sai (OTHER_UNIT → COUNTED)', 'error', 'SEAL_N1_CLASS', (p) => { const r = find(p.parts.sales_lines, 'order_line_id', S.s2.order_line_id); r.quantity_class = 'COUNTED'; r.eligible_base = r.base_quantity }],
    ['bỏ sót ứng viên (dòng bán thiếu so với lớp nguồn)', 'error', 'SEAL_SOURCE_LINK', (p) => { p.parts.sales_lines = p.parts.sales_lines.filter((r) => r.order_line_id !== S.s10.order_line_id).map((r, i) => ({ ...r, seq: String(i) })) }],
    // Đột biến F07 14/11 (seal bước 2 `count(*) > 1`) sống sót ⇒ ca đúng MỘT dòng vi phạm phạm vi.
    ['một dòng bán ngoài phạm vi khai INCLUDED (đúng 1 dòng vi phạm)', 'error', 'SEAL_SCOPE', (p) => { find(p.parts.sales_lines, 'order_line_id', S.s8.order_line_id).disposition = 'INCLUDED' }],
    ['b ≠ q × K (hai lớp nhất quán)', 'held', 'SEAL_N1_BASE_QTY_MISMATCH', (p) => { for (const part of ['sales_lines', 'source_lines']) { const r = find(p.parts[part], 'order_line_id', S.s5.order_line_id); r.base_quantity = '21'; if (part === 'sales_lines') r.eligible_base = '21' } }],
    ['đơn vị cờ OVERSIZE', 'held', 'SEAL_N1_UNIT_INVALID', (p) => { for (const part of ['sales_lines', 'source_lines']) { const r = find(p.parts[part], 'order_line_id', S.s5.order_line_id); r.uom_src = null; r.uom_raw = null; r.uom_src_flag = 'OVERSIZE' } }],
    ['ứng viên âm chỉ ở lớp nguồn', 'held', 'SEAL_N1_NEGATIVE_SALE', (p) => { find(p.parts.source_lines, 'order_line_id', S.s10.order_line_id).gmv_amount = '-1'; p.parts.sales_lines = p.parts.sales_lines.filter((r) => r.order_line_id !== S.s10.order_line_id).map((r, i) => ({ ...r, seq: String(i) })) }],
    ['thô ↔ sạch lệch', 'error', 'SEAL_N1_SRC', (p) => { for (const part of ['sales_lines', 'source_lines']) find(p.parts[part], 'order_line_id', S.s3.order_line_id).uom_raw = ' hộp' }],
    ['disposition phiếu khai sai', 'error', 'SEAL_N2_DISPOSITION', (p) => { find(p.parts.return_lines, 'return_event_id', 'R5').disposition = 'ORIGIN_OUT_OF_WINDOW' }],
    ['phiếu sau as_of', 'held', 'SEAL_N2_AFTER_AS_OF', (p) => { const r1 = find(p.parts.return_lines, 'return_event_id', 'R1'); const now = BigInt(Date.now()) * BigInt(1000); p.expect.pin.as_of = TM.formatUtcMicros(now - BigInt(3_600_000_000)); r1.recorded_at = TM.formatUtcMicros(now - BigInt(60_000_000)) }],
    ['as_of cũ hơn 36 giờ trước mở run (phát lại snapshot)', 'error', 'SEAL_N2_AS_OF', (p) => { p.expect.pin.as_of = TM.formatUtcMicros(BigInt(Date.now()) * BigInt(1000) - BigInt(37 * 3600) * BigInt(1_000_000)) }],
    ['ngữ cảnh gốc lệch (GMV gốc)', 'held', 'SEAL_N2_CONTEXT_MISMATCH', (p) => { find(p.parts.return_lines, 'return_event_id', 'R1').original_gmv_amount = '299999' }],
    ['Σ trả vượt b gốc', 'held', 'SEAL_N2_EXCEEDS_SALE_BASE', (p) => { find(p.parts.return_lines, 'return_event_id', 'R4').return_base_quantity = '11' }],
    ['sự kiện thiếu', 'error', 'SEAL_N3_EVENTS', (p) => { const k = 'RETURN:R3'; p.parts.result_events = p.parts.result_events.filter((e) => e.event_key !== k).map((e, i) => ({ ...e, seq: String(i) })) }],
    ['thứ tự sự kiện đảo', 'error', 'SEAL_ORDER', (p) => { const e = p.parts.result_events; const a = e[0].seq; e[0].seq = e[1].seq; e[1].seq = a }],
    ['tiền nhóm khai sai', 'error', 'SEAL_RESULT_SUMS', (p) => { const r = p.parts.results.find((x) => x.amount_vnd !== '0'); r.amount_vnd = String(BigInt(r.amount_vnd) + BigInt(1)); r.potential_amount = r.amount_vnd }],
    ['trạng thái sự kiện khai sai', 'error', 'SEAL_LINE_ALLOC', (p) => { const e = p.parts.result_events.find((x) => x.status === 'RECORDED'); e.status = 'ACCUMULATING' }],
    ['digest bán trong pin sai', 'error', 'SEAL_PIN_DIGEST', (p) => { p.expect.pin.sales.staged_digest = '0'.repeat(64) }],
    ['digest trả trong pin sai', 'error', 'SEAL_PIN_DIGEST', (p) => { p.expect.pin.returns.digest = 'f'.repeat(64) }],
    ['tập SP trong pin sai', 'error', 'SEAL_PIN_SCOPE', (p) => { p.expect.pin.scope.products_hash = 'a'.repeat(64) }],
    ['có dòng normalizer từ chối (contract fail-closed)', 'held', 'SEAL_N9_REJECTED', (p) => { p.expect.rows_rejected = 1; p.expect.rows_read += 1; p.expect.pin.sales.rows_rejected = 1; p.expect.pin.sales.rows_total += 1 }],
    ['tổng hiển thị khai sai (class_counts)', 'error', 'SEAL_TOTALS', (p) => { p.expect.totals.class_counts.COUNTED += 1 }],
  ]
  for (const [label, st, want, mutate] of MUTS) {
    const m = await crun(CN, SALES, RETS, { mutate })
    const got = m.last && !m.last.ok && !m.last.sealed ? `${m.last.status}:${m.last.code}` : m.begin?.code ? `${m.begin.status}:${m.begin.code}` : (m.stageErr ?? m.begin?.err ?? 'SEALED')
    ok(got === `${st}:${want}`, `đột biến "${label}" ⇒ ${st} ${want}`, got)
  }
  // Stage / seal_begin từ chối hình dạng.
  const unk = await crun(CN, SALES, RETS, { mutate: (p) => { find(p.parts.return_lines, 'return_event_id', 'R2').return_status = 'APPROVED ' } })
  ok(unk.stageErr === 'CMS_RETURN_STATUS_UNKNOWN', 'trạng thái phiếu ngoài từ điển (dấu cách thừa) ⇒ stage CMS_RETURN_STATUS_UNKNOWN', unk.stageErr)
  const badPart = await crun(CN, SALES, RETS, { parts: ['result_lines'], mutate: (p) => { p.parts.result_lines = [{ x: 'y' }] } })
  ok(badPart.stageErr === 'CMS_STAGE_BAD_PART', 'run contract stage result_lines ⇒ CMS_STAGE_BAD_PART', badPart.stageErr)
  const badKey = await crun(CN, SALES, RETS, { mutate: (p) => { p.expect.result_lines = 0 } })
  ok(badKey.begin?.err === 'CMS_SEAL_BAD_EXPECT', 'seal_begin run contract có khoá result_lines ⇒ CMS_SEAL_BAD_EXPECT', JSON.stringify(badKey.begin))
  const badCnt = await crun(CN, SALES, RETS, { keepExpect: true, mutate: (p) => { p.expect.result_events += 1 } })
  ok(badCnt.begin?.code === 'SEAL_COUNT_MISMATCH', 'expect đếm sai ⇒ SEAL_COUNT_MISMATCH', JSON.stringify(badCnt.begin))
  const legacyWorker = await crun(CN, SALES, RETS, { detail: { source: 'qa' } })
  const lw = legacyWorker.runId ? await runRow(legacyWorker.runId) : null
  ok(legacyWorker.opened?.held === true && lw?.status === 'held' && lw?.error_code === 'CMS_WORKER_UNSUPPORTED' && lw?.cc === 'cms-calc-ret2-v1',
    'worker cũ (không khai calc_contract) mở chương trình contract ⇒ VẪN có run, đóng held CMS_WORKER_UNSUPPORTED', JSON.stringify(lw))

  // ── CU: cms_unit + sales-only ──
  const cu = CU.products[0].pid
  const CU_SALES = [srow(CU, { pid: cu, q: '4', u: 'HỘP', base: 40 }), srow(CU, { pid: cu, q: '12', u: 'Hộp', base: 120, s: 1 })]
  const B = await crun(CU, CU_SALES, [])
  ok(B.last?.sealed === true && B.row?.pol === 'sales_only_v1' && B.row?.rdg === null && !B.row?.has_asof && B.row?.rrr === null
    && B.payload.stageParts.includes('return_lines') === false && B.payload.expect.pin.returns === undefined,
    'CU cms_unit + sales-only ⇒ seal 13 bước; run KHÔNG có cột trả ("0 phiếu" giả)', JSON.stringify(B.last ?? B.begin ?? B.stageErr))
  const cuRet = await crun(CU, CU_SALES, [], { parts: ['return_lines'], mutate: (p) => { p.parts.return_lines = [{ return_event_id: 'X', seq: '0', return_status: 'APPROVED', disposition: 'NOT_COMPLETED' }] } })
  ok(cuRet.stageErr === 'CMS_STAGE_BAD_PART', 'sales-only stage return_lines ⇒ CMS_STAGE_BAD_PART', cuRet.stageErr)

  // ── PB: pos_base + net, chương trình THẬT ──
  const pb = PB.products[0].pid
  const PB_S = [srow(PB, { pid: pb, q: 'abc', u: '', base: 7, gmv: '70000' }), srow(PB, { pid: pb, q: '3', u: 'Hộp', base: 6, s: 1 })]
  const PB_R = [rrow(PB, PB_S[0], { id: 'P1', base: 3, gmv: '30000', min: 200 })]
  const Cr = await crun(PB, PB_S, PB_R)
  ok(Cr.last?.sealed === true && Cr.row?.b === 'pos_base' && Cr.row?.pol === 'net_returns_v1' && Cr.row?.pin?.provider === 'bq',
    'PB pos_base + net (chương trình thật, provider bq): q / u hỏng KHÔNG HOLD (pos_base); seal 13 bước', JSON.stringify(Cr.last ?? Cr.begin ?? Cr.stageErr))
  const fx = await crun(PB, PB_S, PB_R, { provider: 'fixture' })
  ok(fx.begin?.code === 'SEAL_PIN_PROVIDER' && fx.begin?.status === 'error', 'pin provider fixture trên chương trình thật ⇒ SEAL_PIN_PROVIDER', JSON.stringify(fx.begin))

  // ── Ledger trả hàng (PM D14 / r2.1 §14.1–§14.3): publish atomic, conflict, sàn as_of, xác nhận phục hồi, chuỗi conflict, ràng buộc DB ──
  {
    const CL = await X.makeProgram({ name: 'QA ledger', isTest: true, products: [{ pid: X.pid(), k: '10', unit: 'Hộp' }], v2: 'cms_unit' })
    await setNet(CL)
    const cp = CL.products[0].pid
    const Ls = { l1: srow(CL, { pid: cp, q: '3', base: 30, gmv: '300000' }), l2: srow(CL, { pid: cp, q: '2', base: 20, gmv: '200000', s: 1 }),
      l3: srow(CL, { pid: cp, q: '1', base: 10, s: 4 }), l4: srow(CL, { pid: cp, q: '4', base: 40, gmv: '400000', s: 2 }) }
    const LS = Object.values(Ls)
    const RA = rrow(CL, Ls.l1, { id: 'LA', base: 10, gmv: '100000', min: 300 })
    const RA_CHG = rrow(CL, Ls.l1, { id: 'LA', base: 10, gmv: '90000', min: 300 })
    const RA_NE = { return_event_id: 'LA', return_status: 'APPROVED' }
    const RB = rrow(CL, Ls.l3, { id: 'LB', base: 10, min: 301 })
    const RN = { return_event_id: 'LN', return_status: 'APPROVED' }
    const RC = rrow(CL, Ls.l2, { id: 'LC', base: 10, gmv: '100000', min: 302 })
    const RD = rrow(CL, Ls.l4, { id: 'LD', base: 10, gmv: '100000', min: 303 })
    let tick = BigInt(Date.now()) * BigInt(1000)
    const lpub = (rets, o = {}) => crun(CL, LS, rets, { publish: true, asOf: o.asOf ?? (tick += BigInt(1000)) })
    const st = () => X.one(`SELECT (SELECT count(*)::int FROM public.cms_return_baselines WHERE program_id = $1) nb,
      (SELECT count(*)::int FROM public.cms_return_ledger_evals WHERE program_id = $1) ne,
      (SELECT count(*)::int FROM public.cms_return_conflicts WHERE program_id = $1) nc,
      (SELECT count(*)::int FROM public.cms_return_conflicts c WHERE c.program_id = $1
         AND NOT EXISTS (SELECT 1 FROM public.cms_return_conflict_restorations r WHERE r.conflict_id = c.id)) nopen,
      (SELECT count(*)::int FROM public.cms_return_conflict_observations WHERE program_id = $1) nobs,
      (SELECT count(*)::int FROM public.cms_return_restorations WHERE program_id = $1) nrest,
      (SELECT current_result_run_id::text FROM public.cms_programs WHERE id = $1) ptr,
      public.cms__open_set_hash($1) oh, public.cms__ledger_set_hash($1) lh`, [CL.id])
    const lrun = (id) => X.one(`SELECT status, error_code, ledger_verdict lv, ledger_eval_seq::int les, ledger_set_hash lh,
      detail ->> 'results_basis' rb, detail ->> 'quantity_basis' qb FROM public.cms_sync_runs WHERE id = $1`, [id])
    const confirm = async (uid, args) => {
      const r = await settle(L.as(X.db, uid, () => X.db.query(`SELECT public.rpc_cms_return_conflicts_confirm_restored($1, $2, $3, $4, $5) r`, args), 'authenticated'))
      return r.ok ? r.v.rows[0].r : { err: code(r) }
    }
    const pubCode = (m) => m.pub?.code ?? m.pub?.err ?? (m.pub?.published ? 'PUBLISHED' : JSON.stringify(m.last ?? m.begin ?? m.stageErr ?? m.out?.holds))
    const idem = () => globalThis.crypto.randomUUID()
    const WHY = 'Nguồn trả hàng đã khôi phục đúng phiếu đã nhận — QA'
    const asU = async (uid, sql, params) => {
      const r = await settle(L.as(X.db, uid, () => X.db.query(sql, params), 'authenticated'))
      return r.ok ? r.v.rows[0].r : { err: code(r) }
    }

    // 1. Lượt đầu sạch ⇒ công bố + baseline cho phiếu EFFECTIVE có tác động tiền (APPLIED / ORIGIN_UNASSIGNED); LN chưa hiệu lực ⇒ không.
    const r1 = await lpub([RA, RB, RN])
    let s = await st()
    const r1l = await lrun(r1.runId)
    ok(r1.pub?.published === true && r1.pub.baselines_new === 2 && s.nb === 2 && s.ne === 1 && s.nc === 0 && s.ptr === r1.runId
      && r1l.status === 'ok' && r1l.lv === 'CLEAN' && r1l.les === 1 && r1l.rb === 'net_returns_v1' && r1l.qb === 'cms_unit',
      'publish run net sạch ⇒ ok + pointer + 2 baseline (APPLIED / ORIGIN_UNASSIGNED) + eval 1 CLEAN; đóng dấu căn cứ (cả run QA)',
      JSON.stringify({ p: r1.pub ?? pubCode(r1), s, r1l }))
    const bA = await X.one(`SELECT financial_fp fp, accepted_run_id::text ar, accepted_report_id ap, accepted_eval_seq::int ae
      FROM public.cms_return_baselines WHERE program_id = $1 AND return_event_id = 'LA'`, [CL.id])
    const fpTs = FP.cmsReturnFinancialFp({ programId: CL.id, returnEventId: 'LA', returnDocumentId: 'RD-LA', originalOrderLineId: Ls.l1.order_line_id,
      originalOrderId: Ls.l1.order_id, productId: cp, baseUnits: BigInt(10) * BigInt(1e9), refundUnits: BigInt(100000) * BigInt(1e9),
      recordedAtMicros: BigInt(Date.parse(RA.return_recorded_at)) * BigInt(1000) })
    ok(bA?.fp === fpTs && bA.ar === r1.runId && bA.ap === null && bA.ae === 1, 'baseline LA: fp DB = cmsReturnFinancialFp (TS); nhận bởi run + eval 1', JSON.stringify(bA))

    // 2. Lượt sau thêm LC ⇒ công bố, baseline LC.
    const r2 = await lpub([RA, RB, RN, RC])
    s = await st()
    ok(r2.pub?.published === true && r2.pub.baselines_new === 1 && s.nb === 3 && s.ne === 2 && s.ptr === r2.runId, 'lượt 2 sạch ⇒ baseline LC, eval 2',
      JSON.stringify({ p: r2.pub ?? pubCode(r2), s }))
    // 3. LA biến mất (+ phiếu mới LD) ⇒ held CMS_RETURN_LEDGER_CONFLICT; conflict MISSING + observation v1; pointer giữ; LD KHÔNG nhận.
    const r3 = await lpub([RB, RN, RC, RD])
    s = await st()
    const r3l = await lrun(r3.runId)
    const c1 = await X.one(`SELECT id::int, prev_conflict_id prev, opened_kind k, opened_eval_seq::int oe FROM public.cms_return_conflicts
      WHERE program_id = $1 AND return_event_id = 'LA'`, [CL.id])
    ok(pubCode(r3) === 'CMS_RETURN_LEDGER_CONFLICT' && r3l.status === 'held' && r3l.lv === 'MISMATCH' && r3l.les === 3 && s.ptr === r2.runId
      && s.nb === 3 && s.nc === 1 && s.nopen === 1 && s.nobs === 1 && c1?.prev === null && c1?.k === 'MISSING' && c1?.oe === 3
      && r3.pub?.ledger?.open_set_hash === s.oh,
      'phiếu đã nhận mất ⇒ held LEDGER_CONFLICT, conflict MISSING (prev NULL) + obs v1, pointer giữ, phiếu mới không nhận',
      JSON.stringify({ c: pubCode(r3), r3l, s, c1 }))
    // 4. Vẫn mất ⇒ held; eval 4 ghi, KHÔNG thêm observation (chỉ ghi khi đổi).
    const r4 = await lpub([RB, RN, RC, RD])
    s = await st()
    ok(pubCode(r4) === 'CMS_RETURN_LEDGER_CONFLICT' && s.ne === 4 && s.nobs === 1, 'vẫn lệch, không đổi ⇒ eval 4 có, observation không thêm', JSON.stringify(s))
    // 5. PM RET2-R2-01: snapshot CŨ hơn lượt 4 (lượt dedupe) mà khớp ⇒ CMS_RETURN_AS_OF_REGRESSION, 0 eval / 0 observation — không thành proof.
    const rS = await lpub([RA, RB, RN, RC, RD], { asOf: r4.asOf - BigInt(500) })
    s = await st()
    const rSl = await lrun(rS.runId)
    ok(pubCode(rS) === 'CMS_RETURN_AS_OF_REGRESSION' && rSl.status === 'held' && rSl.lv === null && s.ne === 4 && s.nobs === 1,
      'snapshot as_of cũ hơn eval trước (dù khớp) ⇒ held AS_OF_REGRESSION, không ghi eval / observation', JSON.stringify({ c: pubCode(rS), rSl, s }))
    // 6. Proof phải là eval OPEN_CONFLICT_MATCH: eval mới nhất đang MISMATCH ⇒ từ chối.
    let cf = await confirm(U.super, [CL.id, s.oh, 4, WHY, idem()])
    ok(cf.err === 'CMS_RETURN_PROOF_NOT_MATCH', 'confirm với eval mới nhất MISMATCH ⇒ CMS_RETURN_PROOF_NOT_MATCH', JSON.stringify(cf))
    // 7. LA đổi tiền ⇒ obs v2 CHANGED; 8. LA khớp lại ⇒ v3 MATCH, held CMS_RETURN_CONFLICT_OPEN (không tự mở); 9. lặp ⇒ không obs mới.
    const r5 = await lpub([RA_CHG, RB, RN, RC, RD])
    const s5 = await st()
    const r6 = await lpub([RA, RB, RN, RC, RD])
    const s6 = await st()
    const r6l = await lrun(r6.runId)
    const r7 = await lpub([RA, RB, RN, RC, RD])
    const s7 = await st()
    const obs = await X.all(`SELECT version v, verdict, eval_seq::int e FROM public.cms_return_conflict_observations WHERE conflict_id = $1 ORDER BY version`, [c1.id])
    ok(pubCode(r5) === 'CMS_RETURN_LEDGER_CONFLICT' && s5.nobs === 2 && pubCode(r6) === 'CMS_RETURN_CONFLICT_OPEN' && r6l.lv === 'OPEN_CONFLICT_MATCH'
      && s6.nobs === 3 && s6.ptr === r2.runId && s6.nb === 3 && pubCode(r7) === 'CMS_RETURN_CONFLICT_OPEN' && s7.nobs === 3 && s7.ne === 7
      && obs.map((o) => o.verdict).join() === 'MISSING,CHANGED,MATCH' && obs.map((o) => o.e).join() === '3,5,6',
      'đổi ⇒ obs CHANGED; khớp lại ⇒ obs MATCH + held CONFLICT_OPEN (không tự mở); lặp ⇒ eval có, obs không',
      JSON.stringify({ c: [pubCode(r5), pubCode(r6), pubCode(r7)], obs, s7 }))
    const cv7 = await asU(U.super, `SELECT public.rpc_cms_return_conflicts($1) r`, [CL.id])
    ok(cv7.proof?.eval_seq === 7 && cv7.proof.open_set_hash === s7.oh && cv7.open_count === 1 && cv7.open[0]?.return_event_id === 'LA'
      && cv7.open[0].observations.length === 3 && cv7.open[0].observations[0].verdict === 'MATCH' && cv7.latest_eval.verdict === 'OPEN_CONFLICT_MATCH',
      'rpc_cms_return_conflicts: proof ứng viên = eval mới nhất OPEN_CONFLICT_MATCH + open_set_hash hiện tại; observation mới nhất trước', JSON.stringify(cv7).slice(0, 300))
    // 10. Confirm: quyền / đầu vào / hash cũ / proof không mới nhất / đúng / replay / idem khác tham số / không còn conflict.
    const cfForbidden = (await confirm(U.mkt, [CL.id, s7.oh, 7, WHY, idem()])).err
    const cfBad = (await confirm(U.super, [CL.id, s7.oh, 7, 'ngắn', idem()])).err
    const cfStale = (await confirm(U.super, [CL.id, '0'.repeat(64), 7, WHY, idem()])).err
    const cfNotLatest = (await confirm(U.super, [CL.id, s7.oh, 6, WHY, idem()])).err
    ok(cfForbidden === 'CMS_RETURN_CONFIRM_FORBIDDEN' && cfBad === 'CMS_RETURN_CONFIRM_BAD_INPUT' && cfStale === 'CMS_RETURN_OPEN_SET_STALE'
      && cfNotLatest === 'CMS_RETURN_PROOF_NOT_LATEST', 'confirm từ chối: không super / lý do ngắn / open_set_hash cũ / proof không phải eval mới nhất',
      JSON.stringify([cfForbidden, cfBad, cfStale, cfNotLatest]))
    const k1 = idem()
    const cOk = await confirm(U.super, [CL.id, s7.oh, 7, WHY, k1])
    const sC = await st()
    const cAgain = await confirm(U.super, [CL.id, s7.oh, 7, WHY, k1])
    const cReuse = await confirm(U.super, [CL.id, s7.oh, 7, WHY + ' khác', k1])
    const cNone = await confirm(U.super, [CL.id, sC.oh, 7, WHY, idem()])
    ok(cOk.confirmed === true && cOk.already === false && cOk.conflicts === 1 && sC.nopen === 0 && sC.nrest === 1 && sC.ptr === r2.runId && sC.nb === 3
      && sC.lh === s7.lh && cAgain.already === true && cAgain.id === cOk.id && cReuse.err === 'CMS_IDEM_REUSED' && cNone.err === 'CMS_RETURN_NO_OPEN_CONFLICT',
      'confirm đúng ⇒ 1 phục hồi, 0 conflict mở, không đổi tiền / baseline / pointer; replay = already; idem khác tham số ⇒ IDEM_REUSED; hết conflict ⇒ NO_OPEN',
      JSON.stringify({ cOk, sC, cAgain, cReuse, cNone }))
    // 11. Lượt sau sạch ⇒ công bố, nhận LD.
    const r8 = await lpub([RA, RB, RN, RC, RD])
    s = await st()
    ok(r8.pub?.published === true && r8.pub.baselines_new === 1 && s.nb === 4 && s.ptr === r8.runId, 'sau phục hồi lượt sạch ⇒ công bố + nhận LD',
      JSON.stringify({ p: r8.pub ?? pubCode(r8), s }))
    // 12. LA chuyển chưa hiệu lực ⇒ conflict MỚI nối chuỗi (prev = conflict đã phục hồi), loại NOT_EFFECTIVE.
    const r9 = await lpub([RA_NE, RB, RN, RC, RD])
    const c2 = await X.one(`SELECT id::int, prev_conflict_id::int prev, opened_kind k FROM public.cms_return_conflicts
      WHERE program_id = $1 AND return_event_id = 'LA' AND id <> $2`, [CL.id, c1.id])
    s = await st()
    ok(pubCode(r9) === 'CMS_RETURN_LEDGER_CONFLICT' && c2?.prev === c1.id && c2?.k === 'NOT_EFFECTIVE' && s.nopen === 1 && s.ptr === r8.runId,
      'sau phục hồi lệch lại ⇒ conflict mới prev = conflict đã phục hồi (không RESOLVED), NOT_EFFECTIVE', JSON.stringify({ c: pubCode(r9), c2, s }))
    // Đột biến G08 14/11 sống sót ⇒ kiểm nội dung observed: status = trạng thái nguồn nguyên văn (không phải effect); CHANGED mang lượng / tiền mới.
    const obsJ = Object.fromEntries((await X.all(`SELECT o.conflict_id::int || ':' || o.version k, o.observed j FROM public.cms_return_conflict_observations o
      WHERE o.conflict_id = ANY($1::bigint[])`, [[c1.id, c2?.id ?? 0]])).map((x) => [x.k, typeof x.j === 'string' ? JSON.parse(x.j) : x.j]))
    const oMiss = obsJ[`${c1.id}:1`], oChg = obsJ[`${c1.id}:2`], oNe = obsJ[`${c2?.id}:1`]
    ok(canon(oMiss) === '{}' && oChg?.status === 'COMPLETED' && oChg.effect === 'EFFECTIVE' && oChg.base === RA_CHG.return_base_quantity
      && oChg.refund === RA_CHG.return_gmv_amount && typeof oChg.recorded_at === 'string'
      && oNe?.status === 'APPROVED' && oNe.effect === 'NOT_EFFECTIVE' && oNe.base === undefined,
      'observed: MISSING = {}; CHANGED = status nguồn COMPLETED + effect + lượng / tiền mới; NOT_EFFECTIVE = status APPROVED (không phải effect)',
      JSON.stringify({ oMiss, oChg, oNe }))

    // 13. Ghi thẳng bằng owner (r2.1 §14.3): bất biến; thứ tự eval; chuỗi conflict; guard observation / baseline; NULL / giá trị lạ từng cột.
    const raw = async (sql, p = []) => {
      const r = await settle(X.db.query(sql, p))
      return r.ok ? 'OK' : (/\bCMS_[A-Z_]+\b/.exec(r.err)?.[0] ?? /violates check constraint|null value in column|violates foreign key|duplicate key/.exec(r.err)?.[0] ?? r.err.slice(0, 100))
    }
    const insJ = (table, row) => raw(`INSERT INTO public.${table} ${table === 'cms_return_conflicts' ? 'OVERRIDING SYSTEM VALUE ' : ''}SELECT * FROM jsonb_populate_record(NULL::public.${table}, $1::jsonb)`, [JSON.stringify(row)])
    const tx = async (fn) => { await X.db.exec('BEGIN'); try { return await fn() } finally { await X.db.exec('ROLLBACK') } }
    const imm = [
      await raw(`UPDATE public.cms_return_baselines SET refund_amount = 1 WHERE program_id = $1`, [CL.id]),
      await raw(`DELETE FROM public.cms_return_ledger_evals WHERE program_id = $1`, [CL.id]),
      await raw(`TRUNCATE public.cms_return_conflict_observations`),
      await raw(`DELETE FROM public.cms_return_conflict_restorations WHERE program_id = $1`, [CL.id]),
      await raw(`UPDATE public.cms_return_conflicts SET opened_kind = 'CHANGED' WHERE program_id = $1`, [CL.id]),
      await raw(`DELETE FROM public.cms_return_restorations WHERE program_id = $1`, [CL.id]),
    ]
    ok(imm.every((x) => x === 'CMS_LEDGER_IMMUTABLE'), 'owner UPDATE / DELETE / TRUNCATE 6 bảng ledger ⇒ CMS_LEDGER_IMMUTABLE', imm.join(' '))
    const evJ = (await X.one(`SELECT to_jsonb(e) j FROM public.cms_return_ledger_evals e WHERE program_id = $1 ORDER BY eval_seq DESC LIMIT 1`, [CL.id])).j
    const ev10 = { ...evJ, kind: 'report', run_id: null, report_attempt: idem(), eval_seq: evJ.eval_seq + 1 }
    const ord = [
      await insJ('cms_return_ledger_evals', { ...ev10, eval_seq: evJ.eval_seq + 2 }),
      await insJ('cms_return_ledger_evals', { ...ev10, eval_seq: evJ.eval_seq }),
      await insJ('cms_return_ledger_evals', { ...ev10, kind: 'run', run_id: r9.runId, report_attempt: null, returns_as_of: '2000-01-01T00:00:00Z' }),
      await insJ('cms_return_ledger_evals', ev10),
    ]
    ok(evJ.eval_seq === 9 && ord.slice(0, 3).every((x) => x === 'CMS_LEDGER_EVAL_ORDER') && ord[3] === 'CMS_LEDGER_EVAL_BIND',
      'eval ghi thẳng: nhảy số / trùng số / as_of lùi ⇒ EVAL_ORDER; kind report ở chương trình chưa chốt ⇒ EVAL_BIND', ord.join(' '))
    const cJ = (await X.one(`SELECT to_jsonb(c) j FROM public.cms_return_conflicts c WHERE id = $1`, [c2.id])).j
    const chain = [
      await insJ('cms_return_conflicts', { ...cJ, id: 900001, prev_conflict_id: null }),
      await insJ('cms_return_conflicts', { ...cJ, id: 900002, prev_conflict_id: c2.id }),
      await insJ('cms_return_conflicts', { ...cJ, id: 900003, prev_conflict_id: c1.id }),
    ]
    ok(chain[0] === 'duplicate key' && chain[1] === 'violates foreign key' && chain[2] === 'duplicate key',
      'conflict thứ hai cho cùng phiếu bị DB chặn: đầu chuỗi trùng (NULLS NOT DISTINCT) / trỏ conflict chưa phục hồi (FK) / kế tiếp thứ hai (UNIQUE)', chain.join(' '))
    const oJ = (await X.one(`SELECT to_jsonb(o) j FROM public.cms_return_conflict_observations o WHERE conflict_id = $1 ORDER BY version DESC LIMIT 1`, [c2.id])).j
    // Eval ghi thẳng (guard eval tắt trong transaction) + dòng phụ thuộc trong CÙNG transaction (evaluated_at = now() — luật P2-2).
    const withEvT = (table, row, evOver = {}) => tx(async () => {
      await X.db.exec(`ALTER TABLE public.cms_return_ledger_evals DISABLE TRIGGER cms_ledger_eval_guard`)
      const nowJ = (await X.one(`SELECT to_jsonb(now()) j`)).j
      const a = await insJ('cms_return_ledger_evals', { ...ev10, evaluated_at: nowJ, ...evOver })
      return a === 'OK' ? insJ(table, row) : `setup ${a}`
    })
    const withEv = (row) => withEvT('cms_return_conflict_observations', row)
    // evaluated_at cũ = eval đã commit ở transaction TRƯỚC (luật P2-2: dòng phụ thuộc chỉ ghi cùng transaction với eval).
    const oldJ = (await X.one(`SELECT to_jsonb(now() - interval '1 hour') j`)).j
    const oNext = { ...oJ, version: oJ.version + 1, eval_seq: ev10.eval_seq, verdict: 'MISSING', observed_fp: null, observed: {} }
    const og = [
      await insJ('cms_return_conflict_observations', { ...oJ, conflict_id: c1.id, version: 4 }),
      await withEv({ ...oNext, version: oJ.version + 2 }),
      await withEv({ ...oNext, verdict: 'MATCH', observed_fp: '0'.repeat(64) }),
      await withEv(oNext),
    ]
    ok(og.slice(0, 3).every((x) => x === 'CMS_LEDGER_INSERT_GUARD') && og[3] === 'OK',
      'observation ghi thẳng: conflict đã phục hồi / nhảy version / MATCH sai fp ⇒ INSERT_GUARD (đối chứng hợp lệ qua)', og.join(' '))
    const oLate = await withEvT('cms_return_conflict_observations', oNext, { evaluated_at: oldJ })
    ok(oLate === 'CMS_LEDGER_INSERT_GUARD' && og[3] === 'OK',
      'observation ghi ở transaction SAU eval (evaluated_at ≠ now()) ⇒ INSERT_GUARD; cùng dòng trong cùng transaction với eval thì qua', oLate)
    const bJ = (await X.one(`SELECT to_jsonb(b) || jsonb_build_object('return_event_id', 'LZ', 'financial_fp', public.cms__return_fp(b.fp_version,
        b.program_id, 'LZ', b.return_document_id, b.original_order_line_id, b.original_order_id, b.product_id, b.base_quantity, b.refund_amount,
        b.recorded_at)) j FROM public.cms_return_baselines b WHERE program_id = $1 AND return_event_id = 'LA'`, [CL.id])).j
    const r8eval = (await lrun(r8.runId)).les
    const bg = [
      await insJ('cms_return_baselines', { ...bJ, accepted_eval_seq: 9, accepted_run_id: r9.runId }),
      await insJ('cms_return_baselines', { ...bJ, accepted_eval_seq: r8eval, accepted_run_id: r8.runId }),
    ]
    ok(bg.every((x) => x === 'CMS_LEDGER_INSERT_GUARD'), 'baseline ghi thẳng: eval MISMATCH / eval CLEAN cũ (không mới nhất) ⇒ INSERT_GUARD', bg.join(' '))
    const nOpenCL = Number((await X.one(`SELECT count(*)::int n FROM public.cms_return_conflicts c WHERE c.program_id = $1
      AND NOT EXISTS (SELECT 1 FROM public.cms_return_conflict_restorations x WHERE x.conflict_id = c.id)`, [CL.id])).n)
    const vd = [
      await insJ('cms_return_ledger_evals', { ...ev10, kind: 'run', run_id: r9.runId, report_attempt: null, verdict: 'CLEAN', mismatched: 0, open_conflicts: 0 }),
      await insJ('cms_return_ledger_evals', { ...ev10, kind: 'run', run_id: r9.runId, report_attempt: null, verdict: 'OPEN_CONFLICT_MATCH', mismatched: 0,
        open_conflicts: nOpenCL + 1 }),
      await insJ('cms_return_ledger_evals', { ...ev10, kind: 'run', run_id: r9.runId, report_attempt: null, verdict: 'MISMATCH', mismatched: 1,
        open_conflicts: nOpenCL - 1 }),
    ]
    ok(nOpenCL > 0 && vd.every((x) => x === 'CMS_LEDGER_EVAL_VERDICT'),
      'eval ghi thẳng (owner): CLEAN khi còn conflict mở / OPEN_CONFLICT_MATCH sai số conflict mở / MISMATCH khai ít hơn số đang mở ⇒ CMS_LEDGER_EVAL_VERDICT', `${nOpenCL} ${vd.join(' ')}`)
    // Sàn as_of gồm run net đã khai seal mà chưa ghi eval (held / error trước publish): phát lại snapshot cũ hơn ⇒ AS_OF_REGRESSION.
    const PF = await X.makeProgram({ name: 'QA sàn as_of run chưa eval', isTest: true, products: [{ pid: X.pid(), k: '1', unit: 'Viên' }], v2: 'cms_unit' })
    await setNet(PF)
    const fS = srow(PF, { pid: PF.products[0].pid, q: '2', u: 'Viên', base: 2 })
    const fR = rrow(PF, fS, { id: 'F1', base: 1, min: 50 })
    const fNow = BigInt(Date.now()) * BigInt(1000)
    const f1 = await crun(PF, [fS], [fR], { asOf: fNow - BigInt(60_000_000), publish: true })
    const f2 = await crun(PF, [fS], [fR], { asOf: fNow - BigInt(10_000_000) })
    const f2r = await runRow(f2.runId)
    const f3 = await crun(PF, [fS], [fR], { asOf: fNow - BigInt(30_000_000), publish: true })
    const fEv = Number((await X.one(`SELECT count(*)::int n FROM public.cms_return_ledger_evals WHERE program_id = $1`, [PF.id])).n)
    ok(f1.pub?.published === true && f2.last?.sealed === true && f2r.status === 'error' && f3.last?.sealed === true
      && f3.pub?.code === 'CMS_RETURN_AS_OF_REGRESSION' && fEv === 1,
      'sàn as_of: run net seal đủ rồi error trước eval (as_of mới) ⇒ phát lại snapshot cũ hơn (vẫn mới hơn eval) ⇒ AS_OF_REGRESSION, 0 eval mới',
      JSON.stringify({ p1: f1.pub, f2: [f2.last?.sealed, f2r.status], p3: f3.pub ?? f3.last, fEv }))
    const fz = (await X.one(`SELECT to_jsonb(b) || jsonb_build_object('return_event_id', 'FZ', 'financial_fp', public.cms__return_fp(b.fp_version,
        b.program_id, 'FZ', b.return_document_id, b.original_order_line_id, b.original_order_id, b.product_id, b.base_quantity, b.refund_amount,
        b.recorded_at)) j FROM public.cms_return_baselines b WHERE program_id = $1 AND return_event_id = 'F1'`, [PF.id])).j
    const late = await insJ('cms_return_baselines', fz)
    ok(late === 'CMS_LEDGER_INSERT_GUARD', 'baseline ghi thẳng ở transaction SAU eval CLEAN mới nhất ⇒ INSERT_GUARD (chỉ cùng lượt đánh giá)', late)
    // Proof = eval MỚI NHẤT nhưng as_of < sàn: run net đã khai seal as_of mới hơn rồi error trước eval ⇒ confirm CMS_RETURN_PROOF_STALE (không
    // xác nhận trên snapshot cũ hơn mốc DB đã thấy); lượt sau ghi eval mới khớp lại ⇒ confirm trên proof mới qua (đột biến r3 E06).
    const PQ = await X.makeProgram({ name: 'QA proof cũ hơn sàn', isTest: true, products: [{ pid: X.pid(), k: '1', unit: 'Viên' }], v2: 'cms_unit' })
    await setNet(PQ)
    const qS = srow(PQ, { pid: PQ.products[0].pid, q: '2', u: 'Viên', base: 2 })
    const qR = rrow(PQ, qS, { id: 'Q1', base: 1, min: 50 })
    const qNow = BigInt(Date.now()) * BigInt(1000)
    const qAt = (sec) => qNow - BigInt(120_000_000) + BigInt(sec) * BigInt(1_000_000)
    const qTop = async () => {
      const r = await X.one(`SELECT (SELECT max(eval_seq)::int FROM public.cms_return_ledger_evals WHERE program_id = $1) seq,
        public.cms__open_set_hash($1) oh`, [PQ.id])
      return { seq: Number(r.seq), oh: r.oh }
    }
    const q1 = await crun(PQ, [qS], [qR], { asOf: qAt(0), publish: true })
    const q2 = await crun(PQ, [qS], [], { asOf: qAt(10), publish: true })
    const q3 = await crun(PQ, [qS], [qR], { asOf: qAt(20), publish: true })
    const qp3 = await qTop()
    const q4 = await crun(PQ, [qS], [qR], { asOf: qAt(40) })
    const q4r = await runRow(q4.runId)
    const qp4 = await qTop()
    const qStale = await confirm(U.super, [PQ.id, qp4.oh, qp4.seq, WHY, idem()])
    const q5 = await crun(PQ, [qS], [qR], { asOf: qAt(60), publish: true })
    const qp5 = await qTop()
    const qOk = await confirm(U.super, [PQ.id, qp5.oh, qp5.seq, WHY, idem()])
    ok(q1.pub?.published === true && q2.pub?.code === 'CMS_RETURN_LEDGER_CONFLICT' && q3.pub?.code === 'CMS_RETURN_CONFLICT_OPEN' && qp3.seq === 3
      && q4.last?.sealed === true && q4r.status === 'error' && qp4.seq === 3 && qp4.oh === qp3.oh && qStale.err === 'CMS_RETURN_PROOF_STALE'
      && q5.pub?.code === 'CMS_RETURN_CONFLICT_OPEN' && qp5.seq === 4 && qOk.confirmed === true && qOk.conflicts === 1,
      'confirm trên proof = eval mới nhất nhưng as_of < sàn (run net đã khai seal mới hơn, error trước eval) ⇒ PROOF_STALE; eval mới khớp lại ⇒ confirm qua',
      JSON.stringify({ p: [q1.pub?.published, q2.pub?.code, q3.pub?.code, q5.pub?.code], q4: [q4.last?.sealed, q4r.status], qp3, qp4, qStale, qp5, qOk }))
    // NULL / giá trị lạ: CHECK / NOT NULL phải tự từ chối (eval: tắt guard trong transaction để chứng minh ràng buộc, không nhờ trigger).
    const nul = []
    let nP = 0
    const isRej = (x) => x === 'violates check constraint' || x === 'null value in column'
    const np = async (table, row, label) => { nP++; const x = await tx(() => insJ(table, row)); if (!isRej(x)) nul.push(`${label}=${x}`) }
    const npEv = async (row, label) => {
      nP++
      const x = await tx(async () => { await X.db.exec(`ALTER TABLE public.cms_return_ledger_evals DISABLE TRIGGER cms_ledger_eval_guard`); return insJ('cms_return_ledger_evals', row) })
      if (!isRej(x)) nul.push(`${label}=${x}`)
    }
    const npObs = async (row, label) => { nP++; const x = await withEv(row); if (!isRej(x)) nul.push(`${label}=${x}`) }
    const bBase = { ...bJ, accepted_eval_seq: 9, accepted_run_id: r9.runId }
    for (const c of ['program_id', 'return_event_id', 'fp_version', 'financial_fp', 'return_document_id', 'original_order_line_id', 'original_order_id',
      'product_id', 'base_quantity', 'refund_amount', 'recorded_at', 'accepted_eval_seq', 'accepted_at']) await np('cms_return_baselines', { ...bBase, [c]: null }, `b.${c}`)
    await np('cms_return_baselines', { ...bBase, accepted_run_id: null }, 'b.accepted cả hai NULL')
    await np('cms_return_baselines', { ...bBase, accepted_report_id: idem() }, 'b.accepted cả hai')
    await np('cms_return_baselines', { ...bBase, fp_version: 'cms-return-fp-v0' }, 'b.fp_version lạ')
    await np('cms_return_baselines', { ...bBase, financial_fp: 'a'.repeat(64) }, 'b.financial_fp sai')
    await np('cms_return_baselines', { ...bBase, refund_amount: '100000.5' }, 'b.refund đổi (fp cũ)')
    for (const c of ['program_id', 'eval_seq', 'kind', 'returns_as_of', 'returns_digest', 'verdict', 'baselines', 'mismatched', 'open_conflicts',
      'ledger_set_hash', 'open_set_hash', 'config_version', 'evaluated_at']) await npEv({ ...ev10, [c]: null }, `e.${c}`)
    await npEv({ ...ev10, report_attempt: null }, 'e.report thiếu attempt')
    await npEv({ ...ev10, run_id: r9.runId }, 'e.report kèm run')
    await npEv({ ...ev10, verdict: 'CLEAN' }, 'e.CLEAN có lệch')
    await npEv({ ...ev10, verdict: 'OPEN_CONFLICT_MATCH' }, 'e.OPEN_CONFLICT_MATCH có lệch')
    const cBase = { ...cJ, id: 900010, return_event_id: 'LB', prev_conflict_id: null }
    const cCtrl = await withEvT('cms_return_conflicts', { ...cBase, opened_eval_seq: ev10.eval_seq },
      { verdict: 'MISMATCH', mismatched: 1, open_conflicts: Math.max(ev10.open_conflicts, 1) })
    const cLate = await withEvT('cms_return_conflicts', { ...cBase, opened_eval_seq: ev10.eval_seq },
      { verdict: 'MISMATCH', mismatched: 1, open_conflicts: Math.max(ev10.open_conflicts, 1), evaluated_at: oldJ })
    ok(cCtrl === 'OK' && cLate === 'CMS_LEDGER_INSERT_GUARD',
      'conflict ghi ở transaction SAU eval MISMATCH (evaluated_at ≠ now()) ⇒ INSERT_GUARD; cùng dòng trong cùng transaction thì qua', `${cCtrl} ${cLate}`)
    for (const c of ['program_id', 'return_event_id', 'opened_kind', 'opened_eval_seq', 'opened_at']) await np('cms_return_conflicts', { ...cBase, [c]: null }, `c.${c}`)
    await np('cms_return_conflicts', { ...cBase, opened_kind: 'MATCH' }, 'c.opened_kind MATCH')
    for (const c of ['conflict_id', 'version', 'program_id', 'eval_seq', 'verdict', 'observed', 'observed_at']) await npObs({ ...oNext, [c]: null }, `o.${c}`)
    await npObs({ ...oNext, verdict: 'CHANGED' }, 'o.CHANGED thiếu fp')
    await npObs({ ...oNext, observed_fp: 'b'.repeat(64) }, 'o.MISSING có fp')
    await npObs({ ...oNext, observed: [] }, 'o.observed mảng')
    await npObs({ ...oNext, version: 0 }, 'o.version 0')
    const rJ = { ...(await X.one(`SELECT to_jsonb(r) j FROM public.cms_return_restorations r WHERE id = $1`, [cOk.id])).j, id: idem(), idem_key: idem(), proof_eval_seq: 9 }
    for (const c of ['id', 'program_id', 'proof_eval_seq', 'open_set_hash', 'ledger_set_hash', 'conflicts', 'reason', 'confirmed_by', 'confirmed_at', 'idem_key']) {
      await np('cms_return_restorations', { ...rJ, [c]: null }, `r.${c}`)
    }
    await np('cms_return_restorations', { ...rJ, reason: 'ngắn' }, 'r.reason ngắn')
    await np('cms_return_restorations', { ...rJ, reason: WHY + ' ' }, 'r.reason chưa cắt')
    await np('cms_return_restorations', { ...rJ, conflicts: 0 }, 'r.conflicts 0')
    // Phục hồi phải nối ĐỦ số conflict khai (db-reviewer 14/11 P1-2: đếm một lần mỗi phục hồi). Một transaction: eval OPEN_CONFLICT_MATCH
    // mới nhất (guard eval tắt) + observation MATCH đúng fp baseline + phục hồi khai `declared` conflict + 1 liên kết (c2 — conflict mở duy
    // nhất). declared = 1 ⇒ qua (đối chứng); declared = 2 ⇒ thiếu liên kết ⇒ INSERT_GUARD.
    const fpLA = (await X.one(`SELECT financial_fp fp FROM public.cms_return_baselines WHERE program_id = $1 AND return_event_id = 'LA'`, [CL.id])).fp
    const restLinks = (declared) => tx(async () => {
      await X.db.exec(`ALTER TABLE public.cms_return_ledger_evals DISABLE TRIGGER cms_ledger_eval_guard`)
      const hs = await X.one(`SELECT to_jsonb(now()) n, public.cms__ledger_set_hash($1) lh`, [CL.id])
      const evRow = (oh) => ({ ...ev10, verdict: 'OPEN_CONFLICT_MATCH', mismatched: 0, open_conflicts: declared, open_set_hash: oh, ledger_set_hash: hs.lh,
        evaluated_at: hs.n })
      const obsRow = { ...oNext, verdict: 'MATCH', observed_fp: fpLA }
      // open_set_hash gồm version observation mới nhất ⇒ đo hash SAU observation trong savepoint, rồi ghi lại đúng thứ tự (cùng now()).
      await X.db.exec('SAVEPOINT oh')
      const p1 = await insJ('cms_return_ledger_evals', evRow('0'.repeat(64)))
      const p2 = p1 === 'OK' ? await insJ('cms_return_conflict_observations', obsRow) : 'skip'
      const oh = p2 === 'OK' ? (await X.one(`SELECT public.cms__open_set_hash($1) oh`, [CL.id])).oh : null
      await X.db.exec('ROLLBACK TO SAVEPOINT oh')
      if (oh === null) return `setup pre ${p1} ${p2}`
      const steps = [
        ['eval', 'cms_return_ledger_evals', evRow(oh)],
        ['obs', 'cms_return_conflict_observations', obsRow],
        ['rest', 'cms_return_restorations', { ...rJ, proof_eval_seq: ev10.eval_seq, open_set_hash: oh, ledger_set_hash: hs.lh, conflicts: declared }],
      ]
      for (const [k, tb, row] of steps) { const a = await insJ(tb, row); if (a !== 'OK') return `setup ${k} ${a}` }
      return insJ('cms_return_conflict_restorations', { conflict_id: c2.id, restoration_id: rJ.id, program_id: CL.id, return_event_id: 'LA' })
    })
    const rl = [await restLinks(1), await restLinks(2)]
    ok(rl[0] === 'OK' && rl[1] === 'CMS_LEDGER_INSERT_GUARD',
      'phục hồi khai 2 conflict nhưng chỉ nối 1 ⇒ INSERT_GUARD; khai đúng 1 thì qua (đối chứng cùng transaction)', rl.join(' '))
    const crBase = { conflict_id: c2.id, restoration_id: cOk.id, program_id: CL.id, return_event_id: 'LA' }
    for (const c of Object.keys(crBase)) await np('cms_return_conflict_restorations', { ...crBase, [c]: null }, `cr.${c}`)
    const runProbe = async (set, label) => { nP++; const x = await tx(() => raw(`UPDATE public.cms_sync_runs SET ${set} WHERE id = $1`, [r8.runId])); if (!isRej(x)) nul.push(`${label}=${x}`) }
    await runProbe(`ledger_verdict = 'MISMATCH'`, 'run ok MISMATCH')
    await runProbe(`ledger_verdict = NULL, ledger_set_hash = NULL, ledger_checked_at = NULL`, 'run ok verdict NULL')
    await runProbe(`ledger_eval_seq = NULL`, 'run ok net thiếu eval')
    // FK bốn cột (db-reviewer 14/11 P2-1): phán quyết trên run phải = phán quyết eval của nó.
    nP++
    const fkV = await tx(() => raw(`UPDATE public.cms_sync_runs SET ledger_verdict = 'OPEN_CONFLICT_MATCH' WHERE id = $1`, [r3.runId]))
    if (fkV !== 'violates foreign key') nul.push(`run held đổi phán quyết ≠ eval=${fkV}`)
    ok(cCtrl === 'OK' && nul.length === 0 && nP >= 60, `NULL / giá trị lạ ghi thẳng ở 6 bảng ledger + run ⇒ CHECK / NOT NULL tự từ chối (${nP} probe, đối chứng hợp lệ qua)`,
      `${cCtrl} ${nul.join(' ')}`)

    // 14. Cleanup không chạm sổ (bằng chứng còn sau cleanup — r2 §6.5).
    const sBefore = await st()
    let more = true
    for (let i = 0; i < 40 && more; i++) more = (await X.rpc(`SELECT public.rpc_cms_sales_run_cleanup($1, 50000) r`, [CL.id])).more
    const sAfter = await st()
    ok(!more && canon(sBefore) === canon(sAfter), 'cleanup chương trình có sổ ⇒ baseline / eval / conflict / observation / phục hồi giữ nguyên',
      JSON.stringify({ sBefore, sAfter }))

    // 15. Sales-only contract: công bố không eval; chương trình thật pos_base + net: công bố + baseline.
    const cuP = await crun(CU, CU_SALES, [], { publish: true })
    const cuL = await lrun(cuP.runId)
    const cuE = await X.one(`SELECT count(*)::int n FROM public.cms_return_ledger_evals WHERE program_id = $1`, [CU.id])
    ok(cuP.pub?.published === true && cuL.status === 'ok' && cuL.lv === 'CLEAN' && cuL.les === null && cuL.rb === 'sales_only_v1' && cuE.n === 0,
      'CU sales-only contract ⇒ công bố, ledger CLEAN không eval, căn cứ sales_only_v1', JSON.stringify({ p: cuP.pub ?? pubCode(cuP), cuL, cuE }))
    const pbP = await crun(PB, PB_S, PB_R, { publish: true })
    const pbB = await X.one(`SELECT count(*)::int n FROM public.cms_return_baselines WHERE program_id = $1`, [PB.id])
    ok(pbP.pub?.published === true && pbB.n === 1, 'PB pos_base + net chương trình thật ⇒ công bố + baseline P1', JSON.stringify({ p: pbP.pub ?? pubCode(pbP), pbB }))

    // 15b. Chốt (cms__lock_eval vá 130): run contract ⇒ CONTRACT_UNSUPPORTED; conflict mở ⇒ RETURN_CONFLICT; chế độ chương trình ≠ căn cứ
    //      run hiện hành ⇒ POLICY_POINTER_MISMATCH; chứng nhận nguồn trên run contract ⇒ CONTRACT_UNSUPPORTED (attest_eval).
    const lp = async (id) => (await X.rpc(`SELECT public.rpc_cms_lock_preview($1) r`, [id])).blockers ?? []
    const PM = await X.makeProgram({ name: 'QA pointer lệch chế độ', isTest: true, products: [{ pid: X.pid(), k: '1' }], v2: 'pos_base' })
    const pmSync = await X.sync(PM, X.rows(PM, [{ pid: PM.products[0].pid, s: 0, base: 3 }]))
    const pmB0 = await lp(PM.id)
    await setNet(PM)
    const pmB1 = await lp(PM.id)
    const [clB, cuB] = [await lp(CL.id), await lp(CU.id)]
    const clOpen = (await st()).nopen
    // Chứng nhận decision10 giả gắn run contract (owner, tắt guard chèn trong transaction ROLLBACK) ⇒ attest_eval phải từ chối.
    const now = new Date().toISOString()
    const attRow = { id: idem(), program_id: CL.id, run_id: r8.runId, config_version: 1, mapping_fp: '0'.repeat(32), basis: 'operator_reconciliation',
      fp_version: 'cms-rows-fp-v1', field_set: 'decision10', scope_from: CL.start, scope_to: CL.end, scope_hash: '0'.repeat(64), run_rows_fp: '0'.repeat(64),
      run_file_sha256: '0'.repeat(64), reference_rows_fp: '0'.repeat(64), reference_file_sha256: '0'.repeat(64), reference_label: 'QA ref',
      as_of: now, reference_exported_at: now, run_exported_at: now, lines_compared: 1, missing_lines: 0, extra_lines: 0, changed_lines: 0,
      tool_version: 'cms-i4-compare-v1', ack_reason: 'QA chứng nhận giả trên run contract', idem_key: idem(), payload_sha256: '0'.repeat(64), attested_by: U.super, attested_at: now }
    let attC = null
    await X.db.exec('BEGIN')
    try {
      await X.db.exec(`ALTER TABLE public.cms_source_attestations DISABLE TRIGGER cms_attest_insert_guard`)
      await X.db.query(`INSERT INTO public.cms_source_attestations SELECT * FROM jsonb_populate_record(NULL::public.cms_source_attestations, $1::jsonb)`, [JSON.stringify(attRow)])
      attC = (await X.one(`SELECT public.cms__attest_eval($1, $2) ->> 'code' c`, [CL.id, r8.runId])).c
    } catch (e) { attC = `ERR ${String(e.message).slice(0, 100)}` } finally { await X.db.exec('ROLLBACK') }
    ok(pmSync.status === 'published' && !pmB0.includes('CMS_LOCK_POLICY_POINTER_MISMATCH') && pmB1.includes('CMS_LOCK_POLICY_POINTER_MISMATCH')
      && clOpen > 0 && clB.includes('CMS_LOCK_RETURN_CONFLICT') && clB.includes('CMS_LOCK_CONTRACT_UNSUPPORTED')
      && cuB.includes('CMS_LOCK_CONTRACT_UNSUPPORTED') && !cuB.includes('CMS_LOCK_RETURN_CONFLICT') && !cuB.includes('CMS_LOCK_POLICY_POINTER_MISMATCH')
      && attC === 'CONTRACT_UNSUPPORTED',
      'chốt: pos_base legacy đổi net khi pointer còn run legacy ⇒ POLICY_POINTER_MISMATCH; CL (contract + conflict mở) ⇒ CONTRACT_UNSUPPORTED + RETURN_CONFLICT; CU contract sạch ⇒ chỉ CONTRACT_UNSUPPORTED; chứng nhận trên run contract ⇒ attest CONTRACT_UNSUPPORTED',
      JSON.stringify({ pm: [pmSync.status, pmB0, pmB1], clOpen, clB, cuB, attC }))

    // 16. Reader (r2 §8): 4 reader 122 RAISE trên run contract, run legacy đọc bình thường; v2 mang khối contract ghim từ run; quyền.
    const old = [
      await asU(U.super, `SELECT public.rpc_cms_result_header($1) r`, [CL.id]),
      await asU(U.super, `SELECT public.rpc_cms_result_rows($1, $2) r`, [CL.id, r8.runId]),
      await asU(U.super, `SELECT public.rpc_cms_result_lines($1, $2, NULL, NULL, NULL, 20) r`, [CL.id, r8.runId]),
      await asU(U.super, `SELECT public.rpc_cms_result_excluded($1, $2, NULL, 100) r`, [CL.id, r8.runId]),
    ]
    const oldLegacy = await asU(U.super, `SELECT public.rpc_cms_result_header($1) r`, [X.LIVE.id])
    ok(old.every((x) => x.err === 'CMS_RESULT_CONTRACT_UNSUPPORTED') && oldLegacy.run?.id,
      '4 reader 122 trên run contract ⇒ CMS_RESULT_CONTRACT_UNSUPPORTED; chương trình legacy đọc bình thường', JSON.stringify(old.map((x) => x.err ?? 'OK')))
    const h2 = await asU(U.super, `SELECT public.rpc_cms_result_header_v2($1) r`, [CL.id])
    const h2l = await asU(U.super, `SELECT public.rpc_cms_result_header_v2($1) r`, [X.LIVE.id])
    ok(h2.run?.id === r8.runId && h2.run.contract.legacy === false && h2.run.contract.quantity_basis === 'cms_unit'
      && h2.run.contract.returns_policy === 'net_returns_v1' && h2.run.ledger?.verdict === 'CLEAN' && h2.ledger?.open_conflicts === 1
      && h2.last_attempt?.ledger_verdict === 'MISMATCH' && h2l.run?.contract?.legacy === true && h2l.run.contract.returns_policy === 'sales_only_v1',
      'header_v2: run contract (cms_unit / net / ledger) + sổ; run legacy = pos_base + sales_only_v1', JSON.stringify({ h2: h2.run?.contract, l: h2l.run?.contract }))
    const rv = await asU(U.super, `SELECT public.rpc_cms_result_rows_v2($1, $2) r`, [CL.id, r8.runId])
    const amt = rv.results?.reduce((a, r) => a + BigInt(r.amount_vnd), BigInt(0))
    const r8amt = (await runRow(r8.runId)).amt
    ok(rv.contract?.legacy === false && rv.results.length > 0 && rv.results.every((r) => r.net && r.net.return_count >= 0)
      && rv.results.some((r) => r.net.return_count > 0) && amt.toString() === r8amt,
      'rows_v2: nhóm có khối net (bán / trả / đủ điều kiện); Σ tiền = tiền run', JSON.stringify({ n: rv.results?.length, amt: String(amt), r8amt }))
    const evAll = []
    let after = null
    for (let i = 0; i < 20; i++) {
      const pg = await asU(U.super, `SELECT public.rpc_cms_result_events_v2($1, $2, NULL, NULL, $3, 2) r`, [CL.id, r8.runId, after])
      evAll.push(...pg.rows)
      after = pg.next_after_seq
      if (after === null) break
    }
    const evN = (await X.one(`SELECT count(*)::int n FROM public.cms_result_events WHERE run_id = $1`, [r8.runId])).n
    const evRet = evAll.filter((e) => e.kind === 'RETURN')
    ok(evAll.length === evN && evRet.length > 0 && evRet.every((e) => e.pos_code === null && e.quantity_raw === null && e.return_code)
      && evAll.filter((e) => e.kind === 'SALE').every((e) => e.pos_code), 'events_v2: keyset đủ sự kiện; RETURN có mã phiếu, không POS / lượng thô gốc',
      JSON.stringify({ got: evAll.length, evN }))
    const evL = await asU(U.super, `SELECT public.rpc_cms_result_events_v2($1, $2, NULL, NULL, NULL, 500) r`, [X.LIVE.id, h2l.run.id])
    const rlN = (await X.one(`SELECT count(*)::int n FROM public.cms_result_lines WHERE run_id = $1`, [h2l.run.id])).n
    ok(evL.contract?.legacy === true && evL.rows.length === rlN && evL.rows.every((e) => e.kind === 'SALE' && e.quantity_class === 'POS_BASE'),
      'events_v2 trên run legacy: cms_result_lines ↦ SALE / POS_BASE', JSON.stringify({ n: evL.rows?.length, rlN }))
    const exD = await asU(U.super, `SELECT public.rpc_cms_result_excluded_v2($1, $2, 'disposition', NULL, 100) r`, [CL.id, r8.runId])
    const exQ = await asU(U.super, `SELECT public.rpc_cms_result_excluded_v2($1, $2, 'quantity', NULL, 100) r`, [CL.id, r8.runId])
    const rt = await asU(U.super, `SELECT public.rpc_cms_result_returns_v2($1, $2, NULL, 100) r`, [CL.id, r8.runId])
    const inL = Object.fromEntries((rt.rows ?? []).map((x) => [x.return_event_id, x.in_ledger]))
    ok(exD.rows?.some((x) => x.order_line_id === Ls.l3.order_line_id && x.quantity_class === 'COUNTED') && exQ.rows?.length === 0
      && rt.rows?.length === 5 && inL.LA && inL.LB && inL.LC && inL.LD && inL.LN === false && rt.rows.some((x) => x.original_seller_email),
      'excluded_v2 (disposition / quantity) + returns_v2 (super: email gốc, in_ledger)', JSON.stringify({ d: exD.rows?.length, q: exQ.rows?.length, inL }))
    const deny = [
      await asU(U.mkt, `SELECT public.rpc_cms_result_excluded_v2($1, $2, 'disposition', NULL, 100) r`, [CL.id, r8.runId]),
      await asU(U.mkt, `SELECT public.rpc_cms_result_returns_v2($1, $2, NULL, 100) r`, [CL.id, r8.runId]),
      await asU(U.mkt, `SELECT public.rpc_cms_return_conflicts($1) r`, [CL.id]),
    ]
    const cvEnd = await asU(U.super, `SELECT public.rpc_cms_return_conflicts($1) r`, [CL.id])
    ok(deny.every((x) => x.err === 'CMS_RESULT_FORBIDDEN') && cvEnd.proof === null && cvEnd.open_count === 1 && cvEnd.restorations.length === 1,
      'excluded / returns / conflicts chỉ super; sau lệch lại không có proof ứng viên', JSON.stringify({ deny: deny.map((x) => x.err), proof: cvEnd.proof }))
  }

  // ── NULL probe trực tiếp (RET2-R2-03): mọi CHECK của 130 từ chối NULL ở cột bắt buộc theo nhánh ──
  {
    const rid = A.runId
    let nProbe = 0
    const probe = async (sql, params) => { nProbe++; const r = await settle(X.db.query(sql, params)); return !r.ok && /violates check constraint|null value in column/.test(r.err) }
    const bad = []
    for (const c of ['quantity_basis', 'quantity_policy_version', 'returns_policy', 'unit_key_version', 'status_dictionary_version', 'source_pin',
      'sales_src_digest', 'returns_as_of', 'returns_digest', 'returns_rows_read', 'seal_step', 'seal_expect']) {
      if (!await probe(`UPDATE public.cms_sync_runs SET ${c} = NULL WHERE id = $1`, [rid])) bad.push(`run.${c}`)
    }
    if (!await probe(`UPDATE public.cms_sync_runs SET ledger_verdict = 'CLEAN' WHERE id = $1`, [rid])) bad.push('run.ledger_verdict thiếu hash')
    for (const c of ['quantity_class', 'eligible_base', 'src_v']) {
      if (!await probe(`UPDATE public.cms_sales_lines SET ${c} = NULL WHERE run_id = $1 AND order_line_id = $2`, [rid, S.s1.order_line_id])) bad.push(`sales.${c}`)
    }
    if (!await probe(`UPDATE public.cms_sales_source_lines SET src_v = NULL WHERE run_id = $1 AND order_line_id = $2`, [rid, S.s1.order_line_id])) bad.push('source.src_v')
    if (!await probe(`UPDATE public.cms_sales_source_lines SET quantity_src = NULL WHERE run_id = $1 AND order_line_id = $2`, [rid, S.s1.order_line_id])) bad.push('source.quantity_src (raw còn)')
    for (const c of ['net_v', 'sale_base', 'return_base', 'eligible_sale_base', 'eligible_return_base', 'eligible_base', 'sale_gmv', 'return_gmv', 'return_count']) {
      if (!await probe(`UPDATE public.cms_results SET ${c} = NULL WHERE run_id = $1`, [rid])) bad.push(`results.${c}`)
    }
    for (const c of ['recorded_at', 'return_document_id', 'original_order_line_id', 'original_order_id', 'product_id', 'return_base_quantity',
      'return_gmv_amount', 'original_completed_at', 'original_order_type', 'original_order_status', 'original_base_quantity', 'original_gmv_amount',
      'sale_ref_line_id', 'status_effect', 'disposition']) {
      if (!await probe(`UPDATE public.cms_return_lines SET ${c} = NULL WHERE run_id = $1 AND return_event_id = 'R1'`, [rid])) bad.push(`ret.${c}`)
    }
    for (const c of ['event_at', 'user_id', 'quantity_class', 'base_delta', 'eligible_delta', 'gmv_delta', 'eligible_before', 'eligible_after',
      'qty_before', 'qty_after', 'amount_vnd', 'status']) {
      if (!await probe(`UPDATE public.cms_result_events SET ${c} = NULL WHERE run_id = $1 AND event_key = 'RETURN:R1'`, [rid])) bad.push(`ev.${c}`)
    }
    if (!await probe(`UPDATE public.cms_result_events SET return_event_id = NULL WHERE run_id = $1 AND event_key = 'RETURN:R1'`, [rid])) bad.push('ev.return_event_id')
    if (!await probe(`UPDATE public.cms_sync_runs SET calc_contract_version = NULL WHERE id = $1`, [rid])) bad.push('run.calc_contract_version')
    ok(bad.length === 0 && nProbe >= 50, `NULL probe trực tiếp: ${nProbe} cột bắt buộc theo nhánh ở 6 bảng ⇒ CHECK / NOT NULL từ chối`, bad.join(' '))
  }

  // ── Cleanup dọn đủ bảng run contract ──
  {
    let more = true
    for (let i = 0; i < 40 && more; i++) more = (await X.rpc(`SELECT public.rpc_cms_sales_run_cleanup($1, 50000) r`, [CN.id])).more
    const left = await X.one(`SELECT count(*) FILTER (WHERE r.cleared_at IS NOT NULL)::int cleared,
      count(*) FILTER (WHERE r.cleared_at IS NOT NULL AND (EXISTS (SELECT 1 FROM public.cms_result_events e WHERE e.run_id = r.id)
        OR EXISTS (SELECT 1 FROM public.cms_return_lines x WHERE x.run_id = r.id) OR EXISTS (SELECT 1 FROM public.cms_sales_source_lines s WHERE s.run_id = r.id)))::int dirty,
      count(*) FILTER (WHERE r.cleared_at IS NULL)::int kept FROM public.cms_sync_runs r WHERE r.program_id = $1`, [CN.id])
    ok(!more && left.cleared > 0 && left.dirty === 0 && left.kept <= 2, 'cleanup run contract: xoá sự kiện → phiếu trả → … → khối; giữ ≤ 2 run held / error gần nhất', JSON.stringify(left))
  }
}

// ── §8 báo cáo trả hàng sau chốt (PM D11 · thiết kế r2 §6.6 / r2.1 §14.2) ─────────────────────────────────────────────────────────
// Chương trình QA pos_base legacy hết kỳ → đồng bộ nguồn qa → CHỐT qa_assumption (lõi lockAction thật) → báo cáo trên dòng bán đóng băng.
async function reportSection() {
  const X = await env('report')
  ok(X.applied.ok, 'DB 4: áp 130', X.applied.err)
  const LD = {
    lockEnabled: () => true, qaReadonly: () => false, access: async () => ({ kind: 'ok', actorId: U.super, qa: true }),
    program: async (id) => { const r = await X.one(`SELECT is_test FROM public.cms_programs WHERE id = $1`, [id]); return r ? { isTest: r.is_test } : null },
    rpc: async (fn, args) => {
      const named = Object.keys(args).map((k, i) => `${k} => $${i + 1}`).join(', ')
      try { return { data: (await X.svc(`SELECT public.${fn}(${named}) r`, Object.values(args))).rows[0].r, error: null } } catch (e) { LD.lastErr = `${fn}: ${e.code} ${e.message}`; return { data: null, error: { code: e.code, message: e.message } } }
    },
  }
  const pa = X.pid(), pb = X.pid(), pOut = X.pid()
  const start = await X.day(-40), end = await X.day(-10)
  const K = { [pa]: 2, [pb]: 1 }
  const P = await X.makeProgram({ name: 'QA báo cáo sau chốt', isTest: true, products: [{ pid: pa, k: '2' }, { pid: pb, k: '1' }], dates: [start, end] })
  // Nhóm (người 0, pa) = S0 + S4 = 26 ⇒ Q 13; (người 1, pa) = 6 ⇒ Q 3; (người 2, pb) = 10 ⇒ Q 10; S3 chưa gán (GMV nhỏ, dưới ngưỡng chốt).
  const S = X.rows(P, [{ pid: pa, s: 0, base: 24 }, { pid: pa, s: 1, base: 6 }, { pid: pb, s: 2, base: 10 }, { pid: pb, s: 0, base: 5 }, { pid: pa, s: 0, base: 2 }])
  S[3].seller_email = 'nobody.qa@example.invalid'
  S[3].gmv_amount = '1000'
  const F = (q) => { let a = 0; for (const t of T3) { if (q < t.from) break; a += ((t.to === null ? q : Math.min(q, t.to)) - t.from + 1) * Number(t.amount) } return a }
  const sy = await X.syncQa(P, S)
  const runId = sy.runId
  const pv = await LA.runCmsLockPreview(LD, P.id)
  const lk = pv.ok ? await LA.runCmsLock(LD, { programId: P.id, expectedRunId: runId, expectedPolicyVersion: pv.preview.policyVersion,
    ackReason: 'QA giả chốt để thử báo cáo trả hàng sau chốt' }) : { ok: false }
  const pay0 = await X.one(`SELECT run_id::text r, amount_vnd::text a FROM public.cms_payouts WHERE program_id = $1`, [P.id])
  const FROZEN = F(13) + F(3) + F(10)
  ok(sy.status === 'published' && lk.ok && (await X.prog(P.id)).status === 'locked' && pay0?.r === runId && pay0.a === String(FROZEN),
    `nền: chương trình QA pos_base legacy đồng bộ nguồn qa + CHỐT qa_assumption (lockAction thật) ⇒ payout ${FROZEN}đ trên run legacy`,
    JSON.stringify([sy.status, sy.code, pv.ok ? pv.preview.blockers : pv, lk, pay0, LD.lastErr ?? null]))

  const rat = (min) => new Date(Date.parse(`${end}T05:00:00Z`) + min * 60000).toISOString()
  const rrow = (sale, o) => ({ return_event_id: o.id, return_document_id: `RD-${o.id}`, return_code: `RC-${o.id}`, return_status: o.status ?? 'COMPLETED',
    return_recorded_at: o.at ?? rat(o.min ?? 1), original_order_line_id: sale.order_line_id, original_order_id: sale.order_id, product_id: sale.product_id,
    return_base_quantity: String(o.base), return_gmv_amount: o.gmv ?? '10000', original_completed_at: sale.completed_at,
    original_order_type: sale.order_type, original_order_status: sale.order_status, original_seller_email: sale.seller_email,
    original_pos_code: sale.pos_code, original_base_quantity: sale.base_quantity, original_gmv_amount: sale.gmv_amount,
    original_quantity_raw: sale.quantity_raw, original_uom_raw: sale.uom_raw, source_updated_at: o.at ?? rat(o.min ?? 1) })
  const fake = (o) => ({ ...S[1], order_line_id: o.line, order_id: `F-${o.line}`, product_id: o.pid ?? pa, completed_at: o.at ?? S[1].completed_at,
    order_type: o.type ?? 'OFFLINE' })
  const RA = rrow(S[0], { id: 'RA', base: 4, min: 1 })
  const RU = rrow(S[3], { id: 'RU', base: 1, gmv: '100', min: 2 })
  const RN = { return_event_id: 'RN', return_status: 'APPROVED' }
  const RW = rrow(fake({ line: '948999001', at: `${await X.day(-45)}T03:00:00.000Z` }), { id: 'RW', base: 1, min: 3 })
  const RP = rrow(fake({ line: '948999002', pid: pOut }), { id: 'RP', base: 1, min: 4 })
  const RE = rrow(fake({ line: '948999003', type: 'ONLINE' }), { id: 'RE', base: 1, min: 5 })
  const RB = rrow(S[2], { id: 'RB', base: 3, gmv: '5000', min: 7 })
  const PROG = { startDate: start, endDate: end, productIds: [pa, pb] }
  const recs = (raws) => raws.map((r) => { const n = RT.normalizeReturnRow(r); if (!n.ok) throw new Error('phiếu giả lỗi ' + JSON.stringify(n.issues)); return n.value })
  let tick = BigInt(Date.now()) * BigInt(1000)
  const pl = (raws, o = {}) => CR.buildCmsCloseReportPayload(o.prog ?? PROG, recs(raws), { provider: 'fixture', snapshotId: 'qa-close',
    asOfMicros: o.asOf ?? (tick += BigInt(1000)), actor: o.actor })
  const save = async (payload, o = {}) => {
    const r = await settle(X.rpc(`SELECT public.rpc_cms_return_close_report_save($1, $2, $3::jsonb) r`, [o.program ?? P.id, o.run ?? runId, JSON.stringify(payload)]))
    return r.ok ? r.v : { err: code(r) }
  }
  const st = () => X.one(`SELECT (SELECT count(*)::int FROM public.cms_return_ledger_evals WHERE program_id = $1) ne,
    (SELECT count(*)::int FROM public.cms_return_close_reports WHERE program_id = $1) nr,
    (SELECT count(*)::int FROM public.cms_return_close_report_lines WHERE program_id = $1) nl,
    (SELECT count(*)::int FROM public.cms_return_close_report_events WHERE program_id = $1) nv,
    (SELECT count(*)::int FROM public.cms_return_baselines WHERE program_id = $1) nb,
    (SELECT count(*)::int FROM public.cms_return_conflicts c WHERE c.program_id = $1
       AND NOT EXISTS (SELECT 1 FROM public.cms_return_conflict_restorations r WHERE r.conflict_id = c.id)) nopen,
    (SELECT amount_vnd::text FROM public.cms_payouts WHERE program_id = $1) pay,
    (SELECT md5(string_agg(x::text, ';' ORDER BY x::text)) FROM public.cms_payout_staff x WHERE x.program_id = $1) staff,
    (SELECT status || '/' || current_result_run_id::text FROM public.cms_programs WHERE id = $1) prog,
    public.cms__open_set_hash($1) oh`, [P.id])
  const asU = async (uid, sql, params) => {
    const r = await settle(L.as(X.db, uid, () => X.db.query(sql, params), 'authenticated'))
    return r.ok ? r.v.rows[0].r : { err: code(r) }
  }
  const linesOf = (rid) => X.all(`SELECT product_id p, frozen_base::text fb, frozen_amount::text fa, return_base::text rb, return_events n,
    eligible_base::text eb, recomputed_qty::text q, recomputed_amount::text ra, delta::text d, gate_met g FROM public.cms_return_close_report_lines
    WHERE report_id = $1 ORDER BY line_no`, [rid])
  const expLine = (p, fb, rb, n) => {
    const q = Math.floor((fb - rb) / K[p])
    return { p, fb: String(fb), fa: String(F(Math.floor(fb / K[p]))), rb: String(rb), n, eb: String(fb - rb), q: String(q), ra: String(F(q)),
      d: String(F(q) - F(Math.floor(fb / K[p]))), g: true }
  }
  const sameSet = (a, b) => canon([...a].map(canon).sort()) === canon([...b].map(canon).sort())

  // 1. Báo cáo đầu (super bấm) ⇒ lưu; số tính lại độc lập; disposition DB suy; baseline receipt chung gắn báo cáo; payout / pointer KHÔNG đổi.
  const s0 = await st()
  const P1 = pl([RA, RU, RN, RW, RP, RE], { actor: U.super })
  const r1 = await save(P1)
  const s1 = await st()
  const REC1 = F(11) + F(3) + F(10)
  ok(r1.saved === true && r1.already === false && r1.frozen_amount === String(FROZEN) && r1.recomputed_amount === String(REC1)
    && r1.delta_amount === String(REC1 - FROZEN) && r1.return_events === 5 && r1.line_count === 3 && r1.baselines_new === 2
    && s1.ne === s0.ne + 1 && s1.nr === 1 && s1.nl === 3 && s1.nv === 5 && s1.nb === 2 && s1.pay === s0.pay && s1.staff === s0.staff && s1.prog === s0.prog,
    `báo cáo 1: chốt ${FROZEN}đ ⇒ tính lại ${REC1}đ (Δ ${REC1 - FROZEN}), 5 sự kiện / 3 dòng / 2 baseline; payout + payout_staff + pointer giữ nguyên`,
    JSON.stringify({ r1, s0, s1 }))
  const l1 = await linesOf(r1.report_id)
  ok(sameSet(l1, [expLine(pa, 26, 4, 1), expLine(pa, 6, 0, 0), expLine(pb, 10, 0, 0)]),
    'dòng báo cáo 1 = oracle JS độc lập (B đủ = B chốt − Σ APPLIED; Q = floor / K; F lũy tiến thang đóng băng; gate không mục tiêu)', JSON.stringify(l1))
  const ev1 = await X.all(`SELECT return_event_id id, disposition d, user_id IS NOT NULL g FROM public.cms_return_close_report_events
    WHERE report_id = $1 ORDER BY 1`, [r1.report_id])
  ok(canon(ev1) === canon([{ id: 'RA', d: 'APPLIED', g: true }, { id: 'RE', d: 'ORIGIN_NOT_ELIGIBLE', g: false }, { id: 'RP', d: 'ORIGIN_NOT_IN_PROGRAM', g: false },
    { id: 'RU', d: 'ORIGIN_UNASSIGNED', g: false }, { id: 'RW', d: 'ORIGIN_OUT_OF_WINDOW', g: false }]),
    'disposition DB tự suy từ dòng bán đóng băng: APPLIED / NOT_ELIGIBLE / NOT_IN_PROGRAM / UNASSIGNED / OUT_OF_WINDOW; phiếu chưa hiệu lực không vào', JSON.stringify(ev1))
  const h1 = await X.one(`SELECT eval_seq::int es, created_via v, created_by::text by, returns_digest dg FROM public.cms_return_close_reports WHERE id = $1`, [r1.report_id])
  const e1 = await X.one(`SELECT kind, verdict, report_attempt::text ra, run_id, eval_seq::int es, returns_digest dg FROM public.cms_return_ledger_evals
    WHERE program_id = $1 ORDER BY eval_seq DESC LIMIT 1`, [P.id])
  const b1 = await X.all(`SELECT return_event_id id, accepted_report_id::text rp, accepted_run_id ar, accepted_eval_seq::int es, financial_fp fp
    FROM public.cms_return_baselines WHERE program_id = $1 ORDER BY 1`, [P.id])
  const fpRA = FP.cmsReturnFinancialFp({ programId: P.id, returnEventId: 'RA', returnDocumentId: 'RD-RA', originalOrderLineId: S[0].order_line_id,
    originalOrderId: S[0].order_id, productId: pa, baseUnits: BigInt(4) * BigInt(1e9), refundUnits: BigInt(10000) * BigInt(1e9),
    recordedAtMicros: BigInt(Date.parse(RA.return_recorded_at)) * BigInt(1000) })
  ok(e1.kind === 'report' && e1.verdict === 'CLEAN' && e1.ra === r1.report_id && e1.run_id === null && e1.es === h1.es && e1.dg === P1.pin.returns.digest
    && h1.dg === P1.pin.returns.digest && h1.v === 'super' && h1.by === U.super
    && b1.length === 2 && b1.every((b) => b.rp === r1.report_id && b.ar === null && b.es === h1.es) && b1[0].id === 'RA' && b1[0].fp === fpRA,
    'eval kind report CLEAN gắn lượt (report_attempt = id báo cáo); digest DB = digest TS; baseline accepted_report_id + fp = TS', JSON.stringify({ e1, h1, b1 }))

  // 2. Lặp cùng snapshot ⇒ báo cáo cũ, 0 eval.
  const r1b = await save(P1)
  ok(r1b.saved === true && r1b.already === true && r1b.report_id === r1.report_id && canon(await st()) === canon(s1), 'lặp cùng snapshot (as_of + digest) ⇒ báo cáo cũ, 0 eval / 0 ghi', JSON.stringify(r1b))

  // 3. Mã đầu vào / ngữ cảnh ⇒ RAISE, 0 ghi (kể cả eval).
  const tamper = (p, fn) => { const c = JSON.parse(JSON.stringify(p)); fn(c); return c }
  const raL2 = (o) => rrow(S[1], { id: 'RX', base: 1, min: 9, ...o })
  const RAt = BigInt(Date.parse(RA.return_recorded_at)) * BigInt(1000)
  if (Date.now() - Date.parse(RA.return_recorded_at) < 37 * 3600 * 1000) throw new Error('fixture: RA phải cũ hơn 37 giờ cho ca STALE')
  const cases = [
    ['AFTER_AS_OF', pl([RA, RU, { ...raL2({ id: 'RF' }), return_recorded_at: new Date(Date.now() - 60_000).toISOString() }],
      { asOf: BigInt(Date.now() - 3_600_000) * BigInt(1000) }), {}, 'CMS_REPORT_AFTER_AS_OF'],
    ['AS_OF_STALE (cũ hơn 36 giờ)', pl([RA, RU], { asOf: RAt - BigInt(1) }), {}, 'CMS_REPORT_AS_OF_STALE'],
    ['ACTOR_FORBIDDEN (QLCH)', pl([RA, RU], { actor: U.qlch1 }), {}, 'CMS_REPORT_ACTOR_FORBIDDEN'],
    ['BEFORE_SALE', pl([raL2({ at: new Date(Date.parse(S[1].completed_at) - 60000).toISOString() })]), {}, 'CMS_REPORT_BEFORE_SALE'],
    ['CONTEXT_MISMATCH', pl([{ ...RA, original_gmv_amount: '99999' }]), {}, 'CMS_REPORT_CONTEXT_MISMATCH'],
    ['ORIGIN_MISSING', pl([rrow(fake({ line: '948999009' }), { id: 'RM', base: 1, min: 6 })]), {}, 'CMS_REPORT_ORIGIN_MISSING'],
    ['EXCEEDS_SALE_BASE (Σ 2 phiếu)', pl([raL2({ id: 'RX1', base: 4 }), raL2({ id: 'RX2', base: 4, min: 10 })]), {}, 'CMS_REPORT_EXCEEDS_SALE_BASE'],
    ['EXCEEDS_SALE_GMV (Σ 2 phiếu)', pl([raL2({ id: 'RX1', gmv: '60000' }), raL2({ id: 'RX2', gmv: '60000', min: 10 })]), {}, 'CMS_REPORT_EXCEEDS_SALE_GMV'],
    ['PIN_DIGEST', tamper(P1, (c) => { c.pin.returns.digest = '0'.repeat(64) }), {}, 'CMS_REPORT_PIN_DIGEST'],
    ['PIN_SCOPE tập SP', pl([RA], { prog: { ...PROG, productIds: [pa] } }), {}, 'CMS_REPORT_PIN_SCOPE'],
    ['PIN_SCOPE kỳ', pl([RA], { prog: { ...PROG, endDate: start } }), {}, 'CMS_REPORT_PIN_SCOPE'],
    ['BAD_PIN protocol', tamper(P1, (c) => { c.pin.protocol = 'x' }), {}, 'CMS_REPORT_BAD_PIN'],
    ['BAD_PIN rows lệch', tamper(P1, (c) => { c.pin.returns.rows = 5 }), {}, 'CMS_REPORT_BAD_PIN'],
    ['BAD_PIN job + snapshot', tamper(P1, (c) => { c.pin.job_id = 'j1' }), {}, 'CMS_REPORT_BAD_PIN'],
    ['BAD_PIN as_of tương lai', pl([RA], { asOf: (BigInt(Date.now()) + BigInt(3600000)) * BigInt(1000) }), {}, 'CMS_REPORT_BAD_PIN'],
    ['BAD_INPUT khoá lạ', tamper(P1, (c) => { c.extra = 1 }), {}, 'CMS_REPORT_BAD_INPUT'],
    ['BAD_INPUT actor', tamper(P1, (c) => { c.actor = 'x' }), {}, 'CMS_REPORT_BAD_INPUT'],
    ['BAD_ROW số', tamper(P1, (c) => { c.returns[0].return_base_quantity = 4 }), {}, 'CMS_REPORT_BAD_ROW'],
    ['BAD_ROW phần tử', tamper(P1, (c) => { c.returns.push(1); c.pin.returns.rows = c.returns.length }), {}, 'CMS_REPORT_BAD_ROW'],
    ['BAD_ROW khoá lạ', tamper(P1, (c) => { c.returns[0].x = null }), {}, 'CMS_REPORT_BAD_ROW'],
    ['BAD_ROW trùng ID', tamper(P1, (c) => { c.returns.push(c.returns[0]); c.pin.returns.rows = c.returns.length }), {}, 'CMS_REPORT_BAD_ROW'],
    ['BAD_ROW hình dạng (chưa hiệu lực có mã phiếu)', tamper(P1, (c) => { c.returns.find((x) => x.return_event_id === 'RN').return_code = 'X' }), {}, 'CMS_REPORT_BAD_ROW'],
    ['BAD_ROW hình dạng (hiệu lực thiếu dòng gốc)', tamper(P1, (c) => { c.returns[0].original_order_line_id = null }), {}, 'CMS_REPORT_BAD_ROW'],
    ['STATUS_UNKNOWN', tamper(P1, (c) => { c.returns.find((x) => x.return_event_id === 'RN').return_status = 'WEIRD' }), {}, 'CMS_RETURN_STATUS_UNKNOWN'],
    ['PAYOUT_MISMATCH', P1, { run: globalThis.crypto.randomUUID() }, 'CMS_REPORT_PAYOUT_MISMATCH'],
    ['NOT_LOCKED (chương trình đang chạy)', P1, { program: X.LIVE.id }, 'CMS_REPORT_NOT_LOCKED'],
    ['PROGRAM_NOT_FOUND', P1, { program: globalThis.crypto.randomUUID() }, 'CMS_PROGRAM_NOT_FOUND'],
  ]
  const badCodes = []
  for (const [label, payload, o, exp] of cases) { const r = await save(payload, o); if (r.err !== exp) badCodes.push(`${label}=${r.err ?? JSON.stringify(r).slice(0, 80)}`) }
  ok(badCodes.length === 0 && canon(await st()) === canon(s1), `${cases.length} mã đầu vào / pin / ngữ cảnh / quyền chương trình ⇒ RAISE đúng mã, 0 eval / 0 ghi`, badCodes.join(' · '))
  const det = await (async () => { try { await X.svc(`SELECT public.rpc_cms_return_close_report_save($1, $2, $3::jsonb) r`, [P.id, runId,
    JSON.stringify(pl([{ ...RA, original_gmv_amount: '99999' }, { ...RU, original_gmv_amount: '99999' }]))]); return null } catch (e) { return { m: String(e.message), d: e.detail ?? null } } })()
  ok(/CMS_REPORT_CONTEXT_MISMATCH/.test(det?.m ?? '') && det?.d === 'refs: RA,RU', 'mã H kèm DETAIL = ID phiếu (byte, ≤ 20, không PII) để job ghi vết', JSON.stringify(det))

  // 4. Nguồn đổi (RA đổi số) + mất (RU) ⇒ eval MISMATCH + 2 conflict, KHÔNG báo cáo; 5. snapshot cũ hơn ⇒ AS_OF_REGRESSION 0 ghi.
  const r2 = await save(pl([{ ...RA, return_base_quantity: '5' }, RN, RW, RP, RE]))
  const s2 = await st()
  const cf2 = await X.all(`SELECT return_event_id id, opened_kind k, opened_eval_seq::int es FROM public.cms_return_conflicts WHERE program_id = $1 ORDER BY 1`, [P.id])
  ok(r2.saved === false && r2.code === 'CMS_REPORT_LEDGER_CONFLICT' && r2.ledger?.verdict === 'MISMATCH' && s2.ne === s1.ne + 1 && s2.nr === 1 && s2.nb === 2
    && s2.nopen === 2 && canon(cf2.map((c) => [c.id, c.k])) === canon([['RA', 'CHANGED'], ['RU', 'MISSING']]) && cf2.every((c) => c.es === s2.ne),
    'báo cáo khi nguồn đổi / mất phiếu đã nhận ⇒ held CMS_REPORT_LEDGER_CONFLICT: eval report MISMATCH + conflict CHANGED / MISSING, 0 báo cáo', JSON.stringify({ r2, s2, cf2 }))
  const r2b = await save(pl([RA, RU, RN, RW, RP, RE], { asOf: tick - BigInt(3600) * BigInt(1000000) }))
  ok(r2b.saved === false && r2b.code === 'CMS_RETURN_AS_OF_REGRESSION' && canon(await st()) === canon(s2), 'snapshot as_of cũ hơn eval trước ⇒ CMS_RETURN_AS_OF_REGRESSION, 0 eval', JSON.stringify(r2b))

  // 6. Nguồn khớp lại ⇒ eval OPEN_CONFLICT_MATCH (proof), vẫn KHÔNG báo cáo; 7. super xác nhận trên proof báo cáo ⇒ đóng conflict.
  const r3 = await save(pl([RA, RU, RN, RW, RP, RE]))
  const s3 = await st()
  ok(r3.saved === false && r3.code === 'CMS_REPORT_CONFLICT_OPEN' && r3.ledger?.verdict === 'OPEN_CONFLICT_MATCH' && s3.ne === s2.ne + 1 && s3.nr === 1 && s3.nopen === 2,
    'nguồn khớp lại ⇒ held CMS_REPORT_CONFLICT_OPEN (eval proof OPEN_CONFLICT_MATCH), không tự mở', JSON.stringify({ r3, s3 }))
  const cfl = await asU(U.super, `SELECT public.rpc_cms_return_conflicts($1) r`, [P.id])
  const WHY = 'Nguồn trả hàng đã khôi phục đúng phiếu đã nhận — QA báo cáo sau chốt'
  const cfx = await asU(U.mkt, `SELECT public.rpc_cms_return_conflicts_confirm_restored($1, $2, $3, $4, $5) r`, [P.id, s3.oh, s3.ne, WHY, globalThis.crypto.randomUUID()])
  const cfo = await asU(U.super, `SELECT public.rpc_cms_return_conflicts_confirm_restored($1, $2, $3, $4, $5) r`, [P.id, s3.oh, s3.ne, WHY, globalThis.crypto.randomUUID()])
  const s3b = await st()
  ok(cfl.proof?.eval_seq === s3.ne && cfl.proof.open_set_hash === s3.oh && cfx.err === 'CMS_RETURN_CONFIRM_FORBIDDEN' && cfo.confirmed === true && cfo.conflicts === 2
    && s3b.nopen === 0 && s3b.ne === s3.ne, 'reader conflicts đưa proof = eval báo cáo; không phải super ⇒ FORBIDDEN; super xác nhận ⇒ 2 conflict đóng, 0 eval mới',
    JSON.stringify({ proof: cfl.proof ?? cfl, cfx, cfo, s3b }))

  // 8. Snapshot sau có phiếu mới RB ⇒ báo cáo 2 (cron, không actor): Δ cộng dồn RA + RB; baseline mới chỉ RB.
  const P4 = pl([RA, RU, RN, RW, RP, RE, RB])
  const r4 = await save(P4)
  const s4 = await st()
  const REC2 = F(11) + F(3) + F(7)
  const l4 = await linesOf(r4.report_id)
  const h4 = await X.one(`SELECT eval_seq::int es, created_via v, created_by by FROM public.cms_return_close_reports WHERE id = $1`, [r4.report_id])
  ok(r4.saved === true && r4.recomputed_amount === String(REC2) && r4.delta_amount === String(REC2 - FROZEN) && r4.return_events === 6 && r4.baselines_new === 1
    && s4.nr === 2 && s4.nb === 3 && s4.ne === s3b.ne + 1 && h4.es === s4.ne && h4.v === 'cron' && h4.by === null && s4.pay === s0.pay && s4.staff === s0.staff
    && sameSet(l4, [expLine(pa, 26, 4, 1), expLine(pa, 6, 0, 0), expLine(pb, 10, 3, 1)]),
    `báo cáo 2 (job, không actor) sau phục hồi: tính lại ${REC2}đ (Δ ${REC2 - FROZEN}), 6 sự kiện, baseline mới chỉ RB; dòng = oracle`, JSON.stringify({ r4, s4, l4 }))

  // 9. Reader (authenticated: super + chương trình đọc được).
  const lst = await asU(U.super, `SELECT public.rpc_cms_return_close_reports($1) r`, [P.id])
  const d1 = await asU(U.super, `SELECT public.rpc_cms_return_close_report($1, NULL, 2) r`, [r4.report_id])
  const d2 = d1.next_after != null ? await asU(U.super, `SELECT public.rpc_cms_return_close_report($1, $2, 2) r`, [r4.report_id, d1.next_after]) : {}
  ok(lst.reports?.length === 2 && lst.reports[0].id === r4.report_id && lst.reports[1].id === r1.report_id && lst.reports[0].delta_amount === String(REC2 - FROZEN)
    && d1.report?.not_a_payment_order === true && d1.report.source_pin?.returns?.digest === P4.pin.returns.digest && d1.lines?.length === 2 && d1.next_after === 1
    && d1.events === undefined && d2.lines?.length === 1 && d2.next_after === null,
    'reader: danh sách mới trước; chi tiết keyset dòng (2 + 1), cờ "không phải lệnh thu / chi", pin lưu nguyên', JSON.stringify({ lst, d1, d2 }).slice(0, 600))
  const e1p = await asU(U.super, `SELECT public.rpc_cms_return_close_report_events($1, NULL, 4) r`, [r4.report_id])
  const e2p = e1p.next_after != null ? await asU(U.super, `SELECT public.rpc_cms_return_close_report_events($1, $2, 4) r`, [r4.report_id, e1p.next_after]) : {}
  const eIds = [...(e1p.events ?? []), ...(e2p.events ?? [])].map((x) => x.return_event_id)
  const eBad = await asU(U.super, `SELECT public.rpc_cms_return_close_report_events($1, NULL, 0) r`, [r4.report_id])
  ok(e1p.return_events === 6 && e1p.events?.length === 4 && e2p.events?.length === 2 && e2p.next_after === null && new Set(eIds).size === 6
    && eIds.join(',') === [...eIds].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).join(',') && eBad.err === 'CMS_RESULT_BAD_INPUT',
    'reader sự kiện báo cáo: keyset theo byte ID (4 + 2), đủ 6, không cắt; limit 0 ⇒ BAD_INPUT', JSON.stringify({ e1p, e2p, eBad }).slice(0, 500))
  const forb = [
    await asU(U.mkt, `SELECT public.rpc_cms_return_close_reports($1) r`, [P.id]),
    await asU(U.qlch1, `SELECT public.rpc_cms_return_close_report($1, NULL, 10) r`, [r4.report_id]),
    await asU(U.sm, `SELECT public.rpc_cms_return_close_report($1, NULL, 10) r`, [r4.report_id]),
    await asU(U.qlch1, `SELECT public.rpc_cms_return_close_report_events($1, NULL, 10) r`, [r4.report_id]),
  ]
  const svcR = await settle(X.svc(`SELECT public.rpc_cms_return_close_reports($1) r`, [P.id]))
  const usrSave = await asU(U.super, `SELECT public.rpc_cms_return_close_report_save($1, $2, $3::jsonb) r`, [P.id, runId, JSON.stringify(P4)])
  ok(forb.every((x) => x.err === 'CMS_RESULT_FORBIDDEN') && !svcR.ok && /permission denied|FORBIDDEN/.test(svcR.err) && /permission denied/.test(usrSave.err ?? ''),
    'reader chỉ super (admin / QLCH / SM ⇒ FORBIDDEN; service_role không có quyền đọc); save chỉ service_role (super authenticated ⇒ permission denied)',
    JSON.stringify([forb, svcR.err?.slice(0, 80), usrSave]))

  // 10. Dòng bán đóng băng cho job (service_role, keyset seq) — chỉ chương trình đã chốt.
  const f1 = await X.rpc(`SELECT public.rpc_cms_frozen_sales_lines($1, NULL, 3) r`, [P.id])
  const f2 = f1.next_after_seq != null ? await X.rpc(`SELECT public.rpc_cms_frozen_sales_lines($1, $2, 3) r`, [P.id, f1.next_after_seq]) : { rows: [] }
  const fNo = await settle(X.rpc(`SELECT public.rpc_cms_frozen_sales_lines($1, NULL, 3) r`, [X.LIVE.id]))
  const fIds = [...f1.rows, ...f2.rows].map((r) => r.order_line_id).sort()
  ok(f1.rows.length === 3 && f1.next_after_seq === f1.rows[2].seq && f2.rows.length === 2 && f2.next_after_seq === null && f1.payout_run_id === runId
    && f1.payout_amount_vnd === String(FROZEN) && f1.contract?.legacy === true && canon(fIds) === canon(S.map((r) => r.order_line_id).sort())
    && !fNo.ok && code(fNo) === 'CMS_REPORT_NOT_LOCKED', 'rpc_cms_frozen_sales_lines: keyset 3 + 2 đủ dòng run chốt, contract legacy; chương trình chưa chốt ⇒ NOT_LOCKED',
    JSON.stringify({ f1: { n: f1.rows.length, next: f1.next_after_seq, c: f1.contract }, f2: f2.rows.length, fNo: fNo.ok ? 'OK' : code(fNo) }))

  // 10b. Gate sau trả (đột biến B07 13/11 sống sót ⇒ thêm): gate SP theo GMV gate RÒNG, gate danh mục theo GMV danh mục RÒNG của dược
  //      sĩ — hoàn làm rớt gate ⇒ tiền nhóm 0 dù Q còn > 0.
  {
    const g1 = X.pid(), g2 = X.pid(), g3 = X.pid()
    const PG = await X.makeProgram({ name: 'QA báo cáo gate', isTest: true, dates: [start, end], catalogTarget: '300000',
      products: [{ pid: g1, k: '1', basis: 'product', target: '250000' }, { pid: g2, k: '1', basis: 'catalog' }, { pid: g3, k: '1', basis: 'catalog' }] })
    const SG = X.rows(PG, [{ pid: g1, s: 0, base: 2, gmv: '150000' }, { pid: g1, s: 0, base: 2, gmv: '150000' }, { pid: g2, s: 0, base: 2, gmv: '200000' },
      { pid: g3, s: 0, base: 1, gmv: '150000' }])
    const syG = await X.syncQa(PG, SG)
    const pvG = await LA.runCmsLockPreview(LD, PG.id)
    const lkG = pvG.ok ? await LA.runCmsLock(LD, { programId: PG.id, expectedRunId: syG.runId, expectedPolicyVersion: pvG.preview.policyVersion }) : { ok: false }
    const FG = F(4) + F(2) + F(1)
    const rG = await save(CR.buildCmsCloseReportPayload({ startDate: start, endDate: end, productIds: [g1, g2, g3] },
      recs([rrow(SG[0], { id: 'GA', base: 1, gmv: '60000', min: 1 }), rrow(SG[3], { id: 'GC', base: 1, gmv: '100000', min: 2 })]),
      { provider: 'fixture', snapshotId: 'qa-gate', asOfMicros: BigInt(Date.now()) * BigInt(1000) }), { program: PG.id, run: syG.runId })
    const lG = rG.saved ? await X.all(`SELECT product_id p, frozen_amount::text fa, frozen_gate_met fg, net_gmv::text ng, gate_met g, recomputed_qty::text q,
      recomputed_amount::text ra FROM public.cms_return_close_report_lines WHERE report_id = $1`, [rG.report_id]) : []
    const byP = Object.fromEntries(lG.map((l) => [l.p, l]))
    ok(syG.status === 'published' && lkG.ok && rG.saved === true && rG.frozen_amount === String(FG) && rG.recomputed_amount === '0' && rG.delta_amount === String(-FG)
      && byP[g1]?.fg === true && byP[g1].g === false && byP[g1].q === '3' && byP[g1].ra === '0' && Number(byP[g1].ng) === 240000
      && byP[g2]?.fg === true && byP[g2].g === false && byP[g2].q === '2' && byP[g2].ra === '0' && byP[g3]?.g === false && byP[g3].q === '0',
      `gate sau trả: SP (gate 300k − hoàn 60k < mục tiêu 250k) + danh mục (350k − hoàn 100k < 300k) rớt ⇒ tiền 0 cả 3 nhóm (Δ −${FG}) dù Q còn 3 / 2`,
      JSON.stringify({ sy: syG.status, lk: lkG.ok ? 'ok' : (pvG.ok ? pvG.preview.blockers : pvG), rG, lG }).slice(0, 700))
  }

  // 10c. Dòng bán gốc phải thuộc ĐÚNG run đã chốt (đột biến F04 14/11 — tra dòng bán ở mọi run — sống sót ⇒ thêm): đồng bộ 2 lần, run 2
  //      bỏ một dòng; chốt run 2; phiếu trỏ dòng chỉ còn ở run 1 ⇒ CMS_REPORT_ORIGIN_MISSING, 0 ghi; phiếu trỏ dòng của run 2 ⇒ lưu.
  {
    const o1 = X.pid()
    const PO = await X.makeProgram({ name: 'QA báo cáo dòng run cũ', isTest: true, products: [{ pid: o1, k: '1' }], dates: [start, end] })
    const SO = X.rows(PO, [{ pid: o1, s: 0, base: 5 }, { pid: o1, s: 1, base: 3 }])
    const syO1 = await X.syncQa(PO, SO)
    const syO2 = await X.syncQa(PO, [SO[0]])
    const pvO = await LA.runCmsLockPreview(LD, PO.id)
    const lkO = pvO.ok ? await LA.runCmsLock(LD, { programId: PO.id, expectedRunId: syO2.runId, expectedPolicyVersion: pvO.preview.policyVersion }) : { ok: false }
    const inRuns = (await X.all(`SELECT run_id::text r FROM public.cms_sales_lines WHERE program_id = $1 AND order_line_id = $2`, [PO.id, SO[1].order_line_id]))
      .map((x) => x.r)
    const progO = { startDate: start, endDate: end, productIds: [o1] }
    const cnt = () => X.one(`SELECT (SELECT count(*)::int FROM public.cms_return_close_reports WHERE program_id = $1) nr,
      (SELECT count(*)::int FROM public.cms_return_baselines WHERE program_id = $1) nb,
      (SELECT count(*)::int FROM public.cms_return_ledger_evals WHERE program_id = $1) ne`, [PO.id])
    const c0 = await cnt()
    const rOld = await save(pl([rrow(SO[1], { id: 'RO1', base: 1, min: 1 })], { prog: progO }), { program: PO.id, run: syO2.runId })
    const c1 = await cnt()
    const rNew = await save(pl([rrow(SO[0], { id: 'RO0', base: 1, min: 2 })], { prog: progO }), { program: PO.id, run: syO2.runId })
    ok(syO1.status === 'published' && syO2.status === 'published' && syO1.runId !== syO2.runId && lkO.ok
      && inRuns.length === 1 && inRuns[0] === syO1.runId && rOld.err === 'CMS_REPORT_ORIGIN_MISSING' && canon(c1) === canon(c0) && rNew.saved === true,
      'phiếu trỏ dòng bán chỉ có ở run cũ (không phải run chốt) ⇒ CMS_REPORT_ORIGIN_MISSING, 0 ghi; dòng của run chốt ⇒ lưu',
      JSON.stringify({ sy: [syO1.status, syO2.status, syO1.runId === syO2.runId], lk: lkO.ok ? 'ok' : (pvO.ok ? pvO.preview.blockers : pvO), inRuns: inRuns.length,
        rOld, c0, c1, rNew: rNew.saved ?? rNew }).slice(0, 700))
  }

  // 11. Ghi thẳng bằng owner: bất biến; dòng / sự kiện chỉ một câu lệnh cùng lượt tạo (kể cả báo cáo mới nhất).
  const raw = async (sql, p = []) => {
    const r = await settle(X.db.query(sql, p))
    return r.ok ? 'OK' : (/\bCMS_[A-Z_]+\b/.exec(r.err)?.[0] ?? /violates check constraint|null value in column|violates foreign key|duplicate key/.exec(r.err)?.[0] ?? r.err.slice(0, 100))
  }
  const insJ = (table, row) => raw(`INSERT INTO public.${table} SELECT * FROM jsonb_populate_record(NULL::public.${table}, $1::jsonb)`, [JSON.stringify(row)])
  const tx = async (fn) => { await X.db.exec('BEGIN'); try { return await fn() } finally { await X.db.exec('ROLLBACK') } }
  const imm = [
    await raw(`UPDATE public.cms_return_close_reports SET line_count = 0 WHERE program_id = $1`, [P.id]),
    await raw(`DELETE FROM public.cms_return_close_reports WHERE program_id = $1`, [P.id]),
    await raw(`DELETE FROM public.cms_return_close_report_lines WHERE program_id = $1`, [P.id]),
    await raw(`UPDATE public.cms_return_close_report_lines SET delta = delta WHERE program_id = $1`, [P.id]),
    await raw(`TRUNCATE public.cms_return_close_report_events`),
    await raw(`UPDATE public.cms_return_close_report_events SET refund = refund WHERE program_id = $1`, [P.id]),
  ]
  ok(imm.every((x) => x === 'CMS_LEDGER_IMMUTABLE'), 'owner UPDATE / DELETE / TRUNCATE header / dòng / sự kiện báo cáo ⇒ CMS_LEDGER_IMMUTABLE', imm.join(' '))
  const hJ = (await X.one(`SELECT to_jsonb(r) j FROM public.cms_return_close_reports r WHERE id = $1`, [r1.report_id])).j
  const lJ = (await X.one(`SELECT to_jsonb(l) j FROM public.cms_return_close_report_lines l WHERE report_id = $1 ORDER BY line_no LIMIT 1`, [r1.report_id])).j
  const l4J = (await X.one(`SELECT to_jsonb(l) j FROM public.cms_return_close_report_lines l WHERE report_id = $1 ORDER BY line_no LIMIT 1`, [r4.report_id])).j
  const vJ = (await X.one(`SELECT to_jsonb(e) j FROM public.cms_return_close_report_events e WHERE report_id = $1 AND return_event_id = 'RA'`, [r1.report_id])).j
  const v4J = (await X.one(`SELECT to_jsonb(e) j FROM public.cms_return_close_report_events e WHERE report_id = $1 AND return_event_id = 'RA'`, [r4.report_id])).j
  // Header cô lập điều kiện verdict (đột biến A07 13/11): trong transaction tạo eval report MISMATCH THẬT và MỚI NHẤT (lượt held), rồi
  // chèn header khớp mọi điều kiện khác (kind report, report_attempt = id, eval mới nhất, as_of / digest của eval, FK, UNIQUE trống) ⇒
  // chỉ verdict ≠ CLEAN chặn.
  const hdrOnMismatch = () => tx(async () => {
    const h = await save(pl([{ ...RA, return_base_quantity: '6' }, RU, RN, RW, RP, RE, RB]))
    const e = await X.one(`SELECT eval_seq::int es, report_attempt::text ra, returns_as_of a, returns_digest dg, verdict v FROM public.cms_return_ledger_evals
      WHERE program_id = $1 ORDER BY eval_seq DESC LIMIT 1`, [P.id])
    if (h.code !== 'CMS_REPORT_LEDGER_CONFLICT' || e.v !== 'MISMATCH' || e.ra === null) return `setup ${JSON.stringify([h, e])}`
    return insJ('cms_return_close_reports', { ...hJ, id: e.ra, idem_key: 'b'.repeat(64), eval_seq: e.es, returns_as_of: e.a, returns_digest: e.dg })
  })
  const grd = [
    await tx(() => insJ('cms_return_close_report_lines', { ...lJ, line_no: 99, user_id: U.super })),
    await tx(() => insJ('cms_return_close_report_lines', { ...l4J, line_no: 99, user_id: U.super })),
    await tx(() => insJ('cms_return_close_report_events', { ...v4J, return_event_id: 'RZ', user_id: null, program_product_id: null, disposition: 'ORIGIN_NOT_ELIGIBLE' })),
    await hdrOnMismatch(),
  ]
  ok(grd.every((x) => x === 'CMS_LEDGER_INSERT_GUARD'),
    'owner thêm dòng vào báo cáo cũ / báo cáo MỚI NHẤT, thêm sự kiện, thêm header không gắn eval report CLEAN của chính lượt ⇒ INSERT_GUARD', grd.join(' '))
  // Header ghi ở transaction SAU eval report CLEAN (eval đã commit trước ⇒ evaluated_at ≠ now()) ⇒ INSERT_GUARD; cùng transaction thì qua.
  const hdrAfterEval = (old) => tx(async () => {
    await X.db.exec(`ALTER TABLE public.cms_return_ledger_evals DISABLE TRIGGER cms_ledger_eval_guard`)
    const e = (await X.one(`SELECT to_jsonb(e) j FROM public.cms_return_ledger_evals e WHERE program_id = $1 ORDER BY eval_seq DESC LIMIT 1`, [P.id])).j
    const at = (await X.one(`SELECT to_jsonb(now() - ($1::int * interval '1 hour')) j`, [old ? 1 : 0])).j
    const ra = globalThis.crypto.randomUUID()
    const ev = { ...e, eval_seq: Number(e.eval_seq) + 1, kind: 'report', run_id: null, report_attempt: ra, verdict: 'CLEAN', mismatched: 0, open_conflicts: 0,
      evaluated_at: at }
    const a = await insJ('cms_return_ledger_evals', ev)
    if (a !== 'OK') return `setup ${a}`
    return insJ('cms_return_close_reports', { ...hJ, id: ra, idem_key: 'c'.repeat(64), eval_seq: ev.eval_seq, returns_as_of: ev.returns_as_of,
      returns_digest: ev.returns_digest })
  })
  const hdrT = [await hdrAfterEval(false), await hdrAfterEval(true)]
  ok(hdrT[0] === 'OK' && hdrT[1] === 'CMS_LEDGER_INSERT_GUARD',
    'header báo cáo ghi ở transaction SAU eval report CLEAN (evaluated_at ≠ now()) ⇒ INSERT_GUARD; cùng transaction thì qua', hdrT.join(' '))
  // NULL probe trực tiếp (RET2-R2-03): mọi cột của 3 bảng báo cáo, NULL ⇒ NOT NULL / CHECK từ chối; thêm giá trị lạch.
  const nul = []
  let nP = 0
  const isRej = (x) => x === 'violates check constraint' || x === 'null value in column'
  const np = async (table, row, label) => { nP++; const x = await tx(() => insJ(table, row)); if (!isRej(x)) nul.push(`${label}=${x}`) }
  for (const c of Object.keys(hJ)) await np('cms_return_close_reports', { ...hJ, [c]: null }, `h.${c}`)
  for (const c of Object.keys(lJ)) await np('cms_return_close_report_lines', { ...lJ, [c]: null }, `l.${c}`)
  for (const c of Object.keys(vJ)) await np('cms_return_close_report_events', { ...vJ, [c]: null }, `e.${c}`)
  await np('cms_return_close_reports', { ...hJ, delta_amount: Number(hJ.delta_amount) + 1 }, 'h.delta lệch')
  await np('cms_return_close_reports', { ...hJ, created_via: 'cron' }, 'h.cron có người')
  await np('cms_return_close_reports', { ...hJ, calc_contract_version: 'cms-calc-ret2-v0' }, 'h.contract lạ')
  await np('cms_return_close_report_lines', { ...lJ, delta: Number(lJ.delta) + 1 }, 'l.delta lệch')
  await np('cms_return_close_report_lines', { ...lJ, eligible_base: Number(lJ.eligible_base) + 1 }, 'l.eligible lệch')
  await np('cms_return_close_report_lines', { ...lJ, return_events: 0 }, 'l.events 0 nhưng có trả')
  await np('cms_return_close_report_events', { ...vJ, user_id: null, program_product_id: null }, 'e.APPLIED không nhóm')
  await np('cms_return_close_report_events', { ...vJ, disposition: 'ORIGIN_NOT_ELIGIBLE' }, 'e.không APPLIED có nhóm')
  await np('cms_return_close_report_events', { ...vJ, disposition: 'NOT_COMPLETED' }, 'e.disposition lạ')
  await np('cms_return_close_report_events', { ...vJ, base: '1.5' }, 'e.base lẻ')
  ok(nul.length === 0 && nP >= 60, `NULL / giá trị lạ trực tiếp: ${nP} probe ở header / dòng / sự kiện báo cáo ⇒ NOT NULL / CHECK từ chối`, nul.join(' '))

  // 12. Rollback 130 dừng khi sổ có báo cáo (sổ bền không bao giờ bị xoá bởi rollback).
  const rb = await settle(X.db.exec(RB_130))
  try { await X.db.exec('ROLLBACK') } catch {}
  const s12 = await st()
  ok(!rb.ok && /sổ trả hàng đã có dữ liệu/.test(rb.err) && canon(s12) === canon(s4), 'rollback 130 khi đã có báo cáo sau chốt ⇒ DỪNG, sổ giữ nguyên', rb.ok ? 'OK' : rb.err.slice(0, 160))
}

// ── §9 race 2 kết nối (CHỈ PG15): khoá chương trình tuần tự hoá eval / báo cáo / confirm (RET2-R2-01 dưới tranh chấp thật) ─────────
/** §11 — chính lõi worker TS (lib/cms/salesSync.ts → contractSync.ts) chạy end-to-end trên DB thật với provider fixture (e2e/). */
async function workerSection() {
  const X = await env('worker')
  ok(X.applied.ok, 'DB worker: áp 130', X.applied.err)
  const SEL = [STORES[0].assigneeEmails[0], STORES[0].assigneeEmails[1], STORES[1].assigneeEmails[0], STORES[2].assigneeEmails[0], 'nobody.qa@example.invalid']
  const setNet = async (P) => X.svc(`SELECT public.rpc_cms_program_set_returns_policy($1, 'net_returns_v1', $2, $3)`, [P.id, (await X.prog(P.id)).v, U.super])
  let ln = 0
  const at = (P, min) => new Date(Date.parse(`${P.start}T02:00:00Z`) + min * 60000).toISOString()
  const srow = (P, o) => {
    const id = ++ln
    const ts = at(P, o.min ?? id)
    return { order_line_id: String(951000000 + id), order_id: `WO${id}`, order_code: `WQA-${id}`, product_id: o.pid, seller_email: SEL[o.s ?? 0],
      pos_code: 'QAOS01', order_type: 'OFFLINE', order_status: 'COMPLETED', completed_at: ts, quantity_raw: o.q ?? '1', uom_raw: o.u === undefined ? 'Hộp' : o.u,
      base_quantity: String(o.base), gmv_amount: o.gmv ?? '100000', source_updated_at: ts }
  }
  const rrow = (P, sale, o) => ({ return_event_id: o.id, return_document_id: `RD-${o.id}`, return_code: `RC-${o.id}`, return_status: o.status ?? 'COMPLETED',
    return_recorded_at: at(P, o.min), original_order_line_id: sale.order_line_id, original_order_id: sale.order_id, product_id: sale.product_id,
    return_base_quantity: String(o.base), return_gmv_amount: o.gmv ?? '10000', original_completed_at: sale.completed_at,
    original_order_type: sale.order_type, original_order_status: sale.order_status, original_seller_email: sale.seller_email,
    original_pos_code: sale.pos_code, original_base_quantity: sale.base_quantity, original_gmv_amount: sale.gmv_amount,
    original_quantity_raw: sale.quantity_raw, original_uom_raw: sale.uom_raw, source_updated_at: at(P, o.min) })
  const calls = { finish: 0, stage: 0 }
  const deps = (provider, legacyRows = []) => ({
    table: QR.CMS_QA_FAKE_TABLE, runner: FX.createCmsFixtureRunner({ sales: legacyRows }),
    loadSnapshot: (id) => X.rpc(`SELECT public.rpc_cms_sales_snapshot($1) r`, [id]),
    openRun: (id, detail) => X.rpc(`SELECT public.rpc_cms_sales_run_open($1, $2::jsonb) r`, [id, JSON.stringify(detail)]),
    stage: async (runId, part, chunkNo, x) => { calls.stage++; return Number(await X.rpc(`SELECT public.rpc_cms_sales_run_stage($1, $2, $3, $4::jsonb) r`, [runId, part, chunkNo, JSON.stringify(x)])) },
    sealBegin: (runId, expect) => X.rpc(`SELECT public.rpc_cms_sales_run_seal_begin($1, $2::jsonb) r`, [runId, JSON.stringify(expect)]),
    sealStep: (runId, step) => X.rpc(`SELECT public.rpc_cms_sales_run_seal_step($1, $2) r`, [runId, step]),
    publish: (runId) => X.rpc(`SELECT public.rpc_cms_sales_run_publish($1) r`, [runId]),
    finish: async (runId, status, detail) => { calls.finish++; await X.rpc(`SELECT public.rpc_cms_sales_run_finish($1, $2, $3::jsonb) r`, [runId, status, JSON.stringify(detail)]) },
    cleanup: (id, max) => X.rpc(`SELECT public.rpc_cms_sales_run_cleanup($1, $2) r`, [id, max]),
    now: () => Date.now(),
    contractProvider: provider,
  })
  const ON = { modes: true, returns: true }
  const run = (P, provider, o = {}) => SS.runCmsSalesSync(deps(provider, o.legacyRows), P.id, { dryRun: o.dryRun ?? false, source: o.source ?? 'qa',
    sourceCapture: true, chunkSize: 4, ...(o.flags === null ? {} : { calcFlags: o.flags ?? ON }) })
  const runRow = (id) => X.one(`SELECT status, error_code, calc_contract_version cc, quantity_basis b, returns_policy pol, ledger_verdict lv, ledger_eval_seq::int les, amount_vnd::text amt, seal_step, detail ->> 'calc_contract' dcc, detail ->> 'return_issue_kinds' rik, detail ->> 'hold_codes' hc, detail ->> 'hold_refs' hr, source_pin ->> 'provider' prov FROM public.cms_sync_runs WHERE id = $1`, [id])
  const nRuns = async (P) => Number((await X.one(`SELECT count(*)::int n FROM public.cms_sync_runs WHERE program_id = $1`, [P.id])).n)
  const ptr = async (P) => (await X.prog(P.id)).ptr

  // W1. cms_unit + net (QA): công bố qua worker; summary; lượt 2 sạch; phiếu đã nhận mất ⇒ held LEDGER_CONFLICT, pointer giữ.
  const WN = await X.makeProgram({ name: 'QA worker unit net', isTest: true, products: [{ pid: X.pid(), k: '10', unit: 'Hộp' }], v2: 'cms_unit' })
  await setNet(WN)
  const wp = WN.products[0].pid
  const ws = [srow(WN, { pid: wp, q: '3', base: 30, gmv: '300000' }), srow(WN, { pid: wp, q: '2', base: 20, gmv: '200000', s: 1 }), srow(WN, { pid: wp, q: '1', base: 10, s: 2 })]
  // WR2 APPROVED phải mang ProductID + ngày bán gốc trong phạm vi: job (và fixture) chỉ bỏ qua luật phạm vi cho phiếu THIẾU ngữ cảnh khi
  // trạng thái CHƯA biết là chưa hiệu lực (RET2-SRC-01) — APPROVED không xác định phạm vi không thuộc chương trình nào.
  const wr = [rrow(WN, ws[0], { id: 'WR1', base: 10, gmv: '100000', min: 200 }),
    { return_event_id: 'WR2', return_status: 'APPROVED', product_id: wp, original_completed_at: ws[1].completed_at }]
  const fxCalls = []
  const FXN = CF.createCmsContractFixtureProvider({ sales: ws, returns: wr, calls: fxCalls })
  const w1 = await run(WN, FXN)
  const w1r = w1.runId ? await runRow(w1.runId) : null
  ok(w1.status === 'published' && w1.code === null && w1r?.status === 'ok' && w1r.cc === 'cms-calc-ret2-v1' && w1r.lv === 'CLEAN' && w1r.seal_step === 13
    && w1r.dcc === 'cms-calc-ret2-v1' && w1r.prov === 'fixture' && w1r.amt === w1.amountVnd && (await ptr(WN)) === w1.runId
    && w1.contract?.provider === 'fixture' && w1.contract.returnsRead === 2 && w1.contract.returnsApplied === 1 && w1.contract.returnsNotEffective === 1
    && w1.sourceRows === ws.length && fxCalls.length === 1 && fxCalls[0].withReturns === true && w1.cleanup?.stoppedBy === 'done',
    'W1 worker TS chương trình cms_unit + net: provider một lần (có phần trả) → stage 6 part (khối 4) → seal 13 → publish CLEAN; pointer; số = DB; tóm tắt contract',
    JSON.stringify({ s: w1.status, c: w1.code, r: w1r, sum: w1.contract, src: w1.sourceRows, calls: fxCalls.length }))
  const w2 = await run(WN, FXN)
  const w2r = w2.runId ? await runRow(w2.runId) : null
  ok(w2.status === 'published' && w2r?.lv === 'CLEAN' && w2r.les === (w1r?.les ?? 0) + 1 && (await ptr(WN)) === w2.runId,
    'W1b lượt 2 cùng nguồn (as_of mới hơn) ⇒ công bố, eval tăng 1', JSON.stringify({ s: w2.status, c: w2.code, w2r }))
  const FXL = CF.createCmsContractFixtureProvider({ sales: ws, returns: [wr[1]] })
  const w3 = await run(WN, FXL)
  const w3r = w3.runId ? await runRow(w3.runId) : null
  ok(w3.status === 'held' && w3.code === 'CMS_RETURN_LEDGER_CONFLICT' && w3r?.status === 'held' && w3r.lv === 'MISMATCH' && (await ptr(WN)) === w2.runId,
    'W1c phiếu đã nhận biến mất ⇒ worker held CMS_RETURN_LEDGER_CONFLICT (DB tự đóng run), pointer giữ lượt 2', JSON.stringify({ s: w3.status, c: w3.code, w3r }))

  // W2. Cờ OFF ⇒ open không khai hợp đồng ⇒ DB đóng held CMS_WORKER_UNSUPPORTED ngay; worker không đóng lần hai, không đọc nguồn.
  const fBefore = calls.finish
  const fxOff = []
  const w4 = await run(WN, CF.createCmsContractFixtureProvider({ sales: ws, returns: wr, calls: fxOff }), { flags: null })
  const w4r = w4.runId ? await runRow(w4.runId) : null
  ok(w4.status === 'held' && w4.code === 'CMS_WORKER_UNSUPPORTED' && w4r?.status === 'held' && w4r.error_code === 'CMS_WORKER_UNSUPPORTED'
    && calls.finish === fBefore && fxOff.length === 0 && (await ptr(WN)) === w2.runId,
    'W2 cờ OFF trên chương trình contract ⇒ held CMS_WORKER_UNSUPPORTED có vết (run held), 0 finish thêm, 0 đọc nguồn, pointer giữ (không quay về legacy)',
    JSON.stringify({ s: w4.status, c: w4.code, w4r, fin: calls.finish - fBefore, src: fxOff.length }))

  // W3. modes ON, returns OFF trên chương trình net ⇒ held RETURNS_DISABLED. W4. modes OFF trên cms_unit sales-only ⇒ CALC_MODES_DISABLED.
  const w5 = await run(WN, FXN, { flags: { modes: true, returns: false } })
  const w5r = w5.runId ? await runRow(w5.runId) : null
  const WU = await X.makeProgram({ name: 'QA worker unit sales', isTest: true, products: [{ pid: X.pid(), k: '1', unit: 'Viên' }], v2: 'cms_unit' })
  const us1 = [srow(WU, { pid: WU.products[0].pid, q: '4', u: 'Viên', base: 4 })]
  const fxU = []
  const w6 = await run(WU, CF.createCmsContractFixtureProvider({ sales: us1, calls: fxU }), { flags: { modes: false, returns: true } })
  const w6r = w6.runId ? await runRow(w6.runId) : null
  ok(w5.status === 'held' && w5.code === 'RETURNS_DISABLED' && w5r?.status === 'held' && w5r.error_code === 'RETURNS_DISABLED'
    && w6.status === 'held' && w6.code === 'CALC_MODES_DISABLED' && w6r?.error_code === 'CALC_MODES_DISABLED' && fxU.length === 0,
    'W3 / W4 thiếu cờ đúng loại (net cần CMS_RETURNS_ENABLED, cms_unit cần CMS_CALC_MODES_ENABLED) ⇒ held có vết, không đọc nguồn',
    JSON.stringify({ w5: [w5.status, w5.code, w5r?.error_code], w6: [w6.status, w6.code, w6r?.error_code] }))
  // W12. cms_unit sales-only, modes ON ⇒ công bố; provider không đọc phần trả; run sales_only_v1.
  const w7 = await run(WU, CF.createCmsContractFixtureProvider({ sales: us1, calls: fxU }), { flags: { modes: true, returns: false } })
  const w7r = w7.runId ? await runRow(w7.runId) : null
  ok(w7.status === 'published' && w7r?.pol === 'sales_only_v1' && w7r.b === 'cms_unit' && fxU.length === 1 && fxU[0].withReturns === false
    && w7.contract?.returnsRead === null,
    'W5 cms_unit sales-only (chỉ cờ modes) ⇒ công bố; provider gọi KHÔNG kèm phần trả (returnsRead null, không phải 0)',
    JSON.stringify({ s: w7.status, c: w7.code, w7r, sum: w7.contract }))

  // W6. Provider lỗi / hỏng ⇒ không bao giờ stage net với 0 phiếu giả.
  const WP = await X.makeProgram({ name: 'QA worker nguồn lỗi', isTest: true, products: [{ pid: X.pid(), k: '10', unit: 'Hộp' }], v2: 'cms_unit' })
  await setNet(WP)
  const ps = [srow(WP, { pid: WP.products[0].pid, q: '2', base: 20 })]
  const stageBefore = calls.stage
  const p1 = await run(WP, CF.createCmsContractFixtureProvider({ fail: { ok: false, code: 'NOT_CONFIGURED', part: 'returns' } }))
  const p1r = p1.runId ? await runRow(p1.runId) : null
  const p2 = await run(WP, CF.createCmsContractFixtureProvider({ sales: ps, returns: [], tamper: (r) => ({ ...r, returnsRaw: null }) }))
  const p3 = await run(WP, CF.createCmsContractFixtureProvider({ sales: ps, returns: [], tamper: (r) => ({ ...r, asOfMicros: r.asOfMicros - BigInt(1) }) }))
  const p4 = await run(WP, CF.createCmsContractFixtureProvider({ fail: { ok: false, code: 'TIMEOUT', part: 'job' } }))
  ok(p1.status === 'held' && p1.code === 'SOURCE_NOT_CONFIGURED' && p1r?.status === 'held' && p2.status === 'error' && p2.code === 'SOURCE_PIN_MISMATCH'
    && p3.code === 'SOURCE_PIN_MISMATCH' && p4.status === 'error' && p4.code === 'SOURCE_TIMEOUT' && calls.stage === stageBefore && (await ptr(WP)) === null,
    'W6 nguồn trả chưa cấu hình ⇒ held SOURCE_NOT_CONFIGURED; provider trả net mà returns null / as_of khác ⇒ SOURCE_PIN_MISMATCH; timeout ⇒ error; 0 stage, không pointer',
    JSON.stringify({ p1: [p1.status, p1.code, p1r?.status], p2: [p2.status, p2.code], p3: p3.code, p4: [p4.status, p4.code], st: calls.stage - stageBefore }))
  // W7. Phiếu trả lỗi chuẩn hoá ⇒ held RETURN_ROW_ISSUES (chỉ tên trường); W8. engine HOLD ⇒ CALC_<mã> + ref kỹ thuật.
  const q1 = await run(WP, CF.createCmsContractFixtureProvider({ sales: ps, returns: [{ ...rrow(WP, ps[0], { id: 'BAD1', base: 1, min: 90 }), return_status: 'Completed' }] }))
  const q1r = q1.runId ? await runRow(q1.runId) : null
  const hs = [...ps, srow(WP, { pid: WP.products[0].pid, q: '1', u: null, base: 10 })]
  const q2 = await run(WP, CF.createCmsContractFixtureProvider({ sales: hs, returns: [] }))
  const q2r = q2.runId ? await runRow(q2.runId) : null
  ok(q1.status === 'held' && q1.code === 'RETURN_ROW_ISSUES' && q1r?.rik === 'UNKNOWN_STATUS:return_status' && !JSON.stringify(q1r).includes('Completed')
    && q2.status === 'held' && q2.code === 'CALC_UNIT_MISSING' && q2r?.hc === 'UNIT_MISSING' && q2r.hr === `SALE:${hs[1].order_line_id}`
    && calls.stage === stageBefore,
    'W7 phiếu trả trạng thái lạ ⇒ held RETURN_ROW_ISSUES (detail chỉ loại:trường, không giá trị); W8 dòng bán thiếu đơn vị ở cms_unit ⇒ held CALC_* + ref dòng; 0 stage',
    JSON.stringify({ q1: [q1.status, q1.code, q1r?.rik], q2: [q2.status, q2.code, q2r?.hc, q2r?.hr] }))

  // W9. Fixture trên chương trình THẬT (nguồn cron) ⇒ held FIXTURE_REAL_PROGRAM, không đọc nguồn.
  const WR = await X.makeProgram({ name: 'QA worker thật', isTest: false, products: [{ pid: X.pid(), k: '10', unit: 'Hộp' }], v2: 'cms_unit' })
  const fxR = []
  const r1 = await run(WR, CF.createCmsContractFixtureProvider({ sales: [srow(WR, { pid: WR.products[0].pid, q: '1', base: 10 })], calls: fxR }), { source: 'cron' })
  const r1r = r1.runId ? await runRow(r1.runId) : null
  ok(r1.status === 'held' && r1.code === 'FIXTURE_REAL_PROGRAM' && r1r?.status === 'held' && fxR.length === 0 && (await ptr(WR)) === null,
    'W9 provider fixture trên chương trình thật ⇒ held FIXTURE_REAL_PROGRAM, 0 đọc nguồn, không pointer', JSON.stringify({ s: r1.status, c: r1.code, r1r }))

  // W10. Chương trình legacy (pos_base + sales_only) với cờ ON ⇒ đường legacy nguyên hành vi (run không hợp đồng), provider contract không gọi.
  const WL = await X.makeProgram({ name: 'QA worker legacy', isTest: true, products: [{ pid: X.pid(), k: '2' }] })
  const fxL = []
  const lrows = X.rows(WL, [{ pid: WL.products[0].pid, s: 0, base: 8 }])
  const l1 = await run(WL, CF.createCmsContractFixtureProvider({ sales: [], calls: fxL }), { legacyRows: lrows })
  const l1r = l1.runId ? await runRow(l1.runId) : null
  ok(l1.status === 'published' && l1r?.cc === null && l1r.status === 'ok' && fxL.length === 0 && (l1.contract ?? null) === null,
    'W10 chương trình legacy + cờ ON ⇒ run legacy (calc_contract_version NULL) công bố như cũ; provider contract không được gọi',
    JSON.stringify({ s: l1.status, c: l1.code, l1r, src: fxL.length }))

  // W11. Dry-run chương trình contract ⇒ dry_run, resultHash, KHÔNG tạo run; hai lần cùng nguồn + cùng as_of ⇒ cùng hash.
  const nr = await nRuns(WN)
  const dAsOf = BigInt(Date.now()) * BigInt(1000)
  const dDeps = { ...deps(FXN), asOfMicros: () => dAsOf }
  const d1 = await SS.runCmsSalesSync(dDeps, WN.id, { dryRun: true, source: 'operator', calcFlags: ON })
  const d2 = await SS.runCmsSalesSync(dDeps, WN.id, { dryRun: true, source: 'operator', calcFlags: ON })
  ok(d1.status === 'dry_run' && d1.code === null && /^[0-9a-f]{64}$/.test(d1.resultHash ?? '') && d1.resultHash === d2.resultHash && d1.runId === null
    && (await nRuns(WN)) === nr && d1.contract?.returnsApplied === 1,
    'W11 dry-run chương trình contract ⇒ dry_run + resultHash ổn định, 0 run mới', JSON.stringify({ s: d1.status, c: d1.code, h: [d1.resultHash, d2.resultHash] }))
}

async function raceSection() {
  const X = await env('race')
  ok(X.applied.ok, 'DB race: áp 130', X.applied.err)
  const LD = {
    lockEnabled: () => true, qaReadonly: () => false, access: async () => ({ kind: 'ok', actorId: U.super, qa: true }),
    program: async (id) => { const r = await X.one(`SELECT is_test FROM public.cms_programs WHERE id = $1`, [id]); return r ? { isTest: r.is_test } : null },
    rpc: async (fn, args) => {
      const named = Object.keys(args).map((k, i) => `${k} => $${i + 1}`).join(', ')
      try { return { data: (await X.svc(`SELECT public.${fn}(${named}) r`, Object.values(args))).rows[0].r, error: null } } catch (e) { return { data: null, error: { code: e.code, message: e.message } } }
    },
  }
  const pa = X.pid()
  const start = await X.day(-40), end = await X.day(-10)
  const P = await X.makeProgram({ name: 'QA race báo cáo', isTest: true, products: [{ pid: pa, k: '1' }], dates: [start, end] })
  const S = X.rows(P, [{ pid: pa, s: 0, base: 20 }, { pid: pa, s: 1, base: 5 }])
  const sy = await X.syncQa(P, S)
  const pv = await LA.runCmsLockPreview(LD, P.id)
  const lk = pv.ok ? await LA.runCmsLock(LD, { programId: P.id, expectedRunId: sy.runId, expectedPolicyVersion: pv.preview.policyVersion }) : { ok: false }
  ok(sy.status === 'published' && lk.ok, 'nền race: chương trình QA đã chốt', JSON.stringify([sy.status, pv.ok ? pv.preview.blockers : pv, lk]))
  const rr = (sale, id, base, min) => ({ return_event_id: id, return_document_id: `RD-${id}`, return_code: null, return_status: 'COMPLETED',
    return_recorded_at: new Date(Date.parse(`${end}T05:00:00Z`) + min * 60000).toISOString(), original_order_line_id: sale.order_line_id,
    original_order_id: sale.order_id, product_id: sale.product_id, return_base_quantity: String(base), return_gmv_amount: '1000',
    original_completed_at: sale.completed_at, original_order_type: 'OFFLINE', original_order_status: 'COMPLETED', original_seller_email: sale.seller_email,
    original_pos_code: sale.pos_code, original_base_quantity: sale.base_quantity, original_gmv_amount: sale.gmv_amount,
    original_quantity_raw: sale.quantity_raw, original_uom_raw: sale.uom_raw, source_updated_at: null })
  const RA = rr(S[0], 'QA', 2, 1), RB = rr(S[1], 'QB', 1, 2)
  const PROG = { startDate: start, endDate: end, productIds: [pa] }
  const recs = (raws) => raws.map((r) => { const n = RT.normalizeReturnRow(r); if (!n.ok) throw new Error('phiếu giả lỗi ' + JSON.stringify(n.issues)); return n.value })
  let tick = BigInt(Date.now()) * BigInt(1000) - BigInt(60_000_000)
  const pl = (raws, asOf) => CR.buildCmsCloseReportPayload(PROG, recs(raws), { provider: 'fixture', snapshotId: 'qa-race', asOfMicros: asOf ?? (tick += BigInt(1000)) })
  const SAVE = `SELECT public.rpc_cms_return_close_report_save($1, $2, $3::jsonb) r`
  const CONFIRM = `SELECT public.rpc_cms_return_conflicts_confirm_restored($1, $2, $3, $4, $5) r`
  const WHY = 'Nguồn trả hàng đã khôi phục đúng phiếu đã nhận — QA race'
  // Kết nối B (cùng DB) + kết nối quan sát.
  const cB = await pgConn(X.dbName)
  const B = { exec: (sql) => cB.query(sql), query: (sql, p) => cB.query(sql, p) }
  const obs = await pgConn(X.dbName)
  const waiting = async () => Number((await obs.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'`, [X.dbName])).rows[0].n)
  const st = async () => (await obs.query(`SELECT (SELECT count(*)::int FROM public.cms_return_ledger_evals WHERE program_id = $1) ne,
    (SELECT count(*)::int FROM public.cms_return_close_reports WHERE program_id = $1) nr,
    (SELECT string_agg(eval_seq::text, ',' ORDER BY eval_seq) FROM public.cms_return_ledger_evals WHERE program_id = $1) seqs,
    public.cms__open_set_hash($1) oh`, [P.id])).rows[0]
  /** A giữ transaction (vai service_role) qua `fnA`; B chạy `fnB` song song (phải CHỜ khoá), A COMMIT, trả kết quả B. */
  async function race(fnA, fnB) {
    await X.db.exec('BEGIN')
    await X.db.exec('SET LOCAL ROLE service_role')
    const a = await settle(fnA())
    const pB = settle(fnB())
    let w = 0
    for (let i = 0; i < 50 && w === 0; i++) { await sleep(40); w = await waiting() }
    await X.db.exec(a.ok ? 'COMMIT' : 'ROLLBACK')
    const b = await pB
    return { a: a.ok ? a.v.rows[0].r : { err: code(a) }, b: b.ok ? b.v.rows[0].r : { err: code(b) }, waited: w > 0 }
  }
  const asB = (uid, role, sql, p) => L.as(B, uid, () => B.query(sql, p), role)

  // R1. Cùng snapshot từ hai kết nối ⇒ đúng MỘT báo cáo + MỘT eval; B (chờ khoá) nhận báo cáo của A (already).
  const p1 = pl([RA])
  const r1 = await race(() => X.db.query(SAVE, [P.id, sy.runId, JSON.stringify(p1)]), () => asB(null, 'service_role', SAVE, [P.id, sy.runId, JSON.stringify(p1)]))
  const s1 = await st()
  ok(r1.waited && r1.a.saved === true && r1.a.already === false && r1.b.saved === true && r1.b.already === true && r1.b.report_id === r1.a.report_id
    && s1.ne === 1 && s1.nr === 1, 'R1 cùng snapshot hai kết nối: B chờ khoá chương trình rồi nhận báo cáo của A (already) — 1 báo cáo / 1 eval',
    JSON.stringify({ r1, s1 }))

  // R2. A as_of MỚI giữ khoá, B as_of CŨ hơn chờ ⇒ sau COMMIT của A, B = AS_OF_REGRESSION, 0 eval (sàn đọc DƯỚI khoá, không trước khoá).
  const tNew = tick + BigInt(10_000), tOld = tick + BigInt(5_000)
  tick = tNew
  const r2 = await race(() => X.db.query(SAVE, [P.id, sy.runId, JSON.stringify(pl([RA, RB], tNew))]),
    () => asB(null, 'service_role', SAVE, [P.id, sy.runId, JSON.stringify(pl([RA, RB], tOld))]))
  const s2 = await st()
  ok(r2.waited && r2.a.saved === true && r2.b.saved === false && r2.b.code === 'CMS_RETURN_AS_OF_REGRESSION' && s2.ne === 2 && s2.nr === 2 && s2.seqs === '1,2',
    'R2 as_of đảo thứ tự commit: B (as_of cũ, chờ khoá) ⇒ CMS_RETURN_AS_OF_REGRESSION, 0 eval; eval_seq liên tục 1,2', JSON.stringify({ r2, s2 }))

  // R3. Có conflict mở + proof k; A ghi eval k+1 (khớp lại) giữ khoá; B confirm proof k chờ ⇒ PROOF_NOT_LATEST; confirm proof k+1 ⇒ đóng.
  await X.svc(SAVE, [P.id, sy.runId, JSON.stringify(pl([{ ...RA, return_base_quantity: '3' }, RB]))])
  const rk = (await X.svc(SAVE, [P.id, sy.runId, JSON.stringify(pl([RA, RB]))])).rows[0].r
  const sk = await st()
  const r3 = await race(() => X.db.query(SAVE, [P.id, sy.runId, JSON.stringify(pl([RA, RB]))]),
    () => asB(U.super, 'authenticated', CONFIRM, [P.id, sk.oh, sk.ne, WHY, globalThis.crypto.randomUUID()]))
  const s3 = await st()
  const ok3 = await L.as(B, U.super, () => B.query(CONFIRM, [P.id, s3.oh, s3.ne, WHY, globalThis.crypto.randomUUID()]), 'authenticated').then((x) => x.rows[0].r, (e) => ({ err: code({ err: String(e.message) }) }))
  ok(rk.code === 'CMS_REPORT_CONFLICT_OPEN' && r3.waited && r3.a.code === 'CMS_REPORT_CONFLICT_OPEN' && r3.b.err === 'CMS_RETURN_PROOF_NOT_LATEST'
    && s3.ne === sk.ne + 1 && ok3.confirmed === true && ok3.proof_eval_seq === s3.ne,
    'R3 confirm proof k chờ khoá trong lúc lượt khác ghi eval k+1 ⇒ PROOF_NOT_LATEST (không xác nhận trên proof cũ); proof k+1 ⇒ đóng conflict',
    JSON.stringify({ rk: rk.code, r3, sk: sk.ne, s3: s3.ne, ok3 }))

  // R4. Báo cáo giữ khoá × gọi chốt lại cùng run từ B: B CHỜ khoá chương trình rồi nhận already (không ghi payout mới), báo cáo A lưu.
  const r4 = await race(() => X.db.query(SAVE, [P.id, sy.runId, JSON.stringify(pl([RA, RB, rr(S[1], 'QC', 1, 3)]))]),
    () => asB(null, 'service_role', `SELECT public.rpc_cms_program_lock($1, $2, $3, $4, $5) r`, [P.id, sy.runId, pv.preview.policyVersion, U.super, null]))
  ok(r4.waited && r4.a.saved === true && r4.b.locked === true && r4.b.already === true,
    'R4 báo cáo giữ khoá × chốt lại cùng run song song ⇒ chốt chờ khoá rồi already, báo cáo lưu', JSON.stringify(r4))

  // Huỷ giữa chừng (statement_timeout như Supabase): trigger QA ngủ ở lệnh ghi CUỐI (baseline). Trong lúc ngủ, pg_locks của kết nối A
  // phải cho thấy các lệnh INSERT trước đã chạy (RowExclusiveLock) ⇒ timeout cắt SAU khi đã ghi một phần; sau huỷ: 0 delta mọi bảng,
  // gọi lại cùng đầu vào ⇒ thành công, eval_seq liền (không thủng số).
  const aPid = Number((await X.db.query('SELECT pg_backend_pid() p')).rows[0].p)
  await X.db.exec(`CREATE FUNCTION public.qa_sleep_t() RETURNS trigger LANGUAGE plpgsql AS $q$ BEGIN PERFORM pg_sleep(3); RETURN NULL; END $q$`)
  const SLEEP_ON = `CREATE TRIGGER qa_sleep_baselines AFTER INSERT ON public.cms_return_baselines FOR EACH STATEMENT EXECUTE FUNCTION public.qa_sleep_t()`
  const SLEEP_OFF = 'DROP TRIGGER qa_sleep_baselines ON public.cms_return_baselines'
  /** A (service_role, statement_timeout 800 ms) chạy sql; trong lúc A ngủ ở trigger, đọc khoá ghi A đang giữ. */
  async function cancelled(sql, p) {
    await X.db.exec(SLEEP_ON)
    await X.db.exec('BEGIN')
    await X.db.exec('SET LOCAL ROLE service_role')
    await X.db.exec(`SET LOCAL statement_timeout = '800ms'`)
    const pA = settle(X.db.query(sql, p))
    let held = []
    for (let i = 0; i < 15 && !held.includes('cms_return_baselines'); i++) {
      await sleep(40)
      held = (await obs.query(`SELECT coalesce(array_agg(DISTINCT c.relname::text), '{}') r FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
        WHERE l.pid = $1 AND l.granted AND l.mode = 'RowExclusiveLock' AND c.relname LIKE 'cms\\_%'`, [aPid])).rows[0].r
    }
    const a = await pA
    await X.db.exec('ROLLBACK')
    await X.db.exec(SLEEP_OFF)
    return { a: a.ok ? a.v.rows[0].r : { err: a.err.slice(0, 80) }, held: [...held].sort() }
  }
  const cnt = async (pid) => (await obs.query(`SELECT (SELECT count(*)::int FROM public.cms_return_baselines WHERE program_id = $1) nb,
    (SELECT count(*)::int FROM public.cms_return_ledger_evals WHERE program_id = $1) ne,
    (SELECT string_agg(eval_seq::text, ',' ORDER BY eval_seq) FROM public.cms_return_ledger_evals WHERE program_id = $1) seqs,
    (SELECT count(*)::int FROM public.cms_return_close_reports WHERE program_id = $1) nr,
    (SELECT count(*)::int FROM public.cms_return_close_report_lines l JOIN public.cms_return_close_reports r ON r.id = l.report_id WHERE r.program_id = $1) nl,
    (SELECT count(*)::int FROM public.cms_return_close_report_events v JOIN public.cms_return_close_reports r ON r.id = v.report_id WHERE r.program_id = $1) nv,
    (SELECT current_result_run_id::text FROM public.cms_programs WHERE id = $1) ptr`, [pid])).rows[0]
  const isTimeout = (x) => /statement timeout/.test(x?.err ?? '')

  // R5. Báo cáo sau chốt có phiếu MỚI (QD) bị huỷ khi đang ghi baseline ⇒ eval / header / dòng / sự kiện / baseline đều không còn.
  const p5 = pl([RA, RB, rr(S[1], 'QC', 1, 3), rr(S[0], 'QD', 1, 4)])
  const b5 = await cnt(P.id)
  const c5 = await cancelled(SAVE, [P.id, sy.runId, JSON.stringify(p5)])
  const m5 = await cnt(P.id)
  const ok5 = (await X.svc(SAVE, [P.id, sy.runId, JSON.stringify(p5)])).rows[0].r
  const a5 = await cnt(P.id)
  const wrote5 = ['cms_return_close_report_events', 'cms_return_close_report_lines', 'cms_return_close_reports', 'cms_return_ledger_evals'].every((x) => c5.held.includes(x))
  ok(isTimeout(c5.a) && wrote5 && canon(m5) === canon(b5) && ok5.saved === true && ok5.already === false && a5.ne === b5.ne + 1 && a5.nr === b5.nr + 1
    && a5.nb === b5.nb + 1 && a5.seqs === Array.from({ length: a5.ne }, (_, i) => String(i + 1)).join(','),
    'R5 báo cáo bị statement_timeout cắt SAU khi đã ghi eval / header / dòng / sự kiện ⇒ 0 delta; gọi lại ⇒ lưu, eval_seq liền',
    JSON.stringify({ a: c5.a, held: c5.held, b5, m5, ok5: { saved: ok5.saved, already: ok5.already, code: ok5.code }, a5 }))

  // R6. Publish run contract net (chương trình thử mới) bị huỷ khi đang ghi baseline ⇒ eval / baseline / pointer / trạng thái run giữ nguyên.
  const KIT = contractKit(X)
  const pn = X.pid()
  const PN = await X.makeProgram({ name: 'QA race publish huỷ', isTest: true, products: [{ pid: pn, k: '10', unit: 'Hộp' }], v2: 'cms_unit' })
  await X.svc(`SELECT public.rpc_cms_program_set_returns_policy($1, 'net_returns_v1', $2, $3)`, [PN.id, (await X.prog(PN.id)).v, U.super])
  const SN = X.rows(PN, [{ pid: pn, s: 0, base: 10 }, { pid: pn, s: 1, base: 10 }])
  const RN = [{ ...rr(SN[0], 'PX1', 10, 0), return_recorded_at: new Date(Date.parse(SN[0].completed_at) + 60_000).toISOString() }]
  let r6 = null
  const R6 = await KIT.crun(PN, SN, RN, { publish: true, publishVia: async (runId) => {
    const b = await cnt(PN.id)
    const c = await cancelled(`SELECT public.rpc_cms_sales_run_publish($1) r`, [runId])
    const m = await cnt(PN.id)
    const st6 = (await KIT.runRow(runId)).status
    const again = await X.rpc(`SELECT public.rpc_cms_sales_run_publish($1) r`, [runId])
    r6 = { b, c, m, st6, a: await cnt(PN.id), again, runId }
    return again
  } })
  const wrote6 = r6 && ['cms_return_baselines', 'cms_return_ledger_evals'].every((x) => r6.c.held.includes(x))
  ok(R6.last?.sealed === true && r6 && isTimeout(r6.c.a) && wrote6 && canon(r6.m) === canon(r6.b) && r6.st6 === 'running'
    && r6.again?.published === true && r6.again.baselines_new === 1 && r6.a.ne === 1 && r6.a.nb === 1 && r6.a.seqs === '1' && r6.a.ptr === r6.runId,
    'R6 publish contract net bị statement_timeout cắt SAU khi đã ghi eval + baseline ⇒ 0 delta, run vẫn running; gọi lại ⇒ ok, 1 eval / 1 baseline / pointer',
    JSON.stringify({ sealed: R6.last?.sealed, r6 }))
  await X.db.exec('DROP FUNCTION public.qa_sleep_t()')
}

// ── §10 bench (CHỈ PG15 + --bench): run contract net quy mô 200.000 dòng bán + 20.000 phiếu trả, CẢ HAI mode (plan §5) ─────────────
// Dữ liệu gần trường hợp xấu cho DISTINCT: lượng thô ~50.000 giá trị (cả số lẻ .5), 12 biến thể đơn vị (hoa / thường / khoảng trắng /
// NFD / đơn vị khác), GMV khác nhau, mỗi phiếu trả trỏ một dòng gốc riêng. Đo: TS tính · payload · stage (khối 5.000) · seal 13 bước ·
// publish ×2 (eval 2 đối chiếu toàn bộ baseline) · cleanup run cũ · reader super (trang đầu + trang sâu). Mỗi lời gọi < 8 s (CỨNG —
// statement_timeout authenticated Supabase; RPC service_role cũng giữ trần này theo plan §5).
const BENCH_UNITS = ['Hộp', 'hộp', 'HỘP', ' Hộp', 'Hộp ', '  hộp  ', 'Ho\u0323\u0302p', 'Viên', 'viên', 'Vỉ', 'Chai', 'Tuýp']
async function benchSection() {
  const N_SALES = Number(process.env.CMS130_BENCH_SALES ?? 200_000), N_RET = Number(process.env.CMS130_BENCH_RETURNS ?? 20_000)
  const X = await env('bench')
  ok(X.applied.ok, 'DB bench: áp 130', X.applied.err)
  // CMS130_BENCH_MODES=none ⇒ bỏ bench mode (chỉ chẩn đoán báo cáo sau chốt).
  const modes = (process.env.CMS130_BENCH_MODES ?? 'cms_unit,pos_base').split(',').filter((m) => m && m !== 'none')
  // CMS130_BENCH_STALE=1 (bench 14/11): thống kê CŨ có chủ đích — tắt autovacuum trên mọi bảng cms_*, ANALYZE một lần sau mode đầu
  // (hoặc ngay đầu nếu không có mode) rồi KHÔNG phân tích lại: run / chương trình mới về sau không có trong MCV ⇒ planner ước ~1 dòng
  // (đúng hoàn cảnh prod khi seal / publish / báo cáo chạy trước autoanalyze). Mọi lời gọi vẫn phải < 8 s.
  const stale = process.env.CMS130_BENCH_STALE === '1'
  const cmsTables = stale ? (await X.all(`SELECT format('%I.%I', schemaname, tablename) t FROM pg_tables
    WHERE schemaname = 'public' AND tablename LIKE 'cms\\_%' ORDER BY 1`)).map((r) => r.t) : []
  for (const tb of cmsTables) await X.db.exec(`ALTER TABLE ${tb} SET (autovacuum_enabled = false, toast.autovacuum_enabled = false)`)
  const analyze = async () => { for (const tb of cmsTables) await X.db.exec(`ANALYZE ${tb}`); console.log(`  · [thống kê cũ] ANALYZE ${cmsTables.length} bảng cms_* một lần; autovacuum tắt`) }
  if (stale && !modes.length) await analyze()
  for (const [i, mode] of modes.entries()) {
    await benchMode(X, mode, N_SALES, N_RET, i === 0 && process.env.CMS130_BENCH_LEDGER !== '0')
    if (stale && i === 0) await analyze()
  }
  if (process.env.CMS130_BENCH_REPORT !== '0') await benchReport(X, N_SALES, N_RET)
}

async function benchMode(X, mode, N_SALES, N_RET, withLedger) {
  const NP = 20
  const products = Array.from({ length: NP }, () => ({ pid: X.pid(), k: '10', unit: 'Hộp' }))
  const P = await X.makeProgram({ name: `QA bench contract ${mode}`, isTest: true, products, v2: mode })
  await X.svc(`SELECT public.rpc_cms_program_set_returns_policy($1, 'net_returns_v1', $2, $3)`, [P.id, (await X.prog(P.id)).v, U.super])
  const SEL = [...STORES[0].assigneeEmails, ...STORES[1].assigneeEmails, STORES[2].assigneeEmails[0], 'nobody.qa@example.invalid']
  const t0 = Date.parse(`${P.start}T02:00:00Z`)
  const span = 6 * 24 * 3600 * 1000
  const salesRaw = new Array(N_SALES)
  for (let i = 0; i < N_SALES; i++) {
    const t = new Date(t0 + Math.floor((i / N_SALES) * span)).toISOString()
    const qi = 1 + (i % 50_000)
    const half = i % 13 === 0
    const qRaw = half ? `${qi}.5` : String(qi)
    const base = qi * 10 + (half ? 5 : 0)
    salesRaw[i] = { order_line_id: String(960000000 + i), order_id: `BO${Math.floor(i / 3)}`, order_code: `BQA-${Math.floor(i / 3)}`,
      product_id: products[i % NP].pid, seller_email: SEL[i % SEL.length], pos_code: `QAOS${String(i % 7).padStart(2, '0')}`, order_type: 'OFFLINE',
      order_status: 'COMPLETED', completed_at: t, quantity_raw: qRaw, uom_raw: BENCH_UNITS[i % BENCH_UNITS.length], base_quantity: String(base),
      gmv_amount: String(base * 1000 + (i % 997)), source_updated_at: t }
  }
  // as_of theo giờ thật (cửa sổ seal N2: ≤ mở run + 5 phút, ≥ mở run − 36 giờ); mọi dòng bán / phiếu trả đều trước đó.
  const asOfMs = Date.now() - 60_000
  const step = Math.floor(N_SALES / N_RET)
  const retRaw = new Array(N_RET)
  for (let j = 0; j < N_RET; j++) {
    const s = salesRaw[j * step]
    const at = new Date(Date.parse(s.completed_at) + 60_000).toISOString()
    retRaw[j] = j % 20 === 0 ? { return_event_id: `BR${j}`, return_status: 'APPROVED' } : {
      return_event_id: `BR${j}`, return_document_id: `BRD${j}`, return_code: `BRC${j}`, return_status: 'COMPLETED', return_recorded_at: at,
      original_order_line_id: s.order_line_id, original_order_id: s.order_id, product_id: s.product_id, return_base_quantity: String(5 + (j % 6)),
      return_gmv_amount: String(1000 + (j % 513)), original_completed_at: s.completed_at, original_order_type: 'OFFLINE', original_order_status: 'COMPLETED',
      original_seller_email: s.seller_email, original_pos_code: s.pos_code, original_base_quantity: s.base_quantity, original_gmv_amount: s.gmv_amount,
      original_quantity_raw: s.quantity_raw, original_uom_raw: s.uom_raw, source_updated_at: at }
  }
  const T = {}
  const timed = async (k, fn) => { const a = performance.now(); try { return await fn() } finally { T[k] = Math.round(performance.now() - a) } }
  const calls = []
  const call = async (what, sql, p) => {
    const a = performance.now()
    const r = await X.rpc(sql, p)
    calls.push({ what, ms: Math.round(performance.now() - a) })
    return r
  }
  const asSuper = async (what, sql, p) => {
    const a = performance.now()
    const r = (await L.as(X.db, U.super, () => X.db.query(sql, p), 'authenticated')).rows[0].r
    calls.push({ what, ms: Math.round(performance.now() - a) })
    return r
  }
  async function brun(asOfMicros, retsRaw = retRaw) {
    const opened = await call('open', `SELECT public.rpc_cms_sales_run_open($1, $2::jsonb) r`, [P.id, JSON.stringify({ source: 'qa', calc_contract: 'cms-calc-ret2-v1' })])
    const runId = opened.run_id
    const snap = CS.parseCmsContractSnapshot(opened)
    const sales = await timed('ts_normalize', () => salesRaw.map((r) => { const n = C.normalizeSalesRow(r); if (!n.ok) throw new Error('dòng bán bench lỗi'); return NET.cmsCalcSaleLine(r, n.value) }))
    const rets = retsRaw.map((r) => { const n = RT.normalizeReturnRow(r); if (!n.ok) throw new Error('phiếu bench lỗi'); return n.value })
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
  // Chẩn đoán (CMS130_PGLOG=<file>): auto_explain mọi câu ≥ 300 ms kể cả câu lồng trong hàm (log server ⇒ file). Không đổi kết quả.
  if (process.env.CMS130_PGLOG) {
    await X.db.exec(`LOAD 'auto_explain'; SET auto_explain.log_min_duration = 300; SET auto_explain.log_analyze = on;
      SET auto_explain.log_nested_statements = on; SET auto_explain.log_buffers = on`)
  }
  const asOf1 = BigInt(asOfMs) * BigInt(1000)
  const b1 = await brun(asOf1)
  const T1 = { ...T }
  const nb = Number((await X.one(`SELECT count(*)::int n FROM public.cms_return_baselines WHERE program_id = $1`, [P.id])).n)
  const b2 = await brun(asOf1 + BigInt(1000))
  const T2 = { ...T }
  const ev = await X.all(`SELECT eval_seq::int s, verdict v, baselines::int b FROM public.cms_return_ledger_evals WHERE program_id = $1 ORDER BY eval_seq`, [P.id])
  const dq = (await X.one(`SELECT count(DISTINCT (quantity_raw, uom_raw))::int qu, count(DISTINCT quantity_raw)::int q, count(DISTINCT uom_raw)::int u
    FROM public.cms_sales_lines WHERE run_id = $1`, [b2.runId]))
  const cls = await X.all(`SELECT quantity_class c, count(*)::int n FROM public.cms_sales_lines WHERE run_id = $1 GROUP BY 1 ORDER BY 1`, [b2.runId])

  // Sổ quy mô (db-reviewer 14/11 P1-2): nguồn mất toàn bộ phiếu đã nhận ⇒ ~19.000 conflict MISSING + observation; nguồn khớp lại ⇒
  // OPEN_CONFLICT_MATCH + ~19.000 observation MATCH; super confirm (authenticated — trần 8 s) đóng toàn bộ; run sạch ⇒ công bố. Sau đó run
  // ok cũ b1 không còn là current / previous ⇒ cleanup có dữ liệu thật để dọn.
  let led = null
  if (withLedger) {
    const b3 = await brun(asOf1 + BigInt(2000), retRaw.filter((r) => r.return_status === 'APPROVED'))
    const nOpen3 = Number((await X.one(`SELECT count(*)::int n FROM public.cms_return_conflicts WHERE program_id = $1`, [P.id])).n)
    const b4 = await brun(asOf1 + BigInt(3000))
    const oh = await X.one(`SELECT public.cms__open_set_hash($1) h, (SELECT max(eval_seq) FROM public.cms_return_ledger_evals WHERE program_id = $1)::text s`, [P.id])
    const cf = await asSuper('confirm', `SELECT public.rpc_cms_return_conflicts_confirm_restored($1, $2, $3, $4, $5) r`,
      [P.id, oh.h, oh.s, 'Nguồn trả hàng đã khôi phục đúng phiếu đã nhận — bench', globalThis.crypto.randomUUID()])
    const b5 = await brun(asOf1 + BigInt(4000))
    const nObs = Number((await X.one(`SELECT count(*)::int n FROM public.cms_return_conflict_observations WHERE program_id = $1`, [P.id])).n)
    led = { b3: b3.pub, b4: b4.pub, cf, b5: b5.pub, runId: b5.runId, nOpen3, nObs }
    console.log(`  · [${mode}] sổ: conflict mở ${nOpen3}, observation ${nObs}; publish MISMATCH ${calls.filter((c) => c.what === 'publish')[2]?.ms} ms · OPEN_CONFLICT_MATCH ${calls.filter((c) => c.what === 'publish')[3]?.ms} ms · confirm ${calls.find((c) => c.what === 'confirm')?.ms} ms · publish sạch ${calls.filter((c) => c.what === 'publish')[4]?.ms} ms`)
  }
  const cur = led?.runId ?? b2.runId
  const evAll = await X.all(`SELECT eval_seq::int s, verdict v, baselines::int b FROM public.cms_return_ledger_evals WHERE program_id = $1 ORDER BY eval_seq`, [P.id])

  // Cleanup run cũ (b1, đã thay pointer) — từng lời gọi 50.000 dòng.
  let more = true, nClean = 0
  await timed('cleanup_total', async () => { for (let i = 0; i < 60 && more; i++) { more = (await call(`cleanup#${i}`, `SELECT public.rpc_cms_sales_run_cleanup($1, 50000) r`, [P.id])).more; nClean++ } })
  const leftB1 = Number((await X.one(`SELECT count(*)::int n FROM public.cms_sales_lines WHERE run_id = $1`, [b1.runId])).n)

  // Reader super (authenticated) trên run công bố b2: trang đầu + trang sâu (keyset gần cuối).
  const nEv = Number((await X.one(`SELECT count(*)::int n FROM public.cms_result_events WHERE run_id = $1`, [cur])).n)
  const nRl = Number((await X.one(`SELECT count(*)::int n FROM public.cms_return_lines WHERE run_id = $1`, [cur])).n)
  const oneUser = (await X.one(`SELECT user_id::text u FROM public.cms_result_events WHERE run_id = $1 AND user_id IS NOT NULL LIMIT 1`, [cur])).u
  const rd = {}
  rd.header = await asSuper('header_v2', `SELECT public.rpc_cms_result_header_v2($1) r`, [P.id])
  rd.rows = await asSuper('rows_v2', `SELECT public.rpc_cms_result_rows_v2($1, $2) r`, [P.id, cur])
  rd.ev0 = await asSuper('events_v2 đầu', `SELECT public.rpc_cms_result_events_v2($1, $2, NULL, NULL, NULL, 500) r`, [P.id, cur])
  rd.evDeep = await asSuper('events_v2 sâu', `SELECT public.rpc_cms_result_events_v2($1, $2, NULL, NULL, $3, 500) r`, [P.id, cur, Math.max(nEv - 600, 0)])
  rd.evUser = await asSuper('events_v2 một dược sĩ', `SELECT public.rpc_cms_result_events_v2($1, $2, NULL, $3, NULL, 500) r`, [P.id, cur, oneUser])
  rd.exQ = await asSuper('excluded_v2 quantity', `SELECT public.rpc_cms_result_excluded_v2($1, $2, 'quantity', NULL, 500) r`, [P.id, cur])
  rd.exQDeep = await asSuper('excluded_v2 quantity sâu', `SELECT public.rpc_cms_result_excluded_v2($1, $2, 'quantity', $3, 500) r`, [P.id, cur, Math.max(N_SALES - 2000, 0)])
  rd.exD = await asSuper('excluded_v2 disposition', `SELECT public.rpc_cms_result_excluded_v2($1, $2, 'disposition', NULL, 500) r`, [P.id, cur])
  rd.rt0 = await asSuper('returns_v2 đầu', `SELECT public.rpc_cms_result_returns_v2($1, $2, NULL, 500) r`, [P.id, cur])
  rd.rtDeep = await asSuper('returns_v2 sâu', `SELECT public.rpc_cms_result_returns_v2($1, $2, $3, 500) r`, [P.id, cur, Math.max(nRl - 600, 0)])
  rd.cf = await asSuper('return_conflicts', `SELECT public.rpc_cms_return_conflicts($1) r`, [P.id])

  const by = (re) => calls.filter((c) => re.test(c.what)).reduce((m, c) => (c.ms > m.ms ? c : m), { what: '-', ms: 0 })
  const worst = calls.reduce((m, c) => (c.ms > m.ms ? c : m), { what: '-', ms: 0 })
  const readerMs = Object.fromEntries(calls.filter((c) => /_v2|conflicts/.test(c.what)).map((c) => [c.what, c.ms]))
  console.log(`  · [${mode}] ${N_SALES} dòng bán / ${N_RET} phiếu (${b1.parts.return_lines} return_lines, ${b1.parts.result_events} sự kiện, ${nb} baseline); DISTINCT (q, u) = ${dq.qu}, q = ${dq.q}, u = ${dq.u}; lớp ${JSON.stringify(cls)}`)
  console.log(`  · [${mode}] lượt 1 (ms): ${JSON.stringify(T1)}`)
  console.log(`  · [${mode}] lượt 2 (ms): ${JSON.stringify(T2)}`)
  console.log(`  · [${mode}] cleanup: ${nClean} lời gọi, tổng ${T.cleanup_total} ms, chậm nhất ${by(/^cleanup/).ms} ms; còn ${leftB1} dòng run cũ`)
  console.log(`  · [${mode}] reader (ms): ${JSON.stringify(readerMs)}`)
  console.log(`  · [${mode}] chậm nhất: ${worst.what} ${worst.ms} ms; stage chậm nhất ${by(/^stage/).ms} ms; seal chậm nhất ${by(/^seal /).what} ${by(/^seal /).ms} ms`)
  const readersOk = rd.header?.run?.id === cur && rd.rows?.results?.length > 0 && rd.ev0?.rows?.length === 500 && rd.evDeep?.rows?.length > 0
    && rd.evUser?.rows?.length > 0 && rd.rt0?.rows?.length === 500 && rd.rtDeep?.rows?.length > 0 && Array.isArray(rd.exD?.rows) && Array.isArray(rd.exQ?.rows)
    && (mode !== 'cms_unit' || rd.exQ.rows.length > 0)
  const ledOk = !led || (led.b3?.code === 'CMS_RETURN_LEDGER_CONFLICT' && led.b4?.code === 'CMS_RETURN_CONFLICT_OPEN' && led.cf?.confirmed === true
    && led.cf.conflicts === nb && led.b5?.published === true && led.nOpen3 === nb && evAll.length === 5
    && canon(evAll.map((x) => x.v)) === canon(['CLEAN', 'CLEAN', 'MISMATCH', 'OPEN_CONFLICT_MATCH', 'CLEAN']))
  ok(b1.pub?.published === true && b2.pub?.published === true && nb > 0 && ev.length === 2 && ev[0].v === 'CLEAN' && ev[1].v === 'CLEAN' && ev[1].b === nb
    && dq.qu >= Math.min(N_SALES, 50_000) && ledOk && (led ? !more && leftB1 === 0 : true) && readersOk && worst.ms < 8000,
    `bench [${mode}] ${N_SALES} / ${N_RET}: 2 run net seal 13 bước + publish (eval 2 đối chiếu ${nb} baseline) ${led ? ' + sổ ' + led.nOpen3 + ' conflict (mất nguồn → khớp lại → confirm → sạch)' : ''} + cleanup + 11 reader; DISTINCT (q, u) ${dq.qu}; mọi lời gọi < 8 s (chậm nhất ${worst.what} ${worst.ms} ms)`,
    JSON.stringify({ p1: b1.pub, p2: b2.pub, ev, led, evAll, worst, more, leftB1, readersOk, rd: Object.fromEntries(Object.entries(rd).map(([k, v]) => [k, v?.rows?.length ?? v?.results?.length ?? (v ? 'obj' : v)])) }).slice(0, 600))
}


// Bench báo cáo sau chốt: chương trình QA legacy 200k dòng bán đã chốt + 20k phiếu: save 1 (20k sự kiện + baseline), save 2 (eval đối
// chiếu 20k baseline), đọc dòng bán đóng băng (keyset 5.000), reader báo cáo (dòng + sự kiện trang sâu). Mọi lời gọi < 8 s.
async function benchReport(X, N_SALES, N_RET) {
  const NP = 20
  const products = Array.from({ length: NP }, () => ({ pid: X.pid(), k: '10' }))
  const start = await X.day(-40), end = await X.day(-10)
  const P = await X.makeProgram({ name: 'QA bench báo cáo sau chốt', isTest: true, products, dates: [start, end] })
  const S = X.rows(P, Array.from({ length: N_SALES }, (_, i) => ({ pid: products[i % NP].pid, s: i % 3, base: 10 })))
  const calls = []
  const T = {}
  const timed = async (k, fn) => { const a = performance.now(); try { return await fn() } finally { T[k] = Math.round(performance.now() - a) } }
  const call = async (what, sql, p) => { const a = performance.now(); const r = await X.rpc(sql, p); calls.push({ what, ms: Math.round(performance.now() - a) }); return r }
  const asSuper = async (what, sql, p) => {
    const a = performance.now()
    const r = (await L.as(X.db, U.super, () => X.db.query(sql, p), 'authenticated')).rows[0].r
    calls.push({ what, ms: Math.round(performance.now() - a) })
    return r
  }
  const sy = await timed('legacy_sync', () => X.syncQa(P, S))
  if (process.env.CMS130_PGLOG) {
    await X.db.exec(`LOAD 'auto_explain'; SET auto_explain.log_min_duration = 300; SET auto_explain.log_analyze = on;
      SET auto_explain.log_nested_statements = on; SET auto_explain.log_buffers = on; SET auto_explain.log_triggers = on`)
  }
  const LD = {
    lockEnabled: () => true, qaReadonly: () => false, access: async () => ({ kind: 'ok', actorId: U.super, qa: true }),
    program: async (id) => { const r = await X.one(`SELECT is_test FROM public.cms_programs WHERE id = $1`, [id]); return r ? { isTest: r.is_test } : null },
    rpc: async (fn, args) => {
      const named = Object.keys(args).map((k, i) => `${k} => $${i + 1}`).join(', ')
      const a = performance.now()
      try { return { data: (await X.svc(`SELECT public.${fn}(${named}) r`, Object.values(args))).rows[0].r, error: null } }
      catch (e) { return { data: null, error: { code: e.code, message: e.message } } }
      finally { calls.push({ what: fn, ms: Math.round(performance.now() - a) }) }
    },
  }
  const pv = await LA.runCmsLockPreview(LD, P.id)
  const lk = pv.ok ? await LA.runCmsLock(LD, { programId: P.id, expectedRunId: sy.runId, expectedPolicyVersion: pv.preview.policyVersion }) : { ok: false }
  const step = Math.floor(N_SALES / N_RET)
  const endMs = Date.parse(`${end}T05:00:00Z`)
  const raws = Array.from({ length: N_RET }, (_, j) => {
    const s = S[j * step]
    return { return_event_id: `QR${j}`, return_document_id: `RDQ${j}`, return_code: null, return_status: 'COMPLETED',
      return_recorded_at: new Date(endMs + j * 1000).toISOString(), original_order_line_id: s.order_line_id, original_order_id: s.order_id,
      product_id: s.product_id, return_base_quantity: String(1 + (j % 5)), return_gmv_amount: String(1000 + (j % 97)),
      original_completed_at: s.completed_at, original_order_type: 'OFFLINE', original_order_status: 'COMPLETED', original_seller_email: s.seller_email,
      original_pos_code: s.pos_code, original_base_quantity: s.base_quantity, original_gmv_amount: s.gmv_amount, original_quantity_raw: s.quantity_raw,
      original_uom_raw: s.uom_raw, source_updated_at: null }
  })
  const recs = raws.map((r) => { const n = RT.normalizeReturnRow(r); if (!n.ok) throw new Error('phiếu bench báo cáo lỗi'); return n.value })
  const PROG = { startDate: start, endDate: end, productIds: products.map((p) => p.pid) }
  const asOf = BigInt(Date.now() - 60_000) * BigInt(1000)
  const SAVE = `SELECT public.rpc_cms_return_close_report_save($1, $2, $3::jsonb) r`
  const p1 = CR.buildCmsCloseReportPayload(PROG, recs, { provider: 'fixture', snapshotId: 'qa-bench-report', asOfMicros: asOf })
  const r1 = await call('report_save 1', SAVE, [P.id, sy.runId, JSON.stringify(p1)])
  const p2 = CR.buildCmsCloseReportPayload(PROG, recs, { provider: 'fixture', snapshotId: 'qa-bench-report', asOfMicros: asOf + BigInt(1000) })
  const r2 = await call('report_save 2', SAVE, [P.id, sy.runId, JSON.stringify(p2)])
  let after = null, pages = 0, frozen = 0
  for (let i = 0; i < 200; i++) {
    const pg = await call(`frozen_sales#${i}`, `SELECT public.rpc_cms_frozen_sales_lines($1, $2, 5000) r`, [P.id, after])
    frozen += pg.rows.length; pages++; after = pg.next_after_seq
    if (after == null) break
  }
  const d1 = await asSuper('close_report dòng', `SELECT public.rpc_cms_return_close_report($1, NULL, 1000) r`, [r2.report_id])
  const lastId = [...raws.map((r) => r.return_event_id)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))[N_RET - 600]
  const e1 = await asSuper('close_report sự kiện đầu', `SELECT public.rpc_cms_return_close_report_events($1, NULL, 1000) r`, [r2.report_id])
  const e2 = await asSuper('close_report sự kiện sâu', `SELECT public.rpc_cms_return_close_report_events($1, $2, 1000) r`, [r2.report_id, lastId])
  const worst = calls.reduce((m, c) => (c.ms > m.ms ? c : m), { what: '-', ms: 0 })
  const by = (re) => calls.filter((c) => re.test(c.what)).reduce((m, c) => (c.ms > m.ms ? c : m), { what: '-', ms: 0 })
  console.log(`  · [báo cáo] sync legacy ${N_SALES} dòng ${T.legacy_sync} ms; chốt ${by(/lock/).what} ${by(/lock/).ms} ms; save 1 ${calls.find((c) => c.what === 'report_save 1').ms} ms (${r1.return_events} sự kiện, ${r1.baselines_new} baseline); save 2 ${calls.find((c) => c.what === 'report_save 2').ms} ms; dòng bán đóng băng ${pages} trang (${frozen} dòng, chậm nhất ${by(/^frozen/).ms} ms); reader ${JSON.stringify(Object.fromEntries(calls.filter((c) => /^close_report/.test(c.what)).map((c) => [c.what, c.ms])))}`)
  ok(sy.status === 'published' && lk.ok && r1.saved === true && r1.return_events === N_RET && r1.baselines_new === N_RET && r2.saved === true
    && r2.already === false && r2.baselines_new === 0 && frozen === N_SALES && d1.lines?.length > 0 && e1.events?.length === 1000 && e2.events?.length === 599
    && e2.next_after === null && worst.ms < 8000,
    `bench báo cáo sau chốt: ${N_SALES} dòng bán chốt + ${N_RET} phiếu — save 1 / save 2 (eval đối chiếu ${N_RET} baseline) / dòng bán đóng băng ${pages} trang / reader; mọi lời gọi < 8 s (chậm nhất ${worst.what} ${worst.ms} ms)`,
    JSON.stringify({ sy: sy.status, lk: lk.ok ? 'ok' : lk, r1: { s: r1.saved, n: r1.return_events, b: r1.baselines_new, c: r1.code }, r2: { s: r2.saved, a: r2.already, b: r2.baselines_new, c: r2.code },
      frozen, e1: e1.events?.length, e2: e2.events?.length, worst }).slice(0, 600))
}

try {
  await main()
} catch (e) {
  fail++
  console.log(`\n  ✗ LỖI: ${e?.stack ?? e}`)
} finally {
  for (const c of closers.reverse()) { try { await c() } catch {} }
}
console.log(`\n${pass} đạt · ${fail} lỗi`)
process.exitCode = fail ? 1 : 0
// embedded-postgres (--pg15) gắn async-exit-hook: sự kiện beforeExit ⇒ process.exit(0) ĐÈ exitCode (bench 14/11 r4b: "2 lỗi" mà exit 0)
// ⇒ chờ stdout xả rồi thoát tường minh bằng đúng mã.
await new Promise((resolve) => process.stdout.write('', resolve))
process.exit(fail ? 1 : 0)
