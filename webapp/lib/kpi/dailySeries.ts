import { metricPresentation } from './campaignDisplay'

// UI v2 Phase 2 · K-6 — giá trị MỘT NGÀY của "Tiến độ theo ngày": MỘT nguồn cho CampaignDailyChart (cột + tooltip) và
// bảng số liệu ngày (<details>), để hai bề mặt không bao giờ đọc ra hai con số khác nhau. Thuần — e2e/kpi-daily-series
// khoá. Logic chuyển nguyên từ CampaignDailyChart (mig 103/106), không đổi kết quả.

export type DailySeriesKey = 'orders' | 'aov'

export interface DailySeriesPoint {
  date: string
  gmv: number
  gmv_affiliate: number
  affiliate_customer_count?: number
  // Mig 106: số đơn Offline của NGÀY (null = nguồn chưa có số đơn ⇒ GAP / '—', không phải 0).
  offline_order_count?: number | null
}

/**
 * Giá trị của ngày theo loại chiến dịch:
 * - GMV: Offline + Affiliate; Số khách: affiliate_customer_count (thiếu ⇒ 0 như chart cũ);
 * - Chất lượng bán hàng: số đơn (series 'orders') hoặc AOV = net ngày / số đơn ngày (series 'aov').
 *   Số đơn null ⇒ null; AOV ngày 0 đơn ⇒ null. null = KHÔNG vẽ cột / hiện '—', tuyệt đối không quy về 0.
 */
export function dailyPointValue(d: DailySeriesPoint, metricType: string | undefined, series: DailySeriesKey): number | null {
  const kind = metricPresentation(metricType).kind
  if (kind === 'offline_order_aov') {
    const ord = d.offline_order_count
    if (ord === null || ord === undefined) return null
    if (series === 'orders') return ord
    return ord > 0 ? d.gmv / ord : null
  }
  return kind === 'affiliate_customer_count' ? (d.affiliate_customer_count ?? 0) : d.gmv + d.gmv_affiliate
}

/** Định dạng ĐẦY ĐỦ (tooltip cột, ô bảng): số đơn là ĐẾM ("N đơn"), AOV là tiền, còn lại theo loại. */
export function dailyValueFormatter(metricType: string | undefined, series: DailySeriesKey): (n: number) => string {
  const pres = metricPresentation(metricType)
  if (pres.kind === 'offline_order_aov') {
    if (series === 'orders') {
      const nf = new Intl.NumberFormat('vi-VN')
      return (n: number) => `${nf.format(Math.round(n))} đơn`
    }
    return metricPresentation('gmv').value
  }
  return pres.value
}
