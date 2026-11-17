import { notFound, redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { KpiFixtureBoundary } from '@/components/kpi/KpiFixtureBoundary'
import { CmsWizardShell } from '@/components/cms/admin/CmsWizardShell'
import { CmsBasisBadges } from '@/components/cms/CmsBasisBadges'
import { CmsRevisionFlow } from '@/components/cms/admin/CmsRevisionFlow'
import { cmsDateRange, cmsDateTime } from '@/lib/cms/display'
import {
  CMS_FX_REV_DONE, CMS_FX_REV_FILE_ERROR, CMS_FX_REV_PREVIEW, CMS_FX_REV_PREVIEW_IMPACT_ERROR, CMS_FX_REV_PREVIEW_MANY_REMOVED, CMS_FX_REV_PREVIEW_PRIOR,
  CMS_FX_REV_PROGRAM,
} from '@/lib/cms/revision/fixtures'
import { CMS_CONFIG_RESET_TEXT } from '@/lib/cms/resultView'

// Dev-only fixture F-A — ĐÚNG CmsWizardShell + CmsRevisionFlow của route /targets/campaigns/cms/[id]/revision, dữ liệu giả. Mọi kiểm tra /
// ghi đi qua useFixtureActionBlocked ⇒ 0 request. Cổng: UI_CATALOG=1 + super admin. ?fx=
//   upload (mặc định, cờ v2 giả lập ⇒ có chọn loại file) · running · file-errors (file còn lỗi: tóm tắt 64 + 83 + bảng lỗi, không lập revision) ·
//   result (diff + dự toán + lý do / tick không tick sẵn) · result-many-removed (bỏ 15 SP, danh sách mã dài) · result-impact-error (nguồn lỗi ⇒
//   không số, nút ghi khoá) · result-prior (r3 P1-03: đã sửa v6→v7, chưa có run mới ⇒ "bản công bố trước thay đổi cấu hình v6", không
//   gọi "đang công bố") · done (đã ghi v6 → v7).
const PREVIEWS = { result: CMS_FX_REV_PREVIEW, 'result-many-removed': CMS_FX_REV_PREVIEW_MANY_REMOVED, 'result-impact-error': CMS_FX_REV_PREVIEW_IMPACT_ERROR,
  'result-prior': CMS_FX_REV_PREVIEW_PRIOR } as const

export default async function CmsRevisionFixture({ searchParams }: { searchParams: Promise<{ fx?: string }> }) {
  if (process.env.UI_CATALOG !== '1') notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()
  const { fx = 'upload' } = await searchParams
  const preview = PREVIEWS[fx as keyof typeof PREVIEWS]
  const step = fx === 'running' ? 'running' as const : preview || fx === 'file-errors' || fx === 'done' ? 'result' as const : 'upload' as const
  const P = CMS_FX_REV_PROGRAM
  return (
    <KpiFixtureBoundary>
      <div data-testid="ui-catalog-cms-revision" data-fx={fx}>
        <CmsWizardShell title="Sửa danh mục / mức CMS" subtitle={P.name} backHref="/ui-catalog/cms-v2/detail" backLabel="Chi tiết chương trình" kind="revision">
          <dl data-cms-revision-context className="grid gap-x-4 gap-y-1.5 rounded-v2-panel border bg-card p-3 text-[13px] sm:grid-cols-[auto_1fr] md:p-4">
            <dt className="text-muted-foreground">Kỳ</dt><dd className="tabular-nums">{cmsDateRange('2026-11-01', '2026-11-30')} (không đổi)</dd>
            <dt className="text-muted-foreground">Phạm vi</dt><dd>Tất cả nhà thuốc OS (25) (không đổi)</dd>
            <dt className="text-muted-foreground">Cách tính</dt>
            <dd className="flex flex-wrap items-center gap-1.5"><CmsBasisBadges basis={{ basis: 'pos_base', source: 'admin', returnsPolicy: 'sales_only_v1' }} /> (không đổi)</dd>
            <dt className="text-muted-foreground">Cấu hình hiện hành</dt><dd className="tabular-nums">{fx === 'result-prior' ? 'v7 · 14 sản phẩm' : 'v6 · 13 sản phẩm'}</dd>
            <dt className="text-muted-foreground">Đang công bố</dt>
            <dd className="tabular-nums">{fx === 'result-prior' ? CMS_CONFIG_RESET_TEXT : <>Lượt cấu hình v6 · mốc {cmsDateTime('2026-11-17T05:00:00.000Z')}</>}</dd>
          </dl>
          <CmsRevisionFlow
            program={P}
            v2
            publishedAt="2026-11-17T05:00:00.000Z"
            fixture={{
              step,
              ...(preview ? { preview } : {}),
              ...(fx === 'file-errors' ? { fileError: CMS_FX_REV_FILE_ERROR } : {}),
              ...(fx === 'done' ? { done: CMS_FX_REV_DONE } : {}),
            }}
          />
        </CmsWizardShell>
      </div>
    </KpiFixtureBoundary>
  )
}
