import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { redirectIfFsStaff } from '@/lib/fs/isolation'
import { isCmsProgramEnabled } from '@/lib/cms/flags'
import { cmsLoadStaffProduct } from '@/lib/cms/server/staffCatalog'
import { cmsTodayVn } from '@/lib/cms/programStatus'
import { ErrorState } from '@/components/ds/ErrorState'
import { CmsStaffProductView } from '@/components/cms/staff/CmsStaffProductView'

// CMS P1-d · D2 /targets/cms/products/[programProductId] — staff / QLCH (cùng cổng /targets: đăng nhập, FS ⇒ module FS).
// Cờ CMS_PROGRAM_ENABLED OFF hoặc vai trò khác ⇒ 404 (super / SM xem A3). Sản phẩm ngoài phạm vi RLS 120 (nhà thuốc khác,
// QA không marker, nháp) hoặc chương trình không còn Sắp diễn ra / Đang chạy (H5) ⇒ 404. Lỗi ⇒ ErrorState (không số giả).
export default async function CmsStaffProductPage({ params }: { params: Promise<{ programProductId: string }> }) {
  const { programProductId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const { data: profile } = await supabase.from('users').select('role, store_id').eq('id', user.id).single()
  await redirectIfFsStaff(supabase, profile)
  if (!isCmsProgramEnabled()) notFound()
  if (!(profile?.role === 'staff' || profile?.role === 'store_manager')) notFound()
  const today = cmsTodayVn(new Date())
  const res = await cmsLoadStaffProduct(programProductId, today)
  if (!res.ok) {
    return (
      <div data-ui-v2="page" data-layout-width="centered" className="mx-auto max-w-2xl p-4">
        <ErrorState message="Không tải được sản phẩm CMS" hint="Thử tải lại trang." />
      </div>
    )
  }
  if (!res.data) notFound()
  return <CmsStaffProductView data={res.data} today={today} />
}
