// QA THỰC THI cho migration 092 (audit P2: verify SQL không được chỉ là
// comment). Chạy SAU khi 092 đã apply, TRƯỚC khi mở Phase 3.
//   cd webapp && node scripts/qa-kpi-affiliate-092.mjs
// Nguyên tắc: fixture = campaign is_test=true (ẩn khỏi staff/SM thật qua RLS
// can_read_kpi_campaign), dọn bằng exact-ID (FK cascade), KHÔNG đụng campaign
// thật. Mọi case RAISE của rpc_replace_campaign_actuals + legacy caller +
// backfill regression + quyền EXECUTE. Exit 1 nếu bất kỳ case fail.
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
  console.log((ok ? 'PASS' : 'FAIL').padEnd(5), label.padEnd(64), detail)
  if (!ok) failed++
}
const expectRaise = async (label, promise, msgPart) => {
  const { error } = await promise
  const ok = !!error && error.message.includes(msgPart)
  out(label, ok, error ? error.message.slice(0, 70) : 'KHÔNG lỗi (phải RAISE)')
}

// ── Preflight: 092 đã apply? ────────────────────────────────────────────────
const mig = await svc.from('app_migrations').select('version').eq('version', '092').maybeSingle()
if (!mig.data) { console.error('ABORT: migration 092 chưa chạy (app_migrations không có 092)'); process.exit(2) }
const colCheck = await svc.from('affiliate_orders').select('completed_time').limit(1)
out('preflight: cột affiliate_orders.completed_time tồn tại', !colCheck.error, colCheck.error?.message ?? '')

// ── Backfill regression vàng (không phụ thuộc fixture) ──────────────────────
// PostgREST không so sánh cột-với-cột trong filter → fetch rồi so trong JS
// (bảng actuals nhỏ: ~26 store × vài campaign).
const reg = await svc.from('kpi_campaign_store_actuals')
  .select('actual_value, actual_offline, actual_affiliate')
  .is('affiliate_synced_at', null)
const regBad = (reg.data ?? []).filter((r) =>
  Number(r.actual_offline) !== Number(r.actual_value) || Number(r.actual_affiliate) !== 0)
out('backfill: row legacy lệch (offline≠value hoặc affiliate≠0) = 0',
  !reg.error && regBad.length === 0, reg.error?.message ?? `lệch=${regBad.length}/${reg.data?.length}`)

// ── Fixture: 2 store os thật + 2 campaign is_test (C1 offline-only, C2 both) ─
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

// Helper payload đủ 2 store (contract r2: payload phải phủ TOÀN BỘ targets).
const aggRow = (s, over = {}) => ({ store_id: s.id, actual_value: 100, run_rate: 10, remaining_target: 900, raw_row_count: 1, ...over })
const dayRow = (s, over = {}) => ({ store_id: s.id, date: '2026-07-01', gmv: 100, ...over })

// ── 1) Legacy caller (payload CŨ, không key mới) trên C1 ────────────────────
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

// ── 2) Caller mới both-metric trên C2 (tổng = off + aff, daily 2 nguồn) ─────
{
  const { error } = await rpc(c2,
    [dayRow(sA, { gmv: 70, gmv_affiliate: 30 }), dayRow(sB, { gmv: 100, gmv_affiliate: 0 })],
    [aggRow(sA, { actual_offline: 70, actual_affiliate: 30, offline_synced_at: new Date().toISOString(), affiliate_synced_at: new Date().toISOString() }),
     aggRow(sB, { actual_offline: 100, actual_affiliate: 0, offline_synced_at: new Date().toISOString(), affiliate_synced_at: new Date().toISOString() })])
  out('both-metric: RPC chấp nhận payload mới hợp lệ', !error, error?.message ?? '')
  const { data } = await svc.from('kpi_campaign_store_actuals')
    .select('actual_offline, actual_affiliate').eq('campaign_id', c2).eq('store_id', sA.id).single()
  out('both-metric: breakdown 70/30 ghi đúng',
    data && Number(data.actual_offline) === 70 && Number(data.actual_affiliate) === 30, JSON.stringify(data))
}

// ── 3) Các case RAISE (kỳ vọng LỖI + snapshot cũ GIỮ NGUYÊN) ────────────────
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

// Snapshot C1 sau các RAISE vẫn là kết quả case 1 (rollback toàn transaction).
{
  const { data } = await svc.from('kpi_campaign_store_actuals')
    .select('actual_value').eq('campaign_id', c1).eq('store_id', sA.id).single()
  out('rollback: snapshot C1 giữ nguyên sau mọi RAISE', data && Number(data.actual_value) === 100, JSON.stringify(data))
}

// ── 4) Quyền EXECUTE: anon bị chặn cả 2 RPC ─────────────────────────────────
{
  const r1 = await anon.rpc('rpc_replace_campaign_actuals', { p_campaign_id: c1, p_daily: [], p_actuals: [] })
  out('quyền: anon gọi rpc_replace_campaign_actuals bị từ chối', !!r1.error, (r1.error?.message ?? '').slice(0, 60))
  const r2q = await anon.rpc('rpc_aggregate_affiliate_gmv', { p_store_ids: [sA.id], p_from: '2026-07-01T00:00:00Z', p_to: '2026-08-01T00:00:00Z' })
  out('quyền: anon gọi rpc_aggregate_affiliate_gmv bị từ chối', !!r2q.error, (r2q.error?.message ?? '').slice(0, 60))
}

// ── 5) rpc_aggregate_affiliate_gmv smoke (service role, chỉ đọc) ────────────
{
  const { data, error } = await svc.rpc('rpc_aggregate_affiliate_gmv', {
    p_store_ids: [sA.id, sB.id], p_from: '2026-06-30T17:00:00Z', p_to: '2026-07-31T17:00:00Z',
  })
  out('aggregate smoke: service role gọi được (rows tùy backfill)', !error, error?.message ?? `rows=${data?.length}`)
}

// ── Cleanup exact-ID (FK cascade targets/actuals/daily) ─────────────────────
const del = await svc.from('kpi_campaigns').delete().in('id', [c1, c2]).select('id')
out('CLEANUP: xóa đúng 2 campaign fixture (cascade)', !del.error && del.data?.length === 2, del.error?.message ?? `deleted=${del.data?.length}`)
const ghost = await svc.from('kpi_campaign_store_actuals').select('campaign_id', { count: 'exact', head: true }).in('campaign_id', [c1, c2])
out('CLEANUP: 0 actuals ghost', ghost.count === 0, `ghost=${ghost.count}`)

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
