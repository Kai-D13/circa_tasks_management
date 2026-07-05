'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { PrescriptionImageUpload, type PrescriptionImage } from '@/components/prescriptions/PrescriptionImageUpload'
import { submitPrescriptionCare } from '@/app/actions/prescriptions'
import { HeartHandshake } from 'lucide-react'

// Chronic-care logging: required note + >=1 evidence photo. Rendered on the
// prescription detail for same-store staff/store managers while the chronic
// submission hasn't been cared for yet.
export function CareForm({ submissionId, storeId }: { submissionId: string; storeId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [note, setNote] = useState('')
  const [images, setImages] = useState<PrescriptionImage[]>([])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!note.trim()) { toast.error('Vui lòng nhập ghi chú chăm sóc'); return }
    if (images.length === 0) { toast.error('Cần ít nhất 1 ảnh bằng chứng chăm sóc'); return }
    startTransition(async () => {
      const imagePaths = images.map(({ path, name, type, size }) => ({ path, name, type, size }))
      const r = await submitPrescriptionCare(submissionId, note.trim(), imagePaths)
      if (r?.error) { toast.error(r.error); return }
      toast.success('Đã ghi nhận chăm sóc khách hàng')
      router.refresh()
    })
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-1.5">
          <HeartHandshake className="h-4 w-4 text-primary" /> Chăm sóc khách hàng
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="care-note">
              Ghi chú chăm sóc <span className="text-destructive">*</span>
            </label>
            <Textarea
              id="care-note"
              placeholder="VD: Đã gọi/gặp khách, tư vấn tiếp tục dùng thuốc, khách sẽ ghé mua ngày..."
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              required
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              Ảnh bằng chứng <span className="text-destructive">*</span>
            </label>
            <PrescriptionImageUpload
              submissionId={submissionId}
              storeId={storeId}
              value={images}
              onChange={setImages}
              purpose="prescription_care"
            />
          </div>
          <Button type="submit" disabled={pending} className="w-full h-11 text-base">
            {pending ? 'Đang lưu...' : 'Đã chăm sóc'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
