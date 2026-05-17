import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { TaskStatusBadge } from '@/components/tasks/TaskStatusBadge'
import { TaskPriorityBadge } from '@/components/tasks/TaskPriorityBadge'
import { TaskFilters } from '@/components/tasks/TaskFilters'
import { formatDistanceToNow } from '@/lib/dateUtils'
import { Plus, Upload } from 'lucide-react'
import { Task } from '@/types'
import { cn } from '@/lib/utils'

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; priority?: string; store_id?: string }>
}) {
  const params = await searchParams
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  const { data: profile } = await supabase
    .from('users').select('role, store_id').eq('id', user!.id).single()

  let query = supabase
    .from('tasks')
    .select('*, stores(name), assignee:users!assigned_to(full_name, email)')
    .order('created_at', { ascending: false })

  if (params.status)   query = query.eq('status', params.status)
  if (params.priority) query = query.eq('priority', params.priority)
  if (params.store_id) query = query.eq('store_id', params.store_id)

  const { data: tasks } = await query
  const { data: stores } = await supabase.from('stores').select('id, name').order('name')

  const canCreate = profile?.role === 'admin' || profile?.role === 'store_manager'

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Danh sách Tasks</h1>
        {canCreate && (
          <div className="flex gap-2">
            <Link href="/tasks/import" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
              <Upload className="h-4 w-4 mr-1" />
              Import File
            </Link>
            <Link href="/tasks/new" className={cn(buttonVariants({ size: 'sm' }))}>
              <Plus className="h-4 w-4 mr-1" />
              Tạo Task
            </Link>
          </div>
        )}
      </div>

      <TaskFilters stores={stores ?? []} currentParams={params} />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tiêu đề</TableHead>
                <TableHead>Cửa hàng</TableHead>
                <TableHead>Người thực hiện</TableHead>
                <TableHead>Ưu tiên</TableHead>
                <TableHead>Trạng thái</TableHead>
                <TableHead>Deadline</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(tasks ?? []).map((task) => (
                <TableRow key={task.id} className="cursor-pointer hover:bg-muted/50">
                  <TableCell>
                    <Link href={`/tasks/${task.id}`} className="font-medium hover:underline block">
                      {task.title}
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {(task.stores as unknown as { name: string } | null)?.name ?? '—'}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {(task.assignee as unknown as { full_name: string } | null)?.full_name ?? 'Chưa phân công'}
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
              ))}
              {(tasks ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-10">
                    Không có task nào
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
