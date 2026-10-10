import fs from 'node:fs'
import path from 'node:path'
import { test, expect, request as pwRequest, type Page } from '@playwright/test'
import { SUPER_STATE, MANAGER_STATE, STAFF_STATE } from './authState'
import { saveLocatorShot } from './qaShot'

// CRM-CSKH B5a r1.1 — UI báo cáo /care/reports + export (Q-91: chỉ "Khách có đơn", không số đơn/tiền).
// • Mock /ui-catalog/care-reports (UI_CATALOG=1 + super; DỮ LIỆU GIẢ — DB chưa có 114, chưa đồng bộ N3):
//   trước đồng bộ ⇒ "Chưa có dữ liệu đơn", không số 0 giả; đã đồng bộ ⇒ số + mốc giờ VN + "Chưa thấy
//   đơn…"; lỗi ⇒ giữ số cũ + "Chưa cập nhật"; rỗng; dashboard /care có Khách có đơn. Ảnh
//   qa-artifacts/care-b5a-ui (gitignored).
// • Smoke thật cờ OFF (server QA mặc định): /care/reports + /api/export/care 404, sidebar không "Báo cáo".
// • Smoke thật cờ ON (E2E_CARE_ON_URL): super thấy "chưa sẵn sàng" (DB chưa có 114), export 503.

const HAS_STATE = fs.existsSync(SUPER_STATE)
const CARE_ON = process.env.E2E_CARE_ON_URL
const SHOTS = path.resolve(__dirname, '..', 'qa-artifacts', 'care-b5a-ui')

async function openCatalog(page: Page, theme: 'light' | 'dark' = 'light') {
  await page.goto('/ui-catalog/care-reports')
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
  await page.getByTestId('catalog-care-report-none').waitFor({ timeout: 20_000 })
}
async function shot(page: Page, testId: string, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.evaluate(() => {
    document.querySelectorAll('header.bg-primary, aside.bg-sidebar, nav[aria-label="Điều hướng chính"], nextjs-portal').forEach((el) => { (el as HTMLElement).style.display = 'none' })
  })
  await saveLocatorShot(page.getByTestId(testId), path.join(SHOTS, `${name}.png`))
}
const noPageOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)

test.describe('care B5a — báo cáo (dữ liệu giả) @desktop', () => {
  test.skip(!HAS_STATE, 'chưa có storageState super (E2E_SUPER_* + project setup)')
  test.use({ storageState: SUPER_STATE })

  test('trước đồng bộ: "Chưa có dữ liệu đơn", ô Có đơn là "—" (không 0 giả); task vẫn có số; không tiền/số đơn', async ({ page }) => {
    await openCatalog(page)
    const s = page.getByTestId('catalog-care-report-none')
    await expect(s.getByTestId('care-order-state')).toHaveAttribute('data-state', 'none')
    await expect(s.getByTestId('care-order-state')).toContainText('Chưa có dữ liệu đơn')
    await expect(s.getByTestId('care-order-not-seen')).toHaveCount(0)                         // chưa đồng bộ ⇒ chưa nói "chưa thấy"
    await expect(s.getByRole('columnheader')).toHaveText(['Cửa hàng', 'Dược sĩ', 'Khách', 'Hoàn thành', 'Chưa chăm sóc', 'Đang theo dõi', 'Từng trễ hẹn', 'Không hoàn thành', 'Có đơn'])
    const total = s.getByTestId('care-report-total')
    await expect(total.getByRole('cell')).toHaveText(['Tổng', '285', '170', '75', '40', '25', '0', '—'])
    await expect(s.getByText(/₫|Doanh thu|Số đơn/)).toHaveCount(0)
    await expect(s.locator('a[href="/api/export/care?month=2026-10"]')).toHaveText(/Xuất Excel/)
    await shot(page, 'catalog-care-report-none', 'desktop-report-none')
  })

  test('đã đồng bộ: Khách có đơn + mốc giờ VN + "Chưa thấy đơn…"; lỗi sau đó: giữ số + "Chưa cập nhật"; rỗng', async ({ page }) => {
    await openCatalog(page)
    const ok = page.getByTestId('catalog-care-report-synced')
    await expect(ok.getByTestId('care-order-state')).toHaveAttribute('data-state', 'synced')
    await expect(ok.getByTestId('care-order-state')).toContainText('Cập nhật lúc 08:05 20/10/2026')
    await expect(ok.getByTestId('care-order-not-seen')).toHaveText('Task Hoàn thành chưa có đơn: Chưa thấy đơn theo dữ liệu đến lần đồng bộ 08:05 20/10/2026.')
    await expect(ok.getByTestId('care-report-total').getByRole('cell')).toHaveText(['Tổng', '285', '170', '75', '40', '25', '0', '58'])
    await expect(ok.getByRole('row').filter({ hasText: 'QAOS02' }).getByRole('cell').last()).toHaveText('9')
    await expect(ok.getByText(/₫|Doanh thu|Số đơn/)).toHaveCount(0)
    await shot(page, 'catalog-care-report-synced', 'desktop-report-synced')
    const stale = page.getByTestId('catalog-care-report-stale')
    await expect(stale.getByTestId('care-order-state')).toHaveAttribute('data-state', 'stale')
    await expect(stale.getByTestId('care-order-state')).toContainText('lần thành công 06:00 20/10/2026')
    await expect(stale.getByTestId('care-order-not-seen')).toContainText('lần đồng bộ 06:00 20/10/2026')   // mốc thành công cuối
    await expect(stale.getByTestId('care-report-total').getByRole('cell').last()).toHaveText('31')      // giữ số cũ
    const all = page.getByTestId('catalog-care-report-all-converted')
    await expect(all.getByTestId('care-order-state')).toHaveAttribute('data-state', 'synced')
    await expect(all.getByTestId('care-order-not-seen')).toHaveCount(0)                         // mọi task Hoàn thành đã Có đơn
    await expect(page.getByTestId('catalog-care-report-empty').getByText('Không có dữ liệu chăm sóc theo bộ lọc này')).toBeVisible()
    const dash = page.getByTestId('catalog-care-dashboard-orders')
    await expect(dash.getByTestId('care-dashboard-orders')).toContainText('Khách có đơn')
    await expect(dash.getByTestId('care-dashboard-orders')).toContainText('58')
    await expect(dash.getByText(/₫|Doanh thu|Số đơn/)).toHaveCount(0)
    await expect(dash.getByTestId('care-order-state')).toHaveAttribute('data-state', 'synced')
    expect(await noPageOverflow(page)).toBe(true)
  })

  test('dark mode + 390px: không cuộn ngang trang, nút Xuất Excel ≥ 44px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openCatalog(page, 'dark')
    expect(await noPageOverflow(page)).toBe(true)
    const btn = page.getByTestId('catalog-care-report-none').getByRole('link', { name: /Xuất Excel/ })
    expect((await btn.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    // Dòng "Chưa thấy đơn…" dài nằm trọn trong khung trạng thái (không tràn) ở 390px.
    const fits = await page.getByTestId('catalog-care-report-synced').evaluate((sec) => {
      const el = sec.querySelector('[data-testid="care-order-not-seen"]')
      if (!el) return 'missing'
      const box = el.closest('[data-testid="care-order-state"]')!.getBoundingClientRect()
      const r = el.getBoundingClientRect()
      return r.right <= box.right + 1 && r.left >= box.left - 1
    })
    expect(fits).toBe(true)
    await shot(page, 'catalog-care-report-synced', 'mobile-390-dark-report-synced')
  })
})

test.describe('care B5a — page thật khi cờ CARE_ENABLED tắt @desktop', () => {
  test.skip(!HAS_STATE, 'chưa có storageState super')
  test.skip(process.env.CARE_ENABLED === 'true', 'server QA đang bật cờ CRM — smoke này kiểm trạng thái mặc định OFF')
  test.use({ storageState: SUPER_STATE })

  test('super: /care/reports 404, /api/export/care 404; sidebar không có "Báo cáo" CRM', async ({ page, baseURL }) => {
    expect((await page.goto('/care/reports'))!.status()).toBe(404)
    expect((await page.goto('/care/reports?month=2026-10'))!.status()).toBe(404)
    const api = await pwRequest.newContext({ baseURL, storageState: SUPER_STATE })
    expect((await api.get('/api/export/care?month=2026-10')).status()).toBe(404)
    await api.dispose()
    await page.goto('/dashboard')
    await expect(page.locator('a[href="/care/reports"]')).toHaveCount(0)
  })

  test('B5b.1 route QA đọc VIEW N3: bản build production luôn 404 (kể cả cookie super + đúng Bearer); không cookie ⇒ không JSON', async ({ baseURL }) => {
    const auth = { Authorization: `Bearer ${process.env.CRON_SECRET ?? 'qa-missing-secret'}` }
    const api = await pwRequest.newContext({ baseURL, storageState: SUPER_STATE })
    const r = await api.get('/api/qa/care-n3-view', { headers: auth })
    expect(r.status()).toBe(404)
    expect(await r.text()).not.toMatch(/sampleCount|paramQuery|customer_external_id/)
    await api.dispose()
    const anon = await pwRequest.newContext({ baseURL, storageState: { cookies: [], origins: [] } })
    const r2 = await anon.get('/api/qa/care-n3-view', { headers: auth, maxRedirects: 0 })
    expect([307, 308, 404]).toContain(r2.status()) // proxy chỉ bỏ qua đăng nhập khi development
    expect(await r2.text()).not.toMatch(/sampleCount|paramQuery/)
    await anon.dispose()
  })

  test('chưa đăng nhập: export không lộ gì', async ({ baseURL }) => {
    const ctx = await pwRequest.newContext({ baseURL, storageState: { cookies: [], origins: [] } })
    const r = await ctx.get('/api/export/care', { maxRedirects: 0 })
    expect([401, 404, 307, 308]).toContain(r.status())
    expect(r.headers()['content-type'] ?? '').not.toContain('spreadsheetml')
    await ctx.dispose()
  })
})

test.describe('care B5a — page thật khi cờ CARE_ENABLED BẬT (server riêng E2E_CARE_ON_URL) @desktop', () => {
  test.skip(!CARE_ON || !HAS_STATE, 'cần E2E_CARE_ON_URL (server QA bật CARE_ENABLED) + storageState super')

  test('super: /care/reports báo chưa sẵn sàng (DB chưa có 114), export 503 — không dựng bảng/số giả', async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: CARE_ON, storageState: SUPER_STATE })
    const page = await ctx.newPage()
    expect((await page.goto('/care/reports'))!.status()).toBe(200)
    await expect(page.getByText('Hệ thống CRM chưa sẵn sàng.')).toBeVisible()
    await expect(page.getByTestId('care-report')).toHaveCount(0)
    const api = await pwRequest.newContext({ baseURL: CARE_ON, storageState: SUPER_STATE })
    const r = await api.get('/api/export/care?month=2026-10')
    expect(r.status()).toBe(503)
    expect(r.headers()['content-type'] ?? '').not.toContain('spreadsheetml')
    await api.dispose()
    await ctx.close()
  })

  test('QLCH / staff: không tải được Excel báo cáo', async () => {
    for (const st of [MANAGER_STATE, STAFF_STATE]) {
      if (!fs.existsSync(st)) continue
      const api = await pwRequest.newContext({ baseURL: CARE_ON, storageState: st })
      const r = await api.get('/api/export/care?month=2026-10')
      // DB chưa có 114 ⇒ care_my_access lỗi ⇒ 503 trước bước quyền; có 114 ⇒ 403 (PGlite/unit chứng minh nhánh quyền).
      expect([403, 503], st).toContain(r.status())
      expect(r.headers()['content-type'] ?? '', st).not.toContain('spreadsheetml')
      await api.dispose()
    }
  })
})
