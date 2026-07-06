'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { updatePrescriptionOrderCode } from '@/app/actions/prescriptions'
import { DHC_STRICT_PATTERN, DHC_FORMAT_HINT } from '@/lib/prescriptions/constants'
import { cn } from '@/lib/utils'
import { AlertTriangle, PencilLine } from 'lucide-react'

// Fix a wrong DHC on an order that failed to sync (or is still pending). The
// next order-sync cron then re-matches against the Sheet. Rendered on the
// prescription detail for the owner staff / super admin.
export function OrderCodeFixForm({
  submissionId, currentCode, isError,
}: {
  submissionId: string
  currentCode: string
  isError: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState(currentCode)

  const invalid = code.trim() !== '' && !DHC_STRICT_PATTERN.test(code.trim().toUpperCase())

  function save() {
    const c = code.trim().toUpperCase()
    if (!DHC_STRICT_PATTERN.test(c)) { toast.error(DHC_FORMAT_HINT); return }
    if (c === currentCode.toUpperCase()) { toast.error('Mã đơn không thay đổi'); return }
    startTransition(async () => {
      const r = await updatePrescriptionOrderCode(submissionId, c)
      if (r?.error) { toast.error(r.error); return }
      toast.success('Đã cập nhật mã đơn — hệ thống sẽ đồng bộ lại ở phiên kế tiếp')
      setOpen(false)
      router.refresh()
    })
  }

  if (!open) {
    return isError ? (
      <div className="rounded-lg border border-red-200 bg-red-50/60 dark:border-red-900 dark:bg-red-950/20 p-3 space-y-2">
        <p className="flex items-center gap-1.5 text-sm font-medium text-red-700">
          <AlertTriangle className="h-4 w-4 shrink-0" /> Mã DHC chưa khớp dữ liệu đơn POS
        </p>
        <p className="text-xs text-muted-foreground">
          Kiểm tra lại mã đơn trên POS. Sửa đúng mã để hệ thống tự đồng bộ ở phiên kế tiếp.
        </p>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          <PencilLine className="h-3.5 w-3.5 mr-1.5" /> Sửa mã đơn
        </Button>
      </div>
    ) : (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)} className="text-muted-foreground">
        <PencilLine className="h-3.5 w-3.5 mr-1.5" /> Sửa mã đơn
      </Button>
    )
  }

  return (
    <div className="rounded-lg border p-3 space-y-2">
      <label className="text-sm font-medium" htmlFor="fix-order-code">Mã đơn hàng DHC</label>
      <input
        id="fix-order-code"
        type="text"
        autoCapitalize="characters"
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase())}
        className={cn(
          'w-full h-10 rounded-md border bg-background px-3 text-base font-mono tracking-wider shadow-sm',
          invalid ? 'border-destructive' : 'border-input focus-visible:border-primary',
        )}
      />
      <p className={cn('text-xs', invalid ? 'text-destructive' : 'text-muted-foreground')}>{DHC_FORMAT_HINT}</p>
      <div className="flex gap-2">
        <Button size="sm" onClick={save} disabled={pending}>{pending ? 'Đang lưu…' : 'Lưu mã mới'}</Button>
        <Button size="sm" variant="ghost" onClick={() => { setOpen(false); setCode(currentCode) }} disabled={pending}>Hủy</Button>
      </div>
    </div>
  )
}
