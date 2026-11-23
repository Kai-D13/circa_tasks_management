import fs from 'node:fs'
import path from 'node:path'
import { test, expect, request as pwRequest, type Page, type Route } from '@playwright/test'
import { SUPER_STATE } from './authState'
import { saveLocatorShot } from './qaShot'
import { handleCarePreview, type CareImportDeps } from '../lib/care/import/handler'
import type { CareImportLookups } from '../lib/care/import/preview'
import { buildCareImportCsv, defaultFixtureStores } from './careImportFixture'
import crypto from 'node:crypto'
import { excludeCareCsvRows } from '../lib/care/import/exclude'

// CRM-CSKH B2 — UI wizard Phân công + smoke API thật.
//
// UI chạy trên /ui-catalog/care-import (UI_CATALOG=1 + super — Coolify không bao
// giờ đặt ⇒ prod 404) với API GIẢ bằng page.route: DB chưa có migration 114 ở
// B2 nên không gọi được API thật. JSON giả được dựng bằng CHÍNH handler thật
// (lib/care/import/handler.ts) trên fixture CSV giả B0 (Q-124) ⇒ đúng shape thật.
// Ảnh chụp chỉ phần wizard (ẩn shell có tên người dùng thật) ⇒ lưu vào
// qa-artifacts/ (gitignored), không phải snapshot commit.
//
// Smoke API thật (server QA, cờ CARE_ENABLED tắt mặc định): route/page trả 404,
// không đăng nhập bị proxy đẩy về /login.

const HAS_STATE = fs.existsSync(SUPER_STATE)
const SHOTS = path.resolve(__dirname, '..', 'qa-artifacts', 'care-b2-ui')
const STORES = defaultFixtureStores(25)
const fixture = Buffer.from(buildCareImportCsv())

function lookups(): CareImportLookups {
  return {
    storesByCode: new Map(STORES.map((s, i) => [s.code, { id: `s${i}`, code: s.code, name: `QA store ${i + 1}` }])),
    staff: STORES.flatMap((s, i) => s.assigneeEmails.map((e) => ({ id: e, storeId: `s${i}`, email: e, fullName: `QA dược sĩ ${e.slice(9, 12)}` }))),
    customers: new Map(), refusals: new Set(), currentTasks: new Map(), currentPeriodTaskCount: 0, openPreviousPeriodCount: 0,
  }
}
async function realPreviewJson(bytes: Uint8Array, lk = lookups()) {
  const fd = new FormData()
  fd.append('file', new File([new Uint8Array(bytes)], 'care.csv'))
  const tmp = new Request('http://x/', { method: 'POST', body: fd })
  const body = new Uint8Array(await tmp.arrayBuffer())
  const deps: CareImportDeps = {
    enabled: true, maxBytes: 8 * 1024 * 1024, getAccess: async () => ({ kind: 'ok', actorId: 'a' }),
    repo: { loadLookups: async () => lk, createBatch: async () => 'b', stageRows: async () => {}, finalize: async () => { throw new Error('x') }, discardBatch: async () => {}, purgeStaleStaging: async () => {} },
    now: () => new Date('2026-10-10T03:00:00Z'),
  }
  const res = await handleCarePreview(new Request('http://x/', {
    method: 'POST', body, headers: { 'content-type': tmp.headers.get('content-type')!, 'content-length': String(body.byteLength) },
  }), deps)
  return res.json()
}
const fulfill = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

async function openWizard(page: Page, theme: 'light' | 'dark' = 'light') {
  await page.goto('/ui-catalog/care-import')
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
  await page.getByTestId('care-import-wizard').waitFor({ timeout: 20_000 })
}
async function upload(page: Page, bytes: Buffer = fixture) {
  await page.locator('input[type="file"]').setInputFiles({ name: 'care_T10.csv', mimeType: 'text/csv', buffer: bytes })
  await page.getByRole('button', { name: 'Kiểm tra file' }).click()
}
async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.evaluate(() => {
    document.querySelectorAll('header.bg-primary, aside.bg-sidebar, nav[aria-label="Điều hướng chính"], nextjs-portal').forEach((el) => { (el as HTMLElement).style.display = 'none' })
    // <main> của shell là vùng cuộn cao cố định ⇒ mở ra để ảnh phần tử không bị cắt (cùng cách ui-catalog.spec).
    const main = document.querySelector('main')
    const outer = main?.parentElement
    if (outer instanceof HTMLElement) { outer.style.height = 'auto'; outer.style.overflow = 'visible' }
    if (main instanceof HTMLElement) { main.style.overflow = 'visible' }
  })
  await saveLocatorShot(page.getByTestId('care-import-wizard'), path.join(SHOTS, `${name}.png`))
}
const noPageOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)

test.describe('care B2 — wizard Phân công (API giả) @desktop', () => {
  test.skip(!HAS_STATE, 'chưa có storageState super (E2E_SUPER_* + project setup)')
  test.use({ storageState: SUPER_STATE })

  test('fixture 25 store: Kiểm tra → Phân công (chỉ xem) → Xác nhận; bấm 2 lần chỉ gửi 1 commit', async ({ page }) => {
    test.setTimeout(120_000)
    const previewJson = await realPreviewJson(fixture)
    let commits = 0
    await page.route('**/api/care/import/preview', (r) => fulfill(r, 200, previewJson))
    await page.route('**/api/care/import/commit', async (r) => {
      commits++
      const form = r.request().postData() ?? ''
      expect(form).toContain(previewJson.sha256)
      expect(form).toContain('2026-10-01')
      await new Promise((ok) => setTimeout(ok, 600)) // giữ request để thử bấm lại
      await fulfill(r, 200, { ok: true, result: { status: 'committed', batch_id: 'b', created: 100, updated: 0, unchanged: 0, skipped_has_interaction: 0, closed_previous_period: 0 }, previewCounts: previewJson.preview.counts })
    })
    await openWizard(page)
    await shot(page, 'desktop-light-1-upload')
    await upload(page)

    const wiz = page.getByTestId('care-import-wizard')
    await expect(wiz.getByText('Khách (task)')).toBeVisible()
    await expect(wiz.getByText('25/25')).toBeVisible()
    await expect(wiz.getByText('10/2026', { exact: true })).toBeVisible()
    await expect(wiz.getByText('31/10/2026')).toBeVisible()
    await expect(wiz.getByRole('button', { name: /Tạo mới \(100\)/ })).toBeVisible()
    await shot(page, 'desktop-light-2-check')

    await wiz.getByRole('button', { name: 'Tiếp: xem phân công' }).click()
    await expect(wiz.getByText('chỉ để xem lại')).toBeVisible()
    // B7-ui: bước đã xong có dấu ✓ (nhãn "đã xong"), bước hiện tại aria-current="step".
    await expect(wiz.getByRole('list', { name: 'Các bước import' }).getByLabel('đã xong')).toHaveCount(2)
    await expect(wiz.locator('li[aria-current="step"]')).toContainText('Phân công')
    await expect(wiz.getByRole('button', { name: /Phân công theo cửa hàng|Chuyển giao/ })).toHaveCount(0)
    await expect(wiz.locator('tbody tr')).toHaveCount(50) // 25 store × 2 dược sĩ
    await shot(page, 'desktop-light-3-assign')

    await wiz.getByRole('button', { name: 'Tiếp: xác nhận' }).click()
    const confirm = wiz.getByRole('button', { name: 'Xác nhận import' })
    await confirm.click()
    await confirm.click({ force: true }).catch(() => {}) // bấm lần 2 khi đang gửi
    await expect(page.getByTestId('care-import-result')).toContainText('Đã import')
    expect(commits).toBe(1)
    await shot(page, 'desktop-light-4-result')
  })

  test('file lỗi: bảng lỗi + tổng, không cho đi tiếp; chạm số dòng lọc tới khách chứa dòng đó', async ({ page }) => {
    const lk = lookups()
    lk.storesByCode.delete('QAOS03') // mọi khách QAOS03 thành STORE_INVALID
    const previewJson = await realPreviewJson(fixture, lk)
    expect(previewJson.preview.errorCount).toBeGreaterThan(0)
    await page.route('**/api/care/import/preview', (r) => fulfill(r, 200, previewJson))
    await openWizard(page)
    await upload(page)
    const wiz = page.getByTestId('care-import-wizard')
    await expect(wiz.getByTestId('care-import-issues').getByText(`${previewJson.preview.errorCount} lỗi`, { exact: true })).toBeVisible()
    await expect(wiz.getByRole('button', { name: 'Sửa file rồi kiểm tra lại' })).toBeDisabled()
    const firstRow = previewJson.preview.errors[0].row
    await wiz.getByRole('button', { name: String(firstRow), exact: true }).first().click()
    await expect(wiz.getByText(`Đang xem khách chứa dòng ${firstRow}`)).toBeVisible()
    await shot(page, 'desktop-light-errors')
  })

  test('kết quả duplicate/rejected và lỗi 409 không bị trình bày như tạo mới thành công', async ({ page }) => {
    test.setTimeout(120_000)
    const previewJson = await realPreviewJson(fixture)
    await page.route('**/api/care/import/preview', (r) => fulfill(r, 200, previewJson))
    const outcomes: [number, unknown, RegExp][] = [
      [200, { ok: true, result: { status: 'duplicate', batch_id: 'b', duplicate_of: 'b0' } }, /Không tạo task mới/],
      [200, { ok: true, result: { status: 'rejected', batch_id: 'b', error_count: 1, errors: [{ row: 5, code: 'REFUSED_AT_STORE' }] } }, /Bị từ chối — không có task nào được ghi/],
      [409, { ok: false, code: 'PERIOD_CHANGED' }, /Đã sang tháng mới/],
    ]
    for (const [status, body, text] of outcomes) {
      await page.unroute('**/api/care/import/commit')
      await page.route('**/api/care/import/commit', (r) => fulfill(r, status, body))
      await openWizard(page)
      await upload(page)
      const wiz = page.getByTestId('care-import-wizard')
      await wiz.getByRole('button', { name: 'Tiếp: xem phân công' }).click()
      await wiz.getByRole('button', { name: 'Tiếp: xác nhận' }).click()
      await wiz.getByRole('button', { name: 'Xác nhận import' }).click()
      await expect(wiz).toContainText(text)
      await expect(wiz.getByText('Đã import', { exact: true })).toHaveCount(0)
    }
  })

  test('dark mode + lịch sử import (dữ liệu giả) hiển thị trạng thái đúng nhãn', async ({ page }) => {
    const previewJson = await realPreviewJson(fixture)
    await page.route('**/api/care/import/preview', (r) => fulfill(r, 200, previewJson))
    await openWizard(page, 'dark')
    await expect(page.getByText('Trùng file — không tạo mới')).toBeVisible()
    await expect(page.getByText('Bị từ chối', { exact: true })).toBeVisible()
    await upload(page)
    await shot(page, 'desktop-dark-2-check')
  })
})

test.describe('care B2 — wizard mobile 360 (API giả) @mobile', () => {
  test.skip(!HAS_STATE, 'chưa có storageState super')
  test.use({ storageState: SUPER_STATE })

  test('360px: không cuộn ngang trang, nút đủ 44px', async ({ page }) => {
    const previewJson = await realPreviewJson(fixture)
    await page.route('**/api/care/import/preview', (r) => fulfill(r, 200, previewJson))
    await openWizard(page)
    expect(await noPageOverflow(page)).toBe(true)
    await upload(page)
    const wiz = page.getByTestId('care-import-wizard')
    await expect(wiz.getByText('Khách (task)')).toBeVisible()
    expect(await noPageOverflow(page)).toBe(true)
    const next = wiz.getByRole('button', { name: 'Tiếp: xem phân công' })
    expect((await next.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await shot(page, `mobile-${page.viewportSize()!.width}-check`)
  })
})

test.describe('care B2 — API/page thật khi cờ CARE_ENABLED tắt @desktop', () => {
  test.skip(!HAS_STATE, 'chưa có storageState super')
  test.skip(process.env.CARE_ENABLED === 'true', 'server QA đang bật cờ CRM — smoke này kiểm trạng thái mặc định OFF')
  test.use({ storageState: SUPER_STATE })

  test('super đăng nhập: /care/assign 404, preview/commit/template 404 — cờ OFF không lộ chức năng', async ({ page }) => {
    expect((await page.goto('/care/assign'))!.status()).toBe(404)
    for (const p of ['/api/care/import/preview', '/api/care/import/commit']) {
      const res = await page.request.post(p, { multipart: { file: { name: 'care.csv', mimeType: 'text/csv', buffer: fixture } } })
      expect(res.status(), p).toBe(404)
      expect(await res.json(), p).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    }
    expect((await page.request.get('/api/care/import/template')).status()).toBe(404)
  })

  test('không đăng nhập: proxy đẩy về /login, không tới handler', async ({ baseURL }) => {
    const ctx = await pwRequest.newContext({ baseURL, storageState: { cookies: [], origins: [] } })
    const res = await ctx.post('/api/care/import/preview', { maxRedirects: 0, multipart: { file: { name: 'a.csv', mimeType: 'application/octet-stream', buffer: fixture } } })
    expect([302, 307]).toContain(res.status())
    expect(res.headers()['location']).toContain('/login')
    await ctx.dispose()
  })
})

// ── B8.3 /care/assign theo artboard 11 + Q-110 ─────────────────────────────────────────────────────────────
const SHOTS_B83 = path.resolve(__dirname, '..', 'qa-artifacts', 'b8-3')
async function pageShot(page: Page, name: string) {
  fs.mkdirSync(SHOTS_B83, { recursive: true })
  await page.evaluate(() => {
    document.querySelectorAll('header.bg-primary, aside.bg-sidebar, nav[aria-label="Điều hướng chính"], nextjs-portal').forEach((el) => { (el as HTMLElement).style.display = 'none' })
    // <main> của shell là vùng cuộn cao cố định ⇒ mở ra để ảnh toàn trang không bị cắt (cùng cách shot()).
    const main = document.querySelector('main')
    const outer = main?.parentElement
    if (outer instanceof HTMLElement) { outer.style.height = 'auto'; outer.style.overflow = 'visible' }
    if (main instanceof HTMLElement) { main.style.overflow = 'visible' }
  })
  await page.screenshot({ path: path.join(SHOTS_B83, `${name}.png`), fullPage: true })
}
/** Preview giả "đúng shape thật" (JSON từ handler thật) + lỗi tiêm vào: 1.234 lỗi, chi tiết 500 đầu, đếm theo mã đủ. */
async function truncatedErrorsJson() {
  const base = await realPreviewJson(fixture)
  const errors = [
    { row: 2, code: 'PHONE_INVALID', field: 'customer_phone' },
    { row: 3, code: 'FIELD_REQUIRED' },
    ...Array.from({ length: 498 }, (_, i) => ({ row: 4 + i, code: 'STORE_INVALID', field: 'target_store_code' })),
  ]
  return { ...base, preview: { ...base.preview, errorCount: 1234, errorCounts: { PHONE_INVALID: 1, FIELD_REQUIRED: 1, STORE_INVALID: 1232 }, errors } }
}
const committedBody = (previewJson: { preview: { counts: unknown } }) => ({
  ok: true, result: { status: 'committed', batch_id: 'b', created: 100, updated: 0, unchanged: 0, skipped_has_interaction: 0, closed_previous_period: 0 },
  previewCounts: previewJson.preview.counts,
})

test.describe('care B8.3 — /care/assign theo artboard 11 (API giả) @desktop', () => {
  test.skip(!HAS_STATE, 'chưa có storageState super')
  test.use({ storageState: SUPER_STATE })

  test('bước 1: header Kỳ nhận + Tải file mẫu; yêu cầu file đủ 10 cột A–J; bước chưa tới bị khoá; kéo thả nhận file, Bỏ file về trống', async ({ page }) => {
    await openWizard(page)
    await expect(page.getByText('Kỳ nhận:')).toContainText('Tháng 10/2026')
    await expect(page.getByRole('link', { name: 'Tải file mẫu' })).toHaveAttribute('href', '/api/care/import/template')
    const cols = page.getByTestId('care-import-columns').locator('li')
    await expect(cols).toHaveCount(10)
    await expect(cols.first()).toContainText('A')
    await expect(cols.first()).toContainText('customer_external_id')
    await expect(cols.last()).toContainText('J')
    await expect(cols.last()).toContainText('product_url')
    const steps = page.getByRole('list', { name: 'Các bước import' }).getByRole('button')
    await expect(steps).toHaveCount(4)
    for (let i = 0; i < 4; i++) await expect(steps.nth(i)).toBeDisabled()
    await expect(page.getByRole('button', { name: /Kiểm tra file/ })).toBeDisabled()
    const dt = await page.evaluateHandle((b64) => {
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))
      const d = new DataTransfer()
      d.items.add(new File([bytes], 'care_keo_tha.csv', { type: 'text/csv' }))
      return d
    }, fixture.toString('base64'))
    const zone = page.getByTestId('care-import-dropzone')
    await zone.dispatchEvent('dragover', { dataTransfer: dt })
    await expect(zone).toHaveAttribute('data-dragging', 'true')
    await zone.dispatchEvent('drop', { dataTransfer: dt })
    await expect(page.getByTestId('care-import-file')).toContainText('care_keo_tha.csv')
    await expect(page.getByRole('button', { name: /Kiểm tra file/ })).toBeEnabled()
    await page.getByRole('button', { name: 'Bỏ file' }).click()
    await expect(page.getByTestId('care-import-dropzone')).toBeVisible()
  })

  test('Q-110: lỗi chặn cả file — cột chỉ khi chắc chắn (chữ cột + tên), "—" khi nhiều cột; hướng sửa; tổng/chip đúng khi chi tiết bị cắt; không CTA import phần hợp lệ', async ({ page }) => {
    const json = await truncatedErrorsJson()
    await page.route('**/api/care/import/preview', (r) => fulfill(r, 200, json))
    await openWizard(page)
    await upload(page)
    const wiz = page.getByTestId('care-import-wizard')
    await expect(wiz.getByTestId('care-import-blocked')).toContainText('không import được phần nào')
    const issues = wiz.getByTestId('care-import-issues')
    await expect(issues.getByText('1.234 lỗi', { exact: true })).toBeVisible()
    await expect(issues).toContainText('hiển thị 500 lỗi đầu')
    const rows = issues.locator('tbody tr')
    await expect(rows.nth(0)).toContainText('C')
    await expect(rows.nth(0)).toContainText('customer_phone')
    await expect(rows.nth(0)).toContainText('Nhập số di động Việt Nam')
    await expect(rows.nth(1).locator('td').nth(1)).toHaveText('—')
    await expect(rows.nth(2)).toContainText('target_store_code')
    // Chip đếm theo mã lấy từ server (toàn bộ 1.234), không phải từ 500 dòng chi tiết.
    await expect(issues.getByRole('button', { name: /Tất cả\s*1\.234/ })).toBeVisible()
    await issues.getByRole('button', { name: /Mã cửa hàng sai\s*1\.232/ }).click()
    await expect(issues).toContainText('Đang hiện 498/1.232 lỗi loại này')
    await expect(wiz.getByRole('button', { name: 'Sửa file rồi kiểm tra lại' })).toBeDisabled()
    await expect(wiz.getByText(/Tiếp tục với|dòng hợp lệ ·|Gần đúng/)).toHaveCount(0)
    const steps = page.getByRole('list', { name: 'Các bước import' }).getByRole('button')
    await expect(steps.nth(2)).toBeDisabled()
    await expect(steps.nth(3)).toBeDisabled()
    await wiz.getByRole('button', { name: 'Chọn file đã sửa' }).click()
    await expect(page.getByTestId('care-import-dropzone')).toBeVisible()
  })

  test('bước 3 chỉ đọc + tổng; quay lại bằng stepper; bước 4 tóm tắt + thay đổi từ preview thật; thành công có link danh sách chăm sóc', async ({ page }) => {
    const previewJson = await realPreviewJson(fixture)
    await page.route('**/api/care/import/preview', (r) => fulfill(r, 200, previewJson))
    await page.route('**/api/care/import/commit', (r) => fulfill(r, 200, committedBody(previewJson)))
    await openWizard(page)
    await upload(page)
    const wiz = page.getByTestId('care-import-wizard')
    await wiz.getByRole('button', { name: 'Tiếp: xem phân công' }).click()
    await expect(wiz.locator('tfoot')).toContainText('50 dược sĩ · 25 cửa hàng')
    await expect(wiz.locator('tfoot')).toContainText('100')
    await expect(wiz.locator('select, input:not([type="file"])')).toHaveCount(0) // chỉ đọc: không chọn lại tài khoản
    // Stepper: bấm "Kiểm tra dữ liệu" (đã qua) quay lại bước 2; bước chưa tới vẫn khoá.
    const steps = page.getByRole('list', { name: 'Các bước import' }).getByRole('button')
    await expect(steps.nth(3)).toBeDisabled()
    await steps.nth(1).click()
    await expect(wiz.locator('li[aria-current="step"]')).toContainText('Kiểm tra dữ liệu')
    await wiz.getByRole('button', { name: 'Tiếp: xem phân công' }).click()
    await wiz.getByRole('button', { name: 'Tiếp: xác nhận' }).click()
    const summary = wiz.getByRole('region', { name: 'Tóm tắt' })
    await expect(summary).toContainText('Tháng 10/2026')
    await expect(summary).toContainText('31/10/2026')
    await expect(summary).toContainText('25 cửa hàng')
    await expect(summary).toContainText('50 dược sĩ')
    await expect(summary).toContainText(`${previewJson.preview.rowCount} dòng · 100 khách`)
    const changes = wiz.getByRole('region', { name: 'Thay đổi sẽ áp dụng' })
    await expect(changes).toContainText('100')
    await expect(changes).toContainText('Task kỳ trước sẽ đóng')
    await wiz.getByRole('button', { name: 'Xác nhận import 100 khách' }).click()
    const res = page.getByTestId('care-import-result')
    await expect(res).toContainText('Đã import file cho kỳ 10/2026')
    await expect(res.getByRole('link', { name: 'Xem danh sách chăm sóc' })).toHaveAttribute('href', '/care/tasks')
    await expect(page.getByRole('list', { name: 'Các bước import' }).getByLabel('đã xong')).toHaveCount(4)
    await res.getByRole('button', { name: 'Import file khác' }).click()
    await expect(page.getByTestId('care-import-dropzone')).toBeVisible()
  })

  test('ảnh 1440/1280 sáng/tối từng bước (so artboard 11); không cuộn ngang trang', async ({ page }) => {
    test.setTimeout(240_000)
    const ok = await realPreviewJson(fixture)
    const bad = await truncatedErrorsJson()
    for (const w of [1440, 1280]) for (const theme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width: w, height: 900 })
      await page.unroute('**/api/care/import/preview')
      await page.unroute('**/api/care/import/commit')
      await page.route('**/api/care/import/preview', (r) => fulfill(r, 200, ok))
      await page.route('**/api/care/import/commit', (r) => fulfill(r, 200, committedBody(ok)))
      await openWizard(page, theme)
      await page.waitForLoadState('networkidle')
      expect(await noPageOverflow(page), `${w}-${theme}-1`).toBe(true)
      await pageShot(page, `desktop-${w}-${theme}-1-upload`)
      await upload(page)
      const wiz = page.getByTestId('care-import-wizard')
      await wiz.getByRole('button', { name: 'Tiếp: xem phân công' }).waitFor()
      expect(await noPageOverflow(page), `${w}-${theme}-2`).toBe(true)
      await pageShot(page, `desktop-${w}-${theme}-2-check`)
      await wiz.getByRole('button', { name: 'Tiếp: xem phân công' }).click()
      expect(await noPageOverflow(page), `${w}-${theme}-3`).toBe(true)
      await pageShot(page, `desktop-${w}-${theme}-3-assign`)
      await wiz.getByRole('button', { name: 'Tiếp: xác nhận' }).click()
      expect(await noPageOverflow(page), `${w}-${theme}-4`).toBe(true)
      await pageShot(page, `desktop-${w}-${theme}-4-confirm`)
      await wiz.getByRole('button', { name: /Xác nhận import/ }).click()
      await page.getByTestId('care-import-result').waitFor()
      await pageShot(page, `desktop-${w}-${theme}-5-done`)
      await page.unroute('**/api/care/import/preview')
      await page.route('**/api/care/import/preview', (r) => fulfill(r, 200, bad))
      await openWizard(page, theme)
      await upload(page)
      await page.getByTestId('care-import-issues').waitFor()
      expect(await noPageOverflow(page), `${w}-${theme}-err`).toBe(true)
      await pageShot(page, `desktop-${w}-${theme}-2-errors`)
    }
  })
})

test.describe('care B8.3 — /care/assign mobile 360 (API giả) @mobile', () => {
  test.skip(!HAS_STATE, 'chưa có storageState super')
  test.use({ storageState: SUPER_STATE })

  test('360/390 sáng/tối: mọi bước không cuộn ngang trang, nút chính ≥ 44px; ảnh', async ({ page }) => {
    test.setTimeout(180_000)
    const ok = await realPreviewJson(fixture)
    const bad = await truncatedErrorsJson()
    const w = page.viewportSize()!.width
    for (const theme of ['light', 'dark'] as const) {
      await page.unroute('**/api/care/import/preview')
      await page.unroute('**/api/care/import/commit')
      await page.route('**/api/care/import/preview', (r) => fulfill(r, 200, ok))
      await page.route('**/api/care/import/commit', (r) => fulfill(r, 200, committedBody(ok)))
      await openWizard(page, theme)
      await page.waitForLoadState('networkidle')
      expect(await noPageOverflow(page)).toBe(true)
      expect((await page.getByRole('button', { name: 'Chọn file từ máy' }).boundingBox())!.height).toBeGreaterThanOrEqual(44)
      await pageShot(page, `mobile-${w}-${theme}-1-upload`)
      await upload(page)
      const wiz = page.getByTestId('care-import-wizard')
      const next = wiz.getByRole('button', { name: 'Tiếp: xem phân công' })
      expect((await next.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      expect(await noPageOverflow(page)).toBe(true)
      await pageShot(page, `mobile-${w}-${theme}-2-check`)
      await next.click()
      expect(await noPageOverflow(page)).toBe(true)
      await pageShot(page, `mobile-${w}-${theme}-3-assign`)
      await wiz.getByRole('button', { name: 'Tiếp: xác nhận' }).click()
      const confirm = wiz.getByRole('button', { name: /Xác nhận import/ })
      expect((await confirm.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      expect(await noPageOverflow(page)).toBe(true)
      await pageShot(page, `mobile-${w}-${theme}-4-confirm`)
      await confirm.click()
      await page.getByTestId('care-import-result').waitFor()
      expect(await noPageOverflow(page)).toBe(true)
      await pageShot(page, `mobile-${w}-${theme}-5-done`)
      await page.unroute('**/api/care/import/preview')
      await page.route('**/api/care/import/preview', (r) => fulfill(r, 200, bad))
      await openWizard(page, theme)
      await upload(page)
      await page.getByTestId('care-import-issues').waitFor()
      expect(await noPageOverflow(page)).toBe(true)
      await pageShot(page, `mobile-${w}-${theme}-2-errors`)
    }
  })
})

// ── B8.3 r1.1 (PM R1-01): phản hồi preview của file cũ không được gắn vào file mới ─────────────────────────
test.describe('care B8.3 r1.1 — preview cũ về muộn sau khi đổi/bỏ file @desktop', () => {
  test.skip(!HAS_STATE, 'chưa có storageState super')
  test.use({ storageState: SUPER_STATE })
  const CSV_MIME = 'text/csv'
  const fileB = Buffer.from(buildCareImportCsv({ stores: defaultFixtureStores(2), customersPerStore: 3 }))

  /** Giữ phản hồi preview của care_A.csv tới khi `releaseA()`; file khác trả ngay. */
  async function holdA(page: Page) {
    const [jsonA, jsonB] = [await realPreviewJson(fixture), await realPreviewJson(fileB)]
    expect([jsonA.preview.customerCount, jsonB.preview.customerCount]).toEqual([100, 6])
    let release!: () => void
    const gate = new Promise<void>((ok) => { release = ok })
    let aDone!: () => void
    const aFulfilled = new Promise<void>((ok) => { aDone = ok })
    await page.route('**/api/care/import/preview', async (r) => {
      if ((r.request().postDataBuffer()?.toString('latin1') ?? '').includes('filename="care_A.csv"')) {
        await gate
        await fulfill(r, 200, jsonA).catch(() => {}) // request đã huỷ (abort) ⇒ bỏ qua
        aDone()
      } else await fulfill(r, 200, jsonB)
    })
    return { releaseA: async () => { release(); await aFulfilled; await page.waitForTimeout(500) } }
  }
  /** Ghi lại MỌI trạng thái DOM mà wizard hiện số liệu của A (100 khách / 200 dòng) — kể cả thoáng qua. */
  async function watchA(page: Page) {
    await page.evaluate(() => {
      const w = window as unknown as { __a: string[] }
      w.__a = []
      new MutationObserver(() => {
        const t = document.querySelector('[data-testid="care-import-wizard"]')?.textContent ?? ''
        if (/gộp theo mã khách/.test(t) && /Khách \(task\)100/.test(t)) w.__a.push(t.includes('care_B.csv') ? 'A-under-B' : 'A')
      }).observe(document.body, { subtree: true, childList: true, characterData: true })
    })
  }
  const seenA = (page: Page) => page.evaluate(() => (window as unknown as { __a: string[] }).__a)

  test('A đang kiểm tra → Bỏ file → chọn B → A về muộn: KHÔNG sang bước 2 với số A; B kiểm tra ra đúng số B', async ({ page }) => {
    const { releaseA } = await holdA(page)
    await openWizard(page)
    await page.waitForLoadState('networkidle')
    await watchA(page)
    const input = page.locator('input[type="file"]')
    await input.setInputFiles({ name: 'care_A.csv', mimeType: CSV_MIME, buffer: fixture })
    await page.getByRole('button', { name: /Kiểm tra file/ }).click()
    await page.getByRole('button', { name: 'Bỏ file' }).click()
    await input.setInputFiles({ name: 'care_B.csv', mimeType: CSV_MIME, buffer: fileB })
    await expect(page.getByTestId('care-import-file')).toContainText('care_B.csv')
    await releaseA()
    const wiz = page.getByTestId('care-import-wizard')
    await expect(wiz.getByRole('button', { name: 'Tiếp: xem phân công' })).toHaveCount(0)
    await expect(page.getByTestId('care-import-file')).toContainText('care_B.csv')
    await page.getByRole('button', { name: /Kiểm tra file/ }).click()
    await expect(wiz.getByRole('button', { name: 'Tiếp: xem phân công' })).toBeVisible()
    await expect(wiz).toContainText('care_B.csv')
    await expect(wiz).toContainText('Khách (task)6')
    expect(await seenA(page)).toEqual([])
  })

  test('A đang kiểm tra → Bỏ file (không chọn file khác) → A về muộn: vẫn ở bước 1 trống, bước 2 không sống lại', async ({ page }) => {
    const { releaseA } = await holdA(page)
    await openWizard(page)
    await page.waitForLoadState('networkidle')
    await watchA(page)
    await page.locator('input[type="file"]').setInputFiles({ name: 'care_A.csv', mimeType: CSV_MIME, buffer: fixture })
    await page.getByRole('button', { name: /Kiểm tra file/ }).click()
    await page.getByRole('button', { name: 'Bỏ file' }).click()
    await releaseA()
    await expect(page.getByTestId('care-import-dropzone')).toBeVisible()
    await expect(page.getByTestId('care-import-wizard').getByRole('button', { name: 'Tiếp: xem phân công' })).toHaveCount(0)
    await expect(page.locator('li[aria-current="step"]')).toContainText('Tải file')
    expect(await seenA(page)).toEqual([])
  })
})

// ── PM 22/11/2026 — "Loại khỏi lần nhập" (khách đã từ chối chăm sóc tại cửa hàng) ──────────────────────────────────
// API giả nhưng TÍNH TỪ BYTES TRÌNH DUYỆT GỬI bằng handler thật ⇒ lượt kiểm tra lại phản ánh đúng file làm việc của wizard.
async function refusedSetup() {
  const base = await realPreviewJson(fixture)
  const victims = (base.preview.customers as { externalId: string; storeCode: string; rows: number[] }[]).slice(0, 2)
  const lk = lookups()
  for (const v of victims) {
    lk.customers.set(v.externalId, { id: `c-${v.externalId}`, isTest: false })
    lk.refusals.add(`c-${v.externalId}|s${STORES.findIndex((s) => s.code === v.storeCode)}`)
  }
  const rows = victims.flatMap((v) => v.rows).sort((a, b) => a - b)
  return { base, lk, rows }
}
async function previewOfPosted(route: Route, lk: CareImportLookups) {
  const body = route.request().postDataBuffer()!
  const deps: CareImportDeps = {
    enabled: true, maxBytes: 8 * 1024 * 1024, getAccess: async () => ({ kind: 'ok', actorId: 'a' }),
    repo: { loadLookups: async () => lk, createBatch: async () => 'b', stageRows: async () => {}, finalize: async () => { throw new Error('x') }, discardBatch: async () => {}, purgeStaleStaging: async () => {} },
    now: () => new Date('2026-10-10T03:00:00Z'),
  }
  const res = await handleCarePreview(new Request('http://x/', {
    method: 'POST', body: new Uint8Array(body), headers: { 'content-type': route.request().headers()['content-type'], 'content-length': String(body.byteLength) },
  }), deps)
  return { status: res.status, json: await res.json() }
}

test.describe('care PM 22/11 — wizard: loại khách đã từ chối khỏi lần nhập (API giả tính từ file gửi lên) @desktop', () => {
  test.skip(!HAS_STATE, 'chưa có storageState super (E2E_SUPER_* + project setup)')
  test.use({ storageState: SUPER_STATE })

  test('chọn nhóm "Khách đã từ chối" → xác nhận số khách / dòng → kiểm tra lại sạch lỗi → commit gửi đúng file làm việc; chọn file khác xoá trạng thái', async ({ page }) => {
    test.setTimeout(120_000)
    const { base, lk, rows } = await refusedSetup()
    const total = base.preview.rowCount as number, customers = base.preview.customerCount as number
    const previews: any[] = []
    let commitForm = ''
    await page.route('**/api/care/import/preview', async (r) => { const p = await previewOfPosted(r, lk); previews.push(p.json); await fulfill(r, p.status, p.json) })
    await page.route('**/api/care/import/commit', async (r) => {
      commitForm = r.request().postDataBuffer()!.toString('latin1')
      await fulfill(r, 200, { ok: true, result: { status: 'committed', batch_id: 'b', created: customers - 2, updated: 0, unchanged: 0, skipped_has_interaction: 0, closed_previous_period: 0 }, previewCounts: previews.at(-1).preview.counts })
    })
    await openWizard(page)
    await upload(page)
    const wiz = page.getByTestId('care-import-wizard')
    const issues = wiz.getByTestId('care-import-issues')
    await expect(issues).toContainText(`${rows.length} lỗi`)
    await expect(wiz.getByRole('button', { name: 'Tiếp: xem phân công' })).toHaveCount(0)   // còn lỗi ⇒ không có đường đi tiếp
    // Chưa chọn nhóm lỗi ⇒ chưa có nút loại (không loại nhầm khi đang xem lỗi khác).
    await expect(wiz.getByTestId('care-import-refused-action')).toHaveCount(0)
    await issues.getByRole('button', { name: /Khách đã từ chối/ }).click()
    const action = wiz.getByTestId('care-import-refused-action')
    await expect(action).toContainText(`2 khách (${rows.length} dòng sản phẩm)`)
    await shot(page, 'refused-1-action')
    await action.getByRole('button', { name: 'Loại khỏi lần nhập' }).click()
    const dlg = page.getByTestId('care-import-refused-dialog')
    await expect(dlg.getByTestId('refused-customers')).toHaveText('2')
    await expect(dlg.getByTestId('refused-rows')).toHaveText(String(rows.length))
    await expect(dlg.getByTestId('refused-remaining')).toHaveText(`${customers - 2} khách · ${total - rows.length} dòng`)
    // "Không loại" ⇒ không gửi gì, lỗi còn nguyên.
    await dlg.getByRole('button', { name: 'Không loại' }).click()
    await expect(dlg).toHaveCount(0)
    expect(previews).toHaveLength(1)
    await action.getByRole('button', { name: 'Loại khỏi lần nhập' }).click()
    await page.getByTestId('care-import-refused-dialog').getByRole('button', { name: 'Loại 2 khách và kiểm tra lại' }).click()

    const note = wiz.getByTestId('care-import-excluded')
    await expect(note).toContainText(`Đã loại 2 khách đã từ chối (${rows.length} dòng sản phẩm)`)
    await expect(wiz.getByTestId('care-import-issues')).toHaveCount(0)
    expect(previews).toHaveLength(2)
    expect(previews[1].preview).toMatchObject({ errorCount: 0, rowCount: total - rows.length, customerCount: customers - 2, refused: { customerCount: 0, rows: [] } })
    expect(previews[1].sha256).not.toBe(previews[0].sha256)
    // File làm việc đúng bằng file gốc bỏ các dòng server chỉ ra (cùng hàm thuần).
    const want = excludeCareCsvRows(new Uint8Array(fixture), rows)
    if (!want.ok) throw new Error(want.reason)
    expect(previews[1].sha256).toBe(crypto.createHash('sha256').update(want.bytes).digest('hex'))
    await expect(wiz.getByRole('button', { name: new RegExp(`Tạo mới \\(${customers - 2}\\)`) })).toBeVisible()
    await shot(page, 'refused-2-rechecked')

    await wiz.getByRole('button', { name: 'Tiếp: xem phân công' }).click()
    await wiz.getByRole('button', { name: 'Tiếp: xác nhận' }).click()
    await expect(wiz.getByTestId('care-import-excluded-summary')).toHaveText(`2 khách đã từ chối · ${rows.length} dòng`)
    await shot(page, 'refused-3-confirm')
    await wiz.getByRole('button', { name: 'Xác nhận import' }).click()
    await expect(page.getByTestId('care-import-result')).toContainText('Đã import')
    expect(commitForm).toContain(previews[1].sha256)            // sha + bytes của file làm việc, không phải file gốc
    expect(commitForm).not.toContain(previews[0].sha256)
    expect(Buffer.from(commitForm, 'latin1').includes(Buffer.from(want.bytes))).toBe(true)
  })

  // PM 23/11/2026 (audit r1, P1): cùng mã khách ở HAI cửa hàng, chỉ một nơi đã từ chối ⇒ nhóm đó KHÔNG được loại; giao diện tách rõ
  // "được loại" (số trong khối hành động + hộp xác nhận) với "giữ lại để sửa". Sau khi loại, lỗi không nhất quán vẫn chặn.
  for (const order of ['A trước B', 'B trước A'] as const) {
    test(`r1.1 — khách hai cửa hàng (${order}): chỉ khách từ chối hợp lệ bị loại, nhóm mâu thuẫn ở lại + có dòng giải thích, vẫn chặn ghi`, async ({ page }) => {
      test.setTimeout(120_000)
      const { base, lk, rows } = await refusedSetup()
      const total = base.preview.rowCount as number, customers = base.preview.customerCount as number
      // Hai dòng của MỘT mã khách mới ở hai cửa hàng khác nhau (email đúng cửa hàng từng dòng); đã từ chối ở cửa hàng A.
      const rowOf = (storeIdx: number, pid: string) => ['QA-AB', 'KH QA-AB', '0390000777', STORES[storeIdx].code, STORES[storeIdx].assigneeEmails[0], 'chronic', 'QA', pid, `SP ${pid}`, ''].join(',')
      const a = rowOf(3, 'PAB1'), b = rowOf(4, 'PAB2')
      const text = fixture.toString('utf8').replace(/\s+$/, '')
      const dirty = Buffer.from(`${text}\r\n${order === 'A trước B' ? `${a}\r\n${b}` : `${b}\r\n${a}`}\r\n`)
      lk.customers.set('QA-AB', { id: 'c-QA-AB', isTest: false })
      lk.refusals.add('c-QA-AB|s3')
      const previews: any[] = []
      await page.route('**/api/care/import/preview', async (r) => { const p = await previewOfPosted(r, lk); previews.push(p.json); await fulfill(r, p.status, p.json) })
      await openWizard(page)
      await upload(page, dirty)
      const wiz = page.getByTestId('care-import-wizard')
      expect(previews[0].preview.refused).toEqual({ customerCount: 2, rows, inconsistentCustomerCount: 1 })   // hai dòng QA-AB KHÔNG có trong danh sách loại
      await wiz.getByTestId('care-import-issues').getByRole('button', { name: /Khách đã từ chối/ }).click()
      const action = wiz.getByTestId('care-import-refused-action')
      await expect(action).toContainText(`2 khách (${rows.length} dòng sản phẩm)`)
      const held = wiz.getByTestId('care-import-refused-inconsistent')
      await expect(held).toContainText('1 khách')
      await expect(held).toContainText('không loại tự động')
      await shot(page, `refused-r11-${order === 'A trước B' ? 'ab' : 'ba'}-1-action`)
      await action.getByRole('button', { name: 'Loại khỏi lần nhập' }).click()
      const dlg = page.getByTestId('care-import-refused-dialog')
      await expect(dlg.getByTestId('refused-customers')).toHaveText('2')
      await expect(dlg.getByTestId('refused-rows')).toHaveText(String(rows.length))
      await expect(dlg.getByTestId('refused-inconsistent')).toHaveText('1 khách')
      await expect(dlg.getByTestId('refused-remaining')).toHaveText(`${customers + 1 - 2} khách · ${total + 2 - rows.length} dòng`)
      await dlg.getByRole('button', { name: 'Loại 2 khách và kiểm tra lại' }).click()
      await expect(wiz.getByTestId('care-import-excluded')).toContainText(`Đã loại 2 khách đã từ chối (${rows.length} dòng sản phẩm)`)
      // Kiểm tra lại: file làm việc = file gốc bỏ đúng các dòng server chỉ ra; hai dòng QA-AB còn nguyên; preview KHÔNG sạch.
      expect(previews).toHaveLength(2)
      const want = excludeCareCsvRows(new Uint8Array(dirty), rows)
      if (!want.ok) throw new Error(want.reason)
      expect(previews[1].sha256).toBe(crypto.createHash('sha256').update(want.bytes).digest('hex'))
      const kept = Buffer.from(want.bytes).toString('utf8')
      expect(kept).toContain(a); expect(kept).toContain(b)
      expect(previews[1].preview).toMatchObject({ rowCount: total + 2 - rows.length, customerCount: customers + 1 - 2, refused: { customerCount: 0, rows: [], inconsistentCustomerCount: 1 } })
      expect(previews[1].preview.errorCounts.INCONSISTENT_CUSTOMER).toBe(2)
      const issues = wiz.getByTestId('care-import-issues')
      await expect(issues).toBeVisible()
      await expect(wiz.getByTestId('care-import-blocked')).toBeVisible()
      await expect(wiz.getByRole('button', { name: 'Tiếp: xem phân công' })).toHaveCount(0)      // lỗi không nhất quán vẫn chặn
      await expect(wiz.getByTestId('care-import-refused-action')).toHaveCount(0)                // không còn gì ĐƯỢC loại ⇒ không có nút
      // Nhóm "Khách đã từ chối" chỉ còn khi dòng ĐẦU của nhóm mâu thuẫn là cửa hàng đã từ chối (mã lỗi theo phép kiểm của finalize).
      const chip = issues.getByRole('button', { name: /Khách đã từ chối/ })
      if (order === 'A trước B') {
        await chip.click()
        await expect(wiz.getByTestId('care-import-refused-inconsistent')).toContainText('1 khách')
        await expect(wiz.getByTestId('care-import-refused-action')).toHaveCount(0)
        await shot(page, 'refused-r11-ab-2-after')
      } else {
        await expect(chip).toHaveCount(0)
      }
      // Dù thứ tự nào, nhóm "Khách không nhất quán" cũng có dòng chỉ dẫn (không có nút loại).
      await issues.getByRole('button', { name: /Khách không nhất quán/ }).click()
      await expect(wiz.getByTestId('care-import-refused-inconsistent')).toContainText('không loại tự động')
      await expect(wiz.getByTestId('care-import-refused-action')).toHaveCount(0)
    })
  }

  test('còn lỗi KHÁC sau khi loại: vẫn chặn, nhóm "Khách đã từ chối" biến mất; đổi file ⇒ dòng "Đã loại" biến mất', async ({ page }) => {
    test.setTimeout(120_000)
    const { lk, rows } = await refusedSetup()
    // Thêm một dòng sai mã cửa hàng vào cuối file.
    const text = fixture.toString('utf8').replace(/\s+$/, '')
    const last = text.split('\r\n').at(-1)!.split(',')
    last[0] = 'QA-BAD-STORE'; last[3] = 'QAOS99'
    const dirty = Buffer.from(`${text}\r\n${last.join(',')}\r\n`)
    await page.route('**/api/care/import/preview', async (r) => { const p = await previewOfPosted(r, lk); await fulfill(r, p.status, p.json) })
    await openWizard(page)
    await upload(page, dirty)
    const wiz = page.getByTestId('care-import-wizard')
    await wiz.getByTestId('care-import-issues').getByRole('button', { name: /Khách đã từ chối/ }).click()
    await wiz.getByTestId('care-import-refused-action').getByRole('button', { name: 'Loại khỏi lần nhập' }).click()
    await page.getByTestId('care-import-refused-dialog').getByRole('button', { name: 'Loại 2 khách và kiểm tra lại' }).click()
    await expect(wiz.getByTestId('care-import-excluded')).toContainText(`${rows.length} dòng sản phẩm`)
    const issues = wiz.getByTestId('care-import-issues')
    await expect(issues).toContainText('1 lỗi')
    await expect(issues.getByRole('button', { name: /Khách đã từ chối/ })).toHaveCount(0)
    await expect(wiz.getByTestId('care-import-refused-action')).toHaveCount(0)
    await expect(wiz.getByRole('button', { name: 'Tiếp: xem phân công' })).toHaveCount(0)   // còn lỗi ⇒ không có đường đi tiếp
    // Chọn file khác (file sạch) ⇒ trạng thái "đã loại" của file cũ không bám theo.
    lk.refusals.clear()
    await wiz.getByRole('button', { name: 'Chọn file đã sửa' }).click()
    await expect(wiz.getByTestId('care-import-excluded')).toHaveCount(0)
    await upload(page)
    await expect(wiz.getByText('Khách (task)')).toBeVisible()
    await expect(wiz.getByTestId('care-import-excluded')).toHaveCount(0)
    await expect(wiz.getByRole('button', { name: 'Tiếp: xem phân công' })).toBeEnabled()
  })
})

test.describe('care PM 22/11 — wizard mobile: loại khách đã từ chối @mobile', () => {
  test.skip(!HAS_STATE, 'chưa có storageState super')
  test.use({ storageState: SUPER_STATE })

  test('360px: khối hành động + hộp xác nhận không tràn ngang, nút ≥ 44px; loại xong kiểm tra lại sạch', async ({ page }) => {
    test.setTimeout(120_000)
    const { lk, rows } = await refusedSetup()
    await page.route('**/api/care/import/preview', async (r) => { const p = await previewOfPosted(r, lk); await fulfill(r, p.status, p.json) })
    await openWizard(page)
    await upload(page)
    const wiz = page.getByTestId('care-import-wizard')
    await wiz.getByTestId('care-import-issues').getByRole('button', { name: /Khách đã từ chối/ }).click()
    const open = wiz.getByTestId('care-import-refused-action').getByRole('button', { name: 'Loại khỏi lần nhập' })
    expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    expect(await noPageOverflow(page)).toBe(true)
    await shot(page, `refused-mobile-${page.viewportSize()!.width}-action`)
    await open.click()
    const dlg = page.getByTestId('care-import-refused-dialog')
    await expect.poll(async () => (await dlg.getByRole('button', { name: 'Không loại' }).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)   // chờ hết hiệu ứng mở
    const box = (await dlg.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1)
    for (const name of ['Không loại', 'Loại 2 khách và kiểm tra lại']) expect((await dlg.getByRole('button', { name }).boundingBox())!.height, name).toBeGreaterThanOrEqual(44)
    await dlg.getByRole('button', { name: 'Loại 2 khách và kiểm tra lại' }).click()
    await expect(wiz.getByTestId('care-import-excluded')).toContainText(`${rows.length} dòng sản phẩm`)
    await expect(wiz.getByTestId('care-import-issues')).toHaveCount(0)
    expect(await noPageOverflow(page)).toBe(true)
  })
})
