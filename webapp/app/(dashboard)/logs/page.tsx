import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import Link from 'next/link'

const ACTION_COLORS: Record<string, string> = {
  created:                     'bg-blue-100 text-blue-700',
  updated:                     'bg-yellow-100 text-yellow-700',
  deleted:                     'bg-red-100 text-red-700',
  submitted:                   'bg-green-100 text-green-700',
  status_changed:              'bg-purple-100 text-purple-700',
  reassigned:                  'bg-orange-100 text-orange-700',
  resubmit_requested:          'bg-amber-100 text-amber-700',
  review_note:                 'bg-indigo-100 text-indigo-700',
  schedule_created:            'bg-teal-100 text-teal-700',
  schedule_paused:             'bg-gray-100 text-gray-600',
  schedule_resumed:            'bg-teal-100 text-teal-700',
  recurring_tasks_generated:   'bg-teal-100 text-teal-700',
  cron_run_failed:             'bg-red-100 text-red-700',
}

const ACTION_LABELS: Record<string, string> = {
  created:                     'Đã tạo',
  updated:                     'Cập nhật',
  deleted:                     'Đã xoá',
  submitted:                   'Đã nộp',
  status_changed:              'Đổi trạng thái',
  reassigned:                  'Phân công lại',
  resubmit_requested:          'Yêu cầu làm lại',
  review_note:                 'Ghi chú đánh giá',
  schedule_created:            'Tạo lịch định kỳ',
  schedule_paused:             'Tạm dừng lịch',
  schedule_resumed:            'Kích hoạt lại lịch',
  recurring_tasks_generated:   'Tạo task định kỳ',
  cron_run_failed:             'Cron lỗi',
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
    case 'resubmit_requested':
      return metadata.reason ? `Lý do: ${String(metadata.reason)}` : '—'
    case 'review_note': {
      const note = metadata.note as string | undefined
      return note ? note.slice(0, 80) : '—'
    }
    case 'schedule_created':
    case 'recurring_tasks_generated': {
      const freq: Record<string, string> = { daily: 'mỗi ngày', weekly: 'mỗi tuần', monthly: 'mỗi tháng' }
      const f = freq[metadata.frequency as string] ?? (metadata.frequency as string)
      const sc = metadata.store_count ? ` · ${metadata.store_count} cửa hàng` : ''
      return `"${metadata.title ?? '—'}" · ${f}${sc}`
    }
    case 'cron_run_failed':
      return metadata.error_message ? String(metadata.error_message).slice(0, 80) : '—'
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

  // Build query with role-based filtering
  // Admin: all logs
  // Store Manager: own logs + store users' logs
  // Staff: own logs only
  let logsQuery = supabase
    .from('task_logs')
    .select('*, tasks(id, title), users(full_name)')
    .order('created_at', { ascending: false })
    .limit(300)

  if (profile?.role === 'store_manager') {
    if (profile.store_id) {
      const { data: storeUsers } = await supabase
        .from('users')
        .select('id')
        .eq('store_id', profile.store_id)
      const userIds = [user.id, ...(storeUsers ?? []).map((u) => u.id)]
      logsQuery = logsQuery.in('user_id', userIds)
    } else {
      logsQuery = logsQuery.eq('user_id', user.id)
    }
  } else if (profile?.role === 'staff') {
    logsQuery = logsQuery.eq('user_id', user.id)
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
