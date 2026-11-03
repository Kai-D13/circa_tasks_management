import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { SUPER_STATE } from './authState'
import { expectBlocked, expectGuardedCalls, trapWrites } from './fixtureGuard'
import { cmsVnd } from '../lib/cms/display'
import { CMS_FX_RUN } from '../lib/cms/fixturesResults'
import { cmsFxLockPreview, cmsFxPayout } from '../lib/cms/fixturesPayout'
import { cmsLockCodeLabel } from '../lib/cms/payoutView'

// CMS P3a (luồng D) — khối "Chốt kỳ" / "Số đã chốt" trên A3 qua fixture /ui-catalog/cms-v2/detail?p3= (ĐÚNG CmsProgramDetailView
// của route thật; DTO giả dựng qua parser thật). Kiểm: tổng = Σ kết quả cùng run, giả định QA có nhãn, blocker có câu dễ hiểu,
// lý do Q-213 khoá nút xác nhận tới khi hợp lệ, xác nhận / kiểm tra lại ở fixture bị CHẶN (0 request ghi), số đã chốt theo vai
// (super: tổng toàn chương trình; SM: trong phạm vi, không email), link xuất ghim run; 360 / 390 / 1280 × sáng / tối không cuộn
// ngang, chạm ≥ 44 trên mobile.

const HAS_SUPER = fs.existsSync(SUPER_STATE)
const SHOTS = process.env.CMS_SHOTS_DIR
type Theme = 'light' | 'dark'
const DEVICES = { m360: { width: 360, height: 800 }, m390: { width: 390, height: 844 }, d1280: { width: 1280, height: 900 } } as const
type Dev = keyof typeof DEVICES
const PID = '00000000-0000-4000-8000-000000000001'
const END = '2026-11-14'

async function open(page: Page, qs: string, theme: Theme = 'light') {
  await page.goto(`/ui-catalog/cms-v2/detail?${qs}`)
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
  await page.locator('main [data-testid="ui-catalog-cms-detail"]').waitFor({ state: 'visible', timeout: 20_000 })
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
const P3A_TARGETS = 'main [data-cms-lock-open], main [data-cms-lock-recheck], main [data-cms-payout-export], main [data-cms-payout-rows] > summary'
// (checkbox hộp chốt nằm trong <label> min-h 44 — kiểm ở ui-v2-cms-p3a-staff.spec)
async function touchTargets(page: Page, where: string, sel = P3A_TARGETS) {
  const small = await page.locator(sel).evaluateAll((els) => els.map((e) => {
    const r = e.getBoundingClientRect()
    return { t: (e.textContent ?? '').trim().slice(0, 40), h: Math.round(r.height), w: Math.round(r.width) }
  }).filter((x) => x.h > 0 && x.w > 0 && x.h < 44))
  expect(small, `${where}: chạm < 44px`).toEqual([])
}
async function shot(page: Page, name: string) {
  if (!SHOTS) return
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true })
}

test.describe('ui v2 CMS P3a — bố cục Chốt kỳ / Số đã chốt @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })
  const MATRIX = ['ready', 'ack', 'blocked', 'pending', 'error', 'qa-readonly', 'locked', 'locked-sm', 'locked-error']
  for (const p3 of MATRIX) for (const theme of ['light', 'dark'] as Theme[]) for (const dev of Object.keys(DEVICES) as Dev[]) {
    test(`p3=${p3} ${dev} ${theme}`, async ({ page }) => {
      const writes = await trapWrites(page)
      await page.setViewportSize(DEVICES[dev])
      await open(page, `p3=${p3}`, theme)
      await expect(page.locator(`main [data-p3="${p3}"]`)).toBeVisible()
      await noPageOverflow(page, `p3=${p3} ${dev} ${theme}`)
      if (dev !== 'd1280') await touchTargets(page, `p3=${p3} ${dev}`)
      await shot(page, `p3a-detail-${p3}-${dev}-${theme}`)
      expect(writes).toEqual([])
    })
  }
})

test.describe('ui v2 CMS P3a — hành vi khối Chốt kỳ / Số đã chốt @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('nguồn: mọi lời gọi action chốt / preview trong CmsLockPanel đứng sau fixtureBlocked()', () => {
    // r2: action chỉ được dựng trong reload() và confirm() SAU fixtureBlocked() (lời gọi RECHECK nằm trong lib/cms/lockFlow) ⇒ 2 chỗ.
    expect(expectGuardedCalls('components/cms/admin/CmsLockPanel.tsx', ['lockCmsProgram', 'previewCmsLock'])).toBe(2)
  })

  test('sẵn sàng: tổng = Σ kết quả cùng run, giả định QA có nhãn, hộp xác nhận "không thể mở lại"; xác nhận / kiểm tra lại bị chặn, 0 request ghi', async ({ page }) => {
    const writes = await trapWrites(page)
    const pv = cmsFxLockPreview('ready', PID, END)!
    await open(page, 'p3=ready')
    const panel = page.locator('main [data-cms-lock-panel]')
    await expect(panel).toHaveAttribute('data-cms-lock-panel', 'ready')
    await expect(panel.locator('[data-cms-lock-amount]')).toHaveText(cmsVnd(pv.amountVnd))
    await expect(panel.locator('[data-cms-lock-summary]')).toContainText('Giả định QA — không phải quy tắc chi trả thật')
    await expect(panel.locator('[data-cms-lock-summary]')).toContainText(`${pv.staffPaid} / ${pv.staffRows}`)
    await expect(panel).toContainText('Không thể mở lại')
    await expect(panel.locator('[data-cms-lock-blockers]')).toHaveCount(0)
    await page.locator('main [data-cms-lock-open]').click()
    const dlg = page.getByRole('dialog')
    await expect(dlg).toContainText('Chốt kỳ chương trình?')
    await expect(dlg.locator('[data-cms-lock-ack]')).toHaveCount(0)
    await expect(dlg.locator('[data-cms-lock-confirm]')).toBeDisabled() // r2: phải tick "Tôi đã kiểm tra số liệu"
    await dlg.getByLabel('Tôi đã kiểm tra số liệu').check()
    await expect(dlg.locator('[data-cms-lock-confirm]')).toBeEnabled()
    await dlg.locator('[data-cms-lock-confirm]').click()
    await expectBlocked(page, 1, 'xác nhận chốt')
    await page.locator('main [data-cms-lock-recheck]').click()
    await expectBlocked(page, 2, 'kiểm tra lại')
    await expect(page.locator('main [data-cms-lock-panel]')).toHaveAttribute('data-cms-lock-panel', 'ready')
    expect(writes).toEqual([])
  })

  test('còn dòng chưa gán dưới ngưỡng: lý do bắt buộc 10–1.000 ký tự sau khi bỏ khoảng trắng', async ({ page }) => {
    const writes = await trapWrites(page)
    await open(page, 'p3=ack')
    await page.locator('main [data-cms-lock-open]').click()
    const dlg = page.getByRole('dialog')
    const ack = dlg.locator('[data-cms-lock-ack]')
    await expect(dlg).toContainText('Lý do xác nhận 7 dòng chưa gán')
    await expect(dlg.locator('[data-cms-lock-confirm]')).toBeDisabled()
    await ack.fill('   ngắn    ')
    await expect(dlg.locator('[data-cms-lock-confirm]')).toBeDisabled()
    await ack.fill('Đã đối soát với vận hành')
    await expect(dlg.locator('[data-cms-lock-confirm]')).toBeDisabled() // r2: lý do hợp lệ CHƯA đủ — cần checkbox
    await dlg.getByLabel('Tôi đã kiểm tra số liệu').check()
    await expect(dlg.locator('[data-cms-lock-confirm]')).toBeEnabled()
    await dlg.getByRole('button', { name: 'Để sau' }).click()
    await expect(dlg).toHaveCount(0)
    expect(writes).toEqual([])
  })

  test('bị chặn: nút Chốt kỳ… khoá, mỗi blocker một câu dễ hiểu; chương trình thật: quy tắc chốt chưa chốt (không nhãn QA)', async ({ page }) => {
    await open(page, 'p3=blocked')
    await expect(page.locator('main [data-cms-lock-panel]')).toHaveAttribute('data-cms-lock-panel', 'blocked')
    await expect(page.locator('main [data-cms-lock-open]')).toBeDisabled()
    await expect(page.locator('main [data-cms-lock-blocker]')).toHaveText([cmsLockCodeLabel('CMS_LOCK_RUN_CHANGED'), cmsLockCodeLabel('CMS_LOCK_UNASSIGNED_OVER')])
    await open(page, 'p3=pending')
    await expect(page.locator('main [data-cms-lock-open]')).toBeDisabled()
    await expect(page.locator('main [data-cms-lock-blocker]')).toHaveText([cmsLockCodeLabel('CMS_LOCK_POLICY_PENDING')])
    await expect(page.locator('main [data-cms-lock-summary]')).not.toContainText('Giả định QA')
    await expect(page.locator('main [data-cms-lock-summary]')).toContainText('Phiên bản 1')
    await open(page, 'p3=error')
    await expect(page.locator('main [role="alert"]')).toContainText('Chưa tải được điều kiện chốt kỳ')
    await expect(page.locator('main [data-cms-lock-open]')).toHaveCount(0)
  })

  test('số đã chốt (super): tổng toàn chương trình = Σ dòng, nhãn QA không chi trả, lý do lúc chốt, danh sách đủ dòng, link xuất ghim run; không còn khối Chốt kỳ', async ({ page }) => {
    const writes = await trapWrites(page)
    const po = cmsFxPayout('locked', PID)!
    await open(page, 'p3=locked')
    const main = page.locator('main [data-cms-payout]')
    await expect(main.locator('[data-cms-payout-total]')).toHaveText(cmsVnd(po.scopeTotal))
    await expect(main).toContainText('Tổng toàn chương trình')
    await expect(main).toContainText('QA — không chi trả')
    await expect(main).toContainText(po.super!.ackReason!)
    await expect(page.locator('main [data-cms-payout-export]')).toHaveAttribute('href', `/api/export/cms/payout?program=${PID}&run=${CMS_FX_RUN}`)
    await main.locator('[data-cms-payout-rows] > summary').click()
    await expect(main.locator('[data-cms-payout-row]')).toHaveCount(po.rows.length)
    await expect(page.locator('main [data-cms-lock-panel]')).toHaveCount(0)
    expect(writes).toEqual([])
  })

  test('số đã chốt (SM): tổng trong phạm vi, ít dòng hơn super, không email / không tổng toàn chương trình', async ({ page }) => {
    const sm = cmsFxPayout('locked-sm', PID)!
    const sup = cmsFxPayout('locked', PID)!
    await open(page, 'p3=locked-sm')
    const main = page.locator('main [data-cms-payout]')
    await expect(main.locator('[data-cms-payout-total]')).toHaveText(cmsVnd(sm.scopeTotal))
    await expect(main).toContainText('Tổng trong phạm vi của bạn')
    await expect(main).not.toContainText('Tổng toàn chương trình')
    await main.locator('[data-cms-payout-rows] > summary').click()
    await expect(main.locator('[data-cms-payout-row]')).toHaveCount(sm.rows.length)
    expect(sm.rows.length).toBeLessThan(sup.rows.length)
    expect(await page.locator('main').innerText()).not.toMatch(/@example\.invalid/)
    await open(page, 'p3=locked-error')
    await expect(page.locator('main [role="alert"]')).toContainText('Chưa tải được số đã chốt')
  })
})
