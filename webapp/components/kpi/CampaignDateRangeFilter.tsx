import { CalendarRange, RotateCcw } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { formatDate } from '@/lib/dateUtils'
import { CAMPAIGN_RANGE_ERROR_TEXT, withRangeParams, type CampaignRange } from '@/lib/kpi/campaignDateRange'

// Bộ lọc khoảng ngày của campaign (17/08) — CHỈ ĐỂ XEM.
//
// `<form method="GET">`: giữ page là server component, URL chia sẻ được, và
// back/refresh hoạt động đúng mà không cần một dòng client JS nào.
//
// Chỉ render từ `md` trở lên (md:block ở wrapper) — đây là công cụ đối soát
// trên máy bàn. Việc AI được thấy do CALLER quyết bằng rangeFilterVisibleForRole
// trên server; component không tự phán quyền.
export function CampaignDateRangeFilter({
  action, campaignStart, campaignEnd, range, keepParams, note,
}: {
  action: string                              // pathname đích của form
  campaignStart: string
  campaignEnd: string
  range: CampaignRange
  keepParams: Record<string, string | undefined>  // campaign · tab · series · store
  note?: string | null                        // cảnh báo nguồn (vd lỗi health)
}) {
  const resetHref = `${action}${withRangeParams(keepParams, { from: null, to: null })}`

  return (
    <Card className="hidden md:block rounded-lg">
      <CardContent className="p-3">
        <form method="GET" action={action} className="flex flex-wrap items-end gap-3">
          {/* Giữ nguyên mọi param đang chạy — mất `campaign` hay `tab` là nhảy
              sang màn khác ngay khi bấm Áp dụng. */}
          {Object.entries(keepParams).map(([k, v]) =>
            v ? <input key={k} type="hidden" name={k} value={v} /> : null)}

          <span className="inline-flex items-center gap-1.5 text-sm font-medium">
            <CalendarRange className="h-4 w-4 text-primary" /> Xem theo khoảng
          </span>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">Từ ngày</span>
            <input
              type="date" name="from" defaultValue={range.from ?? ''}
              min={campaignStart} max={campaignEnd}
              className="h-9 rounded-md border bg-background px-2 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">Đến ngày</span>
            <input
              type="date" name="to" defaultValue={range.to ?? ''}
              min={campaignStart} max={campaignEnd}
              className="h-9 rounded-md border bg-background px-2 text-sm"
            />
          </label>

          <Button type="submit" size="sm" className="h-9">Áp dụng</Button>
          {(range.active || range.error) && (
            // Link thường, không bọc Button: base-ui KHÔNG có `asChild` (dùng
            // `render`), mà ở đây chỉ cần một anchor điều hướng — bọc thêm chỉ
            // đẻ một lớp API không cần thiết.
            <a
              href={resetHref}
              aria-label="Đặt lại khoảng ngày"
              className="inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Đặt lại
            </a>
          )}
        </form>

        {/* Trạng thái phải nói RÕ đang xem gì. Khoảng sai mà im lặng hiện số
            toàn kỳ là để người dùng đọc nhầm con số của một kỳ khác. */}
        {range.error ? (
          <p className="mt-2 text-xs text-status-danger">
            {CAMPAIGN_RANGE_ERROR_TEXT[range.error]} Đang hiển thị số liệu TOÀN KỲ.
          </p>
        ) : range.active ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Đang xem <span className="font-medium text-foreground">{formatDate(range.from!)} – {formatDate(range.to!)}</span>
            {' · '}Mục tiêu, bậc thưởng và commission vẫn tính theo TOÀN KỲ.
          </p>
        ) : null}

        {note && <p className="mt-2 text-xs text-status-warning">{note}</p>}
      </CardContent>
    </Card>
  )
}
