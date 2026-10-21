// QA RACE 2-transaction cho migration 115 (CRM-CSKH D1 — huỷ import), Q-168 (PM D1 r1) — qua pg-meta của Supabase self-hosted
// (`POST {NEXT_PUBLIC_SUPABASE_URL}/pg/query`, service role key ⇒ chạy bằng supabase_admin). Khuôn scripts/qa-race-112-pgmeta.mjs:
// mỗi request HTTP = MỘT kết nối + MỘT transaction ngầm; "A giữ khoá" = `…; SELECT pg_sleep(N)`; B gửi SONG SONG; chờ khoá thấy qua
// pg_stat_activity. KHÔNG BEGIN/COMMIT tường minh. Kịch bản + dọn: scripts/lib-race-115.mjs (đã chạy thử trên PostgreSQL 15 thật:
// planning/research/dev-tools/d1-115/realpg-race.mjs).
//
// SCRIPT GHI FIXTURE is_test VÀO DB THẬT ⇒ chỉ operator chạy, SAU 115 + VERIFY `post` + PM GO. Cổng fail-fast exit 2 TRƯỚC mọi request;
// cờ là biến PROCESS tạm, KHÔNG đặt vào .env.local:
//   cd webapp
//   $env:QA_RACE_115_ALLOWED='YES'; $env:QA_EXPECTED_PROJECT_HOST='<host của NEXT_PUBLIC_SUPABASE_URL>'
//   node scripts/qa-race-115.mjs            # 8 kịch bản (~2 phút)
//   node scripts/qa-race-115.mjs cleanup    # chỉ khi lần trước chết giữa chừng: dọn theo marker .qa-race-115.json
//   Remove-Item Env:QA_RACE_115_ALLOWED, Env:QA_EXPECTED_PROJECT_HOST
// Tài khoản (đọc .env.local): E2E_SUPER_EMAIL (super — actor import/huỷ + chuyển giao), E2E_STAFF_EMAIL (dược sĩ QA, store OS
// đang hoạt động — được giao task giả), E2E_CARE_TRANSFER_TO_EMAIL (dược sĩ QA đích, store OS). Output chỉ số đếm / mã / kết luận.
import fs from 'node:fs'
import { cleanupRaceScope, judgeRaceBarrier, RACE_PREFLIGHT_BARRIER_SQL, runRace115 } from './lib-race-115.mjs'

const safetyGate = (ok, msg) => { if (!ok) { console.error('SAFETY GATE FAIL:', msg); process.exit(2) } }
const cmd = process.argv[2] ?? 'run'
safetyGate(['run', 'cleanup'].includes(cmd) && process.argv.length <= 3, 'dùng: node scripts/qa-race-115.mjs [cleanup]')
safetyGate(process.env.QA_RACE_115_ALLOWED === 'YES', 'thiếu $env:QA_RACE_115_ALLOWED=YES (biến PROCESS tạm) — opt-in từng lần chạy vì script GHI fixture vào DB thật')
safetyGate(fs.existsSync('.env.local'), 'không thấy .env.local — chạy từ thư mục webapp/')
const envFile = fs.readFileSync('.env.local', 'utf8')
safetyGate(!/^\s*(QA_RACE_115_ALLOWED|QA_EXPECTED_PROJECT_HOST)\s*=/m.test(envFile), 'QA_RACE_115_ALLOWED / QA_EXPECTED_PROJECT_HOST nằm trong .env.local — phải là biến PROCESS tạm')
const env = {}
for (const line of envFile.split(/\r?\n/)) {
  const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/)
  if (m) env[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
}
const BASE = env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, ''), KEY = env.SUPABASE_SERVICE_ROLE_KEY
safetyGate(!!BASE && !!KEY, '.env.local thiếu NEXT_PUBLIC_SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY')
let host = null
try { host = new URL(BASE).hostname } catch { /* sai URL */ }
safetyGate(!!host && process.env.QA_EXPECTED_PROJECT_HOST === host, `QA_EXPECTED_PROJECT_HOST phải TRÙNG host của NEXT_PUBLIC_SUPABASE_URL (${host})`)
const MARKER = '.qa-race-115.json'
if (cmd === 'run') safetyGate(!fs.existsSync(MARKER), `marker ${MARKER} còn — lần trước chưa dọn xong; chạy: node scripts/qa-race-115.mjs cleanup`)
if (cmd === 'cleanup') safetyGate(fs.existsSync(MARKER), `không có marker ${MARKER} — không có gì để dọn`)
setTimeout(() => { console.error(`FAIL: watchdog 300 s — script treo; kiểm marker ${MARKER}`); process.exit(1) }, 300_000).unref()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// SET LOCAL statement_timeout chỉ sống trong transaction ngầm của request — không đổi session pg-meta dùng chung.
async function exec(sql) {
  const t = Date.now()
  try {
    const res = await fetch(`${BASE}/pg/query`, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `SET LOCAL statement_timeout = '40s'; ${sql}` }),
      signal: AbortSignal.timeout(60_000),
    })
    const text = await res.text()
    let body
    try { body = JSON.parse(text) } catch { body = text }
    const error = res.ok ? null : (typeof body === 'string' ? body : (body?.message ?? body?.error ?? JSON.stringify(body)))
    return { ok: res.ok, rows: res.ok && Array.isArray(body) ? body : [], error, ms: Date.now() - t }
  } catch (e) {
    return { ok: false, rows: [], error: `mạng/timeout: ${e.name}`, ms: Date.now() - t }
  }
}
const must = async (sql, what) => { const r = await exec(sql); if (!r.ok) throw new Error(`${what}: ${String(r.error).split('\n')[0].slice(0, 160)}`); return r.rows }
// Preflight (trước writeMarker): transaction ngầm READ ONLY — hàm / câu nào lỡ ghi ⇒ lỗi 25006, không ghi (db-reviewer r1.2 P2-7).
const mustRead = (sql, what) => must(`SET TRANSACTION READ ONLY; ${sql}`, what)
const writeMarker =(m) => { const tmp = `${MARKER}.tmp`; fs.writeFileSync(tmp, JSON.stringify(m, null, 2)); fs.renameSync(tmp, MARKER) }
const EMAIL = /^[^\s'"\\$;]+@[^\s'"\\$;]+$/

if (cmd === 'cleanup') {
  const m = JSON.parse(fs.readFileSync(MARKER, 'utf8'))
  safetyGate(m?.host === host && Array.isArray(m.scopes), 'marker khác host hoặc sai định dạng — không tự dọn, báo Dev')
  let bad = 0
  for (const s of m.scopes) {
    try { await cleanupRaceScope(exec, s); console.log(`cleanup ${s.tag}: sạch`) } catch (e) { bad++; console.error(`FAIL cleanup ${s.tag}: ${e.message}`) }
  }
  if (!bad) fs.rmSync(MARKER)
  console.log(bad ? 'RACE 115 CLEANUP: FAIL — giữ marker, báo Dev' : 'RACE 115 CLEANUP: sạch, đã xoá marker')
  process.exit(bad ? 1 : 0)
}

let failed = false
const assert = (ok, label, detail = '') => { if (ok) console.log('PASS:', label); else { console.error('FAIL:', label, detail); failed = true } }
const marker = { host, runId: null, startedAt: new Date().toISOString(), scopes: [] }
let cleanupOk = true
try {
  // ── Preflight CHỈ ĐỌC ────────────────────────────────────────────────────
  // Bước 1: 115 + rào commit (cùng điều kiện VERIFY V6; PM D1 r1.1 P1: rào 'A' = ENABLE ALWAYS). Chưa có 115 ⇒ dừng TRƯỚC khi đọc
  // bảng của 115 (journal) để ra lý do rõ, không lỗi SQL.
  const barrier = (await mustRead(RACE_PREFLIGHT_BARRIER_SQL, 'preflight rào'))[0]
  const notReady = judgeRaceBarrier(barrier)
  if (notReady) throw new Error(notReady)
  // Bước 2: dữ liệu (chỉ chạy khi đã có 115).
  const pre = (await mustRead(`SELECT
      public.care_vn_today()::text AS today,
      public.care_period_of(public.care_vn_today())::text AS period,
      (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::text AS now_vn,
      (SELECT count(*)::int FROM public.care_tasks WHERE status = 'open' AND period_month < public.care_period_of(public.care_vn_today())) AS open_prev,
      (SELECT count(*)::int FROM public.care_import_batches WHERE is_test AND status = 'committed' AND period_month = public.care_period_of(public.care_vn_today())) AS test_committed,
      (SELECT count(*)::int FROM public.care_import_revision_journal j JOIN public.care_import_batches b ON b.id = j.batch_id
         WHERE b.period_month < public.care_period_of(public.care_vn_today())) AS prev_journal`,
    'preflight'))[0]
  const nowVn = new Date(`${pre.now_vn.replace(' ', 'T').slice(0, 19)}Z`)
  const minsToMonth = Math.min(nowVn.getUTCDate() === 1 ? nowVn.getUTCHours() * 60 + nowVn.getUTCMinutes() : 1e9,
    (Date.UTC(nowVn.getUTCFullYear(), nowVn.getUTCMonth() + 1, 1) - nowVn.getTime()) / 60_000)
  if (minsToMonth < 15) throw new Error('trong 15 phút quanh giao tháng (giờ VN) — chạy lại sau')
  if (pre.open_prev !== 0) throw new Error(`còn ${pre.open_prev} task mở kỳ trước — finalize fixture sẽ đóng chúng; chờ đóng kỳ`)
  if (pre.test_committed !== 0) throw new Error(`kỳ này còn ${pre.test_committed} batch is_test committed của lượt QA khác — dọn trước`)
  // finalize fixture gọi care__close_period_at ⇒ sẽ xoá journal THẬT của kỳ trước nếu cron đóng kỳ chưa chạy (db-reviewer r1.1 P2-5).
  if (pre.prev_journal !== 0) throw new Error(`còn ${pre.prev_journal} dòng journal kỳ trước (cron đóng kỳ chưa chạy) — chờ care-period-close rồi chạy lại`)
  const user = async (k) => {
    const email = env[k]
    if (!email || !EMAIL.test(email)) throw new Error(`${k} thiếu hoặc sai định dạng`)
    const r = await mustRead(`SELECT u.id, u.role, s.code, s.store_type, s.is_active FROM public.users u LEFT JOIN public.stores s ON s.id = u.store_id
      WHERE lower(u.email) = lower('${email}')`, `tra ${k}`)
    if (r.length !== 1) throw new Error(`${k} không khớp đúng 1 user`)
    return r[0]
  }
  const sup = await user('E2E_SUPER_EMAIL'), st = await user('E2E_STAFF_EMAIL'), st2 = await user('E2E_CARE_TRANSFER_TO_EMAIL')
  const isSuper = (await mustRead(`SELECT public.care__uid_is_super('${sup.id}'::uuid) AS s`, 'kiểm super'))[0].s
  if (sup.role !== 'admin' || isSuper !== true) throw new Error('E2E_SUPER_EMAIL phải là super admin')
  for (const [k, u] of [['E2E_STAFF_EMAIL', st], ['E2E_CARE_TRANSFER_TO_EMAIL', st2]]) {
    if (u.role !== 'staff' || u.store_type !== 'os' || u.is_active !== true) throw new Error(`${k} phải là dược sĩ của store OS đang hoạt động`)
  }
  if (st.id === st2.id) throw new Error('E2E_STAFF_EMAIL và E2E_CARE_TRANSFER_TO_EMAIL phải khác nhau')
  writeMarker(marker)
  const out = await runRace115({
    exec, sleep, assert,          // thời gian giữ khoá = hằng chung RACE_HOLD_S (< lock_timeout 5 s của huỷ)
    ids: { actor: sup.id, staff: st.id, staff2: st2.id, storeCode: st.code, staffEmail: env.E2E_STAFF_EMAIL, period: pre.period, today: pre.today },
    onScope: (s) => { marker.runId = s.ext[0].split('-')[2]; marker.scopes.push({ tag: s.tag, ext: s.ext, batchIds: s.batchIds }); writeMarker(marker) },
  })
  console.log(`kịch bản: ${out.scenarios.join(', ')}`)
} catch (e) {
  console.error('FAIL (exception):', e.message)
  failed = true
  // Kịch bản dở: thử dọn mọi scope trong marker (cùng hàm dọn, kiểm phạm vi trước DELETE).
  for (const s of marker.scopes) {
    try { await cleanupRaceScope(exec, s) } catch (ce) { cleanupOk = false; console.error(`FAIL cleanup ${s.tag}: ${ce.message}`) }
  }
}
if (cleanupOk && fs.existsSync(MARKER)) fs.rmSync(MARKER)
else if (!cleanupOk) console.error(`GIỮ marker ${MARKER} — chạy lại: node scripts/qa-race-115.mjs cleanup`)
const verdict = failed || !cleanupOk ? 'RACE 115: FAIL' : 'RACE 115: ALL PASS'
console.log(verdict)
process.exit(verdict === 'RACE 115: ALL PASS' ? 0 : 1)
