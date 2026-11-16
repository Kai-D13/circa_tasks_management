import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { SUPER_STATE } from './authState'
import { expectBlocked, trapWrites } from './fixtureGuard'

// UX-KACK-1 (PM 15/11 review đóng đợt §4) — bước xác nhận K khi nạp file CMS, fixture /ui-catalog/cms-v2/wizard (ĐÚNG CmsImportFlow +
// CmsKCheckPanel của route thật, dữ liệu giả 83 SP 9183xx). Mọi kiểm tra lại / ghi đi qua useFixtureActionBlocked (0 request); kết quả
// "Kiểm tra lại với xác nhận" được MÔ PHỎNG sau khi chặn (lỗi HTTP / mất kết nối / thành công dựng sẵn) để kiểm luồng giữ / bỏ nháp.
// Kiểm: AC1 khoá ghi khi còn ý định chưa gửi (tick, đổi nguồn, bỏ tick, lỗi kiểm tra lại); AC2 N / M / U + lý do + xác nhận ghi một
// phần + chương trình đang chạy là bổ sung; AC3 hướng dẫn xác nhận tay thay vì "sửa file"; AC4 cột xác nhận gần đầu, 360 / 390 thấy
// hành động + nguồn không cần kéo ngang, chạm ≥ 44, 1280 không tràn, sáng / tối; AC5 chọn nhiều chỉ dòng xác nhận được + nguồn chung
// phải tự nhập và tự xác nhận; AC6 preview mới bỏ nháp cũ.

const HAS_SUPER = fs.existsSync(SUPER_STATE)
const SHOTS = process.env.CMS_SHOTS_DIR
type Theme = 'light' | 'dark'
// d1024: khổ nhỏ nhất đã chuyển sang lưới 5 cột (lg) — cột xác nhận hẹp nhất khi có sidebar.
const DEVICES = { m360: { width: 360, height: 800 }, m390: { width: 390, height: 844 }, d1024: { width: 1024, height: 800 }, d1280: { width: 1280, height: 900 } } as const
type Dev = keyof typeof DEVICES
const id = (i: number) => `9183${String(i).padStart(2, '0')}`

async function openWizard(page: Page, fx: string, theme: Theme = 'light') {
  await page.goto(`/ui-catalog/cms-v2/wizard?fx=${fx}`)
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
  await page.locator('main [data-testid="ui-catalog-cms-wizard"]').waitFor({ state: 'visible', timeout: 20_000 })
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
  const small = await page.locator('main [data-ui-v2="page"] a:visible, main [data-ui-v2="page"] button:visible, main [data-cms-kcheck] label:visible').evaluateAll((els) => els.map((e) => {
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
const flow = (page: Page) => page.locator('main [data-cms-import-flow]')
const kRow = (page: Page, pid: string) => flow(page).locator(`[data-cms-k-row="${pid}"]`)
const commitBtn = (page: Page) => flow(page).locator('[data-cms-commit]')

test.describe('UX-KACK-1 — bố cục bảng kiểm K 83 SP (fixture, 0 ghi) @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  for (const theme of ['light', 'dark'] as Theme[]) for (const dev of Object.keys(DEVICES) as Dev[]) {
    test(`result-k83 ${dev} ${theme}: không tràn ngang; hành động + nguồn thấy trong khung; chạm ≥ 44 (mobile)`, async ({ page }) => {
      const writes = await trapWrites(page)
      await page.setViewportSize(DEVICES[dev])
      await openWizard(page, 'result-k83', theme)
      await noPageOverflow(page, `k83 ${dev} ${theme}`)
      const r = kRow(page, id(50))
      const box = page.locator('main [data-cms-kcheck]')
      for (const el of [r.getByRole('checkbox'), r.getByRole('textbox')]) {
        await el.scrollIntoViewIfNeeded()
        const b = (await el.boundingBox())!
        const vw = DEVICES[dev].width
        expect(b.x, `${dev}: hành động bị đẩy ra trái`).toBeGreaterThanOrEqual(0)
        expect(b.x + b.width, `${dev}: hành động / nguồn nằm ngoài khung (phải kéo ngang)`).toBeLessThanOrEqual(vw + 1)
      }
      // Bảng kiểm K không tự cuộn ngang ở bất kỳ khổ nào (thẻ trên mobile, lưới trên desktop)
      const sx = await box.evaluate((el) => [el, ...el.querySelectorAll('*')].filter((n) => {
        const ox = getComputedStyle(n).overflowX
        return (ox === 'auto' || ox === 'scroll') && (n as HTMLElement).scrollWidth > (n as HTMLElement).clientWidth + 1
      }).length)
      expect(sx, `${dev}: bảng kiểm K có vùng cuộn ngang`).toBe(0)
      if (dev === 'd1280' || dev === 'd1024') {
        const heads = await box.locator('[role="columnheader"]').allInnerTexts()
        expect(heads.map((h) => h.trim())).toEqual(['ProductID', 'Kết quả', 'Xác nhận tay', 'Đơn vị · K', 'Chi tiết'])
        // Ô nguồn ở cột xác nhận đủ rộng để nhập (không bị bóp còn vài ký tự)
        expect((await r.getByRole('textbox').boundingBox())!.width, `${dev}: ô nguồn quá hẹp`).toBeGreaterThanOrEqual(140)
      } else {
        await expect(box.locator('[role="columnheader"]').first()).toBeHidden()
        await touchTargets(page, `k83 ${dev} ${theme}`)
      }
      await shot(page, `kack-k83-${dev}-${theme}`)
      expect(writes).toEqual([])
    })
  }
})

test.describe('UX-KACK-1 — khoá ghi, tóm tắt, chọn nhiều (fixture, 0 ghi) @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('mở màn: không auto-tick; tóm tắt N 83 · M 50 · U 33 theo lý do; ghi một phần phải tick xác nhận số SP bị bỏ', async ({ page }) => {
    const writes = await trapWrites(page)
    await openWizard(page, 'result-k83')
    const f = flow(page)
    await expect(f.locator('[data-cms-k-row] input[type="checkbox"]:checked')).toHaveCount(0)
    await expect(f.locator('[data-cms-k-selected]')).toHaveAttribute('data-cms-k-selected', '0')
    await expect(f.locator('[data-cms-k-row] input[type="text"]')).toHaveCount(20)
    for (const v of await f.locator('[data-cms-k-row] input[type="text"]').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))) expect(v).toBe('')
    const s = f.locator('[data-cms-commit-summary]')
    await expect(s).toHaveAttribute('data-total', '83')
    await expect(s).toHaveAttribute('data-write', '50')
    await expect(s).toHaveAttribute('data-skip', '33')
    await expect(s.locator('[data-cms-commit-skip-reason="k-ack"]')).toContainText('18')
    await expect(s.locator('[data-cms-commit-skip-reason="k-ack"]')).toContainText('không cần sửa file')
    await expect(s.locator('[data-cms-commit-skip-reason="k-blocked"]')).toContainText('10')
    await expect(s.locator('[data-cms-commit-skip-reason="file"]')).toContainText('5')
    await expect(s.locator('[data-cms-commit-write]')).toContainText('THAY')
    await expect(commitBtn(page)).toHaveText('Nạp danh mục (thay toàn bộ, 50 sản phẩm)')
    await expect(commitBtn(page)).toBeDisabled()
    await expect(commitBtn(page)).toHaveAttribute('data-cms-commit-block', 'PARTIAL_UNCONFIRMED')
    await s.locator('[data-cms-partial-ack]').check()
    await expect(commitBtn(page)).toBeEnabled()
    await commitBtn(page).click()
    await expectBlocked(page, 1, 'Xác nhận ghi')
    // Dòng xác nhận được nhưng còn lỗi tư vấn được nói rõ
    await expect(kRow(page, id(81)).locator('[data-cms-k-other-errors]')).toBeVisible()
    expect(writes).toEqual([])
  })

  test('AC1: tick ⇒ khoá ghi + hướng dẫn; đổi nguồn vẫn khoá; bỏ tick ⇒ mở lại; thiếu nguồn ⇒ không cho kiểm tra lại', async ({ page }) => {
    const writes = await trapWrites(page)
    await openWizard(page, 'result-k83')
    const f = flow(page)
    await f.locator('[data-cms-partial-ack]').check()
    await expect(commitBtn(page)).toBeEnabled()
    const r = kRow(page, id(50))
    await r.getByRole('checkbox', { name: 'Tôi xác nhận K = 10 hộp' }).check()
    await expect(r).toHaveAttribute('data-cms-k-pending', 'incomplete')
    await expect(commitBtn(page)).toBeDisabled()
    await expect(commitBtn(page)).toHaveAttribute('data-cms-commit-block', 'DIRTY')
    await expect(f.locator('[data-cms-commit-locked]')).toContainText('Còn 1 xác nhận K đã tick nhưng chưa gửi')
    await expect(f.locator('[data-cms-k-recheck]')).toBeDisabled()
    await expect(f.locator('[data-cms-k-incomplete]')).toHaveAttribute('data-cms-k-incomplete', '1')
    await r.getByRole('textbox').fill('Quy cách NCC 16/11')
    await expect(r).toHaveAttribute('data-cms-k-pending', 'ready')
    await expect(f.locator('[data-cms-k-recheck]')).toBeEnabled()
    await expect(f.locator('[data-cms-k-recheck]')).toHaveText('Kiểm tra lại với xác nhận (1)')
    await expect(commitBtn(page)).toBeDisabled()
    await r.getByRole('textbox').fill('Quy cách NCC 16/11 (sửa)')
    await expect(commitBtn(page)).toHaveAttribute('data-cms-commit-block', 'DIRTY')
    // Một dòng đủ nguồn + một dòng thiếu ⇒ không gửi im lặng một phần
    await kRow(page, id(51)).getByRole('checkbox').check()
    await expect(f.locator('[data-cms-k-recheck]')).toBeDisabled()
    await kRow(page, id(51)).getByRole('checkbox').uncheck()
    await r.getByRole('checkbox').uncheck()
    await expect(r).not.toHaveAttribute('data-cms-k-pending', /.+/)
    await expect(f.locator('[data-cms-commit-locked]')).toHaveCount(0)
    await expect(commitBtn(page)).toBeEnabled()
    await expect(page.locator('main [data-kpi-fixture-blocked]')).toHaveAttribute('data-kpi-fixture-blocked', '0')
    expect(writes).toEqual([])
  })

  test('AC1: kiểm tra lại LỖI (HTTP) ⇒ báo lỗi, GIỮ nháp + nguồn, nút ghi vẫn khoá; không request', async ({ page }) => {
    const writes = await trapWrites(page)
    await openWizard(page, 'result-k83-fail')
    const f = flow(page)
    const r = kRow(page, id(52))
    await r.getByRole('checkbox').check()
    await r.getByRole('textbox').fill('Quy cách NCC 16/11')
    await f.locator('[data-cms-k-recheck]').click()
    await expectBlocked(page, 1, 'Kiểm tra lại với xác nhận')
    await expect(f.locator('[role="alert"]')).toContainText('Máy chủ không phản hồi đúng — thử lại')
    await expect(r.getByRole('checkbox')).toBeChecked()
    await expect(r.getByRole('textbox')).toHaveValue('Quy cách NCC 16/11')
    await expect(r).toHaveAttribute('data-cms-k-pending', 'ready')
    await expect(commitBtn(page)).toBeDisabled()
    await expect(commitBtn(page)).toHaveAttribute('data-cms-commit-block', 'DIRTY')
    await expect(f.locator('[data-cms-commit-summary]')).toHaveAttribute('data-write', '50') // preview cũ, tick không làm tăng M
    expect(writes).toEqual([])
  })

  test('AC1: kiểm tra lại QUÁ HẠN CHỜ ⇒ báo hết giờ, GIỮ nháp, nút ghi vẫn khoá', async ({ page }) => {
    const writes = await trapWrites(page)
    await openWizard(page, 'result-k83-timeout')
    const f = flow(page)
    const r = kRow(page, id(55))
    await r.getByRole('checkbox').check()
    await r.getByRole('textbox').fill('Quy cách NCC 16/11')
    await f.locator('[data-cms-k-recheck]').click()
    await expectBlocked(page, 1, 'Kiểm tra lại với xác nhận')
    await expect(f.locator('[role="alert"]')).toContainText('quá thời gian chờ — xác nhận đã tick vẫn giữ')
    await expect(r.getByRole('textbox')).toHaveValue('Quy cách NCC 16/11')
    await expect(commitBtn(page)).toHaveAttribute('data-cms-commit-block', 'DIRTY')
    expect(writes).toEqual([])
  })

  test('AC6: "Upload file khác" / "Hủy lần chạy" sau khi tick ⇒ bỏ kết quả + nháp, về bước tải file (không mang ý định sang file mới)', async ({ page }) => {
    const writes = await trapWrites(page)
    for (const btn of ['Upload file khác', 'Hủy lần chạy']) {
      await openWizard(page, 'result-k83')
      const f = flow(page)
      const r = kRow(page, id(56))
      await r.getByRole('checkbox').check()
      await r.getByRole('textbox').fill('Quy cách NCC 16/11')
      await expect(commitBtn(page)).toHaveAttribute('data-cms-commit-block', 'DIRTY')
      await f.getByRole('button', { name: btn, exact: true }).click()
      await expect(page.locator('main [data-cms-import-flow]')).toHaveAttribute('data-cms-import-flow', 'upload')
      await expect(f.locator('[data-cms-kcheck]')).toHaveCount(0)
      await expect(f.locator('[data-cms-commit]')).toHaveCount(0)
      // File đã bỏ ⇒ phải chọn lại file và chạy xử lý (preview mới) — nút chạy khoá khi chưa có file thật
      await expect(f.getByRole('button', { name: 'Chạy xử lý' })).toBeDisabled()
      // Đổi loại file ở bước tải cũng không làm hiện lại kết quả / nháp cũ
      await f.getByRole('radio', { name: /Nhiều bậc/ }).check()
      await f.getByRole('radio', { name: /Mức cố định/ }).check()
      await expect(f.locator('[data-cms-kcheck]')).toHaveCount(0)
      await expect(page.locator('main [data-kpi-fixture-blocked]')).toHaveAttribute('data-kpi-fixture-blocked', '0')
    }
    expect(writes).toEqual([])
  })

  test('AC2: chương trình đã bắt đầu ⇒ BỔ SUNG, giữ SP đang có; mất kết nối khi kiểm tra lại ⇒ giữ nháp', async ({ page }) => {
    const writes = await trapWrites(page)
    await openWizard(page, 'result-k83-append')
    const f = flow(page)
    await expect(f).toContainText('Chương trình đã bắt đầu: chỉ thêm sản phẩm mới')
    await expect(f.locator('[data-cms-commit-write]')).toContainText('BỔ SUNG')
    await expect(f.locator('[data-cms-commit-write]')).toContainText('giữ nguyên')
    await expect(commitBtn(page)).toHaveText('Thêm 50 sản phẩm')
    const r = kRow(page, id(53))
    await r.getByRole('checkbox').check()
    await r.getByRole('textbox').fill('Quy cách NCC 16/11')
    await f.locator('[data-cms-k-recheck]').click()
    await expectBlocked(page, 1, 'Kiểm tra lại với xác nhận')
    await expect(f.locator('[role="alert"]')).toContainText('Không kết nối được máy chủ — thử lại')
    await expect(r).toHaveAttribute('data-cms-k-pending', 'ready')
    await expect(commitBtn(page)).toHaveAttribute('data-cms-commit-block', 'DIRTY')
    expect(writes).toEqual([])
  })

  test('AC5 / AC6: lọc "Cần xác nhận"; chọn tất cả chỉ 20 dòng xác nhận được; nguồn chung phải nhập + tự xác nhận; kiểm tra lại thành công ⇒ preview mới, nháp bỏ, báo SP không áp', async ({ page }) => {
    const writes = await trapWrites(page)
    await openWizard(page, 'result-k83')
    const f = flow(page)
    await f.locator('[data-cms-k-view="ack"]').click()
    await expect(f.locator('[data-cms-k-row]')).toHaveCount(20)
    const statuses = await f.locator('[data-cms-k-row]').evaluateAll((rs) => [...new Set(rs.map((r) => r.getAttribute('data-cms-k-status')))])
    expect(statuses).toEqual(['NO_EVIDENCE'])
    await expect(f.locator('[data-cms-k-excluded]')).toHaveText('Không chọn được: 48 KHỚP · 2 đã xác nhận · 6 LỆCH · 4 NGUỒN LỖI · 3 ĐỀ XUẤT K')
    await f.locator('[data-cms-k-select-all]').click()
    await expect(f.locator('[data-cms-k-selected]')).toHaveAttribute('data-cms-k-selected', '20')
    await expect(commitBtn(page)).toHaveAttribute('data-cms-commit-block', 'DIRTY')
    await expect(f.locator('[data-cms-k-recheck]')).toBeDisabled() // 20 ý định chưa có nguồn
    const apply = f.locator('[data-cms-k-bulk-apply]')
    const confirm = f.locator('[data-cms-k-bulk-confirm]')
    await expect(apply).toBeDisabled()
    await expect(confirm).toBeDisabled()
    await f.locator('[data-cms-k-bulk-source]').fill('ab')
    await expect(confirm).toBeDisabled()
    await f.locator('[data-cms-k-bulk-source]').fill('Quy cách NCC (mẫu, nguồn chung)')
    await expect(apply).toBeDisabled()
    await confirm.check()
    await expect(apply).toHaveText('Áp nguồn cho 20 dòng đã chọn')
    await apply.click()
    await expect(confirm).not.toBeChecked()
    const vals = await f.locator('[data-cms-k-row] input[type="text"]').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))
    expect(vals).toEqual(Array(20).fill('Quy cách NCC (mẫu, nguồn chung)'))
    // Dòng LỆCH / NGUỒN LỖI không có ô xác nhận (xem ở "Tất cả")
    await f.locator('[data-cms-k-view="all"]').click()
    for (const i of [68, 74, 78]) await expect(kRow(page, id(i)).locator('input')).toHaveCount(0)
    await expect(f.locator('[data-cms-k-recheck]')).toHaveText('Kiểm tra lại với xác nhận (20)')
    await f.locator('[data-cms-k-recheck]').click()
    await expectBlocked(page, 1, 'Kiểm tra lại với xác nhận')
    // Preview mô phỏng sau khi server gắn: 17 / 18 ghi được, 918367 đổi sang LỆCH
    await expect(f.locator('[data-cms-k-not-applied]')).toHaveAttribute('data-cms-k-not-applied', '1')
    await expect(f.locator('[data-cms-k-not-applied]')).toContainText(id(67))
    await expect(commitBtn(page)).toHaveText('Nạp danh mục (thay toàn bộ, 67 sản phẩm)')
    await expect(f.locator('[data-cms-commit-summary]')).toHaveAttribute('data-skip', '16')
    await expect(f.locator('[data-cms-k-row][data-cms-k-pending]')).toHaveCount(0)
    await expect(f.locator('[data-cms-k-row]')).toHaveCount(83) // bảng dựng lại theo preview mới (không giữ bộ lọc / nguồn chung cũ)
    await expect(f.locator('[data-cms-k-bulk]')).toHaveCount(0) // không còn dòng xác nhận được
    await expect(f.locator('[data-cms-k-row] input[type="checkbox"]:checked')).toHaveCount(0)
    await expect(kRow(page, id(50)).locator('[data-cms-k-ack-info]')).toContainText('Quy cách NCC (mẫu, nguồn chung)')
    await expect(kRow(page, id(50))).toContainText('CHƯA CÓ BẰNG CHỨNG · ĐÃ XÁC NHẬN TAY')
    await expect(kRow(page, id(50))).not.toContainText('KHỚP')
    await expect(commitBtn(page)).toHaveAttribute('data-cms-commit-block', 'PARTIAL_UNCONFIRMED') // preview mới ⇒ xác nhận lại số SP bị bỏ
    await f.locator('[data-cms-partial-ack]').check()
    await expect(commitBtn(page)).toBeEnabled()
    expect(writes).toEqual([])
  })

  test('KACK-BULK-01: xác nhận nguồn chung mất khi thêm / đổi SP (cùng số lượng) / bỏ hết rồi chọn lại / đổi nguồn; Áp chỉ sau khi tick lại', async ({ page }) => {
    const writes = await trapWrites(page)
    await openWizard(page, 'result-k83')
    const f = flow(page)
    const apply = f.locator('[data-cms-k-bulk-apply]')
    const confirm = f.locator('[data-cms-k-bulk-confirm]')
    const pick = (i: number, on: boolean) => (on ? kRow(page, id(i)).getByRole('checkbox').check() : kRow(page, id(i)).getByRole('checkbox').uncheck())
    await f.locator('[data-cms-k-bulk-source]').fill('Quy cách NCC nhóm A')
    await pick(51, true)
    await confirm.check()
    await expect(apply).toBeEnabled()
    // Thêm SP sau khi xác nhận
    await pick(52, true)
    await expect(confirm).not.toBeChecked()
    await expect(apply).toBeDisabled()
    await confirm.check()
    await expect(apply).toHaveText('Áp nguồn cho 2 dòng đã chọn')
    await expect(apply).toBeEnabled()
    // Đổi sang SP khác, số lượng vẫn 2
    await pick(51, false)
    await pick(53, true)
    await expect(f.locator('[data-cms-k-selected]')).toHaveAttribute('data-cms-k-selected', '2')
    await expect(confirm).not.toBeChecked()
    await expect(apply).toBeDisabled()
    // Bỏ hết rồi chọn lại đúng tập vừa xác nhận ⇒ không phục hồi
    await confirm.check()
    await f.locator('[data-cms-k-select-none]').click()
    await pick(52, true)
    await pick(53, true)
    await expect(confirm).not.toBeChecked()
    await expect(apply).toBeDisabled()
    // Đổi nguồn rồi gõ lại nguồn cũ ⇒ vẫn phải tick lại
    await confirm.check()
    await f.locator('[data-cms-k-bulk-source]').fill('Quy cách NCC nhóm B')
    await f.locator('[data-cms-k-bulk-source]').fill('Quy cách NCC nhóm A')
    await expect(confirm).not.toBeChecked()
    await expect(apply).toBeDisabled()
    await confirm.check()
    await apply.click()
    await expect(confirm).not.toBeChecked()
    for (const i of [52, 53]) await expect(kRow(page, id(i)).getByRole('textbox')).toHaveValue('Quy cách NCC nhóm A')
    await expect(kRow(page, id(51)).getByRole('textbox')).toHaveValue('')
    expect(writes).toEqual([])
  })

  test('AC4 bàn phím: Tab tới ô xác nhận, Space tick; nhãn rõ cho checkbox + ô nguồn', async ({ page }) => {
    await trapWrites(page)
    await openWizard(page, 'result-k83')
    const r = kRow(page, id(54))
    const cb = r.getByRole('checkbox', { name: 'Tôi xác nhận K = 10 hộp' })
    await cb.focus()
    await page.keyboard.press('Space')
    await expect(cb).toBeChecked()
    await page.keyboard.press('Tab')
    await expect(r.getByRole('textbox', { name: `Nguồn căn cứ K của ${id(54)}` })).toBeFocused()
    await page.keyboard.type('Quy cách NCC')
    await expect(r).toHaveAttribute('data-cms-k-pending', 'ready')
  })

  test('AC3: 0 SP ghi được vì chỉ thiếu bằng chứng ⇒ hướng dẫn xác nhận tay / kiểm lại sau, không bảo sửa file; lỗi file thật vẫn bảo sửa file', async ({ page }) => {
    await trapWrites(page)
    await openWizard(page, 'result-simple-unavailable')
    let f = flow(page)
    await expect(f.locator('[data-cms-commit]')).toHaveCount(0)
    await expect(f.locator('[data-cms-commit-none]')).toHaveText('Không có sản phẩm hợp lệ để ghi.')
    await expect(f.locator('[data-cms-commit-none-kack]')).toContainText('2 sản phẩm chỉ thiếu bằng chứng K')
    await expect(f.locator('[data-cms-commit-none-kack]')).toContainText('Không cần sửa file')
    await expect(f.locator('[data-cms-k-recheck]')).toHaveText('Kiểm tra lại')
    await expect(f.locator('[data-cms-k-recheck]')).toBeEnabled() // nguồn bán chưa đọc được ⇒ cho thử lại
    await openWizard(page, 'result-simple-nok')
    f = flow(page)
    await expect(f.locator('[data-cms-commit-none]')).toContainText('sửa file theo danh sách lỗi')
    await expect(f.locator('[data-cms-commit-none-kack]')).toHaveCount(0)
  })
})
