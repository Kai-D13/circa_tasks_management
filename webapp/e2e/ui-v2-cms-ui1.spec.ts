import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { SUPER_STATE } from './authState'
import { trapWrites } from './fixtureGuard'
import { CMS_FX_PG } from '../lib/cms/fixtureScenario'

// CMS-UI-1 (PM 04/11 §4 / §8) — nghiệm thu bố cục A3 "Theo sản phẩm" + A1 / D1 qua fixture /ui-catalog/cms-v2 (ĐÚNG component route
// thật, số engine). Kiểm: hàng mở rộng là hàng RIÊNG chiếm toàn chiều ngang (sai số ≤ 2px, không nằm trong ô CMS); đổi bảng ⇄ card theo
// CHIỀU RỘNG VÙNG NỘI DUNG (container 984px ±1, không theo viewport) và khi sidebar mở / thu; tên / nhà thuốc 1 dòng có cắt nhưng
// chạm / bàn phím đọc đủ; tiền / footer không bị cắt (scrollWidth ≤ clientWidth) ở 8 độ rộng × sáng / tối; chạm ≥ 44; điều hướng
// danh sách → chi tiết → SP / lịch sử → quay lại ở trong catalog; 1 / 4 / 14 SP, > 10 dược sĩ, tư vấn ~4.000 ký tự; trạng thái đã chốt
// không ghi "tạm tính / chưa chốt"; 0 request ghi / export. Ảnh (CMS_SHOTS_DIR) 390 / 1280 / 1920 sáng + tối.

const HAS_SUPER = fs.existsSync(SUPER_STATE)
const SHOTS = process.env.CMS_SHOTS_DIR
type Theme = 'light' | 'dark'
const WIDTHS = [360, 390, 768, 1024, 1280, 1440, 1920, 2560] as const
const PG1 = CMS_FX_PG.PG1
const DETAIL = `program=${PG1}&p2=running`
const BREAK = 984 // = tổng bề rộng tối thiểu 8 cột (200+92+96+116+80+160+116+44) + 7 khe 8px + lề 24px

async function open(page: Page, url: string, theme: Theme = 'light', height = 900) {
  await page.setViewportSize({ width: page.viewportSize()?.width ?? 1280, height })
  await page.goto(url)
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
  await page.locator('main [data-testid^="ui-catalog-cms-"]').waitFor({ state: 'visible', timeout: 30_000 })
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
/** Tiền / số không bị cắt: mọi phần tử số tiền có scrollWidth ≤ clientWidth và không bị cha overflow cắt (không chữa bằng overflow-hidden). */
async function moneyReadable(page: Page, where: string) {
  const bad = await page.evaluate(() => {
    const sel = '[data-cms-product-amount] b, [data-cms-detail-results] p span, [data-cms-staff-line] [role="cell"]:last-child, [data-cms-staff-total] [role="cell"], [data-cms-stats] p span, [data-cms-hero-amount], [data-cms-store-amount]'
    const out: string[] = []
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || !/₫|\d/.test(el.textContent ?? '')) continue
      if (el.scrollWidth > el.clientWidth + 1) out.push(`scroll ${el.textContent}`)
      let p = el.parentElement
      while (p && p.tagName !== 'MAIN') {
        const cs = getComputedStyle(p)
        if (cs.overflowX !== 'visible') { const pr = p.getBoundingClientRect(); if (r.right > pr.right + 1 || r.left < pr.left - 1) out.push(`clip ${el.textContent}`); break }
        p = p.parentElement
      }
    }
    return out
  })
  expect(bad, `${where}: tiền bị cắt`).toEqual([])
}
async function touchTargets(page: Page, where: string) {
  const small = await page.locator('main [data-cms-products] button:visible, main [data-cms-actions] a:visible, main [data-cms-actions] button:visible').evaluateAll((els) => els.map((e) => {
    const r = e.getBoundingClientRect()
    return { t: (e.textContent ?? '').trim().slice(0, 40), h: Math.round(r.height), w: Math.round(r.width) }
  }).filter((x) => x.h > 0 && x.w > 0 && Math.min(x.h, x.w) < 44))
  expect(small, `${where}: chạm < 44px`).toEqual([])
}
async function shot(page: Page, name: string) {
  if (!SHOTS) return
  fs.mkdirSync(SHOTS, { recursive: true })
  // <main> là vùng cuộn của layout ⇒ chụp cả trang bằng cách mở chiều cao main trong ảnh (không đổi bố cục ngang).
  await page.locator('main').evaluate((m) => { m.style.height = 'auto'; m.style.overflow = 'visible' })
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true })
}
const tableMode = (page: Page) => page.locator('main [data-cms-products] [role="row"]').first().evaluate((e) => getComputedStyle(e).display !== 'none')

test.describe('ui v2 CMS-UI-1 — A3 bảng SP / mở rộng toàn hàng @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  for (const width of WIDTHS) for (const theme of ['light', 'dark'] as Theme[]) {
    test(`A3 ${width} ${theme}: không tràn, tiền đọc đủ, hàng đóng gọn, mở rộng toàn hàng, chạm ≥ 44`, async ({ page }) => {
      const writes = await trapWrites(page)
      await page.setViewportSize({ width, height: 900 })
      await open(page, `/ui-catalog/cms-v2/detail?${DETAIL}`, theme)
      await noPageOverflow(page, `A3 ${width} ${theme}`)
      await moneyReadable(page, `A3 ${width} ${theme} đóng`)
      const table = await tableMode(page)
      const cw = await page.locator('main [data-cms-products]').evaluate((e) => e.clientWidth)
      expect(table, `${width}: container ${cw}px`).toBe(cw >= BREAK)
      if (table) {
        const hs = await page.locator('main [data-cms-product]').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)))
        for (const h of hs) expect(h, `${width}: hàng đóng cao ${h}px`).toBeLessThanOrEqual(110)
      }
      await page.locator('main [data-cms-expand="900001"]').click()
      const exp = page.locator('main [data-cms-product-expansion="900001"]')
      await expect(exp).toBeVisible()
      const g = await page.evaluate(() => {
        const t = document.querySelector('[data-cms-products]')!.getBoundingClientRect()
        const e = document.querySelector('[data-cms-product-expansion="900001"]')!.getBoundingClientRect()
        const inAmount = !!document.querySelector('[data-cms-product-amount] [data-cms-product-expansion], [data-cms-product-amount] [data-cms-product-staff]')
        return { tw: t.width, ew: e.width, dl: e.left - t.left, inAmount }
      })
      expect(g.inAmount, 'mở rộng nằm trong ô CMS').toBe(false)
      expect(Math.abs(g.tw - g.ew), `mở rộng ${g.ew} / bảng ${g.tw}`).toBeLessThanOrEqual(2)
      expect(Math.abs(g.dl), 'mở rộng lệch trái').toBeLessThanOrEqual(2)
      await noPageOverflow(page, `A3 ${width} ${theme} mở`)
      await moneyReadable(page, `A3 ${width} ${theme} mở`)
      if (width < 768) await touchTargets(page, `A3 ${width}`) // ≥ md: nút desktop 36px theo DS (như các spec CMS khác)
      if ([390, 1280, 1920].includes(width)) await shot(page, `ui1-a3-open-${width}-${theme}`)
      expect(writes).toEqual([])
    })
  }

  test('ngưỡng container: 984px ⇒ bảng 8 cột, 983px ⇒ card (đo theo vùng nội dung, viewport giữ nguyên)', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 900 })
    await open(page, `/ui-catalog/cms-v2/detail?${DETAIL}`)
    const box = page.locator('main [data-cms-products]')
    const border = await box.evaluate((e) => (e as HTMLElement).offsetWidth - e.clientWidth) // container query đo vùng nội dung (trừ viền)
    for (const [w, want] of [[BREAK, true], [BREAK - 1, false], [BREAK + 1, true]] as const) {
      await box.evaluate((e, px) => { (e as HTMLElement).style.width = `${px}px` }, w + border)
      expect(await box.evaluate((e) => e.clientWidth)).toBe(w)
      await expect.poll(() => tableMode(page), { message: `container ${w}px` }).toBe(want)
      await noPageOverflow(page, `container ${w}`)
      await moneyReadable(page, `container ${w}`)
    }
  })

  test('sidebar mở / thu đổi vùng nội dung ⇒ bố cục theo container (1280: mở vẫn đủ 984px, thu rộng hơn)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await open(page, `/ui-catalog/cms-v2/detail?${DETAIL}`)
    const w1 = await page.locator('main [data-cms-products]').evaluate((e) => e.clientWidth)
    expect(await tableMode(page)).toBe(w1 >= BREAK)
    const toggle = page.getByRole('button', { name: /thanh điều hướng/ })
    await toggle.click()
    await expect.poll(() => page.locator('main [data-cms-products]').evaluate((e) => e.clientWidth)).toBeGreaterThan(w1)
    expect(await tableMode(page)).toBe(true)
    await moneyReadable(page, 'sidebar thu')
    await page.getByRole('button', { name: /thanh điều hướng/ }).click() // trả lại trạng thái
  })

  test('bàn phím + đọc đầy đủ: Enter mở / Space đóng (aria-expanded / aria-controls); tên dài cắt 1 dòng, chạm mở đủ; Xem thêm giữ tổng', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await open(page, `/ui-catalog/cms-v2/detail?${DETAIL}`)
    const btn = page.locator('main [data-cms-expand="900001"]')
    await btn.focus()
    await page.keyboard.press('Enter')
    await expect(btn).toHaveAttribute('aria-expanded', 'true')
    const ctl = await btn.getAttribute('aria-controls')
    await expect(page.locator(`[id="${ctl}"]`)).toHaveAttribute('data-cms-product-expansion', '900001')
    const exp = page.locator('main [data-cms-product-expansion="900001"]')
    const nameBtn = exp.locator('[data-cms-staff-name]', { hasText: 'tên rất dài' })
    const cut = await nameBtn.locator('span').first().evaluate((e) => ({ s: e.scrollWidth, c: e.clientWidth, ws: getComputedStyle(e).whiteSpace }))
    expect(cut.ws).toBe('nowrap')
    expect(cut.s, 'tên dài phải đang bị cắt 1 dòng').toBeGreaterThan(cut.c)
    await nameBtn.click()
    await expect(nameBtn).toHaveAttribute('aria-expanded', 'true')
    expect(await nameBtn.locator('span').first().evaluate((e) => ({ ws: getComputedStyle(e).whiteSpace, fit: e.scrollWidth <= e.clientWidth + 1 }))).toEqual({ ws: 'normal', fit: true })
    const total = await exp.locator('[data-cms-staff-total]').innerText()
    await exp.locator('[data-cms-staff-more]').click()
    await expect(exp.locator('[data-cms-staff-line]')).toHaveCount(11)
    expect(await exp.locator('[data-cms-staff-total]').innerText()).toBe(total)
    await btn.focus()
    await page.keyboard.press(' ')
    await expect(btn).toHaveAttribute('aria-expanded', 'false')
    await expect(exp).toHaveCount(0)
  })

  test('1 / 4 / 14 SP; tư vấn ~4.000 ký tự không đẩy cao hàng đóng; chương trình ĐÃ CHỐT không ghi "tạm tính / chưa chốt kỳ"', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await open(page, `/ui-catalog/cms-v2/detail?program=${CMS_FX_PG.PG7}&p2=running`)
    await expect(page.locator('main [data-cms-product]')).toHaveCount(1)
    await open(page, `/ui-catalog/cms-v2/detail?program=${CMS_FX_PG.PG5}&p2=running`)
    const main = page.locator('main [data-cms-detail]')
    await expect(main.locator('[data-cms-product]')).toHaveCount(14)
    await expect(main.locator('[data-cms-synced]')).toHaveAttribute('data-cms-synced', 'locked')
    await expect(main.locator('[data-cms-synced]')).toContainText('Số đã chốt')
    await expect(main.locator('[data-cms-detail-results]')).toContainText('CMS đã chốt')
    const labels = (await main.locator('[data-cms-detail-results], [data-cms-synced], [data-cms-products] [role="columnheader"]').allInnerTexts()).join(' | ')
    for (const w of ['tạm tính', 'Tạm tính', 'chưa chốt kỳ']) expect(labels).not.toContain(w)
    const hs = await main.locator('[data-cms-product]').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)))
    expect(Math.max(...hs), 'hàng đóng (có SP tư vấn 4.000 ký tự) không cao bất thường').toBeLessThanOrEqual(110)
    await main.locator('[data-cms-expand="900032"]').click()
    await main.locator('[data-cms-product-expansion="900032"] [data-cms-advice-toggle]').click()
    const adv = main.locator('[data-cms-product-expansion="900032"] [data-cms-advice]')
    expect((await adv.innerText()).length).toBeGreaterThan(3500)
    await noPageOverflow(page, 'tư vấn dài')
    await open(page, `/ui-catalog/cms-v2/detail?program=${CMS_FX_PG.PG2}`)
    await expect(page.locator('main [data-cms-product]')).toHaveCount(1)
    await expect(page.locator('main [data-cms-products]')).toHaveAttribute('data-cms-products', 'catalog') // chưa bắt đầu: không cột kết quả, không 0 giả
  })

  test('kịch bản HỎNG (tiền lệch bậc): không vẽ phân bố, ghi "Chưa đủ dữ liệu giải thích", tiền vẫn theo snapshot', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await open(page, '/ui-catalog/cms-v2/detail?fx=running&p2=corrupt')
    const row = page.locator('main [data-cms-product="900001"]')
    await expect(row.locator('[data-cms-dist="unknown"]')).toHaveText('Chưa đủ dữ liệu giải thích')
    await expect(row.locator('[data-cms-product-amount]')).toContainText('3.011.000₫')
  })
})

// UI1-P1-1 (PM 04/11 implementation audit): bảng dược sĩ trong phần mở rộng chỉ được dùng 5 cột khi vùng nội dung THỰC đủ chỗ.
// Kiểm tự nhiên ở viewport trung gian (1120 / 1140 — dải PM tái hiện cắt tiền) với sidebar mở và thu, và ranh giới container của
// CHÍNH bảng dược sĩ (STAFF_BREAK −1 / 0 / +1). Mỗi ô tiền + hàng Tổng phải nằm trong MỌI tổ tiên có overflow ≠ visible (khung bo góc
// không được che lỗi), và khung không có nội dung tràn (scrollWidth ≤ clientWidth).
const STAFF_BREAK = 820 // = cột tối thiểu 170+84+190+150+120 (714) + 4 khe 12px + lề 24px + viền 2px, dư ~32px an toàn
async function staffInsideClips(page: Page, where: string) {
  const bad = await page.evaluate(() => {
    const out: string[] = []
    for (const frame of document.querySelectorAll<HTMLElement>('[data-cms-product-staff]')) {
      if (frame.scrollWidth > frame.clientWidth + 1) out.push(`khung tràn ${frame.scrollWidth}>${frame.clientWidth}`)
      const cells = frame.querySelectorAll<HTMLElement>('[data-cms-staff-line] [role="cell"]:last-child, [data-cms-staff-total] [role="cell"]')
      for (const el of cells) {
        const r = el.getBoundingClientRect()
        if (r.width === 0) continue
        for (let p = el.parentElement; p && p.tagName !== 'MAIN'; p = p.parentElement) {
          if (getComputedStyle(p).overflowX === 'visible') continue
          const pr = p.getBoundingClientRect()
          if (r.right > pr.right + 1 || r.left < pr.left - 1) { out.push(`${(el.textContent ?? '').trim().slice(0, 30)} vượt ${Math.round(r.right - pr.right)}px`); break }
        }
        if (el.scrollWidth > el.clientWidth + 1) out.push(`ô tràn ${(el.textContent ?? '').trim().slice(0, 30)}`)
      }
    }
    return out
  })
  expect(bad, `${where}: tiền / Tổng bảng dược sĩ bị cắt`).toEqual([])
}
const staffTable = (page: Page) => page.locator('main [data-cms-product-expansion="900001"] [data-cms-product-staff] [role="rowgroup"]').first().evaluate((e) => getComputedStyle(e).display !== 'none')

test.describe('ui v2 CMS-UI-1 r2 — bảng dược sĩ không cắt tiền (UI1-P1-1) @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  for (const collapsed of [false, true]) for (const width of [1100, 1120, 1140, 1160, 1180, 1240]) {
    test(`${width}px sidebar ${collapsed ? 'thu' : 'mở'}: 5 cột chỉ khi đủ chỗ; tiền từng người + Tổng không bị cắt`, async ({ page, baseURL }) => {
      await page.context().addCookies([{ name: 'sidebar_collapsed', value: collapsed ? '1' : '0', url: baseURL! }])
      await page.setViewportSize({ width, height: 900 })
      await open(page, `/ui-catalog/cms-v2/detail?${DETAIL}`)
      await page.locator('main [data-cms-expand="900001"]').click()
      const exp = page.locator('main [data-cms-product-expansion="900001"]')
      await expect(exp.locator('[data-cms-staff-line]').first()).toBeVisible()
      const cw = await exp.evaluate((e) => { const cs = getComputedStyle(e.firstElementChild as HTMLElement); return (e.firstElementChild as HTMLElement).clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) })
      await staffInsideClips(page, `${width} ${collapsed ? 'thu' : 'mở'}`)
      expect(await staffTable(page), `${width}: vùng bảng dược sĩ ${cw}px`).toBe(cw >= STAFF_BREAK)
      await exp.locator('[data-cms-staff-more]').click()
      await expect(exp.locator('[data-cms-staff-line]')).toHaveCount(11)
      await staffInsideClips(page, `${width} ${collapsed ? 'thu' : 'mở'} (11/11)`)
      await noPageOverflow(page, `${width}`)
    })
  }

  test(`ranh giới container bảng dược sĩ: ${STAFF_BREAK - 1} ⇒ danh sách, ${STAFF_BREAK} / ${STAFF_BREAK + 1} ⇒ 5 cột; tiền không bị cắt ở cả ba`, async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 900 })
    await open(page, `/ui-catalog/cms-v2/detail?${DETAIL}`)
    await page.locator('main [data-cms-expand="900001"]').click()
    const cell = page.locator('main [data-cms-product-expansion="900001"] > [role="cell"]')
    const pad = await cell.evaluate((e) => { const cs = getComputedStyle(e); return parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) })
    for (const [w, want] of [[STAFF_BREAK - 1, false], [STAFF_BREAK, true], [STAFF_BREAK + 1, true]] as const) {
      await cell.evaluate((e, px) => { (e as HTMLElement).style.width = `${px}px` }, w + pad)
      await page.waitForTimeout(100)
      await staffInsideClips(page, `container ${w}`)
      await expect.poll(() => staffTable(page), { message: `bảng dược sĩ ${w}px` }).toBe(want)
    }
  })
})

test.describe('ui v2 CMS-UI-1 — điều hướng demo trong catalog + A1 / D1 @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('A1 → A3 → quay lại; D1 → D2 → D3 → quay lại: mọi trang ở /ui-catalog, giữ p2; 0 request ghi / export', async ({ page }) => {
    const writes = await trapWrites(page)
    const inCatalog = () => expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/ui-catalog\/cms-v2\//)
    await page.setViewportSize({ width: 1440, height: 900 })
    await open(page, '/ui-catalog/cms-v2/list?p2=running')
    await page.locator('main [data-cms-table] a', { hasText: 'Thực phẩm chức năng quý 3' }).click()
    await inCatalog()
    await expect(page).toHaveURL(new RegExp(`/ui-catalog/cms-v2/detail\\?program=${CMS_FX_PG.PG5}&p2=running`))
    await expect(page.locator('main [data-cms-product]')).toHaveCount(14)
    await page.locator('main a', { hasText: 'CMS sản phẩm' }).first().click()
    await expect(page).toHaveURL(/\/ui-catalog\/cms-v2\/list\?p2=running$/)
    await page.locator('main [data-cms-table] a', { hasText: 'Chương trình CMS Vitamin' }).click()
    await page.locator('main nav a', { hasText: 'Theo dược sĩ' }).click()
    await expect(page).toHaveURL(new RegExp(`detail\\?program=${PG1}&view=staff&p2=running`))
    await expect(page.locator('main [data-cms-staff-row]')).toHaveCount(12)
    // D1 → D2 → D3 → D1
    await open(page, '/ui-catalog/cms-v2/staff?p2=running')
    await page.locator('main [data-cms-staff-product="900001"]').click()
    await inCatalog()
    await expect(page.locator('main [data-cms-staff-product-detail]')).toBeVisible()
    await page.locator('main [data-cms-recent] a', { hasText: 'Xem tất cả' }).click()
    await expect(page).toHaveURL(/\/ui-catalog\/cms-v2\/history\?/)
    await expect(page.locator('main [data-cms-history]')).toHaveAttribute('data-cms-history', 'ok')
    await page.locator('main a', { hasText: 'CMS sản phẩm' }).first().click()
    await expect(page).toHaveURL(new RegExp(`/ui-catalog/cms-v2/staff\\?program=${PG1}&p2=running`))
    // Không còn link route thật trong trang fixture CMS (trừ link tải file đã chặn).
    for (const u of ['/ui-catalog/cms-v2/list?p2=running', `/ui-catalog/cms-v2/detail?${DETAIL}`, '/ui-catalog/cms-v2/staff?p2=running']) {
      await open(page, u)
      const real = await page.locator('main [data-ui-v2="page"] a[href]').evaluateAll((els) => els.map((e) => e.getAttribute('href')!).filter((h) => h.startsWith('/targets')))
      expect(real, u).toEqual([])
    }
    expect(writes).toEqual([])
  })

  for (const theme of ['light', 'dark'] as Theme[]) for (const width of [390, 1280, 1920]) {
    test(`ảnh + đọc đủ A1 / D1 (staff, QLCH) ${width} ${theme}`, async ({ page }) => {
      const writes = await trapWrites(page)
      await page.setViewportSize({ width, height: 900 })
      for (const [name, url] of [['a1', '/ui-catalog/cms-v2/list?p2=running'], ['d1-staff', '/ui-catalog/cms-v2/staff?p2=running'], ['d1-manager', '/ui-catalog/cms-v2/staff?fx=manager&p2=running'], ['a3-closed', `/ui-catalog/cms-v2/detail?${DETAIL}`]] as const) {
        await open(page, url, theme)
        await noPageOverflow(page, `${name} ${width} ${theme}`)
        await moneyReadable(page, `${name} ${width} ${theme}`)
        await shot(page, `ui1-${name}-${width}-${theme}`)
      }
      expect(writes).toEqual([])
    })
  }
})
