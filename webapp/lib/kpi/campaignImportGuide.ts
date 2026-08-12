// Mig 103 r1 (audit P1#2) — GUIDE/TEMPLATE import campaign tách thành module
// THUẦN để (1) CampaignImport render theo ĐÚNG loại chiến dịch (customer không
// còn thấy target tiền 450000000 + rule ranh giới tiền → hết nguy cơ Admin
// nhập nhầm hàng trăm triệu KHÁCH) và (2) spec khóa regression: template GMV
// GIỮ NGUYÊN TỪNG BYTE; template customer không chứa target tiền.
// Đồng bộ với parser (lib/kpi/campaignImport.ts) + RPC 103 (integer guard).

export interface ImportGuideColumn { col: string; meaning: string; example: string; optional?: boolean }
export interface ImportGuideModel {
  columns: ImportGuideColumn[]
  sampleCsv: string
  sampleFileName: string
  /** Câu cảnh báo dưới bảng guide — null = không hiện (customer bỏ rule biên tiền). */
  boundaryWarning: string | null
  targetHeaderLabel: string    // header cột preview: 'KPI target' | 'KPI target (khách)'
  /** Format giá trị target ở bảng preview ('450.000.000' | '100 khách'). */
  formatTarget(n: number): string
  /** Toast sau khi nạp thành công (nhắc bước đồng bộ kế tiếp theo metric). */
  commitToast(upserted: number | string): string
}

const nfVi = new Intl.NumberFormat('vi-VN')

// GMV — NGUYÊN VĂN nội dung production trước 103 (spec khóa byte-equal).
const GMV_GUIDE: ImportGuideModel = {
  columns: [
    { col: 'pos_code', meaning: 'Mã cửa hàng', example: 'POS0059' },
    { col: 'kpi_target', meaning: 'KPI doanh số của Store trong kỳ chiến dịch', example: '450000000' },
    { col: 'store_kpi_group', meaning: 'Phân loại Store theo KPI (nhãn hiển thị)', example: 'Nhỏ hơn 500 triệu' },
    { col: 'tier_1_threshold_pct', meaning: 'Mốc đạt KPI bậc 1 (%)', example: '90' },
    { col: 'tier_1_commission_amount', meaning: 'Commission Store bậc 1 (số tiền)', example: '15000000' },
    { col: 'tier_2_threshold_pct', meaning: 'Mốc đạt KPI bậc 2 (%)', example: '100' },
    { col: 'tier_2_commission_amount', meaning: 'Commission Store bậc 2 (số tiền)', example: '20800000' },
    { col: 'tier_3_threshold_pct', meaning: 'Mốc đạt KPI bậc 3 (%)', example: '105' },
    { col: 'tier_3_commission_amount', meaning: 'Commission Store bậc 3 (số tiền)', example: '26300000' },
    { col: 'pos_name', meaning: 'Tên cửa hàng', example: 'CIRCA TAM VIET', optional: true },
    { col: 'note', meaning: 'Ghi chú', example: 'Demo', optional: true },
  ],
  sampleCsv: [
    'pos_code,kpi_target,store_kpi_group,tier_1_threshold_pct,tier_1_commission_amount,tier_2_threshold_pct,tier_2_commission_amount,tier_3_threshold_pct,tier_3_commission_amount,pos_name,note',
    'POS0059,450000000,Nhỏ hơn 500 triệu,90,15000000,100,20800000,105,26300000,CIRCA TAM VIET,Demo',
    'POS0009,250000000,Nhỏ hơn 300 triệu,90,10600000,100,14700000,105,18500000,CIRCA CENTRAL,Demo',
  ].join('\n'),
  sampleFileName: 'mau-chien-dich-kpi.csv',
  boundaryWarning: 'Lưu ý: kpi_target không được trùng đúng ranh giới nhóm (200/300/500/800 triệu, 1 tỷ).',
  targetHeaderLabel: 'KPI target',
  formatTarget: (n) => nfVi.format(Math.round(n)),
  commitToast: (upserted) =>
    `Đã nạp ${upserted} cửa hàng — kết quả cũ đã được xoá, bấm "Đồng bộ doanh số" ở tab Kết quả để cập nhật`,
}

// Customer — target = SỐ KHÁCH nguyên; KHÔNG rule biên tiền; commission vẫn VNĐ.
const CUSTOMER_GUIDE: ImportGuideModel = {
  columns: [
    { col: 'pos_code', meaning: 'Mã cửa hàng', example: 'POS0059' },
    { col: 'kpi_target', meaning: 'Số khách mục tiêu trong kỳ (SỐ NGUYÊN — đơn vị khách)', example: '100' },
    { col: 'store_kpi_group', meaning: 'Phân loại Store (nhãn hiển thị theo file)', example: 'Nhóm A' },
    { col: 'tier_1_threshold_pct', meaning: 'Mốc đạt KPI bậc 1 (% số khách mục tiêu)', example: '90' },
    { col: 'tier_1_commission_amount', meaning: 'Commission Store bậc 1 (số tiền VNĐ)', example: '15000000' },
    { col: 'tier_2_threshold_pct', meaning: 'Mốc đạt KPI bậc 2 (%)', example: '100' },
    { col: 'tier_2_commission_amount', meaning: 'Commission Store bậc 2 (số tiền VNĐ)', example: '20800000' },
    { col: 'pos_name', meaning: 'Tên cửa hàng', example: 'CIRCA TAM VIET', optional: true },
    { col: 'note', meaning: 'Ghi chú', example: 'Demo', optional: true },
  ],
  sampleCsv: [
    'pos_code,kpi_target,store_kpi_group,tier_1_threshold_pct,tier_1_commission_amount,tier_2_threshold_pct,tier_2_commission_amount,pos_name,note',
    'POS0059,100,Nhóm A,90,15000000,100,20800000,CIRCA TAM VIET,Demo',
    'POS0009,50,Nhóm B,90,10600000,100,14700000,CIRCA CENTRAL,Demo',
  ].join('\n'),
  sampleFileName: 'mau-chien-dich-so-khach.csv',
  boundaryWarning: null,
  targetHeaderLabel: 'KPI target (khách)',
  formatTarget: (n) => `${nfVi.format(Math.round(n))} khách`,
  commitToast: (upserted) =>
    `Đã nạp ${upserted} cửa hàng — kết quả cũ đã được xoá, bấm "Đồng bộ số khách" ở tab Kết quả để cập nhật`,
}

// Mig 106 — Chất lượng bán hàng: file CHỈ có 4 chỉ số sàn/mục tiêu.
// KHÔNG kpi_target (hệ thống chuẩn hóa = 100%) và KHÔNG net_revenue (số tham
// khảo của Finance — AOV đã làm tròn VNĐ nên net ≠ order_target × aov_target).
const ORDER_AOV_GUIDE: ImportGuideModel = {
  columns: [
    { col: 'pos_code', meaning: 'Mã cửa hàng', example: 'POS0018' },
    { col: 'order_floor', meaning: 'SÀN số đơn trong kỳ (bắt buộc đạt — số nguyên)', example: '888' },
    { col: 'aov_floor', meaning: 'SÀN giá trị đơn trung bình (VNĐ nguyên, bắt buộc đạt)', example: '190540' },
    { col: 'order_target', meaning: 'Số đơn mục tiêu (>= order_floor)', example: '1046' },
    { col: 'aov_target', meaning: 'AOV mục tiêu VNĐ (>= aov_floor)', example: '194046' },
    { col: 'store_kpi_group', meaning: 'Phân loại Store (nhãn hiển thị theo file)', example: 'Nhóm A' },
    { col: 'tier_1_threshold_pct', meaning: 'Mốc hoàn thành bậc 1 (% điểm chất lượng)', example: '90' },
    { col: 'tier_1_commission_amount', meaning: 'Commission Store bậc 1 (số tiền VNĐ)', example: '15000000' },
    { col: 'tier_2_threshold_pct', meaning: 'Mốc hoàn thành bậc 2 (%)', example: '100' },
    { col: 'tier_2_commission_amount', meaning: 'Commission Store bậc 2 (số tiền VNĐ)', example: '20800000' },
    { col: 'pos_name', meaning: 'Tên cửa hàng', example: 'CIRCA SIGNATURE', optional: true },
    { col: 'note', meaning: 'Ghi chú', example: 'Demo', optional: true },
  ],
  sampleCsv: [
    'pos_code,order_floor,aov_floor,order_target,aov_target,store_kpi_group,tier_1_threshold_pct,tier_1_commission_amount,tier_2_threshold_pct,tier_2_commission_amount,pos_name,note',
    'POS0018,888,190540,1046,194046,Nhóm A,90,15000000,100,20800000,CIRCA SIGNATURE,Demo',
    'POS0013,971,123849,1187,126644,Nhóm A,90,15000000,100,20800000,CIRCA MIZUKI,Demo',
    'POS0065,479,221758,586,226762,Nhóm A,90,15000000,100,20800000,CIRCA SYMPHONY,Demo',
  ].join('\n'),
  sampleFileName: 'mau-chien-dich-chat-luong-ban-hang.csv',
  boundaryWarning: 'Điểm hoàn thành = 90% số đơn + 10% AOV (so với SÀN). File KHÔNG có cột kpi_target (hệ thống chuẩn hóa 100%) và KHÔNG có net_revenue.',
  targetHeaderLabel: 'Mục tiêu (đơn · AOV)',
  // Cột target ở preview hiển thị điểm chuẩn hóa — số đơn/AOV có cột riêng.
  formatTarget: () => '100%',
  commitToast: (upserted) =>
    `Đã nạp ${upserted} cửa hàng — kết quả cũ đã được xoá, bấm "Đồng bộ chất lượng bán hàng" ở tab Kết quả để cập nhật`,
}

// Default 'gmv' cho giá trị lạ/thiếu (caller cũ) — nhất quán metricPresentation.
export function campaignImportGuide(metricType?: string | null): ImportGuideModel {
  if (metricType === 'affiliate_customer_count') return CUSTOMER_GUIDE
  if (metricType === 'offline_order_aov') return ORDER_AOV_GUIDE
  return GMV_GUIDE
}
