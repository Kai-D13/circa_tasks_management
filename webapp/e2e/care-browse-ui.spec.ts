import fs from 'node:fs'
import path from 'node:path'
import { test, expect, request as pwRequest, type Page, type Request } from '@playwright/test'
import { SUPER_STATE, SM_STATE, MANAGER_STATE } from './authState'
import { saveLocatorShot } from './qaShot'

// CRM-CSKH B3 — UI browser Khách hàng/Chăm sóc + chuyển giao.
//
// UI chạy trên /ui-catalog/care-browse (UI_CATALOG=1 + super — Coolify không bao
// giờ đặt ⇒ prod 404) với DỮ LIỆU GIẢ + server action giả viết inline: DB chưa có
// migration 114 nên trang thật /care* chưa chạy end-to-end (B6). Component dùng
// chung với trang thật. Ảnh chụp chỉ phần nội dung (ẩn shell có tên người dùng thật)
// ⇒ lưu qa-artifacts/ (gitignored).
//
// Smoke thật (server QA, CARE_ENABLED tắt mặc định): /care* 404, sidebar không có
// nhóm "Chăm sóc KH", chưa đăng nhập ⇒ /login.

const HAS_STATE = fs.existsSync(SUPER_STATE)
const SHOTS = path.resolve(__dirname, '..', 'qa-artifacts', 'care-b3-ui')
const PHONE_RE = /0[35789]\d{8}/

async function openCatalog(page: Page, theme: 'light' | 'dark' = 'light') {
  await page.goto('/ui-catalog/care-browse')
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
  await page.getByTestId('care-task-table').first().waitFor({ timeout: 20_000 })
}
async function hideShell(page: Page) {
  await page.evaluate(() => {
    document.querySelectorAll('header.bg-primary, aside.bg-sidebar, nav[aria-label="Điều hướng chính"], nextjs-portal').forEach((el) => { (el as HTMLElement).style.display = 'none' })
    const main = document.querySelector('main')
    const outer = main?.parentElement
    if (outer instanceof HTMLElement) { outer.style.height = 'auto'; outer.style.overflow = 'visible' }
    if (main instanceof HTMLElement) { main.style.overflow = 'visible' }
  })
}
async function shot(page: Page, testId: string, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true })
  await hideShell(page)
  await saveLocatorShot(page.getByTestId(testId), path.join(SHOTS, `${name}.png`))
}
const noPageOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
/** POST server action chuyển giao (body chứa toUserId) — đếm để kiểm chống gửi đôi. */
const isTransferPost = (r: Request) => r.method() === 'POST' && !!r.headers()['next-action'] && (r.postData() ?? '').includes('toUserId')

async function pickTarget(page: Page, name: string) {
  const dlg = page.getByTestId('care-transfer-dialog')
  await dlg.locator('button[aria-haspopup="listbox"]').click()
  await dlg.getByRole('textbox', { name: 'Tìm tên, mã cửa hàng…' }).fill(name)
  await dlg.getByText(name, { exact: true }).click()
}

test.describe('care B3 — browser (dữ liệu giả) @desktop', () => {
  test.skip(!HAS_STATE, 'chưa có storageState super (E2E_SUPER_* + project setup)')
  test.use({ storageState: SUPER_STATE })

  test('dashboard: kỳ hiện tại vs kỳ cũ tách nhãn; ô đơn hàng ghi "Chưa có dữ liệu đơn"; chart có chú giải + bảng', async ({ page }) => {
    await openCatalog(page)
    const cur = page.getByTestId('catalog-care-dashboard')
    for (const l of ['Khách (task) trong kỳ', 'Hoàn thành', 'Chưa chăm sóc', 'Quá hạn đang mở']) await expect(cur.getByText(l, { exact: true }).first()).toBeVisible()
    await expect(cur.getByText('Từng trễ hẹn trong kỳ', { exact: true })).toHaveCount(0)
    await expect(cur.getByText(/Chưa có dữ liệu đơn/)).toBeVisible()
    await expect(cur.getByRole('list', { name: 'Chú giải' })).toBeVisible()
    await expect(cur.getByLabel(/^QAOS01: /)).toBeVisible()
    await cur.getByText('Xem bảng số theo cửa hàng').click()
    await expect(cur.getByRole('cell', { name: 'QAOS02' }).first()).toBeVisible()
    await expect(cur.getByText('Chưa cập nhật')).toBeVisible()
    const past = page.getByTestId('catalog-care-dashboard-past')
    for (const l of ['Từng trễ hẹn trong kỳ', 'Không hoàn thành trong kỳ']) await expect(past.getByText(l, { exact: true }).first()).toBeVisible()
    await expect(past.getByText('Quá hạn đang mở', { exact: true })).toHaveCount(0)
    await shot(page, 'catalog-care-dashboard', 'desktop-light-dashboard')
  })

  test('danh sách: SĐT che, chỉ task mở có checkbox, nhãn trạng thái + Quá hạn; tìm SĐT qua POST, không vào URL', async ({ page }) => {
    const urls: string[] = []
    page.on('request', (r) => urls.push(r.url()))
    await openCatalog(page)
    const table = page.getByTestId('catalog-care-table').getByTestId('care-task-table')
    expect(await table.innerText()).not.toMatch(PHONE_RE)
    // Che Ở SERVER: số đầy đủ của hàng danh sách không có trong HTML/RSC payload (chỉ 002 ở khối chi tiết).
    const html = await page.content()
    for (const n of ['0390000001', '0390000003', '0390000004', '0390000005', '0390000006']) expect(html).not.toContain(n)
    await expect(table.getByRole('checkbox', { name: /^Chọn KH QA/ })).toHaveCount(4)
    await expect(table.getByText('Chưa chăm sóc', { exact: true }).first()).toBeVisible()
    await expect(table.getByText('Đang theo dõi', { exact: true }).first()).toBeVisible()
    await expect(table.getByText('Không hoàn thành trong kỳ', { exact: true })).toBeVisible()
    await expect(table.getByText('Quá hạn', { exact: true })).toHaveCount(1)
    await expect(table.getByRole('button', { name: /^Chuyển giao/ })).toBeDisabled()
    await shot(page, 'catalog-care-table', 'desktop-light-table')

    await table.getByRole('textbox', { name: 'Tìm theo tên hoặc SĐT' }).fill('0390000002')
    await table.getByRole('button', { name: 'Tìm', exact: true }).click()
    await expect(table.getByRole('row')).toHaveCount(2)                    // header + 1
    await expect(table.getByText('KH QA 00002')).toBeVisible()
    expect(urls.filter((u) => u.includes('0390000002'))).toEqual([])
    expect(page.url()).not.toContain('0390000002')
    await table.getByRole('button', { name: 'Bỏ tìm' }).click()
    await expect(table.getByRole('row')).toHaveCount(7)
    await table.getByRole('textbox', { name: 'Tìm theo tên hoặc SĐT' }).fill('khong-co')
    await table.getByRole('button', { name: 'Tìm', exact: true }).click()
    await expect(table.getByText('Không tìm thấy khách phù hợp')).toBeVisible()
    // Lỗi tìm: thông báo an toàn, không vỡ bảng.
    await table.getByRole('textbox', { name: 'Tìm theo tên hoặc SĐT' }).fill('qa-loi')
    await table.getByRole('button', { name: 'Tìm', exact: true }).click()
    await expect(table.getByText('Không tải được danh sách — thử lại.')).toBeVisible()
  })

  test('rỗng + bàn phím: bảng rỗng không có chọn/chuyển giao; Space chọn, Enter mở dialog, Esc đóng', async ({ page }) => {
    await openCatalog(page)
    const empty = page.getByTestId('catalog-care-table-empty')
    await expect(empty.getByText('Không có task theo bộ lọc này')).toBeVisible()
    await expect(empty.getByRole('checkbox')).toHaveCount(0)
    await expect(empty.getByRole('button', { name: /^Chuyển giao/ })).toHaveCount(0)
    const table = page.getByTestId('catalog-care-table')
    await table.getByRole('checkbox', { name: 'Chọn KH QA 00005' }).focus()
    await page.keyboard.press('Space')
    await expect(table.getByRole('checkbox', { name: 'Chọn KH QA 00005' })).toBeChecked()
    await table.getByRole('button', { name: 'Chuyển giao (1)' }).focus()
    await page.keyboard.press('Enter')
    const dlg = page.getByTestId('care-transfer-dialog')
    await expect(dlg.getByRole('heading', { name: 'Chuyển giao 1 khách' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dlg).toHaveCount(0)
  })

  test('chuyển giao nhóm: ghi chú bắt buộc, cảnh báo đổi store, bấm 2 lần chỉ gửi 1 lệnh, báo số đã chuyển', async ({ page }) => {
    const posts: Request[] = []
    page.on('request', (r) => { if (isTransferPost(r)) posts.push(r) })
    await openCatalog(page)
    const table = page.getByTestId('catalog-care-table').getByTestId('care-task-table')
    await table.getByRole('checkbox', { name: 'Chọn KH QA 00001' }).check()
    await table.getByRole('checkbox', { name: 'Chọn KH QA 00002' }).check()
    await table.getByRole('button', { name: 'Chuyển giao (2)' }).click()
    const dlg = page.getByTestId('care-transfer-dialog')
    await expect(dlg.getByRole('heading', { name: 'Chuyển giao 2 khách' })).toBeVisible()
    await expect(dlg.getByText('QAOS01 · QA Dược sĩ 01a (2)')).toBeVisible()
    const confirm = dlg.getByRole('button', { name: 'Xác nhận chuyển giao' })
    await expect(confirm).toBeDisabled()
    await pickTarget(page, 'QA Dược sĩ 02a')
    await expect(dlg.getByText('2 khách đổi sang cửa hàng QAOS02')).toBeVisible()
    await expect(confirm).toBeDisabled()                                     // chưa có ghi chú
    await dlg.getByRole('textbox', { name: 'Ghi chú chuyển giao (bắt buộc)' }).fill('   ')
    await expect(confirm).toBeDisabled()
    await dlg.getByRole('textbox', { name: 'Ghi chú chuyển giao (bắt buộc)' }).fill('QA: dược sĩ nghỉ phép')
    await shot(page, 'care-transfer-dialog', 'desktop-light-transfer-dialog')
    await confirm.dblclick()
    await expect(confirm).toBeDisabled()
    await expect(page.getByRole('status').getByText('Đã chuyển giao 2 khách')).toBeVisible({ timeout: 10_000 })
    await expect(dlg).toHaveCount(0)
    expect(posts).toHaveLength(1)
    expect(posts[0].postData()).toContain('QA: dược sĩ nghỉ phép')
  })

  test('chuyển giao lỗi (DNC tại đích): thông báo an toàn, dialog giữ nguyên; trùng owner ⇒ chặn trước khi gửi', async ({ page }) => {
    const posts: Request[] = []
    page.on('request', (r) => { if (isTransferPost(r)) posts.push(r) })
    await openCatalog(page)
    const table = page.getByTestId('catalog-care-table').getByTestId('care-task-table')
    await table.getByRole('checkbox', { name: 'Chọn KH QA 00001' }).check()
    await table.getByRole('button', { name: 'Chuyển giao (1)' }).click()
    const dlg = page.getByTestId('care-transfer-dialog')
    await pickTarget(page, 'QA Dược sĩ 01a')                                  // đang là owner
    await expect(dlg.getByText('1 khách đã thuộc dược sĩ này')).toBeVisible()
    await dlg.getByRole('textbox', { name: 'Ghi chú chuyển giao (bắt buộc)' }).fill('QA')
    await expect(dlg.getByRole('button', { name: 'Xác nhận chuyển giao' })).toBeDisabled()
    await pickTarget(page, 'QA Dược sĩ 02a')
    await dlg.getByRole('textbox', { name: 'Ghi chú chuyển giao (bắt buộc)' }).fill('QA DNC')
    await dlg.getByRole('button', { name: 'Xác nhận chuyển giao' }).click()
    await expect(dlg.getByRole('alert')).toHaveText('Có khách đã từ chối chăm sóc tại cửa hàng đích — chọn cửa hàng khác.')
    await expect(dlg).toBeVisible()
    expect(posts).toHaveLength(1)
    // Bàn phím: Esc đóng dialog khi không bận.
    await page.keyboard.press('Escape')
    await expect(dlg).toHaveCount(0)
  })

  test('chi tiết: sản phẩm từ file import, timeline lượt + chuyển giao có ghi chú; nút chuyển giao 1 task', async ({ page }) => {
    await openCatalog(page)
    const det = page.getByTestId('catalog-care-detail')
    await expect(det.getByText('Sản phẩm QA 0001')).toBeVisible()
    await expect(det.getByText('QA: khách dùng thuốc định kỳ, sắp hết liều')).toBeVisible()
    // Ảnh ngoài CDN đã chốt ⇒ coi như không có ảnh, không tải.
    await expect(det.getByLabel('Không có ảnh')).toHaveCount(2)
    await expect(det.locator('img')).toHaveCount(0)
    await expect(det.getByText('QA: dược sĩ nghỉ phép')).toBeVisible()
    await expect(det.getByText('Kỳ trước / dược sĩ trước').first()).toBeVisible()
    await shot(page, 'catalog-care-detail', 'desktop-light-detail')
    // Q-78: 10 lượt mới nhất, "Xem thêm" nạp 10 rồi 3; hết lượt ⇒ nút biến mất. Bấm đúp chỉ nạp một lần.
    const tl = det.getByTestId('care-timeline')
    const items = tl.getByText(/^QA: lượt giả #\d+$/)
    await expect(items).toHaveCount(10)
    const more = tl.getByRole('button', { name: 'Xem thêm lượt cũ hơn' })
    await more.dblclick()
    await expect(items).toHaveCount(20)
    await more.click()
    await expect(items).toHaveCount(23)
    await expect(more).toHaveCount(0)
    await expect(tl.getByText('QA: lượt giả #8', { exact: true })).toBeVisible()
    await det.getByRole('button', { name: 'Chuyển giao' }).focus()
    await page.keyboard.press('Enter')
    const dlg = page.getByTestId('care-transfer-dialog')
    await expect(dlg.getByRole('heading', { name: 'Chuyển giao 1 khách' })).toBeVisible()
    await pickTarget(page, 'QA Dược sĩ 01b')
    await dlg.getByRole('textbox', { name: 'Ghi chú chuyển giao (bắt buộc)' }).fill('QA chuyển ca')
    await dlg.getByRole('button', { name: 'Xác nhận chuyển giao' }).click()
    await expect(det.getByText('Đã chuyển giao', { exact: true })).toBeVisible({ timeout: 10_000 })
  })

  test('dark mode: dashboard + bảng + chi tiết', async ({ page }) => {
    await openCatalog(page, 'dark')
    await shot(page, 'catalog-care-dashboard', 'desktop-dark-dashboard')
    await shot(page, 'catalog-care-table', 'desktop-dark-table')
    await shot(page, 'catalog-care-detail', 'desktop-dark-detail')
  })
})

test.describe('care B3 — browser mobile (dữ liệu giả) @mobile', () => {
  test.skip(!HAS_STATE, 'chưa có storageState super')
  test.use({ storageState: SUPER_STATE })

  test('360/393: không cuộn ngang trang, nút đủ 44px, dialog vừa màn hình', async ({ page }) => {
    await openCatalog(page)
    expect(await noPageOverflow(page)).toBe(true)
    const table = page.getByTestId('catalog-care-table').getByTestId('care-task-table')
    for (const name of ['Tìm', /^Chuyển giao/]) expect((await table.getByRole('button', { name }).boundingBox())!.height).toBeGreaterThanOrEqual(44)
    const w = page.viewportSize()!.width
    await shot(page, 'catalog-care-dashboard', `mobile-${w}-dashboard`)
    await shot(page, 'catalog-care-table', `mobile-${w}-table`)
    await shot(page, 'catalog-care-detail', `mobile-${w}-detail`)
    await table.getByRole('checkbox', { name: 'Chọn KH QA 00001' }).check()
    await table.getByRole('button', { name: 'Chuyển giao (1)' }).click()
    const dlg = page.getByTestId('care-transfer-dialog')
    const box = (await dlg.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(w + 1)
    // Dialog mở có animation scale ⇒ đo sau khi ổn định.
    await expect.poll(async () => (await dlg.getByRole('button', { name: 'Xác nhận chuyển giao' }).boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await shot(page, 'care-transfer-dialog', `mobile-${w}-transfer-dialog`)
  })
})

test.describe('care B3 — page thật khi cờ CARE_ENABLED tắt @desktop', () => {
  test.skip(!HAS_STATE, 'chưa có storageState super')
  test.skip(process.env.CARE_ENABLED === 'true', 'server QA đang bật cờ CRM — smoke này kiểm trạng thái mặc định OFF')
  test.use({ storageState: SUPER_STATE })

  test('super: /care, /care/tasks, /care/tasks/[id] 404; sidebar không có "Chăm sóc KH"', async ({ page }) => {
    for (const p of ['/care', '/care/tasks', '/care/tasks/00000000-0000-4000-8000-000000000001', '/care/tasks/x?month=2026-10']) {
      expect((await page.goto(p))!.status(), p).toBe(404)
    }
    await page.goto('/dashboard')
    await expect(page.locator('aside').first()).toBeVisible()
    await expect(page.getByText('Chăm sóc KH')).toHaveCount(0)
    await expect(page.locator('a[href^="/care"]')).toHaveCount(0)
  })

  test('SM (nếu có state): sidebar không có nhóm CRM khi cờ OFF', async ({ browser }) => {
    test.skip(!fs.existsSync(SM_STATE), 'chưa có storageState SM')
    const ctx = await browser.newContext({ storageState: SM_STATE })
    const page = await ctx.newPage()
    expect((await page.goto('/care'))!.status()).toBe(404)
    await page.goto('/dashboard')
    await expect(page.locator('a[href^="/care"]')).toHaveCount(0)
    await ctx.close()
  })

  test('QLCH (nếu có state): không route/nav CRM (Q-76/77)', async ({ browser }) => {
    test.skip(!fs.existsSync(MANAGER_STATE), 'chưa có storageState QLCH')
    const ctx = await browser.newContext({ storageState: MANAGER_STATE })
    const page = await ctx.newPage()
    for (const p of ['/care', '/care/tasks', '/care/assign']) expect((await page.goto(p))!.status(), p).toBe(404)
    await page.goto('/tasks')
    await expect(page.locator('a[href^="/care"]')).toHaveCount(0)
    await ctx.close()
  })

  test('không đăng nhập: /care* về /login', async ({ baseURL }) => {
    const ctx = await pwRequest.newContext({ baseURL, storageState: { cookies: [], origins: [] } })
    for (const p of ['/care', '/care/tasks']) {
      const res = await ctx.get(p, { maxRedirects: 0 })
      expect([302, 307], p).toContain(res.status())
      expect(res.headers()['location'], p).toContain('/login')
    }
    await ctx.dispose()
  })
})
