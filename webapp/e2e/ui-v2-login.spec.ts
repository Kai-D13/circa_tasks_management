import { test, expect, type Page } from '@playwright/test'
import { LOGIN_CREDENTIAL_ERROR } from '../lib/auth/loginCopy'

// UI v2 Login (artboard L1–L3 / M1–M3). Route thật /login (CHƯA đăng nhập) + fixture /login/ui-catalog?state= (render
// ĐÚNG LoginScreen với trạng thái ép, không gắn server action). Kiểm:
//   - giữ luồng: name/type/required/autocomplete, Server Action, hard navigation (đăng nhập thật bằng tài khoản E2E);
//   - nút mắt type=button (không gửi form, không mất giá trị), nhãn Hiện/Ẩn, thứ tự Tab email → mật khẩu → mắt → nút;
//   - validation trình duyệt chặn gửi rỗng / email sai; lỗi credential tô viền ô mật khẩu, lỗi khác chỉ alert;
//     email giữ giá trị sau lỗi, mật khẩu được xoá; bận ⇒ nút khoá + vòng quay + "Đang đăng nhập…";
//   - bố cục desktop 1024/1280/1440 (2 vùng) và mobile 360/390 (panel ~250px + sheet đè 28px), màn thấp cuộn tới
//     nút; sáng/tối theo lựa chọn của app; không cuộn ngang.

test.use({ storageState: { cookies: [], origins: [] } })
const THEMES = ['light', 'dark'] as const
type Theme = (typeof THEMES)[number]
const STAFF = { email: process.env.E2E_STAFF_EMAIL, password: process.env.E2E_STAFF_PASSWORD }
const CANVAS = { light: 'rgb(247, 246, 244)', dark: 'rgb(18, 17, 16)' }
const BUSY_BG = { light: 'rgb(217, 120, 79)', dark: 'rgb(185, 103, 63)' }

async function open(page: Page, url: string, theme: Theme, size: { width: number; height: number }) {
  await page.setViewportSize(size)
  await page.goto(url)
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
  await page.locator('[data-login]').waitFor({ state: 'visible', timeout: 20_000 })
  await page.evaluate(() => document.fonts.ready)
}

async function noHorizontalScroll(page: Page, where: string) {
  const g = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }))
  expect(g.sw, `${where}: cuộn ngang`).toBeLessThanOrEqual(g.iw + 1)
}

const box = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => {
  const r = el.getBoundingClientRect(); return { x: r.x, y: r.y + window.scrollY, w: r.width, h: r.height, bottom: r.bottom + window.scrollY }
})

test.describe('ui v2 Login @desktop', () => {
  test('route thật: gốc v2, chữ theo artboard, form giữ hợp đồng auth (name/type/required/autocomplete)', async ({ page }) => {
    await open(page, '/login', 'light', { width: 1280, height: 900 })
    await expect(page).toHaveTitle('Đăng nhập — Circa Tasks')
    const root = page.locator('[data-login]')
    await expect(root).toHaveAttribute('data-ui-v2', 'page')
    await expect(root.locator('h1')).toHaveText('Đăng nhập')
    await expect(root).toContainText('Dùng tài khoản Circa Tasks được cấp cho bạn.')
    await expect(root).toContainText('Mọi việc ở nhà thuốc, gọn trong một nơi.')
    expect(await root.locator('ul[aria-label="Giới thiệu Circa Tasks"] li').allInnerTexts()).toEqual([
      'Nhận task và nộp kết quả ngay trên điện thoại', 'Theo dõi doanh số chiến dịch theo từng ngày', 'Chăm sóc khách hàng và bảng tin nội bộ',
    ])
    await expect(root).toContainText('Hệ thống nội bộ Circa · chỉ dành cho tài khoản được cấp')
    // Quên mật khẩu = CHỮ hướng dẫn, không link / không luồng reset mới
    const help = root.getByText('Quên mật khẩu? Liên hệ Admin hoặc Quản lý vùng để được cấp lại.')
    await expect(help).toBeVisible()
    expect(await help.evaluate((el) => el.tagName)).toBe('P')
    await expect(root.locator('a')).toHaveCount(0)
    await expect(root).toContainText(`© ${new Date().getFullYear()} Circa`)
    const email = page.locator('#email'), pw = page.locator('#password')
    expect(await email.evaluate((el: HTMLInputElement) => [el.name, el.type, el.required, el.autocomplete, el.placeholder, el.value]))
      .toEqual(['email', 'email', true, 'email', 'ten@circa.vn', ''])
    expect(await pw.evaluate((el: HTMLInputElement) => [el.name, el.type, el.required, el.autocomplete, el.placeholder]))
      .toEqual(['password', 'password', true, 'current-password', 'Nhập mật khẩu'])
    await expect(page.getByLabel('Email', { exact: true })).toHaveAttribute('id', 'email')
    await expect(page.getByLabel('Mật khẩu', { exact: true })).toHaveAttribute('id', 'password')
    const submit = page.getByRole('button', { name: /^đăng nhập$/i })
    await expect(submit).toBeEnabled()
    await expect(submit).toHaveAttribute('type', 'submit')
    await expect(root.getByRole('alert')).toHaveCount(0)
  })

  test('nút mắt: type=button, không gửi form, giữ giá trị; Tab email → mật khẩu → mắt → nút; validation chặn gửi', async ({ page }) => {
    await open(page, '/login', 'light', { width: 1280, height: 900 })
    const posts: string[] = []
    page.on('request', (r) => { if (r.method() === 'POST') posts.push(r.url()) })
    const pw = page.locator('#password')
    await page.locator('#email').fill('duocsi.qa@example.invalid')
    await pw.fill('mat-khau-gia')
    const eye = page.getByRole('button', { name: 'Hiện mật khẩu' })
    await expect(eye).toHaveAttribute('type', 'button')
    await expect(eye).toHaveAttribute('aria-pressed', 'false')
    await eye.click()
    await expect(pw).toHaveAttribute('type', 'text')
    await expect(page.getByRole('button', { name: 'Ẩn mật khẩu' })).toHaveAttribute('aria-pressed', 'true')
    await expect(pw).toHaveValue('mat-khau-gia')
    await page.keyboard.press('Enter') // bàn phím trên nút mắt: chỉ đổi lại, KHÔNG gửi form
    await expect(pw).toHaveAttribute('type', 'password')
    await expect(pw).toHaveValue('mat-khau-gia')
    await expect(page.locator('#email')).toHaveValue('duocsi.qa@example.invalid')
    expect(posts, 'nút mắt làm gửi form').toEqual([])
    // Thứ tự Tab
    await page.locator('#email').focus()
    const order: string[] = []
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Tab')
      order.push(await page.evaluate(() => { const a = document.activeElement as HTMLElement; return a.id || a.getAttribute('aria-label') || a.textContent?.trim() || a.tagName }))
    }
    expect(order).toEqual(['password', 'Hiện mật khẩu', 'Đăng nhập'])
    // Validation trình duyệt: rỗng / email sai ⇒ không gửi
    await page.locator('#email').fill('')
    await page.getByRole('button', { name: /^đăng nhập$/i }).click()
    expect(await page.locator('#email').evaluate((el: HTMLInputElement) => el.validity.valueMissing)).toBe(true)
    await page.locator('#email').fill('khong-phai-email')
    await page.getByRole('button', { name: /^đăng nhập$/i }).click()
    expect(await page.locator('#email').evaluate((el: HTMLInputElement) => el.validity.typeMismatch)).toBe(true)
    await page.waitForTimeout(300)
    expect(posts, 'form không hợp lệ vẫn gửi').toEqual([])
    await expect(page.locator('[data-login]').getByRole('alert')).toHaveCount(0)
  })

  test('lỗi thật từ server (1 lần đăng nhập sai bằng email giả): đúng chữ, viền mật khẩu, giữ email, xoá mật khẩu', async ({ page }) => {
    await open(page, '/login', 'light', { width: 390, height: 844 })
    await page.locator('#email').fill('ui-v2-login-qa@example.invalid')
    await page.locator('#password').fill('khong-dung-123')
    await page.getByRole('button', { name: /^đăng nhập$/i }).click()
    const alert = page.locator('[data-login]').getByRole('alert')
    await expect(alert).toBeVisible({ timeout: 20_000 })
    // Server có thể trả credential hoặc lỗi khác (vd giới hạn tần suất) — chữ hiện NGUYÊN, viền chỉ khi credential
    const text = (await alert.innerText()).trim()
    const pwBorder = await page.locator('[data-login-password]').evaluate((el) => getComputedStyle(el).borderTopColor)
    const danger = await page.locator('[data-login]').evaluate((el) => {
      const s = document.createElement('span'); s.className = 'text-status-danger'; el.appendChild(s)
      const c = getComputedStyle(s).color; s.remove(); return c
    })
    if (text === LOGIN_CREDENTIAL_ERROR) expect(pwBorder, 'lỗi credential phải tô viền ô mật khẩu').toBe(danger)
    else expect(pwBorder, `lỗi khác ("${text}") không được quy cho mật khẩu`).not.toBe(danger)
    await expect(page.locator('#email')).toHaveValue('ui-v2-login-qa@example.invalid')
    await expect(page.locator('#password')).toHaveValue('')
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByRole('button', { name: /^đăng nhập$/i })).toBeEnabled()
  })

  test('đăng nhập thật (tài khoản E2E staff): nút bận tới khi chuyển trang, hard navigation theo vai', async ({ page }) => {
    test.skip(!STAFF.email || !STAFF.password, 'E2E_STAFF_* chưa set')
    await open(page, '/login', 'light', { width: 390, height: 844 })
    await page.locator('#email').fill(STAFF.email!)
    await page.locator('#password').fill(STAFF.password!)
    const docNav = page.waitForRequest((r) => r.isNavigationRequest() && r.frame() === page.mainFrame() && !r.url().includes('/login'), { timeout: 30_000 })
    await page.getByRole('button', { name: /^đăng nhập$/i }).click()
    await expect(page.getByRole('button', { name: 'Đang đăng nhập…' })).toBeDisabled({ timeout: 5_000 })
    const nav = await docNav // hard navigation = request điều hướng tài liệu (không phải RSC fetch của router)
    expect(nav.headers()['rsc'], 'chuyển trang phải là hard navigation').toBeUndefined()
    await page.waitForURL(/\/(tasks|dashboard|targets|fs)/, { timeout: 30_000 })
  })

  test('fixture trạng thái: lỗi credential / lỗi khác / đang đăng nhập (sáng + tối)', async ({ page }) => {
    for (const theme of THEMES) {
      await open(page, '/login/ui-catalog?state=credential', theme, { width: 1280, height: 900 })
      const danger = await page.locator('[data-login]').evaluate((el) => {
        const s = document.createElement('span'); s.className = 'text-status-danger'; el.appendChild(s)
        const c = getComputedStyle(s).color; s.remove(); return c
      })
      await expect(page.locator('[data-login]').getByRole('alert')).toHaveText(LOGIN_CREDENTIAL_ERROR)
      expect(await page.locator('[data-login-password]').evaluate((el) => getComputedStyle(el).borderTopColor)).toBe(danger)
      await expect(page.locator('#password')).toHaveAttribute('aria-invalid', 'true')
      await expect(page.locator('#email')).toHaveValue('duocsi.qa@example.invalid')

      await open(page, '/login/ui-catalog?state=other', theme, { width: 1280, height: 900 })
      await expect(page.locator('[data-login]').getByRole('alert')).toHaveText('Request rate limit reached')
      expect(await page.locator('[data-login-password]').evaluate((el) => getComputedStyle(el).borderTopColor)).not.toBe(danger)
      await expect(page.locator('#password')).not.toHaveAttribute('aria-invalid', 'true')

      await open(page, '/login/ui-catalog?state=pending', theme, { width: 1280, height: 900 })
      const btn = page.getByRole('button', { name: 'Đang đăng nhập…' })
      await expect(btn).toBeDisabled()
      await expect(btn.locator('.animate-spin')).toHaveCount(1)
      expect(await btn.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(BUSY_BG[theme])
      expect(await page.locator('[data-login]').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(CANVAS[theme])
    }
  })

  for (const theme of THEMES) {
    for (const w of [1024, 1280, 1440]) {
      test(`desktop ${w} ${theme}: 2 vùng cạnh nhau, form ≤ 380px giữa, không cuộn ngang`, async ({ page }) => {
        await open(page, '/login', theme, { width: w, height: 900 })
        await noHorizontalScroll(page, `${w} ${theme}`)
        const aside = await box(page, '[data-login] aside'), form = await box(page, '[data-login] form')
        expect(aside.x).toBe(0)
        expect(aside.y).toBe(0)
        expect(form.x, 'form phải nằm bên phải panel').toBeGreaterThanOrEqual(aside.x + aside.w)
        expect(form.w).toBeLessThanOrEqual(381)
        expect(aside.h, 'panel phủ hết chiều cao').toBeGreaterThanOrEqual(899)
        await expect(page.locator('[data-login] ul[aria-label="Giới thiệu Circa Tasks"]')).toBeVisible()
        expect(await page.locator('#email').evaluate((el) => getComputedStyle(el).fontSize)).toBe('15px')
        expect(await page.locator('[data-login]').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(CANVAS[theme])
        if (w === 1440) {
          expect(await page.screenshot({ fullPage: true, animations: 'disabled' })).toMatchSnapshot(`login-${theme}-d1440.png`, { maxDiffPixelRatio: 0.01 })
        }
      })
    }
    for (const w of [360, 390]) {
      test(`mobile ${w} ${theme}: panel ~250px + sheet đè 28px, chữ ô 16px, chạm ≥44px, màn thấp cuộn tới nút`, async ({ page }) => {
        await open(page, '/login', theme, { width: w, height: 844 })
        await noHorizontalScroll(page, `${w} ${theme}`)
        const aside = await box(page, '[data-login] aside')
        const sheet = await box(page, '[data-login] aside + div')
        expect(aside.h).toBeGreaterThanOrEqual(240)
        expect(aside.h).toBeLessThanOrEqual(260)
        expect(Math.round(aside.bottom - sheet.y), 'sheet phải đè panel 28px').toBe(28)
        await expect(page.locator('[data-login] ul[aria-label="Giới thiệu Circa Tasks"]')).toBeHidden()
        for (const id of ['#email', '#password']) expect(await page.locator(id).evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px')
        for (const sel of ['button[aria-controls="password"]', 'button[type="submit"]']) {
          const b = await box(page, `[data-login] ${sel}`)
          expect(Math.min(b.w, b.h), `${sel} < 44px`).toBeGreaterThanOrEqual(44)
        }
        if (w === 390) {
          expect(await page.screenshot({ fullPage: true, animations: 'disabled' })).toMatchSnapshot(`login-${theme}-m390.png`, { maxDiffPixelRatio: 0.01 })
          // Màn thấp / bàn phím mở: trang cuộn dọc (không khoá chiều cao), tới được nút Đăng nhập
          await page.setViewportSize({ width: w, height: 480 })
          const g = await page.evaluate(() => ({ sh: document.documentElement.scrollHeight, ih: window.innerHeight, ov: getComputedStyle(document.querySelector('[data-login]')!).overflowY }))
          expect(g.sh, 'màn thấp phải cuộn được').toBeGreaterThan(g.ih)
          expect(g.ov).not.toBe('hidden')
          const submit = page.getByRole('button', { name: /^đăng nhập$/i })
          await submit.scrollIntoViewIfNeeded()
          await expect(submit).toBeInViewport()
        }
      })
    }
  }

  test('fixture: trạng thái lạ ⇒ mặc định; ảnh lỗi (390 sáng) + đang đăng nhập (1440 tối)', async ({ page }) => {
    await open(page, '/login/ui-catalog?state=khong-co', 'light', { width: 390, height: 844 })
    await expect(page.getByTestId('login-fixture')).toHaveAttribute('data-state', 'default')
    // Fixture không gắn action: Enter KHÔNG được gửi form (không GET mang email/mật khẩu lên URL)
    await page.locator('#email').fill('duocsi.qa@example.invalid')
    await page.locator('#password').fill('mat-khau-gia')
    await page.locator('#password').press('Enter')
    await page.waitForTimeout(300)
    expect(new URL(page.url()).search).toBe('?state=khong-co')
    await open(page, '/login/ui-catalog?state=credential', 'light', { width: 390, height: 844 })
    expect(await page.screenshot({ fullPage: true, animations: 'disabled' })).toMatchSnapshot('login-credential-light-m390.png', { maxDiffPixelRatio: 0.01 })
    await open(page, '/login/ui-catalog?state=pending', 'dark', { width: 1440, height: 900 })
    expect(await page.screenshot({ fullPage: true, animations: 'disabled' })).toMatchSnapshot('login-pending-dark-d1440.png', { maxDiffPixelRatio: 0.01 })
  })
})
