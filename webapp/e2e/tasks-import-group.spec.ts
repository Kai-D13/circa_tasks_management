import { test, expect } from '@playwright/test'
import { buildImportBatchGroups, type ImportBatchViewRow, type ImportBatchMember } from '../lib/tasks/importBatchGroups'

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

  test('members lỗi/rỗng → fallback fail-visible: badge đếm theo subset đang thấy', () => {
    const [g] = buildImportBatchGroups(
      [row('a', 'todo', 'S1'), row('b', 'done', 'S2')],
      [],
    )
    expect(g.total).toBe(2)
    expect(g.done).toBe(1)
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
