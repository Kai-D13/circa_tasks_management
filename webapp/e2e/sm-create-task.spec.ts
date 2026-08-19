import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import {
  canCreateRecurring, canCreateTask, canImportExcel, smVisibilityAllowed,
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

  test("SM KHÔNG được đặt visibility 'public' (task lọt ra toàn công ty)", () => {
    // tasks_select_staff cho 'public' KHÔNG kèm điều kiện cửa hàng ⇒ mọi staff
    // đọc được. Form chỉ gửi store/private nên luật này chỉ chạm payload giả.
    expect(smVisibilityAllowed('store')).toBe(true)
    expect(smVisibilityAllowed('private')).toBe(true)
    expect(smVisibilityAllowed('public')).toBe(false)
    expect(smVisibilityAllowed(undefined)).toBe(false)
    expect(smVisibilityAllowed('bogus')).toBe(false)
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

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE RUNTIME (108.4)
//
// Contract thuần ở trên không chứng minh được UI đã nối. Bài học 4b: 493 test
// xanh vẫn lọt một nhánh vai trò chưa hề được wire. Ở đây kiểm màn hình thật:
// ai thấy nút, SM thấy đúng những cửa hàng nào, và SM KHÔNG thấy gì.
// ─────────────────────────────────────────────────────────────────────────────
import { MANAGER_STATE, SM_STATE, STAFF_STATE, SUPER_STATE } from './authState'

const CRED = {
  sm: { email: process.env.E2E_SM_EMAIL, password: process.env.E2E_SM_PASSWORD },
  staff: { email: process.env.E2E_STAFF_EMAIL, password: process.env.E2E_STAFF_PASSWORD },
  qlch: { email: process.env.E2E_QLCH_EMAIL, password: process.env.E2E_QLCH_PASSWORD },
  super: { email: process.env.E2E_SUPER_EMAIL, password: process.env.E2E_SUPER_PASSWORD },
}

// Đọc `main` chỉ sau khi nội dung đã render (bẫy timing đã trị ở 107.3).
async function mainReady(page: import('@playwright/test').Page) {
  // 20s: /tasks/new của admin nạp TOÀN BỘ user công ty nên render chậm hơn hẳn
  // các màn khác; mặc định 5s của expect.poll đủ cho SM nhưng không đủ cho admin.
  await expect.poll(
    async () => (await page.locator('main').innerText()).trim().length,
    { timeout: 20_000, message: 'main vẫn rỗng — trang chưa render xong' },
  ).toBeGreaterThan(50)
  return page.locator('main').innerText()
}

test.describe('SM thấy nút Tạo Task @desktop', () => {
  test.use({ storageState: SM_STATE })
  test.skip(!CRED.sm.email || !CRED.sm.password, 'E2E_SM_* chưa set')

  test('nút "Tạo Task" hiện trên /tasks', async ({ page }) => {
    await page.goto('/tasks')
    await mainReady(page)
    await expect(page.getByRole('link', { name: /Tạo Task/i }).first()).toBeVisible()
  })

  test('/tasks/new mở được; CHỈ hiện cửa hàng được phân công', async ({ page }) => {
    await page.goto('/tasks/new')
    await mainReady(page)
    // Không bị đẩy về /tasks
    expect(page.url()).toContain('/tasks/new')

    // Phạm vi quản lý của SM đọc từ chính màn /targets (nguồn độc lập với form).
    await page.goto('/targets')
    await mainReady(page)
    const scopeChips = await page.locator('main').innerText()

    await page.goto('/tasks/new')
    await mainReady(page)
    // Mở phạm vi "Nhiều cửa hàng" để lộ danh sách checkbox store.
    const multi = page.getByText('Nhiều cửa hàng', { exact: false }).first()
    if (await multi.count() > 0) await multi.click().catch(() => {})
    const formText = await page.locator('main').innerText()

    // Mọi cửa hàng xuất hiện trong form phải nằm trong phạm vi SM. Lấy tên
    // store dạng "CIRCA ..." để so — đủ đặc trưng trong dữ liệu thật.
    const inForm = [...formText.matchAll(/CIRCA [A-ZĐÀ-Ỹ0-9 ]+/g)].map((m) => m[0].trim())
    test.skip(inForm.length === 0, 'không đọc được tên cửa hàng trong form')
    for (const name of new Set(inForm)) {
      expect(scopeChips, `form hiện cửa hàng NGOÀI phạm vi SM: ${name}`).toContain(name)
    }
  })

  test('SM KHÔNG có Định kỳ, KHÔNG có import Excel, KHÔNG vào /tasks/schedules', async ({ page }) => {
    await page.goto('/tasks/new')
    const body = await mainReady(page)
    expect(body, 'SM không được thấy loại task Định kỳ').not.toContain('Định kỳ')
    // Nhắm ĐÚNG panel Excel-split. Không dùng chuỗi 'excel' trần: help-text của
    // ô đính kèm có nhắc "file excel, pdf..." một cách hợp lệ.
    expect(body, 'SM không được thấy panel chia file Excel')
      .not.toContain('Chia file Excel theo cửa hàng')

    // Ép ?mode=recurring cũng không mở được luồng định kỳ.
    await page.goto('/tasks/new?mode=recurring')
    const forced = await mainReady(page)
    expect(forced).not.toContain('Định kỳ')

    await page.goto('/tasks/schedules')
    await expect.poll(() => page.url()).not.toContain('/tasks/schedules')
  })
})

for (const [label, state, cred] of [
  ['Staff', STAFF_STATE, CRED.staff],
  ['QLCH', MANAGER_STATE, CRED.qlch],
] as const) {
  test.describe(`${label} KHÔNG được tạo task @desktop`, () => {
    test.use({ storageState: state })
    test.skip(!cred.email || !cred.password, 'credential chưa set')

    test('không thấy nút và bị đẩy khỏi /tasks/new', async ({ page }) => {
      await page.goto('/tasks')
      await mainReady(page)
      await expect(page.getByRole('link', { name: /Tạo Task/i })).toHaveCount(0)

      await page.goto('/tasks/new')
      await expect.poll(() => page.url(), { message: 'phải bị redirect khỏi /tasks/new' })
        .not.toContain('/tasks/new')
    })
  })
}

test.describe('Admin KHÔNG regress @desktop', () => {
  test.use({ storageState: SUPER_STATE })
  test.skip(!CRED.super.email || !CRED.super.password, 'E2E_SUPER_* chưa set')

  test('admin vẫn có Định kỳ + Excel + /tasks/schedules', async ({ page }) => {
    await page.goto('/tasks/new')
    const body = await mainReady(page)
    expect(body, 'admin phải vẫn thấy loại Định kỳ').toContain('Định kỳ')

    await page.goto('/tasks/schedules')
    await mainReady(page)
    expect(page.url()).toContain('/tasks/schedules')
  })
})
