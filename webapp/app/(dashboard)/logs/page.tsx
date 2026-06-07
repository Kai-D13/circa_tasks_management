import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { formatDateTime } from '@/lib/dateUtils'
import { LogFilters, type LogFilterParams } from '@/components/logs/LogFilters'
import { AutoRefresh } from '@/components/common/AutoRefresh'
import { LOGS_PAGE_SIZE, ACTION_COLORS, ACTION_LABELS, formatMeta } from '@/lib/logs/constants'

type Meta = Record<string, unknown>
type LogTask = { id: string; title: string; store_id: string | null; source_schedule_id: string | null; stores: { name: string } | null }

function buildUrl(base: Record<string, string | undefined>, patch: Record<string, string | undefined>): string {
  const merged = { ...base, ...patch }
  const qs = Object.entries(merged)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v!)}`)
    .join('&')
  return qs ? `?${qs}` : '?'
}

export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<LogFilterParams & { page?: string }>
}) {
  const params = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('users').select('role, store_id').eq('id', user.id).single()
  const isAdmin   = profile?.role === 'admin'
  const isManager = profile?.role === 'store_manager'
  const isStaff   = profile?.role === 'staff'

  const page = Math.max(1, parseInt(params.page ?? '1', 10))
  const from = (page - 1) * LOGS_PAGE_SIZE
  const to   = from + LOGS_PAGE_SIZE - 1

  // A joined task is required when filtering by store / task type / title search.
  // store_manager ignores any store_id param (RLS already scopes to their store).
  const storeFilter = isAdmin ? params.store_id : undefined
  const needsTaskJoin = !!(storeFilter || params.task_type || params.q)
  const taskEmbed = needsTaskJoin
    ? 'tasks!inner(id, title, store_id, source_schedule_id, stores(name))'
    : 'tasks(id, title, store_id, source_schedule_id, stores(name))'

  let logsQuery = supabase
    .from('task_logs')
    .select(`*, ${taskEmbed}, users(id, full_name)`, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to)

  // Staff: own logs only (narrower than RLS)
  if (profile?.role === 'staff') logsQuery = logsQuery.eq('user_id', user.id)

  if (params.action)  logsQuery = logsQuery.eq('action', params.action)
  if (params.user_id) logsQuery = logsQuery.eq('user_id', params.user_id)
  if (params.date_from) logsQuery = logsQuery.gte('created_at', params.date_from + 'T00:00:00+07:00')
  if (params.date_to)   logsQuery = logsQuery.lte('created_at', params.date_to   + 'T23:59:59+07:00')

  if (storeFilter)        logsQuery = logsQuery.eq('tasks.store_id', storeFilter)
  if (params.q)           logsQuery = logsQuery.ilike('tasks.title', `%${params.q.trim()}%`)
  if (params.task_type === 'recurring') logsQuery = logsQuery.not('tasks.source_schedule_id', 'is', null)
  if (params.task_type === 'adhoc')     logsQuery = logsQuery.is('tasks.source_schedule_id', null)

  // Dropdown data: stores (admin only), users (admin: all; manager: own store)
  const usersQuery = isAdmin
    ? supabase.from('users').select('id, full_name').order('full_name')
    : isManager && profile?.store_id
      ? supabase.from('users').select('id, full_name').eq('store_id', profile.store_id).order('full_name')
      : Promise.resolve({ data: [] as { id: string; full_name: string }[] })

  const [{ data: logs, count }, { data: stores }, { data: users }, { data: managerStore }] = await Promise.all([
    logsQuery,
    isAdmin ? supabase.from('stores').select('id, name').order('name') : Promise.resolve({ data: [] }),
    usersQuery,
    isManager && profile?.store_id
      ? supabase.from('stores').select('name').eq('id', profile.store_id).single()
      : Promise.resolve({ data: null }),
  ])

  const totalPages = Math.max(1, Math.ceil((count ?? 0) / LOGS_PAGE_SIZE))
  const currentParams: Record<string, string | undefined> = {
    q: params.q, action: params.action, user_id: params.user_id,
    task_type: params.task_type, store_id: params.store_id,
    date_from: params.date_from, date_to: params.date_to, page: params.page,
  }

  return (
    <div className="p-4 space-y-4">
      {!isStaff && <AutoRefresh intervalMs={60000} />}
      <h1 className="text-xl font-semibold">Nhật ký hoạt động</h1>

      <LogFilters
        params={params}
        isAdmin={isAdmin}
        stores={stores ?? []}
        users={users ?? []}
        managerStoreName={(managerStore as { name: string } | null)?.name ?? null}
      />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Thời gian</TableHead>
                <TableHead>Hành động</TableHead>
                <TableHead>Loại</TableHead>
                <TableHead>Task</TableHead>
                {!isManager && <TableHead>Cửa hàng</TableHead>}
                <TableHead>Nhân viên</TableHead>
                <TableHead>Chi tiết</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(logs ?? []).map((log) => {
                const task = log.tasks as LogTask | null
                const isRecurring = !!task?.source_schedule_id
                return (
                  <TableRow key={log.id}>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {formatDateTime(log.created_at)}
                    </TableCell>
                    <TableCell>
                      <Badge className={ACTION_COLORS[log.action] ?? 'bg-muted text-muted-foreground'}>
                        {ACTION_LABELS[log.action] ?? log.action}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {task ? (
                        <span className={cn(
                          'text-xs px-1.5 py-0.5 rounded',
                          isRecurring ? 'bg-teal-100 text-teal-700' : 'bg-gray-100 text-gray-600'
                        )}>
                          {isRecurring ? 'Định kỳ' : 'Phát sinh'}
                        </span>
                      ) : '—'}
                    </TableCell>
                    <TableCell className="text-sm max-w-[180px] truncate">
                      {task ? (
                        <Link href={`/tasks/${task.id}`} prefetch={false} className="hover:underline">{task.title}</Link>
                      ) : '—'}
                    </TableCell>
                    {!isManager && (
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {task?.stores?.name ?? '—'}
                      </TableCell>
                    )}
                    <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                      {(log.users as { full_name: string } | null)?.full_name ?? '—'}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                      {formatMeta(log.action, log.metadata as Meta | null)}
                    </TableCell>
                  </TableRow>
                )
              })}
              {(logs ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={isManager ? 6 : 7} className="text-center text-muted-foreground py-8">
                    Không có nhật ký nào
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t text-sm">
              <span className="text-muted-foreground">
                Trang {page} / {totalPages} · {count ?? 0} bản ghi
              </span>
              <div className="flex gap-2">
                {page > 1 && (
                  <Link href={buildUrl(currentParams, { page: String(page - 1) })}
                    className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
                    ← Trước
                  </Link>
                )}
                {page < totalPages && (
                  <Link href={buildUrl(currentParams, { page: String(page + 1) })}
                    className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
                    Tiếp →
                  </Link>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
