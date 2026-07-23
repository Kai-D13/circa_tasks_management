import { test, expect } from '@playwright/test'
import { manualSyncPlan, runSyncBatch } from '../lib/kpi/syncBatch'
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
})
