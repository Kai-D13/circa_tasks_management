// P3-F r1 — Dựng row export campaign (THUẦN, audit P2#3): contract cột nằm ở
// đây để test khóa. r1 P2#2: GIỮ NGUYÊN tên cột cũ 'Actual GMV' (không đổi
// thành 'GMV Total' — tránh vỡ file mẫu/Power Query/đối soát đang phụ thuộc
// tên cũ; muốn đổi tên phải có xác nhận chính thức của stakeholder); cột mới
// BỔ SUNG sau cột cũ. fmt = formatter ngày giờ (DI — route truyền fmtVN).

import { campaignPerformance } from '@/lib/kpi/performance'

export interface ExportCampaign {
  name: string; start_date: string; end_date: string
  metric_offline: boolean; metric_affiliate: boolean
}
export interface ExportTarget {
  store_id: string; pos_code: string | null; kpi_target: number; store_kpi_group: string | null
  stores: { name: string } | null
}
export interface ExportActual {
  store_id: string; actual_value: number; run_rate: number | null; remaining_target: number | null
  achieved_tier_order: number | null; store_commission_pool: number | null; synced_at: string
  actual_offline: number | null; actual_affiliate: number | null
  offline_synced_at: string | null; affiliate_synced_at: string | null
}

export function affiliateDataStatus(metricAffiliate: boolean, a: ExportActual | undefined): string {
  if (!metricAffiliate) return 'Không áp dụng'
  if (!a || a.affiliate_synced_at === null) return 'Chưa đồng bộ'
  return 'Đã đồng bộ'
}

export function buildCampaignExportRows(
  c: ExportCampaign,
  targets: ExportTarget[],
  actuals: ExportActual[],
  vnTodayISO: string,
  fmt: (iso: string) => string,
): Record<string, string | number>[] {
  const actualByStore = new Map(actuals.map((a) => [a.store_id, a]))
  return targets.map((t) => {
    const a = actualByStore.get(t.store_id)
    const perf = campaignPerformance(t.kpi_target, a?.actual_value ?? null, c.start_date, c.end_date, vnTodayISO)
    return {
      'Chiến dịch':   c.name,
      'Từ ngày':      c.start_date,
      'Đến ngày':     c.end_date,
      'POS':          t.pos_code ?? '',
      'Cửa hàng':     t.stores?.name ?? '',
      'Phân loại':    t.store_kpi_group ?? '',
      'KPI target':   Number(t.kpi_target) || 0,
      // Cột CŨ giữ nguyên tên + ngữ nghĩa (= tổng, actual_value)
      'Actual GMV':   a ? Number(a.actual_value) || 0 : '',
      // Cột MỚI bổ sung (P3-F)
      'GMV Offline':  a?.actual_offline != null ? Number(a.actual_offline) || 0 : '',
      'GMV Affiliate': a?.actual_affiliate != null ? Number(a.actual_affiliate) || 0 : '',
      'Run rate %':   a?.run_rate != null ? Number(a.run_rate.toFixed(1)) : '',
      'Performance %': perf != null ? Number(perf.toFixed(1)) : '',
      'Còn thiếu':    a?.remaining_target != null ? Number(a.remaining_target) || 0 : '',
      'Bậc đạt':      a?.achieved_tier_order ?? '',
      'Commission pool': a?.store_commission_pool != null ? Number(a.store_commission_pool) || 0 : '',
      'Offline Synced At':   a?.offline_synced_at ? fmt(a.offline_synced_at) : '',
      'Affiliate Synced At': a?.affiliate_synced_at ? fmt(a.affiliate_synced_at) : '',
      'Affiliate Data Status': affiliateDataStatus(c.metric_affiliate, a),
      'Đồng bộ lúc':  a ? fmt(a.synced_at) : '',
    }
  })
}
