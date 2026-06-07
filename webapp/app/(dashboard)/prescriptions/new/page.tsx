import { redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { PrescriptionForm } from '@/components/prescriptions/PrescriptionForm'

export default async function NewPrescriptionPage() {
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')

  if (profile?.role !== 'staff') redirect('/prescriptions')
  if (!profile.store_id) redirect('/prescriptions')

  return (
    <div className="p-6 space-y-4 pb-24">
      <div>
        <h1 className="text-xl font-semibold">Nộp toa thuốc</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Chụp ảnh toa thuốc và nhập mã đơn hàng DHC.
        </p>
      </div>
      <PrescriptionForm storeId={profile.store_id} />
    </div>
  )
}
