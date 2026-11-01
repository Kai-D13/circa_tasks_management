import { notFound } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isCmsProgramEnabled } from '@/lib/cms/flags'
import { canManageCms, canViewCmsAdmin } from '@/lib/cms/access'
import { cmsLoadProgramDetail } from '@/lib/cms/server/catalog'
import { cmsTodayVn } from '@/lib/cms/programStatus'
import { ErrorState } from '@/components/ds/ErrorState'
import { CmsProgramDetailView } from '@/components/cms/admin/CmsProgramDetailView'

// CMS P1-c · A3 /targets/campaigns/cms/[id]. Cổng như A1 (cờ + super / SM). Chương trình ngoài phạm vi RLS (kể cả QA không
// marker — H9b) ⇒ 404 như không tồn tại. SM chỉ đọc. Lỗi truy vấn ⇒ ErrorState (không danh mục rỗng giả).
export default async function CmsProgramPage({ params, searchParams }: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ view?: string }>
}) {
  const [{ id }, { view }] = await Promise.all([params, searchParams])
  const { user, profile } = await getSessionProfile()
  if (!user) notFound()
  if (!(isCmsProgramEnabled() && canViewCmsAdmin(profile?.role, user.email))) notFound()
  const canManage = canManageCms(profile?.role, user.email)
  const res = await cmsLoadProgramDetail(id, { manage: canManage })
  if (!res.ok) {
    console.error('[cms-detail] query failed:', res.error)
    return (
      <div data-ui-v2="page" data-layout-width="fluid" className="p-4 md:p-6">
        <ErrorState message="Không tải được chương trình CMS" hint="Thử tải lại trang." />
      </div>
    )
  }
  if (!res.data) notFound()
  return <CmsProgramDetailView detail={res.data} today={cmsTodayVn(new Date())} canManage={canManage} view={view === 'runs' ? 'runs' : 'products'} />
}
