import { test, expect } from '@playwright/test'
import { metricPresentation, offlineOrderLine } from '../lib/kpi/campaignDisplay'
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
  offline_order_count: null,
  offline_synced_at: null, affiliate_synced_at: null, ...over,
})
const TODAY = '2026-07-27'
const TODAY_TS = '2026-07-27T10:00:00Z'

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

  test('r3+r6 smScopeState: campaign ngoài scope → forbidden KHÔNG fallback; hết contract ?store= (r6 bỏ filter — URL cũ được page redirect canonicalize)', () => {
    expect(smScopeState(true)).toBe('ok')
    expect(smScopeState(false)).toBe('campaign-out-of-scope')
  })
})

// ── 10/08 (stakeholder): cột 'Còn thiếu' → 'Trung bình/ngày cần đạt' ────────
// Công thức DÙNG CHUNG với card Staff (lib/kpi/performance.requiredPerDay):
//   remaining / max(daysLeft, 1), daysLeft tính CẢ hôm nay.
test.describe('kpi requiredPerDay (bảng kết quả Super/SM) @desktop', () => {
  const rowOf = (m: ReturnType<typeof buildCampaignResultModel>, store: string) =>
    m.rows.find((r) => r.storeId === store)!

  test('r1.1 (P1): remaining_target của ENGINE được ƯU TIÊN — không tự tính lại target-actual', () => {
    // target 1000, actual 300 (tự tính ra 700/5 = 140) NHƯNG engine ghi
    // remaining_target = 650 → phải ra 650/5 = 130. Khóa việc UI luôn dùng
    // cùng nguồn với hero Staff.
    const m = buildCampaignResultModel(
      CAMP(), [T('a', 1000)], [A('a', 300, 300, 0, { remaining_target: 650 })], TODAY)
    expect(rowOf(m, 'a').requiredPerDay).toBeCloseTo(130, 6)
  })

  test('đang chạy: remaining / số ngày còn lại (tính cả hôm nay)', () => {
    // 27/07 → 31/07 = 5 ngày; target 1000, actual 300 → 700/5 = 140
    const m = buildCampaignResultModel(CAMP(), [T('a', 1000)], [A('a', 300, 300, 0)], TODAY)
    expect(rowOf(m, 'a').requiredPerDay).toBeCloseTo(140, 6)
  })

  test('còn ĐÚNG một ngày (hôm nay = end_date) → chia 1', () => {
    const m = buildCampaignResultModel(CAMP(), [T('a', 1000)], [A('a', 400, 400, 0)], '2026-07-31')
    expect(rowOf(m, 'a').requiredPerDay).toBeCloseTo(600, 6)
  })

  test('đã đạt/vượt target → 0 (KHÔNG phải null)', () => {
    const m = buildCampaignResultModel(CAMP(), [T('a', 1000)], [A('a', 1200, 1200, 0)], TODAY)
    expect(rowOf(m, 'a').requiredPerDay).toBe(0)
  })

  test('chưa đồng bộ actual → null (UI hiện "—", không ra số giả)', () => {
    const m = buildCampaignResultModel(CAMP(), [T('a', 1000)], [], TODAY)
    expect(rowOf(m, 'a').actual).toBeNull()
    expect(rowOf(m, 'a').requiredPerDay).toBeNull()
  })

  test('campaign đã hết ngày (today > end_date) → null; target ≤ 0 → null', () => {
    const ended = buildCampaignResultModel(CAMP(), [T('a', 1000)], [A('a', 300, 300, 0)], '2026-08-05')
    expect(rowOf(ended, 'a').requiredPerDay).toBeNull()
    const noTarget = buildCampaignResultModel(CAMP(), [T('a', 0)], [A('a', 300, 300, 0)], TODAY)
    expect(rowOf(noTarget, 'a').requiredPerDay).toBeNull()
  })

  test('customer campaign: cùng công thức + presentation ra "N khách"', () => {
    const camp = CAMP({
      metric_offline: false, metric_affiliate: true,
      metric_type: 'affiliate_customer_count',
    })
    // target 100 khách, actual 40 → 60/5 = 12 khách/ngày
    const m = buildCampaignResultModel(camp, [T('a', 100)], [A('a', 40, 0, 40)], TODAY)
    const perDay = rowOf(m, 'a').requiredPerDay
    expect(perDay).toBeCloseTo(12, 6)
    // Bảng render qua metricPresentation của ĐÚNG metric_type campaign.
    const pres = metricPresentation(m.campaign.metric_type)
    expect(pres.value(perDay!)).toBe('12 khách')
    expect(metricPresentation('gmv').value(perDay!)).toContain('₫')   // GMV vẫn tiền
  })

  test('Super ↔ SM: cùng row input → cùng requiredPerDay (subset RLS không đổi số)', () => {
    const tAll = [T('a', 1000), T('b', 500)]
    const aAll = [A('a', 300, 300, 0), A('b', 100, 100, 0)]
    const sup = buildCampaignResultModel(CAMP(), tAll, aAll, TODAY)
    const sm = buildCampaignResultModel(CAMP(), tAll.slice(1), aAll.slice(1), TODAY)
    expect(rowOf(sm, 'b').requiredPerDay).toBe(rowOf(sup, 'b').requiredPerDay)
    expect(rowOf(sm, 'b').requiredPerDay).toBeCloseTo(80, 6)   // (500-100)/5
  })

  test('remaining_target VẪN còn trong model (engine/export/tier dùng) — chỉ bỏ CỘT UI', () => {
    const m = buildCampaignResultModel(
      CAMP(), [T('a', 1000)], [A('a', 300, 300, 0, { remaining_target: 700 })], TODAY)
    expect(rowOf(m, 'a').actual!.remaining_target).toBe(700)
  })
})

// ── 105 (11/08): Số đơn Offline + AOV ───────────────────────────────────────
// Contract: AOV = SUM(net_revenue)/SUM(no_order) WEIGHTED (đo thật 08/2026:
// weighted 130.501,53 vs AVG(aov) 131.946,34 — lệch 1.445đ). NULL count =
// 'nguồn chưa có số đơn' ≠ 0 đơn.
test.describe('kpi offline order count + AOV (105) @desktop', () => {
  const rowOf = (m: ReturnType<typeof buildCampaignResultModel>, store: string) =>
    m.rows.find((r) => r.storeId === store)!
  const withOrders = (store: string, value: number, off: number, orders: number | null) =>
    A(store, value, off, 0, { offline_order_count: orders })

  test('per-store: AOV = actual_offline / offline_order_count (làm tròn ở UI, model giữ số thực)', () => {
    const m = buildCampaignResultModel(
      CAMP(), [T('a', 1000)], [withOrders('a', 54140774, 54140774, 343)], TODAY)
    expect(rowOf(m, 'a').offlineOrderCount).toBe(343)
    // POS0068 thật 08/2026: 54.140.774 / 343 = 157.844,82
    expect(rowOf(m, 'a').offlineAov).toBeCloseTo(157844.82, 2)
  })

  test('count NULL (snapshot cũ) → count + AOV đều null (UI "—", KHÔNG hiện 0 đơn)', () => {
    const m = buildCampaignResultModel(CAMP(), [T('a', 1000)], [withOrders('a', 500, 500, null)], TODAY)
    expect(rowOf(m, 'a').offlineOrderCount).toBeNull()
    expect(rowOf(m, 'a').offlineAov).toBeNull()
  })

  test('count = 0 → giữ 0 đơn nhưng AOV null (không chia 0)', () => {
    const m = buildCampaignResultModel(CAMP(), [T('a', 1000)], [withOrders('a', 0, 0, 0)], TODAY)
    expect(rowOf(m, 'a').offlineOrderCount).toBe(0)
    expect(rowOf(m, 'a').offlineAov).toBeNull()
  })

  test('TỔNG: AOV toàn phạm vi là WEIGHTED, KHÁC trung bình AOV từng store', () => {
    // 2 store: (1.000.000 / 10 = 100.000đ) và (200.000 / 4 = 50.000đ)
    // weighted = 1.200.000 / 14 = 85.714,29 ; average(100k, 50k) = 75.000 → khác
    const m = buildCampaignResultModel(
      CAMP(), [T('a', 1000), T('b', 500)],
      [withOrders('a', 1_000_000, 1_000_000, 10), withOrders('b', 200_000, 200_000, 4)], TODAY)
    expect(m.totalOfflineOrders).toBe(14)
    expect(m.totalOfflineAov).toBeCloseTo(85714.2857, 3)
    const avgOfStores = (rowOf(m, 'a').offlineAov! + rowOf(m, 'b').offlineAov!) / 2
    expect(m.totalOfflineAov).not.toBeCloseTo(avgOfStores, 0)
  })

  test('CHỈ MỘT store thiếu count → tổng đơn + AOV tổng = null (fail-visible, không sai mẫu số)', () => {
    const m = buildCampaignResultModel(
      CAMP(), [T('a', 1000), T('b', 500)],
      [withOrders('a', 1_000_000, 1_000_000, 10), withOrders('b', 200_000, 200_000, null)], TODAY)
    expect(m.totalOfflineOrders).toBeNull()
    expect(m.totalOfflineAov).toBeNull()
    // per-store vẫn hiện được cho store có dữ liệu
    expect(rowOf(m, 'a').offlineAov).toBeCloseTo(100000, 6)
  })

  test('r1.1 (P2): 2 TARGET mà chỉ 1 có actual → tổng đơn/AOV = null (không coi là đủ dữ liệu)', () => {
    // actuals.every() cũ trả true vì mảng chỉ có 1 phần tử → dashboard hiện
    // tổng của riêng store A như thể cả campaign đã sync.
    const m = buildCampaignResultModel(
      CAMP(), [T('a', 1000), T('b', 500)], [withOrders('a', 1_000_000, 1_000_000, 10)], TODAY)
    expect(m.rows).toHaveLength(2)
    expect(m.totalOfflineOrders).toBeNull()
    expect(m.totalOfflineAov).toBeNull()
  })

  test('r1.1 (P2): tổng chỉ tính TARGET — actual lạc ngoài targets KHÔNG được cộng vào', () => {
    const m = buildCampaignResultModel(
      CAMP(), [T('a', 1000), T('b', 500)],
      [withOrders('a', 1_000_000, 1_000_000, 10), withOrders('b', 200_000, 200_000, 4),
       withOrders('zz-ngoai-target', 9_000_000, 9_000_000, 999)], TODAY)
    expect(m.totalOfflineOrders).toBe(14)               // 10 + 4, KHÔNG có 999
    expect(m.totalOfflineAov).toBeCloseTo(85714.2857, 3)
  })

  test('formatter offlineOrderLine: có count → "N đơn · AOV X₫"; null → null; 0 → AOV —', () => {
    expect(offlineOrderLine(54140774, 343)).toBe('343 đơn · AOV 157.845₫')
    expect(offlineOrderLine(500, null)).toBeNull()
    expect(offlineOrderLine(0, 0)).toBe('0 đơn · AOV —')
    expect(offlineOrderLine(2_907_965_577, 22_283)).toBe('22.283 đơn · AOV 130.502₫')  // tổng thật 08/2026
  })
})

// ── Mig 106: Chất lượng bán hàng trong result model (contract 12/08) ───────
test.describe('kpi result model — Chất lượng bán hàng (106) @desktop', () => {
  // Fixture Finance SIGNATURE: 1.046 đơn × AOV 194.046đ.
  const QT = (over: Record<string, unknown> = {}) => ({
    id: 't-1', store_id: 'a', pos_code: 'POS0018', kpi_target: 100,
    store_kpi_group: 'Nhóm A', stores: { name: 'CIRCA SIGNATURE' },
    kpi_campaign_store_tiers: [],
    order_target: 1046, aov_target: 194_046,
    ...over,
  })
  const QA = (over: Record<string, unknown> = {}) => ({
    store_id: 'a', actual_value: 100, run_rate: 100, remaining_target: 0,
    achieved_tier_order: 1, store_commission_pool: 20_800_000, synced_at: TODAY_TS,
    actual_offline: 203_039_424, actual_affiliate: 0, offline_order_count: 1046,
    offline_synced_at: TODAY_TS, affiliate_synced_at: null,
    ...over,
  })
  const CAMP_Q = () => ({ ...CAMP(), metric_type: 'offline_order_aov' })

  test('2 dòng metric gộp 1 nhóm: "thực tế / mục tiêu" (không còn sàn, không cột ngang mới)', () => {
    const m = buildCampaignResultModel(CAMP_Q(), [QT()], [QA()], TODAY)
    const r = m.rows[0]
    expect(r.orderAovLines).toEqual({
      order: '1.046 / 1.046 đơn',
      aov: '194.110₫ / 194.046₫',
    })
    expect(r.qualityKpiPass).toBe(true)
    expect(r.qualityStatusLabel).toBe('Đạt KPI')
    expect(m.qualityPassCount).toBe(1)
  })

  test('chưa đạt mục tiêu AOV → nhãn rõ chỉ số nào thiếu, KHÔNG tính là đạt', () => {
    const m = buildCampaignResultModel(
      CAMP_Q(), [QT()],
      // đủ 1.046 đơn nhưng AOV chỉ 180.000 ⇒ completion ≈ 92,76%
      [QA({ actual_value: 92.7618, actual_offline: 1046 * 180_000, achieved_tier_order: null, store_commission_pool: null })],
      TODAY,
    )
    expect(m.rows[0].qualityKpiPass).toBe(false)
    expect(m.rows[0].qualityStatusLabel).toBe('Chưa đạt mục tiêu AOV')
    expect(m.qualityPassCount).toBe(0)
  })

  test('KPI pass suy từ completion, KHÔNG từ bậc (bậc lỗi không kéo theo "đạt")', () => {
    const m = buildCampaignResultModel(
      CAMP_Q(), [QT()],
      [QA({ actual_value: 99.9999, achieved_tier_order: 1, store_commission_pool: 20_800_000,
        offline_order_count: 1045 })],
      TODAY,
    )
    expect(m.rows[0].qualityKpiPass).toBe(false)   // dù achieved_tier_order = 1
    expect(m.qualityPassCount).toBe(0)
  })

  test('chưa phát sinh đơn → nhãn riêng; chưa sync → trạng thái null nhưng vẫn hiện cấu hình', () => {
    const zero = buildCampaignResultModel(
      CAMP_Q(), [QT()],
      [QA({ actual_value: 0, offline_order_count: 0, actual_offline: 0,
        achieved_tier_order: null, store_commission_pool: null })],
      TODAY,
    )
    expect(zero.rows[0].qualityStatusLabel).toBe('Chưa phát sinh đơn')
    expect(zero.rows[0].orderAovLines?.aov).toContain('—')     // AOV vô định

    const notSynced = buildCampaignResultModel(CAMP_Q(), [QT()], [], TODAY)
    expect(notSynced.rows[0].qualityKpiPass).toBe(false)
    expect(notSynced.rows[0].qualityStatusLabel).toBeNull()
    expect(notSynced.rows[0].orderAovLines?.order).toBe('— / 1.046 đơn')
  })

  test('campaign GMV/khách: mọi field Chất lượng bán hàng = null/false (zero-touch)', () => {
    const m = buildCampaignResultModel(CAMP(), [T('a', 1000)], [A('a', 500, 500, 0)], TODAY)
    expect(m.rows[0].orderAovLines).toBeNull()
    expect(m.rows[0].qualityKpiPass).toBe(false)
    expect(m.rows[0].qualityStatusLabel).toBeNull()
    expect(m.qualityPassCount).toBe(0)
  })
})
