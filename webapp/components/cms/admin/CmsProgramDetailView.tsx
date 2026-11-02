import Link from 'next/link'
import { ArrowLeft, Pencil, Upload } from 'lucide-react'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { StatCard } from '@/components/ds/StatCard'
import { EmptyState } from '@/components/ds/EmptyState'
import { TagBadge } from '@/components/ds/TagBadge'
import { buttonVariants } from '@/components/ui/button'
import { CmsProductImage } from '@/components/cms/CmsProductImage'
import { CmsTierChips } from '@/components/cms/CmsTierChips'
import { CmsActivateButton } from '@/components/cms/admin/CmsActivateButton'
import { CmsErrorFileLink } from '@/components/cms/admin/CmsErrorFileLink'
import { cn } from '@/lib/utils'
import { CMS_GATE_HUE, CMS_GATE_LABEL, cmsBaseQtyLine, cmsDate, cmsDateRange, cmsDateTime, cmsPrice, cmsVnd } from '@/lib/cms/display'
import {
  CMS_STATUS_LABEL, CMS_STATUS_TONE, cmsDaysLeft, cmsDisplayStatus, cmsProgramActions,
} from '@/lib/cms/programStatus'
import type { CmsProgramDetail } from '@/lib/cms/server/catalog'

// CMS P1-c · A3 /targets/campaigns/cms/[id] (UI §3.3; r2 U1 / U6 / U8 / U17). P1: CHỈ cấu hình — số SP, target, bậc,
// mức CMS / đơn vị, quy cách, phạm vi, lịch sử import. KHÔNG có ô / cột kết quả thực tế (CMS tạm tính, GMV / SL bán,
// lượt đạt…), không Xuất Excel / Chốt kỳ (P2 / P3). Nút quản trị theo SPEC §4.7, chỉ super; SM chỉ đọc.

const BTN = 'h-[44px] md:h-[36px] gap-1.5 text-[13px]'

export function CmsProgramDetailView({ detail, today, canManage, view }: {
  detail: CmsProgramDetail
  today: string
  canManage: boolean
  view: 'products' | 'runs'
}) {
  const p = detail.program
  const display = cmsDisplayStatus(p, today)
  const left = cmsDaysLeft(p, today)
  const actions = cmsProgramActions(p, today, detail.products.length, canManage)
  const scopeText = p.scope === 'all'
    ? `Tất cả nhà thuốc OS${p.status === 'draft' ? ' (chốt danh sách khi kích hoạt)' : ` (${detail.storeCount})`}`
    : `${detail.storeCount} nhà thuốc`
  const hasCatalog = detail.products.some((x) => x.gmvBasis === 'catalog')
  const tabHref = (v: 'products' | 'runs') => (v === 'products' ? `/targets/campaigns/cms/${p.id}` : `/targets/campaigns/cms/${p.id}?view=runs`)
  const showRuns = canManage && view === 'runs'

  return (
    <div data-ui-v2="page" data-layout-width="fluid" data-cms-detail={display} className="p-4 md:p-6 space-y-4 md:space-y-[18px]">
      <Link href="/targets/campaigns/cms" className="inline-flex min-h-[44px] items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> CMS sản phẩm
      </Link>

      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 space-y-1.5">
          <h1 className="text-[20px] md:text-[22px] font-bold leading-tight break-words">{p.name}</h1>
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge tone={CMS_STATUS_TONE[display]}>{CMS_STATUS_LABEL[display]}</StatusBadge>
            {p.isTest && <StatusBadge tone="warning">QA</StatusBadge>}
          </div>
          <p className="text-[13px] text-muted-foreground tabular-nums">
            {cmsDateRange(p.startDate, p.endDate)}
            {display === 'upcoming' && <> · bắt đầu {cmsDate(p.startDate)}</>}
            {left !== null && <> · còn {left} ngày</>}
            {' · '}{scopeText}
          </p>
        </div>
        {canManage && (actions.edit || actions.importMode || actions.activate) && (
          <div className="flex flex-wrap gap-2 md:justify-end">
            {actions.edit && (
              <Link href={`/targets/campaigns/cms/${p.id}/edit`} className={cn(buttonVariants({ variant: 'outline' }), BTN)}>
                <Pencil className="h-4 w-4" /> Sửa thông tin
              </Link>
            )}
            {actions.importMode && (
              <Link href={`/targets/campaigns/cms/${p.id}/import`} className={cn(buttonVariants({ variant: 'outline' }), BTN)}>
                <Upload className="h-4 w-4" /> {actions.importMode === 'replace' ? (detail.products.length ? 'Nạp lại danh mục' : 'Nạp danh mục') : 'Import bổ sung'}
              </Link>
            )}
            {actions.activate && (
              <CmsActivateButton programId={p.id} productCount={detail.products.length} startDate={p.startDate} endDate={p.endDate} scopeText={scopeText} today={today} />
            )}
          </div>
        )}
      </div>

      <div data-cms-detail-stats className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        <StatCard label="Sản phẩm trong chương trình" value={<span className="tabular-nums">{detail.products.length}</span>} />
        <StatCard label="Nhà thuốc áp dụng" value={<span className="tabular-nums">{p.scope === 'all' && p.status === 'draft' ? 'Tất cả OS' : detail.storeCount}</span>} />
        {hasCatalog && <StatCard label="Target danh mục" value={<span className="tabular-nums">{cmsVnd(p.catalogTargetGmv)}</span>} />}
      </div>

      {p.scope === 'stores' && detail.storeNames && detail.storeNames.length > 0 && (
        <p data-cms-store-names className="text-[13px] text-muted-foreground line-clamp-2 break-words">Phạm vi: {detail.storeNames.join(', ')}</p>
      )}

      {canManage && (
        <nav aria-label="Nội dung chương trình" className="flex w-fit max-w-full gap-1 rounded-v2-control bg-muted p-1">
          {(['products', 'runs'] as const).map((v) => (
            <Link
              key={v}
              href={tabHref(v)}
              aria-current={(v === 'runs') === showRuns ? 'page' : undefined}
              className={cn(
                'inline-flex min-h-[44px] md:min-h-0 md:h-[30px] items-center whitespace-nowrap rounded-[8px] px-3 text-[13px]',
                (v === 'runs') === showRuns ? 'border border-input bg-card font-semibold text-foreground' : 'text-muted-foreground',
              )}
            >
              {v === 'products' ? `Theo sản phẩm (${detail.products.length})` : `Lịch sử import (${detail.runs.length})`}
            </Link>
          ))}
        </nav>
      )}

      {showRuns ? (
        detail.runs.length === 0 ? (
          <EmptyState className="py-10 rounded-v2-panel border border-dashed border-input bg-card" icon={Upload} title="Chưa có lần import nào" />
        ) : (
          <div className="overflow-hidden rounded-v2-panel border bg-card">
            <div className="overflow-x-auto">
              <table data-cms-runs className="w-full min-w-[680px] text-[13px]">
                <thead className="bg-muted">
                  <tr className="text-left whitespace-nowrap">
                    <th className="pl-4 pr-3 py-2.5 text-[12px] font-medium text-muted-foreground">Thời gian</th>
                    <th className="px-3 py-2.5 text-[12px] font-medium text-muted-foreground">Chế độ</th>
                    <th className="px-3 py-2.5 text-[12px] font-medium text-muted-foreground">Trạng thái</th>
                    <th className="px-3 py-2.5 text-[12px] font-medium text-muted-foreground">Kết quả</th>
                    <th className="pl-3 pr-4 py-2.5 text-[12px] font-medium text-muted-foreground text-right">File lỗi</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.runs.map((r) => (
                    <tr key={r.id} className="border-t align-middle">
                      <td className="pl-4 pr-3 py-2.5 tabular-nums whitespace-nowrap">{cmsDateTime(r.committedAt ?? r.createdAt)}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">{r.mode === 'replace' ? 'Nạp toàn bộ' : 'Thêm sản phẩm'}</td>
                      <td className="px-3 py-2.5"><StatusBadge tone={r.status === 'committed' ? 'success' : 'neutral'}>{r.status === 'committed' ? 'Đã ghi' : 'Chỉ kiểm tra'}</StatusBadge></td>
                      <td className="px-3 py-2.5 tabular-nums">
                        {r.productsOk} SP hợp lệ · {r.rowsTotal} dòng
                        {r.productsRejected > 0 && <span className="text-status-warning"> · {r.productsRejected} nhóm lỗi đã loại</span>}
                      </td>
                      <td className="pl-3 pr-4 py-2.5 text-right">
                        {r.productsRejected > 0 ? (
                          <CmsErrorFileLink runId={r.id} />
                        ) : <span className="text-muted-foreground">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      ) : detail.products.length === 0 ? (
        <EmptyState
          className="py-10 rounded-v2-panel border border-dashed border-input bg-card"
          icon={Upload}
          title="Chưa có sản phẩm"
          hint={canManage && actions.importMode ? 'Nạp file danh mục 9 cột để thêm sản phẩm.' : undefined}
          action={canManage && actions.importMode ? (
            <Link href={`/targets/campaigns/cms/${p.id}/import`} className={cn(buttonVariants(), BTN, 'font-semibold')}><Upload className="h-4 w-4" /> Nạp danh mục</Link>
          ) : undefined}
        />
      ) : (
        <ul data-cms-products className="divide-y rounded-v2-panel border bg-card">
          {detail.products.map((x) => (
            <li key={x.id} data-cms-product={x.productId} className="grid gap-3 p-3 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.5fr)] md:p-4">
              <div className="flex min-w-0 gap-3">
                <CmsProductImage url={x.imageUrlSnapshot} name={x.nameSnapshot} size={44} />
                <div className="min-w-0 space-y-0.5">
                  <p className="font-semibold leading-snug line-clamp-2 break-words">{x.nameSnapshot}</p>
                  <p className="text-[12px] text-muted-foreground tabular-nums">{x.productId}{x.priceSnapshot ? ` · ${cmsPrice(x.priceSnapshot)}` : ''}</p>
                  {x.addedAfterStart && <StatusBadge tone="info" size="sm">Bổ sung sau ngày bắt đầu</StatusBadge>}
                </div>
              </div>
              <div className="space-y-1 text-[13px]">
                <TagBadge hue={CMS_GATE_HUE[x.gmvBasis]}>{CMS_GATE_LABEL[x.gmvBasis]}</TagBadge>
                {x.gmvBasis === 'product' && <p className="text-muted-foreground">Target {cmsVnd(x.targetGmv)}</p>}
                {x.gmvBasis === 'catalog' && <p className="text-muted-foreground">Target danh mục {cmsVnd(p.catalogTargetGmv)}</p>}
                <p className="text-muted-foreground">{cmsBaseQtyLine(x.unitCms, x.baseQuantityCms)}</p>
              </div>
              <div className="space-y-1.5">
                <CmsTierChips tiers={x.tiers} unit={x.unitCms} />
                {/* Tư vấn: 2 dòng + "Xem đầy đủ" mở toàn văn tại chỗ (PM review P1-c P2 — không tooltip trên mobile). */}
                <details data-cms-advice className="group text-[12px] text-muted-foreground">
                  <summary className="flex min-h-[44px] md:min-h-0 cursor-pointer list-none flex-col gap-0.5 [&::-webkit-details-marker]:hidden">
                    <span className="line-clamp-2 whitespace-pre-line break-words group-open:hidden">{x.adviceText}</span>
                    <span className="font-medium text-foreground underline-offset-2 hover:underline"><span className="group-open:hidden">Xem đầy đủ</span><span className="hidden group-open:inline">Thu gọn</span></span>
                  </summary>
                  <p className="mt-1 whitespace-pre-line break-words">{x.adviceText}</p>
                </details>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
