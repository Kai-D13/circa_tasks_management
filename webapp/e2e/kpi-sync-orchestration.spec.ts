import { test, expect } from '@playwright/test'
import {
  syncCampaignWithDeps,
  type CampaignConfig, type SyncCampaignDeps,
} from '../lib/kpi/syncCampaignCore'
import type { TargetRow } from '../lib/kpi/engine'
import type { AffiliateSyncHealth } from '../lib/affiliate/health'

// P3-B r1 — ORCHESTRATION + SIDE-EFFECT gate (audit: module thưởng phải chứng
// minh bằng test đếm số lần gọi, không chỉ code inspection). Mock toàn bộ deps,
// ghi lại THỨ TỰ gọi (seq) + số lần gọi (calls).

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
  ready: true, reason: null, runId: 'run-1',
  lastSuccessAt: '2026-07-23T09:00:00.000Z', ageMinutes: 60,
}

function mkDeps(cfg: CampaignConfig, over: Partial<SyncCampaignDeps> = {}) {
  const calls = { campaign: 0, targets: 0, stores: 0, health: 0, agg: 0, sa: 0, bq: 0, replace: 0 }
  const seq: string[] = []
  const deps: SyncCampaignDeps = {
    loadCampaign: async () => { calls.campaign++; seq.push('campaign'); return { data: cfg, error: null } },
    loadTargets: async () => { calls.targets++; seq.push('targets'); return { data: TARGETS, error: null } },
    loadStores: async (ids) => {
      calls.stores++; seq.push('stores')
      return { data: ids.map((id) => ({ id, code: id.toUpperCase(), store_type: 'os', is_active: true })), error: null }
    },
    getAffiliateHealth: async () => { calls.health++; seq.push('health'); return READY },
    aggregateAffiliate: async () => {
      calls.agg++; seq.push('agg')
      return { data: [{ store_id: 'store-a', vn_date: '2026-07-05', gmv: 200 }], error: null }
    },
    loadBqServiceAccount: () => { calls.sa++; seq.push('sa'); return { key: 'fake' } },
    runBqChunk: async () => {
      calls.bq++; seq.push('bq')
      return [{ pos_code: 'POS0001', date: '2026-07-02', gmv: 300 }]
    },
    replaceActuals: async () => { calls.replace++; seq.push('replace'); return { data: TARGETS.length, error: null } },
    nowMs: () => NOW,
    ...over,
  }
  return { deps, calls, seq }
}

test.describe('kpi sync orchestration @desktop', () => {
  test('OFFLINE-ONLY: BQ 1 lần, health/aggregate/stores 0 lần, replace ĐÚNG 1 lần', async () => {
    const { deps, calls } = mkDeps(CFG())
    const r = await syncCampaignWithDeps('camp-1', deps)
    expect(r.status).toBe('success')
    expect(calls).toEqual({ campaign: 1, targets: 1, stores: 0, health: 0, agg: 0, sa: 1, bq: 1, replace: 1 })
  })

  test('AFFILIATE-ONLY: BQ credential + BQ 0 lần; health/aggregate/replace đúng 1 lần', async () => {
    const { deps, calls } = mkDeps(CFG({ metric_offline: false, metric_affiliate: true }))
    const r = await syncCampaignWithDeps('camp-1', deps)
    expect(r.status).toBe('success')
    expect(calls.sa).toBe(0)
    expect(calls.bq).toBe(0)
    expect(calls.stores).toBe(1)
    expect(calls.health).toBe(1)
    expect(calls.agg).toBe(1)
    expect(calls.replace).toBe(1)
    if (r.status === 'success') {
      expect(r.unmatched).toEqual([]) // unmatched chỉ có nghĩa khi metric offline
    }
  })

  test('BOTH + health NOT ready: snapshot_preserved; BQ/aggregate/replace đều 0', async () => {
    const { deps, calls } = mkDeps(CFG({ metric_affiliate: true }), {
      getAffiliateHealth: async () => ({ ...READY, ready: false, reason: 'snapshot stale 400 phút (> 180)' }),
    })
    const r = await syncCampaignWithDeps('camp-1', deps)
    expect(r.status).toBe('snapshot_preserved')
    if (r.status === 'snapshot_preserved') expect(r.reason).toContain('stale')
    expect(calls.sa).toBe(0)
    expect(calls.bq).toBe(0)
    expect(calls.agg).toBe(0)
    expect(calls.replace).toBe(0)
  })

  test('BOTH + ready: HEALTH TRƯỚC BigQuery; replace đúng 1 lần và là bước cuối', async () => {
    const { deps, calls, seq } = mkDeps(CFG({ metric_affiliate: true }))
    const r = await syncCampaignWithDeps('camp-1', deps)
    expect(r.status).toBe('success')
    expect(calls.health).toBe(1)
    expect(calls.agg).toBe(1)
    expect(calls.sa).toBe(1)
    expect(calls.bq).toBe(1)
    expect(calls.replace).toBe(1)
    expect(seq.indexOf('health')).toBeLessThan(seq.indexOf('sa'))   // audit #7
    expect(seq.indexOf('health')).toBeLessThan(seq.indexOf('bq'))
    expect(seq[seq.length - 1]).toBe('replace')                     // audit #13
  })

  test('target FS/inactive/missing: snapshot_preserved; KHÔNG gọi nguồn nào, KHÔNG replace', async () => {
    for (const bad of [
      { store_type: 'fs', is_active: true },
      { store_type: 'os', is_active: false },
      null, // store không tồn tại
    ]) {
      const { deps, calls } = mkDeps(CFG({ metric_affiliate: true }), {
        loadStores: async (ids) => ({
          data: ids.slice(1).map((id) => ({ id, code: id, store_type: 'os', is_active: true }))
            .concat(bad ? [{ id: ids[0], code: ids[0], ...bad }] : []),
          error: null,
        }),
      })
      const r = await syncCampaignWithDeps('camp-1', deps)
      expect(r.status).toBe('snapshot_preserved')
      if (r.status === 'snapshot_preserved') expect(r.reason).toContain('không phải OS store active')
      expect(calls.health).toBe(0)
      expect(calls.agg).toBe(0)
      expect(calls.sa).toBe(0)
      expect(calls.bq).toBe(0)
      expect(calls.replace).toBe(0)
    }
  })

  test('no targets: snapshot_preserved, không gọi nguồn/replace', async () => {
    const { deps, calls } = mkDeps(CFG({ metric_affiliate: true }), {
      loadTargets: async () => ({ data: [], error: null }),
    })
    const r = await syncCampaignWithDeps('camp-1', deps)
    expect(r.status).toBe('snapshot_preserved')
    if (r.status === 'snapshot_preserved') expect(r.reason).toContain('chưa có target')
    expect(calls.stores + calls.health + calls.agg + calls.sa + calls.bq + calls.replace).toBe(0)
  })

  test('BigQuery lỗi: snapshot_preserved, KHÔNG replace', async () => {
    const { deps, calls } = mkDeps(CFG(), {
      runBqChunk: async () => { throw new Error('BigQuery timeout 504') },
    })
    const r = await syncCampaignWithDeps('camp-1', deps)
    expect(r.status).toBe('snapshot_preserved')
    if (r.status === 'snapshot_preserved') expect(r.reason).toContain('BigQuery lỗi')
    expect(calls.replace).toBe(0)
  })

  test('aggregate Affiliate lỗi: snapshot_preserved, KHÔNG replace', async () => {
    const { deps, calls } = mkDeps(CFG({ metric_offline: false, metric_affiliate: true }), {
      aggregateAffiliate: async () => ({ data: null, error: { message: 'fail-closed: 1 đơn thiếu completed_time' } }),
    })
    const r = await syncCampaignWithDeps('camp-1', deps)
    expect(r.status).toBe('snapshot_preserved')
    if (r.status === 'snapshot_preserved') expect(r.reason).toContain('rpc_aggregate_affiliate_gmv lỗi')
    expect(calls.replace).toBe(0)
  })

  test('replace lỗi: failed (snapshot cũ còn nguyên nhờ RPC transaction)', async () => {
    // override tự đếm — mock thay thế không đi qua counter của mkDeps
    let replaceCalls = 0
    const { deps } = mkDeps(CFG(), {
      replaceActuals: async () => { replaceCalls++; return { data: null, error: { message: 'SUM(daily) không khớp aggregate' } } },
    })
    const r = await syncCampaignWithDeps('camp-1', deps)
    expect(r.status).toBe('failed')
    if (r.status === 'failed') expect(r.error).toContain('Ghi actuals lỗi')
    expect(replaceCalls).toBe(1)
  })

  test('campaign không tồn tại / lỗi đọc: failed, không gọi gì thêm', async () => {
    const missing = mkDeps(CFG(), { loadCampaign: async () => ({ data: null, error: null }) })
    const r1 = await syncCampaignWithDeps('camp-x', missing.deps)
    expect(r1.status).toBe('failed')
    expect(missing.calls.targets + missing.calls.replace).toBe(0)

    const errored = mkDeps(CFG(), { loadCampaign: async () => ({ data: null, error: { message: 'db down' } }) })
    const r2 = await syncCampaignWithDeps('camp-x', errored.deps)
    expect(r2.status).toBe('failed')
  })

  test('offline: thiếu BQ service account: failed (lỗi config), không BQ/replace', async () => {
    const { deps, calls } = mkDeps(CFG(), { loadBqServiceAccount: () => { calls_sa_marker(); return null } })
    function calls_sa_marker() { /* sa được gọi nhưng trả null */ }
    const r = await syncCampaignWithDeps('camp-1', deps)
    expect(r.status).toBe('failed')
    if (r.status === 'failed') expect(r.error).toContain('BQ_SERVICE_ACCOUNT_KEY')
    expect(calls.bq).toBe(0)
    expect(calls.replace).toBe(0)
  })

  test('success: payload merge 2 nguồn đi vào replace (spot-check giá trị)', async () => {
    let captured: { daily: unknown[]; actuals: { store_id: string; actual_value: number; actual_offline: number; actual_affiliate: number }[] } | null = null
    const { deps } = mkDeps(CFG({ metric_affiliate: true }), {
      replaceActuals: async (_id, daily, actuals) => {
        captured = { daily, actuals: actuals as never }
        return { data: actuals.length, error: null }
      },
    })
    const r = await syncCampaignWithDeps('camp-1', deps)
    expect(r.status).toBe('success')
    const a = captured!.actuals.find((x) => x.store_id === 'store-a')!
    expect(a.actual_offline).toBe(300)   // BQ mock POS0001
    expect(a.actual_affiliate).toBe(200) // aggregate mock store-a
    expect(a.actual_value).toBe(500)
  })
})
