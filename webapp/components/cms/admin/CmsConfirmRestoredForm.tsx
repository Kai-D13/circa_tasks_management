'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ShieldCheck } from 'lucide-react'
import { confirmCmsReturnsRestored } from '@/app/actions/cmsReturns'
import { useFixtureActionBlocked } from '@/components/kpi/KpiFixtureBoundary'
import { Notice } from '@/components/ds/Notice'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { CMS_CONFIRM_CODE_LABEL } from '@/lib/cms/returnsConflictAction'

// CMS-CALC-RET-2 P5.5 — nút "Xác nhận nguồn đã phục hồi" (super). CHỈ render khi server đọc được proof hợp lệ (rpc_cms_return_conflicts
// trả `proof`). Gửi đúng proof (eval_seq + open_set_hash) của lần đọc + idem do server sinh lúc render ⇒ bấm lại / mạng chập chờn không
// tạo hai bản ghi (RPC trả already). Không có thao tác nhận số mới / sửa tiền.
const BTN = 'h-[44px] md:h-[36px] gap-1.5'

export function CmsConfirmRestoredForm({ programId, proof, idem, disabledReason, openCount }: {
  programId: string
  proof: { evalSeq: number; openSetHash: string }
  idem: string
  /** Cờ returns OFF / server QA chỉ đọc ⇒ nút khoá + lý do. */
  disabledReason: string | null
  openCount: number
}) {
  const router = useRouter()
  const fixtureBlocked = useFixtureActionBlocked()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  // Code point (= SQL char_length / kiểm ở server), không theo UTF-16.
  const len = [...reason.trim()].length
  const submit = () => {
    if (fixtureBlocked()) return
    setError(null)
    startTransition(async () => {
      try {
        const r = await confirmCmsReturnsRestored({ programId, openSetHash: proof.openSetHash, proofEvalSeq: proof.evalSeq, reason, idem })
        if (r.ok) {
          toast.success(r.already ? 'Đã xác nhận trước đó' : `Đã xác nhận ${r.conflicts} phiếu khớp lại baseline`)
          setOpen(false)
          router.refresh()
          return
        }
        setError(CMS_CONFIRM_CODE_LABEL[r.code] ?? CMS_CONFIRM_CODE_LABEL.QUERY_FAILED)
        if (r.code === 'UNKNOWN_OUTCOME' || r.code === 'STALE') router.refresh()
      } catch {
        setError(CMS_CONFIRM_CODE_LABEL.UNKNOWN_OUTCOME)
        router.refresh()
      }
    })
  }
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => { setError(null); setOpen(true) }} disabled={!!disabledReason || pending}
          className={BTN} data-cms-confirm-restored>
          <ShieldCheck className="h-4 w-4" aria-hidden="true" /> Xác nhận nguồn đã phục hồi
        </Button>
        {disabledReason && <span className="text-[12px] text-muted-foreground">{disabledReason}</span>}
      </div>
      <Dialog open={open} onOpenChange={(o) => { if (!pending) setOpen(o) }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Xác nhận nguồn trả hàng đã phục hồi?</DialogTitle>
            <DialogDescription>
              Lần kiểm #{proof.evalSeq} thấy {openCount} phiếu đã khớp lại đúng baseline đã nhận. Xác nhận chỉ đóng conflict để lượt tính sau
              được công bố — không đổi số tiền, không nhận nội dung mới của phiếu.
            </DialogDescription>
          </DialogHeader>
          <label className="block space-y-1.5 text-[13px]">
            <span className="font-medium">Lý do / bằng chứng đã kiểm (10–1.000 ký tự)</span>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={4}
              className="text-[16px] md:text-sm" data-cms-confirm-reason />
            <span data-cms-confirm-reason-hint className="block text-[12px] text-muted-foreground">Lý do được lưu vĩnh viễn trong lịch sử xác nhận — ghi mã phiếu / nguồn đã kiểm, không ghi tên hoặc số điện thoại khách.</span>
            <span className="block text-[12px] text-muted-foreground tabular-nums">{len}/1.000</span>
          </label>
          {error && <Notice tone="danger" role="alert">{error}</Notice>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending} className={BTN}>Huỷ</Button>
            <Button type="button" onClick={submit} disabled={pending || len < 10 || len > 1000} className={BTN} data-cms-confirm-submit>
              {pending ? 'Đang xác nhận…' : 'Xác nhận'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
