// QA migration 121 (CMS P1-b) trên PGlite (Postgres 16 WASM), nền 114–116 của lib-care-pglite.mjs + 120 + 121.
// RPC lưu chương trình / preview / commit import / kích hoạt: trạng thái × hành động (SPEC §4.7), replace / append,
// commit lặp idempotent, lệch preview ⇒ CONFLICT, kiểm payload trong SQL, trùng ProductID theo namespace is_test, H7,
// ACL, rollback. KHÔNG chạm DB thật.
//   npm i --no-save @electric-sql/pglite@0.2.17     # một lần, trong webapp/
//   node scripts/qa-cms-121.mjs                     # kỳ vọng: N đạt · 0 lỗi
// GIỚI HẠN: PGlite một session ⇒ không tái lập race; race 2 kết nối với PG15 thật:
// planning/research/dev-tools/cms/121-realpg-race.mjs.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import * as L from './lib-care-pglite.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIG = path.join(HERE, '..', '..', 'supabase', 'migrations')
const SQL_120 = fs.readFileSync(path.join(MIG, '120_cms_foundation.sql'), 'utf8')
const SQL_121 = fs.readFileSync(path.join(MIG, '121_cms_import_activation.sql'), 'utf8')
const RB_121 = fs.readFileSync(path.join(MIG, 'rollback', '121_cms_import_activation_rollback.sql'), 'utf8')

let PGlite
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch {
  console.error('FAIL: thiếu @electric-sql/pglite — chạy: npm i --no-save @electric-sql/pglite@0.2.17 (trong webapp/)')
  process.exit(2)
}

let pass = 0, fail = 0
const ok = (c, name, extra = '') => { if (c) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name} ${extra}`) } }
const section = (s) => console.log(`\n${s}`)
const { U, uid, storeId, S_FS, S_INACTIVE, one, count, as } = L
let lastErr = ''
async function raises(db, p, needle) {
  try { await p } catch (e) {
    lastErr = String(e?.message ?? e)
    await db.exec('ROLLBACK').catch(() => {})
    return needle ? lastErr.includes(needle) : true
  }
  lastErr = 'KHÔNG raise'
  return false
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')

const HELPERS = ['cms__vn_today()', 'cms__lock_catalog()', 'cms__conflicts(uuid, boolean, date, date, text[])']
const RPCS = ['rpc_cms_program_save(jsonb)', 'rpc_cms_import_preview_save(jsonb)',
  'rpc_cms_import_commit(uuid, text, text, jsonb, uuid)', 'rpc_cms_program_activate(uuid, uuid)']

async function baseDb({ with121 = true } = {}) {
  const db = await L.freshDb(PGlite)
  await db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('117','t'),('118','t'),('118a','t'),('119','t'),('119a','t') ON CONFLICT DO NOTHING`)
  await db.exec(SQL_120)
  if (with121) await db.exec(SQL_121)
  await db.query(`INSERT INTO public.cms_product_master (product_id, product_name, is_active, source_updated_at)
    SELECT (b + g)::text, 'SP giả ' || (b + g), true, now() FROM unnest(ARRAY[900000, 910000, 920000, 930000, 940000, 950000]) b, generate_series(1, 99) g`)
  return db
}

section('1. Preflight')
{
  const db = await L.freshDb(PGlite)
  await db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('117','t'),('118','t'),('118a','t'),('119','t'),('119a','t')`)
  ok(await raises(db, db.exec(SQL_121), 'thiếu migration nền 120'), 'chưa có 120 ⇒ dừng')
  await db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('120', 'kpi_rls_set_helpers')`)
  ok(await raises(db, db.exec(SQL_121), 'name = kpi_rls_set_helpers'), 'marker 120 không phải CMS ⇒ dừng')
}
{
  const db = await baseDb({ with121: false })
  await db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('122', 't')`)
  ok(await raises(db, db.exec(SQL_121), 'migration số > 121'), 'đã có 122 ⇒ dừng')
}
const db = await baseDb()
ok((await one(db, `SELECT name FROM public.app_migrations WHERE version = '121'`))?.name === 'cms_import_activation', 'marker 121 = cms_import_activation')
ok(await raises(db, db.exec(SQL_121), 'đã có marker 121'), 'chạy lại ⇒ dừng')

section('2. Ma trận ACL')
const fnAcl = async (f) => one(db, `SELECT has_function_privilege('anon', 'public.${f}', 'EXECUTE') a, has_function_privilege('authenticated', 'public.${f}', 'EXECUTE') u,
  has_function_privilege('service_role', 'public.${f}', 'EXECUTE') s, has_function_privilege('dashboard_qa', 'public.${f}', 'EXECUTE') d,
  (SELECT prosecdef FROM pg_proc WHERE oid = 'public.${f}'::regprocedure) sd`)
for (const f of RPCS) { const r = await fnAcl(f); ok(!r.a && !r.u && r.s && !r.d && r.sd, `${f}: chỉ service_role, SECDEF`, JSON.stringify(r)) }
for (const f of HELPERS) { const r = await fnAcl(f); ok(!r.a && !r.u && !r.s && !r.d && r.sd, `${f}: không cấp ai`, JSON.stringify(r)) }
ok(await raises(db, as(db, U.super, () => db.query(`SELECT public.rpc_cms_program_save('{}'::jsonb)`)), 'permission denied'), 'authenticated (super) gọi RPC trực tiếp ⇒ từ chối')
ok(await raises(db, as(db, U.A, () => db.query(`SELECT public.rpc_cms_program_activate($1, $2)`, [uid(1), U.A])), 'permission denied'), 'staff gọi kích hoạt ⇒ từ chối')
ok(await raises(db, as(db, null, () => db.query(`SELECT public.rpc_cms_import_commit($1, 'x', 'x', '{}'::jsonb, $1)`, [uid(1)]), 'anon'), 'permission denied'), 'anon gọi commit ⇒ từ chối')

// ── Helper gọi RPC bằng service_role ──
const svc = (sql, params = []) => as(db, null, () => db.query(sql, params), 'service_role')
const TODAY = (await one(db, `SELECT public.cms__vn_today()::text d`)).d
const day = (n) => { const d = new Date(`${TODAY}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const save = async (o) => (await svc(`SELECT public.rpc_cms_program_save($1::jsonb) id`, [JSON.stringify({ actor: U.super, ...o })])).rows[0].id
const newProg = (o = {}) => save({ name: 'QA CMS', start_date: day(10), end_date: day(40), scope: 'all', is_test: false, ...o })
const prog = (id) => one(db, `SELECT * FROM public.cms_programs WHERE id = $1`, [id])
const T2 = [{ order: 1, from: 1, to: 9, amount: '15000' }, { order: 2, from: 10, to: null, amount: '20000' }]
const prod = (pid, o = {}) => ({ product_id: pid, gmv_basis: 'none', target_gmv: null, unit_cms: 'hộp', base_quantity_cms: '24',
  advice_text: 'Tư vấn QA', name_snapshot: 'SP giả', image_url_snapshot: null, price_snapshot: null, tiers: T2, ...o })
const STATS = { rowsTotal: 2, rowsOk: 2, rowsRejected: 0, warnings: 0, productsOk: 1, productsRejected: 0 }
let fileSeq = 0
async function preview(programId, mode, extra = {}) {
  const fileSha = sha(`file-${++fileSeq}`), digest = sha(`digest-${fileSeq}`)
  const id = (await svc(`SELECT public.rpc_cms_import_preview_save($1::jsonb) id`, [JSON.stringify({ program_id: programId, mode,
    file_name: 'qa.xlsx', file_sha256: fileSha, file_bytes: 1000, actor: U.super, stats: STATS, result: { digest }, ...extra })])).rows[0].id
  return { id, fileSha, digest }
}
const commit = async (run, payload, o = {}) => (await svc(`SELECT public.rpc_cms_import_commit($1, $2, $3, $4::jsonb, $5) r`,
  [run.id, o.sha ?? run.fileSha, o.digest ?? run.digest, JSON.stringify(payload), U.super])).rows[0].r
const activate = async (id) => (await svc(`SELECT public.rpc_cms_program_activate($1, $2) r`, [id, U.super])).rows[0].r
const importAll = async (id, mode, products, catalogTarget = null) => commit(await preview(id, mode), { mode, products, catalog_target: catalogTarget })
const prodIds = async (id) => (await db.query(`SELECT product_id FROM public.cms_program_products WHERE program_id = $1 ORDER BY product_id`, [id])).rows.map((r) => r.product_id)
// Ép trạng thái "đã bắt đầu" cho chương trình active: lùi ngày bằng superuser (RPC không cho sửa ngày khi đã bắt đầu).
const backdate = (id, startOffset, endOffset = 20) => db.query(`UPDATE public.cms_programs SET start_date = $2, end_date = $3 WHERE id = $1`, [id, day(startOffset), day(endOffset)])

section('3. rpc_cms_program_save — tạo / sửa (SPEC §4.7)')
const pAll = await newProg()
ok(!!pAll && (await prog(pAll)).status === 'draft' && (await prog(pAll)).is_test === false && (await prog(pAll)).config_version === 1, 'tạo nháp scope all: draft, is_test false, config_version 1')
ok(await count(db, `SELECT count(*) FROM public.cms_program_stores WHERE program_id = '${pAll}'`) === 0, 'nháp scope all: chưa ghi danh sách nhà thuốc (ghi khi kích hoạt)')
const pStores = await newProg({ scope: 'stores', store_ids: [storeId(1), storeId(2), storeId(2)] })
ok(await count(db, `SELECT count(*) FROM public.cms_program_stores WHERE program_id = '${pStores}'`) === 2, 'scope stores: ghi 2 nhà thuốc (bỏ trùng)')
for (const [o, code, name] of [
  [{ scope: 'stores', store_ids: [S_FS] }, 'CMS_PROGRAM_STORE_INVALID', 'nhà thuốc FS'],
  [{ scope: 'stores', store_ids: [S_INACTIVE] }, 'CMS_PROGRAM_STORE_INVALID', 'nhà thuốc ngừng'],
  [{ scope: 'stores', store_ids: [uid(999)] }, 'CMS_PROGRAM_STORE_INVALID', 'nhà thuốc không tồn tại'],
  [{ scope: 'stores', store_ids: [] }, 'CMS_PROGRAM_STORE_INVALID', 'scope stores rỗng'],
  [{ scope: 'stores', store_ids: ['abc'] }, 'CMS_PROGRAM_BAD_INPUT', 'store_ids không phải uuid'],
  [{ scope: 'stores', store_ids: [1] }, 'CMS_PROGRAM_BAD_INPUT', 'store_ids kiểu số'],
  [{ start_date: day(5), end_date: day(4) }, 'CMS_PROGRAM_BAD_INPUT', 'kết thúc < bắt đầu'],
  [{ start_date: '2026-02-30' }, 'CMS_PROGRAM_BAD_INPUT', 'ngày không tồn tại 2026-02-30'],
  [{ start_date: '01/11/2026' }, 'CMS_PROGRAM_BAD_INPUT', 'ngày sai định dạng'],
  [{ name: '   ' }, 'CMS_PROGRAM_BAD_INPUT', 'tên chỉ khoảng trắng'],
  [{ name: 'x'.repeat(201) }, 'CMS_PROGRAM_BAD_INPUT', 'tên > 200 ký tự'],
  [{ scope: 'region' }, 'CMS_PROGRAM_BAD_INPUT', "scope 'region'"],
  [{ actor: 'admin' }, 'CMS_PROGRAM_BAD_INPUT', 'actor không phải uuid'],
  [{ is_test: undefined }, 'CMS_PROGRAM_BAD_INPUT', 'tạo thiếu is_test (server phải quyết)'],
  [{ is_test: 'true' }, 'CMS_PROGRAM_BAD_INPUT', 'is_test kiểu chuỗi'],
  [{ id: 'xyz' }, 'CMS_PROGRAM_BAD_INPUT', 'id không phải uuid'],
  [{ id: uid(4242) }, 'CMS_PROGRAM_NOT_FOUND', 'sửa id không tồn tại'],
]) ok(await raises(db, newProg(o), code), `${name} ⇒ ${code}`, lastErr)
await save({ id: pAll, name: 'QA CMS sửa', start_date: day(11), end_date: day(41), scope: 'stores', store_ids: [storeId(3)], is_test: true })
{
  const p = await prog(pAll)
  ok(p.name === 'QA CMS sửa' && p.scope === 'stores' && p.config_version === 2 && p.is_test === false, 'sửa nháp: tên / ngày / phạm vi, config_version + 1, is_test KHÔNG đổi theo input', JSON.stringify({ n: p.name, v: p.config_version, t: p.is_test }))
  ok(await count(db, `SELECT count(*) FROM public.cms_program_stores WHERE program_id = '${pAll}'`) === 1, 'sửa nháp scope stores: thay danh sách nhà thuốc')
}
await save({ id: pAll, name: 'QA CMS sửa', start_date: day(11), end_date: day(41), scope: 'all' })
ok(await count(db, `SELECT count(*) FROM public.cms_program_stores WHERE program_id = '${pAll}'`) === 0, 'nháp đổi về scope all: xoá danh sách (ghi khi kích hoạt)')
const pTest = await newProg({ is_test: true })
ok((await prog(pTest)).is_test === true, 'tạo chương trình QA: is_test do server truyền')

section('4. Import preview / commit — replace (nháp)')
ok(await raises(db, preview(pAll, 'append'), 'CMS_IMPORT_CONFLICT'), 'preview nháp với mode append ⇒ CONFLICT (mode do trạng thái quyết)')
ok(await raises(db, preview(pAll, 'replace', { result: {} }), 'CMS_IMPORT_BAD_INPUT'), 'preview thiếu digest ⇒ BAD_INPUT')
ok(await raises(db, preview(pAll, 'replace', { stats: { ...STATS, rowsOk: 'x' } }), 'CMS_IMPORT_BAD_INPUT'), 'preview stats không phải số ⇒ BAD_INPUT')
ok(await raises(db, preview(pAll, 'replace', { file_sha256: 'abc' }), 'CMS_IMPORT_BAD_INPUT'), 'preview hash sai dạng ⇒ BAD_INPUT')
ok(await raises(db, preview(uid(4343), 'replace'), 'CMS_PROGRAM_NOT_FOUND'), 'preview chương trình không tồn tại ⇒ NOT_FOUND')
ok(await raises(db, preview(pAll, 'replace', { file_bytes: 5242881 }), 'CMS_IMPORT_BAD_INPUT'), 'preview file > 5 MiB ⇒ BAD_INPUT (không lọt CHECK thô)')
ok(await raises(db, preview(pAll, 'replace', { file_name: '' }), 'CMS_IMPORT_BAD_INPUT'), 'preview tên file rỗng ⇒ BAD_INPUT')
const run1 = await preview(pAll, 'replace')
ok((await one(db, `SELECT status, mode, config_version_at_preview v FROM public.cms_import_runs WHERE id = $1`, [run1.id])).status === 'previewed', 'preview ghi run previewed')
const P1 = [prod('900001', { gmv_basis: 'product', target_gmv: '10000000' }), prod('900002', { gmv_basis: 'catalog' }), prod('900003', { price_snapshot: '12000.5', image_url_snapshot: 'https://cdn-gcs.thuocsi.vn/thuocsi-live/images/x.png' })]
const payload1 = { mode: 'replace', products: P1, catalog_target: '50000000' }
ok(await raises(db, commit(run1, payload1, { sha: sha('khác') }), 'CMS_IMPORT_CONFLICT'), 'commit hash file khác preview ⇒ CONFLICT')
ok(await raises(db, commit(run1, payload1, { digest: sha('khác') }), 'CMS_IMPORT_CONFLICT'), 'commit digest khác preview ⇒ CONFLICT')
// Payload sai — mỗi ca đều phải bị chặn trước khi ghi (run vẫn previewed, dùng lại được).
const badCases = [
  [{ ...payload1, mode: 'append' }, 'CMS_IMPORT_BAD_PAYLOAD', 'payload mode khác run'],
  [{ ...payload1, products: [] }, 'CMS_IMPORT_BAD_PAYLOAD', '0 sản phẩm'],
  [{ ...payload1, products: [P1[0], P1[0]] }, 'CMS_IMPORT_BAD_PAYLOAD', 'trùng ProductID trong payload'],
  [{ ...payload1, products: [prod('0123')] }, 'CMS_IMPORT_BAD_PAYLOAD', 'ProductID không canonical'],
  [{ ...payload1, products: [prod(900004)] }, 'CMS_IMPORT_BAD_PAYLOAD', 'ProductID kiểu số'],
  [{ ...payload1, products: [prod('900004', { gmv_basis: 'product' })] }, 'CMS_IMPORT_BAD_PAYLOAD', 'gate product thiếu target'],
  [{ ...payload1, products: [prod('900004', { target_gmv: '5' })] }, 'CMS_IMPORT_BAD_PAYLOAD', 'gate none có target'],
  [{ ...payload1, products: [prod('900004', { gmv_basis: undefined })] }, 'CMS_IMPORT_BAD_PAYLOAD', 'thiếu gmv_basis'],
  [{ ...payload1, products: [prod('900004', { gmv_basis: 'store' })] }, 'CMS_IMPORT_BAD_PAYLOAD', "gmv_basis 'store'"],
  [{ ...payload1, catalog_target: null }, 'CMS_IMPORT_BAD_PAYLOAD', 'có SP danh mục nhưng thiếu target danh mục'],
  [{ ...payload1, catalog_target: '0' }, 'CMS_IMPORT_BAD_PAYLOAD', 'target danh mục 0'],
  [{ ...payload1, catalog_target: 5 }, 'CMS_IMPORT_BAD_PAYLOAD', 'target danh mục kiểu số'],
  [{ ...payload1, products: [prod('900004', { base_quantity_cms: '1.0000000001' })] }, 'CMS_IMPORT_BAD_PAYLOAD', 'quy cách > 9 chữ số thập phân'],
  [{ ...payload1, products: [prod('900004', { base_quantity_cms: 24 })] }, 'CMS_IMPORT_BAD_PAYLOAD', 'quy cách kiểu số'],
  [{ ...payload1, products: [prod('900004', { price_snapshot: '1e3' })] }, 'CMS_IMPORT_BAD_PAYLOAD', 'giá số mũ'],
  [{ ...payload1, products: [prod('900004', { unit_cms: null })] }, 'CMS_IMPORT_BAD_PAYLOAD', 'unit_CMS null'],
  [{ ...payload1, products: [prod('900004', { tiers: {} })] }, 'CMS_IMPORT_BAD_PAYLOAD', 'tiers kiểu object'],
  [{ ...payload1, products: [prod('900004', { tiers: [] })] }, 'CMS_IMPORT_BAD_PAYLOAD', 'tiers rỗng'],
  [{ ...payload1, products: [prod('900004', { tiers: [{ order: 1, from: 2, to: null, amount: '1' }] })] }, 'CMS_IMPORT_BAD_TIERS', 'bậc không bắt đầu từ 1'],
  [{ ...payload1, products: [prod('900004', { tiers: [{ order: 1, from: 1, to: 9, amount: '1' }, { order: 2, from: 11, to: null, amount: '1' }] })] }, 'CMS_IMPORT_BAD_TIERS', 'bậc hở (gap)'],
  [{ ...payload1, products: [prod('900004', { tiers: [{ order: 1, from: 1, to: 9, amount: '1' }, { order: 2, from: 9, to: null, amount: '1' }] })] }, 'CMS_IMPORT_BAD_TIERS', 'bậc chồng'],
  [{ ...payload1, products: [prod('900004', { tiers: [{ order: 1, from: 1, to: null, amount: '1' }, { order: 2, from: 10, to: 20, amount: '1' }] })] }, 'CMS_IMPORT_BAD_TIERS', 'bậc mở không ở cuối'],
  [{ ...payload1, products: [prod('900004', { tiers: [{ order: 1, from: 5, to: 4, amount: '1' }] })] }, 'CMS_IMPORT_BAD_TIERS', 'đến < từ'],
  [{ ...payload1, products: [prod('900004', { tiers: [{ order: 1, from: 1, to: null, amount: '0' }] })] }, 'CMS_IMPORT_BAD_TIERS', 'CMS 0đ'],
  [{ ...payload1, products: [prod('900004', { tiers: [{ order: 1, from: 1, to: null, amount: 15000 }] })] }, 'CMS_IMPORT_BAD_TIERS', 'CMS kiểu số'],
  [{ ...payload1, products: [prod('900004', { tiers: [{ order: 2, from: 1, to: null, amount: '1' }] })] }, 'CMS_IMPORT_BAD_TIERS', 'order sai vị trí'],
  [{ ...payload1, products: [prod('900004', { tiers: [{ order: 1, from: 1, to: 2147483648, amount: '1' }, { order: 2, from: 2147483649, to: null, amount: '1' }] })] }, 'CMS_IMPORT_BAD_TIERS', 'đến > int max'],
  [{ ...payload1, products: [prod('900004', { tiers: [{ order: 1, from: 1.5, to: null, amount: '1' }] })] }, 'CMS_IMPORT_BAD_TIERS', 'từ số lẻ'],
  [{ ...payload1, products: [prod('900004', { advice_text: 'x'.repeat(4001) })] }, 'CMS_IMPORT_BAD_PAYLOAD', 'tư vấn > 4.000 ký tự'],
  [{ ...payload1, products: [prod('900004', { advice_text: ' \n\t ' })] }, 'CMS_IMPORT_BAD_PAYLOAD', 'tư vấn chỉ khoảng trắng'],
  [{ ...payload1, products: [prod('900004', { base_quantity_cms: '0' })] }, 'CMS_IMPORT_BAD_PAYLOAD', 'quy cách 0'],
  [{ ...payload1, products: [prod('900004', { base_quantity_cms: '0.000000000' })] }, 'CMS_IMPORT_BAD_PAYLOAD', 'quy cách 0.000000000'],
  [{ ...payload1, products: [prod('900004', { unit_cms: '   ' })] }, 'CMS_IMPORT_BAD_PAYLOAD', 'unit_CMS chỉ khoảng trắng'],
  [{ ...payload1, products: [prod('900004', { unit_cms: 'x'.repeat(51) })] }, 'CMS_IMPORT_BAD_PAYLOAD', 'unit_CMS > 50 ký tự'],
  [{ ...payload1, products: [prod('900004', { name_snapshot: '' })] }, 'CMS_IMPORT_BAD_PAYLOAD', 'tên snapshot rỗng'],
  [{ ...payload1, products: [prod('900004', { image_url_snapshot: 'http://x.example/a.png' })] }, 'CMS_IMPORT_BAD_PAYLOAD', 'ảnh không https'],
  [{ ...payload1, products: [prod('900004', { tiers: Array.from({ length: 1001 }, (_, i) => ({ order: i + 1, from: i + 1, to: i === 1000 ? null : i + 1, amount: '1' })) }),
    prod('900005', { tiers: Array.from({ length: 1000 }, (_, i) => ({ order: i + 1, from: i + 1, to: i === 999 ? null : i + 1, amount: '1' })) })] }, 'CMS_IMPORT_BAD_TIERS', 'tổng bậc > 2.000 / lần'],
  [{ ...payload1, products: [prod('990001')] }, 'CMS_IMPORT_PRODUCT_UNKNOWN', 'ProductID không có trên Product Master'],
  [{ ...payload1, products: [prod('900004', { tiers: [{ order: 1, from: 1, to: null, amount: '9223372036854775808' }] })] }, 'CMS_IMPORT_BAD_TIERS', 'CMS = bigint max + 1'],
  [{ ...payload1, products: [prod('900004', { gmv_basis: 'product', target_gmv: '9223372036854775808' })] }, 'CMS_IMPORT_BAD_PAYLOAD', 'target SP = bigint max + 1'],
  [{ ...payload1, catalog_target: '9223372036854775808' }, 'CMS_IMPORT_BAD_PAYLOAD', 'target danh mục = bigint max + 1'],
  [{ ...payload1, products: [prod('900004', { base_quantity_cms: '1' + '0'.repeat(29) })] }, 'CMS_IMPORT_BAD_PAYLOAD', 'quy cách 30 chữ số nguyên'],
]
const vBefore = (await prog(pAll)).config_version
for (const [pl, code, name] of badCases) ok(await raises(db, commit(run1, pl), code), `${name} ⇒ ${code}`, lastErr)
ok(await count(db, `SELECT count(*) FROM public.cms_program_products WHERE program_id = '${pAll}'`) === 0 && (await prog(pAll)).config_version === vBefore, 'sau mọi ca lỗi: 0 sản phẩm, config_version không đổi')
const r1 = await commit(run1, payload1)
ok(r1.already === false && r1.mode === 'replace' && r1.products === 3, 'commit replace: 3 sản phẩm', JSON.stringify(r1))
{
  const p = await prog(pAll)
  ok(p.config_version === vBefore + 1 && String(p.catalog_target_gmv) === '50000000', 'commit: config_version + 1; đặt target danh mục', JSON.stringify({ v: p.config_version, c: p.catalog_target_gmv }))
  ok(await count(db, `SELECT count(*) FROM public.cms_program_tiers WHERE program_id = '${pAll}'`) === 6, 'commit: 6 bậc')
  const r = await one(db, `SELECT status, committed_by, committed_at IS NOT NULL c FROM public.cms_import_runs WHERE id = $1`, [run1.id])
  ok(r.status === 'committed' && r.committed_by === U.super && r.c, 'run ⇒ committed + người / thời điểm')
  const au = await one(db, `SELECT jsonb_array_length(result->'committed'->'products') n, result->>'digest' d FROM public.cms_import_runs WHERE id = $1`, [run1.id])
  ok(au.n === 3 && au.d === run1.digest, 'audit: payload đã ghi lưu trong run (result.committed), giữ digest')
  const pp = await one(db, `SELECT base_quantity_cms::text q, price_snapshot::text pr, added_after_start a, import_run_id r FROM public.cms_program_products WHERE program_id = $1 AND product_id = '900003'`, [pAll])
  ok(pp.q === '24' && pp.pr === '12000.5' && pp.a === false && pp.r === run1.id, 'giá trị ghi đúng (quy cách / giá / run / không hồi tố)', JSON.stringify(pp))
}
const again = await commit(run1, payload1)
ok(again.already === true && (await prog(pAll)).config_version === vBefore + 1 && (await count(db, `SELECT count(*) FROM public.cms_program_products WHERE program_id = '${pAll}'`)) === 3, 'commit lặp cùng run ⇒ already, không ghi thêm')
ok(await raises(db, commit(run1, payload1, { sha: sha('khác') }), 'CMS_IMPORT_CONFLICT'), 'commit lặp với hash khác ⇒ CONFLICT (không trả already)')
// Hai preview song song: commit run A ⇒ run B lỗi thời (config_version đổi).
const runA = await preview(pAll, 'replace'), runB = await preview(pAll, 'replace')
await commit(runA, { mode: 'replace', products: [prod('900010'), prod('900011')], catalog_target: null })
ok(JSON.stringify(await prodIds(pAll)) === JSON.stringify(['900010', '900011']) && (await prog(pAll)).catalog_target_gmv === null, 'nạp lại (replace): thay TOÀN BỘ sản phẩm; không còn SP danh mục ⇒ xoá target')
ok(await raises(db, commit(runB, { mode: 'replace', products: [prod('900012')] }), 'CMS_IMPORT_CONFLICT'), 'preview cũ sau khi đã commit preview khác ⇒ CONFLICT')
const runC = await preview(pAll, 'replace')
await save({ id: pAll, name: 'QA CMS sửa lần 2', start_date: day(11), end_date: day(41), scope: 'all' })
ok(await raises(db, commit(runC, { mode: 'replace', products: [prod('900012')] }), 'CMS_IMPORT_CONFLICT'), 'sửa thông tin sau preview ⇒ commit CONFLICT')

section('5. Trùng ProductID — chương trình active / locked giao ngày, cùng namespace is_test')
const pX = await newProg({ name: 'QA X', start_date: day(10), end_date: day(40) })
await importAll(pX, 'replace', [prod('910001'), prod('910002')])
const aX = await activate(pX)
ok((await prog(pX)).status === 'active' && aX.started === false, 'X kích hoạt (chưa bắt đầu)', JSON.stringify(aX))
const pY = await newProg({ name: 'QA Y', start_date: day(30), end_date: day(60) })
ok(await raises(db, importAll(pY, 'replace', [prod('910001')]), 'CMS_IMPORT_PRODUCT_CONFLICT'), 'nháp Y giao ngày với X active, cùng ProductID ⇒ PRODUCT_CONFLICT')
ok(await count(db, `SELECT count(*) FROM public.cms_program_products WHERE program_id = '${pY}'`) === 0, 'conflict ⇒ không ghi gì')
const pZ = await newProg({ name: 'QA Z', start_date: day(41), end_date: day(60) })
ok((await importAll(pZ, 'replace', [prod('910001')])).products === 1, 'Z không giao ngày (bắt đầu sau ngày kết thúc X) ⇒ được nạp')
const pYt = await newProg({ name: 'QA Y test', start_date: day(30), end_date: day(60), is_test: true })
ok((await importAll(pYt, 'replace', [prod('910001')])).products === 1, 'chương trình QA (is_test) cùng ProductID, giao ngày ⇒ khác namespace, được nạp')
const pD = await newProg({ name: 'QA D', start_date: day(10), end_date: day(40) })
const pD2 = await newProg({ name: 'QA D2', start_date: day(20), end_date: day(50) })
ok((await importAll(pD, 'replace', [prod('910005')])).products === 1 && (await importAll(pD2, 'replace', [prod('910005')])).products === 1, 'hai NHÁP cùng ProductID giao ngày ⇒ nạp đều được (nháp không chặn)')
await activate(pD2)
ok(await raises(db, activate(pD), 'CMS_ACTIVATE_CONFLICT'), 'D2 đã kích hoạt ⇒ kích hoạt D (trùng 910005, giao ngày) ⇒ ACTIVATE_CONFLICT')
ok((await prog(pD)).status === 'draft', 'kích hoạt lỗi ⇒ vẫn nháp')
// Locked cũng chặn.
const pL = await newProg({ name: 'QA L', start_date: day(-40), end_date: day(-20) })
await importAll(pL, 'replace', [prod('910003')])
await activate(pL)
await db.query(`UPDATE public.cms_programs SET status = 'locked', locked_at = now() WHERE id = $1`, [pL])
const pM = await newProg({ name: 'QA M', start_date: day(-30), end_date: day(-25) })
ok(await raises(db, importAll(pM, 'replace', [prod('910003')]), 'CMS_IMPORT_PRODUCT_CONFLICT'), 'giao ngày với chương trình ĐÃ CHỐT ⇒ PRODUCT_CONFLICT')
// Sửa ngày chương trình active chưa bắt đầu ⇒ kiểm trùng lại.
const pW = await newProg({ name: 'QA W', start_date: day(45), end_date: day(60) })
await importAll(pW, 'replace', [prod('910002')])
await activate(pW)
ok(await raises(db, save({ id: pW, name: 'QA W', start_date: day(35), end_date: day(60), scope: 'all' }), 'CMS_PROGRAM_CONFLICT'), 'sửa ngày W (active chưa bắt đầu) giao với X ⇒ PROGRAM_CONFLICT')
ok(await raises(db, save({ id: pW, name: 'QA W', start_date: day(0), end_date: day(60), scope: 'all' }), 'CMS_PROGRAM_START_PAST'), 'Q-214 (chốt): dời ngày bắt đầu chương trình active về hôm nay ⇒ START_PAST')
ok(await raises(db, save({ id: pW, name: 'QA W', start_date: day(-3), end_date: day(60), scope: 'all' }), 'CMS_PROGRAM_START_PAST'), 'Q-214 (chốt): dời về quá khứ ⇒ START_PAST')
ok(await raises(db, newProg({ start_date: '1900-01-01' }), 'CMS_PROGRAM_BAD_INPUT'), 'ngày trước 2020 ⇒ BAD_INPUT (gõ nhầm năm)')
ok(await raises(db, newProg({ end_date: '9999-12-31' }), 'CMS_PROGRAM_BAD_INPUT'), 'ngày sau 2100 ⇒ BAD_INPUT')
ok(await raises(db, newProg({ name: '\t\n \r' }), 'CMS_PROGRAM_BAD_INPUT'), 'tên chỉ tab / xuống dòng ⇒ BAD_INPUT')
await save({ id: pW, name: 'QA W đổi tên', start_date: day(46), end_date: day(61), scope: 'all' })
{
  const p = await prog(pW)
  ok(p.name === 'QA W đổi tên' && p.status === 'active', 'sửa W không giao ⇒ được; vẫn active')
  ok(await count(db, `SELECT count(*) FROM public.cms_program_stores WHERE program_id = '${pW}'`) === 25, 'active scope all sửa ⇒ ghi lại danh sách 25 nhà thuốc OS active')
}

section('6. Kích hoạt (SPEC §4.7 điều kiện 1–5, H7)')
const pE = await newProg({ name: 'QA rỗng' })
ok(await raises(db, activate(pE), 'CMS_PROGRAM_EMPTY'), 'nháp 0 sản phẩm ⇒ EMPTY')
ok(await raises(db, activate(pX), 'CMS_PROGRAM_NOT_DRAFT'), 'kích hoạt lại chương trình active ⇒ NOT_DRAFT')
ok(await raises(db, activate(pL), 'CMS_PROGRAM_NOT_DRAFT'), 'kích hoạt chương trình đã chốt ⇒ NOT_DRAFT')
ok(await raises(db, activate(uid(4444)), 'CMS_PROGRAM_NOT_FOUND'), 'id không tồn tại ⇒ NOT_FOUND')
{
  const pC = await newProg({ name: 'QA danh mục thiếu target' })
  await importAll(pC, 'replace', [prod('920001')])
  await db.query(`UPDATE public.cms_program_products SET gmv_basis = 'catalog' WHERE program_id = $1`, [pC])
  ok(await raises(db, activate(pC), 'CMS_PROGRAM_CATALOG_TARGET_MISSING'), 'có SP danh mục mà thiếu target danh mục ⇒ CATALOG_TARGET_MISSING')
}
{
  const pS = await newProg({ name: 'QA stores', scope: 'stores', store_ids: [storeId(4), storeId(5)] })
  await importAll(pS, 'replace', [prod('920002')])
  await db.query(`UPDATE public.stores SET is_active = false WHERE id = $1`, [storeId(5)])
  ok(await raises(db, activate(pS), 'CMS_PROGRAM_STORE_INVALID'), 'scope stores có nhà thuốc đã ngừng ⇒ STORE_INVALID (sửa phạm vi trước)')
  await db.query(`UPDATE public.stores SET is_active = true WHERE id = $1`, [storeId(5)])
  const r = await activate(pS)
  ok(r.stores === 2 && (await prog(pS)).status === 'active', 'scope stores hợp lệ ⇒ active, 2 nhà thuốc', JSON.stringify(r))
}
{
  const before = (await prog(pZ)).config_version
  const r = await activate(pZ)
  const p = await prog(pZ)
  ok(p.status === 'active' && p.activated_by === U.super && p.activated_at && p.config_version === before + 1, 'kích hoạt: active, activated_by / at, config_version + 1')
  ok(r.stores === 25 && await count(db, `SELECT count(*) FROM public.cms_program_stores ps JOIN public.stores s ON s.id = ps.store_id WHERE ps.program_id = '${pZ}' AND s.store_type = 'os' AND s.is_active`) === 25, 'scope all ⇒ ghi đúng 25 nhà thuốc OS đang hoạt động (không FS / ngừng)')
}
{
  const pR = await newProg({ name: 'QA hồi tố', start_date: day(-5), end_date: day(20) })
  await importAll(pR, 'replace', [prod('920003')])
  const r = await activate(pR)
  ok(r.started === true && r.ended === false && (await prog(pR)).status === 'active', 'H7: ngày bắt đầu đã qua vẫn kích hoạt (started = true)', JSON.stringify(r))
  const pR2 = await newProg({ name: 'QA đã kết thúc', start_date: day(-30), end_date: day(-1) })
  await importAll(pR2, 'replace', [prod('920004')])
  ok((await activate(pR2)).ended === true, 'ngày kết thúc đã qua ⇒ kích hoạt được, ended = true (UI: Chờ chốt kỳ)')
}
{
  const pYt2 = await newProg({ name: 'QA Y test 2', start_date: day(30), end_date: day(60), is_test: true })
  await importAll(pYt2, 'replace', [prod('910001')])
  ok((await activate(pYt)).program_id === pYt, 'chương trình QA (is_test) kích hoạt được dù trùng ProductID với X thật (khác namespace)')
  ok(await raises(db, activate(pYt2), 'CMS_ACTIVATE_CONFLICT'), 'hai chương trình QA cùng ProductID giao ngày ⇒ ACTIVATE_CONFLICT (cùng namespace test)')
  const pYt3 = await newProg({ name: 'QA Y test 3', start_date: day(30), end_date: day(60), is_test: true })
  ok(await raises(db, importAll(pYt3, 'replace', [prod('910001')]), 'CMS_IMPORT_PRODUCT_CONFLICT'), 'nạp vào chương trình QA trùng chương trình QA active ⇒ PRODUCT_CONFLICT')
}

section('7. Đã bắt đầu ⇒ append (thêm SP, hồi tố); đã chốt ⇒ không sửa')
{
  // X active: lùi ngày để thành "đã bắt đầu" (không giao chương trình nào khác ngoài các ca dưới).
  await backdate(pX, -3, 20)
  ok(await raises(db, preview(pX, 'replace'), 'CMS_IMPORT_CONFLICT'), 'đã bắt đầu: preview replace ⇒ CONFLICT (chỉ append)')
  ok(await raises(db, save({ id: pX, name: 'x', start_date: day(-3), end_date: day(20), scope: 'all' }), 'CMS_PROGRAM_NOT_EDITABLE'), 'đã bắt đầu: sửa thông tin ⇒ NOT_EDITABLE')
  ok(await raises(db, importAll(pX, 'append', [prod('910001')]), 'CMS_IMPORT_PRODUCT_EXISTS'), 'append SP đã có ⇒ PRODUCT_EXISTS')
  const r = await importAll(pX, 'append', [prod('930001', { gmv_basis: 'catalog' })], '70000000')
  ok(r.mode === 'append' && r.products === 1, 'append SP mới', JSON.stringify(r))
  const pp = await one(db, `SELECT added_after_start a FROM public.cms_program_products WHERE program_id = $1 AND product_id = '930001'`, [pX])
  ok(pp.a === true && String((await prog(pX)).catalog_target_gmv) === '70000000', 'append: added_after_start = true; nhóm danh mục đầu tiên đặt target')
  ok(JSON.stringify(await prodIds(pX)) === JSON.stringify(['910001', '910002', '930001']), 'append: giữ nguyên SP cũ')
  ok(await raises(db, importAll(pX, 'append', [prod('930002', { gmv_basis: 'catalog' })], '80000000'), 'CMS_IMPORT_CATALOG_TARGET_CHANGED'), 'append target danh mục khác hiện hữu ⇒ CATALOG_TARGET_CHANGED')
  ok((await importAll(pX, 'append', [prod('930003', { gmv_basis: 'catalog' })], '70000000')).products === 1, 'append cùng target danh mục ⇒ được')
  ok(await raises(db, importAll(pX, 'append', [prod('920003')]), 'CMS_IMPORT_PRODUCT_CONFLICT'), 'append SP đang thuộc chương trình active khác giao ngày ⇒ PRODUCT_CONFLICT')
  ok(await raises(db, preview(pL, 'append'), 'CMS_PROGRAM_NOT_EDITABLE'), 'đã chốt: preview ⇒ NOT_EDITABLE')
  ok(await raises(db, save({ id: pL, name: 'x', start_date: day(-40), end_date: day(-20), scope: 'all' }), 'CMS_PROGRAM_NOT_EDITABLE'), 'đã chốt: sửa thông tin ⇒ NOT_EDITABLE')
  // Preview khi chưa bắt đầu (replace) rồi qua ngày bắt đầu trước khi commit ⇒ CONFLICT (mode đổi).
  const pQ = await newProg({ name: 'QA qua ngày', start_date: day(70), end_date: day(80) })
  await importAll(pQ, 'replace', [prod('940001')])
  await activate(pQ)
  const runQ = await preview(pQ, 'replace')
  await backdate(pQ, -1, 80)
  ok(await raises(db, commit(runQ, { mode: 'replace', products: [prod('940002')] }), 'CMS_IMPORT_CONFLICT'), 'preview replace rồi qua ngày bắt đầu ⇒ commit CONFLICT (mode đã thành append)')
}
ok(await count(db, `SELECT count(*) FROM pg_proc WHERE proname IN ('rpc_cms_program_delete', 'rpc_cms_program_cancel', 'rpc_cms_program_revert')`) === 0, 'H8: không có RPC xoá / huỷ / về nháp')
{
  // Chương trình bị chốt sau preview ⇒ commit báo NOT_EDITABLE (không phải CONFLICT).
  const pK = await newProg({ name: 'QA khoá sau preview', start_date: day(90), end_date: day(95) })
  const runK = await preview(pK, 'replace')
  await db.query(`UPDATE public.cms_programs SET status = 'locked', activated_at = now(), locked_at = now() WHERE id = $1`, [pK])
  ok(await raises(db, commit(runK, { mode: 'replace', products: [prod('940009')] }), 'CMS_PROGRAM_NOT_EDITABLE'), 'chương trình đã chốt ⇒ commit NOT_EDITABLE')
  // Isolation khác READ COMMITTED ⇒ từ chối trước khi kiểm trùng (snapshot cũ không an toàn).
  const pI = await newProg({ name: 'QA isolation', start_date: day(96), end_date: day(99) })
  await importAll(pI, 'replace', [prod('940010')])
  let iso = ''
  await db.exec('BEGIN ISOLATION LEVEL REPEATABLE READ')
  try { await db.exec('SET LOCAL ROLE service_role'); await db.query(`SELECT public.rpc_cms_program_activate($1, $2)`, [pI, U.super]) } catch (e) { iso = String(e?.message ?? e) } finally { await db.exec('ROLLBACK').catch(() => {}) }
  ok(iso.includes('CMS_ISOLATION') && (await prog(pI)).status === 'draft', 'REPEATABLE READ ⇒ CMS_ISOLATION, không kích hoạt', iso)
  const cfg = await one(db, `SELECT proconfig::text c FROM pg_proc WHERE proname = 'rpc_cms_import_commit'`)
  ok(cfg.c.includes('lock_timeout=5s'), 'RPC có lock_timeout=5s', cfg.c)
}

section('8. Đầu-cuối biên số: workbook thật → parse → validate → payload → RPC (PM P1-b P1-1 / P1-2)')
{
  const { createJiti } = await import('jiti')
  const ROOT = path.join(HERE, '..')
  const jiti = createJiti(import.meta.url, { alias: { '@': ROOT, 'server-only': path.join(HERE, 'cms-server-only-stub.mjs') } })
  const XM = await import('xlsx')
  const X = XM.utils ? XM : XM.default
  const { parseCmsImportXlsx, CMS_IMPORT_COLUMNS } = await jiti.import(path.join(ROOT, 'lib/cms/import/parse.ts'))
  const { validateCmsImport } = await jiti.import(path.join(ROOT, 'lib/cms/import/validate.ts'))
  const { cmsImportPayload } = await jiti.import(path.join(ROOT, 'lib/cms/import/handler.ts'))
  const MAX = '9223372036854775807', OVER = '9223372036854775808'
  const QTY29 = '9'.repeat(29) + '.999999999'
  // [ProductID, Target, Loai, Tu, Den, CMS, TuVan, unit, baseQty] — tiền / quy cách dạng TEXT chính xác.
  const r = (pid, tgt, loai, cms, base) => [pid, tgt, loai, 1, null, cms, 'Tư vấn QA', 'hộp', base]
  const ws = X.utils.aoa_to_sheet([[...CMS_IMPORT_COLUMNS],
    r(900050, MAX, 'GMV_THEO_PRODUCTID', MAX, '24'),            // tiền = bigint max (CMS + target SP)
    r(900051, MAX, 'GMV_TOAN_DANH_MUC', '1000000000000000000', '1'), // target danh mục = max; CMS 19 chữ số (ca PM)
    r(900052, null, null, '5000', QTY29),                        // quy cách 29 chữ số nguyên + 9 thập phân
    r(900053, null, null, '5000', '100000000000000000000'),      // quy cách 21 chữ số (ca PM)
    r(900054, null, null, OVER, '1'),                            // CMS vượt miền ⇒ loại nhóm ở preview
    r(900055, null, null, '5000', '1' + '0'.repeat(29)),         // quy cách 30 chữ số ⇒ loại
    r(900056, null, null, '5000', 9007199254740992),             // quy cách ô số ngoài miền an toàn ⇒ loại
    r(900057, null, null, '5000', Number.MAX_SAFE_INTEGER),      // ô số = MAX_SAFE_INTEGER ⇒ nhận
  ])
  const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, ws, 'IMPORT_CMS')
  const parsed = parseCmsImportXlsx(new Uint8Array(X.write(wb, { type: 'array', bookType: 'xlsx' })))
  ok(parsed.ok && parsed.rows.length === 8, 'parse workbook thật 8 dòng', JSON.stringify(parsed.ok ? parsed.rows.length : parsed))
  const pm = new Map((await db.query(`SELECT product_id, product_name, image_url, is_active, reference_price::text rp FROM public.cms_product_master WHERE product_id LIKE '9000%'`)).rows
    .map((x) => [x.product_id, { productName: x.product_name, imageUrl: x.image_url, isActive: x.is_active, referencePrice: x.rp }]))
  const v = validateCmsImport(parsed.rows, { mode: 'replace', productMaster: pm, existingProductIds: new Set(), conflictProductIds: new Set(), currentCatalogTarget: null })
  const okIds = v.groupsOk.map((g) => g.productId).sort(), badIds = v.groupsRejected.map((g) => g.key).sort()
  ok(JSON.stringify(okIds) === JSON.stringify(['900050', '900051', '900052', '900053', '900057']), 'preview: 5 nhóm trong miền hợp lệ', JSON.stringify(okIds))
  ok(JSON.stringify(badIds) === JSON.stringify(['900054', '900055', '900056']), 'preview: 3 nhóm ngoài miền bị loại ĐÚNG nhóm', JSON.stringify(v.groupsRejected.map((g) => [g.key, g.errors.map((e) => e.code)])))
  const pE = await newProg({ name: 'QA biên số', start_date: day(150), end_date: day(160) })
  const runE = await preview(pE, 'replace')
  const res = await commit(runE, cmsImportPayload(v))
  ok(res.products === 5, 'commit payload validator ⇒ RPC nhận đủ 5 nhóm (preview hợp lệ ⇒ commit ghi được)', JSON.stringify(res))
  const got = await one(db, `SELECT (SELECT amount_per_unit::text FROM public.cms_program_tiers t JOIN public.cms_program_products pp ON pp.id = t.program_product_id WHERE pp.program_id = $1 AND pp.product_id = '900050') amt,` +
    ` (SELECT target_gmv::text FROM public.cms_program_products WHERE program_id = $1 AND product_id = '900050') tgt,` +
    ` (SELECT catalog_target_gmv::text FROM public.cms_programs WHERE id = $1) cat,` +
    ` (SELECT base_quantity_cms::text FROM public.cms_program_products WHERE program_id = $1 AND product_id = '900052') q29,` +
    ` (SELECT base_quantity_cms::text FROM public.cms_program_products WHERE program_id = $1 AND product_id = '900057') qsafe`, [pE])
  ok(got.amt === MAX && got.tgt === MAX && got.cat === MAX && got.q29 === QTY29 && got.qsafe === '9007199254740991', 'giá trị biên lưu chính xác (không làm tròn / cắt)', JSON.stringify(got))
}

section('9. Rollback 121')
{
  const db2 = await baseDb()
  await db2.query(`UPDATE public.app_migrations SET name = 'khac' WHERE version = '121'`)
  ok(await raises(db2, db2.exec(RB_121), 'không phải của CMS'), 'marker 121 không phải CMS ⇒ dừng')
  await db2.query(`UPDATE public.app_migrations SET name = 'cms_import_activation' WHERE version = '121'`)
  await db2.query(`INSERT INTO public.app_migrations (version, name) VALUES ('122', 't')`)
  ok(await raises(db2, db2.exec(RB_121), 'migration số > 121'), 'đã có 122 ⇒ dừng')
  await db2.query(`DELETE FROM public.app_migrations WHERE version = '122'`)
  await db2.query(`INSERT INTO public.cms_programs (name, start_date, end_date, scope, created_by) VALUES ('QA giữ', '2026-11-01', '2026-11-02', 'all', $1)`, [U.super])
  await db2.exec(RB_121)
  ok(await count(db2, `SELECT count(*) FROM pg_proc WHERE proname IN ('cms__vn_today','cms__lock_catalog','cms__conflicts','rpc_cms_program_save','rpc_cms_import_preview_save','rpc_cms_import_commit','rpc_cms_program_activate')`) === 0, 'rollback: hết 7 hàm 121')
  ok(await count(db2, `SELECT count(*) FROM public.cms_programs`) === 1 && await count(db2, `SELECT count(*) FROM pg_proc WHERE proname = 'cms_readable_program_ids'`) === 1, 'rollback 121 giữ bảng / dữ liệu / hàm của 120')
  ok(await count(db2, `SELECT count(*) FROM public.app_migrations WHERE version = '121'`) === 0, 'rollback: xoá marker 121')
  await db2.exec(SQL_121)
  ok(await count(db2, `SELECT count(*) FROM public.app_migrations WHERE version = '121'`) === 1, 'chạy lại 121 sau rollback')
}

console.log(`\n${pass} đạt · ${fail} lỗi`)
process.exit(fail ? 1 : 0)
