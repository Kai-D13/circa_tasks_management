'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { CareImportCancelDialog } from '@/components/care/CareImportCancelDialog'
import type { CareCancelPreview, CareCancelResult } from '@/lib/care/importCancel'

// Nút "Huỷ file" trên dòng batch đủ điều kiện (server đã tính: cờ ON + quyền import + batch committed mới nhất của kỳ hiện tại).
// Huỷ xong ⇒ làm mới trang KHI ĐÓNG hộp thoại (để người dùng đọc được kết quả thật trước khi dòng đổi trạng thái).
export function CareImportCancelButton({
  batchId, preview, cancel,
}: {
  batchId: string
  preview: (input: { batchId: string }) => Promise<CareCancelPreview>
  cancel: (input: { batchId: string; expectedCommitSeq: string }) => Promise<CareCancelResult>
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [done, setDone] = useState(false)
  return (
    <>
      <Button variant="destructive" size="sm" className="min-h-[44px] md:min-h-0" onClick={() => setOpen(true)} data-testid="care-cancel-open">
        Huỷ file
      </Button>
      {open && (
        <CareImportCancelDialog
          open={open}
          batchId={batchId}
          preview={preview}
          cancel={cancel}
          onDone={() => setDone(true)}
          onOpenChange={(o) => {
            setOpen(o)
            if (!o && done) { setDone(false); router.refresh() }
          }}
        />
      )}
    </>
  )
}
