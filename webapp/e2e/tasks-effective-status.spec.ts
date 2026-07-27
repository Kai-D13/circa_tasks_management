import { test, expect } from '@playwright/test'
import { effectiveDone, fetchedComplete } from '../lib/tasks/effectiveGroupStatus'
import { groupModeActive } from '../lib/tasks/importBatchGroups'

// Hotfix Tasks P1 (stakeholder 27/07) — unit gate contract EFFECTIVE STATUS:
// tab phân loại theo tiến độ children của group staff_all, parent DB giữ
// nguyên 'todo'. Fail-closed: stats thiếu/lỗi KHÔNG được suy luận hoàn thành.

test.describe('tasks effective group status @desktop', () => {
  test('4/4 đã nộp → effective_done=true → CHỈ nằm tab Hoàn thành (case thật a6fd6e2d: parent todo, 4/4 con done)', () => {
    expect(effectiveDone({ loaded: true, total: 4, done: 4 })).toBe(true)
    expect(effectiveDone({ loaded: true, total: 3, done: 3 })).toBe(true)
    expect(effectiveDone({ loaded: true, total: 1, done: 1 })).toBe(true)
  })

  test('2/3 → false → CHỈ nằm Chờ thực hiện; resubmit 4/4→3/4 → quay lại Chờ (stats-driven, không đổi DB)', () => {
    expect(effectiveDone({ loaded: true, total: 3, done: 2 })).toBe(false)
    expect(effectiveDone({ loaded: true, total: 4, done: 3 })).toBe(false) // 1 child bị resubmit
    expect(effectiveDone({ loaded: true, total: 4, done: 0 })).toBe(false)
  })

  test('FAIL-CLOSED: stats chưa load/lỗi/cap/thiếu → KHÔNG suy luận hoàn thành (kể cả done==total); total 0 → false', () => {
    expect(effectiveDone({ loaded: false, total: 4, done: 4 })).toBe(false) // query lỗi/vượt cap
    expect(effectiveDone({ loaded: true, total: 0, done: 0 })).toBe(false)  // không xác định đủ tổng
    expect(effectiveDone(null)).toBe(false)
    expect(effectiveDone(undefined)).toBe(false)
  })

  test('r1 P1#1 fetchedComplete: nguồn phân loại KHÔNG được là subset bị cap — count phải khớp rows; count null (không exact) cũng fail-closed', () => {
    expect(fetchedComplete(106, 106)).toBe(true)
    expect(fetchedComplete(0, 0)).toBe(true)
    expect(fetchedComplete(500, 499)).toBe(false)   // bị cap cắt → ErrorState, không phân loại
    expect(fetchedComplete(2500, 2000)).toBe(false) // vượt cap cũ 2000 → phải fail-visible
    expect(fetchedComplete(null, 100)).toBe(false)  // không yêu cầu exact count → fail-closed
    expect(fetchedComplete(undefined, 100)).toBe(false)
  })

  test('groupModeActive (mở rộng P1): admin/sm/store_manager GOM; staff/không-role flat; archive/assignee flat', () => {
    for (const role of ['admin', 'sm', 'store_manager']) {
      expect(groupModeActive({ role, showArchived: false, userFilter: false })).toBe(true)
    }
    expect(groupModeActive({ role: 'staff', showArchived: false, userFilter: false })).toBe(false)
    expect(groupModeActive({ role: null, showArchived: false, userFilter: false })).toBe(false)
    expect(groupModeActive({ role: 'admin', showArchived: true, userFilter: false })).toBe(false)
    expect(groupModeActive({ role: 'sm', showArchived: false, userFilter: true })).toBe(false)
  })
})
