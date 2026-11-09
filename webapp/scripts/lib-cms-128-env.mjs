// Môi trường DB dùng chung cho harness CMS 128 (scripts/qa-cms-128.mjs) và datafix T11 CMS-UNIT (scripts/qa-cms-unit-t11.mjs): backend
// PGlite (Postgres 16 WASM) hoặc PostgreSQL 15 embedded (127.0.0.1) · chuỗi migration THẬT 120 → 126 + marker 127 mô phỏng · helper
// chương trình / dòng bán giả / đồng bộ app thật / stage trực tiếp / reader / VERIFY. TÁCH NGUYÊN VĂN từ qa-cms-128 (UNIT-4), chỉ tham số
// hoá cổng / tiền tố DB và nhận module TS từ caller (một bản module cho cả harness — không lệch instanceof). KHÔNG chạm DB thật / mạng.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as L from './lib-care-pglite.mjs'

const { U, storeId, STORES, sha } = L
const MIG = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'supabase', 'migrations')
const SQL = (f) => fs.readFileSync(path.join(MIG, f), 'utf8')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const lastRows = (results) => { for (let i = results.length - 1; i >= 0; i--) if (results[i].rows?.length) return results[i].rows; return [] }

/**
 * o.libs: { T: e2e/cmsQaTooling, C: lib/cms/source/contract, SS: lib/cms/salesSync, RS: lib/cms/resultStage, EN: lib/cms/engine/compute,
 *           QR: e2e/cmsQaResults, FX: e2e/cmsFixtureRunner } (đã nạp bằng jiti của caller)
 * o.pg15: null (PGlite) | { modDir, dataRoot } · o.port (PG15, mặc định 54358) · o.dbPrefix (mặc định rpgcms128)
 */
export function createCmsEnv(o) {
  const { T, C, SS, RS, EN, QR, FX } = o.libs
  const PG15 = !!o.pg15
  const argv = PG15 ? ['--pg15', o.pg15.modDir, o.pg15.dataRoot] : []
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
      PORT = o.port ?? 54358; PASS = 'qa-local-only'
      cluster = new EmbeddedPostgres({ databaseDir: path.join(path.resolve(dataRoot), `pgdata-${o.dbPrefix ?? 'cms128'}-${Date.now()}`), user: 'postgres', password: PASS, port: PORT,
        persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {}, onError: () => {} })
      await cluster.initialise(); await cluster.start()
    }
    const name = `${o.dbPrefix ?? 'rpgcms128'}_${tag}`
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

  /** Người bán: 2 nhà thuốc trong phạm vi (4 dược sĩ) + 1 nhà thuốc ngoài phạm vi. */
  const SELLERS = [STORES[0].assigneeEmails[0], STORES[0].assigneeEmails[1], STORES[1].assigneeEmails[0], STORES[1].assigneeEmails[1]]
  const SELLER_IDS = [L.staffId(1, 'a'), L.staffId(1, 'b'), L.staffId(2, 'a'), L.staffId(2, 'b')]
  const OUT_EMAIL = STORES[2].assigneeEmails[0]
  const ORACLE_SELLERS = [0, 1, 2].flatMap((i) => ['a', 'b'].map((ab, j) => ({ email: STORES[i].assigneeEmails[j], userId: L.staffId(i + 1, ab), storeId: storeId(i + 1) })))

  /** Môi trường một DB: 120 → 126 + marker 127 (PRE chụp ngay trước 127 / 128), helper chương trình / bán / đồng bộ / stage trực tiếp. */
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
    const pre127 = await snapshot()
    await db.query(`INSERT INTO public.app_migrations (version, name, notes) VALUES ('127', 'cms_t11_flat_amounts', '{"qa": "128 — marker mô phỏng, 127 chỉ dữ liệu"}')`)
    await sleep(20)
    const pre128 = await snapshot()
    await db.query(`INSERT INTO public.cms_product_master (product_id, product_name, is_active, source_updated_at)
      SELECT g::text, 'SP giả ' || g, true, now() FROM generate_series(958001, 960200) g`)
    await db.query(`INSERT INTO public.cms_qa_access (user_id, granted_by, expires_at) VALUES ($1, 'qa-script:cms-128', now() + interval '6 hours')`, [U.super])
    let pidNext = 958001, seqf = 0, lineSeq = 0
    const pid = () => String(pidNext++)
    const day = async (n) => { const t = (await one(`SELECT public.cms__vn_today()::text d`)).d; const d = new Date(`${t}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
    const prodPayload = (p) => ({ product_id: p.pid, gmv_basis: p.basis ?? 'none', target_gmv: p.target ?? null, base_quantity_cms: p.k ?? '1', tiers: p.tiers,
      unit_cms: p.unit ?? 'hộp', advice_text: 'QA', name_snapshot: 'SP giả', image_url_snapshot: null, price_snapshot: null })
    async function preview(id, mode = 'replace') {
      const fileSha = sha(`f128-${tag}-${++seqf}`), digest = sha(`d128-${tag}-${seqf}`)
      const run = (await svc(`SELECT public.rpc_cms_import_preview_save($1::jsonb) id`, [JSON.stringify({ program_id: id, mode, file_name: 'qa.xlsx', file_sha256: fileSha,
        file_bytes: 10, actor: U.super, stats: { rowsTotal: 1, rowsOk: 1, rowsRejected: 0, warnings: 0, productsOk: 1, productsRejected: 0 }, result: { digest } })])).rows[0].id
      return { run, fileSha, digest }
    }
    const commit = async (pr, mode, products, catalogTarget = null) => (await svc(`SELECT public.rpc_cms_import_commit($1, $2, $3, $4::jsonb, $5) r`,
      [pr.run, pr.fileSha, pr.digest, JSON.stringify({ mode, catalog_target: catalogTarget, products: products.map(prodPayload) }), U.super])).rows[0].r
    const rpc = async (sql, params) => { try { return (await svc(sql, params)).rows[0].r } catch (e) { const m = /\b(CMS_[A-Z0-9_]+)\b/.exec(String(e.message)); throw new Error(m ? m[1] : `RPC_FAILED ${String(e.message).slice(0, 160)}`) } }
    async function saveProgram(o) {
      return (await svc(`SELECT public.rpc_cms_program_save($1::jsonb) id`, [JSON.stringify({ actor: U.super, ...o })])).rows[0].id
    }
    async function makeProgram({ name, isTest = true, products, basis = null, catalogTarget = null, activate = true }) {
      const start = await day(-20), end = await day(-1)
      const id = await saveProgram({ name, start_date: start, end_date: end, scope: 'stores', store_ids: [storeId(1), storeId(2)], is_test: isTest,
        ...(basis ? { quantity_basis: basis } : {}) })
      await commit(await preview(id), 'replace', products, catalogTarget)
      if (activate) await svc(`SELECT public.rpc_cms_program_activate($1, $2)`, [id, U.super])
      return { id, products, start, end, isTest, catalogTarget, storeIds: [storeId(1), storeId(2)] }
    }
    /** Dòng nguồn giả trong kỳ. spec: { pid, s (0…3) | email | out, base, gmv, qty, uom, type, n, m (khai báo TAY: đúng ĐV CMS?) }. */
    const fx = new Map()
    function rows(p, specs) {
      const out = []
      const t0 = Date.parse(`${p.start}T01:00:00Z`)
      for (const sp of specs) for (let i = 0; i < (sp.n ?? 1); i++) {
        const id = ++lineSeq
        const at = new Date(t0 + id * 1000).toISOString()
        const email = sp.out ? OUT_EMAIL : sp.email ?? SELLERS[sp.s ?? 0]
        const r = { order_line_id: String(958000000 + id), order_id: `O${id}`, order_code: `QA-${id}`, product_id: sp.pid, seller_email: email, pos_code: 'QAOS01',
          order_type: sp.type ?? 'OFFLINE', order_status: 'COMPLETED', completed_at: at, quantity_raw: sp.qty ?? '1', uom_raw: sp.uom === undefined ? 'Hộp' : sp.uom,
          base_quantity: String(sp.base ?? 1), gmv_amount: String(sp.gmv ?? 10000), source_updated_at: at }
        out.push(r)
        // Fixture SQL độc lập: người nhận + cờ đúng ĐV do NGƯỜI VIẾT khai báo (không suy từ engine / khoá đơn vị).
        if (sp.m !== undefined) fx.set(r.order_line_id, { order_line_id: r.order_line_id, user_id: sp.email || sp.out || sp.type === 'ONLINE' ? null : SELLER_IDS[sp.s ?? 0],
          pid: sp.pid, qty: sp.qty ?? '1', m: sp.m, inc: !(sp.email || sp.out || sp.type === 'ONLINE') })
      }
      for (const r of out) if (!C.normalizeSalesRow(r).ok) throw new Error('dòng giả lỗi ' + JSON.stringify(r))
      return out
    }
    const timings = []
    const timed = (fn, label) => async (...a) => { const t = Date.now(); try { return await fn(...a) } finally { timings.push({ label, ms: Date.now() - t }) } }
    const syncDeps = (rws) => ({
      table: QR.CMS_QA_FAKE_TABLE, runner: FX.createCmsFixtureRunner({ sales: rws }),
      loadSnapshot: (id) => rpc(`SELECT public.rpc_cms_sales_snapshot($1) r`, [id]),
      openRun: (id, detail) => rpc(`SELECT public.rpc_cms_sales_run_open($1, $2::jsonb) r`, [id, JSON.stringify(detail)]),
      stage: async (runId, part, chunkNo, x) => { const t = Date.now(); try { return Number(await rpc(`SELECT public.rpc_cms_sales_run_stage($1, $2, $3, $4::jsonb) r`, [runId, part, chunkNo, JSON.stringify(x)])) } finally { timings.push({ label: 'stage', part, chunkNo, ms: Date.now() - t }) } },
      sealBegin: timed((runId, expect) => rpc(`SELECT public.rpc_cms_sales_run_seal_begin($1, $2::jsonb) r`, [runId, JSON.stringify(expect)]), 'seal_begin'),
      sealStep: async (runId, step) => { const t = Date.now(); try { return await rpc(`SELECT public.rpc_cms_sales_run_seal_step($1, $2) r`, [runId, step]) } finally { timings.push({ label: 'seal_step', step, ms: Date.now() - t }) } },
      publish: timed((runId) => rpc(`SELECT public.rpc_cms_sales_run_publish($1) r`, [runId]), 'publish'),
      finish: async (runId, status, detail) => { await rpc(`SELECT public.rpc_cms_sales_run_finish($1, $2, $3::jsonb) r`, [runId, status, JSON.stringify(detail)]) },
      cleanup: (id, max) => rpc(`SELECT public.rpc_cms_sales_run_cleanup($1, $2) r`, [id, max]),
      now: () => Date.now(),
    })
    const sync = (p, rws, o = {}) => SS.runCmsSalesSync(syncDeps(rws), p.id, { dryRun: false, source: o.source ?? 'cron', sourceCapture: true, unitBasisEnabled: o.flag ?? true })
    /**
     * Stage + seal TRỰC TIẾP qua RPC (bỏ qua chặn của app — mô phỏng caller service_role / writer khác), KHÔNG publish.
     * o.engineBasis: tính bằng cơ sở khác (writer cũ) · o.mutate(payload): sửa payload trước stage · o.expect(e): sửa expect ·
     * o.beforeSeal(): chạy sau stage, trước seal · o.detail: detail open.
     */
    async function stageDirect(p, rws, o = {}) {
      const raw = await rpc(`SELECT public.rpc_cms_sales_run_open($1, $2::jsonb) r`, [p.id, JSON.stringify(o.detail ?? { source: 'operator' })])
      const snap = RS.parseCmsSalesSnapshot(raw)
      const lines = rws.map((r) => { const n = C.normalizeSalesRow(r); if (!n.ok) throw new Error('dòng lỗi'); return n.value })
      const ei = RS.cmsSnapshotToEngineInput(snap)
      const program = o.engineBasis ? { ...ei.program, quantityBasis: o.engineBasis } : ei.program
      const out = EN.computeCmsProgram({ program, lines, sellers: ei.sellers })
      const payload = RS.buildCmsStagePayload(snap, lines, out, { rowsRead: rws.length, rowsRejected: 0, bytesProcessed: null })
      if (o.mutate) o.mutate(payload)
      for (const part of RS.CMS_STAGE_PARTS) {
        const chunks = RS.chunkCmsStageRows(payload.parts[part])
        for (let i = 0; i < chunks.length; i++) await rpc(`SELECT public.rpc_cms_sales_run_stage($1, $2, $3, $4::jsonb) r`, [snap.runId, part, i, JSON.stringify(chunks[i])])
      }
      if (o.beforeSeal) await o.beforeSeal(snap.runId)
      const expect = o.expect ? o.expect({ ...payload.expect }) : payload.expect
      const seal = await SS.runCmsSealSteps({ begin: () => rpc(`SELECT public.rpc_cms_sales_run_seal_begin($1, $2::jsonb) r`, [snap.runId, JSON.stringify(expect)]),
        step: (n) => rpc(`SELECT public.rpc_cms_sales_run_seal_step($1, $2) r`, [snap.runId, n]) })
      return { runId: snap.runId, snap, sealed: seal.sealed, status: seal.status, code: seal.code, out, expect, payload }
    }
    const publishRpc = (runId) => rpc(`SELECT public.rpc_cms_sales_run_publish($1) r`, [runId])
    const prog = (id) => one(`SELECT status, config_version v, current_result_run_id::text ptr, is_test, quantity_basis qb FROM public.cms_programs WHERE id = $1`, [id])
    const prog127 = (id) => one(`SELECT status, config_version v, current_result_run_id::text ptr, is_test FROM public.cms_programs WHERE id = $1`, [id])
    const runRow = (id) => one(`SELECT status, error_code, detail, amount_vnd::text amt, published_at, seal_expect FROM public.cms_sync_runs WHERE id = $1`, [id])
    const runMeta = (id) => one(`SELECT quantity_basis qb, calculation_policy_version pv, calculation_snapshot cs, config_version cv FROM public.cms_sync_runs WHERE id = $1`, [id])
    const results = (runId) => all(`SELECT r.user_id::text u, r.product_id pid, r.cms_quantity::text q, r.potential_amount::text pot, r.amount_vnd::text amt, r.gate_met g,
        (r.base_quantity * 1000000000)::numeric(60,0)::text b9, (r.gmv_amount * 1000000000)::numeric(60,0)::text gmv9, r.per_unit::text k
      FROM public.cms_results r WHERE r.run_id = $1 ORDER BY 1, 2`, [runId])
    /** Vân tay dữ liệu MỘT run (4 bảng + dòng run trừ cột 128) — so trước / sau migration. */
    const runFp = async (runId) => {
      const parts = []
      for (const t of ['cms_sales_lines', 'cms_results', 'cms_result_catalog', 'cms_result_lines', 'cms_sales_source_lines']) {
        parts.push((await one(`SELECT count(*)::int n, md5(coalesce(string_agg(to_jsonb(x)::text, chr(10) ORDER BY to_jsonb(x)::text), '')) m FROM public.${t} x WHERE x.run_id = $1`, [runId])))
      }
      parts.push(await one(`SELECT md5((to_jsonb(r) - 'quantity_basis' - 'calculation_policy_version' - 'calculation_snapshot')::text) m FROM public.cms_sync_runs r WHERE r.id = $1`, [runId]))
      return JSON.stringify(parts)
    }
    const asSuper = async (sql, params) => (await L.as(db, U.super, () => db.query(sql, params), 'authenticated')).rows[0].r
    const header = (id) => asSuper(`SELECT public.rpc_cms_result_header($1) r`, [id])
    const rowsR = (id, runId = null) => asSuper(`SELECT public.rpc_cms_result_rows($1, $2) r`, [id, runId])
    const linesR = (id, runId, ppId = null, uid = null) => asSuper(`SELECT public.rpc_cms_result_lines($1, $2, $3, $4, NULL, 500) r`, [id, runId, ppId, uid])
    const lockEval = async (id) => (await one(`SELECT public.cms__lock_eval($1, NULL, NULL, NULL, false) r`, [id])).r
    const fnCount = async () => Number((await one(`SELECT count(*)::int n FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND (proname LIKE 'cms\\_%' OR proname LIKE 'rpc\\_cms\\_%')`)).n)
    const hasCol = async () => Number((await one(`SELECT count(*)::int n FROM pg_attribute WHERE attrelid = 'public.cms_programs'::regclass AND attname = 'quantity_basis' AND NOT attisdropped`)).n) === 1
    const configFps = async () => (await all(`SELECT id::text, public.cms__config_fp(id) fp FROM public.cms_programs ORDER BY 1`)).map((r) => `${r.id}=${r.fp}`).join(',')
    const fnMd5 = async (names) => Object.fromEntries((await all(`SELECT p.proname n, md5(replace(p.prosrc, E'\\r', '')) m FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1)`, [names])).map((r) => [r.n, r.m]))
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
      if (P_ >= 128) input.p128 = { invBasis: (await lastQ(q.inv128Basis))[0] }
      return input
    }
    const verify = async (phase, aclPre, requireProven) => T.evaluateCmsVerify({ ...(await postInput(phase, aclPre)), ...(requireProven ? { requireProven } : {}) })
    /** Đỏ có chủ đích trên DB thử: isolation môi trường + bất biến dữ liệu T11 của marker 127 MÔ PHỎNG (kiểm ở qa-cms-127). */
    const bad = (cs) => cs.filter((c) => !c.ok && !['v7-isolation-123', 'isolation'].includes(c.id) && !c.id.startsWith('v127-'))
    const show = (cs) => bad(cs).map((c) => `${c.id}: ${c.detail}`).slice(0, 6).join(' | ')
    return { db, label, conn, one, all, lastQ, svc, rpc, pre127, pre128, pid, day, preview, commit, saveProgram, makeProgram, rows, fx, sync, syncDeps, stageDirect,
      publishRpc, prog, prog127, runRow, runMeta, results, runFp, asSuper, header, rowsR, linesR, lockEval, fnCount, hasCol, configFps, fnMd5, verify, bad, show, timings }
  }


  async function closeAll() {
    for (const c of closers.reverse()) await Promise.resolve().then(c).catch(() => {})
    if (cluster) await cluster.stop().catch(() => {})
  }
  return { makeDb, env, closeAll, SELLERS, SELLER_IDS, OUT_EMAIL, ORACLE_SELLERS }
}
