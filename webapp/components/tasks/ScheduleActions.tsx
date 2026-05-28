'use client'

import { useTransition } from 'react'
import { toast } from 'sonner'
import { pauseSchedule, resumeSchedule } from '@/app/actions/tasks'
import { Pause, Play } from 'lucide-react'

interface Props {
  scheduleId: string
  isActive: boolean
}

export function ScheduleActions({ scheduleId, isActive }: Props) {
  const [pending, startTransition] = useTransition()

  function handleToggle() {
    startTransition(async () => {
      const result = isActive
        ? await pauseSchedule(scheduleId)
        : await resumeSchedule(scheduleId)
      if (result?.error) toast.error(result.error)
      else toast.success(isActive ? 'Đã tạm dừng lịch' : 'Đã kích hoạt lại lịch')
    })
  }

  return (
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
  )
}
