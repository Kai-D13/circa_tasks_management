import Link from 'next/link'
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

// UI v2 P1.5 (artboard 04) — phần TRÌNH BÀY của /tasks/schedules. Nhận dữ liệu đã truy vấn qua props để
// route thật (app/(dashboard)/tasks/schedules/page.tsx — query + cổng admin ở đó) và fixture catalog
// (/ui-catalog/schedules-v2) dùng CHUNG một markup. Tự mang gốc data-ui-v2="page".
const FREQ_LABEL: Record<string, string> = {
  daily:   'Mỗi ngày',
  weekly:  'Mỗi tuần',
  monthly: 'Mỗi tháng',
}

export type ScheduleListRow = {
  id: string
  title: string | null
  frequency: string
  run_time: string | null
  next_run_at: string | null
  last_run_at: string | null
  is_active: boolean
  assignment_mode: string | null
  storeCount: number
}

// Nút hành động chính: [44px] PIXEL trên mobile (root 15px — rem lừa), 36px desktop.
const CREATE_BTN = cn(buttonVariants({ size: 'sm' }), 'h-[44px] md:h-[36px] px-3.5 text-[13px] font-semibold')

export function SchedulesListView({ rows, error }: {
  rows: ScheduleListRow[] | null
  error: { message: string } | null
}) {
  return (
    <div data-ui-v2="page" className="p-4 md:p-6 space-y-4">
      <PageHeader
        title="Task định kỳ"
        icon={CalendarClock}
        actions={
          <Link href="/tasks/new?mode=recurring" className={CREATE_BTN}>
            <Plus className="h-4 w-4 mr-1" />
            Tạo lịch mới
          </Link>
        }
      />

      {error ? (
        <ErrorState message="Không thể tải danh sách lịch định kỳ" hint={error.message} />
      ) : (!rows || rows.length === 0) ? (
        <EmptyState
          className="py-12 rounded-v2-panel border border-dashed border-input bg-card"
          icon={CalendarClock}
          title="Chưa có lịch định kỳ nào."
          hint="Form sẽ mở sẵn ở chế độ “Định kỳ”."
          action={
            <Link href="/tasks/new?mode=recurring" className={CREATE_BTN}>
              <Plus className="h-4 w-4 mr-1" /> Tạo lịch đầu tiên
            </Link>
          }
        />
      ) : (
        <DataTableShell>
          {/* Bảng tự cuộn ngang trong khung (ui/table data-slot=table-container) khi hẹp — trang không cuộn. */}
          <Table className="min-w-[960px]">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Tên lịch</TableHead>
                <TableHead className="px-3 w-[140px]">Tần suất</TableHead>
                <TableHead className="px-3 w-[84px]">Giờ chạy</TableHead>
                <TableHead className="px-3 w-[90px]">Cửa hàng</TableHead>
                <TableHead className="px-3 w-[120px]">Lần chạy tiếp</TableHead>
                <TableHead className="px-3 w-[120px]">Lần cuối</TableHead>
                <TableHead className="px-3 w-[150px]">Trạng thái</TableHead>
                <TableHead className="pl-3 pr-4 w-[130px] text-right">Thao tác</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((s) => (
                <TableRow key={s.id} data-schedule-row>
                  <TableCell className="pl-4 pr-3 min-w-[240px] whitespace-normal">
                    <div className="flex flex-col items-start gap-1.5">
                      {/* Tên dài: tối đa 2 dòng, ngắt được; đọc trọn ở trang chi tiết. */}
                      <Link
                        href={`/tasks/schedules/${s.id}`}
                        className="font-semibold hover:underline line-clamp-2 [overflow-wrap:anywhere]"
                        title={s.title ?? undefined}
                      >
                        {s.title ?? '—'}
                      </Link>
                      {/* Assignment mode = taxonomy — same hue axis as the /tasks
                          method chips (per-staff=sky, store=indigo). */}
                      <TagBadge hue={s.assignment_mode === 'staff_all' ? 'sky' : 'indigo'}>
                        {s.assignment_mode === 'staff_all' ? 'Từng dược sĩ' : 'Cửa hàng'}
                      </TagBadge>
                    </div>
                  </TableCell>
                  <TableCell className="px-3 text-[13px] text-muted-foreground">
                    {FREQ_LABEL[s.frequency] ?? s.frequency}
                  </TableCell>
                  <TableCell className="px-3 font-mono text-[13px]">
                    {s.run_time ?? '—'}
                  </TableCell>
                  <TableCell className="px-3 text-[13px]">
                    {s.storeCount} CH
                  </TableCell>
                  <TableCell className={cn('px-3 text-[13px]', s.is_active ? 'text-foreground' : 'text-v2-text-3')}>
                    {s.next_run_at ? formatDate(s.next_run_at) : '—'}
                  </TableCell>
                  <TableCell className={cn('px-3 text-[13px]', s.last_run_at ? 'text-muted-foreground' : 'text-v2-text-3')}>
                    {s.last_run_at ? formatDate(s.last_run_at) : 'Chưa chạy'}
                  </TableCell>
                  <TableCell className="px-3">
                    <StatusBadge tone={s.is_active ? 'success' : 'neutral'}>
                      {s.is_active ? 'Đang hoạt động' : 'Tạm dừng'}
                    </StatusBadge>
                  </TableCell>
                  <TableCell className="pl-3 pr-4">
                    <div className="flex justify-end">
                      <ScheduleActions scheduleId={s.id} isActive={s.is_active} compact />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DataTableShell>
      )}
    </div>
  )
}
