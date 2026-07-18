import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { buttonVariants } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/components/ds/PageHeader'
import { DataTableShell } from '@/components/ds/DataTableShell'
import { EmptyState } from '@/components/ds/EmptyState'
import { ErrorState } from '@/components/ds/ErrorState'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { TagBadge } from '@/components/ds/TagBadge'
import { ScheduleActions } from '@/components/tasks/ScheduleActions'
import { Plus, CalendarClock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatDate } from '@/lib/dateUtils'

// WAVE A1 (UI design system): visual-only migration to components/ds/ —
// query, admin gate, ScheduleActions (pause/resume/delete) untouched.
const FREQ_LABEL: Record<string, string> = {
  daily:   'Mỗi ngày',
  weekly:  'Mỗi tuần',
  monthly: 'Mỗi tháng',
}

export default async function SchedulesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') redirect('/tasks')

  const { data: schedules, error: schedulesError } = await supabase
    .from('task_schedules')
    .select(`
      id, frequency, run_time, next_run_at, last_run_at, is_active, created_at, assignment_mode,
      task_templates ( title ),
      task_schedule_stores ( store_id )
    `)
    .order('created_at', { ascending: false })

  return (
    <div className="p-4 space-y-4">
      <PageHeader
        title="Task định kỳ"
        icon={CalendarClock}
        actions={
          <Link href="/tasks/new?mode=recurring" className={cn(buttonVariants({ size: 'sm' }), 'h-[44px] md:h-8')}>
            <Plus className="h-4 w-4 mr-1" />
            Tạo lịch mới
          </Link>
        }
      />

      {schedulesError ? (
        <ErrorState message="Không thể tải danh sách lịch định kỳ" hint={schedulesError.message} />
      ) : (!schedules || schedules.length === 0) ? (
        <EmptyState
          className="py-12"
          icon={CalendarClock}
          title="Chưa có lịch định kỳ nào."
          hint="Form sẽ mở sẵn ở chế độ “Định kỳ”."
          action={
            <Link href="/tasks/new?mode=recurring" className={cn(buttonVariants({ size: 'sm' }), 'h-[44px] md:h-8')}>
              <Plus className="h-4 w-4 mr-1" /> Tạo lịch đầu tiên
            </Link>
          }
        />
      ) : (
        <DataTableShell>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tên lịch</TableHead>
                <TableHead>Tần suất</TableHead>
                <TableHead>Giờ chạy</TableHead>
                <TableHead>Cửa hàng</TableHead>
                <TableHead>Lần chạy tiếp</TableHead>
                <TableHead>Lần cuối</TableHead>
                <TableHead>Trạng thái</TableHead>
                <TableHead>Thao tác</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {schedules.map((s) => {
                const template = s.task_templates as unknown as { title: string } | null
                const storeCount = (s.task_schedule_stores as { store_id: string }[] | null)?.length ?? 0
                return (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium max-w-[240px]">
                      <Link href={`/tasks/schedules/${s.id}`} className="hover:underline block truncate" title={template?.title ?? undefined}>
                        {template?.title ?? '—'}
                      </Link>
                      {/* Assignment mode = taxonomy — same hue axis as the /tasks
                          method chips (per-staff=sky, store=indigo). */}
                      <TagBadge hue={s.assignment_mode === 'staff_all' ? 'sky' : 'indigo'} className="mt-0.5">
                        {s.assignment_mode === 'staff_all' ? 'Từng dược sĩ' : 'Cửa hàng'}
                      </TagBadge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {FREQ_LABEL[s.frequency] ?? s.frequency}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {s.run_time ?? '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {storeCount} CH
                    </TableCell>
                    <TableCell className="text-muted-foreground whitespace-nowrap">
                      {s.next_run_at ? formatDate(s.next_run_at) : '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground whitespace-nowrap">
                      {s.last_run_at ? formatDate(s.last_run_at) : 'Chưa chạy'}
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={s.is_active ? 'success' : 'neutral'}>
                        {s.is_active ? 'Đang hoạt động' : 'Tạm dừng'}
                      </StatusBadge>
                    </TableCell>
                    <TableCell>
                      <ScheduleActions scheduleId={s.id} isActive={s.is_active} />
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </DataTableShell>
      )}
    </div>
  )
}
