import { test, expect, type Page, type Locator } from '@playwright/test'

// Staff mobile smoke: login → tap all 5 bottom-nav tabs → each navigates,
// marks itself aria-current="page", and the page never scrolls horizontally.
// Requires a STAFF test account via env: E2E_STAFF_EMAIL / E2E_STAFF_PASSWORD
// (optional E2E_BASE_URL, default http://localhost:3000). Without them the
// suite skips instead of failing — safe on CI until the account is provisioned.
//
// UI-NAV U2 (PM spec planning/research/ui-nav-spec-implementation-2026-11-08.md §4, quyết định D04 thay hình thức nút NỔI
// 15/08): năm tab staff cùng một kiểu — cùng bề rộng / chiều cao, vùng chạm ≥ 44×44, không phần tử nào nhô khỏi pill; nội dung
// cuối trang nằm trên mép trên pill + khoảng thở; <main> chừa đúng 75.5px (+ safe-area) — bớt 22px phần nhô + quầng cũ.
// Vị trí 5 theo cờ CARE_ENABLED của SERVER: E2E_CARE_ENABLED=1 ⇒ CSKH (/care/my), không ⇒ Tồn kho (/inventory). Chạy cả hai
// biến thể bằng hai server — không suy biến thể từ DOM (sai cờ phải đỏ, không âm thầm đổi kỳ vọng).

const EMAIL = process.env.E2E_STAFF_EMAIL
const PASSWORD = process.env.E2E_STAFF_PASSWORD
const CARE = process.env.E2E_CARE_ENABLED === '1'

// THỨ TỰ là hợp đồng: Tasks · Toa thuốc · Doanh số (giữa, thứ ba) · Bảng tin · Tồn kho | CSKH. Khoá bằng href (badge chèn số
// vào textContent). `icon` = class lucide render thật (CheckSquare render `lucide-square-check-big` — đừng đoán từ tên import).
const TABS = [
  { label: 'Tasks', path: '/tasks', icon: 'lucide-square-check-big' },
  { label: 'Toa thuốc', path: '/prescriptions', icon: 'lucide-file-image' },
  { label: 'Doanh số', path: '/targets', icon: 'lucide-chart-no-axes-combined' },
  { label: 'Bảng tin', path: '/announcements', icon: 'lucide-newspaper' },
  CARE
    ? { label: 'CSKH', path: '/care/my', icon: 'lucide-heart-handshake' }
    : { label: 'Tồn kho', path: '/inventory', icon: 'lucide-boxes' },
]
const CONTENT_GAP = 8          // --bottom-nav-content-gap
const FLAT_CLEARANCE = 75.5    // --bottom-nav-clearance-flat khi safe-area = 0 (60 + 7.5 + 8)

// Vùng cuộn của app là <main> (overflow-y-auto trong khung h-[100dvh]), KHÔNG phải window.
async function scrollMainToBottom(page: Page) {
  await page.evaluate(() => {
    const main = document.querySelector('main')
    if (main) main.scrollTop = main.scrollHeight
  })
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
}

/** Hình học 5 tab + pill + phần tử cuối của <main> (đo sau khi cuộn hết). */
async function navGeometry(page: Page) {
  return page.evaluate(() => {
    const nav = document.querySelector('[data-bottom-nav]')
    const pill = nav?.firstElementChild as HTMLElement | null
    const main = document.querySelector('main')
    if (!nav || !pill || !main) return null
    const p = pill.getBoundingClientRect()
    const links = [...pill.querySelectorAll<HTMLAnchorElement>(':scope > a')].map((a) => {
      const r = a.getBoundingClientRect()
      return { href: a.getAttribute('href'), x: r.left, w: r.width, h: r.height, top: r.top, bottom: r.bottom }
    })
    // Mọi phần tử con của pill (icon, nhãn, badge, khung active) phải nằm trong pill — "không nút nhô lên".
    const above = [...pill.querySelectorAll<HTMLElement>('*')].map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.height > 0 && r.top < p.top - 0.5)
      .map(({ el, r }) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 2).join('.')}@${Math.round(r.top)}`)
    const last = [...main.children].filter((el) => el.getBoundingClientRect().height > 0).pop()
    return {
      pillTop: p.top, pillH: p.height, links, above,
      lastBottom: last ? last.getBoundingClientRect().bottom : null,
      lastDesc: last ? `${last.tagName.toLowerCase()}.${String(last.className || '').split(' ').slice(0, 3).join('.')}` : '',
      mainPb: parseFloat(getComputedStyle(main).paddingBottom),
      legacy: document.querySelectorAll('[data-testid="bottom-nav-center"], [data-nav-center-zone]').length,
    }
  })
}

async function login(page: Page) {
  await page.goto('/login')
  await page.fill('#email', EMAIL!)
  await page.fill('#password', PASSWORD!)
  await page.getByRole('button', { name: /^đăng nhập$/i }).click()
  await page.waitForURL(/\/(tasks|dashboard|targets)/, { timeout: 20_000 })
}

function expectEqualTabs(g: NonNullable<Awaited<ReturnType<typeof navGeometry>>>, where: string) {
  expect(g.links.map((l) => l.href), `${where}: thứ tự / href`).toEqual(TABS.map((t) => t.path))
  const ws = g.links.map((l) => l.w), hs = g.links.map((l) => l.h)
  expect(Math.max(...ws) - Math.min(...ws), `${where}: 5 tab không cùng bề rộng (${ws.map((w) => w.toFixed(1)).join(' / ')})`).toBeLessThanOrEqual(1)
  expect(Math.max(...hs) - Math.min(...hs), `${where}: 5 tab không cùng chiều cao (${hs.join(' / ')})`).toBeLessThanOrEqual(0.5)
  for (const l of g.links) {
    expect(l.w, `${where}: ${l.href} rộng ${l.w}px < 44`).toBeGreaterThanOrEqual(44)
    expect(l.h, `${where}: ${l.href} cao ${l.h}px < 44`).toBeGreaterThanOrEqual(44)
  }
  // Các ô nối tiếp nhau, không chồng hitbox (badge không kéo vùng chạm sang tab cạnh).
  for (let i = 1; i < g.links.length; i++) expect(g.links[i].x, `${where}: tab ${i + 1} chồng tab ${i}`).toBeGreaterThanOrEqual(g.links[i - 1].x + g.links[i - 1].w - 0.5)
  expect(g.above, `${where}: phần tử nhô khỏi mép trên pill`).toEqual([])
  expect(g.legacy, `${where}: còn DOM nút giữa nổi cũ`).toBe(0)
}

test.describe(`staff bottom nav — 5 tab đều nhau (${CARE ? 'CARE ON: CSKH' : 'CARE OFF: Tồn kho'}) @mobile`, () => {
  test.skip(!EMAIL || !PASSWORD, 'E2E_STAFF_EMAIL / E2E_STAFF_PASSWORD not set')

  test('5 tabs navigate, mark active, equal hitboxes, no overflow, content clears the pill', async ({ page }) => {
    await login(page)
    const nav = page.getByRole('navigation', { name: 'Điều hướng chính' })
    await expect(nav).toBeVisible()
    // Staff must NOT have a "Thêm" overflow button (5 direct tabs).
    await expect(nav.getByRole('button', { name: 'Thêm' })).toHaveCount(0)

    for (const tab of TABS) {
      await expect(nav.getByRole('link', { name: tab.label }).locator(`svg.${tab.icon}`), `${tab.path}: sai icon (chờ .${tab.icon})`).toHaveCount(1)
    }

    for (const tab of TABS) {
      // force: true — in `next dev` the dev-tools portal floats over the bottom-left. Không tồn tại ở production.
      await nav.getByRole('link', { name: tab.label }).click({ force: true })
      await page.waitForURL(`**${tab.path}**`)
      const link = nav.getByRole('link', { name: tab.label })
      await expect(link).toHaveAttribute('aria-current', 'page')
      await expect(nav.locator('a[aria-current="page"]'), `${tab.path}: số tab aria-current`).toHaveCount(1)
      // Active = nền nhạt bọc icon + nhãn như tab thường (không vòng tròn đặc); tab khác không nền.
      const bgs = await nav.locator('a > span').evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor))
      const activeIdx = TABS.indexOf(tab)
      bgs.forEach((bg, i) => {
        if (i === activeIdx) expect(bg, `${tab.path}: tab active thiếu nền nhạt`).not.toBe('rgba(0, 0, 0, 0)')
        else expect(bg, `${tab.path}: tab ${TABS[i].path} không active mà có nền`).toBe('rgba(0, 0, 0, 0)')
      })
      const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)
      expect(noOverflow, `horizontal overflow on ${tab.path}`).toBe(true)

      await scrollMainToBottom(page)
      const g = await navGeometry(page)
      expect(g, `${tab.path}: không đo được nav / <main>`).not.toBeNull()
      expectEqualTabs(g!, tab.path)
      // Phần tử cuối nằm trên mép trên pill + khoảng thở (ranh giới giờ là mép pill, không còn vùng nút nổi).
      if (g!.lastBottom !== null) {
        expect(g!.lastBottom, `${tab.path}: phần tử cuối ${g!.lastDesc} (đáy ${g!.lastBottom}px) chạm khoảng thở trên pill (${g!.pillTop}px)`)
          .toBeLessThanOrEqual(g!.pillTop - CONTENT_GAP + 0.5)
      }
      // CSKH chi tiết ẩn nav (không phải route tab) — các route tab đều có nav ⇒ <main> chừa đúng clearance phẳng (safe-area 0).
      expect(g!.mainPb, `${tab.path}: <main> padding-bottom`).toBeCloseTo(FLAT_CLEARANCE, 1)
    }
  })

  test('badge 1 / 9 / 9+ nằm gọn trong ô của tab, không chặn tab cạnh; bàn phím Tab + Enter điều hướng, có focus ring', async ({ page }) => {
    await login(page)
    const nav = page.getByRole('navigation', { name: 'Điều hướng chính' })
    await expect(nav).toBeVisible()
    // UI-NAV r1: <nav> có trước khi hydrate, còn 5 link chỉ render khi UserProvider đã đặt vai (effect) — chờ đủ link rồi mới
    // đo (lượt r1 08/11: đo trước khi hydrate ⇒ "thiếu" link, không phải lỗi badge).
    await expect(nav.locator('a'), 'BottomNav chưa hydrate đủ 5 link').toHaveCount(TABS.length, { timeout: 20_000 })
    // Badge thật phụ thuộc dữ liệu QA ⇒ đặt nội dung badge tạm trong DOM (chỉ trình duyệt, không ghi gì) để đo ca rộng nhất.
    for (const text of ['1', '9', '9+']) {
      const res = await page.evaluate((t) => {
        const out: string[] = []
        for (const href of ['/tasks', '/announcements']) {
          const a = document.querySelector<HTMLAnchorElement>(`[data-bottom-nav] a[href="${href}"]`)
          const iconBox = a?.querySelector('span > span.relative')
          if (!a || !iconBox) { out.push(`${href}: thiếu`); continue }
          let b = iconBox.querySelector<HTMLElement>('span.absolute')
          if (!b) { b = document.createElement('span'); b.className = 'absolute -top-1.5 -right-2 min-w-4 h-4 px-1 rounded-full bg-primary text-white text-[9px] font-semibold flex items-center justify-center'; b.dataset.e2eBadge = '1'; iconBox.appendChild(b) }
          b.textContent = t
          const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect()
          if (br.left < ar.left - 0.5 || br.right > ar.right + 0.5 || br.top < ar.top - 0.5) out.push(`${href} badge "${t}" tràn ô [${Math.round(br.left)}–${Math.round(br.right)}] ngoài [${Math.round(ar.left)}–${Math.round(ar.right)}]`)
          // Điểm giữa mép phải badge thuộc về chính link (không bị tab cạnh nhận).
          const hit = document.elementFromPoint(br.right - 1, br.top + br.height / 2)
          if (!hit || !a.contains(hit)) out.push(`${href} badge "${t}": điểm chạm thuộc phần tử khác`)
        }
        return out
      }, text)
      expect(res, `badge "${text}"`).toEqual([])
    }
    await page.reload()
    await expect(nav).toBeVisible()
    // Bàn phím: focus link đầu của nav, Tab lần lượt qua 5 link, focus ring hiện (outline / box-shadow), Enter điều hướng.
    const links = nav.locator('a')
    await links.nth(0).focus()
    for (let i = 0; i < TABS.length; i++) {
      if (i > 0) await page.keyboard.press('Tab')
      await expect(links.nth(i), `Tab lần ${i}: focus không ở ${TABS[i].path}`).toBeFocused()
      const ring = await links.nth(i).evaluate((e) => { const s = getComputedStyle(e); return s.boxShadow !== 'none' || (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) })
      expect(ring, `${TABS[i].path}: không thấy focus ring khi focus bằng bàn phím`).toBe(true)
    }
    const target = TABS[2]
    await links.nth(2).focus()
    await page.keyboard.press('Enter')
    await page.waitForURL(`**${target.path}**`)
    await expect(nav.getByRole('link', { name: target.label })).toHaveAttribute('aria-current', 'page')
  })
})

/** QLCH (store_manager) giữ tab thường + "Thêm" và clearance CŨ (97.5px + safe-area) — không bị kéo theo staff. */
const QLCH = { email: process.env.E2E_QLCH_EMAIL, password: process.env.E2E_QLCH_PASSWORD }
test.describe('QLCH bottom nav giữ nguyên (Thêm + clearance cũ) @mobile', () => {
  test.skip(!QLCH.email || !QLCH.password, 'E2E_QLCH_* not set')
  test('QLCH: có nút Thêm, không DOM nút nổi, <main> chừa 97.5px', async ({ page }) => {
    await page.goto('/login')
    await page.fill('#email', QLCH.email!)
    await page.fill('#password', QLCH.password!)
    await page.getByRole('button', { name: /^đăng nhập$/i }).click()
    await page.waitForURL(/\/(tasks|dashboard|targets)/, { timeout: 20_000 })
    const nav: Locator = page.getByRole('navigation', { name: 'Điều hướng chính' })
    await expect(nav).toBeVisible()
    await expect(nav.getByRole('button', { name: 'Thêm' })).toHaveCount(1)
    const g = await navGeometry(page)
    expect(g!.legacy).toBe(0)
    expect(g!.above, 'QLCH: phần tử nhô khỏi pill').toEqual([])
    expect(g!.mainPb, 'QLCH: <main> padding-bottom (clearance cũ = 60 + 7.5 + 14 + 8 + 8, safe-area 0)').toBeCloseTo(97.5, 1)
  })
})
