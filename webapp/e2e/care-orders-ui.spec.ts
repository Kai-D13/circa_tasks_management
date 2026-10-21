import fs from 'node:fs'
import path from 'node:path'
import { test, expect, request as pwRequest, type Page } from '@playwright/test'
import { SUPER_STATE } from './authState'
import { saveLocatorShot } from './qaShot'

// CRM-CSKH E3 — UI "đơn xác thực sau import" (thiết kế E0 r3.4 §5 / §9) trên /ui-catalog/care-orders + /ui-catalog/care-my
// (UI_CATALOG=1 + super; DỮ LIỆU GIẢ, mã đơn DHC-QA…). Kiểm: nhãn trạng thái từng ca §5, "Xem thêm", sao chép mã (aria-live),
// ≥ 44 px trên mobile, không cuộn ngang 360/390, sáng/tối; mã đơn KHÔNG nằm trong URL / title / data-* / aria-label.
// Cờ OFF (server thật): route E 503, /care/orders 404, trang báo cáo / chi tiết không có khối đơn (kiểm nguồn).

const HAS_STATE = fs.existsSync(SUPER_STATE)
const SHOTS = path.resolve(__dirname, '..', 'qa-artifacts', 'care-e3-ui')
const ROOT = path.resolve(__dirname, '..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n')
const DHC = /DHC-QA-\d+/

async function open(page: Page, url: string, testId: string, theme: 'light' | 'dark' = 'light') {
  await page.goto(url)
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
  await page.getByTestId(testId).first().waitFor({ timeout: 30_000 })
  await page.waitForLoadState('networkidle')
}
const noPageOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
/** Mọi thuộc tính của mọi phần tử + URL: không chứa mã đơn. */
const dhcInAttributes = (page: Page) => page.evaluate((re) => {
  const rx = new RegExp(re)
  if (rx.test(location.href)) return 'url'
  for (const el of Array.from(document.querySelectorAll('*'))) {
    for (const a of Array.from(el.attributes)) if (rx.test(a.value)) return `${el.tagName}[${a.name}]`
  }
  return null
}, DHC.source)
async function shot(page: Page, testId: string, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.evaluate(() => {
    document.querySelectorAll('header.bg-primary, aside.bg-sidebar, nav[aria-label="Điều hướng chính"], nextjs-portal').forEach((el) => { (el as HTMLElement).style.display = 'none' })
  })
  await saveLocatorShot(page.getByTestId(testId), path.join(SHOTS, `${name}.png`))
}

test.describe('care E3 — đơn xác thực sau import (catalog, dữ liệu giả) @desktop', () => {
  test.skip(!HAS_STATE, 'chưa có storageState super (E2E_SUPER_* + project setup)')
  test.use({ storageState: SUPER_STATE })

  test('nhãn trạng thái theo E0 §5; Xem thêm; sao chép mã (aria-live); mã đơn không trong thuộc tính', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await open(page, '/ui-catalog/care-orders', 'catalog-care-orders')
    const box = (k: string) => page.getByTestId(`catalog-orders-${k}`)
    await expect(box('orders').getByText('23 đơn xác thực', { exact: true })).toBeVisible()
    await expect(box('zero').getByText('Chưa thấy đơn', { exact: true })).toBeVisible()
    await expect(box('zero')).toContainText('Chưa thấy đơn theo dữ liệu đến')
    await expect(box('nocov').getByText('Chưa có dữ liệu đơn', { exact: true })).toBeVisible()
    await expect(box('lagging').getByText('Chưa cập nhật', { exact: true })).toBeVisible()
    await expect(box('closed')).toContainText('Đã chốt theo VIEW N3 lúc 00:40 01/10/2026 — đơn hoàn tất trước 00:00 01/10.')
    await expect(box('closed0')).toContainText('Không thấy đơn theo dữ liệu VIEW tại mốc chốt')
    await expect(box('waiting').getByText('Đang chờ chốt kỳ', { exact: true })).toBeVisible()
    await expect(box('failed').getByText('Chưa chốt đủ dữ liệu đơn', { exact: true })).toBeVisible()
    await expect(box('pre').getByText('Chưa có dữ liệu đơn', { exact: true })).toBeVisible()
    for (const k of ['nocov', 'pre', 'closed0', 'failed']) await expect(box(k)).not.toContainText('Chưa có đơn')
    // Xem thêm: 3 ⇒ 5 đơn, nút biến mất.
    await expect(box('orders').getByTestId('care-task-order-list').locator('li')).toHaveCount(3)
    await box('orders').getByRole('button', { name: 'Xem thêm đơn' }).click()
    await expect(box('orders').getByTestId('care-task-order-list').locator('li')).toHaveCount(5)
    await expect(box('orders').getByRole('button', { name: 'Xem thêm đơn' })).toHaveCount(0)
    // Sao chép mã: clipboard + aria-live; nút không mang mã đơn.
    await box('orders').getByRole('button', { name: 'Sao chép mã đơn' }).first().click()
    await expect(box('orders').getByText('Đã sao chép', { exact: true })).toBeVisible()
    await expect(box('orders').locator('[aria-live="polite"]')).toHaveText('Đã sao chép mã đơn.')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(DHC)
    expect(await dhcInAttributes(page)).toBeNull()
    await shot(page, 'catalog-care-orders', 'catalog-desktop-light')
  })

  test('không có clipboard ⇒ chọn sẵn mã + thông báo thủ công', async ({ page }) => {
    await open(page, '/ui-catalog/care-orders', 'catalog-care-orders')
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }) })
    const box = page.getByTestId('catalog-orders-orders')
    await box.getByRole('button', { name: 'Sao chép mã đơn' }).first().click()
    await expect(box.locator('[aria-live="polite"]')).toContainText('hãy sao chép thủ công')
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toMatch(DHC)
  })

  test('/care/orders (frame): bảng không mã đơn, banner cập nhật một phần, Xem thêm; cohort ghi số báo cáo / còn quyền xem', async ({ page }) => {
    await open(page, '/ui-catalog/care-orders?frame=orders', 'catalog-frame-orders')
    await expect(page.getByTestId('care-orders-partial')).toContainText('Đang cập nhật một phần — 4 task có đơn')
    const table = page.getByTestId('care-import-orders-table')
    await expect(table.locator('tbody tr')).toHaveCount(4)
    await expect(table).not.toContainText(DHC)
    await page.getByRole('button', { name: 'Xem thêm' }).click()
    await expect(table.locator('tbody tr')).toHaveCount(5)
    await expect(table.getByText('Chưa cập nhật', { exact: true })).toHaveCount(1)
    await open(page, '/ui-catalog/care-orders?frame=conversion', 'catalog-frame-conversion')
    await expect(page.getByTestId('care-conversion-totals')).toContainText('5 task theo báo cáo; 3 task bạn còn quyền xem')
    await expect(page.getByTestId('care-conversion-table').locator('tbody tr')).toHaveCount(3)
    await shot(page, 'catalog-frame-conversion', 'conversion-desktop-light')
  })

  test('khối /care/reports: chưa có dữ liệu / đã cập nhật (số toàn chuỗi) / chưa cập nhật / đã chốt', async ({ page }) => {
    await open(page, '/ui-catalog/care-orders', 'catalog-care-orders', 'dark')
    await expect(page.getByTestId('catalog-block-none')).toContainText('Chưa có dữ liệu đơn')
    await expect(page.getByTestId('catalog-block-synced')).toContainText('212 / 1.384 task có đơn N3 sau mốc import')
    await expect(page.getByTestId('catalog-block-stale')).toContainText('Chưa cập nhật')
    await expect(page.getByTestId('catalog-block-closed')).toContainText('Đã chốt kỳ')
    for (const k of ['none', 'synced', 'stale', 'closed']) await expect(page.getByTestId(`catalog-block-${k}`)).toContainText('chưa phải xác nhận từ N3')
    await shot(page, 'catalog-care-orders', 'catalog-desktop-dark')
  })
})

test.describe('care E3 — đơn xác thực sau import (mobile, dữ liệu giả) @mobile', () => {
  test.skip(!HAS_STATE, 'chưa có storageState super (E2E_SUPER_* + project setup)')
  test.use({ storageState: SUPER_STATE })

  for (const theme of ['light', 'dark'] as const) {
    test(`catalog ${theme}: không cuộn ngang; nút sao chép / Xem thêm ≥ 44 px`, async ({ page }, info) => {
      await open(page, '/ui-catalog/care-orders', 'catalog-care-orders', theme)
      expect(await noPageOverflow(page)).toBe(true)
      const box = page.getByTestId('catalog-orders-orders')
      for (const name of ['Sao chép mã đơn', 'Xem thêm đơn']) {
        const h = (await box.getByRole('button', { name }).first().boundingBox())?.height ?? 0
        expect(h, name).toBeGreaterThanOrEqual(44)
      }
      await shot(page, 'catalog-orders-orders', `orders-${info.project.name}-${theme}`)
    })
  }

  // E3 r1.1 (PM E1–E3 r1 P1): chip hiện HẾT task có đơn — "Xem thêm" keyset (catalog giả lặp 1 dòng mỗi trang sau ⇒ UI bỏ trùng),
  // không phân trang theo số; tìm trong nhóm gửi orders: true (catalog chỉ tìm trong n khách có đơn), trang theo số.
  test('chip "Có đơn xác thực" 41 khách: Xem thêm 20 → 40 → 41 không trùng; tìm trong nhóm giữ điều kiện có đơn; ≥ 44 px', async ({ page }) => {
    await open(page, '/ui-catalog/care-my?frame=list&orders=1&view=orders&n=41', 'catalog-care-my-home')
    const list = page.getByRole('list', { name: 'Danh sách khách' }).locator('li')
    const count = page.getByTestId('care-my-count')
    const more = page.getByRole('button', { name: 'Xem thêm' })
    const nav = page.getByRole('navigation', { name: 'Phân trang' })
    await expect(page.getByRole('link', { name: /Có đơn xác thực/ })).toHaveAttribute('aria-current', 'page')
    await expect(count).toHaveText('41 khách có đơn xác thực · đang hiện 20')
    await expect(list).toHaveCount(20)
    await expect(nav).toHaveCount(0)
    expect((await more.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
    expect(await noPageOverflow(page)).toBe(true)
    await more.click()
    await expect(list).toHaveCount(40)
    await expect(count).toHaveText('41 khách có đơn xác thực · đang hiện 40')
    await more.click()
    await expect(list).toHaveCount(41)
    await expect(count).toHaveText('41 khách có đơn xác thực')
    await expect(more).toHaveCount(0)
    const names = await list.locator('p[title]').allTextContents()
    expect(new Set(names).size).toBe(41)
    expect([names[0], names[19], names[20], names[40]]).toEqual(['KH có đơn 01', 'KH có đơn 20', 'KH có đơn 21', 'KH có đơn 41'])
    const box = page.getByRole('searchbox', { name: 'Tìm tên hoặc SĐT khách' })
    await box.fill('đơn 4')
    await box.press('Enter')
    await expect(count).toHaveText('2 khách có đơn khớp tìm kiếm')
    await expect(list.locator('p[title]')).toHaveText(['KH có đơn 40', 'KH có đơn 41'])
    await box.fill('KH có đơn')
    await box.press('Enter')
    await expect(count).toHaveText('41 khách có đơn khớp tìm kiếm')
    await expect(nav).toContainText('Trang 1/3')
    await nav.getByRole('button', { name: 'Sau' }).click()
    await expect(nav).toContainText('Trang 2/3')
    await expect(list.locator('p[title]').first()).toHaveText('KH có đơn 21')
    await nav.getByRole('button', { name: 'Sau' }).click()
    await expect(nav).toContainText('Trang 3/3')
    await expect(list).toHaveCount(1)
    // Bỏ tìm ⇒ về đúng danh sách chip đã tải (41), không quay về trang đầu.
    await page.getByRole('button', { name: 'Bỏ tìm' }).click()
    await expect(list).toHaveCount(41)
    await expect(count).toHaveText('41 khách có đơn xác thực')
  })

  test('chip "Có đơn xác thực" 21 khách: trang đầu 20, Xem thêm còn đúng 1', async ({ page }) => {
    await open(page, '/ui-catalog/care-my?frame=list&orders=1&view=orders&n=21', 'catalog-care-my-home')
    const list = page.getByRole('list', { name: 'Danh sách khách' }).locator('li')
    await expect(page.getByTestId('care-my-count')).toHaveText('21 khách có đơn xác thực · đang hiện 20')
    await expect(list).toHaveCount(20)
    await page.getByRole('button', { name: 'Xem thêm' }).click()
    await expect(list).toHaveCount(21)
    await expect(page.getByTestId('care-my-count')).toHaveText('21 khách có đơn xác thực')
    await expect(page.getByRole('button', { name: 'Xem thêm' })).toHaveCount(0)
    expect(new Set(await list.locator('p[title]').allTextContents()).size).toBe(21)
  })

  test('màn dược sĩ: chip "Có đơn xác thực" + khối đơn ở tab Tổng quan; không cuộn ngang; mã đơn không trong thuộc tính', async ({ page }, info) => {
    await open(page, '/ui-catalog/care-my?frame=list&orders=1', 'catalog-care-my-home')
    const chip = page.getByRole('link', { name: /Có đơn xác thực/ })
    await expect(chip).toContainText('2')
    expect((await chip.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
    expect(await noPageOverflow(page)).toBe(true)
    await open(page, '/ui-catalog/care-my?frame=detail&orders=1', 'care-my-detail')
    const sec = page.getByTestId('care-task-orders')
    await expect(sec).toContainText('2 đơn xác thực')
    await expect(sec.getByTestId('care-task-order-list').locator('li')).toHaveCount(2)
    expect(await noPageOverflow(page)).toBe(true)
    expect(await dhcInAttributes(page)).toBeNull()
    await shot(page, 'care-my-detail', `my-detail-orders-${info.project.name}`)
    // Không cờ ⇒ không khối đơn (catalog giữ DOM cũ khi không truyền `orders`).
    await open(page, '/ui-catalog/care-my?frame=detail', 'care-my-detail')
    await expect(page.getByTestId('care-task-orders')).toHaveCount(0)
  })
})

test.describe('care E3 — cờ OFF @desktop', () => {
  test('nguồn: mọi bề mặt E chỉ hiện khi careOrderLinksUiOn(); /care/orders notFound khi cờ OFF', () => {
    expect(read('components/care/CareOrdersScreen.tsx')).toMatch(/const g = await requireCareViewer\(\)\n\s+if \(!careOrderLinksUiOn\(\)\) notFound\(\)/)
    for (const f of ['app/(dashboard)/care/tasks/[id]/page.tsx', 'app/(dashboard)/care/my/[id]/page.tsx']) {
      expect(read(f), f).toContain('const orders = careOrderLinksUiOn() ? await loadTaskOrders(')
    }
    expect(read('app/(dashboard)/care/reports/page.tsx')).toContain('const ui = careOrderLinksUiOn() && !d.storeOutOfScope')
    expect(read('app/(dashboard)/care/my/page.tsx')).toContain('const ui = careOrderLinksUiOn()')
    // E3 r1.1: chế độ chip / "Xem thêm" / tìm trong nhóm chỉ khi cờ UI ON; cờ OFF ⇒ ?filter=orders là danh sách thường, action từ chối.
    expect(read('app/(dashboard)/care/my/page.tsx')).toContain("const ordersView = ui && sp.filter === 'orders'")
    expect(read('app/(dashboard)/care/my/page.tsx')).toContain('ordersList={ordersView ? { next: list.next, total: ordersTotal, loadMore: loadMoreMyOrderTasks } : undefined}')
    expect(read('app/actions/careMy.ts')).toContain("if (orders && !isCareOrderLinksUiEnabled()) return { ok: false, message: 'Chức năng chưa được bật.' }")
    const more = read('app/actions/careOrders.ts').split('export async function loadMoreMyOrderTasks(')[1] ?? ''
    expect(more.indexOf("if (!isCareEnabled() || !isCareOrderLinksUiEnabled()) return { ok: false, message: 'Không có quyền xem.' }")).toBeGreaterThan(0)
    expect(more.indexOf("if (a.kind !== 'ok') return")).toBeGreaterThan(more.indexOf('isCareOrderLinksUiEnabled()'))
    // Cursor / từ khoá chỉ đi qua POST: không vào href của danh sách dược sĩ.
    expect(read('components/care/CareMyHome.tsx')).not.toMatch(/href=\{[^}]*(cursor|next|\bq\b)/)
    expect(read('app/actions/care.ts')).toContain('const orders = isCareOrderLinksUiEnabled() ? await loadTaskOrders(v.userId, t.id).catch(() => null) : null')
    expect(read('app/actions/careOrders.ts')).toContain('if (!isCareEnabled() || !isCareOrderLinksUiEnabled()) return null')
    expect(read('app/actions/careOrders.ts')).toContain('return id && (await careQaViewerAllowed(id)) ? id : null')
    expect(read('app/actions/careOrders.ts')).toContain("return v.kind === 'ok' && v.perms.canView ? v.userId : null")
    expect(read('app/actions/careOrders.ts').match(/const u = await listViewer\(\)/g)?.length).toBe(2)
    // Mã đơn không vào log / URL phía server: không console.* trong lớp đọc / action / component E3.
    for (const f of ['lib/care/server/orderLinks.ts', 'app/actions/careOrders.ts', 'components/care/CareTaskOrdersSection.tsx', 'components/care/CareOrdersTable.tsx', 'lib/care/orderLinks/view.ts']) {
      expect(read(f), f).not.toMatch(/console\.(log|warn|error|info)/)
    }
    expect(read('components/care/CareTaskOrdersSection.tsx')).not.toMatch(/(title|aria-label|data-[a-z-]+)=\{o\.orderCode\}/)
  })

  test('HTTP: route E 503 khi cờ OFF (server chính + server CARE_ENABLED); /care/orders 404', async () => {
    test.skip(!process.env.CRON_SECRET, 'cần CRON_SECRET trong env E2E')
    const bases = [process.env.E2E_BASE_URL ?? 'http://localhost:3000', process.env.E2E_CARE_ON_URL].filter(Boolean) as string[]
    for (const baseURL of bases) {
      const api = await pwRequest.newContext({ baseURL, storageState: { cookies: [], origins: [] } })
      for (const route of ['/api/cron/care-order-links-sync', '/api/cron/care-order-links-close', '/api/cron/care-order-links-trial?kind=regular']) {
        expect((await api.get(route, { maxRedirects: 0 })).status(), `${baseURL}${route}`).toBe(401)
        const r = await api.get(route, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }, maxRedirects: 0 })
        expect(r.status(), `${baseURL}${route}`).toBe(503)
      }
      await api.dispose()
      if (HAS_STATE) {
        const su = await pwRequest.newContext({ baseURL, storageState: SUPER_STATE })
        for (const p of ['/care/orders', '/care/orders/care']) expect((await su.get(p, { maxRedirects: 0 })).status(), `${baseURL}${p}`).toBe(404)
        await su.dispose()
      }
    }
  })
})
