import { expect, test, type Page } from '@playwright/test'

// GEOMETRY CONTRACT của width policy 15/08 (audit UI-fluid-sidebar-r1, P1#2).
//
// Vì sao spec này tồn tại: test wide-viewport cũ chỉ khẳng định document không
// scroll ngang. Một trang vẫn còn `max-w-5xl` ở page-root cũng PASS điều kiện
// đó — tức là cap quay lại lúc nào cũng lọt lưới, và screenshot là gate duy
// nhất phát hiện ra (mà screenshot thì người phải nhìn, và chỉ được chụp khi có
// đủ credential). Ở đây bề rộng được ĐO: fluid phải phủ kín <main>, centered
// phải cân hai bên và thật sự bị cap ở viewport rộng. Screenshot vẫn giữ vai
// trò thẩm mỹ; contract bề rộng thì máy gác.
//
// Page-root khai báo ý định bằng `data-layout-width="fluid" | "centered"` —
// attribute TRƠ, không sinh class, không đổi một pixel nào; nó chỉ cho spec
// biết phải đo trang này theo luật nào (xem docs/ui/UI_CHANGE_GUARDRAILS.md).
//
// Cần E2E_SUPER_* + một server đang chạy (E2E_BASE_URL) — thiếu thì skip, cùng
// cơ chế với e2e/ui-pilot-capture.spec.ts.

const SUPER = { email: process.env.E2E_SUPER_EMAIL, password: process.env.E2E_SUPER_PASSWORD }

// [route, chuỗi con của <h1> (đã lowercase + NFC), kiểu bề rộng mong đợi]
const ROUTES: [string, string, 'fluid' | 'centered'][] = [
  ['/tasks',             'danh sách tasks',    'fluid'],
  ['/users',             'quản lý người dùng', 'fluid'],
  ['/targets',           'doanh số',           'fluid'],
  ['/targets/campaigns', 'chiến dịch kpi',     'fluid'],
  ['/fs/products',       'sản phẩm',           'fluid'],
  ['/inventory/trf',     'trf',                'fluid'],
  ['/gioi-thieu',        'giới thiệu bạn bè',  'fluid'],
  ['/announcements',     'bảng tin',           'centered'],
  ['/inventory',         'tồn kho',            'centered'],
]

// Zoom-out 75%/60% trên màn 1440 ⇒ viewport CSS ~1920/2400px. Đo ở đúng dải đó:
// cap `max-w-*` chỉ bind khi viewport đủ rộng, nên 1366 mặc định không phát
// hiện được gì.
const WIDE_VIEWPORTS = [
  { width: 1920, height: 900 },
  { width: 2560, height: 1000 },
] as const

// Sai số cho phép: 2px (làm tròn sub-pixel của layout engine + border).
const TOL = 2

async function login(page: Page) {
  await page.goto('/login')
  await page.waitForLoadState('networkidle')
  await page.fill('#email', SUPER.email!)
  await page.fill('#password', SUPER.password!)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL(/\/(tasks|dashboard|targets|fs)/, { timeout: 20_000, waitUntil: 'commit' })
}

test.describe('width contract @desktop', () => {
  test.skip(!SUPER.email || !SUPER.password, 'E2E_SUPER_* not set')

  test('page-root fill/căn giữa đúng khai báo @1920 + @2560', async ({ page }) => {
    test.setTimeout(240_000)
    await login(page)
    await page.evaluate(() => localStorage.setItem('theme', 'light'))

    for (const vp of WIDE_VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      for (const [route, heading, kind] of ROUTES) {
        await page.goto(route)
        await page.waitForFunction(
          (h) => [...document.querySelectorAll('h1')].some((el) => (el.textContent ?? '').normalize('NFC').toLowerCase().includes(h)),
          heading.normalize('NFC').toLowerCase(), { timeout: 15_000 },
        )

        const geo = await page.evaluate(() => {
          const main = document.querySelector('main')
          const root = document.querySelector<HTMLElement>('main [data-layout-width]')
          if (!main || !root) return null
          const m = main.getBoundingClientRect()
          const r = root.getBoundingClientRect()
          // <main> có `overflow-y-auto` ⇒ mép phải của rect BAO GỒM cả thanh
          // cuộn dọc. Mốc so sánh phải là mép vùng NỘI DUNG (clientWidth), nếu
          // không thì mọi trang fluid đều "hụt" đúng bằng bề rộng scrollbar.
          const contentLeft  = m.left + main.clientLeft
          const contentRight = contentLeft + main.clientWidth
          return {
            declared:  root.dataset.layoutWidth,
            mainClient: main.clientWidth,
            contentLeft,
            contentRight,
            rootWidth: r.width,
            rootLeft:  r.left,
            rootRight: r.right,
            docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          }
        })

        const where = `${route} @${vp.width}`
        expect(geo, `${where}: không tìm thấy <main> hoặc page-root [data-layout-width]`).not.toBeNull()
        expect(geo!.declared, `${where}: khai báo data-layout-width sai`).toBe(kind)

        if (kind === 'fluid') {
          // Root phủ kín bề ngang khả dụng của <main> — padding nằm TRONG root,
          // không phải dải trắng bên ngoài nó.
          expect(geo!.mainClient - geo!.rootWidth, `${where}: page-root hẹp hơn <main> ⇒ cap còn sót`)
            .toBeLessThanOrEqual(TOL)
          // Và khoảng hở bên PHẢI — chính là dải trắng stakeholder khiếu nại.
          expect(geo!.contentRight - geo!.rootRight, `${where}: còn dải trắng bên phải`)
            .toBeLessThanOrEqual(TOL)
        } else {
          const leftGap  = geo!.rootLeft - geo!.contentLeft
          const rightGap = geo!.contentRight - geo!.rootRight
          // Cân hai bên: `max-w-*` thiếu `mx-auto` sẽ ghim nội dung sang trái.
          expect(Math.abs(leftGap - rightGap), `${where}: lệch trái/phải (${leftGap} vs ${rightGap}) ⇒ thiếu mx-auto`)
            .toBeLessThanOrEqual(TOL)
          // Cap phải THẬT SỰ bind ở viewport rộng — nếu không thì trang này
          // đang fluid trên thực tế và khai báo 'centered' là sai sự thật.
          expect(geo!.rootWidth, `${where}: khai báo centered nhưng cap không bind`)
            .toBeLessThan(geo!.mainClient)
        }

        // Gỡ cap không bao giờ được đánh đổi bằng scroll ngang toàn trang.
        expect(geo!.docOverflow, `${where}: document scroll ngang`).toBeLessThanOrEqual(1)
      }
    }
  })
})
