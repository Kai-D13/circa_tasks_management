import Link from 'next/link'
import { buttonVariants } from '@/components/ui/button'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

// Discriminated union (UI design system P1.3 — docs/ui/UI_COMPONENT_CONTRACTS §7):
// - 'full' (default): the EXACT pre-existing API + markup — range label,
//   windowed page numbers, prev/next. Existing callers are untouched.
// - 'simple': staff lists without an exact count — "Trang N" + Trước/Tiếp;
//   hasNext is REQUIRED (without it the component can't decide the next link).
type Props =
  | {
      mode?: 'full'
      page: number
      totalPages: number
      totalRows: number
      pageSize: number
      hrefForPage: (p: number) => string   // caller builds the filter-preserving href
    }
  | {
      mode: 'simple'
      page: number
      hasNext: boolean
      hrefForPage: (p: number) => string
    }

// Presentational pager. Full mode renders nothing for a single page; simple
// mode renders nothing when there's neither a previous nor a next page.
export function Pagination(props: Props) {
  if (props.mode === 'simple') {
    const { page, hasNext, hrefForPage } = props
    if (page <= 1 && !hasNext) return null
    return (
      <div className="flex items-center justify-between gap-2 pt-1">
        <span className="text-xs text-muted-foreground">Trang {page}</span>
        <div className="flex items-center gap-1">
          {/* h-[44px] PIXEL LITERAL touch target on mobile (root font-size is
              15px so h-11/2.75rem = only 41.25 real px); desktop compacts via
              md: (P1 r1.1). Full mode markup below stays untouched. */}
          <Link
            href={hrefForPage(page - 1)}
            aria-disabled={page <= 1}
            className={cn(
              buttonVariants({ variant: 'outline', size: 'sm' }),
              'h-[44px] px-4 md:h-8 md:px-3',
              page <= 1 && 'pointer-events-none opacity-40',
            )}
            aria-label="Trang trước"
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Trước
          </Link>
          <Link
            href={hrefForPage(page + 1)}
            aria-disabled={!hasNext}
            className={cn(
              buttonVariants({ variant: 'outline', size: 'sm' }),
              'h-[44px] px-4 md:h-8 md:px-3',
              !hasNext && 'pointer-events-none opacity-40',
            )}
            aria-label="Trang tiếp"
          >
            Tiếp <ChevronRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
    )
  }

  const { page, totalPages, totalRows, pageSize, hrefForPage } = props
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
