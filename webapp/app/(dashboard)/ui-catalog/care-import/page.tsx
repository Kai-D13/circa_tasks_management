import { notFound, redirect } from 'next/navigation'
import { ClipboardList } from 'lucide-react'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { PageHeader } from '@/components/ds/PageHeader'
import { CareImportWizard } from '@/components/care/CareImportWizard'
import { CareImportPageActions } from '@/components/care/CareImportPanels'
import { CareImportHistory, type CareImportHistoryRow } from '@/components/care/CareImportHistory'

// Dev-only bàn thử UI cho wizard import CRM (B2). 100% DỮ LIỆU GIẢ: lịch sử là
// fixture cứng; wizard gọi /api/care/import/* nhưng e2e/care-import-ui.spec.ts
// chặn và trả JSON giả bằng page.route — nên kiểm được UI khi DB chưa có
// migration 114. Cùng cổng với /ui-catalog: UI_CATALOG=1 (Coolify không bao giờ
// đặt ⇒ production 404) + super admin. Không phụ thuộc CARE_ENABLED.

const FAKE_HISTORY: CareImportHistoryRow[] = [
  {
    id: '00000000-0000-4000-8000-000000000001', period_month: '2026-10-01', kind: 'revision', status: 'committed',
    row_count: 200, customer_count: 101, created_at: '2026-10-05T03:15:00Z', created_by_name: 'QA Marketing',
    summary: { created: 1, updated: 2, unchanged: 97, skipped_has_interaction: 1 },
  },
  {
    id: '00000000-0000-4000-8000-000000000002', period_month: '2026-10-01', kind: null, status: 'rejected',
    row_count: 14, customer_count: null, created_at: '2026-10-04T09:00:00Z', created_by_name: 'QA Marketing',
    summary: { error_count: 3, errors: [{ row: 3, code: 'STORE_INVALID' }, { row: 5, code: 'ASSIGNEE_AMBIGUOUS' }, { row: 9, code: 'REFUSED_AT_STORE' }] },
  },
  {
    id: '00000000-0000-4000-8000-000000000003', period_month: '2026-10-01', kind: null, status: 'duplicate',
    row_count: 200, customer_count: null, created_at: '2026-10-02T02:00:00Z', created_by_name: 'QA Marketing', summary: {},
  },
  {
    id: '00000000-0000-4000-8000-000000000004', period_month: '2026-10-01', kind: 'initial', status: 'committed',
    row_count: 200, customer_count: 100, created_at: '2026-10-01T01:30:00Z', created_by_name: 'QA Marketing',
    summary: { created: 100, updated: 0, unchanged: 0, skipped_has_interaction: 0 },
  },
]

export default async function CareImportCatalogPage() {
  if (process.env.UI_CATALOG !== '1') notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()

  return (
    <div data-layout-width="fluid" data-care-browse className="space-y-6 p-4 md:p-6">
      <PageHeader title="Phân công chăm sóc khách hàng" subtitle="UI catalog — dữ liệu giả, API được giả lập trong test" icon={ClipboardList}
        actions={<CareImportPageActions period="2026-10-01" />} />
      {/* Kỳ cố định 10/2026 khớp now() giả của test (handler thật dựng JSON). */}
      <CareImportWizard maxBytes={8 * 1024 * 1024} period="2026-10-01" tasksHref="/care/tasks" />
      <section className="space-y-3">
        <h2 className="text-base font-semibold">Lịch sử import</h2>
        <CareImportHistory rows={FAKE_HISTORY} />
      </section>
    </div>
  )
}
