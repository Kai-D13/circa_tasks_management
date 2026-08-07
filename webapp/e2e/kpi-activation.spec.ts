import { test, expect } from '@playwright/test'
import { evaluateActivation, type ActivationCampaign, type ActivationDeps, type ActivationStore } from '../lib/kpi/activation'
import type { AffiliateSyncHealth } from '../lib/affiliate/health'

// P3-D r1 wiring gate (audit P2#2): chứng minh bằng ĐẾM CALL rằng evaluate
// activation gọi đúng dependency theo từng loại campaign. Behavior override
// nằm TRONG wrapper đã instrument (pattern r1.1 của orchestration).

// Mig 103: flags dạng object — BOTH_ON giữ semantics 'true' cũ, AFF_OFF giữ 'false'.
const BOTH_ON = { affiliate: true, customer: true }
const AFF_OFF = { affiliate: false, customer: true }
const READY: AffiliateSyncHealth = {
  ready: true, reason: null, runId: 'run-A',
  lastSuccessAt: '2026-07-23T09:00:00.000Z', ageMinutes: 30,
}
const CAMP = (over: Partial<ActivationCampaign> = {}): ActivationCampaign => ({
  id: 'camp-1', status: 'draft', updated_at: '2026-07-23T08:00:00.000Z', metric_type: 'gmv', metric_affiliate: false, ...over,
})
const TARGETS = [
  { store_id: 's-a', pos_code: 'POS0001' },
  { store_id: 's-b', pos_code: 'POS0002' },
]

interface Behavior {
  campaign?: () => Promise<{ data: ActivationCampaign | null; error: { message: string } | null }>
  targets?: () => Promise<{ data: typeof TARGETS | null; error: { message: string } | null }>
  stores?: (ids: string[]) => Promise<{ data: ActivationStore[] | null; error: { message: string } | null }>
  health?: () => Promise<AffiliateSyncHealth>
}

function mkDeps(camp: ActivationCampaign, behavior: Behavior = {}) {
  const calls = { campaign: 0, targets: 0, stores: 0, health: 0 }
  const deps: ActivationDeps = {
    loadCampaign: async () => { calls.campaign++; return behavior.campaign ? behavior.campaign() : { data: camp, error: null } },
    loadTargets: async () => { calls.targets++; return behavior.targets ? behavior.targets() : { data: TARGETS, error: null } },
    loadStores: async (ids) => {
      calls.stores++
      return behavior.stores ? behavior.stores(ids)
        : { data: ids.map((id) => ({ id, code: id.toUpperCase(), store_type: 'os', is_active: true })), error: null }
    },
    getHealth: async () => { calls.health++; return behavior.health ? behavior.health() : READY },
  }
  return { deps, calls }
}

test.describe('kpi activation wiring @desktop', () => {
  test('OFFLINE-ONLY: stores/health 0 lần; expectedRunId=null; expectedUpdatedAt đúng', async () => {
    const { deps, calls } = mkDeps(CAMP())
    const r = await evaluateActivation(deps, 'camp-1', BOTH_ON)
    expect(r).toEqual({ ok: true, expectedUpdatedAt: '2026-07-23T08:00:00.000Z', expectedRunId: null })
    expect(calls).toEqual({ campaign: 1, targets: 1, stores: 0, health: 0 })
  })

  test('AFFILIATE: đọc TOÀN BỘ target + stores 1 + health ĐÚNG 1 lần; expectedRunId từ health', async () => {
    let storesRequested: string[] = []
    const { deps, calls } = mkDeps(CAMP({ metric_affiliate: true }), {
      stores: async (ids) => {
        storesRequested = ids
        return { data: ids.map((id) => ({ id, code: id, store_type: 'os', is_active: true })), error: null }
      },
    })
    const r = await evaluateActivation(deps, 'camp-1', BOTH_ON)
    expect(r).toEqual({ ok: true, expectedUpdatedAt: '2026-07-23T08:00:00.000Z', expectedRunId: 'run-A' })
    expect(calls.health).toBe(1)
    expect(storesRequested).toEqual(['s-a', 's-b']) // đủ MỌI target, không limit
  })

  test('AFFILIATE + store FS/inactive/missing: lỗi + KHÔNG gọi health (3 biến thể)', async () => {
    for (const bad of [
      { store_type: 'fs', is_active: true },
      { store_type: 'os', is_active: false },
      null,
    ]) {
      const { deps, calls } = mkDeps(CAMP({ metric_affiliate: true }), {
        stores: async (ids) => ({
          data: ids.slice(1).map((id) => ({ id, code: id, store_type: 'os', is_active: true }))
            .concat(bad ? [{ id: ids[0], code: ids[0], ...bad }] : []),
          error: null,
        }),
      })
      const r = await evaluateActivation(deps, 'camp-1', BOTH_ON)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain('không phải OS store active')
      expect(calls.health).toBe(0) // store sai → dừng trước health
    }
  })

  test('AFFILIATE + health không ready → lỗi lý do cụ thể', async () => {
    const { deps } = mkDeps(CAMP({ metric_affiliate: true }), {
      health: async () => ({ ...READY, ready: false, reason: 'snapshot stale 400 phút (> 180)' }),
    })
    const r = await evaluateActivation(deps, 'camp-1', BOTH_ON)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('stale')
  })

  test('AFFILIATE + health THROW → fail-closed thành lỗi có cấu trúc', async () => {
    const { deps, calls } = mkDeps(CAMP({ metric_affiliate: true }), {
      health: async () => { throw new Error('network down') },
    })
    const r = await evaluateActivation(deps, 'camp-1', BOTH_ON)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('Không kiểm tra được nguồn affiliate')
    expect(calls.health).toBe(1) // vẫn được đếm
  })

  test('r1.2 FLAG OFF + campaign affiliate: lỗi NGAY sau load campaign — targets/stores/health đều 0', async () => {
    const { deps, calls } = mkDeps(CAMP({ metric_affiliate: true }))
    const r = await evaluateActivation(deps, 'camp-1', AFF_OFF)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('KPI_AFFILIATE_ENABLED')
    expect(calls).toEqual({ campaign: 1, targets: 0, stores: 0, health: 0 })
  })

  test('r1.2 FLAG OFF + campaign OFFLINE-only: vẫn kích hoạt bình thường (không phụ thuộc flag)', async () => {
    const { deps, calls } = mkDeps(CAMP())
    const r = await evaluateActivation(deps, 'camp-1', AFF_OFF)
    expect(r.ok).toBe(true)
    expect(calls.stores + calls.health).toBe(0)
  })

  test('no targets → lỗi; status active/ended/missing → lỗi tương ứng', async () => {
    const empty = mkDeps(CAMP({ metric_affiliate: true }), { targets: async () => ({ data: [], error: null }) })
    const r1 = await evaluateActivation(empty.deps, 'camp-1', BOTH_ON)
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.error).toContain('Chưa import target')
    expect(empty.calls.stores + empty.calls.health).toBe(0)

    const active = mkDeps(CAMP({ status: 'active' }))
    expect((await evaluateActivation(active.deps, 'camp-1', BOTH_ON)).ok).toBe(false)

    const ended = mkDeps(CAMP({ status: 'ended' }))
    const r3 = await evaluateActivation(ended.deps, 'camp-1', BOTH_ON)
    if (!r3.ok) expect(r3.error).toContain('kết thúc')

    const missing = mkDeps(CAMP(), { campaign: async () => ({ data: null, error: null }) })
    expect((await evaluateActivation(missing.deps, 'camp-1', BOTH_ON)).ok).toBe(false)
  })

  // ── Mig 103: campaign "Số khách Affiliate" ────────────────────────────────
  test('CUSTOMER + flag customer TẮT → lỗi NGAY sau load campaign, 0 call còn lại', async () => {
    const { deps, calls } = mkDeps(CAMP({ metric_type: 'affiliate_customer_count', metric_affiliate: true }))
    const r = await evaluateActivation(deps, 'camp-1', { affiliate: true, customer: false })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('KPI_AFFILIATE_CUSTOMER_ENABLED')
    expect(calls).toEqual({ campaign: 1, targets: 0, stores: 0, health: 0 })
  })

  test('CUSTOMER + flag customer BẬT (affiliate flag TẮT — độc lập): chạy đủ OS-active + health, expectedRunId từ health', async () => {
    const { deps, calls } = mkDeps(CAMP({ metric_type: 'affiliate_customer_count', metric_affiliate: true }))
    const r = await evaluateActivation(deps, 'camp-1', { affiliate: false, customer: true })
    expect(r).toEqual({ ok: true, expectedUpdatedAt: '2026-07-23T08:00:00.000Z', expectedRunId: 'run-A' })
    expect(calls).toEqual({ campaign: 1, targets: 1, stores: 1, health: 1 })
  })

  test('metric_type LẠ → fail-closed, không load targets', async () => {
    const { deps, calls } = mkDeps(CAMP({ metric_type: 'bogus' }))
    const r = await evaluateActivation(deps, 'camp-1', BOTH_ON)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('không hỗ trợ')
    expect(calls.targets).toBe(0)
  })
})
