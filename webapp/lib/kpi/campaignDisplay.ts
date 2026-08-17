// P3-E/F r1 — Contract HIỂN THỊ campaign (THUẦN, audit P2#3): mọi quyết định
// render breakdown / footnote / trạng thái metric-editor nằm ở đây để test
// khóa contract — component chỉ tiêu thụ.
// r2 (audit P3): structural type CỤC BỘ — tầng lib không import type từ
// component UI (tránh đảo chiều phụ thuộc); CampaignView khớp structurally.

import {
  ORDER_AOV_VERDICT, aovFromSnapshot, formatCompletionPct, formatRemainingPct,
  orderAovDualView, qualityKpiPass,
} from '@/lib/kpi/orderAov'

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
// 17/08: chú thích nguồn phải nói RÕ Offline là Net Revenue. Đây là chú thích
// DUY NHẤT — không tách thành helper riêng rồi quên gọi ở component.
export function campaignFootnote(v: { metric_offline: boolean; metric_affiliate: boolean; metric_type?: string }): string {
  if (v.metric_type === 'affiliate_customer_count') {
    return 'Nguồn: Circa Online · đếm khách có đơn giao thành công (DELIVERED) — mỗi khách tính 1 lần trong chiến dịch'
  }
  // Chất lượng bán hàng: cùng nguồn BI nhưng luật đạt KHÁC hẳn ⇒ chú thích riêng.
  if (v.metric_type === 'offline_order_aov') {
    return 'Nguồn: báo cáo BI · Doanh thu thuần tại cửa hàng (Net Revenue) · Đạt KPI khi CẢ số đơn và AOV cùng chạm mục tiêu'
  }
  if (!v.metric_affiliate) {
    return 'Nguồn: báo cáo BI · Doanh thu thuần tại cửa hàng (Net Revenue) — không bao gồm đơn online'
  }
  if (v.metric_offline) {
    return 'Nguồn: báo cáo BI + Circa Online · Tổng gồm Doanh thu thuần tại cửa hàng (Net Revenue) và Doanh thu Affiliate (đơn giao thành công)'
  }
  return 'Nguồn: Circa Online · Doanh thu Affiliate, chỉ tính đơn giao thành công (DELIVERED)'
}

// ── Mig 103: PRESENTATION tập trung theo metric_type ────────────────────────
// Một nguồn duy nhất cho label/đơn vị/format của campaign — thay 6 bản vnd()
// lặp ở component (KpiView/ResultSummary/ResultDashboard/DailyChart/[id]/list).
// gmv: format BYTE-EQUAL formatter cũ (Intl vi-VN + '₫', null → '—'; compact
// tỷ/tr/k như CampaignDailyChart) — test khóa; customer: 'N khách'.
export type CampaignMetricType = 'gmv' | 'affiliate_customer_count' | 'offline_order_aov'

// ── 17/08: THUẬT NGỮ "DOANH THU", không còn "GMV" trên UI ───────────────────
// "GMV" là từ nội bộ của BI; dược sĩ và quản lý cửa hàng không đọc ra nó. Toàn
// bộ nhãn hiển thị chuyển sang "Doanh thu".
// ⚠ CHỈ đổi NHÃN. Tên nội bộ `metric_type='gmv'`, cột `gmv`/`actual_gmv`/
// `actual_value` và TÊN CỘT EXCEL giữ nguyên từng byte — đó là contract DB/API
// và Power Query của Finance đang bám vào (exportRows dùng literal, không đi
// qua chỗ này, nên đổi ở đây không chạm export).
export const REVENUE_LABELS = {
  // Nói rõ "thuần tại cửa hàng": số này là Net Revenue từ BI, đã trừ trả hàng.
  // 17/08 (audit P2): KHÔNG có biến thể ngắn bỏ chữ "thuần". Bản trước tách
  // `offlineShort` = 'Doanh thu tại cửa hàng' cho bảng/card, hoá ra đúng ba màn
  // hay được đọc nhất lại mất mất chữ quan trọng nhất. Nhãn dài hơn thì để nó
  // xuống dòng, đừng đánh đổi bằng nghĩa.
  offline: 'Doanh thu thuần tại cửa hàng',
  // KHÔNG gọi là "thuần" — nguồn Circa Online không qua cùng phép trừ đó.
  affiliate: 'Doanh thu Affiliate',
  total: 'Tổng doanh thu thực tế',
} as const

export interface MetricPresentation {
  kind: CampaignMetricType
  targetLabel: string            // 'Mục tiêu doanh thu' | 'Mục tiêu số khách'
  actualHeroLabel: string        // hero "Đã đạt" giữ chung
  todayLabel: string             // 'Doanh thu hôm nay' | 'Khách hôm nay'
  perDayLabel: string            // 'Trung bình/ngày cần đạt' (chung)
  actualColumnLabel: string      // cột bảng: 'Doanh thu thực tế' | 'Số khách'
  chartAriaLabel: string
  value(n: number | null | undefined): string
  compact(n: number): string
  zero: string                   // '0₫' | '0 khách'
}

const nfVi = new Intl.NumberFormat('vi-VN')
const GMV_PRESENTATION: MetricPresentation = {
  kind: 'gmv',
  targetLabel: 'Mục tiêu doanh thu',
  actualHeroLabel: 'Đã đạt',
  todayLabel: 'Doanh thu hôm nay',
  perDayLabel: 'Trung bình/ngày cần đạt',
  // ⚠ Đây là nhãn CỘT BẢNG, không phải key export. Cột Excel 'Actual GMV' là
  // literal trong exportRows.ts và PHẢI giữ nguyên (Power Query của Finance).
  actualColumnLabel: 'Doanh thu thực tế',
  chartAriaLabel: 'Biểu đồ doanh thu theo ngày',
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

// Mig 106 — Chất lượng bán hàng: đơn vị hiển thị là ĐIỂM %, KHÔNG phải tiền.
// ⚠ Nếu quên nhánh này, metricPresentation default 'gmv' sẽ render 116,1975
// thành "116₫" — sai im lặng trên màn tiền (hero Staff đọc thẳng run_rate).
const ORDER_AOV_PRESENTATION: MetricPresentation = {
  kind: 'offline_order_aov',
  targetLabel: 'Mục tiêu chất lượng',
  actualHeroLabel: 'Điểm hoàn thành',
  todayLabel: 'Số đơn hôm nay',
  perDayLabel: 'Trung bình/ngày cần đạt',
  actualColumnLabel: 'Hoàn thành',
  chartAriaLabel: 'Biểu đồ số đơn theo ngày',
  // 1 chữ số thập phân, NHƯNG chưa đạt thì không bao giờ ra '100%'
  // (formatCompletionPct — dùng chung mọi surface).
  value: (n) => formatCompletionPct(n),
  compact: (n) => nfVi.format(Math.round(n)),
  zero: '0%',
}

// Default 'gmv' cho MỌI giá trị lạ/thiếu (caller cũ chưa truyền metric_type
// giữ nguyên hiển thị tiền — an toàn hiển thị; số liệu đã bị DB/engine chặn).
export function metricPresentation(metricType?: string | null): MetricPresentation {
  if (metricType === 'affiliate_customer_count') return CUSTOMER_PRESENTATION
  if (metricType === 'offline_order_aov') return ORDER_AOV_PRESENTATION
  return GMV_PRESENTATION
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

// ── 106 r1.1 (audit P2#5): nhãn "đã đồng bộ" theo LOẠI chiến dịch ───────────
// Toast/cảnh báo trước đây hard-code "GMV đã đồng bộ" ⇒ campaign Số khách hiện
// nhãn sai. Default vẫn là doanh số (caller cũ / giá trị lạ).
export function syncedSubjectLabel(metricType?: string | null): string {
  if (metricType === 'affiliate_customer_count') return 'Số khách đã đồng bộ'
  if (metricType === 'offline_order_aov') return 'Chất lượng bán hàng đã đồng bộ'
  return 'Doanh số đã đồng bộ'
}

// ── r1.2.1 (audit P1): 3 QUYẾT ĐỊNH HIỂN THỊ tách thuần để test khóa ───────

// Hero "Còn thiếu" — BA trạng thái tách bạch. Trước đây null actual vẫn ra
// "Còn thiếu 100%" (mâu thuẫn với "Chưa đồng bộ" ngay bên trên), và ca
// completion 99,9999% ra "0%" (mâu thuẫn với badge "Chưa đạt").
export function heroRemainingText(p: {
  actualValue: number | null | undefined
  achieved: boolean
  remaining: number
  metricType?: string | null
}): string {
  if (p.actualValue === null || p.actualValue === undefined) return '—'
  const pres = metricPresentation(p.metricType)
  if (pres.kind === 'offline_order_aov') return formatRemainingPct(p.achieved ? 0 : p.remaining)
  return p.achieved ? pres.zero : pres.value(p.remaining)
}

// Card campaign ở màn danh sách Staff/QLCH: chưa đồng bộ KHÔNG được vẽ tiến độ
// 0% (đọc như đã có kết quả); actual = 0 THẬT thì vẫn hiện 0%.
export function campaignCardProgress(c: {
  kpi_target: number | null
  actual_value: number | null | undefined
  metric_type?: string
}): { synced: boolean; pct: number; text: string } {
  const synced = c.actual_value !== null && c.actual_value !== undefined
  const target = Number(c.kpi_target) || 0
  const actual = Number(c.actual_value) || 0
  const isOrderAov = c.metric_type === 'offline_order_aov'
  // order_aov: actual_value CHÍNH LÀ điểm hoàn thành (kpi_target chuẩn hóa 100).
  const rawPct = isOrderAov ? actual : (target > 0 ? (actual / target) * 100 : 0)
  if (!synced) return { synced, pct: 0, text: 'Chưa đồng bộ' }
  return {
    synced,
    pct: Math.round(rawPct),
    text: isOrderAov ? formatCompletionPct(rawPct) : `${Math.round(rawPct)}%`,
  }
}

// ── r2.3 (audit P1#1 + P1#2): GIÁ TRỊ HIỂN THỊ campaign trên màn TỔNG HỢP ───
// Màn danh sách của SM (và mọi màn "nhiều cửa hàng × nhiều campaign") trước đây
// tự gọi vnd() nên campaign Số khách ra "Mục tiêu 450đ · Đã đạt 3đ". Quyết định
// hiển thị theo metric_type nằm Ở ĐÂY (thuần, test khóa) — component chỉ tiêu
// thụ, KHÔNG được tự format lại.
//
// Quy ước cặp số "thực tế / mục tiêu":
//   · tiền  → ₫ dính vào TỪNG số (giữ nguyên chuẩn màn tiền đang chạy)
//     '600.235.456₫ / 1.454.000.000₫'
//   · đếm   → đơn vị đứng MỘT lần ở cuối: '3 / 450 khách'
//
// Chất lượng bán hàng (offline_order_aov): ở mức TỔNG VÙNG không tồn tại "mục
// tiêu" cộng dồn được (kpi_target là ĐIỂM 100 chuẩn hóa; aov_target là bình
// quân — cộng lại vô nghĩa, và model tổng hợp không mang order_target/aov_target
// dạng tổng) ⇒ dùng ĐÚNG chỉ số của màn danh sách super: số cửa hàng ĐẠT KPI /
// tổng, kèm dòng THỰC TẾ số đơn · AOV khi đủ dữ liệu (offlineOrderLine).
export interface CampaignOverviewInput {
  metricType?: string | null
  synced: boolean                     // đã có ít nhất 1 snapshot (lastSyncedAt)
  storeCount: number
  totalTarget: number
  totalActual: number
  // Chỉ dùng cho offline_order_aov:
  qualityPassCount?: number
  totalOffline?: number
  totalOfflineOrders?: number | null  // null = có store thiếu số đơn → KHÔNG hiện dòng thực tế
}

export interface CampaignOverviewLine {
  label: string
  value: string
  // Commit 5: mỗi dòng có thể mang % RIÊNG (Chất lượng bán hàng: Số đơn và AOV
  // là hai chỉ số độc lập). null ⇒ dòng không có %, component không vẽ thanh.
  pct?: number | null            // KHÔNG cap 100 (thanh tự clamp khi vẽ)
  pctText?: string
  pass?: boolean
}

export interface CampaignOverviewValue {
  kind: CampaignMetricType
  synced: boolean
  lines: CampaignOverviewLine[]
  pct: number                         // 0 khi chưa đồng bộ → KHÔNG vẽ thanh tiến độ
  pctText: string                     // '—' khi chưa đồng bộ (không có "0%" giả)
}

export function campaignOverviewValue(v: CampaignOverviewInput): CampaignOverviewValue {
  const pres = metricPresentation(v.metricType)
  const synced = v.synced

  if (pres.kind === 'offline_order_aov') {
    const stores = Number(v.storeCount) || 0
    const pass = Number(v.qualityPassCount) || 0
    const pct = stores > 0 ? (pass / stores) * 100 : 0
    const lines: CampaignOverviewLine[] = [
      { label: 'Đạt KPI', value: synced ? `${pass}/${stores} cửa hàng` : '—' },
    ]
    // Thực tế toàn vùng (không có mục tiêu tổng): "1.046 đơn · AOV 194.046₫".
    // Thiếu số đơn ở BẤT KỲ store nào ⇒ offlineOrderLine không được gọi (tổng
    // sai có hệ thống) — caller truyền null, dòng này biến mất.
    const actualLine = synced ? offlineOrderLine(v.totalOffline ?? 0, v.totalOfflineOrders ?? null) : null
    if (actualLine) lines.push({ label: 'Thực tế', value: actualLine })
    return { kind: pres.kind, synced, lines, pct: synced ? pct : 0, pctText: synced ? `${Math.round(pct)}%` : '—' }
  }

  // gmv / affiliate_customer_count — % và luật "chưa đồng bộ" dùng chung
  // campaignCardProgress (một luật làm tròn duy nhất với card Staff/QLCH).
  const prog = campaignCardProgress({
    kpi_target: v.totalTarget,
    actual_value: synced ? v.totalActual : null,
    metric_type: pres.kind,
  })
  const actual = !synced ? '—'
    : pres.kind === 'gmv' ? pres.value(v.totalActual) : nfVi.format(Math.round(v.totalActual))
  return {
    kind: pres.kind,
    synced,
    lines: [{ label: 'Đã đạt / Mục tiêu', value: `${actual} / ${pres.value(v.totalTarget)}` }],
    pct: prog.pct,
    pctText: synced ? prog.text : '—',
  }
}

// ── Batch /targets mobile: GIÁ TRỊ HIỂN THỊ trên card MỘT CỬA HÀNG ──────────
// Card ở màn danh sách của Staff/QLCH trước đây chỉ hiện phần trăm. Stakeholder
// muốn thấy cả cặp "thực tế / mục tiêu" đúng đơn vị từng loại chiến dịch.
//
// ⚠ KHÔNG dùng lại `campaignOverviewValue` cho việc này: hàm đó là khung TỔNG
// HỢP NHIỀU CỬA HÀNG — với offline_order_aov nó trả "Đạt KPI 3/8 cửa hàng",
// vô nghĩa trên card của một dược sĩ đang xem chính cửa hàng mình.
//
// Quy ước đơn vị GIỮ NGUYÊN như màn tổng hợp (một luật cho cả hệ):
//   · tiền → ₫ dính vào TỪNG số      '600.235.456₫ / 1.454.000.000₫'
//   · đếm  → đơn vị đứng MỘT lần cuối '3 / 450 khách'
//   · chất lượng bán hàng → HAI dòng (Số đơn, AOV) vì đây là 2 chỉ số độc lập,
//     và hero % là chỉ số YẾU HƠN trong hai cái — gộp một dòng sẽ giấu mất
//     chỉ số đang kéo điểm xuống.
export interface CampaignCardInput {
  metricType?: string | null
  kpiTarget: number | null
  actualValue: number | null | undefined
  // chỉ offline_order_aov:
  actualOffline?: number | null
  offlineOrderCount?: number | null
  orderTarget?: number | null
  aovTarget?: number | null
}

export interface CampaignCardValue {
  kind: CampaignMetricType
  // Nhãn NGẮN của loại chiến dịch cho chip trên card. Khác `targetLabel`
  // ('Mục tiêu GMV') vì ở đây đang gọi tên LOẠI, không phải gọi tên con số.
  typeLabel: string
  synced: boolean
  lines: CampaignOverviewLine[]
  // Commit 5: false ⇒ KHÔNG có % tổng cho loại này (Chất lượng bán hàng bỏ
  // điểm gộp khỏi UI) — component vẽ thanh THEO TỪNG DÒNG và dùng `pctText`
  // như nhãn TRẠNG THÁI ('Đạt KPI'/'Chưa đạt'), không phải một con số.
  showAggregate: boolean
  pct: number                    // 0 khi chưa đồng bộ ⇒ KHÔNG vẽ thanh tiến độ
  pctText: string                // 'Chưa đồng bộ' khi chưa có snapshot
  // Tông trạng thái cho chip/thanh — component KHÔNG tự suy ra từ pct, vì
  // chất lượng bán hàng "đạt" KHÔNG phải pct >= 100 làm tròn mà là
  // qualityKpiPass (99,9999% vẫn là chưa đạt, chưa có commission).
  tone: 'success' | 'warning' | 'neutral'
}

const CARD_TYPE_LABEL: Record<CampaignMetricType, string> = {
  gmv: 'Doanh số',
  affiliate_customer_count: 'Số khách',
  offline_order_aov: 'Chất lượng bán hàng',
}

export function campaignCardValue(v: CampaignCardInput): CampaignCardValue {
  const pres = metricPresentation(v.metricType)
  const typeLabel = CARD_TYPE_LABEL[pres.kind]
  const prog = campaignCardProgress({
    kpi_target: v.kpiTarget,
    actual_value: v.actualValue,
    metric_type: pres.kind,
  })
  const synced = prog.synced

  if (pres.kind === 'offline_order_aov') {
    // Trạng thái "đã đồng bộ" lấy DUY NHẤT từ actual_value (điểm hoàn thành do
    // RPC ghi). Snapshot partial/stale có thể còn offline_order_count và
    // actual_offline cũ trong khi actual_value đã null — nếu format thẳng, card
    // hiện "Chưa đồng bộ" ngay cạnh "1.046 / 900 đơn" của kỳ trước.
    // Ép null theo `synced`: MỤC TIÊU vẫn hiện (nó là cấu hình, không phải kết
    // quả), phần thực tế thành '—'.
    const dual = orderAovDualView({
      actualOrder: v.offlineOrderCount,
      actualNet: v.actualOffline,
      orderTarget: v.orderTarget,
      aovTarget: v.aovTarget,
      synced,
    })
    // dual === null ⇒ campaign chưa cấu hình đủ 2 mục tiêu: không bịa dòng nào.
    const lines: CampaignOverviewLine[] = dual ? [
      { label: 'Số đơn', value: dual.order.valueText, pct: dual.order.pctRaw, pctText: dual.order.pctText, pass: dual.order.pass },
      { label: 'AOV', value: dual.aov.valueText, pct: dual.aov.pctRaw, pctText: dual.aov.pctText, pass: dual.aov.pass },
    ] : []
    // ĐẠT = cả hai chỉ số đạt VÀ điểm gộp (số quyết định commission) cũng đạt.
    // Với snapshot nhất quán, hai vế LUÔN trùng (bất biến có test). Chúng chỉ
    // lệch khi snapshot bị trộn kỳ — lúc đó chọn phía DÈ DẶT: màn lương không
    // được hứa "Đạt KPI" trong khi con số trả thưởng nói chưa.
    const pass = dual
      ? dual.overallPass && qualityKpiPass(v.actualValue)
      : qualityKpiPass(v.actualValue)
    return {
      kind: pres.kind, typeLabel, synced, lines,
      // KHÔNG có % tổng: chỗ đó giờ là VERDICT.
      showAggregate: false,
      pct: 0,
      pctText: !synced ? ORDER_AOV_VERDICT.unsynced : pass ? ORDER_AOV_VERDICT.pass : ORDER_AOV_VERDICT.fail,
      tone: !synced ? 'neutral' : pass ? 'success' : 'warning',
    }
  }

  // gmv / affiliate_customer_count — một dòng "thực tế / mục tiêu".
  const target = Number(v.kpiTarget) || 0
  const actual = Number(v.actualValue) || 0
  const value = !synced
    ? '—'
    : pres.kind === 'gmv'
      ? `${pres.value(actual)} / ${pres.value(target)}`
      : `${nfVi.format(Math.round(actual))} / ${pres.value(target)}`
  return {
    kind: pres.kind,
    typeLabel,
    synced,
    lines: [{ label: 'Đã đạt / Mục tiêu', value }],
    showAggregate: true,
    pct: prog.pct,
    pctText: prog.text,
    tone: !synced ? 'neutral' : target > 0 && actual >= target ? 'success' : 'warning',
  }
}

// Ô "Trung bình/ngày cần đạt" — Chất lượng bán hàng KHÔNG có ô này.
// `requiredPerDay` chia phần còn thiếu cho số ngày còn lại; với gmv/khách thì
// ra "tiền/ngày" và "khách/ngày" đều có nghĩa. Với offline_order_aov, phần còn
// thiếu là ĐIỂM hoàn thành ⇒ ra "điểm %/ngày", không tương đương số đơn/ngày
// hay AOV/ngày và rất dễ bị đọc thành mục tiêu vận hành.
//
// Quyết định này vốn nằm inline trong CampaignKpiView (`!isOrderAovCampaign`);
// đưa ra đây để rebuild mobile không vô tình làm mất nó — component chỉ tiêu thụ.
export function perDayVisible(metricType?: string | null): boolean {
  return metricPresentation(metricType).kind !== 'offline_order_aov'
}

// Lưới trục cho chuỗi SỐ ĐƠN: giá trị nguyên + khử trùng (max=5 ⇒ [3,5], không
// phải [2.5,5] rồi nhãn làm tròn thành '3' đặt sai chỗ).
export function orderAxisTicks(max: number): number[] {
  const top = Math.max(1, Math.ceil(max))
  return [...new Set([Math.ceil(top / 2), top])]
}
