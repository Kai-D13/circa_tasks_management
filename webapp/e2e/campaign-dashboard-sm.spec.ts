import { test, expect, type Page } from '@playwright/test'
import { MANAGER_STATE, SM_STATE, STAFF_STATE, SUPER_STATE } from './authState'
import { must, serviceDb, sessionDb } from './dbFixtures'

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD CHIẾN DỊCH KPI — acceptance RUNTIME (batch 111)
//
// Contract thuần đã có test riêng. Suite này trả lời câu hỏi KHÁC: màn hình
// THẬT có đúng vậy không. Bài học 4b/5.1: contract xanh vẫn lọt một surface
// chưa nối (picker) và một nhánh vai trò chưa hề chạm tới (SM).
//
// Mọi cổng skip đều CHỜ TƯỜNG MINH rồi mới kết luận — `count()` trần đọc DOM
// tức thì nên một nhịp render chậm là test tự skip mà báo cáo vẫn xanh.
// ─────────────────────────────────────────────────────────────────────────────

const CRED = {
  super: { email: process.env.E2E_SUPER_EMAIL, password: process.env.E2E_SUPER_PASSWORD },
  sm: { email: process.env.E2E_SM_EMAIL, password: process.env.E2E_SM_PASSWORD },
  staff: { email: process.env.E2E_STAFF_EMAIL, password: process.env.E2E_STAFF_PASSWORD },
  qlch: { email: process.env.E2E_QLCH_EMAIL, password: process.env.E2E_QLCH_PASSWORD },
}

const LIST = '/targets/campaigns'
const TABS = 'nav[aria-label="Lọc chiến dịch theo trạng thái"] a'

async function mainReady(page: Page) {
  await expect
    .poll(async () => (await page.locator('main').innerText()).trim().length, {
      message: 'main vẫn rỗng — trang chưa render xong',
    })
    .toBeGreaterThan(30)
}

const createBtn = (page: Page) => page.getByRole('link', { name: /Tạo chiến dịch/i })

// ── Fixture "campaign ĐÃ KẾT THÚC có thật" ───────────────────────────────────
// Ca âm/dương về `ended` phải trỏ vào ĐÍCH DANH một campaign ended thật, phủ
// đúng cửa hàng của vai trò đang kiểm. Đọc bằng service role (chỉ để dựng
// fixture), còn việc "ai đọc được" thì hỏi RLS bằng phiên của chính vai trò.
async function endedCampaignForStores(storeIds: string[]): Promise<{ id: string; name: string } | null> {
  if (storeIds.length === 0) return null
  const sb = await serviceDb()
  const ended = must<{ id: string; name: string }[]>(
    await sb.from('kpi_campaigns').select('id, name')
      .eq('status', 'ended').eq('is_test', false).is('archived_at', null),
    'đọc campaign ended')
  if (ended.length === 0) return null
  const tg = must<{ campaign_id: string }[]>(
    await sb.from('kpi_campaign_store_targets').select('campaign_id')
      .in('campaign_id', ended.map((c) => c.id)).in('store_id', storeIds),
    'đọc target của campaign ended')
  return ended.find((c) => tg.some((t) => t.campaign_id === c.id)) ?? null
}

async function storeIdOf(email: string): Promise<string | null> {
  const sb = await serviceDb()
  return must<{ store_id: string | null }>(
    await sb.from('users').select('store_id').eq('email', email).single(),
    `đọc cửa hàng của ${email}`).store_id
}

// Marker migration — thứ biến CỜ thành GATE. Trước 111, không đọc được `ended`
// là đúng nên cho skip; SAU 111 (marker có trong app_migrations) mà vẫn không
// đọc được thì đó là REGRESSION và phải ĐỎ. Thiếu cái này thì suite trả exit 0
// kể cả khi quyền chính hỏng, và việc phát hiện lại phụ thuộc người đọc log.
async function migration111Applied(): Promise<boolean> {
  const sb = await serviceDb()
  return must<{ version: string }[]>(
    await sb.from('app_migrations').select('version').eq('version', '111'),
    'đọc marker migration 111').length > 0
}

// Tập cửa hàng ĐÚNG RA SM phải đọc được của một campaign (service role).
async function expectedScopedStores(campaignId: string, scope: string[]): Promise<string[]> {
  const sb = await serviceDb()
  const rows = must<{ store_id: string }[]>(
    await sb.from('kpi_campaign_store_targets').select('store_id').eq('campaign_id', campaignId),
    `đọc target của campaign ${campaignId}`)
  return [...new Set(rows.map((r) => r.store_id).filter((id) => scope.includes(id)))].sort()
}

async function smAssignedStoreIds(email: string): Promise<string[]> {
  const sb = await serviceDb()
  const u = must<{ id: string }>(
    await sb.from('users').select('id').eq('email', email).single(), 'đọc user SM')
  return must<{ store_id: string }[]>(
    await sb.from('sm_store_assignments').select('store_id').eq('sm_user_id', u.id),
    'đọc sm_store_assignments').map((r) => r.store_id)
}

test.describe('dashboard chiến dịch — Super @desktop', () => {
  test.use({ storageState: SUPER_STATE })
  test.skip(!CRED.super.email || !CRED.super.password, 'E2E_SUPER_* chưa set')

  test('đủ 5 tab trạng thái + nút Tạo chiến dịch', async ({ page }) => {
    await page.goto(LIST)
    await mainReady(page)
    await expect(page.locator(TABS)).toHaveCount(5)
    const labels = (await page.locator(TABS).allInnerTexts()).join(' | ')
    for (const t of ['Tất cả', 'Đang chạy', 'Tạm dừng', 'Nháp', 'Kết thúc']) {
      expect(labels, `thiếu tab ${t}`).toContain(t)
    }
    await expect(createBtn(page)).toHaveCount(1)
  })

  // `mainReady` chỉ đo độ dài `main` — trong lúc Next chuyển route, main của
  // TRANG CŨ cũng thoả điều kiện đó, nên đọc tab active ngay sau goto là đọc
  // trúng trạng thái cũ. Neo vào chính thanh tab rồi mới khẳng định.
  async function activeTab(page: Page): Promise<string> {
    await expect(page.locator(TABS).first()).toBeVisible({ timeout: 15_000 })
    // Giữa lúc Next chuyển route, thanh tab của trang CŨ và trang MỚI có thể
    // cùng nằm trong DOM ⇒ 2 phần tử aria-current (strict mode nổ, và đọc lúc
    // đó là đọc trạng thái nửa vời). Coi như CHƯA ổn định để poll thử lại.
    const cur = await page.locator(`${TABS}[aria-current="page"]`).allInnerTexts()
    return cur.length === 1 ? cur[0] : `chưa ổn định (${cur.length} tab active)`
  }

  test('?status=ended lọc đúng; giá trị lạ quay về Tất cả', async ({ page }) => {
    // timeout 15s tường minh: chạy trong full suite (6 worker song song) server
    // chậm hơn hẳn chạy lẻ, và 5s mặc định của poll không đủ — test đã rớt đúng
    // kiểu đó trong khi chạy riêng thì xanh 4 lượt liên tiếp.
    const POLL = { timeout: 15_000 }
    await page.goto(`${LIST}?status=ended`)
    await expect.poll(() => activeTab(page), { ...POLL, message: 'tab Kết thúc chưa active' })
      .toMatch(/Kết thúc/)

    await page.goto(`${LIST}?status=khong_ton_tai`)
    await expect.poll(() => activeTab(page), { ...POLL, message: 'status lạ phải quay về Tất cả' })
      .toMatch(/Tất cả/)
  })
})

test.describe('dashboard chiến dịch — SM chỉ xem @desktop', () => {
  test.use({ storageState: SM_STATE })
  test.skip(!CRED.sm.email || !CRED.sm.password, 'E2E_SM_* chưa set')

  test('SM VÀO ĐƯỢC danh sách, KHÔNG có nút quản trị nào', async ({ page }) => {
    await page.goto(LIST)
    await mainReady(page)
    expect(page.url(), 'SM bị đá khỏi dashboard').toContain('/targets/campaigns')
    await expect(createBtn(page), 'SM không được thấy Tạo chiến dịch').toHaveCount(0)
    for (const label of ['Kích hoạt', 'Tạm dừng', 'Lưu trữ']) {
      await expect(page.getByRole('button', { name: label }), `SM thấy nút ${label}`).toHaveCount(0)
    }
  })

  test('SM chỉ có 3 tab; KHÔNG có Nháp/Tạm dừng', async ({ page }) => {
    await page.goto(LIST)
    await mainReady(page)
    const n = await page.locator(TABS).count()
    if (n === 0) {
      expect(await page.locator('main').innerText(),
        'không có tab mà cũng không phải empty-state của SM').toContain('cửa hàng bạn quản lý')
      return
    }
    expect(n).toBe(3)
    const labels = (await page.locator(TABS).allInnerTexts()).join(' | ')
    expect(labels).toContain('Tất cả')
    expect(labels).toContain('Kết thúc')
    for (const dead of ['Nháp', 'Tạm dừng']) {
      expect(labels, `SM không được có tab ${dead}`).not.toContain(dead)
    }
  })

  test('SM KHÔNG thấy chiến dịch nháp/tạm dừng/TEST', async ({ page }) => {
    await page.goto(LIST)
    await mainReady(page)
    const body = await page.locator('main').innerText()
    for (const dead of ['Nháp', 'Tạm dừng', 'TEST']) {
      expect(body, `SM nhìn thấy chiến dịch ${dead}`).not.toContain(dead)
    }
  })

  test('SM mở detail: ?tab=config KHÔNG mở cấu hình, CÓ Xuất Excel', async ({ page }) => {
    await page.goto(LIST)
    await mainReady(page)
    // ⚠ '/targets/campaigns/affiliate' (tab Affiliate) và '/new' cũng khớp tiền
    // tố này — lấy nhầm là test đi lạc sang màn khác rồi đỏ vì lý do vô nghĩa.
    await page.locator('main a[href^="/targets/campaigns/"]').first()
      .waitFor({ state: 'attached', timeout: 15_000 }).catch(() => {})
    const hrefs = (await page.locator('main a[href^="/targets/campaigns/"]').evaluateAll(
      (as) => as.map((a) => a.getAttribute('href') ?? ''),
    )).filter((h) => /^\/targets\/campaigns\/[0-9a-f-]{36}$/.test(h))
    const has = hrefs.length > 0
    if (!has) {
      // eslint-disable-next-line no-console
      console.log('SM_CAMPAIGN_DETAIL_VERIFIED=false — SM chưa có chiến dịch nào trong phạm vi')
      test.info().annotations.push({
        type: 'runtime-unverified',
        description: 'SM_CAMPAIGN_DETAIL_VERIFIED=false — chưa kiểm được detail chỉ-đọc của SM',
      })
      test.skip(true, 'SM_CAMPAIGN_DETAIL_VERIFIED=false — không có chiến dịch trong phạm vi SM')
      return
    }
    const href = hrefs[0]

    await page.goto(`${href}?tab=config`)
    await mainReady(page)
    const body = await page.locator('main').innerText()
    expect(body, 'SM lọt vào tab Cấu hình').not.toContain('Nạp target từ file')
    for (const dead of ['Đồng bộ', 'Kích hoạt', 'Lưu trữ']) {
      await expect(page.getByRole('button', { name: dead }), `SM thấy nút ${dead}`).toHaveCount(0)
    }
    await expect(page.getByRole('button', { name: /Xuất Excel/i }),
      'SM phải có nút Xuất Excel (chốt 30/08)').toHaveCount(1)
    // eslint-disable-next-line no-console
    console.log('SM_CAMPAIGN_DETAIL_VERIFIED=true')
  })

  // Chính REQUEST #1. GATE theo marker migration: chưa chạy 111 thì cho skip
  // (branch phải xanh trước migration), CHẠY RỒI mà không thấy là ĐỎ.
  test('SM thấy chiến dịch ĐÃ KẾT THÚC (gate theo marker 111)', async ({ page }) => {
    const scope = await smAssignedStoreIds(CRED.sm.email as string)
    const fixture = await endedCampaignForStores(scope)
    const applied = await migration111Applied()

    await page.goto(`${LIST}?status=ended`)
    await mainReady(page)
    const rows = (await page.locator('main a[href^="/targets/campaigns/"]').evaluateAll(
      (as) => as.map((a) => a.getAttribute('href') ?? ''),
    )).filter((h) => /^\/targets\/campaigns\/[0-9a-f-]{36}$/.test(h))

    if (rows.length === 0) {
      // Đủ điều kiện mà vẫn trống ⇒ REGRESSION, không phải "chưa kiểm được".
      if (applied && fixture) {
        expect(rows.length,
          `REGRESSION: marker 111 ĐÃ có trong app_migrations và vùng SM có campaign ended ("${fixture.name}") — danh sách ?status=ended KHÔNG được trống`)
          .toBeGreaterThan(0)
      }
      const why = !applied ? 'marker 111 chưa có trong app_migrations' : 'vùng SM chưa có campaign ended nào'
      // eslint-disable-next-line no-console
      console.log(`SM_ENDED_VISIBLE=false — ${why}`)
      test.info().annotations.push({
        type: !applied ? 'runtime-unverified' : 'fixture-missing',
        description: `SM_ENDED_VISIBLE=false — ${why}`,
      })
      test.skip(true, `SM_ENDED_VISIBLE=false — ${why}`)
      return
    }
    // Có dòng thì mọi dòng phải đúng là ended, và mở được detail.
    const body = await page.locator('main').innerText()
    expect(body).toContain('Kết thúc')
    await page.goto(rows[0])
    await mainReady(page)
    expect(await page.locator('main').innerText(), 'SM mở detail campaign ended bị chặn')
      .not.toContain('This page could not be found')
    // eslint-disable-next-line no-console
    console.log(`SM_ENDED_VISIBLE=true — ${rows.length} campaign ended trong vùng SM`)
  })

  // Cặp ĐỐI XỨNG với ca âm của Staff/QLCH bên dưới: cùng loại campaign ended,
  // SM phải ĐỌC ĐƯỢC ở tầng RLS — và thấy ĐÚNG BẰNG tập cửa hàng vùng mình.
  // Kiểm ở tầng dữ liệu chứ không qua UI: UI có thể trống/đầy vì lý do khác.
  // GATE theo marker 111 giống test trên.
  test('SM đọc được campaign ĐÃ KẾT THÚC qua RLS, đúng tập cửa hàng (gate theo marker 111)', async () => {
    const scope = await smAssignedStoreIds(CRED.sm.email as string)
    expect(scope.length, 'SM chưa được phân công cửa hàng nào').toBeGreaterThan(0)
    const hit = await endedCampaignForStores(scope)
    if (!hit) {
      test.info().annotations.push({
        type: 'fixture-missing',
        description: 'DB chưa có campaign ended nào phủ vùng SM — không kiểm được quyền đọc ended',
      })
      test.skip(true, 'thiếu fixture campaign ended trong vùng SM')
      return
    }

    const applied = await migration111Applied()
    const as = await sessionDb(CRED.sm.email as string, CRED.sm.password as string)
    const rows = must<{ id: string }[]>(
      await as.from('kpi_campaigns').select('id').eq('id', hit.id), 'SM đọc kpi_campaigns')
    if (rows.length === 0) {
      expect(applied,
        `REGRESSION: marker 111 ĐÃ có trong app_migrations nhưng RLS vẫn không cho SM đọc campaign ended "${hit.name}"`)
        .toBe(false)
      // eslint-disable-next-line no-console
      console.log('SM_ENDED_RLS_VERIFIED=false — marker 111 chưa có trong app_migrations')
      test.info().annotations.push({
        type: 'runtime-unverified',
        description: 'SM_ENDED_RLS_VERIFIED=false — chưa apply 111 nên quyền đọc ended của SM chưa kiểm được',
      })
      test.skip(true, 'SM_ENDED_RLS_VERIFIED=false — cần migration 111')
      return
    }

    // Đối soát HAI CHIỀU như export: không RÒ và không THIẾU. Chỉ kiểm "mọi
    // dòng đều thuộc vùng" thì SM mất một nửa cửa hàng hợp lệ vẫn xanh.
    const expected = await expectedScopedStores(hit.id, scope)
    const actual = [...new Set(must<{ store_id: string }[]>(
      await as.from('kpi_campaign_store_targets').select('store_id').eq('campaign_id', hit.id),
      'SM đọc target campaign ended').map((t) => t.store_id))].sort()
    expect(expected.length,
      'fixture sai: campaign ended này không có cửa hàng nào thuộc vùng SM').toBeGreaterThan(0)
    const outside = actual.filter((id) => !scope.includes(id))
    expect(outside,
      'SM đọc được target của cửa hàng NGOÀI vùng — 111 nới status mà mất ràng buộc is_sm_for_store')
      .toEqual([])
    expect(actual,
      'tập cửa hàng SM đọc được KHÔNG bằng đúng (target campaign ended ∩ sm_store_assignments)')
      .toEqual(expected)
    // eslint-disable-next-line no-console
    console.log(`SM_ENDED_RLS_VERIFIED=true — "${hit.name}": ${actual.length}/${scope.length} cửa hàng, khớp đúng tập kỳ vọng`)
  })

  test('lối vào: /targets có nút Lịch sử chiến dịch trỏ đúng ?status=ended', async ({ page }) => {
    await page.goto('/targets')
    await mainReady(page)
    const link = page.getByRole('link', { name: /Lịch sử chiến dịch/i })
    await expect(link).toHaveCount(1)
    expect(await link.getAttribute('href')).toBe('/targets/campaigns?status=ended')
  })
})

for (const [label, state, cred] of [
  ['Staff', STAFF_STATE, CRED.staff],
  ['QLCH', MANAGER_STATE, CRED.qlch],
] as const) {
  test.describe(`${label} KHÔNG vào được dashboard @desktop`, () => {
    test.use({ storageState: state })
    test.skip(!cred.email || !cred.password, 'credential chưa set')

    test('vào /targets/campaigns → không thấy gì; /targets không có chiến dịch Kết thúc', async ({ page }) => {
      await page.goto(LIST)
      // Đo NỘI DUNG chứ không đo HTTP status: `notFound()` ở bản standalone trả
      // 200 kèm trang rỗng, nên assert 404 là đo nhầm thứ — điều thực sự quan
      // trọng là hai vai trò này KHÔNG nhìn thấy dashboard.
      const body = await page.locator('body').innerText()
      for (const leak of ['Chiến dịch KPI', 'Tổng chiến dịch', 'Tạo chiến dịch']) {
        expect(body, `${label} nhìn thấy dashboard chiến dịch ("${leak}")`).not.toContain(leak)
      }
      await expect(page.locator(TABS), `${label} thấy bộ lọc trạng thái`).toHaveCount(0)

      await page.goto('/targets')
      await mainReady(page)
      expect(await page.locator('main').innerText(),
        `${label} nhìn thấy chiến dịch đã kết thúc trên /targets`).not.toContain('Đã kết thúc')
    })

    // Ca âm TRỰC TIẾP (audit 111.2 P1). Hai assert ở trên chỉ nói "không thấy
    // dashboard" và "/targets không có chữ Đã kết thúc" — UI có thể trống vì
    // lý do khác mà test vẫn xanh. Ở đây lấy ĐÍCH DANH một campaign ended phủ
    // đúng cửa hàng của vai trò này rồi hỏi cả hai tầng: RLS (bằng chính phiên
    // đăng nhập, không mượn service role) và UI (vào thẳng URL mang id đó).
    // Assert CỨNG cả trước lẫn sau migration 111: 111 chỉ nới cho SM.
    test('campaign ĐÃ KẾT THÚC của chính cửa hàng mình: RLS 0 dòng + UI không render', async ({ page }) => {
      const storeId = await storeIdOf(cred.email as string)
      expect(storeId, `${label} QA chưa được gán cửa hàng`).toBeTruthy()
      const hit = await endedCampaignForStores([storeId as string])
      if (!hit) {
        test.info().annotations.push({
          type: 'fixture-missing',
          description: `DB chưa có campaign ended nào phủ cửa hàng của ${label} — ca âm chưa chạy được`,
        })
        test.skip(true, `thiếu fixture campaign ended cho cửa hàng ${label}`)
        return
      }

      // Tầng 1 — RLS.
      const as = await sessionDb(cred.email as string, cred.password as string)
      const rows = must<{ id: string }[]>(
        await as.from('kpi_campaigns').select('id').eq('id', hit.id), `${label} đọc kpi_campaigns`)
      expect(rows.map((r) => r.id),
        `${label} ĐỌC ĐƯỢC campaign ended "${hit.name}" — 111 đã nới nhầm cho vai trò này`)
        .toEqual([])
      const tg = must<{ store_id: string }[]>(
        await as.from('kpi_campaign_store_targets').select('store_id').eq('campaign_id', hit.id),
        `${label} đọc target campaign ended`)
      expect(tg, `${label} đọc được target của campaign ended "${hit.name}"`).toEqual([])

      // Tầng 2 — UI: vào thẳng URL mang id campaign ended.
      await page.goto(`/targets?campaign=${hit.id}`)
      await mainReady(page)
      expect(await page.locator('main').innerText(),
        `${label} nhìn thấy campaign ended "${hit.name}" khi mở thẳng URL`).not.toContain(hit.name)
    })
  })
}
