import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { SUPER_STATE } from './authState'
import { trapWrites } from './fixtureGuard'
import { CMS_FX_PRODUCTS } from '../lib/cms/fixtures'
import { CMS_FX_RUN } from '../lib/cms/fixturesResults'

// CMS P2-c (I3) — màn kết quả qua fixture /ui-catalog/cms-v2/{staff,product,history,list,detail}?p2= (ĐÚNG view của route
// thật, số liệu giả tính bằng hàm bậc engine). Kiểm: số khớp từng đồng, '—' khi chưa có snapshot (không 0₫ giả), trạng thái
// lỗi / giữ số cũ / cấu hình đổi / run đổi, QLCH không "của bạn" / gợi ý / "Nếu bán thêm" (U19), chia bậc + bậc hiện tại +
// "Nếu bán thêm" cùng engine, D3 20 dòng / lần ghim run + "dữ liệu đã thay đổi", A1 loại QA, A3 4 ô + tab dược sĩ + nhóm Chưa
// gán chỉ super + Xuất Excel cùng run; 360 / 1280 × sáng / tối không cuộn ngang, chạm ≥ 44 trên mobile; 0 request ghi.

const HAS_SUPER = fs.existsSync(SUPER_STATE)
const SHOTS = process.env.CMS_SHOTS_DIR
type Theme = 'light' | 'dark'
type Screen = 'staff' | 'product' | 'history' | 'list' | 'detail'
const DEVICES = { m360: { width: 360, height: 800 }, d1280: { width: 1280, height: 900 } } as const
type Dev = keyof typeof DEVICES
const PP = CMS_FX_PRODUCTS.map((p) => p.id)

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
const fake0 = /(^|[^0-9.])0₫/

test.describe('ui v2 CMS P2-c — bố cục fixture kết quả @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })
  const MATRIX: [Screen, string][] = [
    ['staff', 'fx=many&p2=running'], ['staff', 'fx=manager&p2=running'], ['product', 'fx=product&p2=running'], ['product', 'fx=none&p2=top'],
    ['history', 'role=manager'], ['list', 'p2=running'], ['detail', 'fx=running&p2=running'], ['detail', 'fx=running&p2=running&view=staff'],
  ]
  for (const [screen, qs] of MATRIX) for (const theme of ['light', 'dark'] as Theme[]) for (const dev of Object.keys(DEVICES) as Dev[]) {
    test(`${screen}?${qs} ${dev} ${theme}`, async ({ page }) => {
      const writes = await trapWrites(page)
      await page.setViewportSize(DEVICES[dev])
      await open(page, screen, qs, theme)
      await noPageOverflow(page, `${screen} ${qs} ${dev} ${theme}`)
      if (dev === 'm360' && (screen === 'staff' || screen === 'product' || screen === 'history')) await touchTargets(page, `${screen} ${qs}`)
      await shot(page, `p2c-${screen}-${qs.replace(/[=&]/g, '_')}-${dev}-${theme}`)
      expect(writes).toEqual([])
    })
  }
})

test.describe('ui v2 CMS P2-c — D1 / D2 / D3 dược sĩ @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('D1 staff đang chạy: hero 295.000₫, ô SP, gợi ý gần đạt, danh mục chưa đạt, dòng bậc, bộ lọc Có / Chưa có CMS', async ({ page }) => {
    await open(page, 'staff', 'fx=many&p2=running')
    const main = page.locator('main [data-cms-staff]')
    await expect(main).toHaveAttribute('data-cms-results', 'loaded')
    await expect(main.locator('[data-cms-hero-amount]')).toHaveText('295.000₫')
    await expect(main.locator('[data-cms-hero]')).toContainText('2/4')
    await expect(main.locator('[data-cms-hero]')).toContainText('Cập nhật 15/11/2026 08:05 · chưa chốt kỳ')
    await expect(main.locator('[data-cms-near-gate]')).toContainText('Còn 800.000₫ GMV để mở CMS Sản phẩm mẫu 4')
    await expect(main.locator('[data-cms-near-gate]')).toContainText('ước ≈ 105.000₫')
    await expect(main.locator('[data-cms-staff-catalog-target] [data-cms-gate="unmet"]')).toContainText('30.000.000₫ / 50.000.000₫')
    await expect(main.locator('[data-cms-staff-product="900001"] [data-cms-tier-line]')).toHaveText('Bậc 2 · 20.000₫/hộp · Còn 6 hộp lên 25.000₫/hộp')
    await expect(main.locator('[data-cms-staff-product="900004"] [data-cms-tier-line]')).toHaveText('Cần đạt target trước')
    await expect(main.locator('[data-cms-staff-product="900003"] [data-cms-sold]')).toHaveText('Đã bán 12,5 vỉ')
    await expect(main.locator('[data-cms-card-filter] a')).toHaveText(['Tất cả (4)', 'Có CMS (2)', 'Chưa có CMS (2)'])
    // Link trong fixture trỏ route thật ⇒ kiểm href rồi mở fixture với cùng bộ lọc.
    await expect(main.getByRole('link', { name: 'Có CMS (2)', exact: true })).toHaveAttribute('href', '/targets?tab=cms&program=00000000-0000-4000-8000-000000000001&f=met')
    await open(page, 'staff', 'fx=many&p2=running&f=met')
    await expect(page.locator('main [data-cms-card-filter] a[aria-current="page"]')).toHaveText('Có CMS (2)')
    await expect(page.locator('main [data-cms-staff-product]')).toHaveCount(2)
    await expect(page.locator('main [data-cms-staff-product="900001"]')).toBeVisible()
    await expect(page.locator('main [data-cms-staff-product="900003"]')).toBeVisible()
  })

  test('D1 trạng thái: chưa có snapshot ⇒ "—" (không 0₫); lỗi; giữ số cũ; danh mục đổi; run đổi ⇒ tải lại', async ({ page }) => {
    await open(page, 'staff', 'fx=many&p2=none')
    const main = page.locator('main [data-cms-staff]')
    await expect(main.locator('[data-cms-hero-amount]')).toHaveText('—')
    await expect(main.locator('[data-cms-hero]')).toContainText('Chưa có số liệu')
    expect(await main.innerText()).not.toMatch(fake0)
    await expect(main.locator('[data-cms-card-filter]')).toHaveCount(0)
    await open(page, 'staff', 'fx=many&p2=error')
    await expect(page.locator('main [data-cms-staff] [role="alert"]')).toContainText('Chưa tải được số liệu CMS')
    await expect(page.locator('main [data-cms-staff-product]')).toHaveCount(4)
    await open(page, 'staff', 'fx=many&p2=held')
    await expect(page.locator('main [data-cms-staff]')).toContainText('Lần cập nhật gần nhất chưa thành công')
    await expect(page.locator('main [data-cms-hero-amount]')).toHaveText('295.000₫')
    await open(page, 'staff', 'fx=many&p2=config')
    await expect(page.locator('main [data-cms-staff]')).toContainText('Danh mục vừa thay đổi')
    await open(page, 'staff', 'fx=many&p2=gone')
    await expect(page.locator('main [data-cms-staff]')).toContainText('Tải lại để xem số mới')
  })

  test('D1 QLCH (U19): tổng nhà thuốc 1.030.000₫ cộng cá nhân; không "của bạn" / gợi ý / bộ lọc', async ({ page }) => {
    await open(page, 'staff', 'fx=manager&p2=running')
    const main = page.locator('main [data-cms-staff]')
    await expect(main.locator('[data-cms-store-amount]')).toHaveText('1.030.000₫')
    await expect(main.locator('[data-cms-store-staff-sales]')).toHaveText('/ 3 người có bán')
    await expect(main.locator('[data-cms-store-hero]')).toContainText('2/4')
    const text = await main.innerText()
    for (const w of ['của bạn', 'Gợi ý gần đạt', 'Nếu bán thêm']) expect(text).not.toContain(w)
    await expect(main.locator('[data-cms-near-gate], [data-cms-hero], [data-cms-card-filter]')).toHaveCount(0)
    await expect(main.locator('[data-cms-staff-product="900001"]')).toContainText('720.000₫')
  })

  test('D2 staff: CMS 235.000₫ chia bậc khớp, bậc hiện tại, "Nếu bán thêm" cùng engine (+/− aria-live), 3 ghi nhận gần nhất', async ({ page }) => {
    const writes = await trapWrites(page)
    await open(page, 'product', 'fx=product&p2=running')
    const main = page.locator('main [data-cms-staff-product-detail]')
    await expect(main.locator('[data-cms-product-cms]')).toHaveText('235.000₫')
    await expect(main.locator('[data-cms-qty-line]')).toHaveText('Đã bán 14 hộp · tính CMS 14 hộp')
    await expect(main.locator('[data-cms-tier-breakdown] li')).toHaveText(['Bậc 1 · 9 hộp × 15.000₫135.000₫', 'Bậc 2 · 5 hộp × 20.000₫100.000₫'])
    await expect(main.locator('[data-cms-tier-state]')).toHaveCount(3)
    await expect(main.locator('[data-cms-staff-tier="1"]')).toHaveAttribute('data-cms-tier-state', 'done')
    await expect(main.locator('[data-cms-staff-tier="2"]')).toContainText('Bạn đang ở đây · 5/10 hộp')
    await expect(main.locator('[data-cms-staff-tier="3"]')).toContainText('Còn 6 hộp để lên bậc này')
    await expect(main.locator('[data-cms-gate="met"]')).toContainText('Đạt từ 08/11')
    const w = main.locator('[data-cms-what-if]')
    await expect(w.locator('[data-cms-what-if-n]')).toHaveText('6 hộp')
    await expect(w.locator('[data-cms-what-if-after]')).toHaveText('360.000₫')
    await expect(w.locator('[data-cms-what-if-delta]')).toHaveText('+125.000₫')
    await expect(w.locator('output')).toHaveAttribute('aria-live', 'polite')
    await w.getByRole('button', { name: 'Thêm 1 hộp' }).click()
    await expect(w.locator('[data-cms-what-if-after]')).toHaveText('385.000₫')
    await expect(w.locator('[data-cms-what-if-delta]')).toHaveText('+150.000₫')
    await expect(main.locator('[data-cms-recent] li')).toHaveCount(3)
    await expect(main.locator('[data-cms-recent] a', { hasText: 'Xem tất cả' })).toHaveAttribute('href', new RegExp(`product=${PP[0]}`))
    expect(writes).toEqual([])
  })

  test('D2: gate chưa đạt ⇒ "CMS khi đạt target" + còn thiếu; chạm trần ⇒ không "Nếu bán thêm"; QLCH ⇒ theo dược sĩ, không "của bạn"', async ({ page }) => {
    await open(page, 'product', 'fx=gate4&p2=running')
    let main = page.locator('main [data-cms-staff-product-detail]')
    await expect(main.locator('[data-cms-product-amount] h2')).toHaveText('CMS khi đạt target')
    await expect(main.locator('[data-cms-product-cms]')).toHaveText('105.000₫')
    await expect(main.locator('[data-cms-gate="unmet"]')).toContainText('Còn thiếu 800.000₫')
    await expect(main.locator('[data-cms-what-if]')).toContainText('CMS ước tính khi đạt target')
    await open(page, 'product', 'fx=none&p2=top')
    main = page.locator('main [data-cms-staff-product-detail]')
    await expect(main.locator('[data-cms-product-cms]')).toHaveText('250.000₫')
    await expect(main).toContainText('Đã đạt trần')
    await expect(main.locator('[data-cms-what-if]')).toHaveCount(0)
    await open(page, 'product', 'fx=product&p2=running&role=manager')
    main = page.locator('main [data-cms-staff-product-detail]')
    await expect(main.locator('[data-cms-store-product]')).toContainText('720.000₫')
    await expect(main.locator('[data-cms-store-staff] li')).toHaveCount(3)
    const text = await main.innerText()
    for (const w of ['của bạn', 'Nếu bán thêm', 'Ghi nhận gần đây']) expect(text).not.toContain(w)
  })

  test('D3: 20 dòng / lần ghim run; "Xem thêm" ⇒ 34 dòng cùng run; lọc SP; run khác ⇒ dữ liệu đã thay đổi; chưa có số ⇒ "—"', async ({ page }) => {
    await open(page, 'history', 'role=manager')
    let main = page.locator('main [data-cms-history]')
    await expect(main).toHaveAttribute('data-cms-history', 'ok')
    await expect(main.locator('[data-cms-history-amount]')).toHaveText('1.030.000₫')
    await expect(main.locator('[data-cms-history-lines] li')).toHaveCount(20)
    // Link fixture trỏ route thật ⇒ kiểm href (ghim run, n=40) rồi mở fixture với cùng query.
    const more = await main.locator('[data-cms-history-more]').getAttribute('href')
    expect(more).toBe(`/targets/cms/history?program=00000000-0000-4000-8000-000000000001&run=${CMS_FX_RUN}&n=40`)
    await open(page, 'history', `role=manager&${more!.split('?')[1]}`)
    await expect(page.locator('main [data-cms-history-lines] li')).toHaveCount(34)
    await expect(page.locator('main [data-cms-history-more]')).toHaveCount(0)
    const seqs = await page.locator('main [data-cms-history-lines] li').evaluateAll((els) => els.map((e) => e.textContent ?? ''))
    expect(new Set(seqs).size).toBe(34)
    await open(page, 'history', `p2=running&product=${PP[0]}`)
    main = page.locator('main [data-cms-history]')
    await expect(main.locator('[data-cms-history-lines] li')).toHaveCount(6)
    await expect(main).toContainText('Đang lọc: ')
    await open(page, 'history', `p2=running&run=00000000-0000-4000-8000-000000000998`)
    await expect(page.locator('main [data-cms-history]')).toHaveAttribute('data-cms-history', 'stale')
    await expect(page.locator('main [data-cms-history]')).toContainText('Dữ liệu đã thay đổi')
    await open(page, 'history', 'p2=none')
    await expect(page.locator('main [data-cms-history-amount]')).toHaveText('—')
    expect(await page.locator('main [data-cms-history]').innerText()).not.toMatch(fake0)
  })
})

test.describe('ui v2 CMS P2-c — A1 / A3 quản trị @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('A1: 3 ô P2 (QA không vào tổng; chờ chốt chưa có số ⇒ "—" + gợi ý), cột kết quả; lỗi ⇒ "—" + ô lỗi; SM theo phạm vi', async ({ page }) => {
    await open(page, 'list', 'p2=running')
    const main = page.locator('main [data-cms-list]')
    await expect(main.locator('[data-cms-stat-running]')).toHaveText('1.875.000₫')
    await expect(main.locator('[data-cms-stat-waiting]')).toHaveText('—')
    await expect(main.locator('[data-cms-stat-pharmacists]')).toHaveText('3')
    await expect(main.locator('[data-cms-stats]')).toContainText('1 chương trình chưa có số liệu')
    await expect(main.locator('[data-cms-table] thead')).toContainText('CMS tạm tính')
    await expect(main.locator('[data-cms-table] tbody tr').first()).toContainText('1.875.000₫')
    await open(page, 'list', 'p2=error')
    await expect(page.locator('main [data-cms-stat-running]')).toHaveText('—')
    await expect(page.locator('main [data-cms-result-cell="error"]').first()).toHaveText('Lỗi tải số liệu')
    await open(page, 'list', 'fx=sm&p2=running')
    await expect(page.locator('main [data-cms-stat-running]')).toHaveText('1.030.000₫')
  })

  test('A3 super: 4 ô (Dược sĩ x/y theo Q-212, lượt 7/10), cập nhật, danh mục, phân bố bậc, bảng con, Xuất Excel cùng run', async ({ page }) => {
    const writes = await trapWrites(page)
    await open(page, 'detail', 'fx=running&p2=running')
    const main = page.locator('main [data-cms-detail]')
    await expect(main.locator('[data-cms-detail-results]')).toContainText('1.875.000₫')
    await expect(main.locator('[data-cms-detail-results]')).toContainText('3/5')
    await expect(main.locator('[data-cms-detail-results]')).toContainText('7/10')
    await expect(main.locator('[data-cms-synced]')).toHaveText('Số liệu cập nhật 15/11/2026 08:05 · tạm tính, chưa chốt kỳ · Xuất Excel: toàn chương trình trong phạm vi của bạn')
    await expect(main.locator('[data-cms-detail-catalog]')).toContainText('1/2 dược sĩ có bán đã đạt')
    await expect(main.locator('[data-cms-product="900001"] [role="img"]')).toHaveAttribute('aria-label', 'B1: 27 · B2: 25 · B3: 15 hộp')
    await expect(main.locator('[data-cms-export]')).toHaveAttribute('href', `/api/export/cms?program=00000000-0000-4000-8000-000000000001&run=${CMS_FX_RUN}`)
    await main.locator('[data-cms-product="900001"] [data-cms-product-staff] summary').click()
    await expect(main.locator('[data-cms-product="900001"] [data-cms-product-staff] tbody tr')).toHaveCount(5)
    expect(writes).toEqual([])
  })

  test('A3 tab Theo dược sĩ: super thấy nhóm Chưa gán + 4 dược sĩ; SM chỉ phạm vi (3), không nhóm Chưa gán; lần đồng bộ lỗi ⇒ mã (super)', async ({ page }) => {
    await open(page, 'detail', 'fx=running&p2=running&view=staff')
    let main = page.locator('main [data-cms-detail]')
    await expect(main.locator('[data-cms-staff-row]')).toHaveCount(4)
    await expect(main.locator('[data-cms-unassigned]')).toContainText('Email không khớp tài khoản nào: 4')
    await expect(main).toContainText('7 dòng đơn chưa map được người bán')
    await open(page, 'detail', 'fx=sm&p2=running&view=staff')
    main = page.locator('main [data-cms-detail]')
    await expect(main.locator('[data-cms-staff-row]')).toHaveCount(3)
    await expect(main.locator('[data-cms-unassigned]')).toHaveCount(0)
    await expect(main.locator('[data-cms-detail-results]')).toContainText('1.030.000₫')
    await open(page, 'detail', 'fx=running&p2=held')
    await expect(page.locator('main [data-cms-detail]')).toContainText('SOURCE_TIMEOUT')
    await open(page, 'detail', 'fx=sm&p2=held')
    await expect(page.locator('main [data-cms-detail]')).not.toContainText('SOURCE_TIMEOUT')
    await open(page, 'detail', 'fx=running&p2=none')
    await expect(page.locator('main [data-cms-detail-results]')).toContainText('—')
    expect(await page.locator('main [data-cms-detail-results]').innerText()).not.toMatch(fake0)
  })
})
