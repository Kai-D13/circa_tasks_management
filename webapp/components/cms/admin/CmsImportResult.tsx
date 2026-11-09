'use client'

import { useState } from 'react'
import { AlertTriangle, Download } from 'lucide-react'
import { Notice } from '@/components/ds/Notice'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { TagBadge } from '@/components/ds/TagBadge'
import { CmsProductImage } from '@/components/cms/CmsProductImage'
import { CmsTierChips } from '@/components/cms/CmsTierChips'
import { CmsDownloadLink } from '@/components/cms/CmsDownloadLink'
import { cn } from '@/lib/utils'
import { CMS_GATE_HUE, CMS_GATE_LABEL, cmsBaseQtyLine, cmsPrice, cmsVnd } from '@/lib/cms/display'
import { cmsSimpleSummary, type CmsPreviewResult } from '@/lib/cms/importView'
import { cmsImportColumnLabel } from '@/lib/cms/import/simpleColumns'
import { cmsFlatRate, cmsFlatRateText } from '@/lib/cms/flat'

// CMS P1-c — bước "Kết quả" A2 (UI §3.2 bước 4; r2 U5 / U16): 4 ô, tab hợp lệ / lỗi & cảnh báo, file dòng lỗi, thông
// báo nội dung sau điểm dừng. Chỉ trình bày kết quả kiểm tra (preview) — không ghi gì. Link file lỗi là GET export ⇒
// trong fixture là nút bị chặn (CmsDownloadLink — không có href endpoint thật).

function Box({ label, value, tone }: { label: string; value: number; tone: 'neutral' | 'success' | 'danger' | 'warning' }) {
  const dot = { neutral: 'bg-muted-foreground', success: 'bg-status-success', danger: 'bg-status-danger', warning: 'bg-status-warning' }[tone]
  return (
    <div className="rounded-v2-panel border bg-card px-4 py-3">
      <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', dot)} />{label}
      </span>
      <span className="text-[22px] font-bold tabular-nums">{value}</span>
    </div>
  )
}

export function CmsImportResult({ result }: { result: CmsPreviewResult }) {
  const [tab, setTab] = useState<'ok' | 'errors'>(result.groupsOk.length > 0 ? 'ok' : 'errors')
  const s = result.stats
  const errorRows = result.groupsRejected.flatMap((g) => g.errors.map((e) => ({ ...e, key: g.key })))
  const warnCount = result.groupsOk.reduce((n, g) => n + g.warnings.length, 0)
  return (
    <div data-cms-import-result className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <Box label="Tổng dòng" value={s.rowsTotal} tone="neutral" />
        <Box label="Hợp lệ" value={s.rowsOk} tone="success" />
        <Box label="Lỗi (đã loại)" value={s.rowsRejected} tone="danger" />
        <Box label="Cảnh báo" value={s.warnings} tone="warning" />
      </div>
      {result.format === 'simple' && (
        <Notice tone="info" role="status">
          <span data-cms-simple-summary>{cmsSimpleSummary(result.groupsOk.length + result.groupsRejected.length)}</span>
          {result.supplement && (!result.supplement.baseQuantity || !result.supplement.advice) && (
            <span data-cms-simple-missing className="mt-1 block">File chưa có cột {[!result.supplement.baseQuantity && 'base_quantity_CMS', !result.supplement.advice && 'Noi_dung_tu_van'].filter(Boolean).join(' và ')} — đọc được nhưng chưa ghi được; thêm cột rồi kiểm tra lại.</span>
          )}
        </Notice>
      )}
      {result.quantityBasis === 'cms_unit' && (
        <Notice tone="info" role="status">
          <span data-cms-preview-basis="cms_unit">Cách tính số lượng của chương trình: <b>Theo ĐV tính CMS</b> — chỉ đơn bán đúng ĐV khai ở cột unit_CMS được tính CMS; K chỉ để kiểm chéo với POS.</span>
        </Notice>
      )}
      {result.ignoredFromRow !== null && (
        <Notice tone="warning" icon={AlertTriangle}>Nội dung từ dòng {result.ignoredFromRow} trở đi không được nhập (sau dòng ProductID trống đầu tiên).</Notice>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label="Kết quả kiểm tra" className="flex w-fit max-w-full gap-1 rounded-v2-control bg-muted p-1">
          {([['ok', `Sản phẩm hợp lệ (${result.groupsOk.length})`], ['errors', `Lỗi & cảnh báo (${result.groupsRejected.length + warnCount})`]] as const).map(([k, label]) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={cn(
                'min-h-[44px] md:min-h-0 md:h-[30px] whitespace-nowrap rounded-[8px] px-3 text-[13px]',
                tab === k ? 'bg-card font-semibold text-foreground border border-input' : 'text-muted-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {result.groupsRejected.length > 0 && (
          <CmsDownloadLink
            href={`/api/cms/import/errors?run_id=${encodeURIComponent(result.runId)}`}
            data-cms-import-error-file
            className="inline-flex min-h-[44px] items-center gap-1.5 text-[13px] font-medium underline-offset-2 hover:underline"
          >
            <Download className="h-4 w-4" /> Tải file dòng lỗi (.xlsx)
          </CmsDownloadLink>
        )}
      </div>

      {tab === 'ok' ? (
        result.groupsOk.length === 0 ? (
          <p className="rounded-v2-panel border border-dashed bg-card p-6 text-center text-[13px] text-muted-foreground">Không có sản phẩm hợp lệ trong file.</p>
        ) : (
          <ul data-cms-preview-ok className="divide-y rounded-v2-panel border bg-card">
            {result.groupsOk.map((g) => (
              <li key={g.productId} className="grid gap-3 p-3 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.4fr)] md:p-4">
                <div className="flex min-w-0 gap-3">
                  <CmsProductImage url={g.imageUrlSnapshot} name={g.nameSnapshot} size={44} />
                  <div className="min-w-0 space-y-0.5">
                    <p className="font-semibold leading-snug line-clamp-2 break-words">{g.nameSnapshot}</p>
                    <p className="text-[12px] text-muted-foreground tabular-nums">{g.productId}{g.priceSnapshot ? ` · ${cmsPrice(g.priceSnapshot)}` : ''}</p>
                    {g.warnings.map((w, i) => <p key={i} className="text-[12px] text-status-warning">{w.message}</p>)}
                  </div>
                </div>
                <div className="space-y-1 text-[13px]">
                  <TagBadge hue={CMS_GATE_HUE[g.gmvBasis]}>{CMS_GATE_LABEL[g.gmvBasis]}</TagBadge>
                  {g.gmvBasis === 'product' && <p className="text-muted-foreground">Target {cmsVnd(g.targetGmv)}</p>}
                  {g.gmvBasis === 'catalog' && <p className="text-muted-foreground">Target danh mục {cmsVnd(result.catalogTarget)}</p>}
                  <p className="text-muted-foreground">{cmsBaseQtyLine(g.unitCms, g.baseQuantityCms)}</p>
                </div>
                <div className="space-y-1.5">
                  {(() => { const rate = cmsFlatRate(g); return rate ? <p data-cms-preview-flat className="text-[13px] font-semibold tabular-nums">{cmsFlatRateText(rate, g.unitCms)}</p> : <CmsTierChips tiers={g.tiers} unit={g.unitCms} /> })()}
                  <p className="text-[12px] text-muted-foreground line-clamp-2 whitespace-pre-line break-words">{g.advicePreview}</p>
                  <p className="text-[12px] text-muted-foreground tabular-nums">Dòng Excel {g.excelRows.join(', ')}</p>
                </div>
              </li>
            ))}
          </ul>
        )
      ) : (
        <div className="overflow-hidden rounded-v2-panel border bg-card">
          <div className="overflow-x-auto">
            <table data-cms-preview-errors className="w-full min-w-[720px] text-[13px]">
              <thead className="bg-muted">
                <tr className="text-left whitespace-nowrap">
                  <th className="pl-4 pr-3 py-2.5 text-[12px] font-medium text-muted-foreground">Dòng Excel</th>
                  <th className="px-3 py-2.5 text-[12px] font-medium text-muted-foreground">ProductID</th>
                  <th className="px-3 py-2.5 text-[12px] font-medium text-muted-foreground">Cột</th>
                  <th className="px-3 py-2.5 text-[12px] font-medium text-muted-foreground">Lỗi</th>
                  <th className="pl-3 pr-4 py-2.5 text-[12px] font-medium text-muted-foreground">Cách sửa</th>
                </tr>
              </thead>
              <tbody>
                {errorRows.map((e, i) => (
                  <tr key={`e${i}`} className="border-t align-top">
                    <td className="pl-4 pr-3 py-2.5 tabular-nums">{e.excelRow ?? '—'}</td>
                    <td className="px-3 py-2.5 tabular-nums break-all">{e.key.startsWith('raw:') ? e.key.slice(4) || '—' : e.key}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap">{cmsImportColumnLabel(e.column, result.format) ?? '—'}</td>
                    <td className="px-3 py-2.5"><span className="inline-flex flex-wrap items-center gap-1.5"><StatusBadge tone="danger">Lỗi · đã loại</StatusBadge>{e.message}</span></td>
                    <td className="pl-3 pr-4 py-2.5 text-muted-foreground">{e.fix}</td>
                  </tr>
                ))}
                {result.groupsOk.flatMap((g) => g.warnings.map((w, i) => (
                  <tr key={`w${g.productId}-${i}`} className="border-t align-top">
                    <td className="pl-4 pr-3 py-2.5 tabular-nums">{w.excelRow ?? '—'}</td>
                    <td className="px-3 py-2.5 tabular-nums">{g.productId}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap">{cmsImportColumnLabel(w.column, result.format) ?? '—'}</td>
                    <td className="px-3 py-2.5"><span className="inline-flex flex-wrap items-center gap-1.5"><StatusBadge tone="warning">Cảnh báo · vẫn nạp</StatusBadge>{w.message}</span></td>
                    <td className="pl-3 pr-4 py-2.5 text-muted-foreground">{w.fix}</td>
                  </tr>
                )))}
                {errorRows.length === 0 && warnCount === 0 && (
                  <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">Không có lỗi hay cảnh báo.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
