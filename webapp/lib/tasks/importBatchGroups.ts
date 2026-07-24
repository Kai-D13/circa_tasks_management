// Slice A (audit 24/07) — gộp task import Excel theo import_batch_id (THUẦN,
// test khóa ở e2e/tasks-import-group.spec.ts). Task import (mig 034) có
// import_batch_id nhưng broadcast_id=NULL + parent_task_id=NULL → trước đây
// rơi nhánh flat (N dòng/N store). Group key = import_batch_id — KHÔNG gán
// broadcast_id giả (2 loại batch khác nghiệp vụ/action), KHÔNG update task.
//
// Contract (audit):
//   · children  = viewRows (đã lọc theo view: pending → chưa done, done → done)
//   · total/done = allMembers (tiến độ TOÀN batch trong phạm vi filter hiện
//     tại — page mirror filter store/category/dept/priority vào query members:
//     không filter → toàn batch; filter store → subset đúng store đó)
//   · taskIds   = id các viewRows ("chọn đúng cái đang thấy" — khớp hành vi
//     flat cũ cho export/archive/bulk-resubmit)
//   · title/createdAt = member đầu tiên (viewRows đã sort created_at desc)
//   · batch không có viewRow nào → KHÔNG render group
//   · r1 (audit P1#2): members query LỖI (allMembers=null) hoặc batch thiếu
//     trong kết quả → total/done = NULL — UI hiện "—/—" + "Không tải được
//     tiến độ". TUYỆT ĐỐI không suy đoán từ viewRows (vd batch 1 done/25,
//     màn Pending thấy 24 dòng → suy đoán sẽ ra "0/24" — tín hiệu nghiệp vụ SAI).

// r1 (audit P1#1 + P2#3): điều kiện GOM của page — admin + không archive +
// không assignee filter. KHÔNG phụ thuộc status sub-filter (todo/in_progress/
// overdue VẪN GOM — đây chính là bug 25 dòng ở màn "Chờ thực hiện") lẫn view
// (pending/done đều gom). Page dùng CHÍNH hàm này cho groupPaginate → test
// khóa được điều kiện tích hợp.
export function groupModeActive(p: {
  isAdmin: boolean
  showArchived: boolean
  userFilter: boolean
}): boolean {
  return p.isAdmin && !p.showArchived && !p.userFilter
}

// r1.1 (audit P1#1/P2#3): slice theo GROUP unit — page dùng CHÍNH hàm này sau
// khi đã gộp TOÀN BỘ dataset (dataset phải giống nhau ở mọi request page; mọi
// group xuất hiện đúng MỘT lần trên đúng MỘT trang; page vượt biên → clamp).
export function sliceGroupPage<T>(items: T[], page: number, perPage: number): {
  pageItems: T[]
  totalPages: number
  clampedPage: number
} {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage))
  const clampedPage = Math.min(Math.max(1, page), totalPages)
  return {
    pageItems: items.slice((clampedPage - 1) * perPage, clampedPage * perPage),
    totalPages,
    clampedPage,
  }
}

// r1.1 (audit P1#2): KHÔNG suy đoán "tổng cửa hàng" khi tiến độ lỗi — total
// null → nhãn nói rõ là số ĐANG HIỂN THỊ, không phải tổng batch.
export function groupStoreCountLabel(total: number | null, visibleCount: number): string {
  return total !== null ? `${total} cửa hàng` : `${visibleCount} cửa hàng đang hiển thị`
}

export interface ImportBatchViewRow {
  id: string
  import_batch_id: string
  title: string
  category: string | null
  status: string
  created_at: string
  deadline: string | null
  overdue_at: string | null
  completed_at: string | null
  storeName: string | null
  department: { name: string; color: string | null } | null
  creator: { full_name: string } | null
}

export interface ImportBatchMember { import_batch_id: string; status: string }

// Cấu trúc khớp structurally với union item của TaskList (childTasks theo shape
// ChildTask; assignee luôn null — task import là store-level).
export interface ImportBatchGroupOut {
  type: 'import_batch'
  batchId: string
  title: string
  category: string | null
  department: { name: string; color: string | null } | null
  creator: { full_name: string } | null
  total: number | null   // null = không tải được tiến độ (members lỗi/thiếu)
  done: number | null
  createdAt: string
  taskIds: string[]
  childTasks: {
    id: string
    status: string
    stores: { name: string } | null
    assignee: null
    deadline: string | null
    overdue_at: string | null
    completed_at: string | null
  }[]
}

export function buildImportBatchGroups(
  viewRows: ImportBatchViewRow[],
  allMembers: ImportBatchMember[] | null,  // null = members query LỖI
): ImportBatchGroupOut[] {
  const memberStats = new Map<string, { total: number; done: number }>()
  for (const m of allMembers ?? []) {
    const s = memberStats.get(m.import_batch_id) ?? { total: 0, done: 0 }
    s.total++
    if (m.status === 'done') s.done++
    memberStats.set(m.import_batch_id, s)
  }

  const groups = new Map<string, ImportBatchGroupOut>()
  for (const r of viewRows) {
    let g = groups.get(r.import_batch_id)
    if (!g) {
      g = {
        type: 'import_batch',
        batchId: r.import_batch_id,
        title: r.title,
        category: r.category,
        department: r.department,
        creator: r.creator,
        total: null,
        done: null,
        createdAt: r.created_at,
        taskIds: [],
        childTasks: [],
      }
      groups.set(r.import_batch_id, g)
    }
    g.taskIds.push(r.id)
    g.childTasks.push({
      id: r.id,
      status: r.status,
      stores: r.storeName !== null ? { name: r.storeName } : null,
      assignee: null,
      deadline: r.deadline,
      overdue_at: r.overdue_at,
      completed_at: r.completed_at,
    })
  }

  for (const g of groups.values()) {
    const stats = allMembers === null ? undefined : memberStats.get(g.batchId)
    if (stats && stats.total > 0) {
      g.total = stats.total
      g.done = stats.done
    }
    // else: giữ null — UI hiện "—/—" + "Không tải được tiến độ" (audit P1#2:
    // không bao giờ suy đoán tổng từ subset đang thấy).
  }
  return [...groups.values()]
}
