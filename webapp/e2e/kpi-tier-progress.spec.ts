import { test, expect } from '@playwright/test'
import {
  buildCampaignResultModel, buildTierProgress,
  type ResultActualRow, type ResultCampaign, type ResultTargetRow, type ResultTierRow,
} from '../lib/kpi/resultModel'

// Tier Progress (contract 28/07) — unit gate cho công thức từng bậc dùng chung
// Super/SM (bảng desktop) + QLCH (Mốc thưởng):
//   target_amount = ceil(kpi_target × threshold_pct / 100)
//   remaining     = max(target_amount − actual, 0); backend reached → ÉP 0
//   chưa sync → remaining null ('—', KHÔNG phải 0)

const TIERS: ResultTierRow[] = [
  { tier_order: 2, threshold_pct: 100, commission_amount: 30_000_000 }, // cố tình đảo thứ tự
  { tier_order: 1, threshold_pct: 90, commission_amount: 20_000_000 },
  { tier_order: 3, threshold_pct: 105, commission_amount: 40_000_000 },
]
const KPI = 351_500_000

test.describe('kpi tier progress @desktop', () => {
  test('sort theo tier_order + target_amount = CEIL(kpi × pct/100)', () => {
    const tp = buildTierProgress(KPI, { actual_value: 0, achieved_tier_order: null }, TIERS)
    expect(tp.map((t) => t.tier_order)).toEqual([1, 2, 3])
    expect(tp[0].target_amount).toBe(Math.ceil(KPI * 0.9))   // 316.350.000
    expect(tp[1].target_amount).toBe(KPI)                    // 100%
    expect(tp[2].target_amount).toBe(Math.ceil(KPI * 1.05))  // 369.075.000
  })

  test('CHƯA SYNC (actual null) → mọi bậc remaining = null (UI "—", không phải 0)', () => {
    const tp = buildTierProgress(KPI, null, TIERS)
    expect(tp.every((t) => t.remaining_amount === null && t.reached === false)).toBe(true)
  })

  test('DƯỚI BẬC 1: remaining từng bậc đúng công thức, không bậc nào reached', () => {
    const actual = 200_000_000
    const tp = buildTierProgress(KPI, { actual_value: actual, achieved_tier_order: null }, TIERS)
    expect(tp[0].remaining_amount).toBe(Math.ceil(KPI * 0.9) - actual)
    expect(tp[1].remaining_amount).toBe(KPI - actual)
    expect(tp[2].remaining_amount).toBe(Math.ceil(KPI * 1.05) - actual)
    expect(tp.every((t) => !t.reached)).toBe(true)
  })

  test('GIỮA BẬC 1/2 (backend achieved=1): bậc 1 Đã đạt remaining ÉP 0; bậc 2/3 còn thiếu đúng số', () => {
    const actual = 330_000_000 // ~93.9%
    const tp = buildTierProgress(KPI, { actual_value: actual, achieved_tier_order: 1 }, TIERS)
    expect(tp[0]).toMatchObject({ reached: true, remaining_amount: 0 })
    expect(tp[1]).toMatchObject({ reached: false, remaining_amount: KPI - actual })
    expect(tp[2]).toMatchObject({ reached: false, remaining_amount: Math.ceil(KPI * 1.05) - actual })
  })

  test('ĐÚNG NGƯỠNG + làm tròn run_rate: backend nói đạt là ĐẠT (remaining 0) dù actual < ceil target', () => {
    // actual thấp hơn ceil(90%) đúng 1đ nhưng backend đã ghi achieved=1 (run_rate
    // làm tròn) → contract: backend là nguồn sự thật, ép remaining = 0.
    const actual = Math.ceil(KPI * 0.9) - 1
    const tp = buildTierProgress(KPI, { actual_value: actual, achieved_tier_order: 1 }, TIERS)
    expect(tp[0]).toMatchObject({ reached: true, remaining_amount: 0 })
  })

  test('VƯỢT BẬC CUỐI (achieved=3): mọi bậc Đã đạt, remaining 0 toàn bộ', () => {
    const tp = buildTierProgress(KPI, { actual_value: 400_000_000, achieved_tier_order: 3 }, TIERS)
    expect(tp.every((t) => t.reached && t.remaining_amount === 0)).toBe(true)
  })

  test('KHÔNG hardcode 3 bậc: 1 tier và 5 tier đều render đủ; actual vượt target thô → remaining clamp 0', () => {
    expect(buildTierProgress(KPI, null, [TIERS[1]])).toHaveLength(1)
    const five: ResultTierRow[] = Array.from({ length: 5 }, (_, i) => ({
      tier_order: i + 1, threshold_pct: 80 + i * 10, commission_amount: (i + 1) * 1_000_000,
    }))
    const tp = buildTierProgress(100, { actual_value: 1000, achieved_tier_order: null }, five)
    expect(tp).toHaveLength(5)
    expect(tp.every((t) => t.remaining_amount === 0)).toBe(true) // clamp, không âm
  })

  test('TÍCH HỢP model: rows mang tierProgress; maxTierCount = max theo store (cột động desktop)', () => {
    const camp: ResultCampaign = {
      id: 'c1', name: 'C', start_date: '2026-07-01', end_date: '2026-07-31',
      status: 'active', metric_offline: true, metric_affiliate: false,
    }
    const t = (store: string, tiers: ResultTierRow[]): ResultTargetRow => ({
      id: `t-${store}`, store_id: store, pos_code: null, kpi_target: 1000,
      store_kpi_group: 'G', stores: { name: store }, kpi_campaign_store_tiers: tiers,
    })
    const a: ResultActualRow = {
      store_id: 'a', actual_value: 950, run_rate: 95, remaining_target: 50,
      achieved_tier_order: 1, store_commission_pool: 5, synced_at: '2026-07-28T02:00:00Z',
      actual_offline: 950, actual_affiliate: 0, offline_order_count: null,
      offline_synced_at: null, affiliate_synced_at: null,
    }
    const m = buildCampaignResultModel(camp, [t('a', TIERS), t('b', [TIERS[1]])], [a], '2026-07-28')
    expect(m.maxTierCount).toBe(3)
    expect(m.rows[0].tierProgress.map((x) => x.tier_order)).toEqual([1, 2, 3])
    expect(m.rows[0].tierProgress[0]).toMatchObject({ reached: true, remaining_amount: 0 })
    // Store b chưa sync → '—' contract
    expect(m.rows[1].tierProgress).toHaveLength(1)
    expect(m.rows[1].tierProgress[0].remaining_amount).toBeNull()
  })
})
