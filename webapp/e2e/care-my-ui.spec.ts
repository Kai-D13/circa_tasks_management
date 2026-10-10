import fs from 'node:fs'
import path from 'node:path'
import { test, expect, request as pwRequest, type Page, type Request } from '@playwright/test'
import { SUPER_STATE, STAFF_STATE, MANAGER_STATE } from './authState'
import { saveLocatorShot } from './qaShot'

// CRM-CSKH B4 — UI màn dược sĩ (mobile).
// • Mock /ui-catalog/care-my (UI_CATALOG=1 + super, DỮ LIỆU GIẢ, action giả) — DB chưa có 114.
// • Smoke thật cờ OFF (server QA mặc định): /care/my* 404, nav giữ Tồn kho, /tasks không CTA.
// • Smoke thật cờ ON (server thứ hai, E2E_CARE_ON_URL, CARE_ENABLED=true): tab CSKH thay Tồn
//   kho, CTA /tasks, /care/my báo "chưa sẵn sàng" (DB chưa có 114), QLCH/super 404.
// Ảnh chụp chỉ phần nội dung, lưu qa-artifacts/ (gitignored).

const HAS_SUPER = fs.existsSync(SUPER_STATE)
const SHOTS = path.resolve(__dirname, '..', 'qa-artifacts', 'care-b4-ui')
const CARE_ON = process.env.E2E_CARE_ON_URL
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

async function openCatalog(page: Page, theme: 'light' | 'dark' = 'light') {
  await page.goto('/ui-catalog/care-my')
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
  await page.getByTestId('care-my-home').first().waitFor({ timeout: 20_000 })
}
async function shot(page: Page, testId: string, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.evaluate(() => {
    document.querySelectorAll('header.bg-primary, aside.bg-sidebar, nav[aria-label="Điều hướng chính"], nextjs-portal').forEach((el) => { (el as HTMLElement).style.display = 'none' })
    const main = document.querySelector('main')
    const outer = main?.parentElement
    if (outer instanceof HTMLElement) { outer.style.height = 'auto'; outer.style.overflow = 'visible' }
    if (main instanceof HTMLElement) { main.style.overflow = 'visible' }
  })
  await saveLocatorShot(page.getByTestId(testId), path.join(SHOTS, `${name}.png`))
}
const noPageOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
const isRecordPost = (r: Request) => r.method() === 'POST' && !!r.headers()['next-action'] && (r.postData() ?? '').includes('proofUrls')

test.describe('care B4 — màn dược sĩ (mock) @mobile', () => {
  test.skip(!HAS_SUPER, 'chưa có storageState super')
  test.use({ storageState: SUPER_STATE })

  test('danh sách: 4 thẻ tổng, nhãn Quá hạn/Hẹn lại/Chưa chăm sóc, SĐT che, tìm qua POST, rỗng/lỗi', async ({ page }) => {
    const urls: string[] = []
    page.on('request', (r) => urls.push(r.url()))
    await openCatalog(page)
    expect(await noPageOverflow(page)).toBe(true)
    const home = page.getByTestId('catalog-care-my-home')
    for (const l of ['Được giao', 'Chưa chăm sóc', 'Hoàn thành', 'Quá hạn đang mở']) await expect(home.getByText(l, { exact: true }).first()).toBeVisible()
    const list = home.getByRole('list', { name: 'Danh sách khách' })
    await expect(list.getByRole('listitem')).toHaveCount(5)
    for (const l of ['Quá hạn · hẹn 05/10', 'Hẹn chăm sóc lại 10/10', 'Hẹn chăm sóc lại 31/10', 'Chưa chăm sóc', 'Hoàn thành']) await expect(list.getByText(l, { exact: true })).toBeVisible()
    expect(await list.innerText()).not.toMatch(/0[35789]\d{8}/)
    for (const name of ['Tất cả', 'Quá hạn']) expect((await home.getByRole('link', { name, exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44)
    expect((await list.getByRole('link').first().boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await home.getByRole('textbox', { name: 'Tìm tên hoặc SĐT khách' }).fill('0390000011')
    await home.getByRole('button', { name: 'Tìm', exact: true }).click()
    await expect(list.getByRole('listitem')).toHaveCount(1)
    expect(urls.filter((u) => u.includes('0390000011'))).toEqual([])
    await home.getByRole('textbox', { name: 'Tìm tên hoặc SĐT khách' }).fill('qa-loi')
    await home.getByRole('button', { name: 'Tìm', exact: true }).click()
    await expect(home.getByText('Không tải được danh sách — thử lại.')).toBeVisible()
    await expect(page.getByTestId('catalog-care-my-empty').getByText('Không có khách theo bộ lọc này')).toBeVisible()
    await shot(page, 'catalog-care-my-home', `mobile-${page.viewportSize()!.width}-home`)
  })

  test('chi tiết 3 tab: ảnh sản phẩm CHỈ tải ở tab Sản phẩm; lịch sử 10 + "Xem thêm"; Gọi/Nhắn; chỉ đọc khi đã kết thúc', async ({ page }) => {
    const cdn: string[] = []
    await page.route('https://cdn-gcs.thuocsi.vn/**', (r) => { cdn.push(r.request().url()); return r.fulfill({ status: 200, contentType: 'image/png', body: PNG_1PX }) })
    const gcs: string[] = []
    await page.route('https://storage.googleapis.com/**', (r) => { gcs.push(r.request().url()); return r.fulfill({ status: 200, contentType: 'image/png', body: PNG_1PX }) })
    // Q-85: ảnh của lượt #49 giả lập object đã mất (404) ⇒ ô "Không tải được ảnh". Route đăng ký SAU thắng.
    await page.route('**/care-proof/**/1700000000002_abcd1202.jpg', (r) => { gcs.push(r.request().url()); return r.fulfill({ status: 404, body: '' }) })
    await openCatalog(page)
    const det = page.getByTestId('catalog-care-my-detail')
    await expect(det.getByRole('tab', { name: 'Tổng quan' })).toHaveAttribute('aria-selected', 'true')
    await expect(det.getByRole('link', { name: /Gọi/ })).toHaveAttribute('href', /^tel:0\d{9}$/)
    await expect(det.getByRole('link', { name: 'Nhắn tin' })).toHaveAttribute('href', /^sms:0\d{9}$/)
    await page.waitForTimeout(500)
    expect(cdn).toEqual([])                                                    // chưa mở tab Sản phẩm ⇒ không tải ảnh
    await shot(page, 'catalog-care-my-detail', `mobile-${page.viewportSize()!.width}-detail-overview`)
    await det.getByRole('tab', { name: 'Sản phẩm' }).click()
    await expect(det.getByText('Sản phẩm QA 0001')).toBeVisible()
    await expect.poll(() => cdn.length).toBeGreaterThanOrEqual(2)
    await shot(page, 'catalog-care-my-detail', `mobile-${page.viewportSize()!.width}-detail-products`)
    await det.getByRole('tab', { name: 'Lịch sử chăm sóc' }).click()
    const items = det.getByText(/^QA lượt #\d+$/)
    await expect(items).toHaveCount(10)
    // Q-83: ghi chú chuyển giao của SM hiển thị cho dược sĩ đang phụ trách.
    await expect(det.getByText('Ghi chú: QA ghi chú SM: khách hẹn gọi buổi chiều')).toBeVisible()
    // Ảnh tải lỗi ⇒ ô chữ nhẹ, không link/không <img> vỡ; ảnh còn lại vẫn là thumbnail mở được.
    await expect(det.getByTestId('care-proof-failed')).toHaveText('Không tải được ảnh')
    await expect(det.locator('img[src*="1700000000002_abcd1202"]')).toHaveCount(0)
    await expect(det.getByRole('link', { name: 'Xem ảnh minh chứng 1' })).toHaveCount(1)
    await expect(det.getByRole('link', { name: 'Xem ảnh minh chứng 1' })).toBeVisible()
    await det.getByRole('button', { name: 'Xem thêm lượt cũ hơn' }).dblclick()
    await expect(items).toHaveCount(13)
    await expect(det.getByRole('button', { name: 'Xem thêm lượt cũ hơn' })).toHaveCount(0)
    // Q-85: lượt #38 (20/06, quá 90 ngày so với "hôm nay" mock 10/10) ⇒ thông báo hết hạn, không link, không tải ảnh.
    await expect(det.getByTestId('care-proof-expired')).toHaveText('Ảnh minh chứng đã hết thời hạn lưu')
    await expect(det.getByTestId('care-proof-expired').getByRole('link')).toHaveCount(0)
    await page.waitForTimeout(300)
    expect(gcs.filter((u) => u.includes('1700000000003_abcd1203'))).toEqual([])
    await expect(det.getByRole('link', { name: /Xem ảnh minh chứng/ })).toHaveCount(1)
    await shot(page, 'catalog-care-my-detail', `mobile-${page.viewportSize()!.width}-detail-history`)
    await expect(det.getByRole('link', { name: 'Ghi nhận chăm sóc' })).toBeVisible()
    const ro = page.getByTestId('catalog-care-my-readonly')
    await expect(ro.getByRole('link', { name: 'Ghi nhận chăm sóc' })).toHaveCount(0)
    await expect(ro.getByText('Khách đã kết thúc chăm sóc — chỉ xem.')).toBeVisible()
    expect(await noPageOverflow(page)).toBe(true)
  })

  test('form: outcome quyết định ngày hẹn, ghi chú bắt buộc, lỗi RPC giữ nội dung, bấm đúp chỉ gửi 1, ảnh lỗi vẫn lưu được', async ({ page }) => {
    const posts: Request[] = []
    page.on('request', (r) => { if (isRecordPost(r)) posts.push(r) })
    await openCatalog(page)
    const form = page.getByTestId('care-interaction-form')
    const submit = form.getByRole('button', { name: 'Lưu lượt chăm sóc' })
    await submit.click()
    await expect(form.getByRole('alert')).toHaveText('Chọn một kết quả chăm sóc.')
    // Bàn phím: chọn outcome bằng phím cách.
    await form.getByRole('radio', { name: /Hẹn chăm sóc lại/ }).focus()
    await page.keyboard.press('Space')
    await expect(form.getByRole('radio', { name: /Hẹn chăm sóc lại/ })).toBeChecked()
    const date = form.getByLabel('Ngày hẹn chăm sóc lại (bắt buộc)')
    await expect(date).toHaveAttribute('min', '2026-10-10')
    await expect(date).toHaveAttribute('max', '2026-10-31')
    await form.getByLabel('Ghi chú (bắt buộc)').fill('QA gọi lại')
    await submit.click()
    await expect(form.getByRole('alert')).toHaveText('Kết quả này bắt buộc chọn ngày hẹn chăm sóc lại.')
    await form.getByRole('radio', { name: /Từ chối chăm sóc/ }).check()
    await expect(date).toHaveCount(0)
    await expect(form.getByText('Khách từ chối sẽ không được giao chăm sóc lại tại cửa hàng này.')).toBeVisible()
    await form.getByRole('radio', { name: /Khách quan tâm/ }).check()
    await form.getByLabel('Ghi chú (bắt buộc)').fill('   ')
    await submit.click()
    await expect(form.getByRole('alert')).toHaveText('Ghi chú bắt buộc (1–500 ký tự).')
    // Ảnh tùy chọn: upload lỗi (server QA tắt cờ ⇒ không cấp URL) ⇒ báo lỗi, bỏ ảnh, vẫn lưu được.
    await form.locator('#care-proof-input').setInputFiles({ name: 'ten-khach-0901234567.png', mimeType: 'image/png', buffer: PNG_1PX })
    await expect(form.getByText('Ảnh lỗi sẽ không được gửi — có thể bỏ ảnh và vẫn lưu lượt chăm sóc.')).toBeVisible({ timeout: 15_000 })
    expect(await form.innerText()).not.toContain('ten-khach')                // không hiện tên file gốc
    await shot(page, 'catalog-care-my-form', `mobile-${page.viewportSize()!.width}-form-error`)
    await form.getByRole('button', { name: 'Bỏ Ảnh 1' }).click()
    // Lỗi RPC (vd. vừa bị chuyển giao) ⇒ thông báo an toàn, giữ nội dung.
    await form.getByLabel('Ghi chú (bắt buộc)').fill('QA-RPC-LOI khách quan tâm')
    await submit.click()
    await expect(form.getByRole('alert')).toHaveText('Khách này không còn được giao cho bạn (có thể vừa được chuyển giao).', { timeout: 10_000 })
    await expect(form.getByLabel('Ghi chú (bắt buộc)')).toHaveValue('QA-RPC-LOI khách quan tâm')
    await expect(form.getByRole('radio', { name: /Khách quan tâm/ })).toBeChecked()
    posts.length = 0
    await form.getByLabel('Ghi chú (bắt buộc)').fill('QA khách quan tâm, hẹn ghé cửa hàng')
    expect((await submit.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await submit.dblclick()
    await expect.poll(() => page.url(), { timeout: 15_000 }).toContain('saved=1')
    expect(posts).toHaveLength(1)
  })

  test('dark mode: danh sách + chi tiết + form', async ({ page }) => {
    await openCatalog(page, 'dark')
    const w = page.viewportSize()!.width
    await shot(page, 'catalog-care-my-home', `mobile-${w}-dark-home`)
    await shot(page, 'catalog-care-my-detail', `mobile-${w}-dark-detail`)
    await shot(page, 'catalog-care-my-form', `mobile-${w}-dark-form`)
  })
})

test.describe('care B4 — thật, cờ CARE_ENABLED tắt (mặc định) @mobile', () => {
  test.skip(!fs.existsSync(STAFF_STATE), 'chưa có storageState staff')
  test.skip(process.env.CARE_ENABLED === 'true', 'server QA đang bật cờ CRM')
  test.use({ storageState: STAFF_STATE })

  test('staff: /care/my* 404, nav giữ Tồn kho (không CSKH), /tasks không CTA', async ({ page }) => {
    for (const p of ['/care/my', '/care/my/00000000-0000-4000-8000-000000000001', '/care/my/00000000-0000-4000-8000-000000000001/update']) {
      expect((await page.goto(p))!.status(), p).toBe(404)
    }
    await page.goto('/tasks')
    await expect(page.locator('a[href="/inventory"]:visible').first()).toBeVisible()
    await expect(page.locator('a[href="/care/my"]')).toHaveCount(0)
    await expect(page.getByTestId('care-cta')).toHaveCount(0)
  })
})

test.describe('care B4 — chưa đăng nhập @desktop', () => {
  test('/care/my ⇒ /login', async ({ baseURL }) => {
    const ctx = await pwRequest.newContext({ baseURL, storageState: { cookies: [], origins: [] } })
    const res = await ctx.get('/care/my', { maxRedirects: 0 })
    expect([302, 307]).toContain(res.status())
    expect(res.headers()['location']).toContain('/login')
    await ctx.dispose()
  })
})

test.describe('care B4 — thật, cờ CARE_ENABLED BẬT (server riêng E2E_CARE_ON_URL) @mobile', () => {
  test.skip(!CARE_ON || !fs.existsSync(STAFF_STATE), 'cần E2E_CARE_ON_URL (server QA thứ hai bật CARE_ENABLED) + storageState staff')

  // Prod đã cài 114 (pha a, 10/10/2026) ⇒ /care/my dựng màn thật. Tài khoản staff E2E (dược sĩ QA) không có task
  // thật nào trong kỳ (QA is_test bị ẩn ở production) ⇒ thẻ tóm tắt 0 + empty state thật, không báo "chưa sẵn sàng".
  test('staff: tab CSKH thay Tồn kho (active ở /care/my), CTA /tasks, /care/my dựng màn thật (114 đã có) — rỗng, số 0 thật', async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: CARE_ON, storageState: STAFF_STATE })
    const page = await ctx.newPage()
    await page.goto('/tasks')
    const cta = page.locator('[data-testid="care-cta"]:visible')
    await expect(cta).toBeVisible()
    await expect(cta).toHaveAttribute('href', '/care/my')
    expect((await cta.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    const tab = page.locator('a[href="/care/my"][aria-label="CSKH"]:visible')
    await expect(tab).toBeVisible()
    await expect(page.locator('a[href="/inventory"]')).toHaveCount(0)
    await tab.click()
    await page.waitForURL(/\/care\/my$/)
    await expect(tab).toHaveAttribute('aria-current', 'page')
    const home = page.getByTestId('care-my-home')
    await expect(home).toBeVisible()
    await expect(page.getByText('Hệ thống chăm sóc khách hàng chưa sẵn sàng.')).toHaveCount(0)
    await expect(home.getByText('Chưa có khách nào được giao trong tháng')).toBeVisible()
    await expect(home.getByRole('list', { name: 'Danh sách khách' })).toHaveCount(0)
    expect(await noPageOverflow(page)).toBe(true)
    await ctx.close()
  })

  test('QLCH và super: /care/my 404 dù cờ bật', async ({ browser }) => {
    for (const st of [MANAGER_STATE, SUPER_STATE]) {
      if (!fs.existsSync(st)) continue
      const ctx = await browser.newContext({ baseURL: CARE_ON, storageState: st })
      const page = await ctx.newPage()
      expect((await page.goto('/care/my'))!.status(), st).toBe(404)
      await ctx.close()
    }
  })
})

// Nhánh "DB chưa có 114 / RPC lỗi" không còn tái hiện được trên prod ⇒ giữ bằng kiểm nguồn tất định (không DB).
test.describe('care B4 — nhánh chưa sẵn sàng (nguồn, không DB) @desktop', () => {
  const read = (f: string) => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n')
  test('/care/my: loader lỗi (care_my_summary/RLS) ⇒ CareNotReadyError ⇒ CHỈ ErrorState "chưa sẵn sàng", không dựng danh sách', () => {
    const page = read('app/(dashboard)/care/my/page.tsx')
    const caught = /\} catch \{\n([\s\S]*?)\n  \}\n\}/.exec(page)![1]
    expect(caught).toContain('<ErrorState message="Hệ thống chăm sóc khách hàng chưa sẵn sàng."')
    expect(caught).not.toContain('CareMyHome')
    const my = read('lib/care/server/my.ts')
    expect(my).toMatch(/const \{ data, error \} = await supabase\.rpc\('care_my_summary'\)\n\s*if \(error\) throw new CareNotReadyError\(\)/)
    expect(my).toMatch(/\} catch \{\n\s*throw new CareNotReadyError\(\)\n\s*\}/)
  })
})

// B6-qa-ui (PM r1 P1): chế độ QA local hiện SĐT giả dạng chữ — KHÔNG có tel:/sms: (số giả có thể là số người thật);
// production giữ nguyên liên kết. Kiểm trên desktop + mobile 390/360 bằng hai trang catalog (component dùng chung trang thật).
test.describe('care B6-qa-ui — chế độ QA không có liên kết gọi/nhắn @desktop @mobile', () => {
  test.skip(!HAS_SUPER, 'chưa có storageState super')
  test.use({ storageState: SUPER_STATE })

  test('màn dược sĩ + màn chi tiết admin: QA 0 tel:/sms:, hiện số dạng chữ; production vẫn có liên kết', async ({ page }) => {
    await page.goto('/ui-catalog/care-my')
    const prodMy = page.getByTestId('catalog-care-my-detail')
    const qaMy = page.getByTestId('catalog-care-my-detail-qa')
    await qaMy.waitFor({ timeout: 20_000 })
    await expect(prodMy.locator('a[href^="tel:"]')).toHaveCount(1)
    await expect(prodMy.locator('a[href^="sms:"]')).toHaveCount(1)
    await expect(qaMy.locator('a[href^="tel:"], a[href^="sms:"]')).toHaveCount(0)
    await expect(qaMy.getByTestId('care-contact-disabled')).toContainText('0390000015')
    await expect(qaMy.getByTestId('care-contact-disabled')).toContainText('không gọi')
    expect(await noPageOverflow(page)).toBe(true)

    await page.goto('/ui-catalog/care-browse')
    const prodDet = page.getByTestId('catalog-care-detail')
    const qaDet = page.getByTestId('catalog-care-detail-qa')
    await qaDet.waitFor({ timeout: 20_000 })
    await expect(prodDet.locator('a[href^="tel:"]')).toHaveCount(1)
    await expect(qaDet.locator('a[href^="tel:"], a[href^="sms:"]')).toHaveCount(0)
    await expect(qaDet.getByTestId('care-contact-disabled')).toContainText('0390000002')
  })
})
