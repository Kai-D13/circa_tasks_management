import { test, expect } from '@playwright/test'
import {
  CAMPAIGN_RANGE_ERROR_TEXT, parseCampaignRange, rangeFilterSupported, withRangeParams,
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

  test('campaign Số khách Affiliate: KHÔNG hỗ trợ lọc', () => {
    expect(rangeFilterSupported('affiliate_customer_count')).toBe(false)
    expect(rangeFilterSupported('gmv')).toBe(true)
    expect(rangeFilterSupported('offline_order_aov')).toBe(true)
    expect(rangeFilterSupported(undefined)).toBe(true)

    const r = parseCampaignRange({
      ...CAMPAIGN, from: '2026-08-01', to: '2026-08-05',
      metricType: 'affiliate_customer_count',
    })
    expect(r.active).toBe(false)
    expect(r.error).toBe('unsupported')
    // lý do phải giải thích được cho người dùng, không phải mã lỗi trống
    expect(CAMPAIGN_RANGE_ERROR_TEXT.unsupported).toContain('mỗi khách chỉ tính một lần')
  })

  test('mọi mã lỗi đều có câu tiếng Việt đọc được', () => {
    for (const key of ['incomplete', 'malformed', 'reversed', 'outside', 'unsupported'] as const) {
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
