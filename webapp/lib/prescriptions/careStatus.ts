// Two SEPARATE axes on a prescription (kept apart after the Sheet rebuild):
//
// 1. ORDER sync — the primary status of every prescription now. The old
//    product-sync (paste-JSON → prescription_submission_products, column
//    `status`) is deprecated; order/customer/product data comes from the
//    Google Sheet via the cron and lives in order_sync_status.
//      pending → "Chờ đồng bộ" · synced → "Đã đồng bộ" · error → "Lỗi đơn hàng"
//
// 2. CARE — the chronic-care workflow, shown IN ADDITION only once the order is
//    synced (so it never overlaps the order badge). Derived from reminder_date
//    vs today at read time (never stale, no status-flip cron).

export interface CareStateInput {
  is_chronic:        boolean
  order_sync_status: string
  care_status:       string
  reminder_date:     string | null
}

export interface Badge { key: string; label: string; cls: string }

// Primary order-sync badge (all prescriptions).
export function deriveOrderStatus(orderSyncStatus: string): Badge {
  switch (orderSyncStatus) {
    case 'synced': return { key: 'synced',  label: 'Đã đồng bộ',   cls: 'bg-green-100 text-green-700' }
    case 'error':  return { key: 'error',   label: 'Lỗi đơn hàng', cls: 'bg-red-100 text-red-700' }
    default:       return { key: 'pending', label: 'Chờ đồng bộ',  cls: 'bg-amber-100 text-amber-700' }
  }
}

// Chronic-care chip — ONLY once the order is synced (waiting/error are covered
// by the order badge, so no double badge). Returns null when there's nothing
// care-specific to show yet.
export function deriveCareState(s: CareStateInput, todayISO: string): Badge | null {
  if (!s.is_chronic) return null
  if (s.care_status === 'done')
    return { key: 'done', label: 'Đã chăm sóc', cls: 'bg-green-100 text-green-700' }
  if (s.care_status === 'ignored') return null
  if (s.order_sync_status !== 'synced' || !s.reminder_date) return null
  if (todayISO < s.reminder_date)
    return { key: 'upcoming', label: 'Sắp đến kỳ', cls: 'bg-sky-100 text-sky-700' }
  return { key: 'due', label: 'Cần chăm sóc', cls: 'bg-primary/10 text-primary' }
}
