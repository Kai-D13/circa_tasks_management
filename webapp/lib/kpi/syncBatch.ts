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
//   • 105 r1.3.1 (audit P1): warnings của success (vd Order/AOV Offline bị ẩn
//     do nguồn BQ hỏng) phải NỔI LÊN RESPONSE, không chỉ nằm trong log — Coolify
//     và nút "Đồng bộ ngay" chỉ nhìn thấy body. HTTP vẫn 200 (tiền đã ghi đúng).

import type { SyncCampaignResult } from '@/lib/kpi/syncCampaignCore'
import { sanitizeOpsText } from '@/lib/ops/sanitize'

export interface BatchCampaignRef { id: string; name: string | null }

// r1.2 (audit P2): trần số warning đưa vào response body. Log KHÔNG bị cắt —
// chỉ body (thứ Coolify hiển thị) mới cần gọn.
export const WARNING_LIMIT = 50

export interface BatchOutcome {
  httpStatus: 200 | 207 | 500
  anySuccess: boolean
  body: {
    ok: boolean
    campaigns: number
    upserted: number
    unmatched: string[]
    preserved: { campaign: string; reason: string }[]
    // 105 r1.3.1: cảnh báo của campaign ĐÃ ghi thành công (degrade chỉ số phụ).
    // Đã sanitize + dedupe theo (campaign, warning) — cron chạy 2h/lần nên
    // cùng một POS hỏng sẽ lặp lại, không được phình body.
    // r1.2 (audit P2): CẮT ở WARNING_LIMIT — nguồn hỏng diện rộng (25 POS ×
    // nhiều campaign) không được biến response cron thành payload khổng lồ.
    // warningCount = TỔNG thật (sau dedupe) để không "im lặng cắt bớt".
    warnings: { campaign: string; warning: string }[]
    warningCount: number
    warningsTruncated: boolean
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
  const warnings: { campaign: string; warning: string }[] = []
  const seenWarning = new Set<string>()
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
      // Mig 103: warnings của success (vd cross-store account campaign khách).
      // 105 r1.3.1 (audit P1): vào CẢ log lẫn response body — KHÔNG đổi HTTP
      // contract (vẫn 200 vì tiền đã ghi đúng), nhưng Coolify/người vận hành
      // phải đọc được POS nào đang bị ẩn Order/AOV thay vì body sạch trơn.
      for (const w of r.warnings ?? []) {
        const warning = sanitizeOpsText(w)
        logLines.push(`[sync-kpi-campaign] warning campaign=${c.id} (${label}): ${warning}`)
        const key = `${c.id}|${warning}`
        if (seenWarning.has(key)) continue
        seenWarning.add(key)
        warnings.push({ campaign: label, warning })
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
      warnings: warnings.slice(0, WARNING_LIMIT),
      warningCount: warnings.length,
      warningsTruncated: warnings.length > WARNING_LIMIT,
      errors,
    },
    logLines,
  }
}

// ── Manual sync ("Đồng bộ ngay") — kế hoạch side-effect cho action/button ────
//   success   → revalidate + toast thành công
//   preserved → KHÔNG revalidate (số cũ giữ nguyên) + toast info kèm lý do
//   failed    → KHÔNG revalidate + toast lỗi
// 105 r1.3.1: success VẪN có thể kèm warnings (degrade chỉ số phụ) — toast phải
// nói rõ "GMV đã đồng bộ nhưng Order/AOV tạm ẩn", không báo thành công trơn.
export type ManualSyncPlan =
  | { kind: 'success'; revalidate: true; upserted: number; unmatched: string[]; warnings: string[] }
  | { kind: 'preserved'; revalidate: false; reason: string }
  | { kind: 'failed'; revalidate: false; error: string }

export function manualSyncPlan(r: SyncCampaignResult): ManualSyncPlan {
  if (r.status === 'failed') return { kind: 'failed', revalidate: false, error: sanitizeOpsText(r.error) }
  if (r.status === 'snapshot_preserved') return { kind: 'preserved', revalidate: false, reason: sanitizeOpsText(r.reason) }
  return {
    kind: 'success', revalidate: true, upserted: r.upserted, unmatched: r.unmatched,
    warnings: [...new Set((r.warnings ?? []).map(sanitizeOpsText))],
  }
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
