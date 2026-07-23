import { test, expect } from '@playwright/test'
import {
  buildCampaignSnapshot, effectiveEndISO, monthChunks, nextDayISO, vnDayRange, vnTodayISO,
  type SnapshotInput, type TargetRow,
} from '../lib/kpi/engine'

// P3-B unit gate — engine thuần 2 nguồn (không IO). Bao: boundary VN range,
// 3 chế độ metric, merge daily union, tier trên TỔNG, bất biến tổng = off+aff.

const T = (over: Partial<TargetRow> = {}): TargetRow => ({
  store_id: 'store-a', pos_code: 'POS0001', kpi_target: 1000,
  tiers: [
    { tier_order: 1, threshold_pct: 20, commission_amount: 111 },
    { tier_order: 2, threshold_pct: 50, commission_amount: 222 },
  ],
  ...over,
})
const m = (entries: [string, number][]) => new Map(entries)
const base = (over: Partial<SnapshotInput> = {}): SnapshotInput => ({
  campaignId: 'camp-1', targets: [T()],
  metricOffline: true, metricAffiliate: false,
  offlineByPos: new Map(), affiliateByStore: new Map(),
  snapshotTs: '2026-07-23T10:00:00.000Z',
  offlineSyncedAt: '2026-07-23T09:59:00.000Z',
  affiliateSyncedAt: null,
  ...over,
})

test.describe('kpi engine hai nguồn @desktop', () => {
  test('vnDayRange: p_from 00:00 VN ngày start, p_to EXCLUSIVE 00:00 VN ngày SAU effEnd', () => {
    expect(vnDayRange('2026-07-01', '2026-07-31')).toEqual({
      from: '2026-07-01T00:00:00+07:00',
      to: '2026-08-01T00:00:00+07:00',
    })
    expect(nextDayISO('2026-12-31')).toBe('2027-01-01') // rollover năm
  })

  test('effectiveEnd + vnToday: cap tại hôm nay VN', () => {
    expect(effectiveEndISO('2026-07-31', '2026-07-23')).toBe('2026-07-23')
    expect(effectiveEndISO('2026-07-10', '2026-07-23')).toBe('2026-07-10')
    // 17:30 UTC 22/07 = 00:30 VN 23/07
    expect(vnTodayISO(Date.parse('2026-07-22T17:30:00Z'))).toBe('2026-07-23')
  })

  test('monthChunks: campaign vắt 2 tháng → 2 cửa sổ đúng biên', () => {
    expect(monthChunks('2026-07-15', '2026-08-10')).toEqual([
      ['2026-07-15', '2026-07-31'],
      ['2026-08-01', '2026-08-10'],
    ])
  })

  test('OFFLINE-ONLY: parity logic cũ — totals/run_rate/tier/unmatched/raw_row_count', () => {
    const { daily, actuals, unmatchedPos } = buildCampaignSnapshot(base({
      targets: [T(), T({ store_id: 'store-b', pos_code: 'POS0002' })],
      offlineByPos: new Map([['POS0001', m([['2026-07-01', 100], ['2026-07-02', 200]])]]),
    }))
    expect(unmatchedPos).toEqual(['POS0002']) // có target, 0 row BQ
    const a = actuals.find((x) => x.store_id === 'store-a')!
    expect(a.actual_offline).toBe(300)
    expect(a.actual_affiliate).toBe(0)
    expect(a.actual_value).toBe(300)
    expect(a.run_rate).toBe(30)                  // 300/1000 — đạt bậc 20, chưa 50
    expect(a.achieved_tier_order).toBe(1)
    expect(a.store_commission_pool).toBe(111)
    expect(a.remaining_target).toBe(700)
    expect(a.raw_row_count).toBe(2)
    expect(a.offline_synced_at).toBe('2026-07-23T09:59:00.000Z')
    expect(a.affiliate_synced_at).toBeNull()     // metric tắt → null
    const d1 = daily.find((d) => d.store_id === 'store-a' && d.date === '2026-07-01')!
    expect(d1.gmv).toBe(100)
    expect(d1.gmv_affiliate).toBe(0)
    expect(d1.synced_at).toBe('2026-07-23T10:00:00.000Z')
  })

  test('AFFILIATE-ONLY: không BQ → unmatched RỖNG, offline=0, timestamp đúng nguồn', () => {
    const { daily, actuals, unmatchedPos } = buildCampaignSnapshot(base({
      metricOffline: false, metricAffiliate: true,
      offlineSyncedAt: null, affiliateSyncedAt: '2026-07-23T08:00:00.000Z',
      affiliateByStore: new Map([['store-a', m([['2026-07-05', 500]])]]),
    }))
    expect(unmatchedPos).toEqual([]) // unmatched chỉ có nghĩa khi metric offline bật
    const a = actuals[0]
    expect(a.actual_offline).toBe(0)
    expect(a.actual_affiliate).toBe(500)
    expect(a.actual_value).toBe(500)
    expect(a.run_rate).toBe(50)
    expect(a.achieved_tier_order).toBe(2)
    expect(a.offline_synced_at).toBeNull()
    expect(a.affiliate_synced_at).toBe('2026-07-23T08:00:00.000Z')
    expect(daily).toEqual([{
      campaign_id: 'camp-1', store_id: 'store-a', date: '2026-07-05',
      gmv: 0, gmv_affiliate: 500, synced_at: '2026-07-23T10:00:00.000Z',
    }])
  })

  test('BOTH: merge union theo (store, date) — cùng ngày gộp 1 row, khác ngày 2 row sorted', () => {
    const { daily, actuals } = buildCampaignSnapshot(base({
      metricAffiliate: true,
      affiliateSyncedAt: '2026-07-23T08:00:00.000Z',
      offlineByPos: new Map([['POS0001', m([['2026-07-01', 100], ['2026-07-03', 50]])]]),
      affiliateByStore: new Map([['store-a', m([['2026-07-01', 40], ['2026-07-02', 60]])]]),
    }))
    expect(daily.map((d) => [d.date, d.gmv, d.gmv_affiliate])).toEqual([
      ['2026-07-01', 100, 40],  // cùng ngày → 1 row đủ 2 nguồn
      ['2026-07-02', 0, 60],
      ['2026-07-03', 50, 0],
    ])
    const a = actuals[0]
    expect(a.actual_offline).toBe(150)
    expect(a.actual_affiliate).toBe(100)
    expect(a.actual_value).toBe(250)
    expect(a.raw_row_count).toBe(3)
  })

  test('BOTH: tier grade trên TỔNG — offline một mình chưa đạt, tổng đạt bậc 50', () => {
    const { actuals } = buildCampaignSnapshot(base({
      metricAffiliate: true,
      affiliateSyncedAt: '2026-07-23T08:00:00.000Z',
      offlineByPos: new Map([['POS0001', m([['2026-07-01', 400]])]]),  // 40% — chưa chạm 50
      affiliateByStore: new Map([['store-a', m([['2026-07-02', 200]])]]), // +20% → tổng 60%
    }))
    const a = actuals[0]
    expect(a.run_rate).toBe(60)
    expect(a.achieved_tier_order).toBe(2)
    expect(a.store_commission_pool).toBe(222)
  })

  test('kpi_target = 0 → run_rate null, không tier, remaining 0', () => {
    const { actuals } = buildCampaignSnapshot(base({
      targets: [T({ kpi_target: 0 })],
      offlineByPos: new Map([['POS0001', m([['2026-07-01', 100]])]]),
    }))
    expect(actuals[0].run_rate).toBeNull()
    expect(actuals[0].achieved_tier_order).toBeNull()
    expect(actuals[0].store_commission_pool).toBeNull()
    expect(actuals[0].remaining_target).toBe(0)
  })

  test('BẤT BIẾN: mọi row actual_value = actual_offline + actual_affiliate (khớp validate 092)', () => {
    const { actuals } = buildCampaignSnapshot(base({
      metricAffiliate: true,
      affiliateSyncedAt: 'x',
      targets: [T(), T({ store_id: 'store-b', pos_code: 'POS0002', kpi_target: 500 })],
      offlineByPos: new Map([['POS0001', m([['2026-07-01', 123.45]])], ['POS0002', m([['2026-07-01', 0]])]]),
      affiliateByStore: new Map([['store-b', m([['2026-07-09', 77.7]])]]),
    }))
    for (const a of actuals) {
      expect(a.actual_value).toBeCloseTo(a.actual_offline + a.actual_affiliate, 9)
    }
  })
})
