import { test, expect } from '@playwright/test'
import {
  buildCampaignResultModel, smScopeState,
  type ResultActualRow, type ResultCampaign, type ResultTargetRow,
} from '../lib/kpi/resultModel'

// SM Dashboard r1 unit gate — MỘT nguồn công thức cho màn Kết quả (Super ↔ SM).
// Yêu cầu audit: cùng input → cùng output; SM đưa rows RLS-scoped (subset) →
// totals = tổng đúng phạm vi; hybrid identity; chưa sync không ra 0 giả.

const CAMP = (over: Partial<ResultCampaign> = {}): ResultCampaign => ({
  id: 'c1', name: 'KPI 07/2026', start_date: '2026-07-01', end_date: '2026-07-31',
  status: 'active', metric_offline: true, metric_affiliate: true, ...over,
})
const T = (store: string, target: number): ResultTargetRow => ({
  id: `t-${store}`, store_id: store, pos_code: `POS-${store}`, kpi_target: target,
  store_kpi_group: 'Nhỏ hơn 500 triệu', stores: { name: `Store ${store}` },
  kpi_campaign_store_tiers: [],
})
const A = (store: string, value: number, off: number, aff: number, over: Partial<ResultActualRow> = {}): ResultActualRow => ({
  store_id: store, actual_value: value, run_rate: 50, remaining_target: null,
  achieved_tier_order: null, store_commission_pool: null,
  synced_at: '2026-07-27T10:00:00Z', actual_offline: off, actual_affiliate: aff,
  offline_synced_at: null, affiliate_synced_at: null, ...over,
})
const TODAY = '2026-07-27'

test.describe('kpi result model @desktop', () => {
  test('cùng input → cùng output (deterministic) + totals đúng công thức super', () => {
    const targets = [T('a', 1000), T('b', 500)]
    const actuals = [A('a', 300, 200, 100, { achieved_tier_order: 1, store_commission_pool: 111 }), A('b', 200, 150, 50)]
    const m1 = buildCampaignResultModel(CAMP(), targets, actuals, TODAY)
    const m2 = buildCampaignResultModel(CAMP(), targets, actuals, TODAY)
    expect(m1).toEqual(m2)
    expect(m1.totalTarget).toBe(1500)
    expect(m1.totalActual).toBe(500)
    expect(m1.totalOffline).toBe(350)
    expect(m1.totalAffiliate).toBe(150)
    expect(m1.completionPct).toBeCloseTo((500 / 1500) * 100, 6)
    expect(m1.totalCommission).toBe(111)
    expect(m1.reachedStoreCount).toBe(1)
    expect(m1.storeCount).toBe(2)
    expect(m1.deadlineLabel).toBe('Còn 5 ngày') // 27→31/07, tính cả hôm nay
    expect(m1.showBreakdown).toBe(true)
    expect(m1.rows).toHaveLength(2)
  })

  test('SM SCOPE = SUBSET: model trên rows RLS-scoped ra đúng tổng phạm vi (không leak store ngoài)', () => {
    const tAll = [T('a', 1000), T('b', 500), T('c', 800)]
    const aAll = [A('a', 300, 200, 100), A('b', 200, 150, 50), A('c', 640, 600, 40)]
    // SM được phân công b + c → RLS chỉ trả rows b,c
    const mSm = buildCampaignResultModel(CAMP(), tAll.slice(1), aAll.slice(1), TODAY)
    expect(mSm.totalTarget).toBe(1300)
    expect(mSm.totalActual).toBe(840)
    expect(mSm.storeCount).toBe(2)
    expect(mSm.rows.map((r) => r.storeId)).toEqual(['b', 'c'])
    // Super (full) vẫn ra tổng toàn campaign — cùng công thức
    const mSuper = buildCampaignResultModel(CAMP(), tAll, aAll, TODAY)
    expect(mSuper.totalActual).toBe(1140)
    expect(mSuper.storeCount).toBe(3)
  })

  test('HYBRID identity: totalActual = totalOffline + totalAffiliate khi rows nhất quán', () => {
    const m = buildCampaignResultModel(CAMP(),
      [T('a', 1000), T('b', 500)],
      [A('a', 300, 200, 100), A('b', 250, 180, 70)], TODAY)
    expect(m.totalActual).toBe(m.totalOffline + m.totalAffiliate)
  })

  test('CHƯA SYNC (actuals rỗng): lastSyncedAt null · performance null · KHÔNG số giả (pct 0, rows actual null)', () => {
    const m = buildCampaignResultModel(CAMP(), [T('a', 1000)], [], TODAY)
    expect(m.lastSyncedAt).toBeNull()
    expect(m.performance).toBeNull()
    expect(m.completionPct).toBe(0)
    expect(m.totalActual).toBe(0)
    expect(m.rows[0].actual).toBeNull()
  })

  test('deadline: paused → Tạm dừng · ended/quá hạn → Đã kết thúc · offline-only → KHÔNG breakdown', () => {
    expect(buildCampaignResultModel(CAMP({ status: 'paused' }), [], [], TODAY).deadlineLabel).toBe('Tạm dừng')
    expect(buildCampaignResultModel(CAMP({ status: 'ended' }), [], [], TODAY).deadlineLabel).toBe('Đã kết thúc')
    expect(buildCampaignResultModel(CAMP({ end_date: '2026-07-20' }), [], [], TODAY).deadlineLabel).toBe('Đã kết thúc')
    expect(buildCampaignResultModel(CAMP({ metric_affiliate: false }), [], [], TODAY).showBreakdown).toBe(false)
  })

  test('r3 smScopeState: campaign/store ngoài scope → forbidden, KHÔNG fallback', () => {
    expect(smScopeState(true, undefined, false)).toBe('ok')          // không filter store
    expect(smScopeState(true, 'store-b', true)).toBe('ok')
    expect(smScopeState(false, undefined, false)).toBe('campaign-out-of-scope')
    expect(smScopeState(false, 'store-b', true)).toBe('campaign-out-of-scope') // campaign thắng
    expect(smScopeState(true, 'store-x', false)).toBe('store-out-of-scope')
  })
})
