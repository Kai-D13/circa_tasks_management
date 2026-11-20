import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { cmsBqContractMaxBytes, cmsBqReturnsTable, cmsBqSalesTable } from '@/lib/cms/config'
import { createCmsBqContractProvider } from '@/lib/cms/source/contractSource'
import { cmsBqRunner } from '@/lib/cms/source/bigqueryRunner'
import { createClient } from '@/lib/supabase/server'
import { cmsCalcFlags, isCmsQaServer } from '@/lib/cms/flags'
import { getCmsAdminAccess } from './access'
import {
  CMS_AFTER_CLOSE_WINDOW_DAYS, cmsAfterCloseProfile, cmsAfterCloseRefs, cmsAfterCloseRpcCode, cmsAfterCloseWindow, type CmsAfterCloseDeps,
  type CmsAfterClosePayoutRun, type CmsAfterCloseProgram, type CmsManualReportDeps,
} from '@/lib/cms/returnsAfterClose'
import type { CmsReturnProfile } from '@/lib/cms/calc/policy'
import { getCmsCapabilityState } from './capabilities'

// CMS-CALC-RET-2 P5.5 / Q-233 / Q-236 r1 — deps THẬT của job báo cáo trả sau chốt (lib/cms/returnsAfterClose.ts):
//  · danh sách chương trình locked THẬT (is_test = false) có D+1 ≤ hôm nay (VN) ≤ D+N (Q-233: N mặc định 30, env; đồng hồ ghim lúc dựng
//    deps) — D+N+1 trở đi job không tự chọn; super lập tay qua server action có PHIÊN (cmsManualCloseReportDeps);
//  · SP = SP HIỆU LỰC (retired_at IS NULL — PM r0 P1-01): chương trình đã chốt có config đóng băng ⇒ đúng tập SP của run chốt; SP đã
//    retire không vào phạm vi ⇒ phiếu trên SP đó là ORIGIN_NOT_IN_PROGRAM, không HOLD ORIGIN_MISSING;
//  · run chốt + profile đã ghim qua rpc_cms_frozen_sales_lines (limit 1; DB tự suy mọi số ở report_save, kể cả run contract);
//  · provider BQ contract hiện có (MỘT job bán + trả, ghim as_of); view trả chưa cấu hình ⇒ SOURCE_NOT_CONFIGURED (held, không ghi);
//  · lưu: cron = service_role rpc_cms_return_close_report_save (created_via cron); thủ công = SESSION rpc_cms_return_close_report_save_super
//    (actor = auth.uid(), is_super_admin(), lý do + khoá yêu cầu). Lỗi RPC chỉ trả MÃ CMS_* (không message thô).
//  · capability: đường close_report; profile full_line cần thêm đường full_line; lập tay cần manual_report (DB 132) — thiếu ⇒
//    CAPS_UNAVAILABLE, không đọc nguồn.

const BUDGET_MS = 240_000

const rpcCode = cmsAfterCloseRpcCode
const PRODUCT_PAGE = 1000

export function cmsAfterCloseMaxAgeDays(env: Record<string, string | undefined>): number {
  const v = env.CMS_RETURNS_AFTER_CLOSE_MAX_AGE_DAYS
  if (v === undefined || v === '') return CMS_AFTER_CLOSE_WINDOW_DAYS
  if (!/^[1-9][0-9]{0,2}$/.test(v)) throw new Error('CONFIG_INVALID')
  return Number(v)
}

/**
 * Run chốt + lựa chọn profile đã ghim (rpc_cms_frozen_sales_lines limit 1 — service_role; caller đã kiểm quyền ở app). Giá trị lạ ⇒
 * PAYOUT_READ_FAILED (fail-closed).
 */
export async function cmsReadPayoutRun(programId: string, signal?: AbortSignal)
  : Promise<({ ok: true } & CmsAfterClosePayoutRun) | { ok: false; code: string }> {
  const q = supabaseAdmin.rpc('rpc_cms_frozen_sales_lines', { p_program_id: programId, p_after_seq: null, p_limit: 1 })
  const { data, error } = await (signal ? q.abortSignal(signal) : q)
  if (error) return { ok: false, code: rpcCode(error, 'PAYOUT_READ_FAILED') }
  const o = data as { payout_run_id?: unknown; report_profile?: unknown; contract?: { legacy?: unknown; returns_policy?: unknown } } | null
  if (!o || typeof o.payout_run_id !== 'string' || typeof o.contract?.legacy !== 'boolean') return { ok: false, code: 'PAYOUT_READ_FAILED' }
  const runPolicy = o.contract.returns_policy
  if (runPolicy !== 'sales_only_v1' && runPolicy !== 'net_returns_v1' && runPolicy !== 'full_line_qty_refund_v1') return { ok: false, code: 'PAYOUT_READ_FAILED' }
  // 132: profile báo cáo đã ghim (null = chưa có báo cáo). Giá trị lạ ⇒ lỗi đọc (fail-closed).
  const rp = o.report_profile ?? null
  if (rp !== null && rp !== 'net_returns_v1' && rp !== 'full_line_qty_refund_v1') return { ok: false, code: 'PAYOUT_READ_FAILED' }
  return { ok: true, runId: o.payout_run_id, legacy: o.contract.legacy, runPolicy, reportProfile: rp }
}

/** Trạng thái form lập tay (trang Trả hàng, super): run chốt để ghim + quy tắc đã ghim hay phải chọn. */
export type CmsManualReportState =
  | { ok: true; payoutRunId: string; choice: { kind: 'pinned'; profile: CmsReturnProfile } | { kind: 'choose' } }
  | { ok: false; code: string }
export async function cmsLoadManualReportState(programId: string): Promise<CmsManualReportState> {
  let pay: Awaited<ReturnType<typeof cmsReadPayoutRun>>
  try { pay = await cmsReadPayoutRun(programId, AbortSignal.timeout(10_000)) } catch { return { ok: false, code: 'PAYOUT_READ_FAILED' } }
  if (!pay.ok) return { ok: false, code: pay.code }
  const sel = cmsAfterCloseProfile(pay, null)
  if ('profile' in sel) return { ok: true, payoutRunId: pay.runId, choice: { kind: 'pinned', profile: sel.profile } }
  return sel.code === 'REPORT_POLICY_UNSELECTED' ? { ok: true, payoutRunId: pay.runId, choice: { kind: 'choose' } } : { ok: false, code: sel.code }
}

export function cmsReturnsAfterCloseDeps(env: Record<string, string | undefined> = process.env, started = Date.now())
  : CmsAfterCloseDeps & Pick<CmsManualReportDeps, 'manualProgram'> {
  const maxAge = cmsAfterCloseMaxAgeDays(env)
  const win = cmsAfterCloseWindow(started, maxAge)
  const salesTable = cmsBqSalesTable(env)
  const io = () => AbortSignal.timeout(Math.max(1000, Math.min(60_000, BUDGET_MS - (Date.now() - started))))
  /** SP HIỆU LỰC của chương trình — phân trang theo id (PostgREST prod trần 1.000 dòng / request — tiền lệ EXP-1; db-reviewer 14/11 P2-3). */
  const productIds = async (programId: string): Promise<string[]> => {
    const ids: string[] = []
    for (let from = 0; ; from += PRODUCT_PAGE) {
      const pp = await supabaseAdmin.from('cms_program_products').select('id, product_id').eq('program_id', programId).is('retired_at', null).order('id')
        .range(from, from + PRODUCT_PAGE - 1).abortSignal(io())
      if (pp.error) throw new Error('LIST_FAILED')
      const rows = (pp.data ?? []) as Array<{ id: string; product_id: string }>
      for (const r of rows) ids.push(r.product_id)
      if (rows.length < PRODUCT_PAGE) break
    }
    return ids
  }
  return {
    // Profile theo lựa chọn đã ghim của từng chương trình (returnsAfterClose.cmsAfterCloseProfile) — không hằng mặc định (PM r0 §3.1).
    capsOk: async (profile, manual) => {
      const s = await getCmsCapabilityState()
      return s.kind === 'ok' && s.caps.paths.close_report && (profile !== 'full_line_qty_refund_v1' || s.caps.paths.full_line)
        && (!manual || s.caps.paths.manual_report)
    },
    provider: salesTable
      ? createCmsBqContractProvider({ runner: cmsBqRunner, salesTable, returnsTable: cmsBqReturnsTable(env), maxBytesBilled: cmsBqContractMaxBytes(env) })
      : null,
    async listPrograms() {
      const { data, error } = await supabaseAdmin.from('cms_programs').select('id, start_date, end_date, is_test')
        .eq('status', 'locked').eq('is_test', false).gte('end_date', win.since).lt('end_date', win.today)
        .order('end_date', { ascending: false }).order('id').abortSignal(io())
      if (error) throw new Error('LIST_FAILED')
      const progs = (data ?? []) as Array<{ id: string; start_date: string; end_date: string; is_test: boolean }>
      if (progs.length === 0) return []
      const out: CmsAfterCloseProgram[] = []
      for (const p of progs) {
        out.push({ id: p.id, startDate: p.start_date, endDate: p.end_date, isTest: p.is_test, productIds: await productIds(p.id),
          ...(p.end_date === win.lastDay ? { lastDay: true } : {}) })
      }
      return out
    },
    async manualProgram(programId) {
      const { data, error } = await supabaseAdmin.from('cms_programs').select('id, start_date, end_date, is_test, status').eq('id', programId).abortSignal(io())
        .maybeSingle()
      if (error) return { ok: false, code: 'PROGRAM_READ_FAILED' }
      const p = data as { id: string; start_date: string; end_date: string; is_test: boolean; status: string } | null
      if (!p) return { ok: false, code: 'CMS_PROGRAM_NOT_FOUND' }
      if (p.status !== 'locked') return { ok: false, code: 'CMS_REPORT_NOT_LOCKED' }
      return { ok: true, program: { id: p.id, startDate: p.start_date, endDate: p.end_date, isTest: p.is_test, productIds: await productIds(p.id) } }
    },
    payoutRun: (programId) => cmsReadPayoutRun(programId, io()),
    async save(programId, payoutRunId, payload, manual) {
      // Thủ công: SESSION client — DB lấy actor = auth.uid() + kiểm is_super_admin(), lưu lý do / khoá yêu cầu (PM r0 P1-04). Cron: service_role.
      const { data, error } = manual
        ? await (await createClient()).rpc('rpc_cms_return_close_report_save_super', { p_program_id: programId, p_payout_run_id: payoutRunId,
          p_payload: payload, p_reason: manual.reason, p_request: manual.request }).abortSignal(io())
        : await supabaseAdmin.rpc('rpc_cms_return_close_report_save', { p_program_id: programId, p_payout_run_id: payoutRunId, p_payload: payload })
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

/** Deps action thủ công ngày 31 (phiên super) — cùng deps job; lưu bằng SESSION client. */
export function cmsManualCloseReportDeps(env: Record<string, string | undefined> = process.env): CmsManualReportDeps {
  let deps: ReturnType<typeof cmsReturnsAfterCloseDeps> | null = null
  const d = () => (deps ??= cmsReturnsAfterCloseDeps(env))
  return {
    enabled: () => cmsCalcFlags().returns,
    qaReadonly: isCmsQaServer,
    access: getCmsAdminAccess,
    manualProgram: (id) => d().manualProgram(id),
    job: () => d(),
  }
}
