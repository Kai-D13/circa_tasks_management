// QA RACE 2-transaction cho migration 112 — BIẾN THỂ qua pg-meta (113.11).
// Cùng mục tiêu và cùng chuẩn an toàn với scripts/qa-race-112.mjs, nhưng không
// cần connection string Postgres trực tiếp (QA_DB_URL): gửi SQL tới endpoint
// pg-meta của Supabase self-hosted `POST {NEXT_PUBLIC_SUPABASE_URL}/pg/query`
// bằng service role key (chạy với quyền supabase_admin).
//
// Mỗi request HTTP là MỘT kết nối và MỘT transaction ngầm (chuỗi nhiều lệnh
// trong một simple-query chạy trong một transaction, commit ở cuối chuỗi, lỗi
// thì rollback cả chuỗi). Vì vậy "A giữ khoá" = một request
// `INSERT/UPDATE ...; SELECT pg_sleep(N)`; B là request thứ hai gửi SONG SONG.
// KHÔNG dùng BEGIN/COMMIT tường minh: request lỗi giữa chừng sẽ để lại
// transaction treo trên kết nối của pg-meta.
//
// SCRIPT GHI FIXTURE VÀO DB THẬT ⇒ safety gate fail-fast exit 2 TRƯỚC mọi
// request mạng. Cờ là biến PROCESS tạm, KHÔNG đặt vào .env.local:
//   $env:QA_RACE_112_ALLOWED='YES'
//   $env:QA_EXPECTED_PROJECT_HOST='<host của NEXT_PUBLIC_SUPABASE_URL>'
//   node scripts/qa-race-112-pgmeta.mjs
//   Remove-Item Env:QA_RACE_112_ALLOWED, Env:QA_EXPECTED_PROJECT_HOST
// URL + service role key đọc từ .env.local (như các script QA khác).
//
// Invariant tài chính cần serialize: campaign có ngưỡng thưởng thêm ⇔ bật CẢ
// metric Offline lẫn Affiliate. Hai chiều tấn công:
//   1. A ghi ngưỡng (giữ khoá) · B tắt Affiliate → B PHẢI CHỜ khoá rồi RAISE
//      'không tắt được' sau khi A commit.
//   2. A tắt Affiliate (giữ khoá) · B ghi ngưỡng → FOR UPDATE trong trigger
//      targets khiến B PHẢI CHỜ rồi RAISE 'chỉ hợp lệ với chiến dịch Doanh số bật CẢ'.
// Bằng chứng "chờ khoá" lấy từ pg_stat_activity (wait_event_type = 'Lock')
// trong lúc A còn giữ — không suy từ thời gian.
// Fixture: campaign is_test PAUSED riêng (cron sync chỉ nhặt active) + 1 target
// trên OS store active đầu tiên. Marker ghi TRƯỚC khi tạo fixture; cleanup theo
// tên duy nhất + id, is_test, prefix; HẬU KIỂM campaign/target = 0; cleanup
// hỏng ⇒ exit 1 và GIỮ marker. Timeout: statement_timeout (SET LOCAL, chỉ sống
// trong đúng transaction của request) + timeout HTTP + watchdog 120s.
import fs from 'node:fs'
import { finalVerdict, judgeCleanup, parseDbHost } from './lib-race-112.mjs'

// ── SAFETY GATES — fail-fast TRƯỚC mọi request mạng/ghi bất kỳ gì ───────────
const safetyGate = (ok, msg) => {
  if (!ok) { console.error('SAFETY GATE FAIL:', msg); process.exit(2) }
}
safetyGate(process.env.QA_RACE_112_ALLOWED === 'YES',
  'thiếu $env:QA_RACE_112_ALLOWED=YES (biến PROCESS tạm, KHÔNG đặt vào .env.local) — opt-in tường minh từng lần chạy vì script GHI fixture vào DB thật')
safetyGate(fs.existsSync('.env.local'), 'không thấy .env.local — chạy từ thư mục webapp/')
const envFile = fs.readFileSync('.env.local', 'utf8')
safetyGate(!/^\s*(QA_RACE_112_ALLOWED|QA_EXPECTED_PROJECT_HOST)\s*=/m.test(envFile),
  'QA_RACE_112_ALLOWED / QA_EXPECTED_PROJECT_HOST đang nằm trong .env.local — phải là biến PROCESS tạm, xoá khỏi file')
const env = {}
for (const line of envFile.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m) env[m[1]] = m[2]
}
const BASE = env.NEXT_PUBLIC_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY
safetyGate(!!BASE && !!KEY, '.env.local thiếu NEXT_PUBLIC_SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY')
const projectHost = parseDbHost(BASE)
safetyGate(!!projectHost, 'NEXT_PUBLIC_SUPABASE_URL không parse được thành URL')
safetyGate(process.env.QA_EXPECTED_PROJECT_HOST === projectHost,
  'QA_EXPECTED_PROJECT_HOST (' + (process.env.QA_EXPECTED_PROJECT_HOST ?? 'THIẾU') + ') phải TRÙNG host của NEXT_PUBLIC_SUPABASE_URL (' + projectHost + ') — biến PROCESS tạm, xác nhận đúng project trước mọi thao tác ghi')

const MARKER = '.qa-race-112.json'   // dùng CHUNG với qa-race-112.mjs: fixture sót của script nào cũng chặn cả hai
safetyGate(!fs.existsSync(MARKER),
  'marker ' + MARKER + ' đang tồn tại — lần chạy trước chưa dọn xong; xoá campaign QA-RACE-112-* (is_test) theo tên/id trong marker rồi xoá marker')

// Watchdog: request treo ngoài dự kiến ⇒ thoát ≠ 0 thay vì đứng mãi.
setTimeout(() => { console.error('FAIL: watchdog 120s — script treo; kiểm marker ' + MARKER); process.exit(1) }, 120_000).unref()

const HOLD_S = 12                      // A giữ khoá bấy nhiêu giây
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Mọi request mở đầu bằng SET LOCAL statement_timeout: chỉ sống trong
// transaction ngầm của chính request (đã kiểm: request sau vẫn thấy mặc định).
// TUYỆT ĐỐI không SET cấp session — kết nối pg-meta dùng chung với Studio.
async function pg(sql, stmtTimeout = '20s') {
  const t = Date.now()
  const res = await fetch(`${BASE}/pg/query`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `SET LOCAL statement_timeout = '${stmtTimeout}'; ${sql}` }),
    signal: AbortSignal.timeout(45_000),
  })
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  const error = res.ok ? null : (typeof body === 'string' ? body : (body?.message ?? body?.error ?? JSON.stringify(body)))
  return { ok: res.ok, rows: res.ok && Array.isArray(body) ? body : [], error, ms: Date.now() - t }
}
async function must(sql, what) {
  const r = await pg(sql)
  if (!r.ok) throw new Error(`${what}: ${r.error}`)
  return r.rows
}
// Chỉ nhận literal đã kiểm định dạng — không bao giờ nội suy chuỗi tự do vào SQL.
const lit = (v, re, what) => {
  if (typeof v !== 'string' || !re.test(v)) throw new Error(`${what} sai định dạng: ${String(v)}`)
  return `'${v}'`
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const POS = /^[A-Z0-9]{3,20}$/
const NAME = /^QA-RACE-112-\d{13}$/

let failed = false
function assert(ok, label, detail = '') {
  if (ok) console.log('PASS:', label + (detail ? ` — ${detail}` : ''))
  else { console.error('FAIL:', label, detail); failed = true }
}
const settled = (p) => Promise.race([p.then(() => true, () => true), sleep(0).then(() => false)])

const name = `QA-RACE-112-${Date.now()}`
let markerWritten = false
let campaignId = null

try {
  const mig = await must("SELECT 1 AS ok FROM public.app_migrations WHERE version = '112'", 'đọc marker 112')
  if (mig.length !== 1) throw new Error('migration 112 chưa áp trên DB này — áp 112 + VERIFY trước')

  const st = await must("SELECT id, code FROM public.stores WHERE store_type = 'os' AND is_active ORDER BY code LIMIT 1", 'đọc OS store')
  if (st.length !== 1) throw new Error('không có OS store active làm fixture')
  const storeLit = lit(st[0].id, UUID, 'store id')
  const posLit = lit(st[0].code, POS, 'pos code')
  const nameLit = lit(name, NAME, 'tên fixture')

  // Marker TRƯỚC khi tạo: process chết ngay sau INSERT vẫn còn tên duy nhất để dọn.
  fs.writeFileSync(MARKER, JSON.stringify({ name, campaignId: null, host: projectHost, createdAt: new Date().toISOString() }))
  markerWritten = true
  const c = await must(
    `INSERT INTO public.kpi_campaigns (name, start_date, end_date, scope_type, metric_type, order_type,
       metric_offline, metric_affiliate, status, is_test)
     VALUES (${nameLit}, '2026-09-10', '2026-09-16', 'store', 'gmv', 'all', true, true, 'paused', true)
     RETURNING id`, 'tạo fixture')
  campaignId = c[0].id
  const idLit = lit(campaignId, UUID, 'campaign id')
  fs.writeFileSync(MARKER, JSON.stringify({ name, campaignId, host: projectHost, createdAt: new Date().toISOString() }))
  console.log('fixture campaign:', campaignId, `(${name}, is_test, paused, offline+affiliate) — marker đã ghi`)

  const INSERT_THRESHOLD = `INSERT INTO public.kpi_campaign_store_targets
       (campaign_id, store_id, pos_code, kpi_target, minimum_order_target, order_bonus_per_staff)
     VALUES (${idLit}, ${storeLit}, ${posLit}, 1000, 10, 200000)`
  const TURN_OFF_AFF = `UPDATE public.kpi_campaigns SET metric_affiliate = false WHERE id = ${idLit} AND is_test`
  // Chụp phiên KHÁC đang chạm fixture (lọc theo id) — không đếm chính mình.
  const SNAP = `SELECT pid, wait_event_type, wait_event, (query ILIKE '%pg_sleep%') AS is_holder
     FROM pg_stat_activity
     WHERE pid <> pg_backend_pid() AND query LIKE '%' || ${idLit} || '%' AND query NOT ILIKE '%pg_stat_activity%'`
  const thresholds = async () => Number((await must(
    `SELECT count(*)::int AS n FROM public.kpi_campaign_store_targets WHERE campaign_id = ${idLit} AND minimum_order_target IS NOT NULL`,
    'đếm ngưỡng'))[0].n)
  const affiliateOn = async () => (await must(`SELECT metric_affiliate FROM public.kpi_campaigns WHERE id = ${idLit}`, 'đọc cờ'))[0].metric_affiliate

  // ── Chiều 1: A ghi ngưỡng (giữ khoá), B tắt Affiliate ──────────────────
  const pA1 = pg(`${INSERT_THRESHOLD}; SELECT pg_sleep(${HOLD_S})`, '40s')
  await sleep(2000)
  const pB1 = pg(TURN_OFF_AFF)
  await sleep(2500)
  const s1 = await pg(SNAP)
  const b1w = s1.rows.find((r) => r.is_holder === false)
  assert(s1.ok && s1.ms < 3000, 'chiều 1: request thứ 3 trả về ngay — pool pg-meta không xếp hàng', `${s1.ms}ms`)
  assert(!!b1w && b1w.wait_event_type === 'Lock', 'chiều 1: B đang CHỜ KHOÁ trong Postgres khi A còn giữ', b1w ? `${b1w.wait_event_type}/${b1w.wait_event}` : 'không thấy B')
  assert(!(await settled(pB1)), 'chiều 1: B chưa kết thúc khi A còn giữ khoá')
  const [a1, b1] = await Promise.all([pA1, pB1])
  assert(a1.ok, 'chiều 1: A commit thành công (ngưỡng đã ghi)', a1.error ?? '')
  assert(!b1.ok && /không tắt được/.test(b1.error ?? ''), 'chiều 1: sau A commit, B thấy ngưỡng vừa ghi → trigger RAISE', (b1.error ?? 'B KHÔNG lỗi').split('\n')[0].slice(0, 140))
  assert(b1.ms >= (HOLD_S - 4) * 1000, 'chiều 1: B đã phải chờ tới khi A nhả khoá', `${Math.round(b1.ms / 1000)}s`)
  assert((await affiliateOn()) === true && (await thresholds()) === 1, 'chiều 1: không có trạng thái mâu thuẫn — có ngưỡng VÀ Affiliate vẫn bật')

  // Dọn target để chạy chiều ngược trên cùng fixture.
  await must(`DELETE FROM public.kpi_campaign_store_targets WHERE campaign_id = ${idLit}`, 'dọn target giữa 2 chiều')

  // ── Chiều 2: A tắt Affiliate (giữ khoá), B ghi ngưỡng ──────────────────
  const pA2 = pg(`${TURN_OFF_AFF}; SELECT pg_sleep(${HOLD_S})`, '40s')
  await sleep(2000)
  const pB2 = pg(INSERT_THRESHOLD)
  await sleep(2500)
  const s2 = await pg(SNAP)
  const b2w = s2.rows.find((r) => r.is_holder === false)
  assert(!!b2w && b2w.wait_event_type === 'Lock', 'chiều 2: B đang CHỜ KHOÁ — chính là FOR UPDATE trong trigger targets', b2w ? `${b2w.wait_event_type}/${b2w.wait_event}` : 'không thấy B')
  assert(!(await settled(pB2)), 'chiều 2: B chưa kết thúc khi A còn giữ khoá')
  const [a2, b2] = await Promise.all([pA2, pB2])
  assert(a2.ok, 'chiều 2: A commit thành công (Affiliate đã tắt)', a2.error ?? '')
  assert(!b2.ok && /chỉ hợp lệ với chiến dịch Doanh số bật CẢ/.test(b2.error ?? ''), 'chiều 2: sau A commit, B đọc cờ đã tắt → trigger RAISE', (b2.error ?? 'B KHÔNG lỗi').split('\n')[0].slice(0, 140))
  assert(b2.ms >= (HOLD_S - 4) * 1000, 'chiều 2: B đã phải chờ tới khi A nhả khoá', `${Math.round(b2.ms / 1000)}s`)
  assert((await affiliateOn()) === false && (await thresholds()) === 0, 'chiều 2: không ngưỡng nào lọt vào campaign đã tắt Affiliate')
} catch (e) {
  console.error('FAIL (exception):', e.message)
  failed = true
}

// ── CLEANUP + HẬU KIỂM — không bao giờ ALL PASS khi fixture còn trên DB ─────
let cleanup = { ok: !markerWritten, reason: markerWritten ? 'chưa chạy' : 'chưa tạo fixture' }
if (markerWritten) {
  try {
    const nameLit = lit(name, NAME, 'tên fixture')
    const idLit = campaignId ? lit(campaignId, UUID, 'campaign id') : null
    const del = await must(
      `DELETE FROM public.kpi_campaigns WHERE name = ${nameLit}${idLit ? ` AND id = ${idLit}` : ''} AND is_test AND name LIKE 'QA-RACE-112-%' RETURNING id`,
      'xoá fixture')
    // Target không tồn tại được khi không còn campaign (FK cascade) ⇒ chưa có id thì đếm 0.
    const left = await must(
      `SELECT (SELECT count(*)::int FROM public.kpi_campaigns WHERE name = ${nameLit}) AS campaigns,
              ${idLit ? `(SELECT count(*)::int FROM public.kpi_campaign_store_targets WHERE campaign_id = ${idLit})` : '0'} AS targets`,
      'hậu kiểm')
    const campaignsLeft = left[0].campaigns
    const targetsLeft = left[0].targets
    if (campaignId) {
      cleanup = judgeCleanup({ deleted: del.length, campaignsLeft, targetsLeft, error: null })
    } else if (del.length <= 1 && campaignsLeft === 0 && targetsLeft === 0) {
      // INSERT lỗi hoặc mất response trước khi có id: chỉ đòi hậu kiểm 0/0 theo tên duy nhất.
      cleanup = { ok: true, reason: `fixture chưa có id — xoá theo tên ${del.length} dòng, hậu kiểm 0/0` }
    } else {
      cleanup = judgeCleanup({ deleted: del.length, campaignsLeft, targetsLeft, error: null })
    }
  } catch (e) {
    cleanup = judgeCleanup({ deleted: 0, campaignsLeft: -1, targetsLeft: -1, error: e.message })
  }
}
if (cleanup.ok) {
  console.log('cleanup:', cleanup.reason)
  if (fs.existsSync(MARKER)) fs.unlinkSync(MARKER)
} else {
  console.error('FAIL cleanup:', cleanup.reason, '— GIỮ marker', MARKER, 'để dọn tay (campaign', name, campaignId ?? '', ')')
}

const verdict = finalVerdict({ testsFailed: failed, cleanupOk: cleanup.ok })
console.log(verdict)
process.exit(verdict === 'RACE 112: ALL PASS' ? 0 : 1)
