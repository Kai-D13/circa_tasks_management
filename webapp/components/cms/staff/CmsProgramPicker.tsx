'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Check, ChevronDown } from 'lucide-react'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { cmsDate, cmsDateRange } from '@/lib/cms/display'
import { CMS_STATUS_LABEL, CMS_STATUS_TONE, cmsDisplayStatus } from '@/lib/cms/programStatus'
import { cmsStaffHref } from '@/lib/cms/staffView'
import type { CmsProgramRowView } from '@/lib/cms/server/catalog'

// CMS P1-d (UI §4.1) — chọn chương trình: nút 52px mở danh sách chương trình đang áp dụng (`?program=`, link — không gọi
// máy chủ ghi). Chỉ 1 chương trình ⇒ nhãn, không mở danh sách. Sắp diễn ra ghi "Bắt đầu dd/mm".
function Meta({ p, today }: { p: CmsProgramRowView; today: string }) {
  const d = cmsDisplayStatus(p, today)
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
      <StatusBadge tone={CMS_STATUS_TONE[d]} size="sm">{CMS_STATUS_LABEL[d]}</StatusBadge>
      {d === 'upcoming' ? <span className="tabular-nums">Bắt đầu {cmsDate(p.startDate).slice(0, 5)}</span> : <span className="tabular-nums">{cmsDateRange(p.startDate, p.endDate)}</span>}
    </span>
  )
}

export function CmsProgramPicker({ programs, selectedId, today }: { programs: CmsProgramRowView[]; selectedId: string; today: string }) {
  const [open, setOpen] = useState(false)
  const selected = programs.find((p) => p.id === selectedId) ?? programs[0]
  if (!selected) return null
  if (programs.length === 1) {
    return (
      <div data-cms-program-label className="space-y-1 rounded-v2-panel border bg-card px-4 py-3">
        <p className="font-semibold leading-snug break-words">{selected.name}</p>
        <Meta p={selected} today={today} />
      </div>
    )
  }
  return (
    <>
      <button
        type="button"
        data-cms-program-picker
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="flex min-h-[52px] w-full items-center gap-3 rounded-v2-panel border bg-card px-4 py-2 text-left"
      >
        <span className="min-w-0 flex-1 space-y-1">
          <span className="font-semibold leading-snug line-clamp-2 break-words">{selected.name}</span>
          <Meta p={selected} today={today} />
        </span>
        <span className="shrink-0 text-[12px] text-muted-foreground tabular-nums">{programs.length} chương trình</span>
        <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Chọn chương trình CMS</DialogTitle>
          </DialogHeader>
          <ul data-cms-program-list className="max-h-[60vh] divide-y overflow-y-auto">
            {programs.map((p) => (
              <li key={p.id}>
                <Link
                  href={cmsStaffHref(p.id)}
                  onClick={() => setOpen(false)}
                  aria-current={p.id === selected.id ? 'true' : undefined}
                  className={cn('flex min-h-[52px] items-center gap-3 py-2', p.id === selected.id && 'font-semibold')}
                >
                  <span className="min-w-0 flex-1 space-y-1">
                    <span className="leading-snug line-clamp-2 break-words">{p.name}</span>
                    <Meta p={p} today={today} />
                  </span>
                  {p.id === selected.id && <Check aria-hidden="true" className="h-4 w-4 shrink-0" />}
                </Link>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  )
}
