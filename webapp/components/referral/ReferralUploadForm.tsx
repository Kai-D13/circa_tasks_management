'use client'

import { useRef, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Upload } from 'lucide-react'
import { uploadReferralReport } from '@/app/actions/referrals'
import { Button } from '@/components/ui/button'

// Manual snapshot loader for the referral campaign — super admin uploads the
// xlsx exported from BigQuery; each upload REPLACES all rows.
export function ReferralUploadForm() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<{ inserted: number; staffCount: number } | null>(null)

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const file = inputRef.current?.files?.[0]
    if (!file) { toast.error('Chọn file .xlsx export từ BigQuery trước'); return }
    const formData = new FormData()
    formData.set('file', file)
    startTransition(async () => {
      const r = await uploadReferralReport(formData)
      if ('error' in r) { toast.error(r.error); return }
      setResult({ inserted: r.inserted ?? 0, staffCount: r.staffCount ?? 0 })
      toast.success(`Đã nạp ${r.inserted} dòng cho ${r.staffCount} nhân viên`)
      if (inputRef.current) inputRef.current.value = ''
    })
  }

  return (
    <div className="space-y-2">
      <form onSubmit={handleSubmit} className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="text-sm file:mr-2 file:rounded file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium"
          aria-label="File XLSX giới thiệu"
        />
        <Button type="submit" size="sm" disabled={pending}>
          <Upload className="h-4 w-4 mr-1" />
          {pending ? 'Đang nạp...' : 'Nạp dữ liệu'}
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">
        Upload kết quả query BigQuery (.xlsx). Mỗi lần nạp sẽ <span className="font-medium">thay thế toàn bộ</span> dữ liệu cũ.
      </p>
      {result && (
        <p className="text-xs text-muted-foreground">Đã ghi {result.inserted} dòng cho {result.staffCount} nhân viên.</p>
      )}
    </div>
  )
}
