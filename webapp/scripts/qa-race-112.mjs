// QA RACE 2-connection cho migration 112 (audit 113.7 P1 concurrency) — thay
// thế psql khi không tiện mở 2 session tay. Chạy từ webapp/ SAU KHI đã áp 112.
// Cần env QA_DB_URL = Postgres connection string của Supabase self-hosted (lấy
// từ Coolify, KHÔNG commit/print). Dùng driver `pg` (devDependency) mở 2
// CONNECTION THẬT — PGlite (scripts/qa-kpi-order-bonus-112.mjs) là một session
// nên không tái lập được race này.
//
//   $env:QA_DB_URL='postgres://...'; node scripts/qa-race-112.mjs
//
// Invariant tài chính cần serialize: campaign có ngưỡng thưởng thêm ⇔ bật CẢ
// metric Offline lẫn Affiliate. Hai chiều tấn công:
//   1. A ghi ngưỡng (giữ tx mở) · B tắt Affiliate → B PHẢI CHỜ (≥1.5s) rồi
//      RAISE 'không tắt được' sau khi A commit — không được để cả hai commit.
//   2. A tắt Affiliate (giữ tx mở) · B ghi ngưỡng → trigger targets FOR UPDATE
//      khiến B PHẢI CHỜ rồi RAISE 'chỉ hợp lệ với chiến dịch Doanh số bật CẢ'.
// Fixture: campaign is_test PAUSED riêng (cron sync chỉ nhặt active) + 1 target
// trên OS store active đầu tiên; cleanup exact id (verify name prefix + is_test)
// trong finally + marker để dọn tay nếu crash.
import fs from 'node:fs'
import pg from 'pg'

const { Client } = pg
const DB_URL = process.env.QA_DB_URL
if (!DB_URL) {
  console.error("FAIL: thiếu env QA_DB_URL — lấy Postgres connection string của Supabase self-hosted từ Coolify rồi chạy: $env:QA_DB_URL='postgres://...'; node scripts/qa-race-112.mjs")
  process.exit(1)
}
const MARKER = '.qa-race-112.json'
if (fs.existsSync(MARKER)) {
  console.error('FAIL: marker', MARKER, 'đang tồn tại — lần chạy trước crash; dọn campaign QA-RACE-112-* (is_test) rồi xoá marker')
  process.exit(1)
}

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

const A = new Client({ connectionString: DB_URL })
const B = new Client({ connectionString: DB_URL })
let campaignId = null

try {
  await A.connect()
  await B.connect()

  const mig = await A.query("SELECT 1 FROM public.app_migrations WHERE version = '112'")
  if (mig.rowCount === 0) { console.error('FAIL: migration 112 chưa áp trên DB này'); process.exit(1) }

  const st = await A.query("SELECT id, code FROM public.stores WHERE store_type = 'os' AND is_active ORDER BY code LIMIT 1")
  if (st.rowCount === 0) { console.error('FAIL: không có OS store active làm fixture'); process.exit(1) }
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
  fs.writeFileSync(MARKER, JSON.stringify({ campaignId, name, createdAt: new Date().toISOString() }))
  console.log('fixture campaign:', campaignId, `(${name}, is_test, paused, offline+affiliate) — marker đã ghi`)

  const INSERT_THRESHOLD = `INSERT INTO public.kpi_campaign_store_targets
       (campaign_id, store_id, pos_code, kpi_target, minimum_order_target, order_bonus_per_staff)
     VALUES ($1, $2, $3, 1000, 10, 200000)`

  // ── Chiều 1: A ghi ngưỡng, B tắt Affiliate ─────────────────────────────
  await A.query('BEGIN')
  await A.query(INSERT_THRESHOLD, [campaignId, storeId, posCode])
  const t1 = Date.now()
  const pB1 = outcome(B.query('UPDATE public.kpi_campaigns SET metric_affiliate = false WHERE id = $1', [campaignId]))
  await sleep(1500)
  assert(!(await settled(pB1)), 'chiều 1: B (tắt Affiliate) BỊ CHẶN khi A còn giữ khoá dòng campaign ≥1.5s')
  await A.query('COMMIT')
  const r1 = await pB1
  assert(!r1.ok && /không tắt được/.test(r1.msg), 'chiều 1: sau A commit, B thấy ngưỡng vừa ghi → trigger RAISE', r1.msg)
  assert(Date.now() - t1 >= 1500, 'chiều 1: B đã chờ ≥1.5s (không chạy xuyên khoá)')
  const s1 = await A.query('SELECT metric_affiliate FROM public.kpi_campaigns WHERE id = $1', [campaignId])
  assert(s1.rows[0].metric_affiliate === true, 'chiều 1: metric_affiliate vẫn true — không có trạng thái mâu thuẫn')

  // Dọn target để chạy chiều ngược trên cùng fixture.
  await A.query('DELETE FROM public.kpi_campaign_store_targets WHERE campaign_id = $1', [campaignId])

  // ── Chiều 2: A tắt Affiliate, B ghi ngưỡng ─────────────────────────────
  await A.query('BEGIN')
  await A.query('UPDATE public.kpi_campaigns SET metric_affiliate = false WHERE id = $1', [campaignId])
  const t2 = Date.now()
  const pB2 = outcome(B.query(INSERT_THRESHOLD, [campaignId, storeId, posCode]))
  await sleep(1500)
  assert(!(await settled(pB2)), 'chiều 2: B (ghi ngưỡng) BỊ CHẶN bởi FOR UPDATE trong trigger khi A còn giữ khoá ≥1.5s')
  await A.query('COMMIT')
  const r2 = await pB2
  assert(!r2.ok && /chỉ hợp lệ với chiến dịch Doanh số bật CẢ/.test(r2.msg), 'chiều 2: sau A commit, B đọc cờ đã tắt → trigger RAISE', r2.msg)
  assert(Date.now() - t2 >= 1500, 'chiều 2: B đã chờ ≥1.5s')
  const s2 = await A.query('SELECT count(*)::int AS c FROM public.kpi_campaign_store_targets WHERE campaign_id = $1 AND minimum_order_target IS NOT NULL', [campaignId])
  assert(s2.rows[0].c === 0, 'chiều 2: không ngưỡng nào lọt vào campaign đã tắt Affiliate')
} catch (e) {
  console.error('FAIL (exception):', e.message)
  failed = true
  try { await A.query('ROLLBACK') } catch { /* không trong tx */ }
} finally {
  try {
    if (campaignId) {
      const del = await A.query(
        "DELETE FROM public.kpi_campaigns WHERE id = $1 AND is_test AND name LIKE 'QA-RACE-112-%' RETURNING id", [campaignId])
      console.log(del.rowCount === 1 ? 'cleanup: đã xoá fixture (cascade targets)' : 'cleanup: KHÔNG xoá được fixture — dọn tay ' + campaignId)
      if (del.rowCount === 1 && fs.existsSync(MARKER)) fs.unlinkSync(MARKER)
    }
  } catch (e) {
    console.error('cleanup lỗi — dọn tay theo marker', MARKER, e.message)
  }
  await A.end().catch(() => {})
  await B.end().catch(() => {})
}
console.log(failed ? 'RACE 112: FAIL' : 'RACE 112: ALL PASS')
process.exit(failed ? 1 : 0)
