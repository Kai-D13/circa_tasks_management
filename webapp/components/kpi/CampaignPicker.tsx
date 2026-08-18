'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { CalendarDays, ChevronDown, Check } from 'lucide-react'

// Campaign selector for the staff /targets screen (review r3). The horizontal
// chip row broke down at 3-5 long-named campaigns, so the selected campaign is
// now the screen's focus and switching happens through this picker: a date
// pill (mockup's "Tháng 7/2026 ▾") that opens a dialog listing every active
// campaign with its range, days-left and completion. Labels are precomputed
// server-side — this component only navigates.

export interface CampaignPickerItem {
  id: string
  name: string
  rangeLabel: string        // "01/07 – 31/07"
  statusLabel: string       // "Còn 27 ngày" | "Đã kết thúc"
  // Commit 5.1: chuỗi ĐÃ quyết định theo loại chiến dịch
  // (campaignPickerMetricLabel). Trước đây là "8%" và component tự ghép
  // "Hoàn thành ..." cho MỌI loại — Chất lượng bán hàng vì thế vẫn lộ điểm gộp
  // ở đúng chỗ này dù đã bỏ khỏi hero/bảng/card.
  metricLabel: string       // "Hoàn thành 8%" | "Số đơn 116,2% · AOV 101,8%" | "Chưa đồng bộ"
}

const pillCls =
  'inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-secondary px-3 py-1.5 text-xs font-medium text-foreground'

export function CampaignPicker({ items, selectedId }: { items: CampaignPickerItem[]; selectedId: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const sel = items.find((i) => i.id === selectedId) ?? items[0]
  if (!sel) return null

  // Single campaign → informational pill, nothing to pick.
  if (items.length <= 1) {
    return (
      <span className={pillCls}>
        <CalendarDays className="h-3.5 w-3.5 text-primary shrink-0" />
        {sel.rangeLabel}
      </span>
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* [44px] touch height on mobile; the informational (single-campaign)
          pill above stays compact since it isn't interactive. */}
      <DialogTrigger render={<button type="button" className={cn(pillCls, 'min-h-[44px] md:min-h-0 hover:bg-primary/10 transition-colors')} />}>
        <CalendarDays className="h-3.5 w-3.5 text-primary shrink-0" />
        {sel.rangeLabel}
        <span className="text-muted-foreground">· {items.length} chiến dịch</span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      </DialogTrigger>
      <DialogContent className="gap-2 p-3" showCloseButton={false}>
        <DialogTitle className="px-1">Chọn chiến dịch</DialogTitle>
        <div className="space-y-1.5 max-h-[60vh] overflow-y-auto">
          {items.map((i) => {
            const active = i.id === sel.id
            return (
              <button
                key={i.id}
                type="button"
                onClick={() => { setOpen(false); router.push(`/targets?campaign=${i.id}`) }}
                className={cn(
                  'w-full rounded-lg border px-3 py-2.5 text-left transition-colors',
                  active ? 'border-primary bg-secondary' : 'hover:bg-muted/40',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className={cn('text-sm font-medium leading-snug', active && 'text-primary')}>{i.name}</p>
                  {active && <Check className="h-4 w-4 text-primary shrink-0 mt-0.5" />}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {i.rangeLabel} · {i.statusLabel} · {i.metricLabel}
                </p>
              </button>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
