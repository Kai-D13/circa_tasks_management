// QA EXECUTABLE cho migration 116 (CRM-CSKH E — đơn N3 xác thực sau import) trên PGlite (Postgres 16 WASM) + 114 + 115 thật.
// Không đụng DB thật; pglite cài --no-save.
//
//   cd webapp
//   npm i --no-save @electric-sql/pglite@0.2.17     # một lần
//   node scripts/qa-care-116.mjs                    # kỳ vọng: N đạt · 0 lỗi
//
// Bao phủ (thiết kế E0 r3.4 §11): migration / ACL / chạy lại · biên kỳ care_period_end · trigger freeze / chặn chèn kỳ đã chốt
// (isolation) / dọn coverage · lượt thường đầu–cuối (cửa sổ (lo, snapshot], nhiều đơn, đơn muộn, đổi giờ, relink bị từ chối) ·
// kiểm dạng chunk / job (sha, trùng order_key, ngoài cửa sổ, idempotent, xung đột) · lượt chốt (biên 23:59:59.999999 / 00:00,
// đóng băng, CLOSE_NOT_ELIGIBLE, chạy lại bằng kỳ) · máy trạng thái chốt (coverage thiếu, fail, abandoned, lỡ khung, gọi trùng) ·
// trial + cleanup · dọn QA · gate / assess D1 (Q-175 / Q-182) · RPC đọc theo vai trò · rollback mức 1 / 2.
// GIỚI HẠN: PGlite một session ⇒ race hai connection chạy trên PostgreSQL 15 thật (planning/research/dev-tools/e-116/realpg-race-116.mjs).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
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
const { U, one, count, raises, setUid, as, stage, finalize, row, taskOf, EA, EB, EC, storeId } = L
const S1 = L.STORES[0].code, S2 = L.STORES[1].code

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')
const j = async (db, sql, p = []) => (await one(db, sql, p)).r
const svc = (db, sql, p = []) => as(db, null, () => j(db, sql, p), 'service_role')
const todayVN = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date())
const P = `${todayVN.slice(0, 7)}-01`
const S = JSON.stringify

// ── Fixture trực tiếp (owner): batch committed + task với created_at cố định (I1: kỳ = tháng VN của created_at) ──
async function mkBatch(db, period, finishedAt, isTest = false) {
  const id = crypto.randomUUID()
  await db.query(`INSERT INTO public.care_import_batches (id, period_month, kind, status, file_name, file_sha256, row_count, created_by,
                    is_test, finished_at, provenance_version, commit_seq, journal_rows)
                  VALUES ($1, $2, 'initial', 'committed', 'qa.csv', $3, 1, $4, $5, $6::timestamptz, 1, nextval('public.care_import_commit_seq'), 0)`,
    [id, period, sha256(id), U.mkt, isTest, finishedAt])
  return id
}
async function mkTask(db, { ext, period, createdAt, batch, store = storeId(1), assignee = U.A, isTest = false }) {
  await db.query(`INSERT INTO public.care_customers (external_id, is_test) VALUES ($1, $2) ON CONFLICT (external_id) DO NOTHING`, [ext, isTest])
  return one(db, `INSERT INTO public.care_tasks (customer_id, period_month, due_date, batch_id, store_id, assignee_id, customer_name, phone_norm, phone_raw,
                    is_test, created_at)
                  SELECT c.id, $2::date, public.care_period_last_day($2::date), $3, $4, $5, 'KH ' || $1, '0390000999', '0390000999', $6, $7::timestamptz
                  FROM public.care_customers c WHERE c.external_id = $1
                  RETURNING id, public.care__utc_us(created_at) AS lo`, [ext, period, batch, store, assignee, isTest, createdAt])
}
const ord = (key, ext, at) => ({ order_key: key, customer_external_id: ext, ordered_at: at })

// ── Lượt chạy như app (E0 §4.1); BigQuery giả lọc ĐÚNG như câu SQL bước 4 ──
const openRun = (db, kind, mode, now, { retry = null, cap = 5000 } = {}) =>
  j(db, `SELECT public.care__order_links_begin_open_at($1, $2, $3::date, $4, $5::timestamptz) r`, [kind, mode, retry, cap, now])
const selectRun = (db, runId, max = 20000) => j(db, `SELECT public.care_order_links_begin_select($1, $2, 7) r`, [runId, max])
const runJob = (db, runId, n) => j(db, `SELECT public.care_order_links_run_job($1, $2) r`, [runId, n])
const jobDone = (db, runId, n, total, dup, s) => j(db, `SELECT public.care_order_links_job_done($1, $2, $3, $4, $5) r`, [runId, n, total, dup, s])
const applyChunk = (db, runId, jobNo, chunkNo, ids, orders) =>
  j(db, `SELECT public.care_order_links_apply_chunk($1, $2, $3, $4::text[], $5::jsonb) r`, [runId, jobNo, chunkNo, ids, S(orders)])
const complete = (db, runId) => j(db, `SELECT public.care_order_links_complete($1) r`, [runId])
const failRun = (db, runId, code) => j(db, `SELECT public.care_order_links_fail($1, $2) r`, [runId, code])
// Băm tham số như lib/care/orderLinks (độ dài byte + giá trị; thời điểm µs UTC; thứ tự DB trả).
function paramsSha(job) {
  const lines = job.customer_ids.map((id, i) => `${Buffer.byteLength(id, 'utf8')}:${id}|${job.from_ts[i]}`)
  return sha256(['care-order-links/v1', job.upper_bound, job.is_close ? '1' : '0', String(job.per_customer_cap), lines.join('\n')].join('\n'))
}
function bq(job, orders) {
  const lo = new Map(job.customer_ids.map((id, i) => [id, job.from_ts[i]]))
  return orders.filter((o) => lo.has(o.customer_external_id) && o.ordered_at > lo.get(o.customer_external_id)
    && o.ordered_at <= job.upper_bound && (!job.is_close || o.ordered_at < job.upper_bound))
}
async function readJobs(db, runId, jobs, orders) {
  const out = []
  for (let n = 1; n <= jobs; n++) {
    const job = await runJob(db, runId, n)
    const rows = bq(job, orders)
    out.push({ job, rows, sha: paramsSha(job), done: await jobDone(db, runId, n, rows.length, 0, paramsSha(job)) })
  }
  return out
}
async function applyJobs(db, runId, jobsRead, size = 2000) {
  let chunk = 1
  const res = []
  for (const { job, rows } of jobsRead) {
    for (let i = 0; i < job.customer_ids.length; i += size) {
      const ids = job.customer_ids.slice(i, i + size)
      const set = new Set(ids)
      res.push(await applyChunk(db, runId, job.job_no, chunk++, ids, rows.filter((o) => set.has(o.customer_external_id))))
    }
  }
  return res
}
async function fullRun(db, kind, mode, now, orders, opts = {}) {
  const open = await openRun(db, kind, mode, now, opts)
  if (open.status !== 'ok') return { open }
  const select = await selectRun(db, open.run_id)
  const jobs = await readJobs(db, open.run_id, select.jobs, orders)
  const chunks = await applyJobs(db, open.run_id, jobs, opts.size)
  if (opts.beforeComplete) await opts.beforeComplete(open)
  return { open, select, jobs, chunks, complete: await complete(db, open.run_id) }
}
const pstate = (db, p) => one(db, `SELECT status, last_error, close_run_id, public.care__utc_us(closed_through) AS thru
                                   FROM public.care_order_period_state WHERE period_month = $1`, [p])
const sstate = (db) => one(db, `SELECT public.care__utc_us(last_success_at) AS s, last_error AS e FROM public.care_sync_state WHERE source = 'n3_import_orders'`)
const links = async (db) => Object.fromEntries((await db.query(
  `SELECT l.order_key, c.external_id, public.care__utc_us(l.ordered_at) AS at FROM public.care_order_links l
   JOIN public.care_tasks t ON t.id = l.task_id JOIN public.care_customers c ON c.id = t.customer_id ORDER BY l.order_key`)).rows
  .map((r) => [r.order_key, `${r.external_id}@${r.at}`]))
const cov = async (db, taskId) => one(db, `SELECT public.care__utc_us(covered_until) AS u, run_id FROM public.care_order_task_coverage WHERE task_id = $1`, [taskId])
const runOf = (db, id) => one(db, `SELECT status, error_code, is_retry FROM public.care_order_runs WHERE run_id = $1`, [id])
const dataHash = async (db) => (await one(db, `SELECT md5(concat_ws('|',
    (SELECT string_agg(order_key || task_id::text || ordered_at::text, ',' ORDER BY order_key) FROM public.care_order_links),
    (SELECT string_agg(task_id::text || covered_until::text, ',' ORDER BY task_id) FROM public.care_order_task_coverage),
    (SELECT string_agg(period_month::text || status || COALESCE(last_error, '-'), ',' ORDER BY period_month) FROM public.care_order_period_state),
    (SELECT string_agg(source || COALESCE(last_success_at::text, '-') || COALESCE(last_error, '-'), ',' ORDER BY source) FROM public.care_sync_state))) AS h`)).h
const insertTaskRaises = (db, period, createdAt, needle) => raises((async () => {
  const b = await mkBatch(db, period, createdAt)
  await mkTask(db, { ext: `X-${crypto.randomUUID().slice(0, 8)}`, period, createdAt, batch: b })
})(), needle)

// ════════════════════════════════════════════════════════════════════════════
section('MIGRATION 116 — ACL, chạy lại, biên kỳ')
let db = await L.freshDb(PGlite)
// md5 thân gate trong FILE 116 (phần giữa AS $$ … $$; như prosrc) — đối chiếu với hàm trên DB.
const fileBody = (sql, sig) => {
  const i = sql.indexOf(`CREATE OR REPLACE FUNCTION ${sig}`)
  const a = sql.indexOf('AS $$', i) + 5
  return sql.slice(a, sql.indexOf('$$;', a))
}
const gateMd5File = crypto.createHash('md5').update(fileBody(L.MIGRATION_116, 'public.care__import_cancel_gate(')).digest('hex')
ok(await count(db, `SELECT count(*) FROM public.app_migrations WHERE version = '116'`) === 1, 'app_migrations có 116')
for (const role of ['anon', 'authenticated', 'service_role']) {
  ok(await raises(as(db, null, () => db.query(`SELECT 1 FROM public.care_order_links`), role), 'permission denied') === true, `${role} không SELECT care_order_links`)
}
ok(await raises(as(db, null, () => db.query(`SELECT 1 FROM public.care_order_task_coverage`), 'service_role'), 'permission denied') === true, 'service_role không SELECT coverage')
ok(await raises(as(db, null, () => db.query(`DELETE FROM public.care_tasks WHERE id = $1`, [L.uid(1)]), 'service_role'), 'permission denied') === true, 'service_role mất DELETE care_tasks')
ok(await raises(as(db, U.super, () => db.query(`SELECT public.care_order_links_begin_open('regular', 'apply')`)), 'permission denied') === true, 'authenticated không gọi RPC đồng bộ')
ok(await raises(as(db, null, () => db.query(`SELECT public.care__order_links_begin_open_at('regular', 'apply', NULL, 5000, NULL)`), 'service_role'), 'permission denied') === true, 'service_role không gọi bản _at')
ok(await raises(as(db, null, () => db.query(`SELECT public.care_task_orders($1)`, [L.uid(1)]), 'service_role'), 'permission denied') === true, 'service_role không gọi RPC đọc')
ok(await raises(as(db, null, () => db.query(`SELECT public.care_task_orders($1)`, [L.uid(1)]), 'anon'), 'permission denied') === true, 'anon không gọi RPC đọc')
ok((await as(db, U.A, () => j(db, `SELECT public.care_task_orders($1) r`, [L.uid(1)]))).found === false, 'authenticated gọi được RPC đọc')
const m = await one(db, `SELECT md5(replace(prosrc, chr(13), '')) AS g FROM pg_proc WHERE oid = 'public.care__import_cancel_gate(uuid,uuid,date)'::regprocedure`)
ok(m.g === gateMd5File && fs.readFileSync(path.join(L.MIG_DIR, '116_care_order_links.sql'), 'utf8').includes(`md5 gate 116 ${m.g}`), 'gate trên DB = thân trong file 116 = md5 ghi ở VERIFY')
ok((await pstate(db, P))?.status === 'active', `kỳ hiện tại ${P} = active (kỳ go-live E)`)
ok((await sstate(db))?.s === null, 'care_sync_state n3_import_orders có, chưa thành công')
await db.exec(L.MIGRATION_116)
ok(await count(db, `SELECT count(*) FROM public.care_order_period_state`) === 1, 'chạy lại 116: không nhân trạng thái')
// Đối chứng đột biến (db-reviewer E1 P0): fixture có default privileges cho role khác owner (dashboard_qa ≈ postgres của
// Supabase) ⇒ bỏ khối thu hồi ACL bảng / hàm thì hậu kiểm 116 PHẢI chặn (cả file rollback, không áp gì).
{
  const cut = (sql, marker) => {
    const i = sql.indexOf(marker)
    const j = sql.indexOf('END $$;\n', i)
    if (i < 0 || j < 0 || sql.indexOf(marker, i + 1) >= 0) throw new Error(`không cắt được khối: ${marker}`)
    return sql.slice(0, i) + sql.slice(j + 'END $$;\n'.length)
  }
  for (const [marker, needle, name] of [
    ['-- Owner-only: thu hồi MỌI quyền của mọi role khác owner', 'bảng / sequence mới có quyền ngoài owner', 'bỏ thu hồi ACL bảng / sequence'],
    ['-- Owner-only cho hàm mới: thu hồi EXECUTE của MỌI role khác owner', 'hàm mới có quyền EXECUTE ngoài owner', 'bỏ thu hồi EXECUTE hàm']]) {
    const d = await L.freshDb(PGlite, { through: '115' })
    const r = await raises(d.exec(cut(L.MIGRATION_116, marker)), needle)
    await d.exec('ROLLBACK').catch(() => {})
    ok(r === true && await count(d, `SELECT count(*) FROM pg_class WHERE relname = 'care_order_links'`) === 0, `đột biến "${name}" ⇒ hậu kiểm chặn, 0 thay đổi`, String(r))
  }
}
const pe = await one(db, `SELECT public.care__utc_us(public.care_period_end('2030-01-01')) a, public.care__utc_us(public.care_period_end('2030-02-01')) b,
                            public.care__utc_us(public.care_period_end('2028-02-01')) c`)
ok(pe.a === '2030-01-31T17:00:00.000000Z' && pe.b === '2030-02-28T17:00:00.000000Z' && pe.c === '2028-02-29T17:00:00.000000Z', 'care_period_end = 00:00 VN ngày 1 kỳ sau (gồm năm nhuận)', S(pe))
const pol = await one(db, `SELECT qual FROM pg_policies WHERE tablename = 'care_tasks' AND policyname = 'care_tasks_select'`)
ok(/assignee_id = \( SELECT care_assignee_uid\(\)/.test(pol.qual) && /store_id = \( SELECT care_staff_store_id\(\)/.test(pol.qual)
  && /SELECT care_can_view_all\(\)/.test(pol.qual) && /store_id = ANY \(\( SELECT care_scope_store_ids\(\)/.test(pol.qual), 'policy care_tasks_select vẫn là vị từ READ mà RPC chép')
const READ = '((t.assignee_id = me.uid AND t.store_id = me.sstore) OR me.v_all OR t.store_id = ANY (me.scope))'
const ME = 'public.care_assignee_uid() AS uid, public.care_staff_store_id() AS sstore,\n           public.care_can_view_all() AS v_all, public.care_scope_store_ids() AS scope'
for (const f of ['care_task_orders', 'care_task_order_counts', 'care_import_order_list']) {
  const src = (await one(db, `SELECT prosrc FROM pg_proc WHERE proname = $1`, [f])).prosrc.replace(/\s+/g, ' ')
  ok(src.includes(READ) && src.includes(ME.replace(/\s+/g, ' ')), `${f}: vị từ READ + CTE me nguyên văn`)
}

// ════════════════════════════════════════════════════════════════════════════
section('TRIGGER — freeze mốc / external_id; chặn chèn: isolation')
{
  const b = await mkBatch(db, '2030-01-01', '2030-01-05T03:00:00Z')
  const t = await mkTask(db, { ext: 'FZ-1', period: '2030-01-01', createdAt: '2030-01-05T03:00:00Z', batch: b })
  ok(await raises(db.query(`UPDATE public.care_tasks SET created_at = created_at + interval '1 second' WHERE id = $1`, [t.id]), 'CARE_TASK_CUTOFF_FROZEN') === true, 'UPDATE created_at ⇒ CARE_TASK_CUTOFF_FROZEN')
  ok(await raises(db.query(`UPDATE public.care_tasks SET period_month = '2030-02-01' WHERE id = $1`, [t.id]), 'CARE_TASK_CUTOFF_FROZEN') === true, 'UPDATE period_month ⇒ chặn')
  ok(await raises(db.query(`UPDATE public.care_customers SET external_id = 'FZ-2' WHERE external_id = 'FZ-1'`), 'CARE_CUSTOMER_ID_FROZEN') === true, 'UPDATE external_id ⇒ CARE_CUSTOMER_ID_FROZEN')
  await db.query(`UPDATE public.care_tasks SET customer_name = 'KH đổi', updated_at = now() WHERE id = $1`, [t.id])
  ok((await one(db, `SELECT customer_name FROM public.care_tasks WHERE id = $1`, [t.id])).customer_name === 'KH đổi', 'UPDATE cột khác vẫn được')
  for (const lvl of ['REPEATABLE READ', 'SERIALIZABLE']) {
    await db.exec(`BEGIN ISOLATION LEVEL ${lvl}`)
    const r = await insertTaskRaises(db, '2030-01-01', '2030-01-06T03:00:00Z', 'CARE_TASK_INSERT_ISOLATION')
    await db.exec('ROLLBACK')
    ok(r === true, `chèn task ở ${lvl} ⇒ CARE_TASK_INSERT_ISOLATION`)
  }
  await db.exec('BEGIN ISOLATION LEVEL READ COMMITTED')
  const r = await insertTaskRaises(db, '2030-01-01', '2030-01-06T03:00:00Z', 'không có')
  await db.exec('ROLLBACK')
  ok(r === 'KHÔNG raise', 'chèn task ở READ COMMITTED (kỳ chưa chốt) ⇒ được')
}

// ════════════════════════════════════════════════════════════════════════════
section('LƯỢT THƯỜNG — cửa sổ (lo, snapshot], nhiều đơn, đơn muộn, đổi giờ, relink')
db = await L.freshDb(PGlite)
const P1 = '2030-01-01', P1_END = '2030-01-31T17:00:00.000000Z'
const T0 = '2030-01-05T03:00:00.000000Z', T4 = '2030-01-08T03:00:00.000000Z'
const bA = await mkBatch(db, P1, T0), bB = await mkBatch(db, P1, T4)
const c = {}
for (const e of ['E1', 'E2', 'E3']) c[e] = await mkTask(db, { ext: e, period: P1, createdAt: T0, batch: bA })
c.E4 = await mkTask(db, { ext: 'E4', period: P1, createdAt: T4, batch: bB, store: storeId(2), assignee: U.C })
const N1 = '2030-01-10T05:00:00.000000Z', N2 = '2030-01-12T05:00:00.000000Z'
const O1 = [
  ord('DHC-1A', 'E1', T0), ord('DHC-1B', 'E1', '2030-01-05T03:00:00.000001Z'),
  ord('DHC-2A', 'E2', '2030-01-06T01:00:00.000000Z'), ord('DHC-2B', 'E2', '2030-01-09T01:00:00.000000Z'),
  ord('DHC-4X', 'E4', '2030-01-07T01:00:00.000000Z'), ord('DHC-4Y', 'E4', N1),
  ord('DHC-LATE', 'E3', '2030-01-10T05:00:00.000001Z'),
]
let R = await fullRun(db, 'regular', 'apply', N1, O1)
ok(R.open.status === 'ok' && R.open.period_month === P1 && R.open.snapshot_at === N1 && R.open.upper_bound === N1, 'begin_open: kỳ do DB suy từ snapshot, upper = snapshot', S(R.open))
ok(R.select.tasks === 4 && R.select.jobs === 1, 'begin_select: 4 task / 1 job')
ok(R.jobs[0].job.params_sha256 === R.jobs[0].sha && R.jobs[0].done.status === 'ok', 'params_sha256 DB = app (độ dài byte + µs UTC)')
ok(R.complete.status === 'complete', 'complete', S(R.complete))
let lk = await links(db)
ok(S(lk) === S({ 'DHC-1B': `E1@2030-01-05T03:00:00.000001Z`, 'DHC-2A': `E2@2030-01-06T01:00:00.000000Z`, 'DHC-2B': `E2@2030-01-09T01:00:00.000000Z`, 'DHC-4Y': `E4@${N1}` }),
  'gắn đúng: = lo không gắn, lo+1µs gắn, 2 đơn / khách, đơn trước mốc task revision không gắn, = snapshot gắn, sau snapshot chờ lượt kế', S(lk))
ok((await cov(db, c.E3.id)).u === N1 && (await cov(db, c.E1.id)).u === N1, 'coverage mọi task = snapshot (kể cả task 0 đơn)')
ok((await sstate(db)).s === N1 && (await sstate(db)).e === null, 'care_sync_state.last_success_at = snapshot')
ok((await pstate(db, P1)).status === 'active', `period_state ${P1} = active sau lượt thường`)
const O2 = [
  ord('DHC-1A', 'E1', T0), ord('DHC-1B', 'E2', '2030-01-11T00:00:00.000000Z'), // BI đổi khách ⇒ relink bị từ chối
  ord('DHC-2A', 'E2', '2030-01-06T01:00:00.000000Z'), ord('DHC-2B', 'E2', '2030-01-09T02:00:00.000000Z'), // đổi giờ
  ord('DHC-4Y', 'E4', N1), ord('DHC-LATE', 'E3', '2030-01-10T05:00:00.000001Z'),
]
R = await fullRun(db, 'regular', 'apply', N2, O2)
const ch = R.chunks[0]
ok(R.complete.status === 'complete' && ch.links_inserted === 1 && ch.links_updated === 1 && ch.relink_refused === 1, 'lượt 2: +1 đơn muộn, 1 đổi giờ, 1 relink bị từ chối', S(ch))
lk = await links(db)
ok(lk['DHC-1B'] === 'E1@2030-01-05T03:00:00.000001Z' && lk['DHC-2B'] === 'E2@2030-01-09T02:00:00.000000Z' && lk['DHC-LATE'] === 'E3@2030-01-10T05:00:00.000001Z', 'link cũ giữ khi BI đổi khách; đổi giờ cùng task cập nhật', S(lk))
const h1 = await dataHash(db)
R = await fullRun(db, 'regular', 'apply', '2030-01-12T06:00:00.000000Z', O2)
ok(R.chunks[0].links_inserted === 0 && R.chunks[0].links_updated === 0, 'chạy lại cùng dữ liệu ⇒ delta 0 (chỉ mốc tiến)')
ok((await cov(db, c.E1.id)).u === '2030-01-12T06:00:00.000000Z' && h1 !== await dataHash(db), 'coverage tiến theo snapshot mới')

// ════════════════════════════════════════════════════════════════════════════
section('KIỂM DẠNG — job / chunk / complete')
{
  const N3 = '2030-01-13T05:00:00.000000Z'
  const o = await openRun(db, 'regular', 'apply', N3)
  ok((await openRun(db, 'regular', 'apply', N3)).code === 'RUN_IN_PROGRESS', 'gọi trùng ⇒ RUN_IN_PROGRESS')
  ok(await raises(applyChunk(db, o.run_id, 1, 1, ['E1'], []), 'RUN_NOT_RUNNING') === true, 'chunk khi run preparing ⇒ RUN_NOT_RUNNING')
  await selectRun(db, o.run_id)
  const job = await runJob(db, o.run_id, 1)
  ok(S(job.customer_ids) === S(['E1', 'E2', 'E3', 'E4']) && job.from_ts[3] === T4 && job.min_lo === T0, 'run_job: mảng song song theo COLLATE "C"', S(job))
  ok(await raises(applyChunk(db, o.run_id, 1, 1, ['E1'], []), 'JOBS_NOT_DONE') === true, 'chunk trước job_done ⇒ JOBS_NOT_DONE')
  ok(await raises(jobDone(db, o.run_id, 1, 0, 0, '0'.repeat(64)), 'JOB_PARAMS_MISMATCH') === true, 'sha sai ⇒ JOB_PARAMS_MISMATCH')
  ok(await raises(jobDone(db, o.run_id, 1, 1, 2, paramsSha(job)), 'JOB_COUNTS_INVALID') === true, 'duplicates_dropped > total ⇒ JOB_COUNTS_INVALID')
  ok((await jobDone(db, o.run_id, 1, 3, 1, paramsSha(job))).status === 'ok', 'job_done (3 dòng BigQuery, khử 1 trùng)')
  ok((await jobDone(db, o.run_id, 1, 3, 1, paramsSha(job))).status === 'duplicate', 'job_done lặp cùng số ⇒ duplicate')
  ok(await raises(jobDone(db, o.run_id, 1, 4, 1, paramsSha(job)), 'JOB_ALREADY_DONE') === true, 'job_done lặp khác số ⇒ JOB_ALREADY_DONE')
  const bad = [
    [[ord('K1', 'E1', '2030-01-11T00:00:00.000000Z'), ord('K1', 'E1', '2030-01-11T00:00:01.000000Z')], 'CHUNK_DUPLICATE_ORDER_KEY', 'payload trùng order_key'],
    [[ord('K2', 'E1', T0)], 'CHUNK_ORDER_OUT_OF_WINDOW', 'ordered_at = mốc task'],
    [[ord('K3', 'E1', '2030-01-13T05:00:00.000001Z')], 'CHUNK_ORDER_OUT_OF_WINDOW', 'ordered_at > snapshot'],
    [[ord('K4', 'E3', '2030-01-11T00:00:00.000000Z')], 'CHUNK_ORDER_OUT_OF_WINDOW', 'đơn của khách ngoài chunk'],
    [[ord('K5', 'E1', '2030-01-11T00:00:00.000Z')], 'CHUNK_INVALID', 'ordered_at không đủ 6 chữ số lẻ'],
    [[{ ...ord('K6', 'E1', '2030-01-11T00:00:00.000000Z'), x: 1 }], 'CHUNK_INVALID', 'đơn thừa key'],
    [[ord(' K7', 'E1', '2030-01-11T00:00:00.000000Z')], 'CHUNK_INVALID', 'order_key có khoảng trắng đầu'],
  ]
  for (const [orders, code, name] of bad) ok(await raises(applyChunk(db, o.run_id, 1, 1, ['E1', 'E2'], orders), code) === true, `${name} ⇒ ${code}`)
  ok(await raises(applyChunk(db, o.run_id, 1, 1, ['E1', 'NOPE'], []), 'CHUNK_CUSTOMERS_INVALID') === true, 'khách không thuộc job ⇒ CHUNK_CUSTOMERS_INVALID')
  ok(await raises(applyChunk(db, o.run_id, 1, 1, ['E1', 'E1'], []), 'CHUNK_INVALID') === true, 'khách lặp trong chunk ⇒ CHUNK_INVALID')
  const okc = await applyChunk(db, o.run_id, 1, 1, ['E1', 'E2'], [ord('DHC-1C', 'E1', '2030-01-13T00:00:00.000000Z')])
  ok(okc.status === 'ok' && okc.links_inserted === 1, 'chunk 1 (E1, E2) áp')
  ok((await applyChunk(db, o.run_id, 1, 1, ['E1', 'E2'], [ord('DHC-1C', 'E1', '2030-01-13T00:00:00.000000Z')])).status === 'duplicate', 'gọi lại cùng chunk ⇒ duplicate (idempotent)')
  ok(await raises(applyChunk(db, o.run_id, 1, 1, ['E1', 'E2'], []), 'CHUNK_CONFLICT') === true, 'cùng chunk_no khác payload ⇒ CHUNK_CONFLICT')
  ok(await raises(applyChunk(db, o.run_id, 1, 2, ['E2', 'E3'], []), 'CHUNK_CUSTOMERS_INVALID') === true, 'khách đã áp ở chunk khác ⇒ CHUNK_CUSTOMERS_INVALID')
  const before = await sstate(db)
  const cpl = await complete(db, o.run_id)
  ok(cpl.status === 'failed' && cpl.code === 'RUN_CHUNKS_MISSING', 'complete khi thiếu chunk ⇒ failed RUN_CHUNKS_MISSING (không RAISE)', S(cpl))
  ok((await runOf(db, o.run_id)).status === 'failed' && (await sstate(db)).e === 'RUN_CHUNKS_MISSING' && (await sstate(db)).s === before.s,
    'run failed; last_error ghi mã; last_success_at giữ (chunk đã áp giữ, mốc riêng)')
  ok((await complete(db, o.run_id)).status === 'noop' && (await failRun(db, o.run_id, 'X_CODE')).status === 'noop', 'complete / fail trên run đã kết thúc ⇒ no-op')
  ok((await cov(db, c.E1.id)).u === N3 && (await cov(db, c.E3.id)).u === '2030-01-12T06:00:00.000000Z', 'mốc riêng: task đã áp mốc mới, task chưa áp giữ mốc cũ (Q-181)')
  // Dòng BigQuery lệch số đã áp.
  const o2 = await openRun(db, 'regular', 'apply', '2030-01-13T06:00:00.000000Z')
  await selectRun(db, o2.run_id)
  const jb = await runJob(db, o2.run_id, 1)
  await jobDone(db, o2.run_id, 1, 5, 0, paramsSha(jb))
  await applyChunk(db, o2.run_id, 1, 1, jb.customer_ids, [])
  ok((await complete(db, o2.run_id)).code === 'RUN_ROWS_MISMATCH', 'Σ rows_received + dup ≠ bq_total_rows ⇒ RUN_ROWS_MISMATCH')
  // Trần task.
  const o3 = await openRun(db, 'regular', 'apply', '2030-01-13T07:00:00.000000Z')
  ok(await raises(selectRun(db, o3.run_id, 2), 'TASKS_OVER_CAP') === true, '> trần task ⇒ TASKS_OVER_CAP (rollback)')
  ok((await runOf(db, o3.run_id)).status === 'preparing' && (await count(db, `SELECT count(*) FROM public.care_order_run_tasks WHERE run_id = $1`, [o3.run_id])) === 0, 'run vẫn preparing, 0 run_tasks')
  ok((await failRun(db, o3.run_id, 'TASKS_OVER_CAP')).status === 'failed', 'app gọi fail ⇒ failed')
  // Biên kỳ của lượt thường (P1-2 db).
  const a = await openRun(db, 'regular', 'apply', '2030-01-31T16:59:59.900000Z')
  ok(a.period_month === P1, 'lượt bắt đầu 23:59:59.9 VN ⇒ kỳ cũ')
  await failRun(db, a.run_id, 'QA_STOP')
  const b2 = await openRun(db, 'regular', 'apply', '2030-01-31T17:00:00.000000Z')
  ok(b2.period_month === '2030-02-01', 'lượt có snapshot 00:00 VN ⇒ kỳ mới (không gắn đơn 00:00 vào task kỳ cũ)')
  await failRun(db, b2.run_id, 'QA_STOP')
  ok(await raises(db.query(`INSERT INTO public.care_order_runs (kind, mode, period_month, snapshot_at, upper_bound, per_customer_cap)
                            VALUES ('regular', 'trial', '2030-01-01', '2030-01-31T17:00:00Z', '2030-01-31T17:00:00Z', 10)`), 'care_order_runs_regular_bounds_ck') === true,
    'CHECK chặn run thường kỳ cũ có snapshot ≥ P_end')
  ok(await raises(db.query(`INSERT INTO public.care_order_runs (kind, mode, period_month, snapshot_at, upper_bound, per_customer_cap)
                            VALUES ('close', 'trial', '2030-01-01', '2030-01-31T17:20:00Z', '2030-01-31T17:00:00Z', 10)`), 'care_order_runs_close_bounds_ck') === true,
    'CHECK chặn lượt chốt chạy trước P_end + 30 phút')
}

// ════════════════════════════════════════════════════════════════════════════
section('LƯỢT CHỐT — biên 23:59:59.999999 / 00:00, đóng băng, không mở lại')
{
  const NC = '2030-01-31T17:40:00.000000Z'
  const h0 = await dataHash(db)
  ok((await openRun(db, 'close', 'apply', '2030-01-31T17:20:00.000000Z')).code === 'CLOSE_NOT_ELIGIBLE' && h0 === await dataHash(db), 'trước P_end + 30 phút ⇒ skipped, 0 ghi')
  const OC = [...O2, ord('DHC-EDGE', 'E3', '2030-01-31T16:59:59.999999Z'), ord('DHC-MID', 'E3', P1_END)]
  const o = await openRun(db, 'close', 'apply', NC)
  ok(o.status === 'ok' && o.period_month === P1 && o.upper_bound === P1_END && o.is_close, 'begin_open(close): kỳ trước, upper = P_end', S(o))
  ok((await openRun(db, 'close', 'apply', NC)).code === 'RUN_IN_PROGRESS' && (await pstate(db, P1)).status === 'active', 'gọi chốt trùng ⇒ RUN_IN_PROGRESS, state không đổi')
  const sel = await selectRun(db, o.run_id)
  const jr = await readJobs(db, o.run_id, sel.jobs, OC)
  ok(!jr[0].rows.some((x) => x.order_key === 'DHC-MID'), 'BigQuery giả loại đơn 00:00:00 (nghiêm ngặt < P_end)')
  ok(await raises(applyChunk(db, o.run_id, 1, 1, ['E3'], [ord('DHC-MID', 'E3', P1_END)]), 'CHUNK_ORDER_OUT_OF_WINDOW') === true, 'DB chặn đơn = P_end ở lượt chốt')
  await applyJobs(db, o.run_id, jr)
  const cp = await complete(db, o.run_id)
  ok(cp.status === 'closed', 'complete(close) ⇒ closed', S(cp))
  const st = await pstate(db, P1)
  ok(st.status === 'closed' && st.thru === P1_END && Number(st.close_run_id) === o.run_id && st.last_error === null, 'period_state closed, closed_through = P_end, close_run_id', S(st))
  ok((await links(db))['DHC-EDGE'] === 'E3@2030-01-31T16:59:59.999999Z' && !(await links(db))['DHC-MID'], '23:59:59.999999 nhận, 00:00:00 không')
  ok((await cov(db, c.E4.id)).u === P1_END && Number((await cov(db, c.E4.id)).run_id) === o.run_id, 'coverage kỳ chốt = P_end, run_id = lượt chốt')
  ok(await insertTaskRaises(db, P1, '2030-01-20T03:00:00Z', 'PERIOD_CLOSED_FOR_ORDERS') === true, 'chèn task vào kỳ đã chốt ⇒ PERIOD_CLOSED_FOR_ORDERS')
  // Một lệnh INSERT chứa task của HAI kỳ (đã chốt + đang mở) ⇒ cả lệnh bị chặn, 0 dòng; hai kỳ đang mở ⇒ được.
  {
    const bm = await mkBatch(db, '2030-02-01', '2030-02-02T03:00:00Z')
    await db.query(`INSERT INTO public.care_customers (external_id) VALUES ('MP-1'), ('MP-2'), ('MP-3'), ('MP-4')`)
    const multi = (pa, pb, ea, eb) => db.query(`INSERT INTO public.care_tasks (customer_id, period_month, due_date, batch_id, store_id, assignee_id, customer_name, phone_norm, phone_raw, created_at)
      SELECT c.id, v.p::date, public.care_period_last_day(v.p::date), $1, $2, $3, 'KH', '0390000999', '0390000999', v.at::timestamptz
      FROM (VALUES ($4, $5, $6), ($7, $8, $9)) v(e, p, at) JOIN public.care_customers c ON c.external_id = v.e`,
      [bm, storeId(1), U.A, ea, pa, `${pa.slice(0, 8)}10T03:00:00Z`, eb, pb, `${pb.slice(0, 8)}10T03:00:00Z`])
    ok(await raises(multi(P1, '2030-02-01', 'MP-1', 'MP-2'), 'PERIOD_CLOSED_FOR_ORDERS') === true
      && await count(db, `SELECT count(*) FROM public.care_tasks t JOIN public.care_customers c ON c.id = t.customer_id WHERE c.external_id IN ('MP-1', 'MP-2')`) === 0,
      'một lệnh INSERT 2 kỳ (1 kỳ đã chốt) ⇒ chặn cả lệnh, 0 dòng')
    await multi('2030-03-01', '2030-02-01', 'MP-3', 'MP-4')
    ok(await count(db, `SELECT count(*) FROM public.care_tasks t JOIN public.care_customers c ON c.id = t.customer_id WHERE c.external_id IN ('MP-3', 'MP-4')`) === 2,
      'một lệnh INSERT 2 kỳ đang mở ⇒ được (khoá từng kỳ theo thứ tự)')
  }
  ok((await openRun(db, 'close', 'apply', '2030-01-31T18:00:00.000000Z')).code === 'CLOSE_NOT_ELIGIBLE', 'gọi chốt lại kỳ closed ⇒ CLOSE_NOT_ELIGIBLE')
  ok((await openRun(db, 'close', 'apply', '2030-01-31T18:00:00.000000Z', { retry: P1 })).code === 'CLOSE_NOT_ELIGIBLE' && (await pstate(db, P1)).status === 'closed', 'header chạy lại với kỳ closed ⇒ từ chối, kỳ vẫn closed')
  ok((await openRun(db, 'close', 'trial', '2030-01-31T18:00:00.000000Z')).code === 'CLOSE_NOT_ELIGIBLE', 'trial chốt kỳ closed ⇒ từ chối')
  // Lượt thường kỳ mới không đụng kỳ đã chốt; sweep không lật closed.
  const b3 = await mkBatch(db, '2030-02-01', '2030-02-01T03:00:00Z')
  const f1 = await mkTask(db, { ext: 'F1', period: '2030-02-01', createdAt: '2030-02-01T03:00:00Z', batch: b3 })
  R = await fullRun(db, 'regular', 'apply', '2030-02-03T05:00:00.000000Z', [ord('DHC-F1', 'F1', '2030-02-02T00:00:00.000000Z'), ord('DHC-0000', 'F1', P1_END)])
  ok(R.complete.status === 'complete' && R.select.tasks === 1, 'lượt thường kỳ 02 chỉ quét task kỳ 02')
  ok((await links(db))['DHC-0000'] === undefined, 'đơn 00:00 ngày 1 trước mốc task kỳ mới không gắn task nào (Q-190)')
  const sw = await openRun(db, 'regular', 'apply', '2030-03-05T05:00:00.000000Z')
  ok(sw.status === 'ok' && (await pstate(db, P1)).status === 'closed', 'sweep lỡ khung không lật kỳ closed')
  await failRun(db, sw.run_id, 'QA_STOP')
  ok(await raises(applyChunk(db, o.run_id, 1, 9, ['E1'], []), 'RUN_NOT_RUNNING') === true, 'chunk cho lượt chốt đã xong ⇒ từ chối')
  // I1 bị vi phạm (fixture cố ý): task kỳ sau của cùng khách tạo TRƯỚC đơn ⇒ task đích không còn là task gần nhất.
  const bz = await mkBatch(db, '2031-01-01', '2031-01-05T03:00:00Z')
  const z1 = await mkTask(db, { ext: 'Z1', period: '2031-01-01', createdAt: '2031-01-05T03:00:00Z', batch: bz })
  await db.query(`UPDATE public.care_tasks SET status = 'closed_unfinished', closed_at = now(), next_action_date = NULL WHERE id = $1`, [z1.id])
  const bz2 = await mkBatch(db, '2031-02-01', '2031-01-20T03:00:00Z')
  await mkTask(db, { ext: 'Z1', period: '2031-02-01', createdAt: '2031-01-20T03:00:00Z', batch: bz2 })
  const oz = await openRun(db, 'regular', 'apply', '2031-01-25T05:00:00.000000Z')
  await selectRun(db, oz.run_id)
  const jz = await runJob(db, oz.run_id, 1)
  await jobDone(db, oz.run_id, 1, 1, 0, paramsSha(jz))
  ok(await raises(applyChunk(db, oz.run_id, 1, 1, ['Z1'], [ord('DHC-Z', 'Z1', '2031-01-22T00:00:00.000000Z')]), 'TARGET_INVARIANT_BROKEN') === true, 'I1 vi phạm ⇒ TARGET_INVARIANT_BROKEN (fail-closed)')
  await failRun(db, oz.run_id, 'TARGET_INVARIANT_BROKEN')
  void f1
}

// ════════════════════════════════════════════════════════════════════════════
section('MÁY TRẠNG THÁI CHỐT — coverage thiếu, chạy lại theo kỳ, fail, abandoned, lỡ khung, song song lượt thường')
db = await L.freshDb(PGlite)
{
  const P3 = '2030-03-01', P3_END = '2030-03-31T17:00:00.000000Z'
  const b = await mkBatch(db, P3, '2030-03-05T03:00:00Z')
  await mkTask(db, { ext: 'G1', period: P3, createdAt: '2030-03-05T03:00:00Z', batch: b })
  await mkTask(db, { ext: 'G2', period: P3, createdAt: '2030-03-05T03:00:00Z', batch: b })
  ok((await fullRun(db, 'regular', 'apply', '2030-03-10T05:00:00.000000Z', [])).complete.status === 'complete', 'lượt thường kỳ 03')
  // Lượt thường (kỳ 04) và lượt chốt (kỳ 03) chạy cùng lúc.
  const reg = await openRun(db, 'regular', 'apply', '2030-03-31T17:40:00.000000Z')
  let late = null
  R = await fullRun(db, 'close', 'apply', '2030-03-31T17:40:00.000000Z', [], {
    beforeComplete: async () => {
      // Task commit sau begin_select (finalize commit muộn): chưa chốt ⇒ trigger cho qua; hậu kiểm thấy lệch.
      late = await mkTask(db, { ext: 'G3', period: P3, createdAt: '2030-03-31T10:00:00Z', batch: b })
    },
  })
  ok(reg.status === 'ok' && R.open.status === 'ok', 'UNIQUE (kind, mode): lượt thường kỳ mới và lượt chốt kỳ trước chạy song song')
  ok(R.complete.status === 'failed' && R.complete.code === 'CLOSE_COVERAGE_INCOMPLETE', 'task mới sau begin_select ⇒ failed CLOSE_COVERAGE_INCOMPLETE', S(R.complete))
  let st = await pstate(db, P3)
  ok(st.status === 'close_failed' && st.last_error === 'CLOSE_COVERAGE_INCOMPLETE' && st.thru === null, 'close_failed, closed_through không tiến', S(st))
  ok((await runOf(db, R.open.run_id)).status === 'failed', 'run chốt failed (không bao giờ complete)')
  ok((await openRun(db, 'close', 'apply', '2030-03-31T18:00:00.000000Z')).code === 'CLOSE_NOT_ELIGIBLE', 'không header ⇒ không tự chạy lại')
  ok((await openRun(db, 'close', 'apply', '2030-03-31T18:00:00.000000Z', { retry: '2030-02-01' })).code === 'CLOSE_NOT_ELIGIBLE', 'header sai kỳ ⇒ từ chối')
  R = await fullRun(db, 'close', 'apply', '2030-04-01T03:00:00.000000Z', [ord('DHC-G3', 'G3', '2030-03-31T12:00:00.000000Z')], { retry: P3 })
  ok(R.complete.status === 'closed' && R.select.tasks === 3, 'header X-Care-Close-Retry = kỳ ⇒ chạy lại, gồm task commit muộn ⇒ closed', S(R.complete))
  ok((await runOf(db, R.open.run_id)).is_retry === true && (await cov(db, late.id)).u === P3_END, 'run đánh dấu retry; task muộn có coverage P_end')
  await failRun(db, reg.run_id, 'QA_STOP')
  // fail() của lượt chốt.
  const P5 = '2030-05-01'
  const b5 = await mkBatch(db, P5, '2030-05-05T03:00:00Z')
  await mkTask(db, { ext: 'G5', period: P5, createdAt: '2030-05-05T03:00:00Z', batch: b5 })
  await fullRun(db, 'regular', 'apply', '2030-05-10T05:00:00.000000Z', [])
  const o5 = await openRun(db, 'close', 'apply', '2030-05-31T17:40:00.000000Z')
  ok((await failRun(db, o5.run_id, 'BQ_TIMEOUT')).status === 'failed' && (await pstate(db, P5)).status === 'close_failed' && (await pstate(db, P5)).last_error === 'BQ_TIMEOUT', 'fail lượt chốt ⇒ close_failed cùng transaction')
  // Abandoned: lượt chốt chết, không có lượt chốt nào khác.
  const P7 = '2030-07-01'
  const b7 = await mkBatch(db, P7, '2030-07-05T03:00:00Z')
  await mkTask(db, { ext: 'G7', period: P7, createdAt: '2030-07-05T03:00:00Z', batch: b7 })
  await fullRun(db, 'regular', 'apply', '2030-07-10T05:00:00.000000Z', [])
  const o7 = await openRun(db, 'close', 'apply', '2030-07-31T17:40:00.000000Z')
  await selectRun(db, o7.run_id)
  await db.query(`UPDATE public.care_order_runs SET started_at = clock_timestamp() - interval '3 hours' WHERE run_id = $1`, [o7.run_id])
  const sw = await openRun(db, 'regular', 'apply', '2030-08-01T05:00:00.000000Z')
  ok(sw.swept >= 1 && (await runOf(db, o7.run_id)).status === 'abandoned' && (await pstate(db, P7)).last_error === 'RUN_ABANDONED' && (await pstate(db, P7)).status === 'close_failed',
    'lượt thường kế tiếp abandon lượt chốt > 2 h ⇒ close_failed RUN_ABANDONED', S(sw))
  ok((await complete(db, o7.run_id)).status === 'noop' && (await failRun(db, o7.run_id, 'LATE')).status === 'noop' && (await pstate(db, P7)).last_error === 'RUN_ABANDONED',
    'run bị abandon còn sống gọi complete / fail ⇒ no-op')
  await failRun(db, sw.run_id, 'QA_STOP')
  // Lỡ khung: kỳ active quá P_end + 24 h không có lượt chốt.
  const P9 = '2030-09-01'
  const b9 = await mkBatch(db, P9, '2030-09-05T03:00:00Z')
  await mkTask(db, { ext: 'G9', period: P9, createdAt: '2030-09-05T03:00:00Z', batch: b9 })
  await fullRun(db, 'regular', 'apply', '2030-09-10T05:00:00.000000Z', [])
  const o9 = await openRun(db, 'close', 'apply', '2030-10-01T17:00:00.000000Z') // P_end + 24 h
  ok(o9.code === 'CLOSE_NOT_ELIGIBLE' && (await pstate(db, P9)).status === 'close_failed' && (await pstate(db, P9)).last_error === 'CLOSE_WINDOW_MISSED', 'tới P_end + 24 h chưa chốt ⇒ CLOSE_WINDOW_MISSED')
  ok(await count(db, `SELECT count(*) FROM public.care_order_period_state s WHERE s.status = 'active'
                      AND timestamptz '2030-10-01T17:00:00Z' >= public.care_period_end(s.period_month) + interval '24 hours'`) === 0, 'V-stuck = 0')
  ok((await pstate(db, P3)).status === 'closed', 'kỳ closed không bị lật bởi các luật trên')
  // Kỳ go-live: kỳ cũ hơn kỳ go-live không được tạo trạng thái.
  ok((await openRun(db, 'close', 'apply', '2026-01-31T17:40:00.000000Z')).code === 'CLOSE_NOT_ELIGIBLE'
    && await count(db, `SELECT count(*) FROM public.care_order_period_state WHERE period_month = '2026-01-01'`) === 0, 'kỳ trước go-live E ⇒ không tạo trạng thái, không chốt')
  // V-closed-run hai chiều.
  ok(await count(db, `SELECT count(*) FROM public.care_order_period_state s LEFT JOIN public.care_order_runs r ON r.run_id = s.close_run_id
                      WHERE s.status = 'closed' AND (r.run_id IS NULL OR r.kind <> 'close' OR r.status <> 'complete')`) === 0
    && await count(db, `SELECT count(*) FROM public.care_order_runs r LEFT JOIN public.care_order_period_state s ON s.period_month = r.period_month
                        WHERE r.kind = 'close' AND r.mode = 'apply' AND r.status = 'complete' AND (s.status IS DISTINCT FROM 'closed' OR s.close_run_id <> r.run_id)`) === 0,
    'V-closed-run (a) + (b) = 0')
  ok(await count(db, `SELECT count(*) FROM public.care_tasks t JOIN public.care_order_period_state s ON s.period_month = t.period_month AND s.status = 'closed'
                      LEFT JOIN public.care_order_task_coverage c ON c.task_id = t.id WHERE c.task_id IS NULL OR c.run_id <> s.close_run_id`) === 0, 'V-close-cov = 0')
}

// ════════════════════════════════════════════════════════════════════════════
section('TRIAL — không ghi link / coverage / state; cleanup về 0')
{
  const P11 = '2030-11-01'
  const b = await mkBatch(db, P11, '2030-11-05T03:00:00Z')
  await mkTask(db, { ext: 'H1', period: P11, createdAt: '2030-11-05T03:00:00Z', batch: b })
  await mkTask(db, { ext: 'H2', period: P11, createdAt: '2030-11-05T03:00:00Z', batch: b })
  const h0 = await dataHash(db)
  R = await fullRun(db, 'regular', 'trial', '2030-11-10T05:00:00.000000Z', [ord('T-1', 'H1', '2030-11-06T00:00:00.000000Z'), ord('T-2', 'H1', '2030-11-07T00:00:00.000000Z')])
  ok(R.complete.status === 'complete' && R.complete.mode === 'trial' && R.complete.tasks === 2 && R.complete.tasks_with_orders === 1 && R.complete.orders === 2, 'trial: số tổng hợp', S(R.complete))
  ok(h0 === await dataHash(db), 'trial không đổi link / coverage / period_state / sync_state')
  const reg = await openRun(db, 'regular', 'apply', '2030-11-10T06:00:00.000000Z')
  ok(reg.status === 'ok', 'trial không chặn lượt apply (UNIQUE theo mode)')
  await failRun(db, reg.run_id, 'QA_STOP')
  const ct = await svc(db, `SELECT public.care_order_links_trial_cleanup() r`)
  ok(ct.remaining_trial_runs === 0 && ct.deleted_runs >= 1, 'trial_cleanup (service_role) ⇒ 0 run trial', S(ct))
  ok(await count(db, `SELECT count(*) FROM public.care_order_run_tasks rt JOIN public.care_order_runs r ON r.run_id = rt.run_id WHERE r.mode = 'trial'`) === 0, 'metadata trial = 0')
}

// ════════════════════════════════════════════════════════════════════════════
section('DỌN QA — care_qa_delete_test_tasks (X → L), trigger dọn coverage')
{
  const P12 = '2030-12-01'
  const b = await mkBatch(db, P12, '2030-12-05T03:00:00Z', true)
  const q1 = await mkTask(db, { ext: 'Q1', period: P12, createdAt: '2030-12-05T03:00:00Z', batch: b, isTest: true })
  const q2 = await mkTask(db, { ext: 'Q2', period: P12, createdAt: '2030-12-05T03:00:00Z', batch: b, isTest: true })
  const bReal = await mkBatch(db, P12, '2030-12-05T03:00:00Z')
  const real = await mkTask(db, { ext: 'Q3', period: P12, createdAt: '2030-12-05T03:00:00Z', batch: bReal })
  await fullRun(db, 'regular', 'apply', '2030-12-10T05:00:00.000000Z', [ord('Q-1', 'Q1', '2030-12-06T00:00:00.000000Z')])
  const ids = [q1.id, q2.id]
  ok(S(await svc(db, `SELECT public.care_order_links_qa_counts($1::uuid[]) r`, [ids])) === S({ care_order_links: 1, care_order_task_coverage: 2 }), 'qa_counts trước dọn: 1 link, 2 coverage')
  const run = await openRun(db, 'regular', 'apply', '2030-12-10T06:00:00.000000Z')
  ok((await svc(db, `SELECT public.care_qa_delete_test_tasks($1::uuid[]) r`, [ids])).code === 'ORDERS_SYNC_RUNNING', 'đang có lượt apply ⇒ từ chối (fixture thử lại)')
  await failRun(db, run.run_id, 'QA_STOP')
  ok(await raises(svc(db, `SELECT public.care_qa_delete_test_tasks($1::uuid[]) r`, [[q1.id, real.id]]), 'NOT_TEST_TASK') === true, 'lẫn task thật ⇒ NOT_TEST_TASK')
  const del = await svc(db, `SELECT public.care_qa_delete_test_tasks($1::uuid[]) r`, [ids])
  ok(del.status === 'ok' && del.links === 1 && del.tasks === 2, 'xoá link → task', S(del))
  ok(S(await svc(db, `SELECT public.care_order_links_qa_counts($1::uuid[]) r`, [ids])) === S({ care_order_links: 0, care_order_task_coverage: 0 }), 'coverage dọn cùng transaction (V12b)')
  ok(await count(db, `SELECT count(*) FROM public.care_order_task_coverage c WHERE NOT EXISTS (SELECT 1 FROM public.care_tasks t WHERE t.id = c.task_id)`) === 0, 'V12b coverage mồ côi = 0')
}

// ════════════════════════════════════════════════════════════════════════════
section(`D1 — gate / assess 116 (kỳ thật ${P}, finalize 115)`)
{
  db = await L.freshDb(PGlite)
  const preview = async (b) => (await one(db, `SELECT public.care__import_cancel_preview_at($1, $2, $3::date) AS r`, [b, U.mkt, todayVN])).r
  const cancel = async (b) => {
    const seq = (await one(db, `SELECT commit_seq::text s FROM public.care_import_batches WHERE id = $1`, [b])).s
    return (await one(db, `SELECT public.care__import_cancel_at($1, $2, $3::bigint, $4::date, NULL) AS r`, [b, U.mkt, seq, todayVN])).r
  }
  const ext = (n) => `QA116-${n}`
  const b1 = await stage(db, [row(ext(1), S1, EA, '1101'), row(ext(2), S1, EA, '1201'), row(ext(3), S1, EA, '1301')], { period: P })
  ok((await finalize(db, b1, U.mkt, todayVN)).status === 'committed', 'B1 initial')
  ok((await preview(b1)).code === 'ORDERS_SYNC_STALE', 'chưa có lượt thường thành công ⇒ ORDERS_SYNC_STALE')
  let r = await fullRun(db, 'regular', 'apply', null, [])
  ok(r.complete.status === 'complete' && r.select.tasks === 3, 'lượt thường kỳ thật (đồng hồ DB)')
  const pv = await preview(b1)
  ok(pv.status === 'ready' && typeof pv.orders_checked_at === 'string', 'đã đối chiếu sau import ⇒ ready (+ orders_checked_at)', S(pv))
  const run = await openRun(db, 'regular', 'apply', null)
  ok((await preview(b1)).code === 'ORDERS_SYNC_RUNNING', 'lượt thường đang chạy ⇒ ORDERS_SYNC_RUNNING')
  await failRun(db, run.run_id, 'QA_STOP')
  await db.query(`UPDATE public.care_sync_state SET last_success_at = now() - interval '25 hours' WHERE source = 'n3_import_orders'`)
  ok((await preview(b1)).code === 'ORDERS_SYNC_STALE', 'lượt thành công cuối > 24 h ⇒ ORDERS_SYNC_STALE')
  r = await fullRun(db, 'regular', 'apply', null, [])
  const b2 = await stage(db, [row(ext(1), S1, EA, '1102'), row(ext(4), S1, EA, '1401')], { period: P })
  ok((await finalize(db, b2, U.mkt, todayVN)).kind === 'revision', 'B2 revision (sửa c1, thêm c4)')
  ok((await preview(b2)).code === 'ORDERS_NOT_COVERED', 'task B2 tạo / sửa chưa được quét sau B2 ⇒ ORDERS_NOT_COVERED')
  r = await fullRun(db, 'regular', 'apply', null, [])
  ok((await preview(b2)).status === 'ready', 'quét sau B2 ⇒ ready')
  const t4 = await taskOf(db, ext(4), P)
  const lo4 = (await one(db, `SELECT public.care__utc_us(created_at + interval '1 microsecond') AS u FROM public.care_tasks WHERE id = $1`, [t4.id])).u
  r = await fullRun(db, 'regular', 'apply', null, [ord('DHC-D1', ext(4), lo4)])
  ok(r.chunks[0].links_inserted === 1, 'đơn N3 gắn task c4 (T_new của B2)')
  ok((await preview(b2)).code === 'HAS_VERIFIED_ORDER', 'có đơn xác thực ⇒ HAS_VERIFIED_ORDER (Q-182)')
  ok((await cancel(b2)).code === 'HAS_VERIFIED_ORDER' && await count(db, `SELECT count(*) FROM public.care_tasks WHERE id = $1`, [t4.id]) === 1, 'huỷ bị chặn, task còn')
  // Huỷ batch có coverage (0 đơn) ⇒ coverage của task bị xoá biến mất cùng transaction.
  db = await L.freshDb(PGlite)
  const b3 = await stage(db, [row(ext(7), S1, EA, '1701'), row(ext(8), S1, EA, '1801')], { period: P })
  await finalize(db, b3, U.mkt, todayVN)
  await fullRun(db, 'regular', 'apply', null, [])
  const ids = (await db.query(`SELECT id FROM public.care_tasks WHERE batch_id = $1`, [b3])).rows.map((x) => x.id)
  ok(await count(db, `SELECT count(*) FROM public.care_order_task_coverage WHERE task_id = ANY ($1::uuid[])`, [ids]) === 2, 'trước huỷ: 2 coverage')
  const cc = await cancel(b3)
  ok(cc.status === 'cancelled' && cc.tasks_deleted === 2, 'huỷ initial có coverage, 0 đơn ⇒ cancelled', S(cc))
  ok(await count(db, `SELECT count(*) FROM public.care_order_task_coverage`) === 0, 'coverage của task bị xoá = 0 (V12b)')
  r = await fullRun(db, 'regular', 'apply', null, [])
  ok(r.select.tasks === 0 && await count(db, `SELECT count(*) FROM public.care_order_task_coverage`) === 0, 'lượt ngay sau huỷ không tạo lại coverage')
}

// ════════════════════════════════════════════════════════════════════════════
section(`RPC ĐỌC — vai trò, byte-identical, keyset, partial, cohort KPI (kỳ thật ${P})`)
{
  db = await L.freshDb(PGlite)
  const b = await stage(db, [row('R-A', S1, EA, '1'), row('R-B', S1, EB, '1'), row('R-C', S2, EC, '1')], { period: P })
  await finalize(db, b, U.mkt, todayVN)
  const tA = await taskOf(db, 'R-A', P), tB = await taskOf(db, 'R-B', P), tC = await taskOf(db, 'R-C', P)
  const loA = (await one(db, `SELECT public.care__utc_us(created_at) AS u FROM public.care_tasks WHERE id = $1`, [tA.id])).u
  const plus = (iso, us) => { // iso µs + us micro giây (cùng giây đủ dùng cho fixture)
    const [head, frac] = iso.slice(0, -1).split('.')
    const v = BigInt(Date.parse(head + 'Z')) * 1000n + BigInt(frac) + BigInt(us)
    const ms = v / 1000n, rest = v % 1000n
    return new Date(Number(ms)).toISOString().replace(/\.(\d{3})Z$/, (_, d) => `.${d}${String(rest).padStart(3, '0')}Z`)
  }
  const orders = Array.from({ length: 25 }, (_, i) => ord(`DHC-A${String(i).padStart(2, '0')}`, 'R-A', plus(loA, i + 1)))
  orders.push(ord('DHC-C1', 'R-C', plus(loA, 30)))
  const r = await fullRun(db, 'regular', 'apply', null, orders)
  ok(r.complete.status === 'complete' && r.chunks[0].links_inserted === 26, 'lượt thường gắn 25 đơn A + 1 đơn C', S(r.chunks))
  const asJ = (who, sql, p) => as(db, who, () => j(db, sql, p))
  const pg1 = await asJ(U.A, `SELECT public.care_task_orders($1) r`, [tA.id])
  ok(pg1.found && pg1.orders.length === 20 && pg1.has_more && pg1.orders_count === 25 && pg1.coverage && pg1.is_current_period && pg1.period_status === 'active', 'A xem task mình: trang 20 / có thêm', S({ ...pg1, orders: pg1.orders.length }))
  const last = pg1.orders[19]
  const pg2 = await asJ(U.A, `SELECT public.care_task_orders($1, $2::timestamptz, $3) r`, [tA.id, last.completed_at, last.link_id])
  ok(pg2.orders.length === 5 && !pg2.has_more && pg2.orders[0].order_code === 'DHC-A04', 'keyset (completed_at, link_id) ⇒ trang 2 còn 5', S(pg2.orders.map((x) => x.order_code)))
  const half1 = await asJ(U.A, `SELECT public.care_task_orders($1, $2::timestamptz, NULL) r`, [tA.id, last.completed_at])
  const half2 = await asJ(U.A, `SELECT public.care_task_orders($1, NULL, $2) r`, [tA.id, last.link_id])
  const half3 = await asJ(U.super, `SELECT public.care_import_order_list($1::date, NULL, NULL, NULL, $2::timestamptz, NULL) r`, [P, last.completed_at])
  const half4 = await asJ(U.super, `SELECT public.care_report_conversion_list($1::date, NULL, NULL, false, NULL, $2) r`, [P, tA.id])
  ok(half1.orders.length === 0 && half2.orders.length === 0 && half3.rows.length === 0 && half4.rows.length === 0, 'keyset nửa NULL ⇒ 0 dòng (không bỏ sót / lặp dòng cùng mốc)')
  const notFound = S(await asJ(U.A, `SELECT public.care_task_orders($1) r`, [L.uid(99999)]))
  ok(S(await asJ(U.A, `SELECT public.care_task_orders($1) r`, [tC.id])) === notFound && notFound === S({ found: false }), 'A xem task người khác ⇒ byte-identical "không tồn tại"')
  ok(S(await asJ(U.qlch1, `SELECT public.care_task_orders($1) r`, [tA.id])) === notFound, 'QLCH ⇒ không có gì')
  ok((await asJ(U.sm, `SELECT public.care_task_orders($1) r`, [tC.id])).found === true, 'SM trong vùng ⇒ thấy')
  ok((await asJ(U.sm2, `SELECT public.care_task_orders($1) r`, [tC.id])).found === false, 'SM ngoài vùng ⇒ không')
  ok((await asJ(U.mkt, `SELECT public.care_task_orders($1) r`, [tB.id])).found === true && (await asJ(U.super, `SELECT public.care_task_orders($1) r`, [tB.id])).found === true, 'care admin (view_all) / super ⇒ thấy')
  const cnt = await asJ(U.A, `SELECT public.care_task_order_counts($1::uuid[]) r`, [[tA.id, tC.id]])
  ok(cnt.length === 1 && cnt[0].task_id === tA.id && cnt[0].orders_count === 25 && cnt[0].coverage === true && cnt[0].lagging === false, 'counts chỉ task đọc được', S(cnt))
  ok(await raises(asJ(U.A, `SELECT public.care_task_order_counts($1::uuid[]) r`, [Array.from({ length: 51 }, (_, i) => L.uid(5000 + i))]), '0–50') === true, '51 task ⇒ từ chối')
  const lsS = await asJ(U.super, `SELECT public.care_import_order_list($1::date) r`, [P])
  ok(lsS.rows.length === 2 && lsS.summary.tasks === 3 && lsS.summary.covered === 3 && lsS.summary.with_orders === 2 && lsS.partial === false && lsS.rows[0].task_id === tC.id,
    'danh sách super: 2 task có đơn / 3 task, không partial, mới nhất trước', S({ ...lsS, rows: lsS.rows.map((x) => x.task_id) }))
  ok(!S(lsS).includes('DHC-'), 'danh sách không có mã đơn')
  const lsA = await asJ(U.A, `SELECT public.care_import_order_list($1::date) r`, [P])
  ok(lsA.rows.length === 1 && lsA.summary.tasks === 1, 'danh sách dược sĩ A: chỉ task mình')
  ok((await asJ(U.sm, `SELECT public.care_import_order_list($1::date, $2::uuid[]) r`, [P, [storeId(2)]])).rows.length === 1, 'SM lọc store 2')
  ok((await asJ(U.super, `SELECT public.care_import_order_list($1::date, NULL, NULL, $2) r`, [P, L.uid(4242)])).summary.tasks === 0, 'phạm vi QA (batch khác) ⇒ 0 task thật')
  ok((await asJ(U.A, `SELECT public.care_import_order_list($1::date, NULL, NULL, $2) r`, [P, b])).summary.tasks === 0
    && (await asJ(U.A, `SELECT public.care_my_order_summary($1) r`, [b])).tasks === 0, 'dược sĩ tự truyền p_qa_batch_id = batch thật ⇒ 0 task (chỉ is_test của batch, vẫn qua READ)')
  // partial: một task mất coverage (fixture) ⇒ partial.
  await db.query(`DELETE FROM public.care_order_task_coverage WHERE task_id = $1`, [tB.id])
  const lsP = await asJ(U.super, `SELECT public.care_import_order_list($1::date) r`, [P])
  ok(lsP.partial === true && lsP.summary.not_covered === 1, 'task chưa coverage ⇒ partial (Q-181)')
  const my = await asJ(U.A, `SELECT public.care_my_order_summary() r`, [])
  ok(my.tasks === 1 && my.tasks_with_orders === 1 && my.orders === 25 && my.covered === 1, 'thẻ dược sĩ: kỳ hiện tại của mình', S(my))
  ok(await asJ(U.super, `SELECT public.care_my_order_summary() r`, []) === null, 'không phải dược sĩ ⇒ NULL')
  ok((await asJ(U.A, `SELECT public.care_my_order_tasks() r`, [])).rows.length === 1, 'danh sách task có đơn của tôi')
  ok(await asJ(U.qlch1, `SELECT public.care_import_order_state($1::date) r`, [P]) === null, 'trạng thái: QLCH ⇒ NULL')
  const stA = await asJ(U.A, `SELECT public.care_import_order_state($1::date) r`, [P])
  ok(stA.has_synced && stA.chain === null && stA.period_status === 'active', 'trạng thái: dược sĩ không nhận số toàn chuỗi')
  ok((await asJ(U.super, `SELECT public.care_import_order_state($1::date) r`, [P])).chain.tasks === 3, 'trạng thái: super nhận số toàn chuỗi')
  // Cohort KPI: attribution 114 trên task B (lượt Hoàn thành rồi đơn), chuyển giao B → C sau đó.
  await db.query(`INSERT INTO public.care_interactions (task_id, customer_id, actor_id, assignee_id, store_id, period_month, outcome, is_terminal, note, is_test, created_at)
                  SELECT id, customer_id, assignee_id, assignee_id, store_id, period_month, 'ORDERED', true, 'QA 116', is_test, now() - interval '10 minutes'
                  FROM public.care_tasks WHERE id = $1`, [tB.id])
  await as(db, null, () => db.query(`SELECT public.care_order_sync_apply($1::jsonb, now())`,
    [S([{ order_key: 'KPI-1', customer_external_id: 'R-B', ordered_at: new Date(Date.now() - 5 * 60_000).toISOString().replace('Z', '000Z') }])]), 'service_role')
  const kpiS = await asJ(U.super, `SELECT public.care_report_conversion_list($1::date) r`, [P])
  const repS = await as(db, U.super, async () => (await db.query(`SELECT COALESCE(sum(converted_tasks), 0)::int AS n FROM public.care_report($1::date)`, [P])).rows[0].n)
  ok(kpiS.cohort_total === repS && repS === 1 && kpiS.visible_total === 1 && kpiS.rows[0].task_id === tB.id, 'cohort = Σ converted_tasks của care_report (super)', S(kpiS))
  await L.transfer(db, todayVN, U.super, [tB.id], U.C)
  const repB = await as(db, U.B, async () => (await db.query(`SELECT COALESCE(sum(converted_tasks), 0)::int AS n FROM public.care_report($1::date)`, [P])).rows[0].n)
  const kpiB = await asJ(U.B, `SELECT public.care_report_conversion_list($1::date) r`, [P])
  ok(kpiB.cohort_total === repB && repB === 1 && kpiB.visible_total === 0 && kpiB.rows.length === 0, 'sau chuyển giao: B còn 1 trong báo cáo, 0 task còn quyền xem', S(kpiB))
  ok((await asJ(U.C, `SELECT public.care_report_conversion_list($1::date) r`, [P])).cohort_total === 0, 'C (người nhận) không vào cohort của báo cáo')
}

// ════════════════════════════════════════════════════════════════════════════
section('CHIP DƯỢC SĨ "Có đơn xác thực" (PM E1–E3 r1 P1) — keyset 21 / 41, không lặp / mất, counts ≤ 50, phạm vi, chuyển giao')
{
  db = await L.freshDb(PGlite)
  const rows = [
    ...Array.from({ length: 41 }, (_, i) => row(`MA-${String(i).padStart(2, '0')}`, S1, EA, '1')),
    ...Array.from({ length: 15 }, (_, i) => row(`MN-${String(i).padStart(2, '0')}`, S1, EA, '1')),
    ...Array.from({ length: 21 }, (_, i) => row(`MB-${String(i).padStart(2, '0')}`, S1, EB, '1')),
    ...Array.from({ length: 3 }, (_, i) => row(`MC-${i}`, S2, EC, '1')),
  ]
  await finalize(db, await stage(db, rows, { period: P }), U.mkt, todayVN)
  const lo = (await one(db, `SELECT public.care__utc_us(max(created_at)) AS u FROM public.care_tasks`)).u
  const plusUs = (iso, us) => {
    const [head, frac] = iso.slice(0, -1).split('.')
    const v = BigInt(Date.parse(head + 'Z')) * 1000n + BigInt(frac) + BigInt(us)
    return new Date(Number(v / 1000n)).toISOString().replace(/\.(\d{3})Z$/, (_, d) => `.${d}${String(v % 1000n).padStart(3, '0')}Z`)
  }
  // A: khách i mới nhất theo i tăng ⇒ thứ tự latest DESC = MA-00…MA-40; MA-19 / MA-20 CÙNG mốc (hoà ở đúng biên trang 20);
  // MA-05 có 2 đơn (latest = đơn muộn hơn). B: 21 khách. C (store 2): 3 khách. MN-*: task của A không có đơn.
  const pad = (i) => String(i).padStart(2, '0')
  const orders = [
    ...Array.from({ length: 41 }, (_, i) => ord(`DHC-MA${i}`, `MA-${pad(i)}`, plusUs(lo, 1000 - (i === 20 ? 19 : i)))),
    ord('DHC-MA5-OLD', 'MA-05', plusUs(lo, 10)),
    ...Array.from({ length: 21 }, (_, i) => ord(`DHC-MB${i}`, `MB-${pad(i)}`, plusUs(lo, 500 - i))),
    ...Array.from({ length: 3 }, (_, i) => ord(`DHC-MC${i}`, `MC-${i}`, plusUs(lo, 200 + i))),
  ]
  const r = await fullRun(db, 'regular', 'apply', null, orders)
  ok(r.complete?.status === 'complete' && r.chunks.reduce((n, c) => n + c.links_inserted, 0) === 66, 'lượt thường gắn 66 đơn cho 41 + 21 + 3 khách', S(r.complete ?? r.open))
  const asJ = (who, sql, p) => as(db, who, () => j(db, sql, p))
  const walk = async (who) => {
    const pages = []
    let last = null
    for (let k = 0; k < 10; k++) {
      const pg = await asJ(who, `SELECT public.care_my_order_tasks(NULL, $1::timestamptz, $2::uuid, 20) r`, [last?.latest_completed_at ?? null, last?.task_id ?? null])
      pages.push(pg.rows)
      if (!pg.has_more) break
      last = pg.rows.at(-1)
    }
    return pages
  }
  const idsOf = async (prefix) => (await db.query(`SELECT t.id FROM public.care_tasks t JOIN public.care_customers c ON c.id = t.customer_id
                                                    WHERE c.external_id LIKE $1 ORDER BY t.id`, [prefix + '%'])).rows.map((x) => x.id)
  const idsMA = await idsOf('MA-'), idsMN = await idsOf('MN-'), idsMB = await idsOf('MB-')
  const sorted = (xs) => [...xs].sort((a, b) => (a.latest_completed_at !== b.latest_completed_at
    ? (a.latest_completed_at < b.latest_completed_at ? 1 : -1) : a.task_id < b.task_id ? 1 : -1))
  const pA = await walk(U.A)
  const flatA = pA.flat()
  ok(S(pA.map((x) => x.length)) === '[20,20,1]', '41 task: trang 20 / 20 / 1 (keyset theo dòng cuối của trang trước)', S(pA.map((x) => x.length)))
  ok(new Set(flatA.map((x) => x.task_id)).size === 41 && S(flatA.map((x) => x.task_id).sort()) === S([...idsMA].sort()), '41 task: không lặp, không mất, đúng tập task có đơn của A')
  ok(S(flatA) === S(sorted(flatA)) && flatA[19].latest_completed_at === flatA[20].latest_completed_at, 'thứ tự (latest DESC, task_id DESC) liên tục qua biên trang; mốc hoà đúng ở dòng 20 / 21')
  const a05 = flatA.find((x) => x.orders_count === 2)
  ok(flatA.filter((x) => x.orders_count === 2).length === 1 && a05.latest_completed_at === plusUs(lo, 995), 'task 2 đơn: orders_count 2, latest = đơn muộn hơn', S(a05))
  ok((await asJ(U.A, `SELECT public.care_my_order_summary() r`, [])).tasks_with_orders === 41, 'số trên chip (summary) = tổng số dòng đi hết keyset = 41')
  const pB = await walk(U.B)
  ok(S(pB.map((x) => x.length)) === '[20,1]' && S(pB.flat().map((x) => x.task_id).sort()) === S([...idsMB].sort()), '21 task (B): trang 20 / 1, đúng tập của B')
  ok(!pB.flat().some((x) => idsMA.includes(x.task_id)) && !flatA.some((x) => idsMB.includes(x.task_id)), 'phạm vi: A không thấy task B và ngược lại (cùng store)')
  ok((await asJ(U.A, `SELECT public.care_my_order_tasks(NULL, NULL, NULL, 500) r`, [])).rows.length === 20, 'p_limit > 20 ⇒ vẫn 20 / trang')
  // Tìm trong nhóm (app: id khớp tên / SĐT của mình ∩ counts > 0, mỗi lần ≤ 50 id).
  const mine = [...idsMA, ...idsMN]
  const c1 = await asJ(U.A, `SELECT public.care_task_order_counts($1::uuid[]) r`, [mine.slice(0, 50)])
  const c2 = await asJ(U.A, `SELECT public.care_task_order_counts($1::uuid[]) r`, [mine.slice(50)])
  const hits = [...c1, ...c2].filter((x) => x.orders_count > 0)
  ok(c1.length === 50 && c2.length === 6 && hits.length === 41 && S(hits.map((x) => x.task_id).sort()) === S([...idsMA].sort()), '56 id của A theo 2 khối 50 + 6 ⇒ 41 có đơn, 15 không đơn')
  ok([...c1, ...c2].filter((x) => x.orders_count === 0).every((x) => x.latest_completed_at === null), 'task 0 đơn ⇒ latest_completed_at NULL')
  ok(S(await asJ(U.A, `SELECT public.care_task_order_counts($1::uuid[]) r`, [idsMB.slice(0, 50)])) === '[]', 'counts: A truyền id task của B ⇒ [] (vị từ READ)')
  ok((await asJ(U.C, `SELECT public.care_my_order_tasks() r`, [])).rows.length === 3, 'C (store 2) chỉ 3 task của mình')
  // Chuyển giao MA-00 (mới nhất) A → B: A còn 40, B 22; đi lại keyset vẫn không lặp / mất.
  const moved = flatA[0].task_id
  await L.transfer(db, todayVN, U.super, [moved], U.B)
  const pA2 = (await walk(U.A)).flat(), pB2 = (await walk(U.B)).flat()
  ok(pA2.length === 40 && new Set(pA2.map((x) => x.task_id)).size === 40 && !pA2.some((x) => x.task_id === moved)
    && pB2.length === 22 && pB2.some((x) => x.task_id === moved)
    && (await asJ(U.A, `SELECT public.care_my_order_summary() r`, [])).tasks_with_orders === 40, 'sau chuyển giao: A 40 / B 22, summary khớp')
}

// ════════════════════════════════════════════════════════════════════════════
section('ROLLBACK mức 1 / mức 2')
{
  db = await L.freshDb(PGlite)
  const b = await stage(db, [row('RB-1', S1, EA, '1'), row('RB-2', S1, EA, '1')], { period: P, isTest: true })
  await finalize(db, b, U.mkt, todayVN)
  const t1 = await taskOf(db, 'RB-1', P), t2 = await taskOf(db, 'RB-2', P)
  const lo = (await one(db, `SELECT public.care__utc_us(created_at + interval '1 microsecond') AS u FROM public.care_tasks WHERE id = $1`, [t1.id])).u
  await fullRun(db, 'regular', 'apply', null, [ord('RB-DHC', 'RB-1', lo)])
  await db.exec(L.ROLLBACK_116_L1)
  ok(await count(db, `SELECT count(*) FROM public.app_migrations WHERE version = '116'`) === 0, 'mức 1: bỏ app_migrations 116')
  const pv = (await one(db, `SELECT public.care__import_cancel_preview_at($1, $2, $3::date) AS r`, [b, U.mkt, todayVN])).r
  ok(pv.code === 'HAS_VERIFIED_ORDER', 'mức 1: gate 115 (không cần đồng bộ) nhưng assess vẫn chặn task có link', S(pv))
  await as(db, null, () => db.query(`DELETE FROM public.care_task_products WHERE task_id = $1`, [t2.id]), 'service_role')
  await as(db, null, () => db.query(`DELETE FROM public.care_assignment_events WHERE task_id = $1`, [t2.id]), 'service_role')
  await as(db, null, () => db.query(`DELETE FROM public.care_tasks WHERE id = $1 AND is_test`, [t2.id]), 'service_role')
  ok(await count(db, `SELECT count(*) FROM public.care_order_task_coverage WHERE task_id = $1`, [t2.id]) === 0, 'mức 1: service_role xoá lại được task is_test; trigger dọn coverage còn chạy')
  ok(await count(db, `SELECT count(*) FROM public.care_order_links`) === 1, 'mức 1: giữ link / bảng')
  await db.exec(L.MIGRATION_116)
  ok(await count(db, `SELECT count(*) FROM public.app_migrations WHERE version = '116'`) === 1, 'chạy lại 116 sau mức 1')
  await db.exec(L.ROLLBACK_116_L2)
  ok(await count(db, `SELECT count(*) FROM pg_class WHERE relname = 'care_order_links'`) === 0, 'mức 2: bỏ bảng E')
  const pv2 = (await one(db, `SELECT public.care__import_cancel_preview_at($1, $2, $3::date) AS r`, [b, U.mkt, todayVN])).r
  ok(pv2.status === 'ready', 'mức 2: assess về 115 (không còn rào đơn)', S(pv2))
}

console.log(`\n${pass} đạt · ${fail} lỗi`)
process.exit(fail ? 1 : 0)
