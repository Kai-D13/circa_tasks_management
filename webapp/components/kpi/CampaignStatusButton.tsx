'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { toggleCampaign, deleteCampaign } from '@/app/actions/kpiCampaigns'
import { Button } from '@/components/ui/button'
import { Play, Pause, Trash2 } from 'lucide-react'

// Pause/resume (active↔paused) + delete (draft only). Mirrors ScheduleActions.
export function CampaignStatusButton({ id, status }: { id: string; status: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const isActive = status === 'active'
  const canToggle = status === 'active' || status === 'draft' || status === 'paused'

  function handleToggle() {
    startTransition(async () => {
      const r = await toggleCampaign(id)
      if (r?.error) toast.error(r.error)
      else { toast.success(isActive ? 'Đã tạm dừng' : 'Đã kích hoạt'); router.refresh() }
    })
  }
  function handleDelete() {
    if (!confirm('Xoá chiến dịch nháp này?')) return
    startTransition(async () => {
      const r = await deleteCampaign(id)
      if (r?.error) toast.error(r.error)
      else { toast.success('Đã xoá'); router.push('/targets/campaigns') }
    })
  }

  return (
    <div className="flex items-center gap-1.5">
      {canToggle && (
        <Button size="sm" variant="outline" onClick={handleToggle} disabled={pending} className="gap-1.5">
          {isActive ? <><Pause className="h-3.5 w-3.5" /> Tạm dừng</> : <><Play className="h-3.5 w-3.5" /> Kích hoạt</>}
        </Button>
      )}
      {/* Delete stays quiet (ghost icon) — a red button per row shouts on the list */}
      {status === 'draft' && (
        <Button
          size="sm" variant="ghost" onClick={handleDelete} disabled={pending}
          aria-label="Xoá chiến dịch nháp" title="Xoá chiến dịch nháp"
          className="px-2 text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      )}
    </div>
  )
}
