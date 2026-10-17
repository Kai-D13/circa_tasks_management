import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { MANAGER_STATE, SM_STATE, STAFF_STATE, SUPER_STATE } from './authState'
import { announcementTimeGroup, groupAnnouncementsByTime, readPercent, vnDayIndex, vnWeekStart } from '../lib/announcements/feed'

// UI v2 Phase 3 · Bảng tin — A0 (component dùng chung, artboard B0) trên /ui-catalog/announcements-v2: render ĐÚNG
// component của route thật với fixture giả cố định ⇒ không phụ thuộc dữ liệu prod; ảnh catalog commit được.
// Kiểm HÀNH VI, không chỉ ảnh: chưa đọc có chữ "Mới" (không chỉ màu) · không suy ra chưa đọc khi không theo dõi/đọc lỗi ·
// hết hạn giữ tương phản chữ · ReadMeter phân biệt lỗi / chưa có số / 0 đối tượng / 0 người xem · % không bao giờ ghi
// 100% khi còn người chưa xem · nút xoá ảnh luôn hiện 44px · fixture 0 request ghi.

const HAS_STATE = fs.existsSync(SUPER_STATE)
const THEMES = ['light', 'dark'] as const
const ROOT = 'ui-catalog-ann-v2'

async function open(page: Page, fx: string, theme: (typeof THEMES)[number] = 'light') {
  await page.goto(`/ui-catalog/announcements-v2?fx=${fx}`)
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
  await expect(page.getByTestId(ROOT)).toHaveAttribute('data-fx', fx, { timeout: 20_000 })
  await page.evaluate(() => document.fonts.ready)
}
const card = (page: Page, id: string) => page.getByTestId(ROOT).locator(`[data-ann-card="${id}"]`)
const color = (page: Page, sel: string) => page.getByTestId(ROOT).locator(sel).first().evaluate((el) => getComputedStyle(el).color)

async function noPageOverflow(page: Page) {
  const g = await page.evaluate(() => {
    const m = document.querySelector('main')!
    return { sw: document.documentElement.scrollWidth, iw: window.innerWidth, msw: m.scrollWidth, mcw: m.clientWidth }
  })
  expect(g.sw, 'trang cuộn ngang').toBeLessThanOrEqual(g.iw + 1)
  expect(g.msw, '<main> cuộn ngang').toBeLessThanOrEqual(g.mcw + 1)
}

async function hideShell(page: Page) {
  await page.evaluate(() => {
    document.querySelectorAll('header.bg-primary, aside.bg-sidebar, nav[aria-label="Điều hướng chính"], nextjs-portal').forEach((el) => { (el as HTMLElement).style.display = 'none' })
    const main = document.querySelector('main'); const outer = main?.parentElement
    if (outer instanceof HTMLElement) { outer.style.height = 'auto'; outer.style.overflow = 'visible' }
    if (main instanceof HTMLElement) main.style.overflow = 'visible'
  })
  await page.waitForTimeout(250)
}

// ── Helper thuần (không trình duyệt) ────────────────────────────────────────────────────────────────────
test.describe('bảng tin — nhóm thời gian + % đã xem @desktop', () => {
  const at = (iso: string) => ({ publishedAt: iso })

  test('nửa đêm giờ VN (UTC+7): 16:59:59Z còn hôm trước, 17:00:00Z đã sang ngày mới', () => {
    expect(vnDayIndex('2026-10-14T16:59:59Z') + 1).toBe(vnDayIndex('2026-10-14T17:00:00Z'))
    const now = '2026-10-15T02:45:00Z' // thứ Năm 09:45 VN
    expect(announcementTimeGroup('2026-10-14T17:00:00Z', now)).toBe('today') // 00:00 15/10 VN
    expect(announcementTimeGroup('2026-10-14T16:59:59Z', now)).toBe('week') // 23:59 14/10 VN
  })

  test('tuần bắt đầu thứ Hai: CN trước = Trước đó; thứ Hai = Tuần này; hôm nay là thứ Hai ⇒ không có nhóm Tuần này', () => {
    const thu = '2026-10-15T02:45:00Z'
    expect(vnWeekStart(vnDayIndex(thu))).toBe(vnDayIndex('2026-10-12T05:00:00Z')) // thứ Hai 12/10
    expect(announcementTimeGroup('2026-10-11T16:59:00Z', thu)).toBe('earlier') // 23:59 CN 11/10 VN
    expect(announcementTimeGroup('2026-10-11T17:00:00Z', thu)).toBe('week') // 00:00 thứ Hai 12/10 VN
    const mon = '2026-10-12T03:00:00Z'
    const g = groupAnnouncementsByTime([at('2026-10-12T01:00:00Z'), at('2026-10-11T10:00:00Z')], mon).map((x) => x.key)
    expect(g).toEqual(['today', 'earlier'])
  })

  test('chỉ nhóm có dữ liệu, thứ tự Hôm nay → Tuần này → Trước đó, giữ thứ tự gốc trong nhóm; tương lai = Hôm nay; lỗi ngày = Trước đó', () => {
    const now = '2026-10-15T02:45:00Z'
    const items = [at('2026-09-01T03:00:00Z'), at('2026-10-15T02:30:00Z'), at('xx'), at('2026-10-13T09:05:00Z'), at('2026-10-15T01:10:00Z'), at('2026-10-20T00:00:00Z')]
    const g = groupAnnouncementsByTime(items, now)
    expect(g.map((x) => [x.key, x.label, x.items.map((i) => i.publishedAt)])).toEqual([
      ['today', 'Hôm nay', ['2026-10-15T02:30:00Z', '2026-10-15T01:10:00Z', '2026-10-20T00:00:00Z']],
      ['week', 'Tuần này', ['2026-10-13T09:05:00Z']],
      ['earlier', 'Trước đó', ['2026-09-01T03:00:00Z', 'xx']],
    ])
    expect(groupAnnouncementsByTime([], now)).toEqual([])
  })

  test('% đã xem làm tròn xuống, không bao giờ 100 khi còn người chưa xem; mẫu số 0/không hợp lệ ⇒ null', () => {
    expect(readPercent(86, 120)).toBe(71)
    expect(readPercent(119, 120)).toBe(99)
    expect(readPercent(239, 240)).toBe(99)
    expect(readPercent(120, 120)).toBe(100)
    expect(readPercent(0, 120)).toBe(0)
    expect(readPercent(0, 0)).toBeNull()
    expect(readPercent(5, Number.NaN)).toBeNull()
  })
})

// ── Fixture trên trình duyệt ─────────────────────────────────────────────────────────────────────────────
test.describe('ui v2 Bảng tin A0 catalog @desktop', () => {
  test.skip(!HAS_STATE, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  for (const theme of THEMES) {
    test(`thẻ tin 4 trạng thái — chữ "Mới" + chấm info; không theo dõi ⇒ không chấm; hết hạn giữ tương phản (${theme})`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 1000 })
      await open(page, 'components', theme)
      // Thẻ có hover + transition-colors ⇒ đưa chuột ra khỏi mọi thẻ rồi mới so màu nền/viền.
      await page.mouse.move(1, 1)
      await page.waitForTimeout(250)
      // Chưa đọc: chấm cùng màu chữ badge info, tiêu đề đậm 700, có chữ "Mới".
      const unread = card(page, 'fx-ann-1')
      await expect(unread).toHaveAttribute('data-read', 'unread')
      await expect(unread).toContainText('Mới')
      const infoColor = await unread.getByText('Mới', { exact: true }).evaluate((el) => getComputedStyle(el).color)
      expect(await unread.locator('[data-ann-unread-dot]').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(infoColor)
      expect(await unread.locator('[data-ann-title]').evaluate((el) => getComputedStyle(el).fontWeight)).toBe('700')
      // Nền/viền thẻ chưa đọc TRUNG TÍNH (Q-144): giống thẻ đã đọc.
      const read = card(page, 'fx-ann-3')
      const bg = (l: typeof read) => l.evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).borderTopColor].join('|'))
      expect(await bg(unread)).toBe(await bg(read))
      // Đã đọc: còn cột chấm (trong suốt), không "Mới", chữ 500.
      await expect(read).toHaveAttribute('data-read', 'read')
      await expect(read).not.toContainText('Mới')
      await expect(read.locator('[data-ann-unread-dot]')).toHaveCount(0)
      expect(await read.locator('[data-ann-title]').evaluate((el) => getComputedStyle(el).fontWeight)).toBe('500')
      // Theo cửa hàng: nhãn "Theo cửa hàng", không phải trạng thái đọc.
      await expect(card(page, 'fx-ann-4')).toContainText('Theo cửa hàng')
      // Hết hạn (admin, không theo dõi đọc): không cột chấm, không "Mới", badge "Hết hạn"; chữ cùng màu thẻ thường,
      // thẻ không opacity; chỉ ảnh bìa giảm nhấn (Q-141).
      const exp = card(page, 'fx-ann-expired')
      await expect(exp).toHaveAttribute('data-read', 'untracked')
      await expect(exp).toContainText('Hết hạn')
      await expect(exp).not.toContainText('Mới')
      expect(await exp.locator('span[aria-hidden="true"].w-2').count()).toBe(0)
      expect(await exp.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
      const excerptColor = (l: typeof exp) => l.locator('p').first().evaluate((el) => getComputedStyle(el).color)
      expect(await excerptColor(exp)).toBe(await excerptColor(read))
      expect(await exp.locator('[data-ann-cover]').evaluate((el) => getComputedStyle(el).opacity)).toBe('0.6')
      expect(await card(page, 'fx-ann-4').locator('[data-ann-cover]').evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
    })
  }

  test('tiêu đề dài tối đa 2 dòng, không tràn thẻ; thẻ có href giữ nguyên', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await open(page, 'components')
    const long = card(page, 'fx-ann-long')
    const g = await long.locator('[data-ann-title]').evaluate((el) => {
      const cs = getComputedStyle(el)
      return { h: el.getBoundingClientRect().height, lh: parseFloat(cs.lineHeight), clamp: cs.webkitLineClamp, sw: el.scrollWidth, cw: el.clientWidth }
    })
    expect(g.clamp).toBe('2')
    expect(g.h).toBeLessThanOrEqual(g.lh * 2 + 1)
    expect(g.sw).toBeLessThanOrEqual(g.cw + 1)
    await expect(long).toHaveAttribute('href', '#fx-ann-long')
  })

  test('ReadMeter: 86/120 info · 120/120 success · 0/120 vẫn là số thật · 119/120 = 99% · 0/0 "Không có đối tượng nhận." · chưa có số "—" · lỗi chỉ báo lỗi', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await open(page, 'components')
    const root = page.getByTestId(ROOT)
    const pb = (id: string) => root.getByTestId(id).locator('[role="progressbar"]')
    const fill = (id: string) => pb(id).locator('> div').evaluate((el) => getComputedStyle(el).backgroundColor)
    // 86/120 — đang thu thập (info)
    await expect(pb('fx-meter-86')).toHaveAttribute('aria-valuenow', '86')
    await expect(pb('fx-meter-86')).toHaveAttribute('aria-valuemax', '120')
    await expect(root.getByTestId('fx-meter-86')).toContainText('đã xem · 71%')
    const info = await root.getByTestId('fx-store-bars').locator('[data-ann-store-bar="partial"] [role="progressbar"] > div').first().evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(await fill('fx-meter-86')).toBe(info)
    // 120/120 — đủ ⇒ success, KHÁC info; không link chưa xem
    expect(await fill('fx-meter-complete')).not.toBe(info)
    await expect(root.getByTestId('fx-meter-complete').locator('[data-ann-unread-link]')).toHaveCount(0)
    expect(await fill('fx-meter-complete')).toBe(await root.getByTestId('fx-store-bars').locator('[data-ann-store-bar="complete"] [role="progressbar"] > div').evaluate((el) => getComputedStyle(el).backgroundColor))
    // 86/120 strip: link "34 người chưa xem" tới panel thống kê
    await expect(root.getByTestId('fx-meter-strip').locator('[data-ann-unread-link]')).toHaveText(/^34 người chưa xem/)
    await expect(root.getByTestId('fx-meter-strip').locator('[data-ann-unread-link]')).toHaveAttribute('href', '#fx-stats')
    // 0/120 — số 0 THẬT: vẫn có thanh (0), "120 người chưa xem"
    await expect(pb('fx-meter-zero')).toHaveAttribute('aria-valuenow', '0')
    await expect(root.getByTestId('fx-meter-zero')).toContainText('0/120')
    await expect(root.getByTestId('fx-meter-zero').locator('[data-ann-unread-link]')).toHaveText(/^120 người chưa xem/)
    // 119/120 — không làm tròn lên 100%
    await expect(root.getByTestId('fx-meter-near')).toContainText('đã xem · 99%')
    // 0/0 — không có đối tượng nhận: chữ hiện hành, KHÔNG thanh, KHÔNG "0/0"
    await expect(root.getByTestId('fx-meter-no-audience')).toHaveText('Không có đối tượng nhận.')
    await expect(pb('fx-meter-no-audience')).toHaveCount(0)
    // chưa có số — "—", không thanh, không 0
    await expect(root.getByTestId('fx-meter-missing')).toContainText('—')
    await expect(pb('fx-meter-missing')).toHaveCount(0)
    await expect(root.getByTestId('fx-meter-missing')).not.toContainText('0')
    // lỗi — chỉ câu lỗi, không số, không thanh
    await expect(root.getByTestId('fx-meter-error')).toHaveText('Không tải được thống kê đã xem')
    await expect(pb('fx-meter-error')).toHaveCount(0)
    expect(await root.getByTestId('fx-meter-error').innerText()).not.toMatch(/\d/)
    // mẫu số không hợp lệ (NaN) = chưa có số "—", KHÔNG "đã xem · %" rỗng, không thanh
    await expect(root.getByTestId('fx-meter-nan')).toContainText('—')
    await expect(root.getByTestId('fx-meter-nan')).not.toContainText('%')
    await expect(pb('fx-meter-nan')).toHaveCount(0)
  })

  test('ô ảnh: nút xoá LUÔN hiện (không cần rê chuột), vùng bấm ≥44px, aria-label riêng; ô thêm ảnh ≥44px', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await open(page, 'components')
    const tiles = page.getByTestId(ROOT).getByTestId('fx-image-tiles')
    const rm = tiles.getByRole('button', { name: 'Xóa ảnh carousel 1' })
    await expect(rm).toBeVisible()
    await page.mouse.move(0, 0) // không hover
    const g = await rm.evaluate((el) => {
      const r = el.getBoundingClientRect(); const dot = el.firstElementChild as HTMLElement
      return { w: r.width, h: r.height, op: getComputedStyle(el).opacity, dotOp: getComputedStyle(dot).opacity, vis: getComputedStyle(dot).visibility }
    })
    expect(g.w).toBeGreaterThanOrEqual(44)
    expect(g.h).toBeGreaterThanOrEqual(44)
    expect([g.op, g.dotOp, g.vis]).toEqual(['1', '1', 'visible'])
    const add = tiles.locator('[data-ann-image-add]')
    await expect(add).toHaveText('Thêm ảnh khác')
    expect((await add.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await expect(tiles.locator('[data-ann-image-uploading]')).toHaveText('Đang tải…')
  })

  test('feed: nhóm Hôm nay 2 · Tuần này 2 · Trước đó 1 (giữ thứ tự); 1 tin; rỗng; lỗi; đọc lỗi ⇒ không "Mới"; admin ⇒ không chấm', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    const root = page.getByTestId(ROOT)
    await open(page, 'feed')
    const groups = await root.locator('[data-ann-group]').evaluateAll((els) => els.map((e) => [e.getAttribute('data-ann-group'), e.querySelector('h2')!.textContent, [...e.querySelectorAll('[data-ann-card]')].map((c) => c.getAttribute('data-ann-card'))]))
    expect(groups).toEqual([
      ['today', 'Hôm nay', ['fx-ann-1', 'fx-ann-2']],
      ['week', 'Tuần này', ['fx-ann-3', 'fx-ann-4']],
      ['earlier', 'Trước đó', ['fx-ann-5']],
    ])
    await expect(root.locator('[data-read="unread"]')).toHaveCount(2)

    await open(page, 'feed-one')
    expect(await root.locator('[data-ann-group]').evaluateAll((els) => els.map((e) => e.getAttribute('data-ann-group')))).toEqual(['today'])

    await open(page, 'feed-empty')
    await expect(root.locator('[data-ann-state="empty"]')).toHaveText('Chưa có thông báo nào.')
    await expect(root.locator('[data-ann-feed]')).toHaveCount(0)

    await open(page, 'feed-error')
    await expect(root.locator('[data-ann-state="error"] [role="alert"]')).toContainText('Không tải được bảng tin.')
    await expect(root.locator('[data-ann-state="empty"]')).toHaveCount(0)

    await open(page, 'feed-read-error')
    await expect(root.locator('[data-ann-state="read-error"]')).toHaveText('Không tải được trạng thái đã xem.')
    await expect(root.locator('[data-ann-card]')).toHaveCount(5)
    await expect(root.locator('[data-read="unread"], [data-ann-unread-dot]')).toHaveCount(0)
    await expect(root.locator('[data-ann-feed]')).not.toContainText('Mới')

    await open(page, 'feed-admin')
    await expect(root.locator('[data-read="untracked"]')).toHaveCount(5)
    await expect(root.locator('[data-ann-feed] span[aria-hidden="true"].w-2')).toHaveCount(0)
    await expect(root.locator('[data-expired]')).toHaveCount(1)
    await expect(root.locator('[data-ann-card="fx-ann-5"]')).toContainText('Hết hạn')
  })

  test('fixture 0 request ghi: bấm mọi nút/link + Enter ⇒ không POST/PUT/PATCH/DELETE, không upload, không lượt chặn', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    for (const fx of ['components', 'feed', 'feed-admin']) {
      await open(page, fx)
      const writes: string[] = []
      page.on('request', (r) => { if (r.method() !== 'GET' || /upload|storage\/v1|googleapis/.test(r.url())) writes.push(`${r.method()} ${r.url()}`) })
      const root = page.getByTestId(ROOT)
      const targets = root.locator('button, a[href]')
      const n = await targets.count()
      expect(n, `${fx}: phải có nút/link để thử`).toBeGreaterThan(3)
      for (let i = 0; i < n; i++) {
        const t = targets.nth(i)
        await t.click()
        await t.focus()
        await page.keyboard.press('Enter')
      }
      await page.waitForTimeout(400)
      expect(writes, `${fx}: fixture không được gửi request ghi/upload`).toEqual([])
      await expect(page.locator('[data-ann-fixture-blocked]')).toHaveAttribute('data-ann-fixture-blocked', '0')
      expect(new URL(page.url()).pathname).toBe('/ui-catalog/announcements-v2')
    }
  })
})

// Cổng fixture (spec §4 A0): CÙNG server bật UI_CATALOG=1, vai KHÔNG phải super vẫn 404 (không lộ fixture). Trường hợp
// tắt UI_CATALOG (prod) không đổi được env server trong cùng lượt ⇒ kiểm trên server giống prod bằng
// scratchpad/rcall-catalog404.cjs (ghi trong report), như các catalog trước.
test.describe('ui v2 Bảng tin A0 — cổng fixture theo vai @desktop', () => {
  const STATES = [['staff', STAFF_STATE], ['SM', SM_STATE], ['QLCH', MANAGER_STATE]] as const
  test.skip(STATES.some(([, s]) => !fs.existsSync(s)), 'thiếu phiên staff/SM/QLCH')

  test('staff · SM · QLCH mở /ui-catalog/announcements-v2 ⇒ HTTP 404, không fixture', async ({ browser }, info) => {
    for (const [label, state] of STATES) {
      const ctx = await browser.newContext({ baseURL: info.project.use.baseURL, storageState: state })
      const page = await ctx.newPage()
      const res = await page.goto('/ui-catalog/announcements-v2?fx=feed')
      expect(new URL(page.url()).pathname, `${label}: bị đẩy về /login ⇒ phiên/mạng lỗi, không phải kết quả cổng`).toBe('/ui-catalog/announcements-v2')
      expect(res!.status(), `${label}: phải 404`).toBe(404)
      await expect(page.getByRole('heading', { name: '404' })).toBeVisible()
      await expect(page.getByTestId(ROOT)).toHaveCount(0)
      await expect(page.locator('[data-ann-card]')).toHaveCount(0)
      await ctx.close()
    }
  })
})

test.describe('ui v2 Bảng tin A0 catalog @mobile', () => {
  test.skip(!HAS_STATE, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('360/390: không tràn; thẻ ≥44px; nút xoá ảnh 44px; feed đủ 3 nhóm', async ({ page }) => {
    for (const fx of ['components', 'feed']) {
      await open(page, fx)
      await noPageOverflow(page)
      const cards = page.getByTestId(ROOT).locator('[data-ann-card]')
      const hs = await cards.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))
      expect(hs.length).toBeGreaterThan(0)
      for (const h of hs) expect(h).toBeGreaterThanOrEqual(44)
    }
    await open(page, 'components')
    const rm = page.getByTestId(ROOT).getByRole('button', { name: 'Xóa ảnh carousel 1' })
    const b = (await rm.boundingBox())!
    expect(b.width).toBeGreaterThanOrEqual(44)
    expect(b.height).toBeGreaterThanOrEqual(44)
  })
})

test.describe('ui v2 Bảng tin A0 — ảnh catalog @desktop', () => {
  test.skip(!HAS_STATE, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('catalog B0 1440 + 1280 có sidebar · feed 390 + 360, light/dark (fixture, commit được)', async ({ page }, info) => {
    test.setTimeout(240_000)
    await page.context().addCookies([{ name: 'sidebar_collapsed', value: '0', url: info.project.use.baseURL! }])
    const snap = async (name: string) =>
      expect(await page.getByTestId(ROOT).screenshot({ animations: 'disabled' })).toMatchSnapshot(name, { maxDiffPixelRatio: 0.01 })
    for (const theme of THEMES) {
      await page.setViewportSize({ width: 1440, height: 1000 })
      await open(page, 'components', theme)
      await hideShell(page)
      await snap(`ann-b0-${theme}-d1440.png`)
      // 1280 GIỮ sidebar mở (bề rộng nội dung thật của admin) — chỉ mở khoá cuộn, ảnh chỉ gồm gốc fixture.
      await page.setViewportSize({ width: 1280, height: 900 })
      await open(page, 'components', theme)
      await expect(page.locator('aside.bg-sidebar').first()).toBeVisible()
      await page.evaluate(() => {
        const main = document.querySelector('main'); const outer = main?.parentElement
        if (outer instanceof HTMLElement) { outer.style.height = 'auto'; outer.style.overflow = 'visible' }
        if (main instanceof HTMLElement) main.style.overflow = 'visible'
        document.querySelectorAll('nextjs-portal').forEach((el) => { (el as HTMLElement).style.display = 'none' })
      })
      await page.waitForTimeout(250)
      await snap(`ann-b0-${theme}-d1280.png`)
      for (const w of [390, 360]) {
        await page.setViewportSize({ width: w, height: 844 })
        await open(page, 'feed', theme)
        await hideShell(page)
        await snap(`ann-feed-${theme}-m${w}.png`)
      }
    }
  })
})

// Guardrail tĩnh: component Bảng tin A0 không màu thô (pastel/status/hex) — màu đi qua token / ds.
test.describe('ui v2 Bảng tin A0 — guardrail màu thô @desktop', () => {
  test('component Bảng tin A0 + lib không màu thô', () => {
    const root = path.resolve(__dirname, '..')
    const files = [
      'components/announcements/AnnouncementCard.tsx', 'components/announcements/AnnouncementFeed.tsx',
      'components/announcements/ReadMeter.tsx', 'components/announcements/AnnouncementImageTile.tsx',
      'components/announcements/AnnouncementStates.tsx', 'components/announcements/AnnouncementFixtureBoundary.tsx',
      'lib/announcements/feed.ts',
    ]
    const RAW = /\b(?:bg|text|border|fill|stroke)-(?:green|red|amber|sky|blue|teal|gray|emerald|rose|orange|yellow|slate|indigo|primary)-\d{2,3}\b|#[0-9a-fA-F]{6}\b/g
    for (const f of files) expect(fs.readFileSync(path.join(root, f), 'utf8').match(RAW) ?? [], `${f} còn màu thô`).toEqual([])
  })
})
