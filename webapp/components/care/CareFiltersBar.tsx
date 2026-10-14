'use client'

import { useRouter } from 'next/navigation'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SearchableSelect } from '@/components/ui/searchable-select'
import { careFilterHref, type CareFilters } from '@/lib/care/browse'

// Bộ lọc /care và /care/tasks (SPEC B3 §2). Chỉ ghi vào URL các khoá KHÔNG phải PII
// (tháng/store/dược sĩ/trạng thái). Đổi lọc ⇒ về trang 1. Server tự kiểm lại và chỉ
// THU HẸP phạm vi RLS — giá trị ngoài phạm vi chỉ cho kết quả rỗng.
// B8.1: trạng thái chuyển sang chip có số (/care/tasks); có thể tách kỳ lên header
// (`months` bỏ trống ⇒ không hiện chọn kỳ) và hiện "Xoá lọc" (giữ kỳ, bỏ store/dược sĩ/trạng thái).

export function CareFiltersBar({
  path, filters, months, stores, staff, clearable,
}: {
  path: string
  filters: CareFilters
  months?: { value: string; label: string }[]
  stores?: { id: string; code: string; name: string }[]
  staff?: { id: string; fullName: string; storeCode: string }[]
  clearable?: boolean
}) {
  const router = useRouter()
  const go = (over: Partial<CareFilters>) => router.push(careFilterHref(path, filters, { ...over, page: 1 }))
  // B7-ui: mọi control của thanh lọc cùng cao (mobile 44px, desktop 36px) và cùng bo góc với Input.
  const selectCls = 'h-[44px] rounded-lg border bg-background px-2 text-[16px] md:h-[36px] md:text-sm'
  const filtered = !!(filters.storeId || filters.assigneeId || filters.status)
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="care-filters">
      {months && (
        <select aria-label="Kỳ chăm sóc" className={selectCls} value={filters.month.slice(0, 7)}
          onChange={(e) => go({ month: `${e.target.value}-01` })}>
          {months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      )}
      {stores && (
        <SearchableSelect
          value={filters.storeId ?? ''}
          onValueChange={(v) => go({ storeId: v || null, assigneeId: null })}
          options={[{ value: '', label: 'Tất cả cửa hàng' }, ...stores.map((s) => ({ value: s.id, label: s.code, description: s.name, keywords: [s.name] }))]}
          placeholder="Cửa hàng"
          searchPlaceholder="Tìm mã/tên cửa hàng…"
          triggerClassName="min-h-[44px] md:min-h-0 md:h-[36px] w-full md:w-56"
          className="w-full md:w-auto"
        />
      )}
      {staff && (
        <SearchableSelect
          value={filters.assigneeId ?? ''}
          onValueChange={(v) => go({ assigneeId: v || null })}
          options={[{ value: '', label: 'Tất cả dược sĩ' }, ...staff
            .filter((s) => !filters.storeId || stores?.find((x) => x.id === filters.storeId)?.code === s.storeCode)
            .map((s) => ({ value: s.id, label: s.fullName, description: s.storeCode }))]}
          placeholder="Dược sĩ"
          searchPlaceholder="Tìm dược sĩ…"
          triggerClassName="min-h-[44px] md:min-h-0 md:h-[36px] w-full md:w-56"
          className="w-full md:w-auto"
        />
      )}
      {clearable && filtered && (
        <Button type="button" variant="ghost" className="min-h-[44px] text-primary md:h-[36px] md:min-h-0"
          onClick={() => go({ storeId: null, assigneeId: null, status: null })}>
          <X className="size-4" /> Xoá lọc
        </Button>
      )}
    </div>
  )
}
