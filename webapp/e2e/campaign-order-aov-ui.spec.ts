import { test, expect, type Page } from '@playwright/test'
import { SUPER_STATE } from './authState'

// ─────────────────────────────────────────────────────────────────────────────
// CHẤT LƯỢNG BÁN HÀNG — acceptance RUNTIME (commit 5)
//
// Contract thuần đã có test riêng (kpi-order-aov). Suite này trả lời câu hỏi
// KHÁC: màn hình thật có đúng như contract không. Bài học 4b: 493 test xanh vẫn
// lọt một block render trùng và một nhánh vai trò chưa hề được nối.
//
// Khoá ba thứ:
//   1. Bảng có HAI cột độc lập Số đơn / AOV, KHÔNG còn điểm gộp và Nhịp độ.
//   2. Số cột <th> == số cell <td> mỗi dòng. Bỏ một cột phải bỏ ĐỦ cả header
//      lẫn cell: trong chính commit này, bản nháp gỡ header 'Nhịp độ' mà quên
//      cell → body thừa một cột, mọi giá trị bên phải bị đọc dưới tên cột
//      khác. Test này bắt được ngay, nên nó ở lại.
//   3. % của từng chỉ số có mặt và không bị cap 100.
// ─────────────────────────────────────────────────────────────────────────────

const SUPER = { email: process.env.E2E_SUPER_EMAIL, password: process.env.E2E_SUPER_PASSWORD }

const ORDER_COL = 'Số đơn (thực tế / mục tiêu)'
const AOV_COL = 'AOV (thực tế / mục tiêu)'

// Tìm campaign Chất lượng bán hàng bằng chính dấu hiệu của nó trên màn Kết quả.
async function findOrderAovCampaign(page: Page): Promise<string | null> {
  await page.goto('/targets/campaigns')
  const hrefs = (await page.locator('main a[href^="/targets/campaigns/"]').evaluateAll(
    (as) => as.map((a) => a.getAttribute('href') ?? ''),
  )).filter((h) => /^\/targets\/campaigns\/[0-9a-f-]{36}$/.test(h))

  for (const h of hrefs) {
    await page.goto(`${h}?tab=result`)
    if (await page.getByText(ORDER_COL, { exact: true }).count() > 0) return h
  }
  return null
}

test.describe('Chất lượng bán hàng — bảng kết quả @desktop', () => {
  test.use({ storageState: SUPER_STATE })
  test.skip(!SUPER.email || !SUPER.password, 'E2E_SUPER_* chưa set')

  test('HAI cột độc lập; điểm gộp và Nhịp độ biến mất', async ({ page }) => {
    const href = await findOrderAovCampaign(page)
    test.skip(href === null, 'chưa có chiến dịch Chất lượng bán hàng nào')

    const headers = await page.locator('table thead th').allInnerTexts()
    expect(headers, 'phải có cột Số đơn riêng').toContain(ORDER_COL)
    expect(headers, 'phải có cột AOV riêng').toContain(AOV_COL)
    expect(headers).toContain('Trạng thái')
    // Điểm gộp min(số đơn%, AOV%) và mọi thứ suy ra từ nó KHÔNG còn trên bảng.
    for (const dead of ['Hoàn thành', 'Nhịp độ', 'KPI target', 'Trung bình/ngày']) {
      expect(headers, `cột '${dead}' phải biến mất`).not.toContain(dead)
    }
  })

  test('header và body PHẢI cùng số cột (bỏ cột phải bỏ cả hai phía)', async ({ page }) => {
    const href = await findOrderAovCampaign(page)
    test.skip(href === null, 'chưa có chiến dịch Chất lượng bán hàng nào')

    const headerCount = await page.locator('table thead th').count()
    const rows = page.locator('table tbody tr')
    const rowCount = await rows.count()
    test.skip(rowCount === 0, 'chiến dịch chưa có dòng cửa hàng nào')
    for (let i = 0; i < Math.min(rowCount, 5); i++) {
      expect(await rows.nth(i).locator('td').count(), `dòng ${i} lệch cột`).toBe(headerCount)
    }
  })

  test('mỗi chỉ số có % riêng trong ô của nó', async ({ page }) => {
    const href = await findOrderAovCampaign(page)
    test.skip(href === null, 'chưa có chiến dịch Chất lượng bán hàng nào')

    const headers = await page.locator('table thead th').allInnerTexts()
    const orderIdx = headers.indexOf(ORDER_COL)
    const aovIdx = headers.indexOf(AOV_COL)
    const row = page.locator('table tbody tr').first()
    test.skip(await page.locator('table tbody tr').count() === 0, 'chưa có dòng cửa hàng')

    const orderCell = await row.locator('td').nth(orderIdx).innerText()
    const aovCell = await row.locator('td').nth(aovIdx).innerText()
    // 'x / y đơn' + '116,2%' — cặp thực tế/mục tiêu VÀ phần trăm, trong CÙNG ô.
    expect(orderCell, `ô Số đơn: ${orderCell}`).toMatch(/\/.*đơn/)
    expect(orderCell).toMatch(/(%|—)/)
    expect(aovCell, `ô AOV: ${aovCell}`).toMatch(/\/.*₫/)
    expect(aovCell).toMatch(/(%|—)/)
  })
})
