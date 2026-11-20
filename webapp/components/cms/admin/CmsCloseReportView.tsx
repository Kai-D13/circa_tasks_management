import Link from 'next/link'
import { ArrowLeft, Download } from 'lucide-react'
import { cmsDateTime, cmsVnd } from '@/lib/cms/display'
import { parseCmsDecimal } from '@/lib/cms/decimal'
import { cmsQtyText } from '@/lib/cms/resultUi'
import {
  CMS_CLOSE_REPORT_CONTRACT_NOTE, CMS_CLOSE_REPORT_NOTE, cmsCloseReportIsContract, cmsCloseReportProfileNote, cmsCloseReportViaLabel, type CmsCloseReportPage,
} from '@/lib/cms/returnsView'
import { cmsNavHref, type CmsNav } from '@/lib/cms/fixtureNav'
import { Notice } from '@/components/ds/Notice'
import { Panel } from '@/components/ds/Panel'
import { StatCard } from '@/components/ds/StatCard'
import { DataTableShell } from '@/components/ds/DataTableShell'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { CmsDownloadLink } from '@/components/cms/CmsDownloadLink'

// CMS-CALC-RET-2 P5.5 — chi tiết một báo cáo trả hàng sau chốt (super). Chỉ trình bày số DB đã tính (route thật đối chiếu line_count ở
// loader). Không phải lệnh thu / chi; không có thao tác ghi. Link Xuất Excel bọc guard fixture (0 request trong /ui-catalog).
// Q-236: nhãn cột lượng / GMV trừ + câu quy tắc theo returns_profile (full_line: lượng trừ theo quy ước CMS, GMV theo tiền hoàn).
// 132 r1: run CONTRACT (số chốt là số RÒNG) ⇒ câu giải thích + cột "Đã trừ lúc chốt"; người lập / lý do lập tay hiện dưới tiêu đề.
const units = (v: string) => { const r = parseCmsDecimal(v, { allowNegative: true }); return r.ok ? r.units : BigInt(0) }
const gmv = (v: string) => cmsVnd(units(v) / BigInt(1_000_000_000))

export function CmsCloseReportView({ program, products, page, nav }: {
  program: { id: string; name: string }
  /** program_product_id ⇒ tên SP. */
  products: ReadonlyMap<string, { nameSnapshot: string }>
  page: CmsCloseReportPage
  nav?: CmsNav
}) {
  const r = page.report
  const href = (h: string) => cmsNavHref(nav, h)
  const full = r.returnsProfile === 'full_line_qty_refund_v1'
  const contract = cmsCloseReportIsContract(page.lines)
  return (
    <div data-ui-v2="page" data-layout-width="fluid" data-cms-close-report-detail={r.id} className="space-y-4 p-4 md:p-6">
      <Link href={href(`/targets/campaigns/cms/${program.id}/returns`)} className="inline-flex min-h-[44px] items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Trả hàng · {program.name}
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-[20px] font-bold leading-snug">Báo cáo sau chốt · dữ liệu trả đến {cmsDateTime(r.returnsAsOf)}</h1>
        <CmsDownloadLink href={`/api/export/cms/close-report?program=${program.id}&report=${r.id}`} data-cms-close-report-xlsx
          className="inline-flex h-[44px] items-center gap-1.5 rounded-v2-control border bg-card px-4 text-[13px] font-semibold md:h-[36px]">
          <Download className="h-4 w-4" aria-hidden="true" /> Xuất Excel
        </CmsDownloadLink>
      </div>
      <Notice tone="info" role="status">{CMS_CLOSE_REPORT_NOTE}</Notice>
      <p data-cms-close-report-profile={r.returnsProfile} className="text-[13px] text-muted-foreground">{cmsCloseReportProfileNote(r.returnsProfile)}</p>
      {contract && <p data-cms-close-report-contract className="text-[13px] text-muted-foreground">{CMS_CLOSE_REPORT_CONTRACT_NOTE}</p>}
      <p data-cms-close-report-via={r.createdVia} className="text-[13px] text-muted-foreground break-words">
        Lập bởi: {cmsCloseReportViaLabel(r)}{r.manualReason ? <> · Lý do: <span className="text-foreground">{r.manualReason}</span></> : null}
      </p>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <StatCard label="CMS đã chốt" value={cmsVnd(r.frozenAmount)} />
        <StatCard label="CMS tính lại" value={cmsVnd(r.recomputedAmount)} />
        <StatCard label="Chênh lệch" value={cmsVnd(r.deltaAmount)} />
        <StatCard label="Phiếu trả áp dụng" value={r.returnEvents.toLocaleString('vi-VN')} />
      </div>
      <Panel title="Theo dược sĩ × sản phẩm" flush className="v2:rounded-v2-panel">
        <DataTableShell>
          <Table aria-label="Dòng báo cáo sau chốt">
            <TableHeader>
              <TableRow>
                <TableHead>Dược sĩ</TableHead>
                <TableHead>Sản phẩm</TableHead>
                <TableHead className="text-right">SL đã chốt</TableHead>
                {contract && <TableHead className="text-right">Đã trừ lúc chốt</TableHead>}
                <TableHead className="text-right">{full ? 'Lượng trừ (quy ước CMS)' : 'SL trả'}</TableHead>
                <TableHead className="text-right">{full ? 'GMV trừ (tiền hoàn)' : 'GMV trả'}</TableHead>
                <TableHead className="text-right">SL tính lại</TableHead>
                <TableHead className="text-right">GMV ròng</TableHead>
                <TableHead className="text-right">CMS đã chốt</TableHead>
                <TableHead className="text-right">CMS tính lại</TableHead>
                <TableHead className="text-right">Chênh lệch</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.lines.map((l) => {
                const name = products.get(l.programProductId)?.nameSnapshot ?? l.productId
                const k = units(l.perUnit)
                return (
                  <TableRow key={l.lineNo} data-cms-close-report-line={l.lineNo}>
                    <TableCell className="max-w-[160px] truncate">{l.fullName ?? '—'}</TableCell>
                    <TableCell className="max-w-[200px] truncate" title={name}>{name}</TableCell>
                    <TableCell className="text-right tabular-nums">{l.frozenQty}</TableCell>
                    {contract && (
                      <TableCell className="text-right tabular-nums" data-cms-close-report-frozen-return>
                        {l.frozenReturnBase === null ? '—' : cmsQtyText(units(l.frozenReturnBase), k)}
                        {l.frozenReturnGmv !== null && <span className="block text-[12px] text-muted-foreground">{gmv(l.frozenReturnGmv)}</span>}
                      </TableCell>
                    )}
                    <TableCell className="text-right tabular-nums">{cmsQtyText(units(l.returnBase), k)}<span className="block text-[12px] text-muted-foreground">{l.returnEvents} phiếu</span></TableCell>
                    <TableCell className="text-right tabular-nums">{gmv(l.returnGmv)}</TableCell>
                    <TableCell className="text-right tabular-nums">{l.recomputedQty}{l.gateMet ? '' : <span className="block text-[12px] text-muted-foreground">chưa đạt ĐK</span>}</TableCell>
                    <TableCell className="text-right tabular-nums">{gmv(l.netGmv)}</TableCell>
                    <TableCell className="text-right tabular-nums">{cmsVnd(l.frozenAmount)}</TableCell>
                    <TableCell className="text-right tabular-nums">{cmsVnd(l.recomputedAmount)}</TableCell>
                    <TableCell className="text-right tabular-nums font-semibold">{cmsVnd(l.delta)}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </DataTableShell>
      </Panel>
      <p className="text-[12px] text-muted-foreground tabular-nums">Lần kiểm sổ #{r.evalSeq} · digest {r.returnsDigest.slice(0, 12)}… · {r.lineCount.toLocaleString('vi-VN')} dòng</p>
    </div>
  )
}
