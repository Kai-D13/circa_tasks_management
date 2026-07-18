'use client'

import { useRouter, usePathname } from 'next/navigation'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SearchableSelect } from '@/components/ui/searchable-select'
import { Button } from '@/components/ui/button'
import { Store } from '@/types'
import { Archive, ArrowLeft, History } from 'lucide-react'
import { cn } from '@/lib/utils'

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

  return (
    <div className="space-y-2">
      {/* Primary view tab — always visible (except in archive view). The single
          most important control: "what's still open" vs "history". */}
      {!showArchived && (
        <div className="inline-flex rounded-full sm:rounded-lg border bg-muted/40 p-0.5 w-full sm:w-auto">
          {(['pending', 'done'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={cn(
                // Mobile: pill + [44px] PIXEL touch height (root 15px rem-trap);
                // desktop keeps the compact strip. Active = coral for BOTH tabs
                // (tab-selection state, not a completion status — Pilot-2 review).
                'flex-1 sm:flex-none px-4 min-h-[44px] sm:min-h-0 sm:h-8 rounded-full sm:rounded-md text-sm font-medium transition-colors',
                view === v
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground hover:bg-background/60',
              )}
            >
              {v === 'pending' ? 'Chờ thực hiện' : 'Hoàn thành'}
            </button>
          ))}
        </div>
      )}

    <div className="flex flex-wrap gap-2 items-center">
      {!showArchived ? (
        <>
          {/* Status sub-filter: only refines the pending view, desktop only
              (on mobile the tab is the status control). Staff never see it —
              their screen is just the two tabs. */}
          {!isStaff && view === 'pending' && (
            <Select value={statusVal} onValueChange={(v) => update('status', v)}>
              <SelectTrigger className="w-40 h-8 text-sm hidden md:flex">
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
              <SelectTrigger className="w-36 h-10 md:h-8 text-[16px] md:text-sm">
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
              triggerClassName="w-40 h-10 md:h-8 text-[16px] md:text-sm"
            />
          )}

          {!isStaff && (
            <Select value={categoryVal} onValueChange={(v) => update('category', v)}>
              <SelectTrigger className="w-36 h-10 md:h-8 text-[16px] md:text-sm">
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
              <SelectTrigger className="w-40 h-10 md:h-8 text-[16px] md:text-sm">
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
              triggerClassName="w-44 h-10 md:h-8 text-[16px] md:text-sm"
            />
          )}

          {!isStaff && hasFilters && (
            <Button variant="ghost" size="sm" onClick={clear} className="h-[44px] md:h-8 text-xs">
              Xoá bộ lọc
            </Button>
          )}

          {/* Reveal tasks older than 14 days (hidden by default for a clean
              overview). View-only — no archiving involved. */}
          {!isStaff && (
            <Button
              variant={showOld ? 'default' : 'outline'}
              size="sm"
              className="h-[44px] md:h-8 text-xs gap-1.5 ml-auto"
              onClick={() => update('show_old', showOld ? null : 'true')}
            >
              <History className="h-3.5 w-3.5" />
              {showOld ? 'Ẩn task cũ' : 'Hiện task cũ (>14 ngày)'}
            </Button>
          )}

          {!isStaff && (
            <Button
              variant="outline"
              size="sm"
              className="h-[44px] md:h-8 text-xs gap-1.5"
              onClick={toggleArchive}
            >
              <Archive className="h-3.5 w-3.5" />
              Xem task đã lưu trữ
            </Button>
          )}
        </>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="h-[44px] md:h-8 text-xs gap-1.5"
          onClick={toggleArchive}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Quay lại task đang hoạt động
        </Button>
      )}
    </div>
    </div>
  )
}
