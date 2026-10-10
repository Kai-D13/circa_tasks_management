import fs from 'node:fs'
import path from 'node:path'
import { test, expect, request as pwRequest, type Page, type Route } from '@playwright/test'
import { SUPER_STATE } from './authState'
import { saveLocatorShot } from './qaShot'
import { handleCarePreview, type CareImportDeps } from '../lib/care/import/handler'
import type { CareImportLookups } from '../lib/care/import/preview'
import { buildCareImportXlsx, defaultFixtureStores } from './careImportFixture'

// CRM-CSKH B2 — UI wizard Phân công + smoke API thật.
//
// UI chạy trên /ui-catalog/care-import (UI_CATALOG=1 + super — Coolify không bao
// giờ đặt ⇒ prod 404) với API GIẢ bằng page.route: DB chưa có migration 114 ở
// B2 nên không gọi được API thật. JSON giả được dựng bằng CHÍNH handler thật
// (lib/care/import/handler.ts) trên fixture Excel giả B0 ⇒ đúng shape thật.
// Ảnh chụp chỉ phần wizard (ẩn shell có tên người dùng thật) ⇒ lưu vào
// qa-artifacts/ (gitignored), không phải snapshot commit.
//
// Smoke API thật (server QA, cờ CARE_ENABLED tắt mặc định): route/page trả 404,
// không đăng nhập bị proxy đẩy về /login.

const HAS_STATE = fs.existsSync(SUPER_STATE)
const SHOTS = path.resolve(__dirname, '..', 'qa-artifacts', 'care-b2-ui')
const STORES = defaultFixtureStores(25)
const fixture = Buffer.from(buildCareImportXlsx())

function lookups(): CareImportLookups {
  return {
    storesByCode: new Map(STORES.map((s, i) => [s.code, { id: `s${i}`, code: s.code, name: `QA store ${i + 1}` }])),
    staff: STORES.flatMap((s, i) => s.assigneeEmails.map((e) => ({ id: e, storeId: `s${i}`, email: e, fullName: `QA dược sĩ ${e.slice(9, 12)}` }))),
    customers: new Map(), refusals: new Set(), currentTasks: new Map(), currentPeriodTaskCount: 0, openPreviousPeriodCount: 0,
  }
}
async function realPreviewJson(bytes: Uint8Array, lk = lookups()) {
  const fd = new FormData()
  fd.append('file', new File([new Uint8Array(bytes)], 'care.xlsx'))
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
  await page.locator('input[type="file"]').setInputFiles({ name: 'care_T10.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bytes })
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
    await expect(wiz.getByText(`${previewJson.preview.errorCount} lỗi`, { exact: true })).toBeVisible()
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
      const res = await page.request.post(p, { multipart: { file: { name: 'care.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: fixture } } })
      expect(res.status(), p).toBe(404)
      expect(await res.json(), p).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    }
    expect((await page.request.get('/api/care/import/template')).status()).toBe(404)
  })

  test('không đăng nhập: proxy đẩy về /login, không tới handler', async ({ baseURL }) => {
    const ctx = await pwRequest.newContext({ baseURL, storageState: { cookies: [], origins: [] } })
    const res = await ctx.post('/api/care/import/preview', { maxRedirects: 0, multipart: { file: { name: 'a.xlsx', mimeType: 'application/octet-stream', buffer: fixture } } })
    expect([302, 307]).toContain(res.status())
    expect(res.headers()['location']).toContain('/login')
    await ctx.dispose()
  })
})
