'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { pauseSchedule, resumeSchedule, deleteSchedule } from '@/app/actions/tasks'
import { Pause, Play, Trash2 } from 'lucide-react'

interface Props {
  scheduleId: string
  isActive: boolean
  // Owner/super-admin only — delete is hidden otherwise so a collaborator never
  // sees a button RLS would silently reject.
  canDelete?: boolean
}

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
        className={[
          'flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded border transition-colors',
          isActive
            ? 'border-border text-muted-foreground hover:border-amber-300 hover:text-amber-700 hover:bg-amber-50'
            : 'border-border text-muted-foreground hover:border-green-300 hover:text-green-700 hover:bg-green-50',
          pending ? 'opacity-50 pointer-events-none' : '',
        ].join(' ')}
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
          className={[
            'flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded border transition-colors',
            confirmDelete
              ? 'border-red-300 bg-red-50 text-red-700 font-medium'
              : 'border-border text-muted-foreground hover:border-red-300 hover:text-red-700 hover:bg-red-50',
            pending ? 'opacity-50 pointer-events-none' : '',
          ].join(' ')}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {confirmDelete ? 'Bấm lần nữa để xóa' : 'Xóa lịch'}
        </button>
      )}
    </div>
  )
}
