// P3-A — Affiliate Sync Health gate (roadmap stakeholder 23/07).
// Trả lời MỘT câu hỏi cho KPI engine: nguồn affiliate_orders có đủ tươi/sạch
// để recompute snapshot campaign có metric_affiliate không?
//   • ready=false → engine GIỮ SNAPSHOT CŨ (không bao giờ ghi số 0 thay thế).
//   • Campaign Offline-only TUYỆT ĐỐI không gọi helper này (không phụ thuộc).
// Pure evaluate tách khỏi fetch (DI SupabaseClient) để unit-test đủ mọi trạng
// thái không cần DB. Fail-closed: lỗi đọc DB cũng là ready=false.

export interface AffiliateSyncHealth {
  ready: boolean
  reason: string | null
  runId: string | null
  lastSuccessAt: string | null
  ageMinutes: number | null
}

// 1.5× cadence cron 2h — quá mốc này coi như nguồn đứng (mất VPN/allowlist,
// cron chết…), khớp ngưỡng đã chốt trong plan v1.1.
export const AFFILIATE_STALE_LIMIT_MINUTES = 180

export interface AffiliateHealthInput {
  latestRun: {
    id: string
    status: string
    finished_at: string | null
    rejected: number | null
    note: string | null
    error: string | null
  } | null
  lastSuccessAt: string | null           // finished_at của run success gần nhất (kể cả khi latestRun failed)
  deliveredMissingCompleted: number      // canary: đơn DELIVERED active thiếu completed_time
  nowMs: number
}

export function evaluateAffiliateSyncHealth(input: AffiliateHealthInput): AffiliateSyncHealth {
  const { latestRun, lastSuccessAt, deliveredMissingCompleted, nowMs } = input
  const ageMinutes = lastSuccessAt !== null
    ? Math.round((nowMs - Date.parse(lastSuccessAt)) / 60_000)
    : null
  const base = { runId: latestRun?.id ?? null, lastSuccessAt, ageMinutes }
  const notReady = (reason: string): AffiliateSyncHealth => ({ ready: false, reason, ...base })

  // Thứ tự kiểm: trạng thái run → độ sạch run → độ tươi → canary dữ liệu.
  if (!latestRun) return notReady('chưa có sync run nào (backfill chưa chạy)')
  if (latestRun.status === 'running') return notReady('sync đang chạy — chờ run kết thúc')
  if (latestRun.status === 'failed') {
    return notReady(`run mới nhất FAILED${latestRun.error ? `: ${latestRun.error}` : ''}`)
  }
  if (latestRun.status !== 'success') return notReady(`run mới nhất có status lạ: ${latestRun.status}`)
  if (!latestRun.finished_at) return notReady('run success nhưng thiếu finished_at — dữ liệu run không toàn vẹn')
  if ((latestRun.rejected ?? 0) > 0) {
    return notReady(`run có ${latestRun.rejected} row rejected — snapshot nguồn không sạch`)
  }
  if (latestRun.note) {
    // rpc_finish chỉ ghi note khi có cảnh báo vận hành (vd safety-floor bỏ qua
    // mark-missing) → snapshot có thể không đầy đủ.
    return notReady(`run có note vận hành: ${latestRun.note}`)
  }
  if (ageMinutes === null || ageMinutes > AFFILIATE_STALE_LIMIT_MINUTES) {
    return notReady(`snapshot stale ${ageMinutes ?? '?'} phút (> ${AFFILIATE_STALE_LIMIT_MINUTES})`)
  }
  if (deliveredMissingCompleted > 0) {
    return notReady(`${deliveredMissingCompleted} đơn DELIVERED thiếu completed_time — aggregation sẽ fail-closed`)
  }
  return { ready: true, reason: null, ...base }
}

// ── Fetch wrapper (DI client — caller truyền supabaseAdmin; service-role vì
// affiliate_sync_runs RLS chỉ cho super đọc) ─────────────────────────────────
type MinimalClient = {
  from: (table: string) => {
    select: (cols: string, opts?: { count?: 'exact'; head?: boolean }) => unknown
  }
}

export async function getAffiliateSyncHealth(svc: MinimalClient): Promise<AffiliateSyncHealth> {
  // Kiểu hóa lỏng để không kéo type generator; mọi lỗi đọc → fail-closed.
  const runs = svc.from('affiliate_sync_runs')
    .select('id, status, finished_at, rejected, note, error') as unknown as {
      order: (c: string, o: { ascending: boolean }) => {
        limit: (n: number) => { maybeSingle: () => Promise<{ data: AffiliateHealthInput['latestRun']; error: { message: string } | null }> }
      }
    }
  const { data: latestRun, error: runErr } = await runs
    .order('started_at', { ascending: false }).limit(1).maybeSingle()
  if (runErr) {
    return { ready: false, reason: `không đọc được affiliate_sync_runs: ${runErr.message}`, runId: null, lastSuccessAt: null, ageMinutes: null }
  }

  let lastSuccessAt: string | null = latestRun?.status === 'success' ? latestRun.finished_at : null
  if (latestRun && latestRun.status !== 'success') {
    const succ = svc.from('affiliate_sync_runs').select('finished_at') as unknown as {
      eq: (c: string, v: string) => {
        order: (c: string, o: { ascending: boolean }) => {
          limit: (n: number) => { maybeSingle: () => Promise<{ data: { finished_at: string | null } | null; error: { message: string } | null }> }
        }
      }
    }
    const { data: s } = await succ.eq('status', 'success').order('started_at', { ascending: false }).limit(1).maybeSingle()
    lastSuccessAt = s?.finished_at ?? null
  }

  const canary = svc.from('affiliate_orders')
    .select('order_id', { count: 'exact', head: true }) as unknown as {
      eq: (c: string, v: unknown) => { eq: (c: string, v: unknown) => { is: (c: string, v: null) => Promise<{ count: number | null; error: { message: string } | null }> } }
    }
  const { count, error: cErr } = await canary
    .eq('status_norm', 'delivered').eq('source_active', true).is('completed_time', null)
  if (cErr) {
    return { ready: false, reason: `không đọc được canary affiliate_orders: ${cErr.message}`, runId: latestRun?.id ?? null, lastSuccessAt, ageMinutes: null }
  }

  return evaluateAffiliateSyncHealth({
    latestRun,
    lastSuccessAt,
    deliveredMissingCompleted: count ?? 0,
    nowMs: Date.now(),
  })
}
