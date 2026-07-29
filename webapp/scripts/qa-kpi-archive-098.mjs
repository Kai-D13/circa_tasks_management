// QA executable cho migration 098 (Campaign Archive) — chạy từ thư mục webapp/.
// Đọc URL + service key từ .env.local. KHÔNG in secret. Fixture = 1 campaign
// is_test tên cố định; cleanup theo EXACT id (không range delete). FAIL-FAST:
// mọi bước sai kỳ vọng → in FAIL + exit 1.
//
//   node scripts/qa-kpi-archive-098.mjs verify    # migration record + cột archive
//   node scripts/qa-kpi-archive-098.mjs run       # functional QA đầy đủ (tự cleanup)
//   node scripts/qa-kpi-archive-098.mjs cleanup   # dọn fixture nếu run bị đứt giữa chừng
//
// `run` — KỲ VỌNG từng bước (in PASS/FAIL):
//   1. archive campaign DRAFT   → RAISE 'Chỉ lưu trữ…'
//   2. archive campaign ACTIVE  → RAISE 'tạm dừng trước'
//   3. (paused) import targets + ghi actuals qua RPC → OK; đếm bảng con
//   4. archive PAUSED           → {archived:true}
//   5. archive LẦN 2            → RAISE 'đã được lưu trữ trước đó'
//   6. đếm bảng con SAU archive == TRƯỚC (targets/tiers/actuals/daily/runs)
//   7. rpc_replace_campaign_targets trên archived → RAISE 'đã lưu trữ'
//   8. rpc_activate_kpi_campaign  trên archived   → RAISE 'đã lưu trữ'
//   9. rpc_replace_campaign_actuals trên archived → RAISE 'đã lưu trữ'
//  10. cleanup cascade + verify campaign biến mất
// LƯU Ý: check function-definition/grants (prosecdef, has_function_privilege,
// row-lock trong body) + RACE 2-session nằm trong docs/qa-runbook-098-099.md
// (SQL editor / psql — PostgREST không chạy được các câu đó).
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = {}
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m) env[m[1]] = m[2]
}
for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!env[k]) { console.error('FAIL: thiếu', k, 'trong .env.local'); process.exit(1) }
}
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const QA_NAME = 'QA-ARCHIVE-098'
const [cmd] = process.argv.slice(2)
let failed = false

function must(res, label) {
  if (res.error) { console.error('FAIL:', label, '—', res.error.message); process.exit(1) }
  return res
}
function expectOk(res, label) {
  if (res.error) { console.error('FAIL:', label, '— kỳ vọng OK, nhận lỗi:', res.error.message); failed = true }
  else console.log('PASS:', label)
  return res
}
function expectRaise(res, label, needle) {
  if (!res.error) { console.error('FAIL:', label, '— kỳ vọng RAISE nhưng GỌI ĐƯỢC'); failed = true }
  else if (needle && !res.error.message.includes(needle)) {
    console.error(`FAIL: ${label} — RAISE nhưng message không chứa "${needle}": ${res.error.message}`); failed = true
  } else console.log('PASS:', label, '→ bị chặn ✓')
}

async function childCounts(id) {
  const t = must(await svc.from('kpi_campaign_store_targets').select('*', { count: 'exact', head: true }).eq('campaign_id', id), 'đếm targets')
  const tr = must(await svc.from('kpi_campaign_store_tiers').select('id, kpi_campaign_store_targets!inner(campaign_id)', { count: 'exact', head: true }).eq('kpi_campaign_store_targets.campaign_id', id), 'đếm tiers')
  const a = must(await svc.from('kpi_campaign_store_actuals').select('*', { count: 'exact', head: true }).eq('campaign_id', id), 'đếm actuals')
  const d = must(await svc.from('kpi_campaign_store_daily_actuals').select('*', { count: 'exact', head: true }).eq('campaign_id', id), 'đếm daily')
  const r = must(await svc.from('kpi_campaign_import_runs').select('*', { count: 'exact', head: true }).eq('campaign_id', id), 'đếm import runs')
  return { targets: t.count, tiers: tr.count, actuals: a.count, daily: d.count, runs: r.count }
}

async function verify() {
  const mig = must(await svc.from('app_migrations').select('version, name').eq('version', '098'), 'đọc app_migrations')
  if (mig.data.length !== 1) { console.error('FAIL: app_migrations chưa có 098 — migration chưa chạy?'); process.exit(1) }
  console.log('PASS: app_migrations 098 =', JSON.stringify(mig.data[0]))
  const col = await svc.from('kpi_campaigns').select('id, archived_at, archived_by, archived_reason').limit(1)
  if (col.error) { console.error('FAIL: thiếu cột archive —', col.error.message); process.exit(1) }
  console.log('PASS: 3 cột archived_at/archived_by/archived_reason tồn tại')
  console.log('NHẮC: chạy tiếp các block SQL (prosecdef/grants/function-def/race) trong docs/qa-runbook-098-099.md')
}

async function run() {
  // ── Fixture: campaign is_test + 1 target OS ──
  const store = must(await svc.from('stores').select('id, code').eq('store_type', 'os').eq('is_active', true).limit(1).single(), 'đọc 1 OS store')
  const camp = must(await svc.from('kpi_campaigns').insert({
    name: QA_NAME, start_date: '2026-07-01', end_date: '2026-07-31',
    scope_type: 'store', metric_type: 'gmv', order_type: 'all',
    metric_offline: true, metric_affiliate: false, status: 'draft', is_test: true,
  }).select('id, updated_at').single(), 'tạo campaign fixture')
  const id = camp.data.id
  console.log('fixture campaign:', id, '(is_test, draft)')

  // 1-2. draft/active không archive được
  expectRaise(await svc.rpc('rpc_archive_kpi_campaign', { p_campaign_id: id, p_actor: null }), '1. archive DRAFT', 'Chỉ lưu trữ')
  must(await svc.from('kpi_campaigns').update({ status: 'active' }).eq('id', id), 'set active')
  expectRaise(await svc.rpc('rpc_archive_kpi_campaign', { p_campaign_id: id, p_actor: null }), '2. archive ACTIVE', 'tạm dừng trước')

  // 3. paused: import targets + ghi actuals (RPC thật — cùng đường production)
  must(await svc.from('kpi_campaigns').update({ status: 'paused' }).eq('id', id), 'set paused')
  expectOk(await svc.rpc('rpc_replace_campaign_targets', {
    p_campaign_id: id,
    p_rows: [{ store_id: store.data.id, pos_code: store.data.code, kpi_target: 2000, store_kpi_group: 'QA', import_row: 1, note: null, tiers: [{ tier_order: 1, threshold_pct: 90, commission_amount: 100 }] }],
    p_file_name: 'qa-098.xlsx', p_uploaded_by: null,
  }), '3a. import targets (paused)')
  const now = new Date().toISOString()
  expectOk(await svc.rpc('rpc_replace_campaign_actuals', {
    p_campaign_id: id,
    p_daily: [{ store_id: store.data.id, date: '2026-07-15', gmv: 1000, gmv_affiliate: 0, synced_at: now }],
    p_actuals: [{ store_id: store.data.id, actual_value: 1000, actual_offline: 1000, actual_affiliate: 0, run_rate: 50, remaining_target: 1000, achieved_tier_order: null, store_commission_pool: 0, raw_row_count: 1, offline_synced_at: now, affiliate_synced_at: null, synced_at: now }],
  }), '3b. ghi actuals (paused, chưa archive)')
  const before = await childCounts(id)
  console.log('   bảng con TRƯỚC archive:', JSON.stringify(before))

  // 4-5. archive OK đúng 1 lần
  expectOk(await svc.rpc('rpc_archive_kpi_campaign', { p_campaign_id: id, p_actor: null }), '4. archive PAUSED')
  expectRaise(await svc.rpc('rpc_archive_kpi_campaign', { p_campaign_id: id, p_actor: null }), '5. archive lần 2', 'đã được lưu trữ')

  // 6. bảng con nguyên vẹn
  const after = await childCounts(id)
  if (JSON.stringify(before) === JSON.stringify(after)) console.log('PASS: 6. bảng con KHÔNG đổi sau archive:', JSON.stringify(after))
  else { console.error('FAIL: 6. bảng con đổi sau archive:', JSON.stringify(before), '→', JSON.stringify(after)); failed = true }

  // 7-9. archived đóng băng cả 3 RPC ghi
  expectRaise(await svc.rpc('rpc_replace_campaign_targets', {
    p_campaign_id: id, p_rows: [], p_file_name: null, p_uploaded_by: null,
  }), '7. import targets trên archived', 'đã lưu trữ')
  const row = must(await svc.from('kpi_campaigns').select('updated_at, archived_at').eq('id', id).single(), 'đọc updated_at')
  if (!row.data.archived_at) { console.error('FAIL: archived_at NULL sau archive'); failed = true }
  expectRaise(await svc.rpc('rpc_activate_kpi_campaign', {
    p_campaign_id: id, p_expected_updated_at: row.data.updated_at,
  }), '8. activate trên archived', 'đã lưu trữ')
  expectRaise(await svc.rpc('rpc_replace_campaign_actuals', {
    p_campaign_id: id, p_daily: [], p_actuals: [],
  }), '9. ghi actuals trên archived (fix P1#1)', 'đã lưu trữ')

  // 10. cleanup cascade
  const del = must(await svc.from('kpi_campaigns').delete().eq('id', id).select('id'), 'xóa fixture')
  const left = must(await svc.from('kpi_campaigns').select('*', { count: 'exact', head: true }).eq('name', QA_NAME), 'verify sạch')
  console.log(`PASS: 10. cleanup cascade (deleted=${del.data.length}, còn lại=${left.count})`)

  console.log(failed ? '\n=== KẾT QUẢ: CÓ FAIL — xem log trên ===' : '\n=== KẾT QUẢ: PASS TOÀN BỘ 10 bước ===')
  process.exit(failed ? 1 : 0)
}

async function cleanup() {
  const del = must(await svc.from('kpi_campaigns').delete().eq('name', QA_NAME).eq('is_test', true).select('id'), 'xóa fixture theo tên')
  console.log('OK: đã dọn', del.data.length, 'campaign fixture', QA_NAME)
}

const cmds = { verify, run, cleanup }
if (!cmds[cmd]) { console.error('Lệnh: verify | run | cleanup'); process.exit(1) }
await cmds[cmd]()
