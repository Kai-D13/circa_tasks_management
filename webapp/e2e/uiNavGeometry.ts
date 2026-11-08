import { expect, type Page, type TestInfo } from '@playwright/test'

// UI-NAV r1 — helper hình học khung điều hướng mobile, dùng chung cho ui-nav-safe-area (trang thật) và ui-nav-shell-fixture
// (fixture vai không có tài khoản). Module thường (không phải .spec) để hai spec cùng import.
// Safe-area giả lập CHỈ ở lớp môi trường CSS: CDP `Emulation.setSafeAreaInsetsOverride` đổi giá trị `env(safe-area-inset-*)`;
// công thức token (globals.css) và markup thật giữ nguyên — test không đặt padding nào. Không phải iPhone thật.

export const NAV_H = 60, NAV_OFFSET = 7.5, GAP = 8, LEGACY_EXTRA = 22   // --bottom-nav-h / -offset / -content-gap; 14 + 8 (vai khác)

export async function setSafeArea(page: Page, bottom: number) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 0, right: 0, bottom } })
}

/** Giá trị env thật trang nhận (phần tử thăm dò tạm, gỡ ngay — không đổi bố cục khi đo). */
export async function envInset(page: Page): Promise<number> {
  return page.evaluate(() => {
    const d = document.createElement('div')
    d.style.cssText = 'position:fixed;left:-9999px;top:0;padding-bottom:env(safe-area-inset-bottom)'
    document.body.appendChild(d)
    const v = parseFloat(getComputedStyle(d).paddingBottom)
    d.remove()
    return v
  })
}

/** Mở route, chờ BottomNav hydrate (vai đọc từ store client sau effect của UserProvider), cuộn <main> xuống đáy. */
export async function settle(page: Page, route: string, withNav: boolean) {
  await page.goto(route)
  await expect(page, 'bị đẩy về /login ⇒ storageState hết hạn').not.toHaveURL(/\/login/)
  if (withNav) await expect(page.locator('[data-bottom-nav] a').first()).toBeAttached({ timeout: 20_000 })
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
  await page.evaluate(() => { const m = document.querySelector('main'); if (m) m.scrollTop = m.scrollHeight })
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
}

export async function geometry(page: Page) {
  return page.evaluate(() => {
    const main = document.querySelector('main')!
    const nav = document.querySelector<HTMLElement>('[data-bottom-nav]')
    const pill = nav?.firstElementChild as HTMLElement | null
    const p = pill?.getBoundingClientRect()
    const last = [...main.children].filter((el) => el.getBoundingClientRect().height > 0).pop()
    const sticky = document.querySelector<HTMLElement>('[data-sticky-action]')
    const cta = sticky?.querySelector<HTMLElement>('a, button')
    return {
      vh: window.innerHeight, vw: window.innerWidth,
      mainPb: parseFloat(getComputedStyle(main).paddingBottom),
      nav: !!nav, navVisible: !!nav && nav.getBoundingClientRect().height > 0,
      navPb: nav ? parseFloat(getComputedStyle(nav).paddingBottom) : null,
      pillTop: p ? p.top : null, pillBottom: p ? p.bottom : null, pillH: p ? p.height : null,
      tabs: pill ? [...pill.querySelectorAll<HTMLElement>(':scope > a, :scope > button')].map((el) => ({
        href: el.getAttribute('href'), label: el.getAttribute('aria-label'), w: el.getBoundingClientRect().width,
      })) : [],
      lastBottom: last ? last.getBoundingClientRect().bottom : null,
      lastDesc: last ? `${last.tagName.toLowerCase()}.${String(last.className || '').split(' ').slice(0, 2).join('.')}` : '',
      sticky: sticky ? { top: sticky.getBoundingClientRect().top, bottom: sticky.getBoundingClientRect().bottom, pb: parseFloat(getComputedStyle(sticky).paddingBottom) } : null,
      ctaBottom: cta ? cta.getBoundingClientRect().bottom : null,
    }
  })
}
export type Geo = Awaited<ReturnType<typeof geometry>>

export async function attachJson(testInfo: TestInfo, name: string, data: unknown) {
  await testInfo.attach(name, { body: JSON.stringify(data, null, 1), contentType: 'application/json' })
}

/** Thanh tab + <main> của một vai mobile ở một inset. `flat` = staff OS (pill + 15.5 px), còn lại thêm 22 px. `pillH` = chiều cao
 *  pill mong đợi (60 px một hàng; UI-NAV-D07 reflow: 98 / 146 px — `pillHeight(bottomNavLayout(vw).rows)`). <main> phải tăng CÙNG
 *  pill: clearance = pillH + offset + gap (+ 22) + inset (safe-area một lần). */
export function expectMobileShell(g: Geo, inset: number, flat: boolean, where: string, pillH: number = NAV_H) {
  const want = pillH + NAV_OFFSET + GAP + (flat ? 0 : LEGACY_EXTRA) + inset
  expect(g.nav && g.navVisible, `${where}: phải có thanh tab`).toBe(true)
  expect(g.mainPb, `${where}: <main> chừa ${g.mainPb}px, cần ${want}px`).toBeCloseTo(want, 1)
  expect(g.navPb, `${where}: nav đệm đáy = offset + inset`).toBeCloseTo(NAV_OFFSET + inset, 1)
  expect(g.pillH, `${where}: chiều cao pill`).toBeCloseTo(pillH, 1)
  expect(g.pillBottom!, `${where}: pill phải dịch lên đúng inset`).toBeCloseTo(g.vh - NAV_OFFSET - inset, 1)
  expect(g.lastBottom, `${where}: không thấy phần tử cuối của <main>`).not.toBeNull()
  expect(g.pillTop! - g.lastBottom!, `${where}: phần tử cuối (${g.lastDesc}) cách mép trên pill ${(g.pillTop! - g.lastBottom!).toFixed(1)}px`).toBeGreaterThanOrEqual(GAP - 0.5)
}

/** UI-NAV-D07 — từng ô của thanh tab (link + nút Thêm) theo CSS px (getBoundingClientRect, KHÔNG nhân DPR): khung, trong viewport /
 *  trong pill, hit-test tâm ô (elementFromPoint phải trúng chính control), nhãn đang hiện, tên accessible (aria-label), icon trang trí
 *  aria-hidden, badge (chữ + có nằm trong ô). Hàng = các giá trị top khác nhau (làm tròn 0,5 px). */
export async function navItems(page: Page) {
  return page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>('[data-bottom-nav]')
    const pill = nav?.querySelector<HTMLElement>(':scope > [data-nav-pill]') ?? (nav?.firstElementChild as HTMLElement | null)
    if (!nav || !pill) return null
    const P = pill.getBoundingClientRect()
    const cs = getComputedStyle(document.documentElement)
    const items = [...pill.querySelectorAll<HTMLElement>(':scope > a, :scope > button')].map((el) => {
      const r = el.getBoundingClientRect()
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2
      const hit = document.elementFromPoint(cx, cy)
      const label = el.querySelector<HTMLElement>('[data-nav-label]')
      const badge = [...el.querySelectorAll('span')].find((s) => s.children.length === 0 && /^\d+\+?$/.test((s.textContent || '').trim()))
      const br = badge?.getBoundingClientRect()
      return {
        tag: el.tagName.toLowerCase(), href: el.getAttribute('href'), name: el.getAttribute('aria-label'), current: el.getAttribute('aria-current'),
        x: r.left, y: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height,
        inVp: r.left >= -0.5 && r.right <= innerWidth + 0.5 && r.top >= -0.5 && r.bottom <= innerHeight + 0.5,
        inPill: r.left >= P.left - 0.5 && r.right <= P.right + 0.5 && r.top >= P.top - 0.5 && r.bottom <= P.bottom + 0.5,
        hitOk: !!hit && (hit === el || el.contains(hit)),
        labelShown: !!label && getComputedStyle(label).display !== 'none' && label.getBoundingClientRect().width > 0,
        labelInside: !label || getComputedStyle(label).display === 'none' || (label.getBoundingClientRect().left >= r.left - 0.5 && label.getBoundingClientRect().right <= r.right + 0.5),
        iconsHidden: [...el.querySelectorAll('svg')].every((svg) => svg.getAttribute('aria-hidden') === 'true'),
        badge: br ? { text: (badge!.textContent || '').trim(), inCell: br.left >= r.left - 0.5 && br.right <= r.right + 0.5 && br.top >= r.top - 0.5 && br.bottom <= r.bottom + 0.5 } : null,
      }
    })
    const rows = [...new Set(items.map((i) => Math.round(i.y * 2) / 2))].sort((a, b) => a - b)
    return {
      vw: innerWidth, vh: innerHeight, reflow: nav.hasAttribute('data-nav-reflow'), controls: Number(nav.getAttribute('data-nav-controls')),
      pill: { l: P.left, r: P.right, t: P.top, b: P.bottom, h: P.height },
      rootNavH: cs.getPropertyValue('--bottom-nav-h').trim(), rootRows: cs.getPropertyValue('--bottom-nav-rows').trim(),
      items, rows: rows.length, perRow: rows.map((y) => items.filter((i) => Math.round(i.y * 2) / 2 === y).length),
      docOverflowX: document.documentElement.scrollWidth - innerWidth,
    }
  })
}
export type NavItems = NonNullable<Awaited<ReturnType<typeof navItems>>>

/** Mọi ô ≥ 44×44 CSS px, nằm trong viewport + pill, tâm ô trúng chính control, không chồng nhau; trang không cuộn ngang. */
export function expectTargets(m: NavItems, where: string) {
  for (const i of m.items) {
    expect(i.w, `${where} · ${i.name}: rộng ${i.w.toFixed(2)} CSS px`).toBeGreaterThanOrEqual(44)
    expect(i.h, `${where} · ${i.name}: cao ${i.h.toFixed(2)} CSS px`).toBeGreaterThanOrEqual(44)
    expect(i.inVp, `${where} · ${i.name}: ra ngoài khung nhìn (x ${i.x.toFixed(1)}–${i.r.toFixed(1)}, vw ${m.vw})`).toBe(true)
    expect(i.inPill, `${where} · ${i.name}: ra ngoài pill`).toBe(true)
    expect(i.hitOk, `${where} · ${i.name}: tâm ô không trúng chính control`).toBe(true)
    expect(i.labelInside, `${where} · ${i.name}: nhãn tràn khỏi ô`).toBe(true)
    expect(i.iconsHidden, `${where} · ${i.name}: icon trang trí phải aria-hidden`).toBe(true)
    if (i.badge) expect(i.badge.inCell, `${where} · ${i.name}: badge lọt khỏi ô`).toBe(true)
  }
  for (let a = 0; a < m.items.length; a++) for (let b = a + 1; b < m.items.length; b++) {
    const A = m.items[a], B = m.items[b]
    const overlap = Math.min(A.r, B.r) - Math.max(A.x, B.x) > 0.5 && Math.min(A.b, B.b) - Math.max(A.y, B.y) > 0.5
    expect(overlap, `${where}: ${A.name} chồng ${B.name}`).toBe(false)
  }
  expect(m.docOverflowX, `${where}: trang cuộn ngang`).toBeLessThanOrEqual(0)
}
