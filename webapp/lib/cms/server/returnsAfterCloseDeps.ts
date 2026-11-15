import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { cmsBqContractMaxBytes, cmsBqReturnsTable, cmsBqSalesTable } from '@/lib/cms/config'
import { createCmsBqContractProvider } from '@/lib/cms/source/contractSource'
import { cmsBqRunner } from '@/lib/cms/source/bigqueryRunner'
import { cmsAfterCloseRefs, cmsAfterCloseRpcCode, type CmsAfterCloseDeps, type CmsAfterCloseProgram } from '@/lib/cms/returnsAfterClose'
import { getCmsCapabilityState } from './capabilities'

// CMS-CALC-RET-2 P5.5 — deps THẬT của job báo cáo trả sau chốt (lib/cms/returnsAfterClose.ts). service_role:
//  · danh sách chương trình locked THẬT (is_test = false) kết thúc trong cửa sổ ngày (env, mặc định 45) — cũ hơn không đọc nguồn nữa;
//  · run chốt qua rpc_cms_frozen_sales_lines (limit 1 — chỉ để biết run + hợp đồng; DB tự suy mọi số ở report_save);
//  · provider BQ contract hiện có (MỘT job bán + trả, ghim as_of); view trả chưa cấu hình ⇒ SOURCE_NOT_CONFIGURED (held, không ghi);
//  · rpc_cms_return_close_report_save. Lỗi RPC chỉ trả MÃ CMS_* (không message thô).
// TODO(câu hỏi mở P5.5 — cửa sổ ngày sau kết thúc kỳ còn chạy báo cáo; mặc định Dev 45 ngày, đổi qua env, chờ PM / stakeholder).

const DAY_MS = 86_400_000
const BUDGET_MS = 240_000

const rpcCode = cmsAfterCloseRpcCode
const PRODUCT_PAGE = 1000

export function cmsAfterCloseMaxAgeDays(env: Record<string, string | undefined>): number {
  const v = env.CMS_RETURNS_AFTER_CLOSE_MAX_AGE_DAYS
  if (v === undefined || v === '') return 45
  if (!/^[1-9][0-9]{0,2}$/.test(v)) throw new Error('CONFIG_INVALID')
  return Number(v)
}

export function cmsReturnsAfterCloseDeps(env: Record<string, string | undefined> = process.env, started = Date.now()): CmsAfterCloseDeps {
  const maxAge = cmsAfterCloseMaxAgeDays(env)
  const salesTable = cmsBqSalesTable(env)
  const io = () => AbortSignal.timeout(Math.max(1000, Math.min(60_000, BUDGET_MS - (Date.now() - started))))
  return {
    capsOk: async () => { const s = await getCmsCapabilityState(); return s.kind === 'ok' && s.caps.paths.close_report },
    provider: salesTable
      ? createCmsBqContractProvider({ runner: cmsBqRunner, salesTable, returnsTable: cmsBqReturnsTable(env), maxBytesBilled: cmsBqContractMaxBytes(env) })
      : null,
    async listPrograms() {
      const since = new Date(Date.now() + 7 * 3600_000 - maxAge * DAY_MS).toISOString().slice(0, 10)
      const { data, error } = await supabaseAdmin.from('cms_programs').select('id, start_date, end_date, is_test')
        .eq('status', 'locked').eq('is_test', false).gte('end_date', since).order('end_date', { ascending: false }).order('id').abortSignal(io())
      if (error) throw new Error('LIST_FAILED')
      const progs = (data ?? []) as Array<{ id: string; start_date: string; end_date: string; is_test: boolean }>
      if (progs.length === 0) return []
      // Theo TỪNG chương trình + phân trang theo id (PostgREST prod trần 1.000 dòng / request — tiền lệ EXP-1; db-reviewer 14/11 P2-3).
      const byProg = new Map<string, string[]>()
      for (const p of progs) {
        const ids: string[] = []
        for (let from = 0; ; from += PRODUCT_PAGE) {
          const pp = await supabaseAdmin.from('cms_program_products').select('id, product_id').eq('program_id', p.id).order('id')
            .range(from, from + PRODUCT_PAGE - 1).abortSignal(io())
          if (pp.error) throw new Error('LIST_FAILED')
          const rows = (pp.data ?? []) as Array<{ id: string; product_id: string }>
          for (const r of rows) ids.push(r.product_id)
          if (rows.length < PRODUCT_PAGE) break
        }
        byProg.set(p.id, ids)
      }
      return progs.map((p): CmsAfterCloseProgram => ({ id: p.id, startDate: p.start_date, endDate: p.end_date, isTest: p.is_test, productIds: byProg.get(p.id) ?? [] }))
    },
    async payoutRun(programId) {
      const { data, error } = await supabaseAdmin.rpc('rpc_cms_frozen_sales_lines', { p_program_id: programId, p_after_seq: null, p_limit: 1 }).abortSignal(io())
      if (error) return { ok: false, code: rpcCode(error, 'PAYOUT_READ_FAILED') }
      const o = data as { payout_run_id?: unknown; contract?: { legacy?: unknown } } | null
      if (!o || typeof o.payout_run_id !== 'string' || typeof o.contract?.legacy !== 'boolean') return { ok: false, code: 'PAYOUT_READ_FAILED' }
      return { ok: true, runId: o.payout_run_id, legacy: o.contract.legacy }
    },
    async save(programId, payoutRunId, payload) {
      const { data, error } = await supabaseAdmin.rpc('rpc_cms_return_close_report_save', { p_program_id: programId, p_payout_run_id: payoutRunId, p_payload: payload })
        .abortSignal(io())
      if (error) {
        const refs = cmsAfterCloseRefs((error as { details?: unknown }).details)
        return { ok: false, code: rpcCode(error, 'SAVE_FAILED'), ...(refs.length ? { refs } : {}) }
      }
      return { ok: true, data }
    },
    nowMicros: () => BigInt(Date.now()) * BigInt(1000),
    remainingMs: () => BUDGET_MS - (Date.now() - started),
  }
}
