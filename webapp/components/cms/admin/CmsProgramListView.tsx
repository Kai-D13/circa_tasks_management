import Link from 'next/link'
import { Boxes, Plus, Search } from 'lucide-react'
import { PageHeader } from '@/components/ds/PageHeader'
import { StatCard } from '@/components/ds/StatCard'
import { FilterTabs } from '@/components/ds/FilterTabs'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { EmptyState } from '@/components/ds/EmptyState'
import { ErrorState } from '@/components/ds/ErrorState'
import { ProgressBar } from '@/components/ds/ProgressBar'
import { Notice } from '@/components/ds/Notice'
import { CampaignsTabs } from '@/components/kpi/CampaignsTabs'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { cmsDate, cmsDateRange, cmsDateTime, cmsVnd } from '@/lib/cms/display'
import type { CmsA1Cell, CmsA1Stats } from '@/lib/cms/resultUi'
import {
  CMS_STATUS_LABEL, CMS_STATUS_TONE, cmsDaysLeft, cmsStatusesFor,
} from '@/lib/cms/programStatus'
import type { CmsImportRunView } from '@/lib/cms/server/catalog'
import type { CmsListFilter, CmsListModelRow } from '@/lib/cms/programList'
import { cmsNavHref, type CmsNav } from '@/lib/cms/fixtureNav'

// CMS P1-c · A1 /targets/campaigns/cms (UI §3.1, r2 U1/U2/U8/U20). Dùng chung route thật + fixture /ui-catalog/cms-v2.
// P1: KHÔNG render cột / ô kết quả thực tế (Đạt điều kiện, CMS tạm tính, Dược sĩ có CMS) — không ô 0 / thanh rỗng.
// StatCard chỉ ô không có tiền; chương trình QA không vào thống kê. SM: chỉ đọc, không có Nháp / Tạo / Import.
// P2-c (I3): `p2` (chỉ khi cờ CMS_EARNINGS_ENABLED) thêm 3 ô (CMS đang chạy · CMS chờ chốt · Dược sĩ có CMS — loại QA, lỗi / chưa
// có số ⇒ '—') và 3 cột Đạt điều kiện / CMS / Dược sĩ có CMS (SM: theo phạm vi RPC). p2 null ⇒ P1 nguyên trạng.
// CMS-UI-1 (PM 04/11 §6.4–6.5): ô chương trình ĐÃ CHỐT ghi "Đã chốt" (run đóng băng) và không vào hai ô tổng; ô thiếu số thống
// nhất '—' (+ lý do ngắn, link A3 khi chưa tải / lỗi); tiền đọc đủ (ô thống kê không cắt số); gợi ý "chưa có số liệu" nằm đúng
// nhóm đang chạy / chờ chốt; chú thích "Không tính chương trình QA"; toolbar xuống hàng khi thiếu chỗ (ô tìm không che chip).

const MONEY = 'tabular-nums [overflow-wrap:anywhere] text-[length:clamp(20px,11cqi,30px)]'
const DASH = <span className="text-muted-foreground">—</span>

function ResultCells({ cell, detailHref, expect }: { cell: CmsA1Cell | undefined; detailHref: string; expect: boolean }) {
  if (!cell || cell.kind !== 'ok') {
    const note = !cell ? (expect ? 'Chưa tải số ở danh sách' : null) : cell.kind === 'none' ? 'Chưa có số liệu' : 'Lỗi tải số liệu'
    return (
      <>
        <td className="px-3 py-3" data-cms-result-cell={cell?.kind ?? (expect ? 'not-loaded' : 'na')}>
          <span className="flex flex-col gap-0.5">
            {DASH}
            {note && <span className={cn('text-[12px]', cell?.kind === 'error' ? 'text-status-danger' : 'text-muted-foreground')}>{note}</span>}
            {note && cell?.kind !== 'none' && <Link href={detailHref} className="text-[12px] font-medium underline underline-offset-2">Xem trong chi tiết</Link>}
          </span>
        </td>
        <td className="px-3 py-3 text-right">{DASH}</td>
        <td className="px-3 py-3 text-right">{DASH}</td>
      </>
    )
  }
  return (
    <>
      <td className="px-3 py-3" data-cms-result-cell={cell.locked ? 'locked' : 'ok'}>
        <ProgressBar value={cell.productsWithCms} max={Math.max(1, cell.productCount)} tone={cell.locked ? 'ended' : 'ok'} size={5} ariaLabel={`${cell.productsWithCms}/${cell.productCount} SP có CMS`}
          label={<span className="text-[12px] font-normal text-muted-foreground">{cell.productsWithCms}/{cell.productCount} SP có CMS</span>} />
      </td>
      <td className="px-3 py-3 text-right">
        <span className="block font-semibold tabular-nums whitespace-nowrap">{cmsVnd(cell.amountVnd)}</span>
        <span className="block text-[12px] text-muted-foreground">{cell.locked ? 'Đã chốt' : 'Tạm tính'}</span>
      </td>
      <td className="px-3 py-3 text-right tabular-nums">{cell.pharmacistsWithCms}</td>
    </>
  )
}

/** Hàng A1 (lib/cms/programList). lastImport null khi người xem không đọc được import run (SM) hoặc chưa ghi lần nào. */
export type CmsListRow = CmsListModelRow

const CREATE_BTN = cn(buttonVariants({ size: 'sm' }), 'h-[44px] md:h-[36px] px-3.5 text-[13px] font-semibold')

function listHref(status: CmsListFilter, q: string) {
  const p = new URLSearchParams()
  if (status !== 'all') p.set('status', status)
  if (q) p.set('q', q)
  const s = p.toString()
  return s ? `/targets/campaigns/cms?${s}` : '/targets/campaigns/cms'
}

function RunCell({ run }: { run: CmsImportRunView | null }) {
  if (!run) return <span className="text-muted-foreground">Chưa nạp danh mục</span>
  return (
    <span className="flex flex-col gap-0.5">
      <span className="tabular-nums">{cmsDateTime(run.committedAt ?? run.createdAt)}</span>
      {run.productsRejected > 0
        ? <span className="text-[12px] text-status-warning">{run.productsOk} SP hợp lệ · {run.productsRejected} nhóm lỗi đã loại</span>
        : <span className="text-[12px] text-muted-foreground">{run.productsOk} SP hợp lệ{run.mode === 'append' ? ' · thêm sản phẩm' : ''}</span>}
    </span>
  )
}

function DateLine({ r, today }: { r: CmsListRow; today: string }) {
  const left = cmsDaysLeft({ status: r.display === 'draft' ? 'draft' : r.display === 'locked' ? 'locked' : 'active', startDate: r.startDate, endDate: r.endDate }, today)
  return (
    <span className="text-[12px] text-muted-foreground tabular-nums">
      {cmsDateRange(r.startDate, r.endDate)}
      {r.display === 'upcoming' && <> · bắt đầu {cmsDate(r.startDate).slice(0, 5)}</>}
      {left !== null && <> · còn {left} ngày</>}
    </span>
  )
}

const HAS_RESULTS = (d: CmsListRow['display']) => d === 'running' || d === 'waiting_close' || d === 'locked'

export function CmsProgramListView({
  canManage, affiliateEnabled, today, filter, q, counts, rows, hasAny, stats, error, p2 = null, nav, tabsDesktopReplaced = false,
}: {
  canManage: boolean
  affiliateEnabled: boolean
  today: string
  filter: CmsListFilter
  q: string
  /** Đếm trên TOÀN TẬP người xem đọc được (không theo tab). */
  counts: Record<CmsListFilter, number>
  rows: CmsListRow[]
  hasAny: boolean
  /** Thống kê thật (loại QA): null khi lỗi. */
  stats: { running: number; productsRunning: number } | null
  error: string | null
  /** P2 (cờ earnings): ô kết quả theo chương trình + thống kê; null ⇒ P1. */
  p2?: { cells: Map<string, CmsA1Cell>; stats: CmsA1Stats } | null
  /** Fixture: điều hướng trong /ui-catalog (route thật bỏ trống). */
  nav?: CmsNav
  /** UI-NAV U1: ẩn hàng tab chuyển module ở desktop — page server tính (campaignTabsDesktopReplaced: super / SM); mặc định false (fixture). */
  tabsDesktopReplaced?: boolean
}) {
  const href = (h: string) => cmsNavHref(nav, h)
  const statuses = cmsStatusesFor(canManage)
  const tabs = [
    { key: 'all', label: 'Tất cả', count: counts.all, href: href(listHref('all', q)) },
    ...statuses.map((s) => ({ key: s, label: CMS_STATUS_LABEL[s], count: counts[s], href: href(listHref(s, q)) })),
  ]
  const searchAction = href('/targets/campaigns/cms')
  const searchUrl = new URL(searchAction, 'http://x')
  const okCell = (id: string) => { const c = p2?.cells.get(id); return c?.kind === 'ok' ? c : null }
  return (
    <div data-ui-v2="page" data-layout-width="fluid" data-cms-list className="p-4 md:p-6 space-y-4 md:space-y-[18px]">
      <PageHeader
        title="Chiến dịch KPI"
        icon={Boxes}
        actions={canManage ? (
          <Link href={href('/targets/campaigns/cms/new')} className={CREATE_BTN}>
            <Plus className="h-4 w-4 mr-1" /> Tạo chương trình CMS
          </Link>
        ) : undefined}
      />
      <CampaignsTabs active="cms" affiliateEnabled={affiliateEnabled} cmsEnabled desktopSidebarReplacement={nav?.mode === 'fixture' ? false : tabsDesktopReplaced}
        hrefs={nav?.mode === 'fixture' ? { campaigns: href('/targets/campaigns'), affiliate: href('/targets/campaigns/affiliate'), cms: href('/targets/campaigns/cms') } : undefined} />

      {error ? (
        <ErrorState message="Không tải được danh sách chương trình CMS" hint={error} />
      ) : (
        <>
          {stats && (
            <div data-cms-stats className="@container space-y-1.5">
              <div className={p2 ? 'grid grid-cols-1 gap-2.5 @min-[400px]:grid-cols-2 @min-[680px]:grid-cols-3 @min-[1000px]:grid-cols-5' : 'grid grid-cols-2 gap-2.5 md:max-w-xl'}>
                <StatCard label="Chương trình đang chạy" value={<span className="tabular-nums">{stats.running}</span>} />
                <StatCard label="Sản phẩm đang áp dụng" value={<span className="tabular-nums">{stats.productsRunning}</span>} />
                {p2 && (
                  <>
                    <StatCard className="@container" label="CMS tạm tính · đang chạy" value={<span data-cms-stat-running className={MONEY}>{p2.stats.runningVnd === null ? '—' : cmsVnd(p2.stats.runningVnd)}</span>}
                      hint={p2.stats.withoutSnapshotRunning > 0 ? `${p2.stats.withoutSnapshotRunning} chương trình đang chạy chưa có số liệu` : undefined} hintLines={2} />
                    <StatCard className="@container" label="CMS · chờ chốt kỳ" value={<span data-cms-stat-waiting className={MONEY}>{p2.stats.waitingVnd === null ? '—' : cmsVnd(p2.stats.waitingVnd)}</span>}
                      hint={p2.stats.withoutSnapshotWaiting > 0 ? `${p2.stats.withoutSnapshotWaiting} chương trình chờ chốt chưa có số liệu` : undefined} hintLines={2} />
                    <StatCard label="Dược sĩ có CMS" value={<span data-cms-stat-pharmacists className="tabular-nums">{p2.stats.pharmacists === null ? '—' : p2.stats.pharmacists}</span>}
                      hint="Đang chạy + chờ chốt kỳ" hintLines={2} />
                  </>
                )}
              </div>
              <p data-cms-stats-note className="text-[12px] text-muted-foreground">Thống kê không tính chương trình QA{p2 ? ' và chương trình đã chốt (số đã chốt xem ở từng hàng)' : ''}. Số trên các tab lọc đếm mọi chương trình bạn xem được.</p>
            </div>
          )}
          {p2 && p2.stats.notLoaded > 0 && (
            <Notice tone="warning" role="status" title="Không cộng tổng CMS trên danh sách">
              <span data-cms-stats-truncated>{p2.stats.notLoaded} chương trình đang chạy / chờ chốt chưa được tải số liệu ở màn này — xem số từng chương trình trong trang chi tiết.</span>
            </Notice>
          )}

          {hasAny && (
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="min-w-0 max-w-full"><FilterTabs variant="chip" ariaLabel="Lọc chương trình theo trạng thái" activeKey={filter} tabs={tabs} /></div>
              <form action={searchUrl.pathname} method="get" role="search" className="flex min-w-[260px] flex-1 basis-[320px] gap-2 md:max-w-[420px] md:ml-auto">
                {nav?.mode === 'fixture' && [...searchUrl.searchParams].filter(([k]) => k !== 'q' && k !== 'status').map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
                {filter !== 'all' && <input type="hidden" name="status" value={filter} />}
                <label className="relative flex-1">
                  <span className="sr-only">Tìm theo tên chương trình hoặc ProductID</span>
                  <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    name="q"
                    defaultValue={q}
                    placeholder="Tên chương trình hoặc ProductID"
                    className="h-[44px] md:h-[36px] w-full rounded-v2-control border border-input bg-card pl-9 pr-3 text-[16px] md:text-sm"
                  />
                </label>
                <button type="submit" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-[44px] md:h-[36px] px-3.5')}>Tìm</button>
              </form>
            </div>
          )}

          {rows.length === 0 ? (
            <EmptyState
              className="py-12 rounded-v2-panel border border-dashed border-input bg-card"
              icon={Boxes}
              title={hasAny ? 'Không có chương trình khớp bộ lọc' : 'Chưa có chương trình CMS'}
              action={!hasAny && canManage ? (
                <Link href={href('/targets/campaigns/cms/new')} className={CREATE_BTN}><Plus className="h-4 w-4 mr-1" /> Tạo chương trình CMS</Link>
              ) : undefined}
            />
          ) : (
            <>
              <div className="hidden md:block overflow-hidden rounded-v2-panel border bg-card">
                <div className="overflow-x-auto">
                  <table data-cms-table className={cn('w-full text-[13px]', p2 ? 'min-w-[1000px]' : 'min-w-[760px]')}>
                    <thead className="bg-muted">
                      <tr className="text-left whitespace-nowrap">
                        <th className="pl-5 pr-3 py-2.5 text-[12px] font-medium text-muted-foreground">Chương trình</th>
                        <th className="px-3 py-2.5 text-[12px] font-medium text-muted-foreground">Trạng thái</th>
                        <th className="px-3 py-2.5 text-[12px] font-medium text-muted-foreground text-right">Sản phẩm</th>
                        {p2 && <th className="px-3 py-2.5 text-[12px] font-medium text-muted-foreground">Đạt điều kiện</th>}
                        {p2 && <th className="px-3 py-2.5 text-[12px] font-medium text-muted-foreground text-right">CMS</th>}
                        {p2 && <th className="px-3 py-2.5 text-[12px] font-medium text-muted-foreground text-right">Dược sĩ có CMS</th>}
                        {canManage && <th className="pl-3 pr-5 py-2.5 text-[12px] font-medium text-muted-foreground">Import gần nhất</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id} data-cms-row={r.display} className="border-t align-middle">
                          <td className="pl-5 pr-3 py-3">
                            <span className="flex flex-col gap-0.5 min-w-0">
                              <Link href={href(`/targets/campaigns/cms/${r.id}`)} className="font-semibold hover:underline line-clamp-2 break-words">{r.name}</Link>
                              <DateLine r={r} today={today} />
                            </span>
                          </td>
                          <td className="px-3 py-3 whitespace-nowrap">
                            <span className="inline-flex items-center gap-1.5">
                              <StatusBadge tone={CMS_STATUS_TONE[r.display]}>{CMS_STATUS_LABEL[r.display]}</StatusBadge>
                              {r.isTest && <StatusBadge tone="warning">QA</StatusBadge>}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-right tabular-nums">{r.productCount}</td>
                          {p2 && <ResultCells cell={p2.cells.get(r.id)} detailHref={href(`/targets/campaigns/cms/${r.id}`)} expect={HAS_RESULTS(r.display)} />}
                          {canManage && <td className="pl-3 pr-5 py-3"><RunCell run={r.lastImport} /></td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <ul data-cms-cards className="md:hidden space-y-2.5">
                {rows.map((r) => {
                  const c = okCell(r.id)
                  return (
                    <li key={r.id} data-cms-card={r.display}>
                      <Link href={href(`/targets/campaigns/cms/${r.id}`)} className="block min-h-[44px] space-y-2 rounded-v2-panel border bg-card p-4">
                        <span className="flex items-start justify-between gap-2">
                          <span className="min-w-0 font-semibold line-clamp-2 break-words">{r.name}</span>
                          <span className="inline-flex shrink-0 items-center gap-1">
                            <StatusBadge tone={CMS_STATUS_TONE[r.display]}>{CMS_STATUS_LABEL[r.display]}</StatusBadge>
                            {r.isTest && <StatusBadge tone="warning">QA</StatusBadge>}
                          </span>
                        </span>
                        <DateLine r={r} today={today} />
                        <span className="flex items-center justify-between text-[13px]">
                          <span className="text-muted-foreground">Sản phẩm</span>
                          <span className="font-semibold tabular-nums">{r.productCount}</span>
                        </span>
                        {p2 && HAS_RESULTS(r.display) && (
                          <span data-cms-card-amount className="flex items-center justify-between gap-2 text-[13px]">
                            <span className="text-muted-foreground">{c?.locked ? 'CMS đã chốt' : 'CMS tạm tính'}</span>
                            <span className="font-semibold tabular-nums [overflow-wrap:anywhere]">{c ? cmsVnd(c.amountVnd) : '—'}</span>
                          </span>
                        )}
                        {canManage && <span className="block text-[13px]"><RunCell run={r.lastImport} /></span>}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  )
}
