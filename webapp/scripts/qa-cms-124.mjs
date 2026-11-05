// QA migration 124 (CMS COMP-INT — chứng nhận đối soát nguồn) + tầng app trên PGlite (Postgres 16 WASM): nền 114–116 + 120 → 124
// NGUYÊN VĂN từ supabase/migrations (124 SINH bằng scripts/gen-cms-124.mjs — kiểm không lệch). Kiểm trên JSON THẬT của RPC:
//   §0 generator ↔ file · §1 áp / chạy lại dừng · §2 VERIFY phase 124 (POST đạt, phase 123 trên DB 124 đỏ, đột biến ACL / config /
//   trigger đỏ) + V8 phase 124 · §3 lõi đồng bộ (lib/cms/salesSync) capture ON / OFF / DB không trả source_schema · §4 chứng nhận qua
//   lõi CLI (e2e/cmsSourceAttest) — xuất phân trang, compare TÍNH LẠI, decision10 duy nhất, tái hiện PM COMP-P1-1 (audit14 / GMV +1 …),
//   chỉ source_updated_at khác vẫn MATCH · §5 lõi action chốt 6 tham số + payout / XLSX · §6 rollback (dừng khi đã chốt bằng chứng
//   nhận; DB khác: md5 về 122 / 123, app capture ⇒ SOURCE_SCHEMA_UNSUPPORTED, áp lại) · §7 CLI scripts/cms-source-attest.mjs đầu-cuối
//   qua shim HTTP (pg-meta + PostgREST giả trên PGlite: export-run / attest dry-run + --write / mất phản hồi ⇒ unknown ⇒ reconcile /
//   revoke / status).
// GIỚI HẠN: PGlite một session ⇒ race / timeout / cancel / benchmark ở PG15 thật
// (planning/research/dev-tools/cms/draft-completeness/124-realpg-test.mjs). KHÔNG chạm DB thật.
//   npm i --no-save @electric-sql/pglite@0.2.17 ; node scripts/qa-cms-124.mjs     # kỳ vọng: N đạt · 0 lỗi
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'
import * as XLSX from 'xlsx'
import * as L from './lib-care-pglite.mjs'
import { buildCms124, CMS_124_FILE, CMS_124_ROLLBACK_FILE } from './gen-cms-124.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIG = path.join(HERE, '..', '..', 'supabase', 'migrations')
const SQL = (f) => fs.readFileSync(path.join(MIG, f), 'utf8')
const SQL_124 = fs.readFileSync(CMS_124_FILE, 'utf8')
const RB_124 = fs.readFileSync(CMS_124_ROLLBACK_FILE, 'utf8')

let PGlite
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch {
  console.error('FAIL: thiếu @electric-sql/pglite — chạy: npm i --no-save @electric-sql/pglite@0.2.17 (trong webapp/)')
  process.exit(2)
}
const jiti = createJiti(import.meta.url, { interopDefault: true, alias: { '@': path.join(HERE, '..') } })
const lib = (p) => jiti.import(path.join(HERE, '..', p))
const E = await lib('lib/cms/engine/compute.ts')
const RS = await lib('lib/cms/resultStage.ts')
const C = await lib('lib/cms/source/contract.ts')
const D = await lib('lib/cms/decimal.ts')
const TM = await lib('lib/cms/time.ts')
const SS = await lib('lib/cms/salesSync.ts')
const PV = await lib('lib/cms/payoutView.ts')
const LA = await lib('lib/cms/lockAction.ts')
const XP = await lib('lib/cms/exportPayouts.ts')
const A = await lib('e2e/cmsSourceAttest.ts')
const X = await lib('e2e/cmsI4CompareSource.ts')
const I = await lib('e2e/cmsI4Offline.ts')
const T = await lib('e2e/cmsQaTooling.ts')
const FX = await lib('e2e/cmsFixtureRunner.ts')
const QR = await lib('e2e/cmsQaResults.ts')

const bail = (e) => { console.error(`\nLỖI NGOÀI DỰ KIẾN: ${e?.stack ?? e}`); process.exit(1) }
process.on('uncaughtException', bail)
process.on('unhandledRejection', bail)
let pass = 0, fail = 0
const ok = (c, name, extra = '') => { if (c) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name} ${extra}`) } }
const section = (s) => console.log(`\n${s}`)
const { U, storeId, STORES, one, as, sha } = L
const lastRows = (results) => { for (let i = results.length - 1; i >= 0; i--) if (results[i].rows?.length) return results[i].rows; return [] }
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, err: String(e?.message ?? e), code: e?.code }))
const errIs = (r, code) => !r.ok && new RegExp(`\\b${code}\\b`).test(r.err)

section('0. Generator ↔ file (không sửa tay file sinh)')
{
  const g = buildCms124()
  ok(g.migration === SQL_124 && g.rollback === RB_124, 'scripts/gen-cms-124.mjs sinh ĐÚNG byte 124 + rollback trên đĩa')
}

// ── Nền DB + helper (mẫu qa-cms-123) ─────────────────────────────────────────
async function baseDb() {
  const db = await L.freshDb(PGlite)
  await db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('117','t'),('118','t'),('118a','t'),('119','t'),('119a','t') ON CONFLICT DO NOTHING`)
  for (const f of ['120_cms_foundation.sql', '121_cms_import_activation.sql', '122_cms_results.sql', '123_cms_payouts.sql']) await db.exec(SQL(f))
  await db.query(`INSERT INTO public.cms_product_master (product_id, product_name, is_active, source_updated_at)
    SELECT g::text, 'SP giả ' || g, true, now() FROM generate_series(924001, 924060) g`)
  return db
}
function helpers(db) {
  const svc = (sql, params = []) => as(db, null, () => db.query(sql, params), 'service_role')
  const asSuper = (sql, params = []) => as(db, U.super, () => db.query(sql, params))
  let pidNext = 924001, seqf = 0
  const T_ONE = [{ order: 1, from: 1, to: null, amount: '1000' }]
  return {
    svc, asSuper,
    async day(n) { const t = (await one(db, `SELECT public.cms__vn_today()::text d`)).d; const d = new Date(`${t}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) },
    async makeProgram({ isTest = true, nProducts = 2 } = {}) {
      const pids = Array.from({ length: nProducts }, () => String(pidNext++))
      const start = await this.day(-20), end = await this.day(-1)
      const id = (await svc(`SELECT public.rpc_cms_program_save($1::jsonb) id`, [JSON.stringify({ actor: U.super, name: 'QA CMS 124', start_date: start, end_date: end,
        scope: 'stores', store_ids: [storeId(1), storeId(2)], is_test: isTest })])).rows[0].id
      const fileSha = sha(`f124-${++seqf}`), digest = sha(`d124-${seqf}`)
      const run = (await svc(`SELECT public.rpc_cms_import_preview_save($1::jsonb) id`, [JSON.stringify({ program_id: id, mode: 'replace', file_name: 'qa.xlsx',
        file_sha256: fileSha, file_bytes: 10, actor: U.super, stats: { rowsTotal: 1, rowsOk: 1, rowsRejected: 0, warnings: 0, productsOk: 1, productsRejected: 0 },
        result: { digest } })])).rows[0].id
      await svc(`SELECT public.rpc_cms_import_commit($1, $2, $3, $4::jsonb, $5)`, [run, fileSha, digest, JSON.stringify({ mode: 'replace', catalog_target: null,
        products: pids.map((product_id) => ({ product_id, gmv_basis: 'none', target_gmv: null, base_quantity_cms: '2', tiers: T_ONE, unit_cms: 'hộp',
          advice_text: 'QA', name_snapshot: 'SP giả', image_url_snapshot: null, price_snapshot: null })) }), U.super])
      await svc(`SELECT public.rpc_cms_program_activate($1, $2)`, [id, U.super])
      return { id, pids, start, end }
    },
  }
}
let lineSeq = 0
const EM = (i, ab = 'a') => STORES[i - 1].assigneeEmails[ab === 'a' ? 0 : 1]
/** Dòng nguồn THÔ (như adapter đọc) trong kỳ: kể cả ONLINE / huỷ / chờ xác nhận. */
function rawRows(p, specs) {
  const out = []
  const base = Date.parse(`${p.start}T01:00:00Z`)
  for (const s of specs) for (let i = 0; i < s.n; i++) {
    const id = ++lineSeq
    const at = new Date(base + id * 3_600_000).toISOString().replace('Z', '').padEnd(23, '0') + `${String(id % 1000).padStart(3, '0')}Z`
    out.push({ order_line_id: String(924000000 + id), order_id: `O${id}`, order_code: `QA-${id}`, product_id: p.pids[i % p.pids.length],
      seller_email: s.email ?? [EM(1), EM(1, 'b'), EM(2), EM(2, 'b')][i % 4], pos_code: 'QAOS01', order_type: s.type ?? 'OFFLINE',
      order_status: s.status ?? 'COMPLETED', completed_at: at, quantity_raw: '1', uom_raw: 'Hộp', base_quantity: String(1 + (i % 3)),
      gmv_amount: String(s.gmv ?? 10000 + i * 100), source_updated_at: at })
  }
  return out
}
const linesOf = (rows) => rows.map((r) => { const n = C.normalizeSalesRow(r); if (!n.ok) throw new Error('dòng giả lỗi'); return n.value })
/** Deps THẬT của lõi đồng bộ nối PGlite (RPC 122 / 124 vai service_role), nguồn = runner giả. */
function syncDeps(db, h, rows, o = {}) {
  const calls = { stage: [] }
  const rpc = async (sql, params) => {
    try { return (await h.svc(sql, params)).rows[0].r } catch (e) {
      const m = /\bCMS_[A-Z0-9_]+\b/.exec(String(e.message)); throw new Error(m ? m[0] : 'RPC_FAILED')
    }
  }
  return {
    calls,
    deps: {
      table: QR.CMS_QA_FAKE_TABLE, runner: FX.createCmsFixtureRunner({ sales: rows }),
      loadSnapshot: (id) => rpc(`SELECT public.rpc_cms_sales_snapshot($1) r`, [id]),
      openRun: async (id, detail) => { const r = await rpc(`SELECT public.rpc_cms_sales_run_open($1, $2::jsonb) r`, [id, JSON.stringify(detail)]); return o.dropSchema ? (({ source_schema: _s, ...x }) => x)(r) : r },
      stage: async (runId, part, chunkNo, rws) => { calls.stage.push(part); return Number(await rpc(`SELECT public.rpc_cms_sales_run_stage($1, $2, $3, $4::jsonb) r`, [runId, part, chunkNo, JSON.stringify(rws)])) },
      sealBegin: (runId, expect) => rpc(`SELECT public.rpc_cms_sales_run_seal_begin($1, $2::jsonb) r`, [runId, JSON.stringify(expect)]),
      sealStep: (runId, step) => rpc(`SELECT public.rpc_cms_sales_run_seal_step($1, $2) r`, [runId, step]),
      publish: (runId) => rpc(`SELECT public.rpc_cms_sales_run_publish($1) r`, [runId]),
      finish: async (runId, status, detail) => { await rpc(`SELECT public.rpc_cms_sales_run_finish($1, $2, $3::jsonb) r`, [runId, status, JSON.stringify(detail)]) },
      cleanup: (id, max) => rpc(`SELECT public.rpc_cms_sales_run_cleanup($1, $2) r`, [id, max]),
      now: () => Date.now(),
    },
  }
}

const db = await baseDb()
const H = helpers(db)
await db.query(`INSERT INTO public.cms_qa_access (user_id, granted_by, expires_at) VALUES ($1, 'qa-script:qa-cms-124', now() + interval '6 hours')`, [U.super])
const lastQ = (sql) => db.exec(T.pgMetaReadOnly(sql)).then(lastRows)

section('1. Áp 124 trên 120–123 (hậu kiểm trong transaction) · chạy lại ⇒ dừng')
// PRE VERIFY (chụp NGAY TRƯỚC 124) — giờ DB phải trước applied_at của 124.
const pre124 = (await lastQ(T.cmsVerifyAclSql()))[0]
await new Promise((r) => setTimeout(r, 20))
{
  const r = await settle(db.exec(SQL_124))
  ok(r.ok, 'chạy 124 (18 hàm ACL, tổng hàm 67, 9 trigger ALWAYS, PG ≥ 14 + UTF8, real.ready false)', r.err)
  const again = await settle(db.exec(SQL_124))
  await db.exec('ROLLBACK').catch(() => {})
  ok(!again.ok && /đã có marker 124/.test(again.err), 'chạy lại 124 ⇒ preflight dừng', again.err)
}

section('2. VERIFY phase 124 (POST) · phase 123 trên DB 124 ⇒ đỏ · đột biến ⇒ đỏ · V8 phase 124')
async function postInput(phase, aclPre) {
  const q = T.CMS_VERIFY_SQL
  const input = {
    phase, whoami: (await lastQ(q.whoami))[0], markers: await lastQ(q.markers), maxNumeric: (await lastQ(q.maxNumeric))[0],
    functions: await lastQ(q.functions), policies: await lastQ(q.policies), triggers: await lastQ(q.triggers), tableShape: await lastQ(q.tableShape),
    tables: await lastQ(q.tables), roles: await lastQ(q.roles), oneRunningIndex: await lastQ(q.oneRunningIndex),
    aclPost: (await lastQ(T.cmsVerifyAclSql()))[0], aclPre,
    inv121: { overlap: await lastQ(q.inv121Overlap), tiers: await lastQ(q.inv121Tiers), catalog: await lastQ(q.inv121Catalog) },
    isolation: (await lastQ(q.isolation))[0],
    p122: { tiersUnique: await lastQ(q.tiersUnique), pointerFk: await lastQ(q.pointerFk), releaseGate: (await lastQ(q.releaseGate))[0],
      inv122Pointer: await lastQ(q.inv122Pointer), fnDefs: await lastQ(q.fnDefs), columns: await lastQ(q.columns) },
    p123: { owners: (await lastQ(q.owners))[0], isolation123: (await lastQ(q.isolation123))[0], triggerFns: await lastQ(q.triggerFns),
      lockPolicy: (await lastQ(q.lockPolicy))[0], payoutAcl: await lastQ(q.payoutAcl), invPayout: (await lastQ(q.invPayout))[0] ?? { n: 0, bad: 0 },
      invLocked: (await lastQ(q.invLocked))[0], invPayoutStaff: (await lastQ(q.invPayoutStaff))[0] ?? { n: 0, bad: 0 },
      invRunFrozen: (await lastQ(q.invRunFrozen))[0] ?? { n: 0, bad: 0 }, payoutReach: await lastQ(q.payoutReach), lockPreview: (await lastQ(q.lockPreview))[0] ?? { n_real: 0, open_n: 0 } },
  }
  if (phase === '124') input.p124 = { invAttest: (await lastQ(q.invAttest))[0] ?? { n: 0, bad: 0 } }
  return input
}
const failedIds = (cs) => cs.filter((c) => !c.ok).map((c) => c.id)
{
  // PGlite: hàm SECDEF owner là postgres (không phải role riêng) — v0 / isolation như qa-cms-qa-tooling (mục môi trường, không thuộc 124).
  const ENV_ONLY = new Set(['v7-isolation-123', 'isolation'])
  const post = T.evaluateCmsVerify(await postInput('124', pre124))
  const bad = post.filter((c) => !c.ok && !ENV_ONLY.has(c.id))
  ok(bad.length === 0, `POST phase 124: ${post.length} mục, lệch ${bad.length}`, bad.map((c) => `${c.id}: ${c.detail}`).slice(0, 6).join(' | '))
  ok(post.some((c) => c.id === 'fn-src:rpc_cms_sales_run_open' && c.ok) && post.some((c) => c.id === 'fn-config:rpc_cms_program_lock' && c.ok)
    && post.some((c) => c.id === 'acl-preexisting-functions' && c.ok), 'POST 124 kiểm thân run_open mới, lock_timeout 2 s của lock, ACL mọi hàm có trước (trừ lock đổi chữ ký)')
  const as123 = T.evaluateCmsVerify(await postInput('123', pre124))
  ok(failedIds(as123).includes('phase-match'), 'checker phase 123 trên DB 124 ⇒ phase-match ĐỎ (không xanh giả)')
  const mutate = async (sqlOn, sqlOff, id, name) => {
    await db.exec(sqlOn)
    const ids = failedIds(T.evaluateCmsVerify(await postInput('124', pre124)))
    await db.exec(sqlOff)
    ok(ids.some((x) => x.startsWith(id)), `đột biến ${name} ⇒ ${id} ĐỎ`, ids.join(','))
  }
  await mutate(`GRANT EXECUTE ON FUNCTION public.rpc_cms_run_source_export(uuid, uuid, text, integer) TO anon`,
    `REVOKE EXECUTE ON FUNCTION public.rpc_cms_run_source_export(uuid, uuid, text, integer) FROM anon`, 'fn-exec:rpc_cms_run_source_export', 'GRANT anon export')
  await mutate(`ALTER FUNCTION public.rpc_cms_source_attest(uuid, uuid, jsonb, uuid) SET lock_timeout = '3s'`,
    `ALTER FUNCTION public.rpc_cms_source_attest(uuid, uuid, jsonb, uuid) SET lock_timeout = '2s'`, 'fn-config:rpc_cms_source_attest', 'lock_timeout attest 3 s')
  await mutate(`ALTER TABLE public.cms_source_attestations DISABLE TRIGGER cms_attest_insert_guard`,
    `ALTER TABLE public.cms_source_attestations ENABLE ALWAYS TRIGGER cms_attest_insert_guard`, 'triggers', 'tắt trigger chặn INSERT')
  await mutate(`GRANT SELECT ON public.cms_source_attestations TO authenticated`, `REVOKE SELECT ON public.cms_source_attestations FROM authenticated`,
    'table:cms_source_attestations', 'cấp SELECT bảng chứng nhận cho authenticated')
  const restored = T.evaluateCmsVerify(await postInput('124', pre124)).filter((c) => !c.ok && !ENV_ONLY.has(c.id))
  ok(restored.length === 0, 'sau khôi phục đột biến: POST 124 lại đạt', restored.map((c) => c.id).join(','))
  const [v8] = lastRows(await db.exec(T.pgMetaReadOnlySnapshot(T.cmsVerifyV8Sql(U.super, 'super', '124'))))
  const v8c = T.evaluateCmsV8(v8, U.super, 'super', { phase: '124' })
  ok(failedIds(v8c).length === 0, `V8 phase 124 (super): ${v8c.length} mục đạt — RPC gọi được gồm 4 RPC chứng nhận`, failedIds(v8c).join(','))
}

section('3. Lõi đồng bộ trên RPC THẬT: capture ON / OFF / DB không trả source_schema')
const P1 = await H.makeProgram()
const rows1 = rawRows(P1, [{ n: 40 }, { n: 6, type: 'ONLINE' }, { n: 3, status: 'CANCELLED' }, { n: 2, email: 'khong.co@example.invalid', gmv: 10 }])
let R1
{
  const s = syncDeps(db, H, rows1)
  const r = await SS.runCmsSalesSync(s.deps, P1.id, { dryRun: false, source: 'qa', sourceCapture: true })
  R1 = r.runId
  const chk = await one(db, `SELECT public.cms__run_source_check($1) k, (SELECT source_schema FROM public.cms_sync_runs WHERE id = $1) v,
    (SELECT count(*)::int FROM public.cms_sales_source_lines WHERE run_id = $1) n`, [R1])
  ok(r.status === 'published' && r.sourceRows === rows1.length && chk.k === null && chk.v === 1 && chk.n === rows1.length && s.calls.stage.includes('source_lines'),
    `capture ON: công bố, lớp nguồn ${chk.n} dòng (gồm ONLINE / huỷ / không gán), kiểm lớp nguồn đạt, source_schema 1 THỰC từ run_open`, JSON.stringify({ r: [r.status, r.code, r.sourceRows], chk }))
  const snap = RS.parseCmsSalesSnapshot((await H.svc(`SELECT public.rpc_cms_sales_snapshot($1) r`, [P1.id])).rows[0].r)
  ok(snap.sourceSchema === null && snap.runId === null, 'snapshot CHỈ ĐỌC không có source_schema (parser phân biệt snapshot / kết quả mở run)')
}
{
  const P0 = await H.makeProgram()
  const s = syncDeps(db, H, rawRows(P0, [{ n: 10 }]))
  const r = await SS.runCmsSalesSync(s.deps, P0.id, { dryRun: false, source: 'qa', sourceCapture: false })
  const k = (await one(db, `SELECT public.cms__run_source_check($1) k`, [r.runId])).k
  ok(r.status === 'published' && r.sourceRows === null && !s.calls.stage.includes('source_lines') && k === 'SOURCE_COUNT',
    'capture OFF (mặc định): không gửi source_lines; run sau 124 không chứng nhận được (SOURCE_COUNT) — không phải legacy', JSON.stringify([r.status, k]))
  const s2 = syncDeps(db, H, rawRows(P0, [{ n: 10 }]), { dropSchema: true })
  const r2 = await SS.runCmsSalesSync(s2.deps, P0.id, { dryRun: false, source: 'qa', sourceCapture: true })
  const run2 = await one(db, `SELECT status, error_code FROM public.cms_sync_runs WHERE id = $1`, [r2.runId])
  ok(r2.status === 'error' && r2.code === 'SOURCE_SCHEMA_UNSUPPORTED' && s2.calls.stage.length === 0 && run2.status === 'error',
    'capture ON nhưng open không trả source_schema (DB cũ / rollback) ⇒ đóng run lỗi SOURCE_SCHEMA_UNSUPPORTED, 0 stage / publish', JSON.stringify([r2.status, r2.code, run2]))
}

{
  const PR = await H.makeProgram()
  const ls = linesOf(rawRows(PR, [{ n: 8 }]))
  const snap = RS.parseCmsSalesSnapshot((await H.svc(`SELECT public.rpc_cms_sales_run_open($1, '{"source":"qa"}'::jsonb) r`, [PR.id])).rows[0].r)
  const inp = RS.cmsSnapshotToEngineInput(snap)
  const pl = RS.buildCmsStagePayload(snap, ls, E.computeCmsProgram({ program: inp.program, lines: ls, sellers: inp.sellers }),
    { rowsRead: ls.length + 1, rowsRejected: 1, bytesProcessed: null, chunkSize: 5000 })
  const stg = async (part, rowsP) => { const ch = RS.chunkCmsStageRows(rowsP, 5000); for (let i = 0; i < ch.length; i++) await H.svc(`SELECT public.rpc_cms_sales_run_stage($1, $2, $3, $4::jsonb)`, [snap.runId, part, i, JSON.stringify(ch[i])]) }
  for (const part of RS.CMS_STAGE_PARTS) await stg(part, pl.parts[part])
  await stg(RS.CMS_SOURCE_PART, RS.buildCmsSourceStageRows(ls))
  await H.svc(`SELECT public.rpc_cms_sales_run_seal_begin($1, $2::jsonb)`, [snap.runId, JSON.stringify(pl.expect)])
  for (let i = 1; i <= 10; i++) { const r = (await H.svc(`SELECT public.rpc_cms_sales_run_seal_step($1, $2) r`, [snap.runId, i])).rows[0].r; if (r.sealed) break }
  await H.svc(`SELECT public.rpc_cms_sales_run_publish($1)`, [snap.runId])
  ok((await one(db, `SELECT public.cms__run_source_check($1) k`, [snap.runId])).k === 'SOURCE_REJECTED', 'run công bố có dòng nguồn bị từ chối ⇒ SOURCE_REJECTED (không chứng nhận được — db-reviewer r2 P2-4)')
}

section('4. Chứng nhận qua lõi CLI: xuất phân trang · compare TÍNH LẠI · decision10 duy nhất (PM COMP-P1-1)')
const prog1 = A.parseCmsAttestProgram((await H.svc(A.cmsAttestProgramSql(P1.id))).rows[0])
let exportRows, appCsv
{
  let st = A.newCmsAttestExportState(P1.id, R1)
  for (let after = null; ;) {
    const page = (await H.asSuper(`SELECT public.rpc_cms_run_source_export($1, $2, $3, 7) r`, [P1.id, R1, after])).rows[0].r
    const pg = A.cmsAttestExportPage(st, page, 7)
    if (!pg.ok) { ok(false, 'xuất trang', pg.code); break }
    st = pg.state
    if (pg.done) break
    after = st.lastId
  }
  exportRows = st.rows
  appCsv = A.cmsAttestExportCsv(st.rows)
  const back = I.cmsI4ReadCsv(new Uint8Array(Buffer.from(appCsv, 'utf8')), C.CMS_SALES_COLUMNS)
  ok(st.rows.length === rows1.length && st.pages === Math.ceil(rows1.length / 7) && back.ok && JSON.stringify(back.rows) === JSON.stringify(st.rows),
    `xuất ${st.rows.length} dòng / ${st.pages} trang (keyset byte, đếm = total trang đầu); CSV đọc lại đúng từng ô`)
  const bad = A.cmsAttestExportPage(A.newCmsAttestExportState(P1.id, R1), { run_id: R1, source_schema: 1, rows: [], next_after: null, total: 3 }, 7)
  ok(!bad.ok && bad.code === 'EXPORT_COUNT', 'trang cuối mà số dòng ≠ total ⇒ EXPORT_COUNT (không file "hoàn chỉnh")')
}
const dbNow = async () => (await one(db, `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') t`)).t
async function attempt(refRows, o = {}) {
  const refCsv = A.cmsAttestExportCsv(refRows)
  const refSha = sha(refCsv), appSha = sha(appCsv)
  const at = await dbNow()
  const side = (kind, s) => ({ inputKind: kind, source: kind === 'reference_source' ? 'Nguồn độc lập giả — QA' : 'rpc_cms_run_source_export', exportedAt: at, asOf: at,
    fileSha256: s, scope: { startDate: prog1.startDate, endDate: prog1.endDate, productIds: prog1.productIds }, runId: kind === 'published_run' ? R1 : null })
  const meta = X.cmsI4ParseEvidenceMeta({ version: 1, reference: side('reference_source', refSha), app: side('published_run', appSha) })
  const compare = X.cmsI4CompareSource({ context: A.cmsAttestContext(prog1), reference: { rows: I.cmsI4ReadCsv(new Uint8Array(Buffer.from(refCsv)), C.CMS_SALES_COLUMNS).rows, fileSha256: refSha },
    app: { rows: I.cmsI4ReadCsv(new Uint8Array(Buffer.from(appCsv)), C.CMS_SALES_COLUMNS).rows, fileSha256: appSha }, meta: meta.value })
  const built = A.cmsAttestBuildPayload({ program: prog1, runId: R1, compare, meta: meta.value, refSha, appSha, ack: 'Đã đối soát nguồn độc lập toàn kỳ (QA giả)' })
  return { compare, built, payloadOf: (extra = {}) => ({ fp_version: 'cms-rows-fp-v1', field_set: 'decision10', scope_from: prog1.startDate, scope_to: prog1.endDate,
    scope_hash: compare.scope.scopeHash, run_rows_fp: compare.app.decisionFp, run_file_sha256: appSha, reference_rows_fp: compare.reference.decisionFp,
    reference_file_sha256: refSha, reference_label: 'Nguồn độc lập giả — QA', as_of: at, reference_exported_at: at, run_exported_at: at,
    lines_compared: String(compare.compare.matched), missing_lines: '0', extra_lines: '0', changed_lines: '0', tool_version: 'cms-i4-compare-v1',
    ack_reason: 'Đã đối soát nguồn độc lập toàn kỳ (QA giả)', ...o, ...extra }) }
}
const attestRpc = (payload, idem = crypto.randomUUID()) => settle(H.asSuper(`SELECT public.rpc_cms_source_attest($1, $2, $3::jsonb, $4) r`, [P1.id, R1, JSON.stringify(payload), idem]).then((x) => x.rows[0].r))
// Tham chiếu độc lập: email viết hoa + khoảng trắng (chuẩn hoá như app) — vẫn KHỚP.
const refBase = exportRows.map((r) => ({ ...r, seller_email: r.seller_email ? ` ${r.seller_email.toUpperCase()} ` : null }))
let A1
{
  const a = await attempt(refBase)
  ok(a.compare.verdict === 'MATCH' && a.built.ok, 'compare-source (tham chiếu ↔ xuất run) MATCH ⇒ dựng payload decision10', JSON.stringify(a.built.reasons ?? a.compare.dataIssues))
  const r = await attestRpc(a.built.payload)
  A1 = r.v?.id
  ok(r.ok && r.v.attested && !r.v.already, 'super (marker QA) chứng nhận decision10 ⇒ ghi', r.err)
  const audit = await attempt(refBase, { field_set: 'audit14' })
  const ra = await attestRpc(audit.payloadOf())
  ok(errIs(ra, 'CMS_ATTEST_BAD_INPUT'), 'field_set audit14 ⇒ BAD_INPUT trước mọi khoá / ghi (PM COMP-P1-1)', ra.err)
}
{
  // Tái hiện PM: tham chiếu GMV +1 đ dòng đầu. Lõi CLI không dựng payload; payload ép (vân tay tham chiếu khác) ⇒ DB NOT_MATCH.
  const gmv1 = refBase.map((r, i) => (i === 0 ? { ...r, gmv_amount: String(BigInt(r.gmv_amount) + BigInt(1)) } : r)) // GMV dòng giả là số nguyên VND
  const a = await attempt(gmv1)
  ok(a.compare.verdict !== 'MATCH' && !a.built.ok, 'PM repro: tham chiếu GMV +1 đ ⇒ compare không MATCH, CLI không dựng payload')
  const forced = await attestRpc(a.payloadOf({ missing_lines: '0', changed_lines: '0' }))
  ok(errIs(forced, 'CMS_ATTEST_NOT_MATCH'), 'PM repro: payload ép decision10 với vân tay tham chiếu ≠ run ⇒ DB NOT_MATCH (không còn đường audit14)', forced.err)
  const forced14 = await attestRpc(a.payloadOf({ field_set: 'audit14' }))
  ok(errIs(forced14, 'CMS_ATTEST_BAD_INPUT'), 'PM repro: cùng payload khai audit14 ⇒ BAD_INPUT', forced14.err)
  const variants = {
    'người bán': (r) => ({ ...r, seller_email: 'khac@example.invalid' }), 'SL': (r) => ({ ...r, base_quantity: '9' }),
    'type': (r) => ({ ...r, order_type: 'ONLINE' }), 'status': (r) => ({ ...r, order_status: 'CANCELLED' }),
    'completed_at': (r) => ({ ...r, completed_at: r.completed_at.replace(/\.(\d{6})Z$/, (m, us) => `.${String((Number(us) + 1) % 1000000).padStart(6, '0')}Z`) }),
  }
  for (const [k, f] of Object.entries(variants)) {
    const v = await attempt(refBase.map((r, i) => (i === 1 ? f(r) : r)))
    ok(v.compare.verdict !== 'MATCH' && !v.built.ok && v.compare.reference.decisionFp !== v.compare.app.decisionFp, `tham chiếu đổi ${k} ⇒ không MATCH, vân tay decision10 khác`)
  }
  const swap = refBase.map((r, i) => (i === 0 ? { ...r, gmv_amount: refBase[1].gmv_amount } : i === 1 ? { ...r, gmv_amount: refBase[0].gmv_amount } : r))
  const sv = await attempt(swap)
  ok(sv.compare.verdict !== 'MATCH' && sv.compare.reference.decisionFp !== sv.compare.app.decisionFp, 'hai dòng đổi GMV (tổng giữ nguyên) ⇒ không MATCH')
  const info = await attempt(refBase.map((r, i) => (i === 2 ? { ...r, source_updated_at: '2026-01-01T00:00:00.000000Z' } : r)))
  ok(info.compare.verdict === 'MATCH' && info.built.ok && info.compare.reference.decisionFp === info.compare.app.decisionFp, 'chỉ source_updated_at khác ⇒ compare decision10 MATCH')
  const ri = await attestRpc(info.built.payload)
  ok(ri.ok && ri.v.superseded_id === A1, 'chứng nhận decision10 khi chỉ source_updated_at khác ⇒ hợp lệ (thay chứng nhận trước)', ri.err)
  A1 = ri.v?.id
  // db-reviewer r2 P2-3: dòng chứng nhận do OWNER ghi thẳng (qua mọi CHECK) mà as_of trước hết kỳ / lines_compared lệch ⇒ eval mã,
  // không thành basis. Thu hồi (owner, trước chốt — trigger cho phép) rồi chèn bản sao sửa một trường.
  const ownerCopy = async (from, patchObj) => {
    await db.query(`UPDATE public.cms_source_attestations SET revoked_at = now(), revoked_by = $2, revoke_reason = 'QA thử ghi thẳng (owner)', revoke_idem_key = gen_random_uuid() WHERE id = $1`, [from, U.super])
    const id = crypto.randomUUID()
    await db.query(`INSERT INTO public.cms_source_attestations SELECT (jsonb_populate_record(NULL::public.cms_source_attestations, to_jsonb(a) || $2::jsonb)).*
      FROM public.cms_source_attestations a WHERE a.id = $1`, [from, JSON.stringify({ id, idem_key: crypto.randomUUID(), revoked_at: null, revoked_by: null,
      revoke_reason: null, revoke_idem_key: null, superseded_by: null, superseded_at: null, ...patchObj })])
    return id
  }
  const cAsOf = await ownerCopy(A1, { as_of: `${P1.start}T00:00:00+07:00`, reference_exported_at: `${P1.start}T00:00:00+07:00`, run_exported_at: new Date().toISOString() })
  ok((await one(db, `SELECT public.cms__attest_eval($1, $2) e`, [P1.id, R1])).e.code === 'AS_OF', 'eval: dòng ghi thẳng có mốc M trước hết kỳ ⇒ AS_OF (không thành basis)')
  const t0 = await one(db, `SELECT as_of, reference_exported_at, run_exported_at FROM public.cms_source_attestations WHERE id = $1`, [A1])
  const cCnt = await ownerCopy(cAsOf, { as_of: t0.as_of, reference_exported_at: t0.reference_exported_at, run_exported_at: t0.run_exported_at, lines_compared: rows1.length + 1 })
  ok((await one(db, `SELECT public.cms__attest_eval($1, $2) e`, [P1.id, R1])).e.code === 'COUNT', 'eval: lines_compared ≠ số dòng lớp nguồn ⇒ COUNT')
  await db.query(`UPDATE public.cms_source_attestations SET revoked_at = now(), revoked_by = $2, revoke_reason = 'QA thử ghi thẳng (owner)', revoke_idem_key = gen_random_uuid() WHERE id = $1`, [cCnt, U.super])
  const again = await attempt(refBase)
  const ra2 = await attestRpc(again.built.payload)
  ok(ra2.ok && !ra2.v.superseded_id, 'chứng nhận lại decision10 qua RPC sau khi thu hồi bản thử', ra2.err)
  A1 = ra2.v?.id
}

section('5. Lõi action chốt 6 tham số + payout / XLSX trên JSON THẬT')
const lockDeps = () => ({
  lockEnabled: () => true, qaReadonly: () => false, access: async () => ({ kind: 'ok', actorId: U.super, qa: true }),
  program: async (id) => { const r = await one(db, `SELECT is_test FROM public.cms_programs WHERE id = $1`, [id]); return r ? { isTest: r.is_test } : null },
  rpc: async (fn, args) => {
    const named = Object.keys(args).map((k, i) => `${k} => $${i + 1}`).join(', ')
    try { return { data: (await H.svc(`SELECT public.${fn}(${named}) r`, Object.values(args))).rows[0].r, error: null } } catch (e) { return { data: null, error: { code: e.code, message: e.message } } }
  },
})
{
  const pv = await LA.runCmsLockPreview(lockDeps(), P1.id)
  const exp = pv.ok ? PV.cmsLockExpectedAttestation(pv.preview) : 'x'
  ok(pv.ok && pv.preview.sourceAttestation.state === 'valid' && pv.preview.sourceCompleteBasis === 'operator_reconciliation' && exp === A1,
    'preview: chứng nhận hợp lệ (DB tính lại), basis operator_reconciliation, id gửi kèm chốt = id preview', JSON.stringify(pv.ok ? pv.preview.sourceAttestation : pv))
  const noId = await LA.runCmsLock(lockDeps(), { programId: P1.id, expectedRunId: R1, expectedPolicyVersion: pv.preview.policyVersion, ackReason: 'Đã soát dòng chưa gán (QA giả)' })
  ok(!noId.ok && noId.code === 'CMS_LOCK_EVIDENCE_CHANGED', 'chốt KHÔNG gửi id chứng nhận khi preview chốt bằng chứng nhận ⇒ EVIDENCE_CHANGED', JSON.stringify(noId))
  const lk = await LA.runCmsLock(lockDeps(), { programId: P1.id, expectedRunId: R1, expectedPolicyVersion: pv.preview.policyVersion, ackReason: 'Đã soát dòng chưa gán (QA giả)', expectedAttestationId: exp })
  ok(lk.ok && lk.sourceAttestationId === A1, 'chốt 6 tham số với id preview ⇒ locked, phản hồi nói đúng chứng nhận đã dùng', JSON.stringify(lk))
  const again = await LA.runCmsLock(lockDeps(), { programId: P1.id, expectedRunId: R1, expectedPolicyVersion: pv.preview.policyVersion, ackReason: 'Đã soát dòng chưa gán (QA giả)', expectedAttestationId: exp })
  ok(again.ok && again.already, 'gọi lại cùng chứng nhận ⇒ already (idempotent)')
  const raw = (await H.asSuper(`SELECT public.rpc_cms_payout($1) r`, [P1.id])).rows[0].r
  const pay = PV.parseCmsPayout(raw)
  ok(pay.super?.sourceAttestationId === A1 && pay.super?.sourceAttestation?.fieldSet === 'decision10' && pay.super.sourceCompleteBasis === 'operator_reconciliation',
    'rpc_cms_payout (super): id + tóm tắt chứng nhận (decision10, mốc, nhãn, số dòng) — parser chặt')
  ok(!JSON.stringify(raw.source_attestation).includes('@') && !('attested_by' in raw.source_attestation), 'tóm tắt chứng nhận không có actor / email')
  const built = XP.buildCmsPayoutWorkbook({ program: { id: P1.id, name: 'QA 124', startDate: P1.start, endDate: P1.end, status: 'locked', isTest: true }, payout: pay, exportedAt: new Date(), scope: 'super' })
  const info = built.ok ? XLSX.utils.sheet_to_json(XLSX.read(built.bytes).Sheets['Thong tin'], { header: 1 }) : []
  const val = (k) => info.find((r) => r[0] === k)?.[1]
  ok(built.ok && val('Chứng nhận đối soát nguồn (id)') === A1 && val('Bộ trường đối soát') === 'decision10' && val('Nguồn tham chiếu') === 'Nguồn độc lập giả — QA'
    && String(val('Cơ sở nguồn đầy đủ')).startsWith('Đối soát nguồn độc lập'), 'XLSX super: sheet thông tin có metadata chứng nhận đúng')
  const ia = (await lastQ(T.CMS_VERIFY_SQL.invAttest))[0]
  ok(ia.n === 1 && ia.bad === 0, 'VERIFY V-124: payout chốt bằng chứng nhận trỏ đúng chứng nhận decision10 còn hiệu lực của đúng run')
}

section('6. Rollback 124')
{
  const rb = await settle(db.exec(RB_124))
  await db.exec('ROLLBACK').catch(() => {})
  ok(!rb.ok && /payout dùng chứng nhận/.test(rb.err), 'đã có payout operator_reconciliation ⇒ rollback dừng (xử lý tiến)', rb.err)
}
const db2 = await baseDb()
const H2 = helpers(db2)
{
  const md5s = async () => (await db2.query(`SELECT proname, md5(prosrc) m FROM pg_proc WHERE pronamespace = 'public'::regnamespace
    AND proname IN ('rpc_cms_sales_run_open','rpc_cms_sales_run_stage','rpc_cms_sales_run_cleanup','cms__lock_eval','rpc_cms_payout','rpc_cms_program_lock') ORDER BY 1`)).rows
  const m0 = await md5s()
  const origOpen = buildCms124().originals.run_open.replace('CREATE FUNCTION public.', 'CREATE OR REPLACE FUNCTION public.')
  await db2.exec(origOpen.replace('BEGIN\n', 'BEGIN\n  -- sửa tay giả lập lệch thân\n'))
  const pre = await settle(db2.exec(SQL_124))
  await db2.exec('ROLLBACK').catch(() => {})
  ok(!pre.ok && /124 preflight: thân hàm 122 \/ 123/.test(pre.err), '124 preflight: thân rpc_cms_sales_run_open lệch bản đã duyệt ⇒ dừng (db-reviewer r2 P2-6)', pre.err)
  await db2.exec(origOpen)
  await db2.exec(SQL_124)
  await db2.exec(`GRANT EXECUTE ON FUNCTION public.rpc_cms_payout(uuid) TO anon`)
  const rbAcl = await settle(db2.exec(RB_124))
  await db2.exec('ROLLBACK').catch(() => {})
  ok(!rbAcl.ok && /rollback 124 hậu kiểm: ACL/.test(rbAcl.err), 'rollback: ACL hàm khôi phục lệch (anon EXECUTE rpc_cms_payout) ⇒ hậu kiểm dừng, giữ nguyên 124 (db-reviewer r2 P1-1)', rbAcl.err)
  await db2.exec(`REVOKE EXECUTE ON FUNCTION public.rpc_cms_payout(uuid) FROM anon`)
  const rb = await settle(db2.exec(RB_124))
  const m2 = await md5s()
  const st = await one(db2, `SELECT to_regclass('public.cms_source_attestations') t, (SELECT count(*)::int FROM public.app_migrations WHERE version = '124') m,
    has_function_privilege('service_role', 'public.rpc_cms_program_lock(uuid, uuid, integer, uuid, text)', 'EXECUTE') s`)
  ok(rb.ok && JSON.stringify(m2) === JSON.stringify(m0) && st.t === null && st.m === 0 && st.s, 'DB khác: rollback đạt (hậu kiểm md5 6 hàm trong file), về 123, marker xoá', rb.err)
  const P = await H2.makeProgram()
  const s = syncDeps(db2, H2, rawRows(P, [{ n: 5 }]))
  const r = await SS.runCmsSalesSync(s.deps, P.id, { dryRun: false, source: 'qa', sourceCapture: true })
  ok(r.status === 'error' && r.code === 'SOURCE_SCHEMA_UNSUPPORTED' && s.calls.stage.length === 0, 'sau rollback: app bật capture ⇒ SOURCE_SCHEMA_UNSUPPORTED (không tự capture vào DB không hỗ trợ)')
  const re = await settle(db2.exec(SQL_124))
  ok(re.ok, 'áp lại 124 sau rollback đạt', re.err)
}

section('7. CLI scripts/cms-source-attest.mjs đầu-cuối qua shim HTTP (pg-meta + PostgREST giả trên PGlite)')
{
  // Chương trình THẬT (chế độ vận hành, --ledger-dir): mở cổng Q-206 CHỈ trong DB thử này để có run công bố.
  await db2.exec(`CREATE OR REPLACE FUNCTION public.cms__results_release_open() RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public AS $$ SELECT true $$`)
  const P = await H2.makeProgram({ isTest: false })
  const rws = rawRows(P, [{ n: 12 }, { n: 2, type: 'ONLINE' }])
  // Lõi app giữ cổng Q-206 (releaseGate) cho chương trình thật ⇒ công bố TRỰC TIẾP qua RPC 122 / 124 (engine + payload THẬT + lớp nguồn).
  const sync = await (async () => {
    const snap = RS.parseCmsSalesSnapshot((await H2.svc(`SELECT public.rpc_cms_sales_run_open($1, '{"source":"qa"}'::jsonb) r`, [P.id])).rows[0].r)
    const ls = linesOf(rws)
    const inp = RS.cmsSnapshotToEngineInput(snap)
    const outE = E.computeCmsProgram({ program: inp.program, lines: ls, sellers: inp.sellers })
    const pl = RS.buildCmsStagePayload(snap, ls, outE, { rowsRead: ls.length, rowsRejected: 0, bytesProcessed: null, chunkSize: 5000 })
    const stg = async (part, rowsP) => { const ch = RS.chunkCmsStageRows(rowsP, 5000); for (let i = 0; i < ch.length; i++) await H2.svc(`SELECT public.rpc_cms_sales_run_stage($1, $2, $3, $4::jsonb)`, [snap.runId, part, i, JSON.stringify(ch[i])]) }
    for (const part of RS.CMS_STAGE_PARTS) await stg(part, pl.parts[part])
    await stg(RS.CMS_SOURCE_PART, RS.buildCmsSourceStageRows(ls))
    await H2.svc(`SELECT public.rpc_cms_sales_run_seal_begin($1, $2::jsonb)`, [snap.runId, JSON.stringify(pl.expect)])
    for (let i = 1; i <= 10; i++) { const r = (await H2.svc(`SELECT public.rpc_cms_sales_run_seal_step($1, $2) r`, [snap.runId, i])).rows[0].r; if (r.sealed) break }
    const pub = (await H2.svc(`SELECT public.rpc_cms_sales_run_publish($1) r`, [snap.runId])).rows[0].r
    if (!pub.published) throw new Error('publish thật lỗi ' + JSON.stringify(pub))
    return { runId: snap.runId }
  })()
  let dropNext = false
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const ch of req) body += ch
    const send = (st, obj) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    try {
      if (req.url === '/pg/query') return send(200, lastRows(await db2.exec(JSON.parse(body).query)))
      const m = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(req.url ?? '')
      if (!m) return send(404, { message: 'not found' })
      const tok = String(req.headers.authorization ?? '').replace(/^Bearer /, '')
      const sub = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()).sub
      const args = JSON.parse(body)
      const named = Object.keys(args).map((k, i) => `${k} => $${i + 1}`).join(', ')
      const vals = Object.values(args).map((v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v))
      const out = (await as(db2, sub, () => db2.query(`SELECT public.${m[1]}(${named}) r`, vals))).rows[0].r
      if (dropNext) { dropNext = false; res.writeHead(502); return res.end() } // ĐÃ commit nhưng mất phản hồi
      return send(200, out)
    } catch (e) { return send(400, { code: e.code ?? '', message: String(e.message) }) }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cms124-cli-'))
  const ledger = path.join(tmp, 'ledger'); fs.mkdirSync(ledger)
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const token = `${b64({ alg: 'HS256' })}.${b64({ sub: U.super, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.x`
  const env = { ...process.env, NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${port}`, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-test', SUPABASE_SERVICE_ROLE_KEY: 'svc-test', CMS_SUPER_ACCESS_TOKEN: token }
  const cli = (args, extraEnv = {}) => new Promise((resolve) => execFile(process.execPath, [path.join(HERE, 'cms-source-attest.mjs'), ...args], { env: { ...env, ...extraEnv }, cwd: path.join(HERE, '..') },
    (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: `${stdout}${stderr}` })))
  const host = `127.0.0.1:${port}`
  const out = path.join(tmp, 'run.csv')
  const host0 = `127.0.0.1:${port}`
  const e0 = await cli(['export-run', `--program=${P.id}`, `--run=${sync.runId}`, `--out=${out}`, `--ledger-dir=${ledger}`])
  ok(e0.code === 2 && /--expect-host/.test(e0.out) && !fs.existsSync(out), 'export-run thiếu --expect-host ⇒ rc 2, không đọc dữ liệu (security review P1-1)')
  const e1 = await cli(['export-run', `--program=${P.id}`, `--run=${sync.runId}`, `--out=${out}`, `--ledger-dir=${ledger}`, `--expect-host=${host0}`])
  ok(e1.code === 0 && fs.existsSync(out) && !fs.existsSync(`${out}.partial`) && /"rows":14/.test(e1.out) && !e1.out.includes('@') && !e1.out.includes(token) && /XOÁ sau khi đối soát/.test(e1.out),
    'export-run: đủ trang ⇒ file hoàn chỉnh + app-side.json; stdout không email / token; nhắc xoá file có email', e1.out.slice(-300))
  const xs = fs.readdirSync(ledger).filter((x) => x.startsWith('x-'))
  const xr = xs.length === 1 ? JSON.parse(fs.readFileSync(path.join(ledger, xs[0]), 'utf8')) : null
  ok(xr?.status === 'done' && xr.rows === 14 && xr.actorId === U.super && /^[0-9a-f]{64}$/.test(xr.sha256) && !JSON.stringify(xr).includes('@'),
    'sổ xuất x-….json: uid phiên, chương trình, run, số dòng, sha256 — không email')
  const clash = path.join(tmp, 'clash.csv')
  fs.writeFileSync(clash, 'CŨ')
  const e2 = await cli(['export-run', `--program=${P.id}`, `--run=${sync.runId}`, `--out=${clash}`, `--ledger-dir=${ledger}`, `--expect-host=${host0}`])
  ok(e2.code === 2 && fs.readFileSync(clash, 'utf8') === 'CŨ', '--out đã tồn tại ⇒ rc 2, không ghi đè')
  fs.rmSync(clash)
  const appSide = JSON.parse(fs.readFileSync(`${out}.app-side.json`, 'utf8'))
  const ref = path.join(tmp, 'ref.csv')
  fs.writeFileSync(ref, fs.readFileSync(out))
  const refSha = crypto.createHash('sha256').update(fs.readFileSync(ref)).digest('hex')
  const at = (await one(db2, `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') t`)).t
  const meta = path.join(tmp, 'meta.json')
  fs.writeFileSync(meta, JSON.stringify({ version: 1, reference: { inputKind: 'reference_source', source: 'Nguồn độc lập giả — CLI', exportedAt: at, asOf: at,
    fileSha256: refSha, scope: appSide.scope }, app: { ...appSide, asOf: at, exportedAt: at > appSide.exportedAt ? at : appSide.exportedAt } }))
  const base = ['attest', `--program=${P.id}`, `--run=${sync.runId}`, `--reference=${ref}`, `--app=${out}`, `--evidence-meta=${meta}`,
    '--ack=Đã đối soát nguồn độc lập toàn kỳ (CLI thử)', `--ledger-dir=${ledger}`]
  const dry = await cli(base)
  ok(dry.code === 0 && /DRY-RUN đạt/.test(dry.out) && fs.readdirSync(ledger).filter((x) => x.startsWith('a-') || x.startsWith('.lock-')).length === 0, 'attest mặc định DRY-RUN: tính lại compare, không gọi DB ghi, không ghi sổ', dry.out.slice(-300))
  const noIdem = await cli([...base, '--write', `--expect-host=${host}`])
  ok(noIdem.code === 2 && /--idem/.test(noIdem.out), '--write thiếu --idem ⇒ rc 2 (công cụ không tự sinh khoá)')
  const wrongHost = await cli([...base, '--write', `--idem=${crypto.randomUUID()}`, '--expect-host=khac.example'])
  ok(wrongHost.code === 2 && /--expect-host/.test(wrongHost.out), '--expect-host sai ⇒ rc 2 trước mọi ghi')
  const idem = crypto.randomUUID()
  dropNext = true
  const lost = await cli([...base, '--write', `--idem=${idem}`, `--expect-host=${host}`])
  const ops = fs.readdirSync(ledger).filter((x) => x.startsWith('a-'))
  const op = ops.length === 1 ? JSON.parse(fs.readFileSync(path.join(ledger, ops[0]), 'utf8')) : null
  ok(lost.code === 1 && /KHÔNG RÕ/.test(lost.out) && op?.status === 'unknown' && op?.idemKey === idem, 'mất phản hồi sau commit ⇒ sổ unknown, rc 1 (không kết luận thất bại)', lost.out.slice(-300))
  const rec = await cli(['reconcile', `--op=${op?.operationId}`, `--ledger-dir=${ledger}`])
  const opR = op ? JSON.parse(fs.readFileSync(path.join(ledger, ops[0]), 'utf8')) : null
  ok(rec.code === 0 && opR?.status === 'reconciled' && opR?.reconcile?.found === true, 'reconcile đọc DB theo ĐÚNG khoá idem ⇒ đã ghi (reconciled found)', rec.out.slice(-300))
  const retry = await cli([...base, '--write', `--idem=${idem}`, `--expect-host=${host}`])
  const cnt = (await one(db2, `SELECT count(*)::int n FROM public.cms_source_attestations WHERE run_id = $1`, [sync.runId])).n
  ok(retry.code === 0 && /"already":true/.test(retry.out) && cnt === 1, 'gọi lại cùng --idem + cùng file ⇒ already, vẫn 1 chứng nhận (không nhân bản)', retry.out.slice(-200))
  const otherIdem = await cli(['revoke', `--program=${P.id}`, `--attestation=${opR?.reconcile?.attestationId}`, '--reason=Thu hồi để đối soát lại (CLI thử)', `--ledger-dir=${ledger}`, '--write', `--idem=${idem}`, `--expect-host=${host}`])
  ok(otherIdem.code === 2 && /thao tác KHÁC/.test(otherIdem.out), 'dùng lại --idem cho thao tác khác ⇒ rc 2')
  const rv = await cli(['revoke', `--program=${P.id}`, `--attestation=${opR?.reconcile?.attestationId}`, '--reason=Thu hồi để đối soát lại (CLI thử)', `--ledger-dir=${ledger}`, '--write', `--idem=${crypto.randomUUID()}`, `--expect-host=${host}`])
  ok(rv.code === 0 && /"status":"done"/.test(rv.out), 'revoke --write ⇒ done', rv.out.slice(-200))
  const stt = await cli(['status', `--ledger-dir=${ledger}`])
  ok(stt.code === 0 && /4 thao tác|3 thao tác/.test(stt.out) && /1 lần xuất/.test(stt.out), 'status liệt kê sổ thao tác + sổ xuất', stt.out.slice(0, 300))
  const qaProg = await H2.makeProgram()
  const qa = await cli(['export-run', `--program=${qaProg.id}`, `--run=${sync.runId}`, `--out=${path.join(tmp, 'x.csv')}`, `--ledger-dir=${ledger}`, `--expect-host=${host0}`])
  ok(qa.code === 2 && /chỉ thao tác BÊN TRONG run QA/.test(qa.out), 'chương trình QA ngoài run QA (--ledger-dir) ⇒ rc 2')
  const expired = await cli(['export-run', `--program=${P.id}`, `--run=${sync.runId}`, `--out=${path.join(tmp, 'y.csv')}`, `--ledger-dir=${ledger}`],
    { CMS_SUPER_ACCESS_TOKEN: `${b64({ alg: 'HS256' })}.${b64({ sub: U.super, role: 'authenticated', exp: 1 })}.x` })
  ok(expired.code === 2 && /hết hạn/.test(expired.out), 'token hết hạn ⇒ rc 2 mã cố định')
  {
    const polOrig = (await one(db2, `SELECT pg_get_functiondef('public.cms__lock_policy()'::regprocedure) d`)).d
    await db2.exec(`CREATE OR REPLACE FUNCTION public.cms__lock_policy() RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public AS $f$
      SELECT jsonb_build_object('version', 1, 'real', jsonb_build_object('ready', true, 'unassigned_max_gmv_bp', 200, 'unassigned_max_lines', 20, 'wait_hours', 0,
        'completeness', 'operator_reconciliation'), 'qa', jsonb_build_object('label', 'QA_ONLY_ASSUMPTION', 'unassigned_max_gmv_bp', 200, 'unassigned_max_lines', 20,
        'wait_hours', 0, 'completeness', 'qa_assumption')) $f$`)
    const pv = (await H2.svc(`SELECT public.rpc_cms_lock_preview($1) r`, [P.id])).rows[0].r
    await db2.exec(polOrig)
    ok(pv.source_complete_basis === null && pv.blockers.includes('CMS_LOCK_SOURCE_INCOMPLETE') && pv.source_attestation.code === 'NONE',
      'policy thật khai operator_reconciliation nhưng chứng nhận đã thu hồi ⇒ basis NULL (không báo nhầm) + SOURCE_INCOMPLETE (db-reviewer r2 P2-9)', JSON.stringify([pv.source_complete_basis, pv.blockers]))
  }
  server.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}

await db.close()
await db2.close()
console.log(`\n${pass} đạt · ${fail} lỗi`)
process.exitCode = fail ? 1 : 0
