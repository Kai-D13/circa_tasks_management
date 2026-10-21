// Lõi race 2-transaction cho migration 115 (CRM-CSKH D1 — huỷ import), Q-168 (PM D1 r1): bốn cặp tranh chấp trực tiếp, HAI chiều thứ
// tự khoá — huỷ ‖ finalize, huỷ ‖ ghi lượt, huỷ ‖ chuyển giao — và hai lệnh huỷ cùng batch. Không phụ thuộc kết nối cụ thể:
// `exec(sql)` = MỘT connection + MỘT transaction ngầm (pg-meta trên prod: scripts/qa-race-115.mjs; Postgres thật local:
// planning/research/dev-tools/d1-115/realpg-race.mjs). "A giữ khoá" = một lệnh `…; SELECT pg_sleep(N)`; B gửi SONG SONG; bằng chứng
// chờ khoá lấy từ pg_stat_activity (wait_event_type = 'Lock'), không suy từ thời gian.
// Fixture: dữ liệu GIẢ is_test, ID khách `QA-R115-<run>-<kịch bản>-<n>`, batch `qa-r115.csv`; mỗi kịch bản tự dọn theo đúng ID của nó
// (FK order, is_test) + hậu kiểm 0. Không ghi care_orders, không gọi sync, lượt ghi proof=[] (không object GCS).
import crypto from 'node:crypto'

export const RACE_FILE_NAME = 'qa-r115.csv'
/** Thời gian (P1-A db-reviewer r1.1): huỷ có SET lock_timeout = '5s' (115 care__import_cancel_at) ⇒ B là lệnh huỷ phải chờ < 5 s.
 *  A giữ RACE_HOLD_S. B chỉ gửi khi pg_stat_activity đã thấy A ở pg_sleep (A khoá xong) và ≥ RACE_B_DELAY_MS sau khi gửi A ⇒ B chờ
 *  ≤ HOLD bất kể độ trễ mạng (db-reviewer r1.2 P2-4). Hỏi B chờ 'Lock' từ RACE_SNAP_MS sau khi gửi B, mỗi RACE_POLL_MS, tới khi A nhả. */
export const CANCEL_LOCK_TIMEOUT_S = 5
export const RACE_HOLD_S = 4
export const RACE_B_DELAY_MS = 1000
export const RACE_SNAP_MS = 300
export const RACE_POLL_MS = 150
/** Tối đa chờ thấy A ở pg_sleep (tính từ lúc gửi A). */
export const RACE_SEEN_MAX_MS = 3000
/** R5: A giữ lâu hơn lock_timeout của huỷ ⇒ huỷ phải lỗi 55P03 (app: RETRYABLE), 0 thay đổi. */
export const RACE_LONG_HOLD_S = 8

// ── Nhận dạng rào commit của 115 — CÙNG điều kiện với VERIFY 115 V6 `barrier_ok` (planning/research/dev-tools/crm-115-verify.sql;
// selftest VERIFY ép 2 hằng dưới đây trùng chuỗi trong SQL). PM D1 r1.1 P1: rào là ENABLE ALWAYS ('A') — 'O' / 'D' / thiếu ⇒ từ chối.
export const BARRIER_TRIGGER_DEF = "CREATE TRIGGER care_import_batches_require_provenance BEFORE INSERT OR UPDATE ON public.care_import_batches FOR EACH ROW WHEN ((new.status = 'committed'::text)) EXECUTE FUNCTION care__require_commit_provenance()"
export const BARRIER_FN_MD5 = '28b77750661f674514595770f47e327d'
export const RACE_PREFLIGHT_BARRIER_SQL = `SELECT
    (SELECT count(*)::int FROM public.app_migrations WHERE version = '115') AS has_115,
    (SELECT g.tgenabled::text FROM pg_trigger g WHERE g.tgrelid = 'public.care_import_batches'::regclass
       AND g.tgname = 'care_import_batches_require_provenance' AND NOT g.tgisinternal) AS barrier_state,
    EXISTS (SELECT 1 FROM pg_trigger g JOIN pg_proc p ON p.oid = g.tgfoid
            WHERE g.tgrelid = 'public.care_import_batches'::regclass AND g.tgname = 'care_import_batches_require_provenance'
              AND NOT g.tgisinternal AND g.tgenabled = 'A' AND g.tgtype = 23
              AND replace(pg_get_triggerdef(g.oid), 'FUNCTION public.', 'FUNCTION ') = '${BARRIER_TRIGGER_DEF.split("'").join("''")}'
              AND p.oid = to_regprocedure('public.care__require_commit_provenance()')
              AND md5(replace(p.prosrc, chr(13), '')) = '${BARRIER_FN_MD5}') AS barrier_ok`
/** Kết quả RACE_PREFLIGHT_BARRIER_SQL ⇒ null (đạt) hoặc lý do từ chối (không ghi gì). */
export function judgeRaceBarrier(pre) {
  if (!pre || pre.has_115 !== 1) return 'migration 115 chưa áp — chạy 115 + VERIFY post trước'
  if (pre.barrier_state == null) return 'thiếu rào care_import_batches_require_provenance — chạy VERIFY post, báo Dev'
  if (pre.barrier_state !== 'A') return `rào đang ở trạng thái '${pre.barrier_state}' (115 đặt 'A' = ENABLE ALWAYS) — không chạy; báo Dev/PM, KHÔNG hạ / đổi trigger để chạy script`
  if (pre.barrier_ok !== true) return 'rào khác định nghĩa của 115 (tgtype / WHEN / hàm / thân) — chạy VERIFY post, báo Dev'
  return null
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])-01$/
const RUN = /^[0-9a-f]{8}$/
const CODE = /^[A-Za-z0-9_-]{2,40}$/
const EMAIL = /^[^\s'"\\$;]+@[^\s'"\\$;]+$/

/** Literal đã kiểm định dạng — không nội suy chuỗi tự do vào SQL. */
export function lit(v, re, what) {
  if (typeof v !== 'string' || !re.test(v)) throw new Error(`${what} sai định dạng`)
  return `'${v}'`
}
const jsonLit = (obj) => {
  const s = JSON.stringify(obj)
  if (s.includes('$qa$')) throw new Error('payload chứa $qa$')
  return `$qa$${s}$qa$::jsonb`
}
export const raceExternalIds = (runId, tag, n) => Array.from({ length: n }, (_, i) => `QA-R115-${runId}-${tag}-${i + 1}`)

/** Dọn một kịch bản theo đúng ID của nó (FK order, chỉ is_test) + hậu kiểm 0. Lệch phạm vi ⇒ ném lỗi TRƯỚC mọi DELETE. */
export async function cleanupRaceScope(exec, s) {
  const must = async (sql, what) => { const r = await exec(sql); if (!r.ok) throw new Error(`${what}: ${String(r.error).split('\n')[0].slice(0, 200)}`); return r.rows }
  const extArr = `ARRAY[${s.ext.map((e) => lit(e, /^QA-R115-[0-9a-f]{8}-[a-z0-9]+-\d$/, 'ext')).join(', ')}]::text[]`
  const bArr = `ARRAY[${s.batchIds.map((b) => lit(b, UUID, 'batch')).join(', ')}]::uuid[]`
  // Mọi dòng phải is_test và thuộc batch fixture (task batch_id NULL cũng tính là lệch) — lệch ⇒ dừng trước DELETE.
  const bad = (await must(`SELECT
      (SELECT count(*) FROM public.care_customers WHERE external_id = ANY (${extArr}) AND NOT is_test)
    + (SELECT count(*) FROM public.care_import_batches WHERE id = ANY (${bArr}) AND (NOT is_test OR file_name <> '${RACE_FILE_NAME}'))
    + (SELECT count(*) FROM public.care_tasks t JOIN public.care_customers c ON c.id = t.customer_id WHERE c.external_id = ANY (${extArr}) AND NOT t.is_test)
    + (SELECT count(*) FROM public.care_tasks t JOIN public.care_customers c ON c.id = t.customer_id WHERE c.external_id = ANY (${extArr}) AND NOT COALESCE(t.batch_id = ANY (${bArr}), false)) AS n`,
    `${s.tag}: kiểm phạm vi dọn`))[0].n
  if (Number(bad) !== 0) throw new Error(`${s.tag}: phạm vi dọn lẫn dòng không is_test / ngoài batch fixture (${bad}) — dừng, giữ marker`)
  const T = `(SELECT t.id FROM public.care_tasks t JOIN public.care_customers c ON c.id = t.customer_id WHERE c.external_id = ANY (${extArr}))`
  const C = `(SELECT id FROM public.care_customers WHERE external_id = ANY (${extArr}))`
  await must(`DELETE FROM public.care_order_attributions WHERE task_id IN ${T} AND is_test;
    DELETE FROM public.care_reconcile_queue WHERE customer_id IN ${C};
    DELETE FROM public.care_store_refusals WHERE customer_id IN ${C} AND is_test;
    DELETE FROM public.care_interactions WHERE task_id IN ${T} AND is_test;
    DELETE FROM public.care_assignment_events WHERE task_id IN ${T} AND is_test;
    DELETE FROM public.care_task_products WHERE task_id IN ${T};
    DELETE FROM public.care_tasks WHERE id IN ${T} AND is_test;
    DELETE FROM public.care_customers WHERE external_id = ANY (${extArr}) AND is_test;
    DELETE FROM public.care_import_staging WHERE batch_id = ANY (${bArr});
    DELETE FROM public.care_import_batches WHERE id = ANY (${bArr}) AND is_test AND file_name = '${RACE_FILE_NAME}';`, `${s.tag}: dọn`)
  const left = (await must(`SELECT (SELECT count(*) FROM public.care_customers WHERE external_id = ANY (${extArr}))
    + (SELECT count(*) FROM public.care_import_batches WHERE id = ANY (${bArr}))
    + (SELECT count(*) FROM public.care_import_staging WHERE batch_id = ANY (${bArr}))
    + (SELECT count(*) FROM public.care_orders WHERE customer_external_id = ANY (${extArr})) AS n`, `${s.tag}: hậu kiểm`))[0].n
  if (Number(left) !== 0) throw new Error(`${s.tag}: còn ${left} dòng sau dọn — giữ marker`)
}

function rowsFor(ext, storeCode, staffEmail, variant) {
  return ext.flatMap((e, i) => [1, 2].map((j) => ({
    customer_external_id: e, customer_name: `KH QA R115 ${i + 1}${variant === 'b' ? ' sửa' : ''}`, customer_phone: `0390${String(700000 + i)}`,
    target_store_code: storeCode, assignee_email: staffEmail, reason_type: 'chronic', reason_text: `QA R115 ${variant}`,
    product_id: `QAR${variant.toUpperCase()}${i + 1}P${j}`, product_name: `SP QA R115 ${variant} ${j}`, product_url: 'https://cdn-gcs.thuocsi.vn/qa-fixture/QAR115.png',
  })))
}

/**
 * Chạy toàn bộ kịch bản. ids = { actor (super), staff, staff2, storeCode, staffEmail, period, today }.
 * exec(sql) ⇒ { ok, rows, error, ms }. log(msg). assert(cond, label, detail). onScope(scope) gọi TRƯỚC lần ghi đầu của mỗi kịch bản
 * (CLI ghi marker để dọn tay nếu process chết). Trả { scopes } — mọi scope đã dọn hoặc ném lỗi.
 */
export async function runRace115({ exec, ids, runId = crypto.randomBytes(4).toString('hex'), holdS = RACE_HOLD_S, log = console.log, assert, onScope = () => {}, sleep }) {
  if (!RUN.test(runId)) throw new Error('runId sai định dạng')
  if (!(holdS <= CANCEL_LOCK_TIMEOUT_S - 1) || RACE_SNAP_MS / 1000 >= holdS - RACE_B_DELAY_MS / 1000) {
    throw new Error('holdS vượt biên: B (huỷ) gửi khi A đã giữ khoá nên chờ ≤ holdS — phải < lock_timeout 5 s với dư ≥ 1 s, và hỏi B khi A còn giữ')
  }
  const A = { actor: lit(ids.actor, UUID, 'actor'), staff: lit(ids.staff, UUID, 'staff'), staff2: lit(ids.staff2, UUID, 'staff2') }
  const period = lit(ids.period, PERIOD, 'period'), today = lit(ids.today, /^\d{4}-\d{2}-\d{2}$/, 'today')
  lit(ids.storeCode, CODE, 'store code'); lit(ids.staffEmail, EMAIL, 'staff email')
  const must = async (sql, what) => { const r = await exec(sql); if (!r.ok) throw new Error(`${what}: ${String(r.error).split('\n')[0].slice(0, 200)}`); return r.rows }
  const asUser = (uid, sql) => `SELECT set_config('request.jwt.claim.sub', ${uid}, true); ${sql}`
  const settled = (p) => Promise.race([p.then(() => true, () => true), sleep(0).then(() => false)])

  async function fixture(tag) {
    const ext = raceExternalIds(runId, tag, 3)
    const b1 = crypto.randomUUID(), b2 = crypto.randomUUID()
    const scope = { tag, ext, batchIds: [b1, b2] }
    onScope(scope)
    const stageSql = (id, i, rows) => {
      const sha = crypto.createHash('sha256').update(`qa-r115:${runId}:${tag}:${i}`).digest('hex')
      return `INSERT INTO public.care_import_batches (id, period_month, file_name, file_sha256, row_count, created_by, is_test)
          VALUES (${lit(id, UUID, 'batch')}, ${period}, '${RACE_FILE_NAME}', '${sha}', ${rows.length}, ${A.actor}, true);
        INSERT INTO public.care_import_staging (batch_id, row_no, payload)
          SELECT ${lit(id, UUID, 'batch')}, (x->>'n')::int, x->'p' FROM jsonb_array_elements(${jsonLit(rows.map((p, k) => ({ n: k + 2, p })))}) x;`
    }
    await must(stageSql(b1, 0, rowsFor(ext, ids.storeCode, ids.staffEmail, 'a')), `${tag}: stage B1`)
    const f1 = (await must(`SELECT public.care__import_finalize_at(${lit(b1, UUID, 'b1')}, ${A.actor}, ${today}) AS r`, `${tag}: finalize B1`))[0].r
    if (f1?.status !== 'committed' || f1.kind !== 'initial') throw new Error(`${tag}: B1 finalize ${f1?.status}/${f1?.kind}`)
    await must(stageSql(b2, 1, rowsFor(ext, ids.storeCode, ids.staffEmail, 'b')), `${tag}: stage B2`)
    const meta = (await must(`SELECT b.commit_seq::text AS seq, (SELECT array_agg(t.id ORDER BY t.id) FROM public.care_tasks t WHERE t.batch_id = b.id) AS tasks
      FROM public.care_import_batches b WHERE b.id = ${lit(b1, UUID, 'b1')}`, `${tag}: đọc B1`))[0]
    const tasks = typeof meta.tasks === 'string' ? meta.tasks.replace(/[{}]/g, '').split(',') : meta.tasks
    return { ...scope, b1, b2, seq1: meta.seq, t1: tasks[0] }
  }

  const cleanup = (s) => cleanupRaceScope(exec, s)

  // Lệnh mang nhãn `/* qa-r115:<run>:<tag>:<A|B> */` ở ĐẦU câu (nằm trong 1 kB đầu — track_activity_query_size) + thời gian chạy phía
  // server (giây) ⇒ phân biệt lỗi do thời gian / mạng với lỗi logic.
  const ACT = (tag, who) => `SELECT wait_event_type, wait_event, round(extract(epoch FROM now() - query_start)::numeric, 1) AS run_s
    FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND query LIKE '%qa-r115:${runId}:${tag}:${who} */%' AND query NOT ILIKE '%pg_stat_activity%'`
  // Hỏi lặp tới khi thấy dòng thoả `pick`, quá hạn hoặc lệnh đã xong ⇒ { row, last }. Mỗi lần hỏi là 1 request (độ trễ mạng thật).
  async function watch(tag, who, pick, untilMs, done) {
    let last = null
    for (;;) {
      const r = await exec(ACT(tag, who))
      last = r.ok ? r.rows[0] ?? last : last
      const row = r.ok ? r.rows.find(pick) : undefined
      if (row) return { row, last: row }
      if (Date.now() >= untilMs || (await done())) return { row: null, last }
      await sleep(RACE_POLL_MS)
    }
  }
  const state = async (s) => (await must(`SELECT
      (SELECT status FROM public.care_import_batches WHERE id = ${lit(s.b1, UUID, 'b1')}) AS b1,
      (SELECT status FROM public.care_import_batches WHERE id = ${lit(s.b2, UUID, 'b2')}) AS b2,
      (SELECT kind FROM public.care_import_batches WHERE id = ${lit(s.b2, UUID, 'b2')}) AS b2kind,
      (SELECT count(*)::int FROM public.care_tasks WHERE batch_id = ${lit(s.b1, UUID, 'b1')}) AS b1_tasks,
      (SELECT count(*)::int FROM public.care_interactions i JOIN public.care_tasks t ON t.id = i.task_id WHERE t.id = ${lit(s.t1, UUID, 't1')}) AS t1_ia,
      (SELECT count(*)::int FROM public.care_assignment_events WHERE task_id = ${lit(s.t1, UUID, 't1')} AND kind = 'transferred') AS t1_tr,
      (SELECT count(*)::int FROM public.care_tasks WHERE id = ${lit(s.t1, UUID, 't1')}) AS t1_exists`, `${s.tag}: đọc trạng thái`))[0]

  // A giữ khoá hold giây. B chỉ gửi khi DB đã thấy A ở pg_sleep (thứ tự do server xác nhận, không đoán theo độ trễ mạng) và ≥ RACE_B_DELAY_MS
  // sau khi gửi A; từ RACE_SNAP_MS sau khi gửi B hỏi tới khi thấy B chờ 'Lock' (trước lúc A nhả); đợi cả hai.
  async function pair(s, label, aSql, bSql, hold = holdS) {
    const t0 = Date.now()
    const pA = exec(`/* qa-r115:${runId}:${s.tag}:A */ ${aSql}; SELECT pg_sleep(${hold})`)
    const aw = await watch(s.tag, 'A', (r) => r.wait_event === 'PgSleep', t0 + RACE_SEEN_MAX_MS, () => settled(pA))
    assert(!!aw.row, `${label}: A ĐANG GIỮ khoá (pg_sleep) trước khi gửi B`, (await settled(pA))
      ? 'A kết thúc trước pg_sleep (xem lỗi A)' : `không thấy A ở pg_sleep sau ${RACE_SEEN_MAX_MS} ms — TIMING (request A tới server chậm?) ⇒ chạy lại, chưa phải lỗi logic`)
    const tSeen = Date.now()
    await sleep(Math.max(0, t0 + RACE_B_DELAY_MS - tSeen))
    const pB = exec(`/* qa-r115:${runId}:${s.tag}:B */ ${bSql}`)
    await sleep(RACE_SNAP_MS)
    const bw = await watch(s.tag, 'B', (r) => r.wait_event_type === 'Lock', tSeen + hold * 1000 - 500, () => settled(pB))
    assert(!!bw.row, `${label}: B ĐANG CHỜ KHOÁ khi A còn giữ`, bw.last
      ? `${bw.last.wait_event_type}/${bw.last.wait_event} sau ${bw.last.run_s} s` : 'không thấy B trước khi A nhả — TIMING (request B tới server chậm?) ⇒ chạy lại, chưa phải lỗi logic')
    assert(!(await settled(pB)), `${label}: B chưa kết thúc khi A còn giữ khoá`)
    const [a, b] = await Promise.all([pA, pB])
    assert(a.ok, `${label}: A thành công`, a.ok ? '' : String(a.error).slice(0, 160))
    return { a, b, after: await state(s) }
  }
  const cancelSql = (s, seq = s.seq1) => `SELECT public.care__import_cancel_at(${lit(s.b1, UUID, 'b1')}, ${A.actor}, ${lit(seq, /^[1-9]\d{0,18}$/, 'seq')}::bigint, ${today}) AS r`
  const finalizeB2 = (s) => `SELECT public.care__import_finalize_at(${lit(s.b2, UUID, 'b2')}, ${A.actor}, ${today}) AS r`
  const recordT1 = (s) => asUser(A.staff, `SELECT public.care__record_interaction_at(${today}, ${lit(s.t1, UUID, 't1')}, 'CALLBACK', 'QA R115 race', ${today}::date, '[]'::jsonb) AS r`)
  const transferT1 = (s) => asUser(A.actor, `SELECT public.care__transfer_tasks_at(${today}, ARRAY[${lit(s.t1, UUID, 't1')}]::uuid[], ${A.staff2}, 'QA R115 race') AS r`)
  const res = (x) => (x.ok ? x.rows?.[x.rows.length - 1]?.r ?? null : null)
  const errMsg = (x) => String(x.error ?? '').split('\n')[0].slice(0, 160)
  // 55P03 ở kịch bản không chủ ý giữ lâu ⇒ nhãn TIMING (chờ khoá vượt lock_timeout do mạng chậm) — chạy lại, chưa phải lỗi logic.
  const why = (x) => (x.ok ? JSON.stringify(res(x)) : /lock timeout/i.test(String(x.error)) ? `TIMING (55P03) — chạy lại: ${errMsg(x)}` : errMsg(x))

  const scenarios = [
    ['r1a', 'huỷ (A) ‖ finalize (B)', async (s) => {
      const { b, after } = await pair(s, 'R1a huỷ ‖ finalize', cancelSql(s), finalizeB2(s))
      assert(after.b1 === 'cancelled' && after.b1_tasks === 0, 'R1a: A huỷ xong B1 trước')
      assert(b.ok && res(b)?.status === 'committed' && after.b2 === 'committed' && after.b2kind === 'initial', 'R1a: B finalize SAU huỷ ⇒ B2 là initial mới (không bám dữ liệu đã huỷ)', JSON.stringify(after))
    }],
    ['r1b', 'finalize (A) ‖ huỷ (B)', async (s) => {
      const { b, after } = await pair(s, 'R1b finalize ‖ huỷ', finalizeB2(s), cancelSql(s))
      assert(res(b)?.status === 'rejected' && res(b)?.code === 'NOT_LATEST', 'R1b: sau khi B2 commit, huỷ B1 ⇒ NOT_LATEST', why(b))
      assert(after.b1 === 'committed' && after.b2 === 'committed' && after.b2kind === 'revision', 'R1b: B1 giữ nguyên, B2 revision', JSON.stringify(after))
    }],
    ['r2a', 'huỷ (A) ‖ ghi lượt (B)', async (s) => {
      const { b, after } = await pair(s, 'R2a huỷ ‖ ghi lượt', cancelSql(s), recordT1(s))
      assert(!b.ok && after.t1_exists === 0 && after.t1_ia === 0 && after.b1 === 'cancelled', 'R2a: task đã huỷ ⇒ ghi lượt lỗi, 0 lượt mồ côi', why(b))
    }],
    ['r2b', 'ghi lượt (A) ‖ huỷ (B)', async (s) => {
      const { b, after } = await pair(s, 'R2b ghi lượt ‖ huỷ', recordT1(s), cancelSql(s))
      assert(res(b)?.code === 'HAS_ACTIVITY' && after.b1 === 'committed' && after.t1_ia === 1 && after.b1_tasks === 3, 'R2b: lượt commit trước ⇒ huỷ HAS_ACTIVITY, 0 thay đổi', why(b))
    }],
    ['r3a', 'huỷ (A) ‖ chuyển giao (B)', async (s) => {
      const { b, after } = await pair(s, 'R3a huỷ ‖ chuyển giao', cancelSql(s), transferT1(s))
      const moved = res(b)?.transferred ?? 0
      assert(after.b1 === 'cancelled' && after.t1_exists === 0 && after.t1_tr === 0 && (!b.ok || moved === 0), 'R3a: task đã huỷ ⇒ chuyển giao không có hiệu lực (lỗi hoặc 0 task)', why(b))
    }],
    ['r3b', 'chuyển giao (A) ‖ huỷ (B)', async (s) => {
      const { b, after } = await pair(s, 'R3b chuyển giao ‖ huỷ', transferT1(s), cancelSql(s))
      assert(res(b)?.code === 'HAS_ACTIVITY' && after.b1 === 'committed' && after.t1_tr === 1, 'R3b: chuyển giao commit trước ⇒ huỷ HAS_ACTIVITY, 0 thay đổi', why(b))
    }],
    ['r4', 'huỷ (A) ‖ huỷ (B) cùng batch', async (s) => {
      const { b, after } = await pair(s, 'R4 huỷ ‖ huỷ', cancelSql(s), cancelSql(s))
      assert(res(b)?.code === 'NOT_COMMITTED' && after.b1 === 'cancelled' && after.b1_tasks === 0, 'R4: lệnh huỷ thứ hai ⇒ NOT_COMMITTED (huỷ đúng 1 lần)', why(b))
    }],
    ['r5', 'ghi lượt (A, giữ lâu) ‖ huỷ (B) — quá lock_timeout', async (s) => {
      const { b, after } = await pair(s, 'R5 giữ khoá lâu ‖ huỷ', recordT1(s), cancelSql(s), RACE_LONG_HOLD_S)
      assert(!b.ok && /lock timeout/i.test(String(b.error)), 'R5: huỷ chờ quá lock_timeout 5 s ⇒ lỗi 55P03 (app: RETRYABLE)', why(b))
      assert(after.b1 === 'committed' && after.b1_tasks === 3 && after.t1_ia === 1, 'R5: huỷ lỗi ⇒ 0 thay đổi (lượt của A vẫn commit)', JSON.stringify(after))
    }],
  ]
  const done = []
  for (const [tag, title, fn] of scenarios) {
    log(`\n${tag} — ${title}`)
    const s = await fixture(tag)
    try { await fn(s) } finally { await cleanup(s); done.push(tag) }
  }
  return { runId, scenarios: done }
}
