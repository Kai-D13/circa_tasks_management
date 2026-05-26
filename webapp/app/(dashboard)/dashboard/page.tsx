import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { TaskStatusBadge } from '@/components/tasks/TaskStatusBadge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import Link from 'next/link'
import { formatDistanceToNow } from '@/lib/dateUtils'
import { Radio, AlertCircle } from 'lucide-react'
import { TaskCategory } from '@/types'
import { cn } from '@/lib/utils'

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

type DashboardRow =
  | {
      type:        'broadcast'
      broadcastId: string
      title:       string
      category:    string | null
      total:       number
      done:        number
      deadline:    string | null
    }
  | {
      type:     'task'
      id:       string
      title:    string
      category: string | null
      status:   string
      store:    string | null
      deadline: string | null
    }

export default async function DashboardPage() {
  const supabase = await createClient()

  const [
    { count: total,      error: e1 },
    { count: done,       error: e2 },
    { count: overdue,    error: e3 },
    { count: inProgress, error: e4 },
    { data: recentRaw,   error: e5 },
  ] = await Promise.all([
    supabase.from('tasks').select('*', { count: 'exact', head: true }).is('archived_at', null),
    supabase.from('tasks').select('*', { count: 'exact', head: true }).is('archived_at', null).eq('status', 'done'),
    supabase.from('tasks').select('*', { count: 'exact', head: true }).is('archived_at', null).eq('status', 'overdue'),
    supabase.from('tasks').select('*', { count: 'exact', head: true }).is('archived_at', null).eq('status', 'in_progress'),
    supabase
      .from('tasks')
      .select('id, title, status, priority, deadline, category, broadcast_id, stores(name)')
      .is('archived_at', null)
      .order('created_at', { ascending: false })
      .limit(50),
  ])

  const kpiError = e1 ?? e2 ?? e3 ?? e4
  const recentError = e5

  // Build grouped recent list (max 8 display rows)
  const recentRows: DashboardRow[] = []
  const seenBroadcast = new Map<string, number>()

  for (const task of recentRaw ?? []) {
    if (!task.broadcast_id) {
      recentRows.push({
        type:     'task',
        id:       task.id,
        title:    task.title,
        category: task.category ?? null,
        status:   task.status,
        store:    (task.stores as unknown as { name: string } | null)?.name ?? null,
        deadline: task.deadline ?? null,
      })
    } else {
      if (seenBroadcast.has(task.broadcast_id)) {
        const idx = seenBroadcast.get(task.broadcast_id)!
        const row = recentRows[idx] as Extract<DashboardRow, { type: 'broadcast' }>
        row.total++
        if (task.status === 'done') row.done++
        if (task.deadline && (!row.deadline || task.deadline < row.deadline)) {
          row.deadline = task.deadline
        }
      } else {
        const idx = recentRows.length
        seenBroadcast.set(task.broadcast_id, idx)
        recentRows.push({
          type:        'broadcast',
          broadcastId: task.broadcast_id,
          title:       task.title,
          category:    task.category ?? null,
          total:       1,
          done:        task.status === 'done' ? 1 : 0,
          deadline:    task.deadline ?? null,
        })
      }
    }

    if (recentRows.length >= 8) break
  }

  const kpis = [
    { label: 'Tổng Tasks đang hoạt động', value: total ?? 0,      color: 'text-foreground' },
    { label: 'Đang thực hiện',            value: inProgress ?? 0, color: 'text-blue-600' },
    { label: 'Hoàn thành',                value: done ?? 0,       color: 'text-green-600' },
    { label: 'Quá hạn',                   value: overdue ?? 0,    color: 'text-red-600' },
  ]

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-6">
      <h1 className="text-lg md:text-xl font-semibold">Tổng quan</h1>

      {/* KPI error */}
      {kpiError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 flex items-center gap-2 text-sm">
          <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
          <span className="text-destructive font-medium">Lỗi tải KPI:</span>
          <span className="text-muted-foreground">{kpiError.message}</span>
          {kpiError.message.includes('archived_at') && (
            <span className="text-muted-foreground">— Vui lòng chạy migration <code className="font-mono text-xs bg-muted px-1 rounded">011_archive_tasks.sql</code></span>
          )}
        </div>
      )}

      {/* KPI Cards — 2 cols on mobile, 4 on desktop */}
      <div className="grid grid-cols-2 gap-3 md:gap-4 md:grid-cols-4">
        {kpis.map(({ label, value, color }) => (
          <Card key={label}>
            <CardContent className="p-4">
              <p className="text-xs font-medium text-muted-foreground leading-snug">{label}</p>
              <p className={`text-3xl font-bold mt-1 ${color}`}>{value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Recent Activity */}
      <Card>
        <CardHeader className="pb-2 px-4 pt-4 flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium">Hoạt động gần đây</CardTitle>
          <Link href="/tasks" className="text-xs text-primary hover:underline">
            Xem tất cả trong Tasks →
          </Link>
        </CardHeader>
        <CardContent className="p-0">
          {recentError ? (
            <div className="px-4 py-4 flex items-start gap-2 text-sm">
              <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-destructive">Không thể tải danh sách gần đây</p>
                <p className="text-muted-foreground mt-0.5">{recentError.message}</p>
              </div>
            </div>
          ) : (
            <>
              {/* Desktop */}
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tiêu đề</TableHead>
                      <TableHead>Loại</TableHead>
                      <TableHead>Cửa hàng</TableHead>
                      <TableHead>Trạng thái</TableHead>
                      <TableHead>Deadline</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recentRows.map((row, idx) => {
                      if (row.type === 'broadcast') {
                        return (
                          <TableRow key={`bc-${row.broadcastId}`} className="bg-primary/5">
                            <TableCell>
                              <div className="flex items-center gap-1.5 font-medium">
                                <Radio className="h-3.5 w-3.5 text-primary shrink-0" />
                                {row.title}
                              </div>
                            </TableCell>
                            <TableCell>
                              {row.category && row.category !== 'other' ? (
                                <span className={cn('text-xs px-1.5 py-0.5 rounded', CATEGORY_STYLE[row.category as TaskCategory] ?? 'bg-gray-100 text-gray-600')}>
                                  {CATEGORY_LABEL[row.category as TaskCategory] ?? row.category}
                                </span>
                              ) : '—'}
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {row.total} cửa hàng
                            </TableCell>
                            <TableCell className="text-sm">
                              <span className={cn('font-medium', row.done === row.total ? 'text-green-600' : 'text-amber-600')}>
                                {row.done}/{row.total}
                              </span>
                              <span className="text-muted-foreground"> hoàn thành</span>
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {row.deadline ? formatDistanceToNow(row.deadline) : '—'}
                            </TableCell>
                          </TableRow>
                        )
                      }

                      return (
                        <TableRow key={`task-${row.id}`}>
                          <TableCell>
                            <Link href={`/tasks/${row.id}`} className="font-medium hover:underline">
                              {row.title}
                            </Link>
                          </TableCell>
                          <TableCell>
                            {row.category && row.category !== 'other' ? (
                              <span className={cn('text-xs px-1.5 py-0.5 rounded', CATEGORY_STYLE[row.category as TaskCategory] ?? 'bg-gray-100 text-gray-600')}>
                                {CATEGORY_LABEL[row.category as TaskCategory] ?? row.category}
                              </span>
                            ) : '—'}
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm">{row.store ?? '—'}</TableCell>
                          <TableCell>
                            <TaskStatusBadge status={row.status as 'todo' | 'in_progress' | 'done' | 'overdue'} />
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm">
                            {row.deadline ? formatDistanceToNow(row.deadline) : '—'}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                    {recentRows.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                          Chưa có task nào đang hoạt động
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>

              {/* Mobile */}
              <div className="md:hidden divide-y">
                {recentRows.length === 0 && (
                  <p className="text-center text-muted-foreground py-8 text-sm">Chưa có task nào đang hoạt động</p>
                )}
                {recentRows.map((row) => {
                  if (row.type === 'broadcast') {
                    return (
                      <div key={`bc-${row.broadcastId}`} className="flex flex-col gap-1.5 px-4 py-3 bg-primary/5">
                        <div className="flex items-start gap-1.5">
                          <Radio className="h-3.5 w-3.5 text-primary shrink-0 mt-0.5" />
                          <span className="font-medium text-sm leading-snug">{row.title}</span>
                        </div>
                        <div className="flex items-center gap-2 flex-wrap pl-5">
                          {row.category && row.category !== 'other' && (
                            <span className={cn('text-xs px-1.5 py-0.5 rounded', CATEGORY_STYLE[row.category as TaskCategory] ?? 'bg-gray-100 text-gray-600')}>
                              {CATEGORY_LABEL[row.category as TaskCategory] ?? row.category}
                            </span>
                          )}
                          <span className={cn('text-xs font-medium', row.done === row.total ? 'text-green-600' : 'text-amber-600')}>
                            {row.done}/{row.total} hoàn thành
                          </span>
                          {row.deadline && (
                            <span className="text-xs text-muted-foreground">{formatDistanceToNow(row.deadline)}</span>
                          )}
                        </div>
                      </div>
                    )
                  }

                  return (
                    <Link key={`task-${row.id}`} href={`/tasks/${row.id}`} className="flex flex-col gap-1.5 px-4 py-3 hover:bg-muted/40 active:bg-muted/60">
                      <div className="flex items-start justify-between gap-2">
                        <span className="font-medium text-sm leading-snug">{row.title}</span>
                        {row.category && row.category !== 'other' && (
                          <span className={cn('text-xs px-1.5 py-0.5 rounded shrink-0', CATEGORY_STYLE[row.category as TaskCategory] ?? 'bg-gray-100 text-gray-600')}>
                            {CATEGORY_LABEL[row.category as TaskCategory] ?? row.category}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <TaskStatusBadge status={row.status as 'todo' | 'in_progress' | 'done' | 'overdue'} />
                        <span className="text-xs text-muted-foreground">{row.store ?? '—'}</span>
                        {row.deadline && (
                          <span className="text-xs text-muted-foreground">{formatDistanceToNow(row.deadline)}</span>
                        )}
                      </div>
                    </Link>
                  )
                })}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground text-center">
        Trang tổng quan chỉ hiển thị task đang hoạt động.{' '}
        <Link href="/tasks" className="text-primary hover:underline">Vào Tasks</Link>{' '}
        để quản lý chi tiết.
      </p>
    </div>
  )
}
