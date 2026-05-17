import { Badge } from '@/components/ui/badge'
import { TaskStatus } from '@/types'
import { cn } from '@/lib/utils'

const STATUS_STYLES: Record<TaskStatus, string> = {
  todo:        'bg-slate-100 text-slate-700',
  in_progress: 'bg-blue-100 text-blue-700',
  done:        'bg-green-100 text-green-700',
  overdue:     'bg-red-100 text-red-700',
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo:        'Chờ thực hiện',
  in_progress: 'Đang thực hiện',
  done:        'Hoàn thành',
  overdue:     'Quá hạn',
}

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return (
    <Badge className={cn(STATUS_STYLES[status])}>
      {STATUS_LABELS[status]}
    </Badge>
  )
}
