import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { SM_STATE, SUPER_STATE } from './authState'
import { blockedCounter, expectBlocked, expectBoundaryOnlyInCatalog, expectCatalogWrapped, expectGuardedCalls, trapWrites } from './fixtureGuard'

// UI v2 Phase 2 · K-4 — /targets/campaigns/affiliate (canvas K5). Fixture /ui-catalog/kpi-v2/affiliate render ĐÚNG
// AffiliateOverviewView của route thật (dữ liệu giả, không RPC) + AffiliateOrdersPanel cho drill-down ⇒ kiểm đủ vai
// (super OS+FS / phòng ban / SM / QLCH), nguồn chưa sẵn sàng & lỗi aggregate KHÔNG hiện 0, lỗi mapping, rỗng, khoảng
// ngày bị thu hẹp, drill-down khớp/lệch/tải thêm. Fixture bọc KpiFixtureBoundary: chevron không gọi action (PM 17/10 P1)
// + quét nguồn mọi component KPI/Affiliate có server action. Route thật: super + SM chỉ đọc; khung chờ 2 lối vào (tab
// Affiliate ở danh sách; sidebar admin phòng ban từ ngoài /targets — mô phỏng bằng router.push từ /tasks).

const HAS_SUPER = fs.existsSync(SUPER_STATE)
const HAS_SM = fs.existsSync(SM_STATE)
const THEMES = ['light', 'dark'] as const
type Theme = (typeof THEMES)[number]
const DEVICES = {
  d1280: { width: 1280, height: 900 }, d1440: { width: 1440, height: 900 },
  m360: { width: 360, height: 800 }, m390: { width: 390, height: 844 },
} as const
type Dev = keyof typeof DEVICES
const FX = '/ui-catalog/kpi-v2/affiliate'
const ROUTE = '/targets/campaigns/affiliate'
const SUBTITLE = 'Nguồn: Circa Online · Chỉ tính đơn DELIVERED.'

async function setup(page: Page, dev: Dev, baseURL: string) {
  await page.setViewportSize(DEVICES[dev])
  await page.context().addCookies([{ name: 'sidebar_collapsed', value: '0', url: baseURL }])
}
async function openFx(page: Page, fx: string, theme: Theme = 'light') {
  await page.goto(`${FX}?fx=${fx}`)
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
  await page.locator(`main [data-testid="ui-catalog-kpi-affiliate"][data-fx="${fx}"]`).waitFor({ state: 'visible', timeout: 20_000 })
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
const view = (page: Page) => page.locator('main [data-affiliate-overview]').first()
const kpiValues = (page: Page) => view(page).locator('[data-affiliate-kpis] > *').evaluateAll((els) =>
  els.map((e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim()))
const bodyRows = (page: Page) => view(page).locator('[data-affiliate-table] tbody tr')

test.describe('ui v2 KPI K-4 Doanh số Affiliate — fixture @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('super (OS+FS): phụ đề nguồn, tab, bộ lọc có Loại, 3 ô đúng số, bảng sắp GMV giảm dần, chip FS, chevron chỉ khi có đơn', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    await openFx(page, 'super')
    const v = view(page)
    await expect(v).toHaveAttribute('data-ui-v2', 'page')
    await expect(v.locator('h1')).toHaveText('Doanh số Affiliate — Circa Online')
    await expect(v).toContainText(SUBTITLE)
    await expect(v.getByRole('link', { name: 'Affiliate' })).toHaveAttribute('href', ROUTE)
    const form = v.locator('form[data-affiliate-filter]')
    await expect(form.locator('input[name="from"]')).toHaveValue('2026-10-01')
    await expect(form.locator('input[name="to"]')).toHaveValue('2026-10-15')
    await expect(form.locator('select[name="type"] option')).toHaveCount(3)
    await expect(form.locator('select[name="store"] option')).toHaveCount(6) // Tất cả + 4 store + 1 đối tác FS
    await expect(form.getByRole('button', { name: 'Áp dụng' })).toBeVisible()
    expect(await kpiValues(page)).toEqual([
      'GMV Affiliate (01/10/2026 – 15/10/2026) 26.612.300₫', 'Đơn giao thành công 145', 'Điểm có doanh số 4/5',
    ])
    const rows = bodyRows(page)
    await expect(rows).toHaveCount(5)
    expect(await rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText.split('\n')[0].trim())))
      .toEqual(['CIRCA CENTRAL — Nhà thuốc trung tâm quận 1 (chi nhánh mở rộng) · POS0009', 'CIRCA URBAN · POS0012', 'NHÀ THUỐC ĐỐI TÁC FS AN KHANG · FS0003FS', 'Đối tác FS Minh ChâuFS', 'CIRCA LUMINA · POS0015'])
    await expect(rows.nth(4)).toContainText('—') // store 0 đơn: không "0₫"
    await expect(rows.nth(4)).not.toContainText('0₫')
    expect(await rows.evaluateAll((els) => els.map((e) => e.querySelectorAll('button[aria-label="Xem danh sách đơn"]').length)))
      .toEqual([1, 1, 1, 1, 0])
    await expect(v.getByRole('alert')).toHaveCount(0)
  })

  test('phòng ban (OS) / SM / QLCH: không tab, Loại ẩn, nhãn "Store có doanh số"; SM/QLCH có "← Doanh số"', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    await openFx(page, 'ops')
    let v = view(page)
    await expect(v.getByRole('link', { name: 'Affiliate' })).toHaveCount(0)
    await expect(v.getByRole('link', { name: '← Doanh số' })).toHaveCount(0)
    await expect(v.locator('select[name="type"]')).toHaveCount(0)
    expect((await kpiValues(page))[2]).toBe('Store có doanh số 2/3')
    for (const fx of ['sm', 'qlch']) {
      await openFx(page, fx)
      v = view(page)
      await expect(v.getByRole('link', { name: '← Doanh số' })).toHaveAttribute('href', '/targets')
      await expect(v.locator('select[name="type"]')).toHaveCount(0)
    }
    await expect(bodyRows(page)).toHaveCount(1)
  })

  test('nguồn chưa sẵn sàng / lỗi aggregate ⇒ mọi số "—", không chevron; lỗi mapping ⇒ chỉ ErrorState; rỗng; thu hẹp ngày', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    await openFx(page, 'not-ready')
    let v = view(page)
    await expect(v.getByRole('alert')).toContainText('Dữ liệu Affiliate chưa được cập nhật. Số liệu đang tạm ẩn.')
    await expect(v.getByRole('alert')).toContainText('Đồng bộ gần nhất:')
    expect((await kpiValues(page)).map((t) => t.split(' ').at(-1))).toEqual(['—', '—', '—'])
    await expect(v.locator('[data-affiliate-table] button[aria-label="Xem danh sách đơn"]')).toHaveCount(0)
    expect(await v.locator('[data-affiliate-table] tbody').innerText()).not.toMatch(/\d₫/)

    await openFx(page, 'agg-error')
    v = view(page)
    await expect(v.getByRole('alert')).toContainText('Không tổng hợp được doanh số Affiliate')
    expect((await kpiValues(page)).map((t) => t.split(' ').at(-1))).toEqual(['—', '—', '—'])

    await openFx(page, 'mapping-error')
    v = view(page)
    await expect(v.getByRole('alert')).toContainText('Không tải được danh sách mapping affiliate — không thể tổng hợp doanh số')
    await expect(v.getByRole('alert')).toContainText('kiểm tra migration 090/095/096 và RLS, rồi tải lại.')
    await expect(v.locator('form[data-affiliate-filter], [data-affiliate-table], [data-affiliate-kpis]')).toHaveCount(0)

    await openFx(page, 'empty')
    v = view(page)
    await expect(v.locator('form[data-affiliate-filter]')).toHaveCount(1)
    await expect(v).toContainText('Không có mapping affiliate nào khớp bộ lọc.')
    await expect(v.locator('[data-affiliate-table], [data-affiliate-kpis]')).toHaveCount(0)

    await openFx(page, 'clamped')
    await expect(view(page)).toContainText('Khoảng ngày vượt giới hạn 366 ngày — đã thu hẹp còn 01/10/2026 – 15/10/2026.')
  })

  test('drill-down: khớp ✓ (xanh) / Tải thêm / LỆCH (đỏ) / rỗng / đang tải / lỗi; trạng thái DELIVERED', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    await openFx(page, 'drill')
    const d = (k: string) => page.locator(`main [data-fx-drill="${k}"]`)
    await expect(d('match')).toContainText('Đã tải 3/3 đơn · Tổng đã tải: 612.400₫ · Khớp số tổng hợp ✓')
    const ok = await d('match').locator('[data-recon="match"]').evaluate((el) => getComputedStyle(el).color)
    const okRef = await page.locator('main').evaluate((el) => { const s = document.createElement('span'); s.className = 'text-status-success'; el.appendChild(s); const c = getComputedStyle(s).color; s.remove(); return c })
    expect(ok, 'khớp phải dùng token status-success (không màu thô)').toBe(okRef)
    await expect(d('match').getByText('DELIVERED', { exact: true }).first()).toBeVisible()
    await expect(d('match').locator('thead th')).toHaveCount(8)
    await expect(d('more').getByRole('button', { name: 'Tải thêm' })).toBeVisible()
    await expect(d('more').locator('[data-recon]')).toHaveCount(0)
    await expect(d('mismatch').locator('[data-recon="mismatch"]')).toContainText('LỆCH số tổng hợp (700.000₫ / 4 đơn) — báo Admin kiểm tra')
    const dangerRef = await page.locator('main').evaluate((el) => { const s = document.createElement('span'); s.className = 'text-status-danger'; el.appendChild(s); const c = getComputedStyle(s).color; s.remove(); return c })
    expect(await d('mismatch').locator('[data-recon="mismatch"]').evaluate((el) => getComputedStyle(el).color), 'LỆCH phải dùng token status-danger').toBe(dangerRef)
    expect(await d('error').getByRole('alert').evaluate((el) => getComputedStyle(el).color), 'lỗi phải dùng token status-danger').toBe(dangerRef)
    await expect(d('empty')).toHaveText('Không có đơn DELIVERED trong khoảng này.')
    await expect(d('loading')).toContainText('Đang tải đơn…')
    await expect(d('error').getByRole('alert')).toHaveText('Không tải được danh sách đơn: permission denied')
  })

  for (const theme of THEMES) {
    for (const dev of ['d1280', 'd1440', 'm360', 'm390'] as Dev[]) {
      test(`bố cục ${dev} ${theme}: không tràn, bảng cuộn trong khung, ô lọc 16px + chạm ≥44px ở mobile`, async ({ page }, info) => {
        await setup(page, dev, info.project.use.baseURL!)
        const mobile = dev.startsWith('m')
        for (const fx of ['super', 'drill']) {
          await openFx(page, fx, theme)
          await noPageOverflow(page, `${fx} ${dev} ${theme}`)
          if (mobile && fx === 'super') {
            const sizes = await view(page).locator('form[data-affiliate-filter] input, form[data-affiliate-filter] select, form[data-affiliate-filter] button, [data-affiliate-table] button').evaluateAll((els) =>
              els.map((e) => { const r = e.getBoundingClientRect(); return { h: Math.round(r.height), w: Math.round(r.width), t: e.getAttribute('name') ?? e.getAttribute('aria-label') ?? e.textContent?.trim() } }))
            for (const s of sizes) expect(Math.min(s.h, s.w), `vùng chạm < 44px: ${s.t}`).toBeGreaterThanOrEqual(44)
            for (const n of ['from', 'store']) expect(await view(page).locator(`[name="${n}"]`).evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px')
          }
          const shot = (fx === 'super' && (dev === 'd1440' || (dev === 'm390' && theme === 'light'))) || (fx === 'drill' && dev === 'd1440' && theme === 'dark')
          if (shot) {
            if (mobile) await page.evaluate(() => {
              document.querySelectorAll<HTMLElement>('header.bg-primary, aside.bg-sidebar, nav[aria-label="Điều hướng chính"], nextjs-portal')
                .forEach((el) => { el.style.display = 'none' })
              const main = document.querySelector<HTMLElement>('main')
              const outer = main?.parentElement
              if (outer) { outer.style.height = 'auto'; outer.style.overflow = 'visible' }
              if (main) main.style.overflow = 'visible'
            })
            else await page.setViewportSize({ width: DEVICES[dev].width, height: 1600 })
            expect(await page.getByTestId('ui-catalog-kpi-affiliate').screenshot({ animations: 'disabled' }))
              .toMatchSnapshot(`affiliate-${fx}-${theme}-${dev}.png`, { maxDiffPixelRatio: 0.01 })
            await page.setViewportSize(DEVICES[dev])
          }
        }
      })
    }
  }
})

test.describe('ui v2 KPI K-4 /targets/campaigns/affiliate route thật — super @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE, serviceWorkers: 'block' })

  // pm-auditor P1.2: route thật vẫn nối action đọc đơn. Nguồn chưa sẵn sàng / lỗi aggregate ⇒ không có chevron (luật
  // đã khoá ở fixture) ⇒ khẳng định chặt nhánh đó rồi dừng, ghi annotation; sẵn sàng ⇒ bấm chevron đầu tiên.
  test('route thật vẫn nối action đọc đơn: không boundary; bấm chevron ⇒ đúng 1 server action POST (abort ở trình duyệt)', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    const seen = await trapWrites(page)
    await page.goto(ROUTE)
    const v = view(page)
    await expect(v).toBeVisible({ timeout: 20_000 })
    await expect(blockedCounter(page), 'route thật không được bọc KpiFixtureBoundary').toHaveCount(0)
    expect(seen, 'mở trang thật không được gửi request ghi').toEqual([])
    const chev = v.locator('[data-affiliate-table] button[aria-label="Xem danh sách đơn"]')
    const alerts = (await v.getByRole('alert').allInnerTexts()).join(' | ')
    if (alerts.includes('Dữ liệu Affiliate chưa được cập nhật. Số liệu đang tạm ẩn.') || alerts.includes('Không tổng hợp được doanh số Affiliate')) {
      await expect(chev).toHaveCount(0)
      test.info().annotations.push({ type: 'nhánh', description: `chevron thật: nguồn lỗi — ${alerts.slice(0, 80)}` })
      return
    }
    await expect(v.getByRole('alert')).toHaveCount(0)
    expect(await chev.count(), 'nguồn sẵn sàng nhưng không dòng nào có đơn').toBeGreaterThan(0)
    await chev.first().click()
    await expect.poll(() => seen.length, { timeout: 10_000 }).toBe(1)
    await page.waitForTimeout(1_000) // cửa sổ bắt request thứ 2 đến muộn
    expect(seen).toEqual([{ method: 'POST', path: ROUTE, action: true }])
    test.info().annotations.push({ type: 'nhánh', description: 'chevron thật: nguồn sẵn sàng — 1 POST action (abort)' })
  })

  test('dữ liệu thật: gốc v2, tab, 3 ô (số hoặc "—" khi nguồn chưa sẵn sàng — không 0 giả), bảng có dòng, không tràn 1280 sáng/tối', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    for (const theme of THEMES) {
      await page.goto(ROUTE)
      await page.evaluate((t) => localStorage.setItem('theme', t), theme)
      await page.reload()
      const v = view(page)
      await expect(v).toBeVisible({ timeout: 20_000 })
      await expect(v).toHaveAttribute('data-ui-v2', 'page')
      await expect(v).toContainText(SUBTITLE)
      await expect(v.locator('[data-affiliate-kpis] > *')).toHaveCount(3)
      const vals = (await kpiValues(page)).map((t) => t.split(' ').at(-1))
      // Ba nhánh đều khẳng định chặt: nguồn chưa sẵn sàng / lỗi aggregate ⇒ đúng alert + cả 3 "—";
      // sẵn sàng ⇒ KHÔNG alert nào và không ô nào "—"/NaN.
      const alerts = (await v.getByRole('alert').allInnerTexts()).join(' | ')
      if (alerts.includes('Dữ liệu Affiliate chưa được cập nhật. Số liệu đang tạm ẩn.') || alerts.includes('Không tổng hợp được doanh số Affiliate')) {
        expect(vals).toEqual(['—', '—', '—'])
        test.info().annotations.push({ type: 'nhánh', description: `super ${theme}: nguồn lỗi — ${alerts.slice(0, 80)}` })
      } else {
        await expect(v.getByRole('alert')).toHaveCount(0)
        for (const x of vals) expect(x).toMatch(/^[\d.]+(₫)?$|^\d+\/\d+$/)
        test.info().annotations.push({ type: 'nhánh', description: `super ${theme}: nguồn sẵn sàng — ${vals.join(' · ')}` })
      }
      expect(await bodyRows(page).count(), 'bảng affiliate super không có dòng').toBeGreaterThan(0)
      await expect(v).not.toContainText('NaN')
      await noPageOverflow(page, `affiliate 1280 ${theme}`)
    }
  })

  // Hai lối vào, hai ranh giới chờ: tab ở danh sách (cùng segment campaigns) ⇒ affiliate/loading.tsx; sidebar admin phòng
  // ban (ngoài /targets) ⇒ targets/loading.tsx chọn khung theo pathname (kind 'affiliate'). Cả hai ⇒ khung Affiliate v2.
  for (const entry of ['tab', 'outside'] as const) {
    test(`loading: ${entry === 'tab' ? 'tab "Affiliate" ở danh sách chiến dịch' : 'lối vào sidebar (router từ /tasks)'} → khung chờ Affiliate`, async ({ page }) => {
      let prefetched = 0
      let hold = false
      await page.route((u) => u.pathname === ROUTE, async (route) => {
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
      if (entry === 'outside') {
        await page.goto('/tasks')
        await page.locator('main h1').first().waitFor()
      } else {
        await page.goto('/targets/campaigns')
        await page.locator('main [data-campaign-list]').waitFor()
      }
      for (let round = 0; round < 10 && prefetched < 2; round++) {
        await page.evaluate((h) => {
          const r = (window as unknown as { next?: { router?: { prefetch: (href: string) => unknown } } }).next?.router
          if (!r) throw new Error('window.next.router không có')
          r.prefetch(h)
        }, ROUTE)
        for (let t = 0; t < 30 && prefetched < 2; t++) await page.waitForTimeout(100)
      }
      expect(prefetched, `prefetch ${ROUTE} chưa xong`).toBeGreaterThanOrEqual(2)
      await page.waitForLoadState('networkidle')
      hold = true
      if (entry === 'tab') await page.locator('main').getByRole('link', { name: 'Affiliate' }).click()
      else await page.evaluate((h) => {
        const r = (window as unknown as { next?: { router?: { push: (href: string) => void } } }).next?.router
        if (!r) throw new Error('window.next.router không có')
        r.push(h)
      }, ROUTE)
      const l = page.locator('[data-route-loading="campaign-affiliate"]')
      await expect(l, 'khung chờ Affiliate không hiện').toBeVisible({ timeout: 2_000 })
      await expect(l).toHaveAttribute('data-ui-v2', 'page')
      await expect(page.locator('[data-route-loading="campaigns"], [data-route-loading="campaign-detail"]'), 'hiện nhầm khung khác').toHaveCount(0)
      await expect(view(page)).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('[data-route-loading]')).toHaveCount(0)
    })
  }
})

test.describe('ui v2 KPI fixture bất khả gọi action — nguồn (K-1..K-4) @desktop', () => {
  test('AffiliateStoreOrdersRow hỏi fixtureBlocked() trước action đọc đơn; fixture bọc boundary, route thật không', () => {
    expect(expectGuardedCalls('components/affiliate/AffiliateStoreOrdersRow.tsx', ['listAffiliatePartnerOrders', 'listAffiliateOrders'])).toBe(2)
    expectCatalogWrapped('app/(dashboard)/ui-catalog/kpi-v2/affiliate/page.tsx')
    expectBoundaryOnlyInCatalog([`app/(dashboard)${ROUTE}/page.tsx`])
  })

  test('quét: MỌI fixture /ui-catalog/kpi-v2/<route> bọc boundary; trang gốc K-0 không dựng component có action', () => {
    const dir = path.join(__dirname, '..', 'app', '(dashboard)', 'ui-catalog', 'kpi-v2')
    const subs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    expect(subs.length, 'không thấy fixture con nào').toBeGreaterThanOrEqual(4)
    for (const s of subs) expectCatalogWrapped(`app/(dashboard)/ui-catalog/kpi-v2/${s}/page.tsx`)
    const rootSrc = fs.readFileSync(path.join(dir, 'page.tsx'), 'utf8')
    for (const c of ['CampaignStatusButton', 'CampaignImport', 'CampaignMetricEditor', 'SyncActualsButton', 'CampaignExportButton', 'CampaignWizard', 'AffiliateStoreOrdersRow', 'CampaignDetailView', 'CampaignListView', 'AffiliateOverviewView', "@/app/actions/"]) {
      expect(rootSrc.includes(c), `kpi-v2/page.tsx (K-0) dựng ${c} mà không bọc boundary`).toBe(false)
    }
  })

  test('quét: MỌI component KPI/Affiliate import server action đều đi qua useFixtureActionBlocked (thêm component mới ⇒ phải thêm guard); components/ds|ui không có action', () => {
    const root = path.join(__dirname, '..')
    const found: string[] = []
    for (const d of ['components/ds', 'components/ui']) {
      for (const file of fs.readdirSync(path.join(root, d))) {
        if (!/\.tsx?$/.test(file)) continue
        expect(fs.readFileSync(path.join(root, d, file), 'utf8').includes("from '@/app/actions/"), `${d}/${file} import server action — phải đưa vào guard fixture`).toBe(false)
      }
    }
    for (const d of ['components/kpi', 'components/affiliate']) {
      for (const file of fs.readdirSync(path.join(root, d))) {
        if (!file.endsWith('.tsx')) continue
        const src = fs.readFileSync(path.join(root, d, file), 'utf8')
        if (src.includes("from '@/app/actions/")) {
          found.push(`${d}/${file}`)
          expect(src, `${d}/${file}: import server action mà không dùng guard fixture`).toContain('useFixtureActionBlocked()')
        }
      }
    }
    expect(found.sort()).toEqual([
      'components/affiliate/AffiliateStoreOrdersRow.tsx',
      'components/kpi/CampaignImport.tsx',
      'components/kpi/CampaignMetricEditor.tsx',
      'components/kpi/CampaignStatusButton.tsx',
      'components/kpi/CampaignWizard.tsx',
      'components/kpi/SyncActualsButton.tsx',
    ])
  })
})

test.describe('ui v2 KPI K-4 fixture bất khả gọi action (PM 17/10 P1) @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE, serviceWorkers: 'block' })

  test('fixture: bấm chevron (chuột + Enter) ⇒ chặn trước action đọc đơn, dòng không mở, 0 request ghi/action', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    const seen = await trapWrites(page)
    await openFx(page, 'super')
    await expectBlocked(page, 0, 'mở trang')
    const chev = view(page).locator('[data-affiliate-table] button[aria-label="Xem danh sách đơn"]')
    expect(await chev.count(), 'fixture super phải có dòng có đơn').toBeGreaterThanOrEqual(2)
    await chev.first().click()
    await expectBlocked(page, 1, 'chevron')
    await expect(chev.first()).toHaveAttribute('aria-expanded', 'false')
    await chev.nth(1).focus()
    await page.keyboard.press('Enter')
    await expectBlocked(page, 2, 'chevron (Enter)')
    await expect(view(page).locator('[data-affiliate-table] button[aria-expanded="true"]')).toHaveCount(0)
    expect(seen, 'fixture Affiliate gửi request ghi/action').toEqual([])
  })
})

test.describe('ui v2 KPI K-4 /targets/campaigns/affiliate route thật — SM @desktop', () => {
  test.skip(!HAS_SM, 'chưa có phiên SM')
  test.use({ storageState: SM_STATE })

  test('SM: "← Doanh số", không tab quản trị, không chọn Loại (chỉ OS); hoặc 404 khi không có store OS (cổng cũ)', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    await page.goto(ROUTE)
    const v = view(page)
    const nf = page.locator('main').getByText('This page could not be found.')
    await expect(v.or(nf)).toBeVisible({ timeout: 20_000 })
    if (await nf.isVisible()) {
      await expect(v).toHaveCount(0)
      test.info().annotations.push({ type: 'nhánh', description: 'SM: 404 (không có store OS active)' })
      return
    }
    test.info().annotations.push({ type: 'nhánh', description: 'SM: có view' })
    await expect(v).toHaveAttribute('data-ui-v2', 'page')
    await expect(v.getByRole('link', { name: '← Doanh số' })).toHaveAttribute('href', '/targets')
    await expect(v.getByRole('link', { name: 'Affiliate' })).toHaveCount(0)
    await expect(v.locator('select[name="type"]')).toHaveCount(0)
    await noPageOverflow(page, 'SM affiliate 1280')
  })
})
