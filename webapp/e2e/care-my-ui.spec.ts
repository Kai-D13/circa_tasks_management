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
    // Ảnh chụp cả khối (cuộn tự động): thanh dính đáy B7-ui về vị trí luồng để không đè nội dung trong ảnh.
    document.querySelectorAll('[data-sticky-action]').forEach((el) => { (el as HTMLElement).style.position = 'static' })
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

  test('danh sách: khối tiến độ + chip có số (B7-ui M03), nhãn Quá hạn/Hẹn lại/Chưa chăm sóc, SĐT che, tìm qua POST, rỗng/lỗi', async ({ page }) => {
    const urls: string[] = []
    page.on('request', (r) => urls.push(r.url()))
    await openCatalog(page)
    expect(await noPageOverflow(page)).toBe(true)
    const home = page.getByTestId('catalog-care-my-home')
    // B7-ui M03: 4 thẻ số → 1 khối tiến độ (hoàn thành/được giao) + số đếm care_my_summary trên chip lọc.
    await expect(home.getByText('khách đã hoàn thành')).toBeVisible()
    await expect(home.getByRole('progressbar', { name: 'Tỉ lệ hoàn thành' })).toHaveAttribute('aria-valuenow', '20')
    // B7-ui r2 (artboard 08): chip "Tất cả 5" — số đếm tách màu nhạt, không ngoặc.
    for (const [name, n] of [['Tất cả', 5], ['Chưa chăm sóc', 1], ['Quá hạn', 1], ['Hoàn thành', 1]] as const) {
      await expect(home.getByRole('link', { name: new RegExp(`^${name}\\s?${n}$`) })).toBeVisible()
    }
    const list = home.getByRole('list', { name: 'Danh sách khách' })
    await expect(list.getByRole('listitem')).toHaveCount(5)
    for (const l of ['Quá hạn · hẹn 05/10', 'Hẹn chăm sóc lại 10/10', 'Hẹn chăm sóc lại 31/10', 'Chưa chăm sóc', 'Hoàn thành']) await expect(list.getByText(l, { exact: true })).toBeVisible()
    expect(await list.innerText()).not.toMatch(/0[35789]\d{8}/)
    for (const name of [/^Tất cả/, /^Quá hạn/]) expect((await home.getByRole('link', { name }).boundingBox())!.height).toBeGreaterThanOrEqual(44)
    expect((await list.getByRole('link').first().boundingBox())!.height).toBeGreaterThanOrEqual(44)
    // B7-ui r2: một ô tìm (type=search), gửi bằng phím Tìm/Enter của bàn phím — vẫn POST.
    const box = home.getByRole('searchbox', { name: 'Tìm tên hoặc SĐT khách' })
    await expect(box).toHaveAttribute('enterkeyhint', 'search')
    await box.fill('0390000011')
    await box.press('Enter')
    await expect(list.getByRole('listitem')).toHaveCount(1)
    await expect(home.getByText('1 khách khớp tìm kiếm')).toBeVisible()
    expect(urls.filter((u) => u.includes('0390000011'))).toEqual([])
    expect((await home.getByRole('button', { name: 'Bỏ tìm' }).boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await box.fill('qa-loi')
    await box.press('Enter')
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
    const historyBefore = await page.evaluate(() => history.length)
    await submit.dblclick()
    await expect.poll(() => page.url(), { timeout: 15_000 }).toContain('saved=1')
    expect(posts).toHaveLength(1)
    // B7-ui: lưu xong THAY trang form (router.replace) — "Quay lại" không mở lại form vừa gửi.
    expect(await page.evaluate(() => history.length)).toBe(historyBefore)
  })

  test('B7-ui M01: nút hành động chính dính đáy khung nhìn, không bị bottom nav che (chi tiết + form)', async ({ page }) => {
    await openCatalog(page)
    const vh = page.viewportSize()!.height
    const det = page.getByTestId('catalog-care-my-detail')
    await det.getByRole('tab', { name: 'Lịch sử chăm sóc' }).click()             // tab dài ⇒ nút nằm ngoài khung nếu không dính
    await expect(det.getByText(/^QA lượt #\d+$/)).toHaveCount(10)
    await det.getByRole('tablist').evaluate((el) => el.scrollIntoView({ block: 'start' }))
    const unobstructed = (sel: string) => page.locator(sel).first().evaluate((el) => {
      const r = el.getBoundingClientRect()
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return { top: r.top, bottom: r.bottom, hit: !!hit && el.contains(hit) }
    })
    const cta = await unobstructed('[data-testid="catalog-care-my-detail"] [data-sticky-action] a')
    expect(cta.bottom).toBeLessThanOrEqual(vh)
    expect(cta.top).toBeGreaterThan(vh / 2)                                        // dính đáy, không trôi giữa màn
    expect(cta.hit).toBe(true)                                                    // không bị nav/phần tử khác đè
    const form = page.getByTestId('care-interaction-form')
    await form.getByRole('radiogroup', { name: 'Kết quả chăm sóc' }).evaluate((el) => el.scrollIntoView({ block: 'start' }))
    const save = await unobstructed('[data-testid="care-interaction-form"] [data-sticky-action] button[type="submit"]')
    expect(save.bottom).toBeLessThanOrEqual(vh)
    expect(save.hit).toBe(true)
    await expect(form.getByText('Còn thiếu: kết quả, ghi chú')).toBeVisible()      // gợi ý, KHÔNG phải role=alert
    await expect(form.getByRole('alert')).toHaveCount(0)
  })

  test('B7-ui M05: outcome chia 2 nhóm (một radiogroup), ngày hẹn có nút nhanh trong [hôm nay, hạn] + hiện dd/mm/yyyy', async ({ page }) => {
    await openCatalog(page)
    const form = page.getByTestId('care-interaction-form')
    const group = form.getByRole('radiogroup', { name: 'Kết quả chăm sóc' })
    await expect(group.getByRole('radio')).toHaveCount(6)
    await expect(group.getByText('Cần liên hệ lại', { exact: true })).toBeVisible()
    await expect(group.getByText('Kết thúc chăm sóc khách này', { exact: true })).toBeVisible()
    for (const r of await group.getByRole('radio').all()) {
      expect((await r.locator('xpath=ancestor::label').boundingBox())!.height).toBeGreaterThanOrEqual(44)
    }
    await group.getByRole('radio', { name: /Không liên hệ được/ }).check()
    const quick = form.getByRole('group', { name: 'Chọn nhanh ngày hẹn' })
    await quick.getByRole('button', { name: '+7 ngày' }).click()                  // mock hôm nay 10/10 (Thứ bảy)
    await expect(form.getByLabel('Ngày hẹn chăm sóc lại (bắt buộc)')).toHaveValue('2026-10-17')
    await expect(form.getByText('17/10/2026 (Thứ bảy)')).toBeVisible()         // r2: ô hiển thị dd/mm/yyyy (Thứ …)
    await expect(quick.getByRole('button', { name: '+7 ngày' })).toHaveAttribute('aria-pressed', 'true')
  })

  test('dark mode: danh sách + chi tiết + form', async ({ page }) => {
    await openCatalog(page, 'dark')
    const w = page.viewportSize()!.width
    await shot(page, 'catalog-care-my-home', `mobile-${w}-dark-home`)
    await shot(page, 'catalog-care-my-detail', `mobile-${w}-dark-detail`)
    await shot(page, 'catalog-care-my-form', `mobile-${w}-dark-form`)
  })
})

// B7-ui r2 — khung MỘT màn theo bố cục trang thật (CareMyScreen + CareMyHeader), artboard 08/09/10.
// Catalog không nằm dưới /care/my nên MobileHeader cam + bottom nav vẫn render: `asRoute` ẩn header cam (route
// thật: MobileHeader trả null) và với màn con gỡ dấu [data-bottom-nav] + ẩn nav (route thật: BottomNav trả null)
// — đúng điều kiện CSS globals.css áp cho <main>.
test.describe('care B7-ui r2 — khung màn thật (?frame=) @mobile', () => {
  test.skip(!HAS_SUPER, 'chưa có storageState super')
  test.use({ storageState: SUPER_STATE })

  async function openFrame(page: Page, frame: string, opts: { qa?: boolean; child?: boolean } = {}) {
    await page.goto(`/ui-catalog/care-my?frame=${frame}${opts.qa ? '&qa=1' : ''}`)
    await page.locator('[data-care-screen]').waitFor({ timeout: 20_000 })
    await page.evaluate((child) => {
      document.querySelectorAll('header.bg-primary, nextjs-portal').forEach((el) => { (el as HTMLElement).style.display = 'none' })
      if (child) document.querySelectorAll('[data-bottom-nav]').forEach((el) => { el.removeAttribute('data-bottom-nav'); (el as HTMLElement).style.display = 'none' })
    }, !!opts.child)
  }
  const barBox = (page: Page) => page.locator('[data-sticky-action]').first().evaluate((el) => {
    const r = el.getBoundingClientRect()
    const btn = el.querySelector('a, button[type="submit"]')!.getBoundingClientRect()
    const hit = document.elementFromPoint(btn.x + btn.width / 2, btn.y + btn.height / 2)
    return { top: r.top, bottom: r.bottom, hit: !!hit && el.contains(hit), vh: window.innerHeight, mainPB: getComputedStyle(document.querySelector('main')!).paddingBottom }
  })

  test('header riêng: tiêu đề, quay lại/huỷ về màn cha ≥44px, avatar mở sheet "Tài khoản"; không chip QA ở production', async ({ page }) => {
    await openFrame(page, 'list')
    const list = page.locator('header', { has: page.getByRole('heading', { name: 'Khách hàng của tôi' }) })
    await expect(list).toBeVisible()
    await expect(list.getByRole('link')).toHaveCount(0)                                // màn gốc tab: không quay lại
    await expect(page.getByTestId('care-qa-chip')).toHaveCount(0)
    const avatar = list.getByRole('button', { name: 'Tài khoản' })
    expect((await avatar.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await avatar.click()
    await expect(page.getByRole('dialog', { name: 'Tài khoản' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Tài khoản' })).toHaveCount(0)
    expect(await noPageOverflow(page)).toBe(true)

    await openFrame(page, 'detail', { child: true })
    const det = page.locator('header', { has: page.getByRole('heading', { name: 'Chăm sóc khách' }) })
    const back = det.getByRole('link', { name: 'Quay lại Khách hàng của tôi' })
    await expect(back).toHaveAttribute('href', '/ui-catalog/care-my?frame=list')
    expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    expect(await noPageOverflow(page)).toBe(true)

    await openFrame(page, 'update', { child: true })
    const upd = page.locator('header', { has: page.getByRole('heading', { name: 'Ghi nhận chăm sóc' }) })
    await expect(upd.getByText('KH QA 00701')).toBeVisible()                           // tên khách ở dòng phụ header
    const close = upd.getByRole('link', { name: 'Huỷ, quay lại Chi tiết khách' })
    await expect(close).toHaveAttribute('href', '/ui-catalog/care-my?frame=detail')
    expect((await close.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    // Mở trực tiếp (không có mục lịch sử là màn cha) ⇒ đi tới màn cha cố định.
    await close.click()
    await expect(page).toHaveURL(/frame=detail$/)
    expect(await noPageOverflow(page)).toBe(true)
  })

  test('thanh hành động SÁT ĐÁY màn con: nội dung ngắn lẫn khi cuộn; <main> không chừa chỗ nav; không đè mục cuối', async ({ page }) => {
    await openFrame(page, 'detail', { child: true })
    let b = await barBox(page)                                                       // tab Tổng quan: nội dung ngắn
    expect(b.mainPB).toBe('0px')
    expect(Math.abs(b.bottom - b.vh)).toBeLessThanOrEqual(1)
    expect(b.hit).toBe(true)
    await page.getByRole('tab', { name: 'Lịch sử chăm sóc' }).click()
    await expect(page.getByText(/^QA lượt #\d+$/)).toHaveCount(10)
    await page.locator('main').evaluate((m) => m.scrollTo({ top: m.scrollHeight / 2 }))
    b = await barBox(page)                                                           // đang cuộn giữa danh sách dài
    expect(Math.abs(b.bottom - b.vh)).toBeLessThanOrEqual(1)
    expect(b.hit).toBe(true)
    await page.locator('main').evaluate((m) => m.scrollTo({ top: m.scrollHeight }))
    b = await barBox(page)
    const lastBottom = await page.getByRole('button', { name: 'Xem thêm lượt cũ hơn' }).evaluate((el) => el.getBoundingClientRect().bottom)
    expect(lastBottom).toBeLessThanOrEqual(b.top + 1)                               // cuối trang: không bị thanh che
    // Tab dính dưới header khi cuộn.
    const tabTop = await page.getByRole('tablist').evaluate((el) => el.getBoundingClientRect().top)
    expect(Math.round(tabTop)).toBe(52)

    await openFrame(page, 'update', { child: true })
    b = await barBox(page)
    expect(Math.abs(b.bottom - b.vh)).toBeLessThanOrEqual(1)
    expect(b.hit).toBe(true)
    await expect(page.getByText('Còn thiếu: kết quả, ghi chú')).toBeVisible()
  })

  test('bàn phím (khung nhìn thấp): ô ghi chú được cuộn lên TRÊN thanh Lưu, không bị che', async ({ page }) => {
    await page.setViewportSize({ width: page.viewportSize()!.width, height: 420 })
    await openFrame(page, 'update', { child: true })
    await page.locator('main').evaluate((m) => m.scrollTo({ top: 0 }))
    await page.getByLabel('Ghi chú (bắt buộc)').focus()                               // focus như khi bàn phím bật lên
    await page.waitForTimeout(200)
    const note = await page.getByLabel('Ghi chú (bắt buộc)').evaluate((el) => el.getBoundingClientRect())
    const b = await barBox(page)
    expect(note.bottom).toBeLessThanOrEqual(b.top + 1)
    expect(note.top).toBeGreaterThanOrEqual(0)
  })

  test('chip QA (chỉ chế độ QA): ≥44px, mở sheet nội dung Q-107 — Gọi/Nhắn mở ứng dụng của máy, app không tự gọi', async ({ page }) => {
    await openFrame(page, 'detail', { qa: true, child: true })
    const chip = page.getByTestId('care-qa-chip')
    await expect(chip).toHaveAccessibleName('Chế độ QA — xem chi tiết')
    const chipBox = (await chip.boundingBox())!
    expect(chipBox.height).toBeGreaterThanOrEqual(44)
    expect(chipBox.width).toBeGreaterThanOrEqual(44)
    await chip.click()
    const sheet = page.getByRole('dialog', { name: /Chế độ QA/ })
    await expect(sheet).toContainText('mở ứng dụng gọi/SMS của máy với số QA giả — app không tự gọi hay gửi')
    await expect(sheet).not.toContainText('không gọi/nhắn')
    await sheet.getByRole('button', { name: 'Đã hiểu' }).click()
    await expect(sheet).toHaveCount(0)
    // Q-107: vẫn đúng 2 link tel:/sms: với số QA đang hiện.
    await expect(page.locator('a[href^="tel:"], a[href^="sms:"]')).toHaveCount(2)
    await expect(page.getByTestId('care-contact-qa')).toContainText('khách QA giả')
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
    // B7-ui r2: route thật — header riêng của trang, MobileHeader cam KHÔNG render (không chồng 2 header).
    await expect(page.locator('header.bg-primary')).toHaveCount(0)
    await expect(page.locator('header:visible')).toHaveCount(1)
    await expect(page.getByRole('heading', { level: 1, name: 'Khách hàng của tôi' })).toBeVisible()
    await expect(page.getByTestId('care-qa-chip')).toHaveCount(0)
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
// Q-107 (B7-ui r1.1, thay PM r1 P1): chế độ QA cũng mở tel:/sms: — số trong href = số QA đang hiển thị của task đó;
// chỉ thêm dòng nhận biết số giả. (Nguồn số = task is_test của batch marker: care-qa-ui.spec — PGlite + kiểm nguồn.)
test.describe('care B7-ui r1.1 — chế độ QA mở Gọi/Nhắn bằng số khách QA @desktop @mobile', () => {
  test.skip(!HAS_SUPER, 'chưa có storageState super')
  test.use({ storageState: SUPER_STATE })

  test('màn dược sĩ + màn chi tiết admin: QA có tel:/sms: đúng số QA hiển thị, nút ≥44px; production y nguyên', async ({ page }) => {
    await page.goto('/ui-catalog/care-my')
    const prodMy = page.getByTestId('catalog-care-my-detail')
    const qaMy = page.getByTestId('catalog-care-my-detail-qa')
    await qaMy.waitFor({ timeout: 20_000 })
    for (const [sec, shown] of [[prodMy, '0390 000 010'], [qaMy, '0390000015']] as const) {
      await expect(sec.getByText(shown, { exact: true })).toBeVisible()                 // số hiển thị
      const digits = shown.replace(/\D/g, '')
      const call = sec.getByRole('link', { name: 'Gọi khách' })
      const sms = sec.getByRole('link', { name: 'Nhắn tin' })
      await expect(call).toHaveAttribute('href', `tel:${digits}`)                        // href = đúng số đang hiển thị
      await expect(sms).toHaveAttribute('href', `sms:${digits}`)
      await expect(sec.locator('a[href^="tel:"], a[href^="sms:"]')).toHaveCount(2)
      for (const l of [call, sms]) expect((await l.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    }
    await expect(qaMy.getByTestId('care-contact-qa')).toContainText('khách QA giả')
    await expect(prodMy.getByTestId('care-contact-qa')).toHaveCount(0)
    expect(await noPageOverflow(page)).toBe(true)

    await page.goto('/ui-catalog/care-browse')
    const prodDet = page.getByTestId('catalog-care-detail')
    const qaDet = page.getByTestId('catalog-care-detail-qa')
    await qaDet.waitFor({ timeout: 20_000 })
    for (const [sec, shown] of [[prodDet, '0390 000 002'], [qaDet, '0390000002']] as const) {
      await expect(sec.locator('a[href^="tel:"]')).toHaveCount(1)
      await expect(sec.locator('a[href^="sms:"]')).toHaveCount(0)
      await expect(sec.getByRole('link', { name: shown, exact: true })).toHaveAttribute('href', `tel:${shown.replace(/\D/g, '')}`)
    }
    await expect(qaDet.getByTestId('care-contact-qa')).toContainText('khách QA giả')
    await expect(prodDet.getByTestId('care-contact-qa')).toHaveCount(0)
  })
})
