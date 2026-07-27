import { test, expect } from '@playwright/test'
import {
  buildImportBatchGroups, groupModeActive, sliceGroupPage, groupStoreCountLabel,
  type ImportBatchViewRow, type ImportBatchMember,
} from '../lib/tasks/importBatchGroups'

// Slice A unit gate (audit 24/07) — khóa contract gộp task import Excel theo
// import_batch_id: badge toàn batch, children theo view, taskIds = subset đang
// thấy, store-filter subset, fallback fail-visible.

const BATCH = 'batch-e19'
const row = (id: string, status: string, store: string, over: Partial<ImportBatchViewRow> = {}): ImportBatchViewRow => ({
  id, import_batch_id: BATCH, title: 'Kiểm kê quý 3', category: 'audit', status,
  created_at: '2026-07-24T03:00:00Z', deadline: '2026-07-26T10:00:00Z', overdue_at: null,
  completed_at: status === 'done' ? '2026-07-24T05:00:00Z' : null,
  storeName: store, department: { name: 'OPS', color: 'orange' }, creator: { full_name: 'Admin A' },
  ...over,
})
const members = (done: number, total: number): ImportBatchMember[] => [
  ...Array.from({ length: done }, () => ({ import_batch_id: BATCH, status: 'done' })),
  ...Array.from({ length: total - done }, () => ({ import_batch_id: BATCH, status: 'todo' })),
]

test.describe('tasks import-batch group contract @desktop', () => {
  test('PENDING: 24 row chưa done + members 25 (1 done) → 1 group, badge 1/25 TOÀN batch, children/taskIds = 24 đang thấy', () => {
    const viewRows = Array.from({ length: 24 }, (_, i) => row(`t-${i}`, 'todo', `Store ${i}`))
    const [g] = buildImportBatchGroups(viewRows, members(1, 25))
    expect(g.type).toBe('import_batch')
    expect(g.batchId).toBe(BATCH)
    expect(g.title).toBe('Kiểm kê quý 3')
    expect(g.total).toBe(25)                     // badge TOÀN batch
    expect(g.done).toBe(1)                       // 1/25
    expect(g.childTasks).toHaveLength(24)        // pending view: chỉ chưa done
    expect(g.taskIds).toHaveLength(24)           // chọn đúng cái đang thấy
    expect(g.childTasks[0].stores).toEqual({ name: 'Store 0' })
    expect(g.childTasks[0].assignee).toBeNull()  // store-level
  })

  test('DONE view: children chỉ task done; badge vẫn 1/25', () => {
    const [g] = buildImportBatchGroups([row('t-done', 'done', 'Store X')], members(1, 25))
    expect(g.childTasks).toHaveLength(1)
    expect(g.childTasks[0].status).toBe('done')
    expect(g.childTasks[0].completed_at).not.toBeNull()
    expect(g.total).toBe(25)
    expect(g.done).toBe(1)
  })

  test('FILTER STORE (subset): members đã mirror filter → badge + children chỉ store đó', () => {
    // page mirror filter vào query members → members chỉ còn 1 row của store lọc
    const [g] = buildImportBatchGroups(
      [row('t-5', 'todo', 'Store 5')],
      [{ import_batch_id: BATCH, status: 'todo' }],
    )
    expect(g.total).toBe(1)
    expect(g.done).toBe(0)
    expect(g.childTasks).toHaveLength(1)
  })

  test('r1 P1#1 (+P1 27/07) groupModeActive: role folding GOM ở MỌI status sub-filter + pending mặc định + done; flat khi assignee/archive/staff', () => {
    // Hàm KHÔNG nhận status/view — todo/in_progress/overdue không thể tắt group
    // (chính là bug 25 dòng ở màn "Chờ thực hiện"); page dùng CHÍNH hàm này.
    // Hotfix P1 27/07: mở rộng sm/store_manager (matrix đầy đủ ở
    // tasks-effective-status.spec).
    expect(groupModeActive({ role: 'admin', showArchived: false, userFilter: false })).toBe(true)
    expect(groupModeActive({ role: 'admin', showArchived: false, userFilter: true })).toBe(false)  // assignee → flat
    expect(groupModeActive({ role: 'admin', showArchived: true, userFilter: false })).toBe(false)  // archive → flat
    expect(groupModeActive({ role: 'staff', showArchived: false, userFilter: false })).toBe(false) // staff → flat
  })

  test('r1 P1#2 members query LỖI (null) → total/done = null ("—/—"), KHÔNG suy đoán từ subset đang thấy', () => {
    // Batch thật 1 done/25 nhưng màn Pending chỉ thấy 24 dòng — suy đoán sẽ ra
    // "0/24" (tín hiệu nghiệp vụ SAI). Contract: null → UI "—/—" + chú thích.
    const viewRows = [row('a', 'todo', 'S1'), row('b', 'todo', 'S2')]
    const [gErr] = buildImportBatchGroups(viewRows, null)
    expect(gErr.total).toBeNull()
    expect(gErr.done).toBeNull()
    expect(gErr.childTasks).toHaveLength(2)  // children vẫn hiển thị + link được
    expect(gErr.taskIds).toHaveLength(2)
    // members non-null nhưng THIẾU batch (kết quả không nhất quán) → cũng null
    const [gMiss] = buildImportBatchGroups(viewRows, [{ import_batch_id: 'batch-khac', status: 'todo' }])
    expect(gMiss.total).toBeNull()
    expect(gMiss.done).toBeNull()
  })

  test('r1.1 P1#1 sliceGroupPage: >15 group → trang 2 CÓ dữ liệu; mỗi group đúng 1 lần trên đúng 1 trang; page vượt biên → clamp', () => {
    // Mô phỏng in_progress/overdue có 20 group (dataset ĐÃ GỘP TOÀN BỘ trước
    // khi cắt — page dùng chính hàm này nên gate page===1 cũ không thể tái diễn).
    const groups = Array.from({ length: 20 }, (_, i) => ({ batchId: `g-${i}` }))
    const p1 = sliceGroupPage(groups, 1, 15)
    const p2 = sliceGroupPage(groups, 2, 15)
    expect(p1.pageItems).toHaveLength(15)
    expect(p2.pageItems).toHaveLength(5)                 // trang 2 KHÔNG rỗng
    expect(p1.totalPages).toBe(2)
    const ids = [...p1.pageItems, ...p2.pageItems].map((g) => g.batchId)
    expect(new Set(ids).size).toBe(20)                   // không lặp, không mất
    expect(sliceGroupPage(groups, 99, 15).clampedPage).toBe(2)  // clamp biên
    expect(sliceGroupPage(groups, 0, 15).clampedPage).toBe(1)
    expect(sliceGroupPage([], 1, 15)).toEqual({ pageItems: [], totalPages: 1, clampedPage: 1 })
  })

  test('r1.1 P1#2 groupStoreCountLabel: total null → "đang hiển thị", KHÔNG suy đoán tổng cửa hàng', () => {
    expect(groupStoreCountLabel(25, 24)).toBe('25 cửa hàng')
    expect(groupStoreCountLabel(null, 24)).toBe('24 cửa hàng đang hiển thị')
    expect(groupStoreCountLabel(null, 24)).not.toContain('25')
  })

  test('2 batch khác nhau → 2 group riêng; batch không có viewRow → không render', () => {
    const other = row('x-1', 'todo', 'Store Y', { import_batch_id: 'batch-khac', title: 'Trưng bày hè' })
    const groups = buildImportBatchGroups(
      [row('t-1', 'todo', 'S1'), other],
      [...members(0, 25), { import_batch_id: 'batch-khac', status: 'todo' }],
    )
    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.batchId).sort()).toEqual(['batch-e19', 'batch-khac'])
    expect(buildImportBatchGroups([], members(1, 25))).toHaveLength(0)
  })
})
