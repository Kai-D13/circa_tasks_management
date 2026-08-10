import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { isAffiliateSyncEnabled } from '@/lib/affiliate/flags'
import { fetchAffiliateOrdersSnapshot } from '@/lib/affiliate/mongo'
import { resolveMappingsWithAutoCreate } from '@/lib/affiliate/ensureFs'
import {
  dedupeByOrderId,
  resolveStores,
  sourceIssueCodes,
  validateSourceOrder,
  type AffiliateOrderRow,
  type PartnerMappingRow,
  type SourceOrderDoc,
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
// Phân loại lỗi theo LOẠI, không theo prefix message (audit r1.1 P2 — driver
// Mongo trả "Server selection timed out after 15000 ms", không bắt đầu bằng
// "Mongo" nên nhánh prefix cũ rơi về 500 sai).
class SourceError extends Error {}  // đọc upstream Mongo → 502
class UpsertError extends Error {}  // ghi affiliate_orders → 502 (contract F2)

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
    let rawDocs: SourceOrderDoc[]
    try {
      rawDocs = await fetchAffiliateOrdersSnapshot(Math.min(MONGO_MAX_TIME_MS, Math.max(1_000, timeLeft())))
    } catch (e) {
      throw new SourceError(`Mongo: ${e instanceof Error ? e.message : 'unknown'}`)
    }
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
    // FS-expansion (contract 06/08 + mig 102) r1: luồng auto-create mapping FS
    // nằm trong CORE resolveMappingsWithAutoCreate (lib/affiliate/ensureFs.ts,
    // test bằng fake deps — audit P1#3): mã mới hợp lệ → RPC ensure
    // (insert-if-absent, không đụng mapping hiện hữu kể cả inactive) → ĐỌC LẠI
    // mappings từ DB rồi mới resolve; dry-run KHÔNG ghi (chỉ would_create_fs);
    // mã vi phạm contract partner_code → invalid_new_codes, không gửi RPC (tự
    // rơi unmatched → health chặn — không sập cả run vì 1 mã hỏng); ensure
    // lỗi → throw → fail run, KHÔNG upsert.
    const ensured = await resolveMappingsWithAutoCreate(valid, isDry, {
      loadMappings: async (): Promise<PartnerMappingRow[]> => {
        guard('đọc mappings')
        const { data, error } = await supabaseAdmin
          .from('affiliate_partner_mappings')
          .select('partner_code, store_id, partner_type, is_active')
          .abortSignal(sig())
        if (error) throw new Error(`Đọc mappings: ${error.message}`)
        return (data ?? []) as PartnerMappingRow[]
      },
      ensureFsMappings: async (codes: string[]): Promise<string[]> => {
        guard('ensure fs mappings')
        const { data: created, error: ensureErr } = await supabaseAdmin
          .rpc('rpc_ensure_fs_partner_mappings', { p_codes: codes })
          .abortSignal(sig())
        if (ensureErr) throw new Error(`Tạo mapping FS cho mã mới: ${ensureErr.message}`)
        return (created ?? []) as string[]
      },
    })
    const newFsCodes = ensured.newFsCodes
    const { resolved, report } = resolveStores(valid, ensured.mappings)
    const unknownStatuses = [...new Set(valid.filter((r) => r.status_norm === 'other').map((r) => r.raw_status))]
    // Canary KPI (audit r2.1 P1): DELIVERED thiếu completed_time sẽ bị
    // aggregation fail-closed (rpc_aggregate_affiliate_gmv RAISE) — báo sớm ở
    // đây để vận hành thấy TRƯỚC khi KPI đứng snapshot. Ingest vẫn lưu đủ.
    const deliveredMissingCompleted = valid.filter((r) => r.status_norm === 'delivered' && r.completed_time === null)
    // Canary IDENTITY (mig 104 — contract 09/08): identity khách =
    // customer_phone_norm (buyer phone chuẩn hóa), KHÔNG còn account_id.
    //   · missing_customer_phone (DIAGNOSTIC — r1 audit P1#4): đơn ĐỦ ĐIỀU
    //     KIỆN đếm (delivered + total_price>0 + CÓ completed_time + mapping OS
    //     ACTIVE) thiếu phone hợp lệ. Cron KHÔNG biết campaign nào đang chạy
    //     và canary này quét TOÀN NGUỒN (mọi thời điểm) — đơn cũ ngoài kỳ
    //     campaign không được làm run 'warning'. Fail-closed THẬT nằm ở
    //     rpc_aggregate_affiliate_customers + activation gate (scope đúng
    //     campaign range ∩ target stores). Ở đây chỉ đếm + log để vận hành
    //     thấy sớm chất lượng nguồn.
    //   · missing_account_id (DIAGNOSTIC thuần — 104 hạ cấp từ blocking):
    //     account_id không còn tham gia identity; giữ đếm để theo dõi chất
    //     lượng nguồn, KHÔNG đổi status run.
    const osCodes = new Set(ensured.mappings
      .filter((m) => m.partner_type === 'os' && m.is_active && m.store_id)
      .map((m) => m.partner_code))
    const missingPhoneEligible = valid.filter((r) =>
      r.status_norm === 'delivered' && r.total_price > 0 && r.completed_time !== null
      && osCodes.has(r.partner_code) && r.customer_phone_norm === null)
    const deliveredMissingAccount = valid.filter((r) => r.status_norm === 'delivered' && r.account_id === null)
    const missingAccountOs = deliveredMissingAccount.filter((r) => osCodes.has(r.partner_code))
    const missingAccountNonOs = deliveredMissingAccount.filter((r) => !osCodes.has(r.partner_code))
    return {
      rawFetched: rawDocs.length, duplicates, unique, resolved, rejected, report, unknownStatuses,
      newFsCodes,
      wouldCreateFs: ensured.wouldCreateFs,
      invalidNewCodes: ensured.invalidNewCodes,
      deliveredMissingCompletedCount: deliveredMissingCompleted.length,
      deliveredMissingCompletedSample: deliveredMissingCompleted.slice(0, 10).map((r) => r.order_id),
      deliveredMissingAccountCount: missingAccountOs.length,
      deliveredMissingAccountSample: missingAccountOs.slice(0, 10).map((r) => r.order_id),
      missingPhoneEligibleCount: missingPhoneEligible.length,
      missingPhoneEligibleSample: missingPhoneEligible.slice(0, 10).map((r) => r.order_id),
      deliveredMissingAccountNonOsCount: missingAccountNonOs.length,
      deliveredMissingAccountNonOsSample: missingAccountNonOs.slice(0, 10).map((r) => r.order_id),
    }
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
        // FS-expansion: dry-run KHÔNG tạo mapping — mã mới liệt kê ở đây
        // (và vẫn nằm unmatched trong mapping_report của dry). r1: mã vi phạm
        // contract partner_code tách riêng — sẽ KHÔNG được auto-create.
        would_create_fs: d.wouldCreateFs,
        invalid_new_codes: d.invalidNewCodes,
        mapping_report: d.report,
        unknown_statuses: d.unknownStatuses,
        delivered_missing_completed_time_count: d.deliveredMissingCompletedCount,
        delivered_missing_completed_time_sample: d.deliveredMissingCompletedSample,
        // mig 104: identity = phone (BLOCKING); account_id chỉ diagnostic.
        missing_customer_phone_count: d.missingPhoneEligibleCount,
        missing_customer_phone_sample: d.missingPhoneEligibleSample,
        delivered_missing_account_id_count: d.deliveredMissingAccountCount,
        delivered_missing_account_id_sample: d.deliveredMissingAccountSample,
        delivered_missing_account_id_non_os_count: d.deliveredMissingAccountNonOsCount,
        delivered_missing_account_id_non_os_sample: d.deliveredMissingAccountNonOsSample,
        status_distribution: statusCount,
        partner_code_distribution: codeCount,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown'
      const status = e instanceof DeadlineError ? 504 : e instanceof SourceError ? 502 : 500
      return NextResponse.json({ error: `Dry-run: ${msg}` }, { status })
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

  // rpc_fail dùng signal RIÊNG (không dính deadline đã cháy) để luôn đóng được
  // run, và TỰ NUỐT exception (audit r1.1 P2): nếu client throw (abort/network)
  // thì response lỗi GỐC vẫn phải trả về; run kẹt sẽ được lease 15' thu hồi.
  const failRun = async (msg: string) => {
    try {
      const { error } = await supabaseAdmin
        .rpc('rpc_fail_affiliate_sync', { p_run_id: runId, p_error: msg })
        .abortSignal(AbortSignal.timeout(30_000))
      if (error) console.error('[affiliate-sync] rpc_fail cũng lỗi:', error.message)
    } catch (e) {
      console.error('[affiliate-sync] rpc_fail throw (nuốt để giữ lỗi gốc):', e instanceof Error ? e.message : e)
    }
  }

  interface FinishResult { deactivated?: number; note?: string | null }
  let finishResult: FinishResult | null = null
  let counts: { rawFetched: number; duplicates: number; pulled: number; upserted: number } | null = null
  let rejectedReasons: { order_id: unknown; reason: string }[] = []
  let report: ReturnType<typeof resolveStores>['report'] | null = null
  let unknownStatuses: string[] = []
  let newFsCodes: string[] = []
  let invalidNewCodes: string[] = []
  let deliveredMissingCompletedCount = 0
  let deliveredMissingCompletedSample: number[] = []
  let deliveredMissingAccountCount = 0
  let deliveredMissingAccountSample: number[] = []
  let deliveredMissingAccountNonOsCount = 0
  let deliveredMissingAccountNonOsSample: number[] = []
  let missingPhoneEligibleCount = 0
  let missingPhoneEligibleSample: number[] = []

  try {
    const d = await readAndClassify()
    rejectedReasons = d.rejected
    report = d.report
    unknownStatuses = d.unknownStatuses
    newFsCodes = d.newFsCodes
    invalidNewCodes = d.invalidNewCodes
    deliveredMissingCompletedCount = d.deliveredMissingCompletedCount
    deliveredMissingCompletedSample = d.deliveredMissingCompletedSample
    deliveredMissingAccountCount = d.deliveredMissingAccountCount
    deliveredMissingAccountSample = d.deliveredMissingAccountSample
    deliveredMissingAccountNonOsCount = d.deliveredMissingAccountNonOsCount
    deliveredMissingAccountNonOsSample = d.deliveredMissingAccountNonOsSample
    missingPhoneEligibleCount = d.missingPhoneEligibleCount
    missingPhoneEligibleSample = d.missingPhoneEligibleSample

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
      if (upErr) throw new UpsertError(`Upsert batch ${i / UPSERT_CHUNK + 1}: ${upErr.message}`)
    }

    // 3) Finish — mark-missing + safety floor + đóng run trong 1 transaction ở DB.
    guard('rpc_finish')
    const sourceIssues = sourceIssueCodes(report)
    const { data: finish, error: finErr } = await supabaseAdmin
      .rpc('rpc_finish_affiliate_sync', {
        p_run_id: runId,
        p_pulled: d.unique.length,
        p_upserted: upsertRows.length,
        p_rejected: rejectedReasons.length,
        // Hợp nhất unmatched + inactive, dedupe (P3-A r2/r2.1 — health gate đọc
        // từ run; inactive không có cột riêng, audit chốt: không cần migration).
        p_unmatched: sourceIssues.length ? sourceIssues : null,
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
    const status = e instanceof DeadlineError ? 504
      : e instanceof SourceError || e instanceof UpsertError ? 502
      : 500
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
  if (newFsCodes.length > 0) {
    // FS-expansion: mã mới đã TỰ TẠO mapping fs — lần sync kế phải rỗng
    // (idempotent); log để vận hành biết có đối tác mới xuất hiện.
    console.warn('[affiliate-sync] new_fs_codes — đã tự tạo mapping FS:', newFsCodes.join(', '))
  }
  if (invalidNewCodes.length > 0) {
    // r1: mã mới VI PHẠM contract partner_code (control char/quá dài/không
    // trim) — KHÔNG auto-create; nằm unmatched → health chặn READY tới khi
    // vận hành xử lý nguồn (fail-visible, không sập run).
    console.warn('[affiliate-sync] invalid_new_codes — vi phạm contract partner_code, KHÔNG auto-create:', JSON.stringify(invalidNewCodes))
  }
  if (report && report.unmatched_codes.length > 0) {
    console.warn('[affiliate-sync] partner_code chưa map/mapping sai cấu hình (store NULL):', report.unmatched_codes.join(', '))
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
  if (deliveredMissingCompletedCount > 0) {
    // Audit r2.1 P1: các đơn này sẽ làm rpc_aggregate_affiliate_gmv fail-closed
    // (KPI giữ snapshot cũ) — phải WARN + status warning để vận hành xử lý nguồn.
    console.warn(`[affiliate-sync] ${deliveredMissingCompletedCount} đơn DELIVERED thiếu completed_time (KPI aggregate sẽ fail-closed):`,
      deliveredMissingCompletedSample.join(', '))
  }
  if (missingPhoneEligibleCount > 0) {
    // DIAGNOSTIC (r1 P1#4): KHÔNG đổi status run — campaign khách có bị chặn
    // hay không do RPC quyết theo ĐÚNG range của campaign đó.
    console.warn(`[affiliate-sync] ${missingPhoneEligibleCount} đơn DELIVERED (OS, đủ điều kiện đếm) thiếu SĐT khách hợp lệ — diagnostic; aggregate SỐ KHÁCH chỉ fail-closed nếu đơn nằm TRONG kỳ campaign:`,
      missingPhoneEligibleSample.join(', '))
  }
  if (deliveredMissingAccountCount > 0) {
    // 104: account_id KHÔNG còn là identity → diagnostic thuần (info).
    console.info(`[affiliate-sync] ${deliveredMissingAccountCount} đơn DELIVERED (OS) thiếu account_id — diagnostic chất lượng nguồn, KHÔNG chặn campaign khách (identity đã chuyển sang SĐT):`,
      deliveredMissingAccountSample.join(', '))
  }
  if (deliveredMissingAccountNonOsCount > 0) {
    // NON-OS DIAGNOSTIC (r1.3.5): ngoài scope campaign khách — chỉ ghi nhận.
    console.info(`[affiliate-sync] ${deliveredMissingAccountNonOsCount} đơn DELIVERED (FS/partner) thiếu account_id — diagnostic, không ảnh hưởng campaign khách OS:`,
      deliveredMissingAccountNonOsSample.join(', '))
  }

  const hasNotes = (report?.unmatched_codes.length ?? 0) > 0 || (report?.inactive_codes.length ?? 0) > 0
    || unknownStatuses.length > 0 || newFsCodes.length > 0 || invalidNewCodes.length > 0
  return NextResponse.json({
    ok: true,
    status: rejectedReasons.length > 0 || deliveredMissingCompletedCount > 0
      ? 'warning' : hasNotes ? 'success_with_notes' : 'success',
    run_id: runId,
    raw_fetched: counts!.rawFetched,
    duplicates: counts!.duplicates,
    pulled: counts!.pulled,
    upserted: counts!.upserted,
    rejected: rejectedReasons.length,
    rejected_reasons: rejectedReasons.slice(0, 20),
    deactivated: finishResult?.deactivated ?? 0,
    finish_note: finishResult?.note ?? null,
    mapping_report: { ...report, new_fs_codes: newFsCodes, invalid_new_codes: invalidNewCodes },
    unknown_statuses: unknownStatuses,
    delivered_missing_completed_time_count: deliveredMissingCompletedCount,
    delivered_missing_completed_time_sample: deliveredMissingCompletedSample,
    // mig 104 r1: phone + account_id đều DIAGNOSTIC ở tầng cron (fail-closed
    // thật nằm ở RPC aggregate/activation theo đúng campaign range).
    missing_customer_phone_count: missingPhoneEligibleCount,
    missing_customer_phone_sample: missingPhoneEligibleSample,
    delivered_missing_account_id_count: deliveredMissingAccountCount,
    delivered_missing_account_id_sample: deliveredMissingAccountSample,
    delivered_missing_account_id_non_os_count: deliveredMissingAccountNonOsCount,
    delivered_missing_account_id_non_os_sample: deliveredMissingAccountNonOsSample,
    post_finish_notes: postFinishNotes,
  })
}
