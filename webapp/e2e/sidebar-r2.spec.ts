import { test, expect, type Page } from '@playwright/test'

// ─────────────────────────────────────────────────────────────────────────────
// SIDEBAR r2 — BỘ TEST HÀNH VI/HÌNH HỌC CHUYÊN DỤNG (audit r2.5)
//
// Vì sao spec này tồn tại: e2e/sidebar-nav.spec.ts chỉ khoá contract ACTIVE
// (đúng 1 hàng sáng), còn mọi thứ r2 vừa dựng — bề rộng 232/64, header 56, cookie
// nhớ trạng thái thu gọn, footer không bị nav đè ở màn thấp, tooltip portal khi
// thu gọn, nhãn nhóm, dark mode — hiện KHÔNG có máy nào gác. Chúng chỉ được đối
// chiếu bằng mắt với mockup, tức là sẽ trôi im lặng ngay lần refactor kế.
//
// Ở đây KHÔNG có snapshot ảnh: đối chiếu thẩm mỹ với mockup vẫn là việc QA
// tay/stakeholder (docs/ui/UI_VISUAL_QA.md). Spec này chỉ ĐO những con số đã
// chốt và kiểm những hành vi nhị phân — thứ máy gác được và người thì hay bỏ sót.
//
// Env: E2E_SUPER_EMAIL/PASSWORD + một server đang chạy (E2E_BASE_URL) — thiếu
// thì SKIP, cùng cơ chế với e2e/sidebar-nav.spec.ts (login flow cũng lấy nguyên
// từ đó: fill → verify → submit → chờ redirect, bọc trong toPass, vì hydration
// dưới tải nhiều project có thể reset input SAU khi fill nhìn như đã thành công).
// ─────────────────────────────────────────────────────────────────────────────

const SUPER = { email: process.env.E2E_SUPER_EMAIL, password: process.env.E2E_SUPER_PASSWORD }

// Hình học đã chốt của mockup r2. Tất cả là PIXEL LITERAL trong Sidebar.tsx
// (root font-size 15px ⇒ mọi thang rem của Tailwind co 6.25%, không dùng được).
const W_EXPANDED  = 232
const W_COLLAPSED = 64
const H_HEADER    = 56
// Sai số cho phép: 1px (làm tròn sub-pixel của layout engine + border).
const TOL = 1

async function login(page: Page) {
  await page.goto('/login')
  await page.waitForLoadState('networkidle')
  await expect(async () => {
    await page.fill('#email', SUPER.email!)
    await page.fill('#password', SUPER.password!)
    await page.waitForTimeout(150)
    expect(await page.inputValue('#email')).toBe(SUPER.email)
    expect(await page.inputValue('#password')).toBe(SUPER.password)
    await page.getByRole('button', { name: /sign in/i }).click()
    await page.waitForURL(/\/(tasks|dashboard|targets|fs)/, { timeout: 10_000, waitUntil: 'commit' })
  }).toPass({ timeout: 60_000, intervals: [1_000, 2_000, 3_000] })
}

const aside  = (page: Page) => page.locator('aside')
// Nút thu gọn/mở rộng — nhận diện bằng `aria-controls`, KHÔNG bằng aria-label:
// nhãn ĐỔI theo trạng thái (nói hành động sắp xảy ra) nên dùng nó làm selector
// thì mỗi test lại phải đoán trước đang ở trạng thái nào.
const toggle = (page: Page) => page.locator('aside button[aria-controls="sidebar-nav"]')
// Header = con TRỰC TIẾP của aside có chứa nút toggle (nền primary, cao 56px).
const header = (page: Page) =>
  page.locator('aside > div').filter({ has: page.locator('button[aria-controls="sidebar-nav"]') })
// Footer = con TRỰC TIẾP của aside có chứa avatar (khối account + hàng action).
const footer = (page: Page) =>
  page.locator('aside > div').filter({ has: page.locator('[data-slot="avatar"]') })

// Bề rộng aside SAU KHI transition đã dừng. `transition-[width] duration-200`
// nghĩa là một mẫu đo ngay sau click có thể bắt được giá trị giữa chừng — và tệ
// hơn: trên máy nhanh nó tình cờ lọt tolerance, trên CI chậm thì fail. Mỗi vòng
// poll lấy HAI mẫu cách nhau 1 frame NGAY TRONG TRANG và chỉ chấp nhận khi hai
// mẫu bằng nhau ⇒ chờ đúng lúc transition kết thúc, không sleep cứng ở đâu cả.
async function expectAsideWidth(page: Page, expected: number, label: string) {
  await expect(async () => {
    const [a, b] = await aside(page).evaluate(
      (el) => new Promise<[number, number]>((resolve) => {
        const first = el.getBoundingClientRect().width
        requestAnimationFrame(() => requestAnimationFrame(
          () => resolve([first, el.getBoundingClientRect().width]),
        ))
      }),
    )
    expect(Math.abs(b - a), `${label}: bề rộng còn đang chạy transition (${a} → ${b})`).toBeLessThan(0.5)
    expect(Math.abs(b - expected), `${label}: aside ${b}px, mong đợi ${expected}±${TOL}`).toBeLessThanOrEqual(TOL)
  }).toPass({ timeout: 10_000, intervals: [100, 150, 250] })
}

// Bấm toggle + khẳng định nhãn ĐỘNG đúng trước khi bấm, rồi chờ bề rộng ổn định.
// Sau khi bấm phải RỜI CHUỘT khỏi nút: ở trạng thái thu gọn nút được bọc
// IconTooltip, con trỏ nằm lại đó sẽ bung tooltip và làm nhiễu test khác.
async function setCollapsed(page: Page, next: boolean) {
  const label = next ? 'Thu gọn thanh điều hướng' : 'Mở rộng thanh điều hướng'
  await expect(toggle(page), `nút toggle phải mang nhãn "${label}" trước khi bấm`)
    .toHaveAttribute('aria-label', label)
  await toggle(page).click()
  await page.mouse.move(900, 500)
  await expectAsideWidth(page, next ? W_COLLAPSED : W_EXPANDED, next ? 'sau khi thu gọn' : 'sau khi mở rộng')
}

test.describe('sidebar r2 @desktop', () => {
  test.skip(!SUPER.email || !SUPER.password, 'E2E_SUPER_* not set')

  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000)
    await login(page)
    await page.goto('/tasks')
    await expect(page, '/tasks bị redirect ⇒ tài khoản E2E_SUPER_* thiếu quyền?').toHaveURL(/\/tasks(\?|$)/)
    await expect(aside(page), 'không thấy <aside> — viewport < md, hay tài khoản là staff (không render sidebar)?')
      .toBeVisible()
  })

  // 1 ── Bề rộng 232/64 và header 56px CỐ ĐỊNH cả hai trạng thái. Header phải
  // không đổi chiều cao, nếu không hàng nav đầu tiên nhảy mỗi lần thu gọn.
  test('kích thước: aside 232 ⇄ 64, header 56 ở cả hai trạng thái', async ({ page }) => {
    await expectAsideWidth(page, W_EXPANDED, 'mặc định (chưa có cookie)')
    const hExpanded = (await header(page).boundingBox())!.height
    expect(Math.abs(hExpanded - H_HEADER), `header mở rộng ${hExpanded}px, mong đợi ${H_HEADER}±${TOL}`)
      .toBeLessThanOrEqual(TOL)

    await setCollapsed(page, true)
    const hCollapsed = (await header(page).boundingBox())!.height
    expect(Math.abs(hCollapsed - H_HEADER), `header thu gọn ${hCollapsed}px, mong đợi ${H_HEADER}±${TOL}`)
      .toBeLessThanOrEqual(TOL)
    // Cùng một con số ở cả 2 trạng thái — đây mới là điều kiện "không nhảy".
    expect(Math.abs(hCollapsed - hExpanded), 'header đổi chiều cao khi thu gọn ⇒ nav nhảy')
      .toBeLessThanOrEqual(TOL)

    // Và quay lại được: 64 → 232, không kẹt ở một giá trị trung gian nào.
    await setCollapsed(page, false)
  })

  // 2 ── Cookie `sidebar_collapsed` đọc SERVER-SIDE (layout truyền defaultCollapsed).
  // Điểm mấu chốt: HTML ĐẦU TIÊN đã đúng bề rộng. Nếu trạng thái chỉ được khôi
  // phục ở client (localStorage + useEffect) thì trang vẫn "nhớ", nhưng nháy 1
  // frame — nên phép đo dưới đây cố tình chạy NGAY khi DOM sẵn sàng.
  test('persistence: trạng thái thu gọn sống qua reload (cookie SSR, không giật)', async ({ page }) => {
    await setCollapsed(page, true)
    const cookie = (await page.context().cookies()).find((c) => c.name === 'sidebar_collapsed')
    expect(cookie?.value, 'thu gọn nhưng không ghi cookie sidebar_collapsed=1').toBe('1')

    await page.reload({ waitUntil: 'domcontentloaded' })
    const firstPaint = await aside(page).evaluate((el) => el.getBoundingClientRect().width)
    expect(Math.abs(firstPaint - W_COLLAPSED), `sau reload HTML server ra ${firstPaint}px ⇒ cookie chưa vào SSR (giật)`)
      .toBeLessThanOrEqual(TOL)
    await expectAsideWidth(page, W_COLLAPSED, 'sau reload (thu gọn)')

    // Chiều ngược lại cũng phải đúng — cookie phải được GHI ĐÈ về '0', không
    // phải chỉ xoá state trong bộ nhớ.
    await setCollapsed(page, false)
    expect((await page.context().cookies()).find((c) => c.name === 'sidebar_collapsed')?.value,
      'mở rộng nhưng cookie chưa về 0').toBe('0')
    await page.reload({ waitUntil: 'domcontentloaded' })
    const firstPaintBack = await aside(page).evaluate((el) => el.getBoundingClientRect().width)
    expect(Math.abs(firstPaintBack - W_EXPANDED), `sau reload HTML server ra ${firstPaintBack}px, mong đợi ${W_EXPANDED}`)
      .toBeLessThanOrEqual(TOL)
    await expectAsideWidth(page, W_EXPANDED, 'sau reload (mở rộng)')
  })

  // 3 ── Màn THẤP (1366×768 = laptop 13" phổ biến nhất): nav `flex-1
  // overflow-y-auto` + footer `shrink-0`. Bug kinh điển nếu thiếu `shrink-0`:
  // nav đẩy footer tụt khỏi viewport, người dùng không còn nút Đăng xuất.
  test('viewport thấp 1366×768: footer luôn thấy được, nav tự cuộn, không đè nhau', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 })

    for (const collapsed of [false, true]) {
      if (collapsed) await setCollapsed(page, true)
      const where = collapsed ? 'thu gọn' : 'mở rộng'

      const geo = await page.evaluate(() => {
        const nav = document.querySelector('#sidebar-nav')!
        const foot = [...document.querySelectorAll('aside > div')]
          .find((d) => d.querySelector('[data-slot="avatar"]'))!
        const n = nav.getBoundingClientRect()
        const f = foot.getBoundingClientRect()
        return {
          navBottom: n.bottom,
          footTop: f.top, footBottom: f.bottom, footHeight: f.height,
          vh: window.innerHeight,
          scrollHeight: nav.scrollHeight, clientHeight: nav.clientHeight,
          overflowY: getComputedStyle(nav).overflowY,
        }
      })

      // (a) Footer NẰM TRỌN trong viewport — không bị đẩy xuống dưới mép màn.
      expect(geo.footHeight, `${where}: không đo được footer`).toBeGreaterThan(0)
      expect(geo.footTop, `${where}: footer bắt đầu phía trên viewport`).toBeGreaterThanOrEqual(-TOL)
      expect(geo.footBottom, `${where}: footer tràn dưới viewport (${geo.footBottom} > ${geo.vh})`)
        .toBeLessThanOrEqual(geo.vh + TOL)

      // (b) Nav DỪNG ở mép trên footer — hai vùng không chồng nhau một pixel nào.
      expect(geo.navBottom, `${where}: nav đè lên footer (nav bottom ${geo.navBottom} > footer top ${geo.footTop})`)
        .toBeLessThanOrEqual(geo.footTop + TOL)

      // (c) Nav là vùng CUỘN được: thiếu chỗ thì nội dung cuộn trong nav chứ
      //     không đẩy footer đi. `scrollHeight >= clientHeight` luôn đúng về
      //     mặt định nghĩa, nên phần thật sự có giá trị là overflowY + phép
      //     thử cuộn khi (và chỉ khi) nội dung đang tràn.
      expect(geo.overflowY, `${where}: #sidebar-nav không phải vùng cuộn`).toBe('auto')
      expect(geo.scrollHeight, `${where}: scrollHeight < clientHeight (?)`).toBeGreaterThanOrEqual(geo.clientHeight)
      if (geo.scrollHeight > geo.clientHeight + 1) {
        const moved = await page.evaluate(() => {
          const n = document.querySelector('#sidebar-nav')!
          n.scrollTop = 9_999
          const top = n.scrollTop
          n.scrollTop = 0
          return top
        })
        expect(moved, `${where}: nav tràn nội dung nhưng KHÔNG cuộn được`).toBeGreaterThan(0)
      }
    }
  })

  // 4 ── Thu gọn = rail chỉ còn icon ⇒ tooltip là kênh DUY NHẤT đọc được nhãn.
  // Phải bung cả khi rê chuột LẪN khi tab bàn phím (đây chính là lý do bỏ
  // `title` native: `title` không bao giờ hiện khi focus bằng bàn phím).
  // Popup treo vào <body> qua Tooltip.Portal nên query TOÀN TRANG, không trong aside.
  test('thu gọn: tooltip nhãn bung khi hover VÀ khi tab bàn phím', async ({ page }) => {
    await setCollapsed(page, true)
    const tasksLink = page.locator('aside a[href="/tasks"]')
    const tip = page.locator('[role="tooltip"]', { hasText: 'Tasks' })

    // (a) Hover — Tooltip.Trigger đặt delay 300ms nên để expect tự chờ.
    await tasksLink.hover()
    await expect(tip, 'hover icon Tasks (thu gọn) mà không thấy tooltip').toBeVisible()

    // Rời chuột thật xa rồi CHỜ tooltip đóng hẳn: nếu không, phép thử bàn phím
    // bên dưới sẽ nhìn thấy đúng cái tooltip của hover và pass một cách vô nghĩa.
    await page.mouse.move(1_100, 600)
    await expect(tip, 'tooltip không đóng khi rời chuột').toBeHidden()

    // (b) Bàn phím — Tab tới đúng link đó. Dùng Tab THẬT (không `focus()`):
    // base-ui chỉ mở popup khi khớp `:focus-visible`, mà focus lập trình không
    // chắc chắn thoả điều kiện đó ⇒ test bằng focus() có thể fail oan.
    let focused = false
    for (let i = 0; i < 30 && !focused; i++) {
      await page.keyboard.press('Tab')
      focused = await tasksLink.evaluate((el) => el === document.activeElement)
    }
    expect(focused, 'tab 30 lần vẫn không tới được link Tasks trong sidebar').toBe(true)
    await expect(tip, 'link Tasks đang focus bàn phím mà không thấy tooltip').toBeVisible()
  })

  // 5 ── Thu gọn: nhãn nhóm đổi thành gạch phân cách (không còn CHỮ), badge đếm
  // thu về chấm nhỏ ở góc icon.
  test('thu gọn: nhãn nhóm mất chữ, badge Bảng tin thu về chấm trong aside', async ({ page }) => {
    const sectionLabel = aside(page).getByText('Vận hành', { exact: true })
    const annLink = page.locator('aside a[href="/announcements"]')

    // — Mở rộng: nhãn nhóm là CHỮ đọc được.
    await expect(sectionLabel, 'mở rộng: không thấy nhãn nhóm "Vận hành"').toBeVisible()

    // Badge Bảng tin = DỮ LIỆU SỐNG (và bằng 0 với mọi role admin — layout chỉ
    // đếm cho non-admin). Không hardcode con số: đọc trạng thái THẬT ở chế độ
    // mở rộng rồi ràng buộc chế độ thu gọn phải NHẤT QUÁN với nó. Có badge ⇒
    // thu gọn phải là chấm; không có ⇒ thu gọn cũng không được đẻ ra chấm.
    const badgeCount = await annLink.locator('span[class*="rounded-full"]').count()

    await setCollapsed(page, true)

    // — Thu gọn: KHÔNG còn phần tử text nào mang chữ "Vận hành" (SectionLabel
    //   đổi hẳn sang gạch `aria-hidden`, không phải ẩn bằng CSS).
    await expect(sectionLabel, 'thu gọn: nhãn nhóm "Vận hành" vẫn còn chữ').toHaveCount(0)

    // — Badge: chấm là `span.absolute` NẰM TRONG aside (e2e/ui-baseline mask
    //   đúng selector này để chặn drift dữ liệu — nếu nó đổi kiểu, mask hụt).
    const dot = annLink.locator('span.absolute')
    await expect(dot, `số badge lệch giữa 2 chế độ (mở rộng ${badgeCount})`).toHaveCount(badgeCount)
    if (badgeCount > 0) {
      await expect(dot).toBeVisible()
      await expect(dot, 'chấm đếm không phải là số').toHaveText(/^\d+\+?$/)
    } else {
      test.info().annotations.push({
        type: 'note',
        description: 'announcementsUnread = 0 (tài khoản super là role admin ⇒ layout không đếm) — chỉ khẳng định được "không đẻ ra chấm thừa"',
      })
    }
  })

  // 6 ── Dark mode. CÁCH ĐÚNG là localStorage `theme`, KHÔNG phải
  // `emulateMedia({ colorScheme })`: ThemeProvider dựng next-themes với
  // `attribute="class"` + `enableSystem={false}` ⇒ app không hề đọc
  // prefers-color-scheme, emulateMedia sẽ không đổi được gì và test "pass" trên
  // một trang vẫn đang sáng. Cùng cơ chế với e2e/ui-baseline.spec.ts.
  test('dark mode: token nền/chữ của sidebar đổi, nền không còn trắng', async ({ page }) => {
    const light = await readSidebarPaint(page)
    expect(light.dark, 'mặc định phải là light theme').toBe(false)

    await page.evaluate(() => localStorage.setItem('theme', 'dark'))
    await page.reload()
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'), null, { timeout: 10_000 })
    await expect(aside(page)).toBeVisible()
    const dark = await readSidebarPaint(page)

    // (a) TOKEN ĐỔI — không khẳng định màu cụ thể nào (bảng màu còn được tinh
    //     chỉnh), chỉ khẳng định sidebar KHÔNG dùng lại y nguyên bảng light.
    expect(dark.bg, 'nền sidebar giữ nguyên giá trị của light theme').not.toBe(light.bg)
    expect(dark.fg, 'màu chữ nav giữ nguyên giá trị của light theme').not.toBe(light.fg)

    // (b) "Nền khác trắng" + "chữ đọc được" phải đo bằng RGB THẬT: Chromium
    //     serialize token oklch nguyên dạng `oklch(...)`, nên so chuỗi với
    //     'rgb(255, 255, 255)' là vô nghĩa. readSidebarPaint vẽ màu lên canvas
    //     1×1 rồi đọc pixel — kèm 2 phép thử trắng/đen để biết bộ parse có hiểu
    //     cú pháp token hay không (không hiểu thì bỏ qua phần đo, đừng fail oan).
    const parserOk = light.probeWhite > 250 && light.probeBlack < 5
    if (!parserOk) {
      test.info().annotations.push({ type: 'note', description: 'canvas không parse được cú pháp màu của token — bỏ qua phần đo độ sáng' })
      return
    }
    expect(light.bgLum, `light: nền sidebar phải gần trắng (đo ${Math.round(light.bgLum)})`).toBeGreaterThan(200)
    expect(dark.bgLum, `dark: nền sidebar vẫn sáng như trắng (đo ${Math.round(dark.bgLum)})`).toBeLessThan(100)
    expect(Math.abs(dark.fgLum - dark.bgLum),
      `dark: chữ nav gần như chìm vào nền (chữ ${Math.round(dark.fgLum)} vs nền ${Math.round(dark.bgLum)})`)
      .toBeGreaterThan(100)
  })

  // 7 ── Regression hình học nhanh cho dải zoom hay dùng: đổi bề rộng sidebar
  // KHÔNG bao giờ được đẩy document ra ngoài viewport. (Contract bề rộng của
  // page-root sống ở e2e/ui-width-contract.spec.ts — đây chỉ là chốt chặn rẻ
  // tiền cho chính hành động thu gọn/mở rộng.)
  test('không sinh scroll ngang @1366×900 ở cả hai trạng thái', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 900 })
    const overflow = () => page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )

    expect(await overflow(), 'mở rộng: document cuộn ngang @1366').toBeLessThanOrEqual(1)
    await setCollapsed(page, true)
    expect(await overflow(), 'thu gọn: document cuộn ngang @1366').toBeLessThanOrEqual(1)
    await setCollapsed(page, false)
    expect(await overflow(), 'mở rộng lại: document cuộn ngang @1366').toBeLessThanOrEqual(1)
  })
})

// Đọc "sơn" của sidebar: chuỗi computed style (để so TOKEN có đổi hay không) +
// độ sáng RGB thật (để nói được "trắng"/"tối"/"đọc được"). Chữ lấy ở hàng nav
// KHÔNG active — hàng active mang `text-primary`, không đại diện cho màu chữ nền.
async function readSidebarPaint(page: Page) {
  return page.evaluate(() => {
    const cv = document.createElement('canvas')
    cv.width = 1
    cv.height = 1
    const ctx = cv.getContext('2d')!
    const rgb = (c: string): [number, number, number] => {
      // Gán '#000' trước: nếu `c` là cú pháp canvas không hiểu thì fillStyle
      // GIỮ NGUYÊN giá trị cũ (không ném lỗi) — mốc đen này khiến probe phát
      // hiện ra chuyện đó thay vì trả về một con số ngẫu nhiên.
      ctx.fillStyle = '#000'
      ctx.fillStyle = c
      ctx.fillRect(0, 0, 1, 1)
      const d = ctx.getImageData(0, 0, 1, 1).data
      return [d[0], d[1], d[2]]
    }
    const lum = (c: string) => {
      const [r, g, b] = rgb(c)
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const el = document.querySelector('aside')!
    const link = document.querySelector<HTMLElement>('#sidebar-nav a:not([aria-current="page"])')!
    const bg = getComputedStyle(el).backgroundColor
    const fg = getComputedStyle(link).color
    return {
      dark: document.documentElement.classList.contains('dark'),
      bg, fg,
      bgLum: lum(bg), fgLum: lum(fg),
      probeWhite: lum('oklch(1 0 0)'),
      probeBlack: lum('oklch(0 0 0)'),
    }
  })
}
