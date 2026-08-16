import { test, expect, type Page } from '@playwright/test'
import { MANAGER_STATE, STAFF_STATE } from './authState'

// ─────────────────────────────────────────────────────────────────────────────
// CAMPAIGN DETAIL MOBILE (Step 4) — hợp đồng RUNTIME
//
// Hero trước đây vẽ ĐỒNG THỜI ring, thanh tiến độ và số phần trăm — ba lần cùng
// một tỉ lệ, riêng ring ăn ~92px bề ngang ở màn 360px. Dưới `md` giờ chỉ còn
// một thanh + một con số; từ `md` trở lên giữ nguyên ring đã duyệt.
//
// Khối chart dùng khung tỉ lệ cố định (aspect 360/170) nên đổi chuỗi Số đơn/AOV
// hay rơi vào trạng thái rỗng đều KHÔNG làm phần dưới nhảy.
//
// Suite chạy cho CẢ Staff và QLCH: hai vai trò đi hai nhánh render khác nhau
// (targets/page.tsx:616 vs :747) nhưng dùng chung CampaignKpiView.
//
// PHỤ THUỘC DỮ LIỆU: cửa hàng phải có ít nhất một chiến dịch đang chạy. Không
// có thì skip — nêu rõ lý do thay vì đỏ vì chuyện vận hành.
// ─────────────────────────────────────────────────────────────────────────────

const STAFF = { email: process.env.E2E_STAFF_EMAIL, password: process.env.E2E_STAFF_PASSWORD }
const QLCH = { email: process.env.E2E_QLCH_EMAIL, password: process.env.E2E_QLCH_PASSWORD }

const RING = 'svg circle[stroke-dasharray]'          // vòng tròn tiến độ của hero
const HERO_BAR = '[data-hero-progress]'

// Mở chiến dịch đầu tiên trong danh sách. Trả về false nếu store không có
// chiến dịch nào (caller skip).
async function openFirstCampaign(page: Page): Promise<boolean> {
  await page.goto('/targets')
  await expect(page, 'bị đẩy về /login ⇒ storageState hết hạn (xoá e2e/.auth rồi chạy lại)')
    .toHaveURL(/\/targets(\?|$)/)

  // Đã ở sẵn detail (store chỉ có 1 chiến dịch) thì không cần bấm.
  if (/[?&]campaign=/.test(page.url())) return true
  const first = page.locator('main a[href*="campaign="]').first()
  if (await first.count() === 0) return false
  // Card có thể nằm dưới fold ở 360px, và điều hướng là server-render nên chậm
  // hơn ngưỡng mặc định 5s khi chạy tuần tự nhiều vai trò. Cuộn tới + chờ rộng
  // tay thay vì để test đỏ vì tốc độ máy.
  await first.scrollIntoViewIfNeeded()
  await expect(first).toBeVisible()
  await first.click()
  await expect(page).toHaveURL(/[?&]campaign=/, { timeout: 20_000 })
  return true
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow, `trang cuộn ngang ${overflow}px`).toBeLessThanOrEqual(1)
}

function mobileSuite(label: string, state: string, creds: { email?: string; password?: string }) {
  test.describe(`campaign detail ${label} @mobile`, () => {
    test.use({ storageState: state, viewport: { width: 360, height: 800 } })
    test.skip(!creds.email || !creds.password, `credential ${label} chưa set`)

    test('hero: ring ẨN dưới md, chỉ còn MỘT thanh tiến độ', async ({ page }) => {
      test.skip(!(await openFirstCampaign(page)), 'store chưa có chiến dịch nào')

      // Ring vẫn nằm trong DOM (ẩn bằng md:block) nhưng KHÔNG được nhìn thấy —
      // đó mới là thứ chiếm chỗ trên màn 360px.
      const ring = page.locator(RING).first()
      if (await ring.count() > 0) await expect(ring, 'ring vẫn hiện trên mobile').toBeHidden()

      await expect(page.locator(HERO_BAR), 'phải có ĐÚNG một thanh tiến độ ở hero').toHaveCount(1)
      await noHorizontalOverflow(page)
    })

    test('không có cuộn ngang và nội dung cuối không bị bottom nav che', async ({ page }) => {
      test.skip(!(await openFirstCampaign(page)), 'store chưa có chiến dịch nào')
      await noHorizontalOverflow(page)

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
        expect(geom.lastBottom, 'phần tử cuối bị vùng nút giữa của bottom nav che').toBeLessThanOrEqual(geom.zoneTop)
      }
    })

    test('URL contract: đổi series giữ nguyên campaign; back về danh sách', async ({ page }) => {
      test.skip(!(await openFirstCampaign(page)), 'store chưa có chiến dịch nào')
      const campaignId = new URL(page.url()).searchParams.get('campaign')

      const aov = page.getByRole('tab', { name: 'AOV' })
      if (await aov.count() > 0) {
        // Chỉ campaign Chất lượng bán hàng mới có segmented.
        const before = await chartBox(page)
        await aov.click()
        await expect(page).toHaveURL(/series=aov/)
        expect(
          new URL(page.url()).searchParams.get('campaign'),
          'đổi series làm MẤT campaign khỏi URL',
        ).toBe(campaignId)

        // Khung tỉ lệ cố định ⇒ đổi chuỗi không được làm chart đổi chiều cao.
        const after = await chartBox(page)
        if (before && after) {
          expect(Math.abs(after.height - before.height), 'chart đổi chiều cao khi đổi series').toBeLessThanOrEqual(1)
        }
      }

      await page.getByRole('link', { name: /Danh sách chiến dịch/ }).click()
      await expect(page).not.toHaveURL(/[?&]campaign=/)
    })
  })
}

async function chartBox(page: Page) {
  const el = page.locator('svg[role="img"]').first()
  if (await el.count() === 0) return null
  return el.boundingBox()
}

mobileSuite('Staff', STAFF_STATE, STAFF)
mobileSuite('QLCH', MANAGER_STATE, QLCH)

test.describe('campaign detail desktop giữ nguyên @desktop', () => {
  test.use({ storageState: STAFF_STATE })
  test.skip(!STAFF.email || !STAFF.password, 'E2E_STAFF_* chưa set')

  test('desktop: ring VẪN hiện (hình thức đã duyệt không đổi)', async ({ page }) => {
    test.skip(!(await openFirstCampaign(page)), 'store chưa có chiến dịch nào')
    const ring = page.locator(RING).first()
    await expect(ring, 'ring biến mất trên desktop — đã đổi hình thức đã duyệt').toBeVisible()
  })
})
