import { test, expect, type Page } from '@playwright/test'
import * as XLSX from 'xlsx'
import { MANAGER_STATE, SM_STATE, STAFF_STATE } from './authState'
import { must, serviceDb, type Sb } from './dbFixtures'

// ─────────────────────────────────────────────────────────────────────────────
// XUẤT EXCEL CHO SM (chốt 30/08) — kiểm FILE, không kiểm cái nút
//
// Nút hiện ra không chứng minh gì cả. Điều phải chứng minh là: API trả 200, file
// mở được, và nó KHÔNG chứa cửa hàng ngoài sm_store_assignments. Đây là đường
// dữ liệu ra khỏi hệ thống — nếu route lỡ dùng service role thì file sẽ chứa cả
// 26 cửa hàng mà UI vẫn trông bình thường.
//
// Dùng `page.request` để đi bằng ĐÚNG cookie phiên của vai trò đang test.
// ─────────────────────────────────────────────────────────────────────────────

const CRED = {
  sm: { email: process.env.E2E_SM_EMAIL, password: process.env.E2E_SM_PASSWORD },
  staff: { email: process.env.E2E_STAFF_EMAIL, password: process.env.E2E_STAFF_PASSWORD },
  qlch: { email: process.env.E2E_QLCH_EMAIL, password: process.env.E2E_QLCH_PASSWORD },
}
const EXPORT = (id: string) => `/api/export/kpi-campaigns?campaign_id=${id}`

// Phiên hết hạn thì middleware chuyển hướng sang /login, và `page.request` TỰ
// ĐỘNG đi theo redirect ⇒ kết quả là trang HTML 200. Ca âm sẽ đỏ với thông
// điệp "SM tải được campaign" — nghe như lỗ hổng bảo mật trong khi thật ra chỉ
// là storageState cũ. Tách hẳn hai chuyện đó ra.
function assertNotLoginRedirect(res: { status: () => number; url: () => string }, role: string) {
  expect(res.url().includes('/login'), `phiên ${role} đã hết hạn (bị đẩy về /login) — xoá e2e/.auth rồi chạy lại; đây KHÔNG phải kết quả phân quyền`)
    .toBe(false)
}

interface TargetRow { campaign_id: string; store_id: string; pos_code: string | null }

// Phạm vi SM đọc thẳng từ DB (service role) — nguồn sự thật ĐỘC LẬP với app.
async function smStoreIds(sb: Sb, email: string): Promise<Set<string>> {
  const smRow = must<{ id: string }>(
    await sb.from('users').select('id').eq('email', email).single(), 'đọc user SM')
  const rows = must<{ store_id: string }[]>(
    await sb.from('sm_store_assignments').select('store_id').eq('sm_user_id', smRow.id),
    'đọc sm_store_assignments')
  return new Set(rows.map((r) => r.store_id))
}

async function campaignTargets(sb: Sb, campaignId: string): Promise<TargetRow[]> {
  return must(await sb.from('kpi_campaign_store_targets')
    .select('campaign_id, store_id, pos_code').eq('campaign_id', campaignId),
  `đọc target của campaign ${campaignId}`) as TargetRow[]
}

// Campaign đầu tiên SM nhìn thấy trên dashboard (đã qua RLS).
async function smFirstCampaignId(page: Page): Promise<string | null> {
  await page.goto('/targets/campaigns')
  await expect
    .poll(async () => (await page.locator('main').innerText()).trim().length)
    .toBeGreaterThan(30)
  const hrefs = await page.locator('main a[href^="/targets/campaigns/"]').evaluateAll(
    (as) => as.map((a) => a.getAttribute('href') ?? ''))
  const hit = hrefs.find((h) => /^\/targets\/campaigns\/[0-9a-f-]{36}$/.test(h))
  return hit ? hit.split('/').pop()! : null
}

test.describe('export campaign — SM @desktop', () => {
  test.use({ storageState: SM_STATE })
  test.skip(!CRED.sm.email || !CRED.sm.password, 'E2E_SM_* chưa set')

  test('SM tải được XLSX và file CHỈ chứa cửa hàng trong phạm vi', async ({ page }) => {
    test.setTimeout(120_000)
    const id = await smFirstCampaignId(page)
    if (id === null) {
      // eslint-disable-next-line no-console
      console.log('SM_EXPORT_VERIFIED=false — SM chưa có chiến dịch nào trong phạm vi')
      test.info().annotations.push({
        type: 'runtime-unverified',
        description: 'SM_EXPORT_VERIFIED=false — chưa kiểm được file Excel của SM',
      })
      test.skip(true, 'SM_EXPORT_VERIFIED=false — không có chiến dịch trong phạm vi SM')
      return
    }

    const res = await page.request.get(EXPORT(id))
    expect(res.status(), `export lỗi: ${res.status()} ${(await res.text()).slice(0, 200)}`).toBe(200)
    expect(res.headers()['content-type'] ?? '', 'không phải file Excel')
      .toContain('spreadsheet')

    // Mở file thật, không tin content-type.
    const buf = Buffer.from(await res.body())
    const wb = XLSX.read(buf, { type: 'buffer' })
    expect(wb.SheetNames.length, 'workbook rỗng').toBeGreaterThan(0)
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]])
    expect(rows.length, 'file không có dòng dữ liệu nào').toBeGreaterThan(0)

    // ── Đối soát HAI CHIỀU ────────────────────────────────────────────────
    // Không RÒ (POS lạ) và không THIẾU (đủ POS hợp lệ). Bản trước chỉ khoá
    // chiều "không rò" — một file mất nửa số dòng vẫn xanh.
    //   expected = target của campaign ∩ sm_store_assignments
    //   actual   = POS trong XLSX, mỗi dòng bắt buộc có POS
    const sb = await serviceDb()
    const scope = await smStoreIds(sb, CRED.sm.email as string)
    expect(scope.size, 'SM chưa được phân công cửa hàng nào').toBeGreaterThan(0)

    const targets = await campaignTargets(sb, id)
    expect(targets.length, 'campaign không có dòng target nào để đối soát').toBeGreaterThan(0)
    const storeOfPos = new Map(targets.map((t) => [t.pos_code ?? '', t.store_id]))
    const expectedPos = [...new Set(targets.filter((t) => scope.has(t.store_id))
      .map((t) => t.pos_code ?? ''))].sort()
    const outOfScopePos = [...new Set(targets.filter((t) => !scope.has(t.store_id))
      .map((t) => t.pos_code ?? ''))]
    expect(expectedPos.length, 'campaign này không có cửa hàng nào thuộc phạm vi SM').toBeGreaterThan(0)

    // `.filter(Boolean)` của bản trước NUỐT dòng thiếu POS — đếm tường minh.
    const posInFile = rows.map((r) => String(r['POS'] ?? '').trim())
    const blank = posInFile.filter((p) => p === '').length
    expect(blank, `${blank} dòng trong file không có POS`).toBe(0)

    const leaked = [...new Set(posInFile)].filter((p) => !scope.has(storeOfPos.get(p) ?? ''))
    expect(leaked,
      `FILE CHỨA CỬA HÀNG NGOÀI PHẠM VI SM: ${leaked.join(', ')} (ngoài vùng trong campaign này: ${outOfScopePos.join(', ') || 'không có'})`)
      .toEqual([])
    expect([...new Set(posInFile)].sort(),
      'tập POS trong file KHÔNG bằng đúng (target campaign ∩ phạm vi SM)')
      .toEqual(expectedPos)
    // buildCampaignExportRows = targets.map ⇒ đúng 1 dòng / cửa hàng.
    expect(rows.length, 'số dòng export không khớp số cửa hàng hợp lệ').toBe(expectedPos.length)

    // eslint-disable-next-line no-console
    console.log(`SM_EXPORT_VERIFIED=true — ${rows.length} dòng, POS: ${expectedPos.join(', ')}`)
  })

  test('campaign SAI TRẠNG THÁI (draft/paused/test) → SM không tải được', async ({ page }) => {
    const sb = await serviceDb()
    // Chọn một campaign mà RLS chắc chắn chặn SM: draft/paused hoặc is_test.
    const blocked = must(await sb.from('kpi_campaigns').select('id, name, status, is_test')
      .or('status.eq.draft,status.eq.paused,is_test.eq.true').limit(1),
    'đọc campaign draft/paused/test') as { id: string }[]
    test.skip(blocked.length === 0, 'DB không có campaign draft/paused/test để thử')

    const res = await page.request.get(EXPORT(blocked[0].id))
    assertNotLoginRedirect(res, 'SM')
    expect([403, 404], `SM tải được campaign sai trạng thái (status ${res.status()})`)
      .toContain(res.status())
  })

  // Ca âm KHÁC hẳn ca trên: campaign hoàn toàn HỢP LỆ (active/ended, không
  // test, không archive) — chỉ khác vùng. Nếu RLS 111 nới theo status mà quên
  // ràng buộc is_sm_for_store thì ca draft/paused ở trên VẪN xanh, chỉ ca này
  // đỏ. Đây mới là ca chứng minh "SM không thấy campaign ngoài vùng".
  test('campaign HỢP LỆ nhưng NGOÀI VÙNG → SM không tải được', async ({ page }) => {
    const sb = await serviceDb()
    const scope = await smStoreIds(sb, CRED.sm.email as string)
    const live = must(await sb.from('kpi_campaigns').select('id, name, status')
      .in('status', ['active', 'ended']).eq('is_test', false).is('archived_at', null),
    'đọc campaign active/ended') as { id: string; name: string; status: string }[]
    test.skip(live.length === 0, 'DB không có campaign active/ended nào')

    const rows = must(await sb.from('kpi_campaign_store_targets')
      .select('campaign_id, store_id').in('campaign_id', live.map((c) => c.id)),
    'đọc target của các campaign active/ended') as { campaign_id: string; store_id: string }[]
    const byCampaign = new Map<string, string[]>()
    for (const r of rows) byCampaign.set(r.campaign_id, [...(byCampaign.get(r.campaign_id) ?? []), r.store_id])

    // Phải CÓ target (campaign 0 target thì 404 vì lý do khác, không chứng minh
    // được gì) nhưng KHÔNG cửa hàng nào thuộc phạm vi SM.
    const outOfScope = live.find((c) => {
      const ids = byCampaign.get(c.id) ?? []
      return ids.length > 0 && ids.every((id) => !scope.has(id))
    })
    if (!outOfScope) {
      test.info().annotations.push({
        type: 'fixture-missing',
        description: 'DB không có campaign active/ended nào nằm HOÀN TOÀN ngoài vùng SM — ca âm ngoài-vùng chưa chạy được ở đây',
      })
      test.skip(true, 'thiếu fixture campaign ngoài vùng SM (query chạy OK, dữ liệu không có)')
      return
    }

    const res = await page.request.get(EXPORT(outOfScope.id))
    assertNotLoginRedirect(res, 'SM')
    expect([403, 404],
      `SM tải được campaign NGOÀI VÙNG "${outOfScope.name}" (${outOfScope.status}) — status ${res.status()}`)
      .toContain(res.status())
  })
})

for (const [label, state, cred] of [
  ['Staff', STAFF_STATE, CRED.staff],
  ['QLCH', MANAGER_STATE, CRED.qlch],
] as const) {
  test.describe(`export campaign — ${label} bị chặn @desktop`, () => {
    test.use({ storageState: state })
    test.skip(!cred.email || !cred.password, 'credential chưa set')

    test('gọi thẳng API export → 403', async ({ page }) => {
      const sb = await serviceDb()
      const any = must(await sb.from('kpi_campaigns').select('id').limit(1),
        'đọc campaign bất kỳ') as { id: string }[]
      test.skip(any.length === 0, 'DB chưa có campaign nào')
      const res = await page.request.get(EXPORT(any[0].id))
      assertNotLoginRedirect(res, label)
      expect(res.status(), `${label} tải được file export`).toBe(403)
    })
  })
}
