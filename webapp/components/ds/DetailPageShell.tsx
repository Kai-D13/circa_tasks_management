import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { cn } from '@/lib/utils'

// Detail-page frame: back-link → single <h1> + status badges → meta line →
// content. Replaces the hand-rolled headers on tasks/[id], fs/[id],
// prescriptions/[id] (migrated per-route in their waves).
export function DetailPageShell({
  backHref, backLabel, title, badges, meta, actions, children, className, layoutWidth,
}: {
  backHref: string
  backLabel: string
  title: string
  badges?: React.ReactNode
  meta?: React.ReactNode
  // Header actions (share/pause/delete…), right of the title on md+. Optional —
  // without it the markup is unchanged (existing callers/snapshots unaffected).
  actions?: React.ReactNode
  children: React.ReactNode
  // Contract width (đổi 15/08): width là việc của CALLER, shell không tự cap.
  // Detail mới mặc định FLUID theo width policy 15/08; caller nào cần hẹp thì
  // tự truyền `max-w-* mx-auto` qua className (xem tasks/schedules/[id]).
  className?: string
  // Khai báo bề rộng để spec e2e/ui-width-contract đo được (shell không spread
  // props nên data-attr phải đi qua prop). TRƠ về mặt hiển thị — chỉ render ra
  // `data-layout-width`, không sinh một class nào.
  layoutWidth?: 'fluid' | 'centered'
}) {
  const titleBlock = (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold break-words min-w-0">{title}</h1>
        {badges}
      </div>
      {meta && <div className="text-sm text-muted-foreground mt-1">{meta}</div>}
    </div>
  )
  return (
    <div data-layout-width={layoutWidth} className={cn('p-4 space-y-4', className)}>
      {/* min-h-[44px] PIXEL LITERAL hit area on mobile (root 15px → rem lies;
          P1 r1.1); negative margin keeps the text baseline in place. Desktop
          compact. */}
      <Link
        href={backHref}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground min-h-[44px] md:min-h-0 -my-2.5 md:my-0"
      >
        <ChevronLeft className="h-4 w-4" /> {backLabel}
      </Link>
      {actions ? (
        <div className="flex items-start justify-between gap-4 flex-wrap">
          {titleBlock}
          <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">{actions}</div>
        </div>
      ) : titleBlock}
      {children}
    </div>
  )
}
