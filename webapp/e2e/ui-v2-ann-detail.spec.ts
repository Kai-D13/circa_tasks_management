import fs from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import { MANAGER_STATE, SM_STATE, STAFF_STATE, SUPER_STATE } from './authState'
import { buildStoreReadGroups, onlyUnread, UNASSIGNED_STORE, type ReadMember } from '../lib/announcements/readStats'

// UI v2 Phase 3 · Bảng tin — A2 chi tiết /announcements/[id] + thống kê đã xem (artboard B2 admin / M2 dược sĩ).
// (1) helper thuần readStats; (2) fixture ?fx=detail-* render ĐÚNG AnnouncementDetailView + AnnouncementAdminActions thật
// trong boundary: lỗi / chưa có số / 0 người nhận / số thật tách rõ, lọc Chưa xem, <details> bàn phím, GUARD XÓA (bấm,
// Enter, dialog được auto-accept ⇒ vẫn 0 dialog + 0 request ghi; mọi request ghi bị abort trước mạng nên kể cả khi guard
// hỏng cũng không chạm server); (3) route thật chỉ đọc theo vai: mọi request ghi bị chặn trước mạng — admin 0 lời gọi,
// staff/QLCH/SM đúng 1 lời gọi markAnnouncementRead (đã abort ⇒ không ghi read receipt lên prod).

const ROOT = 'ui-catalog-ann-v2'
const THEMES = ['light', 'dark'] as const

async function openFx(page: Page, fx: string, theme: (typeof THEMES)[number] = 'light') {
  await page.goto(`/ui-catalog/announcements-v2?fx=${fx}`)
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
  await expect(page.getByTestId(ROOT)).toHaveAttribute('data-fx', fx, { timeout: 20_000 })
  await page.evaluate(() => document.fonts.ready)
}
const view = (page: Page) => page.locator('main [data-ann-detail]')
const panel = (page: Page) => view(page).locator('[data-ann-read-stats]')

/** Chặn request ghi (không phải GET/HEAD) TRƯỚC mạng và ghi lại; server action = header next-action.
 *  Fixture: chặn MỌI origin. Route thật (`appOnly`): chặn + đếm request ghi cùng origin app (server action — nơi
 *  markAnnouncementRead/deleteAnnouncement đi qua); request khác origin (Supabase tự làm mới token đăng nhập) cho qua để
 *  phiên không bị đứt — trang chi tiết không ghi dữ liệu Supabase trực tiếp từ trình duyệt. */
async function blockWrites(page: Page, appOnly = false) {
  const writes: { method: string; url: string; action: boolean }[] = []
  const appOrigin = new URL(test.info().project.use.baseURL!).origin
  await page.route('**/*', (route) => {
    const r = route.request()
    if (r.method() === 'GET' || r.method() === 'HEAD') return route.continue()
    if (appOnly && new URL(r.url()).origin !== appOrigin) return route.continue()
    writes.push({ method: r.method(), url: r.url(), action: !!r.headers()['next-action'] })
    return route.abort()
  })
  return writes
}

async function noPageOverflow(page: Page) {
  const g = await page.evaluate(() => {
    const m = document.querySelector('main')!
    return { sw: document.documentElement.scrollWidth, iw: window.innerWidth, msw: m.scrollWidth, mcw: m.clientWidth }
  })
  expect(g.sw, 'trang cuộn ngang').toBeLessThanOrEqual(g.iw + 1)
  expect(g.msw, '<main> cuộn ngang').toBeLessThanOrEqual(g.mcw + 1)
}

const storeOrder = (page: Page) => panel(page).locator('[data-ann-store]').evaluateAll((els) => els.map((e) => e.getAttribute('data-ann-store')))
// Đọc số từ data-read/data-total của StoreReadBar — KHÔNG tách chữ (tên cửa hàng kết thúc bằng số, vd "…Q7", dính vào
// "1/5 đã xem" trong textContent ⇒ đọc nhầm "71/5").
const storeCounts = (page: Page) => panel(page).locator('[data-ann-store] summary [data-ann-store-bar]').evaluateAll((els) => els.map((e) =>
  [Number(e.getAttribute('data-read')), Number(e.getAttribute('data-total'))] as [number, number]))

// ── Helper thuần ─────────────────────────────────────────────────────────────────────────────────────────
test.describe('bảng tin — readStats @desktop', () => {
  const mk = (spec: [string, number, number][]) => {
    const members: ReadMember[] = []; const readMap = new Map<string, string>()
    spec.forEach(([store, read, total], si) => { for (let i = 0; i < total; i++) {
      const id = `u${si}-${i}`
      members.push({ id, full_name: ['Võ', 'An', 'Đỗ', 'Bình', 'Ân'][i % 5] + si + i, store_id: store === UNASSIGNED_STORE ? null : `s${si}`, store })
      if (i < read) readMap.set(id, '2026-10-15T02:00:00Z')
    } })
    return buildStoreReadGroups(members, readMap)
  }

  test('tổng = đúng tập người nhận; xếp tỷ lệ tăng dần, bằng nhau theo tên vi; "Chưa gán cửa hàng" luôn cuối', () => {
    const r = mk([['CIRCA CENTRAL', 6, 6], ['CIRCA URBAN', 4, 5], [UNASSIGNED_STORE, 0, 1], ['CIRCA MIZUKI', 5, 7], ['CIRCA LUMINA', 1, 4], ['CIRCA ÁNH', 1, 4]])
    expect([r.read, r.total]).toEqual([17, 27])
    expect(r.groups.map((g) => [g.store, g.read, g.total])).toEqual([
      ['CIRCA ÁNH', 1, 4], ['CIRCA LUMINA', 1, 4], ['CIRCA MIZUKI', 5, 7], ['CIRCA URBAN', 4, 5], ['CIRCA CENTRAL', 6, 6], [UNASSIGNED_STORE, 0, 1],
    ])
    for (const g of r.groups) {
      const names = g.members.map((m) => m.full_name)
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'vi')))
    }
  })

  test('onlyUnread: bỏ cửa hàng đã xem đủ, giữ người chưa xem, giữ số đếm nhóm + thứ tự; rỗng ⇒ []', () => {
    const r = mk([['CIRCA CENTRAL', 6, 6], ['CIRCA URBAN', 4, 5], [UNASSIGNED_STORE, 0, 1]])
    const u = onlyUnread(r.groups)
    expect(u.map((g) => [g.store, g.members.length, g.read, g.total])).toEqual([['CIRCA URBAN', 1, 4, 5], [UNASSIGNED_STORE, 1, 0, 1]])
    expect(u.flatMap((g) => g.members).every((m) => m.readAt === null)).toBe(true)
    expect(onlyUnread(mk([['A', 2, 2]]).groups)).toEqual([])
    expect(buildStoreReadGroups([], new Map())).toEqual({ groups: [], total: 0, read: 0 })
  })
})

// ── Fixture ──────────────────────────────────────────────────────────────────────────────────────────────
test.describe('ui v2 Bảng tin A2 — fixture chi tiết @desktop', () => {
  test.skip(!fs.existsSync(SUPER_STATE), 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('admin: link "Bảng tin"; dải 16/23 + "7 người chưa xem" → focus panel; panel cùng số; cửa hàng xếp tỷ lệ tăng, chưa gán cuối; tổng cửa hàng = tổng dải', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await openFx(page, 'detail-admin')
    const v = view(page)
    await expect(v).toHaveAttribute('data-ann-detail', 'ok')
    await expect(v.locator('[data-ann-back]')).toHaveText('Bảng tin')
    await expect(v.locator('[data-ann-back]')).toHaveAttribute('href', '#fx-back')
    await expect(v.locator('h1')).toHaveText('Lịch trực Tết Dương lịch 2027 — đăng ký trước 20/10')
    const strip = v.locator('[data-ann-read-meter]')
    await expect(strip).toHaveAttribute('data-ann-read-meter', 'ok')
    await expect(strip).toContainText('16/23')
    await expect(strip.locator('[role="progressbar"]')).toHaveAttribute('aria-valuenow', '16')
    await expect(strip.locator('[data-ann-unread-link]')).toHaveText(/^7 người chưa xem/)
    await expect(panel(page).locator('h2')).toHaveText('Đã xem: 16/23 (đối tượng nhận)')
    expect(await storeOrder(page)).toEqual(['CIRCA LUMINA', 'CIRCA MIZUKI', 'CIRCA URBAN', 'CIRCA CENTRAL', UNASSIGNED_STORE])
    const counts = await storeCounts(page)
    expect(counts.reduce((s, [r]) => s + r, 0)).toBe(16)
    expect(counts.reduce((s, [, t]) => s + t, 0)).toBe(23)
    await expect(panel(page).locator('[data-ann-others]')).toContainText('Người khác đã xem (2)')
    // Link chỉ chuyển focus khi React đã hydrate (handler client); trước đó trình duyệt chỉ cuộn — chờ hydrate rồi bấm.
    const link = strip.locator('[data-ann-unread-link]')
    // href phải là CHUỖI "#da-xem" (từng hỏng thành "#function(){throw …}" khi hằng nằm trong file 'use client').
    await expect(link).toHaveAttribute('href', '#da-xem')
    await expect.poll(() => link.evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactProps')))).toBe(true)
    await link.click()
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('da-xem')
  })

  test('lọc "Chưa xem (7)": chỉ cửa hàng còn người chưa xem + chỉ người chưa xem, mở sẵn, ẩn "Người khác"; về "Tất cả" đủ lại', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await openFx(page, 'detail-admin')
    const p = panel(page)
    const unreadBtn = p.getByRole('button', { name: 'Chưa xem (7)' })
    await unreadBtn.click()
    await expect(unreadBtn).toHaveAttribute('aria-pressed', 'true')
    await expect(p).toHaveAttribute('data-filter', 'unread')
    expect(await storeOrder(page)).toEqual(['CIRCA LUMINA', 'CIRCA MIZUKI', 'CIRCA URBAN', UNASSIGNED_STORE])
    await expect(p.locator('[data-ann-member]')).toHaveCount(7)
    await expect(p.locator('[data-ann-member="read"]')).toHaveCount(0)
    expect(await p.locator('details[data-ann-store]').evaluateAll((els) => els.every((e) => (e as HTMLDetailsElement).open))).toBe(true)
    await expect(p.locator('[data-ann-others]')).toHaveCount(0)
    await p.getByRole('button', { name: 'Tất cả' }).click()
    expect(await storeOrder(page)).toHaveLength(5)
    await expect(p.locator('[data-ann-others]')).toHaveCount(1)
  })

  test('<details> cửa hàng điều khiển bằng bàn phím: Enter mở, Space đóng; summary ≥44px', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await openFx(page, 'detail-admin')
    const first = panel(page).locator('details[data-ann-store]').first()
    const sum = first.locator('summary')
    expect((await sum.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await sum.focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => first.evaluate((e) => (e as HTMLDetailsElement).open)).toBe(true)
    await expect(first.locator('[data-ann-member]')).toHaveCount(4)
    await page.keyboard.press('Space')
    await expect.poll(() => first.evaluate((e) => (e as HTMLDetailsElement).open)).toBe(false)
  })

  test('đủ 23/23: nút "Chưa xem (0)" tắt, không link chưa xem, thanh success; 0 người nhận: chữ hiện hành, không thanh, không "0/0"', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await openFx(page, 'detail-complete')
    await expect(panel(page).getByRole('button', { name: 'Chưa xem (0)' })).toBeDisabled()
    await expect(view(page).locator('[data-ann-read-meter]')).toHaveAttribute('data-ann-read-meter', 'complete')
    await expect(view(page).locator('[data-ann-unread-link]')).toHaveCount(0)
    await openFx(page, 'detail-zero')
    await expect(view(page).locator('[data-ann-read-meter]')).toHaveText('Không có đối tượng nhận.')
    await expect(panel(page)).toHaveAttribute('data-ann-read-stats', 'no-audience')
    await expect(panel(page)).toContainText('Không có đối tượng nhận.')
    await expect(view(page).locator('[role="progressbar"], [data-ann-filter]')).toHaveCount(0)
    await expect(view(page)).not.toContainText('0/0')
  })

  test('thống kê lỗi: dải + panel chỉ báo "Không tải được thống kê đã xem" — không số, không thanh, không bộ lọc; bài viết vẫn đọc được', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await openFx(page, 'detail-stats-error')
    await expect(view(page).locator('[data-ann-read-meter]')).toHaveText('Không tải được thống kê đã xem')
    await expect(panel(page)).toHaveAttribute('data-ann-read-stats', 'error')
    await expect(panel(page).locator('h2')).toHaveText('Đã xem')
    await expect(panel(page)).toContainText('Không tải được thống kê đã xem')
    expect(await panel(page).innerText()).not.toMatch(/\d/)
    await expect(view(page).locator('[role="progressbar"], [data-ann-filter], [data-ann-store]')).toHaveCount(0)
    await expect(view(page).locator('table')).toHaveCount(1)
  })

  test('dược sĩ: không dải/panel thống kê, không Sửa/Xóa; lỗi tải tin: ErrorState + link "Bảng tin", không tiêu đề', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await openFx(page, 'detail-staff')
    await expect(view(page).locator('[data-ann-read-meter], [data-ann-read-stats], [data-ann-delete]')).toHaveCount(0)
    await expect(view(page).getByRole('link', { name: /Sửa/ })).toHaveCount(0)
    await expect(view(page).locator('h1')).toHaveCount(1)
    await openFx(page, 'detail-error')
    await expect(view(page)).toHaveAttribute('data-ann-detail', 'error')
    await expect(view(page).locator('[role="alert"]')).toContainText('Không tải được thông báo.')
    await expect(view(page).locator('[data-ann-back]')).toHaveText('Bảng tin')
    await expect(view(page).locator('h1, [data-ann-read-stats]')).toHaveCount(0)
  })

  test('admin KHÔNG phải tác giả (canManage = false): vẫn có dải + panel thống kê, KHÔNG Sửa/Xóa', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await openFx(page, 'detail-admin-other')
    await expect(view(page).locator('[data-ann-read-meter]')).toHaveAttribute('data-ann-read-meter', 'ok')
    await expect(panel(page)).toHaveAttribute('data-ann-read-stats', 'ok')
    await expect(view(page).locator('[data-ann-delete]')).toHaveCount(0)
    await expect(view(page).getByRole('link', { name: /Sửa/ })).toHaveCount(0)
  })

  test('page-root centered 720px; không ảnh ⇒ không khung ảnh, chữ thường giữ xuống dòng', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await openFx(page, 'detail-noimage')
    const v = view(page)
    await expect(v).toHaveAttribute('data-layout-width', 'centered')
    expect(await v.evaluate((el) => getComputedStyle(el).maxWidth)).toBe('720px')
    await expect(v.locator('[data-ann-detail-cover], [data-ann-carousel]')).toHaveCount(0)
    expect(await v.locator('p.whitespace-pre-wrap').evaluate((el) => (el as HTMLElement).innerText)).toContain('\n')
  })

  test('GUARD XÓA (fixture): bấm chuột + Enter, dialog được auto-accept ⇒ 0 dialog, 0 request ghi, đếm chặn 2; Sửa không rời fixture', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await openFx(page, 'detail-admin')
    const writes = await blockWrites(page)
    const dialogs: string[] = []
    page.on('dialog', (d) => { dialogs.push(d.message()); void d.accept() })
    const del = view(page).locator('[data-ann-delete]')
    await expect(del).toHaveText('Xóa')
    await del.click()
    await expect(page.locator('[data-ann-fixture-blocked]')).toHaveAttribute('data-ann-fixture-blocked', '1')
    await del.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-ann-fixture-blocked]')).toHaveAttribute('data-ann-fixture-blocked', '2')
    await page.waitForTimeout(800)
    expect(dialogs, 'guard phải chặn TRƯỚC confirm()').toEqual([])
    expect(writes, 'fixture không được gửi request ghi (deleteAnnouncement)').toEqual([])
    await view(page).getByRole('link', { name: /Sửa/ }).click()
    expect(new URL(page.url()).pathname).toBe('/ui-catalog/announcements-v2')
  })
})

test.describe('ui v2 Bảng tin A2 — fixture chi tiết @mobile', () => {
  test.skip(!fs.existsSync(SUPER_STATE), 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('360/390: không tràn (tiêu đề/nội dung dài, 5 ảnh cuộn trong khung); Sửa/Xóa/lọc/link ≥44px', async ({ page }) => {
    await openFx(page, 'detail-long')
    await noPageOverflow(page)
    const h1 = view(page).locator('h1')
    const g = await h1.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, h: el.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(el).lineHeight) }))
    expect(g.sw).toBeLessThanOrEqual(g.cw + 1)
    expect(g.h, 'tiêu đề chi tiết hiện đủ, không kẹp 1 dòng').toBeGreaterThan(g.lh * 2)
    const car = view(page).locator('[data-ann-carousel]')
    await expect(car.locator('img')).toHaveCount(5)
    const c = await car.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }))
    expect(c.sw).toBeGreaterThan(c.cw)
    for (const l of [view(page).locator('[data-ann-delete]'), view(page).getByRole('link', { name: /Sửa/ }), view(page).locator('[data-ann-back]'), panel(page).locator('[data-ann-filter]').first(), view(page).locator('[data-ann-unread-link]')]) {
      expect((await l.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    }
  })
})

test.describe('ui v2 Bảng tin A2 — ảnh fixture @desktop', () => {
  test.skip(!fs.existsSync(SUPER_STATE), 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('detail-admin 1440 + 1280 có sidebar, detail-staff 390/360, sáng/tối (commit được)', async ({ page }, info) => {
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
      await page.mouse.move(1, 1)
      await page.waitForTimeout(250)
      expect(await view(page).screenshot({ animations: 'disabled' })).toMatchSnapshot(name, { maxDiffPixelRatio: 0.01 })
    }
    for (const theme of THEMES) {
      await page.setViewportSize({ width: 1440, height: 1000 })
      await openFx(page, 'detail-admin', theme)
      await unlock(true)
      await snap(`detail-admin-${theme}-d1440.png`)
      await page.setViewportSize({ width: 1280, height: 900 })
      await openFx(page, 'detail-admin', theme)
      await expect(page.locator('aside.bg-sidebar').first()).toBeVisible()
      await unlock(false)
      await snap(`detail-admin-${theme}-d1280.png`)
      for (const w of [390, 360]) {
        await page.setViewportSize({ width: w, height: 844 })
        await openFx(page, 'detail-staff', theme)
        await unlock(true)
        await snap(`detail-staff-${theme}-m${w}.png`)
      }
    }
    // Hai trạng thái thống kê PM soi riêng (pm-auditor A2): 0 người nhận và truy vấn thống kê lỗi — sáng, 1440.
    for (const fx of ['detail-zero', 'detail-stats-error']) {
      await page.setViewportSize({ width: 1440, height: 1000 })
      await openFx(page, fx, 'light')
      await unlock(true)
      await snap(`${fx}-light-d1440.png`)
    }
  })
})

// ── Route thật (chỉ đọc; mọi request ghi bị chặn trước mạng) ─────────────────────────────────────────────────
async function openFirstDetail(page: Page, who: string) {
  await page.goto('/announcements')
  expect(new URL(page.url()).pathname, `${who}: bị đẩy khỏi /announcements (phiên/mạng lỗi?)`).toBe('/announcements')
  const href = await page.locator('main [data-ann-card]').first().getAttribute('href', { timeout: 30_000 })
  expect(href, `${who}: tài khoản QA phải thấy ít nhất 1 tin`).toMatch(/^\/announcements\/[0-9a-f-]{36}$/)
  await page.goto(href!)
  expect(new URL(page.url()).pathname).toBe(href)
  await expect(view(page)).toHaveAttribute('data-ann-detail', 'ok', { timeout: 30_000 })
  await expect(view(page)).toHaveAttribute('data-ui-v2', 'page')
  await expect(view(page)).toHaveAttribute('data-layout-width', 'centered')
  await expect(view(page).locator('[data-ann-back]')).toHaveAttribute('href', '/announcements')
  expect((await view(page).locator('h1').innerText()).trim().length, `${who}: tiêu đề`).toBeGreaterThan(0)
  return href!
}

/** Non-admin: đúng 1 server action (markAnnouncementRead) được GỌI và đã bị chặn trước mạng; không thống kê/Sửa/Xóa. */
async function assertNonAdminDetail(page: Page, who: string, writes: { action: boolean }[]) {
  await expect.poll(() => writes.length, { message: `${who}: phải gọi markAnnouncementRead đúng 1 lần (đã chặn)`, timeout: 15_000 }).toBe(1)
  await page.waitForTimeout(1000)
  expect(writes, `${who}: chỉ 1 lời gọi, là server action`).toEqual([expect.objectContaining({ action: true })])
  await expect(view(page).locator('[data-ann-read-meter], [data-ann-read-stats], [data-ann-delete]')).toHaveCount(0)
  await expect(view(page).getByRole('link', { name: /^Sửa$/ })).toHaveCount(0)
}

test.describe('ui v2 Bảng tin A2 — route thật super @desktop', () => {
  test.skip(!fs.existsSync(SUPER_STATE), 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('super: v2 centered; 0 request ghi (admin không ghi nhận đọc); Sửa/Xóa; thống kê nhất quán (dải = panel = tổng cửa hàng) hoặc lỗi rõ; lọc Chưa xem đúng', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    const writes = await blockWrites(page, true)
    const href = await openFirstDetail(page, 'super')
    await expect(view(page).getByRole('link', { name: /Sửa/ })).toHaveAttribute('href', `${href}/edit`)
    await expect(view(page).locator('[data-ann-delete]')).toBeVisible()
    const mode = await panel(page).getAttribute('data-ann-read-stats')
    test.info().annotations.push({ type: 'nhánh', description: `super chi tiết ${href}: thống kê = ${mode}` })
    if (mode === 'error') {
      await expect(view(page).locator('[data-ann-read-meter]')).toHaveText('Không tải được thống kê đã xem')
      await expect(view(page).locator('[role="progressbar"], [data-ann-store]')).toHaveCount(0)
    } else if (mode === 'no-audience') {
      await expect(view(page).locator('[data-ann-read-meter]')).toHaveText('Không có đối tượng nhận.')
      await expect(view(page).locator('[role="progressbar"]')).toHaveCount(0)
    } else {
      expect(mode).toBe('ok')
      const m = (await panel(page).locator('h2').innerText()).match(/Đã xem: (\d+)\/(\d+)/)!
      const [read, total] = [Number(m[1]), Number(m[2])]
      test.info().annotations.push({ type: 'nhánh', description: `super: ${read}/${total} đã xem` })
      expect(read).toBeLessThanOrEqual(total)
      await expect(view(page).locator('[data-ann-read-meter] [role="progressbar"]')).toHaveAttribute('aria-valuenow', String(read))
      await expect(view(page).locator('[data-ann-read-meter] [role="progressbar"]')).toHaveAttribute('aria-valuemax', String(total))
      const counts = await storeCounts(page)
      expect(counts.reduce((s, [r]) => s + r, 0), 'tổng đã xem theo cửa hàng').toBe(read)
      expect(counts.reduce((s, [, t]) => s + t, 0), 'tổng người nhận theo cửa hàng').toBe(total)
      const order = await storeOrder(page)
      const ratios = counts.map(([r, t]) => r / t)
      const named = order.map((s, i) => ({ s, r: ratios[i] })).filter((x) => x.s !== UNASSIGNED_STORE)
      for (let i = 1; i < named.length; i++) expect(named[i].r, `thứ tự tỷ lệ tại ${named[i].s}`).toBeGreaterThanOrEqual(named[i - 1].r)
      if (order.includes(UNASSIGNED_STORE)) expect(order.at(-1)).toBe(UNASSIGNED_STORE)
      const unread = total - read
      if (unread > 0) {
        await expect(view(page).locator('[data-ann-unread-link]')).toHaveText(new RegExp(`^${unread} người chưa xem`))
        await panel(page).getByRole('button', { name: `Chưa xem (${unread})` }).click()
        await expect(panel(page).locator('[data-ann-member]')).toHaveCount(unread)
        await expect(panel(page).locator('[data-ann-member="read"], [data-ann-others]')).toHaveCount(0)
      } else {
        await expect(panel(page).getByRole('button', { name: 'Chưa xem (0)' })).toBeDisabled()
      }
    }
    await page.waitForTimeout(800)
    expect(writes, 'admin mở chi tiết: không có request ghi nào').toEqual([])
  })
})

test.describe('ui v2 Bảng tin A2 — route thật QLCH @desktop', () => {
  test.skip(!fs.existsSync(MANAGER_STATE), 'chưa có phiên QLCH')
  test.use({ storageState: MANAGER_STATE })
  test('QLCH: v2 centered; ghi nhận đọc vẫn nối (1 lời gọi, đã chặn); không thống kê, không Sửa/Xóa', async ({ page }) => {
    const writes = await blockWrites(page, true)
    await openFirstDetail(page, 'QLCH')
    await assertNonAdminDetail(page, 'QLCH', writes)
  })
})

test.describe('ui v2 Bảng tin A2 — route thật SM @desktop', () => {
  test.skip(!fs.existsSync(SM_STATE), 'chưa có phiên SM')
  test.use({ storageState: SM_STATE })
  test('SM: v2 centered; ghi nhận đọc vẫn nối (1 lời gọi, đã chặn); không thống kê, không Sửa/Xóa', async ({ page }) => {
    const writes = await blockWrites(page, true)
    await openFirstDetail(page, 'SM')
    await assertNonAdminDetail(page, 'SM', writes)
  })
})

test.describe('ui v2 Bảng tin A2 — route thật dược sĩ @mobile', () => {
  test.skip(!fs.existsSync(STAFF_STATE), 'chưa có phiên staff')
  test.use({ storageState: STAFF_STATE })
  test('dược sĩ mobile: v2; ghi nhận đọc vẫn nối (1 lời gọi, đã chặn); không thống kê; không tràn', async ({ page }) => {
    const writes = await blockWrites(page, true)
    await openFirstDetail(page, 'staff')
    await assertNonAdminDetail(page, 'staff', writes)
    await noPageOverflow(page)
  })
})
