import { test, expect } from '@playwright/test'
import {
  AFFILIATE_STALE_LIMIT_MINUTES,
  evaluateAffiliateSyncHealth,
  getAffiliateSyncHealth,
  type AffiliateHealthDb,
  type AffiliateLatestRun,
} from '../lib/affiliate/health'

// P3-A r1 unit gate — đủ MỌI trạng thái + boundary (audit 23/07). Pure logic +
// wrapper qua fake AffiliateHealthDb, không browser/DB thật.

const NOW = Date.parse('2026-07-23T10:00:00Z')
const minAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()
const run = (over: Partial<AffiliateLatestRun> = {}): AffiliateLatestRun => ({
  id: 'run-1', status: 'success', finished_at: minAgo(10), rejected: 0, note: null, error: null,
  unmatched_codes: null, unknown_statuses: null, ...over,
})
const evalWith = (latestRun: AffiliateLatestRun | null, over: Partial<Parameters<typeof evaluateAffiliateSyncHealth>[0]> = {}) =>
  evaluateAffiliateSyncHealth({
    latestRun,
    lastSuccessAt: latestRun?.status === 'success' ? latestRun.finished_at : null,
    lastSuccessLookupError: null,
    deliveredMissingCompleted: 0,
    nowMs: NOW,
    ...over,
  })

test.describe('affiliate sync health — evaluate thuần @desktop', () => {
  test('chưa có run nào → not ready', () => {
    const h = evalWith(null)
    expect(h.ready).toBe(false)
    expect(h.reason).toContain('chưa có sync run')
    expect(h.runId).toBeNull()
  })

  test('run đang chạy → not ready', () => {
    const h = evalWith(run({ status: 'running', finished_at: null }))
    expect(h.ready).toBe(false)
    expect(h.reason).toContain('đang chạy')
  })

  test('run failed → not ready, mang error + age từ mốc success trước', () => {
    const h = evaluateAffiliateSyncHealth({
      latestRun: run({ status: 'failed', error: 'Mongo: Server selection timed out', finished_at: minAgo(5) }),
      lastSuccessAt: minAgo(130), lastSuccessLookupError: null,
      deliveredMissingCompleted: 0, nowMs: NOW,
    })
    expect(h.ready).toBe(false)
    expect(h.reason).toContain('FAILED')
    expect(h.reason).toContain('Mongo')
    expect(h.ageMinutes).toBe(130)
  })

  test('run failed + lỗi lookup last-success → reason giải thích cả hai (r1 P2#5)', () => {
    const h = evaluateAffiliateSyncHealth({
      latestRun: run({ status: 'failed', error: 'x', finished_at: minAgo(5) }),
      lastSuccessAt: null, lastSuccessLookupError: 'timeout đọc sync_runs',
      deliveredMissingCompleted: 0, nowMs: NOW,
    })
    expect(h.ready).toBe(false)
    expect(h.reason).toContain('FAILED')
    expect(h.reason).toContain('mốc success gần nhất không xác định')
    expect(h.ageMinutes).toBeNull()
  })

  test('success nhưng thiếu finished_at → not ready', () => {
    const h = evalWith(run({ finished_at: null }), { lastSuccessAt: null })
    expect(h.ready).toBe(false)
    expect(h.reason).toContain('finished_at')
  })

  test('finished_at invalid (parse NaN) → not ready, ageMinutes null (r1 P2#4)', () => {
    const h = evalWith(run({ finished_at: 'garbage' }), { lastSuccessAt: 'garbage' })
    expect(h.ready).toBe(false)
    expect(h.reason).toContain('không hợp lệ')
    expect(h.ageMinutes).toBeNull()
  })

  test('finished_at tương lai: +4 phút (trong skew) OK + ageMinutes clamp 0, +6 phút → not ready (r1 P2#4, r2 P2)', () => {
    const okSkew = evalWith(run({ finished_at: minAgo(-4) }))
    expect(okSkew.ready).toBe(true)
    expect(okSkew.ageMinutes).toBe(0) // r2: không trả số âm cho UI/log
    const future = evalWith(run({ finished_at: minAgo(-6) }))
    expect(future.ready).toBe(false)
    expect(future.reason).toContain('tương lai')
  })

  test('unmatched_codes có phần tử → not ready (r2 P1#1 — code chưa map/inactive)', () => {
    const h = evalWith(run({ unmatched_codes: ['CIRCA-CODE-MOI', 'CODE-X (đã hợp nhất inactive)'] }))
    expect(h.ready).toBe(false)
    expect(h.reason).toContain('2 partner code chưa map/inactive')
    expect(h.reason).toContain('CIRCA-CODE-MOI')
  })

  test('unknown_statuses có phần tử → not ready (r2 P1#1)', () => {
    const h = evalWith(run({ unknown_statuses: ['SOME_NEW_STATUS'] }))
    expect(h.ready).toBe(false)
    expect(h.reason).toContain('status lạ')
    expect(h.reason).toContain('SOME_NEW_STATUS')
  })

  test('jsonb sai kiểu (không phải null/mảng) → not ready (r2 P1#1)', () => {
    const bad1 = evalWith(run({ unmatched_codes: 'oops-string' }))
    expect(bad1.ready).toBe(false)
    expect(bad1.reason).toContain('unmatched_codes sai kiểu JSON')
    const bad2 = evalWith(run({ unknown_statuses: { weird: true } }))
    expect(bad2.ready).toBe(false)
    expect(bad2.reason).toContain('unknown_statuses sai kiểu JSON')
  })

  test('rejected=null → not ready (r1 P1#1 — null KHÔNG phải 0)', () => {
    const h = evalWith(run({ rejected: null }))
    expect(h.ready).toBe(false)
    expect(h.reason).toContain('rejected=null')
  })

  test('rejected > 0 → not ready', () => {
    const h = evalWith(run({ rejected: 3 }))
    expect(h.ready).toBe(false)
    expect(h.reason).toContain('3 row rejected')
  })

  test('note vận hành (safety-floor) → not ready', () => {
    const h = evalWith(run({ note: 'rejected>0 — bỏ qua mark-missing' }))
    expect(h.ready).toBe(false)
    expect(h.reason).toContain('note vận hành')
  })

  test('stale boundary theo MILLISECOND: đúng 180 phút ready, +1ms → not ready (r1 P2#3)', () => {
    const exact = new Date(NOW - AFFILIATE_STALE_LIMIT_MINUTES * 60_000).toISOString()
    expect(evalWith(run({ finished_at: exact })).ready).toBe(true)
    const overByOneMs = new Date(NOW - (AFFILIATE_STALE_LIMIT_MINUTES * 60_000 + 1)).toISOString()
    const stale = evalWith(run({ finished_at: overByOneMs }))
    expect(stale.ready).toBe(false)
    expect(stale.reason).toContain('stale')
  })

  test('canary scoped: đơn DELIVERED thiếu completed_time trong targets → not ready', () => {
    const h = evalWith(run(), { deliveredMissingCompleted: 2 })
    expect(h.ready).toBe(false)
    expect(h.reason).toContain('2 đơn DELIVERED thiếu completed_time')
  })

  test('status lạ → not ready (fail-closed)', () => {
    const h = evalWith(run({ status: 'weird' }))
    expect(h.ready).toBe(false)
    expect(h.reason).toContain('status lạ')
  })

  test('run success tươi + sạch → READY, đủ metadata', () => {
    const h = evalWith(run({ finished_at: minAgo(25) }))
    expect(h).toEqual({
      ready: true, reason: null, runId: 'run-1',
      lastSuccessAt: minAgo(25), ageMinutes: 25,
    })
  })
})

// ── Wrapper qua fake DB: scoping canary + empty targets + query errors ───────
const OS_A = 'store-os-a'
const OS_B = 'store-os-b'
const fakeDb = (over: Partial<AffiliateHealthDb> = {}, dirtyStores: string[] = []): AffiliateHealthDb => ({
  latestRun: async () => ({ data: run(), error: null }),
  lastSuccessFinishedAt: async () => ({ data: { finished_at: minAgo(10) }, error: null }),
  // Fake mô phỏng DB thật: chỉ đếm đơn hỏng THUỘC danh sách store truyền vào —
  // chứng minh wrapper scope canary theo targets (FS/external không được chặn OS).
  countDeliveredMissingCompleted: async (storeIds) => ({
    count: storeIds.filter((s) => dirtyStores.includes(s)).length, error: null,
  }),
  ...over,
})

// r2.1: wrapper LUÔN nhận NOW inject — fixture minAgo() neo vào NOW nên kết quả
// bất biến theo thời điểm chạy (audit: test từng lúc pass lúc fail theo clock).
test.describe('affiliate sync health — wrapper scoped @desktop', () => {
  test('scope RỖNG (không store, không partner) → not ready (FS-expansion 06/08)', async () => {
    const h = await getAffiliateSyncHealth(fakeDb(), [], NOW)
    expect(h.ready).toBe(false)
    expect(h.reason).toContain('scope rỗng')
  })

  test('FS-expansion: store rỗng NHƯNG có partnerCodes (view FS-only) → wrapper CHẠY TIẾP, run sạch → READY, canary store bỏ qua', async () => {
    let canaryCalls = 0
    const h = await getAffiliateSyncHealth(
      fakeDb({ countDeliveredMissingCompleted: async () => { canaryCalls++; return { count: 0, error: null } } }),
      [], NOW, ['NT-YEN-HUONG'])
    expect(h.ready).toBe(true)
    expect(canaryCalls).toBe(0) // canary theo store KHÔNG chạy khi store rỗng —
    // canary phía partner nằm trong rpc_aggregate_affiliate_partner_gmv (RAISE)
  })

  test('FS-expansion: có partnerCodes nhưng RUN LỖI vẫn chặn (điều kiện run-level giữ nguyên)', async () => {
    const h = await getAffiliateSyncHealth(
      fakeDb({ latestRun: async () => ({ data: run({ status: 'failed', error: 'x' }), error: null }) }),
      [], NOW, ['NT-YEN-HUONG'])
    expect(h.ready).toBe(false)
  })

  test('đơn FS/external hỏng NHƯNG target OS sạch → READY (r1 P1#2)', async () => {
    const h = await getAffiliateSyncHealth(fakeDb({}, ['store-fs-x', 'store-ext-y']), [OS_A, OS_B], NOW)
    expect(h.ready).toBe(true)
  })

  test('target OS có đơn hỏng → not ready', async () => {
    const h = await getAffiliateSyncHealth(fakeDb({}, [OS_B]), [OS_A, OS_B], NOW)
    expect(h.ready).toBe(false)
    expect(h.reason).toContain('1 đơn DELIVERED thiếu completed_time')
  })

  test('lỗi query latestRun → not ready fail-closed', async () => {
    const h = await getAffiliateSyncHealth(
      fakeDb({ latestRun: async () => ({ data: null, error: { message: 'boom' } }) }), [OS_A], NOW)
    expect(h.ready).toBe(false)
    expect(h.reason).toContain('không đọc được affiliate_sync_runs')
  })

  test('lỗi query canary → not ready fail-closed', async () => {
    const h = await getAffiliateSyncHealth(
      fakeDb({ countDeliveredMissingCompleted: async () => ({ count: null, error: { message: 'net' } }) }), [OS_A], NOW)
    expect(h.ready).toBe(false)
    expect(h.reason).toContain('không đọc được canary')
  })

  test('canary count=null KHÔNG error → vẫn not ready (r2 P1#2 — null ≠ 0)', async () => {
    const h = await getAffiliateSyncHealth(
      fakeDb({ countDeliveredMissingCompleted: async () => ({ count: null, error: null }) }), [OS_A], NOW)
    expect(h.ready).toBe(false)
    expect(h.reason).toContain('không trả count')
  })

  test('latest failed + lỗi lookup success → reason mang cả hai, vẫn not ready', async () => {
    const h = await getAffiliateSyncHealth(fakeDb({
      latestRun: async () => ({ data: run({ status: 'failed', error: 'Mongo down' }), error: null }),
      lastSuccessFinishedAt: async () => ({ data: null, error: { message: 'timeout' } }),
    }), [OS_A], NOW)
    expect(h.ready).toBe(false)
    expect(h.reason).toContain('FAILED')
    expect(h.reason).toContain('mốc success gần nhất không xác định: timeout')
  })

  test('không truyền nowMs → mặc định Date.now() (production path)', async () => {
    // finished_at neo theo giờ thật để chứng minh default hoạt động.
    const fresh = new Date(Date.now() - 10 * 60_000).toISOString()
    const h = await getAffiliateSyncHealth(fakeDb({
      latestRun: async () => ({ data: run({ finished_at: fresh }), error: null }),
    }), [OS_A])
    expect(h.ready).toBe(true)
  })
})
