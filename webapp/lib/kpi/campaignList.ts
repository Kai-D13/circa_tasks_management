import { kpiProgressTone, type KpiProgressTone } from './progressTone'
import { metricPresentation } from './campaignDisplay'

// UI v2 Phase 2 · K-1 — luật THUẦN của màn danh sách /targets/campaigns. page.tsx (route thật) và fixture
// /ui-catalog/kpi-v2/campaigns dùng chung; e2e/kpi-campaign-list.spec.ts khoá.

type QueryError = { message: string } | null | undefined

// 3 truy vấn của trang: chiến dịch (chính) + target/actual (phụ). Chính lỗi ⇒ chỉ báo lỗi chính (không danh sách
// ⇒ lỗi phụ vô nghĩa). Phụ lỗi ⇒ danh sách còn nhưng KHÔNG được hiện số gộp từ truy vấn hỏng (lỗi ≠ 0).
export function campaignListErrors(
  campaigns: QueryError, targets: QueryError, actuals: QueryError,
): { campaignsError: string | null; sideError: string | null } {
  if (campaigns) return { campaignsError: campaigns.message, sideError: null }
  return { campaignsError: null, sideError: targets?.message ?? actuals?.message ?? null }
}

export interface CampaignListInput {
  metricType?: string | null
  synced: boolean
  storeCount: number
  totalTarget: number
  totalActual: number
  qualityPassCount: number
}

// "Đạt" tính từ số THÔ — KHÔNG từ % đã làm tròn của campaignOverviewValue (99,6% hiện "100%" nhưng chưa đạt).
// Chất lượng bán hàng: đạt khi MỌI cửa hàng có target đều đạt KPI (cùng nghĩa pct = pass/stores ≥ 100 cũ).
export function campaignListReached(v: CampaignListInput): boolean {
  if (!v.synced) return false
  if (metricPresentation(v.metricType ?? undefined).kind === 'offline_order_aov') {
    return v.storeCount > 0 && v.qualityPassCount >= v.storeCount
  }
  return v.totalTarget > 0 && v.totalActual >= v.totalTarget
}

// % hoàn thành của DÒNG danh sách (K-1 r1.1, PM P1) — chữ, thanh và ARIA cùng lấy từ đây:
//   raw  = tỷ lệ THÔ (không làm tròn) cho progressbar/aria-valuenow; null khi chưa đồng bộ hoặc không có mẫu số
//          (mục tiêu 0 / 0 cửa hàng) ⇒ '—', không vẽ thanh (null ≠ 0).
//   text = 1 chữ số thập phân kiểu vi-VN ("99,6%", "112%"); CHƯA đạt mà làm tròn lên 100 ⇒ "<100%" (tiền lệ
//          formatCompletionPct) — không bao giờ ghi "100%" khi chưa đạt.
// Chỉ là định dạng trình bày của K-1: KHÔNG đổi campaignCardProgress/campaignOverviewValue (staff/QLCH/SM),
// điều kiện đạt, tiền thưởng hay export.
export function campaignListPct(v: CampaignListInput): { raw: number | null; text: string } {
  if (!v.synced) return { raw: null, text: '—' }
  const quality = metricPresentation(v.metricType ?? undefined).kind === 'offline_order_aov'
  const raw = quality
    ? (v.storeCount > 0 ? (v.qualityPassCount / v.storeCount) * 100 : null)
    : (v.totalTarget > 0 ? (v.totalActual / v.totalTarget) * 100 : null)
  if (raw === null || !Number.isFinite(raw)) return { raw: null, text: '—' }
  const rounded = Math.round(raw * 10) / 10
  if (!campaignListReached(v) && rounded >= 100) return { raw, text: '<100%' }
  return { raw, text: `${new Intl.NumberFormat('vi-VN').format(rounded)}%` }
}

// Khung chờ theo pathname (K-1/K-2): '/targets/campaigns' ⇒ list; '/targets/campaigns/<uuid>' ⇒ detail; còn lại
// (new, affiliate, đường khác) ⇒ null — caller giữ khung cũ của nó. Thuần để unit test khoá.
const CAMPAIGN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function campaignsLoadingKind(pathname: string | null | undefined): 'list' | 'detail' | null {
  if (!pathname) return null
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  if (p === '/targets/campaigns') return 'list'
  const m = p.match(/^\/targets\/campaigns\/([^/]+)$/)
  return m && CAMPAIGN_ID.test(m[1]) ? 'detail' : null
}

// Tone thanh của dòng danh sách / hero chi tiết: chưa đồng bộ > đạt (xanh, KỂ CẢ đã kết thúc) > đã kết thúc chưa đạt
// (--v2-text-3) > màu chuỗi — CHÍNH luật chung kpiProgressTone (PM K-1 §3, sửa ở K-2), chỉ đổi status → cờ ended.
export function campaignListTone(v: { synced: boolean; reached: boolean; status: string }): KpiProgressTone {
  return kpiProgressTone({ synced: v.synced, ended: v.status === 'ended', reached: v.reached })
}
