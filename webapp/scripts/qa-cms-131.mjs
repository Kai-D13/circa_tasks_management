// QA candidate migration 131 (F-A — sửa chương trình CMS có version; PM spec 17/11) trên chuỗi THẬT 120 → 126 + marker 127 + 130.
// PGlite (mặc định, Postgres 16 WASM); PG15 thật: `--pg15 <embedded-postgres-dir> <data-root>` (ACL default privileges kiểu Supabase,
// đua hai phiên, bench). KHÔNG chạm DB thật / nguồn thật / mạng.
//   §0 generator ↔ file · LF · thân nền 4 hàm thay + 13 hàm ghim = md5 trên DB sau 130
//   §1 áp 131: config_version / pointer không đổi; ACL ma trận; bảng mới RLS không grant; policy; tổng hàm; marker; chạy lại bị chặn
//   §2 REV01 quyền: super được; admin thường / SM / QLCH / staff / anon / service_role bị chặn ở RPC + bảng
//   §3 REV05 tiền: cùng nguồn B=25 · K10/100 ⇒ Q2/200 → K5 ⇒ Q5/500 → K20 ⇒ Q1/100 (tính lại cả kỳ, Q theo tổng không floor từng đơn);
//      che run trước sửa (mặc định NULL; staff đọc tường minh RUN_GONE; super đọc được); lưu trữ copied / reused đúng số / K / bậc
//   §4 REV04 lịch sử / retire: bỏ SP có dữ liệu ⇒ retire (RLS ẩn, snapshot / trùng / phạm vi bỏ), thêm lại ⇒ cùng dòng, không đếm đôi;
//      bỏ SP chưa có dữ liệu ⇒ xoá; lưu trữ bất biến; dọn run không xoá lưu trữ
//   §5 REV02 trạng thái: nháp / chốt / net / run đang chạy (BUSY, 0 delta) / cms_unit bỏ SP có dữ liệu / cms_unit đổi mức;
//      r2: bỏ SP (retire) rồi đổi returns_policy ⇒ CMS_RETURNS_POLICY_RETIRED_UNSUPPORTED (RPC 130 + UPDATE owner), 0 delta
//   §6 REV03 idempotency / stale / hết hạn / người khác / xác nhận / lý do / impact lỗi / lỗi giữa chừng ⇒ 0 delta
//   §7 REV07 phạm vi: đơn vị / loại / target / SP danh mục bị chặn; nạp thêm / nạp lại nháp cũ vẫn đúng
//   §8 rollback: dừng khi có revision committed; gỡ về nền (md5 / policy / cột) rồi áp lại được
//   §9 dán CRLF ≡ LF · §10 preflight dừng 0 delta · §11 (PG15) đua hai phiên (sửa × sửa / cùng key / sửa × mở run / r2: sửa × chốt
//      hai chiều) · §12 (PG15) bench. r2 (17/11 tối): §1 chạy khối VERIFY; §3 header bị che qua parser THẬT của app ⇒ câu config_reset;
//      §7 lưu trữ run khác version ⇒ 'unknown' (không gán đơn vị / bậc hiện hành)
//   r3 (PM audit cuối 17/11): §6b P1-01 preview ghim expected_run_id (A→A / A→B / NULL→NULL / NULL→B / thiếu trường / impact lệch run
//      + đối chứng âm bằng đột biến hàm tại chỗ); §6c P1-03 số đã công bố qua ĐƯỜNG ĐỌC THẬT (cmsLoadPublished + reader SQL cùng cột /
//      thứ tự + dự toán thật): run 0 / lỗi / khác chương trình / thiếu-lặp trang / purge / Σ lệch / sửa hai lần không run mới;
//      §11 (PG15) công bố run giữ khoá × lưu preview ⇒ chờ rồi STALE (+ đối chứng âm bỏ FOR SHARE); §12 P1-04 bỏ 82/83 và 1.999/2.000
//      SP có dữ liệu (retire) mỗi lời gọi < 8 s. CMS131_ONLY=r3 ⇒ chỉ §6b + §6c (vòng dev, KHÔNG phải gate).
//   npm i --no-save @electric-sql/pglite@0.2.17 ; node scripts/qa-cms-131.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'
import * as L from './lib-care-pglite.mjs'
import { buildCms131, CMS_131_FILE, CMS_131_ROLLBACK_FILE, CMS_131_NEW, CMS_131_REPLACED, CMS_131_ALL, CMS_131_FN_BEFORE, cmsFunctionBodies } from './gen-cms-131.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIG = path.join(HERE, '..', '..', 'supabase', 'migrations')
const SQL = (f) => fs.readFileSync(path.join(MIG, f), 'utf8')
const SQL_131 = fs.readFileSync(CMS_131_FILE, 'utf8')
const RB_131 = fs.readFileSync(CMS_131_ROLLBACK_FILE, 'utf8')
const jiti = createJiti(import.meta.url, { interopDefault: true, alias: { '@': path.join(HERE, '..') } })
const lib = (p) => jiti.import(path.join(HERE, '..', p))
const C = await lib('lib/cms/source/contract.ts')
const SS = await lib('lib/cms/salesSync.ts')
const FX = await lib('e2e/cmsFixtureRunner.ts')
const QR = await lib('e2e/cmsQaResults.ts')
const LA = await lib('lib/cms/lockAction.ts')
const CF = await lib('e2e/cmsContractFixture.ts')
const RV = await lib('lib/cms/resultView.ts')
const IM = await lib('lib/cms/revision/impact.ts')
const PUB = await lib('lib/cms/revision/published.ts')
const MD = await lib('lib/cms/revision/model.ts')
const { U, storeId, STORES, sha } = L

let pass = 0, fail = 0
const ok = (c, name, extra = '') => { if (c) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) } }
const section = (s) => console.log(`\n${s}`)
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, err: String(e?.message ?? e) }))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CRLF = (s) => s.split('\n').join('\r\n')
const code = (r) => (r.ok ? 'OK' : (/\bCMS_[A-Z0-9_]+\b/.exec(r.err)?.[0] ?? r.err.slice(0, 160)))
const PREVIEW = `SELECT public.rpc_cms_program_revision_preview($1::jsonb) r`
const PREVIEW_SIG = 'rpc_cms_program_revision_preview(jsonb)'
const T1 = (amount) => [{ order: 1, from: 1, to: null, amount: String(amount) }]
const uuid = () => globalThis.crypto.randomUUID()

// ── §0 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
section('0. Generator ↔ file · LF · md5 thân nền')
const GEN = buildCms131()
ok(GEN.migration === SQL_131 && GEN.rollback === RB_131, 'scripts/gen-cms-131.mjs sinh ĐÚNG byte 131 + rollback trên đĩa')
ok(!SQL_131.includes('\r') && !RB_131.includes('\r'), '131 + rollback giữ LF')
const CODE_131 = SQL_131.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
ok(!/DISABLE TRIGGER|session_replication_role/i.test(CODE_131) && !/current_result_run_id\s*=\s*NULL/i.test(CODE_131)
  && !/\bON DELETE CASCADE\b|\bCASCADE\b/i.test(CODE_131), '131 không DISABLE TRIGGER / session_replication_role / đặt pointer NULL / CASCADE')
ok(!/p_actor/.test(CODE_131), 'RPC 131 không nhận p_actor (quyền suy từ auth.uid() + is_super_admin())')

// ── backend ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const PG15 = process.argv[2] === '--pg15'
let PGlite = null, cluster = null, pgMod = null
const PG_PORT = 54357, PG_PASS = 'qa-local-only'
if (!PG15) {
  try { ({ PGlite } = await import('@electric-sql/pglite')) } catch { console.error('FAIL: thiếu @electric-sql/pglite — npm i --no-save @electric-sql/pglite@0.2.17'); process.exit(2) }
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
    cluster = new EmbeddedPostgres({ databaseDir: path.join(path.resolve(dataRoot), `pgdata-cms131-${Date.now()}`), user: 'postgres', password: PG_PASS,
      port: PG_PORT, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {}, onError: () => {} })
    await cluster.initialise(); await cluster.start()
    closers.unshift(() => cluster.stop())
  }
  const name = `rpgcms131_${tag.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_${++dbSeq}`
  const admin = await pgConn('postgres')
  await admin.query(`CREATE DATABASE ${name} ENCODING 'UTF8' TEMPLATE template0`)
  const c = await pgConn(name)
  const wrap = { exec: (sql) => c.query(sql).then((r) => (Array.isArray(r) ? r : [r])), query: (sql, p) => c.query(sql, p), close: () => c.end() }
  const rolesExist = (await c.query(`SELECT count(*)::int n FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')`)).rows[0].n === 3
  const ROLES = 'CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;'
  function FakePGlite() { return rolesExist ? { ...wrap, exec: (sql) => wrap.exec(sql.split(ROLES).join('')) } : wrap }
  await L.freshDb(FakePGlite)
  return { db: wrap, dbName: name }
}

/** DB nền 130 (120 → 126 thật + marker 127 + 130 thật) — chương trình thật có run công bố. apply ⇒ áp 131. */
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
  await db.query(`INSERT INTO public.cms_product_master (product_id, product_name, is_active, source_updated_at)
    SELECT g::text, 'SP giả ' || g, true, now() FROM generate_series(948001, ${tag === 'bench' ? 953500 : 948400}) g`)
  await db.query(`INSERT INTO public.cms_qa_access (user_id, granted_by, expires_at) VALUES ($1, 'qa-script:cms-131', now() + interval '6 hours')`, [U.super])
  let pidNext = 948001, seqf = 0, lineSeq = 0
  const pid = () => String(pidNext++)
  const day = async (n) => { const t = (await one(`SELECT public.cms__vn_today()::text d`)).d; const d = new Date(`${t}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
  const prodPayload = (p) => ({ product_id: p.pid, gmv_basis: p.basis ?? 'none', target_gmv: p.target ?? null, base_quantity_cms: p.k ?? '1', tiers: p.tiers ?? T1(100),
    unit_cms: p.unit ?? 'hộp', advice_text: p.advice ?? `Tư vấn QA ${p.pid}`, name_snapshot: `SP giả ${p.pid}`, image_url_snapshot: null, price_snapshot: null })
  async function preview(id, mode = 'replace') {
    const fileSha = sha(`f131-${tag}-${++seqf}`), digest = sha(`d131-${tag}-${seqf}`)
    const run = (await svc(`SELECT public.rpc_cms_import_preview_save($1::jsonb) id`, [JSON.stringify({ program_id: id, mode, file_name: 'qa.xlsx', file_sha256: fileSha,
      file_bytes: 10, actor: U.super, stats: { rowsTotal: 1, rowsOk: 1, rowsRejected: 0, warnings: 0, productsOk: 1, productsRejected: 0 }, result: { digest } })])).rows[0].id
    return { run, fileSha, digest }
  }
  const commit = async (pr, mode, products, catalogTarget = null) => (await svc(`SELECT public.rpc_cms_import_commit($1, $2, $3, $4::jsonb, $5) r`,
    [pr.run, pr.fileSha, pr.digest, JSON.stringify({ mode, catalog_target: catalogTarget, products: products.map(prodPayload) }), U.super])).rows[0].r
  async function makeProgram({ name, isTest = false, products, activate = true, v2 = null, dates = null, catalogTarget = null, storeCount = 2 }) {
    const payload = { actor: U.super, name, start_date: dates?.[0] ?? await day(-7), end_date: dates?.[1] ?? await day(22), scope: 'stores',
      store_ids: Array.from({ length: storeCount }, (_, i) => storeId(i + 1)), is_test: isTest, ...(v2 ? { quantity_basis: v2 } : {}) }
    const id = (await svc(`SELECT public.${v2 ? 'rpc_cms_program_save_v2' : 'rpc_cms_program_save'}($1::jsonb) id`, [JSON.stringify(payload)])).rows[0].id
    if (products) await commit(await preview(id), 'replace', products, catalogTarget)
    if (activate) await svc(`SELECT public.rpc_cms_program_activate($1, $2)`, [id, U.super])
    const p = await one(`SELECT start_date::text s, end_date::text e FROM public.cms_programs WHERE id = $1`, [id])
    return { id, products, start: p.s, end: p.e, isTest }
  }
  const SELLERS = [STORES[0].assigneeEmails[0], STORES[0].assigneeEmails[1], STORES[1].assigneeEmails[0]]
  // Bench: đủ 25 nhà thuốc × 2 dược sĩ của fixture (50 người bán).
  const SELLERS_ALL = STORES.flatMap((x) => x.assigneeEmails)
  function rows(p, specs) {
    const t0 = Date.parse(`${p.start}T01:00:00Z`)
    return specs.map((sp) => {
      const id = ++lineSeq
      const at = new Date(t0 + id * 1000).toISOString()
      const r = { order_line_id: String(948000000 + id), order_id: `O${id}`, order_code: `QA-${id}`, product_id: sp.pid, seller_email: sp.email ?? SELLERS[sp.s], pos_code: 'QAOS01',
        order_type: 'OFFLINE', order_status: 'COMPLETED', completed_at: at, quantity_raw: sp.q ?? '1', uom_raw: sp.uom ?? 'Hộp', base_quantity: String(sp.base), gmv_amount: sp.gmv ?? '100000', source_updated_at: at }
      if (!C.normalizeSalesRow(r).ok) throw new Error('dòng giả lỗi')
      return r
    })
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
  const sync = (p, rws) => SS.runCmsSalesSync(syncDeps(rws), p.id, { dryRun: false, source: p.isTest ? 'qa' : 'cron', sourceCapture: true })
  // Run hợp đồng (cms_unit / net): worker TS + provider fixture (như qa-cms-130 §11).
  const syncContract = (p, rws) => SS.runCmsSalesSync({ ...syncDeps([]), contractProvider: CF.createCmsContractFixtureProvider({ sales: rws, returns: [] }) }, p.id,
    { dryRun: false, source: 'qa', sourceCapture: true, calcFlags: { modes: true, returns: true } })
  const prog = (id) => one(`SELECT status, config_version v, current_result_run_id::text ptr FROM public.cms_programs WHERE id = $1`, [id])
  // RPC dưới vai trò authenticated (JWT sub) — trả r hoặc { err: mã }.
  const asU = async (uid, sql, params = []) => {
    const r = await settle(L.as(db, uid, () => db.query(sql, params), 'authenticated'))
    return r.ok ? r.v.rows[0]?.r : { err: code(r) }
  }
  const asRole = async (role, uid, sql, params = []) => {
    const r = await settle(L.as(db, uid, () => db.query(sql, params), role))
    return r.ok ? r.v.rows[0] : { err: code(r) }
  }
  const mapping = async () => (await one(`SELECT public.cms__mapping_fp() m`)).m
  // r3 (PM P1-01): dự toán 'ok' mang published_run_id = run app đã ghim (expected_run_id).
  const impact = (cv, run = null, o = {}) => ({ status: 'ok', from_config_version: cv,
    totals: { before_vnd: '0', after_vnd: '0', delta_vnd: '0', people_up: 0, people_down: 0, published_vnd: null, published_run_id: run }, ...o })
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
  /** Thân preview: expected_run_id mặc định = pointer đọc lúc này (o.expectedRun ghi đè, kể cả null; o.omitExpected bỏ trường;
   *  o.rawExpected gửi giá trị thô); impact mặc định tham chiếu cùng run (o.impactRun ghi đè). */
  async function revBody(p, products, o = {}) {
    const st = await prog(p.id)
    const xrun = has(o, 'expectedRun') ? o.expectedRun : (st.ptr ?? null)
    const body = { program_id: p.id, file_sha256: sha(`rev-${tag}-${++seqf}`), catalog_target: o.catalogTarget ?? null, products: products.map(prodPayload),
      impact: o.impact ?? impact(o.cv ?? st.v, has(o, 'impactRun') ? o.impactRun : xrun), source: o.source ?? { mapping_fp: await mapping(), rows_read: 0 } }
    if (has(o, 'rawExpected')) body.expected_run_id = o.rawExpected
    else if (!o.omitExpected) body.expected_run_id = xrun
    return body
  }
  /** Preview revision (super mặc định): products = mô tả SP (prodPayload). */
  async function revPreview(p, products, o = {}) {
    const body = await revBody(p, products, o)
    return asU(o.uid ?? U.super, `SELECT public.rpc_cms_program_revision_preview($1::jsonb) r`, [JSON.stringify(body)])
  }
  async function revCommit(pv, o = {}) {
    const removed = o.removed ?? pv.diff?.removed ?? []
    return asU(o.uid ?? U.super, `SELECT public.rpc_cms_program_revision_commit($1, $2, $3, $4, $5, $6::jsonb) r`,
      [pv.revision_id, o.cv ?? pv.from_config_version, o.digest ?? pv.payload_digest, o.key ?? uuid(), o.reason ?? 'QA sửa K / mức theo xác nhận admin',
        JSON.stringify(o.ack ?? { whole_period: true, may_decrease: true, removed })])
  }
  // Ảnh chụp đủ để kiểm 0 delta.
  const snap = async (id) => ({
    p: await one(`SELECT config_version v, current_result_run_id::text ptr, status FROM public.cms_programs WHERE id = $1`, [id]),
    cfg: (await one(`SELECT public.cms__revision_config($1)::text c`, [id]).catch(() => ({ c: null }))).c,
    pp: (await one(`SELECT count(*)::int n, string_agg(id::text || ':' || base_quantity_cms::text || ':' || COALESCE(retired_at::text, '-'), ',' ORDER BY id) s FROM public.cms_program_products WHERE program_id = $1`, [id])),
    rev: (await one(`SELECT count(*) FILTER (WHERE status = 'committed')::int c, count(*)::int n FROM public.cms_program_revisions WHERE program_id = $1`, [id]).catch(() => null)),
    arc: (await one(`SELECT count(*)::int n FROM public.cms_program_revision_results WHERE program_id = $1`, [id]).catch(() => null)),
  })

  // Trước 131: chương trình thật có run công bố (K10 · mức 100 · B 7 + 8 + 10 = 25 ⇒ Q2 · 200đ).
  const pa = pid(), pb = pid()
  const LIVE = await makeProgram({ name: 'QA thật trước 131', products: [{ pid: pa, k: '10' }, { pid: pb, k: '1' }] })
  const LIVE_ROWS = rows(LIVE, [{ pid: pa, s: 0, base: 7 }, { pid: pa, s: 0, base: 8 }, { pid: pa, s: 0, base: 10 }, { pid: pb, s: 1, base: 3 }])
  const r0 = await sync(LIVE, LIVE_ROWS)
  if (r0.status !== 'published') throw new Error('nền: đồng bộ trước 131 không công bố ' + JSON.stringify(r0).slice(0, 200))
  if (before) await before({ db, one, all, svc })
  const progsBefore = await all(`SELECT id::text, config_version, current_result_run_id::text ptr, status FROM public.cms_programs ORDER BY id`)
  let applied = null
  if (apply) applied = await settle(db.exec(crlf ? CRLF(SQL_131) : SQL_131))
  return { db, dbName, one, all, svc, rpc, sync, syncDeps, syncContract, rows, prog, pid, preview, commit, makeProgram, LIVE, LIVE_ROWS, pa, pb, progsBefore, applied, day, SELLERS_ALL,
    asU, asRole, mapping, impact, revBody, revPreview, revCommit, snap, prodPayload }
}

/** Đột biến tại chỗ một hàm trên DB thử (đối chứng âm): mỗi cặp [từ, thành] phải khớp ĐÚNG MỘT chỗ trong pg_get_functiondef;
 *  CREATE OR REPLACE (giữ ACL); trả hàm khôi phục nguyên văn. */
async function mutateFn(E, sig, pairs) {
  const def = (await E.one(`SELECT pg_get_functiondef(to_regprocedure($1)) d`, [`public.${sig}`])).d
  let m = def
  for (const [from, to] of pairs) {
    const n = m.split(from).length - 1
    if (n !== 1) throw new Error(`đột biến ${sig}: ${n} chỗ khớp (cần đúng 1) — ${from.slice(0, 60)}`)
    m = m.split(from).join(to)
  }
  await E.db.exec(m)
  return async () => { await E.db.exec(def) }
}

const sigs = CMS_131_ALL.map((x) => x.sig)
const aclMatrix = async (E) => E.all(`SELECT p.oid::regprocedure::text sig, has_function_privilege('anon', p.oid, 'EXECUTE') a,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') u, has_function_privilege('service_role', p.oid, 'EXECUTE') s, p.prosecdef d,
  p.proconfig cfg, (SELECT count(*)::int FROM aclexplode(p.proacl) x WHERE x.grantee = 'dashboard_qa'::regrole) dq
  FROM pg_proc p WHERE p.oid IN (SELECT to_regprocedure('public.' || s) FROM unnest($1::text[]) s)`, [sigs])
const cmsFnCount = async (E) => Number((await E.one(`SELECT count(*)::int n FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND (proname LIKE 'cms\\_%' OR proname LIKE 'rpc\\_cms\\_%')`)).n)
const header = (E, uid, id) => E.asU(uid, `SELECT public.rpc_cms_result_header($1) r`, [id])
const rowsOf = (E, uid, id, run = null) => E.asU(uid, `SELECT public.rpc_cms_result_rows($1, $2) r`, [id, run])
const resultQ = async (E, run, pidStr) => E.one(`SELECT sum(cms_quantity)::int q, sum(amount_vnd)::int a, min(per_unit)::text k FROM public.cms_results WHERE run_id = $1 AND product_id = $2`, [run, pidStr])

async function main() {
  if (PG15 && process.env.CMS131_ONLY === 'bench') { section('12. Bench PG15 (CHỈ bench)'); await benchSection(); return }
  // Vòng dev r3 (không phải gate): chỉ §6b + §6c. Gate chạy đủ mọi mục.
  if (process.env.CMS131_ONLY === 'r3') { await pinSection(); await publishedSection(); return }
  // ── §0 nền ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const B = await env('base', { apply: false })
  const md5Base = await B.all(`SELECT p.proname n, md5(replace(p.prosrc, E'\\r', '')) m FROM pg_proc p WHERE p.oid IN (SELECT to_regprocedure('public.' || s) FROM unnest($1::text[]) s)`,
    [CMS_131_REPLACED.map((x) => x.sig)])
  ok(CMS_131_REPLACED.every((x) => md5Base.find((r) => r.n === x.name)?.m === x.base), '4 thân hàm thay trên DB sau 130 = md5 nền ghim (preflight + rollback)',
    JSON.stringify(md5Base))
  const pinned = [...SQL_131.matchAll(/to_regprocedure\('public\.([^']+)'\)\) IS DISTINCT FROM '([0-9a-f]{32})'/g)].slice(0, 17)
  const pinBad = []
  for (const [, sig, m] of pinned) { const r = await B.one(`SELECT md5(replace(prosrc, E'\\r', '')) m FROM pg_proc WHERE oid = to_regprocedure($1)`, [`public.${sig}`]); if (r?.m !== m) pinBad.push(sig) }
  ok(pinned.length === 17 && pinBad.length === 0, '17 ghim preflight (4 thay + 13 guard / helper) = md5 thật trên DB nền 130', pinBad.join(' '))

  // ── §1 ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section(`1. Áp 131 trên nền 130 (${PG15 ? 'PostgreSQL 15 nhúng' : 'PGlite'})`)
  const E = await env('main')
  const ver = await E.one(`SELECT current_setting('server_version_num')::int n, current_setting('server_version') v`)
  console.log(`  · backend: PostgreSQL ${ver.v}${PG15 ? ' (embedded, 127.0.0.1)' : ' (PGlite WASM)'}`)
  if (PG15) ok(ver.n >= 150000 && ver.n < 160000, `PostgreSQL 15 thật (${ver.v})`)
  ok(E.applied.ok, 'áp 131 thành công', E.applied.err)
  const after = await E.all(`SELECT id::text, config_version, current_result_run_id::text ptr, status FROM public.cms_programs ORDER BY id`)
  ok(JSON.stringify(after) === JSON.stringify(E.progsBefore), 'config_version / pointer / trạng thái mọi chương trình KHÔNG đổi')
  const acl = await aclMatrix(E)
  const aclBad = CMS_131_ALL.filter((x) => { const r = acl.find((a) => a.sig.startsWith(`${x.name}(`)); return !r || r.a || r.u !== (x.grant === 'authenticated:EXECUTE') || r.s !== (x.grant === 'service_role:EXECUTE') || !r.d || !(r.cfg ?? []).includes('search_path=public') || r.dq !== 0 })
  ok(acl.length === CMS_131_ALL.length && aclBad.length === 0, `ACL ${CMS_131_ALL.length} hàm (${CMS_131_NEW.length} mới + ${CMS_131_REPLACED.length} thay) đúng ma trận: anon 0 · authenticated 6 RPC · service_role chỉ capabilities · SECDEF + search_path · default privileges (dashboard_qa) thu hồi`, aclBad.map((x) => x.name).join(' '))
  const tbl = await E.all(`SELECT c.relname, c.relrowsecurity rls, (SELECT count(*)::int FROM pg_policy WHERE polrelid = c.oid) pol,
    has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE') a, has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE') u,
    has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE') s, (SELECT count(*)::int FROM aclexplode(c.relacl) x WHERE x.grantee <> c.relowner) g
    FROM pg_class c WHERE c.oid IN ('public.cms_program_revisions'::regclass, 'public.cms_program_revision_results'::regclass) ORDER BY 1`)
  ok(tbl.length === 2 && tbl.every((t) => t.rls && t.pol === 0 && !t.a && !t.u && !t.s && t.g === 0), '2 bảng mới: RLS bật, 0 policy, 0 grant ngoài owner (anon / authenticated / service_role không đọc / ghi)', JSON.stringify(tbl))
  const pol = await E.one(`SELECT pg_get_expr(polqual, polrelid) q FROM pg_policy WHERE polrelid = 'public.cms_program_products'::regclass`)
  ok(pol.q === '((retired_at IS NULL) AND (program_id = ANY (( SELECT cms_readable_program_ids() AS cms_readable_program_ids)::uuid[])))', 'policy đọc SP = nền 120 + retired_at IS NULL (cùng bảng)', pol.q)
  ok(await cmsFnCount(E) === CMS_131_FN_BEFORE + CMS_131_NEW.length, `tổng hàm CMS = ${CMS_131_FN_BEFORE} + ${CMS_131_NEW.length}`)
  const trg = await E.all(`SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid IN ('public.cms_program_revisions'::regclass, 'public.cms_program_revision_results'::regclass) AND NOT tgisinternal ORDER BY 1`)
  ok(trg.length === 4 && trg.every((t) => t.tgenabled === 'A'), '4 trigger bất biến ENABLE ALWAYS')
  const pgT = await E.all(`SELECT t.tgname, t.tgenabled, p.proname FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid WHERE t.tgrelid = 'public.cms_programs'::regclass AND t.tgname = 'cms_revision_policy_guard'`)
  ok(pgT.length === 1 && pgT[0].tgenabled === 'A' && pgT[0].proname === 'cms__revision_policy_guard', 'trigger cms_revision_policy_guard trên cms_programs ENABLE ALWAYS (r2 — db-reviewer P1-1)', JSON.stringify(pgT))
  // Khối VERIFY cuối file (chú thích): chạy từng câu NGUYÊN VĂN (owner) ⇒ không lỗi; kỳ vọng V0 / V2 / V4 / V6 / V8.
  const vq = verifyQueries(SQL_131)
  const vr = {}
  for (const [k, qs] of Object.entries(vq)) {
    vr[k] = []
    for (const q of qs) { const r = await settle(E.all(q)); vr[k].push(r.ok ? r.v : { err: r.err.slice(0, 160) }) }
  }
  const vErr = Object.entries(vr).filter(([, a]) => a.some((x) => x?.err)).map(([k]) => k)
  const v0 = vr.V0?.[0]?.[0], v2 = vr.V2?.[0]?.[0], v4 = vr.V4?.[0]?.[0]
  ok(vErr.length === 0 && Object.keys(vq).join(',') === 'V0,V1,V2,V3,V4,V5,V6,V8' && Number(v0?.n) === E.progsBefore.length
    && Number(v2?.n) === CMS_131_ALL.length && Number(v2?.anon_x) === 0 && Number(v2?.auth_x) === 6 && Number(v2?.svc_x) === 1
    && Number(v4?.revisions) === 0 && Number(v4?.archive) === 0 && Number(v4?.retired) === 0
    && vr.V6?.[1]?.length === 5 && vr.V6[1].every((x) => x.tgenabled === 'A') && Number(vr.V8?.[0]?.[0]?.count) === 0,
    `khối VERIFY chạy được nguyên văn: V0 n = ${E.progsBefore.length} · V2 n = ${CMS_131_ALL.length} / anon 0 / auth 6 / svc 1 · V4 0 / 0 / 0 · V6 5 trigger 'A' · V8 0`,
    JSON.stringify({ keys: Object.keys(vq), vErr, v0, v2, v4, v6: vr.V6?.[1], v8: vr.V8 }).slice(0, 700))
  const mk = await E.one(`SELECT name, notes FROM public.app_migrations WHERE version = '131'`)
  ok(mk?.name === 'cms_program_revision' && JSON.parse(mk.notes).new_functions === CMS_131_NEW.length, 'marker 131 + notes JSON')
  const caps = await E.rpc(`SELECT public.rpc_cms_revision_capabilities() r`, [])
  ok(caps.version === 'cms-revision-v1' && caps.ok === true && caps.rpcs.length === 6, 'rpc_cms_revision_capabilities (service_role) = cms-revision-v1, ok', JSON.stringify(caps))
  const again = await settle(E.db.exec(SQL_131))
  ok(!again.ok && /đã có marker 131/.test(again.err), 'chạy lại 131 bị chặn (marker)', again.err?.slice(0, 120))
  await E.db.exec('ROLLBACK').catch(() => {})

  await permSection(E)
  await moneySection(E)
  await historySection(E)
  await stateSection()
  await idemSection()
  await pinSection()
  await publishedSection()
  await scopeSection()
  await rollbackSection()
  await crlfSection()
  await preflightSection()
  if (PG15) { await raceSection(); await benchSection() }
}

// ── §2 REV01 quyền ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function permSection(E) {
  section('2. REV01 quyền (RPC + bảng)')
  const P = E.LIVE
  const prods = [{ pid: E.pa, k: '5' }, { pid: E.pb, k: '1' }]
  for (const [who, uid] of [['admin thường (Marketing)', U.mkt], ['SM', U.sm], ['QLCH', U.qlch1], ['staff', U.A]]) {
    const pv = await E.revPreview(P, prods, { uid })
    const hist = await E.asU(uid, `SELECT public.rpc_cms_program_revisions($1) r`, [P.id])
    ok(pv?.err === 'CMS_REVISION_FORBIDDEN' && hist?.err === 'CMS_REVISION_FORBIDDEN', `${who}: preview / lịch sử ⇒ CMS_REVISION_FORBIDDEN`, JSON.stringify({ pv, hist }))
  }
  const anon = await E.asRole('anon', null, `SELECT public.rpc_cms_program_revision_preview('{}'::jsonb) r`)
  const svcPv = await E.asRole('service_role', null, `SELECT public.rpc_cms_program_revision_preview('{}'::jsonb) r`)
  const svcCm = await E.asRole('service_role', null, `SELECT public.rpc_cms_program_revision_commit(gen_random_uuid(), 1, repeat('a', 64), gen_random_uuid(), 'x', '{}'::jsonb) r`)
  const authCaps = await E.asRole('authenticated', U.super, `SELECT public.rpc_cms_revision_capabilities() r`)
  ok(/permission denied/.test(anon.err) && /permission denied/.test(svcPv.err) && /permission denied/.test(svcCm.err) && /permission denied/.test(authCaps.err),
    'anon / service_role không EXECUTE preview / commit; authenticated không EXECUTE capabilities', JSON.stringify([anon, svcPv, svcCm, authCaps]))
  const direct = []
  for (const [role, uid] of [['authenticated', U.super], ['service_role', null], ['anon', null]]) {
    direct.push(await E.asRole(role, uid, `SELECT count(*) n FROM public.cms_program_revisions`))
    direct.push(await E.asRole(role, uid, `INSERT INTO public.cms_program_revision_results (revision_id) VALUES (gen_random_uuid())`))
  }
  ok(direct.every((d) => /permission denied/.test(d.err ?? '')), 'đọc / ghi trực tiếp 2 bảng mới bị từ chối ở mọi vai trò client (kể cả super, service_role)', JSON.stringify(direct))
  const pvOk = await E.revPreview(P, prods)
  ok(pvOk?.revision_id && pvOk.diff.change === 1 && pvOk.diff.keep === 1 && pvOk.diff.remove === 0, 'super: preview được (diff 1 đổi · 1 giữ)', JSON.stringify(pvOk))
  const readers = []
  for (const uid of [U.mkt, U.sm, U.qlch1, U.A]) {
    readers.push(await E.asU(uid, `SELECT public.rpc_cms_program_revision($1) r`, [pvOk.revision_id]))
    readers.push(await E.asU(uid, `SELECT public.rpc_cms_program_revision_archive($1, 0, 10) r`, [pvOk.revision_id]))
  }
  ok(readers.every((x) => x?.err === 'CMS_REVISION_FORBIDDEN'), 'admin thường / SM / QLCH / staff: chi tiết + số trước sửa (tên, tiền) ⇒ CMS_REVISION_FORBIDDEN (r2)', JSON.stringify(readers))
  const foreign = await E.revCommit(pvOk, { uid: U.mkt })
  ok(foreign?.err === 'CMS_REVISION_FORBIDDEN', 'admin thường commit preview của super ⇒ FORBIDDEN', JSON.stringify(foreign))
  const st = await E.asU(U.A, `SELECT public.rpc_cms_program_revision_state($1) r`, [P.id])
  const stOut = await E.asU(U.staffFs, `SELECT public.rpc_cms_program_revision_state($1) r`, [P.id])
  ok(st?.revised === false && st.masked === false && stOut?.err === 'CMS_RESULT_FORBIDDEN', 'state: staff đọc được chương trình ⇒ có cờ; ngoài phạm vi ⇒ FORBIDDEN', JSON.stringify({ st, stOut }))
}

// ── §3 REV05 tiền ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function moneySection(E) {
  section('3. REV05 tiền trên cùng nguồn + che run trước sửa + lưu trữ')
  const P = E.LIVE
  const run0 = (await E.prog(P.id)).ptr
  const q0 = await resultQ(E, run0, E.pa)
  ok(q0.q === 2 && q0.a === 200 && q0.k === '10', 'nền: B 7 + 8 + 10 = 25 · K10 · mức 100 ⇒ Q2 · 200đ (Q theo TỔNG, không floor từng đơn = 1)', JSON.stringify(q0))
  // K10 → K5.
  const s0 = await E.snap(P.id)
  const pv = await E.revPreview(P, [{ pid: E.pa, k: '5' }, { pid: E.pb, k: '1' }])
  const cm = await E.revCommit(pv)
  const s1 = await E.snap(P.id)
  ok(cm?.already === false && cm.to_config_version === s0.p.v + 1 && s1.p.v === s0.p.v + 1 && s1.p.ptr === s0.p.ptr && cm.archive_mode === 'copied' && cm.archive_rows === 2,
    'commit K10 → K5: config_version +1, pointer giữ, lưu trữ copied 2 dòng', JSON.stringify({ cm, s0: s0.p, s1: s1.p }))
  const hStaff = await header(E, U.A, P.id)
  const hSuper = await header(E, U.super, P.id)
  const oldStaff = await rowsOf(E, U.A, P.id, run0)
  const oldSuper = await rowsOf(E, U.super, P.id, run0)
  const stM = await E.asU(U.A, `SELECT public.rpc_cms_program_revision_state($1) r`, [P.id])
  ok(hStaff?.run === null && hSuper?.run === null && oldStaff?.err === 'CMS_RESULT_RUN_GONE' && oldSuper?.results?.length === 2 && stM?.masked === true,
    'sau commit: header mặc định run = NULL (staff + super), staff đọc tường minh run cũ ⇒ RUN_GONE, super đọc được bản trước sửa; state.masked',
    JSON.stringify({ hs: hStaff?.run, hsu: hSuper?.run, oldStaff, n: oldSuper?.results?.length, stM }))
  // r2 (PM audit P0-1): header DB sau che đi qua parser / câu chữ THẬT của app (resultView.ts — không đổi so với 13dd40e) cho staff + SM.
  const hSm = await header(E, U.sm, P.id)
  const txt = [hStaff, hSm].map((h) => { try { const d = RV.parseCmsResultHeader(h, 1); return { st: RV.cmsResultState(d), t: RV.cmsNoRunText(d) } } catch (e) { return { err: String(e.message) } } })
  ok(hSm?.run === null && txt.every((x) => x.st === 'config_reset' && x.t === RV.CMS_CONFIG_RESET_TEXT),
    'staff + SM sau sửa: header DB → parseCmsResultHeader / cmsNoRunText thật ⇒ "Chưa có số liệu sau thay đổi cấu hình — hệ thống sẽ tính lại ở lượt tiếp theo", không số cũ (r2)',
    JSON.stringify({ txt, la: hStaff?.last_attempt?.status, smRun: hSm?.run }))
  const arc = await E.asU(U.super, `SELECT public.rpc_cms_program_revision_archive($1, 0, 100) r`, [cm.revision_id])
  const a0 = arc?.rows?.find((r) => r.product_id === E.pa)
  ok(arc?.mode === 'copied' && arc.total === 2 && a0?.cms_quantity === '2' && a0.amount_vnd === '200' && a0.per_unit === '10' && a0.config_basis === 'exact'
    && a0.unit_cms === 'hộp' && JSON.stringify(a0.tiers) === JSON.stringify([{ to: null, from: 1, order: 1, amount: '100' }]) && a0.full_name,
    'lưu trữ: số trước sửa Q2 · 200đ · K10 · đơn vị / bậc của run (exact) + tên dược sĩ', JSON.stringify(arc).slice(0, 400))
  const r1 = await E.sync(P, E.LIVE_ROWS)
  const run1 = (await E.prog(P.id)).ptr
  const q1 = await resultQ(E, run1, E.pa)
  const st1 = await E.asU(U.A, `SELECT public.rpc_cms_program_revision_state($1) r`, [P.id])
  const h1 = await header(E, U.A, P.id)
  ok(r1.status === 'published' && run1 !== run0 && q1.q === 5 && q1.a === 500 && q1.k === '5' && st1?.masked === false && h1?.run?.id === run1,
    'lượt đồng bộ kế tiếp (cùng nguồn): K5 ⇒ Q5 · 500đ; pointer mới, hết che', JSON.stringify({ r1: r1.status, q1, st1, h1: h1?.run?.id }))
  // K5 → K20 (giảm — được phép sau xác nhận).
  const pv2 = await E.revPreview(P, [{ pid: E.pa, k: '20' }, { pid: E.pb, k: '1' }])
  const cm2 = await E.revCommit(pv2)
  await E.sync(P, E.LIVE_ROWS)
  const q2 = await resultQ(E, (await E.prog(P.id)).ptr, E.pa)
  const arc2 = await E.asU(U.super, `SELECT public.rpc_cms_program_revision_archive($1, 0, 100) r`, [cm2.revision_id])
  ok(cm2?.archive_mode === 'copied' && q2.q === 1 && q2.a === 100 && arc2?.rows?.find((r) => r.product_id === E.pa)?.amount_vnd === '500',
    'K5 → K20 (giảm tiền, không ép ≥ cũ): Q1 · 100đ; lưu trữ lần 2 giữ 500đ của run K5', JSON.stringify({ cm2, q2 }))
  // Hai lần sửa liên tiếp không có run giữa ⇒ lần 2 dùng lại lưu trữ (reused), không chép lại.
  const pv3 = await E.revPreview(P, [{ pid: E.pa, k: '20', tiers: T1(150) }, { pid: E.pb, k: '1' }])
  const cm3 = await E.revCommit(pv3)
  const pv4 = await E.revPreview(P, [{ pid: E.pa, k: '20', tiers: T1(100) }, { pid: E.pb, k: '1' }])
  const cm4 = await E.revCommit(pv4)
  const arc4 = await E.asU(U.super, `SELECT public.rpc_cms_program_revision_archive($1, 0, 100) r`, [cm4.revision_id])
  ok(cm3?.archive_mode === 'copied' && cm4?.archive_mode === 'reused' && arc4?.mode === 'reused' && arc4.rows.length === 2
    && arc4.rows.find((r) => r.product_id === E.pa)?.amount_vnd === '100', 'hai lần sửa liền (không run giữa): lần 2 reused — đọc đúng bản chép của run đang hiển thị', JSON.stringify({ cm3, cm4, n: arc4?.rows?.length }))
  const hist = await E.asU(U.super, `SELECT public.rpc_cms_program_revisions($1) r`, [P.id])
  const det = await E.asU(U.super, `SELECT public.rpc_cms_program_revision($1) r`, [cm.revision_id])
  ok(Array.isArray(hist) && hist.length === 4 && hist[0].to_config_version > hist[3].to_config_version && det?.before?.products?.[0]?.base_quantity_cms === '10'
    && det.after.products[0].base_quantity_cms === '5' && det.reason && det.diff.items.find((i) => i.product_id === E.pa)?.action === 'change',
    'lịch sử super: 4 revision mới nhất trước; chi tiết có snapshot trước / sau (K10 → K5), lý do, diff', JSON.stringify(hist?.slice?.(0, 1)).slice(0, 300))
  // Bất biến: không sửa / xoá lưu trữ hoặc revision (kể cả owner).
  const mutA = await settle(E.db.query(`UPDATE public.cms_program_revision_results SET amount_vnd = 0 WHERE true`))
  const mutB = await settle(E.db.query(`DELETE FROM public.cms_program_revisions WHERE true`))
  const mutC = await settle(E.db.query(`UPDATE public.cms_program_revisions SET reason = 'sửa lý do sau ghi' WHERE status = 'committed'`))
  const mutD = await settle(E.db.query(`TRUNCATE public.cms_program_revision_results`))
  ok([mutA, mutB, mutC, mutD].every((m) => !m.ok && /CMS_REVISION_(ARCHIVE_)?IMMUTABLE/.test(m.err)), 'owner UPDATE / DELETE / TRUNCATE lưu trữ / revision ⇒ IMMUTABLE', JSON.stringify([mutA, mutB, mutC, mutD].map(code)))
  // Dọn run (purge) không đụng lưu trữ.
  const nArc = (await E.one(`SELECT count(*)::int n FROM public.cms_program_revision_results`)).n
  for (let i = 0; i < 8; i++) await E.rpc(`SELECT public.rpc_cms_sales_run_cleanup($1, 50000) r`, [P.id])
  const purged = (await E.one(`SELECT count(*)::int n FROM public.cms_sync_runs WHERE program_id = $1 AND purged_at IS NOT NULL`, [P.id])).n
  const nArc2 = (await E.one(`SELECT count(*)::int n FROM public.cms_program_revision_results`)).n
  const arcAfter = await E.asU(U.super, `SELECT public.rpc_cms_program_revision_archive($1, 0, 100) r`, [cm.revision_id])
  ok(purged >= 1 && nArc2 === nArc && arcAfter?.rows?.find((r) => r.product_id === E.pa)?.amount_vnd === '200', `dọn run (${purged} run purge) không xoá lưu trữ; bản trước sửa đầu tiên vẫn đọc được 200đ`, JSON.stringify({ purged, nArc, nArc2 }))
}

// ── §4 REV04 retire / thêm lại ────────────────────────────────────────────────────────────────────────────────────────────────────
async function historySection(E) {
  section('4. REV04 bỏ SP (retire / xoá) · thêm lại không đếm đôi')
  const a = E.pid(), b = E.pid(), c = E.pid()
  const P = await E.makeProgram({ name: 'QA retire', products: [{ pid: a, k: '1' }, { pid: b, k: '1' }, { pid: c, k: '1' }] })
  const R = E.rows(P, [{ pid: a, s: 0, base: 3 }, { pid: b, s: 0, base: 4 }])
  await E.sync(P, R)
  const ids0 = await E.all(`SELECT product_id, id::text FROM public.cms_program_products WHERE program_id = $1 ORDER BY 1`, [P.id])
  // Bỏ b (đã có dữ liệu run) + c (chưa có) — xác nhận phải liệt kê đúng.
  const pv = await E.revPreview(P, [{ pid: a, k: '1' }])
  const badAck = await E.revCommit(pv, { removed: [b] })
  const cm = await E.revCommit(pv)
  const rows = await E.all(`SELECT product_id, retired_at IS NOT NULL r, id::text FROM public.cms_program_products WHERE program_id = $1 ORDER BY 1`, [P.id])
  ok(badAck?.err === 'CMS_REVISION_ACK_REQUIRED' && cm?.retired === 1 && cm.deleted === 1 && rows.length === 2 && rows.find((r) => r.product_id === b)?.r === true
    && !rows.some((r) => r.product_id === c), 'bỏ 2 SP: xác nhận sai danh sách ⇒ ACK_REQUIRED; b (có dữ liệu run) ⇒ retire, c (chưa có) ⇒ xoá', JSON.stringify({ badAck, cm, rows }))
  const rls = await E.asRole('authenticated', U.A, `SELECT string_agg(product_id, ',' ORDER BY product_id) s FROM public.cms_program_products WHERE program_id = '${P.id}'`)
  const snapP = await E.rpc(`SELECT public.rpc_cms_sales_snapshot($1) r`, [P.id])
  const scopeN = await E.one(`SELECT public.cms__program_scope_hash($1) h`, [P.id])
  ok(rls.s === a && snapP.products.length === 1 && snapP.products[0].product_id === a && /^[0-9a-f]{64}$/.test(scopeN.h), 'SP retire: RLS ẩn với staff; snapshot worker chỉ SP hiệu lực', JSON.stringify({ rls, n: snapP.products.length }))
  // Chương trình khác được nhận b (SP retire không chặn trùng).
  const Q = await E.makeProgram({ name: 'QA nhận SP retire', products: [{ pid: b, k: '1' }] }).then((x) => ({ ok: true, x }), (e) => ({ ok: false, e: String(e.message) }))
  ok(Q.ok, 'chương trình khác kích hoạt được với SP đã retire ở chương trình này', Q.e)
  // Đồng bộ lại cả kỳ ⇒ chỉ SP a; b không còn tính ở P.
  await E.sync(P, R)
  const res = await E.all(`SELECT product_id, sum(cms_quantity)::int q FROM public.cms_results WHERE run_id = (SELECT current_result_run_id FROM public.cms_programs WHERE id = $1) GROUP BY 1 ORDER BY 1`, [P.id])
  ok(res.length === 1 && res[0].product_id === a, 'tính lại cả kỳ sau bỏ SP: kết quả chỉ còn SP hiệu lực', JSON.stringify(res))
  // Thêm lại b khi Q đang giữ b ⇒ trùng; gỡ Q khỏi đường (tạo chương trình test khác không ảnh hưởng) ⇒ dùng chương trình mới R2 không giữ b.
  const pvRe = await E.revPreview(P, [{ pid: a, k: '1' }, { pid: b, k: '2' }])
  ok(pvRe?.err === 'CMS_REVISION_PRODUCT_CONFLICT', 'thêm lại b khi chương trình khác đang giữ b ⇒ PRODUCT_CONFLICT', JSON.stringify(pvRe))
  const P2 = await E.makeProgram({ name: 'QA thêm lại', products: [{ pid: E.pid(), k: '1' }, { pid: E.pid(), k: '1' }] })
  const [x, y] = P2.products.map((p) => p.pid)
  await E.sync(P2, E.rows(P2, [{ pid: x, s: 0, base: 2 }, { pid: y, s: 0, base: 5 }]))
  const idY = (await E.one(`SELECT id::text FROM public.cms_program_products WHERE program_id = $1 AND product_id = $2`, [P2.id, y])).id
  const c1 = await E.revCommit(await E.revPreview(P2, [{ pid: x, k: '1' }]))
  const pvBack = await E.revPreview(P2, [{ pid: x, k: '1' }, { pid: y, k: '1' }])
  const c2 = await E.revCommit(pvBack)
  const back = await E.all(`SELECT id::text, retired_at FROM public.cms_program_products WHERE program_id = $1 AND product_id = $2`, [P2.id, y])
  const R2 = E.rows(P2, [{ pid: x, s: 0, base: 2 }, { pid: y, s: 0, base: 5 }])
  await E.sync(P2, R2)
  const resY = await E.all(`SELECT count(*)::int n, sum(cms_quantity)::int q FROM public.cms_results WHERE run_id = (SELECT current_result_run_id FROM public.cms_programs WHERE id = $1) AND product_id = $2`, [P2.id, y])
  ok(c1?.retired === 1 && pvBack?.diff?.readd === 1 && c2?.already === false && back.length === 1 && back[0].id === idY && back[0].retired_at === null && resY[0].n === 1 && resY[0].q === 5,
    'bỏ rồi thêm lại y: bật lại ĐÚNG dòng cũ (cùng id, một bản), kết quả đếm một lần', JSON.stringify({ c1, readd: pvBack?.diff, back, resY, idY }))
}

/** Deps lockAction THẬT trên DB thử (service role) — §5 + §11. */
function lockDeps(E) {
  return {
    lockEnabled: () => true, qaReadonly: () => false, access: async () => ({ kind: 'ok', actorId: U.super, qa: true }),
    program: async (id) => { const r = await E.one(`SELECT is_test FROM public.cms_programs WHERE id = $1`, [id]); return r ? { isTest: r.is_test } : null },
    rpc: async (fn, args) => {
      const named = Object.keys(args).map((k, i) => `${k} => $${i + 1}`).join(', ')
      try { return { data: (await E.svc(`SELECT public.${fn}(${named}) r`, Object.values(args))).rows[0].r, error: null } } catch (e) { return { data: null, error: { code: e.code, message: e.message } } }
    },
  }
}

/** Câu SQL trong khối VERIFY (chú thích cuối 131): { V0: [câu…], … } — dòng '-- Vn …' mở nhóm, dòng '--   …' là thân câu (câu mới bắt đầu bằng SELECT). */
function verifyQueries(sql) {
  const tail = sql.slice(sql.indexOf('-- ── VERIFY'))
  const out = {}
  let k = null, cur = []
  const flush = () => { if (k && cur.length) { out[k].push(cur.join('\n')); cur = [] } }
  for (const line of tail.split('\n')) {
    const h = /^-- (V[0-9]+) /.exec(line)
    if (h) { flush(); k = h[1]; out[k] = []; continue }
    const b = /^--   (.*)$/.exec(line)
    if (!b || !k) continue
    if (/^SELECT /.test(b[1]) && cur.length) flush()
    cur.push(b[1])
  }
  flush()
  return out
}

// ── §5 REV02 trạng thái ───────────────────────────────────────────────────────────────────────────────────────────────────────────
async function stateSection() {
  section('5. REV02 trạng thái chương trình / run đang chạy / cms_unit')
  const E = await env('state')
  // Nháp: bỏ SP ⇒ xoá (không retire), không lưu trữ; kích hoạt vẫn được.
  const d1 = E.pid(), d2 = E.pid()
  const D = await E.makeProgram({ name: 'QA nháp', products: [{ pid: d1, k: '1' }, { pid: d2, k: '1' }], activate: false })
  const cmD = await E.revCommit(await E.revPreview(D, [{ pid: d1, k: '3' }]))
  const act = await settle(E.svc(`SELECT public.rpc_cms_program_activate($1, $2)`, [D.id, U.super]))
  ok(cmD?.archive_mode === 'none' && cmD.deleted === 1 && cmD.retired === 0 && act.ok, 'nháp: sửa được (archive none, bỏ SP ⇒ xoá), kích hoạt sau sửa vẫn được', JSON.stringify({ cmD, act: code(act) }))
  // Run đang chạy ⇒ BUSY, 0 delta.
  const P = E.LIVE
  const pv = await E.revPreview(P, [{ pid: E.pa, k: '5' }, { pid: E.pb, k: '1' }])
  await E.rpc(`SELECT public.rpc_cms_sales_run_open($1, '{}'::jsonb) r`, [P.id])
  const s0 = await E.snap(P.id)
  const busy = await E.revCommit(pv)
  const s1 = await E.snap(P.id)
  ok(busy?.err === 'CMS_SYNC_BUSY' && JSON.stringify(s0) === JSON.stringify(s1), 'run đang chạy ⇒ CMS_SYNC_BUSY, 0 delta (cấu hình / pointer / revision / lưu trữ)', JSON.stringify({ busy }))
  await E.db.query(`UPDATE public.cms_sync_runs SET status = 'error', finished_at = now(), error_code = 'QA_STOP' WHERE program_id = $1 AND status = 'running'`, [P.id])
  const ok2 = await E.revCommit(pv)
  ok(ok2?.already === false, 'run kết thúc ⇒ commit cùng preview được', JSON.stringify(ok2))
  // Net trả hàng ⇒ chặn.
  const n1 = E.pid()
  const N = await E.makeProgram({ name: 'QA net', products: [{ pid: n1, k: '1' }], v2: 'pos_base', activate: false })
  await E.svc(`SELECT public.rpc_cms_program_set_returns_policy($1, 'net_returns_v1', (SELECT config_version FROM public.cms_programs WHERE id = $1), $2)`, [N.id, U.super])
  const net = await E.revPreview(N, [{ pid: n1, k: '2' }])
  ok(net?.err === 'CMS_REVISION_NET_UNSUPPORTED', 'chương trình net_returns_v1 ⇒ NET_UNSUPPORTED', JSON.stringify(net))
  // r2 (db-reviewer P1-1): pos_base đã bỏ SP có dữ liệu (retire) ⇒ đổi returns_policy bị chặn ở MỌI đường (RPC 130 + UPDATE owner), 0 delta.
  const rt1 = E.pid(), rt2 = E.pid()
  const RT = await E.makeProgram({ name: 'QA retire rồi net', products: [{ pid: rt1, k: '1' }, { pid: rt2, k: '1' }], v2: 'pos_base' })
  await E.sync(RT, E.rows(RT, [{ pid: rt1, s: 0, base: 2 }, { pid: rt2, s: 0, base: 3 }]))
  const rtCm = await E.revCommit(await E.revPreview(RT, [{ pid: rt1, k: '1' }]))
  const rtS0 = await E.snap(RT.id)
  const rtPol = await settle(E.svc(`SELECT public.rpc_cms_program_set_returns_policy($1, 'net_returns_v1', (SELECT config_version FROM public.cms_programs WHERE id = $1), $2)`, [RT.id, U.super]))
  const rtOwn = await settle(E.db.query(`UPDATE public.cms_programs SET returns_policy = 'net_returns_v1', returns_policy_set_by = $2, returns_policy_set_at = now(), config_version = config_version + 1 WHERE id = $1`, [RT.id, U.super]))
  const rtS1 = await E.snap(RT.id)
  const rtP = await E.one(`SELECT returns_policy FROM public.cms_programs WHERE id = $1`, [RT.id])
  ok(rtCm?.retired === 1 && code(rtPol) === 'CMS_RETURNS_POLICY_RETIRED_UNSUPPORTED' && code(rtOwn) === 'CMS_RETURNS_POLICY_RETIRED_UNSUPPORTED'
    && JSON.stringify(rtS0) === JSON.stringify(rtS1) && rtP.returns_policy === 'sales_only_v1',
    'pos_base đã retire SP ⇒ chuyển net (RPC 130 lẫn UPDATE owner) ⇒ CMS_RETURNS_POLICY_RETIRED_UNSUPPORTED, 0 delta (r2 — P1-1); chương trình chưa retire vẫn chuyển được (ca net trên)',
    JSON.stringify({ rtCm, rtPol: code(rtPol), rtOwn: code(rtOwn), rtP }))
  // cms_unit: đổi mức được; bỏ SP có dữ liệu run ⇒ REMOVE_UNSUPPORTED (con dấu N9 — finding).
  const u1 = E.pid(), u2 = E.pid()
  const CU = await E.makeProgram({ name: 'QA cms_unit', isTest: true, products: [{ pid: u1, k: '1', unit: 'Hộp' }, { pid: u2, k: '1', unit: 'Hộp' }], v2: 'cms_unit' })
  const su = await E.syncContract(CU, E.rows(CU, [{ pid: u1, s: 0, base: 2, q: '2' }, { pid: u2, s: 0, base: 3, q: '3' }]))
  const cuK = await E.revCommit(await E.revPreview(CU, [{ pid: u1, k: '1', unit: 'Hộp', tiers: T1(200) }, { pid: u2, k: '1', unit: 'Hộp' }]))
  const cuRm = await E.revPreview(CU, [{ pid: u1, k: '1', unit: 'Hộp', tiers: T1(200) }])
  ok(su.status === 'published' && cuK?.already === false && cuRm?.err === 'CMS_REVISION_REMOVE_UNSUPPORTED', 'cms_unit: đổi mức được; bỏ SP đã có dữ liệu run ⇒ REMOVE_UNSUPPORTED (preview)', JSON.stringify({ su: su.status, cuK, cuRm }))
  const su2 = await E.syncContract(CU, E.rows(CU, [{ pid: u1, s: 0, base: 2, q: '2' }, { pid: u2, s: 0, base: 3, q: '3' }]))
  ok(su2.status === 'published', 'cms_unit sau sửa: run contract seal / công bố bình thường', JSON.stringify(su2).slice(0, 200))
  // Chốt (locked + payout) ⇒ chặn: QA ended program + lockAction thật.
  const l1 = E.pid()
  const LP = await E.makeProgram({ name: 'QA chốt', isTest: true, products: [{ pid: l1, k: '1' }], dates: [await E.day(-40), await E.day(-10)] })
  await E.sync(LP, E.rows(LP, [{ pid: l1, s: 0, base: 4 }]))
  const LD = lockDeps(E)
  const lpv = await LA.runCmsLockPreview(LD, LP.id)
  const lk = lpv.ok ? await LA.runCmsLock(LD, { programId: LP.id, expectedRunId: (await E.prog(LP.id)).ptr, expectedPolicyVersion: lpv.preview.policyVersion,
    ackReason: 'QA chốt để thử chặn sửa chương trình' }) : { ok: false }
  const locked = await E.revPreview(LP, [{ pid: l1, k: '2' }])
  ok(lk.ok && locked?.err === 'CMS_PROGRAM_LOCKED', 'chương trình đã chốt (payout) ⇒ CMS_PROGRAM_LOCKED', JSON.stringify({ lk, locked }))
  // Chứng nhận nguồn / sổ trả hàng ⇒ chặn (dòng giả lập bằng owner — chỉ DB thử, tắt trigger tạm thời).
  const t1 = E.pid()
  const TP = await E.makeProgram({ name: 'QA chứng nhận', products: [{ pid: t1, k: '1' }] })
  await E.sync(TP, E.rows(TP, [{ pid: t1, s: 0, base: 1 }]))
  const tRun = (await E.prog(TP.id)).ptr
  await E.db.exec(`ALTER TABLE public.cms_source_attestations DISABLE TRIGGER USER`)
  await E.db.query(`INSERT INTO public.cms_source_attestations (id, program_id, run_id, config_version, mapping_fp, basis, fp_version, field_set, scope_from, scope_to,
      scope_hash, run_rows_fp, run_file_sha256, reference_rows_fp, reference_file_sha256, reference_label, as_of, reference_exported_at, run_exported_at,
      lines_compared, missing_lines, extra_lines, changed_lines, tool_version, ack_reason, idem_key, payload_sha256, attested_by)
    VALUES (gen_random_uuid(), $1, $2, 1, repeat('a', 32), 'operator_reconciliation', 'cms-rows-fp-v1', 'decision10', current_date, current_date,
      repeat('b', 64), repeat('c', 64), repeat('d', 64), repeat('c', 64), repeat('e', 64), 'QA nhãn', now(), now(), now(), 1, 0, 0, 0, 'cms-i4-compare-v1',
      'QA chứng nhận giả', gen_random_uuid(), repeat('f', 64), $3)`, [TP.id, tRun, U.super])
  await E.db.exec(`ALTER TABLE public.cms_source_attestations ENABLE TRIGGER USER`)
  const att = await E.revPreview(TP, [{ pid: t1, k: '2' }])
  ok(att?.err === 'CMS_REVISION_ATTESTED', 'đã có chứng nhận nguồn ⇒ CMS_REVISION_ATTESTED', JSON.stringify(att))
}

// ── §6 REV03 idempotency / stale ──────────────────────────────────────────────────────────────────────────────────────────────────
async function idemSection() {
  section('6. REV03 idempotency · stale · hết hạn · người khác · xác nhận · lỗi giữa chừng')
  const E = await env('idem')
  const P = E.LIVE
  const prods = (k) => [{ pid: E.pa, k }, { pid: E.pb, k: '1' }]
  const pv = await E.revPreview(P, prods('5'))
  const key = uuid()
  const c1 = await E.revCommit(pv, { key })
  const c2 = await E.revCommit(pv, { key })
  const c3 = await E.revCommit(pv, { key: uuid() })
  const v = (await E.prog(P.id)).v
  ok(c1?.already === false && c2?.already === true && c2.revision_id === c1.revision_id && c3?.err === 'CMS_REVISION_IDEMPOTENCY_CONFLICT' && v === pv.from_config_version + 1,
    'cùng preview + key ⇒ ghi 1 lần (lần 2 already); key khác ⇒ IDEMPOTENCY_CONFLICT; version +1 đúng một lần', JSON.stringify({ c1, c2, c3, v }))
  // Stale version: hai preview cùng version, commit một ⇒ cái kia STALE.
  const pa1 = await E.revPreview(P, prods('2'))
  const pa2 = await E.revPreview(P, prods('3'))
  const k1 = await E.revCommit(pa1)
  const s0 = await E.snap(P.id)
  const k2 = await E.revCommit(pa2)
  ok(k1?.already === false && k2?.err === 'CMS_REVISION_PREVIEW_STALE' && JSON.stringify(s0) === JSON.stringify(await E.snap(P.id)), 'preview cũ sau một commit khác ⇒ PREVIEW_STALE, 0 delta', JSON.stringify(k2))
  // Stale pointer: run mới công bố sau preview.
  const pp = await E.revPreview(P, prods('4'))
  await E.sync(P, E.LIVE_ROWS)
  const kp = await E.revCommit(pp)
  ok(kp?.err === 'CMS_REVISION_PREVIEW_STALE', 'pointer đổi sau preview (run mới công bố) ⇒ PREVIEW_STALE', JSON.stringify(kp))
  // Stale mapping: đổi người dùng sau preview.
  const pm = await E.revPreview(P, prods('4'))
  await E.db.query(`UPDATE public.users SET full_name = full_name, email = lower(email) || '' WHERE id = $1`, [U.A])
  await E.db.query(`UPDATE public.users SET role = 'staff' WHERE id = $1`, [U.B])
  await E.db.query(`INSERT INTO public.users (id, email, full_name, role, store_id) VALUES (gen_random_uuid(), 'qa.new131@example.invalid', 'QA mới', 'staff', $1)`, [storeId(3)])
  const km = await E.revCommit(pm)
  ok(km?.err === 'CMS_REVISION_PREVIEW_STALE', 'mapping đổi sau preview ⇒ PREVIEW_STALE', JSON.stringify(km))
  // Digest / version sai, người khác, lý do, xác nhận thiếu tick.
  const pz = await E.revPreview(P, prods('4'))
  const zd = await E.revCommit(pz, { digest: 'a'.repeat(64) })
  const zv = await E.revCommit(pz, { cv: pz.from_config_version - 1 })
  await E.db.query(`UPDATE public.users SET role = 'admin' WHERE id = $1`, [U.mkt])
  const super2 = await E.one(`SELECT id::text FROM public.users WHERE id = $1`, [U.super])
  const zr = await E.revCommit(pz, { reason: 'ngắn' })
  const za = await E.revCommit(pz, { ack: { whole_period: true, may_decrease: false, removed: [] } })
  const zb = await E.revCommit(pz, { ack: { whole_period: 'true', may_decrease: true, removed: [] } })
  ok(zd?.err === 'CMS_REVISION_PREVIEW_STALE' && zv?.err === 'CMS_REVISION_PREVIEW_STALE' && zr?.err === 'CMS_REVISION_REASON_REQUIRED'
    && za?.err === 'CMS_REVISION_ACK_REQUIRED' && zb?.err === 'CMS_REVISION_ACK_REQUIRED' && super2,
    'digest sai / version kỳ vọng sai ⇒ STALE; lý do < 10 ký tự ⇒ REASON_REQUIRED; thiếu tick (false / chuỗi) ⇒ ACK_REQUIRED', JSON.stringify({ zd, zv, zr, za, zb }))
  // Người khác (super thứ hai — giả lập bằng bảng allowlist SQL: dùng owner chèn revision cùng nội dung nhưng actor khác).
  const other = await E.one(`INSERT INTO public.cms_program_revisions (program_id, actor_id, program_status, from_config_version, expected_run_id, mapping_fp, file_sha256,
      payload, payload_digest, diff, before_snapshot, impact, source_identity, expires_at)
    SELECT program_id, $2, program_status, from_config_version, expected_run_id, mapping_fp, file_sha256, payload, payload_digest, diff, before_snapshot, impact,
      source_identity, expires_at FROM public.cms_program_revisions WHERE id = $1 RETURNING id::text`, [pz.revision_id, U.mkt])
  const zo = await E.revCommit({ ...pz, revision_id: other.id })
  // Hết hạn: revision previewed có expires_at quá khứ (owner chèn — guard cho phép INSERT previewed).
  const expd = await E.one(`INSERT INTO public.cms_program_revisions (program_id, actor_id, program_status, from_config_version, expected_run_id, mapping_fp, file_sha256,
      payload, payload_digest, diff, before_snapshot, impact, source_identity, expires_at, created_at)
    SELECT program_id, actor_id, program_status, from_config_version, expected_run_id, mapping_fp, file_sha256, payload, payload_digest, diff, before_snapshot, impact,
      source_identity, now() - interval '1 minute', now() - interval '16 minutes' FROM public.cms_program_revisions WHERE id = $1 RETURNING id::text`, [pz.revision_id])
  const ze = await E.revCommit({ ...pz, revision_id: expd.id })
  ok(zo?.err === 'CMS_REVISION_NOT_OWNER' && ze?.err === 'CMS_REVISION_PREVIEW_EXPIRED', 'preview của người khác ⇒ NOT_OWNER; preview quá 15 phút ⇒ PREVIEW_EXPIRED', JSON.stringify({ zo, ze }))
  // Impact lỗi nguồn ⇒ preview lưu được (xem diff) nhưng KHÔNG commit.
  const pe = await E.revPreview(P, prods('4'), { impact: { status: 'error', from_config_version: (await E.prog(P.id)).v, error_code: 'SOURCE_ERROR' } })
  const ke = await E.revCommit(pe)
  ok(pe?.impact_ok === false && ke?.err === 'CMS_REVISION_IMPACT_INVALID', 'impact lỗi nguồn ⇒ preview impact_ok false, commit IMPACT_INVALID', JSON.stringify({ pe: pe?.impact_ok, ke }))
  // Impact tính trên version / mapping khác ⇒ preview từ chối.
  const pvS = await E.revPreview(P, prods('4'), { cv: 1 })
  const pvM = await E.revPreview(P, prods('4'), { source: { mapping_fp: 'f'.repeat(32) } })
  ok(pvS?.err === 'CMS_REVISION_PREVIEW_STALE' && pvM?.err === 'CMS_REVISION_MAPPING_CHANGED', 'impact khác version / mapping hiện hành ⇒ preview từ chối', JSON.stringify({ pvS, pvM }))
  // Lỗi giữa chừng (sau lưu trữ + áp một phần) ⇒ rollback đủ.
  const pf = await E.revPreview(P, [{ pid: E.pa, k: '4', tiers: T1(120) }, { pid: E.pb, k: '1' }])
  await E.db.exec(`CREATE FUNCTION public.qa_fail_tier() RETURNS trigger LANGUAGE plpgsql AS $q$ BEGIN RAISE EXCEPTION 'QA_FAIL_MID'; END $q$;
    CREATE TRIGGER qa_fail_tier AFTER INSERT ON public.cms_program_tiers FOR EACH ROW EXECUTE FUNCTION public.qa_fail_tier();`)
  const sf0 = await E.snap(P.id)
  const kf = await E.revCommit(pf)
  const sf1 = await E.snap(P.id)
  await E.db.exec(`DROP TRIGGER qa_fail_tier ON public.cms_program_tiers; DROP FUNCTION public.qa_fail_tier();`)
  const kf2 = await E.revCommit(pf)
  ok(/QA_FAIL_MID/.test(kf?.err ?? '') && JSON.stringify(sf0) === JSON.stringify(sf1) && kf2?.already === false,
    'lỗi giữa chừng (sau lưu trữ + đổi K, lúc ghi bậc) ⇒ 0 delta (lưu trữ / SP / version / revision); gọi lại cùng preview thành công', JSON.stringify({ kf, kf2 }))
}

// ── §6c r3 (PM P1-03) số đã công bố — đường đọc THẬT trên DB thử ───────────────────────────────────────────────────────────────────
// Reader SQL = cùng bảng / cột / lọc / thứ tự với reader service role của route (revisionDeps.cmsPublishedReader, PostgREST); dữ liệu
// hỏng tạo bằng owner trên DB thử (purge / Σ lệch) — không mock deps.throw.
const pgPublishedReader = (E, wrap = {}) => {
  const base = {
    header: async (runId) => (await E.svc(`SELECT id::text, program_id::text, kind, status, to_json(published_at) #>> '{}' published_at,
        to_json(purged_at) #>> '{}' purged_at, amount_vnd::text, config_version, seal_expect ->> 'results' results_expected
      FROM public.cms_sync_runs WHERE id = $1`, [runId])).rows[0] ?? null,
    page: async (runId, from, to) => (await E.svc(`SELECT user_id::text, program_product_id::text, amount_vnd::text FROM public.cms_results
      WHERE run_id = $1 ORDER BY user_id, program_product_id OFFSET $2 LIMIT $3`, [runId, from, to - from + 1])).rows,
  }
  return { header: wrap.header ? (r) => wrap.header(base, r) : base.header, page: wrap.page ? (r, f, t) => wrap.page(base, r, f, t) : base.page }
}
const realImpactDeps = (E, rws, reader) => ({
  table: QR.CMS_QA_FAKE_TABLE, runner: FX.createCmsFixtureRunner({ sales: rws }),
  loadSnapshot: (id) => E.rpc(`SELECT public.rpc_cms_sales_snapshot($1) r`, [id]),
  loadPublished: (p, r) => PUB.cmsLoadPublished(reader ?? pgPublishedReader(E), p, r),
  calcModes: true, deadlineMs: 30_000, now: () => new Date(),
})
async function publishedSection() {
  section('6c. r3 P1-03 số đã công bố: đọc đủ + kiểm (đường đọc thật, DB thử)')
  const E = await env('pub')
  const why = async (p) => { try { await p; return 'OK' } catch (e) { return e?.reason ?? `KHÁC:${String(e?.message ?? e).slice(0, 80)}` } }
  // ok: run công bố thật của LIVE — Σ dòng = header, số dòng = niêm phong.
  const P = E.LIVE
  const A = (await E.prog(P.id)).ptr
  const h = await E.one(`SELECT amount_vnd::text a, (seal_expect ->> 'results')::int n, config_version cv FROM public.cms_sync_runs WHERE id = $1`, [A])
  const okL = await PUB.cmsLoadPublished(pgPublishedReader(E), P.id, A)
  const okP = await PUB.cmsLoadPublished(pgPublishedReader(E), P.id, A, { pageSize: 1 })
  ok(okL.amountVnd === h.a && okL.rows === h.n && okL.configVersion === h.cv && okP.rows === h.n && okP.amountVnd === h.a && h.n >= 2,
    `run công bố thật: đọc đủ (${h.n} dòng, Σ ${h.a}) — cả trang 1 dòng; Σ = header, số dòng = niêm phong`, JSON.stringify({ h, okL: { a: okL.amountVnd, n: okL.rows } }))
  // Header 0 THẬT + 0 dòng ⇒ 0 (không lỗi).
  const z1 = E.pid()
  const Z = await E.makeProgram({ name: 'QA run 0', products: [{ pid: z1, k: '1' }] })
  const syZ = await E.sync(Z, [])
  const ZR = (await E.prog(Z.id)).ptr
  const zl = ZR ? await settle(PUB.cmsLoadPublished(pgPublishedReader(E), Z.id, ZR)) : { ok: false, err: 'không có run' }
  ok(syZ.status === 'published' && zl.ok && zl.v.amountVnd === '0' && zl.v.rows === 0 && zl.v.byUser.size === 0, 'run công bố 0 dòng / 0₫ thật ⇒ đọc được 0 (không coi là lỗi)', JSON.stringify({ sy: syZ.status, zl: zl.ok ? 'ok' : zl.err }))
  // Status sai: run lỗi của chính chương trình; run của chương trình khác.
  const er = await E.rpc(`SELECT public.rpc_cms_sales_run_open($1, '{}'::jsonb) r`, [P.id])
  const erId = typeof er === 'string' ? er : er?.run_id ?? er?.id
  await E.db.query(`UPDATE public.cms_sync_runs SET status = 'error', finished_at = now(), error_code = 'QA_STOP' WHERE id = $1 AND status = 'running'`, [erId])
  const st = { err: await why(PUB.cmsLoadPublished(pgPublishedReader(E), P.id, erId)), other: await why(PUB.cmsLoadPublished(pgPublishedReader(E), Z.id, A)),
    missing: await why(PUB.cmsLoadPublished(pgPublishedReader(E), P.id, uuid())) }
  ok(st.err === 'RUN_NOT_PUBLISHED' && st.other === 'RUN_PROGRAM_MISMATCH' && st.missing === 'RUN_MISSING', 'run lỗi ⇒ RUN_NOT_PUBLISHED; run chương trình khác ⇒ RUN_PROGRAM_MISMATCH; không có ⇒ RUN_MISSING', JSON.stringify({ erId, st }))
  // Thiếu trang / trùng trang (trang 1 dòng): bỏ trang 2; trang 2 = trang 1; purge bắt đầu giữa lúc đọc (header lần 2).
  const pg = {
    drop: await why(PUB.cmsLoadPublished(pgPublishedReader(E, { page: (b, r, f, t) => (f === 1 ? [] : b.page(r, f, t)) }), P.id, A, { pageSize: 1 })),
    dup: await why(PUB.cmsLoadPublished(pgPublishedReader(E, { page: (b, r, f, t) => b.page(r, f === 1 ? 0 : f, f === 1 ? 0 : t) }), P.id, A, { pageSize: 1 })),
    purgeMid: await why(PUB.cmsLoadPublished(pgPublishedReader(E, { header: (() => { let n = 0; return async (b, r) => { const x = await b.header(r); return ++n > 1 ? { ...x, purged_at: new Date().toISOString() } : x } })() }), P.id, A)),
  }
  ok(pg.drop === 'ROWS_COUNT_MISMATCH' && pg.dup === 'ROWS_ORDER' && pg.purgeMid === 'RUN_PURGED', 'thiếu trang ⇒ ROWS_COUNT_MISMATCH; trang lặp ⇒ ROWS_ORDER; purge bắt đầu giữa lúc đọc ⇒ RUN_PURGED', JSON.stringify(pg))
  // Dữ liệu hỏng THẬT trên DB thử (owner, chương trình riêng): Σ dòng lệch header; purge (purged_at như lô dọn đầu tiên).
  const mkRun = async (name) => {
    const x1 = E.pid(), x2 = E.pid()
    const X = await E.makeProgram({ name, products: [{ pid: x1, k: '1' }, { pid: x2, k: '1' }] })
    const rws = E.rows(X, [{ pid: x1, s: 0, base: 3 }, { pid: x2, s: 1, base: 2 }])
    await E.sync(X, rws)
    return { X, rws, run: (await E.prog(X.id)).ptr, prods: [{ pid: x1, k: '1' }, { pid: x2, k: '1' }] }
  }
  const S = await mkRun('QA tổng lệch')
  await E.db.exec(`ALTER TABLE public.cms_results DISABLE TRIGGER USER`)
  const su = await settle(E.db.query(`UPDATE public.cms_results SET potential_amount = potential_amount + 1, amount_vnd = amount_vnd + 1
    WHERE (run_id, user_id, program_product_id) = (SELECT run_id, user_id, program_product_id FROM public.cms_results WHERE run_id = $1 ORDER BY user_id, program_product_id LIMIT 1)`, [S.run]))
  await E.db.exec(`ALTER TABLE public.cms_results ENABLE TRIGGER USER`)
  const sumWhy = await why(PUB.cmsLoadPublished(pgPublishedReader(E), S.X.id, S.run))
  const G = await mkRun('QA run bị dọn')
  await E.db.exec(`ALTER TABLE public.cms_sync_runs DISABLE TRIGGER USER`)
  const pu = await settle(E.db.query(`UPDATE public.cms_sync_runs SET purged_at = now() WHERE id = $1`, [G.run]))
  await E.db.exec(`ALTER TABLE public.cms_sync_runs ENABLE TRIGGER USER`)
  const purgeWhy = await why(PUB.cmsLoadPublished(pgPublishedReader(E), G.X.id, G.run))
  // Nối vào dự toán THẬT (snapshot RPC + reader thật) ⇒ status error PUBLISHED_UNAVAILABLE ⇒ preview lưu impact_ok false ⇒ commit IMPACT_INVALID.
  const imS = await IM.computeCmsRevisionImpact(realImpactDeps(E, S.rws), S.X.id, [E.prodPayload({ pid: S.prods[0].pid, k: '2' }), E.prodPayload(S.prods[1])])
  const imG = await IM.computeCmsRevisionImpact(realImpactDeps(E, G.rws), G.X.id, [E.prodPayload({ pid: G.prods[0].pid, k: '2' }), E.prodPayload(G.prods[1])])
  const pvS = imS.ok ? await E.revPreview(S.X, [{ pid: S.prods[0].pid, k: '2' }, S.prods[1]], { impact: imS.impact, expectedRun: imS.snapshot.currentResultRunId, source: imS.source }) : null
  const cmS = pvS?.revision_id ? await E.revCommit(pvS) : null
  ok(su.ok && sumWhy === 'ROWS_SUM_MISMATCH' && pu.ok && purgeWhy === 'RUN_PURGED' && imS.ok && imS.impact.status === 'error' && imS.impact.code === 'PUBLISHED_UNAVAILABLE'
    && imS.impact.totals === null && imG.ok && imG.impact.code === 'PUBLISHED_UNAVAILABLE' && pvS?.impact_ok === false && cmS?.err === 'CMS_REVISION_IMPACT_INVALID',
    'dữ liệu hỏng thật: Σ dòng lệch header ⇒ ROWS_SUM_MISMATCH; run bị dọn ⇒ RUN_PURGED; dự toán thật ⇒ PUBLISHED_UNAVAILABLE (không số), preview impact_ok false, commit IMPACT_INVALID',
    JSON.stringify({ su: su.ok ? 'ok' : su.err, sumWhy, pu: pu.ok ? 'ok' : pu.err, purgeWhy, imS: imS.ok ? imS.impact.code : imS.code, imG: imG.ok ? imG.impact.code : imG.code, pvS: pvS?.err ?? pvS?.impact_ok, cmS }))
  // Hai lần sửa liền, KHÔNG có run mới: dự toán thật ⇒ bản công bố trước (current false, version run), preview / commit vẫn được (pointer giữ).
  const T2r = await mkRun('QA sửa hai lần không run mới')
  const imp = async (k) => IM.computeCmsRevisionImpact(realImpactDeps(E, T2r.rws), T2r.X.id, [E.prodPayload({ pid: T2r.prods[0].pid, k }), E.prodPayload(T2r.prods[1])])
  const runCv = Number((await E.one(`SELECT config_version FROM public.cms_sync_runs WHERE id = $1`, [T2r.run])).config_version)
  const i1 = await imp('2')
  const p1 = await E.revPreview(T2r.X, [{ pid: T2r.prods[0].pid, k: '2' }, T2r.prods[1]], { impact: i1.impact, expectedRun: i1.snapshot.currentResultRunId, source: i1.source })
  const c1 = await E.revCommit(p1)
  const i2 = await imp('3')
  const p2 = await E.revPreview(T2r.X, [{ pid: T2r.prods[0].pid, k: '3' }, T2r.prods[1]], { impact: i2.impact, expectedRun: i2.snapshot.currentResultRunId, source: i2.source })
  const c2 = await E.revCommit(p2)
  const i3 = await imp('4')
  const t1 = i1.impact?.totals, t2 = i2.impact?.totals, t3 = i3.impact?.totals
  const v1 = t1 ? MD.cmsRevisionPublishedView(t1) : null, v3 = t3 ? MD.cmsRevisionPublishedView(t3) : null
  ok(i1.impact?.status === 'ok' && t1.published_current === true && v1.kind === 'current' && c1?.already === false
    && t2?.published_current === false && t2.published_run_id === T2r.run && t2.published_config_version === runCv && c2?.already === false
    && t3?.published_current === false && i3.impact.from_config_version === runCv + 2 && v3.kind === 'prior' && v3.label === `Bản công bố trước thay đổi cấu hình v${runCv}`
    && t3.published_vnd === t1.published_vnd,
    'sửa hai lần không có run mới (dự toán thật): lần 1 "đang công bố"; lần 2–3 "bản công bố trước thay đổi cấu hình v<run>" (current false, cùng run / số), preview + commit vẫn đúng',
    JSON.stringify({ i1: i1.impact?.code, t1, t2: t2?.published_current, c1, c2: c2?.err ?? c2?.already, v3, runCv }).slice(0, 900))
}

// ── §6b r3 (PM P1-01) preview ghim run app đã dùng để dự toán ───────────────────────────────────────────────────────────────────────
async function pinSection() {
  section('6b. r3 P1-01 preview ghim expected_run_id (run đổi giữa dự toán và lưu preview)')
  const E = await env('pin')
  const P = E.LIVE
  const prods = (k) => [{ pid: E.pa, k }, { pid: E.pb, k: '1' }]
  const nRev = async (id) => Number((await E.one(`SELECT count(*)::int n FROM public.cms_program_revisions WHERE program_id = $1`, [id])).n)
  // A→A: pointer gửi = hiện hành ⇒ lưu expected_run_id = A (cột + kết quả), impact tham chiếu A.
  const A = (await E.prog(P.id)).ptr
  const pAA = await E.revPreview(P, prods('5'))
  const rowAA = pAA?.revision_id ? await E.one(`SELECT expected_run_id::text x, impact->'totals'->>'published_run_id' ir FROM public.cms_program_revisions WHERE id = $1`, [pAA.revision_id]) : null
  ok(!!A && pAA?.expected_run_id === A && rowAA?.x === A && rowAA?.ir === A, 'A→A: expected_run_id = pointer hiện hành ⇒ preview lưu đúng A (cột + impact)',
    JSON.stringify({ A, pAA: pAA?.err ?? pAA?.expected_run_id, rowAA }))
  // A→B giữa đọc nguồn (dự toán) và lưu preview: thân dựng với A; run mới công bố; gửi ⇒ STALE, KHÔNG tạo revision.
  const bodyAB = await E.revBody(P, prods('6'))
  await E.sync(P, E.LIVE_ROWS)
  const B = (await E.prog(P.id)).ptr
  const nAB = await nRev(P.id)
  const pAB = await E.asU(U.super, PREVIEW, [JSON.stringify(bodyAB)])
  ok(!!B && B !== A && bodyAB.expected_run_id === A && pAB?.err === 'CMS_REVISION_PREVIEW_STALE' && await nRev(P.id) === nAB,
    'A→B giữa dự toán và lưu preview ⇒ PREVIEW_STALE, 0 revision mới', JSON.stringify({ pAB, nAB }))
  const kAA = await E.revCommit(pAA)
  ok(kAA?.err === 'CMS_REVISION_PREVIEW_STALE', 'preview A lưu trước khi run đổi sang B ⇒ commit PREVIEW_STALE (giữ r2)', JSON.stringify(kAA))
  // Nháp: NULL→NULL hợp lệ; thiếu trường (≠ null) / kiểu sai ⇒ BAD_INPUT, không tạo revision.
  const d1 = E.pid()
  const D = await E.makeProgram({ name: 'QA nháp ghim run', products: [{ pid: d1, k: '1' }], activate: false })
  const pNN = await E.revPreview(D, [{ pid: d1, k: '2' }])
  const bad = { omit: await E.revPreview(D, [{ pid: d1, k: '2' }], { omitExpected: true }) }
  for (const [k, v] of [['num', 1], ['obj', {}], ['arr', []], ['bool', true], ['empty', ''], ['text', 'abc'], ['upper', uuid().toUpperCase()],
    ['space', ` ${uuid()}`], ['brace', `{${uuid()}}`], ['nl', `${uuid()}\n`]]) bad[k] = await E.revPreview(D, [{ pid: d1, k: '2' }], { rawExpected: v })
  // db-reviewer r3 P2-4: pointer NULL + expected UUID ⇒ STALE; expected null + impact ok trỏ một run / THIẾU khoá published_run_id ⇒ IMPACT_INVALID.
  const xv = (await E.prog(D.id)).v
  const nullSide = {
    staleUuid: await E.revPreview(D, [{ pid: d1, k: '2' }], { expectedRun: uuid() }),
    impUuid: await E.revPreview(D, [{ pid: d1, k: '2' }], { impactRun: uuid() }),
    impNoKey: await E.revPreview(D, [{ pid: d1, k: '2' }], { impact: { status: 'ok', from_config_version: xv,
      totals: { before_vnd: '0', after_vnd: '0', delta_vnd: '0', people_up: 0, people_down: 0 } } }),
  }
  const nD = await nRev(D.id)
  ok(pNN?.revision_id && pNN.expected_run_id === null && Object.values(bad).every((x) => x?.err === 'CMS_REVISION_BAD_INPUT')
    && nullSide.staleUuid?.err === 'CMS_REVISION_PREVIEW_STALE' && nullSide.impUuid?.err === 'CMS_REVISION_IMPACT_INVALID' && nullSide.impNoKey?.err === 'CMS_REVISION_IMPACT_INVALID' && nD === 1,
    'nháp NULL→NULL hợp lệ; thiếu expected_run_id / số / object / mảng / bool / chuỗi rỗng / không phải UUID / UUID hoa / khoảng trắng / {} / xuống dòng ⇒ BAD_INPUT; '
      + 'pointer NULL + expected UUID ⇒ STALE; impact trỏ run khi chưa có run / THIẾU khoá published_run_id ⇒ IMPACT_INVALID; không tạo revision',
    JSON.stringify({ pNN: pNN?.err ?? pNN?.expected_run_id, bad: Object.fromEntries(Object.entries(bad).map(([k, v]) => [k, v?.err ?? 'OK'])),
      nullSide: Object.fromEntries(Object.entries(nullSide).map(([k, v]) => [k, v?.err ?? 'OK'])), nD }))
  // Đang chạy, chưa có run: NULL→NULL hợp lệ; run đầu công bố sau dự toán (NULL→B) ⇒ STALE.
  const q1 = E.pid()
  const Q = await E.makeProgram({ name: 'QA chưa có run', products: [{ pid: q1, k: '1' }] })
  const pQN = await E.revPreview(Q, [{ pid: q1, k: '2' }])
  const bodyNB = await E.revBody(Q, [{ pid: q1, k: '3' }])
  const syQ = await E.sync(Q, E.rows(Q, [{ pid: q1, s: 0, base: 2 }]))
  const QB = (await E.prog(Q.id)).ptr
  const nQ = await nRev(Q.id)
  const pNB = await E.asU(U.super, PREVIEW, [JSON.stringify(bodyNB)])
  ok(pQN?.revision_id && pQN.expected_run_id === null && bodyNB.expected_run_id === null && syQ.status === 'published' && !!QB && pNB?.err === 'CMS_REVISION_PREVIEW_STALE' && await nRev(Q.id) === nQ,
    'chưa có run: NULL→NULL hợp lệ; NULL→B (run đầu công bố sau dự toán) ⇒ PREVIEW_STALE, 0 revision mới', JSON.stringify({ pQN: pQN?.err ?? pQN?.expected_run_id, pNB, syQ: syQ.status }))
  // Dự toán 'ok' phải tham chiếu đúng run ghim; dự toán lỗi nguồn (không totals) vẫn lưu được để xem diff.
  const im = {
    other: await E.revPreview(P, prods('7'), { impactRun: uuid() }),
    nul: await E.revPreview(P, prods('7'), { impactRun: null }),
    noTotals: await E.revPreview(P, prods('7'), { impact: { status: 'ok', from_config_version: (await E.prog(P.id)).v } }),
    errNoTotals: await E.revPreview(P, prods('7'), { impact: { status: 'error', from_config_version: (await E.prog(P.id)).v, error_code: 'SOURCE_ERROR' } }),
    okNow: await E.revPreview(P, prods('7')),
  }
  ok(im.other?.err === 'CMS_REVISION_IMPACT_INVALID' && im.nul?.err === 'CMS_REVISION_IMPACT_INVALID' && im.noTotals?.err === 'CMS_REVISION_IMPACT_INVALID'
    && im.errNoTotals?.impact_ok === false && im.okNow?.expected_run_id === B,
    'impact ok tham chiếu run khác / null / thiếu totals ⇒ IMPACT_INVALID; impact lỗi nguồn vẫn lưu (impact_ok false); đúng run ⇒ lưu',
    JSON.stringify(Object.fromEntries(Object.entries(im).map(([k, v]) => [k, v?.err ?? v?.expected_run_id ?? v?.impact_ok]))))
  // Đối chứng âm (đột biến hàm tại chỗ trên DB thử, khôi phục ngay): mỗi guard bỏ đi ⇒ ca tương ứng LỌT ⇒ test trên bắt được.
  const r1 = await mutateFn(E, PREVIEW_SIG, [['IF v_prog.current_result_run_id IS DISTINCT FROM v_xrun THEN', 'IF false THEN']])
  const bodyNeg = await E.revBody(P, prods('8'))
  await E.sync(P, E.LIVE_ROWS)
  const neg1 = await E.asU(U.super, PREVIEW, [JSON.stringify(bodyNeg)])
  await r1()
  const r2 = await mutateFn(E, PREVIEW_SIG, [["OR NOT (p ? 'expected_run_id')", 'OR false'], ["COALESCE(jsonb_typeof(p->'expected_run_id'), '')", "COALESCE(jsonb_typeof(p->'expected_run_id'), 'null')"]])
  const neg2 = await E.revPreview(D, [{ pid: d1, k: '4' }], { omitExpected: true })
  await r2()
  const r3 = await mutateFn(E, PREVIEW_SIG, [["OR (v_imp->'totals'->>'published_run_id') IS DISTINCT FROM v_xrun::text) THEN", 'OR false) THEN']])
  const neg3 = await E.revPreview(P, prods('8'), { impactRun: uuid() })
  await r3()
  const back = { ab: await E.asU(U.super, PREVIEW, [JSON.stringify({ ...bodyNeg, file_sha256: sha(`neg-${uuid()}`) })]),
    omit: await E.revPreview(D, [{ pid: d1, k: '4' }], { omitExpected: true }), imp: await E.revPreview(P, prods('8'), { impactRun: uuid() }) }
  ok(!!neg1?.revision_id && !!neg2?.revision_id && !!neg3?.revision_id && back.ab?.err === 'CMS_REVISION_PREVIEW_STALE' && back.omit?.err === 'CMS_REVISION_BAD_INPUT'
    && back.imp?.err === 'CMS_REVISION_IMPACT_INVALID',
    'đối chứng âm: bỏ guard pointer ⇒ A→B lọt; bỏ kiểm thiếu trường ⇒ thiếu expected lọt; bỏ kiểm run của impact ⇒ impact lệch lọt; khôi phục ⇒ chặn lại cả ba',
    JSON.stringify({ neg1: neg1?.err ?? 'lọt', neg2: neg2?.err ?? 'lọt', neg3: neg3?.err ?? 'lọt', back: Object.fromEntries(Object.entries(back).map(([k, v]) => [k, v?.err ?? 'OK'])) }))
}

// ── §7 REV07 phạm vi file ─────────────────────────────────────────────────────────────────────────────────────────────────────────
async function scopeSection() {
  section('7. REV07 file không được đổi thuộc tính ngoài phạm vi · luồng nạp cũ')
  const E = await env('scope')
  const P = E.LIVE
  const unit = await E.revPreview(P, [{ pid: E.pa, k: '10', unit: 'chai' }, { pid: E.pb, k: '1' }])
  const tgt = await E.revPreview(P, [{ pid: E.pa, k: '10', basis: 'product', target: '1000000' }, { pid: E.pb, k: '1' }])
  const catAdd = await E.revPreview(P, [{ pid: E.pa, k: '10' }, { pid: E.pb, k: '1' }, { pid: E.pid(), k: '1', basis: 'catalog' }], { catalogTarget: '5000000' })
  const same = await E.revPreview(P, [{ pid: E.pa, k: '10' }, { pid: E.pb, k: '1' }])
  const bad = await E.revPreview(P, [{ pid: E.pa, k: '10', tiers: [{ order: 1, from: 1, to: 5, amount: '100' }] }, { pid: E.pb, k: '1' }])
  const unknown = await E.revPreview(P, [{ pid: E.pa, k: '10' }, { pid: E.pb, k: '1' }, { pid: '999999001', k: '1' }])
  ok(unit?.err === 'CMS_REVISION_FIELD_LOCKED' && tgt?.err === 'CMS_REVISION_FIELD_LOCKED' && catAdd?.err === 'CMS_REVISION_CATALOG_UNSUPPORTED'
    && same?.err === 'CMS_REVISION_NO_CHANGE' && bad?.err === 'CMS_REVISION_TIER_LAST_FINITE' && unknown?.err === 'CMS_REVISION_PRODUCT_UNKNOWN',
    'đổi đơn vị / loại + target ⇒ FIELD_LOCKED; thêm SP danh mục ⇒ CATALOG_UNSUPPORTED; không đổi gì ⇒ NO_CHANGE; bậc cuối hữu hạn ⇒ TIER_LAST_FINITE; SP lạ ⇒ PRODUCT_UNKNOWN',
    JSON.stringify({ unit, tgt, catAdd, same, bad, unknown }))
  // Danh mục có SP GMV_TOAN_DANH_MUC: bỏ ⇒ chặn; giữ nguyên + đổi K SP khác được.
  const c1 = E.pid(), c2 = E.pid()
  const CP = await E.makeProgram({ name: 'QA danh mục', products: [{ pid: c1, k: '1', basis: 'catalog' }, { pid: c2, k: '1' }], catalogTarget: '5000000' })
  const rmCat = await E.revPreview(CP, [{ pid: c2, k: '1' }])
  const keepCat = await E.revCommit(await E.revPreview(CP, [{ pid: c1, k: '1', basis: 'catalog' }, { pid: c2, k: '2' }], { catalogTarget: '5000000' }))
  const chgCat = await E.revPreview(CP, [{ pid: c1, k: '1', basis: 'catalog' }, { pid: c2, k: '3' }], { catalogTarget: '6000000' })
  ok(rmCat?.err === 'CMS_REVISION_CATALOG_UNSUPPORTED' && keepCat?.already === false && chgCat?.err === 'CMS_REVISION_CATALOG_UNSUPPORTED',
    'SP danh mục: bỏ ⇒ chặn; giữ (cùng target danh mục) + đổi K SP khác ⇒ được; đổi target danh mục ⇒ chặn', JSON.stringify({ rmCat, keepCat, chgCat }))
  // Luồng nạp cũ: append vào chương trình đã sửa vẫn đúng; SP đã retire ⇒ PRODUCT_EXISTS.
  const a1 = E.pid()
  const AP = await E.makeProgram({ name: 'QA append sau sửa', products: [{ pid: a1, k: '1' }, { pid: E.pid(), k: '1' }] })
  const a2 = AP.products[1].pid
  await E.sync(AP, E.rows(AP, [{ pid: a1, s: 0, base: 1 }, { pid: a2, s: 0, base: 1 }]))
  await E.revCommit(await E.revPreview(AP, [{ pid: a1, k: '1' }]))
  const ap1 = await settle(E.commit(await E.preview(AP.id, 'append'), 'append', [{ pid: E.pid(), k: '1' }]))
  const ap2 = await settle(E.commit(await E.preview(AP.id, 'append'), 'append', [{ pid: a2, k: '1' }]))
  ok(ap1.ok && code(ap2) === 'CMS_IMPORT_PRODUCT_EXISTS', 'nạp thêm (append) sau sửa vẫn được; nạp thêm SP đã retire ⇒ PRODUCT_EXISTS (thêm lại phải qua sửa)', JSON.stringify({ ap1: code(ap1), ap2: code(ap2) }))
  // r2 (PM audit P1-2): run tính ở version N, nạp thêm (N + 1) rồi sửa ⇒ lưu trữ của run cũ căn cứ 'unknown', KHÔNG gán đơn vị / bậc
  // hiện hành cho run khác version; K vẫn là K thực của run (per_unit), số tiền giữ nguyên.
  const g1 = E.pid(), gNew = E.pid()
  const GP = await E.makeProgram({ name: 'QA lưu trữ khác version', products: [{ pid: g1, k: '1' }] })
  await E.sync(GP, E.rows(GP, [{ pid: g1, s: 0, base: 3 }]))
  const gRun = await E.one(`SELECT p.config_version pcv, r.config_version rcv FROM public.cms_programs p JOIN public.cms_sync_runs r ON r.id = p.current_result_run_id WHERE p.id = $1`, [GP.id])
  const gAp = await settle(E.commit(await E.preview(GP.id, 'append'), 'append', [{ pid: gNew, k: '1' }]))
  const gCv = await E.one(`SELECT config_version FROM public.cms_programs WHERE id = $1`, [GP.id])
  const gCm = await E.revCommit(await E.revPreview(GP, [{ pid: g1, k: '1', tiers: T1(150) }, { pid: gNew, k: '1' }]))
  const gArc = await E.asU(U.super, `SELECT public.rpc_cms_program_revision_archive($1, 0, 100) r`, [gCm?.revision_id])
  const gRow = gArc?.rows?.find((r) => r.product_id === g1)
  ok(gAp.ok && gRun.rcv === gRun.pcv && gCv.config_version === gRun.pcv + 1 && gCm?.archive_mode === 'copied' && gRow?.config_basis === 'unknown'
    && gRow.tiers === null && gRow.unit_cms === null && gRow.per_unit === '1' && gRow.amount_vnd === '300',
    'run version N + nạp thêm (N + 1) rồi sửa ⇒ lưu trữ căn cứ unknown: không gán đơn vị / bậc hiện hành cho run khác version; K thực + tiền của run giữ (r2 — P1-2)',
    JSON.stringify({ gAp: code(gAp), gRun, gCv, gCm: gCm?.archive_mode ?? gCm, gRow }))
  const dp = E.pid()
  const DR = await E.makeProgram({ name: 'QA nháp replace', products: [{ pid: dp, k: '1' }], activate: false })
  const rp = await settle(E.commit(await E.preview(DR.id), 'replace', [{ pid: E.pid(), k: '2' }]))
  ok(rp.ok, 'nạp lại (replace) nháp vẫn được — guard cũ không đổi')
}

// ── §8 rollback ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function rollbackSection() {
  section('8. Rollback 131')
  const E = await env('rb')
  const pv = await E.revPreview(E.LIVE, [{ pid: E.pa, k: '5' }, { pid: E.pb, k: '1' }])
  const fresh = await env('rb2')
  await fresh.revPreview(fresh.LIVE, [{ pid: fresh.pa, k: '5' }, { pid: fresh.pb, k: '1' }])
  const rbOk = await settle(fresh.db.exec(RB_131))
  const left = await fresh.one(`SELECT (SELECT count(*)::int FROM pg_attribute WHERE attrelid = 'public.cms_program_products'::regclass AND attname LIKE 'retired%' AND NOT attisdropped) cols,
    to_regclass('public.cms_program_revisions') IS NULL gone, (SELECT count(*)::int FROM public.app_migrations WHERE version = '131') mk,
    (SELECT pg_get_expr(polqual, polrelid) FROM pg_policy WHERE polrelid = 'public.cms_program_products'::regclass) q`)
  const md5s = await fresh.all(`SELECT p.proname n, md5(replace(p.prosrc, E'\\r', '')) m FROM pg_proc p WHERE p.oid IN (SELECT to_regprocedure('public.' || s) FROM unnest($1::text[]) s)`, [CMS_131_REPLACED.map((x) => x.sig)])
  ok(rbOk.ok && left.cols === 0 && left.gone && left.mk === 0 && left.q === '(program_id = ANY (( SELECT cms_readable_program_ids() AS cms_readable_program_ids)::uuid[]))'
    && CMS_131_REPLACED.every((x) => md5s.find((r) => r.n === x.name)?.m === x.base) && await cmsFnCount(fresh) === CMS_131_FN_BEFORE,
    'chỉ có preview ⇒ rollback gỡ về nền 130 (4 hàm md5 gốc, policy gốc, không cột / bảng / marker, 103 hàm)', rbOk.err ?? JSON.stringify(left))
  const re = await settle(fresh.db.exec(SQL_131))
  ok(re.ok, 'áp lại 131 sau rollback được', re.err)
  await E.revCommit(pv)
  const s0 = await E.one(`SELECT (SELECT count(*)::int FROM public.cms_program_revisions) n, (SELECT count(*)::int FROM public.app_migrations WHERE version = '131') mk`)
  const rbStop = await settle(E.db.exec(RB_131))
  await E.db.exec('ROLLBACK').catch(() => {})
  const s1 = await E.one(`SELECT (SELECT count(*)::int FROM public.cms_program_revisions) n, (SELECT count(*)::int FROM public.app_migrations WHERE version = '131') mk`)
  ok(!rbStop.ok && /đã có revision committed/.test(rbStop.err) && JSON.stringify(s0) === JSON.stringify(s1), 'có revision committed ⇒ rollback DỪNG, 0 delta', rbStop.err?.slice(0, 120))
}

// ── §9 CRLF ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function crlfSection() {
  section('9. Dán CRLF (Studio) ≡ LF')
  const E = await env('crlf', { crlf: true })
  ok(E.applied.ok, 'áp 131 dạng CRLF thành công (hậu kiểm md5 thân bỏ \\r)', E.applied.err)
  const r = await E.revCommit(await E.revPreview(E.LIVE, [{ pid: E.pa, k: '5' }, { pid: E.pb, k: '1' }]))
  ok(r?.already === false, 'RPC chạy đúng sau dán CRLF', JSON.stringify(r))
  const rb = await settle(E.db.exec(CRLF(RB_131)))
  ok(!rb.ok && /đã có revision committed/.test(rb.err), 'rollback CRLF vẫn dừng đúng khi có revision', rb.err?.slice(0, 100))
}

// ── §10 preflight ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function preflightSection() {
  section('10. Preflight dừng, 0 delta')
  const cases = [
    ['thiếu marker 130', async (X) => X.db.query(`DELETE FROM public.app_migrations WHERE version = '130'`), /thiếu migration nền 130/],
    ['có migration số > 130', async (X) => X.db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('132', 'x')`), /số > 130/],
    ['run đang chạy', async (X) => X.svc(`SELECT public.rpc_cms_sales_run_open($1, '{}'::jsonb)`, [X.LIVE.id]), /run đang chạy/],
    ['thân hàm thay lệch', async (X) => X.db.exec(`CREATE OR REPLACE FUNCTION public.cms__conflicts(p_program_id uuid, p_is_test boolean, p_start date, p_end date, p_ids text[])
      RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT '{}'::text[] $$`), /thân một trong 4 hàm/],
    ['ACL hàm thay lệch', async (X) => X.db.exec(`GRANT EXECUTE ON FUNCTION public.cms__result_run(uuid,uuid) TO authenticated`), /ACL nền/],
    ['policy đọc SP lệch', async (X) => X.db.exec(`ALTER POLICY cms_program_products_select ON public.cms_program_products USING (true)`), /policy cms_program_products_select/],
    ['đã có cột retired_at', async (X) => X.db.exec(`ALTER TABLE public.cms_program_products ADD COLUMN retired_at timestamptz`), /đã có cột/],
  ]
  for (const [name, mut, re] of cases) {
    const X = await env(`pf_${name}`, { apply: false })
    await mut(X)
    const before = await X.one(`SELECT (SELECT count(*)::int FROM public.app_migrations) m, (SELECT count(*)::int FROM pg_proc WHERE proname LIKE '%revision%') f,
      to_regclass('public.cms_program_revisions') IS NULL t`)
    const r = await settle(X.db.exec(SQL_131))
    await X.db.exec('ROLLBACK').catch(() => {})
    const after = await X.one(`SELECT (SELECT count(*)::int FROM public.app_migrations) m, (SELECT count(*)::int FROM pg_proc WHERE proname LIKE '%revision%') f,
      to_regclass('public.cms_program_revisions') IS NULL t`)
    ok(!r.ok && re.test(r.err) && JSON.stringify(before) === JSON.stringify(after), `preflight: ${name} ⇒ dừng, 0 delta`, r.err?.slice(0, 140))
  }
}

// ── §11 (PG15) đua hai phiên ──────────────────────────────────────────────────────────────────────────────────────────────────────
async function raceSection() {
  section('11. Hai phiên (PG15)')
  const E = await env('race')
  const P = E.LIVE
  const Bc = await pgConn(E.dbName)
  const asB = async (uid, sql, params) => {
    await Bc.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [uid ?? ''])
    await Bc.query(`SET ROLE authenticated`)
    try { return (await Bc.query(sql, params)).rows[0].r } catch (e) { return { err: /\bCMS_[A-Z0-9_]+\b/.exec(String(e.message))?.[0] ?? String(e.message).slice(0, 120) } } finally { await Bc.query('RESET ROLE') }
  }
  const COMMIT = `SELECT public.rpc_cms_program_revision_commit($1, $2, $3, $4, $5, $6::jsonb) r`
  const args = (pv, key = uuid()) => [pv.revision_id, pv.from_config_version, pv.payload_digest, key, 'QA hai phiên cùng sửa', JSON.stringify({ whole_period: true, may_decrease: true, removed: pv.diff.removed })]
  // A giữ khoá chương trình (BEGIN + commit revision chưa COMMIT); B commit preview khác cùng version ⇒ chờ rồi STALE.
  const p1 = await E.revPreview(P, [{ pid: E.pa, k: '5' }, { pid: E.pb, k: '1' }])
  const p2 = await E.revPreview(P, [{ pid: E.pa, k: '6' }, { pid: E.pb, k: '1' }])
  await E.db.query(`BEGIN`)
  await E.db.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [U.super])
  await E.db.query(`SET LOCAL ROLE authenticated`)
  const ra = (await E.db.query(COMMIT, args(p1))).rows[0].r
  let bDone = false
  const bp = asB(U.super, COMMIT, args(p2)).then((x) => { bDone = true; return x })
  await sleep(600)
  const waited = !bDone
  await E.db.query(`COMMIT`)
  const rb = await bp
  ok(ra.already === false && waited && rb?.err === 'CMS_REVISION_PREVIEW_STALE', 'A ghi giữ khoá; B (preview khác cùng version) CHỜ rồi PREVIEW_STALE — không hai commit cùng thắng', JSON.stringify({ ra, waited, rb }))
  // Cùng preview + cùng key hai phiên ⇒ một ghi, một already.
  const p3 = await E.revPreview(P, [{ pid: E.pa, k: '7' }, { pid: E.pb, k: '1' }])
  const key = uuid()
  const [x1, x2] = await Promise.all([E.revCommit(p3, { key }), asB(U.super, COMMIT, args(p3, key))])
  ok([x1, x2].filter((x) => x?.already === false).length === 1 && [x1, x2].filter((x) => x?.already === true).length === 1, 'cùng preview + key song song ⇒ đúng một ghi + một already', JSON.stringify([x1, x2]))
  // Commit × mở run: open giữ khoá ⇒ commit chờ rồi BUSY; commit trước ⇒ open thấy version mới.
  const p4 = await E.revPreview(P, [{ pid: E.pa, k: '8' }, { pid: E.pb, k: '1' }])
  await E.db.query(`BEGIN`)
  await E.db.query(`SET LOCAL ROLE service_role`)
  await E.db.query(`SELECT public.rpc_cms_sales_run_open($1, '{}'::jsonb)`, [P.id])
  let cDone = false
  const cp = asB(U.super, COMMIT, args(p4)).then((x) => { cDone = true; return x })
  await sleep(600)
  const w2 = !cDone
  await E.db.query(`COMMIT`)
  const rc = await cp
  ok(w2 && rc?.err === 'CMS_SYNC_BUSY', 'mở run giữ khoá chương trình; commit CHỜ rồi CMS_SYNC_BUSY (không đổi cấu hình dưới run đang tính)', JSON.stringify({ w2, rc }))
  await E.db.query(`UPDATE public.cms_sync_runs SET status = 'error', finished_at = now(), error_code = 'QA_STOP' WHERE program_id = $1 AND status = 'running'`, [P.id])
  // r2 (PM audit P1-1): sửa × chốt hai phiên, hai chiều — không cùng thành công sai trạng thái.
  const LD = lockDeps(E)
  const asBsvc = async (sql, params) => {
    await Bc.query(`SET ROLE service_role`)
    try { return (await Bc.query(sql, params)).rows[0].r } catch (e) { return { err: /\bCMS_[A-Z0-9_]+\b/.exec(String(e.message))?.[0] ?? String(e.message).slice(0, 120) } } finally { await Bc.query('RESET ROLE') }
  }
  const LOCK = `SELECT public.rpc_cms_program_lock($1, $2, $3, $4, $5) r`
  const ended = async (name) => {
    const pid = E.pid()
    const X = await E.makeProgram({ name, isTest: true, products: [{ pid, k: '1' }], dates: [await E.day(-40), await E.day(-10)] })
    await E.sync(X, E.rows(X, [{ pid, s: 0, base: 4 }]))
    const lp = await LA.runCmsLockPreview(LD, X.id)
    return { X, pid, pv: lp.ok ? lp.preview.policyVersion : null, run: (await E.prog(X.id)).ptr }
  }
  // (a) Sửa giữ khoá trước; chốt CHỜ rồi bị từ chối (run hiện hành thuộc cấu hình trước sửa) — không chốt trên số đã che.
  const A1 = await ended('QA sửa trước chốt')
  const pA = await E.revPreview(A1.X, [{ pid: A1.pid, k: '2' }])
  await E.db.query(`BEGIN`)
  await E.db.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [U.super])
  await E.db.query(`SET LOCAL ROLE authenticated`)
  const raL = (await E.db.query(COMMIT, args(pA))).rows[0].r
  let lDone = false
  const lp1 = asBsvc(LOCK, [A1.X.id, A1.run, A1.pv, U.super, 'QA chốt song song khi đang sửa']).then((x) => { lDone = true; return x })
  await sleep(600)
  const wL = !lDone
  await E.db.query(`COMMIT`)
  const rbL = await lp1
  const stA = await E.one(`SELECT status, config_version FROM public.cms_programs WHERE id = $1`, [A1.X.id])
  const payA = await settle(E.one(`SELECT count(*)::int n FROM public.cms_payouts WHERE program_id = $1`, [A1.X.id]))
  ok(A1.pv !== null && raL?.already === false && wL && typeof rbL?.err === 'string' && /^CMS_/.test(rbL.err) && stA.status !== 'locked' && payA.ok && payA.v.n === 0,
    'sửa giữ khoá; chốt (RPC lock thật) CHỜ rồi bị từ chối — chương trình không chốt trên run trước sửa, 0 payout (r2)', JSON.stringify({ raL: raL?.already, wL, rbL, stA, payA }))
  // (b) Chốt giữ khoá trước; sửa CHỜ rồi CMS_PROGRAM_LOCKED — version / pointer không đổi.
  const B1 = await ended('QA chốt trước sửa')
  const pB = await E.revPreview(B1.X, [{ pid: B1.pid, k: '2' }])
  const sB0 = await E.snap(B1.X.id)
  await E.db.query(`BEGIN`)
  await E.db.query(`SET LOCAL ROLE service_role`)
  const lkB = await settle(E.db.query(LOCK, [B1.X.id, B1.run, B1.pv, U.super, 'QA chốt giữ khoá trước khi sửa']))
  let cDoneB = false
  const cpB = asB(U.super, COMMIT, args(pB)).then((x) => { cDoneB = true; return x })
  await sleep(600)
  const wB = !cDoneB
  await E.db.query(lkB.ok ? `COMMIT` : `ROLLBACK`)
  const rcB = await cpB
  const sB1 = await E.snap(B1.X.id)
  const stB = await E.one(`SELECT status FROM public.cms_programs WHERE id = $1`, [B1.X.id])
  ok(B1.pv !== null && lkB.ok && wB && rcB?.err === 'CMS_PROGRAM_LOCKED' && stB.status === 'locked' && sB1.p.v === sB0.p.v && sB1.p.ptr === sB0.p.ptr,
    'chốt giữ khoá; sửa CHỜ rồi CMS_PROGRAM_LOCKED — version / pointer không đổi (r2)', JSON.stringify({ lk: lkB.ok ? 'ok' : lkB.err?.slice(0, 120), wB, rcB, stB, v0: sB0.p.v, v1: sB1.p.v }))

  // r3 (PM P1-01): công bố run mới giữ khoá chương trình (chưa COMMIT) × lưu preview ghim run cũ ở phiên khác ⇒ preview CHỜ (FOR SHARE)
  // rồi PREVIEW_STALE, 0 revision. Đối chứng âm: bỏ FOR SHARE ⇒ preview KHÔNG chờ, đọc pointer cũ đã commit, lưu revision lệch run.
  const nRev = async (id) => Number((await E.one(`SELECT count(*)::int n FROM public.cms_program_revisions WHERE program_id = $1`, [id])).n)
  const raceRun = async (X, rws, body) => {
    const out = { waited: null, res: null, pubErr: null }
    const deps = E.syncDeps(rws)
    const pub0 = deps.publish
    deps.publish = async (runId) => {
      await E.db.query('BEGIN')
      let r
      try { r = await pub0(runId) } catch (e) { out.pubErr = String(e.message); await E.db.query('ROLLBACK'); throw e }
      let done = false
      const pp = asB(U.super, PREVIEW, [JSON.stringify(body)]).then((x) => { done = true; return x })
      await sleep(600)
      out.waited = !done
      await E.db.query('COMMIT')
      out.res = await pp
      return r
    }
    out.sync = (await SS.runCmsSalesSync(deps, X.id, { dryRun: false, source: X.isTest ? 'qa' : 'cron', sourceCapture: true })).status
    return out
  }
  const rp = E.pid()
  const RX = await E.makeProgram({ name: 'QA đua dự toán × công bố', products: [{ pid: rp, k: '1' }] })
  const RX_ROWS = E.rows(RX, [{ pid: rp, s: 0, base: 3 }])
  await E.sync(RX, RX_ROWS)
  const rA = (await E.prog(RX.id)).ptr
  const bodyR = await E.revBody(RX, [{ pid: rp, k: '2' }])
  const nR0 = await nRev(RX.id)
  const rr = await raceRun(RX, RX_ROWS, bodyR)
  const rB = (await E.prog(RX.id)).ptr
  ok(rr.sync === 'published' && rB !== rA && bodyR.expected_run_id === rA && rr.waited === true && rr.res?.err === 'CMS_REVISION_PREVIEW_STALE' && await nRev(RX.id) === nR0,
    'r3: công bố run mới giữ khoá; preview (ghim run cũ) CHỜ rồi PREVIEW_STALE, 0 revision mới', JSON.stringify({ rr, rA, rB }))
  const restore = await mutateFn(E, PREVIEW_SIG, [['WHERE id = v_pid FOR SHARE;', 'WHERE id = v_pid;']])
  const bodyN = await E.revBody(RX, [{ pid: rp, k: '2' }])
  const rn = await raceRun(RX, RX_ROWS, bodyN)
  await restore()
  const rN = (await E.prog(RX.id)).ptr
  const negRow = rn.res?.revision_id ? await E.one(`SELECT expected_run_id::text x FROM public.cms_program_revisions WHERE id = $1`, [rn.res.revision_id]) : null
  // Bản đột biến vẫn có thể CHỜ ở bước sau (khoá FK lúc INSERT) — nhưng đã đọc pointer cũ TRƯỚC khi chờ ⇒ lưu revision lệch run. Điều cần
  // chứng minh là kết cục (revision ghim run cũ được tạo), không phải có chờ hay không.
  // db-reviewer r3 P2-4d — chiều ngược: preview giữ FOR SHARE (transaction chưa COMMIT) × mở run ở phiên khác ⇒ mở run CHỜ rồi thành công
  // (không deadlock / 55P03); pointer không đổi ⇒ commit preview đó (sau khi run đóng) thành công, không STALE nhầm.
  const bodyR2 = await E.revBody(RX, [{ pid: rp, k: '3' }])
  await E.db.query(`BEGIN`)
  await E.db.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [U.super])
  await E.db.query(`SET LOCAL ROLE authenticated`)
  const pvHeld = (await E.db.query(PREVIEW, [JSON.stringify(bodyR2)])).rows[0].r
  let oDone = false
  const op = asBsvc(`SELECT public.rpc_cms_sales_run_open($1, '{}'::jsonb) r`, [RX.id]).then((x) => { oDone = true; return x })
  await sleep(600)
  const wO = !oDone
  await E.db.query(`COMMIT`)
  const ro = await op
  await E.db.query(`UPDATE public.cms_sync_runs SET status = 'error', finished_at = now(), error_code = 'QA_STOP' WHERE program_id = $1 AND status = 'running'`, [RX.id])
  const kHeld = await E.revCommit(pvHeld)
  ok(!!pvHeld?.revision_id && wO && ro && !ro.err && kHeld?.already === false,
    'r3: preview giữ FOR SHARE; mở run phiên khác CHỜ rồi thành công (không deadlock / lock_timeout); commit preview đó sau khi run đóng ⇒ thành công (không STALE nhầm)',
    JSON.stringify({ pv: pvHeld?.err ?? pvHeld?.revision_id, wO, ro, kHeld }))
  ok(rn.sync === 'published' && !!rn.res?.revision_id && negRow?.x === bodyN.expected_run_id && negRow.x !== rN,
    'đối chứng âm: bỏ FOR SHARE ⇒ preview đọc pointer cũ đã commit, LƯU revision ghim run cũ trong khi run mới đã công bố (test trên bắt được)',
    JSON.stringify({ waited: rn.waited, res: rn.res?.err ?? rn.res?.revision_id, negRow, rN }))
}

// ── §12 (PG15) bench ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function benchSection() {
  section('12. Bench (PG15): 83 SP · nhiều dược sĩ · preview / commit / lưu trữ / reader < 8 s')
  const E = await env('bench')
  const N_SP = 83
  const prods = Array.from({ length: N_SP }, () => ({ pid: E.pid(), k: '10', tiers: [{ order: 1, from: 1, to: 9, amount: '1000' }, { order: 2, from: 10, to: null, amount: '1500' }] }))
  const P = await E.makeProgram({ name: 'QA bench 83', products: prods })
  // 25 store × 2 dược sĩ có trong fixture: mở rộng phạm vi bằng chương trình scope 2 store ⇒ dùng 3 người bán × 83 SP × 40 đơn.
  const specs = []
  for (let i = 0; i < 40; i++) for (const p of prods) specs.push({ pid: p.pid, s: i % 3, base: 5 + (i % 7) })
  const t0 = Date.now()
  const sy = await E.sync(P, E.rows(P, specs))
  const tSync = Date.now() - t0
  const next = prods.map((p, i) => ({ ...p, k: i % 2 ? '5' : '20' }))
  next.pop()
  const tm = {}
  let t = Date.now(); const pv = await E.revPreview(P, next); tm.preview = Date.now() - t
  t = Date.now(); const cm = await E.revCommit(pv); tm.commit = Date.now() - t
  t = Date.now(); const ar = await E.asU(U.super, `SELECT public.rpc_cms_program_revision_archive($1, 0, 1000) r`, [cm.revision_id]); tm.archive = Date.now() - t
  t = Date.now(); const dt = await E.asU(U.super, `SELECT public.rpc_cms_program_revision($1) r`, [cm.revision_id]); tm.detail = Date.now() - t
  t = Date.now(); const hd = await header(E, U.A, P.id); tm.header = Date.now() - t
  console.log(`  · sync ${specs.length} dòng ${tSync} ms · ${JSON.stringify(tm)} · lưu trữ ${cm.archive_rows} dòng`)
  ok(sy.status === 'published' && pv?.diff?.change === N_SP - 1 && pv.diff.remove === 1 && cm?.already === false && cm.archive_rows === 3 * N_SP
    && ar?.rows?.length === 3 * N_SP && dt?.diff?.items?.length === N_SP && hd?.run === null && Object.values(tm).every((x) => x < 8000),
    `83 SP: preview / commit / lưu trữ / chi tiết / header mỗi lời gọi < 8 s`, JSON.stringify({ sy: sy.status, diff: pv?.diff, cm, tm }))

  // 83 SP × 50 dược sĩ (25 nhà thuốc — cỡ chương trình thật 83 SP, scope rộng): mỗi dược sĩ bán mỗi SP 3 đơn.
  const prodsW = Array.from({ length: N_SP }, () => ({ pid: E.pid(), k: '10', tiers: [{ order: 1, from: 1, to: 9, amount: '1000' }, { order: 2, from: 10, to: null, amount: '1500' }] }))
  const PW = await E.makeProgram({ name: 'QA bench 83 × 50', products: prodsW, storeCount: 25 })
  const specsW = []
  for (const em of E.SELLERS_ALL) for (const p of prodsW) for (let j = 0; j < 3; j++) specsW.push({ pid: p.pid, email: em, base: 7 + j })
  let tw = Date.now()
  const syW = await E.sync(PW, E.rows(PW, specsW))
  const tSyncW = Date.now() - tw
  const nextW = prodsW.map((p, i) => ({ ...p, k: i % 2 ? '5' : '20' }))
  const tmW = {}
  tw = Date.now(); const pvW = await E.revPreview(PW, nextW); tmW.preview = Date.now() - tw
  tw = Date.now(); const cmW = await E.revCommit(pvW); tmW.commit = Date.now() - tw
  tw = Date.now(); const arW = await E.asU(U.super, `SELECT public.rpc_cms_program_revision_archive($1, 3000, 1000) r`, [cmW.revision_id]); tmW.archivePage = Date.now() - tw
  tw = Date.now(); const lsW = await E.asU(U.super, `SELECT public.rpc_cms_program_revisions($1) r`, [PW.id]); tmW.list = Date.now() - tw
  tw = Date.now(); const stW = await E.asU(U.A, `SELECT public.rpc_cms_program_revision_state($1) r`, [PW.id]); tmW.state = Date.now() - tw
  console.log(`  · 83 × 50: sync ${specsW.length} dòng ${tSyncW} ms · ${JSON.stringify(tmW)} · lưu trữ ${cmW?.archive_rows} dòng`)
  ok(syW.status === 'published' && pvW?.diff?.change === N_SP && cmW?.archive_rows === 50 * N_SP && arW?.rows?.length === 1000 && arW.total === 50 * N_SP
    && Array.isArray(lsW) && lsW.length === 1 && stW?.masked === true && Object.values(tmW).every((x) => x < 8000),
    `83 SP × 50 dược sĩ (${specsW.length} dòng, lưu trữ ${50 * N_SP} dòng): preview / commit / trang lưu trữ / lịch sử / trạng thái mỗi lời gọi < 8 s`, JSON.stringify({ sy: syW.status, cm: cmW, tmW }))

  // Trần cấu hình nhận (cms__revision_norm): 2.000 SP × 1 bậc. Sửa K toàn bộ.
  const N_MAX = 2000
  const prodsM = Array.from({ length: N_MAX }, () => ({ pid: E.pid(), k: '10', tiers: [{ order: 1, from: 1, to: null, amount: '1000' }] }))
  const PM = await E.makeProgram({ name: 'QA bench 2000', products: prodsM })
  const specsM = prodsM.map((p, i) => ({ pid: p.pid, s: i % 3, base: 20 }))
  tw = Date.now()
  const syM = await E.sync(PM, E.rows(PM, specsM))
  const tSyncM = Date.now() - tw
  const tmM = {}
  tw = Date.now(); const pvM = await E.revPreview(PM, prodsM.map((p) => ({ ...p, k: '5' }))); tmM.preview = Date.now() - tw
  tw = Date.now(); const cmM = await E.revCommit(pvM); tmM.commit = Date.now() - tw
  tw = Date.now(); const dtM = await E.asU(U.super, `SELECT public.rpc_cms_program_revision($1) r`, [cmM.revision_id]); tmM.detail = Date.now() - tw
  console.log(`  · 2.000 SP: sync ${specsM.length} dòng ${tSyncM} ms · ${JSON.stringify(tmM)} · lưu trữ ${cmM?.archive_rows} dòng`)
  const over = await E.revPreview(PM, [...prodsM, { pid: E.pid(), k: '1' }])
  ok(syM.status === 'published' && pvM?.diff?.change === N_MAX && cmM?.archive_rows === N_MAX && dtM?.diff?.items?.length === N_MAX
    && Object.values(tmM).every((x) => x < 8000) && over?.err === 'CMS_REVISION_BAD_PAYLOAD',
    `trần cấu hình 2.000 SP: preview / commit / chi tiết mỗi lời gọi < 8 s; 2.001 SP ⇒ BAD_PAYLOAD`, JSON.stringify({ sy: syM.status, cm: cmM, tmM, over: over?.err ?? 'OK' }))

  // r3 (PM P1-04): bỏ HÀNG LOẠT SP ĐÃ có dữ liệu (retire) — giữ 1 / bỏ 82 trên 83 và giữ 1 / bỏ 1.999 trên 2.000. Mỗi lời gọi < 8 s;
  // kiểm số retire / xoá, cấu hình hiệu lực, ảnh chụp trước / sau, lịch sử, lưu trữ, dữ liệu run không mất, version +1, pointer giữ.
  const bulk = async (label, n, specsFor) => {
    const ps = Array.from({ length: n }, () => ({ pid: E.pid(), k: '10', tiers: T1(1000) }))
    const X = await E.makeProgram({ name: label, products: ps })
    let q = Date.now()
    const sy = await E.sync(X, E.rows(X, specsFor(ps)))
    const tSync = Date.now() - q
    const s0 = await E.snap(X.id)
    const res0 = await E.one(`SELECT count(*)::int n, count(DISTINCT program_product_id)::int sp FROM public.cms_results WHERE program_id = $1 AND run_id = $2`, [X.id, s0.p.ptr])
    const t = {}
    q = Date.now(); const pv = await E.revPreview(X, [ps[0]]); t.preview = Date.now() - q
    q = Date.now(); const cm = await E.revCommit(pv); t.commit = Date.now() - q
    q = Date.now(); const dt = await E.asU(U.super, `SELECT public.rpc_cms_program_revision($1) r`, [cm?.revision_id]); t.detail = Date.now() - q
    q = Date.now(); const ls = await E.asU(U.super, `SELECT public.rpc_cms_program_revisions($1) r`, [X.id]); t.list = Date.now() - q
    q = Date.now(); const ar = await E.asU(U.super, `SELECT public.rpc_cms_program_revision_archive($1, 0, 1000) r`, [cm?.revision_id]); t.archive = Date.now() - q
    q = Date.now(); const st = await E.asU(U.A, `SELECT public.rpc_cms_program_revision_state($1) r`, [X.id]); t.state = Date.now() - q
    q = Date.now(); const hd = await header(E, U.A, X.id); t.header = Date.now() - q
    const pp = await E.one(`SELECT count(*)::int n, count(*) FILTER (WHERE retired_at IS NOT NULL)::int r, count(*) FILTER (WHERE retired_revision_id = $2)::int rr
      FROM public.cms_program_products WHERE program_id = $1`, [X.id, cm?.revision_id ?? null])
    const cfg = await E.one(`SELECT jsonb_array_length(public.cms__revision_config($1)->'products') n`, [X.id])
    const sn = cm?.revision_id ? await E.one(`SELECT jsonb_array_length(before_snapshot->'products') b, jsonb_array_length(after_snapshot->'products') a, status
      FROM public.cms_program_revisions WHERE id = $1`, [cm.revision_id]) : null
    const res1 = await E.one(`SELECT count(*)::int n FROM public.cms_results WHERE program_id = $1 AND run_id = $2`, [X.id, s0.p.ptr])
    const s1 = await E.snap(X.id)
    console.log(`  · bỏ ${n - 1}/${n} SP có dữ liệu: sync ${tSync} ms · ${JSON.stringify(t)} · retire ${cm?.retired} · xoá ${cm?.deleted} · lưu trữ ${cm?.archive_rows} dòng`)
    ok(sy.status === 'published' && res0.sp === n && pv?.diff?.remove === n - 1 && pv.diff.removed?.length === n - 1 && pv.diff.products_after === 1
      && cm?.already === false && cm.retired === n - 1 && cm.deleted === 0 && cm.archive_rows === res0.n
      && pp.n === n && pp.r === n - 1 && pp.rr === n - 1 && cfg.n === 1 && sn?.b === n && sn?.a === 1 && sn?.status === 'committed'
      && dt?.diff?.remove === n - 1 && Array.isArray(ls) && ls.length === 1 && ar?.total === res0.n && st?.masked === true && hd?.run === null
      && res1.n === res0.n && s1.p.v === s0.p.v + 1 && s1.p.ptr === s0.p.ptr && s1.arc.n === res0.n
      && Object.values(t).every((x) => x < 8000),
      `bỏ ${n - 1}/${n} SP đã có dữ liệu (giữ 1): preview / commit / chi tiết / lịch sử / lưu trữ / trạng thái / header mỗi lời gọi < 8 s; retire ${n - 1}, xoá 0, cấu hình hiệu lực 1 SP, snapshot trước ${n} / sau 1, dữ liệu run giữ nguyên, version +1, pointer giữ`,
      JSON.stringify({ sy: sy.status, res0, diff: { ...pv?.diff, items: undefined, removed: pv?.diff?.removed?.length }, cm, pp, cfg, sn, ls: ls?.length, ar: ar?.total, st: st?.masked, hd: hd?.run, res1, v: [s0.p.v, s1.p.v], t }).slice(0, 900))
  }
  await bulk('QA bench bỏ 82/83', N_SP, (ps) => ps.flatMap((p) => [0, 1, 2].flatMap((s) => [{ pid: p.pid, s, base: 4 }, { pid: p.pid, s, base: 6 }])))
  await bulk('QA bench bỏ 1999/2000', N_MAX, (ps) => ps.map((p, i) => ({ pid: p.pid, s: i % 3, base: 12 })))
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
await new Promise((resolve) => process.stdout.write('', resolve))
process.exit(fail ? 1 : 0)
