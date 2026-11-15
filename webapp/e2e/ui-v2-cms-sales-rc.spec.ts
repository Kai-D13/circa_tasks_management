import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { SUPER_STATE } from './authState'
import { blockedCounter, expectBlocked, trapWrites } from './fixtureGuard'
import { CMS_FX_PG } from '../lib/cms/fixtureScenario'
import { CMS_FX_PG_CONTRACT, CMS_FX_REPORT_PROGRAM, cmsFxContract } from '../lib/cms/fixturesContract'
import { cmsFxAdminResults, cmsFxStaffResults, cmsFxStoreResults } from '../lib/cms/fixturesResults'
import { CMS_SALES_ONLY_NOTE, type CmsResultsLoad } from '../lib/cms/resultUi'
import { CMS_QUANTITY_BASIS_LABEL } from '../lib/cms/calc/policy'
import { cmsVnd } from '../lib/cms/display'
import { CMS_127_T11_ID } from './cmsQaTooling'

// CMS bán hàng — RC phát hành trước (PM 14/11 `planning/reviews/2026-11-14-cms-sales-first-release-pm.md`). Browser scoped trên fixture
// /ui-catalog/cms-v2 (ĐÚNG view của route thật, số giả do engine tính — lib/cms/fixturesContract): cờ mode BẬT, trả hàng TẮT.
//   · Bố cục 360 / 390 / 1280 sáng / tối: không cuộn ngang, chạm ≥ 44 (mobile); ảnh cho guide bán hàng (CMS_SHOTS_DIR).
//   · Dược sĩ / QLCH / SM / super xem chương trình tính nguyên (PG14 — run contract cms_unit + sales_only) và chương trình mới chọn
//     "Tính lẻ" (PG16 — DB vẫn tạo run LEGACY, như T11; PM RC r2 SALES-RC-02) chưa trừ trả: câu phạm vi T11 nguyên văn, không dòng / nút /
//     tổng trả hàng. Run legacy (T11, PG16) chỉ hiện dòng "Cách tính" khi cờ mode bật (&bu=1 = loader gắn basisUi).
//   · PM P5-02: form THẬT SỰ chọn cách tính, bấm lưu và đọc payload (`data-cms-pending-payload` ghi ngay trước khi boundary chặn action):
//     chưa chọn ⇒ lỗi + 0 payload + 0 action; chọn ⇒ payload đúng MỘT mode; đã kích hoạt ⇒ gửi lại đúng mode hiện tại; cờ OFF ⇒ không khoá.
//   · Returns OFF: nút "Trả hàng" chỉ khi &ret=1 (= CMS_RETURNS_ENABLED); route thật /returns ⇒ 404 khi cờ tắt — kiểm cả khi
//     CMS_PROGRAM_ENABLED + CMS_EARNINGS_ENABLED bật (cấu hình prod): chi tiết T11 thật mở, panel kết quả đọc qua reader thật có run +
//     câu sales-only, /returns của nó 404 (PM RC r2 SALES-RC-01). A3 run sales_only KHÔNG dòng "Đã trừ … phiếu".
// Mọi thao tác ghi / tải file bị guard fixture chặn — 0 request ghi. Không phải bằng chứng ghi DB / nguồn thật (smoke sau deploy).

const HAS_SUPER = fs.existsSync(SUPER_STATE)
const SHOTS = process.env.CMS_SHOTS_DIR
type Theme = 'light' | 'dark'
type Screen = 'staff' | 'product' | 'history' | 'detail' | 'wizard'
const DEVICES = { m360: { width: 360, height: 800 }, m390: { width: 390, height: 844 }, d1280: { width: 1280, height: 900 } } as const
type Dev = keyof typeof DEVICES
const PG13 = CMS_FX_PG_CONTRACT.PG13
const PG14 = CMS_FX_PG_CONTRACT.PG14
const PG16 = CMS_FX_PG_CONTRACT.PG16
const PG1 = CMS_FX_PG.PG1
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
const payloadOf = async (page: Page) =>
  JSON.parse((await page.locator('main [data-cms-program-form]').getAttribute('data-cms-pending-payload')) ?? 'null') as Record<string, unknown> | null

test.describe('ui v2 CMS bán hàng RC — bố cục 360 / 390 / 1280 sáng / tối, 0 ghi @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })
  const MATRIX: [Screen, string][] = [
    ['staff', `fx=contract&program=${PG14}`], ['staff', `fx=contract&program=${PG16}&bu=1`], ['staff', `fx=contract-manager&program=${PG14}`],
    ['staff', `fx=contract&program=${PG14}&p2=held`], ['staff', `program=${PG1}&p2=running&bu=1`],
    ['product', `pp=${pp(PG14, 0)}`], ['product', `pp=${pp(PG16, 1)}&as=manager`],
    ['history', `fx=contract&program=${PG14}`],
    ['detail', `program=${PG14}`], ['detail', `program=${PG16}&view=staff&bu=1`], ['detail', `program=${PG14}&as=sm`],
    ['wizard', 'fx=info&b=on'], ['wizard', 'fx=upload&b=unit'], ['wizard', 'fx=result&b=pos'],
  ]
  for (const [screen, qs] of MATRIX) for (const theme of ['light', 'dark'] as Theme[]) for (const dev of Object.keys(DEVICES) as Dev[]) {
    test(`${screen}?${qs.slice(0, 70)} ${dev} ${theme}`, async ({ page }) => {
      const writes = await trapWrites(page)
      await page.setViewportSize(DEVICES[dev])
      await open(page, screen, qs, theme)
      await noPageOverflow(page, `${screen} ${qs} ${dev} ${theme}`)
      if (dev !== 'd1280') await touchTargets(page, `${screen} ${qs} ${dev}`)
      // Bản bán hàng: không màn nào trong ma trận có nút / dòng trả hàng.
      await expect(page.locator('main [data-cms-returns-link], main [data-cms-line-kind="RETURN"]')).toHaveCount(0)
      await shot(page, `sales-${screen}-${qs.replace(/[=&]/g, '_').replace(/0000000-0000-4000-8000-0+/g, '').slice(0, 60)}-${dev}-${theme}`)
      expect(writes).toEqual([])
    })
  }
})

test.describe('ui v2 CMS bán hàng RC — form cách tính (PM P5-02: chọn, bấm lưu, payload) @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  for (const dev of Object.keys(DEVICES) as Dev[]) {
    test(`tạo (cờ mode BẬT) ${dev}: chưa chọn ⇒ lỗi, 0 payload, 0 action; Tính lẻ / Tính nguyên ⇒ payload đúng một mode, guard chặn ghi`, async ({ page }) => {
      const writes = await trapWrites(page)
      await page.setViewportSize(DEVICES[dev])
      await open(page, 'wizard', 'fx=info&b=on')
      const main = page.locator('main [data-cms-wizard]')
      await expect(main.locator('[data-cms-basis-option]')).toHaveCount(2)
      await main.locator('input').first().fill('CMS thử cách tính')
      await main.locator('input[type=date]').first().fill('2026-12-01')
      await main.locator('input[type=date]').nth(1).fill('2026-12-31')
      await expect(main.locator('input[name="quantity_basis"]:checked'), 'không chọn sẵn').toHaveCount(0)
      await main.getByRole('button', { name: 'Lưu nháp' }).click()
      await expect(main.locator('[role="alert"]')).toContainText('Chọn cách tính lượng cho chương trình')
      await expect(blockedCounter(page), 'chưa chọn ⇒ không gọi action').toHaveAttribute('data-kpi-fixture-blocked', '0')
      expect(await payloadOf(page)).toBeNull()

      await main.locator('[data-cms-basis-option="pos_base"]').click()
      await expect(main.locator('input[name="quantity_basis"][value="pos_base"]')).toBeChecked()
      await main.getByRole('button', { name: 'Lưu nháp' }).click()
      await expectBlocked(page, 1, 'Lưu nháp · Tính lẻ')
      const p1 = await payloadOf(page)
      expect(p1).toEqual({ name: 'CMS thử cách tính', start_date: '2026-12-01', end_date: '2026-12-31', scope: 'all', store_ids: [], quantity_basis: 'pos_base' })

      await main.locator('[data-cms-basis-option="cms_unit"]').click()
      await expect(main.locator('input[name="quantity_basis"]:checked')).toHaveCount(1)
      await main.getByRole('button', { name: 'Tiếp tục · Upload file' }).click()
      await expectBlocked(page, 2, 'Tiếp tục · Upload file · Tính nguyên')
      expect((await payloadOf(page))?.quantity_basis).toBe('cms_unit')
      expect(Object.keys((await payloadOf(page)) ?? {}).filter((k) => k === 'quantity_basis')).toHaveLength(1)
      await shot(page, `sales-form-create-${dev}`)
      expect(writes, 'form gửi request ghi').toEqual([])
    })
  }

  test('sửa nháp đã chọn Tính lẻ: giữ lựa chọn, đổi sang Tính nguyên ⇒ payload cms_unit; nháp có trước lựa chọn ⇒ phải chọn lại', async ({ page }) => {
    const writes = await trapWrites(page)
    await open(page, 'wizard', 'fx=edit-invalid&b=pos')
    let main = page.locator('main [data-cms-wizard]')
    await expect(main.locator('input[name="quantity_basis"][value="pos_base"]')).toBeChecked()
    const inv = main.locator('[data-cms-invalid-store]')
    for (let i = 0; i < 2; i++) await inv.first().getByRole('button', { name: 'Bỏ chọn' }).click()
    await expect(inv).toHaveCount(0)
    await main.locator('[data-cms-basis-option="cms_unit"]').click()
    await main.getByRole('button', { name: 'Lưu thay đổi' }).click()
    await expectBlocked(page, 1, 'Lưu thay đổi · đổi cách tính')
    expect(await payloadOf(page)).toMatchObject({ scope: 'stores', quantity_basis: 'cms_unit' })

    await open(page, 'wizard', 'fx=edit-invalid&b=legacy')
    main = page.locator('main [data-cms-wizard]')
    await expect(main.locator('[data-cms-basis-note="legacy_migration"]')).toBeVisible()
    await expect(main.locator('input[name="quantity_basis"]:checked'), 'legacy không chọn sẵn').toHaveCount(0)
    for (let i = 0; i < 2; i++) await main.locator('[data-cms-invalid-store]').first().getByRole('button', { name: 'Bỏ chọn' }).click()
    await main.getByRole('button', { name: 'Lưu thay đổi' }).click()
    await expect(main.locator('[role="alert"]')).toContainText('Chọn cách tính lượng cho chương trình')
    await expect(blockedCounter(page)).toHaveAttribute('data-kpi-fixture-blocked', '0')
    expect(await payloadOf(page)).toBeNull()
    expect(writes).toEqual([])
  })

  test('đã kích hoạt: cách tính khoá (không radio); lưu ⇒ payload gửi lại đúng mode hiện tại (server + DB chặn đổi)', async ({ page }) => {
    const writes = await trapWrites(page)
    await open(page, 'wizard', 'fx=edit-active&b=unit')
    const main = page.locator('main [data-cms-wizard]')
    await expect(main.locator('[data-cms-basis-locked="cms_unit"]')).toContainText(CMS_QUANTITY_BASIS_LABEL.cms_unit)
    await expect(main.locator('input[name="quantity_basis"]')).toHaveCount(0)
    await main.locator('input[type=date]').first().fill('2026-11-21')
    await main.getByRole('button', { name: 'Lưu thay đổi' }).click()
    await expectBlocked(page, 1, 'Lưu thay đổi · đã kích hoạt')
    expect(await payloadOf(page)).toMatchObject({ start_date: '2026-11-21', quantity_basis: 'cms_unit' })
    expect(writes).toEqual([])
  })

  test('cờ mode OFF: không ô cách tính; payload KHÔNG có khoá quantity_basis (đường 121 như cũ)', async ({ page }) => {
    const writes = await trapWrites(page)
    await open(page, 'wizard', 'fx=info')
    const main = page.locator('main [data-cms-wizard]')
    await expect(main.locator('[data-cms-basis-field]')).toHaveCount(0)
    await main.locator('input').first().fill('CMS cờ tắt')
    await main.locator('input[type=date]').first().fill('2026-12-01')
    await main.locator('input[type=date]').nth(1).fill('2026-12-31')
    await main.getByRole('button', { name: 'Lưu nháp' }).click()
    await expectBlocked(page, 1, 'Lưu nháp · cờ OFF')
    const p = await payloadOf(page)
    expect(p).not.toBeNull()
    expect(Object.prototype.hasOwnProperty.call(p, 'quantity_basis')).toBe(false)
    expect(writes).toEqual([])
  })

  test('nạp file: nháp chưa chọn cách tính ⇒ khoá "Chạy xử lý"; đã chọn ⇒ badge; kết quả import ghim cách tính', async ({ page }) => {
    const writes = await trapWrites(page)
    await open(page, 'wizard', 'fx=upload&b=pending')
    await expect(page.locator('main [data-cms-import-basis="pending"]')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Chạy xử lý' })).toBeDisabled()
    await open(page, 'wizard', 'fx=upload&b=unit')
    await expect(page.locator('main [data-cms-import-basis="cms_unit"]')).toBeVisible()
    await open(page, 'wizard', 'fx=result&b=pos')
    await expect(page.locator('main [data-cms-import-result-basis="pos_base"]')).toBeVisible()
    expect(writes).toEqual([])
  })
})

test.describe('ui v2 CMS bán hàng RC — số dược sĩ / QLCH / quản trị, trả hàng TẮT @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })

  // PG14: run contract ⇒ dòng cách tính theo run kể cả cờ mode tắt. PG16: run LEGACY ⇒ chỉ khi cờ mode bật (&bu=1); tắt ⇒ không dòng.
  for (const [label, id, basis, bu] of [['PG14 tính nguyên (run contract)', PG14, 'cms_unit', ''], ['PG16 Tính lẻ (run legacy, cờ mode bật)', PG16, 'pos_base', '&bu=1']] as const) {
    test(`dược sĩ ${label}: hero = Σ engine; dòng cách tính theo run; câu phạm vi T11 nguyên văn (chưa trừ trả); 0 dòng trả`, async ({ page }) => {
      const writes = await trapWrites(page)
      await open(page, 'staff', `fx=contract&program=${id}${bu}`)
      const main = page.locator('main [data-testid="ui-catalog-cms-staff"]')
      await expect(main.locator('[data-cms-hero-amount]')).toHaveText(cmsVnd(sum(cmsFxStaffResults('running', id))))
      await expect(main.locator(`[data-cms-run-basis="${basis}"]`).first()).toContainText(CMS_QUANTITY_BASIS_LABEL[basis])
      await expect(main.locator('[data-cms-sales-only="sales_only_v1"]').first()).toHaveText(CMS_SALES_ONLY_NOTE)
      await expect(main.locator('[data-cms-sales-only="net_returns_v1"]')).toHaveCount(0)
      await expect(main).not.toContainText('đã trừ phiếu trả hàng')
      if (id === PG16) {
        // Run legacy: không lớp lượng / "Không tính lượng" (chỉ run contract cms_unit có); cờ mode tắt ⇒ không dòng cách tính.
        await expect(main.locator('[data-cms-line="NOT_COUNTED"], [data-cms-qty-not-counted]')).toHaveCount(0)
        await open(page, 'staff', `fx=contract&program=${id}`)
        await expect(page.locator('main [data-cms-run-basis]')).toHaveCount(0)
        await expect(page.locator('main [data-cms-sales-only="sales_only_v1"]').first()).toHaveText(CMS_SALES_ONLY_NOTE)
      }
      expect(writes).toEqual([])
    })
  }

  test('QLCH PG14: tổng nhà thuốc = Σ engine; D2 vitamin: "Không tính lượng" (dòng khác đơn vị / lẻ), không "đã trả"; D3: không dòng trả', async ({ page }) => {
    const writes = await trapWrites(page)
    await open(page, 'staff', `fx=contract-manager&program=${PG14}`)
    await expect(page.locator('main [data-cms-store-amount]')).toHaveText(cmsVnd(sum(cmsFxStoreResults('running', PG14))))
    await open(page, 'product', `pp=${pp(PG14, 0)}`)
    const prod = page.locator('main [data-testid="ui-catalog-cms-product"]')
    await expect(prod.locator('[data-cms-qty-not-counted]')).toContainText('Không tính lượng')
    await expect(prod.locator('[data-cms-product-amount]').first()).toContainText(cmsVnd(sum(cmsFxStaffResults('running', PG14), pp(PG14, 0))))
    await expect(prod.locator('[data-cms-recent] [data-cms-line-kind="RETURN"]')).toHaveCount(0)
    await expect(prod).not.toContainText('đã trả')
    await open(page, 'history', `fx=contract&program=${PG14}`)
    const hist = page.locator('main [data-testid="ui-catalog-cms-history"]')
    await expect(hist.locator('[data-cms-line="NOT_COUNTED"]').first()).toContainText('Không tính lượng')
    await expect(hist.locator('[data-cms-line-kind="RETURN"]')).toHaveCount(0)
    expect(writes).toEqual([])
  })

  test('held PG14: giữ số cũ (không 0₫ giả) + trạng thái cập nhật chưa thành công', async ({ page }) => {
    await open(page, 'staff', `fx=contract&program=${PG14}&p2=held`)
    const main = page.locator('main [data-testid="ui-catalog-cms-staff"]')
    await expect(main.locator('[data-cms-hero-amount]')).toHaveText(cmsVnd(sum(cmsFxStaffResults('held', PG14))))
    await expect(main).toContainText('chưa thành công')
  })

  test('A3 super PG14 / PG16: badge cách tính + chưa trừ trả, KHÔNG nút Trả hàng / tổng trả; PG13 / PG9 không ret cũng không nút; ret=1 ⇒ có (đối chứng); SM không nút', async ({ page }) => {
    const writes = await trapWrites(page)
    for (const [id, basis] of [[PG14, 'cms_unit'], [PG16, 'pos_base']] as const) {
      await open(page, 'detail', `program=${id}`)
      const main = page.locator('main [data-testid="ui-catalog-cms-detail"]')
      await expect(main.locator(`[data-cms-basis="${basis}"][data-cms-returns-policy="sales_only_v1"]`)).toHaveCount(1)
      await expect(main.locator('[data-cms-returns-link]')).toHaveCount(0)
      await expect(main.locator('[data-cms-net-summary]')).toHaveCount(0)
      await expect(main.locator('[data-cms-sales-only="sales_only_v1"]')).toHaveText(CMS_SALES_ONLY_NOTE)
      // Badge trên = cấu hình chương trình; dòng "Cách tính" dưới = hợp đồng của RUN: PG14 contract luôn hiện, PG16 legacy chỉ khi cờ mode bật.
      await expect(main.locator('[data-cms-run-basis]')).toHaveCount(id === PG14 ? 1 : 0)
    }
    await open(page, 'detail', `program=${PG16}&bu=1`)
    await expect(page.locator('main [data-cms-run-basis="pos_base"]')).toContainText(CMS_QUANTITY_BASIS_LABEL.pos_base)
    for (const id of [PG13, CMS_FX_REPORT_PROGRAM]) {
      await open(page, 'detail', `program=${id}`)
      await expect(page.locator('main [data-cms-returns-link]'), `${id}: trả hàng TẮT ⇒ không nút`).toHaveCount(0)
    }
    // Đối chứng dòng tóm tắt: chỉ run ghim net_returns_v1 (PG13) mới có "Đã trừ … phiếu" — sales_only (PG14 / PG16) dù có cột ròng
    // (mig 130 ghi net_v = 1 cho mọi run contract) vẫn không hiện.
    await open(page, 'detail', `program=${PG13}`)
    await expect(page.locator('main [data-cms-returns-policy="net_returns_v1"]')).toHaveCount(1)
    await expect(page.locator('main [data-cms-net-summary]')).toContainText('phiếu trả hàng hoàn tất')
    await open(page, 'detail', `program=${PG14}&ret=1`)
    await expect(page.locator('main [data-cms-returns-link]'), 'đối chứng: chỉ cờ trả bật mới có nút').toHaveCount(1)
    await open(page, 'detail', `program=${PG14}&as=sm`)
    await expect(page.locator('main [data-cms-returns-link]')).toHaveCount(0)
    expect(cmsFxAdminResults('running', 'sm', PG14).kind).toBe('loaded')
    expect(writes).toEqual([])
  })

  // FINAL-QA7-01 (PM work order qa7-fix §3): A3 super / SM dựng từ header fixture ĐÃ SỬA (super run contract sales-only mang ledger CLEAN +
  // eval_seq null như DB 130 — parse thật lúc render). Số thẻ "CMS tạm tính" và từng hàng tab "Theo dược sĩ" = Σ engine của cùng run;
  // không hộp lỗi kết quả. PG14 = contract sales-only, PG16 = legacy sales-only (cờ mode OFF / BẬT). XLSX của fixture bị guard chặn tải ⇒
  // XLSX kiểm ở harness PGlite §7 mục 16b (handler thật trên RPC v2).
  test('FINAL-QA7-01 A3 super / SM PG14 (contract sales-only) + PG16 (legacy, cờ mode OFF / BẬT): thẻ CMS tạm tính + tab Theo dược sĩ = Σ engine cùng run; không hộp lỗi', async ({ page }) => {
    const writes = await trapWrites(page)
    const byStaff = (l: CmsResultsLoad) => {
      if (l.kind !== 'loaded') throw new Error('fx')
      const m = new Map<string, bigint>()
      for (const r of l.rows.results) m.set(r.userId, (m.get(r.userId) ?? BigInt(0)) + BigInt(r.amountVnd))
      return [...m.values()].map((v) => cmsVnd(v).replace(/\s/g, '')).sort()
    }
    const cases = [[PG14, '', 'super'], [PG14, '&as=sm', 'sm'], [PG16, '', 'super'], [PG16, '&bu=1', 'super'], [PG16, '&as=sm', 'sm']] as const
    for (const [id, qs, who] of cases) {
      const where = `${id === PG14 ? 'PG14' : 'PG16'}${qs}`
      const load = cmsFxAdminResults('running', who, id)
      if (load.kind !== 'loaded') throw new Error('fx')
      if (id === PG14 && who === 'super') expect(load.header.run?.ledger, `${where}: header fixture super mang ledger sales-only`).toMatchObject({ verdict: 'CLEAN', evalSeq: null })
      if (who === 'sm' || id === PG16) expect(load.header.run?.ledger ?? null, `${where}: không khối ledger`).toBeNull()
      await open(page, 'detail', `program=${id}&p2=running${qs}`)
      const main = page.locator('main [data-testid="ui-catalog-cms-detail"]')
      const stats = main.locator('[data-cms-detail-results]')
      await expect(stats, where).toBeVisible()
      await expect(main.locator('[data-cms-results-error]'), `${where}: không hộp lỗi`).toHaveCount(0)
      const statText = await stats.innerText()
      expect(/CMS tạm tính\s*([\d.]+\s?₫)/.exec(statText)?.[1]?.replace(/\s/g, ''), `${where}: thẻ CMS tạm tính`).toBe(cmsVnd(sum(load)).replace(/\s/g, ''))
      await open(page, 'detail', `program=${id}&p2=running&view=staff${qs}`)
      const rows = page.locator('main [data-cms-staff-row]')
      await expect(rows.first(), where).toBeVisible()
      const amounts = await rows.evaluateAll((els) => els.map((r) => { const c = r.querySelectorAll('td'); return (c[c.length - 1]?.textContent ?? '').trim() }))
      expect(amounts.map((x) => x.replace(/\s/g, '')).sort(), `${where}: tab Theo dược sĩ`).toEqual(byStaff(load))
      await expect(page.locator('main [data-cms-results-error]'), `${where}: tab không hộp lỗi`).toHaveCount(0)
    }
    expect(writes).toEqual([])
  })

  test('T11 / run legacy PG1: cờ mode OFF ⇒ câu T11 nguyên văn, không dòng cách tính; cờ BẬT ⇒ "Tính lẻ — cộng dồn"; A3 không nút Trả hàng', async ({ page }) => {
    await open(page, 'staff', `program=${PG1}&p2=running`)
    const main = page.locator('main [data-testid="ui-catalog-cms-staff"]')
    await expect(main.locator('[data-cms-sales-only="sales_only_v1"]').first()).toHaveText(CMS_SALES_ONLY_NOTE)
    await expect(main.locator('[data-cms-run-basis]')).toHaveCount(0)
    await open(page, 'staff', `program=${PG1}&p2=running&bu=1`)
    await expect(page.locator('main [data-cms-run-basis="pos_base"]').first()).toContainText(CMS_QUANTITY_BASIS_LABEL.pos_base)
    await open(page, 'detail', `program=${PG1}&p2=running`)
    await expect(page.locator('main [data-cms-run-basis]')).toHaveCount(0)
    await expect(page.locator('main [data-cms-returns-link]')).toHaveCount(0)
  })
})

test.describe('CMS bán hàng RC — route thật trang Trả hàng, cờ trả hàng TẮT (server gate) @desktop', () => {
  test.skip(!HAS_SUPER, 'chưa có phiên super')
  test.use({ storageState: SUPER_STATE })
  // Một test, rẽ nhánh theo cờ server (không skip ở lượt nào của runner):
  //   · E2E_CMS_ENABLED=1 (CMS_PROGRAM_ENABLED=true + CMS_EARNINGS_ENABLED=true như prod; mode / import v2 / trả / chốt TẮT) — cấu hình
  //     phát hành bán hàng: chi tiết T11 THẬT vẫn mở và panel kết quả đọc qua reader thật (DB prod chưa có 130 ⇒ reader 122 — bước 1
  //     của thứ tự deploy: app mới + DB cũ): có run (dòng "Số liệu cập nhật"), câu sales-only nguyên văn, không tóm tắt trả, không dòng
  //     "Cách tính" (run legacy + cờ mode tắt); không khẳng định số tiền động. Không nút Trả hàng;
  //     /returns + /returns/<id> của CHÍNH chương trình đó ⇒ 404 ⇒ cổng là cmsReturnsPageEnabled, không phải chương trình không tồn tại.
  //   · cờ CMS tắt — mọi route CMS 404 (ui-v2-cms-admin); ở đây chỉ khẳng định route trả hàng cũng 404.
  // Route có loading.tsx ⇒ HTTP 200 stream trước notFound() (như ui-v2-cms-admin) ⇒ khẳng định bằng UI 404 + không view trả hàng.
  test('trả hàng TẮT ⇒ /returns và /returns/<id> là trang 404, không view trả hàng; cờ CMS bật ⇒ chi tiết T11 + panel kết quả (run, câu sales-only) mở, không nút Trả hàng', async ({ page }) => {
    expect(process.env.CMS_RETURNS_ENABLED ?? '', 'test này chỉ cho cấu hình trả hàng TẮT').not.toBe('true')
    const writes = await trapWrites(page)
    const cmsOn = process.env.E2E_CMS_ENABLED === '1'
    const id = cmsOn ? CMS_127_T11_ID : '00000000-0000-4000-8000-000000000014'
    if (cmsOn) {
      await page.goto(`/targets/campaigns/cms/${id}`)
      expect(process.env.CMS_EARNINGS_ENABLED ?? '', 'lượt cờ CMS bật phải có CMS_EARNINGS_ENABLED=true (panel kết quả)').toBe('true')
      expect(process.env.CMS_CALC_MODES_ENABLED ?? '', 'lượt bán hàng: mode TẮT').not.toBe('true')
      const main = page.locator('main [data-cms-detail]')
      await expect(main, 'đối chứng: chi tiết T11 phải mở khi cờ CMS bật').toBeVisible({ timeout: 30_000 })
      await expect(main.locator('[data-cms-results-error]'), 'reader kết quả lỗi').toHaveCount(0)
      await expect(main.locator('[data-cms-detail-results]'), 'panel kết quả T11 (4 ô)').toBeVisible({ timeout: 30_000 })
      const synced = main.locator('[data-cms-synced]')
      await expect(synced).toHaveAttribute('data-cms-synced', /^(running|waiting_close)$/)
      await expect(synced, 'T11 phải có run đã công bố').toContainText('Số liệu cập nhật')
      await expect(main.locator('[data-cms-sales-only]')).toHaveAttribute('data-cms-sales-only', 'sales_only_v1')
      await expect(main.locator('[data-cms-sales-only]')).toHaveText(CMS_SALES_ONLY_NOTE)
      await expect(main.locator('[data-cms-net-summary]')).toHaveCount(0)
      await expect(main.locator('[data-cms-run-basis]'), 'run legacy + cờ mode tắt ⇒ không dòng Cách tính').toHaveCount(0)
      await expect(main.locator('[data-cms-returns-link]')).toHaveCount(0)
    }
    for (const u of [`/targets/campaigns/cms/${id}/returns`, `/targets/campaigns/cms/${id}/returns/00000000-0000-4000-8000-000000009951`]) {
      await page.goto(u)
      await expect(page.locator('main').getByText('This page could not be found.'), `${u}: phải là trang 404`).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('[data-cms-returns-admin], [data-cms-close-report-detail]'), u).toHaveCount(0)
    }
    test.info().annotations.push({ type: 'nhánh', description: cmsOn ? 'cờ CMS bật (T11 thật)' : 'cờ CMS tắt' })
    expect(writes).toEqual([])
  })
})
