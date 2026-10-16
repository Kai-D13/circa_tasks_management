import fs from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import { SM_STATE, SUPER_STATE } from './authState'

// UI v2 P1.5 /tasks/schedules + /tasks/schedules/[id].
// - Trạng thái/quyền: fixture /ui-catalog/schedules-v2?fx=… render ĐÚNG SchedulesListView/ScheduleDetailView
//   (component trình bày của route thật) với dữ liệu giả cố định ⇒ không phụ thuộc prod, không nhánh bỏ qua.
// - Route thật: có dữ liệu + loading.tsx (giữ chậm request RSC khi điều hướng client) + SM bị chuyển về /tasks.
// CHỈ ĐỌC: không bấm Tạm dừng/Kích hoạt/Xóa; dialog Chia sẻ chỉ mở rồi Escape.

const HAS_SUPER = fs.existsSync(SUPER_STATE)
const LONG_ERROR_HEAD = 'Lỗi QA giả lập: hết thời gian chờ khi tạo task cho 3 cửa hàng'
const LONG_ERROR_TAIL = 'sẽ thử lại ở lần chạy kế tiếp theo lịch.'
const ACTION = /^(Tạm dừng|Kích hoạt)$/
const ACTION_TEXT = /Tạm dừng|Kích hoạt/

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme)
}

async function openFx(page: Page, fx: string, theme?: 'light' | 'dark') {
  await page.goto(`/ui-catalog/schedules-v2?fx=${fx}`)
  if (theme) await setTheme(page, theme)
  await page.locator(`[data-testid="ui-catalog-schedules"][data-fx="${fx}"]`).waitFor({ timeout: 20_000 })
  await page.locator('main h1').first().waitFor()
}

async function sidebarOpen(page: Page, width: number, baseURL: string) {
  await page.setViewportSize({ width, height: 900 })
  await page.context().addCookies([{ name: 'sidebar_collapsed', value: '0', url: baseURL }])
}

// Trang không cuộn ngang (bảng tự cuộn trong khung của nó).
async function assertNoPageOverflow(page: Page) {
  const g = await page.evaluate(() => {
    const m = document.querySelector('main')!
    return { sw: document.documentElement.scrollWidth, iw: window.innerWidth, msw: m.scrollWidth, mcw: m.clientWidth }
  })
  expect(g.sw, 'trang cuộn ngang').toBeLessThanOrEqual(g.iw + 1)
  expect(g.msw, '<main> cuộn ngang').toBeLessThanOrEqual(g.mcw + 1)
}

const btn = (page: Page, name: string | RegExp) => page.locator('main').getByRole('button', { name, exact: typeof name === 'string' })
const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1

test.describe('ui v2 lịch định kỳ — fixture desktop @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  for (const theme of ['light', 'dark'] as const) {
    test(`danh sách 1280 sidebar mở (${theme}) — 8 cột, tên dài ≤ 2 dòng, 1 nút/dòng 32px, trang không cuộn ngang`, async ({ page }, info) => {
      await sidebarOpen(page, 1280, info.project.use.baseURL!)
      await openFx(page, 'list', theme)
      await expect(page.locator('main [data-ui-v2="page"]')).toHaveCount(1)
      const h1 = page.locator('main h1').first()
      await expect(h1).toHaveText('Task định kỳ')
      expect(await h1.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBe(22)
      expect((await page.locator('main a', { hasText: 'Tạo lịch mới' }).boundingBox())!.height).toBeCloseTo(36, 0)
      await expect(page.locator('main thead th')).toHaveText(['Tên lịch', 'Tần suất', 'Giờ chạy', 'Cửa hàng', 'Lần chạy tiếp', 'Lần cuối', 'Trạng thái', 'Thao tác'])
      const rows = page.locator('main tr[data-schedule-row]')
      await expect(rows).toHaveCount(6)
      expect(await page.locator('main [data-ui-v2] [data-slot="card"]').first().evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius))).toBe(12)
      for (let i = 0; i < 6; i++) {
        const acts = rows.nth(i).getByRole('button')
        await expect(acts).toHaveCount(1)
        await expect(acts).toHaveText(ACTION_TEXT)
        expect((await acts.boundingBox())!.height).toBeCloseTo(32, 0)
      }
      await expect(btn(page, /Xóa lịch/)).toHaveCount(0)
      await expect(page.locator('main tbody').getByText('Chưa chạy', { exact: true })).toHaveCount(2)
      // Tên 120 ký tự: tối đa 2 dòng (line-clamp), đầy đủ ở thuộc tính title
      const long = rows.nth(4).locator('a[href^="/tasks/schedules/"]')
      const m = await long.evaluate((el) => ({ h: el.clientHeight, sh: el.scrollHeight, lh: parseFloat(getComputedStyle(el).lineHeight) }))
      expect(m.h, 'tên dài vượt 2 dòng').toBeLessThanOrEqual(2 * m.lh + 1)
      expect(m.sh, 'fixture tên dài phải thực sự bị cắt ở 2 dòng').toBeGreaterThan(m.h)
      expect((await long.getAttribute('title'))!.length).toBeGreaterThanOrEqual(100)
      await assertNoPageOverflow(page)
    })
  }

  test('danh sách 1440 — bảng vừa khung, không cuộn', async ({ page }, info) => {
    await sidebarOpen(page, 1440, info.project.use.baseURL!)
    await openFx(page, 'list')
    const c = await page.locator('main [data-slot="table-container"]').evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }))
    expect(c.sw).toBeLessThanOrEqual(c.cw + 1)
    await assertNoPageOverflow(page)
  })

  test('danh sách rỗng / lỗi — đúng MỘT trạng thái, không có bảng', async ({ page }) => {
    await openFx(page, 'list-empty')
    await expect(page.locator('main').getByText('Chưa có lịch định kỳ nào.')).toBeVisible()
    await expect(page.locator('main a', { hasText: 'Tạo lịch đầu tiên' })).toHaveAttribute('href', '/tasks/new?mode=recurring')
    await expect(page.locator('main table')).toHaveCount(0)
    await openFx(page, 'list-error')
    await expect(page.locator('main').getByText('Không thể tải danh sách lịch định kỳ')).toBeVisible()
    await expect(page.locator('main').getByText('QA: lỗi giả lập khi đọc task_schedules')).toBeVisible()
    await expect(page.locator('main table')).toHaveCount(0)
    await expect(page.locator('main').getByText('Chưa có lịch định kỳ nào.')).toHaveCount(0)
  })

  for (const theme of ['light', 'dark'] as const) {
    test(`chi tiết owner 1280 sidebar mở (${theme}) — nút header bên phải không chồng tiêu đề, 2 cột, đủ 25 cửa hàng, ghi chú lỗi đọc trọn`, async ({ page }, info) => {
      await sidebarOpen(page, 1280, info.project.use.baseURL!)
      await openFx(page, 'detail-owner', theme)
      const h1 = page.locator('main h1').first()
      expect(await h1.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBe(24)
      const hb = (await h1.boundingBox())!
      const vw = page.viewportSize()!.width
      const boxes = []
      for (const name of ['Chia sẻ', 'Tạm dừng', 'Xóa lịch']) {
        const b = (await btn(page, name).boundingBox())!
        expect(b.height, `nút ${name} 36px`).toBeCloseTo(36, 0)
        expect(b.x + b.width, `nút ${name} ngoài khung`).toBeLessThanOrEqual(vw + 1)
        expect(overlap(b, hb), `nút ${name} chồng tiêu đề`).toBe(false)
        expect(b.x, `nút ${name} phải nằm bên phải tiêu đề`).toBeGreaterThanOrEqual(hb.x + hb.width - 1)
        boxes.push(b)
      }
      expect(overlap(boxes[0], boxes[1]) || overlap(boxes[1], boxes[2])).toBe(false)
      // Cấu hình lịch | Nội dung task cùng hàng
      const cfg = (await page.locator('main [data-schedule-config]').boundingBox())!
      const ctn = (await page.locator('main [data-schedule-content]').boundingBox())!
      expect(ctn.x).toBeGreaterThan(cfg.x + cfg.width)
      await expect(page.locator('main [data-schedule-config] dt')).toHaveText([
        'Chế độ giao', 'Tần suất', 'Ngày trong tuần', 'Giờ tạo task', 'Deadline sau khi tạo', 'Múi giờ',
        'Ngày bắt đầu', 'Ngày kết thúc', 'Lần chạy gần nhất', 'Lần chạy tiếp theo',
      ])
      await expect(page.locator('main [data-schedule-config] dd').nth(2).locator('span span')).toHaveText(['Thứ Hai', 'Thứ Tư', 'Thứ Sáu'])
      // Toàn bộ cửa hàng, không rút gọn "+N"
      await expect(page.locator('main [data-schedule-stores] > span')).toHaveCount(25)
      await expect(page.locator('main').getByText(/^\+\d+ cửa hàng$/)).toHaveCount(0)
      // Lịch sử chạy: 5 lần, ghi chú lỗi dài đọc trọn (không cắt)
      await expect(page.locator('main [data-schedule-runs] tbody tr')).toHaveCount(5)
      // Cột "Chi tiết" (ô cuối) — ô kết quả còn chứa bản mobile của ghi chú (ẩn ở desktop)
      const note = page.locator('main [data-schedule-runs] tbody td:last-child', { hasText: LONG_ERROR_HEAD })
      await expect(note).toBeVisible()
      await expect(note).toContainText(LONG_ERROR_TAIL)
      const nm = await note.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, ov: getComputedStyle(el).textOverflow }))
      expect(nm.ov).not.toBe('ellipsis')
      expect(nm.sw, 'ghi chú lỗi bị cắt').toBeLessThanOrEqual(nm.cw + 1)
      // Task đã tạo: 2 nhóm, nhóm đầu mở, nhóm sau đóng; mở/đóng được (chỉ UI)
      const groups = page.locator('main details[data-schedule-run-group]')
      await expect(groups).toHaveCount(2)
      expect(await groups.nth(0).evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true)
      expect(await groups.nth(1).evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false)
      await groups.nth(1).locator('summary').click()
      expect(await groups.nth(1).evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true)
      await assertNoPageOverflow(page)
    })
  }

  test('chi tiết owner 1440 — Lịch sử chạy | Task đã tạo cùng hàng; dialog Chia sẻ mở/đóng', async ({ page }, info) => {
    await sidebarOpen(page, 1440, info.project.use.baseURL!)
    await openFx(page, 'detail-owner')
    const runs = (await page.getByRole('heading', { name: 'Lịch sử chạy' }).boundingBox())!
    const recent = (await page.getByRole('heading', { name: 'Task đã tạo gần đây' }).boundingBox())!
    expect(Math.abs(runs.y - recent.y)).toBeLessThan(2)
    await assertNoPageOverflow(page)
    await btn(page, 'Chia sẻ').click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
  })

  test('ma trận quyền: editor / view / lỗi đọc quyền; trạng thái rỗng & lỗi con; lỗi truy vấn chính', async ({ page }) => {
    // editor: chỉ Tạm dừng/Kích hoạt
    await openFx(page, 'detail-editor')
    await expect(btn(page, 'Kích hoạt')).toHaveCount(1)
    await expect(btn(page, 'Chia sẻ')).toHaveCount(0)
    await expect(btn(page, /Xóa lịch/)).toHaveCount(0)
    await expect(page.locator('main [data-schedule-config]')).toContainText('Ngày 5')
    await expect(page.locator('main').getByText('Chưa có lần chạy nào')).toBeVisible()
    await expect(page.locator('main').getByText('Chưa có task nào được tạo')).toBeVisible()
    // view: không nút nào; khối lỗi con giữ nguyên, không biến thành rỗng
    await openFx(page, 'detail-view')
    for (const n of ['Chia sẻ', 'Tạm dừng', 'Kích hoạt']) await expect(btn(page, n)).toHaveCount(0)
    await expect(btn(page, /Xóa lịch/)).toHaveCount(0)
    await expect(page.locator('main').getByText('Không tải được lịch sử chạy')).toBeVisible()
    await expect(page.locator('main').getByText('Không tải được task đã tạo')).toBeVisible()
    await expect(page.locator('main').getByText('Chưa có lần chạy nào')).toHaveCount(0)
    await expect(page.locator('main').getByText('Chưa có cửa hàng nào')).toBeVisible()
    // owner nhưng đọc quyền/chia sẻ lỗi: cảnh báo + ẩn Chia sẻ, giữ Tạm dừng/Xóa
    await openFx(page, 'detail-permwarn')
    await expect(page.locator('main').getByText('Một số thông tin quyền không tải được')).toBeVisible()
    await expect(page.locator('main').getByText(/Không kiểm tra được quyền cộng tác\. Danh sách chia sẻ tạm thời không khả dụng\./)).toBeVisible()
    await expect(btn(page, 'Chia sẻ')).toHaveCount(0)
    await expect(btn(page, 'Tạm dừng')).toHaveCount(1)
    await expect(btn(page, /Xóa lịch/)).toHaveCount(1)
    // lỗi truy vấn lịch (không phải 404)
    await openFx(page, 'detail-error')
    await expect(page.locator('main h1').first()).toHaveText('Chi tiết lịch')
    await expect(page.locator('main').getByText('Không thể tải lịch định kỳ')).toBeVisible()
    await expect(page.locator('main [data-ui-v2="page"]')).toHaveCount(1)
  })
})

test.describe('ui v2 lịch định kỳ — fixture mobile @mobile', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('danh sách: bảng tự cuộn trong khung, trang không cuộn; nút tạo 44px', async ({ page }) => {
    await openFx(page, 'list')
    const c = await page.locator('main [data-slot="table-container"]').evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }))
    expect(c.sw, 'bảng phải tự cuộn ngang ở mobile').toBeGreaterThan(c.cw)
    await assertNoPageOverflow(page)
    const b = (await page.locator('main a', { hasText: 'Tạo lịch mới' }).boundingBox())!
    expect(b.height).toBeGreaterThanOrEqual(43.5)
    expect(b.x + b.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1)
  })

  test('chi tiết: nút header 44px không chồng nhau/tiêu đề; lịch sử chạy không cuộn ngang, ghi chú dưới kết quả; khối cuối đọc được', async ({ page }) => {
    await openFx(page, 'detail-owner')
    const vw = page.viewportSize()!.width
    const hb = (await page.locator('main h1').first().boundingBox())!
    const boxes = []
    for (const name of ['Chia sẻ', 'Tạm dừng', 'Xóa lịch']) {
      const b = (await btn(page, name).boundingBox())!
      expect(b.height, `nút ${name} 44px`).toBeGreaterThanOrEqual(43.5)
      expect(b.x + b.width).toBeLessThanOrEqual(vw + 1)
      expect(overlap(b, hb), `nút ${name} chồng tiêu đề`).toBe(false)
      boxes.push(b)
    }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j])).toBe(false)
    await assertNoPageOverflow(page)
    const runs = page.locator('main [data-schedule-runs]')
    const rc = await runs.evaluate((el) => ({ sw: el.parentElement!.scrollWidth, cw: el.parentElement!.clientWidth }))
    expect(rc.sw, 'bảng lịch sử chạy cuộn ngang ở mobile').toBeLessThanOrEqual(rc.cw + 1)
    await expect(runs.locator('th', { hasText: 'Chi tiết' })).toBeHidden()
    const note = runs.locator('[data-run-note]', { hasText: LONG_ERROR_HEAD })
    await expect(note).toBeVisible()
    await expect(note).toContainText(LONG_ERROR_TAIL)
    await expect(page.locator('main [data-schedule-stores] > span')).toHaveCount(25)
    // Khối cuối: cuộn tới, tâm phần tử không bị bottom nav che
    const last = page.locator('main details[data-schedule-run-group]').last().locator('summary')
    await last.scrollIntoViewIfNeeded()
    const hit = await last.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return !!at && el.contains(at)
    })
    expect(hit, 'khối cuối bị che').toBe(true)
  })
})

test.describe('ui v2 lịch định kỳ — route thật @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('danh sách + chi tiết có dữ liệu (1280 sidebar mở), owner thấy Chia sẻ/Xóa — chỉ đọc', async ({ page }, info) => {
    await sidebarOpen(page, 1280, info.project.use.baseURL!)
    await page.goto('/tasks/schedules')
    await expect(page.locator('main h1').first()).toHaveText('Task định kỳ')
    await expect(page.locator('main [data-ui-v2="page"]')).toHaveCount(1)
    const rows = page.locator('main tr[data-schedule-row]')
    expect(await rows.count(), 'prod phải có ít nhất 1 lịch định kỳ').toBeGreaterThan(0)
    for (let i = 0; i < await rows.count(); i++) await expect(rows.nth(i).getByRole('button')).toHaveText(ACTION_TEXT)
    await assertNoPageOverflow(page)
    const href = await rows.first().locator('a[href^="/tasks/schedules/"]').getAttribute('href')
    await page.goto(href!)
    await expect(page.locator('main [data-ui-v2="page"]')).toHaveCount(1)
    for (const h of ['Cấu hình lịch', 'Nội dung task', 'Lịch sử chạy', 'Task đã tạo gần đây']) {
      await expect(page.getByRole('heading', { name: h })).toBeVisible()
    }
    await expect(page.getByRole('heading', { name: /^Cửa hàng nhận task \(\d+\)$/ })).toBeVisible()
    await expect(btn(page, 'Chia sẻ')).toHaveCount(1)
    await expect(btn(page, /Xóa lịch/)).toHaveCount(1)
    await expect(btn(page, ACTION)).toHaveCount(1)
    await assertNoPageOverflow(page)
  })

  test('loading.tsx của cả 2 route hiện khi điều hướng (giữ chậm RSC) rồi ra trang', async ({ page }) => {
    let hold = false
    await page.route((u) => u.pathname.startsWith('/tasks/schedules'), async (route) => {
      const h = route.request().headers()
      if (hold && h['rsc'] === '1' && !h['next-router-prefetch']) await new Promise((r) => setTimeout(r, 2500))
      await route.continue()
    })
    await page.goto('/tasks/schedules')
    await page.locator('main tr[data-schedule-row]').first().waitFor()
    await page.waitForLoadState('networkidle')
    hold = true
    await page.locator('main tr[data-schedule-row] a[href^="/tasks/schedules/"]').first().click()
    const dl = page.locator('[data-route-loading="schedule-detail"]')
    await expect(dl, 'loading chi tiết không hiện').toBeVisible({ timeout: 2_000 })
    await expect(dl).toHaveAttribute('data-ui-v2', 'page')
    await expect(page.getByRole('heading', { name: 'Cấu hình lịch' })).toBeVisible({ timeout: 15_000 })
    await page.waitForLoadState('networkidle')
    await page.locator('main a[href="/tasks/schedules"]').first().click()
    const ll = page.locator('[data-route-loading="schedules"]')
    await expect(ll, 'loading danh sách không hiện').toBeVisible({ timeout: 2_000 })
    await expect(ll).toHaveAttribute('data-ui-v2', 'page')
    await expect(page.locator('main h1', { hasText: 'Task định kỳ' })).toBeVisible({ timeout: 15_000 })
  })
})

test.describe('ui v2 lịch định kỳ — route thật mobile @mobile', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('danh sách + chi tiết thật không cuộn ngang trang', async ({ page }) => {
    await page.goto('/tasks/schedules')
    await page.locator('main tr[data-schedule-row]').first().waitFor()
    await assertNoPageOverflow(page)
    const href = await page.locator('main tr[data-schedule-row] a[href^="/tasks/schedules/"]').first().getAttribute('href')
    await page.goto(href!)
    await expect(page.getByRole('heading', { name: 'Cấu hình lịch' })).toBeVisible()
    await assertNoPageOverflow(page)
  })
})

test.describe('ui v2 lịch định kỳ — SM bị chuyển về /tasks @desktop', () => {
  test.skip(!fs.existsSync(SM_STATE), 'chưa có phiên SM')
  test.use({ storageState: SM_STATE })

  test('SM vào danh sách hoặc chi tiết đều bị redirect /tasks', async ({ page }) => {
    // Route có loading.tsx ⇒ phản hồi stream khung chờ trước, redirect() thành điều hướng phía client sau hydrate
    // — dưới tải full suite có thể > 5 s (lượt gate 16/10 đỏ ở 5 s, chạy riêng ×2 xanh) ⇒ chờ URL tới 20 s.
    for (const url of ['/tasks/schedules', '/tasks/schedules/00000000-0000-4000-8000-000000000002']) {
      await page.goto(url)
      await page.waitForURL((u) => u.pathname === '/tasks', { timeout: 20_000 })
      expect(new URL(page.url()).pathname, `SM không được ở ${url}`).toBe('/tasks')
    }
  })
})
