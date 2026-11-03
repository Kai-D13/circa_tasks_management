import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { SUPER_STATE } from './authState'
import { trapWrites } from './fixtureGuard'
import { CMS_FX_STAFF_ENDED } from '../lib/cms/fixturesStaff'

// CMS P3a r2 (PM r1 PKG-P1-1 / PKG-P1-2) — lối đọc sau hết kỳ / đã chốt cho staff / QLCH qua fixture /ui-catalog/cms-v2/{staff,
// product,history}?fx= (ĐÚNG view của route thật; số liệu giả cùng run) + A3 khi server QA chỉ đọc (detail?p3=qa-readonly):
//   · D1: bộ chọn có nhóm "Đã kết thúc" (Chờ chốt kỳ / Đã chốt) — chương trình đã kết thúc vẫn mở được; Chờ chốt kỳ = tạm tính
//     "chờ chốt", Đã chốt = "CMS đã chốt" (run đóng băng); không gợi ý gần đạt / gợi ý bán thêm khi đã kết thúc; QLCH nhãn nhà thuốc;
//   · D2 đã chốt: "CMS đã chốt", không "Nếu bán thêm"; D3: chương trình đã chốt có trong danh sách, ghi chú "Đã chốt kỳ";
//   · 360 / 390 / 1280 × sáng / tối không cuộn ngang, chạm ≥ 44 trên mobile; 0 request ghi.

const HAS_SUPER = fs.existsSync(SUPER_STATE)
const SHOTS = process.env.CMS_SHOTS_DIR
type Theme = 'light' | 'dark'
type Screen = 'staff' | 'product' | 'history' | 'detail'
const DEVICES = { m360: { width: 360, height: 800 }, m390: { width: 390, height: 844 }, d1280: { width: 1280, height: 900 } } as const
type Dev = keyof typeof DEVICES
const [ENDED, LOCKED] = CMS_FX_STAFF_ENDED

async function open(page: Page, screen: Screen, qs: string, theme: Theme = 'light') {
  await page.goto(`/ui-catalog/cms-v2/${screen}?${qs}`)
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
  await page.locator(`main [data-testid="ui-catalog-cms-${screen}"]`).waitFor({ state: 'visible', timeout: 20_000 })
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
async function touchTargets(page: Page, where: string) {
  const small = await page.locator('main [data-ui-v2="page"] a:visible, main [data-ui-v2="page"] button:visible').evaluateAll((els) => els.map((e) => {
    const r = e.getBoundingClientRect()
    return { t: (e.textContent ?? '').trim().slice(0, 40), h: Math.round(r.height), w: Math.round(r.width) }
  }).filter((x) => x.h > 0 && x.w > 0 && Math.min(x.h, x.w) < 44))
  expect(small, `${where}: chạm < 44px`).toEqual([])
}
async function shot(page: Page, name: string) {
  if (!SHOTS) return
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true })
}

test.describe('ui v2 CMS P3a r2 — bố cục lối đọc sau hết kỳ / đã chốt @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })
  const MATRIX: [Screen, string][] = [
    ['staff', 'fx=history&p2=running'], ['staff', 'fx=ended&p2=running'], ['staff', 'fx=locked&p2=running'], ['staff', 'fx=locked-manager&p2=running'],
    ['product', 'fx=locked&p2=running'], ['history', `fx=with-ended&program=${LOCKED.id}`], ['detail', 'p3=qa-readonly'],
  ]
  for (const [screen, qs] of MATRIX) for (const theme of ['light', 'dark'] as Theme[]) for (const dev of Object.keys(DEVICES) as Dev[]) {
    test(`${screen}?${qs} ${dev} ${theme}`, async ({ page }) => {
      const writes = await trapWrites(page)
      await page.setViewportSize(DEVICES[dev])
      await open(page, screen, qs, theme)
      await noPageOverflow(page, `${screen} ${qs} ${dev} ${theme}`)
      if (dev !== 'd1280' && screen !== 'detail') await touchTargets(page, `${screen} ${qs} ${dev}`)
      await shot(page, `p3a-r2-${screen}-${qs.replace(/[=&]/g, '_').slice(0, 60)}-${dev}-${theme}`)
      expect(writes).toEqual([])
    })
  }
})

test.describe('ui v2 CMS P3a r2 — hành vi lối đọc sau hết kỳ / đã chốt @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('D1 bộ chọn: nhóm "Đang áp dụng" + "Đã kết thúc" (Chờ chốt kỳ, Đã chốt); mặc định vẫn chương trình đang chạy; link mở chương trình đã chốt', async ({ page }) => {
    const writes = await trapWrites(page)
    await open(page, 'staff', 'fx=history&p2=running')
    const main = page.locator('main [data-cms-staff]')
    await expect(main.locator('[data-cms-program-picker]')).toContainText('Đang chạy')
    await main.locator('[data-cms-program-picker]').click()
    const dlg = page.getByRole('dialog')
    await expect(dlg.locator('[data-cms-program-group="current"] li')).toHaveCount(3)
    await expect(dlg.locator('[data-cms-program-group="ended"] li')).toHaveCount(2)
    await expect(dlg.locator('[data-cms-program-group="ended"]')).toContainText('Chờ chốt kỳ')
    await expect(dlg.locator('[data-cms-program-group="ended"]')).toContainText('Đã chốt')
    await expect(dlg.getByRole('link', { name: new RegExp(LOCKED.name) })).toHaveAttribute('href', `/targets?tab=cms&program=${LOCKED.id}`)
    expect(writes).toEqual([])
  })

  test('D1 Chờ chốt kỳ: tạm tính "chờ chốt", không gợi ý gần đạt, thẻ không "Còn … lên"', async ({ page }) => {
    await open(page, 'staff', 'fx=ended&p2=running')
    const main = page.locator('main [data-cms-staff]')
    await expect(main.locator('[data-cms-staff-note]')).toContainText(`Đã kết thúc ngày`)
    await expect(main.locator('[data-cms-hero-title]')).toHaveText('CMS tạm tính của bạn')
    await expect(main.locator('[data-cms-updated="waiting_close"]')).toContainText('chờ chốt kỳ')
    await expect(main.locator('[data-cms-near-gate]')).toHaveCount(0)
    expect(await main.locator('[data-cms-tier-line]').allInnerTexts()).not.toContainEqual(expect.stringMatching(/Còn \d|Cần đạt target trước|Bán \d/))
    await expect(main.locator('[data-cms-program-picker]')).toContainText('Chờ chốt kỳ')
  })

  test('D1 Đã chốt (staff / QLCH): "CMS đã chốt" theo run đóng băng, badge Đã chốt, link Xem ghi nhận còn', async ({ page }) => {
    await open(page, 'staff', 'fx=locked&p2=running')
    const main = page.locator('main [data-cms-staff]')
    await expect(main.locator('[data-cms-staff-note]')).toContainText('Đã chốt kỳ')
    await expect(main.locator('[data-cms-hero-title]')).toHaveText('CMS đã chốt của bạn')
    await expect(main.locator('[data-cms-updated="locked"]')).toContainText('Đã chốt kỳ · số theo lần tính')
    await expect(main.locator('[data-cms-hero-amount]')).not.toHaveText('—')
    await expect(main.locator('[data-cms-near-gate]')).toHaveCount(0)
    await expect(main.locator('[data-cms-program-picker]')).toContainText('Đã chốt')
    await expect(main.getByRole('link', { name: /Xem ghi nhận/ })).toHaveAttribute('href', new RegExp(`program=${LOCKED.id}`))
    await open(page, 'staff', 'fx=locked-manager&p2=running')
    await expect(page.locator('main [data-cms-store-title]')).toHaveText('CMS đã chốt của nhà thuốc')
    await expect(page.locator('main [data-cms-hero-title]')).toHaveCount(0)
  })

  test('D2 Đã chốt: "CMS đã chốt", không "Nếu bán thêm"; D2 Chờ chốt kỳ cũng không "Nếu bán thêm"', async ({ page }) => {
    await open(page, 'product', 'fx=locked&p2=running')
    const main = page.locator('main [data-cms-staff-product-detail]')
    await expect(main.locator('[data-cms-product-title]')).toHaveText('CMS đã chốt')
    await expect(main.locator('[data-cms-updated="locked"]')).toContainText('Đã chốt kỳ')
    await expect(main.locator('[data-cms-what-if]')).toHaveCount(0)
    await open(page, 'product', 'fx=ended&p2=running')
    await expect(page.locator('main [data-cms-what-if]')).toHaveCount(0)
    await expect(page.locator('main [data-cms-updated="waiting_close"]')).toContainText('chờ chốt kỳ')
  })

  test('D3: chương trình Đã chốt có trong danh sách (3 gần nhất + Khác), ghi chú "Đã chốt kỳ", dòng của run đóng băng', async ({ page }) => {
    await open(page, 'history', `fx=with-ended&program=${LOCKED.id}`)
    const main = page.locator('main [data-cms-history]')
    await expect(main.locator('[data-cms-history-total]')).toContainText('Đã chốt')
    await expect(main.locator('[data-cms-history-note="locked"]')).toContainText('Đã chốt kỳ — số đã chốt')
    await expect(main.locator('[data-cms-history-amount]')).not.toHaveText('—')
    await expect(main.locator('[data-cms-line]').first()).toBeVisible()
    await open(page, 'history', `fx=with-ended&program=${ENDED.id}`)
    await expect(page.locator('main [data-cms-history-note="waiting_close"]')).toContainText('Chờ chốt kỳ')
  })

  test('A3 server QA chỉ đọc: thông báo + nút Chốt kỳ… khoá (server từ chối trước RPC — kiểm ở qa-cms-lock-wiring)', async ({ page }) => {
    await open(page, 'detail', 'p3=qa-readonly')
    await expect(page.locator('main [data-cms-lock-panel]')).toContainText('Server QA chỉ đọc')
    await expect(page.locator('main [data-cms-lock-open]')).toBeDisabled()
  })

  test('A3 hộp chốt: checkbox "Tôi đã kiểm tra số liệu" bắt buộc trước nút Chốt kỳ (UI_V2_CMS §3.4)', async ({ page }) => {
    const writes = await trapWrites(page)
    await open(page, 'detail', 'p3=ready')
    await page.locator('main [data-cms-lock-open]').click()
    const dlg = page.getByRole('dialog')
    await expect(dlg.locator('[data-cms-lock-confirm]')).toBeDisabled()
    await dlg.getByLabel('Tôi đã kiểm tra số liệu').check()
    await expect(dlg.locator('[data-cms-lock-confirm]')).toBeEnabled()
    await dlg.getByRole('button', { name: 'Để sau' }).click()
    await page.locator('main [data-cms-lock-open]').click()
    await expect(page.getByRole('dialog').getByLabel('Tôi đã kiểm tra số liệu')).not.toBeChecked() // mở lại ⇒ phải xác nhận lại
    expect(writes).toEqual([])
  })
})
