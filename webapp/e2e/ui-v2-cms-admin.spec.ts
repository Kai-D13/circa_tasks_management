import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { SUPER_STATE } from './authState'
import { expectBlocked, trapWrites } from './fixtureGuard'

// CMS P1-c — UI admin qua fixture /ui-catalog/cms-v2/{list,wizard,detail} (render ĐÚNG View của route thật, dữ liệu giả,
// bọc KpiFixtureBoundary). Kiểm: gốc v2, 360 / 390 / 1280 / 1440 × sáng / tối không cuộn ngang trang, chạm ≥ 44px trên
// mobile, P1 KHÔNG có ô / cột kết quả thực tế và không "0₫" giả (U1), SM chỉ đọc (U8), quyền nút theo SPEC §4.7, nhãn
// xác nhận ghi (U16), hộp kích hoạt hồi tố (U6 / H7), 0 request ghi / export (mọi thao tác bị chặn đúng số lần).
// Route thật với cờ CMS OFF (server gate): 404 + tab CMS không hiện (khoá 2 chiều cờ). CMS_SHOTS_DIR ⇒ lưu ảnh để soát.

const HAS_SUPER = fs.existsSync(SUPER_STATE)
const SHOTS = process.env.CMS_SHOTS_DIR
const THEMES = ['light', 'dark'] as const
type Theme = (typeof THEMES)[number]
const DEVICES = {
  d1280: { width: 1280, height: 900 },
  d1440: { width: 1440, height: 900 },
  m360: { width: 360, height: 800 },
  m390: { width: 390, height: 844 },
} as const
type Dev = keyof typeof DEVICES
const RESULT_WORDS = ['CMS tạm tính', 'Dược sĩ có CMS', 'Đạt điều kiện', 'GMV thực tế', 'Đã bán', 'Chốt kỳ', 'Xuất Excel']

async function setup(page: Page, dev: Dev, baseURL: string) {
  await page.setViewportSize(DEVICES[dev])
  await page.context().addCookies([{ name: 'sidebar_collapsed', value: '0', url: baseURL }])
}

async function openFx(page: Page, screen: 'list' | 'wizard' | 'detail', fx: string, theme: Theme = 'light', extra = '') {
  await page.goto(`/ui-catalog/cms-v2/${screen}?fx=${fx}${extra}`)
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
  await page.locator(`main [data-testid="ui-catalog-cms-${screen}"][data-fx="${fx}"]`).waitFor({ state: 'visible', timeout: 20_000 })
  await page.evaluate(() => document.fonts.ready)
}

async function noPageOverflow(page: Page, where: string) {
  const g = await page.evaluate(() => {
    const m = document.querySelector('main')!
    return { sw: document.documentElement.scrollWidth, iw: window.innerWidth, msw: m.scrollWidth, mcw: m.clientWidth }
  })
  expect(g.sw, `${where}: trang cuộn ngang`).toBeLessThanOrEqual(g.iw + 1)
  expect(g.msw, `${where}: <main> cuộn ngang`).toBeLessThanOrEqual(g.mcw + 1)
}

// Ô radio / checkbox: vùng chạm là NHÃN bao ngoài (label min-h 44px) — đo label đó, không đo ô 15px.
async function touchTargets(page: Page, scope: string, where: string) {
  const small = await page.locator(`${scope} a:visible, ${scope} button:visible, ${scope} input:not([type=hidden]):not(.sr-only):visible, ${scope} label:has(input[type=file]):visible`)
    .evaluateAll((els) => els.map((e) => {
      const box = (e instanceof HTMLInputElement && (e.type === 'radio' || e.type === 'checkbox')) ? (e.closest('label') ?? e) : e
      const r = box.getBoundingClientRect()
      return { t: (e.textContent ?? e.getAttribute('aria-label') ?? e.tagName).trim().slice(0, 40), h: Math.round(r.height), w: Math.round(r.width) }
    }).filter((x) => x.h > 0 && Math.min(x.h, x.w) < 44 && x.w > 0))
  expect(small, `${where}: chạm < 44px`).toEqual([])
}

async function noResultNumbers(page: Page, scope: string, where: string) {
  const text = await page.locator(scope).innerText()
  for (const w of RESULT_WORDS) expect(text, `${where}: P1 không hiện "${w}"`).not.toContain(w)
  expect(text, `${where}: không "0₫" giả`).not.toMatch(/(^|[^0-9.])0₫/)
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true })
}

test.describe('ui v2 CMS P1-c — fixture A1 / A2 / A3 bố cục @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })
  const CASES: [('list' | 'wizard' | 'detail'), string, string][] = [
    ['list', 'super', '[data-cms-list]'],
    ['wizard', 'info', '[data-cms-wizard]'],
    ['wizard', 'result', '[data-cms-wizard]'],
    ['detail', 'draft', '[data-cms-detail]'],
  ]
  for (const [screen, fx, scope] of CASES) for (const theme of THEMES) for (const dev of Object.keys(DEVICES) as Dev[]) {
    test(`${screen}?fx=${fx} ${dev} ${theme}: gốc v2, không tràn, chạm ≥ 44 (mobile), không số thực tế`, async ({ page, baseURL }) => {
      await setup(page, dev, baseURL!)
      await openFx(page, screen, fx, theme)
      await expect(page.locator(`main ${scope}[data-ui-v2="page"]`)).toBeVisible()
      await noPageOverflow(page, `${screen} ${fx} ${dev} ${theme}`)
      if (dev.startsWith('m')) await touchTargets(page, `main ${scope}`, `${screen} ${fx} ${dev}`)
      await noResultNumbers(page, `main ${scope}`, `${screen} ${fx}`)
      await shot(page, `${screen}-${fx}-${dev}-${theme}`)
    })
  }
})

// pm-auditor P1-c P1-3: mọi trạng thái fixture còn lại — 360 sáng (chạm ≥ 44) + 1280 tối; không tràn; không số thực tế.
test.describe('ui v2 CMS P1-c — fixture mọi trạng thái (360 sáng / 1280 tối) @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })
  const STATES: [('list' | 'wizard' | 'detail'), string, string, string][] = [
    ['list', 'sm', '[data-cms-list]', ''], ['list', 'empty', '[data-cms-list]', ''], ['list', 'error', '[data-cms-list]', ''],
    ['list', 'filter-empty', '[data-cms-list]', '&status=locked'], ['list', 'loading', '[data-cms-skeleton]', ''],
    ['wizard', 'stores', '[data-cms-wizard]', ''], ['wizard', 'edit-active', '[data-cms-wizard]', ''], ['wizard', 'upload', '[data-cms-wizard]', ''],
    ['wizard', 'running', '[data-cms-wizard]', ''], ['wizard', 'result-append', '[data-cms-wizard]', ''], ['wizard', 'result-none', '[data-cms-wizard]', ''],
    ['detail', 'draft-empty', '[data-cms-detail]', ''], ['detail', 'retro', '[data-cms-detail]', ''], ['detail', 'upcoming', '[data-cms-detail]', ''],
    ['detail', 'running', '[data-cms-detail]', ''], ['detail', 'sm', '[data-cms-detail]', ''], ['detail', 'runs', '[data-cms-detail]', ''],
    ['detail', 'loading', '[data-cms-skeleton]', ''],
  ]
  for (const [screen, fx, scope, extra] of STATES) for (const [dev, theme] of [['m360', 'light'], ['d1280', 'dark']] as [Dev, Theme][]) {
    test(`${screen}?fx=${fx} ${dev} ${theme}`, async ({ page, baseURL }) => {
      await setup(page, dev, baseURL!)
      await openFx(page, screen, fx, theme, extra)
      await expect(page.locator(`main ${scope}[data-ui-v2="page"]`)).toBeVisible()
      await noPageOverflow(page, `${screen} ${fx} ${dev} ${theme}`)
      if (dev === 'm360') await touchTargets(page, `main ${scope}`, `${screen} ${fx} ${dev}`)
      await noResultNumbers(page, `main ${scope}`, `${screen} ${fx}`)
      await shot(page, `${screen}-${fx}-${dev}-${theme}`)
    })
  }
  test('hộp kích hoạt (hồi tố) 360: vừa màn hình, nút ≥ 44px, không tràn', async ({ page, baseURL }) => {
    await setup(page, 'm360', baseURL!)
    await openFx(page, 'detail', 'retro')
    await page.locator('main [data-cms-activate]').click()
    const dlg = page.getByRole('dialog')
    await expect(dlg).toBeVisible()
    // Chờ hiệu ứng mở (zoom-in 95%) xong rồi mới đo — đo giữa hiệu ứng ra 43px giả.
    await dlg.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((x) => x.finished)))
    const box = await dlg.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(361)
    await touchTargets(page, '[role="dialog"]', 'hộp kích hoạt 360')
    await shot(page, 'detail-retro-dialog-m360-light')
  })
})

test.describe('ui v2 CMS P1-c — A1 danh sách (fixture) @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })
  test('super: tab CMS đang chọn, 2 ô thống kê (loại QA), lọc có số, import gần nhất, nút tạo', async ({ page }) => {
    await openFx(page, 'list', 'super')
    const main = page.locator('main [data-cms-list]')
    await expect(main.getByRole('link', { name: 'CMS sản phẩm' })).toHaveAttribute('aria-current', 'page')
    // CMS-UI-1: kịch bản một nguồn — 2 chương trình thật đang chạy (PG1 4 SP + PG7 1 SP), QA không tính.
    await expect(main.locator('[data-cms-stats]')).toContainText('Chương trình đang chạy2')
    await expect(main.locator('[data-cms-stats]')).toContainText('Sản phẩm đang áp dụng5')
    await expect(main.getByRole('link', { name: /Tạo chương trình CMS/ })).toBeVisible()
    await expect(main.locator('[data-cms-table] thead')).toContainText('Import gần nhất')
    await expect(main.locator('[data-cms-table] tbody tr')).toHaveCount(9)
    await expect(main.locator('[data-cms-table]')).toContainText('QA')
    await expect(main.locator('[data-cms-table]')).toContainText('1 nhóm lỗi đã loại')
  })
  test('SM: chỉ đọc — không Tạo, không lọc Nháp, không cột Import; có lọc Đã chốt (P3a r2 — Q-219)', async ({ page }) => {
    await openFx(page, 'list', 'sm')
    const main = page.locator('main [data-cms-list]')
    await expect(main.getByRole('link', { name: /Tạo chương trình CMS/ })).toHaveCount(0)
    await expect(main.getByRole('link', { name: /^Nháp/ })).toHaveCount(0)
    await expect(main.getByRole('link', { name: /^Đã chốt/ })).toBeVisible()
    await expect(main.getByRole('link', { name: /^Chờ chốt kỳ/ })).toBeVisible()
    await expect(main.locator('[data-cms-table] thead')).not.toContainText('Import gần nhất')
  })
  test('rỗng / lọc rỗng / lỗi: không số 0 giả, lỗi không hiện thống kê', async ({ page }) => {
    await openFx(page, 'list', 'empty')
    await expect(page.locator('main [data-cms-list]')).toContainText('Chưa có chương trình CMS')
    await openFx(page, 'list', 'filter-empty', 'light', '&status=locked')
    await expect(page.locator('main [data-cms-list]')).toContainText('Không có chương trình khớp bộ lọc')
    await openFx(page, 'list', 'error')
    await expect(page.locator('main [data-cms-list] [role="alert"]')).toContainText('Không tải được danh sách chương trình CMS')
    await expect(page.locator('main [data-cms-stats]')).toHaveCount(0)
  })
})

test.describe('ui v2 CMS P1-c — A2 wizard / import (fixture, 0 ghi) @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })
  test('Thông tin: stepper bước 1; thiếu tên ⇒ lỗi tại chỗ (không gọi máy chủ); hợp lệ ⇒ lưu bị chặn', async ({ page }) => {
    const seen = await trapWrites(page)
    await openFx(page, 'wizard', 'info')
    const main = page.locator('main [data-cms-wizard]')
    await expect(main.locator('[aria-current="step"]')).toContainText('Thông tin')
    await expect(main).not.toContainText('Target GMV toàn danh mục')
    await main.locator('input[type=date]').first().fill('2026-12-01')
    await main.locator('input[type=date]').nth(1).fill('2026-12-31')
    await main.getByRole('button', { name: 'Lưu nháp' }).click()
    await expect(main.locator('[role="alert"]')).toContainText('Thiếu tên chương trình')
    await expect(page.locator('[data-kpi-fixture-blocked]')).toHaveAttribute('data-kpi-fixture-blocked', '0')
    await main.locator('input').first().fill('CMS thử')
    await main.getByRole('button', { name: 'Tiếp tục · Upload file' }).click()
    await expectBlocked(page, 1, 'Tiếp tục · Upload file')
    expect(seen, 'fixture Thông tin gửi request ghi').toEqual([])
  })
  test('Sửa chương trình đã kích hoạt: ngày bắt đầu ≤ hôm nay ⇒ chặn tại chỗ (Q-214); sau hôm nay ⇒ lưu bị chặn', async ({ page }) => {
    const seen = await trapWrites(page)
    await openFx(page, 'wizard', 'edit-active')
    const main = page.locator('main [data-cms-wizard]')
    await expect(main).toContainText('ngày bắt đầu mới phải sau hôm nay')
    await main.locator('input[type=date]').first().fill('2026-11-15')
    await main.getByRole('button', { name: 'Lưu thay đổi' }).click()
    await expect(main.locator('[role="alert"]')).toContainText('sau hôm nay')
    await main.locator('input[type=date]').first().fill('2026-11-20')
    await main.getByRole('button', { name: 'Lưu thay đổi' }).click()
    await expectBlocked(page, 1, 'Lưu thay đổi')
    expect(seen).toEqual([])
  })
  test('Upload: chỉ .xlsx; chọn file ⇒ "Chạy xử lý" bị chặn (không POST preview)', async ({ page }) => {
    const seen = await trapWrites(page)
    await openFx(page, 'wizard', 'upload')
    const main = page.locator('main [data-cms-wizard]')
    await expect(main.getByRole('link', { name: /Tải file mẫu/ })).toHaveAttribute('href', '/templates/Circa_Import_CMS.xlsx')
    await expect(main.getByRole('button', { name: 'Chạy xử lý' })).toBeDisabled()
    await main.locator('input[type=file]').setInputFiles({ name: 'a.csv', mimeType: 'text/csv', buffer: Buffer.from('x') })
    await expect(main.locator('[role="alert"]')).toContainText('Chỉ nhận file .xlsx')
    await main.locator('input[type=file]').setInputFiles({ name: 'danh-muc.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('PK\u0003\u0004') })
    await main.getByRole('button', { name: 'Chạy xử lý' }).click()
    await expectBlocked(page, 1, 'Chạy xử lý')
    expect(seen).toEqual([])
  })
  test('Kết quả nạp toàn bộ: 4 ô, nội dung sau điểm dừng, tab lỗi, file lỗi + xác nhận ghi bị chặn', async ({ page }) => {
    const seen = await trapWrites(page)
    await openFx(page, 'wizard', 'result')
    const main = page.locator('main [data-cms-wizard]')
    await expect(main.locator('[aria-current="step"]')).toContainText('Kết quả')
    await expect(main.locator('[data-cms-import-result]')).toContainText('Tổng dòng8')
    await expect(main).toContainText('Nội dung từ dòng 48 trở đi không được nhập')
    await expect(main.locator('[data-cms-preview-ok] > li')).toHaveCount(3)
    await expect(main.locator('[data-cms-preview-ok]')).toContainText('1 hộp = 30 đơn vị cơ sở')
    await expect(main.locator('[data-cms-preview-ok]')).toContainText('15.000₫/hộp')
    await main.getByRole('tab', { name: /Lỗi & cảnh báo/ }).click()
    await expect(main.locator('[data-cms-preview-errors]')).toContainText('ProductID không có trên Product Master')
    await expect(main.locator('[data-cms-preview-errors]')).toContainText('SKU-ABC')
    await main.getByRole('button', { name: /Tải file dòng lỗi/ }).click() // r2: fixture là nút, không href endpoint thật
    await expectBlocked(page, 1, 'Tải file dòng lỗi')
    await main.getByRole('button', { name: 'Nạp danh mục (thay toàn bộ, 3 sản phẩm)' }).click()
    await expectBlocked(page, 2, 'Xác nhận ghi')
    expect(seen).toEqual([])
  })
  test('Kết quả import bổ sung ⇒ "Thêm 3 sản phẩm"; 0 hợp lệ ⇒ ẩn nút xác nhận', async ({ page }) => {
    await openFx(page, 'wizard', 'result-append')
    await expect(page.locator('main [data-cms-wizard]').getByRole('button', { name: 'Thêm 3 sản phẩm' })).toBeVisible()
    await openFx(page, 'wizard', 'result-none')
    await expect(page.locator('main [data-cms-wizard] [data-cms-commit]')).toHaveCount(0)
    await expect(page.locator('main [data-cms-wizard]')).toContainText('Không có sản phẩm hợp lệ để ghi')
  })
})

test.describe('ui v2 CMS P1-c — A3 chi tiết (fixture, 0 ghi) @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })
  test('nháp: Sửa · Nạp lại · Kích hoạt; hộp xác nhận không hồi tố; xác nhận bị chặn', async ({ page }) => {
    const seen = await trapWrites(page)
    await openFx(page, 'detail', 'draft')
    const main = page.locator('main [data-cms-detail]')
    await expect(main.getByRole('link', { name: /Sửa thông tin/ })).toBeVisible()
    await expect(main.getByRole('link', { name: /Nạp lại danh mục/ })).toBeVisible()
    await expect(main.locator('[data-cms-products] [data-cms-product]')).toHaveCount(4)
    // CMS-UI-1 §4.1: cấu hình là MỘT dòng meta dưới tiêu đề (không còn 3 ô cấu hình lớn).
    await expect(main.locator('[data-cms-detail-meta]')).toContainText('4 sản phẩm · target nhóm danh mục 1.500.000₫ / dược sĩ')
    await expect(main.locator('[data-cms-detail-stats]')).toHaveCount(0)
    await expect(main.locator('[data-cms-image="fallback"]').first()).toBeVisible()
    await main.locator('[data-cms-activate]').click()
    const dlg = page.getByRole('dialog')
    await expect(dlg).toContainText('Kích hoạt chương trình?')
    await expect(dlg).not.toContainText('hồi tố')
    await dlg.locator('[data-cms-activate-confirm]').click()
    await expectBlocked(page, 1, 'Kích hoạt')
    expect(seen).toEqual([])
  })
  test('ngày bắt đầu đã qua: hộp xác nhận nói rõ áp dụng hồi tố (H7)', async ({ page }) => {
    await openFx(page, 'detail', 'retro')
    await page.locator('main [data-cms-activate]').click()
    await expect(page.getByRole('dialog')).toContainText('áp dụng hồi tố từ ngày bắt đầu')
  })
  test('đang chạy: chỉ "Import bổ sung" (không Sửa / Kích hoạt); SM: không nút, không tab lịch sử', async ({ page }) => {
    await openFx(page, 'detail', 'running')
    let main = page.locator('main [data-cms-detail]')
    await expect(main.getByRole('link', { name: /Import bổ sung/ })).toBeVisible()
    await expect(main.getByRole('link', { name: /Sửa thông tin/ })).toHaveCount(0)
    await expect(main.locator('[data-cms-activate]')).toHaveCount(0)
    await expect(main.locator('[data-cms-product="900004"]')).toContainText('Bổ sung giữa kỳ') // Q-209 hồi tố: không ngày hiệu lực SP
    await openFx(page, 'detail', 'sm')
    main = page.locator('main [data-cms-detail]')
    await expect(main.getByRole('link', { name: /Import bổ sung|Sửa thông tin|Nạp/ })).toHaveCount(0)
    await expect(main.getByRole('link', { name: /Lịch sử import/ })).toHaveCount(0)
  })
  test('lịch sử import: Đã ghi / Chỉ kiểm tra; tải file lỗi bị chặn', async ({ page }) => {
    const seen = await trapWrites(page)
    await openFx(page, 'detail', 'runs')
    const runs = page.locator('main [data-cms-runs]')
    await expect(runs).toContainText('Đã ghi')
    await expect(runs).toContainText('Chỉ kiểm tra')
    await runs.locator('[data-cms-error-file]').first().click()
    await expectBlocked(page, 1, 'Tải file lỗi')
    expect(seen).toEqual([])
  })
})

test.describe('CMS P1-c — route thật khi cờ CMS OFF (server gate) @desktop', () => {
  test.skip(!HAS_SUPER || process.env.E2E_CMS_ENABLED === '1', 'chưa có phiên super / server bật cờ CMS')
  test.use({ storageState: SUPER_STATE })
  // Route có loading.tsx ⇒ stream HTTP 200 trước khi notFound() chạy (như ui-v2-kpi-new) ⇒ khẳng định bằng UI 404 + không
  // có view CMS, không bằng mã HTTP.
  test('mọi route CMS ⇒ trang 404, không view CMS; danh sách KPI không có tab "CMS sản phẩm"', async ({ page }) => {
    for (const u of ['/targets/campaigns/cms', '/targets/campaigns/cms/new', '/targets/campaigns/cms/00000000-0000-4000-8000-000000000001',
      '/targets/campaigns/cms/00000000-0000-4000-8000-000000000001/edit', '/targets/campaigns/cms/00000000-0000-4000-8000-000000000001/import']) {
      await page.goto(u)
      await expect(page.locator('main').getByText('This page could not be found.'), `${u}: phải là trang 404`).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('[data-cms-list], [data-cms-detail], [data-cms-wizard]'), u).toHaveCount(0)
    }
    await page.goto('/targets/campaigns')
    await expect(page.locator('main [data-campaign-list]')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('main').getByRole('link', { name: 'CMS sản phẩm' })).toHaveCount(0)
  })
})

// PM review P1-c P1: sửa phạm vi có nhà thuốc ĐÃ CHỌN nhưng không còn hợp lệ — hiện riêng + "Bỏ chọn" tường minh; còn mục
// ⇒ chặn lưu (không gọi action); bỏ xong ⇒ payload vẫn scope 'stores', chỉ còn nhà thuốc hợp lệ (không tự loại, không ép
// "Tất cả"). Payload đọc từ data-cms-pending-payload (ghi ngay trước khi boundary chặn action).
test.describe('ui v2 CMS P1-c r2 — sửa phạm vi có nhà thuốc không còn hợp lệ @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })
  const sid = (i: number) => `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`
  const INV = ['00000000-0000-4000-8000-000000000190', '00000000-0000-4000-8000-000000000191']
  const payload = async (page: Page) =>
    JSON.parse((await page.locator('main [data-cms-program-form]').getAttribute('data-cms-pending-payload')) ?? 'null') as
      { scope: string; store_ids: string[]; start_date: string } | null
  for (const [fx, n, valid] of [['edit-invalid', 2, [sid(0), sid(1)]], ['edit-active-invalid', 1, [sid(0)]]] as const) {
    test(`${fx}: mục không hợp lệ hiện riêng; còn mục ⇒ chặn lưu; bỏ chọn ⇒ payload chỉ còn nhà thuốc hợp lệ, vẫn phạm vi stores`, async ({ page }) => {
      const seen = await trapWrites(page)
      await openFx(page, 'wizard', fx)
      const main = page.locator('main [data-cms-wizard]')
      const inv = main.locator('[data-cms-invalid-store]')
      await expect(inv).toHaveCount(n)
      await expect(main).toContainText('Nhà thuốc mẫu đã ngừng')
      await expect(main).toContainText('đã ngừng hoạt động')
      await expect(main.locator('input[type=checkbox]'), 'không cho chọn mới nhà thuốc không hợp lệ').toHaveCount(12)
      await expect(main).toContainText(`Đã chọn ${valid.length} / 12 nhà thuốc đang hoạt động`)
      await main.getByRole('button', { name: 'Lưu thay đổi' }).click()
      await expect(main.locator('[role="alert"]')).toContainText(`Bỏ chọn ${n} nhà thuốc không còn hợp lệ`)
      await expect(page.locator('[data-kpi-fixture-blocked]'), 'chưa bỏ chọn ⇒ không gọi action').toHaveAttribute('data-kpi-fixture-blocked', '0')
      expect(await payload(page)).toBeNull()
      for (let i = 0; i < n; i++) await inv.first().getByRole('button', { name: 'Bỏ chọn' }).click()
      await expect(inv).toHaveCount(0)
      await main.getByRole('button', { name: 'Lưu thay đổi' }).click()
      await expectBlocked(page, 1, 'Lưu thay đổi sau khi bỏ chọn')
      const p = await payload(page)
      expect(p?.scope).toBe('stores')
      expect([...(p?.store_ids ?? [])].sort()).toEqual([...valid].sort())
      for (const x of INV) expect(p?.store_ids).not.toContain(x)
      if (fx === 'edit-active-invalid') expect(p?.start_date, 'Q-214 không bị ảnh hưởng').toBe('2026-11-20')
      expect(seen).toEqual([])
    })
  }
  test('edit-invalid-only: bỏ hết ⇒ "Chọn ít nhất một nhà thuốc", không gọi action, không ép sang "Tất cả"', async ({ page }) => {
    const seen = await trapWrites(page)
    await openFx(page, 'wizard', 'edit-invalid-only')
    const main = page.locator('main [data-cms-wizard]')
    await main.locator('[data-cms-invalid-store]').getByRole('button', { name: 'Bỏ chọn' }).click()
    await main.getByRole('button', { name: 'Lưu thay đổi' }).click()
    await expect(main.locator('[role="alert"]')).toContainText('Chọn ít nhất một nhà thuốc')
    await expect(page.locator('[data-kpi-fixture-blocked]')).toHaveAttribute('data-kpi-fixture-blocked', '0')
    await expect(main.locator('input[type=radio][value="stores"]')).toBeChecked()
    expect(seen).toEqual([])
  })
  for (const [dev, theme] of [['m360', 'light'], ['m390', 'dark'], ['d1280', 'light'], ['d1440', 'dark']] as [Dev, Theme][]) {
    test(`edit-invalid ${dev} ${theme}: không tràn, chạm ≥ 44 (mobile)`, async ({ page, baseURL }) => {
      await setup(page, dev, baseURL!)
      await openFx(page, 'wizard', 'edit-invalid', theme)
      await noPageOverflow(page, `edit-invalid ${dev} ${theme}`)
      if (dev.startsWith('m')) await touchTargets(page, 'main [data-cms-wizard]', `edit-invalid ${dev}`)
      await shot(page, `wizard-edit-invalid-${dev}-${theme}`)
    })
  }
  test('A3: tư vấn KHÔNG nằm ở hàng đóng; mở rộng ⇒ nút "Nội dung tư vấn" mở toàn văn (giữ xuống dòng), bấm lại thu gọn', async ({ page }) => {
    await openFx(page, 'detail', 'draft')
    const main = page.locator('main [data-cms-detail]')
    await expect(main.locator('[data-cms-advice]')).toHaveCount(0)
    const btn = main.locator('[data-cms-expand="900001"]')
    await expect(btn).toHaveAttribute('aria-expanded', 'false')
    await btn.click()
    await expect(btn).toHaveAttribute('aria-expanded', 'true')
    const toggle = main.locator('[data-cms-product-expansion="900001"] [data-cms-advice-toggle]')
    await toggle.click()
    const adv = main.locator('[data-cms-product-expansion="900001"] [data-cms-advice]')
    await expect(adv).toBeVisible()
    await expect(adv).toContainText('Nhắc khách đọc kỹ hướng dẫn sử dụng')
    expect(await adv.evaluate((e) => getComputedStyle(e).whiteSpace)).toBe('pre-line')
    await expect(toggle).toHaveText(/Ẩn nội dung tư vấn/)
    await toggle.click()
    await expect(adv).toHaveCount(0)
  })
})
