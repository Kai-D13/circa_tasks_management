import { HeartHandshake } from 'lucide-react'
import { PageHeader } from '@/components/ds/PageHeader'
import { ErrorState } from '@/components/ds/ErrorState'
import { CareMyHome } from '@/components/care/CareMyHome'
import { CARE_MY_PAGE_SIZE, parseMyFilters } from '@/lib/care/my'
import { carePeriodOf, vnDateISO } from '@/lib/care/time'
import { loadMySummary, loadMyTaskPage, requireCareStaff } from '@/lib/care/server/my'
import { searchMyCareTasks } from '@/app/actions/careMy'

// /care/my — "Khách hàng của tôi" (SPEC B4 §2): dược sĩ OS, task kỳ hiện tại giao cho mình.
// Cờ OFF ⇒ 404 trước mọi đọc; role khác ⇒ 404. Đọc bằng session + RLS 114.
export default async function CareMyPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireCareStaff()
  const header = <PageHeader title="Khách hàng của tôi" subtitle="Chăm sóc khách trong tháng" icon={HeartHandshake} />
  const now = new Date()
  const today = vnDateISO(now)
  const f = parseMyFilters(await searchParams)
  try {
    const [summary, list] = await Promise.all([
      loadMySummary(),
      loadMyTaskPage(me, carePeriodOf(now), f.filter, f.page, today),
    ])
    return (
      <div data-layout-width="fluid" className="space-y-4 p-4 md:p-6">
        {header}
        <CareMyHome key={`${f.filter}:${f.page}`} summary={summary} rows={list.rows} total={list.total} filter={f.filter} page={f.page}
          pageSize={CARE_MY_PAGE_SIZE} todayISO={today} search={searchMyCareTasks} />
      </div>
    )
  } catch {
    return (
      <div data-layout-width="fluid" className="space-y-4 p-4 md:p-6">
        {header}
        <ErrorState message="Hệ thống chăm sóc khách hàng chưa sẵn sàng." hint="Thử tải lại trang; nếu vẫn lỗi, báo quản lý." />
      </div>
    )
  }
}
