'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Play } from 'lucide-react'
import { activateCmsProgram } from '@/app/actions/cmsPrograms'
import { useFixtureActionBlocked } from '@/components/kpi/KpiFixtureBoundary'
import { Notice } from '@/components/ds/Notice'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { cmsDate, cmsDateRange } from '@/lib/cms/display'

// CMS P1-c — kích hoạt chương trình nháp (U6; SPEC §4.7; H7). Hộp xác nhận: số SP, khoảng ngày, phạm vi; ngày bắt đầu đã
// qua ⇒ nói rõ áp dụng HỒI TỐ từ ngày bắt đầu và sau kích hoạt chỉ còn thêm sản phẩm; ngày kết thúc đã qua ⇒ Chờ chốt kỳ.
// RPC 121 kiểm lại trạng thái / SP / phạm vi / trùng ProductID trong transaction. Không có đường về nháp / huỷ (H8).
export function CmsActivateButton({ programId, productCount, startDate, endDate, scopeText, today }: {
  programId: string
  productCount: number
  startDate: string
  endDate: string
  scopeText: string
  today: string
}) {
  const router = useRouter()
  const fixtureBlocked = useFixtureActionBlocked()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const retro = startDate <= today
  const ended = endDate < today

  function confirm() {
    setError(null)
    if (fixtureBlocked()) { setOpen(false); return }
    startTransition(async () => {
      const r = await activateCmsProgram(programId)
      if (!r.ok) { setError(r.error); return }
      toast.success('Đã kích hoạt chương trình')
      setOpen(false)
      router.refresh()
    })
  }

  return (
    <>
      <Button type="button" onClick={() => { setError(null); setOpen(true) }} data-cms-activate className="h-[44px] md:h-[36px] gap-1.5 font-semibold">
        <Play className="h-4 w-4" /> Kích hoạt chương trình
      </Button>
      <Dialog open={open} onOpenChange={(o) => { if (!pending) setOpen(o) }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Kích hoạt chương trình?</DialogTitle>
            <DialogDescription>Sau khi kích hoạt, dược sĩ thuộc phạm vi thấy danh mục; không có thao tác về nháp hay huỷ.</DialogDescription>
          </DialogHeader>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
            <dt className="text-muted-foreground">Sản phẩm</dt><dd className="font-semibold tabular-nums">{productCount}</dd>
            <dt className="text-muted-foreground">Thời gian</dt><dd className="tabular-nums">{cmsDateRange(startDate, endDate)}</dd>
            <dt className="text-muted-foreground">Phạm vi</dt><dd>{scopeText}</dd>
          </dl>
          {retro && (
            <Notice tone="warning" role="status">
              Ngày bắt đầu {cmsDate(startDate)} đã qua: chương trình <b>áp dụng hồi tố từ ngày bắt đầu</b>. Sau khi kích hoạt chỉ còn thêm sản phẩm mới.
              {ended && ' Ngày kết thúc cũng đã qua — chương trình sẽ ở trạng thái Chờ chốt kỳ.'}
            </Notice>
          )}
          {error && <Notice tone="danger" role="alert">{error}</Notice>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending} className="h-[44px] md:h-[36px]">Để sau</Button>
            <Button type="button" onClick={confirm} disabled={pending} data-cms-activate-confirm className="h-[44px] md:h-[36px] font-semibold">Kích hoạt</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
