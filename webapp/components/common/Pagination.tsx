import Link from 'next/link'
import { buttonVariants } from '@/components/ui/button'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Props {
  page:        number
  totalPages:  number
  totalRows:   number
  pageSize:    number
  hrefForPage: (p: number) => string   // caller builds the filter-preserving href
}

// Presentational pager: range label + prev/next chevrons + windowed page numbers
// with `…` gaps. Mirrors the inline block on /tasks. Renders nothing for a single page.
export function Pagination({ page, totalPages, totalRows, pageSize, hrefForPage }: Props) {
  if (totalPages <= 1) return null

  const offset = (page - 1) * pageSize

  return (
    <div className="flex items-center justify-between gap-2 pt-1">
      <span className="text-xs text-muted-foreground">
        {offset + 1}–{Math.min(offset + pageSize, totalRows)} / {totalRows}
      </span>
      <div className="flex items-center gap-1">
        <Link
          href={hrefForPage(page - 1)}
          aria-disabled={page <= 1}
          className={cn(
            buttonVariants({ variant: 'outline', size: 'sm' }),
            'h-7 w-7 p-0',
            page <= 1 && 'pointer-events-none opacity-40',
          )}
          aria-label="Trang trước"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Link>

        {/* Page numbers — show first, last, and a window of ±2 around current */}
        {Array.from({ length: totalPages }, (_, i) => i + 1)
          .filter((p) => p === 1 || p === totalPages || Math.abs(p - page) <= 2)
          .reduce<(number | '…')[]>((acc, p, i, arr) => {
            if (i > 0 && (p as number) - (arr[i - 1] as number) > 1) acc.push('…')
            acc.push(p)
            return acc
          }, [])
          .map((p, i) =>
            p === '…' ? (
              <span key={`gap-${i}`} className="text-xs text-muted-foreground px-1">…</span>
            ) : (
              <Link
                key={p}
                href={hrefForPage(p as number)}
                className={cn(
                  buttonVariants({ variant: p === page ? 'default' : 'outline', size: 'sm' }),
                  'h-7 w-7 p-0 text-xs',
                )}
              >
                {p}
              </Link>
            )
          )}

        <Link
          href={hrefForPage(page + 1)}
          aria-disabled={page >= totalPages}
          className={cn(
            buttonVariants({ variant: 'outline', size: 'sm' }),
            'h-7 w-7 p-0',
            page >= totalPages && 'pointer-events-none opacity-40',
          )}
          aria-label="Trang tiếp"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </div>
  )
}
