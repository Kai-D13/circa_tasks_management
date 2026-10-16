import type { LucideIcon } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'

type StatTone = 'default' | 'success' | 'warning' | 'danger' | 'info'

const TONE_TILE: Record<StatTone, string> = {
  default: 'bg-muted text-foreground',
  success: 'bg-status-success-bg text-status-success',
  warning: 'bg-status-warning-bg text-status-warning',
  danger:  'bg-status-danger-bg text-status-danger',
  info:    'bg-status-info-bg text-status-info',
}

// UI v2: chấm màu trước nhãn thay cho ô icon.
const TONE_DOT: Record<StatTone, string> = {
  default: 'bg-v2-text-3',
  success: 'bg-status-success',
  warning: 'bg-status-warning',
  danger:  'bg-status-danger',
  info:    'bg-status-info',
}

// Summary stat card (grid layout owned by the page: e.g. grid-cols-2 sm:grid-cols-4).
// UI v2 (chỉ trong [data-ui-v2]): panel 12px, chấm tone + nhãn 13px, số 30px đậm, hint 12px;
// ô icon ẩn; tone danger tô màu số. Ngoài phạm vi hiển thị y hệt bản cũ.
export function StatCard({
  label, value, icon: Icon, tone = 'default', hint, hintLines = 1, className,
}: {
  label: string
  value: React.ReactNode
  icon?: LucideIcon
  tone?: StatTone
  hint?: string
  /** Opt-in (B7-ui): 2 = hint giải thích dài xuống tối đa 2 dòng thay vì cắt 1 dòng. Mặc định 1 (giữ nguyên các trang cũ). */
  hintLines?: 1 | 2
  className?: string
}) {
  return (
    // rounded-lg override — base ui/card is rounded-xl (12px); DS surfaces cap
    // at 8px per UI_FOUNDATION_SPEC (P1 r1). Base card stays untouched (would
    // restyle every un-migrated route).
    <Card className={cn('rounded-lg v2:rounded-v2-panel v2:ring-border v2:py-0', className)}>
      <CardContent className="p-3 flex items-center gap-3 v2:px-[18px] v2:py-4">
        {Icon && (
          <span className={cn('h-9 w-9 rounded-lg flex items-center justify-center shrink-0 v2:hidden', TONE_TILE[tone])}>
            <Icon className="h-4 w-4" />
          </span>
        )}
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground truncate v2:flex v2:items-center v2:gap-2 v2:text-[13px]">
            <span aria-hidden="true" className={cn('hidden v2:inline-block size-2 shrink-0 rounded-full', TONE_DOT[tone])} />
            <span className="v2:min-w-0 v2:truncate">{label}</span>
          </p>
          <p className={cn(
            'text-2xl font-semibold tabular-nums leading-none mt-0.5 v2:text-[30px] v2:font-bold v2:leading-[1.1] v2:mt-1.5',
            tone === 'danger' && 'v2:text-status-danger',
          )}>{value}</p>
          {hint && <p className={cn('text-[11px] text-muted-foreground mt-1 v2:text-[12px] v2:text-v2-text-3 v2:mt-1.5', hintLines === 2 ? 'line-clamp-2' : 'truncate')} title={hint}>{hint}</p>}
        </div>
      </CardContent>
    </Card>
  )
}
