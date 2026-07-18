'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { pauseSchedule, resumeSchedule, deleteSchedule } from '@/app/actions/tasks'
import { Pause, Play, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Props {
  scheduleId: string
  isActive: boolean
  // Owner/super-admin only — delete is hidden otherwise so a collaborator never
  // sees a button RLS would silently reject.
  canDelete?: boolean
}

// [44px] PIXEL touch target on mobile (root 15px → rem lies), compact on md+.
const ACTION_BTN = 'flex items-center justify-center gap-1.5 text-xs px-3 min-h-[44px] md:min-h-0 md:px-2.5 md:py-1.5 rounded border transition-colors'

export function ScheduleActions({ scheduleId, isActive, canDelete = false }: Props) {
  const [pending, startTransition] = useTransition()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const router = useRouter()

  useEffect(() => () => { if (confirmTimer.current) clearTimeout(confirmTimer.current) }, [])

  function handleToggle() {
    startTransition(async () => {
      const result = isActive
        ? await pauseSchedule(scheduleId)
        : await resumeSchedule(scheduleId)
      if (result?.error) toast.error(result.error)
      else toast.success(isActive ? 'Đã tạm dừng lịch' : 'Đã kích hoạt lại lịch')
    })
  }

  function handleDelete() {
    if (!confirmDelete) {
      // First click arms the button; it disarms itself after 4s.
      setConfirmDelete(true)
      confirmTimer.current = setTimeout(() => setConfirmDelete(false), 4000)
      return
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    setConfirmDelete(false)
    startTransition(async () => {
      const result = await deleteSchedule(scheduleId)
      if (result?.error) { toast.error(result.error); return }
      toast.success('Đã xóa lịch định kỳ (task đã tạo được giữ lại)')
      router.push('/tasks/schedules')
      router.refresh()
    })
  }

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        disabled={pending}
        onClick={handleToggle}
        className={cn(
          ACTION_BTN,
          isActive
            ? 'border-border text-muted-foreground hover:border-status-warning hover:text-status-warning hover:bg-status-warning-bg'
            : 'border-border text-muted-foreground hover:border-status-success hover:text-status-success hover:bg-status-success-bg',
          pending && 'opacity-50 pointer-events-none',
        )}
      >
        {isActive
          ? <><Pause className="h-3.5 w-3.5" /> Tạm dừng</>
          : <><Play  className="h-3.5 w-3.5" /> Kích hoạt</>
        }
      </button>

      {canDelete && (
        <button
          type="button"
          disabled={pending}
          onClick={handleDelete}
          className={cn(
            ACTION_BTN,
            confirmDelete
              ? 'border-status-danger bg-status-danger-bg text-status-danger font-medium'
              : 'border-border text-muted-foreground hover:border-status-danger hover:text-status-danger hover:bg-status-danger-bg',
            pending && 'opacity-50 pointer-events-none',
          )}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {confirmDelete ? 'Bấm lần nữa để xóa' : 'Xóa lịch'}
        </button>
      )}
    </div>
  )
}
