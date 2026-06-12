'use client'

import { useRef, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Upload } from 'lucide-react'
import { uploadWeeklyTargets } from '@/app/actions/targets'
import { Button } from '@/components/ui/button'

interface UploadResult {
  upserted:  number
  unmatched: string[]
  rowErrors: string[]
}

// Manual fallback loader for the BI XLSX export — the daily path is the
// automated /api/targets/ingest push.
export function TargetUploadForm() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<UploadResult | null>(null)

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const file = inputRef.current?.files?.[0]
    if (!file) { toast.error('Chọn file XLSX export từ Power BI trước'); return }
    const formData = new FormData()
    formData.set('file', file)
    startTransition(async () => {
      const r = await uploadWeeklyTargets(formData)
      if ('error' in r) { toast.error(r.error); return }
      setResult({ upserted: r.upserted ?? 0, unmatched: r.unmatched ?? [], rowErrors: r.rowErrors ?? [] })
      toast.success(`Đã cập nhật doanh số cho ${r.upserted} cửa hàng`)
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
          aria-label="File XLSX doanh số"
        />
        <Button type="submit" size="sm" disabled={pending}>
          <Upload className="h-4 w-4 mr-1" />
          {pending ? 'Đang nạp...' : 'Nạp dữ liệu'}
        </Button>
      </form>
      {result && (
        <div className="text-xs space-y-1">
          <p className="text-muted-foreground">Đã ghi {result.upserted} cửa hàng.</p>
          {result.unmatched.length > 0 && (
            <p className="text-amber-600">
              Không khớp tên cửa hàng ({result.unmatched.length}): {result.unmatched.join(', ')}
            </p>
          )}
          {result.rowErrors.length > 0 && (
            <p className="text-red-600">
              Dòng lỗi ({result.rowErrors.length}): {result.rowErrors.slice(0, 5).join('; ')}
              {result.rowErrors.length > 5 && '…'}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
