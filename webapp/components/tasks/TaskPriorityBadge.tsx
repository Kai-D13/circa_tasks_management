import { StatusBadge, type StatusTone } from '@/components/ds/StatusBadge'
import { TaskPriority } from '@/types'

// Priority is an attention signal → DS status tones (urgent = warning, same
// amber/orange family as the old pastel; normal = neutral).
const PRIORITY_TONES: Record<TaskPriority, StatusTone> = {
  urgent: 'warning',
  normal: 'neutral',
}

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  urgent: 'Khẩn cấp',
  normal: 'Bình thường',
}

export function TaskPriorityBadge({ priority }: { priority: TaskPriority }) {
  return <StatusBadge tone={PRIORITY_TONES[priority]}>{PRIORITY_LABELS[priority]}</StatusBadge>
}
