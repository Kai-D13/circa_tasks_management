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
//   · members query lỗi/rỗng cho batch → fallback đếm theo viewRows
//     (fail-visible: badge phản ánh subset đang thấy, không bịa số).

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
  total: number
  done: number
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
  allMembers: ImportBatchMember[],
): ImportBatchGroupOut[] {
  const memberStats = new Map<string, { total: number; done: number }>()
  for (const m of allMembers) {
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
        total: 0,
        done: 0,
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
    const stats = memberStats.get(g.batchId)
    if (stats && stats.total > 0) {
      g.total = stats.total
      g.done = stats.done
    } else {
      // Fallback fail-visible: members thiếu → badge theo subset đang thấy.
      g.total = g.childTasks.length
      g.done = g.childTasks.filter((c) => c.status === 'done').length
    }
  }
  return [...groups.values()]
}
