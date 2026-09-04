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

// ── Làm tròn theo TOÀN KHOẢNG, phân bổ phần dư ──────────────────────────────
// Contract 04/09 điểm 3 nói ROUND(SUM(cả khoảng)), nhưng Supabase/UI phải lưu
// số nguyên theo TỪNG NGÀY (chart + invariant SUM(daily) = tổng kỳ). Làm tròn
// từng ngày rồi cộng lại KHÔNG bằng làm tròn tổng: hai ngày 0,4đ cho ra 0đ
// trong khi contract đòi 1đ.
// Cách duy nhất thoả cả hai: làm tròn tổng MỘT LẦN, làm tròn từng ngày, rồi
// dồn phần chênh vào NGÀY CUỐI (xác định, không rải ngẫu nhiên).
export function allocateRoundedDaily(rawByDate: Map<string, number>): Map<string, number> {
  const dates = [...rawByDate.keys()].sort()
  const out = new Map<string, number>()
  if (dates.length === 0) return out
  const total = roundRevenue([...rawByDate.values()].reduce((a, b) => a + b, 0))
  let acc = 0
  for (const d of dates) {
    const v = roundRevenue(rawByDate.get(d) as number)
    out.set(d, v)
    acc += v
  }
  if (acc !== total) {
    const last = dates[dates.length - 1]
    out.set(last, (out.get(last) as number) + (total - acc))
  }
  return out
}
