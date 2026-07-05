// Derived chronic-care display state. care_status only stores stable states
// ('none'/'done'/'ignored'); "Sắp đến kỳ" vs "Cần chăm sóc" is a pure function
// of today vs reminder_date — derived at read time so it can never go stale
// (no daily status-flip cron). Shared by the list chips + detail card.

export interface CareStateInput {
  is_chronic:        boolean
  order_sync_status: string
  care_status:       string
  reminder_date:     string | null
}

export interface CareState {
  key:   'waiting' | 'error' | 'upcoming' | 'due' | 'done' | 'ignored'
  label: string
  cls:   string // badge classes (module pastel idiom)
}

export function deriveCareState(s: CareStateInput, todayISO: string): CareState | null {
  if (!s.is_chronic) return null
  if (s.care_status === 'done')
    return { key: 'done', label: 'Đã chăm sóc', cls: 'bg-green-100 text-green-700' }
  if (s.care_status === 'ignored')
    return { key: 'ignored', label: 'Bỏ qua', cls: 'bg-muted text-muted-foreground' }
  if (s.order_sync_status === 'error')
    return { key: 'error', label: 'Lỗi DHC', cls: 'bg-red-100 text-red-700' }
  if (s.order_sync_status !== 'synced' || !s.reminder_date)
    return { key: 'waiting', label: 'Chờ dữ liệu đơn', cls: 'bg-amber-100 text-amber-700' }
  if (todayISO < s.reminder_date)
    return { key: 'upcoming', label: 'Sắp đến kỳ', cls: 'bg-sky-100 text-sky-700' }
  return { key: 'due', label: 'Cần chăm sóc', cls: 'bg-primary/10 text-primary' }
}
