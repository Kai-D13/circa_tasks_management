import { test, expect } from '@playwright/test'
import {
  syncCampaignWithDeps,
  type CampaignConfig, type StoreRow, type SyncCampaignDeps,
} from '../lib/kpi/syncCampaignCore'
import type { TargetRow } from '../lib/kpi/engine'
import type { AffiliateSyncHealth } from '../lib/affiliate/health'

// P3-B r1.1 — ORCHESTRATION + SIDE-EFFECT gate. r1.1 (audit): behavior override
// truyền VÀO TRONG wrapper đã instrument — mọi call LUÔN được đếm, override
// không thể bypass counter; + double-check health chống race; + metric guard.

const NOW = Date.parse('2026-07-23T10:00:00Z')
const CFG = (over: Partial<CampaignConfig> = {}): CampaignConfig => ({
  id: 'camp-1', start_date: '2026-07-01', end_date: '2026-07-31',
  metric_offline: true, metric_affiliate: false, ...over,
})
const TARGETS: TargetRow[] = [
  { store_id: 'store-a', pos_code: 'POS0001', kpi_target: 1000, tiers: [] },
  { store_id: 'store-b', pos_code: 'POS0002', kpi_target: 500, tiers: [] },
]
const READY: AffiliateSyncHealth = {
  ready: true, reason: null, runId: 'run-A',
  lastSuccessAt: '2026-07-23T09:00:00.000Z', ageMinutes: 60,
}
const NOT_READY = (reason: string): AffiliateSyncHealth =>
  ({ ready: false, reason, runId: 'run-A', lastSuccessAt: null, ageMinutes: null })

// Behavior = HÀM TRẢ KẾT QUẢ (không phải dep) — wrapper luôn đếm rồi mới ủy
// quyền cho behavior; override vì thế không thể bỏ qua counter (audit r1.1 P2).
interface Behavior {
  campaign?: () => Promise<{ data: CampaignConfig | null; error: { message: string } | null }>
  targets?: () => Promise<{ data: TargetRow[] | null; error: { message: string } | null }>
  stores?: (ids: string[]) => Promise<{ data: StoreRow[] | null; error: { message: string } | null }>
  health?: (call: number) => Promise<AffiliateSyncHealth>   // call = lần gọi thứ mấy (1-based)
  agg?: () => Promise<{ data: { store_id: string; vn_date: string; gmv: number }[] | null; error: { message: string } | null }>
  sa?: () => unknown | null
  bq?: () => Promise<Record<string, unknown>[]>
  replace?: SyncCampaignDeps['replaceActuals']
  flag?: boolean                                            // KPI_AFFILIATE_ENABLED (default true)
}

function mkDeps(cfg: CampaignConfig, behavior: Behavior = {}) {
  const calls = { campaign: 0, targets: 0, stores: 0, health: 0, agg: 0, sa: 0, bq: 0, replace: 0 }
  const seq: string[] = []
  const deps: SyncCampaignDeps = {
    loadCampaign: async () => { calls.campaign++; seq.push('campaign'); return behavior.campaign ? behavior.campaign() : { data: cfg, error: null } },
    loadTargets: async () => { calls.targets++; seq.push('targets'); return behavior.targets ? behavior.targets() : { data: TARGETS, error: null } },
    loadStores: async (ids) => {
      calls.stores++; seq.push('stores')
      return behavior.stores ? behavior.stores(ids)
        : { data: ids.map((id) => ({ id, code: id.toUpperCase(), store_type: 'os', is_active: true })), error: null }
    },
    getAffiliateHealth: async () => {
      calls.health++; seq.push(`health${calls.health}`)
      return behavior.health ? behavior.health(calls.health) : READY
    },
    aggregateAffiliate: async () => {
      calls.agg++; seq.push('agg')
      return behavior.agg ? behavior.agg()
        : { data: [{ store_id: 'store-a', vn_date: '2026-07-05', gmv: 200 }], error: null }
    },
    loadBqServiceAccount: () => { calls.sa++; seq.push('sa'); return behavior.sa ? behavior.sa() : { key: 'fake' } },
    runBqChunk: async () => {
      calls.bq++; seq.push('bq')
      return behavior.bq ? behavior.bq() : [{ pos_code: 'POS0001', date: '2026-07-02', gmv: 300 }]
    },
    replaceActuals: async (id, daily, actuals) => {
      calls.replace++; seq.push('replace')
      return behavior.replace ? behavior.replace(id, daily, actuals) : { data: actuals.length, error: null }
    },
    nowMs: () => NOW,
    isAffiliateFeatureEnabled: () => behavior.flag ?? true,
  }
  return { deps, calls, seq }
}

test.describe('kpi sync orchestration @desktop', () => {
  test('OFFLINE-ONLY: BQ 1 lần; health/aggregate/stores 0; replace ĐÚNG 1 lần', async () => {
    const { deps, calls } = mkDeps(CFG())
    const r = await syncCampaignWithDeps('camp-1', deps)
    expect(r.status).toBe('success')
    expect(calls).toEqual({ campaign: 1, targets: 1, stores: 0, health: 0, agg: 0, sa: 1, bq: 1, replace: 1 })
  })

  test('AFFILIATE-ONLY: BQ credential + BQ 0 lần; health ĐÚNG 2 LẦN (double-check); agg/replace 1', async () => {
    const { deps, calls } = mkDeps(CFG({ metric_offline: false, metric_affiliate: true }))
    const r = await syncCampaignWithDeps('camp-1', deps)
    expect(r.status).toBe('success')
    expect(calls).toEqual({ campaign: 1, targets: 1, stores: 1, health: 2, agg: 1, sa: 0, bq: 0, replace: 1 })
    if (r.status === 'success') expect(r.unmatched).toEqual([])
  })

  test('BOTH + ready ổn định: thứ tự health1 → agg → health2 → BQ; replace CUỐI đúng 1 lần', async () => {
    const { deps, calls, seq } = mkDeps(CFG({ metric_affiliate: true }))
    const r = await syncCampaignWithDeps('camp-1', deps)
    expect(r.status).toBe('success')
    expect(calls.health).toBe(2)
    expect(calls.agg).toBe(1)
    expect(calls.sa).toBe(1)
    expect(calls.bq).toBe(1)
    expect(calls.replace).toBe(1)
    expect(seq.indexOf('health1')).toBeLessThan(seq.indexOf('agg'))    // health TRƯỚC aggregate
    expect(seq.indexOf('agg')).toBeLessThan(seq.indexOf('health2'))    // double-check SAU aggregate
    expect(seq.indexOf('health2')).toBeLessThan(seq.indexOf('sa'))     // rồi mới BigQuery (audit #7)
    expect(seq.indexOf('health2')).toBeLessThan(seq.indexOf('bq'))
    expect(seq[seq.length - 1]).toBe('replace')                        // audit #13
  })

  test('RACE: health lần 2 chuyển running → preserved; BQ/replace = 0 (agg đã 1)', async () => {
    const { deps, calls } = mkDeps(CFG({ metric_affiliate: true }), {
      health: async (call) => call === 1 ? READY : NOT_READY('sync đang chạy — chờ run kết thúc'),
    })
    const r = await syncCampaignWithDeps('camp-1', deps)
    expect(r.status).toBe('snapshot_preserved')
    if (r.status === 'snapshot_preserved') expect(r.reason).toContain('đổi trạng thái trong lúc aggregate')
    expect(calls.health).toBe(2)
    expect(calls.agg).toBe(1)
    expect(calls.sa).toBe(0)
    expect(calls.bq).toBe(0)
    expect(calls.replace).toBe(0)
  })

  test('RACE: health lần 2 đổi runId (sync mới đã xong) → preserved; BQ/replace = 0', async () => {
    const { deps, calls } = mkDeps(CFG({ metric_affiliate: true }), {
      health: async (call) => call === 1 ? READY : { ...READY, runId: 'run-B' },
    })
    const r = await syncCampaignWithDeps('camp-1', deps)
    expect(r.status).toBe('snapshot_preserved')
    if (r.status === 'snapshot_preserved') expect(r.reason).toContain('runId run-A → run-B')
    expect(calls.health).toBe(2)
    expect(calls.bq).toBe(0)
    expect(calls.replace).toBe(0)
  })

  test('RACE: health lần 2 stale/failed → preserved; BQ/replace = 0', async () => {
    const { deps, calls } = mkDeps(CFG({ metric_affiliate: true }), {
      health: async (call) => call === 1 ? READY : NOT_READY('run mới nhất FAILED: Mongo down'),
    })
    const r = await syncCampaignWithDeps('camp-1', deps)
    expect(r.status).toBe('snapshot_preserved')
    expect(calls.health).toBe(2)
    expect(calls.replace).toBe(0)
  })

  test('health lần 1 NOT ready: preserved NGAY; agg/BQ/replace = 0, health đúng 1 lần', async () => {
    const { deps, calls } = mkDeps(CFG({ metric_affiliate: true }), {
      health: async () => NOT_READY('snapshot stale 400 phút (> 180)'),
    })
    const r = await syncCampaignWithDeps('camp-1', deps)
    expect(r.status).toBe('snapshot_preserved')
    if (r.status === 'snapshot_preserved') expect(r.reason).toContain('stale')
    expect(calls.health).toBe(1) // override VẪN được đếm (instrumentation r1.1)
    expect(calls.agg).toBe(0)
    expect(calls.sa).toBe(0)
    expect(calls.bq).toBe(0)
    expect(calls.replace).toBe(0)
  })

  test('r1.2 FLAG OFF + AFFILIATE-ONLY: snapshot_preserved; targets/health/BQ/replace đều 0', async () => {
    const { deps, calls } = mkDeps(CFG({ metric_offline: false, metric_affiliate: true }), { flag: false })
    const r = await syncCampaignWithDeps('camp-1', deps)
    expect(r.status).toBe('snapshot_preserved')
    if (r.status === 'snapshot_preserved') expect(r.reason).toContain('KPI_AFFILIATE_ENABLED')
    expect(calls).toEqual({ campaign: 1, targets: 0, stores: 0, health: 0, agg: 0, sa: 0, bq: 0, replace: 0 })
  })

  test('r1.2 FLAG OFF + HYBRID: preserve TOÀN BỘ — không ghi partial offline', async () => {
    const { deps, calls } = mkDeps(CFG({ metric_affiliate: true }), { flag: false })
    const r = await syncCampaignWithDeps('camp-1', deps)
    expect(r.status).toBe('snapshot_preserved')
    expect(calls.sa).toBe(0)      // không đụng cả BigQuery
    expect(calls.bq).toBe(0)
    expect(calls.replace).toBe(0) // không partial write
  })

  test('r1.2 FLAG OFF + OFFLINE-ONLY: vẫn success bình thường', async () => {
    const { deps, calls } = mkDeps(CFG(), { flag: false })
    const r = await syncCampaignWithDeps('camp-1', deps)
    expect(r.status).toBe('success')
    expect(calls.replace).toBe(1)
  })

  // P3-G (audit 24/07): campaign chưa đến kỳ → snapshot_preserved, KHÔNG gọi
  // targets/health/Mongo/BigQuery/replace ở CẢ 3 cấu hình metric — không ghi
  // snapshot 0đ, không cập nhật timestamp sync.
  test('P3-G CHƯA ĐẾN KỲ: preserved + 0 call nguồn/ghi ở cả 3 cấu hình metric', async () => {
    for (const metrics of [
      { metric_offline: true, metric_affiliate: false },
      { metric_offline: false, metric_affiliate: true },
      { metric_offline: true, metric_affiliate: true },
    ]) {
      const { deps, calls } = mkDeps(CFG({ ...metrics, start_date: '2026-08-01', end_date: '2026-08-31' }))
      const r = await syncCampaignWithDeps('camp-1', deps)
      expect(r.status).toBe('snapshot_preserved')
      if (r.status === 'snapshot_preserved') expect(r.reason).toContain('chưa đến kỳ')
      expect(calls).toEqual({ campaign: 1, targets: 0, stores: 0, health: 0, agg: 0, sa: 0, bq: 0, replace: 0 })
    }
  })

  test('P3-G BIÊN NGÀY BẮT ĐẦU: start_date == hôm nay VN → sync chạy bình thường', async () => {
    // NOW (2026-07-23T10:00Z) = 23/07 giờ VN → start đúng hôm nay KHÔNG bị chặn.
    const { deps, calls } = mkDeps(CFG({ start_date: '2026-07-23' }))
    const r = await syncCampaignWithDeps('camp-1', deps)
    expect(r.status).toBe('success')
    expect(calls.replace).toBe(1)
  })

  test('METRIC GUARD: cả 2 metric tắt → failed; mọi call sau campaign = 0 (r1.1)', async () => {
    const { deps, calls } = mkDeps(CFG({ metric_offline: false, metric_affiliate: false }))
    const r = await syncCampaignWithDeps('camp-1', deps)
    expect(r.status).toBe('failed')
    if (r.status === 'failed') expect(r.error).toContain('không bật chỉ số')
    expect(calls).toEqual({ campaign: 1, targets: 0, stores: 0, health: 0, agg: 0, sa: 0, bq: 0, replace: 0 })
  })

  test('target FS/inactive/missing: preserved; KHÔNG health/nguồn/replace (3 biến thể)', async () => {
    for (const bad of [
      { store_type: 'fs', is_active: true },
      { store_type: 'os', is_active: false },
      null,
    ]) {
      const { deps, calls } = mkDeps(CFG({ metric_affiliate: true }), {
        stores: async (ids) => ({
          data: ids.slice(1).map((id) => ({ id, code: id, store_type: 'os', is_active: true }))
            .concat(bad ? [{ id: ids[0], code: ids[0], ...bad }] : []),
          error: null,
        }),
      })
      const r = await syncCampaignWithDeps('camp-1', deps)
      expect(r.status).toBe('snapshot_preserved')
      if (r.status === 'snapshot_preserved') expect(r.reason).toContain('không phải OS store active')
      expect(calls.stores).toBe(1) // override vẫn được đếm
      expect(calls.health + calls.agg + calls.sa + calls.bq + calls.replace).toBe(0)
    }
  })

  test('no targets: preserved; không stores/health/nguồn/replace', async () => {
    const { deps, calls } = mkDeps(CFG({ metric_affiliate: true }), {
      targets: async () => ({ data: [], error: null }),
    })
    const r = await syncCampaignWithDeps('camp-1', deps)
    expect(r.status).toBe('snapshot_preserved')
    expect(calls.targets).toBe(1)
    expect(calls.stores + calls.health + calls.agg + calls.sa + calls.bq + calls.replace).toBe(0)
  })

  test('BigQuery lỗi: preserved; bq VẪN đếm = 1, replace = 0', async () => {
    const { deps, calls } = mkDeps(CFG(), {
      bq: async () => { throw new Error('BigQuery timeout 504') },
    })
    const r = await syncCampaignWithDeps('camp-1', deps)
    expect(r.status).toBe('snapshot_preserved')
    if (r.status === 'snapshot_preserved') expect(r.reason).toContain('BigQuery lỗi')
    expect(calls.bq).toBe(1) // instrumentation r1.1: lỗi vẫn được đếm
    expect(calls.replace).toBe(0)
  })

  test('aggregate Affiliate lỗi: preserved; agg VẪN đếm = 1, health lần 2 không gọi, replace = 0', async () => {
    const { deps, calls } = mkDeps(CFG({ metric_offline: false, metric_affiliate: true }), {
      agg: async () => ({ data: null, error: { message: 'fail-closed: 1 đơn thiếu completed_time' } }),
    })
    const r = await syncCampaignWithDeps('camp-1', deps)
    expect(r.status).toBe('snapshot_preserved')
    if (r.status === 'snapshot_preserved') expect(r.reason).toContain('rpc_aggregate_affiliate_gmv lỗi')
    expect(calls.agg).toBe(1)
    expect(calls.health).toBe(1) // dừng trước double-check
    expect(calls.replace).toBe(0)
  })

  test('replace lỗi: failed; replace VẪN đếm = 1 (snapshot cũ nguyên nhờ RPC transaction)', async () => {
    const { deps, calls } = mkDeps(CFG(), {
      replace: async () => ({ data: null, error: { message: 'SUM(daily) không khớp aggregate' } }),
    })
    const r = await syncCampaignWithDeps('camp-1', deps)
    expect(r.status).toBe('failed')
    if (r.status === 'failed') expect(r.error).toContain('Ghi actuals lỗi')
    expect(calls.replace).toBe(1)
  })

  test('campaign không tồn tại / lỗi đọc: failed; targets/replace = 0', async () => {
    const missing = mkDeps(CFG(), { campaign: async () => ({ data: null, error: null }) })
    expect((await syncCampaignWithDeps('camp-x', missing.deps)).status).toBe('failed')
    expect(missing.calls.campaign).toBe(1)
    expect(missing.calls.targets + missing.calls.replace).toBe(0)

    const errored = mkDeps(CFG(), { campaign: async () => ({ data: null, error: { message: 'db down' } }) })
    expect((await syncCampaignWithDeps('camp-x', errored.deps)).status).toBe('failed')
  })

  test('offline thiếu BQ service account: failed; sa VẪN đếm = 1, bq/replace = 0', async () => {
    const { deps, calls } = mkDeps(CFG(), { sa: () => null })
    const r = await syncCampaignWithDeps('camp-1', deps)
    expect(r.status).toBe('failed')
    if (r.status === 'failed') expect(r.error).toContain('BQ_SERVICE_ACCOUNT_KEY')
    expect(calls.sa).toBe(1)
    expect(calls.bq).toBe(0)
    expect(calls.replace).toBe(0)
  })

  test('success BOTH: payload merge 2 nguồn đi vào replace (spot-check)', async () => {
    let captured: { store_id: string; actual_value: number; actual_offline: number; actual_affiliate: number }[] = []
    const { deps } = mkDeps(CFG({ metric_affiliate: true }), {
      replace: async (_id, _daily, actuals) => {
        captured = actuals as never
        return { data: actuals.length, error: null }
      },
    })
    const r = await syncCampaignWithDeps('camp-1', deps)
    expect(r.status).toBe('success')
    const a = captured.find((x) => x.store_id === 'store-a')!
    expect(a.actual_offline).toBe(300)
    expect(a.actual_affiliate).toBe(200)
    expect(a.actual_value).toBe(500)
  })
})
