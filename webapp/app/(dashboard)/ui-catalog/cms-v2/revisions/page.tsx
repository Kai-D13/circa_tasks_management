import { notFound, redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { KpiFixtureBoundary } from '@/components/kpi/KpiFixtureBoundary'
import { CmsRevisionHistory } from '@/components/cms/admin/CmsRevisionHistory'
import { CMS_FX_REV_ARCHIVE, CMS_FX_REV_DETAIL, CMS_FX_REV_LIST, CMS_FX_REV_PROGRAM } from '@/lib/cms/revision/fixtures'

// Dev-only fixture F-A — ĐÚNG CmsRevisionHistory của /targets/campaigns/cms/[id]/revisions, dữ liệu giả (chỉ đọc). Cổng: UI_CATALOG=1 + super.
//   ?fx= list (mặc định: 3 lần sửa, chưa chọn) · detail (chọn lần v6 → v7: lý do, diff, dự toán, số trước sửa có K / bậc của chính lượt) ·
//   empty (chưa có lần sửa) · error (không tải được danh sách / chi tiết).
const PAGE = 200

export default async function CmsRevisionsFixture({ searchParams }: { searchParams: Promise<{ fx?: string }> }) {
  if (process.env.UI_CATALOG !== '1') notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()
  const { fx = 'list' } = await searchParams
  const list = fx === 'error' ? { ok: false as const, code: 'CMS_REVISION_FAILED' } : { ok: true as const, data: fx === 'empty' ? [] : CMS_FX_REV_LIST }
  const selected = fx === 'detail' ? { ok: true as const, data: CMS_FX_REV_DETAIL } : fx === 'error' ? { ok: false as const, code: 'CMS_REVISION_FAILED' } : null
  const archive = fx === 'detail' ? { ok: true as const, data: CMS_FX_REV_ARCHIVE } : null
  return (
    <KpiFixtureBoundary>
      <div data-testid="ui-catalog-cms-revisions" data-fx={fx}>
        <CmsRevisionHistory program={CMS_FX_REV_PROGRAM} list={list} selected={selected} archive={archive} page={1} pageSize={PAGE} />
      </div>
    </KpiFixtureBoundary>
  )
}
