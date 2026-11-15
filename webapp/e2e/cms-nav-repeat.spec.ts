import fs from 'node:fs'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { MANAGER_STATE, STAFF_STATE } from './authState'
import { trapWrites, type TrappedRequest } from './fixtureGuard'
import { NAV_WATCHDOG_MS } from '../lib/nav/watchdog'
import { cmsToKpiSplit, kpiToCmsSplit, navTimeline } from './navRepeatOracle'

// ─────────────────────────────────────────────────────────────────────────────
// NAV-REPEAT-1 (PM 15/11/2026 — planning/reviews/2026-11-15-nav-repeat-1-work-order-pm.md, AC NAVR-01…06; gộp vào CMS-SALES-FINAL):
// trên /targets của dược sĩ / QLCH, KPI → CMS sau một vòng CMS → KPI mềm treo tất định (report RC §16 / §18, có cả trên main
// 0a95570). Mitigation: link "CMS sản phẩm" trên trang KPI là <a> thường (data-cms-nav="document") ⇒ request TÀI LIỆU bắt đầu
// ngay lúc chạm, không transition RSC, không watchdog. Chiều CMS → KPI giữ <Link> + NavWatchdog (điều hướng mềm).
//
// Đây là hợp đồng điều hướng MỚI cho riêng hướng KPI → CMS: một document navigation chủ động là ĐÚNG; không gọi nó là "điều hướng
// mềm đạt". Mọi đo đạc tính từ ngay trước click; "bắt đầu" = thời điểm request document được gửi (không gồm độ trễ server / Supabase).
// Route thật cần server bật CMS_PROGRAM_ENABLED (E2E_CMS_ENABLED=1), chỉ đọc: mọi request ghi của app bị chặn + đếm (trapWrites) = 0.
// NAVR-05 chạy ở lượt server CMS OFF. Map các ca NAV2 cũ: đầu e2e/cms-nav2.spec.ts.
//
// PM 15/11 (work order gộp §8.1–§8.2): NAVR-01/03 PHIÊN BẢN MỚI = ca CHỨC NĂNG 3 vòng, oracle tách URL / nội dung / load
// (e2e/navRepeatOracle.ts). Thay ca cũ "… CMS → KPI mềm" (lịch sử timing giữ FAIL / EXCEPTION trong report, không đổi thành PASS):
// KPI → CMS giữ HARD (một document ≤ 1,5 s, 0 RSC, không document thứ hai tới watchdog + 2 s, nội dung = tải trực tiếp mọi vòng);
// CMS → KPI HARD về chức năng (đúng KPI + nội dung = tải trực tiếp, ≤ 1 tải cứng dự phòng của watchdog, 0 vòng tải lại, 0 ghi),
// THỜI GIAN chiều về là số đo (annotation; ≥ 6 s hoặc có tải cứng dự phòng ⇒ EXCEPTION), không ném sớm. NAVR-02 / 04 / 05 không đổi.
// ─────────────────────────────────────────────────────────────────────────────

const RUN_PROJECT = 'mobile-390'   // viewport do test đặt — một project là đủ (cùng lý do cms-nav2 / nav-watchdog)
const CMS_ON = process.env.E2E_CMS_ENABLED === '1'
const KPI = '/targets'
const CMS = '/targets?tab=cms'
const isCms = (u: URL) => u.pathname === '/targets' && u.searchParams.get('tab') === 'cms'
const isKpi = (u: URL) => u.pathname === '/targets' && !u.searchParams.has('tab')
/** Chạm → request document tới CMS phải BẮT ĐẦU trong mốc này (gồm thời gian Playwright dispatch click; không gồm phản hồi server). */
const DOC_START_MAX = 1_500
/** Cửa sổ kiểm không có document thứ hai sau chạm KPI → CMS (vượt mốc watchdog 6 s + 2 s). */
const QUIET_UNTIL = NAV_WATCHDOG_MS + 2_000
const ROUNDS = 3

type Ev = { t: number; kind: 'doc' | 'rsc' | 'prefetch'; to: 'cms' | 'kpi' }
/** Mọi request tới /targets (KPI) và /targets?tab=cms (CMS) — document / RSC điều hướng / prefetch — mốc ms từ `mark()`. */
function navLog(page: Page) {
  let t0 = 0
  const ev: Ev[] = []
  page.on('request', (r) => {
    if (!t0) return
    const u = new URL(r.url())
    const to = isCms(u) ? 'cms' : isKpi(u) ? 'kpi' : null
    if (!to) return
    const h = r.headers()
    const kind = r.resourceType() === 'document' ? 'doc' : h['rsc'] === '1' ? (h['next-router-prefetch'] === '1' ? 'prefetch' : 'rsc') : null
    if (kind) ev.push({ t: Date.now() - t0, kind, to })
  })
  return {
    /** Đặt gốc thời gian (lần đầu) và trả mốc hiện tại theo gốc đó. */
    mark: () => { if (!t0) t0 = Date.now(); return Date.now() - t0 },
    between: (kind: Ev['kind'], to: Ev['to'], from: number, until = Infinity) => ev.filter((e) => e.kind === kind && e.to === to && e.t >= from && e.t < until).map((e) => e.t - from),
    count: (kind: Ev['kind'], to: Ev['to']) => ev.filter((e) => e.kind === kind && e.to === to).length,
    text: () => ev.map((e) => `${e.t}:${e.kind}>${e.to}`).join(' '),
  }
}
async function segmentReady(page: Page, seg: 'kpi' | 'cms'): Promise<Locator> {
  const nav = page.locator(`main [data-cms-targets-segment="${seg}"]`)
  await expect(nav, `không có segment ${seg}`).toBeVisible({ timeout: 30_000 })
  // Chờ hydrate: chạm trước khi React gắn handler thì <Link> cũng thành tải trang thường — không đo được chiều mềm.
  await page.waitForFunction((s) => { const a = document.querySelector(`main [data-cms-targets-segment="${s}"] a[aria-current="page"]`); return !!a && Object.keys(a).some((k) => k.startsWith('__reactProps')) }, seg, { timeout: 30_000 })
  return nav
}
const cmsLink = (page: Page) => page.locator('main [data-cms-targets-segment="kpi"] a', { hasText: 'CMS sản phẩm' }).first()
const kpiLink = (page: Page) => page.locator('main [data-cms-targets-segment="cms"] a', { hasText: 'KPI chiến dịch' }).first()
async function openKpi(page: Page) {
  await page.goto(KPI)
  await expect(page, 'bị đẩy về /login ⇒ storageState hết hạn').not.toHaveURL(/\/login/)
  await segmentReady(page, 'kpi')
}
/** Dấu hiệu nội dung CMS — so điều hướng document với tải trực tiếp (cùng chương trình / phạm vi / run / số tiền). Đọc sau khi hết
 *  skeleton. `updated` = chữ "Cập nhật <giờ>" của run đang hiện ⇒ lệch do run mới công bố giữa lượt hiện rõ trong thông báo lỗi. */
async function cmsSignature(page: Page) {
  const root = page.locator('main [data-cms-staff]')
  await expect(root).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('main [data-cms-skeleton]'), 'màn CMS còn skeleton').toHaveCount(0, { timeout: 30_000 })
  const attrs = (sel: string, name: string) => page.locator(sel).evaluateAll((els, n) => els.map((e) => e.getAttribute(n) ?? '').join('|'), name)
  const texts = async (sel: string) => (await page.locator(sel).allInnerTexts()).map((t) => t.trim()).join('|')
  return {
    kind: await root.getAttribute('data-cms-staff'),
    results: await root.getAttribute('data-cms-results'),
    program: await texts('main [data-cms-program-label], main [data-cms-program-picker]'),
    heroState: await attrs('main [data-cms-hero]', 'data-cms-hero'),
    hero: await texts('main [data-cms-hero-amount]'),
    storeState: await attrs('main [data-cms-store-hero]', 'data-cms-store-hero'),
    store: await texts('main [data-cms-store-amount]'),
    updated: await texts('main [data-cms-updated]'),
    noRun: await attrs('main [data-cms-no-run]', 'data-cms-no-run'),
    cards: await page.locator('main [data-cms-staff-product]').count(),
    adminLinks: await page.locator('main a[href^="/targets/campaigns/cms"]').count(),
  }
}
type CmsSig = Awaited<ReturnType<typeof cmsSignature>>
/** NAVR-03 — bất biến nội dung một màn CMS dược sĩ / QLCH (không phụ thuộc số liệu prod): không lỗi; có run ⇒ số tiền thật (chữ số + ₫)
 *  kèm dòng cập nhật; không run ⇒ "—" kèm lý do, KHÔNG hiện 0; chương trình đọc được ⇒ có tên + thẻ sản phẩm; không link quản trị CMS;
 *  không nhãn QA / is_test ở tên chương trình / số tiền / dòng cập nhật. Trả danh sách vi phạm (rỗng = đạt). */
function cmsContentProblems(s: CmsSig): string[] {
  const p: string[] = []
  if (s.kind === 'error') p.push('màn CMS báo lỗi (data-cms-staff=error)')
  if (s.results === 'error') p.push('kết quả CMS lỗi (data-cms-results=error)')
  const money = /^-?\d[\d.]*\s?₫$/   // cmsVnd: "31.500₫"; giá trị hỏng ⇒ "—" (bị bắt khi state = ok)
  const heroStates = s.heroState ? s.heroState.split('|') : []
  const heroes = s.hero ? s.hero.split('|') : []
  heroStates.forEach((st, i) => {
    if (st === 'ok' && !money.test(heroes[i] ?? '')) p.push(`hero có run nhưng số tiền "${heroes[i]}" không phải số ₫`)
    if (st === 'none' && heroes[i] !== '—') p.push(`hero không run nhưng hiện "${heroes[i]}" (phải là —, không 0 giả)`)
  })
  if (heroStates.includes('ok') && !s.updated) p.push('hero có run nhưng thiếu dòng cập nhật')
  if (heroStates.includes('none') && !s.noRun) p.push('hero không run nhưng thiếu lý do (data-cms-no-run)')
  if (s.storeState.split('|').includes('ok') && !s.store.split('|').every((t) => money.test(t))) p.push(`số cửa hàng "${s.store}" không phải số ₫`)
  if (s.storeState === 'none' && s.store !== '—') p.push(`số cửa hàng không run nhưng hiện "${s.store}" (phải là —, không 0 giả)`)
  if (s.kind === 'ok' && !s.program) p.push('chương trình đọc được nhưng thiếu tên chương trình')
  if (s.kind === 'ok' && s.cards === 0) p.push('chương trình đọc được nhưng 0 thẻ sản phẩm')
  if (s.adminLinks) p.push(`màn dược sĩ / QLCH có ${s.adminLinks} link quản trị CMS`)
  if (/\b(QA|is_test)\b/i.test(`${s.program}|${s.hero}|${s.store}|${s.updated}`)) p.push('có nhãn QA / is_test trên màn dược sĩ / QLCH')
  return p
}
/** Dấu hiệu màn KPI (NAVR-01/03 mới, chiều về): segment KPI đang chọn + hydrate, hết khung chờ route, không còn màn CMS, số khối KPI
 *  chính. Trang KPI không có Suspense riêng ⇒ có segment + hết khung chờ là đủ nội dung để so với tải trực tiếp. */
async function kpiSignature(page: Page) {
  await segmentReady(page, 'kpi')
  await expect(page.locator('[data-route-loading]'), 'màn KPI còn khung chờ').toHaveCount(0, { timeout: 30_000 })
  return {
    current: (await page.locator('main [data-cms-targets-segment] a[aria-current="page"]').allInnerTexts()).map((t) => t.trim()).join('|'),
    cms: await page.locator('main [data-cms-staff]').count(),
    lists: await page.locator('main [data-campaign-card-list], main [data-campaign-cards]').count(),
    cards: await page.locator('main [data-campaign-card]').count(),
    meters: await page.locator('main [data-kpi-meter]').count(),
  }
}
type KpiSig = Awaited<ReturnType<typeof kpiSignature>>
function kpiContentProblems(k: KpiSig): string[] {
  const p: string[] = []
  if (k.current !== 'KPI chiến dịch') p.push(`segment đang chọn "${k.current}" (phải là KPI chiến dịch)`)
  if (k.cms) p.push('màn KPI còn nội dung CMS (data-cms-staff)')
  return p
}
/** Mở trang bằng goto chỉ chờ commit (không chờ load — PM §8.2), loại /login. */
async function gotoCommit(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'commit' })
  expect(new URL(page.url()).pathname, 'bị đẩy về /login ⇒ storageState hết hạn').not.toBe('/login')
}
function noWrites(seen: TrappedRequest[]) {
  expect(seen, 'request ghi của app trong luồng điều hướng chỉ đọc').toEqual([])
}
/** Không tràn ngang ở viewport hiện tại. */
async function noOverflow(page: Page, where: string) {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
  expect(o.sw, `${where}: tràn ngang (scrollWidth ${o.sw} > ${o.cw})`).toBeLessThanOrEqual(o.cw)
}

/**
 * Kiểm một lần chạm KPI → CMS theo hợp đồng document (NAVR-01 / 02): đúng MỘT document tới CMS, bắt đầu ≤ DOC_START_MAX sau chạm,
 * 0 RSC điều hướng tới CMS, tới đúng URL + nội dung, không document thứ hai tới hết QUIET_UNTIL. Trả số đo; vi phạm ⇒ danh sách lỗi
 * (không ném) để ca điều khiển dùng lại đúng hàm này.
 */
async function kpiToCms(page: Page, log: ReturnType<typeof navLog>, click: () => Promise<void>, opts: { settle?: boolean } = {}) {
  const at = log.mark()
  await click()
  const problems: string[] = []
  let url = -1
  try {
    await expect(page).toHaveURL((u) => isCms(u), { timeout: opts.settle === false ? DOC_START_MAX + 500 : 20_000 })
    url = log.mark() - at
  } catch { problems.push('không tới CMS') }
  if (url >= 0 && opts.settle !== false) await expect(page.locator('main [data-cms-staff]'), 'không hiện nội dung CMS').toBeVisible({ timeout: 30_000 })
  if (opts.settle !== false) await page.waitForTimeout(Math.max(0, QUIET_UNTIL - (log.mark() - at)))
  const docs = log.between('doc', 'cms', at)
  const rsc = log.between('rsc', 'cms', at)
  if (docs.length === 0) problems.push(`không có request document tới CMS trong ${log.mark() - at} ms`)
  else if (docs[0] > DOC_START_MAX) problems.push(`document bắt đầu muộn +${docs[0]} ms (> ${DOC_START_MAX})`)
  if (docs.length > 1) problems.push(`document thứ hai tới CMS (${docs.join(', ')} ms)`)
  if (rsc.length) problems.push(`có RSC điều hướng tới CMS (${rsc.join(', ')} ms) — vẫn đi transition mềm`)
  return { docStart: docs[0] ?? null, docs: docs.length, url, problems }
}

const COMBOS = [
  { who: 'staff', state: STAFF_STATE, vw: { width: 360, height: 800 } },
  { who: 'staff', state: STAFF_STATE, vw: { width: 390, height: 844 } },
  { who: 'QLCH', state: MANAGER_STATE, vw: { width: 360, height: 800 } },
  { who: 'QLCH', state: MANAGER_STATE, vw: { width: 390, height: 844 } },
] as const

for (const c of COMBOS) {
  test.describe(`NAV-REPEAT-1 — ${c.who} @${c.vw.width} @mobile`, () => {
    test.use({ storageState: c.state, viewport: c.vw, isMobile: true, hasTouch: true })
    test.skip(!CMS_ON, 'server chưa bật CMS_PROGRAM_ENABLED (E2E_CMS_ENABLED=1)')
    test.skip(!fs.existsSync(c.state), `chưa có phiên ${c.who}`)
    test.beforeEach(async ({}, testInfo) => {
      testInfo.skip(testInfo.project.name !== RUN_PROJECT, `chỉ chạy dưới project ${RUN_PROJECT}`)
      testInfo.setTimeout(300_000)
    })

    test(`NAVR-01/03 chức năng ${c.who} @${c.vw.width}: ${ROUNDS} vòng — KPI → CMS một document chủ động + URL + nội dung = tải trực tiếp; CMS → KPI đúng KPI + nội dung, ≤ 1 tải cứng dự phòng, thời gian chiều về là số đo`, async ({ page }, testInfo) => {
      const seen = await trapWrites(page)
      const log = navTimeline(page)
      await gotoCommit(page, KPI)
      await segmentReady(page, 'kpi')
      log.mark()
      const out: string[] = []
      const exc: string[] = []
      const viaDoc: CmsSig[] = []
      const viaBack: KpiSig[] = []
      let fallbackTotal = 0
      try {
        for (let i = 1; i <= ROUNDS; i++) {
          const r = await kpiToCmsSplit(page, log, () => cmsLink(page).click(),
            async () => { const s = await cmsSignature(page); viaDoc.push(s); return cmsContentProblems(s) },
            { urlBudgetMs: 20_000, docStartMax: DOC_START_MAX, quietUntil: QUIET_UNTIL })
          expect(r.problems, `vòng ${i} KPI → CMS · ${log.text()}`).toEqual([])
          await noOverflow(page, `vòng ${i} CMS`)
          await segmentReady(page, 'cms')
          const b = await cmsToKpiSplit(page, log, () => kpiLink(page).click(),
            async () => { const k = await kpiSignature(page); viaBack.push(k); return kpiContentProblems(k) },
            { urlBudgetMs: NAV_WATCHDOG_MS + 10_000, watchdogMs: NAV_WATCHDOG_MS, maxFallback: 1 })
          expect(b.problems, `vòng ${i} CMS → KPI · ${log.text()}`).toEqual([])
          fallbackTotal += b.fallbacks.length
          if (!b.timing.startsWith('mềm')) exc.push(`v${i} ${b.timing}`)
          out.push(`v${i}: KPI→CMS doc +${r.docStart} · URL +${r.url} · nội dung +${r.ready} · load ${r.load ?? 'chưa'} ms | CMS→KPI URL +${b.url} · nội dung +${b.ready} · load ${b.load ?? '—'} ms · ${b.timing}`)
        }
      } finally {
        testInfo.annotations.push({ type: 'nav-repeat-1 chức năng (mốc)', description: `${c.who} @${c.vw.width} · ${out.join(' · ') || 'chưa xong vòng nào'} · timeline ${log.text()}` })
        testInfo.annotations.push({ type: 'nav-repeat-1 thời gian chiều về', description: `${c.who} @${c.vw.width} · ${exc.length ? exc.join(' · ') : out.length === ROUNDS ? `mọi vòng mềm < ${NAV_WATCHDOG_MS} ms` : 'chưa đủ vòng'}` })
      }
      // Toàn lượt: đúng ROUNDS document tới CMS, 0 RSC điều hướng tới CMS; tải cứng về KPI chỉ là các lần dự phòng đã ghi ở từng vòng.
      await page.waitForTimeout(1_500)
      expect(log.count('doc', 'cms'), `số document tới CMS · ${log.text()}`).toBe(ROUNDS)
      expect(log.count('rsc', 'cms'), `có RSC điều hướng tới CMS · ${log.text()}`).toBe(0)
      expect(log.count('doc', 'kpi'), `tải cứng về KPI ngoài các lần dự phòng đã ghi (${fallbackTotal}) · ${log.text()}`).toBe(fallbackTotal)
      // NAVR-03: nội dung CMS sau document navigation ở MỌI vòng = tải trực tiếp (cùng chương trình / phạm vi / run / số tiền) + bất biến
      // nội dung; chiều về: màn KPI ở MỌI vòng = tải trực tiếp KPI. goto chỉ chờ commit, nội dung kiểm bằng chữ ký.
      await gotoCommit(page, CMS)
      const direct = await cmsSignature(page)
      expect(cmsContentProblems(direct), `tải trực tiếp CMS · ${JSON.stringify(direct)}`).toEqual([])
      expect(viaDoc.length, 'số màn CMS đã kiểm').toBe(ROUNDS)
      viaDoc.forEach((v, k) => {
        expect(cmsContentProblems(v), `vòng ${k + 1} qua segment · ${JSON.stringify(v)}`).toEqual([])
        expect(v, `vòng ${k + 1}: màn CMS qua segment khác tải trực tiếp`).toEqual(direct)
      })
      await gotoCommit(page, KPI)
      const kpiDirect = await kpiSignature(page)
      expect(kpiContentProblems(kpiDirect), `tải trực tiếp KPI · ${JSON.stringify(kpiDirect)}`).toEqual([])
      expect(viaBack.length, 'số màn KPI chiều về đã kiểm').toBe(ROUNDS)
      viaBack.forEach((v, k) => expect(v, `vòng ${k + 1}: màn KPI chiều về khác tải trực tiếp`).toEqual(kpiDirect))
      testInfo.annotations.push({ type: 'nav-repeat-1-content', description: `${c.who} @${c.vw.width} · kind=${direct.kind} results=${direct.results} hero=${direct.heroState} store=${direct.storeState} cards=${direct.cards} noRun=${direct.noRun} · KPI ${JSON.stringify(kpiDirect)}` })
      noWrites(seen)
    })
  })
}

for (const role of [{ who: 'staff', state: STAFF_STATE, vw: { width: 390, height: 844 } }, { who: 'QLCH', state: MANAGER_STATE, vw: { width: 360, height: 800 } }] as const) {
  test.describe(`NAV-REPEAT-1 — UX ${role.who} @${role.vw.width} @mobile`, () => {
    test.use({ storageState: role.state, viewport: role.vw, isMobile: true, hasTouch: true })
    test.skip(!CMS_ON, 'server chưa bật CMS_PROGRAM_ENABLED (E2E_CMS_ENABLED=1)')
    test.skip(!fs.existsSync(role.state), `chưa có phiên ${role.who}`)
    test.beforeEach(async ({}, testInfo) => {
      testInfo.skip(testInfo.project.name !== RUN_PROJECT, `chỉ chạy dưới project ${RUN_PROJECT}`)
      testInfo.setTimeout(180_000)
    })

    test(`NAVR-04 ${role.who}: href / nhãn / thứ tự / aria-current giữ; chỉ link CMS trên trang KPI là document; chạm ≥ 44 px; không tràn`, async ({ page }) => {
      const seen = await trapWrites(page)
      for (const [from, seg] of [[KPI, 'kpi'], [CMS, 'cms']] as const) {
        await page.goto(from)
        const nav = await segmentReady(page, seg)
        const links = nav.locator('a')
        await expect(links).toHaveCount(2)
        expect(await links.evaluateAll((as) => as.map((a) => ({ href: a.getAttribute('href'), text: a.textContent, cur: a.getAttribute('aria-current'), doc: a.getAttribute('data-cms-nav') }))), `${from}: thuộc tính segment`)
          .toEqual([
            { href: '/targets', text: 'KPI chiến dịch', cur: seg === 'kpi' ? 'page' : null, doc: null },
            { href: '/targets?tab=cms', text: 'CMS sản phẩm', cur: seg === 'cms' ? 'page' : null, doc: seg === 'kpi' ? 'document' : null },
          ])
        for (const box of await links.evaluateAll((as) => as.map((a) => a.getBoundingClientRect().height))) {
          expect(box, `${from}: vùng chạm segment < 44 px`).toBeGreaterThanOrEqual(44)
        }
        await noOverflow(page, from)
      }
      noWrites(seen)
    })

    test(`NAVR-04 ${role.who}: bàn phím Enter ⇒ một document; Back về KPI / Forward về CMS dùng được`, async ({ page }) => {
      const seen = await trapWrites(page)
      const log = navLog(page)
      await openKpi(page)
      const r = await kpiToCms(page, log, async () => { await cmsLink(page).focus(); await page.keyboard.press('Enter') })
      expect(r.problems, `Enter · ${log.text()}`).toEqual([])
      await page.goBack()
      await expect(page).toHaveURL((u) => isKpi(u), { timeout: 15_000 })
      await segmentReady(page, 'kpi')
      await page.goForward()
      await expect(page).toHaveURL((u) => isCms(u), { timeout: 15_000 })
      await expect(page.locator('main [data-cms-staff]')).toBeVisible({ timeout: 30_000 })
      await page.waitForTimeout(1_500)
      expect(log.count('rsc', 'cms'), `có RSC điều hướng tới CMS · ${log.text()}`).toBe(0)
      noWrites(seen)
    })

    // Phím bổ trợ là thao tác con trỏ / bàn phím (máy tính hoặc tablet có chuột) ⇒ context riêng isMobile:false cùng bề rộng:
    // mô phỏng mobile của Chromium không mở tab mới khi Ctrl-click.
    test(`NAVR-04 ${role.who}: Ctrl-click ⇒ CMS mở tab mới, tab gốc ở lại KPI, không tải tài liệu`, async ({ browser }, testInfo) => {
      const ctx = await browser.newContext({ storageState: role.state, viewport: role.vw, baseURL: testInfo.project.use.baseURL })
      try {
        const page = await ctx.newPage()
        const seen = await trapWrites(page)
        const log = navLog(page)
        await openKpi(page)
        const at = log.mark()
        const popup = ctx.waitForEvent('page', { timeout: 15_000 })
        await cmsLink(page).click({ modifiers: ['Control'] })
        const p2 = await popup
        await expect(p2).toHaveURL((u) => isCms(u), { timeout: 20_000 })
        await p2.close()
        await page.waitForTimeout(QUIET_UNTIL)
        expect(log.between('doc', 'cms', at), 'tab gốc tải tài liệu CMS').toEqual([])
        expect(log.between('rsc', 'cms', at), 'tab gốc đi transition CMS').toEqual([])
        await expect(page).toHaveURL((u) => isKpi(u))
        noWrites(seen)
      } finally {
        await ctx.close()
      }
    })

    for (const theme of ['light', 'dark'] as const) {
      test(`NAVR-04 ${role.who} theme ${theme}: tab đang chọn nền action, tab còn lại không nền; chạm KPI → CMS vẫn một document`, async ({ page }, testInfo) => {
        const seen = await trapWrites(page)
        await page.addInitScript((t) => { try { localStorage.setItem('theme', t) } catch { /* bỏ qua */ } }, theme)
        const log = navLog(page)
        await openKpi(page)
        await page.waitForFunction((t) => document.documentElement.classList.contains('dark') === (t === 'dark'), theme, { timeout: 10_000 })
        const colors = async (seg: 'kpi' | 'cms') => page.locator(`main [data-cms-targets-segment="${seg}"] a`).evaluateAll((as) =>
          as.map((a) => { const s = getComputedStyle(a); return { cur: a.getAttribute('aria-current'), bg: s.backgroundColor, fg: s.color } }))
        const check = (cs: { cur: string | null; bg: string; fg: string }[], where: string) => {
          const on = cs.find((x) => x.cur === 'page')!
          const off = cs.find((x) => x.cur !== 'page')!
          expect(on.bg, `${where}: tab đang chọn không có nền`).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
          expect(on.fg, `${where}: chữ trùng nền`).not.toBe(on.bg)
          expect(off.bg, `${where}: tab còn lại có nền`).toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
        }
        check(await colors('kpi'), `KPI ${theme}`)
        await page.locator('main [data-cms-targets-segment="kpi"]').screenshot({ path: testInfo.outputPath(`navr-seg-kpi-${role.who}-${theme}.png`) })
        const r = await kpiToCms(page, log, () => cmsLink(page).click())
        expect(r.problems, `${theme} · ${log.text()}`).toEqual([])
        await segmentReady(page, 'cms')
        expect(await page.evaluate(() => document.documentElement.classList.contains('dark')), 'document mới mất theme').toBe(theme === 'dark')
        check(await colors('cms'), `CMS ${theme}`)
        await page.locator('main [data-cms-targets-segment="cms"]').screenshot({ path: testInfo.outputPath(`navr-seg-cms-${role.who}-${theme}.png`) })
        noWrites(seen)
      })
    }
  })
}

test.describe('NAV-REPEAT-1 — ca điều khiển NAVR-02 (staff) @mobile', () => {
  test.use({ storageState: STAFF_STATE, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  test.skip(!CMS_ON, 'server chưa bật CMS_PROGRAM_ENABLED (E2E_CMS_ENABLED=1)')
  test.skip(!fs.existsSync(STAFF_STATE), 'chưa có phiên staff')
  test.beforeEach(async ({}, testInfo) => {
    testInfo.skip(testInfo.project.name !== RUN_PROJECT, `chỉ chạy dưới project ${RUN_PROJECT}`)
    testInfo.setTimeout(120_000)
  })

  // Chứng minh kiểm "bắt đầu ngay" không xanh vô điều kiện: init script chặn chạm link document rồi tự điều hướng sau đúng mốc
  // watchdog (giả lập bản lỗi chờ 6 s). Cùng hàm kpiToCms phải báo lỗi "document bắt đầu muộn / không có document"; không ghi app.
  test('NAVR-02 điều khiển: bản cố tình chờ 6 s rồi mới điều hướng ⇒ hàm kiểm báo lỗi bắt đầu muộn', async ({ page }) => {
    const seen = await trapWrites(page)
    await page.addInitScript((ms) => {
      document.addEventListener('click', (e) => {
        const a = (e.target as Element | null)?.closest?.('a[data-cms-nav="document"]') as HTMLAnchorElement | null
        if (!a) return
        e.preventDefault()
        e.stopImmediatePropagation()
        setTimeout(() => window.location.assign(a.href), ms)
      }, true)
    }, NAV_WATCHDOG_MS)
    const log = navLog(page)
    await openKpi(page)
    const r = await kpiToCms(page, log, () => cmsLink(page).click(), { settle: false })
    expect(r.problems.join(' | '), 'ca điều khiển phải bị hàm kiểm bắt').toMatch(/không tới CMS|không có request document|bắt đầu muộn/)
    expect(r.docStart === null || r.docStart > DOC_START_MAX, 'ca điều khiển mà document vẫn bắt đầu sớm').toBe(true)
    await page.goto('about:blank')   // rời trang trước khi timer giả lập chạy — không tải CMS
    noWrites(seen)
  })
})

// NAVR-05: server CMS OFF (lượt A của runner — chỉ project desktop-chromium ⇒ tag @desktop; viewport mobile đặt bằng test.use) —
// /targets không có segment / link CMS, không thêm entry so với hành vi cũ.
test.describe('NAV-REPEAT-1 — cờ CMS OFF @desktop', () => {
  test.skip(CMS_ON, 'chỉ chạy khi server tắt CMS_PROGRAM_ENABLED')
  for (const role of [{ who: 'staff', state: STAFF_STATE }, { who: 'QLCH', state: MANAGER_STATE }] as const) {
    test.describe(role.who, () => {
      test.use({ storageState: role.state, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
      test.skip(!fs.existsSync(role.state), `chưa có phiên ${role.who}`)
      test(`NAVR-05 ${role.who}: cờ OFF ⇒ /targets không segment, không link /targets?tab=cms`, async ({ page }) => {
        const seen = await trapWrites(page)
        await page.goto(KPI)
        await expect(page, 'bị đẩy về /login ⇒ storageState hết hạn').not.toHaveURL(/\/login/)
        await expect(page.locator('main')).toBeVisible({ timeout: 30_000 })
        await page.waitForLoadState('networkidle').catch(() => {})
        await expect(page.locator('[data-cms-targets-segment]')).toHaveCount(0)
        await expect(page.locator('a[href="/targets?tab=cms"]')).toHaveCount(0)
        await expect(page.locator('a[data-cms-nav]')).toHaveCount(0)
        noWrites(seen)
      })
    })
  }
})
