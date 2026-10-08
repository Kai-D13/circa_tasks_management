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
  ok(fns.length === 32, '32 function care*', String(fns.length))
  ok(fns.every((f) => !f.anon), 'anon không EXECUTE function care* nào', fns.filter((f) => f.anon).map((f) => f.fn).join(', '))
  const internal = fns.filter((f) => f.fn.startsWith('care__'))
  ok(internal.length === 8 && internal.every((f) => !f.auth && !f.svc), 'care__* (8 hàm nội bộ) không cấp cho role nào', JSON.stringify(internal.filter((f) => f.auth || f.svc)))
  const svcOnly = ['care_import_finalize(uuid,uuid)', 'care_close_period()', 'care_stamp_overdue()', 'care_purge_stale_staging(interval)']
  ok(fns.filter((f) => svcOnly.includes(f.fn)).every((f) => f.svc && !f.auth), 'finalize/close/stamp/purge chỉ service_role')
  ok(await raises(as(db, null, () => db.query(`TRUNCATE public.care_interactions`), 'service_role'), 'permission denied') === true, 'service_role không TRUNCATE được bảng append-only')
  ok(await count(db, `SELECT count(*) FROM pg_policies WHERE tablename LIKE 'care\_%'`) === 14, '14 policy care_*')
  const authRpc = ['care_record_interaction(uuid,text,text,date,jsonb)', 'care_transfer_tasks(uuid[],uuid,text)', 'care_report(date,uuid[],boolean)', 'care_my_summary()', 'care_my_access()']
  ok(fns.filter((f) => authRpc.includes(f.fn)).length === 5 && fns.filter((f) => authRpc.includes(f.fn)).every((f) => f.auth), 'RPC người dùng: authenticated có EXECUTE')
  const tp = await one(db, `SELECT has_table_privilege('authenticated','public.care_tasks','INSERT') ins,
      has_table_privilege('authenticated','public.care_interactions','UPDATE') upd,
      has_table_privilege('authenticated','public.care_import_staging','SELECT') stg,
      has_table_privilege('authenticated','public.care_reconcile_queue','SELECT') q,
      has_table_privilege('anon','public.care_tasks','SELECT') anon_sel,
      has_table_privilege('authenticated','public.care_orders','SELECT') ord_sel`)
  ok(!tp.ins && !tp.upd && !tp.stg && !tp.q && !tp.anon_sel, 'bảng: authenticated không ghi; staging/queue không đọc; anon không đọc', JSON.stringify(tp))
  ok(await count(db, `SELECT count(*) FROM information_schema.columns WHERE table_name = 'care_orders' AND column_name IN ('is_valid_order','is_deleted','order_status','channel','store_code')`) === 0
     && await count(db, `SELECT count(*) FROM information_schema.columns WHERE table_name = 'care_orders' AND column_name IN ('order_key','customer_external_id','ordered_at','source_updated_at','net_amount','pos_code')`) === 6,
     'care_orders đúng N3 r3.2 (6 trường nghiệp vụ, không cột r3.1)')
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
ok(await raises(record(db, '2026-10-05', U.qlch1, tA0.id, 'NO_NEED'), 'chỉ dược sĩ được giao') === true, 'QLCH không ghi thay (TODO Q-33)')
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
r = await record(db, '2026-10-05', U.A, tA0.id, 'INTERESTED', 'QA quan tâm', null, [{ url: 'https://example.invalid/p.jpg' }])
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
  ok(await as(db, U.A, () => count(db, `SELECT count(*) FROM public.care_orders`)) === 0, 'staff: care_orders 0 dòng')
  ok(await raises(as(db, U.A, () => db.query(`INSERT INTO public.care_customers (external_id) VALUES ('hack')`)), 'permission denied') === true, 'staff không ghi thẳng bảng')
  const histA = await as(db, U.A, async () => (await db.query(`SELECT note FROM public.care_interactions i JOIN public.care_customers c ON c.id = i.customer_id WHERE c.external_id = 'QA-H'`)).rows)
  ok(histA.length === 1 && histA[0].note === 'lượt kỳ trước', 'staff A thấy lượt kỳ trước của khách H (H có task kỳ này giao A)')
  const histC = await as(db, U.C, () => count(db, `SELECT count(*) FROM public.care_interactions i JOIN public.care_customers c ON c.id = i.customer_id WHERE c.external_id = 'QA-H'`))
  ok(histC === 0, 'staff C (store khác) không thấy lịch sử khách H')
  const sQ = await visibleExt(U.qlch1)
  ok(sQ.every((x) => !x.startsWith('QA-C1') && !x.startsWith('QA-Z1')) && sQ.includes(`QA-B1@${cur}`) && sQ.includes(`QA-H@${prev}`), 'QLCH QAOS01: chỉ store mình (kể cả kỳ cũ)', sQ.join(','))
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
  ok(await as(db, U.A, () => count(db, `SELECT count(*) FROM public.care_interactions i JOIN public.care_customers c ON c.id = i.customer_id WHERE c.external_id = 'QA-H'`)) === 0, 'A mất cả lượt của task đã chuyển và lịch sử khách H')
  ok(await as(db, U.A, () => count(db, `SELECT count(*) FROM public.care_task_products p WHERE p.task_id = $1`, [tH.id])) === 0, 'A không đọc sản phẩm task đã chuyển')
  ok(await as(db, U.B, () => count(db, `SELECT count(*) FROM public.care_interactions i JOIN public.care_customers c ON c.id = i.customer_id WHERE c.external_id = 'QA-H'`)) === 2, 'B thấy lượt của A + lượt kỳ trước của H')
  ok(await as(db, U.B, () => count(db, `SELECT count(*) FROM public.care_assignment_events WHERE task_id = $1`, [tH.id])) === 2, 'B thấy sự kiện assigned + transferred')
}

section('BÁO CÁO = đếm qua session client; không nhân đôi; loại is_test')
{
  // Attribution fixture (B5 mới ghi thật): H có 3 sản phẩm, 2 đơn; một đơn hoàn hết (0đ) vẫn là chuyển đổi.
  const tH = await taskOf(db, 'QA-H', PC), tB1 = await taskOf(db, 'QA-B1', PC), tT1 = await taskOf(db, 'QA-T1', PC)
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [U.B])
  const iH = (await db.query(`SELECT public.care__record_interaction_at($1, $2, 'ORDERED', 'B chốt', NULL, NULL) r`, [TODAY, tH.id])).rows[0].r.interaction_id
  await setUid(db, null)
  await db.query(`INSERT INTO public.care_orders (order_key, customer_external_id, ordered_at, source_updated_at, net_amount, pos_code) VALUES
    ('QA-O1','QA-H', now(), now(), 150000, 'QAOS01'), ('QA-O2','QA-H', now(), now(), 0, NULL), ('QA-O3','QA-T1', now(), now(), 999, NULL)`)
  await db.query(`INSERT INTO public.care_order_attributions (order_key, interaction_id, task_id, customer_id, assignee_id, store_id, period_month, net_amount, is_test) VALUES
    ('QA-O1', $1, $2, $3, $4, $5, $6, 150000, false), ('QA-O2', $1, $2, $3, $4, $5, $6, 0, false)`, [iH, tH.id, tH.customer_id, U.B, storeId(1), PC])
  await setUid(db, U.A)
  const iT = (await db.query(`SELECT public.care__record_interaction_at($1, $2, 'NO_NEED', 'test', NULL, NULL) r`, [TODAY, tT1.id])).rows[0].r.interaction_id
  await setUid(db, null)
  await db.query(`INSERT INTO public.care_order_attributions (order_key, interaction_id, task_id, customer_id, assignee_id, store_id, period_month, net_amount, is_test) VALUES ('QA-O3', $1, $2, $3, $4, $5, $6, 999, true)`, [iT, tT1.id, tT1.customer_id, U.A, storeId(1), PC])
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
  ok(bRow && bRow.orders === 2 && bRow.converted_tasks === 1 && Number(bRow.net_revenue) === 150000 && bRow.completed === 1, 'B: 2 đơn (1 hoàn hết vẫn tính) · 1 task chuyển đổi · 150.000đ — khách 3 sản phẩm không nhân đôi', JSON.stringify(bRow))
  ok(repAll.every((x) => Number(x.net_revenue) !== 999), 'đơn của fixture is_test bị loại khỏi báo cáo')
  const repTest = await as(db, U.super, async () => (await db.query(`SELECT sum(orders)::int o FROM public.care_report($1::date, NULL, true)`, [PC])).rows[0].o)
  const repTestMkt = await as(db, U.mkt, async () => (await db.query(`SELECT sum(orders)::int o FROM public.care_report($1::date, NULL, true)`, [PC])).rows[0].o)
  ok(repTest === 3 && repTestMkt === 2, 'p_include_test chỉ có tác dụng với super')
  const repA = await as(db, U.A, async () => (await db.query(`SELECT * FROM public.care_report($1::date)`, [PC])).rows)
  ok(repA.every((x) => x.assignee_id === U.A) && repA.every((x) => x.orders === 0), 'staff A chỉ thấy dòng của mình, không thấy doanh thu của B')
  const repSm2 = await as(db, U.sm2, async () => (await db.query(`SELECT * FROM public.care_report($1::date, $2::uuid[])`, [PC, [storeId(2)]])).rows)
  ok(repSm2.length === 0, 'p_store_ids ngoài scope không nới quyền (SM2 lọc QAOS02 ⇒ rỗng)')
  const mid = PC.slice(0, 8) + '15'
  const repMid = await as(db, U.mkt, async () => (await db.query(`SELECT sum(tasks_total)::int n FROM public.care_report($1::date)`, [mid])).rows[0].n)
  ok(repMid === repAll.reduce((a, x) => a + x.tasks_total, 0) && repMid > 0, 'care_report nhận ngày giữa tháng ⇒ chuẩn hoá về kỳ (không rỗng âm thầm)')
  ok(await as(db, U.B, () => count(db, `SELECT count(*) FROM public.care_orders`)) === 0 && await as(db, U.B, () => count(db, `SELECT count(*) FROM public.care_order_attributions`)) === 2, 'B: không đọc care_orders, đọc attribution task của mình')
  const sum = await as(db, U.A, async () => (await db.query(`SELECT * FROM public.care_my_summary()`)).rows[0])
  // A đang có QA-A2 (thật, chưa chăm sóc) + QA-T1 (fixture is_test, đã Hoàn thành); H đã chuyển cho B.
  ok(sum.assigned === 1 && sum.completed === 0 && sum.not_cared === 1, 'care_my_summary staff A chỉ đếm task thật — loại fixture is_test (audit PM B1 P1)', JSON.stringify(sum))
  ok(await as(db, U.A, () => count(db, `SELECT count(*) FROM public.care_tasks WHERE is_test AND period_month = $1`, [PC])) === 1, 'fixture is_test vẫn tồn tại (RLS) nhưng không vào thẻ')
  ok(await as(db, null, async () => (await db.query(`SELECT public.care_stamp_overdue() s, public.care_close_period() c`)).rows[0].c, 'service_role') === 0, 'service_role gọi được care_stamp_overdue/care_close_period (giờ VN thật)')
}
await db.close()

console.log(`\n${pass} đạt · ${fail} lỗi`)
process.exit(fail ? 1 : 0)
