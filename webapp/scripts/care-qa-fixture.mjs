// CRM-CSKH B6-qa — vòng đời fixture QA `is_test` trên DB production (pha (a), SAU migration 114 + VERIFY, cờ
// Coolify OFF). CHỈ operator chạy, sau PM audit. Không tự chạy khi import (test gọi các hàm export).
//
//   cd webapp && set -a && . ./.env.local && set +a
//   E2E_CARE_WRITE_QA=YES E2E_EXPECTED_SUPABASE_HOST=<host> node scripts/care-qa-fixture.mjs up
//   E2E_CARE_WRITE_QA=YES E2E_EXPECTED_SUPABASE_HOST=<host> node scripts/care-qa-fixture.mjs verify
//   node scripts/care-qa-fixture.mjs status            (chỉ đọc)
//   E2E_CARE_WRITE_QA=YES E2E_EXPECTED_SUPABASE_HOST=<host> node scripts/care-qa-fixture.mjs down
//
// An toàn:
//   · cổng careWriteGate (e2e/writeQaGates.ts): cờ PROCESS tạm, host Supabase gõ lại, không nằm trong .env.local;
//   · marker `.qa-care.json` ghi TRƯỚC mọi lần ghi DB, chứa run ID + batch ID + ID khách giả ĐÃ ĐỊNH TRƯỚC ⇒ process
//     chết giữa chừng thì status/down vẫn tìm đúng dòng; `up` không chạy chồng khi marker còn;
//   · down chỉ xoá dòng thuộc phạm vi marker; bảng có `is_test` ⇒ thêm điều kiện is_test; bảng KHÔNG có is_test
//     (care_task_products, care_import_staging, care_reconcile_queue) ⇒ chỉ xoá theo cha đã kiểm là is_test; mọi cha
//     lệch is_test ⇒ dừng, giữ marker. Không DELETE toàn bảng, không dựa vào prefix. Hậu kiểm 0 rồi mới xoá marker;
//   · ghi lượt `proof=[]` (không object GCS); không ghi care_orders / không gọi sync;
//   · log chỉ số đếm / mã — không ID, SĐT, email.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CARE_QA_MARKER, careWriteGate, urlHost } from '../e2e/writeQaGates.ts'

export const FIXTURE_CUSTOMERS = 3
export const FIXTURE_FILE_NAME = 'qa-b6-fixture.xlsx'
const MARKER_VERSION = 1
const HERE = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_MARKER_PATH = path.resolve(HERE, '..', CARE_QA_MARKER)

export class FixtureError extends Error {
  constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.code = code }
}

/** Ngày hôm nay theo giờ VN (YYYY-MM-DD) và kỳ (YYYY-MM-01). */
export function vnToday(nowMs = Date.now()) {
  const d = new Date(nowMs + 7 * 3_600_000).toISOString().slice(0, 10)
  return { today: d, period: `${d.slice(0, 7)}-01` }
}

/** Trong 15 phút quanh 00:00 VN ngày 01 (cả hai phía) ⇒ preflight và finalize có thể khác kỳ. */
export function nearMonthBoundary(nowMs = Date.now(), windowMin = 15) {
  const vn = new Date(nowMs + 7 * 3_600_000)
  const start = Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), 1)
  const next = Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth() + 1, 1)
  const t = vn.getTime()
  return t - start < windowMin * 60_000 || next - t < windowMin * 60_000
}

/** ID khách giả định trước từ run ID — không trùng dữ liệu thật (prefix + run ngẫu nhiên). */
export function fixtureExternalIds(runId, n = FIXTURE_CUSTOMERS) {
  return Array.from({ length: n }, (_, i) => `QA-B6-${runId}-${i + 1}`)
}

/** Dòng N1 giả (đúng contract B2): SĐT giả hợp lệ, sản phẩm giả, URL ảnh tĩnh của bộ fixture. */
export function fixtureRows(externalIds, storeCode, staffEmail) {
  return externalIds.map((ext, i) => ({
    customer_external_id: ext, customer_name: `KH QA B6 ${i + 1}`, customer_phone: `039000${String(9000 + i).padStart(4, '0')}`,
    target_store_code: storeCode, assignee_email: staffEmail, reason_type: 'chronic', reason_text: 'QA B6 fixture',
    product_id: `QAB6${i + 1}`, product_name: `SP QA B6 ${i + 1}`, product_url: `https://cdn-gcs.thuocsi.vn/qa-fixture/QAB6${i + 1}.png`,
  }))
}

// ─── Marker ─────────────────────────────────────────────────────────────────
export function readMarker(p) {
  if (!fs.existsSync(p)) return null
  const m = JSON.parse(fs.readFileSync(p, 'utf8'))
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  const ids = (a) => a === undefined || (Array.isArray(a) && a.every((x) => UUID.test(x)))
  if (m?.v !== MARKER_VERSION || !/^[0-9a-f]{8}$/.test(m.runId ?? '') || !UUID.test(m.batchId ?? '') || !Array.isArray(m.externalIds)
      || !m.externalIds.every((x) => typeof x === 'string' && x.startsWith('QA-B6-')) || !ids(m.taskIds) || !ids(m.customerIds)) {
    throw new FixtureError('MARKER_INVALID', 'marker không đúng định dạng — không tự xử lý, báo Dev')
  }
  return m
}
function createMarkerExclusive(p, m) {
  try { fs.writeFileSync(p, JSON.stringify(m, null, 2), { flag: 'wx' }) } catch (e) {
    if (e?.code === 'EEXIST') throw new FixtureError('MARKER_EXISTS', 'marker vừa được tạo bởi lần chạy khác — dừng, không ghi DB')
    throw e
  }
}
function writeMarker(p, m) {
  const tmp = `${p}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2))
  fs.renameSync(tmp, p) // thay nguyên khối — không để marker ghi dở
}

// ─── Cổng ───────────────────────────────────────────────────────────────────
/** Cổng ghi: careWriteGate (cờ process + host + không nằm trong .env.local). `mode` quyết định yêu cầu marker. */
function assertMarkerHost(m, env) {
  const host = urlHost(env.NEXT_PUBLIC_SUPABASE_URL)
  if (m.host !== host) throw new FixtureError('HOST_MISMATCH', 'marker tạo trên host Supabase khác — dừng')
}
export function writeGate({ env, envFileText, markerExists, mode }) {
  const g = careWriteGate({ env, envFileText, markerExists: mode === 'up' ? markerExists : false })
  if (!g.ok) return g
  if (mode !== 'up' && !markerExists) return { ok: false, reason: `không có marker ${CARE_QA_MARKER} — không có fixture nào để ${mode}` }
  return g
}

// ─── Lệnh ───────────────────────────────────────────────────────────────────
const SCOPED_COUNTS = (s) => [
  ['care_import_batches', [['id', 'in', [s.batchId]]]],
  ['care_import_staging', [['batch_id', 'in', [s.batchId]]]],
  ['care_customers', [['id', 'in', s.customerIds]]],
  ['care_tasks', [['id', 'in', s.taskIds]]],
  ['care_task_products', [['task_id', 'in', s.taskIds]]],
  ['care_interactions', [['task_id', 'in', s.taskIds]]],
  ['care_assignment_events', [['task_id', 'in', s.taskIds]]],
  ['care_store_refusals', [['customer_id', 'in', s.customerIds]]],
  ['care_reconcile_queue', [['customer_id', 'in', s.customerIds]]],
  ['care_order_attributions', [['task_id', 'in', s.taskIds]]],
  // Không thể có (VIEW thật không chứa ID QA-B6-…, cờ sync OFF) — chỉ ĐẾM; ≠ 0 ⇒ NOT_CLEAN, báo Dev.
  ['care_orders', [['customer_external_id', 'in', s.externalIds]]],
]

/** Phạm vi dọn: từ marker + tra lại DB (bắt dòng tạo sau khi process chết, trước khi cập nhật marker). */
const sameSet = (a, b) => a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x))
/** DB ⊆ marker: mọi ID tìm thấy trong DB đều có trong marker (dùng khi down đã xoá một phần). */
const subsetOf = (db, marker) => db.every((x) => marker.includes(x))
const batchSha = (runId) => crypto.createHash('sha256').update(`qa-b6:${runId}`).digest('hex')

/**
 * Phạm vi dọn RÀNG CHẶT theo marker (PM audit B6-qa r1 P1-1) — fail-closed trước mọi DELETE:
 *  · externalIds = đúng ID suy ra từ runId; batch (nếu có) is_test + đúng tên file + đúng hash của runId;
 *  · khách = đúng các dòng có external_id trong marker, is_test; customerIds của marker (nếu có) TRÙNG tập đó;
 *  · task = task của batch; mỗi task thuộc khách trong tập; khách KHÔNG có task ở batch khác; taskIds của
 *    marker (nếu có) TRÙNG tập task của batch. Marker trỏ sang fixture/batch khác ⇒ SCOPE_MISMATCH.
 * Tra lại DB theo batch ID + external ID nên process chết trước khi marker có ID vẫn tìm đúng dòng.
 */
async function resolveScope(gw, m) {
  const mismatch = (why) => { throw new FixtureError('SCOPE_MISMATCH', `marker không khớp DB (${why}) — dừng TRƯỚC khi xoá, giữ marker, báo Dev/PM`) }
  if (!sameSet(m.externalIds, fixtureExternalIds(m.runId, m.externalIds.length))) mismatch('ID khách không suy ra từ runId')
  const batch = await gw.svc.select('care_import_batches', 'id, is_test, file_name, file_sha256', [['id', 'in', [m.batchId]]])
  if (batch.some((b) => b.is_test !== true)) throw new FixtureError('SCOPE_NOT_TEST', 'batch trong marker KHÔNG is_test — dừng, giữ marker, báo Dev/PM')
  if (batch.some((b) => b.file_name !== FIXTURE_FILE_NAME || b.file_sha256 !== batchSha(m.runId))) mismatch('batch không thuộc lần chạy này')
  const custRows = await gw.svc.select('care_customers', 'id, external_id, is_test', [['external_id', 'in', m.externalIds]])
  if (custRows.some((c) => c.is_test !== true)) throw new FixtureError('SCOPE_NOT_TEST', 'khách trong marker KHÔNG is_test — dừng, giữ marker, báo Dev/PM')
  const customerIds = custRows.map((c) => c.id)
  // Pha tearing_down (down đã bắt đầu xoá): DB chỉ còn TẬP CON của marker; mọi pha khác: phải TRÙNG.
  const match = m.phase === 'tearing_down' ? (marker, db) => subsetOf(db, marker) : sameSet
  if (m.customerIds && !match(m.customerIds, customerIds)) mismatch('customerIds ≠ khách theo ID giả')
  const byBatch = await gw.svc.select('care_tasks', 'id, customer_id, batch_id, is_test', [['batch_id', 'in', [m.batchId]]])
  const byCust = customerIds.length ? await gw.svc.select('care_tasks', 'id, customer_id, batch_id, is_test', [['customer_id', 'in', customerIds]]) : []
  if ([...byBatch, ...byCust].some((t) => t.is_test !== true)) throw new FixtureError('SCOPE_NOT_TEST', 'task trong phạm vi KHÔNG is_test — dừng, giữ marker, báo Dev/PM')
  if (byBatch.some((t) => !customerIds.includes(t.customer_id))) mismatch('task của batch thuộc khách ngoài marker')
  if (byCust.some((t) => t.batch_id !== m.batchId)) mismatch('khách fixture có task ở batch khác')
  const taskIds = byBatch.map((t) => t.id)
  if (m.taskIds && !match(m.taskIds, taskIds)) mismatch('taskIds ≠ task của batch')
  return { batchId: m.batchId, customerIds, taskIds, externalIds: m.externalIds }
}

/** Trước khi xoá (P2-3): không có dữ liệu/quan hệ ngoài phạm vi — dòng không is_test gắn với fixture, hay care_orders. */
async function assertNothingOutOfScope(gw, s) {
  const checks = [
    ['care_interactions', [['task_id', 'in', s.taskIds], ['is_test', 'eq', false]]],
    ['care_assignment_events', [['task_id', 'in', s.taskIds], ['is_test', 'eq', false]]],
    ['care_order_attributions', [['task_id', 'in', s.taskIds], ['is_test', 'eq', false]]],
    ['care_store_refusals', [['customer_id', 'in', s.customerIds], ['is_test', 'eq', false]]],
    ['care_orders', [['customer_external_id', 'in', s.externalIds]]],
  ]
  for (const [table, filters] of checks) {
    const n = filters.some(([, , v]) => Array.isArray(v) && v.length === 0) ? 0 : await gw.svc.count(table, filters)
    if (n !== 0) throw new FixtureError('OUT_OF_SCOPE', `${table}: ${n} dòng ngoài phạm vi fixture — dừng TRƯỚC khi xoá, giữ marker, báo Dev/PM`)
  }
}

async function countScope(gw, s) {
  const out = {}
  for (const [table, filters] of SCOPED_COUNTS(s)) {
    out[table] = filters.some(([, , v]) => v.length === 0) ? 0 : await gw.svc.count(table, filters)
  }
  return out
}

export async function cmdUp({ gw, env, envFileText, markerPath, nowMs = Date.now(), runId = crypto.randomBytes(4).toString('hex') }) {
  const g = writeGate({ env, envFileText, markerExists: fs.existsSync(markerPath), mode: 'up' })
  if (!g.ok) throw new FixtureError('GATE', g.reason)
  if ((await gw.svc.count('app_migrations', [['version', 'eq', '114']])) !== 1) throw new FixtureError('NO_114', 'migration 114 chưa chạy')
  // finalize luôn đóng MỌI task còn mở của kỳ trước (114 care__close_period_at, KHÔNG lọc is_test) ⇒ còn task
  // mở kỳ trước — thật HOẶC is_test của lượt QA khác — thì up sẽ đóng chúng ngoài phạm vi marker, down không hoàn
  // tác được ⇒ dừng trước khi ghi. (Vận hành: cờ OFF + cửa sổ operator ⇒ không có import cạnh tranh.)
  // Ngày theo DB (care_vn_today — đúng ngày finalize dùng), không theo đồng hồ máy chạy script.
  const dbTodayRaw = await gw.svc.rpc('care_vn_today', {})
  const dbToday = typeof dbTodayRaw === 'string' ? dbTodayRaw.slice(0, 10) : new Date(dbTodayRaw).toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dbToday)) throw new FixtureError('DB_DATE', 'không đọc được ngày từ DB')
  if (nearMonthBoundary(nowMs)) throw new FixtureError('MONTH_BOUNDARY', 'đang trong 15 phút quanh lúc giao tháng (giờ VN) — chạy lại sau')
  const curPeriod = `${dbToday.slice(0, 7)}-01`
  const openPrev = await gw.svc.count('care_tasks', [['status', 'eq', 'open'], ['period_month', 'lt', curPeriod]])
  if (openPrev !== 0) throw new FixtureError('OPEN_PREVIOUS', `còn ${openPrev} task (thật hoặc test) đang mở của kỳ trước — up sẽ đóng chúng; chờ đóng kỳ / dọn fixture cũ`)
  const staff = await gw.userByEmail(env.E2E_STAFF_EMAIL)
  const actor = await gw.userByEmail(env.E2E_SUPER_EMAIL)
  if (!staff || staff.role !== 'staff' || !staff.store_id) throw new FixtureError('STAFF_INVALID', 'E2E_STAFF_EMAIL không phải dược sĩ có store')
  if (!actor || actor.role !== 'admin') throw new FixtureError('ACTOR_INVALID', 'E2E_SUPER_EMAIL phải là admin super trong users')
  const [store] = await gw.svc.select('stores', 'code, store_type, is_active', [['id', 'eq', staff.store_id]])
  if (!store || store.store_type !== 'os' || !store.is_active) throw new FixtureError('STORE_INVALID', 'store của staff QA không phải OS đang hoạt động')

  const period = curPeriod
  const externalIds = fixtureExternalIds(runId)
  if ((await gw.svc.count('care_customers', [['external_id', 'in', externalIds]])) !== 0) throw new FixtureError('ID_CLASH', 'ID giả đã tồn tại')
  const batchId = crypto.randomUUID()
  const m = { v: MARKER_VERSION, runId, host: g.host, createdAt: new Date(nowMs).toISOString(), period, phase: 'reserved',
    batchId, actorId: actor.id, staffId: staff.id, storeId: staff.store_id, externalIds }
  createMarkerExclusive(markerPath, m) // TRƯỚC mọi lần ghi DB; độc quyền (wx)

  const rows = fixtureRows(externalIds, store.code, env.E2E_STAFF_EMAIL)
  await gw.svc.insert('care_import_batches', [{ id: batchId, period_month: period, file_name: FIXTURE_FILE_NAME,
    file_sha256: crypto.createHash('sha256').update(`qa-b6:${runId}`).digest('hex'), row_count: rows.length, created_by: actor.id, is_test: true }])
  await gw.svc.insert('care_import_staging', rows.map((payload, i) => ({ batch_id: batchId, row_no: i + 2, payload })))
  const fin = await gw.svc.rpc('care_import_finalize', { p_batch_id: batchId, p_actor: actor.id })
  if (fin?.status !== 'committed') throw new FixtureError('FINALIZE_REJECTED', `finalize trả ${fin?.status ?? 'không rõ'} (mã lỗi dòng: ${(fin?.errors ?? []).map((e) => e.code).join(',') || '-'})`)
  const tasks = await gw.svc.select('care_tasks', 'id, customer_id, is_test', [['batch_id', 'in', [batchId]]])
  const customers = await gw.svc.select('care_customers', 'id, external_id, is_test', [['external_id', 'in', externalIds]])
  if (tasks.length !== externalIds.length || tasks.some((t) => !t.is_test) || customers.some((c) => !c.is_test)) {
    throw new FixtureError('FIXTURE_MISMATCH', 'số task/khách hoặc cờ is_test không như kỳ vọng — chạy down')
  }
  const order = new Map(customers.map((c) => [c.id, externalIds.indexOf(c.external_id)]))
  tasks.sort((a, b) => order.get(a.customer_id) - order.get(b.customer_id))
  writeMarker(markerPath, { ...m, phase: 'ready', customerIds: customers.map((c) => c.id), taskIds: tasks.map((t) => t.id) })
  return { ok: true, period, customers: customers.length, tasks: tasks.length }
}

export async function cmdStatus({ gw, env, markerPath }) {
  const m = readMarker(markerPath)
  if (!m) return { ok: true, marker: false }
  assertMarkerHost(m, env)
  const s = await resolveScope(gw, m)
  return { ok: true, marker: true, phase: m.phase, period: m.period, counts: await countScope(gw, s) }
}

/** Kiểm RLS/RPC dưới phiên đăng nhập thật từng vai. Mỗi mục: PASS | FAIL | NOT_VERIFIED (+ lý do không ID). */
export async function cmdVerify({ gw, env, envFileText, markerPath }) {
  const g = writeGate({ env, envFileText, markerExists: fs.existsSync(markerPath), mode: 'verify' })
  if (!g.ok) throw new FixtureError('GATE', g.reason)
  const m = readMarker(markerPath)
  assertMarkerHost(m, env)
  if (m.phase !== 'ready') throw new FixtureError('PHASE', `marker ở pha "${m.phase}" — verify chỉ chạy một lần sau up thành công (down rồi up lại để chạy lại)`)
  const n = m.taskIds.length
  const [t1, t2, t3] = m.taskIds
  const todayRaw = await gw.svc.rpc('care_vn_today', {}) // ngày hẹn CALLBACK so với care_vn_today() của DB
  const today = typeof todayRaw === 'string' ? todayRaw.slice(0, 10) : new Date(todayRaw).toISOString().slice(0, 10)
  const results = []
  const check = async (name, fn) => {
    try { const r = await fn(); results.push({ check: name, ...r }) } catch (e) { results.push({ check: name, result: 'FAIL', reason: `lỗi ${e?.code ?? 'không rõ mã'}` }) }
  }
  const denied = async (sess, sql) => {
    try { await sess.select('care_customers', sql, [['id', 'in', m.customerIds]]); return { result: 'FAIL', reason: 'đọc được — kỳ vọng 42501' } } catch (e) {
      return e?.code === '42501' ? { result: 'PASS' } : { result: 'FAIL', reason: `lỗi ${e?.code ?? 'không rõ mã'} — kỳ vọng 42501` }
    }
  }
  writeMarker(markerPath, { ...m, phase: 'verifying' }) // ghi lượt/sự kiện thuộc phạm vi task ⇒ down vẫn bắt được
  const sessions = []
  const open = async (role) => { const x = await gw.as(role); if (x) sessions.push(x); return x }
  try {

  const staff = await open('staff')
  await check('staff: RLS thấy đúng task fixture của mình', async () => {
    const c = await staff.count('care_tasks', [['id', 'in', m.taskIds]])
    return c === n ? { result: 'PASS' } : { result: 'FAIL', reason: `thấy ${c}/${n}` }
  })
  await check('staff: SELECT external_id bị 42501 (Q-105)', () => denied(staff, 'external_id'))
  await check('staff: SELECT * care_customers bị 42501 (Q-105)', () => denied(staff, '*'))
  await check('staff: ghi lượt không kết thúc CALLBACK (proof=[])', async () => {
    const r = await staff.rpc('care_record_interaction', { p_task_id: t1, p_outcome: 'CALLBACK', p_note: 'QA B6 verify', p_next_action_date: today, p_proof: [] })
    return r?.status === 'open' ? { result: 'PASS' } : { result: 'FAIL', reason: `task ${r?.status ?? '?'} — kỳ vọng open` }
  })
  await check('staff: ghi lượt kết thúc NO_NEED (proof=[]) + hàng đợi đối soát', async () => {
    const r = await staff.rpc('care_record_interaction', { p_task_id: t2, p_outcome: 'NO_NEED', p_note: 'QA B6 verify', p_next_action_date: null, p_proof: [] })
    const q = await gw.svc.count('care_reconcile_queue', [['customer_id', 'in', [m.customerIds[1]]]])
    return r?.status === 'completed' && q === 1 ? { result: 'PASS' } : { result: 'FAIL', reason: `task ${r?.status ?? '?'}, queue ${q} — kỳ vọng completed, 1` }
  })

  const qlch = await open('qlch')
  await check('QLCH: 0 task CRM (Q-76/77)', async () => {
    const c = await qlch.count('care_tasks', [['id', 'in', m.taskIds]])
    return c === 0 ? { result: 'PASS' } : { result: 'FAIL', reason: `thấy ${c}` }
  })

  const sup = await open('super')
  await check('super: thấy toàn bộ task fixture', async () => {
    const c = await sup.count('care_tasks', [['id', 'in', m.taskIds]])
    return c === n ? { result: 'PASS' } : { result: 'FAIL', reason: `thấy ${c}/${n}` }
  })
  await check('super: SELECT external_id bị 42501 (Q-105)', () => denied(sup, 'external_id'))
  await check('super: care_report gồm test − không test = số task fixture', async () => {
    const sum = (rows) => rows.reduce((a, r) => a + (r.tasks_total ?? 0), 0)
    const withT = sum(await sup.rpc('care_report', { p_month: m.period, p_store_ids: [m.storeId], p_include_test: true }) ?? [])
    const without = sum(await sup.rpc('care_report', { p_month: m.period, p_store_ids: [m.storeId], p_include_test: false }) ?? [])
    return withT - without === n ? { result: 'PASS' } : { result: 'FAIL', reason: `chênh ${withT - without} — kỳ vọng ${n}` }
  })

  const sm = await open('sm')
  if (!sm) {
    results.push({ check: 'SM: RLS + chuyển giao', result: 'NOT_VERIFIED', reason: 'thiếu E2E_SM_EMAIL/PASSWORD' })
  } else {
    const inScope = await gw.smManagesStore(sm.userId, m.storeId)
    await check('SM: RLS theo vùng', async () => {
      const c = await sm.count('care_tasks', [['id', 'in', m.taskIds]])
      const want = inScope ? n : 0
      return c === want ? { result: 'PASS', reason: inScope ? 'store QA trong vùng SM' : 'store QA NGOÀI vùng SM (kỳ vọng 0)' } : { result: 'FAIL', reason: `thấy ${c}, kỳ vọng ${want}` }
    })
    const target = env.E2E_CARE_TRANSFER_TO_EMAIL ? await gw.userByEmail(env.E2E_CARE_TRANSFER_TO_EMAIL) : null
    if (!inScope || !target || target.role !== 'staff') {
      results.push({ check: 'SM: chuyển giao 1 task', result: 'NOT_VERIFIED', reason: !inScope ? 'store QA ngoài vùng SM' : 'cần E2E_CARE_TRANSFER_TO_EMAIL là dược sĩ trong vùng SM' })
    } else {
      await check('SM: chuyển giao 1 task có ghi chú', async () => {
        const r = await sm.rpc('care_transfer_tasks', { p_task_ids: [t3], p_to_user: target.id, p_note: 'QA B6 verify' })
        return r?.transferred === 1 ? { result: 'PASS' } : { result: 'FAIL', reason: `transferred ${r?.transferred ?? '?'}` }
      })
    }
  }
  } finally {
    for (const x of sessions) await x.close?.().catch(() => {}) // signOut: không để lại phiên của tài khoản E2E
  }
  writeMarker(markerPath, { ...m, phase: 'verified' })
  const failed = results.filter((r) => r.result === 'FAIL').length
  const notVerified = results.filter((r) => r.result === 'NOT_VERIFIED').length
  // ok = không có FAIL. NOT_VERIFIED KHÔNG phải PASS — báo riêng để PM quyết (vd. chuyển giao chưa kiểm trên prod).
  return { ok: failed === 0, failed, notVerified, results }
}

/** Dọn theo thứ tự phụ thuộc; chạy lại được sau lỗi một phần; hậu kiểm 0 rồi xoá marker. */
export async function cmdDown({ gw, env, envFileText, markerPath }) {
  const g = writeGate({ env, envFileText, markerExists: fs.existsSync(markerPath), mode: 'down' })
  if (!g.ok) throw new FixtureError('GATE', g.reason)
  const m = readMarker(markerPath)
  assertMarkerHost(m, env)
  const s = await resolveScope(gw, m)
  await assertNothingOutOfScope(gw, s)
  // Trước DELETE đầu tiên: chốt tập ID đã kiểm vào marker ⇒ chạy lại sau lỗi một phần so TẬP CON với đúng tập này.
  if (m.phase !== 'tearing_down') writeMarker(markerPath, { ...m, phase: 'tearing_down', customerIds: s.customerIds, taskIds: s.taskIds })
  const del = async (table, filters) => (filters.some(([, , v]) => v.length === 0) ? 0 : gw.svc.del(table, filters))
  const T = [['is_test', 'eq', true]]
  const deleted = {
    care_order_attributions: await del('care_order_attributions', [['task_id', 'in', s.taskIds], ...T]),
    care_reconcile_queue: await del('care_reconcile_queue', [['customer_id', 'in', s.customerIds]]), // không có is_test — cha đã kiểm
    care_store_refusals: await del('care_store_refusals', [['customer_id', 'in', s.customerIds], ...T]), // FK interaction_id → lượt
    care_interactions: await del('care_interactions', [['task_id', 'in', s.taskIds], ...T]),
    care_assignment_events: await del('care_assignment_events', [['task_id', 'in', s.taskIds], ...T]),
    care_task_products: await del('care_task_products', [['task_id', 'in', s.taskIds]]), // không có is_test — cha đã kiểm
    care_tasks: await del('care_tasks', [['id', 'in', s.taskIds], ...T]),
    care_customers: await del('care_customers', [['id', 'in', s.customerIds], ...T]),
    care_import_staging: await del('care_import_staging', [['batch_id', 'in', [s.batchId]]]), // không có is_test — batch đã kiểm
    care_import_batches: await del('care_import_batches', [['id', 'in', [s.batchId]], ...T]),
  }
  const remaining = await countScope(gw, s)
  const left = Object.values(remaining).reduce((a, b) => a + b, 0)
  if (left !== 0) throw new FixtureError('NOT_CLEAN', `còn ${left} dòng trong phạm vi — giữ marker, chạy lại down`)
  fs.rmSync(markerPath)
  return { ok: true, deleted, remaining: 0 }
}

// ─── Gateway Supabase (prod) ────────────────────────────────────────────────
function applyFilters(q, filters) {
  for (const [col, op, v] of filters) q = op === 'in' ? q.in(col, v) : op === 'lt' ? q.lt(col, v) : q.eq(col, v)
  return q
}
const raise = (error) => { const e = new Error(error.message); e.code = error.code; throw e }

export async function makeSupabaseGateway(env, createClientImpl) {
  const createClient = createClientImpl ?? (await import('@supabase/supabase-js')).createClient
  const url = env.NEXT_PUBLIC_SUPABASE_URL
  if (!url || !env.SUPABASE_SERVICE_ROLE_KEY || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY) throw new FixtureError('ENV', 'thiếu NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY')
  const admin = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  const ops = (client) => ({
    async select(table, cols, filters) { const { data, error } = await applyFilters(client.from(table).select(cols), filters); if (error) raise(error); return data },
    async count(table, filters) { const { count, error } = await applyFilters(client.from(table).select('*', { count: 'exact', head: true }), filters); if (error) raise(error); return count ?? 0 },
    async rpc(fn, args) { const { data, error } = await client.rpc(fn, args); if (error) raise(error); return data },
  })
  const svc = {
    ...ops(admin),
    async insert(table, rows) { const { error } = await admin.from(table).insert(rows); if (error) raise(error) },
    async del(table, filters) { const { count, error } = await applyFilters(admin.from(table).delete({ count: 'exact' }), filters); if (error) raise(error); return count ?? 0 },
  }
  const ROLE_ENV = { staff: 'STAFF', qlch: 'QLCH', super: 'SUPER', sm: 'SM' }
  return {
    svc,
    async userByEmail(email) {
      if (!email) return null
      if (email.includes('*')) throw new FixtureError('ENV', 'email có ký tự * — không hỗ trợ')
      // Không phân biệt hoa/thường (import N1 cũng vậy); escape ký tự đại diện LIKE để không khớp rộng.
      const { data, error } = await admin.from('users').select('id, role, store_id').ilike('email', email.replace(/[\\%_]/g, (c) => `\\${c}`)).maybeSingle()
      if (error) raise(error)
      return data
    },
    async smManagesStore(smId, storeId) {
      const { count, error } = await admin.from('sm_store_assignments').select('*', { count: 'exact', head: true }).eq('sm_user_id', smId).eq('store_id', storeId)
      if (error) raise(error)
      return (count ?? 0) > 0
    },
    async as(role) {
      const email = env[`E2E_${ROLE_ENV[role]}_EMAIL`], password = env[`E2E_${ROLE_ENV[role]}_PASSWORD`]
      if (!email || !password) { if (role === 'sm') return null; throw new FixtureError('ENV', `thiếu E2E_${ROLE_ENV[role]}_EMAIL/PASSWORD`) }
      const c = createClient(url, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } })
      const { data, error } = await c.auth.signInWithPassword({ email, password })
      if (error) throw new FixtureError('LOGIN', `đăng nhập vai ${role} lỗi`)
      return { ...ops(c), userId: data.user.id, close: async () => { await c.auth.signOut() } }
    },
  }
}

// ─── CLI ────────────────────────────────────────────────────────────────────
async function main() {
  const cmd = process.argv[2]
  if (!['up', 'verify', 'status', 'down'].includes(cmd)) {
    console.error('dùng: node scripts/care-qa-fixture.mjs up | verify | status | down'); process.exit(2)
  }
  const envPath = path.resolve(HERE, '..', '.env.local')
  const envFileText = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : null
  const gw = await makeSupabaseGateway(process.env)
  const ctx = { gw, env: process.env, envFileText, markerPath: DEFAULT_MARKER_PATH }
  try {
    const out = cmd === 'up' ? await cmdUp(ctx) : cmd === 'verify' ? await cmdVerify(ctx) : cmd === 'status' ? await cmdStatus(ctx) : await cmdDown(ctx)
    console.log(JSON.stringify(out, null, 2))
    process.exit(out.ok ? 0 : 1)
  } catch (e) {
    console.error(JSON.stringify({ ok: false, code: e?.code ?? 'UNKNOWN', message: e instanceof FixtureError ? e.message : 'lỗi không mong đợi — giữ nguyên marker, báo Dev' }))
    process.exit(1)
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main()

// urlHost dùng lại cho test (marker.host phải khớp host hiện tại khi down).
export { urlHost }
