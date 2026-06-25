'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { RotateCcw } from 'lucide-react'
import { bulkRequestResubmit } from '@/app/actions/tasks'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'

interface Props {
  taskIds: string[]
  onDone: () => void
}

export function BulkResubmitButton({ taskIds, onDone }: Props) {
  const router = useRouter()
  const [open, setOpen]     = useState(false)
  const [reason, setReason] = useState('')
  const [pre, setPre]       = useState<{ validCount: number; skippedCount: number } | null>(null)
  const [pending, start]    = useTransition()

  function openDialog() {
    setOpen(true)
    setPre(null)
    // Auto-preflight so the admin immediately sees how many are eligible.
    start(async () => {
      const r = await bulkRequestResubmit(taskIds, undefined, { preflight: true })
      if ('error' in r) { toast.error(r.error); return }
      if ('preflight' in r) setPre({ validCount: r.validCount ?? 0, skippedCount: r.skippedCount ?? 0 })
    })
  }

  function confirm() {
    start(async () => {
      const r = await bulkRequestResubmit(taskIds, reason.trim() || undefined)
      if ('error' in r) { toast.error(r.error); return }
      const count = (r as { count?: number }).count ?? 0
      const skipped = (r as { skippedCount?: number }).skippedCount ?? 0
      toast.success(`Đã yêu cầu làm lại ${count} task${skipped ? ` · bỏ qua ${skipped}` : ''}`)
      setOpen(false)
      setReason('')
      onDone()
      router.refresh()
    })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (o) openDialog(); else setOpen(false) }}>
      <DialogTrigger render={<Button variant="outline" size="sm" className="h-7 text-xs gap-1" />}>
        <RotateCcw className="h-3.5 w-3.5" /> Yêu cầu làm lại
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Yêu cầu làm lại {taskIds.length} task đã chọn</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {pre === null
              ? 'Đang kiểm tra…'
              : `${pre.validCount} task hợp lệ${pre.skippedCount ? ` · ${pre.skippedCount} bị bỏ qua (task cha / chưa có kết quả / không có quyền)` : ''}.`}
          </p>
          <div>
            <label className="text-sm font-medium">Lý do <span className="text-muted-foreground font-normal">(tùy chọn)</span></label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Vd: Ảnh chưa rõ, cần chụp lại…"
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={pending}>Hủy</Button>
            <Button size="sm" onClick={confirm} disabled={pending || !pre || pre.validCount === 0}>
              {pending ? 'Đang xử lý...' : `Xác nhận (${pre?.validCount ?? 0})`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
