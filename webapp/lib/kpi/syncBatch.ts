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
import { sanitizeOpsText } from '@/lib/ops/sanitize'

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
    const label = sanitizeOpsText(c.name ?? c.id)
    // r1 (audit P1#1): exception isolation TỪNG campaign — dependency throw bất
    // ngờ được chuyển thành failed và batch TIẾP TỤC campaign kế tiếp.
    let r: SyncCampaignResult
    try {
      r = await syncFn(c.id)
    } catch (e) {
      r = { status: 'failed', campaignId: c.id, error: `exception: ${e instanceof Error ? e.message : String(e)}` }
    }
    if (r.status === 'failed') {
      // r1 (audit P1#2): sanitize TRƯỚC khi vào cả log lẫn response body.
      const msg = sanitizeOpsText(r.error)
      errors.push(`${label}: ${msg}`)
      logLines.push(`[sync-kpi-campaign] FAILED campaign=${c.id} (${label}): ${msg}`)
    } else if (r.status === 'snapshot_preserved') {
      const why = sanitizeOpsText(r.reason)
      preserved.push({ campaign: label, reason: why })
      logLines.push(`[sync-kpi-campaign] snapshot_preserved campaign=${c.id} (${label}): ${why}`)
    } else {
      anySuccess = true
      upserted += r.upserted
      unmatched.push(...r.unmatched)
      // Mig 103: warnings của success (vd cross-store account campaign khách)
      // — KHÔNG đổi HTTP contract (vẫn 200), chỉ nổi lên log để vận hành thấy.
      for (const w of r.warnings ?? []) {
        logLines.push(`[sync-kpi-campaign] warning campaign=${c.id} (${label}): ${sanitizeOpsText(w)}`)
      }
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
  if (r.status === 'failed') return { kind: 'failed', revalidate: false, error: sanitizeOpsText(r.error) }
  if (r.status === 'snapshot_preserved') return { kind: 'preserved', revalidate: false, reason: sanitizeOpsText(r.reason) }
  return { kind: 'success', revalidate: true, upserted: r.upserted, unmatched: r.unmatched }
}

// r1 (audit P1#1): nút manual cũng không được để server action throw ra UI —
// exception → plan failed có cấu trúc (đã sanitize).
export async function safeManualSync(
  syncFn: (campaignId: string) => Promise<SyncCampaignResult>,
  campaignId: string,
): Promise<ManualSyncPlan> {
  try {
    return manualSyncPlan(await syncFn(campaignId))
  } catch (e) {
    return {
      kind: 'failed', revalidate: false,
      error: sanitizeOpsText(`exception: ${e instanceof Error ? e.message : String(e)}`),
    }
  }
}

// r1 (audit P2): auto-end đổi DB (campaign → ended) cũng phải refresh cache dù
// toàn bộ sync bị preserve/fail; batch rỗng + không auto-end → không revalidate.
export function shouldRevalidateAfterBatch(anySuccess: boolean, endedCount: number): boolean {
  return anySuccess || endedCount > 0
}
