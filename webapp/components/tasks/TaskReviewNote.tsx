'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { addReviewNote } from '@/app/actions/tasks'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatDate } from '@/lib/dateUtils'

interface ReviewEntry {
  id: string
  created_at: string
  metadata: Record<string, unknown> | null
  users: { full_name: string } | null
}

interface Props {
  taskId: string
  reviews: ReviewEntry[]
}

export function TaskReviewNote({ taskId, reviews }: Props) {
  const [note, setNote] = useState('')
  const [pending, startTransition] = useTransition()

  function handleSubmit() {
    if (!note.trim()) return
    startTransition(async () => {
      const result = await addReviewNote(taskId, note.trim())
      if (result?.error) toast.error(result.error)
      else {
        toast.success('Đã gửi ghi chú')
        setNote('')
      }
    })
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Ghi chú quản lý</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {reviews.length > 0 && (
          <div className="space-y-2">
            {reviews.map((r) => (
              <div key={r.id} className="rounded-md border bg-muted/40 p-3 space-y-0.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium">
                    {r.users?.full_name ?? '—'}
                  </span>
                  <span className="text-xs text-muted-foreground">{formatDate(r.created_at)}</span>
                </div>
                <p className="text-sm whitespace-pre-wrap">
                  {r.metadata?.note as string ?? ''}
                </p>
              </div>
            ))}
          </div>
        )}

        <div className="space-y-2">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Yêu cầu Staff bổ sung thông tin, mô tả, làm lại..."
            rows={3}
            className="text-sm"
          />
          <Button size="sm" disabled={pending || !note.trim()} onClick={handleSubmit}>
            {pending ? 'Đang gửi...' : 'Gửi ghi chú'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
