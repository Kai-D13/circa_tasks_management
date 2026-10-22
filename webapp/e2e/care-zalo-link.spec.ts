import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page, type Request } from '@playwright/test'
import { SUPER_STATE } from './authState'
import { CARE_ZALO_PHONE_RE, careZaloHref } from '../lib/care/zalo'
import { careZaloLinkEnabledFromEnv } from '../lib/care/config'
import { normalizeVnPhone } from '../lib/affiliate/phone'

// CRM-CSKH lát C1 (Q-154, PM 21/10 #3) — nút Zalo trên chi tiết khách của dược sĩ, sau cờ CARE_ZALO_LINK_ENABLED (mặc định OFF).
// • Thuần + nguồn (@desktop, không cần server): số hợp lệ ⇒ https://zalo.me/<số>; cờ chỉ đúng 'true'; link chỉ từ phone_norm của
//   task; không target / timer / tự chuyển SMS; giữ đúng MỘT tel: và MỘT sms:; server quyết cờ.
// • UI (@mobile 390 / 360, mock /ui-catalog/care-zalo — UI_CATALOG=1 + super): cờ OFF y như cũ; cờ ON có Gọi khách + Zalo +
//   SMS dự phòng ≥ 44px, sáng / tối, không tràn ngang; số sai ⇒ ghi chú, không link; bấm Zalo ⇒ 0 request tới app, không Referer.

const ROOT = path.resolve(__dirname, '..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8')
// Mã không kèm comment (cùng cách care-qa-ui.spec.ts đếm tel:/sms:).
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '')
const HAS_SUPER = fs.existsSync(SUPER_STATE)
const PHONE = '0390000901'

test.describe('care C1 — Zalo: thuần + nguồn @desktop', () => {
  test('careZaloHref: chỉ SĐT chuẩn hoá 10 số đầu 03/05/07/08/09 ⇒ https://zalo.me/<số>; còn lại null', () => {
    for (const p of ['0390000901', '0512345678', '0712345678', '0812345678', '0912345678']) {
      expect(careZaloHref(p), p).toBe(`https://zalo.me/${p}`)
    }
    for (const p of ['', '0190000901', '0212345678', '039000090', '03900009011', '+84390000901', '84390000901', '0390 000 901',
      '039000090a', ' 0390000901', '0390000901 ', '0390000901/x', 'javascript:alert(1)', '0390000901?a=1']) {
      expect(careZaloHref(p), JSON.stringify(p)).toBeNull()
    }
    expect(CARE_ZALO_PHONE_RE.source).toBe('^0[35789][0-9]{8}$')
    // Cùng ràng buộc phone_norm của 114 (số trong task luôn hợp lệ; nhánh null là phòng thủ).
    expect(read('../supabase/migrations/114_care_crm_foundation.sql')).toMatch(/phone_norm\s+text NOT NULL CHECK \(phone_norm ~ '\^0\[35789\]\[0-9\]\{8\}\$'\)/)
    // security C1 P2-2: cùng quy tắc với normalizeVnPhone (nguồn identity khách, AGENTS §4.8) — mở rộng đầu số ở một nơi ⇒ test đỏ.
    expect(read('lib/affiliate/phone.ts')).toContain(`const VN_MOBILE_RE = /${CARE_ZALO_PHONE_RE.source}/`)
    for (const raw of ['0390000901', '+84 390 000 901', '84390000901', '0390.000.901', '0190000901', '0390000', 'abc']) {
      const n = normalizeVnPhone(raw)
      expect(n === null ? null : careZaloHref(n), raw).toBe(n === null ? null : `https://zalo.me/${n}`)
    }
  })

  test('cờ CARE_ZALO_LINK_ENABLED chỉ bật với đúng chuỗi "true"; server-only, cần CARE_ENABLED; khai báo OFF trong .env.example', () => {
    expect(careZaloLinkEnabledFromEnv({ CARE_ZALO_LINK_ENABLED: 'true' })).toBe(true)
    for (const v of [undefined, '', 'false', '1', 'TRUE', 'True', ' true', 'true ', 'yes']) {
      expect(careZaloLinkEnabledFromEnv({ CARE_ZALO_LINK_ENABLED: v }), String(v)).toBe(false)
    }
    expect(careZaloLinkEnabledFromEnv({})).toBe(false)
    const flags = read('lib/care/flags.ts')
    expect(flags).toMatch(/^import 'server-only'/)
    expect(flags).toContain('return isCareEnabled() && careZaloLinkEnabledFromEnv(process.env)')
    expect(read('.env.example')).toMatch(/^CARE_ZALO_LINK_ENABLED=false$/m)
  })

  test('nguồn: link Zalo chỉ từ phone_norm của task đang xem; cùng tab, không referrer, không timer / tự chuyển SMS; đúng 1 tel: + 1 sms:', () => {
    const detail = code('components/care/CareMyTaskDetail.tsx')
    expect(detail.match(/careZaloHref\(/g)).toHaveLength(1)
    expect(detail).toContain('const zaloHref = zalo ? careZaloHref(t.phone_norm) : null')
    expect(detail.match(/href=\{zaloHref\}/g)).toHaveLength(1)
    expect(detail).toContain('<a href={zaloHref} rel="noopener noreferrer" referrerPolicy="no-referrer" data-testid="care-contact-zalo"')
    expect(detail).not.toMatch(/target=|setTimeout|setInterval|location\.|window\.open|fetch\(|navigator\.|zalo\.me|zalo:\/\/|intent:/)
    expect(detail.match(/href=\{`(tel|sms):\$\{t\.phone_norm\}`\}/g)).toHaveLength(2)
    expect(detail.match(/(tel|sms):/g)).toHaveLength(2)
    // Server quyết cờ; trang không đụng SĐT (care-qa-ui.spec.ts cũng ghim).
    const page = code('app/(dashboard)/care/my/[id]/page.tsx')
    expect(page).toContain('zalo={isCareZaloLinkEnabled()}')
    expect(page).not.toMatch(/phone_(raw|norm)|zalo\.me/)
    // URL Zalo chỉ dựng ở một hàm thuần; không env, không log.
    const lib = code('lib/care/zalo.ts')
    expect(lib).not.toMatch(/process\.env|console\.|NEXT_PUBLIC/)
    for (const dir of ['app', 'components', 'lib']) {
      const hits: string[] = []
      const walk = (d: string) => {
        for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
          const rel = path.posix.join(d, e.name)
          if (e.isDirectory()) walk(rel)
          else if (/\.(ts|tsx)$/.test(e.name) && code(rel).includes('zalo.me')) hits.push(rel)
        }
      }
      walk(dir)
      expect(hits, dir).toEqual(dir === 'lib' ? ['lib/care/zalo.ts'] : [])
    }
  })
})

async function open(page: Page, query: string, theme: 'light' | 'dark' = 'light') {
  await page.goto(`/ui-catalog/care-zalo?${query}`)
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
  await page.locator('main [data-testid="care-my-detail"]').waitFor({ timeout: 20_000 })
  return page.locator('main section[aria-label="Thông tin liên hệ"]')
}
const noPageOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
async function minHeight44(loc: ReturnType<Page['locator']>, name: string) {
  const box = await loc.boundingBox()
  expect(box, name).not.toBeNull()
  expect(box!.height, name).toBeGreaterThanOrEqual(44)
}

test.describe('care C1 — Zalo: UI chi tiết khách (mock) @mobile', () => {
  test.skip(!HAS_SUPER, 'chưa có storageState super')
  test.use({ storageState: SUPER_STATE })

  test('cờ OFF: y như cũ — đúng 2 link Gọi khách (tel:) + Nhắn tin (sms:), không Zalo, không gợi ý', async ({ page }) => {
    const sec = await open(page, 'zalo=0')
    await expect(sec.locator('a')).toHaveCount(2)
    await expect(sec.getByRole('link', { name: 'Gọi khách' })).toHaveAttribute('href', `tel:${PHONE}`)
    await expect(sec.getByRole('link', { name: 'Nhắn tin' })).toHaveAttribute('href', `sms:${PHONE}`)
    await expect(sec.locator('a[href*="zalo"]')).toHaveCount(0)
    await expect(sec.getByTestId('care-contact-zalo-hint')).toHaveCount(0)
    await expect(sec.getByTestId('care-contact-zalo-invalid')).toHaveCount(0)
    await expect(sec.getByText('SMS dự phòng')).toHaveCount(0)
  })

  for (const theme of ['light', 'dark'] as const) {
    test(`cờ ON (${theme}): Gọi khách + Zalo + SMS dự phòng (một sms:), ≥ 44px, không tràn ngang, link Zalo cùng tab không referrer`, async ({ page }) => {
      const sec = await open(page, 'zalo=1', theme)
      await expect(sec.locator('a')).toHaveCount(3)
      const call = sec.getByRole('link', { name: 'Gọi khách' })
      const zalo = sec.getByRole('link', { name: 'Zalo', exact: true })
      const sms = sec.getByRole('link', { name: 'SMS dự phòng' })
      await expect(call).toHaveAttribute('href', `tel:${PHONE}`)
      await expect(zalo).toHaveAttribute('href', `https://zalo.me/${PHONE}`)
      await expect(sms).toHaveAttribute('href', `sms:${PHONE}`)
      await expect(sec.locator('a[href^="sms:"]')).toHaveCount(1)
      await expect(sec.locator('a[href^="tel:"]')).toHaveCount(1)
      expect(await zalo.getAttribute('target')).toBeNull()
      await expect(zalo).toHaveAttribute('rel', 'noopener noreferrer')
      await expect(zalo).toHaveAttribute('referrerpolicy', 'no-referrer')
      for (const [l, n] of [[call, 'Gọi khách'], [zalo, 'Zalo'], [sms, 'SMS dự phòng']] as const) await minHeight44(l, n)
      // Zalo cùng hàng với Gọi khách; SMS dự phòng chiếm cả hàng dưới.
      const [bc, bz, bs] = [await call.boundingBox(), await zalo.boundingBox(), await sms.boundingBox()]
      expect(Math.abs(bc!.y - bz!.y)).toBeLessThan(2)
      expect(bs!.y).toBeGreaterThan(bc!.y + bc!.height - 1)
      expect(bs!.width).toBeGreaterThan(bc!.width + bz!.width)
      await expect(sec.getByTestId('care-contact-zalo-hint')).toHaveText('Zalo không tìm thấy khách? Quay lại đây và bấm SMS dự phòng.')
      // Màu theo token (sáng / tối khác nhau), chữ khác nền.
      const [fg, bg] = await zalo.evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el).backgroundColor])
      expect(fg).not.toBe(bg)
      expect(await noPageOverflow(page)).toBe(true)
    })
  }

  test('số sai khuôn cho Zalo ⇒ ghi chú "chưa hợp lệ" (không tuyên bố khách không có Zalo), không link Zalo, nút SMS dự phòng vẫn hiện', async ({ page }) => {
    const sec = await open(page, 'zalo=1&phone=bad')
    await expect(sec.locator('a[href*="zalo"]')).toHaveCount(0)
    await expect(sec.getByTestId('care-contact-zalo-invalid')).toHaveText('Số điện thoại chưa hợp lệ để mở Zalo.')
    await expect(sec.getByTestId('care-contact-zalo-hint')).toHaveCount(0)
    // PM P2-Z1: nhánh phòng thủ (CHECK 114 chặn số sai) — chỉ kiểm nút còn hiện, KHÔNG khẳng định SMS tới đúng người.
    await expect(sec.getByRole('link', { name: 'SMS dự phòng' })).toBeVisible()
    await minHeight44(sec.getByTestId('care-contact-zalo-invalid'), 'ô ghi chú')
    expect(await noPageOverflow(page)).toBe(true)
  })

  test('bấm Zalo: điều hướng cùng tab tới zalo.me đúng số, không Referer, 0 request tới app; chế độ QA ghi rõ Zalo', async ({ page, baseURL }) => {
    const sec = await open(page, 'zalo=1&qa=1')
    await expect(page.getByTestId('care-contact-qa')).toContainText('gọi/SMS/Zalo')
    const appOrigin = new URL(baseURL!).origin
    // Prefetch Link sau hydrate (header "UI catalog") phải xong trước khi bắt đầu đếm — chỉ đếm request do cú bấm gây ra.
    await page.waitForLoadState('networkidle')
    const zaloReqs: Request[] = []
    await page.route('https://zalo.me/**', (route) => { zaloReqs.push(route.request()); return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>zalo-qa</p>' }) })
    const appReqs: string[] = []
    page.on('request', (r) => { if (new URL(r.url()).origin === appOrigin) appReqs.push(`${r.method()} ${new URL(r.url()).pathname}`) })
    const pagesBefore = page.context().pages().length
    await sec.getByRole('link', { name: 'Zalo', exact: true }).click()
    await page.waitForURL(`https://zalo.me/${PHONE}`)
    await expect(page.getByText('zalo-qa')).toBeVisible()
    expect(page.context().pages().length).toBe(pagesBefore)   // cùng tab
    expect(zaloReqs).toHaveLength(1)
    expect(zaloReqs[0].isNavigationRequest()).toBe(true)
    expect(zaloReqs[0].headers()['referer']).toBeUndefined()
    expect(appReqs).toEqual([])
  })
})
