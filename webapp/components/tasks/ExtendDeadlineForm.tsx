'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { CalendarClock } from 'lucide-react'

interface Props {
  taskId:    string
  extendFn:  (taskId: string, newDeadline: string) => Promise<{ success?: boolean; error?: string } | undefined>
  currentDeadline: string | null
}

export function ExtendDeadlineForm({ taskId, extendFn, currentDeadline }: Props) {
  const router = useRouter()
  const [open, setOpen]           = useState(false)
  const [date, setDate]           = useState('')
  const [pending, startTransition] = useTransition()

  // Minimum date: tomorrow in VN timezone (UTC+7)
  const minDate = new Date(Date.now() + 7 * 3600 * 1000 + 86400 * 1000)
    .toISOString().slice(0, 10)

  function handleSubmit() {
    if (!date) return
    startTransition(async () => {
      // Store as end-of-day in VN timezone (UTC+7) = 16:59:59Z next day
      const newDeadline = `${date}T23:59:59+07:00`
      const result = await extendFn(taskId, newDeadline)
      if (result?.error) {
        toast.error(result.error)
      } else {
        toast.success('Đã gia hạn deadline')
        setOpen(false)
        setDate('')
        router.refresh()
      }
    })
  }

  if (!open) {
    return (
      <Card className="bg-status-danger-bg/60 ring-status-danger/30 v2:ring-status-danger/30">
        <CardContent className="pt-4 flex items-center justify-between gap-4">
          <p className="text-sm text-status-danger">
            Task đã quá hạn{currentDeadline ? ` từ ${new Date(currentDeadline).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}` : ''}.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 h-[44px] md:h-8 border-status-danger/40 text-status-danger hover:bg-status-danger-bg"
            onClick={() => setOpen(true)}
          >
            <CalendarClock className="h-4 w-4 mr-1.5" />
            Gia hạn deadline
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="ring-status-danger/30 v2:ring-status-danger/30">
      <CardContent className="pt-4 space-y-3">
        <p className="text-sm font-medium text-status-danger">Chọn deadline mới</p>
        <input
          type="date"
          min={minDate}
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="h-10 md:h-9 rounded-md v2:rounded-v2-control border border-input bg-background px-3 py-1 text-[16px] md:text-sm shadow-sm w-full max-w-[200px]"
          aria-label="Ngày gia hạn"
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={!date || pending}
            onClick={handleSubmit}
            className="h-[44px] md:h-8 bg-status-danger text-status-danger-bg hover:bg-status-danger/90"
          >
            {pending ? 'Đang lưu...' : 'Xác nhận'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setOpen(false); setDate('') }}
          >
            Huỷ
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
