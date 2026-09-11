import { test, expect, type Page } from '@playwright/test'
import * as XLSX from 'xlsx'
import { SUPER_STATE } from './authState'
import { must, serviceDb, sessionDb, type Sb } from './dbFixtures'

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE RUNTIME — thưởng thêm theo ngưỡng số đơn (migration 112, batch 113)
//
// Chạy trên DB đã áp 112, QA server localhost:3010 (flags như ghi ở memory
// feedback_qa_server_recipe). GHI FIXTURE is_test vào DB production ⇒ opt-in
// tường minh: E2E_ORDER_BONUS_QA=1 (cùng chuẩn E2E_SM_WRITE_QA của 111).
//
// Đường đi là đường THẬT: target nạp qua rpc_replace_campaign_targets (RPC 112
// tự validate), đồng bộ bằng nút "Đồng bộ doanh số" của Super trên UI (server
// action → engine → rpc_replace_campaign_actuals tự tính trạng thái thưởng),
// rồi đối soát kết quả bằng service role (nguồn sự thật độc lập với app).
//
// Fixture is_test bị RLS giấu khỏi Staff/QLCH/SM (can_read_kpi_campaign) —
// spec CHỨNG MINH điều đó (không rò ra dược sĩ thật). Vì vậy phần "3 vai trò
// NHÌN THẤY thưởng thêm" chỉ chạy được trên campaign W2 thật sau deploy + nạp
// lại file v2 — spec này KHÔNG giả vờ đã làm việc đó.
// ─────────────────────────────────────────────────────────────────────────────

const QA_ON = process.env.E2E_ORDER_BONUS_QA === '1'
const SUPER = { email: process.env.E2E_SUPER_EMAIL, password: process.env.E2E_SUPER_PASSWORD }
const STAFF = { email: process.env.E2E_STAFF_EMAIL, password: process.env.E2E_STAFF_PASSWORD }
const SM = { email: process.env.E2E_SM_EMAIL, password: process.env.E2E_SM_PASSWORD }

const EXPORT = (id: string) => `/api/export/kpi-campaigns?campaign_id=${id}`
const BONUS_PER_STAFF = 200_000
const START = '2026-09-10'
const END = '2026-09-16'
// 3 cửa hàng: POS0009 cấu hình target/ngưỡng THẤP để chắc chắn có ca ĐẠT;
// hai POS còn lại dùng đúng target/ngưỡng W2 (không đạt trong vài ngày đầu).
const FIXTURE = [
  { pos: 'POS0009', kpi_target: 1_000_000, threshold: 50 },
  { pos: 'POS0059', kpi_target: 145_380_624, threshold: 1410 },
  { pos: 'POS0077', kpi_target: 52_064_782, threshold: 520 },
]

const vnTodayISO = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)
const nextDayISO = (d: string) => new Date(Date.parse(d + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10)

interface ActualRow {
  store_id: string; actual_value: number; offline_order_count: number | null
  affiliate_order_count: number | null; bonus_order_count: number | null
  order_bonus_achieved: boolean | null; store_commission_pool: number | null; synced_at: string
}

let sb: Sb
let campaignId: string | null = null
let campaignName = ''
const storeByPos = new Map<string, string>()
const posByStore = new Map<string, string>()
let actuals: ActualRow[] = []
let fullViewTexts: Record<string, string> = {}

async function readActuals(): Promise<ActualRow[]> {
  return must<ActualRow[]>(await sb.from('kpi_campaign_store_actuals')
    .select('store_id, actual_value, offline_order_count, affiliate_order_count, bonus_order_count, order_bonus_achieved, store_commission_pool, synced_at')
    .eq('campaign_id', campaignId as string), 'đọc actuals fixture')
}

async function bonusTexts(page: Page): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const card = page.locator('p', { hasText: /^Đạt thưởng thêm$/ }).locator('xpath=following-sibling::p[1]')
  out.card = (await card.first().textContent())?.trim() ?? ''
  for (const f of FIXTURE) {
    const row = page.locator('tbody tr', { hasText: f.pos })
    await expect(row.first(), `dòng ${f.pos} phải có trong bảng`).toBeVisible()
    const badge = row.first().getByText(/Đạt · 200\.000₫|Chưa đạt thưởng thêm|Chưa đủ dữ liệu số đơn|Chưa đồng bộ/)
    out[f.pos] = (await badge.first().textContent())?.trim() ?? ''
  }
  return out
}

test.describe('thưởng thêm theo số đơn — acceptance Super trên fixture is_test (112) @desktop', () => {
  test.describe.configure({ mode: 'serial' })
  test.use({ storageState: SUPER_STATE })
  test.skip(!QA_ON, 'E2E_ORDER_BONUS_QA=1 chưa bật — spec GHI fixture is_test vào DB production, chỉ chạy có chủ đích')
  test.skip(!SUPER.email || !SUPER.password, 'E2E_SUPER_* chưa set')

  test.beforeAll(async () => {
    sb = await serviceDb()
    const mig = must<{ version: string }[]>(await sb.from('app_migrations').select('version').eq('version', '112'), 'đọc marker 112')
    expect(mig.length, 'migration 112 phải đã áp trên DB này').toBe(1)

    const stores = must<{ id: string; code: string }[]>(
      await sb.from('stores').select('id, code').in('code', FIXTURE.map((f) => f.pos)).eq('store_type', 'os').eq('is_active', true),
      'đọc 3 store fixture')
    expect(stores.length, 'đủ 3 OS store active').toBe(3)
    for (const s of stores) { storeByPos.set(s.code, s.id); posByStore.set(s.id, s.code) }

    campaignName = `QA-BONUS-112-${Date.now()}`
    const ins = must<{ id: string }[]>(await sb.from('kpi_campaigns').insert({
      name: campaignName, start_date: START, end_date: END, scope_type: 'store', metric_type: 'gmv',
      order_type: 'all', metric_offline: true, metric_affiliate: true, status: 'draft', is_test: true,
    }).select('id'), 'tạo campaign fixture')
    campaignId = ins[0].id

    // Nạp target qua ĐÚNG RPC 112 (validate ngưỡng/200000/2 metric ở DB).
    const rows = FIXTURE.map((f, i) => ({
      store_id: storeByPos.get(f.pos), pos_code: f.pos, kpi_target: f.kpi_target, store_kpi_group: null,
      import_row: i + 2, note: 'acceptance 112',
      tiers: [{ tier_order: 1, threshold_pct: 100, commission_amount: 2_500_000 }],
      minimum_order_target: f.threshold, order_bonus_per_staff: BONUS_PER_STAFF,
    }))
    const n = must<number>(await sb.rpc('rpc_replace_campaign_targets', {
      p_campaign_id: campaignId, p_rows: rows, p_file_name: 'acceptance-112.csv', p_uploaded_by: null,
    }), 'rpc_replace_campaign_targets')
    expect(n).toBe(3)
    // Fixture is_test: bật thẳng để đồng bộ được (cron chỉ nhặt active — chấp
    // nhận: is_test ẩn khỏi mọi vai trò thường và sẽ xoá ở afterAll).
    must(await sb.from('kpi_campaigns').update({ status: 'active' }).eq('id', campaignId).select('id'), 'activate fixture')
  })

  test.afterAll(async () => {
    if (!campaignId) return
    const del = must<{ id: string }[]>(
      await sb.from('kpi_campaigns').delete().eq('id', campaignId).eq('is_test', true).like('name', 'QA-BONUS-112-%').select('id'),
      'xoá fixture')
    const left = must<{ id: string }[]>(await sb.from('kpi_campaign_store_targets').select('id').eq('campaign_id', campaignId), 'hậu kiểm targets')
    const leftC = must<{ id: string }[]>(await sb.from('kpi_campaigns').select('id').eq('id', campaignId), 'hậu kiểm campaign')
    if (del.length !== 1 || left.length !== 0 || leftC.length !== 0) {
      throw new Error(`CLEANUP HỎNG: deleted=${del.length} targets_left=${left.length} campaign_left=${leftC.length} — dọn tay ${campaignId}`)
    }
  })

  test('RPC 112 đã lưu ngưỡng + 200.000đ; cột bonus của actuals còn trống trước khi đồng bộ', async () => {
    const t = must<{ pos_code: string; minimum_order_target: number; order_bonus_per_staff: number }[]>(
      await sb.from('kpi_campaign_store_targets').select('pos_code, minimum_order_target, order_bonus_per_staff').eq('campaign_id', campaignId as string),
      'đọc targets fixture')
    expect(t.map((x) => [x.pos_code, x.minimum_order_target, Number(x.order_bonus_per_staff)]).sort())
      .toEqual(FIXTURE.map((f) => [f.pos, f.threshold, BONUS_PER_STAFF]).sort())
    expect((await readActuals()).length, 'chưa đồng bộ → chưa có actuals').toBe(0)
  })

  test('Super bấm "Đồng bộ doanh số" → RPC tự tính bonus_order_count + order_bonus_achieved đúng công thức', async ({ page }) => {
    test.setTimeout(180_000)
    await page.goto(`/targets/campaigns/${campaignId}?tab=result`)
    await expect(page.getByRole('button', { name: 'Đồng bộ doanh số' })).toBeVisible()
    await page.getByRole('button', { name: 'Đồng bộ doanh số' }).click()
    // Chờ snapshot xuất hiện (BigQuery + Supabase; vài chục giây là bình thường).
    await expect.poll(async () => (await readActuals()).length, { timeout: 150_000, intervals: [2000] }).toBe(3)
    actuals = await readActuals()

    const targets = must<{ store_id: string; kpi_target: number; minimum_order_target: number }[]>(
      await sb.from('kpi_campaign_store_targets').select('store_id, kpi_target, minimum_order_target').eq('campaign_id', campaignId as string),
      'đọc targets')
    const tByStore = new Map(targets.map((t) => [t.store_id, t]))
    const offline: Record<string, number | null> = {}
    for (const a of actuals) {
      const t = tByStore.get(a.store_id)!
      const pos = posByStore.get(a.store_id) as string
      offline[pos] = a.offline_order_count
      // Campaign bật cả 2 metric ⇒ số đơn Affiliate PHẢI có (sổ Supabase luôn đọc được).
      expect(a.affiliate_order_count, `${pos}: affiliate_order_count`).not.toBeNull()
      if (a.offline_order_count === null) {
        // POS degrade ở nguồn Offline ⇒ RPC để NULL (chưa đủ dữ liệu), KHÔNG phải "chưa đạt".
        expect(a.bonus_order_count, `${pos}: offline NULL ⇒ bonus NULL`).toBeNull()
        expect(a.order_bonus_achieved, `${pos}: offline NULL ⇒ achieved NULL`).toBeNull()
        continue
      }
      const expectedBonus = a.offline_order_count + (a.affiliate_order_count as number)
      const expectedAchieved = Number(a.actual_value) >= Number(t.kpi_target) && expectedBonus >= t.minimum_order_target
      expect(a.bonus_order_count, `${pos}: bonus = offline + affiliate`).toBe(expectedBonus)
      expect(a.order_bonus_achieved, `${pos}: đạt ⇔ doanh thu ≥ target VÀ đơn ≥ ngưỡng`).toBe(expectedAchieved)
      // Thưởng thêm KHÔNG chạm Commission Store: pool chỉ theo bậc doanh thu.
      const tierPool = Number(a.actual_value) >= Number(t.kpi_target) ? 2_500_000 : null
      expect(a.store_commission_pool === null ? null : Number(a.store_commission_pool), `${pos}: commission pool theo bậc, không cộng 200.000`).toBe(tierPool)
    }
    // POS0009 cấu hình để chắc chắn ĐẠT (target 1tr, ngưỡng 50) — trừ khi nguồn Offline degrade.
    const a9 = actuals.find((a) => posByStore.get(a.store_id) === 'POS0009')!
    if (a9.offline_order_count !== null) expect(a9.order_bonus_achieved, 'POS0009 phải ĐẠT với target/ngưỡng thấp').toBe(true)
    console.log(`BONUS_QA_OFFLINE=${JSON.stringify(offline)} effEnd=${vnTodayISO() < END ? vnTodayISO() : END}`)
  })

  test('đối soát số đơn Affiliate với sổ affiliate_orders (DELIVERED, source_active, partner_code, ngày VN theo completed_time)', async () => {
    expect(actuals.length).toBe(3)
    const effEnd = vnTodayISO() < END ? vnTodayISO() : END
    const from = `${START}T00:00:00+07:00`
    const to = `${nextDayISO(effEnd)}T00:00:00+07:00`
    for (const a of actuals) {
      const pos = posByStore.get(a.store_id) as string
      const { count, error } = await sb.from('affiliate_orders').select('id', { count: 'exact', head: true })
        .eq('store_id', a.store_id).eq('status_norm', 'delivered').eq('source_active', true)
        .gte('completed_time', from).lt('completed_time', to)
      if (error) throw new Error(`đếm affiliate_orders ${pos}: ${error.message}`)
      expect(a.affiliate_order_count, `${pos}: affiliate_order_count = đếm sổ [${from} → ${to})`).toBe(count ?? 0)
    }
  })

  test('Super thấy card "Đạt thưởng thêm X/3", 2 cột "Số đơn / Ngưỡng" + "Thưởng thêm/dược sĩ", badge đúng từng cửa hàng', async ({ page }) => {
    await page.goto(`/targets/campaigns/${campaignId}?tab=result`)
    await expect(page.getByRole('columnheader', { name: 'Số đơn / Ngưỡng' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: 'Thưởng thêm/dược sĩ' })).toBeVisible()
    fullViewTexts = await bonusTexts(page)
    const achieved = actuals.filter((a) => a.order_bonus_achieved === true).length
    expect(fullViewTexts.card).toBe(`${achieved}/3 cửa hàng`)
    for (const a of actuals) {
      const pos = posByStore.get(a.store_id) as string
      const want = a.order_bonus_achieved === true ? 'Đạt · 200.000₫'
        : a.order_bonus_achieved === false ? 'Chưa đạt thưởng thêm' : 'Chưa đủ dữ liệu số đơn'
      expect(fullViewTexts[pos], `badge ${pos}`).toBe(want)
    }
  })

  test('bộ lọc khoảng ngày (1 ngày) → doanh thu đổi nhưng trạng thái thưởng + card GIỮ NGUYÊN (snapshot toàn kỳ)', async ({ page }) => {
    await page.goto(`/targets/campaigns/${campaignId}?tab=result&from=${START}&to=${START}`)
    await expect(page.getByRole('columnheader', { name: 'Số đơn / Ngưỡng' })).toBeVisible()
    const ranged = await bonusTexts(page)
    expect(ranged).toEqual(fullViewTexts)
  })

  test('export XLSX: 21 cột cũ + 5 cột thưởng thêm ở CUỐI, giá trị khớp DB; tiền thưởng chỉ ghi khi ĐẠT', async ({ page }) => {
    const res = await page.request.get(EXPORT(campaignId as string))
    expect(res.status()).toBe(200)
    const wb = XLSX.read(await res.body(), { type: 'buffer' })
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]])
    expect(rows.length).toBe(3)
    const keys = Object.keys(rows[0])
    expect(keys.slice(-5)).toEqual(['Ngưỡng đơn tối thiểu', 'Số đơn Affiliate', 'Tổng số đơn', 'Đạt thưởng thêm', 'Thưởng thêm/dược sĩ'])
    expect(keys.slice(0, 8)).toEqual(['Chiến dịch', 'Từ ngày', 'Đến ngày', 'POS', 'Cửa hàng', 'Phân loại', 'KPI target', 'Actual GMV'])
    for (const r of rows) {
      const pos = String(r['POS'])
      const f = FIXTURE.find((x) => x.pos === pos)!
      const a = actuals.find((x) => posByStore.get(x.store_id) === pos)!
      expect(r['Ngưỡng đơn tối thiểu'], pos).toBe(f.threshold)
      expect(r['Số đơn Affiliate'], pos).toBe(a.affiliate_order_count)
      expect(r['Tổng số đơn'], pos).toBe(a.bonus_order_count ?? '')
      expect(r['Đạt thưởng thêm'], pos).toBe(a.order_bonus_achieved === true ? 'Đạt' : a.order_bonus_achieved === false ? 'Chưa đạt' : 'Chưa đủ dữ liệu')
      expect(r['Thưởng thêm/dược sĩ'], pos).toBe(a.order_bonus_achieved === true ? BONUS_PER_STAFF : '')
      expect(r['Commission pool'], `${pos}: pool không cộng thưởng thêm`).toBe(a.store_commission_pool === null ? '' : Number(a.store_commission_pool))
    }
  })

  test('Staff và SM KHÔNG thấy fixture is_test qua RLS — không rò ra dược sĩ thật', async () => {
    test.skip(!STAFF.email || !STAFF.password || !SM.email || !SM.password, 'thiếu E2E_STAFF_* / E2E_SM_*')
    for (const [role, cred] of [['staff', STAFF], ['sm', SM]] as const) {
      const db = await sessionDb(cred.email as string, cred.password as string)
      const t = must<{ id: string }[]>(await db.from('kpi_campaign_store_targets').select('id').eq('campaign_id', campaignId as string), `${role} đọc targets`)
      const c = must<{ id: string }[]>(await db.from('kpi_campaigns').select('id').eq('id', campaignId as string), `${role} đọc campaign`)
      expect(t.length, `${role} không được thấy target của fixture is_test`).toBe(0)
      expect(c.length, `${role} không được thấy campaign fixture is_test`).toBe(0)
      await db.auth.signOut()
    }
  })
})
