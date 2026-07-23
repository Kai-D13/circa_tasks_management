import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/components/ds/PageHeader'
import { DataTableShell } from '@/components/ds/DataTableShell'
import { EmptyState } from '@/components/ds/EmptyState'
import { ErrorState } from '@/components/ds/ErrorState'
import { TagBadge } from '@/components/ds/TagBadge'
import Link from 'next/link'
import { formatDateTime } from '@/lib/dateUtils'
import { LogFilters, type LogFilterParams } from '@/components/logs/LogFilters'
import { AutoRefresh } from '@/components/common/AutoRefresh'
import { ExportButton } from '@/components/common/ExportButton'
import { Pagination } from '@/components/common/Pagination'
import { LOGS_PAGE_SIZE, ACTION_HUE, ACTION_LABELS, formatMeta } from '@/lib/logs/constants'
import { getSmStoreIds } from '@/lib/authz'
import { ScrollText } from 'lucide-react'

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
  // Staff no longer have the activity log (removed from nav to lighten the mobile
  // app) — bounce them even on a direct URL, mirroring the peer-page guards.
  if (profile?.role === 'staff') redirect('/tasks')
  const isAdmin   = profile?.role === 'admin'
  const isManager = profile?.role === 'store_manager'
  const isStaff   = profile?.role === 'staff'
  const isSm      = profile?.role === 'sm'

  const smStoreIds = isSm ? await getSmStoreIds(supabase, user.id) : []
  if (isSm && smStoreIds.length === 0) {
    return (
      <div className="p-4 space-y-4">
        <PageHeader title="Nhật ký hoạt động" icon={ScrollText} />
        <EmptyState title="Chưa được phân công cửa hàng nào" hint="Vui lòng liên hệ Admin." />
      </div>
    )
  }

  const page = Math.max(1, parseInt(params.page ?? '1', 10))
  const from = (page - 1) * LOGS_PAGE_SIZE
  const to   = from + LOGS_PAGE_SIZE - 1

  // A joined task is required when filtering by store / task type / title search.
  // store_manager ignores any store_id param (RLS already scopes to their store).
  const storeFilter = (isAdmin || isSm) ? params.store_id : undefined
  const needsTaskJoin = !!(storeFilter || params.task_type || params.q)
  const taskEmbed = needsTaskJoin
    ? 'tasks!inner(id, title, store_id, source_schedule_id, stores(name))'
    : 'tasks(id, title, store_id, source_schedule_id, stores(name))'

  let logsQuery = supabase
    .from('task_logs')
    // 'estimated' uses the planner row estimate for large result sets (avoids a
    // full COUNT scan on every load) and falls back to exact for small ones —
    // an approximate total is fine for paginating an audit log.
    .select(`*, ${taskEmbed}, users(id, full_name)`, { count: 'estimated' })
    .order('created_at', { ascending: false })
    .range(from, to)

  // Staff: own logs only (narrower than RLS)
  if (isStaff) logsQuery = logsQuery.eq('user_id', user.id)

  if (params.action)  logsQuery = logsQuery.eq('action', params.action)
  if (params.user_id) logsQuery = logsQuery.eq('user_id', params.user_id)
  if (params.date_from) logsQuery = logsQuery.gte('created_at', params.date_from + 'T00:00:00+07:00')
  if (params.date_to)   logsQuery = logsQuery.lte('created_at', params.date_to   + 'T23:59:59+07:00')

  if (storeFilter)        logsQuery = logsQuery.eq('tasks.store_id', storeFilter)
  if (params.q)           logsQuery = logsQuery.ilike('tasks.title', `%${params.q.trim()}%`)
  if (params.task_type === 'recurring') logsQuery = logsQuery.not('tasks.source_schedule_id', 'is', null)
  if (params.task_type === 'adhoc')     logsQuery = logsQuery.is('tasks.source_schedule_id', null)

  // Dropdown data: stores (admin/SM), users (admin: all; manager/SM: their store(s))
  const usersQuery = isAdmin
    ? supabase.from('users').select('id, full_name').order('full_name')
    : (isManager && profile?.store_id)
      ? supabase.from('users').select('id, full_name').eq('store_id', profile.store_id).order('full_name')
      : isSm
        ? supabase.from('users').select('id, full_name').in('store_id', smStoreIds).order('full_name')
        : Promise.resolve({ data: [] as { id: string; full_name: string }[], error: null })

  const [
    { data: logs, count, error: logsError },
    { data: stores, error: storesError },
    { data: users, error: usersError },
    { data: managerStore },
  ] = await Promise.all([
    logsQuery,
    isAdmin
      ? supabase.from('stores').select('id, name').eq('store_type', 'os').order('name')
      : isSm
        ? supabase.from('stores').select('id, name').in('id', smStoreIds).order('name')
        : Promise.resolve({ data: [] as { id: string; name: string }[], error: null }),
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
      {!isStaff && <AutoRefresh intervalMs={120000} />}
      <PageHeader
        title="Nhật ký hoạt động"
        icon={ScrollText}
        actions={(isAdmin || isSm) && (
          <ExportButton
            endpoint="/api/export/logs"
            className="h-[44px] md:h-8"
            requireParams={['date_from', 'date_to']}
            requireMessage="Vui lòng chọn khoảng ngày (Từ ngày / Đến ngày) trước khi xuất Excel"
          />
        )}
      />

      {/* A failed dropdown fetch would render an EMPTY store/user picker, which
          reads as "nothing to filter by" — say so instead of lying silently. */}
      {(storesError || usersError) && (
        <ErrorState
          message="Một số bộ lọc không tải được"
          hint={
            (storesError ? 'Danh sách cửa hàng không khả dụng. ' : '')
            + (usersError ? 'Danh sách nhân viên không khả dụng. ' : '')
            + 'Nhật ký bên dưới vẫn đầy đủ; tải lại trang để dùng bộ lọc.'
          }
        />
      )}

      <LogFilters
        params={params}
        isAdmin={isAdmin || isSm}
        stores={stores ?? []}
        users={users ?? []}
        managerStoreName={(managerStore as { name: string } | null)?.name ?? null}
      />

      {logsError ? (
        <ErrorState message="Không thể tải nhật ký hoạt động" hint={logsError.message} />
      ) : (
        <DataTableShell>
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
                      <TagBadge hue={ACTION_HUE[log.action] ?? 'gray'}>
                        {ACTION_LABELS[log.action] ?? log.action}
                      </TagBadge>
                    </TableCell>
                    {/* Same taxonomy axis as /tasks: Định kỳ=teal, Phát sinh=slate. */}
                    <TableCell>
                      {task ? (
                        <TagBadge hue={isRecurring ? 'teal' : 'slate'}>
                          {isRecurring ? 'Định kỳ' : 'Phát sinh'}
                        </TagBadge>
                      ) : '—'}
                    </TableCell>
                    <TableCell className="text-sm max-w-[180px]">
                      {task ? (
                        <Link href={`/tasks/${task.id}`} prefetch={false} className="hover:underline block truncate" title={task.title}>{task.title}</Link>
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
                  <TableCell colSpan={isManager ? 6 : 7} className="p-0">
                    <EmptyState icon={ScrollText} title="Không có nhật ký nào" className="py-8" />
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </DataTableShell>
      )}

      {/* Pagination — full mode keeps the total on screen ("1–50 / N") like the
          previous "Trang x / y · N bản ghi" line; the row count stays the
          planner ESTIMATE (count: 'estimated'), same source as before, and
          buildUrl keeps every active filter in the href. */}
      {!logsError && (
        <Pagination
          page={page}
          totalPages={totalPages}
          totalRows={count ?? 0}
          pageSize={LOGS_PAGE_SIZE}
          hrefForPage={(p) => buildUrl(currentParams, { page: String(p) })}
        />
      )}
    </div>
  )
}
