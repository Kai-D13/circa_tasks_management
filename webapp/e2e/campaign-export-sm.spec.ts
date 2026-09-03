import { test, expect, type Page } from '@playwright/test'
import * as XLSX from 'xlsx'
import { MANAGER_STATE, SM_STATE, STAFF_STATE } from './authState'

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

async function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  expect(Boolean(url && key), 'thiếu SUPABASE env để đối soát phạm vi').toBe(true)
  const { createClient } = await import('@supabase/supabase-js')
  return createClient(url as string, key as string, { auth: { persistSession: false } })
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

    // Đối soát phạm vi: mọi POS trong file phải thuộc sm_store_assignments.
    const sb = await db()
    const smRow = (await sb.from('users').select('id').eq('email', CRED.sm.email as string).single()).data
    expect(smRow, 'không đọc được user SM').toBeTruthy()
    const assigned = (await sb.from('sm_store_assignments').select('store_id')
      .eq('sm_user_id', (smRow as { id: string }).id)).data ?? []
    const codes = (await sb.from('stores').select('code')
      .in('id', assigned.map((a: { store_id: string }) => a.store_id))).data ?? []
    const allowed = new Set(codes.map((c: { code: string }) => c.code))
    expect(allowed.size, 'SM chưa được phân công cửa hàng nào').toBeGreaterThan(0)

    const posInFile = rows.map((r) => String(r['POS'] ?? '')).filter(Boolean)
    expect(posInFile.length, 'file không có cột POS để đối soát').toBeGreaterThan(0)
    const outside = [...new Set(posInFile)].filter((p) => !allowed.has(p))
    expect(outside,
      `FILE CHỨA CỬA HÀNG NGOÀI PHẠM VI SM: ${outside.join(', ')} (được phép: ${[...allowed].join(', ')})`)
      .toEqual([])

    // eslint-disable-next-line no-console
    console.log(`SM_EXPORT_VERIFIED=true — ${rows.length} dòng, POS: ${[...new Set(posInFile)].join(', ')}`)
  })

  test('campaign NGOÀI phạm vi (draft/test) → SM không tải được', async ({ page }) => {
    const sb = await db()
    // Chọn một campaign mà RLS chắc chắn chặn SM: draft/paused hoặc is_test.
    const blocked = (await sb.from('kpi_campaigns').select('id, name, status, is_test')
      .or('status.eq.draft,status.eq.paused,is_test.eq.true').limit(1)).data ?? []
    test.skip(blocked.length === 0, 'DB không có campaign draft/paused/test để thử')

    const res = await page.request.get(EXPORT((blocked[0] as { id: string }).id))
    expect([403, 404], `SM tải được campaign ngoài phạm vi (status ${res.status()})`)
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
      const sb = await db()
      const any = (await sb.from('kpi_campaigns').select('id').limit(1)).data ?? []
      test.skip(any.length === 0, 'DB chưa có campaign nào')
      const res = await page.request.get(EXPORT((any[0] as { id: string }).id))
      expect(res.status(), `${label} tải được file export`).toBe(403)
    })
  })
}
