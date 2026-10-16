import fs from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import { SUPER_STATE } from './authState'

// Nợ trước RC (PM): trạng thái của các route Tasks v2 THẬT — loading.tsx (giữ chậm request RSC điều hướng,
// không phải prefetch, nên khung chờ phải hiện), rỗng (bộ lọc không khớp ⇒ 0 dòng) và 404. CHỈ ĐỌC.
// Không có nhánh bỏ qua theo dữ liệu: thiếu link/dòng để điều hướng ⇒ FAIL.
// Lỗi truy vấn thật không tái hiện an toàn trên prod ⇒ ErrorState kiểm qua fixture (catalog v2, schedules-v2).
// /tasks/schedules(+[id]) kiểm trong ui-v2-schedules.spec.ts.

const UUID = /^\/tasks\/([0-9a-f-]{36})$/
const FAKE = '00000000-0000-4000-8000-00000000abcd'

type Hold = { on: boolean; prefetched: Map<string, number> }

// Giữ chậm request RSC điều hướng (không phải prefetch) của các path khớp — khi `on`. Request prefetch đi qua
// route.fetch + fulfill để biết lúc HOÀN TẤT (đếm theo pathname) — prefetch() bên dưới chờ trên số đếm này.
async function holdRsc(page: Page, match: (pathname: string) => boolean): Promise<Hold> {
  const state: Hold = { on: false, prefetched: new Map() }
  await page.route((u) => match(u.pathname), async (route) => {
    const h = route.request().headers()
    if (h['rsc'] === '1' && h['next-router-prefetch']) {
      const res = await route.fetch()
      await route.fulfill({ response: res })
      const p = new URL(route.request().url()).pathname
      state.prefetched.set(p, (state.prefetched.get(p) ?? 0) + 1)
      return
    }
    if (state.on && h['rsc'] === '1') await new Promise((r) => setTimeout(r, 2500))
    await route.continue()
  })
  return state
}

// Task thường (không phải nhóm): task đơn tab Chờ → tab Hoàn thành → task con của nhóm broadcast đầu tiên
// (như ui-v2-task-detail.spec.ts). Không nguồn nào có ⇒ FAIL.
async function pickNormal(page: Page): Promise<string> {
  const id = (h: string | null) => h?.match(/\/tasks\/([0-9a-f-]{36})/)?.[1] ?? null
  for (const url of ['/tasks', '/tasks?view=done']) {
    await page.goto(url)
    await page.locator('main h1').first().waitFor()
    await page.waitForLoadState('networkidle')
    const hrefs = await page.locator('tbody tr:not([data-group-type]) a[href^="/tasks/"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')))
    const found = hrefs.map(id).find(Boolean)
    if (found) return found
  }
  await page.goto('/tasks')
  await page.locator('tr[data-group-type="broadcast"] td[data-group-col="title"]').first().click()
  const child = id(await page.locator('tbody tr:not([data-group-type]) a[href^="/tasks/"]').first().getAttribute('href', { timeout: 10_000 }))
  expect(child, 'không tìm được task thường nào (tab Chờ, Hoàn thành, task con broadcast)').not.toBeNull()
  return child!
}

async function expectLoading(page: Page, marker: string) {
  const l = page.locator(`[data-route-loading="${marker}"]`)
  await expect(l, `loading ${marker} không hiện`).toBeVisible({ timeout: 2_000 })
  await expect(l).toHaveAttribute('data-ui-v2', 'page')
}

// Điều hướng phía client bằng router của app (như bấm Link).
async function navigate(page: Page, href: string) {
  await page.evaluate((h) => {
    const r = (window as unknown as { next?: { router?: { push: (href: string) => void } } }).next?.router
    if (!r) throw new Error('window.next.router không có')
    r.push(h)
  }, href)
}

// Link sidebar và link task trong TaskList dùng prefetch={false} (router chưa biết ranh giới loading trước khi
// server trả) ⇒ prefetch tay qua router của app trước khi điều hướng, như link mặc định. router.prefetch không
// trả promise ⇒ chờ ĐỦ 2 phản hồi prefetch (cây segment + dữ liệu) của đúng path đã hoàn tất.
async function prefetch(page: Page, hold: Hold, href: string) {
  const before = hold.prefetched.get(href) ?? 0
  await page.evaluate((h) => {
    const r = (window as unknown as { next?: { router?: { prefetch: (href: string) => unknown } } }).next?.router
    if (!r) throw new Error('window.next.router không có')
    r.prefetch(h)
  }, href)
  await expect.poll(() => (hold.prefetched.get(href) ?? 0) - before, { message: `prefetch ${href} chưa xong`, timeout: 15_000 })
    .toBeGreaterThanOrEqual(2)
}

// Link mặc định (prefetch tự động khi vào khung nhìn): chờ prefetch tự động của path đó đã hoàn tất.
async function autoPrefetched(hold: Hold, href: string) {
  await expect.poll(() => hold.prefetched.get(href) ?? 0, { message: `link ${href} chưa tự prefetch`, timeout: 15_000 })
    .toBeGreaterThanOrEqual(2)
}

test.describe('ui v2 trạng thái route thật @desktop', () => {
  test.skip(!fs.existsSync(SUPER_STATE), 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('loading: /tasks → /tasks/[id] → /tasks/[id]/edit; /tasks → /tasks/new', async ({ page }) => {
    const hold = await holdRsc(page, (p) => p.startsWith('/tasks/'))
    await page.goto('/tasks')
    await page.locator('main h1').first().waitFor()
    await page.waitForLoadState('networkidle')
    const hrefs = await page.locator('main a[href^="/tasks/"]').evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''))
    const href = hrefs.find((h) => UUID.test(h))
    expect(href, 'không có link task nào trên /tasks').toBeTruthy()
    // Link task trong TaskList: prefetch={false} và (desktop) mở tab mới ⇒ prefetch tay + router.push của app.
    await prefetch(page, hold, href!)
    hold.on = true
    await navigate(page, href!)
    await expectLoading(page, 'task-detail')
    await expect(page.locator('main [data-detail-content]')).toBeVisible({ timeout: 15_000 })
    // Chỉnh sửa: mở chi tiết một task THƯỜNG (task cha "từng dược sĩ" có dialog hướng dẫn, không có link sửa)
    hold.on = false
    await page.goto(`/tasks/${await pickNormal(page)}`)
    await page.locator('main [data-detail-content]').waitFor()
    await page.waitForLoadState('networkidle')
    const edit = page.locator('main a[href$="/edit"]').first()
    await expect(edit, 'không thấy link Chỉnh sửa trên chi tiết task').toBeVisible()
    await autoPrefetched(hold, (await edit.getAttribute('href'))!)
    hold.on = true
    await edit.click()
    await expectLoading(page, 'task-edit')
    await expect(page.locator('main h1').first()).toHaveText('Chỉnh sửa Task', { timeout: 15_000 })
    // Tạo task (link "Tạo Task" dùng prefetch mặc định ⇒ chờ prefetch tự động xong)
    hold.on = false
    hold.prefetched.delete('/tasks/new')
    await page.goto('/tasks')
    await page.locator('main h1').first().waitFor()
    await autoPrefetched(hold, '/tasks/new')
    hold.on = true
    await page.locator('main a[href="/tasks/new"]').first().click()
    await expectLoading(page, 'task-new')
    await expect(page.locator('main h1').first()).toHaveText('Tạo task mới', { timeout: 15_000 })
  })

  test('loading: /tasks → /dashboard; /dashboard → /tasks (link sidebar)', async ({ page }) => {
    const hold = await holdRsc(page, (p) => p === '/dashboard' || p === '/tasks')
    await page.goto('/tasks')
    await page.locator('main h1').first().waitFor()
    await prefetch(page, hold, '/dashboard')
    hold.on = true
    await page.locator('aside a[href="/dashboard"]').first().click()
    await expectLoading(page, 'dashboard')
    await expect(page.getByRole('heading', { level: 1, name: 'Tổng quan' })).toBeVisible({ timeout: 15_000 })
    // /dashboard → /tasks: tải MỚI /dashboard để /tasks chưa nằm trong cache router ⇒ prefetch tay chạy thật.
    // (Lượt gate 16/10: dựa vào cây /tasks còn trong cache từ lần tải đầu thì đỏ dưới tải full suite.)
    hold.on = false
    await page.goto('/dashboard')
    await expect(page.getByRole('heading', { level: 1, name: 'Tổng quan' })).toBeVisible()
    await prefetch(page, hold, '/tasks')
    hold.on = true
    await page.locator('aside a[href="/tasks"]').first().click()
    await expectLoading(page, 'tasks')
    await expect(page.locator('main [data-ui-v2="page"] h1').first()).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('[data-route-loading]')).toHaveCount(0)
  })

  test('rỗng thật: /tasks lọc cửa hàng không tồn tại ⇒ EmptyState "thử xoá bộ lọc", không bảng', async ({ page }) => {
    await page.goto(`/tasks?store_id=${FAKE}`)
    await expect(page.locator('main [data-ui-v2="page"]')).toHaveCount(1)
    await expect(page.getByText('Không có task nào', { exact: true })).toBeVisible()
    await expect(page.getByText('Thử xoá bớt bộ lọc để xem thêm task.')).toBeVisible()
    await expect(page.locator('main table')).toHaveCount(0)
  })

  // Route có loading.tsx ⇒ phản hồi stream (HTTP 200) trước khi notFound() chạy; Next hiện UI 404 trong stream
  // (có từ trước batch: tasks/loading.tsx và schedules/loading.tsx bọc các route con) ⇒ kiểm UI, không kiểm mã.
  test('404 thật: task / lịch không tồn tại ⇒ trang "not found", không lộ khung dữ liệu', async ({ page }) => {
    for (const url of [`/tasks/${FAKE}`, `/tasks/schedules/${FAKE}`]) {
      await page.goto(url)
      await expect(page.getByText('This page could not be found.'), `${url} phải hiện trang 404`).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('main [data-detail-content], main [data-schedule-config]')).toHaveCount(0)
    }
  })
})
