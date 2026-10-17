import { test, expect } from '@playwright/test'
import { dailyPointValue, dailyValueFormatter } from '../lib/kpi/dailySeries'

// UI v2 K-6 — giá trị một ngày của "Tiến độ theo ngày": MỘT nguồn cho CampaignDailyChart và bảng số liệu ngày.
// null = không vẽ cột / '—' (không bao giờ quy về 0).

test.describe('kpi daily series contract @desktop', () => {
  const P = (o: Partial<{ gmv: number; gmv_affiliate: number; affiliate_customer_count: number; offline_order_count: number | null }>) =>
    ({ date: '2026-10-15', gmv: 0, gmv_affiliate: 0, ...o })

  test('GMV = Offline + Affiliate (0 thật vẫn là 0); Số khách = affiliate_customer_count (thiếu ⇒ 0 như chart cũ)', () => {
    expect(dailyPointValue(P({ gmv: 13_300_000, gmv_affiliate: 900_000 }), 'gmv', 'orders')).toBe(14_200_000)
    expect(dailyPointValue(P({}), undefined, 'orders')).toBe(0)
    expect(dailyPointValue(P({ affiliate_customer_count: 4, gmv: 999 }), 'affiliate_customer_count', 'orders')).toBe(4)
    expect(dailyPointValue(P({}), 'affiliate_customer_count', 'orders')).toBe(0)
  })

  test('Chất lượng bán hàng: số đơn null ⇒ null; AOV = net/đơn, 0 đơn ⇒ null (gap, không phải 0₫)', () => {
    expect(dailyPointValue(P({ offline_order_count: 19, gmv: 2_682_000 }), 'offline_order_aov', 'orders')).toBe(19)
    expect(dailyPointValue(P({ offline_order_count: null, gmv: 2_682_000 }), 'offline_order_aov', 'orders')).toBeNull()
    expect(dailyPointValue(P({ gmv: 2_682_000 }), 'offline_order_aov', 'orders')).toBeNull()
    expect(dailyPointValue(P({ offline_order_count: 19, gmv: 2_682_000 }), 'offline_order_aov', 'aov')).toBeCloseTo(141_157.89, 2)
    expect(dailyPointValue(P({ offline_order_count: 0, gmv: 2_682_000 }), 'offline_order_aov', 'aov')).toBeNull()
    expect(dailyPointValue(P({ offline_order_count: 0 }), 'offline_order_aov', 'orders')).toBe(0)
  })

  test('định dạng đầy đủ: đơn là ĐẾM ("N đơn"), AOV là tiền, GMV tiền, Số khách "N khách"', () => {
    expect(dailyValueFormatter('offline_order_aov', 'orders')(1234)).toBe('1.234 đơn')
    expect(dailyValueFormatter('offline_order_aov', 'aov')(141_157.89)).toBe('141.158₫')
    expect(dailyValueFormatter('gmv', 'orders')(14_200_000)).toBe('14.200.000₫')
    expect(dailyValueFormatter(undefined, 'aov')(0)).toBe('0₫')
    expect(dailyValueFormatter('affiliate_customer_count', 'orders')(3)).toMatch(/^3 khách$/)
  })
})
