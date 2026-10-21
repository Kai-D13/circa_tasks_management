// QA EXECUTABLE cho migration 115 (CRM-CSKH D1 — huỷ import N1 chưa có lượt) trên PGlite (Postgres 16 WASM) + 114 thật.
// Không đụng DB thật; pglite cài --no-save.
//
//   cd webapp
//   npm i --no-save @electric-sql/pglite@0.2.17     # một lần
//   node scripts/qa-care-115.mjs                    # kỳ vọng: N đạt · 0 lỗi
//
// Bao phủ (thiết kế D0 r1.5 §8): provenance (created_batch_id, commit_seq, journal = summary.updated) · huỷ initial / revision
// khôi phục chính xác · huỷ tuần tự + expectedCommitSeq · nạp lại file đã huỷ · từ chối (quyền, không mới nhất, không committed,
// kỳ / biên tháng, trước 115, hoạt động, journal thiếu/lệch) ⇒ 0 thay đổi · trigger + token + owner · guard batch · ACL 115 ·
// regression dưới service_role (createBatch / stage / finalize / discard / purge / fixture is_test + CASCADE journal) ·
// đóng kỳ dọn journal kỳ trước (k task ≠ m journal) · summary không PII · rollback có/không batch cancelled + chạy lại 115.
// GIỚI HẠN: PGlite một session ⇒ race hai transaction thật chạy trên DB thật bằng fixture is_test (operator).
import crypto from 'node:crypto'
import * as L from './lib-care-pglite.mjs'

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
const { U, row, one, count, raises, setUid, as, stage, finalize, record, transfer, taskOf, EA, EB, EC, storeId } = L
const S1 = L.STORES[0].code, S2 = L.STORES[1].code

// Kỳ theo ngày VN THẬT (wrapper dùng care_vn_today()).
const todayVN = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date())
const P = `${todayVN.slice(0, 7)}-01`
const prevLast = (() => { const d = new Date(`${P}T00:00:00Z`); d.setUTCDate(0); return d.toISOString().slice(0, 10) })()
const PP = `${prevLast.slice(0, 7)}-01`
const nextMonthTs = (() => { const d = new Date(`${P}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCHours(5); return d.toISOString() })()
const nowTs = new Date().toISOString()

// E (116): gate huỷ đòi đơn N3 đã đối chiếu sau import ⇒ trước mỗi lần huỷ / xem trước chạy một lượt thường 0 đơn (no-op trên 115).
const V116 = L.THROUGH_DEFAULT === '116'
const synced = (db) => (V116 ? L.syncOrders116(db) : null)
const cancel = async (db, b, actor, expected, { today = todayVN, now = nowTs } = {}) => (await synced(db),
  (await one(db, `SELECT public.care__import_cancel_at($1, $2, $3::bigint, $4::date, $5::timestamptz) AS r`, [b, actor, expected, today, now])).r)
const preview = async (db, b, actor, today = todayVN) => (await synced(db),
  (await one(db, `SELECT public.care__import_cancel_preview_at($1, $2, $3::date) AS r`, [b, actor, today])).r)
const seqOf = async (db, b) => (await one(db, `SELECT commit_seq::text AS s FROM public.care_import_batches WHERE id = $1`, [b])).s
// Ảnh chụp toàn bộ dữ liệu nghiệp vụ (để chứng minh "0 thay đổi" khi từ chối).
const snap = async (db) => (await one(db, `SELECT md5(concat_ws('|',
    (SELECT string_agg(id::text || status || customer_name || phone_norm || batch_id::text, ',' ORDER BY id) FROM public.care_tasks),
    (SELECT string_agg(id::text || is_current::text || batch_id::text, ',' ORDER BY id) FROM public.care_task_products),
    (SELECT string_agg(id::text, ',' ORDER BY id) FROM public.care_customers),
    (SELECT string_agg(id::text || status || COALESCE(commit_seq::text, '-'), ',' ORDER BY id) FROM public.care_import_batches),
    (SELECT string_agg(id::text, ',' ORDER BY id) FROM public.care_import_revision_journal),
    (SELECT string_agg(id::text || kind, ',' ORDER BY id) FROM public.care_assignment_events),
    (SELECT count(*)::text FROM public.care_cancel_tokens))) AS h`)).h
const currentProducts = async (db, taskId) =>
  (await db.query(`SELECT id FROM public.care_task_products WHERE task_id = $1 AND is_current ORDER BY id`, [taskId])).rows.map((r) => r.id)

// Bộ file giả: B1 initial (c1 2 SP, c2, c3), B2 revision (c1 đổi SP, c2 đổi tên, c3 vắng, c4 mới).
const ext = (n, tag) => `QA115-${tag}-${n}`
const fileB1 = (tag, store = S1, email = EA) => [
  row(ext(1, tag), store, email, '1101'), row(ext(1, tag), store, email, '1102'),
  row(ext(2, tag), store, email, '1201'), row(ext(3, tag), store, email, '1301')]
const fileB2 = (tag, store = S1, email = EA) => [
  row(ext(1, tag), store, email, '1103'),
  row(ext(2, tag), store, email, '1201', { customer_name: `KH ${ext(2, tag)} đổi tên` }),
  row(ext(4, tag), store, email, '1401')]

// ════════════════════════════════════════════════════════════════════════════
section(`PROVENANCE (kỳ ${P}, migration 114 + 115)`)
let db = await L.freshDb(PGlite)
const b1 = await stage(db, fileB1('a'), { period: P })
const r1 = await finalize(db, b1, U.mkt, todayVN)
ok(r1.status === 'committed' && r1.kind === 'initial' && r1.created === 3, 'B1 initial 3 khách', JSON.stringify(r1))
const m1 = await one(db, `SELECT provenance_version, commit_seq::text s, journal_rows, (summary->>'updated')::int upd FROM public.care_import_batches WHERE id = $1`, [b1])
ok(m1.provenance_version === 1 && m1.s && m1.journal_rows === 0 && m1.upd === 0, 'B1: provenance_version=1, commit_seq có, journal_rows=0=summary.updated', JSON.stringify(m1))
ok(await count(db, `SELECT count(*) FROM public.care_customers WHERE created_batch_id = $1`, [b1]) === 3, 'B1: 3 khách mới có created_batch_id = B1')
const t1 = await taskOf(db, ext(1, 'a'), P), t2 = await taskOf(db, ext(2, 'a'), P), t3 = await taskOf(db, ext(3, 'a'), P)
const t1ProdsB1 = await currentProducts(db, t1.id)
const t2NameB1 = t2.customer_name
const b2 = await stage(db, fileB2('a'), { period: P })
const r2 = await finalize(db, b2, U.mkt, todayVN)
ok(r2.status === 'committed' && r2.kind === 'revision' && r2.created === 1 && r2.updated === 2 && r2.absent_kept === 1, 'B2 revision: 1 mới, 2 cập nhật, 1 vắng giữ', JSON.stringify(r2))
const m2 = await one(db, `SELECT commit_seq s, journal_rows, (summary->>'updated')::int upd FROM public.care_import_batches WHERE id = $1`, [b2])
ok(m2.journal_rows === 2 && m2.upd === 2, 'B2: journal_rows = summary.updated = 2', JSON.stringify(m2))
ok(BigInt(m2.s) > BigInt(m1.s), 'commit_seq(B2) > commit_seq(B1) — tăng theo thứ tự commit')
const j = (await db.query(`SELECT task_id, products_replaced, cardinality(prev_product_row_ids) n, prev_customer_name, new_customer_name
  FROM public.care_import_revision_journal WHERE batch_id = $1 ORDER BY task_id`, [b2])).rows
const j1 = j.find((x) => x.task_id === t1.id), j2 = j.find((x) => x.task_id === t2.id)
ok(j.length === 2 && j1 && j1.products_replaced && Number(j1.n) === 2 && j2 && !j2.products_replaced && Number(j2.n) === 0
   && j2.prev_customer_name === t2NameB1 && j2.new_customer_name.endsWith('đổi tên'), 'journal B2: c1 thay SP (2 dòng trước), c2 chỉ snapshot (before/after tên)', JSON.stringify(j))
ok(!j.some((x) => x.task_id === t3.id), 'c3 vắng file ⇒ không journal')
const t4 = await taskOf(db, ext(4, 'a'), P)
ok(t4 && t4.batch_id === b2 && await count(db, `SELECT count(*) FROM public.care_customers WHERE created_batch_id = $1`, [b2]) === 1, 'c4 mới: task batch_id = B2, khách created_batch_id = B2')

section('PREVIEW + HUỶ REVISION (khôi phục chính xác)')
const pv2 = await preview(db, b2, U.mkt)
ok(pv2.status === 'ready' && pv2.commit_seq === String(m2.s) && typeof pv2.commit_seq === 'string'
   && pv2.tasks_deleted === 1 && pv2.tasks_restored === 2 && pv2.customers_deleted === 1, 'preview B2: commit_seq là CHUỖI, 1 task xoá, 2 hoàn nguyên, 1 khách xoá', JSON.stringify(pv2))
const pv1early = await preview(db, b1, U.mkt)
ok(pv1early.status === 'rejected' && pv1early.code === 'NOT_LATEST', 'preview B1 khi B2 là mới nhất ⇒ NOT_LATEST')
let s0 = await snap(db)
let rr = await cancel(db, b2, U.mkt, String(BigInt(m2.s) + 1n))
ok(rr.status === 'rejected' && rr.code === 'NOT_LATEST' && await snap(db) === s0, 'expectedCommitSeq lệch ⇒ NOT_LATEST, 0 thay đổi', JSON.stringify(rr))
ok(await raises(db.query(`SELECT public.care__import_cancel_at($1, $2, NULL, $3::date, NULL)`, [b2, U.mkt, todayVN]), 'thiếu tham số') === true, 'expectedCommitSeq NULL ⇒ RAISE thiếu tham số (trước ghi)')
rr = await cancel(db, b1, U.mkt, m1.s)
ok(rr.status === 'rejected' && rr.code === 'NOT_LATEST' && await snap(db) === s0, 'huỷ B1 khi B2 còn là mới nhất ⇒ NOT_LATEST, 0 thay đổi')
rr = await cancel(db, b2, U.mkt, pv2.commit_seq)
ok(rr.status === 'cancelled' && rr.tasks_deleted === 1 && rr.tasks_restored === 2 && rr.customers_deleted === 1 && rr.products_restored === 2,
   'huỷ B2 ⇒ cancelled + số đếm khớp preview', JSON.stringify(rr))
ok(JSON.stringify(await currentProducts(db, t1.id)) === JSON.stringify(t1ProdsB1), 'c1: sản phẩm hiện hành = đúng các dòng của B1')
ok((await taskOf(db, ext(2, 'a'), P)).customer_name === t2NameB1, 'c2: tên trả về trước revision')
ok(!(await taskOf(db, ext(4, 'a'), P)) && await count(db, `SELECT count(*) FROM public.care_customers WHERE external_id = $1`, [ext(4, 'a')]) === 0, 'c4: task + khách do B2 tạo đã xoá')
ok(await count(db, `SELECT count(*) FROM public.care_import_revision_journal WHERE batch_id = $1`, [b2]) === 0
   && await count(db, `SELECT count(*) FROM public.care_cancel_tokens`) === 0, 'journal B2 + token đã xoá')
const mb2 = await one(db, `SELECT status, cancelled_by, cancelled_at IS NOT NULL ca, file_name, file_sha256, summary FROM public.care_import_batches WHERE id = $1`, [b2])
ok(mb2.status === 'cancelled' && mb2.cancelled_by === U.mkt && mb2.ca && mb2.summary.cancel && mb2.summary.updated === 2 && mb2.file_name === 'qa.xlsx',
   'batch B2: cancelled + người/thời điểm; summary gốc giữ + cancel; file_name giữ nguyên', JSON.stringify(mb2.summary))
// [116] assess thêm orders_checked_at (mốc coverage nhỏ nhất của T_new ∪ T_mod — chuỗi thời điểm, không PII).
const cancelKeys = 'customers_deleted,events_deleted,products_deleted,products_restored,tasks_deleted,tasks_restored'
ok(Object.keys(mb2.summary.cancel).filter((k) => !(V116 && k === 'orders_checked_at')).sort().join(',') === cancelKeys
   && Object.entries(mb2.summary.cancel).every(([k, v]) => (V116 && k === 'orders_checked_at' ? typeof v === 'string' : typeof v === 'number')),
   V116 ? 'summary.cancel đúng 6 số đếm + [116] orders_checked_at' : 'summary.cancel đúng 6 số đếm')

section('HUỶ TUẦN TỰ B1 + NẠP LẠI FILE ĐÃ HUỶ (Q-153, Q-163)')
const pv1 = await preview(db, b1, U.mkt)
ok(pv1.status === 'ready' && pv1.commit_seq === m1.s, 'sau khi huỷ B2, B1 là mới nhất (preview ready)', JSON.stringify(pv1))
rr = await cancel(db, b1, U.mkt, pv2.commit_seq)
ok(rr.status === 'rejected' && rr.code === 'NOT_LATEST', 'gửi lại commitSeq của B2 cho B1 ⇒ NOT_LATEST (mỗi batch preview riêng)')
rr = await cancel(db, b1, U.mkt, pv1.commit_seq)
ok(rr.status === 'cancelled' && rr.tasks_deleted === 3 && rr.customers_deleted === 3, 'huỷ B1 ⇒ 3 task + 3 khách xoá', JSON.stringify(rr))
ok(await count(db, `SELECT count(*) FROM public.care_tasks WHERE period_month = $1 AND NOT is_test`, [P]) === 0, 'kỳ trống task')
const b1b = await stage(db, fileB1('a'), { period: P })
const r1b = await finalize(db, b1b, U.mkt, todayVN)
ok(r1b.status === 'committed' && r1b.kind === 'initial' && r1b.created === 3, 'nạp lại đúng file B1 sau huỷ ⇒ committed initial (không duplicate)', JSON.stringify(r1b))

section('TỪ CHỐI ⇒ 0 THAY ĐỔI')
s0 = await snap(db)
const seq1b = await seqOf(db, b1b)
for (const [who, uidv] of [['staff', U.A], ['SM', U.sm], ['QLCH', U.qlch1], ['admin OPS không quyền', U.ops]]) {
  const x = await cancel(db, b1b, uidv, seq1b)
  ok(x.status === 'rejected' && x.code === 'FORBIDDEN' && await snap(db) === s0, `${who} ⇒ FORBIDDEN, 0 thay đổi`)
}
ok((await cancel(db, b1b, U.super, seq1b, { now: nextMonthTs })).code === 'NOT_CURRENT_PERIOD' && await snap(db) === s0, 'đồng hồ sau khoá đã sang tháng ⇒ NOT_CURRENT_PERIOD, 0 thay đổi')
ok((await cancel(db, '00000000-0000-4000-8000-00000000abcd', U.mkt, '1')).code === 'NOT_FOUND', 'batch không có ⇒ NOT_FOUND')
{
  const dupB = await stage(db, fileB1('a'), { period: P })
  const dr = await finalize(db, dupB, U.mkt, todayVN)
  ok(dr.status === 'duplicate', 'file trùng B1b ⇒ duplicate')
  ok((await cancel(db, dupB, U.mkt, '1')).code === 'NOT_COMMITTED', 'batch duplicate ⇒ NOT_COMMITTED')
}
// Hoạt động: một lượt CALLBACK trên task của B1b.
{
  const tt = await taskOf(db, ext(3, 'a'), P)
  await record(db, todayVN, U.A, tt.id, 'CALLBACK', 'QA gọi lại', todayVN)
  const s1 = await snap(db)
  const x = await cancel(db, b1b, U.mkt, seq1b)
  ok(x.code === 'HAS_ACTIVITY' && await snap(db) === s1, 'một task có lượt chăm sóc ⇒ HAS_ACTIVITY, 0 thay đổi', JSON.stringify(x))
  ok((await preview(db, b1b, U.mkt)).code === 'HAS_ACTIVITY', 'preview cũng HAS_ACTIVITY')
}

section('HOẠT ĐỘNG KHÁC: CHUYỂN GIAO (kể cả trước revision), REFUSED; REVISION CÓ TASK LOCKED')
{
  const d2 = await L.freshDb(PGlite)
  // Chuyển giao trên task B1, rồi revision B2 sửa task khác ⇒ huỷ B2 vẫn được (task chuyển giao không thuộc T(B2)), huỷ B1 bị chặn.
  const bA = await stage(d2, fileB1('t'), { period: P })
  await finalize(d2, bA, U.mkt, todayVN)
  const ta3 = await taskOf(d2, ext(3, 't'), P)
  const tr = await transfer(d2, todayVN, U.sm, [ta3.id], U.B, 'QA chuyển')
  ok(tr && tr.transferred === 1, 'chuyển giao c3 (B1) A→B', JSON.stringify(tr))
  const bB = await stage(d2, fileB2('t'), { period: P })
  await finalize(d2, bB, U.mkt, todayVN)
  ok((await cancel(d2, bB, U.mkt, await seqOf(d2, bB))).status === 'cancelled', 'huỷ B2 (không chạm task đã chuyển giao) ⇒ được')
  const sB = await snap(d2)
  ok((await cancel(d2, bA, U.mkt, await seqOf(d2, bA))).code === 'HAS_ACTIVITY' && await snap(d2) === sB, 'B1 có task đã chuyển giao (trước revision) ⇒ HAS_ACTIVITY, 0 thay đổi')
  // REFUSED.
  const d3 = await L.freshDb(PGlite)
  const bR = await stage(d3, fileB1('r'), { period: P })
  await finalize(d3, bR, U.mkt, todayVN)
  await record(d3, todayVN, U.A, (await taskOf(d3, ext(1, 'r'), P)).id, 'REFUSED', 'QA từ chối')
  ok((await cancel(d3, bR, U.mkt, await seqOf(d3, bR))).code === 'HAS_ACTIVITY', 'task REFUSED (DNC) ⇒ HAS_ACTIVITY')
  // Revision chạm task đã có lượt (locked ⇒ skipped_has_interaction): huỷ B2 được, B1 vẫn bị chặn.
  const d4 = await L.freshDb(PGlite)
  const bL1 = await stage(d4, fileB1('l'), { period: P })
  await finalize(d4, bL1, U.mkt, todayVN)
  await record(d4, todayVN, U.A, (await taskOf(d4, ext(1, 'l'), P)).id, 'UNREACHABLE', 'QA chưa gọi được', todayVN)
  const bL2 = await stage(d4, fileB2('l'), { period: P })
  const rl2 = await finalize(d4, bL2, U.mkt, todayVN)
  ok(rl2.skipped_has_interaction === 1 && rl2.updated === 1, 'B2 bỏ qua task đã có lượt (skipped_has_interaction=1)', JSON.stringify(rl2))
  ok(await count(d4, `SELECT count(*) FROM public.care_import_revision_journal WHERE batch_id = $1`, [bL2]) === 1, 'task locked không có journal')
  ok((await cancel(d4, bL2, U.mkt, await seqOf(d4, bL2))).status === 'cancelled', 'huỷ B2 (có task skipped) ⇒ được')
  ok((await cancel(d4, bL1, U.mkt, await seqOf(d4, bL1))).code === 'HAS_ACTIVITY', 'huỷ B1 (task có lượt) ⇒ HAS_ACTIVITY')
}

section('BẰNG CHỨNG JOURNAL (P0-1) ⇒ RESTORE_UNAVAILABLE, 0 thay đổi')
for (const [why, tamper] of [
  ['xoá một dòng journal', async (d, b) => d.query(`DELETE FROM public.care_import_revision_journal WHERE id = (SELECT min(id) FROM public.care_import_revision_journal WHERE batch_id = $1)`, [b])],
  // Sửa tay ngoài luồng (owner tắt rào commit — r1.1 chặn đổi provenance của batch committed) ⇒ gate vẫn phải fail-closed.
  ['journal_rows lệch số dòng journal', async (d, b) => d.exec(`ALTER TABLE public.care_import_batches DISABLE TRIGGER care_import_batches_require_provenance;
    UPDATE public.care_import_batches SET journal_rows = journal_rows + 1 WHERE id = '${b}';
    ALTER TABLE public.care_import_batches ENABLE ALWAYS TRIGGER care_import_batches_require_provenance;`)],
  ['tên task bị sửa ngoài revision', async (d, _b, tag) => d.query(`UPDATE public.care_tasks SET customer_name = 'KH sửa tay' WHERE id = (SELECT t.id FROM public.care_tasks t JOIN public.care_customers c ON c.id = t.customer_id WHERE c.external_id = $1)`, [ext(2, tag)])],
  ['dòng sản phẩm batch B trên task ngoài phạm vi', async (d, b, tag) => d.query(`UPDATE public.care_task_products SET batch_id = $1 WHERE id = (SELECT p.id FROM public.care_task_products p JOIN public.care_tasks t ON t.id = p.task_id JOIN public.care_customers c ON c.id = t.customer_id WHERE c.external_id = $2 LIMIT 1)`, [b, ext(3, tag)])],
  ['id sản phẩm trước trỏ sang task khác', async (d, b, tag) => d.query(`UPDATE public.care_import_revision_journal SET prev_product_row_ids = ARRAY[(SELECT p.id FROM public.care_task_products p JOIN public.care_tasks t ON t.id = p.task_id JOIN public.care_customers c ON c.id = t.customer_id WHERE c.external_id = $2 LIMIT 1)] WHERE batch_id = $1 AND products_replaced`, [b, ext(3, tag)])],
]) {
  const d = await L.freshDb(PGlite)
  const tag = 'j' + crypto.randomBytes(2).toString('hex')
  await finalize(d, await stage(d, fileB1(tag), { period: P }), U.mkt, todayVN)
  const bx = await stage(d, fileB2(tag), { period: P })
  await finalize(d, bx, U.mkt, todayVN)
  await tamper(d, bx, tag)
  const sx = await snap(d)
  const x = await cancel(d, bx, U.mkt, await seqOf(d, bx))
  ok(x.code === 'RESTORE_UNAVAILABLE' && await snap(d) === sx, `${why} ⇒ RESTORE_UNAVAILABLE, 0 thay đổi`, JSON.stringify(x))
}

section('BATCH TRƯỚC 115 ⇒ PROVENANCE_UNAVAILABLE')
{
  const d = await L.freshDb(PGlite, { through: '114' })
  const bOld = await stage(d, fileB1('o'), { period: P })
  await finalize(d, bOld, U.mkt, todayVN)
  await d.exec(L.MIGRATION_115)
  const x = await preview(d, bOld, U.mkt)
  ok(x.code === 'PROVENANCE_UNAVAILABLE', 'batch finalize bằng 114 ⇒ preview PROVENANCE_UNAVAILABLE', JSON.stringify(x))
  ok((await cancel(d, bOld, U.mkt, '1')).code === 'PROVENANCE_UNAVAILABLE', 'huỷ ⇒ PROVENANCE_UNAVAILABLE')
  // PM D1 r1 P1-1 — rào thực thi: một finalize đã nạp THÂN 114 trước khi 115 commit sẽ chạy tiếp thân đó sau commit. Mô phỏng
  // xác định: chép nguyên văn thân 114 của care__import_finalize_at sang hàm probe (tạo trước 115 — như một lệnh đã nạp thân cũ),
  // gọi SAU 115 ⇒ UPDATE cuối (status → committed, thiếu commit_seq) bị rào RAISE ⇒ rollback toàn bộ, 0 thay đổi. Race 2 connection
  // thật (finalize chờ khoá trong lúc 115 chạy): planning/research/dev-tools/d1-115/realpg-barrier.mjs trên Postgres 15 thật.
  const finalize114 = L.MIGRATION.slice(L.MIGRATION.indexOf('CREATE OR REPLACE FUNCTION public.care__import_finalize_at('))
  const probeSql = finalize114.slice(0, finalize114.indexOf('\nEND $$;') + '\nEND $$;'.length)
    .replace('public.care__import_finalize_at(', 'public.qa_probe_finalize_114(')
  ok(probeSql.includes('qa_probe_finalize_114') && !probeSql.includes('commit_seq'), 'probe = thân 114 nguyên văn (không có commit_seq)')
  const d0 = await L.freshDb(PGlite, { through: '114' })
  await d0.exec(probeSql)
  await d0.exec(L.MIGRATION_115)
  const bStale = await stage(d0, fileB1('st'), { period: P })
  const s0 = await snap(d0)
  ok(await raises(d0.query(`SELECT public.qa_probe_finalize_114($1, $2, $3::date)`, [bStale, U.mkt, todayVN]), 'chỉ finalize bản 115 được commit batch') === true,
    'finalize THÂN 114 chạy sau 115 ⇒ rào RAISE')
  ok(await snap(d0) === s0 && await count(d0, `SELECT count(*) FROM public.care_import_batches WHERE id = $1 AND status = 'staged'`, [bStale]) === 1,
    'rào: 0 thay đổi (batch vẫn staged, không task/khách/sự kiện)')
  ok(await raises(d0.query(`UPDATE public.care_import_batches SET status = 'committed', kind = 'initial', finished_at = now() WHERE id = $1`, [bStale]),
    'chỉ finalize bản 115 được commit batch') === true, 'rào: UPDATE trực tiếp (owner) sang committed thiếu commit_seq ⇒ RAISE')
  const rs = await finalize(d0, bStale, U.mkt, todayVN)
  ok(rs.status === 'committed' && (await seqOf(d0, bStale)) !== null, 'cùng batch import lại bằng finalize 115 ⇒ committed có commit_seq (rào không chặn đường đúng)')
  ok(await count(d0, `SELECT count(*) FROM public.care_import_batches WHERE status = 'committed' AND commit_seq IS NULL`) === 0,
    'sau 115 không có batch committed thiếu commit_seq')
  // db-reviewer D1 r1.1 P2-1 — rào chặt: INSERT committed thiếu provenance (owner) ⇒ RAISE; committed→committed đổi provenance ⇒ RAISE;
  // session_replication_role = replica không vượt (ENABLE ALWAYS); sửa cột KHÁC của batch committed vẫn được.
  ok(await raises(d0.query(`INSERT INTO public.care_import_batches (period_month, kind, status, file_name, file_sha256, row_count, created_by, finished_at)
      VALUES ($1, 'initial', 'committed', 'x.csv', repeat('b', 64), 1, $2, now())`, [P, U.mkt]), 'chỉ finalize bản 115 được commit batch') === true,
    'rào: INSERT trực tiếp batch committed thiếu commit_seq (owner) ⇒ RAISE')
  ok(await raises(d0.query(`UPDATE public.care_import_batches SET commit_seq = NULL, provenance_version = NULL, journal_rows = NULL WHERE id = $1`, [bStale]),
    'không sửa commit_seq/provenance') === true, 'rào: xoá provenance của batch committed (owner) ⇒ RAISE')
  ok(await raises(d0.exec(`SET session_replication_role = replica; UPDATE public.care_import_batches SET commit_seq = commit_seq + 1000 WHERE id = '${bStale}';`),
    'không sửa commit_seq/provenance') === true, 'rào ENABLE ALWAYS: session_replication_role = replica vẫn chặn')
  await d0.exec('RESET session_replication_role')
  ok((await d0.query(`UPDATE public.care_import_batches SET summary = summary || '{}'::jsonb WHERE id = $1 RETURNING id`, [bStale])).rows.length === 1,
    'rào không chặn sửa cột khác của batch committed')

  // Không còn cửa sổ thời gian: bOld (thân 114) kết thúc VÀI GIÂY trước 115 (không lùi giờ) — batch sau 115 vẫn là mới nhất, huỷ được.
  const bNew = await stage(d, fileB2('o'), { period: P })
  const rn = await finalize(d, bNew, U.mkt, todayVN)
  ok(rn.kind === 'revision', 'revision sau 115 trên batch 114')
  ok((await preview(d, bNew, U.mkt)).status === 'ready', 'batch 114 kết thúc ngay trước 115 KHÔNG chặn batch sau 115 (không dùng cửa sổ)')
  ok((await d.query(`UPDATE public.care_import_batches SET file_name = file_name WHERE id = $1 RETURNING id`, [bOld])).rows.length === 1,
    'batch committed trước 115 (provenance NULL) vẫn sửa được cột khác — rào chỉ giữ nguyên 3 cột provenance')
  // Gate không đọc app_migrations: thiếu dòng 115 không đổi kết quả.
  await d.query(`DELETE FROM public.app_migrations WHERE version = '115'`)
  ok((await preview(d, bNew, U.mkt)).status === 'ready', 'gate không phụ thuộc dòng app_migrations 115')
  await d.query(`INSERT INTO public.app_migrations (version, name) VALUES ('115', 'care_import_cancel')`)
  ok((await cancel(d, bNew, U.mkt, await seqOf(d, bNew))).status === 'cancelled', 'huỷ revision sau 115 ⇒ được (khôi phục từ journal)')
  ok((await preview(d, bOld, U.mkt)).code === 'PROVENANCE_UNAVAILABLE', 'sau đó batch 114 vẫn PROVENANCE_UNAVAILABLE (Q-163)')
}

section('TRIGGER / TOKEN / GUARD BATCH')
{
  const d = await L.freshDb(PGlite)
  const bT = await stage(d, fileB1('g'), { period: P })
  await finalize(d, bT, U.mkt, todayVN)
  const tg = await taskOf(d, ext(1, 'g'), P)
  ok(await raises(as(d, null, () => d.query(`DELETE FROM public.care_tasks WHERE id = $1`, [tg.id]), 'service_role'), V116 ? 'permission denied' : 'chỉ thêm') === true,
     V116 ? '[116] service_role DELETE task ⇒ 42501 (mất quyền DELETE)' : 'service_role DELETE task thật ⇒ "chỉ thêm"')
  ok(await raises(as(d, U.mkt, () => d.query(`DELETE FROM public.care_tasks WHERE id = $1`, [tg.id])), 'permission denied') === true, 'authenticated DELETE task ⇒ 42501')
  ok(await raises(d.query(`DELETE FROM public.care_tasks WHERE id = $1`, [tg.id]), 'chỉ thêm') === true, 'owner DELETE trực tiếp không token ⇒ "chỉ thêm"')
  // Token của transaction khác (xid8 giả) + batch cancelled giả không mở được DELETE.
  await d.query(`INSERT INTO public.care_cancel_tokens (xact, batch_id) VALUES ('1'::xid8, $1)`, [bT])
  ok(await raises(d.query(`DELETE FROM public.care_tasks WHERE id = $1`, [tg.id]), 'chỉ thêm') === true, 'token của transaction khác ⇒ vẫn chặn')
  await d.query(`DELETE FROM public.care_cancel_tokens WHERE true`)
  ok(await raises(as(d, null, () => d.query(`INSERT INTO public.care_import_batches (period_month, kind, status, file_name, file_sha256, row_count, created_by, finished_at, provenance_version, commit_seq, journal_rows, cancelled_by, cancelled_at)
     VALUES ($1, 'initial', 'cancelled', 'x.csv', $2, 1, $3, now(), 1, 999, 0, $3, now())`, [P, L.sha('fake'), U.mkt]), 'service_role'), 'chỉ được tạo batch staged') === true, 'service_role INSERT batch cancelled giả ⇒ chặn')
  ok(await raises(as(d, null, () => d.query(`INSERT INTO public.care_import_batches (period_month, kind, status, file_name, file_sha256, row_count, created_by, finished_at)
     VALUES ($1, 'initial', 'committed', 'x.csv', $2, 1, $3, now())`, [P, L.sha('fake2'), U.mkt]), 'service_role'), 'chỉ được tạo batch staged') === true, 'service_role INSERT batch committed ⇒ chặn')
  ok(await raises(as(d, null, () => d.query(`UPDATE public.care_import_batches SET status = 'cancelled' WHERE id = $1`, [bT]), 'service_role'), 'permission denied') === true, 'service_role UPDATE batch ⇒ 42501')
  // service_role đổi batch_id task sang batch staged của mình rồi DELETE ⇒ vẫn chặn (không owner, không token).
  const own = await as(d, null, async () => (await d.query(`INSERT INTO public.care_import_batches (period_month, file_name, file_sha256, row_count, created_by) VALUES ($1, 'y.csv', $2, 1, $3) RETURNING id`, [P, L.sha('own'), U.mkt])).rows[0].id, 'service_role')
  ok(own, 'service_role INSERT batch staged (đường createBatch) ⇒ được')
  ok(await raises(as(d, null, async () => { await d.query(`UPDATE public.care_tasks SET batch_id = $1 WHERE id = $2`, [own, tg.id]); await d.query(`DELETE FROM public.care_tasks WHERE id = $1`, [tg.id]) }, 'service_role'), V116 ? 'permission denied' : 'chỉ thêm') === true,
     V116 ? '[116] service_role đổi task sang batch giả rồi DELETE ⇒ 42501' : 'service_role đổi task sang batch giả rồi DELETE ⇒ vẫn "chỉ thêm"')
  const ev = await one(d, `SELECT id FROM public.care_assignment_events WHERE task_id = $1`, [tg.id])
  ok(await raises(d.query(`UPDATE public.care_assignment_events SET note = 'x' WHERE id = $1`, [ev.id]), 'chỉ thêm') === true, 'UPDATE sự kiện (kể cả owner) ⇒ "chỉ thêm"')
  await record(d, todayVN, U.A, (await taskOf(d, ext(2, 'g'), P)).id, 'REFUSED', 'QA từ chối')
  ok(await raises(d.query(`DELETE FROM public.care_interactions WHERE true`), 'chỉ thêm') === true, 'DELETE lượt ⇒ "chỉ thêm"')
  ok(await raises(d.query(`DELETE FROM public.care_store_refusals WHERE true`), 'chỉ thêm') === true, 'DELETE từ chối ⇒ "chỉ thêm"')
  // Batch cancelled thật không xoá được; is_test xoá được.
  const d5 = await L.freshDb(PGlite)
  const bc = await stage(d5, fileB1('k'), { period: P })
  await finalize(d5, bc, U.mkt, todayVN)
  await cancel(d5, bc, U.mkt, await seqOf(d5, bc))
  ok(await raises(as(d5, null, () => d5.query(`DELETE FROM public.care_import_batches WHERE id = $1`, [bc]), 'service_role'), 'không xoá batch đã huỷ') === true, 'DELETE batch cancelled thật ⇒ chặn')
}

section('REGRESSION DƯỚI service_role THẬT (đường app + fixture is_test) + CASCADE journal')
{
  const d = await L.freshDb(PGlite)
  const svc = (fn) => as(d, null, fn, 'service_role')
  const mk = async (rows, isTest) => svc(async () => {
    const id = (await d.query(`INSERT INTO public.care_import_batches (period_month, file_name, file_sha256, row_count, created_by, is_test)
      VALUES ($1, 'care-import-x.csv', $2, $3, $4, $5) RETURNING id`, [P, L.sha(JSON.stringify(rows) + isTest), rows.length, U.mkt, isTest])).rows[0].id
    for (let i = 0; i < rows.length; i++) await d.query(`INSERT INTO public.care_import_staging (batch_id, row_no, payload) VALUES ($1, $2, $3)`, [id, i + 2, JSON.stringify(rows[i])])
    return id
  })
  const fin = (id) => svc(async () => (await d.query(`SELECT public.care_import_finalize($1, $2) AS r`, [id, U.mkt])).rows[0].r)
  const disc = await mk(fileB1('d'), false)
  ok(await svc(async () => (await d.query(`DELETE FROM public.care_import_batches WHERE id = $1 AND status = 'staged'`, [disc])).affectedRows) === 1, 'discardBatch (DELETE staged) dưới service_role ⇒ được')
  ok(await svc(async () => { await d.query(`SELECT public.care_purge_stale_staging('1 hour'::interval)`); return true }), 'care_purge_stale_staging dưới service_role ⇒ được')
  const tst = fileB1('q').map((r) => ({ ...r, customer_external_id: 'QA-UI-' + r.customer_external_id }))
  const tst2 = fileB2('q').map((r) => ({ ...r, customer_external_id: 'QA-UI-' + r.customer_external_id }))
  const tb1 = await mk(tst, true)
  const fr1 = await fin(tb1)
  ok(fr1.status === 'committed', 'finalize wrapper (service_role) is_test initial', JSON.stringify(fr1))
  const tb2 = await mk(tst2, true)
  const fr2 = await fin(tb2)
  ok(fr2.status === 'committed' && fr2.updated === 2, 'finalize wrapper is_test revision (journal 2 dòng)', JSON.stringify(fr2))
  ok(await count(d, `SELECT count(*) FROM public.care_import_revision_journal WHERE is_test`) === 2, 'journal is_test có 2 dòng')
  // fixture down: xoá theo thứ tự FK bằng service_role (như care-qa-fixture.mjs), journal CASCADE.
  await svc(async () => {
    await d.query(`DELETE FROM public.care_assignment_events WHERE is_test`)
    await d.query(`DELETE FROM public.care_task_products WHERE task_id IN (SELECT id FROM public.care_tasks WHERE is_test)`)
    // [116] service_role không DELETE care_tasks — fixture down gọi care_qa_delete_test_tasks (X → L).
    if (V116) await d.query(`SELECT public.care_qa_delete_test_tasks(ARRAY(SELECT id FROM public.care_tasks WHERE is_test))`)
    else await d.query(`DELETE FROM public.care_tasks WHERE is_test`)
    await d.query(`DELETE FROM public.care_customers WHERE is_test`)
    await d.query(`DELETE FROM public.care_import_batches WHERE is_test`)
  })
  ok(await count(d, `SELECT count(*) FROM public.care_import_revision_journal`) === 0 && await count(d, `SELECT count(*) FROM public.care_import_batches WHERE is_test`) === 0,
     'fixture down (service_role) sau revision is_test ⇒ remaining 0, journal CASCADE')
}

section('ĐÓNG KỲ DỌN JOURNAL KỲ TRƯỚC (k task ≠ m journal)')
{
  const d = await L.freshDb(PGlite)
  // Kỳ trước PP: initial 3 khách + revision sửa 2 ⇒ k = 4 task mở (3 + 1 mới), m = 2 journal.
  await finalize(d, await stage(d, fileB1('p'), { period: PP }), U.mkt, prevLast)
  await finalize(d, await stage(d, fileB2('p'), { period: PP }), U.mkt, prevLast)
  ok(await count(d, `SELECT count(*) FROM public.care_import_revision_journal`) === 2, 'kỳ trước: 2 dòng journal')
  // Kỳ hiện tại: revision có journal (giữ lại).
  const n1 = await one(d, `SELECT public.care__close_period_at($1::date) AS n`, [todayVN])
  ok(n1.n === 4, 'care__close_period_at trả k = 4 (số TASK đóng kỳ, không phải số journal)', JSON.stringify(n1))
  ok(await count(d, `SELECT count(*) FROM public.care_import_revision_journal`) === 0, 'journal kỳ trước đã dọn')
  ok((await one(d, `SELECT public.care__close_period_at($1::date) AS n`, [todayVN])).n === 0, 'gọi lặp ⇒ 0 (idempotent)')
  // Journal kỳ hiện tại không bị dọn khi đóng kỳ trong cùng kỳ.
  await finalize(d, await stage(d, fileB1('c'), { period: P }), U.mkt, todayVN)
  await finalize(d, await stage(d, fileB2('c'), { period: P }), U.mkt, todayVN)
  await d.query(`SELECT public.care__close_period_at($1::date)`, [todayVN])
  ok(await count(d, `SELECT count(*) FROM public.care_import_revision_journal`) === 2, 'journal kỳ hiện tại giữ nguyên sau đóng kỳ')
  // Finalize đầu kỳ ghi closed_previous_period = k (không bị journal làm lệch); cron wrapper dưới service_role trả k.
  const e = await L.freshDb(PGlite)
  await finalize(e, await stage(e, fileB1('e'), { period: PP }), U.mkt, prevLast)
  await finalize(e, await stage(e, fileB2('e'), { period: PP }), U.mkt, prevLast)
  const fe = await finalize(e, await stage(e, fileB1('f'), { period: P }), U.mkt, todayVN)
  ok(fe.closed_previous_period === 4 && await count(e, `SELECT count(*) FROM public.care_import_revision_journal`) === 0, 'finalize đầu kỳ: closed_previous_period = 4, journal kỳ trước dọn', JSON.stringify(fe))
  const e2 = await L.freshDb(PGlite)
  await finalize(e2, await stage(e2, fileB1('w'), { period: PP }), U.mkt, prevLast)
  await finalize(e2, await stage(e2, fileB2('w'), { period: PP }), U.mkt, prevLast)
  const cw = await as(e2, null, async () => (await e2.query(`SELECT public.care_close_period() AS n`)).rows[0].n, 'service_role')
  ok(cw === 4, 'care_close_period() (cron, service_role) trả 4', String(cw))
}

section('ACL 115 + QUYỀN HÀM')
{
  const d = await L.freshDb(PGlite)
  const acl = (await d.query(`SELECT r.role, ${['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES'].map((p) => `count(*) FILTER (WHERE has_table_privilege(r.role, c.oid, '${p}'))::int AS "${p}"`).join(', ')}
    FROM (VALUES ('anon'), ('authenticated'), ('service_role')) r(role) CROSS JOIN pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relname LIKE 'care\\_%' AND c.relkind = 'r' GROUP BY r.role ORDER BY r.role`)).rows
  const m = Object.fromEntries(acl.map((x) => [x.role, [x.SELECT, x.INSERT, x.UPDATE, x.DELETE, x.TRUNCATE, x.TRIGGER, x.REFERENCES].join('/')]))
  ok(m.anon === '0/0/0/0/0/0/0' && m.authenticated === '8/1/1/1/0/0/0' && m.service_role === (V116 ? '13/13/12/12/0/0/0' : '13/13/12/13/0/0/0'),
     V116 ? 'ma trận ACL bảng care_* sau 115 + [116] (7 bảng E: 0 quyền mọi role; service_role mất DELETE care_tasks)' : 'ma trận ACL 15 bảng care_* sau 115', JSON.stringify(m))
  const fp = (await d.query(`SELECT p.proname, p.prosecdef d, has_function_privilege('anon', p.oid, 'EXECUTE') a, has_function_privilege('authenticated', p.oid, 'EXECUTE') u, has_function_privilege('service_role', p.oid, 'EXECUTE') s
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('care__forbid_mutation', 'care__close_period_at', 'care__import_finalize_at',
      'care__cancel_delete_allowed', 'care__guard_batch_insert', 'care__keep_cancelled_batch', 'care__require_commit_provenance', 'care__import_cancel_assess',
      'care__import_cancel_gate', 'care__import_cancel_preview_at', 'care__import_cancel_at', 'care_import_cancel_preview', 'care_import_cancel') ORDER BY 1`)).rows
  ok(fp.length === 13 && fp.every((f) => !f.a && !f.u && (f.s === ['care_import_cancel', 'care_import_cancel_preview'].includes(f.proname))), 'chỉ 2 wrapper cho service_role; hàm nội bộ / thay không role nào', JSON.stringify(fp.filter((f) => f.a || f.u)))
  ok(fp.filter((f) => ['care__forbid_mutation', 'care__guard_batch_insert', 'care__keep_cancelled_batch', 'care__require_commit_provenance'].includes(f.proname)).every((f) => !f.d), '4 hàm trigger SECURITY INVOKER (gồm rào commit)')
  ok(await raises(as(d, U.mkt, () => d.query(`SELECT public.care_import_cancel('00000000-0000-4000-8000-000000000001', $1, 1)`, [U.mkt])), 'permission denied') === true, 'authenticated gọi care_import_cancel ⇒ 42501')
  ok(await raises(as(d, U.mkt, () => d.query(`SELECT * FROM public.care_import_revision_journal`)), 'permission denied') === true, 'authenticated đọc journal ⇒ 42501')
  ok(await raises(as(d, null, () => d.query(`SELECT * FROM public.care_import_revision_journal`), 'service_role'), 'permission denied') === true, 'service_role đọc journal ⇒ 42501 (owner-only)')
  ok(await raises(as(d, U.mkt, () => d.query(`SELECT created_batch_id FROM public.care_customers`)), 'permission denied') === true, 'authenticated đọc care_customers.created_batch_id ⇒ 42501')
  const w = await as(d, null, async () => (await d.query(`SELECT public.care_import_cancel_preview('00000000-0000-4000-8000-000000000001', $1) AS r`, [U.mkt])).rows[0].r, 'service_role')
  ok(w.code === 'NOT_FOUND', 'service_role gọi wrapper preview ⇒ chạy (NOT_FOUND với id giả)')
}

section('SUMMARY KHÔNG PII (Q-161) — tập khoá theo trạng thái')
{
  const d = await L.freshDb(PGlite)
  const bOk = await stage(d, fileB1('s'), { period: P })
  await finalize(d, bOk, U.mkt, todayVN)
  const bRej = await stage(d, [row('QA115-s-9', 'KHONG_CO', EA, '1901')], { period: P })
  await finalize(d, bRej, U.mkt, todayVN)
  const bDup = await stage(d, fileB1('s'), { period: P })
  await finalize(d, bDup, U.mkt, todayVN)
  const bStg = await stage(d, fileB1('z'), { period: P })
  const bCan = await stage(d, fileB2('s'), { period: P })
  await finalize(d, bCan, U.mkt, todayVN)
  await cancel(d, bCan, U.mkt, await seqOf(d, bCan))
  const COMMITTED = 'absent_kept,closed_previous_period,created,customers,kind,owner_ignored,rows,skipped_has_interaction,stores,unchanged,updated'
  const rows = (await d.query(`SELECT id, status, kind, summary FROM public.care_import_batches`)).rows
  const keys = (o) => Object.keys(o).sort().join(',')
  const bad = rows.filter((b) => {
    const s = b.summary
    if (b.status === 'staged') return keys(s) !== ''
    if (b.status === 'rejected') return !(keys(s) === 'error_count,errors' && Array.isArray(s.errors) && s.errors.every((e) => keys(e) === 'code,row' && typeof e.row === 'number' && /^[A-Z_]+$/.test(e.code)))
      && JSON.stringify(s) !== '{"reason":"stale_staging"}'
    if (b.status === 'duplicate') return !(keys(s) === 'duplicate_of' && /^[0-9a-f-]{36}$/.test(s.duplicate_of))
    const base = b.status === 'cancelled' ? COMMITTED + ',cancel' : COMMITTED
    return keys(s).split(',').sort().join(',') !== base.split(',').sort().join(',') || s.kind !== b.kind
      || Object.entries(s).some(([k, v]) => k !== 'kind' && k !== 'cancel' && typeof v !== 'number')
  })
  ok(rows.length === 5 && bad.length === 0, 'staged / rejected / duplicate / committed / cancelled: summary đúng tập khoá, chỉ số + mã', JSON.stringify(bad))
  ok(!JSON.stringify(rows.map((r) => r.summary)).match(/QA115|KH |0390000/), 'summary không chứa mã khách / tên / SĐT')
  void bStg
}

section('ROLLBACK 115 (có / không batch cancelled) + CHẠY LẠI 115')
{
  const md5of = async (d, sig) => (await one(d, `SELECT md5(replace(prosrc, chr(13), '')) m FROM pg_proc WHERE oid = '${sig}'::regprocedure`)).m
  // [116] Rollback 115 khi đã có 116 ⇒ từ chối (rollback 116 trước); phần còn lại của mục này kiểm rollback 115 trên DB dừng ở 115.
  if (V116) {
    const d116 = await L.freshDb(PGlite)
    ok(await raises(d116.exec(L.ROLLBACK_115), 'đã có migration sau 115') === true, '[116] rollback 115 khi có 116 ⇒ từ chối')
  }
  // Không có batch cancelled ⇒ trở về đúng 114.
  const d = await L.freshDb(PGlite, { through: '115' })
  await finalize(d, await stage(d, fileB1('rb'), { period: P }), U.mkt, todayVN)
  await d.exec(L.ROLLBACK_115)
  ok(await md5of(d, 'public.care__import_finalize_at(uuid,uuid,date)') === '121e14feb18accd8ec95424df192d20b'
     && await md5of(d, 'public.care__close_period_at(date)') === 'cd4fb7f945c0cfa4a7ba12e6696942a3'
     && await md5of(d, 'public.care__forbid_mutation()') === 'ae77c258096e0c881e9895d275dc0df4', 'rollback: md5 3 hàm = 114')
  ok(await count(d, `SELECT count(*) FROM information_schema.columns WHERE table_name = 'care_import_batches' AND column_name IN ('commit_seq', 'provenance_version', 'cancelled_at')`) === 0
     && await count(d, `SELECT count(*) FROM public.app_migrations WHERE version = '115'`) === 0, 'rollback không có cancelled: bỏ cột mới, xoá marker 115')
  // PM D1 r1 P1-2: không còn cột huỷ ⇒ lịch sử cờ OFF (cột 114) vẫn chạy; cờ ON (đọc cancelled_at) sẽ lỗi ⇒ runbook: rollback ⇒ cờ OFF.
  ok((await d.query(`SELECT b.id, b.period_month, b.kind, b.status, b.row_count, b.customer_count, b.created_at, b.summary FROM public.care_import_batches b`)).rows.length >= 1
     && await raises(d.query(`SELECT cancelled_at FROM public.care_import_batches`), 'cancelled_at') === true,
     'rollback không có cancelled: lịch sử cờ OFF chạy; cột huỷ không còn ⇒ phải để cờ OFF')
  const r114 = await finalize(d, await stage(d, fileB2('rb'), { period: P }), U.mkt, todayVN)
  ok(r114.status === 'committed' && r114.kind === 'revision', 'sau rollback: finalize 114 chạy bình thường', JSON.stringify(r114))
  await d.exec(L.MIGRATION_115)
  ok(await count(d, `SELECT count(*) FROM public.app_migrations WHERE version = '115'`) === 1, 'chạy lại 115 sau rollback ⇒ được')
  // Có batch cancelled ⇒ giữ cột / sequence; chạy lại 115 ⇒ commit_seq mới > cũ.
  const e = await L.freshDb(PGlite, { through: '115' })
  const eb1 = await stage(e, fileB1('rc'), { period: P })
  await finalize(e, eb1, U.mkt, todayVN)
  const eSeq = await seqOf(e, eb1)
  await cancel(e, eb1, U.mkt, eSeq)
  // db-reviewer D1 r1.1 P2-6: một batch committed CÓ commit_seq trước rollback ⇒ rollback xoá provenance ⇒ sau khi chạy lại 115 nó là
  // "trước 115" (PROVENANCE_UNAVAILABLE), không được coi là mới nhất.
  const ebK = await stage(e, fileB1('rk'), { period: P })
  await finalize(e, ebK, U.mkt, todayVN)
  ok((await seqOf(e, ebK)) !== null, 'trước rollback: batch committed có commit_seq')
  await e.exec(L.ROLLBACK_115)
  ok(await count(e, `SELECT count(*) FROM public.care_import_batches WHERE status = 'cancelled' AND provenance_version = 1`) === 1, 'rollback có cancelled: batch cancelled giữ provenance (CHECK không vỡ)')
  const acl = (await e.query(`SELECT ${['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES'].map((p) => `count(*) FILTER (WHERE has_table_privilege('service_role', c.oid, '${p}'))::int AS "${p}"`).join(', ')}
    FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname LIKE 'care\\_%' AND c.relkind = 'r'`)).rows[0]
  ok(Object.values(acl).join('/') === '13/13/13/13/9/13/13', 'rollback: ACL service_role = 114 (TRUNCATE chỉ 9 bảng)', JSON.stringify(acl))
  ok(!(await one(e, `SELECT has_table_privilege('service_role', 'public.care_tasks', 'TRUNCATE') t`)).t, 'rollback không mở lại TRUNCATE care_tasks')
  // PM D1 r1 P1-2 — sau rollback còn batch cancelled: đúng các cột /care/assign (D1) đọc vẫn truy vấn được; import 114 vẫn chạy.
  // (App TRƯỚC D1 đọc STATUS[r.status].tone ⇒ vỡ với 'cancelled' — runbook §7b: giữ app D1 cờ OFF, KHÔNG revert app.)
  const HIST_OFF = `SELECT b.id, b.period_month, b.kind, b.status, b.row_count, b.customer_count, b.created_at, b.summary, u.full_name
    FROM public.care_import_batches b LEFT JOIN public.users u ON u.id = b.created_by ORDER BY b.created_at DESC, b.id DESC`
  const HIST_ON = `SELECT b.id, b.status, b.cancelled_at, cu.full_name AS canceller FROM public.care_import_batches b
    LEFT JOIN public.users cu ON cu.id = b.cancelled_by ORDER BY b.created_at DESC`
  const offRows = (await e.query(HIST_OFF)).rows
  ok(offRows.some((x) => x.status === 'cancelled'), 'rollback có cancelled: truy vấn lịch sử (cờ OFF) chạy, có dòng cancelled')
  ok((await e.query(HIST_ON)).rows.some((x) => x.status === 'cancelled' && x.cancelled_at && x.canceller), 'rollback có cancelled: cột người/lúc huỷ còn (cờ ON vẫn đọc được)')
  const r114c = await finalize(e, await stage(e, fileB2('rc'), { period: P }), U.mkt, todayVN)
  ok(r114c.status === 'committed', 'rollback có cancelled: import (finalize 114) vẫn chạy — rào commit đã bỏ cùng rollback', JSON.stringify(r114c))
  await e.exec(L.MIGRATION_115)
  const eb2 = await stage(e, fileB1('rc'), { period: P })
  await finalize(e, eb2, U.mkt, todayVN)
  ok(BigInt(await seqOf(e, eb2)) > BigInt(eSeq), 'chạy lại 115 ⇒ commit_seq mới lớn hơn mọi giá trị cũ')
  ok((await preview(e, ebK, U.mkt)).code === 'PROVENANCE_UNAVAILABLE' && (await preview(e, r114c.batch_id, U.mkt)).code === 'PROVENANCE_UNAVAILABLE'
     && (await preview(e, eb2, U.mkt)).status === 'ready',
     'rollback → finalize 114 → chạy lại 115: batch có seq trước rollback + batch trong khoảng rollback đều PROVENANCE_UNAVAILABLE; batch mới là mới nhất')
}

console.log(`\n${pass} đạt · ${fail} lỗi`)
process.exit(fail ? 1 : 0)
