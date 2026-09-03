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

// ── Trạng thái Affiliate của một (POS × ngày) ────────────────────────────────
// Contract 04/09 điểm 5. Đối soát 4 ngày với sổ Affiliate thật (04/09): tổng
// SỐ ĐƠN của BQ khớp tuyệt đối Supabase, và view CHƯA BAO GIỜ phát ra 0 trong
// 18 ngày ⇒ NULL là "không phát sinh", không phải "chưa nạp".
// Chỉ MỘT trong hai field NULL là mâu thuẫn nội tại ⇒ fail-closed.
export type AffiliateDayState =
  | { kind: 'none' }
  | { kind: 'value'; revenue: number; orders: number }
  | { kind: 'invalid'; detail: string }

export function affiliateDayState(rawRevenue: unknown, rawOrders: unknown): AffiliateDayState {
  const revenue = parseSourceNumber(rawRevenue)
  const orders = parseSourceNumber(rawOrders)
  if (revenue === undefined || orders === undefined) {
    return { kind: 'invalid', detail: `giá trị Affiliate không đọc được (revenue=${String(rawRevenue)}, orders=${String(rawOrders)})` }
  }
  if (revenue === null && orders === null) return { kind: 'none' }
  if (revenue === null || orders === null) {
    return {
      kind: 'invalid',
      detail: `Affiliate chỉ một field NULL (revenue=${String(rawRevenue)}, orders=${String(rawOrders)}) — nguồn mâu thuẫn`,
    }
  }
  if (!Number.isInteger(orders) || orders < 0) {
    return { kind: 'invalid', detail: `số đơn Affiliate không hợp lệ: ${String(rawOrders)}` }
  }
  return { kind: 'value', revenue, orders }
}

// ── Trạng thái Offline của một (POS × ngày) ──────────────────────────────────
// Contract 04/09 điểm 6: Offline NULL = nguồn CHƯA HỢP LỆ → preserve snapshot.
// Khác hẳn Affiliate: cửa hàng luôn có doanh thu offline (kể cả 0), nên NULL ở
// đây là dấu hiệu nguồn hỏng chứ không phải "không phát sinh".
// Doanh thu ÂM hợp lệ (hoàn/điều chỉnh). Số đơn phải nguyên >= 0.
export type OfflineDayState =
  | { kind: 'value'; revenue: number; orders: number }
  | { kind: 'invalid'; detail: string }

export function offlineDayState(rawRevenue: unknown, rawOrders: unknown): OfflineDayState {
  const revenue = parseSourceNumber(rawRevenue)
  const orders = parseSourceNumber(rawOrders)
  if (revenue === undefined) return { kind: 'invalid', detail: `doanh thu Offline không đọc được: ${String(rawRevenue)}` }
  if (revenue === null) return { kind: 'invalid', detail: 'doanh thu Offline NULL — nguồn chưa hoàn tất' }
  if (orders === undefined) return { kind: 'invalid', detail: `số đơn Offline không đọc được: ${String(rawOrders)}` }
  if (orders === null) return { kind: 'invalid', detail: 'số đơn Offline NULL — nguồn chưa hoàn tất' }
  if (!Number.isInteger(orders) || orders < 0) {
    return { kind: 'invalid', detail: `số đơn Offline không hợp lệ: ${String(rawOrders)}` }
  }
  return { kind: 'value', revenue, orders }
}
