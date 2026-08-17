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
import { metricPresentation, REVENUE_LABELS } from '@/lib/kpi/campaignDisplay'

export interface ResultTableColumn {
  key: string
  label: string
  minPx: number
  align: 'left' | 'right'
  // all = mọi viewport · desktop = hidden lg:table-cell · mobile = lg:hidden
  scope: 'all' | 'desktop' | 'mobile'
}

// Khoảng px theo audit 29/07: Cửa hàng 160–180 · Phân loại 90–110 ·
// KPI/GMV 130–150 · %/Nhịp độ 100–120 · Trung bình/ngày 140 · mỗi Bậc 170–190.
export const RESULT_COL_PX = {
  store: 180,
  group: 100,
  money: 140,
  pct: 110,
  pace: 100,
  perDay: 140,   // 10/08: thay cột 'Còn thiếu' (đã bỏ) — 'Trung bình/ngày'
  orderAov: 230, // 106: cột GỘP 2 dòng "Số đơn · AOV" (thay vì 2 cột ngang)
  quality: 150,  // 106: trạng thái đạt/chưa đạt 2 mục tiêu
  combined: 170, // cột gộp "Bậc đạt · Commission" (mobile giữ UI cũ)
  tier: 176,
} as const

// Mig 103: metricType đổi DUY NHẤT label cột actual ('Actual GMV' → 'Số
// khách'); campaign GMV giữ mảng label BẤT BIẾN (test khóa); width contract
// không đổi (số khách ngắn hơn tiền — min-width cũ vẫn đúng).
export function resultTableColumns(maxTierCount: number, showBreakdown: boolean, metricType?: string): ResultTableColumn[] {
  // Mig 106: Chất lượng bán hàng — cột actual là ĐIỂM %, và Order/AOV gộp vào
  // MỘT cột 2 dòng (yêu cầu stakeholder: không tăng cột ngang).
  const isOrderAov = metricType === 'offline_order_aov'
  // 17/08: lấy nhãn TỪ presentation thay vì chép lại chuỗi ở đây — bản cũ
  // hardcode 'Actual GMV' nên đổi thuật ngữ ở contract mà bảng vẫn hiện chữ cũ.
  const actualLabel = isOrderAov ? 'Hoàn thành' : metricPresentation(metricType).actualColumnLabel
  return [
    { key: 'store', label: 'Cửa hàng', minPx: RESULT_COL_PX.store, align: 'left', scope: 'all' },
    { key: 'group', label: 'Phân loại', minPx: RESULT_COL_PX.group, align: 'left', scope: 'all' },
    // r1.1 (audit P2): Chất lượng bán hàng BỎ cột 'KPI target' (luôn 100% —
    // không mang thông tin) và gộp '%' vào chính cột Hoàn thành.
    ...(isOrderAov ? [] : [
      { key: 'kpiTarget', label: 'KPI target', minPx: RESULT_COL_PX.money, align: 'right', scope: 'all' } as const,
    ]),
    { key: 'actual', label: actualLabel, minPx: RESULT_COL_PX.money, align: 'right', scope: 'all' },
    ...(isOrderAov ? [
      { key: 'orderAov', label: 'Số đơn · AOV (thực tế / mục tiêu)', minPx: RESULT_COL_PX.orderAov, align: 'left', scope: 'all' } as const,
      { key: 'quality', label: 'Trạng thái', minPx: RESULT_COL_PX.quality, align: 'left', scope: 'all' } as const,
    ] : []),
    ...(showBreakdown ? [
      { key: 'offline', label: REVENUE_LABELS.offline, minPx: RESULT_COL_PX.money, align: 'right', scope: 'all' } as const,
      { key: 'affiliate', label: REVENUE_LABELS.affiliate, minPx: RESULT_COL_PX.money, align: 'right', scope: 'all' } as const,
    ] : []),
    ...(isOrderAov ? [] : [
      { key: 'pct', label: '%', minPx: RESULT_COL_PX.pct, align: 'right', scope: 'all' } as const,
    ]),
    { key: 'pace', label: 'Nhịp độ', minPx: RESULT_COL_PX.pace, align: 'right', scope: 'all' },
    // 10/08 (stakeholder): BỎ cột 'Còn thiếu' ở bảng tổng — thay bằng
    // 'Trung bình/ngày' (CÙNG công thức card Staff). remaining_target VẪN giữ
    // trong model/DB/export + các dòng 'Còn thiếu' trong từng cột Bậc (khoảng
    // cách tới threshold — nghĩa khác, không trùng cột bị bỏ).
    // r1.1: ẩn với Chất lượng bán hàng — "điểm %/ngày" không tương đương số
    // đơn/ngày hay AOV/ngày (khuyến nghị audit, stakeholder có thể bật lại).
    ...(isOrderAov ? [] : [
      { key: 'perDay', label: 'Trung bình/ngày', minPx: RESULT_COL_PX.perDay, align: 'right', scope: 'all' } as const,
    ]),
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
export function resultTableDesktopMinPx(maxTierCount: number, showBreakdown: boolean, metricType?: string): number {
  // r1 (audit): PHẢI truyền metricType — thiếu sẽ tính sai tổng width khi loại
  // campaign có cột riêng (106 thêm 2 cột).
  return resultTableColumns(maxTierCount, showBreakdown, metricType)
    .filter((c) => c.scope !== 'mobile')
    .reduce((sum, c) => sum + c.minPx, 0)
}
