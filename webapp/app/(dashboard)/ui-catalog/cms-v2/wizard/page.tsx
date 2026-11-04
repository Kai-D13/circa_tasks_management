import { notFound, redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { KpiFixtureBoundary } from '@/components/kpi/KpiFixtureBoundary'
import { CmsWizardShell } from '@/components/cms/admin/CmsWizardShell'
import { CmsStepper } from '@/components/cms/admin/CmsStepper'
import { CmsProgramForm, type CmsProgramFormInitial } from '@/components/cms/admin/CmsProgramForm'
import { CmsImportFlow } from '@/components/cms/admin/CmsImportFlow'
import { CMS_FX_PREVIEW, CMS_FX_TODAY } from '@/lib/cms/fixtures'
import { CMS_FX_PG, cmsFxProgram } from '@/lib/cms/fixtureScenario'
import type { CmsInvalidStore } from '@/lib/cms/server/catalog'

// Dev-only fixture A2 / sửa / import — ĐÚNG CmsProgramForm + CmsImportFlow của route thật, dữ liệu giả. Mọi lưu / kiểm tra
// file / ghi / tải file lỗi đi qua useFixtureActionBlocked ⇒ 0 request ghi. Cổng: UI_CATALOG=1 + super admin. ?fx=
//   info (mặc định) · stores (phạm vi chọn nhà thuốc) · edit-active (sửa chương trình đã kích hoạt, Q-214) ·
//   edit-invalid (nháp, phạm vi có 1 nhà thuốc đã ngừng + 1 FS) · edit-active-invalid (đã kích hoạt chưa bắt đầu, có nhà
//   thuốc ngừng) · edit-invalid-only (chỉ còn nhà thuốc không hợp lệ) · upload · running · result (nạp toàn bộ, có lỗi +
//   cảnh báo + nội dung sau điểm dừng) · result-append · result-none (0 hợp lệ)
const STORES = Array.from({ length: 12 }, (_, i) => ({ id: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`, name: `Nhà thuốc mẫu ${i + 1}`, code: `QAOS${String(i + 1).padStart(2, '0')}` }))
// CMS-UI-1: chương trình của kịch bản (lib/cms/fixtureScenario); &program=<id> (link Sửa / Import từ A3 fixture) — mặc định PG1.
const programOf = (id: string | undefined) => { const p = cmsFxProgram(id) ?? cmsFxProgram(CMS_FX_PG.PG1)!; return { id: p.row.id, name: p.row.name } }
const INVALID: CmsInvalidStore[] = [
  { id: '00000000-0000-4000-8000-000000000190', name: 'Nhà thuốc mẫu đã ngừng', code: 'QAOS90', reason: 'inactive' },
  { id: '00000000-0000-4000-8000-000000000191', name: 'Nhà thuốc mẫu FS', code: 'QAFS91', reason: 'not_os' },
]
const EDIT_FX = ['edit-active', 'edit-invalid', 'edit-active-invalid', 'edit-invalid-only']

function formFor(fx: string, PROGRAM: { id: string; name: string }): { initial?: CmsProgramFormInitial; invalid: CmsInvalidStore[] } {
  const base = { id: PROGRAM.id, name: PROGRAM.name, startDate: '2026-11-20', endDate: '2026-12-20', scope: 'stores' as const }
  if (fx === 'edit-active') return { initial: { ...base, storeIds: STORES.slice(0, 3).map((s) => s.id), active: true }, invalid: [] }
  if (fx === 'edit-invalid') return { initial: { ...base, storeIds: [...STORES.slice(0, 2).map((s) => s.id), ...INVALID.map((x) => x.id)], active: false }, invalid: INVALID }
  if (fx === 'edit-active-invalid') return { initial: { ...base, storeIds: [STORES[0].id, INVALID[0].id], active: true }, invalid: [INVALID[0]] }
  if (fx === 'edit-invalid-only') return { initial: { ...base, storeIds: [INVALID[0].id], active: false }, invalid: [INVALID[0]] }
  if (fx === 'stores') return { initial: { ...base, id: '', name: '', startDate: '', endDate: '', storeIds: [], active: false }, invalid: [] }
  return { invalid: [] }
}

export default async function CmsWizardFixture({ searchParams }: { searchParams: Promise<{ fx?: string; program?: string }> }) {
  if (process.env.UI_CATALOG !== '1') notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()
  const { fx = 'info', program } = await searchParams
  const PROGRAM = programOf(program)
  const isEdit = EDIT_FX.includes(fx)
  const isForm = isEdit || fx === 'info' || fx === 'stores'
  const form = formFor(fx, PROGRAM)
  const result = fx === 'result-append' ? { ...CMS_FX_PREVIEW, mode: 'append' as const, ignoredFromRow: null }
    : fx === 'result-none' ? { ...CMS_FX_PREVIEW, groupsOk: [], stats: { ...CMS_FX_PREVIEW.stats, rowsOk: 0, productsOk: 0, warnings: 0 } }
    : CMS_FX_PREVIEW
  return (
    <KpiFixtureBoundary>
      <div data-testid="ui-catalog-cms-wizard" data-fx={fx}>
        <CmsWizardShell
          title={isEdit ? 'Sửa thông tin chương trình' : 'Tạo chương trình CMS'}
          subtitle={isForm && !isEdit ? undefined : PROGRAM.name}
          backHref={program ? `/ui-catalog/cms-v2/detail?program=${encodeURIComponent(PROGRAM.id)}` : '/ui-catalog/cms-v2/list'}
          backLabel="CMS sản phẩm"
          kind={isEdit ? 'edit' : isForm ? 'new' : 'import'}
        >
          {isForm ? (
            <>
              {!isEdit && <CmsStepper current={0} />}
              <CmsProgramForm
                mode={isEdit ? 'edit' : 'create'}
                initial={form.initial}
                stores={STORES}
                storesError={false}
                invalidStores={form.invalid}
                today={CMS_FX_TODAY}
              />
            </>
          ) : (
            <CmsImportFlow
              program={PROGRAM}
              mode={fx === 'result-append' ? 'append' : 'replace'}
              fromNew={fx !== 'result-append'}
              fixture={{ step: fx === 'upload' ? 'upload' : fx === 'running' ? 'running' : 'result', result, fileName: 'Circa_Import_CMS_thang11.xlsx', fileBytes: 48_213 }}
            />
          )}
        </CmsWizardShell>
      </div>
    </KpiFixtureBoundary>
  )
}
