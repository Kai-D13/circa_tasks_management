import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { SUPER_STATE } from './authState'
import { trapWrites } from './fixtureGuard'

// Batch vá `xlsx` 0.20.3 — smoke TRÌNH DUYỆT cho đường client duy nhất dùng thư viện: form tạo task "Nhiều CH" → "Chia file
// Excel theo cửa hàng" (components/tasks/TaskExcelSplitPanel.tsx: XLSX.read {type:'array'} + sheet_to_json raw:false trong
// bundle client). CHỈ ĐỌC: chọn file giả rồi kiểm số dòng / sheet; KHÔNG bấm tạo task, mọi request ghi bị chặn và phải = 0.

const FIXTURE = path.join(__dirname, 'xlsx-fixtures', 'regression-sheetjs.xlsx')
const btn = (page: Page, name: string) => page.locator('main').getByRole('button', { name, exact: true })

test.describe('xlsx — bundle client: chia file Excel ở form task (chỉ đọc) @desktop', () => {
  test.skip(!fs.existsSync(SUPER_STATE), 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('chọn file ⇒ trình duyệt đọc đúng sheet / số dòng bằng thư viện đã vá; 0 request ghi', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/tasks/new')
    await page.locator('main h1').first().waitFor()
    const seen = await trapWrites(page) // sau khi trang đã tải: chỉ đo thao tác chọn file
    await expect(async () => {
      await btn(page, 'Nhiều CH').click()
      await expect(page.locator('main').getByText(/^Chọn cửa hàng \(\d+ đã chọn\)$/)).toBeVisible({ timeout: 1_000 })
    }, 'không chuyển được sang Nhiều CH (hydrate?)').toPass({ timeout: 15_000 })
    const boxes = page.locator('main label input[type="checkbox"]')
    expect(await boxes.count(), 'phải có ít nhất 2 cửa hàng').toBeGreaterThanOrEqual(2)
    await boxes.nth(0).check()
    await boxes.nth(1).check()
    await expect(page.locator('main').getByText('Chia file Excel theo cửa hàng (tuỳ chọn)')).toBeVisible()
    await page.locator('main input[type="file"][aria-label="Chon file Excel"]').setInputFiles(FIXTURE)
    // Golden 0.18.5 = 0.20.3: sheet "Data" có 4 dòng dữ liệu (profile B).
    await expect(page.locator('main').getByText(/^4 dòng · sheet Data$/)).toBeVisible()
    await expect(page.getByText('Không đọc được file')).toHaveCount(0)
    expect(errors).toEqual([])
    expect(seen).toEqual([])
  })
})
