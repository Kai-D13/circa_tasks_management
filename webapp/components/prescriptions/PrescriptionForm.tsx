'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { PrescriptionImageUpload, type PrescriptionImage } from '@/components/prescriptions/PrescriptionImageUpload'
import { submitPrescription } from '@/app/actions/prescriptions'
import { DHC_STRICT_PATTERN, DHC_FORMAT_HINT } from '@/lib/prescriptions/constants'
import { cn } from '@/lib/utils'
import { FileText, Camera, HeartPulse, NotebookPen } from 'lucide-react'

interface Props {
  storeId: string
}

const DAYS_PRESETS = [7, 15, 30]

// Compact numbered section header for the submit flow.
function StepCard({ n, icon: Icon, title, required, children }: {
  n: number; icon: React.ElementType; title: string; required?: boolean; children: React.ReactNode
}) {
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-bold shrink-0">{n}</span>
          <Icon className="h-4 w-4 text-primary shrink-0" />
          <p className="text-sm font-semibold">{title}{required && <span className="text-destructive"> *</span>}</p>
        </div>
        {children}
      </CardContent>
    </Card>
  )
}

export function PrescriptionForm({ storeId }: Props) {
  const [pending, startTransition] = useTransition()
  const [orderCode, setOrderCode]  = useState('')
  const [images, setImages]        = useState<PrescriptionImage[]>([])
  const [notes, setNotes]          = useState('')
  const [isChronic, setIsChronic]  = useState(false)
  const [daysSupply, setDaysSupply] = useState('')

  // Stable submission ID so images can be uploaded before the form is submitted
  const [submissionId] = useState(() => crypto.randomUUID())

  // Inline format feedback the moment the code stops matching (client mirror of
  // the server DHC_STRICT_PATTERN check).
  const codeInvalid = orderCode.trim() !== '' && !DHC_STRICT_PATTERN.test(orderCode.trim().toUpperCase())

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    const trimmed = orderCode.trim().toUpperCase()
    if (!trimmed) { toast.error('Vui lòng nhập mã đơn hàng DHC'); return }
    if (!DHC_STRICT_PATTERN.test(trimmed)) { toast.error(DHC_FORMAT_HINT); return }
    if (images.length === 0) { toast.error('Vui lòng chụp ít nhất 1 ảnh toa thuốc'); return }
    if (!notes.trim()) { toast.error('Vui lòng nhập ghi chú toa thuốc'); return }
    const days = parseInt(daysSupply, 10)
    if (isChronic && (!Number.isFinite(days) || days <= 0)) {
      toast.error('Toa mạn tính cần số ngày dùng thuốc (lớn hơn 0)')
      return
    }

    startTransition(async () => {
      // Pass only storage paths (not preview URLs) to the server
      const imagePaths = images.map(({ path, name, type, size }) => ({ path, name, type, size }))
      const result = await submitPrescription(submissionId, trimmed, imagePaths, notes.trim(), {
        isChronic,
        daysSupply: isChronic ? days : undefined,
      })
      // redirect() is called server-side on success — only error path returns here
      if (result?.error) toast.error(result.error)
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 max-w-lg">
      {/* 1 · DHC — the prominent first action */}
      <StepCard n={1} icon={FileText} title="Mã đơn hàng DHC" required>
        <input
          id="order-code"
          type="text"
          inputMode="text"
          autoCapitalize="characters"
          placeholder="DHC0097848"
          value={orderCode}
          onChange={(e) => setOrderCode(e.target.value.toUpperCase())}
          className={cn(
            'w-full h-12 rounded-lg border-2 border-input bg-background px-3 text-lg shadow-sm font-mono tracking-widest text-center',
            codeInvalid ? 'border-destructive focus-visible:ring-destructive/30' : 'focus-visible:border-primary',
          )}
          required
        />
        <p className={cn('text-xs', codeInvalid ? 'text-destructive' : 'text-muted-foreground')}>{DHC_FORMAT_HINT}</p>
      </StepCard>

      {/* 2 · Photos — the primary capture action */}
      <StepCard n={2} icon={Camera} title="Ảnh toa thuốc" required>
        <PrescriptionImageUpload
          submissionId={submissionId}
          storeId={storeId}
          value={images}
          onChange={setImages}
        />
      </StepCard>

      {/* 3 · Chronic toggle card */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-bold shrink-0">3</span>
            <HeartPulse className="h-4 w-4 text-primary shrink-0" />
            <span className="text-sm font-semibold flex-1">Toa thuốc mạn tính</span>
            <input
              type="checkbox"
              checked={isChronic}
              onChange={(e) => setIsChronic(e.target.checked)}
              className="h-5 w-5 accent-primary"
            />
          </label>
          {isChronic && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Số ngày dùng thuốc — hệ thống nhắc chăm sóc khách trước khi hết thuốc 2 ngày.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {DAYS_PRESETS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDaysSupply(String(d))}
                    className={cn(
                      'h-10 px-4 rounded-full border text-sm font-medium transition-colors',
                      daysSupply === String(d)
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:text-primary hover:bg-primary/5',
                    )}
                  >
                    {d} ngày
                  </button>
                ))}
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  placeholder="Số ngày"
                  aria-label="Số ngày dùng thuốc"
                  value={daysSupply}
                  onChange={(e) => setDaysSupply(e.target.value.replace(/[^0-9]/g, ''))}
                  className="h-10 w-24 rounded-md border border-input bg-background px-3 text-sm shadow-sm"
                />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 4 · Note */}
      <StepCard n={4} icon={NotebookPen} title="Ghi chú" required>
        <Textarea
          id="notes"
          placeholder="Hoạt chất, loại thuốc kê đơn (ETC)..."
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          required
        />
      </StepCard>

      {/* Sticky submit — sits above the mobile bottom nav (64px + safe area). */}
      <div className="sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] md:bottom-0 z-10 -mx-4 md:mx-0 border-t md:border-0 bg-background/95 backdrop-blur px-4 md:px-0 py-3">
        <Button type="submit" disabled={pending} className="w-full h-12 text-base">
          {pending ? 'Đang nộp...' : 'Nộp toa thuốc'}
        </Button>
      </div>
    </form>
  )
}
