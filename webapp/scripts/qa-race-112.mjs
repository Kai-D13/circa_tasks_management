// QA RACE 2-connection cho migration 112 (audit 113.7 P1 concurrency) — thay
// thế psql khi không tiện mở 2 session tay. Chạy từ webapp/ SAU KHI đã áp 112.
// Dùng driver `pg` (devDependency) mở 2 CONNECTION THẬT — PGlite
// (scripts/qa-kpi-order-bonus-112.mjs) là một session nên không tái lập được.
//
// SCRIPT NÀY GHI FIXTURE VÀO DB THẬT ⇒ safety gate như qa-kpi-customer-103
// (fail-fast exit 2 TRƯỚC khi tạo connection), biến PROCESS tạm, KHÔNG đặt vào
// .env.local:
//   $env:QA_RACE_112_ALLOWED='YES'
//   $env:QA_DB_URL='postgres://...'            # connection string Supabase self-hosted (Coolify), KHÔNG commit/print
//   $env:QA_EXPECTED_DB_HOST='<host trong QA_DB_URL>'   # gõ lại host — xác nhận đúng DB trước mọi thao tác ghi
//   node scripts/qa-race-112.mjs
//   Remove-Item Env:QA_RACE_112_ALLOWED, Env:QA_DB_URL, Env:QA_EXPECTED_DB_HOST
//
// Invariant tài chính cần serialize: campaign có ngưỡng thưởng thêm ⇔ bật CẢ
// metric Offline lẫn Affiliate. Hai chiều tấn công:
//   1. A ghi ngưỡng (giữ tx mở) · B tắt Affiliate → B PHẢI CHỜ (≥1.5s) rồi
//      RAISE 'không tắt được' sau khi A commit — không được để cả hai commit.
//   2. A tắt Affiliate (giữ tx mở) · B ghi ngưỡng → trigger targets FOR UPDATE
//      khiến B PHẢI CHỜ rồi RAISE 'chỉ hợp lệ với chiến dịch Doanh số bật CẢ'.
// Fixture: campaign is_test PAUSED riêng (cron sync chỉ nhặt active) + 1 target
// trên OS store active đầu tiên. Cleanup exact id (verify name prefix + is_test)
// + HẬU KIỂM campaign/target = 0 trong finally; cleanup lỗi/sót ⇒ exit 1 và
// GIỮ marker để dọn tay. statement_timeout 20s + connect timeout 10s + watchdog
// 90s: regression lock không bao giờ treo vô thời hạn.
import fs from 'node:fs'
import pg from 'pg'
import { finalVerdict, judgeCleanup, parseDbHost } from './lib-race-112.mjs'

// ── SAFETY GATES — fail-fast TRƯỚC khi tạo connection/ghi bất kỳ gì ──────────
const safetyGate = (ok, msg) => {
  if (!ok) { console.error('SAFETY GATE FAIL:', msg); process.exit(2) }
}
safetyGate(process.env.QA_RACE_112_ALLOWED === 'YES',
  'thiếu $env:QA_RACE_112_ALLOWED=YES (biến PROCESS tạm, KHÔNG đặt vào .env.local) — opt-in tường minh từng lần chạy vì script GHI fixture vào DB thật')
const DB_URL = process.env.QA_DB_URL
safetyGate(!!DB_URL,
  'thiếu $env:QA_DB_URL — Postgres connection string của Supabase self-hosted (lấy từ Coolify, KHÔNG commit/print)')
const dbHost = parseDbHost(DB_URL)
safetyGate(!!dbHost, 'QA_DB_URL không parse được thành URL Postgres (postgres://user:pass@host:port/db)')
const EXPECTED_HOST = process.env.QA_EXPECTED_DB_HOST
safetyGate(!!EXPECTED_HOST && EXPECTED_HOST === dbHost,
  'QA_EXPECTED_DB_HOST (' + (EXPECTED_HOST ?? 'THIẾU') + ') phải TRÙNG host trong QA_DB_URL (' + dbHost + ') — biến PROCESS tạm, xác nhận đúng DB trước mọi thao tác ghi')

const MARKER = '.qa-race-112.json'
safetyGate(!fs.existsSync(MARKER),
  'marker ' + MARKER + ' đang tồn tại — lần chạy trước chưa dọn xong; xoá campaign QA-RACE-112-* (is_test) theo id trong marker rồi xoá marker')

// Watchdog: connect treo / lock treo ngoài dự kiến ⇒ thoát ≠ 0 thay vì đứng mãi.
setTimeout(() => { console.error('FAIL: watchdog 90s — script treo (lock/connect); kiểm marker ' + MARKER); process.exit(1) }, 90_000).unref()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = false
function assert(ok, label, detail = '') {
  if (ok) console.log('PASS:', label)
  else { console.error('FAIL:', label, detail); failed = true }
}
// Promise đã settle chưa (không chờ): .then của promise đã settle chạy ở
// microtask, trước setTimeout(0).
const settled = (p) => Promise.race([p.then(() => true, () => true), sleep(0).then(() => false)])
const outcome = (p) => p.then(() => ({ ok: true, msg: '' }), (e) => ({ ok: false, msg: String(e.message) }))

const clientOpts = {
  connectionString: DB_URL,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 20_000,
  query_timeout: 25_000,
}
const A = new pg.Client(clientOpts)
const B = new pg.Client(clientOpts)
let campaignId = null
let aInTx = false

try {
  await A.connect()
  await B.connect()
  // Belt-and-braces: đặt tường minh trên session (như qa-race-098).
  await A.query("SET statement_timeout = '20s'")
  await B.query("SET statement_timeout = '20s'")

  const mig = await A.query("SELECT 1 FROM public.app_migrations WHERE version = '112'")
  if (mig.rowCount === 0) throw new Error('migration 112 chưa áp trên DB này — áp 112 + VERIFY trước')

  const st = await A.query("SELECT id, code FROM public.stores WHERE store_type = 'os' AND is_active ORDER BY code LIMIT 1")
  if (st.rowCount === 0) throw new Error('không có OS store active làm fixture')
  const storeId = st.rows[0].id
  const posCode = st.rows[0].code

  const name = `QA-RACE-112-${Date.now()}`
  const c = await A.query(
    `INSERT INTO public.kpi_campaigns
       (name, start_date, end_date, scope_type, metric_type, order_type,
        metric_offline, metric_affiliate, status, is_test)
     VALUES ($1, '2026-09-10', '2026-09-16', 'store', 'gmv', 'all', true, true, 'paused', true)
     RETURNING id`, [name])
  campaignId = c.rows[0].id
  fs.writeFileSync(MARKER, JSON.stringify({ campaignId, name, host: dbHost, createdAt: new Date().toISOString() }))
  console.log('fixture campaign:', campaignId, `(${name}, is_test, paused, offline+affiliate) — marker đã ghi`)

  const INSERT_THRESHOLD = `INSERT INTO public.kpi_campaign_store_targets
       (campaign_id, store_id, pos_code, kpi_target, minimum_order_target, order_bonus_per_staff)
     VALUES ($1, $2, $3, 1000, 10, 200000)`

  // ── Chiều 1: A ghi ngưỡng, B tắt Affiliate ─────────────────────────────
  await A.query('BEGIN'); aInTx = true
  await A.query(INSERT_THRESHOLD, [campaignId, storeId, posCode])
  const t1 = Date.now()
  const pB1 = outcome(B.query('UPDATE public.kpi_campaigns SET metric_affiliate = false WHERE id = $1', [campaignId]))
  await sleep(1500)
  assert(!(await settled(pB1)), 'chiều 1: B (tắt Affiliate) BỊ CHẶN khi A còn giữ khoá dòng campaign ≥1.5s')
  await A.query('COMMIT'); aInTx = false
  const r1 = await pB1
  assert(!r1.ok && /không tắt được/.test(r1.msg), 'chiều 1: sau A commit, B thấy ngưỡng vừa ghi → trigger RAISE', r1.msg)
  assert(Date.now() - t1 >= 1500, 'chiều 1: B đã chờ ≥1.5s (không chạy xuyên khoá)')
  const s1 = await A.query('SELECT metric_affiliate FROM public.kpi_campaigns WHERE id = $1', [campaignId])
  assert(s1.rows[0].metric_affiliate === true, 'chiều 1: metric_affiliate vẫn true — không có trạng thái mâu thuẫn')

  // Dọn target để chạy chiều ngược trên cùng fixture.
  await A.query('DELETE FROM public.kpi_campaign_store_targets WHERE campaign_id = $1', [campaignId])

  // ── Chiều 2: A tắt Affiliate, B ghi ngưỡng ─────────────────────────────
  await A.query('BEGIN'); aInTx = true
  await A.query('UPDATE public.kpi_campaigns SET metric_affiliate = false WHERE id = $1', [campaignId])
  const t2 = Date.now()
  const pB2 = outcome(B.query(INSERT_THRESHOLD, [campaignId, storeId, posCode]))
  await sleep(1500)
  assert(!(await settled(pB2)), 'chiều 2: B (ghi ngưỡng) BỊ CHẶN bởi FOR UPDATE trong trigger khi A còn giữ khoá ≥1.5s')
  await A.query('COMMIT'); aInTx = false
  const r2 = await pB2
  assert(!r2.ok && /chỉ hợp lệ với chiến dịch Doanh số bật CẢ/.test(r2.msg), 'chiều 2: sau A commit, B đọc cờ đã tắt → trigger RAISE', r2.msg)
  assert(Date.now() - t2 >= 1500, 'chiều 2: B đã chờ ≥1.5s')
  const s2 = await A.query('SELECT count(*)::int AS c FROM public.kpi_campaign_store_targets WHERE campaign_id = $1 AND minimum_order_target IS NOT NULL', [campaignId])
  assert(s2.rows[0].c === 0, 'chiều 2: không ngưỡng nào lọt vào campaign đã tắt Affiliate')
} catch (e) {
  console.error('FAIL (exception):', e.message)
  failed = true
}

// ── CLEANUP + HẬU KIỂM — không bao giờ ALL PASS khi fixture còn trên DB ─────
let cleanup = { ok: campaignId === null, reason: campaignId === null ? 'chưa tạo fixture' : 'chưa chạy' }
try {
  if (aInTx) { await A.query('ROLLBACK').catch(() => {}); aInTx = false }
  if (campaignId) {
    const del = await A.query(
      "DELETE FROM public.kpi_campaigns WHERE id = $1 AND is_test AND name LIKE 'QA-RACE-112-%' RETURNING id", [campaignId])
    const left = await A.query(
      `SELECT (SELECT count(*)::int FROM public.kpi_campaigns WHERE id = $1) AS campaigns,
              (SELECT count(*)::int FROM public.kpi_campaign_store_targets WHERE campaign_id = $1) AS targets`, [campaignId])
    cleanup = judgeCleanup({ deleted: del.rowCount, campaignsLeft: left.rows[0].campaigns, targetsLeft: left.rows[0].targets, error: null })
  }
} catch (e) {
  cleanup = judgeCleanup({ deleted: 0, campaignsLeft: -1, targetsLeft: -1, error: e.message })
}
if (cleanup.ok) {
  console.log('cleanup:', cleanup.reason)
  if (fs.existsSync(MARKER)) fs.unlinkSync(MARKER)
} else {
  console.error('FAIL cleanup:', cleanup.reason, '— GIỮ marker', MARKER, 'để dọn tay (campaign', campaignId, ')')
}
await A.end().catch(() => {})
await B.end().catch(() => {})

const verdict = finalVerdict({ testsFailed: failed, cleanupOk: cleanup.ok })
console.log(verdict)
process.exit(verdict === 'RACE 112: ALL PASS' ? 0 : 1)
