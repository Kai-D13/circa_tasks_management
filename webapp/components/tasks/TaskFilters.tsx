'use client'

import { useRouter, usePathname } from 'next/navigation'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SearchableSelect } from '@/components/ui/searchable-select'
import { Button } from '@/components/ui/button'
import { Store } from '@/types'
import { Archive, ArrowLeft, History, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FILTER_ACTIVE } from '@/components/ds/DataToolbar'

interface Props {
  stores:        Pick<Store, 'id' | 'name'>[]
  departments:   { id: string; name: string }[]
  users:         { id: string; full_name: string; store_id?: string | null }[]
  currentParams: { view?: string; status?: string; priority?: string; store_id?: string; category?: string; department_id?: string; assignee?: string; archived?: string; show_old?: string }
  showArchived?: boolean
  showOld?:      boolean
  view?:         'pending' | 'done'
  isStaff?:      boolean
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

export function TaskFilters({ stores, departments, users, currentParams, showArchived, showOld = false, view = 'pending', isStaff = false }: Props) {
  const router   = useRouter()
  const pathname = usePathname()

  function update(key: string, value: string | null) {
    const params = new URLSearchParams()
    // Exclude 'page' — changing a filter always resets to page 1.
    const current = { ...currentParams, [key]: value ?? '', page: '' }
    Object.entries(current).forEach(([k, v]) => {
      if (v && v !== ALL) params.set(k, v)
    })
    router.push(`${pathname}?${params.toString()}`)
  }

  // Switch the primary view tab. Going to "done" drops the status sub-filter
  // (done view ignores it) and resets to page 1; "pending" is the default so it's
  // omitted from the URL. Priority/store/category carry over — except for Staff,
  // who never see those filters, so we keep their URL clean (view only).
  function setView(v: 'pending' | 'done') {
    const params = new URLSearchParams()
    if (v === 'done') params.set('view', 'done')
    if (!isStaff) {
      ;(['priority', 'store_id', 'category', 'department_id', 'assignee'] as const).forEach((k) => {
        if (currentParams[k]) params.set(k, currentParams[k]!)
      })
      if (v === 'pending' && currentParams.status && currentParams.status !== 'done') {
        params.set('status', currentParams.status)
      }
    }
    const qs = params.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname)
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
    ([k, v]) => k !== 'archived' && k !== 'show_old' && v && v !== 'false'
  )

  const statusVal   = currentParams.status   ?? ALL
  const priorityVal = currentParams.priority ?? ALL
  const storeIdVal  = currentParams.store_id ?? ALL
  const categoryVal = currentParams.category ?? ALL
  const deptIdVal   = currentParams.department_id ?? ALL
  const assigneeVal = currentParams.assignee ?? ALL

  const storeOptions = [
    { value: ALL, label: 'Tất cả cửa hàng' },
    ...stores.map((s) => ({ value: s.id, label: s.name })),
  ]

  // "Người thực hiện": semantics differ by view — pending = who it's assigned to,
  // done = who submitted it. Placeholder carries that meaning.
  const assigneeAllLabel = view === 'done' ? 'Tất cả người nộp' : 'Tất cả người được giao'
  const userOptions = [
    { value: ALL, label: assigneeAllLabel },
    ...users.map((u) => ({ value: u.id, label: u.full_name })),
  ]

  // UI v2 P1.2 (trang /tasks gắn data-ui-v2): CHỈ trình bày — handler/URL/điều kiện hiển thị giữ nguyên.
  // Control lọc: 40px mobile / 36px desktop, chữ 16px mobile; control đang có giá trị ⇒ FILTER_ACTIVE.
  const ctl = 'h-10 md:h-[36px] text-[16px] md:text-[13px]'
  const activeIf = (on: boolean) => (on ? FILTER_ACTIVE : undefined)
  const ghostBtn = 'h-[44px] md:h-8 gap-1.5 px-2.5 text-[13px] text-muted-foreground hover:text-foreground'

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {/* Primary view tab — always visible (except in archive view). Segmented v2: tab đang chọn
            TRUNG TÍNH (nền panel + viền), cam chỉ dành cho hành động (PM duyệt 16/10, thay coral cũ). */}
        {!showArchived && (
          <div className="inline-flex w-full gap-1 rounded-v2-control bg-muted p-1 sm:w-auto">
            {(['pending', 'done'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                aria-pressed={view === v}
                className={cn(
                  // Mobile: [44px] PIXEL touch height (root 15px rem-trap); desktop gọn.
                  'flex-1 sm:flex-none px-4 min-h-[44px] sm:min-h-0 sm:h-[30px] rounded-[8px] border text-sm sm:text-[13px] font-medium transition-colors',
                  view === v
                    ? 'border-input bg-card font-semibold text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {v === 'pending' ? 'Chờ thực hiện' : 'Hoàn thành'}
              </button>
            ))}
          </div>
        )}

        {showArchived ? (
          <Button variant="outline" size="sm" className="h-[44px] md:h-8 gap-1.5 text-[13px]" onClick={toggleArchive}>
            <ArrowLeft className="h-3.5 w-3.5" />
            Quay lại task đang hoạt động
          </Button>
        ) : !isStaff && (
          <div className="flex flex-wrap items-center gap-1 sm:ml-auto">
            {/* Reveal tasks older than 14 days (hidden by default for a clean
                overview). View-only — no archiving involved. */}
            <Button
              variant="ghost"
              size="sm"
              className={cn(ghostBtn, activeIf(showOld))}
              aria-pressed={showOld}
              onClick={() => update('show_old', showOld ? null : 'true')}
            >
              <History className="h-3.5 w-3.5" />
              {showOld ? 'Ẩn task cũ' : 'Hiện task cũ (>14 ngày)'}
            </Button>
            <Button variant="ghost" size="sm" className={ghostBtn} onClick={toggleArchive}>
              <Archive className="h-3.5 w-3.5" />
              Xem task đã lưu trữ
            </Button>
          </div>
        )}
      </div>

      {!showArchived && (
        <div className="flex flex-wrap items-center gap-2">
          {/* Status sub-filter: only refines the pending view, desktop only
              (on mobile the tab is the status control). Staff never see it —
              their screen is just the two tabs. */}
          {!isStaff && view === 'pending' && (
            <Select value={statusVal} onValueChange={(v) => update('status', v)}>
              <SelectTrigger className={cn('w-40 h-8 md:h-[36px] text-sm md:text-[13px] hidden md:flex', activeIf(statusVal !== ALL))}>
                <SelectValue>{STATUS_LABEL[statusVal]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Tất cả trạng thái</SelectItem>
                <SelectItem value="todo">Chờ thực hiện</SelectItem>
                <SelectItem value="in_progress">Đang thực hiện</SelectItem>
                <SelectItem value="overdue">Quá hạn</SelectItem>
              </SelectContent>
            </Select>
          )}

          {!isStaff && (
            <Select value={priorityVal} onValueChange={(v) => update('priority', v)}>
              <SelectTrigger className={cn('w-36', ctl, activeIf(priorityVal !== ALL))}>
                <SelectValue>{PRIORITY_LABEL[priorityVal]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Tất cả ưu tiên</SelectItem>
                <SelectItem value="urgent">Khẩn cấp</SelectItem>
                <SelectItem value="normal">Bình thường</SelectItem>
              </SelectContent>
            </Select>
          )}

          {stores.length > 0 && (
            <SearchableSelect
              value={storeIdVal}
              options={storeOptions}
              onValueChange={(v) => update('store_id', v)}
              placeholder="Tất cả cửa hàng"
              triggerClassName={cn('w-40', ctl, activeIf(storeIdVal !== ALL))}
            />
          )}

          {!isStaff && (
            <Select value={categoryVal} onValueChange={(v) => update('category', v)}>
              <SelectTrigger className={cn('w-36', ctl, activeIf(categoryVal !== ALL))}>
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
          )}

          {!isStaff && departments.length > 0 && (
            <Select value={deptIdVal} onValueChange={(v) => update('department_id', v)}>
              <SelectTrigger className={cn('w-40', ctl, activeIf(deptIdVal !== ALL))}>
                <SelectValue>
                  {deptIdVal === ALL ? 'Tất cả bộ phận' : (departments.find((d) => d.id === deptIdVal)?.name ?? 'Bộ phận')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Tất cả bộ phận</SelectItem>
                {departments.map((d) => (
                  <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {/* Người thực hiện: pending = người được giao (assigned_to), done =
              người đã nộp (completed_by). Searchable — a store can have many staff. */}
          {!isStaff && users.length > 0 && (
            <SearchableSelect
              value={assigneeVal}
              options={userOptions}
              onValueChange={(v) => update('assignee', v)}
              placeholder={assigneeAllLabel}
              triggerClassName={cn('w-44', ctl, activeIf(assigneeVal !== ALL))}
            />
          )}

          {!isStaff && hasFilters && (
            <Button variant="ghost" size="sm" onClick={clear} className={cn(ghostBtn, 'md:h-[36px]')}>
              <X className="h-3.5 w-3.5" />
              Xoá bộ lọc
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
