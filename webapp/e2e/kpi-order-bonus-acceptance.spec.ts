import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import * as XLSX from 'xlsx'
import { SUPER_STATE } from './authState'
import { must, serviceDb, sessionDb, type Sb } from './dbFixtures'
import { ORDER_BONUS_MARKER, ORDER_BONUS_NAME_PREFIX, orderBonusWriteGate } from './writeQaGates'
import { bqQuery } from './bigqueryDirect'
import { expectOffline, sameBqRows, type BqDayRow } from './offlineRecon'

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE RUNTIME — thưởng thêm theo ngưỡng số đơn (migration 112, batch 113)
//
// Chạy trên DB đã áp 112, QA server localhost:3010 (flags như ghi ở memory
// feedback_qa_server_recipe). GHI FIXTURE is_test vào DB production ⇒ opt-in
// tường minh + 113.11 safety gate (e2e/writeQaGates.ts), đều là biến PROCESS
// tạm, KHÔNG đặt trong .env.local:
//   1. DISABLE Coolify Scheduled Task "Sync KPI campaign actuals".
//   2. $env:E2E_ORDER_BONUS_QA='1'
//      $env:E2E_KPI_SYNC_CRON_PAUSED='YES'
//      $env:E2E_EXPECTED_SUPABASE_HOST='<host của NEXT_PUBLIC_SUPABASE_URL>'
//   3. npx playwright test e2e/kpi-order-bonus-acceptance.spec.ts --project=desktop-chromium --workers=1
//   4. Remove-Item Env:E2E_ORDER_BONUS_QA, Env:E2E_KPI_SYNC_CRON_PAUSED, Env:E2E_EXPECTED_SUPABASE_HOST
//      rồi ENABLE lại task cron.
// Marker .qa-order-bonus-112.json ghi TRƯỚC khi tạo fixture, chỉ xoá sau khi
// hậu kiểm 0 dòng ⇒ process chết giữa chừng thì lần chạy sau bị chặn tới khi
// dọn tay (tên/id nằm trong marker).
//
// Đường đi là đường THẬT: target nạp qua rpc_replace_campaign_targets (RPC 112
// tự validate), đồng bộ bằng nút "Đồng bộ doanh số" của Super trên UI (server
// action → engine → rpc_replace_campaign_actuals tự tính trạng thái thưởng).
// Đối soát bằng NGUỒN ĐỘC LẬP với app: Offline đọc thẳng BigQuery bằng client
// riêng (e2e/bigqueryDirect.ts), Affiliate đếm thẳng sổ affiliate_orders.
//
// Fixture is_test bị RLS giấu khỏi Staff/QLCH/SM (can_read_kpi_campaign) —
// spec CHỨNG MINH điều đó với tài khoản CÓ phạm vi trên cửa hàng fixture. Phần
// "3 vai trò NHÌN THẤY thưởng thêm" chỉ chạy được trên campaign W2 thật sau
// deploy + nạp lại file v2 — spec này KHÔNG giả vờ đã làm việc đó.
// ─────────────────────────────────────────────────────────────────────────────

const QA_ON = process.env.E2E_ORDER_BONUS_QA === '1'
const SUPER = { email: process.env.E2E_SUPER_EMAIL, password: process.env.E2E_SUPER_PASSWORD }
const STAFF = { email: process.env.E2E_STAFF_EMAIL, password: process.env.E2E_STAFF_PASSWORD }
const QLCH = { email: process.env.E2E_QLCH_EMAIL, password: process.env.E2E_QLCH_PASSWORD }
const SM = { email: process.env.E2E_SM_EMAIL, password: process.env.E2E_SM_PASSWORD }

const EXPORT = (id: string) => `/api/export/kpi-campaigns?campaign_id=${id}`
const BONUS_PER_STAFF = 200_000
const START = '2026-09-10'
const END = '2026-09-16'
// Bảng Offline mà engine đọc (lib/targets/bigquery.ts). Spec khoá chuỗi này
// với code engine để một lần đổi nguồn không làm đối soát so nhầm bảng.
const BQ_OFFLINE_TABLE = 'lakehouse-prod-394907.buymed_tech.tech__circa_os_gmv_kpi'
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
  store_id: string; actual_value: number; actual_offline: number; offline_order_count: number | null
  affiliate_order_count: number | null; bonus_order_count: number | null
  order_bonus_achieved: boolean | null; store_commission_pool: number | null; synced_at: string
}

let sb: Sb
let campaignId: string | null = null
let campaignName = ''
let markerWritten = false
let effEnd = ''
const storeByPos = new Map<string, string>()
const posByStore = new Map<string, string>()
let actuals: ActualRow[] = []
let fullViewTexts: Record<string, string> = {}
let bqBefore: BqDayRow[] = []
let bqAfter: BqDayRow[] = []
let postSyncStamp = new Map<string, string>()

async function readActuals(): Promise<ActualRow[]> {
  return must<ActualRow[]>(await sb.from('kpi_campaign_store_actuals')
    .select('store_id, actual_value, actual_offline, offline_order_count, affiliate_order_count, bonus_order_count, order_bonus_achieved, store_commission_pool, synced_at')
    .eq('campaign_id', campaignId as string), 'đọc actuals fixture')
}

// Dòng DAY THÔ của 3 POS trong [START, effEnd] — không SUM ở SQL, để phần diễn
// giải (e2e/offlineRecon.ts) nằm trong code có unit test và đọc được từng ô.
async function readBqOffline(): Promise<BqDayRow[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effEnd)) throw new Error(`effEnd không hợp lệ: ${effEnd}`)
  const pos = FIXTURE.map((f) => `'${f.pos}'`).join(', ')
  return (await bqQuery(`
    SELECT pos_code, CAST(start_date AS STRING) AS d, offline_no_order, offline_net_revenue
    FROM \`${BQ_OFFLINE_TABLE}\`
    WHERE date_type = 'DAY' AND pos_code IN (${pos})
      AND start_date BETWEEN '${START}' AND '${effEnd}'
    ORDER BY pos_code, d`)) as unknown as BqDayRow[]
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
    // 113.11: cổng an toàn TRƯỚC mọi thao tác ghi — cron đã tạm dừng · đúng
    // project · không có fixture lần trước còn sót.
    const gate = orderBonusWriteGate({
      env: process.env,
      envFileText: fs.existsSync('.env.local') ? fs.readFileSync('.env.local', 'utf8') : null,
      markerExists: fs.existsSync(ORDER_BONUS_MARKER),
    })
    if (!gate.ok) throw new Error(`SAFETY GATE: ${gate.reason}`)
    effEnd = vnTodayISO() < END ? vnTodayISO() : END

    sb = await serviceDb()
    const mig = must<{ version: string }[]>(await sb.from('app_migrations').select('version').eq('version', '112'), 'đọc marker 112')
    expect(mig.length, 'migration 112 phải đã áp trên DB này').toBe(1)

    const stores = must<{ id: string; code: string }[]>(
      await sb.from('stores').select('id, code').in('code', FIXTURE.map((f) => f.pos)).eq('store_type', 'os').eq('is_active', true),
      'đọc 3 store fixture')
    expect(stores.length, 'đủ 3 OS store active').toBe(3)
    for (const s of stores) { storeByPos.set(s.code, s.id); posByStore.set(s.id, s.code) }

    campaignName = `${ORDER_BONUS_NAME_PREFIX}${Date.now()}`
    // Marker TRƯỚC khi insert: process chết ngay sau insert vẫn để lại tên duy nhất để dọn.
    const stamp = { name: campaignName, host: gate.host, createdAt: new Date().toISOString() }
    fs.writeFileSync(ORDER_BONUS_MARKER, JSON.stringify({ ...stamp, campaignId: null }))
    markerWritten = true
    const ins = must<{ id: string }[]>(await sb.from('kpi_campaigns').insert({
      name: campaignName, start_date: START, end_date: END, scope_type: 'store', metric_type: 'gmv',
      order_type: 'all', metric_offline: true, metric_affiliate: true, status: 'draft', is_test: true,
    }).select('id'), 'tạo campaign fixture')
    campaignId = ins[0].id
    fs.writeFileSync(ORDER_BONUS_MARKER, JSON.stringify({ ...stamp, campaignId }))

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
    // active để kiểm RLS có nghĩa (RLS còn lọc theo status). Cron nhặt cả is_test
    // active ⇒ đó là lý do gate đòi cron tạm dừng; test cuối kiểm lại synced_at.
    must(await sb.from('kpi_campaigns').update({ status: 'active' }).eq('id', campaignId).select('id'), 'activate fixture')
  })

  test.afterAll(async () => {
    if (!markerWritten) return
    // Xoá theo TÊN duy nhất (+ id khi đã biết) — dọn được cả khi insert đã ghi mà response mất.
    let del = sb.from('kpi_campaigns').delete().eq('name', campaignName).eq('is_test', true).like('name', `${ORDER_BONUS_NAME_PREFIX}%`)
    if (campaignId) del = del.eq('id', campaignId)
    const deleted = must<{ id: string }[]>(await del.select('id'), 'xoá fixture')
    const leftC = must<{ id: string }[]>(await sb.from('kpi_campaigns').select('id').eq('name', campaignName), 'hậu kiểm campaign')
    const leftT = campaignId
      ? must<{ id: string }[]>(await sb.from('kpi_campaign_store_targets').select('id').eq('campaign_id', campaignId), 'hậu kiểm targets') : []
    const leftA = campaignId
      ? must<{ id: string }[]>(await sb.from('kpi_campaign_store_actuals').select('id').eq('campaign_id', campaignId), 'hậu kiểm actuals') : []
    if ((campaignId && deleted.length !== 1) || leftC.length !== 0 || leftT.length !== 0 || leftA.length !== 0) {
      throw new Error(`CLEANUP HỎNG: deleted=${deleted.length} campaign_left=${leftC.length} targets_left=${leftT.length} actuals_left=${leftA.length} — GIỮ marker ${ORDER_BONUS_MARKER}, dọn tay ${campaignName} ${campaignId ?? ''}`)
    }
    fs.unlinkSync(ORDER_BONUS_MARKER)
    console.log(`cleanup: fixture ${campaignName} đã xoá, hậu kiểm 0/0/0`)
  })

  test('RPC 112 đã lưu ngưỡng + 200.000đ; cột bonus của actuals còn trống trước khi đồng bộ', async () => {
    const t = must<{ pos_code: string; minimum_order_target: number; order_bonus_per_staff: number }[]>(
      await sb.from('kpi_campaign_store_targets').select('pos_code, minimum_order_target, order_bonus_per_staff').eq('campaign_id', campaignId as string),
      'đọc targets fixture')
    expect(t.map((x) => [x.pos_code, x.minimum_order_target, Number(x.order_bonus_per_staff)]).sort())
      .toEqual(FIXTURE.map((f) => [f.pos, f.threshold, BONUS_PER_STAFF]).sort())
    expect((await readActuals()).length, 'chưa đồng bộ → chưa có actuals (cron không được ghi trước nút Đồng bộ)').toBe(0)
  })

  test('Super bấm "Đồng bộ doanh số" → RPC tự tính bonus_order_count + order_bonus_achieved đúng công thức', async ({ page }) => {
    test.setTimeout(240_000)
    // Đọc BigQuery TRƯỚC và SAU đồng bộ: hai lần phải trùng thì mới chắc nguồn
    // đứng yên trong lúc engine đọc (ngày hôm nay còn được BI nạp thêm).
    bqBefore = await readBqOffline()
    await page.goto(`/targets/campaigns/${campaignId}?tab=result`)
    await expect(page.getByRole('button', { name: 'Đồng bộ doanh số' })).toBeVisible()
    await page.getByRole('button', { name: 'Đồng bộ doanh số' }).click()
    // Chờ snapshot xuất hiện (BigQuery + Supabase; vài chục giây là bình thường).
    await expect.poll(async () => (await readActuals()).length, { timeout: 150_000, intervals: [2000] }).toBe(3)
    actuals = await readActuals()
    bqAfter = await readBqOffline()
    postSyncStamp = new Map(actuals.map((a) => [a.store_id, a.synced_at]))

    const targets = must<{ store_id: string; kpi_target: number; minimum_order_target: number }[]>(
      await sb.from('kpi_campaign_store_targets').select('store_id, kpi_target, minimum_order_target').eq('campaign_id', campaignId as string),
      'đọc targets')
    const tByStore = new Map(targets.map((t) => [t.store_id, t]))
    for (const a of actuals) {
      const t = tByStore.get(a.store_id)!
      const pos = posByStore.get(a.store_id) as string
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
  })

  test('đối soát Offline với BigQuery ĐỘC LẬP — doanh thu thuần + số đơn, từng ngày và cả kỳ, 3 POS', async () => {
    expect(actuals.length).toBe(3)
    expect(fs.readFileSync('lib/targets/bigquery.ts', 'utf8'), 'engine phải đọc cùng bảng BigQuery với đối soát này')
      .toContain(BQ_OFFLINE_TABLE)
    expect(sameBqRows(bqBefore, bqAfter), 'nguồn BigQuery đổi trong lúc đồng bộ (BI vừa nạp thêm) — chạy lại acceptance').toBe(true)
    const want = expectOffline(bqAfter, FIXTURE.map((f) => f.pos), START, effEnd)
    const daily = must<{ store_id: string; date: string; gmv: number; offline_order_count: number | null }[]>(
      await sb.from('kpi_campaign_store_daily_actuals').select('store_id, date, gmv, offline_order_count').eq('campaign_id', campaignId as string),
      'đọc daily fixture')
    const evidence: Record<string, unknown> = {}
    for (const a of actuals) {
      const pos = posByStore.get(a.store_id) as string
      const w = want.get(pos)!
      expect(Number(a.actual_offline), `${pos}: doanh thu thuần Offline cả kỳ = tổng ROUND từng ngày BigQuery`).toBe(w.revenue)
      expect(a.offline_order_count, `${pos}: số đơn Offline cả kỳ = SUM(offline_no_order) BigQuery [${START} → ${effEnd}]${w.degraded ? ` — degrade: ${w.degraded}` : ''}`)
        .toBe(w.orders)
      const mine = daily.filter((r) => r.store_id === a.store_id)
      expect(mine.map((r) => String(r.date).slice(0, 10)).sort(), `${pos}: daily có đủ từng ngày trong kỳ`).toEqual([...w.byDay.keys()].sort())
      for (const r of mine) {
        const d = String(r.date).slice(0, 10)
        const wd = w.byDay.get(d)!
        expect(Number(r.gmv), `${pos}/${d}: doanh thu thuần ngày`).toBe(wd.revenue)
        expect(r.offline_order_count, `${pos}/${d}: số đơn Offline ngày`).toBe(wd.orders)
      }
      evidence[pos] = {
        days: w.byDay.size, bq_orders: w.orders, sb_orders: a.offline_order_count,
        bq_revenue: w.revenue, sb_revenue: Number(a.actual_offline), degraded: w.degraded,
      }
    }
    console.log(`BONUS_QA_BQ_RECON=${JSON.stringify(evidence)} range=${START}..${effEnd}`)
  })

  test('đối soát số đơn Affiliate với sổ affiliate_orders (DELIVERED, source_active, partner_code, ngày VN theo completed_time)', async () => {
    expect(actuals.length).toBe(3)
    const from = `${START}T00:00:00+07:00`
    const to = `${nextDayISO(effEnd)}T00:00:00+07:00`
    const evidence: Record<string, number> = {}
    for (const a of actuals) {
      const pos = posByStore.get(a.store_id) as string
      const { count, error } = await sb.from('affiliate_orders').select('id', { count: 'exact', head: true })
        .eq('store_id', a.store_id).eq('status_norm', 'delivered').eq('source_active', true)
        .gte('completed_time', from).lt('completed_time', to)
      if (error) throw new Error(`đếm affiliate_orders ${pos}: ${error.message}`)
      expect(a.affiliate_order_count, `${pos}: affiliate_order_count = đếm sổ [${from} → ${to})`).toBe(count ?? 0)
      evidence[pos] = count ?? 0
    }
    console.log(`BONUS_QA_AFFILIATE=${JSON.stringify(evidence)}`)
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

  test('Staff, QLCH và SM KHÔNG thấy fixture is_test qua RLS — tài khoản có phạm vi trên cửa hàng fixture', async () => {
    test.skip(!STAFF.email || !STAFF.password || !QLCH.email || !QLCH.password || !SM.email || !SM.password,
      'thiếu E2E_STAFF_* / E2E_QLCH_* / E2E_SM_*')
    const fixtureStores = new Set(storeByPos.values())
    for (const [role, cred] of [['staff', STAFF], ['qlch', QLCH], ['sm', SM]] as const) {
      // Tiền điều kiện (service role): tài khoản PHẢI có phạm vi trên ≥1 cửa hàng
      // fixture. Không có thì "không thấy" chỉ do khác cửa hàng — chứng minh rỗng.
      const u = must<{ id: string; role: string; store_id: string | null }[]>(
        await sb.from('users').select('id, role, store_id').eq('email', cred.email as string), `${role} hồ sơ`)
      expect(u.length, `${role}: tài khoản phải tồn tại`).toBe(1)
      const scope = u[0].role === 'sm'
        ? must<{ store_id: string }[]>(await sb.from('sm_store_assignments').select('store_id').eq('sm_user_id', u[0].id), `${role} phân công`).map((r) => r.store_id)
        : [u[0].store_id]
      expect(scope.some((s) => s !== null && fixtureStores.has(s)), `${role}: phạm vi phải chạm cửa hàng fixture`).toBe(true)

      const db = await sessionDb(cred.email as string, cred.password as string)
      const t = must<{ id: string }[]>(await db.from('kpi_campaign_store_targets').select('id').eq('campaign_id', campaignId as string), `${role} đọc targets`)
      const c = must<{ id: string }[]>(await db.from('kpi_campaigns').select('id').eq('id', campaignId as string), `${role} đọc campaign`)
      const a = must<{ id: string }[]>(await db.from('kpi_campaign_store_actuals').select('id').eq('campaign_id', campaignId as string), `${role} đọc actuals`)
      expect(t.length, `${role} không được thấy target của fixture is_test`).toBe(0)
      expect(c.length, `${role} không được thấy campaign fixture is_test`).toBe(0)
      expect(a.length, `${role} không được thấy actuals của fixture is_test`).toBe(0)
      await db.auth.signOut()
    }
  })

  test('không có lượt đồng bộ thứ hai chen vào trong phiên QA — synced_at giữ nguyên từ lần bấm Đồng bộ', async () => {
    expect(postSyncStamp.size).toBe(3)
    const now = await readActuals()
    expect(new Map(now.map((a) => [a.store_id, a.synced_at])), 'synced_at đổi ⇒ cron hoặc một lượt sync khác đã ghi đè giữa phiên').toEqual(postSyncStamp)
  })
})
