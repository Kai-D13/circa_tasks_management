// P3-E/F r1 — Contract HIỂN THỊ campaign (THUẦN, audit P2#3): mọi quyết định
// render breakdown / footnote / trạng thái metric-editor nằm ở đây để test
// khóa contract — component chỉ tiêu thụ.
// r2 (audit P3): structural type CỤC BỘ — tầng lib không import type từ
// component UI (tránh đảo chiều phụ thuộc); CampaignView khớp structurally.

export interface BreakdownInput {
  metric_offline: boolean
  metric_affiliate: boolean
  kpi_target: number
  actual_offline: number | null
  actual_affiliate: number | null
}

export interface BreakdownModel {
  show: boolean                 // CHỈ true khi campaign bật CẢ 2 chỉ số
  offlinePct: number | null     // % trên kpi_target — CHỈ dòng Offline
  // KHÔNG có affiliatePct (stakeholder 24/07): affiliate chia sẻ chung
  // kpi_target nên % luôn ≈0 gây hiểu nhầm — dòng Affiliate chỉ hiện số tiền.
}

export function breakdownModel(v: BreakdownInput): BreakdownModel {
  const pct = (x: number | null) =>
    x === null || v.kpi_target <= 0 ? null : Math.round((x / v.kpi_target) * 100)
  return {
    show: v.metric_offline && v.metric_affiliate,
    offlinePct: pct(v.actual_offline),
  }
}

// Chú thích nguồn theo cấu hình metric — offline-only GIỮ NGUYÊN câu production
// cũ (regression); có affiliate → nêu rõ rule DELIVERED-only.
// Mig 103: nhận metric_type optional — campaign Số khách có câu riêng (mỗi
// khách tính 1 lần); thiếu metric_type (caller cũ) = gmv, hành vi y nguyên.
export function campaignFootnote(v: { metric_offline: boolean; metric_affiliate: boolean; metric_type?: string }): string {
  if (v.metric_type === 'affiliate_customer_count') {
    return 'Nguồn: Circa Online · đếm khách có đơn giao thành công (DELIVERED) — mỗi khách tính 1 lần trong chiến dịch'
  }
  if (!v.metric_affiliate) return 'Nguồn: báo cáo BI · * Không bao gồm đơn online'
  if (v.metric_offline) return 'Nguồn: báo cáo BI + Circa Online · GMV Affiliate chỉ tính đơn giao thành công'
  return 'Nguồn: Circa Online · chỉ tính đơn giao thành công (DELIVERED)'
}

// ── Mig 103: PRESENTATION tập trung theo metric_type ────────────────────────
// Một nguồn duy nhất cho label/đơn vị/format của campaign — thay 6 bản vnd()
// lặp ở component (KpiView/ResultSummary/ResultDashboard/DailyChart/[id]/list).
// gmv: format BYTE-EQUAL formatter cũ (Intl vi-VN + '₫', null → '—'; compact
// tỷ/tr/k như CampaignDailyChart) — test khóa; customer: 'N khách'.
export type CampaignMetricType = 'gmv' | 'affiliate_customer_count'

export interface MetricPresentation {
  kind: CampaignMetricType
  targetLabel: string            // 'Mục tiêu GMV' | 'Mục tiêu số khách'
  actualHeroLabel: string        // hero "Đã đạt" giữ chung
  todayLabel: string             // 'GMV hôm nay' | 'Khách hôm nay'
  perDayLabel: string            // 'Trung bình/ngày cần đạt' (chung)
  actualColumnLabel: string      // cột bảng: 'Actual GMV' | 'Số khách'
  chartAriaLabel: string
  value(n: number | null | undefined): string
  compact(n: number): string
  zero: string                   // '0₫' | '0 khách'
}

const nfVi = new Intl.NumberFormat('vi-VN')
const GMV_PRESENTATION: MetricPresentation = {
  kind: 'gmv',
  targetLabel: 'Mục tiêu GMV',
  actualHeroLabel: 'Đã đạt',
  todayLabel: 'GMV hôm nay',
  perDayLabel: 'Trung bình/ngày cần đạt',
  actualColumnLabel: 'Actual GMV',
  chartAriaLabel: 'Biểu đồ GMV theo ngày',
  value: (n) => (n === null || n === undefined ? '—' : `${nfVi.format(Math.round(n))}₫`),
  // BYTE-EQUAL compactVnd cũ của CampaignDailyChart (tỷ/tr/k, không space,
  // toFixed(1) GIỮ '.0') — test khóa từng case.
  compact: (n) =>
    n >= 1_000_000_000 ? `${(n / 1_000_000_000).toFixed(1)}tỷ`
    : n >= 1_000_000 ? `${Math.round(n / 1_000_000)}tr`
    : n >= 1_000 ? `${Math.round(n / 1_000)}k`
    : `${Math.round(n)}`,
  zero: '0₫',
}
const CUSTOMER_PRESENTATION: MetricPresentation = {
  kind: 'affiliate_customer_count',
  targetLabel: 'Mục tiêu số khách',
  actualHeroLabel: 'Đã đạt',
  todayLabel: 'Khách hôm nay',
  perDayLabel: 'Trung bình/ngày cần đạt',
  actualColumnLabel: 'Số khách',
  chartAriaLabel: 'Biểu đồ số khách theo ngày',
  value: (n) => (n === null || n === undefined ? '—' : `${nfVi.format(Math.round(n))} khách`),
  compact: (n) => nfVi.format(Math.round(n)),
  zero: '0 khách',
}

// Default 'gmv' cho MỌI giá trị lạ/thiếu (caller cũ chưa truyền metric_type
// giữ nguyên hiển thị tiền — an toàn hiển thị; số liệu đã bị DB/engine chặn).
export function metricPresentation(metricType?: string | null): MetricPresentation {
  return metricType === 'affiliate_customer_count' ? CUSTOMER_PRESENTATION : GMV_PRESENTATION
}

// (H1.2 smSelectorVisible đã GỠ 27/07: SM Dashboard r2 thay store-selector-
// navigation bằng regional list + filter store trong dashboard — xem
// lib/kpi/resultModel smScopeState.)

// r1 P2#1: flag tắt + campaign có affiliate → khóa TOÀN BỘ editor (cả checkbox
// Offline lẫn nút lưu) — không để user sửa được UI rồi server mới từ chối.
export interface MetricEditorState {
  editable: boolean             // được sửa + hiện nút lưu
  metricsLocked: boolean        // khóa vì flag tắt trên campaign affiliate
  showAffiliateControl: boolean // hiện dòng affiliate (flag bật, hoặc campaign sẵn có để đọc)
}

export function metricEditorState(p: {
  status: string
  affiliateEnabled: boolean
  metricAffiliate: boolean
  // Mig 103: campaign Số khách — loại BẤT BIẾN sau tạo → editor khóa hẳn
  // (read-only), không phụ thuộc status/flag khác.
  metricType?: string
}): MetricEditorState {
  if (p.metricType === 'affiliate_customer_count') {
    return { editable: false, metricsLocked: true, showAffiliateControl: false }
  }
  const statusEditable = p.status === 'draft' || p.status === 'paused'
  const metricsLocked = !p.affiliateEnabled && p.metricAffiliate
  return {
    editable: statusEditable && !metricsLocked,
    metricsLocked,
    showAffiliateControl: p.affiliateEnabled || p.metricAffiliate,
  }
}

// ── 105 (11/08): dòng phụ "Số đơn · AOV" cho GMV Offline ────────────────────
// KHÔNG thêm cột bảng (yêu cầu stakeholder: không rối mắt, hạn chế scroll
// ngang) — chuỗi này nằm dưới ô/card GMV Offline (hybrid) hoặc Actual GMV
// (offline-only). Trả null ⇒ KHÔNG render dòng nào:
//   · count == null → nguồn/snapshot chưa có số đơn (KHÁC 0 đơn) — không bịa
//   · campaign khách / affiliate-only → caller không gọi
// AOV = offline / count (weighted per store), làm tròn tới VNĐ; count = 0 →
// hiện "0 đơn" (số thật) nhưng AOV '—' (không chia 0).
export function offlineOrderLine(offline: number | null, count: number | null): string | null {
  if (count === null || count === undefined) return null
  const nf = new Intl.NumberFormat('vi-VN')
  const orders = `${nf.format(count)} đơn`
  if (count <= 0) return `${orders} · AOV —`
  const aov = Math.round((Number(offline) || 0) / count)
  return `${orders} · AOV ${nf.format(aov)}₫`
}
