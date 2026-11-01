import { cmsAmountPerUnit, cmsTierRange } from '@/lib/cms/display'
import type { CmsTierView } from '@/lib/cms/server/catalog'
import { cn } from '@/lib/utils'

// CMS — chip bậc chính sách "1–9 · 15.000₫/hộp" (U5 / U9). Chỉ cấu hình, không có tiến độ thực tế (P1).
export function CmsTierChips({ tiers, unit, className }: { tiers: CmsTierView[]; unit: string; className?: string }) {
  return (
    <ul aria-label="Thang CMS theo số lượng" className={cn('flex flex-wrap gap-1.5', className)}>
      {tiers.map((t) => (
        <li
          key={t.order}
          data-cms-tier={t.order}
          className="inline-flex items-center gap-1 rounded-[6px] border bg-card px-2 py-1 text-[12px] leading-tight whitespace-nowrap"
        >
          <span className="text-muted-foreground tabular-nums">{cmsTierRange(t.from, t.to)}</span>
          <span aria-hidden="true" className="text-muted-foreground">·</span>
          <span className="font-semibold tabular-nums">{cmsAmountPerUnit(t.amount, unit)}</span>
        </li>
      ))}
    </ul>
  )
}
