import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import Link from 'next/link'

const ACTION_COLORS: Record<string, string> = {
  created:        'bg-blue-100 text-blue-700',
  updated:        'bg-yellow-100 text-yellow-700',
  deleted:        'bg-red-100 text-red-700',
  submitted:      'bg-green-100 text-green-700',
  status_changed: 'bg-purple-100 text-purple-700',
  reassigned:     'bg-orange-100 text-orange-700',
}

const ACTION_LABELS: Record<string, string> = {
  created:        'Đã tạo',
  updated:        'Cập nhật',
  deleted:        'Đã xoá',
  submitted:      'Đã nộp',
  status_changed: 'Đổi trạng thái',
  reassigned:     'Phân công lại',
}

const STATUS_VI: Record<string, string> = {
  todo:        'Chờ thực hiện',
  in_progress: 'Đang thực hiện',
  done:        'Hoàn thành',
  overdue:     'Quá hạn',
}

type Meta = Record<string, unknown>

function formatMeta(action: string, metadata: Meta | null): string {
  if (!metadata) return '—'
  switch (action) {
    case 'reassigned':
      if (metadata.assignee_name) return `→ ${metadata.assignee_name}`
      if (metadata.assigned_to)   return '→ (đã phân công)'
      return 'Bỏ phân công'
    case 'status_changed': {
      const from = STATUS_VI[metadata.from as string] ?? metadata.from
      const to   = STATUS_VI[metadata.to   as string] ?? STATUS_VI[metadata.status as string] ?? metadata.to ?? metadata.status
      return metadata.from ? `${from} → ${to}` : `→ ${to}`
    }
    case 'created':
      if (metadata.method === 'bulk_import') return `Import: ${metadata.file ?? '—'}`
      if (metadata.assignee_name)            return `Giao cho: ${metadata.assignee_name}`
      return metadata.title ? `"${metadata.title}"` : '—'
    case 'updated':
      if (metadata.assignee_name) return `Giao cho: ${metadata.assignee_name}`
      return metadata.title ? `"${metadata.title}"` : '—'
    case 'submitted': {
      const types = metadata.output_types as string[] | undefined
      return types?.length ? `Nộp: ${types.join(', ')}` : '—'
    }
    default:
      return Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : '—'
  }
}

export default async function LogsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('users').select('role, store_id').eq('id', user.id).single()

  if (profile?.role === 'staff') redirect('/dashboard')

  // Build query — store_manager only sees logs for tasks in their store
  let logsQuery = supabase
    .from('task_logs')
    .select('*, tasks(id, title), users(full_name)')
    .order('created_at', { ascending: false })
    .limit(300)

  if (profile?.role === 'store_manager') {
    if (profile.store_id) {
      const { data: storeTasks } = await supabase
        .from('tasks')
        .select('id')
        .eq('store_id', profile.store_id)
      const ids = (storeTasks ?? []).map((t) => t.id)
      logsQuery = ids.length > 0
        ? logsQuery.in('task_id', ids)
        : logsQuery.eq('task_id', '00000000-0000-0000-0000-000000000000')
    }
  }

  const { data: logs } = await logsQuery

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-xl font-semibold">Nhật ký hoạt động</h1>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Thời gian</TableHead>
                <TableHead>Hành động</TableHead>
                <TableHead>Task</TableHead>
                <TableHead>Người dùng</TableHead>
                <TableHead>Chi tiết</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(logs ?? []).map((log) => (
                <TableRow key={log.id}>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(log.created_at).toLocaleString('vi-VN')}
                  </TableCell>
                  <TableCell>
                    <Badge className={ACTION_COLORS[log.action] ?? 'bg-muted text-muted-foreground'}>
                      {ACTION_LABELS[log.action] ?? log.action}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm max-w-[180px] truncate">
                    {log.tasks ? (
                      <Link href={`/tasks/${(log.tasks as { id: string; title: string }).id}`} className="hover:underline">
                        {(log.tasks as { id: string; title: string }).title}
                      </Link>
                    ) : '—'}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                    {(log.users as { full_name: string } | null)?.full_name ?? '—'}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                    {formatMeta(log.action, log.metadata as Meta | null)}
                  </TableCell>
                </TableRow>
              ))}
              {(logs ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                    Chưa có nhật ký nào
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
