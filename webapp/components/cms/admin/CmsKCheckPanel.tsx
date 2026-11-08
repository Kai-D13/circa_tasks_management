'use client'

import { Loader2, ShieldCheck } from 'lucide-react'
import { Notice } from '@/components/ds/Notice'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { Button } from '@/components/ui/button'
import { cmsDateTime } from '@/lib/cms/display'
import { cmsKAckable, cmsKView, type CmsPreviewKCheck } from '@/lib/cms/importView'

// CMS S2 (PM spec r1 08/11 §5.1) — bảng kiểm K của lần kiểm file (chỉ super; route import đã chặn vai khác). Trình bày trạng thái từ
// server; KHÔNG tự điền K, không tự khẳng định "đã kiểm". Xác nhận tay chỉ cho SP CHƯA CÓ BẰNG CHỨNG / KHÔNG KIỂM ĐƯỢC có K: chọn +
// nhập nguồn căn cứ ⇒ "Kiểm tra lại với xác nhận" gửi lại preview kèm ý định; server gắn tên người xác nhận (phiên) + thời điểm và
// lưu trong lần kiểm. LỆCH / NGUỒN LỖI / NGUỒN XUNG ĐỘT không có ô xác nhận.

export type CmsKAckDraft = Record<string, { checked: boolean; source: string }>

export function CmsKCheckPanel({ kCheck, drafts, onDraft, onRecheck, busy }: {
  kCheck: CmsPreviewKCheck
  drafts: CmsKAckDraft
  onDraft: (productId: string, d: { checked: boolean; source: string }) => void
  onRecheck: () => void
  busy: boolean
}) {
  const rows = kCheck.products
  const ready = rows.filter((x) => cmsKAckable(x) && drafts[x.productId]?.checked && (drafts[x.productId]?.source.trim().length ?? 0) >= 3)
  const anyAckable = rows.some(cmsKAckable)
  return (
    <section data-cms-kcheck={kCheck.available ? 'ok' : 'unavailable'} className="space-y-3 rounded-v2-panel border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 text-[14px] font-semibold"><ShieldCheck aria-hidden="true" className="h-4 w-4" />Kiểm quy đổi đơn vị (K) theo dữ liệu bán</h2>
        <span className="text-[12px] text-muted-foreground">{kCheck.available ? `Dữ liệu đọc lúc ${cmsDateTime(kCheck.asOf)}` : 'Không đọc được dữ liệu bán'}</span>
      </div>
      {!kCheck.available && (
        <Notice tone="warning" role="status">Chưa kiểm được K — sản phẩm chỉ ghi được khi có xác nhận tay kèm nguồn căn cứ, hoặc kiểm tra lại sau.</Notice>
      )}
      {rows.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">Không có sản phẩm đọc được để kiểm K.</p>
      ) : (
        <div className="overflow-hidden rounded-v2-panel border">
          <div className="overflow-x-auto">
            <table data-cms-kcheck-table className="w-full min-w-[760px] text-[13px]">
              <thead className="bg-muted/50 text-[12px] text-muted-foreground">
                <tr className="text-left whitespace-nowrap">
                  <th className="pl-4 pr-3 py-2 font-medium">ProductID</th>
                  <th className="px-3 py-2 font-medium">Đơn vị</th>
                  <th className="px-3 py-2 font-medium">K trong file</th>
                  <th className="px-3 py-2 font-medium">Kết quả</th>
                  <th className="px-3 py-2 font-medium">Chi tiết</th>
                  <th className="pl-3 pr-4 py-2 font-medium">Xác nhận tay</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((x) => {
                  const v = cmsKView(x)
                  const d = drafts[x.productId] ?? { checked: false, source: '' }
                  return (
                    <tr key={x.productId} data-cms-k-row={x.productId} data-cms-k-status={x.status} data-cms-k-ack={x.ack ? 'yes' : undefined} className="border-t align-top">
                      <td className="pl-4 pr-3 py-3 tabular-nums">{x.productId}</td>
                      <td className="px-3 py-3">{x.unit || '—'}</td>
                      <td className="px-3 py-3 tabular-nums">{x.k ?? '—'}</td>
                      <td className="px-3 py-3"><StatusBadge tone={v.tone} size="sm">{v.label}</StatusBadge></td>
                      <td className="px-3 py-3 text-muted-foreground break-words">
                        {x.note}
                        {x.proposedK && <span data-cms-k-proposed className="block text-foreground">Đề xuất K = <b className="tabular-nums">{x.proposedK}</b> — nhập vào base_quantity_CMS nếu đúng, rồi kiểm tra lại.</span>}
                      </td>
                      <td className="pl-3 pr-4 py-3">
                        {x.ack ? (
                          <span data-cms-k-ack-info className="block text-[12px] text-muted-foreground break-words">Nguồn: {x.ack.source} · {cmsDateTime(x.ack.at)}</span>
                        ) : cmsKAckable(x) ? (
                          <div className="flex min-w-[220px] flex-col gap-1.5">
                            <label className="inline-flex min-h-[44px] items-center gap-2">
                              <input type="checkbox" className="h-4 w-4" checked={d.checked} onChange={(e) => onDraft(x.productId, { ...d, checked: e.target.checked })} />
                              <span>Tôi xác nhận K = {x.k} {x.unit}</span>
                            </label>
                            <input
                              type="text" maxLength={200} value={d.source} disabled={!d.checked} aria-label={`Nguồn căn cứ K của ${x.productId}`}
                              placeholder="Nguồn căn cứ (vd. quy cách NCC)" onChange={(e) => onDraft(x.productId, { ...d, source: e.target.value })}
                              className="h-[44px] rounded-v2-control border border-input bg-background px-3 text-[16px] md:text-sm disabled:opacity-50"
                            />
                          </div>
                        ) : <span className="text-muted-foreground">—</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {anyAckable && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[12px] text-muted-foreground">Xác nhận lưu tên bạn và thời điểm cùng lần kiểm file; chỉ áp đúng sản phẩm / đơn vị / K trong file. LỆCH / NGUỒN LỖI không xác nhận tay được.</p>
          <Button type="button" variant="outline" disabled={busy || ready.length === 0} onClick={onRecheck} data-cms-k-recheck className="h-[44px] md:h-[36px] shrink-0">
            {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}Kiểm tra lại với xác nhận ({ready.length})
          </Button>
        </div>
      )}
    </section>
  )
}
