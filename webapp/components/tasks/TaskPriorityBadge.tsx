import { Badge } from '@/components/ui/badge'
import { TaskPriority } from '@/types'
import { cn } from '@/lib/utils'

const PRIORITY_STYLES: Record<TaskPriority, string> = {
  urgent: 'bg-orange-100 text-orange-700',
  normal: 'bg-gray-100 text-gray-600',
}

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  urgent: 'Khẩn cấp',
  normal: 'Bình thường',
}

export function TaskPriorityBadge({ priority }: { priority: TaskPriority }) {
  return (
    <Badge className={cn(PRIORITY_STYLES[priority])}>
      {PRIORITY_LABELS[priority]}
    </Badge>
  )
}
