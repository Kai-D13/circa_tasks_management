'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  CARE_CANCEL_MESSAGES, CARE_CANCEL_WARNING, type CareCancelCounts, type CareCancelPreview, type CareCancelResult,
} from '@/lib/care/importCancel'

// Huỷ file import (D1, Q-157/Q-163): bước 1 xem trước (câu cảnh báo cố định + số đếm dự kiến), bước 2 xác nhận RIÊNG gửi
// đúng commitSeq của bản xem trước này. Preview chỉ tham khảo — RPC 115 kiểm lại mọi điều kiện sau khi khoá; kết quả hiển
// thị là số thật RPC trả. Action truyền vào (trang thật: server action; catalog: action giả). Chống gửi đôi.

type Step = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'review'; preview: Extract<CareCancelPreview, { ok: true }> }
  | { kind: 'confirm'; preview: Extract<CareCancelPreview, { ok: true }> } | { kind: 'done'; counts: CareCancelCounts }

const n = (v: number) => v.toLocaleString('vi-VN')

function CountList({ c, done = false }: { c: CareCancelCounts; done?: boolean }) {
  const rows: [string, number][] = [
    [done ? 'Task đã xoá' : 'Task sẽ xoá', c.tasksDeleted],
    [done ? 'Task đã hoàn nguyên' : 'Task sẽ hoàn nguyên', c.tasksRestored],
    [done ? 'Khách đã xoá' : 'Khách sẽ xoá', c.customersDeleted],
    [done ? 'Dòng sản phẩm đã xoá' : 'Dòng sản phẩm sẽ xoá', c.productsDeleted],
    [done ? 'Dòng sản phẩm đã khôi phục' : 'Dòng sản phẩm sẽ khôi phục', c.productsRestored],
  ]
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 rounded-lg border bg-muted/30 p-3 text-sm" data-testid="care-cancel-counts">
      {rows.map(([label, v]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-right font-medium tabular-nums">{n(v)}</dd>
        </div>
      ))}
    </dl>
  )
}

export function CareImportCancelDialog({
  open, onOpenChange, batchId, preview, cancel, onDone,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  batchId: string
  preview: (input: { batchId: string }) => Promise<CareCancelPreview>
  cancel: (input: { batchId: string; expectedCommitSeq: string }) => Promise<CareCancelResult>
  onDone?: () => void
}) {
  const [step, setStep] = useState<Step>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const sending = useRef(false)

  useEffect(() => {
    if (!open) return
    setStep({ kind: 'loading' })
    let alive = true
    preview({ batchId }).then((r) => {
      if (!alive) return
      setStep(r.ok ? { kind: 'review', preview: r } : { kind: 'error', message: CARE_CANCEL_MESSAGES[r.code] })
    }).catch(() => alive && setStep({ kind: 'error', message: CARE_CANCEL_MESSAGES.FAILED }))
    return () => { alive = false }
  }, [open, batchId, preview])

  async function submit() {
    if (step.kind !== 'confirm' || sending.current) return
    sending.current = true
    setBusy(true)
    try {
      const r = await cancel({ batchId, expectedCommitSeq: step.preview.commitSeq })
      if (r.ok) { setStep({ kind: 'done', counts: r.counts }); onDone?.() }
      else setStep({ kind: 'error', message: CARE_CANCEL_MESSAGES[r.code] })
    } catch {
      setStep({ kind: 'error', message: CARE_CANCEL_MESSAGES.FAILED })
    } finally {
      sending.current = false
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o) }}>
      {/* Không dùng nút X mặc định (26px, dưới 44px trên mobile) — mỗi bước đã có Đóng / Quay lại ở footer. */}
      <DialogContent className="sm:max-w-lg" showCloseButton={false} data-testid="care-cancel-dialog" data-step={step.kind}>
        <DialogHeader>
          <DialogTitle>{step.kind === 'done' ? 'Đã huỷ file import' : 'Huỷ file import'}</DialogTitle>
          <DialogDescription>
            {step.kind === 'done' ? 'Kết quả thực tế do hệ thống trả về.' : step.kind === 'confirm' ? 'Bước 2/2 — xác nhận huỷ.' : 'Bước 1/2 — xem trước tác động.'}
          </DialogDescription>
        </DialogHeader>

        {step.kind === 'loading' && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Đang kiểm tra file…</p>
        )}
        {step.kind === 'error' && (
          <p role="alert" className="text-sm text-status-danger" data-testid="care-cancel-error">{step.message}</p>
        )}
        {(step.kind === 'review' || step.kind === 'confirm') && (
          <div className="space-y-3">
            <p className="flex gap-2 rounded-lg border border-status-warning/40 bg-status-warning-bg p-3 text-sm text-status-warning" data-testid="care-cancel-warning">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>{CARE_CANCEL_WARNING}</span>
            </p>
            <CountList c={step.preview.counts} />
            {step.kind === 'confirm' && (
              <p className="text-sm font-medium" data-testid="care-cancel-confirm-text">
                Xác nhận huỷ file {step.preview.kind === 'revision' ? 'sửa trong kỳ' : 'đầu kỳ'}: xoá {n(step.preview.counts.tasksDeleted)} task
                {step.preview.counts.tasksRestored > 0 ? `, hoàn nguyên ${n(step.preview.counts.tasksRestored)} task` : ''}. Không hoàn tác được.
              </p>
            )}
          </div>
        )}
        {step.kind === 'done' && <CountList c={step.counts} done />}

        <DialogFooter>
          {step.kind === 'review' && (
            <>
              <Button variant="outline" className="min-h-[44px] md:min-h-0" onClick={() => onOpenChange(false)}>Đóng</Button>
              <Button className="min-h-[44px] md:min-h-0" onClick={() => setStep({ kind: 'confirm', preview: step.preview })}>Tiếp tục</Button>
            </>
          )}
          {step.kind === 'confirm' && (
            <>
              <Button variant="outline" className="min-h-[44px] md:min-h-0" disabled={busy} onClick={() => setStep({ kind: 'review', preview: step.preview })}>Quay lại</Button>
              <Button variant="destructive" className="min-h-[44px] md:min-h-0" disabled={busy} onClick={submit} data-testid="care-cancel-submit">
                {busy && <Loader2 className="size-4 animate-spin" />} Huỷ file
              </Button>
            </>
          )}
          {(step.kind === 'loading' || step.kind === 'error' || step.kind === 'done') && (
            <Button variant="outline" className="min-h-[44px] md:min-h-0" onClick={() => onOpenChange(false)}>Đóng</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
