// QA THỰC THI cho migration 103 + 104 (Affiliate Customer Campaign).
// ⚠ IDENTITY (contract 09/08, mig 104) = customer_phone_norm (buyer phone
// chuẩn hóa), KHÔNG phải account_id. Chạy SAU khi 103+104 apply. Khối
// AGGREGATE + ACTIVATION identity-gate yêu cầu backfill customer_phone_norm
// đã xong (sau deploy + full sync) — chưa xong → PENDING (exit ≠0, không tính
// ALL PASS; pattern r1.1 của 093). Các khối RPC-branch/targets/overlap/grants
// chạy được ngay sau migration.
//   cd webapp && node scripts/qa-kpi-customer-103.mjs
//
// ── SAFETY GATES (audit r1 P0/P1 + r1.1) — script GHI vào bảng production ──
// 3 biến an toàn CHỈ đọc từ PROCESS ENV (r1.1 P1#1 — KHÔNG đọc .env.local:
// biến nằm lại trong file sau lần QA đầu sẽ vô hiệu cơ chế opt-in TỪNG LẦN
// chạy; .env.local chỉ giữ URL/key kết nối). Thiếu → exit 2 TRƯỚC mọi thao
// tác ghi. Chạy bằng biến tạm PowerShell rồi XÓA ngay sau QA:
//   $env:QA_KPI_CUSTOMER_FIXTURE_ALLOWED='YES'
//   $env:QA_AFFILIATE_CRON_PAUSED='YES'          # đã DISABLE task Pull Affiliate Orders
//   $env:QA_EXPECTED_SUPABASE_URL='<url>'        # phải TRÙNG NEXT_PUBLIC_SUPABASE_URL
//   node scripts/qa-kpi-customer-103.mjs
//   Remove-Item Env:QA_KPI_CUSTOMER_FIXTURE_ALLOWED, Env:QA_AFFILIATE_CRON_PAUSED, Env:QA_EXPECTED_SUPABASE_URL
// Tùy chọn authenticated-deny: QA_AUTH_EMAIL + QA_PASSWORD trong .env.local.
// Fixture: campaign is_test=true + đơn order_id vùng RIÊNG 999810001-999810099
// partner 'QA-103-FIXTURE', cửa sổ 01/2025 (trước mọi data thật ~06/2026 →
// assert số TUYỆT ĐỐI). An toàn chống xóa nhầm (r1 P0): preflight cả VÙNG ID
// phải trống; ID chỉ vào cleanup SAU khi insert THÀNH CÔNG; mọi DELETE kèm
// partner_code fixture — không bao giờ xóa chỉ theo ID. KHÔNG process.exit
// trong try — throw để FINALLY luôn dọn; cleanup lỗi/fixture sót → FAIL.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = {}
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m) env[m[1]] = m[2]
}
// ── SAFETY GATES (r1 P0/P1) — fail-fast TRƯỚC khi tạo client/ghi bất kỳ gì ──
const safetyGate = (ok, msg) => {
  if (!ok) { console.error('SAFETY GATE FAIL:', msg); process.exit(2) }
}
// r1.1 P1#1: CHỈ process.env — biến tạm từng lần chạy, không nằm lại file.
safetyGate(process.env.QA_KPI_CUSTOMER_FIXTURE_ALLOWED === 'YES',
  'thiếu $env:QA_KPI_CUSTOMER_FIXTURE_ALLOWED=YES (biến PROCESS tạm, KHÔNG đặt vào .env.local) — opt-in tường minh từng lần chạy')
safetyGate(process.env.QA_AFFILIATE_CRON_PAUSED === 'YES',
  'thiếu $env:QA_AFFILIATE_CRON_PAUSED=YES (biến PROCESS tạm) — DISABLE Coolify task "Pull Affiliate Orders" rồi khai báo (chống race full-snapshot)')
safetyGate(!!process.env.QA_EXPECTED_SUPABASE_URL && process.env.QA_EXPECTED_SUPABASE_URL === env.NEXT_PUBLIC_SUPABASE_URL,
  'QA_EXPECTED_SUPABASE_URL (' + (process.env.QA_EXPECTED_SUPABASE_URL ?? 'THIẾU') + ') phải TRÙNG NEXT_PUBLIC_SUPABASE_URL (' + env.NEXT_PUBLIC_SUPABASE_URL + ') — biến PROCESS tạm, xác nhận đúng project trước mọi thao tác ghi')

const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } })

let failed = 0
let pending = 0
const out = (label, ok, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL').padEnd(5), label.padEnd(70), detail)
  if (!ok) failed++
}
const pendingSkip = (label, why) => { pending++; console.log('PEND '.padEnd(5), label.padEnd(70), why) }
const skip = (label, why) => console.log('SKIP '.padEnd(5), label.padEnd(70), why)
const expectRaise = async (label, promise, msgPart) => {
  const { error } = await promise
  const ok = !!error && error.message.includes(msgPart)
  out(label, ok, error ? error.message.slice(0, 76) : 'KHÔNG lỗi (phải RAISE)')
}
const abort = (msg) => { throw new Error(`ABORT: ${msg}`) }

// Cửa sổ fixture 01/2025 (VN) — half-open như vnDayRange.
const P_FROM = '2025-01-01T00:00:00+07:00'
const P_TO = '2025-02-01T00:00:00+07:00'
const PARTNER = 'QA-103-FIXTURE' // KHÔNG tạo mapping — RPC aggregate không cần mapping (đi theo store_id)
const FX_MIN = 999810001
const FX_MAX = 999810099
let nextId = FX_MIN
const FX_IDS = [] // r1 P0: CHỈ chứa ID đã insert THÀNH CÔNG
const campaignIds = []

try {
  // ── Preflight ─────────────────────────────────────────────────────────────
  const mig = await svc.from('app_migrations').select('version').eq('version', '103').maybeSingle()
  if (!mig.data) abort('migration 103 chưa chạy (app_migrations không có 103)')
  // r1 P1: chống race — không có affiliate sync run nào đang RUNNING.
  const { count: runningCount, error: runErr } = await svc.from('affiliate_sync_runs')
    .select('id', { count: 'exact', head: true }).eq('status', 'running')
  if (runErr) abort('không đọc được affiliate_sync_runs: ' + runErr.message)
  if ((runningCount ?? 1) !== 0) abort('còn ' + runningCount + ' affiliate sync run RUNNING — chờ xong (lease 15 phút thu hồi) rồi chạy lại')
  // r1 P0: TOÀN VÙNG ID QA phải trống trước khi ghi — có row là DỪNG, không
  // ghi đè, không xóa (row đó có thể là dữ liệu thật/fixture sót — xác minh tay).
  const { data: preexisting, error: preErr } = await svc.from('affiliate_orders')
    .select('order_id, partner_code').gte('order_id', FX_MIN).lte('order_id', FX_MAX)
  if (preErr) abort('không kiểm tra được vùng ID QA: ' + preErr.message)
  if ((preexisting ?? []).length > 0) {
    abort('vùng order_id QA ' + FX_MIN + '-' + FX_MAX + ' đã có ' + preexisting.length + ' row ('
      + preexisting.slice(0, 5).map((r) => r.order_id).join(', ') + '…) — xác minh + dọn tay rồi chạy lại; script KHÔNG tự xóa')
  }
  // r1.1 P1#2: schema preflight FAIL = ABORT trước dòng ghi đầu tiên —
  // không bao giờ tạo fixture trên schema thiếu cột.
  for (const [table, col] of [
    ['affiliate_orders', 'account_id'],
    ['affiliate_orders', 'customer_phone_norm'],
    ['kpi_campaign_store_actuals', 'actual_customer_count'],
    ['kpi_campaign_store_daily_actuals', 'affiliate_customer_count'],
  ]) {
    const r = await svc.from(table).select(col).limit(1)
    if (r.error) abort('preflight schema: cột ' + table + '.' + col + ' không đọc được (103 chưa apply đủ?): ' + r.error.message)
    out(`preflight: cột ${table}.${col} tồn tại`, true, '')
  }
  // r1 (audit P1#5): preflight identity phải SCOPE ĐÚNG như RPC sẽ chạy trong
  // test — 2 fixture store + cửa sổ QA [P_FROM, P_TO). Đếm toàn bảng khiến
  // MỘT đơn thật không liên quan (đơn cũ ngoài kỳ) cũng skip cả khối
  // aggregate thành PENDING. Đo scope sau khi có sA/sB (bên dưới).
  const identityScopeCheck = async (storeIds) => {
    const { count, error } = await svc.from('affiliate_orders')
      .select('order_id', { count: 'exact', head: true })
      .eq('status_norm', 'delivered').eq('source_active', true)
      .gt('total_price', 0).not('completed_time', 'is', null)
      .in('store_id', storeIds)
      .gte('completed_time', P_FROM).lt('completed_time', P_TO)
      .is('customer_phone_norm', null)
    if (error) abort('preflight: không đếm được đơn thiếu customer_phone_norm trong scope QA: ' + error.message)
    return count ?? 1
  }

  // ── Fixture stores + campaigns ────────────────────────────────────────────
  const { data: stores } = await svc.from('stores').select('id, code')
    .eq('store_type', 'os').eq('is_active', true).order('code').limit(2)
  if (!stores || stores.length < 2) abort('không đủ 2 store os active')
  const [sA, sB] = stores
  // r1 P1#5: identity readiness ĐÚNG SCOPE test (2 store fixture × cửa sổ QA).
  const missingPhoneScoped = await identityScopeCheck([sA.id, sB.id])
  const backfillDone = missingPhoneScoped === 0
  console.log(`backfill identity (mig 104) trong SCOPE QA (${sA.code}/${sB.code} × ${P_FROM}→${P_TO}): đơn đủ điều kiện thiếu customer_phone_norm = ${missingPhoneScoped} → ${backfillDone ? 'ĐÃ xong' : 'CHƯA xong (khối aggregate sẽ PENDING)'}`)

  const mkCampaign = async (name, over = {}) => {
    const { data, error } = await svc.from('kpi_campaigns').insert({
      name, start_date: '2025-01-01', end_date: '2025-01-31', scope_type: 'store',
      metric_type: 'gmv', order_type: 'all', status: 'draft', is_test: true,
      metric_offline: true, metric_affiliate: false, ...over,
    }).select('id, updated_at').single()
    if (error) abort(`fixture campaign "${name}": ${error.message}`)
    campaignIds.push(data.id)
    return data.id
  }
  const CUSTOMER = {
    metric_type: 'affiliate_customer_count', metric_offline: false,
    metric_affiliate: true, order_type: 'online',
  }
  const importTargets = async (cid, kpiTarget) => {
    const { error } = await svc.rpc('rpc_replace_campaign_targets', {
      p_campaign_id: cid,
      p_rows: [sA, sB].map((s, i) => ({
        store_id: s.id, pos_code: s.code, kpi_target: kpiTarget,
        store_kpi_group: 'QA-103', import_row: i + 1, note: null,
        tiers: [{ tier_order: 1, threshold_pct: 90, commission_amount: 1000000 }],
      })),
      p_file_name: 'qa-103.xlsx', p_uploaded_by: null,
    })
    return error
  }
  const mkOrder = async (over) => {
    const id = nextId++
    if (id > FX_MAX) abort('vượt vùng ID QA (' + FX_MAX + ')')
    const { error } = await svc.from('affiliate_orders').insert({
      order_id: id, partner_code: PARTNER, raw_status: 'DELIVERED', status_norm: 'delivered',
      total_price: 100000, created_time: '2025-01-02T03:00:00Z',
      completed_time: '2025-01-05T03:00:00Z', // 10:00 VN 05/01
      source_active: true, account_id: 900001, customer_phone_norm: '0900000001', ...over,
    })
    if (error) abort(`fixture order ${id}: ${error.message}`)
    FX_IDS.push(id) // r1 P0: CHỈ sau insert thành công — collision không lọt cleanup
    return id
  }
  const agg = () => svc.rpc('rpc_aggregate_affiliate_customers',
    { p_store_ids: [sA.id, sB.id], p_from: P_FROM, p_to: P_TO })

  // ── 1) CHECK contract cột campaign customer (DB không tin app) ────────────
  await expectRaise('CHECK: customer + metric_offline=true → violation',
    svc.from('kpi_campaigns').insert({
      name: 'QA-103 bad contract', start_date: '2025-01-01', end_date: '2025-01-31',
      status: 'draft', is_test: true, ...CUSTOMER, metric_offline: true,
    }), 'chk_kpi_campaigns_customer_contract')
  await expectRaise('CHECK: metric_type lạ → violation',
    svc.from('kpi_campaigns').insert({
      name: 'QA-103 bad type', start_date: '2025-01-01', end_date: '2025-01-31',
      status: 'draft', is_test: true, metric_type: 'bogus',
    }), 'chk_kpi_campaigns_metric_type')

  const cCust = await mkCampaign('QA-103 customer (xóa được)', CUSTOMER)
  const cGmv = await mkCampaign('QA-103 gmv offline (xóa được)')

  // ── 2) rpc_replace_campaign_targets: integer guard theo metric ────────────
  {
    const e1 = await importTargets(cCust, 12.5)
    out('targets: customer + kpi_target 12.5 → RAISE số nguyên',
      !!e1 && e1.message.includes('số nguyên'), e1?.message?.slice(0, 76) ?? 'KHÔNG lỗi')
    const e2 = await importTargets(cCust, 100)
    out('targets: customer + kpi_target 100 (integer) → OK', !e2, e2?.message ?? '')
    const e3 = await importTargets(cGmv, 1000000.5)
    out('targets: gmv + kpi_target thập phân → OK (hành vi cũ giữ nguyên)', !e3, e3?.message ?? '')
  }

  // ── 3) rpc_replace_campaign_actuals: branch theo metric_type ──────────────
  const rpcReplace = (cid, daily, actuals) =>
    svc.rpc('rpc_replace_campaign_actuals', { p_campaign_id: cid, p_daily: daily, p_actuals: actuals })
  const ts = new Date().toISOString()
  const custAgg = (s, count, over = {}) => ({
    store_id: s.id, actual_value: count, actual_offline: 0, actual_affiliate: 0,
    actual_customer_count: count, run_rate: count, remaining_target: Math.max(100 - count, 0),
    raw_row_count: 1, affiliate_synced_at: ts, synced_at: ts, ...over,
  })
  const custDay = (s, count, over = {}) => ({
    store_id: s.id, date: '2025-01-05', gmv: 0, gmv_affiliate: 0,
    affiliate_customer_count: count, synced_at: ts, ...over,
  })
  {
    const { error } = await rpcReplace(cCust,
      [custDay(sA, 3), custDay(sB, 2)], [custAgg(sA, 3), custAgg(sB, 2)])
    out('replace: customer payload hợp lệ → OK', !error, error?.message ?? '')
    const { data } = await svc.from('kpi_campaign_store_actuals')
      .select('actual_value, actual_offline, actual_affiliate, actual_customer_count')
      .eq('campaign_id', cCust).eq('store_id', sA.id).single()
    out('replace: DB ghi value=count=3, offline=affiliate=0',
      data && Number(data.actual_value) === 3 && Number(data.actual_customer_count) === 3
        && Number(data.actual_offline) === 0 && Number(data.actual_affiliate) === 0,
      JSON.stringify(data))
  }
  // TẦNG CHỐT: engine cũ (payload GMV legacy, không key mới) ghi vào campaign
  // customer → fallback offline=actual_value ≠ 0 → RAISE.
  await expectRaise('replace: payload GMV legacy vào campaign customer → RAISE',
    rpcReplace(cCust,
      [{ store_id: sA.id, date: '2025-01-05', gmv: 100, synced_at: ts },
       { store_id: sB.id, date: '2025-01-05', gmv: 100, synced_at: ts }],
      [{ store_id: sA.id, actual_value: 100, run_rate: 10, remaining_target: 0, raw_row_count: 1, synced_at: ts },
       { store_id: sB.id, actual_value: 100, run_rate: 10, remaining_target: 0, raw_row_count: 1, synced_at: ts }]),
    'campaign customer-count')
  await expectRaise('replace: customer value≠count → RAISE',
    rpcReplace(cCust, [custDay(sA, 3), custDay(sB, 2)],
      [custAgg(sA, 3, { actual_value: 4 }), custAgg(sB, 2)]),
    'actual_customer_count')
  await expectRaise('replace: customer SUM(daily count)≠aggregate → RAISE',
    rpcReplace(cCust, [custDay(sA, 2), custDay(sB, 2)], [custAgg(sA, 3), custAgg(sB, 2)]),
    'SUM(daily.affiliate_customer_count)')
  await expectRaise('replace: customer daily có gmv≠0 → RAISE',
    rpcReplace(cCust, [custDay(sA, 3, { gmv: 5 }), custDay(sB, 2)], [custAgg(sA, 3), custAgg(sB, 2)]),
    'SUM(daily gmv)')
  {
    // GMV legacy payload vẫn chạy (regression 098) + chặn chiều ngược.
    const gmvDay = (s) => ({ store_id: s.id, date: '2025-01-05', gmv: 100, synced_at: ts })
    const gmvAgg = (s, over = {}) => ({
      store_id: s.id, actual_value: 100, run_rate: 10, remaining_target: 900,
      raw_row_count: 1, synced_at: ts, ...over,
    })
    const { error } = await rpcReplace(cGmv, [gmvDay(sA), gmvDay(sB)], [gmvAgg(sA), gmvAgg(sB)])
    out('replace: gmv legacy payload → OK (regression 098 giữ nguyên)', !error, error?.message ?? '')
    await expectRaise('replace: gmv + actual_customer_count>0 → RAISE (chặn chiều ngược)',
      rpcReplace(cGmv, [gmvDay(sA), gmvDay(sB)],
        [gmvAgg(sA, { actual_customer_count: 5 }), gmvAgg(sB)]),
      'campaign GMV')
  }

  // ── 4) rpc_aggregate_affiliate_customers (cần backfill xong) ──────────────
  if (!backfillDone) {
    pendingSkip('aggregate: toàn khối dedup/tie-break/biên ngày/fail-closed', 'backfill customer_phone_norm chưa xong — chạy lại script SAU deploy + full sync')
  } else {
    // Fixture: acc 900001 — 3 đơn delivered (2 sA sớm, 1 sB muộn) → 1 khách tại sA, cross-store
    await mkOrder({ customer_phone_norm: '0900000001', store_id: sA.id, completed_time: '2025-01-05T03:00:00Z' })
    await mkOrder({ customer_phone_norm: '0900000001', store_id: sA.id, completed_time: '2025-01-06T03:00:00Z' })
    await mkOrder({ customer_phone_norm: '0900000001', store_id: sB.id, completed_time: '2025-01-07T03:00:00Z' })
    // acc 900002 — 1 đơn sB
    await mkOrder({ customer_phone_norm: '0900000002', store_id: sB.id, completed_time: '2025-01-10T03:00:00Z' })
    // acc 900003 — chỉ CANCELED → không tính
    await mkOrder({ customer_phone_norm: '0900000003', store_id: sA.id, raw_status: 'CANCELED', status_norm: 'canceled' })
    // acc 900004 — delivered nhưng total_price ≤ 0 → loại êm
    await mkOrder({ customer_phone_norm: '0900000004', store_id: sA.id, total_price: 0 })
    await mkOrder({ customer_phone_norm: '0900000004', store_id: sA.id, total_price: -5000 })
    // acc 900005 — ngoài range (12/2024)
    await mkOrder({ customer_phone_norm: '0900000005', store_id: sA.id, completed_time: '2024-12-20T03:00:00Z' })
    // acc 900006 — biên TRONG: 23:59:59 VN 31/01 = 16:59:59Z
    await mkOrder({ customer_phone_norm: '0900000006', store_id: sA.id, completed_time: '2025-01-31T16:59:59Z' })
    // acc 900007 — biên NGOÀI: 00:00:00 VN 01/02 = 17:00:00Z 31/01
    await mkOrder({ customer_phone_norm: '0900000007', store_id: sA.id, completed_time: '2025-01-31T17:00:00Z' })
    // acc 900008 — tie-break: 2 đơn CÙNG completed_time, order_id nhỏ ở sB thắng
    const tieB = await mkOrder({ customer_phone_norm: '0900000008', store_id: sB.id, completed_time: '2025-01-15T03:00:00Z' })
    await mkOrder({ customer_phone_norm: '0900000008', store_id: sA.id, completed_time: '2025-01-15T03:00:00Z' })

    const { data: r, error: aggErr } = await agg()
    out('aggregate: chạy OK', !aggErr, aggErr?.message ?? '')
    if (r) {
      // Kỳ vọng khách: 900001(sA), 900002(sB), 900006(sA), 900008(sB — tie-break) = 4
      out('aggregate: total_customers = 4 (dedup + loại canceled/≤0/ngoài range/biên)',
        r.total_customers === 4, `total=${r.total_customers}`)
      const sum = (r.rows ?? []).reduce((s, x) => s + x.customer_count, 0)
      out('aggregate: SUM(rows) = total_customers', sum === r.total_customers, `sum=${sum}`)
      const byKey = new Map((r.rows ?? []).map((x) => [`${x.store_id}|${x.vn_date}`, x.customer_count]))
      out('aggregate: 900001 tính tại sA ngày 05/01 (đơn sớm nhất)',
        (byKey.get(`${sA.id}|2025-01-05`) ?? 0) >= 1, JSON.stringify([...byKey.entries()]))
      out('aggregate: biên 23:59:59 VN 31/01 VÀO (900006 tại sA 31/01)',
        (byKey.get(`${sA.id}|2025-01-31`) ?? 0) === 1, '')
      out('aggregate: tie-break order_id nhỏ thắng (900008 tại sB 15/01)',
        (byKey.get(`${sB.id}|2025-01-15`) ?? 0) === 1, `tie winner order=${tieB}`)
      out('aggregate: cross_store đếm 900001 + 900008',
        r.cross_store_customer_count === 2
          && (r.cross_store_sample ?? []).includes(900001) && (r.cross_store_sample ?? []).includes(900008),
        JSON.stringify({ n: r.cross_store_customer_count, sample: r.cross_store_sample }))
    }
    // Fail-closed (mig 104): thiếu customer_phone_norm (đơn đủ điều kiện) /
    // thiếu completed_time trong scope
    const badAcct = await mkOrder({ customer_phone_norm: null, store_id: sA.id })
    await expectRaise('aggregate: đơn đủ điều kiện thiếu SĐT khách → RAISE fail-closed (mig 104)',
      agg(), 'thiếu số điện thoại khách')
    await svc.from('affiliate_orders').delete().eq('order_id', badAcct).eq('partner_code', PARTNER)
    const badCt = await mkOrder({ customer_phone_norm: '0900000009', store_id: sA.id, completed_time: null })
    await expectRaise('aggregate: delivered thiếu completed_time → RAISE fail-closed', agg(), 'thiếu completed_time')
    await svc.from('affiliate_orders').delete().eq('order_id', badCt).eq('partner_code', PARTNER)
  }

  // ── 5) Activation: overlap customer + EXCLUDE backstop + GMV không dính ───
  const { data: latestRun } = await svc.from('affiliate_sync_runs')
    .select('id, status').order('started_at', { ascending: false }).limit(1).maybeSingle()
  const freshUpdatedAt = async (cid) =>
    (await svc.from('kpi_campaigns').select('updated_at').eq('id', cid).single()).data.updated_at
  const activate = async (cid) => svc.rpc('rpc_activate_kpi_campaign', {
    p_campaign_id: cid, p_expected_updated_at: await freshUpdatedAt(cid),
    p_expected_run_id: latestRun?.id ?? null,
  })

  if (!latestRun || latestRun.status !== 'success') {
    pendingSkip('activation: khối customer (cần latest affiliate run = success)', `latest run: ${latestRun?.status ?? 'không có'}`)
  } else if (!backfillDone) {
    pendingSkip('activation: khối customer (identity gate cần backfill xong)', '')
  } else {
    const { error: a1 } = await activate(cCust)
    out('activate: customer campaign 1 → OK', !a1, a1?.message ?? '')
    const cCust2 = await mkCampaign('QA-103 customer overlap (xóa được)', {
      ...CUSTOMER, start_date: '2025-01-15', end_date: '2025-02-15',
    })
    await importTargets(cCust2, 50)
    await expectRaise('activate: customer 2 overlap → RAISE (RPC pre-check)', activate(cCust2), 'trùng thời gian')
    // EXCLUDE backstop: đổi status trực tiếp (né RPC) cũng phải bị chặn
    const { error: exErr } = await svc.from('kpi_campaigns')
      .update({ status: 'active' }).eq('id', cCust2)
    out('EXCLUDE backstop: UPDATE tay status=active campaign overlap → bị chặn',
      !!exErr && exErr.message.includes('excl_customer_campaign_overlap'), exErr?.message?.slice(0, 76) ?? 'KHÔNG lỗi')
    // paused vẫn chặn (handoff): pause customer 1 rồi activate customer 2
    await svc.from('kpi_campaigns').update({ status: 'paused' }).eq('id', cCust)
    await expectRaise('activate: customer 1 PAUSED vẫn chặn customer 2 overlap', activate(cCust2), 'trùng thời gian')
    // GMV không dính: 2 campaign GMV cùng cửa sổ activate được cả 2
    const cGmv2 = await mkCampaign('QA-103 gmv 2 (xóa được)')
    await importTargets(cGmv2, 2000000)
    const { error: g1 } = await activate(cGmv)
    const { error: g2 } = await activate(cGmv2)
    out('activate: 2 campaign GMV cùng cửa sổ → CẢ HAI OK (không dính EXCLUDE)',
      !g1 && !g2, `${g1?.message ?? ''} ${g2?.message ?? ''}`)
  }

  // ── 6) Grants ─────────────────────────────────────────────────────────────
  {
    const { error } = await anon.rpc('rpc_aggregate_affiliate_customers',
      { p_store_ids: [sA.id], p_from: P_FROM, p_to: P_TO })
    out('grants: anon gọi rpc_aggregate_affiliate_customers → DENIED', !!error, error?.message?.slice(0, 76) ?? 'KHÔNG lỗi (LEAK)')
  }
  if (env.QA_AUTH_EMAIL && env.QA_PASSWORD) {
    const authed = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } })
    const { error: loginErr } = await authed.auth.signInWithPassword({ email: env.QA_AUTH_EMAIL, password: env.QA_PASSWORD })
    if (loginErr) skip('grants: authenticated deny', `login lỗi: ${loginErr.message}`)
    else {
      const { error } = await authed.rpc('rpc_aggregate_affiliate_customers',
        { p_store_ids: [sA.id], p_from: P_FROM, p_to: P_TO })
      out('grants: authenticated gọi aggregate customers → DENIED', !!error, error?.message?.slice(0, 76) ?? 'KHÔNG lỗi (LEAK)')
      await authed.auth.signOut()
    }
  } else {
    skip('grants: authenticated deny', 'thiếu QA_AUTH_EMAIL/QA_PASSWORD')
  }
  // r1 hardening: RPC tự bảo vệ contract (param sai → RAISE trước mọi đọc)
  await expectRaise('hardening: p_store_ids NULL → RAISE',
    svc.rpc('rpc_aggregate_affiliate_customers', { p_store_ids: null, p_from: P_FROM, p_to: P_TO }),
    'p_store_ids NULL')
  await expectRaise('hardening: p_from >= p_to → RAISE',
    svc.rpc('rpc_aggregate_affiliate_customers', { p_store_ids: [], p_from: P_TO, p_to: P_FROM }),
    'không hợp lệ')
  // Smoke: mảng rỗng → 0, không RAISE
  {
    const { data, error } = await svc.rpc('rpc_aggregate_affiliate_customers',
      { p_store_ids: [], p_from: P_FROM, p_to: P_TO })
    out('smoke: store_ids rỗng → total 0, không RAISE',
      !error && data?.total_customers === 0, error?.message ?? JSON.stringify(data))
  }
} catch (e) {
  console.error(e.message)
  failed++
} finally {
  // ── CLEANUP exact-ID (fixture sót → FAIL) ─────────────────────────────────
  try {
    // r1 P0: DELETE luôn kèm partner_code fixture — không bao giờ xóa chỉ theo ID.
    if (FX_IDS.length > 0) await svc.from('affiliate_orders').delete().in('order_id', FX_IDS).eq('partner_code', PARTNER)
    if (campaignIds.length > 0) {
      // FK cascade dọn targets/tiers/actuals/daily/import_runs
      await svc.from('kpi_campaigns').delete().in('id', campaignIds)
    }
    const left1 = FX_IDS.length > 0
      ? await svc.from('affiliate_orders').select('order_id', { count: 'exact', head: true }).in('order_id', FX_IDS).eq('partner_code', PARTNER)
      : { count: 0 }
    const left2 = campaignIds.length > 0
      ? await svc.from('kpi_campaigns').select('id', { count: 'exact', head: true }).in('id', campaignIds)
      : { count: 0 }
    out('cleanup: fixture orders + campaigns sạch', (left1.count ?? 1) === 0 && (left2.count ?? 1) === 0,
      `orders sót=${left1.count} campaigns sót=${left2.count}`)
  } catch (e) {
    out('cleanup: chạy được', false, e instanceof Error ? e.message : String(e))
  }
  console.log(`\n${failed === 0 && pending === 0 ? 'ALL PASS' : `FAILED=${failed} PENDING=${pending}`}`)
  process.exit(failed > 0 ? 1 : pending > 0 ? 3 : 0)
}
