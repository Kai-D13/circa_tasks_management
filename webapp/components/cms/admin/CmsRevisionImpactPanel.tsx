'use client'

import { useState } from 'react'
import { DataTableShell } from '@/components/ds/DataTableShell'
import { Notice } from '@/components/ds/Notice'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cmsDate, cmsDateTime, cmsVnd } from '@/lib/cms/display'
import type { CmsRevisionImpact, CmsRevisionSourceIdentity } from '@/lib/cms/revision/impact'
import { cmsRevisionImpactLabel, cmsRevisionPublishedView } from '@/lib/cms/revision/model'
import { cmsDeltaSign, cmsDeltaVnd } from '@/lib/cms/revision/view'

// F-A (spec §2.5) — dự toán tác động: trước / sau tính trên CÙNG một lần đọc nguồn + mapping ghim (delta = do cấu hình); số đang công
// bố hiện RIÊNG kèm run / mốc (khác "trước sửa" vì nguồn mới hơn). Lỗi nguồn / HOLD ⇒ không có số (không 0 giả), nút ghi khoá.
const PERSONS_PREVIEW = 20
const deltaTone = (v: string) => (cmsDeltaSign(v) === 'down' ? 'text-status-danger' : cmsDeltaSign(v) === 'up' ? 'text-status-success' : 'text-muted-foreground')

export function CmsRevisionImpactPanel({ impact, source, names = {}, publishedAt }: {
  impact: CmsRevisionImpact
  source: CmsRevisionSourceIdentity | null
  names?: Record<string, string>
  /** Mốc công bố của run đang hiển thị (nếu có). */
  publishedAt?: string | null
}) {
  const [all, setAll] = useState(false)
  if (impact.status !== 'ok' || !impact.totals) {
    return (
      <Notice tone="danger" role="alert" title="Không có dự toán tác động hợp lệ">
        <span data-cms-rev-impact="error" data-code={impact.code ?? ''}>{cmsRevisionImpactLabel(impact.code)}. Không ghi được sửa đổi cho tới khi dự toán tính được — thử lại sau khi nguồn ổn định.</span>
      </Notice>
    )
  }
  const t = impact.totals
  // r3 (P1-03): nhãn + mốc theo CHÍNH run mà dự toán đã đọc (không theo header trang, vốn bị che sau sửa).
  const pub = cmsRevisionPublishedView(t)
  const pubAt = t.published_at ?? publishedAt ?? null
  const persons = all ? impact.persons : impact.persons.slice(0, PERSONS_PREVIEW)
  return (
    <section data-cms-rev-impact="ok" aria-labelledby="cms-rev-impact-title" className="space-y-3 rounded-v2-panel border bg-card p-3 md:p-4">
      <div className="space-y-1">
        <h3 id="cms-rev-impact-title" className="text-[14px] font-semibold">Dự toán tác động (tính lại cả kỳ)</h3>
        {impact.path === 'not_started' ? (
          <p className="text-[13px] text-muted-foreground">Chương trình chưa bắt đầu / còn nháp — chưa có số CMS nào bị ảnh hưởng.</p>
        ) : (
          <p className="text-[13px] text-muted-foreground">
            Trước và sau sửa tính trên <b>cùng một lần đọc nguồn</b>
            {source && <> ({source.rows_read ?? '—'} dòng, {source.product_ids} sản phẩm, kỳ {cmsDate(source.from_date)} – {cmsDate(source.to_date)})</>}
            {' '}lúc {cmsDateTime(impact.computed_at)} — chênh lệch chỉ do thay đổi cấu hình. Số chính thức có sau lượt đồng bộ kế tiếp.
          </p>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <div className="rounded-v2-control border p-2.5">
          <dt className="text-[12px] text-muted-foreground">Theo cấu hình hiện hành</dt>
          <dd className="text-[18px] font-semibold tabular-nums" data-cms-rev-before>{cmsVnd(t.before_vnd)}</dd>
        </div>
        <div className="rounded-v2-control border p-2.5">
          <dt className="text-[12px] text-muted-foreground">Theo cấu hình sau sửa</dt>
          <dd className="text-[18px] font-semibold tabular-nums" data-cms-rev-after>{cmsVnd(t.after_vnd)}</dd>
        </div>
        <div className="rounded-v2-control border p-2.5">
          <dt className="text-[12px] text-muted-foreground">Chênh lệch</dt>
          <dd className={`text-[18px] font-semibold tabular-nums ${deltaTone(t.delta_vnd)}`} data-cms-rev-delta>{cmsDeltaVnd(t.delta_vnd)}</dd>
        </div>
        <div className="rounded-v2-control border p-2.5">
          <dt className="text-[12px] text-muted-foreground">Dược sĩ tăng / giảm / không đổi</dt>
          <dd className="text-[18px] font-semibold tabular-nums">
            <span className="text-status-success">{t.up}</span> / <span className="text-status-danger">{t.down}</span> / <span className="text-muted-foreground">{t.same}</span>
          </dd>
        </div>
      </dl>
      <p data-cms-rev-published={pub.kind} className="text-[13px] text-muted-foreground">
        {pub.kind === 'current' && (
          <>Đang công bố (riêng, không dùng để tính chênh lệch): <b className="text-foreground tabular-nums">{cmsVnd(t.published_vnd)}</b>{pubAt ? <> — mốc {cmsDateTime(pubAt)}</> : null}. Sau khi ghi, số này chỉ còn xem trong Lịch sử sửa (bản trước sửa có mốc).</>
        )}
        {pub.kind === 'prior' && (
          <>{pub.label}{pubAt ? <> (mốc {cmsDateTime(pubAt)})</> : null}: <b className="text-foreground tabular-nums">{cmsVnd(t.published_vnd)}</b> — đang bị che vì cấu hình đã sửa sau mốc này và chưa có lượt tính lại; chỉ để tham khảo, không dùng để tính chênh lệch.</>
        )}
        {pub.kind === 'none' && <>{pub.label} — chưa có số đã công bố.</>}
        {' '}Sản phẩm được tính: {t.products_before} → {t.products_after}.
      </p>
      {impact.persons.length > 0 && (
        <div className="space-y-2">
          <p className="text-[13px] font-semibold">Theo dược sĩ (giảm nhiều nhất trước)</p>
          <DataTableShell>
            <Table className="min-w-[560px] text-[13px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Dược sĩ</TableHead>
                  <TableHead className="text-right">{pub.column}</TableHead>
                  <TableHead className="text-right">Trước sửa</TableHead>
                  <TableHead className="text-right">Sau sửa</TableHead>
                  <TableHead className="pr-4 text-right">Chênh lệch</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {persons.map((p) => (
                  <TableRow key={p.user_id} data-cms-rev-person={cmsDeltaSign(p.delta_vnd)}>
                    <TableCell className="pl-4 max-w-[220px] truncate">{names[p.user_id] ?? `Dược sĩ ${p.user_id.slice(0, 8)}`}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{cmsVnd(p.published_vnd)}</TableCell>
                    <TableCell className="text-right tabular-nums">{cmsVnd(p.before_vnd)}</TableCell>
                    <TableCell className="text-right tabular-nums">{cmsVnd(p.after_vnd)}</TableCell>
                    <TableCell className={`pr-4 text-right tabular-nums font-semibold ${deltaTone(p.delta_vnd)}`}>{cmsDeltaVnd(p.delta_vnd)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </DataTableShell>
          <div className="flex flex-wrap items-center gap-2">
            {impact.persons.length > PERSONS_PREVIEW && (
              <Button type="button" variant="ghost" onClick={() => setAll((v) => !v)} aria-expanded={all} className="h-[44px] md:h-[36px] text-[13px]">
                {all ? 'Thu gọn' : `Xem đủ ${impact.persons.length} dược sĩ`}
              </Button>
            )}
            {impact.truncated.persons && <StatusBadge tone="info">Danh sách cắt ở {impact.persons.length} người — tổng vẫn đủ</StatusBadge>}
          </div>
        </div>
      )}
    </section>
  )
}
