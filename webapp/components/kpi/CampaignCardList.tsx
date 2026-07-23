import Link from 'next/link'
import { Card, CardContent } from '@/components/ui/card'
import { formatDate } from '@/lib/dateUtils'
import { CalendarDays, ChevronRight, TrendingUp } from 'lucide-react'

interface CampaignCard {
  id: string; name: string; start_date: string; end_date: string
  kpi_target: number | null; actual_value: number | null
}

// The active campaigns of a store as tappable cards (staff/SM landing) → click
// opens the existing campaign detail (?campaign=<id>). No dashboard summary here
// (stakeholder) — just name, dates, and a run-rate bar.
export function CampaignCardList({ items, hrefFor }: { items: CampaignCard[]; hrefFor: (id: string) => string }) {
  return (
    <div className="space-y-2">
      {items.map((c) => {
        const target = Number(c.kpi_target) || 0
        const actual = Number(c.actual_value) || 0
        const pct = target > 0 ? Math.round((actual / target) * 100) : 0
        return (
          <Link key={c.id} href={hrefFor(c.id)} prefetch={false} className="block">
            {/* rounded-lg — DS surfaces cap at 8px; row is well past the 44px
                touch minimum via its own padding. */}
            <Card className="rounded-lg hover:border-primary/40 active:bg-muted/40 transition-colors">
              <CardContent className="p-3 flex items-center gap-3 min-h-[44px]">
                <span className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                  <TrendingUp className="h-4 w-4" />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{c.name}</div>
                  <div className="text-xs text-muted-foreground inline-flex items-center gap-1">
                    <CalendarDays className="h-3 w-3" /> {formatDate(c.start_date)} – {formatDate(c.end_date)}
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
                      <div className="h-full bg-primary" style={{ width: `${Math.min(pct, 100)}%` }} />
                    </div>
                    <span className="text-xs text-muted-foreground tabular-nums shrink-0">{pct}%</span>
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
              </CardContent>
            </Card>
          </Link>
        )
      })}
    </div>
  )
}
