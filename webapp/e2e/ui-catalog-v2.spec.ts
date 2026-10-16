import fs from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import { SUPER_STATE } from './authState'

// UI v2 Tasks — P1.0 nền tảng (docs/ui/UI_V2_TASKS.md). /ui-catalog/tasks-v2 = 100% fixture, gốc
// data-ui-v2="page" ⇒ snapshot COMMIT được (như /ui-catalog). Kèm guardrail đo computed style:
// token/bán kính/tab trung tính chỉ có hiệu lực TRONG phạm vi, còn /ui-catalog mặc định giữ nguyên
// (snapshot e2e/ui-catalog.spec.ts không được cập nhật trong batch này).
// Server: UI_CATALOG=1 + phiên super (e2e/auth.setup.ts ghi SUPER_STATE).

const HAS_STATE = fs.existsSync(SUPER_STATE)
const THEMES = ['light', 'dark'] as const

async function open(page: Page, path: string, theme: (typeof THEMES)[number], testId: string) {
  await page.goto(path)
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
  await page.getByTestId(testId).waitFor({ state: 'visible', timeout: 20_000 })
  await page.evaluate(() => document.fonts.ready)
}

// Ẩn shell thật (tên/email người đăng nhập = PII) + mở khoá cuộn lồng để chụp trọn phần tử — như ui-catalog.spec.
async function hideShell(page: Page) {
  await page.evaluate(() => {
    document.querySelectorAll('header.bg-primary, aside.bg-sidebar, nav[aria-label="Điều hướng chính"], nextjs-portal').forEach((el) => {
      ;(el as HTMLElement).style.display = 'none'
    })
    const main = document.querySelector('main')
    const outer = main?.parentElement
    if (outer instanceof HTMLElement) { outer.style.height = 'auto'; outer.style.overflow = 'visible' }
    if (main instanceof HTMLElement) { main.style.overflow = 'visible' }
  })
}

const radius = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius))

for (const tag of ['@desktop', '@mobile'] as const) {
  test.describe(`ui catalog v2 ${tag}`, () => {
    test.skip(!HAS_STATE, 'chưa có phiên super (chạy project setup với E2E_SUPER_*)')
    test.use({ storageState: SUPER_STATE })

    test(`catalog v2 light+dark ${tag}`, async ({ page }) => {
      test.setTimeout(120_000)
      for (const theme of THEMES) {
        await open(page, '/ui-catalog/tasks-v2', theme, 'ui-catalog-v2')
        await hideShell(page)
        const cat = page.getByTestId('ui-catalog-v2')
        await cat.getByRole('heading', { name: 'DetailPageShell v2' }).waitFor()
        const box = await cat.boundingBox()
        expect(box!.height).toBeGreaterThan(page.viewportSize()!.height)
        await page.waitForTimeout(250)
        // animations disabled: skeleton animate-pulse làm ảnh lệch 1–4% mỗi lần chụp (P1.1) ⇒ dừng để so chính xác.
        expect(await cat.screenshot({ animations: 'disabled' })).toMatchSnapshot(`catalog-v2-${theme}.png`, { maxDiffPixelRatio: 0.01 })
      }
    })
  })
}

test.describe('ui v2 guardrails @mobile', () => {
  test.skip(!HAS_STATE, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('trong v2: panel 12 / control 10 / chip 6, chấm badge, tab trung tính, touch ≥44, input ≥16px', async ({ page }) => {
    await open(page, '/ui-catalog/tasks-v2', 'light', 'ui-catalog-v2')
    // Nền <main> = canvas v2 (#F7F6F4)
    expect(await page.locator('main').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(247, 246, 244)')
    // Bán kính theo token v2
    expect(await radius(page, '[data-ui-v2] [data-slot="card"]')).toBe(12)
    expect(await radius(page, '[data-ui-v2] [data-slot="button"]')).toBe(10)
    expect(await radius(page, '[data-ui-v2] [data-slot="input"]')).toBe(10)
    expect(await radius(page, '[data-ui-v2] [data-slot="select-trigger"]')).toBe(10)
    const badge = page.getByText('Quá hạn', { exact: true }).first()
    expect(await badge.evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius))).toBe(6)
    // Chấm của StatusBadge hiện (6px) trong v2 (flex item ⇒ display bị blockify, đo hộp thật)
    const dot = await badge.locator('span[aria-hidden="true"]').boundingBox()
    expect(dot!.width).toBeCloseTo(6, 0)
    expect(dot!.height).toBeCloseTo(6, 0)
    // Tab đang chọn TRUNG TÍNH: nền = panel trắng, không phải action
    const active = page.locator('nav[aria-label="Bộ lọc"] a[aria-current="page"]')
    expect(await active.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)')
    // Primary trong v2 = action #C94A16 + chữ trắng
    const primary = page.getByRole('button', { name: 'Primary' })
    expect(await primary.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(201, 74, 22)')
    // Touch target mobile
    for (const name of ['Tạo Task', 'Xuất Excel', 'Xoá bộ lọc', 'Xuất đã chọn (2)']) {
      expect((await page.getByRole('button', { name }).boundingBox())!.height, name).toBeGreaterThanOrEqual(44)
    }
    expect((await active.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    // Input/textarea mobile ≥16px (iOS zoom). Bỏ qua <input> ẩn base-ui Select sinh cho form (hộp ~0px,
    // không nhận focus của người dùng) — chỉ đo control nhìn thấy được.
    const fonts = await page.locator('main input, main textarea').evaluateAll((els) => els
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2 })
      .map((el) => parseFloat(getComputedStyle(el).fontSize)))
    expect(fonts.length).toBeGreaterThan(0)
    for (const f of fonts) expect(f).toBeGreaterThanOrEqual(16)
  })

  test('ngoài v2 (/ui-catalog): token rỗng, chấm ẩn, tab cam, button 4px, card ≤8px', async ({ page }) => {
    await open(page, '/ui-catalog', 'light', 'ui-catalog')
    const root = page.getByTestId('ui-catalog')
    expect(await root.evaluate((el) => getComputedStyle(el).getPropertyValue('--v2-canvas').trim())).toBe('')
    expect(await page.locator('main').evaluate((el) => getComputedStyle(el).getPropertyValue('--v2-canvas').trim())).toBe('')
    const badge = root.getByText('Quá hạn', { exact: true }).first()
    expect(await badge.locator('span[aria-hidden="true"]').evaluate((el) => getComputedStyle(el).display)).toBe('none')
    expect(await badge.evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius))).toBeLessThan(6)
    const active = root.locator('nav[aria-label="Bộ lọc"] a[aria-current="page"]').first()
    const primaryBg = await root.getByRole('button', { name: 'Action' }).evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(await active.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(primaryBg)
    // Button sm mặc định = min(--radius-md, 12px) = 6,4px — KHÔNG được thành 10px (control v2)
    expect(await root.getByRole('button', { name: 'Action' }).evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius))).toBeLessThan(10)
    const radii = await root.locator('[data-slot="card"]').evaluateAll((els) => els.map((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius)))
    for (const r of radii) expect(r).toBeLessThanOrEqual(8)
  })
})

test.describe('ui v2 desktop @desktop', () => {
  test.skip(!HAS_STATE, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('dark: canvas + action đảo đúng palette; tab desktop ≥30px', async ({ page }) => {
    await open(page, '/ui-catalog/tasks-v2', 'dark', 'ui-catalog-v2')
    expect(await page.locator('main').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(18, 17, 16)')
    const primary = page.getByRole('button', { name: 'Primary' })
    expect(await primary.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(243, 116, 63)')
    expect(await primary.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(20, 18, 16)')
    const active = page.locator('nav[aria-label="Bộ lọc"] a[aria-current="page"]')
    expect(await active.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(26, 24, 23)')
    const h = (await active.boundingBox())!.height
    expect(h).toBeGreaterThanOrEqual(30)
    expect(h).toBeLessThan(44)
  })
})
