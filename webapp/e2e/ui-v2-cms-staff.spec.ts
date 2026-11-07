import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { MANAGER_STATE, STAFF_STATE, SUPER_STATE } from './authState'
import { trapWrites } from './fixtureGuard'

// CMS P1-d — D1 /targets?tab=cms + D2 /targets/cms/products/[id] qua fixture /ui-catalog/cms-v2/{staff,product} (ĐÚNG view
// của route thật, dữ liệu giả). Kiểm: gốc v2 cột giữa, 360 / 390 / 1280 / 1440 × sáng / tối không cuộn ngang, chạm ≥ 44 trên
// mobile, P1 KHÔNG hero / tiến độ / gợi ý / "Nếu bán thêm" / số thực tế / "0₫" giả (U1 / U19), segmented KPI | CMS, chọn
// chương trình (Sắp diễn ra ghi ngày bắt đầu — H5), thang `đ/unit_CMS`, tư vấn đầy đủ + Sao chép, 0 request ghi.
// Route thật cờ CMS OFF (server gate): staff / QLCH `?tab=cms` giữ KPI (không segmented, không màn CMS); D2 ⇒ trang 404.

const HAS_SUPER = fs.existsSync(SUPER_STATE)
const HAS_STAFF = fs.existsSync(STAFF_STATE)
const HAS_MANAGER = fs.existsSync(MANAGER_STATE)
const SHOTS = process.env.CMS_SHOTS_DIR
type Theme = 'light' | 'dark'
const DEVICES = { d1280: { width: 1280, height: 900 }, d1440: { width: 1440, height: 900 }, m360: { width: 360, height: 800 }, m390: { width: 390, height: 844 } } as const
type Dev = keyof typeof DEVICES
const FORBIDDEN = ['CMS tạm tính', 'Gợi ý gần đạt', 'Nếu bán thêm', 'Đã bán', 'Xem ghi nhận', 'Ghi nhận gần đây', 'Bạn đang ở đây']

async function setup(page: Page, dev: Dev, baseURL: string) {
  await page.setViewportSize(DEVICES[dev])
  await page.context().addCookies([{ name: 'sidebar_collapsed', value: '0', url: baseURL }])
}
async function openFx(page: Page, screen: 'staff' | 'product', fx: string, theme: Theme = 'light', extra = '') {
  await page.goto(`/ui-catalog/cms-v2/${screen}?fx=${fx}${extra}`)
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
  await page.locator(`main [data-testid="ui-catalog-cms-${screen}"][data-fx="${fx}"]`).waitFor({ state: 'visible', timeout: 20_000 })
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
async function touchTargets(page: Page, scope: string, where: string) {
  const small = await page.locator(`${scope} a:visible, ${scope} button:visible`).evaluateAll((els) => els.map((e) => {
    const r = e.getBoundingClientRect()
    return { t: (e.textContent ?? '').trim().slice(0, 40), h: Math.round(r.height), w: Math.round(r.width) }
  }).filter((x) => x.h > 0 && x.w > 0 && Math.min(x.h, x.w) < 44))
  expect(small, `${where}: chạm < 44px`).toEqual([])
}
async function noResults(page: Page, scope: string, where: string) {
  const text = await page.locator(scope).innerText()
  for (const w of FORBIDDEN) expect(text, `${where}: P1 không hiện "${w}"`).not.toContain(w)
  expect(text, `${where}: không "0₫" giả`).not.toMatch(/(^|[^0-9.])0₫/)
}
async function shot(page: Page, name: string) {
  if (!SHOTS) return
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true })
}

test.describe('ui v2 CMS P1-d — fixture D1 / D2 bố cục @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })
  const FULL: ['staff' | 'product', string, string][] = [['staff', 'many', '[data-cms-staff]'], ['product', 'product', '[data-cms-staff-product-detail]']]
  for (const [screen, fx, scope] of FULL) for (const theme of ['light', 'dark'] as Theme[]) for (const dev of Object.keys(DEVICES) as Dev[]) {
    test(`${screen}?fx=${fx} ${dev} ${theme}`, async ({ page, baseURL }) => {
      await setup(page, dev, baseURL!)
      await openFx(page, screen, fx, theme)
      await expect(page.locator(`main ${scope}[data-ui-v2="page"]`)).toBeVisible()
      await noPageOverflow(page, `${screen} ${fx} ${dev} ${theme}`)
      if (dev.startsWith('m')) await touchTargets(page, `main ${scope}`, `${screen} ${fx} ${dev}`)
      await noResults(page, `main ${scope}`, `${screen} ${fx}`)
      await shot(page, `staff-${screen}-${fx}-${dev}-${theme}`)
    })
  }
  const REST: ['staff' | 'product', string, string][] = [
    ['staff', 'single', '[data-cms-staff]'], ['staff', 'upcoming', '[data-cms-staff]'], ['staff', 'manager', '[data-cms-staff]'],
    ['staff', 'manager-nokpi', '[data-cms-staff]'], ['staff', 'empty', '[data-cms-staff]'], ['staff', 'no-store', '[data-cms-staff]'], ['staff', 'error', '[data-cms-staff]'],
    ['product', 'catalog', '[data-cms-staff-product-detail]'], ['product', 'none', '[data-cms-staff-product-detail]'],
    ['product', 'long', '[data-cms-staff-product-detail]'], ['product', 'upcoming', '[data-cms-staff-product-detail]'],
  ]
  for (const [screen, fx, scope] of REST) for (const [dev, theme] of [['m360', 'light'], ['d1280', 'dark']] as [Dev, Theme][]) {
    test(`${screen}?fx=${fx} ${dev} ${theme}`, async ({ page, baseURL }) => {
      await setup(page, dev, baseURL!)
      await openFx(page, screen, fx, theme)
      await expect(page.locator(`main ${scope}[data-ui-v2="page"]`)).toBeVisible()
      await noPageOverflow(page, `${screen} ${fx} ${dev} ${theme}`)
      if (dev === 'm360') await touchTargets(page, `main ${scope}`, `${screen} ${fx} ${dev}`)
      await noResults(page, `main ${scope}`, `${screen} ${fx}`)
      await shot(page, `staff-${screen}-${fx}-${dev}-${theme}`)
    })
  }
})

test.describe('ui v2 CMS P1-d — D1 / D2 chức năng (fixture, 0 ghi) @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })
  test('D1 nhiều chương trình: segmented CMS đang chọn; nút chọn mở danh sách 3 chương trình (Sắp diễn ra ghi ngày bắt đầu); thẻ SP → D2', async ({ page }) => {
    const seen = await trapWrites(page)
    await openFx(page, 'staff', 'many')
    const main = page.locator('main [data-cms-staff]')
    await expect(main.locator('[data-cms-targets-segment] a[aria-current="page"]')).toHaveText('CMS sản phẩm')
    // CMS-UI-1 §6.7: fixture giữ demo trong catalog — tab KPI trỏ catalog KPI (route thật vẫn '/targets', kiểm ở cms-ui1-unit).
    await expect(main.locator('[data-cms-targets-segment] a').first()).toHaveAttribute('href', '/ui-catalog/kpi-v2/staff')
    await main.locator('[data-cms-program-picker]').click()
    const list = page.getByRole('dialog').locator('[data-cms-program-list] li')
    await expect(list).toHaveCount(3)
    await expect(page.getByRole('dialog')).toContainText('Bắt đầu 01/12')
    await expect(page.getByRole('dialog').locator('a').first()).toHaveAttribute('href', /^\/ui-catalog\/cms-v2\/staff\?program=/)
    await page.keyboard.press('Escape')
    const card = main.locator('[data-cms-staff-product="900001"]')
    await expect(card).toHaveAttribute('href', /^\/ui-catalog\/cms-v2\/product\?pp=/)
    await expect(card).toContainText('1–9: 15.000₫/hộp · 10–19: 20.000₫/hộp · Từ 20 trở lên: 25.000₫/hộp')
    await expect(card).toContainText('Target 3.000.000₫')
    await expect(main.locator('[data-cms-staff-catalog-target]')).toContainText('1.500.000₫')
    expect(seen).toEqual([])
  })
  test('D1 một chương trình ⇒ nhãn (không nút chọn); sắp diễn ra ⇒ ghi ngày bắt đầu; QLCH ⇒ chỉ xem danh mục, không hero', async ({ page }) => {
    await openFx(page, 'staff', 'single')
    await expect(page.locator('main [data-cms-program-picker]')).toHaveCount(0)
    await expect(page.locator('main [data-cms-program-label]')).toBeVisible()
    await openFx(page, 'staff', 'upcoming')
    await expect(page.locator('main [data-cms-staff-note]')).toContainText('Chương trình bắt đầu 01/12/2026')
    await openFx(page, 'staff', 'manager')
    await expect(page.locator('main [data-cms-staff-note]')).toContainText('Tài khoản cửa hàng chỉ xem danh mục')
    await expect(page.locator('main [data-cms-targets-segment]')).toHaveCount(1)
  })
  test('QLCH khi cờ KPI campaign OFF ⇒ không segmented (không link "KPI chiến dịch" bị chuyển /tasks); tiêu đề CMS sản phẩm', async ({ page }) => {
    await openFx(page, 'staff', 'manager-nokpi')
    const main = page.locator('main [data-cms-staff]')
    await expect(main.locator('h1')).toHaveText('CMS sản phẩm')
    await expect(main.locator('[data-cms-targets-segment]')).toHaveCount(0)
    await expect(main.locator('a[href="/targets"]')).toHaveCount(0)
    await expect(main.locator('[data-cms-staff-note]')).toContainText('Tài khoản cửa hàng chỉ xem danh mục')
    await expect(main.locator('[data-cms-staff-product]').first()).toBeVisible()
  })
  test('D1 rỗng / chưa gán nhà thuốc / lỗi', async ({ page }) => {
    await openFx(page, 'staff', 'empty')
    await expect(page.locator('main [data-cms-staff]')).toContainText('Hiện chưa có chương trình CMS cho nhà thuốc của bạn')
    await openFx(page, 'staff', 'no-store')
    await expect(page.locator('main [data-cms-staff]')).toContainText('Tài khoản chưa được gán nhà thuốc')
    await openFx(page, 'staff', 'error')
    await expect(page.locator('main [data-cms-staff] [role="alert"]')).toContainText('Không tải được danh mục CMS')
  })
  test('D2: điều kiện cấu hình, thang `đ/unit`, quy cách, tư vấn ĐẦY ĐỦ nhiều dòng + Sao chép (toast), không gọi máy chủ', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const seen = await trapWrites(page)
    await openFx(page, 'product', 'long')
    const main = page.locator('main [data-cms-staff-product-detail]')
    await expect(main.locator('[data-cms-staff-gate]')).toContainText('3.000.000₫')
    await expect(main.locator('[data-cms-staff-tier]')).toHaveCount(3)
    await expect(main.locator('[data-cms-staff-tiers]')).toContainText('Từ 20 hộp trở lên')
    await expect(main.locator('[data-cms-staff-tiers]')).toContainText('1 hộp = 30 đơn vị cơ sở')
    const advice = main.locator('[data-cms-staff-advice] p')
    await expect(advice).toContainText('Gợi ý bán kèm: nước muối sinh lý')
    expect(await advice.evaluate((e) => getComputedStyle(e).whiteSpace)).toBe('pre-line')
    expect(await advice.evaluate((e) => (e as HTMLElement).offsetHeight > 120), 'tư vấn hiện đầy đủ, không cắt').toBe(true)
    await main.locator('[data-cms-copy]').click()
    await expect(page.getByText('Đã sao chép')).toBeVisible()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('Hỏi nhu cầu và đối tượng dùng')
    expect(seen).toEqual([])
  })
  test('D2 danh mục / không target / sắp diễn ra', async ({ page }) => {
    await openFx(page, 'product', 'catalog')
    await expect(page.locator('main [data-cms-staff-gate]')).toContainText('tổng GMV các sản phẩm trong nhóm danh mục')
    await expect(page.locator('main [data-cms-staff-tiers]')).toContainText('CMS 8.000₫/chai')
    await openFx(page, 'product', 'none')
    await expect(page.locator('main [data-cms-staff-gate]')).toHaveCount(0)
    // CMS-Q-220: một bậc không giới hạn ⇒ chỉ mức CMS, không "tối đa 50 vỉ" (trước đây bậc 1–50 = trần).
    await expect(page.locator('main [data-cms-staff-tiers]')).toContainText('CMS 5.000₫/vỉ')
    await expect(page.locator('main [data-cms-staff-tiers]')).not.toContainText('tối đa')
    await openFx(page, 'product', 'upcoming')
    await expect(page.locator('main [data-cms-staff-product-detail]')).toContainText('Bắt đầu 01/12/2026')
  })
})

// Route thật — server gate để cờ CMS OFF: `?tab=cms` bị bỏ qua (KPI giữ nguyên, khoá 2 chiều cờ), D2 404.
for (const [who, state, has] of [['staff', STAFF_STATE, HAS_STAFF], ['QLCH', MANAGER_STATE, HAS_MANAGER]] as const) {
  test.describe(`CMS P1-d — route thật cờ CMS OFF (${who}) @desktop`, () => {
    test.skip(!has || process.env.E2E_CMS_ENABLED === '1', `chưa có phiên ${who} / server bật cờ CMS`)
    test.use({ storageState: state })
    test(`${who}: /targets?tab=cms giữ màn KPI (không segmented, không màn CMS); D2 ⇒ trang 404`, async ({ page }) => {
      await page.setViewportSize(DEVICES.m390)
      await page.goto('/targets?tab=cms')
      await expect(page.locator('main [data-staff-targets]')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('main [data-cms-staff]')).toHaveCount(0)
      await expect(page.locator('main [data-cms-targets-segment]')).toHaveCount(0)
      await page.goto('/targets/cms/products/00000000-0000-4000-8000-000000005001')
      await expect(page.locator('main').getByText('This page could not be found.')).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('main [data-cms-staff-product-detail]')).toHaveCount(0)
    })
  })
}
