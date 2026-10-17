import fs from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import { SM_STATE, STAFF_STATE, SUPER_STATE } from './authState'

// UI v2 Phase 2 · K-5 — /targets nhánh SM (canvas K6 desktop / M6 mobile). Fixture /ui-catalog/kpi-v2/sm render ĐÚNG
// SmTargetsLandingView / SmTargetsErrorView / SmTargetsOutOfScopeView của route thật (model qua buildCampaignResultModel)
// ⇒ kiểm đủ trạng thái không phụ thuộc prod: n / 1 / 0 chiến dịch, chưa đồng bộ ('—', không 0 giả), kết thúc đạt (xanh)
// / chưa đạt (trung tính), dải GMV Affiliate ok / nguồn chưa sẵn sàng / lỗi / tắt, lỗi store, lỗi dữ liệu, ngoài phạm
// vi, tên dài + 25 cửa hàng. K-5b: chi tiết ?campaign= (SmTargetsDetailView + dashboard v2 của K-2) — GMV / CLBH / chưa
// đồng bộ / đang xem khoảng. Route thật: SM chỉ đọc (landing + chi tiết, không nút quản trị/xuất/đồng bộ), staff không
// mang khung SM.

const HAS_SUPER = fs.existsSync(SUPER_STATE)
const HAS_SM = fs.existsSync(SM_STATE)
const HAS_STAFF = fs.existsSync(STAFF_STATE)
const THEMES = ['light', 'dark'] as const
type Theme = (typeof THEMES)[number]
const DEVICES = {
  d1280: { width: 1280, height: 900 }, d1440: { width: 1440, height: 900 },
  m360: { width: 360, height: 800 }, m390: { width: 390, height: 844 },
} as const
type Dev = keyof typeof DEVICES
const FX = '/ui-catalog/kpi-v2/sm'
const NOTE = 'Chế độ xem Quản lý vùng — chỉ đọc · số liệu giới hạn trong các cửa hàng bạn quản lý.'
const ADMIN_BUTTONS = [/^Tạm dừng$/, /^Kích hoạt$/, /Lưu trữ/, /^Đồng bộ/, /Xoá chiến dịch/]

async function setup(page: Page, dev: Dev, baseURL: string) {
  await page.setViewportSize(DEVICES[dev])
  await page.context().addCookies([{ name: 'sidebar_collapsed', value: '0', url: baseURL }])
}
async function openFx(page: Page, fx: string, theme: Theme = 'light') {
  await page.goto(`${FX}?fx=${fx}`)
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
  await page.locator(`main [data-testid="ui-catalog-kpi-sm"][data-fx="${fx}"]`).waitFor({ state: 'visible', timeout: 20_000 })
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
const root = (page: Page) => page.locator('main [data-sm-targets]')
const rows = (page: Page) => root(page).locator('[data-sm-campaign-list] > li')
const stripValues = (page: Page) => root(page).locator('[data-affiliate-strip] [data-affiliate-stat-value]').allInnerTexts()
// [href, trạng thái, tone thanh, chữ %] của từng dòng theo thứ tự hiển thị.
const rowFacts = (page: Page) => rows(page).evaluateAll((els) => els.map((li) => [
  li.querySelector('a')?.getAttribute('href') ?? null,
  li.getAttribute('data-sm-campaign'),
  li.querySelector('[data-campaign-progress]')?.getAttribute('data-campaign-progress') ?? null,
  (li.querySelector('[data-campaign-progress] > span:last-child')?.textContent ?? '').trim(),
]))

async function expectReadOnly(page: Page) {
  for (const b of ADMIN_BUTTONS) await expect(root(page).getByRole('button', { name: b }), `SM thấy nút ${b}`).toHaveCount(0)
  await expect(root(page).getByRole('link', { name: /Tạo chiến dịch/ })).toHaveCount(0)
}

test.describe('ui v2 KPI K-5 /targets SM — fixture @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('landing n chiến dịch: header + Lịch sử, chip phạm vi, dải GMV 3 ô, danh sách sắp theo hạn, % + màu theo luật K-1, chỉ đọc', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    await openFx(page, 'list')
    const r = root(page)
    await expect(r).toHaveAttribute('data-sm-targets', 'landing')
    await expect(r).toHaveAttribute('data-ui-v2', 'page')
    await expect(r.locator('h1')).toHaveText('Doanh số chiến dịch')
    await expect(r).toContainText('Phạm vi: 6 cửa hàng bạn quản lý')
    const hist = r.getByRole('link', { name: 'Lịch sử chiến dịch' })
    await expect(hist).toHaveCount(1)
    await expect(hist).toHaveAttribute('href', '/targets/campaigns?status=ended')
    const scope = r.locator('[data-sm-scope]')
    await expect(scope.locator('span').first()).toHaveText('Phạm vi quản lý:')
    await expect(scope.locator('span')).toHaveCount(7)
    expect(await stripValues(page)).toEqual(['24.913.200₫', '148', '5/6'])
    await expect(r.getByRole('link', { name: 'Xem chi tiết Affiliate →' })).toHaveAttribute('href', '/targets/campaigns/affiliate')
    // Hạn gần nhất lên đầu (như page.tsx); chưa đồng bộ ⇒ '—' + nét đứt; kết thúc đạt ⇒ ok; kết thúc chưa đạt ⇒ ended.
    expect(await rowFacts(page)).toEqual([
      ['/targets?campaign=fx-sm6', 'ended', 'ok', '105,2%'],
      ['/targets?campaign=fx-sm5', 'ended', 'ended', '84,3%'],
      ['/targets?campaign=fx-sm4', 'active', 'unsynced', '—'],
      ['/targets?campaign=fx-sm1', 'active', 'series', '38,7%'],
      ['/targets?campaign=fx-sm2', 'active', 'series', '70%'], // 315/450 khách (75×0,82 = 61,4999… ⇒ 61)
      ['/targets?campaign=fx-sm3', 'active', 'series', '33,3%'],
    ])
    await expect(rows(page).nth(2).getByRole('progressbar'), 'chưa đồng bộ không được vẽ thanh').toHaveCount(0)
    await expect(rows(page).nth(3).getByRole('progressbar')).toHaveAttribute('aria-label', 'Hoàn thành 38,7%')
    await expect(rows(page).nth(3)).toContainText('Đã đạt / Mục tiêu: 1.183.200.000₫ / 3.060.000.000₫')
    await expect(rows(page).nth(2)).toContainText('Chưa đồng bộ')
    await expect(r.getByText(NOTE)).toBeVisible()
    await expectReadOnly(page)
    await noPageOverflow(page, 'list 1280')
  })

  test('1 / 0 chiến dịch; dải GMV: nguồn chưa sẵn sàng ⇒ 3 "—" + lý do; lỗi ⇒ 3 "—" + alert; cờ tắt ⇒ không dải', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    await openFx(page, 'one')
    await expect(rows(page)).toHaveCount(1)
    await openFx(page, 'empty')
    await expect(root(page).getByText('Chưa có chiến dịch nào áp dụng cho các cửa hàng bạn quản lý.')).toBeVisible()
    await expect(root(page).locator('[data-sm-campaign-list]')).toHaveCount(0)
    expect(await stripValues(page), 'rỗng chiến dịch vẫn hiện dải GMV').toEqual(['24.913.200₫', '148', '5/6'])
    await openFx(page, 'gmv-warning')
    expect(await stripValues(page)).toEqual(['—', '—', '—'])
    await expect(root(page)).toContainText('Nguồn dữ liệu chưa sẵn sàng: đồng bộ Circa Online quá 6 giờ chưa chạy lại — số liệu tạm ẩn')
    await openFx(page, 'gmv-error')
    expect(await stripValues(page)).toEqual(['—', '—', '—'])
    await expect(root(page).getByRole('alert')).toHaveText('Không tải được dữ liệu Affiliate. Vui lòng thử lại sau hoặc báo Admin.')
    await openFx(page, 'gmv-off')
    await expect(root(page).locator('[data-affiliate-strip]')).toHaveCount(0)
    await expect(rows(page)).toHaveCount(6)
  })

  test('lỗi store / lỗi dữ liệu ⇒ chỉ ErrorState; ngoài phạm vi ⇒ link về danh sách + ErrorState', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    for (const [fx, msg] of [['stores-error', 'Không tải được danh sách cửa hàng được phân công'], ['data-error', 'Không tải được dữ liệu chiến dịch']] as const) {
      await openFx(page, fx)
      await expect(root(page)).toHaveAttribute('data-sm-targets', 'error')
      await expect(root(page)).toContainText(msg)
      await expect(root(page).locator('[data-sm-scope], [data-affiliate-strip], [data-sm-campaign-list]')).toHaveCount(0)
      await expect(root(page).getByText('Chưa có chiến dịch nào')).toHaveCount(0)
    }
    await openFx(page, 'out-of-scope')
    await expect(root(page)).toHaveAttribute('data-sm-targets', 'out-of-scope')
    await expect(root(page).getByRole('link', { name: '← Danh sách chiến dịch' })).toHaveAttribute('href', '/targets')
    await expect(root(page)).toContainText('Chiến dịch không thuộc phạm vi quản lý của bạn')
    await expect(root(page).locator('[data-sm-campaign-list], [data-affiliate-strip]')).toHaveCount(0)
  })

  for (const theme of THEMES) {
    for (const dev of ['d1280', 'd1440', 'm360', 'm390'] as Dev[]) {
      test(`bố cục ${dev} ${theme}: không tràn (kể cả tên dài + 25 cửa hàng), chip cuộn trong khung, chạm ≥44px ở mobile`, async ({ page }, info) => {
        await setup(page, dev, info.project.use.baseURL!)
        const mobile = dev.startsWith('m')
        // 'long' trước, 'list' sau ⇒ ảnh chụp ở cuối là fx=list.
        for (const fx of ['long', 'list']) {
          await openFx(page, fx, theme)
          await noPageOverflow(page, `${fx} ${dev} ${theme}`)
          if (fx === 'long') {
            // Tên dài xuống dòng trong ô của nó, không đẩy giá trị/thanh ra ngoài; 25 chip cuộn trong khung.
            const name = rows(page).filter({ hasText: 'Chiến dịch tăng trưởng doanh số' }).locator('p').first()
            expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'tên dài bị tràn').toBe(true)
            await expect(root(page).locator('[data-sm-scope] span')).toHaveCount(26)
          }
          if (mobile) {
            // Mobile: mỗi chiến dịch là thẻ riêng (có viền); vùng chạm của 2 link ≥ 44px.
            expect(await rows(page).first().locator('a').evaluate((el) => getComputedStyle(el).borderTopWidth)).not.toBe('0px')
            for (const name of ['Lịch sử chiến dịch', 'Xem chi tiết Affiliate →']) {
              const h = await root(page).getByRole('link', { name }).evaluate((el) => el.getBoundingClientRect().height)
              expect(h, `${name} cao ${h}px`).toBeGreaterThanOrEqual(44)
            }
          }
        }
        const snap = dev === 'd1440' ? `sm-list-${theme}-d1440.png` : dev === 'm390' && theme === 'light' ? 'sm-list-light-m390.png' : null
        if (snap) {
          // Như K-1: mobile mở khoá cuộn lồng + ẩn khung app; desktop kéo cao khung nhìn để cả danh sách nằm trong <main>.
          if (mobile) await page.evaluate(() => {
            document.querySelectorAll<HTMLElement>('header.bg-primary, aside.bg-sidebar, nav[aria-label="Điều hướng chính"], nextjs-portal')
              .forEach((el) => { el.style.display = 'none' })
            const main = document.querySelector<HTMLElement>('main')
            const outer = main?.parentElement
            if (outer) { outer.style.height = 'auto'; outer.style.overflow = 'visible' }
            if (main) main.style.overflow = 'visible'
          })
          else await page.setViewportSize({ width: DEVICES[dev].width, height: 1200 })
          expect(await page.getByTestId('ui-catalog-kpi-sm').screenshot({ animations: 'disabled' }))
            .toMatchSnapshot(snap, { maxDiffPixelRatio: 0.01 })
        }
      })
    }
  }
})

test.describe('ui v2 KPI K-5b /targets?campaign= chi tiết SM — fixture @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('GMV: back-link, tên + hạn + loại, dòng phạm vi, thanh công cụ (đồng bộ + 1 bộ lọc giữ campaign, không store), dashboard v2, chỉ đọc, không Xuất/Đồng bộ', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    await openFx(page, 'detail')
    const r = root(page)
    await expect(r).toHaveAttribute('data-sm-targets', 'detail')
    await expect(r).toHaveAttribute('data-ui-v2', 'page')
    await expect(r.getByRole('link', { name: '← Danh sách chiến dịch' })).toHaveAttribute('href', '/targets')
    await expect(r.locator('h1')).toHaveText('KPI tháng 10/2026')
    // Badge hạn + tag loại nằm cùng hàng với tiêu đề (ô 'Thời hạn' của dashboard cũng có 'Còn 18 ngày' ⇒ khoanh vùng header).
    const head = r.locator('h1').locator('xpath=..')
    await expect(head).toContainText('Còn 18 ngày')
    await expect(head).toContainText('Doanh số')
    await expect(r).toContainText('01/10/2026 – 31/10/2026 · 6 cửa hàng thuộc phạm vi bạn quản lý')
    await expect(r.locator('[data-result-toolbar]')).toContainText('Doanh số đồng bộ 16:15 15/10/2026')
    const form = r.locator('form:has(input[name="from"])')
    await expect(form).toHaveCount(1)
    await expect(form).toHaveAttribute('action', '/targets')
    await expect(form.locator('input[type="hidden"][name="campaign"]')).toHaveValue('fx-sm1')
    await expect(form.locator('input[type="hidden"][name="store"]')).toHaveCount(0)
    const summary = r.locator('[data-result-summary]')
    await expect(summary).toBeVisible()
    await expect(summary).toContainText('38,7%')
    await expect(r.getByRole('button', { name: 'Xuất Excel' })).toHaveCount(0)
    await expectReadOnly(page)
    await expect(r.getByText(NOTE)).toBeVisible()
    await noPageOverflow(page, 'detail 1280')
  })

  test('chưa đồng bộ ⇒ chip "Chưa đồng bộ doanh số", không progressbar, không 0₫/0% giả; CLBH ⇒ dashboard riêng; đang xem khoảng ⇒ câu "Đang xem"', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    await openFx(page, 'detail-unsynced')
    const r = root(page)
    await expect(r.locator('[data-result-toolbar]')).toContainText('Chưa đồng bộ doanh số')
    await expect(r.locator('[data-result-summary]').getByRole('progressbar')).toHaveCount(0)
    expect(await r.locator('[data-result-summary]').innerText()).not.toMatch(/(^|[^\d.,])0(₫|%)/)
    await openFx(page, 'detail-quality')
    await expect(root(page).locator('h1')).toHaveText('Chất lượng bán hàng tháng 10/2026')
    await expect(root(page).locator('[data-result-summary]')).toBeVisible()
    await expect(root(page)).not.toContainText('NaN')
    await openFx(page, 'detail-range')
    await expect(root(page).getByText(/Đang xem/).first()).toBeVisible()
    await expect(root(page).locator('form:has(input[name="from"])')).toHaveCount(1)
  })

  for (const theme of THEMES) {
    for (const dev of ['d1280', 'd1440', 'm360', 'm390'] as Dev[]) {
      test(`chi tiết bố cục ${dev} ${theme}: không tràn trang (bảng cuộn trong khung), back-link ≥44px ở mobile`, async ({ page }, info) => {
        await setup(page, dev, info.project.use.baseURL!)
        const mobile = dev.startsWith('m')
        await openFx(page, 'detail', theme)
        await noPageOverflow(page, `detail ${dev} ${theme}`)
        if (mobile) {
          const h = await root(page).getByRole('link', { name: '← Danh sách chiến dịch' }).evaluate((el) => el.getBoundingClientRect().height)
          expect(h, `back-link cao ${h}px`).toBeGreaterThanOrEqual(44)
        }
        const snap = dev === 'd1440' && theme === 'light' ? 'sm-detail-light-d1440.png' : dev === 'm390' && theme === 'dark' ? 'sm-detail-dark-m390.png' : null
        if (snap) {
          if (mobile) await page.evaluate(() => {
            document.querySelectorAll<HTMLElement>('header.bg-primary, aside.bg-sidebar, nav[aria-label="Điều hướng chính"], nextjs-portal')
              .forEach((el) => { el.style.display = 'none' })
            const main = document.querySelector<HTMLElement>('main')
            const outer = main?.parentElement
            if (outer) { outer.style.height = 'auto'; outer.style.overflow = 'visible' }
            if (main) main.style.overflow = 'visible'
          })
          else await page.setViewportSize({ width: DEVICES[dev].width, height: 1400 })
          expect(await page.getByTestId('ui-catalog-kpi-sm').screenshot({ animations: 'disabled' }))
            .toMatchSnapshot(snap, { maxDiffPixelRatio: 0.01 })
        }
      })
    }
  }
})

test.describe('ui v2 KPI K-5 /targets route thật — SM @desktop', () => {
  test.skip(!HAS_SM, 'chưa có phiên SM')
  test.use({ storageState: SM_STATE })

  test('SM: gốc v2, landing chỉ đọc; danh sách hoặc rỗng (khẳng định chặt cả hai); không NaN, không tràn 1280 sáng/tối + 390', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    for (const theme of THEMES) {
      await page.goto('/targets')
      await page.evaluate((t) => localStorage.setItem('theme', t), theme)
      await page.reload()
      const r = root(page)
      await expect(r).toBeVisible({ timeout: 20_000 })
      await expect(r).toHaveAttribute('data-sm-targets', 'landing')
      await expect(r).toHaveAttribute('data-ui-v2', 'page')
      await expect(r.getByRole('link', { name: 'Lịch sử chiến dịch' })).toHaveAttribute('href', '/targets/campaigns?status=ended')
      const empty = r.getByText('Chưa có chiến dịch nào áp dụng cho các cửa hàng bạn quản lý.')
      await expect(rows(page).first().or(empty)).toBeVisible({ timeout: 15_000 })
      if (await empty.isVisible()) {
        await expect(r.locator('[data-sm-campaign-list]')).toHaveCount(0)
        test.info().annotations.push({ type: 'nhánh', description: `SM ${theme}: 0 chiến dịch` })
      } else {
        const facts = await rowFacts(page)
        expect(facts.length).toBeGreaterThan(0)
        for (const [href, status, tone, text] of facts) {
          expect(href).toMatch(/^\/targets\?campaign=[0-9a-f-]{36}$/)
          // RLS 075/111: SM chỉ đọc chiến dịch active + ended (không nháp/tạm dừng) — dòng khác là lọt quyền ⇒ đỏ.
          expect(['active', 'ended']).toContain(status)
          expect(['series', 'ok', 'ended', 'unsynced']).toContain(tone)
          expect(text).toMatch(tone === 'unsynced' ? /^—$/ : /^(<100%|\d{1,3}(\.\d{3})*(,\d)?%)$/)
        }
        test.info().annotations.push({ type: 'nhánh', description: `SM ${theme}: ${facts.length} chiến dịch` })
      }
      await expect(r).not.toContainText('NaN')
      await expect(r).not.toContainText('undefined')
      await expect(r.getByText(NOTE)).toBeVisible()
      await expectReadOnly(page)
      await noPageOverflow(page, `SM /targets 1280 ${theme}`)
    }
    await page.setViewportSize(DEVICES.m390)
    await page.reload()
    await expect(root(page)).toBeVisible({ timeout: 20_000 })
    await noPageOverflow(page, 'SM /targets 390')
  })

  test('SM chi tiết thật (chiến dịch đầu danh sách): gốc v2 detail, tên, 1 bộ lọc giữ campaign (không store), dashboard v2, chỉ đọc, không NaN, không tràn 1280 sáng/tối + 390', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    await page.goto('/targets')
    const first = rows(page).first().locator('a')
    const empty = root(page).getByText('Chưa có chiến dịch nào áp dụng cho các cửa hàng bạn quản lý.')
    await expect(first.or(empty)).toBeVisible({ timeout: 20_000 })
    if (await empty.isVisible()) {
      // Rỗng là trạng thái hợp lệ của dữ liệu SM: khẳng định chặt rồi dừng (không có chi tiết để mở).
      await expect(rows(page)).toHaveCount(0)
      test.info().annotations.push({ type: 'nhánh', description: 'SM chi tiết: 0 chiến dịch' })
      return
    }
    const href = await first.getAttribute('href')
    expect(href).toMatch(/^\/targets\?campaign=[0-9a-f-]{36}$/)
    const id = href!.split('=')[1]
    for (const theme of THEMES) {
      await page.goto(href!)
      await page.evaluate((t) => localStorage.setItem('theme', t), theme)
      await page.reload()
      const r = root(page)
      await expect(r).toBeVisible({ timeout: 20_000 })
      await expect(r).toHaveAttribute('data-sm-targets', 'detail')
      await expect(r).toHaveAttribute('data-ui-v2', 'page')
      expect((await r.locator('h1').innerText()).trim().length, 'tên chiến dịch rỗng').toBeGreaterThan(0)
      await expect(r.locator('[data-result-toolbar]')).toBeVisible()
      const form = r.locator('form:has(input[name="from"])')
      await expect(form).toHaveCount(1)
      await expect(form.locator('input[type="hidden"][name="campaign"]')).toHaveValue(id)
      await expect(form.locator('input[type="hidden"][name="store"]')).toHaveCount(0)
      await expect(r.locator('[data-result-summary]')).toBeVisible()
      await expect(r.getByRole('button', { name: 'Xuất Excel' })).toHaveCount(0)
      await expectReadOnly(page)
      await expect(r).not.toContainText('NaN')
      await expect(r).not.toContainText('undefined')
      await expect(r.getByText(NOTE)).toBeVisible()
      await noPageOverflow(page, `SM chi tiết 1280 ${theme}`)
    }
    test.info().annotations.push({ type: 'nhánh', description: `SM chi tiết: ${id}` })
    await page.setViewportSize(DEVICES.m390)
    await page.reload()
    await expect(root(page)).toHaveAttribute('data-sm-targets', 'detail', { timeout: 20_000 })
    await noPageOverflow(page, 'SM chi tiết 390')
  })

  test('SM: ?campaign= ngoài phạm vi ⇒ khung ngoài phạm vi v2, không dữ liệu khác', async ({ page }) => {
    await page.goto('/targets?campaign=00000000-0000-4000-8000-000000000000')
    const r = root(page)
    await expect(r).toBeVisible({ timeout: 20_000 })
    await expect(r).toHaveAttribute('data-sm-targets', 'out-of-scope')
    await expect(r).toContainText('Chiến dịch không thuộc phạm vi quản lý của bạn')
    await expect(r.locator('[data-sm-campaign-list], [data-affiliate-strip]')).toHaveCount(0)
  })
})

test.describe('ui v2 KPI K-5 /targets route thật — staff không mang khung SM @desktop', () => {
  test.skip(!HAS_STAFF, 'chưa có phiên staff')
  test.use({ storageState: STAFF_STATE })

  test('staff /targets: không có [data-sm-targets] (nhánh staff giữ nguyên tới K-6)', async ({ page }) => {
    await page.goto('/targets')
    await expect(page.locator('main h1, main h2').first()).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('main [data-sm-targets]')).toHaveCount(0)
  })
})
