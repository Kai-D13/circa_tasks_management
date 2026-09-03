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

// Áp NỬA ĐẦU kỳ rồi bỏ lọc, và đòi màn hình quay lại ĐÚNG TỪNG KÝ TỰ snapshot
// toàn kỳ. Đây là bất biến không phụ thuộc dữ liệu (khác với "số phải đổi" —
// một range phủ hết dữ liệu hiện có thì số KHÔNG đổi mới là đúng), nên nó bắt
// được cả rò rỉ trạng thái lẫn việc bỏ lọc mà vẫn giữ số đã lọc.
// `page.goto` chỉ chờ sự kiện load — Next vẫn có thể đang chuyển route, và
// `main.innerText()` lúc đó trả CHUỖI RỖNG. Bản trước so snapshot với chuỗi
// rỗng đó rồi đỏ, trong khi ảnh chụp lỗi lại hiện đúng nội dung mong đợi: lỗi
// TIMING của test, không phải lỗi UI. Mọi lần đọc `main` ở đây đều phải đi sau
// một NEO NGỮ NGHĨA — thứ chỉ tồn tại khi nội dung thật đã render.
async function mainTextWhenReady(page: Page, opts: { ranged: boolean }): Promise<string> {
  // Neo = CHÍNH NỘI DUNG đã render, không phải một element cụ thể. Thử neo vào
  // ô lọc thì đỏ kiểu khác: element đã có trong DOM nhưng lớp `hidden md:block`
  // chưa áp xong nên Playwright thấy "hidden". Đo độ dài text của `main` là
  // điều kiện đúng với thứ ta sắp đọc, và đúng cho MỌI vai trò/breakpoint.
  await expect.poll(
    async () => (await page.locator('main').innerText()).trim().length,
    { message: 'main vẫn rỗng — trang chưa render xong' },
  ).toBeGreaterThan(50)
  if (opts.ranged) {
    await expect(page.getByText('Đang xem', { exact: false }).first()).toBeVisible()
  } else {
    // Toàn kỳ: đợi dòng trạng thái khoảng BIẾN MẤT hẳn rồi mới chụp.
    await expect(page.getByText('Đang xem', { exact: false })).toHaveCount(0)
  }
  // Chuẩn hoá phần BIẾN THIÊN THEO THỜI GIAN trước khi so: text có mốc "Đồng bộ
  // 09:45 03/09/2026" do cron KPI ghi. Suite chạy ~2 phút nên một tick cron có
  // thể rơi vào giữa hai lần đọc và làm round-trip đỏ vì lý do không liên quan
  // (chạy lẻ luôn xanh, chỉ full-suite mới dính).
  const raw = await page.locator('main').innerText()
  return raw
    .replace(/\d{2}:\d{2} \d{2}\/\d{2}\/\d{4}/g, '<TS>')
    .replace(/\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/g, '<TS>')
}

async function expectRangeRoundTrip(page: Page, url: string) {
  await page.goto(url)
  const full = await mainTextWhenReady(page, { ranged: false })
  expect(full.trim().length, 'đọc được main rỗng ⇒ neo chờ chưa đủ').toBeGreaterThan(0)
  // Đọc min/max SAU neo chờ: đọc ngay sau goto thì thanh lọc của trang CŨ và
  // trang MỚI có thể cùng nằm trong DOM giữa lúc Next chuyển route → strict
  // mode nổ (2 element trùng hệt nhau). Hai ô luôn mang cùng min/max nên
  // .first() là đủ và không che giấu điều gì.
  const from = await page.locator('input[name="from"]').first().getAttribute('min')
  const to = await page.locator('input[name="to"]').first().getAttribute('max')
  expect(from, 'input from phải có min = ngày bắt đầu campaign').toBeTruthy()

  const d0 = Date.parse(`${from}T00:00:00Z`)
  const mid = new Date(d0 + Math.floor((Date.parse(`${to}T00:00:00Z`) - d0) / 2))
    .toISOString().slice(0, 10)
  const sep = url.includes('?') ? '&' : '?'
  await page.goto(`${url}${sep}from=${from}&to=${mid}`)

  const ranged = await mainTextWhenReady(page, { ranged: true })
  // Câu này là CAM KẾT với người xem: lọc không được đụng tới thưởng.
  expect(ranged).toContain('Mục tiêu, bậc thưởng và commission vẫn tính theo TOÀN KỲ')

  await page.goto(url)
  expect(await mainTextWhenReady(page, { ranged: false }),
    'bỏ lọc phải trả về đúng snapshot toàn kỳ').toBe(full)
}

// Trang /targets là DANH SÁCH khi store có campaign; detail mở bằng ?campaign=.
// Trả null khi không có chiến dịch nào trong phạm vi → test tự skip thay vì đỏ
// trên môi trường không có dữ liệu.
async function campaignDetailUrl(page: Page): Promise<string | null> {
  await page.goto('/targets')
  // count() KHÔNG chờ: một nhịp render chậm là ra 0 và test tự skip — mất
  // coverage trong khi báo cáo vẫn xanh. Chờ tường minh rồi mới kết luận.
  const link = page.locator('main a[href*="campaign="]').first()
  const found = await link.waitFor({ state: 'attached', timeout: 15_000 })
    .then(() => true).catch(() => false)
  return found ? link.getAttribute('href') : null
}

test.describe('range filter — Super @desktop', () => {
  test.use({ storageState: SUPER_STATE })
  test.skip(!SUPER.email || !SUPER.password, 'E2E_SUPER_* chưa set')

  // `/targets/campaigns/new` (nút Tạo) và `/affiliate` cũng khớp tiền tố — lấy
  // nhầm nút Tạo thì test đi lạc sang wizard và đỏ vì lý do vô nghĩa.
  async function firstCampaign(page: Page): Promise<string | null> {
    await page.goto('/targets/campaigns')
    // evaluateAll trên locator rỗng trả [] mà không chờ — xem ghi chú ở
    // campaign-order-aov-ui.spec.ts (đã gây skip ngẫu nhiên ở đó).
    await page.locator('main a[href^="/targets/campaigns/"]').first()
      .waitFor({ state: 'attached', timeout: 15_000 })
    const hrefs = await page.locator('main a[href^="/targets/campaigns/"]').evaluateAll(
      (as) => as.map((a) => a.getAttribute('href') ?? ''),
    )
    return hrefs.find((h) => /^\/targets\/campaigns\/[0-9a-f-]{36}$/.test(h)) ?? null
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

    // Cùng bẫy timing: đọc `main` ngay sau goto có thể ra chuỗi rỗng.
    await expect.poll(
      async () => (await page.locator('main').innerText()).trim().length,
      { message: 'main vẫn rỗng — trang chưa render xong' },
    ).toBeGreaterThan(50)
    const body = await page.locator('main').innerText()
    expect(body).toContain('TOÀN KỲ')
    // Một trạng thái duy nhất: không được vừa báo lỗi vừa "Đang xem <khoảng>".
    expect(body, 'không được đồng thời tuyên bố đang xem khoảng đã chọn').not.toContain('Đang xem')
  })

  test('super: áp khoảng rồi bỏ lọc → trả đúng snapshot toàn kỳ', async ({ page }) => {
    const href = await firstCampaign(page)
    test.skip(href === null, 'chưa có chiến dịch nào')
    await expectRangeRoundTrip(page, `${href}?tab=result`)
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

  test('QLCH: áp khoảng rồi bỏ lọc → trả đúng snapshot toàn kỳ', async ({ page }) => {
    const href = await campaignDetailUrl(page)
    test.skip(href === null, 'store chưa có chiến dịch')
    await expectRangeRoundTrip(page, href!)
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

  test('SM: áp khoảng rồi bỏ lọc → trả đúng snapshot toàn kỳ', async ({ page }) => {
    const href = await campaignDetailUrl(page)
    test.skip(href === null, 'SM chưa có chiến dịch trong phạm vi')
    await expectRangeRoundTrip(page, href!)
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
    await expect.poll(async () => (await page.locator('main').innerText()).trim().length)
      .toBeGreaterThan(50)
    const before = await page.locator('main').innerText()

    const sep = href!.includes('?') ? '&' : '?'
    await page.goto(`${href}${sep}from=2026-08-01&to=2026-08-02`)
    await expect(page.locator(FILTER_FORM)).toHaveCount(0)
    await expect.poll(async () => (await page.locator('main').innerText()).trim().length)
      .toBeGreaterThan(50)
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
    // Tách ĐẾM khỏi ẨN. `toBeHidden()` trên locator khớp 2 phần tử ném lỗi
    // strict-mode NGAY, không retry — nên một lượt double-render thoáng qua
    // giữa hai segment khi điều hướng cũng làm đỏ với thông báo sai bản chất.
    // `toHaveCount` có retry: duplicate THẬT vẫn đỏ, thoáng qua thì tự ổn định.
    await expect(page.locator(FILTER_INPUT), 'bộ lọc bị render trùng').toHaveCount(1)
    // `hidden md:block` ⇒ node vẫn trong DOM, nhưng phải KHÔNG hiển thị.
    await expect(page.locator(FILTER_INPUT).first()).toBeHidden()
  })
})
