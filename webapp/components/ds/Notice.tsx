import { AlertTriangle, CheckCircle2, Info, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { StatusTone } from './StatusBadge'

// Khối thông báo trong trang (thay banner amber/xanh tự chế: "Đang chờ nộp lại"…). Màu = cặp
// --status-* đã đo; KHÔNG phải ErrorState (lỗi tải dữ liệu vẫn dùng ErrorState).
// Không tự gắn role — banner trạng thái tĩnh không phải alert; caller truyền `role` khi cần.
// Ngoài [data-ui-v2]: bo 8px; trong v2: panel 12px.
const TONE: Record<StatusTone, { box: string; title: string; icon: LucideIcon }> = {
  warning: { box: 'border-status-warning/30 bg-status-warning-bg', title: 'text-status-warning', icon: AlertTriangle },
  danger:  { box: 'border-status-danger/30 bg-status-danger-bg',   title: 'text-status-danger',  icon: AlertTriangle },
  info:    { box: 'border-status-info/30 bg-status-info-bg',       title: 'text-status-info',    icon: Info },
  success: { box: 'border-status-success/30 bg-status-success-bg', title: 'text-status-success', icon: CheckCircle2 },
  neutral: { box: 'border-border bg-status-neutral-bg',            title: 'text-foreground',     icon: Info },
}

export function Notice({
  tone, title, children, icon, role, className,
}: {
  tone: StatusTone
  title?: React.ReactNode
  children?: React.ReactNode
  icon?: LucideIcon
  role?: 'status' | 'alert'
  className?: string
}) {
  const t = TONE[tone]
  const Icon = icon ?? t.icon
  return (
    <div role={role} className={cn('flex gap-2.5 rounded-lg border px-4 py-3 text-sm v2:rounded-v2-panel v2:gap-3 v2:py-3.5', t.box, className)}>
      <Icon aria-hidden="true" className={cn('mt-0.5 h-4 w-4 shrink-0 v2:size-[18px] v2:mt-px', t.title)} />
      <div className="min-w-0 space-y-0.5">
        {title && <p className={cn('font-semibold', t.title)}>{title}</p>}
        {children && <div className="text-muted-foreground v2:text-[13px] v2:leading-[1.5]">{children}</div>}
      </div>
    </div>
  )
}
