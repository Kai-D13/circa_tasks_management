import Link from 'next/link'
import { Boxes, Plus, Search } from 'lucide-react'
import { PageHeader } from '@/components/ds/PageHeader'
import { StatCard } from '@/components/ds/StatCard'
import { FilterTabs } from '@/components/ds/FilterTabs'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { EmptyState } from '@/components/ds/EmptyState'
import { ErrorState } from '@/components/ds/ErrorState'
import { CampaignsTabs } from '@/components/kpi/CampaignsTabs'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { cmsDate, cmsDateRange, cmsDateTime } from '@/lib/cms/display'
import {
  CMS_STATUS_LABEL, CMS_STATUS_TONE, cmsDaysLeft, cmsStatusesFor,
} from '@/lib/cms/programStatus'
import type { CmsImportRunView } from '@/lib/cms/server/catalog'
import type { CmsListFilter, CmsListModelRow } from '@/lib/cms/programList'

// CMS P1-c · A1 /targets/campaigns/cms (UI §3.1, r2 U1/U2/U8/U20). Dùng chung route thật + fixture /ui-catalog/cms-v2.
// P1: KHÔNG render cột / ô kết quả thực tế (Đạt điều kiện, CMS tạm tính, Dược sĩ có CMS) — không ô 0 / thanh rỗng.
// StatCard chỉ ô không có tiền; chương trình QA không vào thống kê. SM: chỉ đọc, không có Nháp / Tạo / Import.

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
        : <span className="text-[12px] text-muted-foreground">{run.productsOk} SP hợp lệ</span>}
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

export function CmsProgramListView({
  canManage, affiliateEnabled, today, filter, q, counts, rows, hasAny, stats, error,
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
}) {
  const statuses = cmsStatusesFor(canManage)
  const tabs = [
    { key: 'all', label: 'Tất cả', count: counts.all, href: listHref('all', q) },
    ...statuses.map((s) => ({ key: s, label: CMS_STATUS_LABEL[s], count: counts[s], href: listHref(s, q) })),
  ]
  return (
    <div data-ui-v2="page" data-layout-width="fluid" data-cms-list className="p-4 md:p-6 space-y-4 md:space-y-[18px]">
      <PageHeader
        title="Chiến dịch KPI"
        icon={Boxes}
        actions={canManage ? (
          <Link href="/targets/campaigns/cms/new" className={CREATE_BTN}>
            <Plus className="h-4 w-4 mr-1" /> Tạo chương trình CMS
          </Link>
        ) : undefined}
      />
      <CampaignsTabs active="cms" affiliateEnabled={affiliateEnabled} cmsEnabled />

      {error ? (
        <ErrorState message="Không tải được danh sách chương trình CMS" hint={error} />
      ) : (
        <>
          {stats && (
            <div data-cms-stats className="grid grid-cols-2 gap-2.5 md:max-w-xl">
              <StatCard label="Chương trình đang chạy" value={<span className="tabular-nums">{stats.running}</span>} />
              <StatCard label="Sản phẩm đang áp dụng" value={<span className="tabular-nums">{stats.productsRunning}</span>} />
            </div>
          )}

          {hasAny && (
            <div className="flex flex-col gap-2.5 md:flex-row md:items-center md:justify-between">
              <FilterTabs variant="chip" ariaLabel="Lọc chương trình theo trạng thái" activeKey={filter} tabs={tabs} />
              <form action="/targets/campaigns/cms" method="get" role="search" className="flex gap-2 md:w-[360px]">
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
                <Link href="/targets/campaigns/cms/new" className={CREATE_BTN}><Plus className="h-4 w-4 mr-1" /> Tạo chương trình CMS</Link>
              ) : undefined}
            />
          ) : (
            <>
              <div className="hidden md:block overflow-hidden rounded-v2-panel border bg-card">
                <div className="overflow-x-auto">
                  <table data-cms-table className="w-full min-w-[760px] text-[13px]">
                    <thead className="bg-muted">
                      <tr className="text-left whitespace-nowrap">
                        <th className="pl-5 pr-3 py-2.5 text-[12px] font-medium text-muted-foreground">Chương trình</th>
                        <th className="px-3 py-2.5 text-[12px] font-medium text-muted-foreground">Trạng thái</th>
                        <th className="px-3 py-2.5 text-[12px] font-medium text-muted-foreground text-right">Sản phẩm</th>
                        {canManage && <th className="pl-3 pr-5 py-2.5 text-[12px] font-medium text-muted-foreground">Import gần nhất</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id} data-cms-row={r.display} className="border-t align-middle">
                          <td className="pl-5 pr-3 py-3">
                            <span className="flex flex-col gap-0.5 min-w-0">
                              <Link href={`/targets/campaigns/cms/${r.id}`} className="font-semibold hover:underline line-clamp-2 break-words">{r.name}</Link>
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
                          {canManage && <td className="pl-3 pr-5 py-3"><RunCell run={r.lastImport} /></td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <ul data-cms-cards className="md:hidden space-y-2.5">
                {rows.map((r) => (
                  <li key={r.id} data-cms-card={r.display}>
                    <Link href={`/targets/campaigns/cms/${r.id}`} className="block min-h-[44px] space-y-2 rounded-v2-panel border bg-card p-4">
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
                      {canManage && <span className="block text-[13px]"><RunCell run={r.lastImport} /></span>}
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  )
}
