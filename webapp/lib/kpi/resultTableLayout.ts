// r1.6 (P1 UI responsive 29/07) — WIDTH CONTRACT của bảng Kết quả campaign
// (Super + SM dùng chung CampaignResultDashboard). THUẦN: không import
// component/DB; test khóa ở e2e/kpi-result-table-layout.spec.ts.
//
// Vấn đề gốc: cột không có width contract → trình duyệt tự tính theo độ dài
// số tiền/text, layout đổi theo dữ liệu và tràn vùng hiển thị ở zoom 100%.
// Contract: mỗi cột có min-width cố định (px literal — root font 15px nên rem
// lừa); bảng scroll NGANG + DỌC trong MỘT container riêng (không bao giờ để
// body scroll ngang — guardrail circa-ui); N cột Bậc render động theo
// maxTierCount (không hardcode 3).
export interface ResultTableColumn {
  key: string
  label: string
  minPx: number
  align: 'left' | 'right'
  // all = mọi viewport · desktop = hidden lg:table-cell · mobile = lg:hidden
  scope: 'all' | 'desktop' | 'mobile'
}

// Khoảng px theo audit 29/07: Cửa hàng 160–180 · Phân loại 90–110 ·
// KPI/GMV 130–150 · %/Nhịp độ 100–120 · Còn thiếu 140 · mỗi Bậc 170–190.
export const RESULT_COL_PX = {
  store: 180,
  group: 100,
  money: 140,
  pct: 110,
  pace: 100,
  remaining: 140,
  combined: 170, // cột gộp "Bậc đạt · Commission" (mobile giữ UI cũ)
  tier: 176,
} as const

// Mig 103: metricType đổi DUY NHẤT label cột actual ('Actual GMV' → 'Số
// khách'); campaign GMV giữ mảng label BẤT BIẾN (test khóa); width contract
// không đổi (số khách ngắn hơn tiền — min-width cũ vẫn đúng).
export function resultTableColumns(maxTierCount: number, showBreakdown: boolean, metricType?: string): ResultTableColumn[] {
  const actualLabel = metricType === 'affiliate_customer_count' ? 'Số khách' : 'Actual GMV'
  return [
    { key: 'store', label: 'Cửa hàng', minPx: RESULT_COL_PX.store, align: 'left', scope: 'all' },
    { key: 'group', label: 'Phân loại', minPx: RESULT_COL_PX.group, align: 'left', scope: 'all' },
    { key: 'kpiTarget', label: 'KPI target', minPx: RESULT_COL_PX.money, align: 'right', scope: 'all' },
    { key: 'actual', label: actualLabel, minPx: RESULT_COL_PX.money, align: 'right', scope: 'all' },
    ...(showBreakdown ? [
      { key: 'offline', label: 'GMV Offline', minPx: RESULT_COL_PX.money, align: 'right', scope: 'all' } as const,
      { key: 'affiliate', label: 'GMV Affiliate', minPx: RESULT_COL_PX.money, align: 'right', scope: 'all' } as const,
    ] : []),
    { key: 'pct', label: '%', minPx: RESULT_COL_PX.pct, align: 'right', scope: 'all' },
    { key: 'pace', label: 'Nhịp độ', minPx: RESULT_COL_PX.pace, align: 'right', scope: 'all' },
    { key: 'remaining', label: 'Còn thiếu', minPx: RESULT_COL_PX.remaining, align: 'right', scope: 'all' },
    { key: 'tierCombined', label: 'Bậc đạt · Commission', minPx: RESULT_COL_PX.combined, align: 'left', scope: 'mobile' },
    ...Array.from({ length: Math.max(0, maxTierCount) }, (_, i) => ({
      key: `tier-${i + 1}`,
      label: `Bậc ${i + 1}`,
      minPx: RESULT_COL_PX.tier,
      align: 'left' as const,
      scope: 'desktop' as const,
    })),
  ]
}

// Tổng min-width vùng desktop (mọi cột trừ mobile-only) — tài liệu/QA: cho
// biết bảng cần bao nhiêu px trước khi scroll ngang nội bộ kích hoạt.
export function resultTableDesktopMinPx(maxTierCount: number, showBreakdown: boolean): number {
  return resultTableColumns(maxTierCount, showBreakdown)
    .filter((c) => c.scope !== 'mobile')
    .reduce((sum, c) => sum + c.minPx, 0)
}
