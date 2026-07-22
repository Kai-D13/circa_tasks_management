// QA THỰC THI cho migration 092 (audit P2 r2 + r2.1). Chạy SAU khi 092 apply,
// TRƯỚC khi mở Phase 3:
//   cd webapp && node scripts/qa-kpi-affiliate-092.mjs
// Tùy chọn test authenticated-deny: đặt QA_AUTH_EMAIL + QA_PASSWORD (account
// staff/admin bất kỳ) — thiếu thì case đó SKIP có cảnh báo.
// Nguyên tắc: fixture campaign is_test=true + đơn affiliate ID vùng riêng
// 999800001+ partner_code 'QA-092-FIXTURE', cửa sổ thời gian 01/2025 (trước
// mọi data thật ~06/2026 → assert số TUYỆT ĐỐI kể cả sau backfill); cleanup
// exact-ID trong FINALLY (script throw giữa chừng vẫn dọn); KHÔNG đụng
// campaign/đơn thật. Exit 1 nếu bất kỳ case fail.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = {}
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m) env[m[1]] = m[2]
}
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } })

let failed = 0
const out = (label, ok, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL').padEnd(5), label.padEnd(66), detail)
  if (!ok) failed++
}
const skip = (label, why) => console.log('SKIP '.padEnd(5), label.padEnd(66), why)
const expectRaise = async (label, promise, msgPart) => {
  const { error } = await promise
  const ok = !!error && error.message.includes(msgPart)
  out(label, ok, error ? error.message.slice(0, 72) : 'KHÔNG lỗi (phải RAISE)')
}

// ID vùng QA riêng cho affiliate_orders (không đụng order_id thật ~2xxxx).
const FX = { d1: 999800001, dBoundA: 999800002, dBoundB: 999800003, canceled: 999800004, fail: 999800005, dOut: 999800006, dNull: 999800007 }
const FX_IDS = Object.values(FX)
const campaignIds = []

try {
  // ── Preflight ─────────────────────────────────────────────────────────────
  const mig = await svc.from('app_migrations').select('version').eq('version', '092').maybeSingle()
  if (!mig.data) { console.error('ABORT: migration 092 chưa chạy'); process.exit(2) }
  const colCheck = await svc.from('affiliate_orders').select('completed_time').limit(1)
  out('preflight: cột affiliate_orders.completed_time tồn tại', !colCheck.error, colCheck.error?.message ?? '')
  const map = await svc.from('affiliate_partner_mappings').select('partner_code, partner_type, stores(code)').in('partner_code', ['CIRCA-MIZUKI', 'CIRCA-NAMVIET'])
  out('preflight: mapping MIZUKI→POS0013 + NAMVIET→POS0077 (os)',
    map.data?.length === 2 && map.data.every((m) => m.partner_type === 'os')
      && map.data.some((m) => m.stores?.code === 'POS0013') && map.data.some((m) => m.stores?.code === 'POS0077'),
    JSON.stringify(map.data?.map((m) => `${m.partner_code}:${m.stores?.code}`)))

  // ── Backfill regression vàng (PostgREST không so cột-cột → so trong JS) ───
  const reg = await svc.from('kpi_campaign_store_actuals')
    .select('actual_value, actual_offline, actual_affiliate').is('affiliate_synced_at', null)
  const regBad = (reg.data ?? []).filter((r) =>
    Number(r.actual_offline) !== Number(r.actual_value) || Number(r.actual_affiliate) !== 0)
  out('backfill: row legacy lệch (offline≠value hoặc affiliate≠0) = 0',
    !reg.error && regBad.length === 0, reg.error?.message ?? `lệch=${regBad.length}/${reg.data?.length}`)

  // ── Fixture stores + campaigns ────────────────────────────────────────────
  const { data: stores } = await svc.from('stores').select('id, code').eq('store_type', 'os').eq('is_active', true).order('code').limit(2)
  if (!stores || stores.length < 2) { console.error('ABORT: không đủ 2 store os active'); process.exit(2) }
  const [sA, sB] = stores
  const mkCampaign = async (name, metricAffiliate) => {
    const { data, error } = await svc.from('kpi_campaigns').insert({
      name, start_date: '2026-07-01', end_date: '2026-07-31', scope_type: 'store',
      metric_type: 'gmv', order_type: 'all', status: 'draft', is_test: true,
      metric_offline: true, metric_affiliate: metricAffiliate,
    }).select('id').single()
    if (error) { console.error('ABORT fixture campaign:', error.message); process.exit(2) }
    campaignIds.push(data.id)
    for (const s of [sA, sB]) {
      const { error: tErr } = await svc.from('kpi_campaign_store_targets')
        .insert({ campaign_id: data.id, store_id: s.id, pos_code: s.code, kpi_target: 1000, store_kpi_group: 'QA-092' })
      if (tErr) { console.error('ABORT fixture target:', tErr.message); process.exit(2) }
    }
    return data.id
  }
  const c1 = await mkCampaign('QA-092 offline-only (xóa được)', false)
  const c2 = await mkCampaign('QA-092 both-metric (xóa được)', true)
  console.log('fixture:', { c1, c2, storeA: sA.code, storeB: sB.code })

  const rpc = (campaignId, daily, actuals) =>
    svc.rpc('rpc_replace_campaign_actuals', { p_campaign_id: campaignId, p_daily: daily, p_actuals: actuals })
  const aggRow = (s, over = {}) => ({ store_id: s.id, actual_value: 100, run_rate: 10, remaining_target: 900, raw_row_count: 1, ...over })
  const dayRow = (s, over = {}) => ({ store_id: s.id, date: '2026-07-01', gmv: 100, ...over })

  // ── 1) rpc_replace_campaign_actuals: legacy + both + RAISE ───────────────
  {
    const { error } = await rpc(c1, [dayRow(sA), dayRow(sB)], [aggRow(sA), aggRow(sB)])
    out('legacy caller: RPC chấp nhận payload cũ', !error, error?.message ?? '')
    const { data } = await svc.from('kpi_campaign_store_actuals')
      .select('actual_value, actual_offline, actual_affiliate, offline_synced_at')
      .eq('campaign_id', c1).eq('store_id', sA.id).single()
    out('legacy caller: 100/100/0 + offline_synced_at set (KHÔNG 100/0/0)',
      data && Number(data.actual_value) === 100 && Number(data.actual_offline) === 100
        && Number(data.actual_affiliate) === 0 && data.offline_synced_at !== null,
      JSON.stringify(data))
  }
  {
    const ts = new Date().toISOString()
    const { error } = await rpc(c2,
      [dayRow(sA, { gmv: 70, gmv_affiliate: 30 }), dayRow(sB, { gmv: 100, gmv_affiliate: 0 })],
      [aggRow(sA, { actual_offline: 70, actual_affiliate: 30, offline_synced_at: ts, affiliate_synced_at: ts }),
       aggRow(sB, { actual_offline: 100, actual_affiliate: 0, offline_synced_at: ts, affiliate_synced_at: ts })])
    out('both-metric: RPC chấp nhận payload mới hợp lệ', !error, error?.message ?? '')
    const { data } = await svc.from('kpi_campaign_store_actuals')
      .select('actual_offline, actual_affiliate').eq('campaign_id', c2).eq('store_id', sA.id).single()
    out('both-metric: breakdown 70/30 ghi đúng',
      data && Number(data.actual_offline) === 70 && Number(data.actual_affiliate) === 30, JSON.stringify(data))
  }
  const { data: fakeStore } = await svc.from('stores').select('id').eq('store_type', 'os').eq('is_active', true).order('code', { ascending: false }).limit(1).single()
  await expectRaise('RAISE: campaign không tồn tại',
    rpc('00000000-0000-0000-0000-000000000000', [], []), 'không tồn tại')
  await expectRaise('RAISE: store ngoài targets trong p_actuals',
    rpc(c1, [dayRow(sA), dayRow(sB)], [aggRow(sA), aggRow(sB), aggRow(fakeStore)]), 'không thuộc targets')
  await expectRaise('RAISE: p_actuals THIẾU 1 store trong targets (r2)',
    rpc(c1, [dayRow(sA)], [aggRow(sA)]), 'THIẾU aggregate')
  await expectRaise('RAISE: duplicate store trong p_actuals (r2)',
    rpc(c1, [dayRow(sA), dayRow(sB)], [aggRow(sA), aggRow(sA), aggRow(sB)]), 'trùng lặp')
  await expectRaise('RAISE: duplicate (store,date) trong p_daily (r2)',
    rpc(c1, [dayRow(sA), dayRow(sA), dayRow(sB)], [aggRow(sA, { actual_value: 200 }), aggRow(sB)]), 'trùng lặp')
  await expectRaise('RAISE: actual_value <> offline + affiliate',
    rpc(c2, [dayRow(sA), dayRow(sB)],
      [aggRow(sA, { actual_value: 100, actual_offline: 70, actual_affiliate: 50 }), aggRow(sB, { actual_offline: 100, actual_affiliate: 0 })]),
    'actual_value')
  await expectRaise('RAISE: metric_affiliate tắt nhưng actual_affiliate > 0',
    rpc(c1, [dayRow(sA), dayRow(sB)],
      [aggRow(sA, { actual_value: 100, actual_offline: 70, actual_affiliate: 30 }), aggRow(sB)]),
    'tắt metric_affiliate')
  await expectRaise('RAISE: SUM(daily) không khớp aggregate',
    rpc(c1, [dayRow(sA, { gmv: 999 }), dayRow(sB)], [aggRow(sA), aggRow(sB)]), 'không khớp aggregate')
  {
    const { data } = await svc.from('kpi_campaign_store_actuals')
      .select('actual_value').eq('campaign_id', c1).eq('store_id', sA.id).single()
    out('rollback: snapshot C1 giữ nguyên sau mọi RAISE', data && Number(data.actual_value) === 100, JSON.stringify(data))
  }

  // ── 2) rpc_aggregate_affiliate_gmv: rule ngày + status + fail-closed ──────
  // Fixture đơn ở cửa sổ 01/2025 (data thật bắt đầu ~06/2026 → số tuyệt đối).
  // VN = UTC+7: 16:59:59Z = 23:59:59 VN cùng ngày; 17:00:00Z = 00:00 hôm sau.
  const fxRow = (id, storeId, rawStatus, statusNorm, price, createdIso, completedIso) => ({
    order_id: id, order_code: `QA092-${id}`, partner_code: 'QA-092-FIXTURE',
    store_id: storeId, raw_status: rawStatus, status_norm: statusNorm,
    total_price: price, created_time: createdIso, completed_time: completedIso,
    source_active: true,
  })
  const { error: fxErr } = await svc.from('affiliate_orders').upsert([
    fxRow(FX.d1,     sA.id, 'DELIVERED', 'delivered', 100000, '2025-01-05T03:00:00Z', '2025-01-10T05:00:00Z'), // vn 10/01
    fxRow(FX.dBoundA, sA.id, 'DELIVERED', 'delivered', 10000, '2025-01-14T03:00:00Z', '2025-01-15T16:59:59Z'), // vn 23:59:59 15/01
    fxRow(FX.dBoundB, sA.id, 'DELIVERED', 'delivered', 20000, '2025-01-14T03:00:00Z', '2025-01-15T17:00:00Z'), // vn 00:00 16/01
    fxRow(FX.canceled, sA.id, 'CANCELED', 'canceled', 50000, '2025-01-11T03:00:00Z', '2025-01-11T05:00:00Z'),  // không tính
    fxRow(FX.fail,    sA.id, 'FAIL_TO_DELIVER', 'fail_to_deliver', 60000, '2025-01-12T03:00:00Z', '2025-01-12T05:00:00Z'), // không tính
    fxRow(FX.dOut,    sA.id, 'DELIVERED', 'delivered', 70000, '2025-01-20T03:00:00Z', '2025-02-05T05:00:00Z'), // created TRONG cửa sổ, completed NGOÀI → loại (chứng minh dùng completed_time)
  ], { onConflict: 'order_id' })
  if (fxErr) { console.error('ABORT fixture orders:', fxErr.message); process.exit(2) }

  const win = { p_store_ids: [sA.id], p_from: '2024-12-31T17:00:00Z', p_to: '2025-01-31T17:00:00Z' } // 01/01–31/01 VN
  {
    const { data, error } = await svc.rpc('rpc_aggregate_affiliate_gmv', win)
    const byDate = new Map((data ?? []).map((r) => [r.vn_date, r]))
    out('aggregate: gọi được, chỉ trả ngày có đơn DELIVERED', !error && (data?.length ?? 0) === 3, error?.message ?? `rows=${data?.length}`)
    out('aggregate: vn_date 2025-01-10 = 100.000 (ngày giao, không phải ngày tạo 05/01)',
      Number(byDate.get('2025-01-10')?.gmv) === 100000, JSON.stringify(byDate.get('2025-01-10')))
    out('aggregate: boundary 16:59:59Z → VN 15/01 (10.000)',
      Number(byDate.get('2025-01-15')?.gmv) === 10000, JSON.stringify(byDate.get('2025-01-15')))
    out('aggregate: boundary 17:00:00Z → VN 16/01 (20.000)',
      Number(byDate.get('2025-01-16')?.gmv) === 20000, JSON.stringify(byDate.get('2025-01-16')))
    const total = (data ?? []).reduce((s, r) => s + Number(r.gmv), 0)
    out('aggregate: tổng = 130.000 — CANCELED/FAIL_TO_DELIVER/completed-ngoài-cửa-sổ KHÔNG tính',
      total === 130000, `total=${total}`)
  }
  // fail-closed: DELIVERED completed_time NULL ở sB → RAISE; xóa → chạy lại OK.
  {
    const { error: nErr } = await svc.from('affiliate_orders').upsert([
      fxRow(FX.dNull, sB.id, 'DELIVERED', 'delivered', 5000, '2025-01-08T03:00:00Z', null),
    ], { onConflict: 'order_id' })
    if (nErr) { console.error('ABORT fixture null:', nErr.message); process.exit(2) }
    await expectRaise('fail-closed: store có DELIVERED thiếu completed_time → RAISE',
      svc.rpc('rpc_aggregate_affiliate_gmv', { ...win, p_store_ids: [sB.id] }), 'fail-closed')
    await svc.from('affiliate_orders').delete().eq('order_id', FX.dNull)
    const { error: okErr } = await svc.rpc('rpc_aggregate_affiliate_gmv', { ...win, p_store_ids: [sB.id] })
    out('fail-closed: xóa đơn thiếu mốc → aggregate chạy lại bình thường', !okErr, okErr?.message ?? '')
  }

  // ── 3) Quyền EXECUTE: anon + authenticated đều bị chặn ────────────────────
  {
    const r1 = await anon.rpc('rpc_replace_campaign_actuals', { p_campaign_id: c1, p_daily: [], p_actuals: [] })
    out('quyền: anon bị chặn rpc_replace_campaign_actuals', !!r1.error, (r1.error?.message ?? '').slice(0, 60))
    const r2q = await anon.rpc('rpc_aggregate_affiliate_gmv', win)
    out('quyền: anon bị chặn rpc_aggregate_affiliate_gmv', !!r2q.error, (r2q.error?.message ?? '').slice(0, 60))
    if (env.QA_AUTH_EMAIL && env.QA_PASSWORD) {
      const authed = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } })
      const { error: siErr } = await authed.auth.signInWithPassword({ email: env.QA_AUTH_EMAIL, password: env.QA_PASSWORD })
      if (siErr) out('quyền: đăng nhập QA_AUTH_EMAIL', false, siErr.message)
      else {
        const a1 = await authed.rpc('rpc_replace_campaign_actuals', { p_campaign_id: c1, p_daily: [], p_actuals: [] })
        out('quyền: authenticated bị chặn rpc_replace_campaign_actuals', !!a1.error, (a1.error?.message ?? '').slice(0, 60))
        const a2 = await authed.rpc('rpc_aggregate_affiliate_gmv', win)
        out('quyền: authenticated bị chặn rpc_aggregate_affiliate_gmv', !!a2.error, (a2.error?.message ?? '').slice(0, 60))
        await authed.auth.signOut()
      }
    } else {
      skip('quyền: authenticated deny (2 RPC)', 'đặt QA_AUTH_EMAIL + QA_PASSWORD để chạy')
    }
  }
} finally {
  // ── Cleanup exact-ID (chạy cả khi throw giữa chừng — audit P2 r2.1) ───────
  const delFx = await svc.from('affiliate_orders').delete().in('order_id', FX_IDS).select('order_id')
  console.log('CLEANUP affiliate fixtures:', delFx.error ? `ERR ${delFx.error.message}` : `deleted=${delFx.data?.length}`)
  if (campaignIds.length > 0) {
    const delC = await svc.from('kpi_campaigns').delete().in('id', campaignIds).select('id')
    console.log('CLEANUP campaigns (cascade targets/actuals/daily):', delC.error ? `ERR ${delC.error.message}` : `deleted=${delC.data?.length}`)
    const ghost = await svc.from('kpi_campaign_store_actuals').select('campaign_id', { count: 'exact', head: true }).in('campaign_id', campaignIds)
    console.log('CLEANUP ghost actuals:', ghost.count === 0 ? 'PASS 0' : `FAIL ${ghost.count}`)
    if (ghost.count !== 0) failed++
  }
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
