import Link from 'next/link'
import { Link2, TrendingUp, Package, Store as StoreIcon } from 'lucide-react'
import { AffiliateStoreOrdersRow } from '@/components/affiliate/AffiliateStoreOrdersRow'
import { CampaignsTabs } from '@/components/kpi/CampaignsTabs'
import { PageHeader } from '@/components/ds/PageHeader'
import { DataToolbar } from '@/components/ds/DataToolbar'
import { StatCard } from '@/components/ds/StatCard'
import { DataTableShell } from '@/components/ds/DataTableShell'
import { ErrorState } from '@/components/ds/ErrorState'
import { EmptyState } from '@/components/ds/EmptyState'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { buttonVariants } from '@/components/ui/button'
import { salesPointsLabel, type OverviewDataState, type OverviewPageScope } from '@/lib/affiliate/overview'
import { drilldownEnabled, overviewEntityKey, type OverviewEntity, type OverviewTypeFilter } from '@/lib/affiliate/orders'
import { formatDate, formatDateTime } from '@/lib/dateUtils'
import { cn } from '@/lib/utils'

// UI v2 Phase 2 · K-4 (canvas K5) — phần TRÌNH BÀY của /targets/campaigns/affiliate. page.tsx giữ toàn bộ cổng quyền
// (overviewPageScope, QLCH/SM boundary), truy vấn mapping (session/service theo scope), health FAIL-CLOSED và 2 RPC
// aggregate; component này chỉ nhận dữ liệu đã tính để route thật và fixture /ui-catalog/kpi-v2/affiliate dùng CHUNG
// một markup. Chữ giữ nguyên (câu "Nguồn: Circa Online · Chỉ tính đơn DELIVERED." chuyển từ chân trang lên phụ đề).
// Không bao giờ hiện số 0 giả: nguồn chưa sẵn sàng / aggregate lỗi ⇒ '—'.

const vnd = (n: number) => `${new Intl.NumberFormat('vi-VN').format(Math.round(n))}₫`
const FIELD = 'h-[44px] md:h-[40px] rounded-v2-control border border-input bg-card px-3 text-[16px] md:text-[14px] outline-none focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-primary/30'
const LABEL = 'text-[12px] text-v2-text-3'
const FS_CHIP = 'ml-1.5 inline-flex rounded-[6px] bg-muted px-1.5 py-0.5 align-middle text-[11px] font-medium text-muted-foreground'

export interface AffiliateOverviewRow {
  entity: OverviewEntity
  agg: { gmv: number; orders: number; lastDate: string | null }
}

export type AffiliateOverviewBody =
  | { kind: 'mapping-error'; message: string }
  | { kind: 'empty' }
  | {
      kind: 'data'
      clamped: boolean
      dataState: OverviewDataState
      healthReason: string | null
      healthLastSuccessAt: string | null
      aggErrorMsg: string | null
      totals: { gmv: number; orders: number; points: number }
      rows: AffiliateOverviewRow[]
      filteredCount: number
    }

export function AffiliateOverviewView({ scope, filter, body }: {
  scope: Exclude<OverviewPageScope, 'denied'>
  /** null ⇒ chưa dựng được bộ lọc (mapping lỗi). */
  filter: { from: string; to: string; typeFilter: OverviewTypeFilter; storeParam?: string; options: OverviewEntity[] } | null
  body: AffiliateOverviewBody
}) {
  return (
    <div data-ui-v2="page" data-layout-width="fluid" data-affiliate-overview={body.kind} className="p-4 md:p-6 space-y-4 md:space-y-[18px]">
      <PageHeader title="Doanh số Affiliate — Circa Online" subtitle="Nguồn: Circa Online · Chỉ tính đơn DELIVERED." icon={Link2} />
      {scope === 'os-fs'
        ? <CampaignsTabs active="affiliate" affiliateEnabled />
        : (scope === 'os-assigned' || scope === 'os-own')
          ? <Link href="/targets" className="inline-flex min-h-[44px] items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground md:min-h-0">← Doanh số</Link>
          : null}

      {body.kind === 'mapping-error' ? (
        // r1 P1#2: mapping lỗi → FAIL-CLOSED — chỉ ErrorState, không số 0 giả.
        <ErrorState
          message="Không tải được danh sách mapping affiliate — không thể tổng hợp doanh số"
          hint={`${body.message} — kiểm tra migration 090/095/096 và RLS, rồi tải lại.`}
        />
      ) : (
        <>
          {filter && <OverviewFilter scope={scope} filter={filter} />}
          {body.kind === 'empty' ? (
            <EmptyState className="py-12 rounded-v2-panel border border-dashed border-input bg-card" icon={Link2} title="Không có mapping affiliate nào khớp bộ lọc." />
          ) : (
            <OverviewData scope={scope} filter={filter!} body={body} />
          )}
        </>
      )}
    </div>
  )
}

function OverviewFilter({ scope, filter }: {
  scope: Exclude<OverviewPageScope, 'denied'>
  filter: { from: string; to: string; typeFilter: OverviewTypeFilter; storeParam?: string; options: OverviewEntity[] }
}) {
  return (
    <DataToolbar
      filters={
        <form method="GET" data-affiliate-filter className="flex flex-wrap items-end gap-2.5">
          <label className="grid gap-1">
            <span className={LABEL}>Từ ngày</span>
            <input type="date" name="from" defaultValue={filter.from} className={cn(FIELD, 'tabular-nums')} />
          </label>
          <label className="grid gap-1">
            <span className={LABEL}>Đến ngày</span>
            <input type="date" name="to" defaultValue={filter.to} className={cn(FIELD, 'tabular-nums')} />
          </label>
          {/* FS-expansion: filter Loại GIỮA thời gian và Cửa hàng — CHỈ super */}
          {scope === 'os-fs' && (
            <label className="grid gap-1">
              <span className={LABEL}>Loại</span>
              <select name="type" defaultValue={filter.typeFilter === 'all' ? '' : filter.typeFilter} className={FIELD}>
                <option value="">Tất cả</option>
                <option value="os">OS</option>
                <option value="fs">FS</option>
              </select>
            </label>
          )}
          <label className="grid gap-1">
            <span className={LABEL}>Cửa hàng</span>
            <select name="store" defaultValue={filter.storeParam ?? ''} className={cn(FIELD, 'max-w-[260px]')}>
              <option value="">Tất cả</option>
              {/* Option theo entity của Loại đang chọn (store đã dedupe; partner theo display_name) */}
              {filter.options.map((e) => (
                <option key={overviewEntityKey(e)} value={overviewEntityKey(e)}>
                  {e.kind === 'store' ? (e.name ?? e.partnerCodes[0]) : e.display_name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-[44px] rounded-v2-control px-4 text-[13px] md:h-[40px]')}>Áp dụng</button>
        </form>
      }
    />
  )
}

function OverviewData({ scope, filter, body }: {
  scope: Exclude<OverviewPageScope, 'denied'>
  filter: { from: string; to: string; typeFilter: OverviewTypeFilter }
  body: Extract<AffiliateOverviewBody, { kind: 'data' }>
}) {
  const { from, to } = filter
  const blocked = body.dataState !== 'ok'
  const { totals } = body
  return (
    <>
      {body.clamped && (
        <p className="text-[12px] text-muted-foreground">
          Khoảng ngày vượt giới hạn 366 ngày — đã thu hẹp còn {formatDate(from)} – {formatDate(to)}.
        </p>
      )}

      {/* Fail-closed theo trạng thái nguồn — không bao giờ render 0 giả */}
      {body.dataState === 'source-not-ready' && (
        <div title={scope === 'os-fs' ? (body.healthReason ?? undefined) : undefined}>
          <ErrorState
            message="Dữ liệu Affiliate chưa được cập nhật. Số liệu đang tạm ẩn."
            hint={body.healthLastSuccessAt
              ? `Đồng bộ gần nhất: ${formatDateTime(body.healthLastSuccessAt)}`
              : 'Chưa có lần đồng bộ thành công nào.'}
          />
        </div>
      )}
      {body.dataState === 'aggregate-error' && (
        <ErrorState message="Không tổng hợp được doanh số Affiliate" hint={body.aggErrorMsg ?? undefined} />
      )}

      {/* r1.3: đúng 3 KPI card cho khoảng thời gian đang xem — FS-expansion: card 3 đếm ĐIỂM khi view có FS */}
      <div data-affiliate-kpis className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label={`GMV Affiliate (${formatDate(from)} – ${formatDate(to)})`} value={blocked ? '—' : vnd(totals.gmv)} icon={TrendingUp} tone={!blocked && totals.gmv > 0 ? 'success' : 'default'} />
        <StatCard label="Đơn giao thành công" value={blocked ? '—' : totals.orders} icon={Package} />
        <StatCard label={salesPointsLabel(filter.typeFilter)} value={blocked ? '—' : `${totals.points}/${body.filteredCount}`} icon={StoreIcon} />
      </div>

      <DataTableShell>
        <Table data-affiliate-table>
          <TableHeader>
            <TableRow>
              {/* Drill-down (28/07): cột chevron — mở danh sách đơn DELIVERED */}
              <TableHead className="w-10 pl-1 pr-0" />
              <TableHead>Cửa hàng</TableHead>
              <TableHead className="text-right">Đơn thành công</TableHead>
              <TableHead className="text-right">GMV Affiliate</TableHead>
              <TableHead className="text-right pr-4">Đơn gần nhất</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {body.rows.map(({ entity: e, agg }) => {
              const has = agg.orders > 0
              const numberCells = (
                <>
                  <TableCell className={cn('text-right tabular-nums', !has && 'text-muted-foreground')}>
                    {blocked ? '—' : agg.orders}
                  </TableCell>
                  <TableCell className={cn('text-right tabular-nums font-medium', !has && 'text-muted-foreground font-normal')}>
                    {blocked ? '—' : has || agg.gmv !== 0 ? vnd(agg.gmv) : '—'}
                  </TableCell>
                  <TableCell className="text-right pr-4 text-muted-foreground tabular-nums">
                    {blocked ? '—' : agg.lastDate ? formatDate(agg.lastDate) : '—'}
                  </TableCell>
                </>
              )
              // Drill-down: client row lazy-load — store qua RPC 099 (mọi scope hợp lệ), FS partner qua RPC 102 (CHỈ
              // super — chevron cũng chỉ render ở scope os-fs); chevron CHỈ khi số parent thật (!blocked) + có đơn;
              // key gồm from/to → đổi filter hủy state.
              if (e.kind === 'store') {
                return (
                  <AffiliateStoreOrdersRow
                    key={`s-${e.store_id}-${from}-${to}`}
                    storeId={e.store_id}
                    from={from}
                    to={to}
                    canDrill={drilldownEnabled({ blocked, orders: agg.orders })}
                    expectedOrders={agg.orders}
                    expectedGmv={agg.gmv}
                    parentCells={
                      <>
                        <TableCell>
                          <span className="font-semibold">{e.name ?? '—'}</span>
                          <span className="text-[12px] text-muted-foreground"> · {e.code ?? '—'}</span>
                          {e.isFs && <span className={FS_CHIP}>FS</span>}
                          {/* r1.3 + r1 P2#4: partner codes = metadata đối soát */}
                          <span className="block font-mono text-[11px] text-v2-text-3">{e.partnerCodes.join(' · ')}</span>
                        </TableCell>
                        {numberCells}
                      </>
                    }
                  />
                )
              }
              // FS partner (không store): KHÔNG QR, KHÔNG liên quan FS Products.
              return (
                <AffiliateStoreOrdersRow
                  key={`p-${e.partner_code}-${from}-${to}`}
                  partnerCode={e.partner_code}
                  from={from}
                  to={to}
                  canDrill={scope === 'os-fs' && drilldownEnabled({ blocked, orders: agg.orders })}
                  expectedOrders={agg.orders}
                  expectedGmv={agg.gmv}
                  parentCells={
                    <>
                      <TableCell>
                        <span className="font-semibold">{e.display_name}</span>
                        <span className={FS_CHIP}>FS</span>
                        <span className="block font-mono text-[11px] text-v2-text-3">{e.partner_code}</span>
                      </TableCell>
                      {numberCells}
                    </>
                  }
                />
              )
            })}
          </TableBody>
        </Table>
      </DataTableShell>
    </>
  )
}
