// QA executable cho migration 098 (Campaign Archive) — chạy từ thư mục webapp/.
// Đọc URL + service key từ .env.local (PRODUCTION — fixture phải tự cô lập).
// KHÔNG in secret.
//
// r1.3 (audit): chuẩn cleanup production —
//   · Flow `run` KHÔNG process.exit giữa chừng: mọi lỗi THROW → catch đặt
//     failed → finally LUÔN chạy cleanup; exit code đặt ở top-level SAU finally.
//   · Cleanup contract 3 ĐIỀU KIỆN: delete không lỗi + query verify không lỗi
//     + count = 0 → mới xóa marker. Bất kỳ điều kiện nào fail → GIỮ marker,
//     failed=true, exit ≠ 0 (không bao giờ 'PASS TOÀN BỘ' khi DB chưa sạch).
//   · Manual `cleanup` dùng CÙNG contract (không delete-rồi-xóa-marker mù).
//   · Snapshot bảng con = select('*') TOÀN BỘ CỘT + canonical-sort theo
//     primary/unique key rồi deep-compare.
//   · Marker có kind/schemaVersion/createdAt — validate trước khi dùng.
//   · fixture có giai đoạn ACTIVE ngắn → yêu cầu QA_KPI_CRON_PAUSED=YES:
//     lời XÁC NHẬN đã DISABLE THẬT Coolify task sync-kpi-campaign-actuals
//     (r1.4 audit: không dùng cách chạy lệch phút) — giữ Disabled XUYÊN SUỐT
//     normal run + negative run + cleanup + SQL xác nhận sạch.
//   · Negative QA: QA_BREAK_STEP=yes → cố ý throw sau bước 6 để chứng minh
//     cleanup vẫn chạy và marker chỉ mất khi DB sạch.
//
//   $env:QA_KPI_CRON_PAUSED='YES'; node scripts/qa-kpi-archive-098.mjs run
//   node scripts/qa-kpi-archive-098.mjs verify
//   node scripts/qa-kpi-archive-098.mjs cleanup   # dọn theo marker (cùng contract)
//
// `run` — KỲ VỌNG 10 bước như r1.2 (draft/active chặn · paused OK · lần 2
// chặn · bảng con NGUYÊN VẸN NỘI DUNG deep-compare · import/activate/ghi-
// actuals trên archived RAISE · cleanup 3-điều-kiện). Check function-def/
// grants + RACE 2-session: docs/qa-runbook-098-099.md.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = {}
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m) env[m[1]] = m[2]
}
for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!env[k]) { console.error('FAIL: thiếu', k, 'trong .env.local'); process.exitCode = 1; process.exit() }
}
const URL = env.NEXT_PUBLIC_SUPABASE_URL
const svc = createClient(URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const MARKER = '.qa-archive-098.json'
const MARKER_KIND = 'qa-archive-098'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const [cmd] = process.argv.slice(2)
let failed = false

function fail(label, detail = '') { console.error('FAIL:', label, detail); failed = true }
// r1.3: trong flow run/cleanup KHÔNG exit — throw để finally luôn chạy.
function mustT(res, label) {
  if (res.error) throw new Error(`${label} — ${res.error.message}`)
  return res
}
function expectOk(res, label) {
  if (res.error) fail(label, `— kỳ vọng OK, nhận lỗi: ${res.error.message}`)
  else console.log('PASS:', label)
  return res
}
function expectRaise(res, label, needle) {
  if (!res.error) fail(label, '— kỳ vọng RAISE nhưng GỌI ĐƯỢC')
  else if (needle && !res.error.message.includes(needle)) {
    fail(label, `— RAISE nhưng message không chứa "${needle}": ${res.error.message}`)
  } else console.log('PASS:', label, '→ bị chặn ✓')
}
const sortBy = (arr, keyFn) => [...arr].sort((a, b) => {
  const ka = keyFn(a); const kb = keyFn(b)
  return ka < kb ? -1 : ka > kb ? 1 : 0
})

// r1.3 (P2#3): snapshot TOÀN BỘ CỘT (select *) 5 nhóm bảng con, canonical-sort
// theo primary/unique key — deep-compare bắt mọi thay đổi nội dung.
async function childSnapshot(id) {
  const t = mustT(await svc.from('kpi_campaign_store_targets').select('*').eq('campaign_id', id), 'snapshot targets')
  const tr = mustT(await svc.from('kpi_campaign_store_tiers')
    .select('*, kpi_campaign_store_targets!inner(campaign_id)')
    .eq('kpi_campaign_store_targets.campaign_id', id), 'snapshot tiers')
  const a = mustT(await svc.from('kpi_campaign_store_actuals').select('*').eq('campaign_id', id), 'snapshot actuals')
  const d = mustT(await svc.from('kpi_campaign_store_daily_actuals').select('*').eq('campaign_id', id), 'snapshot daily')
  const r = mustT(await svc.from('kpi_campaign_import_runs').select('*').eq('campaign_id', id), 'snapshot import runs')
  return JSON.stringify({
    targets: sortBy(t.data, (x) => x.id),
    tiers: sortBy(tr.data, (x) => `${x.target_id}|${String(x.tier_order).padStart(4, '0')}`),
    actuals: sortBy(a.data, (x) => `${x.campaign_id}|${x.store_id}`),
    daily: sortBy(d.data, (x) => `${x.store_id}|${x.date}`),
    runs: sortBy(r.data, (x) => x.id),
  })
}

// r1.3 (P1#1+#2): cleanup contract 3 điều kiện — trả true CHỈ khi DB chắc chắn
// sạch; mọi nhánh lỗi → failed=true + false (caller GIỮ marker).
// r1.5 (audit r1.4 P2-low): TRƯỚC delete đối chiếu row là fixture QA thật —
// name prefix QA-ARCHIVE-098-* + is_test=true; không khớp → KHÔNG xóa.
async function cleanupFixture(campaignId) {
  const row = await svc.from('kpi_campaigns').select('id, name, is_test').eq('id', campaignId).maybeSingle()
  if (row.error) { fail('cleanup: đọc row lỗi', row.error.message); return false }
  if (row.data && (!String(row.data.name ?? '').startsWith('QA-ARCHIVE-098-') || row.data.is_test !== true)) {
    fail('cleanup: row KHÔNG phải fixture QA (name/is_test không khớp) — KHÔNG xóa', JSON.stringify({ name: row.data.name, is_test: row.data.is_test }))
    return false
  }
  const del = await svc.from('kpi_campaigns').delete().eq('id', campaignId).eq('is_test', true).select('id')
  if (del.error) { fail('cleanup: delete lỗi', del.error.message); return false }
  const left = await svc.from('kpi_campaigns').select('*', { count: 'exact', head: true }).eq('id', campaignId)
  if (left.error) { fail('cleanup: verify lỗi', left.error.message); return false }
  if (left.count !== 0) { fail('cleanup: verify', `còn ${left.count} row — DB CHƯA sạch`); return false }
  console.log(`PASS: cleanup cascade 3-điều-kiện (deleted=${del.data.length}, verify=0)`)
  return true
}
function removeMarkerIfClean(clean) {
  if (clean) {
    if (fs.existsSync(MARKER)) fs.unlinkSync(MARKER)
    console.log('marker đã gỡ (DB sạch)')
  } else {
    fail('marker GIỮ NGUYÊN — DB chưa xác nhận sạch; xử lý rồi chạy `cleanup`')
  }
}
function loadMarker() {
  if (!fs.existsSync(MARKER)) throw new Error(`không có marker ${MARKER} — không có fixture nào cần dọn (không tự đoán).`)
  const m = JSON.parse(fs.readFileSync(MARKER, 'utf8'))
  // r1.4: kèm check projectUrl — marker của project khác không được dùng ở đây.
  if (m.kind !== MARKER_KIND || m.schemaVersion !== 1 || !UUID_RE.test(m.campaignId ?? '') || m.projectUrl !== URL) {
    throw new Error(`marker hỏng/sai schema/khác Supabase project (${JSON.stringify({ kind: m.kind, schemaVersion: m.schemaVersion, projectMatch: m.projectUrl === URL })}) — KHÔNG xóa gì; kiểm tra tay.`)
  }
  return m
}

async function verify() {
  const mig = mustT(await svc.from('app_migrations').select('version, name').eq('version', '098'), 'đọc app_migrations')
  if (mig.data.length !== 1) throw new Error('app_migrations chưa có 098 — migration chưa chạy?')
  console.log('PASS: app_migrations 098 =', JSON.stringify(mig.data[0]))
  mustT(await svc.from('kpi_campaigns').select('id, archived_at, archived_by, archived_reason').limit(1), 'đọc 3 cột archive')
  console.log('PASS: 3 cột archived_at/archived_by/archived_reason tồn tại')
  console.log('NHẮC: chạy tiếp các block SQL (prosecdef/grants/function-def/race) trong docs/qa-runbook-098-099.md')
}

async function run() {
  if (fs.existsSync(MARKER)) { fail(`marker ${MARKER} đang tồn tại — run trước chưa dọn; chạy \`cleanup\` trước.`); return }
  // r1.3/r1.4 (P2#5/điểm 10): fixture có giai đoạn ACTIVE ngắn — bắt xác nhận
  // đã DISABLE THẬT Coolify task sync-kpi-campaign-actuals (audit: không dùng
  // cách "chạy lệch phút"); env chỉ là lời xác nhận của người chạy.
  if (process.env.QA_KPI_CRON_PAUSED !== 'YES') {
    fail('thiếu xác nhận QA_KPI_CRON_PAUSED=YES — DISABLE Coolify task sync-kpi-campaign-actuals trước, rồi set env này.')
    return
  }
  const QA_NAME = `QA-ARCHIVE-098-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
  let id = null
  try {
    const store = mustT(await svc.from('stores').select('id, code').eq('store_type', 'os').eq('is_active', true).limit(1).single(), 'đọc 1 OS store')
    const camp = mustT(await svc.from('kpi_campaigns').insert({
      name: QA_NAME, start_date: '2026-07-01', end_date: '2026-07-31',
      scope_type: 'store', metric_type: 'gmv', order_type: 'all',
      metric_offline: true, metric_affiliate: false, status: 'draft', is_test: true,
    }).select('id').single(), 'tạo campaign fixture')
    id = camp.data.id
    fs.writeFileSync(MARKER, JSON.stringify({ kind: MARKER_KIND, schemaVersion: 1, campaignId: id, name: QA_NAME, createdAt: new Date().toISOString(), projectUrl: URL }))
    console.log('fixture campaign:', id, `(${QA_NAME}, is_test, draft) — marker đã ghi`)

    expectRaise(await svc.rpc('rpc_archive_kpi_campaign', { p_campaign_id: id, p_actor: null }), '1. archive DRAFT', 'Chỉ lưu trữ')
    mustT(await svc.from('kpi_campaigns').update({ status: 'active' }).eq('id', id), 'set active')
    expectRaise(await svc.rpc('rpc_archive_kpi_campaign', { p_campaign_id: id, p_actor: null }), '2. archive ACTIVE', 'tạm dừng trước')

    mustT(await svc.from('kpi_campaigns').update({ status: 'paused' }).eq('id', id), 'set paused')
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
    console.log('   snapshot bảng con TRƯỚC archive:', before.length, 'bytes (select *, canonical-sort)')

    expectOk(await svc.rpc('rpc_archive_kpi_campaign', { p_campaign_id: id, p_actor: null }), '4. archive PAUSED')
    expectRaise(await svc.rpc('rpc_archive_kpi_campaign', { p_campaign_id: id, p_actor: null }), '5. archive lần 2', 'đã được lưu trữ')

    const after = await childSnapshot(id)
    if (before === after) console.log('PASS: 6. bảng con NGUYÊN VẸN NỘI DUNG sau archive (deep-compare toàn bộ cột)')
    else fail('6. NỘI DUNG bảng con đổi sau archive (deep-compare khác nhau)')

    // r1.3 (điểm 11 — negative QA): cố ý hỏng để chứng minh finally-cleanup.
    if (process.env.QA_BREAK_STEP === 'yes') throw new Error('QA_BREAK_STEP — cố ý làm hỏng sau bước 6 (kiểm tra cleanup vẫn chạy)')

    expectRaise(await svc.rpc('rpc_replace_campaign_targets', {
      p_campaign_id: id, p_rows: [], p_file_name: null, p_uploaded_by: null,
    }), '7. import targets trên archived', 'đã lưu trữ')
    const row = mustT(await svc.from('kpi_campaigns').select('updated_at, archived_at').eq('id', id).single(), 'đọc updated_at')
    if (!row.data.archived_at) fail('archived_at NULL sau archive')
    expectRaise(await svc.rpc('rpc_activate_kpi_campaign', {
      p_campaign_id: id, p_expected_updated_at: row.data.updated_at,
    }), '8. activate trên archived', 'đã lưu trữ')
    expectRaise(await svc.rpc('rpc_replace_campaign_actuals', {
      p_campaign_id: id, p_daily: [], p_actuals: [],
    }), '9. ghi actuals trên archived (fix P1#1)', 'đã lưu trữ')
  } catch (e) {
    fail('exception giữa chừng', `— ${e.message}`)
  } finally {
    if (id !== null) {
      // r1.3: cleanup luôn chạy (throw không thoát process); marker chỉ mất khi DB sạch.
      const clean = await cleanupFixture(id).catch((e) => { fail('cleanup: exception', e.message); return false })
      removeMarkerIfClean(clean)
    }
  }
  console.log(failed ? '\n=== KẾT QUẢ: CÓ FAIL — xem log trên ===' : '\n=== KẾT QUẢ: PASS TOÀN BỘ 10 bước ===')
}

async function cleanup() {
  // r1.3 (điểm 6): manual cleanup CÙNG contract 3 điều kiện + validate marker.
  const m = loadMarker()
  const clean = await cleanupFixture(m.campaignId)
  removeMarkerIfClean(clean)
  if (clean) console.log('OK: đã dọn fixture', m.name, '(exact id từ marker)')
}

const cmds = { verify, run, cleanup }
if (!cmds[cmd]) { console.error('Lệnh: verify | run (cần QA_KPI_CRON_PAUSED=YES) | cleanup'); process.exitCode = 1 } else {
  try {
    await cmds[cmd]()
  } catch (e) {
    fail(cmd, `— ${e.message}`)
  }
  // r1.3: exit code đặt DUY NHẤT ở top-level sau khi mọi finally đã chạy.
  process.exitCode = failed ? 1 : 0
}
