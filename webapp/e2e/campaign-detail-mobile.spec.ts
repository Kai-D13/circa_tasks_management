import { test, expect, type Page } from '@playwright/test'
import { MANAGER_STATE, STAFF_STATE } from './authState'
import { must, sessionDb } from './dbFixtures'

// ─────────────────────────────────────────────────────────────────────────────
// CAMPAIGN DETAIL MOBILE (Step 4) — hợp đồng RUNTIME
//
// Hero trước đây vẽ ĐỒNG THỜI ring, thanh tiến độ và số phần trăm — ba lần cùng
// một tỉ lệ, riêng ring ăn ~92px bề ngang ở màn 360px. Dưới `md` giờ chỉ còn
// một thanh + một con số; từ `md` trở lên giữ nguyên ring đã duyệt.
//
// Khối chart dùng khung tỉ lệ cố định (aspect 360/170) nên chart, empty và error
// chiếm y hệt một chiều cao — đổi chuỗi hay mất dữ liệu không làm phần dưới nhảy.
//
// ── VIEWPORT LÀ CỦA TEST, KHÔNG PHẢI CỦA PROJECT ────────────────────────────
// Bản đầu đặt cứng `viewport: 360×800` trong một describe duy nhất, nên project
// `mobile-390` cũng chạy ở 360 — bằng chứng ghi "360/390" là SAI. Giờ mỗi bề
// ngang là một describe riêng với `test.use` của chính nó, và chạy đủ ba mốc
// máy staff đang dùng: 360 · 390 · 430.
//
// Suite chạy cho CẢ Staff và QLCH: hai vai trò đi hai nhánh render khác nhau
// (targets/page.tsx:616 vs :747) nhưng dùng chung CampaignKpiView.
//
// PHỤ THUỘC DỮ LIỆU: cửa hàng phải có ít nhất một chiến dịch đang chạy. CHỈ skip khi
// RLS (phiên của chính vai trò) xác nhận 0 chiến dịch; có chiến dịch mà trang không
// hiện thẻ ⇒ FAIL (PM CT-R1-01: trang trả [] cả khi truy vấn lỗi).
// ─────────────────────────────────────────────────────────────────────────────

const STAFF = { email: process.env.E2E_STAFF_EMAIL, password: process.env.E2E_STAFF_PASSWORD }
const QLCH = { email: process.env.E2E_QLCH_EMAIL, password: process.env.E2E_QLCH_PASSWORD }

const RING = 'svg circle[stroke-dasharray]'   // vòng tròn tiến độ của hero
const HERO_BAR = '[data-hero-progress]'
// Commit 5: Chất lượng bán hàng KHÔNG dùng hero điểm gộp nữa — thay bằng HAI
// chỉ số độc lập, mỗi cái một thanh riêng. Test hero vì thế phải hỏi LOẠI
// chiến dịch trước khi đếm thanh; hỏi bằng nhãn loại trên chính trang.
const METRIC_BAR = '[data-metric-progress]'
async function isOrderAovDetail(page: Page): Promise<boolean> {
  return (await page.locator('main').innerText()).includes('Chất lượng bán hàng')
}
const CHART_FRAME = '[data-chart-frame]'

// Ba bề ngang thật của máy staff (cùng bộ với ui-mobile-baseline).
// Viewport do TEST đặt, nên chạy dưới hai project mobile là làm y hệt một việc
// hai lần. Mỗi lần render /targets là một loạt query xuống DB thật ⇒ nhân đôi
// tải và đã làm cả suite vượt timeout 60s. Chốt một project, đúng pattern
// CAPTURE_PROJECT của ui-mobile-baseline.
const RUN_PROJECT = 'mobile-390'

const VIEWPORTS = [
  { w: 360, h: 800 },
  { w: 390, h: 844 },
  { w: 430, h: 932 },
] as const

async function gotoTargets(page: Page) {
  await page.goto('/targets')
  await expect(page, 'bị đẩy về /login ⇒ storageState hết hạn (xoá e2e/.auth rồi chạy lại)')
    .toHaveURL(/\/targets(\?|$)/)
}

// ── Chiến dịch có/không: precondition ĐỘC LẬP, không suy từ việc trang render (PM CT-R1-01, 14/10) ─────────
// /targets trả danh sách rỗng cả khi truy vấn chiến dịch LỖI (fetchCampaignViews log rồi trả []), nên "không thấy
// thẻ" KHÔNG chứng minh store 0 chiến dịch. Hỏi thẳng RLS bằng phiên của chính vai trò, cùng truy vấn với trang.
// Lỗi đăng nhập/truy vấn ⇒ ném (test FAIL), không bao giờ coi là 0. Nhớ theo email trong một worker.
type Creds = { email?: string; password?: string }
const rlsCampaignMemo = new Map<string, Promise<{ metricType: string | null }[]>>()
type RlsClient = Pick<Awaited<ReturnType<typeof sessionDb>>, 'auth' | 'from'>
const NO_STORE_ERROR = 'kiểm RLS: tài khoản vai trò không gắn cửa hàng (users.store_id rỗng) — hành trình campaign không áp dụng; kiểm cấu hình tài khoản E2E'
/**
 * Chiến dịch vai trò thấy qua RLS. `[]` CHỈ khi truy vấn kpi_campaign_store_targets THÀNH CÔNG và 0 dòng. Thiếu
 * store (PM CT-R1.1-01: trước đây trả [] mà chưa truy vấn ⇒ skip nhầm "RLS xác nhận 0") hoặc lỗi bất kỳ ⇒ ném.
 */
async function campaignsVisibleTo(sb: RlsClient): Promise<{ metricType: string | null }[]> {
  const { data: { user }, error } = await sb.auth.getUser()
  if (error || !user) throw new Error('kiểm RLS: không đọc được user của phiên đăng nhập')
  const me = must(await sb.from('users').select('store_id').eq('id', user.id).single(), 'users (tự đọc)') as { store_id: string | null }
  if (!me.store_id) throw new Error(NO_STORE_ERROR)
  const rows = must(await sb.from('kpi_campaign_store_targets').select('campaign:kpi_campaigns!inner(id, metric_type)')
    .eq('store_id', me.store_id).is('campaign.archived_at', null), 'kpi_campaign_store_targets (RLS vai trò)')
  return (rows as unknown as { campaign: { metric_type?: string | null } }[]).map((r) => ({ metricType: r.campaign.metric_type ?? null }))
}
async function queryRlsCampaigns(creds: Creds): Promise<{ metricType: string | null }[]> {
  return campaignsVisibleTo(await sessionDb(creds.email!, creds.password!))
}
function rlsCampaigns(creds: Creds): Promise<{ metricType: string | null }[]> {
  const key = creds.email ?? ''
  if (!rlsCampaignMemo.has(key)) rlsCampaignMemo.set(key, queryRlsCampaigns(creds).catch((e) => { rlsCampaignMemo.delete(key); throw e }))
  return rlsCampaignMemo.get(key)!
}
const rlsCampaignCount = async (creds: Creds) => (await rlsCampaigns(creds)).length
const NO_CAMPAIGN = 'store của tài khoản không có chiến dịch đang chạy (RLS xác nhận 0 dòng kpi_campaign_store_targets)'

/**
 * Chờ THẺ chiến dịch trên landing /targets (tải lại tối đa `attempts` lần). Chỉ gọi khi RLS đã thấy ≥ 1 chiến dịch
 * ⇒ không thấy thẻ (trễ quá hạn / trang rỗng vì lỗi tải) là LỖI: ném kèm URL + trạng thái UI an toàn, không PII.
 * Landing /targets luôn là danh sách khi có chiến dịch (targets/page.tsx: showCampaignList), kể cả MỘT chiến dịch.
 */
async function waitCampaignCards(page: Page, n: number, { attempts = 3, waitMs = 15_000 } = {}) {
  const first = page.locator('main a[href*="campaign="]').first()
  for (let i = 0; i < attempts; i++) {
    await gotoTargets(page)
    if (await first.waitFor({ state: 'attached', timeout: waitMs }).then(() => true, () => false)) return first
  }
  const u = new URL(page.url())
  const back = await page.getByRole('link', { name: /Danh sách chiến dịch/ }).count()
  throw new Error(`/targets không hiện thẻ chiến dịch sau ${attempts} lần tải (${waitMs / 1000} s/lần) dù RLS thấy ${n} chiến dịch — `
    + `URL ${u.pathname}${u.search}, link "Danh sách chiến dịch": ${back}`)
}

// ĐẾN được trang chi tiết — dùng cho các test KHÔNG nhằm kiểm cú bấm.
// Đi thẳng bằng goto thay vì click: card nằm trong vùng cuộn, bottom nav nổi
// che mép dưới, và layout còn xê dịch sau khi cuộn ⇒ cú click trong phần SETUP
// từng đỏ ngẫu nhiên ở một viewport khác nhau mỗi lượt. Href vẫn được đọc từ
// DOM thật nên vẫn khoá được "card trỏ đúng ?campaign=".
// Trả LÝ DO skip (chỉ khi RLS xác nhận 0 chiến dịch); null = đã vào detail.
async function openFirstCampaign(page: Page, creds: Creds): Promise<string | null> {
  const n = await rlsCampaignCount(creds)
  if (n === 0) return NO_CAMPAIGN
  const first = await waitCampaignCards(page, n)
  const href = await first.getAttribute('href')
  expect(href, 'card chiến dịch thiếu href').toBeTruthy()
  await page.goto(href!)
  await expect(page).toHaveURL(/[?&]campaign=/, { timeout: 20_000 })
  return null
}

// BẤM THẬT vào card — chỉ dùng cho test hành trình list → detail. Cuộn vào GIỮA
// màn (scrollIntoViewIfNeeded đưa phần tử vào ở mức tối thiểu, tức sát mép dưới
// đúng chỗ bottom nav nổi chiếm) rồi đợi layout đứng yên trước khi bấm.
// Trả LÝ DO skip (chỉ khi RLS xác nhận 0 chiến dịch); null = đã bấm sang detail.
async function clickFirstCampaign(page: Page, creds: Creds, opts?: { attempts?: number; waitMs?: number }): Promise<string | null> {
  const n = await rlsCampaignCount(creds)
  if (n === 0) return NO_CAMPAIGN
  const first = await waitCampaignCards(page, n, opts)
  // Cả cụm cuộn → bấm → điều hướng được RETRY như một khối (idiom sẵn có ở
  // ui-catalog.spec cho login): cú bấm đầu thỉnh thoảng rơi vào lúc layout còn
  // xê dịch nên không điều hướng. Bấm lại là xong; điều đang kiểm là "card dẫn
  // sang detail được", không phải "trúng ngay phát đầu".
  await expect(async () => {
    await first.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    await expect(first).toBeVisible()
    await first.click()
    await expect(page).toHaveURL(/[?&]campaign=/, { timeout: 10_000 })
  }).toPass({ timeout: 45_000, intervals: [1_000, 2_000, 3_000] })
  return null
}

// Tìm chiến dịch CHẤT LƯỢNG BÁN HÀNG (loại duy nhất có segmented Số đơn/AOV).
// Skip TƯỜNG MINH chỉ khi RLS xác nhận store không có loại này (PM CT-R1-01 — trước đây đọc thẻ NGAY sau goto,
// rỗng/chưa hiện ⇒ skip). RLS thấy loại này mà không trang chi tiết nào có tab AOV ⇒ FAIL.
async function openOrderAovCampaign(page: Page, creds: Creds): Promise<{ url: string } | { skip: string }> {
  const all = await rlsCampaigns(creds)
  const aov = all.filter((c) => c.metricType === 'offline_order_aov').length
  if (aov === 0) return { skip: 'store không có chiến dịch Chất lượng bán hàng (RLS xác nhận 0 chiến dịch offline_order_aov)' }
  await waitCampaignCards(page, all.length)
  const hrefs = await page.locator('main a[href*="campaign="]')
    .evaluateAll((els) => els.map((el) => (el as HTMLAnchorElement).getAttribute('href')!))
  for (const href of hrefs) {
    await page.goto(href)
    // Trang chi tiết dựng xong (link quay lại danh sách) rồi mới hỏi tab AOV.
    await expect(page.getByRole('link', { name: /Danh sách chiến dịch/ }).first()).toBeAttached({ timeout: 20_000 })
    if (await page.getByRole('tab', { name: 'AOV' }).count() > 0) return { url: page.url() }
  }
  throw new Error(`RLS thấy ${aov} chiến dịch Chất lượng bán hàng nhưng không trang chi tiết nào trong ${hrefs.length} thẻ có tab AOV`)
}

async function noHorizontalOverflow(page: Page, where: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow, `${where}: trang cuộn ngang ${overflow}px`).toBeLessThanOrEqual(1)
}

function mobileSuite(label: string, state: string, creds: { email?: string; password?: string }) {
  for (const vp of VIEWPORTS) {
    test.describe(`campaign detail ${label} ${vp.w} @mobile`, () => {
      test.use({ storageState: state, viewport: { width: vp.w, height: vp.h } })
      test.skip(!creds.email || !creds.password, `credential ${label} chưa set`)

      test.beforeEach(async ({}, testInfo) => {
        testInfo.skip(testInfo.project.name !== RUN_PROJECT, `chỉ chạy dưới project ${RUN_PROJECT}`)
        // Trang detail render phía server + đọc DB thật; 60s mặc định là chật
        // khi chạy tuần tự 2 vai trò × 3 viewport.
        testInfo.setTimeout(120_000)
      })

      test(`hero: ring ẨN, đúng MỘT thanh tiến độ @${vp.w}`, async ({ page }) => {
        const why = await openFirstCampaign(page, creds)
        test.skip(why !== null, why ?? '')

        // Ring vẫn nằm trong DOM (ẩn bằng md:block) nhưng KHÔNG được nhìn thấy —
        // đó mới là thứ chiếm chỗ trên màn hẹp.
        const ring = page.locator(RING).first()
        if (await ring.count() > 0) await expect(ring, `@${vp.w}: ring vẫn hiện trên mobile`).toBeHidden()

        if (await isOrderAovDetail(page)) {
          // Loại này KHÔNG có hero điểm gộp: đúng hai thanh, mỗi chỉ số một cái.
          await expect(page.locator(HERO_BAR), 'Chất lượng bán hàng không được có hero điểm gộp').toHaveCount(0)
          await expect(page.locator(METRIC_BAR), 'phải có ĐÚNG hai thanh: Số đơn và AOV').toHaveCount(2)
        } else {
          await expect(page.locator(HERO_BAR), 'phải có ĐÚNG một thanh tiến độ ở hero').toHaveCount(1)
        }
        await noHorizontalOverflow(page, `hero @${vp.w}`)
      })

      test(`nội dung cuối không bị bottom nav che @${vp.w}`, async ({ page }) => {
        const why = await openFirstCampaign(page, creds)
        test.skip(why !== null, why ?? '')
        await noHorizontalOverflow(page, `detail @${vp.w}`)

        await page.evaluate(() => {
          const main = document.querySelector('main')
          if (main) main.scrollTop = main.scrollHeight
        })
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

        const geom = await page.evaluate((zoneSel) => {
          const main = document.querySelector('main')
          const zone = document.querySelector(zoneSel)
          if (!main || !zone) return null
          const last = [...main.children].filter((el) => el.getBoundingClientRect().height > 0).pop()
          if (!last) return null
          return { lastBottom: last.getBoundingClientRect().bottom, zoneTop: zone.getBoundingClientRect().top }
        }, '[data-nav-center-zone]')

        if (geom) {
          expect(geom.lastBottom, `@${vp.w}: phần tử cuối bị vùng nút giữa của bottom nav che`)
            .toBeLessThanOrEqual(geom.zoneTop)
        }
      })

      // Hành trình THẬT: bấm card ở danh sách → detail → back về danh sách.
      test(`list → detail → back @${vp.w}`, async ({ page }) => {
        const why = await clickFirstCampaign(page, creds)
        test.skip(why !== null, why ?? '')
        await page.getByRole('link', { name: /Danh sách chiến dịch/ }).click()
        // Cùng lý do với openFirstCampaign: điều hướng là server-render, chạy
        // tuần tự 2 vai trò × 3 viewport thì vượt ngưỡng mặc định 5s. Đã đỏ một
        // lần ở đúng 390 chỉ vì lượt đó chậm hơn, không phải vì bề ngang.
        await expect(page).not.toHaveURL(/[?&]campaign=/, { timeout: 20_000 })
      })

      // TÁCH RIÊNG (audit P2): trước đây phần này nằm trong `if (aov.count() > 0)`
      // nên campaign không phải Chất lượng bán hàng thì toàn bộ contract
      // `series=aov` + chiều cao chart bị bỏ qua mà test vẫn báo PASS.
      // Giờ nếu store không có loại đó thì SKIP tường minh, đọc report thấy ngay.
      test(`Order/AOV: đổi series giữ campaign, chart không đổi chiều cao @${vp.w}`, async ({ page }) => {
        const aov = await openOrderAovCampaign(page, creds)
        test.skip('skip' in aov, 'skip' in aov ? aov.skip : '')
        const url = 'url' in aov ? aov.url : ''

        const campaignId = new URL(url!).searchParams.get('campaign')
        // Đo KHUNG chart chứ không đo svg: khung mới là thứ giữ chỗ cho cả
        // trạng thái rỗng/lỗi, và cũng là thứ quyết định phần dưới có nhảy không.
        const before = await page.locator(CHART_FRAME).first().boundingBox()

        await page.getByRole('tab', { name: 'AOV' }).click()
        // Điều hướng này render phía server + đọc DB thật; 5s mặc định đủ ở
        // 360/390 nhưng đã rớt ở 430 dưới tải — dùng cùng mốc 20s như
        // openFirstCampaign thay vì để đỏ ngẫu nhiên theo viewport.
        await expect(page).toHaveURL(/series=aov/, { timeout: 20_000 })
        expect(
          new URL(page.url()).searchParams.get('campaign'),
          'đổi series làm MẤT campaign khỏi URL',
        ).toBe(campaignId)

        const after = await page.locator(CHART_FRAME).first().boundingBox()
        expect(before, 'không đo được khung chart trước khi đổi series').not.toBeNull()
        expect(after, 'không đo được khung chart sau khi đổi series').not.toBeNull()
        expect(
          Math.abs(after!.height - before!.height),
          `@${vp.w}: khung chart đổi chiều cao khi đổi series (${before!.height} → ${after!.height})`,
        ).toBeLessThanOrEqual(1)

        await noHorizontalOverflow(page, `chart aov @${vp.w}`)
      })
    })
  }
}

mobileSuite('Staff', STAFF_STATE, STAFF)
mobileSuite('QLCH', MANAGER_STATE, QLCH)

test.describe('campaign detail desktop giữ nguyên @desktop', () => {
  test.use({ storageState: STAFF_STATE })
  test.skip(!STAFF.email || !STAFF.password, 'E2E_STAFF_* chưa set')

  test('desktop: ring VẪN hiện cho Doanh số/Số khách (hình thức đã duyệt không đổi)', async ({ page }) => {
    const why = await openFirstCampaign(page, STAFF)
    test.skip(why !== null, why ?? '')
    if (await isOrderAovDetail(page)) {
      // Chất lượng bán hàng bỏ hero (commit 5) nên không có ring — kiểm đúng
      // cái THAY THẾ nó thay vì bỏ qua lượt kiểm.
      await expect(page.locator(METRIC_BAR), 'phải có hai thanh chỉ số thay cho ring').toHaveCount(2)
      return
    }
    await expect(
      page.locator(RING).first(),
      'ring biến mất trên desktop — đã đổi hình thức đã duyệt',
    ).toBeVisible()
  })
})

// ── PM CT-R1-01: bằng chứng hai nhánh của helper — trễ vẫn chạy; không có thẻ thì FAIL (không skip) ─────────
test.describe('campaign detail — helper chờ thẻ chiến dịch (trễ / không thẻ / precondition lỗi) @mobile', () => {
  test.use({ storageState: STAFF_STATE, viewport: { width: 390, height: 844 } })
  test.skip(!STAFF.email || !STAFF.password, 'E2E_STAFF_* chưa set')
  test.beforeEach(async ({}, testInfo) => {
    testInfo.skip(testInfo.project.name !== RUN_PROJECT, `chỉ chạy dưới project ${RUN_PROJECT}`)
    testInfo.setTimeout(120_000)
  })
  const isLanding = (u: string) => { const x = new URL(u); return x.pathname === '/targets' && !x.searchParams.has('campaign') }

  test('landing /targets trả chậm 8 s ⇒ helper chờ được; list → detail → back chạy hết', async ({ page }) => {
    test.skip((await rlsCampaignCount(STAFF)) === 0, NO_CAMPAIGN)
    let delayed = 0
    await page.route('**/targets*', async (route) => {
      if (route.request().isNavigationRequest() && isLanding(route.request().url())) { delayed++; await new Promise((r) => setTimeout(r, 8_000)) }
      await route.continue()
    })
    expect(await clickFirstCampaign(page, STAFF)).toBeNull()
    expect(delayed).toBeGreaterThan(0)
    await page.getByRole('link', { name: /Danh sách chiến dịch/ }).click()
    await expect(page).not.toHaveURL(/[?&]campaign=/, { timeout: 30_000 })
  })

  test('landing /targets không có thẻ (như khi truy vấn chiến dịch lỗi ⇒ []) ⇒ helper NÉM lỗi kèm URL, không trả lý do skip', async ({ page }) => {
    const n = await rlsCampaignCount(STAFF)
    test.skip(n === 0, NO_CAMPAIGN)
    await page.route('**/targets*', (route) => (route.request().isNavigationRequest() && isLanding(route.request().url())
      ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><body><main><h1>Doanh số</h1></main></body></html>' })
      : route.continue()))
    const r = await clickFirstCampaign(page, STAFF, { attempts: 2, waitMs: 2_000 }).then((why) => ({ why }), (e: Error) => ({ err: e.message }))
    expect(r, 'helper phải ném (test FAIL) chứ không trả lý do skip').toHaveProperty('err')
    expect((r as { err: string }).err).toBe(`/targets không hiện thẻ chiến dịch sau 2 lần tải (2 s/lần) dù RLS thấy ${n} chiến dịch — URL /targets, link "Danh sách chiến dịch": 0`)
    const o = await openFirstCampaign(page, STAFF).then((why) => ({ why }), (e: Error) => ({ err: e.message }))
    expect(o, 'openFirstCampaign cũng phải ném').toHaveProperty('err')
  })

  test('precondition RLS lỗi (đăng nhập hỏng) ⇒ ném, KHÔNG coi là 0 chiến dịch', async () => {
    // Email không tồn tại (domain .invalid) — không chạm tài khoản thật, không gây khoá đăng nhập.
    const r = await rlsCampaignCount({ email: 'qa.khong.ton.tai@example.invalid', password: 'x-khong-dung' })
      .then((n) => ({ n }), (e: Error) => ({ err: e.message }))
    expect(r).toHaveProperty('err')
    expect((r as { err: string }).err).toMatch(/đăng nhập .* để kiểm RLS lỗi/)
  })

  // PM CT-R1.1-01: không tạo được tài khoản prod có store_id rỗng (không sửa tài khoản thật) ⇒ kiểm hàm
  // campaignsVisibleTo bằng client giả cùng hình dạng supabase-js (auth.getUser + from().select().eq()…).
  test('thiếu store ⇒ ném lỗi chẩn đoán, KHÔNG truy vấn campaign, KHÔNG trả []; [] chỉ khi truy vấn RLS thành công 0 dòng', async () => {
    const fake = (storeId: string | null, kpi: { data: unknown[] | null; error: { message: string } | null }) => {
      const tables: string[] = []
      const chain = (result: unknown) => {
        const c: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'is']) c[m] = () => c
        c.single = async () => result
        c.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(result).then(ok, ko)
        return c
      }
      const client = {
        auth: { getUser: async () => ({ data: { user: { id: 'qa-uid' } }, error: null }) },
        from: (t: string) => { tables.push(t); return chain(t === 'users' ? { data: { store_id: storeId }, error: null } : kpi) },
      }
      return { tables, client: client as unknown as RlsClient }
    }
    const noStore = fake(null, { data: [], error: null })
    const r = await campaignsVisibleTo(noStore.client).then((v) => ({ v }), (e: Error) => ({ err: e.message }))
    expect(r).toEqual({ err: NO_STORE_ERROR })
    expect(noStore.tables).toEqual(['users'])                         // chưa truy vấn campaign thì không được kết luận 0
    expect(NO_STORE_ERROR).not.toMatch(/@|qa-uid/)                   // không email/ID
    const zero = fake('store-qa', { data: [], error: null })
    expect(await campaignsVisibleTo(zero.client)).toEqual([])         // 0 dòng SAU truy vấn thành công ⇒ []
    expect(zero.tables).toEqual(['users', 'kpi_campaign_store_targets'])
    const failed = fake('store-qa', { data: null, error: { message: 'boom' } })
    expect(await campaignsVisibleTo(failed.client).then(() => 'ok', () => 'threw')).toBe('threw')
    const some = fake('store-qa', { data: [{ campaign: { metric_type: 'offline_order_aov' } }, { campaign: {} }], error: null })
    expect(await campaignsVisibleTo(some.client)).toEqual([{ metricType: 'offline_order_aov' }, { metricType: null }])
  })
})
