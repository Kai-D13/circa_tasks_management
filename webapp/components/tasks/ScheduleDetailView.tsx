import Link from 'next/link'
import { DetailPageShell } from '@/components/ds/DetailPageShell'
import { ErrorState } from '@/components/ds/ErrorState'
import { Panel } from '@/components/ds/Panel'
import { StatusBadge, type StatusTone } from '@/components/ds/StatusBadge'
import { TagBadge, type TagHue } from '@/components/ds/TagBadge'
import { ScheduleActions } from '@/components/tasks/ScheduleActions'
import { ShareScheduleDialog, type ScheduleCollaboratorRow } from '@/components/tasks/ShareScheduleDialog'
import { RichText } from '@/components/tasks/RichText'
import { TaskStatusBadge } from '@/components/tasks/TaskStatusBadge'
import { TaskPriorityBadge } from '@/components/tasks/TaskPriorityBadge'
import { CalendarClock, ChevronRight, Store } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatDate } from '@/lib/dateUtils'
import { TaskCategory, TaskPriority, TaskStatus } from '@/types'

// UI v2 P1.5 (artboard 05) — phần TRÌNH BÀY của /tasks/schedules/[id]. Query, cổng admin, RBAC
// (owner/collaborator) và phân biệt 404/lỗi nằm ở page.tsx; component này chỉ nhận dữ liệu + cờ quyền đã
// tính sẵn, để route thật và fixture catalog (/ui-catalog/schedules-v2) dùng CHUNG một markup.
// Tự mang gốc data-ui-v2="page". Native <details> accordion giữ nguyên.
const FREQ_LABEL: Record<string, string> = {
  daily:   'Mỗi ngày',
  weekly:  'Mỗi tuần',
  monthly: 'Mỗi tháng',
}

const WEEKDAY_LABELS: Record<number, string> = {
  0: 'Chủ nhật', 1: 'Thứ Hai', 2: 'Thứ Ba', 3: 'Thứ Tư',
  4: 'Thứ Năm', 5: 'Thứ Sáu', 6: 'Thứ Bảy',
}

const CATEGORY_LABEL: Record<TaskCategory, string> = {
  training: 'Training', recall: 'Thu hồi / Kiểm kê',
  display: 'Trưng bày', audit: 'Kiểm tra', other: 'Khác',
}
// Category = taxonomy → TagBadge hues (same axis as /tasks).
const CATEGORY_HUE: Record<TaskCategory, TagHue> = {
  training: 'blue', recall: 'red', display: 'green', audit: 'amber', other: 'gray',
}
const OUTPUT_LABEL: Record<string, string> = {
  text: 'Ghi chú', image: 'Ảnh', video: 'Video', file: 'File',
}
// Run outcome = semantic status → StatusBadge tones.
const RUN_STATUS_TONE: Record<string, StatusTone> = {
  success: 'success', failed: 'danger', running: 'info', skipped: 'neutral',
}
const RUN_STATUS_LABEL: Record<string, string> = {
  success: 'Thành công', failed: 'Lỗi', running: 'Đang chạy', skipped: 'Bỏ qua',
}

export type ScheduleTemplateConfig = {
  description?: string; category: TaskCategory; priority: string
  visibility: string; required_outputs: string[]
  input_data?: { attachments?: { name: string; url: string }[]; links?: { label: string; url: string }[] }
}

export type ScheduleDetailData = {
  title: string | null
  is_active: boolean
  frequency: string
  assignment_mode: string | null
  weekdays: number[]
  month_day: number | null
  run_time: string | null
  deadline_offset_hours: number | null
  timezone: string | null
  start_date: string | null
  end_date: string | null
  last_run_at: string | null
  next_run_at: string | null
  config: ScheduleTemplateConfig | undefined
  stores: { store_id: string; name: string | null }[]
}

export type ScheduleRun = {
  id: string; scheduled_for: string | null; status: string
  created_count: number | null; error_message: string | null
}

export type ScheduleRecentTask = {
  id: string; status: string; scheduled_for: string | null
  deadline: string | null; overdue_at: string | null; stores: { name: string } | null
}

export type ScheduleDetailViewProps = {
  scheduleId: string
  data: ScheduleDetailData
  runs: ScheduleRun[] | null
  runsError: { message: string } | null
  recentTasks: ScheduleRecentTask[] | null
  recentTasksError: { message: string } | null
  isOwner: boolean
  isEditorCollaborator: boolean
  collaborators: ScheduleCollaboratorRow[]
  adminOptions: { value: string; label: string; description?: string }[]
  myCollabError: boolean
  shareDataError: boolean
}

// Cặp nhãn–giá trị của "Cấu hình lịch" (dl 2 cột như artboard: nhãn 1fr, giá trị 1.4fr).
function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="border-b px-4 md:px-5 py-2.5 text-[13px] text-muted-foreground">{label}</dt>
      <dd className="border-b px-4 md:px-5 py-2.5 text-[13px] font-medium min-w-0 [overflow-wrap:anywhere]">{children}</dd>
    </>
  )
}

// Trường của "Nội dung task": nhãn nhỏ phía trên, giá trị bên dưới.
function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <span className="text-[12px] text-v2-text-3">{label}</span>
      <div className="min-w-0 text-[13px]">{children}</div>
    </div>
  )
}

const CHIP = 'rounded-v2-chip bg-muted px-2 py-0.5 text-[12px] text-muted-foreground'
const LINK = 'block text-accent-foreground hover:underline [overflow-wrap:anywhere]'
const SHELL = 'md:px-6 md:pt-5 md:pb-8 space-y-4 md:space-y-[18px]'

// Lỗi truy vấn thật (không phải 404) — cùng khung, cùng gốc v2.
export function ScheduleDetailErrorView({ message }: { message: string }) {
  return (
    <div data-ui-v2="page">
      <DetailPageShell layoutWidth="fluid" className={SHELL} backHref="/tasks/schedules" backLabel="Định kỳ" title="Chi tiết lịch">
        <ErrorState message="Không thể tải lịch định kỳ" hint={message} />
      </DetailPageShell>
    </div>
  )
}

export function ScheduleDetailView({
  scheduleId, data, runs, runsError, recentTasks, recentTasksError,
  isOwner, isEditorCollaborator, collaborators, adminOptions, myCollabError, shareDataError,
}: ScheduleDetailViewProps) {
  const { config } = data

  // Group generated tasks by run date (scheduled_for) so each cron run collapses
  // into one expandable row (Lần chạy → cửa hàng), instead of a long flat list.
  const recentByRun = new Map<string, ScheduleRecentTask[]>()
  for (const t of recentTasks ?? []) {
    const key = t.scheduled_for ?? 'unknown'
    const arr = recentByRun.get(key) ?? []
    arr.push(t)
    recentByRun.set(key, arr)
  }
  const runGroups = [...recentByRun.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))

  return (
    <div data-ui-v2="page">
      <DetailPageShell
        layoutWidth="fluid"
        className={SHELL}
        backHref="/tasks/schedules"
        backLabel="Định kỳ"
        title={data.title ?? '—'}
        badges={
          <>
            <StatusBadge tone={data.is_active ? 'success' : 'neutral'}>
              {data.is_active ? 'Đang hoạt động' : 'Tạm dừng'}
            </StatusBadge>
            {config?.category && (
              <TagBadge hue={CATEGORY_HUE[config.category] ?? 'gray'}>
                {CATEGORY_LABEL[config.category] ?? config.category}
              </TagBadge>
            )}
          </>
        }
        meta={
          <span className="flex items-center gap-1.5">
            <CalendarClock className="h-3.5 w-3.5 shrink-0" />
            {FREQ_LABEL[data.frequency] ?? data.frequency} · Lần tiếp: {data.next_run_at ? formatDate(data.next_run_at) : '—'}
          </span>
        }
        actions={
          <>
            {/* Owner share dialog — suppressed if its data failed to load (an
                empty dialog reads as "no admins to share with"). */}
            {isOwner && !shareDataError && (
              <ShareScheduleDialog
                scheduleId={scheduleId}
                collaborators={collaborators}
                adminOptions={adminOptions}
              />
            )}
            {/* View-only collaborators get no pause/resume — RLS would reject it
                as a silent 0-row update, which the action would misreport as success. */}
            {(isOwner || isEditorCollaborator) && (
              <ScheduleActions scheduleId={scheduleId} isActive={data.is_active} canDelete={isOwner} />
            )}
          </>
        }
      >
        {/* A failed own-collaborator read leaves pause/resume gating uncertain;
            a failed share-data read hides the dialog — warn in both cases. */}
        {(myCollabError || shareDataError) && (
          <ErrorState
            message="Một số thông tin quyền không tải được"
            hint={
              (myCollabError ? 'Không kiểm tra được quyền cộng tác. ' : '')
              + (shareDataError ? 'Danh sách chia sẻ tạm thời không khả dụng. ' : '')
              + 'Vui lòng tải lại trang.'
            }
          />
        )}

        {/* Cấu hình lịch | Nội dung task — 2 cột khi đủ rộng, xếp dọc trên mobile */}
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel flush title="Cấu hình lịch">
            <dl data-schedule-config className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] [&>*:nth-last-child(-n+2)]:border-b-0">
              <KV label="Chế độ giao">
                {data.assignment_mode === 'staff_all' ? 'Từng dược sĩ nộp' : 'Cửa hàng nộp'}
              </KV>
              <KV label="Tần suất">{FREQ_LABEL[data.frequency] ?? data.frequency}</KV>
              {data.frequency === 'weekly' && data.weekdays.length > 0 && (
                <KV label="Ngày trong tuần">
                  <span className="flex flex-wrap gap-1">
                    {[...data.weekdays].sort().map((d) => (
                      <span key={d} className={CHIP}>{WEEKDAY_LABELS[d]}</span>
                    ))}
                  </span>
                </KV>
              )}
              {data.frequency === 'monthly' && data.month_day && (
                <KV label="Ngày trong tháng">Ngày {data.month_day}</KV>
              )}
              <KV label="Giờ tạo task">{data.run_time ?? '—'}</KV>
              <KV label="Deadline sau khi tạo">{data.deadline_offset_hours}h</KV>
              <KV label="Múi giờ">{data.timezone}</KV>
              <KV label="Ngày bắt đầu">{data.start_date ? formatDate(data.start_date) : '—'}</KV>
              <KV label="Ngày kết thúc">{data.end_date ? formatDate(data.end_date) : 'Không giới hạn'}</KV>
              <KV label="Lần chạy gần nhất">{data.last_run_at ? formatDate(data.last_run_at) : 'Chưa chạy'}</KV>
              <KV label="Lần chạy tiếp theo">{data.next_run_at ? formatDate(data.next_run_at) : '—'}</KV>
            </dl>
          </Panel>

          <Panel flush title="Nội dung task">
            <div data-schedule-content className="space-y-3.5 px-4 md:px-5 py-4">
              <div className="flex flex-wrap gap-x-6 gap-y-3.5">
                <Field label="Ưu tiên">
                  {config?.priority ? <TaskPriorityBadge priority={config.priority as TaskPriority} /> : '—'}
                </Field>
                <Field label="Output cần nộp">
                  {config?.required_outputs?.length ? (
                    <span className="flex flex-wrap gap-1">
                      {config.required_outputs.map((o) => (
                        <span key={o} className={CHIP}>{OUTPUT_LABEL[o] ?? o}</span>
                      ))}
                    </span>
                  ) : '—'}
                </Field>
              </div>
              {config?.description && (
                <Field label="Mô tả">
                  <RichText value={config.description} className="text-[14px] leading-[1.6]" />
                </Field>
              )}
              {(config?.input_data?.attachments?.length ?? 0) > 0 && (
                <Field label="Tài liệu đính kèm">
                  <span className="block space-y-1">
                    {config!.input_data!.attachments!.map((a, i) => (
                      <a key={i} href={a.url} target="_blank" rel="noreferrer" className={LINK}>{a.name}</a>
                    ))}
                  </span>
                </Field>
              )}
              {(config?.input_data?.links?.length ?? 0) > 0 && (
                <Field label="Links">
                  <span className="block space-y-1">
                    {config!.input_data!.links!.map((l, i) => (
                      <a key={i} href={l.url} target="_blank" rel="noreferrer" className={LINK}>{l.label || l.url}</a>
                    ))}
                  </span>
                </Field>
              )}
            </div>
          </Panel>
        </div>

        {/* Stores — TOÀN BỘ danh sách (không rút gọn "+N"), chip xuống dòng trong panel */}
        <Panel
          title={
            <span className="flex items-center gap-1.5">
              <Store className="h-4 w-4 text-muted-foreground" />
              Cửa hàng nhận task ({data.stores.length})
            </span>
          }
        >
          {data.stores.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">Chưa có cửa hàng nào</p>
          ) : (
            <div data-schedule-stores className="flex flex-wrap gap-1.5">
              {data.stores.map((ss) => (
                <span key={ss.store_id} className="rounded-v2-chip bg-muted px-2.5 py-1 text-[12px] text-muted-foreground [overflow-wrap:anywhere]">
                  {ss.name ?? ss.store_id.slice(0, 8)}
                </span>
              ))}
            </div>
          )}
        </Panel>

        {/* Lịch sử chạy | Task đã tạo gần đây — 2 cột khi đủ rộng */}
        <div className="grid items-start gap-4 xl:grid-cols-2">
          {/* Recent generation runs */}
          <Panel flush title="Lịch sử chạy">
            {runsError ? (
              <div className="p-4 md:px-5"><ErrorState message="Không tải được lịch sử chạy" hint={runsError.message} /></div>
            ) : (!runs || runs.length === 0) ? (
              <p className="px-4 md:px-5 py-4 text-[13px] text-muted-foreground">Chưa có lần chạy nào</p>
            ) : (
              <div className="overflow-x-auto">
                <table data-schedule-runs className="w-full md:min-w-[440px] text-[13px]">
                  <thead className="bg-muted">
                    <tr>
                      <th className="text-left pl-4 md:pl-5 pr-3 py-2 text-[12px] font-medium text-muted-foreground whitespace-nowrap">Ngày</th>
                      <th className="text-left px-3 py-2 text-[12px] font-medium text-muted-foreground whitespace-nowrap">Kết quả</th>
                      <th className="text-left px-3 max-md:pr-4 py-2 text-[12px] font-medium text-muted-foreground whitespace-nowrap">Task tạo</th>
                      <th className="hidden md:table-cell text-left pl-3 pr-5 py-2 text-[12px] font-medium text-muted-foreground whitespace-nowrap">Chi tiết</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r) => (
                      <tr key={r.id} className="border-t hover:bg-muted/30 max-md:align-top">
                        <td className="pl-4 md:pl-5 pr-3 py-2.5 whitespace-nowrap">
                          {r.scheduled_for ?? '—'}
                        </td>
                        <td className="px-3 py-2.5">
                          <StatusBadge tone={RUN_STATUS_TONE[r.status] ?? 'neutral'}>
                            {RUN_STATUS_LABEL[r.status] ?? r.status}
                          </StatusBadge>
                          {/* Mobile: ghi chú ngay dưới kết quả (cột "Chi tiết" ẩn) — đọc trọn, không cuộn ngang. */}
                          {r.error_message && (
                            <p data-run-note className="md:hidden mt-1.5 text-[12px] text-muted-foreground [overflow-wrap:anywhere]">{r.error_message}</p>
                          )}
                        </td>
                        <td className="px-3 max-md:pr-4 py-2.5 tabular-nums whitespace-nowrap">
                          {r.created_count ?? 0} task
                        </td>
                        {/* Ghi chú lỗi dài: xuống dòng, đọc trọn (không cắt). */}
                        <td className="hidden md:table-cell pl-3 pr-5 py-2.5 min-w-[160px] text-muted-foreground [overflow-wrap:anywhere]">
                          {r.error_message ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          {/* Recent tasks generated */}
          <Panel flush title="Task đã tạo gần đây">
            {recentTasksError ? (
              <div className="p-4 md:px-5"><ErrorState message="Không tải được task đã tạo" hint={recentTasksError.message} /></div>
            ) : runGroups.length === 0 ? (
              <p className="px-4 md:px-5 py-4 text-[13px] text-muted-foreground">Chưa có task nào được tạo</p>
            ) : (
              runGroups.map(([date, tasks], idx) => {
                const done = tasks.filter((t) => t.status === 'done').length
                return (
                  <details key={date} open={idx === 0} data-schedule-run-group className="group border-b last:border-0">
                    <summary className="flex items-center gap-2 px-4 md:px-5 min-h-[44px] py-2.5 cursor-pointer hover:bg-muted/60 group-open:bg-muted list-none select-none">
                      <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-90 shrink-0" />
                      <span className="font-semibold text-[14px]">{date === 'unknown' ? '—' : formatDate(date)}</span>
                      <span className="text-[13px] text-muted-foreground">· {tasks.length} task</span>
                      <span className={cn('ml-auto text-[13px] font-semibold whitespace-nowrap', done === tasks.length ? 'text-status-success' : 'text-status-warning')}>
                        {done}/{tasks.length} hoàn thành
                      </span>
                    </summary>
                    <div className="overflow-x-auto">
                      <table className="w-full text-[13px]">
                        <tbody>
                          {tasks.map((t) => (
                            <tr key={t.id} className="border-t hover:bg-muted/30">
                              <td className="pl-4 md:pl-5 pr-3 py-2.5 max-w-[260px]">
                                <Link href={`/tasks/${t.id}`} className="hover:underline block truncate" title={t.stores?.name ?? undefined}>
                                  {t.stores?.name ?? '—'}
                                </Link>
                              </td>
                              <td className="px-3 py-2.5">
                                <TaskStatusBadge status={t.status as TaskStatus} late={t.status === 'done' && !!t.overdue_at} />
                              </td>
                              <td className="pl-3 pr-4 md:pr-5 py-2.5 text-[12px] text-v2-text-3 whitespace-nowrap text-right">
                                {t.deadline ? formatDate(t.deadline) : '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )
              })
            )}
          </Panel>
        </div>
      </DetailPageShell>
    </div>
  )
}
