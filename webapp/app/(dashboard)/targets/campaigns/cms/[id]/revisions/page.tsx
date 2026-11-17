import { notFound } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isCmsProgramEnabled } from '@/lib/cms/flags'
import { canManageCms } from '@/lib/cms/access'
import { cmsLoadProgramDetail } from '@/lib/cms/server/catalog'
import { cmsRevisionReadable } from '@/lib/cms/server/revisionCaps'
import { CMS_ARCHIVE_PAGE, cmsLoadRevision, cmsLoadRevisionArchive, cmsLoadRevisions } from '@/lib/cms/server/revisionLoad'
import { ErrorState } from '@/components/ds/ErrorState'
import { CmsRevisionHistory } from '@/components/cms/admin/CmsRevisionHistory'

// F-A (spec §2.8) /targets/campaigns/cms/[id]/revisions — lịch sử sửa + số trước sửa (super). r3 (PM P1-02): cổng ĐỌC = module CMS +
// DB 131 + super, KHÔNG phụ thuộc cờ ghi CMS_PROGRAM_REVISION_ENABLED (tắt cờ ghi sau sự cố vẫn xem được lịch sử / lưu trữ). DB 130 ⇒ 404,
// không gọi RPC 131. RPC 131 kiểm super lại ở DB. ?r=<revision> chọn chi tiết, ?page=n phân trang bản trước sửa. Đã chốt vẫn xem được.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export default async function CmsRevisionsPage({ params, searchParams }: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ r?: string; page?: string }>
}) {
  const [{ id }, { r, page }] = await Promise.all([params, searchParams])
  const { user, profile } = await getSessionProfile()
  if (!user) notFound()
  if (!(isCmsProgramEnabled() && canManageCms(profile?.role, user.email))) notFound()
  if (!(await cmsRevisionReadable())) notFound()
  const res = await cmsLoadProgramDetail(id, { manage: true })
  if (!res.ok) {
    console.error('[cms-revisions] query failed:', res.error)
    return <div data-ui-v2="page" data-layout-width="fluid" className="p-4 md:p-6"><ErrorState message="Không tải được chương trình CMS" hint="Thử tải lại trang." /></div>
  }
  if (!res.data) notFound()
  const p = res.data.program
  const n = Number(page)
  const pageNum = Number.isInteger(n) && n > 0 ? n : 1
  const rid = typeof r === 'string' && UUID_RE.test(r) ? r : null
  const [list, selected] = await Promise.all([cmsLoadRevisions(p.id), rid ? cmsLoadRevision(rid) : Promise.resolve(null)])
  // Revision của chương trình khác ⇒ coi như không có (không lộ qua URL).
  const sel = selected && selected.ok && selected.data.programId !== p.id ? { ok: false as const, code: 'CMS_REVISION_NOT_FOUND' } : selected
  const archive = sel?.ok && sel.data.archive.mode !== 'none' ? await cmsLoadRevisionArchive(sel.data.id, pageNum) : null
  return <CmsRevisionHistory program={{ id: p.id, name: p.name }} list={list} selected={sel} archive={archive} page={pageNum} pageSize={CMS_ARCHIVE_PAGE} />
}
