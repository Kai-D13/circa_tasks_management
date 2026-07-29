// QA executable cho migration 099 (Affiliate Orders drill-down) — chạy từ
// webapp/. Đọc URL + keys từ .env.local. KHÔNG in secret; password role qua
// env QA_PASSWORD (không positional arg). Fixture 55 đơn DELIVERED id cố định
// (54 dương + 1 ÂM — rule LOCK) trên 1 store OS → test cả phân trang >50.
// Cleanup theo EXACT id range. FAIL-FAST.
//
//   node scripts/qa-affiliate-orders-099.mjs verify        # migration record + RPC tồn tại
//   node scripts/qa-affiliate-orders-099.mjs fixture-up    # 55 đơn QA vào store POS0059
//   $env:QA_PASSWORD='...'; node scripts/qa-affiliate-orders-099.mjs check <email>
//   node scripts/qa-affiliate-orders-099.mjs fixture-down  # xóa exact ids + verify
//
// `check <email>` tự tính KỲ VỌNG theo profile account rồi assert:
//   a. DIRECT TABLE select customer_phone → super: >0 row · MỌI role khác: 0 row
//      (fix P1#2 — trước 099 staff/QLCH/SM own-scope đọc được PII).
//   b. RPC store QA (POS0059): super/OPS-granted → rows; SM → rows nếu được
//      phân công store đó, ngược lại lỗi; QLCH → rows nếu đúng store mình,
//      ngược lại lỗi; staff/admin thường → lỗi.
//   c. Nếu được phép: WALK trang 1 (50) + trang 2 (5) — không trùng/sót id;
//      COUNT + SUM(total_price) khớp TUYỆT ĐỐI rpc_aggregate_affiliate_gmv
//      (gồm đơn âm).
//   d. Range guard: from>to → lỗi; span 367 ngày → lỗi.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = {}
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m) env[m[1]] = m[2]
}
for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!env[k]) { console.error('FAIL: thiếu', k, 'trong .env.local'); process.exit(1) }
}
const URL = env.NEXT_PUBLIC_SUPABASE_URL
const svc = createClient(URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY

const QA_STORE_CODE = 'POS0059'
const N = 55
const FIX_BASE = 999910000 // order_id 999910001..999910055
const FIX_IDS = Array.from({ length: N }, (_, i) => FIX_BASE + i + 1)
const FROM = '2026-06-01'
const TO = '2026-06-30'
// timestamptz range VN [from 00:00, day-after-to 00:00) — mirror vnDayRange
const RANGE = { from: '2026-05-31T17:00:00.000Z', to: '2026-06-30T17:00:00.000Z' }
const [cmd, email] = process.argv.slice(2)
let failed = false

function must(res, label) {
  if (res.error) { console.error('FAIL:', label, '—', res.error.message); process.exit(1) }
  return res
}
function assert(ok, label, detail = '') {
  if (ok) console.log('PASS:', label)
  else { console.error('FAIL:', label, detail); failed = true }
}

async function qaStoreId() {
  const st = must(await svc.from('stores').select('id').eq('code', QA_STORE_CODE).single(), `đọc store ${QA_STORE_CODE}`)
  return st.data.id
}

async function verify() {
  const mig = must(await svc.from('app_migrations').select('version, name').eq('version', '099'), 'đọc app_migrations')
  if (mig.data.length !== 1) { console.error('FAIL: app_migrations chưa có 099'); process.exit(1) }
  console.log('PASS: app_migrations 099 =', JSON.stringify(mig.data[0]))
  // RPC tồn tại: gọi với range sai → phải RAISE range (service ctx chưa tới scope check)
  const r = await svc.rpc('rpc_list_affiliate_orders', {
    p_store_id: '00000000-0000-0000-0000-000000000000',
    p_from: RANGE.to, p_to: RANGE.from, p_limit: 1,
    p_cursor_completed_time: null, p_cursor_id: null,
  })
  assert(!!r.error && r.error.message.includes('from phải trước to'), 'RPC tồn tại + range guard from>=to hoạt động', r.error?.message ?? '(gọi được?!)')
  console.log('NHẮC: check policy qual/grants/index bằng SQL trong docs/qa-runbook-098-099.md')
  process.exit(failed ? 1 : 0)
}

async function fixtureUp() {
  const sid = await qaStoreId()
  const rows = FIX_IDS.map((oid, i) => ({
    order_id: oid,
    order_code: `QA-DRILL-${i + 1}`,
    pos_order_code: `DHCQA${String(i + 1).padStart(4, '0')}`,
    partner_code: 'QA-DRILL',
    store_id: sid,
    raw_status: 'DELIVERED',
    status_norm: 'delivered',
    sale_order_status: 'COMPLETED',
    // 54 đơn dương + đơn cuối ÂM (hoàn/hủy một phần — rule LOCK giữ nguyên âm)
    total_price: i === N - 1 ? -50000 : 100000 + i * 1000,
    total_item: 1,
    customer_name: `QA Khách ${i + 1}`,
    customer_phone: `09000${String(i + 1).padStart(5, '0')}`,
    created_time: `2026-06-${String((i % 28) + 1).padStart(2, '0')}T03:00:00Z`,
    completed_time: `2026-06-${String((i % 28) + 1).padStart(2, '0')}T05:00:00Z`,
    source_active: true,
  }))
  must(await svc.from('affiliate_orders').insert(rows), 'insert 55 đơn fixture')
  const sum = rows.reduce((s, r) => s + r.total_price, 0)
  console.log(`OK: 55 đơn QA vào ${QA_STORE_CODE} (${FIX_IDS[0]}..${FIX_IDS[N - 1]}) · SUM=${sum} (có 1 đơn ÂM -50000)`)
}

async function check() {
  const password = process.env.QA_PASSWORD
  if (!email || !password) {
    console.error("Cách dùng (PowerShell): $env:QA_PASSWORD='...'; node scripts/qa-affiliate-orders-099.mjs check <email>")
    process.exit(1)
  }
  const sid = await qaStoreId()
  const anon = createClient(URL, anonKey, { auth: { persistSession: false } })
  const login = await anon.auth.signInWithPassword({ email, password })
  if (login.error) { console.error('FAIL: login —', login.error.message); process.exit(1) }
  const c = createClient(URL, anonKey, {
    global: { headers: { Authorization: 'Bearer ' + login.data.session.access_token } },
    auth: { persistSession: false },
  })

  // Kỳ vọng theo profile (đọc bằng service — dữ liệu tin cậy)
  const prof = must(await svc.from('users').select('id, role, email, department_id, store_id').eq('email', email).single(), 'đọc profile')
  const p = prof.data
  const superEmails = ['hoangvudn96@gmail.com', 'vu.nguyenhoang@buymed.com'] // allowlist app-layer; DB check = is_super_admin()
  const isSuper = p.role === 'admin' && superEmails.includes((p.email ?? '').toLowerCase())
  const opsGranted = p.role === 'admin' && p.department_id
    ? (must(await svc.from('affiliate_department_access').select('department_id').eq('department_id', p.department_id), 'đọc dept grant')).data.length > 0
    : false
  const smAssigned = p.role === 'sm'
    ? (must(await svc.from('sm_store_assignments').select('store_id').eq('sm_user_id', p.id).eq('store_id', sid), 'đọc sm assignment')).data.length > 0
    : false
  const expectRpcAllowed = isSuper || (opsGranted && !isSuper) || smAssigned || (p.role === 'store_manager' && p.store_id === sid)
  console.log(`account: ${email} | role: ${p.role} | super: ${isSuper} | opsGranted: ${opsGranted} | smAssigned(${QA_STORE_CODE}): ${smAssigned}`)

  // a. DIRECT TABLE PII — super duy nhất
  const direct = await c.from('affiliate_orders').select('customer_phone').in('order_id', FIX_IDS)
  const directCount = direct.error ? -1 : direct.data.length
  assert(isSuper ? directCount === N : directCount === 0,
    `a. direct select customer_phone → ${isSuper ? N : 0} row (thực tế: ${directCount})`)

  // b+c. RPC store QA
  const page1 = await c.rpc('rpc_list_affiliate_orders', {
    p_store_id: sid, p_from: RANGE.from, p_to: RANGE.to, p_limit: 50,
    p_cursor_completed_time: null, p_cursor_id: null,
  })
  if (!expectRpcAllowed) {
    assert(!!page1.error, `b. RPC ${QA_STORE_CODE} PHẢI bị từ chối (role ${p.role})`, page1.error ? '' : '→ GỌI ĐƯỢC!')
  } else {
    assert(!page1.error && page1.data.length === 50, `b. RPC trang 1 = 50 đơn (thực tế: ${page1.error ? page1.error.message : page1.data.length})`)
    if (!page1.error) {
      const last = page1.data[page1.data.length - 1]
      const page2 = await c.rpc('rpc_list_affiliate_orders', {
        p_store_id: sid, p_from: RANGE.from, p_to: RANGE.to, p_limit: 50,
        p_cursor_completed_time: last.completed_time, p_cursor_id: last.id,
      })
      assert(!page2.error && page2.data.length === N - 50, `c1. trang 2 = ${N - 50} đơn (thực tế: ${page2.error ? page2.error.message : page2.data.length})`)
      const all = [...page1.data, ...(page2.data ?? [])]
      const uniq = new Set(all.map((r) => r.id))
      assert(uniq.size === N, `c2. ${N} id duy nhất qua 2 trang — không trùng/sót (thực tế: ${uniq.size})`)
      const sum = all.reduce((s, r) => s + Number(r.total_price), 0)
      const agg = must(await svc.rpc('rpc_aggregate_affiliate_gmv', { p_store_ids: [sid], p_from: RANGE.from, p_to: RANGE.to }), 'aggregate đối chiếu')
      const expGmv = agg.data.reduce((s, r) => s + Number(r.gmv), 0)
      const expCnt = agg.data.reduce((s, r) => s + Number(r.order_count), 0)
      assert(all.length === expCnt && Math.abs(sum - expGmv) < 0.005,
        `c3. đối soát parent-child: COUNT ${all.length}==${expCnt} & SUM ${sum}==${expGmv} (gồm đơn âm)`)
    }
    // d. range guard qua session được phép
    const bad1 = await c.rpc('rpc_list_affiliate_orders', { p_store_id: sid, p_from: RANGE.to, p_to: RANGE.from, p_limit: 1, p_cursor_completed_time: null, p_cursor_id: null })
    assert(!!bad1.error, 'd1. from>to → bị chặn')
    const bad2 = await c.rpc('rpc_list_affiliate_orders', { p_store_id: sid, p_from: '2025-06-01T00:00:00Z', p_to: '2026-06-30T00:00:00Z', p_limit: 1, p_cursor_completed_time: null, p_cursor_id: null })
    assert(!!bad2.error && bad2.error.message.includes('366'), 'd2. span >366 ngày → bị chặn')
  }

  console.log(failed ? '\n=== KẾT QUẢ: CÓ FAIL ===' : '\n=== KẾT QUẢ: PASS TOÀN BỘ cho account này ===')
  process.exit(failed ? 1 : 0)
}

async function fixtureDown() {
  const del = must(await svc.from('affiliate_orders').delete().in('order_id', FIX_IDS).select('order_id'), 'xóa fixture')
  const left = must(await svc.from('affiliate_orders').select('*', { count: 'exact', head: true }).in('order_id', FIX_IDS), 'verify sạch')
  console.log(`OK: đã xóa ${del.data.length} đơn QA · còn lại trong range fixture: ${left.count}`)
}

const cmds = { verify, 'fixture-up': fixtureUp, check, 'fixture-down': fixtureDown }
if (!cmds[cmd]) { console.error('Lệnh: verify | fixture-up | check <email> (QA_PASSWORD qua env) | fixture-down'); process.exit(1) }
await cmds[cmd]()
