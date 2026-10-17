import fs from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import { MANAGER_STATE, SM_STATE, STAFF_STATE, SUPER_STATE } from './authState'
import { blockedCounter, trapWrites } from './fixtureGuard'

// UI v2 Phase 2 · K-6 — /targets staff (M1–M5) + QLCH. Fixture /ui-catalog/kpi-v2/staff render ĐÚNG StaffCampaignView /
// StaffPeriodView / StaffStateView / ManagerTargetsView của route thật (CHÍNH CampaignCardList, CampaignKpiView,
// CampaignDailyChart + CampaignDailyTable, KpiSummaryCard, AffiliateQrCard, ReferralCard) với dữ liệu giả cố định ⇒ kiểm
// đủ trạng thái không phụ thuộc prod: danh sách GMV / Chất lượng (2 điều kiện Số đơn + AOV riêng) / Số khách; chi tiết
// GMV hai nguồn có mốc thưởng (commission CỬA HÀNG) + thưởng thêm; chưa đồng bộ ('—', không 0 giả); bảng số liệu ngày
// mở bằng bàn phím, cùng nguồn với biểu đồ; đường cần/ngày CHỈ GMV; theo kỳ ngày/tuần/tháng; QR/Giới thiệu theo trạng
// thái; QLCH desktop. Ảnh fixture thay ảnh live staff-targets (K-6).

const HAS_SUPER = fs.existsSync(SUPER_STATE)
const HAS_STAFF = fs.existsSync(STAFF_STATE)
const HAS_MANAGER = fs.existsSync(MANAGER_STATE)
const HAS_SM = fs.existsSync(SM_STATE)
const UUID_Q = /^\/targets\?campaign=[0-9a-f-]{36}$/
const THEMES = ['light', 'dark'] as const
type Theme = (typeof THEMES)[number]
const DEVICES = {
  d1280: { width: 1280, height: 900 }, d1440: { width: 1440, height: 900 },
  m360: { width: 360, height: 800 }, m390: { width: 390, height: 844 },
} as const
type Dev = keyof typeof DEVICES
const FX = '/ui-catalog/kpi-v2/staff'

async function setup(page: Page, dev: Dev, baseURL: string) {
  await page.setViewportSize(DEVICES[dev])
  await page.context().addCookies([{ name: 'sidebar_collapsed', value: '0', url: baseURL }])
}
async function openFx(page: Page, fx: string, theme: Theme = 'light') {
  await page.goto(`${FX}?fx=${fx}`)
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
  await page.locator(`main [data-testid="ui-catalog-kpi-staff"][data-fx="${fx}"]`).waitFor({ state: 'visible', timeout: 20_000 })
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
const root = (page: Page) => page.locator('main [data-staff-targets]')
const table = (page: Page) => root(page).locator('details[data-daily-table]')
const rowsOf = (page: Page) => table(page).locator('tbody tr').evaluateAll((trs) => trs.map((tr) => [
  tr.getAttribute('data-daily-row'), ...[...tr.querySelectorAll('td')].slice(1).map((td) => (td.textContent ?? '').trim()),
]))

test.describe('ui v2 KPI K-6 /targets staff — fixture @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE, serviceWorkers: 'block' })

  test('M1 danh sách: gốc v2, 3 thẻ (GMV / Chất lượng 2 thanh riêng / Số khách) đúng số cũ, QR + Giới thiệu bạn bè, 0 request ghi', async ({ page }, info) => {
    await setup(page, 'm390', info.project.use.baseURL!)
    const seen = await trapWrites(page)
    await openFx(page, 'list')
    const r = root(page)
    await expect(r).toHaveAttribute('data-staff-targets', 'campaign-list')
    await expect(r).toHaveAttribute('data-ui-v2', 'page')
    await expect(r.locator('h1')).toHaveText('Doanh số chiến dịch')
    const cards = r.locator('[data-campaign-card-list] > a')
    await expect(cards).toHaveCount(3)
    await expect(cards.nth(0)).toContainText('KPI tháng 10/2026')
    await expect(cards.nth(0)).toContainText('157.921.521₫ / 393.000.000₫')
    await expect(cards.nth(1)).toContainText('81 / 180 đơn')
    await expect(cards.nth(1)).toContainText('141.200₫ / 135.000₫')
    // Chất lượng bán hàng: HAI thanh riêng (Số đơn + AOV), không gộp điểm.
    await expect(cards.nth(1).locator('[data-card-line-progress]')).toHaveCount(2)
    await expect(cards.nth(2)).toContainText('61 / 150 khách')
    await expect(r.getByText('Mã QR Circa Online')).toBeVisible()
    await expect(r.getByText('Giới thiệu bạn bè')).toBeVisible()
    await expect(r.getByText('Có đơn cùng ngày')).toHaveCount(2)
    await noPageOverflow(page, 'list 390')
    expect(seen).toEqual([])
  })

  test('M2 chi tiết GMV: hero Đã đạt / Mục tiêu / Còn thiếu, 2 nguồn, 3 ô, đường cần/ngày (GMV), mốc thưởng CỬA HÀNG, thưởng thêm, thông tin áp dụng', async ({ page }, info) => {
    await setup(page, 'm390', info.project.use.baseURL!)
    await openFx(page, 'detail-gmv')
    const r = root(page)
    await expect(r).toHaveAttribute('data-staff-targets', 'campaign-detail')
    await expect(r.getByRole('link', { name: '← Danh sách chiến dịch' })).toBeVisible()
    const hero = r.locator('[data-kpi-hero]')
    await expect(hero).toContainText('Đã đạt157.921.521₫')
    await expect(hero).toContainText('Mục tiêu doanh thu393.000.000₫')
    await expect(hero).toContainText('Còn thiếu:235.078.479₫')
    await expect(r).toContainText('Phân loại theo chỉ số')
    const tiles = r.locator('[data-kpi-tiles]')
    await expect(tiles).toContainText('17 ngày')
    await expect(tiles).toContainText('13.828.146₫')
    await expect(tiles).toContainText('14.200.000₫')
    await expect(r.locator('[data-required-legend]')).toHaveText(/Trung bình\/ngày cần đạt:\s*13\.828\.146₫/)
    const tiers = r.locator('[data-kpi-tiers]')
    for (const t of ['90%', '100%', '110%']) await expect(tiers).toContainText(t)
    await expect(tiers).toContainText('Commission Store dự kiến')
    await expect(tiers).toContainText('Đây là tổng commission của Store')
    await expect(r.locator('[data-order-bonus]')).toContainText('1.092 / 1.300 đơn')
    await expect(r.locator('[data-kpi-info]')).toContainText('Vị trí của bạn: Dược sĩ')
    await noPageOverflow(page, 'detail-gmv 390')
  })

  test('bảng số liệu ngày: đóng mặc định, Enter mở / Space đóng; 01→15/10 (ngày tương lai không có), 09/10 thiếu điểm "—", 08/10 0₫ thật, hôm nay đậm; cột Offline/Affiliate', async ({ page }, info) => {
    await setup(page, 'm390', info.project.use.baseURL!)
    await openFx(page, 'detail-gmv')
    const d = table(page)
    await expect(d).toHaveCount(1)
    await expect(d).not.toHaveAttribute('open', /.*/)
    const summary = d.locator('summary')
    await expect(summary).toHaveText('Xem số liệu theo ngày')
    expect((await summary.boundingBox())!.height, 'summary ≥ 44px').toBeGreaterThanOrEqual(44)
    await summary.focus()
    await page.keyboard.press('Enter')
    await expect(d).toHaveAttribute('open', '')
    expect(await d.locator('thead th').allInnerTexts()).toEqual(['Ngày', 'Doanh thu', 'Doanh thu thuần tại cửa hàng', 'Doanh thu Affiliate'])
    const rows = await rowsOf(page)
    expect(rows.length).toBe(15)
    expect(rows[0]).toEqual(['2026-10-01', '9.000.000₫', '8.100.000₫', '900.000₫'])
    expect(rows[7]).toEqual(['2026-10-08', '0₫', '0₫', '0₫'])
    expect(rows[8]).toEqual(['2026-10-09', '—', '—', '—'])
    expect(rows[14]).toEqual(['2026-10-15', '14.200.000₫', '13.300.000₫', '900.000₫'])
    await expect(d.locator('tbody tr[aria-current="date"]')).toHaveAttribute('data-daily-row', '2026-10-15')
    await summary.focus()
    await page.keyboard.press('Space')
    await expect(d).not.toHaveAttribute('open', /.*/)
  })

  test('M4 Chất lượng: không hero điểm gộp, 2 chỉ số riêng + câu CẢ HAI; bảng theo chuỗi Số đơn / AOV (đơn null ⇒ "—"); không đường cần/ngày', async ({ page }, info) => {
    await setup(page, 'm390', info.project.use.baseURL!)
    await openFx(page, 'detail-quality')
    const r = root(page)
    await expect(r.locator('[data-kpi-hero]')).toHaveCount(0)
    const q = r.locator('[data-kpi-quality]')
    await expect(q).toContainText('81 / 180 đơn')
    await expect(q).toContainText('141.200₫ / 135.000₫')
    await expect(q).toContainText('Phải đạt CẢ HAI mục tiêu Số đơn và AOV mới đạt KPI và được thưởng.')
    await expect(r, 'M4 không thêm "Đạt KPI → X₫" (PM)').not.toContainText('Đạt KPI →')
    await expect(r.locator('[data-required-legend]')).toHaveCount(0)
    await expect(table(page), 'thiếu bảng số liệu ngày').toHaveCount(1)
    await table(page).locator('summary').click()
    expect(await table(page).locator('thead th').allInnerTexts()).toEqual(['Ngày', 'Số đơn'])
    expect(await rowsOf(page)).toEqual([['2026-10-12', '19 đơn'], ['2026-10-13', '23 đơn'], ['2026-10-14', '18 đơn'], ['2026-10-15', '—']])
    await openFx(page, 'detail-quality-aov')
    await expect(table(page), 'thiếu bảng số liệu ngày').toHaveCount(1)
    await table(page).locator('summary').click()
    expect(await table(page).locator('thead th').allInnerTexts()).toEqual(['Ngày', 'AOV'])
    expect(await rowsOf(page)).toEqual([['2026-10-12', '141.158₫'], ['2026-10-13', '141.000₫'], ['2026-10-14', '141.000₫'], ['2026-10-15', '—']])
  })

  test('bảng ngày kỳ dài (01/06 → hôm nay 15/10 = 137 ngày): ĐỦ mọi ngày tới hôm nay, không cắt ngày gần nhất', async ({ page }, info) => {
    await setup(page, 'm390', info.project.use.baseURL!)
    await openFx(page, 'detail-long')
    await expect(table(page), 'thiếu bảng số liệu ngày').toHaveCount(1)
    await table(page).locator('summary').click()
    const rows = await rowsOf(page)
    expect(rows.length).toBe(137)
    // Chiến dịch 2 nguồn ⇒ cột Offline / Affiliate.
    expect(rows[0]).toEqual(['2026-06-01', '7.000.000₫', '7.000.000₫', '0₫'])
    expect(rows[1]).toEqual(['2026-06-02', '—', '—', '—'])
    expect(rows.at(-1)).toEqual(['2026-10-15', '14.200.000₫', '13.300.000₫', '900.000₫'])
  })

  // Q-134 (PM 17/10): cửa sổ biểu đồ kỳ dài = 92 ngày GẦN NHẤT tới min(hôm nay, hết kỳ); kỳ ≤ 92 ngày đủ cả kỳ như cũ.
  test('biểu đồ ngày: kỳ ≤ 92 ngày đủ cả kỳ; kỳ dài = 92 ngày gần nhất tới hôm nay / hết kỳ (không trước đầu kỳ); kỳ dài mới chạy = 92 ngày đầu; tooltip trùng bảng', async ({ page }, info) => {
    await setup(page, 'm390', info.project.use.baseURL!)
    const chartDays = () => root(page).locator('[data-chart-frame] svg[role="img"] g[data-day]').evaluateAll((gs) => gs.map((g) => g.getAttribute('data-day')))
    const cases: [string, number, string, string][] = [
      ['detail-gmv', 31, '2026-10-01', '2026-10-31'],          // kỳ ngắn đang chạy: đủ kỳ, ngày tương lai để trống
      ['detail-ended-daily', 30, '2026-09-01', '2026-09-30'],  // kỳ ngắn đã kết thúc
      ['detail-long', 92, '2026-07-16', '2026-10-15'],         // kỳ dài đang chạy: kết thúc ở HÔM NAY
      ['detail-long-ended', 92, '2026-06-01', '2026-08-31'],   // kỳ dài đã kết thúc: kết thúc ở HẾT KỲ
      ['detail-long-early', 92, '2026-09-01', '2026-12-01'],   // kỳ dài mới chạy 45 ngày: 92 ngày đầu, có hôm nay
    ]
    for (const [fx, n, first, last] of cases) {
      await openFx(page, fx)
      const days = await chartDays()
      expect(days.length, `${fx}: số ngày trên trục`).toBe(n)
      expect([days[0], days.at(-1)], `${fx}: cửa sổ ngày`).toEqual([first, last])
    }
    // Kỳ dài đang chạy: ngày đầu kỳ (01/06) KHÔNG còn trên biểu đồ, hôm nay có; tooltip hôm nay == hàng bảng hôm nay.
    await openFx(page, 'detail-long')
    expect(await chartDays()).not.toContain('2026-06-01')
    const tip = (await root(page).locator('[data-chart-frame] g[data-day="2026-10-15"] title').textContent())!.trim()
    expect(tip).toBe('15/10: 14.200.000₫ (Offline 13.300.000₫ · Affiliate 900.000₫)')
    await table(page).locator('summary').click()
    expect((await rowsOf(page)).at(-1)).toEqual(['2026-10-15', '14.200.000₫', '13.300.000₫', '900.000₫'])
    // Kỳ dài đang chạy, chưa đạt ⇒ vẫn vẽ đường cần/ngày từ cột hôm nay (giữ luật K-0).
    await expect(root(page).locator('[data-required-line]')).toHaveCount(1)
    await openFx(page, 'detail-long-ended')
    expect(await root(page).locator('[data-chart-frame] g[data-day="2026-08-31"] title').textContent()).toBe('31/08: 16.000.000₫ (Offline 15.500.000₫ · Affiliate 500.000₫)')
  })

  test('đường cần/ngày KHÔNG vẽ khi: chưa có snapshot dù đã có điểm ngày / đã đạt / đã kết thúc (có điểm ngày) — luật K-0, giá trị thô', async ({ page }, info) => {
    await setup(page, 'm390', info.project.use.baseURL!)
    for (const fx of ['detail-unsynced-daily', 'detail-achieved', 'detail-ended-daily']) {
      await openFx(page, fx)
      await expect(root(page).locator('[data-chart-frame] svg[role="img"]'), `${fx}: phải có biểu đồ (có điểm ngày)`).toHaveCount(1)
      await expect(root(page).locator('[data-required-legend]'), `${fx}: không được vẽ đường cần/ngày`).toHaveCount(0)
      await expect(root(page).locator('[data-required-line]'), `${fx}: không được vẽ đường cần/ngày`).toHaveCount(0)
    }
    // Đối chứng: chiến dịch đang chạy, đã đồng bộ, chưa đạt ⇒ CÓ đường.
    await openFx(page, 'detail-gmv')
    await expect(root(page).locator('[data-required-legend]')).toHaveCount(1)
  })

  test('Số khách: bảng "Số khách", không đường cần/ngày; chưa đồng bộ: hero "Chưa đồng bộ", Còn thiếu "—", không bảng ngày, chú thích "Doanh số chưa được đồng bộ"', async ({ page }, info) => {
    await setup(page, 'm390', info.project.use.baseURL!)
    await openFx(page, 'detail-customer')
    await expect(root(page).locator('[data-required-legend]')).toHaveCount(0)
    await expect(table(page), 'thiếu bảng số liệu ngày').toHaveCount(1)
    await table(page).locator('summary').click()
    expect(await table(page).locator('thead th').allInnerTexts()).toEqual(['Ngày', 'Số khách'])
    const rows = await rowsOf(page)
    expect(rows.length).toBe(15)
    expect(rows[0]).toEqual(['2026-10-01', '3 khách'])
    await openFx(page, 'detail-unsynced')
    const r = root(page)
    await expect(r.locator('[data-kpi-hero]')).toContainText('Chưa đồng bộ')
    await expect(r.locator('[data-kpi-hero]')).toContainText('Còn thiếu:—')
    await expect(table(page)).toHaveCount(0)
    await expect(r.locator('[data-required-legend]')).toHaveCount(0)
    await expect(r).toContainText('Doanh số chưa được đồng bộ')
    await expect(r).not.toContainText('0₫ / ')
  })

  test('M5 theo kỳ: tab Ngày/Tuần/Tháng (aria-current), thẻ KPI tuần / ngày không mục tiêu / tháng đã đạt; rỗng ⇒ câu cũ; QR', async ({ page }, info) => {
    await setup(page, 'm390', info.project.use.baseURL!)
    await openFx(page, 'period-week')
    const r = root(page)
    await expect(r).toHaveAttribute('data-staff-targets', 'period')
    await expect(r.locator('h1')).toHaveText('Doanh số tuần')
    await expect(r.locator('a[aria-current="page"]')).toHaveText('Tuần')
    const card = r.locator('[data-kpi-summary]')
    await expect(card).toContainText('KPI tuần')
    await expect(card).toContainText('Chưa đạt mục tiêu')
    await expect(card).toContainText('31.420.000₫')
    await expect(card).toContainText('66.0%')
    await openFx(page, 'period-day')
    await expect(root(page).locator('[data-kpi-summary]')).toContainText('Chưa có mục tiêu')
    await expect(root(page).locator('[data-kpi-summary]')).toContainText('Chưa cập nhật')
    await openFx(page, 'period-month')
    await expect(root(page).locator('[data-kpi-summary]')).toContainText('Đã đạt mục tiêu')
    await openFx(page, 'period-empty')
    await expect(root(page).getByText('Chưa có dữ liệu doanh số tuần cho cửa hàng của bạn.')).toBeVisible()
    await expect(root(page).locator('[data-kpi-summary]')).toHaveCount(0)
    await expect(root(page).getByText('Mã QR Circa Online')).toBeVisible()
  })

  test('trạng thái: chưa gán cửa hàng / lỗi truy vấn / lỗi Giới thiệu / thiếu SĐT / lỗi QR — đúng câu cũ', async ({ page }, info) => {
    await setup(page, 'm390', info.project.use.baseURL!)
    await openFx(page, 'no-store')
    await expect(root(page)).toContainText('Tài khoản chưa được gán cửa hàng')
    await openFx(page, 'error')
    await expect(root(page)).toContainText('Không tải được dữ liệu doanh số')
    await openFx(page, 'referral-error')
    await expect(root(page)).toContainText('Không tải được dữ liệu chương trình giới thiệu')
    await openFx(page, 'referral-phone')
    await expect(root(page)).toContainText('để xem chương trình giới thiệu bạn bè')
    await openFx(page, 'qr-error')
    await expect(root(page)).toContainText('Không tải được mã QR. Vui lòng thử lại sau hoặc báo Admin.')
  })

  test('QLCH desktop 1280: 2 cột (nội dung + QR/GMV), tóm tắt kết quả + 1 bộ lọc, Mốc thưởng có "Còn thiếu" từng bậc; danh sách / rỗng', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    await openFx(page, 'manager-detail')
    const r = root(page)
    await expect(r).toHaveAttribute('data-staff-targets', 'manager-detail')
    await expect(r.locator('form:has(input[name="from"])')).toHaveCount(1)
    await expect(r.locator('[data-kpi-tiers]')).toContainText('Còn thiếu:')
    await expect(r.getByText('GMV Affiliate — Circa Online')).toBeVisible()
    await noPageOverflow(page, 'manager-detail 1280')
    await openFx(page, 'manager-list')
    await expect(root(page).locator('[data-campaign-card-list] > a')).toHaveCount(2)
    await openFx(page, 'manager-empty')
    await expect(root(page).getByText('Hiện chưa có chiến dịch doanh số đang áp dụng.')).toBeVisible()
    await expect(blockedCounter(page)).toHaveCount(1)
  })

  for (const theme of THEMES) {
    for (const dev of ['m360', 'm390', 'd1440'] as Dev[]) {
      test(`bố cục ${dev} ${theme}: không tràn (kể cả tên dài, 6 thẻ), chạm ≥44px ở mobile; ảnh fixture`, async ({ page }, info) => {
        await setup(page, dev, info.project.use.baseURL!)
        const mobile = dev.startsWith('m')
        const shots: [string, string][] = mobile
          ? [['list-long', ''], ['detail-quality', theme === 'light' ? 'staff-detail-quality-light-m390' : ''], ['period-week', theme === 'light' ? 'staff-period-light-m390' : ''],
             ['list', theme === 'light' ? 'staff-list-light-m390' : ''], ['detail-gmv', `staff-detail-gmv-${theme}-m390`]]
          : [['manager-detail', theme === 'light' ? 'manager-detail-light-d1440' : '']]
        for (const [fx, snap] of shots) {
          await openFx(page, fx, theme)
          await noPageOverflow(page, `${fx} ${dev} ${theme}`)
          if (mobile) {
            for (const el of await root(page).locator('a[href], summary, button').all()) {
              if (!(await el.isVisible())) continue
              const h = (await el.boundingBox())!.height
              expect(h, `${fx}: vùng chạm "${(await el.innerText()).slice(0, 30)}" cao ${h}px`).toBeGreaterThanOrEqual(44)
            }
          }
          if (snap && dev !== 'm360') {
            if (mobile) await page.evaluate(() => {
              document.querySelectorAll<HTMLElement>('header.bg-primary, aside.bg-sidebar, nav[aria-label="Điều hướng chính"], nextjs-portal')
                .forEach((el) => { el.style.display = 'none' })
              const main = document.querySelector<HTMLElement>('main')
              const outer = main?.parentElement
              if (outer) { outer.style.height = 'auto'; outer.style.overflow = 'visible' }
              if (main) main.style.overflow = 'visible'
            })
            else await page.setViewportSize({ width: DEVICES[dev].width, height: 1600 })
            expect(await page.getByTestId('ui-catalog-kpi-staff').screenshot({ animations: 'disabled' }))
              .toMatchSnapshot(`${snap}.png`, { maxDiffPixelRatio: 0.01 })
            await page.setViewportSize(DEVICES[dev])
          }
        }
      })
    }
  }
})

// Route thật — CHỈ ĐỌC, theo dữ liệu prod của tài khoản E2E: mỗi nhánh dữ liệu đều khẳng định chặt + ghi annotation.
async function themed(page: Page, url: string, theme: Theme) {
  await page.goto(url)
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
}

test.describe('ui v2 KPI K-6 /targets route thật — staff @desktop', () => {
  test.skip(!HAS_STAFF, 'chưa có phiên staff')
  test.use({ storageState: STAFF_STATE })

  test('staff /targets 360/390 sáng/tối: gốc v2; nhánh chiến dịch (thẻ → ?campaign=uuid) HOẶC theo kỳ (tab Ngày/Tuần/Tháng) — khẳng định chặt; mở chi tiết chiến dịch đầu; không NaN, không tràn', async ({ page }, info) => {
    let detailHref: string | null = null
    for (const dev of ['m360', 'm390'] as Dev[]) {
      for (const theme of THEMES) {
        await setup(page, dev, info.project.use.baseURL!)
        await themed(page, '/targets', theme)
        const r = root(page)
        await expect(r).toBeVisible({ timeout: 20_000 })
        await expect(r).toHaveAttribute('data-ui-v2', 'page')
        const kind = await r.getAttribute('data-staff-targets')
        expect(['campaign-list', 'period'], `nhánh staff lạ: ${kind}`).toContain(kind)
        if (kind === 'campaign-list') {
          const links = r.locator('[data-campaign-card-list] > a')
          expect(await links.count()).toBeGreaterThan(0)
          for (const h of await links.evaluateAll((els) => els.map((a) => a.getAttribute('href')))) expect(h).toMatch(UUID_Q)
          detailHref ??= await links.first().getAttribute('href')
          await expect(r.locator('a[aria-current="page"]'), 'chế độ chiến dịch không có tab kỳ').toHaveCount(0)
        } else {
          await expect(r.locator('a[aria-current="page"]')).toHaveCount(1)
          await expect(r.locator('[data-kpi-summary]').or(r.getByText(/Chưa có dữ liệu doanh số/))).toBeVisible()
        }
        if (dev === 'm390' && theme === 'light') test.info().annotations.push({ type: 'nhánh', description: `staff /targets: ${kind}` })
        await expect(r).not.toContainText('NaN')
        await expect(r).not.toContainText('undefined')
        await noPageOverflow(page, `staff /targets ${dev} ${theme}`)
      }
    }
    if (detailHref === null) return
    await setup(page, 'm390', info.project.use.baseURL!)
    await themed(page, detailHref, 'light')
    const r = root(page)
    await expect(r).toHaveAttribute('data-staff-targets', 'campaign-detail', { timeout: 20_000 })
    await expect(r.locator('[data-kpi-hero]').or(r.locator('[data-kpi-quality]'))).toBeVisible()
    // Bảng số liệu ngày có khi có dữ liệu ngày; không có ⇒ khung biểu đồ hiện câu "Chưa …" — khẳng định đúng một trong hai.
    const tableCount = await table(page).count()
    if (tableCount === 1) {
      await table(page).locator('summary').click()
      expect((await rowsOf(page)).length).toBeGreaterThan(0)
    } else {
      expect(tableCount).toBe(0)
      await expect(r.locator('[data-chart-frame]')).toContainText(/Chưa (có dữ liệu|tải được)/)
    }
    test.info().annotations.push({ type: 'nhánh', description: `staff chi tiết ${detailHref}: bảng ngày ${tableCount === 1 ? 'có' : 'không (chưa có dữ liệu ngày)'}` })
    await expect(r).not.toContainText('NaN')
    await noPageOverflow(page, 'staff chi tiết 390')
  })
})

test.describe('ui v2 KPI K-6 /targets route thật — QLCH @desktop', () => {
  test.skip(!HAS_MANAGER, 'chưa có phiên QLCH')
  test.use({ storageState: MANAGER_STATE })

  test('QLCH /targets 1280 sáng/tối + 390: gốc v2; danh sách (≥1 thẻ → ?campaign=uuid) hoặc rỗng (câu cũ); mở chi tiết thẻ đầu: tóm tắt + 1 bộ lọc + mốc "Còn thiếu"/"Đã đạt"; không NaN, không tràn', async ({ page }, info) => {
    let detailHref: string | null = null
    for (const theme of THEMES) {
      await setup(page, 'd1280', info.project.use.baseURL!)
      await themed(page, '/targets', theme)
      const r = root(page)
      await expect(r).toBeVisible({ timeout: 20_000 })
      await expect(r).toHaveAttribute('data-ui-v2', 'page')
      const kind = await r.getAttribute('data-staff-targets')
      // /targets không ?campaign= ⇒ chỉ có danh sách (≥1 chiến dịch) hoặc rỗng (showCampaignList).
      expect(['manager-list', 'manager-empty']).toContain(kind)
      if (kind === 'manager-list') {
        const hrefs = await r.locator('[data-campaign-card-list] > a').evaluateAll((els) => els.map((a) => a.getAttribute('href')))
        expect(hrefs.length, 'QLCH danh sách không có thẻ nào').toBeGreaterThan(0)
        for (const h of hrefs) expect(h).toMatch(UUID_Q)
        detailHref ??= hrefs[0]
      } else {
        await expect(r.getByText('Hiện chưa có chiến dịch doanh số đang áp dụng.')).toBeVisible()
        await expect(r.locator('[data-campaign-card-list]')).toHaveCount(0)
      }
      if (theme === 'light') test.info().annotations.push({ type: 'nhánh', description: `QLCH /targets: ${kind}` })
      await expect(r).not.toContainText('NaN')
      await noPageOverflow(page, `QLCH /targets 1280 ${theme}`)
    }
    await page.setViewportSize(DEVICES.m390)
    await page.reload()
    await expect(root(page)).toBeVisible({ timeout: 20_000 })
    await noPageOverflow(page, 'QLCH /targets 390')
    if (detailHref === null) return
    await setup(page, 'd1280', info.project.use.baseURL!)
    await themed(page, detailHref, 'light')
    const r = root(page)
    await expect(r).toHaveAttribute('data-staff-targets', 'manager-detail', { timeout: 20_000 })
    await expect(r.getByRole('link', { name: '← Danh sách chiến dịch' })).toHaveAttribute('href', '/targets')
    await expect(r.locator('form:has(input[name="from"])'), 'QLCH được lọc khoảng — đúng 1 bộ lọc').toHaveCount(1)
    await expect(r.locator('form input[type="hidden"][name="campaign"]')).toHaveValue(detailHref.split('=')[1])
    await expect(r.locator('[data-kpi-hero]').or(r.locator('[data-kpi-quality]'))).toBeVisible()
    const tiers = r.locator('[data-kpi-tiers]')
    if (await tiers.count()) await expect(tiers, 'QLCH ≥1024px: mỗi bậc có "Còn thiếu"/"Đã đạt"').toContainText(/Còn thiếu:|Đã đạt/)
    test.info().annotations.push({ type: 'nhánh', description: `QLCH chi tiết ${detailHref}: mốc thưởng ${await tiers.count() ? 'có' : 'không (chiến dịch không có bậc)'}` })
    await expect(r).not.toContainText('NaN')
    await noPageOverflow(page, 'QLCH chi tiết 1280')
  })
})

test.describe('ui v2 KPI K-6 khung chờ /targets — SM @desktop', () => {
  test.skip(!HAS_SM, 'chưa có phiên SM')
  test.use({ storageState: SM_STATE })

  // Vào /targets từ ngoài (sidebar "Doanh số") ⇒ ranh giới targets/loading.tsx ⇒ khung v2 chung TargetsLandingSkeleton.
  test('router từ /tasks → /targets: hiện khung chờ v2 [data-route-loading="targets"], không khung cũ max-w-xl, rồi trang SM', async ({ page }) => {
    const ROUTE = '/targets'
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
    await page.goto('/tasks')
    await page.locator('main h1').first().waitFor()
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
    await page.evaluate((h) => {
      const r = (window as unknown as { next?: { router?: { push: (href: string) => void } } }).next?.router
      if (!r) throw new Error('window.next.router không có')
      r.push(h)
    }, ROUTE)
    const l = page.locator('[data-route-loading="targets"]')
    await expect(l, 'khung chờ /targets v2 không hiện').toBeVisible({ timeout: 2_000 })
    await expect(l).toHaveAttribute('data-ui-v2', 'page')
    await expect(page.locator('main [data-sm-targets]')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-route-loading]')).toHaveCount(0)
  })
})
