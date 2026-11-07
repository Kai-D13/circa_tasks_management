import Link from 'next/link'
import { ArrowLeft, Download, Pencil, Upload } from 'lucide-react'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { Notice } from '@/components/ds/Notice'
import { EmptyState } from '@/components/ds/EmptyState'
import { buttonVariants } from '@/components/ui/button'
import { CmsActivateButton } from '@/components/cms/admin/CmsActivateButton'
import { CmsErrorFileLink } from '@/components/cms/admin/CmsErrorFileLink'
import { CmsA3CatalogBlock, CmsA3StaffTab, CmsA3StatCards, CmsA3SyncLine } from '@/components/cms/admin/CmsProgramResults'
import { CmsA3ProductTable, CmsDistLegend } from '@/components/cms/admin/CmsA3ProductTable'
import { CmsLockPanel } from '@/components/cms/admin/CmsLockPanel'
import { CmsPayoutPanel } from '@/components/cms/admin/CmsPayoutPanel'
import { CmsClampTitle } from '@/components/cms/CmsClampTitle'
import { CmsDownloadLink } from '@/components/cms/CmsDownloadLink'
import type { CmsLockPreviewDto, CmsPayoutDto } from '@/lib/cms/payoutView'
import { cn } from '@/lib/utils'
import { cmsDate, cmsDateRange, cmsDateTime, cmsPrice, cmsVnd } from '@/lib/cms/display'
import {
  CMS_STATUS_LABEL, CMS_STATUS_TONE, cmsDaysLeft, cmsDisplayStatus, cmsProgramActions,
} from '@/lib/cms/programStatus'
import type { CmsProgramDetail } from '@/lib/cms/server/catalog'
import { cmsA3Stats, cmsUnassignedSummary, type CmsResultsLoad } from '@/lib/cms/resultUi'
import { cmsA3ProductVM } from '@/lib/cms/productPresentation'
import { cmsNavHref, type CmsNav } from '@/lib/cms/fixtureNav'
import type { CmsResultRowDto } from '@/lib/cms/resultView'

// CMS P1-c · A3 /targets/campaigns/cms/[id] (UI §3.3; r2 U1 / U6 / U8 / U17). P1: CHỈ cấu hình — số SP, target, bậc,
// mức CMS / đơn vị, quy cách, phạm vi, lịch sử import. KHÔNG có ô / cột kết quả thực tế (CMS tạm tính, GMV / SL bán,
// lượt đạt…), không Xuất Excel / Chốt kỳ (P2 / P3). Nút quản trị theo SPEC §4.7, chỉ super; SM chỉ đọc.
// P2-c (I3): `results` (mặc định 'off' ⇒ P1 nguyên trạng) — cờ CMS_EARNINGS_ENABLED + chương trình đã bắt đầu: 4 ô kết quả,
// trạng thái đồng bộ, khối danh mục, cột kết quả theo SP (+ dược sĩ trong phần mở rộng), tab Theo dược sĩ (super thấy nhóm Chưa
// gán), Xuất Excel cùng run. SM: phạm vi theo RPC 122 (nhà thuốc được phân công).
// P3a (cờ program + earnings + lock): khối Chốt kỳ (super, chương trình đã hết kỳ — CmsLockPanel) và Số đã chốt (super + SM,
// chương trình locked — CmsPayoutPanel, phạm vi hiện tại Q-208 / Q-217, file chi trả). Cờ lock OFF ⇒ cả hai ẩn.
// CMS-UI-1 (PM 04/11 §4): page-root FLUID (không cap — width policy Circa); cấu hình (ngày · phạm vi · số SP · số nhà thuốc ·
// target danh mục) là MỘT dòng meta dưới tiêu đề thay 3 ô cấu hình lớn; nút Sửa / Import / Kích hoạt / Xuất Excel chung một
// nhóm; bảng SP theo CmsA3ProductTable (mở rộng toàn hàng, card khi vùng nội dung hẹp); nhãn theo trạng thái (Đã chốt không ghi
// "tạm tính / chưa chốt kỳ"). `nav` (fixture) chỉ đổi href, route thật mặc định giữ nguyên.
export type CmsDetailView = 'products' | 'staff' | 'runs'

const BTN = 'h-[44px] md:h-[36px] gap-1.5 text-[13px]'

export function CmsProgramDetailView({ detail, today, canManage, view, results = { kind: 'off' }, eligibleStaffIds = null, storeNames = new Map(), staffPage = 1, lock = null, payout = null, nav }: {
  detail: CmsProgramDetail
  today: string
  canManage: boolean
  view: CmsDetailView
  results?: CmsResultsLoad
  /** Mẫu số Q-212 (staff hiện thuộc phạm vi ∩ phạm vi người xem); null ⇒ không hiện "/y". */
  eligibleStaffIds?: string[] | null
  storeNames?: Map<string, string>
  staffPage?: number
  /** P3a: khối Chốt kỳ (chỉ super + cờ lock + chương trình đã hết kỳ) — null ⇒ ẩn. */
  lock?: { preview: CmsLockPreviewDto | null; error: string | null; qaReadonly?: boolean } | null
  /** P3a: số đã chốt (chương trình locked + cờ lock) — null ⇒ ẩn. */
  payout?: { data: CmsPayoutDto | null; error: string | null } | null
  /** Fixture: điều hướng trong /ui-catalog (route thật bỏ trống). */
  nav?: CmsNav
}) {
  const p = detail.program
  const href = (h: string) => cmsNavHref(nav, h)
  const display = cmsDisplayStatus(p, today)
  const left = cmsDaysLeft(p, today)
  const actions = cmsProgramActions(p, today, detail.products.length, canManage)
  const scopeText = p.scope === 'all'
    ? `Tất cả nhà thuốc OS${p.status === 'draft' ? ' (chốt danh sách khi kích hoạt)' : ` (${detail.storeCount})`}`
    : `${detail.storeCount} nhà thuốc`
  const hasCatalog = detail.products.some((x) => x.gmvBasis === 'catalog')
  const base = `/targets/campaigns/cms/${p.id}`
  const tabHref = (v: CmsDetailView) => href(v === 'products' ? base : `${base}?view=${v}`)
  const loaded = results.kind === 'loaded' ? results : null
  const run = loaded?.header.run ?? null
  const resultRows = loaded ? loaded.rows.results : []
  const rowsByPp = new Map<string, CmsResultRowDto[]>()
  for (const r of resultRows) { const l = rowsByPp.get(r.programProductId); if (l) l.push(r); else rowsByPp.set(r.programProductId, [r]) }
  const stats = run ? cmsA3Stats(resultRows, detail.products.map((x) => x.productId), eligibleStaffIds) : null
  const staffCount = new Set(resultRows.map((r) => r.userId)).size
  const tabs: CmsDetailView[] = ['products', ...(loaded ? ['staff' as const] : []), ...(canManage ? ['runs' as const] : [])]
  const active: CmsDetailView = tabs.includes(view) ? view : 'products'
  const showRuns = active === 'runs'
  const exportHref = run ? `/api/export/cms?program=${encodeURIComponent(p.id)}&run=${encodeURIComponent(run.id)}` : null
  const amountLabel = display === 'locked' ? 'CMS đã chốt' : 'CMS tạm tính'
  const products = detail.products.map((x) => cmsA3ProductVM(x, {
    catalogTargetGmv: p.catalogTargetGmv, priceText: cmsPrice,
    results: run && loaded ? { rows: rowsByPp.get(x.id) ?? [], catalog: loaded.rows.catalog, users: loaded.rows.users, storeNames } : null,
  }))
  const showActions = canManage && (actions.edit || actions.importMode || actions.activate)

  return (
    <div data-ui-v2="page" data-layout-width="fluid" data-cms-detail={display} className="p-4 md:p-6 space-y-4 md:space-y-[18px]">
      <Link href={href('/targets/campaigns/cms')} className="inline-flex min-h-[44px] items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> CMS sản phẩm
      </Link>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-1.5 lg:max-w-[72ch]">
          <CmsClampTitle text={p.name} />
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge tone={CMS_STATUS_TONE[display]}>{CMS_STATUS_LABEL[display]}</StatusBadge>
            {p.isTest && <StatusBadge tone="warning">QA</StatusBadge>}
          </div>
          <p data-cms-detail-meta className="text-[13px] text-muted-foreground tabular-nums break-words">
            {cmsDateRange(p.startDate, p.endDate)}
            {display === 'upcoming' && <> · bắt đầu {cmsDate(p.startDate)}</>}
            {left !== null && <> · còn {left} ngày</>}
            {' · '}{scopeText}
            {' · '}{detail.products.length} sản phẩm
            {hasCatalog && <> · target nhóm danh mục {cmsVnd(p.catalogTargetGmv)} / dược sĩ</>}
          </p>
          {p.scope === 'stores' && detail.storeNames && detail.storeNames.length > 0 && (
            <p data-cms-store-names className="text-[13px] text-muted-foreground line-clamp-2 break-words">Phạm vi: {detail.storeNames.join(', ')}</p>
          )}
        </div>
        {(showActions || exportHref) && (
          <div data-cms-actions className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap lg:shrink-0 lg:justify-end">
            {canManage && actions.edit && (
              <Link href={href(`${base}/edit`)} className={cn(buttonVariants({ variant: 'outline' }), BTN)}>
                <Pencil className="h-4 w-4" /> Sửa thông tin
              </Link>
            )}
            {canManage && actions.importMode && (
              <Link href={href(`${base}/import`)} className={cn(buttonVariants({ variant: 'outline' }), BTN)}>
                <Upload className="h-4 w-4" /> {actions.importMode === 'replace' ? (detail.products.length ? 'Nạp lại danh mục' : 'Nạp danh mục') : 'Import bổ sung'}
              </Link>
            )}
            {exportHref && (
              <CmsDownloadLink href={exportHref} data-cms-export className={cn(buttonVariants({ variant: 'outline' }), BTN)}>
                <Download className="h-4 w-4" /> Xuất Excel
              </CmsDownloadLink>
            )}
            {canManage && actions.activate && (
              <span className="col-span-2 sm:col-span-1 [&>*]:w-full sm:[&>*]:w-auto">
                <CmsActivateButton programId={p.id} productCount={detail.products.length} startDate={p.startDate} endDate={p.endDate} scopeText={scopeText} today={today} />
              </span>
            )}
          </div>
        )}
      </div>

      {payout && <CmsPayoutPanel programId={p.id} payout={payout.data} error={payout.error} />}
      {lock && <CmsLockPanel programId={p.id} preview={lock.preview} loadError={lock.error} qaReadonly={lock.qaReadonly === true} />}
      {loaded && <CmsA3SyncLine header={loaded.header} isSuper={canManage} display={display} />}
      {loaded && <CmsA3StatCards stats={stats} display={display} />}
      {run && loaded && hasCatalog && loaded.rows.catalog.length > 0 && <CmsA3CatalogBlock catalog={loaded.rows.catalog} target={p.catalogTargetGmv} />}
      {(results.kind === 'error' || results.kind === 'gone') && (
        <div data-cms-results-error>
          {results.kind === 'gone'
            ? <Notice tone="info" role="status" title="Số liệu vừa được cập nhật">Tải lại trang để xem số mới.</Notice>
            : <Notice tone="danger" role="alert" title="Chưa tải được số liệu CMS">Danh mục vẫn hiển thị bên dưới. Thử tải lại trang.</Notice>}
        </div>
      )}

      {tabs.length > 1 && (
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <nav aria-label="Nội dung chương trình" className="flex w-fit max-w-full gap-1 overflow-x-auto rounded-v2-control bg-muted p-1">
            {tabs.map((v) => (
              <Link
                key={v}
                href={tabHref(v)}
                aria-current={v === active ? 'page' : undefined}
                className={cn(
                  'inline-flex min-h-[44px] md:min-h-0 md:h-[30px] items-center whitespace-nowrap rounded-[8px] px-3 text-[13px]',
                  v === active ? 'border border-input bg-card font-semibold text-foreground' : 'text-muted-foreground',
                )}
              >
                {v === 'products' ? `Theo sản phẩm (${detail.products.length})` : v === 'staff' ? `Theo dược sĩ${run ? ` (${staffCount})` : ''}` : `Lịch sử import (${detail.runs.length})`}
              </Link>
            ))}
          </nav>
          {active === 'products' && run && detail.products.length > 0 && <CmsDistLegend />}
        </div>
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
      ) : active === 'staff' ? (
        run ? (
          <CmsA3StaffTab rows={resultRows} users={loaded!.rows.users} storeNames={storeNames} page={staffPage} amountLabel={amountLabel}
            pageHref={(n) => href(`${base}?view=staff${n > 1 ? `&page=${n}` : ''}`)}
            unassigned={canManage ? cmsUnassignedSummary(run.totals) : null} />
        ) : (
          <EmptyState className="py-10 rounded-v2-panel border border-dashed border-input bg-card" icon={Upload} title="Chưa có số liệu" hint="Số liệu xuất hiện sau lần đồng bộ bán đầu tiên được công bố." />
        )
      ) : detail.products.length === 0 ? (
        <EmptyState
          className="py-10 rounded-v2-panel border border-dashed border-input bg-card"
          icon={Upload}
          title="Chưa có sản phẩm"
          hint={canManage && actions.importMode ? 'Nạp file danh mục 9 cột để thêm sản phẩm.' : undefined}
          action={canManage && actions.importMode ? (
            <Link href={href(`${base}/import`)} className={cn(buttonVariants(), BTN, 'font-semibold')}><Upload className="h-4 w-4" /> Nạp danh mục</Link>
          ) : undefined}
        />
      ) : (
        <CmsA3ProductTable products={products} amountLabel={amountLabel} staffTabHref={run ? tabHref('staff') : null} />
      )}
    </div>
  )
}
