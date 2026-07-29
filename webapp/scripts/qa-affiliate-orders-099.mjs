// QA executable cho migration 099 (Affiliate Orders drill-down) — chạy từ
// webapp/. Đọc URL + keys từ .env.local (PRODUCTION — fixture phải TỰ CÔ LẬP).
// KHÔNG in secret; password role qua env QA_PASSWORD.
//
// r1.2 (audit — an toàn production):
//   · ID fixture ĐỘNG mỗi run (base ngẫu nhiên 9.9e12) + MARKER local
//     (.qa-drill-fixture.json) ghi TRƯỚC khi insert — cleanup CHỈ xóa đúng
//     các id trong marker, không marker thì KHÔNG xóa gì.
//   · Preflight BẮT BUỘC trước insert: (a) marker chưa tồn tại; (b) 0 row
//     trùng dải id; (c) BASELINE = 0 đơn delivered+active của store trong
//     cửa sổ QA (cửa sổ RETRO 02/2024 — trước khi chương trình Affiliate
//     tồn tại) → đơn production không bao giờ lọt vào COUNT/SUM/phân trang.
//   · Sau insert: verify ĐỦ 55 id thuộc marker rồi mới cho chạy role matrix.
//   · ⚠ TẠM DỪNG cron pull-affiliate-orders (Coolify) trong lúc fixture tồn
//     tại — full-snapshot reconciliation sẽ đánh dấu source_active=false các
//     đơn không có trong nguồn. fixture-up sẽ in nhắc.
//   · Expected Super lấy từ CHÍNH session đang test qua RPC is_super_admin()
//     (một nguồn chân lý — không duy trì allowlist email thứ hai).
//   · Role bị từ chối: assert đúng message 'Không có quyền'.
//   · FS scope: Super gọi được (0 đơn vẫn OK), OPS/SM/QLCH/Staff bị từ chối.
//
//   node scripts/qa-affiliate-orders-099.mjs verify        # migration record + RPC + range guard
//   node scripts/qa-affiliate-orders-099.mjs fixture-up    # preflight + 55 đơn QA (54 dương + 1 ÂM)
//   $env:QA_PASSWORD='...'; node scripts/qa-affiliate-orders-099.mjs check <email>
//   node scripts/qa-affiliate-orders-099.mjs fixture-down  # chỉ theo marker + verify sạch
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
const MARKER = '.qa-drill-fixture.json'
// Cửa sổ RETRO 02/2024 — trước khi Affiliate tồn tại (chương trình bắt đầu
// 07/2026) → baseline production = 0 đơn; preflight vẫn XÁC NHẬN lại số 0 đó.
const FROM_D = '2024-02-01'
const TO_D = '2024-02-29'
const RANGE = { from: '2024-01-31T17:00:00.000Z', to: '2024-02-29T17:00:00.000Z' } // [from 00:00 VN, day-after-to 00:00 VN)
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
function assertDenied(res, label) {
  // r1.2: từ chối phải ĐÚNG message authz của RPC — không nhận error bất kỳ
  // (lỗi hạ tầng/param không được tính là "đã chặn đúng").
  assert(!!res.error && res.error.message.includes('Không có quyền'), label,
    res.error ? `(error khác kỳ vọng: ${res.error.message})` : '→ GỌI ĐƯỢC!')
}
function loadMarker() {
  if (!fs.existsSync(MARKER)) { console.error('FAIL: chưa có marker', MARKER, '— chạy fixture-up trước.'); process.exit(1) }
  return JSON.parse(fs.readFileSync(MARKER, 'utf8'))
}

async function qaStoreId() {
  const st = must(await svc.from('stores').select('id').eq('code', QA_STORE_CODE).single(), `đọc store ${QA_STORE_CODE}`)
  return st.data.id
}

async function verify() {
  const mig = must(await svc.from('app_migrations').select('version, name').eq('version', '099'), 'đọc app_migrations')
  if (mig.data.length !== 1) { console.error('FAIL: app_migrations chưa có 099'); process.exit(1) }
  console.log('PASS: app_migrations 099 =', JSON.stringify(mig.data[0]))
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
  // Preflight (a): không chồng fixture cũ.
  if (fs.existsSync(MARKER)) {
    console.error('FAIL: marker', MARKER, 'đang tồn tại — fixture trước chưa dọn (fixture-down trước).')
    process.exit(1)
  }
  const sid = await qaStoreId()
  // ID động mỗi run — base ngẫu nhiên vùng 9.9e12 (bigint, ngoài mọi order_id thật).
  const base = 9_900_000_000_000 + Math.floor(Math.random() * 1_000_000_000)
  const ids = Array.from({ length: N }, (_, i) => base + i + 1)
  // Preflight (b): dải id phải TRỐNG.
  const clash = must(await svc.from('affiliate_orders').select('order_id', { count: 'exact', head: true }).in('order_id', ids), 'preflight dải id')
  if (clash.count !== 0) { console.error(`FAIL: dải id đã có ${clash.count} row — ABORT, không insert, không cleanup.`); process.exit(1) }
  // Preflight (c): BASELINE cửa sổ QA phải = 0 đơn delivered+active của store.
  const base0 = must(await svc.from('affiliate_orders')
    .select('order_id', { count: 'exact', head: true })
    .eq('store_id', sid).eq('status_norm', 'delivered').eq('source_active', true)
    .gte('completed_time', RANGE.from).lt('completed_time', RANGE.to), 'preflight baseline cửa sổ QA')
  if (base0.count !== 0) {
    console.error(`FAIL: baseline cửa sổ ${FROM_D}..${TO_D} của ${QA_STORE_CODE} = ${base0.count} đơn (kỳ vọng 0) — chọn cửa sổ khác, ABORT.`)
    process.exit(1)
  }
  // Marker ghi TRƯỚC khi insert (audit r1.2 điểm 1) — cleanup luôn biết đúng dải.
  fs.writeFileSync(MARKER, JSON.stringify({ ids, storeId: sid, storeCode: QA_STORE_CODE, from: FROM_D, to: TO_D, range: RANGE, at: new Date().toISOString() }))

  const rows = ids.map((oid, i) => ({
    order_id: oid,
    order_code: `QA-DRILL-${i + 1}`,
    pos_order_code: `DHCQA${String(i + 1).padStart(4, '0')}`,
    partner_code: 'QA-DRILL',
    store_id: sid,
    raw_status: 'DELIVERED',
    status_norm: 'delivered',
    sale_order_status: 'COMPLETED',
    total_price: i === N - 1 ? -50000 : 100000 + i * 1000, // 54 dương + 1 ÂM (rule LOCK)
    total_item: 1,
    customer_name: `QA Khách ${i + 1}`,
    customer_phone: `09000${String(i + 1).padStart(5, '0')}`,
    created_time: `2024-02-${String((i % 28) + 1).padStart(2, '0')}T03:00:00Z`,
    completed_time: `2024-02-${String((i % 28) + 1).padStart(2, '0')}T05:00:00Z`,
    source_active: true,
  }))
  must(await svc.from('affiliate_orders').insert(rows), 'insert 55 đơn fixture')
  // Verify sau insert: ĐỦ 55 id thuộc marker rồi mới cho check.
  const chk = must(await svc.from('affiliate_orders').select('order_id', { count: 'exact', head: true }).in('order_id', ids), 'verify sau insert')
  if (chk.count !== N) { console.error(`FAIL: sau insert chỉ thấy ${chk.count}/${N} id — kiểm tra rồi fixture-down.`); process.exit(1) }
  const sum = rows.reduce((s, r) => s + r.total_price, 0)
  console.log(`OK: ${N} đơn QA vào ${QA_STORE_CODE}, cửa sổ ${FROM_D}..${TO_D} (id ${ids[0]}..${ids[N - 1]}) · SUM=${sum} (1 đơn ÂM -50000)`)
  console.log('⚠ NHẮC: TẠM DỪNG Coolify cron pull-affiliate-orders tới khi fixture-down xong (full-snapshot sẽ vô hiệu fixture).')
}

async function check() {
  const password = process.env.QA_PASSWORD
  if (!email || !password) {
    console.error("Cách dùng (PowerShell): $env:QA_PASSWORD='...'; node scripts/qa-affiliate-orders-099.mjs check <email>")
    process.exit(1)
  }
  const mk = loadMarker()
  const ids = mk.ids
  const sid = mk.storeId
  const range = mk.range
  const anon = createClient(URL, anonKey, { auth: { persistSession: false } })
  const login = await anon.auth.signInWithPassword({ email, password })
  if (login.error) { console.error('FAIL: login —', login.error.message); process.exit(1) }
  const c = createClient(URL, anonKey, {
    global: { headers: { Authorization: 'Bearer ' + login.data.session.access_token } },
    auth: { persistSession: false },
  })

  // r1.2: Super lấy từ CHÍNH session qua SECDEF helper — một nguồn chân lý,
  // không allowlist email thứ hai trong script.
  const superRes = await c.rpc('is_super_admin')
  if (superRes.error) { console.error('FAIL: gọi is_super_admin() —', superRes.error.message); process.exit(1) }
  const isSuper = superRes.data === true

  const prof = must(await svc.from('users').select('id, role, department_id, store_id').eq('email', email).single(), 'đọc profile')
  const p = prof.data
  const opsGranted = !isSuper && p.role === 'admin' && p.department_id
    ? (must(await svc.from('affiliate_department_access').select('department_id').eq('department_id', p.department_id), 'đọc dept grant')).data.length > 0
    : false
  const smAssigned = p.role === 'sm'
    ? (must(await svc.from('sm_store_assignments').select('store_id').eq('sm_user_id', p.id).eq('store_id', sid), 'đọc sm assignment')).data.length > 0
    : false
  const expectRpcAllowed = isSuper || opsGranted || smAssigned || (p.role === 'store_manager' && p.store_id === sid)
  console.log(`account: ${email} | role: ${p.role} | is_super_admin(): ${isSuper} | opsGranted: ${opsGranted} | smAssigned(${mk.storeCode}): ${smAssigned} → RPC kỳ vọng: ${expectRpcAllowed ? 'CHO PHÉP' : 'TỪ CHỐI'}`)

  // a. DIRECT TABLE PII — chỉ super
  const direct = await c.from('affiliate_orders').select('customer_phone').in('order_id', ids)
  const directCount = direct.error ? -1 : direct.data.length
  assert(isSuper ? directCount === N : directCount === 0,
    `a. direct select customer_phone → ${isSuper ? N : 0} row (thực tế: ${directCount})`)

  // b+c. RPC store QA
  const page1 = await c.rpc('rpc_list_affiliate_orders', {
    p_store_id: sid, p_from: range.from, p_to: range.to, p_limit: 50,
    p_cursor_completed_time: null, p_cursor_id: null,
  })
  if (!expectRpcAllowed) {
    assertDenied(page1, `b. RPC ${mk.storeCode} bị từ chối đúng message (role ${p.role})`)
  } else {
    assert(!page1.error && page1.data.length === 50, `b. RPC trang 1 = 50 đơn (thực tế: ${page1.error ? page1.error.message : page1.data.length})`)
    if (!page1.error) {
      const last = page1.data[page1.data.length - 1]
      const page2 = await c.rpc('rpc_list_affiliate_orders', {
        p_store_id: sid, p_from: range.from, p_to: range.to, p_limit: 50,
        p_cursor_completed_time: last.completed_time, p_cursor_id: last.id,
      })
      assert(!page2.error && page2.data.length === N - 50, `c1. trang 2 = ${N - 50} đơn (thực tế: ${page2.error ? page2.error.message : page2.data.length})`)
      const all = [...page1.data, ...(page2.data ?? [])]
      const uniq = new Set(all.map((r) => r.id))
      assert(uniq.size === N, `c2. ${N} id duy nhất qua 2 trang — không trùng/sót (thực tế: ${uniq.size})`)
      const sum = all.reduce((s, r) => s + Number(r.total_price), 0)
      const agg = must(await svc.rpc('rpc_aggregate_affiliate_gmv', { p_store_ids: [sid], p_from: range.from, p_to: range.to }), 'aggregate đối chiếu')
      const expGmv = agg.data.reduce((s, r) => s + Number(r.gmv), 0)
      const expCnt = agg.data.reduce((s, r) => s + Number(r.order_count), 0)
      assert(all.length === expCnt && Math.abs(sum - expGmv) < 0.005,
        `c3. đối soát parent-child: COUNT ${all.length}==${expCnt} & SUM ${sum}==${expGmv} (gồm đơn âm)`)
    }
    // d. range guard qua session được phép
    const bad1 = await c.rpc('rpc_list_affiliate_orders', { p_store_id: sid, p_from: range.to, p_to: range.from, p_limit: 1, p_cursor_completed_time: null, p_cursor_id: null })
    assert(!!bad1.error && bad1.error.message.includes('from phải trước to'), 'd1. from>to → bị chặn đúng message')
    const bad2 = await c.rpc('rpc_list_affiliate_orders', { p_store_id: sid, p_from: '2023-01-01T00:00:00Z', p_to: '2024-02-29T00:00:00Z', p_limit: 1, p_cursor_completed_time: null, p_cursor_id: null })
    assert(!!bad2.error && bad2.error.message.includes('366'), 'd2. span >366 ngày → bị chặn')
  }

  // e. FS scope (r1.2 điểm 9): Super gọi được (0 đơn vẫn hợp lệ); mọi role khác từ chối.
  const fsStore = await svc.from('stores').select('id, code').eq('store_type', 'fs').limit(1).maybeSingle()
  if (fsStore.error || !fsStore.data) {
    console.log('SKIP: e. không có store FS trong DB — bỏ qua check FS scope')
  } else {
    const fsRes = await c.rpc('rpc_list_affiliate_orders', {
      p_store_id: fsStore.data.id, p_from: range.from, p_to: range.to, p_limit: 1,
      p_cursor_completed_time: null, p_cursor_id: null,
    })
    if (isSuper) assert(!fsRes.error, `e. FS ${fsStore.data.code}: super gọi được (${fsRes.error ? fsRes.error.message : `${fsRes.data.length} đơn — 0 vẫn hợp lệ`})`)
    else assertDenied(fsRes, `e. FS ${fsStore.data.code}: role ${p.role} bị từ chối đúng message`)
  }

  console.log(failed ? '\n=== KẾT QUẢ: CÓ FAIL ===' : '\n=== KẾT QUẢ: PASS TOÀN BỘ cho account này ===')
  process.exit(failed ? 1 : 0)
}

async function fixtureDown() {
  // r1.2: CHỈ xóa đúng ids trong marker — không marker, không xóa gì.
  const mk = loadMarker()
  const del = must(await svc.from('affiliate_orders').delete().in('order_id', mk.ids).select('order_id'), 'xóa fixture theo marker')
  const left = must(await svc.from('affiliate_orders').select('*', { count: 'exact', head: true }).in('order_id', mk.ids), 'verify sạch')
  if (left.count !== 0) { console.error(`FAIL: còn ${left.count} row trong dải marker sau khi xóa`); process.exit(1) }
  fs.unlinkSync(MARKER)
  console.log(`OK: đã xóa ${del.data.length} đơn QA (exact ids từ marker) · verify 0 row còn lại · marker đã gỡ`)
  console.log('NHẮC: bật lại Coolify cron pull-affiliate-orders nếu đã tạm dừng.')
}

const cmds = { verify, 'fixture-up': fixtureUp, check, 'fixture-down': fixtureDown }
if (!cmds[cmd]) { console.error('Lệnh: verify | fixture-up | check <email> (QA_PASSWORD qua env) | fixture-down'); process.exit(1) }
await cmds[cmd]()
