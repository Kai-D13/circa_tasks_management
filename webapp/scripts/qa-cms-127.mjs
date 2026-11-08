// QA migration 127 (S0 CMS đơn giản — PM spec r1 2026-11-08 §3: sửa dữ liệu ĐÚNG MỘT chương trình thật T11 sang mức cố định / hộp) trên
// chuỗi migration THẬT 120 → 126 + app hiện hành (engine / sales sync / đọc kết quả). Hai backend: PGlite (mặc định, Postgres 16 WASM) và
// PostgreSQL 15 thật (embedded: `--pg15 <embedded-postgres-dir> <data-root>`).
//   §0 generator ↔ file (byte) · LF · md5 6 guard = ma trận VERIFY · bản ghim thật = 17 mức PM (md5) · pin không email
//   §1 DB 126 + chương trình thật giống T11 (phạm vi tất cả OS, 17 SP × 3 bậc 15k/20k/25k, K 10–180) có run công bố + chương trình thật khác
//      + chương trình QA (không được đổi) · tiền trước 127 = oracle bậc cũ
//   §2 preflight dừng, 0 delta (bậc / version / pointer / marker / chế độ trigger): ghim cũ (version) · SP lệch · bậc lệch · phạm vi lệch ·
//      run 'running' · trigger pointer ALWAYS · đã có marker 127 · thiếu 126 · có số > 126 · role không phải owner · không READ COMMITTED ·
//      lỗi giữa chừng SAU khi đã tắt trigger (hậu kiểm hỏng) ⇒ rollback cả transaction, trigger về 'O'
//   §3 áp 127: 17 bậc đúng mức, version +1, pointer NULL, SP / phạm vi / chương trình khác / QA / run / kết quả / hàm / ACL / trigger không
//      đổi · marker notes · chạy lại bị chặn · VERIFY 127 (v127-t11-pm đỏ có chủ đích trên DB thử) · checker 126 trên DB 127 đỏ ·
//      đọc kết quả thật (rpc_cms_result_header) ⇒ config_reset, không tiền cũ
//   §4 tính lại ngay: run mới version mới, tiền = oracle độc lập Q × mức (Q = floor(ΣB / K)) từng cặp · run cũ / kết quả cũ giữ nguyên ·
//      VERIFY 127 --require-proven=resync
//   §5 rollback: 51 bậc ghim, version TĂNG tiếp, pointer NULL, marker xoá, run giữ, hàm / ACL / trigger không đổi · áp lại CÙNG file bị
//      chặn (version) · ghim mới ⇒ áp lại được (version tăng tiếp) · rollback bị chặn khi đã có chỉnh sửa sau 127
//   §6 dán CRLF (Studio): 127 + rollback CRLF ≡ LF · guard thân lạ ⇒ preflight dừng
//   §7 (chỉ --pg15) race: giao dịch giữ khoá dòng chương trình / ghi bảng run ⇒ 127 hết lock_timeout, 0 delta, trigger 'O'; nhả ⇒ áp được
// KHÔNG chạm DB thật / nguồn thật / mạng (PG15 chỉ 127.0.0.1).
//   npm i --no-save @electric-sql/pglite@0.2.17 ; node scripts/qa-cms-127.mjs
//   node scripts/qa-cms-127.mjs --pg15 <embedded-postgres-dir> <data-root>
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createJiti } from 'jiti'
import * as L from './lib-care-pglite.mjs'
import { buildCms127, loadCms127Pin, validateCms127Pin, cmsRatesMd5, CMS_127_FILE, CMS_127_ROLLBACK_FILE, CMS_127_GUARDS, CMS_127_RATES } from './gen-cms-127.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIG = path.join(HERE, '..', '..', 'supabase', 'migrations')
const SQL = (f) => fs.readFileSync(path.join(MIG, f), 'utf8')
const SQL_127 = fs.readFileSync(CMS_127_FILE, 'utf8')
const RB_127 = fs.readFileSync(CMS_127_ROLLBACK_FILE, 'utf8')
const jiti = createJiti(import.meta.url, { interopDefault: true, alias: { '@': path.join(HERE, '..') } })
const lib = (p) => jiti.import(path.join(HERE, '..', p))
const T = await lib('e2e/cmsQaTooling.ts')
const C = await lib('lib/cms/source/contract.ts')
const SS = await lib('lib/cms/salesSync.ts')
const RV = await lib('lib/cms/resultView.ts')
const FX = await lib('e2e/cmsFixtureRunner.ts')
const QR = await lib('e2e/cmsQaResults.ts')
const { U, storeId, STORES, sha } = L

const argv = process.argv.slice(2)
const PG15 = argv[0] === '--pg15'
let pass = 0, fail = 0
const ok = (c, name, extra = '') => { if (c) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) } }
const section = (s) => console.log(`\n${s}`)
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, err: String(e?.message ?? e), code: e?.code }))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const execFail = async (db, sql) => { const r = await settle(db.exec(sql)); if (!r.ok) await db.exec('ROLLBACK').catch(() => {}); return r }
const lastRows = (results) => { for (let i = results.length - 1; i >= 0; i--) if (results[i].rows?.length) return results[i].rows; return [] }
const B = (x) => BigInt(x)
const CRLF = (s) => s.split('\n').join('\r\n')
/** Oracle ĐỘC LẬP bậc cũ 1–9 @15.000 · 10–19 @20.000 · từ 20 @25.000 (không dùng tiers.ts / SQL seal). */
const stakeF = (q) => { q = B(q); const mn = (a, b) => (a < b ? a : b), mx = (a, b) => (a > b ? a : b); return B(15000) * mn(q, B(9)) + B(20000) * mn(mx(q - B(9), B(0)), B(10)) + B(25000) * mx(q - B(19), B(0)) }
const T3 = [{ order: 1, from: 1, to: 9, amount: '15000' }, { order: 2, from: 10, to: 19, amount: '20000' }, { order: 3, from: 20, to: null, amount: '25000' }]
const K17 = ['20', '30', '60', '90', '30', '120', '10', '60', '20', '20', '20', '180', '30', '30', '30', '20', '30']
const RATES17 = Object.values(CMS_127_RATES)

// ── §0 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
section('0. Generator ↔ file · md5 guard · bản ghim thật')
const GEN = buildCms127()
ok(GEN.migration === SQL_127 && GEN.rollback === RB_127, 'scripts/gen-cms-127.mjs sinh ĐÚNG byte 127 + rollback trên đĩa')
ok(!SQL_127.includes('\r') && !RB_127.includes('\r'), '127 + rollback giữ LF')
ok(GEN.guards.length === 6 && GEN.guards.every((g) => g.md5 === T.CMS_FN_MATRIX[g.name]?.src),
  '6 guard: md5 định nghĩa cuối 120–126 = ma trận VERIFY', GEN.guards.map((g) => `${g.name} ${g.md5.slice(0, 8)}/${String(T.CMS_FN_MATRIX[g.name]?.src).slice(0, 8)}`).join(' '))
const PIN = loadCms127Pin()
ok(GEN.ratesMd5 === T.CMS_127_PM_RATES_MD5 && cmsRatesMd5(PIN.products) === T.CMS_127_PM_RATES_MD5 && PIN.program.id === T.CMS_127_T11_ID,
  'bản ghim thật = T11 + 17 mức PM (md5 = hằng VERIFY)')
ok(!/@/.test(fs.readFileSync(path.join(HERE, 'cms-127', 'pin.json'), 'utf8')), 'pin.json không có email')
ok((() => { try { validateCms127Pin({ ...PIN, products: PIN.products.map((p, i) => (i ? p : { ...p, new_amount: p.new_amount + 1 })) }); return false } catch { return true } })(),
  'bản ghim T11 lệch mức PM ⇒ generator từ chối')
const CODE_127 = SQL_127.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
ok(CODE_127.split('DISABLE TRIGGER').length - 1 === 1 && CODE_127.split('DISABLE TRIGGER cms_programs_result_guard').length - 1 === 1
  && CODE_127.split('ENABLE TRIGGER cms_programs_result_guard').length - 1 === 1 && !/DISABLE TRIGGER ALL|session_replication_role/.test(CODE_127),
  'mã (không tính comment): tắt tạm đúng 1 trigger pointer, bật lại đúng nó, không DISABLE ALL / session_replication_role')

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
    PORT = 54357; PASS = 'qa-local-only'
    cluster = new EmbeddedPostgres({ databaseDir: path.join(path.resolve(dataRoot), `pgdata-cms127-${Date.now()}`), user: 'postgres', password: PASS, port: PORT,
      persistent: true, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {}, onError: () => {} })
    await cluster.initialise(); await cluster.start()
  }
  const name = `rpgcms127_${tag}`
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

/** Môi trường: chuỗi 120 → 126, chương trình giống T11 (thật, phạm vi tất cả OS, 17 SP × 3 bậc) + thật khác + QA, có run công bố. */
async function env(tag) {
  const { db, label, conn } = await makeDb(tag)
  const one = async (sql, p = []) => (await db.query(sql, p)).rows[0]
  const all = async (sql, p = []) => (await db.query(sql, p)).rows
  const lastQ = (sql) => db.exec(T.pgMetaReadOnly(sql)).then(lastRows)
  const svc = (sql, params = []) => L.as(db, null, () => db.query(sql, params), 'service_role')
  const snapshot = async () => { const r = (await lastQ(T.cmsVerifyAclSql()))[0]; await sleep(20); return r }
  await db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('117','t'),('118','t'),('118a','t'),('119','t'),('119a','t') ON CONFLICT DO NOTHING`)
  for (const f of ['120_cms_foundation.sql', '121_cms_import_activation.sql', '122_cms_results.sql', '123_cms_payouts.sql', '124_cms_source_attestation.sql',
    '125_cms_uncapped_last_tier.sql', '126_cms_sales_only_results_release.sql']) { await db.exec(SQL(f)); await sleep(20) }
  await db.query(`INSERT INTO public.cms_product_master (product_id, product_name, is_active, source_updated_at)
    SELECT g::text, 'SP giả ' || g, true, now() FROM generate_series(947001, 947100) g`)
  await db.query(`INSERT INTO public.cms_qa_access (user_id, granted_by, expires_at) VALUES ($1, 'qa-script:cms-127', now() + interval '6 hours')`, [U.super])
  let pidNext = 947001, seqf = 0, lineSeq = 0
  const pid = () => String(pidNext++)
  const day = async (n) => { const t = (await one(`SELECT public.cms__vn_today()::text d`)).d; const d = new Date(`${t}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
  const prodPayload = (p) => ({ product_id: p.pid, gmv_basis: 'none', target_gmv: null, base_quantity_cms: p.k ?? '1', tiers: p.tiers,
    unit_cms: 'hộp', advice_text: `Tư vấn QA ${p.pid}`, name_snapshot: `SP giả ${p.pid}`, image_url_snapshot: null, price_snapshot: null })
  async function preview(id, mode = 'replace') {
    const fileSha = sha(`f127-${tag}-${++seqf}`), digest = sha(`d127-${tag}-${seqf}`)
    const run = (await svc(`SELECT public.rpc_cms_import_preview_save($1::jsonb) id`, [JSON.stringify({ program_id: id, mode, file_name: 'qa.xlsx', file_sha256: fileSha,
      file_bytes: 10, actor: U.super, stats: { rowsTotal: 1, rowsOk: 1, rowsRejected: 0, warnings: 0, productsOk: 1, productsRejected: 0 }, result: { digest } })])).rows[0].id
    return { run, fileSha, digest }
  }
  const commit = async (pr, mode, products) => (await svc(`SELECT public.rpc_cms_import_commit($1, $2, $3, $4::jsonb, $5) r`,
    [pr.run, pr.fileSha, pr.digest, JSON.stringify({ mode, catalog_target: null, products: products.map(prodPayload) }), U.super])).rows[0].r
  async function makeProgram({ name, isTest, products, scopeAll = false }) {
    const start = await day(-7), end = await day(22)
    const id = (await svc(`SELECT public.rpc_cms_program_save($1::jsonb) id`, [JSON.stringify({ actor: U.super, name, start_date: start, end_date: end,
      ...(scopeAll ? { scope: 'all' } : { scope: 'stores', store_ids: [storeId(1), storeId(2)] }), is_test: isTest })])).rows[0].id
    await commit(await preview(id), 'replace', products)
    await svc(`SELECT public.rpc_cms_program_activate($1, $2)`, [id, U.super])
    return { id, products, start, end, isTest }
  }
  const SELLERS = [STORES[0].assigneeEmails[0], STORES[0].assigneeEmails[1], STORES[1].assigneeEmails[0], STORES[1].assigneeEmails[1]]
  const SELLER_IDS = [L.staffId(1, 'a'), L.staffId(1, 'b'), L.staffId(2, 'a'), L.staffId(2, 'b')]
  function rows(p, specs) {
    const out = []
    const t0 = Date.parse(`${p.start}T01:00:00Z`)
    for (const sp of specs) {
      const id = ++lineSeq
      const at = new Date(t0 + id * 1000).toISOString()
      out.push({ order_line_id: String(947000000 + id), order_id: `O${id}`, order_code: `QA-${id}`, product_id: sp.pid, seller_email: SELLERS[sp.s], pos_code: 'QAOS01',
        order_type: 'OFFLINE', order_status: 'COMPLETED', completed_at: at, quantity_raw: '1', uom_raw: 'Hộp', base_quantity: String(sp.base), gmv_amount: '100000', source_updated_at: at })
    }
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
  const prog = (id) => one(`SELECT status, config_version v, current_result_run_id::text ptr, updated_by::text ub FROM public.cms_programs WHERE id = $1`, [id])
  const results = (runId) => all(`SELECT r.user_id::text u, pp.product_id pid, r.cms_quantity::text q, r.amount_vnd::text amt FROM public.cms_results r
    JOIN public.cms_program_products pp ON pp.id = r.program_product_id WHERE r.run_id = $1 ORDER BY 1, 2`, [runId])
  const tiersMd5 = async (id) => (await one(`SELECT md5(coalesce(string_agg(program_product_id::text || ':' || tier_order || ':' || qty_from || ':' || coalesce(qty_to::text, '-') || ':' || amount_per_unit, ',' ORDER BY program_product_id::text, tier_order), '')) m, count(*)::int n FROM public.cms_program_tiers WHERE program_id = $1`, [id]))
  const rowsMd5 = async (sql, p = []) => (await one(`SELECT md5(coalesce(string_agg(x, ',' ORDER BY x), '')) m, count(*)::int n FROM (SELECT to_jsonb(t)::text x FROM (${sql}) t) s`, p))
  const ptrMode = async () => (await one(`SELECT string_agg(tgenabled::text, ',') m FROM pg_trigger WHERE tgrelid = 'public.cms_programs'::regclass AND tgname = 'cms_programs_result_guard'`)).m
  const marker = async (v) => (await one(`SELECT name, notes FROM public.app_migrations WHERE version = $1`, [v])) ?? null
  /** Bản ghim dựng từ DB thử (cùng dạng pin.json thật) — mức gán theo bảng 17 mức PM theo thứ tự SP. */
  async function pinFromDb(programId, cvOverride) {
    const g = await one(`SELECT id::text, status, is_test, start_date::text, end_date::text, scope, calc_mode, gate_scope, catalog_target_gmv, config_version FROM public.cms_programs WHERE id = $1`, [programId])
    const st = await one(`SELECT count(*)::int n, md5(string_agg(store_id::text, ',' ORDER BY store_id::text)) m FROM public.cms_program_stores WHERE program_id = $1`, [programId])
    const pp = await all(`SELECT pp.id::text, pp.product_id, pp.gmv_basis, pp.target_gmv, pp.unit_cms, pp.base_quantity_cms::text, md5(pp.advice_text) advice_md5,
        md5(pp.name_snapshot) name_md5, md5(coalesce(pp.image_url_snapshot, '')) image_md5, pp.price_snapshot, pp.import_run_id::text, pp.added_after_start,
        (SELECT json_agg(json_build_array(t.tier_order, t.qty_from, t.qty_to, t.amount_per_unit) ORDER BY t.tier_order) FROM public.cms_program_tiers t WHERE t.program_product_id = pp.id) old_tiers
      FROM public.cms_program_products pp WHERE pp.program_id = $1 ORDER BY pp.product_id`, [programId])
    return { version: 1, source: { sha256: 'qa-' + tag }, program: { ...g, config_version: cvOverride ?? g.config_version, stores_n: st.n, stores_md5: st.m },
      products: pp.map((x, i) => ({ ...x, old_tiers: x.old_tiers.map((t) => t.map((v) => (v === null ? null : Number(v)))), new_amount: RATES17[i] })) }
  }
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
    if (P_ >= 127) input.p127 = { invFlat: (await lastQ(q.inv127Flat))[0] }
    return input
  }
  // Ngoài DB thử: isolation (môi trường), v127-t11-pm (DB thử dựng chương trình khác T11 — đỏ có chủ đích, kiểm riêng).
  const ENV_ONLY = new Set(['v7-isolation-123', 'isolation', 'v127-t11-pm'])
  const bad = (cs) => cs.filter((c) => !c.ok && !ENV_ONLY.has(c.id))
  const show = (cs) => bad(cs).map((c) => `${c.id}: ${c.detail}`).slice(0, 5).join(' | ')
  const verify = async (phase, aclPre, requireProven) => T.evaluateCmsVerify({ ...(await postInput(phase, aclPre)), ...(requireProven ? { requireProven } : {}) })
  const header = async (uid) => RV.parseCmsResultHeader((await L.as(db, uid, () => db.query(`SELECT public.rpc_cms_result_header($1) r`, [T11.id]))).rows[0].r)

  // Dữ liệu: T11 giả (thật, phạm vi tất cả OS), thật khác (2 SP), QA (2 SP).
  const T11 = await makeProgram({ name: 'QA T11 giả', isTest: false, scopeAll: true, products: K17.map((k) => ({ pid: pid(), k, tiers: T3 })) })
  const OTHER = await makeProgram({ name: 'QA thật khác', isTest: false, products: [{ pid: pid(), k: '10', tiers: T3 }, { pid: pid(), k: '1', tiers: T3 }] })
  const QA = await makeProgram({ name: 'QA namespace', isTest: true, products: [{ pid: pid(), k: '1', tiers: T3 }, { pid: pid(), k: '2', tiers: T3 }] })
  // Dòng bán T11: mỗi SP × 4 người bán, B = K × q + phần lẻ < K (Q ≥ 1, có phần lẻ) — đủ biên Q 1 / 9 / 10 / 19 / 20 / 23 / 45.
  const QS = [1, 9, 10, 19, 20, 23, 45]
  const specs = []
  T11.products.forEach((p, i) => { for (let s = 0; s < 4; s++) { const q = QS[(i + s) % QS.length]; const k = Number(p.k); specs.push({ pid: p.pid, s, base: k * q + ((i + s) % k) }) } })
  const T11_ROWS = rows(T11, specs)
  const OTHER_ROWS = rows(OTHER, [{ pid: OTHER.products[0].pid, s: 0, base: 120 }, { pid: OTHER.products[1].pid, s: 1, base: 7 }])
  const QA_ROWS = rows(QA, [{ pid: QA.products[0].pid, s: 0, base: 3 }])
  return { db, label, conn, one, all, lastQ, svc, snapshot, sync, prog, results, tiersMd5, rowsMd5, ptrMode, marker, pinFromDb, verify, bad, show, header,
    rpc, T11, OTHER, QA, T11_ROWS, OTHER_ROWS, QA_ROWS, SELLER_IDS, specs, pid, preview, commit }
}

/** Oracle ĐỘC LẬP theo cặp (người bán × SP): B = Σ base, Q = floor(B / K), tiền = f(Q) (không dùng engine / tiers.ts). */
function oracle(E, f) {
  const m = new Map()
  for (const sp of E.specs) {
    const p = E.T11.products.find((x) => x.pid === sp.pid)
    const key = `${E.SELLER_IDS[sp.s]}|${sp.pid}`
    m.set(key, { k: B(p.k), b: (m.get(key)?.b ?? B(0)) + B(sp.base), pid: sp.pid })
  }
  return new Map([...m].map(([key, v]) => { const q = v.b / v.k; return [key, { q: String(q), amt: String(f(v.pid, q)) }] }))
}
const sameResults = (rs, exp) => rs.length === exp.size && rs.every((r) => { const e = exp.get(`${r.u}|${r.pid}`); return e && e.q === r.q && e.amt === r.amt })

async function main() {
  section(`1. DB 126 + T11 giả có run công bố (${PG15 ? 'PG15' : 'PGlite'})`)
  const E = await env('main')
  console.log(`  (${E.label})`)
  for (const [p, rws] of [[E.T11, E.T11_ROWS], [E.OTHER, E.OTHER_ROWS], [E.QA, E.QA_ROWS]]) {
    const r = await E.sync(p, rws)
    ok(r.status === 'published', `đồng bộ ${p === E.T11 ? 'T11 giả' : p === E.OTHER ? 'thật khác' : 'QA'} ⇒ công bố`, JSON.stringify(r).slice(0, 200))
  }
  const g0 = await E.prog(E.T11.id)
  const run0 = g0.ptr
  const rs0 = await E.results(run0)
  ok(!!run0 && sameResults(rs0, oracle(E, (pid, q) => stakeF(q))), 'trước 127: tiền T11 = oracle bậc cũ 15k/20k/25k từng cặp', `${rs0.length} cặp`)
  const PIN_H = await E.pinFromDb(E.T11.id)
  const H = buildCms127(PIN_H)
  const base = { tiers: await E.tiersMd5(E.T11.id), g: g0 }
  const zeroDelta = async (what) => {
    const t = await E.tiersMd5(E.T11.id), g = await E.prog(E.T11.id)
    ok(t.m === base.tiers.m && g.v === base.g.v && g.ptr === base.g.ptr && (await E.marker('127')) === null && (await E.ptrMode()) === 'O',
      `${what}: 0 delta (bậc / version / pointer / marker / trigger 'O')`, `v ${g.v} ptr ${String(g.ptr).slice(0, 8)} trig ${await E.ptrMode()}`)
  }
  const failsWith = async (sql, re, what) => {
    const r = await execFail(E.db, sql)
    ok(!r.ok && re.test(r.err), what, r.ok ? 'KHÔNG dừng' : r.err.slice(0, 160))
    await zeroDelta(what)
  }

  section('2. Preflight dừng — 0 delta')
  await failsWith(buildCms127(await E.pinFromDb(E.T11.id, base.g.v + 1)).migration, /config_version \d+ ≠ bản ghim/, 'ghim cũ (version khác) ⇒ dừng')
  const pp0 = await E.one(`SELECT id::text FROM public.cms_program_products WHERE program_id = $1 ORDER BY product_id LIMIT 1`, [E.T11.id])
  await E.db.query(`UPDATE public.cms_program_products SET unit_cms = 'vỉ' WHERE id = $1`, [pp0.id])
  await failsWith(H.migration, /17 SP của chương trình khác bản ghim/, 'SP lệch ghim (đơn vị) ⇒ dừng')
  await E.db.query(`UPDATE public.cms_program_products SET unit_cms = 'hộp' WHERE id = $1`, [pp0.id])
  await E.db.query(`UPDATE public.cms_program_tiers SET amount_per_unit = 15001 WHERE program_product_id = $1 AND tier_order = 1`, [pp0.id])
  await E.db.exec('SELECT 1')
  {
    const r = await execFail(E.db, H.migration)
    ok(!r.ok && /bậc hiện tại khác 51 bậc ghim/.test(r.err), 'bậc lệch ghim ⇒ dừng', r.ok ? 'KHÔNG dừng' : r.err.slice(0, 160))
  }
  await E.db.query(`UPDATE public.cms_program_tiers SET amount_per_unit = 15000 WHERE program_product_id = $1 AND tier_order = 1`, [pp0.id])
  await zeroDelta('bậc lệch ghim (đã trả lại)')
  const st0 = await E.one(`SELECT store_id::text FROM public.cms_program_stores WHERE program_id = $1 ORDER BY store_id LIMIT 1`, [E.T11.id])
  await E.db.query(`DELETE FROM public.cms_program_stores WHERE program_id = $1 AND store_id = $2`, [E.T11.id, st0.store_id])
  {
    const r = await execFail(E.db, H.migration)
    ok(!r.ok && /phạm vi nhà thuốc khác bản ghim/.test(r.err), 'phạm vi lệch ghim ⇒ dừng', r.ok ? 'KHÔNG dừng' : r.err.slice(0, 160))
  }
  await E.db.query(`INSERT INTO public.cms_program_stores (program_id, store_id) VALUES ($1, $2)`, [E.T11.id, st0.store_id])
  await zeroDelta('phạm vi lệch ghim (đã trả lại)')
  const openRun = await E.rpc(`SELECT public.rpc_cms_sales_run_open($1, $2::jsonb) r`, [E.QA.id, JSON.stringify({ source: 'operator' })])
  const openId = openRun?.run_id ?? openRun?.runId ?? openRun?.id
  await failsWith(H.migration, /còn run bán đang chạy/, "run bán 'running' (chương trình khác) ⇒ dừng")
  await E.db.query(`UPDATE public.cms_sync_runs SET status = 'error', error_code = 'QA_ABORT', finished_at = now() WHERE id = $1`, [openId])
  await E.db.exec('ALTER TABLE public.cms_programs ENABLE ALWAYS TRIGGER cms_programs_result_guard')
  {
    const r = await execFail(E.db, H.migration)
    ok(!r.ok && /trigger pointer cms_programs_result_guard không đúng dạng 122/.test(r.err), 'trigger pointer chế độ ALWAYS ⇒ dừng', r.ok ? 'KHÔNG dừng' : r.err.slice(0, 160))
  }
  await E.db.exec('ALTER TABLE public.cms_programs ENABLE TRIGGER cms_programs_result_guard')
  await zeroDelta('trigger ALWAYS (đã trả lại)')
  await E.db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('127', 'x')`)
  { const r = await execFail(E.db, H.migration); ok(!r.ok && /đã có marker 127/.test(r.err), 'đã có marker 127 ⇒ dừng', r.ok ? 'KHÔNG dừng' : r.err.slice(0, 160)) }
  await E.db.query(`DELETE FROM public.app_migrations WHERE version = '127'`)
  await E.db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('128', 'x')`)
  await failsWith(H.migration, /DB đã có migration số > 126/, 'có migration số > 126 ⇒ dừng')
  await E.db.query(`DELETE FROM public.app_migrations WHERE version = '128'`)
  await E.db.query(`UPDATE public.app_migrations SET name = 'x' WHERE version = '126'`)
  await failsWith(H.migration, /thiếu migration nền 126/, 'thiếu 126 ⇒ dừng')
  await E.db.query(`UPDATE public.app_migrations SET name = 'cms_sales_only_results_release' WHERE version = '126'`)
  await E.db.exec(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qa127_su') THEN CREATE ROLE qa127_su SUPERUSER; END IF; END $$`)
  {
    const r = await settle(E.db.exec(`SET ROLE qa127_su; ${H.migration}`))
    if (!r.ok) await E.db.exec('ROLLBACK').catch(() => {})
    await E.db.exec('RESET ROLE')
    ok(!r.ok && /owner bảng \/ hàm CMS khác role chạy/.test(r.err), 'role superuser KHÔNG phải owner ⇒ dừng', r.ok ? 'KHÔNG dừng' : r.err.slice(0, 160))
  }
  await zeroDelta('role không phải owner')
  {
    await E.db.exec('SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE')
    const r = await settle(E.db.exec(H.migration))
    if (!r.ok) await E.db.exec('ROLLBACK').catch(() => {})
    await E.db.exec('SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL READ COMMITTED')
    ok(!r.ok && /cần READ COMMITTED/.test(r.err), 'không READ COMMITTED ⇒ dừng', r.ok ? 'KHÔNG dừng' : r.err.slice(0, 160))
  }
  await zeroDelta('isolation')
  // Chương trình khác ghim: nháp / kỳ / 18 SP · trigger cấu hình khác bị tắt (db-reviewer 127 P2-3 / P2-5).
  const act0 = await E.one(`SELECT activated_at, activated_by::text ab FROM public.cms_programs WHERE id = $1`, [E.T11.id])
  await E.db.query(`UPDATE public.cms_programs SET status = 'draft', activated_at = NULL, activated_by = NULL WHERE id = $1`, [E.T11.id])
  { const r = await execFail(E.db, H.migration); ok(!r.ok && /chương trình khác bản ghim \(status draft/.test(r.err), 'chương trình không active ⇒ dừng', r.ok ? 'KHÔNG dừng' : r.err.slice(0, 160)) }
  await E.db.query(`UPDATE public.cms_programs SET status = 'active', activated_at = $2, activated_by = $3 WHERE id = $1`, [E.T11.id, act0.activated_at, act0.ab])
  await E.db.query(`UPDATE public.cms_programs SET end_date = end_date + 1 WHERE id = $1`, [E.T11.id])
  { const r = await execFail(E.db, H.migration); ok(!r.ok && /chương trình khác bản ghim/.test(r.err), 'kỳ lệch ghim ⇒ dừng', r.ok ? 'KHÔNG dừng' : r.err.slice(0, 160)) }
  await E.db.query(`UPDATE public.cms_programs SET end_date = end_date - 1 WHERE id = $1`, [E.T11.id])
  const extraPid = E.pid()
  await E.db.query(`INSERT INTO public.cms_program_products (program_id, product_id, gmv_basis, unit_cms, base_quantity_cms, advice_text, name_snapshot)
    VALUES ($1, $2, 'none', 'hộp', 1, 'x', 'x')`, [E.T11.id, extraPid])
  { const r = await execFail(E.db, H.migration); ok(!r.ok && /17 SP của chương trình khác bản ghim/.test(r.err), '18 SP (thêm thẳng, không tăng version) ⇒ dừng', r.ok ? 'KHÔNG dừng' : r.err.slice(0, 160)) }
  await E.db.query(`DELETE FROM public.cms_program_products WHERE program_id = $1 AND product_id = $2`, [E.T11.id, extraPid])
  await E.db.exec('ALTER TABLE public.cms_programs DISABLE TRIGGER cms_programs_guard')
  { const r = await execFail(E.db, H.migration); ok(!r.ok && /trigger bảng cấu hình \(tên \/ chế độ \/ hàm\) khác bản duyệt/.test(r.err), 'trigger cấu hình khác (cms_programs_guard tắt) ⇒ dừng', r.ok ? 'KHÔNG dừng' : r.err.slice(0, 160)) }
  await E.db.exec('ALTER TABLE public.cms_programs ENABLE TRIGGER cms_programs_guard')
  await zeroDelta('nháp / kỳ / 18 SP / trigger khác (đã trả lại)')
  // Cờ giai đoạn: khối ghi / khối hậu kiểm chạy riêng (mô phỏng client tự savepoint bỏ qua khối lỗi) ⇒ tự chặn, 0 ghi.
  const dmlBlock = H.migration.slice(H.migration.indexOf('-- ── 1. Sửa đúng T11'), H.migration.indexOf('SET CONSTRAINTS ALL IMMEDIATE;'))
  const postBlock = H.migration.slice(H.migration.indexOf('-- ── 2. Hậu kiểm trong transaction'), H.migration.indexOf('\nCOMMIT;'))
  for (const [what, blk] of [['khối ghi', dmlBlock], ['khối hậu kiểm + marker', postBlock]]) {
    const r = await execFail(E.db, `BEGIN;\n${blk}\nROLLBACK;`)
    ok(!r.ok && /bước trước chưa đạt/.test(r.err), `${what} chạy riêng (không qua preflight) ⇒ tự chặn theo cờ giai đoạn`, r.ok ? 'KHÔNG chặn' : r.err.slice(0, 160))
  }
  await zeroDelta('cờ giai đoạn')
  // Lỗi NGAY GIỮA DISABLE và ENABLE trigger ⇒ rollback cả transaction (DDL trigger hoàn tác về 'O').
  const DIS = 'ALTER TABLE public.cms_programs DISABLE TRIGGER cms_programs_result_guard;'
  ok(H.migration.split(DIS).length === 2, 'định vị DISABLE đúng 1 chỗ')
  await failsWith(H.migration.split(DIS).join(`${DIS}\n  RAISE EXCEPTION 'qa127: lỗi giữa DISABLE / ENABLE';`), /qa127: lỗi giữa DISABLE \/ ENABLE/,
    'lỗi giữa DISABLE / ENABLE ⇒ rollback toàn bộ')
  // Lỗi SAU khi đã tắt trigger + ghi bậc (hậu kiểm hỏng) ⇒ rollback cả transaction (DDL trigger cũng hoàn tác).
  const sab = H.migration.split(`IS DISTINCT FROM '${H.ratesMd5}' THEN\n    RAISE EXCEPTION '127 hậu kiểm: md5 bảng mức`)
  ok(sab.length === 2, 'đột biến hậu kiểm định vị đúng 1 chỗ')
  await failsWith(sab.join(`IS DISTINCT FROM 'deadbeefdeadbeefdeadbeefdeadbeef' THEN\n    RAISE EXCEPTION '127 hậu kiểm: md5 bảng mức`), /127 hậu kiểm: md5 bảng mức/,
    'lỗi giữa chừng SAU DISABLE TRIGGER ⇒ rollback toàn bộ')

  section('3. Áp 127')
  const fpOthers = { other: await E.rowsMd5(`SELECT * FROM public.cms_programs WHERE id <> '${E.T11.id}'`), pp: await E.rowsMd5(`SELECT * FROM public.cms_program_products`),
    st: await E.rowsMd5(`SELECT * FROM public.cms_program_stores`), runs: await E.rowsMd5(`SELECT * FROM public.cms_sync_runs`), res: await E.rowsMd5(`SELECT * FROM public.cms_results`),
    tiersOther: await E.rowsMd5(`SELECT * FROM public.cms_program_tiers WHERE program_id <> '${E.T11.id}'`) }
  const pre127 = await E.snapshot()
  const ap = await settle(E.db.exec(H.migration))
  ok(ap.ok, '127 áp thành công', ap.err)
  const g1 = await E.prog(E.T11.id)
  const tiers1 = await E.all(`SELECT pp.product_id pid, t.tier_order o, t.qty_from f, t.qty_to t, t.amount_per_unit::text a FROM public.cms_program_tiers t
    JOIN public.cms_program_products pp ON pp.id = t.program_product_id WHERE t.program_id = $1 ORDER BY pp.product_id`, [E.T11.id])
  ok(tiers1.length === 17 && tiers1.every((t, i) => t.o === 1 && t.f === 1 && t.t === null && t.a === String(PIN_H.products.find((p) => p.product_id === t.pid).new_amount)),
    '17 SP × 1 bậc {1, từ 1, không giới hạn} đúng mức ghim')
  ok(g1.v === g0.v + 1 && g1.ptr === null && g1.ub === null && g1.status === 'active', 'config_version +1 đúng 1 lần · pointer NULL · updated_by NULL · active', JSON.stringify(g1))
  const fpAfter = { other: await E.rowsMd5(`SELECT * FROM public.cms_programs WHERE id <> '${E.T11.id}'`), pp: await E.rowsMd5(`SELECT * FROM public.cms_program_products`),
    st: await E.rowsMd5(`SELECT * FROM public.cms_program_stores`), runs: await E.rowsMd5(`SELECT * FROM public.cms_sync_runs`), res: await E.rowsMd5(`SELECT * FROM public.cms_results`),
    tiersOther: await E.rowsMd5(`SELECT * FROM public.cms_program_tiers WHERE program_id <> '${E.T11.id}'`) }
  ok(JSON.stringify(fpAfter) === JSON.stringify(fpOthers), 'SP (17 id giữ) / phạm vi / chương trình khác + QA / bậc khác / run / kết quả KHÔNG đổi (byte)')
  const post127 = await E.snapshot()
  ok(post127.n_all === pre127.n_all && post127.md5_all === pre127.md5_all, 'hàm + ACL public không đổi (n_all / md5_all)')
  ok((await E.ptrMode()) === 'O', "trigger pointer về đúng 'O'")
  const mk = await E.marker('127')
  const notes = mk ? JSON.parse(mk.notes) : null
  ok(mk?.name === 'cms_t11_flat_amounts' && notes?.program === E.T11.id && notes?.config_version?.from === g0.v && notes?.config_version?.to === g0.v + 1
    && notes?.tiers?.from === 51 && notes?.tiers?.to === 17 && notes?.rates_md5 === H.ratesMd5 && notes?.old_pointer === run0 && notes?.pointer_cleared === true,
    'marker 127 + notes (version / bậc / md5 mức / pointer cũ)', mk?.notes)
  { const r = await execFail(E.db, H.migration); ok(!r.ok && /đã có marker 127/.test(r.err), 'chạy lại 127 ⇒ dừng (đã có marker)') }
  let cs = await E.verify('127', pre127)
  ok(E.bad(cs).length === 0, 'VERIFY phase 127 không LỆCH (trừ mục môi trường)', E.show(cs))
  ok(cs.find((c) => c.id === 'v127-t11-pm')?.ok === false && cs.find((c) => c.id === 'v127-flat')?.ok === true && cs.find((c) => c.id === 'v127-resync')?.proven === false,
    'v127-flat ĐẠT · v127-resync CHƯA (pointer NULL) · v127-t11-pm đỏ có chủ đích (DB thử ≠ T11)')
  cs = await E.verify('126', pre127)
  ok(['phase-match', 'marker-127-absent', 'max-numeric'].every((id) => cs.find((c) => c.id === id)?.ok === false), 'checker 126 trên DB 127 ⇒ LỆCH phase-match / marker-127-absent / max-numeric')
  const hSuper = await E.header(U.super)
  ok(hSuper.run === null && RV.cmsResultState(hSuper) === 'config_reset' && RV.cmsNoRunText(hSuper) === RV.CMS_CONFIG_RESET_TEXT,
    'đọc kết quả (super, rpc_cms_result_header) ⇒ config_reset "Chưa có số liệu sau thay đổi cấu hình", không tiền cũ', RV.cmsResultState(hSuper))
  const hStaff = await E.header(E.SELLER_IDS[0])
  ok(hStaff.run === null, `đọc kết quả (dược sĩ) ⇒ không có run hiện hành (state ${RV.cmsResultState(hStaff)}) — không hiện tiền cũ`)

  section('4. Tính lại ngay theo cấu hình mới')
  const r1 = await E.sync(E.T11, E.T11_ROWS)
  const g2 = await E.prog(E.T11.id)
  const run1 = await E.one(`SELECT config_version v, status, published_at FROM public.cms_sync_runs WHERE id = $1`, [g2.ptr])
  ok(r1.status === 'published' && !!g2.ptr && g2.ptr !== run0 && run1.v === g1.v && run1.status === 'ok' && run1.published_at, 'run mới công bố đúng config_version mới, pointer → run mới', JSON.stringify(r1).slice(0, 160))
  const rate = (pid) => B(PIN_H.products.find((p) => p.product_id === pid).new_amount)
  const rs1 = await E.results(g2.ptr)
  ok(sameResults(rs1, oracle(E, (pid, q) => q * rate(pid))), 'tiền mới = oracle độc lập Q × mức từng cặp (Q = floor(ΣB / K))', `${rs1.length} cặp`)
  ok(JSON.stringify(await E.results(run0)) === JSON.stringify(rs0), 'kết quả run cũ giữ nguyên byte (không xoá / sửa)')
  cs = await E.verify('127', pre127, ['resync'])
  ok(E.bad(cs).length === 0 && cs.find((c) => c.id === 'v127-resync')?.proven === true, 'VERIFY 127 --require-proven=resync ĐẠT', E.show(cs))
  const hs2 = await E.header(U.super)
  ok(RV.cmsResultState(hs2) === 'ok', 'đọc kết quả sau tính lại ⇒ ok')

  section('5. Rollback 127')
  const preRb = await E.snapshot()
  const runsBeforeRb = await E.rowsMd5('SELECT * FROM public.cms_sync_runs')
  const rb = await settle(E.db.exec(H.rollback))
  ok(rb.ok, 'rollback 127 áp thành công', rb.err)
  const g3 = await E.prog(E.T11.id)
  ok((await E.tiersMd5(E.T11.id)).m === base.tiers.m, '51 bậc ghim khôi phục đúng byte')
  ok(g3.v === g1.v + 1 && g3.ptr === null, 'version TĂNG tiếp (không giảm) · pointer NULL (không khôi phục pointer cũ)', JSON.stringify(g3))
  ok((await E.marker('127')) === null && (await E.ptrMode()) === 'O', "marker 127 xoá · trigger 'O'")
  ok((await E.rowsMd5('SELECT * FROM public.cms_sync_runs')).m === runsBeforeRb.m, 'run / lịch sử giữ nguyên')
  const postRb = await E.snapshot()
  ok(postRb.md5_all === preRb.md5_all, 'hàm + ACL không đổi')
  { const r = await execFail(E.db, H.migration); ok(!r.ok && /config_version \d+ ≠ bản ghim/.test(r.err), 'áp lại CÙNG file sau rollback ⇒ dừng (version ≠ ghim)') }
  const H2 = buildCms127(await E.pinFromDb(E.T11.id))
  const ap2 = await settle(E.db.exec(H2.migration))
  const g4 = await E.prog(E.T11.id)
  ok(ap2.ok && g4.v === g3.v + 1 && g4.ptr === null, 'ghim mới ⇒ áp lại được, version tăng tiếp', ap2.err)
  // Có chỉnh sửa sau 127 (import bổ sung SP mới) ⇒ rollback dừng.
  const pr = await E.preview(E.T11.id, 'append')
  await E.commit(pr, 'append', [{ pid: E.pid(), k: '1', tiers: [{ order: 1, from: 1, to: null, amount: '1000' }] }])
  { const r = await execFail(E.db, H2.rollback); ok(!r.ok && /đã có chỉnh sửa sau 127/.test(r.err), 'rollback sau chỉnh sửa mới ⇒ dừng', r.ok ? 'KHÔNG dừng' : r.err.slice(0, 160)) }

  section('6. Dán CRLF (Studio) + guard thân lạ')
  const X = await env('crlf')
  const PIN_X = await X.pinFromDb(X.T11.id)
  const HX = buildCms127(PIN_X)
  await X.db.exec(`CREATE OR REPLACE FUNCTION public.cms__programs_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$ BEGIN RETURN NEW; END $$`)
  { const r = await execFail(X.db, HX.migration); ok(!r.ok && /thân hàm guard \(6\) KHÁC bản đã duyệt/.test(r.err), 'thân guard lạ ⇒ preflight dừng', r.ok ? 'KHÔNG dừng' : r.err.slice(0, 160)) }
  const g120 = SQL('120_cms_foundation.sql')
  const i = g120.indexOf('CREATE FUNCTION public.cms__programs_guard(')
  await X.db.exec(g120.slice(i, g120.indexOf('$$;', g120.indexOf('AS $$', i) + 5) + 3).replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'))
  const ax = await settle(X.db.exec(CRLF(HX.migration)))
  const gx = await X.prog(X.T11.id)
  ok(ax.ok && gx.ptr === null && (await X.tiersMd5(X.T11.id)).n === 17 && (await X.ptrMode()) === 'O', '127 dán CRLF ⇒ cùng kết quả LF (17 bậc, pointer NULL, trigger O)', ax.err)
  const rx = await settle(X.db.exec(CRLF(HX.rollback)))
  ok(rx.ok && (await X.tiersMd5(X.T11.id)).n === 51 && (await X.marker('127')) === null, 'rollback dán CRLF ⇒ 51 bậc, marker xoá', rx.err)
  // Chương trình đã chốt (không đảo được ⇒ làm cuối môi trường này). DB 123 chỉ cho vào 'locked' khi có payout khớp run hiện hành
  // (cms__programs_lock_guard), mà payout thật chỉ qua RPC chốt (policy real.ready = false) ⇒ trạng thái này KHÔNG dựng được bằng đường
  // hợp lệ; harness tắt TẠM guard 123 chỉ để dựng trạng thái, bật lại TRƯỚC khi chạy 127 (pin trigger đòi đủ 15 trigger đúng chế độ).
  await X.db.exec('ALTER TABLE public.cms_programs DISABLE TRIGGER cms_programs_lock_guard')
  await X.db.query(`UPDATE public.cms_programs SET status = 'locked', locked_at = now(), locked_by = $2 WHERE id = $1`, [X.T11.id, U.super])
  await X.db.exec('ALTER TABLE public.cms_programs ENABLE ALWAYS TRIGGER cms_programs_lock_guard')
  { const r = await execFail(X.db, buildCms127(await X.pinFromDb(X.T11.id)).migration); ok(!r.ok && /chương trình khác bản ghim \(status locked/.test(r.err), 'chương trình đã chốt ⇒ dừng', r.ok ? 'KHÔNG dừng' : r.err.slice(0, 160)) }

  if (PG15) {
    section('7. Race (PG15): giao dịch giữ khoá ⇒ 127 hết lock_timeout, 0 delta')
    const R = await env('race')
    const HR = buildCms127(await R.pinFromDb(R.T11.id))
    const r0 = { t: await R.tiersMd5(R.T11.id), g: await R.prog(R.T11.id) }
    const same = async (what) => { const t = await R.tiersMd5(R.T11.id), g = await R.prog(R.T11.id); ok(t.m === r0.t.m && g.v === r0.g.v && (await R.marker('127')) === null && (await R.ptrMode()) === 'O', `${what}: 0 delta`) }
    for (const [what, sql] of [['khoá dòng chương trình FOR UPDATE', `SELECT 1 FROM public.cms_programs WHERE id = '${R.T11.id}' FOR UPDATE`],
      ['ghi bảng run (ROW EXCLUSIVE)', 'LOCK TABLE public.cms_sync_runs IN ROW EXCLUSIVE MODE']]) {
      const c2 = await R.conn()
      await c2.query('BEGIN'); await c2.query(sql)
      const t0 = Date.now()
      const r = await execFail(R.db, HR.migration)
      ok(!r.ok && /lock timeout|55P03/i.test(r.err) && Date.now() - t0 >= 4000, `${what} ⇒ 127 dừng theo lock_timeout`, r.ok ? 'KHÔNG dừng' : r.err.slice(0, 120))
      await c2.query('ROLLBACK')
      await same(what)
    }
    // Cancel giữa DISABLE / ENABLE (pg_sleep chèn chỉ trong bản thử) ⇒ huỷ cả transaction, trigger 'O', 0 delta.
    const DIS = 'ALTER TABLE public.cms_programs DISABLE TRIGGER cms_programs_result_guard;'
    const cM = await R.conn()
    const pidM = (await cM.query('SELECT pg_backend_pid() p')).rows[0].p
    const cancelP = settle(cM.query(HR.migration.split(DIS).join(`${DIS}\n  PERFORM pg_sleep(5);`)))
    await sleep(1500)
    const cAdmin = await R.conn()
    await cAdmin.query('SELECT pg_cancel_backend($1)', [pidM])
    const rc = await cancelP
    await cM.query('ROLLBACK').catch(() => {})
    ok(!rc.ok && /cancel/i.test(rc.err), 'cancel khi trigger đang tắt ⇒ huỷ transaction', rc.ok ? 'KHÔNG huỷ' : rc.err.slice(0, 120))
    await same('cancel giữa DISABLE / ENABLE')
    // Thứ tự khoá chương trình → run (db-reviewer 127 P2-1): phiên giữ dòng chương trình rồi cần ghi bảng run KHÔNG deadlock với 127.
    const cX = await R.conn(), cY = await R.conn()
    await cX.query('BEGIN'); await cX.query(`SELECT 1 FROM public.cms_programs WHERE id = $1 FOR UPDATE`, [R.T11.id])
    const migP = settle(cY.query(HR.migration))
    await sleep(500)
    const xRun = await settle(cX.query('LOCK TABLE public.cms_sync_runs IN ROW EXCLUSIVE MODE'))
    await cX.query(xRun.ok ? 'COMMIT' : 'ROLLBACK')
    const ar = await migP
    ok(xRun.ok && ar.ok && (await R.tiersMd5(R.T11.id)).n === 17, 'phiên giữ dòng chương trình rồi ghi bảng run ⇒ không deadlock; 127 áp sau khi phiên kia xong',
      (xRun.err ?? '') + ' ' + (ar.err ?? ''))
    // Đồng thời thật: 127 đang giữ khoá (pg_sleep chèn sau LOCK, chỉ bản thử) — phiên khác mở run ⇒ CHỜ tới COMMIT rồi mở theo version MỚI.
    const R2 = await env('race2')
    const HR2 = buildCms127(await R2.pinFromDb(R2.T11.id))
    const LK = 'LOCK TABLE public.cms_program_stores, public.cms_payouts IN SHARE MODE;'
    ok(HR2.migration.split(LK).length === 2, 'định vị LOCK cuối đúng 1 chỗ')
    const cA = await R2.conn(), cB = await R2.conn()
    const mig = settle(cA.query(HR2.migration.split(LK).join(`${LK}\nSELECT pg_sleep(2);`)))
    await sleep(400)
    await cB.query('SET ROLE service_role')
    const t0 = Date.now()
    const ob = await settle(cB.query(`SELECT public.rpc_cms_sales_run_open($1, $2::jsonb) r`, [R2.T11.id, JSON.stringify({ source: 'operator' })]))
    const waited = Date.now() - t0
    await cB.query('RESET ROLE')
    const am = await mig
    const gv = await R2.prog(R2.T11.id)
    const ov = ob.ok ? await R2.one(`SELECT config_version v FROM public.cms_sync_runs WHERE program_id = $1 AND status = 'running'`, [R2.T11.id]) : null
    ok(am.ok && ob.ok && waited >= 1200 && ov?.v === gv.v, `mở run trong lúc 127 giữ khoá ⇒ chờ ${waited} ms, mở theo config_version mới`, am.err ?? ob.err)
  }
}

try { await main() } catch (e) { fail++; console.log(`  ✗ LỖI ${String(e?.stack ?? e).slice(0, 600)}`) }
finally {
  for (const c of closers.reverse()) { try { await c() } catch { /* đóng */ } }
  if (cluster) { try { await cluster.stop() } catch (e) { console.log(`  (cảnh báo dừng cluster: ${String(e?.message ?? e).slice(0, 80)})`) } }
}
console.log(`\nQA 127: ${pass} đạt / ${fail} lỗi`)
process.exitCode = fail ? 1 : 0
if (PG15) process.exit(fail ? 1 : 0)
