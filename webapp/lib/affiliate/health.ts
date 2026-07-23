// P3-A r1 — Affiliate Sync Health gate (audit 23/07: rejected=null fail-closed,
// canary SCOPED theo target stores, stale so sánh millisecond, chặn timestamp
// invalid/tương-lai, surface lỗi lookup last-success).
// Trả lời MỘT câu hỏi cho KPI engine: nguồn affiliate_orders có đủ tươi/sạch
// để recompute snapshot campaign có metric_affiliate không?
//   • ready=false → engine GIỮ SNAPSHOT CŨ (không bao giờ ghi số 0 thay thế).
//   • Campaign Offline-only TUYỆT ĐỐI không gọi helper này (không phụ thuộc).
//   • Canary CHỈ kiểm các store thuộc targets của campaign — đơn FS/external
//     lỗi không được phép chặn campaign OS (audit r1 P1#2).
// Pure evaluate tách khỏi fetch (interface AffiliateHealthDb — fake được trong
// unit test). Fail-closed: mọi dữ liệu không rõ/lỗi đọc DB đều ready=false.

export interface AffiliateSyncHealth {
  ready: boolean
  reason: string | null
  runId: string | null
  lastSuccessAt: string | null
  ageMinutes: number | null
}

// 1.5× cadence cron 2h — quá mốc coi như nguồn đứng (mất allowlist, cron chết…).
export const AFFILIATE_STALE_LIMIT_MINUTES = 180
const STALE_LIMIT_MS = AFFILIATE_STALE_LIMIT_MINUTES * 60_000
// finished_at được phép lệch tương lai tối đa chừng này (clock skew giữa DB và
// app); vượt quá = timestamp không tin được → fail-closed (audit r1 P2#4).
const CLOCK_SKEW_MS = 5 * 60_000

export interface AffiliateLatestRun {
  id: string
  status: string
  finished_at: string | null
  rejected: number | null
  note: string | null
  error: string | null
  // jsonb từ affiliate_sync_runs — kiểu unknown vì DB không ép; validate khi đọc
  // (r2 P1#1: code chưa map/status lạ = GMV có nguy cơ thiếu → chặn recompute).
  unmatched_codes: unknown
  unknown_statuses: unknown
}

// jsonb hợp lệ = null hoặc mảng; mọi kiểu khác = dữ liệu run không tin được.
const issueList = (v: unknown): { ok: boolean; items: string[] } => {
  if (v === null || v === undefined) return { ok: true, items: [] }
  if (Array.isArray(v)) return { ok: true, items: v.map((x) => String(x)) }
  return { ok: false, items: [] }
}

export interface AffiliateHealthInput {
  latestRun: AffiliateLatestRun | null
  lastSuccessAt: string | null            // finished_at của run success gần nhất (kể cả khi latestRun failed)
  lastSuccessLookupError: string | null   // lỗi khi đọc mốc success (metadata phải có giải thích — audit r1 P2#5)
  deliveredMissingCompleted: number       // canary ĐÃ SCOPED theo target stores
  nowMs: number
}

export function evaluateAffiliateSyncHealth(input: AffiliateHealthInput): AffiliateSyncHealth {
  const { latestRun, lastSuccessAt, lastSuccessLookupError, deliveredMissingCompleted, nowMs } = input

  const lastSuccessMs = lastSuccessAt !== null ? Date.parse(lastSuccessAt) : NaN
  // ageMinutes CHỈ để hiển thị (floor, clamp ≥0 — trong clock-skew age có thể
  // âm, r2 P2) — mọi quyết định stale so sánh ms trực tiếp.
  const ageMinutes = Number.isFinite(lastSuccessMs) ? Math.max(0, Math.floor((nowMs - lastSuccessMs) / 60_000)) : null
  const base = { runId: latestRun?.id ?? null, lastSuccessAt, ageMinutes }
  const lookupNote = lastSuccessLookupError ? ` · mốc success gần nhất không xác định: ${lastSuccessLookupError}` : ''
  const notReady = (reason: string): AffiliateSyncHealth => ({ ready: false, reason: reason + lookupNote, ...base })

  // Thứ tự kiểm: trạng thái run → toàn vẹn dữ liệu run → độ tươi → canary.
  if (!latestRun) return notReady('chưa có sync run nào (backfill chưa chạy)')
  if (latestRun.status === 'running') return notReady('sync đang chạy — chờ run kết thúc')
  if (latestRun.status === 'failed') {
    return notReady(`run mới nhất FAILED${latestRun.error ? `: ${latestRun.error}` : ''}`)
  }
  if (latestRun.status !== 'success') return notReady(`run mới nhất có status lạ: ${latestRun.status}`)
  if (!latestRun.finished_at) return notReady('run success nhưng thiếu finished_at — dữ liệu run không toàn vẹn')

  const finishedAtMs = Date.parse(latestRun.finished_at)
  if (!Number.isFinite(finishedAtMs)) {
    return notReady(`finished_at không hợp lệ: ${latestRun.finished_at}`)
  }
  if (finishedAtMs > nowMs + CLOCK_SKEW_MS) {
    return notReady('finished_at nằm trong tương lai vượt clock-skew cho phép — timestamp không tin được')
  }
  // rejected=null = KHÔNG RÕ run có sạch không → fail-closed (audit r1 P1#1).
  if (latestRun.rejected === null || latestRun.rejected === undefined) {
    return notReady('rejected=null — dữ liệu run không rõ, không xác nhận được snapshot sạch')
  }
  if (latestRun.rejected > 0) {
    return notReady(`run có ${latestRun.rejected} row rejected — snapshot nguồn không sạch`)
  }
  if (latestRun.note) {
    // rpc_finish chỉ ghi note khi có cảnh báo vận hành (vd safety-floor bỏ qua
    // mark-missing) → snapshot có thể không đầy đủ.
    return notReady(`run có note vận hành: ${latestRun.note}`)
  }
  // r2 P1#1: code chưa map (gồm cả inactive — F2 hợp nhất vào p_unmatched) hoặc
  // status lạ = có đơn KHÔNG được phân loại đúng → GMV có nguy cơ thiếu.
  const unmatched = issueList(latestRun.unmatched_codes)
  if (!unmatched.ok) return notReady('unmatched_codes sai kiểu JSON — dữ liệu run không tin được')
  if (unmatched.items.length > 0) {
    return notReady(`run có ${unmatched.items.length} partner code chưa map/inactive: ${unmatched.items.slice(0, 5).join(', ')}`)
  }
  const unknownSt = issueList(latestRun.unknown_statuses)
  if (!unknownSt.ok) return notReady('unknown_statuses sai kiểu JSON — dữ liệu run không tin được')
  if (unknownSt.items.length > 0) {
    return notReady(`run có status lạ chưa phân loại: ${unknownSt.items.slice(0, 5).join(', ')}`)
  }
  if (nowMs - finishedAtMs > STALE_LIMIT_MS) {
    return notReady(`snapshot stale ${Math.floor((nowMs - finishedAtMs) / 60_000)} phút (> ${AFFILIATE_STALE_LIMIT_MINUTES})`)
  }
  if (deliveredMissingCompleted > 0) {
    return notReady(`${deliveredMissingCompleted} đơn DELIVERED thiếu completed_time trong target stores — aggregation sẽ fail-closed`)
  }
  return { ready: true, reason: null, ...base }
}

// ── Data-access interface (fake được trong test; impl thật bên dưới) ─────────
export interface AffiliateHealthDb {
  latestRun(): Promise<{ data: AffiliateLatestRun | null; error: { message: string } | null }>
  lastSuccessFinishedAt(): Promise<{ data: { finished_at: string | null } | null; error: { message: string } | null }>
  countDeliveredMissingCompleted(storeIds: string[]): Promise<{ count: number | null; error: { message: string } | null }>
}

// targetStoreIds = danh sách store trong kpi_campaign_store_targets của
// campaign (P3-B validate toàn bộ là OS trước khi gọi). Rỗng → fail-closed.
export async function getAffiliateSyncHealth(
  db: AffiliateHealthDb,
  targetStoreIds: string[],
): Promise<AffiliateSyncHealth> {
  if (targetStoreIds.length === 0) {
    return { ready: false, reason: 'danh sách store target rỗng — campaign chưa có target để kiểm canary', runId: null, lastSuccessAt: null, ageMinutes: null }
  }

  const { data: latestRun, error: runErr } = await db.latestRun()
  if (runErr) {
    return { ready: false, reason: `không đọc được affiliate_sync_runs: ${runErr.message}`, runId: null, lastSuccessAt: null, ageMinutes: null }
  }

  let lastSuccessAt: string | null = latestRun?.status === 'success' ? latestRun.finished_at : null
  let lastSuccessLookupError: string | null = null
  if (latestRun && latestRun.status !== 'success') {
    const { data: s, error: sErr } = await db.lastSuccessFinishedAt()
    if (sErr) lastSuccessLookupError = sErr.message
    else lastSuccessAt = s?.finished_at ?? null
  }

  const { count, error: cErr } = await db.countDeliveredMissingCompleted(targetStoreIds)
  if (cErr) {
    return {
      ready: false,
      reason: `không đọc được canary affiliate_orders: ${cErr.message}`,
      runId: latestRun?.id ?? null, lastSuccessAt, ageMinutes: null,
    }
  }
  // r2 P1#2: count=null (PostgREST không trả count dù không error) = KHÔNG RÕ
  // — fail-closed, không được coi là 0/sạch.
  if (count === null || count === undefined) {
    return {
      ready: false,
      reason: 'canary không trả count (null) — không xác nhận được dữ liệu sạch',
      runId: latestRun?.id ?? null, lastSuccessAt, ageMinutes: null,
    }
  }

  return evaluateAffiliateSyncHealth({
    latestRun,
    lastSuccessAt,
    lastSuccessLookupError,
    deliveredMissingCompleted: count,
    nowMs: Date.now(),
  })
}

// ── Impl thật trên Supabase client (service-role — sync_runs RLS super-only).
// Kiểu hóa lỏng có chủ đích để không kéo type generator; hành vi được phủ bởi
// unit test qua interface + integration ở P3-B. ─────────────────────────────
type LooseClient = { from: (t: string) => any } // eslint-disable-line @typescript-eslint/no-explicit-any

export function supabaseAffiliateHealthDb(svc: LooseClient): AffiliateHealthDb {
  return {
    latestRun: () => svc.from('affiliate_sync_runs')
      .select('id, status, finished_at, rejected, note, error, unmatched_codes, unknown_statuses')
      .order('started_at', { ascending: false }).limit(1).maybeSingle(),
    lastSuccessFinishedAt: () => svc.from('affiliate_sync_runs')
      .select('finished_at').eq('status', 'success')
      .order('started_at', { ascending: false }).limit(1).maybeSingle(),
    countDeliveredMissingCompleted: async (storeIds: string[]) => {
      const { count, error } = await svc.from('affiliate_orders')
        .select('order_id', { count: 'exact', head: true })
        .eq('status_norm', 'delivered').eq('source_active', true)
        .in('store_id', storeIds).is('completed_time', null)
      return { count, error }
    },
  }
}
