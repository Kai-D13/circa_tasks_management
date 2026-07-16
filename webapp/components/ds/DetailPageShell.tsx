import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { cn } from '@/lib/utils'

// Detail-page frame: back-link → single <h1> + status badges → meta line →
// content. Replaces the hand-rolled headers on tasks/[id], fs/[id],
// prescriptions/[id] (migrated per-route in their waves).
export function DetailPageShell({
  backHref, backLabel, title, badges, meta, children, className,
}: {
  backHref: string
  backLabel: string
  title: string
  badges?: React.ReactNode
  meta?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('p-4 space-y-4 max-w-5xl', className)}>
      {/* min-h-[44px] PIXEL LITERAL hit area on mobile (root 15px → rem lies;
          P1 r1.1); negative margin keeps the text baseline in place. Desktop
          compact. */}
      <Link
        href={backHref}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground min-h-[44px] md:min-h-0 -my-2.5 md:my-0"
      >
        <ChevronLeft className="h-4 w-4" /> {backLabel}
      </Link>
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold break-words min-w-0">{title}</h1>
          {badges}
        </div>
        {meta && <div className="text-sm text-muted-foreground mt-1">{meta}</div>}
      </div>
      {children}
    </div>
  )
}
