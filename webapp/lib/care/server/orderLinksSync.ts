import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { CARE_SYNC_RPC_TIMEOUT_MS } from '@/lib/care/orders/sync'
import { CARE_ORDER_LINKS_QUERY_DEADLINE_MS, parseRunJob, readOrderLinksJob } from '@/lib/care/orderLinks/source'
import {
  CareOrderLinksDbError, parseBeginOpen, parseBeginSelect, parseChunk, parseComplete, runCareOrderLinks,
  type CareOrderLinksDeps, type CareOrderLinksRunOptions, type CareOrderLinksRunResult, type CareOrderLinksStep,
} from '@/lib/care/orderLinks/run'
import { careN3Table, preflightN3, runN3Query } from './n3Source'

// CRM-CSKH E — nối deps thật cho route care-order-links-{sync,close,trial}: RPC service_role của migration 116 + VIEW N3
// bằng SA app (cùng adapter 114). Lỗi DB / BigQuery chỉ thành MÃ (run.ts) — không log / trả message thô.

const rpcSignal = () => AbortSignal.timeout(CARE_SYNC_RPC_TIMEOUT_MS)

async function rpc(step: CareOrderLinksStep, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await supabaseAdmin.rpc(fn, args).abortSignal(rpcSignal())
  if (error) throw new CareOrderLinksDbError(step, error.message)
  return data
}

const realDeps: CareOrderLinksDeps = {
  beginOpen: async (kind, mode, retryPeriod, cap) => parseBeginOpen(await rpc('OPEN', 'care_order_links_begin_open',
    { p_kind: kind, p_mode: mode, p_retry_period: retryPeriod, p_per_customer_cap: cap })),
  preflight: () => preflightN3(),
  beginSelect: async (runId, maxTasks, maxAge) => parseBeginSelect(await rpc('SELECT', 'care_order_links_begin_select',
    { p_run_id: runId, p_max_tasks: maxTasks, p_max_age_minutes: maxAge })),
  runJob: async (runId, jobNo) => parseRunJob(await rpc('JOB', 'care_order_links_run_job', { p_run_id: runId, p_job_no: jobNo })),
  readJob: (job, maxRows) => readOrderLinksJob(careN3Table(), job, runN3Query, { maxRows, deadlineMs: CARE_ORDER_LINKS_QUERY_DEADLINE_MS }),
  async jobDone(runId, jobNo, total, dup, sha) {
    await rpc('JOB', 'care_order_links_job_done', { p_run_id: runId, p_job_no: jobNo, p_bq_total_rows: total, p_duplicates_dropped: dup, p_params_sha256: sha })
  },
  applyChunk: async (runId, jobNo, chunkNo, customerIds, orders) => parseChunk(await rpc('CHUNK', 'care_order_links_apply_chunk',
    { p_run_id: runId, p_job_no: jobNo, p_chunk_no: chunkNo, p_customer_ids: customerIds, p_orders: orders })),
  complete: async (runId) => parseComplete(await rpc('COMPLETE', 'care_order_links_complete', { p_run_id: runId })),
  async fail(runId, code) {
    const r = await rpc('COMPLETE', 'care_order_links_fail', { p_run_id: runId, p_code: code }) as { status?: unknown } | null
    return r?.status === 'failed'
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
}

export function runCareOrderLinksSync(opts: CareOrderLinksRunOptions): Promise<CareOrderLinksRunResult> {
  return runCareOrderLinks(realDeps, opts)
}

/** Dọn metadata trial (route trial ?action=cleanup). */
export async function cleanupCareOrderLinksTrial(): Promise<{ deletedRuns: number; remainingTrialRuns: number }> {
  const r = await rpc('COMPLETE', 'care_order_links_trial_cleanup', {}) as { deleted_runs?: unknown; remaining_trial_runs?: unknown } | null
  if (typeof r?.deleted_runs !== 'number' || typeof r?.remaining_trial_runs !== 'number') throw new Error('care_order_links_result_malformed')
  return { deletedRuns: r.deleted_runs, remainingTrialRuns: r.remaining_trial_runs }
}

/** Một dòng log an toàn (chỉ số đếm / mã) cho Coolify. */
export function careOrderLinksLogLine(tag: string, r: CareOrderLinksRunResult): string {
  return `[${tag}] ok=${r.ok} status=${r.status} code=${r.code ?? '-'} kind=${r.kind} mode=${r.mode} period=${r.periodMonth ?? '-'}`
    + ` tasks=${r.tasks ?? '-'} jobs=${r.jobs} chunks=${r.chunks} rows=${r.rows} dup=${r.duplicatesDropped} ins=${r.linksInserted}`
    + ` upd=${r.linksUpdated} relink_refused=${r.relinkRefused} busy=${r.busyRetries} age=${r.maxAgeMinutes ?? '-'}`
    + ` bytes=${r.bytesProcessed ?? '-'} ms=${r.elapsedMs}`
}
