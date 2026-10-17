import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { test, expect, type Page } from '@playwright/test'
import { SM_STATE, SUPER_STATE } from './authState'

// UI v2 Phase 2 · K-2 — /targets/campaigns/[id] (canvas K2 Kết quả + K3 Cấu hình). Fixture /ui-catalog/kpi-v2/detail
// render ĐÚNG CampaignDetailView của route thật (model qua buildCampaignResultModel, bộ lọc qua rangeFilterVisibleForRole)
// ⇒ kiểm đủ trạng thái không phụ thuộc prod: GMV hybrid / offline / Số khách / Chất lượng bán hàng / thưởng thêm, chưa
// đồng bộ ('—', không 0 giả), kết thúc đạt, lọc khoảng (đang xem / lỗi / nguồn lỗi), rỗng, lỗi truy vấn, SM chỉ đọc,
// tab Cấu hình (chỉ số, nạp target, bảng target, lịch sử) + khối xem trước. Route thật: super Kết quả/Cấu hình, SM,
// khung chờ 2 lối vào. Bố cục 1280 sidebar mở / 1440 / 360 / 390 sáng/tối: chỉ BẢNG cuộn ngang, trang không tràn.

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
const FX = '/ui-catalog/kpi-v2/detail'
const UUID_HREF = /^\/targets\/campaigns\/[0-9a-f-]{36}$/
const FILTER_FORM = 'main form:has(input[name="from"])'

async function setup(page: Page, dev: Dev, baseURL: string) {
  await page.setViewportSize(DEVICES[dev])
  await page.context().addCookies([{ name: 'sidebar_collapsed', value: '0', url: baseURL }])
}

async function openFx(page: Page, fx: string, theme: Theme = 'light') {
  await page.goto(`${FX}?fx=${fx}`)
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
  await page.locator(`main [data-testid="ui-catalog-kpi-detail"][data-fx="${fx}"]`).waitFor({ state: 'visible', timeout: 20_000 })
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

const tile = (page: Page, id: string) => page.locator(`main [data-result-tile="${id}"]`)
const headerTexts = (page: Page) => page.locator('main [data-campaign-detail] table').first().locator('thead th:visible').allInnerTexts()

// Số ô hiển thị ở header = ở body (bỏ cột phải bỏ cả hai phía — bài học commit 5).
async function expectAlignedColumns(page: Page, table = 'main [data-campaign-detail] table') {
  const t = page.locator(table).first()
  const head = await t.locator('thead th:visible').count()
  const rows = t.locator('tbody tr')
  const n = await rows.count()
  expect(n, 'bảng không có dòng').toBeGreaterThan(0)
  for (let i = 0; i < Math.min(n, 5); i++) expect(await rows.nth(i).locator('td:visible').count(), `dòng ${i} lệch cột`).toBe(head)
}

test.describe('ui v2 KPI K-2 chi tiết chiến dịch — fixture @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('Kết quả GMV (2 nguồn): header + tab, thanh công cụ 1 bộ lọc giữ tab, hero/ô/2 thẻ nguồn, bảng khớp cột', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    await openFx(page, 'result-gmv')
    const root = page.locator('main [data-campaign-detail="result"]')
    await expect(root).toHaveAttribute('data-ui-v2', 'page')
    await expect(root.locator('h1')).toHaveText('KPI tháng 10/2026')
    await expect(root.getByText('Đang chạy', { exact: true }).first()).toBeVisible()
    await expect(root.getByText('Doanh số', { exact: true }).first()).toBeVisible()
    await expect(root).toContainText('01/10/2026 – 31/10/2026 · 6 cửa hàng · Còn 17 ngày')
    const tabs = root.locator('nav[aria-label="Màn chiến dịch"] a')
    expect(await tabs.evaluateAll((els) => els.map((e) => [e.textContent?.trim(), e.getAttribute('href'), e.getAttribute('aria-current')])))
      .toEqual([['Cấu hình', '/targets/campaigns/fx-detail?tab=config', null], ['Kết quả', '/targets/campaigns/fx-detail?tab=result', 'page']])
    await expect(root.getByRole('button', { name: 'Tạm dừng' })).toBeVisible()
    // Thanh công cụ: trạng thái đồng bộ · đúng MỘT bộ lọc giữ tab=result · Xuất / Đồng bộ
    const bar = root.locator('[data-result-toolbar]')
    await expect(bar).toContainText('Doanh số đồng bộ ')
    await expect(page.locator(FILTER_FORM)).toHaveCount(1)
    await expect(page.locator(`${FILTER_FORM} input[type="hidden"][name="tab"]`)).toHaveValue('result')
    await expect(bar.getByRole('button', { name: 'Xuất Excel' })).toBeVisible()
    await expect(bar.getByRole('button', { name: 'Đồng bộ doanh số' })).toBeVisible()
    // Hero: % từ tỷ lệ THÔ (1.757.447.100 / 2.510.000.000 = 70,02%) ⇒ "70%"; thanh/ARIA cùng số
    const comp = root.locator('[data-result-completion]')
    await expect(comp).toHaveText('70%')
    await expect(comp).toHaveAttribute('data-result-completion', 'series')
    await expect(root.locator('[data-result-actual]')).toHaveText('1.757.447.100₫')
    await expect(root.locator('[data-result-target]')).toHaveText('2.510.000.000₫')
    const bar0 = root.locator('[data-result-hero] [role="progressbar"]')
    await expect(bar0).toHaveAttribute('aria-label', 'Hoàn thành 70%')
    expect(Number(await bar0.getAttribute('aria-valuenow'))).toBeCloseTo(70.0178, 3)
    // Ô: nhãn cũ, số theo model
    await expect(tile(page, 'pace')).toContainText('Nhịp độ (Performance)')
    await expect(tile(page, 'pace').locator('p').nth(1)).toHaveText(/^\d+\.\d%$/) // định dạng cũ, khớp cột bảng
    await expect(tile(page, 'reached')).toContainText('Store đạt bậc2/6')
    await expect(tile(page, 'commission')).toContainText('Tổng commission đạt11.000.000₫')
    await expect(tile(page, 'deadline')).toContainText('Thời hạnCòn 17 ngày')
    await expect(tile(page, 'bonus')).toHaveCount(0)
    const bd = root.locator('[data-result-breakdown] > div')
    await expect(bd).toHaveCount(2)
    await expect(bd.nth(0)).toContainText('Doanh thu thuần tại cửa hàng1.724.134.800₫')
    await expect(bd.nth(0)).toContainText('12.887 đơn · AOV')
    await expect(bd.nth(1)).toContainText('33.312.300₫')
    // Bảng: cột cũ (không đổi nhãn), header = body
    const th = await headerTexts(page)
    for (const h of ['Cửa hàng', 'Phân loại', 'KPI target', 'Nhịp độ', 'Trung bình/ngày', 'Bậc 1', 'Bậc 2', 'Bậc 3']) expect(th, `thiếu cột ${h}`).toContain(h)
    await expectAlignedColumns(page)
    await expect(root.getByRole('alert')).toHaveCount(0)
  })

  test('Kết quả Chất lượng bán hàng: bộ ô riêng, KHÔNG hero điểm gộp; bảng Số đơn/AOV riêng, không cột gộp', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    await openFx(page, 'result-quality')
    const root = page.locator('main [data-campaign-detail="result"]')
    await expect(root.locator('[data-result-summary="quality"]')).toBeVisible()
    await expect(root.locator('[data-result-hero]')).toHaveCount(0)
    expect(await root.locator('[data-result-tile]').evaluateAll((els) => els.map((e) => e.getAttribute('data-result-tile'))))
      .toEqual(['quality-pass', 'orders', 'aov', 'net', 'commission', 'deadline'])
    await expect(tile(page, 'quality-pass')).toContainText('Cửa hàng đạt KPI2/6')
    await expect(root.getByRole('button', { name: 'Đồng bộ chất lượng bán hàng' })).toBeVisible()
    const th = await headerTexts(page)
    for (const h of ['Số đơn (thực tế / mục tiêu)', 'AOV (thực tế / mục tiêu)', 'Trạng thái']) expect(th).toContain(h)
    for (const dead of ['Hoàn thành', 'Nhịp độ', 'KPI target', 'Trung bình/ngày']) expect(th, `cột '${dead}' phải không có`).not.toContain(dead)
    await expectAlignedColumns(page)
  })

  test('Kết quả Số khách + offline-only + thưởng thêm: nhãn/đơn vị đúng loại', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    await openFx(page, 'result-customer')
    let root = page.locator('main [data-campaign-detail="result"]')
    await expect(root.locator('[data-result-hero]')).toContainText('Tổng số khách')
    await expect(root.locator('[data-result-actual]')).toHaveText(/ khách$/)
    await expect(root.locator('[data-result-target]')).toHaveText(/ khách$/)
    await expect(root.locator('[data-result-breakdown]')).toHaveCount(0)
    await expect(root.getByRole('button', { name: 'Đồng bộ số khách' })).toBeVisible()

    await openFx(page, 'result-offline')
    root = page.locator('main [data-campaign-detail="result"]')
    await expect(root.locator('[data-result-breakdown]')).toHaveCount(0)
    await expect(root.locator('[data-result-hero]')).toContainText('12.887 đơn · AOV')

    await openFx(page, 'result-bonus')
    await expect(tile(page, 'bonus')).toContainText('Đạt thưởng thêm')
    await expect(tile(page, 'bonus')).toContainText('200.000₫/dược sĩ')
    const th = await headerTexts(page)
    for (const h of ['Số đơn / Ngưỡng', 'Thưởng thêm/dược sĩ']) expect(th).toContain(h)
    await expectAlignedColumns(page)
  })

  test('chưa đồng bộ ⇒ "—" + thanh nét đứt, không 0 giả; kết thúc đạt thật ⇒ xanh', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    await openFx(page, 'result-unsynced')
    const root = page.locator('main [data-campaign-detail="result"]')
    await expect(root.locator('[data-result-toolbar]')).toContainText('Chưa đồng bộ doanh số')
    await expect(root.locator('[data-result-completion]')).toHaveText('—')
    await expect(root.locator('[data-result-completion]')).toHaveAttribute('data-result-completion', 'unsynced')
    await expect(root.locator('[data-result-hero] [role="progressbar"]'), 'chưa đồng bộ không được vẽ thanh').toHaveCount(0)
    expect(await root.locator('[data-result-hero] [aria-hidden="true"]').evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('dashed')
    await expect(root.locator('[data-result-actual]')).toHaveText('—')
    for (const id of ['pace', 'reached', 'commission']) await expect(tile(page, id).locator('p').nth(1)).toHaveText('—')
    await expect(root.locator('[data-result-target]')).toHaveText('2.510.000.000₫') // mục tiêu là cấu hình, vẫn hiện
    expect(await root.locator('[data-result-summary]').innerText()).not.toMatch(/(^|\s)0₫|(^|\s)0%/)

    await openFx(page, 'result-ended')
    const ended = page.locator('main [data-campaign-detail="result"]')
    await expect(ended.getByText('Kết thúc', { exact: true }).first()).toBeVisible()
    await expect(ended.locator('[data-result-completion]')).toHaveAttribute('data-result-completion', 'ok')
    expect(await ended.locator('[data-result-hero] [role="progressbar"] > div').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(47, 158, 91)')
    await expect(ended.locator('[data-result-completion]')).toHaveText(/^1\d\d(,\d)?%$/)
  })

  test('lọc khoảng: đang xem / khoảng sai / nguồn lỗi — đúng MỘT trạng thái, câu sẵn có', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    await openFx(page, 'result-range')
    const bar = page.locator('main [data-result-toolbar]')
    await expect(bar).toContainText('Đang xem 01/10/2026 – 10/10/2026 · Mục tiêu, bậc thưởng và commission vẫn tính theo TOÀN KỲ.')
    await expect(bar.getByRole('link', { name: 'Đặt lại khoảng ngày' })).toHaveAttribute('href', '/targets/campaigns/fx-detail?tab=result')
    await openFx(page, 'result-range-error')
    await expect(page.locator('main [data-result-toolbar]')).toContainText('Đang hiển thị số liệu TOÀN KỲ.')
    await expect(page.locator('main [data-result-toolbar]')).not.toContainText('Đang xem')
    await openFx(page, 'result-range-note')
    await expect(page.locator('main [data-result-toolbar]')).toContainText('Không áp dụng được khoảng đã chọn. Đang hiển thị số liệu TOÀN KỲ. (nguồn affiliate chưa sẵn sàng)')
  })

  test('SM chỉ đọc: không tab, không nút ghi/đồng bộ, CÓ Xuất Excel + bộ lọc; lỗi truy vấn ⇒ ErrorState; rỗng ⇒ câu cũ', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    await openFx(page, 'sm')
    const root = page.locator('main [data-campaign-detail="result"]')
    await expect(root.locator('nav[aria-label="Màn chiến dịch"]')).toHaveCount(0)
    for (const b of ['Tạm dừng', 'Kích hoạt', 'Lưu trữ chiến dịch', 'Đồng bộ doanh số']) await expect(root.getByRole('button', { name: b })).toHaveCount(0)
    await expect(root.getByRole('button', { name: 'Xuất Excel' })).toBeVisible()
    await expect(page.locator(FILTER_FORM)).toHaveCount(1)

    await openFx(page, 'error')
    const alert = page.locator('main [data-campaign-detail]').getByRole('alert')
    await expect(alert).toContainText('Lỗi truy vấn dữ liệu: canceling statement due to statement timeout')
    await expect(alert).toContainText('Kiểm tra migration 070/071/072/092/093 đã apply chưa.')

    await openFx(page, 'result-empty')
    await expect(page.locator('main [data-campaign-detail]')).toContainText('Chưa có target — nạp file ở tab Cấu hình trước.')
    await expect(page.locator('main [data-result-completion]')).toHaveText('—')
  })

  test('Cấu hình nháp: 2 panel cạnh nhau, ô chỉ số, nạp target (chọn file không gửi), bảng target + lịch sử', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    await openFx(page, 'config-draft')
    const root = page.locator('main [data-campaign-detail="config"]')
    await expect(root.locator('nav[aria-label="Màn chiến dịch"] a[aria-current="page"]')).toHaveText('Cấu hình')
    await expect(root.getByRole('button', { name: 'Kích hoạt' })).toBeVisible()
    await expect(root.getByRole('button', { name: 'Xoá chiến dịch nháp' })).toBeVisible()
    const metric = root.locator('section', { has: page.getByRole('heading', { name: 'Chỉ số doanh số' }) })
    const imp = root.locator('section', { has: page.getByRole('heading', { name: 'Nạp / cập nhật target (thay toàn bộ)' }) })
    const [mb, ib] = [await metric.boundingBox(), await imp.boundingBox()]
    expect(Math.abs(mb!.y - ib!.y), '2 panel phải cùng hàng ở 1280').toBeLessThan(2)
    expect(mb!.x).toBeLessThan(ib!.x)
    const opts = metric.locator('[data-metric-option]')
    await expect(opts).toHaveCount(2)
    await expect(opts.nth(0)).toContainText('Doanh thu thuần tại cửa hàng')
    await expect(opts.nth(0)).toContainText('Net Revenue từ báo cáo BI')
    expect(await opts.locator('input').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).checked))).toEqual([true, true])
    // Nạp target: chọn file chỉ đổi trạng thái UI, KHÔNG gọi server (không bấm Xem trước / Xác nhận nạp)
    await expect(imp.getByRole('button', { name: 'Xem trước' })).toBeDisabled()
    await expect(imp.getByRole('button', { name: 'Xác nhận nạp' })).toBeDisabled()
    await expect(imp.locator('details')).not.toHaveAttribute('open', '')
    const tmp = path.join(os.tmpdir(), 'k2-fixture-target.csv')
    fs.writeFileSync(tmp, 'pos_code,kpi_target\nPOS0009,1000\n')
    await imp.locator('input[type="file"]').setInputFiles(tmp)
    await expect(imp.locator('[data-import-file]')).toContainText('k2-fixture-target.csv')
    await expect(imp.getByRole('button', { name: 'Xem trước' })).toBeEnabled()
    await expect(imp.getByRole('button', { name: 'Xác nhận nạp' })).toBeDisabled()
    // Bảng target: cột tuỳ chọn theo dữ liệu (Phân loại, thưởng thêm), header = body
    const th = await root.locator('[data-target-table] thead th').allInnerTexts()
    expect(th).toEqual(['Cửa hàng', 'Phân loại', 'KPI target', 'Bậc (mốc % → Commission)', 'Ngưỡng đơn', 'Thưởng thêm/dược sĩ'])
    await expect(root.locator('[data-target-table] tbody tr')).toHaveCount(6)
    await expectAlignedColumns(page, 'main [data-target-table]')
    await expect(root.locator('[data-target-table] tbody tr').first()).toContainText('90% → 3.000.000₫')
    const runs = root.locator('[data-import-runs] li')
    await expect(runs).toHaveCount(2)
    await expect(runs.nth(0)).toContainText('target_T10_2026_v2.xlsx')
    await expect(runs.nth(0)).toContainText('6/6 dòng')
    await expect(runs.nth(1)).toContainText('0/6 dòng')
  })

  test('Cấu hình đang chạy / rỗng / Số khách + khối xem trước nạp', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    await openFx(page, 'config-active')
    let root = page.locator('main [data-campaign-detail="config"]')
    await expect(root.getByRole('heading', { name: 'Nạp / cập nhật target (thay toàn bộ)' })).toHaveCount(0)
    await expect(root).toContainText('Chỉ sửa được khi chiến dịch ở trạng thái nháp/tạm dừng.')
    expect(await root.locator('[data-metric-option] input').evaluateAll((els) => els.every((e) => (e as HTMLInputElement).disabled))).toBe(true)

    await openFx(page, 'config-empty')
    root = page.locator('main [data-campaign-detail="config"]')
    await expect(root).toContainText('Chưa có target. Nạp file để thêm.')
    await expect(root.locator('[data-target-table]')).toHaveCount(0)
    await expect(root.locator('details')).toHaveAttribute('open', '')

    await openFx(page, 'config-customer')
    root = page.locator('main [data-campaign-detail="config"]')
    await expect(root.getByRole('heading', { name: 'Loại chỉ số' })).toBeVisible()
    await expect(root).toContainText('Số khách Affiliate')

    await openFx(page, 'import-preview')
    const pv = page.locator('main [data-import-preview]')
    await expect(pv).toHaveCount(2)
    await expect(pv.nth(0)).toContainText('Hợp lệ 3')
    await expect(pv.nth(0).getByRole('alert')).toHaveCount(0)
    await expect(pv.nth(1)).toContainText('Hợp lệ 23')
    await expect(pv.nth(1)).toContainText('Lỗi 2')
    await expect(pv.nth(1)).toContainText('POS không khớp 1')
    await expect(pv.nth(1).getByRole('alert')).toContainText('Dòng 14 (POS0021): tier_2_threshold_pct phải lớn hơn tier_1')
    expect(await pv.nth(1).locator('thead th').allInnerTexts()).toContain('Thưởng thêm/dược sĩ')
    await expect(pv.nth(1)).toContainText('… và 22 dòng hợp lệ khác.')
  })

  for (const theme of THEMES) {
    for (const dev of ['d1280', 'd1440', 'm360', 'm390'] as Dev[]) {
      test(`bố cục ${dev} ${theme}: không tràn, chỉ bảng cuộn ngang, chạm ≥44px ở mobile`, async ({ page }, info) => {
        await setup(page, dev, info.project.use.baseURL!)
        const mobile = dev.startsWith('m')
        for (const fx of ['result-gmv', 'config-draft']) {
          await openFx(page, fx, theme)
          await noPageOverflow(page, `${fx} ${dev} ${theme}`)
          // Tiêu đề không bị nhóm tab/nút ép thành cột hẹp (lỗi thấy ở ảnh 390 lần đầu): ≤ 2 dòng, rộng ≥ 60% gốc
          const h1 = await page.locator('main [data-campaign-detail] h1').evaluate((el) => {
            const r = el.getBoundingClientRect()
            return { lines: Math.round(r.height / parseFloat(getComputedStyle(el).lineHeight)), w: r.width, root: el.closest('[data-campaign-detail]')!.getBoundingClientRect().width }
          })
          expect(h1.lines, `${fx} ${dev}: tiêu đề bị ép hẹp`).toBeLessThanOrEqual(2)
          expect(h1.w, `${fx} ${dev}: tiêu đề quá hẹp`).toBeGreaterThan(Math.min(h1.root * 0.6, 160))
          const wrap = page.locator('main [data-campaign-detail] table').first().locator('xpath=..')
          const g = await wrap.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, ox: getComputedStyle(el).overflowX }))
          expect(['auto', 'scroll'], `${fx}: khung bảng phải tự cuộn ngang`).toContain(g.ox)
          if (fx === 'result-gmv' && dev !== 'd1440') expect(g.sw, 'bảng kết quả N cột phải cuộn trong khung').toBeGreaterThan(g.cw)
          if (mobile) {
            const targets = page.locator('main [data-campaign-detail] nav[aria-label="Màn chiến dịch"] a, main [data-campaign-detail] button:visible')
            const sizes = await targets.evaluateAll((els) => els.map((e) => {
              const r = e.getBoundingClientRect(); return { h: Math.round(r.height), w: Math.round(r.width), t: (e.textContent ?? e.getAttribute('aria-label') ?? '').trim().slice(0, 24) }
            }))
            expect(sizes.length).toBeGreaterThan(2)
            for (const s of sizes) expect(Math.min(s.h, s.w), `vùng chạm < 44px: ${s.t}`).toBeGreaterThanOrEqual(44)
          }
          if (dev === 'd1440' || (dev === 'm390' && fx === 'result-gmv')) {
            if (mobile) await page.evaluate(() => {
              document.querySelectorAll<HTMLElement>('header.bg-primary, aside.bg-sidebar, nav[aria-label="Điều hướng chính"], nextjs-portal')
                .forEach((el) => { el.style.display = 'none' })
              const main = document.querySelector<HTMLElement>('main')
              const outer = main?.parentElement
              if (outer) { outer.style.height = 'auto'; outer.style.overflow = 'visible' }
              if (main) main.style.overflow = 'visible'
            })
            else await page.setViewportSize({ width: DEVICES[dev].width, height: 1600 })
            expect(await page.getByTestId('ui-catalog-kpi-detail').screenshot({ animations: 'disabled' }))
              .toMatchSnapshot(`detail-${fx}-${theme}-${dev}.png`, { maxDiffPixelRatio: 0.01 })
            await page.setViewportSize(DEVICES[dev])
          }
        }
      })
    }
  }

  test('khung chờ chi tiết (fixture): v2, không tràn 1440/360', async ({ page }, info) => {
    for (const dev of ['d1440', 'm360'] as Dev[]) {
      await setup(page, dev, info.project.use.baseURL!)
      await openFx(page, 'loading')
      const l = page.locator('main [data-route-loading="campaign-detail"]')
      await expect(l).toBeVisible()
      await expect(l).toHaveAttribute('data-ui-v2', 'page')
      await noPageOverflow(page, `loading ${dev}`)
    }
  })
})

// Chiến dịch đang chạy (hoặc đã kết thúc) ĐẦU TIÊN của danh sách super — route thật, chỉ đọc. Không có ⇒ FAIL.
async function firstLiveCampaign(page: Page): Promise<string> {
  await page.goto('/targets/campaigns')
  const rows = page.locator('main [data-campaign-table] tr[data-campaign-row="active"], main [data-campaign-table] tr[data-campaign-row="ended"]')
  await rows.first().waitFor({ state: 'attached', timeout: 20_000 })
  const href = await rows.first().locator('a[href^="/targets/campaigns/"]').first().getAttribute('href')
  expect(href, 'không có chiến dịch đang chạy/đã kết thúc nào').toMatch(UUID_HREF)
  return href!
}

test.describe('ui v2 KPI K-2 /targets/campaigns/[id] route thật — super @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('Kết quả + Cấu hình dữ liệu thật: gốc v2, 1 bộ lọc giữ tab, cột khớp, không NaN, không tràn 1280 sáng/tối', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    const href = await firstLiveCampaign(page)
    for (const theme of THEMES) {
      await page.goto(`${href}?tab=result`)
      await page.evaluate((t) => localStorage.setItem('theme', t), theme)
      await page.reload()
      const root = page.locator('main [data-campaign-detail="result"]')
      await expect(root).toBeVisible({ timeout: 20_000 })
      await expect(root).toHaveAttribute('data-ui-v2', 'page')
      await expect(root.getByRole('alert'), 'truy vấn lỗi trên prod').toHaveCount(0)
      await expect(page.locator(FILTER_FORM)).toHaveCount(1)
      await expect(page.locator(`${FILTER_FORM} input[type="hidden"][name="tab"]`)).toHaveValue('result')
      await expect(root.locator('[data-result-summary]')).toBeVisible()
      await expectAlignedColumns(page)
      await expect(root).not.toContainText('NaN')
      await expect(root).not.toContainText('undefined')
      await noPageOverflow(page, `result 1280 ${theme}`)
    }
    await page.goto(`${href}?tab=config`)
    const cfg = page.locator('main [data-campaign-detail="config"]')
    await expect(cfg).toBeVisible({ timeout: 20_000 })
    await expect(cfg.getByRole('alert')).toHaveCount(0)
    await expect(cfg.locator('[data-target-table]').or(cfg.getByText('Chưa có target. Nạp file để thêm.'))).toBeVisible()
    await expect(cfg).not.toContainText('NaN')
    await noPageOverflow(page, 'config 1280')
  })

  // Hai lối vào có RANH GIỚI CHỜ KHÁC NHAU: từ danh sách (cùng segment campaigns) ⇒ [id]/loading.tsx; từ ngoài /targets
  // ⇒ targets/loading.tsx chọn khung theo pathname. Cả hai phải ra khung CHI TIẾT v2 (không phải khung danh sách).
  for (const entry of ['list', 'outside'] as const) {
    test(`loading chi tiết: lối vào ${entry === 'list' ? 'link tên chiến dịch ở danh sách' : 'router từ /tasks'}`, async ({ page, browser }) => {
      // Lấy link ở CONTEXT RIÊNG: mở danh sách trước trong cùng context làm Next giữ cache prefetch của chi tiết (không
      // đi qua route đếm) ⇒ điều hướng từ /tasks thành điều hướng chặn (trang cũ đứng tới khi có dữ liệu, không khung
      // chờ) — trạng thái cache của Next, không phải lỗi giao diện (probe K-2). Kịch bản đo ở đây = phiên mới.
      const ctx = await browser.newContext({ storageState: SUPER_STATE, baseURL: test.info().project.use.baseURL })
      const href = await firstLiveCampaign(await ctx.newPage())
      await ctx.close()
      const prefetched = new Map<string, number>()
      let hold = false
      await page.route((u) => u.pathname === href, async (route) => {
        const h = route.request().headers()
        if (h['rsc'] === '1' && h['next-router-prefetch']) {
          let res: Awaited<ReturnType<typeof route.fetch>>
          try { res = await route.fetch() } catch { await route.abort('failed'); return }
          await route.fulfill({ response: res })
          prefetched.set(href, (prefetched.get(href) ?? 0) + 1)
          return
        }
        if (hold && h['rsc'] === '1') await new Promise((r) => setTimeout(r, 2500))
        await route.continue()
      })
      if (entry === 'outside') {
        await page.goto('/tasks')
        await page.locator('main h1').first().waitFor()
      } else {
        prefetched.clear()
        await page.goto('/targets/campaigns')
        await page.locator('main [data-campaign-table]').waitFor()
      }
      for (let round = 0; round < 10 && (prefetched.get(href) ?? 0) < 2; round++) {
        await page.evaluate((h) => {
          const r = (window as unknown as { next?: { router?: { prefetch: (href: string) => unknown } } }).next?.router
          if (!r) throw new Error('window.next.router không có')
          r.prefetch(h)
        }, href)
        for (let t = 0; t < 30 && (prefetched.get(href) ?? 0) < 2; t++) await page.waitForTimeout(100)
      }
      expect(prefetched.get(href) ?? 0, `prefetch ${href} chưa xong`).toBeGreaterThanOrEqual(2)
      // Link ở danh sách TỰ prefetch ngay khi trang tải ⇒ đếm đủ 2 phản hồi trước khi router xử lý xong; bấm lúc đó thì
      // điều hướng chặn (không khung chờ). Chờ mạng nhàn = router đã nhận đủ dữ liệu prefetch (probe K-2: 0/4 → 5/5).
      await page.waitForLoadState('networkidle')
      hold = true
      if (entry === 'list') await page.locator(`main [data-campaign-table] a[href="${href}"]`).first().click()
      else await page.evaluate((h) => {
        const r = (window as unknown as { next?: { router?: { push: (href: string) => void } } }).next?.router
        if (!r) throw new Error('window.next.router không có')
        r.push(h)
      }, href)
      const l = page.locator('[data-route-loading="campaign-detail"]')
      await expect(l, 'khung chờ chi tiết không hiện').toBeVisible({ timeout: 2_000 })
      await expect(l).toHaveAttribute('data-ui-v2', 'page')
      await expect(page.locator('[data-route-loading="campaigns"]'), 'hiện nhầm khung danh sách').toHaveCount(0)
      await expect(page.locator('main [data-campaign-detail]')).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('[data-route-loading]')).toHaveCount(0)
    })
  }
})

test.describe('ui v2 KPI K-2 /targets/campaigns/[id] route thật — SM @desktop', () => {
  test.skip(!HAS_SM, 'chưa có phiên SM')
  test.use({ storageState: SM_STATE })

  test('SM: gốc v2, không tab Cấu hình, không nút ghi/đồng bộ, có Xuất Excel; không tràn', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    await page.goto('/targets/campaigns')
    const list = page.locator('main [data-campaign-list]')
    await expect(list).toBeVisible({ timeout: 20_000 })
    const empty = list.getByText('Chưa có chiến dịch nào áp dụng cho các cửa hàng bạn quản lý.')
    const link = page.locator('main [data-campaign-table] a[href^="/targets/campaigns/"]').first()
    await expect(link.or(empty)).toBeVisible({ timeout: 15_000 })
    // Rỗng là trạng thái hợp lệ của dữ liệu SM: khẳng định chặt rồi dừng (không có chi tiết để mở).
    if (await empty.isVisible()) { await expect(page.locator('main [data-campaign-table]')).toHaveCount(0); return }
    const href = await link.getAttribute('href')
    expect(href).toMatch(UUID_HREF)
    await page.goto(`${href}?tab=config`)
    const root = page.locator('main [data-campaign-detail="result"]')
    await expect(root, '?tab=config phải bị ép về Kết quả với SM').toBeVisible({ timeout: 20_000 })
    await expect(root).toHaveAttribute('data-ui-v2', 'page')
    await expect(root.locator('nav[aria-label="Màn chiến dịch"]')).toHaveCount(0)
    for (const b of [/^Tạm dừng$/, /^Kích hoạt$/, /Lưu trữ/, /^Đồng bộ/]) await expect(root.getByRole('button', { name: b })).toHaveCount(0)
    await expect(root.getByRole('button', { name: 'Xuất Excel' })).toBeVisible()
    await noPageOverflow(page, 'SM detail 1280')
  })
})
