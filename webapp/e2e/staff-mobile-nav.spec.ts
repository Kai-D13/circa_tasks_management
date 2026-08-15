import { test, expect, type Page } from '@playwright/test'

// Staff mobile smoke: login → tap all 5 bottom-nav tabs → each navigates,
// marks itself aria-current="page", and the page never scrolls horizontally.
// Requires a STAFF test account via env: E2E_STAFF_EMAIL / E2E_STAFF_PASSWORD
// (optional E2E_BASE_URL, default http://localhost:3000). Without them the
// suite skips instead of failing — safe on CI until the account is provisioned.

const EMAIL = process.env.E2E_STAFF_EMAIL
const PASSWORD = process.env.E2E_STAFF_PASSWORD

// THỨ TỰ là hợp đồng, không phải danh sách: chốt với stakeholder 15/08 —
// Doanh số nằm CHÍNH GIỮA (2 tab thường mỗi bên) vì nó render thành nút tròn
// nổi. Đổi thứ tự ở BottomNav mà quên chỗ này thì assert hrefs dưới đây đỏ.
const TABS = [
  { label: 'Tasks', path: '/tasks' },
  { label: 'Toa thuốc', path: '/prescriptions' },
  { label: 'Doanh số', path: '/targets' }, // ← nút giữa nổi
  { label: 'Bảng tin', path: '/announcements' },
  { label: 'Tồn kho', path: '/inventory' },
]

const CENTER = TABS[2]
const CENTER_SELECTOR = '[data-testid="bottom-nav-center"]'

// Vùng cuộn của app là <main> (overflow-y-auto trong khung h-[100dvh]), KHÔNG
// phải window — cuộn window ở đây không nhúc nhích gì.
async function scrollMainToBottom(page: Page) {
  await page.evaluate(() => {
    const main = document.querySelector('main')
    if (main) main.scrollTop = main.scrollHeight
  })
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
}

// Nút giữa NHÔ lên khỏi pill ⇒ chính nó, chứ không phải mép trên pill, mới là
// ranh giới che nội dung. Đo sau khi đã cuộn hết xuống (phần tử cuối lúc đó ở
// vị trí thấp nhất): mép trên nút phải nằm DƯỚI đáy phần tử cuối.
async function centerGeometry(page: Page) {
  return page.evaluate((sel) => {
    const main = document.querySelector('main')
    const btn = document.querySelector(sel)
    if (!main || !btn) return null
    const last = [...main.children].filter((el) => el.getBoundingClientRect().height > 0).pop()
    if (!last) return null
    const b = btn.getBoundingClientRect()
    const l = last.getBoundingClientRect()
    return {
      width: b.width,
      height: b.height,
      top: b.top,
      lastBottom: l.bottom,
      lastDesc: `${last.tagName.toLowerCase()}.${(last.className || '').toString().split(' ').slice(0, 3).join('.')}`,
    }
  }, CENTER_SELECTOR)
}

test.describe('staff bottom nav @mobile', () => {
  test.skip(!EMAIL || !PASSWORD, 'E2E_STAFF_EMAIL / E2E_STAFF_PASSWORD not set')

  test('5 tabs navigate, mark active, no horizontal overflow', async ({ page }) => {
    await page.goto('/login')
    await page.fill('#email', EMAIL!)
    await page.fill('#password', PASSWORD!)
    await page.getByRole('button', { name: /sign in/i }).click()
    await page.waitForURL(/\/(tasks|dashboard|targets)/, { timeout: 20_000 })

    const nav = page.getByRole('navigation', { name: 'Điều hướng chính' })
    await expect(nav).toBeVisible()
    // Staff must NOT have a "Thêm" overflow button (5 direct tabs).
    await expect(nav.getByRole('button', { name: 'Thêm' })).toHaveCount(0)

    // Thứ tự tab khoá bằng href (badge Tasks/Bảng tin chèn số vào textContent
    // nên so text sẽ giòn; href thì không).
    const hrefs = await nav.getByRole('link').evaluateAll((els) => els.map((el) => el.getAttribute('href')))
    expect(hrefs).toEqual(TABS.map((t) => t.path))

    // Nút giữa: đúng là link /targets và thật sự render dạng nút tròn.
    const centerLink = nav.getByRole('link', { name: CENTER.label })
    await expect(centerLink).toHaveAttribute('href', CENTER.path)
    await expect(centerLink.locator(CENTER_SELECTOR)).toBeVisible()

    for (const tab of TABS) {
      // force: true — in `next dev` the dev-tools portal (<nextjs-portal>) floats
      // over the bottom-left, intercepting clicks on the first tab. It doesn't
      // exist in production, so a forced click reflects the real prod behaviour.
      await nav.getByRole('link', { name: tab.label }).click({ force: true })
      await page.waitForURL(`**${tab.path}**`)
      await expect(nav.getByRole('link', { name: tab.label })).toHaveAttribute('aria-current', 'page')
      const noOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      )
      expect(noOverflow, `horizontal overflow on ${tab.path}`).toBe(true)

      // Phần nhô của nút giữa ăn vào khoảng thở của --bottom-nav-clearance —
      // kiểm trên MỌI route, không riêng /targets.
      await scrollMainToBottom(page)
      const geom = await centerGeometry(page)
      expect(geom, `${tab.path}: không đo được nút giữa (thiếu <main> hoặc nút)`).not.toBeNull()
      expect(geom!.width, `${tab.path}: nút giữa rộng ${geom!.width}px`).toBeGreaterThanOrEqual(56)
      expect(geom!.height, `${tab.path}: nút giữa cao ${geom!.height}px`).toBeGreaterThanOrEqual(56)
      expect(
        geom!.lastBottom,
        `${tab.path}: nút giữa (mép trên ${geom!.top}px) che phần tử cuối ${geom!.lastDesc} (đáy ${geom!.lastBottom}px)`,
      ).toBeLessThanOrEqual(geom!.top)
    }
  })
})
