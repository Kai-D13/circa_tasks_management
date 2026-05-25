'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { updateTaskStatus } from '@/app/actions/tasks'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { TaskStatus, UserRole } from '@/types'

interface Props {
  taskId: string
  currentStatus: TaskStatus
  userRole: UserRole
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo:        'Chờ thực hiện',
  in_progress: 'Đang thực hiện',
  done:        'Hoàn thành',
  overdue:     'Quá hạn',
}

export function TaskStatusSelector({ taskId, currentStatus, userRole }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [pendingStatus, setPendingStatus] = useState<TaskStatus | null>(null)
  const [note, setNote] = useState('')
  // Optimistic local state — updates immediately on success, syncs via router.refresh()
  const [displayStatus, setDisplayStatus] = useState<TaskStatus>(currentStatus)

  const allStatuses: TaskStatus[] = ['todo', 'in_progress', 'done', 'overdue']
  const visibleStatuses = userRole === 'admin'
    ? allStatuses
    : userRole === 'staff'
      ? ['todo', 'in_progress'] as TaskStatus[]
      : allStatuses.filter((s) => s !== 'overdue') // store_manager

  function handleChange(status: string | null) {
    if (!status) return
    const s = status as TaskStatus
    // Staff changing to in_progress → show note prompt
    if (userRole === 'staff' && s === 'in_progress') {
      setPendingStatus(s)
      setNote('')
      return
    }
    applyChange(s)
  }

  function applyChange(status: TaskStatus, noteText?: string) {
    startTransition(async () => {
      const result = await updateTaskStatus(taskId, status, noteText)
      if (result?.error) {
        toast.error(result.error)
      } else {
        setDisplayStatus(status)   // optimistic: show new status immediately
        toast.success('Đã cập nhật trạng thái')
        router.refresh()           // sync server component with DB
      }
      setPendingStatus(null)
      setNote('')
    })
  }

  return (
    <div className="space-y-2">
      <Select value={displayStatus} onValueChange={handleChange} disabled={pending}>
        <SelectTrigger className="h-7 w-40 text-xs">
          <SelectValue>{STATUS_LABEL[displayStatus]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {visibleStatuses.map((s) => (
            <SelectItem key={s} value={s}>{STATUS_LABEL[s]}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {pendingStatus && (
        <div className="rounded-md border bg-muted/40 p-3 space-y-2 text-sm">
          <p className="text-xs text-muted-foreground">
            Ghi chú tiến độ{userRole === 'staff' ? ' (bắt buộc)' : ' (không bắt buộc)'}
          </p>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Mô tả bạn đang làm gì..."
            rows={2}
            className="text-xs"
          />
          <div className="flex gap-2">
            <Button
              size="sm" className="text-xs h-7"
              disabled={pending || (userRole === 'staff' && !note.trim())}
              onClick={() => applyChange(pendingStatus, note || undefined)}
            >
              Xác nhận
            </Button>
            <Button size="sm" variant="outline" className="text-xs h-7"
              onClick={() => { setPendingStatus(null); setNote('') }}>
              Huỷ
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
