'use client'

import { useState } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { CalendarRange, X } from 'lucide-react'
import { cn } from '@/lib/utils'

// Single-control date-range filter (review r-ui4): replaces the two loose native
// date inputs that cluttered the staff mobile filter row. One button opens a
// small sheet with quick presets + start/end pickers. URL still uses
// date_from/date_to so the backend + export are unchanged.

const dm = (iso: string) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '…')
const vnNow = () => new Date(Date.now() + 7 * 3600_000)
const iso = (d: Date) => d.toISOString().slice(0, 10)

export function PrescriptionDateRangeFilter() {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const curFrom = sp.get('date_from') ?? ''
  const curTo = sp.get('date_to') ?? ''
  const hasRange = !!(curFrom || curTo)

  const [open, setOpen] = useState(false)
  const [from, setFrom] = useState(curFrom)
  const [to, setTo] = useState(curTo)

  function nav(f: string, t: string) {
    const params = new URLSearchParams(sp.toString())
    if (f) params.set('date_from', f); else params.delete('date_from')
    if (t) params.set('date_to', t); else params.delete('date_to')
    params.delete('page')
    setOpen(false)
    const qs = params.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname)
  }

  function preset(days: number) {
    const now = vnNow()
    nav(iso(new Date(now.getTime() - (days - 1) * 86400_000)), iso(now))
  }
  function thisMonth() {
    const now = vnNow()
    nav(`${iso(now).slice(0, 7)}-01`, iso(now))
  }

  return (
    <div className="inline-flex items-stretch">
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) { setFrom(curFrom); setTo(curTo) } }}>
        <DialogTrigger
          render={
            <button
              type="button"
              className={cn(
                'inline-flex items-center gap-1.5 h-10 md:h-8 border bg-background px-3 text-sm shadow-sm',
                hasRange ? 'rounded-l-md text-foreground' : 'rounded-md text-muted-foreground',
              )}
            />
          }
        >
          <CalendarRange className="h-4 w-4 shrink-0" />
          {hasRange ? `${dm(curFrom)} – ${dm(curTo)}` : 'Khoảng thời gian'}
        </DialogTrigger>
        <DialogContent
          showCloseButton={false}
          className="top-auto bottom-0 left-0 right-0 max-w-full translate-x-0 translate-y-0 rounded-b-none rounded-t-2xl pb-[calc(1rem_+_env(safe-area-inset-bottom))] sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:max-w-sm sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl"
        >
          <DialogTitle>Khoảng thời gian</DialogTitle>
          <div className="flex flex-wrap gap-2">
            {[{ label: '7 ngày', fn: () => preset(7) }, { label: '30 ngày', fn: () => preset(30) }, { label: 'Tháng này', fn: thisMonth }].map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={p.fn}
                className="h-9 px-3 rounded-full border text-sm font-medium text-muted-foreground hover:text-primary hover:bg-primary/5"
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1 text-xs text-muted-foreground">
              Từ ngày
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                className="w-full h-10 rounded-md border border-input bg-background px-2 text-sm shadow-sm" />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              Đến ngày
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
                className="w-full h-10 rounded-md border border-input bg-background px-2 text-sm shadow-sm" />
            </label>
          </div>
          <div className="flex gap-2">
            <Button className="flex-1 h-10" onClick={() => nav(from, to)}>Áp dụng</Button>
            <Button variant="outline" className="h-10" onClick={() => nav('', '')}>Xóa</Button>
          </div>
        </DialogContent>
      </Dialog>
      {hasRange && (
        <button
          type="button"
          aria-label="Xóa khoảng thời gian"
          onClick={() => nav('', '')}
          className="inline-flex items-center h-10 md:h-8 border border-l-0 rounded-r-md bg-background px-2 text-muted-foreground hover:text-destructive shadow-sm"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}
