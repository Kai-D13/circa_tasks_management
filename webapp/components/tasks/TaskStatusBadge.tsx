import { StatusBadge, type StatusTone } from '@/components/ds/StatusBadge'
import { TaskStatus } from '@/types'

// Status colors come from the DS status tokens (single source — circa-ui rule
// 2). Same hue families as the old hand-rolled pastels, now dark-mode-safe.
const STATUS_TONES: Record<TaskStatus, StatusTone> = {
  todo:        'neutral',
  in_progress: 'info',
  done:        'success',
  overdue:     'danger',
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo:        'Chờ thực hiện',
  in_progress: 'Đang thực hiện',
  done:        'Hoàn thành',
  overdue:     'Quá hạn',
}

// `late` marks a task that was completed after its deadline (status 'done' with
// tasks.overdue_at set). It surfaces an amber "Hoàn thành trễ" badge instead of
// the green "Hoàn thành" so the lateness stays visible after submission.
export function TaskStatusBadge({ status, late }: { status: TaskStatus; late?: boolean }) {
  if (status === 'done' && late) {
    return <StatusBadge tone="warning">Hoàn thành trễ</StatusBadge>
  }
  return <StatusBadge tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</StatusBadge>
}
