'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { syncCampaignActuals } from '@/app/actions/kpiCampaigns'
import { Button } from '@/components/ui/button'
import { RefreshCw } from 'lucide-react'

// Manual actual-GMV sync (super admin) — same lib the 2h cron uses.
export function SyncActualsButton({ campaignId }: { campaignId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  function handleSync() {
    startTransition(async () => {
      const r = await syncCampaignActuals(campaignId)
      if (r?.error) { toast.error(r.error); return }
      const ok = r as { upserted?: number; unmatched?: string[] }
      const unmatched = ok.unmatched ?? []
      if (unmatched.length > 0) {
        // A store has a target but ZERO BigQuery rows in the range — surface it
        // so admin doesn't read a silent 0 as a clean sync.
        toast.warning(
          `Đồng bộ ${ok.upserted ?? 0} cửa hàng — ${unmatched.length} POS chưa có dữ liệu BigQuery: ${unmatched.slice(0, 5).join(', ')}${unmatched.length > 5 ? '…' : ''}`,
          { duration: 8000 },
        )
      } else {
        toast.success(`Đã đồng bộ ${ok.upserted ?? 0} cửa hàng`)
      }
      router.refresh()
    })
  }

  return (
    <Button size="sm" variant="outline" onClick={handleSync} disabled={pending} className="gap-1.5">
      <RefreshCw className={pending ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
      {pending ? 'Đang đồng bộ…' : 'Đồng bộ ngay'}
    </Button>
  )
}
