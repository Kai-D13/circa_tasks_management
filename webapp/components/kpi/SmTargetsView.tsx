import Link from 'next/link'
import { History, TrendingUp } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/ds/PageHeader'
import { ErrorState } from '@/components/ds/ErrorState'
import { EmptyState } from '@/components/ds/EmptyState'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { TagBadge } from '@/components/ds/TagBadge'
import { AffiliateGmvCard } from '@/components/affiliate/AffiliateGmvCard'
import { CampaignDateRangeFilter } from '@/components/kpi/CampaignDateRangeFilter'
import { CampaignResultDashboard } from '@/components/kpi/CampaignResultDashboard'
import { TYPE_HUE } from '@/components/kpi/CampaignListView'
import { RegionalCampaignOverviewList, deadlineTone, type RegionalCampaignItem } from '@/components/kpi/RegionalCampaignOverviewList'
import { CARD_TYPE_LABEL, metricPresentation } from '@/lib/kpi/campaignDisplay'
import type { CampaignRange } from '@/lib/kpi/campaignDateRange'
import type { CampaignResultModel, ResultCampaign } from '@/lib/kpi/resultModel'
import { formatDate, formatDateTime } from '@/lib/dateUtils'
import { cn } from '@/lib/utils'

// UI v2 Phase 2 · K-5 (canvas K6 desktop / M6 mobile) — phần TRÌNH BÀY nhánh SM của /targets. page.tsx giữ nguyên auth,
// truy vấn (store phân công, target/actual RLS 075, health + aggregate Affiliate), gom theo chiến dịch và model; view chỉ
// nhận dữ liệu đã tính. Route thật và fixture /ui-catalog/kpi-v2/sm dùng chung. Chữ giữ nguyên bản cũ. Read-only: không
// có nút quản trị / đồng bộ nào (SM r2).

const TITLE = 'Doanh số chiến dịch'
// Câu cũ của màn chi tiết SM; canvas K6/M6 đặt thêm ở cuối danh sách.
export const SM_READONLY_NOTE = 'Chế độ xem Quản lý vùng — chỉ đọc · số liệu giới hạn trong các cửa hàng bạn quản lý.'
const BACK_LINK = 'inline-flex min-h-[44px] items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground md:min-h-0'

function Shell({ kind, children }: { kind: 'landing' | 'detail' | 'error' | 'out-of-scope'; children: React.ReactNode }) {
  return (
    <div data-ui-v2="page" data-layout-width="fluid" data-sm-targets={kind} className="p-4 md:p-6 space-y-4 md:space-y-[18px]">
      {children}
    </div>
  )
}

/** r3: lỗi query store / dữ liệu chiến dịch ⇒ ErrorState, KHÔNG redirect hay "chưa có chiến dịch" giả. */
export function SmTargetsErrorView({ message, hint }: { message: string; hint: string }) {
  return (
    <Shell kind="error">
      <PageHeader title={TITLE} icon={TrendingUp} />
      <ErrorState message={message} hint={hint} />
    </Shell>
  )
}

/** r3: ?campaign= ngoài phạm vi SM ⇒ forbidden, KHÔNG fallback dữ liệu khác. */
export function SmTargetsOutOfScopeView() {
  return (
    <Shell kind="out-of-scope">
      <PageHeader title={TITLE} icon={TrendingUp} />
      <Link href="/targets" className={BACK_LINK}>← Danh sách chiến dịch</Link>
      <ErrorState
        message="Chiến dịch không thuộc phạm vi quản lý của bạn"
        hint="Kiểm tra lại đường dẫn hoặc quay về danh sách chiến dịch."
      />
    </Shell>
  )
}

/** Props dải GMV Affiliate vùng — CHÍNH props AffiliateGmvCard variant="strip" (fail-closed: error/sourceWarning ⇒ '—'). */
export interface SmGmvStrip {
  monthLabel: string
  gmv: number
  orders: number
  storesWithSales: number
  storeCount: number
  syncedAt: string | null
  error: boolean
  sourceWarning: string | null
}

export function SmTargetsLandingView({ stores, gmv, items }: {
  /** Store phân công (đã validate server-side) — chip TĨNH, không phải bộ lọc (SM r6). */
  stores: { id: string; name: string }[]
  /** null ⇒ không render dải (cờ tắt / 0 store — smRegionalGmvVisible). */
  gmv: SmGmvStrip | null
  /** Đã sắp hạn gần nhất lên đầu. */
  items: RegionalCampaignItem[]
}) {
  return (
    <Shell kind="landing">
      <PageHeader
        title={TITLE}
        icon={TrendingUp}
        subtitle={`Phạm vi: ${stores.length} cửa hàng bạn quản lý`}
        /* 111: lối vào lịch sử chiến dịch — đặt ở header thay vì thêm mục sidebar thứ hai cùng chủ đề. */
        actions={
          <Link
            href="/targets/campaigns?status=ended"
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-[44px] px-3.5 text-[13px] md:h-[36px]')}
          >
            <History className="h-4 w-4 mr-1.5" /> Lịch sử chiến dịch
          </Link>
        }
      />
      {/* r2.4 (audit P2#4): phạm vi quản lý — chip TĨNH. Mobile: một hàng cuộn ngang trong khung (không tràn trang). */}
      {stores.length > 0 && (
        <div data-sm-scope className="-mx-4 flex items-center gap-1.5 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:overflow-visible md:px-0">
          <span className="shrink-0 text-[12px] text-muted-foreground">Phạm vi quản lý:</span>
          {stores.map((s) => (
            <span key={s.id} className="max-w-[180px] shrink-0 truncate rounded-v2-chip bg-muted px-2.5 py-1 text-[12px] font-medium text-muted-foreground">
              {s.name}
            </span>
          ))}
        </div>
      )}

      {/* r2.4: GMV Affiliate REGIONAL = dải ngang trên danh sách (cùng data/props/fail-closed của AffiliateGmvCard,
          variant="strip"; QLCH vẫn dùng bản card). KHÔNG QR, KHÔNG nút sync. */}
      {gmv && (
        <AffiliateGmvCard
          monthLabel={gmv.monthLabel}
          gmv={gmv.gmv}
          orders={gmv.orders}
          storesWithSales={gmv.storesWithSales}
          storeCount={gmv.storeCount}
          syncedAt={gmv.syncedAt}
          error={gmv.error}
          sourceWarning={gmv.sourceWarning}
          detailHref="/targets/campaigns/affiliate"
          regional
          variant="strip"
        />
      )}

      {items.length === 0 ? (
        <EmptyState className="py-12" icon={TrendingUp} title="Chưa có chiến dịch nào áp dụng cho các cửa hàng bạn quản lý." />
      ) : (
        <RegionalCampaignOverviewList items={items} hrefFor={(cid) => `/targets?campaign=${cid}`} />
      )}
      <p className="text-[12px] text-v2-text-3">{SM_READONLY_NOTE}</p>
    </Shell>
  )
}

/**
 * K-5b — chi tiết SM `/targets?campaign=` (chỉ đọc, LUÔN tổng hợp toàn phạm vi SM — r6). Khung header + thanh công cụ
 * theo chi tiết K-2 (canvas K2) và CHÍNH `CampaignResultDashboard layout="v2"`. Không nút Xuất/Đồng bộ (SM ở /targets
 * trước giờ không có; Xuất Excel của SM nằm ở /targets/campaigns/[id]). Bộ lọc khoảng `bare` chỉ khi page cho phép
 * (rangeFilterVisibleForRole), giữ đúng `?campaign=` (r6 bỏ `?store=`).
 */
export function SmTargetsDetailView({ campaign, storeCount, model, filter }: {
  campaign: ResultCampaign
  /** Số store của chiến dịch ∩ phạm vi SM (entry.targets.length). */
  storeCount: number
  model: CampaignResultModel
  /** null ⇒ không render bộ lọc. */
  filter: { range: CampaignRange; note: string | null; campaignParam: string } | null
}) {
  const kind = metricPresentation(campaign.metric_type).kind
  const lastSynced = model.lastSyncedAt
  return (
    <Shell kind="detail">
      <div>
        <Link href="/targets" className={BACK_LINK}>← Danh sách chiến dịch</Link>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="min-w-0 text-[22px] font-bold leading-tight tracking-[-0.01em] [overflow-wrap:anywhere] md:text-[24px]">{campaign.name}</h1>
          <StatusBadge tone={deadlineTone(campaign.status, model.deadlineLabel)} size="sm">{model.deadlineLabel}</StatusBadge>
          <TagBadge hue={TYPE_HUE[kind]}>{CARD_TYPE_LABEL[kind]}</TagBadge>
        </div>
        <p className="mt-1 text-[13px] text-v2-text-3">
          {formatDate(campaign.start_date)} – {formatDate(campaign.end_date)} · {storeCount} cửa hàng thuộc phạm vi bạn quản lý
        </p>
      </div>

      {/* Thanh công cụ như K-2 (trạng thái đồng bộ · lọc khoảng) — không có nút quản trị. */}
      <div data-result-toolbar className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-v2-panel border bg-card px-4 py-3">
        <span className={cn(
          'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium',
          lastSynced ? 'bg-status-success-bg text-status-success' : 'bg-status-warning-bg text-status-warning',
        )}>
          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', lastSynced ? 'bg-status-success' : 'bg-status-warning')} />
          {lastSynced ? `Doanh số đồng bộ ${formatDateTime(lastSynced)}` : 'Chưa đồng bộ doanh số'}
        </span>
        {filter && (
          <CampaignDateRangeFilter
            bare
            action="/targets"
            campaignStart={campaign.start_date}
            campaignEnd={campaign.end_date}
            range={filter.range}
            keepParams={{ campaign: filter.campaignParam }}
            note={filter.note}
          />
        )}
      </div>

      <CampaignResultDashboard model={model} layout="v2" emptyHint="Chưa có dữ liệu kết quả trong phạm vi của bạn." />
      <p className="text-[12px] text-v2-text-3">{SM_READONLY_NOTE}</p>
    </Shell>
  )
}
