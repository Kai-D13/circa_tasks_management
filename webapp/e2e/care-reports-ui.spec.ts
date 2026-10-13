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
// • Smoke thật cờ ON (E2E_CARE_ON_URL; prod ĐÃ có 114 từ 10/10/2026): super thấy báo cáo thật, kỳ 01/2026 rỗng
//   (empty state), export 200 XLSX; QLCH/staff 403. Nhánh "chưa sẵn sàng" giữ bằng kiểm nguồn (không DB).

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
    // B8.2: nhóm "Cửa hàng / Dược sĩ" + Đã liên hệ + Tiến độ.
    await expect(s.getByRole('columnheader')).toHaveText(['Cửa hàng / Dược sĩ', 'Khách', 'Đã liên hệ', 'Hoàn thành', 'Chưa chăm sóc', 'Đang theo dõi', 'Từng trễ hẹn', 'Không hoàn thành', 'Có đơn', 'Tiến độ'])
    const total = s.getByTestId('care-report-total')
    await expect(total.getByRole('cell')).toHaveText(['Tổng', '285', '210', '170', '75', '40', '25', '0', '—', '74%'])
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
    await expect(ok.getByTestId('care-report-total').getByRole('cell')).toHaveText(['Tổng', '285', '210', '170', '75', '40', '25', '0', '58', '74%'])
    await expect(ok.getByTestId('care-report-store').filter({ hasText: 'QAOS02' }).getByRole('cell').nth(8)).toHaveText('9')   // cột Có đơn
    await expect(ok.getByText(/₫|Doanh thu|Số đơn/)).toHaveCount(0)
    await shot(page, 'catalog-care-report-synced', 'desktop-report-synced')
    const stale = page.getByTestId('catalog-care-report-stale')
    await expect(stale.getByTestId('care-order-state')).toHaveAttribute('data-state', 'stale')
    await expect(stale.getByTestId('care-order-state')).toContainText('lần thành công 06:00 20/10/2026')
    await expect(stale.getByTestId('care-order-not-seen')).toContainText('lần đồng bộ 06:00 20/10/2026')   // mốc thành công cuối
    await expect(stale.getByTestId('care-report-total').getByRole('cell').nth(8)).toHaveText('31')      // giữ số cũ (cột Có đơn)
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

// ── B8.2 /care/reports theo artboard 13 ───────────────────────────────────────────────
const S = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const SHOTS_B82 = path.resolve(__dirname, '..', 'qa-artifacts', 'b8-2')

test.describe('care B8.2 — báo cáo (dữ liệu giả) @desktop', () => {
  test.skip(!HAS_STATE, 'chưa có storageState super')
  test.use({ storageState: SUPER_STATE })

  test('KPI: Đã liên hệ (Q-113) + %, Khách có đơn viền đứt "Chưa có dữ liệu" (không 0 giả); tiến độ 4 nhóm rời nhau + đúng 2 thanh nhịp', async ({ page }) => {
    await openCatalog(page)
    await page.waitForLoadState('networkidle')
    const s = page.getByTestId('catalog-care-report-none')
    const kpi = s.getByTestId('care-report').locator('> div').first()
    await expect(kpi).toContainText(/Đã liên hệ\s*210\s*74%/)
    await expect(kpi).toContainText(/Hoàn thành\s*170\s*60%/)
    await expect(kpi).toContainText('Từng trễ hẹn25')
    const orders = s.getByTestId('care-order-state')
    await expect(orders).toContainText('Chưa có dữ liệu')
    await expect(orders).toContainText('—')
    expect(await orders.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('dashed')
    const prog = s.getByTestId('care-report-progress')
    await expect(prog.getByRole('list', { name: 'Chú giải' }).getByRole('listitem')).toHaveText(['Hoàn thành170', 'Đang theo dõi40', 'Chưa chăm sóc75', 'Không hoàn thành0'])
    await expect(prog.getByRole('img', { name: /^Thời gian đã qua/ })).toHaveCount(1)
    await expect(prog.getByRole('img', { name: /^Khách đã liên hệ 74%/ })).toHaveCount(1)
    await expect(prog.getByRole('img', { name: /Thời gian|liên hệ/ })).toHaveCount(2)               // đúng 2 thanh, không thanh/cảnh báo khác
    await expect(prog.getByText(/chậm|khách\/ngày|điểm %/)).toHaveCount(0)                          // Q-114: không cảnh báo
    const oc = s.getByTestId('care-report-outcomes')
    await expect(oc.getByRole('listitem')).toHaveCount(6)
    await expect(oc).toContainText('210 khách · mỗi khách theo lượt gần nhất')                       // Q-117: tổng = Đã liên hệ
    await expect(oc.getByText('Chưa cập nhật')).toHaveCount(0)                                       // không có nhóm "chưa liên hệ" trong mẫu
  })

  test('link chỉ ở số có filter tương đương (PM P1): Khách/Hoàn thành/Chưa CS/Đang theo dõi/Không HT; KHÔNG Đã liên hệ/Từng trễ/Có đơn', async ({ page }) => {
    await openCatalog(page)
    const s = page.getByTestId('catalog-care-report-synced')
    const store1 = s.getByTestId('care-report-store').filter({ hasText: 'QAOS01' })
    const cells = store1.getByRole('cell')
    await expect(cells.nth(1).getByRole('link')).toHaveAttribute('href', `/care/tasks?month=2026-10&store=${S(101)}`)
    await expect(cells.nth(3).getByRole('link')).toHaveAttribute('href', `/care/tasks?month=2026-10&store=${S(101)}&status=completed`)
    await expect(cells.nth(4).getByRole('link')).toHaveAttribute('href', `/care/tasks?month=2026-10&store=${S(101)}&status=not_cared`)
    await expect(cells.nth(5).getByRole('link')).toHaveAttribute('href', `/care/tasks?month=2026-10&store=${S(101)}&status=following`)
    for (const i of [2, 6, 7, 8]) await expect(cells.nth(i).getByRole('link'), `cột ${i}`).toHaveCount(0)  // Đã liên hệ, Từng trễ, Không HT (=0), Có đơn
    const ds = s.getByRole('row').filter({ hasText: 'QA Dược sĩ 01a' }).getByRole('cell')
    await expect(ds.nth(3).getByRole('link')).toHaveAttribute('href', `/care/tasks?month=2026-10&store=${S(101)}&assignee=${S(1002)}&status=completed`)
    await expect(s.getByTestId('care-report-total').getByRole('cell').nth(1).getByRole('link')).toHaveAttribute('href', '/care/tasks?month=2026-10')
  })

  test('kỳ đã đóng: Đã liên hệ gồm task không hoàn thành từng có lượt; thời gian 100% (kỳ đã kết thúc)', async ({ page }) => {
    await openCatalog(page)
    const p = page.getByTestId('catalog-care-report-past')
    await expect(p.getByTestId('care-report').locator('> div').first()).toContainText(/Đã liên hệ\s*75\s*75%/)   // 60 HT + 15 KHT có lượt
    await expect(p.getByRole('img', { name: /^Thời gian đã qua 100% — kỳ đã kết thúc/ })).toHaveCount(1)
    await expect(p.getByTestId('care-report-store').getByRole('cell').nth(7).getByRole('link')).toHaveAttribute('href', /status=closed_unfinished/)
    // Lỗi tải phân bố ⇒ báo, không 0 giả.
    await expect(page.getByTestId('catalog-care-report-stale').getByTestId('care-report-outcomes')).toContainText('Không tải được')
  })

  test('số liệu phụ tải SAU khi hiện (như trang thật): "…" + skeleton → số; lỗi ⇒ "—" + "Không tải được" (không 0 giả)', async ({ page }) => {
    await page.goto('/ui-catalog/care-reports?frame=report-live')
    const fr = page.getByTestId('catalog-frame-report-live')
    await fr.waitFor()
    const kpi = fr.getByTestId('care-report').locator('> div').first()
    // Khung hiện ngay với trạng thái đang tải (action giả trễ 800 ms, chỉ gọi sau khi hydrate).
    await expect(kpi).toContainText(/Đã liên hệ\s*…/)
    await expect(fr.getByTestId('care-report-outcomes-loading')).toBeVisible()
    await expect(fr.getByRole('img', { name: /^Khách đã liên hệ — — đang tải/ })).toHaveCount(1)
    await expect(kpi).toContainText(/Đã liên hệ\s*210\s*74%/, { timeout: 10_000 })
    await expect(fr.getByTestId('care-report-outcomes')).toContainText('210 khách · mỗi khách theo lượt gần nhất')
    await expect(fr.getByRole('img', { name: /^Khách đã liên hệ 74%/ })).toHaveCount(1)
    await page.goto('/ui-catalog/care-reports?frame=report-live&extras=error')
    await page.getByTestId('catalog-frame-report-live').waitFor()
    const kpi2 = page.getByTestId('catalog-frame-report-live').getByTestId('care-report').locator('> div').first()
    await expect(kpi2).toContainText(/Đã liên hệ\s*—\s*không tải được/, { timeout: 10_000 })
    await expect(page.getByTestId('care-report-outcomes')).toContainText('Không tải được')
    await expect(page.getByRole('img', { name: /^Khách đã liên hệ — — không tải được/ })).toHaveCount(1)
    await expect(kpi2).not.toContainText(/Đã liên hệ\s*0/)
  })

  test('PM r1: đổi bộ lọc A(đã có số)→B(chậm)→C(nhanh): màn B/C KHÔNG từng hiện số kỳ trước; B về sau C không ghi đè', async ({ page }) => {
    const EXPECT: Record<string, string> = { '2026-10': '210', '2026-09': '75', '2026-08': '33' }
    await page.goto('/ui-catalog/care-reports?frame=report-live&m=2026-10')
    const fr = page.getByTestId('catalog-frame-report-live')
    await fr.waitFor()
    const kpi = () => page.getByTestId('catalog-frame-report-live').getByTestId('care-report').locator('> div').first()
    await expect(kpi()).toContainText(/Đã liên hệ\s*210/, { timeout: 10_000 })        // A đã có số
    // Theo dõi MỌI lần DOM đổi: khung đang ở kỳ X mà ô "Đã liên hệ" hiện số của kỳ khác ⇒ vi phạm.
    await page.evaluate((exp) => {
      const w = window as unknown as { __stale: string[] }
      w.__stale = []
      const check = () => {
        const f = document.querySelector('[data-testid="catalog-frame-report-live"]')
        const m = f?.getAttribute('data-month') ?? ''
        // Ô KPI: <span>nhãn</span><span>{số}<span>{pct}%</span></span> — đọc riêng text node số (không dính pct).
        const tile = [...(f?.querySelectorAll('[data-testid="care-report"] > div:first-child > div') ?? [])]
          .find((d) => d.firstElementChild?.textContent?.trim() === 'Đã liên hệ')
        const v = tile?.children[1]?.firstChild?.textContent?.trim() ?? ''
        if (/^[\d.]+$/.test(v) && v !== exp[m]) w.__stale.push(`${m}:${v}`)
      }
      new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
    }, EXPECT)
    await fr.getByRole('link', { name: 'Kỳ B' }).click()
    await expect(page.getByTestId('catalog-frame-report-live')).toHaveAttribute('data-month', '2026-09')
    await page.getByTestId('catalog-frame-report-live').getByRole('link', { name: 'Kỳ C' }).click()   // B (1,5 s) còn đang chạy
    await expect(page.getByTestId('catalog-frame-report-live')).toHaveAttribute('data-month', '2026-08')
    await expect(kpi()).toContainText(/Đã liên hệ\s*33/, { timeout: 10_000 })
    await page.waitForTimeout(2_000)                                                    // chờ phản hồi B chậm về (sau C)
    await expect(kpi()).toContainText(/Đã liên hệ\s*33/)
    expect(await page.evaluate(() => (window as unknown as { __stale: string[] }).__stale)).toEqual([])
  })

  test('ảnh khung trang thật 1440/1280 sáng/tối (so artboard 13); không cuộn ngang', async ({ page }) => {
    for (const w of [1440, 1280]) for (const theme of ['light', 'dark'] as const) for (const orders of ['none', 'synced']) {
      await page.setViewportSize({ width: w, height: 900 })
      await page.goto(`/ui-catalog/care-reports?frame=report&orders=${orders}`)
      await page.evaluate((t) => localStorage.setItem('theme', t), theme)
      await page.reload()
      await page.getByTestId('catalog-frame-report').waitFor()
      await expect(page.getByTestId('catalog-frame-report').getByRole('link', { name: /Xuất Excel/ })).toBeVisible()
      expect(await noPageOverflow(page), `${w}-${theme}`).toBe(true)
      fs.mkdirSync(SHOTS_B82, { recursive: true })
      await page.evaluate(() => document.querySelectorAll('header.bg-primary, aside.bg-sidebar, nav[aria-label="Điều hướng chính"], nextjs-portal').forEach((el) => { (el as HTMLElement).style.display = 'none' }))
      await page.screenshot({ path: path.join(SHOTS_B82, `desktop-${w}-${theme}-${orders}.png`), fullPage: true })
    }
  })
})

test.describe('care B8.2 — báo cáo mobile @mobile', () => {
  test.skip(!HAS_STATE, 'chưa có storageState super')
  test.use({ storageState: SUPER_STATE })

  test('360/393: không cuộn ngang trang; bảng cuộn trong khung; Xuất Excel ≥ 44px', async ({ page }) => {
    for (const theme of ['light', 'dark'] as const) {
      await page.goto('/ui-catalog/care-reports?frame=report&orders=synced')
      await page.evaluate((t) => localStorage.setItem('theme', t), theme)
      await page.reload()
      await page.getByTestId('catalog-frame-report').waitFor()
      expect(await noPageOverflow(page)).toBe(true)
      expect((await page.getByTestId('catalog-frame-report').getByRole('link', { name: /Xuất Excel/ }).boundingBox())!.height).toBeGreaterThanOrEqual(44)
      fs.mkdirSync(SHOTS_B82, { recursive: true })
      await page.evaluate(() => document.querySelectorAll('header.bg-primary, aside.bg-sidebar, nav[aria-label="Điều hướng chính"], nextjs-portal').forEach((el) => { (el as HTMLElement).style.display = 'none' }))
      await page.screenshot({ path: path.join(SHOTS_B82, `mobile-${page.viewportSize()!.width}-${theme}.png`), fullPage: true })
    }
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

  // Prod đã cài 114 (pha a, 10/10/2026). Kỳ 01/2026 trước khi có CRM ⇒ chắc chắn KHÔNG có task ⇒ empty state thật,
  // tất định cả sau rollout (không phụ thuộc dữ liệu kỳ hiện tại).
  test('super: /care/reports dựng báo cáo thật (114 đã có) — kỳ không dữ liệu ⇒ empty state, số 0 thật; export 200 XLSX', async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: CARE_ON, storageState: SUPER_STATE })
    const page = await ctx.newPage()
    expect((await page.goto('/care/reports?month=2026-01'))!.status()).toBe(200)
    const report = page.getByTestId('care-report')
    await expect(report).toBeVisible()
    await expect(page.getByText('Hệ thống CRM chưa sẵn sàng.')).toHaveCount(0)
    await expect(report.getByText('Không có dữ liệu chăm sóc theo bộ lọc này')).toBeVisible()
    await expect(page.getByTestId('care-report-total')).toHaveCount(0)
    await expect(report.getByText('kỳ 01/2026')).toBeVisible()
    await expect(page.getByTestId('care-order-state')).toBeVisible()
    const api = await pwRequest.newContext({ baseURL: CARE_ON, storageState: SUPER_STATE })
    const r = await api.get('/api/export/care?month=2026-01')
    expect(r.status()).toBe(200)
    expect(r.headers()['content-type'] ?? '').toContain('spreadsheetml')
    expect((await r.body()).byteLength).toBeGreaterThan(0)
    await api.dispose()
    await ctx.close()
  })

  test('QLCH / staff: không tải được Excel báo cáo (114 đã có ⇒ đúng 403 ở bước quyền)', async () => {
    let checked = 0
    for (const st of [MANAGER_STATE, STAFF_STATE]) {
      if (!fs.existsSync(st)) continue
      const api = await pwRequest.newContext({ baseURL: CARE_ON, storageState: st })
      const r = await api.get('/api/export/care?month=2026-01')
      expect(r.status(), st).toBe(403)
      expect(r.headers()['content-type'] ?? '', st).not.toContain('spreadsheetml')
      await api.dispose()
      checked++
    }
    expect(checked).toBeGreaterThan(0)
  })
})

// Nhánh "DB chưa có 114 / RPC lỗi" không còn tái hiện được trên prod ⇒ giữ bằng kiểm nguồn tất định (không DB).
test.describe('care B5a — nhánh chưa sẵn sàng (nguồn, không DB) @desktop', () => {
  const read = (f: string) => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n')
  test('page /care/reports: unavailable ⇒ CHỈ ErrorState, không dựng báo cáo; export unavailable ⇒ 503 không XLSX', () => {
    const page = read('app/(dashboard)/care/reports/page.tsx')
    const branch = /if \(g\.kind === 'unavailable'\) \{\n([\s\S]*?)\n  \}/.exec(page)![1]
    expect(branch).toContain('<ErrorState message="Hệ thống CRM chưa sẵn sàng."')
    expect(branch).not.toMatch(/CareReportView|loadCareReport/)
    expect(page.indexOf("if (g.kind === 'unavailable')")).toBeLessThan(page.indexOf('loadCareReport('))
    const route = read('app/api/export/care/route.ts')
    expect(route).toContain("if (v.kind === 'unavailable') return NextResponse.json({ error: 'CRM chưa sẵn sàng' }, { status: 503 })")
    expect(route.indexOf("v.kind === 'unavailable'")).toBeLessThan(route.indexOf('loadCareReport('))
    expect(read('lib/care/server/browse.ts')).toMatch(/if \(error \|\| !data \|\| typeof data !== 'object'\) return \{ kind: 'unavailable' \}/)
  })
})
