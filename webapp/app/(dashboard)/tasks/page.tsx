import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { TaskFilters } from '@/components/tasks/TaskFilters'
import { TaskList, TaskListItem, BroadcastGroup, TaskRow, ChildTask } from '@/components/tasks/TaskList'
import { AutoRefresh } from '@/components/common/AutoRefresh'
import { Plus, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; priority?: string; store_id?: string; category?: string; archived?: string }>
}) {
  const params = await searchParams
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  const { data: profile } = await supabase
    .from('users').select('role, store_id').eq('id', user!.id).single()

  const showArchived = params.archived === 'true'

  let query = supabase
    .from('tasks')
    .select('*, stores(name), assignee:users!assigned_to(full_name), source_schedule_id')
    .order('created_at', { ascending: false })

  if (showArchived) {
    query = query.not('archived_at', 'is', null)
  } else {
    query = query.is('archived_at', null)
  }

  if (params.status) {
    const now = new Date().toISOString()
    if (params.status === 'overdue') {
      // Explicitly overdue OR deadline passed and not done
      query = query.or(`status.eq.overdue,and(deadline.lt.${now},status.neq.done)`)
    } else if (params.status === 'todo' || params.status === 'in_progress') {
      // Exact status match AND deadline not yet passed (exclude tasks that are effectively overdue)
      query = query
        .eq('status', params.status)
        .or(`deadline.is.null,deadline.gte.${now}`)
    } else {
      query = query.eq('status', params.status)
    }
  }
  if (params.priority) query = query.eq('priority', params.priority)
  if (params.store_id) query = query.eq('store_id', params.store_id)
  if (params.category) query = query.eq('category', params.category)

  const [{ data: tasks, error: tasksError }, { data: stores }] = await Promise.all([
    query,
    supabase.from('stores').select('id, name').order('name'),
  ])

  const storesForFilter = profile?.role === 'staff' ? [] : (stores ?? [])
  const canCreate  = profile?.role === 'admin' || profile?.role === 'store_manager'
  const canArchive = !showArchived && (profile?.role === 'admin' || profile?.role === 'store_manager')
  const canRestore = showArchived  && (profile?.role === 'admin' || profile?.role === 'store_manager')

  // Group tasks: collapse same broadcast_id into one broadcast row with full progress
  const grouped: TaskListItem[] = []
  const seenBroadcast = new Map<string, number>()

  for (const task of tasks ?? []) {
    if (!task.broadcast_id) {
      const row: TaskRow = {
        type: 'task',
        task: {
          id:                 task.id,
          title:              task.title,
          status:             task.status,
          priority:           task.priority,
          category:           task.category ?? null,
          broadcast_id:       task.broadcast_id ?? null,
          source_schedule_id: (task as { source_schedule_id?: string | null }).source_schedule_id ?? null,
          stores:             (task.stores as { name: string } | null),
          assignee:           (task.assignee as { full_name: string } | null),
          deadline:           task.deadline ?? null,
          created_at:         task.created_at,
        },
      }
      grouped.push(row)
    } else {
      const child: ChildTask = {
        id:       task.id,
        status:   task.status,
        stores:   (task.stores as { name: string } | null),
        assignee: (task.assignee as { full_name: string } | null),
        deadline: task.deadline ?? null,
      }

      if (seenBroadcast.has(task.broadcast_id)) {
        const idx = seenBroadcast.get(task.broadcast_id)!
        const row = grouped[idx] as BroadcastGroup
        row.total++
        if (task.status === 'done') row.done++
        row.taskIds.push(task.id)
        row.childTasks.push(child)
      } else {
        const idx = grouped.length
        seenBroadcast.set(task.broadcast_id, idx)
        const row: BroadcastGroup = {
          type:        'broadcast',
          broadcastId: task.broadcast_id,
          title:       task.title,
          category:    task.category ?? null,
          total:       1,
          done:        task.status === 'done' ? 1 : 0,
          createdAt:   task.created_at,
          taskIds:     [task.id],
          childTasks:  [child],
        }
        grouped.push(row)
      }
    }
  }

  return (
    <div className="p-6 space-y-4">
      <AutoRefresh intervalMs={25000} />
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Danh sách Tasks</h1>
        {canCreate && (
          <Link href="/tasks/new" className={cn(buttonVariants({ size: 'sm' }))}>
            <Plus className="h-4 w-4 mr-1" />
            Tạo Task
          </Link>
        )}
      </div>

      <TaskFilters
        stores={storesForFilter}
        currentParams={params as Record<string, string>}
        showArchived={showArchived}
      />

      {tasksError ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-4 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-medium text-destructive">Không thể tải danh sách task</p>
            <p className="text-muted-foreground mt-1">{tasksError.message}</p>
            {tasksError.message.includes('archived_at') && (
              <p className="text-muted-foreground mt-1">
                Vui lòng chạy migration <code className="font-mono text-xs bg-muted px-1 rounded">011_archive_tasks.sql</code> trong Supabase SQL Editor.
              </p>
            )}
          </div>
        </div>
      ) : (
        <Card>
          <CardContent className="p-0">
            <TaskList items={grouped} canArchive={canArchive} canRestore={canRestore} showArchived={showArchived} />
          </CardContent>
        </Card>
      )}
    </div>
  )
}
