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
import { formatDistanceToNow } from '@/lib/dateUtils'
import { Radio, Archive, ArchiveRestore, ChevronRight, ChevronDown } from 'lucide-react'
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
  id:       string
  status:   string
  stores:   { name: string } | null
  assignee: { full_name: string } | null
  deadline: string | null
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

export type TaskRow = {
  type: 'task'
  task: {
    id:           string
    title:        string
    status:       string
    priority:     string
    category:     string | null
    broadcast_id: string | null
    stores:       { name: string } | null
    assignee:     { full_name: string } | null
    deadline:     string | null
    created_at:   string
  }
}

export type TaskListItem = BroadcastGroup | TaskRow

interface Props {
  items:         TaskListItem[]
  canArchive:    boolean
  canRestore?:   boolean
  showArchived?: boolean
}

export function TaskList({ items, canArchive, canRestore, showArchived }: Props) {
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

  function toggleBroadcast(group: BroadcastGroup) {
    const allInGroup = group.taskIds.every((id) => selected.has(id))
    setSelected((prev) => {
      const next = new Set(prev)
      if (allInGroup) {
        group.taskIds.forEach((id) => next.delete(id))
      } else {
        group.taskIds.forEach((id) => next.add(id))
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
  const colCount     = showCheckbox ? 7 : 6

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
            <TableHead>Người thực hiện</TableHead>
            <TableHead>Ưu tiên</TableHead>
            <TableHead>Trạng thái</TableHead>
            <TableHead>Deadline</TableHead>
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
                          onChange={() => toggleBroadcast(item)}
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
                  </TableRow>

                  {/* Expanded child rows */}
                  {isExpanded && item.childTasks.map((child) => (
                    <TableRow key={child.id} className="bg-muted/30 hover:bg-muted/50">
                      {showCheckbox && <TableCell />}
                      <TableCell>
                        <Link
                          href={`/tasks/${child.id}`}
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
                        <TaskStatusBadge status={child.status as Task['status']} />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {child.deadline ? formatDistanceToNow(child.deadline) : '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </React.Fragment>
              )
            }

            const { task } = item
            const isSelected = selected.has(task.id)

            return (
              <TableRow
                key={task.id}
                className={cn('cursor-pointer hover:bg-muted/50', isSelected && 'bg-primary/5')}
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
                  <Link href={`/tasks/${task.id}`} className="font-medium hover:underline flex items-center gap-1.5">
                    {task.title}
                    {task.broadcast_id && (
                      <Radio className="h-3.5 w-3.5 text-primary shrink-0" />
                    )}
                  </Link>
                  {task.category && task.category !== 'other' && (
                    <span className={cn(
                      'mt-0.5 inline-block text-xs px-1.5 py-0.5 rounded',
                      CATEGORY_STYLE[task.category as TaskCategory] ?? 'bg-gray-100 text-gray-600'
                    )}>
                      {CATEGORY_LABEL[task.category as TaskCategory] ?? task.category}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {task.stores?.name ?? '—'}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {task.assignee?.full_name ?? 'Chưa phân công'}
                </TableCell>
                <TableCell>
                  <TaskPriorityBadge priority={task.priority as Task['priority']} />
                </TableCell>
                <TableCell>
                  <TaskStatusBadge status={task.status as Task['status']} />
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {task.deadline ? formatDistanceToNow(task.deadline) : '—'}
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
  )
}
