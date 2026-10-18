import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { MANAGER_STATE, SM_STATE, STAFF_STATE, SUPER_STATE } from './authState'
import { editLoadDecision } from '../lib/announcements/editLoad'

// UI v2 Phase 3 · Bảng tin — A3 form tạo/sửa + ảnh (artboard B3). (1) fixture ?fx=form-* render ĐÚNG
// AnnouncementFormView + CreateAnnouncementForm + AnnouncementImageUpload trong boundary: 3 khối, editor một viền, lọc cửa
// hàng giữ lựa chọn, tóm tắt từ state, nút xoá ảnh 44px, lỗi tải ≠ bộ chọn rỗng; GUARD gửi form + chọn file (chuột,
// Enter, setInputFiles; mọi request ghi bị abort trước mạng) ⇒ 0 request + đếm chặn; (2) guard tĩnh: mọi component
// Bảng tin gọi action ghi / upload phải hỏi useAnnouncementFixtureBlocked; (3) route thật chỉ đọc: super mở /new và
// /edit (không gửi), 0 request ghi; staff/QLCH/SM bị chuyển về /announcements như cũ.

const ROOT = 'ui-catalog-ann-v2'
const THEMES = ['light', 'dark'] as const
// PNG 1×1 hợp lệ — chỉ để chọn file; guard phải chặn trước khi nén/tải.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

async function openFx(page: Page, fx: string, theme: (typeof THEMES)[number] = 'light') {
  await page.goto(`/ui-catalog/announcements-v2?fx=${fx}`)
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
  await expect(page.getByTestId(ROOT)).toHaveAttribute('data-fx', fx, { timeout: 20_000 })
  await page.evaluate(() => document.fonts.ready)
}
const view = (page: Page) => page.locator('main [data-ann-form-page]')
const form = (page: Page) => view(page).locator('[data-ann-form]')
const blocked = (page: Page) => page.locator('[data-ann-fixture-blocked]')
async function hydrated(page: Page) {
  await expect.poll(() => form(page).locator('[data-ann-submit]').evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactProps')))).toBe(true)
}

async function blockWrites(page: Page, appOnly = false) {
  const writes: { method: string; url: string; action: boolean }[] = []
  const appOrigin = new URL(test.info().project.use.baseURL!).origin
  await page.route('**/*', (route) => {
    const r = route.request()
    if (r.method() === 'GET' || r.method() === 'HEAD') return route.continue()
    if (appOnly && new URL(r.url()).origin !== appOrigin) return route.continue()
    writes.push({ method: r.method(), url: r.url(), action: !!r.headers()['next-action'] })
    return route.abort()
  })
  return writes
}

async function noPageOverflow(page: Page) {
  const g = await page.evaluate(() => {
    const m = document.querySelector('main')!
    return { sw: document.documentElement.scrollWidth, iw: window.innerWidth, msw: m.scrollWidth, mcw: m.clientWidth }
  })
  expect(g.sw, 'trang cuộn ngang').toBeLessThanOrEqual(g.iw + 1)
  expect(g.msw, '<main> cuộn ngang').toBeLessThanOrEqual(g.mcw + 1)
}

// ── Guard tĩnh ───────────────────────────────────────────────────────────────────────────────────────────
test.describe('bảng tin — guard fixture tĩnh @desktop', () => {
  test('component Bảng tin gọi action ghi / upload đều hỏi useAnnouncementFixtureBlocked; MarkAnnouncementRead không vào view/fixture', () => {
    const root = path.resolve(__dirname, '..')
    const dir = path.join(root, 'components/announcements')
    const WRITE = /\b(createAnnouncement|updateAnnouncement|deleteAnnouncement)\(|\buploadViaGcs\(|\.upload\(/
    const guarded: string[] = []
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.tsx'))) {
      const s = fs.readFileSync(path.join(dir, f), 'utf8')
      if (!WRITE.test(s)) continue
      guarded.push(f)
      expect(s, `${f} gọi action ghi/upload nhưng không hỏi guard fixture`).toMatch(/useAnnouncementFixtureBlocked\(\)/)
      expect(s, `${f}: guard phải được gọi (if (fixtureBlocked()) …)`).toMatch(/if \(fixtureBlocked\(\)\)/)
    }
    expect(guarded.sort()).toEqual(['AnnouncementAdminActions.tsx', 'AnnouncementImageUpload.tsx', 'CreateAnnouncementForm.tsx'])
    // Guard phải là câu ĐẦU của handler (trước validate / confirm / nén / upload) — không chỉ "có mặt đâu đó" (pm-auditor A3 P1-2).
    const src = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8')
    expect(src('CreateAnnouncementForm.tsx')).toMatch(/function submit\(\) \{\s*if \(fixtureBlocked\(\)\) return\n/)
    expect(src('AnnouncementAdminActions.tsx')).toMatch(/function onDelete\(\) \{\s*if \(fixtureBlocked\(\)\) return\n/)
    expect(src('AnnouncementImageUpload.tsx')).toMatch(/async function handleFiles\(files: FileList \| null\) \{\s*if \(!files\?\.length\) return\s*if \(fixtureBlocked\(\)\) \{/)
    // markAnnouncementRead chỉ ở MarkAnnouncementRead, và component đó chỉ mount ở page chi tiết thật.
    for (const f of ['components/announcements/AnnouncementDetailView.tsx', 'app/(dashboard)/ui-catalog/announcements-v2/page.tsx']) {
      expect(fs.readFileSync(path.join(root, f), 'utf8'), `${f} không được mount ghi nhận đọc`).not.toMatch(/MarkAnnouncementRead|markAnnouncementRead/)
    }
  })
})

// Nhánh lỗi PHÍA SERVER của /new và /edit không ép được bằng page.route (truy vấn chạy trên server) ⇒ khoá bằng đọc
// mã (pm-auditor A3 P1-1): đúng `error` của chính các truy vấn, đúng thứ tự quyền như cũ; nhánh 404 thật kiểm ở route.
test.describe('bảng tin — nhánh lỗi /new /edit (tĩnh) @desktop', () => {
  test('/edit: bắt error của cả 4 truy vấn; thứ tự tin lỗi → 404 → redirect quyền → dữ liệu phụ lỗi (fail-closed) → cửa hàng lỗi chỉ báo; /new: storesError', () => {
    const root = path.resolve(__dirname, '..')
    const edit = fs.readFileSync(path.join(root, 'app/(dashboard)/announcements/[id]/edit/page.tsx'), 'utf8')
    for (const v of ['data: ann, error: annErr', 'data: stores, error: storesErr', 'data: aStores, error: aStoresErr', 'data: assets, error: assetsErr']) {
      expect(edit, `/edit phải lấy ${v}`).toContain(v)
    }
    const at = (needle: string) => { const i = edit.indexOf(needle); expect(i, `/edit thiếu: ${needle}`).toBeGreaterThan(-1); return i }
    const order = [
      at('if (annErr) return errorView(annErr)'),
      at('if (!ann) notFound()'),
      at("if (ann.created_by !== user.id && !isSuperAdminEmail(user.email)) redirect(`/announcements/${id}`)"),
      at('const load = editLoadDecision({'),
      at('aStoresErr: !!aStoresErr, assetsErr: !!assetsErr, storesErr: !!storesErr'),
      at("if (load.kind === 'error') return errorView("),
      at('storesError={load.storesError}'),
    ]
    expect(order, '/edit: sai thứ tự xử lý lỗi/quyền').toEqual([...order].sort((a, b) => a - b))
    // R1-01 nối THẬT: đối tượng nhận đưa vào editLoadDecision phải là của chính tin (không gán cứng 'all').
    expect(edit).toContain("visibility: (ann.visibility as 'all' | 'stores') ?? 'all',\n  })\n  if (load.kind === 'error')")
    const nw = fs.readFileSync(path.join(root, 'app/(dashboard)/announcements/new/page.tsx'), 'utf8')
    expect(nw).toContain("if (profile?.role !== 'admin') redirect('/announcements')")
    expect(nw).toContain('storesError={!!storesErr}')
  })

  test('editLoadDecision (R1-01): cửa hàng đích/ảnh lỗi ⇒ error; danh sách cửa hàng lỗi + tin THEO CỬA HÀNG ⇒ error; + tin TẤT CẢ ⇒ form chỉ "Tất cả"; không lỗi ⇒ form', () => {
    const d = (o: Partial<Parameters<typeof editLoadDecision>[0]>) =>
      editLoadDecision({ aStoresErr: false, assetsErr: false, storesErr: false, visibility: 'stores', ...o })
    expect(d({})).toEqual({ kind: 'form', storesError: false })
    expect(d({ visibility: 'all' })).toEqual({ kind: 'form', storesError: false })
    expect(d({ aStoresErr: true })).toEqual({ kind: 'error' })
    expect(d({ assetsErr: true, visibility: 'all' })).toEqual({ kind: 'error' })
    expect(d({ storesErr: true, visibility: 'stores' })).toEqual({ kind: 'error' })
    expect(d({ storesErr: true, visibility: 'all' })).toEqual({ kind: 'form', storesError: true })
  })
})

// ── Fixture ──────────────────────────────────────────────────────────────────────────────────────────────
test.describe('ui v2 Bảng tin A3 — fixture form @desktop', () => {
  test.skip(!fs.existsSync(SUPER_STATE), 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('tạo mới: 3 khối, tiêu đề bắt buộc, chữ hướng dẫn khớp validation, editor MỘT viền, đếm ảnh 0/5, centered 720px', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await openFx(page, 'form-new')
    await expect(view(page)).toHaveAttribute('data-layout-width', 'centered')
    expect(await view(page).evaluate((el) => getComputedStyle(el).maxWidth)).toBe('720px')
    await expect(view(page).locator('h1')).toHaveText('Tạo thông báo')
    await expect(view(page).locator('[data-ann-back]')).toHaveText('Bảng tin')
    expect(await form(page).locator('section > div h2').allInnerTexts()).toEqual(['Nội dung', 'Hình ảnh', 'Gửi cho'])
    await expect(form(page).locator('label[for="ann-title"]')).toHaveText('Tiêu đề *')
    await expect(form(page).locator('#ann-title')).toHaveAttribute('aria-required', 'true')
    await expect(form(page)).toContainText('Có thể dán bảng từ Excel. Cần nội dung hoặc ít nhất một ảnh.')
    await expect(form(page)).toContainText('jpg, png, webp · ảnh được nén tự động')
    await expect(form(page).locator('[data-ann-upload="carousel"] [data-ann-upload-count]')).toHaveText(' · 0/5')
    await expect(form(page).locator('[data-ann-upload="cover"] [data-ann-upload-count]')).toHaveCount(0)
    // Editor một viền: khung ngoài 1px, thanh công cụ KHÔNG viền trên (flush border-y bị khung bỏ cạnh trên).
    await hydrated(page)
    const ed = form(page).locator('[data-ann-editor]')
    await expect(ed.locator('.ProseMirror')).toBeVisible()
    const b = await ed.evaluate((el) => {
      const toolbar = el.firstElementChild!.firstElementChild as HTMLElement
      const cs = getComputedStyle(el); const ts = getComputedStyle(toolbar)
      return { outerTop: cs.borderTopWidth, outerLeft: cs.borderLeftWidth, toolbarTop: ts.borderTopWidth, rootBorder: getComputedStyle(el.firstElementChild!).borderTopWidth }
    })
    expect(b).toEqual({ outerTop: '1px', outerLeft: '1px', toolbarTop: '0px', rootBorder: '0px' })
    // Nhãn nằm TRÊN ô nhập (B3) — không cùng dòng.
    for (const id of ['ann-title', 'ann-expires']) {
      const lb = (await form(page).locator(`label[for="${id}"]`).boundingBox())!
      const ip = (await form(page).locator(`#${id}`).boundingBox())!
      expect(ip.y, `${id}: ô nhập phải ở dưới nhãn`).toBeGreaterThanOrEqual(lb.y + lb.height - 1)
    }
  })

  test('gửi cho: lọc bỏ dấu, GIỮ lựa chọn khi đổi từ khóa; "Đã chọn N/25" (M = toàn bộ đã tải); tóm tắt chỉ từ state; không khớp ⇒ câu riêng', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await openFx(page, 'form-new')
    await hydrated(page)
    const f = form(page)
    const summary = f.locator('[data-ann-form-summary]')
    await expect(summary).toHaveText('Gửi đến tất cả')
    await expect(f.locator('[data-ann-visibility="all"]')).toHaveAttribute('aria-pressed', 'true')
    await f.locator('[data-ann-visibility="stores"]').click()
    const picker = f.locator('[data-ann-store-picker]')
    await expect(picker.locator('[data-ann-store-count]')).toHaveText('Đã chọn 0/25')
    await expect(summary).toHaveText('Gửi đến 0 cửa hàng')
    const filter = picker.locator('[data-ann-store-filter]')
    await filter.fill('thong nhat')
    await expect(picker.locator('[data-ann-store-option]')).toHaveText(['CIRCA THỐNG NHẤT'])
    await picker.locator('[data-ann-store-option]').first().click()
    await filter.fill('LUMI')
    await expect(picker.locator('[data-ann-store-option]')).toHaveText(['CIRCA LUMINA'])
    await picker.locator('[data-ann-store-option]').first().click()
    await filter.fill('xyz')
    await expect(picker).toContainText('Không có cửa hàng khớp.')
    await expect(picker).not.toContainText('Chưa có cửa hàng.')
    await filter.fill('')
    await expect(picker.locator('[data-ann-store-option]')).toHaveCount(25)
    await expect(picker.locator('input[type="checkbox"]:checked')).toHaveCount(2)
    await expect(picker.locator('[data-ann-store-count]')).toHaveText('Đã chọn 2/25')
    await expect(summary).toHaveText('Gửi đến 2 cửa hàng')
    await f.locator('#ann-expires').fill('2026-10-20')
    await expect(summary).toHaveText('Gửi đến 2 cửa hàng · hết hạn 20/10/2026')
    await f.locator('#ann-expires').fill('')
    await expect(summary).toHaveText('Gửi đến 2 cửa hàng')
    await f.locator('[data-ann-visibility="all"]').click()
    await expect(summary).toHaveText('Gửi đến tất cả')
  })

  test('sửa: dữ liệu ban đầu đúng; nút xoá ảnh LUÔN hiện, aria-label riêng, ≥44px; bỏ 1 ảnh carousel chỉ đổi state (0 request)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await openFx(page, 'form-edit')
    await hydrated(page)
    const writes = await blockWrites(page)
    const f = form(page)
    await expect(view(page).locator('h1')).toHaveText('Sửa thông báo')
    await expect(view(page).locator('[data-ann-back]')).toHaveText('Quay lại')
    await expect(f.locator('#ann-title')).toHaveValue('Lịch trực Tết Dương lịch 2027 — đăng ký trước 20/10')
    await expect(f.locator('[data-ann-submit]')).toHaveText('Lưu thay đổi')
    await expect(f.locator('[data-ann-form-summary]')).toHaveText('Gửi đến 4 cửa hàng · hết hạn 20/10/2026')
    await expect(f.locator('[data-ann-store-count]')).toHaveText('Đã chọn 4/25')
    await expect(f.locator('[data-ann-upload="carousel"] [data-ann-upload-count]')).toHaveText(' · 3/5')
    const labels = await f.locator('[data-ann-image-remove]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
    expect(labels).toEqual(['Xóa ảnh bìa', 'Xóa ảnh carousel 1', 'Xóa ảnh carousel 2', 'Xóa ảnh carousel 3'])
    await page.mouse.move(1, 1)
    for (const box of await f.locator('[data-ann-image-remove]').evaluateAll((els) => els.map((e) => {
      const r = e.getBoundingClientRect(); const dot = e.firstElementChild as HTMLElement
      return { w: r.width, h: r.height, op: getComputedStyle(dot).opacity, vis: getComputedStyle(dot).visibility }
    }))) expect(box).toEqual({ w: 44, h: 44, op: '1', vis: 'visible' })
    await f.getByRole('button', { name: 'Xóa ảnh carousel 2' }).click()
    await expect(f.locator('[data-ann-upload="carousel"] [data-ann-upload-count]')).toHaveText(' · 2/5')
    await expect(f.locator('[data-ann-upload="carousel"] [data-ann-image-tile]')).toHaveCount(2)
    await page.waitForTimeout(400)
    expect(writes).toEqual([])
  })

  test('lỗi: cửa hàng lỗi (/new) ⇒ Notice KHỚP trạng thái: chỉ "Tất cả", nút "Chọn cửa hàng" TẮT, không bộ chọn, "Gửi đến tất cả"; 0 cửa hàng thật ⇒ "Chưa có cửa hàng."; trang sửa lỗi ⇒ ErrorState', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await openFx(page, 'form-stores-error')
    await hydrated(page)
    await expect(form(page)).toContainText('Không tải được danh sách cửa hàng — chỉ có thể gửi cho “Tất cả”. Thử lại sau hoặc báo Admin.')
    await expect(form(page).locator('[data-ann-visibility="all"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(form(page).locator('[data-ann-visibility="stores"]')).toBeDisabled()
    await form(page).locator('[data-ann-visibility="stores"]').click({ force: true }) // bấm cưỡng bức vào nút tắt: không đổi gì
    await expect(form(page).locator('[data-ann-visibility="all"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(form(page).locator('[data-ann-form-summary]')).toHaveText('Gửi đến tất cả')
    await expect(form(page).locator('[data-ann-store-picker]')).toHaveCount(0)
    await expect(form(page)).not.toContainText('Chưa có cửa hàng.')
    await expect(form(page)).not.toContainText('Gửi đến 0 cửa hàng')
    await openFx(page, 'form-nostores')
    await hydrated(page)
    await form(page).locator('[data-ann-visibility="stores"]').click()
    await expect(form(page).locator('[data-ann-store-picker]')).toContainText('Chưa có cửa hàng.')
    await expect(form(page).locator('[data-ann-store-count]')).toHaveText('Đã chọn 0/0')
    await openFx(page, 'form-edit-error')
    await expect(view(page)).toHaveAttribute('data-ann-form-page', 'error')
    await expect(view(page).locator('[role="alert"]')).toContainText('Không tải được thông báo.')
    await expect(view(page).locator('h1')).toHaveText('Sửa thông báo')
    await expect(view(page).locator('[data-ann-form], input, textarea')).toHaveCount(0)
  })

  test('R1-01 /edit: tin THEO CỬA HÀNG + danh sách cửa hàng lỗi ⇒ CHỈ ErrorState, không form; tin TẤT CẢ + lỗi ⇒ form mở, chỉ "Tất cả" (nút cửa hàng tắt), vẫn lưu được', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await openFx(page, 'form-edit-stores-error')
    await expect(view(page)).toHaveAttribute('data-ann-form-page', 'error')
    await expect(view(page).locator('[role="alert"]')).toContainText('Không tải được thông báo.')
    await expect(view(page).locator('[data-ann-form], input, textarea, [data-ann-submit]')).toHaveCount(0)
    await openFx(page, 'form-edit-all-stores-error')
    await hydrated(page)
    await expect(view(page)).toHaveAttribute('data-ann-form-page', 'ok')
    const f = form(page)
    await expect(f).toContainText('chỉ có thể gửi cho “Tất cả”')
    await expect(f.locator('[data-ann-visibility="all"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(f.locator('[data-ann-visibility="stores"]')).toBeDisabled()
    await expect(f.locator('[data-ann-store-picker]')).toHaveCount(0)
    await expect(f.locator('[data-ann-form-summary]')).toHaveText('Gửi đến tất cả · hết hạn 20/10/2026')
    await expect(f.locator('[data-ann-submit]')).toBeEnabled()
    await expect(f.locator('[data-ann-submit]')).toHaveText('Lưu thay đổi')
  })

  test('GUARD đứng TRƯỚC validate: tiêu đề rỗng, bấm Gửi ⇒ đếm chặn 1, KHÔNG toast "Vui lòng nhập tiêu đề", 0 request', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await openFx(page, 'form-new')
    await hydrated(page)
    const writes = await blockWrites(page)
    await expect(form(page).locator('#ann-title')).toHaveValue('')
    await form(page).locator('[data-ann-submit]').click()
    await expect(blocked(page)).toHaveAttribute('data-ann-fixture-blocked', '1')
    await page.waitForTimeout(600)
    await expect(page.getByText('Vui lòng nhập tiêu đề')).toHaveCount(0)
    expect(writes).toEqual([])
  })

  for (const fx of ['form-new', 'form-edit']) {
    test(`GUARD (${fx}): gửi bằng chuột + Enter, chọn file ảnh bìa + carousel ⇒ đếm chặn 4, 0 request ghi/upload, 0 dialog, ảnh không đổi`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 1000 })
      await openFx(page, fx)
      await hydrated(page)
      const writes = await blockWrites(page)
      const dialogs: string[] = []
      page.on('dialog', (d) => { dialogs.push(d.message()); void d.accept() })
      const f = form(page)
      if (fx === 'form-new') await f.locator('#ann-title').fill('Bản mẫu UI — không được gửi')
      const tilesBefore = await f.locator('[data-ann-image-tile]').count()
      const submit = f.locator('[data-ann-submit]')
      await submit.click()
      await expect(blocked(page)).toHaveAttribute('data-ann-fixture-blocked', '1')
      await submit.focus()
      await page.keyboard.press('Enter')
      await expect(blocked(page)).toHaveAttribute('data-ann-fixture-blocked', '2')
      // Chọn file: chỉ ô còn chỗ (form-edit đã có ảnh bìa ⇒ ô bìa không còn ô thêm nhưng input vẫn có trong DOM).
      await f.locator('input[type="file"][aria-label="Ảnh bìa (tùy chọn)"]').setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: PNG })
      await expect(blocked(page)).toHaveAttribute('data-ann-fixture-blocked', '3')
      await f.locator('input[type="file"][aria-label="Ảnh carousel (tối đa 5, tùy chọn)"]').setInputFiles({ name: 'b.png', mimeType: 'image/png', buffer: PNG })
      await expect(blocked(page)).toHaveAttribute('data-ann-fixture-blocked', '4')
      await page.waitForTimeout(1000)
      expect(dialogs).toEqual([])
      expect(writes, 'fixture không được gửi request ghi/upload (create/update/createUploadUrl/storage)').toEqual([])
      await expect(f.locator('[data-ann-image-tile]')).toHaveCount(tilesBefore)
      await expect(f.locator('[data-ann-image-uploading]')).toHaveCount(0)
      expect(new URL(page.url()).pathname).toBe('/ui-catalog/announcements-v2')
    })
  }
})

test.describe('ui v2 Bảng tin A3 — fixture form @mobile', () => {
  test.skip(!fs.existsSync(SUPER_STATE), 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('360/390: không tràn; thanh hành động dính đáy, không che ô cuối khi cuộn hết, nằm trên bottom nav; chạm ≥44px', async ({ page }) => {
    await openFx(page, 'form-edit')
    await hydrated(page)
    await noPageOverflow(page)
    const bar = form(page).locator('[data-ann-form-bar]')
    const vh = page.viewportSize()!.height
    const navTop = await page.evaluate(() => {
      const n = [...document.querySelectorAll('nav')].find((e) => getComputedStyle(e).position === 'fixed' && e.getBoundingClientRect().bottom >= window.innerHeight - 1)
      return n ? n.getBoundingClientRect().top : window.innerHeight
    })
    // Đầu trang: thanh đã dính đáy (nhìn thấy), không lấn bottom nav.
    let r = (await bar.boundingBox())!
    expect(r.y + r.height, 'thanh phải nằm trong khung nhìn').toBeLessThanOrEqual(vh + 1)
    expect(r.y + r.height, 'thanh không đè bottom nav').toBeLessThanOrEqual(navTop + 1)
    // Cuộn hết: ô hạn chót (cuối nội dung) nằm TRÊN thanh.
    await page.evaluate(() => { const m = document.querySelector('main')!; m.scrollTop = m.scrollHeight })
    await page.waitForTimeout(300)
    r = (await bar.boundingBox())!
    const last = (await form(page).locator('#ann-expires').boundingBox())!
    expect(last.y + last.height, 'thanh không che ô cuối').toBeLessThanOrEqual(r.y + 1)
    for (const l of [form(page).locator('[data-ann-submit]'), form(page).getByRole('button', { name: 'Hủy' }), form(page).locator('[data-ann-visibility="stores"]'), form(page).locator('#ann-title'), form(page).locator('[data-ann-image-remove]').first()]) {
      expect((await l.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    }
  })
})

test.describe('ui v2 Bảng tin A3 — ảnh fixture @desktop', () => {
  test.skip(!fs.existsSync(SUPER_STATE), 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('form-edit 1440 + 1280 có sidebar + 390/360, sáng/tối; form-stores-error 1440 sáng (commit được)', async ({ page }, info) => {
    test.setTimeout(240_000)
    await page.context().addCookies([{ name: 'sidebar_collapsed', value: '0', url: info.project.use.baseURL! }])
    // Ảnh chụp CẢ trang dài (mở khoá cuộn) ⇒ thanh sticky sẽ dính đáy khung nhìn giữa ảnh; khi chụp đặt nó về static
    // (vị trí cuối nội dung, đúng DOM). Hành vi dính đáy thật được kiểm ở test @mobile phía trên.
    const unlock = (hideShell: boolean) => page.evaluate((hide) => {
      if (hide) document.querySelectorAll('header.bg-primary, aside.bg-sidebar, nav[aria-label="Điều hướng chính"]').forEach((el) => { (el as HTMLElement).style.display = 'none' })
      document.querySelectorAll('nextjs-portal, [data-sonner-toaster]').forEach((el) => { (el as HTMLElement).style.display = 'none' })
      document.querySelectorAll('[data-ann-form-bar]').forEach((el) => { (el as HTMLElement).style.position = 'static' })
      const main = document.querySelector('main'); const outer = main?.parentElement
      if (outer instanceof HTMLElement) { outer.style.height = 'auto'; outer.style.overflow = 'visible' }
      if (main instanceof HTMLElement) main.style.overflow = 'visible'
    }, hideShell)
    const snap = async (name: string) => {
      await page.mouse.move(1, 1)
      await page.waitForTimeout(300)
      expect(await view(page).screenshot({ animations: 'disabled' })).toMatchSnapshot(name, { maxDiffPixelRatio: 0.01 })
    }
    for (const theme of THEMES) {
      await page.setViewportSize({ width: 1440, height: 1000 })
      await openFx(page, 'form-edit', theme)
      await hydrated(page)
      await unlock(true)
      await snap(`form-edit-${theme}-d1440.png`)
      await page.setViewportSize({ width: 1280, height: 900 })
      await openFx(page, 'form-edit', theme)
      await hydrated(page)
      await expect(page.locator('aside.bg-sidebar').first()).toBeVisible()
      await unlock(false)
      await snap(`form-edit-${theme}-d1280.png`)
      for (const w of [390, 360]) {
        await page.setViewportSize({ width: w, height: 844 })
        await openFx(page, 'form-edit', theme)
        await hydrated(page)
        await unlock(true)
        await snap(`form-edit-${theme}-m${w}.png`)
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    await openFx(page, 'form-stores-error', 'light')
    await hydrated(page)
    await unlock(true)
    await snap('form-stores-error-light-d1440.png')
  })
})

// ── Route thật (chỉ đọc; không gửi; mọi request ghi cùng origin bị chặn trước mạng) ─────────────────────────────
test.describe('ui v2 Bảng tin A3 — route thật super @desktop', () => {
  test.skip(!fs.existsSync(SUPER_STATE), 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('super /announcements/new: v2 centered, 3 khối, bộ chọn có cửa hàng thật; 0 request ghi (không bấm gửi)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    const writes = await blockWrites(page, true)
    await page.goto('/announcements/new')
    expect(new URL(page.url()).pathname).toBe('/announcements/new')
    await expect(view(page)).toHaveAttribute('data-ann-form-page', 'ok', { timeout: 30_000 })
    await expect(view(page)).toHaveAttribute('data-ui-v2', 'page')
    await expect(view(page).locator('h1')).toHaveText('Tạo thông báo')
    expect(await form(page).locator('section > div h2').allInnerTexts()).toEqual(['Nội dung', 'Hình ảnh', 'Gửi cho'])
    await hydrated(page)
    await form(page).locator('[data-ann-visibility="stores"]').click()
    const count = (await form(page).locator('[data-ann-store-count]').innerText()).match(/Đã chọn (\d+)\/(\d+)/)!
    test.info().annotations.push({ type: 'nhánh', description: `super /new: ${count[0]}` })
    expect(Number(count[1])).toBe(0)
    expect(Number(count[2]), 'phải tải được danh sách cửa hàng OS').toBeGreaterThan(0)
    await expect(form(page).locator('[data-ann-store-option]')).toHaveCount(Number(count[2]))
    await page.waitForTimeout(800)
    expect(writes).toEqual([])
  })

  test('super /announcements/[id]/edit: form có dữ liệu thật nhất quán (tóm tắt ↔ bộ chọn ↔ số ảnh); 0 request ghi (không bấm lưu)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    const writes = await blockWrites(page, true)
    await page.goto('/announcements')
    const href = await page.locator('main [data-ann-card]').first().getAttribute('href', { timeout: 30_000 })
    expect(href).toMatch(/^\/announcements\/[0-9a-f-]{36}$/)
    await page.goto(`${href}/edit`)
    expect(new URL(page.url()).pathname).toBe(`${href}/edit`)
    await expect(view(page)).toHaveAttribute('data-ann-form-page', 'ok', { timeout: 30_000 })
    await hydrated(page)
    const f = form(page)
    expect((await f.locator('#ann-title').inputValue()).trim().length).toBeGreaterThan(0)
    await expect(f.locator('[data-ann-submit]')).toHaveText('Lưu thay đổi')
    const carouselTiles = await f.locator('[data-ann-upload="carousel"] [data-ann-image-tile]').count()
    await expect(f.locator('[data-ann-upload="carousel"] [data-ann-upload-count]')).toHaveText(` · ${carouselTiles}/5`)
    const summary = await f.locator('[data-ann-form-summary]').innerText()
    const stores = f.locator('[data-ann-visibility="stores"]')
    test.info().annotations.push({ type: 'nhánh', description: `super ${href}/edit: "${summary}", ${carouselTiles} ảnh carousel` })
    if ((await stores.getAttribute('aria-pressed')) === 'true') {
      const n = (await f.locator('[data-ann-store-count]').innerText()).match(/Đã chọn (\d+)\//)![1]
      expect(summary.startsWith(`Gửi đến ${n} cửa hàng`)).toBe(true)
    } else {
      expect(summary.startsWith('Gửi đến tất cả')).toBe(true)
    }
    await page.waitForTimeout(800)
    expect(writes).toEqual([])
  })
})

test.describe('ui v2 Bảng tin A3 — tin không tồn tại vẫn 404 (không thành ErrorState) @desktop', () => {
  test.skip(!fs.existsSync(SUPER_STATE), 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })
  // Route nằm dưới announcements/loading.tsx (có sẵn trên main) ⇒ Next stream khung chờ trước, notFound() ra HTTP 200 +
  // UI 404 (hành vi Next đã ghi ở RC Tasks §4) — nên khẳng định GIAO DIỆN not-found, không khẳng định mã HTTP.
  test('super: /announcements/<uuid không có>/edit và chi tiết ⇒ trang not-found của Next, KHÔNG form / ErrorState / chi tiết', async ({ page }) => {
    const missing = '00000000-0000-4000-8000-000000000000'
    for (const url of [`/announcements/${missing}/edit`, `/announcements/${missing}`]) {
      const res = await page.goto(url)
      expect(new URL(page.url()).pathname, `${url}: bị đẩy đi đâu?`).toBe(url)
      test.info().annotations.push({ type: 'nhánh', description: `${url}: HTTP ${res!.status()}` })
      expect([200, 404]).toContain(res!.status())
      await expect(page.getByText('This page could not be found.')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('[data-ann-form-page], [data-ann-detail], [data-ann-form], [role="alert"]:has-text("Không tải được")')).toHaveCount(0)
    }
  })
})

for (const [label, state] of [['staff', STAFF_STATE], ['QLCH', MANAGER_STATE], ['SM', SM_STATE]] as const) {
  test.describe(`ui v2 Bảng tin A3 — quyền ${label} @desktop`, () => {
    test.skip(!fs.existsSync(state), `chưa có phiên ${label}`)
    test.use({ storageState: state })
    test(`${label}: /announcements/new và /[id]/edit ⇒ về /announcements (quyền không đổi)`, async ({ page }) => {
      await page.goto('/announcements/new')
      await expect(page).toHaveURL(/\/announcements$/)
      const href = await page.locator('main [data-ann-card]').first().getAttribute('href', { timeout: 30_000 })
      await page.goto(`${href}/edit`)
      await expect(page).toHaveURL(/\/announcements$/)
      await expect(page.locator('[data-ann-form]')).toHaveCount(0)
    })
  })
}
