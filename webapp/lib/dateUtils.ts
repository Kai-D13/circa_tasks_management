const VN_TZ = 'Asia/Ho_Chi_Minh'

export function formatDistanceToNow(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = date.getTime() - now.getTime()
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays === 0) return 'Hôm nay'
  if (diffDays === 1) return 'Ngày mai'
  if (diffDays === -1) return 'Hôm qua'
  if (diffDays < 0) return `${Math.abs(diffDays)} ngày trước`
  return `Còn ${diffDays} ngày`
}

export function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('vi-VN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: VN_TZ,
  })
}

export function formatDateTime(dateStr: string): string {
  return new Date(dateStr).toLocaleString('vi-VN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: VN_TZ,
  })
}

export function toDatetimeLocal(dateStr: string): string {
  // Shift UTC to VN local (+7h) before formatting for datetime-local input
  const d = new Date(dateStr)
  const vn = new Date(d.getTime() + 7 * 60 * 60 * 1000)
  return vn.toISOString().slice(0, 16)
}

export function getEffectiveStatus(deadline: string | null, status: string): string {
  if (status === 'done' || status === 'overdue') return status
  if (deadline && new Date(deadline) < new Date()) return 'overdue'
  return status
}
