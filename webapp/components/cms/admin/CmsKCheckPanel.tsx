'use client'

import { useState } from 'react'
import { Loader2, ShieldCheck } from 'lucide-react'
import { Notice } from '@/components/ds/Notice'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { cmsDateTime } from '@/lib/cms/display'
import { CMS_K_VIEW, cmsKAckable, cmsKView, type CmsPreviewKCheck } from '@/lib/cms/importView'
import {
  CMS_K_ACK_SOURCE_MAX_CLIENT, cmsKAckKey, cmsKBulkApplyAllowed, cmsKBulkApplySource, cmsKBulkCheck, cmsKBulkConfirmSync, cmsKBulkFingerprint,
  cmsKCanRecheck, cmsKDraftOf, cmsKExcluded, cmsKPending, cmsKSelected, cmsKSourceOk, type CmsKAckDraft,
} from '@/lib/cms/kAckPlan'

// CMS S2 (PM spec r1 08/11 §5.1) — bảng kiểm K của lần kiểm file (chỉ super; route import đã chặn vai khác). Trình bày trạng thái từ
// server; KHÔNG tự điền K, không tự khẳng định "đã kiểm". Xác nhận tay chỉ cho SP CHƯA CÓ BẰNG CHỨNG / KHÔNG KIỂM ĐƯỢC có K: chọn +
// nhập nguồn căn cứ ⇒ "Kiểm tra lại với xác nhận" gửi lại preview kèm ý định; server gắn tên người xác nhận (phiên) + thời điểm và
// lưu trong lần kiểm. LỆCH / NGUỒN LỖI / NGUỒN XUNG ĐỘT không có ô xác nhận.
// UX-KACK-1 (PM 15/11 §4): cột xác nhận đứng thứ 3 (ngay sau ProductID / Kết quả); < lg mỗi SP là một thẻ (thấy hành động + nguồn
// không cần kéo ngang); lọc "Cần xác nhận"; chọn nhiều dòng + một nguồn chung (người dùng tự nhập và tự xác nhận — không auto-tick,
// không dùng nguồn cũ); dòng đã tick mà chưa gửi được đánh dấu; ý định thiếu nguồn chặn gửi (không gửi im lặng một phần).

export type { CmsKAckDraft } from '@/lib/cms/kAckPlan'

const COLS = 'lg:grid lg:grid-cols-[7rem_10.5rem_minmax(0,1.4fr)_7.5rem_minmax(0,1fr)] lg:gap-x-3'
const EXCLUDED_LABEL = (s: ReturnType<typeof cmsKExcluded>[number]['status']): string =>
  s === 'ACKED' ? 'đã xác nhận' : s === 'NO_K' ? 'thiếu K trong file' : CMS_K_VIEW[s].label

export function CmsKCheckPanel({ kCheck, drafts, onDrafts, onRecheck, busy, otherErrorIds }: {
  kCheck: CmsPreviewKCheck
  drafts: CmsKAckDraft
  onDrafts: (next: CmsKAckDraft) => void
  onRecheck: () => void
  busy: boolean
  /** ProductID xác nhận K được nhưng nhóm còn lỗi ngoài K (xác nhận K chưa đủ để ghi). */
  otherErrorIds?: ReadonlySet<string>
}) {
  const rows = kCheck.products
  const ackable = rows.filter(cmsKAckable)
  const [view, setView] = useState<'all' | 'ack'>('all')
  const [bulkSource, setBulkSource] = useState('')
  // KACK-BULK-01: xác nhận nguồn chung lưu DẤU VÂN TAY (tập ProductID / đơn vị / K đã chọn + nguồn chuẩn hoá) lúc tick, không lưu boolean.
  const [bulkConfirmedFp, setBulkConfirmedFp] = useState<string | null>(null)
  const visible = view === 'ack' && ackable.length > 0 ? ackable : rows
  const visibleAckable = visible.filter(cmsKAckable)
  const pending = cmsKPending(rows, drafts)
  const selected = cmsKSelected(visible, drafts)
  const excluded = cmsKExcluded(rows)
  const canRecheck = cmsKCanRecheck(rows, drafts, kCheck.available)
  const bulkFp = cmsKBulkFingerprint(selected, bulkSource)
  // Mọi đường đổi tập / nguồn (tick từng dòng, chọn / bỏ chọn tất cả, đổi lọc, nhập nguồn) ⇒ dấu vân tay khác ⇒ huỷ hẳn ngay trong render.
  const confirmedFp = cmsKBulkConfirmSync(bulkConfirmedFp, bulkFp)
  if (confirmedFp !== bulkConfirmedFp) setBulkConfirmedFp(confirmedFp)
  const bulkConfirm = confirmedFp !== null
  const bulkOk = cmsKBulkApplyAllowed({ selected, source: bulkSource, confirmedFp, busy })
  const setOne = (key: string, d: { checked: boolean; source: string }) => onDrafts({ ...drafts, [key]: d })

  function applyBulk() {
    if (!cmsKBulkApplyAllowed({ selected, source: bulkSource, confirmedFp, busy })) return
    onDrafts(cmsKBulkApplySource(visible, drafts, bulkSource))
    setBulkConfirmedFp(null)
  }

  return (
    <section id="cms-kcheck" data-cms-kcheck={kCheck.available ? 'ok' : 'unavailable'} className="space-y-3 rounded-v2-panel border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 text-[14px] font-semibold"><ShieldCheck aria-hidden="true" className="h-4 w-4" />Kiểm quy đổi đơn vị (K) theo dữ liệu bán</h2>
        <span className="text-[12px] text-muted-foreground">{kCheck.available ? `Dữ liệu đọc lúc ${cmsDateTime(kCheck.asOf)}` : 'Không đọc được dữ liệu bán'}</span>
      </div>
      {!kCheck.available && (
        <Notice tone="warning" role="status">Chưa kiểm được K — sản phẩm chỉ ghi được khi có xác nhận tay kèm nguồn căn cứ, hoặc bấm “Kiểm tra lại” sau để đọc lại dữ liệu bán.</Notice>
      )}
      {ackable.length > 0 && (
        <p data-cms-k-howto className="text-[13px] text-muted-foreground">
          <b className="text-foreground">{ackable.length} sản phẩm</b> chưa có bằng chứng K từ dữ liệu bán — không cần sửa file nếu K đúng: tick “Tôi xác nhận K…”, nhập nguồn
          căn cứ (vd. quy cách nhà cung cấp, cột “SL quy đổi” của đúng đơn vị trên POS), rồi bấm <b className="text-foreground">“Kiểm tra lại với xác nhận”</b>. Tick chưa
          làm sản phẩm ghi được cho tới khi kiểm tra lại xong.
        </p>
      )}

      {ackable.length > 0 && ackable.length < rows.length && (
        <div role="group" aria-label="Lọc bảng kiểm K" className="flex w-fit max-w-full gap-1 rounded-v2-control bg-muted p-1">
          {([['all', `Tất cả (${rows.length})`], ['ack', `Cần xác nhận (${ackable.length})`]] as const).map(([k, label]) => (
            <button
              key={k} type="button" aria-pressed={view === k} data-cms-k-view={k} onClick={() => setView(k)}
              className={cn('min-h-[44px] md:min-h-0 md:h-[30px] whitespace-nowrap rounded-[8px] px-3 text-[13px]',
                view === k ? 'bg-card font-semibold text-foreground border border-input' : 'text-muted-foreground')}
            >{label}</button>
          ))}
        </div>
      )}

      {ackable.length >= 2 && (
        <div data-cms-k-bulk className="space-y-2.5 rounded-v2-control border border-dashed p-3">
          <p className="text-[13px] font-semibold">Xác nhận nhiều dòng</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={busy || visibleAckable.length === 0} data-cms-k-select-all onClick={() => onDrafts(cmsKBulkCheck(visible, drafts, true))} className="h-[44px] md:h-[36px]">
              Chọn tất cả {visibleAckable.length} dòng có thể xác nhận
            </Button>
            <Button type="button" variant="ghost" disabled={busy || selected.length === 0} data-cms-k-select-none onClick={() => onDrafts(cmsKBulkCheck(visible, drafts, false))} className="h-[44px] md:h-[36px]">
              Bỏ chọn tất cả
            </Button>
          </div>
          <p data-cms-k-selected={selected.length} className="text-[12px] text-muted-foreground break-words">
            Đã chọn <b className="text-foreground tabular-nums">{selected.length}</b> / {visibleAckable.length}
            {selected.length > 0 && <>: <span className="tabular-nums">{selected.map((x) => x.productId).join(', ')}</span></>}
          </p>
          {excluded.length > 0 && (
            <p data-cms-k-excluded className="text-[12px] text-muted-foreground">
              Không chọn được: {excluded.map((e) => `${e.n} ${EXCLUDED_LABEL(e.status)}`).join(' · ')}
            </p>
          )}
          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
            <input
              type="text" maxLength={CMS_K_ACK_SOURCE_MAX_CLIENT} value={bulkSource} disabled={busy} data-cms-k-bulk-source
              aria-label="Nguồn căn cứ chung cho các dòng đã chọn" placeholder="Nguồn căn cứ chung (chỉ khi cùng chứng minh K cho mọi dòng đã chọn)"
              onChange={(e) => { setBulkSource(e.target.value); setBulkConfirmedFp(null) }}
              className="h-[44px] w-full min-w-0 rounded-v2-control border border-input bg-background px-3 text-[16px] md:text-sm disabled:opacity-50"
            />
            <Button type="button" variant="outline" disabled={!bulkOk} data-cms-k-bulk-apply onClick={applyBulk} className="h-[44px] md:h-[36px]">
              Áp nguồn cho {selected.length} dòng đã chọn
            </Button>
          </div>
          <label className="flex min-h-[44px] items-start gap-2 text-[13px]">
            <input
              type="checkbox" className="mt-1 h-4 w-4 shrink-0" checked={bulkConfirm} disabled={busy || selected.length === 0 || !cmsKSourceOk(bulkSource)}
              data-cms-k-bulk-confirm onChange={(e) => setBulkConfirmedFp(e.target.checked ? bulkFp : null)}
            />
            <span>Nguồn này chứng minh K cho cả <b className="tabular-nums">{selected.length}</b> sản phẩm đã chọn (tôi đã soát đơn vị và K từng dòng). Áp sẽ ghi đè nguồn đang nhập ở các dòng đó.</span>
          </label>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">Không có sản phẩm đọc được để kiểm K.</p>
      ) : (
        <div data-cms-kcheck-table role="table" aria-label="Kết quả kiểm K từng sản phẩm" className="overflow-hidden rounded-v2-panel border text-[13px]">
          <div role="row" className={cn('hidden bg-muted/50 px-4 py-2 text-[12px] font-medium text-muted-foreground', COLS)}>
            <span role="columnheader">ProductID</span>
            <span role="columnheader">Kết quả</span>
            <span role="columnheader">Xác nhận tay</span>
            <span role="columnheader">Đơn vị · K</span>
            <span role="columnheader">Chi tiết</span>
          </div>
          <ul role="rowgroup" className="divide-y">
            {visible.map((x) => {
              const key = cmsKAckKey(x)
              const v = cmsKView(x)
              const d = cmsKDraftOf(drafts, x)
              const can = cmsKAckable(x)
              const pend = can && d.checked ? (cmsKSourceOk(d.source) ? 'ready' : 'incomplete') : undefined
              const other = can && otherErrorIds?.has(x.productId)
              return (
                <li
                  key={key} role="row" data-cms-k-row={x.productId} data-cms-k-status={x.status} data-cms-k-ack={x.ack ? 'yes' : undefined} data-cms-k-pending={pend}
                  className={cn('grid gap-2 px-4 py-3 lg:items-start', COLS, pend && 'bg-status-warning-bg')}
                >
                  <div role="cell" className="flex items-center justify-between gap-2 lg:block">
                    <span className="font-semibold tabular-nums lg:font-normal">{x.productId}</span>
                    <span className="lg:hidden"><StatusBadge tone={v.tone} size="sm">{v.label}</StatusBadge></span>
                  </div>
                  <div role="cell" className="hidden lg:block"><StatusBadge tone={v.tone} size="sm">{v.label}</StatusBadge></div>
                  <div role="cell" className="min-w-0">
                    {x.ack ? (
                      <span data-cms-k-ack-info className="block text-[12px] text-muted-foreground break-words">Nguồn: {x.ack.source} · {cmsDateTime(x.ack.at)}</span>
                    ) : can ? (
                      <div className="flex min-w-0 flex-col gap-1.5">
                        <label className="inline-flex min-h-[44px] items-center gap-2">
                          <input type="checkbox" className="h-4 w-4 shrink-0" checked={d.checked} disabled={busy} onChange={(e) => setOne(key, { ...d, checked: e.target.checked })} />
                          <span>Tôi xác nhận K = <b className="tabular-nums">{x.k}</b> {x.unit}</span>
                        </label>
                        <input
                          type="text" maxLength={CMS_K_ACK_SOURCE_MAX_CLIENT} value={d.source} disabled={busy || !d.checked} aria-label={`Nguồn căn cứ K của ${x.productId}`}
                          placeholder="Nguồn căn cứ (vd. quy cách NCC)" onChange={(e) => setOne(key, { ...d, source: e.target.value })}
                          className="h-[44px] w-full min-w-0 rounded-v2-control border border-input bg-background px-3 text-[16px] md:text-sm disabled:opacity-50"
                        />
                        {pend === 'ready' && <span data-cms-k-pending-note className="text-[12px] text-status-warning">Chưa gửi — bấm “Kiểm tra lại với xác nhận”.</span>}
                        {pend === 'incomplete' && <span data-cms-k-pending-note className="text-[12px] text-status-warning">Nhập nguồn căn cứ (≥ 3 ký tự) hoặc bỏ tick.</span>}
                        {other && <span data-cms-k-other-errors className="text-[12px] text-status-danger">Dòng còn lỗi khác trong file (xem tab Lỗi) — xác nhận K chưa đủ để ghi.</span>}
                      </div>
                    ) : <span className="hidden text-muted-foreground lg:inline">—</span>}
                  </div>
                  <div role="cell" className="tabular-nums">
                    <span className="text-muted-foreground lg:hidden">Đơn vị · K: </span>{x.unit || '—'} · {x.k ?? '—'}
                  </div>
                  <div role="cell" className="min-w-0 text-muted-foreground break-words">
                    {x.note}
                    {x.proposedK && <span data-cms-k-proposed className="block text-foreground">Đề xuất K = <b className="tabular-nums">{x.proposedK}</b> — nhập vào base_quantity_CMS nếu đúng, rồi kiểm tra lại.</span>}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}
      {(ackable.length > 0 || !kCheck.available) && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[12px] text-muted-foreground">
            Xác nhận lưu tên bạn và thời điểm cùng lần kiểm file; chỉ áp đúng sản phẩm / đơn vị / K trong file. LỆCH / NGUỒN LỖI không xác nhận tay được.
            {pending.incomplete.length > 0 && <span data-cms-k-incomplete={pending.incomplete.length} className="block text-status-warning">{pending.incomplete.length} dòng đã tick chưa có nguồn căn cứ — nhập nguồn hoặc bỏ tick để kiểm tra lại.</span>}
          </p>
          <Button type="button" variant="outline" disabled={busy || !canRecheck} onClick={onRecheck} data-cms-k-recheck className="h-[44px] md:h-[36px] shrink-0">
            {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {kCheck.available || pending.ready.length > 0 ? `Kiểm tra lại với xác nhận (${pending.ready.length})` : 'Kiểm tra lại'}
          </Button>
        </div>
      )}
    </section>
  )
}
