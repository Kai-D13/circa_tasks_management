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
  // B8.1: bảng có state client (chọn/tìm/drawer) ⇒ chờ JS nạp xong mới thao tác (dev server biên dịch chậm).
  await page.waitForLoadState('networkidle')
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
    // B7-ui (hintLines=2): mô tả dài của thẻ số hiện đủ (tối đa 2 dòng), không bị cắt một dòng.
    const hint = cur.getByText(/^đã qua ngày hẹn chăm sóc lại · từng trễ trong kỳ: \d+$/)
    await expect(hint).toBeVisible()
    expect(await hint.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1)).toBe(true)
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
    // B8.1: chưa chọn ⇒ không có nút chuyển giao (thanh hành động chỉ hiện khi đã chọn), có gợi ý cách chọn.
    await expect(table.getByRole('button', { name: /^Chuyển giao/ })).toHaveCount(0)
    await expect(table.getByText('Tick ô đầu hàng để chuyển giao')).toBeVisible()
    await shot(page, 'catalog-care-table', 'desktop-light-table')

    const box = table.getByRole('textbox', { name: 'Tìm theo tên hoặc SĐT' })
    // B8.1: không còn nút "Tìm" — Enter chạy ngay; từ khoá vẫn đi POST, không vào URL.
    await expect(table.getByRole('button', { name: 'Tìm', exact: true })).toHaveCount(0)
    await box.fill('0390000002')
    await box.press('Enter')
    await expect(table.getByRole('row')).toHaveCount(2)                    // header + 1
    await expect(table.getByText('KH QA 00002')).toBeVisible()
    expect(urls.filter((u) => u.includes('0390000002'))).toEqual([])
    expect(page.url()).not.toContain('0390000002')
    await table.getByRole('button', { name: 'Bỏ tìm' }).click()
    await expect(table.getByRole('row')).toHaveCount(7)
    // Tự áp dụng sau ~400 ms (không bấm Enter).
    await box.fill('khong-co')
    await expect(table.getByText('Không tìm thấy khách phù hợp')).toBeVisible()
    // Lỗi tìm: thông báo an toàn, trạng thái riêng (không coi như danh sách rỗng).
    await box.fill('qa-loi')
    await box.press('Enter')
    await expect(table.getByText('Không tải được danh sách — thử lại.')).toBeVisible()
    await expect(table.getByText('Không tìm thấy khách phù hợp')).toHaveCount(0)
    // Từ khoá < 2 ký tự ⇒ về danh sách gốc.
    await box.fill('q')
    await expect(table.getByRole('row')).toHaveCount(7)
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
    await expect(table.getByTestId('care-bulk-bar').getByText('Đã chọn 1 khách')).toBeVisible()
    await table.getByRole('button', { name: 'Chuyển giao 1 khách' }).focus()
    await page.keyboard.press('Enter')
    const dlg = page.getByTestId('care-transfer-dialog')
    await expect(dlg.getByRole('heading', { name: 'Chuyển giao 1 khách' })).toBeVisible()
    // Esc trong dialog chỉ đóng dialog — KHÔNG xoá lựa chọn.
    await page.keyboard.press('Escape')
    await expect(dlg).toHaveCount(0)
    await expect(table.getByRole('checkbox', { name: 'Chọn KH QA 00005' })).toBeChecked()
    // Esc lần nữa (focus trong bảng) ⇒ bỏ chọn, thanh hành động biến mất.
    await table.getByRole('checkbox', { name: 'Chọn KH QA 00005' }).focus()
    await page.keyboard.press('Escape')
    await expect(table.getByRole('checkbox', { name: 'Chọn KH QA 00005' })).not.toBeChecked()
    await expect(table.getByTestId('care-bulk-bar')).toHaveCount(0)
  })

  test('chuyển giao nhóm: ghi chú bắt buộc, cảnh báo đổi store, bấm 2 lần chỉ gửi 1 lệnh, báo số đã chuyển', async ({ page }) => {
    const posts: Request[] = []
    page.on('request', (r) => { if (isTransferPost(r)) posts.push(r) })
    await openCatalog(page)
    const table = page.getByTestId('catalog-care-table').getByTestId('care-task-table')
    await table.getByRole('checkbox', { name: 'Chọn KH QA 00001' }).check()
    await table.getByRole('checkbox', { name: 'Chọn KH QA 00002' }).check()
    await table.getByRole('button', { name: 'Chuyển giao 2 khách' }).click()
    const dlg = page.getByTestId('care-transfer-dialog')
    await expect(dlg.getByRole('heading', { name: 'Chuyển giao 2 khách' })).toBeVisible()
    await expect(dlg.getByText('QAOS01 · QA Dược sĩ 01a (2)')).toBeVisible()
    const confirm = dlg.getByRole('button', { name: 'Xác nhận chuyển giao' })
    await expect(confirm).toBeDisabled()
    // B7-ui: nút tắt luôn kèm lý do (không phải role=alert).
    await expect(dlg.getByTestId('care-transfer-hint')).toHaveText('Chọn dược sĩ nhận và nhập ghi chú để xác nhận.')
    await pickTarget(page, 'QA Dược sĩ 02a')
    await expect(dlg.getByText('2 khách đổi sang cửa hàng QAOS02')).toBeVisible()
    await expect(confirm).toBeDisabled()                                     // chưa có ghi chú
    await expect(dlg.getByTestId('care-transfer-hint')).toHaveText('Nhập ghi chú chuyển giao để xác nhận.')
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
    await table.getByRole('button', { name: 'Chuyển giao 1 khách' }).click()
    const dlg = page.getByTestId('care-transfer-dialog')
    // B8.1 (PM P1-2): owner hiện tại bị khoá NGAY trong danh sách — bấm không chọn được.
    await dlg.locator('button[aria-haspopup="listbox"]').click()
    await dlg.getByRole('textbox', { name: 'Tìm tên, mã cửa hàng…' }).fill('QA Dược sĩ 01a')
    await expect(dlg.getByText('đang giữ 1 khách trong lô')).toBeVisible()
    await dlg.getByText('QA Dược sĩ 01a', { exact: true }).click()
    await dlg.getByRole('heading', { name: 'Chuyển giao 1 khách' }).click()   // đóng listbox (click ngoài)
    await expect(dlg.locator('button[aria-haspopup="listbox"]')).toContainText('Chọn dược sĩ')
    await dlg.getByRole('textbox', { name: 'Ghi chú chuyển giao (bắt buộc)' }).fill('QA')
    await expect(dlg.getByRole('button', { name: 'Xác nhận chuyển giao' })).toBeDisabled()
    expect(posts).toHaveLength(0)
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
    expect((await table.getByRole('textbox', { name: 'Tìm theo tên hoặc SĐT' }).boundingBox())!.height).toBeGreaterThanOrEqual(44)
    const w = page.viewportSize()!.width
    await shot(page, 'catalog-care-dashboard', `mobile-${w}-dashboard`)
    await shot(page, 'catalog-care-table', `mobile-${w}-table`)
    await shot(page, 'catalog-care-detail', `mobile-${w}-detail`)
    await table.getByRole('checkbox', { name: 'Chọn KH QA 00001' }).check()
    for (const name of ['Bỏ chọn', 'Chuyển giao 1 khách']) expect((await table.getByRole('button', { name }).boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await table.getByRole('button', { name: 'Chuyển giao 1 khách' }).click()
    const dlg = page.getByTestId('care-transfer-dialog')
    const box = (await dlg.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(w + 1)
    // Dialog mở có animation scale ⇒ đo sau khi ổn định.
    await expect.poll(async () => (await dlg.getByRole('button', { name: 'Xác nhận chuyển giao' }).boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await shot(page, 'care-transfer-dialog', `mobile-${w}-transfer-dialog`)
  })
})

// ── B8.1 /care/tasks theo artboard 12 — `?frame=tasks` dựng đúng bố cục trang thật ──────────
const S = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const SHOTS_B81 = path.resolve(__dirname, '..', 'qa-artifacts', 'b8-1')
const ALL_PHONES = Array.from({ length: 6 }, (_, i) => `039000000${i + 1}`)

async function openFrame(page: Page, theme: 'light' | 'dark' = 'light', extra = '') {
  await page.goto(`/ui-catalog/care-browse?frame=tasks${extra}`)
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
  await page.getByTestId('catalog-frame-tasks').waitFor({ timeout: 20_000 })
  await page.waitForLoadState('networkidle')
  return page.getByTestId('catalog-frame-tasks')
}
async function frameShot(page: Page, name: string) {
  fs.mkdirSync(SHOTS_B81, { recursive: true })
  await hideShell(page)
  await page.screenshot({ path: path.join(SHOTS_B81, `${name}.png`), fullPage: true })
}

test.describe('care B8.1 — /care/tasks (frame, dữ liệu giả) @desktop', () => {
  test.skip(!HAS_STATE, 'chưa có storageState super')
  test.use({ storageState: SUPER_STATE })

  test('chip có số (Tất cả là count riêng), ô 2 dòng, n sản phẩm, kỳ ở header', async ({ page }) => {
    const fr = await openFrame(page)
    const chips = fr.getByRole('navigation', { name: 'Lọc theo trạng thái' })
    await expect(chips.getByRole('link')).toHaveCount(6)
    await expect(chips.getByRole('link', { name: /^Tất cả\s?6$/ })).toHaveAttribute('aria-current', 'page')
    await expect(chips.getByRole('link', { name: /^Quá hạn\s?1$/ })).toHaveAttribute('href', /status=overdue_open/)
    for (const a of await chips.getByRole('link').all()) expect(await a.getAttribute('href')).not.toMatch(/page=|q=|open=/)
    await expect(fr.getByRole('combobox', { name: 'Kỳ chăm sóc' })).toBeVisible()
    const table = fr.getByTestId('care-task-table')
    const r2 = table.getByRole('row').filter({ hasText: 'KH QA 00002' })
    await expect(r2.getByText('2 sản phẩm')).toBeVisible()
    await expect(r2.getByText('10:00 05/10')).toBeVisible()                  // lượt gần nhất giờ VN
    await expect(r2.getByText('còn 10 ngày')).toBeVisible()
    await expect(table.getByRole('row').filter({ hasText: 'KH QA 00003' }).getByText('quá 8 ngày')).toBeVisible()
    // Danh sách không mang số đầy đủ nào trước khi mở drawer.
    const html = await page.content()
    for (const n of ALL_PHONES) expect(html).not.toContain(n)
    expect(await noPageOverflow(page)).toBe(true)
  })

  test('tìm: phản hồi chậm của từ khoá cũ không ghi đè kết quả mới; gõ tìm ⇒ bỏ chọn ngay', async ({ page }) => {
    const fr = await openFrame(page)
    const table = fr.getByTestId('care-task-table')
    await table.getByRole('checkbox', { name: 'Chọn KH QA 00001' }).check()
    await expect(table.getByTestId('care-bulk-bar')).toBeVisible()
    await table.getByRole('button', { name: 'Bỏ chọn' }).click()
    const box = table.getByRole('textbox', { name: 'Tìm theo tên hoặc SĐT' })
    await box.fill('KH QA 00001'); await box.press('Enter')                  // fake trả CHẬM 1,5 s
    await box.fill('KH QA 00002'); await box.press('Enter')                  // fake trả nhanh
    await expect(table.getByRole('row')).toHaveCount(2)
    await page.waitForTimeout(2_000)                                          // chờ phản hồi cũ về
    await expect(table.getByRole('row')).toHaveCount(2)
    await expect(table.getByRole('link', { name: 'KH QA 00002' })).toBeVisible()
    await expect(table.getByRole('link', { name: 'KH QA 00001' })).toHaveCount(0)
    // Đang có kết quả tìm: chọn rồi đổi từ khoá ⇒ lựa chọn bị bỏ ngay (không giữ task có thể bị ẩn).
    await table.getByRole('checkbox', { name: 'Chọn KH QA 00002' }).check()
    await expect(table.getByTestId('care-bulk-bar')).toBeVisible()
    await table.getByRole('button', { name: 'Bỏ chọn' }).click()             // thanh hành động → về ô tìm
    await table.getByRole('checkbox', { name: 'Chọn KH QA 00002' }).check()
    await expect(table.getByTestId('care-bulk-bar')).toBeVisible()
    await table.getByTestId('care-bulk-bar').getByRole('button', { name: 'Bỏ chọn' }).focus()
    await page.keyboard.press('Escape')                                      // Esc trong bảng ⇒ bỏ chọn
    await expect(table.getByTestId('care-bulk-bar')).toHaveCount(0)
    await table.getByRole('checkbox', { name: 'Chọn KH QA 00002' }).check()
    await expect(table.getByTestId('care-bulk-bar')).toHaveCount(1)
    // Ô tìm bị thay bởi thanh hành động khi đang chọn; đổi trang/lọc remount bảng (key = URL lọc) ⇒ rỗng.
    await table.getByRole('button', { name: 'Bỏ chọn' }).click()
    await box.fill('KH QA 0000')
    await expect(table.getByRole('checkbox', { name: 'Chọn KH QA 00002' })).not.toBeChecked()
  })

  test('tìm (PM r1): A về TRONG lúc chờ debounce của B ⇒ không hiện kết quả A; B hiện đúng', async ({ page }) => {
    const fr = await openFrame(page)
    const table = fr.getByTestId('care-task-table')
    const box = table.getByRole('textbox', { name: 'Tìm theo tên hoặc SĐT' })
    const isSearch = (r: Request, term: string) => r.method() === 'POST' && !!r.headers()['next-action'] && (r.postData() ?? '').includes(term)
    // GIỮ phản hồi của A cho tới khi test nhả — tạo đúng cửa sổ: A về SAU khi gõ B nhưng TRƯỚC khi debounce B hết.
    let releaseA!: () => void
    const gateA = new Promise<void>((r) => { releaseA = r })
    let fetchedA!: () => void
    const aFetched = new Promise<void>((r) => { fetchedA = r })
    let aDeliveredAt = 0
    let bSentAt = 0
    await page.route(() => true, async (route) => {
      if (!isSearch(route.request(), 'KH QA 00001')) return route.fallback()
      const resp = await route.fetch()
      fetchedA()
      await gateA
      aDeliveredAt = Date.now()
      await route.fulfill({ response: resp })
    })
    page.on('request', (r) => { if (!bSentAt && isSearch(r, 'KH QA 00002')) bSentAt = Date.now() })
    await box.fill('KH QA 00001'); await box.press('Enter')
    await aFetched                                                           // server đã trả A; test đang giữ
    await box.fill('KH QA 00002')                                            // B: bắt đầu chờ debounce 400 ms
    const bTypedAt = Date.now()
    // Theo dõi DOM từ lúc gõ B: kết quả của A có TỪNG hiện ra không (auto-retry của expect sẽ chờ B đè lên và che lỗi).
    await page.evaluate(() => {
      const w = window as unknown as { __staleA?: boolean }
      w.__staleA = false
      const seen = () => { if (document.body.innerText.includes('Kết quả tìm “KH QA 00001”')) w.__staleA = true }
      seen()
      new MutationObserver(seen).observe(document.body, { subtree: true, childList: true, characterData: true })
    })
    await page.waitForTimeout(100)
    releaseA()                                                              // A về ~100 ms sau khi gõ B
    await expect(table.getByText('Kết quả tìm “KH QA 00002”: 1 khách', { exact: false })).toBeVisible({ timeout: 10_000 })
    // Kịch bản đúng như PM r1: A về trong lúc B còn chờ debounce (B chỉ gửi SAU khi A về).
    expect(aDeliveredAt - bTypedAt).toBeLessThan(400)
    expect(bSentAt).toBeGreaterThanOrEqual(aDeliveredAt)
    expect(await page.evaluate(() => (window as unknown as { __staleA?: boolean }).__staleA), 'kết quả của từ khoá cũ A từng hiện sau khi đã gõ B').toBe(false)
    await expect(table.getByRole('row')).toHaveCount(2)
    await expect(table.getByRole('link', { name: 'KH QA 00002' })).toBeVisible()
  })

  test('tìm (PM r1): XOÁ từ khoá khi A đang chạy ⇒ A về sau không hiện, bảng về danh sách gốc', async ({ page }) => {
    const fr = await openFrame(page)
    const table = fr.getByTestId('care-task-table')
    const box = table.getByRole('textbox', { name: 'Tìm theo tên hoặc SĐT' })
    let releaseA!: () => void
    const gateA = new Promise<void>((r) => { releaseA = r })
    let fetchedA!: () => void
    const aFetched = new Promise<void>((r) => { fetchedA = r })
    let delivered!: () => void
    const aDelivered = new Promise<void>((r) => { delivered = r })
    await page.route(() => true, async (route) => {
      const r = route.request()
      if (!(r.method() === 'POST' && r.headers()['next-action'] && (r.postData() ?? '').includes('KH QA 00001'))) return route.fallback()
      const resp = await route.fetch()
      fetchedA()
      await gateA
      await route.fulfill({ response: resp })
      delivered()
    })
    await box.fill('KH QA 00001'); await box.press('Enter')
    await aFetched
    await table.getByRole('button', { name: 'Bỏ tìm' }).click()             // xoá khi A còn đang bay
    await expect(box).toHaveValue('')
    await expect(table.getByRole('row')).toHaveCount(7)                      // danh sách gốc
    releaseA(); await aDelivered
    await page.waitForTimeout(500)
    expect(await table.getByText('Kết quả tìm “KH QA 00001”').count()).toBe(0)
    expect(await table.getByRole('row').count()).toBe(7)
    expect(await table.locator('[aria-label="Đang tìm"]').count()).toBe(0)
  })

  test('drawer ≥1280: click thường mở cạnh bảng (?open=uuid), SĐT đủ + tel: chỉ của khách đó; Esc đóng, focus về tên', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const fr = await openFrame(page)
    const table = fr.getByTestId('care-task-table')
    await table.getByRole('link', { name: 'KH QA 00002' }).click()
    const dr = page.getByTestId('care-task-drawer')
    await expect(dr.getByRole('heading', { name: 'KH QA 00002' })).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`frame=tasks.*open=${S(501)}`))
    expect(page.url()).not.toMatch(/0390000/)
    await expect(dr.locator('a[href="tel:0390000002"]')).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)                     // cạnh bảng, không phải overlay
    const tb = (await table.locator('section').first().boundingBox())!
    const db = (await page.locator('aside[aria-label="Chi tiết khách"]').boundingBox())!
    expect(db.x).toBeGreaterThanOrEqual(tb.x + tb.width - 1)
    for (const n of ALL_PHONES.filter((p) => p !== '0390000002')) expect(await page.content()).not.toContain(n)
    await expect(dr.getByRole('link', { name: /Mở trang đầy đủ/ })).toHaveAttribute('href', `/care/tasks/${S(501)}`)
    await expect(dr.getByRole('button', { name: 'Chuyển giao' })).toBeVisible()  // task mở kỳ hiện tại
    await frameShot(page, 'desktop-1440-light-drawer')
    await page.keyboard.press('Escape')
    await expect(dr).toHaveCount(0)
    await expect(page).not.toHaveURL(/open=/)
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-open-task'))).toBe(S(501))
  })

  test('drawer <1280: hộp thoại phủ phải, Esc đóng; Ctrl+click vẫn mở trang chi tiết (tab mới), không mở drawer', async ({ page, context }) => {
    await page.setViewportSize({ width: 1100, height: 800 })
    const fr = await openFrame(page)
    const table = fr.getByTestId('care-task-table')
    await table.getByRole('link', { name: 'KH QA 00003' }).click()
    const dlg = page.getByRole('dialog')
    await expect(dlg.getByText('Chi tiết khách')).toBeVisible()
    await expect(dlg.getByRole('heading', { name: 'KH QA 00003' })).toBeVisible()
    const box = (await dlg.boundingBox())!
    expect(box.x + box.width).toBeLessThanOrEqual(1101)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('care-task-drawer')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-open-task'))).toBe(S(502))
    const popup = context.waitForEvent('page')
    await table.getByRole('link', { name: 'KH QA 00001' }).click({ modifiers: ['Control'] })
    const np = await popup
    await expect.poll(() => np.url(), { timeout: 15_000 }).toContain(`/care/tasks/${S(500)}`)
    await np.close()
    await expect(page.getByTestId('care-task-drawer')).toHaveCount(0)
    await expect(page).not.toHaveURL(/open=/)
  })

  test('deep link ?open= mở đúng khách khi tải lại; id ngoài phạm vi ⇒ không tìm thấy, không lộ số', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openFrame(page, 'light', `&open=${S(501)}`)
    await expect(page.getByTestId('care-task-drawer').getByRole('heading', { name: 'KH QA 00002' })).toBeVisible()
    await openFrame(page, 'light', `&open=${S(599)}`)
    const dr = page.getByTestId('care-task-drawer')
    await expect(dr.getByText('Không tìm thấy khách này trong phạm vi của bạn.')).toBeVisible()
    const html = await page.content()
    for (const n of ALL_PHONES) expect(html).not.toContain(n)
    await openFrame(page, 'light', '&open=0390000001')                       // không phải uuid ⇒ bỏ qua
    await expect(page.getByTestId('care-task-drawer')).toHaveCount(0)
  })

  test('chuyển giao lô pha trộn owner: khoá MỌI dược sĩ đang giữ task trong lô; đích hợp lệ kèm tải đang mở', async ({ page }) => {
    const fr = await openFrame(page)
    const table = fr.getByTestId('care-task-table')
    await table.getByRole('checkbox', { name: 'Chọn KH QA 00001' }).check()   // QA Dược sĩ 01a
    await table.getByRole('checkbox', { name: 'Chọn KH QA 00005' }).check()   // QA Dược sĩ 02a
    await table.getByRole('button', { name: 'Chuyển giao 2 khách' }).click()
    const dlg = page.getByTestId('care-transfer-dialog')
    await expect(dlg.getByTestId('care-transfer-sources')).toContainText('QAOS01 · QA Dược sĩ 01a (1)')
    await expect(dlg.getByTestId('care-transfer-sources')).toContainText('QAOS02 · QA Dược sĩ 02a (1)')
    await dlg.locator('button[aria-haspopup="listbox"]').click()
    await expect(dlg.getByText('đang giữ 1 khách trong lô')).toHaveCount(2)
    await expect(dlg.getByText('QAOS01 · 0 đang mở')).toBeVisible()          // 01b: tải 0 (có đọc được)
    await expect(dlg.getByTestId('care-transfer-conflicts')).toBeVisible()
    await dlg.getByText('QA Dược sĩ 02a', { exact: true }).click()            // bị khoá ⇒ không chọn
    await expect(dlg.locator('button[aria-haspopup="listbox"]')).toContainText('Chọn dược sĩ')
    await dlg.getByText('QA Dược sĩ 01b', { exact: true }).click()
    await dlg.getByRole('textbox', { name: 'Ghi chú chuyển giao (bắt buộc)' }).fill('QA B8.1 lô pha trộn')
    await frameShot(page, 'desktop-light-transfer-mixed')
    await dlg.getByRole('button', { name: 'Xác nhận chuyển giao' }).click()
    await expect(page.getByRole('status').getByText('Đã chuyển giao 2 khách')).toBeVisible({ timeout: 10_000 })
    await expect(table.getByTestId('care-bulk-bar')).toHaveCount(0)
  })

  test('ảnh 1440/1280 sáng/tối (so artboard 12)', async ({ page }) => {
    for (const w of [1440, 1280]) for (const theme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width: w, height: 900 })
      await openFrame(page, theme)
      expect(await noPageOverflow(page), `${w}-${theme}`).toBe(true)
      await frameShot(page, `desktop-${w}-${theme}-list`)
      await openFrame(page, theme, `&open=${S(502)}`)
      await page.getByTestId('care-task-drawer').getByRole('heading', { name: 'KH QA 00003' }).waitFor()
      await frameShot(page, `desktop-${w}-${theme}-drawer`)
    }
  })
})

test.describe('care B8.1 — /care/tasks (frame) mobile @mobile', () => {
  test.skip(!HAS_STATE, 'chưa có storageState super')
  test.use({ storageState: SUPER_STATE })

  test('360/393: không cuộn ngang trang, chip cuộn trong hàng, drawer phủ vừa màn hình', async ({ page }) => {
    for (const theme of ['light', 'dark'] as const) {
      const fr = await openFrame(page, theme)
      expect(await noPageOverflow(page)).toBe(true)
      const w = page.viewportSize()!.width
      await frameShot(page, `mobile-${w}-${theme}-list`)
      await fr.getByTestId('care-task-table').getByRole('link', { name: 'KH QA 00002' }).click()
      const dlg = page.getByRole('dialog')
      await expect(dlg.getByRole('heading', { name: 'KH QA 00002' })).toBeVisible()
      const box = (await dlg.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(w + 1)
      expect((await dlg.getByRole('button', { name: 'Đóng chi tiết' }).boundingBox())!.height).toBeGreaterThanOrEqual(44)
      await frameShot(page, `mobile-${w}-${theme}-drawer`)
      await dlg.getByRole('button', { name: 'Đóng chi tiết' }).click()
      await expect(page.getByTestId('care-task-drawer')).toHaveCount(0)
    }
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

// ── B8.4 /care theo artboard 05 (frame dữ liệu giả, đúng bố cục trang thật) ─────────────────────────────────
const SHOTS_B84 = path.resolve(__dirname, '..', 'qa-artifacts', 'b8-4')
async function openDashboard(page: Page, qs = '', theme: 'light' | 'dark' = 'light') {
  await page.goto(`/ui-catalog/care-browse?frame=dashboard${qs}`)
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
  await page.getByTestId('catalog-frame-dashboard').waitFor({ timeout: 20_000 })
  await page.waitForLoadState('networkidle')
}
async function dashShot(page: Page, name: string) {
  fs.mkdirSync(SHOTS_B84, { recursive: true })
  await hideShell(page)
  await page.screenshot({ path: path.join(SHOTS_B84, `${name}.png`), fullPage: true })
}
const kpi = (page: Page, label: string) => page.getByTestId('care-dashboard').locator('> div').first().locator('> *').filter({ hasText: label }).first()

test.describe('care B8.4 — /care theo artboard 05 (frame, dữ liệu giả) @desktop', () => {
  test.skip(!HAS_STATE, 'chưa có storageState super')
  test.use({ storageState: SUPER_STATE })

  test('kỳ hiện tại: 4 ô KPI là link /care/tasks đúng trạng thái + giữ kỳ; "Khách có đơn" chưa đồng bộ là ô viền đứt, không link; bộ lọc trên header', async ({ page }) => {
    await openDashboard(page)
    const f = page.getByTestId('catalog-frame-dashboard')
    const hdr = f.locator('> div').first()
    await expect(hdr.getByRole('heading', { level: 1, name: 'Chăm sóc khách hàng' })).toBeVisible()
    await expect(hdr.locator('button[aria-haspopup="listbox"], select, [role="combobox"]').first()).toBeVisible() // bộ lọc nằm trong header
    const want: [string, string][] = [
      ['Khách (task) trong kỳ', '/care/tasks?month=2026-10'],
      ['Hoàn thành', '/care/tasks?month=2026-10&status=completed'],
      ['Chưa chăm sóc', '/care/tasks?month=2026-10&status=not_cared'],
      ['Quá hạn đang mở', '/care/tasks?month=2026-10&status=overdue_open'],
    ]
    for (const [label, href] of want) {
      const t = kpi(page, label)
      await expect(t, label).toHaveAttribute('href', href)
      expect((await t.boundingBox())!.height, label).toBeGreaterThanOrEqual(44)
    }
    await expect(kpi(page, 'Khách (task) trong kỳ')).toContainText('2 cửa hàng · 3 dược sĩ có khách')
    const orders = page.getByTestId('care-dashboard-orders').getByTestId('care-order-state')
    await expect(orders).toHaveAttribute('data-state', 'none')
    await expect(orders).toContainText('Chưa có dữ liệu')
    expect(await orders.evaluate((el) => el.tagName)).toBe('DIV')
    await expect(page.getByTestId('care-dashboard').locator('a[data-kpi-link]')).toHaveCount(4)
    await expect(f.getByRole('link', { name: /Xem báo cáo theo dược sĩ/ })).toHaveAttribute('href', '/care/reports?month=2026-10')
    expect(await noPageOverflow(page)).toBe(true)
  })

  test('lọc cửa hàng: link giữ kỳ + cửa hàng, KHÔNG mang dược sĩ', async ({ page }) => {
    await openDashboard(page, '&store=1')
    const href = await kpi(page, 'Chưa chăm sóc').getAttribute('href')
    expect(href).toMatch(/^\/care\/tasks\?month=2026-10&store=[0-9a-f-]{36}&status=not_cared$/)
    expect(href).not.toMatch(/assignee|staff/)
  })

  test('kỳ cũ: "Từng trễ hẹn" KHÔNG link (khác tập overdue_open); "Không hoàn thành" link closed_unfinished; không còn "Quá hạn đang mở"', async ({ page }) => {
    await openDashboard(page, '&past=1')
    const late = kpi(page, 'Từng trễ hẹn trong kỳ')
    expect(await late.evaluate((el) => el.tagName)).toBe('DIV')
    await expect(late).not.toHaveAttribute('href', /.*/)
    await expect(kpi(page, 'Không hoàn thành trong kỳ')).toHaveAttribute('href', '/care/tasks?month=2026-09&status=closed_unfinished')
    await expect(page.getByTestId('care-dashboard').getByText('Quá hạn đang mở', { exact: true })).toHaveCount(0)
  })

  test('kỳ mới import chưa có lượt nào: khối kết quả trống có giải thích + link khách chưa chăm sóc (cùng tập)', async ({ page }) => {
    await openDashboard(page, '&fresh=1')
    const empty = page.getByTestId('care-outcomes-empty')
    await expect(empty).toContainText('Chưa có kết quả trong kỳ')
    await expect(empty.getByRole('link', { name: /Xem khách chưa chăm sóc/ })).toHaveAttribute('href', '/care/tasks?month=2026-10&status=not_cared')
    await expect(kpi(page, 'Hoàn thành')).not.toHaveAttribute('href', /.*/) // 0 ⇒ không link danh sách rỗng
  })

  test('RPC quyền lỗi (unavailable): thông báo mất kết nối/thử tải lại — không nói "thiếu cấu hình CRM"', async ({ page }) => {
    await openDashboard(page, '&unavailable=1')
    const f = page.getByTestId('catalog-frame-dashboard')
    await expect(f.getByRole('alert')).toContainText('Không tải được hệ thống CRM.')
    await expect(f.getByRole('alert')).toContainText('mất kết nối')
    await expect(f.getByText(/cấu hình CRM/)).toHaveCount(0)
    await expect(page.getByTestId('care-dashboard')).toHaveCount(0)
  })

  test('ảnh 1440/1280 sáng/tối (so artboard 05): kỳ hiện tại, kỳ mới, kỳ cũ, lỗi kết nối; không cuộn ngang', async ({ page }) => {
    test.setTimeout(180_000)
    for (const w of [1440, 1280]) for (const theme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width: w, height: 900 })
      for (const [qs, name] of [['', 'current'], ['&fresh=1', 'fresh'], ['&past=1', 'past'], ['&unavailable=1', 'unavailable']] as const) {
        await openDashboard(page, qs, theme)
        expect(await noPageOverflow(page), `${w}-${theme}-${name}`).toBe(true)
        await dashShot(page, `desktop-${w}-${theme}-${name}`)
      }
    }
  })
})

test.describe('care B8.4 — /care mobile (frame) @mobile', () => {
  test.skip(!HAS_STATE, 'chưa có storageState super')
  test.use({ storageState: SUPER_STATE })

  test('360/393 sáng/tối: không cuộn ngang trang, ô KPI link ≥ 44px; ảnh', async ({ page }) => {
    const w = page.viewportSize()!.width
    for (const theme of ['light', 'dark'] as const) for (const [qs, name] of [['', 'current'], ['&fresh=1', 'fresh']] as const) {
      await openDashboard(page, qs, theme)
      expect(await noPageOverflow(page), `${w}-${theme}-${name}`).toBe(true)
      expect((await kpi(page, 'Chưa chăm sóc').boundingBox())!.height).toBeGreaterThanOrEqual(44)
      await dashShot(page, `mobile-${w}-${theme}-${name}`)
    }
  })
})

// ── B8.4 r1.1 (PM R1-01): kỳ 0 task vẫn hiện ô "Khách có đơn" đúng trạng thái N3; KPI 0 không link ───────────
test.describe('care B8.4 r1.1 — /care kỳ 0 task (frame) @desktop', () => {
  test.skip(!HAS_STATE, 'chưa có storageState super')
  test.use({ storageState: SUPER_STATE })

  test('0 task + N3 chưa đồng bộ: lời giải thích kỳ rỗng + ô "Khách có đơn" viền đứt "—"/"Chưa có dữ liệu" (không 0 giả); KPI 0 không link', async ({ page }) => {
    await openDashboard(page, '&empty=1')
    const f = page.getByTestId('catalog-frame-dashboard')
    await expect(f.getByText('Chưa có khách cần chăm sóc trong kỳ 10/2026')).toBeVisible()
    const orders = f.getByTestId('care-dashboard-orders').getByTestId('care-order-state')
    await expect(orders).toBeVisible()
    await expect(orders).toHaveAttribute('data-state', 'none')
    await expect(orders).toContainText('Chưa có dữ liệu')
    await expect(orders.locator('span.text-2xl')).toHaveText('—')
    await expect(f.locator('a[data-kpi-link]')).toHaveCount(0)
    await expect(f.locator('a[href^="/care/tasks"]')).toHaveCount(0)
    for (const label of ['Khách (task) trong kỳ', 'Hoàn thành', 'Chưa chăm sóc', 'Quá hạn đang mở']) await expect(kpi(page, label).locator('span.text-2xl')).toHaveText(/^0/)
    await expect(f.getByRole('heading', { name: 'Theo cửa hàng' })).toHaveCount(0)
    expect(await noPageOverflow(page)).toBe(true)
  })

  test('0 task + N3 đã đồng bộ: ô "Khách có đơn" hiện 0 THẬT + mốc đồng bộ; vẫn không link', async ({ page }) => {
    await openDashboard(page, '&empty=1&synced=1')
    const f = page.getByTestId('catalog-frame-dashboard')
    const orders = f.getByTestId('care-dashboard-orders').getByTestId('care-order-state')
    await expect(orders).toHaveAttribute('data-state', 'synced')
    await expect(orders.locator('span.text-2xl')).toHaveText('0')
    await expect(orders).toContainText('Cập nhật lúc 08:05 20/10/2026')
    await expect(orders.getByTestId('care-order-not-seen')).toHaveCount(0) // 0 task Hoàn thành ⇒ không câu "chưa thấy đơn"
    await expect(f.locator('a[href^="/care/tasks"]')).toHaveCount(0)
  })

  test('ảnh kỳ 0 task 1440/1280 sáng/tối (chưa đồng bộ + đã đồng bộ)', async ({ page }) => {
    test.setTimeout(120_000)
    for (const w of [1440, 1280]) for (const theme of ['light', 'dark'] as const) for (const [qs, name] of [['&empty=1', 'empty'], ['&empty=1&synced=1', 'empty-synced']] as const) {
      await page.setViewportSize({ width: w, height: 900 })
      await openDashboard(page, qs, theme)
      expect(await noPageOverflow(page), `${w}-${theme}-${name}`).toBe(true)
      await dashShot(page, `desktop-${w}-${theme}-${name}`)
    }
  })
})

test.describe('care B8.4 r1.1 — /care kỳ 0 task mobile @mobile', () => {
  test.skip(!HAS_STATE, 'chưa có storageState super')
  test.use({ storageState: SUPER_STATE })

  test('360/393 sáng/tối: ô "Khách có đơn" vẫn hiện, không cuộn ngang; ảnh', async ({ page }) => {
    const w = page.viewportSize()!.width
    for (const theme of ['light', 'dark'] as const) for (const [qs, name] of [['&empty=1', 'empty'], ['&empty=1&synced=1', 'empty-synced']] as const) {
      await openDashboard(page, qs, theme)
      await expect(page.getByTestId('care-dashboard-orders').getByTestId('care-order-state')).toBeVisible()
      expect(await noPageOverflow(page), `${w}-${theme}-${name}`).toBe(true)
      await dashShot(page, `mobile-${w}-${theme}-${name}`)
    }
  })
})

// ── B8.5: "Lịch sử chuyển giao" trên chi tiết khách browser (trang đầy đủ + drawer) ───────────────────────────
const SHOTS_B85 = path.resolve(__dirname, '..', 'qa-artifacts', 'b8-5')
const noOverflowInside = (loc: ReturnType<Page['locator']>) => loc.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)

test.describe('care B8.5 — Lịch sử chuyển giao (dữ liệu giả) @desktop', () => {
  test.skip(!HAS_STATE, 'chưa có storageState super')
  test.use({ storageState: SUPER_STATE })

  test('trang chi tiết: n = 2 lần, mới nhất trước, A → B + người chuyển + ghi chú; lịch sử chăm sóc KHÔNG lặp sự kiện chuyển giao; 0 lần ⇒ "Chưa có lần chuyển giao"', async ({ page }) => {
    await openCatalog(page)
    const det = page.getByTestId('catalog-care-detail')
    const box = det.getByTestId('care-transfer-history')
    await expect(box.getByRole('heading', { name: /Lịch sử chuyển giao/ })).toContainText('(2)')
    const items = box.getByTestId('care-transfer-item')
    await expect(items).toHaveCount(2)
    // "sang" là chữ ẩn cho trình đọc màn hình (mũi tên aria-hidden).
    await expect(items.nth(0)).toContainText(/QA Dược sĩ 02a \(QAOS02\) →(sang)? QA Dược sĩ 01a \(QAOS01\)/)   // 04/10 — mới nhất
    await expect(items.nth(0)).toContainText('Người chuyển: QA SM')
    await expect(items.nth(0)).toContainText('Ghi chú: QA: dược sĩ nghỉ phép')
    await expect(items.nth(0)).toContainText('04/10/2026')
    await expect(items.nth(1)).toContainText(/QA Dược sĩ 01a \(QAOS01\) →(sang)? QA Dược sĩ 02a \(QAOS02\)/)   // 02/10
    await expect(items.nth(1)).toContainText('Người chuyển: QA Super')
    // Khối nằm trong phần thông tin, ngay dưới "Dược sĩ phụ trách" (trước khối sản phẩm/lịch sử).
    const y = async (l: ReturnType<Page['locator']>) => (await l.boundingBox())!.y
    expect(await y(box)).toBeGreaterThan(await y(det.getByText('Dược sĩ phụ trách', { exact: true })))
    expect(await y(box)).toBeLessThan(await y(det.getByRole('heading', { name: /Sản phẩm cần chăm sóc/ })))
    // Không hiển thị cùng một sự kiện hai lần: lịch sử chăm sóc chỉ còn lượt chăm sóc + "Phân công từ file".
    const tl = det.getByTestId('care-timeline')
    await expect(tl.getByRole('heading', { name: 'Lịch sử chăm sóc' })).toBeVisible()
    await expect(tl.getByText('Chuyển giao', { exact: true })).toHaveCount(0)
    await expect(tl.getByText(/QA: dược sĩ nghỉ phép|QA: tạm giao cửa hàng 2/)).toHaveCount(0)
    await expect(tl.getByText('Phân công từ file', { exact: true })).toHaveCount(1)
    // 0 lần (khung QA, không event) ⇒ câu trống, không danh sách.
    const qa = page.getByTestId('catalog-care-detail-qa').getByTestId('care-transfer-history')
    await expect(qa).toContainText('Chưa có lần chuyển giao')
    await expect(qa.getByTestId('care-transfer-item')).toHaveCount(0)
    fs.mkdirSync(SHOTS_B85, { recursive: true })
    await hideShell(page)
    await saveLocatorShot(det, path.join(SHOTS_B85, 'desktop-detail-light.png'))
  })

  test('drawer ≥1280 (cạnh bảng): 1 lần chuyển giao của khách đó; khách chỉ có sự kiện import ⇒ "Chưa có lần chuyển giao"; không tràn ngang', async ({ page }) => {
    for (const theme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width: 1440, height: 900 })
      const fr = await openFrame(page, theme)
      await fr.getByTestId('care-task-table').getByRole('link', { name: 'KH QA 00002' }).click()
      const dr = page.getByTestId('care-task-drawer')
      await expect(dr.getByRole('heading', { name: 'KH QA 00002' })).toBeVisible()
      const box = dr.getByTestId('care-transfer-history')
      await expect(box.getByTestId('care-transfer-item')).toHaveCount(1)
      await expect(box).toContainText(/QA Dược sĩ 01b \(QAOS01\) →(sang)? QA Dược sĩ 01a/)
      await expect(box).toContainText('Người chuyển: QA SM')
      await expect(box).toContainText('Ghi chú: QA: chuyển để cân tải')
      await expect(dr.getByTestId('care-timeline').getByText('Chuyển giao', { exact: true })).toHaveCount(0)
      expect(await noOverflowInside(box)).toBe(true)
      // Drawer cạnh bảng rộng 400px (CareTaskDrawer w-[400px]) — khối chuyển giao nằm gọn trong đó.
      expect(Math.abs((await page.locator('aside[aria-label="Chi tiết khách"]').boundingBox())!.width - 400)).toBeLessThanOrEqual(1)
      expect((await box.boundingBox())!.width).toBeLessThanOrEqual(400)
      fs.mkdirSync(SHOTS_B85, { recursive: true })
      await hideShell(page)
      await page.screenshot({ path: path.join(SHOTS_B85, `desktop-1440-${theme}-drawer.png`), fullPage: true })
      await page.keyboard.press('Escape')
      await fr.getByTestId('care-task-table').getByRole('link', { name: 'KH QA 00001' }).click()
      await expect(dr.getByRole('heading', { name: 'KH QA 00001' })).toBeVisible()
      await expect(dr.getByTestId('care-transfer-history')).toContainText('Chưa có lần chuyển giao')
      await expect(dr.getByTestId('care-transfer-item')).toHaveCount(0)
      await expect(dr.getByTestId('care-timeline').getByText('Phân công từ file', { exact: true })).toHaveCount(1)
      await page.keyboard.press('Escape')
    }
  })
})

test.describe('care B8.5 — Lịch sử chuyển giao drawer mobile @mobile', () => {
  test.skip(!HAS_STATE, 'chưa có storageState super')
  test.use({ storageState: SUPER_STATE })

  test('360/393: drawer phủ màn có khối chuyển giao, không tràn ngang; ảnh', async ({ page }) => {
    const w = page.viewportSize()!.width
    const fr = await openFrame(page)
    await fr.getByTestId('care-task-table').getByRole('link', { name: 'KH QA 00002' }).click()
    const dlg = page.getByRole('dialog')
    await expect(dlg.getByRole('heading', { name: 'KH QA 00002' })).toBeVisible()
    const box = dlg.getByTestId('care-transfer-history')
    await expect(box.getByTestId('care-transfer-item')).toHaveCount(1)
    expect(await noOverflowInside(box)).toBe(true)
    expect(await noPageOverflow(page)).toBe(true)
    await box.scrollIntoViewIfNeeded()
    fs.mkdirSync(SHOTS_B85, { recursive: true })
    await page.screenshot({ path: path.join(SHOTS_B85, `mobile-${w}-drawer.png`) })
  })
})
