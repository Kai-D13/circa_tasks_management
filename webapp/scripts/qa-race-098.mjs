// QA RACE 2-connection cho migration 098 (audit gate concurrency) — thay thế
// psql khi không tiện mở 2 session tay. Chạy từ webapp/. Cần env QA_DB_URL =
// Postgres connection string của Supabase self-hosted (lấy từ Coolify, KHÔNG
// commit/print). Dùng driver `pg` (devDependency) mở 2 CONNECTION THẬT.
//
//   $env:QA_DB_URL='postgres://...'; node scripts/qa-race-098.mjs
//
// Chứng minh 2 chiều của row-lock 098 (fixture is_test paused riêng — KHÔNG
// bao giờ active nên cron sync không nhặt; vẫn nên giữ cron Disabled theo
// runbook):
//   1. Connection A (vai SYNC) BEGIN + SELECT ... FOR UPDATE giữ row →
//      Connection B gọi rpc_archive_kpi_campaign PHẢI CHỜ (block ≥1.5s).
//   2. A COMMIT → B hoàn tất archive ngay sau đó.
//   3. Chiều ngược: SAU archive, gọi rpc_replace_campaign_actuals → RAISE
//      'đã lưu trữ' (sync không ghi xuyên qua archive).
//   4. Cleanup exact id (verify name prefix + is_test) trong finally + marker
//      chung định dạng với qa-kpi-archive-098.mjs (crash → `cleanup` dọn được).
import fs from 'node:fs'
import pg from 'pg'

const { Client } = pg
const DB_URL = process.env.QA_DB_URL
if (!DB_URL) {
  console.error("FAIL: thiếu env QA_DB_URL — lấy Postgres connection string của Supabase self-hosted từ Coolify rồi chạy: $env:QA_DB_URL='postgres://...'; node scripts/qa-race-098.mjs")
  process.exit(1)
}
// Marker chung định dạng với qa-kpi-archive-098.mjs → lệnh `cleanup` của script
// đó dọn được nếu race test crash. projectUrl lấy từ .env.local như script chính.
const envf = {}
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m) envf[m[1]] = m[2]
}
const MARKER = '.qa-archive-098.json'
if (fs.existsSync(MARKER)) { console.error('FAIL: marker', MARKER, 'đang tồn tại — dọn fixture trước (qa-kpi-archive-098.mjs cleanup).'); process.exit(1) }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = false
function assert(ok, label, detail = '') {
  if (ok) console.log('PASS:', label)
  else { console.error('FAIL:', label, detail); failed = true }
}

const A = new Client({ connectionString: DB_URL })
const B = new Client({ connectionString: DB_URL })
let id = null
try {
  await A.connect()
  await B.connect()
  await A.query("SET statement_timeout = '20s'")
  await B.query("SET statement_timeout = '20s'")

  const name = `QA-ARCHIVE-098-race-${Date.now().toString(36)}`
  const ins = await A.query(
    `INSERT INTO public.kpi_campaigns
       (name, start_date, end_date, scope_type, metric_type, order_type,
        metric_offline, metric_affiliate, status, is_test)
     VALUES ($1, '2026-07-01', '2026-07-31', 'store', 'gmv', 'all', true, false, 'paused', true)
     RETURNING id`, [name])
  id = ins.rows[0].id
  fs.writeFileSync(MARKER, JSON.stringify({
    kind: 'qa-archive-098', schemaVersion: 1, campaignId: id, name,
    createdAt: new Date().toISOString(), projectUrl: envf.NEXT_PUBLIC_SUPABASE_URL ?? null,
  }))
  console.log('fixture campaign:', id, `(${name}, is_test, paused) — marker đã ghi`)

  // ── Chiều 1: SYNC giữ lock trước → ARCHIVE phải chờ ──
  await A.query('BEGIN')
  await A.query('SELECT id FROM public.kpi_campaigns WHERE id = $1 FOR UPDATE', [id]) // đúng lock sync/import dùng
  let bSettled = false
  const bPromise = B.query('SELECT public.rpc_archive_kpi_campaign($1, NULL)', [id])
    .then(() => { bSettled = true; return { ok: true } })
    .catch((e) => { bSettled = true; return { ok: false, msg: e.message } })
  await sleep(1500)
  assert(!bSettled, '1. archive BỊ CHẶN (chờ row lock) khi phiên SYNC đang giữ transaction')
  await A.query('COMMIT')
  const bRes = await bPromise
  assert(bRes.ok === true, '2. archive HOÀN TẤT ngay sau khi SYNC commit', bRes.ok ? '' : `(lỗi: ${bRes.msg})`)

  // ── Chiều 2: SAU archive, sync ghi actuals phải bị từ chối ──
  const s = await A.query('SELECT public.rpc_replace_campaign_actuals($1, $2::jsonb, $3::jsonb)', [id, '[]', '[]'])
    .then(() => ({ ok: true }))
    .catch((e) => ({ ok: false, msg: e.message }))
  assert(!s.ok && (s.msg ?? '').includes('đã lưu trữ'),
    '3. ghi actuals SAU archive → RAISE "đã lưu trữ" (sync không ghi xuyên archive)',
    s.ok ? '→ GHI ĐƯỢC!' : `(message: ${s.msg})`)
} catch (e) {
  console.error('FAIL: exception —', e.message)
  failed = true
} finally {
  try { await A.query('ROLLBACK').catch(() => {}) } catch { /* no open tx */ }
  if (id !== null) {
    // Cleanup contract như script chính: đối chiếu fixture + exact id + verify 0.
    try {
      const del = await A.query(
        "DELETE FROM public.kpi_campaigns WHERE id = $1 AND is_test AND name LIKE 'QA-ARCHIVE-098-%' RETURNING id", [id])
      const left = await A.query('SELECT count(*)::int AS n FROM public.kpi_campaigns WHERE id = $1', [id])
      if (left.rows[0].n === 0) {
        console.log(`PASS: cleanup (deleted=${del.rowCount}, verify=0)`)
        if (fs.existsSync(MARKER)) fs.unlinkSync(MARKER)
        console.log('marker đã gỡ (DB sạch)')
      } else {
        console.error('FAIL: cleanup — còn row, marker GIỮ NGUYÊN (dùng qa-kpi-archive-098.mjs cleanup)')
        failed = true
      }
    } catch (e) {
      console.error('FAIL: cleanup exception —', e.message, '→ marker GIỮ NGUYÊN')
      failed = true
    }
  }
  await A.end().catch(() => {})
  await B.end().catch(() => {})
}
console.log(failed ? '\n=== KẾT QUẢ: CÓ FAIL ===' : '\n=== KẾT QUẢ: RACE GATE 098 PASS (3/3) ===')
process.exitCode = failed ? 1 : 0
