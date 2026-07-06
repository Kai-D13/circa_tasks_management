'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'

// Fixed-URL export (the campaign id is in the path, not page searchParams — so
// the generic ExportButton, which appends searchParams, can't be reused here).
// Mirrors ExportButton's blob download + error toast.
export function CampaignExportButton({ campaignId }: { campaignId: string }) {
  const [pending, setPending] = useState(false)

  async function handleClick() {
    setPending(true)
    try {
      const res = await fetch(`/api/export/kpi-campaigns?campaign_id=${encodeURIComponent(campaignId)}`)
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
      const filename = star ? decodeURIComponent(star[1]) : (plain?.[1] ?? 'campaign.xlsx')
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
    <Button variant="outline" size="sm" onClick={handleClick} disabled={pending}>
      <Download className="h-4 w-4 mr-1" />
      {pending ? 'Đang xuất...' : 'Xuất Excel'}
    </Button>
  )
}
