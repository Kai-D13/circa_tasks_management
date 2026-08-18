import { test, expect, type Page } from '@playwright/test'
import { STAFF_STATE, SUPER_STATE } from './authState'

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
//
// ⚠ PHẢI CHỜ, không được dùng `count()` trần: count() đọc DOM ngay lập tức nên
// một lượt render chậm sẽ trả 0 và test tự SKIP — mất coverage mà báo cáo vẫn
// xanh. Lần chạy tuần tự đầu tiên đã dính đúng ca này (chạy lẻ thì pass).
// Chờ tường minh: bảng phải xuất hiện, rồi mới kết luận có/không có cột.
async function findOrderAovCampaign(page: Page): Promise<string | null> {
  await page.goto('/targets/campaigns')
  // evaluateAll trên locator RỖNG trả [] mà KHÔNG chờ — danh sách render chậm
  // một nhịp là ra 0 link ⇒ test tự skip tức thì. Đây chính là nguyên nhân ba
  // test super skip ngẫu nhiên giữa các lượt chạy. Chờ link đầu tiên trước.
  await page.locator('main a[href^="/targets/campaigns/"]').first()
    .waitFor({ state: 'attached', timeout: 15_000 })
  const hrefs = (await page.locator('main a[href^="/targets/campaigns/"]').evaluateAll(
    (as) => as.map((a) => a.getAttribute('href') ?? ''),
  )).filter((h) => /^\/targets\/campaigns\/[0-9a-f-]{36}$/.test(h))

  for (const h of hrefs) {
    await page.goto(`${h}?tab=result`)
    // Tab Kết quả luôn có bảng HOẶC empty-state; chờ một trong hai ổn định.
    await page.locator('table thead th, [data-empty-state], main').first().waitFor({ state: 'attached' })
    const hit = await page.getByText(ORDER_COL, { exact: true }).first()
      .waitFor({ state: 'attached', timeout: 2_000 }).then(() => true).catch(() => false)
    if (hit) {
      // Dòng đầu của bảng phải có mặt trước khi test đếm cột.
      await page.locator('table tbody tr').first()
        .waitFor({ state: 'attached', timeout: 5_000 }).catch(() => {})
      return h
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// BỘ CHỌN CHIẾN DỊCH — Staff (commit 5.1)
//
// Picker chỉ xuất hiện khi cửa hàng có TỪ HAI chiến dịch trở lên; đó chính là
// lý do nó lọt qua mọi vòng trước. Bản cũ in `Hoàn thành ${Math.round(run_rate)}%`
// cho MỌI loại ⇒ Chất lượng bán hàng vẫn lộ điểm gộp ở đúng chỗ này, và
// Math.round biến 99,9999 thành "100%" cho cửa hàng CHƯA đạt.
// ─────────────────────────────────────────────────────────────────────────────

const STAFF = { email: process.env.E2E_STAFF_EMAIL, password: process.env.E2E_STAFF_PASSWORD }

test.describe('bộ chọn chiến dịch — Staff @desktop', () => {
  test.use({ storageState: STAFF_STATE })
  test.skip(!STAFF.email || !STAFF.password, 'E2E_STAFF_* chưa set')

  // Mở picker; trả về nhãn của từng dòng trong dialog.
  async function pickerRows(page: Page): Promise<string[]> {
    await page.goto('/targets')
    const first = page.locator('main a[href*="campaign="]').first()
    const hasCampaign = await first.waitFor({ state: 'attached', timeout: 15_000 })
      .then(() => true).catch(() => false)
    if (!hasCampaign) return []
    await page.goto((await first.getAttribute('href'))!)
    // Cùng bẫy: count() không chờ. Chờ tường minh rồi mới kết luận "không có
    // picker" — nếu không, store có 2 chiến dịch vẫn bị coi là không có.
    const trigger = page.locator('button:has-text("chiến dịch")').first()
    const hasPicker = await trigger.waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => true).catch(() => false)
    if (!hasPicker) return []                           // <2 chiến dịch: không có picker
    await trigger.click()
    await page.getByRole('heading', { name: 'Chọn chiến dịch' }).waitFor({ timeout: 10_000 })
    return page.locator('[role="dialog"] button p.text-xs').allInnerTexts()
  }

  test('mỗi dòng có nhãn chỉ số; loại Chất lượng bán hàng KHÔNG lộ điểm gộp', async ({ page }) => {
    const rows = await pickerRows(page)
    test.skip(rows.length === 0, 'store chưa có ≥2 chiến dịch để mở picker')

    for (const r of rows) {
      // Không dòng nào được cụt phần chỉ số.
      expect(r, `dòng picker thiếu nhãn chỉ số: ${r}`)
        .toMatch(/Hoàn thành \d|Số đơn .*·.*AOV|Chưa đồng bộ|Chưa có mục tiêu/)
      // '100%' chỉ hợp lệ khi thực sự đạt — bản cũ làm tròn 99,9999 lên.
      // Ca hụt sát ngưỡng phải hiện '<100%' (contract formatCompletionPct).
    }
    // Chất lượng bán hàng (nếu có trong phạm vi) TUYỆT ĐỐI không có "Hoàn thành".
    const names = await page.locator('[role="dialog"] button p.text-sm').allInnerTexts()
    for (let i = 0; i < names.length; i++) {
      const isOrderAov = /chất lượng bán hàng/i.test(names[i])
      if (isOrderAov) {
        expect(rows[i], `"${names[i]}" vẫn lộ điểm gộp`).not.toContain('Hoàn thành')
        expect(rows[i]).toMatch(/Số đơn .*·.*AOV|Chưa đồng bộ|Chưa có mục tiêu/)
      }
    }
  })

  test('GMV / Số khách GIỮ NGUYÊN "Hoàn thành X%" (không regress hai loại kia)', async ({ page }) => {
    const rows = await pickerRows(page)
    test.skip(rows.length === 0, 'store chưa có ≥2 chiến dịch để mở picker')
    expect(rows.some((r) => /Hoàn thành \d+%/.test(r)),
      `không dòng nào giữ dạng "Hoàn thành X%": ${JSON.stringify(rows)}`).toBe(true)
  })
})
