import { test, expect, type Page } from '@playwright/test'
import { MANAGER_STATE, SM_STATE, STAFF_STATE, SUPER_STATE } from './authState'

// ─────────────────────────────────────────────────────────────────────────────
// BỘ LỌC KHOẢNG NGÀY — acceptance RUNTIME (4b.1)
//
// 4b không có một test wiring nào, nên "493 passed" không chứng minh được điều
// gì về UI: block filter render TRÙNG ở QLCH và nhánh SM bị bỏ sót TRỌN VẸN vẫn
// đi qua toàn bộ gate. Suite này khoá đúng những tuyên bố đã trượt.
//
// Filter là `hidden md:block` ⇒ desktop kiểm THẤY, mobile kiểm ẨN.
// Thiếu credential/chiến dịch của vai trò nào thì skip vai trò đó, không đỏ.
// ─────────────────────────────────────────────────────────────────────────────

const SUPER = { email: process.env.E2E_SUPER_EMAIL, password: process.env.E2E_SUPER_PASSWORD }
const QLCH = { email: process.env.E2E_QLCH_EMAIL, password: process.env.E2E_QLCH_PASSWORD }
const SM = { email: process.env.E2E_SM_EMAIL, password: process.env.E2E_SM_PASSWORD }
const STAFF = { email: process.env.E2E_STAFF_EMAIL, password: process.env.E2E_STAFF_PASSWORD }

const FILTER_FORM = 'form:has(input[name="from"])'
const FILTER_INPUT = 'form input[name="from"]'

// Trang /targets là DANH SÁCH khi store có campaign; detail mở bằng ?campaign=.
// Trả null khi không có chiến dịch nào trong phạm vi → test tự skip thay vì đỏ
// trên môi trường không có dữ liệu.
async function campaignDetailUrl(page: Page): Promise<string | null> {
  await page.goto('/targets')
  const link = page.locator('main a[href*="campaign="]').first()
  if (await link.count() === 0) return null
  return link.getAttribute('href')
}

test.describe('range filter — Super @desktop', () => {
  test.use({ storageState: SUPER_STATE })
  test.skip(!SUPER.email || !SUPER.password, 'E2E_SUPER_* chưa set')

  async function firstCampaign(page: Page): Promise<string | null> {
    await page.goto('/targets/campaigns')
    const link = page.locator('main a[href^="/targets/campaigns/"]').first()
    if (await link.count() === 0) return null
    return link.getAttribute('href')
  }

  test('super detail: đúng MỘT filter, hiện được, và giữ tab=result', async ({ page }) => {
    const href = await firstCampaign(page)
    test.skip(href === null, 'chưa có chiến dịch nào')
    await page.goto(`${href}?tab=result`)

    await expect(page.locator(FILTER_FORM), 'phải có ĐÚNG một bộ lọc').toHaveCount(1)
    await expect(page.locator(FILTER_INPUT)).toBeVisible()
    // Mất hidden input này là bấm "Áp dụng" nhảy về tab Cấu hình.
    await expect(page.locator('form input[type="hidden"][name="tab"]')).toHaveValue('result')
  })

  test('super: khoảng NGOÀI kỳ → nói rõ TOÀN KỲ, KHÔNG tuyên bố đã lọc', async ({ page }) => {
    const href = await firstCampaign(page)
    test.skip(href === null, 'chưa có chiến dịch nào')
    await page.goto(`${href}?tab=result&from=2000-01-01&to=2000-01-05`)

    const body = await page.locator('main').innerText()
    expect(body).toContain('TOÀN KỲ')
    // Một trạng thái duy nhất: không được vừa báo lỗi vừa "Đang xem <khoảng>".
    expect(body, 'không được đồng thời tuyên bố đang xem khoảng đã chọn').not.toContain('Đang xem')
  })
})

test.describe('range filter — QLCH @desktop', () => {
  test.use({ storageState: MANAGER_STATE })
  test.skip(!QLCH.email || !QLCH.password, 'E2E_QLCH_* chưa set')

  test('QLCH detail: ĐÚNG MỘT filter (bản 4b render trùng hai block)', async ({ page }) => {
    const href = await campaignDetailUrl(page)
    test.skip(href === null, 'store chưa có chiến dịch')
    await page.goto(href!)
    await expect(page.locator(FILTER_FORM)).toHaveCount(1)
    await expect(page.locator(FILTER_INPUT)).toBeVisible()
  })
})

test.describe('range filter — SM @desktop', () => {
  test.use({ storageState: SM_STATE })
  test.skip(!SM.email || !SM.password, 'E2E_SM_* chưa set')

  test('SM detail: filter PHẢI hiện (4b bỏ sót trọn nhánh này)', async ({ page }) => {
    const href = await campaignDetailUrl(page)
    test.skip(href === null, 'SM chưa có chiến dịch trong phạm vi')
    await page.goto(href!)
    await expect(page.locator(FILTER_FORM), 'SM phải thấy bộ lọc').toHaveCount(1)
    await expect(page.locator(FILTER_INPUT)).toBeVisible()
    // Chỉ giữ `campaign` — SM r6 đã bỏ ?store=, gắn lại là redirect vòng.
    await expect(page.locator('form input[type="hidden"][name="campaign"]')).toHaveCount(1)
    await expect(page.locator('form input[type="hidden"][name="store"]')).toHaveCount(0)
  })
})

test.describe('range filter — Staff KHÔNG có @desktop', () => {
  test.use({ storageState: STAFF_STATE })
  test.skip(!STAFF.email || !STAFF.password, 'E2E_STAFF_* chưa set')

  test('staff: không thấy filter, và tự gắn ?from/to KHÔNG đổi dữ liệu', async ({ page }) => {
    const href = await campaignDetailUrl(page)
    test.skip(href === null, 'store chưa có chiến dịch')

    await page.goto(href!)
    await expect(page.locator(FILTER_FORM), 'staff không được thấy bộ lọc').toHaveCount(0)
    const before = await page.locator('main').innerText()

    const sep = href!.includes('?') ? '&' : '?'
    await page.goto(`${href}${sep}from=2026-08-01&to=2026-08-02`)
    await expect(page.locator(FILTER_FORM)).toHaveCount(0)
    const after = await page.locator('main').innerText()
    expect(after, 'staff gắn from/to mà số liệu đổi ⇒ gate bị lách').toBe(before)
  })
})

test.describe('range filter ẨN trên mobile @mobile', () => {
  test.use({ storageState: MANAGER_STATE })
  test.skip(!QLCH.email || !QLCH.password, 'E2E_QLCH_* chưa set')

  test('QLCH mobile: bộ lọc không nhìn thấy', async ({ page }) => {
    const href = await campaignDetailUrl(page)
    test.skip(href === null, 'store chưa có chiến dịch')
    await page.goto(href!)
    // `hidden md:block` ⇒ node vẫn trong DOM, nhưng phải KHÔNG hiển thị.
    await expect(page.locator(FILTER_INPUT)).toBeHidden()
  })
})
