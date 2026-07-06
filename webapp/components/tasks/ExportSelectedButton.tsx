'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'

// POSTs the selected task ids to the selected-export route and downloads the
// xlsx. POST (with a JSON body) so a large selection can't overflow the URL.
export function ExportSelectedButton({ ids }: { ids: string[] }) {
  const [pending, setPending] = useState(false)

  async function handleClick() {
    setPending(true)
    try {
      const res = await fetch('/api/export/tasks/selected', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      if (!res.ok) {
        let msg = `Xuất thất bại (${res.status})`
        try { const j = await res.json(); if (j?.error) msg = j.error } catch { /* non-JSON */ }
        toast.error(msg)
        return
      }
      const blob = await res.blob()
      const cd = res.headers.get('Content-Disposition') ?? ''
      const star = cd.match(/filename\*=UTF-8''([^;]+)/i)
      const plain = cd.match(/filename="([^"]+)"/i)
      const filename = star ? decodeURIComponent(star[1]) : (plain?.[1] ?? 'tasks_selected.xlsx')
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = filename
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Lỗi tải file')
    } finally {
      setPending(false)
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={handleClick} disabled={pending} className="gap-1.5">
      <Download className="h-3.5 w-3.5" />
      {pending ? 'Đang xuất...' : `Xuất đã chọn (${ids.length})`}
    </Button>
  )
}
