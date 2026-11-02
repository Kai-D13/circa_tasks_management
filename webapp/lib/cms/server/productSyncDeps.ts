import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { cmsBqProductsTable } from '@/lib/cms/config'
import { cmsBqRunner } from '@/lib/cms/source/bigqueryRunner'
import type { CmsProductSyncDeps } from '@/lib/cms/productSync'

// Deps THẬT cho lõi đồng bộ Product Master: view nguồn từ env (validate), runner BigQuery SA readonly,
// 3 RPC service_role của migration 120. Lỗi RPC chỉ trả MÃ (không message thô PostgREST).
// Dùng chung cho cron (route) và script operator (scripts/cms-bootstrap-products.mjs nạp qua jiti).

const RPC_TIMEOUT_MS = 30_000

export function cmsProductSyncDeps(env: Record<string, string | undefined> = process.env): CmsProductSyncDeps {
  return {
    table: cmsBqProductsTable(env),
    runner: cmsBqRunner,
    countCached: async () => {
      const { count, error } = await supabaseAdmin.from('cms_product_master')
        .select('product_id', { count: 'exact', head: true }).abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS))
      if (error) throw new Error('COUNT_FAILED')
      return count ?? 0
    },
    openRun: async (detail) => {
      const { data, error } = await supabaseAdmin.rpc('rpc_cms_sync_run_open', { p_kind: 'products', p_detail: detail })
        .abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS))
      if (error) throw new Error(String(error.message ?? '').includes('CMS_SYNC_BUSY') ? 'CMS_SYNC_BUSY' : 'OPEN_FAILED')
      if (typeof data !== 'string') throw new Error('OPEN_FAILED')
      return data
    },
    upsert: async (runId, rows) => {
      const { data, error } = await supabaseAdmin.rpc('rpc_cms_product_master_upsert', { p_run_id: runId, p_rows: rows })
        .abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS))
      if (error) throw new Error('UPSERT_FAILED')
      return Number(data)
    },
    closeRun: async (runId, status, detail) => {
      const { error } = await supabaseAdmin.rpc('rpc_cms_sync_run_close', { p_run_id: runId, p_status: status, p_detail: detail })
        .abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS))
      if (error) throw new Error('CLOSE_FAILED')
    },
    now: () => Date.now(),
  }
}
