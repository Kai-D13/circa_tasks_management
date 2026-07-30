'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { toggleCampaign, deleteCampaign, archiveCampaign } from '@/app/actions/kpiCampaigns'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Play, Pause, Trash2, Archive } from 'lucide-react'

// Pause/resume (active↔paused) + delete (draft only) + soft archive (paused/
// ended — contract 28/07: biến mất khỏi UI, dữ liệu giữ nguyên). Confirm =
// dialog Circa (base-ui) thay window.confirm; server action + RPC 098 re-check
// trạng thái tại thời điểm thao tác (nút chỉ là lớp UI).
export function CampaignStatusButton({ id, status, name }: { id: string; status: string; name: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [confirming, setConfirming] = useState<'delete' | 'archive' | null>(null)
  const isActive = status === 'active'
  const canToggle = status === 'active' || status === 'draft' || status === 'paused'
  // Mirror lib/kpi/archive (campaignArchivable/campaignDeletable) — list/detail
  // không bao giờ render campaign đã archive nên chỉ cần nhánh theo status.
  const canArchive = status === 'paused' || status === 'ended'
  const canDelete = status === 'draft'

  function handleToggle() {
    startTransition(async () => {
      const r = await toggleCampaign(id)
      if (r?.error) toast.error(r.error)
      else { toast.success(isActive ? 'Đã tạm dừng' : 'Đã kích hoạt'); router.refresh() }
    })
  }
  function handleConfirmed() {
    const kind = confirming
    if (!kind) return
    startTransition(async () => {
      const r = kind === 'delete' ? await deleteCampaign(id) : await archiveCampaign(id)
      if (r?.error) { toast.error(r.error); setConfirming(null); return }
      toast.success(kind === 'delete' ? 'Đã xoá chiến dịch nháp' : 'Đã lưu trữ chiến dịch')
      setConfirming(null)
      router.push('/targets/campaigns')
      router.refresh()
    })
  }

  return (
    <div className="flex items-center gap-1.5">
      {canToggle && (
        <Button size="sm" variant="outline" onClick={handleToggle} disabled={pending} className="gap-1.5">
          {isActive ? <><Pause className="h-3.5 w-3.5" /> Tạm dừng</> : <><Play className="h-3.5 w-3.5" /> Kích hoạt</>}
        </Button>
      )}
      {canArchive && (
        <Button
          size="sm" variant="ghost" onClick={() => setConfirming('archive')} disabled={pending}
          aria-label="Lưu trữ chiến dịch" title="Lưu trữ — ẩn khỏi hệ thống, giữ nguyên dữ liệu"
          className="px-2 text-muted-foreground hover:text-primary"
        >
          <Archive className="h-4 w-4" />
        </Button>
      )}
      {/* Delete stays quiet (ghost icon) — a red button per row shouts on the list */}
      {canDelete && (
        <Button
          size="sm" variant="ghost" onClick={() => setConfirming('delete')} disabled={pending}
          aria-label="Xoá chiến dịch nháp" title="Xoá vĩnh viễn chiến dịch nháp"
          className="px-2 text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      )}

      <Dialog open={confirming !== null} onOpenChange={(open) => { if (!open) setConfirming(null) }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {confirming === 'delete' ? 'Xoá chiến dịch nháp?' : 'Lưu trữ chiến dịch?'}
            </DialogTitle>
            <DialogDescription>
              <span className="font-medium text-foreground">{name}</span>
              {confirming === 'delete' ? (
                <> — toàn bộ target và bậc thưởng đã nạp sẽ bị <span className="font-medium text-destructive">xoá vĩnh viễn</span>. Không thể hoàn tác.</>
              ) : (
                <> — chiến dịch sẽ <span className="font-medium">biến mất khỏi danh sách và các màn doanh số</span>, nhưng toàn bộ dữ liệu target, kết quả, commission và lịch sử import được giữ nguyên.</>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirming(null)} disabled={pending}>
              Hủy
            </Button>
            <Button
              size="sm"
              variant={confirming === 'delete' ? 'destructive' : 'default'}
              onClick={handleConfirmed}
              disabled={pending}
            >
              {confirming === 'delete' ? 'Xoá chiến dịch' : 'Lưu trữ'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
