'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { RefreshCw } from 'lucide-react'

interface Props {
  taskId: string
  requestFn: (taskId: string, reason?: string) => Promise<{ success?: boolean; error?: string } | undefined>
}

export function RequestResubmitSection({ taskId, requestFn }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [reason, setReason] = useState('')
  const [open, setOpen] = useState(false)

  function handleRequest() {
    startTransition(async () => {
      const result = await requestFn(taskId, reason.trim() || undefined)
      if (result?.error) {
        toast.error(result.error)
      } else {
        toast.success('Đã yêu cầu staff thực hiện lại')
        setOpen(false)
        setReason('')
        router.refresh()
      }
    })
  }

  if (!open) {
    return (
      <Card className="bg-status-warning-bg/60 ring-status-warning/30 v2:ring-status-warning/30">
        <CardContent className="pt-4 flex items-center justify-between gap-4">
          <p className="text-sm text-status-warning">
            Kết quả chưa đạt yêu cầu? Yêu cầu staff thực hiện lại task này.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 h-[44px] md:h-8 border-status-warning/40 text-status-warning hover:bg-status-warning-bg"
            onClick={() => setOpen(true)}
          >
            <RefreshCw className="h-4 w-4 mr-1.5" />
            Yêu cầu làm lại
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="ring-status-warning/30 v2:ring-status-warning/30">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm text-status-warning">Yêu cầu thực hiện lại</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea
          placeholder="Lý do (không bắt buộc) — staff sẽ nhận được thông báo kèm lý do này"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={pending}
            onClick={handleRequest}
            className="h-[44px] md:h-8 bg-status-warning text-status-warning-bg hover:bg-status-warning/90"
          >
            {pending ? 'Đang gửi...' : 'Xác nhận yêu cầu'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setOpen(false); setReason('') }}
          >
            Huỷ
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
