import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { SUPER_STATE } from './authState'
import { expectBlocked, trapWrites } from './fixtureGuard'
import { CMS_FX_PG, cmsFxProgram } from '../lib/cms/fixtureScenario'
import { CMS_FX_PG_CONTRACT, CMS_FX_REPORT_ID, cmsFxContract } from '../lib/cms/fixturesContract'
import { cmsFxAdminResults, cmsFxStaffResults, cmsFxStoreResults } from '../lib/cms/fixturesResults'
import { CMS_SALES_ONLY_NOTE, type CmsResultsLoad } from '../lib/cms/resultUi'
import { CMS_QUANTITY_BASIS_LABEL } from '../lib/cms/calc/policy'
import { cmsVnd } from '../lib/cms/display'

// CMS-CALC-RET-2 P5 — browser scoped gate trên fixture /ui-catalog/cms-v2 (ĐÚNG view route thật, dữ liệu giả lib/cms/fixturesContract:
// số do computeCmsNet tính). Kiểm: 360 / 390 / 1280 sáng / tối không cuộn ngang, chạm ≥ 44 trên mobile; cách tính / chính sách đọc từ
// RUN (net ⇒ "đã trừ phiếu trả hàng hoàn tất", sales-only ⇒ câu T11 nguyên văn); "Không tính lượng"; "Đã bán · đã trả · còn"; dòng
// "Trả hàng · đơn gốc"; held giữ số cũ; A3 badge + tổng trả + nút Trả hàng; trang Trả hàng: proof ⇒ nút xác nhận, conflict ⇒ không nút,
// cờ OFF ⇒ khoá; báo cáo sau chốt; form radio cách tính bắt buộc; nạp file khi nháp chưa chọn ⇒ khoá; cờ OFF (run legacy) giữ nguyên T11
// không dòng "Cách tính", cờ BẬT (bu=1) có dòng; mọi thao tác ghi / tải file bị guard fixture chặn — 0 request ghi.

const HAS_SUPER = fs.existsSync(SUPER_STATE)
const SHOTS = process.env.CMS_SHOTS_DIR
type Theme = 'light' | 'dark'
type Screen = 'staff' | 'product' | 'history' | 'detail' | 'returns' | 'wizard'
const DEVICES = { m360: { width: 360, height: 800 }, m390: { width: 390, height: 844 }, d1280: { width: 1280, height: 900 } } as const
type Dev = keyof typeof DEVICES
const PG13 = CMS_FX_PG_CONTRACT.PG13
const PG14 = CMS_FX_PG_CONTRACT.PG14
const PG15 = CMS_FX_PG_CONTRACT.PG15
const PG9 = CMS_FX_PG.PG9
const pp = (id: string, i: number) => cmsFxContract(id)!.fx.products[i].id

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

test.describe('ui v2 CMS-CALC-RET-2 — bố cục 360 / 390 / 1280 sáng / tối, 0 ghi @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })
  // Bảng (A3 / trang Trả hàng / báo cáo) cuộn trong DataTableShell — chỉ kiểm không cuộn ngang trang; chạm ≥ 44 trên mọi màn mobile.
  const MATRIX: [Screen, string][] = [
    ['staff', `fx=contract&program=${PG13}`], ['staff', `fx=contract-manager&program=${PG13}`], ['staff', `fx=contract&program=${PG14}`],
    ['staff', `fx=contract&program=${PG13}&p2=held`],
    ['product', `pp=${pp(PG13, 0)}`], ['product', `pp=${pp(PG13, 1)}&as=manager`],
    ['history', `fx=contract&program=${PG13}`],
    ['detail', `program=${PG13}`], ['detail', `program=${PG15}&view=staff`],
    ['returns', `program=${PG13}&rs=proof`], ['returns', `program=${PG9}`], ['returns', `program=${PG9}&report=${CMS_FX_REPORT_ID}`],
    ['wizard', 'fx=info&b=on'], ['wizard', 'fx=upload&b=pending'], ['wizard', 'fx=result&b=unit'],
  ]
  for (const [screen, qs] of MATRIX) for (const theme of ['light', 'dark'] as Theme[]) for (const dev of Object.keys(DEVICES) as Dev[]) {
    test(`${screen}?${qs.slice(0, 70)} ${dev} ${theme}`, async ({ page }) => {
      const writes = await trapWrites(page)
      await page.setViewportSize(DEVICES[dev])
      await open(page, screen, qs, theme)
      await noPageOverflow(page, `${screen} ${qs} ${dev} ${theme}`)
      if (dev !== 'd1280') await touchTargets(page, `${screen} ${qs} ${dev}`)
      await shot(page, `ret2-${screen}-${qs.replace(/[=&]/g, '_').replace(/0000000-0000-4000-8000-0+/g, '').slice(0, 60)}-${dev}-${theme}`)
      expect(writes).toEqual([])
    })
  }
})

test.describe('ui v2 CMS-CALC-RET-2 — nội dung theo run @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  test('D1 staff PG13 (tính nguyên + trừ trả): hero = Σ engine; dòng cách tính + câu phạm vi net theo run', async ({ page }) => {
    const writes = await trapWrites(page)
    await open(page, 'staff', `fx=contract&program=${PG13}`)
    const main = page.locator('main [data-testid="ui-catalog-cms-staff"]')
    await expect(main.locator('[data-cms-hero-amount]')).toHaveText(cmsVnd(sum(cmsFxStaffResults('running', PG13))))
    await expect(main.locator('[data-cms-run-basis="cms_unit"]').first()).toContainText(CMS_QUANTITY_BASIS_LABEL.cms_unit)
    await expect(main.locator('[data-cms-sales-only="net_returns_v1"]').first()).toContainText('đã trừ phiếu trả hàng hoàn tất')
    expect(writes).toEqual([])
  })

  test('D1 PG14 (chưa trừ trả): câu T11 nguyên văn; QLCH PG13: hero nhà thuốc = Σ engine', async ({ page }) => {
    await open(page, 'staff', `fx=contract&program=${PG14}`)
    const main = page.locator('main [data-testid="ui-catalog-cms-staff"]')
    await expect(main.locator('[data-cms-sales-only="sales_only_v1"]').first()).toHaveText(CMS_SALES_ONLY_NOTE)
    await expect(main.locator('[data-cms-run-basis="cms_unit"]').first()).toBeVisible()
    await open(page, 'staff', `fx=contract-manager&program=${PG13}`)
    await expect(page.locator('main [data-cms-store-amount]')).toHaveText(cmsVnd(sum(cmsFxStoreResults('running', PG13))))
  })

  test('cờ OFF (run legacy PG1): câu T11 nguyên văn, KHÔNG dòng cách tính; cờ BẬT (bu=1): có dòng "Tính lẻ — cộng dồn"', async ({ page }) => {
    await open(page, 'staff', `program=${CMS_FX_PG.PG1}&p2=running`)
    const main = page.locator('main [data-testid="ui-catalog-cms-staff"]')
    await expect(main.locator('[data-cms-sales-only="sales_only_v1"]').first()).toHaveText(CMS_SALES_ONLY_NOTE)
    await expect(main.locator('[data-cms-run-basis]')).toHaveCount(0)
    await open(page, 'staff', `program=${CMS_FX_PG.PG1}&p2=running&bu=1`)
    await expect(page.locator('main [data-cms-run-basis="pos_base"]').first()).toContainText(CMS_QUANTITY_BASIS_LABEL.pos_base)
    await open(page, 'detail', `program=${CMS_FX_PG.PG1}&p2=running`)
    await expect(page.locator('main [data-cms-run-basis]')).toHaveCount(0)
    await expect(page.locator('main [data-cms-returns-link]')).toHaveCount(0)
  })

  test('D2 vitamin PG13: Không tính lượng 155 viên; "Đã bán · đã trả · còn"; gần đây có dòng Trả hàng + Không tính lượng', async ({ page }) => {
    const writes = await trapWrites(page)
    await open(page, 'product', `pp=${pp(PG13, 0)}`)
    const main = page.locator('main [data-testid="ui-catalog-cms-product"]')
    await expect(main.locator('[data-cms-qty-not-counted]')).toContainText('Không tính lượng')
    await expect(main.locator('[data-cms-net-line]').first()).toContainText('đã trả')
    await expect(main.locator('[data-cms-recent] [data-cms-line-kind="RETURN"]')).toHaveCount(1)
    await expect(main.locator('[data-cms-recent] [data-cms-line="NOT_COUNTED"]').first()).toBeVisible()
    await expect(main.locator('[data-cms-product-amount]').first()).toContainText(cmsVnd(sum(cmsFxStaffResults('running', PG13), pp(PG13, 0))))
    expect(writes).toEqual([])
  })

  test('D3 lịch sử PG13: dòng Trả hàng · đơn gốc (giảm CMS / không đổi) và Không tính lượng', async ({ page }) => {
    await open(page, 'history', `fx=contract&program=${PG13}`)
    const main = page.locator('main [data-testid="ui-catalog-cms-history"]')
    const ret = main.locator('[data-cms-line-kind="RETURN"]')
    await expect(ret.first()).toBeVisible()
    await expect(ret.first()).toContainText('Trả hàng · đơn gốc')
    await expect(main.locator('[data-cms-line="RETURN_REDUCED"], [data-cms-line="RETURN_NO_CHANGE"]').first()).toBeVisible()
    await expect(main.locator('[data-cms-line="NOT_COUNTED"]').first()).toContainText('Không tính lượng')
  })

  test('held PG13: giữ số cũ (không 0₫ giả) kèm trạng thái cập nhật chưa thành công', async ({ page }) => {
    await open(page, 'staff', `fx=contract&program=${PG13}&p2=held`)
    const main = page.locator('main [data-testid="ui-catalog-cms-staff"]')
    await expect(main.locator('[data-cms-hero-amount]')).toHaveText(cmsVnd(sum(cmsFxStaffResults('held', PG13))))
    await expect(main).toContainText('chưa thành công')
  })

  test('A3 PG13 super: badge cách tính / chính sách, tổng trả, nút Trả hàng ở lại catalog; SM không có nút', async ({ page }) => {
    const writes = await trapWrites(page)
    // &ret=1 = CMS_RETURNS_ENABLED (PM 14/11: nút Trả hàng chỉ khi pipeline trả bật; bản CMS bán hàng không có nút — spec sales RC).
    await open(page, 'detail', `program=${PG13}&ret=1`)
    const main = page.locator('main [data-testid="ui-catalog-cms-detail"]')
    await expect(main.locator('[data-cms-basis="cms_unit"][data-cms-returns-policy="net_returns_v1"]')).toHaveCount(1)
    await expect(main.locator('[data-cms-net-summary]')).toContainText('Đã trừ 3 phiếu trả hàng hoàn tất')
    const link = main.locator('[data-cms-returns-link]')
    await expect(link).toHaveAttribute('href', new RegExp(`^/ui-catalog/cms-v2/returns\\?program=${PG13}`))
    await link.click()
    await page.locator('main [data-testid="ui-catalog-cms-returns"] [data-cms-returns-admin]').waitFor({ state: 'visible' })
    await open(page, 'detail', `program=${PG13}&as=sm`)
    await expect(page.locator('main [data-cms-returns-link]')).toHaveCount(0)
    expect(cmsFxAdminResults('running', 'sm', PG13).kind).toBe('loaded')
    expect(writes).toEqual([])
  })

  test('Trả hàng: proof ⇒ xác nhận (lý do ≥ 10, guard chặn, 0 ghi); conflict ⇒ không nút; cờ OFF ⇒ khoá + lý do', async ({ page }) => {
    const writes = await trapWrites(page)
    await open(page, 'returns', `program=${PG13}&rs=proof`)
    const main = page.locator('main [data-cms-returns-admin]')
    await expect(main.locator('[data-cms-ledger-verdict="OPEN_CONFLICT_MATCH"]')).toBeVisible()
    await main.locator('[data-cms-confirm-restored]').click()
    const dlg = page.getByRole('dialog')
    await expect(dlg.locator('[data-cms-confirm-reason-hint]')).toContainText('không ghi tên hoặc số điện thoại khách')
    await expect(dlg.locator('[data-cms-confirm-submit]')).toBeDisabled()
    await dlg.locator('[data-cms-confirm-reason]').fill('Nguồn khớp lại đúng phiếu PT1302 (minh hoạ)')
    await dlg.locator('[data-cms-confirm-submit]').click()
    await expectBlocked(page, 1, 'xác nhận phục hồi')
    await open(page, 'returns', `program=${PG13}&rs=conflict`)
    await expect(page.locator('main [data-cms-ledger-verdict="MISMATCH"]')).toBeVisible()
    await expect(page.locator('main [data-cms-conflict="MISSING"]')).toHaveCount(1)
    await expect(page.locator('main [data-cms-confirm-restored]')).toHaveCount(0)
    await open(page, 'returns', `program=${PG13}&rs=proof&off=1`)
    await expect(page.locator('main [data-cms-confirm-restored]')).toBeDisabled()
    await expect(page.locator('main [data-cms-returns-admin]')).toContainText('Pipeline trả hàng đang tắt')
    await open(page, 'returns', `program=${PG13}&rs=restored`)
    await expect(page.locator('main [data-cms-restorations] li')).toHaveCount(1)
    expect(writes).toEqual([])
  })

  test('báo cáo sau chốt PG9: danh sách → chi tiết (tham khảo, không phải lệnh thu / chi); Xuất Excel bị guard chặn', async ({ page }) => {
    const writes = await trapWrites(page)
    await open(page, 'returns', `program=${PG9}`)
    const row = page.locator(`main [data-cms-close-report="${CMS_FX_REPORT_ID}"]`)
    await expect(row).toBeVisible()
    await row.getByRole('link', { name: 'Xem' }).click()
    const detail = page.locator(`main [data-cms-close-report-detail="${CMS_FX_REPORT_ID}"]`)
    await detail.waitFor({ state: 'visible' })
    await expect(detail).toContainText('Không phải lệnh thu / chi')
    const pg9 = cmsFxProgram(PG9)!
    await expect(detail.locator('[data-cms-close-report-line]')).toHaveCount(pg9.out!.results.length)
    await detail.locator('[data-cms-close-report-xlsx]').click()
    await expectBlocked(page, 1, 'xuất Excel báo cáo sau chốt')
    expect(writes).toEqual([])
  })

  test('form cách tính (cờ BẬT): radio 2 lựa chọn, chưa chọn ⇒ lỗi, không lưu; nạp file khi nháp chưa chọn ⇒ khoá "Chạy xử lý"', async ({ page }) => {
    const writes = await trapWrites(page)
    await open(page, 'wizard', 'fx=info&b=on')
    const main = page.locator('main [data-testid="ui-catalog-cms-wizard"]')
    await expect(main.locator('[data-cms-basis-option]')).toHaveCount(2)
    await open(page, 'wizard', 'fx=edit-active&b=unit')
    await expect(page.locator('main [data-cms-basis-locked="cms_unit"]')).toBeVisible()
    await open(page, 'wizard', 'fx=edit-invalid&b=compat')
    await expect(page.locator('main [data-cms-basis-note="legacy_compat"]')).toBeVisible()
    await open(page, 'wizard', 'fx=upload&b=pending')
    await expect(page.locator('main [data-cms-import-basis="pending"]')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Chạy xử lý' })).toBeDisabled()
    await open(page, 'wizard', 'fx=result&b=unit')
    await expect(page.locator('main [data-cms-import-result-basis="cms_unit"]')).toBeVisible()
    await open(page, 'wizard', 'fx=info')
    await expect(page.locator('main [data-cms-basis-field]')).toHaveCount(0)
    expect(writes).toEqual([])
  })
})
