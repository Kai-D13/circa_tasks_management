'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { FilePlus2 } from 'lucide-react'
import { runCmsManualCloseReportAction } from '@/app/actions/cmsReturns'
import { useFixtureActionBlocked } from '@/components/kpi/KpiFixtureBoundary'
import { Notice } from '@/components/ds/Notice'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { CMS_RETURNS_POLICY_LABEL } from '@/lib/cms/calc/basisUi'
import type { CmsReturnProfile } from '@/lib/cms/calc/policy'
import { CMS_MANUAL_REASON_MAX, CMS_MANUAL_REASON_MIN, CMS_MANUAL_REPORT_CODE_LABEL } from '@/lib/cms/returnsAfterClose'

// 132 r1 (PM 18/11 audit r0 P1-02 / P1-04, Q-233) — super lập báo cáo trả sau chốt cho MỘT chương trình bằng PHIÊN của chính mình
// (đường ngày 31; cũng là nơi chọn quy tắc báo cáo lần đầu cho chương trình chốt theo cách cũ / chỉ số bán). Gửi: run chốt server đã đọc
// lúc render (lệch ⇒ CMS_MANUAL_RUN_MISMATCH), lý do 10–500 ký tự, khoá yêu cầu server sinh (bấm lại không nhân bản). Quy tắc: đã ghim ⇒
// chỉ hiển thị; chưa ghim ⇒ radio bắt buộc chọn (không mặc định). DB lấy người lập từ phiên — form không gửi actor.
const BTN = 'h-[44px] md:h-[36px] gap-1.5'
const CHOICES: CmsReturnProfile[] = ['full_line_qty_refund_v1', 'net_returns_v1']

export type CmsManualProfileChoice = { kind: 'pinned'; profile: CmsReturnProfile } | { kind: 'choose' }

export function CmsManualReportForm({ programId, payoutRunId, choice, idem, disabledReason }: {
  programId: string
  payoutRunId: string
  choice: CmsManualProfileChoice
  idem: string
  /** Cờ returns OFF / server QA / DB thiếu đường lập tay ⇒ nút khoá + lý do. */
  disabledReason: string | null
}) {
  const router = useRouter()
  const fixtureBlocked = useFixtureActionBlocked()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [picked, setPicked] = useState<CmsReturnProfile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  // security-reviewer r1 P2-4: khoá yêu cầu giữ trong state (router.refresh() đổi prop `idem` nhưng không đổi state) ⇒ bấm lại sau kết
  // quả KHÔNG rõ (lỗi mạng sau khi DB đã ghi) dùng CÙNG khoá ⇒ DB trả báo cáo cũ, không nhân bản. Chỉ đổi khoá sau khi lập xong.
  const [key, setKey] = useState(idem)
  // Code point (= SQL char_length / kiểm ở server), không theo UTF-16.
  const len = [...reason.trim()].length
  const profile = choice.kind === 'pinned' ? null : picked
  const ready = len >= CMS_MANUAL_REASON_MIN && len <= CMS_MANUAL_REASON_MAX && (choice.kind === 'pinned' || picked !== null)
  const submit = () => {
    if (fixtureBlocked()) return
    setError(null)
    startTransition(async () => {
      try {
        const r = await runCmsManualCloseReportAction({ programId, payoutRunId, profile, reason, idem: key })
        if (r.ok) {
          // db-reviewer r1 P2: "already" = báo cáo CŨ (cùng khoá yêu cầu / cùng snapshot) — lý do lần này KHÔNG được lưu; báo cáo cũ giữ
          // người lập / lý do của nó (có thể là job tự động).
          toast.success(r.status === 'already'
            ? 'Báo cáo đã có (cùng yêu cầu / cùng dữ liệu) — không lập thêm; lý do lần này không được lưu, xem người lập ở danh sách báo cáo'
            : 'Đã lập báo cáo sau chốt')
          setKey(crypto.randomUUID())
          setOpen(false)
          router.refresh()
          return
        }
        setError(CMS_MANUAL_REPORT_CODE_LABEL[r.code] ?? `Không lập được báo cáo (${r.code}).`)
        if (r.code === 'CMS_MANUAL_RUN_MISMATCH') router.refresh()
      } catch {
        setError('Chưa xác định được kết quả — tải lại trang để kiểm tra trước khi thử lại.')
        router.refresh()
      }
    })
  }
  return (
    <div className="space-y-2" data-cms-manual-report={choice.kind === 'pinned' ? choice.profile : 'choose'}>
      <p className="text-[13px] text-muted-foreground">
        {choice.kind === 'pinned'
          ? <>Quy tắc báo cáo đã ghim: <span className="font-medium text-foreground">{CMS_RETURNS_POLICY_LABEL[choice.profile]}</span>.</>
          : 'Chương trình chưa chọn quy tắc báo cáo — job tự động bỏ qua cho tới khi super lập báo cáo đầu tiên và chọn quy tắc.'}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" onClick={() => { setError(null); setOpen(true) }} disabled={!!disabledReason || pending}
          className={BTN} data-cms-manual-open>
          <FilePlus2 className="h-4 w-4" aria-hidden="true" /> Lập báo cáo thủ công
        </Button>
        {disabledReason && <span className="text-[12px] text-muted-foreground" data-cms-manual-disabled>{disabledReason}</span>}
      </div>
      <Dialog open={open} onOpenChange={(o) => { if (!pending) setOpen(o) }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Lập báo cáo trả hàng sau chốt?</DialogTitle>
            <DialogDescription>
              Đọc phiếu trả hàng mới nhất của kỳ rồi tính lại trên số đã chốt. Báo cáo chỉ để tham khảo — không đổi số đã chốt, không phải lệnh
              thu / chi. Người lập và lý do được lưu cùng báo cáo.
            </DialogDescription>
          </DialogHeader>
          {choice.kind === 'choose' && (
            <fieldset className="space-y-1.5">
              <legend className="text-[13px] font-medium">Quy tắc báo cáo (chọn một lần — các báo cáo sau dùng cùng quy tắc)</legend>
              <div className="grid gap-2" role="radiogroup" aria-label="Quy tắc báo cáo">
                {CHOICES.map((p) => (
                  <label key={p} data-cms-manual-profile={p}
                    className={cn('flex min-h-[44px] cursor-pointer items-start gap-2 rounded-v2-control border p-3 text-[14px]', picked === p && 'border-primary bg-primary/5')}>
                    <input type="radio" name="cms-manual-profile" value={p} checked={picked === p} onChange={() => setPicked(p)} className="mt-0.5 size-4 shrink-0" />
                    <span className="min-w-0">{CMS_RETURNS_POLICY_LABEL[p]}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <label className="block space-y-1.5 text-[13px]">
            <span className="font-medium">Lý do lập tay ({CMS_MANUAL_REASON_MIN}–{CMS_MANUAL_REASON_MAX} ký tự)</span>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={CMS_MANUAL_REASON_MAX} rows={3}
              className="text-[16px] md:text-sm" data-cms-manual-reason />
            <span className="block text-[12px] text-muted-foreground">Ví dụ: phiếu hoàn tất sau ngày 30, đối soát ngày 31. Không ghi tên hoặc số điện thoại khách.</span>
            <span className="block text-[12px] text-muted-foreground tabular-nums">{len}/{CMS_MANUAL_REASON_MAX}</span>
          </label>
          {error && <Notice tone="danger" role="alert">{error}</Notice>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending} className={BTN}>Huỷ</Button>
            <Button type="button" onClick={submit} disabled={pending || !ready} className={BTN} data-cms-manual-submit>
              {pending ? 'Đang lập…' : 'Lập báo cáo'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
