import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { SUPER_STATE } from './authState'
import { trapWrites } from './fixtureGuard'
import { CMS_FX_PG_SIMPLE, cmsFxProgram } from '../lib/cms/fixtureScenario'
import { cmsFxStaffResults, cmsFxStoreResults } from '../lib/cms/fixturesResults'
import { cmsVnd } from '../lib/cms/display'
import type { CmsResultsLoad } from '../lib/cms/resultUi'

// CMS đơn giản S3 (PM spec r1 08/11 §6) — fixture /ui-catalog/cms-v2/{staff,product,history} với chương trình mức cố định PG10–12
// (ĐÚNG view của route thật, số giả do engine tính). Kiểm: thẻ "Mức CMS X₫/hộp" + "Đã bán N · tính Q", không badge / bậc / lũy tiến /
// target / gợi ý; D2 "Q × X = A" khớp snapshot, phần lẻ theo đơn vị cơ sở, KHÔNG "Nếu bán thêm" (chỉ dòng tĩnh khi đang chạy); QLCH
// không "bậc riêng"; config_reset không 0₫ giả; tab đang chọn nền action + hero nền selected nhạt đạt tương phản ≥ 4,5 ở cả hai theme;
// 360 / 390 / 1280 không cuộn ngang, chạm ≥ 44 trên mobile; 0 request ghi.

const HAS_SUPER = fs.existsSync(SUPER_STATE)
const SHOTS = process.env.CMS_SHOTS_DIR
type Theme = 'light' | 'dark'
type Screen = 'staff' | 'product' | 'history'
const DEVICES = { m360: { width: 360, height: 800 }, m390: { width: 390, height: 844 }, d1280: { width: 1280, height: 900 } } as const
type Dev = keyof typeof DEVICES
const PG10 = cmsFxProgram(CMS_FX_PG_SIMPLE.PG10)!
const PG12 = cmsFxProgram(CMS_FX_PG_SIMPLE.PG12)!
const pp = (p: typeof PG10, pid: string) => p.products.find((x) => x.productId === pid)!.id

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

/** Màu chữ / nền (nền = tổ tiên gần nhất có nền đặc) qua canvas ⇒ rgb, tương phản WCAG; độ sáng nền. Không hardcode mã màu. */
async function colorsOf(loc: Locator): Promise<{ contrast: number; bgLum: number }> {
  return loc.evaluate((el) => {
    const cv = document.createElement('canvas'); cv.width = 1; cv.height = 1
    const cx = cv.getContext('2d', { willReadFrequently: true })!
    const rgba = (c: string) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255] }
    const lum = (x: number[]) => { const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(x[0]) + 0.7152 * f(x[1]) + 0.0722 * f(x[2]) }
    let bg: number[] = [255, 255, 255, 1]
    for (let e: Element | null = el; e; e = e.parentElement) { const c = rgba(getComputedStyle(e).backgroundColor); if (c[3] > 0.99) { bg = c; break } }
    const a = lum(rgba(getComputedStyle(el).color)), b = lum(bg)
    return { contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), bgLum: b }
  })
}

const sum = (l: CmsResultsLoad, ppId?: string) => {
  if (l.kind !== 'loaded') throw new Error('fx')
  return l.rows.results.filter((r) => !ppId || r.programProductId === ppId).reduce((a, r) => a + BigInt(r.amountVnd), BigInt(0))
}
const STAFF = cmsFxStaffResults('running', PG10.row.id)
const STORE = cmsFxStoreResults('running', PG10.row.id)
const fake0 = /(^|[^0-9.])0₫/

test.describe('ui v2 CMS đơn giản — bố cục @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })
  const MATRIX: [Screen, string][] = [
    ['staff', 'fx=simple&p2=running'], ['staff', 'fx=simple-manager&p2=running'], ['staff', 'fx=simple&p2=reset'], ['staff', 'fx=simple-upcoming'],
    ['staff', 'fx=simple&p2=held'], ['staff', 'fx=simple-ended&p2=running'],
    ['product', `pp=${pp(PG10, '900103')}&p2=running`], ['product', `pp=${pp(PG10, '900106')}&p2=running`], ['history', 'fx=simple'],
  ]
  for (const [screen, qs] of MATRIX) for (const theme of ['light', 'dark'] as Theme[]) for (const dev of Object.keys(DEVICES) as Dev[]) {
    test(`${screen}?${qs} ${dev} ${theme}`, async ({ page }) => {
      const writes = await trapWrites(page)
      await page.setViewportSize(DEVICES[dev])
      await open(page, screen, qs, theme)
      await noPageOverflow(page, `${screen} ${qs} ${dev} ${theme}`)
      if (dev !== 'd1280') await touchTargets(page, `${screen} ${qs} ${dev}`)
      await shot(page, `simple-${screen}-${qs.replace(/[=&]/g, '_').slice(0, 60)}-${dev}-${theme}`)
      expect(writes).toEqual([])
    })
  }
})

test.describe('ui v2 CMS đơn giản — tab action + hero nền selected nhạt, tương phản cả hai theme @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })
  for (const theme of ['light', 'dark'] as Theme[]) {
    test(`segment / tab D3 / hero staff + QLCH — ${theme}`, async ({ page }) => {
      await page.setViewportSize(DEVICES.m390)
      await open(page, 'staff', 'fx=simple&p2=running', theme)
      const main = page.locator('main [data-cms-staff]')
      const active = main.locator('[data-cms-targets-segment] a[aria-current="page"]')
      await expect(active).toHaveText('CMS sản phẩm')
      const a = await colorsOf(active)
      expect(a.contrast, 'tab đang chọn').toBeGreaterThanOrEqual(4.5)
      const inactive = await colorsOf(main.locator('[data-cms-targets-segment] a:not([aria-current])'))
      expect(inactive.contrast, 'tab còn lại').toBeGreaterThanOrEqual(4.5)
      // Tab đang chọn khác hẳn nền khung (không còn "mờ"): độ sáng nền lệch rõ so với tab còn lại.
      expect(Math.abs(a.bgLum - inactive.bgLum), 'tab đang chọn nổi khỏi khung').toBeGreaterThan(0.1)
      const hero = main.locator('[data-cms-hero="ok"]')
      const h = await colorsOf(hero.locator('[data-cms-hero-amount]'))
      expect(h.contrast, 'số tiền hero').toBeGreaterThanOrEqual(4.5)
      expect((await colorsOf(hero.locator('[data-cms-hero-title]'))).contrast, 'nhãn hero').toBeGreaterThanOrEqual(4.5)
      // Không còn "thẻ đen": sáng ⇒ nền hero sáng; tối ⇒ nền hero tối (selected), chữ sáng.
      if (theme === 'light') expect(h.bgLum, 'hero sáng không nền đen').toBeGreaterThan(0.75)
      else expect(h.bgLum, 'hero tối dùng nền selected tối').toBeLessThan(0.05)
      await open(page, 'staff', 'fx=simple-manager&p2=running', theme)
      const s = await colorsOf(page.locator('main [data-cms-store-hero="ok"] [data-cms-store-amount]'))
      expect(s.contrast, 'số tiền QLCH').toBeGreaterThanOrEqual(4.5)
      if (theme === 'light') expect(s.bgLum).toBeGreaterThan(0.75)
      await open(page, 'history', 'fx=simple', theme)
      const t = await colorsOf(page.locator('main nav[aria-label="Chương trình"] a[aria-current="page"]'))
      expect(t.contrast, 'tab chương trình D3').toBeGreaterThanOrEqual(4.5)
    })
  }
})

test.describe('ui v2 CMS đơn giản — D1 / D2 / D3 / QLCH @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('D1 staff: thẻ "Mức CMS X₫/hộp" + "Đã bán N · tính Q"; không badge / bậc / lũy tiến / target / gợi ý; hero = Σ engine', async ({ page }) => {
    const writes = await trapWrites(page)
    await open(page, 'staff', 'fx=simple&p2=running')
    const main = page.locator('main [data-cms-staff]')
    await expect(main).toHaveAttribute('data-cms-results', 'loaded')
    await expect(main.locator('[data-cms-hero-amount]')).toHaveText(cmsVnd(sum(STAFF)))
    await expect(main.locator('[data-cms-staff-product]')).toHaveCount(6)
    await expect(main.locator('[data-cms-staff-product][data-cms-flat]')).toHaveCount(6)
    await expect(main.locator('[data-cms-flat-rate]')).toHaveText(['Mức CMS 58.000₫/hộp', 'Mức CMS 24.000₫/hộp', 'Mức CMS 31.500₫/hộp', 'Mức CMS 17.000₫/hộp', 'Mức CMS 18.000₫/hộp', 'Mức CMS 42.800₫/hộp'])
    await expect(main.locator('[data-cms-staff-product="900103"] [data-cms-sold]')).toHaveText('Đã bán 2,5 hộp · tính 2 hộp')
    await expect(main.locator('[data-cms-staff-product="900103"]')).toContainText('63.000₫')
    await expect(main.locator('[data-cms-staff-product="900106"] [data-cms-sold]')).toHaveText('Đã bán 1.250 hộp · tính 1.250 hộp')
    await expect(main.locator('[data-cms-staff-product="900105"] [data-cms-sold]')).toHaveText('Đã bán 0 hộp')
    await expect(main.locator('[data-cms-tier-line], [data-cms-near-gate], [data-cms-staff-catalog-target], [data-cms-gate]')).toHaveCount(0)
    const text = await main.innerText()
    expect(text).not.toMatch(/Theo số lượng|Bậc|bậc|Lũy tiến|Thang CMS|[Tt]arget/)
    await expect(main.locator('[data-cms-card-filter] a')).toHaveText(['Tất cả (6)', 'Có CMS (5)', 'Chưa có CMS (1)'])
    expect(writes).toEqual([])
  })

  test('D1 QLCH: tổng nhà thuốc không "bậc riêng", thẻ mức cố định + số dược sĩ có bán; không hero "của bạn"', async ({ page }) => {
    await open(page, 'staff', 'fx=simple-manager&p2=running')
    const main = page.locator('main [data-cms-staff]')
    await expect(main.locator('[data-cms-store-amount]')).toHaveText(cmsVnd(sum(STORE)))
    await expect(main.locator('[data-cms-store-note]')).toHaveText('Cộng CMS từng dược sĩ hiện thuộc nhà thuốc.')
    await expect(main.locator('[data-cms-hero], [data-cms-near-gate]')).toHaveCount(0)
    await expect(main.locator('[data-cms-flat-rate]')).toHaveCount(6)
    expect(await main.innerText()).not.toMatch(/bậc|Bậc|của bạn/)
    // Chương trình trộn (PG1) giữ câu "mỗi người tính bậc riêng".
    await open(page, 'staff', 'fx=manager&p2=running')
    await expect(page.locator('main [data-cms-store-note]')).toContainText('mỗi người tính bậc riêng')
  })

  test('D2 phần lẻ: "Q hộp × X₫ = A₫" khớp snapshot, phần lẻ theo đơn vị cơ sở, khối "Mức CMS" + quy cách; không "Nếu bán thêm"', async ({ page }) => {
    const writes = await trapWrites(page)
    const id = pp(PG10, '900103')
    await open(page, 'product', `pp=${id}&p2=running`)
    const main = page.locator('main [data-cms-staff-product-detail]')
    await expect(main.locator('[data-cms-product-cms]')).toHaveText(cmsVnd(sum(STAFF, id)))
    await expect(main.locator('[data-cms-qty-line]')).toHaveText('Đã bán 2,5 hộp')
    await expect(main.locator('[data-cms-flat-equation]')).toHaveText('2 hộp × 31.500₫ = 63.000₫')
    await expect(main.locator('[data-cms-qty-explain]')).toContainText('Phần lẻ 0,5 hộp chưa đủ 1 hộp — đang cộng dồn (5 / 10 đơn vị cơ sở)')
    const rate = main.locator('[data-cms-staff-rate]')
    await expect(rate).toContainText('31.500₫/hộp')
    await expect(rate).toContainText('1 hộp = 10 đơn vị cơ sở')
    await expect(main.locator('[data-cms-flat-each]')).toHaveText('Mỗi hộp được tính CMS 31.500₫.')
    await expect(main.locator('[data-cms-what-if], [data-cms-tier-breakdown], [data-cms-staff-tiers], [data-cms-staff-gate]')).toHaveCount(0)
    expect(await main.innerText()).not.toMatch(/Lũy tiến|Thang CMS|Bậc|Nếu bán thêm/)
    await expect(main.locator('[data-cms-staff-advice]')).toBeVisible()
    await expect(main.locator('[data-cms-recent]')).toBeVisible()
    expect(writes).toEqual([])
  })

  test('D2 số lớn / chưa bán / không giá; hết kỳ ⇒ không dòng gợi ý; QLCH không "bậc riêng"', async ({ page }) => {
    await open(page, 'product', `pp=${pp(PG10, '900106')}&p2=running`)
    let main = page.locator('main [data-cms-staff-product-detail]')
    await expect(main.locator('[data-cms-flat-equation]')).toHaveText('1.250 hộp × 42.800₫ = 53.500.000₫')
    await open(page, 'product', `pp=${pp(PG10, '900105')}&p2=running`)
    main = page.locator('main [data-cms-staff-product-detail]')
    await expect(main.locator('[data-cms-flat-equation]')).toHaveText('0 hộp × 18.000₫ = 0₫')
    await open(page, 'product', `pp=${pp(PG10, '900104')}&p2=running`)
    await expect(page.locator('main [data-cms-staff-product-detail] h1 + p')).not.toContainText('₫')
    await open(page, 'product', `pp=${pp(PG12, '900101')}&p2=running`)
    main = page.locator('main [data-cms-staff-product-detail]')
    await expect(main).toContainText('Chờ chốt kỳ')
    await expect(main.locator('[data-cms-flat-equation]')).toHaveText('4 hộp × 58.000₫ = 232.000₫')
    await expect(main.locator('[data-cms-flat-each], [data-cms-what-if]')).toHaveCount(0)
    await open(page, 'product', `pp=${pp(PG10, '900101')}&p2=running&as=manager`)
    main = page.locator('main [data-cms-staff-product-detail]')
    await expect(main.locator('[data-cms-store-product]')).toBeVisible()
    expect(await main.locator('[data-cms-store-product]').innerText()).not.toMatch(/bậc/)
  })

  test('config_reset: "Chưa có số liệu sau thay đổi cấu hình", hero / thẻ / D2 không 0₫ giả, không phép nhân', async ({ page }) => {
    await open(page, 'staff', 'fx=simple&p2=reset')
    const main = page.locator('main [data-cms-staff]')
    await expect(main.locator('[data-cms-hero="none"] [data-cms-hero-amount]')).toHaveText('—')
    await expect(main.locator('[data-cms-no-run="config_reset"]')).toContainText('Chưa có số liệu sau thay đổi cấu hình')
    expect(await main.locator('[data-cms-hero]').innerText()).not.toMatch(fake0)
    await expect(main.locator('[data-cms-sold]')).toHaveCount(0)
    await expect(main.locator('[data-cms-flat-rate]')).toHaveCount(6)
    await open(page, 'product', `pp=${pp(PG10, '900101')}&p2=reset`)
    const d = page.locator('main [data-cms-staff-product-detail]')
    await expect(d.locator('[data-cms-product-cms]')).toHaveText('—')
    await expect(d.locator('[data-cms-product-amount]')).toContainText('Chưa có số liệu sau thay đổi cấu hình')
    await expect(d.locator('[data-cms-flat-equation]')).toHaveCount(0)
  })

  test('D3 ghi nhận: SP mức cố định không ghi " · bậc k"', async ({ page }) => {
    await open(page, 'history', 'fx=simple')
    const main = page.locator('main [data-cms-history]')
    await expect(main.locator('nav[aria-label="Chương trình"] a[aria-current="page"]')).toContainText('CMS mẫu mức cố định')
    expect(await main.innerText()).not.toMatch(/bậc \d/)
  })
})

// ── S1 / S2 màn import (fixture wizard, cờ v2 giả lập) ──────────────────────────────────────────────────────────────────────
async function openWizard(page: Page, fx: string, theme: Theme = 'light') {
  await page.goto(`/ui-catalog/cms-v2/wizard?fx=${fx}`)
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
  await page.locator('main [data-testid="ui-catalog-cms-wizard"]').waitFor({ state: 'visible', timeout: 20_000 })
}

test.describe('ui v2 CMS đơn giản — import mức cố định + kiểm K (fixture) @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  for (const fx of ['upload-v2', 'result-simple', 'result-simple-unavailable', 'result-simple-nok']) for (const theme of ['light', 'dark'] as Theme[]) for (const dev of Object.keys(DEVICES) as Dev[]) {
    test(`wizard ${fx} ${dev} ${theme}: không cuộn ngang trang, chạm ≥ 44`, async ({ page }) => {
      const writes = await trapWrites(page)
      await page.setViewportSize(DEVICES[dev])
      await openWizard(page, fx, theme)
      await noPageOverflow(page, `wizard ${fx} ${dev} ${theme}`)
      if (dev !== 'd1280') await touchTargets(page, `wizard ${fx} ${dev}`)
      await shot(page, `simple-wizard-${fx}-${dev}-${theme}`)
      expect(writes).toEqual([])
    })
  }

  test('cờ v2 OFF (fx=upload): không có bộ chọn loại file, mẫu 9 cột như cũ; v2 ON: chọn "Mức cố định" ⇒ mẫu + cột hướng dẫn mức cố định', async ({ page }) => {
    await openWizard(page, 'upload')
    let main = page.locator('main [data-cms-import-flow]')
    await expect(main.locator('[data-cms-import-format]')).toHaveCount(0)
    await expect(main.getByRole('link', { name: /Tải file mẫu/ })).toHaveAttribute('href', '/templates/Circa_Import_CMS.xlsx')
    await openWizard(page, 'upload-v2')
    main = page.locator('main [data-cms-import-flow]')
    await expect(main.locator('[data-cms-import-format]')).toHaveAttribute('data-cms-import-format', 'tiers')
    await main.getByRole('radio', { name: /Mức cố định/ }).check()
    await expect(main.locator('[data-cms-import-format]')).toHaveAttribute('data-cms-import-format', 'simple')
    await expect(main.getByRole('link', { name: /Tải file mẫu mức cố định/ })).toHaveAttribute('href', '/templates/Circa_Import_CMS_muc_co_dinh.xlsx')
    await expect(main).toContainText('CMS proposal')
    await expect(main).toContainText('KHÔNG dùng trong công thức CMS')
    await expect(main).toContainText('K (quy đổi đơn vị) đối chiếu với dữ liệu bán')
  })

  test('kết quả: tóm tắt "N sản phẩm · mỗi sản phẩm một mức / đơn vị · không target"; SP hợp lệ hiện "Mức CMS"; bảng K 7 trạng thái, chỉ CHƯA CÓ BẰNG CHỨNG có ô xác nhận; xác nhận tay không thành "KHỚP"; 0 ghi', async ({ page }) => {
    const writes = await trapWrites(page)
    await openWizard(page, 'result-simple')
    const main = page.locator('main [data-cms-import-flow]')
    await expect(main.locator('[data-cms-simple-summary]')).toHaveText('6 sản phẩm · mỗi sản phẩm một mức / đơn vị · không target')
    await expect(main.locator('[data-cms-preview-flat]')).toHaveText(['Mức CMS 58.000₫/hộp', 'Mức CMS 42.800₫/hộp'])
    const k = main.locator('[data-cms-kcheck="ok"]')
    await expect(k.locator('[data-cms-k-row]')).toHaveCount(6)
    await expect(k.locator('[data-cms-k-status]')).toHaveCount(6)
    const status = await k.locator('[data-cms-k-row]').evaluateAll((rs) => rs.map((r) => r.getAttribute('data-cms-k-status')))
    expect(status).toEqual(['MATCH', 'PROPOSED', 'MISMATCH', 'NO_EVIDENCE', 'SOURCE_ERROR', 'NO_EVIDENCE'])
    await expect(k.locator('input[type="checkbox"]')).toHaveCount(1)
    await expect(k.locator('[data-cms-k-row="900104"] input[type="checkbox"]')).toHaveCount(1)
    for (const id of ['900101', '900102', '900103', '900105', '900106']) await expect(k.locator(`[data-cms-k-row="${id}"] input`)).toHaveCount(0)
    await expect(k.locator('[data-cms-k-row="900102"] [data-cms-k-proposed]')).toContainText('Đề xuất K = 1')
    const acked = k.locator('[data-cms-k-row="900106"]')
    await expect(acked).toHaveAttribute('data-cms-k-ack', 'yes')
    await expect(acked).toContainText('CHƯA CÓ BẰNG CHỨNG · ĐÃ XÁC NHẬN TAY')
    await expect(acked).not.toContainText('KHỚP')
    await expect(acked.locator('[data-cms-k-ack-info]')).toContainText('Quy cách nhà cung cấp (mẫu)')
    const recheck = k.locator('[data-cms-k-recheck]')
    await expect(recheck).toBeDisabled()
    await k.locator('[data-cms-k-row="900104"] input[type="checkbox"]').check()
    await expect(recheck).toBeDisabled()
    await k.locator('[data-cms-k-row="900104"] input[type="text"]').fill('Quy cách NCC 05/11')
    await expect(recheck).toBeEnabled()
    await expect(recheck).toHaveText('Kiểm tra lại với xác nhận (1)')
    await recheck.click()
    await expect(page.locator('[data-kpi-fixture-blocked]')).toHaveAttribute('data-kpi-fixture-blocked', /[1-9]/)
    await expect(main.locator('[data-cms-commit]')).toHaveText('Nạp danh mục (thay toàn bộ, 2 sản phẩm)')
    expect(writes).toEqual([])
  })

  test('KHÔNG KIỂM ĐƯỢC: thông báo + mọi SP có K được xác nhận tay; 0 SP ghi được ⇒ không nút ghi. Thiếu cột K / tư vấn: báo rõ, có đề xuất K', async ({ page }) => {
    await openWizard(page, 'result-simple-unavailable')
    let main = page.locator('main [data-cms-import-flow]')
    await expect(main.locator('[data-cms-kcheck="unavailable"]')).toContainText('Chưa kiểm được K')
    await expect(main.locator('[data-cms-kcheck] input[type="checkbox"]')).toHaveCount(2)
    await expect(main.locator('[data-cms-commit]')).toHaveCount(0)
    await openWizard(page, 'result-simple-nok')
    main = page.locator('main [data-cms-import-flow]')
    await expect(main.locator('[data-cms-simple-missing]')).toContainText('base_quantity_CMS và Noi_dung_tu_van')
    await expect(main.locator('[data-cms-k-proposed]')).toHaveCount(2)
    await expect(main.locator('[data-cms-commit]')).toHaveCount(0)
  })
})
