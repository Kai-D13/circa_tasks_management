import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent } from '@/components/ui/card'
import { buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScheduleActions } from '@/components/tasks/ScheduleActions'
import { Plus, CalendarClock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatDate } from '@/lib/dateUtils'

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

  const { data: schedules } = await supabase
    .from('task_schedules')
    .select(`
      id, frequency, run_time, next_run_at, last_run_at, is_active, created_at, assignment_mode,
      task_templates ( title ),
      task_schedule_stores ( store_id )
    `)
    .order('created_at', { ascending: false })

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CalendarClock className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Task định kỳ</h1>
        </div>
        <Link href="/tasks/new?mode=recurring" className={cn(buttonVariants({ size: 'sm' }))}>
          <Plus className="h-4 w-4 mr-1" />
          Tạo lịch mới
        </Link>
      </div>

      {(!schedules || schedules.length === 0) ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground text-sm">
            <CalendarClock className="h-8 w-8 mx-auto mb-3 opacity-30" />
            <p>Chưa có lịch định kỳ nào.</p>
            <p className="mt-1">
              <Link href="/tasks/new?mode=recurring" className="text-primary hover:underline">Tạo lịch đầu tiên</Link>
              {' '}— form sẽ mở sẵn ở chế độ &ldquo;Định kỳ&rdquo;.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Tên lịch</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Tần suất</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Giờ chạy</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Cửa hàng</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Lần chạy tiếp</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Lần cuối</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Trạng thái</th>
                  <th className="px-4 py-3 font-medium text-muted-foreground">Thao tác</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {schedules.map((s) => {
                  const template = s.task_templates as unknown as { title: string } | null
                  const storeCount = (s.task_schedule_stores as { store_id: string }[] | null)?.length ?? 0
                  return (
                    <tr key={s.id} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3 font-medium max-w-[200px]">
                        <Link href={`/tasks/schedules/${s.id}`} className="hover:underline block truncate">
                          {template?.title ?? '—'}
                        </Link>
                        <Badge className={cn('mt-0.5 text-[10px] font-normal',
                          s.assignment_mode === 'staff_all' ? 'bg-primary/10 text-primary' : 'bg-gray-100 text-gray-600')}>
                          {s.assignment_mode === 'staff_all' ? 'Từng dược sĩ' : 'Cửa hàng'}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {FREQ_LABEL[s.frequency] ?? s.frequency}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {s.run_time ?? '—'}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {storeCount} CH
                      </td>
                      <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                        {s.next_run_at ? formatDate(s.next_run_at) : '—'}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                        {s.last_run_at ? formatDate(s.last_run_at) : 'Chưa chạy'}
                      </td>
                      <td className="px-4 py-3">
                        <Badge className={s.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}>
                          {s.is_active ? 'Đang hoạt động' : 'Tạm dừng'}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <ScheduleActions scheduleId={s.id} isActive={s.is_active} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
