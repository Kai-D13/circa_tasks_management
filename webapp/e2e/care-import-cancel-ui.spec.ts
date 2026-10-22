import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { SUPER_STATE } from './authState'
import { CARE_CANCEL_MESSAGES, CARE_CANCEL_WARNING } from '../lib/care/importCancel'

// CRM-CSKH D1 — UI huỷ file import trên /ui-catalog/care-import (UI_CATALOG=1 + super; DỮ LIỆU GIẢ, action giả trong trình
// duyệt — không server action, không DB). Kiểm: hộp thoại 2 bước (xem trước → xác nhận riêng), commitSeq dạng chuỗi giữ đủ
// chữ số (> 2^53), bấm đôi chỉ gọi huỷ 1 lần, lỗi hiện chữ an toàn, nút ≥ 44px và không cuộn ngang ở 360/390, sáng/tối.

const HAS_STATE = fs.existsSync(SUPER_STATE)
const SHOTS = path.resolve(__dirname, '..', 'qa-artifacts', 'care-d1-cancel-ui')
const noPageOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)

async function open(page: Page, mode = 'ok', theme: 'light' | 'dark' = 'light') {
  await page.goto(`/ui-catalog/care-import?cancel=${mode}`)
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
  const sec = page.getByTestId('catalog-care-import-cancel')
  await sec.waitFor({ timeout: 20_000 })
  return sec
}
async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

test.describe('care D1 — hộp thoại huỷ file (catalog, action giả) @desktop', () => {
  test.skip(!HAS_STATE, 'chưa có storageState super (E2E_SUPER_* + project setup)')
  test.use({ storageState: SUPER_STATE })

  test('2 bước: cảnh báo + số đếm → xác nhận riêng → kết quả; gửi đúng commitSeq chuỗi; bấm đôi chỉ 1 lần; 0 request ghi', async ({ page }) => {
    const writes: string[] = []
    page.on('request', (r) => { if (r.method() !== 'GET' && !r.url().includes('/cdn-cgi/')) writes.push(`${r.method()} ${new URL(r.url()).pathname}`) })
    const sec = await open(page)
    // Dòng đã huỷ: nhãn + ghi chú số đếm; nút chỉ ở dòng được chỉ định.
    await expect(sec.getByText('Đã huỷ', { exact: true })).toBeVisible()
    await expect(sec.getByText('Đã huỷ — xoá 40 task')).toBeVisible()
    await expect(sec.getByTestId('care-cancel-open')).toHaveCount(1)
    await sec.getByTestId('care-cancel-open').click()
    const dlg = page.getByTestId('care-cancel-dialog')
    await expect(dlg).toHaveAttribute('data-step', 'review')
    await expect(dlg.getByTestId('care-cancel-warning')).toHaveText(CARE_CANCEL_WARNING)
    const counts = dlg.getByTestId('care-cancel-counts')
    await expect(counts).toContainText('Task sẽ xoá4')
    await expect(counts).toContainText('Task sẽ hoàn nguyên6')
    await expect(dlg.getByTestId('care-cancel-submit')).toHaveCount(0)   // chưa có nút huỷ ở bước 1
    await dlg.getByRole('button', { name: 'Tiếp tục' }).click()
    await expect(dlg).toHaveAttribute('data-step', 'confirm')
    await expect(dlg.getByTestId('care-cancel-confirm-text')).toContainText('xoá 4 task, hoàn nguyên 6 task')
    const submit = dlg.getByTestId('care-cancel-submit')
    await submit.dblclick()
    await expect(dlg).toHaveAttribute('data-step', 'done', { timeout: 5_000 })
    await expect(dlg.getByTestId('care-cancel-counts')).toContainText('Task đã xoá4')
    const calls = await page.evaluate(() => (window as unknown as { __careCancelCalls?: unknown[] }).__careCancelCalls ?? [])
    expect(calls).toEqual([{ batchId: '00000000-0000-4000-8000-0000000000c1', expectedCommitSeq: '9007199254740993' }])
    expect(writes).toEqual([])
  })

  test('preview từ chối HAS_ACTIVITY ⇒ chữ an toàn, không có nút huỷ; huỷ trả NOT_LATEST ⇒ hiện lỗi, không báo thành công', async ({ page }) => {
    let sec = await open(page, 'has_activity')
    await sec.getByTestId('care-cancel-open').click()
    let dlg = page.getByTestId('care-cancel-dialog')
    await expect(dlg.getByTestId('care-cancel-error')).toHaveText(CARE_CANCEL_MESSAGES.HAS_ACTIVITY)
    await expect(dlg.getByRole('button', { name: 'Tiếp tục' })).toHaveCount(0)
    await expect(dlg.getByTestId('care-cancel-submit')).toHaveCount(0)
    sec = await open(page, 'not_latest')
    await sec.getByTestId('care-cancel-open').click()
    dlg = page.getByTestId('care-cancel-dialog')
    await dlg.getByRole('button', { name: 'Tiếp tục' }).click()
    await dlg.getByTestId('care-cancel-submit').click()
    await expect(dlg.getByTestId('care-cancel-error')).toHaveText(CARE_CANCEL_MESSAGES.NOT_LATEST)
    await expect(dlg).not.toHaveAttribute('data-step', 'done')
  })

  test('PM D1 r1 P1-2 — cờ OFF (vd. sau rollback DB còn batch đã huỷ): lịch sử vẫn hiện "Đã huỷ" + người/lúc huỷ, không cột Thao tác, không lỗi trang', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    const sec = await open(page, 'off')
    await expect(sec.getByText('Đã huỷ', { exact: true })).toBeVisible()
    await expect(sec.getByText(/Đã huỷ — xoá 40 task \(QA Marketing · /)).toBeVisible()
    await expect(sec.getByTestId('care-cancel-open')).toHaveCount(0)
    await expect(sec.getByRole('columnheader', { name: 'Thao tác' })).toHaveCount(0)
    expect(errors).toEqual([])
  })

  test('1280 sáng/tối: ảnh hộp thoại bước 1 và 2', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    for (const theme of ['light', 'dark'] as const) {
      const sec = await open(page, 'ok', theme)
      await sec.getByTestId('care-cancel-open').click()
      const dlg = page.getByTestId('care-cancel-dialog')
      await expect(dlg).toHaveAttribute('data-step', 'review')
      await shot(page, `1280-${theme}-review`)
      await dlg.getByRole('button', { name: 'Tiếp tục' }).click()
      await shot(page, `1280-${theme}-confirm`)
    }
  })
})

test.describe('care D1 — hộp thoại huỷ file trên mobile @mobile', () => {
  test.skip(!HAS_STATE, 'chưa có storageState super (E2E_SUPER_* + project setup)')
  test.use({ storageState: SUPER_STATE })

  test('360/390 sáng/tối: không cuộn ngang, nút ≥ 44px ở cả 2 bước; ảnh', async ({ page }) => {
    const w = page.viewportSize()!.width
    for (const theme of ['light', 'dark'] as const) {
      const sec = await open(page, 'ok', theme)
      const btn = sec.getByTestId('care-cancel-open')
      await btn.scrollIntoViewIfNeeded()
      expect((await btn.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      await btn.click()
      const dlg = page.getByTestId('care-cancel-dialog')
      await expect(dlg).toHaveAttribute('data-step', 'review')
      expect(await noPageOverflow(page)).toBe(true)
      for (const b of await dlg.getByRole('button').all()) {
        if (!(await b.isVisible())) continue
        const h = (await b.boundingBox())!.height
        const name = (await b.textContent())?.trim() ?? ''
        if (name) expect(h, name).toBeGreaterThanOrEqual(44)
      }
      await shot(page, `${w}-${theme}-review`)
      await dlg.getByRole('button', { name: 'Tiếp tục' }).click()
      expect((await dlg.getByTestId('care-cancel-submit').boundingBox())!.height).toBeGreaterThanOrEqual(44)
      expect(await noPageOverflow(page)).toBe(true)
      await shot(page, `${w}-${theme}-confirm`)
    }
  })
})
