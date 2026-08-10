import { test, expect } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
// r1.3.1: lõi thuần của proof script — test SYNTHETIC thay vì chỉ source-text.
import {
  buildPointByCode, qualifyOrders, dedupWinners, crossStoreCases,
  scopePoints, classifyMissingIdentity, buildGateReport, runtimeReadiness,
  normalizeVnPhone as normalizeVnPhoneProof,
} from '../scripts/lib-customer-proof.mjs'
// mig 104: bản TS dùng trong app (ingestion) — spec so PARITY với bản .mjs
// của proof để 2 implementation không bao giờ lệch.
import { normalizeVnPhone, maskVnPhone } from '../lib/affiliate/phone'
import { validateSourceOrder } from '../lib/affiliate/normalize'

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
    // mig 104: preflight đếm thiếu IDENTITY = customer_phone_norm
    expect(qa).toContain('không đếm được delivered thiếu customer_phone_norm')

    const proof = fs.readFileSync('scripts/proof-affiliate-account-id.mjs', 'utf8')
    expect(proof).toContain('process.env.QA_CUSTOMER_FROM')
    expect(proof).toContain('process.env.QA_CUSTOMER_TO')
    // exact-range dedup toàn range (mirror RPC) + monthly chỉ là diagnostic
    expect(proof).toContain('EXACT RANGE')
    expect(proof).toContain('DIAGNOSTIC theo tháng VN')
    // r1.3: phân loại missing identity + cross-store in-range + JSON summary
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
    const noFilter = classifyMissingIdentity([MISS(1, 'OS-B', 1500)], points, RANGE, null)
    expect(noFilter.os_in_range_qualifying).toHaveLength(1)

    // cùng đơn đó, filter chỉ POS-s1 → rơi os_outside_pos_filter, KHÔNG vào bucket quyết định
    const filtered = classifyMissingIdentity(
      [MISS(1, 'OS-B', 1500), MISS(2, 'OS-A', 1500)], points, RANGE, new Set(['POS-s1']))
    expect(filtered.os_in_range_qualifying.map((e) => e.order_id)).toEqual([2])
    expect(filtered.os_outside_pos_filter.map((e) => e.order_id)).toEqual([1])
    // các bucket khác vẫn đúng precedence
    const other = classifyMissingIdentity([
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

  test('buildGateReport (mig 104): gate cứng = PHONE + completed_time; account/customer chỉ diagnostic → KHÔNG đổi exit', () => {
    const base = {
      rangeProvided: true,
      eligibleMissingPhone: 0, eligibleCrossStore: 0,
      runtimeMissingPhone: 0, runtimeMissingCompleted: 0,
      globalMissingPhone: 0, globalMissingAccount: 14, globalMissingCustomer: 4, globalCrossStore: 5,
    }
    const ok = buildGateReport(base)
    // 14 đơn thiếu account + 4 account vắng customer + 5 cross-store lịch sử
    // KHÔNG còn chặn (contract 09/08) — chỉ nằm ở diagnostic.
    expect(ok.exitCode).toBe(0)
    expect(ok.diagnostic.some(([label]) => String(label).includes('account_id'))).toBe(true)

    expect(buildGateReport({ ...base, rangeProvided: false }).exitCode).toBe(1)
    expect(buildGateReport({ ...base, eligibleMissingPhone: 1 }).exitCode).toBe(1)
    expect(buildGateReport({ ...base, eligibleCrossStore: 2 }).exitCode).toBe(1)
    // metric scoped PASS nhưng runtime readiness FAIL → exit ≠ 0
    expect(buildGateReport({ ...base, runtimeMissingPhone: 1 }).exitCode).toBe(1)
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
  const R = (orderId: number, partnerCode: string, over: Partial<{ hasPhone: boolean; hasAccount: boolean; hasCompleted: boolean; price: number | null }> = {}) =>
    ({ orderId, partnerCode, hasPhone: true, hasAccount: true, hasCompleted: true, price: 100_000, ...over })

  test('mig 104: canary PHONE trên đơn đủ điều kiện (NGOÀI mọi range vẫn tính); completed_time canary MỌI đơn; account chỉ diagnostic', () => {
    const r = runtimeReadiness([
      R(1, 'OS-A', { hasPhone: false }),                    // thiếu phone → BLOCKING
      R(2, 'OS-A', { hasCompleted: false }),                // thiếu completed_time
      R(3, 'OS-B'),                                         // sạch
      R(4, 'OS-A', { hasAccount: false }),                  // chỉ diagnostic
      R(5, 'OS-A', { hasPhone: false, price: 0 }),          // giá ≤0 → không tham gia đếm
      R(6, 'OS-A', { hasPhone: false, hasCompleted: false }), // chưa completed → chưa tính phone
    ], points)
    expect(r.missingPhone.map((e) => e.order_id)).toEqual([1])
    expect(r.missingCompleted.map((e) => e.order_id)).toEqual([2, 6])
    expect(r.missingAccountDiagnostic.map((e) => e.order_id)).toEqual([4])
  })

  test('scoped đúng: FS-store/OS-inactive KHÔNG tính; posFilter loại store ngoài subset', () => {
    const rows = [
      R(1, 'FS-STORE', { hasPhone: false }),  // ngoài scope OS active
      R(2, 'OS-DEAD', { hasPhone: false }),   // store inactive — RPC không target được
      R(3, 'OS-B', { hasPhone: false }),
    ]
    const all = runtimeReadiness(rows, points)
    expect(all.missingPhone.map((e) => e.order_id)).toEqual([3])
    const sub = runtimeReadiness(rows, points, new Set(['POS-s1']))
    expect(sub.missingPhone).toEqual([])   // OS-B ngoài subset
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
    // mig 104: identity = phone; account/customer xuống diagnostic; KHÔNG
    // bao giờ pull receiver_phone_number.
    expect(proof).toContain('customer_phone: 1')
    // receiver_phone_number chỉ được phép xuất hiện trong COMMENT cảnh báo —
    // TUYỆT ĐỐI không trong projection/code.
    const proofCode = proof.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    expect(proofCode).not.toContain('receiver_phone_number')
    expect(proof).toContain('missing_customer_phone')
    expect(proof).toContain('missing_account_id_diagnostic')
  })
})

// ── mig 104: IDENTITY = normalized buyer phone (8 case contract 09/08) ──────
test.describe('customer identity = normalized phone (mig 104) @desktop', () => {
  test('1. 091…/8491…/+8491…/0084…/khoảng trắng-chấm-gạch → CÙNG một identity', () => {
    const variants = [
      '0912345678', '912345678', '84912345678', '+84912345678', '0084912345678',
      '84 0912345678', ' 0912345678 ', '091.234.5678', '091-234-5678', '(091) 234 5678',
    ]
    for (const v of variants) {
      expect(normalizeVnPhone(v), `variant: ${v}`).toBe('0912345678')
    }
  })

  test('2. Không hợp lệ → null (KHÔNG đoán, KHÔNG lưu rác): landline, quá ngắn/dài, đầu số lạ, rỗng, non-string', () => {
    for (const bad of ['0281234567', '02812345', '09123456789', '0112345678', '', '   ', 'abc', '+1 415 555 0100']) {
      expect(normalizeVnPhone(bad), `bad: ${bad}`).toBeNull()
    }
    expect(normalizeVnPhone(null)).toBeNull()
    expect(normalizeVnPhone(undefined)).toBeNull()
    expect(normalizeVnPhone(912345678 as unknown as string)).toBeNull()
  })

  test('3. PARITY: bản TS (app/ingestion) và bản .mjs (proof) cho KẾT QUẢ y hệt', () => {
    const fixtures = [
      '0912345678', '912345678', '+84 903 961 280', '0084866101623', '0977982089',
      '0281234567', '', 'x', '84987654321', '0339410277', '0762528984', '09123456789',
    ]
    for (const f of fixtures) {
      expect(normalizeVnPhoneProof(f), `parity: ${f}`).toBe(normalizeVnPhone(f))
    }
  })

  test('4. Ingestion: validateSourceOrder set customer_phone_norm từ BUYER phone; receiver_phone_number KHÔNG ảnh hưởng', () => {
    const doc = {
      order_id: 1, affiliate_partner_code: 'CIRCA-A', status: 'DELIVERED',
      created_time: '2026-08-01T00:00:00.000Z', total_price: 100_000,
      customer_phone: '+84 912 345 678',
      // field người NHẬN — không có trong projection; kể cả lọt vào doc cũng
      // tuyệt đối không được dùng làm identity.
      receiver_phone_number: '0987654321',
    } as unknown as Parameters<typeof validateSourceOrder>[0]
    const r = validateSourceOrder(doc)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.row.customer_phone_norm).toBe('0912345678')
      expect(r.row.customer_phone_norm).not.toBe('0987654321')
    }
  })

  test('5. Phone hỏng KHÔNG reject đơn — chỉ mất identity (fail-visible ở canary/RPC)', () => {
    const base = {
      order_id: 2, affiliate_partner_code: 'CIRCA-A', status: 'DELIVERED',
      created_time: '2026-08-01T00:00:00.000Z', total_price: 100_000,
    }
    for (const phone of ['0281234567', '', undefined]) {
      const r = validateSourceOrder({ ...base, customer_phone: phone } as unknown as Parameters<typeof validateSourceOrder>[0])
      expect(r.ok).toBe(true)          // đơn vẫn upsert đủ (mirror completed_time)
      if (r.ok) expect(r.row.customer_phone_norm).toBeNull()
    }
  })

  test('6. Dedup theo phone: account null vs account có giá trị NHƯNG cùng phone = MỘT khách; nhiều đơn cùng phone = một', () => {
    const points = buildPointByCode([
      { partner_code: 'OS-A', store_id: 's1', is_active: true, stores: { code: 'POS-s1', store_type: 'os', is_active: true } },
    ])
    const q = qualifyOrders([
      { acc: '0912345678', orderId: 11, price: 100, completedTimeMs: 3000, partnerCode: 'OS-A' }, // account null (nguồn)
      { acc: '0912345678', orderId: 12, price: 100, completedTimeMs: 1000, partnerCode: 'OS-A' }, // account có
      { acc: '0912345678', orderId: 13, price: 100, completedTimeMs: 2000, partnerCode: 'OS-A' },
    ], points)
    const best = dedupWinners(q.osActive)
    expect(best.size).toBe(1)
    expect(best.get('0912345678')!.orderId).toBe(12)   // đơn sớm nhất thắng
  })

  test('7. Cross-store theo phone: winner = đơn sớm nhất TRONG tập đưa vào (range đã lọc trước); tie → order_id nhỏ', () => {
    const points = buildPointByCode([
      { partner_code: 'OS-A', store_id: 's1', is_active: true, stores: { code: 'POS-s1', store_type: 'os', is_active: true } },
      { partner_code: 'OS-B', store_id: 's2', is_active: true, stores: { code: 'POS-s2', store_type: 'os', is_active: true } },
    ])
    const { osActive } = qualifyOrders([
      { acc: '0905375560', orderId: 24631, price: 100, completedTimeMs: 1000, partnerCode: 'OS-A' },
      { acc: '0905375560', orderId: 25001, price: 100, completedTimeMs: 5000, partnerCode: 'OS-B' },
    ], points)
    const cases = crossStoreCases(osActive)
    expect(cases).toHaveLength(1)
    expect(cases[0].winner.orderId).toBe(24631)        // 04/08 thắng 08/08
    expect(cases[0].winner.pointKey).toBe('store:s1')
    // tie-break: cùng thời điểm → order_id nhỏ hơn
    const tie = dedupWinners(qualifyOrders([
      { acc: '0937425337', orderId: 24990, price: 100, completedTimeMs: 7000, partnerCode: 'OS-B' },
      { acc: '0937425337', orderId: 24984, price: 100, completedTimeMs: 7000, partnerCode: 'OS-A' },
    ], points).osActive)
    expect(tie.get('0937425337')!.orderId).toBe(24984)
  })

  test('8. maskVnPhone: log/diagnostic không lộ số đầy đủ', () => {
    expect(maskVnPhone('0905375560')).toBe('0905***560')
    expect(maskVnPhone('0905375560')).not.toMatch(/^0\d{9}$/)
    expect(maskVnPhone('bad')).toBe('***')
  })
})

// ── SOURCE-TEXT: contract identity trong migration 104 + ingestion ──────────
test.describe('mig 104 source contract @desktop', () => {
  const sql = fs.readFileSync('../supabase/migrations/104_kpi_customer_phone_identity.sql', 'utf8')

  test('RPC aggregate: dedup theo customer_phone_norm, canary phone CHỈ trong range, KHÔNG còn account_id, sample MASK', () => {
    const agg = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.rpc_aggregate_affiliate_customers'),
                          sql.indexOf('CREATE OR REPLACE FUNCTION public.rpc_activate_kpi_campaign'))
    const code = agg.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    expect(code).toContain('DISTINCT ON (q.phone)')
    expect(code).toContain('o.customer_phone_norm IS NULL')
    expect(code).toContain('ORDER BY q.phone, q.completed_time ASC, q.order_id ASC')
    expect(code).toContain('cross_store_customer_count')
    expect(code).toContain("left(s.phone, 4) || '***' || right(s.phone, 3)")   // mask PII
    expect(code).not.toContain('account_id')                                    // identity cũ biến mất
    // canary phone gắn với range (đơn đủ điều kiện), completed_time thì không
    expect(code).toContain('o.completed_time >= p_from AND o.completed_time < p_to\n    AND o.customer_phone_norm IS NULL')
  })

  test('Activation gate: phone theo campaign range ∩ target stores; account KHÔNG chặn', () => {
    const act = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION public.rpc_activate_kpi_campaign'),
      sql.indexOf('REVOKE ALL ON FUNCTION public.rpc_activate_kpi_campaign'))
    const code = act.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    expect(code).toContain('v_nophone')
    expect(code).toContain('o.customer_phone_norm IS NULL')
    expect(code).toContain("v_c.start_date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'")
    expect(code).toContain("(v_c.end_date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'")
    expect(code).not.toContain('account_id')
    // giữ nguyên các guard 103 khác
    expect(code).toContain('daterange(c2.start_date, c2.end_date')
    expect(code).toContain('p_expected_run_id')
  })

  test('Cột + CHECK định dạng di động VN; GMV zero-touch (không đụng bảng/RPC GMV)', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS customer_phone_norm text')
    expect(sql).toContain("customer_phone_norm ~ '^0[35789][0-9]{8}$'")
    expect(sql).not.toContain('rpc_replace_campaign_actuals')
    expect(sql).not.toContain('kpi_campaign_store_daily_actuals')
  })
})
