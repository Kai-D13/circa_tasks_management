import Link from 'next/link'
import { ArrowLeft, History } from 'lucide-react'
import { DataTableShell } from '@/components/ds/DataTableShell'
import { EmptyState } from '@/components/ds/EmptyState'
import { ErrorState } from '@/components/ds/ErrorState'
import { Notice } from '@/components/ds/Notice'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { buttonVariants } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { CmsRevisionDiffTable } from '@/components/cms/admin/CmsRevisionDiffTable'
import { cn } from '@/lib/utils'
import { cmsDate, cmsDateTime, cmsDecimal, cmsVnd } from '@/lib/cms/display'
import type { CmsRevisionArchivePage, CmsRevisionDetail, CmsRevisionListItem } from '@/lib/cms/revision/history'
import { cmsRevisionImpactLabel } from '@/lib/cms/revision/model'
import { cmsDeltaVnd, cmsRevisionTiersText } from '@/lib/cms/revision/view'

// F-A (spec §2.8) — lịch sử sửa (super): danh sách revision đã ghi, chi tiết (lý do, diff, dự toán, nguồn ghim) và SỐ TRƯỚC SỬA có
// mốc — đọc từ archive bất biến với K / đơn vị / bậc CỦA CHÍNH run đó (không ghép K mới với Q / tiền cũ). Không có nút xoá / hoàn tác:
// muốn quay cấu hình cũ ⇒ sửa bù qua cùng luồng xác nhận.
type R<T> = { ok: true; data: T } | { ok: false; code: string }

const CONFIG_BASIS_LABEL = { exact: 'Đúng cấu hình run', unchanged_since_run: 'K / bậc không đổi từ run', unknown: 'Không còn cấu hình của run' } as const

export function CmsRevisionHistory({ program, list, selected, archive, page, pageSize }: {
  program: { id: string; name: string }
  list: R<CmsRevisionListItem[]>
  selected: R<CmsRevisionDetail> | null
  archive: R<CmsRevisionArchivePage> | null
  page: number
  pageSize: number
}) {
  const base = `/targets/campaigns/cms/${program.id}/revisions`
  return (
    <div data-ui-v2="page" data-layout-width="fluid" data-cms-revisions className="p-4 md:p-6 space-y-4 md:space-y-[18px]">
      <Link href={`/targets/campaigns/cms/${program.id}`} className="inline-flex min-h-[44px] items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Chi tiết chương trình
      </Link>
      <div className="space-y-1">
        <h1 className="text-[20px] md:text-[22px] font-bold leading-tight">Lịch sử sửa chương trình</h1>
        <p className="text-[13px] text-muted-foreground break-words">{program.name}</p>
      </div>
      {!list.ok ? (
        <ErrorState message="Không tải được lịch sử sửa" hint="Thử tải lại trang." />
      ) : list.data.length === 0 ? (
        <EmptyState className="py-10 rounded-v2-panel border border-dashed border-input bg-card" icon={History} title="Chưa có lần sửa nào" />
      ) : (
        <DataTableShell>
          <Table data-cms-revision-list className="min-w-[760px] text-[13px]">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Thời điểm</TableHead>
                <TableHead>Cấu hình</TableHead>
                <TableHead>Người sửa · lý do</TableHead>
                <TableHead>Thay đổi</TableHead>
                <TableHead className="text-right">Dự toán chênh lệch</TableHead>
                <TableHead className="pr-4 text-right">Chi tiết</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.map((r) => (
                <TableRow key={r.id} aria-current={selected?.ok && selected.data.id === r.id ? 'true' : undefined} className="align-top">
                  <TableCell className="pl-4 tabular-nums whitespace-nowrap">{cmsDateTime(r.committedAt)}</TableCell>
                  <TableCell className="tabular-nums whitespace-nowrap">v{r.fromConfigVersion} → v{r.toConfigVersion}</TableCell>
                  <TableCell className="max-w-[320px] whitespace-normal">
                    <div className="font-medium">{r.committedByName ?? '—'}</div>
                    <div className="line-clamp-2 break-words text-muted-foreground">{r.reason}</div>
                  </TableCell>
                  <TableCell className="whitespace-normal tabular-nums">
                    {[r.counts.add && `+${r.counts.add}`, r.counts.readd && `↺${r.counts.readd}`, r.counts.change && `~${r.counts.change}`, r.counts.remove && `−${r.counts.remove}`].filter(Boolean).join(' · ') || '—'}
                    <span className="text-muted-foreground"> · còn {r.counts.productsAfter} SP</span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.impact ? cmsDeltaVnd(r.impact.deltaVnd) : '—'}</TableCell>
                  <TableCell className="pr-4 text-right">
                    <Link href={`${base}?r=${r.id}`} className={cn(buttonVariants({ variant: 'outline' }), 'h-[44px] md:h-[32px] text-[13px]')}>Xem</Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DataTableShell>
      )}

      {selected && !selected.ok && <ErrorState message="Không tải được chi tiết lần sửa" hint="Thử tải lại trang." />}
      {selected?.ok && <Detail d={selected.data} archive={archive} page={page} pageSize={pageSize} base={base} />}
    </div>
  )
}

function Detail({ d, archive, page, pageSize, base }: { d: CmsRevisionDetail; archive: R<CmsRevisionArchivePage> | null; page: number; pageSize: number; base: string }) {
  const t = d.impact.totals
  return (
    <section data-cms-revision-detail={d.id} aria-labelledby="cms-rev-detail-title" className="space-y-4">
      <div className="space-y-1.5 rounded-v2-panel border bg-card p-3 md:p-4">
        <h2 id="cms-rev-detail-title" className="text-[16px] font-semibold">Lần sửa v{d.fromConfigVersion} → v{d.toConfigVersion}</h2>
        <p className="text-[13px] text-muted-foreground tabular-nums">{cmsDateTime(d.committedAt)} · {d.committedByName ?? '—'} · file {d.fileSha256.slice(0, 12)}…</p>
        <p className="text-[13px] whitespace-pre-wrap break-words">{d.reason}</p>
        <p className="text-[13px] text-muted-foreground">
          Dự toán lúc sửa{d.impact.computedAt ? ` (${cmsDateTime(d.impact.computedAt)})` : ''}:{' '}
          {d.impact.status === 'ok' && t
            ? <>trước {cmsVnd(t.beforeVnd)} → sau {cmsVnd(t.afterVnd)} (<b className="text-foreground">{cmsDeltaVnd(t.deltaVnd)}</b>) · tăng {t.up} / giảm {t.down} / không đổi {t.same} dược sĩ</>
            : cmsRevisionImpactLabel(d.impact.code)}
          {d.source.fromDate && d.source.toDate && <> · nguồn {d.source.rowsRead ?? '—'} dòng, kỳ {cmsDate(d.source.fromDate)} – {cmsDate(d.source.toDate)}</>}
        </p>
      </div>
      <CmsRevisionDiffTable diff={d.diff} />
      <div className="space-y-2">
        <h3 className="text-[14px] font-semibold">Số đang hiển thị trước lần sửa</h3>
        {d.archive.mode === 'none' ? (
          <Notice tone="info">Lúc sửa chưa có số đang công bố — không có bản trước sửa.</Notice>
        ) : !archive || !archive.ok ? (
          <ErrorState message="Không tải được bản số trước sửa" hint="Thử tải lại trang." />
        ) : (
          <>
            <p className="text-[13px] text-muted-foreground tabular-nums">
              Lượt cấu hình v{archive.data.runConfigVersion ?? '—'} · {archive.data.total} dòng · tổng {cmsVnd(archive.data.amountVnd)}
              {d.archive.mode === 'reused' && ' · cùng bản đã lưu ở lần sửa trước trên lượt này'}. K / đơn vị / bậc dưới đây là của chính lượt đó.
            </p>
            <DataTableShell>
              <Table data-cms-revision-archive className="min-w-[860px] text-[13px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Dược sĩ</TableHead>
                    <TableHead>Sản phẩm</TableHead>
                    <TableHead>K của lượt</TableHead>
                    <TableHead>Mức CMS của lượt</TableHead>
                    <TableHead className="text-right">SL CMS</TableHead>
                    <TableHead className="text-right">CMS</TableHead>
                    <TableHead className="pr-4">Căn cứ cấu hình</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {archive.data.rows.map((r, i) => (
                    <TableRow key={`${r.userId}:${r.productId}:${i}`} className="align-top">
                      <TableCell className="pl-4 max-w-[200px] truncate">{r.fullName ?? `Dược sĩ ${r.userId.slice(0, 8)}`}</TableCell>
                      <TableCell className="font-mono text-[12px]">{r.productId}</TableCell>
                      <TableCell className="tabular-nums">{cmsDecimal(r.perUnit)}{r.unitCms ? ` · ${r.unitCms}` : ''}</TableCell>
                      <TableCell className="max-w-[260px] whitespace-normal tabular-nums">{cmsRevisionTiersText(r.tiers, r.unitCms)}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.cmsQuantity ?? '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{cmsVnd(r.amountVnd)}</TableCell>
                      <TableCell className="pr-4"><StatusBadge tone={r.configBasis === 'unknown' ? 'warning' : 'neutral'} size="sm">{CONFIG_BASIS_LABEL[r.configBasis]}</StatusBadge></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </DataTableShell>
            {archive.data.total > pageSize && (
              <nav aria-label="Trang bản trước sửa" className="flex items-center justify-end gap-2 text-[13px]">
                {page > 1 && <Link href={`${base}?r=${d.id}&page=${page - 1}`} className={cn(buttonVariants({ variant: 'outline' }), 'h-[44px] md:h-[32px]')}>Trước</Link>}
                <span className="tabular-nums text-muted-foreground">Trang {page} / {Math.ceil(archive.data.total / pageSize)}</span>
                {page * pageSize < archive.data.total && <Link href={`${base}?r=${d.id}&page=${page + 1}`} className={cn(buttonVariants({ variant: 'outline' }), 'h-[44px] md:h-[32px]')}>Sau</Link>}
              </nav>
            )}
          </>
        )}
      </div>
    </section>
  )
}
