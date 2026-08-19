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

  test('tasks_insert_sm GHIM TỪNG CỘT — chặn cả đường gọi PostgREST trực tiếp', () => {
    // Đây là P0 của vòng audit: policy chỉ kiểm role + created_by + store thì
    // một SM bỏ qua server action vẫn tạo được task 'public' / 'done' /
    // assigned_to người ngoài / gắn vào broadcast của người khác.
    const i = code.indexOf('CREATE POLICY "tasks_insert_sm"')
    const body = code.slice(i, code.indexOf(';', i))
    for (const pin of [
      "visibility = 'store'",          // không cho 'public' (mọi staff đọc)
      'assigned_to IS NULL',           // không giao đích danh người ngoài store
      'parent_task_id IS NULL',
      "assignment_mode = 'store'",
      "status = 'todo'",               // không tạo task đã hoàn thành
      "source_type = 'task'",          // không mạo danh nguồn hệ thống
      'broadcast_id IS NOT NULL',
      'public.is_own_sm_broadcast(broadcast_id)',
      'public.is_sm_for_store(store_id)',
      'created_by = (select auth.uid())',
    ]) {
      expect(body, `tasks_insert_sm thiếu ràng buộc: ${pin}`).toContain(pin)
    }
  })

  test('helper broadcast là SECURITY DEFINER (chặn vòng RLS tasks↔task_broadcasts)', () => {
    // Policy của task_broadcasts (045) tham chiếu tasks; nếu policy tasks lại
    // subquery thẳng task_broadcasts thì đúng hình dạng A↔B đã gây 2 sự cố prod.
    const i = code.indexOf('CREATE OR REPLACE FUNCTION public.is_own_sm_broadcast')
    expect(i, 'thiếu helper is_own_sm_broadcast').toBeGreaterThan(-1)
    const fn = code.slice(i, code.indexOf('$fn$;', i))
    expect(fn).toContain('SECURITY DEFINER')
    expect(fn).toContain('SET search_path = public')
    // và policy KHÔNG được đọc thẳng bảng
    const pi = code.indexOf('CREATE POLICY "tasks_insert_sm"')
    expect(code.slice(pi, code.indexOf(';', pi)))
      .not.toContain('FROM public.task_broadcasts')
  })

  test('storage: dựng lại từ 064 (BẢN MỚI NHẤT), không đánh rơi quyền nào', () => {
    // Bản nháp đầu dựng lại policy từ 033 — nhưng 033 đã bị 039 rồi 064 định
    // nghĩa lại. Chạy nó lên production sẽ ÂM THẦM XOÁ: staff nộp ảnh cho task
    // cấp cửa hàng (039) và admin upload ảnh Bảng tin (064). Test khoá đủ BỐN
    // nhánh để lỗi đó không lặp lại.
    const i = code.indexOf('CREATE POLICY task_uploads_insert ON storage.objects')
    expect(i, 'thiếu policy storage (hoặc còn dùng dạng tên có ngoặc kép của 033)')
      .toBeGreaterThan(-1)
    const body = code.slice(i)

    // (1) tasks/ — 039: staff + store_manager nộp kết quả task cấp cửa hàng
    expect(body).toContain("(storage.foldername(name))[1] = 'tasks'")
    expect(body, 'MẤT quyền staff/store_manager nộp task cấp cửa hàng (039)')
      .toContain("u.role IN ('staff', 'store_manager')")
    expect(body).toContain("t.assignment_mode = 'store'")
    // (2) task-inputs/ — admin giữ nguyên, SM thêm nhưng chặn 'import'
    expect(body).toContain("(storage.foldername(name))[1] = 'task-inputs'")
    expect(body).toContain("u.role = 'admin'")
    expect(body).toContain("u.role = 'sm'")
    expect(body).toContain("<> 'import'")
    // (3) prescriptions/
    expect(body).toContain("(storage.foldername(name))[1] = 'prescriptions'")
    // (4) announcement_assets/ — 064
    expect(body, 'MẤT quyền admin upload ảnh Bảng tin (064)')
      .toContain("(storage.foldername(name))[1] = 'announcement_assets'")
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
    // KHÔNG skip khi không đọc được: đây là coverage phạm vi — im lặng bỏ qua
    // thì báo cáo vẫn xanh trong khi thứ quan trọng nhất chưa hề được kiểm.
    expect(inForm.length, 'không đọc được tên cửa hàng nào trong form ⇒ test vô nghĩa, phải sửa selector')
      .toBeGreaterThan(0)
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

  test('SM KHÔNG có scope "Một CH" (tạo task đơn lẻ vẫn admin-only)', async ({ page }) => {
    await page.goto('/tasks/new')
    await mainReady(page)
    await expect(page.getByRole('button', { name: 'Một CH', exact: true }),
      'SM không được thấy scope Một CH').toHaveCount(0)
    // và phải có sẵn hai lựa chọn broadcast
    await expect(page.getByRole('button', { name: 'Nhiều CH', exact: true })).toHaveCount(1)
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

// ─────────────────────────────────────────────────────────────────────────────
// WRITE-PATH QA (108.7) — GHI THẬT, STAFF ĐỌC THẬT, DỌN CÓ BẰNG CHỨNG
//
// ⚠ OPT-IN E2E_SM_WRITE_QA=1 — DB PRODUCTION. Trước khi bật phải TẠM TẮT cron
// `teams-dispatch`: action enqueue teams_notification_events, cron chạy kịp là
// Teams bắn thông báo thật trước khi kịp dọn.
//
// Ba thứ bản trước làm sai, nay sửa:
//  1. "Staff thấy task" chỉ kiểm bằng SERVICE ROLE — mà service role BYPASS
//     RLS, nên nó không chứng minh gì về quyền đọc. Nay mở context Staff thật.
//  2. Mọi lệnh Supabase đều bỏ qua `error`. Đọc ID lỗi ⇒ taskIds rỗng ⇒
//     `finally` không xoá gì mà vẫn báo sạch; `left` null bị đọc thành 0 ⇒ in
//     VERIFIED=true trong khi dữ liệu QA còn nằm trong production.
//  3. Không kiểm broadcast và Teams outbox sau khi dọn.
// ─────────────────────────────────────────────────────────────────────────────
const WRITE_QA = process.env.E2E_SM_WRITE_QA === '1'

// Mọi truy vấn phải NỔ khi lỗi — im lặng ở đây nghĩa là dữ liệu thật bị bỏ lại.
function must<T>(res: { data: unknown; error: { message?: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what} lỗi: ${res.error.message ?? JSON.stringify(res.error)}`)
  if (res.data === null || res.data === undefined) throw new Error(`${what}: không có dữ liệu trả về`)
  return res.data as T
}

type TaskRowQA = {
  id: string; store_id: string; broadcast_id: string | null; created_by: string
  visibility: string; assignment_mode: string; status: string; source_type: string
}

test.describe('SM write-path @desktop', () => {
  test.use({ storageState: SM_STATE })
  test.skip(!CRED.sm.email || !CRED.sm.password, 'E2E_SM_* chưa set')

  test('SM tạo broadcast THẬT → Staff đọc được → dọn sạch có bằng chứng', async ({ page, browser }) => {
    if (!WRITE_QA) {
      // eslint-disable-next-line no-console
      console.log('SM_WRITE_QA_VERIFIED=false — chưa bật E2E_SM_WRITE_QA=1 (ghi vào DB production)')
      test.info().annotations.push({
        type: 'runtime-unverified',
        description: 'SM_WRITE_QA_VERIFIED=false — luồng GHI của SM chưa có bằng chứng runtime',
      })
      test.skip(true, 'SM_WRITE_QA_VERIFIED=false — bật E2E_SM_WRITE_QA=1 để chạy (ghi DB thật)')
      return
    }
    test.setTimeout(300_000)

    const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    expect(Boolean(supaUrl && supaKey), 'thiếu SUPABASE env để dọn dữ liệu QA').toBe(true)
    const { createClient } = await import('@supabase/supabase-js')
    const db = createClient(supaUrl as string, supaKey as string, { auth: { persistSession: false } })

    // ── Cửa hàng phải GIAO NHAU giữa phạm vi SM và store của tài khoản Staff,
    //    nếu không thì "Staff đọc được" là câu hỏi không thể trả lời.
    const smRow = must<{ id: string }>(await db.from('users').select('id').eq('email', CRED.sm.email as string).single(), 'đọc SM')
    const staffRow = must<{ id: string; store_id: string }>(await db.from('users').select('id, store_id').eq('email', CRED.staff.email as string).single(), 'đọc Staff')
    const assigned = must<{ store_id: string }[]>(await db.from('sm_store_assignments').select('store_id').eq('sm_user_id', smRow.id), 'đọc phân công SM')
    const scope = new Set(assigned.map((a) => a.store_id))
    expect(scope.has(staffRow.store_id),
      `cửa hàng của Staff QA (${staffRow.store_id}) KHÔNG nằm trong phạm vi SM ⇒ không kiểm được quyền đọc. Đổi tài khoản QA hoặc phân công lại.`)
      .toBe(true)
    const store = must<{ id: string; name: string; is_active: boolean; store_type: string }>(await db.from('stores')
      .select('id, name, is_active, store_type').eq('id', staffRow.store_id).single(), 'đọc cửa hàng')
    expect(store.is_active === true && store.store_type === 'os',
      'cửa hàng QA phải là OS đang hoạt động thì form mới liệt kê').toBe(true)

    const title = `[QA-SM] tự động ${Date.now()}`
    let taskIds: string[] = []
    let broadcastIds: string[] = []

    try {
      // Form khôi phục BẢN NHÁP đã lưu sau lần render đầu. Nếu còn nháp cũ, nó
      // ghi đè lựa chọn vừa tick và submit im lặng không đi (lượt trước: snapshot
      // hiện "Chọn cửa hàng (0 đã chọn)" dù test đã check). Xoá nháp trước.
      await page.addInitScript(() => { try { localStorage.clear() } catch { /* ignore */ } })
      await page.goto('/tasks/new')
      await mainReady(page)

      // Tick ĐÚNG cửa hàng giao nhau, không phải "ô đầu tiên".
      const box = page.locator('label', { hasText: store.name as string })
        .locator('input[type="checkbox"]').first()
      const found = await box.waitFor({ state: 'visible', timeout: 10_000 })
        .then(() => true).catch(() => false)
      expect(found, `không tìm thấy ô chọn cho cửa hàng "${store.name}" trong form`).toBe(true)
      // ⚠ Click TRƯỚC khi React hydrate thì trình duyệt tự toggle ô, nhưng
      // onChange chưa gắn ⇒ state vẫn rỗng và input KHÔNG bao giờ được render
      // lại (nó là controlled: checked = selectedStoreIds.includes(id)). Triệu
      // chứng đúng như lượt trước: snapshot hiện checkbox [checked] mà bộ đếm
      // vẫn "(0 đã chọn)", rồi submit đứng im. Click lại tới khi STATE nhận.
      const counter1 = page.getByText('Chọn cửa hàng (1 đã chọn)')
      for (let i = 0; i < 6; i++) {
        if (await counter1.count() > 0) break
        await box.click()
        await page.waitForTimeout(500)
      }
      await expect(counter1,
        'state không nhận lựa chọn cửa hàng dù đã click nhiều lần (hydrate hỏng?)')
        .toBeVisible({ timeout: 5_000 })

      // Ô tiêu đề chỉ có PLACEHOLDER, không có <label> — getByLabel không khớp
      // và `fill` chờ tới hết timeout (lượt trước treo đúng 300s ở đây).
      await page.getByPlaceholder(/Tiêu đề task/i).first().fill(title)
      // Output cần nộp là BẮT BUỘC. Nhãn thật là 'Ghi chú' (không phải 'Văn
      // bản' như bản trước đoán), và nút là toggle nên phải KIỂM trạng thái sau
      // khi bấm, không bấm mù.
      const noteOut = page.getByRole('button', { name: 'Ghi chú', exact: true }).first()
      await expect(noteOut, 'không thấy nút output "Ghi chú"').toBeVisible({ timeout: 10_000 })
      for (let i = 0; i < 4; i++) {
        const cls = (await noteOut.getAttribute('class')) ?? ''
        if (cls.includes('bg-primary')) break
        await noteOut.click()
        await page.waitForTimeout(300)
      }
      expect((await noteOut.getAttribute('class')) ?? '',
        'không bật được output "Ghi chú"').toContain('bg-primary')

      // Bắt đầu + Hạn chót là input `required`. Bỏ trống thì TRÌNH DUYỆT chặn
      // submit bằng bong bóng native — không có toast, không có dòng nào trong
      // DOM, nên poll chỉ thấy 'pending' và ta tưởng action hỏng.
      const ymd = (offsetDays: number) =>
        new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10)
      const dateInputs = page.locator('input[type="date"]:visible')
      const timeInputs = page.locator('input[type="time"]:visible')
      expect(await dateInputs.count(), 'không thấy ô ngày Bắt đầu/Hạn chót').toBeGreaterThanOrEqual(2)
      await dateInputs.nth(0).fill(ymd(0))
      await timeInputs.nth(0).fill('08:00')
      await dateInputs.nth(1).fill(ymd(1))
      await timeInputs.nth(1).fill('17:00')

      await expect(page.getByPlaceholder(/Tiêu đề task/i).first()).toHaveValue(title)

      const toast = page.locator('[data-sonner-toast]')
      // ⚠ Nhãn nút ĐỔI theo số cửa hàng đã chọn: 0 → 'Tạo Task', 1 → 'Tạo 1
      // Task'. Locator cũ /^Tạo Task$/ khớp KHÔNG GÌ sau khi tick, và click()
      // chờ actionability tới hết test-timeout 300s (không phải 30s của poll).
      const submitBtn = page.getByRole('button', { name: /^Tạo( \d+)? Task$/i }).last()
      await expect(submitBtn, 'không thấy nút submit').toBeVisible({ timeout: 10_000 })
      await submitBtn.click()
      // Poll trả về LÝ DO khi có, để lần đỏ sau còn chẩn đoán được: toast, hoặc
      // dòng validate inline, thay vì chỉ 'pending' câm.
      await expect.poll(async () => {
        if (!page.url().includes('/tasks/new')) return 'ok'
        if (await toast.count() > 0) return await toast.first().innerText()
        const body = await page.locator('main').innerText()
        // Tách dòng bằng String.fromCharCode(10): escape trong chuỗi đã hai lần
        // bị tầng script nuốt thành ký tự thật ở repo này.
        const line = body.split(String.fromCharCode(10)).find((l) => l.includes('Vui lòng'))
        return line ? `validate: ${line}` : 'pending'
      }, { timeout: 30_000, message: 'submit không đi và không có thông báo nào' }).not.toBe('pending')
      const errText = (await toast.count()) > 0 ? await toast.first().innerText() : ''
      // eslint-disable-next-line no-console
      console.log(`submit → url=${page.url()} | toast=${JSON.stringify(errText)}`)
      expect(errText, `tạo task lỗi — nếu là lỗi quyền thì migration 108 CHƯA chạy: ${errText}`)
        .not.toMatch(/quyền|policy|row-level|permission/i)

      // ── Bằng chứng GHI ───────────────────────────────────────────────────
      const rows = must<TaskRowQA[]>(await db.from('tasks')
        .select('id, store_id, broadcast_id, created_by, visibility, assignment_mode, status, source_type')
        .eq('title', title).eq('created_by', smRow.id), 'đọc task vừa tạo')
      taskIds = rows.map((r) => r.id)
      broadcastIds = [...new Set(rows.map((r) => r.broadcast_id).filter(Boolean))] as string[]
      expect(taskIds.length,
        `không tìm thấy task nào vừa tạo trong DB — url=${page.url()} toast=${JSON.stringify(errText)}`)
        .toBeGreaterThan(0)
      for (const r of rows) {
        expect(r.visibility).toBe('store')
        expect(r.assignment_mode).toBe('store')
        expect(r.status).toBe('todo')
        expect(r.source_type).toBe('task')
        expect(r.broadcast_id, 'task phải thuộc một broadcast').toBeTruthy()
        expect(scope.has(r.store_id), `task rơi vào store NGOÀI phạm vi SM: ${r.store_id}`).toBe(true)
      }

      // ── Bằng chứng ĐỌC: context Staff THẬT, đi qua RLS ───────────────────
      const staffCtx = await browser.newContext({ storageState: STAFF_STATE })
      try {
        const sp = await staffCtx.newPage()
        await sp.goto(`${process.env.E2E_BASE_URL ?? 'http://localhost:3010'}/tasks`)
        await expect(sp.getByText(title).first(),
          'Staff của chính cửa hàng đó KHÔNG đọc được task ⇒ RLS chặn nhầm')
          .toBeVisible({ timeout: 30_000 })
      } finally {
        await staffCtx.close()
      }
    } finally {
      // ── DỌN: phục hồi ID cả khi bước đọc phía trên đã đỏ ─────────────────
      if (taskIds.length === 0) {
        const rec = await db.from('tasks').select('id, broadcast_id')
          .eq('title', title).eq('created_by', smRow.id)
        if (rec.error) throw new Error(`không phục hồi được ID để dọn: ${rec.error.message}`)
        taskIds = (rec.data ?? []).map((r: { id: string }) => r.id)
        broadcastIds = [...new Set((rec.data ?? []).map((r: { broadcast_id: string | null }) => r.broadcast_id).filter(Boolean))] as string[]
      }
      if (taskIds.length > 0) {
        const d = await db.from('tasks').delete().in('id', taskIds)
        if (d.error) throw new Error(`xoá task QA lỗi: ${d.error.message}`)
      }
      if (broadcastIds.length > 0) {
        const d = await db.from('task_broadcasts').delete().in('id', broadcastIds)
        if (d.error) throw new Error(`xoá broadcast QA lỗi: ${d.error.message}`)
      }
      // Bằng chứng SẠCH — bốn bảng, error kiểm tường minh.
      const leftTasks = must<{ id: string }[]>(await db.from('tasks').select('id').eq('title', title), 'kiểm task còn sót')
      expect(leftTasks.length, 'CÒN SÓT task QA trong production').toBe(0)
      if (broadcastIds.length > 0) {
        const leftB = must<{ id: string }[]>(await db.from('task_broadcasts').select('id').in('id', broadcastIds), 'kiểm broadcast còn sót')
        expect(leftB.length, 'CÒN SÓT broadcast QA trong production').toBe(0)
      }
      if (taskIds.length > 0) {
        // task_id có ON DELETE CASCADE — nhưng KIỂM chứ không tin.
        const leftT = must<{ id: string }[]>(await db.from('teams_notification_events').select('id').in('task_id', taskIds),
          'kiểm Teams outbox còn sót')
        expect(leftT.length, 'CÒN SÓT bản ghi Teams outbox — Teams có thể bắn thông báo QA').toBe(0)
        const leftN = must<{ id: string }[]>(await db.from('notifications').select('id').in('task_id', taskIds),
          'kiểm notifications còn sót')
        expect(leftN.length, 'CÒN SÓT notification QA').toBe(0)
      }
      // eslint-disable-next-line no-console
      console.log(`cleanup OK: xoá ${taskIds.length} task, ${broadcastIds.length} broadcast; outbox + notifications = 0`)
    }

    // Chỉ tới đây: đã ghi, hình dạng đúng, Staff ĐỌC được, và dọn có bằng chứng.
    // eslint-disable-next-line no-console
    console.log('SM_WRITE_QA_VERIFIED=true')
  })
})
