import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { MANAGER_STATE, SM_STATE, STAFF_STATE, SUPER_STATE } from './authState'
import { trapWrites } from './fixtureGuard'
import { SM_CMS_ENTRY_HREF, smCmsEntryVisible } from '../lib/cms/access'
import { cmsFlagsFromEnv } from '../lib/cms/flags'
import { SUPER_ADMIN_EMAILS } from '../lib/authz'
import { campaignNavItems } from '../lib/layout/campaignNav'

// SM-CMS-ENTRY-1 (work order PM 11/11 `planning/research/cms-sm-entry-work-order-2026-11-11.md`): nút "CMS sản phẩm" cạnh
// "Lịch sử chiến dịch" ở header landing /targets của SM ⇒ /targets/campaigns/cms (A1 chỉ đọc, phạm vi RLS hiện có).
// Phần thuần (không server): ma trận vai × cờ (AC01 / AC02 / AC06), khoá nguồn (nút chỉ ở landing SM, anchor thường; Sidebar /
// BottomNav / campaignNav không mang nút — nhóm Sidebar "Chiến dịch" của SM theo SM-NAV-D01, 12/11, thay nhánh SM của D03).
// Fixture /ui-catalog/kpi-v2/sm `&cms=1` (opt-in): vị trí / href / trạng thái rỗng
// / lỗi (AC01 / AC07), tương tác document + Back + bàn phím + tab mới (AC03), bố cục 360 / 390 / 1280 × sáng / tối (AC04).
// Route thật theo phiên (AC05 / AC06): SM thấy nút theo cờ server, vào A1 chỉ đọc; staff / QLCH / super không có nút.
// Fixture KHÔNG chứng minh RLS của tài khoản thật.

const ROOT = path.join(__dirname, '..')
const src = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8')
const HAS_SUPER = fs.existsSync(SUPER_STATE)
const HAS_SM = fs.existsSync(SM_STATE)
const HAS_STAFF = fs.existsSync(STAFF_STATE)
const HAS_QLCH = fs.existsSync(MANAGER_STATE)
const FX = '/ui-catalog/kpi-v2/sm'
const ENTRY = '[data-sm-cms-entry]'
const LABEL = 'CMS sản phẩm'
const HISTORY = 'Lịch sử chiến dịch'
const THEMES = ['light', 'dark'] as const
type Theme = (typeof THEMES)[number]
const DEVICES = { d1280: { width: 1280, height: 900 }, m390: { width: 390, height: 844 }, m360: { width: 360, height: 800 } } as const
type Dev = keyof typeof DEVICES
// Ảnh dữ liệu giả lưu NGOÀI Git (SM_ENTRY_SHOTS) — không so baseline.
const SHOTS = process.env.SM_ENTRY_SHOTS ?? ''

// Cờ server của lượt chạy route thật (runner nạp cùng .env.local với server — công thức QA server).
const SERVER_CMS_PROGRAM = cmsFlagsFromEnv(process.env).program

/** Đoạn thân của một hàm export trong file nguồn (tới export kế tiếp). */
function fnBody(file: string, name: string): string {
  const s = src(file)
  const i = s.indexOf(`export function ${name}(`)
  expect(i, `${file}: thiếu ${name}`).toBeGreaterThanOrEqual(0)
  const j = s.indexOf('\nexport ', i + 1)
  return s.slice(i, j < 0 ? undefined : j)
}

test.describe('SM-CMS-ENTRY-1 · phần thuần + nguồn @desktop', () => {
  test('ma trận vai × cờ: chỉ SM + CMS_PROGRAM_ENABLED đúng chuỗi "true"; earnings / Affiliate / KPI không ảnh hưởng', () => {
    const programCases: [string | undefined, boolean][] = [
      [undefined, false], ['', false], ['false', false], ['TRUE', false], ['True', false], ['1', false], [' true', false], ['true ', false], ['true', true],
    ]
    const others = [undefined, 'true', 'false']
    const roles: [string | null | undefined, string | null | undefined, boolean][] = [
      ['sm', 'sm.vung@example.com', true],
      ['sm', null, true],
      ['staff', 'ds@example.com', false],
      ['store_manager', 'qlch@example.com', false],
      ['admin', SUPER_ADMIN_EMAILS[0], false], // super đã có nhóm Sidebar Chiến dịch — không nhận nút nhánh SM
      ['admin', 'pic@example.com', false],
      ['SM', 'sm.vung@example.com', false],
      ['', 'x@example.com', false],
      [null, null, false],
      [undefined, undefined, false],
    ]
    let n = 0
    for (const [prog, progOn] of programCases) {
      for (const earn of others) for (const aff of others) for (const kpi of others) {
        const env = { CMS_PROGRAM_ENABLED: prog, CMS_EARNINGS_ENABLED: earn, KPI_AFFILIATE_ENABLED: aff, KPI_CAMPAIGN_ENABLED: kpi }
        const on = cmsFlagsFromEnv(env).program
        expect(on, `CMS_PROGRAM_ENABLED=${JSON.stringify(prog)}`).toBe(progOn)
        for (const [role, email, smRole] of roles) {
          expect(smCmsEntryVisible(role, email, on), `role=${role} cờ=${JSON.stringify(prog)} earn=${earn} aff=${aff} kpi=${kpi}`).toBe(smRole && progOn)
          n++
        }
      }
    }
    expect(n).toBe(programCases.length * 27 * roles.length)
  })

  test('đích cố định /targets/campaigns/cms — không UUID, không ?status=ended, không ?tab=cms', () => {
    expect(SM_CMS_ENTRY_HREF).toBe('/targets/campaigns/cms')
  })

  test('nguồn: nút chỉ ở SmTargetsLandingView, anchor thường, prop mặc định false; route chỉ truyền cho landing SM', () => {
    const view = 'components/kpi/SmTargetsView.tsx'
    const landing = fnBody(view, 'SmTargetsLandingView')
    expect(landing).toContain('cmsEntry = false')
    expect(landing.match(/data-sm-cms-entry/g)?.length).toBe(1)
    expect(landing).toMatch(/<a\s+href=\{SM_CMS_ENTRY_HREF\}/)
    expect(landing).not.toMatch(/<Link[^>]*SM_CMS_ENTRY_HREF/)
    // Nút cũ giữ nguyên đích, đứng TRƯỚC nút mới.
    expect(landing.indexOf('/targets/campaigns?status=ended')).toBeGreaterThan(0)
    expect(landing.indexOf('/targets/campaigns?status=ended')).toBeLessThan(landing.indexOf('data-sm-cms-entry'))
    for (const other of ['SmTargetsErrorView', 'SmTargetsOutOfScopeView', 'SmTargetsDetailView']) {
      const b = fnBody(view, other)
      expect(b, other).not.toContain('cmsEntry')
      expect(b, other).not.toContain('SM_CMS_ENTRY_HREF')
    }
    const page = src('app/(dashboard)/targets/page.tsx')
    expect(page.match(/cmsEntry=/g)?.length).toBe(1)
    expect(page).toContain('cmsEntry={smCmsEntryVisible(profile?.role, user.email, isCmsProgramEnabled())}')
    const at = page.indexOf('cmsEntry=')
    expect(page.lastIndexOf('<SmTargetsLandingView', at)).toBeGreaterThan(page.lastIndexOf('/>', at))
    // Fixture: chỉ bật khi cms=1.
    expect(src('app/(dashboard)/ui-catalog/kpi-v2/sm/page.tsx')).toContain("const cmsEntry = cms === '1'")
  })

  // SM-CAMPAIGN-NAV-1 (work order PM 12/11, SM-NAV-D01 thay nhánh SM của UI-NAV-D03): SM nhận nhóm Sidebar "Chiến dịch" theo cờ ∩
  // quyền hiện có; nút landing vẫn chỉ ở SmTargetsLandingView. Kiểm HÀNH VI của model (không khoá chuỗi nguồn): SM dương, cờ tắt,
  // vai âm. BottomNav không đổi (không mang nút / nhóm).
  test('SM-NAV-D01: nút entry chỉ ở landing (Sidebar / BottomNav / campaignNav không mang nút); nhóm Chiến dịch cho SM theo cờ, vai khác không', () => {
    for (const f of ['components/layout/Sidebar.tsx', 'components/layout/BottomNav.tsx', 'lib/layout/campaignNav.ts', 'lib/layout/campaignNavServer.ts', 'app/(dashboard)/layout.tsx']) {
      const s = src(f)
      for (const needle of ['smCmsEntryVisible', 'SM_CMS_ENTRY_HREF', 'data-sm-cms-entry']) expect(s, `${f} chứa ${needle}`).not.toContain(needle)
    }
    expect(src('components/layout/BottomNav.tsx'), 'BottomNav không nhận nhóm Chiến dịch').not.toContain('campaignNav')
    const on = { isSuper: false, isFsStore: false, kpiCampaignEnabled: true, kpiAffiliateEnabled: true, cmsProgramEnabled: true, affiliateDeptAdmin: false }
    const keysOf = (p: Parameters<typeof campaignNavItems>[0]) => campaignNavItems(p).map((i) => i.key)
    // SM dương: đủ ba đích; cùng href nút landing cho CMS.
    expect(keysOf({ ...on, role: 'sm', cmsAdminView: true })).toEqual(['kpi', 'affiliate', 'cms'])
    expect(campaignNavItems({ ...on, role: 'sm', cmsAdminView: true }).find((i) => i.key === 'cms')?.href).toBe(SM_CMS_ENTRY_HREF)
    // Cờ tắt: CMS_PROGRAM_ENABLED tắt ⇒ không mục CMS (giống nút landing); mọi cờ tắt ⇒ không nhóm.
    expect(keysOf({ ...on, role: 'sm', cmsAdminView: true, cmsProgramEnabled: false })).toEqual(['kpi', 'affiliate'])
    expect(keysOf({ ...on, role: 'sm', cmsAdminView: true, kpiCampaignEnabled: false, kpiAffiliateEnabled: false, cmsProgramEnabled: false })).toEqual([])
    // Vai âm: staff / QLCH (OS hay FS) không nhận nhóm dù mọi cờ bật.
    for (const role of ['staff', 'store_manager']) for (const isFsStore of [false, true]) {
      expect(keysOf({ ...on, role, isFsStore, cmsAdminView: false }), `${role} fs=${isFsStore}`).toEqual([])
    }
  })
})

// ───────────────────────────── fixture (super, UI_CATALOG=1) ─────────────────────────────
async function setup(page: Page, dev: Dev, baseURL: string) {
  await page.setViewportSize(DEVICES[dev])
  await page.context().addCookies([{ name: 'sidebar_collapsed', value: '0', url: baseURL }])
}
async function openFx(page: Page, fx: string, cms: boolean, theme: Theme = 'light') {
  await page.goto(`${FX}?fx=${fx}${cms ? '&cms=1' : ''}`)
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
  await page.locator(`main [data-testid="ui-catalog-kpi-sm"][data-fx="${fx}"][data-cms="${cms ? '1' : '0'}"]`).waitFor({ state: 'visible', timeout: 20_000 })
  await page.evaluate(() => document.fonts.ready)
}
const smRoot = (page: Page) => page.locator('main [data-sm-targets]')
const entry = (page: Page) => smRoot(page).locator(ENTRY)
const cmsList = (page: Page) => page.locator('main [data-cms-list]')

/** Đợi đúng một request document tới /targets/campaigns/cms trong lúc làm `act`. */
async function expectDocumentNav(page: Page, act: () => Promise<void>) {
  const docs: string[] = []
  const onReq = (r: import('@playwright/test').Request) => {
    if (r.resourceType() === 'document' && r.frame() === page.mainFrame()) docs.push(new URL(r.url()).pathname)
  }
  page.on('request', onReq)
  await act()
  await page.waitForURL((u) => u.pathname === SM_CMS_ENTRY_HREF, { timeout: 30_000 })
  await expect(cmsList(page)).toBeVisible({ timeout: 30_000 })
  page.off('request', onReq)
  expect(docs, 'phải là MỘT lần tải document (anchor thường), không soft navigation').toEqual([SM_CMS_ENTRY_HREF])
  expect(page.url()).not.toContain('?')
}

test.describe('SM-CMS-ENTRY-1 · fixture landing SM @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('opt-in + vị trí: mặc định không nút; cms=1 đúng 1 nút cạnh Lịch sử (cùng nhóm actions, sau nó), đích A1; rỗng vẫn có; lỗi / ngoài phạm vi / chi tiết không có', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    await openFx(page, 'list', false)
    await expect(page.locator(ENTRY)).toHaveCount(0)

    await openFx(page, 'list', true)
    await expect(entry(page)).toHaveCount(1)
    const e = entry(page)
    await expect(e).toHaveText(LABEL)
    await expect(e).toHaveAttribute('href', SM_CMS_ENTRY_HREF)
    expect(await e.evaluate((el) => el.tagName)).toBe('A')
    const hist = smRoot(page).getByRole('link', { name: HISTORY })
    await expect(hist).toHaveAttribute('href', '/targets/campaigns?status=ended')
    // Cùng một nhóm actions của header, Lịch sử đứng trước.
    expect(await e.evaluate((el, h) => el.parentElement === h!.parentElement && h!.compareDocumentPosition(el) === Node.DOCUMENT_POSITION_FOLLOWING,
      await hist.elementHandle())).toBe(true)
    // Không thêm nút quản trị CMS nào trên landing.
    await expect(smRoot(page).getByRole('link', { name: /Tạo chương trình CMS|Import|Kích hoạt/ })).toHaveCount(0)

    await openFx(page, 'empty', true)
    await expect(smRoot(page).getByText('Chưa có chiến dịch nào áp dụng cho các cửa hàng bạn quản lý.')).toBeVisible()
    await expect(entry(page)).toHaveCount(1)

    for (const fx of ['stores-error', 'data-error', 'out-of-scope', 'detail']) {
      await openFx(page, fx, true)
      await expect(page.locator(ENTRY), `fx=${fx}`).toHaveCount(0)
    }
  })

  for (const dev of ['d1280', 'm360'] as Dev[]) {
    test(`tương tác ${dev}: bấm ⇒ một document /targets/campaigns/cms (A1), 0 request ghi; Back về landing; bàn phím Tab + Enter; Ctrl+click mở tab mới`, async ({ page, context }, info) => {
      await setup(page, dev, info.project.use.baseURL!)
      const writes = await trapWrites(page)
      await openFx(page, 'list', true)

      await expectDocumentNav(page, () => entry(page).click())
      await page.goBack()
      await expect(entry(page)).toBeVisible({ timeout: 20_000 })
      expect(new URL(page.url()).pathname).toBe(FX)

      // Bàn phím: Tab từ "Lịch sử chiến dịch" tới nút mới; focus nhìn rõ (vòng focus của buttonVariants).
      await smRoot(page).getByRole('link', { name: HISTORY }).focus()
      await page.keyboard.press('Tab')
      await expect(entry(page)).toBeFocused()
      const ring = await entry(page).evaluate((el) => ({ fv: el.matches(':focus-visible'), shadow: getComputedStyle(el).boxShadow }))
      expect(ring.fv, 'nút không ở trạng thái :focus-visible khi đi bằng bàn phím').toBe(true)
      expect(ring.shadow, 'không thấy vòng focus').not.toBe('none')
      await expectDocumentNav(page, () => page.keyboard.press('Enter'))
      await page.goBack()
      await expect(entry(page)).toBeVisible({ timeout: 20_000 })

      // Tab mới (Ctrl+click) — anchor thường có href thật.
      const [popup] = await Promise.all([context.waitForEvent('page'), entry(page).click({ modifiers: ['Control'] })])
      // Tab mới khởi đầu là about:blank ⇒ chờ đúng URL đích, không chỉ load state.
      await popup.waitForURL((u) => u.pathname === SM_CMS_ENTRY_HREF, { timeout: 30_000 })
      await expect(popup.locator('main [data-cms-list]')).toBeVisible({ timeout: 30_000 })
      await popup.close()

      expect(writes, 'có request ghi').toEqual([])
    })
  }

  for (const theme of THEMES) {
    for (const dev of ['d1280', 'm390', 'm360'] as Dev[]) {
      test(`bố cục ${dev} ${theme}: nhãn đủ, header xuống hàng không chồng, không tràn ngang, vùng chạm ≥ 44×44`, async ({ page }, info) => {
        await setup(page, dev, info.project.use.baseURL!)
        const mobile = dev.startsWith('m')
        for (const fx of ['long', 'list']) {
          await openFx(page, fx, true, theme)
          const g = await page.evaluate((sel) => {
            const main = document.querySelector('main')!
            const e = document.querySelector<HTMLElement>(sel)!
            const h = [...document.querySelectorAll<HTMLElement>('main [data-sm-targets] a')].find((a) => a.textContent?.includes('Lịch sử chiến dịch'))!
            const h1 = document.querySelector<HTMLElement>('main [data-sm-targets] h1')!
            const r = (el: Element) => { const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height } }
            const eb = r(e)
            // Vùng bấm thật: điểm 3,5px ngoài mép trên / dưới của nút vẫn trúng nút (desktop nới ::after).
            const cx = eb.l + eb.w / 2
            const hitTop = document.elementFromPoint(cx, eb.t + (eb.h >= 44 ? 1 : -3.5))?.closest(sel) === e
            const hitBottom = document.elementFromPoint(cx, eb.b + (eb.h >= 44 ? -1 : 3.5))?.closest(sel) === e
            return {
              sw: document.documentElement.scrollWidth, iw: window.innerWidth, msw: main.scrollWidth, mcw: main.clientWidth,
              e: eb, h: r(h), h1: r(h1), text: e.textContent?.trim(), clipped: e.scrollWidth > e.clientWidth + 1, hitTop, hitBottom,
            }
          }, `main ${ENTRY}`)
          const where = `${fx} ${dev} ${theme}`
          expect(g.sw, `${where}: trang cuộn ngang`).toBeLessThanOrEqual(g.iw + 1)
          expect(g.msw, `${where}: <main> cuộn ngang`).toBeLessThanOrEqual(g.mcw + 1)
          expect(g.text, `${where}: nhãn`).toBe(LABEL)
          expect(g.clipped, `${where}: nhãn bị cắt`).toBe(false)
          const overlap = (a: typeof g.e, b: typeof g.e) => a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5
          expect(overlap(g.e, g.h), `${where}: chồng nút Lịch sử`).toBe(false)
          expect(overlap(g.e, g.h1), `${where}: chồng tiêu đề`).toBe(false)
          expect(g.e.r, `${where}: nút vượt khung`).toBeLessThanOrEqual(g.iw + 0.5)
          expect(g.e.w, `${where}: rộng ${g.e.w}`).toBeGreaterThanOrEqual(44)
          if (mobile) expect(g.e.h, `${where}: cao ${g.e.h}`).toBeGreaterThanOrEqual(44)
          // Desktop: nút 36px như nút bên cạnh; vùng bấm nới lên 44px (kiểm bằng hit-test, không chỉ class).
          else expect(g.e.h).toBeGreaterThanOrEqual(35.5)
          expect(g.hitTop && g.hitBottom, `${where}: vùng bấm < 44px`).toBe(true)
          // Hai nút cùng chiều cao (cùng kiểu).
          expect(Math.abs(g.e.h - g.h.h)).toBeLessThanOrEqual(0.5)
        }
        if (SHOTS) {
          fs.mkdirSync(SHOTS, { recursive: true })
          await page.getByTestId('ui-catalog-kpi-sm').screenshot({ path: path.join(SHOTS, `sm-entry-list-${dev}-${theme}.png`), animations: 'disabled' })
        }
      })
    }
  }
})

// ───────────────────────────── route thật theo phiên ─────────────────────────────
test.describe('SM-CMS-ENTRY-1 · route thật SM @desktop', () => {
  test.skip(!HAS_SM, 'chưa có phiên SM')
  test.use({ storageState: SM_STATE })

  test('SM /targets: nút theo cờ server; vào A1 chỉ đọc (không tạo / import / kích hoạt / chốt, không QA), Back về landing, 0 request ghi', async ({ page }, info) => {
    await setup(page, 'd1280', info.project.use.baseURL!)
    const writes = await trapWrites(page)
    await page.goto('/targets')
    await expect(smRoot(page)).toHaveAttribute('data-sm-targets', 'landing', { timeout: 20_000 })
    if (!SERVER_CMS_PROGRAM) {
      await expect(page.locator(ENTRY)).toHaveCount(0)
      test.info().annotations.push({ type: 'nhánh', description: 'CMS_PROGRAM_ENABLED tắt ở server ⇒ không nút' })
      return
    }
    await expect(entry(page)).toHaveCount(1)
    await expectDocumentNav(page, () => entry(page).click())
    const list = cmsList(page)
    await expect(list.getByRole('link', { name: /Tạo chương trình CMS/ })).toHaveCount(0)
    for (const name of [/^Import/, /^Kích hoạt/, /^Chốt/, /^Đồng bộ/, /^Lưu/]) await expect(list.getByRole('button', { name })).toHaveCount(0)
    // SM không có marker QA ⇒ không chương trình QA nào (cms_readable_program_ids: NOT is_test OR qa) — badge "QA" không xuất hiện.
    await expect(list.getByText('QA', { exact: true })).toHaveCount(0)
    await page.goBack()
    await expect(smRoot(page)).toHaveAttribute('data-sm-targets', 'landing', { timeout: 20_000 })
    expect(writes).toEqual([])
  })
})

for (const [label, has, state] of [['staff', HAS_STAFF, STAFF_STATE], ['QLCH', HAS_QLCH, MANAGER_STATE], ['super', HAS_SUPER, SUPER_STATE]] as const) {
  test.describe(`SM-CMS-ENTRY-1 · route thật ${label} không nhận nút @desktop`, () => {
    test.skip(!has, `chưa có phiên ${label}`)
    test.use({ storageState: state })
    test(`${label} /targets: không có nút nhánh SM`, async ({ page }) => {
      await page.goto('/targets')
      await page.locator('main').waitFor({ state: 'visible', timeout: 20_000 })
      await page.waitForLoadState('domcontentloaded')
      await expect(page.locator(ENTRY)).toHaveCount(0)
      await expect(page.locator('main [data-sm-targets]')).toHaveCount(0)
    })
  })
}
