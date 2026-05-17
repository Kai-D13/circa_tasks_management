import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { TaskStatusBadge } from '@/components/tasks/TaskStatusBadge'
import { TaskPriorityBadge } from '@/components/tasks/TaskPriorityBadge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import Link from 'next/link'
import { formatDistanceToNow } from '@/lib/dateUtils'

export default async function DashboardPage() {
  const supabase = await createClient()

  const [
    { count: total },
    { count: done },
    { count: overdue },
    { count: inProgress },
    { data: recentTasks },
  ] = await Promise.all([
    supabase.from('tasks').select('*', { count: 'exact', head: true }),
    supabase.from('tasks').select('*', { count: 'exact', head: true }).eq('status', 'done'),
    supabase.from('tasks').select('*', { count: 'exact', head: true }).eq('status', 'overdue'),
    supabase.from('tasks').select('*', { count: 'exact', head: true }).eq('status', 'in_progress'),
    supabase.from('tasks')
      .select('id, title, status, priority, deadline, stores(name), assignee:users!assigned_to(full_name)')
      .order('created_at', { ascending: false })
      .limit(10),
  ])

  const kpis = [
    { label: 'Tổng Tasks',       value: total ?? 0,      color: 'text-foreground' },
    { label: 'Đang thực hiện',   value: inProgress ?? 0, color: 'text-blue-600' },
    { label: 'Hoàn thành',       value: done ?? 0,       color: 'text-green-600' },
    { label: 'Quá hạn',          value: overdue ?? 0,    color: 'text-red-600' },
  ]

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-xl font-semibold">Tổng quan</h1>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {kpis.map(({ label, value, color }) => (
          <Card key={label}>
            <CardHeader className="pb-1 pt-4 px-4">
              <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
            </CardHeader>
            <CardContent className="pb-4 px-4">
              <p className={`text-3xl font-bold ${color}`}>{value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Recent Tasks */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Tasks gần đây</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tiêu đề</TableHead>
                <TableHead>Cửa hàng</TableHead>
                <TableHead>Ưu tiên</TableHead>
                <TableHead>Trạng thái</TableHead>
                <TableHead>Deadline</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(recentTasks ?? []).map((task) => (
                <TableRow key={task.id}>
                  <TableCell>
                    <Link href={`/tasks/${task.id}`} className="font-medium hover:underline">
                      {task.title}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {(task.stores as unknown as { name: string } | null)?.name ?? '—'}
                  </TableCell>
                  <TableCell><TaskPriorityBadge priority={task.priority as 'urgent' | 'normal'} /></TableCell>
                  <TableCell><TaskStatusBadge status={task.status as 'todo' | 'in_progress' | 'done' | 'overdue'} /></TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {task.deadline ? formatDistanceToNow(task.deadline) : '—'}
                  </TableCell>
                </TableRow>
              ))}
              {(recentTasks ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                    Chưa có task nào
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
