import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { cmsBqSalesTable } from '@/lib/cms/config'
import { cmsBqRunner } from '@/lib/cms/source/bigqueryRunner'
import type { CmsSalesCronDeps } from '@/lib/cms/cronSales'
import type { CmsIo } from '@/lib/cms/salesSync'

// Deps THẬT cho lõi đồng bộ bán CMS (lib/cms/salesSync.ts): view nguồn từ env (validate), runner BigQuery SA readonly,
// RPC service_role của migration 122. Mỗi RPC dùng timeout do lõi tính từ ngân sách còn lại (≤ 60 s) — lõi điều phối seal
// từng bước / cleanup từng lô. Lỗi RPC chỉ trả MÃ CMS_* (không message thô PostgREST / Postgres).
// Dùng chung cho cron (route) và script operator (scripts/cms-sales-sync.mjs nạp qua jiti).

function rpcError(error: { message?: string } | null, fallback: string): Error {
  const m = /\bCMS_[A-Z0-9_]+\b/.exec(String(error?.message ?? ''))
  return new Error(m ? m[0] : fallback)
}

async function rpc<T>(fn: string, args: Record<string, unknown>, io: CmsIo, fallback: string): Promise<T> {
  const { data, error } = await supabaseAdmin.rpc(fn, args).abortSignal(AbortSignal.timeout(io.timeoutMs))
  if (error) throw rpcError(error, fallback)
  return data as T
}

export function cmsSalesSyncDeps(env: Record<string, string | undefined> = process.env): CmsSalesCronDeps {
  return {
    table: cmsBqSalesTable(env),
    runner: cmsBqRunner,
    loadSnapshot: (programId, io) => rpc('rpc_cms_sales_snapshot', { p_program_id: programId }, io, 'SNAPSHOT_FAILED'),
    openRun: (programId, detail, io) => rpc('rpc_cms_sales_run_open', { p_program_id: programId, p_detail: detail }, io, 'OPEN_FAILED'),
    stage: async (runId, part, chunkNo, rows, io) => Number(await rpc('rpc_cms_sales_run_stage',
      { p_run_id: runId, p_part: part, p_chunk_no: chunkNo, p_rows: rows }, io, 'STAGE_FAILED')),
    sealBegin: (runId, expect, io) => rpc('rpc_cms_sales_run_seal_begin', { p_run_id: runId, p_expect: expect }, io, 'SEAL_FAILED'),
    sealStep: (runId, step, io) => rpc('rpc_cms_sales_run_seal_step', { p_run_id: runId, p_step: step }, io, 'SEAL_FAILED'),
    publish: (runId, io) => rpc('rpc_cms_sales_run_publish', { p_run_id: runId }, io, 'PUBLISH_FAILED'),
    finish: async (runId, status, detail, io) => {
      await rpc('rpc_cms_sales_run_finish', { p_run_id: runId, p_status: status, p_detail: detail }, io, 'CLOSE_FAILED')
    },
    cleanup: (programId, maxRows, io) => rpc('rpc_cms_sales_run_cleanup', { p_program_id: programId, p_max_rows: maxRows }, io, 'CLEANUP_FAILED'),
    listDuePrograms: async (todayVn, io) => {
      const signal = () => AbortSignal.timeout(io.timeoutMs)
      const { data, error } = await supabaseAdmin.from('cms_programs')
        .select('id, current_result_run_id')
        .eq('status', 'active').eq('is_test', false).lte('start_date', todayVn)
        .abortSignal(signal())
      if (error) throw new Error('LIST_FAILED')
      const rows = (data ?? []) as Array<{ id: string; current_result_run_id: string | null }>
      const runIds = rows.map((r) => r.current_result_run_id).filter((x): x is string => !!x)
      const published = new Map<string, string>()
      if (runIds.length) {
        const r = await supabaseAdmin.from('cms_sync_runs').select('id, published_at').in('id', runIds).abortSignal(signal())
        if (r.error) throw new Error('LIST_FAILED')
        for (const x of (r.data ?? []) as Array<{ id: string; published_at: string | null }>) if (x.published_at) published.set(x.id, x.published_at)
      }
      return rows.map((r) => ({ id: r.id, lastPublishedAt: r.current_result_run_id ? published.get(r.current_result_run_id) ?? null : null }))
    },
    now: () => Date.now(),
  }
}
