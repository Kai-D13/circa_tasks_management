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
  offlinePct: number | null     // % trên CÙNG kpi_target
  affiliatePct: number | null
}

export function breakdownModel(v: BreakdownInput): BreakdownModel {
  const pct = (x: number | null) =>
    x === null || v.kpi_target <= 0 ? null : Math.round((x / v.kpi_target) * 100)
  return {
    show: v.metric_offline && v.metric_affiliate,
    offlinePct: pct(v.actual_offline),
    affiliatePct: pct(v.actual_affiliate),
  }
}

// Chú thích nguồn theo cấu hình metric — offline-only GIỮ NGUYÊN câu production
// cũ (regression); có affiliate → nêu rõ rule DELIVERED-only.
export function campaignFootnote(v: { metric_offline: boolean; metric_affiliate: boolean }): string {
  if (!v.metric_affiliate) return 'Nguồn: báo cáo BI · * Không bao gồm đơn online'
  if (v.metric_offline) return 'Nguồn: báo cáo BI + Circa Online · GMV Affiliate chỉ tính đơn giao thành công'
  return 'Nguồn: Circa Online · chỉ tính đơn giao thành công (DELIVERED)'
}

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
}): MetricEditorState {
  const statusEditable = p.status === 'draft' || p.status === 'paused'
  const metricsLocked = !p.affiliateEnabled && p.metricAffiliate
  return {
    editable: statusEditable && !metricsLocked,
    metricsLocked,
    showAffiliateControl: p.affiliateEnabled || p.metricAffiliate,
  }
}
