import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import {
  CAMPAIGN_RANGE_ERROR_TEXT, parseCampaignRange, rangeAggregationMode,
  rangeFilterVisibleForRole, withRangeParams,
} from '../lib/kpi/campaignDateRange'
import {
  buildRangeStoreActuals, buildRangeTotals, rangeAveragePerDay, weightedAov,
  type CampaignDailyRow,
} from '../lib/kpi/campaignRangeModel'

// Contract bộ lọc khoảng ngày (17/08) — khoá TRƯỚC khi đụng UI.
// Lọc là CHẾ ĐỘ XEM: không ghi DB, không suy lại tier/commission.

const CAMPAIGN = { campaignStart: '2026-08-01', campaignEnd: '2026-08-31' }

test.describe('campaign date range contract @desktop', () => {
  test('không truyền gì → không lọc (đi đường snapshot cũ)', () => {
    expect(parseCampaignRange({ ...CAMPAIGN })).toEqual({
      active: false, from: null, to: null, days: 0, error: null,
    })
  })

  test('range hợp lệ: inclusive cả hai đầu', () => {
    const r = parseCampaignRange({ ...CAMPAIGN, from: '2026-08-01', to: '2026-08-05' })
    expect(r.active).toBe(true)
    expect(r.days).toBe(5)          // 01,02,03,04,05 — KHÔNG phải 4
    expect(r.error).toBeNull()

    expect(parseCampaignRange({ ...CAMPAIGN, from: '2026-08-10', to: '2026-08-10' }).days).toBe(1)
  })

  test('TRỌN KỲ → coi như không lọc, tránh lệch số so với snapshot đang chạy', () => {
    const r = parseCampaignRange({ ...CAMPAIGN, from: '2026-08-01', to: '2026-08-31' })
    expect(r.active).toBe(false)
    expect(r.error).toBeNull()
  })

  test('thiếu một đầu → lỗi NHÌN THẤY, không tự suy đầu còn lại', () => {
    for (const p of [{ from: '2026-08-01' }, { to: '2026-08-05' }]) {
      const r = parseCampaignRange({ ...CAMPAIGN, ...p })
      expect(r.active, JSON.stringify(p)).toBe(false)
      expect(r.error, JSON.stringify(p)).toBe('incomplete')
    }
  })

  test('ngày sai hình dạng HOẶC không tồn tại thật', () => {
    expect(parseCampaignRange({ ...CAMPAIGN, from: '01/08/2026', to: '2026-08-05' }).error).toBe('malformed')
    // khớp regex nhưng KHÔNG phải ngày thật — bẫy đã gặp ở mig 106
    expect(parseCampaignRange({ ...CAMPAIGN, from: '2026-13-99', to: '2026-08-05' }).error).toBe('malformed')
    expect(parseCampaignRange({ ...CAMPAIGN, from: '2026-02-30', to: '2026-08-05' }).error).toBe('malformed')
  })

  test('from > to → reversed', () => {
    expect(parseCampaignRange({ ...CAMPAIGN, from: '2026-08-20', to: '2026-08-10' }).error).toBe('reversed')
  })

  test('ngoài kỳ campaign → báo lỗi, TUYỆT ĐỐI không clamp âm thầm', () => {
    const before = parseCampaignRange({ ...CAMPAIGN, from: '2026-07-25', to: '2026-08-05' })
    expect(before.error).toBe('outside')
    expect(before.active).toBe(false)
    // không được lặng lẽ kéo về 2026-08-01 rồi hiện số của khoảng khác
    expect(before.from).toBe('2026-07-25')

    expect(parseCampaignRange({ ...CAMPAIGN, from: '2026-08-25', to: '2026-09-05' }).error).toBe('outside')
  })

  test('CẢ BA loại đều lọc được; đường tính khác nhau', () => {
    // Số khách KHÔNG cộng dồn daily được (dedup theo customer_phone_norm ⇒
    // một khách nhiều đơn vẫn là một khách) ⇒
    // phải đếm distinct lại trong range bằng RPC.
    expect(rangeAggregationMode('affiliate_customer_count')).toBe('customer-rpc')
    expect(rangeAggregationMode('gmv')).toBe('daily')
    expect(rangeAggregationMode('offline_order_aov')).toBe('daily')
    expect(rangeAggregationMode(undefined)).toBe('daily')

    // Campaign khách vẫn parse range bình thường — không còn bị chặn.
    const r = parseCampaignRange({
      ...CAMPAIGN, from: '2026-08-01', to: '2026-08-05',
      metricType: 'affiliate_customer_count',
    })
    expect(r.active).toBe(true)
    expect(r.days).toBe(5)
    expect(r.error).toBeNull()
  })

  test('TRỌN KỲ với campaign khách cũng là "không lọc" ⇒ KHÔNG gọi RPC', () => {
    // Đây là thứ giữ chi phí nhánh RPC trong tầm kiểm soát: mặc định trang
    // không lọc nên không bao giờ chạm RPC; chỉ khi chủ động chọn khoảng con.
    const r = parseCampaignRange({
      ...CAMPAIGN, from: '2026-08-01', to: '2026-08-31',
      metricType: 'affiliate_customer_count',
    })
    expect(r.active).toBe(false)
  })

  test('mọi mã lỗi đều có câu tiếng Việt đọc được', () => {
    for (const key of ['incomplete', 'malformed', 'reversed', 'outside'] as const) {
      expect(CAMPAIGN_RANGE_ERROR_TEXT[key].length, key).toBeGreaterThan(10)
    }
  })

  test('AI thấy filter: Super Admin · SM · QLCH — admin thường KHÔNG', () => {
    expect(rangeFilterVisibleForRole({ role: 'admin', isSuperAdmin: true })).toBe(true)
    expect(rangeFilterVisibleForRole({ role: 'sm' })).toBe(true)
    expect(rangeFilterVisibleForRole({ role: 'store_manager' })).toBe(true)

    // Admin THƯỜNG: giữ nguyên access hiện hành — /targets/campaigns vốn
    // super-only và /targets redirect họ đi. Mở filter = phải mở quyền xem
    // campaign, tức đổi authz, ngoài phạm vi batch UI.
    expect(rangeFilterVisibleForRole({ role: 'admin' })).toBe(false)
    expect(rangeFilterVisibleForRole({ role: 'admin', isSuperAdmin: false })).toBe(false)

    // Staff KHÔNG, kể cả mở bằng desktop.
    expect(rangeFilterVisibleForRole({ role: 'staff' })).toBe(false)
    expect(rangeFilterVisibleForRole({ role: 'staff', isSuperAdmin: true })).toBe(false)

    expect(rangeFilterVisibleForRole({})).toBe(false)
    expect(rangeFilterVisibleForRole({ role: null })).toBe(false)
  })

  test('withRangeParams giữ NGUYÊN các query param đang chạy', () => {
    // campaign · series · store · tab đều là contract hiện hành — mất một cái
    // là gãy màn (đổi chuỗi chart, chọn store của SM, tab Cấu hình/Kết quả).
    const q = withRangeParams(
      { campaign: 'c1', series: 'aov', store: 's1', tab: 'result' },
      { from: '2026-08-01', to: '2026-08-05' },
    )
    for (const part of ['campaign=c1', 'series=aov', 'store=s1', 'tab=result', 'from=2026-08-01', 'to=2026-08-05']) {
      expect(q, part).toContain(part)
    }

    // reset: bỏ from/to nhưng GIỮ phần còn lại
    const cleared = withRangeParams({ campaign: 'c1', series: 'aov' }, { from: null, to: null })
    expect(cleared).toContain('campaign=c1')
    expect(cleared).toContain('series=aov')
    expect(cleared).not.toContain('from=')
    expect(cleared).not.toContain('to=')

    expect(withRangeParams({}, {})).toBe('')
  })
})

// ── CANARY nguồn: contract 90/10 + "sàn" KHÔNG được quay lại ────────────────
// Contract "Chất lượng bán hàng" đổi 12/08: hai mục tiêu ĐỘC LẬP, đạt khi CẢ
// HAI cùng chạm — bỏ hẳn tỷ trọng 90/10 và bỏ sàn. Nhưng mô tả cũ đã sống sót
// ở nhiều chỗ rất lâu sau đó (wizard, .env.example, flags.ts) vì chúng là
// COMMENT/copy, không có test nào chạm tới. Canary này quét thẳng file nguồn.
//
// Không quét SQL migration: 106 là lịch sử đã chạy trên prod, sửa file đó là
// viết lại quá khứ. Chỉ quét thứ người dùng/dev đọc hôm nay.
test.describe('canary: contract 90/10 đã bị gỡ @desktop', () => {
  const ROOT = path.join(__dirname, '..')
  const FILES = [
    'lib/kpi/flags.ts',
    'lib/kpi/campaignDisplay.ts',
    'lib/kpi/campaignDateRange.ts',
    'components/kpi/CampaignWizard.tsx',
    'components/kpi/CampaignKpiView.tsx',
    '.env.example',
  ]

  test('không còn tỷ trọng 90/10 hay "sàn" trong mô tả Chất lượng bán hàng', () => {
    // Chỉ bắt khi 90 và 10 đứng CÙNG một dòng dạng phần trăm — tránh false
    // positive với các con số 10/90 vô hại khác trong file.
    const WEIGHTING = /90\s*%[^\n]{0,40}10\s*%|10\s*%[^\n]{0,40}90\s*%/
    const FLOOR = /sàn bắt buộc/i

    for (const rel of FILES) {
      const abs = path.join(ROOT, rel)
      if (!fs.existsSync(abs)) continue
      const src = fs.readFileSync(abs, 'utf8')
      expect(src, `${rel}: còn mô tả tỷ trọng 90/10`).not.toMatch(WEIGHTING)
      expect(src, `${rel}: còn khẳng định "sàn bắt buộc" (contract 12/08 đã bỏ sàn)`).not.toMatch(FLOOR)
    }
  })

  test('CANARY tự kiểm: hai pattern thật sự bắt được văn bản cũ', () => {
    const WEIGHTING = /90\s*%[^\n]{0,40}10\s*%|10\s*%[^\n]{0,40}90\s*%/
    const FLOOR = /sàn bắt buộc/i
    expect('Số đơn Offline 90% + AOV 10%').toMatch(WEIGHTING)
    expect('số đơn (90%) và giá trị đơn trung bình (10%)').toMatch(WEIGHTING)
    expect('mỗi chỉ số có SÀN bắt buộc').toMatch(FLOOR)
    // và không bắt nhầm văn bản hợp lệ
    expect('Đạt KPI khi CẢ số đơn và AOV cùng chạm mục tiêu').not.toMatch(WEIGHTING)
    expect('Đạt KPI khi CẢ số đơn và AOV cùng chạm mục tiêu').not.toMatch(FLOOR)
  })
})

// ── Commit 3: cộng dồn theo khoảng ─────────────────────────────────────────
test.describe('campaign range aggregation @desktop', () => {
  const row = (o: Partial<CampaignDailyRow> & { store_id: string; date: string }): CampaignDailyRow => ({
    gmv: 0, gmv_affiliate: 0, offline_order_count: null, ...o,
  })

  test('GMV: cộng offline + affiliate; tổng = hai nguồn', () => {
    const out = buildRangeStoreActuals([
      row({ store_id: 's1', date: '2026-08-01', gmv: 100, gmv_affiliate: 10 }),
      row({ store_id: 's1', date: '2026-08-02', gmv: 200, gmv_affiliate: 20 }),
      row({ store_id: 's2', date: '2026-08-01', gmv: 50, gmv_affiliate: 0 }),
    ])
    const s1 = out.find((s) => s.store_id === 's1')!
    expect(s1.offline).toBe(300)
    expect(s1.affiliate).toBe(30)
    expect(s1.actual).toBe(330)
    expect(s1.dayCount).toBe(2)
    expect(out).toHaveLength(2)
  })

  test('NET REVENUE ÂM (trả hàng) phải được giữ, không clamp về 0', () => {
    const out = buildRangeStoreActuals([
      row({ store_id: 's1', date: '2026-08-01', gmv: 500 }),
      row({ store_id: 's1', date: '2026-08-02', gmv: -120 }),   // ngày trả hàng nhiều
    ])
    expect(out[0].offline).toBe(380)
    expect(out[0].actual).toBe(380)
  })

  test('AOV luôn WEIGHTED = tổng net / tổng đơn, KHÔNG phải trung bình AOV ngày', () => {
    const out = buildRangeStoreActuals([
      // ngày 1: 1 đơn × 1.000.000 ⇒ AOV ngày = 1.000.000
      row({ store_id: 's1', date: '2026-08-01', gmv: 1_000_000, offline_order_count: 1 }),
      // ngày 2: 99 đơn × ~10.101 ⇒ AOV ngày ≈ 10.101
      row({ store_id: 's1', date: '2026-08-02', gmv: 1_000_000, offline_order_count: 99 }),
    ])
    const s1 = out[0]
    expect(s1.orders).toBe(100)
    expect(s1.aov).toBe(20_000)                    // 2.000.000 / 100
    // trung bình của hai AOV ngày là ~505.050 — con số KHÔNG tồn tại thực tế
    expect(s1.aov).not.toBeCloseTo((1_000_000 + 1_000_000 / 99) / 2, 0)
  })

  test('0 đơn → AOV null (không chia 0); orders vẫn là 0 THẬT', () => {
    const out = buildRangeStoreActuals([
      row({ store_id: 's1', date: '2026-08-01', gmv: 0, offline_order_count: 0 }),
    ])
    expect(out[0].orders).toBe(0)
    expect(out[0].aov).toBeNull()
  })

  test('nguồn CHƯA có số đơn → orders null, KHÁC hẳn 0 đơn', () => {
    const out = buildRangeStoreActuals([
      row({ store_id: 's1', date: '2026-08-01', gmv: 900_000 }),   // offline_order_count null
      row({ store_id: 's1', date: '2026-08-02', gmv: 100_000 }),
    ])
    expect(out[0].orders).toBeNull()
    expect(out[0].aov).toBeNull()
    expect(out[0].offline).toBe(1_000_000)        // tiền vẫn cộng bình thường
  })

  test('một phần ngày có số đơn → cộng ĐÚNG phần có, không coi null là 0', () => {
    const out = buildRangeStoreActuals([
      row({ store_id: 's1', date: '2026-08-01', gmv: 300, offline_order_count: 3 }),
      row({ store_id: 's1', date: '2026-08-02', gmv: 200 }),        // thiếu số đơn
    ])
    expect(out[0].orders).toBe(3)
    expect(out[0].aov).toBe(500 / 3)              // net vẫn là tổng cả 2 ngày
  })

  test('weightedAov: biên', () => {
    expect(weightedAov(1000, 4)).toBe(250)
    expect(weightedAov(1000, 0)).toBeNull()
    expect(weightedAov(1000, null)).toBeNull()
    expect(weightedAov(-500, 5)).toBe(-100)       // net âm vẫn ra AOV âm, không nuốt
  })

  test('totals: gộp nhiều store, AOV weighted TOÀN VÙNG', () => {
    const stores = buildRangeStoreActuals([
      row({ store_id: 's1', date: '2026-08-01', gmv: 1_000_000, gmv_affiliate: 100, offline_order_count: 10 }),
      row({ store_id: 's2', date: '2026-08-01', gmv: 3_000_000, gmv_affiliate: 200, offline_order_count: 30 }),
    ])
    const t = buildRangeTotals(stores)
    expect(t.offline).toBe(4_000_000)
    expect(t.affiliate).toBe(300)
    expect(t.actual).toBe(4_000_300)
    expect(t.orders).toBe(40)
    expect(t.aov).toBe(100_000)                   // 4.000.000 / 40
    expect(t.storeCount).toBe(2)
  })

  test('totals: chỉ MỘT store thiếu số đơn thì tổng đơn vẫn tính phần có', () => {
    const stores = buildRangeStoreActuals([
      row({ store_id: 's1', date: '2026-08-01', gmv: 100, offline_order_count: 2 }),
      row({ store_id: 's2', date: '2026-08-01', gmv: 900 }),
    ])
    const t = buildRangeTotals(stores)
    expect(t.orders).toBe(2)
    // net là tổng cả hai store ⇒ AOV toàn vùng lệch cao; đó là lý do UI phải
    // nêu rõ khi thiếu nguồn, nhưng model KHÔNG được tự bịa 0 đơn cho s2.
    expect(t.aov).toBe(500)
  })

  test('totals rỗng: 0 store, không crash, AOV null', () => {
    const t = buildRangeTotals([])
    expect(t).toEqual({ offline: 0, affiliate: 0, actual: 0, orders: null, aov: null, storeCount: 0 })
  })

  test('trung bình/ngày chia theo SỐ NGÀY CỦA KHOẢNG, không phải ngày có dữ liệu', () => {
    // 5 ngày khoảng, chỉ 2 ngày phát sinh ⇒ vẫn chia 5: ngày không bán vẫn là
    // một ngày bán trong kỳ.
    expect(rangeAveragePerDay(1_000_000, 5)).toBe(200_000)
    expect(rangeAveragePerDay(0, 5)).toBe(0)
    expect(rangeAveragePerDay(100, 0)).toBeNull()
  })
})
