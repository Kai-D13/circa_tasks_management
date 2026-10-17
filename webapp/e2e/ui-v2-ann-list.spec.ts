import fs from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import { MANAGER_STATE, SM_STATE, STAFF_STATE, SUPER_STATE } from './authState'
import { announcementTimeGroup } from '../lib/announcements/feed'

// UI v2 Phase 3 · Bảng tin — A1 danh sách /announcements (artboard B1 admin / M1–M3 dược sĩ).
// Hai lớp: (1) fixture /ui-catalog/announcements-v2?fx=list-* render ĐÚNG AnnouncementsListView ⇒ khẳng định chặt từng
// trạng thái + ảnh commit được; (2) route thật theo vai, chỉ đọc, khẳng định CẤU TRÚC không phụ thuộc nội dung tin:
// gốc v2 + centered; nút Tạo chỉ admin; dòng "N tin mới trong danh sách" CHỈ khi truy vấn đọc thành công và N = số thẻ
// chưa đọc; admin không bao giờ có "Mới"; thứ tự published_at giảm dần + nhóm đúng ngày VN; ≤ 100 thẻ; href chi tiết.

const ROOT = 'ui-catalog-ann-v2'
const THEMES = ['light', 'dark'] as const
const UUID_HREF = /^\/announcements\/[0-9a-f-]{36}$/

async function openFx(page: Page, fx: string, theme: (typeof THEMES)[number] = 'light') {
  await page.goto(`/ui-catalog/announcements-v2?fx=${fx}`)
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
  await expect(page.getByTestId(ROOT)).toHaveAttribute('data-fx', fx, { timeout: 20_000 })
  await page.evaluate(() => document.fonts.ready)
}
const view = (page: Page) => page.locator('main [data-ann-list]')

async function noPageOverflow(page: Page) {
  const g = await page.evaluate(() => {
    const m = document.querySelector('main')!
    return { sw: document.documentElement.scrollWidth, iw: window.innerWidth, msw: m.scrollWidth, mcw: m.clientWidth }
  })
  expect(g.sw, 'trang cuộn ngang').toBeLessThanOrEqual(g.iw + 1)
  expect(g.msw, '<main> cuộn ngang').toBeLessThanOrEqual(g.mcw + 1)
}

async function openRoute(page: Page) {
  await page.goto('/announcements')
  expect(new URL(page.url()).pathname, 'bị đẩy khỏi /announcements (phiên/mạng lỗi?)').toBe('/announcements')
  await expect(view(page)).toBeVisible({ timeout: 30_000 })
  await expect(view(page)).toHaveAttribute('data-ui-v2', 'page')
}

/** Khẳng định chung cho route thật: centered, thứ tự giảm dần, nhóm đúng ngày VN, href chi tiết, ≤ 100 thẻ. */
async function assertRouteStructure(page: Page, who: string) {
  const v = view(page)
  await expect(v).toHaveAttribute('data-layout-width', 'centered')
  await expect(v).toHaveClass(/\bmax-w-3xl\b/)
  await expect(v).toHaveClass(/\bmx-auto\b/)
  await expect(v.locator('h1')).toHaveText('Bảng tin')
  const cards = await v.locator('[data-ann-card]').evaluateAll((els) => els.map((e) => ({
    href: e.getAttribute('href'),
    at: e.getAttribute('data-published-at')!,
    group: e.closest('[data-ann-group]')?.getAttribute('data-ann-group') ?? null,
  })))
  expect(cards.length, `${who}: tài khoản QA phải thấy ít nhất 1 tin`).toBeGreaterThan(0)
  expect(cards.length, `${who}: cap 100 tin`).toBeLessThanOrEqual(100)
  const now = Date.now()
  for (const [i, c] of cards.entries()) {
    expect(c.href, `${who}: href thẻ ${i}`).toMatch(UUID_HREF)
    expect(c.group, `${who}: nhóm thẻ ${i} (${c.at})`).toBe(announcementTimeGroup(c.at, now))
    if (i > 0) expect(Date.parse(c.at), `${who}: thứ tự published_at giảm dần tại thẻ ${i}`).toBeLessThanOrEqual(Date.parse(cards[i - 1].at))
  }
  const groupOrder = await v.locator('[data-ann-group]').evaluateAll((els) => els.map((e) => e.getAttribute('data-ann-group')))
  expect(groupOrder, `${who}: thứ tự nhóm`).toEqual(['today', 'week', 'earlier'].filter((k) => groupOrder.includes(k)))
}

/** Vai không phải admin: theo dõi đọc hợp lệ ⇒ đếm = số thẻ chưa đọc; đọc lỗi ⇒ Notice, không đếm, không "Mới". */
async function assertReadState(page: Page, who: string) {
  const v = view(page)
  await expect(v.getByRole('link', { name: /Tạo thông báo/ }), `${who}: không được có nút Tạo`).toHaveCount(0)
  const mode = await v.getAttribute('data-ann-list')
  expect(['tracked', 'error'], `${who}: chế độ đọc lạ ${mode}`).toContain(mode)
  test.info().annotations.push({ type: 'nhánh', description: `${who}: đọc = ${mode}` })
  if (mode === 'tracked') {
    await expect(v.locator('[data-ann-state="read-error"]')).toHaveCount(0)
    await expect(v.locator('[data-read="untracked"]'), `${who}: theo dõi đọc thì mọi thẻ phải read/unread`).toHaveCount(0)
    const n = await v.locator('[data-read="unread"]').count()
    test.info().annotations.push({ type: 'nhánh', description: `${who}: ${n} tin chưa đọc trong danh sách` })
    if (n > 0) await expect(v.locator('[data-ann-unread-count]')).toHaveText(`${n} tin mới trong danh sách`)
    else await expect(v.locator('[data-ann-unread-count]')).toHaveCount(0)
    await expect(v.locator('[data-read="unread"] [data-ann-unread-dot]')).toHaveCount(n)
  } else {
    await expect(v.locator('[data-ann-state="read-error"]')).toHaveText('Không tải được trạng thái đã xem.')
    await expect(v.locator('[data-ann-unread-count], [data-read="unread"], [data-ann-unread-dot]')).toHaveCount(0)
  }
  // Non-admin: RLS ẩn tin hết hạn ⇒ không thẻ nào gắn hết hạn.
  await expect(v.locator('[data-expired]'), `${who}: không được thấy tin hết hạn`).toHaveCount(0)
}

// ── Fixture danh sách ────────────────────────────────────────────────────────────────────────────────────
test.describe('ui v2 Bảng tin A1 — fixture danh sách @desktop', () => {
  test.skip(!fs.existsSync(SUPER_STATE), 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('dược sĩ: không nút Tạo; "2 tin mới trong danh sách" = 2 thẻ chưa đọc; 3 nhóm; đã đọc hết ⇒ không dòng đếm', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await openFx(page, 'list-staff')
    const v = view(page)
    await expect(v).toHaveAttribute('data-ann-list', 'tracked')
    await expect(v.locator('h1')).toHaveText('Bảng tin')
    await expect(v.getByRole('link', { name: /Tạo thông báo/ })).toHaveCount(0)
    await expect(v.locator('[data-ann-unread-count]')).toHaveText('2 tin mới trong danh sách')
    await expect(v.locator('[data-read="unread"]')).toHaveCount(2)
    expect(await v.locator('[data-ann-group]').evaluateAll((els) => els.map((e) => e.getAttribute('data-ann-group')))).toEqual(['today', 'week', 'earlier'])
    await openFx(page, 'list-allread')
    await expect(view(page).locator('[data-ann-unread-count]')).toHaveCount(0)
    await expect(view(page).locator('[data-read="read"]')).toHaveCount(5)
  })

  test('admin: nút "Tạo thông báo" → /announcements/new; không đếm, không "Mới", không chấm; tin hết hạn có badge', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await openFx(page, 'list-admin')
    const v = view(page)
    await expect(v).toHaveAttribute('data-ann-list', 'untracked')
    await expect(v.getByRole('link', { name: /Tạo thông báo/ })).toHaveAttribute('href', '/announcements/new')
    await expect(v.locator('[data-ann-unread-count], [data-ann-unread-dot], [data-read="unread"]')).toHaveCount(0)
    await expect(v.locator('[data-ann-feed]')).not.toContainText('Mới')
    await expect(v.locator('[data-expired]')).toHaveCount(1)
    await expect(v.locator('[data-expired]')).toContainText('Hết hạn')
  })

  test('đọc lỗi ⇒ Notice, không đếm, không "Mới"; truy vấn chính lỗi ⇒ ErrorState, không feed, không nút Tạo; rỗng ⇒ EmptyState', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await openFx(page, 'list-read-error')
    let v = view(page)
    await expect(v).toHaveAttribute('data-ann-list', 'error')
    await expect(v.locator('[data-ann-state="read-error"]')).toHaveText('Không tải được trạng thái đã xem.')
    await expect(v.locator('[data-ann-unread-count], [data-read="unread"]')).toHaveCount(0)
    await expect(v.locator('[data-ann-card]')).toHaveCount(5)
    await openFx(page, 'list-error')
    v = view(page)
    await expect(v.locator('[role="alert"]')).toContainText('Không tải được bảng tin.')
    await expect(v.locator('[data-ann-feed], [data-ann-state="empty"]')).toHaveCount(0)
    await expect(v.getByRole('link', { name: /Tạo thông báo/ })).toHaveCount(0)
    await openFx(page, 'list-empty')
    v = view(page)
    await expect(v.locator('[data-ann-state="empty"]')).toHaveText('Chưa có thông báo nào.')
    await expect(v.locator('[data-ann-feed], [data-ann-unread-count]')).toHaveCount(0)
  })

  test('page-root centered: data-ui-v2 + data-layout-width + max-w-3xl mx-auto (720px ở root 15px), căn giữa ở 1440', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await openFx(page, 'list-staff')
    const v = view(page)
    await expect(v).toHaveAttribute('data-ui-v2', 'page')
    await expect(v).toHaveAttribute('data-layout-width', 'centered')
    const g = await v.evaluate((el) => {
      const r = el.getBoundingClientRect(); const p = el.parentElement!.getBoundingClientRect()
      return { mw: getComputedStyle(el).maxWidth, w: r.width, left: r.left - p.left, right: p.right - r.right }
    })
    expect(g.mw).toBe('720px')
    expect(Math.abs(g.left - g.right)).toBeLessThanOrEqual(1)
  })

  test('1280 có sidebar: tiêu đề dài kẹp 2 dòng, không tràn', async ({ page }, info) => {
    await page.context().addCookies([{ name: 'sidebar_collapsed', value: '0', url: info.project.use.baseURL! }])
    await page.setViewportSize({ width: 1280, height: 900 })
    await openFx(page, 'list-long')
    await expect(page.locator('aside.bg-sidebar').first()).toBeVisible()
    await noPageOverflow(page)
    const t = view(page).locator('[data-ann-card="fx-ann-long"] [data-ann-title]')
    const g = await t.evaluate((el) => ({ h: el.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(el).lineHeight) }))
    expect(g.h).toBeLessThanOrEqual(g.lh * 2 + 1)
  })
})

test.describe('ui v2 Bảng tin A1 — fixture danh sách @mobile', () => {
  test.skip(!fs.existsSync(SUPER_STATE), 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('360/390: không tràn; thẻ ≥44px; nút Tạo (admin) cao ≥44px; dòng đếm không đẩy tràn', async ({ page }) => {
    for (const fx of ['list-staff', 'list-admin', 'list-long']) {
      await openFx(page, fx)
      await noPageOverflow(page)
      for (const h of await view(page).locator('[data-ann-card]').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(h).toBeGreaterThanOrEqual(44)
    }
    await openFx(page, 'list-admin')
    expect((await view(page).getByRole('link', { name: /Tạo thông báo/ }).boundingBox())!.height).toBeGreaterThanOrEqual(44)
  })
})

test.describe('ui v2 Bảng tin A1 — ảnh fixture @desktop', () => {
  test.skip(!fs.existsSync(SUPER_STATE), 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('list-staff 390/360 + list-admin 1440/1280 có sidebar, sáng/tối (commit được)', async ({ page }, info) => {
    test.setTimeout(240_000)
    await page.context().addCookies([{ name: 'sidebar_collapsed', value: '0', url: info.project.use.baseURL! }])
    const unlock = (hideShell: boolean) => page.evaluate((hide) => {
      if (hide) document.querySelectorAll('header.bg-primary, aside.bg-sidebar, nav[aria-label="Điều hướng chính"]').forEach((el) => { (el as HTMLElement).style.display = 'none' })
      document.querySelectorAll('nextjs-portal').forEach((el) => { (el as HTMLElement).style.display = 'none' })
      const main = document.querySelector('main'); const outer = main?.parentElement
      if (outer instanceof HTMLElement) { outer.style.height = 'auto'; outer.style.overflow = 'visible' }
      if (main instanceof HTMLElement) main.style.overflow = 'visible'
    }, hideShell)
    const snap = async (name: string) => {
      await page.waitForTimeout(250)
      expect(await view(page).screenshot({ animations: 'disabled' })).toMatchSnapshot(name, { maxDiffPixelRatio: 0.01 })
    }
    for (const theme of THEMES) {
      for (const w of [390, 360]) {
        await page.setViewportSize({ width: w, height: 844 })
        await openFx(page, 'list-staff', theme)
        await unlock(true)
        await snap(`list-staff-${theme}-m${w}.png`)
      }
      await page.setViewportSize({ width: 1440, height: 1000 })
      await openFx(page, 'list-admin', theme)
      await unlock(true)
      await snap(`list-admin-${theme}-d1440.png`)
      await page.setViewportSize({ width: 1280, height: 900 })
      await openFx(page, 'list-admin', theme)
      await expect(page.locator('aside.bg-sidebar').first()).toBeVisible()
      await unlock(false)
      await snap(`list-admin-${theme}-d1280.png`)
    }
  })
})

// ── Route thật (chỉ đọc) ─────────────────────────────────────────────────────────────────────────────────
test.describe('ui v2 Bảng tin A1 — route thật super @desktop', () => {
  test.skip(!fs.existsSync(SUPER_STATE), 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('super: gốc v2 centered; nút Tạo; KHÔNG theo dõi đọc (không "Mới"/chấm/đếm); thứ tự + nhóm đúng; href chi tiết', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await openRoute(page)
    await assertRouteStructure(page, 'super')
    const v = view(page)
    await expect(v).toHaveAttribute('data-ann-list', 'untracked')
    await expect(v.getByRole('link', { name: /Tạo thông báo/ })).toHaveAttribute('href', '/announcements/new')
    await expect(v.locator('[data-ann-unread-count], [data-ann-unread-dot], [data-read="unread"], [data-read="read"], [data-ann-state="read-error"]')).toHaveCount(0)
  })
})

test.describe('ui v2 Bảng tin A1 — route thật QLCH @desktop', () => {
  test.skip(!fs.existsSync(MANAGER_STATE), 'chưa có phiên QLCH')
  test.use({ storageState: MANAGER_STATE })
  test('QLCH: gốc v2 centered; không nút Tạo; đếm = số thẻ chưa đọc (hoặc Notice khi đọc lỗi); không tin hết hạn', async ({ page }) => {
    await openRoute(page)
    await assertRouteStructure(page, 'QLCH')
    await assertReadState(page, 'QLCH')
  })
})

test.describe('ui v2 Bảng tin A1 — route thật SM @desktop', () => {
  test.skip(!fs.existsSync(SM_STATE), 'chưa có phiên SM')
  test.use({ storageState: SM_STATE })
  test('SM: gốc v2 centered; không nút Tạo; trạng thái đọc như dược sĩ (SM không phải admin)', async ({ page }) => {
    await openRoute(page)
    await assertRouteStructure(page, 'SM')
    await assertReadState(page, 'SM')
  })
})

test.describe('ui v2 Bảng tin A1 — route thật dược sĩ @mobile', () => {
  test.skip(!fs.existsSync(STAFF_STATE), 'chưa có phiên staff')
  test.use({ storageState: STAFF_STATE })
  test('dược sĩ mobile: gốc v2; không nút Tạo; đếm khớp thẻ chưa đọc; không tràn; bottom nav giữ Newspaper', async ({ page }) => {
    await openRoute(page)
    await assertRouteStructure(page, 'staff')
    await assertReadState(page, 'staff')
    await noPageOverflow(page)
    const tab = page.locator('nav a[href="/announcements"]').filter({ visible: true }).first()
    await expect(tab).toBeVisible()
    await expect(tab.locator('svg.lucide-newspaper')).toHaveCount(1)
  })
})
