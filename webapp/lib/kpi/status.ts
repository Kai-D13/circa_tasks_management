// Shared status labels/colors for KPI campaigns (list + detail).
export const STATUS_META: Record<string, { label: string; cls: string }> = {
  draft:  { label: 'Nháp',      cls: 'bg-gray-100 text-gray-600' },
  active: { label: 'Đang chạy', cls: 'bg-green-100 text-green-700' },
  paused: { label: 'Tạm dừng',  cls: 'bg-amber-100 text-amber-700' },
  ended:  { label: 'Kết thúc',  cls: 'bg-gray-100 text-gray-500' },
}
