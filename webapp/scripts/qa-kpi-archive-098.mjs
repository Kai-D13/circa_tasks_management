// QA executable cho migration 098 (Campaign Archive) — chạy từ thư mục webapp/.
// Đọc URL + service key từ .env.local (PRODUCTION — fixture phải tự cô lập).
// KHÔNG in secret. r1.2 (audit):
//   · Fixture name UNIQUE mỗi run + MARKER local (.qa-archive-098.json) ghi
//     campaign id ngay sau khi tạo — cleanup CHỈ theo exact id trong marker,
//     đặt trong finally (run đứt giữa chừng vẫn dọn).
//   · Bảng con so sánh bằng SNAPSHOT ĐẦY ĐỦ NỘI DUNG (sort ổn định +
//     deep-compare 5 nhóm: targets/tiers/actuals/daily/import-runs) — không
//     chỉ đếm row (archive lỡ sửa actual_value/commission sẽ bị bắt).
//
//   node scripts/qa-kpi-archive-098.mjs verify    # migration record + cột archive
//   node scripts/qa-kpi-archive-098.mjs run       # functional QA 10 bước (tự cleanup trong finally)
//   node scripts/qa-kpi-archive-098.mjs cleanup   # dọn theo marker nếu còn sót
//
// `run` — KỲ VỌNG từng bước (in PASS/FAIL, FAIL-FAST tổng kết exit 1):
//   1. archive DRAFT   → RAISE 'Chỉ lưu trữ…'
//   2. archive ACTIVE  → RAISE 'tạm dừng trước'
//   3. (paused) import targets + ghi actuals qua RPC thật → OK; SNAPSHOT bảng con
//   4. archive PAUSED  → OK
//   5. archive lần 2   → RAISE 'đã được lưu trữ trước đó'
//   6. SNAPSHOT bảng con SAU archive == TRƯỚC (deep-compare nội dung)
//   7. import targets trên archived → RAISE 'đã lưu trữ'
//   8. activate trên archived       → RAISE 'đã lưu trữ'
//   9. ghi actuals trên archived    → RAISE 'đã lưu trữ' (fix P1#1)
//  10. cleanup cascade theo marker + verify sạch
// LƯU Ý: check function-definition/grants + RACE 2-session nằm trong
// docs/qa-runbook-098-099.md (SQL editor / psql).
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

const MARKER = '.qa-archive-098.json'
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

// r1.2 (audit P2#4): SNAPSHOT ĐẦY ĐỦ nội dung 5 nhóm bảng con, sort ổn định —
// deep-compare bắt cả trường hợp archive lỡ sửa giá trị mà không đổi số row.
async function childSnapshot(id) {
  const t = must(await svc.from('kpi_campaign_store_targets')
    .select('id, store_id, pos_code, kpi_target, store_kpi_group, import_row, note')
    .eq('campaign_id', id).order('store_id'), 'snapshot targets')
  const tr = must(await svc.from('kpi_campaign_store_tiers')
    .select('target_id, tier_order, threshold_pct, commission_amount, kpi_campaign_store_targets!inner(campaign_id)')
    .eq('kpi_campaign_store_targets.campaign_id', id)
    .order('target_id').order('tier_order'), 'snapshot tiers')
  const a = must(await svc.from('kpi_campaign_store_actuals')
    .select('store_id, actual_value, actual_offline, actual_affiliate, run_rate, remaining_target, achieved_tier_order, store_commission_pool, raw_row_count, offline_synced_at, affiliate_synced_at, synced_at')
    .eq('campaign_id', id).order('store_id'), 'snapshot actuals')
  const d = must(await svc.from('kpi_campaign_store_daily_actuals')
    .select('store_id, date, gmv, gmv_affiliate, synced_at')
    .eq('campaign_id', id).order('store_id').order('date'), 'snapshot daily')
  const r = must(await svc.from('kpi_campaign_import_runs')
    .select('id, file_name, row_count, success_count, error_count, created_at')
    .eq('campaign_id', id).order('created_at'), 'snapshot import runs')
  return JSON.stringify({ targets: t.data, tiers: tr.data, actuals: a.data, daily: d.data, runs: r.data })
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
  if (fs.existsSync(MARKER)) {
    console.error('FAIL: marker', MARKER, 'đang tồn tại — run trước chưa dọn. Chạy `cleanup` trước, không tạo fixture chồng.')
    process.exit(1)
  }
  // r1.2: tên fixture UNIQUE mỗi run — không đụng bất kỳ campaign nào có sẵn.
  const QA_NAME = `QA-ARCHIVE-098-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
  const store = must(await svc.from('stores').select('id, code').eq('store_type', 'os').eq('is_active', true).limit(1).single(), 'đọc 1 OS store')
  const camp = must(await svc.from('kpi_campaigns').insert({
    name: QA_NAME, start_date: '2026-07-01', end_date: '2026-07-31',
    scope_type: 'store', metric_type: 'gmv', order_type: 'all',
    metric_offline: true, metric_affiliate: false, status: 'draft', is_test: true,
  }).select('id').single(), 'tạo campaign fixture')
  const id = camp.data.id
  // Marker NGAY sau khi tạo — cleanup luôn có exact id kể cả khi run đứt.
  fs.writeFileSync(MARKER, JSON.stringify({ campaignId: id, name: QA_NAME, at: new Date().toISOString() }))
  console.log('fixture campaign:', id, `(${QA_NAME}, is_test, draft) — marker đã ghi`)

  try {
    expectRaise(await svc.rpc('rpc_archive_kpi_campaign', { p_campaign_id: id, p_actor: null }), '1. archive DRAFT', 'Chỉ lưu trữ')
    must(await svc.from('kpi_campaigns').update({ status: 'active' }).eq('id', id), 'set active')
    expectRaise(await svc.rpc('rpc_archive_kpi_campaign', { p_campaign_id: id, p_actor: null }), '2. archive ACTIVE', 'tạm dừng trước')

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
    const before = await childSnapshot(id)
    console.log('   snapshot bảng con TRƯỚC archive:', before.length, 'bytes (5 nhóm, sort ổn định)')

    expectOk(await svc.rpc('rpc_archive_kpi_campaign', { p_campaign_id: id, p_actor: null }), '4. archive PAUSED')
    expectRaise(await svc.rpc('rpc_archive_kpi_campaign', { p_campaign_id: id, p_actor: null }), '5. archive lần 2', 'đã được lưu trữ')

    const after = await childSnapshot(id)
    if (before === after) console.log('PASS: 6. bảng con NGUYÊN VẸN NỘI DUNG sau archive (deep-compare 5 nhóm)')
    else { console.error('FAIL: 6. NỘI DUNG bảng con đổi sau archive — diff snapshot:', before === after); failed = true }

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
  } finally {
    // r1.2: cleanup CHỈ exact id trong marker, luôn chạy kể cả khi lỗi giữa chừng.
    const del = await svc.from('kpi_campaigns').delete().eq('id', id).select('id')
    if (del.error) console.error('FAIL: cleanup —', del.error.message)
    else {
      const left = await svc.from('kpi_campaigns').select('*', { count: 'exact', head: true }).eq('id', id)
      console.log(`PASS: 10. cleanup cascade theo marker (deleted=${del.data.length}, còn lại=${left.count ?? '?'})`)
      if (fs.existsSync(MARKER)) fs.unlinkSync(MARKER)
    }
  }

  console.log(failed ? '\n=== KẾT QUẢ: CÓ FAIL — xem log trên ===' : '\n=== KẾT QUẢ: PASS TOÀN BỘ 10 bước ===')
  process.exit(failed ? 1 : 0)
}

async function cleanup() {
  if (!fs.existsSync(MARKER)) { console.error('Không có marker', MARKER, '— không có fixture nào cần dọn (không tự đoán tên).'); process.exit(1) }
  const m = JSON.parse(fs.readFileSync(MARKER, 'utf8'))
  const del = must(await svc.from('kpi_campaigns').delete().eq('id', m.campaignId).eq('is_test', true).select('id'), 'xóa fixture theo marker')
  fs.unlinkSync(MARKER)
  console.log('OK: đã dọn', del.data.length, 'campaign fixture', m.name, '(exact id từ marker)')
}

const cmds = { verify, run, cleanup }
if (!cmds[cmd]) { console.error('Lệnh: verify | run | cleanup'); process.exit(1) }
await cmds[cmd]()
