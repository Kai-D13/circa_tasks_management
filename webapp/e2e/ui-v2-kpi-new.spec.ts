import fs from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import { SM_STATE, SUPER_STATE } from './authState'
import { blockedCounter, expectBlocked, expectBoundaryOnlyInCatalog, expectCatalogWrapped, expectGuardedCalls, fixtureBlockedToast, trapWrites } from './fixtureGuard'

// UI v2 Phase 2 · K-3 — /targets/campaigns/new (canvas K4). Fixture /ui-catalog/kpi-v2/new render ĐÚNG CampaignNewFrame
// + CampaignWizard của route thật. Validation dừng ở toast phía client (0 request POST). Form HỢP LỆ trên fixture bị
// KpiFixtureBoundary chặn trước createCampaign (PM 17/10 P1) và trapWrites abort mọi request ghi trong trình duyệt ⇒ không
// bao giờ tạo nháp. Route thật vẫn gửi đúng 1 server action (bị abort, không tới máy chủ). Bước 2 dựng bằng
// CampaignWizardSteps + CampaignWizardImportStep.
const CSV = Buffer.from('pos_code,kpi_target\nFX01,1000000\n', 'utf8')

const HAS_SUPER = fs.existsSync(SUPER_STATE)
const HAS_SM = fs.existsSync(SM_STATE)
const THEMES = ['light', 'dark'] as const
type Theme = (typeof THEMES)[number]
const DEVICES = {
  d1280: { width: 1280, height: 900 }, d1440: { width: 1440, height: 900 },
  m360: { width: 360, height: 800 }, m390: { width: 390, height: 844 },
} as const
type Dev = keyof typeof DEVICES
const FX = '/ui-catalog/kpi-v2/new'

async function setup(page: Page, dev: Dev, baseURL: string) {
  await page.setViewportSize(DEVICES[dev])
  await page.context().addCookies([{ name: 'sidebar_collapsed', value: '0', url: baseURL }])
}
async function openFx(page: Page, fx: string, theme: Theme = 'light') {
  await page.goto(`${FX}?fx=${fx}`)
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
  await page.locator(`main [data-testid="ui-catalog-kpi-new"][data-fx="${fx}"]`).waitFor({ state: 'visible', timeout: 20_000 })
  await page.evaluate(() => document.fonts.ready)
}
async function noPageOverflow(page: Page, where: string) {
  const g = await page.evaluate(() => {
    const m = document.querySelector('main')!
    return { sw: document.documentElement.scrollWidth, iw: window.innerWidth, msw: m.scrollWidth, mcw: m.clientWidth }
  })
  expect(g.sw, `${where}: trang cuộn ngang`).toBeLessThanOrEqual(g.iw + 1)
  expect(g.msw, `${where}: <main> cuộn ngang`).toBeLessThanOrEqual(g.mcw + 1)
}
const typeButtons = (page: Page) => page.locator('main [data-campaign-type]')
const pressed = (page: Page) => typeButtons(page).evaluateAll((els) => els.map((e) => [e.getAttribute('data-campaign-type'), e.getAttribute('aria-pressed')]))

test.describe('ui v2 KPI K-3 tạo chiến dịch — fixture @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('bước 1 (mọi cờ bật): khung, 2 bước, nhãn gắn ô, chọn loại bằng aria-pressed, phạm vi khoá "Sắp có"', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    await openFx(page, 'all')
    const root = page.locator('main [data-campaign-new]')
    await expect(root).toHaveAttribute('data-ui-v2', 'page')
    await expect(root.locator('h1')).toHaveText('Tạo chiến dịch KPI')
    await expect(root.getByRole('link', { name: 'Chiến dịch KPI' })).toHaveAttribute('href', '/targets/campaigns')
    const steps = root.locator('ol[aria-label="Các bước tạo chiến dịch"] li')
    expect(await steps.evaluateAll((els) => els.map((e) => [e.textContent?.trim(), e.getAttribute('aria-current')])))
      .toEqual([['1Thông tin', 'step'], ['2Nạp target', null]])
    await expect(root.getByLabel('Tên chiến dịch')).toHaveAttribute('placeholder', 'VD: Chạy doanh số tháng 7')
    await expect(root.getByLabel('Từ ngày')).toHaveAttribute('type', 'date')
    await expect(root.getByLabel('Đến ngày')).toHaveAttribute('type', 'date')
    expect(await pressed(page)).toEqual([['gmv', 'true'], ['affiliate_customer_count', 'false'], ['offline_order_aov', 'false']])
    await expect(root.getByRole('checkbox')).toHaveCount(2) // Doanh thu thuần tại cửa hàng + Doanh thu Affiliate
    await typeButtons(page).nth(1).click()
    expect(await pressed(page)).toEqual([['gmv', 'false'], ['affiliate_customer_count', 'true'], ['offline_order_aov', 'false']])
    await expect(root).toContainText('Đếm khách duy nhất có đơn Affiliate giao thành công trong kỳ')
    await expect(root.getByRole('checkbox'), 'Số khách: ẩn 2 chỉ số').toHaveCount(0)
    await typeButtons(page).nth(2).click()
    await expect(root).toContainText('Đánh giá đồng thời SỐ ĐƠN và AOV')
    await expect(root.getByRole('checkbox')).toHaveCount(2)
    const scope = root.locator('[data-campaign-scope]')
    await expect(scope).toContainText('Cửa hàng')
    await expect(scope.locator('[aria-disabled="true"]')).toHaveText('Từng dược sĩ · Sắp có')
    await expect(root.getByRole('button', { name: 'Tiếp →' })).toBeEnabled()
  })

  test('validation giữ nguyên (toast phía client) và KHÔNG gửi request nào', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    await openFx(page, 'all')
    const posts: string[] = []
    page.on('request', (r) => { if (r.method() === 'POST') posts.push(r.url()) })
    const root = page.locator('main [data-campaign-new]')
    const next = root.getByRole('button', { name: 'Tiếp →' })
    const toast = (t: string) => expect(page.getByText(t, { exact: true }).first()).toBeVisible()
    await next.click(); await toast('Nhập tên chiến dịch')
    await root.getByLabel('Tên chiến dịch').fill('Chiến dịch fixture K-3')
    await next.click(); await toast('Chọn thời gian áp dụng')
    await root.getByLabel('Từ ngày').fill('2026-10-20')
    await root.getByLabel('Đến ngày').fill('2026-10-10')
    await next.click(); await toast('Ngày kết thúc phải sau ngày bắt đầu')
    await root.getByLabel('Đến ngày').fill('2026-10-31')
    for (const cb of await root.getByRole('checkbox').all()) if (await cb.isChecked()) await cb.uncheck()
    await next.click(); await toast('Chọn ít nhất một chỉ số doanh số')
    await page.waitForTimeout(300)
    expect(posts, 'wizard gửi request khi form chưa hợp lệ').toEqual([])
    await expect(root.locator('ol li[aria-current="step"]')).toHaveAttribute('data-step', '1')
  })

  test('cờ: chỉ Affiliate ⇒ không chọn loại, có ô Affiliate; mọi cờ tắt ⇒ chỉ Doanh thu thuần', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    await openFx(page, 'gmv')
    await expect(typeButtons(page)).toHaveCount(0)
    await expect(page.locator('main [data-campaign-new]').getByRole('checkbox')).toHaveCount(2)
    await openFx(page, 'plain')
    await expect(typeButtons(page)).toHaveCount(0)
    const cbs = page.locator('main [data-campaign-new]').getByRole('checkbox')
    await expect(cbs).toHaveCount(1)
    await expect(page.locator('main [data-campaign-new]')).toContainText('Doanh thu thuần tại cửa hàng')
  })

  test('bước 2: bước 1 đã qua, bước 2 hiện tại; khối nạp file giữ hợp đồng xlsx/xls/csv', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    await openFx(page, 'step2')
    const root = page.locator('main [data-campaign-new]')
    await expect(root.locator('ol li[aria-current="step"]')).toHaveAttribute('data-step', '2')
    await expect(root.getByRole('heading', { name: 'Nạp file target + bậc commission' })).toBeVisible()
    const accept = await root.locator('input[type="file"]').getAttribute('accept')
    for (const ext of ['.xlsx', '.xls', '.csv']) expect(accept, `nạp target phải nhận ${ext}`).toContain(ext)
    await expect(root.getByText('Chọn file Excel/CSV')).toBeVisible()
    await expect(root.getByRole('button', { name: 'Tải file mẫu CSV' })).toBeVisible()
    await expect(root.getByRole('button', { name: 'Xem trước' })).toBeDisabled()
    await expect(root.getByRole('button', { name: 'Xác nhận nạp' })).toBeDisabled()
  })

  for (const theme of THEMES) {
    for (const dev of ['d1280', 'd1440', 'm360', 'm390'] as Dev[]) {
      test(`bố cục ${dev} ${theme}: không tràn, ô 16px + chạm ≥44px ở mobile`, async ({ page }, info) => {
        await setup(page, dev, info.project.use.baseURL!)
        const mobile = dev.startsWith('m')
        for (const fx of ['all', 'step2']) {
          await openFx(page, fx, theme)
          await noPageOverflow(page, `${fx} ${dev} ${theme}`)
          if (mobile) {
            const sizes = await page.locator('main [data-campaign-new] button:visible, main [data-campaign-new] label[for]:visible').evaluateAll((els) =>
              els.filter((e) => e.tagName === 'BUTTON' || (e as HTMLLabelElement).htmlFor.startsWith('campaign-file'))
                .map((e) => { const r = e.getBoundingClientRect(); return { h: Math.round(r.height), t: (e.textContent ?? '').trim().slice(0, 24) } }))
            expect(sizes.length).toBeGreaterThan(1)
            for (const s of sizes) expect(s.h, `vùng chạm < 44px: ${s.t}`).toBeGreaterThanOrEqual(44)
            if (fx === 'all') for (const id of ['#campaign-name', '#campaign-start']) {
              expect(await page.locator(id).evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px')
            }
          }
          const shot = (fx === 'all' && (dev === 'd1440' || (dev === 'm390' && theme === 'light'))) || (fx === 'step2' && dev === 'd1440' && theme === 'dark')
          if (shot) {
            if (mobile) await page.evaluate(() => {
              document.querySelectorAll<HTMLElement>('header.bg-primary, aside.bg-sidebar, nav[aria-label="Điều hướng chính"], nextjs-portal')
                .forEach((el) => { el.style.display = 'none' })
              const main = document.querySelector<HTMLElement>('main')
              const outer = main?.parentElement
              if (outer) { outer.style.height = 'auto'; outer.style.overflow = 'visible' }
              if (main) main.style.overflow = 'visible'
            })
            expect(await page.getByTestId('ui-catalog-kpi-new').screenshot({ animations: 'disabled' }))
              .toMatchSnapshot(`new-${fx}-${theme}-${dev}.png`, { maxDiffPixelRatio: 0.01 })
          }
        }
      })
    }
  }

  test('khung chờ (fixture): v2, không tràn 1440/360', async ({ page }, info) => {
    for (const dev of ['d1440', 'm360'] as Dev[]) {
      await setup(page, dev, info.project.use.baseURL!)
      await openFx(page, 'loading')
      const l = page.locator('main [data-route-loading="campaign-new"]')
      await expect(l).toBeVisible()
      await expect(l).toHaveAttribute('data-ui-v2', 'page')
      await noPageOverflow(page, `loading ${dev}`)
    }
  })
})

test.describe('ui v2 KPI K-3 fixture bất khả ghi — nguồn @desktop', () => {
  test('CampaignWizard hỏi fixtureBlocked() trước createCampaign; fixture new bọc boundary, route thật không', () => {
    expect(expectGuardedCalls('components/kpi/CampaignWizard.tsx', ['createCampaign'])).toBe(1)
    expectCatalogWrapped('app/(dashboard)/ui-catalog/kpi-v2/new/page.tsx')
    expectBoundaryOnlyInCatalog(['app/(dashboard)/targets/campaigns/new/page.tsx'])
  })
})

test.describe('ui v2 KPI K-3 fixture bất khả ghi (PM 17/10 P1) @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE, serviceWorkers: 'block' })

  test('bước 1 form HỢP LỆ × 3 loại (chuột) + Enter ⇒ chặn trước createCampaign: vẫn bước 1, không toast tạo nháp, 0 request ghi', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    const seen = await trapWrites(page)
    await openFx(page, 'all')
    await expectBlocked(page, 0, 'mở trang')
    const root = page.locator('main [data-campaign-new]')
    await root.getByLabel('Tên chiến dịch').fill('Fixture chặn ghi — không lưu')
    await root.getByLabel('Từ ngày').fill('2026-10-01')
    await root.getByLabel('Đến ngày').fill('2026-10-31')
    const next = root.getByRole('button', { name: 'Tiếp →' })
    let n = 0
    for (const i of [0, 1, 2]) {
      await typeButtons(page).nth(i).click()
      await next.click()
      await expectBlocked(page, ++n, `Tiếp → (loại ${i})`)
    }
    await next.focus()
    await page.keyboard.press('Enter')
    await expectBlocked(page, ++n, 'Tiếp → (Enter)')
    await expect(root.locator('ol li[aria-current="step"]')).toHaveAttribute('data-step', '1')
    await expect(page.getByText('Đã tạo nháp — nạp file target')).toHaveCount(0)
    await expect(page.getByText(fixtureBlockedToast()).first()).toBeVisible()
    expect(seen, 'fixture wizard gửi request ghi').toEqual([])
  })

  test('bước 2: chọn file → Xem trước (chuột + Enter) ⇒ chặn, Xác nhận nạp vẫn khoá, 0 request', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    const seen = await trapWrites(page)
    await openFx(page, 'step2')
    await expectBlocked(page, 0, 'mở trang')
    const root = page.locator('main [data-campaign-new]')
    await root.getByLabel('Chọn file Excel target chiến dịch').setInputFiles({ name: 'target.csv', mimeType: 'text/csv', buffer: CSV })
    const preview = root.getByRole('button', { name: 'Xem trước', exact: true })
    await expect(preview).toBeEnabled()
    await preview.click()
    await expectBlocked(page, 1, 'Xem trước')
    await preview.focus()
    await page.keyboard.press('Enter')
    await expectBlocked(page, 2, 'Xem trước (Enter)')
    await expect(root.getByRole('button', { name: 'Xác nhận nạp' })).toBeDisabled()
    expect(seen, 'fixture bước 2 gửi request ghi').toEqual([])
  })
})

test.describe('ui v2 KPI K-3 /targets/campaigns/new route thật — super @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE, serviceWorkers: 'block' })

  test('route thật vẫn nối createCampaign: không boundary; form hợp lệ → Tiếp ⇒ đúng 1 server action POST, abort ở trình duyệt (không tạo nháp)', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    const seen = await trapWrites(page)
    await page.goto('/targets/campaigns/new')
    const root = page.locator('main [data-campaign-new]')
    await expect(root).toBeVisible({ timeout: 20_000 })
    await expect(blockedCounter(page), 'route thật không được bọc KpiFixtureBoundary').toHaveCount(0)
    await root.getByLabel('Tên chiến dịch').fill('E2E chặn ghi — request bị abort, không lưu')
    await root.getByLabel('Từ ngày').fill('2026-10-01')
    await root.getByLabel('Đến ngày').fill('2026-10-31')
    expect(seen, 'mở + điền form không được gửi request ghi').toEqual([])
    await root.getByRole('button', { name: 'Tiếp →' }).click()
    await expect.poll(() => seen.length, { timeout: 10_000 }).toBe(1)
    await page.waitForTimeout(1_000) // cửa sổ bắt request thứ 2 đến muộn
    expect(seen).toEqual([{ method: 'POST', path: '/targets/campaigns/new', action: true }])
  })

  test('route thật: gốc v2, wizard bước 1 theo cờ server, không gửi request khi mở; không tràn 1280 sáng/tối', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    const posts: string[] = []
    page.on('request', (r) => { if (r.method() === 'POST') posts.push(r.url()) })
    for (const theme of THEMES) {
      await page.goto('/targets/campaigns/new')
      await page.evaluate((t) => localStorage.setItem('theme', t), theme)
      await page.reload()
      const root = page.locator('main [data-campaign-new]')
      await expect(root).toBeVisible({ timeout: 20_000 })
      await expect(root).toHaveAttribute('data-ui-v2', 'page')
      await expect(root.locator('ol li[aria-current="step"]')).toHaveAttribute('data-step', '1')
      await expect(root.getByRole('button', { name: 'Tiếp →' })).toBeVisible()
      await noPageOverflow(page, `new 1280 ${theme}`)
    }
    expect(posts.filter((u) => !u.includes('/_next/')), 'mở trang tạo không được gửi request ghi').toEqual([])
  })

  test('loading: nút "Tạo chiến dịch" ở danh sách → khung chờ trang tạo', async ({ page }) => {
    const NEW = '/targets/campaigns/new'
    let prefetched = 0
    let hold = false
    await page.route((u) => u.pathname === NEW, async (route) => {
      const h = route.request().headers()
      if (h['rsc'] === '1' && h['next-router-prefetch']) {
        let res: Awaited<ReturnType<typeof route.fetch>>
        try { res = await route.fetch() } catch { await route.abort('failed'); return }
        await route.fulfill({ response: res })
        prefetched++
        return
      }
      if (hold && h['rsc'] === '1') await new Promise((r) => setTimeout(r, 2500))
      await route.continue()
    })
    await page.goto('/targets/campaigns')
    await page.locator('main [data-campaign-list]').waitFor()
    for (let round = 0; round < 10 && prefetched < 2; round++) {
      await page.evaluate((h) => {
        const r = (window as unknown as { next?: { router?: { prefetch: (href: string) => unknown } } }).next?.router
        if (!r) throw new Error('window.next.router không có')
        r.prefetch(h)
      }, NEW)
      for (let t = 0; t < 30 && prefetched < 2; t++) await page.waitForTimeout(100)
    }
    expect(prefetched, `prefetch ${NEW} chưa xong`).toBeGreaterThanOrEqual(2)
    await page.waitForLoadState('networkidle') // router xử lý xong dữ liệu prefetch (như K-2)
    hold = true
    await page.locator('main').getByRole('link', { name: 'Tạo chiến dịch' }).click()
    const l = page.locator('[data-route-loading="campaign-new"]')
    await expect(l, 'khung chờ trang tạo không hiện').toBeVisible({ timeout: 2_000 })
    await expect(l).toHaveAttribute('data-ui-v2', 'page')
    await expect(page.locator('main [data-campaign-new]')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('[data-route-loading]')).toHaveCount(0)
  })
})

test.describe('ui v2 KPI K-3 /targets/campaigns/new — SM @desktop', () => {
  test.skip(!HAS_SM, 'chưa có phiên SM')
  test.use({ storageState: SM_STATE })

  test('SM không vào được trang tạo (cổng cũ notFound): trang 404, không có wizard', async ({ page }) => {
    // Route có loading.tsx ⇒ phản hồi stream HTTP 200 trước khi notFound() chạy; Next hiện UI 404 trong stream
    // (như ui-v2-route-states) ⇒ khẳng định bằng CHÍNH UI 404, không bằng mã HTTP.
    await page.goto('/targets/campaigns/new')
    await expect(page.locator('main').getByText('This page could not be found.'), 'SM phải nhận trang 404').toBeVisible({ timeout: 15_000 })
    await expect(page.locator('main [data-campaign-new]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Tiếp →' })).toHaveCount(0)
  })
})
