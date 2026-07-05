'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { PrescriptionImageUpload, type PrescriptionImage } from '@/components/prescriptions/PrescriptionImageUpload'
import { submitPrescription } from '@/app/actions/prescriptions'
import { DHC_STRICT_PATTERN, DHC_FORMAT_HINT } from '@/lib/prescriptions/constants'
import { cn } from '@/lib/utils'

interface Props {
  storeId: string
}

const DAYS_PRESETS = [7, 15, 30]

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
    <form onSubmit={handleSubmit} className="space-y-4 max-w-lg">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Thông tin toa thuốc</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* DHC order code */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="order-code">
              Mã đơn hàng DHC <span className="text-destructive">*</span>
            </label>
            <input
              id="order-code"
              type="text"
              inputMode="text"
              autoCapitalize="characters"
              placeholder="VD: DHC0097848"
              value={orderCode}
              onChange={(e) => setOrderCode(e.target.value.toUpperCase())}
              className={cn(
                'w-full h-10 rounded-md border border-input bg-background px-3 py-1 text-base shadow-sm font-mono tracking-wider',
                codeInvalid && 'border-destructive focus-visible:ring-destructive/30',
              )}
              required
            />
            {codeInvalid && <p className="text-xs text-destructive">{DHC_FORMAT_HINT}</p>}
          </div>

          {/* Chronic prescription */}
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={isChronic}
                onChange={(e) => setIsChronic(e.target.checked)}
                className="h-4 w-4 accent-primary"
              />
              Toa thuốc mạn tính
            </label>
            {isChronic && (
              <div className="space-y-1.5 pl-6">
                <p className="text-xs text-muted-foreground">
                  Số ngày dùng thuốc — hệ thống sẽ nhắc chăm sóc khách trước khi hết thuốc 2 ngày.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {DAYS_PRESETS.map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setDaysSupply(String(d))}
                      className={cn(
                        'h-9 px-3 rounded-full border text-sm font-medium transition-colors',
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
                    className="h-9 w-24 rounded-md border border-input bg-background px-3 text-sm shadow-sm"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Prescription photos */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              Ảnh toa thuốc <span className="text-destructive">*</span>
            </label>
            <PrescriptionImageUpload
              submissionId={submissionId}
              storeId={storeId}
              value={images}
              onChange={setImages}
            />
          </div>

          {/* Required notes */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="notes">
              Ghi chú <span className="text-destructive">*</span>
            </label>
            <p className="text-xs text-muted-foreground">
              Note thông tin của toa thuốc: hoạt chất, loại thuốc kê đơn...
            </p>
            <Textarea
              id="notes"
              placeholder="VD: Kháng sinh Amoxicillin, thuốc kê đơn ETC..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              required
            />
          </div>
        </CardContent>
      </Card>

      <Button type="submit" disabled={pending} className="w-full h-11 text-base">
        {pending ? 'Đang nộp...' : 'Nộp toa thuốc'}
      </Button>
    </form>
  )
}
