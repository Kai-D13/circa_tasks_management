'use client'

import { useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface Props {
  endpoint: string          // e.g. '/api/export/tasks'
  label?: string
  // Params that MUST be present in the URL before exporting (e.g. ['date_from','date_to']
  // for logs). Shows a toast instead of navigating when missing.
  requireParams?: string[]
  requireMessage?: string
}

// Reuses the page's active filters (URL searchParams) and hits the export
// route; the route's Content-Disposition triggers a file download without
// navigating away.
export function ExportButton({ endpoint, label = 'Xuất Excel', requireParams, requireMessage }: Props) {
  const searchParams = useSearchParams()

  function handleClick() {
    if (requireParams?.some((p) => !searchParams.get(p))) {
      toast.error(requireMessage ?? 'Vui lòng chọn đủ bộ lọc trước khi xuất')
      return
    }
    const qs = searchParams.toString()
    window.location.href = qs ? `${endpoint}?${qs}` : endpoint
  }

  return (
    <Button variant="outline" size="sm" onClick={handleClick}>
      <Download className="h-4 w-4 mr-1" />
      {label}
    </Button>
  )
}
