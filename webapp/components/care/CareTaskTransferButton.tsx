'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Shuffle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { CareTransferDialog, type CareTransferActionResult, type CareTransferTaskRef, type CareTransferTarget } from './CareTransferDialog'

// Nút chuyển giao một task từ trang chi tiết (SM/super, task đang mở kỳ hiện tại).
export function CareTaskTransferButton({ task, loadTargets, transfer }: {
  task: CareTransferTaskRef
  loadTargets: () => Promise<{ ok: true; staff: CareTransferTarget[] } | { ok: false; message: string }>
  transfer: (input: { taskIds: string[]; toUserId: string; note: string }) => Promise<CareTransferActionResult>
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [done, setDone] = useState(false)
  return (
    <>
      {done ? <StatusBadge tone="success">Đã chuyển giao</StatusBadge> : (
        <Button className="min-h-[44px] md:min-h-0" onClick={() => setOpen(true)}><Shuffle className="size-4" /> Chuyển giao</Button>
      )}
      <CareTransferDialog open={open} onOpenChange={setOpen} tasks={[task]} loadTargets={loadTargets} transfer={transfer}
        onDone={() => { setDone(true); router.refresh() }} />
    </>
  )
}
