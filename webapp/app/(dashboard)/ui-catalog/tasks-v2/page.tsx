import { notFound, redirect } from 'next/navigation'
import { ClipboardList, Download, Inbox, Plus, X } from 'lucide-react'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { isSuperAdminEmail } from '@/lib/authz'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/components/ds/PageHeader'
import { StatCard } from '@/components/ds/StatCard'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { TagBadge } from '@/components/ds/TagBadge'
import { FilterTabs } from '@/components/ds/FilterTabs'
import { DataToolbar, FILTER_ACTIVE } from '@/components/ds/DataToolbar'
import { DataTableShell } from '@/components/ds/DataTableShell'
import { EmptyState } from '@/components/ds/EmptyState'
import { ErrorState } from '@/components/ds/ErrorState'
import { LoadingState } from '@/components/ds/LoadingState'
import { DetailPageShell } from '@/components/ds/DetailPageShell'
import { Panel } from '@/components/ds/Panel'
import { Notice } from '@/components/ds/Notice'
import { ProgressBar } from '@/components/ds/ProgressBar'
import { BulkActionBar, BULK_ACTION_BUTTON } from '@/components/ds/BulkActionBar'
import { TaskList, type ChildTask, type TaskListItem } from '@/components/tasks/TaskList'
import { cn } from '@/lib/utils'

// Dev-only catalog UI v2 Tasks (docs/ui/UI_V2_TASKS.md) — gốc trang data-ui-v2="page" nên MỌI token
// v2 có hiệu lực ở đây, còn /ui-catalog (mặc định) không đổi pixel. 100% fixture giả (ảnh snapshot
// commit được). Cổng như /ui-catalog: UI_CATALOG=1 (Coolify không đặt ⇒ prod 404) + super admin.

const SWATCHES = [
  { name: 'canvas', token: '--v2-canvas', cls: 'bg-background' },
  { name: 'panel', token: '--v2-panel', cls: 'bg-card' },
  { name: 'muted', token: '--v2-muted', cls: 'bg-muted' },
  { name: 'line', token: '--v2-line', cls: 'bg-border' },
  { name: 'line-strong', token: '--v2-line-strong', cls: 'bg-input' },
  { name: 'action', token: '--v2-action', cls: 'bg-primary' },
  { name: 'selected', token: '--v2-selected', cls: 'bg-accent' },
  { name: 'inverse', token: '--v2-text', cls: 'bg-foreground' },
]

const ROWS = [
  { title: 'Task QA 01 — trưng bày tuần', tags: [['Trưng bày', 'green'], ['Định kỳ', 'teal']] as const, meta: 'Tạo bởi Nguyễn Văn A', store: '25 cửa hàng', done: 18, total: 25, status: null, deadline: '20/10' },
  { title: 'Task QA 02 — kiểm kê cận date', tags: [['Kiểm tra', 'amber'], ['Cửa hàng nộp', 'indigo']] as const, meta: 'Tạo bởi Trần Thị B', store: 'POS_TEST Cửa hàng A', done: 0, total: 0, status: ['danger', 'Quá hạn'] as const, deadline: '13/10' },
  { title: 'Task QA 03 — training nhóm sản phẩm', tags: [['Training', 'blue'], ['Dược sĩ nộp', 'sky']] as const, meta: 'Tạo bởi Lê Văn C', store: '25 cửa hàng', done: 37, total: 90, status: null, deadline: '25/10' },
  { title: 'Task QA 04 — tentcard quầy', tags: [['Trưng bày', 'green']] as const, meta: 'Tạo bởi Phạm Thị D', store: 'POS_TEST Cửa hàng B', done: 0, total: 0, status: ['info', 'Đang thực hiện'] as const, deadline: '22/10' },
]

// P1.2 r1.1: TaskList THẬT với fixture đủ 4 loại dòng nhóm (broadcast, import mất tiến độ, từng dược sĩ
// nhiều cửa hàng, từng dược sĩ max=0) + 1 task đơn — để test vị trí cột không phụ thuộc dữ liệu prod.
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const DL = '2026-01-20T10:00:00.000Z'
const child = (n: number, store: string, who: string, status = 'todo'): ChildTask => ({
  id: U(n), status, stores: { name: store }, assignee: { full_name: who }, deadline: DL, overdue_at: null,
})
const TL_ITEMS: TaskListItem[] = [
  {
    type: 'broadcast', broadcastId: U(9001),
    title: 'Nhóm QA broadcast — tiêu đề nhóm rất dài để kiểm tra xuống dòng trong cột Tiêu đề khi bảng hẹp',
    category: 'display', department: { name: 'Commercial', color: null }, creator: { full_name: 'Nguyễn Văn A' },
    total: 3, done: 2, createdAt: '2026-01-10T03:00:00.000Z', taskIds: [U(9101), U(9102), U(9103)],
    childTasks: [child(9101, 'POS_TEST Cửa hàng A', 'Trần Thị B', 'done'), child(9102, 'POS_TEST Cửa hàng B', 'Lê Văn C', 'in_progress'), child(9103, 'POS_TEST Cửa hàng C', 'Phạm Thị D')],
  },
  {
    type: 'import_batch', batchId: U(9002), title: 'Nhóm QA import Excel (mất tiến độ)', category: 'audit',
    creator: { full_name: 'Trần Thị B' }, total: null, done: null, createdAt: '2026-01-09T03:00:00.000Z',
    taskIds: [U(9201), U(9202)], childTasks: [child(9201, 'POS_TEST Cửa hàng A', 'Trần Thị B'), child(9202, 'POS_TEST Cửa hàng B', 'Lê Văn C')],
  },
  {
    type: 'staff_broadcast', broadcastId: U(9003), title: 'Nhóm QA từng dược sĩ nhiều cửa hàng', category: 'training',
    creator: { full_name: 'Lê Văn C' }, createdAt: '2026-01-08T03:00:00.000Z', taskIds: [U(9301), U(9311), U(9312)],
    stores: [{ parentId: U(9301), storeName: 'POS_TEST Cửa hàng A', total: 2, done: 1,
      childTasks: [child(9311, 'POS_TEST Cửa hàng A', 'Trần Thị B', 'done'), child(9312, 'POS_TEST Cửa hàng A', 'Phạm Thị D')] }],
    totalStores: 1, totalStaff: 2, doneStaff: 1,
  },
  {
    type: 'staff', parentId: U(9004), title: 'Nhóm QA từng dược sĩ một cửa hàng (chưa có dược sĩ)', category: 'other',
    creator: { full_name: 'Phạm Thị D' }, storeName: 'POS_TEST Cửa hàng B', total: 0, done: 0,
    createdAt: '2026-01-07T03:00:00.000Z', taskIds: [U(9004)], childTasks: [],
  },
  {
    type: 'task',
    task: {
      id: U(9005), title: 'Task QA đơn — quá hạn', status: 'todo', priority: 'urgent', category: 'recall',
      broadcast_id: null, source_schedule_id: null, assignment_mode: 'store', assigned_to: null,
      stores: { name: 'POS_TEST Cửa hàng C' }, assignee: null, completed_by_user: null, creator: { full_name: 'Lê Văn C' },
      completed_at: null, deadline: DL, overdue_at: null, created_at: '2026-01-06T03:00:00.000Z',
    },
  },
]

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-v2-text-3">{title}</h2>
      {children}
    </section>
  )
}

export default async function UiCatalogTasksV2Page() {
  if (process.env.UI_CATALOG !== '1') notFound()
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  if (!(profile?.role === 'admin' && isSuperAdminEmail(user.email))) notFound()

  return (
    <div data-ui-v2="page" data-testid="ui-catalog-v2" className="p-4 md:p-6 space-y-8">
      <PageHeader
        title="Tasks v2 — Catalog"
        subtitle="Dev-only · fixture giả 100% · phạm vi [data-ui-v2]"
        icon={ClipboardList}
        actions={
          <>
            <Button variant="outline" className="h-[44px] md:h-[36px] gap-2 px-3.5 text-[13px]"><Download aria-hidden="true" /> Xuất Excel</Button>
            <Button className="h-[44px] md:h-[36px] gap-1.5 px-3.5 text-[13px] font-semibold"><Plus aria-hidden="true" /> Tạo Task</Button>
          </>
        }
      />

      <Section title="Token bề mặt (trỏ token ngữ nghĩa trong phạm vi)">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {SWATCHES.map((s) => (
            <div key={s.name} className="space-y-1.5">
              <div data-v2-swatch={s.name} className={cn('h-12 rounded-v2-control border border-input', s.cls)} />
              <p className="text-[12px] font-semibold">{s.name}</p>
              <p className="font-mono text-[11px] text-muted-foreground">{s.token}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="StatusBadge (chấm + chữ) · TagBadge">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone="neutral">Chờ thực hiện</StatusBadge>
          <StatusBadge tone="info">Đang thực hiện</StatusBadge>
          <StatusBadge tone="success">Hoàn thành</StatusBadge>
          <StatusBadge tone="warning">Hoàn thành trễ</StatusBadge>
          <StatusBadge tone="danger">Quá hạn</StatusBadge>
          <StatusBadge tone="warning" size="sm">Khẩn cấp</StatusBadge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <TagBadge hue="blue">Training</TagBadge>
          <TagBadge hue="red">Thu hồi</TagBadge>
          <TagBadge hue="green">Trưng bày</TagBadge>
          <TagBadge hue="amber">Kiểm tra</TagBadge>
          <TagBadge hue="teal">Định kỳ</TagBadge>
          <TagBadge hue="slate">Phát sinh</TagBadge>
          <TagBadge hue="indigo">Cửa hàng nộp</TagBadge>
          <TagBadge hue="sky">Dược sĩ nộp</TagBadge>
          <TagBadge hue="gray">Khác</TagBadge>
        </div>
      </Section>

      <Section title="StatCard v2">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Tổng task (fixture)" value="1.284" hint="Chú thích chỉ dùng khi đã có dữ liệu" />
          <StatCard label="Đang thực hiện" value={312} tone="info" />
          <StatCard label="Hoàn thành" value={846} tone="success" />
          <StatCard label="Quá hạn" value={47} tone="danger" />
        </div>
      </Section>

      <Section title="FilterTabs segmented · lọc · control">
        <FilterTabs
          ariaLabel="Bộ lọc"
          activeKey="pending"
          tabs={[
            { key: 'pending', label: 'Chờ thực hiện', href: '#' },
            { key: 'done', label: 'Hoàn thành', href: '#' },
          ]}
        />
        <DataToolbar
          filters={
            <>
              <Select defaultValue="all">
                <SelectTrigger aria-label="Ưu tiên" className="h-[44px] md:h-[36px] w-44 text-[16px] md:text-[13px]">
                  <SelectValue>Tất cả ưu tiên</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tất cả ưu tiên</SelectItem>
                </SelectContent>
              </Select>
              <Select defaultValue="training">
                <SelectTrigger aria-label="Danh mục" className={cn('h-[44px] md:h-[36px] w-44 text-[16px] md:text-[13px]', FILTER_ACTIVE)}>
                  <SelectValue>Training</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="training">Training</SelectItem>
                </SelectContent>
              </Select>
            </>
          }
          actions={<Button variant="ghost" className="h-[44px] md:h-[36px] gap-1.5 px-2.5 text-[13px] text-muted-foreground"><X aria-hidden="true" /> Xoá bộ lọc</Button>}
        />
        <div className="grid gap-3 md:grid-cols-2">
          <Input aria-label="Tiêu đề task" placeholder="Tiêu đề task..." className="h-[44px] md:h-[36px]" />
          <Textarea aria-label="Ghi chú" placeholder="Nhập nội dung ghi chú..." rows={2} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button className="h-[44px] md:h-[36px] px-3.5 text-[13px] font-semibold">Primary</Button>
          <Button variant="outline" className="h-[44px] md:h-[36px] px-3.5 text-[13px]">Outline</Button>
          <Button variant="ghost" className="h-[44px] md:h-[36px] px-3 text-[13px]">Ghost</Button>
          <Button variant="destructive" className="h-[44px] md:h-[36px] px-3.5 text-[13px]">Xoá</Button>
        </div>
      </Section>

      <Section title="DataTableShell · ProgressBar · BulkActionBar">
        <DataTableShell>
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow>
                <TableHead>Tiêu đề</TableHead>
                <TableHead className="w-40">Cửa hàng</TableHead>
                <TableHead className="w-48">Thực hiện / Đã nộp</TableHead>
                <TableHead className="w-36">Trạng thái</TableHead>
                <TableHead className="w-24">Deadline</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ROWS.map((r) => (
                <TableRow key={r.title}>
                  <TableCell className="align-top">
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <span className="font-semibold">{r.title}</span>
                      <span className="flex flex-wrap gap-1.5">{r.tags.map(([label, hue]) => <TagBadge key={label} hue={hue}>{label}</TagBadge>)}</span>
                      <span className="text-[12px] text-v2-text-3">{r.meta}</span>
                    </div>
                  </TableCell>
                  <TableCell className="align-top text-muted-foreground">{r.store}</TableCell>
                  <TableCell className="align-top">
                    {r.total > 0
                      ? <ProgressBar value={r.done} max={r.total} tone={r.done === r.total ? 'success' : 'warning'} label={`${r.done}/${r.total} hoàn thành`} ariaLabel={`${r.done}/${r.total} hoàn thành`} className="max-w-[170px]" />
                      : <span className="text-[13px] text-v2-text-3">—</span>}
                  </TableCell>
                  <TableCell className="align-top">{r.status && <StatusBadge tone={r.status[0]}>{r.status[1]}</StatusBadge>}</TableCell>
                  <TableCell className={cn('align-top text-[13px] whitespace-nowrap', r.status?.[0] === 'danger' ? 'font-semibold text-status-danger' : 'text-muted-foreground')}>{r.deadline}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DataTableShell>
        <BulkActionBar label="2 task đã chọn" className="static">
          <button type="button" className={BULK_ACTION_BUTTON}>Xuất đã chọn (2)</button>
          <button type="button" className={BULK_ACTION_BUTTON}>Lưu trữ đã chọn</button>
        </BulkActionBar>
      </Section>

      <Section title="Panel · Notice">
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Mô tả" titleStyle="eyebrow">
            <p className="text-[14px] leading-[1.65]">Nội dung fixture của một khối mô tả — chữ thật lấy từ dữ liệu trang.</p>
          </Panel>
          <Panel title="Hoạt động gần đây" flush actions={<span className="text-[13px] font-medium text-accent-foreground">Xem tất cả →</span>}>
            <ul className="divide-y">
              <li className="px-5 py-3 text-[13px]">Task QA 01 — trưng bày tuần</li>
              <li className="px-5 py-3 text-[13px]">Task QA 02 — kiểm kê cận date</li>
            </ul>
          </Panel>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <Notice tone="warning" title="Đang chờ nộp lại">Đã yêu cầu làm lại từ 01/01/2026 — fixture.</Notice>
          <Notice tone="info" title="Thông tin">Khối thông tin trung tính dùng cặp status-info.</Notice>
          <Notice tone="danger" title="Cần xử lý">Khối nhắc mức nguy hiểm dùng cặp status-danger.</Notice>
          <Notice tone="success" title="Đã hoàn thành">Khối xác nhận dùng cặp status-success.</Notice>
        </div>
      </Section>

      <Section title="Empty / Error / Loading">
        <div className="grid gap-3 md:grid-cols-2">
          <Panel>
            <EmptyState icon={Inbox} title="Chưa có lịch định kỳ nào." hint="Fixture trạng thái rỗng." />
          </Panel>
          <div className="space-y-3">
            <ErrorState message="Không tải được danh sách" hint="Tải lại trang để thử lại." />
            <LoadingState variant="cards" rows={2} />
          </div>
        </div>
        <LoadingState variant="table" rows={3} />
      </Section>

      <Section title="TaskList fixture — 4 loại nhóm (có / không ô chọn)">
        <div data-testid="fx-tasklist-checkbox"><TaskList items={TL_ITEMS} canArchive userRole="admin" /></div>
        <div data-testid="fx-tasklist-nocheckbox"><TaskList items={TL_ITEMS} canArchive={false} userRole="admin" /></div>
      </Section>

      <Section title="DetailPageShell v2">
        <Panel flush>
          <DetailPageShell
            backHref="#"
            backLabel="Danh sách Tasks"
            title="Task QA 04 — tentcard quầy"
            badges={<StatusBadge tone="info">Đang thực hiện</StatusBadge>}
            meta={<>POS_TEST Cửa hàng B · Tạo bởi Phạm Thị D · 01/01/2026</>}
            actions={<Button variant="outline" className="h-[44px] md:h-[36px] px-3 text-[13px]">Chỉnh sửa</Button>}
          >
            <p className="text-[14px] text-muted-foreground">Nội dung trang chi tiết…</p>
          </DetailPageShell>
        </Panel>
      </Section>
    </div>
  )
}
