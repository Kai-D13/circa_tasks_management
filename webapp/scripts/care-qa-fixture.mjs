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
//
// B6-qa-ui (PM audit 10/10 b1-pilot) — lượt QA BROWSER bằng bản sao giả của file N1 mẫu, marker v2 kind 'ui':
//   E2E_CARE_WRITE_QA=YES E2E_EXPECTED_SUPABASE_HOST=<host> node scripts/care-qa-fixture.mjs prepare <goc.xlsx> [ra.xlsx]
//   E2E_CARE_WRITE_QA=YES E2E_EXPECTED_SUPABASE_HOST=<host> node scripts/care-qa-fixture.mjs serve [cổng=3100]
//   node scripts/care-qa-fixture.mjs status            (chỉ đọc)
//   E2E_CARE_WRITE_QA=YES E2E_EXPECTED_SUPABASE_HOST=<host> node scripts/care-qa-fixture.mjs down
//   · prepare CHỈ ĐỌC DB: sinh file QA (ID/tên/SĐT giả, cùng 10 cột/số dòng/sản phẩm, store + dược sĩ QA) ngoài repo,
//     ghi marker (wx) gồm sha256 file, ID giả, batch ID định trước, tài khoản QA — TRƯỚC lần ghi DB đầu (import browser);
//   · serve chạy `next dev -H 127.0.0.1` với cờ CHỈ trong process (CARE_ENABLED/CARE_QA_UI, sync OFF); server tự đặt
//     is_test=true cho đúng file QA, khoá marker khi import (lib/care/qa/*);
//   · down dọn đúng batch/khách/task is_test của marker (kiểm hash/batch/ID giả/liên kết TRƯỚC khi xoá), chạy lại được.
//
// Q-121 (15/10) — QA TẢI LỚN 20.000 dòng (~8.000 khách) trên DB thật, cùng marker v2 / server QA / down:
//   E2E_CARE_WRITE_QA=YES E2E_EXPECTED_SUPABASE_HOST=<host> node scripts/care-qa-fixture.mjs prepare-load <ra.xlsx> [khách=8000] [dòng=20000]
//   E2E_CARE_WRITE_QA=YES E2E_EXPECTED_SUPABASE_HOST=<host> node scripts/care-qa-fixture.mjs serve [cổng=3100]   (terminal khác)
//   E2E_CARE_WRITE_QA=YES E2E_EXPECTED_SUPABASE_HOST=<host> node scripts/care-qa-fixture.mjs load <ra.xlsx> [http://localhost:3100]
//   node scripts/care-qa-fixture.mjs status   ·   (tắt server) … down
//   · prepare-load CHỈ ĐỌC DB: sinh file GIẢ hoàn toàn (không cần file gốc) — ID QA-UI-<run>-…, tên "KH QA …", SĐT dải
//     03900xxxxx, SKU QALD…, ảnh qa-fixture/, câu lý do mẫu; marker (wx) trước lần ghi đầu như prepare;
//   · load đăng nhập server QA LOCAL bằng tài khoản Marketing QA, preview ×2 (lượt đầu làm nóng) → commit → preview lại
//     (kỳ vọng 0 tạo mới) → commit lại (kỳ vọng bị chặn trước khi ghi). In ms từng pha (Server-Timing) + số đếm/mã;
//   · gateway chia bộ lọc `in` dài thành khối 100 và phân trang có đếm exact (PostgREST max-rows) ⇒ status/down đúng với
//     hàng nghìn dòng.

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

// ─── QA UI (B6-qa-ui) ───────────────────────────────────────────────────────
// Mirror lib/care/qa/uiGate.ts (server đọc CÙNG marker) — e2e/care-qa-ui.spec.ts ép khớp hai phía.
/** Trần khách giả trong marker (= CARE_QA_UI_MAX_CUSTOMERS). */
export const UI_MAX_CUSTOMERS = 10_000
/** Bản sao QA từ file mẫu (`prepare`) — lượt QA browser nhỏ. */
export const UI_COPY_MAX_CUSTOMERS = 200
/** Trần dòng của file N1 — trùng CARE_IMPORT_MAX_ROWS (lib/care/import/contract.ts, Q-121). */
export const CARE_IMPORT_MAX_ROWS = 20_000
const UI_PHASES = ['reserved', 'importing', 'imported', 'tearing_down']
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** Hợp đồng file N1 — trùng lib/care/import/contract.ts (spec ép khớp). */
export const CARE_IMPORT_SHEET = 'KhachHang'
export const CARE_IMPORT_HEADERS = ['customer_external_id', 'customer_name', 'customer_phone', 'target_store_code', 'assignee_email',
  'reason_type', 'reason_text', 'product_id', 'product_name', 'product_url']
/** reason_text của bản QA — câu mẫu cố định (bản gốc có thể chứa thông tin sức khoẻ của khách thật). */
export const UI_REASON_SAMPLES = [
  'QA — khách dùng thuốc định kỳ, sắp hết liều', 'QA — sản phẩm có chương trình trong tháng',
  'QA — nhắc mua lại theo đơn đã dùng', 'QA — tư vấn thêm sản phẩm hỗ trợ',
]

/** ID khách giả của lượt QA UI — suy ra từ runId. */
export function uiExternalIds(runId, n) {
  return Array.from({ length: n }, (_, i) => `QA-UI-${runId}-${String(i + 1).padStart(3, '0')}`)
}

export function validUiMarker(m) {
  const uuids = (a, min, max) => Array.isArray(a) && a.length >= min && a.length <= max && a.every((x) => typeof x === 'string' && UUID_RE.test(x)) && new Set(a).size === a.length
  if (!m || m.v !== 2 || m.kind !== 'ui' || !/^[0-9a-f]{8}$/.test(m.runId ?? '') || typeof m.host !== 'string' || !m.host || typeof m.createdAt !== 'string') return false
  if (!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(m.period ?? '') || !UI_PHASES.includes(m.phase) || !UUID_RE.test(m.batchId ?? '') || !/^[0-9a-f]{64}$/.test(m.fileSha256 ?? '')) return false
  const ext = m.externalIds
  if (!Array.isArray(ext) || ext.length < 1 || ext.length > UI_MAX_CUSTOMERS) return false
  const want = new Set(uiExternalIds(m.runId, ext.length))
  if (new Set(ext).size !== ext.length || !ext.every((x) => want.has(x))) return false
  const a = m.accounts
  if (!a || typeof a !== 'object' || ![a.super, a.marketing, a.sm].every((x) => typeof x === 'string' && UUID_RE.test(x)) || !uuids(a.staff, 1, 4)) return false
  const all = [a.super, a.marketing, a.sm, ...a.staff]
  if (new Set(all).size !== all.length || !uuids(m.storeIds, 1, 4)) return false
  if (m.importResult !== undefined && !['committed', 'rejected', 'duplicate', 'failed'].includes(m.importResult)) return false
  if (m.customerIds !== undefined && !uuids(m.customerIds, 0, UI_MAX_CUSTOMERS)) return false
  if (m.taskIds !== undefined && !uuids(m.taskIds, 0, UI_MAX_CUSTOMERS)) return false
  return true
}

/** Đọc sheet N1 (đúng một sheet KhachHang, đúng 10 header) thành dòng chuỗi đã trim. Không in giá trị ô. */
export function readCareSheet(XLSX, bytes) {
  let wb
  try { wb = XLSX.read(bytes, { type: 'buffer' }) } catch { throw new FixtureError('FILE_INVALID', 'không đọc được file Excel') }
  if (wb.SheetNames.length !== 1 || wb.SheetNames[0] !== CARE_IMPORT_SHEET) throw new FixtureError('FILE_INVALID', `cần đúng một sheet ${CARE_IMPORT_SHEET}`)
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[CARE_IMPORT_SHEET], { header: 1, raw: true, defval: '', blankrows: false })
  const [head = [], ...body] = aoa
  const cell = (v) => String(v ?? '').trim()
  if (CARE_IMPORT_HEADERS.some((h, i) => cell(head[i]) !== h) || head.slice(CARE_IMPORT_HEADERS.length).some((v) => cell(v) !== '')) {
    throw new FixtureError('FILE_INVALID', 'dòng tiêu đề không đúng 10 cột theo mẫu')
  }
  const rows = body.map((r) => Object.fromEntries(CARE_IMPORT_HEADERS.map((h, i) => [h, cell(r[i])])))
  if (rows.length === 0) throw new FixtureError('FILE_INVALID', 'file không có dòng dữ liệu')
  return rows
}

/** Ghi sheet N1 — mọi ô kiểu Text (như file mẫu của app) để Excel không đổi ID/SĐT. */
export function writeCareSheet(XLSX, rows) {
  const ws = XLSX.utils.aoa_to_sheet([CARE_IMPORT_HEADERS, ...rows.map((r) => CARE_IMPORT_HEADERS.map((h) => r[h]))])
  for (const addr of Object.keys(ws)) {
    if (addr.startsWith('!')) continue
    ws[addr].t = 's'
    ws[addr].z = '@'
  }
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, CARE_IMPORT_SHEET)
  // Nén deflate như Excel lưu — không nén thì 20.000 dòng (~12 MB) vượt trần byte 8 MiB của route (Q-121).
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true }))
}

/**
 * Bản sao QA: thay ID/tên/SĐT khách bằng giá trị giả (theo thứ tự khách xuất hiện), store + dược sĩ = tài khoản QA;
 * giữ số dòng, sản phẩm, reason_type. reason_text LUÔN thay bằng câu mẫu (security P2-3: nội dung gốc có thể là thông
 * tin sức khoẻ của khách thật).
 */
export function uiRows(srcRows, runId, storeCode, staffEmail) {
  const order = [...new Set(srcRows.map((r) => r.customer_external_id))]
  if (order.length === 0 || order.length > UI_COPY_MAX_CUSTOMERS || order.some((x) => x === '')) {
    throw new FixtureError('FILE_INVALID', `cần 1–${UI_COPY_MAX_CUSTOMERS} khách, mỗi dòng có customer_external_id`)
  }
  const externalIds = uiExternalIds(runId, order.length)
  const idx = new Map(order.map((x, i) => [x, i]))
  const rows = srcRows.map((r, n) => {
    const i = idx.get(r.customer_external_id)
    return {
      customer_external_id: externalIds[i], customer_name: `KH QA ${String(i + 1).padStart(3, '0')}`,
      customer_phone: `039001${String(i + 1).padStart(4, '0')}`, target_store_code: storeCode, assignee_email: staffEmail,
      reason_type: r.reason_type, reason_text: UI_REASON_SAMPLES[n % UI_REASON_SAMPLES.length],
      product_id: r.product_id, product_name: r.product_name, product_url: r.product_url,
    }
  })
  return { rows, externalIds }
}

// ─── QA tải lớn (Q-121) ─────────────────────────────────────────────────────
export const LOAD_DEFAULT_CUSTOMERS = 8_000
export const LOAD_DEFAULT_ROWS = 20_000
/** Mỗi khách 1–4 sản phẩm; SKU giả dùng chung trong danh mục 1.500 mã (nhiều khách cùng sản phẩm như file thật). */
export const LOAD_MAX_PRODUCTS = 4
export const LOAD_CATALOG = 1_500
const LOAD_REASON_TYPES = ['chronic', 'promotion', 'repurchase']

/** Tham số CLI prepare-load: thiếu ⇒ mặc định; chỉ nhận số nguyên thập phân, sai dạng ⇒ NaN (LOAD_SIZE). */
export const loadArg = (v, d) => (v === undefined ? d : /^\d+$/.test(v) ? Number(v) : NaN)
/** Trần byte request của server QA (CARE_IMPORT_MAX_BYTES như lib/care/config.ts; trống/sai ⇒ 8 MiB mặc định). */
export const loadMaxBytes = (env) => {
  const raw = String(env.CARE_IMPORT_MAX_BYTES ?? '').trim()
  return /^\d+$/.test(raw) ? Number(raw) : 8 * 1024 * 1024
}

/** Số sản phẩm của từng khách: đủ đúng `rows` dòng, rải đều theo vòng (khách đầu được thêm trước), mỗi khách 1–4. */
export function loadProductCounts(customers, rows) {
  if (!Number.isInteger(customers) || !Number.isInteger(rows) || customers < 1 || customers > UI_MAX_CUSTOMERS
      || rows < customers || rows > customers * LOAD_MAX_PRODUCTS || rows > CARE_IMPORT_MAX_ROWS) {
    throw new FixtureError('LOAD_SIZE', `cần 1–${UI_MAX_CUSTOMERS} khách, số dòng từ số khách tới min(${LOAD_MAX_PRODUCTS}×khách, ${CARE_IMPORT_MAX_ROWS})`)
  }
  const counts = new Array(customers).fill(1)
  let left = rows - customers
  for (let round = 1; left > 0 && round < LOAD_MAX_PRODUCTS; round++) {
    for (let i = 0; i < customers && left > 0; i++) { counts[i]++; left-- }
  }
  return counts
}

/** File tải GIẢ hoàn toàn (không đọc file gốc): mọi dòng của một khách liền nhau, SKU khác nhau trong cùng khách. */
export function loadRows(runId, customers, rows, storeCode, staffEmail) {
  const counts = loadProductCounts(customers, rows)
  const externalIds = uiExternalIds(runId, customers)
  const out = []
  externalIds.forEach((ext, i) => {
    const no = String(i + 1).padStart(5, '0')
    for (let p = 0; p < counts[i]; p++) {
      const sku = String(((i * 37 + p * 101) % LOAD_CATALOG) + 1).padStart(4, '0')
      out.push({
        customer_external_id: ext, customer_name: `KH QA ${no}`, customer_phone: `03900${no}`, target_store_code: storeCode,
        assignee_email: staffEmail, reason_type: LOAD_REASON_TYPES[(i + p) % LOAD_REASON_TYPES.length],
        reason_text: UI_REASON_SAMPLES[(i + p) % UI_REASON_SAMPLES.length], product_id: `QALD${sku}`,
        product_name: `SP QA tải ${sku} hộp 10 vỉ x 10 viên`, product_url: `https://cdn-gcs.thuocsi.vn/qa-fixture/QALD${sku}.png`,
      })
    }
  })
  return { rows: out, externalIds }
}

/** Khoá import của server QA: none | held (pid còn sống) | stale (process đã chết giữa chừng). */
export function lockState(lockPath, isPidAlive = pidAlive) {
  if (!fs.existsSync(lockPath)) return 'none'
  let pid = null
  try { pid = JSON.parse(fs.readFileSync(lockPath, 'utf8'))?.pid } catch { /* khoá hỏng = stale */ }
  return Number.isInteger(pid) && isPidAlive(pid) ? 'held' : 'stale'
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e?.code === 'EPERM' }
}

// ─── Marker ─────────────────────────────────────────────────────────────────
export function readMarker(p) {
  if (!fs.existsSync(p)) return null
  const m = JSON.parse(fs.readFileSync(p, 'utf8'))
  if (m?.v === 2) {
    if (!validUiMarker(m)) throw new FixtureError('MARKER_INVALID', 'marker QA UI không đúng định dạng — không tự xử lý, báo Dev')
    return m
  }
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
  if (m.v === 2) return resolveUiScope(gw, m)
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

/**
 * Phạm vi dọn của lượt QA UI (B6-qa-ui) — batch do SERVER QA import từ browser (id định trước, sha256 file QA):
 *  · ID giả = đúng tập suy ra từ runId (validUiMarker); batch (nếu có — staged/rejected/committed) is_test + đúng sha256;
 *  · khách = đúng external_id của marker, is_test; task = task của batch (đã có thể bị SM chuyển store/dược sĩ);
 *    mỗi task thuộc khách trong tập; khách không có task ở batch khác; sản phẩm ghi bởi batch chỉ gắn task trong tập.
 *  Bất kỳ dòng không is_test ⇒ SCOPE_NOT_TEST; lệch tập ⇒ SCOPE_MISMATCH — dừng TRƯỚC mọi DELETE, giữ marker.
 */
async function resolveUiScope(gw, m) {
  const mismatch = (why) => { throw new FixtureError('SCOPE_MISMATCH', `marker QA UI không khớp DB (${why}) — dừng TRƯỚC khi xoá, giữ marker, báo Dev/PM`) }
  const notTest = (what) => { throw new FixtureError('SCOPE_NOT_TEST', `${what} trong phạm vi marker KHÔNG is_test — dừng, giữ marker, báo Dev/PM`) }
  const batch = await gw.svc.select('care_import_batches', 'id, is_test, file_sha256', [['id', 'in', [m.batchId]]])
  if (batch.some((b) => b.is_test !== true)) notTest('batch')
  if (batch.some((b) => b.file_sha256 !== m.fileSha256)) mismatch('batch không phải file QA của marker')
  const custRows = await gw.svc.select('care_customers', 'id, external_id, is_test', [['external_id', 'in', m.externalIds]])
  if (custRows.some((c) => c.is_test !== true)) notTest('khách')
  const customerIds = custRows.map((c) => c.id)
  const match = m.phase === 'tearing_down' ? (marker, db) => subsetOf(db, marker) : sameSet
  if (m.customerIds && !match(m.customerIds, customerIds)) mismatch('customerIds ≠ khách theo ID giả')
  const byBatch = await gw.svc.select('care_tasks', 'id, customer_id, batch_id, is_test', [['batch_id', 'in', [m.batchId]]])
  const byCust = customerIds.length ? await gw.svc.select('care_tasks', 'id, customer_id, batch_id, is_test', [['customer_id', 'in', customerIds]]) : []
  if ([...byBatch, ...byCust].some((t) => t.is_test !== true)) notTest('task')
  if (byBatch.some((t) => !customerIds.includes(t.customer_id))) mismatch('task của batch thuộc khách ngoài marker')
  if (byCust.some((t) => t.batch_id !== m.batchId)) mismatch('khách QA có task ở batch khác')
  const taskIds = byBatch.map((t) => t.id)
  if (m.taskIds && !match(m.taskIds, taskIds)) mismatch('taskIds ≠ task của batch')
  const prods = await gw.svc.select('care_task_products', 'id, task_id', [['batch_id', 'in', [m.batchId]]]) // id ⇒ phân trang được (20.000 dòng)
  if (prods.some((p) => !taskIds.includes(p.task_id))) mismatch('sản phẩm của batch gắn task ngoài phạm vi')
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

/** Preflight chung trước lượt ghi QA (up / prepare): 114 đã chạy, không sát giờ giao tháng, không còn task mở kỳ trước. */
async function preflightPeriod(gw, nowMs) {
  if ((await gw.svc.count('app_migrations', [['version', 'eq', '114']])) !== 1) throw new FixtureError('NO_114', 'migration 114 chưa chạy')
  // finalize luôn đóng MỌI task còn mở của kỳ trước (114 care__close_period_at, KHÔNG lọc is_test) ⇒ còn task
  // mở kỳ trước — thật HOẶC is_test của lượt QA khác — thì import QA sẽ đóng chúng ngoài phạm vi marker, down không
  // hoàn tác được ⇒ dừng trước khi ghi. (Vận hành: cờ OFF + cửa sổ operator ⇒ không có import cạnh tranh.)
  // Ngày theo DB (care_vn_today — đúng ngày finalize dùng), không theo đồng hồ máy chạy script.
  const dbTodayRaw = await gw.svc.rpc('care_vn_today', {})
  const dbToday = typeof dbTodayRaw === 'string' ? dbTodayRaw.slice(0, 10) : new Date(dbTodayRaw).toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dbToday)) throw new FixtureError('DB_DATE', 'không đọc được ngày từ DB')
  if (nearMonthBoundary(nowMs)) throw new FixtureError('MONTH_BOUNDARY', 'đang trong 15 phút quanh lúc giao tháng (giờ VN) — chạy lại sau')
  const curPeriod = `${dbToday.slice(0, 7)}-01`
  const openPrev = await gw.svc.count('care_tasks', [['status', 'eq', 'open'], ['period_month', 'lt', curPeriod]])
  if (openPrev !== 0) throw new FixtureError('OPEN_PREVIOUS', `còn ${openPrev} task (thật hoặc test) đang mở của kỳ trước — import sẽ đóng chúng; chờ đóng kỳ / dọn fixture cũ`)
  return curPeriod
}

export async function cmdUp({ gw, env, envFileText, markerPath, nowMs = Date.now(), runId = crypto.randomBytes(4).toString('hex') }) {
  const g = writeGate({ env, envFileText, markerExists: fs.existsSync(markerPath), mode: 'up' })
  if (!g.ok) throw new FixtureError('GATE', g.reason)
  const curPeriod = await preflightPeriod(gw, nowMs)
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

/** Năm tài khoản QA browser (env E2E_*), kiểm vai/store/phạm vi SM. Lỗi chỉ nêu TÊN biến env, không email. */
async function resolveUiAccounts(gw, env) {
  const need = { super: 'E2E_SUPER_EMAIL', marketing: 'E2E_MKT_ADMIN_EMAIL', sm: 'E2E_SM_EMAIL', staff: 'E2E_STAFF_EMAIL', staff2: 'E2E_CARE_TRANSFER_TO_EMAIL' }
  const u = {}
  for (const [k, v] of Object.entries(need)) {
    u[k] = env[v] ? await gw.userByEmail(env[v]) : null
    if (!u[k]) throw new FixtureError('ACCOUNT_MISSING', `${v} thiếu hoặc không khớp user nào`)
  }
  if (u.super.role !== 'admin') throw new FixtureError('ACCOUNT_ROLE', 'E2E_SUPER_EMAIL phải là admin super')
  if (u.marketing.role !== 'admin' || !u.marketing.department_id
      || (await gw.svc.count('care_access', [['department_id', 'eq', u.marketing.department_id], ['can_import', 'eq', true]])) !== 1) {
    throw new FixtureError('ACCOUNT_ROLE', 'E2E_MKT_ADMIN_EMAIL phải là admin phòng có care_access.can_import')
  }
  if (u.sm.role !== 'sm') throw new FixtureError('ACCOUNT_ROLE', 'E2E_SM_EMAIL phải có role sm')
  const storeIds = []
  let storeCode = null
  for (const k of ['staff', 'staff2']) {
    if (u[k].role !== 'staff' || !u[k].store_id) throw new FixtureError('ACCOUNT_ROLE', `${need[k]} phải là dược sĩ có store`)
    const [st] = await gw.svc.select('stores', 'code, store_type, is_active', [['id', 'eq', u[k].store_id]])
    if (!st || st.store_type !== 'os' || !st.is_active) throw new FixtureError('STORE_INVALID', `store của ${need[k]} không phải OS đang hoạt động`)
    if (!(await gw.smManagesStore(u.sm.id, u[k].store_id))) throw new FixtureError('SM_SCOPE', `store của ${need[k]} không thuộc vùng của E2E_SM_EMAIL`)
    if (!storeIds.includes(u[k].store_id)) storeIds.push(u[k].store_id)
    if (k === 'staff') storeCode = st.code
  }
  const ids = [u.super.id, u.marketing.id, u.sm.id, u.staff.id, u.staff2.id]
  if (new Set(ids).size !== ids.length) throw new FixtureError('ACCOUNT_DUPLICATE', 'năm tài khoản QA phải khác nhau')
  return { accounts: { super: u.super.id, marketing: u.marketing.id, sm: u.sm.id, staff: [u.staff.id, u.staff2.id] }, storeIds, storeCode }
}

/** Cổng chung của prepare / prepare-load (CHỈ ĐỌC DB): cổng ghi, khoá, kỳ, không còn task test trong kỳ, tài khoản QA. */
async function uiPrepareGate({ gw, env, envFileText, markerPath, nowMs }) {
  const g = writeGate({ env, envFileText, markerExists: fs.existsSync(markerPath), mode: 'up' })
  if (!g.ok) throw new FixtureError('GATE', g.reason)
  if (fs.existsSync(`${markerPath}.lock`)) throw new FixtureError('GATE', 'còn khoá import QA của lượt trước — chạy status/down trước')
  const period = await preflightPeriod(gw, nowMs)
  // Kỳ này đã có task is_test (lượt QA khác chưa dọn) ⇒ finalize coi là revision của lượt kia ⇒ dừng.
  const testNow = await gw.svc.count('care_tasks', [['is_test', 'eq', true], ['period_month', 'eq', period]])
  if (testNow !== 0) throw new FixtureError('TEST_TASKS_EXIST', `kỳ này còn ${testNow} task thử nghiệm của lượt QA khác — dọn trước`)
  const { accounts, storeIds, storeCode } = await resolveUiAccounts(gw, env)
  return { host: g.host, period, accounts, storeIds, storeCode, staffEmail: String(env.E2E_STAFF_EMAIL).trim().toLowerCase() }
}

/** Ghi file QA + marker v2 (wx) TRƯỚC lần ghi DB đầu tiên (import trên server QA). Lỗi ghi file ⇒ bỏ marker (chưa ghi DB). */
async function uiPrepareWrite({ gw, markerPath, writeOut, XLSX, nowMs, runId, base, rows, externalIds, maxBytes = null }) {
  if ((await gw.svc.count('care_customers', [['external_id', 'in', externalIds]])) !== 0) throw new FixtureError('ID_CLASH', 'ID giả đã tồn tại')
  const bytes = writeCareSheet(XLSX, rows)
  // Chừa ~4 KB cho phần bọc multipart: file sát trần byte sẽ bị server trả 413 thay vì đo được tải.
  if (maxBytes !== null && bytes.byteLength + 4096 > maxBytes) {
    throw new FixtureError('FILE_TOO_LARGE', `file QA ${(bytes.byteLength / 1048576).toFixed(2)} MB vượt trần byte của request — giảm số dòng`)
  }
  const fileSha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  const m = { v: 2, kind: 'ui', runId, host: base.host, createdAt: new Date(nowMs).toISOString(), period: base.period, phase: 'reserved',
    batchId: crypto.randomUUID(), fileSha256, externalIds, accounts: base.accounts, storeIds: base.storeIds }
  if (!validUiMarker(m)) throw new FixtureError('MARKER_INVALID', 'marker sinh ra không hợp lệ — báo Dev')
  createMarkerExclusive(markerPath, m) // TRƯỚC lần ghi DB đầu tiên (import browser); độc quyền (wx)
  try {
    writeOut(bytes)
  } catch {
    fs.rmSync(markerPath, { force: true }) // chưa ghi DB nào ⇒ bỏ marker an toàn
    throw new FixtureError('OUT_WRITE', 'không ghi được file QA — kiểm đường dẫn ra')
  }
  return bytes
}

/**
 * B6-qa-ui — CHỈ ĐỌC DB. Sinh bản sao QA của file N1 mẫu (ID/tên/SĐT giả; store + dược sĩ = tài khoản QA thứ nhất;
 * giữ số dòng/sản phẩm/reason_type) và marker v2 (wx) ràng buộc host/kỳ/sha256 file/tập ID giả/batch định trước/
 * tài khoản QA. Lần ghi DB đầu tiên là import từ browser trên server QA (`serve`).
 */
export async function cmdPrepare({ gw, env, envFileText, markerPath, originalBytes, writeOut, XLSX,
  nowMs = Date.now(), runId = crypto.randomBytes(4).toString('hex') }) {
  const base = await uiPrepareGate({ gw, env, envFileText, markerPath, nowMs })
  const src = readCareSheet(XLSX, originalBytes)
  const { rows, externalIds } = uiRows(src, runId, base.storeCode, base.staffEmail)
  await uiPrepareWrite({ gw, markerPath, writeOut, XLSX, nowMs, runId, base, rows, externalIds })
  return { ok: true, period: base.period, rows: rows.length, customers: externalIds.length, products: rows.length, stores: 1, assignees: 1, reasonText: 'mẫu QA' }
}

/**
 * Q-121 — CHỈ ĐỌC DB. File tải GIẢ (mặc định 8.000 khách / 20.000 dòng) + marker v2 như prepare; lần ghi DB đầu tiên là
 * `load` (hoặc import browser) trên server QA. `maxBytes` = trần byte request của server (CARE_IMPORT_MAX_BYTES, mặc định 8 MiB).
 */
export async function cmdPrepareLoad({ gw, env, envFileText, markerPath, writeOut, XLSX, customers = LOAD_DEFAULT_CUSTOMERS, rows = LOAD_DEFAULT_ROWS,
  nowMs = Date.now(), runId = crypto.randomBytes(4).toString('hex') }) {
  loadProductCounts(customers, rows) // sai kích thước ⇒ dừng TRƯỚC mọi đọc DB
  const maxBytes = loadMaxBytes(env)
  const base = await uiPrepareGate({ gw, env, envFileText, markerPath, nowMs })
  const data = loadRows(runId, customers, rows, base.storeCode, base.staffEmail)
  const bytes = await uiPrepareWrite({ gw, markerPath, writeOut, XLSX, nowMs, runId, base, rows: data.rows, externalIds: data.externalIds, maxBytes })
  return { ok: true, profile: 'load', period: base.period, rows: data.rows.length, customers: data.externalIds.length, products: data.rows.length,
    fileMb: Number((bytes.byteLength / 1048576).toFixed(2)), stores: 1, assignees: 1, reasonText: 'mẫu QA' }
}

/**
 * Số đếm NGOÀI phạm vi marker (Q-121): so trước prepare-load và sau down ⇒ dữ liệu thật/staging không đổi. Dữ liệu thật
 * chỉ đổi nếu có import thật xen giữa — QA tải chạy ngoài giờ Marketing import.
 */
async function outsideCounts(gw) {
  return {
    real_batches: await gw.svc.count('care_import_batches', [['is_test', 'eq', false]]),
    real_customers: await gw.svc.count('care_customers', [['is_test', 'eq', false]]),
    real_tasks: await gw.svc.count('care_tasks', [['is_test', 'eq', false]]),
    test_tasks_all: await gw.svc.count('care_tasks', [['is_test', 'eq', true]]),
    staging_rows_all: await gw.svc.count('care_import_staging', []),
  }
}

export async function cmdStatus({ gw, env, markerPath }) {
  const m = readMarker(markerPath)
  if (!m) return { ok: true, marker: false, outside: await outsideCounts(gw) }
  assertMarkerHost(m, env)
  const s = await resolveScope(gw, m)
  const ui = m.v === 2 ? { kind: 'ui', importResult: m.importResult ?? null, lock: lockState(`${markerPath}.lock`) } : {}
  return { ok: true, marker: true, ...ui, phase: m.phase, period: m.period, counts: await countScope(gw, s), outside: await outsideCounts(gw) }
}

/** Kiểm RLS/RPC dưới phiên đăng nhập thật từng vai. Mỗi mục: PASS | FAIL | NOT_VERIFIED (+ lý do không ID). */
export async function cmdVerify({ gw, env, envFileText, markerPath }) {
  const g = writeGate({ env, envFileText, markerExists: fs.existsSync(markerPath), mode: 'verify' })
  if (!g.ok) throw new FixtureError('GATE', g.reason)
  const m = readMarker(markerPath)
  assertMarkerHost(m, env)
  if (m.v === 2) throw new FixtureError('PHASE', 'marker là lượt QA browser — verify chỉ dành cho fixture up; kiểm trên browser theo ma trận vai')
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
export async function cmdDown({ gw, env, envFileText, markerPath, isPidAlive }) {
  const g = writeGate({ env, envFileText, markerExists: fs.existsSync(markerPath), mode: 'down' })
  if (!g.ok) throw new FixtureError('GATE', g.reason)
  const m = readMarker(markerPath)
  assertMarkerHost(m, env)
  if (m.v !== 2) return downScoped(gw, m, markerPath)
  // QA UI: server QA còn giữ khoá import (process sống) ⇒ chờ xong/tắt server. Khoá của process đã chết = stale, bỏ.
  // down tự GIỮ khoá (wx) suốt lúc dọn ⇒ server không bắt đầu import chen giữa (security P2-1).
  const lockPath = `${markerPath}.lock`
  const st = lockState(lockPath, isPidAlive)
  if (st === 'held') throw new FixtureError('IMPORT_RUNNING', 'server QA đang import (khoá còn sống) — chờ xong hoặc tắt server rồi chạy lại down')
  if (st === 'stale') fs.rmSync(lockPath, { force: true })
  try {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), by: 'down' }), { flag: 'wx' })
  } catch {
    throw new FixtureError('IMPORT_RUNNING', 'server QA vừa giữ khoá import — chờ xong hoặc tắt server rồi chạy lại down')
  }
  try {
    return await downScoped(gw, m, markerPath)
  } finally {
    fs.rmSync(lockPath, { force: true })
  }
}

async function downScoped(gw, m, markerPath) {
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

/**
 * B6-qa-ui — lệnh khởi động dev server QA (không tự spawn trong hàm để test được): `next dev` bind 127.0.0.1, cờ CRM
 * CHỈ trong env process con, sync OFF. Server tự kiểm lại toàn bộ cổng (lib/care/qa/uiGate.ts) mỗi request.
 * B7-ui r2: `clean` = cache dev (`.next/dev`) xoá TRƯỚC khi chạy — QA 11/10 thấy cache Turbopack giữ CSS cũ
 * (thiếu luật mới của globals.css) dù mã nguồn đã đổi; lần đầu biên dịch chậm hơn nhưng UI đúng mã hiện tại.
 */
export function cmdServe({ env, envFileText, markerPath, port = 3100, appDir = path.resolve(HERE, '..') }) {
  const g = careWriteGate({ env, envFileText, markerExists: false })
  if (!g.ok) throw new FixtureError('GATE', g.reason)
  const m = readMarker(markerPath)
  if (!m || m.v !== 2) throw new FixtureError('GATE', 'chưa có marker QA UI — chạy prepare trước')
  assertMarkerHost(m, env)
  if (m.phase === 'tearing_down') throw new FixtureError('PHASE', 'marker đang dọn (tearing_down) — chạy down cho xong')
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new FixtureError('PORT', 'cổng không hợp lệ')
  const childEnv = { ...env, CARE_ENABLED: 'true', CARE_SYNC_ENABLED: 'false', CARE_QA_UI: 'YES', CARE_QA_UI_BIND: '127.0.0.1' }
  delete childEnv.NODE_ENV // next dev tự đặt development
  return {
    command: process.execPath,
    args: [path.join(appDir, 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev', '-H', '127.0.0.1', '-p', String(port)],
    cwd: appDir, env: childEnv, url: `http://localhost:${port}`, clean: path.join(appDir, '.next', 'dev'),
  }
}

// ─── QA tải (Q-121): chạy trên server QA local ─────────────────────────────
/** Header Server-Timing của route import (chế độ QA) ⇒ { parse, lookups, preview, stage, finalize: ms; rss, rss_peak: MB }. */
export function parseServerTiming(header) {
  const out = {}
  for (const part of String(header ?? '').split(',')) {
    const [name, ...params] = part.split(';').map((x) => x.trim())
    if (!name) continue
    for (const p of params) {
      const [k, v] = p.split('=')
      const n = Number(String(v ?? '').replace(/"/g, ''))
      if ((k === 'dur' || k === 'desc') && Number.isFinite(n)) out[name] = n
    }
  }
  return out
}

/**
 * Q-121 — lượt tải trên server QA LOCAL đã `serve`: preview ×2 (lượt 1 làm nóng biên dịch next dev) → commit → preview lại
 * (kỳ vọng 0 tạo mới, toàn bộ "không đổi") → commit lại (kỳ vọng 409 trước mọi ghi). `client.post(path, fields)` ⇒
 * { status, timing, body } (main: fetch + cookie phiên Marketing QA). Chỉ trả số đếm/mã/ms — không ID/tên/SĐT.
 */
export async function cmdLoad({ env, markerPath, fileBytes, client }) {
  const m = readMarker(markerPath)
  if (!m || m.v !== 2) throw new FixtureError('GATE', 'chưa có marker QA UI — chạy prepare-load trước')
  assertMarkerHost(m, env)
  const sha = crypto.createHash('sha256').update(fileBytes).digest('hex')
  if (sha !== m.fileSha256) throw new FixtureError('FILE_NOT_MARKED', 'file không phải file QA của marker')
  if (m.phase !== 'reserved') throw new FixtureError('PHASE', `marker đang ở pha ${m.phase} — lượt tải chỉ chạy một lần; status → down → prepare-load lại`)
  const file = { name: 'care-qa-load.xlsx', bytes: fileBytes }
  const step = async (p, fields) => { const t = performance.now(); const r = await client.post(p, fields); return { ...r, ms: Math.round(performance.now() - t) } }
  const brief = (r) => ({ status: r.status, ms: r.ms, server: parseServerTiming(r.timing), code: r.body?.code ?? null })
  const customers = m.externalIds.length
  const warm = await step('/api/care/import/preview', { file })
  const pre = await step('/api/care/import/preview', { file })
  const p = pre.body?.preview
  const out = {
    ok: false, rows: p?.rowCount ?? null, customers, fileMb: Number((fileBytes.byteLength / 1048576).toFixed(2)),
    preview_warmup: brief(warm),
    preview: { ...brief(pre), errorCount: p?.errorCount ?? null, created: p?.counts?.created ?? null, commitAllowed: pre.body?.qa?.commitAllowed ?? null, issues: pre.body?.qa?.issues ?? null },
  }
  if (pre.status !== 200 || pre.body?.qa?.commitAllowed !== true || p?.errorCount !== 0) return { ...out, stopped: 'PREVIEW_NOT_READY' }
  const com = await step('/api/care/import/commit', { file, sha256: sha, period: p.period })
  const r = com.body?.result ?? null
  out.commit = {
    ...brief(com),
    result: r && { status: r.status, kind: r.kind ?? null, rows: r.rows ?? null, customers: r.customers ?? null, created: r.created ?? null,
      updated: r.updated ?? null, unchanged: r.unchanged ?? null, absent_kept: r.absent_kept ?? null, error_count: r.error_count ?? null },
  }
  if (com.status !== 200 || r?.status !== 'committed') return { ...out, stopped: 'COMMIT_FAILED' }
  const after = await step('/api/care/import/preview', { file })
  const pa = after.body?.preview
  out.preview_after = { ...brief(after), created: pa?.counts?.created ?? null, updated: pa?.counts?.updated ?? null, unchanged: pa?.counts?.unchanged ?? null, issues: after.body?.qa?.issues ?? null }
  const again = await step('/api/care/import/commit', { file, sha256: sha, period: p.period })
  out.recommit = brief(again)
  out.ok = r.created === customers && r.rows === p.rowCount && pa?.counts?.created === 0 && pa?.counts?.unchanged === customers && again.status === 409
  return out
}

/** multipart giống trình duyệt, kèm Content-Length (route import bắt buộc — 411 nếu thiếu). */
export async function multipartBody(fields) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string') fd.append(k, v)
    else fd.append(k, new File([v.bytes], v.name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
  }
  const tmp = new Request('http://local/', { method: 'POST', body: fd })
  return { body: new Uint8Array(await tmp.arrayBuffer()), contentType: tmp.headers.get('content-type') }
}

// ─── Gateway Supabase (prod) ────────────────────────────────────────────────
function applyFilters(q, filters) {
  for (const [col, op, v] of filters) q = op === 'in' ? q.in(col, v) : op === 'lt' ? q.lt(col, v) : q.eq(col, v)
  return q
}
const raise = (error) => { const e = new Error(error.message); e.code = error.code; throw e }

/** Số giá trị tối đa của một bộ lọc `in` trong một request (URL PostgREST/Kong có giới hạn) — như ID_CHUNK của importRepo. */
export const GW_IN_CHUNK = 100
/** Trang đọc; PostgREST có thể trả ít hơn (max-rows) — vòng đọc dựa trên tổng exact, không dựa vào cỡ trang. */
export const GW_PAGE = 1000

/** Tách bộ lọc `in` dài thành nhiều bộ lọc ≤ size giá trị (không trùng) — kết quả các phần rời nhau, cộng/ghép lại được. */
export function splitInFilters(filters, size = GW_IN_CHUNK) {
  const i = filters.findIndex(([, op, v]) => op === 'in' && Array.isArray(v) && new Set(v).size > size)
  if (i < 0) return [filters]
  const [col, , vals] = filters[i]
  const uniq = [...new Set(vals)]
  const out = []
  for (let k = 0; k < uniq.length; k += size) {
    const f = filters.slice()
    f[i] = [col, 'in', uniq.slice(k, k + size)]
    out.push(...splitInFilters(f, size))
  }
  return out
}

export async function makeSupabaseGateway(env, createClientImpl) {
  const createClient = createClientImpl ?? (await import('@supabase/supabase-js')).createClient
  const url = env.NEXT_PUBLIC_SUPABASE_URL
  if (!url || !env.SUPABASE_SERVICE_ROLE_KEY || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY) throw new FixtureError('ENV', 'thiếu NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY')
  const admin = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  const pageErr = (table, why) => new FixtureError('PAGE', `${table}: ${why} — chạy lại`)
  const ops = (client) => ({
    // Q-121: `in` dài ⇒ nhiều request; mỗi phần đọc theo trang tới đủ tổng exact (PostgREST max-rows cắt im lặng).
    async select(table, cols, filters) {
      const hasId = cols.split(',').some((c) => c.trim() === 'id')
      const out = []
      for (const part of splitInFilters(filters)) {
        let total = null
        for (let from = 0; total === null || from < total;) {
          let q = applyFilters(client.from(table).select(cols, { count: 'exact' }), part)
          if (hasId) q = q.order('id')
          const { data, count, error } = await q.range(from, from + GW_PAGE - 1)
          if (error) raise(error)
          if (typeof count !== 'number') throw pageErr(table, 'không đọc được tổng số dòng')
          if (total !== null && count !== total) throw pageErr(table, 'số dòng đổi giữa các trang')
          total = count
          const rows = data ?? []
          if (from + rows.length < total && (rows.length === 0 || !hasId)) throw pageErr(table, rows.length ? 'cần cột id để phân trang' : 'thiếu trang')
          out.push(...rows)
          from += rows.length
        }
      }
      return out
    },
    async count(table, filters) {
      let n = 0
      for (const part of splitInFilters(filters)) {
        const { count, error } = await applyFilters(client.from(table).select('*', { count: 'exact', head: true }), part)
        if (error) raise(error)
        n += count ?? 0
      }
      return n
    },
    async rpc(fn, args) { const { data, error } = await client.rpc(fn, args); if (error) raise(error); return data },
  })
  const svc = {
    ...ops(admin),
    async insert(table, rows) { const { error } = await admin.from(table).insert(rows); if (error) raise(error) },
    async del(table, filters) {
      let n = 0
      for (const part of splitInFilters(filters)) {
        const { count, error } = await applyFilters(admin.from(table).delete({ count: 'exact' }), part)
        if (error) raise(error)
        n += count ?? 0
      }
      return n
    },
  }
  const ROLE_ENV = { staff: 'STAFF', qlch: 'QLCH', super: 'SUPER', sm: 'SM' }
  return {
    svc,
    async userByEmail(email) {
      if (!email) return null
      if (email.includes('*')) throw new FixtureError('ENV', 'email có ký tự * — không hỗ trợ')
      // Không phân biệt hoa/thường (import N1 cũng vậy); escape ký tự đại diện LIKE để không khớp rộng.
      const { data, error } = await admin.from('users').select('id, role, store_id, department_id').ilike('email', email.replace(/[\\%_]/g, (c) => `\\${c}`)).maybeSingle()
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
/** Đăng nhập server QA local bằng form /login (tài khoản Marketing QA) ⇒ header Cookie phiên Supabase. Không in cookie. */
export async function loginCookie(base, email, password) {
  if (!email || !password) throw new FixtureError('ENV', 'thiếu E2E_MKT_ADMIN_EMAIL / E2E_MKT_ADMIN_PASSWORD')
  const { chromium } = await import('@playwright/test')
  const browser = await chromium.launch()
  try {
    const ctx = await browser.newContext({ baseURL: base.origin })
    const page = await ctx.newPage()
    await page.goto('/login', { timeout: 180_000 }) // lần đầu next dev biên dịch chậm
    await page.fill('#email', email)
    await page.fill('#password', password)
    await page.getByRole('button', { name: /sign in/i }).click()
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 120_000 })
    const cookies = await ctx.cookies(base.origin)
    if (!cookies.some((c) => c.name.startsWith('sb-'))) throw new FixtureError('LOGIN', 'không có cookie phiên sau đăng nhập')
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
  } catch (e) {
    throw e instanceof FixtureError ? e : new FixtureError('LOGIN', 'đăng nhập server QA lỗi (kiểm server đang chạy, tài khoản Marketing QA)')
  } finally {
    await browser.close()
  }
}

async function main() {
  const [cmd, a1, a2, a3] = process.argv.slice(2)
  if (!['up', 'verify', 'status', 'down', 'prepare', 'serve', 'prepare-load', 'load'].includes(cmd)) {
    console.error('dùng: node scripts/care-qa-fixture.mjs up | verify | status | down | prepare <goc.xlsx> [ra.xlsx] | serve [cổng]'
      + ' | prepare-load <ra.xlsx> [khách=8000] [dòng=20000] | load <ra.xlsx> [http://localhost:3100]'); process.exit(2)
  }
  const envPath = path.resolve(HERE, '..', '.env.local')
  const envFileText = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : null
  const fail = (e) => {
    console.error(JSON.stringify({ ok: false, code: e?.code ?? 'UNKNOWN', message: e instanceof FixtureError ? e.message : 'lỗi không mong đợi — giữ nguyên marker, báo Dev' }))
    process.exit(1)
  }
  if (cmd === 'serve') {
    let s
    try { s = cmdServe({ env: process.env, envFileText, markerPath: DEFAULT_MARKER_PATH, port: a1 ? Number(a1) : 3100 }) } catch (e) { fail(e) }
    // Đổi tên TRƯỚC rồi mới xoá: thư mục đang bị next dev khác giữ (Windows: EBUSY/EPERM) ⇒ đổi tên lỗi nguyên
    // khối, không xoá dở cache của server kia ⇒ dừng (không chạy 2 dev server chung .next/dev).
    if (fs.existsSync(s.clean)) {
      const stale = `${s.clean}-old-${Date.now()}`
      try { fs.renameSync(s.clean, stale) } catch { fail(new FixtureError('DEV_CACHE_BUSY', 'không dọn được .next/dev — tắt MỌI next dev của webapp rồi chạy lại')) }
      try { fs.rmSync(stale, { recursive: true, force: true }) } catch { /* bản cũ đã tách khỏi đường dùng — xoá sau cũng được */ }
    }
    console.log(JSON.stringify({ ok: true, url: s.url, note: 'Ctrl+C để tắt; xong QA: tắt server rồi chạy down. Lần đầu mở trang chậm hơn (đã dọn cache dev).' }))
    const { spawn } = await import('node:child_process')
    spawn(s.command, s.args, { cwd: s.cwd, env: s.env, stdio: 'inherit' }).on('exit', (code) => process.exit(code ?? 0))
    return
  }
  const gw = await makeSupabaseGateway(process.env)
  const ctx = { gw, env: process.env, envFileText, markerPath: DEFAULT_MARKER_PATH }
  try {
    let out
    if (cmd === 'prepare') {
      if (!a1 || !fs.existsSync(a1)) throw new FixtureError('FILE_INVALID', 'thiếu đường dẫn file N1 gốc')
      const runId = crypto.randomBytes(4).toString('hex')
      const dest = path.resolve(a2 ?? path.join(path.dirname(path.resolve(a1)), `care-qa-ui-${runId}.xlsx`))
      // File QA (PII đã thay nhưng vẫn là dữ liệu vận hành mẫu) KHÔNG nằm trong repo.
      const repo = path.resolve(HERE, '..', '..')
      if (!path.relative(repo, dest).startsWith('..')) throw new FixtureError('OUT_IN_REPO', 'file QA phải nằm ngoài thư mục repo')
      const XLSX = await import('xlsx')
      out = await cmdPrepare({ ...ctx, runId, XLSX, originalBytes: fs.readFileSync(a1), writeOut: (b) => fs.writeFileSync(dest, b, { flag: 'wx' }) })
      out = { ...out, file: dest }
    } else if (cmd === 'prepare-load') {
      if (!a1) throw new FixtureError('FILE_INVALID', 'thiếu đường dẫn file QA ra (ngoài repo)')
      const dest = path.resolve(a1)
      const repo = path.resolve(HERE, '..', '..')
      if (!path.relative(repo, dest).startsWith('..')) throw new FixtureError('OUT_IN_REPO', 'file QA phải nằm ngoài thư mục repo')
      const XLSX = await import('xlsx')
      out = await cmdPrepareLoad({ ...ctx, XLSX, customers: loadArg(a2, LOAD_DEFAULT_CUSTOMERS), rows: loadArg(a3, LOAD_DEFAULT_ROWS),
        writeOut: (b) => fs.writeFileSync(dest, b, { flag: 'wx' }) })
      out = { ...out, file: dest }
    } else if (cmd === 'load') {
      if (!a1 || !fs.existsSync(a1)) throw new FixtureError('FILE_INVALID', 'thiếu đường dẫn file QA của prepare-load')
      const base = new URL(a2 ?? 'http://localhost:3100')
      // Chỉ server QA local; cookie Supabase (Secure) chỉ đi với localhost, không phải 127.0.0.1 (e2e/auth.setup.ts).
      if (base.protocol !== 'http:' || base.hostname !== 'localhost') throw new FixtureError('GATE', 'load chỉ chạy với server QA local http://localhost:<cổng>')
      const g = careWriteGate({ env: process.env, envFileText, markerExists: false })
      if (!g.ok) throw new FixtureError('GATE', g.reason)
      const cookie = await loginCookie(base, process.env.E2E_MKT_ADMIN_EMAIL, process.env.E2E_MKT_ADMIN_PASSWORD)
      const client = {
        async post(p, fields) {
          const { body, contentType } = await multipartBody(fields)
          const r = await fetch(new URL(p, base), { method: 'POST', body, headers: { 'content-type': contentType, cookie } })
          let j = null
          try { j = await r.json() } catch { /* không phải JSON ⇒ chỉ báo status */ }
          return { status: r.status, timing: r.headers.get('server-timing'), body: j }
        },
      }
      out = await cmdLoad({ env: process.env, markerPath: DEFAULT_MARKER_PATH, fileBytes: fs.readFileSync(a1), client })
    } else {
      out = cmd === 'up' ? await cmdUp(ctx) : cmd === 'verify' ? await cmdVerify(ctx) : cmd === 'status' ? await cmdStatus(ctx) : await cmdDown(ctx)
    }
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
