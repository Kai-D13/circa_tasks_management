import Link from 'next/link'
import { Card, CardContent } from '@/components/ui/card'
import { formatDate } from '@/lib/dateUtils'
import { campaignCardValue } from '@/lib/kpi/campaignDisplay'
import { cn } from '@/lib/utils'
import { CalendarDays, ChevronRight, ChartNoAxesCombined } from 'lucide-react'

// Đủ các trường `fetchCampaignViews` đã lấy sẵn (targets/page.tsx) — KHÔNG cần
// đụng query. Các trường của Chất lượng bán hàng là optional vì hai loại còn
// lại không có.
interface CampaignCard {
  id: string; name: string; start_date: string; end_date: string
  kpi_target: number | null; actual_value: number | null
  metric_type?: string
  actual_offline?: number | null
  offline_order_count?: number | null
  order_target?: number | null
  aov_target?: number | null
}

// Tông theo `tone` do lib quyết định — component KHÔNG suy từ phần trăm đã làm
// tròn (99,9999% vẫn là chưa đạt).
//
// ⚠ `warning` ở đây nghĩa là "đang chạy, chưa đạt" chứ không phải cảnh báo, nên
// thanh dùng brand primary như tiền lệ đang chạy ở campaigns/page.tsx:137 —
// tô amber mọi chiến dịch chưa về đích sẽ dạy người dùng bỏ qua màu amber, và
// làm màn hình đọc như đang có sự cố. Chữ % giữ muted, trạng thái ĐẠT mới nhận
// màu status-success.
const BAR_CLS = {
  success: 'bg-status-success',
  warning: 'bg-primary',
  neutral: 'bg-transparent',
} as const
const PCT_CLS = {
  success: 'text-status-success font-semibold',
  warning: 'text-muted-foreground',
  neutral: 'text-muted-foreground',
} as const

// Chiến dịch đang chạy của một cửa hàng, dạng card bấm được (landing Staff +
// QLCH) → mở chi tiết sẵn có (?campaign=<id>).
export function CampaignCardList({ items, hrefFor }: { items: CampaignCard[]; hrefFor: (id: string) => string }) {
  return (
    <div className="space-y-2">
      {items.map((c) => {
        // MỘT lời gọi duy nhất — mọi quyết định hiển thị (đơn vị, cặp
        // thực tế/mục tiêu, % , tone) nằm ở lib/kpi/campaignDisplay.
        const v = campaignCardValue({
          metricType: c.metric_type,
          kpiTarget: c.kpi_target,
          actualValue: c.actual_value,
          actualOffline: c.actual_offline,
          offlineOrderCount: c.offline_order_count,
          orderTarget: c.order_target,
          aovTarget: c.aov_target,
        })
        return (
          <Link key={c.id} href={hrefFor(c.id)} prefetch={false} className="block">
            {/* rounded-lg — DS cap 8px; padding đã đưa hàng vượt xa mức chạm 44px. */}
            <Card className="rounded-lg hover:border-primary/40 active:bg-muted/40 transition-colors">
              <CardContent className="p-3 space-y-2 min-h-[44px]">
                {/* Hàng tên: icon nhỏ lại (28px) để nhường chỗ cho SỐ LIỆU —
                    trước đây ô 36px chiếm cột riêng suốt chiều cao card.
                    Tên dùng line-clamp-2 + break-words thay `truncate`: tên
                    chiến dịch tiếng Việt hay dài hơn một dòng ở 360px. */}
                <div className="flex items-start gap-2.5">
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <ChartNoAxesCombined className="h-3.5 w-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium leading-snug line-clamp-2 break-words">{c.name}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <CalendarDays className="h-3 w-3 shrink-0" />
                        {formatDate(c.start_date)} – {formatDate(c.end_date)}
                      </span>
                      <span className="rounded bg-muted px-1.5 py-0.5 font-medium">{v.typeLabel}</span>
                    </div>
                  </div>
                  <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
                </div>

                {/* Số liệu: 1 dòng cho GMV/Số khách, 2 dòng cho Chất lượng bán
                    hàng (Số đơn + AOV là hai chỉ số độc lập — gộp lại sẽ giấu
                    mất chỉ số đang kéo điểm xuống). */}
                {v.lines.length > 0 && (
                  <div className="space-y-1">
                    {v.lines.map((l) => (
                      <div key={l.label} className="space-y-0.5">
                        <div className="flex items-baseline justify-between gap-3 text-xs">
                          <span className="shrink-0 text-muted-foreground">{l.label}</span>
                          <span className="text-right font-medium tabular-nums">{l.value}</span>
                        </div>
                        {/* Commit 5: dòng nào mang % riêng thì có THANH riêng —
                            Số đơn và AOV mỗi cái một tiến độ, không gộp. */}
                        {l.pctText !== undefined && (
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                              {v.synced && l.pct != null && (
                                <div
                                  className={cn('h-full', l.pass ? BAR_CLS.success : BAR_CLS.warning)}
                                  style={{ width: `${Math.min(Math.max(l.pct, 0), 100)}%` }}
                                />
                              )}
                            </div>
                            <span className={cn('shrink-0 text-xs tabular-nums', l.pass ? PCT_CLS.success : PCT_CLS.warning)}>
                              {l.pctText}
                            </span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {v.showAggregate ? (
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
                      {/* chưa đồng bộ → KHÔNG vẽ tiến độ (0% đọc như đã có kết quả) */}
                      {v.synced && (
                        <div className={cn('h-full', BAR_CLS[v.tone])} style={{ width: `${Math.min(v.pct, 100)}%` }} />
                      )}
                    </div>
                    <span className={cn('shrink-0 text-xs tabular-nums', PCT_CLS[v.tone])}>{v.pctText}</span>
                  </div>
                ) : (
                  // Không có % tổng ⇒ chỗ này là VERDICT ('Đạt KPI'/'Chưa đạt').
                  <div className="flex justify-end">
                    <span className={cn('text-xs font-medium', PCT_CLS[v.tone])}>{v.pctText}</span>
                  </div>
                )}
              </CardContent>
            </Card>
          </Link>
        )
      })}
    </div>
  )
}
