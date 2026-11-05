// CMS P2-b — handler thuần cho GET /api/cron/sync-cms-sales (kế hoạch PM 02/11 §5; SPEC §6, §9). Thứ tự kiểm (fail-closed,
// không IO trước khi đạt):
//   1) Bearer CRON_SECRET (so sánh hằng thời gian)                  ⇒ 401
//   2) CMS_PROGRAM_ENABLED HOẶC CMS_EARNINGS_ENABLED tắt              ⇒ 503 FLAG_OFF, KHÔNG dựng deps, KHÔNG query nguồn
//   3) cấu hình nguồn sai / thiếu CMS_BQ_SALES_TABLE                  ⇒ 503, không query
//   4) chọn chương trình: active, KHÔNG is_test, đã bắt đầu (ngày VN) — gồm cả chương trình đã kết thúc nhưng chưa chốt;
//      ưu tiên lần công bố thành công cũ nhất (chưa từng ⇒ trước). Một chương trình lỗi không chặn chương trình khác.
//      Hết ngân sách ⇒ chương trình còn lại ghi `pending` cho lượt sau (không gọi là đã đồng bộ hết).
// HTTP: 200 mọi chương trình published / skipped · 207 có held / busy / pending · 500 có lỗi. Body chỉ số đếm + mã.

import { cronBearerMatches } from './cronProducts'
import { cmsCanPublishResults } from './releaseGate'
import { cmsSourceCaptureFromEnv } from './flags'
import {
  CMS_RPC_TIMEOUT_MAX_MS, CMS_RPC_TIMEOUT_MIN_MS, CMS_SALES_MIN_PROGRAM_MS, runCmsSalesSync,
  type CmsIo, type CmsSalesSyncDeps, type CmsSalesSyncResult,
} from './salesSync'
import { vnDateOfMicros } from './time'

/** Ngân sách mặc định toàn lượt cron (đo lại ở I4 trên quy mô thật trước khi tạo Scheduled Task). */
export const CMS_SALES_CRON_BUDGET_MS = 240_000

export interface CmsDueProgram {
  id: string
  /** Lần công bố thành công gần nhất (ISO); null = chưa từng. */
  lastPublishedAt: string | null
}

export interface CmsSalesCronDeps extends CmsSalesSyncDeps {
  /** Chương trình cần tính: status 'active', is_test = false, start_date ≤ ngày VN hôm nay. Timeout theo ngân sách cron. */
  listDuePrograms(todayVn: string, io: CmsIo): Promise<CmsDueProgram[]>
}

export interface CmsSalesCronSummary {
  programs: number
  results: Array<Pick<CmsSalesSyncResult, 'programId' | 'status' | 'code' | 'rowsRead' | 'candidates' | 'unassigned' | 'stagedRows' | 'elapsedMs'>
    & { cleanupMore: boolean | null; cleanupStoppedBy: string | null }>
  pending: string[]
  /** Cảnh báo theo dõi retention: CLEANUP_PENDING (còn run cần dọn / dừng vì ngân sách) · CLEANUP_FAILED. */
  warnings: string[]
  /** Thời gian toàn lượt cron (gồm mọi chương trình + cleanup). */
  elapsedMs: number
}

const NO_CLEANUP = { cleanupMore: null, cleanupStoppedBy: null }

export function orderDuePrograms(list: readonly CmsDueProgram[]): CmsDueProgram[] {
  return [...list].sort((a, b) => {
    if (a.lastPublishedAt === b.lastPublishedAt) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    if (a.lastPublishedAt === null) return -1
    if (b.lastPublishedAt === null) return 1
    return a.lastPublishedAt < b.lastPublishedAt ? -1 : 1
  })
}

export async function runCmsSalesCron(
  deps: CmsSalesCronDeps,
  // releaseOpen: CHỈ để test luồng cron khi cổng Q-206 đã mở; handler route không truyền ⇒ luôn theo hằng releaseGate.
  // sourceCapture: mặc định theo cờ CMS_SOURCE_CAPTURE_ENABLED (migration 124); test truyền tường minh.
  opts: { budgetMs?: number; releaseOpen?: boolean; sourceCapture?: boolean } = {},
): Promise<CmsSalesCronSummary> {
  const t0 = deps.now()
  const budget = opts.budgetMs ?? CMS_SALES_CRON_BUDGET_MS
  const deadlineAt = t0 + budget
  const today = vnDateOfMicros(BigInt(t0) * BigInt(1000))
  // Truy vấn chọn chương trình cũng nằm trong ngân sách cron (pm-auditor r2.2 L6), không timeout cố định ngoài vòng.
  const listIo: CmsIo = { timeoutMs: Math.max(CMS_RPC_TIMEOUT_MIN_MS, Math.min(CMS_RPC_TIMEOUT_MAX_MS, deadlineAt - deps.now())) }
  const programs = orderDuePrograms(await deps.listDuePrograms(today, listIo))
  const results: CmsSalesCronSummary['results'] = []
  const pending: string[] = []
  // Cron chỉ chọn chương trình thật (is_test = false). Cổng Q-206 đóng ⇒ bỏ qua TRƯỚC khi mở run: không quét BigQuery, không
  // tạo run held mỗi lượt (security review r2 P2-b). Đối soát trước khi mở cổng dùng script operator ở chế độ dry-run.
  const releaseOpen = opts.releaseOpen ?? cmsCanPublishResults(false)
  const sourceCapture = opts.sourceCapture ?? cmsSourceCaptureFromEnv(process.env)
  for (const p of programs) {
    if (!releaseOpen) {
      results.push({ programId: p.id, status: 'skipped', code: 'RESULTS_RELEASE_GATE', rowsRead: null, candidates: null, unassigned: null, stagedRows: 0, elapsedMs: 0, ...NO_CLEANUP })
      continue
    }
    // Ngân sách THẬT còn lại (đã trừ chương trình trước + cleanup của chúng) — không đủ ⇒ pending cho lượt sau.
    if (deadlineAt - deps.now() < CMS_SALES_MIN_PROGRAM_MS) { pending.push(p.id); continue }
    let r: CmsSalesSyncResult
    const tp = deps.now()
    try {
      r = await runCmsSalesSync(deps, p.id, { dryRun: false, source: 'cron', deadlineAt, sourceCapture })
    } catch {
      results.push({ programId: p.id, status: 'error', code: 'INTERNAL', rowsRead: null, candidates: null, unassigned: null, stagedRows: 0,
        elapsedMs: deps.now() - tp, ...NO_CLEANUP })
      continue
    }
    results.push({ programId: r.programId, status: r.status, code: r.code, rowsRead: r.rowsRead, candidates: r.candidates,
      unassigned: r.unassigned, stagedRows: r.stagedRows, elapsedMs: r.elapsedMs,
      cleanupMore: r.cleanup ? r.cleanup.more : null, cleanupStoppedBy: r.cleanup ? r.cleanup.stoppedBy : null })
  }
  const warnings: string[] = []
  if (results.some((x) => x.cleanupMore)) warnings.push('CLEANUP_PENDING')
  if (results.some((x) => x.cleanupStoppedBy === 'failed')) warnings.push('CLEANUP_FAILED')
  return { programs: programs.length, results, pending, warnings, elapsedMs: deps.now() - t0 }
}

export function cmsSalesCronHttpStatus(s: CmsSalesCronSummary): number {
  if (s.results.some((r) => r.status === 'error' || r.status === 'config_missing')) return 500
  if (s.pending.length || s.warnings.length || s.results.some((r) => r.status === 'held' || r.status === 'busy')) return 207
  return 200
}

export async function handleSyncCmsSales(input: {
  authorization: string | null
  cronSecret: string | undefined
  programEnabled: boolean
  earningsEnabled: boolean
  makeDeps: () => CmsSalesCronDeps
  budgetMs?: number
}): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!cronBearerMatches(input.authorization, input.cronSecret)) return { status: 401, body: { error: 'Unauthorized' } }
  if (!input.programEnabled || !input.earningsEnabled) {
    return { status: 503, body: { error: 'CMS chưa bật (CMS_PROGRAM_ENABLED + CMS_EARNINGS_ENABLED)', code: 'FLAG_OFF' } }
  }
  let deps: CmsSalesCronDeps
  try { deps = input.makeDeps() } catch { return { status: 503, body: { error: 'Cấu hình nguồn CMS không hợp lệ', code: 'CONFIG_INVALID' } } }
  if (!deps.table) return { status: 503, body: { error: 'Chưa cấu hình CMS_BQ_SALES_TABLE', code: 'CONFIG_MISSING' } }
  let summary: CmsSalesCronSummary
  try {
    summary = await runCmsSalesCron(deps, { budgetMs: input.budgetMs })
  } catch {
    return { status: 500, body: { error: 'Lỗi chọn chương trình CMS', code: 'LIST_FAILED' } }
  }
  const status = cmsSalesCronHttpStatus(summary)
  return { status, body: { status: status === 200 ? 'ok' : status === 207 ? 'partial' : 'error', ...summary } }
}
