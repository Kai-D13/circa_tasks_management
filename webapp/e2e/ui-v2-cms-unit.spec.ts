import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { SUPER_STATE } from './authState'
import { trapWrites } from './fixtureGuard'
import { CMS_FX_PG_UNIT, cmsFxProgram } from '../lib/cms/fixtureScenario'
import { cmsFxStaffResults } from '../lib/cms/fixturesResults'
import { cmsVnd } from '../lib/cms/display'
import { CMS_BASIS_PENDING_TEXT } from '../lib/cms/resultView'
import { CMS_OTHER_UNIT_TEXT } from '../lib/cms/unitBasis'

// CMS-UNIT UNIT-3 (planning/research/cms-unit-basis-spec-implementation-2026-11-09.md §4 / AC10) — fixture /ui-catalog/cms-v2/* với
// chương trình PG13 cơ sở cms_unit (ĐÚNG view của route thật, số do engine tính trên dòng bán giả gồm hộp / viên / vỉ / lọ). Kiểm:
// D1 "Đã bán N hộp đúng ĐV" + câu luật; D2 dòng luật / GMV target mọi đơn vị / dòng gần đây "Khác ĐV tính CMS"; D3 cơ sở của phiên +
// dòng khác ĐV có lý do; A3 cột "SL đúng ĐV" + câu luật + cơ sở chương trình; basis_pending không 0₫ giả; form / import ghi cách tính
// mới; 360 / 390 / 1280 × sáng / tối không cuộn ngang, chạm ≥ 44 trên mobile; 0 request ghi ở mọi màn (vai chỉ đọc).

const HAS_SUPER = fs.existsSync(SUPER_STATE)
const SHOTS = process.env.CMS_SHOTS_DIR
type Theme = 'light' | 'dark'
type Screen = 'staff' | 'product' | 'history' | 'detail' | 'wizard'
const DEVICES = { m360: { width: 360, height: 800 }, m390: { width: 390, height: 844 }, d1280: { width: 1280, height: 900 } } as const
type Dev = keyof typeof DEVICES
const PG13 = cmsFxProgram(CMS_FX_PG_UNIT.PG13)!
const pp = (pid: string) => PG13.products.find((x) => x.productId === pid)!.id
const PG14 = cmsFxProgram(CMS_FX_PG_UNIT.PG14)!
const pp14 = (pid: string) => PG14.products.find((x) => x.productId === pid)!.id
const STAFF = cmsFxStaffResults('running', PG13.row.id)
const sum = (ppId?: string) => {
  if (STAFF.kind !== 'loaded') throw new Error('fx')
  return STAFF.rows.results.filter((r) => !ppId || r.programProductId === ppId).reduce((a, r) => a + BigInt(r.amountVnd), BigInt(0))
}
const fake0 = /(^|[^0-9.])0₫/

async function open(page: Page, screen: Screen, qs: string, theme: Theme = 'light') {
  await page.goto(`/ui-catalog/cms-v2/${screen}?${qs}`)
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
  await page.locator(`main [data-testid="ui-catalog-cms-${screen}"]`).waitFor({ state: 'visible', timeout: 30_000 })
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

test.describe('ui v2 CMS-UNIT — ma trận bố cục, 0 ghi @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })
  const MATRIX: [Screen, string][] = [
    ['staff', 'fx=unit&p2=running'], ['staff', 'fx=unit-manager&p2=running'], ['staff', 'fx=unit&p2=reset'], ['staff', 'fx=unit&p2=held'],
    ['product', `pp=${pp('900201')}&p2=running`], ['product', `pp=${pp('900203')}&p2=running`], ['product', `pp=${pp('900201')}&p2=running&as=manager`],
    ['history', 'fx=unit'], ['staff', 'fx=unit-flat&p2=running'], ['history', 'fx=unit-flat'], ['detail', `program=${PG13.row.id}&p2=running`], ['detail', `program=${PG13.row.id}&p2=reset`],
    ['wizard', 'fx=info&basis=cms_unit'], ['wizard', `fx=upload&program=${PG13.row.id}`], ['wizard', 'fx=result-simple&basis=cms_unit'],
  ]
  for (const [screen, qs] of MATRIX) for (const theme of ['light', 'dark'] as Theme[]) for (const dev of Object.keys(DEVICES) as Dev[]) {
    test(`${screen}?${qs} ${dev} ${theme}`, async ({ page }) => {
      const writes = await trapWrites(page)
      await page.setViewportSize(DEVICES[dev])
      await open(page, screen, qs, theme)
      await noPageOverflow(page, `${screen} ${qs} ${dev} ${theme}`)
      if (dev !== 'd1280') await touchTargets(page, `${screen} ${qs} ${dev}`)
      await shot(page, `unit-${screen}-${qs.replace(/[=&]/g, '_').slice(0, 60)}-${dev}-${theme}`)
      expect(writes).toEqual([])
    })
  }
})

test.describe('ui v2 CMS-UNIT — nội dung theo cơ sở cms_unit @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('D1 staff: "Đã bán N hộp đúng ĐV" (Q, không B / K), không "· tính", câu luật; hero = Σ engine', async ({ page }) => {
    const writes = await trapWrites(page)
    await open(page, 'staff', 'fx=unit&p2=running')
    const main = page.locator('main [data-cms-staff]')
    await expect(main).toHaveAttribute('data-cms-results', 'loaded')
    await expect(main.locator('[data-cms-hero-amount]')).toHaveText(cmsVnd(sum()))
    await expect(main.locator('[data-cms-unit-rule]')).toContainText('Chỉ tính đơn bán đúng ĐV tính CMS')
    await expect(main.locator('[data-cms-staff-product="900201"] [data-cms-sold]')).toHaveText('Đã bán 3 hộp đúng ĐV')
    await expect(main.locator('[data-cms-staff-product="900203"] [data-cms-sold]')).toHaveText('Đã bán 4 hộp đúng ĐV')
    await expect(main.locator('[data-cms-staff-product="900202"] [data-cms-sold]')).toHaveText('Đã bán 3 chai đúng ĐV')
    // Không còn số quy đổi B / K ("4,05 hộp") hay "phần lẻ đơn vị cơ sở".
    const text = await main.innerText()
    expect(text).not.toMatch(/4,05|đơn vị cơ sở|· tính \d/)
    expect(writes).toEqual([])
  })

  test('D1 QLCH: tổng SP theo Q đúng ĐV + số dược sĩ; basis_pending ⇒ câu "cách tính mới", không 0₫ giả', async ({ page }) => {
    await open(page, 'staff', 'fx=unit-manager&p2=running')
    let main = page.locator('main [data-cms-staff]')
    await expect(main.locator('[data-cms-staff-product="900201"] [data-cms-sold]')).toContainText('hộp đúng ĐV · ')
    await open(page, 'staff', 'fx=unit&p2=reset')
    main = page.locator('main [data-cms-staff]')
    await expect(main.locator('[data-cms-no-run="basis_pending"]')).toHaveText(CMS_BASIS_PENDING_TEXT)
    expect(await main.locator('[data-cms-hero]').innerText()).not.toMatch(fake0)
    await expect(main.locator('[data-cms-sold]')).toHaveCount(0)
  })

  test('D2: dòng luật cms_unit, GMV target gồm mọi đơn vị, "nếu bán thêm" theo Q; dòng gần đây khác ĐV có lý do, đúng ĐV "+N hộp"', async ({ page }) => {
    const writes = await trapWrites(page)
    const id = pp('900201')
    await open(page, 'product', `pp=${id}&p2=running`)
    const main = page.locator('main [data-cms-staff-product-detail]')
    await expect(main.locator('[data-cms-product-cms]')).toHaveText(cmsVnd(sum(id)))
    await expect(main.locator('[data-cms-qty-rule="cms_unit"]').first()).toContainText('Chỉ tính đơn bán đúng ĐV tính CMS (hộp)')
    await expect(main.locator('[data-cms-what-if-unit]')).toContainText('bán thêm theo đơn vị khác không tăng')
    await expect(main.locator('[data-cms-line-unit="other"]').first()).toContainText(CMS_OTHER_UNIT_TEXT)
    await expect(main.locator('[data-cms-line-unit="match"]').first()).toContainText(/\d+ hộp/)
    expect(await main.innerText()).not.toMatch(/4,05|1 hộp = 100 đơn vị cơ sở/)
    // SP có target (900203): câu GMV target mọi đơn vị.
    await open(page, 'product', `pp=${pp('900203')}&p2=running`)
    await expect(page.locator('main [data-cms-unit-target]')).toContainText('GMV tính target gồm đơn bán mọi đơn vị')
    expect(writes).toEqual([])
  })

  test('D3: cơ sở của phiên + dòng viên / vỉ / lọ "Khác ĐV tính CMS"; không số quy đổi', async ({ page }) => {
    await open(page, 'history', 'fx=unit')
    const main = page.locator('main [data-cms-history]')
    await expect(main.locator('[data-cms-run-basis="cms_unit"]')).toBeVisible()
    await expect(main.locator('[data-cms-line-unit="other"]')).not.toHaveCount(0)
    for (const t of await main.locator('[data-cms-line-unit="other"]').allInnerTexts()) expect(t).toMatch(/viên|vỉ|lọ/)
    expect(await main.innerText()).toContain('Khác ĐV tính CMS')
    // Run cms_unit liệt kê cả dòng khác ĐV (0₫) ⇒ nhãn "ghi nhận", không "được tính"; pos_base (PG10) giữ nhãn cũ.
    await expect(main.locator('[data-cms-history-lines] h2')).toHaveText('Dòng đơn ghi nhận')
    await expect(main.locator('[data-cms-history-total]')).toContainText('Dòng đơn ghi nhận')
    await expect(main.locator('[data-cms-history-total]')).not.toContainText('Dòng đơn được tính')
    await open(page, 'history', 'fx=simple')
    const legacy = page.locator('main [data-cms-history]')
    await expect(legacy.locator('[data-cms-run-basis="pos_base"]')).toBeVisible()
    await expect(legacy.locator('[data-cms-history-lines] h2')).toHaveText('Dòng đơn được tính')
  })

  test('PG14 mức cố định theo ĐV tính CMS (ảnh hướng dẫn): hộp tính, gói / viên 0₫ có lý do; không phần lẻ', async ({ page }) => {
    const writes = await trapWrites(page)
    await open(page, 'staff', 'fx=unit-flat&p2=running')
    const main = page.locator('main [data-cms-staff]')
    await expect(main).toHaveAttribute('data-cms-results', 'loaded')
    await expect(main.locator('[data-cms-staff-product="900103"] [data-cms-sold]')).toHaveText('Đã bán 3 hộp đúng ĐV')
    await expect(main.locator('[data-cms-staff-product="900101"] [data-cms-sold]')).toHaveText('Đã bán 1 hộp đúng ĐV')
    expect(await main.innerText()).not.toMatch(/phần lẻ|đơn vị cơ sở|· tính \d|4 hộp/i)
    await open(page, 'product', `pp=${pp14('900103')}&p2=running`)
    const d = page.locator('main [data-cms-staff-product-detail]')
    await expect(d).toContainText('3 hộp đúng ĐV × 31.500₫ = 94.500₫')
    await expect(d.locator('[data-cms-line-unit="other"]').first()).toContainText(CMS_OTHER_UNIT_TEXT)
    expect(await d.innerText()).not.toMatch(/phần lẻ|đơn vị cơ sở/i)
    expect(writes).toEqual([])
  })

  test('A3: cơ sở chương trình, cột "SL đúng ĐV", câu luật; basis_pending ở dòng đồng bộ', async ({ page }) => {
    const writes = await trapWrites(page)
    await open(page, 'detail', `program=${PG13.row.id}&p2=running`)
    const main = page.locator('main')
    await expect(main.locator('[data-cms-program-basis="cms_unit"]')).toContainText('(Chỉ tính đơn bán đúng ĐV tính CMS)')
    await expect(main.getByText('SL đúng ĐV', { exact: false }).first()).toBeVisible()
    // Ô số: Q đúng ĐV (Σ 3 + 12 + 0), không B / K "16,25"; cột đã ghi "đúng ĐV" ⇒ ô không lặp hậu tố (không ngắt dòng).
    await expect(main.locator('[data-cms-product="900201"] [data-cms-sold-basis="cms_unit"]')).toHaveText('15 hộp')
    await expect(main.locator('[data-cms-run-basis="cms_unit"]')).toBeVisible()
    // Mở SP 900201: dòng luật (không "Quy đổi:" — K chỉ kiểm chéo) + câu luật dưới bảng dược sĩ + Q đúng ĐV.
    await main.locator('[data-cms-expand="900201"]').first().click()
    const exp = main.locator('[data-cms-product-expansion="900201"]')
    await expect(exp.locator('[data-cms-qty-rule="cms_unit"]')).toContainText('Chỉ tính đơn bán đúng ĐV tính CMS (hộp)')
    await expect(exp.locator('[data-cms-qty-rule="cms_unit"]')).toContainText('Quy cách POS (chỉ kiểm chéo): 1 hộp = 100 đơn vị cơ sở')
    await expect(exp.locator('[data-cms-qty-rule="cms_unit"]')).not.toContainText('Quy đổi:')
    await expect(exp.locator('[data-cms-unit-rule]')).toContainText('đơn bán đơn vị khác không tính CMS (vẫn cộng GMV target)')
    await shot(page, 'unit-detail-expanded-900201-d1280-light')
    await open(page, 'detail', `program=${PG13.row.id}&p2=reset`)
    await expect(page.locator('main [data-cms-no-run="basis_pending"]')).toHaveText(CMS_BASIS_PENDING_TEXT)
    expect(writes).toEqual([])
  })

  test('form / import: cách tính "Theo ĐV tính CMS" ghi rõ; import cms_unit bắt buộc kiểm K kể cả v2 OFF; kết quả kiểm ghi cơ sở', async ({ page }) => {
    const writes = await trapWrites(page)
    await open(page, 'wizard', 'fx=info&basis=cms_unit')
    await expect(page.locator('main [data-cms-form-basis="cms_unit"]')).toContainText('chỉ tính đơn bán đúng ĐV tính CMS')
    await open(page, 'wizard', 'fx=info')
    await expect(page.locator('main [data-cms-form-basis]')).toHaveCount(0)
    await open(page, 'wizard', `fx=upload&program=${PG13.row.id}`)
    const flow = page.locator('main [data-cms-import-flow]')
    await expect(flow.locator('[data-cms-import-basis="cms_unit"]')).toBeVisible()
    await expect(flow).toContainText('K (quy đổi đơn vị) đối chiếu với dữ liệu bán')
    await open(page, 'wizard', 'fx=result-simple&basis=cms_unit')
    await expect(page.locator('main [data-cms-preview-basis="cms_unit"]')).toContainText('K chỉ để kiểm chéo với POS')
    expect(writes).toEqual([])
  })
})
