import { test, expect } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
// r1.3.1: lõi thuần của proof script — test SYNTHETIC thay vì chỉ source-text.
import {
  buildPointByCode, qualifyOrders, dedupWinners, crossStoreCases,
  scopePoints, classifyMissingAccount, buildGateReport, runtimeReadiness,
} from '../scripts/lib-customer-proof.mjs'

// Mig 103 r1.1 (audit P1 tooling) — gate an toàn của 2 script QA/proof phải
// FAIL-FAST trước mọi kết nối/ghi. Test bằng cách SPAWN node thật: các exit
// đều xảy ra TRƯỚC khi client Supabase/Mongo được dùng → không network, không
// DB. Cần .env.local (URL/key kết nối) — thiếu thì skip (máy dev/QA luôn có).
// + SOURCE-TEXT lock (pattern kpi-net-revenue-source): safety flag phải đọc
// từ process.env (không phải env-file object) và schema preflight phải abort.

const execFileP = promisify(execFile)
const HAS_ENV_LOCAL = fs.existsSync('.env.local')

// Strip mọi QA_* khỏi env kế thừa — test kiểm soát chính xác biến nào có mặt.
function baseEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(e)) if (k.startsWith('QA_')) delete e[k]
  return e
}
async function runScript(script: string, extra: Record<string, string> = {}) {
  try {
    const r = await execFileP('node', [script], { env: { ...baseEnv(), ...extra }, timeout: 30_000 })
    return { code: 0, out: r.stdout + r.stderr }
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string }
    return { code: err.code ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

test.describe('qa tooling safety gates (mig 103 r1.1) @desktop', () => {
  test('qa-kpi-customer-103: thiếu TỪNG safety flag (process env) → exit 2 fail-fast, thông điệp đúng biến', async () => {
    test.skip(!HAS_ENV_LOCAL, 'cần .env.local (URL/key) — script đọc file trước khi tới gate')
    const a = await runScript('scripts/qa-kpi-customer-103.mjs')
    expect(a.code).toBe(2)
    expect(a.out).toContain('QA_KPI_CUSTOMER_FIXTURE_ALLOWED')

    const b = await runScript('scripts/qa-kpi-customer-103.mjs', { QA_KPI_CUSTOMER_FIXTURE_ALLOWED: 'YES' })
    expect(b.code).toBe(2)
    expect(b.out).toContain('QA_AFFILIATE_CRON_PAUSED')

    const c = await runScript('scripts/qa-kpi-customer-103.mjs', {
      QA_KPI_CUSTOMER_FIXTURE_ALLOWED: 'YES',
      QA_AFFILIATE_CRON_PAUSED: 'YES',
      QA_EXPECTED_SUPABASE_URL: 'https://sai-project.example.com',
    })
    expect(c.code).toBe(2)
    expect(c.out).toContain('QA_EXPECTED_SUPABASE_URL')
  })

  test('proof script: QA_CUSTOMER_FROM/TO không hợp lệ → exit 1 fail-fast TRƯỚC khi kết nối', async () => {
    test.skip(!HAS_ENV_LOCAL, 'cần .env.local — script check URI trước khi tới validate range')
    // range đảo
    const a = await runScript('scripts/proof-affiliate-account-id.mjs',
      { QA_CUSTOMER_FROM: '2026-08-10', QA_CUSTOMER_TO: '2026-08-01' })
    expect(a.code).toBe(1)
    expect(a.out).toContain('QA_CUSTOMER_FROM')
    // thiếu 1 nửa cặp
    const b = await runScript('scripts/proof-affiliate-account-id.mjs', { QA_CUSTOMER_FROM: '2026-08-01' })
    expect(b.code).toBe(1)
    expect(b.out).toContain('đi CẶP')
    // ngày lịch không tồn tại
    const c = await runScript('scripts/proof-affiliate-account-id.mjs',
      { QA_CUSTOMER_FROM: '2026-02-31', QA_CUSTOMER_TO: '2026-03-05' })
    expect(c.code).toBe(1)
    expect(c.out).toContain('sai định dạng')
  })

  test('SOURCE-TEXT lock: safety flags đọc từ PROCESS ENV; schema preflight ABORT (không out-rồi-chạy-tiếp)', () => {
    const qa = fs.readFileSync('scripts/qa-kpi-customer-103.mjs', 'utf8')
    for (const flag of ['QA_KPI_CUSTOMER_FIXTURE_ALLOWED', 'QA_AFFILIATE_CRON_PAUSED', 'QA_EXPECTED_SUPABASE_URL']) {
      expect(qa).toContain(`process.env.${flag}`)
      // không còn đọc từ env-file object (env.QA_* mà không có tiền tố process.)
      expect(new RegExp(`(?<!process\\.)env\\.${flag}`).test(qa), `${flag} không được đọc từ .env.local`).toBe(false)
    }
    expect(qa).toContain("abort('preflight schema:")
    expect(qa).toContain('không đếm được delivered thiếu account_id')

    const proof = fs.readFileSync('scripts/proof-affiliate-account-id.mjs', 'utf8')
    expect(proof).toContain('process.env.QA_CUSTOMER_FROM')
    expect(proof).toContain('process.env.QA_CUSTOMER_TO')
    // exact-range dedup toàn range (mirror RPC) + monthly chỉ là diagnostic
    expect(proof).toContain('EXACT RANGE')
    expect(proof).toContain('DIAGNOSTIC theo tháng VN')
    // r1.3: phân loại missing_account + cross-store in-range + JSON summary
    expect(proof).toContain('os_in_range_qualifying')
    expect(proof).toContain('R1.3 DIAGNOSTIC')
    expect(proof).toContain('=== JSON SUMMARY ===')
  })
})

// ── r1.3.1: SYNTHETIC tests cho lõi proof (8 case auditor + label-collision) ─
type MapOver = { mapActive?: boolean; type?: string; storeActive?: boolean; code?: string | null }
const M = (partner: string, storeId: string | null, over: MapOver = {}) => ({
  partner_code: partner,
  store_id: storeId,
  is_active: over.mapActive ?? true,
  stores: storeId
    ? { code: over.code === undefined ? `POS-${storeId}` : over.code, store_type: over.type ?? 'os', is_active: over.storeActive ?? true }
    : null,
})
const O = (acc: number, orderId: number, partnerCode: string, t: number, price = 100_000) =>
  ({ acc, orderId, price, completedTimeMs: t, partnerCode })

test.describe('lib-customer-proof synthetic (mig 103 r1.3.1) @desktop', () => {
  const points = buildPointByCode([
    M('OS-A', 's1'),                              // OS active
    M('OS-B', 's2'),                              // OS active thứ hai
    M('FS-STORE', 's3', { type: 'fs' }),          // FS CÓ store — phải bị loại
    M('OS-DEAD', 's4', { storeActive: false }),   // OS nhưng store inactive
    M('OS-MAPOFF', 's5', { mapActive: false }),   // OS nhưng MAPPING inactive
    M('PARTNER', null),                            // fs partner không store
  ])

  test('eligibility: OS active vào baseline; FS-store/OS-inactive/mapping-inactive bị LOẠI nhưng đếm riêng', () => {
    const { osActive, allStorePoints, excluded } = qualifyOrders([
      O(1, 1, 'OS-A', 1000),
      O(2, 2, 'FS-STORE', 1000),   // fs_or_non_os
      O(3, 3, 'OS-DEAD', 1000),    // os_inactive (store inactive)
      O(4, 4, 'OS-MAPOFF', 1000),  // os_inactive (mapping inactive)
      O(5, 5, 'PARTNER', 1000),    // non_store_point
      O(6, 6, 'OS-A', 1000, -50),  // non_positive
      O(7, 7, 'OS-A', null as unknown as number, 100), // thiếu completed → no_completed_time
    ], points)
    expect(osActive.map((q) => q.acc)).toEqual([1])
    // allStorePoints = mọi điểm có store (kể cả FS + OS inactive) đã qua giá/completed
    expect(allStorePoints.map((q) => q.acc).sort()).toEqual([1, 2, 3, 4])
    expect(excluded).toEqual({
      non_positive: 1, no_completed_time: 1, non_store_point: 1,
      fs_or_non_os: 1, os_inactive: 2, pos_filtered: 0,
    })
  })

  test('posFilter subset: đơn ngoài tập POS bị loại + đếm pos_filtered', () => {
    const { osActive, excluded } = qualifyOrders(
      [O(1, 1, 'OS-A', 1000), O(2, 2, 'OS-B', 1000)],
      points, new Set(['POS-s1']))
    expect(osActive.map((q) => q.acc)).toEqual([1])
    expect(excluded.pos_filtered).toBe(1)
  })

  test('dedup: 1 account nhiều đơn cùng OS → 1 khách, WINNER đơn sớm nhất', () => {
    const best = dedupWinners(qualifyOrders(
      [O(9, 11, 'OS-A', 3000), O(9, 12, 'OS-A', 1000), O(9, 13, 'OS-A', 2000)],
      points).osActive)
    expect(best.size).toBe(1)
    expect(best.get(9)!.orderId).toBe(12) // t=1000 sớm nhất thắng
  })

  test('dedup tie-break: cùng completed_time → order_id NHỎ hơn thắng', () => {
    const best = dedupWinners(qualifyOrders(
      [O(9, 22, 'OS-B', 1000), O(9, 21, 'OS-A', 1000)],
      points).osActive)
    expect(best.get(9)!.orderId).toBe(21)
  })

  test('cross-store: 1 account tại 2 OS khác nhau → 1 case, winner theo earliest; cùng 1 OS → không case', () => {
    const { osActive } = qualifyOrders([
      O(1, 1, 'OS-A', 2000), O(1, 2, 'OS-B', 1000),  // cross → winner OS-B
      O(2, 3, 'OS-A', 1000), O(2, 4, 'OS-A', 2000),  // cùng điểm → không cross
    ], points)
    const cases = crossStoreCases(osActive)
    expect(cases).toHaveLength(1)
    expect(cases[0].account).toBe(1)
    expect(cases[0].winner.orderId).toBe(2)
    expect(cases[0].winner.pointKey).toBe('store:s2')
  })

  test('identity = pointKey, KHÔNG phải label: 2 store KHÁC nhau trùng tên POS vẫn là cross-store', () => {
    const twin = buildPointByCode([
      M('T-A', 'sx', { code: 'POS-TRUNG' }),
      M('T-B', 'sy', { code: 'POS-TRUNG' }), // label giống hệt, store khác
    ])
    const { osActive } = qualifyOrders([O(1, 1, 'T-A', 1000), O(1, 2, 'T-B', 2000)], twin)
    const cases = crossStoreCases(osActive)
    expect(cases).toHaveLength(1) // label-based sẽ ra 0 — khóa P2#3
    expect(new Set(cases[0].orders.map((o) => o.pointKey)).size).toBe(2)
  })
})

// ── r1.3.2: SYNTHETIC tests — subset/missing-account/scoped-vs-global gates ──
test.describe('lib-customer-proof r1.3.2 (scoped release gates) @desktop', () => {
  const points = buildPointByCode([
    M('OS-A', 's1'), M('OS-A2', 's1'),            // 2 code CÙNG store — dedupe metadata
    M('OS-B', 's2'),
    M('FS-STORE', 's3', { type: 'fs' }),
    M('OS-DEAD', 's4', { storeActive: false }),
  ])
  const RANGE = { from: 1000, to: 2000 }
  const MISS = (orderId: number, partnerCode: string, t: number | null, price: number | null = 100) =>
    ({ orderId, price, completedTimeMs: t, partnerCode })

  test('classifyMissingAccount: OS active trong range → os_in_range_qualifying; NGOÀI posFilter → os_outside_pos_filter (không block scoped)', () => {
    const noFilter = classifyMissingAccount([MISS(1, 'OS-B', 1500)], points, RANGE, null)
    expect(noFilter.os_in_range_qualifying).toHaveLength(1)

    // cùng đơn đó, filter chỉ POS-s1 → rơi os_outside_pos_filter, KHÔNG vào bucket quyết định
    const filtered = classifyMissingAccount(
      [MISS(1, 'OS-B', 1500), MISS(2, 'OS-A', 1500)], points, RANGE, new Set(['POS-s1']))
    expect(filtered.os_in_range_qualifying.map((e) => e.order_id)).toEqual([2])
    expect(filtered.os_outside_pos_filter.map((e) => e.order_id)).toEqual([1])
    // các bucket khác vẫn đúng precedence
    const other = classifyMissingAccount([
      MISS(3, 'FS-STORE', 1500), MISS(4, 'OS-DEAD', 1500),
      MISS(5, 'OS-A', 1500, -1), MISS(6, 'OS-A', null), MISS(7, 'OS-A', 5000),
    ], points, RANGE, null)
    expect(other.non_os_point).toHaveLength(1)
    expect(other.os_inactive_point).toHaveLength(1)
    expect(other.disqualified_price_or_time).toHaveLength(2)
    expect(other.os_out_of_range).toHaveLength(1)
  })

  test('scopePoints: unique theo store_id (2 partner code cùng store = 1 điểm) + áp posFilter', () => {
    const all = scopePoints(points)
    expect(all.map((pt) => pt.storeId).sort()).toEqual(['s1', 's2']) // FS + inactive loại; s1 KHÔNG lặp
    const sub = scopePoints(points, new Set(['POS-s2']))
    expect(sub.map((pt) => pt.storeId)).toEqual(['s2'])
  })

  test('buildGateReport: global FAIL nhưng scoped SẠCH → exit 0; thiếu range → exit 1; scoped fail → exit 1', () => {
    const base = {
      rangeProvided: true,
      eligibleMissingAccount: 0, eligibleMissingCustomer: 0, eligibleCrossStore: 0,
      runtimeMissingAccount: 0, runtimeMissingCompleted: 0,
      globalMissingAccount: 12, globalMissingCustomer: 3, globalCrossStore: 5,
    }
    const ok = buildGateReport(base)
    expect(ok.exitCode).toBe(0)                                  // global chỉ diagnostic
    expect(ok.diagnostic.every(([, pass]) => pass === false)).toBe(true)

    expect(buildGateReport({ ...base, rangeProvided: false }).exitCode).toBe(1)
    expect(buildGateReport({ ...base, eligibleMissingAccount: 1 }).exitCode).toBe(1)
    expect(buildGateReport({ ...base, eligibleCrossStore: 2 }).exitCode).toBe(1)
    // r1.3.3: metric scoped PASS nhưng runtime readiness FAIL → exit ≠ 0
    expect(buildGateReport({ ...base, runtimeMissingAccount: 1 }).exitCode).toBe(1)
    expect(buildGateReport({ ...base, runtimeMissingCompleted: 1 }).exitCode).toBe(1)
  })

  test('SOURCE-TEXT: exit gate tách RELEASE/DIAGNOSTIC, không còn tham chiếu migration 103', () => {
    const proof = fs.readFileSync('scripts/proof-affiliate-account-id.mjs', 'utf8')
    expect(proof).toContain('RELEASE DECISION GATES')
    expect(proof).toContain('DIAGNOSTIC GATES')
    expect(proof).toContain('os_outside_pos_filter')
    expect(proof).toContain('release_decision_gates')
    // thông báo cũ sai giai đoạn (103 đã chạy) phải biến mất
    expect(proof).not.toContain('điều kiện chạy migration 103')
    expect(proof).not.toContain('tiến hành migration 103')
  })
})

// ── r1.3.3: RUNTIME READINESS — mirror canary RPC 103 (không range/giá) ─────
test.describe('lib-customer-proof r1.3.3 (runtime readiness) @desktop', () => {
  const points = buildPointByCode([
    M('OS-A', 's1'), M('OS-B', 's2'),
    M('FS-STORE', 's3', { type: 'fs' }),
    M('OS-DEAD', 's4', { storeActive: false }),
  ])
  const R = (orderId: number, partnerCode: string, hasAccount: boolean, hasCompleted: boolean) =>
    ({ orderId, partnerCode, hasAccount, hasCompleted })

  test('đơn thiếu account_id NGOÀI mọi range vẫn bị đếm (không có khái niệm range); thiếu completed_time cũng vậy — kể cả đơn có account', () => {
    const r = runtimeReadiness([
      R(1, 'OS-A', false, true),   // thiếu account — runtime canary bắt
      R(2, 'OS-A', true, false),   // CÓ account nhưng thiếu completed_time
      R(3, 'OS-B', true, true),    // sạch
      R(4, 'OS-A', false, false),  // thiếu CẢ HAI → vào cả 2 danh sách
    ], points)
    expect(r.missingAccount.map((e) => e.order_id)).toEqual([1, 4])
    expect(r.missingCompleted.map((e) => e.order_id)).toEqual([2, 4])
  })

  test('scoped đúng: FS-store/OS-inactive KHÔNG tính; posFilter loại store ngoài subset', () => {
    const rows = [
      R(1, 'FS-STORE', false, false),  // ngoài scope OS active
      R(2, 'OS-DEAD', false, false),   // store inactive — RPC không target được
      R(3, 'OS-B', false, true),
    ]
    const all = runtimeReadiness(rows, points)
    expect(all.missingAccount.map((e) => e.order_id)).toEqual([3])
    const sub = runtimeReadiness(rows, points, new Set(['POS-s1']))
    expect(sub.missingAccount).toEqual([])   // OS-B ngoài subset
    expect(sub.missingCompleted).toEqual([])
  })

  test('SOURCE-TEXT: proof có tầng RUNTIME READINESS + summary 3 khối + nhắc verify Supabase sau full-sync', () => {
    const proof = fs.readFileSync('scripts/proof-affiliate-account-id.mjs', 'utf8')
    expect(proof).toContain('RUNTIME READINESS GATES')
    expect(proof).toContain('runtime_readiness_gates')
    expect(proof).toContain('overall_pass')
    // P2#3: proof = predictor trên Mongo; gate Supabase sau deploy+full-sync
    expect(proof).toContain('verify TRỰC TIẾP Supabase')
    expect(proof).toContain("status_norm = 'delivered'")
    // r1.3.4: SQL verify theo ĐÚNG scope proof (scopedPoints, không phải toàn
    // bộ OS khi có subset) + exit không dùng process.exit ngay sau close
    // (abort 0xC0000409 teardown Mongo driver trên Windows → exit code rác)
    expect(proof).toContain("scopedPoints.map((pt) => \"'\" + pt.storeId + \"'\")")
    expect(proof).toContain('process.exitCode = exitCode')
    // r1.3.5 (audit P2): timestamp evidence trong JSON summary
    expect(proof).toContain('generated_at')
    expect(proof).toContain('max_order_updated_at')
  })
})
