'use client'

import { useRouter } from 'next/navigation'
import { SearchableSelect } from '@/components/ui/searchable-select'
import { CARE_STATUS_FILTERS, CARE_STATUS_LABELS, careFilterHref, type CareFilters } from '@/lib/care/browse'

// Bộ lọc /care và /care/tasks (SPEC B3 §2). Chỉ ghi vào URL các khoá KHÔNG phải PII
// (tháng/store/dược sĩ/trạng thái). Đổi lọc ⇒ về trang 1. Server tự kiểm lại và chỉ
// THU HẸP phạm vi RLS — giá trị ngoài phạm vi chỉ cho kết quả rỗng.

export function CareFiltersBar({
  path, filters, months, stores, staff, showStatus,
}: {
  path: string
  filters: CareFilters
  months: { value: string; label: string }[]
  stores: { id: string; code: string; name: string }[]
  staff?: { id: string; fullName: string; storeCode: string }[]
  showStatus?: boolean
}) {
  const router = useRouter()
  const go = (over: Partial<CareFilters>) => router.push(careFilterHref(path, filters, { ...over, page: 1 }))
  const selectCls = 'h-10 min-h-[44px] rounded-md border bg-background px-2 text-[16px] md:min-h-0 md:text-sm'
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="care-filters">
      <select aria-label="Kỳ chăm sóc" className={selectCls} value={filters.month.slice(0, 7)}
        onChange={(e) => go({ month: `${e.target.value}-01` })}>
        {months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
      </select>
      <SearchableSelect
        value={filters.storeId ?? ''}
        onValueChange={(v) => go({ storeId: v || null, assigneeId: null })}
        options={[{ value: '', label: 'Tất cả cửa hàng' }, ...stores.map((s) => ({ value: s.id, label: s.code, description: s.name, keywords: [s.name] }))]}
        placeholder="Cửa hàng"
        searchPlaceholder="Tìm mã/tên cửa hàng…"
        triggerClassName="min-h-[44px] md:min-h-0 w-full md:w-56"
        className="w-full md:w-auto"
      />
      {staff && (
        <SearchableSelect
          value={filters.assigneeId ?? ''}
          onValueChange={(v) => go({ assigneeId: v || null })}
          options={[{ value: '', label: 'Tất cả dược sĩ' }, ...staff
            .filter((s) => !filters.storeId || stores.find((x) => x.id === filters.storeId)?.code === s.storeCode)
            .map((s) => ({ value: s.id, label: s.fullName, description: s.storeCode }))]}
          placeholder="Dược sĩ"
          searchPlaceholder="Tìm dược sĩ…"
          triggerClassName="min-h-[44px] md:min-h-0 w-full md:w-56"
          className="w-full md:w-auto"
        />
      )}
      {showStatus && (
        <select aria-label="Trạng thái" className={selectCls} value={filters.status ?? ''}
          onChange={(e) => go({ status: (e.target.value || null) as CareFilters['status'] })}>
          <option value="">Mọi trạng thái</option>
          {CARE_STATUS_FILTERS.map((s) => <option key={s} value={s}>{CARE_STATUS_LABELS[s]}</option>)}
        </select>
      )}
    </div>
  )
}
