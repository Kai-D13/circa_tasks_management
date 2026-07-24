// QA THỰC THI cho migration 093 (P3-D r1). Chạy SAU khi 093 apply:
//   cd webapp && node scripts/qa-kpi-activation-093.mjs
// Fixture: campaign is_test=true (ẩn khỏi staff/SM thật) + target trên store OS
// thật; cleanup exact-ID trong FINALLY. Không đụng campaign thật.
// Phủ verify block của 093: conflict updated_at, activate/re-activate, update
// song song, affiliate run-id guard, quyền anon/authenticated.
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
let pending = 0
let aborted = null
const out = (label, ok, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL').padEnd(5), label.padEnd(66), detail)
  if (!ok) failed++
}
// r1.1 (audit P2#3): check BẮT BUỘC không chạy được → PENDING, exit ≠ 0 —
// KHÔNG được tính là ALL PASS.
const pendingSkip = (label, why) => { pending++; console.log('PEND '.padEnd(5), label.padEnd(66), why) }
const expectRaise = async (label, promise, msgPart) => {
  const { error } = await promise
  const ok = !!error && error.message.includes(msgPart)
  out(label, ok, error ? error.message.slice(0, 72) : 'KHÔNG lỗi (phải RAISE)')
}
const abort = (msg) => { throw new Error(`ABORT: ${msg}`) }
const campaignIds = []

const activate = (id, expectedUpdatedAt, runId = null) =>
  svc.rpc('rpc_activate_kpi_campaign', {
    p_campaign_id: id, p_expected_updated_at: expectedUpdatedAt, p_expected_run_id: runId,
  })

try {
  const mig = await svc.from('app_migrations').select('version').eq('version', '093').maybeSingle()
  if (!mig.data) abort('migration 093 chưa chạy')

  // ── 0) Regression định nghĩa function (r1.1 audit P2): file migration PHẢI
  //    chứa FOR UPDATE + CẢ 2 lệnh xóa actuals (bản 072) — chống tái diễn lỗi
  //    lấy nhầm body 071. (Định nghĩa LIVE verify bằng SQL tay — xem VERIFY #0.)
  const sql = fs.readFileSync('../supabase/migrations/093_kpi_campaign_activation_guard.sql', 'utf8').toLowerCase()
  out('regression 093: body có FOR UPDATE', sql.includes('for update'))
  out('regression 093: giữ DELETE kpi_campaign_store_actuals', sql.includes('delete from public.kpi_campaign_store_actuals'))
  out('regression 093: giữ DELETE kpi_campaign_store_daily_actuals', sql.includes('delete from public.kpi_campaign_store_daily_actuals'))

  const { data: store } = await svc.from('stores').select('id, code').eq('store_type', 'os').eq('is_active', true).order('code').limit(1).single()
  if (!store) abort('không có store os active')

  const mkCampaign = async (name, metricAffiliate) => {
    const { data, error } = await svc.from('kpi_campaigns').insert({
      name, start_date: '2026-07-01', end_date: '2026-07-31', scope_type: 'store',
      metric_type: 'gmv', order_type: 'all', status: 'draft', is_test: true,
      metric_offline: true, metric_affiliate: metricAffiliate,
    }).select('id, updated_at').single()
    if (error) abort(`fixture campaign: ${error.message}`)
    campaignIds.push(data.id)
    const { error: tErr } = await svc.from('kpi_campaign_store_targets')
      .insert({ campaign_id: data.id, store_id: store.id, pos_code: store.code, kpi_target: 1000, store_kpi_group: 'QA-093' })
    if (tErr) abort(`fixture target: ${tErr.message}`)
    return data
  }

  // ── 1) Offline-only: conflict + activate + re-activate ─────────────────────
  const c1 = await mkCampaign('QA-093 offline (xóa được)', false)
  await expectRaise('conflict: expected_updated_at SAI → RAISE vừa thay đổi',
    activate(c1.id, '2020-01-01T00:00:00Z'), 'vừa thay đổi')
  {
    const { data, error } = await activate(c1.id, c1.updated_at)
    out('activate đúng kỳ vọng → activated=true', !error && data?.activated === true, error?.message ?? JSON.stringify(data))
  }
  await expectRaise('re-activate khi đã active → RAISE draft/paused',
    activate(c1.id, c1.updated_at), 'Chỉ kích hoạt từ draft/paused')

  // ── 2) Update-song-song vs activation: chỉ 1 thao tác thắng ────────────────
  const c2 = await mkCampaign('QA-093 race (xóa được)', false)
  // mô phỏng "sửa campaign" sau khi app đã đọc updated_at: bump updated_at
  const { data: bumped, error: bumpErr } = await svc.from('kpi_campaigns')
    .update({ name: 'QA-093 race (đã sửa)', updated_at: new Date().toISOString() })
    .eq('id', c2.id).select('updated_at').single()
  if (bumpErr) abort(`bump: ${bumpErr.message}`)
  await expectRaise('activation bằng updated_at CŨ sau khi campaign bị sửa → RAISE',
    activate(c2.id, c2.updated_at), 'vừa thay đổi')
  {
    const { data, error } = await activate(c2.id, bumped.updated_at)
    out('activation bằng updated_at MỚI → activated', !error && data?.activated === true, error?.message ?? '')
  }

  // ── 3) Affiliate campaign: run-id guard ────────────────────────────────────
  const c3 = await mkCampaign('QA-093 affiliate (xóa được)', true)
  await expectRaise('affiliate: thiếu expected_run_id → RAISE',
    activate(c3.id, c3.updated_at, null), 'Thiếu run id')
  await expectRaise('affiliate: expected_run_id không khớp latest run → RAISE',
    activate(c3.id, c3.updated_at, '00000000-0000-0000-0000-000000000000'), 'vừa thay đổi')
  {
    // expected_run_id ĐÚNG latest success run → chỉ pass khi latest run là success
    const { data: latest } = await svc.from('affiliate_sync_runs')
      .select('id, status').order('started_at', { ascending: false }).limit(1).maybeSingle()
    if (latest?.status === 'success') {
      const { data, error } = await activate(c3.id, c3.updated_at, latest.id)
      out('affiliate: run_id đúng latest success → activated', !error && data?.activated === true, error?.message ?? '')
    } else {
      pendingSkip('affiliate: run_id đúng latest success → activated', `latest run status=${latest?.status ?? 'none'} — chạy lại sau 1 sync success`)
    }
  }

  // ── 3b) Replace-target POSITIVE path qua service role (r1.1 audit P2#2) ────
  {
    const c4 = await mkCampaign('QA-093 replace-target (xóa được)', false)
    // fixture actuals + daily CŨ — import mới phải xóa sạch (hành vi 072 giữ lại)
    const ts = new Date().toISOString()
    const { error: aErr } = await svc.from('kpi_campaign_store_actuals').insert({
      campaign_id: c4.id, store_id: store.id, actual_value: 999, actual_offline: 999, actual_affiliate: 0,
      run_rate: 99, remaining_target: 1, raw_row_count: 1, offline_synced_at: ts, synced_at: ts,
    })
    const { error: dErr } = await svc.from('kpi_campaign_store_daily_actuals').insert({
      campaign_id: c4.id, store_id: store.id, date: '2026-07-02', gmv: 999, gmv_affiliate: 0, synced_at: ts,
    })
    if (aErr || dErr) abort(`fixture actuals/daily: ${aErr?.message ?? dErr?.message}`)

    const { data: cnt, error: repErr } = await svc.rpc('rpc_replace_campaign_targets', {
      p_campaign_id: c4.id,
      p_rows: [{
        store_id: store.id, pos_code: store.code, kpi_target: 5000, store_kpi_group: 'QA-093-NEW',
        import_row: 1, note: null,
        tiers: [{ tier_order: 1, threshold_pct: 90, commission_amount: 1000000 }],
      }],
    })
    out('replace-target (service role): import thành công, count=1', !repErr && cnt === 1, repErr?.message ?? `count=${cnt}`)

    const { data: newTargets } = await svc.from('kpi_campaign_store_targets')
      .select('kpi_target, store_kpi_group, kpi_campaign_store_tiers(tier_order, threshold_pct, commission_amount)')
      .eq('campaign_id', c4.id)
    out('replace-target: target mới đúng (5000/QA-093-NEW) + tiers tồn tại',
      newTargets?.length === 1 && Number(newTargets[0].kpi_target) === 5000
        && newTargets[0].store_kpi_group === 'QA-093-NEW'
        && (newTargets[0].kpi_campaign_store_tiers ?? []).length === 1,
      JSON.stringify(newTargets?.[0]?.kpi_target))
    const { count: runCnt } = await svc.from('kpi_campaign_import_runs')
      .select('id', { count: 'exact', head: true }).eq('campaign_id', c4.id)
    out('replace-target: import run được ghi', (runCnt ?? 0) >= 1, `runs=${runCnt}`)
    const { count: aCnt } = await svc.from('kpi_campaign_store_actuals')
      .select('campaign_id', { count: 'exact', head: true }).eq('campaign_id', c4.id)
    const { count: dCnt } = await svc.from('kpi_campaign_store_daily_actuals')
      .select('campaign_id', { count: 'exact', head: true }).eq('campaign_id', c4.id)
    out('replace-target: actuals + daily CŨ về 0 (hành vi 072 GIỮ NGUYÊN)',
      aCnt === 0 && dCnt === 0, `actuals=${aCnt} daily=${dCnt}`)

    // import trên campaign ACTIVE bị chặn (sau khi kích hoạt bằng updated_at
    // MỚI — replace vừa bump updated_at)
    const { data: c4now } = await svc.from('kpi_campaigns').select('updated_at').eq('id', c4.id).single()
    const { error: actNowErr } = await activate(c4.id, c4now.updated_at)
    out('setup: kích hoạt c4 để test import-bị-chặn', !actNowErr, actNowErr?.message ?? '')
    await expectRaise('replace-target trên campaign ACTIVE → RAISE draft/paused',
      svc.rpc('rpc_replace_campaign_targets', {
        p_campaign_id: c4.id,
        p_rows: [{ store_id: store.id, pos_code: store.code, kpi_target: 1, store_kpi_group: 'X', tiers: [{ tier_order: 1, threshold_pct: 90, commission_amount: 1 }] }],
      }), 'draft/paused')
  }

  // ── 4) Quyền: anon + authenticated bị chặn cả 2 RPC ────────────────────────
  {
    const a1 = await anon.rpc('rpc_activate_kpi_campaign', { p_campaign_id: c1.id, p_expected_updated_at: c1.updated_at, p_expected_run_id: null })
    out('quyền: anon bị chặn rpc_activate_kpi_campaign', !!a1.error, (a1.error?.message ?? '').slice(0, 60))
    const a2 = await anon.rpc('rpc_replace_campaign_targets', { p_campaign_id: c1.id, p_rows: [] })
    out('quyền: anon bị chặn rpc_replace_campaign_targets', !!a2.error, (a2.error?.message ?? '').slice(0, 60))
    if (env.QA_AUTH_EMAIL && env.QA_PASSWORD) {
      const authed = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } })
      const { error: siErr } = await authed.auth.signInWithPassword({ email: env.QA_AUTH_EMAIL, password: env.QA_PASSWORD })
      if (siErr) out('quyền: đăng nhập QA_AUTH_EMAIL', false, siErr.message)
      else {
        const b1 = await authed.rpc('rpc_activate_kpi_campaign', { p_campaign_id: c1.id, p_expected_updated_at: c1.updated_at, p_expected_run_id: null })
        out('quyền: authenticated bị chặn rpc_activate_kpi_campaign', !!b1.error, (b1.error?.message ?? '').slice(0, 60))
        const b2 = await authed.rpc('rpc_replace_campaign_targets', { p_campaign_id: c1.id, p_rows: [] })
        out('quyền: authenticated bị chặn rpc_replace_campaign_targets', !!b2.error, (b2.error?.message ?? '').slice(0, 60))
        await authed.auth.signOut()
      }
    } else {
      pendingSkip('quyền: authenticated deny (2 RPC)', 'đặt QA_AUTH_EMAIL + QA_PASSWORD để chạy')
    }
  }
} catch (e) {
  aborted = e instanceof Error ? e.message : String(e)
  out(`ABORT giữa chừng: ${aborted}`, false)
} finally {
  if (campaignIds.length > 0) {
    // import_runs không chắc cascade — xóa tường minh trước campaigns.
    await svc.from('kpi_campaign_import_runs').delete().in('campaign_id', campaignIds)
    const del = await svc.from('kpi_campaigns').delete().in('id', campaignIds).select('id')
    out(`CLEANUP: xóa đủ ${campaignIds.length} campaign fixture`, !del.error && del.data?.length === campaignIds.length,
      del.error?.message ?? `deleted=${del.data?.length}`)
    const gT = await svc.from('kpi_campaign_store_targets').select('campaign_id', { count: 'exact', head: true }).in('campaign_id', campaignIds)
    const gA = await svc.from('kpi_campaign_store_actuals').select('campaign_id', { count: 'exact', head: true }).in('campaign_id', campaignIds)
    const gD = await svc.from('kpi_campaign_store_daily_actuals').select('campaign_id', { count: 'exact', head: true }).in('campaign_id', campaignIds)
    const gR = await svc.from('kpi_campaign_import_runs').select('campaign_id', { count: 'exact', head: true }).in('campaign_id', campaignIds)
    out('CLEANUP: 0 ghost targets/actuals/daily/import_runs',
      gT.count === 0 && gA.count === 0 && gD.count === 0 && gR.count === 0,
      `targets=${gT.count} actuals=${gA.count} daily=${gD.count} runs=${gR.count}`)
  }
}

// r1.1: PENDING (check bắt buộc chưa chạy được) → KHÔNG phải ALL PASS, exit 3.
if (aborted) { console.log(`\n${failed} FAILED (aborted)`); process.exit(2) }
if (failed > 0) { console.log(`\n${failed} FAILED${pending ? ` + ${pending} PENDING` : ''}`); process.exit(1) }
if (pending > 0) { console.log(`\nPARTIAL/PENDING — ${pending} check bắt buộc chưa chạy (KHÔNG phải full gate pass)`); process.exit(3) }
console.log('\nALL PASS')
process.exit(0)
