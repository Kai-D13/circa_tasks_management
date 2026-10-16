import { StatusBadge } from '@/components/ds/StatusBadge'
import { performanceStatusTone } from '@/lib/kpi/performance'

// UI v2 Phase 2 (canvas K0): badge Nhịp độ (Performance) — tone theo ĐÚNG ngưỡng performanceTone
// (≥100 success · ≥80 warning · còn lại danger). null (chưa đồng bộ / chưa bắt đầu / không target) ⇒ '—'
// trung tính, không tô màu.
export function PaceBadge({ pct, children, size }: {
  pct: number | null
  /** Chữ đã format của caller (vd "86,4%"); bỏ qua khi pct null. */
  children?: React.ReactNode
  size?: 'sm' | 'md'
}) {
  if (pct === null || !Number.isFinite(pct)) return <StatusBadge tone="neutral" size={size}>—</StatusBadge>
  return <StatusBadge tone={performanceStatusTone(pct)} size={size}>{children}</StatusBadge>
}
