// Mig 106 r1.2 (audit P0) — CHUẨN HÓA 1 dòng daily từ Supabase, THUẦN để test
// được (page là server component, không import vào unit test).
//
// Bug đã xảy ra: query lấy `offline_order_count` nhưng `.map()` bỏ quên field
// ⇒ DB có dữ liệu mà UI hiểu là thiếu (card "Số đơn hôm nay" hiện '—', chart
// Số đơn/AOV trống trơn). Ma trận kiểu bị khóa bằng test.
//
// Quy tắc: `Number(x) || 0` biến null thành 0; `Number(x) ?? null` lại biến 0
// thành null — cả hai đều SAI trên màn tiền:
//   null/undefined/'' → null (nguồn CHƯA có số đơn — chart vẽ GAP)
//   0 hoặc '0'        → 0    (ngày KHÔNG có đơn — dữ liệu hợp lệ)
//   số/chuỗi số       → Number
//   chuỗi rác/NaN     → null (không bịa 0)
// r2 (pattern campaignDisplay): tầng lib KHÔNG import type từ component —
// shape dưới đây khớp structurally với DailyPoint của CampaignKpiView.
import { normalizeOptionalCount } from '@/lib/kpi/orderAov'

export interface DailyRawRow {
  date: string
  gmv: number | string | null
  gmv_affiliate: number | string | null
  affiliate_customer_count: number | string | null
  offline_order_count?: number | string | null
}

export interface NormalizedDailyPoint {
  date: string
  gmv: number
  gmv_affiliate: number
  affiliate_customer_count: number
  offline_order_count: number | null
}

export function normalizeDailyPoint(r: DailyRawRow): NormalizedDailyPoint {
  return {
    date: r.date,
    // Tiền/khách GIỮ NGUYÊN hành vi cũ (numeric string của Supabase → số).
    gmv: Number(r.gmv) || 0,
    gmv_affiliate: Number(r.gmv_affiliate) || 0,
    affiliate_customer_count: Number(r.affiliate_customer_count) || 0,
    // NULL có Ý NGHĨA (nguồn chưa có số đơn) — KHÁC 0 (ngày không có đơn).
    offline_order_count: normalizeOptionalCount(r.offline_order_count),
  }
}
