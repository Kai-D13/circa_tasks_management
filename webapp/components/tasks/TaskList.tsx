'use client'

import React, { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import { archiveTasks, restoreTasks } from '@/app/actions/tasks'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { TaskStatusBadge } from '@/components/tasks/TaskStatusBadge'
import { TaskPriorityBadge } from '@/components/tasks/TaskPriorityBadge'
import { formatDate, formatShiftTime, getEffectiveStatus } from '@/lib/dateUtils'
import { Radio, Archive, ArchiveRestore, ChevronRight, ChevronDown, Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Task, TaskCategory } from '@/types'

const CATEGORY_STYLE: Record<TaskCategory, string> = {
  training: 'bg-blue-100 text-blue-700',
  recall:   'bg-red-100 text-red-700',
  display:  'bg-green-100 text-green-700',
  audit:    'bg-amber-100 text-amber-700',
  other:    'bg-gray-100 text-gray-600',
}
const CATEGORY_LABEL: Record<TaskCategory, string> = {
  training: 'Training',
  recall:   'Thu hồi',
  display:  'Trưng bày',
  audit:    'Kiểm tra',
  other:    'Khác',
}

export type ChildTask = {
  id:         string
  status:     string
  stores:     { name: string } | null
  assignee:   { full_name: string } | null
  deadline:   string | null
  overdue_at: string | null
}

export type BroadcastGroup = {
  type:        'broadcast'
  broadcastId: string
  title:       string
  category:    string | null
  total:       number
  done:        number
  createdAt:   string
  taskIds:     string[]
  childTasks:  ChildTask[]
}

// staff_all parent: overview row that folds in one child per pharmacist. Unlike a
// broadcast (a virtual group), the parent is a real task with its own detail page,
// so the title links to /tasks/<parentId> while the chevron expands inline.
export type StaffGroup = {
  type:       'staff'
  parentId:   string
  title:      string
  category:   string | null
  storeName:  string | null
  total:      number
  done:       number
  createdAt:  string
  taskIds:    string[]      // parent + children, for archive selection
  childTasks: ChildTask[]   // one per staff; child.assignee = pharmacist name
}

export type TaskRow = {
  type: 'task'
  task: {
    id:                 string
    title:              string
    status:             string
    priority:           string
    category:           string | null
    broadcast_id:       string | null
    source_schedule_id: string | null
    assignment_mode:    string | null
    assigned_to:        string | null
    stores:             { name: string } | null
    assignee:           { full_name: string } | null
    completed_by_user:  { full_name: string } | null
    completed_at:       string | null
    deadline:           string | null
    overdue_at:         string | null
    created_at:         string
  }
}

export type TaskListItem = BroadcastGroup | StaffGroup | TaskRow

interface Props {
  items:         TaskListItem[]
  canArchive:    boolean
  canRestore?:   boolean
  showArchived?: boolean
  userRole?:     string
}

// "Thực hiện / Đã nộp" cell content — shared by table and mobile cards.
//   store-level + done -> "Đã nộp: <name>" + "Nộp <datetime>"
//   store-level + open -> "Cửa hàng nộp"
//   direct assignee     -> "<name>" (+ submit time when done)
//   else                -> "Chưa phân công"
function getSubmitterDisplay(task: TaskRow['task']): { primary: string; sub: string | null } {
  const isStoreLevel = task.assignment_mode === 'store' && task.assigned_to === null
  const submitSub = task.completed_at ? formatShiftTime(task.completed_at) : null
  if (isStoreLevel) {
    if (task.status === 'done' && task.completed_by_user)
      return { primary: `Đã nộp: ${task.completed_by_user.full_name}`, sub: submitSub }
    return { primary: 'Cửa hàng nộp', sub: null }
  }
  if (task.assignee)
    return { primary: task.assignee.full_name, sub: task.status === 'done' ? submitSub : null }
  return { primary: 'Chưa phân công', sub: null }
}

// Due within the next 24h and not yet done/overdue — surfaces "Sắp hết hạn".
function isDueSoon(deadline: string | null, effStatus: string): boolean {
  if (!deadline || effStatus === 'done' || effStatus === 'overdue') return false
  const ms = new Date(deadline).getTime() - Date.now()
  return ms > 0 && ms <= 24 * 60 * 60 * 1000
}

// Badge cluster shared by the desktop table title cell and the mobile card, so
// the two layouts never drift. The broadcast Radio icon stays next to the title.
// Two always-on taxonomy badges + situational signals:
//   source  -> Định kỳ (recurring) | Phát sinh (one-off)
//   method  -> Cửa hàng nộp (unassigned store task) | Dược sĩ nộp (assigned/per-staff)
//   signals -> Bạn có thể nộp (executor, open) · Sắp hết hạn (≤24h)
function TaskBadges({ task, userRole, effStatus }: {
  task: TaskRow['task']; userRole?: string; effStatus: string
}) {
  const isStoreLevelRow = task.assignment_mode === 'store' && task.assigned_to === null
  const canSubmitHint = isStoreLevelRow && effStatus !== 'done'
    && (userRole === 'staff' || userRole === 'store_manager')
  const isRecurring = !!task.source_schedule_id
  return (
    <>
      <span className={cn(
        'text-xs px-1.5 py-0.5 rounded',
        isRecurring ? 'bg-teal-100 text-teal-700' : 'bg-slate-100 text-slate-600',
      )}>
        {isRecurring ? 'Định kỳ' : 'Phát sinh'}
      </span>
      {isStoreLevelRow ? (
        <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">
          <Users className="h-3 w-3" /> Cửa hàng nộp
        </span>
      ) : (
        <span className="text-xs px-1.5 py-0.5 rounded bg-sky-100 text-sky-700">Dược sĩ nộp</span>
      )}
      {task.category && task.category !== 'other' && (
        <span className={cn(
          'text-xs px-1.5 py-0.5 rounded',
          CATEGORY_STYLE[task.category as TaskCategory] ?? 'bg-gray-100 text-gray-600'
        )}>
          {CATEGORY_LABEL[task.category as TaskCategory] ?? task.category}
        </span>
      )}
      {canSubmitHint && (
        <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">Bạn có thể nộp</span>
      )}
      {isDueSoon(task.deadline, effStatus) && (
        <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">Sắp hết hạn</span>
      )}
    </>
  )
}

export function TaskList({ items, canArchive, canRestore, showArchived, userRole }: Props) {
  const router = useRouter()
  const [selected, setSelected]    = useState<Set<string>>(new Set())
  const [expanded, setExpanded]    = useState<Set<string>>(new Set())
  const [pending, startTransition] = useTransition()

  // All archivable task IDs across both individual tasks and broadcast groups
  const allTaskIds: string[] = items.flatMap((item) =>
    item.type === 'task' ? [item.task.id] : item.taskIds
  )

  function toggleTask(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleGroup(taskIds: string[]) {
    const allInGroup = taskIds.every((id) => selected.has(id))
    setSelected((prev) => {
      const next = new Set(prev)
      if (allInGroup) {
        taskIds.forEach((id) => next.delete(id))
      } else {
        taskIds.forEach((id) => next.add(id))
      }
      return next
    })
  }

  function toggleAll() {
    if (selected.size === allTaskIds.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(allTaskIds))
    }
  }

  function toggleExpand(broadcastId: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(broadcastId)) next.delete(broadcastId)
      else next.add(broadcastId)
      return next
    })
  }

  function handleArchive() {
    const ids = Array.from(selected)
    startTransition(async () => {
      const result = await archiveTasks(ids)
      if (result?.error) {
        toast.error(result.error)
      } else {
        const count = (result as { count?: number }).count ?? ids.length
        toast.success(`Đã lưu trữ ${count} task`)
        setSelected(new Set())
        router.refresh()
      }
    })
  }

  function handleRestore() {
    const ids = Array.from(selected)
    startTransition(async () => {
      const result = await restoreTasks(ids)
      if (result?.error) {
        toast.error(result.error)
      } else {
        const count = (result as { count?: number }).count ?? ids.length
        toast.success(`Đã khôi phục ${count} task`)
        setSelected(new Set())
        router.refresh()
      }
    })
  }

  const allSelected  = allTaskIds.length > 0 && selected.size === allTaskIds.length
  const someSelected = selected.size > 0
  const showCheckbox = canArchive || canRestore
  const colCount     = showCheckbox ? 8 : 7

  return (
    <div className="space-y-2">
      {someSelected && (canArchive || canRestore) && (
        <div className="flex items-center gap-2 px-1 pt-2">
          <span className="text-sm text-muted-foreground">{selected.size} task đã chọn</span>
          {canArchive && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={handleArchive}
              disabled={pending}
            >
              <Archive className="h-3.5 w-3.5" />
              {pending ? 'Đang xử lý...' : 'Lưu trữ đã chọn'}
            </Button>
          )}
          {canRestore && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={handleRestore}
              disabled={pending}
            >
              <ArchiveRestore className="h-3.5 w-3.5" />
              {pending ? 'Đang xử lý...' : 'Khôi phục đã chọn'}
            </Button>
          )}
        </div>
      )}

      {/* Desktop: dense table. Mobile: card list (below). */}
      <div className="hidden md:block">
      <Table>
        <TableHeader>
          <TableRow>
            {showCheckbox && (
              <TableHead className="w-[40px]">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label="Chọn tất cả"
                  className="h-4 w-4 cursor-pointer accent-primary"
                />
              </TableHead>
            )}
            <TableHead>Tiêu đề</TableHead>
            <TableHead>Cửa hàng</TableHead>
            <TableHead>Thực hiện / Đã nộp</TableHead>
            <TableHead>Ưu tiên</TableHead>
            <TableHead>Trạng thái</TableHead>
            <TableHead>Deadline</TableHead>
            <TableHead>Ngày tạo</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => {
            if (item.type === 'broadcast') {
              const isExpanded    = expanded.has(item.broadcastId)
              const allInSelected = item.taskIds.length > 0 && item.taskIds.every((id) => selected.has(id))
              const someInSelected = item.taskIds.some((id) => selected.has(id))

              return (
                <React.Fragment key={`bc-${item.broadcastId}`}>
                  {/* Broadcast group header row */}
                  <TableRow
                    className="bg-primary/5 hover:bg-primary/10 cursor-pointer"
                  >
                    {showCheckbox && (
                      <TableCell>
                        <input
                          type="checkbox"
                          checked={allInSelected}
                          ref={(el) => { if (el) el.indeterminate = !allInSelected && someInSelected }}
                          onChange={() => toggleGroup(item.taskIds)}
                          aria-label="Chọn broadcast group"
                          className="h-4 w-4 cursor-pointer accent-primary"
                        />
                      </TableCell>
                    )}
                    <TableCell
                      colSpan={4}
                      onClick={() => toggleExpand(item.broadcastId)}
                    >
                      <div className="flex items-center gap-2 font-medium">
                        {isExpanded
                          ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                          : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                        }
                        <Radio className="h-4 w-4 text-primary shrink-0" />
                        <span>{item.title}</span>
                        {item.category && item.category !== 'other' && (
                          <span className={cn(
                            'text-xs px-1.5 py-0.5 rounded',
                            CATEGORY_STYLE[item.category as TaskCategory] ?? 'bg-gray-100 text-gray-600'
                          )}>
                            {CATEGORY_LABEL[item.category as TaskCategory] ?? item.category}
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground font-normal ml-1">
                          {item.total} cửa hàng
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap" onClick={() => toggleExpand(item.broadcastId)}>
                      <span className={cn(
                        'font-medium',
                        item.done === item.total ? 'text-green-600' : 'text-amber-600'
                      )}>
                        {item.done}/{item.total}
                      </span>
                      <span className="text-muted-foreground"> hoàn thành</span>
                    </TableCell>
                    <TableCell onClick={() => toggleExpand(item.broadcastId)} />
                    <TableCell className="text-sm text-muted-foreground" onClick={() => toggleExpand(item.broadcastId)}>
                      {formatDate(item.createdAt)}
                    </TableCell>
                  </TableRow>

                  {/* Expanded child rows */}
                  {isExpanded && item.childTasks.map((child) => (
                    <TableRow key={child.id} className="bg-muted/30 hover:bg-muted/50">
                      {showCheckbox && <TableCell />}
                      <TableCell>
                        <Link
                          href={`/tasks/${child.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          prefetch={false}
                          className="flex items-center gap-1.5 text-sm hover:underline pl-8"
                        >
                          <span className="text-muted-foreground">↳</span>
                          <span className="font-medium">
                            {child.stores?.name ?? 'Không rõ cửa hàng'}
                          </span>
                        </Link>
                      </TableCell>
                      <TableCell />
                      <TableCell className="text-sm text-muted-foreground">
                        {child.assignee?.full_name ?? 'Chưa phân công'}
                      </TableCell>
                      <TableCell />
                      <TableCell>
                        <TaskStatusBadge status={getEffectiveStatus(child.deadline, child.status) as Task['status']} late={child.status === 'done' && !!child.overdue_at} />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {child.deadline ? formatDate(child.deadline) : '—'}
                      </TableCell>
                      <TableCell />
                    </TableRow>
                  ))}
                </React.Fragment>
              )
            }

            if (item.type === 'staff') {
              const isExpanded     = expanded.has(item.parentId)
              const allInSelected  = item.taskIds.length > 0 && item.taskIds.every((id) => selected.has(id))
              const someInSelected = item.taskIds.some((id) => selected.has(id))

              return (
                <React.Fragment key={`staff-${item.parentId}`}>
                  {/* Staff-required parent header row */}
                  <TableRow className="bg-primary/5 hover:bg-primary/10">
                    {showCheckbox && (
                      <TableCell>
                        <input
                          type="checkbox"
                          checked={allInSelected}
                          ref={(el) => { if (el) el.indeterminate = !allInSelected && someInSelected }}
                          onChange={() => toggleGroup(item.taskIds)}
                          aria-label="Chọn nhóm task dược sĩ"
                          className="h-4 w-4 cursor-pointer accent-primary"
                        />
                      </TableCell>
                    )}
                    <TableCell colSpan={4}>
                      <div className="flex items-center gap-2 font-medium">
                        <button
                          type="button"
                          onClick={() => toggleExpand(item.parentId)}
                          className="shrink-0"
                          aria-label={isExpanded ? 'Thu gọn' : 'Mở rộng'}
                        >
                          {isExpanded
                            ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                            : <ChevronRight className="h-4 w-4 text-muted-foreground" />
                          }
                        </button>
                        <Users className="h-4 w-4 text-primary shrink-0" />
                        <Link
                          href={`/tasks/${item.parentId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          prefetch={false}
                          className="hover:underline"
                        >
                          {item.title}
                        </Link>
                        {item.category && item.category !== 'other' && (
                          <span className={cn(
                            'text-xs px-1.5 py-0.5 rounded',
                            CATEGORY_STYLE[item.category as TaskCategory] ?? 'bg-gray-100 text-gray-600'
                          )}>
                            {CATEGORY_LABEL[item.category as TaskCategory] ?? item.category}
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground font-normal ml-1">
                          {item.storeName ? `${item.storeName} · ` : ''}{item.total} dược sĩ
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap" onClick={() => toggleExpand(item.parentId)}>
                      <span className={cn(
                        'font-medium',
                        item.total > 0 && item.done === item.total ? 'text-green-600' : 'text-amber-600'
                      )}>
                        {item.done}/{item.total}
                      </span>
                      <span className="text-muted-foreground"> đã nộp</span>
                    </TableCell>
                    <TableCell onClick={() => toggleExpand(item.parentId)} />
                    <TableCell className="text-sm text-muted-foreground" onClick={() => toggleExpand(item.parentId)}>
                      {formatDate(item.createdAt)}
                    </TableCell>
                  </TableRow>

                  {/* Expanded per-staff child rows */}
                  {isExpanded && item.childTasks.map((child) => (
                    <TableRow key={child.id} className="bg-muted/30 hover:bg-muted/50">
                      {showCheckbox && <TableCell />}
                      <TableCell>
                        <Link
                          href={`/tasks/${child.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          prefetch={false}
                          className="flex items-center gap-1.5 text-sm hover:underline pl-8"
                        >
                          <span className="text-muted-foreground">↳</span>
                          <span className="font-medium">
                            {child.assignee?.full_name ?? 'Chưa phân công'}
                          </span>
                        </Link>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {child.stores?.name ?? '—'}
                      </TableCell>
                      <TableCell />
                      <TableCell />
                      <TableCell>
                        <TaskStatusBadge status={getEffectiveStatus(child.deadline, child.status) as Task['status']} late={child.status === 'done' && !!child.overdue_at} />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {child.deadline ? formatDate(child.deadline) : '—'}
                      </TableCell>
                      <TableCell />
                    </TableRow>
                  ))}
                </React.Fragment>
              )
            }

            const { task } = item
            const isSelected = selected.has(task.id)
            const effStatus = getEffectiveStatus(task.deadline, task.status)
            const submitter = getSubmitterDisplay(task)

            return (
              <TableRow
                key={task.id}
                className={cn(
                  'cursor-pointer hover:bg-muted/50',
                  isSelected && 'bg-primary/5',
                  effStatus === 'overdue' && !isSelected && 'bg-red-50/60 hover:bg-red-50',
                )}
              >
                {showCheckbox && (
                  <TableCell>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleTask(task.id)}
                      aria-label="Chọn task"
                      className="h-4 w-4 cursor-pointer accent-primary"
                    />
                  </TableCell>
                )}
                <TableCell>
                  <Link href={`/tasks/${task.id}`} target="_blank" rel="noopener noreferrer" prefetch={false} className="font-medium hover:underline flex items-center gap-1.5">
                    {task.title}
                    {task.broadcast_id && (
                      <Radio className="h-3.5 w-3.5 text-primary shrink-0" />
                    )}
                  </Link>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1">
                    <TaskBadges task={task} userRole={userRole} effStatus={effStatus} />
                  </div>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {task.stores?.name ?? '—'}
                </TableCell>
                <TableCell className="text-sm">
                  <span className="font-medium text-foreground">{submitter.primary}</span>
                  {submitter.sub && (
                    <span className="block text-xs text-muted-foreground">{submitter.sub}</span>
                  )}
                </TableCell>
                <TableCell>
                  <TaskPriorityBadge priority={task.priority as Task['priority']} />
                </TableCell>
                <TableCell>
                  <TaskStatusBadge status={effStatus as Task['status']} late={task.status === 'done' && !!task.overdue_at} />
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {task.deadline ? formatDate(task.deadline) : '—'}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {formatDate(task.created_at)}
                </TableCell>
              </TableRow>
            )
          })}

          {items.length === 0 && (
            <TableRow>
              <TableCell colSpan={colCount} className="text-center text-muted-foreground py-10">
                {showArchived ? 'Chưa có task nào được lưu trữ' : 'Không có task đang hoạt động'}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      </div>

      {/* Mobile: card list — same items, tap-to-open, groups expand inline. */}
      <div className="md:hidden space-y-2">
        {items.map((item) => {
          if (item.type === 'broadcast' || item.type === 'staff') {
            const id        = item.type === 'broadcast' ? item.broadcastId : item.parentId
            const isExpanded = expanded.has(id)
            const allDone   = item.total > 0 && item.done === item.total
            const Icon      = item.type === 'broadcast' ? Radio : Users
            return (
              <div key={`m-${item.type}-${id}`} className="rounded-lg border bg-primary/5">
                <button
                  type="button"
                  onClick={() => toggleExpand(id)}
                  className="w-full flex items-center gap-2 p-3 text-left"
                >
                  {isExpanded
                    ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                    : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
                  <Icon className="h-4 w-4 text-primary shrink-0" />
                  <span className="font-medium flex-1 truncate">{item.title}</span>
                  <span className={cn('text-sm font-medium whitespace-nowrap', allDone ? 'text-green-600' : 'text-amber-600')}>
                    {item.done}/{item.total}
                  </span>
                </button>
                {isExpanded && (
                  <div className="border-t divide-y divide-border/60">
                    {item.childTasks.map((child) => (
                      <Link
                        key={child.id}
                        href={`/tasks/${child.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        prefetch={false}
                        className="flex items-center justify-between gap-2 p-2 pl-9 text-sm active:bg-muted/50"
                      >
                        <span className="truncate">
                          {item.type === 'broadcast'
                            ? (child.stores?.name ?? 'Không rõ cửa hàng')
                            : (child.assignee?.full_name ?? 'Chưa phân công')}
                        </span>
                        <TaskStatusBadge
                          status={getEffectiveStatus(child.deadline, child.status) as Task['status']}
                          late={child.status === 'done' && !!child.overdue_at}
                        />
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            )
          }

          const { task } = item
          const effStatus = getEffectiveStatus(task.deadline, task.status)
          const submitter = getSubmitterDisplay(task)
          return (
            <Link
              key={`m-${task.id}`}
              href={`/tasks/${task.id}`}
              target="_blank"
              rel="noopener noreferrer"
              prefetch={false}
              className={cn(
                'block rounded-lg border p-3 active:bg-muted/50',
                effStatus === 'overdue' && 'border-red-200 bg-red-50/50',
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="font-medium flex items-center gap-1.5 min-w-0">
                  <span className="truncate">{task.title}</span>
                  {task.broadcast_id && <Radio className="h-3.5 w-3.5 text-primary shrink-0" />}
                </span>
                <TaskStatusBadge status={effStatus as Task['status']} late={task.status === 'done' && !!task.overdue_at} />
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1">
                <TaskBadges task={task} userRole={userRole} effStatus={effStatus} />
              </div>
              <p className="mt-1.5 text-sm text-muted-foreground">{task.stores?.name ?? '—'}</p>
              <p className="text-sm font-medium">{submitter.primary}</p>
              {submitter.sub && <p className="text-xs text-muted-foreground">{submitter.sub}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <TaskPriorityBadge priority={task.priority as Task['priority']} />
                <span>Hạn: {task.deadline ? formatDate(task.deadline) : '—'}</span>
                <span>Tạo: {formatDate(task.created_at)}</span>
              </div>
            </Link>
          )
        })}

        {items.length === 0 && (
          <p className="text-center text-muted-foreground py-10">
            {showArchived ? 'Chưa có task nào được lưu trữ' : 'Không có task đang hoạt động'}
          </p>
        )}
      </div>
    </div>
  )
}
