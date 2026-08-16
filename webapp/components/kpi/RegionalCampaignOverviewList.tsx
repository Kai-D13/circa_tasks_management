import Link from 'next/link'
import { Card, CardContent } from '@/components/ui/card'
import { StatusBadge, type StatusTone } from '@/components/ds/StatusBadge'
import { formatDate, formatDateTime } from '@/lib/dateUtils'
import { campaignOverviewValue } from '@/lib/kpi/campaignDisplay'
import type { CampaignResultModel } from '@/lib/kpi/resultModel'
import { cn } from '@/lib/utils'
import { CalendarDays, ChevronRight, Megaphone } from 'lucide-react'

// r2.3 (audit P1#1 + P1#2) — DANH SÁCH CHIẾN DỊCH của màn tổng hợp nhiều cửa
// hàng (SM landing /targets). Trước đây trang tự dựng card + tự gọi vnd() ⇒
// campaign Số khách hiện "Mục tiêu 450đ / Đã đạt 3đ". Component này THUẦN
// PRESENTATION (server component, không query DB) và MỌI quyết định định dạng
// đi qua contract campaignOverviewValue (lib/kpi/campaignDisplay) — type-aware
// cho cả 3 metric_type, không có formatter cục bộ nào ở đây.
//
// Layout: hàng full-width quét nhanh (mirror màn danh sách của super) — tên +
// khoảng ngày + số cửa hàng + trạng thái đồng bộ + giá trị theo LOẠI + tiến độ
// + chevron. Click giữ NGUYÊN đích cũ: /targets?campaign=<id>.

export interface RegionalCampaignItem {
  id: string
  model: CampaignResultModel
}

// Money-screen rule (giữ nguyên luật đang chạy): xám tới khi có snapshot —
// 0% không bao giờ được đọc như kết quả thật; xanh chỉ khi ≥100%.
function progressCls(synced: boolean, pct: number): { bar: string; text: string } {
  if (!synced) return { bar: 'bg-muted-foreground/30', text: 'text-muted-foreground' }
  return pct >= 100
    ? { bar: 'bg-status-success', text: 'text-status-success' }
    : { bar: 'bg-primary', text: 'text-primary' }
}

function deadlineTone(status: string, label: string): StatusTone {
  if (status === 'paused') return 'warning'
  if (status === 'ended' || label === 'Đã kết thúc') return 'neutral'
  return 'info'
}

export function RegionalCampaignOverviewList({ items, hrefFor }: {
  items: RegionalCampaignItem[]
  hrefFor: (id: string) => string
}) {
  return (
    <Card className="rounded-lg">
      <CardContent className="p-0">
        {items.map(({ id, model }) => {
          const synced = model.lastSyncedAt !== null
          const v = campaignOverviewValue({
            metricType: model.campaign.metric_type,
            synced,
            storeCount: model.storeCount,
            totalTarget: model.totalTarget,
            totalActual: model.totalActual,
            qualityPassCount: model.qualityPassCount,
            totalOffline: model.totalOffline,
            totalOfflineOrders: model.totalOfflineOrders,
          })
          const cls = progressCls(v.synced, v.pct)
          const values = (
            <div className="space-y-0.5">
              {v.lines.map((l) => (
                <p key={l.label} className="text-sm">
                  <span className="text-muted-foreground">{l.label}: </span>
                  <span className="font-semibold tabular-nums">{l.value}</span>
                </p>
              ))}
            </div>
          )
          const progress = (
            <div className="flex items-center gap-2">
              <div className="h-2 flex-1 rounded-full bg-muted overflow-hidden">
                {/* chưa đồng bộ → thanh xám rỗng, KHÔNG vẽ tiến độ */}
                <div className={cn('h-full rounded-full', cls.bar)} style={{ width: `${Math.max(0, Math.min(100, v.pct))}%` }} />
              </div>
              <span className={cn('text-xs font-semibold w-11 text-right tabular-nums', cls.text)}>{v.pctText}</span>
            </div>
          )
          return (
            <Link
              key={id}
              href={hrefFor(id)}
              prefetch={false}
              className="flex items-start md:items-center gap-3 px-4 py-3.5 min-h-[44px] border-t first:border-t-0 hover:bg-muted/30 active:bg-muted/40 transition-colors"
            >
              <span className="hidden sm:flex h-10 w-10 rounded-lg items-center justify-center shrink-0 bg-primary/10 text-primary">
                <Megaphone className="h-5 w-5" />
              </span>

              <div className="min-w-0 flex-[1.4]">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-[15px] font-semibold truncate">{model.campaign.name}</p>
                  <StatusBadge tone={deadlineTone(model.campaign.status, model.deadlineLabel)}>
                    {model.deadlineLabel}
                  </StatusBadge>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5 inline-flex items-center gap-1 flex-wrap">
                  <CalendarDays className="h-3 w-3 shrink-0" />
                  {formatDate(model.campaign.start_date)} – {formatDate(model.campaign.end_date)} · {model.storeCount} cửa hàng
                  {model.lastSyncedAt ? ` · Đồng bộ ${formatDateTime(model.lastSyncedAt)}` : ' · Chưa đồng bộ'}
                </p>
                {/* Mobile: số + tiến độ phải ở lại — đây là màn tiền */}
                <div className="mt-2 md:hidden space-y-1.5">
                  {values}
                  {progress}
                </div>
              </div>

              <div className="hidden md:block flex-1 min-w-0">{values}</div>
              <div className="hidden md:block w-40 shrink-0">{progress}</div>

              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 self-center" />
            </Link>
          )
        })}
      </CardContent>
    </Card>
  )
}
