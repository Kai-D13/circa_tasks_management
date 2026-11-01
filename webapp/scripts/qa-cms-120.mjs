// QA migration 120 r2 (CMS P1-a) trên PGlite (Postgres 16 WASM) với nền giống prod của lib-care-pglite.mjs
// (role anon / authenticated / service_role, auth.uid() theo request.jwt, default privileges như Supabase,
// users / stores / sm_store_assignments, is_super_admin() nguyên văn migration mới nhất). KHÔNG chạm DB thật.
//   npm i --no-save @electric-sql/pglite@0.2.17     # một lần, trong webapp/
//   node scripts/qa-cms-120.mjs                     # kỳ vọng: N đạt · 0 lỗi
// GIỚI HẠN: PGlite một session ⇒ không tái lập race; race + ACL với PG15 thật: planning/research/dev-tools/cms/120-realpg-test.mjs.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as L from './lib-care-pglite.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIG = path.join(HERE, '..', '..', 'supabase', 'migrations')
const SQL_120 = fs.readFileSync(path.join(MIG, '120_cms_foundation.sql'), 'utf8')
const RB_120 = fs.readFileSync(path.join(MIG, 'rollback', '120_cms_foundation_rollback.sql'), 'utf8')

let PGlite
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch {
  console.error('FAIL: thiếu @electric-sql/pglite — chạy: npm i --no-save @electric-sql/pglite@0.2.17 (trong webapp/)')
  process.exit(2)
}

let pass = 0, fail = 0
const ok = (c, name, extra = '') => { if (c) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name} ${extra}`) } }
const section = (s) => console.log(`\n${s}`)
const { U, uid, storeId, S_FS, S_INACTIVE, one, count, as } = L
// File migration / rollback có BEGIN…COMMIT: RAISE giữa chừng để transaction aborted ⇒ ROLLBACK sau mọi lần thất bại.
async function raises(db, p, needle) {
  try { await p } catch (e) {
    await db.exec('ROLLBACK').catch(() => {})
    return needle ? String(e?.message ?? e).includes(needle) : true
  }
  return false
}

const READ_FNS = ['cms_has_qa_access()', 'cms_readable_program_ids()']
const RPC_FNS = ['rpc_cms_sync_run_open(text, jsonb)', 'rpc_cms_product_master_upsert(uuid, jsonb)', 'rpc_cms_sync_run_close(uuid, text, jsonb)']
const TRG_FNS = ['cms__qa_access_stamp()', 'cms__programs_guard()']
const TABLES = ['cms_product_master', 'cms_programs', 'cms_program_stores', 'cms_program_products', 'cms_program_tiers',
  'cms_import_runs', 'cms_sync_runs', 'cms_qa_access']

async function baseDb() {
  const db = await L.freshDb(PGlite)
  await db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('117','t'),('118','t'),('118a','t'),('119','t'),('119a','t') ON CONFLICT DO NOTHING`)
  return db
}

// Chương trình mẫu (ghi bằng superuser như RPC 121 sẽ làm; bảng CMS không cho authenticated ghi).
const P = { active: uid(5001), draft: uid(5002), test: uid(5003), locked: uid(5004), s3: uid(5005), fs: uid(5006) }
const PP = { a1: uid(5101), d1: uid(5102), t1: uid(5103) }
const PROG_OF = { [PP.a1]: P.active, [PP.d1]: P.draft, [PP.t1]: P.test }
async function seed(db) {
  const prog = async (id, status, stores, { isTest = false } = {}) => {
    await db.query(
      `INSERT INTO public.cms_programs (id, name, status, start_date, end_date, scope, is_test, created_by, activated_at, locked_at)
       VALUES ($1, $2, $3, '2026-11-01', '2026-11-30', 'stores', $4, $5,
               CASE WHEN $3 = 'draft' THEN NULL ELSE now() END, CASE WHEN $3 = 'locked' THEN now() ELSE NULL END)`,
      [id, `QA ${id.slice(-4)}`, status, isTest, U.super])
    for (const s of stores) await db.query(`INSERT INTO public.cms_program_stores (program_id, store_id) VALUES ($1, $2)`, [id, s])
  }
  await prog(P.active, 'active', [storeId(1), storeId(2)])
  await prog(P.draft, 'draft', [storeId(1)])
  await prog(P.test, 'active', [storeId(1)], { isTest: true })
  await prog(P.locked, 'locked', [storeId(1)])
  await prog(P.s3, 'active', [storeId(3)])
  await prog(P.fs, 'active', [S_FS, S_INACTIVE])
  for (const [pp, pid] of [[PP.a1, '900001'], [PP.d1, '900002'], [PP.t1, '900003']]) {
    await db.query(
      `INSERT INTO public.cms_program_products (id, program_id, product_id, gmv_basis, target_gmv, unit_cms, base_quantity_cms, advice_text, name_snapshot)
       VALUES ($1, $2, $3, 'product', 10000000, 'hộp', 24, 'Tư vấn mẫu', 'SP giả')`, [pp, PROG_OF[pp], pid])
    await db.query(`INSERT INTO public.cms_program_tiers (program_product_id, program_id, tier_order, qty_from, qty_to, amount_per_unit)
                    VALUES ($1, $2, 1, 1, 9, 15000), ($1, $2, 2, 10, NULL, 20000)`, [pp, PROG_OF[pp]])
  }
  await db.query(`INSERT INTO public.cms_product_master (product_id, product_name, is_active, source_updated_at) VALUES ('900001', 'SP giả', true, now())`)
  await db.query(`INSERT INTO public.cms_import_runs (program_id, mode, file_name, file_sha256, file_bytes, config_version_at_preview, created_by)
                  VALUES ($1, 'replace', 'qa.xlsx', repeat('a', 64), 100, 1, $2), ($3, 'replace', 'qa.xlsx', repeat('b', 64), 100, 1, $2)`, [P.active, U.super, P.test])
  // SM2 thêm phân công nhà thuốc NGỪNG hoạt động — không được mở chương trình chỉ có nhà thuốc ngừng / FS.
  await db.query(`INSERT INTO public.sm_store_assignments (sm_user_id, store_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [U.sm2, S_INACTIVE])
}
const visible = async (db, who) => as(db, who, async () =>
  (await db.query(`SELECT id FROM public.cms_programs ORDER BY id`)).rows.map((r) => r.id))
const grantQa = (db, user, hours = 2) => db.query(
  `INSERT INTO public.cms_qa_access (user_id, granted_by, expires_at) VALUES ($1, 'qa-script', now() + make_interval(hours => $2))
   ON CONFLICT (user_id) DO UPDATE SET expires_at = EXCLUDED.expires_at`, [user, hours])

section('1. Preflight')
{
  const db = await L.freshDb(PGlite)
  ok(await raises(db, db.exec(SQL_120), 'thiếu migration nền 119'), 'thiếu 119 ⇒ dừng')
  await db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('117','t'),('118','t'),('118a','t'),('119','t'),('119a','t'),('121','t')`)
  ok(await raises(db, db.exec(SQL_120), 'migration số > 120'), 'đã có 121 ⇒ dừng (marker chữ 118a/119a không làm hỏng so sánh số)')
}
{
  const db = await baseDb()
  await db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('120', 'kpi_rls_set_helpers')`)
  ok(await raises(db, db.exec(SQL_120), 'name = kpi_rls_set_helpers'), 'marker 120 của migration khác (P-K1 cũ) ⇒ dừng, không nuốt marker')
}
const db = await baseDb()
await db.exec(SQL_120)
ok((await one(db, `SELECT name FROM public.app_migrations WHERE version = '120'`))?.name === 'cms_foundation', 'marker 120 = cms_foundation')
ok(await raises(db, db.exec(SQL_120), 'đã có marker 120'), 'chạy lại ⇒ dừng (không chạy chồng)')
ok(await count(db, `SELECT count(*) FROM pg_class WHERE relname LIKE 'cms\\_%' AND relkind = 'r' AND relrowsecurity`) === 8, '8 bảng cms_* bật RLS')
ok(await count(db, `SELECT count(*) FROM pg_policies WHERE tablename LIKE 'cms\\_%'`) === 6, 'đúng 6 policy')

section('2. Ma trận ACL')
const fnAcl = async (f) => one(db, `SELECT has_function_privilege('anon', 'public.${f}', 'EXECUTE') a, has_function_privilege('authenticated', 'public.${f}', 'EXECUTE') u,
  has_function_privilege('service_role', 'public.${f}', 'EXECUTE') s, has_function_privilege('dashboard_qa', 'public.${f}', 'EXECUTE') d`)
for (const f of READ_FNS) { const r = await fnAcl(f); ok(!r.a && r.u && !r.s && !r.d, `${f}: chỉ authenticated`, JSON.stringify(r)) }
for (const f of RPC_FNS) { const r = await fnAcl(f); ok(!r.a && !r.u && r.s && !r.d, `${f}: chỉ service_role`, JSON.stringify(r)) }
for (const f of TRG_FNS) { const r = await fnAcl(f); ok(!r.a && !r.u && !r.s && !r.d, `${f} (trigger): không ai`, JSON.stringify(r)) }
for (const t of TABLES) {
  const r = await one(db, `SELECT has_table_privilege('anon', 'public.${t}', 'SELECT') a, has_table_privilege('authenticated', 'public.${t}', 'SELECT') us,
    has_table_privilege('authenticated', 'public.${t}', 'INSERT') ui, has_table_privilege('authenticated', 'public.${t}', 'UPDATE') uu,
    has_table_privilege('authenticated', 'public.${t}', 'DELETE') ud, has_table_privilege('service_role', 'public.${t}', 'INSERT') si`)
  const wantSel = !['cms_sync_runs', 'cms_qa_access'].includes(t)
  ok(!r.a && r.us === wantSel && !r.ui && !r.uu && !r.ud && r.si, `${t}: anon 0; authenticated ${wantSel ? 'chỉ SELECT' : 'không'}; service_role ghi`, JSON.stringify(r))
}

section('3. Đọc theo vai (H5 / H6 / H9b) — mảng InitPlan')
await seed(db)
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
ok(same(await visible(db, U.super), [P.active, P.draft, P.locked, P.s3, P.fs]), 'super: mọi chương trình thật, KHÔNG thấy test khi chưa có marker')
await grantQa(db, U.super)
ok((await visible(db, U.super)).includes(P.test), 'super + marker QA còn hạn: thấy test')
ok(same(await visible(db, U.sm), [P.active]), 'SM (store 1, 2, FS): chỉ active có nhà thuốc OS đang hoạt động được phân công; không FS / nháp / locked / test')
ok(same(await visible(db, U.sm2), [P.active]), 'SM2 (store 1 + nhà thuốc ngừng): không mở chương trình chỉ có nhà thuốc ngừng')
ok(same(await visible(db, U.A), [P.active, P.locked]), 'staff store 1: active + locked phạm vi; không nháp / store 3 / test')
ok(same(await visible(db, U.qlch1), [P.active, P.locked]), 'QLCH store 1: như staff')
ok(same(await visible(db, U.C), [P.active]), 'staff store 2: chỉ active có store 2')
ok((await visible(db, U.staffFs)).length === 0, 'staff FS: 0 (kể cả chương trình chứa nhà thuốc FS)')
ok((await visible(db, U.staffInactive)).length === 0, 'staff nhà thuốc ngừng: 0')
ok((await visible(db, U.mkt)).length === 0, 'admin thường: 0')
await grantQa(db, U.A)
ok(same(await visible(db, U.A), [P.active, P.locked, P.test]), 'staff + marker QA: thấy thêm test đúng phạm vi')
await db.query(`UPDATE public.cms_qa_access SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [U.A]).catch(() => {})
// granted_at bị trigger ép = now() ⇒ expires_at ≤ now() vi phạm CHECK ⇒ không thể "hết hạn" bằng UPDATE; xoá marker thay thế.
await db.query(`DELETE FROM public.cms_qa_access WHERE user_id = $1`, [U.A])
ok(!(await visible(db, U.A)).includes(P.test), 'không còn marker: không thấy test')
ok(await as(db, U.A, () => count(db, `SELECT count(*) FROM public.cms_program_products`)) === 1, 'staff: chỉ sản phẩm của chương trình đọc được')
ok(await as(db, U.A, () => count(db, `SELECT count(*) FROM public.cms_program_tiers`)) === 2, 'staff: bậc theo program_id (không gọi helper theo dòng)')
ok(await as(db, U.A, () => count(db, `SELECT count(*) FROM public.cms_program_stores`)) === 3, 'staff: nhà thuốc của chương trình đọc được')
ok(await as(db, U.A, () => count(db, `SELECT count(*) FROM public.cms_product_master`)) === 0, 'staff: Product Master 0 dòng')
ok(await as(db, U.super, () => count(db, `SELECT count(*) FROM public.cms_product_master`)) === 1, 'super: đọc Product Master')
ok(await as(db, U.A, () => count(db, `SELECT count(*) FROM public.cms_import_runs`)) === 0, 'staff: import run 0 dòng')
ok(await as(db, U.sm, () => count(db, `SELECT count(*) FROM public.cms_import_runs`)) === 0, 'SM: import run 0 dòng')
await db.query(`DELETE FROM public.cms_qa_access WHERE user_id = $1`, [U.super])
ok(await as(db, U.super, () => count(db, `SELECT count(*) FROM public.cms_import_runs`)) === 1, 'super không marker: chỉ import run của chương trình thật')
ok(await as(db, U.A, async () => (await one(db, `SELECT cardinality(public.cms_readable_program_ids()) n`)).n) === 2, 'helper mảng gọi trực tiếp đúng số chương trình')
const plan = await as(db, U.A, async () => (await db.query(`EXPLAIN SELECT * FROM public.cms_program_tiers`)).rows.map((r) => Object.values(r)[0]).join('\n'))
ok(/InitPlan/.test(plan), 'policy bậc dùng InitPlan (helper chạy một lần)', plan.slice(0, 300))
ok(await raises(db, as(db, U.A, () => db.query(`SELECT * FROM public.cms_sync_runs`)), 'permission denied'), 'authenticated: cms_sync_runs bị từ chối')
ok(await raises(db, as(db, U.super, () => db.query(`SELECT * FROM public.cms_qa_access`)), 'permission denied'), 'authenticated (kể cả super): cms_qa_access bị từ chối')
ok(await raises(db, as(db, null, () => db.query(`SELECT * FROM public.cms_programs`), 'anon'), 'permission denied'), 'anon: cms_programs bị từ chối')
ok(await raises(db, as(db, U.super, () => db.query(`UPDATE public.cms_programs SET name = 'x' WHERE true`)), 'permission denied'), 'authenticated (super) không UPDATE trực tiếp')
ok(await raises(db, as(db, U.super, () => db.query(`INSERT INTO public.cms_qa_access (user_id, granted_by, expires_at) VALUES ($1, 'self', now() + interval '1 hour')`, [U.super])), 'permission denied'), 'user không tự cấp marker QA')

section('4. Bất biến DB (trigger / CHECK / index)')
await db.query(`INSERT INTO public.cms_qa_access (user_id, granted_by, granted_at, expires_at) VALUES ($1, 'qa', now() + interval '30 days', now() + interval '2 hours')`, [U.B])
ok((await one(db, `SELECT granted_at <= now() + interval '1 second' AS ok FROM public.cms_qa_access WHERE user_id = $1`, [U.B])).ok, 'marker: granted_at bị ép = now() (không đẩy mốc tương lai để kéo dài hạn)')
ok(await raises(db, db.query(`INSERT INTO public.cms_qa_access (user_id, granted_by, expires_at) VALUES ($1, 'qa', now() + interval '8 days')`, [U.C]), 'check constraint'), 'marker > 7 ngày theo giờ DB ⇒ chặn')
ok(await raises(db, db.query(`INSERT INTO public.cms_qa_access (user_id, granted_by, expires_at) VALUES ($1, 'a@b.vn', now() + interval '1 hour')`, [U.C]), 'check constraint'), 'granted_by chứa email ⇒ chặn')
ok(await raises(db, db.query(`UPDATE public.cms_programs SET is_test = true WHERE id = $1`, [P.active]), 'CMS_PROGRAM_IS_TEST_IMMUTABLE'), 'đổi is_test thật → test ⇒ chặn (H9)')
ok(await raises(db, db.query(`UPDATE public.cms_programs SET is_test = false WHERE id = $1`, [P.test]), 'CMS_PROGRAM_IS_TEST_IMMUTABLE'), 'đổi is_test test → thật ⇒ chặn (H9)')
await db.query(`INSERT INTO public.cms_sync_runs (kind) VALUES ('products')`)
ok(await raises(db, db.query(`INSERT INTO public.cms_sync_runs (kind) VALUES ('products')`), 'duplicate key'), 'INSERT trực tiếp phiên running thứ hai ⇒ unique index chặn')
await db.query(`DELETE FROM public.cms_sync_runs WHERE status = 'running'`)
ok(await raises(db, db.query(`INSERT INTO public.cms_sync_runs (kind, status, finished_at, error_code) VALUES ('products', 'ok', now(), 'X')`), 'check constraint'), 'phiên ok mang mã lỗi ⇒ chặn')
ok(await raises(db, db.query(`INSERT INTO public.cms_sync_runs (kind, status, finished_at) VALUES ('products', 'held', now())`), 'check constraint'), 'phiên held không mã ⇒ chặn')
ok(await raises(db, db.query(`INSERT INTO public.cms_product_master (product_id, product_name, is_active, source_updated_at, reference_price) VALUES ('920001', 'x', true, now(), 'NaN')`), 'check constraint'), 'giá NaN ⇒ chặn')
ok(await raises(db, db.query(`INSERT INTO public.cms_product_master (product_id, product_name, is_active, source_updated_at) VALUES ('920002', 'x', true, 'infinity')`), 'check constraint'), 'source_updated_at infinity ⇒ chặn')
ok(await raises(db, db.query(`INSERT INTO public.cms_product_master (product_id, product_name, is_active, source_updated_at) VALUES ('920003', '   ', true, now())`), 'check constraint'), 'tên chỉ khoảng trắng ⇒ chặn')
ok(await raises(db, db.query(`INSERT INTO public.cms_program_tiers (program_product_id, program_id, tier_order, qty_from, amount_per_unit) VALUES ($1, $2, 9, 1, 1)`, [PP.a1, P.draft]), 'foreign key'), 'bậc trỏ program_id khác chương trình của sản phẩm ⇒ FK kép chặn')

section('5. RPC Product Master (service_role)')
ok(await raises(db, as(db, U.super, () => db.query(`SELECT public.rpc_cms_sync_run_open('products', '{}')`)), 'permission denied'), 'authenticated (super) không gọi được rpc_cms_sync_run_open')
const svc = (sql, params = []) => as(db, null, () => db.query(sql, params), 'service_role')
const runId = (await svc(`SELECT public.rpc_cms_sync_run_open('products', '{"source":"qa"}') AS id`)).rows[0].id
ok(!!runId, 'service_role mở phiên')
ok(await raises(db, svc(`SELECT public.rpc_cms_sync_run_open('products', '{}')`), 'CMS_SYNC_BUSY'), 'phiên thứ hai khi đang chạy ⇒ BUSY')
const rows = (n, off = 0) => JSON.stringify(Array.from({ length: n }, (_, i) => ({
  product_id: String(910000 + off + i), product_name: `SP QA ${i}`, image_url: null, is_active: i % 2 === 0,
  source_updated_at: '2026-11-01T01:00:00.000001Z', reference_price: i === 0 ? '9.5' : null, price_unit: null })))
const row1 = (o) => JSON.stringify([{ product_id: '920100', product_name: 'x', is_active: true, source_updated_at: '2026-11-01T00:00:00Z', ...o }])
ok((await svc(`SELECT public.rpc_cms_product_master_upsert($1, $2::jsonb) n`, [runId, rows(3)])).rows[0].n === 3, 'upsert 3 dòng')
ok((await svc(`SELECT public.rpc_cms_product_master_upsert($1, $2::jsonb) n`, [runId, rows(2)])).rows[0].n === 2, 'upsert lại (ON CONFLICT cập nhật)')
ok(await raises(db, svc(`SELECT public.rpc_cms_product_master_upsert($1, $2::jsonb)`, [runId, JSON.stringify([...JSON.parse(rows(1)), ...JSON.parse(rows(1))])]), 'CMS_SYNC_DUPLICATE_PRODUCT'), 'trùng product_id trong khối ⇒ lỗi')
ok(await raises(db, svc(`SELECT public.rpc_cms_product_master_upsert($1, '[]'::jsonb)`, [runId]), 'CMS_SYNC_BAD_CHUNK'), 'khối rỗng ⇒ lỗi')
ok(await raises(db, svc(`SELECT public.rpc_cms_product_master_upsert($1, $2::jsonb)`, [runId, rows(5001)]), 'CMS_SYNC_BAD_CHUNK'), 'khối > 5.000 ⇒ lỗi')
ok(await raises(db, svc(`SELECT public.rpc_cms_product_master_upsert($1, $2::jsonb)`, [runId, row1({ product_id: '0123' })]), 'check constraint'), 'ProductID không canonical ⇒ CHECK chặn')
for (const [o, name] of [
  [{ is_active: 'yes' }, "is_active chuỗi 'yes'"], [{ is_active: 1 }, 'is_active số'], [{ is_active: undefined }, 'thiếu is_active'],
  [{ source_updated_at: '2026-11-01 00:00:00' }, 'timestamp thiếu múi giờ'], [{ source_updated_at: 'now' }, "timestamp 'now'"],
  [{ source_updated_at: 'infinity' }, "timestamp 'infinity'"], [{ product_id: null }, 'product_id null'], [{ product_id: 920101 }, 'product_id kiểu số'],
  [{ reference_price: 'NaN' }, "giá 'NaN'"], [{ reference_price: 9.5 }, 'giá kiểu số'], [{ reference_price: '1e3' }, 'giá số mũ'],
  [{ image_url: 12 }, 'image_url kiểu số'], [{ price_unit: { a: 1 } }, 'price_unit kiểu object'],
]) ok(await raises(db, svc(`SELECT public.rpc_cms_product_master_upsert($1, $2::jsonb)`, [runId, row1(o)]), 'CMS_SYNC_BAD_ROW'), `${name} ⇒ CMS_SYNC_BAD_ROW`)
ok(await raises(db, svc(`SELECT public.rpc_cms_sync_run_close($1, NULL, '{}')`, [runId]), 'CMS_SYNC_BAD_STATUS'), 'đóng với status NULL ⇒ BAD_STATUS')
ok(await raises(db, svc(`SELECT public.rpc_cms_sync_run_close($1, 'held', '{}')`, [runId]), 'CMS_SYNC_BAD_CODE'), 'held không mã ⇒ BAD_CODE')
ok(await raises(db, svc(`SELECT public.rpc_cms_sync_run_close($1, 'ok', '{"error_code":"X"}')`, [runId]), 'CMS_SYNC_BAD_CODE'), 'ok kèm mã ⇒ BAD_CODE')
await svc(`SELECT public.rpc_cms_sync_run_close($1, 'ok', '{"rows_read":5,"rows_rejected":0,"bytes_processed":1024}')`, [runId])
const run = await one(db, `SELECT status, rows_written, rows_read, bytes_processed, finished_at IS NOT NULL AS fin, error_code FROM public.cms_sync_runs WHERE id = $1`, [runId])
ok(run.status === 'ok' && run.rows_written === 5 && run.rows_read === 5 && Number(run.bytes_processed) === 1024 && run.fin && run.error_code === null, 'đóng phiên ok + số liệu', JSON.stringify(run))
ok(await raises(db, svc(`SELECT public.rpc_cms_product_master_upsert($1, $2::jsonb)`, [runId, rows(1)]), 'CMS_SYNC_RUN_NOT_RUNNING'), 'upsert sau khi đóng ⇒ từ chối')
const stale = (await svc(`SELECT public.rpc_cms_sync_run_open('products', '{}') AS id`)).rows[0].id
await db.query(`UPDATE public.cms_sync_runs SET started_at = now() - interval '31 minutes' WHERE id = $1`, [stale])
const fresh = (await svc(`SELECT public.rpc_cms_sync_run_open('products', '{}') AS id`)).rows[0].id
ok(!!fresh && (await one(db, `SELECT status, error_code FROM public.cms_sync_runs WHERE id = $1`, [stale])).error_code === 'STALE', 'phiên treo > 30′ ⇒ đóng STALE, mở phiên mới')
await svc(`SELECT public.rpc_cms_sync_run_close($1, 'held', '{"error_code":"ROW_ISSUES","rows_read":3,"rows_rejected":1}')`, [fresh])
ok((await one(db, `SELECT status, error_code FROM public.cms_sync_runs WHERE id = $1`, [fresh])).error_code === 'ROW_ISSUES', 'đóng held kèm mã')
ok(await count(db, `SELECT count(*) FROM public.cms_product_master WHERE product_id LIKE '91%'`) === 3, 'Product Master giữ 3 SP (không xoá dòng cũ)')

section('6. CHECK dữ liệu chương trình')
const bad = async (sql, params, needle, name) => ok(await raises(db, db.query(sql, params), needle), name)
await bad(`INSERT INTO public.cms_program_products (program_id, product_id, gmv_basis, unit_cms, base_quantity_cms, advice_text, name_snapshot) VALUES ($1, '900009', 'none', 'hộp', 1.0000000001, 'x', 'x')`, [P.draft], 'check constraint', 'base_quantity_cms > 9 chữ số thập phân ⇒ chặn')
await bad(`INSERT INTO public.cms_program_products (program_id, product_id, gmv_basis, unit_cms, base_quantity_cms, advice_text, name_snapshot) VALUES ($1, '900010', 'product', 'hộp', 1, 'x', 'x')`, [P.draft], 'check constraint', 'gate product thiếu target ⇒ chặn')
await bad(`INSERT INTO public.cms_program_products (program_id, product_id, gmv_basis, target_gmv, unit_cms, base_quantity_cms, advice_text, name_snapshot) VALUES ($1, '900011', 'none', 5, 'hộp', 1, 'x', 'x')`, [P.draft], 'check constraint', 'gate none có target ⇒ chặn')
await bad(`INSERT INTO public.cms_program_products (program_id, product_id, gmv_basis, unit_cms, base_quantity_cms, advice_text, name_snapshot) VALUES ($1, '900012', 'none', 'hộp', 1, repeat('x', 4001), 'x')`, [P.draft], 'check constraint', 'tư vấn > 4.000 ký tự ⇒ chặn')
await bad(`INSERT INTO public.cms_program_products (program_id, product_id, gmv_basis, unit_cms, base_quantity_cms, advice_text, name_snapshot) VALUES ($1, '900013', 'none', 'hộp', 1, '   ', 'x')`, [P.draft], 'check constraint', 'tư vấn chỉ khoảng trắng ⇒ chặn')
await bad(`INSERT INTO public.cms_programs (name, start_date, end_date, scope, created_by) VALUES ('x', '2026-11-30', '2026-11-01', 'all', $1)`, [U.super], 'check constraint', 'ngày kết thúc < ngày bắt đầu ⇒ chặn')
await bad(`INSERT INTO public.cms_programs (name, start_date, end_date, scope, created_by, calc_mode) VALUES ('x', '2026-11-01', '2026-11-02', 'all', $1, 'flat')`, [U.super], 'check constraint', "calc_mode 'flat' ⇒ chặn")

section('7. Rollback')
ok(await raises(db, db.exec(RB_120), 'chương trình CMS thật'), 'rollback khi còn chương trình thật ⇒ dừng')
{
  const db2 = await baseDb()
  await db2.exec(SQL_120)
  await db2.query(`UPDATE public.app_migrations SET name = 'khac' WHERE version = '120'`)
  ok(await raises(db2, db2.exec(RB_120), 'không phải của CMS'), 'rollback khi marker 120 không phải CMS ⇒ dừng')
  await db2.query(`UPDATE public.app_migrations SET name = 'cms_foundation' WHERE version = '120'`)
  await db2.query(`INSERT INTO public.cms_programs (name, start_date, end_date, scope, is_test, created_by) VALUES ('QA test', '2026-11-01', '2026-11-02', 'all', true, $1)`, [U.super])
  await db2.exec(RB_120)
  ok(await count(db2, `SELECT count(*) FROM pg_class WHERE relname LIKE 'cms\\_%'`) === 0, 'rollback: hết bảng / index cms_*')
  ok(await count(db2, `SELECT count(*) FROM pg_proc WHERE proname LIKE 'cms\\_%' OR proname LIKE 'rpc\\_cms\\_%'`) === 0, 'rollback: hết hàm cms (gồm trigger)')
  ok(await count(db2, `SELECT count(*) FROM public.app_migrations WHERE version = '120'`) === 0, 'rollback: xoá marker 120')
  await db2.exec(SQL_120)
  ok(await count(db2, `SELECT count(*) FROM public.app_migrations WHERE version = '120'`) === 1, 'chạy lại 120 sau rollback')
}

console.log(`\n${pass} đạt · ${fail} lỗi`)
process.exit(fail ? 1 : 0)
