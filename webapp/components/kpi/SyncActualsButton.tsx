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
      if (r?.error) toast.error(r.error)
      else {
        toast.success(`Đã đồng bộ ${(r as { upserted?: number }).upserted ?? 0} cửa hàng`)
        router.refresh()
      }
    })
  }

  return (
    <Button size="sm" variant="outline" onClick={handleSync} disabled={pending} className="gap-1.5">
      <RefreshCw className={pending ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
      {pending ? 'Đang đồng bộ…' : 'Đồng bộ ngay'}
    </Button>
  )
}
