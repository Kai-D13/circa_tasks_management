'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { PrescriptionImageUpload, type PrescriptionImage } from '@/components/prescriptions/PrescriptionImageUpload'
import { submitPrescription } from '@/app/actions/prescriptions'

interface Props {
  storeId: string
}

export function PrescriptionForm({ storeId }: Props) {
  const [pending, startTransition] = useTransition()
  const [orderCode, setOrderCode]  = useState('')
  const [images, setImages]        = useState<PrescriptionImage[]>([])
  const [notes, setNotes]          = useState('')

  // Stable submission ID so images can be uploaded before the form is submitted
  const [submissionId] = useState(() => crypto.randomUUID())

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    const trimmed = orderCode.trim().toUpperCase()
    if (!trimmed) { toast.error('Vui lòng nhập mã đơn hàng DHC'); return }
    if (images.length === 0) { toast.error('Vui lòng chụp ít nhất 1 ảnh toa thuốc'); return }

    startTransition(async () => {
      // Pass only storage paths (not preview URLs) to the server
      const imagePaths = images.map(({ path, name, type, size }) => ({ path, name, type, size }))
      const result = await submitPrescription(submissionId, trimmed, imagePaths, notes || undefined)
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
              placeholder="VD: DHC00878115"
              value={orderCode}
              onChange={(e) => setOrderCode(e.target.value.toUpperCase())}
              className="w-full h-10 rounded-md border border-input bg-background px-3 py-1 text-base shadow-sm font-mono tracking-wider"
              required
            />
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

          {/* Optional notes */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="notes">
              Ghi chú
            </label>
            <Textarea
              id="notes"
              placeholder="Ghi chú thêm nếu có..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
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
