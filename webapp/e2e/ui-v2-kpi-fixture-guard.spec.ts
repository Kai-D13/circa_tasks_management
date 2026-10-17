import fs from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import { SUPER_STATE } from './authState'
import { blockedCounter, expectBlocked, expectBoundaryOnlyInCatalog, expectCatalogWrapped, expectGuardedCalls, fixtureBlockedToast, trapWrites } from './fixtureGuard'

// PM 17/10 (P1 — catalog KPI bất khả ghi) · K-1 danh sách + K-2 chi tiết. Fixture /ui-catalog/kpi-v2/{campaigns,detail}
// dựng CHÍNH CampaignListView / CampaignDetailView của route thật. Mọi CTA có action (trạng thái, xác nhận lưu trữ/xoá,
// lưu chỉ số, chọn file → xem trước, đồng bộ, xuất Excel) — chuột lẫn bàn phím — phải bị KpiFixtureBoundary chặn:
// bộ đếm chặn tăng đúng 1/thao tác, có toast, 0 request ghi (trapWrites abort mọi request ghi trong trình duyệt ⇒ guard
// hỏng thì test đỏ nhưng không có gì tới máy chủ). Route thật: không boundary, nút Đồng bộ vẫn gửi đúng 1 server action
// (bị abort ở trình duyệt, không tới máy chủ). Nguồn: mọi lời gọi action/export đi qua fixtureBlocked().

const HAS_SUPER = fs.existsSync(SUPER_STATE)
const UUID_HREF = /^\/targets\/campaigns\/[0-9a-f-]{36}$/
const CSV = Buffer.from('pos_code,kpi_target\nFX01,1000000\n', 'utf8')

async function setup(page: Page, baseURL: string) {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.context().addCookies([{ name: 'sidebar_collapsed', value: '0', url: baseURL }])
}

async function open(page: Page, url: string, testid: string, fx: string) {
  await page.goto(url)
  await page.locator(`main [data-testid="${testid}"][data-fx="${fx}"]`).waitFor({ state: 'visible', timeout: 20_000 })
  await expectBlocked(page, 0, 'mở trang')
}

const dialog = (page: Page) => page.getByRole('dialog')

test.describe('ui v2 KPI fixture bất khả ghi — nguồn @desktop', () => {
  test('5 component ghi K-1/K-2 hỏi fixtureBlocked() trước mọi lời gọi action/export; fixture bọc boundary, route thật không', () => {
    expect(expectGuardedCalls('components/kpi/CampaignStatusButton.tsx', ['toggleCampaign', 'deleteCampaign', 'archiveCampaign'])).toBe(2)
    expect(expectGuardedCalls('components/kpi/CampaignImport.tsx', ['previewCampaignImport', 'commitCampaignImport'])).toBe(2)
    expect(expectGuardedCalls('components/kpi/CampaignMetricEditor.tsx', ['updateCampaign'])).toBe(1)
    expect(expectGuardedCalls('components/kpi/SyncActualsButton.tsx', ['syncCampaignActuals'])).toBe(1)
    expect(expectGuardedCalls('components/kpi/CampaignExportButton.tsx', ['fetch'])).toBe(1)
    expectCatalogWrapped('app/(dashboard)/ui-catalog/kpi-v2/campaigns/page.tsx')
    expectCatalogWrapped('app/(dashboard)/ui-catalog/kpi-v2/detail/page.tsx')
    expectBoundaryOnlyInCatalog(['app/(dashboard)/targets/campaigns/page.tsx', 'app/(dashboard)/targets/campaigns/[id]/page.tsx'])
  })
})

test.describe('ui v2 KPI fixture bất khả ghi — K-1 danh sách + K-2 chi tiết @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE, serviceWorkers: 'block' })

  test('danh sách fixture: Tạm dừng / Kích hoạt (chuột + Enter) / Lưu trữ → xác nhận / Xoá → xác nhận (Enter) ⇒ chặn, 0 request ghi', async ({ page }, info) => {
    await setup(page, info.project.use.baseURL!)
    const seen = await trapWrites(page)
    await open(page, '/ui-catalog/kpi-v2/campaigns?fx=super', 'ui-catalog-kpi-campaigns', 'super')
    const row = (s: string) => page.locator(`main [data-campaign-table] tr[data-campaign-row="${s}"]`).first()
    let n = 0
    await row('active').getByRole('button', { name: 'Tạm dừng', exact: true }).click()
    await expectBlocked(page, ++n, 'Tạm dừng')
    await row('paused').getByRole('button', { name: 'Kích hoạt', exact: true }).click()
    await expectBlocked(page, ++n, 'Kích hoạt')
    await row('draft').getByRole('button', { name: 'Kích hoạt', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expectBlocked(page, ++n, 'Kích hoạt (Enter)')

    await row('ended').getByRole('button', { name: 'Lưu trữ chiến dịch' }).click()
    await expect(dialog(page)).toContainText('Lưu trữ chiến dịch?')
    await dialog(page).getByRole('button', { name: 'Lưu trữ', exact: true }).click()
    await expectBlocked(page, ++n, 'Lưu trữ → xác nhận')
    await expect(dialog(page)).toHaveCount(0)

    await row('draft').getByRole('button', { name: 'Xoá chiến dịch nháp' }).click()
    await expect(dialog(page)).toContainText('Xoá chiến dịch nháp?')
    await dialog(page).getByRole('button', { name: 'Xoá chiến dịch', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expectBlocked(page, ++n, 'Xoá → xác nhận (Enter)')
    await expect(dialog(page)).toHaveCount(0)

    await expect(page.getByText(fixtureBlockedToast()).first()).toBeVisible()
    await expect(page, 'nhánh thành công (router.push) không được chạy').toHaveURL(/\/ui-catalog\/kpi-v2\/campaigns\?fx=super$/)
    expect(seen, 'fixture danh sách gửi request ghi').toEqual([])
  })

  test('chi tiết fixture Cấu hình (nháp): Kích hoạt, Xoá → xác nhận, sửa chỉ số → Lưu, chọn file → Xem trước (chuột + Enter) ⇒ chặn, Xác nhận nạp vẫn khoá, 0 request', async ({ page }, info) => {
    await setup(page, info.project.use.baseURL!)
    const seen = await trapWrites(page)
    await open(page, '/ui-catalog/kpi-v2/detail?fx=config-draft', 'ui-catalog-kpi-detail', 'config-draft')
    const root = page.locator('main [data-campaign-detail="config"]')
    let n = 0
    await root.getByRole('button', { name: 'Kích hoạt', exact: true }).click()
    await expectBlocked(page, ++n, 'Kích hoạt')
    await root.getByRole('button', { name: 'Xoá chiến dịch nháp' }).click()
    await dialog(page).getByRole('button', { name: 'Xoá chiến dịch', exact: true }).click()
    await expectBlocked(page, ++n, 'Xoá → xác nhận')
    await expect(dialog(page)).toHaveCount(0)

    const metric = root.locator('[data-metric-option]').nth(1).locator('input[type="checkbox"]')
    await expect(metric).toBeChecked()
    await metric.uncheck()
    await root.getByRole('button', { name: 'Lưu chỉ số' }).click()
    await expectBlocked(page, ++n, 'Lưu chỉ số')

    await root.getByLabel('Chọn file Excel target chiến dịch').setInputFiles({ name: 'target.csv', mimeType: 'text/csv', buffer: CSV })
    const previewBtn = root.getByRole('button', { name: 'Xem trước', exact: true })
    await expect(previewBtn).toBeEnabled()
    await previewBtn.click()
    await expectBlocked(page, ++n, 'Xem trước')
    await previewBtn.focus()
    await page.keyboard.press('Enter')
    await expectBlocked(page, ++n, 'Xem trước (Enter)')
    await expect(root.getByRole('button', { name: 'Xác nhận nạp' }), 'chưa có xem trước ⇒ xác nhận nạp phải khoá').toBeDisabled()

    await expect(page.getByText(fixtureBlockedToast()).first()).toBeVisible()
    expect(seen, 'fixture Cấu hình gửi request ghi').toEqual([])
  })

  test('chi tiết fixture Kết quả: Tạm dừng, Đồng bộ, Xuất Excel; đã kết thúc: Lưu trữ → xác nhận ⇒ chặn, 0 request (kể cả GET export)', async ({ page }, info) => {
    await setup(page, info.project.use.baseURL!)
    const seen = await trapWrites(page)
    await open(page, '/ui-catalog/kpi-v2/detail?fx=result-gmv', 'ui-catalog-kpi-detail', 'result-gmv')
    const root = page.locator('main [data-campaign-detail="result"]')
    let n = 0
    await root.getByRole('button', { name: 'Tạm dừng', exact: true }).click()
    await expectBlocked(page, ++n, 'Tạm dừng')
    await root.getByRole('button', { name: 'Đồng bộ doanh số' }).click()
    await expectBlocked(page, ++n, 'Đồng bộ')
    await expect(root.getByRole('button', { name: 'Đang đồng bộ…' })).toHaveCount(0)
    await root.getByRole('button', { name: 'Xuất Excel' }).focus()
    await page.keyboard.press('Enter')
    await expectBlocked(page, ++n, 'Xuất Excel (Enter)')

    await open(page, '/ui-catalog/kpi-v2/detail?fx=result-ended', 'ui-catalog-kpi-detail', 'result-ended')
    await page.locator('main [data-campaign-detail="result"]').getByRole('button', { name: 'Lưu trữ chiến dịch' }).click()
    await dialog(page).getByRole('button', { name: 'Lưu trữ', exact: true }).click()
    await expectBlocked(page, 1, 'Lưu trữ → xác nhận')
    expect(seen, 'fixture Kết quả gửi request ghi / export').toEqual([])
  })
})

// Chiến dịch đang chạy (hoặc đã kết thúc) ĐẦU TIÊN của danh sách super — route thật. Không có ⇒ FAIL.
async function firstLiveCampaign(page: Page): Promise<string> {
  await page.goto('/targets/campaigns')
  const rows = page.locator('main [data-campaign-table] tr[data-campaign-row="active"], main [data-campaign-table] tr[data-campaign-row="ended"]')
  await rows.first().waitFor({ state: 'attached', timeout: 20_000 })
  const href = await rows.first().locator('a[href^="/targets/campaigns/"]').first().getAttribute('href')
  expect(href, 'không có chiến dịch đang chạy/đã kết thúc nào').toMatch(UUID_HREF)
  return href!
}

test.describe('ui v2 KPI route thật vẫn nối action — super @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE, serviceWorkers: 'block' })

  test('chi tiết thật: không có boundary; bấm Đồng bộ ⇒ đúng 1 server action POST (abort ở trình duyệt, không tới máy chủ)', async ({ page }, info) => {
    await setup(page, info.project.use.baseURL!)
    const seen = await trapWrites(page)
    const href = await firstLiveCampaign(page)
    await page.goto(`${href}?tab=result`)
    const root = page.locator('main [data-campaign-detail="result"]')
    await expect(root).toBeVisible({ timeout: 20_000 })
    await expect(blockedCounter(page), 'route thật không được bọc KpiFixtureBoundary').toHaveCount(0)
    expect(seen, 'mở trang thật không được gửi request ghi').toEqual([])
    await root.getByRole('button', { name: /^Đồng bộ/ }).click()
    await expect.poll(() => seen.length, { timeout: 10_000 }).toBe(1)
    await page.waitForTimeout(1_000) // cửa sổ bắt request thứ 2 đến muộn
    expect(seen).toEqual([{ method: 'POST', path: href, action: true }])
  })
})
