'use client'

import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SearchableSelect } from '@/components/ui/searchable-select'
import { Textarea } from '@/components/ui/textarea'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { CARE_TRANSFER_NOTE_MAX } from '@/lib/care/browse'

// Chuyển giao có ghi chú (SPEC B3 §3). Một dược sĩ đích cho cả nhóm; ghi chú 1–500 ký
// tự; tóm tắt nguồn → đích + cảnh báo đổi cửa hàng trước khi xác nhận; chống gửi đôi.
// Action được truyền vào (trang thật: server action gọi RPC bằng session; trang mock:
// action giả) — RPC 114 là chốt quyền/atomic cuối cùng.

export interface CareTransferTaskRef { id: string; customerName: string; storeId: string; storeCode: string; assigneeId: string; assigneeName: string }
export interface CareTransferTarget { id: string; fullName: string; storeId: string; storeCode: string; storeName: string }
export type CareTransferActionResult = { ok: true; transferred: number } | { ok: false; code: string; message: string }

export function CareTransferDialog({
  open, onOpenChange, tasks, loadTargets, transfer, onDone,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  tasks: CareTransferTaskRef[]
  loadTargets: () => Promise<{ ok: true; staff: CareTransferTarget[] } | { ok: false; message: string }>
  transfer: (input: { taskIds: string[]; toUserId: string; note: string }) => Promise<CareTransferActionResult>
  onDone: (transferred: number) => void
}) {
  const [targets, setTargets] = useState<CareTransferTarget[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [to, setTo] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sending = useRef(false)

  useEffect(() => {
    if (!open) return
    setTo(''); setNote(''); setError(null)
    let alive = true
    loadTargets().then((r) => {
      if (!alive) return
      if (r.ok) { setTargets(r.staff); setLoadErr(null) } else setLoadErr(r.message)
    }).catch(() => alive && setLoadErr('Không tải được danh sách dược sĩ — thử lại.'))
    return () => { alive = false }
  }, [open, loadTargets])

  const target = targets?.find((t) => t.id === to) ?? null
  const sources = [...new Map(tasks.map((t) => [`${t.storeCode}|${t.assigneeName}`, t])).values()]
  const storeChanges = target ? tasks.filter((t) => t.storeId !== target.storeId).length : 0
  const sameOwner = target ? tasks.filter((t) => t.assigneeId === target.id).length : 0
  const noteOk = note.trim().length >= 1 && note.trim().length <= CARE_TRANSFER_NOTE_MAX
  const canSubmit = !!target && noteOk && !busy && sameOwner === 0 && tasks.length > 0
  // B7-ui: nói rõ vì sao nút Xác nhận còn tắt (trước đây chỉ mờ đi, người dùng tưởng lỗi).
  const blockHint = busy || tasks.length === 0 || canSubmit ? null
    : sameOwner > 0 ? 'Chọn dược sĩ khác — có khách đã thuộc dược sĩ này.'
    : !target && !noteOk ? 'Chọn dược sĩ nhận và nhập ghi chú để xác nhận.'
    : !target ? 'Chọn dược sĩ nhận để xác nhận.'
    : 'Nhập ghi chú chuyển giao để xác nhận.'

  async function submit() {
    if (!canSubmit || sending.current) return
    sending.current = true
    setBusy(true); setError(null)
    try {
      const r = await transfer({ taskIds: tasks.map((t) => t.id), toUserId: to, note: note.trim() })
      if (r.ok) { onDone(r.transferred); onOpenChange(false) } else setError(r.message)
    } catch {
      setError('Không gửi được yêu cầu — tải lại danh sách để kiểm tra trước khi thử lại.')
    } finally {
      sending.current = false
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o) }}>
      <DialogContent className="sm:max-w-lg" data-testid="care-transfer-dialog">
        <DialogHeader>
          <DialogTitle>Chuyển giao {tasks.length} khách</DialogTitle>
          <DialogDescription>Đổi dược sĩ phụ trách các task đang mở của kỳ hiện tại. Lịch sử chăm sóc đã ghi được giữ nguyên.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div>
            <p className="mb-1 font-medium">Đang phụ trách</p>
            <ul className="max-h-24 space-y-0.5 overflow-y-auto text-muted-foreground">
              {sources.map((s) => (
                <li key={`${s.storeCode}|${s.assigneeName}`}>
                  {s.storeCode} · {s.assigneeName} ({tasks.filter((t) => t.storeCode === s.storeCode && t.assigneeName === s.assigneeName).length})
                </li>
              ))}
            </ul>
          </div>
          <div className="space-y-1">
            <p className="font-medium">Dược sĩ nhận</p>
            {loadErr ? <p className="text-status-danger">{loadErr}</p> : (
              <SearchableSelect
                value={to}
                onValueChange={setTo}
                options={(targets ?? []).map((t) => ({ value: t.id, label: t.fullName, description: `${t.storeCode} · ${t.storeName}`, keywords: [t.storeCode, t.storeName] }))}
                placeholder={targets ? 'Chọn dược sĩ' : 'Đang tải…'}
                searchPlaceholder="Tìm tên, mã cửa hàng…"
                emptyText="Không có dược sĩ trong phạm vi"
                disabled={!targets}
                triggerClassName="min-h-[44px] w-full md:min-h-0"
              />
            )}
          </div>
          {target && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2">
              <span>{tasks.length} khách</span><ArrowRight className="size-4" />
              <span className="font-medium">{target.fullName}</span><span className="text-muted-foreground">({target.storeCode})</span>
              {storeChanges > 0 && <StatusBadge tone="warning">{storeChanges} khách đổi sang cửa hàng {target.storeCode}</StatusBadge>}
              {sameOwner > 0 && <StatusBadge tone="danger">{sameOwner} khách đã thuộc dược sĩ này</StatusBadge>}
            </div>
          )}
          <div className="space-y-1">
            <label className="font-medium" htmlFor="care-transfer-note">Ghi chú chuyển giao (bắt buộc)</label>
            <Textarea id="care-transfer-note" value={note} maxLength={CARE_TRANSFER_NOTE_MAX} rows={3}
              onChange={(e) => setNote(e.target.value)} className="bg-background text-[16px] md:text-sm dark:bg-background"
              placeholder="Lý do chuyển giao, ví dụ: dược sĩ nghỉ phép, chuyển ca…" />
            <p className="text-right text-xs text-muted-foreground">{note.trim().length}/{CARE_TRANSFER_NOTE_MAX}</p>
          </div>
          {error && <p role="alert" className="text-status-danger">{error}</p>}
          {blockHint && <p className="text-xs text-muted-foreground" data-testid="care-transfer-hint">{blockHint}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" className="min-h-[44px] md:min-h-0" disabled={busy} onClick={() => onOpenChange(false)}>Huỷ</Button>
          <Button className="min-h-[44px] md:min-h-0" disabled={!canSubmit} onClick={submit}>
            {busy && <Loader2 className="size-4 animate-spin" />} Xác nhận chuyển giao
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
