import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import {
  CAMPAIGN_RANGE_ERROR_TEXT, parseCampaignRange, rangeAggregationMode, withRangeParams,
} from '../lib/kpi/campaignDateRange'

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
    // Số khách KHÔNG cộng dồn daily được (dedup theo account toàn phạm vi) ⇒
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
