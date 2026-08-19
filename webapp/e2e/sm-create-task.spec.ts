import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import {
  canCreateRecurring, canCreateTask, canImportExcel,
  validateSmStaffSelection, validateSmStoreScope,
} from '../lib/tasks/smScope'

// ─────────────────────────────────────────────────────────────────────────────
// SM tạo task broadcast (mig 108) — CONTRACT PHẠM VI + source contract migration
//
// Đây là batch mở QUYỀN GHI. Nhánh "Từng dược sĩ nộp" ghi tasks bằng service
// role nên RLS không áp; validateSmStoreScope là ranh giới bảo mật duy nhất ở
// đó. Test giả mạo payload vì vậy là bắt buộc.
// ─────────────────────────────────────────────────────────────────────────────

const A = 'store-a', B = 'store-b', X = 'store-ngoai-pham-vi'

test.describe('SM scope contract @desktop', () => {
  test('store hợp lệ → trả về danh sách đã dedupe', () => {
    expect(validateSmStoreScope([A, B], [A, B])).toEqual({ ok: true, storeIds: [A, B] })
    expect(validateSmStoreScope([A, B], [A, A, B])).toEqual({ ok: true, storeIds: [A, B] })
  })

  test('MỘT store ngoài phạm vi → từ chối TOÀN BỘ, không ghi từng phần', () => {
    const r = validateSmStoreScope([A, B], [A, X])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('ngoài phạm vi')
    // Không được "lọc rồi chạy tiếp" — không có storeIds nào lọt ra.
    expect('storeIds' in r).toBe(false)
  })

  test('thông báo lỗi KHÔNG lộ id store lạ', () => {
    const r = validateSmStoreScope([A], [X])
    if (r.ok) throw new Error('phải từ chối')
    expect(r.error).not.toContain(X)
  })

  test('SM mất hết phân công → từ chối (ca bị gỡ assignment sau khi mở form)', () => {
    const r = validateSmStoreScope([], [A])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('chưa được phân công')
  })

  test('payload rác không làm vỡ (không throw, trả lỗi sạch)', () => {
    expect(validateSmStoreScope([A], []).ok).toBe(false)
    expect(validateSmStoreScope([A], [''] as string[]).ok).toBe(false)
    expect(validateSmStoreScope([A], [null as unknown as string]).ok).toBe(false)
    expect(validateSmStoreScope([A], 'not-an-array' as unknown as string[]).ok).toBe(false)
  })

  test('selectedStaffByStore chỉ được nhắc store trong phạm vi', () => {
    expect(validateSmStaffSelection({ [A]: ['u1'] }, [A, B])).toEqual({ ok: true })
    expect(validateSmStaffSelection(undefined, [A])).toEqual({ ok: true })
    const bad = validateSmStaffSelection({ [X]: ['u1'] }, [A, B])
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain('ngoài phạm vi')
    // giá trị không phải mảng → lỗi sạch, không 500
    expect(validateSmStaffSelection({ [A]: 'u1' as unknown as string[] }, [A]).ok).toBe(false)
  })

  test('ai được tạo gì: SM chỉ phát sinh; định kỳ + Excel vẫn admin-only', () => {
    for (const role of ['admin', 'sm']) expect(canCreateTask(role), role).toBe(true)
    for (const role of ['staff', 'store_manager', null, undefined, 'bogus']) {
      expect(canCreateTask(role), String(role)).toBe(false)
    }
    expect(canCreateRecurring('admin')).toBe(true)
    expect(canCreateRecurring('sm')).toBe(false)
    expect(canImportExcel('admin')).toBe(true)
    expect(canImportExcel('sm')).toBe(false)
  })
})

// ── Source contract migration 108 ───────────────────────────────────────────
test.describe('mig 108 source contract @desktop', () => {
  const sql = fs
    .readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations',
      '108_sm_create_broadcast_task.sql'), 'utf8')
    .replace(/\r\n/g, '\n')
  const exec = sql.slice(0, sql.indexOf('\nCOMMIT;'))
  // Phần LỆNH (bỏ comment): migration CÓ nhắc tên policy admin trong chú
  // thích để giải thích vì sao admin không dính lỗi RETURNING — assert phải
  // soi lệnh, không soi chú thích.
  const code = exec.split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith('--')).join(String.fromCharCode(10))

  test('preflight đòi 107 + helper is_sm_for_store; có marker 108', () => {
    expect(exec).toContain("WHERE version = '107'")
    expect(exec).toContain('is_sm_for_store')
    expect(sql).toContain("VALUES ('108', 'sm_create_broadcast_task'")
  })

  test('ba policy: INSERT broadcast, SELECT broadcast của mình, INSERT task theo phạm vi', () => {
    for (const p of ['tb_insert_sm', 'tb_select_sm_own', 'tasks_insert_sm']) {
      expect(exec, `thiếu policy ${p}`).toContain(`CREATE POLICY "${p}"`)
    }
    // tasks_insert_sm PHẢI ràng buộc cả chủ sở hữu lẫn phạm vi cửa hàng
    const i = exec.indexOf('CREATE POLICY "tasks_insert_sm"')
    const body = exec.slice(i, exec.indexOf(';', i))
    expect(body).toContain("= 'sm'")
    expect(body).toContain('created_by = (select auth.uid())')
    expect(body).toContain('public.is_sm_for_store(store_id)')
    expect(body).toContain('store_id IS NOT NULL')
  })

  test('KHÔNG mở UPDATE/DELETE cho SM và KHÔNG đụng policy admin', () => {
    expect(code).not.toMatch(/CREATE POLICY "[a-z_]*sm[a-z_]*" ON public\.(tasks|task_broadcasts)\s+FOR (UPDATE|DELETE)/)
    for (const admin of ['tasks_insert_admin', 'tb_insert_admin', 'tb_select_admin']) {
      expect(code, `không được DROP/định nghĩa lại ${admin}`).not.toContain(admin)
    }
    expect(code).not.toMatch(/ALTER TABLE/)
  })

  test('ghi rõ nhánh service-role KHÔNG được RLS bảo vệ', () => {
    // Người đọc migration phải biết RLS không phải chốt duy nhất, nếu không họ
    // sẽ tưởng policy là đủ và bỏ qua validate ở action.
    expect(sql).toContain('SERVICE ROLE')
    expect(sql.toLowerCase()).toContain('server action')
  })
})
