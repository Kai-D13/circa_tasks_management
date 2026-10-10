import { notFound, redirect } from 'next/navigation'
import { ClipboardList } from 'lucide-react'
import { PageHeader } from '@/components/ds/PageHeader'
import { ErrorState } from '@/components/ds/ErrorState'
import { Pagination } from '@/components/common/Pagination'
import { CareImportWizard } from '@/components/care/CareImportWizard'
import { CareImportHistory, type CareImportHistoryRow } from '@/components/care/CareImportHistory'
import { careImportMaxBytes } from '@/lib/care/config'
import { isCareEnabled } from '@/lib/care/flags'
import { getCareImportAccess } from '@/lib/care/server/importAccess'
import { careDataScope } from '@/lib/care/server/qaUi'
import { createClient } from '@/lib/supabase/server'

// /care/assign — Phân công CRM (SPEC B2 §3). Chỉ super / admin phòng có
// care_access.can_import. Cờ OFF hoặc không quyền ⇒ 404 (không lộ chức năng).
// B2 chưa thêm mục sidebar/bottom nav (thuộc B3) — truy cập bằng URL để QA.
const PAGE_SIZE = 20

export default async function CareAssignPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  if (!isCareEnabled()) notFound()
  const access = await getCareImportAccess()
  if (access.kind === 'anonymous') redirect('/login')
  if (access.kind === 'forbidden') notFound()

  if (access.kind === 'unavailable') {
    return (
      <div data-layout-width="fluid" className="space-y-4 p-4 md:p-6">
        <PageHeader title="Phân công chăm sóc khách hàng" icon={ClipboardList} />
        <ErrorState message="Hệ thống CRM chưa sẵn sàng." hint="Cơ sở dữ liệu chưa có cấu hình CRM — báo quản trị." />
      </div>
    )
  }

  const params = await searchParams
  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1)
  const supabase = await createClient()
  const scope = careDataScope()
  // Session client: RLS care_import_batches chỉ cho người có quyền import/xem CRM.
  let historyQ = supabase
    .from('care_import_batches')
    .select('id, period_month, kind, status, row_count, customer_count, created_at, summary, users!care_import_batches_created_by_fkey(full_name)', { count: 'exact' })
  // B6-qa-ui: QA local chỉ hiện batch QA của marker (production giữ nguyên).
  if (scope.kind === 'qa') historyQ = historyQ.eq('id', scope.batchId).eq('is_test', true)
  const { data, count, error } = await historyQ
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)

  const rows: CareImportHistoryRow[] = (data ?? []).map((r) => {
    const u = r.users as { full_name?: string } | { full_name?: string }[] | null
    const name = Array.isArray(u) ? u[0]?.full_name : u?.full_name
    return {
      id: r.id, period_month: r.period_month, kind: r.kind, status: r.status, row_count: r.row_count,
      customer_count: r.customer_count, created_at: r.created_at,
      summary: (r.summary ?? null) as Record<string, unknown> | null, created_by_name: name ?? null,
    }
  })
  const totalRows = count ?? 0

  return (
    <div data-layout-width="fluid" className="space-y-6 p-4 md:p-6">
      <PageHeader
        title="Phân công chăm sóc khách hàng"
        subtitle="Import danh sách khách tháng từ Excel — mỗi khách một task, giao theo dược sĩ ghi trong file."
        icon={ClipboardList}
      />
      <CareImportWizard maxBytes={careImportMaxBytes(process.env)} />
      <section className="space-y-3">
        <h2 className="text-base font-semibold">Lịch sử import</h2>
        {error ? (
          <ErrorState message="Không tải được lịch sử import." hint="Thử tải lại trang." />
        ) : (
          <>
            <CareImportHistory rows={rows} />
            {totalRows > PAGE_SIZE && (
              <Pagination
                page={page}
                totalPages={Math.ceil(totalRows / PAGE_SIZE)}
                totalRows={totalRows}
                pageSize={PAGE_SIZE}
                hrefForPage={(p) => `/care/assign?page=${p}`}
              />
            )}
          </>
        )}
      </section>
    </div>
  )
}
