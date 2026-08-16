import { test, expect, type Page } from '@playwright/test'
import { MANAGER_STATE, STAFF_STATE } from './authState'

// ─────────────────────────────────────────────────────────────────────────────
// CAMPAIGN DETAIL MOBILE (Step 4) — hợp đồng RUNTIME
//
// Hero trước đây vẽ ĐỒNG THỜI ring, thanh tiến độ và số phần trăm — ba lần cùng
// một tỉ lệ, riêng ring ăn ~92px bề ngang ở màn 360px. Dưới `md` giờ chỉ còn
// một thanh + một con số; từ `md` trở lên giữ nguyên ring đã duyệt.
//
// Khối chart dùng khung tỉ lệ cố định (aspect 360/170) nên chart, empty và error
// chiếm y hệt một chiều cao — đổi chuỗi hay mất dữ liệu không làm phần dưới nhảy.
//
// ── VIEWPORT LÀ CỦA TEST, KHÔNG PHẢI CỦA PROJECT ────────────────────────────
// Bản đầu đặt cứng `viewport: 360×800` trong một describe duy nhất, nên project
// `mobile-390` cũng chạy ở 360 — bằng chứng ghi "360/390" là SAI. Giờ mỗi bề
// ngang là một describe riêng với `test.use` của chính nó, và chạy đủ ba mốc
// máy staff đang dùng: 360 · 390 · 430.
//
// Suite chạy cho CẢ Staff và QLCH: hai vai trò đi hai nhánh render khác nhau
// (targets/page.tsx:616 vs :747) nhưng dùng chung CampaignKpiView.
//
// PHỤ THUỘC DỮ LIỆU: cửa hàng phải có ít nhất một chiến dịch đang chạy. Không
// có thì skip — nêu rõ lý do thay vì đỏ vì chuyện vận hành.
// ─────────────────────────────────────────────────────────────────────────────

const STAFF = { email: process.env.E2E_STAFF_EMAIL, password: process.env.E2E_STAFF_PASSWORD }
const QLCH = { email: process.env.E2E_QLCH_EMAIL, password: process.env.E2E_QLCH_PASSWORD }

const RING = 'svg circle[stroke-dasharray]'   // vòng tròn tiến độ của hero
const HERO_BAR = '[data-hero-progress]'
const CHART_FRAME = '[data-chart-frame]'

// Ba bề ngang thật của máy staff (cùng bộ với ui-mobile-baseline).
// Viewport do TEST đặt, nên chạy dưới hai project mobile là làm y hệt một việc
// hai lần. Mỗi lần render /targets là một loạt query xuống DB thật ⇒ nhân đôi
// tải và đã làm cả suite vượt timeout 60s. Chốt một project, đúng pattern
// CAPTURE_PROJECT của ui-mobile-baseline.
const RUN_PROJECT = 'mobile-390'

const VIEWPORTS = [
  { w: 360, h: 800 },
  { w: 390, h: 844 },
  { w: 430, h: 932 },
] as const

async function gotoTargets(page: Page) {
  await page.goto('/targets')
  await expect(page, 'bị đẩy về /login ⇒ storageState hết hạn (xoá e2e/.auth rồi chạy lại)')
    .toHaveURL(/\/targets(\?|$)/)
}

// ĐẾN được trang chi tiết — dùng cho các test KHÔNG nhằm kiểm cú bấm.
// Đi thẳng bằng goto thay vì click: card nằm trong vùng cuộn, bottom nav nổi
// che mép dưới, và layout còn xê dịch sau khi cuộn ⇒ cú click trong phần SETUP
// từng đỏ ngẫu nhiên ở một viewport khác nhau mỗi lượt. Href vẫn được đọc từ
// DOM thật nên vẫn khoá được "card trỏ đúng ?campaign=".
// false = store không có chiến dịch nào (caller skip).
async function openFirstCampaign(page: Page): Promise<boolean> {
  await gotoTargets(page)
  if (/[?&]campaign=/.test(page.url())) return true   // store chỉ có 1 chiến dịch
  const first = page.locator('main a[href*="campaign="]').first()
  if (await first.count() === 0) return false
  const href = await first.getAttribute('href')
  expect(href, 'card chiến dịch thiếu href').toBeTruthy()
  await page.goto(href!)
  await expect(page).toHaveURL(/[?&]campaign=/, { timeout: 20_000 })
  return true
}

// BẤM THẬT vào card — chỉ dùng cho test hành trình list → detail. Cuộn vào GIỮA
// màn (scrollIntoViewIfNeeded đưa phần tử vào ở mức tối thiểu, tức sát mép dưới
// đúng chỗ bottom nav nổi chiếm) rồi đợi layout đứng yên trước khi bấm.
async function clickFirstCampaign(page: Page): Promise<boolean> {
  await gotoTargets(page)
  // Store chỉ có MỘT chiến dịch thì /targets render thẳng trang chi tiết (có
  // link "← Danh sách chiến dịch"), KHÔNG có danh sách để bấm — hành trình
  // list → detail đơn giản là không tồn tại, phải skip chứ không phải cố bấm.
  // Bản trước không kiểm điều này nên vớ phải link trong CampaignPicker và đỏ
  // ngẫu nhiên; triệu chứng "URL không đổi" hoàn toàn đánh lạc hướng.
  if (await page.getByRole('link', { name: /Danh sách chiến dịch/ }).count() > 0) return false
  const first = page.locator('main a[href*="campaign="]').first()
  if (await first.count() === 0) return false
  // Cả cụm cuộn → bấm → điều hướng được RETRY như một khối (idiom sẵn có ở
  // ui-catalog.spec cho login): cú bấm đầu thỉnh thoảng rơi vào lúc layout còn
  // xê dịch nên không điều hướng. Bấm lại là xong; điều đang kiểm là "card dẫn
  // sang detail được", không phải "trúng ngay phát đầu".
  await expect(async () => {
    await first.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    await expect(first).toBeVisible()
    await first.click()
    await expect(page).toHaveURL(/[?&]campaign=/, { timeout: 10_000 })
  }).toPass({ timeout: 45_000, intervals: [1_000, 2_000, 3_000] })
  return true
}

// Tìm chiến dịch CHẤT LƯỢNG BÁN HÀNG (loại duy nhất có segmented Số đơn/AOV).
// Trả null nếu store không có loại này — caller phải skip TƯỜNG MINH chứ không
// được lặng lẽ bỏ qua assert rồi báo PASS.
async function openOrderAovCampaign(page: Page): Promise<string | null> {
  await gotoTargets(page)
  const hrefs = await page.locator('main a[href*="campaign="]')
    .evaluateAll((els) => els.map((el) => (el as HTMLAnchorElement).getAttribute('href')!))
  const candidates = hrefs.length > 0 ? hrefs : (/[?&]campaign=/.test(page.url()) ? [page.url()] : [])
  for (const href of candidates) {
    await page.goto(href)
    if (await page.getByRole('tab', { name: 'AOV' }).count() > 0) return page.url()
  }
  return null
}

async function noHorizontalOverflow(page: Page, where: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow, `${where}: trang cuộn ngang ${overflow}px`).toBeLessThanOrEqual(1)
}

function mobileSuite(label: string, state: string, creds: { email?: string; password?: string }) {
  for (const vp of VIEWPORTS) {
    test.describe(`campaign detail ${label} ${vp.w} @mobile`, () => {
      test.use({ storageState: state, viewport: { width: vp.w, height: vp.h } })
      test.skip(!creds.email || !creds.password, `credential ${label} chưa set`)

      test.beforeEach(async ({}, testInfo) => {
        testInfo.skip(testInfo.project.name !== RUN_PROJECT, `chỉ chạy dưới project ${RUN_PROJECT}`)
        // Trang detail render phía server + đọc DB thật; 60s mặc định là chật
        // khi chạy tuần tự 2 vai trò × 3 viewport.
        testInfo.setTimeout(120_000)
      })

      test(`hero: ring ẨN, đúng MỘT thanh tiến độ @${vp.w}`, async ({ page }) => {
        test.skip(!(await openFirstCampaign(page)), 'store chưa có chiến dịch nào')

        // Ring vẫn nằm trong DOM (ẩn bằng md:block) nhưng KHÔNG được nhìn thấy —
        // đó mới là thứ chiếm chỗ trên màn hẹp.
        const ring = page.locator(RING).first()
        if (await ring.count() > 0) await expect(ring, `@${vp.w}: ring vẫn hiện trên mobile`).toBeHidden()

        await expect(page.locator(HERO_BAR), 'phải có ĐÚNG một thanh tiến độ ở hero').toHaveCount(1)
        await noHorizontalOverflow(page, `hero @${vp.w}`)
      })

      test(`nội dung cuối không bị bottom nav che @${vp.w}`, async ({ page }) => {
        test.skip(!(await openFirstCampaign(page)), 'store chưa có chiến dịch nào')
        await noHorizontalOverflow(page, `detail @${vp.w}`)

        await page.evaluate(() => {
          const main = document.querySelector('main')
          if (main) main.scrollTop = main.scrollHeight
        })
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

        const geom = await page.evaluate((zoneSel) => {
          const main = document.querySelector('main')
          const zone = document.querySelector(zoneSel)
          if (!main || !zone) return null
          const last = [...main.children].filter((el) => el.getBoundingClientRect().height > 0).pop()
          if (!last) return null
          return { lastBottom: last.getBoundingClientRect().bottom, zoneTop: zone.getBoundingClientRect().top }
        }, '[data-nav-center-zone]')

        if (geom) {
          expect(geom.lastBottom, `@${vp.w}: phần tử cuối bị vùng nút giữa của bottom nav che`)
            .toBeLessThanOrEqual(geom.zoneTop)
        }
      })

      // Hành trình THẬT: bấm card ở danh sách → detail → back về danh sách.
      test(`list → detail → back @${vp.w}`, async ({ page }) => {
        test.skip(!(await clickFirstCampaign(page)), 'store không có DANH SÁCH chiến dịch để bấm (0 hoặc chỉ 1 chiến dịch)')
        await page.getByRole('link', { name: /Danh sách chiến dịch/ }).click()
        // Cùng lý do với openFirstCampaign: điều hướng là server-render, chạy
        // tuần tự 2 vai trò × 3 viewport thì vượt ngưỡng mặc định 5s. Đã đỏ một
        // lần ở đúng 390 chỉ vì lượt đó chậm hơn, không phải vì bề ngang.
        await expect(page).not.toHaveURL(/[?&]campaign=/, { timeout: 20_000 })
      })

      // TÁCH RIÊNG (audit P2): trước đây phần này nằm trong `if (aov.count() > 0)`
      // nên campaign không phải Chất lượng bán hàng thì toàn bộ contract
      // `series=aov` + chiều cao chart bị bỏ qua mà test vẫn báo PASS.
      // Giờ nếu store không có loại đó thì SKIP tường minh, đọc report thấy ngay.
      test(`Order/AOV: đổi series giữ campaign, chart không đổi chiều cao @${vp.w}`, async ({ page }) => {
        const url = await openOrderAovCampaign(page)
        test.skip(url === null, 'store không có chiến dịch Chất lượng bán hàng (không có segmented Số đơn/AOV)')

        const campaignId = new URL(url!).searchParams.get('campaign')
        // Đo KHUNG chart chứ không đo svg: khung mới là thứ giữ chỗ cho cả
        // trạng thái rỗng/lỗi, và cũng là thứ quyết định phần dưới có nhảy không.
        const before = await page.locator(CHART_FRAME).first().boundingBox()

        await page.getByRole('tab', { name: 'AOV' }).click()
        await expect(page).toHaveURL(/series=aov/)
        expect(
          new URL(page.url()).searchParams.get('campaign'),
          'đổi series làm MẤT campaign khỏi URL',
        ).toBe(campaignId)

        const after = await page.locator(CHART_FRAME).first().boundingBox()
        expect(before, 'không đo được khung chart trước khi đổi series').not.toBeNull()
        expect(after, 'không đo được khung chart sau khi đổi series').not.toBeNull()
        expect(
          Math.abs(after!.height - before!.height),
          `@${vp.w}: khung chart đổi chiều cao khi đổi series (${before!.height} → ${after!.height})`,
        ).toBeLessThanOrEqual(1)

        await noHorizontalOverflow(page, `chart aov @${vp.w}`)
      })
    })
  }
}

mobileSuite('Staff', STAFF_STATE, STAFF)
mobileSuite('QLCH', MANAGER_STATE, QLCH)

test.describe('campaign detail desktop giữ nguyên @desktop', () => {
  test.use({ storageState: STAFF_STATE })
  test.skip(!STAFF.email || !STAFF.password, 'E2E_STAFF_* chưa set')

  test('desktop: ring VẪN hiện (hình thức đã duyệt không đổi)', async ({ page }) => {
    test.skip(!(await openFirstCampaign(page)), 'store chưa có chiến dịch nào')
    await expect(
      page.locator(RING).first(),
      'ring biến mất trên desktop — đã đổi hình thức đã duyệt',
    ).toBeVisible()
  })
})
