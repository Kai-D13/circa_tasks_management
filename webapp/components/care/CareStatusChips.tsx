import { FilterTabs } from '@/components/ds/FilterTabs'
import { careStatusChipTabs, type CareFilters } from '@/lib/care/browse'
import { loadCareStatusCounts } from '@/lib/care/server/browse'

// B8.1 — chip trạng thái /care/tasks có số (server component, stream trong <Suspense>). Số đếm chạy SAU
// khi danh sách đã đọc xong để không tranh pool kết nối PostgREST với truy vấn danh sách (đo 13/10:
// danh sách + 6 count cùng lúc ≈ 800 ms so với ≈ 230–300 ms đọc riêng). Lỗi count ⇒ chip không có số
// (không 0 giả); fallback của Suspense cũng là chip không số nên bố cục không nhảy.

export function CareStatusChipsBare({ path, filters }: { path: string; filters: CareFilters }) {
  return <FilterTabs variant="chip" ariaLabel="Lọc theo trạng thái" activeKey={filters.status ?? 'all'} tabs={careStatusChipTabs(path, filters, null)} />
}

export async function CareStatusChips({ path, filters, todayISO }: { path: string; filters: CareFilters; todayISO: string }) {
  const counts = await loadCareStatusCounts(filters, todayISO).catch(() => null)
  return <FilterTabs variant="chip" ariaLabel="Lọc theo trạng thái" activeKey={filters.status ?? 'all'} tabs={careStatusChipTabs(path, filters, counts)} />
}
