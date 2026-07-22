import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { isAffiliateSyncEnabled } from '@/lib/affiliate/flags'
import { fetchAffiliateOrdersSnapshot } from '@/lib/affiliate/mongo'
import {
  dedupeByOrderId,
  resolveStores,
  validateSourceOrder,
  type AffiliateOrderRow,
  type PartnerMappingRow,
} from '@/lib/affiliate/normalize'

// GET /api/cron/pull-affiliate-orders — đồng bộ đơn Affiliate từ MongoDB Circa
// Online về affiliate_orders. CONTRACT F1/F2 (stakeholder khóa 22/07) + r1:
//   • Vòng đời qua ĐÚNG 3 RPC: rpc_start (lease) → upsert batch → rpc_finish /
//     rpc_fail. KHÔNG UPDATE rời rạc bằng service role.
//   • HARD DEADLINE 10 phút cho TOÀN route (< lease 15') — quá hạn ở bất kỳ
//     phase nào → dừng mọi batch còn lại, rpc_fail, 504. Mongo query có
//     maxTimeMS; mọi call Supabase có abortSignal theo thời gian còn lại.
//   • Dry-run (?dry=1) dùng CHUNG resolveStores với real run — báo matched
//     os/fs/external, unmatched/inactive, số đơn store NULL, giá âm, reject.
//   • Row thiếu/sai field bắt buộc (kể cả BSON Long vượt safe-int, Decimal128
//     không convert được) → REJECT; total_price ÂM vẫn hợp lệ (user 22/07).
//   • rejected>0 → HTTP 200 + status:'warning' + console.warn. Lỗi thật →
//     rpc_fail + 502/500/504. Lease bận → 409.
//   • SAU rpc_finish thành công: mọi thao tác phụ (revalidate…) KHÔNG được
//     đổi kết quả thành failure (audit r1 P2) — lỗi chỉ log.
//   • Gate: CRON_SECRET (401) → AFFILIATE_SYNC_ENABLED (503; flag SYNC tách
//     khỏi UI để backfill chạy khi UI còn tắt — trình tự F5).
// Coolify Scheduled Task (0 */2 * * *) CHỈ tạo ở F5 sau backfill + đối soát.

const UPSERT_CHUNK = 500
const GROWTH_WARN_THRESHOLD = 3_000  // plan §3: >3k → cảnh báo, ticket incremental
const HARD_DEADLINE_MS = 10 * 60_000 // < lease 15 phút (audit r1 P1)
const MONGO_MAX_TIME_MS = 60_000

class DeadlineError extends Error {
  constructor(phase: string) { super(`hard deadline 10 phút vượt tại phase: ${phase}`) }
}

export async function GET(request: NextRequest) {
  const secret = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isAffiliateSyncEnabled()) {
    return NextResponse.json({ error: 'Affiliate sync disabled (AFFILIATE_SYNC_ENABLED=false)' }, { status: 503 })
  }

  const deadlineAt = Date.now() + HARD_DEADLINE_MS
  const timeLeft = () => deadlineAt - Date.now()
  const guard = (phase: string) => { if (timeLeft() <= 0) throw new DeadlineError(phase) }
  // AbortSignal cho call Supabase kế tiếp — không vượt thời gian còn lại.
  const sig = () => AbortSignal.timeout(Math.max(1_000, Math.min(timeLeft(), 60_000)))

  const isDry = request.nextUrl.searchParams.get('dry') === '1'

  // ── Pipeline đọc dùng chung dry/real: snapshot → dedupe → validate → resolve ─
  const readAndClassify = async () => {
    guard('mongo snapshot')
    const rawDocs = await fetchAffiliateOrdersSnapshot(Math.min(MONGO_MAX_TIME_MS, Math.max(1_000, timeLeft())))
    if (rawDocs.length > GROWTH_WARN_THRESHOLD) {
      console.warn(`[affiliate-sync] subset=${rawDocs.length} vượt ngưỡng ${GROWTH_WARN_THRESHOLD} — tạo ticket chuyển incremental theo last_updated_time (plan §3)`)
    }
    guard('dedupe/validate')
    const { unique, duplicates } = dedupeByOrderId(rawDocs)
    const valid: AffiliateOrderRow[] = []
    const rejected: { order_id: unknown; reason: string }[] = []
    for (const doc of unique) {
      const r = validateSourceOrder(doc)
      if (r.ok) valid.push(r.row)
      else rejected.push({ order_id: r.orderId, reason: r.reason })
    }
    guard('đọc mappings')
    const { data: mappings, error: mapErr } = await supabaseAdmin
      .from('affiliate_partner_mappings')
      .select('partner_code, store_id, partner_type, is_active')
      .abortSignal(sig())
    if (mapErr) throw new Error(`Đọc mappings: ${mapErr.message}`)
    const { resolved, report } = resolveStores(valid, (mappings ?? []) as PartnerMappingRow[])
    const unknownStatuses = [...new Set(valid.filter((r) => r.status_norm === 'other').map((r) => r.raw_status))]
    return { rawFetched: rawDocs.length, duplicates, unique, resolved, rejected, report, unknownStatuses }
  }

  // ── DRY-RUN: không lease, KHÔNG GHI GÌ — báo cáo đối soát trước first-write ─
  if (isDry) {
    try {
      const d = await readAndClassify()
      const statusCount: Record<string, number> = {}
      for (const r of d.resolved) statusCount[r.raw_status] = (statusCount[r.raw_status] ?? 0) + 1
      const codeCount: Record<string, number> = {}
      for (const r of d.resolved) codeCount[r.partner_code] = (codeCount[r.partner_code] ?? 0) + 1
      return NextResponse.json({
        ok: true, dry: true,
        raw_fetched: d.rawFetched, duplicates: d.duplicates,
        pulled: d.unique.length,
        would_upsert: d.resolved.length, would_reject: d.rejected.length,
        rejected_reasons: d.rejected.slice(0, 20),
        mapping_report: d.report,
        unknown_statuses: d.unknownStatuses,
        status_distribution: statusCount,
        partner_code_distribution: codeCount,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Mongo error'
      return NextResponse.json({ error: `Dry-run: ${msg}` }, { status: e instanceof DeadlineError ? 504 : 502 })
    }
  }

  // ── REAL RUN ────────────────────────────────────────────────────────────────
  // 1) Lease — NULL = run khác đang giữ: 409, KHÔNG đụng Mongo.
  const { data: runId, error: startErr } = await supabaseAdmin.rpc('rpc_start_affiliate_sync').abortSignal(sig())
  if (startErr) {
    return NextResponse.json({ error: `Không mở được sync run: ${startErr.message}` }, { status: 500 })
  }
  if (!runId) {
    return NextResponse.json({ error: 'Sync đang chạy (lease đang được giữ)' }, { status: 409 })
  }

  // rpc_fail dùng signal RIÊNG (không dính deadline đã cháy) để luôn đóng được run.
  const failRun = async (msg: string) => {
    const { error } = await supabaseAdmin
      .rpc('rpc_fail_affiliate_sync', { p_run_id: runId, p_error: msg })
      .abortSignal(AbortSignal.timeout(30_000))
    if (error) console.error('[affiliate-sync] rpc_fail cũng lỗi:', error.message)
  }

  interface FinishResult { deactivated?: number; note?: string | null }
  let finishResult: FinishResult | null = null
  let counts: { rawFetched: number; duplicates: number; pulled: number; upserted: number } | null = null
  let rejectedReasons: { order_id: unknown; reason: string }[] = []
  let report: ReturnType<typeof resolveStores>['report'] | null = null
  let unknownStatuses: string[] = []

  try {
    const d = await readAndClassify()
    rejectedReasons = d.rejected
    report = d.report
    unknownStatuses = d.unknownStatuses

    // 2) Upsert batch — mỗi row set last_seen_run_id + source_active + synced_at.
    const nowIso = new Date().toISOString()
    const upsertRows = d.resolved.map((r) => ({
      ...r,
      last_seen_run_id: runId,
      source_active: true,
      synced_at: nowIso,
    }))
    for (let i = 0; i < upsertRows.length; i += UPSERT_CHUNK) {
      guard(`upsert batch ${i / UPSERT_CHUNK + 1}`)
      const chunk = upsertRows.slice(i, i + UPSERT_CHUNK)
      const { error: upErr } = await supabaseAdmin
        .from('affiliate_orders')
        .upsert(chunk, { onConflict: 'order_id' })
        .abortSignal(sig())
      if (upErr) throw new Error(`Upsert batch ${i / UPSERT_CHUNK + 1}: ${upErr.message}`)
    }

    // 3) Finish — mark-missing + safety floor + đóng run trong 1 transaction ở DB.
    guard('rpc_finish')
    const { data: finish, error: finErr } = await supabaseAdmin
      .rpc('rpc_finish_affiliate_sync', {
        p_run_id: runId,
        p_pulled: d.unique.length,
        p_upserted: upsertRows.length,
        p_rejected: rejectedReasons.length,
        p_unmatched: report.unmatched_codes.length ? report.unmatched_codes : null,
        p_unknown: unknownStatuses.length ? unknownStatuses : null,
      })
      .abortSignal(sig())
    if (finErr) throw new Error(`rpc_finish: ${finErr.message}`)
    finishResult = (finish ?? null) as FinishResult | null
    counts = { rawFetched: d.rawFetched, duplicates: d.duplicates, pulled: d.unique.length, upserted: upsertRows.length }
  } catch (e) {
    // CHƯA finish → đóng run failed. (Sau finish không còn đường vào đây —
    // post-finish tách riêng bên dưới.)
    const msg = e instanceof Error ? e.message : 'unknown'
    await failRun(msg)
    const status = e instanceof DeadlineError ? 504 : msg.startsWith('Upsert') || msg.startsWith('Mongo') ? 502 : 500
    return NextResponse.json({ error: msg }, { status })
  }

  // ── POST-FINISH (audit r1 P2): run ĐÃ success — thao tác phụ lỗi chỉ log,
  //    không bao giờ đổi kết quả thành failure/gọi rpc_fail. ──────────────────
  const postFinishNotes: string[] = []
  try {
    revalidatePath('/targets')
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'revalidate error'
    console.warn('[affiliate-sync] post-finish revalidate lỗi (run vẫn success):', msg)
    postFinishNotes.push(`revalidate: ${msg}`)
  }

  if (rejectedReasons.length > 0) {
    console.warn(`[affiliate-sync] ${rejectedReasons.length} row REJECTED (không upsert):`,
      JSON.stringify(rejectedReasons.slice(0, 10)))
  }
  if (report && report.unmatched_codes.length > 0) {
    console.warn('[affiliate-sync] partner_code chưa map (store NULL, chỉ super thấy):', report.unmatched_codes.join(', '))
  }
  if (report && report.inactive_codes.length > 0) {
    console.warn('[affiliate-sync] mapping INACTIVE (store NULL):', report.inactive_codes.join(', '))
  }
  if (unknownStatuses.length > 0) {
    console.warn('[affiliate-sync] status lạ → other:', unknownStatuses.join(', '))
  }
  if (report && report.negative_price_count > 0) {
    console.warn(`[affiliate-sync] ${report.negative_price_count} đơn total_price ÂM (giữ theo quyết định 22/07):`, report.negative_price_sample.join(', '))
  }

  const hasNotes = (report?.unmatched_codes.length ?? 0) > 0 || (report?.inactive_codes.length ?? 0) > 0 || unknownStatuses.length > 0
  return NextResponse.json({
    ok: true,
    status: rejectedReasons.length > 0 ? 'warning' : hasNotes ? 'success_with_notes' : 'success',
    run_id: runId,
    raw_fetched: counts!.rawFetched,
    duplicates: counts!.duplicates,
    pulled: counts!.pulled,
    upserted: counts!.upserted,
    rejected: rejectedReasons.length,
    rejected_reasons: rejectedReasons.slice(0, 20),
    deactivated: finishResult?.deactivated ?? 0,
    finish_note: finishResult?.note ?? null,
    mapping_report: report,
    unknown_statuses: unknownStatuses,
    post_finish_notes: postFinishNotes,
  })
}
