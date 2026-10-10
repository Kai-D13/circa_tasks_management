// QA EXECUTABLE cho migration 114 (CRM-CSKH B1) — chạy NGUYÊN FILE migration
// trên Postgres thật (PGlite = Postgres 16 biên dịch WASM) với schema nền giống
// prod (đọc 07/10/2026 qua pg-meta: cột users/stores/sm_store_assignments/
// departments, default ACL của Supabase, auth.uid() nguyên văn, helper RLS
// nguyên văn; is_super_admin() trích từ migration mới nhất định nghĩa nó).
// Không đụng DB thật; pglite cài --no-save, không vào package.json.
//
//   cd webapp
//   npm i --no-save @electric-sql/pglite@0.2.17     # một lần
//   node scripts/qa-care-114.mjs                    # kỳ vọng: N đạt · 0 lỗi
//
// Bao phủ (SPEC B1 §3): idempotent ×2 · RLS bật · grants anon/authenticated/
// service_role · parity SQL↔TS (outcome, mốc trễ, SĐT, kỳ) · import 25 store,
// idempotent/hash trùng/lỗi dữ liệu rollback/actor/kỳ/staging thiếu · revision
// Q-50 · ghi lượt (validate, bất biến sau Hoàn thành, REFUSED → DNC + queue) ·
// biên mốc trễ 30/10 vs 31/10 + import T11 trước cron · đóng kỳ · chuyển giao
// (SM nguồn/đích, DNC, nguyên tử) · scope đọc 5 vai trò + FS + sau chuyển giao
// + lịch sử qua kỳ · report = đếm qua session client, không nhân đôi, loại is_test
// · append-only.
// GIỚI HẠN: PGlite một session ⇒ không tái lập race hai transaction thật. Script
// kiểm bảo đảm phía DB (unique một lượt kết thúc/task, một task mở/khách, FOR
// UPDATE trong thân hàm); race thật chạy qua pg-meta sau khi user áp 114 (B6).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { CARE_OUTCOMES, CARE_OUTCOME_META } from '../lib/care/outcome.ts'
import { overdueStampDate, periodLastDay, vnDateISO } from '../lib/care/time.ts'
import { normalizeVnPhone } from '../lib/affiliate/phone.ts'
import { buildCareImportRows, defaultFixtureStores } from '../e2e/careImportFixture.ts'

let PGlite
try { ({ PGlite } = await import('@electric-sql/pglite')) } catch {
  console.error('FAIL: thiếu @electric-sql/pglite — chạy: npm i --no-save @electric-sql/pglite@0.2.17 (trong webapp/)')
  process.exit(1)
}

let pass = 0, fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name) }
  else { fail++; console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')) }
}
const section = (t) => console.log('\n' + t)

import * as L from './lib-care-pglite.mjs'
const { SUPER_FN, SUPER_EMAIL, uid, MKT_DEPT, OPS_DEPT, storeId, S_INACTIVE, S_FS, staffId, U, setUid, as, raises, sha, stage, finalize, record, transfer, one, count, taskOf, row, EA, EB, EC, ED, MIGRATION } = L
const STORES = defaultFixtureStores(25)
const freshDb = () => L.freshDb(PGlite)
if (JSON.stringify(L.STORES) !== JSON.stringify(STORES)) { console.error('FAIL: lib-care-pglite STORES lệch e2e/careImportFixture'); process.exit(1) }

// ════════════════════════════════════════════════════════════════════════════
section(`MIGRATION (is_super_admin trích từ ${SUPER_FN.file})`)
let db = await freshDb()
ok(true, 'chạy lần 1 thành công (gồm hậu kiểm trong transaction)')
try { await db.exec(MIGRATION); ok(true, 'chạy lần 2 (idempotent) thành công') } catch (e) { ok(false, 'chạy lần 2', e.message) }
ok(await count(db, `SELECT count(*) FROM public.app_migrations WHERE version = '114'`) === 1, 'app_migrations có đúng 1 dòng 114')
ok(await count(db, `SELECT count(*) FROM public.care_access`) === 1, 'seed care_access đúng 1 dòng (không nhân đôi khi chạy lại)')
ok(await count(db, `SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname LIKE 'care\\_%' AND relkind = 'r' AND relrowsecurity`) === 13, '13 bảng care_* bật RLS')
{
  const db0 = new PGlite()
  await db0.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE public.app_migrations (version text PRIMARY KEY, name text NOT NULL, notes text);`)
  ok(await raises(db0.exec(MIGRATION), 'thiếu migration nền 113') === true, 'preflight: thiếu 113 ⇒ RAISE')
}

section('QUYỀN')
{
  const fns = (await db.query(`SELECT p.oid::regprocedure::text AS fn,
      has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
      has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'care%'`)).rows
  ok(fns.length === 41, '41 function care* (gồm care_assignee_uid — Q-76/77; care_staff_reads_task/customer — Q-79; care_staff_store_id — Q-82; care_recompute_attribution + care_order_sync_status — B5a; care_order_sync_candidates/apply/fail — B5b.2)', String(fns.length))
  const sid = fns.find((f) => f.fn === 'care_staff_store_id()')
  ok(sid && !sid.anon && sid.auth && sid.svc, 'care_staff_store_id(): authenticated + service_role, không anon (helper policy)', JSON.stringify(sid))
  ok(fns.every((f) => !f.anon), 'anon không EXECUTE function care* nào', fns.filter((f) => f.anon).map((f) => f.fn).join(', '))
  const internal = fns.filter((f) => f.fn.startsWith('care__'))
  ok(internal.length === 8 && internal.every((f) => !f.auth && !f.svc), 'care__* (8 hàm nội bộ) không cấp cho role nào', JSON.stringify(internal.filter((f) => f.auth || f.svc)))
  const svcOnly = ['care_import_finalize(uuid,uuid)', 'care_close_period()', 'care_stamp_overdue()', 'care_purge_stale_staging(interval)', 'care_recompute_attribution(text[],text[])',
    'care_order_sync_candidates(integer)', 'care_order_sync_apply(jsonb,timestamp with time zone)', 'care_order_sync_fail(text,timestamp with time zone)']
  ok(fns.filter((f) => svcOnly.includes(f.fn)).every((f) => f.svc && !f.auth), 'finalize/close/stamp/purge/recompute/sync_* chỉ service_role')
  ok(await raises(as(db, null, () => db.query(`TRUNCATE public.care_interactions`), 'service_role'), 'permission denied') === true, 'service_role không TRUNCATE được bảng append-only')
  ok(await count(db, `SELECT count(*) FROM pg_policies WHERE tablename LIKE 'care\_%'`) === 12
     && await count(db, `SELECT count(*) FROM pg_policies WHERE tablename IN ('care_order_attributions', 'care_orders')`) === 0,
     '12 policy care_* — không policy trên care_order_attributions (Q-95) / care_orders (Q-101)')
  const authRpc = ['care_record_interaction(uuid,text,text,date,jsonb)', 'care_transfer_tasks(uuid[],uuid,text)', 'care_report(date,uuid[],boolean)', 'care_my_summary()', 'care_my_access()']
  ok(fns.filter((f) => authRpc.includes(f.fn)).length === 5 && fns.filter((f) => authRpc.includes(f.fn)).every((f) => f.auth), 'RPC người dùng: authenticated có EXECUTE')
  const tp = await one(db, `SELECT has_table_privilege('authenticated','public.care_tasks','INSERT') ins,
      has_table_privilege('authenticated','public.care_interactions','UPDATE') upd,
      has_table_privilege('authenticated','public.care_import_staging','SELECT') stg,
      has_table_privilege('authenticated','public.care_reconcile_queue','SELECT') q,
      has_table_privilege('anon','public.care_tasks','SELECT') anon_sel,
      has_table_privilege('authenticated','public.care_orders','SELECT') ord_sel,
      has_table_privilege('authenticated','public.care_order_attributions','SELECT') attr_sel,
      has_table_privilege('anon','public.care_order_attributions','SELECT') attr_anon,
      has_table_privilege('service_role','public.care_order_attributions','SELECT') attr_svc`)
  ok(!tp.ins && !tp.upd && !tp.stg && !tp.q && !tp.anon_sel, 'bảng: authenticated không ghi; staging/queue không đọc; anon không đọc', JSON.stringify(tp))
  ok(!tp.attr_sel && !tp.attr_anon && tp.attr_svc, 'Q-95: authenticated/anon KHÔNG SELECT care_order_attributions; service_role vẫn đọc/ghi', JSON.stringify(tp))
  const tq = await one(db, `SELECT has_table_privilege('authenticated','public.care_orders','SELECT') o_sel,
      has_any_column_privilege('authenticated','public.care_orders','SELECT') o_col,
      has_table_privilege('anon','public.care_orders','SELECT') o_anon,
      has_table_privilege('service_role','public.care_orders','SELECT') o_svc,
      has_table_privilege('service_role','public.care_orders','INSERT') o_svc_ins,
      has_table_privilege('authenticated','public.care_sync_state','SELECT') s_sel`)
  ok(!tp.ord_sel && !tq.o_sel && !tq.o_col && !tq.o_anon && tq.o_svc && tq.o_svc_ins && tq.s_sel,
     'Q-101: authenticated/anon KHÔNG SELECT care_orders (bảng + cột); service_role đọc/ghi; care_sync_state GIỮ SELECT (theo policy)', JSON.stringify(tq))
  // Q-105: care_customers — authenticated chỉ 3 cột; KHÔNG quyền mức bảng (quyền bảng mở mọi cột, cộng dồn).
  const cc = (await db.query(`SELECT a.attname::text col,
      has_column_privilege('authenticated', a.attrelid, a.attnum, 'SELECT') auth,
      has_column_privilege('anon', a.attrelid, a.attnum, 'SELECT') anon,
      has_column_privilege('service_role', a.attrelid, a.attnum, 'SELECT') svc
    FROM pg_attribute a WHERE a.attrelid = 'public.care_customers'::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`)).rows
  const ct = await one(db, `SELECT has_table_privilege('authenticated', 'public.care_customers', 'SELECT') tbl_auth,
      has_table_privilege('anon', 'public.care_customers', 'SELECT') tbl_anon,
      (SELECT count(*)::int FROM pg_class c, aclexplode(c.relacl) x WHERE c.oid = 'public.care_customers'::regclass
         AND x.privilege_type = 'SELECT' AND x.grantee IN (0::oid, 'authenticated'::regrole::oid, 'anon'::regrole::oid)) acl_sel`)
  ok(cc.map((r) => `${r.col}:${r.auth ? 1 : 0}${r.anon ? 1 : 0}${r.svc ? 1 : 0}`).join(',') === 'id:101,external_id:001,is_test:101,created_at:101'
     && !ct.tbl_auth && !ct.tbl_anon && ct.acl_sel === 0,
     'Q-105: authenticated SELECT đúng (id, is_test, created_at) — external_id chỉ service_role; không quyền bảng/ACL SELECT cho authenticated/anon/PUBLIC',
     JSON.stringify({ cc, ct }))
  const cols = async (t) => (await one(db, `SELECT string_agg(column_name::text, ',' ORDER BY column_name) c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [t])).c
  ok(await cols('care_orders') === 'customer_external_id,order_key,ordered_at,synced_at',
     'care_orders đúng N3 r3.4 (Q-91/Q-93): 3 trường nghiệp vụ + synced_at — không tiền/source_updated_at/pos_code/cột r3.1', await cols('care_orders'))
  ok(await cols('care_order_attributions') === 'assignee_id,computed_at,customer_id,interaction_id,is_test,order_key,period_month,store_id,task_id'
     && await cols('care_sync_state') === 'last_error,last_success_at,source,updated_at'
     && await count(db, `SELECT count(*) FROM pg_class WHERE relname = 'care_orders_cursor_idx'`) === 0,
     'attribution không net_amount; care_sync_state không cursor/watermark; không index cursor (Q-91)',
     JSON.stringify({ a: await cols('care_order_attributions'), s: await cols('care_sync_state') }))
  const defs = (await db.query(`SELECT pg_get_functiondef(p.oid) d FROM pg_proc p WHERE p.proname IN ('care__record_interaction_at','care__transfer_tasks_at','care__import_finalize_at')`)).rows.map((r) => r.d)
  ok(defs.length === 3 && defs.every((d) => /FOR UPDATE/.test(d)), 'ghi lượt / chuyển giao / finalize đều khoá dòng FOR UPDATE')
}

section('PARITY SQL ↔ TS')
{
  const probes = [...CARE_OUTCOMES, 'interested', 'DONE', '', null]
  const rows = (await db.query(`SELECT x, public.care_is_outcome(x) o, public.care_is_terminal_outcome(x) t,
      public.care_outcome_requires_date(x) d, public.care_outcome_records_refusal(x) r FROM unnest($1::text[]) x`, [probes])).rows
  const bad = rows.filter((r) => {
    const m = CARE_OUTCOME_META[r.x]
    return (r.o === true) !== !!m || r.t !== (m?.terminal ?? false) || r.d !== (m?.requiresNextActionDate ?? false) || r.r !== (m?.recordsStoreRefusal ?? false)
  })
  ok(bad.length === 0, 'outcome: 6 mã + terminal + bắt buộc ngày hẹn + ghi DNC khớp lib/care/outcome.ts', JSON.stringify(bad))

  const grid = (await db.query(`
    WITH p AS (SELECT unnest(ARRAY['2026-10-01','2026-12-01','2028-02-01','2026-02-01']::date[]) m)
    SELECT n::date::text AS next, public.care_period_last_day(p.m)::text AS due, d::date::text AS today,
           public.care_overdue_stamp(n::date, public.care_period_last_day(p.m), d::date)::text AS s
    FROM p, generate_series(p.m, public.care_period_last_day(p.m), interval '1 day') n,
         generate_series(p.m, public.care_period_last_day(p.m) + 2, interval '3 day') d`)).rows
  const mism = grid.filter((g) => overdueStampDate(g.next, g.due, g.today) !== g.s)
  ok(grid.length > 1000 && mism.length === 0, `mốc trễ: ${grid.length} tổ hợp (next, due, today) khớp overdueStampDate`, JSON.stringify(mism.slice(0, 3)))
  ok(overdueStampDate(null, '2026-10-31', '2026-11-01') === null && (await one(db, `SELECT public.care_overdue_stamp(NULL, '2026-10-31', '2026-11-01') s`)).s === null, 'mốc trễ: không hẹn ⇒ null cả hai bên')

  const lastDays = (await db.query(`SELECT m::date::text m, public.care_period_last_day(m::date)::text l FROM generate_series('2026-01-01'::date, '2028-12-01', interval '1 month') m`)).rows
  ok(lastDays.every((r) => periodLastDay(r.m) === r.l), 'ngày cuối kỳ 36 tháng (gồm 2028 nhuận) khớp periodLastDay')
  const today = (await one(db, `SELECT public.care_vn_today()::text t`)).t
  ok(today === vnDateISO(new Date()), 'care_vn_today() = vnDateISO(now) (Asia/Ho_Chi_Minh)', today)
  // Biên 23:59:59 / 00:00 VN phía SQL, so với TS tại đúng các thời điểm chuyển ngày/tháng/năm.
  const instants = ['2026-10-31T16:59:59.999Z', '2026-10-31T17:00:00Z', '2026-11-01T00:30:00+07:00', '2026-12-31T16:59:00Z', '2026-12-31T17:00:00Z', '2028-02-28T17:00:00Z', '2028-02-29T16:59:59Z']
  const vd = (await db.query(`SELECT x, public.care_vn_date(x::timestamptz)::text d, public.care_period_of(public.care_vn_date(x::timestamptz))::text p FROM unnest($1::text[]) WITH ORDINALITY u(x, i) ORDER BY i`, [instants])).rows
  const vbad = vd.filter((r) => r.d !== vnDateISO(new Date(r.x)))
  ok(vbad.length === 0 && vd[0].p === '2026-10-01' && vd[1].p === '2026-11-01' && vd[4].d === '2027-01-01', 'care_vn_date biên 23:59:59/00:00 VN (tháng, năm, nhuận) khớp vnDateISO', JSON.stringify(vbad))
  const tz = await one(db, `SELECT set_config('TimeZone', 'America/New_York', false) z, public.care_vn_date('2026-10-31T17:00:00Z') d`)
  ok(tz.d.toISOString().slice(0, 10) === '2026-11-01', 'care_vn_date không phụ thuộc timezone session/server')
  await db.query(`SET TimeZone TO 'UTC'`)

  const phones = ['0901234567', '+84 901 234 567', '0084901234567', '84901234567', '840901234567', '901234567', '0201234567',
    '090-123-4567', '', 'abc', '012345678901', '0123456789', '(+84) 39 000 0999', '84 2412345678', null]
  const pr = (await db.query(`SELECT x, public.care_normalize_vn_phone(x) n FROM unnest($1::text[]) WITH ORDINALITY u(x, i) ORDER BY i`, [phones])).rows
  const pbad = pr.filter((r) => normalizeVnPhone(r.x) !== r.n)
  ok(pbad.length === 0, `SĐT: ${phones.length} mẫu khớp normalizeVnPhone`, JSON.stringify(pbad))
}

// ════════════════════════════════════════════════════════════════════════════
section('IMPORT — 25 store, kỳ T10/2026 (today 2026-10-01)')
const P10 = '2026-10-01', P11 = '2026-11-01'
const fixtureRows = buildCareImportRows({ customersPerStore: 12 }) // 6 khách / dược sĩ
const b1 = await stage(db, fixtureRows, { period: P10 })
let r = await finalize(db, b1, U.mkt, '2026-10-01')
ok(r.status === 'committed' && r.kind === 'initial' && r.created === 300 && r.customers === 300 && r.stores === 25, 'commit: 300 khách / 25 store / kind initial', JSON.stringify(r))
ok(await count(db, `SELECT count(*) FROM public.care_tasks WHERE period_month = $1`, [P10]) === 300, '300 task (một khách = một task dù nhiều dòng sản phẩm)')
ok(await count(db, `SELECT count(*) FROM public.care_task_products WHERE is_current`) === fixtureRows.length, `${fixtureRows.length} dòng sản phẩm hiện hành`)
ok(await count(db, `SELECT count(*) FROM public.care_assignment_events WHERE kind = 'assigned'`) === 300, '300 sự kiện assigned')
ok(await count(db, `SELECT count(*) FROM public.care_tasks WHERE due_date = '2026-10-31'`) === 300, 'hạn = 31/10 (cuối tháng import)')
ok(await count(db, `SELECT count(*) FROM public.care_import_staging`) === 0, 'staging (PII) đã xoá sau commit')
{
  const b = await one(db, `SELECT summary::text s FROM public.care_import_batches WHERE id = $1`, [b1])
  const leaks = fixtureRows.filter((x) => b.s.includes(x.customer_phone) || b.s.includes(x.customer_name) || b.s.includes(x.assignee_email))
  ok(leaks.length === 0, 'summary batch không chứa tên/SĐT/email')
  const t = await taskOf(db, fixtureRows[0].customer_external_id, P10)
  ok(t.assignee_id === staffId(1, 'a') && t.store_id === storeId(1), 'email map không phân biệt hoa thường → đúng staff/store')
}
r = await finalize(db, b1, U.mkt, '2026-10-01')
ok(r.status === 'committed' && r.idempotent === true && await count(db, `SELECT count(*) FROM public.care_tasks`) === 300, 'finalize lại cùng batch ⇒ idempotent, không tạo thêm')
const b1dup = await stage(db, fixtureRows, { period: P10 })
r = await finalize(db, b1dup, U.mkt, '2026-10-02')
ok(r.status === 'duplicate' && r.duplicate_of === b1 && await count(db, `SELECT count(*) FROM public.care_tasks`) === 300, 'cùng file (hash) lần 2 ⇒ duplicate, không tạo gì')

{
  // CHECK bảng (ngoài RPC): hạn = cuối kỳ, trạng thái ↔ mốc thời gian, ngày hẹn trong kỳ.
  const t0 = await taskOf(db, fixtureRows[3].customer_external_id, P10)
  ok(await raises(db.query(`UPDATE public.care_tasks SET due_date = '2026-10-30' WHERE id = $1`, [t0.id]), 'check') === true, 'CHECK: due_date phải là ngày cuối kỳ')
  ok(await raises(db.query(`UPDATE public.care_tasks SET status = 'completed' WHERE id = $1`, [t0.id]), 'check') === true, 'CHECK: completed phải có completed_at')
  ok(await raises(db.query(`UPDATE public.care_tasks SET next_action_date = '2026-11-02' WHERE id = $1`, [t0.id]), 'check') === true, 'CHECK: ngày hẹn ngoài kỳ bị chặn')
  ok(await raises(db.query(`UPDATE public.care_tasks SET status = 'paused' WHERE id = $1`, [t0.id]), 'check') === true, 'CHECK: trạng thái chỉ open/completed/closed_unfinished')
}

section('IMPORT — email dược sĩ phải khớp ĐÚNG MỘT staff của store (audit PM B1 P0)')
{
  // public.users.email không unique: thêm staff thứ hai cùng email (khác hoa/thường) ở QAOS05,
  // một staff cùng email ở QAOS06, và một staff đã tháo store (Q-71).
  const dupEmail = STORES[4].assigneeEmails[0]
  await db.query(`INSERT INTO public.users (id, email, full_name, role, store_id) VALUES
    ($1, $2, 'QA trùng email', 'staff', $3), ($4, $5, 'QA cùng email khác store', 'staff', $6), ($7, 'qa.left@example.invalid', 'QA đã nghỉ', 'staff', NULL)`,
    [uid(7001), ' ' + dupEmail.replace('qa.', 'QA.') + ' ', storeId(5), uid(7002), dupEmail, storeId(6), uid(7003)])
  const before = await count(db, `SELECT count(*) FROM public.care_tasks`)
  const rows = [
    row('QA-AMB1', 'QAOS05', dupEmail, 'P1'),                 // 2 staff QAOS05 cùng email ⇒ mơ hồ
    row('QA-AMB2', 'QAOS06', dupEmail, 'P1'),                 // ở QAOS06 chỉ có 1 ⇒ hợp lệ
    row('QA-AMB3', 'QAOS01', 'qa.left@example.invalid', 'P1'), // đã tháo store ⇒ không có ứng viên
  ]
  r = await finalize(db, await stage(db, rows, { period: P10 }), U.mkt, '2026-10-03')
  const byRow = Object.fromEntries(r.errors.map((e) => [e.row, e.code]))
  ok(r.status === 'rejected' && byRow[2] === 'ASSIGNEE_AMBIGUOUS', 'hai staff cùng store trùng email (khác hoa/thường, có khoảng trắng) ⇒ ASSIGNEE_AMBIGUOUS', JSON.stringify(r.errors))
  ok(!(3 in byRow), 'cùng email nhưng store đích chỉ có một staff ⇒ hợp lệ (đếm theo store)')
  ok(byRow[4] === 'ASSIGNEE_INVALID', 'staff đã tháo gán store (Q-71) ⇒ ASSIGNEE_INVALID')
  ok(await count(db, `SELECT count(*) FROM public.care_tasks`) === before && !(await taskOf(db, 'QA-AMB2', P10)), 'có dòng mơ hồ ⇒ cả batch không ghi (kể cả dòng hợp lệ QA-AMB2)')
}

section('IMPORT — lỗi dữ liệu ⇒ rollback cả batch')
{
  const bad = [
    row('QA-E1', 'QAOS01', EA, 'P1'),
    row('QA-E2', 'QAOS99', EA, 'P1'),                                   // store không tồn tại
    row('QA-E3', 'QAOS01', EC, 'P1'),                                   // staff của store khác
    row('QA-E4', 'QAOS01', EA, 'P1', { customer_phone: '0201234567' }), // SĐT bàn
    row('QA-E5', 'QAOS01', EA, 'P1', { product_url: 'https://storage.googleapis.com/x.png' }),
    row('QA-E6', 'QAOS01', EA, 'P1'), row('QA-E6', 'QAOS01', EA, 'P1'), // trùng (khách, sản phẩm)
    row('QA-E7', 'QAOS01', EA, 'P1'), row('QA-E7', 'QAOS01', EA, 'P2', { customer_name: 'Tên khác' }),
    row('QA-E8', 'QAOS01', EA, 'P1', { reason_text: '  ' }),
    row('QA-E9', 'QAFS01', 'qa.stafffs@example.invalid', 'P1'),        // store FS
    row('QA-E10', 'QAOS26', 'qa.staffoff@example.invalid', 'P1'),      // store ngừng
    row('QA-E11', 'QAOS01', 'qa.qlch1@example.invalid', 'P1'),         // không phải staff
  ]
  const before = await count(db, `SELECT count(*) FROM public.care_tasks`)
  const bb = await stage(db, bad, { period: P10 })
  r = await finalize(db, bb, U.mkt, '2026-10-03')
  const codes = new Set(r.errors.map((e) => e.code))
  const want = ['STORE_INVALID', 'ASSIGNEE_INVALID', 'PHONE_INVALID', 'IMAGE_URL_HOST', 'DUPLICATE_PRODUCT', 'INCONSISTENT_CUSTOMER', 'FIELD_REQUIRED']
  ok(r.status === 'rejected' && want.every((c) => codes.has(c)), 'rejected với đủ mã lỗi', JSON.stringify([...codes]))
  ok(r.errors.every((e) => Number.isInteger(e.row) && Object.keys(e).length === 2), 'lỗi chỉ {row, code} — không PII')
  ok(r.errors.some((e) => e.row === 12 && e.code === 'STORE_INVALID') && r.errors.some((e) => e.row === 13 && e.code === 'STORE_INVALID') && r.errors.some((e) => e.row === 14 && e.code === 'ASSIGNEE_INVALID'), 'store FS / store ngừng ⇒ STORE_INVALID; email QLCH ⇒ ASSIGNEE_INVALID (dòng Excel = index + 2)')
  ok(await count(db, `SELECT count(*) FROM public.care_tasks`) === before && !(await taskOf(db, 'QA-E1', P10)), 'dòng hợp lệ QA-E1 cũng KHÔNG được tạo (cả batch rollback)')
  ok(await count(db, `SELECT count(*) FROM public.care_customers WHERE external_id LIKE 'QA-E%'`) === 0, 'không tạo khách nào của batch lỗi')
  ok((await one(db, `SELECT status FROM public.care_import_batches WHERE id = $1`, [bb])).status === 'rejected' && await count(db, `SELECT count(*) FROM public.care_import_staging WHERE batch_id = $1`, [bb]) === 0, 'batch rejected, staging đã xoá')
}
{
  // Q-104: product_id toàn số 0 ("0", "00", " 0 " sau trim) ⇒ PRODUCT_ID_INVALID ở finalize gọi TRỰC TIẾP
  // (không qua parser/preview); ID khác có số 0 bên trong/đầu ("0042", "10") vẫn hợp lệ.
  const z = [
    row('QA-Z0', 'QAOS01', EA, '0'), row('QA-Z00', 'QAOS01', EA, '00'), row('QA-Zsp', 'QAOS01', EA, ' 0 '),
    row('QA-Zok', 'QAOS01', EA, '0042'), row('QA-Zok2', 'QAOS01', EA, '10'),
  ]
  const before = await count(db, `SELECT count(*) FROM public.care_tasks`)
  r = await finalize(db, await stage(db, z, { period: P10 }), U.mkt, '2026-10-03')
  ok(r.status === 'rejected' && JSON.stringify(r.errors.map((e) => `${e.row}:${e.code}`).sort()) === JSON.stringify(['2:PRODUCT_ID_INVALID', '3:PRODUCT_ID_INVALID', '4:PRODUCT_ID_INVALID']),
     'Q-104: finalize trực tiếp — "0", "00", " 0 " ⇒ PRODUCT_ID_INVALID; "0042", "10" không lỗi; cả batch rollback', JSON.stringify(r.errors))
  ok(await count(db, `SELECT count(*) FROM public.care_tasks`) === before, 'Q-104: batch lỗi không tạo task nào')
  const okB = await finalize(db, await stage(db, [row('QA-Zok3', 'QAOS01', EA, '0042')], { period: P10 }), U.mkt, '2026-10-03')
  ok(okB.status === 'committed', 'Q-104: ID có số 0 ở đầu nhưng không toàn 0 ("0042") vẫn nhập được', JSON.stringify(okB))
  // CHECK bảng bảo vệ đường ghi khác ngoài finalize (superuser INSERT thẳng).
  const tz = await taskOf(db, 'QA-Zok3', P10)
  for (const bad of ['0', '000', ' 0']) {
    ok(await raises(db.query(`INSERT INTO public.care_task_products (task_id, batch_id, product_id, product_name, reason_type, reason_text)
      SELECT id, (SELECT id FROM public.care_import_batches LIMIT 1), $1, 'SP', 'chronic', 'QA' FROM public.care_tasks WHERE id = $2`, [bad, tz.id]), 'check') === true,
       `Q-104: CHECK care_task_products chặn product_id ${JSON.stringify(bad)}`)
  }
}
{
  const b = await stage(db, [row('QA-X1', 'QAOS01', EA, 'P1')], { period: P10, actor: U.ops })
  ok(await raises(finalize(db, b, U.ops, '2026-10-03'), 'không có quyền import') === true, 'admin phòng OPS (không có care_access) ⇒ từ chối')
  const b2 = await stage(db, [row('QA-X2', 'QAOS01', EA, 'P1')], { period: P10, actor: U.mkt })
  ok(await raises(finalize(db, b2, U.super, '2026-10-03'), 'actor khác người tạo') === true, 'actor ≠ người tạo batch ⇒ từ chối')
  ok(await raises(finalize(db, b2, U.mkt, '2026-11-01'), 'khác tháng hiện tại') === true, 'kỳ batch ≠ tháng hiện tại VN ⇒ từ chối')
  const b3 = await stage(db, [row('QA-X3', 'QAOS01', EA, 'P1')], { period: P10, actor: U.mkt, rowCount: 5 })
  ok(await raises(finalize(db, b3, U.mkt, '2026-10-03'), 'staging chưa đủ') === true, 'staging thiếu dòng (row_count 5, có 1) ⇒ từ chối')
  const b4 = await stage(db, [row('QA-S1', 'QAOS03', STORES[2].assigneeEmails[0], 'P1')], { period: P10, actor: U.super })
  r = await finalize(db, b4, U.super, '2026-10-03')
  ok(r.status === 'committed' && r.kind === 'revision', 'super admin (allowlist trong is_super_admin) import được; kind revision', JSON.stringify(r))
  const uidAfter = (await one(db, `SELECT current_setting('request.jwt.claim.sub', true) s`)).s
  ok(!uidAfter, 'care__uid_is_super trả lại claim sub cũ sau khi kiểm')
  {
    // Ngữ cảnh PostgREST service_role: chỉ có request.jwt.claims; trick claim.sub không được đụng claims.
    const claims = JSON.stringify({ role: 'service_role' })
    await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [claims])
    const b5 = await stage(db, [row('QA-S2', 'QAOS03', STORES[2].assigneeEmails[0], 'P1')], { period: P10, actor: U.super })
    r = await finalize(db, b5, U.super, '2026-10-03')
    const after = await one(db, `SELECT current_setting('request.jwt.claims', true) c, auth.uid() u`)
    ok(r.status === 'committed' && after.c === claims && after.u === null, 'claims PostgREST giữ nguyên, auth.uid() trở lại null sau finalize')
    await db.query(`SELECT set_config('request.jwt.claims', '', false)`)
  }
  {
    // Fixture is_test và dữ liệu thật không dùng chung khách (cả hai chiều).
    const real = fixtureRows[0].customer_external_id
    let x = await finalize(db, await stage(db, [row(real, 'QAOS01', EA, 'P9')], { period: P10, isTest: true }), U.mkt, '2026-10-03')
    ok(x.status === 'rejected' && x.errors.every((e) => e.code === 'TEST_FLAG_MISMATCH'), 'batch is_test chạm khách thật ⇒ TEST_FLAG_MISMATCH, không sửa task thật', JSON.stringify(x))
    await finalize(db, await stage(db, [row('QA-TONLY', 'QAOS01', EA, 'P1')], { period: P10, isTest: true }), U.mkt, '2026-10-03')
    x = await finalize(db, await stage(db, [row('QA-TONLY', 'QAOS01', EA, 'P1')], { period: P10 }), U.mkt, '2026-10-03')
    ok(x.status === 'rejected' && x.errors[0].code === 'TEST_FLAG_MISMATCH', 'batch thật chạm khách fixture ⇒ TEST_FLAG_MISMATCH')
    // Staging hụt dòng: đủ số lượng nhưng row_no không liền mạch.
    const g = await stage(db, [row('QA-G1', 'QAOS01', EA, 'P1'), row('QA-G2', 'QAOS01', EA, 'P1')], { period: P10 })
    await db.query(`UPDATE public.care_import_staging SET row_no = 9 WHERE batch_id = $1 AND row_no = 3`, [g])
    ok(await raises(finalize(db, g, U.mkt, '2026-10-03'), 'hụt dòng') === true, 'staging row_no không liền mạch ⇒ từ chối')
    // Batch staged kẹt > 24h ⇒ dọn PII.
    const k = await stage(db, [row('QA-K1', 'QAOS01', EA, 'P1')], { period: P10 })
    const fresh = await stage(db, [row('QA-K2', 'QAOS01', EA, 'P1')], { period: P10 })
    await db.query(`UPDATE public.care_import_batches SET created_at = now() - interval '2 days' WHERE id = $1`, [k])
    const n = await as(db, null, async () => (await db.query(`SELECT public.care_purge_stale_staging() n`)).rows[0].n, 'service_role')
    const st = await one(db, `SELECT (SELECT status FROM public.care_import_batches WHERE id = $1) k, (SELECT status FROM public.care_import_batches WHERE id = $2) f,
      (SELECT count(*)::int FROM public.care_import_staging WHERE batch_id = $1) ks, (SELECT count(*)::int FROM public.care_import_staging WHERE batch_id = $2) fs`, [k, fresh])
    ok(n >= 1 && st.k === 'rejected' && st.ks === 0 && st.f === 'staged' && st.fs === 1, 'care_purge_stale_staging: batch kẹt > 24h ⇒ rejected + xoá staging; batch mới giữ nguyên', JSON.stringify({ n, st }))
    ok(await raises(db.query(`SELECT public.care_purge_stale_staging(interval '5 minutes')`), 'tối thiểu 1 giờ') === true, 'purge: ngưỡng < 1 giờ ⇒ từ chối')
    await db.query(`DELETE FROM public.care_import_staging WHERE batch_id = $1`, [fresh])
    await db.query(`UPDATE public.care_import_batches SET status = 'rejected', finished_at = now() WHERE id = $1`, [fresh])
  }
}

section('GHI LƯỢT — validate + bất biến')
const ext = (i) => fixtureRows.filter((x) => x.target_store_code === 'QAOS01')[i].customer_external_id
const custA = [...new Set(fixtureRows.filter((x) => x.assignee_email === EA).map((x) => x.customer_external_id))]
const custB = [...new Set(fixtureRows.filter((x) => x.assignee_email === EB).map((x) => x.customer_external_id))]
const tA0 = await taskOf(db, custA[0], P10)
ok(await raises(record(db, '2026-10-05', U.B, tA0.id, 'NO_NEED'), 'chỉ dược sĩ được giao') === true, 'staff khác ghi task không phải của mình ⇒ từ chối')
ok(await raises(record(db, '2026-10-05', U.qlch1, tA0.id, 'NO_NEED'), 'chỉ dược sĩ được giao') === true, 'QLCH không ghi lượt (Q-76/77)')
ok(await raises(record(db, '2026-10-05', U.A, tA0.id, 'CALLBACK'), 'bắt buộc ngày hẹn') === true, 'CALLBACK thiếu ngày hẹn ⇒ từ chối')
ok(await raises(record(db, '2026-10-05', U.A, tA0.id, 'UNREACHABLE', 'x', '2026-11-02'), 'tới hết tháng') === true, 'ngày hẹn sang tháng sau ⇒ từ chối (Q-48)')
ok(await raises(record(db, '2026-10-05', U.A, tA0.id, 'CALLBACK', 'x', '2026-10-04'), 'tới hết tháng') === true, 'ngày hẹn trong quá khứ ⇒ từ chối')
ok(await raises(record(db, '2026-10-05', U.A, tA0.id, 'NO_NEED', 'x', '2026-10-09'), 'không nhận ngày hẹn') === true, 'outcome kết thúc kèm ngày hẹn ⇒ từ chối')
ok(await raises(record(db, '2026-10-05', U.A, tA0.id, 'NO_NEED', '   '), 'ghi chú bắt buộc') === true, 'ghi chú rỗng ⇒ từ chối')
ok(await raises(record(db, '2026-10-05', U.A, tA0.id, 'NO_NEED', 'x'.repeat(501)), '1–500') === true, 'ghi chú 501 ký tự ⇒ từ chối')
ok(await raises(record(db, '2026-10-05', U.A, tA0.id, 'DONE'), 'kết quả không hợp lệ') === true, 'outcome lạ ⇒ từ chối')
ok(await raises(record(db, '2026-10-05', U.A, tA0.id, 'NO_NEED', 'x', null, { url: 'a' }), 'proof phải là mảng') === true, 'proof không phải mảng ⇒ từ chối')
for (const [bad, why] of [[[{ url: 'javascript:alert(1)' }], 'javascript:'], [[{ url: 'http://x.invalid/a.jpg' }], 'http'], [[{ url: 'https://x.invalid/a.jpg', extra: 1 }], 'key lạ'], [Array(6).fill({ url: 'https://x.invalid/a.jpg' }), '6 ảnh'], [[{ url: 'https://x.invalid/' + 'a'.repeat(5000) }], 'quá dài']]) {
  ok(await raises(record(db, '2026-10-05', U.A, tA0.id, 'NO_NEED', 'x', null, bad), 'proof phải là mảng') === true, `proof ${why} ⇒ từ chối`)
}
// B4: proof chỉ nhận object app cấp cho ĐÚNG task: <base>/care-proof/<task_id>/<khoá>.<ảnh>.
const PB = 'https://storage.googleapis.com/duocsi-circa-vn/care-proof/'
const tOther = await one(db, `SELECT id FROM public.care_tasks WHERE id <> $1 LIMIT 1`, [tA0.id])
for (const [url, why] of [
  ['https://example.invalid/p.jpg', 'host ngoài'],
  [PB + tOther.id + '/1700000000000_abcd1234.jpg', 'prefix task khác'],
  ['https://storage.googleapis.com/duocsi-circa-vn.evil.com/care-proof/' + tA0.id + '/1700000000000_abcd1234.jpg', 'host giả dạng'],
  ['https://storage.googleapis.com/duocsi-circa-vn/tasks/' + tA0.id + '/1700000000000_abcd1234.jpg', 'vùng tasks'],
  [PB + tA0.id + '/../x/1700000000000_abcd1234.jpg', 'traversal'],
  [PB + tA0.id + '/1700000000000_abcd1234.svg', 'đuôi svg'],
  [PB + tA0.id + '/ten-khach.jpg', 'khoá quá ngắn'],
  // Biên (db-reviewer B4): xuống dòng, UUID hoa, query/fragment, percent-encoding, chữ số fullwidth, đuôi hoa.
  [PB + tA0.id + '/1700000000000_abcd1234.jpg\n', 'xuống dòng cuối'],
  [PB + tA0.id.toUpperCase() + '/1700000000000_abcd1234.jpg', 'UUID chữ hoa'],
  [PB + tA0.id + '/1700000000000_abcd1234.jpg?x=1', 'query string'],
  [PB + tA0.id + '/1700000000000_abcd1234.jpg#x', 'fragment'],
  [PB + tA0.id + '/%2e%2e/1700000000000_abcd1234.jpg', 'percent-encoding'],
  [PB + tA0.id + '/１700000000000_abcd1234.jpg', 'chữ số fullwidth'],
  [PB + tA0.id + '/1700000000000_abcd1234.JPG', 'đuôi chữ hoa'],
]) {
  ok(await raises(record(db, '2026-10-05', U.A, tA0.id, 'NO_NEED', 'x', null, [{ url }]), 'proof phải là mảng') === true, `proof ${why} ⇒ từ chối (RPC trực tiếp)`)
}
ok(await raises(record(db, '2026-10-05', U.A, tA0.id, 'NO_NEED', 'x', null, [{ url: PB + tA0.id + '/1700000000000_abcd1234.jpg' }, { url: PB + tA0.id + '/1700000000000_abcd1234.jpg' }]), 'proof phải là mảng') === true, 'proof trùng URL trong mảng ⇒ từ chối (khớp TS)')
// B4: chống ghi trùng khi retry — cùng người/task/kết quả/ghi chú/ngày hẹn trong 2 phút.
{
  const tD = await taskOf(db, (await one(db, `SELECT c.external_id FROM public.care_tasks t JOIN public.care_customers c ON c.id = t.customer_id WHERE t.assignee_id = $1 AND t.status = 'open' AND t.id <> $2 ORDER BY t.id LIMIT 1`, [U.A, tA0.id])).external_id, P10)
  await record(db, '2026-10-05', U.A, tD.id, 'CALLBACK', 'QA retry', '2026-10-09')
  ok(await raises(record(db, '2026-10-05', U.A, tD.id, 'CALLBACK', 'QA retry', '2026-10-09'), 'lượt trùng vừa được ghi') === true, 'retry cùng nội dung trong 2 phút ⇒ từ chối (không tạo lượt trùng)')
  await record(db, '2026-10-05', U.A, tD.id, 'CALLBACK', 'QA gọi lần 2', '2026-10-09')
  ok(await count(db, `SELECT count(*) FROM public.care_interactions WHERE task_id = $1`, [tD.id]) === 2, 'lượt khác nội dung vẫn ghi được')
  // Q-82: dược sĩ bị tháo store / chuyển store khác (OS hoặc FS) / store ngừng ⇒ không ghi lượt dù còn là assignee.
  const NOT_STORE = 'không còn thuộc cửa hàng của task'
  await db.query(`UPDATE public.users SET store_id = NULL WHERE id = $1`, [U.A])
  ok(await raises(record(db, '2026-10-05', U.A, tD.id, 'CALLBACK', 'QA sau tháo store', '2026-10-09'), NOT_STORE) === true, 'staff bị tháo store ⇒ không ghi lượt')
  await db.query(`UPDATE public.users SET store_id = $1 WHERE id = $2`, [storeId(2), U.A])
  ok(await raises(record(db, '2026-10-05', U.A, tD.id, 'CALLBACK', 'QA sau chuyển OS', '2026-10-09'), NOT_STORE) === true, 'staff chuyển sang store OS KHÁC (QAOS02, đang hoạt động) mà task còn ở QAOS01 ⇒ không ghi lượt')
  await db.query(`UPDATE public.users SET store_id = $1 WHERE id = $2`, [S_FS, U.A])
  ok(await raises(record(db, '2026-10-05', U.A, tD.id, 'CALLBACK', 'QA sau chuyển FS', '2026-10-09'), NOT_STORE) === true, 'staff chuyển sang store FS ⇒ không ghi lượt')
  await db.query(`UPDATE public.users SET store_id = $1 WHERE id = $2`, [storeId(1), U.A])
  await db.query(`UPDATE public.stores SET is_active = false WHERE id = $1`, [storeId(1)])
  ok(await raises(record(db, '2026-10-05', U.A, tD.id, 'CALLBACK', 'QA store ngừng', '2026-10-09'), NOT_STORE) === true, 'store của staff (= store task) ngừng hoạt động ⇒ không ghi lượt')
  await db.query(`UPDATE public.stores SET is_active = true WHERE id = $1`, [storeId(1)])
  ok((await record(db, '2026-10-05', U.A, tD.id, 'CALLBACK', 'QA về lại QAOS01', '2026-10-09')).status === 'open', 'về lại đúng store task ⇒ ghi lượt được (đối chứng)')
}
r = await record(db, '2026-10-05', U.A, tA0.id, 'INTERESTED', 'QA quan tâm', null, [{ url: PB + tA0.id + '/1700000000000_abcd1234.jpg' }, { url: PB + tA0.id + '/1700000000001_ef567890.webp' }])
let t = await one(db, `SELECT * FROM public.care_tasks WHERE id = $1`, [tA0.id])
ok(r.status === 'completed' && t.status === 'completed' && t.last_outcome === 'INTERESTED' && t.completed_at, 'INTERESTED ⇒ Hoàn thành')
const it = await one(db, `SELECT * FROM public.care_interactions WHERE task_id = $1`, [tA0.id])
ok(it.assignee_id === U.A && it.store_id === storeId(1) && it.actor_id === U.A && it.is_terminal === true && it.period_month.toISOString().slice(0, 10) === P10, 'lượt chụp assignee/store/kỳ tại thời điểm ghi')
ok(await count(db, `SELECT count(*) FROM public.care_reconcile_queue WHERE customer_id = $1`, [tA0.customer_id]) === 1, 'lượt Hoàn thành ⇒ vào care_reconcile_queue')
ok(await raises(record(db, '2026-10-06', U.A, tA0.id, 'NO_NEED'), 'task đã kết thúc') === true, 'task Hoàn thành không nhận thêm lượt (Q-52) — gọi RPC trực tiếp')
ok(await raises(db.query(`INSERT INTO public.care_interactions (task_id, customer_id, actor_id, assignee_id, store_id, period_month, outcome, is_terminal, note) VALUES ($1,$2,$3,$3,$4,$5,'NO_NEED',true,'x')`, [tA0.id, tA0.customer_id, U.A, storeId(1), P10]), 'one_terminal_per_task') === true, 'DB chặn lượt kết thúc thứ hai cùng task (unique) — bảo đảm khi race')
ok(await raises(db.query(`UPDATE public.care_interactions SET note = 'sửa' WHERE task_id = $1`, [tA0.id]), 'chỉ thêm') === true, 'interaction append-only: UPDATE bị chặn (kể cả superuser)')
ok(await raises(db.query(`DELETE FROM public.care_interactions WHERE task_id = $1`, [tA0.id]), 'chỉ thêm') === true, 'interaction append-only: DELETE dòng thật bị chặn')
ok(await raises(db.query(`DELETE FROM public.care_tasks WHERE id = $1`, [tA0.id]), 'chỉ thêm') === true, 'task thật không xoá được')
{
  const tA1 = await taskOf(db, custA[1], P10)
  await db.query(`INSERT INTO public.care_reconcile_queue (customer_id, from_ts) VALUES ($1, '2026-01-01T00:00:00Z')`, [tA1.customer_id])
  await record(db, '2026-10-05', U.A, tA1.id, 'NO_NEED')
  const q = await one(db, `SELECT from_ts FROM public.care_reconcile_queue WHERE customer_id = $1`, [tA1.customer_id])
  ok(q.from_ts.toISOString() === '2026-01-01T00:00:00.000Z', 'queue gộp giữ MIN(from_ts)')
}

section('MỐC TRỄ HẸN — biên cuối tháng (Q-62, redline r1.3 §2.8)')
const [k30, k31, kDone, kTwice, kNone] = custB
for (const [k, d] of [[k30, '2026-10-30'], [k31, '2026-10-31'], [kDone, '2026-10-10'], [kTwice, '2026-10-08']]) {
  await record(db, '2026-10-05', U.B, (await taskOf(db, k, P10)).id, 'CALLBACK', 'QA hẹn', d)
}
ok(await count(db, `SELECT public.care__stamp_overdue_at('2026-10-30')`) >= 0 && !(await taskOf(db, k30, P10)).first_overdue_on, 'hẹn 30/10, stamp ngày 30/10 ⇒ chưa trễ')
await db.query(`SELECT public.care__stamp_overdue_at('2026-10-31')`)
ok((await taskOf(db, k30, P10)).first_overdue_on?.toISOString().slice(0, 10) === '2026-10-31', 'hẹn 30/10 không gọi ⇒ mốc trễ 31/10 (Quá hạn T10 = 1)')
ok(!(await taskOf(db, k31, P10)).first_overdue_on, 'hẹn 31/10, stamp 31/10 ⇒ không trễ')
await record(db, '2026-10-12', U.B, (await taskOf(db, kDone, P10)).id, 'INTERESTED')
t = await taskOf(db, kDone, P10)
ok(t.status === 'completed' && t.first_overdue_on?.toISOString().slice(0, 10) === '2026-10-11' && t.next_action_date === null, 'trễ hẹn rồi Hoàn thành ⇒ giữ mốc 11/10, xoá nhãn hẹn live')
await record(db, '2026-10-12', U.B, (await taskOf(db, kTwice, P10)).id, 'CALLBACK', 'QA hẹn lại', '2026-10-15')
await record(db, '2026-10-20', U.B, (await taskOf(db, kTwice, P10)).id, 'CALLBACK', 'QA hẹn lần 3', '2026-10-25')
ok((await taskOf(db, kTwice, P10)).first_overdue_on?.toISOString().slice(0, 10) === '2026-10-09', 'trễ 2 lần ⇒ vẫn một mốc (mốc đầu 09/10)')

section('ĐÓNG KỲ qua import T11 (chạy TRƯỚC cron 00:05)')
const refusedK = custA[2]
await record(db, '2026-10-20', U.A, (await taskOf(db, refusedK, P10)).id, 'REFUSED', 'QA từ chối')
ok(await count(db, `SELECT count(*) FROM public.care_store_refusals f JOIN public.care_tasks t ON t.customer_id = f.customer_id WHERE t.id = $1 AND f.store_id = $2`, [(await taskOf(db, refusedK, P10)).id, storeId(1)]) === 1, 'REFUSED ⇒ ghi từ chối (khách, store của task)')
{
  // T11: khách đã từ chối ở QAOS01 ⇒ import lại vào QAOS01 bị chặn cả batch.
  const bRef = await stage(db, [row(refusedK, 'QAOS01', EA, 'P1'), row('QA-N1', 'QAOS01', EA, 'P1')], { period: P11 })
  r = await finalize(db, bRef, U.mkt, '2026-11-01')
  ok(r.status === 'rejected' && r.errors.some((e) => e.code === 'REFUSED_AT_STORE' && e.row === 2), 'T11: khách đã từ chối ở X import vào X ⇒ REFUSED_AT_STORE, cả batch không ghi')
  ok(await count(db, `SELECT count(*) FROM public.care_tasks WHERE period_month = $1`, [P11]) === 0, 'batch bị từ chối không tạo task T11')
  ok(await count(db, `SELECT count(*) FROM public.care_tasks WHERE period_month = $1 AND status = 'open'`, [P10]) > 0, 'batch bị từ chối KHÔNG đóng kỳ T10 (không ghi gì)')
}
const p11rows = [row(refusedK, 'QAOS02', EC, 'P1'), row(custB[5] ?? 'QA-N2', 'QAOS01', EB, 'P1'), row('QA-N3', 'QAOS02', EC, 'P1')]
const b11 = await stage(db, p11rows, { period: P11 })
r = await finalize(db, b11, U.mkt, '2026-11-01')
ok(r.status === 'committed' && r.kind === 'initial' && r.closed_previous_period > 0, 'T11 commit; cùng khách vào store Y khác ⇒ được; đóng kỳ T10 trong cùng transaction', JSON.stringify(r))
const t30 = await taskOf(db, k30, P10), t31 = await taskOf(db, k31, P10), tNone = await taskOf(db, kNone, P10)
ok(t30.status === 'closed_unfinished' && t30.first_overdue_on?.toISOString().slice(0, 10) === '2026-10-31', 'hẹn 30/10 ⇒ Quá hạn 1 + Không hoàn thành 1')
ok(t31.status === 'closed_unfinished' && t31.first_overdue_on === null && t31.next_action_date === null, 'hẹn 31/10 ⇒ Quá hạn 0, Không hoàn thành 1 (không ghi mốc 01/11)')
ok(tNone.status === 'closed_unfinished' && tNone.first_overdue_on === null, 'không hẹn, không xử lý ⇒ Quá hạn 0, Không hoàn thành 1')
ok(await count(db, `SELECT count(*) FROM public.care_tasks WHERE status = 'open' AND period_month < $1`, [P11]) === 0, 'không còn task mở của kỳ cũ')
ok(await count(db, `SELECT public.care__close_period_at('2026-11-02')`) === 0, 'đóng kỳ chạy lại ⇒ idempotent (0 dòng)')
ok((await taskOf(db, kDone, P10)).status === 'completed', 'task đã Hoàn thành không bị đóng kỳ')
{
  // Task kỳ cũ còn mở (cron chưa chạy) không nhận lượt mới.
  const db2 = await freshDb()
  const bx = await stage(db2, [row('QA-OLD', 'QAOS01', EA, 'P1')], { period: P10 })
  await finalize(db2, bx, U.mkt, '2026-10-02')
  ok(await raises(record(db2, '2026-11-01', U.A, (await taskOf(db2, 'QA-OLD', P10)).id, 'NO_NEED'), 'kỳ đã qua') === true, 'task T10 còn mở sang 01/11 ⇒ không ghi lượt được')
  await db2.close()
}

section('REVISION cùng tháng (Q-50)')
{
  const db3 = await freshDb()
  const base = [
    row('QA-R1', 'QAOS01', EA, 'P1'), row('QA-R1', 'QAOS01', EA, 'P2'),     // đổi lý do P2
    row('QA-R2', 'QAOS01', EA, 'P1'),                                       // đổi tên/SĐT
    row('QA-R3', 'QAOS01', EA, 'P1'),                                       // đã có lượt
    row('QA-R4', 'QAOS01', EA, 'P1'),                                       // vắng ở bản sửa
    row('QA-R5', 'QAOS01', EA, 'P1'),                                       // đổi dược sĩ trong file
    row('QA-R6', 'QAOS01', EA, 'P1'),                                       // không đổi
  ]
  await finalize(db3, await stage(db3, base, { period: P10 }), U.mkt, '2026-10-02')
  await record(db3, '2026-10-03', U.A, (await taskOf(db3, 'QA-R3', P10)).id, 'CALLBACK', 'x', '2026-10-20')
  const rev = [
    row('QA-R1', 'QAOS01', EA, 'P1'), row('QA-R1', 'QAOS01', EA, 'P2', { reason_text: 'QA lý do mới' }),
    row('QA-R2', 'QAOS01', EA, 'P1', { customer_name: 'KH đổi tên', customer_phone: '0390000777' }),
    row('QA-R3', 'QAOS01', EA, 'P1', { reason_text: 'không được áp' }),
    row('QA-R5', 'QAOS01', EB, 'P1'),
    row('QA-R6', 'QAOS01', EA, 'P1'),
    row('QA-R7', 'QAOS01', EA, 'P1'),                                       // khách mới
  ]
  r = await finalize(db3, await stage(db3, rev, { period: P10 }), U.mkt, '2026-10-04')
  ok(r.status === 'committed' && r.kind === 'revision' && r.created === 1 && r.updated === 2 && r.unchanged === 2
     && r.skipped_has_interaction === 1 && r.owner_ignored === 1 && r.absent_kept === 1, 'diff: tạo 1 · sửa 2 · giữ 2 · bỏ qua có lượt 1 · owner bỏ qua 1 · vắng giữ 1', JSON.stringify(r))
  const r1 = await taskOf(db3, 'QA-R1', P10)
  const prods = (await db3.query(`SELECT product_id, reason_text, is_current FROM public.care_task_products WHERE task_id = $1 ORDER BY is_current, product_id`, [r1.id])).rows
  ok(prods.filter((p) => p.is_current).length === 2 && prods.some((p) => p.is_current && p.reason_text === 'QA lý do mới') && prods.filter((p) => !p.is_current).length === 2, 'sản phẩm: bản mới is_current, bản cũ giữ lịch sử is_current=false')
  const r2 = await taskOf(db3, 'QA-R2', P10)
  ok(r2.customer_name === 'KH đổi tên' && r2.phone_norm === '0390000777', 'task chưa có lượt: snapshot tên/SĐT kỳ này cập nhật')
  ok(await count(db3, `SELECT count(*) FROM public.care_task_products p JOIN public.care_tasks t ON t.id = p.task_id JOIN public.care_customers c ON c.id = t.customer_id WHERE c.external_id = 'QA-R3' AND p.reason_text = 'không được áp'`) === 0, 'task đã có lượt: không áp thay đổi')
  ok((await taskOf(db3, 'QA-R5', P10)).assignee_id === U.A, 'đổi dược sĩ trong file ⇒ không đổi owner (dùng Chuyển giao)')
  ok((await taskOf(db3, 'QA-R4', P10)).status === 'open', 'khách vắng bản sửa ⇒ task giữ nguyên')
  // Kỳ cũ không bao giờ bị revision kỳ mới chạm.
  await finalize(db3, await stage(db3, [row('QA-R2', 'QAOS01', EA, 'P1', { customer_name: 'Tên T11' })], { period: P11 }), U.mkt, '2026-11-01')
  ok((await taskOf(db3, 'QA-R2', P10)).customer_name === 'KH đổi tên' && (await taskOf(db3, 'QA-R2', P11)).customer_name === 'Tên T11', 'tên T11 mới không đổi snapshot task T10')
  ok(await raises(db3.query(`INSERT INTO public.care_tasks (customer_id, period_month, due_date, batch_id, store_id, assignee_id, customer_name, phone_norm, phone_raw) SELECT customer_id, '2026-12-01', '2026-12-31', batch_id, store_id, assignee_id, 'x', phone_norm, phone_raw FROM public.care_tasks WHERE period_month = $1 LIMIT 1`, [P11]), 'one_open_per_customer') === true, 'DB chặn hai task mở cùng khách')
  await db3.close()
}

section('CHUYỂN GIAO (kỳ T11, today 2026-11-05)')
{
  const tK = await taskOf(db, refusedK, P11)          // ở QAOS02 (C), khách đã từ chối QAOS01
  const tN2 = await taskOf(db, p11rows[1].customer_external_id, P11) // QAOS01 (B)
  ok(await raises(transfer(db, '2026-11-05', U.sm, [tK.id], U.A), 'đã từ chối chăm sóc tại cửa hàng đích') === true, 'chuyển sang store khách đã từ chối ⇒ lỗi')
  ok(await raises(transfer(db, '2026-11-05', U.sm, [tK.id, (await taskOf(db, kDone, P10)).id], U.D), 'đang mở của kỳ hiện tại') === true && (await taskOf(db, refusedK, P11)).assignee_id === U.C && await count(db, `SELECT count(*) FROM public.care_assignment_events WHERE kind = 'transferred'`) === 0, 'lệnh 2 task có 1 task đã Hoàn thành ⇒ lỗi, task hợp lệ cũng không đổi, không ghi sự kiện (nguyên tử)')
  ok(await raises(transfer(db, '2026-11-05', U.sm2, [tN2.id], U.C), 'cửa hàng đích') === true, 'SM chỉ quản lý QAOS01 chuyển sang QAOS02 ⇒ lỗi đích')
  ok(await raises(transfer(db, '2026-11-05', U.sm2, [tK.id], U.A), 'cửa hàng nguồn') === true, 'SM chuyển task ở store không quản lý ⇒ lỗi nguồn')
  ok(await raises(transfer(db, '2026-11-05', U.qlch1, [tN2.id], U.A), 'chỉ SM hoặc super') === true, 'QLCH không chuyển giao')
  ok(await raises(transfer(db, '2026-11-05', U.A, [tN2.id], U.A), 'chỉ SM hoặc super') === true, 'staff không chuyển giao')
  ok(await raises(transfer(db, '2026-11-05', U.sm, [tN2.id], U.A, '  '), 'ghi chú') === true, 'thiếu note ⇒ lỗi')
  ok(await raises(transfer(db, '2026-11-05', U.sm, [tN2.id], U.qlch1), 'staff của cửa hàng OS') === true, 'đích là QLCH ⇒ lỗi')
  ok(await raises(transfer(db, '2026-11-05', U.super, [tN2.id], U.staffFs), 'staff của cửa hàng OS') === true, 'đích là staff FS ⇒ lỗi')
  ok(await raises(transfer(db, '2026-11-05', U.super, [tN2.id], U.staffInactive), 'staff của cửa hàng OS') === true, 'đích ở store ngừng ⇒ lỗi')
  ok(await raises(transfer(db, '2026-11-05', U.super, [(await taskOf(db, kDone, P10)).id], U.A), 'đang mở của kỳ hiện tại') === true, 'task đã Hoàn thành / kỳ cũ ⇒ không chuyển')
  r = await transfer(db, '2026-11-05', U.sm, [tN2.id], U.C, 'QA SM chuyển')
  const ev = await one(db, `SELECT * FROM public.care_assignment_events WHERE task_id = $1 AND kind = 'transferred'`, [tN2.id])
  t = await one(db, `SELECT * FROM public.care_tasks WHERE id = $1`, [tN2.id])
  ok(r.transferred === 1 && t.assignee_id === U.C && t.store_id === storeId(2), 'SM quản lý cả hai store ⇒ chuyển được, task đổi store/dược sĩ')
  ok(ev.from_user_id === U.B && ev.from_store_id === storeId(1) && ev.to_user_id === U.C && ev.actor_id === U.sm && ev.note === 'QA SM chuyển', 'sự kiện ghi snapshot nguồn/đích/actor/note')
  r = await transfer(db, '2026-11-05', U.super, [tK.id], U.D)
  ok(r.transferred === 1, 'super chuyển được trong cùng store sang dược sĩ khác')
}
await db.close()

// ════════════════════════════════════════════════════════════════════════════
section('RLS 5 VAI TRÒ (kỳ hiện tại thật theo giờ VN)')
db = await freshDb()
const TODAY = (await one(db, `SELECT public.care_vn_today()::text t`)).t
const PC = (await one(db, `SELECT public.care_period_of(public.care_vn_today())::text p`)).p
const PPREV = (await one(db, `SELECT (public.care_period_of(public.care_vn_today()) - interval '1 month')::date::text p`)).p
{
  // Kỳ trước: khách H do B (QAOS01) chăm, có lượt; kỳ này H giao cho A. Chèn thẳng (superuser) như dữ liệu lịch sử.
  const bPrev = (await one(db, `INSERT INTO public.care_import_batches (period_month, kind, status, file_name, file_sha256, row_count, created_by, finished_at) VALUES ($1, 'initial', 'committed', 'old.xlsx', $2, 1, $3, now()) RETURNING id`, [PPREV, sha('old'), U.mkt])).id
  await db.query(`INSERT INTO public.care_customers (external_id) VALUES ('QA-H'), ('QA-OLDA')`)
  for (const [e, who] of [['QA-H', U.B], ['QA-OLDA', U.A]]) {
    const tid = (await one(db, `INSERT INTO public.care_tasks (customer_id, period_month, due_date, batch_id, store_id, assignee_id, customer_name, phone_norm, phone_raw, status, last_outcome, completed_at)
      SELECT id, $2, public.care_period_last_day($2), $3, $4, $5, 'KH cũ', '0390000111', '0390000111', 'completed', 'NO_NEED', now() FROM public.care_customers WHERE external_id = $1 RETURNING id`, [e, PPREV, bPrev, storeId(1), who])).id
    await db.query(`INSERT INTO public.care_interactions (task_id, customer_id, actor_id, assignee_id, store_id, period_month, outcome, is_terminal, note) SELECT id, customer_id, $2, $2, store_id, period_month, 'NO_NEED', true, 'lượt kỳ trước' FROM public.care_tasks WHERE id = $1`, [tid, who])
  }
  const rows = [
    row('QA-H', 'QAOS01', EA, 'P1'), row('QA-H', 'QAOS01', EA, 'P2'), row('QA-H', 'QAOS01', EA, 'P3'),
    row('QA-A2', 'QAOS01', EA, 'P1'), row('QA-B1', 'QAOS01', EB, 'P1'), row('QA-C1', 'QAOS02', EC, 'P1'),
    row('QA-Z1', 'QAOS03', STORES[2].assigneeEmails[0], 'P1'),
  ]
  // Import qua đường service_role thật (care_import_finalize dùng giờ VN thật).
  const bc = await stage(db, rows, { period: PC })
  r = await as(db, null, async () => (await db.query(`SELECT public.care_import_finalize($1, $2) r`, [bc, U.mkt])).rows[0].r, 'service_role')
  ok(r.status === 'committed' && r.created === 5, 'service_role gọi care_import_finalize (giờ VN thật) ⇒ commit', JSON.stringify(r))
  const bt = await stage(db, [row('QA-T1', 'QAOS01', EA, 'P1')], { period: PC, isTest: true })
  await finalize(db, bt, U.mkt, TODAY)
  ok(await raises(as(db, U.mkt, () => db.query(`SELECT public.care_import_finalize($1, $2)`, [bt, U.mkt])), 'permission denied') === true, 'authenticated (kể cả Marketing) không gọi được finalize trực tiếp')
  ok(await raises(as(db, U.A, () => db.query(`SELECT public.care__record_interaction_at($1, $2, 'NO_NEED', 'x', NULL, NULL)`, [TODAY, uid(1)])), 'permission denied') === true, 'authenticated không gọi được bản nội bộ care__*_at (không giả ngày)')
  ok(await raises(as(db, null, () => db.query(`SELECT * FROM public.care_tasks`), 'anon'), 'permission denied') === true, 'anon không đọc care_tasks')
  ok(await raises(as(db, null, () => db.query(`SELECT * FROM public.care_report($1)`, [PC]), 'anon'), 'permission denied') === true, 'anon không gọi care_report')
}
// Chỉ đọc care_tasks dưới vai trò; ánh xạ customer_id → mã khách bằng superuser
// (care_customers có policy riêng: chỉ mở khi khách có task KỲ HIỆN TẠI trong scope).
const visibleExt = async (who) => {
  const ids = (await db.query(`SELECT id, external_id FROM public.care_customers`)).rows
  const ext = new Map(ids.map((x) => [x.id, x.external_id]))
  const rows = await as(db, who, async () => (await db.query(`SELECT customer_id, period_month::text p FROM public.care_tasks`)).rows)
  return rows.map((x) => `${ext.get(x.customer_id)}@${x.p.slice(0, 7)}`).sort()
}
{
  const cur = PC.slice(0, 7), prev = PPREV.slice(0, 7)
  const sA = await visibleExt(U.A)
  ok(sA.includes(`QA-H@${cur}`) && sA.includes(`QA-A2@${cur}`) && sA.includes(`QA-T1@${cur}`) && sA.includes(`QA-OLDA@${prev}`) && !sA.includes(`QA-B1@${cur}`) && !sA.includes(`QA-H@${prev}`),
     'staff A: task của mình (kể cả kỳ cũ), không thấy task của B / task kỳ trước của khách do B chăm', sA.join(','))
  ok(await raises(as(db, U.A, () => db.query(`SELECT * FROM public.care_import_staging`)), 'permission denied') === true, 'staff không đọc staging')
  ok(await raises(as(db, U.A, () => db.query(`SELECT count(*) FROM public.care_orders`)), 'permission denied') === true, 'staff: SELECT care_orders bị từ chối (Q-101)')
  ok(await raises(as(db, U.A, () => db.query(`INSERT INTO public.care_customers (external_id) VALUES ('hack')`)), 'permission denied') === true, 'staff không ghi thẳng bảng')
  // Q-105: người dùng không đọc external_id ⇒ lấy customer_id bằng superuser (fixture), kiểm lịch sử theo id.
  const custH = (await one(db, `SELECT id FROM public.care_customers WHERE external_id = 'QA-H'`)).id
  const histOf = (who) => as(db, who, () => count(db, `SELECT count(*) FROM public.care_interactions i WHERE i.customer_id = $1`, [custH]))
  const histA = await as(db, U.A, async () => (await db.query(`SELECT note FROM public.care_interactions i WHERE i.customer_id = $1`, [custH])).rows)
  ok(histA.length === 1 && histA[0].note === 'lượt kỳ trước', 'staff A thấy lượt kỳ trước của khách H (H có task kỳ này giao A)')
  const histC = await histOf(U.C)
  ok(histC === 0, 'staff C (store khác) không thấy lịch sử khách H')
  // Q-105 hành vi: mọi vai người dùng bị từ chối external_id và SELECT *; 3 cột được trả theo RLS khách.
  const custRows = (who) => as(db, who, () => count(db, `SELECT count(*) FROM (SELECT id, is_test, created_at FROM public.care_customers WHERE id = $1) x`, [custH]))
  ok(await custRows(U.A) === 1 && await custRows(U.C) === 0 && await custRows(U.super) === 1,
     'Q-105: SELECT (id, is_test, created_at) vẫn theo RLS khách — A thấy H (task kỳ này), C không, super thấy')
  for (const [name, who] of [['staff A', U.A], ['staff C', U.C], ['SM', U.sm], ['SM2', U.sm2], ['Marketing (care admin)', U.mkt], ['super', U.super], ['QLCH', U.qlch1]]) {
    ok(await raises(as(db, who, () => db.query(`SELECT external_id FROM public.care_customers LIMIT 1`)), 'permission denied') === true
       && await raises(as(db, who, () => db.query(`SELECT * FROM public.care_customers LIMIT 1`)), 'permission denied') === true
       && await raises(as(db, who, () => db.query(`SELECT count(*) FROM public.care_interactions i JOIN public.care_customers c ON c.id = i.customer_id WHERE c.external_id = 'QA-H'`)), 'permission denied') === true,
       `Q-105: ${name} — SELECT external_id / SELECT * / lọc theo external_id đều bị từ chối`)
  }
  ok(await raises(as(db, null, () => db.query(`SELECT id FROM public.care_customers LIMIT 1`), 'anon'), 'permission denied') === true, 'Q-105: anon không đọc cột nào của care_customers')
  ok(await as(db, null, () => count(db, `SELECT count(*) FROM public.care_customers WHERE external_id = 'QA-H'`), 'service_role') === 1, 'Q-105: service_role vẫn tra external_id (import/đồng bộ N3)')
  // Q-76/77 (08/10): QLCH `store_manager` (tài khoản dùng chung) KHÔNG tham gia CRM GĐ1 —
  // 0 dòng ở MỌI bảng CRM đọc được, kể cả khi khách có task kỳ này ở store của QLCH,
  // kể cả khi QLCH cùng department với care admin (Marketing).
  // care_order_attributions không có trong danh sách: Q-95 thu hồi SELECT ⇒ mọi role đều bị từ chối (kiểm riêng).
  const CRM_TABLES = ['care_access', 'care_import_batches', 'care_customers', 'care_tasks', 'care_task_products', 'care_interactions',
    'care_assignment_events', 'care_store_refusals', 'care_sync_state']
  const zeroAll = async (who) => { const n = {}; for (const t of CRM_TABLES) n[t] = await as(db, who, () => count(db, `SELECT count(*) FROM public.${t}`)); return n }
  const superN = await zeroAll(U.super)
  ok(['care_tasks', 'care_task_products', 'care_interactions', 'care_assignment_events', 'care_customers'].every((t) => superN[t] > 0), 'fixture có dữ liệu ở các bảng chính (đối chứng)', JSON.stringify(superN))
  ok(await as(db, null, () => count(db, `SELECT count(*) FROM public.care_tasks WHERE store_id = $1 AND period_month = $2`, [storeId(1), PC]), 'service_role') > 0, 'store của QLCH (QAOS01) có task kỳ hiện tại (đối chứng)')
  for (const [name, who] of [['QLCH OS', U.qlch1], ['QLCH FS', U.qlchFs]]) {
    const n = await zeroAll(who)
    ok(Object.values(n).every((x) => x === 0), `${name}: 0 dòng ở cả ${CRM_TABLES.length} bảng CRM`, JSON.stringify(n))
    const rep = await as(db, who, async () => (await db.query(`SELECT * FROM public.care_report($1::date)`, [PC])).rows)
    const sm = await as(db, who, async () => (await db.query(`SELECT * FROM public.care_my_summary()`)).rows[0])
    const acc = await as(db, who, async () => (await db.query(`SELECT public.care_my_access() a`)).rows[0].a)
    ok(rep.length === 0 && sm.assigned === 0 && acc.scope_store_count === 0 && !acc.can_view_all && !acc.can_import, `${name}: care_report rỗng, care_my_summary 0, care_my_access không scope/quyền`, JSON.stringify({ rep: rep.length, sm, acc }))
  }
  await db.query(`UPDATE public.users SET department_id = $1 WHERE id = $2`, [MKT_DEPT, U.qlch1])
  const nMkt = await zeroAll(U.qlch1)
  const accMkt = await as(db, U.qlch1, async () => (await db.query(`SELECT public.care_my_access() a`)).rows[0].a)
  ok(Object.values(nMkt).every((x) => x === 0) && !accMkt.can_view_all && !accMkt.can_import, 'QLCH cùng phòng Marketing (care admin) KHÔNG kế thừa quyền phòng — kể cả đọc care_access', JSON.stringify({ nMkt, accMkt }))
  await db.query(`UPDATE public.users SET department_id = NULL WHERE id = $1`, [U.qlch1])
  // Q-79: SM chỉ thấy dữ liệu con có store SNAPSHOT thuộc vùng (không suy từ task/khách hiện tại).
  for (const [name, who] of [['SM', U.sm], ['SM2', U.sm2]]) {
    const v = await as(db, who, async () => (await db.query(`SELECT
        (SELECT count(*) FROM public.care_interactions WHERE NOT (store_id = ANY (public.care_scope_store_ids())))::int AS i_out,
        (SELECT count(*) FROM public.care_assignment_events WHERE NOT (to_store_id = ANY (public.care_scope_store_ids()))
                                                              AND NOT (COALESCE(from_store_id = ANY (public.care_scope_store_ids()), false)))::int AS e_out,
        (SELECT count(*) FROM public.care_store_refusals WHERE NOT (store_id = ANY (public.care_scope_store_ids())))::int AS r_out,
        (SELECT count(*) FROM public.care_interactions)::int AS i_all`)).rows[0])
    ok(v.i_out === 0 && v.e_out === 0 && v.r_out === 0 && v.i_all > 0, `${name}: lượt/event/DNC đều có store thuộc vùng (Q-79)`, JSON.stringify(v))
  }
  // Q-95: không role người dùng nào đọc thẳng attribution — kể cả super/care admin.
  for (const [name, who] of [['staff A', U.A], ['SM', U.sm], ['QLCH', U.qlch1], ['Marketing', U.mkt], ['super', U.super]]) {
    ok(await raises(as(db, who, () => db.query(`SELECT count(*) FROM public.care_order_attributions`)), 'permission denied') === true,
       `${name}: SELECT care_order_attributions bị từ chối (Q-95)`)
    ok(await raises(as(db, who, () => db.query(`SELECT order_key FROM public.care_orders LIMIT 1`)), 'permission denied') === true,
       `${name}: SELECT care_orders bị từ chối (Q-101)`)
  }
  // Tài khoản đổi role staff → QLCH: nhánh assignee đóng (care_assignee_uid() = NULL).
  const aBefore = (await visibleExt(U.A)).length
  await db.query(`UPDATE public.users SET role = 'store_manager' WHERE id = $1`, [U.A])
  const aAsQlch = await zeroAll(U.A)
  await db.query(`UPDATE public.users SET role = 'staff' WHERE id = $1`, [U.A])
  ok(aBefore > 0 && Object.values(aAsQlch).every((x) => x === 0) && (await visibleExt(U.A)).length === aBefore, 'staff A bị đổi sang QLCH ⇒ 0 dòng ở mọi bảng; đổi lại staff ⇒ thấy lại task của mình', JSON.stringify({ aBefore, aAsQlch }))
  ok((await visibleExt(U.qlchFs)).length === 0 && (await visibleExt(U.staffFs)).length === 0, 'tài khoản FS (QLCH/staff) không thấy CRM OS')
  const sSm = await visibleExt(U.sm), sSm2 = await visibleExt(U.sm2)
  ok(sSm.includes(`QA-C1@${cur}`) && sSm.includes(`QA-B1@${cur}`) && !sSm.includes(`QA-Z1@${cur}`), 'SM (QAOS01, QAOS02): đúng hai store')
  ok(!sSm2.includes(`QA-C1@${cur}`) && sSm2.includes(`QA-B1@${cur}`), 'SM2 (chỉ QAOS01): không thấy QAOS02')
  ok((await visibleExt(U.mkt)).length === 8 && (await visibleExt(U.super)).length === 8, 'Marketing (can_view_all) và super thấy tất cả')
  ok((await visibleExt(U.ops)).length === 0, 'admin phòng khác không có care_access ⇒ không thấy gì')
  ok(await as(db, U.mkt, () => count(db, `SELECT count(*) FROM public.care_import_batches`)) >= 2 && await as(db, U.A, () => count(db, `SELECT count(*) FROM public.care_import_batches`)) === 0, 'batch: Marketing thấy, staff không')

  // care_access: chỉ super sửa.
  ok(await as(db, U.mkt, () => count(db, `SELECT count(*) FROM public.care_access`)) === 1 && await as(db, U.ops, () => count(db, `SELECT count(*) FROM public.care_access`)) === 0, 'care_access: phòng mình thấy dòng của mình, phòng khác không')
  await as(db, U.mkt, () => db.query(`UPDATE public.care_access SET can_import = false WHERE true`))
  ok((await one(db, `SELECT can_import FROM public.care_access`)).can_import === true, 'Marketing không tự sửa quyền (UPDATE 0 dòng)')
  ok(await raises(as(db, U.ops, () => db.query(`INSERT INTO public.care_access (department_id, can_import) VALUES ($1, true)`, [OPS_DEPT])), 'row-level security') === true, 'admin OPS không tự cấp quyền')
  await as(db, U.super, () => db.query(`INSERT INTO public.care_access (department_id, can_view_all) VALUES ($1, true)`, [OPS_DEPT]))
  ok((await visibleExt(U.ops)).length === 8, 'super cấp can_view_all cho OPS ⇒ OPS thấy CRM (cấu hình, không gắn cứng)')
  await db.query(`DELETE FROM public.care_access WHERE department_id = $1`, [OPS_DEPT])
  const acc = await as(db, U.mkt, async () => (await db.query(`SELECT public.care_my_access() a`)).rows[0].a)
  ok(acc.can_import && acc.can_view_all && !acc.is_super && acc.role === 'admin', 'care_my_access Marketing', JSON.stringify(acc))

  // Ghi lượt qua RPC public thật (giờ VN thật) của A trên H, rồi chuyển H từ A sang B.
  const tH = await taskOf(db, 'QA-H', PC)
  r = await as(db, U.A, async () => (await db.query(`SELECT public.care_record_interaction($1, 'UNREACHABLE', 'A gọi', $2::date, NULL) r`, [tH.id, (await one(db, `SELECT public.care_period_last_day($1::date)::text d`, [PC])).d])).rows[0].r)
  ok(r.status === 'open', 'RPC public care_record_interaction chạy dưới authenticated')
  r = await as(db, U.sm, async () => (await db.query(`SELECT public.care_transfer_tasks($1::uuid[], $2, 'QA SM chuyển A→B') r`, [[tH.id], U.B])).rows[0].r)
  ok(r.transferred === 1, 'RPC public care_transfer_tasks (SM) chạy dưới authenticated')
  const afterA = await visibleExt(U.A)
  ok(!afterA.includes(`QA-H@${cur}`) && afterA.includes(`QA-OLDA@${prev}`), 'sau chuyển A→B: A mất task H kỳ này, vẫn thấy task kỳ cũ của mình')
  ok(await histOf(U.A) === 0, 'A mất cả lượt của task đã chuyển và lịch sử khách H')
  ok(await as(db, U.A, () => count(db, `SELECT count(*) FROM public.care_task_products p WHERE p.task_id = $1`, [tH.id])) === 0, 'A không đọc sản phẩm task đã chuyển')
  ok(await histOf(U.B) === 2, 'B thấy lượt của A + lượt kỳ trước của H')
  ok(await as(db, U.B, () => count(db, `SELECT count(*) FROM public.care_assignment_events WHERE task_id = $1`, [tH.id])) === 2, 'B thấy sự kiện assigned + transferred')
}

section('BÁO CÁO = đếm qua session client; không nhân đôi; loại is_test')
{
  // Attribution fixture (B5 mới ghi thật): H có 3 sản phẩm, 2 đơn COMPLETED ⇒ vẫn 1 task Có đơn (Q-91).
  const tH = await taskOf(db, 'QA-H', PC), tB1 = await taskOf(db, 'QA-B1', PC), tT1 = await taskOf(db, 'QA-T1', PC)
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [U.B])
  const iH = (await db.query(`SELECT public.care__record_interaction_at($1, $2, 'ORDERED', 'B chốt', NULL, NULL) r`, [TODAY, tH.id])).rows[0].r.interaction_id
  await setUid(db, null)
  await db.query(`INSERT INTO public.care_orders (order_key, customer_external_id, ordered_at) VALUES
    ('QA-O1','QA-H', now()), ('QA-O2','QA-H', now()), ('QA-O3','QA-T1', now())`)
  await db.query(`INSERT INTO public.care_order_attributions (order_key, interaction_id, task_id, customer_id, assignee_id, store_id, period_month, is_test) VALUES
    ('QA-O1', $1, $2, $3, $4, $5, $6, false), ('QA-O2', $1, $2, $3, $4, $5, $6, false)`, [iH, tH.id, tH.customer_id, U.B, storeId(1), PC])
  await setUid(db, U.A)
  const iT = (await db.query(`SELECT public.care__record_interaction_at($1, $2, 'NO_NEED', 'test', NULL, NULL) r`, [TODAY, tT1.id])).rows[0].r.interaction_id
  await setUid(db, null)
  await db.query(`INSERT INTO public.care_order_attributions (order_key, interaction_id, task_id, customer_id, assignee_id, store_id, period_month, is_test) VALUES ('QA-O3', $1, $2, $3, $4, $5, $6, true)`, [iT, tT1.id, tT1.customer_id, U.A, storeId(1), PC])
  ok(tB1, 'fixture báo cáo sẵn sàng')

  for (const [name, who] of [['staff A', U.A], ['staff B', U.B], ['QLCH', U.qlch1], ['SM', U.sm], ['SM2', U.sm2], ['Marketing', U.mkt], ['super', U.super], ['OPS', U.ops], ['FS', U.qlchFs]]) {
    const rep = await as(db, who, async () => (await db.query(`SELECT * FROM public.care_report($1::date)`, [PC])).rows)
    const direct = await as(db, who, async () => (await db.query(`SELECT store_id, assignee_id, count(*)::int n FROM public.care_tasks WHERE period_month = $1 AND NOT is_test GROUP BY 1, 2`, [PC])).rows)
    const key = (x) => `${x.store_id}|${x.assignee_id}`
    const dm = new Map(direct.map((x) => [key(x), x.n]))
    const same = rep.filter((x) => x.tasks_total > 0).length === direct.length && rep.every((x) => (dm.get(key(x)) ?? 0) === x.tasks_total)
    ok(same, `${name}: care_report tasks = đếm qua session client (${direct.reduce((s, x) => s + x.n, 0)} task)`, JSON.stringify({ rep, direct }))
  }
  const repAll = await as(db, U.mkt, async () => (await db.query(`SELECT * FROM public.care_report($1::date)`, [PC])).rows)
  const bRow = repAll.find((x) => x.assignee_id === U.B && x.store_id === storeId(1))
  ok(bRow && bRow.converted_tasks === 1 && bRow.completed === 1, 'B: 2 đơn cùng task ⇒ 1 task Có đơn — khách 3 sản phẩm không nhân đôi', JSON.stringify(bRow))
  ok(repAll.every((x) => !('orders' in x) && !('net_revenue' in x)) && Object.keys(repAll[0] ?? {}).at(-1) === 'converted_tasks',
     'care_report GĐ1 không trả số đơn/tiền (Q-91) — cột cuối converted_tasks', JSON.stringify(Object.keys(repAll[0] ?? {})))
  ok(repAll.reduce((s, x) => s + x.converted_tasks, 0) === 1, 'task fixture is_test Có đơn bị loại khỏi báo cáo')
  const repTest = await as(db, U.super, async () => (await db.query(`SELECT sum(converted_tasks)::int o FROM public.care_report($1::date, NULL, true)`, [PC])).rows[0].o)
  const repTestMkt = await as(db, U.mkt, async () => (await db.query(`SELECT sum(converted_tasks)::int o FROM public.care_report($1::date, NULL, true)`, [PC])).rows[0].o)
  ok(repTest === 2 && repTestMkt === 1, 'p_include_test chỉ có tác dụng với super')
  const repA = await as(db, U.A, async () => (await db.query(`SELECT * FROM public.care_report($1::date)`, [PC])).rows)
  ok(repA.every((x) => x.assignee_id === U.A) && repA.every((x) => x.converted_tasks === 0), 'staff A chỉ thấy dòng của mình, không thấy task Có đơn của B')
  const repSm2 = await as(db, U.sm2, async () => (await db.query(`SELECT * FROM public.care_report($1::date, $2::uuid[])`, [PC, [storeId(2)]])).rows)
  ok(repSm2.length === 0, 'p_store_ids ngoài scope không nới quyền (SM2 lọc QAOS02 ⇒ rỗng)')
  const mid = PC.slice(0, 8) + '15'
  const repMid = await as(db, U.mkt, async () => (await db.query(`SELECT sum(tasks_total)::int n FROM public.care_report($1::date)`, [mid])).rows[0].n)
  ok(repMid === repAll.reduce((a, x) => a + x.tasks_total, 0) && repMid > 0, 'care_report nhận ngày giữa tháng ⇒ chuẩn hoá về kỳ (không rỗng âm thầm)')
  ok(await raises(as(db, U.B, () => db.query(`SELECT count(*) FROM public.care_orders`)), 'permission denied') === true
     && await raises(as(db, U.B, () => db.query(`SELECT count(*) FROM public.care_order_attributions`)), 'permission denied') === true
     && (await as(db, U.B, async () => (await db.query(`SELECT sum(converted_tasks)::int n FROM public.care_report($1::date)`, [PC])).rows[0].n)) === 1,
     'B: không đọc care_orders (Q-101)/attribution (Q-95) thẳng; Có đơn của mình chỉ qua care_report (1 task)')
  const sum = await as(db, U.A, async () => (await db.query(`SELECT * FROM public.care_my_summary()`)).rows[0])
  // A đang có QA-A2 (thật, chưa chăm sóc) + QA-T1 (fixture is_test, đã Hoàn thành); H đã chuyển cho B.
  ok(sum.assigned === 1 && sum.completed === 0 && sum.not_cared === 1, 'care_my_summary staff A chỉ đếm task thật — loại fixture is_test (audit PM B1 P1)', JSON.stringify(sum))
  ok(await as(db, U.A, () => count(db, `SELECT count(*) FROM public.care_tasks WHERE is_test AND period_month = $1`, [PC])) === 1, 'fixture is_test vẫn tồn tại (RLS) nhưng không vào thẻ')
  ok(await as(db, null, async () => (await db.query(`SELECT public.care_stamp_overdue() s, public.care_close_period() c`)).rows[0].c, 'service_role') === 0, 'service_role gọi được care_stamp_overdue/care_close_period (giờ VN thật)')
}
await db.close()

// ════════════════════════════════════════════════════════════════════════════
section('Q-82/Q-83 — STAFF ĐỔI STORE A→B MÀ TASK CÒN Ở A · GHI CHÚ CHUYỂN GIAO (kỳ hiện tại thật)')
db = await freshDb()
{
  const PCx = (await one(db, `SELECT public.care_period_of(public.care_vn_today())::text p`)).p
  const DUE = (await one(db, `SELECT public.care_period_last_day($1::date)::text d`, [PCx])).d
  const bq = await stage(db, [row('QA-M1', 'QAOS01', EA, 'P1'), row('QA-M1', 'QAOS01', EA, 'P2'), row('QA-M2', 'QAOS01', EA, 'P1'), row('QA-M3', 'QAOS01', EB, 'P1')], { period: PCx })
  r = await as(db, null, async () => (await db.query(`SELECT public.care_import_finalize($1, $2) r`, [bq, U.mkt])).rows[0].r, 'service_role')
  ok(r.status === 'committed' && r.created === 3, 'fixture: M1 (2 sản phẩm), M2 giao A; M3 giao B — đều QAOS01', JSON.stringify(r))
  const m1 = await taskOf(db, 'QA-M1', PCx), m2 = await taskOf(db, 'QA-M2', PCx), m3 = await taskOf(db, 'QA-M3', PCx)
  const ids = [m1.id, m2.id, m3.id], custs = [m1.customer_id, m2.customer_id, m3.customer_id]
  r = await as(db, U.A, async () => (await db.query(`SELECT public.care_record_interaction($1, 'CALLBACK', 'A gọi M1', $2::date, NULL) r`, [m1.id, DUE])).rows[0].r)
  ok(r.status === 'open', 'A ghi lượt M1 khi còn ở QAOS01 (RPC public)')
  const NOTE = 'QA ghi chú SM: khách hẹn gọi buổi chiều'
  r = await as(db, U.sm, async () => (await db.query(`SELECT public.care_transfer_tasks($1::uuid[], $2, $3) r`, [[m3.id], U.A, NOTE])).rows[0].r)
  ok(r.transferred === 1, 'SM chuyển M3 từ B sang A kèm ghi chú')

  // Đọc trực tiếp các bảng dưới session (RLS) + helper/RPC đọc.
  const view = (who) => as(db, who, async () => ({
    tasks: await count(db, `SELECT count(*) FROM public.care_tasks WHERE id = ANY ($1::uuid[])`, [ids]),
    inter: await count(db, `SELECT count(*) FROM public.care_interactions WHERE task_id = ANY ($1::uuid[])`, [ids]),
    events: await count(db, `SELECT count(*) FROM public.care_assignment_events WHERE task_id = ANY ($1::uuid[])`, [ids]),
    prods: await count(db, `SELECT count(*) FROM public.care_task_products WHERE task_id = ANY ($1::uuid[])`, [ids]),
    cust: await count(db, `SELECT count(*) FROM public.care_customers WHERE id = ANY ($1::uuid[])`, [custs]),
    notes: (await db.query(`SELECT note FROM public.care_assignment_events WHERE task_id = $1 AND kind = 'transferred' ORDER BY id`, [m3.id])).rows.map((x) => x.note),
    sum: (await db.query(`SELECT * FROM public.care_my_summary()`)).rows[0].assigned,
    rep: (await db.query(`SELECT COALESCE(sum(tasks_total), 0)::int n FROM public.care_report($1::date)`, [PCx])).rows[0].n,
    canRead: (await db.query(`SELECT public.care_can_read_task($1) c`, [m1.id])).rows[0].c,
  }))
  let vA = await view(U.A)
  ok(vA.tasks === 3 && vA.inter === 1 && vA.events === 4 && vA.prods === 4 && vA.cust === 3 && vA.sum === 3 && vA.rep === 3 && vA.canRead === true,
     'đối chứng: A ở đúng store đọc đủ 3 task / lượt / event / sản phẩm / khách / summary / report', JSON.stringify(vA))
  ok(JSON.stringify(vA.notes) === JSON.stringify([NOTE]), 'Q-83: staff ĐANG phụ trách (A) thấy ghi chú chuyển giao của SM', JSON.stringify(vA.notes))
  const vB = await view(U.B)
  ok(vB.notes.length === 0 && await as(db, U.B, () => count(db, `SELECT count(*) FROM public.care_tasks WHERE id = $1`, [m3.id])) === 0
     && await as(db, U.B, () => count(db, `SELECT count(*) FROM public.care_assignment_events WHERE task_id = $1`, [m3.id])) === 0,
     'Q-83: staff CŨ (B) sau chuyển giao không đọc được task M3 và ghi chú', JSON.stringify(vB))

  // A chuyển sang QAOS02 (OS đang hoạt động) — task vẫn ở QAOS01.
  await db.query(`UPDATE public.users SET store_id = $1 WHERE id = $2`, [storeId(2), U.A])
  vA = await view(U.A)
  ok(vA.tasks === 0 && vA.inter === 0 && vA.events === 0 && vA.prods === 0 && vA.cust === 0 && vA.notes.length === 0 && vA.sum === 0 && vA.rep === 0 && vA.canRead === false,
     'Q-82: A sang QAOS02 ⇒ 0 dòng ở care_tasks / care_interactions / care_assignment_events / sản phẩm / khách; summary + report 0', JSON.stringify(vA))
  ok(await raises(as(db, U.A, () => db.query(`SELECT public.care_record_interaction($1, 'CALLBACK', 'A sau chuyển', $2::date, NULL)`, [m1.id, DUE])), 'chỉ dược sĩ được giao') === true,
     'Q-82: RPC public ghi lượt task còn ở QAOS01 ⇒ từ chối (NOT_ASSIGNEE)')
  // GIỚI HẠN: createUploadUrl (server action Next + GCS) không chạy được ở đây — chỉ chứng minh truy vấn
  // session nó dùng (SELECT care_tasks qua RLS) trả 0 dòng ⇒ gate careStaffTaskBlock = TASK_NOT_FOUND
  // (unit + source ở e2e/care-my-core.spec.ts). Kiểm tay đầu-cuối ở B6.
  ok(await as(db, U.A, () => count(db, `SELECT count(*) FROM public.care_tasks WHERE id = $1`, [m2.id])) === 0,
     'Q-82: truy vấn session của createUploadUrl (care_proof) không thấy task cũ ⇒ gate từ chối (gián tiếp)')
  const vSm = await view(U.sm), vSup = await view(U.super)
  ok(vSm.tasks === 3 && vSm.inter === 1 && vSup.tasks === 3, 'SM/super không bị ảnh hưởng (vẫn thấy đủ để chuyển giao)', JSON.stringify({ vSm, vSup }))
  // VERIFY 17 chạy NGUYÊN VĂN từ file 114 (bỏ tiền tố comment).
  const MIG_LINES = MIGRATION.replace(/\r\n/g, '\n').split('\n')
  const verbatim = (startsWith, endsWith) => {
    const i = MIG_LINES.findIndex((l) => l.startsWith(startsWith))
    const j = MIG_LINES.findIndex((l, k) => k >= i && l.includes(endsWith))
    return i < 0 || j < 0 ? null : MIG_LINES.slice(i, j + 1).map((l) => l.replace(/^--\s{4}/, '')).join('\n')
  }
  const v17a = verbatim("--    SELECT position('care_staff_store_id'", 'AS svc_x;')
  const v17b = verbatim('--    SELECT t.store_id, t.assignee_id, u.store_id AS user_store', 'GROUP BY 1, 2, 3;')
  const a17 = v17a && (await db.query(v17a)).rows[0]
  ok(a17 && a17.rpc_q82 === true && a17.policy_q82 === true && Number(a17.n_fn) === 41 && a17.anon_x === false && a17.auth_x === true && a17.svc_x === true,
     'VERIFY 17 (nguyên văn): đúng bản r1.1 — t, t, 41, f, t, t', JSON.stringify(a17))
  const b17 = v17b ? (await db.query(v17b)).rows : null
  ok(b17 && b17.length === 1 && b17[0].assignee_id === U.A && b17[0].user_store === storeId(2) && Number(b17[0].count) === 3,
     'VERIFY 17 giám sát (nguyên văn) bắt đúng 3 task mở của A lệch store', JSON.stringify(b17))
  // Nhánh NULL / FS / store ngừng của care_staff_store_id() — fail-closed cả phía ĐỌC.
  for (const [why, sql, params] of [
    ['tháo store (store_id NULL)', `UPDATE public.users SET store_id = NULL WHERE id = $1`, [U.A]],
    ['chuyển sang store FS', `UPDATE public.users SET store_id = $1 WHERE id = $2`, [S_FS, U.A]],
  ]) {
    await db.query(sql, params)
    const v = await view(U.A)
    ok(v.tasks === 0 && v.inter === 0 && v.events === 0 && v.cust === 0 && v.sum === 0 && v.rep === 0, `Q-82 đọc: A ${why} ⇒ 0 dòng / summary 0`, JSON.stringify(v))
  }
  await db.query(`UPDATE public.users SET store_id = $1 WHERE id = $2`, [storeId(1), U.A])
  await db.query(`UPDATE public.stores SET is_active = false WHERE id = $1`, [storeId(1)])
  const vOff = await view(U.A)
  ok(vOff.tasks === 0 && vOff.inter === 0 && vOff.sum === 0, 'Q-82 đọc: store của A (= store task) ngừng hoạt động ⇒ A mất cả quyền đọc (PM xác nhận — báo cáo)', JSON.stringify(vOff))
  await db.query(`UPDATE public.stores SET is_active = true WHERE id = $1`, [storeId(1)])

  // Về lại đúng store ⇒ quyền theo store, không mất vĩnh viễn.
  ok((await view(U.A)).tasks === 3, 'A về lại QAOS01 (store hoạt động lại) ⇒ đọc lại task của mình')
  await db.query(`UPDATE public.users SET store_id = $1 WHERE id = $2`, [storeId(2), U.A])

  // SM/super chuyển giao thủ công (Q-80) ⇒ quyền theo task mới.
  r = await as(db, U.sm, async () => (await db.query(`SELECT public.care_transfer_tasks($1::uuid[], $2, 'QA chuyển M1 cho B') r`, [[m1.id], U.B])).rows[0].r)
  ok(r.transferred === 1, 'SM chuyển M1 (QAOS01) sang B cùng store')
  r = await as(db, U.super, async () => (await db.query(`SELECT public.care_transfer_tasks($1::uuid[], $2, 'QA chuyển M2 cho C') r`, [[m2.id], U.C])).rows[0].r)
  ok(r.transferred === 1 && (await one(db, `SELECT store_id FROM public.care_tasks WHERE id = $1`, [m2.id])).store_id === storeId(2), 'super chuyển M2 sang C (QAOS02) ⇒ task đổi store')
  // Q-86 (chốt 08/10): không chuyển task cho CHÍNH assignee hiện tại dù họ đã đổi store — SM phân công lại thủ công.
  ok(await raises(as(db, U.super, () => db.query(`SELECT public.care_transfer_tasks($1::uuid[], $2, 'QA giữ A ở store mới')`, [[m3.id], U.A])), 'đã thuộc dược sĩ đích') === true,
     'chuyển M3 cho chính A (đã sang QAOS02) ⇒ từ chối "đã thuộc dược sĩ đích" (Q-86)')
  r = await as(db, U.super, async () => (await db.query(`SELECT public.care_transfer_tasks($1::uuid[], $2, 'QA chuyển M3 cho D') r`, [[m3.id], U.D])).rows[0].r)
  ok(r.transferred === 1, 'super chuyển M3 sang D (QAOS02)')
  const seeB = await as(db, U.B, async () => ({
    t: await count(db, `SELECT count(*) FROM public.care_tasks WHERE id = $1`, [m1.id]),
    i: (await db.query(`SELECT note FROM public.care_interactions WHERE task_id = $1`, [m1.id])).rows.map((x) => x.note),
  }))
  ok(seeB.t === 1 && JSON.stringify(seeB.i) === JSON.stringify(['A gọi M1']), 'B (assignee mới, đúng store) thấy M1 + lượt A đã ghi', JSON.stringify(seeB))
  ok(await as(db, U.C, () => count(db, `SELECT count(*) FROM public.care_tasks WHERE id = $1`, [m2.id])) === 1, 'C (QAOS02) thấy M2 sau chuyển giao')
  const dNotes = await as(db, U.D, async () => (await db.query(`SELECT note FROM public.care_assignment_events WHERE task_id = $1 AND kind = 'transferred' ORDER BY id`, [m3.id])).rows.map((x) => x.note))
  ok(dNotes.includes(NOTE) && dNotes.includes('QA chuyển M3 cho D'), 'Q-83: D (đang phụ trách M3) thấy cả ghi chú chuyển giao trước đó', JSON.stringify(dNotes))
  ok((await view(U.A)).tasks === 0, 'A (đã sang QAOS02) vẫn không thấy task nào trong 3 task (đều đã chuyển đi)')
  r = await as(db, U.B, async () => (await db.query(`SELECT public.care_record_interaction($1, 'INTERESTED', 'B chốt M1', NULL, NULL) r`, [m1.id])).rows[0].r)
  ok(r.status === 'completed', 'B ghi lượt M1 sau chuyển giao')
  r = await as(db, U.C, async () => (await db.query(`SELECT public.care_record_interaction($1, 'CALLBACK', 'C gọi M2', $2::date, NULL) r`, [m2.id, DUE])).rows[0].r)
  ok(r.status === 'open', 'C ghi lượt M2 ở store mới QAOS02')
}
await db.close()

// ════════════════════════════════════════════════════════════════════════════
// B5a r1.1 (Q-91/Q-93): N3 ba cột — mỗi dòng care_orders là một đơn COMPLETED (BI đã lọc status),
// ordered_at = completed_at. Chỉ đo task "Có đơn" (COUNT DISTINCT task), không số đơn/tiền.
section('B5a r1.1 — ATTRIBUTION (care_recompute_attribution) + BÁO CÁO CÓ ĐƠN + TRẠNG THÁI ĐƠN')
db = await freshDb()
{
  const P09 = '2026-09-01', P10 = '2026-10-01'
  // Lượt tạo bằng INSERT trực tiếp (superuser) để GHIM created_at — RPC ghi lượt dùng now().
  const addInteraction = async (taskId, at, terminal = true, outcome = null) => (await one(db, `
    INSERT INTO public.care_interactions (task_id, customer_id, actor_id, assignee_id, store_id, period_month, outcome, is_terminal, note, is_test, created_at)
    SELECT id, customer_id, assignee_id, assignee_id, store_id, period_month, $2, $3, 'QA B5a', is_test, $4::timestamptz
    FROM public.care_tasks WHERE id = $1 RETURNING id`, [taskId, outcome ?? (terminal ? 'INTERESTED' : 'CALLBACK'), terminal, at])).id
  const addOrder = (key, ext, at) => db.query(`INSERT INTO public.care_orders (order_key, customer_external_id, ordered_at) VALUES ($1,$2,$3)`, [key, ext, at])
  const recompute = (ext, keys = null) => as(db, null, async () => (await db.query(`SELECT public.care_recompute_attribution($1::text[], $2::text[]) r`, [ext, keys])).rows[0].r, 'service_role')
  const attr = (key) => one(db, `SELECT a.*, a.period_month::text p FROM public.care_order_attributions a WHERE order_key = $1`, [key])
  const attrCount = () => count(db, `SELECT count(*) FROM public.care_order_attributions`)

  // Kỳ 09: K1, K2, K3 giao A (QAOS01). Kỳ 10 (đóng kỳ 09): K1 → C (QAOS02), K2 → B (QAOS01), K3 → A, K4 → D (QAOS02); KT is_test → A.
  r = await finalize(db, await stage(db, [row('QA-K1', 'QAOS01', EA, 'P1'), row('QA-K2', 'QAOS01', EA, 'P1'), row('QA-K3', 'QAOS01', EA, 'P1')], { period: P09 }), U.mkt, '2026-09-02')
  ok(r.status === 'committed', 'fixture kỳ 09 (K1, K2, K3 → A @QAOS01)', JSON.stringify(r))
  r = await finalize(db, await stage(db, [row('QA-K1', 'QAOS02', EC, 'P1'), row('QA-K2', 'QAOS01', EB, 'P1'), row('QA-K3', 'QAOS01', EA, 'P1'), row('QA-K4', 'QAOS02', ED, 'P1')], { period: P10 }), U.mkt, '2026-10-01')
  ok(r.status === 'committed', 'fixture kỳ 10 (K1 → C @QAOS02, K2 → B, K3 → A, K4 → D)', JSON.stringify(r))
  r = await finalize(db, await stage(db, [row('QA-KT', 'QAOS01', EA, 'P1')], { period: P10, isTest: true }), U.mkt, '2026-10-01')
  ok(r.status === 'committed', 'fixture is_test kỳ 10 (KT → A)')
  const T = {}
  for (const [k, ext, p] of [['T1', 'QA-K1', P09], ['T2', 'QA-K1', P10], ['T3', 'QA-K2', P09], ['T4', 'QA-K2', P10], ['T5', 'QA-K3', P09], ['T6', 'QA-K3', P10], ['T7', 'QA-KT', P10], ['T8', 'QA-K4', P10]]) T[k] = (await taskOf(db, ext, p)).id
  // Chuyển giao T4 (K2 kỳ 10) B → C (QAOS02) TRƯỚC lượt kết thúc của C.
  await transfer(db, '2026-10-03', U.sm, [T.T4], U.C, 'QA B5a chuyển K2')
  const L1 = await addInteraction(T.T1, '2026-09-10T03:00:00Z')        // K1 kỳ 09 · A @QAOS01
  const L2 = await addInteraction(T.T2, '2026-10-05T03:00:00Z')        // K1 kỳ 10 · C @QAOS02
  const L3 = await addInteraction(T.T3, '2026-09-15T03:00:00Z')        // K2 kỳ 09 · A @QAOS01
  await addInteraction(T.T4, '2026-10-08T03:00:00Z', false)            // K2 kỳ 10 · lượt KHÔNG kết thúc ⇒ không ghi công
  const L4 = await addInteraction(T.T4, '2026-10-12T03:00:00Z')        // K2 kỳ 10 · C @QAOS02 (sau chuyển giao)
  const L5a = await addInteraction(T.T5, '2026-10-02T00:00:00Z')       // K3: hai lượt kết thúc TRÙNG giờ
  const L5b = await addInteraction(T.T6, '2026-10-02T00:00:00Z')       //     ⇒ chọn id lớn hơn (L5b)
  const L6 = await addInteraction(T.T7, '2026-10-03T00:00:00Z')        // KT is_test
  ok(L5b > L5a, 'fixture: L5b có id lớn hơn L5a cùng created_at')
  ok(await raises(addInteraction(T.T1, '2026-09-21T00:00:00Z'), 'care_interactions_one_terminal_per_task') === true,
     'unique index chặn lượt terminal thứ hai cùng task ⇒ một task chỉ một snapshot ghi công (báo cáo không nhân đôi)')
  // Khoá đơn mô phỏng order_order.code (DHC, duy nhất POS + online — Q-92); N3 không có cột kênh.
  await addOrder('QA-O1', 'QA-K1', '2026-09-01T00:00:00Z')   // completed TRƯỚC mọi lượt ⇒ không ghi công
  await addOrder('QA-O2', 'QA-K1', '2026-09-10T03:00:00Z')   // completed BẰNG giờ L1 ⇒ không ghi công (strict <)
  await addOrder('QA-O3', 'QA-K1', '2026-09-20T00:00:00Z')   // POS, sau L1 ⇒ L1
  await addOrder('QA-O4', 'QA-K1', '2026-09-25T00:00:00Z')   // online, sau L1 ⇒ L1 (2 đơn cùng task T1)
  await addOrder('QA-O5', 'QA-K1', '2026-10-06T00:00:00Z')   // ⇒ L2 (tháng thứ hai — chỉ về lượt gần nhất)
  await addOrder('QA-O6', 'QA-K2', '2026-10-10T00:00:00Z')   // ⇒ L3 (owner task hiện tại là C — KHÔNG dùng)
  await addOrder('QA-O7', 'QA-K2', '2026-10-15T00:00:00Z')   // ⇒ L4 (C sau chuyển giao)
  await addOrder('QA-O8', 'QA-K3', '2026-10-03T00:00:00Z')   // ⇒ L5b (hoà ⇒ id lớn hơn)
  await addOrder('QA-O9', 'QA-KT', '2026-10-04T00:00:00Z')   // ⇒ L6, is_test
  await addOrder('QA-O10', 'QA-NOPE', '2026-10-04T00:00:00Z') // khách không có trong N1 ⇒ không ghi công
  await addOrder('QA-O12', 'QA-K4', '2026-10-20T00:00:00Z')  // K4 chưa có lượt kết thúc

  const ALL = ['QA-K1', 'QA-K2', 'QA-K3', 'QA-KT', 'QA-NOPE', 'QA-K4']
  r = await recompute(ALL)
  ok(r.scope === 11 && r.upserted === 7 && r.deleted === 0, 'lần tính đầu: 11 đơn trong phạm vi, 7 attribution, 0 xoá', JSON.stringify(r))
  for (const k of ['QA-O1', 'QA-O2', 'QA-O10', 'QA-O12']) ok(!(await attr(k)), `${k}: không có attribution (trước/bằng lượt, khách lạ, chưa có lượt kết thúc)`)
  let a = await attr('QA-O3')
  ok(a && Number(a.interaction_id) === Number(L1) && a.task_id === T.T1 && a.assignee_id === U.A && a.store_id === storeId(1) && a.p === P09,
     'O3 (completed sau lượt) ⇒ L1: snapshot A @QAOS01 kỳ 09', JSON.stringify(a))
  a = await attr('QA-O4')
  ok(a && Number(a.interaction_id) === Number(L1) && a.task_id === T.T1, 'O4 (đơn online) ⇒ cũng L1 — 2 đơn cùng task T1', JSON.stringify(a))
  a = await attr('QA-O5')
  ok(a && Number(a.interaction_id) === Number(L2) && a.assignee_id === U.C && a.store_id === storeId(2) && a.p === P10, 'O5 ⇒ L2: tháng/store/dược sĩ thứ hai của cùng khách (C @QAOS02 kỳ 10)', JSON.stringify(a))
  a = await attr('QA-O6')
  ok(a && Number(a.interaction_id) === Number(L3) && a.assignee_id === U.A && a.store_id === storeId(1) && a.p === P09,
     'O6 ⇒ L3 (A @QAOS01 kỳ 09) dù task kỳ 10 của khách đang thuộc C — snapshot LƯỢT, lượt không kết thúc bị bỏ qua', JSON.stringify(a))
  a = await attr('QA-O7')
  ok(a && Number(a.interaction_id) === Number(L4) && a.assignee_id === U.C && a.store_id === storeId(2), 'O7 ⇒ L4 (C @QAOS02, lượt sau chuyển giao)', JSON.stringify(a))
  a = await attr('QA-O8')
  ok(a && Number(a.interaction_id) === Number(L5b), 'O8 ⇒ L5b: hai lượt trùng giờ ⇒ id lớn hơn', JSON.stringify(a))
  a = await attr('QA-O9')
  ok(a && Number(a.interaction_id) === Number(L6) && a.is_test === true, 'O9 ⇒ L6, attribution is_test theo lượt', JSON.stringify(a))

  r = await recompute(ALL)
  ok(r.scope === 11 && r.upserted === 0 && r.deleted === 0 && await attrCount() === 7, 'chạy lại cùng dữ liệu ⇒ 0 thay đổi (idempotent)', JSON.stringify(r))
  r = await recompute(null, ['QA-O3', 'QA-O3', '', null])
  ok(r.scope === 1 && r.upserted === 0, 'phạm vi theo order_key (khử trùng/bỏ rỗng)', JSON.stringify(r))

  // Báo cáo = COUNT(DISTINCT task) attribution theo tháng của LƯỢT; nhiều đơn/task không nhân task; is_test bị loại.
  const rep = async (who, month, test = false) => (await as(db, who, async () => (await db.query(`SELECT * FROM public.care_report($1::date, NULL, $2)`, [month, test])).rows))
  const rowOf = (rows, store, assignee) => rows.find((x) => x.store_id === store && x.assignee_id === assignee)
  const conv = (rows) => rows.reduce((s, y) => s + y.converted_tasks, 0)
  let r09 = await rep(U.super, P09), r10 = await rep(U.super, P10)
  let x = rowOf(r09, storeId(1), U.A)
  ok(x && x.converted_tasks === 2 && await count(db, `SELECT count(*) FROM public.care_order_attributions WHERE period_month = $1`, [P09]) === 3,
     'care_report kỳ 09 (QAOS01·A): 3 đơn gán (O3, O4 cùng T1; O6 về T3) ⇒ 2 task Có đơn — đơn tháng 10 vẫn về kỳ chăm sóc 09 (Q-59)', JSON.stringify(x))
  ok(r09.concat(r10).every((y) => !('orders' in y) && !('net_revenue' in y)), 'care_report không trả số đơn / tiền (Q-91)')
  x = rowOf(r10, storeId(2), U.C)
  ok(x && x.converted_tasks === 2, 'care_report kỳ 10 (QAOS02·C): 2 task Có đơn (T2, T4)', JSON.stringify(x))
  x = rowOf(r10, storeId(1), U.A)
  ok(x && x.converted_tasks === 1, 'care_report kỳ 10 (QAOS01·A): 1 task (T6) — fixture is_test KT không lọt', JSON.stringify(x))
  ok(conv(r10) === 3 && conv(await rep(U.super, P10, true)) === 4, 'is_test chỉ hiện khi super bật p_include_test (3 → 4 task)')

  // RLS: đơn thô chỉ care admin/super. Q-95: KHÔNG ai đọc thẳng attribution; số Có đơn theo phạm vi
  // (staff: task mình đúng store; SM: store snapshot Q-79; QLCH 0) chỉ qua care_report DEFINER.
  // Q-101: đơn thô KHÔNG ai đọc qua API bảng, kể cả super/care admin; service_role (đồng bộ) vẫn thấy đủ.
  for (const [name, who] of [['super', U.super], ['Marketing', U.mkt], ['SM', U.sm], ['staff A', U.A], ['QLCH', U.qlch1]]) {
    ok(await raises(as(db, who, () => db.query(`SELECT count(*) FROM public.care_orders`)), 'permission denied') === true, `${name}: SELECT care_orders bị từ chối (Q-101)`)
  }
  ok(await as(db, null, () => count(db, `SELECT count(*) FROM public.care_orders`), 'service_role') === 11, 'service_role đọc đủ 11 đơn (đường đồng bộ)')
  for (const [name, who] of [['staff A', U.A], ['staff C', U.C], ['SM', U.sm], ['SM2', U.sm2], ['QLCH', U.qlch1], ['Marketing', U.mkt], ['super', U.super]]) {
    ok(await raises(as(db, who, () => db.query(`SELECT order_key FROM public.care_order_attributions`)), 'permission denied') === true,
       `${name}: SELECT thẳng care_order_attributions bị từ chối (Q-95)`)
  }
  const convOf = async (who) => [await rep(who, P09), await rep(who, P10)].map(conv)
  // Kỳ vọng (đã loại is_test KT): A @QAOS01: T1+T3 (09), T6 (10) · C @QAOS02: T2+T4 (10) · B: 0 ·
  // SM (01+02): 2 + 3 · SM2 (01): 2 + 1 · Marketing/super: 2 + 3 · QLCH: 0.
  const expected = [['staff A', U.A, [2, 1]], ['staff C', U.C, [0, 2]], ['staff B', U.B, [0, 0]], ['SM', U.sm, [2, 3]],
    ['SM2', U.sm2, [2, 1]], ['Marketing', U.mkt, [2, 3]], ['super', U.super, [2, 3]], ['QLCH', U.qlch1, [0, 0]]]
  for (const [name, who, want] of expected) {
    const got = await convOf(who)
    ok(JSON.stringify(got) === JSON.stringify(want), `${name}: Có đơn qua care_report kỳ 09/10 = ${want.join('/')} (scope + store snapshot, không is_test)`, JSON.stringify(got))
  }
  // Đối chiếu độc lập (superuser): SM2 = số task distinct có attribution ở QAOS01, không is_test.
  ok(await count(db, `SELECT count(DISTINCT task_id) FROM public.care_order_attributions WHERE store_id = $1 AND NOT is_test`, [storeId(1)]) === 3,
     'đối chứng superuser: QAOS01 có 3 task Có đơn (T1, T3, T6) = tổng SM2 qua care_report')
  ok(await raises(as(db, U.super, () => db.query(`SELECT public.care_recompute_attribution(ARRAY['QA-K1'], NULL)`)), 'permission denied') === true
     && await raises(as(db, U.A, () => db.query(`SELECT public.care_recompute_attribution(ARRAY['QA-K1'], NULL)`)), 'permission denied') === true,
     'authenticated (kể cả super) không gọi được care_recompute_attribution — chỉ service_role')
  ok(await raises(as(db, U.mkt, () => db.query(`INSERT INTO public.care_order_attributions SELECT * FROM public.care_order_attributions LIMIT 0`)), 'permission denied') === true
     && await raises(as(db, U.super, () => db.query(`INSERT INTO public.care_orders (order_key, customer_external_id, ordered_at) VALUES ('X','X',now())`)), 'permission denied') === true,
     'authenticated không ghi thẳng care_orders / attribution')

  // Nguồn đồng bộ lặp lại (cron chạy lại cùng lô) — upsert đơn idempotent + tính lại 0 thay đổi.
  await db.query(`INSERT INTO public.care_orders (order_key, customer_external_id, ordered_at) VALUES ('QA-O3','QA-K1','2026-09-20T00:00:00Z')
    ON CONFLICT (order_key) DO UPDATE SET customer_external_id = EXCLUDED.customer_external_id, ordered_at = EXCLUDED.ordered_at`)
  r = await recompute(['QA-K1'], ['QA-O3'])
  ok(r.upserted === 0 && r.deleted === 0 && (await attr('QA-O3')).task_id === T.T1, 'đồng bộ lặp cùng đơn ⇒ 0 thay đổi attribution', JSON.stringify(r))

  // Đơn đổi khách / đổi giờ ⇒ chuyển attribution, xoá attribution sai theo khoá.
  await db.query(`UPDATE public.care_orders SET customer_external_id = 'QA-K2' WHERE order_key = 'QA-O5'`)
  r = await recompute(['QA-K1', 'QA-K2'])
  a = await attr('QA-O5')
  ok(a && Number(a.interaction_id) === Number(L3) && a.assignee_id === U.A && a.p === P09, 'O5 đổi sang khách K2 ⇒ ghi công lại cho L3 (lượt kết thúc gần nhất TRƯỚC 06/10 của K2)', JSON.stringify({ r, a }))
  await db.query(`UPDATE public.care_orders SET ordered_at = '2026-09-01T00:00:00Z' WHERE order_key = 'QA-O5'`)
  r = await recompute(null, ['QA-O5'])
  ok(r.deleted === 1 && !(await attr('QA-O5')), 'O5 lùi giờ đặt trước mọi lượt của K2 ⇒ xoá attribution theo khoá', JSON.stringify(r))
  await db.query(`UPDATE public.care_orders SET customer_external_id = 'QA-NOPE', ordered_at = '2026-10-06T00:00:00Z' WHERE order_key = 'QA-O7'`)
  r = await recompute(['QA-K2'])
  ok(r.deleted === 1 && !(await attr('QA-O7')), 'O7 đổi sang khách lạ ⇒ tính lại PHÍA CŨ (gọi theo K2) cũng xoá attribution cũ', JSON.stringify(r))

  // Lượt hợp lệ xuất hiện muộn ⇒ lần tính sau ghi công. Lượt là REFUSED (Q-89 đã chốt: terminal, VẪN ghi công).
  ok(!(await attr('QA-O12')), 'K4: đơn 20/10 chưa có lượt kết thúc ⇒ chưa ghi công')
  const L7 = await addInteraction(T.T8, '2026-10-18T00:00:00Z', true, 'REFUSED')
  r = await recompute(['QA-K4'])
  a = await attr('QA-O12')
  ok(r.upserted === 1 && a && Number(a.interaction_id) === Number(L7) && a.assignee_id === U.D && a.store_id === storeId(2),
     'lượt REFUSED đến muộn (18/10) rồi khách có đơn 20/10 ⇒ VẪN ghi công cho D (Q-89)', JSON.stringify(a))
  ok(rowOf(await rep(U.super, P10), storeId(2), U.D)?.converted_tasks === 1, 'care_report: task REFUSED có đơn vẫn tính "Có đơn"')

  // Đầu vào sai ⇒ RAISE, không ghi gì (một câu lệnh ⇒ không có nửa batch).
  const before = await attrCount()
  ok(await raises(recompute(null, null), 'cần ít nhất') === true && await raises(recompute([], ['', null]), 'cần ít nhất') === true, 'không khách/đơn ⇒ từ chối')
  ok(await raises(recompute(Array.from({ length: 20001 }, (_, i) => `QA-X${i}`)), 'vượt giới hạn') === true, '> 20.000 khách một lần ⇒ từ chối')
  ok(await raises(recompute(null, Array.from({ length: 20001 }, (_, i) => `QA-Y${i}`)), 'vượt giới hạn') === true, '> 20.000 đơn một lần ⇒ từ chối')
  ok(await attrCount() === before, 'lệnh bị từ chối không đổi attribution')
  r = await recompute(Array.from({ length: 6000 }, (_, i) => `QA-Z${i}`))
  ok(r.scope === 0 && r.upserted === 0, 'lô 6.000 khách (≤ trần lô parser 20.000) chạy được — không kẹt như trần cũ 5.000 (db-reviewer P1-2)', JSON.stringify(r))

  // Đơn MỚI chỉ vào phạm vi qua order_key (hợp đồng B5b: luôn truyền khoá của lô) — db-reviewer P2-2 m1.
  await addOrder('QA-O13', 'QA-K3', '2026-10-21T00:00:00Z')
  r = await recompute(null, ['QA-O13'])
  a = await attr('QA-O13')
  ok(r.upserted === 1 && a && Number(a.interaction_id) === Number(L5b), 'đơn mới (đến BI muộn), gọi CHỈ theo order_key ⇒ vẫn ghi công (L5b)', JSON.stringify({ r, a }))
  // Chuyển giao THẬT (RPC) task T6 A @QAOS01 → C @QAOS02 SAU lượt ⇒ attribution vẫn theo snapshot LƯỢT.
  r = await transfer(db, '2026-10-22', U.sm, [T.T6], U.C, 'QA B5a chuyển K3 sau lượt')
  ok((await one(db, `SELECT assignee_id, store_id FROM public.care_tasks WHERE id = $1`, [T.T6])).assignee_id === U.C, 'fixture: T6 đã chuyển cho C @QAOS02', JSON.stringify(r))
  r = await recompute(['QA-K3'])
  a = await attr('QA-O13')
  ok(r.upserted === 0 && a.assignee_id === U.A && a.store_id === storeId(1) && (await attr('QA-O8')).assignee_id === U.A,
     'chuyển giao sau lượt ⇒ attribution giữ A @QAOS01 (snapshot lượt), không theo owner mới', JSON.stringify({ r, a }))
  r10 = await rep(U.super, P10)
  // C @QAOS02 giờ giữ T2, T4, T6 (task theo owner hiện tại) nhưng 0 Có đơn: O5/O7 đã chuyển đi ở bước trên.
  ok(rowOf(r10, storeId(1), U.A)?.converted_tasks === 1 && rowOf(r10, storeId(2), U.C)?.tasks_total === 3 && rowOf(r10, storeId(2), U.C)?.converted_tasks === 0,
     'care_report sau chuyển giao: task theo owner mới (C: 3 task) nhưng Có đơn của T6 vẫn tính cho A @QAOS01', JSON.stringify(r10))

  // DB là lớp chặn cuối cho dữ liệu đơn hỏng (parser B5a đã chặn trước) — db-reviewer P2-4.
  for (const [why, sql] of [
    ['ID khách có khoảng trắng', `INSERT INTO public.care_orders (order_key, customer_external_id, ordered_at) VALUES ('QA-WS',' QA-K1',now())`],
    ['order_key có khoảng trắng', `INSERT INTO public.care_orders (order_key, customer_external_id, ordered_at) VALUES ('QA-WS2 ','QA-K1',now())`],
    ['order_key rỗng', `INSERT INTO public.care_orders (order_key, customer_external_id, ordered_at) VALUES ('','QA-K1',now())`],
  ]) ok(await raises(db.query(sql), 'check') === true, `DB chặn đơn hỏng: ${why}`)
  ok(await raises(db.query(`INSERT INTO public.care_orders (order_key, customer_external_id, ordered_at) VALUES ('QA-NULLT','QA-K1',NULL)`), 'null') === true,
     'DB chặn đơn thiếu ordered_at (completed_at NOT NULL — Q-93)')

  // VERIFY 18d nguyên văn (attribution vs quy tắc): 0 thiếu / 0 thừa / 0 lệch.
  {
    const lines = MIGRATION.replace(/\r\n/g, '\n').split('\n')
    const i = lines.findIndex((l) => l.startsWith('--    WITH desired AS ('))
    const j = lines.findIndex((l, k) => k > i && l.includes('FROM desired d FULL JOIN public.care_order_attributions a'))
    const sql = i < 0 || j < 0 ? null : lines.slice(i, j + 1).map((l) => l.replace(/^--\s{4}/, '')).join('\n')
    const v = sql && (await db.query(sql)).rows[0]
    ok(v && Number(v.missing) === 0 && Number(v.extra) === 0 && Number(v.drift) === 0, 'VERIFY 18d (nguyên văn): attribution khớp quy tắc — 0 thiếu/thừa/lệch', JSON.stringify(v))
    await db.query(`UPDATE public.care_order_attributions SET assignee_id = $1 WHERE order_key = 'QA-O13'`, [U.C])
    const v2 = sql && (await db.query(sql)).rows[0]
    ok(v2 && Number(v2.drift) === 1, 'VERIFY 18d bắt được attribution lệch snapshot lượt', JSON.stringify(v2))
    r = await recompute(null, ['QA-O13'])
    const v3 = sql && (await db.query(sql)).rows[0]
    ok(r.upserted === 1 && v3 && Number(v3.drift) === 0 && (await attr('QA-O13')).assignee_id === U.A, 'tính lại sửa attribution lệch về snapshot lượt', JSON.stringify({ r, v3 }))
  }

  // Trạng thái dữ liệu đơn (care_order_sync_status): người xem báo cáo nhận 1 dòng, staff/QLCH 0 dòng.
  const st = (who) => as(db, who, async () => (await db.query(`SELECT has_synced, last_success_at, last_failed FROM public.care_order_sync_status()`)).rows)
  let s0 = await st(U.super)
  ok(s0.length === 1 && s0[0].has_synced === false && s0[0].last_success_at === null && s0[0].last_failed === false, 'trước đồng bộ: has_synced=false ⇒ UI "Chưa có dữ liệu đơn" (không giả 0)', JSON.stringify(s0))
  ok((await st(U.mkt)).length === 1 && (await st(U.sm)).length === 1 && (await st(U.A)).length === 0 && (await st(U.qlch1)).length === 0 && (await st(U.ops)).length === 0,
     'trạng thái đơn: super/care admin/SM có; staff/QLCH/admin không quyền 0 dòng')
  ok(await raises(as(db, null, () => db.query(`SELECT * FROM public.care_order_sync_status()`), 'anon'), 'permission denied') === true, 'anon không gọi được care_order_sync_status')
  ok(await as(db, U.sm, () => count(db, `SELECT count(*) FROM public.care_sync_state`)) === 0, 'SM vẫn không SELECT thẳng care_sync_state')
  await db.query(`INSERT INTO public.care_sync_state (source, last_success_at) VALUES ('n3_orders', '2026-10-20T01:00:00Z')`)
  s0 = await st(U.sm)
  ok(s0[0].has_synced === true && s0[0].last_success_at.toISOString() === '2026-10-20T01:00:00.000Z' && s0[0].last_failed === false, 'sau lần đồng bộ thành công: has_synced + mốc thời gian', JSON.stringify(s0))
  ok(await raises(db.query(`UPDATE public.care_sync_state SET last_error = 'bigquery timeout: SELECT … QA-K1 (raw)' WHERE source = 'n3_orders'`), 'check') === true,
     'DB chặn message lỗi thô/PII trong care_sync_state.last_error — chỉ nhận MÃ lỗi (security-reviewer P1)')
  await db.query(`UPDATE public.care_sync_state SET last_error = 'BQ_TIMEOUT' WHERE source = 'n3_orders'`)
  s0 = await st(U.super)
  ok(s0[0].has_synced === true && s0[0].last_failed === true && !('last_error' in s0[0]), 'lần sau lỗi: giữ mốc thành công cũ + cờ lỗi; KHÔNG trả nội dung lỗi thô', JSON.stringify(s0))
}
await db.close()

// ════════════════════════════════════════════════════════════════════════════
// B5b.2 (SPEC §B5b): care_order_sync_candidates / care_order_sync_apply / care_order_sync_fail (service_role).
section('B5b.2 — SYNC RPC: ứng viên (lo, hi] · apply nguyên tử · fail chỉ mã · chạy chồng')
db = await freshDb()
{
  const P09 = '2026-09-01', P10 = '2026-10-01'
  const svc = (sql, params = []) => as(db, null, async () => (await db.query(sql, params)).rows[0], 'service_role')
  const candidates = async (cap = 20000) => (await svc(`SELECT public.care_order_sync_candidates($1) r`, [cap])).r
  const apply = async (orders, snap) => (await svc(`SELECT public.care_order_sync_apply($1::jsonb, $2::timestamptz) r`, [JSON.stringify(orders), snap])).r
  const fail = async (code, snap) => (await svc(`SELECT public.care_order_sync_fail($1, $2::timestamptz) r`, [code, snap])).r
  const addTerminal = async (taskId, at, outcome = 'INTERESTED') => (await one(db, `
    INSERT INTO public.care_interactions (task_id, customer_id, actor_id, assignee_id, store_id, period_month, outcome, is_terminal, note, is_test, created_at)
    SELECT id, customer_id, assignee_id, assignee_id, store_id, period_month, $2, true, 'QA B5b', is_test, $3::timestamptz
    FROM public.care_tasks WHERE id = $1 RETURNING id`, [taskId, outcome, at])).id
  const iso = (ms) => new Date(ms).toISOString()
  const ago = (min) => iso(Date.now() - min * 60_000)
  const isoUs = (ms) => iso(ms).replace(/Z$/, '000Z') // dạng app chuẩn hoá cho ordered_at (6 chữ số giây lẻ)
  const state = () => one(db, `SELECT last_success_at::text s, last_error e, updated_at::text u FROM public.care_sync_state WHERE source = 'n3_orders'`)
  const nOrders = () => count(db, `SELECT count(*) FROM public.care_orders`)
  const convTasks = () => count(db, `SELECT count(DISTINCT task_id) FROM public.care_order_attributions`)

  r = await finalize(db, await stage(db, [row('QA-S1', 'QAOS01', EA, 'P1'), row('QA-S2', 'QAOS01', EA, 'P1'), row('QA-S3', 'QAOS01', EA, 'P1')], { period: P09 }), U.mkt, '2026-09-02')
  ok(r.status === 'committed', 'fixture kỳ 09 (S1, S2, S3 → A)')
  r = await finalize(db, await stage(db, [row('QA-S1', 'QAOS02', EC, 'P1'), row('QA-S3', 'QAOS01', EA, 'P1'), row('QA-S4', 'QAOS02', ED, 'P1')], { period: P10 }), U.mkt, '2026-10-01')
  ok(r.status === 'committed', 'fixture kỳ 10 (S1 → C @QAOS02, S3 → A, S4 → D chưa có lượt kết thúc)')
  r = await finalize(db, await stage(db, [row('QA-ST', 'QAOS01', EA, 'P1')], { period: P10, isTest: true }), U.mkt, '2026-10-01')
  const T = {}
  for (const [k, ext, p] of [['S1a', 'QA-S1', P09], ['S1b', 'QA-S1', P10], ['S2', 'QA-S2', P09], ['S3a', 'QA-S3', P09], ['S3b', 'QA-S3', P10], ['ST', 'QA-ST', P10]]) T[k] = (await taskOf(db, ext, p)).id
  await addTerminal(T.S1a, '2026-09-10T03:00:00.000400Z')
  await addTerminal(T.S1b, '2026-10-05T03:00:00Z')
  await addTerminal(T.S2, '2026-09-15T03:00:00Z', 'REFUSED')          // Q-89: REFUSED vẫn ghi công
  await addTerminal(T.S3a, '2026-09-20T00:00:00Z')                   // hai lượt kết thúc CÙNG mốc
  await addTerminal(T.S3b, '2026-09-20T00:00:00Z')
  await addTerminal(T.ST, '2026-10-03T00:00:00Z')                    // fixture is_test vẫn là ứng viên

  // ── candidates ──
  let c = await candidates()
  ok(typeof c === 'object' && !Array.isArray(c) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(c.snapshot_at),
     'candidates trả MỘT jsonb, snapshot_at ISO UTC micro giây (DB now())', JSON.stringify(c.snapshot_at))
  const items = (x) => x.items.map(([e, lo, hi]) => `${e}|${lo}|${hi}`)
  ok(c.windows === 6 && c.customers === 4 && JSON.stringify(items(c)) === JSON.stringify([
    'QA-S1|2026-09-10T03:00:00.000400Z|2026-10-05T03:00:00.000000Z',
    'QA-S2|2026-09-15T03:00:00.000000Z|null',
    'QA-S3|2026-09-20T00:00:00.000000Z|2026-09-20T00:00:00.000000Z',   // lượt id nhỏ: lo = hi (rỗng)
    'QA-S3|2026-09-20T00:00:00.000000Z|null',
    'QA-ST|2026-10-03T00:00:00.000000Z|null',
    'QA-S1|2026-10-05T03:00:00.000000Z|null',
  ].sort((a, b) => a.split('|')[1].localeCompare(b.split('|')[1]) || a.localeCompare(b))),
     'candidates: 6 khoảng / 4 khách; hi = lượt terminal KẾ TIẾP cùng khách; lượt cùng mốc ⇒ lo = hi; is_test có mặt; S4 (chưa kết thúc) không có', JSON.stringify(c))
  const c2 = await candidates(2)
  ok(c2.windows === 6 && c2.items.length === 3, 'p_cap = 2 ⇒ vẫn đếm đủ 6 khoảng, chỉ trả cap+1 = 3 phần tử (app thấy vượt ⇒ fail-closed)', JSON.stringify({ w: c2.windows, n: c2.items.length }))

  // ── apply rỗng ⇒ thành công (đã đọc đủ phạm vi) ──
  const sEmpty = ago(20)
  r = await apply([], sEmpty)
  let st = await state()
  ok(r.orders === 0 && r.orders_written === 0 && st && st.e === null && Date.parse(st.s) === Date.parse(sEmpty) && Date.parse(st.u) === Date.parse(sEmpty),
     'apply lô rỗng ⇒ đánh dấu thành công (last_success_at = snapshot), không lỗi', JSON.stringify({ r, st }))

  // ── apply có đơn: trong khoảng / bằng lo / nhiều đơn cùng task / tháng thứ hai / REFUSED ──
  const orders = [
    { customer_external_id: 'QA-S1', order_key: 'DHC-S1-EQLO', ordered_at: '2026-09-10T03:00:00.000400Z' }, // = lo ⇒ không ghi công
    { customer_external_id: 'QA-S1', order_key: 'DHC-S1-A', ordered_at: '2026-09-20T00:00:00.000000Z' },
    { customer_external_id: 'QA-S1', order_key: 'DHC-S1-B', ordered_at: '2026-09-25T00:00:00.000000Z' },          // 2 đơn cùng task S1a
    { customer_external_id: 'QA-S1', order_key: 'DHC-S1-OCT', ordered_at: '2026-10-06T00:00:00.000000Z' },        // ⇒ lượt kỳ 10 (S1b, C)
    { customer_external_id: 'QA-S2', order_key: 'DHC-S2', ordered_at: '2026-09-16T00:00:00.000000Z' },            // sau REFUSED ⇒ vẫn Có
  ]
  const s1 = ago(15)
  r = await apply(orders, s1)
  ok(r.orders === 5 && r.orders_written === 5 && r.attribution.upserted === 4 && await nOrders() === 5,
     'apply: 5 đơn ghi; 4 attribution (đơn = lo không ghi công)', JSON.stringify(r))
  ok(await convTasks() === 3 && await count(db, `SELECT count(*) FROM public.care_order_attributions WHERE task_id = $1`, [T.S1a]) === 2,
     'Có đơn = 3 task (S1a có 2 đơn vẫn 1 task; S1b tháng 10; S2 sau REFUSED)')
  ok((await one(db, `SELECT assignee_id, store_id FROM public.care_order_attributions WHERE order_key = 'DHC-S1-OCT'`)).assignee_id === U.C,
     'đơn 06/10 ghi công lượt kỳ 10 (C @QAOS02) — nhiều tháng cùng khách')
  c = await candidates()
  ok(c.windows === 3 && c.customers === 2 && !c.items.some(([e]) => e === 'QA-S1' || e === 'QA-S2'),
     'sau apply: task đã Có đơn rời tập ứng viên (còn S3 ×2 khoảng + ST)', JSON.stringify(items(c)))

  // ── chạy lặp cùng payload ⇒ 0 thay đổi ──
  r = await apply(orders, ago(14))
  ok(r.orders_written === 0 && r.attribution.upserted === 0 && r.attribution.deleted === 0, 'apply lặp cùng dữ liệu ⇒ 0 ghi, 0 đổi attribution (idempotent)', JSON.stringify(r))

  // ── đơn đến VIEW muộn: lượt sau mới có đơn của khoảng còn mở ──
  r = await apply([{ customer_external_id: 'QA-S3', order_key: 'DHC-S3-LATE', ordered_at: '2026-09-22T00:00:00.000000Z' }], ago(12))
  ok(r.attribution.upserted === 1 && await convTasks() === 4, 'đơn đến muộn ở lượt sau ⇒ task S3 chuyển Có đơn', JSON.stringify(r))
  const tie = await one(db, `SELECT a.task_id FROM public.care_order_attributions a WHERE a.order_key = 'DHC-S3-LATE'`)
  ok(tie.task_id === T.S3b, 'hai lượt cùng mốc ⇒ đơn về lượt id lớn hơn (S3b) — khớp khoảng rỗng của lượt id nhỏ')

  // ── payload sai ⇒ RAISE, KHÔNG ghi gì (đơn / attribution / trạng thái giữ nguyên) ──
  const before = { o: await nOrders(), a: await count(db, `SELECT count(*) FROM public.care_order_attributions`), st: await state() }
  const unchanged = async () => await nOrders() === before.o
    && await count(db, `SELECT count(*) FROM public.care_order_attributions`) === before.a
    && JSON.stringify(await state()) === JSON.stringify(before.st)
  const good = { customer_external_id: 'QA-S4', order_key: 'DHC-S4', ordered_at: '2026-10-07T00:00:00.000000Z' }
  for (const [why, payload, snap, needle] of [
    ['trùng order_key mâu thuẫn', [good, { ...good, ordered_at: '2026-10-08T00:00:00.000000Z' }], ago(10), 'mâu thuẫn'],
    ['thừa key', [{ ...good, type: 'OFFLINE' }], ago(10), 'sai dạng'],
    ['thiếu key', [{ customer_external_id: 'QA-S4', order_key: 'DHC-S4' }], ago(10), 'sai dạng'],
    ['giá trị không phải chuỗi', [{ ...good, order_key: 1 }], ago(10), 'sai dạng'],
    ['mốc hoàn tất ở tương lai (Q-100)', [{ ...good, ordered_at: isoUs(Date.now() + 3600_000) }], ago(10), 'tương lai'],
    ['snapshot quá cũ', [good], ago(180), 'ngoài biên'],
    ['snapshot vừa quá biên 2 giờ (121 phút)', [good], ago(121), 'ngoài biên'],
    ['snapshot ở tương lai', [good], iso(Date.now() + 10 * 60_000), 'ngoài biên'],
    ['order_key rỗng (chặn trước khi ghi — CHECK không phải ghi giá trị thô vào log)', [good, { ...good, order_key: '' }], ago(10), 'sai dạng'],
    ['order_key có khoảng trắng đầu/cuối', [{ ...good, order_key: ' DHC-S4' }], ago(10), 'sai dạng'],
    ['order_key > 200 ký tự', [{ ...good, order_key: 'D'.repeat(201) }], ago(10), 'sai dạng'],
    ['customer_external_id có khoảng trắng cuối', [{ ...good, customer_external_id: 'QA-S4 ' }], ago(10), 'sai dạng'],
    ['customer_external_id > 100 ký tự', [{ ...good, customer_external_id: 'K'.repeat(101) }], ago(10), 'sai dạng'],
    ["ordered_at = 'now' (literal timestamptz đặc biệt)", [{ ...good, ordered_at: 'now' }], ago(10), 'sai dạng'],
    ["ordered_at = '-infinity'", [{ ...good, ordered_at: '-infinity' }], ago(10), 'sai dạng'],
    ['ordered_at không offset (hiểu theo TimeZone phiên — Q-100)', [{ ...good, ordered_at: '2026-10-07T00:00:00.000000' }], ago(10), 'sai dạng'],
    ['ordered_at 3 chữ số giây lẻ (không phải dạng app chuẩn hoá)', [{ ...good, ordered_at: '2026-10-07T00:00:00.000Z' }], ago(10), 'sai dạng'],
    ['ordered_at offset +07:00', [{ ...good, ordered_at: '2026-10-07T07:00:00.000000+07:00' }], ago(10), 'sai dạng'],
  ]) ok(await raises(apply(payload, snap), needle) === true && await unchanged(), `apply từ chối: ${why} — không ghi gì`)
  ok(await raises(apply(Array.from({ length: 20001 }, (_, i) => ({ ...good, order_key: `DHC-X${i}` })), ago(10)), 'vượt 20000') === true && await unchanged(),
     'apply từ chối > 20.000 đơn một lượt — không ghi gì')
  // Biên trong: lượt chậm (snapshot 119 phút trước) vẫn được nhận; kết quả cũ hơn không đổi trạng thái mới hơn.
  ok(await raises(apply([], ago(119)), 'ngoài biên') === 'KHÔNG raise' && await unchanged(),
     'apply nhận snapshot 119 phút (trong biên 2 giờ) — lượt cũ không làm lùi trạng thái')

  // ── kết quả không lùi; lượt cũ không xoá lỗi của lượt mới ──
  const S2 = ago(9), S1old = ago(30), S3 = ago(5), S2b = ago(7), S4 = ago(1)
  await apply([], S2)
  st = await state()
  ok(Date.parse(st.s) === Date.parse(S2) && st.e === null, 'apply S2 ⇒ last_success = S2')
  await apply([], S1old)
  st = await state()
  ok(Date.parse(st.s) === Date.parse(S2) && Date.parse(st.u) === Date.parse(S2), 'apply lượt CŨ hơn (chạy chồng xong muộn) ⇒ last_success KHÔNG lùi')
  ok(await fail('BQ_TIMEOUT', S1old) === false && (await state()).e === null, 'fail lượt cũ hơn kết quả mới nhất ⇒ bỏ qua (false)')
  ok(await fail('BQ_TIMEOUT', S3) === true && (await state()).e === 'BQ_TIMEOUT' && Date.parse((await state()).s) === Date.parse(S2),
     'fail lượt mới ⇒ ghi mã lỗi, GIỮ last_success (UI giữ số cũ + mốc thành công cuối)')
  await apply([], S2b)
  st = await state()
  ok(st.e === 'BQ_TIMEOUT' && Date.parse(st.s) === Date.parse(S2b), 'apply lượt S2b (cũ hơn lượt lỗi S3) ⇒ cập nhật last_success nhưng KHÔNG xoá lỗi của lượt mới hơn', JSON.stringify(st))
  await apply([], S4)
  ok((await state()).e === null && Date.parse((await state()).s) === Date.parse(S4), 'apply lượt mới nhất ⇒ xoá lỗi')
  ok(await raises(fail('bigquery timeout raw', ago(0.5)), 'mã lỗi sai dạng') === true, 'fail chỉ nhận MÃ — không ghi message thô')
  ok(await raises(fail(null, ago(0.5)), 'mã lỗi sai dạng') === true && (await state()).e === null && Date.parse((await state()).s) === Date.parse(S4),
     'fail(NULL) bị từ chối — không thể dùng để xoá lỗi / đẩy updated_at (CHECK cột cho qua NULL)')
  ok(await raises(fail('BQ_TIMEOUT', iso(Date.now() + 10 * 60_000)), 'ngoài biên') === true, 'fail từ chối snapshot ở tương lai')
  const viaStatus = await as(db, U.super, async () => (await db.query(`SELECT has_synced, last_failed FROM public.care_order_sync_status()`)).rows[0])
  ok(viaStatus.has_synced === true && viaStatus.last_failed === false, 'care_order_sync_status (UI) đọc đúng trạng thái sau apply')

  // ── queue: xoá mục enqueued_at ≤ snapshot, giữ mục mới hơn ──
  const cs = await one(db, `SELECT id FROM public.care_customers WHERE external_id = 'QA-S4'`)
  const cs2 = await one(db, `SELECT id FROM public.care_customers WHERE external_id = 'QA-S3'`)
  await db.query(`DELETE FROM public.care_reconcile_queue WHERE true`)
  await db.query(`INSERT INTO public.care_reconcile_queue (customer_id, from_ts, enqueued_at) VALUES ($1, now(), $2), ($3, now(), $4)`,
    [cs.id, ago(3), cs2.id, iso(Date.now() + 30_000)])
  r = await apply([], ago(2))
  ok(r.queue_drained === 1 && await count(db, `SELECT count(*) FROM public.care_reconcile_queue`) === 1, 'queue: xoá mục trước snapshot, giữ mục enqueue sau snapshot', JSON.stringify(r))

  // ── quyền ──
  for (const [name, who] of [['super', U.super], ['Marketing', U.mkt], ['staff A', U.A]]) {
    ok(await raises(as(db, who, () => db.query(`SELECT public.care_order_sync_candidates(10)`)), 'permission denied') === true
       && await raises(as(db, who, () => db.query(`SELECT public.care_order_sync_apply('[]'::jsonb, now())`)), 'permission denied') === true
       && await raises(as(db, who, () => db.query(`SELECT public.care_order_sync_fail('X', now())`)), 'permission denied') === true,
       `${name} (authenticated) không gọi được 3 RPC đồng bộ — chỉ service_role`)
  }
  ok(await raises(as(db, null, () => db.query(`SELECT public.care_order_sync_candidates(10)`), 'anon'), 'permission denied') === true, 'anon không gọi được RPC đồng bộ')
  // Báo cáo người dùng vẫn đúng sau đồng bộ (không 0 giả): Marketing thấy 4 task Có đơn (kỳ 09: S1a, S2, S3b; kỳ 10: S1b).
  const rep = async (p) => (await as(db, U.mkt, async () => (await db.query(`SELECT sum(converted_tasks)::int n FROM public.care_report($1::date)`, [p])).rows[0].n))
  ok(await rep(P09) + await rep(P10) === 4, 'care_report (Marketing) = 4 task Có đơn sau đồng bộ', JSON.stringify({ p09: await rep(P09), p10: await rep(P10) }))
}
await db.close()

console.log(`\n${pass} đạt · ${fail} lỗi`)
process.exit(fail ? 1 : 0)
