'use client'

import { useRouter, usePathname } from 'next/navigation'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Store } from '@/types'

interface Props {
  stores: Pick<Store, 'id' | 'name'>[]
  currentParams: { status?: string; priority?: string; store_id?: string }
}

const ALL = '__all__'

const STATUS_LABEL: Record<string, string> = {
  [ALL]:       'Tất cả trạng thái',
  todo:        'Chờ thực hiện',
  in_progress: 'Đang thực hiện',
  done:        'Hoàn thành',
  overdue:     'Quá hạn',
}

const PRIORITY_LABEL: Record<string, string> = {
  [ALL]:   'Tất cả ưu tiên',
  urgent:  'Khẩn cấp',
  normal:  'Bình thường',
}

export function TaskFilters({ stores, currentParams }: Props) {
  const router = useRouter()
  const pathname = usePathname()

  function update(key: string, value: string | null) {
    const params = new URLSearchParams()
    const current = { ...currentParams, [key]: value ?? '' }
    Object.entries(current).forEach(([k, v]) => {
      if (v && v !== ALL) params.set(k, v)
    })
    router.push(`${pathname}?${params.toString()}`)
  }

  function clear() {
    router.push(pathname)
  }

  const hasFilters = Object.values(currentParams).some(Boolean)

  const statusVal   = currentParams.status   ?? ALL
  const priorityVal = currentParams.priority ?? ALL
  const storeIdVal  = currentParams.store_id ?? ALL
  const selectedStoreName = stores.find((s) => s.id === storeIdVal)?.name

  return (
    <div className="flex flex-wrap gap-2 items-center">
      <Select value={statusVal} onValueChange={(v) => update('status', v)}>
        <SelectTrigger className="w-40 h-8 text-sm">
          <SelectValue>{STATUS_LABEL[statusVal]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Tất cả trạng thái</SelectItem>
          <SelectItem value="todo">Chờ thực hiện</SelectItem>
          <SelectItem value="in_progress">Đang thực hiện</SelectItem>
          <SelectItem value="done">Hoàn thành</SelectItem>
          <SelectItem value="overdue">Quá hạn</SelectItem>
        </SelectContent>
      </Select>

      <Select value={priorityVal} onValueChange={(v) => update('priority', v)}>
        <SelectTrigger className="w-36 h-8 text-sm">
          <SelectValue>{PRIORITY_LABEL[priorityVal]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Tất cả ưu tiên</SelectItem>
          <SelectItem value="urgent">Khẩn cấp</SelectItem>
          <SelectItem value="normal">Bình thường</SelectItem>
        </SelectContent>
      </Select>

      {stores.length > 0 && (
        <Select value={storeIdVal} onValueChange={(v) => update('store_id', v)}>
          <SelectTrigger className="w-40 h-8 text-sm">
            <SelectValue>
              {selectedStoreName ?? (storeIdVal === ALL ? 'Tất cả cửa hàng' : storeIdVal)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Tất cả cửa hàng</SelectItem>
            {stores.map((s) => (
              <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {hasFilters && (
        <Button variant="ghost" size="sm" onClick={clear} className="h-8 text-xs">
          Xoá bộ lọc
        </Button>
      )}
    </div>
  )
}
