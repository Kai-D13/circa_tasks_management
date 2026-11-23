// QA EXECUTABLE cho migration 133 (CRM-CSKH PM 22/11/2026: NO_NEED sang nhóm "cần liên hệ lại" + care_reason_options) trên PGlite
// (Postgres 16 WASM) + 114 / 115 / 116 thật. Không đụng DB thật; pglite cài --no-save.
//
//   cd webapp
//   npm i --no-save @electric-sql/pglite@0.2.17     # một lần
//   node scripts/qa-care-133.mjs                    # kỳ vọng: N đạt · 0 lỗi
//
// Bao phủ: preflight (thiếu 132 / có bản > 133 / trạng thái dở) · chạy lại · bảng chân trị SQL ↔ lib/care/outcome.ts · gate ACL ·
// ghi lượt NO_NEED (thiếu ngày, trước hôm nay, quá hạn, biên hôm nay / đúng hạn, lưu mở, ghi tiếp, không vào hàng đợi ghi công) ·
// dữ liệu cũ giữ nguyên (lượt NO_NEED kết thúc trước 133) · care_reason_options theo vai trò / kỳ / is_test / is_current ·
// rollback (từ chối khi có lượt kiểu mới; sạch thì về đúng 114; nạp lại 133).
import { CARE_OUTCOMES, CARE_OUTCOME_META } from '../lib/care/outcome.ts'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createJiti } from 'jiti'
import * as L from './lib-care-pglite.mjs'

// lib/care/browse.ts import không đuôi + alias '@/…' ⇒ nạp qua jiti (như Playwright), không import .ts trực tiếp bằng Node.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const jiti = createJiti(pathToFileURL(path.join(ROOT, 'scripts', 'x.mjs')).href, { alias: { '@': ROOT }, interopDefault: true })
const { careReasonKey, careReasonLabel } = await jiti.import(path.join(ROOT, 'lib', 'care', 'browse.ts'))

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
const { U, one, count, raises, as, stage, finalize, record, taskOf, row, EA, EB, EC, storeId } = L
const S1 = L.STORES[0].code, S2 = L.STORES[1].code
const P10 = '2026-10-01', DUE = '2026-10-31', TODAY = '2026-10-05'
const S = JSON.stringify
const truth = async (db) => (await db.query(`SELECT x, public.care_is_terminal_outcome(x) t, public.care_outcome_requires_date(x) d FROM unnest($1::text[]) x`, [[...CARE_OUTCOMES, 'zz', null]])).rows
const acl = async (db, sig) => one(db, `SELECT has_function_privilege('anon', $1, 'EXECUTE') a, has_function_privilege('authenticated', $1, 'EXECUTE') u, has_function_privilege('service_role', $1, 'EXECUTE') s,
  (SELECT count(*) FROM pg_proc p, LATERAL aclexplode(p.proacl) x WHERE p.oid = $1::regprocedure AND x.grantee = 0)::int pub,
  (SELECT prosecdef FROM pg_proc WHERE oid = $1::regprocedure) secdef, (SELECT provolatile FROM pg_proc WHERE oid = $1::regprocedure) vol`, [sig])
const FNS = ['public.care_is_terminal_outcome(text)', 'public.care_outcome_requires_date(text)', 'public.care_reason_options(date, boolean)', 'public.care_tasks_by_reason(date, text, boolean)']
const isScopeFn = (f) => f.includes('care_reason_options') || f.includes('care_tasks_by_reason')
/** id task qua RPC lọc lý do (đường app dùng). */
const byReason = async (db, uid, reason, period = P10, isTest = false, role = 'authenticated') =>
  as(db, uid, async () => (await db.query(`SELECT id FROM public.care_tasks_by_reason($1, $2, $3) ORDER BY id`, [period, reason, isTest])).rows.map((r) => r.id), role)
/** Đối chứng: cùng câu hỏi nhưng đọc THẲNG bảng dưới RLS của người xem (policy care_tasks_select + care_task_products_select). */
const byReasonRls = async (db, uid, key, period = P10, isTest = false) =>
  as(db, uid, async () => (await db.query(`SELECT t.id FROM public.care_tasks t WHERE t.period_month = $1 AND t.is_test = $3
    AND EXISTS (SELECT 1 FROM public.care_task_products p WHERE p.task_id = t.id AND p.is_current AND lower(btrim(p.reason_type)) = $2) ORDER BY t.id`, [period, key, isTest])).rows.map((r) => r.id))
const optionsRls = async (db, uid, period = P10) =>
  as(db, uid, async () => (await db.query(`SELECT DISTINCT lower(btrim(p.reason_type)) k FROM public.care_tasks t JOIN public.care_task_products p ON p.task_id = t.id
    WHERE t.period_month = $1 AND NOT t.is_test AND p.is_current AND btrim(p.reason_type) <> '' ORDER BY 1`, [period])).rows.map((r) => r.k))
const reasons = async (db, uid, period = P10, isTest = false, role = 'authenticated') =>
  as(db, uid, async () => (await db.query(`SELECT reason_key, reason_label FROM public.care_reason_options($1, $2)`, [period, isTest])).rows, role)

// ════════════════════════════════════════════════════════════════════════════
section('MIGRATION 133 — preflight / chạy lại')
{
  const d = await L.freshDb(PGlite, { through: '116' })
  ok(await raises(d.exec(L.MIGRATION_133), 'thiếu migration 132') === true, 'DB chưa có 132 ⇒ RAISE (đúng thứ tự)')
  await d.exec('ROLLBACK')
  await L.apply133(d)
  ok(await count(d, `SELECT count(*) FROM public.app_migrations WHERE version = '133' AND name = 'care_no_need_callback'`) === 1, 'nạp 133 sau 116 + marker 132: app_migrations có 133')
  try { await d.exec(L.MIGRATION_133); ok(true, 'chạy lại 133 (idempotent) thành công') } catch (e) { ok(false, 'chạy lại 133', e.message) }
  ok(await count(d, `SELECT count(*) FROM public.app_migrations WHERE version = '133'`) === 1, 'chạy lại không nhân đôi dòng app_migrations')
  await d.exec(`INSERT INTO public.app_migrations (version, name) VALUES ('134', 'qa_sau')`)
  ok(await raises(d.exec(L.MIGRATION_133), 'migration số > 133') === true, 'DB có bản số > 133 ⇒ RAISE')
  await d.exec('ROLLBACK')

  const h = await L.freshDb(PGlite, { through: '116' })
  await h.exec(`INSERT INTO public.app_migrations (version, name) VALUES ('132', 'cms_returns_full_line')`)
  await h.exec(`CREATE OR REPLACE FUNCTION public.care_is_terminal_outcome(p text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT COALESCE(p IN ('INTERESTED', 'ORDERED', 'REFUSED'), false) $$`)
  ok(await raises(h.exec(L.MIGRATION_133), 'trạng thái dở') === true, 'NO_NEED ở trạng thái dở (không kết thúc + không cần ngày) ⇒ RAISE')
  await h.exec('ROLLBACK')
  await h.exec(`CREATE OR REPLACE FUNCTION public.care_is_terminal_outcome(p text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT COALESCE(p IN ('NO_NEED', 'INTERESTED', 'ORDERED', 'REFUSED', 'CALLBACK'), false) $$`)
  ok(await raises(h.exec(L.MIGRATION_133), 'không ở trạng thái 114 / 133') === true, 'helper bị sửa lạ (CALLBACK kết thúc) ⇒ RAISE')
  await h.exec('ROLLBACK')

  // Policy đọc của care_tasks bị sửa (hai hàm lý do chép điều kiện của nó) ⇒ dừng.
  const p = await L.freshDb(PGlite, { through: '116' })
  await p.exec(`INSERT INTO public.app_migrations (version, name) VALUES ('132', 'cms_returns_full_line')`)
  await p.exec(`CREATE POLICY care_tasks_select_qa_extra ON public.care_tasks FOR SELECT TO authenticated USING (false)`)
  ok(await raises(p.exec(L.MIGRATION_133), 'policy đọc của care_tasks') === true, 'care_tasks có thêm policy SELECT lạ ⇒ RAISE')
  await p.exec('ROLLBACK')
  await p.exec(`DROP POLICY care_tasks_select_qa_extra ON public.care_tasks`)
  // PM 23/11 §4 c: tiền kiểm so NGUYÊN biểu thức USING — policy đổi điều kiện nhưng VẪN nhắc đủ bốn helper cũng phải dừng.
  const USING_114 = `((assignee_id = (select public.care_assignee_uid()) AND store_id = (select public.care_staff_store_id())) OR (select public.care_can_view_all()) OR store_id = ANY ((select public.care_scope_store_ids())::uuid[]))`
  const setPolicy = (using, extra = 'FOR SELECT TO authenticated') => p.exec(`DROP POLICY care_tasks_select ON public.care_tasks; CREATE POLICY care_tasks_select ON public.care_tasks ${extra} USING (${using})`)
  const mutants = [
    ['bỏ vế store của dược sĩ (AND → OR), vẫn đủ bốn helper', USING_114.replace(') AND store_id = (select public.care_staff_store_id()))', ') OR store_id = (select public.care_staff_store_id()))')],
    ['thêm điều kiện AND status, vẫn đủ bốn helper', `(${USING_114} AND status <> 'closed_unfinished')`],
    ['đổi thứ tự vai (view_all trước), vẫn đủ bốn helper', "((select public.care_can_view_all()) OR (assignee_id = (select public.care_assignee_uid()) AND store_id = (select public.care_staff_store_id())) OR store_id = ANY ((select public.care_scope_store_ids())::uuid[]))"],
    ['nới thêm OR is_test, vẫn đủ bốn helper', `(${USING_114} OR is_test)`],
  ]
  for (const [name, using] of mutants) {
    await setPolicy(using)
    const q = (await p.query(`SELECT qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'care_tasks' AND policyname = 'care_tasks_select'`)).rows[0].qual
    const four = ['care_assignee_uid()', 'care_staff_store_id()', 'care_can_view_all()', 'care_scope_store_ids()'].every((h) => q.includes(h))
    ok(four && await raises(p.exec(L.MIGRATION_133), 'không còn đúng nguyên biểu thức 114') === true, `policy ${name} ⇒ RAISE (phép LIKE bốn helper của r1 sẽ cho qua)`)
    await p.exec('ROLLBACK')
  }
  await setPolicy(USING_114, 'FOR SELECT TO authenticated, anon')
  ok(await raises(p.exec(L.MIGRATION_133), 'không còn đúng nguyên biểu thức 114') === true, 'policy đúng biểu thức nhưng mở thêm role anon ⇒ RAISE')
  await p.exec('ROLLBACK')
  await setPolicy(USING_114, 'AS RESTRICTIVE FOR SELECT TO authenticated')
  ok(await raises(p.exec(L.MIGRATION_133), 'không còn đúng nguyên biểu thức 114') === true, 'policy đúng biểu thức nhưng RESTRICTIVE ⇒ RAISE')
  await p.exec('ROLLBACK')
  await setPolicy(USING_114)
  // Biểu thức chuẩn ghi trong 133 = nguyên văn prod PG 15.8; PGlite (PG 16) deparse ra cùng chuỗi sau chuẩn hoá ⇒ policy 114 nguyên bản đi qua.
  const norm = (await p.query(`SELECT regexp_replace(replace(qual, 'public.', ''), '[[:space:]]+', '', 'g') n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'care_tasks' AND policyname = 'care_tasks_select'`)).rows[0].n
  ok(L.MIGRATION_133.includes(`= '${norm}'`), 'biểu thức chuẩn trong 133 = qual đã chuẩn hoá của policy 114 nguyên bản (dựng lại bằng DDL của 114)', norm)
  // search_path của phiên không có public ⇒ PG deparse kèm "public." — tiền kiểm vẫn nhận (đã bỏ tiền tố).
  await p.exec(`SET search_path = pg_catalog; SET standard_conforming_strings = off`)   // cả hai biến thể phiên: regex [[:space:]] không phụ thuộc escape
  try { await p.exec(L.MIGRATION_133); ok(true, 'phiên có search_path không chứa public: 133 vẫn chạy (so sánh đã bỏ tiền tố "public.")') } catch (e) { ok(false, 'search_path không chứa public', e.message); await p.exec('ROLLBACK') }
  await p.exec(`RESET search_path; RESET standard_conforming_strings`)
  await p.exec(L.ROLLBACK_133)
  // Studio dán CRLF: chạy được, chạy lại được; md5 thân hai helper (bỏ CR) đúng giá trị ghi trong VERIFY của file.
  const crlf = (s) => s.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
  try { await p.exec(crlf(L.MIGRATION_133)); await p.exec(crlf(L.MIGRATION_133)); ok(true, 'bản CRLF của 133: chạy + chạy lại thành công') } catch (e) { ok(false, 'bản CRLF của 133', e.message) }
  const md5 = async (d) => (await d.query(`SELECT p.proname n, md5(replace(p.prosrc, E'\\r', '')) m FROM pg_proc p WHERE p.oid IN ('public.care_is_terminal_outcome(text)'::regprocedure, 'public.care_outcome_requires_date(text)'::regprocedure) ORDER BY 1`)).rows.map((r) => r.m)
  const doc = L.MIGRATION_133 + L.ROLLBACK_133
  const m133 = await md5(p)
  ok(m133.every((m) => L.MIGRATION_133.includes(m)), 'md5 (bỏ CR) hai helper sau 133 = giá trị trong khối VERIFY V3', S(m133))
  try { await p.exec(crlf(L.ROLLBACK_133)); ok(true, 'bản CRLF của rollback 133 chạy được') } catch (e) { ok(false, 'bản CRLF của rollback 133', e.message) }
  const m114 = await md5(p)
  ok(m114.every((m) => L.ROLLBACK_133.includes(m) && L.MIGRATION_133.includes(m)) && S(m114) !== S(m133) && doc.length > 0, 'md5 (bỏ CR) sau rollback = giá trị nền 114 ghi trong P2 / R3', S(m114))
}

const db = await L.freshDbLatest(PGlite)

section('BẢNG CHÂN TRỊ SQL ↔ lib/care/outcome.ts + thuộc tính / ACL')
{
  const rows = await truth(db)
  const bad = rows.filter((r) => { const m = CARE_OUTCOME_META[r.x]; return r.t !== (m?.terminal ?? false) || r.d !== (m?.requiresNextActionDate ?? false) })
  ok(bad.length === 0 && rows.length === 8, 'sáu outcome + giá trị lạ + NULL: terminal / bắt buộc ngày hẹn khớp TS', S(bad))
  const nn = rows.find((r) => r.x === 'NO_NEED')
  ok(nn.t === false && nn.d === true && CARE_OUTCOME_META.NO_NEED.terminal === false && CARE_OUTCOME_META.NO_NEED.requiresNextActionDate === true, 'NO_NEED: không kết thúc + bắt buộc ngày hẹn (cả SQL lẫn TS)')
  ok(S(CARE_OUTCOMES.filter((o) => CARE_OUTCOME_META[o].terminal)) === S(['INTERESTED', 'ORDERED', 'REFUSED'])
     && S(CARE_OUTCOMES.filter((o) => CARE_OUTCOME_META[o].requiresNextActionDate)) === S(['UNREACHABLE', 'NO_NEED', 'CALLBACK']), 'tập kết thúc = 3 mã; tập cần ngày = 3 mã')
  for (const f of FNS) {
    const a = await acl(db, f)
    // PM 23/11 §4 d: hai RPC lý do CHỈ authenticated (caller là session app); hai helper outcome giữ ma trận 114 (+ service_role).
    ok(a.a === false && a.u === true && a.s === !isScopeFn(f) && a.pub === 0 && a.secdef === isScopeFn(f) && a.vol === (isScopeFn(f) ? 's' : 'i'),
       `ACL ${f}: anon ✗ · authenticated ✓ · service_role ${isScopeFn(f) ? '✗' : '✓'} · PUBLIC ✗ · ${isScopeFn(f) ? 'SECDEF (phạm vi tường minh)' : 'không SECDEF'} · volatility đúng`, S(a))
  }
  ok(await count(db, `SELECT count(*) FROM pg_proc p WHERE p.oid IN ('public.care_reason_options(date, boolean)'::regprocedure, 'public.care_tasks_by_reason(date, text, boolean)'::regprocedure) AND p.proconfig @> ARRAY['search_path=public']`) === 2, 'hai hàm SECDEF đều SET search_path = public')
  ok(await raises(as(db, null, () => db.query(`SELECT * FROM public.care_reason_options($1, false)`, [P10]), 'anon'), 'permission denied') === true, 'anon gọi care_reason_options ⇒ permission denied')
  ok(await raises(as(db, null, () => db.query(`SELECT * FROM public.care_tasks_by_reason($1, 'chronic', false)`, [P10]), 'anon'), 'permission denied') === true, 'anon gọi care_tasks_by_reason ⇒ permission denied')
  ok(await raises(as(db, null, () => db.query(`SELECT * FROM public.care_reason_options($1, false)`, [P10]), 'service_role'), 'permission denied') === true, 'service_role gọi care_reason_options ⇒ permission denied')
  ok(await raises(as(db, null, () => db.query(`SELECT * FROM public.care_tasks_by_reason($1, 'chronic', false)`, [P10]), 'service_role'), 'permission denied') === true, 'service_role gọi care_tasks_by_reason ⇒ permission denied')
  // Chạy lại 133 trên DB đã bị cấp nhầm service_role / PUBLIC cho hai RPC ⇒ REVOKE đích danh đưa về đúng ma trận.
  await db.exec(`GRANT EXECUTE ON FUNCTION public.care_reason_options(date, boolean), public.care_tasks_by_reason(date, text, boolean) TO service_role, anon, PUBLIC`)
  await db.exec(L.MIGRATION_133)
  { const x = await acl(db, FNS[2]), y = await acl(db, FNS[3]); ok(!x.a && x.u && !x.s && x.pub === 0 && !y.a && y.u && !y.s && y.pub === 0, 'cấp nhầm service_role / anon / PUBLIC rồi chạy lại 133 ⇒ về đúng ma trận (chỉ authenticated)', S({ x, y })) }
  ok(await count(db, `SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('care_reason_options', 'care_tasks_by_reason')`) === 2, 'hai hàm lý do: mỗi tên đúng một chữ ký (không overload)')
}

// ── Fixture: T10, store 1 (EA: A1 hai lý do, A2 'Chronic' hoa; EB: A3 lý do ngoài mẫu) · store 2 (EC: C1 promotion) · batch thử ──
{
  const b = await stage(db, [
    row('R-A1', S1, EA, 'P1'), row('R-A1', S1, EA, 'P2', { reason_type: 'Promotion' }), row('R-A1', S1, EA, 'P3'),
    row('R-A2', S1, EA, 'P1', { reason_type: 'Chronic' }),
    row('R-A3', S1, EB, 'P1', { reason_type: 'Tái khám (đợt 2)*' }),
    row('R-C1', S2, EC, 'P1', { reason_type: 'promotion' }),
    row('R-A4', S1, EA, 'P1'), row('R-A5', S1, EA, 'P1'), row('R-A6', S1, EA, 'P1'),
  ], { period: P10 })
  const r = await finalize(db, b, U.mkt, TODAY)
  ok(r.status === 'committed', 'fixture: import 6 khách T10 committed', S(r))
  const bt = await stage(db, [row('R-T1', S1, EA, 'P1', { reason_type: 'chi-thu' })], { period: P10, isTest: true })
  ok((await finalize(db, bt, U.mkt, TODAY)).status === 'committed', 'fixture: batch is_test committed')
}

section('GHI LƯỢT NO_NEED (RPC care__record_interaction_at — không sửa thân hàm)')
{
  const t = await taskOf(db, 'R-A4', P10)
  ok(await raises(record(db, TODAY, U.A, t.id, 'NO_NEED'), 'bắt buộc ngày hẹn') === true, 'NO_NEED thiếu ngày ⇒ từ chối')
  ok(await raises(record(db, TODAY, U.A, t.id, 'NO_NEED', 'x', '2026-10-04'), 'ngày hẹn phải từ hôm nay') === true, 'NO_NEED ngày trước hôm nay ⇒ từ chối')
  ok(await raises(record(db, TODAY, U.A, t.id, 'NO_NEED', 'x', '2026-11-01'), 'ngày hẹn phải từ hôm nay') === true, 'NO_NEED ngày sau hạn task ⇒ từ chối')
  ok(await count(db, `SELECT count(*) FROM public.care_interactions WHERE task_id = $1`, [t.id]) === 0, 'ba lần bị từ chối không ghi lượt nào')
  const r = await record(db, TODAY, U.A, t.id, 'NO_NEED', 'chưa cần, hẹn lại', '2026-10-12')
  const i = await one(db, `SELECT outcome, is_terminal, next_action_date::text d FROM public.care_interactions WHERE task_id = $1`, [t.id])
  const tt = await one(db, `SELECT status, last_outcome, next_action_date::text d, completed_at, last_interaction_at FROM public.care_tasks WHERE id = $1`, [t.id])
  ok(r.status === 'open' && i.outcome === 'NO_NEED' && i.is_terminal === false && i.d === '2026-10-12', 'ngày hợp lệ ⇒ lượt lưu is_terminal = false + ngày hẹn', S({ r, i }))
  ok(tt.status === 'open' && tt.last_outcome === 'NO_NEED' && tt.d === '2026-10-12' && tt.completed_at === null && tt.last_interaction_at !== null,
     'task còn mở (Đang theo dõi), ngày hẹn hiện hành = ngày vừa chọn', S(tt))
  ok(await count(db, `SELECT count(*) FROM public.care_reconcile_queue WHERE customer_id = $1`, [t.customer_id]) === 0, 'lượt NO_NEED mới KHÔNG vào hàng đợi ghi công (chỉ lượt kết thúc)')
  ok(await count(db, `SELECT count(*) FROM public.care_store_refusals WHERE customer_id = $1`, [t.customer_id]) === 0, 'không ghi từ chối tại cửa hàng')
  // Ghi tiếp: NO_NEED lần hai đổi ngày hẹn; rồi lượt kết thúc đóng task.
  const r2 = await record(db, '2026-10-12', U.A, t.id, 'NO_NEED', 'vẫn chưa cần', '2026-10-20')
  ok(r2.status === 'open' && (await one(db, `SELECT next_action_date::text d FROM public.care_tasks WHERE id = $1`, [t.id])).d === '2026-10-20', 'ghi lượt tiếp (NO_NEED lần 2) ⇒ ngày hẹn hiện hành đổi')
  const r3 = await record(db, '2026-10-20', U.A, t.id, 'ORDERED', 'đã đặt')
  ok(r3.status === 'completed' && await count(db, `SELECT count(*) FROM public.care_interactions WHERE task_id = $1`, [t.id]) === 3
     && await count(db, `SELECT count(*) FROM public.care_reconcile_queue WHERE customer_id = $1`, [t.customer_id]) === 1, 'lượt kết thúc sau đó ⇒ Hoàn thành + vào hàng đợi ghi công', S(r3))
  // Biên: hôm nay và đúng hạn.
  const t5 = await taskOf(db, 'R-A5', P10), t6 = await taskOf(db, 'R-A6', P10)
  ok((await record(db, TODAY, U.A, t5.id, 'NO_NEED', 'x', TODAY)).status === 'open', 'biên: ngày hẹn = hôm nay ⇒ nhận')
  ok((await record(db, TODAY, U.A, t6.id, 'NO_NEED', 'x', DUE)).status === 'open', 'biên: ngày hẹn = hạn task ⇒ nhận')
  // Các outcome khác không đổi luật.
  const t2 = await taskOf(db, 'R-A2', P10)
  ok(await raises(record(db, TODAY, U.A, t2.id, 'INTERESTED', 'x', '2026-10-09'), 'không nhận ngày hẹn') === true, 'INTERESTED kèm ngày ⇒ vẫn từ chối (luật cũ giữ)')
  ok(await raises(record(db, TODAY, U.A, t2.id, 'CALLBACK'), 'bắt buộc ngày hẹn') === true, 'CALLBACK thiếu ngày ⇒ vẫn từ chối')
  // Điều kiện "Hẹn hôm nay" (lib/care/my.ts applyMyTaskFilters due_today): mở + next_action_date = hôm nay, đúng dược sĩ + store.
  const due = (uid, sid, day) => count(db, `SELECT count(*) FROM public.care_tasks WHERE assignee_id = $1 AND store_id = $2 AND period_month = $3 AND is_test = false AND status = 'open' AND next_action_date = $4`, [uid, sid, P10, day])
  ok(await due(U.A, storeId(1), TODAY) === 1 && await due(U.A, storeId(1), DUE) === 1 && await due(U.B, storeId(1), TODAY) === 0 && await due(U.A, storeId(1), '2026-10-20') === 0,
     'đếm "hẹn hôm nay": đúng người / đúng ngày; task đã Hoàn thành (hẹn 20/10 rồi đặt đơn) không còn trong danh sách')
}

section('DỮ LIỆU CŨ — lượt NO_NEED kết thúc trước 133 giữ nguyên (không backfill)')
{
  const d = await L.freshDb(PGlite, { through: '116' })
  const b = await stage(d, [row('OLD-1', S1, EA, 'P1'), row('OLD-2', S1, EA, 'P1')], { period: P10 })
  await finalize(d, b, U.mkt, TODAY)
  const t1 = await taskOf(d, 'OLD-1', P10)
  ok((await record(d, TODAY, U.A, t1.id, 'NO_NEED', 'luật cũ')).status === 'completed', 'trước 133: NO_NEED không ngày ⇒ Hoàn thành (luật 114)')
  const before = await one(d, `SELECT (SELECT count(*) FROM public.care_interactions WHERE outcome = 'NO_NEED' AND is_terminal)::int i, (SELECT count(*) FROM public.care_tasks WHERE status = 'completed')::int t, (SELECT count(*) FROM public.care_reconcile_queue)::int q`)
  await L.apply133(d)
  const after = await one(d, `SELECT (SELECT count(*) FROM public.care_interactions WHERE outcome = 'NO_NEED' AND is_terminal)::int i, (SELECT count(*) FROM public.care_tasks WHERE status = 'completed')::int t, (SELECT count(*) FROM public.care_reconcile_queue)::int q,
    (SELECT count(*) FROM public.care_interactions WHERE outcome = 'NO_NEED' AND NOT is_terminal)::int n`)
  ok(before.i === 1 && after.i === 1 && after.t === before.t && after.q === before.q && after.n === 0, 'sau 133: lượt cũ vẫn is_terminal, task vẫn Hoàn thành, hàng đợi ghi công không đổi', S({ before, after }))
  ok(await raises(record(d, TODAY, U.A, t1.id, 'NO_NEED', 'x', '2026-10-09'), 'task đã kết thúc') === true, 'task đã Hoàn thành bằng NO_NEED cũ không mở lại')
  const t2 = await taskOf(d, 'OLD-2', P10)
  ok((await record(d, TODAY, U.A, t2.id, 'NO_NEED', 'luật mới', '2026-10-09')).status === 'open', 'sau 133: task khác ghi NO_NEED theo luật mới (còn mở)')
  // Rollback bị từ chối khi đã có lượt kiểu mới; dữ liệu + hàm giữ nguyên.
  ok(await raises(d.exec(L.ROLLBACK_133), 'lượt NO_NEED kiểu mới') === true, 'rollback 133 khi đã có lượt NO_NEED kiểu mới ⇒ RAISE (PM quyết dữ liệu trước)')
  await d.exec('ROLLBACK')
  ok((await truth(d)).find((r) => r.x === 'NO_NEED').d === true && await count(d, `SELECT count(*) FROM public.app_migrations WHERE version = '133'`) === 1, 'rollback bị từ chối ⇒ 133 còn nguyên')
}

section('care_reason_options — phạm vi theo RLS của người gọi')
{
  await db.query(`INSERT INTO public.sm_store_assignments (sm_user_id, store_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [U.sm2, storeId(1)])
  const keys = (rows) => rows.map((r) => r.reason_key)
  const all = await reasons(db, U.mkt)
  ok(S(keys(all)) === S(['chronic', 'promotion', 'tái khám (đợt 2)*']), 'Marketing: đủ khoá của kỳ, đã gộp hoa / thường, không có lý do của batch thử', S(all))
  ok(all.every((r) => careReasonKey(r.reason_label) === r.reason_key), 'reason_label là một nguyên văn theo file của đúng khoá đó (TS careReasonKey khớp SQL lower(btrim))')
  ok(careReasonLabel('chronic', all.find((r) => r.reason_key === 'chronic').reason_label) === 'Mãn tính' && careReasonLabel('promotion') === 'Khuyến mãi'
     && careReasonLabel('tái khám (đợt 2)*', 'Tái khám (đợt 2)*') === 'Tái khám (đợt 2)*', 'nhãn: Chronic → Mãn tính · Promotion → Khuyến mãi · ngoài mẫu hiện theo file')
  ok(S(keys(await reasons(db, U.super))) === S(keys(all)), 'super: như Marketing')
  ok(S(keys(await reasons(db, U.sm))) === S(keys(all)), 'SM (store 1 + 2): thấy lý do của hai store')
  ok(S(keys(await reasons(db, U.sm2))) === S(['chronic', 'promotion', 'tái khám (đợt 2)*']), 'SM2 (chỉ store 1): lý do của store 1')
  ok(S(keys(await reasons(db, U.C))) === S(['promotion']), 'dược sĩ store 2: chỉ lý do task của mình')
  ok(S(keys(await reasons(db, U.B))) === S(['tái khám (đợt 2)*']), 'dược sĩ B store 1: chỉ lý do task của mình (không thấy của A)')
  ok((await reasons(db, U.ops)).length === 0 && (await reasons(db, U.qlch1)).length === 0, 'admin phòng khác / QLCH: 0 dòng (RLS)')
  ok((await reasons(db, U.mkt, '2026-09-01')).length === 0, 'kỳ khác: 0 dòng')
  ok(S(keys(await reasons(db, U.super, P10, true))) === S(['chi-thu']), 'p_is_test = true: chỉ lý do của dữ liệu thử (super đọc được)')
  // Sản phẩm cũ (is_current = false) không tạo lựa chọn.
  const a2 = await taskOf(db, 'R-A2', P10)
  await db.query(`INSERT INTO public.care_task_products (task_id, batch_id, product_id, product_name, reason_type, reason_text, is_current) VALUES ($1, $2, 'P-CU', 'SP cũ', 'ly-do-cu', 'x', false)`, [a2.id, a2.batch_id])
  ok(!keys(await reasons(db, U.mkt)).includes('ly-do-cu'), 'lý do của sản phẩm is_current = false không vào danh sách')
  ok(S(keys(await reasons(db, U.mkt, '2026-10-17'))) === S(keys(all)), 'kỳ truyền ngày giữa tháng ⇒ chuẩn hoá về đầu tháng (care_period_of)')
  ok(await raises(reasons(db, null, P10, false, 'service_role'), 'permission denied') === true, 'service_role ⇒ permission denied (ma trận PM 23/11: chỉ authenticated)')
  // authenticated nhưng KHÔNG có danh tính (auth.uid() rỗng) ⇒ 0 dòng — hàm SECDEF không mở rộng phạm vi.
  ok((await reasons(db, null, P10, false, 'authenticated')).length === 0, 'authenticated không có auth.uid() ⇒ 0 dòng')
  // Nhãn = biến thể nhỏ nhất theo thứ tự byte (COLLATE "C") — khớp phép chọn của app.
  const a3 = await taskOf(db, 'R-A3', P10)
  await db.query(`INSERT INTO public.care_task_products (task_id, batch_id, product_id, product_name, reason_type, reason_text) VALUES ($1, $2, 'P-HT', 'SP hoa thường', 'tái khám (đợt 2)*', 'x')`, [a3.id, a3.batch_id])
  ok((await reasons(db, U.mkt)).find((r) => r.reason_key === 'tái khám (đợt 2)*').reason_label === 'Tái khám (đợt 2)*', 'hai biến thể hoa / thường ⇒ nhãn chọn theo thứ tự byte (chữ hoa trước) như careTaskReasons')
  // PHẠM VI: danh sách lựa chọn của hàm SECDEF = đúng tập đọc được qua RLS, từng vai.
  const viewers = [['Marketing', U.mkt], ['super', U.super], ['SM', U.sm], ['SM2', U.sm2], ['dược sĩ A', U.A], ['dược sĩ B', U.B], ['dược sĩ C', U.C], ['admin phòng khác', U.ops], ['QLCH', U.qlch1], ['QLCH FS', U.qlchFs]]
  const optBad = []
  for (const [name, who] of viewers) { const f = keys(await reasons(db, who)), r = await optionsRls(db, who); if (S(f) !== S(r)) optBad.push([name, f, r]) }
  ok(optBad.length === 0, 'care_reason_options = tập lý do đọc qua RLS, đủ 10 vai (không rộng hơn, không hẹp hơn)', S(optBad))
}

section('care_tasks_by_reason — lọc trước phân trang, phạm vi = RLS của người gọi')
{
  const idOf = async (ext) => (await taskOf(db, ext, P10)).id
  const A1 = await idOf('R-A1'), A2 = await idOf('R-A2'), A3 = await idOf('R-A3'), C1 = await idOf('R-C1')
  const sorted = (xs) => [...xs].sort()
  const chronic = await byReason(db, U.mkt, 'chronic')
  ok(chronic.length === 5 && chronic.includes(A1) && chronic.includes(A2) && !chronic.includes(A3) && !chronic.includes(C1), 'chronic: 5 task (gộp Chronic / chronic); task hai lý do có mặt MỘT lần', S(chronic.length))
  ok(new Set(chronic).size === chronic.length, 'mỗi task tối đa một dòng (task có nhiều sản phẩm cùng lý do không nhân dòng)')
  ok(S(await byReason(db, U.mkt, 'promotion')) === S(sorted([A1, C1])), 'promotion: A1 (hai lý do) + C1')
  ok(S(await byReason(db, U.mkt, ' Promotion ')) === S(sorted([A1, C1])), 'tham số hoa / khoảng trắng ⇒ cùng phép chuẩn hoá lower(btrim)')
  ok(S(await byReason(db, U.mkt, 'tái khám (đợt 2)*')) === S([A3]), 'lý do ngoài mẫu có ký tự đặc biệt: khớp đúng nguyên chuỗi')
  for (const k of ['ly-do-cu', 'chr', '.*', '%', 'chronic%', '']) ok((await byReason(db, U.mkt, k)).length === 0, `"${k}": 0 dòng (sản phẩm cũ / tiền tố / wildcard / rỗng không khớp nhầm)`)
  ok((await as(db, U.mkt, async () => (await db.query(`SELECT count(*)::int n FROM public.care_tasks_by_reason($1, NULL, false)`, [P10])).rows[0].n)) === 0, 'lý do NULL ⇒ 0 dòng (không trả cả kỳ)')
  ok((await byReason(db, U.mkt, 'chronic', '2026-09-01')).length === 0 && S(await byReason(db, U.mkt, 'chronic', '2026-10-20')) === S(chronic), 'kỳ khác ⇒ 0; ngày giữa tháng ⇒ chuẩn hoá về kỳ')
  ok((await byReason(db, U.super, 'chi-thu', P10, true)).length === 1 && (await byReason(db, U.super, 'chi-thu')).length === 0, 'p_is_test tách dữ liệu thử')
  ok(await raises(byReason(db, null, 'chronic', P10, false, 'service_role'), 'permission denied') === true, 'service_role ⇒ permission denied')
  ok((await byReason(db, null, 'chronic', P10, false, 'authenticated')).length === 0, 'authenticated không có auth.uid() ⇒ 0 dòng')
  // PHẠM VI: kết quả hàm = đúng tập đọc THẲNG bảng dưới RLS, từng vai × từng lý do.
  const viewers = [['Marketing', U.mkt], ['super', U.super], ['SM', U.sm], ['SM2', U.sm2], ['dược sĩ A', U.A], ['dược sĩ B', U.B], ['dược sĩ C', U.C], ['admin phòng khác', U.ops], ['QLCH', U.qlch1], ['QLCH FS', U.qlchFs]]
  const bad = []
  let nonEmpty = 0
  for (const [name, who] of viewers) for (const k of ['chronic', 'promotion', 'tái khám (đợt 2)*']) {
    const f = await byReason(db, who, k), r = await byReasonRls(db, who, k)
    if (S(f) !== S(r)) bad.push([name, k, f.length, r.length])
    if (f.length) nonEmpty++
  }
  ok(bad.length === 0 && nonEmpty >= 10, 'care_tasks_by_reason = tập đọc qua RLS cho 10 vai × 3 lý do (không rộng hơn, không hẹp hơn)', S(bad))
  // PM 23/11 §4 e: đúng câu VERIFY V6 của file 133 — hiệu TẬP ID hai chiều trong MỘT câu, dưới session bị giới hạn, cả dữ liệu thử.
  const v6 = (uid, reason, isTest = false) => as(db, uid, async () => (await db.query(`WITH f AS (SELECT id FROM public.care_tasks_by_reason($1, $2, $3)),
      r AS (SELECT t.id FROM public.care_tasks t WHERE t.period_month = $1 AND t.is_test = $3
             AND EXISTS (SELECT 1 FROM public.care_task_products p WHERE p.task_id = t.id AND p.is_current AND lower(btrim(p.reason_type)) = $2))
    SELECT (SELECT count(*) FROM f)::int qua_ham, (SELECT count(*) FROM r)::int qua_rls,
           (SELECT count(*) FROM (SELECT id FROM f EXCEPT SELECT id FROM r) x)::int ham_tru_rls,
           (SELECT count(*) FROM (SELECT id FROM r EXCEPT SELECT id FROM f) x)::int rls_tru_ham`, [P10, reason, isTest])).rows[0])
  const v6bad = []
  let v6rows = 0
  for (const [name, who] of viewers) for (const [k, t] of [['chronic', false], ['promotion', false], ['tái khám (đợt 2)*', false], ['chi-thu', true]]) {
    const x = await v6(who, k, t)
    v6rows += x.qua_ham
    if (x.ham_tru_rls !== 0 || x.rls_tru_ham !== 0 || x.qua_ham !== x.qua_rls) v6bad.push([name, k, x])
  }
  ok(v6bad.length === 0 && v6rows > 0, 'VERIFY V6 (tập ID hai chiều, cùng kỳ / lý do / is_test, session bị giới hạn): 10 vai × 4 lý do đều 0 / 0', S(v6bad))
  // Đối chứng âm của chính phép V6: nới phạm vi hàm (bỏ vế store của dược sĩ) ⇒ V6 PHẢI thấy lệch — rồi nạp lại 133 đúng.
  await db.query(`UPDATE public.users SET store_id = $1 WHERE id = $2`, [storeId(2), U.B])
  await db.exec(`CREATE OR REPLACE FUNCTION public.care_tasks_by_reason(p_period date, p_reason text, p_is_test boolean DEFAULT false)
    RETURNS SETOF public.care_tasks LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$
    SELECT t.* FROM public.care_tasks t WHERE t.period_month = public.care_period_of(p_period) AND t.is_test = COALESCE(p_is_test, false)
      AND (t.assignee_id = (select public.care_assignee_uid()) OR (select public.care_can_view_all()) OR t.store_id = ANY ((select public.care_scope_store_ids())::uuid[]))
      AND EXISTS (SELECT 1 FROM public.care_task_products p WHERE p.task_id = t.id AND p.is_current AND lower(btrim(p.reason_type)) = lower(btrim(p_reason))) $f$`)
  const wide = await v6(U.B, 'tái khám (đợt 2)*')
  ok(wide.ham_tru_rls === 1 && wide.rls_tru_ham === 0, 'đối chứng âm: hàm bị nới phạm vi (bỏ vế store) ⇒ V6 báo ham_tru_rls = 1 (phép so số đếm ≤ của r1 không bắt được)', S(wide))
  await db.exec(L.MIGRATION_133)
  const back = await v6(U.B, 'tái khám (đợt 2)*')
  ok(back.ham_tru_rls === 0 && back.rls_tru_ham === 0 && back.qua_ham === 0, 'nạp lại 133 ⇒ V6 về 0 / 0', S(back))
  await db.query(`UPDATE public.users SET store_id = $1 WHERE id = $2`, [storeId(1), U.B])
  ok((await byReason(db, U.C, 'chronic')).length === 0 && S(await byReason(db, U.C, 'promotion')) === S([C1]) && S(await byReason(db, U.B, 'tái khám (đợt 2)*')) === S([A3]) && (await byReason(db, U.qlch1, 'chronic')).length === 0,
     'dược sĩ chỉ task của mình; QLCH 0 dòng')
  // Q-82: dược sĩ đổi cửa hàng ⇒ mất task ở cửa hàng cũ, cả qua hàm.
  await db.query(`UPDATE public.users SET store_id = $1 WHERE id = $2`, [storeId(2), U.B])
  ok((await byReason(db, U.B, 'tái khám (đợt 2)*')).length === 0 && (await byReasonRls(db, U.B, 'tái khám (đợt 2)*')).length === 0, 'dược sĩ chuyển store: hàm và RLS cùng trả 0')
  await db.query(`UPDATE public.users SET store_id = $1 WHERE id = $2`, [storeId(1), U.B])
  // Cột trả về = đúng cột care_tasks ⇒ app lọc / sắp / đếm tiếp như trên bảng.
  const cols = await as(db, U.mkt, async () => (await db.query(`SELECT * FROM public.care_tasks_by_reason($1, 'chronic', false) WHERE status = 'open' ORDER BY created_at DESC, id DESC LIMIT 2`, [P10])).fields.map((f) => f.name))
  const tcols = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'care_tasks' ORDER BY ordinal_position`)).rows.map((r) => r.column_name)
  ok(S(cols) === S(tcols), 'RETURNS SETOF care_tasks: đủ cột của bảng, lọc status / sắp created_at, id chạy được trên kết quả')
  ok(typeof careReasonKey === 'function' && careReasonKey(' Chronic ') === 'chronic', 'app gửi khoá careReasonKey (trim + chữ thường) làm p_reason')
}

section('ROLLBACK 133 (DB chưa có lượt kiểu mới) + nạp lại')
{
  const d = await L.freshDbLatest(PGlite)
  await d.exec(L.ROLLBACK_133)
  const rows = await truth(d)
  const nn = rows.find((r) => r.x === 'NO_NEED')
  ok(nn.t === true && nn.d === false && rows.filter((r) => r.t).map((r) => r.x).sort().join() === 'INTERESTED,NO_NEED,ORDERED,REFUSED', 'rollback: bảng chân trị về 114')
  ok(await count(d, `SELECT count(*) FROM pg_proc WHERE proname IN ('care_reason_options', 'care_tasks_by_reason')`) === 0 && await count(d, `SELECT count(*) FROM public.app_migrations WHERE version = '133'`) === 0, 'rollback: gỡ hai hàm lý do + dòng app_migrations 133')
  for (const f of FNS.slice(0, 2)) { const a = await acl(d, f); ok(a.a === false && a.u === true && a.s === true && a.pub === 0 && a.secdef === false && a.vol === 'i', `rollback: ACL + thuộc tính ${f} như 114`, S(a)) }
  // PM 23/11 §4 g: hậu kiểm rollback phải thấy ĐỦ hai hàm biến mất — còn sót một hàm (kể cả chữ ký khác) ⇒ RAISE, không gỡ marker.
  {
    const e = await L.freshDbLatest(PGlite)
    await e.exec(`CREATE FUNCTION public.care_tasks_by_reason(p text) RETURNS int LANGUAGE sql AS $f$ SELECT 1 $f$`)
    ok(await raises(e.exec(L.ROLLBACK_133), 'hàm lọc lý do còn tồn tại') === true, 'rollback: còn sót hàm care_tasks_by_reason (chữ ký khác) ⇒ RAISE')
    await e.exec('ROLLBACK')
    ok(await count(e, `SELECT count(*) FROM public.app_migrations WHERE version = '133'`) === 1 && (await truth(e)).find((r) => r.x === 'NO_NEED').d === true, 'rollback bị chặn ⇒ marker 133 + luật 133 còn nguyên (không dở dang)')
    // Lượt NO_NEED kiểu mới của DỮ LIỆU THỬ cũng chặn rollback (PM 23/11 §4 f — không xoá lượt QA để vượt rào).
    await e.exec(`DROP FUNCTION public.care_tasks_by_reason(text)`)
    const bt = await stage(e, [row('RB-T1', S1, EA, 'P1')], { period: P10, isTest: true })
    await finalize(e, bt, U.mkt, TODAY)
    const tt = await one(e, `SELECT t.id FROM public.care_tasks t JOIN public.care_customers c ON c.id = t.customer_id WHERE c.external_id = 'RB-T1'`)
    await record(e, TODAY, U.A, tt.id, 'NO_NEED', 'QA', '2026-10-09')
    ok(await raises(e.exec(L.ROLLBACK_133), 'lượt NO_NEED kiểu mới') === true, 'rollback: chỉ có lượt NO_NEED kiểu mới của dữ liệu thử (is_test) ⇒ vẫn RAISE')
    await e.exec('ROLLBACK')
    const r0 = await one(e, `SELECT count(*)::int n, (count(*) FILTER (WHERE t.is_test))::int qa FROM public.care_interactions i JOIN public.care_tasks t ON t.id = i.task_id WHERE i.outcome = 'NO_NEED' AND NOT i.is_terminal`)
    ok(r0.n === 1 && r0.qa === 1, 'câu R0 (kiểm trước khi hạ app) đếm đúng 1 lượt kiểu mới, 1 của dữ liệu thử', S(r0))
  }
  ok(await raises(d.exec(L.ROLLBACK_133), 'chưa có migration 133') === true, 'rollback lần hai ⇒ RAISE')
  await d.exec('ROLLBACK')
  try { await d.exec(L.MIGRATION_133); ok((await truth(d)).find((r) => r.x === 'NO_NEED').d === true, 'nạp lại 133 sau rollback thành công') } catch (e) { ok(false, 'nạp lại 133 sau rollback', e.message) }
}

console.log(`\n${pass} đạt · ${fail} lỗi`)
process.exitCode = fail ? 1 : 0
