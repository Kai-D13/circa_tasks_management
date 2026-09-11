// QA EXECUTABLE cho migration 112 (thưởng thêm theo ngưỡng số đơn) — chạy
// NGUYÊN FILE migration trên Postgres THẬT (PGlite = Postgres biên dịch WASM,
// không phải mock) với schema tối thiểu, rồi gọi 2 RPC + ghi thẳng bảng bằng
// các ca tiền then chốt và đọc lại giá trị đã ghi. Không đụng DB thật, không
// đụng dependency của repo (pglite cài --no-save, không vào package.json).
//
//   cd webapp
//   npm i --no-save @electric-sql/pglite@0.2.17     # một lần, ~10MB wasm
//   node scripts/qa-kpi-order-bonus-112.mjs         # kỳ vọng: N đạt · 0 lỗi
//
// Bao phủ: idempotent (chạy 2 lần) · grants · import target (đủ cặp / lẫn lộn
// / mức thưởng ≠ 200000 / thiếu metric / loại campaign khác) · actuals (đạt,
// chưa đạt, = ngưỡng, thiếu 1 đơn, NULL khi degrade, payload dẫn xuất bị từ
// chối) · CHECK khoá 200000 ở tầng bảng · 2 trigger cờ metric ↔ ngưỡng · FOR
// UPDATE trong trigger targets · tương thích ngược.
//
// GIỚI HẠN: PGlite là MỘT session ⇒ không tái lập được race 2 transaction.
// Race (audit 113.7) kiểm bằng scripts/qa-race-112.mjs trên DB thật SAU khi
// áp 112 (idiom qa-race-098: 2 connection , QA_DB_URL).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let PGlite
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch {
  console.error('FAIL: thiếu @electric-sql/pglite — chạy: npm i --no-save @electric-sql/pglite@0.2.17 (trong webapp/)')
  process.exit(1)
}
const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIGRATION = path.resolve(HERE, '..', '..', 'supabase', 'migrations', '112_kpi_campaign_order_bonus.sql')

const db = new PGlite()
let pass = 0, fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name) }
  else { fail++; console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')) }
}
async function expectRaise(sql, params, needle, name) {
  try { await db.query(sql, params); ok(false, name, 'KHÔNG raise') }
  catch (e) { ok(String(e.message).includes(needle), name, 'raise khác: ' + e.message) }
}

// ── Schema tối thiểu (chỉ cột mà 2 RPC + migration dùng) ────────────────────
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TABLE public.app_migrations (version text PRIMARY KEY, name text, notes text);
  INSERT INTO public.app_migrations VALUES ('111', 'kpi_campaign_sm_read_ended', null);
  CREATE TABLE public.kpi_campaigns (
    id uuid PRIMARY KEY, status text, archived_at timestamptz, metric_type text,
    metric_offline boolean, metric_affiliate boolean, updated_at timestamptz);
  CREATE TABLE public.kpi_campaign_store_targets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id uuid, store_id uuid,
    pos_code text, kpi_target numeric, store_kpi_group text, import_row integer,
    note text, order_target bigint, aov_target numeric);
  CREATE TABLE public.kpi_campaign_store_tiers (
    target_id uuid, tier_order integer, threshold_pct numeric, commission_amount numeric);
  CREATE TABLE public.kpi_campaign_import_runs (
    campaign_id uuid, file_name text, uploaded_by uuid, row_count integer,
    success_count integer, error_count integer);
  CREATE TABLE public.kpi_campaign_store_actuals (
    campaign_id uuid, store_id uuid, actual_value numeric, actual_offline numeric,
    actual_affiliate numeric, actual_customer_count integer, run_rate numeric,
    remaining_target numeric, achieved_tier_order integer, store_commission_pool numeric,
    raw_row_count integer, offline_order_count bigint, offline_synced_at timestamptz,
    affiliate_synced_at timestamptz, synced_at timestamptz,
    PRIMARY KEY (campaign_id, store_id));
  CREATE TABLE public.kpi_campaign_store_daily_actuals (
    campaign_id uuid, store_id uuid, date date, gmv numeric, gmv_affiliate numeric,
    affiliate_customer_count integer, offline_order_count bigint, synced_at timestamptz);
`)

// ── Chạy nguyên file migration 112 (2 lần — phải idempotent) ─────────────────
const mig = fs.readFileSync(MIGRATION, 'utf8')
console.log('MIGRATION')
try { await db.exec(mig); ok(true, 'chạy lần 1 thành công') } catch (e) { ok(false, 'chạy lần 1', e.message); process.exit(1) }
try { await db.exec(mig); ok(true, 'chạy lần 2 (idempotent) thành công') } catch (e) { ok(false, 'chạy lần 2', e.message) }
const cols = await db.query(`SELECT table_name, column_name, data_type FROM information_schema.columns
  WHERE column_name IN ('minimum_order_target','order_bonus_per_staff','affiliate_order_count','bonus_order_count','order_bonus_achieved')
  ORDER BY 1, 2`)
ok(cols.rows.length === 5, '5 cột mới tồn tại', JSON.stringify(cols.rows))
const priv = await db.query(`SELECT
  has_function_privilege('service_role','public.rpc_replace_campaign_actuals(uuid,jsonb,jsonb)','EXECUTE') s,
  has_function_privilege('authenticated','public.rpc_replace_campaign_actuals(uuid,jsonb,jsonb)','EXECUTE') a,
  has_function_privilege('anon','public.rpc_replace_campaign_targets(uuid,jsonb,text,uuid)','EXECUTE') n`)
ok(priv.rows[0].s === true && priv.rows[0].a === false && priv.rows[0].n === false, 'grant: service_role có, authenticated/anon không', JSON.stringify(priv.rows[0]))
// 113.7 (audit P1): trigger targets PHẢI khoá dòng campaign trước khi đọc cờ.
const fdef = await db.query(`SELECT pg_get_functiondef('public.ensure_order_bonus_target_metrics()'::regprocedure) AS d`)
ok(/WHERE id = NEW.campaign_id FOR UPDATE;/.test(fdef.rows[0].d), 'trigger targets đọc cờ campaign với FOR UPDATE (serialize với UPDATE cờ)')

// ── Fixture ──────────────────────────────────────────────────────────────
const C1 = '11111111-1111-1111-1111-111111111111' // gmv, offline + affiliate
const C2 = '22222222-2222-2222-2222-222222222222' // gmv, CHỈ offline
const C3 = '33333333-3333-3333-3333-333333333333' // Chất lượng bán hàng
const C4 = '44444444-4444-4444-4444-444444444444' // Số khách Affiliate
const SA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const SB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
await db.query(`INSERT INTO public.kpi_campaigns VALUES
  ($1,'draft',null,'gmv',true,true,now()), ($2,'draft',null,'gmv',true,false,now()),
  ($3,'draft',null,'offline_order_aov',true,false,now()), ($4,'draft',null,'affiliate_customer_count',false,true,now())`,
  [C1, C2, C3, C4])

const tiers = [{ tier_order: 1, threshold_pct: 100, commission_amount: 2500000 }]
const row = (store, pos, extra = {}) => ({ store_id: store, pos_code: pos, kpi_target: 1000, store_kpi_group: null, import_row: 2, note: null, tiers, ...extra })
const bonus = { minimum_order_target: 10, order_bonus_per_staff: 200000 }
const T = `SELECT public.rpc_replace_campaign_targets($1::uuid, $2::jsonb, 'w2.csv', null) AS n`

console.log('\nIMPORT TARGET')
await expectRaise(T, [C1, JSON.stringify([row(SA, 'POS1', bonus), row(SB, 'POS2')])], 'MỌI cửa hàng trong file', 'file lẫn lộn (1 có, 1 trống) → từ chối cả file')
let n = await db.query(`SELECT count(*)::int c FROM public.kpi_campaign_store_targets WHERE campaign_id=$1`, [C1])
ok(n.rows[0].c === 0, 'file lẫn lộn → KHÔNG ghi nửa vời (rollback toàn bộ)', 'còn ' + n.rows[0].c + ' dòng')
await expectRaise(T, [C1, JSON.stringify([row(SA, 'POS1', { minimum_order_target: 10 }), row(SB, 'POS2', { minimum_order_target: 10 })])], 'phải có ĐỦ', 'thiếu order_bonus_per_staff → lỗi')
await expectRaise(T, [C1, JSON.stringify([row(SA, 'POS1', { ...bonus, minimum_order_target: 10.5 }), row(SB, 'POS2', bonus)])], 'minimum_order_target không hợp lệ', 'ngưỡng lẻ 10.5 → lỗi')
await expectRaise(T, [C1, JSON.stringify([row(SA, 'POS1', { ...bonus, order_bonus_per_staff: 0 }), row(SB, 'POS2', bonus)])], 'cố định 200000', 'tiền thưởng 0 → lỗi (rơi vào luật cố định 200000)')
await expectRaise(T, [C3, JSON.stringify([row(SA, 'POS1', { kpi_target: null, order_target: 500, aov_target: 150000, ...bonus })])], 'CHỈ dành cho campaign Doanh số', 'campaign Chất lượng bán hàng mang cột thưởng → lỗi')
// 113.5 (P1#2): mức thưởng khoá cứng 200000
for (const bad of [199999, 200001, 2000000, 200]) {
  await expectRaise(T, [C1, JSON.stringify([row(SA, 'POS1', { ...bonus, order_bonus_per_staff: bad }), row(SB, 'POS2', bonus)])], 'cố định 200000', 'order_bonus_per_staff=' + bad + ' → từ chối')
}
await expectRaise(T, [C1, JSON.stringify([row(SA, 'POS1', bonus), row(SB, 'POS2', { ...bonus, order_bonus_per_staff: 300000 })])], 'cố định 200000', 'file lẫn 2 mức (200000 + 300000) → từ chối')
// 113.5 (P1#3): campaign CHỈ Offline (C2) không được nạp ngưỡng
await expectRaise(T, [C2, JSON.stringify([row(SA, 'POS1', bonus), row(SB, 'POS2', bonus)])], 'bật CẢ Doanh thu thuần tại cửa hàng lẫn Doanh thu Affiliate', 'campaign chỉ Offline nạp ngưỡng → từ chối')
n = await db.query(T, [C2, JSON.stringify([row(SA, 'POS1'), row(SB, 'POS2')])])
const legacy = await db.query(`SELECT minimum_order_target m, order_bonus_per_staff b FROM public.kpi_campaign_store_targets WHERE campaign_id=$1`, [C2])
ok(n.rows[0].n === 2 && legacy.rows.every((r) => r.m === null && r.b === null), 'file KHÔNG có cột thưởng → ghi NULL (hành vi cũ)')
n = await db.query(T, [C1, JSON.stringify([row(SA, 'POS1', bonus), row(SB, 'POS2', bonus)])])
const saved = await db.query(`SELECT minimum_order_target m, order_bonus_per_staff::int b, order_target o FROM public.kpi_campaign_store_targets WHERE campaign_id=$1`, [C1])
ok(n.rows[0].n === 2 && saved.rows.every((r) => r.m === 10 && r.b === 200000 && r.o === null), 'file đủ 2 cột → lưu ngưỡng 10 + 200.000đ, order_target vẫn NULL', JSON.stringify(saved.rows))

// ── Actuals ─────────────────────────────────────────────────────────────────
const A = `SELECT public.rpc_replace_campaign_actuals($1::uuid, $2::jsonb, $3::jsonb) AS n`
const D = '2026-09-10'
const act = (store, off, aff, ord, affOrd, extra = {}) => ({
  store_id: store, actual_value: off + aff, actual_offline: off, actual_affiliate: aff,
  run_rate: null, remaining_target: 0, achieved_tier_order: null, store_commission_pool: null,
  raw_row_count: 1, ...(ord === undefined ? {} : { offline_order_count: ord }),
  ...(affOrd === undefined ? {} : { affiliate_order_count: affOrd }),
  offline_synced_at: null, affiliate_synced_at: null, synced_at: '2026-09-11T00:00:00Z', ...extra,
})
const day = (store, off, aff, ord) => ({ store_id: store, date: D, gmv: off, gmv_affiliate: aff, ...(ord === undefined ? {} : { offline_order_count: ord }), synced_at: '2026-09-11T00:00:00Z' })
const read = async (c) => Object.fromEntries((await db.query(
  `SELECT store_id, affiliate_order_count a, bonus_order_count c, order_bonus_achieved ok FROM public.kpi_campaign_store_actuals WHERE campaign_id=$1`, [c])).rows.map((r) => [r.store_id, r]))

console.log('\nĐỒNG BỘ ACTUALS — công thức thưởng')
await db.query(A, [C1, JSON.stringify([day(SA, 1100, 100, 8), day(SB, 900, 0, 20)]),
  JSON.stringify([act(SA, 1100, 100, 8, 3), act(SB, 900, 0, 20, 0)])])
let r = await read(C1)
ok(r[SA].c === 11 && r[SA].ok === true, 'A: doanh thu 1.200 ≥ 1.000 VÀ đơn 8+3=11 ≥ 10 → ĐẠT', JSON.stringify(r[SA]))
ok(r[SB].c === 20 && r[SB].ok === false, 'B: đơn 20 ≥ 10 nhưng doanh thu 900 < 1.000 → CHƯA ĐẠT', JSON.stringify(r[SB]))

await db.query(A, [C1, JSON.stringify([day(SA, 1000, 0, 7), day(SB, 1500, 0, 9)]),
  JSON.stringify([act(SA, 1000, 0, 7, 3), act(SB, 1500, 0, 9, 0)])])
r = await read(C1)
ok(r[SA].c === 10 && r[SA].ok === true, 'bằng ĐÚNG target và ĐÚNG ngưỡng (1.000 / 10) → ĐẠT (>=)', JSON.stringify(r[SA]))
ok(r[SB].c === 9 && r[SB].ok === false, 'doanh thu vượt nhưng thiếu 1 đơn (9 < 10) → CHƯA ĐẠT', JSON.stringify(r[SB]))
ok(r[SA].a === 3, 'affiliate_order_count được lưu', JSON.stringify(r[SA]))

await db.query(A, [C1, JSON.stringify([day(SA, 1500, 0), day(SB, 1500, 0, 30)]),
  JSON.stringify([act(SA, 1500, 0, undefined, 5), act(SB, 1500, 0, 30, 1)])])
r = await read(C1)
ok(r[SA].c === null && r[SA].ok === null, 'số đơn Offline thiếu (POS degrade) → CHƯA ĐỦ DỮ LIỆU (NULL), không phải "chưa đạt"', JSON.stringify(r[SA]))
ok(r[SB].c === 31 && r[SB].ok === true, 'store còn lại vẫn tính bình thường', JSON.stringify(r[SB]))

await db.query(A, [C1, JSON.stringify([day(SA, 1500, 0, 30), day(SB, 1500, 0, 30)]),
  JSON.stringify([act(SA, 1500, 0, 30), act(SB, 1500, 0, 30, 0)])])
r = await read(C1)
ok(r[SA].c === null && r[SA].ok === null, 'metric Affiliate bật mà thiếu affiliate_order_count (code cũ) → NULL, không đoán 0', JSON.stringify(r[SA]))

console.log('\nĐỒNG BỘ ACTUALS — chặn payload sai')
await expectRaise(A, [C1, JSON.stringify([day(SA, 1100, 100, 8), day(SB, 900, 0, 20)]),
  JSON.stringify([act(SA, 1100, 100, 8, 3, { order_bonus_achieved: true }), act(SB, 900, 0, 20, 0)])],
  'RPC tự tính từ target', 'app tự gửi order_bonus_achieved=true → TỪ CHỐI')
await expectRaise(A, [C1, JSON.stringify([day(SA, 1100, 100, 8), day(SB, 900, 0, 20)]),
  JSON.stringify([act(SA, 1100, 100, 8, 3, { bonus_order_count: 999 }), act(SB, 900, 0, 20, 0)])],
  'RPC tự tính từ target', 'app tự gửi bonus_order_count → TỪ CHỐI')
await expectRaise(A, [C1, JSON.stringify([day(SA, 1100, 100, 8), day(SB, 900, 0, 20)]),
  JSON.stringify([act(SA, 1100, 100, 8, -1), act(SB, 900, 0, 20, 0)])],
  'affiliate_order_count âm', 'affiliate_order_count âm → TỪ CHỐI')
await expectRaise(A, [C2, JSON.stringify([day(SA, 1000, 0, 5), day(SB, 1000, 0, 5)]),
  JSON.stringify([act(SA, 1000, 0, 5, 2), act(SB, 1000, 0, 5)])],
  'tắt metric_affiliate', 'campaign CHỈ Offline mà có affiliate_order_count → TỪ CHỐI')
await db.query(`INSERT INTO public.kpi_campaign_store_targets (campaign_id, store_id, pos_code, kpi_target) VALUES ($1,$2,'POS1',5)`, [C4, SA])
await expectRaise(A, [C4, '[]', JSON.stringify([{ store_id: SA, actual_value: 3, actual_customer_count: 3, affiliate_order_count: 3 }])],
  'chỉ campaign Doanh số được mang', 'campaign Số khách mang affiliate_order_count → TỪ CHỐI')

console.log('\n113.6 — CHECK khoá 200000 ở tầng bảng (đường ghi thẳng của super admin)')
for (const bad of [199999, 200001, 300000]) {
  await expectRaise(`INSERT INTO public.kpi_campaign_store_targets (campaign_id, store_id, pos_code, kpi_target, minimum_order_target, order_bonus_per_staff) VALUES ($1, $2, 'POSX', 1000, 10, $3)`,
    [C1, 'cccccccc-cccc-cccc-cccc-cccccccccccc', bad], 'chk_kcst_order_bonus', 'INSERT thẳng order_bonus_per_staff=' + bad + ' → CHECK từ chối')
}
await expectRaise(`UPDATE public.kpi_campaign_store_targets SET order_bonus_per_staff = 300000 WHERE campaign_id = $1 AND store_id = $2`,
  [C1, SA], 'chk_kcst_order_bonus', 'UPDATE thẳng sang 300000 → CHECK từ chối')

console.log('\n113.6 — trigger: cờ metric ↔ ngưỡng thưởng')
await expectRaise(`UPDATE public.kpi_campaigns SET metric_affiliate = false WHERE id = $1`, [C1],
  'không tắt được', 'tắt Affiliate khi campaign còn ngưỡng → trigger từ chối')
await expectRaise(`UPDATE public.kpi_campaigns SET metric_offline = false WHERE id = $1`, [C1],
  'không tắt được', 'tắt Offline khi campaign còn ngưỡng → trigger từ chối')
await db.query(`UPDATE public.kpi_campaigns SET metric_affiliate = true WHERE id = $1`, [C2])
await db.query(`UPDATE public.kpi_campaigns SET metric_affiliate = false WHERE id = $1`, [C2])
ok(true, 'campaign KHÔNG ngưỡng (C2) đổi cờ qua lại bình thường')
await db.query(`UPDATE public.kpi_campaigns SET updated_at = now() WHERE id = $1`, [C1])
ok(true, 'sửa cột khác của campaign có ngưỡng không bị trigger đụng')
await expectRaise(`INSERT INTO public.kpi_campaign_store_targets (campaign_id, store_id, pos_code, kpi_target, minimum_order_target, order_bonus_per_staff) VALUES ($1, $2, 'POSY', 1000, 10, 200000)`,
  [C2, 'dddddddd-dddd-dddd-dddd-dddddddddddd'], 'chỉ hợp lệ với chiến dịch Doanh số bật CẢ', 'INSERT thẳng ngưỡng vào campaign chỉ Offline → trigger từ chối')
await expectRaise(`INSERT INTO public.kpi_campaign_store_targets (campaign_id, store_id, pos_code, kpi_target, minimum_order_target, order_bonus_per_staff) VALUES ($1, $2, 'POSZ', 100, 10, 200000)`,
  [C3, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'], 'chỉ hợp lệ với chiến dịch Doanh số bật CẢ', 'INSERT thẳng ngưỡng vào campaign Chất lượng bán hàng → trigger từ chối')

// 113.5 (P1#3): phòng thủ tầng actuals — mô phỏng bypass trigger (superuser DISABLE)
// để chứng minh RPC actuals vẫn tự bảo vệ dù trạng thái mâu thuẫn lọt vào DB.
await db.query(`ALTER TABLE public.kpi_campaigns DISABLE TRIGGER trg_kpi_campaign_metrics_order_bonus`)
await db.query(`UPDATE public.kpi_campaigns SET metric_affiliate = false WHERE id = $1`, [C1])
await expectRaise(A, [C1, JSON.stringify([day(SA, 1100, 0, 8), day(SB, 900, 0, 20)]),
  JSON.stringify([act(SA, 1100, 0, 8), act(SB, 900, 0, 20)])],
  'tổng đơn phải gồm CẢ Offline + Affiliate', 'campaign có ngưỡng nhưng đã tắt Affiliate → PRESERVE, không tính nửa số')
await db.query(`UPDATE public.kpi_campaigns SET metric_affiliate = true WHERE id = $1`, [C1])
await db.query(`ALTER TABLE public.kpi_campaigns ENABLE TRIGGER trg_kpi_campaign_metrics_order_bonus`)

console.log('\nTƯƠNG THÍCH NGƯỢC')
await db.query(A, [C2, JSON.stringify([day(SA, 1000, 0, 5), day(SB, 1000, 0, 5)]),
  JSON.stringify([act(SA, 1000, 0, 5), act(SB, 1000, 0, 5)])])
r = await read(C2)
ok(r[SA].a === null && r[SA].c === null && r[SA].ok === null, 'campaign KHÔNG ngưỡng → 3 cột mới NULL (y như trước 112)', JSON.stringify(r[SA]))

console.log(`\nKẾT QUẢ: ${pass} đạt · ${fail} lỗi`)
process.exit(fail ? 1 : 0)
