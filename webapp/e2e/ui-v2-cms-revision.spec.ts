import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { SUPER_STATE } from './authState'
import { expectBlocked, trapWrites } from './fixtureGuard'

// F-A / F-B / F-C (PM spec 17/11 §2 / §4 / §5 · gate IMP03 + UI scoped) — fixture /ui-catalog/cms-v2/{revision, revisions, wizard} dùng
// ĐÚNG CmsRevisionFlow / CmsRevisionHistory / CmsImportFlow của route thật, dữ liệu giả. Mọi kiểm tra / ghi đi qua useFixtureActionBlocked
// (bộ đếm) và trapWrites (0 request không phải GET tới máy chủ).
// Kiểm: 360 / 390 / 1024 / 1280 × sáng / tối — trang và <main> không cuộn ngang, chạm ≥ 44 ở mobile; tick xác nhận / lý do không có sẵn,
// thứ tự khoá nút ghi; dự toán lỗi ⇒ không số, nút ghi khoá; file lỗi ⇒ tóm tắt 64 + 83 cùng hiện, không lập revision; chọn nhầm loại
// file ⇒ câu theo định dạng (không phải yêu cầu target), không tự đổi loại; ghi một phần không tick sẵn; lịch sử không có nút xoá / hoàn tác.

const HAS_SUPER = fs.existsSync(SUPER_STATE)
const SHOTS = process.env.CMS_SHOTS_DIR
type Theme = 'light' | 'dark'
const DEVICES = { m360: { width: 360, height: 800 }, m390: { width: 390, height: 844 }, d1024: { width: 1024, height: 800 }, d1280: { width: 1280, height: 900 } } as const
type Dev = keyof typeof DEVICES
const STATES = [
  { page: 'revision', fx: 'upload', root: 'ui-catalog-cms-revision' },
  { page: 'revision', fx: 'file-errors', root: 'ui-catalog-cms-revision' },
  { page: 'revision', fx: 'result', root: 'ui-catalog-cms-revision' },
  { page: 'revision', fx: 'result-many-removed', root: 'ui-catalog-cms-revision' },
  { page: 'revision', fx: 'result-impact-error', root: 'ui-catalog-cms-revision' },
  { page: 'revision', fx: 'done', root: 'ui-catalog-cms-revision' },
  { page: 'revisions', fx: 'list', root: 'ui-catalog-cms-revisions' },
  { page: 'revisions', fx: 'detail', root: 'ui-catalog-cms-revisions' },
  { page: 'wizard', fx: 'upload-wrong-format', root: 'ui-catalog-cms-wizard' },
  { page: 'wizard', fx: 'result-issues', root: 'ui-catalog-cms-wizard' },
  { page: 'wizard', fx: 'result-issues-partial', root: 'ui-catalog-cms-wizard' },
  // r3 (P1-03): cuối mảng để giữ nguyên chỉ số các ca cũ.
  { page: 'revision', fx: 'result-prior', root: 'ui-catalog-cms-revision' },
] as const

async function open(page: Page, s: { page: string; fx: string; root: string }, theme: Theme = 'light') {
  await page.goto(`/ui-catalog/cms-v2/${s.page}?fx=${s.fx}`)
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
  await page.locator(`main [data-testid="${s.root}"]`).waitFor({ state: 'visible', timeout: 30_000 })
}
async function noPageOverflow(page: Page, where: string) {
  const g = await page.evaluate(() => {
    const m = document.querySelector('main')!
    return { sw: document.documentElement.scrollWidth, iw: window.innerWidth, msw: m.scrollWidth, mcw: m.clientWidth }
  })
  expect(g.sw, `${where}: trang cuộn ngang`).toBeLessThanOrEqual(g.iw + 1)
  expect(g.msw, `${where}: <main> cuộn ngang`).toBeLessThanOrEqual(g.mcw + 1)
}
async function touchTargets(page: Page, where: string) {
  const small = await page.locator('main [data-ui-v2="page"] a:visible, main [data-ui-v2="page"] button:visible, main [data-ui-v2="page"] label:has(input):visible')
    .evaluateAll((els) => els.map((e) => {
      const r = e.getBoundingClientRect()
      return { t: (e.textContent ?? '').trim().slice(0, 40), h: Math.round(r.height), w: Math.round(r.width) }
    }).filter((x) => x.h > 0 && x.w > 0 && Math.min(x.h, x.w) < 44))
  expect(small, `${where}: chạm < 44px`).toEqual([])
}
async function shot(page: Page, name: string) {
  if (!SHOTS) return
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true })
}
const flow = (page: Page) => page.locator('main [data-cms-revision-flow]')
const commitBtn = (page: Page) => flow(page).locator('[data-cms-revision-commit]')

test.describe('F-A / F-B / F-C — bố cục 4 khổ × sáng / tối (fixture, 0 ghi) @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })
  for (const s of STATES) for (const theme of ['light', 'dark'] as Theme[]) for (const dev of Object.keys(DEVICES) as Dev[]) {
    test(`${s.page}:${s.fx} ${dev} ${theme}: không tràn ngang; chạm ≥ 44 (mobile)`, async ({ page }) => {
      const writes = await trapWrites(page)
      await page.setViewportSize(DEVICES[dev])
      await open(page, s, theme)
      await noPageOverflow(page, `${s.fx} ${dev} ${theme}`)
      if (dev === 'm360' || dev === 'm390') await touchTargets(page, `${s.fx} ${dev} ${theme}`)
      await shot(page, `rev-${s.page}-${s.fx}-${dev}-${theme}`)
      expect(writes).toEqual([])
    })
  }
})

test.describe('F-A — luồng sửa: xác nhận, khoá ghi, dự toán (fixture, 0 ghi) @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('result: lý do / tick KHÔNG có sẵn; khoá theo thứ tự REASON → ACK → REMOVED; đủ ⇒ mở, bấm ghi bị fixture chặn (0 request)', async ({ page }) => {
    const writes = await trapWrites(page)
    await open(page, STATES[2])
    const f = flow(page)
    await expect(f).toHaveAttribute('data-cms-revision-flow', 'result')
    await expect(f.locator('input[data-cms-ack]')).toHaveCount(3)
    await expect(f.locator('input[data-cms-ack]:checked')).toHaveCount(0)
    await expect(f.locator('#cms-rev-reason')).toHaveValue('')
    await expect(commitBtn(page)).toBeDisabled()
    await expect(commitBtn(page)).toHaveAttribute('data-cms-revision-commit', 'REASON')
    // Diff: 2 bỏ · 3 đổi · 1 thêm lại · 2 thêm; SP giữ nguyên ẩn sau nút.
    const d = page.locator('main [data-cms-revision-diff]')
    await expect(d.locator('[data-cms-rev-item="remove"]')).toHaveCount(2)
    await expect(d.locator('[data-cms-rev-item="change"]')).toHaveCount(3)
    await expect(d.locator('[data-cms-rev-item="readd"]')).toHaveCount(1)
    await expect(d.locator('[data-cms-rev-item="add"]')).toHaveCount(2)
    await expect(d.locator('[data-cms-rev-item="keep"]')).toHaveCount(0)
    // Dự toán: trước / sau / chênh + số đang công bố tách riêng.
    const im = page.locator('main [data-cms-rev-impact="ok"]')
    await expect(im.locator('[data-cms-rev-before]')).toBeVisible()
    await expect(im.locator('[data-cms-rev-after]')).toBeVisible()
    await expect(im.locator('[data-cms-rev-delta]')).toBeVisible()
    await expect(im.locator('[data-cms-rev-published="current"]')).toContainText('Đang công bố')
    await f.locator('#cms-rev-reason').fill('Ngắn')
    await expect(commitBtn(page)).toHaveAttribute('data-cms-revision-commit', 'REASON')
    await f.locator('#cms-rev-reason').fill('Cập nhật K theo quy cách mới của NCC')
    await expect(commitBtn(page)).toHaveAttribute('data-cms-revision-commit', 'ACK')
    await f.locator('input[data-cms-ack="whole_period"]').check()
    await expect(commitBtn(page)).toHaveAttribute('data-cms-revision-commit', 'ACK')
    await f.locator('input[data-cms-ack="may_decrease"]').check()
    await expect(commitBtn(page)).toHaveAttribute('data-cms-revision-commit', 'REMOVED')
    await f.locator('input[data-cms-ack="removed"]').check()
    await expect(commitBtn(page)).toHaveAttribute('data-cms-revision-commit', 'NONE')
    await expect(commitBtn(page)).toBeEnabled()
    await commitBtn(page).click()
    await expectBlocked(page, 1, 'Ghi sửa đổi')
    await expect(f).toHaveAttribute('data-cms-revision-flow', 'result')
    // Chọn file khác ⇒ bỏ lý do / tick (preview mới phải xác nhận lại).
    await f.getByRole('button', { name: 'Chọn file khác' }).click()
    await expect(f).toHaveAttribute('data-cms-revision-flow', 'upload')
    expect(writes).toEqual([])
  })

  test('r3 P1-03 result-prior: đã sửa, chưa có run mới ⇒ "bản công bố trước thay đổi cấu hình v6" có mốc, KHÔNG gọi "đang công bố"', async ({ page }) => {
    const writes = await trapWrites(page)
    await open(page, STATES.find((s) => s.fx === 'result-prior')!)
    const im = page.locator('main [data-cms-rev-impact="ok"]')
    const pub = im.locator('[data-cms-rev-published="prior"]')
    await expect(pub).toContainText('Bản công bố trước thay đổi cấu hình v6')
    await expect(pub).toContainText('mốc')
    await expect(pub).toContainText('đang bị che')
    await expect(im.locator('[data-cms-rev-published="current"]')).toHaveCount(0)
    await expect(im).not.toContainText('Đang công bố')
    await expect(im.locator('th', { hasText: 'Bản công bố trước v6' })).toBeVisible()
    // Ngữ cảnh trang: run bị che sau sửa ⇒ câu config_reset hiện có, không mốc run cũ.
    await expect(page.locator('main [data-cms-revision-context]')).toContainText('Chưa có số liệu sau thay đổi cấu hình')
    expect(writes).toEqual([])
  })

  test('r3 P1-02 chi tiết: cờ ghi TẮT + đã sửa ⇒ có Lịch sử sửa + thông báo che số, KHÔNG nút Sửa; cờ ghi bật ⇒ nút Sửa; lỗi trạng thái ⇒ vẫn có Lịch sử', async ({ page }) => {
    const writes = await trapWrites(page)
    const det = (rev: string) => open(page, { page: 'detail', fx: 'running', root: 'ui-catalog-cms-detail' }).then(() => page.goto(`/ui-catalog/cms-v2/detail?fx=running&rev=${rev}`))
      .then(() => page.locator('main [data-testid="ui-catalog-cms-detail"]').waitFor({ state: 'visible', timeout: 30_000 }))
    await det('write-off')
    await expect(page.locator('main [data-cms-revisions-link]')).toBeVisible()
    await expect(page.locator('main [data-cms-revisions-link]')).toHaveAttribute('href', /\/revisions$/)
    await expect(page.locator('main [data-cms-revision-link]')).toHaveCount(0)
    await expect(page.locator('main [data-cms-revision-masked]')).toBeVisible()
    await det('write-on')
    await expect(page.locator('main [data-cms-revision-link]')).toBeVisible()
    await expect(page.locator('main [data-cms-revisions-link]')).toHaveCount(0)
    await det('state-error')
    await expect(page.locator('main [data-cms-revisions-link]')).toBeVisible()
    await expect(page.locator('main [data-cms-revision-link]')).toHaveCount(0)
    // Không rev (DB 130 / cổng đọc đóng) ⇒ không link nào.
    await page.goto('/ui-catalog/cms-v2/detail?fx=running')
    await page.locator('main [data-testid="ui-catalog-cms-detail"]').waitFor({ state: 'visible', timeout: 30_000 })
    await expect(page.locator('main [data-cms-revisions-link], main [data-cms-revision-link]')).toHaveCount(0)
    expect(writes).toEqual([])
  })

  test('result-impact-error: không số dự toán (không 0 giả); đủ lý do + tick vẫn khoá IMPACT', async ({ page }) => {
    const writes = await trapWrites(page)
    await open(page, STATES[4])
    const f = flow(page)
    await expect(page.locator('main [data-cms-rev-impact="error"]')).toHaveAttribute('data-code', 'SOURCE_TIMEOUT')
    await expect(page.locator('main [data-cms-rev-impact="ok"]')).toHaveCount(0)
    await expect(page.locator('main [data-cms-rev-before]')).toHaveCount(0)
    await f.locator('#cms-rev-reason').fill('Cập nhật K theo quy cách mới của NCC')
    for (const a of ['whole_period', 'may_decrease', 'removed']) await f.locator(`input[data-cms-ack="${a}"]`).check()
    await expect(commitBtn(page)).toBeDisabled()
    await expect(commitBtn(page)).toHaveAttribute('data-cms-revision-commit', 'IMPACT')
    expect(writes).toEqual([])
  })

  test('file-errors: tóm tắt 64 ô K công thức + 83 dòng thiếu target CÙNG hiện; không lập revision, không nút ghi', async ({ page }) => {
    const writes = await trapWrites(page)
    await open(page, STATES[1])
    const sum = page.locator('main [data-cms-revision-file-errors] [data-cms-issue-summary]')
    await expect(sum.locator('[data-cms-issue-code="CELL_FORMULA"] [data-cms-issue-counts]')).toContainText('64 lần gặp · 64 dòng Excel · 64 sản phẩm')
    await expect(sum.locator('[data-cms-issue-code="GATE_MISSING_TARGET"] [data-cms-issue-counts]')).toContainText('83 lần gặp · 83 dòng Excel · 83 sản phẩm')
    await expect(sum.locator('[data-cms-issue-code="GATE_MISSING_TARGET"]')).toContainText('để trống cả hai cột')
    await expect(page.locator('main [data-cms-revision-diff]')).toHaveCount(0)
    await expect(commitBtn(page)).toHaveCount(0)
    expect(writes).toEqual([])
  })

  test('result-many-removed: tick bỏ 15 SP nêu đủ mã (xuống dòng, không tràn ở 360)', async ({ page }) => {
    const writes = await trapWrites(page)
    await page.setViewportSize(DEVICES.m360)
    await open(page, STATES[3])
    const lab = flow(page).locator('label:has(input[data-cms-ack="removed"])')
    await expect(lab).toContainText('bỏ 15 sản phẩm')
    await expect(lab).toContainText('918910')
    await expect(lab).toContainText('918924')
    const b = (await lab.boundingBox())!
    expect(b.x + b.width).toBeLessThanOrEqual(DEVICES.m360.width + 1)
    expect(writes).toEqual([])
  })

  test('done: báo v6 → v7, có đường sang lịch sử / chương trình; không còn nút ghi', async ({ page }) => {
    const writes = await trapWrites(page)
    await open(page, STATES[5])
    const ok = page.locator('main [data-cms-revision-done]')
    await expect(ok).toContainText('v6 → v7')
    await expect(ok).toContainText('868')
    await expect(ok.getByRole('link', { name: 'Lịch sử sửa' })).toBeVisible()
    await expect(commitBtn(page)).toHaveCount(0)
    expect(writes).toEqual([])
  })

  test('lịch sử: danh sách 3 lần sửa, chi tiết có số trước sửa với căn cứ cấu hình; KHÔNG có nút xoá / hoàn tác', async ({ page }) => {
    const writes = await trapWrites(page)
    await open(page, STATES[7])
    const root = page.locator('main [data-cms-revisions]')
    await expect(root.locator('[data-cms-revision-list] tbody tr')).toHaveCount(3)
    await expect(root.locator('[data-cms-revision-archive] tbody tr')).toHaveCount(24)
    await expect(root.locator('[data-cms-revision-archive]')).toContainText('Không còn cấu hình của run')
    await expect(root.getByRole('button', { name: /xoá|xóa|hoàn tác|khôi phục/i })).toHaveCount(0)
    await expect(root.getByRole('link', { name: /xoá|xóa|hoàn tác|khôi phục/i })).toHaveCount(0)
    expect(writes).toEqual([])
  })
})

test.describe('F-B / F-C — loại file và tóm tắt lỗi khi nạp danh mục (fixture, 0 ghi) @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('upload-wrong-format: câu nói rõ ĐỊNH DẠNG ≠ yêu cầu target; loại đã chọn KHÔNG bị tự đổi', async ({ page }) => {
    const writes = await trapWrites(page)
    await open(page, STATES[8])
    const f = page.locator('main [data-cms-import-flow]')
    const alert = f.getByRole('alert')
    await expect(alert).toContainText('File thuộc mẫu "Nhiều bậc / có target"')
    await expect(alert).toContainText('không phải yêu cầu chương trình có target')
    await expect(f.locator('input[name="cms-import-format"][value="simple"]')).toBeChecked()
    await expect(f.locator('input[name="cms-import-format"][value="tiers"]')).not.toBeChecked()
    expect(writes).toEqual([])
  })

  test('result-issues: 64 ô K công thức VÀ 83 dòng loại GMV thiếu target cùng hiện (đếm ô / dòng / SP riêng)', async ({ page }) => {
    const writes = await trapWrites(page)
    await open(page, STATES[9])
    const sum = page.locator('main [data-cms-issue-summary]')
    await expect(sum.locator('[data-cms-issue-code]')).toHaveCount(2)
    await expect(sum.locator('[data-cms-issue-code="CELL_FORMULA"] [data-cms-issue-counts]')).toContainText('64 lần gặp · 64 dòng Excel · 64 sản phẩm')
    await expect(sum.locator('[data-cms-issue-code="GATE_MISSING_TARGET"] [data-cms-issue-counts]')).toContainText('83 lần gặp · 83 dòng Excel · 83 sản phẩm')
    expect(writes).toEqual([])
  })

  test('result-issues-partial: xác nhận ghi một phần KHÔNG tick sẵn; nút ghi khoá tới khi tick', async ({ page }) => {
    const writes = await trapWrites(page)
    await open(page, STATES[10])
    const f = page.locator('main [data-cms-import-flow]')
    await expect(page.locator('main [data-cms-issue-summary] [data-cms-issue-code]')).not.toHaveCount(0)
    await expect(f.locator('[data-cms-partial-ack]')).not.toBeChecked()
    await expect(f.locator('[data-cms-commit]')).toHaveAttribute('data-cms-commit-block', 'PARTIAL_UNCONFIRMED')
    await f.locator('[data-cms-partial-ack]').check()
    await expect(f.locator('[data-cms-commit]')).toBeEnabled()
    await f.locator('[data-cms-commit]').click()
    await expectBlocked(page, 1, 'Xác nhận ghi')
    expect(writes).toEqual([])
  })
})
