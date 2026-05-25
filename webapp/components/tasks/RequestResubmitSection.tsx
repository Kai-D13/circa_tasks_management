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
      <Card className="border-amber-200 bg-amber-50/50">
        <CardContent className="pt-4 flex items-center justify-between gap-4">
          <p className="text-sm text-amber-800">
            Kết quả chưa đạt yêu cầu? Yêu cầu staff thực hiện lại task này.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 border-amber-300 text-amber-800 hover:bg-amber-100"
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
    <Card className="border-amber-200">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm text-amber-800">Yêu cầu thực hiện lại</CardTitle>
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
            className="bg-amber-600 hover:bg-amber-700"
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
