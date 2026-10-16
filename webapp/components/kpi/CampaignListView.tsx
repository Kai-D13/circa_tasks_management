import Link from 'next/link'
import { Megaphone, Plus, ChevronRight } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/ds/PageHeader'
import { EmptyState } from '@/components/ds/EmptyState'
import { ErrorState } from '@/components/ds/ErrorState'
import { StatusBadge, type StatusTone } from '@/components/ds/StatusBadge'
import { TagBadge, type TagHue } from '@/components/ds/TagBadge'
import { ProgressBar } from '@/components/ds/ProgressBar'
import { CampaignsTabs } from '@/components/kpi/CampaignsTabs'
import { CampaignStatusButton } from '@/components/kpi/CampaignStatusButton'
import { campaignEmptyText, campaignStatusTabs, type CampaignStatusFilter } from '@/lib/kpi/campaignAccess'
import { CARD_TYPE_LABEL, metricPresentation, type CampaignOverviewValue, type CampaignMetricType } from '@/lib/kpi/campaignDisplay'
import { STATUS_META } from '@/lib/kpi/status'
import type { KpiProgressTone } from '@/lib/kpi/progressTone'
import { campaignListTone } from '@/lib/kpi/campaignList'
import { formatDate, formatDateTime } from '@/lib/dateUtils'
import { cn } from '@/lib/utils'

// UI v2 Phase 2 · K-1 (canvas K1) — phần TRÌNH BÀY của /targets/campaigns. page.tsx giữ nguyên cổng quyền,
// 3 truy vấn và phần gộp số (campaignOverviewValue); component này chỉ nhận dữ liệu đã tính để route thật và
// fixture catalog (/ui-catalog/kpi-v2/campaigns) dùng CHUNG một markup. Tự mang gốc data-ui-v2="page".
//
// Hợp đồng hiển thị (spec PM §2):
//   - campaignsError (truy vấn chính lỗi) ⇒ CHỈ ErrorState — không danh sách, không câu "chưa có chiến dịch".
//   - sideError (target/actual lỗi) ⇒ ErrorState + danh sách KHÔNG số: giá trị '—', thanh chưa đồng bộ, meta bỏ
//     "N cửa hàng / Đồng bộ …" (số 0 từ truy vấn hỏng không được đọc như dữ liệu thật).
//   - Chưa đồng bộ ⇒ '—' + thanh nét đứt (không 0% giả).
//   - Chiến dịch Đang chạy được LÀM NỔI bằng style, KHÔNG đổi thứ tự / bộ lọc (PM UI-K1).

export interface CampaignListRow {
  id: string
  name: string
  start_date: string
  end_date: string
  status: string
  is_test: boolean
  metric_type?: string
  stores: number
  lastSync: string | null
  ov: CampaignOverviewValue
  /** Đạt mục tiêu tính từ số THÔ (campaignListReached) — KHÔNG suy từ ov.pct đã làm tròn. */
  reached: boolean
  /** % của dòng (campaignListPct): raw THÔ cho thanh/ARIA (null ⇒ '—', không thanh), text 1 chữ số / "<100%". */
  progress: { raw: number | null; text: string }
}

export interface CampaignListCounts { total: number; active: number; paused: number; draft: number; ended: number }

const STATUS_TONE: Record<string, StatusTone> = { active: 'success', paused: 'warning', draft: 'neutral', ended: 'neutral' }
const TYPE_HUE: Record<CampaignMetricType, TagHue> = { gmv: 'blue', affiliate_customer_count: 'teal', offline_order_aov: 'indigo' }
const FILTER_DOT: Record<CampaignStatusFilter, string> = {
  all: 'bg-muted-foreground', active: 'bg-status-success', paused: 'bg-status-warning', draft: 'bg-v2-text-3', ended: 'bg-status-neutral',
}
const drange = (s: string, e: string) => `${formatDate(s)} – ${formatDate(e)}`
const CREATE_BTN = cn(buttonVariants({ size: 'sm' }), 'h-[44px] md:h-[36px] px-3.5 text-[13px] font-semibold')

// Luật màu thanh: lib/kpi/campaignList.campaignListTone (chưa đồng bộ nét đứt; đạt xanh kể cả đã kết thúc — K1;
// đã kết thúc chưa đạt ⇒ --v2-text-3; còn lại màu chuỗi).

function RowProgress({ tone, raw, text, size }: { tone: KpiProgressTone; raw: number; text: string; size: 6 | 10 }) {
  return (
    <div data-campaign-progress={tone} className="flex items-center gap-2.5">
      {tone === 'unsynced' ? (
        <div aria-hidden="true" className={cn(size === 10 ? 'h-[10px]' : 'h-[6px]', 'flex-1 rounded-full border border-dashed border-input bg-muted')} />
      ) : (
        <ProgressBar value={raw} max={100} tone={tone} size={size} ariaLabel={`Hoàn thành ${text}`} className="flex-1" />
      )}
      <span className="w-14 shrink-0 text-right text-[13px] font-semibold tabular-nums">{tone === 'unsynced' ? '—' : text}</span>
    </div>
  )
}

export function CampaignListView({
  canManage, affiliateEnabled, statusFilter, counts, rows, hasAny, campaignsError, sideError,
}: {
  canManage: boolean
  affiliateEnabled: boolean
  statusFilter: CampaignStatusFilter
  counts: CampaignListCounts
  /** Đã lọc theo tab trạng thái, giữ thứ tự truy vấn. */
  rows: CampaignListRow[]
  /** Người xem có ít nhất 1 chiến dịch (toàn tập, không theo tab). */
  hasAny: boolean
  campaignsError: string | null
  sideError: string | null
}) {
  const tabHref = (k: string) => k === 'all' ? '/targets/campaigns' : `/targets/campaigns?status=${k}`
  const queryError = campaignsError ?? sideError

  return (
    <div data-ui-v2="page" data-layout-width="fluid" data-campaign-list className="p-4 md:p-6 space-y-4 md:space-y-[18px]">
      <PageHeader
        title="Chiến dịch KPI"
        icon={Megaphone}
        actions={canManage ? (
          <Link href="/targets/campaigns/new" className={CREATE_BTN}>
            <Plus className="h-4 w-4 mr-1" /> Tạo chiến dịch
          </Link>
        ) : undefined}
      />

      {/* P3-I: tab Affiliate overview — chỉ render khi KPI_AFFILIATE_ENABLED */}
      <CampaignsTabs active="campaigns" affiliateEnabled={affiliateEnabled} />

      {queryError && (
        <ErrorState message={`Lỗi truy vấn dữ liệu campaign: ${queryError}`} hint="Kiểm tra migration 070/071/072 đã apply chưa." />
      )}

      {/* Lọc theo trạng thái = thẻ có số đếm (K1). Server <Link>, giữ trong URL. Số đếm tính trên TOÀN TẬP người
          xem được, không theo tab. SM chỉ có 3 thẻ (Nháp/Tạm dừng luôn rỗng với họ — RLS 111). */}
      {!campaignsError && hasAny && (
        <nav
          aria-label="Lọc chiến dịch theo trạng thái"
          className={cn('grid gap-2.5', canManage ? 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5' : 'grid-cols-3')}
        >
          {campaignStatusTabs(canManage).map((t) => {
            const active = t.key === statusFilter
            return (
              <Link
                key={t.key}
                href={tabHref(t.key)}
                aria-current={active ? 'page' : undefined}
                data-status-filter={t.key}
                className={cn(
                  'flex min-h-[44px] flex-col gap-1 rounded-v2-panel border bg-card px-4 py-3 transition-colors hover:bg-muted/60',
                  active && 'border-v2-selected-line bg-accent hover:bg-accent',
                )}
              >
                <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
                  <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', FILTER_DOT[t.key])} />
                  {t.label}
                </span>
                <span className="text-[24px] font-bold leading-tight tabular-nums">{t.key === 'all' ? counts.total : counts[t.key]}</span>
              </Link>
            )
          })}
        </nav>
      )}

      {campaignsError ? null : rows.length === 0 ? (
        <EmptyState
          className="py-12 rounded-v2-panel border border-dashed border-input bg-card"
          icon={Megaphone}
          title={campaignEmptyText(statusFilter, canManage, hasAny)}
        />
      ) : (
        <>
          {/* Desktop: bảng 4 cột (K1), bảng tự cuộn ngang trong khung */}
          <div className="hidden md:block overflow-hidden rounded-v2-panel border bg-card">
            <div className="overflow-x-auto">
              <table data-campaign-table className="w-full min-w-[860px] text-[13px]">
                <thead className="bg-muted">
                  <tr className="text-left whitespace-nowrap">
                    <th className="pl-5 pr-3 py-2.5 text-[12px] font-medium text-muted-foreground">Chiến dịch</th>
                    <th className="px-3 py-2.5 text-[12px] font-medium text-muted-foreground text-right w-[260px]">Đã đạt / Mục tiêu</th>
                    <th className="px-3 py-2.5 text-[12px] font-medium text-muted-foreground w-[220px]">Hoàn thành</th>
                    <th className="pl-3 pr-5 py-2.5 text-[12px] font-medium text-muted-foreground text-right">Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => {
                    const synced = c.lastSync !== null && !sideError
                    // Không có tỷ lệ (chưa đồng bộ / không mẫu số / lỗi phụ) ⇒ trình bày như chưa đồng bộ: '—', không thanh.
                    const tone = synced && c.progress.raw !== null ? campaignListTone({ synced, reached: c.reached, status: c.status }) : 'unsynced'
                    const isActive = c.status === 'active'
                    return (
                      <tr key={c.id} data-campaign-row={c.status} className={cn('border-t align-middle', isActive && 'bg-accent/60')}>
                        <td className="pl-5 pr-3 py-3">
                          <RowHead c={c} sideError={!!sideError} big={isActive} />
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">
                          <ValueLines ov={c.ov} sideError={!!sideError} hideGmvLabel />
                        </td>
                        <td className="px-3 py-3">
                          <RowProgress tone={tone} raw={c.progress.raw ?? 0} text={c.progress.text} size={isActive ? 10 : 6} />
                        </td>
                        <td className="pl-3 pr-5 py-3">
                          <RowActions c={c} canManage={canManage} />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile: thẻ — tiền + thanh luôn thấy (màn tiền) */}
          <ul data-campaign-cards className="md:hidden space-y-2.5">
            {rows.map((c) => {
              const synced = c.lastSync !== null && !sideError
              const tone = synced && c.progress.raw !== null ? campaignListTone({ synced, reached: c.reached, status: c.status }) : 'unsynced'
              const isActive = c.status === 'active'
              return (
                <li
                  key={c.id}
                  data-campaign-card={c.status}
                  className={cn('space-y-2.5 rounded-v2-panel border bg-card p-4', isActive && 'border-v2-selected-line')}
                >
                  <RowHead c={c} sideError={!!sideError} big={isActive} />
                  <div className="text-[13px] tabular-nums"><ValueLines ov={c.ov} sideError={!!sideError} /></div>
                  <RowProgress tone={tone} raw={c.progress.raw ?? 0} text={c.progress.text} size={isActive ? 10 : 6} />
                  <RowActions c={c} canManage={canManage} />
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}

function RowHead({ c, sideError, big }: { c: CampaignListRow; sideError: boolean; big: boolean }) {
  const s = STATUS_META[c.status] ?? STATUS_META.draft
  const kind = metricPresentation(c.metric_type).kind
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/targets/campaigns/${c.id}`}
          className={cn('min-w-0 font-semibold hover:underline [overflow-wrap:anywhere]', big ? 'text-[16px]' : 'text-[14px]')}
        >
          {c.name}
        </Link>
        <StatusBadge tone={STATUS_TONE[c.status] ?? 'neutral'} size="sm">{s.label}</StatusBadge>
        <TagBadge hue={TYPE_HUE[kind]}>{CARD_TYPE_LABEL[kind]}</TagBadge>
        {c.is_test && <StatusBadge tone="info" size="sm">TEST</StatusBadge>}
      </div>
      <p className="text-[12px] text-v2-text-3">
        {drange(c.start_date, c.end_date)}
        {!sideError && <>{` · ${c.stores} cửa hàng`}{c.lastSync ? ` · Đồng bộ ${formatDateTime(c.lastSync)}` : ' · Chưa đồng bộ'}</>}
      </p>
    </div>
  )
}

// Dòng giá trị từ campaignOverviewValue (một nguồn với màn SM). Desktop: cột đã có tiêu đề "Đã đạt / Mục tiêu"
// nên dòng cùng nhãn chỉ hiện số; các nhãn khác (Chất lượng bán hàng: "Đạt KPI", "Thực tế") vẫn hiện.
function ValueLines({ ov, sideError, hideGmvLabel = false }: { ov: CampaignOverviewValue; sideError: boolean; hideGmvLabel?: boolean }) {
  if (sideError) return <p data-campaign-value>—</p>
  return (
    <div data-campaign-value className="space-y-0.5">
      {ov.lines.map((l) => (
        <p key={l.label}>
          {!(hideGmvLabel && l.label === 'Đã đạt / Mục tiêu') && <span className="text-muted-foreground">{l.label}: </span>}
          <span className="font-semibold">{l.value}</span>
        </p>
      ))}
    </div>
  )
}

function RowActions({ c, canManage }: { c: CampaignListRow; canManage: boolean }) {
  return (
    <div className="flex items-center justify-end gap-1.5">
      {/* Đổi trạng thái là hành vi QUẢN TRỊ — SM chỉ xem. */}
      {canManage && <CampaignStatusButton id={c.id} status={c.status} name={c.name} />}
      <Link
        href={`/targets/campaigns/${c.id}`}
        aria-label={`Xem ${c.name}`}
        className="inline-flex size-[44px] md:size-[32px] items-center justify-center rounded-[8px] text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <ChevronRight className="h-4 w-4" />
      </Link>
    </div>
  )
}
