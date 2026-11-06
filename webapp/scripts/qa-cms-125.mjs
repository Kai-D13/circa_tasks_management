// QA migration 125 (CMS-UNCAPPED-1 — CMS-Q-220 bỏ trần số lượng hưởng CMS) trên chuỗi migration THẬT 120 → 124 → 125 + tầng app.
// Hai backend: PGlite (mặc định, Postgres 16 WASM) và PostgreSQL 15 thật (embedded: `--pg15 <embedded-postgres-dir> <data-root>`).
//   §0 generator ↔ file (không sửa tay file sinh) · app CŨ (git 60a2231 — engine còn trần) dựng dữ liệu "trước 125"
//   §1 DB 124 + dữ liệu bằng app CŨ: A QA đang chạy có trần + run công bố (at_cap / dòng AT_CAP) · B QA nháp có trần + preview treo ·
//      C QA đã CHỐT có trần (run đóng băng + payout qa_assumption) · D QA đang chạy vốn không trần + run · E THẬT nháp có trần
//   §2 áp 125: chỉ cận bậc cuối → NULL · config_version + 1 ĐÚNG một lần / chương trình bị đổi · pointer NULL · updated_by NULL · C
//      byte-giống · D không đổi · run cũ còn nguyên · marker notes đếm đúng
//   §3 VERIFY phase 125 đạt · phase 124 trên DB 125 đỏ phase-match · đột biến (ACL guard / tắt guard / thân 121 / bậc cuối hữu hạn
//      lọt / run hiện hành có trần) đỏ · V8 phase 125
//   §4 sau 125: RPC import (cuối hữu hạn ⇒ CMS_IMPORT_TIER_LAST_FINITE; payload hỏng vẫn BAD_TIERS) · preview cũ ⇒ CONFLICT · kích hoạt
//      (vượt guard bằng owner ⇒ TIER_LAST_FINITE / TIERS_INVALID) · guard deferred (sửa trong transaction, đổi SP, xoá bậc cuối, xoá
//      hết bậc) · header ⇒ config_reset · chốt run cũ bị chặn · đồng bộ app MỚI: số không trần qua seal SQL (TS = SQL = oracle độc lập),
//      Q100 2.360.000, Q51−Q50 = Q101−Q100 = 25.000, gate chưa đạt Q100 ⇒ 0 / potential đủ, mốc 8 / 18 / 99 / 100.000
//   §5 dừng fail-closed (DB riêng): chương trình THẬT có trần đã công bố · run 'running' · thân 121 lệch · chạy lại
//   §6 rollback 125 ⇒ VERIFY 124 ĐẠT (không phần dư) · dữ liệu giữ chuyển đổi · áp lại 125 (không tăng version lần 2) · rollback 125 →
//      rollback 124 ⇒ profile after-rollback-124 phase 123 ĐẠT
//   §7 (chỉ --pg15) race 2 kết nối + đo: RPC cũ đang chờ khoá × áp 125 ⇒ guard chặn lúc COMMIT · import × kích hoạt · run đang mở × áp
//      125 ⇒ hết lock_timeout · commit 2.000 bậc qua guard trong ngân sách RPC
// KHÔNG chạm DB thật / nguồn thật / mạng (PG15 chỉ 127.0.0.1). App CŨ giải nén vào webapp/qa-artifacts/ (gitignore).
//   npm i --no-save @electric-sql/pglite@0.2.17 ; node scripts/qa-cms-125.mjs
//   node scripts/qa-cms-125.mjs --pg15 <embedded-postgres-dir> <data-root>
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createJiti } from 'jiti'
import * as L from './lib-care-pglite.mjs'
import { buildCms125, CMS_125_FILE, CMS_125_ROLLBACK_FILE } from './gen-cms-125.mjs'
import { CMS_LEGACY_SHA, cmsLegacy } from './lib-cms-legacy.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIG = path.join(HERE, '..', '..', 'supabase', 'migrations')
const SQL = (f) => fs.readFileSync(path.join(MIG, f), 'utf8')
const RB = (f) => fs.readFileSync(path.join(MIG, 'rollback', f), 'utf8')
const SQL_125 = fs.readFileSync(CMS_125_FILE, 'utf8')
const RB_125 = fs.readFileSync(CMS_125_ROLLBACK_FILE, 'utf8')
const jiti = createJiti(import.meta.url, { interopDefault: true, alias: { '@': path.join(HERE, '..') } })
const lib = (p) => jiti.import(path.join(HERE, '..', p))
const T = await lib('e2e/cmsQaTooling.ts')
const C = await lib('lib/cms/source/contract.ts')
const SS = await lib('lib/cms/salesSync.ts')
const LA = await lib('lib/cms/lockAction.ts')
const RV = await lib('lib/cms/resultView.ts')
const TI = await lib('lib/cms/engine/tiers.ts')
const CFG = await lib('lib/cms/engine/config.ts')
const FX = await lib('e2e/cmsFixtureRunner.ts')
const QR = await lib('e2e/cmsQaResults.ts')
const { U, storeId, STORES, sha } = L

const argv = process.argv.slice(2)
const PG15 = argv[0] === '--pg15'
let pass = 0, fail = 0
const ok = (c, name, extra = '') => { if (c) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) } }
const section = (s) => console.log(`\n${s}`)
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, err: String(e?.message ?? e), code: e?.code }))
const errIs = (r, code) => !r.ok && new RegExp(`\\b${code}\\b`).test(r.err)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** Chạy file migration mong lỗi: như phiên psql, lỗi giữa BEGIN … COMMIT để transaction aborted ⇒ ROLLBACK rồi mới dùng tiếp. */
const execFail = async (db, sql) => { const r = await settle(db.exec(sql)); if (!r.ok) await db.exec('ROLLBACK').catch(() => {}); return r }
const lastRows = (results) => { for (let i = results.length - 1; i >= 0; i--) if (results[i].rows?.length) return results[i].rows; return [] }
const B = (x) => BigInt(x)
/** Oracle ĐỘC LẬP ví dụ stakeholder CMS-Q-220 (không dùng tiers.ts): 15.000×min(Q,9) + 20.000×min(max(Q−9,0),10) + 25.000×max(Q−19,0). */
const stakeF = (q) => { q = B(q); const mn = (a, b) => (a < b ? a : b), mx = (a, b) => (a > b ? a : b); return B(15000) * mn(q, B(9)) + B(20000) * mn(mx(q - B(9), B(0)), B(10)) + B(25000) * mx(q - B(19), B(0)) }

// ── §0 generator + app CŨ ───────────────────────────────────────────────────────────────────────────────────────────────────────────
section('0. Generator ↔ file · app CŨ (git 60a2231, engine còn trần) để dựng dữ liệu trước 125')
const GEN = buildCms125()
ok(GEN.migration === SQL_125 && GEN.rollback === RB_125, 'scripts/gen-cms-125.mjs sinh ĐÚNG byte 125 + rollback trên đĩa')
ok(GEN.md5s.commit121 === T.CMS_FN_MATRIX.rpc_cms_import_commit.src && GEN.md5s.activate121 === T.CMS_FN_MATRIX.rpc_cms_program_activate.src
  && GEN.md5s.guard122 === T.CMS_FN_MATRIX.cms__programs_result_guard.src, 'preflight md5 = thân 121 / 122 trong ma trận VERIFY (không ghi đè thân lạ)')
ok(GEN.md5s.commit125 === T.CMS_FN_SRC_125.rpc_cms_import_commit && GEN.md5s.activate125 === T.CMS_FN_SRC_125.rpc_cms_program_activate,
  'thân 125 sinh từ generator = CMS_FN_SRC_125 của VERIFY')
const LEG = cmsLegacy()
ok(LEG.isLegacy, `app cũ (${CMS_LEGACY_SHA.slice(0, 7)}) là bản TRƯỚC CMS-Q-220 (engine lấy trần từ bậc cuối hữu hạn)`)
const SS_OLD = await LEG.load('lib/cms/salesSync.ts')

// ── backend ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
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
    PORT = 54355; PASS = 'qa-local-only'
    cluster = new EmbeddedPostgres({ databaseDir: path.join(path.resolve(dataRoot), `pgdata-cms125-${Date.now()}`), user: 'postgres', password: PASS, port: PORT,
      persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {}, onError: () => {} })
    await cluster.initialise(); await cluster.start()
  }
  const name = `rpgcms125_${tag}`
  const conn = async (d = name) => { const c = new pgMod.Client({ host: '127.0.0.1', port: PORT, user: 'postgres', password: PASS, database: d }); c.on('error', () => {}); await c.connect(); closers.push(() => c.end().catch(() => {})); return c }
  const admin = await conn('postgres')
  await admin.query(`CREATE DATABASE ${name} ENCODING 'UTF8' TEMPLATE template0`)
  const c = await conn()
  const wrap = { exec: (sql) => c.query(sql).then((r) => (Array.isArray(r) ? r : [r])), query: (sql, p) => c.query(sql, p), close: () => c.end() }
  // Role là đối tượng CẤP CLUSTER: DB thứ 2+ trong cùng cluster PG15 bỏ 3 lệnh CREATE ROLE của freshDb (role đã có từ DB đầu).
  const rolesExist = (await c.query(`SELECT count(*)::int n FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')`)).rows[0].n === 3
  const ROLES = 'CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;'
  function FakePGlite() { return rolesExist ? { ...wrap, exec: (sql) => wrap.exec(sql.split(ROLES).join('')) } : wrap }
  await L.freshDb(FakePGlite, { through: '116' })
  const ver = (await c.query('SHOW server_version')).rows[0].server_version
  return { db: wrap, label: `PostgreSQL ${ver} (embedded)`, conn }
}

/** Môi trường một DB: chuỗi 120 → 124 với PRE chụp ngay trước 124 / 125, helper chương trình / bán / đồng bộ / chốt. */
async function env(tag) {
  const { db, label, conn } = await makeDb(tag)
  const one = async (sql, p = []) => (await db.query(sql, p)).rows[0]
  const all = async (sql, p = []) => (await db.query(sql, p)).rows
  const lastQ = (sql) => db.exec(T.pgMetaReadOnly(sql)).then(lastRows)
  const svc = (sql, params = []) => L.as(db, null, () => db.query(sql, params), 'service_role')
  const snapshot = async () => { const r = (await lastQ(T.cmsVerifyAclSql()))[0]; await sleep(20); return r }
  await db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('117','t'),('118','t'),('118a','t'),('119','t'),('119a','t') ON CONFLICT DO NOTHING`)
  for (const f of ['120_cms_foundation.sql', '121_cms_import_activation.sql', '122_cms_results.sql']) { await db.exec(SQL(f)); await sleep(20) }
  const pre123 = await snapshot()
  await db.exec(SQL('123_cms_payouts.sql')); await sleep(20)
  const pre124 = await snapshot()
  await db.exec(SQL('124_cms_source_attestation.sql')); await sleep(20)
  await db.query(`INSERT INTO public.cms_product_master (product_id, product_name, is_active, source_updated_at)
    SELECT g::text, 'SP giả ' || g, true, now() FROM generate_series(926001, 928200) g`)
  await db.query(`INSERT INTO public.cms_qa_access (user_id, granted_by, expires_at) VALUES ($1, 'qa-script:cms-125', now() + interval '6 hours')`, [U.super])
  let pidNext = 926001, seqf = 0, lineSeq = 0
  const pid = () => String(pidNext++)
  const day = async (n) => { const t = (await one(`SELECT public.cms__vn_today()::text d`)).d; const d = new Date(`${t}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
  const prodPayload = (p) => ({ product_id: p.pid, gmv_basis: p.basis ?? 'none', target_gmv: p.target ?? null, base_quantity_cms: p.k ?? '1', tiers: p.tiers,
    unit_cms: 'hộp', advice_text: 'QA', name_snapshot: 'SP giả', image_url_snapshot: null, price_snapshot: null })
  async function preview(id, mode = 'replace') {
    const fileSha = sha(`f125-${tag}-${++seqf}`), digest = sha(`d125-${tag}-${seqf}`)
    const run = (await svc(`SELECT public.rpc_cms_import_preview_save($1::jsonb) id`, [JSON.stringify({ program_id: id, mode, file_name: 'qa.xlsx', file_sha256: fileSha,
      file_bytes: 10, actor: U.super, stats: { rowsTotal: 1, rowsOk: 1, rowsRejected: 0, warnings: 0, productsOk: 1, productsRejected: 0 }, result: { digest } })])).rows[0].id
    return { run, fileSha, digest }
  }
  const commitSql = `SELECT public.rpc_cms_import_commit($1, $2, $3, $4::jsonb, $5) r`
  const commitArgs = (pr, mode, products) => [pr.run, pr.fileSha, pr.digest, JSON.stringify({ mode, catalog_target: null, products: products.map(prodPayload) }), U.super]
  const commit = async (pr, mode, products) => (await svc(commitSql, commitArgs(pr, mode, products))).rows[0].r
  async function makeProgram({ name = 'QA CMS 125', isTest = true, products, activate = true, future = false }) {
    const start = await day(future ? 5 : -20), end = await day(future ? 30 : -1)
    const id = (await svc(`SELECT public.rpc_cms_program_save($1::jsonb) id`, [JSON.stringify({ actor: U.super, name, start_date: start, end_date: end,
      scope: 'stores', store_ids: [storeId(1), storeId(2)], is_test: isTest })])).rows[0].id
    await commit(await preview(id), 'replace', products)
    if (activate) await svc(`SELECT public.rpc_cms_program_activate($1, $2)`, [id, U.super])
    return { id, products, start, end }
  }
  const SELLERS = [STORES[0].assigneeEmails[0], STORES[0].assigneeEmails[1], STORES[1].assigneeEmails[0], STORES[1].assigneeEmails[1]]
  /** Dòng nguồn giả OFFLINE / COMPLETED trong kỳ: specs [{ pid, s (người bán 0…3), base, gmv, n }]. */
  function rows(p, specs) {
    const out = []
    const t0 = Date.parse(`${p.start}T01:00:00Z`)
    for (const sp of specs) for (let i = 0; i < (sp.n ?? 1); i++) {
      const id = ++lineSeq
      const at = new Date(t0 + id * 60_000).toISOString().replace('Z', '').padEnd(23, '0') + `${String(id % 1000).padStart(3, '0')}Z`
      out.push({ order_line_id: String(926000000 + id), order_id: `O${id}`, order_code: `QA-${id}`, product_id: sp.pid, seller_email: SELLERS[sp.s ?? 0], pos_code: 'QAOS01',
        order_type: 'OFFLINE', order_status: 'COMPLETED', completed_at: at, quantity_raw: '1', uom_raw: 'Hộp', base_quantity: String(sp.base ?? 1),
        gmv_amount: String(sp.gmv ?? 10000), source_updated_at: at })
    }
    for (const r of out) if (!C.normalizeSalesRow(r).ok) throw new Error('dòng giả lỗi')
    return out
  }
  const rpc = async (sql, params) => { try { return (await svc(sql, params)).rows[0].r } catch (e) { const m = /\bCMS_[A-Z0-9_]+\b/.exec(String(e.message)); throw new Error(m ? m[0] : 'RPC_FAILED') } }
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
  const sync = (app, p, rws) => app.runCmsSalesSync(syncDeps(rws), p.id, { dryRun: false, source: 'qa', sourceCapture: true })
  const lockDeps = {
    lockEnabled: () => true, qaReadonly: () => false, access: async () => ({ kind: 'ok', actorId: U.super, qa: true }),
    program: async (id) => { const r = await one(`SELECT is_test FROM public.cms_programs WHERE id = $1`, [id]); return r ? { isTest: r.is_test } : null },
    rpc: async (fn, args) => {
      const named = Object.keys(args).map((k, i) => `${k} => $${i + 1}`).join(', ')
      try { return { data: (await svc(`SELECT public.${fn}(${named}) r`, Object.values(args))).rows[0].r, error: null } } catch (e) { return { data: null, error: { code: e.code, message: e.message } } }
    },
  }
  const results = (runId) => all(`SELECT user_id::text u, program_product_id::text pp, cms_quantity::text q, rewarded_quantity::text rq, cap_quantity::text cap, at_cap, amount_vnd::text amt, potential_amount::text pot, gate_met
    FROM public.cms_results WHERE run_id = $1 ORDER BY 1, 2`, [runId])
  const tiersOf = (id) => all(`SELECT pp.product_id pid, t.tier_order o, t.qty_from f, t.qty_to t, t.amount_per_unit::text a FROM public.cms_program_tiers t
    JOIN public.cms_program_products pp ON pp.id = t.program_product_id WHERE t.program_id = $1 ORDER BY 1, 2`, [id])
  const prog = (id) => one(`SELECT status, config_version v, current_result_run_id::text ptr, updated_by::text ub, is_test FROM public.cms_programs WHERE id = $1`, [id])
  const rowsMd5 = async (sql, p) => (await one(`SELECT md5(coalesce(string_agg(x::text, ';' ORDER BY x::text), '')) h FROM (${sql}) x`, p)).h
  const PROF = 'after-rollback-124'
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
    if (P_ >= 124) input.p124 = { invAttest: (await lastQ(q.invAttest))[0] ?? { n: 0, bad: 0 } }
    if (P_ >= 125) input.p125 = { invLastTier: await lastQ(q.inv125LastTier), invCurrentCap: await lastQ(q.inv125CurrentCap), current: (await lastQ(q.inv125Current))[0] }
    if (profile) input.profile = profile
    return input
  }
  // PGlite / PG15 nhúng: owner hàm SECDEF = postgres, isolation mặc định ⇒ 2 mục môi trường (như qa-cms-124 / qa-cms-rollback-profile).
  const ENV_ONLY = new Set(['v7-isolation-123', 'isolation'])
  const bad = (cs) => cs.filter((c) => !c.ok && !ENV_ONLY.has(c.id))
  const show = (cs) => bad(cs).map((c) => `${c.id}: ${c.detail}`).slice(0, 5).join(' | ')
  const verify = async (phase, aclPre, profile) => T.evaluateCmsVerify(await postInput(phase, aclPre, profile))
  return { db, label, conn, one, all, lastQ, svc, snapshot, pre123, pre124, pid, day, preview, commit, commitSql, commitArgs, makeProgram, rows, sync, lockDeps,
    results, tiersOf, prog, rowsMd5, verify, bad, show, PROF }
}

const T3 = (last) => [{ order: 1, from: 1, to: 9, amount: '15000' }, { order: 2, from: 10, to: 19, amount: '20000' }, { order: 3, from: 20, to: last, amount: '25000' }]
const ONE = (to, amount = '1000') => [{ order: 1, from: 1, to, amount }]

async function main() {
  const E = await env('main')
  console.log(`QA migration 125 — ${E.label}`)
  if (PG15) ok(E.label.startsWith('PostgreSQL 15.'), 'PostgreSQL 15')
  const { db, one, svc } = E

  section('1. DB 124 + dữ liệu bằng app CŨ (trước CMS-Q-220)')
  const a1 = E.pid(), a2 = E.pid()
  const A = await E.makeProgram({ name: 'QA A có trần', products: [{ pid: a1, tiers: T3(50) }, { pid: a2, tiers: ONE(null) }] })
  const rA = await E.sync(SS_OLD, A, E.rows(A, [{ pid: a1, s: 0, base: 60 }, { pid: a1, s: 0, base: 5 }, { pid: a1, s: 1, base: 10, n: 3 }, { pid: a2, s: 2, base: 1, n: 5 }]))
  const resA0 = rA.status === 'published' ? await E.results(rA.runId) : []
  const capRow = resA0.find((r) => r.q === '65')
  const atCapLines = Number((await one(`SELECT count(*)::int n FROM public.cms_result_lines WHERE run_id = $1 AND status = 'AT_CAP'`, [rA.runId ?? null])).n)
  ok(rA.status === 'published' && capRow?.cap === '50' && capRow?.at_cap === true && capRow?.rq === '50' && capRow?.amt === String(stakeF(50)) && atCapLines === 1,
    `A: app cũ công bố run CÓ TRẦN (Q 65 ⇒ hưởng 50, ${capRow?.amt ?? '?'}đ, 1 dòng AT_CAP) — dữ liệu "trước 125" thật`, JSON.stringify([rA.status, rA.code, capRow, atCapLines]))
  const b1 = E.pid()
  const Bp = await E.makeProgram({ name: 'QA B nháp có trần', products: [{ pid: b1, tiers: ONE(50, '5000') }], activate: false })
  const staleB = await E.preview(Bp.id)
  const c1 = E.pid()
  const Cp = await E.makeProgram({ name: 'QA C đã chốt có trần', products: [{ pid: c1, tiers: [{ order: 1, from: 1, to: 9, amount: '1000' }, { order: 2, from: 10, to: 20, amount: '2000' }] }] })
  const rC = await E.sync(SS_OLD, Cp, E.rows(Cp, [{ pid: c1, s: 0, base: 25 }]))
  const pvC = await LA.runCmsLockPreview(E.lockDeps, Cp.id)
  const lkC = pvC.ok ? await LA.runCmsLock(E.lockDeps, { programId: Cp.id, expectedRunId: rC.runId, expectedPolicyVersion: pvC.preview.policyVersion, ackReason: 'QA giả chốt trước 125 (có trần cũ)' }) : { ok: false }
  ok(rC.status === 'published' && lkC.ok && (await E.prog(Cp.id)).status === 'locked', 'C: app cũ công bố + CHỐT qa_assumption (run đóng băng có trần)', JSON.stringify([rC.status, pvC.ok ? pvC.preview.blockers : pvC, lkC]))
  const d1 = E.pid()
  const Dp = await E.makeProgram({ name: 'QA D vốn không trần', products: [{ pid: d1, tiers: T3(null) }] })
  const rD = await E.sync(SS_OLD, Dp, E.rows(Dp, [{ pid: d1, s: 3, base: 12 }]))
  ok(rD.status === 'published', 'D: chương trình vốn bậc cuối không giới hạn có run hiện hành', JSON.stringify([rD.status, rD.code]))
  const e1 = E.pid()
  const Ep = await E.makeProgram({ name: 'THẬT E nháp có trần', isTest: false, future: true, activate: false,
    products: [{ pid: e1, tiers: [{ order: 1, from: 1, to: 9, amount: '1000' }, { order: 2, from: 10, to: 99, amount: '2000' }] }] })
  const before = {}
  for (const [k, p] of Object.entries({ A, B: Bp, C: Cp, D: Dp, E: Ep })) before[k] = { prog: await E.prog(p.id), tiers: await E.tiersOf(p.id) }
  const cRows = async () => ({
    prog: await E.rowsMd5(`SELECT id, status, config_version, current_result_run_id, catalog_target_gmv, locked_at, updated_at, updated_by FROM public.cms_programs WHERE id = $1`, [Cp.id]),
    tiers: await E.rowsMd5(`SELECT * FROM public.cms_program_tiers WHERE program_id = $1`, [Cp.id]),
    results: await E.rowsMd5(`SELECT * FROM public.cms_results WHERE run_id = $1`, [rC.runId]),
    lines: await E.rowsMd5(`SELECT * FROM public.cms_result_lines WHERE run_id = $1`, [rC.runId]),
    payout: await E.rowsMd5(`SELECT * FROM public.cms_payouts WHERE program_id = $1`, [Cp.id]),
    staff: await E.rowsMd5(`SELECT * FROM public.cms_payout_staff WHERE program_id = $1`, [Cp.id]),
  })
  const c0 = await cRows()
  const aRun0 = await E.rowsMd5(`SELECT * FROM public.cms_results WHERE run_id = $1`, [rA.runId])
  const dRun0 = await E.rowsMd5(`SELECT * FROM public.cms_results WHERE run_id = $1`, [rD.runId])

  section('2. Áp 125 — chuyển đổi đúng phạm vi')
  const pre125 = await E.snapshot()
  await db.exec(SQL_125); await sleep(20)
  const mk = await one(`SELECT name, notes FROM public.app_migrations WHERE version = '125'`)
  ok(mk?.name === 'cms_uncapped_last_tier', 'marker 125')
  const notes = /chuyển đổi chưa chốt (\{[^}]*\})/.exec(mk?.notes ?? '')?.[1]
  const inv = /inventory trước chuyển đổi (\{[^}]*\})/.exec(mk?.notes ?? '')?.[1]
  ok(inv && JSON.parse(inv)['active:qa'] === 1 && JSON.parse(inv)['draft:qa'] === 1 && JSON.parse(inv)['draft:real'] === 1 && JSON.parse(inv)['locked:qa'] === 1,
    `notes marker ghi inventory trước chuyển đổi (Studio có thể không hiện NOTICE): ${inv}`)
  ok(notes && JSON.parse(notes).programs === 3 && JSON.parse(notes).last_tiers === 3 && JSON.parse(notes).pointers_cleared === 1,
    `notes marker đếm đúng (A, B, E · 3 bậc cuối · 1 pointer): ${notes}`)
  const after = {}
  for (const [k, p] of Object.entries({ A, B: Bp, C: Cp, D: Dp, E: Ep })) after[k] = { prog: await E.prog(p.id), tiers: await E.tiersOf(p.id) }
  const lastNullOnly = (b, a) => a.length === b.length && a.every((t, i) => {
    const o = b[i]; const isLast = !a[i + 1] || a[i + 1].pid !== t.pid
    return t.pid === o.pid && t.o === o.o && t.f === o.f && t.a === o.a && (isLast ? t.t === null : t.t === o.t)
  })
  for (const k of ['A', 'B', 'E']) {
    ok(lastNullOnly(before[k].tiers, after[k].tiers) && before[k].tiers.some((t) => t.t !== null), `${k}: chỉ cận bậc cuối → NULL (bậc giữa / mức tiền / số bậc giữ nguyên)`, JSON.stringify(after[k].tiers))
    ok(after[k].prog.v === before[k].prog.v + 1 && after[k].prog.ptr === null && after[k].prog.ub === null,
      `${k}: config_version ${before[k].prog.v} → ${after[k].prog.v} (đúng +1) · pointer NULL · updated_by NULL (thao tác hệ thống)`, JSON.stringify(after[k].prog))
  }
  ok(before.A.prog.ptr === rA.runId && after.A.prog.ptr === null, 'A: pointer run có trần cũ bị VÔ HIỆU (không còn là tiền hiện hành)')
  ok(JSON.stringify(after.D) === JSON.stringify(before.D), 'D: vốn không trần ⇒ KHÔNG tăng version, KHÔNG đụng pointer / bậc')
  const c1s = await cRows()
  ok(JSON.stringify(c1s) === JSON.stringify(c0) && after.C.tiers.some((t) => t.t === 20), 'C (đã chốt): chương trình / bậc (còn trần 20) / kết quả / dòng / payout / payout_staff BYTE-GIỐNG')
  ok(await E.rowsMd5(`SELECT * FROM public.cms_results WHERE run_id = $1`, [rA.runId]) === aRun0 && (await one(`SELECT status FROM public.cms_sync_runs WHERE id = $1`, [rA.runId])).status === 'ok',
    'A: run cũ KHÔNG xoá / không sửa (vẫn ok, kết quả nguyên byte)')
  ok(await E.rowsMd5(`SELECT * FROM public.cms_results WHERE run_id = $1`, [rD.runId]) === dRun0, 'D: kết quả run hiện hành nguyên byte')
  const trg = await one(`SELECT t.tgenabled::text e, t.tgdeferrable d, t.tginitdeferred i FROM pg_trigger t WHERE t.tgrelid = 'public.cms_program_tiers'::regclass AND t.tgname = 'cms_tiers_last_open'`)
  const ptrTrg = await one(`SELECT tgenabled::text e FROM pg_trigger WHERE tgrelid = 'public.cms_programs'::regclass AND tgname = 'cms_programs_result_guard'`)
  ok(trg?.e === 'A' && trg?.d === true && trg?.i === true && ptrTrg?.e === 'O', 'guard ALWAYS + DEFERRABLE INITIALLY DEFERRED · trigger pointer 122 bật lại chế độ origin')
  const acl = await E.all(`SELECT p.proname n, has_function_privilege('anon', p.oid, 'EXECUTE') a, has_function_privilege('authenticated', p.oid, 'EXECUTE') u,
    has_function_privilege('service_role', p.oid, 'EXECUTE') s FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname IN ('cms__tiers_last_open_guard', 'rpc_cms_import_commit', 'rpc_cms_program_activate') ORDER BY 1`)
  ok(acl.length === 3 && acl.every((r) => !r.a && !r.u && r.s === r.n.startsWith('rpc_')), 'ACL has_function_privilege: anon / authenticated f; service_role chỉ 2 RPC; guard không ai', JSON.stringify(acl))

  section('3. VERIFY phase 125 · phase 124 trên DB 125 đỏ · đột biến đỏ · V8 phase 125')
  const post = await E.verify('125', pre125)
  ok(E.bad(post).length === 0, `POST phase 125: ${post.length} mục, lệch ${E.bad(post).length}`, E.show(post))
  const byId = (cs, id) => cs.find((c) => c.id === id)
  ok(byId(post, 'fn-src:rpc_cms_import_commit')?.ok && byId(post, 'fn-src:rpc_cms_program_activate')?.ok && byId(post, 'acl-preexisting-functions')?.ok
    && byId(post, 'v125-last-tier-open')?.ok && byId(post, 'v125-current-run-uncapped')?.ok && byId(post, 'v125-current-run-uncapped')?.proven === true
    && byId(post, 'table-shape:cms_program_tiers')?.ok, 'POST 125 kiểm thân 2 RPC mới, ACL mọi hàm có trước = PRE, bất biến bậc cuối / run hiện hành (đã chứng minh — D có run), shape tiers')
  ok(E.bad(await E.verify('124', pre125)).some((c) => c.id === 'phase-match'), 'checker phase 124 trên DB 125 ⇒ phase-match ĐỎ (không xanh giả)')
  const failed = (cs) => E.bad(cs).map((c) => c.id)
  const mutate = async (on, off, id, name) => {
    await db.exec(on)
    const ids = failed(await E.verify('125', pre125))
    await db.exec(off)
    ok(ids.some((x) => x.startsWith(id)), `đột biến ${name} ⇒ ${id} ĐỎ`, ids.join(','))
  }
  await mutate(`GRANT EXECUTE ON FUNCTION public.cms__tiers_last_open_guard() TO anon`, `REVOKE EXECUTE ON FUNCTION public.cms__tiers_last_open_guard() FROM anon`, 'fn-exec:cms__tiers_last_open_guard', 'GRANT anon guard')
  await mutate(`ALTER TABLE public.cms_program_tiers DISABLE TRIGGER cms_tiers_last_open`, `ALTER TABLE public.cms_program_tiers ENABLE ALWAYS TRIGGER cms_tiers_last_open`, 'triggers', 'tắt guard')
  await mutate(`ALTER TABLE public.cms_programs ENABLE ALWAYS TRIGGER cms_programs_result_guard`, `ALTER TABLE public.cms_programs ENABLE TRIGGER cms_programs_result_guard`, 'triggers', 'trigger pointer đổi chế độ ALWAYS')
  await mutate(GEN.originals.commit.replace('CREATE FUNCTION public.', 'CREATE OR REPLACE FUNCTION public.'), GEN.replaced.commit, 'fn-src:rpc_cms_import_commit', 'thân import 121 (bỏ chặn cuối hữu hạn)')
  // Bậc cuối hữu hạn lọt vào chương trình chưa chốt (owner tắt guard) ⇒ bất biến đỏ; khôi phục ⇒ đạt.
  const tierB = await one(`SELECT program_product_id::text pp, tier_order o FROM public.cms_program_tiers WHERE program_id = $1 ORDER BY tier_order DESC LIMIT 1`, [Bp.id])
  await mutate(`ALTER TABLE public.cms_program_tiers DISABLE TRIGGER cms_tiers_last_open; UPDATE public.cms_program_tiers SET qty_to = 50 WHERE program_product_id = '${tierB.pp}' AND tier_order = ${tierB.o}; ALTER TABLE public.cms_program_tiers ENABLE ALWAYS TRIGGER cms_tiers_last_open`,
    `ALTER TABLE public.cms_program_tiers DISABLE TRIGGER cms_tiers_last_open; UPDATE public.cms_program_tiers SET qty_to = NULL WHERE program_product_id = '${tierB.pp}' AND tier_order = ${tierB.o}; ALTER TABLE public.cms_program_tiers ENABLE ALWAYS TRIGGER cms_tiers_last_open`,
    'v125-last-tier-open', 'bậc cuối hữu hạn lọt (vượt guard)')
  // Run hiện hành mang trần (owner sửa trực tiếp dữ liệu run D — đột biến) ⇒ bất biến đỏ.
  // (owner được ghi run chưa đóng băng; CHECK 122 buộc cap = Q ⇒ rewarded = Q, at_cap true).
  await mutate(`UPDATE public.cms_results SET cap_quantity = cms_quantity, at_cap = true WHERE run_id = '${rD.runId}'`,
    `UPDATE public.cms_results SET cap_quantity = NULL, at_cap = false WHERE run_id = '${rD.runId}'`,
    'v125-current-run-uncapped', 'run hiện hành mang trần (cap / at_cap)')
  const restored = E.bad(await E.verify('125', pre125))
  ok(restored.length === 0, 'sau khôi phục đột biến: POST 125 lại đạt', restored.map((c) => c.id).join(','))
  const [v8] = lastRows(await db.exec(T.pgMetaReadOnlySnapshot(T.cmsVerifyV8Sql(U.super, 'super', '125'))))
  const v8c = T.evaluateCmsV8(v8, U.super, 'super', { phase: '125' })
  ok(v8c.filter((c) => !c.ok).length === 0, `V8 phase 125 (super): ${v8c.length} mục đạt`, v8c.filter((c) => !c.ok).map((c) => c.id).join(','))
  const v8w = T.evaluateCmsV8(v8, U.super, 'super', { phase: '124' })
  ok(v8w.some((c) => c.id === 'v8-phase' && !c.ok), 'V8 khai phase 124 trên DB 125 ⇒ v8-phase ĐỎ')

  section('4. Sau 125 — RPC / guard / app')
  // 4a. import RPC trực tiếp.
  const g1 = E.pid(), g2 = E.pid()
  const G = await E.makeProgram({ name: 'QA G sau 125', products: [{ pid: g1, tiers: T3(null) }], activate: false })
  const rFin = await settle(E.commit(await E.preview(G.id), 'replace', [{ pid: g1, tiers: T3(50) }]))
  ok(errIs(rFin, 'CMS_IMPORT_TIER_LAST_FINITE'), 'RPC import trực tiếp với bậc cuối hữu hạn ⇒ CMS_IMPORT_TIER_LAST_FINITE', rFin.err)
  const rOne = await settle(E.commit(await E.preview(G.id), 'replace', [{ pid: g1, tiers: ONE(50) }]))
  ok(errIs(rOne, 'CMS_IMPORT_TIER_LAST_FINITE'), 'một bậc 1–50 ⇒ CMS_IMPORT_TIER_LAST_FINITE', rOne.err)
  const rGap = await settle(E.commit(await E.preview(G.id), 'replace', [{ pid: g1, tiers: [{ order: 1, from: 1, to: 9, amount: '1' }, { order: 2, from: 11, to: 50, amount: '2' }] }]))
  ok(errIs(rGap, 'CMS_IMPORT_BAD_TIERS'), 'payload hở bậc + cuối hữu hạn ⇒ vẫn CMS_IMPORT_BAD_TIERS (kiểm cũ chạy trước, không bị "chuẩn hoá")', rGap.err)
  const rMix = await settle(E.commit(await E.preview(G.id), 'replace', [{ pid: g1, tiers: T3(null) }, { pid: g2, tiers: ONE(9) }]))
  ok(errIs(rMix, 'CMS_IMPORT_TIER_LAST_FINITE') && (await E.tiersOf(G.id)).every((t) => t.pid === g1), 'một SP hữu hạn trong file ⇒ cả lệnh bị từ chối, danh mục giữ nguyên', rMix.err)
  const rOk = await settle(E.commit(await E.preview(G.id), 'replace', [{ pid: g1, tiers: T3(null) }, { pid: g2, tiers: ONE(null) }]))
  ok(rOk.ok && (await E.tiersOf(G.id)).filter((t) => t.t === null).length === 2, 'payload hợp lệ (cuối NULL, giữa 9 / 19) qua guard deferred', rOk.err)
  const rStale = await settle(E.commit(staleB, 'replace', [{ pid: b1, tiers: ONE(null, '5000') }]))
  ok(errIs(rStale, 'CMS_IMPORT_CONFLICT'), 'preview B lập TRƯỚC 125 (version cũ) ⇒ CMS_IMPORT_CONFLICT (kiểm lại file)', rStale.err)
  // 4b. guard deferred — owner DML trong MỘT transaction (đường duy nhất ngoài RPC; RPC bị chặn ở 4a).
  const ppG1 = (await one(`SELECT id::text id FROM public.cms_program_products WHERE program_id = $1 AND product_id = $2`, [G.id, g1])).id
  const ppG2 = (await one(`SELECT id::text id FROM public.cms_program_products WHERE program_id = $1 AND product_id = $2`, [G.id, g2])).id
  const txn = async (sql) => { await db.exec('BEGIN'); try { await db.exec(sql); await db.exec('COMMIT'); return { ok: true } } catch (e) { await db.exec('ROLLBACK').catch(() => {}); return { ok: false, err: String(e.message) } } }
  const t1 = await txn(`UPDATE public.cms_program_tiers SET qty_to = 60 WHERE program_product_id = '${ppG1}' AND tier_order = 3; UPDATE public.cms_program_tiers SET qty_to = NULL WHERE program_product_id = '${ppG1}' AND tier_order = 3`)
  ok(t1.ok, 'trong transaction: bậc cuối tạm hữu hạn rồi sửa lại NULL ⇒ COMMIT đạt (deferred — không chặn giữa chừng)', t1.err)
  const t2 = await txn(`UPDATE public.cms_program_tiers SET qty_to = 60 WHERE program_product_id = '${ppG1}' AND tier_order = 3`)
  ok(!t2.ok && /CMS_TIER_LAST_FINITE/.test(t2.err) && (await E.tiersOf(G.id)).find((t) => t.pid === g1 && t.o === 3).t === null, 'kết thúc transaction với bậc cuối hữu hạn ⇒ CMS_TIER_LAST_FINITE, rollback', t2.err)
  const t3 = await txn(`DELETE FROM public.cms_program_tiers WHERE program_product_id = '${ppG1}' AND tier_order = 3`)
  ok(!t3.ok && /CMS_TIER_LAST_FINITE/.test(t3.err), 'xoá bậc cuối (NULL) để bậc 19 thành cuối ⇒ chặn (kiểm OLD)', t3.err)
  const t4 = await txn(`UPDATE public.cms_program_tiers SET program_product_id = '${ppG2}', tier_order = 2, qty_from = 2 WHERE program_product_id = '${ppG1}' AND tier_order = 3`)
  ok(!t4.ok && /CMS_TIER_LAST_FINITE/.test(t4.err), 'UPDATE chuyển bậc cuối sang SP khác (SP cũ còn cuối hữu hạn) ⇒ chặn (kiểm cả OLD lẫn NEW)', t4.err)
  const t5 = await txn(`DELETE FROM public.cms_program_tiers WHERE program_product_id = '${ppG2}'; DELETE FROM public.cms_program_products WHERE id = '${ppG2}'`)
  ok(t5.ok, 'xoá HẾT bậc + SP (như replace) ⇒ không kiểm nhầm id cũ, COMMIT đạt', t5.err)
  // db-reviewer 125 P2-4: SP còn dòng mà 0 bậc (xoá hết bậc nhưng giữ SP) ⇒ không có bậc cuối không giới hạn ⇒ chặn.
  const t5b = await txn(`DELETE FROM public.cms_program_tiers WHERE program_product_id = '${ppG1}'`)
  ok(!t5b.ok && /CMS_TIER_LAST_FINITE/.test(t5b.err), 'xoá hết bậc nhưng GIỮ SP ⇒ chặn (chỉ bỏ qua khi SP cũng đã xoá)', t5b.err)
  const t6 = await txn(`INSERT INTO public.cms_program_tiers (program_product_id, program_id, tier_order, qty_from, qty_to, amount_per_unit) VALUES ('${ppG1}', '${G.id}', 4, 100, 200, 30000)`)
  ok(!t6.ok && /CMS_TIER_LAST_FINITE/.test(t6.err), 'INSERT bậc cuối mới hữu hạn ⇒ chặn', t6.err)
  const repl = await txn(`SET LOCAL session_replication_role = replica; UPDATE public.cms_program_tiers SET qty_to = 60 WHERE program_product_id = '${ppG1}' AND tier_order = 3`)
  ok(!repl.ok && /CMS_TIER_LAST_FINITE/.test(repl.err), 'session_replication_role = replica KHÔNG tắt guard (ENABLE ALWAYS)', repl.err)
  // 4c. kích hoạt: đường kiểm riêng (không dựa guard) — owner vượt guard trong transaction rồi gọi activate.
  const act = async (sqlBreak) => {
    await db.exec('BEGIN')
    try {
      await db.exec(`ALTER TABLE public.cms_program_tiers DISABLE TRIGGER cms_tiers_last_open; ${sqlBreak}; SET LOCAL ROLE service_role`)
      return await settle(db.query(`SELECT public.rpc_cms_program_activate($1, $2) r`, [G.id, U.super]))
    } finally { await db.exec('ROLLBACK').catch(() => {}) }
  }
  const aFin = await act(`UPDATE public.cms_program_tiers SET qty_to = 60 WHERE program_product_id = '${ppG1}' AND tier_order = 3`)
  ok(errIs(aFin, 'CMS_PROGRAM_TIER_LAST_FINITE'), 'kích hoạt cấu hình cuối hữu hạn (vượt guard bằng owner) ⇒ CMS_PROGRAM_TIER_LAST_FINITE', aFin.err)
  const aGap = await act(`UPDATE public.cms_program_tiers SET qty_from = 11 WHERE program_product_id = '${ppG1}' AND tier_order = 2`)
  ok(errIs(aGap, 'CMS_PROGRAM_TIERS_INVALID'), 'kích hoạt thang bậc hở ⇒ CMS_PROGRAM_TIERS_INVALID', aGap.err)
  ok((await settle(svc(`SELECT public.rpc_cms_program_activate($1, $2)`, [G.id, U.super]))).ok && (await E.prog(G.id)).status === 'active', 'kích hoạt cấu hình hợp lệ (cuối NULL) đạt')
  const actB = await settle(svc(`SELECT public.rpc_cms_program_activate($1, $2)`, [Bp.id, U.super]))
  ok(actB.ok && (await E.prog(Bp.id)).status === 'active', 'B (nháp có trần đã chuyển đổi bởi 125) kích hoạt được', actB.err)
  // 4d. header A ⇒ config_reset; chốt run cũ bị chặn.
  const hdr = RV.parseCmsResultHeader((await L.as(db, U.super, () => db.query(`SELECT public.rpc_cms_result_header($1) r`, [A.id]))).rows[0].r)
  ok(hdr.run === null && hdr.lastAttempt?.status === 'ok' && RV.cmsResultState(hdr) === 'config_reset' && RV.cmsNoRunText(hdr) === RV.CMS_CONFIG_RESET_TEXT,
    'A sau 125: header không run hiện hành, lần gần nhất ok ⇒ "Chưa có số liệu sau thay đổi cấu hình" (không 0₫ giả, không tiền trần cũ)', JSON.stringify([hdr.run, hdr.lastAttempt, RV.cmsResultState(hdr)]))
  const pvA = await LA.runCmsLockPreview(E.lockDeps, A.id)
  ok(!pvA.ok || pvA.preview.blockers.length > 0, 'chốt A trên run cũ (có trần) bị chặn — không có run hiện hành', JSON.stringify(pvA.ok ? pvA.preview.blockers : pvA))
  // 4e. đồng bộ app MỚI ⇒ số không trần, seal SQL nhận (TS = SQL), oracle độc lập.
  const rA2 = await E.sync(SS, A, E.rows(A, [{ pid: a1, s: 0, base: 60 }, { pid: a1, s: 0, base: 5 }, { pid: a1, s: 1, base: 10, n: 3 }, { pid: a2, s: 2, base: 1, n: 5 }]))
  const resA2 = rA2.status === 'published' ? await E.results(rA2.runId) : []
  const r65 = resA2.find((r) => r.q === '65')
  ok(rA2.status === 'published' && r65?.amt === String(stakeF(65)) && r65?.cap === null && r65?.at_cap === false && r65?.rq === '65'
    && resA2.every((r) => r.cap === null && r.at_cap === false),
    `A resync app mới: Q 65 ⇒ ${r65?.amt}đ = oracle ${stakeF(65)} (không dừng ở 50), cap NULL / at_cap false mọi dòng`, JSON.stringify([rA2.status, rA2.code, r65]))
  ok(Number((await one(`SELECT count(*)::int n FROM public.cms_result_lines WHERE run_id = $1 AND status = 'AT_CAP'`, [rA2.runId])).n) === 0
    && (await E.prog(A.id)).ptr === rA2.runId, 'run mới: 0 dòng AT_CAP · pointer trỏ run mới (từ NULL)')
  const hdr2 = RV.parseCmsResultHeader((await L.as(db, U.super, () => db.query(`SELECT public.rpc_cms_result_header($1) r`, [A.id]))).rows[0].r)
  ok(RV.cmsResultState(hdr2) === 'ok', 'header A sau resync ⇒ ok')
  // Q100 + biên: một chương trình, nhiều dược sĩ / SP, dòng qua 9→10, 19→20, 50→51.
  const h1 = E.pid(), h2 = E.pid(), h3 = E.pid()
  const H = await E.makeProgram({ name: 'QA H Q100', products: [{ pid: h1, tiers: T3(null) }, { pid: h2, tiers: T3(null), basis: 'product', target: '2000000000' }, { pid: h3, tiers: T3(null), k: '100' }] })
  const rH = await E.sync(SS, H, E.rows(H, [
    { pid: h1, s: 0, base: 9 }, { pid: h1, s: 0, base: 1 }, { pid: h1, s: 0, base: 9 }, { pid: h1, s: 0, base: 1 }, { pid: h1, s: 0, base: 30 }, { pid: h1, s: 0, base: 1 }, { pid: h1, s: 0, base: 49 },
    { pid: h1, s: 1, base: 8 }, { pid: h1, s: 2, base: 18 }, { pid: h1, s: 3, base: 99 },
    { pid: h2, s: 0, base: 1, gmv: 100000, n: 100 },
    { pid: h3, s: 1, base: 4995 }, { pid: h3, s: 1, base: 95 }, { pid: h3, s: 1, base: 5 }, { pid: h3, s: 1, base: 5 },
  ]))
  const resH = rH.status === 'published' ? await E.results(rH.runId) : []
  const ppH = new Map((await E.all(`SELECT product_id p, id::text id FROM public.cms_program_products WHERE program_id = $1`, [H.id])).map((x) => [x.p, x.id]))
  const sellerId = async (i) => (await one(`SELECT id::text id FROM public.users WHERE lower(email) = lower($1)`, [[STORES[0].assigneeEmails[0], STORES[0].assigneeEmails[1], STORES[1].assigneeEmails[0], STORES[1].assigneeEmails[1]][i]])).id
  const S = [await sellerId(0), await sellerId(1), await sellerId(2), await sellerId(3)]
  const res = (s, p) => resH.find((r) => r.u === S[s] && r.pp === ppH.get(p))
  ok(rH.status === 'published', 'H công bố qua seal SQL 122 (S7 / S8 / S14 nhận cấu hình cuối NULL — TS = SQL)', JSON.stringify([rH.status, rH.code]))
  ok(res(0, h1)?.q === '100' && res(0, h1)?.amt === '2360000' && res(0, h1)?.amt === String(stakeF(100)) && res(0, h1)?.rq === '100',
    `Q 100 ⇒ 2.360.000 (= 9×15.000 + 10×20.000 + 81×25.000; oracle ${stakeF(100)})`, JSON.stringify(res(0, h1)))
  ok(['8', '18', '99'].every((q, i) => res(i + 1, h1)?.q === q && res(i + 1, h1)?.amt === String(stakeF(q))), 'Q 8 / 18 / 99 đúng oracle', JSON.stringify([1, 2, 3].map((i) => res(i, h1))))
  const linesH = await E.all(`SELECT l.qty_before::text b, l.qty_after::text a, l.amount_vnd::text v, l.status FROM public.cms_result_lines l
    WHERE l.run_id = $1 AND l.user_id = $2 AND l.program_product_id = $3 ORDER BY l.seq`, [rH.runId, S[0], ppH.get(h1)])
  ok(JSON.stringify(linesH.map((l) => [l.b, l.a, l.v])) === JSON.stringify([['0', '9', '135000'], ['9', '10', '20000'], ['10', '19', '180000'], ['19', '20', '25000'], ['20', '50', '750000'], ['50', '51', '25000'], ['51', '100', String(49 * 25000)]])
    && linesH.reduce((s, l) => s + B(l.v), B(0)) === B(2360000) && linesH.every((l) => l.status === 'RECORDED'),
    'phân bổ dòng qua 9→10, 19→20, 50→51 (Q51 − Q50 = 25.000), tổng dòng = F(Q), không AT_CAP', JSON.stringify(linesH))
  ok(res(0, h2)?.q === '100' && res(0, h2)?.amt === '0' && res(0, h2)?.pot === '2360000' && res(0, h2)?.rq === '100' && res(0, h2)?.gate_met === false,
    'gate chưa đạt: Q 100 giữ đủ lượng / potential 2.360.000, tiền 0', JSON.stringify(res(0, h2)))
  ok(res(1, h3)?.q === '51' && res(1, h3)?.amt === String(stakeF(51)), 'K = 100: phần lẻ cộng dồn 49 → 50 (50,9) → 51; tiền = F(51), không trả sớm phần lẻ', JSON.stringify(res(1, h3)))
  ok(stakeF(101) - stakeF(100) === B(25000) && TI.cmsProgressiveAmount(B(100000), CFG.parseCmsEngineProgram({ programId: H.id, isTest: true, startDate: H.start, endDate: H.end,
    storeIds: [storeId(1)], catalogTargetGmv: null, products: [{ productId: h1, gmvBasis: 'none', targetGmv: null, baseQuantityCms: '1', tiers: T3(null) }] }).products.get(h1).tiers) === B(2499860000),
  'Q101 − Q100 = 25.000; Q 100.000 = 2.499.860.000 (miền bigint, không chặn)')
  // 4f. CÙNG run Q100 qua đường đọc app: RPC 122 (super có marker) → DTO → view-model A3 / D1 / D2 → XLSX (§9.3(13)).
  {
    const asSu = async (sql, p) => (await L.as(db, U.super, () => db.query(sql, p))).rows[0].r
    const header = RV.parseCmsResultHeader(await asSu(`SELECT public.rpc_cms_result_header($1) r`, [H.id]))
    const rowsDto = RV.parseCmsResultRows(await asSu(`SELECT public.rpc_cms_result_rows($1, $2) r`, [H.id, rH.runId]))
    const lines = []
    for (let after = null; ;) {
      const pg = RV.parseCmsResultLines(await asSu(`SELECT public.rpc_cms_result_lines($1, $2, NULL, NULL, $3, 500) r`, [H.id, rH.runId, after]))
      lines.push(...pg.rows)
      if (pg.nextAfterSeq === null) break
      after = pg.nextAfterSeq
    }
    const ppId = ppH.get(h1)
    const row100 = rowsDto.results.find((r) => r.userId === S[0] && r.programProductId === ppId)
    const tiersUi = T3(null).map((t) => ({ order: t.order, from: t.from, to: t.to, amount: t.amount }))
    const PU = await lib('lib/cms/productPresentation.ts')
    const UI = await lib('lib/cms/resultUi.ts')
    const XR = await lib('lib/cms/exportResults.ts')
    const XLSX = await import('xlsx')
    const a3 = PU.cmsA3StaffRows([row100], { tiers: tiersUi, unit: 'hộp', catalog: rowsDto.catalog, users: rowsDto.users, storeNames: new Map() })[0]
    const card = UI.cmsStaffCard({ programProductId: ppId, perUnit: '1', tiers: tiersUi, row: row100, catalog: rowsDto.catalog })
    const wi = RV.cmsWhatIf({ baseQuantity: row100.baseQuantity, perUnit: row100.perUnit, tiers: tiersUi, extraUnits: 1 })
    ok(row100.amountVnd === '2360000' && row100.capQuantity === null && !row100.atCap && !RV.cmsRunHasLegacyCap(rowsDto.results, lines)
      && a3.amountText === '2.360.000₫' && a3.status.label === 'Bậc 3 · 25.000₫/hộp' && a3.qtyNote === null
      && card.amountVnd === B(2360000) && card.position.atCap === false && card.position.next === null && wi.deltaVnd === B(25000),
    'cùng run Q100: DTO 2.360.000 · A3 "Bậc 3 · 25.000₫/hộp" không ghi chú trần · D1 không atCap · D2 "Nếu bán thêm 1" = +25.000₫',
    JSON.stringify({ amt: row100.amountVnd, a3: a3.status, note: a3.qtyNote, delta: String(wi.deltaVnd) }))
    const prodRows = await E.all(`SELECT id::text id, product_id p, name_snapshot n, unit_cms u, base_quantity_cms::text k, gmv_basis g FROM public.cms_program_products WHERE program_id = $1`, [H.id])
    const wb = XR.buildCmsResultWorkbook({ program: { id: H.id, name: 'QA H Q100', startDate: H.start, endDate: H.end, configVersion: header.configVersion },
      header, rows: rowsDto, lines, excluded: null, products: prodRows.map((x) => ({ id: x.id, productId: x.p, nameSnapshot: x.n, unitCms: x.u, baseQuantityCms: x.k, gmvBasis: x.g })),
      storeNames: new Map(), exportedAt: new Date(), scope: 'sm', returnsApproved: false })
    const sheet = wb.ok ? XLSX.utils.sheet_to_json(XLSX.read(wb.bytes, { type: 'array' }).Sheets['Theo duoc si']) : []
    const x100 = sheet.find((r) => r.user_id === S[0] && String(r.ProductID) === h1)
    const heads = wb.ok ? (XLSX.utils.sheet_to_json(XLSX.read(wb.bytes, { type: 'array' }).Sheets['Theo duoc si'], { header: 1 })[0] ?? []).map(String) : []
    ok(wb.ok && String(x100?.['CMS tạm tính (VND)']) === '2360000' && String(x100?.['SL tính CMS']) === '100' && heads.every((h) => !/trần/i.test(h)) && wb.amountVnd === B(rH.amountVnd),
      'cùng run Q100 → XLSX: dòng dược sĩ 2.360.000 · SL tính CMS 100 · không cột trần · tổng file = tổng run', JSON.stringify({ ok: wb.ok, x100, heads }))
  }

  section('5. Dừng fail-closed (DB riêng mỗi ca)')
  {
    const F = await env('stop_real')
    const pf = F.pid()
    const Rp = await F.makeProgram({ name: 'THẬT có trần', isTest: false, future: true, activate: false, products: [{ pid: pf, tiers: ONE(50) }] })
    // Mô phỏng (owner) một run bán ĐÃ CÔNG BỐ của chương trình thật theo luật cũ — đường RPC đang chặn chương trình thật (Q-206),
    // preflight vẫn phải fail-closed nếu dữ liệu như vậy xuất hiện.
    await F.db.query(`INSERT INTO public.cms_sync_runs (kind, program_id, config_version, is_test, mapping_fp, status, started_at, finished_at, sealed_at,
        published_at, amount_vnd, seal_expect, seal_step, detail)
      SELECT 'sales', id, config_version, false, md5('qa'), 'ok', now(), now(), now(), now(), 0, '{}'::jsonb, 10, '{}'::jsonb FROM public.cms_programs WHERE id = $1`, [Rp.id])
    const has = Number((await F.one(`SELECT count(*)::int n FROM public.cms_sync_runs WHERE program_id = $1 AND published_at IS NOT NULL`, [Rp.id])).n)
    const r = await execFail(F.db, SQL_125)
    const m = await F.one(`SELECT count(*)::int n FROM public.app_migrations WHERE version = '125'`)
    ok(has === 1 && errIs({ ok: r.ok, err: r.err }, '125') && /THẬT/.test(r.err ?? '') && m.n === 0
      && (await F.one(`SELECT md5(prosrc) h FROM pg_proc WHERE oid = 'public.rpc_cms_import_commit(uuid, text, text, jsonb, uuid)'::regprocedure`)).h === GEN.md5s.commit121
      && (await F.tiersOf(Rp.id))[0].t === 50,
    'chương trình THẬT có trần đã công bố ⇒ 125 DỪNG, không marker, thân 121 / dữ liệu nguyên vẹn', `${has} · ${r.err}`)
  }
  {
    const F = await env('stop_running')
    const pf = F.pid()
    const P = await F.makeProgram({ name: 'QA running', products: [{ pid: pf, tiers: ONE(null) }] })
    await F.svc(`SELECT public.rpc_cms_sales_run_open($1, '{}'::jsonb)`, [P.id])
    const r = await execFail(F.db, SQL_125)
    ok(!r.ok && /run bán đang chạy/.test(r.err) && (await F.one(`SELECT count(*)::int n FROM public.app_migrations WHERE version = '125'`)).n === 0, 'còn run bán running ⇒ 125 DỪNG', r.err)
    await F.db.exec(`CREATE OR REPLACE FUNCTION public.cms__programs_result_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$ BEGIN RETURN NEW; END; $$`)
    await F.db.query(`UPDATE public.cms_sync_runs SET status = 'error', finished_at = now(), error_code = 'STALE' WHERE kind = 'sales' AND status = 'running'`).catch(() => null)
    const r2 = await execFail(F.db, SQL_125)
    ok(!r2.ok && /md5/.test(r2.err), 'thân trigger pointer 122 lệch bản duyệt ⇒ preflight md5 DỪNG (không tắt / bật trigger lạ)', r2.err)
  }
  {
    const r = await execFail(db, SQL_125)
    ok(!r.ok && /đã có marker 125/.test(r.err), 'chạy lại 125 trên DB đã 125 ⇒ dừng', r.err)
  }

  section('6. Rollback 125 → VERIFY 124 · áp lại · rollback chuỗi 125 → 124 → profile')
  const vBefore = { A: (await E.prog(A.id)).v, B: (await E.prog(Bp.id)).v, E: (await E.prog(Ep.id)).v }
  await db.exec(RB_125); await sleep(20)
  const md5Now = async (sig) => (await one(`SELECT md5(prosrc) h FROM pg_proc WHERE oid = 'public.${sig}'::regprocedure`)).h
  ok(await md5Now('rpc_cms_import_commit(uuid, text, text, jsonb, uuid)') === GEN.md5s.commit121 && await md5Now('rpc_cms_program_activate(uuid, uuid)') === GEN.md5s.activate121
    && !(await one(`SELECT to_regprocedure('public.cms__tiers_last_open_guard()') IS NOT NULL x`)).x
    && (await one(`SELECT count(*)::int n FROM public.app_migrations WHERE version = '125'`)).n === 0, 'rollback 125: thân 2 RPC về NGUYÊN VĂN 121, guard + helper gỡ, marker xoá')
  const v124 = await E.verify('124', E.pre124)
  ok(E.bad(v124).length === 0, `VERIFY phase 124 sau rollback 125 ĐẠT (không phần dư schema): ${v124.length} mục`, E.show(v124))
  ok((await E.tiersOf(A.id)).filter((t) => t.pid === a1).at(-1).t === null && (await E.prog(A.id)).v === vBefore.A,
    'dữ liệu giữ chuyển đổi (bậc cuối NULL, version không giảm) — rollback không hứa khôi phục cận cũ')
  // PRE chụp NGAY TRƯỚC lần áp lại (đúng quy trình runbook: mỗi lần áp có PRE riêng); ACL phải bằng PRE lần đầu (rollback khôi phục ACL).
  const pre125b = await E.snapshot()
  ok(pre125b.n_all === pre125.n_all && pre125b.md5_all === pre125.md5_all, 'ảnh ACL sau rollback 125 = ảnh PRE trước lần áp đầu (ACL khôi phục đúng)')
  await db.exec(SQL_125); await sleep(20)
  const mk2 = await one(`SELECT notes FROM public.app_migrations WHERE version = '125'`)
  const notes2 = JSON.parse(/chuyển đổi chưa chốt (\{[^}]*\})/.exec(mk2.notes)[1])
  ok(notes2.programs === 0 && (await E.prog(Bp.id)).v === vBefore.B && (await E.prog(Ep.id)).v === vBefore.E, 'áp lại 125 sau rollback: không còn cấu hình cần đổi ⇒ không tăng version lần 2', JSON.stringify(notes2))
  const post2 = await E.verify('125', pre125b)
  ok(E.bad(post2).length === 0, `POST 125 sau áp lại ĐẠT: ${post2.length} mục`, E.show(post2))
  await db.exec(RB_125); await sleep(20)
  const rb124 = await execFail(db, RB('124_cms_source_attestation_rollback.sql'))
  ok(rb124.ok, 'rollback 124 sau rollback 125 (QA C chốt qa_assumption không chặn)', rb124.err)
  const prof = await E.verify('123', E.pre123, E.PROF)
  ok(E.bad(prof).length === 0, `profile after-rollback-124 phase 123 ĐẠT sau chuỗi rollback 125 → 124 (125 không để thêm phần dư): ${prof.length} mục`, E.show(prof))
  const plain = await E.verify('123', E.pre123)
  ok(JSON.stringify(E.bad(plain).map((c) => c.id)) === JSON.stringify(['table-shape:cms_sync_run_chunks']),
    'phase 123 THƯỜNG chỉ đỏ đúng 1 mục phần dư 124 (cms_sync_run_chunks) — 125 không thêm mục đỏ nào', E.bad(plain).map((c) => c.id).join(','))

  if (PG15) await race(E)

  console.log(`\n${fail === 0 ? 'ĐẠT' : 'KHÔNG ĐẠT'}: ${pass} đạt · ${fail} lỗi`)
  process.exitCode = fail === 0 ? 0 : 1
  for (const c of closers.reverse()) await Promise.resolve().then(c).catch(() => {})
  // Windows: embedded-postgres xoá thư mục dữ liệu tạm khi stop có thể EBUSY (tiến trình chưa nhả file) — chỉ cảnh báo, không đổi kết quả
  // kiểm (thư mục nằm dưới <data-root> của lượt này; người chạy tự xoá đúng đường dẫn in ra).
  if (cluster) await cluster.stop().catch((e) => console.log(`  · cảnh báo dọn PG15: ${String(e?.message ?? e).slice(0, 200)}`))
}

// ── §7 PG15: race 2 kết nối + đo ───────────────────────────────────────────────────────────────────────────────────────────────────
async function race() {
  section('7. PG15 — race 2 kết nối · lock_timeout · đo commit 2.000 bậc qua guard')
  const R = await env('race')
  const cA = await R.conn(), cC = await R.conn(), cM = await R.conn()
  const asSvc = async (c, sql, p) => { await c.query('BEGIN'); await c.query('SET LOCAL ROLE service_role'); try { const r = await c.query(sql, p); await c.query('COMMIT'); return r } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } }
  // 7a. RPC 121 CŨ đã vào thân hàm (nạp trước 125) và đang chờ khoá dòng import run × áp 125 ⇒ 125 COMMIT trước; RPC cũ đi tiếp ghi bậc
  //     cuối hữu hạn ⇒ guard deferred chặn lúc COMMIT. (RPC giữ khoá dòng CHƯƠNG TRÌNH thì 125 chờ LOCK EXCLUSIVE rồi dừng — ca 7e.)
  const p1 = R.pid()
  const P = await R.makeProgram({ name: 'QA race', products: [{ pid: p1, tiers: ONE(null) }], activate: false })
  const pr = await R.preview(P.id)
  await cC.query('BEGIN'); await cC.query(`SELECT 1 FROM public.cms_import_runs WHERE id = $1 FOR UPDATE`, [pr.run])
  const pending = settle(asSvc(cA, R.commitSql, R.commitArgs(pr, 'replace', [{ pid: p1, tiers: ONE(50) }])))
  await sleep(300)
  const mig = await settle(cM.query(SQL_125))
  await cC.query('COMMIT')
  const old = await pending
  ok(mig.ok, '125 áp được khi một RPC cũ đang chờ khoá dòng import run (không deadlock)', mig.err)
  ok(!old.ok && /CMS_TIER_LAST_FINITE/.test(old.err) && (await R.tiersOf(P.id))[0].t === null,
    'RPC 121 CŨ (thân đã nạp trước 125) ghi bậc cuối hữu hạn SAU 125 ⇒ guard deferred chặn lúc COMMIT, danh mục giữ cuối NULL', old.err)
  // 7b. import commit × kích hoạt cùng chương trình: tuần tự theo khoá dòng chương trình, không deadlock; kích hoạt thấy cấu hình mới.
  const pr2 = await R.preview(P.id)
  await cA.query('BEGIN'); await cA.query('SET LOCAL ROLE service_role')
  await cA.query(R.commitSql, R.commitArgs(pr2, 'replace', [{ pid: p1, tiers: T3(null) }]))
  const actP = settle(asSvc(cC, `SELECT public.rpc_cms_program_activate($1, $2) r`, [P.id, U.super]))
  await sleep(300)
  await cA.query('COMMIT')
  const actR = await actP
  ok(actR.ok && (await R.prog(P.id)).status === 'active' && (await R.tiersOf(P.id)).length === 3, 'import × kích hoạt: tuần tự, không deadlock, kích hoạt trên cấu hình vừa ghi (cuối NULL)', actR.err)
  // 7c. run đang mở dở (chưa COMMIT) × áp lại 125 trên DB khác: LOCK TABLE cms_sync_runs SHARE chờ ⇒ hết lock_timeout, không ghi nửa chừng.
  const Q = await env('race2')
  const q1 = Q.pid()
  const QP = await Q.makeProgram({ name: 'QA race2', products: [{ pid: q1, tiers: ONE(null) }] })
  const qA = await Q.conn(), qM = await Q.conn()
  await qA.query('BEGIN'); await qA.query('SET LOCAL ROLE service_role'); await qA.query(`SELECT public.rpc_cms_sales_run_open($1, '{}'::jsonb)`, [QP.id])
  const t0 = Date.now()
  const m2 = await settle(qM.query(SQL_125))
  const waited = Date.now() - t0
  await qA.query('ROLLBACK')
  ok(!m2.ok && /lock timeout|55P03|canceling statement due to lock timeout/i.test(m2.err + (m2.code ?? '')) && waited >= 4000
    && (await Q.one(`SELECT count(*)::int n FROM public.app_migrations WHERE version = '125'`)).n === 0,
  `run đang mở chưa COMMIT ⇒ 125 hết lock_timeout (${waited} ms), không marker / không ghi nửa chừng`, m2.err)
  // 7d. đo: commit 2.000 bậc (1.000 SP × 2 bậc) qua guard deferred — trong ngân sách RPC 8 s.
  const many = Array.from({ length: 1000 }, () => ({ pid: R.pid(), tiers: [{ order: 1, from: 1, to: 9, amount: '1000' }, { order: 2, from: 10, to: null, amount: '2000' }] }))
  const BIG = await R.makeProgram({ name: 'QA 2000 bậc', products: [{ pid: R.pid(), tiers: ONE(null) }], activate: false })
  const prB = await R.preview(BIG.id)
  const tb = Date.now()
  const rB = await settle(R.commit(prB, 'replace', many))
  const ms = Date.now() - tb
  ok(rB.ok && (await R.one(`SELECT count(*)::int n FROM public.cms_program_tiers WHERE program_id = $1`, [BIG.id])).n === 2000 && ms < 8000,
    `commit 2.000 bậc qua guard: ${ms} ms (< 8.000 ms ngân sách RPC)`, rB.err)
  console.log(`  · đo: commit 2.000 bậc ${ms} ms`)
  // 7d'. replace 2.000 → 2.000 bậc (2.000 xoá + 2.000 chèn ⇒ 4.000 sự kiện deferred) — db-reviewer 125 P2-12.
  const many2 = many.map((x) => ({ ...x, tiers: [{ order: 1, from: 1, to: 4, amount: '1500' }, { order: 2, from: 5, to: null, amount: '2500' }] }))
  const prB2 = await R.preview(BIG.id)
  const tb2 = Date.now()
  const rB2 = await settle(R.commit(prB2, 'replace', many2))
  const ms2 = Date.now() - tb2
  ok(rB2.ok && (await R.one(`SELECT count(*)::int n FROM public.cms_program_tiers WHERE program_id = $1 AND qty_to = 4`, [BIG.id])).n === 1000 && ms2 < 8000,
    `replace 2.000 → 2.000 bậc (4.000 sự kiện guard): ${ms2} ms (< 8.000 ms)`, rB2.err)
  console.log(`  · đo: replace 2.000 → 2.000 bậc ${ms2} ms`)
  // SET CONSTRAINTS ALL IMMEDIATE (app / PostgREST không bao giờ đặt): guard kiểm ngay sau TỪNG câu.
  //  · replace: câu DELETE bậc chạy trước câu DELETE SP ⇒ SP còn dòng mà 0 bậc ⇒ chặn — FAIL-CLOSED (không trần nào lọt), cả lệnh rollback.
  //    Thiết kế dựa vào DEFERRED đúng như spec §6.1.3 ("replace không bị chặn giữa chừng"); ghi trong report.
  const prI = await R.preview(BIG.id)
  await cA.query('BEGIN'); await cA.query('SET CONSTRAINTS ALL IMMEDIATE'); await cA.query('SET LOCAL ROLE service_role')
  const imm = await settle(cA.query(R.commitSql, R.commitArgs(prI, 'replace', many.slice(0, 50))))
  await cA.query('ROLLBACK').catch(() => {})
  ok(!imm.ok && /CMS_TIER_LAST_FINITE/.test(imm.err) && (await R.one(`SELECT count(*)::int n FROM public.cms_program_tiers WHERE program_id = $1`, [BIG.id])).n === 2000,
    'IMMEDIATE + RPC replace ⇒ bị từ chối fail-closed (SP tạm 0 bậc giữa hai câu DELETE), danh mục nguyên 2.000 bậc', imm.err)
  //  · append (chương trình P đã kích hoạt, đã bắt đầu ⇒ mode append): SP mới + đủ bậc trong một câu chèn ⇒ đạt kể cả IMMEDIATE.
  const pA = R.pid()
  const prA = await R.preview(P.id, 'append')
  await cA.query('BEGIN'); await cA.query('SET CONSTRAINTS ALL IMMEDIATE'); await cA.query('SET LOCAL ROLE service_role')
  const immA = await settle(cA.query(R.commitSql, R.commitArgs(prA, 'append', [{ pid: pA, tiers: T3(null) }])))
  await cA.query(immA.ok ? 'COMMIT' : 'ROLLBACK').catch(() => {})
  ok(immA.ok && (await R.tiersOf(P.id)).filter((t) => t.pid === pA).length === 3, 'IMMEDIATE + RPC append hợp lệ ⇒ đạt (mỗi SP chèn đủ bậc trong một câu)', immA.err)
  // 7e. (db-reviewer 125 P2-1) Phiên ĐANG giữ khoá dòng chương trình CẦN chuyển đổi (FOR UPDATE) ⇒ 125 chờ LOCK EXCLUSIVE rồi dừng theo
  //     lock_timeout — không deadlock 40P01 ở §3, không ghi nửa chừng; nhả khoá ⇒ 125 áp được và chuyển đổi đúng.
  const X = await env('race3')
  const x1 = X.pid()
  const XP = await X.makeProgram({ name: 'QA race3 có trần', products: [{ pid: x1, tiers: T3(50) }] })
  const xA = await X.conn(), xM = await X.conn()
  await xA.query('BEGIN'); await xA.query(`SELECT 1 FROM public.cms_programs WHERE id = $1 FOR UPDATE`, [XP.id])
  const t1 = Date.now()
  const m3 = await settle(xM.query(SQL_125))
  const w3 = Date.now() - t1
  await xA.query('ROLLBACK')
  if (!m3.ok) await xM.query('ROLLBACK').catch(() => {})
  ok(!m3.ok && /lock timeout|55P03/i.test(m3.err + (m3.code ?? '')) && !/deadlock|40P01/i.test(m3.err + (m3.code ?? '')) && w3 >= 4000
    && (await X.one(`SELECT count(*)::int n FROM public.app_migrations WHERE version = '125'`)).n === 0 && (await X.tiersOf(XP.id)).at(-1).t === 50,
  `khoá dòng chương trình cần chuyển đổi đang bị giữ ⇒ 125 dừng ở LOCK EXCLUSIVE sau ${w3} ms (lock_timeout, không deadlock), dữ liệu nguyên`, m3.err)
  const m4 = await settle(xM.query(SQL_125))
  ok(m4.ok && (await X.tiersOf(XP.id)).at(-1).t === null, 'nhả khoá ⇒ áp lại 125 đạt, bậc cuối đã chuyển NULL', m4.err)
}

main().catch(async (e) => {
  // Dòng ✗ (stdout) để bộ đột biến / log gate thấy LÝ DO dừng (vd. hậu kiểm trong migration 125 RAISE) — không chỉ mã thoát.
  console.log(`  ✗ LỖI NGOÀI DỰ KIẾN: ${String(e?.message ?? e).split('\n')[0].slice(0, 300)}`)
  console.error(`\nLỖI NGOÀI DỰ KIẾN: ${e?.stack ?? e}`)
  for (const c of closers.reverse()) await Promise.resolve().then(c).catch(() => {})
  if (cluster) await cluster.stop().catch(() => {})
  process.exit(1)
})
