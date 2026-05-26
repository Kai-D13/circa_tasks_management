'use client'

import { useRouter, usePathname } from 'next/navigation'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Store } from '@/types'
import { Archive, ArrowLeft } from 'lucide-react'

interface Props {
  stores:        Pick<Store, 'id' | 'name'>[]
  currentParams: { status?: string; priority?: string; store_id?: string; category?: string; archived?: string }
  showArchived?: boolean
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

const CATEGORY_LABEL: Record<string, string> = {
  [ALL]:     'Tất cả loại',
  training:  'Training',
  recall:    'Thu hồi',
  display:   'Trưng bày',
  audit:     'Kiểm tra',
  other:     'Khác',
}

export function TaskFilters({ stores, currentParams, showArchived }: Props) {
  const router   = useRouter()
  const pathname = usePathname()

  function update(key: string, value: string | null) {
    const params = new URLSearchParams()
    const current = { ...currentParams, [key]: value ?? '' }
    Object.entries(current).forEach(([k, v]) => {
      if (v && v !== ALL) params.set(k, v)
    })
    router.push(`${pathname}?${params.toString()}`)
  }

  function toggleArchive() {
    if (showArchived) {
      router.push(pathname)
    } else {
      router.push(`${pathname}?archived=true`)
    }
  }

  function clear() {
    router.push(pathname)
  }

  const hasFilters = !showArchived && Object.entries(currentParams).some(
    ([k, v]) => k !== 'archived' && v && v !== 'false'
  )

  const statusVal   = currentParams.status   ?? ALL
  const priorityVal = currentParams.priority ?? ALL
  const storeIdVal  = currentParams.store_id ?? ALL
  const categoryVal = currentParams.category ?? ALL
  const selectedStoreName = stores.find((s) => s.id === storeIdVal)?.name

  return (
    <div className="flex flex-wrap gap-2 items-center">
      {!showArchived ? (
        <>
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

          <Select value={categoryVal} onValueChange={(v) => update('category', v)}>
            <SelectTrigger className="w-36 h-8 text-sm">
              <SelectValue>{CATEGORY_LABEL[categoryVal] ?? 'Tất cả loại'}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Tất cả loại</SelectItem>
              <SelectItem value="training">Training</SelectItem>
              <SelectItem value="recall">Thu hồi</SelectItem>
              <SelectItem value="display">Trưng bày</SelectItem>
              <SelectItem value="audit">Kiểm tra</SelectItem>
              <SelectItem value="other">Khác</SelectItem>
            </SelectContent>
          </Select>

          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={clear} className="h-8 text-xs">
              Xoá bộ lọc
            </Button>
          )}

          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs gap-1.5 ml-auto"
            onClick={toggleArchive}
          >
            <Archive className="h-3.5 w-3.5" />
            Xem task đã lưu trữ
          </Button>
        </>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs gap-1.5"
          onClick={toggleArchive}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Quay lại task đang hoạt động
        </Button>
      )}
    </div>
  )
}
