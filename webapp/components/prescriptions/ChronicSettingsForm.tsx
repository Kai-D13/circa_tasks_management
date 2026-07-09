'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { updateChronicSettings } from '@/app/actions/prescriptions'

// Set / clear a toa's days_supply ("có ngày dùng"). Super admin edits any toa;
// the owner staff edits their own until it's cared for (server enforces both).
// Dates recompute server-side from the synced order date.
export function ChronicSettingsForm({
  submissionId, isChronic, daysSupply,
}: {
  submissionId: string
  isChronic: boolean
  daysSupply: number | null
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [chronic, setChronic] = useState(isChronic)
  const [days, setDays] = useState(daysSupply ? String(daysSupply) : '')

  function save() {
    const n = parseInt(days, 10)
    if (chronic && (!Number.isFinite(n) || n <= 0)) {
      toast.error('Số ngày dùng thuốc phải lớn hơn 0')
      return
    }
    startTransition(async () => {
      const r = await updateChronicSettings(submissionId, { isChronic: chronic, daysSupply: chronic ? n : undefined })
      if (r?.error) { toast.error(r.error); return }
      toast.success('Đã cập nhật ngày dùng')
      setOpen(false)
      router.refresh()
    })
  }

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Thiết lập ngày dùng
      </Button>
    )
  }

  return (
    <div className="rounded-lg border p-3 space-y-2.5 text-sm">
      <label className="flex items-center gap-2 font-medium">
        <input
          type="checkbox"
          checked={chronic}
          onChange={(e) => setChronic(e.target.checked)}
          className="h-4 w-4 accent-primary"
        />
        Toa có ngày dùng
      </label>
      {chronic && (
        <div className="flex items-center gap-2">
          <label htmlFor="chronic-days" className="text-muted-foreground">Số ngày dùng:</label>
          <input
            id="chronic-days"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={days}
            onChange={(e) => setDays(e.target.value.replace(/[^0-9]/g, ''))}
            className="h-8 w-20 rounded-md border border-input bg-background px-2 text-sm shadow-sm"
          />
        </div>
      )}
      <div className="flex gap-2">
        <Button size="sm" onClick={save} disabled={pending}>{pending ? 'Đang lưu…' : 'Lưu'}</Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>Hủy</Button>
      </div>
    </div>
  )
}
