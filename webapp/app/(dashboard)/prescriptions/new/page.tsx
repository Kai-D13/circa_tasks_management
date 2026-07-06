import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { PrescriptionForm } from '@/components/prescriptions/PrescriptionForm'
import { FileImage, ChevronLeft } from 'lucide-react'

export default async function NewPrescriptionPage() {
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')

  if (profile?.role !== 'staff') redirect('/prescriptions')
  if (!profile.store_id) redirect('/prescriptions')

  return (
    <div className="p-4 space-y-4 pb-24 max-w-lg mx-auto">
      <Link href="/prescriptions" className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1">
        <ChevronLeft className="h-3.5 w-3.5" /> Toa thuốc
      </Link>
      {/* Brand-tinted header */}
      <div className="rounded-xl bg-secondary border border-primary/20 p-4 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/15 text-primary shrink-0">
          <FileImage className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-lg font-bold">Nộp toa thuốc</h1>
          <p className="text-xs text-muted-foreground">Nhập mã DHC → chụp toa → gửi. Tick mạn tính nếu cần chăm sóc.</p>
        </div>
      </div>
      <PrescriptionForm storeId={profile.store_id} />
    </div>
  )
}
