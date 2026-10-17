import Link from 'next/link'
import { StatusBadge, type StatusTone } from '@/components/ds/StatusBadge'
import { ProgressBar } from '@/components/ds/ProgressBar'
import { formatDate, formatDateTime } from '@/lib/dateUtils'
import { campaignOverviewValue } from '@/lib/kpi/campaignDisplay'
import { campaignListPct, campaignListReached, campaignListTone } from '@/lib/kpi/campaignList'
import type { CampaignResultModel } from '@/lib/kpi/resultModel'
import { cn } from '@/lib/utils'
import { ChevronRight } from 'lucide-react'

// r2.3 (audit P1#1 + P1#2) — DANH SÁCH CHIẾN DỊCH của màn tổng hợp nhiều cửa
// hàng (SM landing /targets). Trước đây trang tự dựng card + tự gọi vnd() ⇒
// campaign Số khách hiện "Mục tiêu 450đ / Đã đạt 3đ". Component này THUẦN
// PRESENTATION (server component, không query DB) và MỌI quyết định định dạng
// đi qua contract campaignOverviewValue (lib/kpi/campaignDisplay) — type-aware
// cho cả 3 metric_type, không có formatter cục bộ nào ở đây.
//
// UI v2 Phase 2 · K-5 (canvas K6/M6): một Link mỗi chiến dịch (đích cũ /targets?campaign=<id>, prefetch tắt như cũ).
// Desktop = các hàng trong một panel (tên + trạng thái hạn / ngày · cửa hàng · đồng bộ | giá trị | thanh + % | chevron);
// mobile = thẻ riêng, chiến dịch đang chạy viền nổi. % + màu thanh theo CHÍNH luật danh sách K-1 (campaignListPct /
// campaignListReached / campaignListTone: tỷ lệ THÔ, chưa đạt mà làm tròn lên 100 ⇒ "<100%", chưa đồng bộ ⇒ '—' +
// thanh nét đứt, đạt xanh kể cả đã kết thúc, kết thúc chưa đạt trung tính). Dòng giá trị vẫn từ campaignOverviewValue.
// Chỉ SM dùng; chữ giữ nguyên.

export interface RegionalCampaignItem {
  id: string
  model: CampaignResultModel
}

// Dùng chung với SmTargetsDetailView (chip hạn của chi tiết SM).
export function deadlineTone(status: string, label: string): StatusTone {
  if (status === 'paused') return 'warning'
  if (status === 'ended' || label === 'Đã kết thúc') return 'neutral'
  return 'info'
}

export function RegionalCampaignOverviewList({ items, hrefFor }: {
  items: RegionalCampaignItem[]
  hrefFor: (id: string) => string
}) {
  return (
    <ul data-sm-campaign-list className="space-y-2.5 md:space-y-0 md:divide-y md:overflow-hidden md:rounded-v2-panel md:border md:bg-card">
      {items.map(({ id, model }) => {
        const synced = model.lastSyncedAt !== null
        const input = {
          metricType: model.campaign.metric_type,
          synced,
          storeCount: model.storeCount,
          totalTarget: model.totalTarget,
          totalActual: model.totalActual,
          qualityPassCount: model.qualityPassCount,
        }
        const v = campaignOverviewValue({ ...input, totalOffline: model.totalOffline, totalOfflineOrders: model.totalOfflineOrders })
        // Q-131 (PM duyệt 17/10): % SM theo luật danh sách K-1 (1 chữ số, "<100%", màu đạt từ số thô) — chỉ trình bày;
        // điều kiện đạt/công thức KPI/số tiền không phụ thuộc chỗ này.
        const pct = campaignListPct(input)
        // Đã đồng bộ nhưng KHÔNG có mẫu số (mục tiêu 0 / 0 cửa hàng) ⇒ raw null ⇒ trình bày như chưa đồng bộ ('—', nét
        // đứt) — null ≠ 0; dòng ngày vẫn ghi "Đồng bộ …" theo dữ liệu thật.
        const tone = synced && pct.raw !== null
          ? campaignListTone({ synced, reached: campaignListReached(input), status: model.campaign.status })
          : 'unsynced'
        const isActive = model.campaign.status === 'active'
        return (
          <li key={id} data-sm-campaign={model.campaign.status}>
            <Link
              href={hrefFor(id)}
              prefetch={false}
              className={cn(
                'block rounded-v2-panel border bg-card p-4 transition-colors hover:bg-muted/40 active:bg-muted/50',
                'md:flex md:items-center md:gap-5 md:rounded-none md:border-0 md:bg-transparent md:px-5 md:py-3.5 md:hover:bg-muted/40',
                isActive && 'border-v2-selected-line',
              )}
            >
              <div className="min-w-0 md:flex-[1.3]">
                <div className="flex items-start justify-between gap-2 md:flex-wrap md:items-center md:justify-start">
                  <p className="min-w-0 text-[15px] font-semibold leading-snug [overflow-wrap:anywhere] md:text-[14px]">{model.campaign.name}</p>
                  <StatusBadge tone={deadlineTone(model.campaign.status, model.deadlineLabel)} size="sm" className="shrink-0">
                    {model.deadlineLabel}
                  </StatusBadge>
                </div>
                <p className="mt-1 text-[12px] text-v2-text-3 tabular-nums">
                  {formatDate(model.campaign.start_date)} – {formatDate(model.campaign.end_date)} · {model.storeCount} cửa hàng
                  {model.lastSyncedAt ? ` · Đồng bộ ${formatDateTime(model.lastSyncedAt)}` : ' · Chưa đồng bộ'}
                </p>
              </div>

              <div className="mt-3 space-y-0.5 text-[13px] tabular-nums md:mt-0 md:flex-1 md:text-right">
                {v.lines.map((l) => (
                  <p key={l.label}>
                    <span className="text-muted-foreground">{l.label}: </span>
                    <span className="font-semibold">{l.value}</span>
                  </p>
                ))}
              </div>

              <div data-campaign-progress={tone} className="mt-2.5 flex items-center gap-2.5 md:mt-0 md:w-[220px] md:shrink-0">
                {tone === 'unsynced' ? (
                  <div aria-hidden="true" className={cn(isActive ? 'h-[10px]' : 'h-[6px]', 'flex-1 rounded-full border border-dashed border-input bg-muted')} />
                ) : (
                  <ProgressBar value={pct.raw ?? 0} max={100} tone={tone} size={isActive ? 10 : 6} ariaLabel={`Hoàn thành ${pct.text}`} className="flex-1" />
                )}
                <span className="w-14 shrink-0 text-right text-[13px] font-semibold tabular-nums">{tone === 'unsynced' ? '—' : pct.text}</span>
              </div>

              <ChevronRight aria-hidden="true" className="hidden h-4 w-4 shrink-0 text-muted-foreground md:block" />
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
