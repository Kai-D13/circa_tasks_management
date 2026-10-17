import Link from 'next/link'
import { ChevronLeft, SlidersHorizontal, BarChart3, type LucideIcon } from 'lucide-react'
import { Panel } from '@/components/ds/Panel'
import { EmptyState } from '@/components/ds/EmptyState'
import { ErrorState } from '@/components/ds/ErrorState'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { TagBadge } from '@/components/ds/TagBadge'
import { CampaignStatusButton } from '@/components/kpi/CampaignStatusButton'
import { CampaignImport } from '@/components/kpi/CampaignImport'
import { CampaignMetricEditor } from '@/components/kpi/CampaignMetricEditor'
import { SyncActualsButton } from '@/components/kpi/SyncActualsButton'
import { CampaignExportButton } from '@/components/kpi/CampaignExportButton'
import { CampaignResultDashboard } from '@/components/kpi/CampaignResultDashboard'
import { CampaignDateRangeFilter } from '@/components/kpi/CampaignDateRangeFilter'
import { STATUS_TONE, TYPE_HUE } from '@/components/kpi/CampaignListView'
import { CARD_TYPE_LABEL, metricPresentation } from '@/lib/kpi/campaignDisplay'
import type { CampaignRange } from '@/lib/kpi/campaignDateRange'
import type { CampaignResultModel } from '@/lib/kpi/resultModel'
import { STATUS_META } from '@/lib/kpi/status'
import { formatDate, formatDateTime } from '@/lib/dateUtils'
import { cn } from '@/lib/utils'

// UI v2 Phase 2 · K-2 (canvas K2 Kết quả + K3 Cấu hình) — phần TRÌNH BÀY của /targets/campaigns/[id]. page.tsx giữ
// cổng quyền, truy vấn, chọn tab, lọc khoảng ngày và dựng CampaignResultModel; component này chỉ nhận dữ liệu đã
// tính để route thật và fixture catalog (/ui-catalog/kpi-v2/detail) dùng CHUNG một markup. Gốc data-ui-v2="page".
// Chữ giữ nguyên bản cũ; nút/handler là CHÍNH các component cũ (CampaignStatusButton, Import, MetricEditor, Export,
// Sync). SM (canManage=false): không thanh tab, không nút ghi, vẫn có Xuất Excel.

export interface DetailTierRow { tier_order: number; threshold_pct: number; commission_amount: number }
export interface DetailTargetRow {
  id: string; store_id: string; pos_code: string | null; kpi_target: number
  store_kpi_group: string | null
  stores: { name: string } | null
  kpi_campaign_store_tiers: DetailTierRow[]
  // Mig 106 — chỉ campaign Chất lượng bán hàng (NULL với 2 loại cũ).
  order_target: number | null; aov_target: number | null
  // Mig 112 — thưởng thêm theo ngưỡng số đơn (NULL = campaign không áp dụng).
  minimum_order_target: number | null; order_bonus_per_staff: number | null
}
export interface DetailRun { file_name: string | null; row_count: number; success_count: number; created_at: string }
export interface DetailCampaign {
  id: string; name: string; start_date: string; end_date: string; status: string; is_test: boolean
  metric_type?: string; metric_offline: boolean; metric_affiliate: boolean
}

const vnd = (n: number) => `${new Intl.NumberFormat('vi-VN').format(Math.round(n))}₫`
const SEG = 'inline-flex min-h-[44px] items-center gap-1.5 rounded-[8px] border px-3.5 text-[13px] font-medium transition-colors md:min-h-0 md:h-[32px]'

function TierChips({ tiers }: { tiers: DetailTierRow[] }) {
  if (tiers.length === 0) return <span className="text-xs text-muted-foreground">—</span>
  return (
    <div className="flex flex-wrap gap-1">
      {[...tiers].sort((a, b) => a.tier_order - b.tier_order).map((t) => (
        <span key={t.tier_order} className="inline-flex whitespace-nowrap rounded-[6px] bg-muted px-2 py-[3px] text-[12px] tabular-nums">
          {t.threshold_pct}% → {vnd(t.commission_amount)}
        </span>
      ))}
    </div>
  )
}

export function CampaignDetailView({
  campaign: c, canManage, tab, targets, runs, queryError, affiliateEnabled, model, lastSynced, filter,
}: {
  campaign: DetailCampaign
  canManage: boolean
  tab: 'config' | 'result'
  targets: DetailTargetRow[]
  runs: DetailRun[]
  queryError: string | null
  affiliateEnabled: boolean
  model: CampaignResultModel
  lastSynced: string | null
  /** null ⇒ vai này không có bộ lọc khoảng (rangeFilterVisibleForRole). */
  filter: { range: CampaignRange; note: string | null } | null
}) {
  const s = STATUS_META[c.status] ?? STATUS_META.draft
  const kind = metricPresentation(c.metric_type).kind
  const canImport = c.status === 'draft' || c.status === 'paused'
  // 107: 'Phân loại' là TÙY CHỌN — mọi store trống ⇒ bỏ hẳn cột. 112: không áp dụng thưởng thêm ⇒ 2 cột không xuất hiện.
  const showGroupCol = targets.some((t) => (t.store_kpi_group ?? '').trim().length > 0)
  const showBonusCols = targets.some((t) => t.minimum_order_target != null)
  // Mig 103: KPI target theo đơn vị metric (khách/₫); TierChips (commission) luôn tiền.
  const targetFmt = (n: number) => metricPresentation(c.metric_type).value(n)

  const tabLink = (t: 'config' | 'result', label: string, Icon: LucideIcon) => (
    <Link
      href={`/targets/campaigns/${c.id}?tab=${t}`}
      aria-current={tab === t ? 'page' : undefined}
      data-detail-tab={t}
      className={cn(SEG, tab === t
        ? 'border-input bg-card font-semibold text-foreground'
        : 'border-transparent text-muted-foreground hover:text-foreground')}
    >
      <Icon className="h-4 w-4" />
      {label}
    </Link>
  )

  return (
    <div data-ui-v2="page" data-layout-width="fluid" data-campaign-detail={tab} className="p-4 md:p-6 space-y-4 md:space-y-[18px]">
      <div>
        <Link href="/targets/campaigns" className="inline-flex min-h-[44px] items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground md:min-h-0">
          <ChevronLeft className="h-3.5 w-3.5" /> Chiến dịch KPI
        </Link>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          {/* basis 280px: không đủ chỗ thì nhóm tab/nút XUỐNG DÒNG thay vì ép tiêu đề thành cột hẹp (mobile 390). */}
          <div className="min-w-0 flex-[1_1_280px]">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="min-w-0 text-[22px] font-bold leading-tight tracking-[-0.01em] [overflow-wrap:anywhere] md:text-[24px]">{c.name}</h1>
              <StatusBadge tone={STATUS_TONE[c.status] ?? 'neutral'} size="sm">{s.label}</StatusBadge>
              <TagBadge hue={TYPE_HUE[kind]}>{CARD_TYPE_LABEL[kind]}</TagBadge>
              {c.is_test && <StatusBadge tone="info" size="sm">TEST</StatusBadge>}
            </div>
            <p className="mt-1 text-[13px] text-v2-text-3">
              {formatDate(c.start_date)} – {formatDate(c.end_date)} · {targets.length} cửa hàng · {model.deadlineLabel}
            </p>
          </div>
          {canManage && (
            <div className="flex flex-wrap items-center gap-2">
              {/* Tabs — một URL, hai màn. SM chỉ có Kết quả nên KHÔNG render thanh tab. */}
              <nav aria-label="Màn chiến dịch" className="inline-flex gap-1 rounded-v2-control bg-muted p-1">
                {tabLink('config', 'Cấu hình', SlidersHorizontal)}
                {tabLink('result', 'Kết quả', BarChart3)}
              </nav>
              <CampaignStatusButton id={c.id} status={c.status} name={c.name} />
            </div>
          )}
        </div>
      </div>

      {queryError && (
        <ErrorState message={`Lỗi truy vấn dữ liệu: ${queryError}`} hint="Kiểm tra migration 070/071/072/092/093 đã apply chưa." />
      )}

      {tab === 'config' ? (
        <>
          <div className={cn('grid items-start gap-4', canImport && 'lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]')}>
            {/* P3-E3: chỉ số doanh số — sửa khi draft/paused, read-only khi active/ended; server action là boundary cuối. */}
            <Panel title={c.metric_type === 'affiliate_customer_count' ? 'Loại chỉ số' : 'Chỉ số doanh số'}>
              <CampaignMetricEditor
                campaignId={c.id}
                status={c.status}
                metricOffline={c.metric_offline === true}
                metricAffiliate={c.metric_affiliate === true}
                affiliateEnabled={affiliateEnabled}
                metricType={c.metric_type}
              />
            </Panel>
            {canImport && (
              <Panel title="Nạp / cập nhật target (thay toàn bộ)">
                <CampaignImport campaignId={c.id} guideDefaultOpen={targets.length === 0} metricType={c.metric_type} />
              </Panel>
            )}
          </div>

          {targets.length > 0 ? (
            <Panel flush>
              <div className="overflow-x-auto">
                <table data-target-table className="w-full text-[13px]">
                  <thead>
                    <tr className="bg-muted text-left text-[12px] text-muted-foreground whitespace-nowrap">
                      <th className="px-5 py-2.5 font-medium">Cửa hàng</th>
                      {/* 107: cùng cờ với body ngay dưới — bỏ cột thì bỏ cả hai phía. */}
                      {showGroupCol && <th className="px-4 py-2.5 font-medium">Phân loại</th>}
                      <th className="px-4 py-2.5 text-right font-medium">KPI target</th>
                      <th className="px-4 py-2.5 font-medium">Bậc (mốc % → Commission)</th>
                      {/* 112: cùng cờ với body — hai cột đi cùng nhau, riêng với Commission. */}
                      {showBonusCols && <th className="whitespace-nowrap px-4 py-2.5 text-right font-medium">Ngưỡng đơn</th>}
                      {showBonusCols && <th className="whitespace-nowrap px-5 py-2.5 text-right font-medium">Thưởng thêm/dược sĩ</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {targets.map((t) => (
                      <tr key={t.id} className="hover:bg-muted/40">
                        <td className="px-5 py-2.5 font-medium">{t.stores?.name ?? '—'}{t.pos_code ? ` · ${t.pos_code}` : ''}</td>
                        {showGroupCol && <td className="px-4 py-2.5 text-[12px]">{t.store_kpi_group ?? '—'}</td>}
                        <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">{targetFmt(t.kpi_target)}</td>
                        <td className="px-4 py-2.5"><TierChips tiers={t.kpi_campaign_store_tiers} /></td>
                        {showBonusCols && (
                          <td className="px-4 py-2.5 text-right tabular-nums">
                            {t.minimum_order_target != null ? `${new Intl.NumberFormat('vi-VN').format(t.minimum_order_target)} đơn` : '—'}
                          </td>
                        )}
                        {showBonusCols && (
                          <td className="px-5 py-2.5 text-right tabular-nums">
                            {t.order_bonus_per_staff != null ? vnd(t.order_bonus_per_staff) : '—'}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          ) : (
            <EmptyState className="rounded-v2-panel border border-dashed border-input bg-card py-10" title="Chưa có target. Nạp file để thêm." />
          )}

          {runs.length > 0 && (
            <Panel title="Lịch sử nạp file" flush>
              <ul data-import-runs className="divide-y text-[13px]">
                {runs.map((r, i) => (
                  <li key={i} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 px-5 py-2.5">
                    <span className="tabular-nums text-v2-text-3">{formatDateTime(r.created_at)}</span>
                    <span className="truncate" title={r.file_name ?? undefined}>{r.file_name ?? '—'}</span>
                    <span className="tabular-nums">{r.success_count}/{r.row_count} dòng</span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </>
      ) : (
        <>
          {/* ── Kết quả: thanh công cụ (trạng thái đồng bộ · lọc khoảng · Xuất / Đồng bộ) ── */}
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
                action={`/targets/campaigns/${c.id}`}
                campaignStart={c.start_date}
                campaignEnd={c.end_date}
                range={filter.range}
                keepParams={{ tab: 'result' }}
                note={filter.note}
              />
            )}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {/* Xuất Excel: SM ĐƯỢC (chốt 30/08) — route export dùng session client, RLS lọc sẵn.
                  Đồng bộ thủ công là hành vi quản trị ⇒ super-only. */}
              <CampaignExportButton campaignId={c.id} />
              {canManage && <SyncActualsButton campaignId={c.id} metricType={c.metric_type} />}
            </div>
          </div>
          <CampaignResultDashboard model={model} layout="v2" emptyHint="Chưa có target — nạp file ở tab Cấu hình trước." />
        </>
      )}
    </div>
  )
}
