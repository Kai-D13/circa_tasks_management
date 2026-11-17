import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { cmsCalcFlags } from '@/lib/cms/flags'
import { cmsBqContractMaxBytes, cmsBqSalesTable } from '@/lib/cms/config'
import { cmsBqRunner } from '@/lib/cms/source/bigqueryRunner'
import { createCmsBqContractProvider } from '@/lib/cms/source/contractSource'
import { computeCmsRevisionImpact } from '@/lib/cms/revision/impact'
import { cmsRevisionRpcErrorFrom, type CmsRevisionDeps } from '@/lib/cms/revision/handler'
import { cmsLoadPublished, type CmsPublishedReader } from '@/lib/cms/revision/published'
import { getCmsAdminAccess } from './access'
import { cmsImportDeps } from './importDeps'
import { cmsRevisionEnabled } from './revisionCaps'

// F-A — deps THẬT cho route sửa chương trình: cờ + năng lực 131, quyền super từ session, kiểm file của import, dự toán tác động
// (snapshot chỉ đọc + số đang công bố bằng service role SAU khi lõi route đã kiểm super; nguồn BigQuery SA chỉ đọc như worker), RPC
// preview / commit bằng SESSION người gọi (DB kiểm auth.uid() / is_super_admin(); không truyền actor). Lỗi RPC chỉ mang mã CMS_*.

const TIMEOUT_MS = 30_000
/** Hạn đọc nguồn cho dự toán (< giới hạn proxy ~100 s; worker cron dùng ngân sách riêng). */
const IMPACT_SOURCE_DEADLINE_MS = 75_000
const rpcErr = cmsRevisionRpcErrorFrom

/** r3 (P1-03): reader service role cho cmsLoadPublished — chỉ I/O; mọi kiểm (header / thứ tự / số dòng / Σ / purge) ở lõi thuần. */
export const cmsPublishedReader: CmsPublishedReader = {
  header: async (runId) => {
    const { data, error } = await supabaseAdmin.from('cms_sync_runs')
      .select('id, program_id, kind, status, published_at, purged_at, amount_vnd::text, config_version, results_expected:seal_expect->>results')
      .eq('id', runId).abortSignal(AbortSignal.timeout(TIMEOUT_MS)).maybeSingle()
    if (error) throw new Error('READ_FAILED')
    return data
  },
  page: async (runId, from, to) => {
    const { data, error } = await supabaseAdmin.from('cms_results').select('user_id, program_product_id, amount_vnd::text')
      .eq('run_id', runId).order('user_id').order('program_product_id').range(from, to)
      .abortSignal(AbortSignal.timeout(TIMEOUT_MS))
    if (error) throw new Error('READ_FAILED')
    return (data ?? []) as unknown[]
  },
}

export function cmsRevisionDeps(env: Record<string, string | undefined> = process.env): CmsRevisionDeps {
  const table = cmsBqSalesTable(env)
  return {
    enabled: cmsRevisionEnabled,
    getAccess: getCmsAdminAccess,
    importDeps: cmsImportDeps(),
    impact: (programId, desired) => computeCmsRevisionImpact({
      table,
      runner: cmsBqRunner,
      // Dự toán chỉ đọc sales_only (net bị chặn ở DB / impact) ⇒ không cần view trả.
      contractProvider: createCmsBqContractProvider({ runner: cmsBqRunner, salesTable: table, returnsTable: null, maxBytesBilled: cmsBqContractMaxBytes(env) }),
      loadSnapshot: async (id) => {
        const { data, error } = await supabaseAdmin.rpc('rpc_cms_sales_snapshot', { p_program_id: id }).abortSignal(AbortSignal.timeout(TIMEOUT_MS))
        if (error) throw new Error('SNAPSHOT_FAILED')
        return data
      },
      loadPublished: (programId, runId) => cmsLoadPublished(cmsPublishedReader, programId, runId),
      calcModes: cmsCalcFlags().modes,
      deadlineMs: IMPACT_SOURCE_DEADLINE_MS,
      now: () => new Date(),
    }, programId, desired),
    rpcPreview: async (p) => {
      const supabase = await createClient()
      const { data, error } = await supabase.rpc('rpc_cms_program_revision_preview', { p }).abortSignal(AbortSignal.timeout(TIMEOUT_MS))
      if (error) throw rpcErr(error)
      return data
    },
    loadNames: async (ids) => {
      const out: Record<string, string> = {}
      const uniq = [...new Set(ids)]
      for (let i = 0; i < uniq.length; i += 200) {
        const { data, error } = await supabaseAdmin.from('users').select('id, full_name').in('id', uniq.slice(i, i + 200))
          .abortSignal(AbortSignal.timeout(TIMEOUT_MS))
        if (error) return {}
        for (const u of (data ?? []) as { id: string; full_name: string | null }[]) if (u.full_name) out[u.id] = u.full_name
      }
      return out
    },
    rpcCommit: async (a) => {
      const supabase = await createClient()
      const { data, error } = await supabase.rpc('rpc_cms_program_revision_commit', {
        p_revision_id: a.revisionId, p_expected_config_version: a.expectedConfigVersion, p_payload_digest: a.payloadDigest,
        p_idempotency_key: a.idempotencyKey, p_reason: a.reason, p_ack: a.ack,
      }).abortSignal(AbortSignal.timeout(TIMEOUT_MS))
      if (error) throw rpcErr(error)
      return data
    },
    now: () => new Date(),
  }
}
