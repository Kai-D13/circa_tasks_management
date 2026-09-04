// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT NGUỒN BIGQUERY SAU KHI BI TÁCH OFFLINE / AFFILIATE (04/09/2026)
//
// View `buymed_tech.tech__circa_os_gmv_kpi` đổi cột:
//     net_revenue → offline_net_revenue        no_order → offline_no_order
//   (+ affiliate_net_revenue, affiliate_no_order, offline_aov, affiliate_aov)
// Cột cũ BIẾN MẤT ⇒ query cũ trả "Unrecognized name: net_revenue" (đã tái hiện
// 04/09) — landing /targets vì thế đứng im từ 05/08.
//
// ⚠ INFORMATION_SCHEMA KHÔNG đáng tin ở đây: đối tượng này là VIEW và metadata
// vẫn liệt kê cột cũ. Sự thật là schema mà một câu SELECT thật trả về.
//
// File THUẦN: không import BQ/Supabase client. Nơi duy nhất định nghĩa "đọc một
// ô dữ liệu nguồn nghĩa là gì", để orchestrator không tự chế lại mỗi chỗ một kiểu.
// ─────────────────────────────────────────────────────────────────────────────

/** Tên cột nguồn — canary trong test khoá đúng bộ này. */
export const SOURCE_COLUMNS = {
  offlineRevenue:   'offline_net_revenue',
  offlineOrders:    'offline_no_order',
  affiliateRevenue: 'affiliate_net_revenue',
  affiliateOrders:  'affiliate_no_order',
} as const

/** Identifier đã bị BI xoá — không được xuất hiện trong bất kỳ SQL nào nữa. */
export const RETIRED_SOURCE_COLUMNS = ['net_revenue', 'no_order'] as const

// BigQuery REST trả MỌI giá trị dạng chuỗi ("1.3406148E7"), và NULL là null.
//   null      → ô trống THẬT SỰ (giữ nguyên, KHÔNG đổi thành 0)
//   undefined → không đọc được (thiếu field / NaN / Infinity / rác) ⇒ lỗi nguồn
// Phân biệt hai thứ này là điểm mấu chốt: gộp chúng lại là cách một ngày mất
// dữ liệu biến thành "0đ" trên màn tiền.
export function parseSourceNumber(raw: unknown): number | null | undefined {
  if (raw === null) return null
  if (raw === undefined || raw === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

// Contract 04/09 điểm 3+4: làm tròn về ĐỒNG, giữ số âm, KHÔNG floor.
// Nửa đơn vị làm tròn RA XA số 0 — khớp hành vi ROUND() của BigQuery
// (ROUND(-2.5) = -3), để số làm tròn ở SQL và ở app không bao giờ lệch nhau.
export function roundRevenue(n: number): number {
  return Math.sign(n) * Math.round(Math.abs(n))
}

// ── 112.4: SNAP VỀ ĐỒNG NGUYÊN, KHÔNG phân bổ phần dư ───────────────────────
// Đo trên TOÀN BỘ view (04/09, 7.139 dòng DAY): độ lệch lớn nhất giữa giá trị
// nguồn và số nguyên gần nhất là 9,3e-10 đ (grain MONTH/WEEK lệch đúng 0).
// Nguồn KHÔNG có phần lẻ VND thật — phần thập phân chỉ là nhiễu FLOAT64
// (vd 310999.99999999994 = 311.000).
//
// Vì vậy KHÔNG cần phân bổ phần dư (bản 112.3 dồn chênh lệch vào ngày cuối).
// Cách đó làm tổng CẢ KỲ đúng nhưng MỌI KHOẢNG CON sai — bộ lọc ngày cộng các
// daily integer nên một ngày có thể hiện 1đ trong khi ROUND(SUM(raw)) là 0đ
// (audit P1#1). Snap từng ngày về số nguyên thì mọi khoảng con đều đúng, vì
// tổng của các số nguyên vốn đã là số nguyên.
//
// Ngoài tolerance ⇒ BI đã đổi contract (bắt đầu phát sinh phần lẻ VND thật):
// trả undefined để caller FAIL-CLOSED, tuyệt đối không tự làm tròn tiền.
// EPS = 1e-6 đ: gấp ~1.000 lần nhiễu đã đo, và nhỏ hơn 1 đồng 1 triệu lần nên
// một phần lẻ THẬT (dù chỉ 0,001đ) vẫn bị bắt.
export const REVENUE_SNAP_EPSILON = 1e-6

export function snapRevenue(n: number): number | undefined {
  if (!Number.isFinite(n)) return undefined
  const r = roundRevenue(n)
  return Math.abs(n - r) <= REVENUE_SNAP_EPSILON ? r : undefined
}
