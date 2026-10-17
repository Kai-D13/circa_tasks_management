import fs from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import { SM_STATE, SUPER_STATE } from './authState'

// UI v2 Phase 2 · K-1 — /targets/campaigns (canvas K1). Fixture /ui-catalog/kpi-v2/campaigns render ĐÚNG
// CampaignListView của route thật (giá trị qua campaignOverviewValue) ⇒ kiểm đủ trạng thái không phụ thuộc prod:
// super 5 thẻ lọc + thao tác quản trị, SM 3 thẻ chỉ xem, rỗng / lọc rỗng / lỗi chính / lỗi phụ KHÔNG hiện số 0,
// chưa đồng bộ '—' không vẽ thanh, chiến dịch Đang chạy nổi bằng style mà KHÔNG đổi thứ tự. Route thật: dữ liệu
// thật (chỉ đọc), khung chờ loading.tsx, bố cục 1280 sidebar mở / 1440 / 360 / 390 sáng/tối không tràn.

const HAS_SUPER = fs.existsSync(SUPER_STATE)
const HAS_SM = fs.existsSync(SM_STATE)
const THEMES = ['light', 'dark'] as const
type Theme = (typeof THEMES)[number]
const DEVICES = {
  d1280: { width: 1280, height: 900 },
  d1440: { width: 1440, height: 900 },
  m360: { width: 360, height: 800 },
  m390: { width: 390, height: 844 },
} as const
type Dev = keyof typeof DEVICES
const RGB = {
  light: { series: 'rgb(232, 98, 42)', ok: 'rgb(47, 158, 91)', text3: 'rgb(111, 105, 100)' },
  dark: { series: 'rgb(243, 116, 63)', ok: 'rgb(91, 191, 126)', text3: 'rgb(138, 132, 128)' },
}
const FX = '/ui-catalog/kpi-v2/campaigns'
// % hiển thị của fixture super theo thứ tự dòng (K-1 r1.1, PM P1): tỷ lệ THÔ 1 chữ số; chưa đạt mà làm tròn lên 100
// ⇒ "<100%"; chưa đồng bộ "—". gmv 40,19 · Số khách đúng 100 · CLBH 3/8 · gmv 99,6 · gmv 99,96 · paused/draft chưa
// đồng bộ · ended 92 · ended 112.
const PCT_TEXTS = ['40,2%', '100%', '37,5%', '99,6%', '<100%', '—', '—', '92%', '112%']
const LIST = '/targets/campaigns'
const NAV = 'main nav[aria-label="Lọc chiến dịch theo trạng thái"]'

async function setup(page: Page, dev: Dev, baseURL: string) {
  await page.setViewportSize(DEVICES[dev])
  await page.context().addCookies([{ name: 'sidebar_collapsed', value: '0', url: baseURL }])
}

async function openFx(page: Page, fx: string, theme: Theme = 'light', extra = '') {
  await page.goto(`${FX}?fx=${fx}${extra}`)
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
  await page.locator(`main [data-testid="ui-catalog-kpi-campaigns"][data-fx="${fx}"]`).waitFor({ state: 'visible', timeout: 20_000 })
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

const filterCards = (page: Page) => page.locator(`${NAV} a[data-status-filter]`)
const cardSummary = (page: Page) => filterCards(page).evaluateAll((els) => els.map((e) => ({
  key: e.getAttribute('data-status-filter'),
  text: (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim(),
  current: e.getAttribute('aria-current'),
  href: e.getAttribute('href'),
})))
const rowTones = (page: Page, scope: string) =>
  page.locator(`main ${scope} [data-campaign-progress]`).evaluateAll((els) => els.map((e) => e.getAttribute('data-campaign-progress')))

test.describe('ui v2 KPI K-1 danh sách chiến dịch — fixture @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('super: 5 thẻ lọc có số, Tạo chiến dịch, thứ tự giữ nguyên, Đang chạy nổi, luật màu + chưa đồng bộ', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    await openFx(page, 'super')
    expect(await cardSummary(page)).toEqual([
      { key: 'all', text: 'Tất cả 9', current: 'page', href: '/targets/campaigns' },
      { key: 'active', text: 'Đang chạy 5', current: null, href: '/targets/campaigns?status=active' },
      { key: 'paused', text: 'Tạm dừng 1', current: null, href: '/targets/campaigns?status=paused' },
      { key: 'draft', text: 'Nháp 1', current: null, href: '/targets/campaigns?status=draft' },
      { key: 'ended', text: 'Kết thúc 2', current: null, href: '/targets/campaigns?status=ended' },
    ])
    await expect(page.locator('main').getByRole('link', { name: 'Tạo chiến dịch' })).toHaveAttribute('href', '/targets/campaigns/new')

    const table = page.locator('main [data-campaign-table]')
    await expect(table).toBeVisible()
    await expect(page.locator('main [data-campaign-cards]')).toBeHidden()
    // Thứ tự = thứ tự truy vấn (fixture), KHÔNG đẩy Đang chạy lên đầu
    expect(await table.locator('tr[data-campaign-row]').evaluateAll((els) => els.map((e) => e.getAttribute('data-campaign-row'))))
      .toEqual(['active', 'active', 'active', 'active', 'active', 'paused', 'draft', 'ended', 'ended'])
    // Tone: gmv 40,2% series · Số khách 100% ok · CLBH 3/8 series · gmv 99,6% series · gmv <100% series
    //       · paused/draft chưa đồng bộ · ended 92% ended · ended 112% ok
    expect(await rowTones(page, '[data-campaign-table]')).toEqual(['series', 'ok', 'series', 'series', 'series', 'unsynced', 'unsynced', 'ended', 'ok'])
    const rows = table.locator('tr[data-campaign-row]')
    const c = RGB.light
    const fill = (i: number) => rows.nth(i).locator('[role="progressbar"] > div').first().evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(await fill(0)).toBe(c.series)
    expect(await fill(1)).toBe(c.ok)
    expect(await fill(7)).toBe(c.text3)
    expect(await fill(8)).toBe(c.ok)
    expect(await fill(3)).toBe(c.series)
    expect(await fill(4)).toBe(c.series)
    // r1.1 (PM P1): chữ + ARIA từ tỷ lệ THÔ — không bao giờ "100%" khi chưa đạt
    expect(await table.locator('[data-campaign-progress]').allInnerTexts()).toEqual(PCT_TEXTS)
    const aria = await table.locator('[role="progressbar"]').evaluateAll((els) =>
      els.map((e) => ({ now: Number(e.getAttribute('aria-valuenow')), label: e.getAttribute('aria-label') })))
    expect(aria.map((a) => a.label)).toEqual(PCT_TEXTS.filter((t) => t !== '—').map((t) => `Hoàn thành ${t}`))
    expect(aria[0].now).toBeCloseTo(40.192, 3)
    expect(aria[1].now).toBe(100)
    expect(aria[2].now).toBe(37.5)
    expect(aria[3].now).toBeCloseTo(99.6, 6)
    expect(aria[4].now).toBeCloseTo(99.96, 6)
    expect(aria[3].now, '99,6% không được làm tròn thành 100 trên ARIA').toBeLessThan(100)
    expect(aria[4].now, '99,96% không được làm tròn thành 100 trên ARIA').toBeLessThan(100)
    expect(aria[5].now).toBe(92)
    expect(aria[6].now, '112% kẹp ở max 100 (chữ vẫn 112%)').toBe(100)
    // Đang chạy: nền nổi + thanh 10px; còn lại nền trong suốt + thanh 6px
    const bg = (i: number) => rows.nth(i).evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(await bg(0)).not.toBe('rgba(0, 0, 0, 0)')
    expect(await bg(7)).toBe('rgba(0, 0, 0, 0)')
    const barH = (i: number) => rows.nth(i).locator('[role="progressbar"]').evaluate((el) => Math.round(el.getBoundingClientRect().height))
    expect(await barH(0)).toBe(10)
    expect(await barH(7)).toBe(6)
    // Giá trị: cột đã có tiêu đề ⇒ không lặp nhãn; số đầy đủ, đúng đơn vị từng loại
    await expect(table.locator('th').nth(1)).toHaveText('Đã đạt / Mục tiêu')
    await expect(rows.nth(0).locator('[data-campaign-value]')).toHaveText('3.790.116.504₫ / 9.430.000.000₫')
    await expect(rows.nth(1).locator('[data-campaign-value]')).toHaveText('450 / 450 khách')
    await expect(rows.nth(2).locator('[data-campaign-value]')).toHaveText('Đạt KPI: 3/8 cửa hàng')
    // Chưa đồng bộ: '—', không thanh progressbar, thanh nét đứt, meta "Chưa đồng bộ"
    const uns = rows.nth(5)
    await expect(uns.locator('[role="progressbar"]'), 'chưa đồng bộ không được vẽ thanh').toHaveCount(0)
    await expect(uns.locator('[data-campaign-progress="unsynced"]')).toHaveText('—')
    expect(await uns.locator('[data-campaign-progress] [aria-hidden="true"]').evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('dashed')
    await expect(uns.locator('[data-campaign-value]')).toHaveText('— / 6.200.000.000₫')
    await expect(uns).toContainText('18 cửa hàng · Chưa đồng bộ')
    await expect(rows.nth(0)).toContainText('24 cửa hàng · Đồng bộ ')
    // Tag loại + TEST + nhãn trạng thái
    await expect(rows.nth(0)).toContainText('Doanh số')
    await expect(rows.nth(1)).toContainText('Số khách')
    await expect(rows.nth(2)).toContainText('Chất lượng bán hàng')
    await expect(rows.nth(6)).toContainText('TEST')
    // Thao tác quản trị cũ còn đủ: mỗi dòng có link Xem; Kích hoạt/Tạm dừng, Lưu trữ, Xoá nháp
    await expect(table.getByRole('link', { name: /^Xem / })).toHaveCount(9)
    await expect(rows.nth(0).getByRole('button', { name: 'Tạm dừng' })).toBeVisible()
    await expect(rows.nth(5).getByRole('button', { name: 'Kích hoạt' })).toBeVisible()
    await expect(table.getByRole('button', { name: 'Xoá chiến dịch nháp' })).toHaveCount(1)
    await expect(table.getByRole('button', { name: 'Lưu trữ chiến dịch' }).first()).toBeVisible()
    await expect(page.locator('main [role="alert"]')).toHaveCount(0)
  })

  test('SM: 3 thẻ lọc, không Tạo chiến dịch, không nút quản trị', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    await openFx(page, 'sm')
    expect((await cardSummary(page)).map((x) => x.text)).toEqual(['Tất cả 7', 'Đang chạy 5', 'Kết thúc 2'])
    await expect(page.locator('main').getByRole('link', { name: 'Tạo chiến dịch' })).toHaveCount(0)
    const table = page.locator('main [data-campaign-table]')
    await expect(table.locator('tr[data-campaign-row]')).toHaveCount(7)
    await expect(table.getByRole('button')).toHaveCount(0)
    await expect(table.getByRole('link', { name: /^Xem / })).toHaveCount(7)
    // Cột Thao tác của SM chỉ còn mũi tên (hẹp nhất) — tiêu đề cột không được gãy dòng
    const thLines = await table.locator('th').evaluateAll((els) => els.map((e) => {
      const r = document.createRange(); r.selectNodeContents(e)
      return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size
    }))
    expect(thLines, 'tiêu đề bảng gãy dòng').toEqual([1, 1, 1, 1])
    const body = await page.locator('main [data-campaign-list]').innerText()
    for (const dead of ['Nháp', 'Tạm dừng', 'TEST']) expect(body, `SM thấy ${dead}`).not.toContain(dead)
  })

  test('rỗng / lọc rỗng: đúng câu sẵn có, không bảng, không số 0 giả', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    await openFx(page, 'empty')
    const list = page.locator('main [data-campaign-list]')
    await expect(list).toContainText('Chưa có chiến dịch nào. Bấm “Tạo chiến dịch” để bắt đầu.')
    await expect(page.locator(NAV)).toHaveCount(0)
    await expect(list.locator('[data-campaign-table], [data-campaign-cards]')).toHaveCount(0)

    await openFx(page, 'filter-empty', 'light', '&status=paused')
    await expect(list).toContainText('Không có chiến dịch tạm dừng.')
    const cards = await cardSummary(page)
    expect(cards.find((x) => x.key === 'paused')).toEqual({ key: 'paused', text: 'Tạm dừng 0', current: 'page', href: '/targets/campaigns?status=paused' })
    await expect(list.locator('[data-campaign-table], [data-campaign-cards]')).toHaveCount(0)
  })

  test('lỗi truy vấn chính: CHỈ ErrorState — không thẻ lọc, không danh sách, không câu "chưa có chiến dịch"', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    await openFx(page, 'error')
    const list = page.locator('main [data-campaign-list]')
    await expect(list.getByRole('alert')).toContainText('Lỗi truy vấn dữ liệu campaign: canceling statement due to statement timeout')
    await expect(list.getByRole('alert')).toContainText('Kiểm tra migration 070/071/072 đã apply chưa.')
    await expect(page.locator(NAV)).toHaveCount(0)
    await expect(list.locator('[data-campaign-table], [data-campaign-cards]')).toHaveCount(0)
    await expect(list).not.toContainText('Chưa có chiến dịch')
  })

  test('lỗi truy vấn phụ (target/actual): danh sách còn, mọi giá trị "—", không thanh, không "0 cửa hàng"', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    await openFx(page, 'side-error')
    const list = page.locator('main [data-campaign-list]')
    await expect(list.getByRole('alert')).toContainText('Lỗi truy vấn dữ liệu campaign:')
    const table = list.locator('[data-campaign-table]')
    await expect(table.locator('tr[data-campaign-row]')).toHaveCount(9)
    expect(await table.locator('[data-campaign-value]').allInnerTexts()).toEqual(Array(9).fill('—'))
    expect(await rowTones(page, '[data-campaign-table]')).toEqual(Array(9).fill('unsynced'))
    expect(await table.locator('[data-campaign-progress]').allInnerTexts()).toEqual(Array(9).fill('—'))
    await expect(table.locator('[role="progressbar"]')).toHaveCount(0)
    const text = await table.innerText()
    expect(text).not.toMatch(/cửa hàng|Đồng bộ|Chưa đồng bộ|0₫|\d+%/)
  })

  for (const theme of THEMES) {
    for (const dev of ['d1280', 'd1440', 'm360', 'm390'] as Dev[]) {
      test(`bố cục ${dev} ${theme}: không tràn, tên dài xuống dòng trong khung, chạm ≥44px ở mobile`, async ({ page }, info) => {
        await setup(page, dev, info.project.use.baseURL!)
        await openFx(page, 'super', theme)
        const mobile = dev.startsWith('m')
        await noPageOverflow(page, `${dev} ${theme}`)
        const scope = mobile ? 'main [data-campaign-cards]' : 'main [data-campaign-table]'
        await expect(page.locator(scope)).toBeVisible()
        await expect(page.locator(mobile ? 'main [data-campaign-table]' : 'main [data-campaign-cards]')).toBeHidden()
        // Tên dài nằm gọn trong ô/thẻ của nó
        const g = await page.locator(`${scope} a[href="/targets/campaigns/fx-c1"]`).first().evaluate((a) => {
          const box = (a.closest('td') ?? a.closest('li'))!.getBoundingClientRect()
          const r = a.getBoundingClientRect()
          return { right: r.right, boxRight: box.right, lines: Math.round(r.height / parseFloat(getComputedStyle(a).lineHeight)) }
        })
        expect(g.right, 'tên chiến dịch tràn khỏi ô').toBeLessThanOrEqual(g.boxRight + 1)
        expect(g.lines, 'tên dài phải xuống dòng, không cắt').toBeGreaterThanOrEqual(2)
        // Chữ % như nhau ở bảng desktop và thẻ mobile (một nguồn)
        expect(await page.locator(`${scope} [data-campaign-progress]`).allInnerTexts()).toEqual(PCT_TEXTS)
        // Tone theo token của theme
        const fillColor = await page.locator(`${scope} [data-campaign-progress="ok"] [role="progressbar"] > div`).first().evaluate((el) => getComputedStyle(el).backgroundColor)
        expect(fillColor).toBe(RGB[theme].ok)
        if (mobile) {
          const sizes = await page.locator(`${scope} li`).first().locator('a[aria-label^="Xem "], button').evaluateAll((els) =>
            els.map((e) => { const r = e.getBoundingClientRect(); return Math.round(Math.min(r.width, r.height)) }))
          expect(sizes.length).toBeGreaterThanOrEqual(2)
          for (const s of sizes) expect(s, 'vùng chạm < 44px').toBeGreaterThanOrEqual(44)
          const cardH = await filterCards(page).first().evaluate((e) => e.getBoundingClientRect().height)
          expect(cardH).toBeGreaterThanOrEqual(44)
        }
        if (dev === 'd1440' || dev === 'm390') {
          // Mobile: <main> tự cuộn + header/bottom nav cố định ⇒ chụp phần tử cao hơn khung nhìn bị đen/đè. Mở khoá
          // cuộn lồng và ẩn khung app (như capture-p15) SAU khi đã đo bố cục ở trên.
          if (mobile) await page.evaluate(() => {
            document.querySelectorAll<HTMLElement>('header.bg-primary, aside.bg-sidebar, nav[aria-label="Điều hướng chính"], nextjs-portal')
              .forEach((el) => { el.style.display = 'none' })
            const main = document.querySelector<HTMLElement>('main')
            const outer = main?.parentElement
            if (outer) { outer.style.height = 'auto'; outer.style.overflow = 'visible' }
            if (main) main.style.overflow = 'visible'
          })
          // Desktop: giữ sidebar, chỉ kéo cao khung nhìn để cả bảng (9 dòng) nằm trong vùng render của <main>
          else await page.setViewportSize({ width: DEVICES[dev].width, height: 1400 })
          expect(await page.getByTestId('ui-catalog-kpi-campaigns').screenshot({ animations: 'disabled' }))
            .toMatchSnapshot(`campaigns-super-${theme}-${dev}.png`, { maxDiffPixelRatio: 0.01 })
        }
      })
    }
  }

  test('khung chờ loading.tsx: v2, không tràn ở 1440 và 360', async ({ page }, info) => {
    for (const dev of ['d1440', 'm360'] as Dev[]) {
      await setup(page, dev, info.project.use.baseURL!)
      await openFx(page, 'loading')
      const l = page.locator('main [data-route-loading="campaigns"]')
      await expect(l).toBeVisible()
      await expect(l).toHaveAttribute('data-ui-v2', 'page')
      await noPageOverflow(page, `loading ${dev}`)
    }
  })
})

test.describe('ui v2 KPI K-1 /targets/campaigns route thật — super @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('dữ liệu thật: gốc v2, 5 thẻ lọc cộng khớp Tất cả, số dòng = Tất cả, không NaN; không tràn 1280 sáng/tối', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    for (const theme of THEMES) {
      await page.goto(LIST)
      await page.evaluate((t) => localStorage.setItem('theme', t), theme)
      await page.reload()
      const list = page.locator('main [data-campaign-list]')
      await expect(list).toBeVisible({ timeout: 20_000 })
      await expect(list).toHaveAttribute('data-ui-v2', 'page')
      await expect(list.getByRole('alert'), 'truy vấn danh sách lỗi trên prod').toHaveCount(0)
      const cards = await cardSummary(page)
      expect(cards.map((x) => x.key)).toEqual(['all', 'active', 'paused', 'draft', 'ended'])
      const n = cards.map((x) => Number(x.text.match(/(\d+)$/)?.[1]))
      expect(n.every(Number.isFinite), `số đếm không hợp lệ: ${JSON.stringify(cards)}`).toBe(true)
      expect(n[0], 'Tất cả ≠ tổng 4 trạng thái').toBe(n[1] + n[2] + n[3] + n[4])
      expect(n[0], 'super phải có ít nhất 1 chiến dịch trên prod').toBeGreaterThan(0)
      await expect(page.locator('main [data-campaign-table] tr[data-campaign-row]')).toHaveCount(n[0])
      const tones = await rowTones(page, '[data-campaign-table]')
      expect(tones.length).toBe(n[0])
      for (const t of tones) expect(['series', 'ok', 'ended', 'unsynced']).toContain(t)
      await expect(list).not.toContainText('NaN')
      await expect(list).not.toContainText('undefined')
      await noPageOverflow(page, `route 1280 ${theme}`)
      // Lọc qua URL vẫn chạy như cũ
      if (theme === 'light') {
        await page.goto(`${LIST}?status=ended`)
        await expect(page.locator(`${NAV} a[aria-current="page"]`)).toHaveAttribute('data-status-filter', 'ended', { timeout: 15_000 })
        expect(await page.locator('main [data-campaign-table] tr[data-campaign-row]').evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('data-campaign-row')))]))
          .toEqual(n[4] > 0 ? ['ended'] : [])
      }
    }
  })

  // Hai lối vào có RANH GIỚI CHỜ KHÁC NHAU: từ ngoài /targets (sidebar) ⇒ targets/loading.tsx (chọn khung theo
  // đường dẫn); trong cây /targets/campaigns (link quay lại của trang tạo) ⇒ campaigns/loading.tsx. Cả hai phải ra
  // cùng khung v2 — không còn skeleton max-w-xl cũ rồi nhảy sang bố cục fluid.
  for (const entry of [
    { from: '/tasks', link: `aside a[href="${LIST}"]`, name: 'link sidebar từ /tasks' },
    { from: '/targets/campaigns/new', link: `main a[href="${LIST}"]`, name: 'link quay lại từ /targets/campaigns/new' },
  ]) {
    test(`loading: ${entry.name} → /targets/campaigns hiện khung chờ v2`, async ({ page }) => {
      const prefetched = new Map<string, number>()
      let hold = false
      await page.route((u) => u.pathname === LIST, async (route) => {
        const h = route.request().headers()
        if (h['rsc'] === '1' && h['next-router-prefetch']) {
          let res: Awaited<ReturnType<typeof route.fetch>>
          try { res = await route.fetch() } catch { await route.abort('failed'); return }
          await route.fulfill({ response: res })
          prefetched.set(LIST, (prefetched.get(LIST) ?? 0) + 1)
          return
        }
        if (hold && h['rsc'] === '1') await new Promise((r) => setTimeout(r, 2500))
        await route.continue()
      })
      await page.goto(entry.from)
      await page.locator('main h1').first().waitFor()
      // Link sidebar prefetch={false}, link mặc định có lần bị huỷ ⇒ prefetch tay tới khi đủ 2 phản hồi hoàn tất
      // (cây segment + dữ liệu) — như ui-v2-route-states.
      for (let round = 0; round < 10 && (prefetched.get(LIST) ?? 0) < 2; round++) {
        await page.evaluate((h) => {
          const r = (window as unknown as { next?: { router?: { prefetch: (href: string) => unknown } } }).next?.router
          if (!r) throw new Error('window.next.router không có')
          r.prefetch(h)
        }, LIST)
        for (let t = 0; t < 30 && (prefetched.get(LIST) ?? 0) < 2; t++) await page.waitForTimeout(100)
      }
      expect(prefetched.get(LIST) ?? 0, `prefetch ${LIST} chưa xong`).toBeGreaterThanOrEqual(2)
      hold = true
      await page.locator(entry.link).first().click()
      const l = page.locator('[data-route-loading="campaigns"]')
      await expect(l, 'loading campaigns không hiện').toBeVisible({ timeout: 2_000 })
      await expect(l).toHaveAttribute('data-ui-v2', 'page')
      await expect(page.locator('main .max-w-xl'), 'skeleton cũ max-w-xl còn hiện').toHaveCount(0)
      await expect(page.locator('main [data-campaign-list]')).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('[data-route-loading]')).toHaveCount(0)
    })
  }
})

test.describe('ui v2 KPI K-1 /targets/campaigns route thật — SM @desktop', () => {
  test.skip(!HAS_SM, 'chưa có phiên SM')
  test.use({ storageState: SM_STATE })

  test('SM: gốc v2, không Tạo chiến dịch, không nút; có chiến dịch ⇒ đúng 3 thẻ, rỗng ⇒ đúng câu SM', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    await page.goto(LIST)
    const list = page.locator('main [data-campaign-list]')
    await expect(list).toBeVisible({ timeout: 20_000 })
    await expect(list).toHaveAttribute('data-ui-v2', 'page')
    await expect(list.getByRole('alert'), 'truy vấn danh sách lỗi').toHaveCount(0)
    await expect(list.getByRole('link', { name: 'Tạo chiến dịch' })).toHaveCount(0)
    await expect(list.getByRole('button')).toHaveCount(0)
    // Hai nhánh đều KHẲNG ĐỊNH chặt (không nhánh nào bỏ qua): rỗng là trạng thái hợp lệ của dữ liệu SM.
    const empty = list.getByText('Chưa có chiến dịch nào áp dụng cho các cửa hàng bạn quản lý.')
    await expect(page.locator(NAV).or(empty)).toBeVisible({ timeout: 15_000 })
    if (await empty.isVisible()) {
      await expect(page.locator(NAV)).toHaveCount(0)
      await expect(list.locator('[data-campaign-table], [data-campaign-cards]')).toHaveCount(0)
    } else {
      expect((await cardSummary(page)).map((x) => x.key)).toEqual(['all', 'active', 'ended'])
      const rows = await page.locator('main [data-campaign-table] tr[data-campaign-row]').evaluateAll((els) => els.map((e) => e.getAttribute('data-campaign-row')))
      expect(rows.length).toBeGreaterThan(0)
      for (const s of rows) expect(['active', 'ended']).toContain(s)
    }
    await noPageOverflow(page, 'SM route 1280')
  })
})
