// P3-C — Caller contract THUẦN (audit 23/07): toàn bộ quyết định của cron batch
// (HTTP status, body, log lines) và của nút manual sync (toast/revalidate) nằm
// ở đây để test không cần HTTP server. Route/action chỉ làm IO.
// Contract:
//   • mọi campaign success            → HTTP 200, ok=true
//   • có snapshot_preserved, 0 failed → HTTP 207, ok=true (kèm danh sách + lý do)
//   • có failed                       → HTTP 500, ok=false — VẪN trả success/
//     preserved đã xử lý trước đó (không nuốt kết quả)
//   • một campaign preserve/failed KHÔNG chặn campaign kế tiếp (loop độc lập —
//     offline-only vẫn sync khi nguồn affiliate stale)
//   • log có campaignId + name + reason; KHÔNG log secret/URI

import type { SyncCampaignResult } from '@/lib/kpi/syncCampaignCore'

export interface BatchCampaignRef { id: string; name: string | null }

export interface BatchOutcome {
  httpStatus: 200 | 207 | 500
  anySuccess: boolean
  body: {
    ok: boolean
    campaigns: number
    upserted: number
    unmatched: string[]
    preserved: { campaign: string; reason: string }[]
    errors: string[]
  }
  logLines: string[]
}

export async function runSyncBatch(
  campaigns: BatchCampaignRef[],
  syncFn: (campaignId: string) => Promise<SyncCampaignResult>,
): Promise<BatchOutcome> {
  let upserted = 0
  const unmatched: string[] = []
  const preserved: { campaign: string; reason: string }[] = []
  const errors: string[] = []
  const logLines: string[] = []
  let anySuccess = false

  for (const c of campaigns) {
    const label = c.name ?? c.id
    const r = await syncFn(c.id)
    if (r.status === 'failed') {
      errors.push(`${label}: ${r.error}`)
      logLines.push(`[sync-kpi-campaign] FAILED campaign=${c.id} (${label}): ${r.error}`)
    } else if (r.status === 'snapshot_preserved') {
      preserved.push({ campaign: label, reason: r.reason })
      logLines.push(`[sync-kpi-campaign] snapshot_preserved campaign=${c.id} (${label}): ${r.reason}`)
    } else {
      anySuccess = true
      upserted += r.upserted
      unmatched.push(...r.unmatched)
    }
  }

  const httpStatus: BatchOutcome['httpStatus'] =
    errors.length > 0 ? 500 : preserved.length > 0 ? 207 : 200

  return {
    httpStatus,
    anySuccess,
    body: {
      ok: errors.length === 0,
      campaigns: campaigns.length,
      upserted,
      unmatched: [...new Set(unmatched)],
      preserved,
      errors,
    },
    logLines,
  }
}

// ── Manual sync ("Đồng bộ ngay") — kế hoạch side-effect cho action/button ────
//   success   → revalidate + toast thành công
//   preserved → KHÔNG revalidate (số cũ giữ nguyên) + toast info kèm lý do
//   failed    → KHÔNG revalidate + toast lỗi
export type ManualSyncPlan =
  | { kind: 'success'; revalidate: true; upserted: number; unmatched: string[] }
  | { kind: 'preserved'; revalidate: false; reason: string }
  | { kind: 'failed'; revalidate: false; error: string }

export function manualSyncPlan(r: SyncCampaignResult): ManualSyncPlan {
  if (r.status === 'failed') return { kind: 'failed', revalidate: false, error: r.error }
  if (r.status === 'snapshot_preserved') return { kind: 'preserved', revalidate: false, reason: r.reason }
  return { kind: 'success', revalidate: true, upserted: r.upserted, unmatched: r.unmatched }
}
