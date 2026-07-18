'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface Props {
  endpoint: string          // e.g. '/api/export/tasks'
  label?: string
  // Params that MUST be present in the URL before exporting (e.g. ['date_from','date_to']
  // for logs). Shows a toast instead of fetching when missing.
  requireParams?: string[]
  requireMessage?: string
  // Styling only (e.g. 'h-[44px] md:h-8' to meet the mobile touch-target
  // contract on migrated routes). Omitted → unchanged default look.
  className?: string
}

// Reuses the page's active filters (URL searchParams) and fetches the export
// route, then triggers a blob download. Unlike a raw <a>/location navigation,
// a non-200 (403 / "too many rows" / 500) surfaces as a toast instead of
// dumping a JSON error page on the user.
export function ExportButton({ endpoint, label = 'Xuất Excel', requireParams, requireMessage, className }: Props) {
  const searchParams = useSearchParams()
  const [pending, setPending] = useState(false)

  async function handleClick() {
    if (requireParams?.some((p) => !searchParams.get(p))) {
      toast.error(requireMessage ?? 'Vui lòng chọn đủ bộ lọc trước khi xuất')
      return
    }
    const qs = searchParams.toString()
    setPending(true)
    try {
      const res = await fetch(qs ? `${endpoint}?${qs}` : endpoint)
      if (!res.ok) {
        let msg = `Xuất thất bại (${res.status})`
        try { const j = await res.json(); if (j?.error) msg = j.error } catch { /* non-JSON */ }
        toast.error(msg)
        return
      }
      const blob = await res.blob()
      // Derive filename from Content-Disposition (filename*=UTF-8'' preferred).
      const cd = res.headers.get('Content-Disposition') ?? ''
      const star = cd.match(/filename\*=UTF-8''([^;]+)/i)
      const plain = cd.match(/filename="([^"]+)"/i)
      const filename = star ? decodeURIComponent(star[1]) : (plain?.[1] ?? 'export.xlsx')

      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Lỗi tải file')
    } finally {
      setPending(false)
    }
  }

  return (
    <Button variant="outline" size="sm" className={className} onClick={handleClick} disabled={pending}>
      <Download className="h-4 w-4 mr-1" />
      {pending ? 'Đang xuất...' : label}
    </Button>
  )
}
