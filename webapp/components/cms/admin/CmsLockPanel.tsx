'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Lock } from 'lucide-react'
import { lockCmsProgram, previewCmsLock } from '@/app/actions/cmsPayouts'
import { useFixtureActionBlocked } from '@/components/kpi/KpiFixtureBoundary'
import { Panel } from '@/components/ds/Panel'
import { Notice } from '@/components/ds/Notice'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { cmsDateTime, cmsVnd } from '@/lib/cms/display'
import { cmsLockConfirmFlow, cmsLockReloadFlow, type CmsLockIo } from '@/lib/cms/lockFlow'
import {
  cmsLockActionLabel, cmsLockCodeLabel, cmsLockReady, cmsNormalizeAck, cmsUnassignedRatioText, type CmsLockPreviewDto,
} from '@/lib/cms/payoutView'

// CMS P3a — khối "Chốt kỳ" trên A3 (blueprint P3 §3; UI_V2_CMS §3.4; work order luồng D). Chỉ super + cờ program + earnings +
// lock; server dựng preview (rpc_cms_lock_preview) rồi truyền vào. Hộp xác nhận: tóm tắt + checkbox "Tôi đã kiểm tra số liệu"
// (+ lý do khi còn dòng chưa gán dưới ngưỡng) ⇒ gửi expected_run_id + policy_version CỦA preview đang xem; RPC 123 kiểm lại
// toàn bộ trong transaction. r2 (PM r1 PKG-P1-3): mọi kết quả action đi qua lib/cms/lockFlow — Server Action reject / mất phản
// hồi ⇒ "chưa xác định" + làm mới trang, KHOÁ nút tới khi "Kiểm tra lại" thành công (không tự gửi lại); RECHECK / tải lại lỗi ⇒
// khoá nút (không giữ sẵn sàng giả). Server QA (CMS_QA_SERVER) ⇒ chỉ đọc: nút khoá + server từ chối trước RPC (PKG-P1-2).
const BTN = 'h-[44px] md:h-[36px] gap-1.5'

function Summary({ p }: { p: CmsLockPreviewDto }) {
  const pol = p.policy
  return (
    <dl data-cms-lock-summary className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
      <dt className="text-muted-foreground">Lần tính dùng để chốt</dt>
      <dd className="tabular-nums">{p.runStartedAt ? cmsDateTime(p.runStartedAt) : '—'}</dd>
      <dt className="text-muted-foreground">Tổng CMS</dt>
      <dd data-cms-lock-amount className="font-semibold tabular-nums">{p.amountVnd !== null ? cmsVnd(p.amountVnd) : '—'}</dd>
      <dt className="text-muted-foreground">Dược sĩ có tiền / có kết quả</dt>
      <dd className="tabular-nums">{p.staffPaid ?? '—'} / {p.staffRows ?? '—'}</dd>
      <dt className="text-muted-foreground">Dòng chưa gán</dt>
      <dd className="tabular-nums">
        {p.unassignedLines} dòng · {cmsUnassignedRatioText(p.unassignedGmv, p.candidateGmv)} GMV
        {pol.unassignedMaxLines !== null && pol.unassignedMaxGmvBp !== null && (
          <span className="text-muted-foreground"> (ngưỡng {pol.unassignedMaxLines} dòng · {(pol.unassignedMaxGmvBp / 100).toLocaleString('vi-VN')}%)</span>
        )}
      </dd>
      <dt className="text-muted-foreground">Quy tắc chốt</dt>
      <dd>
        {pol.label === 'QA_ONLY_ASSUMPTION'
          ? <StatusBadge tone="warning" size="sm">Giả định QA — không phải quy tắc chi trả thật</StatusBadge>
          : <span>Phiên bản {p.policyVersion ?? '—'}</span>}
      </dd>
    </dl>
  )
}

export function CmsLockPanel({ programId, preview: initial, loadError, qaReadonly = false }: {
  programId: string
  preview: CmsLockPreviewDto | null
  /** Mã lỗi preview (đã kiểm quyền ở server); null khi có preview. */
  loadError: string | null
  /** Server QA chỉ đọc (CMS_QA_SERVER) — chỉ là lớp UI; server action từ chối trước RPC. */
  qaReadonly?: boolean
}) {
  const router = useRouter()
  const fixtureBlocked = useFixtureActionBlocked()
  const [preview, setPreview] = useState(initial)
  // stale: preview không còn chắc đúng (RECHECK, tải lại lỗi, kết quả chốt chưa xác định) ⇒ khoá nút tới khi tải lại thành công.
  const [stale, setStale] = useState(false)
  const [open, setOpen] = useState(false)
  const [checked, setChecked] = useState(false)
  const [ack, setAck] = useState('')
  const [error, setError] = useState<string | null>(initial ? null : cmsLockActionLabel(loadError ?? 'QUERY_FAILED'))
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function reload() {
    if (fixtureBlocked()) return
    const io: Pick<CmsLockIo, 'preview'> = { preview: (id) => previewCmsLock(id) }
    startTransition(async () => {
      const r = await cmsLockReloadFlow(io, programId)
      if (r.preview) { setPreview(r.preview); setStale(false); setError(null); setNotice(null) } else { setStale(true); setError(r.error) }
    })
  }

  const recheckButton = (
    <Button type="button" variant="outline" onClick={reload} disabled={pending} className={BTN} data-cms-lock-recheck>Kiểm tra lại</Button>
  )

  if (!preview) {
    return (
      <Panel title="Chốt kỳ" className="v2:rounded-v2-panel" actions={recheckButton}>
        <Notice tone="danger" role="alert" title="Chưa tải được điều kiện chốt kỳ">{error ?? cmsLockActionLabel('QUERY_FAILED')}</Notice>
      </Panel>
    )
  }
  const ready = cmsLockReady(preview) && !stale && !qaReadonly
  const ackOk = !preview.needsAck || cmsNormalizeAck(ack) !== null

  function confirm() {
    setError(null)
    if (fixtureBlocked()) { setOpen(false); return }
    if (!preview || !preview.runId || preview.policyVersion === null) return
    const input = { programId, expectedRunId: preview.runId, expectedPolicyVersion: preview.policyVersion, ackReason: preview.needsAck ? ack : null }
    const io: CmsLockIo = { lock: (i) => lockCmsProgram(i), preview: (id) => previewCmsLock(id) }
    startTransition(async () => {
      const o = await cmsLockConfirmFlow(io, input)
      if (o.kind === 'locked') {
        toast.success(o.already ? 'Chương trình đã được chốt trước đó' : 'Đã chốt kỳ')
        setOpen(false)
        setStale(true)
        router.refresh()
      } else if (o.kind === 'unknown') {
        // Có thể ĐÃ chốt: không báo thất bại, không tự gửi lại — làm mới trang + khoá nút tới khi kiểm tra lại.
        setOpen(false)
        setStale(true)
        setNotice(o.notice)
        router.refresh()
      } else if (o.kind === 'recheck') {
        setOpen(false)
        setNotice(o.notice)
        if (o.reload.preview) { setPreview(o.reload.preview); setStale(false) } else { setStale(true); setError(o.reload.error) }
      } else {
        setError(o.error)
      }
    })
  }

  return (
    <Panel title="Chốt kỳ" className="v2:rounded-v2-panel" actions={recheckButton}>
      <div data-cms-lock-panel={ready ? 'ready' : stale ? 'stale' : 'blocked'} className="space-y-3">
        {qaReadonly && (
          <Notice tone="info" role="status" title="Server QA chỉ đọc">
            Chốt chương trình QA bằng công cụ có sổ (<code>cms-qa-results.mjs lock</code>); máy chủ từ chối xác nhận chốt từ giao diện này.
          </Notice>
        )}
        {notice && <div data-cms-lock-notice><Notice tone="warning" role="status">{notice}</Notice></div>}
        {stale && !notice && <Notice tone="warning" role="status">Điều kiện chốt cần được kiểm tra lại trước khi chốt.</Notice>}
        <Summary p={preview} />
        {preview.blockers.length > 0 ? (
          <Notice tone="warning" role="status" title="Chưa thể chốt kỳ">
            <ul data-cms-lock-blockers className="list-disc space-y-0.5 pl-4">
              {preview.blockers.map((b) => <li key={b} data-cms-lock-blocker={b}>{cmsLockCodeLabel(b)}</li>)}
            </ul>
          </Notice>
        ) : (
          <p className="text-[13px] text-muted-foreground">
            Chốt kỳ ghi lại số tiền và danh sách dược sĩ của lần tính trên. <b>Không thể mở lại</b>; phát sinh sau chốt chỉ vào báo cáo riêng.
          </p>
        )}
        {error && !open && <div data-cms-lock-error><Notice tone="danger" role="alert">{error}</Notice></div>}
        <div className="flex justify-end">
          <Button type="button" onClick={() => { setError(null); setAck(''); setChecked(false); setOpen(true) }} disabled={!ready || pending}
            className={`${BTN} font-semibold`} data-cms-lock-open>
            <Lock className="h-4 w-4" /> Chốt kỳ…
          </Button>
        </div>
      </div>
      <Dialog open={open} onOpenChange={(o) => { if (!pending) setOpen(o) }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Chốt kỳ chương trình?</DialogTitle>
            <DialogDescription>Không thể mở lại. Phát sinh sau chốt (trả hàng, đơn đến muộn) chỉ vào báo cáo riêng, không đổi số đã chốt.</DialogDescription>
          </DialogHeader>
          <Summary p={preview} />
          {preview.needsAck && (
            <div className="space-y-1.5">
              <label htmlFor="cms-lock-ack" className="text-[13px] font-medium">
                Lý do xác nhận {preview.unassignedLines} dòng chưa gán (10–1.000 ký tự)
              </label>
              <Textarea id="cms-lock-ack" data-cms-lock-ack value={ack} onChange={(e) => setAck(e.target.value)} maxLength={1000} rows={3}
                className="text-[16px] md:text-sm" placeholder="Vd: đã đối soát với vận hành, các dòng này không thuộc dược sĩ nào" />
            </div>
          )}
          <label className="flex min-h-[44px] cursor-pointer items-center gap-2.5 text-[13px] font-medium">
            <input type="checkbox" data-cms-lock-check checked={checked} onChange={(e) => setChecked(e.target.checked)} className="size-5 shrink-0 accent-primary" />
            Tôi đã kiểm tra số liệu
          </label>
          {error && <Notice tone="danger" role="alert">{error}</Notice>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending} className="h-[44px] md:h-[36px]">Để sau</Button>
            <Button type="button" variant="destructive" onClick={confirm} disabled={pending || !ackOk || !checked} data-cms-lock-confirm className="h-[44px] md:h-[36px] font-semibold">
              Chốt kỳ
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Panel>
  )
}
