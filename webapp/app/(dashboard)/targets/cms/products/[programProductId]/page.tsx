import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { redirectIfFsStaff } from '@/lib/fs/isolation'
import { isCmsProgramEnabled } from '@/lib/cms/flags'
import { cmsLoadStaffProduct } from '@/lib/cms/server/staffCatalog'
import { cmsLoadResults } from '@/lib/cms/server/resultLoad'
import { cmsLoadResultLines } from '@/lib/cms/server/results'
import { CMS_Q206_RETURNS_CONTRACT } from '@/lib/cms/releaseGate'
import { cmsTodayVn } from '@/lib/cms/programStatus'
import type { CmsResultLineDto } from '@/lib/cms/resultView'
import { ErrorState } from '@/components/ds/ErrorState'
import { CmsStaffProductView } from '@/components/cms/staff/CmsStaffProductView'

// CMS P1-d · D2 /targets/cms/products/[programProductId] — staff / QLCH (cùng cổng /targets: đăng nhập, FS ⇒ module FS).
// Cờ CMS_PROGRAM_ENABLED OFF hoặc vai trò khác ⇒ 404 (super / SM xem A3). Sản phẩm ngoài phạm vi RLS 120 (nhà thuốc khác,
// QA không marker, nháp) hoặc chương trình không còn Sắp diễn ra / Đang chạy (H5) ⇒ 404. Lỗi ⇒ ErrorState (không số giả).
// P2-c (I3): số liệu khi cờ CMS_EARNINGS_ENABLED bật + chương trình đã bắt đầu (lib/cms/server/resultLoad — RPC 122 lọc
// phạm vi). Ghi nhận gần đây (staff): đọc dòng của SP trong CÙNG run, tối đa 1 trang 500 dòng rồi lấy 3 dòng cuối; nhiều
// hơn ⇒ không hiện danh sách (chỉ link D3), không đọc lệch run.
const RECENT_PAGE = 500

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
  const manager = profile.role === 'store_manager'
  const results = await cmsLoadResults(res.data.program.id, { started: res.data.program.startDate <= today })
  let recent: CmsResultLineDto[] | null = null
  if (!manager && results.kind === 'loaded' && results.header.run) {
    const row = results.rows.results.find((r) => r.programProductId === programProductId)
    if (!row || row.lineCount === 0) recent = []
    else if (row.lineCount <= RECENT_PAGE) {
      const lines = await cmsLoadResultLines({
        programId: res.data.program.id, runId: results.header.run.id, programProductId, userId: user.id, afterSeq: null, limit: RECENT_PAGE,
      })
      if (lines.ok && lines.data.runId === results.header.run.id && lines.data.nextAfterSeq === null) recent = lines.data.rows.slice(-3).reverse()
    }
  }
  return (
    <CmsStaffProductView data={res.data} today={today} results={results} manager={manager} recent={recent}
      returnsApproved={CMS_Q206_RETURNS_CONTRACT === 'APPROVED'} />
  )
}
