// QA role-matrix RLS cho affiliate_orders (F1 gate) — chạy từ thư mục webapp/.
// Đọc URL + keys từ .env.local. KHÔNG in secret. Fixture 4 đơn ID cố định;
// cleanup theo EXACT IDs (audit P2 — không range delete).
// r1 (P2 audit F1-close): FAIL-FAST — mọi query lỗi in FAIL + exit 1, không
// bao giờ in "0 đơn" khi thực chất query lỗi; password qua ENV `QA_PASSWORD`,
// KHÔNG nhận qua positional argument (tránh lộ vào shell history).
//
//   node scripts/qa-affiliate-rls.mjs status          # đếm bảng + fixture hiện có
//   node scripts/qa-affiliate-rls.mjs fixture-up      # tạo 4 đơn QA (OS-A TAMVIET / OS-B CENTRAL / FS HB2 / EXTERNAL)
//   $env:QA_PASSWORD='...'; node scripts/qa-affiliate-rls.mjs check <email>
//   node scripts/qa-affiliate-rls.mjs grant-ops       # cấp quyền dept OPS (ghi pre-state vào .qa-ops-grant.json)
//   node scripts/qa-affiliate-rls.mjs revoke-ops      # khôi phục ĐÚNG pre-state (không xóa grant có sẵn từ trước)
//   node scripts/qa-affiliate-rls.mjs fixture-down    # xóa 4 đơn QA theo exact IDs + verify bảng về 0
//
// KỲ VỌNG (fixture-up xong):
//   super admin                     → 4 đơn: QA-OS-A, QA-OS-B, QA-FS, QA-EXT
//   admin thường (CHƯA grant OPS)   → 0 đơn
//   admin dept OPS (SAU grant-ops)  → 2 đơn: QA-OS-A, QA-OS-B (không FS/external)
//   SM                              → chỉ đơn OS thuộc store phụ trách
//   store_manager OS                → chỉ đơn store mình
//   staff/store_manager FS          → 0 đơn
//   Mọi role: rpc_start_affiliate_sync → 'permission denied'
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

const FIX_IDS = [999900001, 999900002, 999900003, 999900004]
const OPS_DEPT = '1b362298-7121-4604-9192-4a9ca2bb545f'
const MARKER = '.qa-ops-grant.json'
const [cmd, email] = process.argv.slice(2)

// Fail-fast: query lỗi → in FAIL + exit 1 (không đọc nhầm lỗi thành "0 đơn").
function must(res, label) {
  if (res.error) {
    console.error('FAIL:', label, '—', res.error.message)
    process.exit(1)
  }
  return res
}

async function status() {
  const o = must(await svc.from('affiliate_orders').select('*', { count: 'exact', head: true }), 'đếm affiliate_orders')
  const f = must(await svc.from('affiliate_orders').select('order_id', { count: 'exact', head: true }).in('order_id', FIX_IDS), 'đếm fixture')
  const r = must(await svc.from('affiliate_sync_runs').select('*', { count: 'exact', head: true }).eq('status', 'running'), 'đếm running')
  const g = must(await svc.from('affiliate_department_access').select('department_id'), 'đọc dept grants')
  console.log('affiliate_orders total:', o.count, '| fixture QA:', f.count, '| running runs:', r.count)
  console.log('dept grants hiện có:', JSON.stringify(g.data))
}

async function fixtureUp() {
  const st = must(await svc.from('stores').select('id, code').in('code', ['POS0059', 'POS0009', 'POS0088']), 'đọc stores')
  const by = Object.fromEntries(st.data.map((s) => [s.code, s.id]))
  for (const c of ['POS0059', 'POS0009', 'POS0088']) {
    if (!by[c]) { console.error('FAIL: thiếu store', c); process.exit(1) }
  }
  const now = new Date().toISOString()
  const rows = [
    { order_id: FIX_IDS[0], order_code: 'QA-OS-A(TAMVIET)', store_id: by.POS0059 },
    { order_id: FIX_IDS[1], order_code: 'QA-OS-B(CENTRAL)', store_id: by.POS0009 },
    { order_id: FIX_IDS[2], order_code: 'QA-FS(HOABINH2)', store_id: by.POS0088 },
    { order_id: FIX_IDS[3], order_code: 'QA-EXTERNAL', store_id: null },
  ].map((r) => ({ ...r, partner_code: 'QA-TEST', raw_status: 'DELIVERED', status_norm: 'delivered', total_price: 1000, created_time: now }))
  must(await svc.from('affiliate_orders').insert(rows), 'insert fixture')
  console.log('OK: đã tạo 4 đơn QA (' + FIX_IDS.join(', ') + ')')
}

async function check() {
  const password = process.env.QA_PASSWORD
  if (!email || !password) {
    console.error('Cách dùng (PowerShell):  $env:QA_PASSWORD=\'...\'; node scripts/qa-affiliate-rls.mjs check <email>')
    console.error('           (bash):       QA_PASSWORD=\'...\' node scripts/qa-affiliate-rls.mjs check <email>')
    process.exit(1)
  }
  const anon = createClient(URL, anonKey, { auth: { persistSession: false } })
  const login = await anon.auth.signInWithPassword({ email, password })
  if (login.error) { console.error('FAIL: login —', login.error.message); process.exit(1) }
  const c = createClient(URL, anonKey, {
    global: { headers: { Authorization: 'Bearer ' + login.data.session.access_token } },
    auth: { persistSession: false },
  })
  const prof = must(await svc.from('users').select('role, department_id, store_id, stores!users_store_id_fkey(code, store_type)').eq('email', email).single(), 'đọc profile')
  console.log('account:', email, '| role:', prof.data?.role, '| store:', prof.data?.stores?.code ?? '(none)', prof.data?.stores?.store_type ?? '', '| dept:', prof.data?.department_id ?? '(none)')
  const rows = must(await c.from('affiliate_orders').select('order_code').in('order_id', FIX_IDS).order('order_id'), 'SELECT affiliate_orders theo RLS')
  console.log('THẤY', rows.data.length, 'đơn:', rows.data.map((x) => x.order_code).join(', ') || '(không đơn nào)')
  const rpc = await c.rpc('rpc_start_affiliate_sync')
  if (!rpc.error) { console.error('FAIL: rpc_start GỌI ĐƯỢC (' + rpc.data + ') — permission chưa siết!'); process.exit(1) }
  console.log('gọi rpc_start: BỊ CHẶN ✓ (' + rpc.error.message.slice(0, 45) + ')')
}

async function grantOps() {
  const pre = must(await svc.from('affiliate_department_access').select('department_id').eq('department_id', OPS_DEPT), 'đọc pre-state')
  const existed = pre.data.length > 0
  fs.writeFileSync(MARKER, JSON.stringify({ existedBefore: existed, at: new Date().toISOString() }))
  if (existed) { console.log('OPS đã được cấp TỪ TRƯỚC — không thay đổi gì (revoke-ops sẽ KHÔNG xóa).'); return }
  must(await svc.from('affiliate_department_access').insert({ department_id: OPS_DEPT }), 'insert grant OPS')
  console.log('OK: đã cấp quyền dept OPS (pre-state: chưa có → revoke-ops sẽ xóa lại).')
}

async function revokeOps() {
  if (!fs.existsSync(MARKER)) { console.error('FAIL: không có pre-state (.qa-ops-grant.json) — chạy grant-ops trước, không tự ý xóa.'); process.exit(1) }
  const pre = JSON.parse(fs.readFileSync(MARKER, 'utf8'))
  if (pre.existedBefore) {
    console.log('Grant OPS tồn tại từ trước test — GIỮ NGUYÊN theo pre-state.')
  } else {
    const del = must(await svc.from('affiliate_department_access').delete().eq('department_id', OPS_DEPT).select(), 'xóa grant OPS')
    console.log('OK: đã khôi phục pre-state (xóa grant OPS, deleted=' + del.data.length + ')')
  }
  fs.unlinkSync(MARKER)
}

async function fixtureDown() {
  const del = must(await svc.from('affiliate_orders').delete().in('order_id', FIX_IDS).select(), 'xóa fixture')
  console.log('OK: đã xóa ' + del.data.length + ' đơn QA theo exact IDs')
  const o = must(await svc.from('affiliate_orders').select('*', { count: 'exact', head: true }), 'đếm lại orders')
  const r = must(await svc.from('affiliate_sync_runs').select('*', { count: 'exact', head: true }).eq('status', 'running'), 'đếm running')
  console.log('verify: affiliate_orders =', o.count, '| running =', r.count)
}

const cmds = { status, 'fixture-up': fixtureUp, check, 'grant-ops': grantOps, 'revoke-ops': revokeOps, 'fixture-down': fixtureDown }
if (!cmds[cmd]) { console.error('Lệnh: status | fixture-up | check <email> (QA_PASSWORD qua env) | grant-ops | revoke-ops | fixture-down'); process.exit(1) }
await cmds[cmd]()
