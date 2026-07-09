'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { chooseSite } from '@/app/actions/site'
import { cn } from '@/lib/utils'
import { LayoutGrid, Boxes, Loader2 } from 'lucide-react'

// Site chooser cards (dual-access accounts). On pick → set cookie server-side →
// HARD navigate (window.location) so the just-set cookie is carried, mirroring
// the login flow (avoids a soft-nav racing the cookie → bouncing back here).
export function SiteChooser({ sites }: { sites: ('os' | 'fs')[] }) {
  const [pending, setPending] = useState<'os' | 'fs' | null>(null)

  async function pick(site: 'os' | 'fs') {
    if (pending) return
    setPending(site)
    const r = await chooseSite(site)
    if ('error' in r) { toast.error(r.error); setPending(null); return }
    window.location.assign(r.redirectTo)
  }

  const CARD = 'flex flex-col items-center gap-3 rounded-2xl border-2 bg-card p-8 text-center transition-colors hover:border-primary hover:bg-primary/5 disabled:opacity-60'

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {sites.includes('os') && (
        <button type="button" onClick={() => pick('os')} disabled={!!pending} className={cn(CARD)}>
          <div className="h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center">
            {pending === 'os' ? <Loader2 className="h-6 w-6 animate-spin text-primary" /> : <LayoutGrid className="h-7 w-7 text-primary" />}
          </div>
          <div>
            <div className="font-semibold">Circa Tasks (OS)</div>
            <div className="text-xs text-muted-foreground mt-0.5">Vận hành cửa hàng OS: tasks, doanh số, toa thuốc, tồn kho…</div>
          </div>
        </button>
      )}
      {sites.includes('fs') && (
        <button type="button" onClick={() => pick('fs')} disabled={!!pending} className={cn(CARD)}>
          <div className="h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center">
            {pending === 'fs' ? <Loader2 className="h-6 w-6 animate-spin text-primary" /> : <Boxes className="h-7 w-7 text-primary" />}
          </div>
          <div>
            <div className="font-semibold">Quản lý FS</div>
            <div className="text-xs text-muted-foreground mt-0.5">Quản lý sản phẩm cho cửa hàng FS</div>
          </div>
        </button>
      )}
    </div>
  )
}
