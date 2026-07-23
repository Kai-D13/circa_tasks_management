import { test, expect } from '@playwright/test'
import { manualSyncPlan, runSyncBatch, safeManualSync, shouldRevalidateAfterBatch } from '../lib/kpi/syncBatch'
import { sanitizeOpsText } from '../lib/ops/sanitize'
import type { SyncCampaignResult } from '../lib/kpi/syncCampaignCore'

// P3-C unit gate — caller contract (audit 23/07): 200/207/500 mapping, loop
// độc lập từng campaign, log không secret, manual plan revalidate/toast.

const ok = (id: string, upserted = 2, unmatched: string[] = []): SyncCampaignResult =>
  ({ status: 'success', campaignId: id, upserted, dailyRows: 10, unmatched })
const preserved = (id: string, reason: string): SyncCampaignResult =>
  ({ status: 'snapshot_preserved', campaignId: id, reason })
const failed = (id: string, error: string): SyncCampaignResult =>
  ({ status: 'failed', campaignId: id, error })

const CAMPS = [
  { id: 'c-1', name: 'Tháng 7 OS' },
  { id: 'c-2', name: 'Affiliate thử nghiệm' },
  { id: 'c-3', name: null },
]

test.describe('kpi sync batch contract @desktop', () => {
  test('mọi campaign success → HTTP 200, ok=true, cộng dồn upserted + dedupe unmatched', async () => {
    const out = await runSyncBatch(CAMPS, async (id) => ok(id, 2, ['POS0009']))
    expect(out.httpStatus).toBe(200)
    expect(out.body.ok).toBe(true)
    expect(out.body.campaigns).toBe(3)
    expect(out.body.upserted).toBe(6)
    expect(out.body.unmatched).toEqual(['POS0009']) // dedupe
    expect(out.body.preserved).toEqual([])
    expect(out.body.errors).toEqual([])
    expect(out.anySuccess).toBe(true)
  })

  test('có snapshot_preserved, 0 failed → HTTP 207, ok=true, kèm campaign + lý do', async () => {
    const out = await runSyncBatch(CAMPS, async (id) =>
      id === 'c-2' ? preserved(id, 'nguồn affiliate chưa sẵn sàng: snapshot stale 400 phút') : ok(id))
    expect(out.httpStatus).toBe(207)
    expect(out.body.ok).toBe(true)
    expect(out.body.preserved).toEqual([
      { campaign: 'Affiliate thử nghiệm', reason: 'nguồn affiliate chưa sẵn sàng: snapshot stale 400 phút' },
    ])
    // Offline-only campaign VẪN sync khi affiliate stale — success đi kèm preserved.
    expect(out.body.upserted).toBe(4)
    expect(out.anySuccess).toBe(true)
  })

  test('có failed → HTTP 500, ok=false — VẪN trả success/preserved đã xử lý', async () => {
    const out = await runSyncBatch(CAMPS, async (id) => {
      if (id === 'c-1') return ok(id, 5)
      if (id === 'c-2') return preserved(id, 'sync đang chạy')
      return failed(id, 'Ghi actuals lỗi: SUM(daily) không khớp')
    })
    expect(out.httpStatus).toBe(500)
    expect(out.body.ok).toBe(false)
    expect(out.body.upserted).toBe(5)                       // success không bị nuốt
    expect(out.body.preserved.length).toBe(1)
    expect(out.body.errors).toEqual(['c-3: Ghi actuals lỗi: SUM(daily) không khớp']) // name null → id
  })

  test('loop ĐỘC LẬP: campaign fail/preserve không chặn campaign kế tiếp (đúng thứ tự)', async () => {
    const seen: string[] = []
    const out = await runSyncBatch(CAMPS, async (id) => {
      seen.push(id)
      if (id === 'c-1') return failed(id, 'db down')
      if (id === 'c-2') return preserved(id, 'stale')
      return ok(id)
    })
    expect(seen).toEqual(['c-1', 'c-2', 'c-3']) // cả 3 đều được gọi, đúng thứ tự
    expect(out.httpStatus).toBe(500)
    expect(out.body.upserted).toBe(2)
  })

  test('logLines: có campaignId + name + reason cho preserved/failed; KHÔNG secret', async () => {
    const out = await runSyncBatch(CAMPS, async (id) => {
      if (id === 'c-2') return preserved(id, 'runId đổi trong lúc aggregate')
      if (id === 'c-3') return failed(id, 'BigQuery timeout')
      return ok(id)
    })
    expect(out.logLines.length).toBe(2)
    expect(out.logLines[0]).toContain('campaign=c-2')
    expect(out.logLines[0]).toContain('Affiliate thử nghiệm')
    expect(out.logLines[0]).toContain('runId đổi')
    expect(out.logLines[1]).toContain('FAILED campaign=c-3')
    for (const line of out.logLines) {
      expect(line).not.toMatch(/mongodb\+srv|password|SERVICE_ROLE|Bearer/i)
    }
  })

  test('batch rỗng → 200 ok, không có gì để log/revalidate', async () => {
    const out = await runSyncBatch([], async () => ok('x'))
    expect(out.httpStatus).toBe(200)
    expect(out.body.campaigns).toBe(0)
    expect(out.anySuccess).toBe(false)
    expect(out.logLines).toEqual([])
  })

  test('manualSyncPlan: success → revalidate=true + số liệu; preserved/failed → revalidate=false', () => {
    const s = manualSyncPlan(ok('c-1', 7, ['POS0002']))
    expect(s).toEqual({ kind: 'success', revalidate: true, upserted: 7, unmatched: ['POS0002'] })

    const p = manualSyncPlan(preserved('c-1', 'nguồn affiliate chưa sẵn sàng'))
    expect(p).toEqual({ kind: 'preserved', revalidate: false, reason: 'nguồn affiliate chưa sẵn sàng' })

    const f = manualSyncPlan(failed('c-1', 'Ghi actuals lỗi'))
    expect(f).toEqual({ kind: 'failed', revalidate: false, error: 'Ghi actuals lỗi' })
  })

  // ── P3-C r1 ────────────────────────────────────────────────────────────────
  test('r1 EXCEPTION ISOLATION: campaign 1 throw → 2-3 VẪN chạy; 500 giữ success/preserved khác', async () => {
    const seen: string[] = []
    const out = await runSyncBatch(CAMPS, async (id) => {
      seen.push(id)
      if (id === 'c-1') throw new Error('Supabase fetch failed unexpectedly')
      if (id === 'c-2') return preserved(id, 'stale')
      return ok(id, 3)
    })
    expect(seen).toEqual(['c-1', 'c-2', 'c-3'])            // không dừng batch
    expect(out.httpStatus).toBe(500)
    expect(out.body.errors[0]).toContain('exception: Supabase fetch failed')
    expect(out.body.preserved.length).toBe(1)               // preserved giữ nguyên
    expect(out.body.upserted).toBe(3)                       // success giữ nguyên
  })

  test('r1 SANITIZE: secret GIẢ trong error/reason/name không lọt vào body lẫn logLines', async () => {
    const dirtyCamps = [
      { id: 'c-1', name: 'Camp Bearer abc123XYZ' },         // name cũng phải sạch
      { id: 'c-2', name: 'Camp 2' },
      { id: 'c-3', name: 'Camp 3' },
    ]
    const out = await runSyncBatch(dirtyCamps, async (id) => {
      if (id === 'c-1') return failed(id, 'connect ECONNREFUSED mongodb+srv://fake_user:fakePass123@fake-host.mongodb.net/db?retryWrites=true')
      if (id === 'c-2') return preserved(id, 'lỗi\r\n[FAKE-INJECTED-LOG] password=hunter2 SUPABASE_SERVICE_ROLE_KEY=eyJfakeKey')
      return ok(id)
    })
    const everything = JSON.stringify(out.body) + out.logLines.join(' ')
    expect(everything).not.toContain('fakePass123')
    expect(everything).not.toContain('abc123XYZ')
    expect(everything).not.toContain('hunter2')
    expect(everything).not.toContain('eyJfakeKey')
    expect(everything).not.toContain('\r')
    expect(everything).not.toContain('\n')
    expect(everything).toContain('mongodb+srv://***')       // che nhưng vẫn nhận diện được loại lỗi
    expect(everything).toContain('Bearer ***')
    expect(everything).toContain('password=***')
  })

  test('r1 sanitizeOpsText: từng pattern với secret giả', () => {
    expect(sanitizeOpsText('mongodb://u:p@h/db')).toBe('mongodb://***')
    expect(sanitizeOpsText('Authorization: Bearer tok.en-123')).toBe('Authorization: Bearer ***')
    expect(sanitizeOpsText('MONGODB_AFFILIATE_URI=mongodb+srv://x CRON_SECRET: abc')).toBe('MONGODB_AFFILIATE_URI=*** CRON_SECRET=***')
    expect(sanitizeOpsText('dòng1\r\ndòng2\ndòng3')).toBe('dòng1 dòng2 dòng3')
  })

  test('r1 REVALIDATE: auto-end vẫn revalidate dù toàn bộ preserved; batch rỗng thì không', () => {
    expect(shouldRevalidateAfterBatch(false, 2)).toBe(true)   // auto-end đổi DB → refresh cache
    expect(shouldRevalidateAfterBatch(true, 0)).toBe(true)
    expect(shouldRevalidateAfterBatch(false, 0)).toBe(false)  // batch rỗng/toàn preserved, không auto-end
  })

  test('r1 MANUAL THROW: safeManualSync trả lỗi có cấu trúc + sanitize, không throw ra UI', async () => {
    const plan = await safeManualSync(async () => {
      throw new Error('driver died at mongodb+srv://fake_user:fakePass@h/x')
    }, 'c-1')
    expect(plan.kind).toBe('failed')
    if (plan.kind === 'failed') {
      expect(plan.error).toContain('exception:')
      expect(plan.error).not.toContain('fakePass')
      expect(plan.error).toContain('mongodb+srv://***')
    }
    const okPlan = await safeManualSync(async () => ok('c-1', 4), 'c-1')
    expect(okPlan.kind).toBe('success')
  })
})
