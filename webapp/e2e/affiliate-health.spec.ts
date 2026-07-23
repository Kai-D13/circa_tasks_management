import { test, expect } from '@playwright/test'
import { AFFILIATE_STALE_LIMIT_MINUTES, evaluateAffiliateSyncHealth } from '../lib/affiliate/health'

// P3-A unit gate — đủ MỌI trạng thái health (yêu cầu audit). Pure logic,
// không browser/DB. ready=false là mặc định an toàn (fail-closed).

const NOW = Date.parse('2026-07-23T10:00:00Z')
const minAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()
const run = (over: Partial<NonNullable<Parameters<typeof evaluateAffiliateSyncHealth>[0]['latestRun']>> = {}) => ({
  id: 'run-1', status: 'success', finished_at: minAgo(10), rejected: 0, note: null, error: null, ...over,
})
const evalWith = (latestRun: ReturnType<typeof run> | null, over: Partial<Parameters<typeof evaluateAffiliateSyncHealth>[0]> = {}) =>
  evaluateAffiliateSyncHealth({
    latestRun,
    lastSuccessAt: latestRun?.status === 'success' ? latestRun.finished_at : null,
    deliveredMissingCompleted: 0,
    nowMs: NOW,
    ...over,
  })

test.describe('affiliate sync health @desktop', () => {
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

  test('run failed → not ready, mang error + lastSuccessAt của run success trước', () => {
    const h = evaluateAffiliateSyncHealth({
      latestRun: run({ status: 'failed', error: 'Mongo: Server selection timed out', finished_at: minAgo(5) }),
      lastSuccessAt: minAgo(130),
      deliveredMissingCompleted: 0,
      nowMs: NOW,
    })
    expect(h.ready).toBe(false)
    expect(h.reason).toContain('FAILED')
    expect(h.reason).toContain('Mongo')
    expect(h.ageMinutes).toBe(130)
  })

  test('success nhưng thiếu finished_at → not ready', () => {
    const h = evalWith(run({ finished_at: null }), { lastSuccessAt: null })
    expect(h.ready).toBe(false)
    expect(h.reason).toContain('finished_at')
  })

  test('success nhưng rejected > 0 → not ready (snapshot không sạch)', () => {
    const h = evalWith(run({ rejected: 3 }))
    expect(h.ready).toBe(false)
    expect(h.reason).toContain('3 row rejected')
  })

  test('success nhưng có note vận hành (safety-floor) → not ready', () => {
    const h = evalWith(run({ note: 'rejected>0 — bỏ qua mark-missing' }))
    expect(h.ready).toBe(false)
    expect(h.reason).toContain('note vận hành')
  })

  test('stale: đúng ngưỡng 180 phút vẫn ready, 181 phút → not ready', () => {
    const ok = evalWith(run({ finished_at: minAgo(AFFILIATE_STALE_LIMIT_MINUTES) }))
    expect(ok.ready).toBe(true)
    const stale = evalWith(run({ finished_at: minAgo(AFFILIATE_STALE_LIMIT_MINUTES + 1) }))
    expect(stale.ready).toBe(false)
    expect(stale.reason).toContain('stale')
  })

  test('canary: đơn DELIVERED thiếu completed_time → not ready', () => {
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
