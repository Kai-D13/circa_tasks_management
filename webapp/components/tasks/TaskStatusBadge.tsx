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

// `late` marks a task that was completed after its deadline (status 'done' with
// tasks.overdue_at set). It surfaces an amber "Hoàn thành trễ" badge instead of
// the green "Hoàn thành" so the lateness stays visible after submission.
export function TaskStatusBadge({ status, late }: { status: TaskStatus; late?: boolean }) {
  if (status === 'done' && late) {
    return <Badge className="bg-amber-100 text-amber-700">Hoàn thành trễ</Badge>
  }
  return (
    <Badge className={cn(STATUS_STYLES[status])}>
      {STATUS_LABELS[status]}
    </Badge>
  )
}
