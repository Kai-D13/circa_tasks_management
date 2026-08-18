import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import {
  CAMPAIGN_RANGE_ERROR_TEXT, parseCampaignRange, rangeAggregationMode,
  rangeFilterVisibleForRole, withRangeParams,
} from '../lib/kpi/campaignDateRange'
import {
  buildRangeStoreActuals, buildRangeTotals, rangeActualAveragePerDay, RANGE_AVERAGE_LABEL, weightedAov,
  type CampaignDailyRow,
} from '../lib/kpi/campaignRangeModel'
import { loadCampaignRangeActuals, type RangeReadDeps } from '../lib/kpi/campaignRangeServer'

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
    ], ['s1', 's2'])
    const s1 = out.find((x) => x.store_id === 's1')!
    expect(s1.offline).toBe(300)
    expect(s1.affiliate).toBe(30)
    expect(s1.actual).toBe(330)
    expect(s1.dayCount).toBe(2)
    expect(out).toHaveLength(2)
  })

  test('NET REVENUE ÂM (trả hàng) phải được giữ, không clamp về 0', () => {
    const out = buildRangeStoreActuals([
      row({ store_id: 's1', date: '2026-08-01', gmv: 500 }),
      row({ store_id: 's1', date: '2026-08-02', gmv: -120 }),
    ], ['s1'])
    expect(out[0].offline).toBe(380)
    expect(out[0].actual).toBe(380)
  })

  test('AOV luôn WEIGHTED = tổng net / tổng đơn, KHÔNG phải trung bình AOV ngày', () => {
    const out = buildRangeStoreActuals([
      row({ store_id: 's1', date: '2026-08-01', gmv: 1_000_000, offline_order_count: 1 }),
      row({ store_id: 's1', date: '2026-08-02', gmv: 1_000_000, offline_order_count: 99 }),
    ], ['s1'])
    const s1 = out[0]
    expect(s1.ordersCoverage).toBe('full')
    expect(s1.orders).toBe(100)
    expect(s1.aov).toBe(20_000)
    expect(s1.aov).not.toBeCloseTo((1_000_000 + 1_000_000 / 99) / 2, 0)
  })

  test('0 đơn → AOV null (không chia 0); orders vẫn là 0 THẬT', () => {
    const out = buildRangeStoreActuals([
      row({ store_id: 's1', date: '2026-08-01', gmv: 0, offline_order_count: 0 }),
    ], ['s1'])
    expect(out[0].ordersCoverage).toBe('full')
    expect(out[0].orders).toBe(0)
    expect(out[0].aov).toBeNull()
  })

  test('nguồn CHƯA có số đơn ngày nào → coverage none, orders null', () => {
    const out = buildRangeStoreActuals([
      row({ store_id: 's1', date: '2026-08-01', gmv: 900_000 }),
      row({ store_id: 's1', date: '2026-08-02', gmv: 100_000 }),
    ], ['s1'])
    expect(out[0].ordersCoverage).toBe('none')
    expect(out[0].orders).toBeNull()
    expect(out[0].aov).toBeNull()
    expect(out[0].offline).toBe(1_000_000)        // tiền vẫn cộng bình thường
  })

  // ⚠ Ca nguy hiểm nhất — bản trước KHOÁ NHẦM hành vi sai: cộng đơn của phần có
  // rồi chia net của TRỌN khoảng, ra một AOV trông hợp lệ mà sai (500/3).
  // Mig 105 đã cấm payload nửa vời ở tầng ghi; tầng đọc giữ cùng kỷ luật.
  test('PARTIAL: có ngày thiếu số đơn → orders/aov NULL, không ra số nửa vời', () => {
    const out = buildRangeStoreActuals([
      row({ store_id: 's1', date: '2026-08-01', gmv: 300, offline_order_count: 3 }),
      row({ store_id: 's1', date: '2026-08-02', gmv: 200 }),        // thiếu số đơn
    ], ['s1'])
    expect(out[0].ordersCoverage).toBe('partial')
    expect(out[0].orders).toBeNull()
    expect(out[0].aov).toBeNull()
    // tuyệt đối không còn 500/3
    expect(out[0].aov).not.toBe(500 / 3)
    // nhưng TIỀN vẫn hiển thị được, độc lập với số đơn
    expect(out[0].offline).toBe(500)
  })

  test('store CÓ TARGET nhưng KHÔNG có dòng nào → vẫn xuất hiện, tiền 0', () => {
    const out = buildRangeStoreActuals([
      row({ store_id: 's1', date: '2026-08-01', gmv: 100, offline_order_count: 1 }),
    ], ['s1', 's2', 's3'])
    expect(out).toHaveLength(3)
    const s2 = out.find((x) => x.store_id === 's2')!
    expect(s2.actual).toBe(0)
    expect(s2.dayCount).toBe(0)
    expect(s2.ordersCoverage).toBe('none')
    expect(s2.orders).toBeNull()
  })

  test('rows NGOÀI tập target bị bỏ qua (model không tự mở rộng phạm vi)', () => {
    const out = buildRangeStoreActuals([
      row({ store_id: 's1', date: '2026-08-01', gmv: 100 }),
      row({ store_id: 'ngoai-scope', date: '2026-08-01', gmv: 999_999 }),
    ], ['s1'])
    expect(out).toHaveLength(1)
    expect(out[0].offline).toBe(100)
  })

  test('weightedAov: biên', () => {
    expect(weightedAov(1000, 4)).toBe(250)
    expect(weightedAov(1000, 0)).toBeNull()
    expect(weightedAov(1000, null)).toBeNull()
    expect(weightedAov(-500, 5)).toBe(-100)
  })

  test('totals: gộp nhiều store, AOV weighted TOÀN VÙNG', () => {
    const stores = buildRangeStoreActuals([
      row({ store_id: 's1', date: '2026-08-01', gmv: 1_000_000, gmv_affiliate: 100, offline_order_count: 10 }),
      row({ store_id: 's2', date: '2026-08-01', gmv: 3_000_000, gmv_affiliate: 200, offline_order_count: 30 }),
    ], ['s1', 's2'])
    const t = buildRangeTotals(stores)
    expect(t.ordersCoverage).toBe('full')
    expect(t.offline).toBe(4_000_000)
    expect(t.affiliate).toBe(300)
    expect(t.actual).toBe(4_000_300)
    expect(t.orders).toBe(40)
    expect(t.aov).toBe(100_000)
    expect(t.storeCount).toBe(2)
  })

  // Tử số cộng đủ mọi store còn mẫu số thiếu một store ⇒ AOV vùng cao GIẢ.
  test('totals: MỘT store thiếu số đơn → tổng orders/aov NULL', () => {
    const stores = buildRangeStoreActuals([
      row({ store_id: 's1', date: '2026-08-01', gmv: 100, offline_order_count: 2 }),
      row({ store_id: 's2', date: '2026-08-01', gmv: 900 }),
    ], ['s1', 's2'])
    const t = buildRangeTotals(stores)
    expect(t.ordersCoverage).toBe('partial')
    expect(t.orders).toBeNull()
    expect(t.aov).toBeNull()
    expect(t.aov).not.toBe(500)      // con số sai của bản trước
    expect(t.offline).toBe(1000)     // tiền vẫn đúng và vẫn hiện được
  })

  test('totals: storeCount = số store ĐƯỢC TARGET, không phải store có dữ liệu', () => {
    const stores = buildRangeStoreActuals([
      row({ store_id: 's1', date: '2026-08-01', gmv: 100, offline_order_count: 1 }),
    ], ['s1', 's2', 's3'])
    expect(buildRangeTotals(stores).storeCount).toBe(3)
  })

  test('totals rỗng: 0 store, không crash, AOV null', () => {
    const t = buildRangeTotals([])
    expect(t).toEqual({
      offline: 0, affiliate: 0, actual: 0, orders: null, aov: null,
      ordersCoverage: 'none', storeCount: 0,
    })
  })

  test('trung bình THỰC TẾ/ngày: chia theo SỐ NGÀY CỦA KHOẢNG + nhãn riêng', () => {
    expect(rangeActualAveragePerDay(1_000_000, 5)).toBe(200_000)
    expect(rangeActualAveragePerDay(0, 5)).toBe(0)
    expect(rangeActualAveragePerDay(100, 0)).toBeNull()
    // Nhãn PHẢI khác "Trung bình/ngày cần đạt" của toàn kỳ — đây là số ĐÃ ĐẠT
    // chia số ngày đã chọn, không phải phần còn thiếu chia số ngày còn lại.
    expect(RANGE_AVERAGE_LABEL).toBe('Trung bình thực tế/ngày')
    expect(RANGE_AVERAGE_LABEL).not.toContain('cần đạt')
  })
})

// ── Commit 4: tầng đọc server ──────────────────────────────────────────────
test.describe('campaign range server read @desktop', () => {
  const RANGE = { active: true, from: '2026-08-01', to: '2026-08-05', days: 5, error: null } as const
  const FULL = { active: false, from: null, to: null, days: 0, error: null } as const

  // Deps giả + ghi lại lời gọi để assert "KHÔNG gọi RPC" — thứ không thể kiểm
  // bằng cách nhìn kết quả.
  function deps(over: Partial<RangeReadDeps> = {}) {
    const calls = { targets: 0, daily: 0, rpc: 0, health: 0, rpcArgs: [] as unknown[][] }
    const base: RangeReadDeps = {
      loadTargetStoreIds: async () => { calls.targets++; return { data: ['s1', 's2'], error: null } },
      loadDaily: async () => { calls.daily++; return { data: [], error: null } },
      aggregateCustomers: async (ids, from, to) => {
        calls.rpc++; calls.rpcArgs.push([ids, from, to])
        return { data: { rows: [], total_customers: 0 }, error: null }
      },
      getAffiliateHealth: async () => { calls.health++; return { ready: true, runId: 'run-1' } },
    }
    return { d: { ...base, ...over }, calls }
  }

  test('range KHÔNG active → không truy vấn gì cả (chốt cứng chống bug caller)', async () => {
    const { d, calls } = deps()
    const r = await loadCampaignRangeActuals(d, { campaignId: 'c1', range: FULL, metricType: 'gmv' })
    expect(r.ok).toBe(false)
    expect(calls.targets).toBe(0)
    expect(calls.daily).toBe(0)
    expect(calls.rpc).toBe(0)
  })

  test('GMV: đi nhánh daily, KHÔNG đụng RPC khách', async () => {
    const { d, calls } = deps({
      loadDaily: async () => ({
        data: [
          { store_id: 's1', date: '2026-08-01', gmv: 100, gmv_affiliate: 10, offline_order_count: 2 },
          { store_id: 's2', date: '2026-08-01', gmv: 300, gmv_affiliate: 0, offline_order_count: 3 },
        ],
        error: null,
      }),
    })
    const r = await loadCampaignRangeActuals(d, { campaignId: 'c1', range: RANGE, metricType: 'gmv' })
    expect(r.ok).toBe(true)
    if (!r.ok || r.mode !== 'daily') throw new Error('sai nhánh')
    expect(r.totals.actual).toBe(410)
    expect(r.totals.orders).toBe(5)
    expect(calls.rpc).toBe(0)
  })

  test('Order/AOV cũng đi nhánh daily, KHÔNG đụng RPC', async () => {
    const { d, calls } = deps()
    const r = await loadCampaignRangeActuals(d, { campaignId: 'c1', range: RANGE, metricType: 'offline_order_aov' })
    expect(r.ok).toBe(true)
    expect(calls.daily).toBe(1)
    expect(calls.rpc).toBe(0)
  })

  test('Khách: gọi RPC với cửa sổ VN HALF-OPEN [from 00:00+07, ngày SAU to 00:00+07)', async () => {
    const { d, calls } = deps()
    await loadCampaignRangeActuals(d, { campaignId: 'c1', range: RANGE, metricType: 'affiliate_customer_count' })
    expect(calls.rpc).toBe(1)
    const [ids, from, to] = calls.rpcArgs[0] as [string[], string, string]
    expect(ids).toEqual(['s1', 's2'])              // derive server-side, không từ URL
    expect(from).toBe('2026-08-01T00:00:00+07:00')
    // to = 06/08 chứ KHÔNG phải 05/08: biên phải EXCLUSIVE đầu ngày kế tiếp,
    // nếu không đơn ngày 05 sẽ bị rụng.
    expect(to).toBe('2026-08-06T00:00:00+07:00')
    expect(calls.daily).toBe(0)
  })

  test('Khách: sparse RPC rows vẫn giữ ĐỦ store; store không có dòng = 0 khách', async () => {
    const { d } = deps({
      loadTargetStoreIds: async () => ({ data: ['s1', 's2', 's3'], error: null }),
      aggregateCustomers: async () => ({
        data: {
          rows: [
            { store_id: 's1', vn_date: '2026-08-01', customer_count: 2 },
            { store_id: 's1', vn_date: '2026-08-02', customer_count: 3 },
          ],
          total_customers: 5,
        },
        error: null,
      }),
    })
    const r = await loadCampaignRangeActuals(d, { campaignId: 'c1', range: RANGE, metricType: 'affiliate_customer_count' })
    if (!r.ok || r.mode !== 'customer') throw new Error('sai nhánh')
    expect(r.stores).toHaveLength(3)
    // cộng qua ngày ĐÚNG vì RPC đã DISTINCT ON (phone) trước khi group
    expect(r.stores.find((x) => x.store_id === 's1')!.customers).toBe(5)
    expect(r.stores.find((x) => x.store_id === 's3')!.customers).toBe(0)
    expect(r.storeCount).toBe(3)
    expect(r.totalCustomers).toBe(5)
  })

  // RPC nhận ĐÚNG tập storeIds, nên row lạ = contract violation, KHÔNG phải
  // dữ liệu hợp lệ để lặng lẽ bỏ qua.
  test('Khách: row NGOÀI tập target → FAIL-VISIBLE, không bỏ qua âm thầm', async () => {
    const { d } = deps({
      aggregateCustomers: async () => ({
        data: {
          rows: [
            { store_id: 's1', vn_date: '2026-08-01', customer_count: 4 },
            { store_id: 'store-la', vn_date: '2026-08-01', customer_count: 100 },
          ],
          total_customers: 104,
        },
        error: null,
      }),
    })
    const r = await loadCampaignRangeActuals(d, { campaignId: 'c1', range: RANGE, metricType: 'affiliate_customer_count' })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('phải lỗi')
    expect(r.error).toContain('ngoài phạm vi')
  })

  test('LỖI phải fail-visible, TUYỆT ĐỐI không rơi âm thầm về toàn kỳ', async () => {
    const dailyErr = await loadCampaignRangeActuals(
      deps({ loadDaily: async () => ({ data: null, error: { message: 'timeout' } }) }).d,
      { campaignId: 'c1', range: RANGE, metricType: 'gmv' },
    )
    expect(dailyErr.ok).toBe(false)
    if (dailyErr.ok) throw new Error('phải lỗi')
    expect(dailyErr.error).toContain('timeout')

    const rpcErr = await loadCampaignRangeActuals(
      deps({ aggregateCustomers: async () => ({ data: null, error: { message: 'RAISE fail-closed' } }) }).d,
      { campaignId: 'c1', range: RANGE, metricType: 'affiliate_customer_count' },
    )
    expect(rpcErr.ok).toBe(false)

    const targetErr = await loadCampaignRangeActuals(
      deps({ loadTargetStoreIds: async () => ({ data: null, error: { message: 'RLS' } }) }).d,
      { campaignId: 'c1', range: RANGE, metricType: 'gmv' },
    )
    expect(targetErr.ok).toBe(false)
  })

  test('không có store nào trong phạm vi → báo rõ, không gọi tiếp', async () => {
    const { d, calls } = deps({ loadTargetStoreIds: async () => ({ data: [], error: null }) })
    const r = await loadCampaignRangeActuals(d, { campaignId: 'c1', range: RANGE, metricType: 'gmv' })
    expect(r.ok).toBe(false)
    expect(calls.daily).toBe(0)
    expect(calls.rpc).toBe(0)
  })
})

// ── Commit 4a.1: health gate + payload cứng cho nhánh khách ────────────────
test.describe('campaign range customer hardening @desktop', () => {
  const RANGE = { active: true, from: '2026-08-01', to: '2026-08-05', days: 5, error: null } as const

  function deps(over: Partial<RangeReadDeps> = {}) {
    const calls = { rpc: 0, health: 0 }
    const base: RangeReadDeps = {
      loadTargetStoreIds: async () => ({ data: ['s1', 's2'], error: null }),
      loadDaily: async () => ({ data: [], error: null }),
      aggregateCustomers: async () => {
        calls.rpc++
        return { data: { rows: [{ store_id: 's1', vn_date: '2026-08-01', customer_count: 2 }], total_customers: 2 }, error: null }
      },
      getAffiliateHealth: async () => { calls.health++; return { ready: true, runId: 'run-1' } },
    }
    return { d: { ...base, ...over }, calls }
  }

  const readCustomer = (d: RangeReadDeps) =>
    loadCampaignRangeActuals(d, { campaignId: 'c1', range: RANGE, metricType: 'affiliate_customer_count' })

  test('health CHƯA READY → KHÔNG gọi RPC, báo lý do', async () => {
    const { d, calls } = deps({
      getAffiliateHealth: async () => ({ ready: false, reason: 'snapshot stale 900 phút' }),
    })
    const r = await readCustomer(d)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('phải lỗi')
    expect(r.error).toContain('stale')
    expect(calls.rpc, 'không được gọi RPC khi nguồn chưa sẵn sàng').toBe(0)
  })

  test('runId ĐỔI giữa chừng → không trả kết quả (số có thể trộn 2 phiên)', async () => {
    let n = 0
    const { d } = deps({
      getAffiliateHealth: async () => {
        n += 1
        return { ready: true, runId: n === 1 ? 'run-1' : 'run-2' }
      },
    })
    const r = await readCustomer(d)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('phải lỗi')
    expect(r.error).toContain('trộn hai phiên')
  })

  test('health đọc HAI lần: trước và sau aggregate', async () => {
    const { d, calls } = deps()
    const r = await readCustomer(d)
    expect(r.ok).toBe(true)
    expect(calls.health).toBe(2)
  })

  test('health đổi sang NOT READY sau aggregate → fail-visible', async () => {
    let n = 0
    const { d } = deps({
      getAffiliateHealth: async () => {
        n += 1
        return n === 1 ? { ready: true, runId: 'run-1' } : { ready: false, reason: 'sync đang chạy' }
      },
    })
    const r = await readCustomer(d)
    expect(r.ok).toBe(false)
  })

  test('data null mà không error → LỖI, tuyệt đối không thành "0 khách"', async () => {
    const { d } = deps({ aggregateCustomers: async () => ({ data: null, error: null }) })
    const r = await readCustomer(d)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('phải lỗi')
    expect(r.error).toContain('rỗng bất thường')
  })

  test('customer_count hỏng (NaN / chuỗi / âm / số lẻ) → fail-visible', async () => {
    for (const bad of [Number.NaN, 'abc' as unknown as number, -1, 2.5]) {
      const { d } = deps({
        aggregateCustomers: async () => ({
          data: { rows: [{ store_id: 's1', vn_date: '2026-08-01', customer_count: bad }], total_customers: 0 },
          error: null,
        }),
      })
      const r = await readCustomer(d)
      expect(r.ok, `giá trị ${String(bad)} phải bị từ chối`).toBe(false)
    }
  })

  test('SUM(rows) ≠ total_customers → nguồn tự mâu thuẫn, fail-visible', async () => {
    const { d } = deps({
      aggregateCustomers: async () => ({
        data: { rows: [{ store_id: 's1', vn_date: '2026-08-01', customer_count: 2 }], total_customers: 99 },
        error: null,
      }),
    })
    const r = await readCustomer(d)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('phải lỗi')
    expect(r.error).toContain('tự mâu thuẫn')
  })

  test('sparse HỢP LỆ vẫn qua: store không có dòng = 0 khách', async () => {
    const { d } = deps({
      loadTargetStoreIds: async () => ({ data: ['s1', 's2', 's3'], error: null }),
      aggregateCustomers: async () => ({
        data: {
          rows: [
            { store_id: 's1', vn_date: '2026-08-01', customer_count: 2 },
            { store_id: 's3', vn_date: '2026-08-02', customer_count: 1 },
          ],
          total_customers: 3,
        },
        error: null,
      }),
    })
    const r = await readCustomer(d)
    expect(r.ok).toBe(true)
    if (!r.ok || r.mode !== 'customer') throw new Error('sai nhánh')
    expect(r.stores).toHaveLength(3)
    expect(r.stores.find((x) => x.store_id === 's2')!.customers).toBe(0)
    expect(r.totalCustomers).toBe(3)
  })

  test('rows null/không phải array → LỖI, không thành "0 khách"', async () => {
    for (const badRows of [null, undefined, 'x' as unknown, {} as unknown]) {
      const { d } = deps({
        aggregateCustomers: async () => ({
          data: { rows: badRows as never, total_customers: 0 },
          error: null,
        }),
      })
      const r = await readCustomer(d)
      expect(r.ok, `rows=${String(badRows)} phải bị từ chối`).toBe(false)
    }
  })

  test('total_customers hỏng (NaN / chuỗi / âm / lẻ) → LỖI trước khi đối soát', async () => {
    // Bẫy cũ: `Number.isFinite(total) && sum !== total` — NaN làm mệnh đề đầu
    // false nên BỎ QUA luôn phép đối soát và kết quả vẫn PASS.
    for (const bad of [Number.NaN, 'abc' as unknown as number, -1, 1.5]) {
      const { d } = deps({
        aggregateCustomers: async () => ({
          data: {
            rows: [{ store_id: 's1', vn_date: '2026-08-01', customer_count: 2 }],
            total_customers: bad,
          },
          error: null,
        }),
      })
      const r = await readCustomer(d)
      expect(r.ok, `total=${String(bad)} phải bị từ chối`).toBe(false)
    }
  })

  test('targets: null (payload hỏng) KHÁC [] (không có target)', async () => {
    const nullPayload = await loadCampaignRangeActuals(
      deps({ loadTargetStoreIds: async () => ({ data: null, error: null }) }).d,
      { campaignId: 'c1', range: RANGE, metricType: 'gmv' },
    )
    expect(nullPayload.ok).toBe(false)
    if (nullPayload.ok) throw new Error('phải lỗi')
    expect(nullPayload.error).toContain('bất thường')

    const empty = await loadCampaignRangeActuals(
      deps({ loadTargetStoreIds: async () => ({ data: [], error: null }) }).d,
      { campaignId: 'c1', range: RANGE, metricType: 'gmv' },
    )
    expect(empty.ok).toBe(false)
    if (empty.ok) throw new Error('phải lỗi')
    expect(empty.error).toContain('chưa có cửa hàng')
    // hai tình huống khác nhau phải nói khác nhau
    expect(empty.error).not.toBe(nullPayload.error)
  })

  test('Khách: reader trả DAILY đã validate để chart dùng chung nguồn với hero', async () => {
    const { d } = deps({
      loadTargetStoreIds: async () => ({ data: ['s1', 's2'], error: null }),
      aggregateCustomers: async () => ({
        data: {
          rows: [
            { store_id: 's1', vn_date: '2026-08-01', customer_count: 2 },
            { store_id: 's2', vn_date: '2026-08-03', customer_count: 1 },
          ],
          total_customers: 3,
        },
        error: null,
      }),
    })
    const r = await readCustomer(d)
    if (!r.ok || r.mode !== 'customer') throw new Error('sai nhánh')
    // Chart phải dựng từ ĐÂY, không cắt snapshot toàn kỳ: khách cross-store có
    // thể được gán ngày/store khác giữa hai cách tính ⇒ hero và chart lệch.
    expect(r.daily).toEqual([
      { store_id: 's1', date: '2026-08-01', customers: 2 },
      { store_id: 's2', date: '2026-08-03', customers: 1 },
    ])
    // và tổng của daily khớp hero
    expect(r.daily.reduce((a, x) => a + x.customers, 0)).toBe(r.totalCustomers)
  })

  test('nhánh DAILY: data null cũng phải lỗi, không coi là danh sách rỗng', async () => {
    const { d } = deps({ loadDaily: async () => ({ data: null, error: null }) })
    const r = await loadCampaignRangeActuals(d, { campaignId: 'c1', range: RANGE, metricType: 'gmv' })
    expect(r.ok).toBe(false)
  })

  test('nhánh DAILY không đụng health gate (số đơn/tiền không phải nguồn Affiliate)', async () => {
    const { d, calls } = deps()
    await loadCampaignRangeActuals(d, { campaignId: 'c1', range: RANGE, metricType: 'gmv' })
    expect(calls.health).toBe(0)
    expect(calls.rpc).toBe(0)
  })
})
