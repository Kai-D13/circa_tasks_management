// P3-D — Campaign metric contract + activation gate (THUẦN, audit 23/07).
// Server action là NGƯỜI GÁC CUỐI: flag tắt thì metric_affiliate=true bị từ
// chối ở đây bất kể UI (không chỉ ẩn checkbox). Mọi quyết định có test riêng.

import type { AffiliateSyncHealth } from '@/lib/affiliate/health'

export interface MetricInput { metric_offline?: boolean; metric_affiliate?: boolean }
export interface MetricFlags { metric_offline: boolean; metric_affiliate: boolean }

export type MetricResolution =
  | ({ ok: true } & MetricFlags)
  | { ok: false; error: string }

// create: current = undefined → default Offline-only (campaign cũ giữ nguyên
// hành vi). update: truyền current để field không gửi giữ giá trị cũ.
export function resolveMetricInput(
  affiliateFlagEnabled: boolean,
  input: MetricInput,
  current?: MetricFlags,
): MetricResolution {
  const metricOffline = input.metric_offline ?? current?.metric_offline ?? true
  const metricAffiliate = input.metric_affiliate ?? current?.metric_affiliate ?? false
  if (metricAffiliate && !affiliateFlagEnabled) {
    // Audit P3-D: server LUÔN từ chối khi flag tắt — kể cả client cố gửi.
    return { ok: false, error: 'Chỉ số GMV Affiliate chưa được bật trên hệ thống (KPI_AFFILIATE_ENABLED)' }
  }
  if (!metricOffline && !metricAffiliate) {
    return { ok: false, error: 'Chiến dịch phải bật ít nhất một chỉ số doanh số' }
  }
  return { ok: true, metric_offline: metricOffline, metric_affiliate: metricAffiliate }
}

// Lý do CHẶN activation (null = được kích hoạt). Offline-only KHÔNG phụ thuộc
// health/store-type (health truyền null). Affiliate campaign: mọi target phải
// là OS store active + nguồn affiliate READY — lý do cụ thể trả về UI.
export function activationBlockReason(p: {
  metricAffiliate: boolean
  targetCount: number
  invalidStores: string[]              // label target không phải OS-active (chỉ xét khi affiliate)
  health: AffiliateSyncHealth | null   // null khi không fetch (offline-only)
}): string | null {
  if (p.targetCount === 0) return 'Chưa import target cho chiến dịch này'
  if (!p.metricAffiliate) return null
  if (p.invalidStores.length > 0) {
    return `Không thể kích hoạt: target không phải OS store active — ${p.invalidStores.slice(0, 5).join(', ')}`
  }
  if (!p.health) return 'Không thể kích hoạt: chưa kiểm tra được nguồn affiliate'
  if (!p.health.ready) return `Không thể kích hoạt: nguồn affiliate chưa sẵn sàng — ${p.health.reason}`
  return null
}
