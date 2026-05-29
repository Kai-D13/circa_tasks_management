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

  // Minimum date: tomorrow (can't re-set to a past date)
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const minDate = tomorrow.toISOString().slice(0, 10)

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
      <Card className="border-red-200 bg-red-50/40">
        <CardContent className="pt-4 flex items-center justify-between gap-4">
          <p className="text-sm text-red-800">
            Task đã quá hạn{currentDeadline ? ` từ ${new Date(currentDeadline).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}` : ''}.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 border-red-300 text-red-800 hover:bg-red-100"
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
    <Card className="border-red-200">
      <CardContent className="pt-4 space-y-3">
        <p className="text-sm font-medium text-red-800">Chọn deadline mới</p>
        <input
          type="date"
          min={minDate}
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm w-full max-w-[200px]"
          aria-label="Ngày gia hạn"
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={!date || pending}
            onClick={handleSubmit}
            className="bg-red-600 hover:bg-red-700"
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
