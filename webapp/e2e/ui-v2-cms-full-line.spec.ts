import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { SUPER_STATE } from './authState'
import { expectBlocked, trapWrites } from './fixtureGuard'
import { CMS_FX_PG } from '../lib/cms/fixtureScenario'
import { CMS_FX_CONTRACT_REPORT_ID, CMS_FX_PG_FULL_LINE, cmsFxContract, cmsFxContractCloseReport } from '../lib/cms/fixturesContract'
import { cmsFxStaffResults } from '../lib/cms/fixturesResults'
import type { CmsResultsLoad } from '../lib/cms/resultUi'
import { cmsVnd } from '../lib/cms/display'

// 132 r1 (Q-236 / Q-237 — PM 18/11 audit r0 P1-03) — browser scoped trên fixture /ui-catalog/cms-v2 với chương trình full_line
// (lib/cms/fixturesContract PG17 đang chạy · PG18 đã chốt run contract; số do computeCmsNet tính qua parser thật). Kiểm:
//   · 360 / 1280 sáng / tối: không cuộn ngang trang, chạm ≥ 44 trên mobile, 0 request ghi (trapWrites);
//   · super: kết quả / lịch sử / sổ trả (baseline fp v2 không lượng) / báo cáo sau chốt run contract (số RÒNG, cột "Đã trừ lúc chốt",
//     người lập + lý do) / số đã chốt (khối hợp đồng + phiếu đã trừ + câu số RÒNG);
//   · dược sĩ: sản phẩm / lịch sử full_line (câu phạm vi "trừ đủ lượng của dòng");
//   · lập tay ngày 31: quy tắc đã ghim chỉ hiển thị; chưa ghim ⇒ radio bắt buộc + lý do 10–500; DB thiếu đường ⇒ khoá; gửi ⇒ guard chặn.

const HAS_SUPER = fs.existsSync(SUPER_STATE)
const SHOTS = process.env.CMS_SHOTS_DIR
type Theme = 'light' | 'dark'
type Screen = 'staff' | 'product' | 'history' | 'detail' | 'returns'
const DEVICES = { m360: { width: 360, height: 800 }, d1280: { width: 1280, height: 900 } } as const
type Dev = keyof typeof DEVICES
const PG17 = CMS_FX_PG_FULL_LINE.PG17
const PG18 = CMS_FX_PG_FULL_LINE.PG18
const PG9 = CMS_FX_PG.PG9
const pp = (id: string, i: number) => cmsFxContract(id)!.fx.products[i].id
const FULL = 'full_line_qty_refund_v1'

async function open(page: Page, screen: Screen, qs: string, theme: Theme = 'light') {
  await page.goto(`/ui-catalog/cms-v2/${screen}?${qs}`)
  await page.evaluate((t) => localStorage.setItem('theme', t), theme)
  await page.reload()
  await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
  await page.locator(`main [data-testid="ui-catalog-cms-${screen}"]`).waitFor({ state: 'visible', timeout: 20_000 })
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
async function touchTargets(page: Page, where: string) {
  const small = await page.locator('main [data-ui-v2="page"] a:visible, main [data-ui-v2="page"] button:visible').evaluateAll((els) => els.map((e) => {
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
const sum = (l: CmsResultsLoad, ppId?: string) => {
  if (l.kind !== 'loaded') throw new Error('fx')
  return l.rows.results.filter((r) => !ppId || r.programProductId === ppId).reduce((a, r) => a + BigInt(r.amountVnd), BigInt(0))
}

test.describe('ui v2 CMS full_line (132 r1) — bố cục 360 / 1280 sáng / tối, 0 ghi @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })
  const MATRIX: [Screen, string][] = [
    ['staff', `fx=full&program=${PG17}`], ['product', `pp=${pp(PG17, 0)}`], ['history', `fx=full&program=${PG17}`],
    ['detail', `program=${PG17}`], ['detail', `program=${PG18}`],
    ['returns', `program=${PG17}&rs=proof`], ['returns', `program=${PG18}`], ['returns', `program=${PG18}&report=${CMS_FX_CONTRACT_REPORT_ID}`],
    ['returns', `program=${PG9}&manual=choose`],
  ]
  for (const [screen, qs] of MATRIX) for (const theme of ['light', 'dark'] as Theme[]) for (const dev of Object.keys(DEVICES) as Dev[]) {
    test(`${screen}?${qs.slice(0, 70)} ${dev} ${theme}`, async ({ page }) => {
      const writes = await trapWrites(page)
      await page.setViewportSize(DEVICES[dev])
      await open(page, screen, qs, theme)
      await noPageOverflow(page, `${screen} ${qs} ${dev} ${theme}`)
      if (dev !== 'd1280') await touchTargets(page, `${screen} ${qs} ${dev}`)
      await shot(page, `full-${screen}-${qs.replace(/[=&]/g, '_').replace(/0000000-0000-4000-8000-0+/g, '').slice(0, 60)}-${dev}-${theme}`)
      expect(writes).toEqual([])
    })
  }
})

test.describe('ui v2 CMS full_line (132 r1) — nội dung @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('dược sĩ PG17: hero = Σ engine; câu phạm vi full_line; sản phẩm + lịch sử có dòng Trả hàng', async ({ page }) => {
    const writes = await trapWrites(page)
    await open(page, 'staff', `fx=full&program=${PG17}`)
    const main = page.locator('main [data-testid="ui-catalog-cms-staff"]')
    await expect(main.locator('[data-cms-hero-amount]')).toHaveText(cmsVnd(sum(cmsFxStaffResults('running', PG17))))
    await expect(main.locator(`[data-cms-sales-only="${FULL}"]`).first()).toContainText('trừ đủ lượng của dòng')
    await open(page, 'product', `pp=${pp(PG17, 0)}`)
    await expect(page.locator('main [data-testid="ui-catalog-cms-product"] [data-cms-recent] [data-cms-line-kind="RETURN"]').first()).toBeVisible()
    await open(page, 'history', `fx=full&program=${PG17}`)
    const hist = page.locator('main [data-testid="ui-catalog-cms-history"] [data-cms-line-kind="RETURN"]')
    await expect(hist.first()).toContainText('Trả hàng · đơn gốc')
    // P1-03: hai phiếu cùng dòng bán — phiếu đầu trừ đủ lượng dòng, phiếu sau lượng 0 (GMV vẫn trừ theo tiền hoàn).
    await expect(hist.filter({ hasText: 'PT1701' })).toContainText('trừ đủ lượng dòng bán')
    await expect(hist.filter({ hasText: 'PT1705' })).toContainText('lượng của dòng bán đã trừ ở phiếu trước · GMV trừ theo tiền hoàn')
    expect(writes).toEqual([])
  })

  test('super PG18 đã chốt run contract: số đã chốt = số RÒNG, khối hợp đồng + phiếu đã trừ + câu số RÒNG', async ({ page }) => {
    const writes = await trapWrites(page)
    await open(page, 'detail', `program=${PG18}`)
    const main = page.locator('main [data-testid="ui-catalog-cms-detail"]')
    const c = cmsFxContract(PG18)!
    await expect(main.locator('[data-cms-payout-total]')).toHaveText(cmsVnd(c.out.results.reduce((a, r) => a + r.amountVnd, BigInt(0))))
    await expect(main.locator(`[data-cms-payout-contract="${FULL}"]`)).toBeVisible()
    await expect(main.locator('[data-cms-payout-returns="3"]')).toBeVisible()
    await expect(main.locator('[data-cms-payout-net-note]')).toContainText('số RÒNG')
    await open(page, 'detail', `program=${PG18}&as=sm`)
    await expect(page.locator(`main [data-cms-payout-contract="${FULL}"]`)).toBeVisible()
    await expect(page.locator('main [data-cms-payout-returns]')).toHaveCount(0)
    expect(writes).toEqual([])
  })

  test('sổ trả PG17 (fp v2): proof ⇒ baseline không lượng (—), nút xác nhận; báo cáo PG18 contract: câu số RÒNG, cột đã trừ, người lập + lý do; Excel bị chặn', async ({ page }) => {
    const writes = await trapWrites(page)
    await open(page, 'returns', `program=${PG17}&rs=proof`)
    await expect(page.locator('main [data-cms-ledger-verdict="OPEN_CONFLICT_MATCH"]')).toBeVisible()
    await expect(page.locator('main [data-cms-conflict="MISSING"]')).toContainText('— ·')
    await open(page, 'returns', `program=${PG18}`)
    const row = page.locator(`main [data-cms-close-report="${CMS_FX_CONTRACT_REPORT_ID}"]`)
    await expect(row.locator('[data-cms-close-report-via="super"]')).toContainText('Lập tay ngày 31')
    await expect(row.locator('[data-cms-close-report-reason]')).toContainText('PT1804')
    await row.getByRole('link', { name: 'Xem' }).click()
    const detail = page.locator(`main [data-cms-close-report-detail="${CMS_FX_CONTRACT_REPORT_ID}"]`)
    await detail.waitFor({ state: 'visible' })
    await expect(detail.locator('[data-cms-close-report-contract]')).toContainText('không bị trừ lại')
    await expect(detail.getByRole('columnheader', { name: 'Đã trừ lúc chốt' })).toBeVisible()
    await expect(detail.locator('[data-cms-close-report-frozen-return]')).toHaveCount(cmsFxContractCloseReport(PG18, CMS_FX_CONTRACT_REPORT_ID)!.lines.length)
    await expect(detail.locator('[data-cms-close-report-via="super"]')).toContainText('Lý do:')
    await detail.locator('[data-cms-close-report-xlsx]').click()
    await expectBlocked(page, 1, 'xuất Excel báo cáo run contract')
    expect(writes).toEqual([])
  })

  test('lập tay ngày 31: đã ghim ⇒ chỉ hiển thị quy tắc; chưa ghim ⇒ radio bắt buộc + lý do ≥ 10; DB thiếu đường ⇒ khoá; gửi ⇒ guard chặn, 0 ghi', async ({ page }) => {
    const writes = await trapWrites(page)
    await open(page, 'returns', `program=${PG18}`)
    const pinned = page.locator(`main [data-cms-manual-report="${FULL}"]`)
    await expect(pinned).toContainText('Quy tắc báo cáo đã ghim')
    await pinned.locator('[data-cms-manual-open]').click()
    let dlg = page.getByRole('dialog')
    await expect(dlg.locator('[data-cms-manual-profile]')).toHaveCount(0)
    await expect(dlg.locator('[data-cms-manual-submit]')).toBeDisabled()
    await dlg.locator('[data-cms-manual-reason]').fill('Phiếu hoàn tất sau ngày 30 — đối soát ngày 31 (minh hoạ)')
    await dlg.locator('[data-cms-manual-submit]').click()
    await expectBlocked(page, 1, 'lập tay đã ghim')
    await open(page, 'returns', `program=${PG9}&manual=choose`)
    const choose = page.locator('main [data-cms-manual-report="choose"]')
    await expect(choose).toContainText('chưa chọn quy tắc')
    await choose.locator('[data-cms-manual-open]').click()
    dlg = page.getByRole('dialog')
    await expect(dlg.locator('[data-cms-manual-profile]')).toHaveCount(2)
    await dlg.locator('[data-cms-manual-reason]').fill('Chọn quy tắc trừ đủ dòng bán cho kỳ (minh hoạ)')
    // Chưa chọn quy tắc ⇒ chưa gửi được (không mặc định).
    await expect(dlg.locator('[data-cms-manual-submit]')).toBeDisabled()
    await dlg.locator(`[data-cms-manual-profile="${FULL}"]`).click()
    await expect(dlg.locator('[data-cms-manual-submit]')).toBeEnabled()
    await dlg.locator('[data-cms-manual-submit]').click()
    await expectBlocked(page, 1, 'lập tay chọn quy tắc')
    await open(page, 'returns', `program=${PG9}&manual=off`)
    await expect(page.locator('main [data-cms-manual-open]')).toBeDisabled()
    await expect(page.locator('main [data-cms-manual-disabled]')).toContainText('migration 132')
    await open(page, 'returns', `program=${PG9}&manual=error`)
    await expect(page.locator('main [data-cms-manual-open]')).toHaveCount(0)
    await expect(page.locator('main [data-cms-returns-admin]')).toContainText('Không đọc được lần chốt')
    expect(writes).toEqual([])
  })
})
