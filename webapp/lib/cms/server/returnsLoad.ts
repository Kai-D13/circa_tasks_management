import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { supabaseCmsImportRepo } from '@/lib/cms/server/importRepo'
import { getCmsAdminAccess } from '@/lib/cms/server/access'
import { cmsCalcFlags, cmsReturnsPagesFromEnv, isCmsQaServer } from '@/lib/cms/flags'
import { cmsQueryFailLine, CmsQueryError } from '@/lib/cms/queryLog'
import type { CmsConfirmRestoredDeps } from '@/lib/cms/returnsConflictAction'
import {
  parseCmsCloseReportPage, parseCmsCloseReports, parseCmsReturnConflicts,
  type CmsCloseReportPage, type CmsCloseReportSummary, type CmsReturnConflictsDto,
} from '@/lib/cms/returnsView'

// CMS-CALC-RET-2 P5.5 — đọc đối soát trả hàng + báo cáo sau chốt bằng SESSION client (RPC 130 authenticated tự kiểm super + chương trình
// đọc được + marker QA). Không service role. Lỗi ⇒ { ok:false } (UI hiện lỗi, không danh sách rỗng giả); log chỉ mã cố định.

export type CmsReturnsRead<T> = { ok: true; data: T } | { ok: false; error: 'FORBIDDEN' | 'QUERY_FAILED' }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

async function call<T>(tag: string, fn: string, args: Record<string, unknown>, parse: (x: unknown) => T): Promise<CmsReturnsRead<T>> {
  try {
    const supabase = await createClient()
    const { data, error } = await supabase.rpc(fn, args)
    if (error) {
      if (/\bCMS_RESULT_FORBIDDEN\b/.test(String(error.message ?? '')) || error.code === '42501') return { ok: false, error: 'FORBIDDEN' }
      throw new CmsQueryError(error.code)
    }
    return { ok: true, data: parse(data) }
  } catch (e) {
    console.error(cmsQueryFailLine(tag, e))
    return { ok: false, error: 'QUERY_FAILED' }
  }
}

export function cmsLoadReturnConflicts(programId: string): Promise<CmsReturnsRead<CmsReturnConflictsDto>> {
  if (!UUID_RE.test(programId)) return Promise.resolve({ ok: false, error: 'QUERY_FAILED' })
  return call('cms-return-conflicts', 'rpc_cms_return_conflicts', { p_program_id: programId }, parseCmsReturnConflicts)
}

export function cmsLoadCloseReports(programId: string): Promise<CmsReturnsRead<CmsCloseReportSummary[]>> {
  if (!UUID_RE.test(programId)) return Promise.resolve({ ok: false, error: 'QUERY_FAILED' })
  return call('cms-close-reports', 'rpc_cms_return_close_reports', { p_program_id: programId }, (x) => {
    const r = parseCmsCloseReports(x)
    if (r.programId !== programId) throw new CmsQueryError('PROGRAM_MISMATCH')
    return r.reports
  })
}

/** Đọc ĐỦ mọi trang dòng của một báo cáo (≤ maxLines; vượt ⇒ lỗi, không hiện thiếu). */
export async function cmsLoadCloseReport(reportId: string, maxLines = 50_000): Promise<CmsReturnsRead<CmsCloseReportPage>> {
  if (!UUID_RE.test(reportId)) return { ok: false, error: 'QUERY_FAILED' }
  const pages: CmsCloseReportPage[] = []
  let after: number | null = null
  let total = 0
  for (;;) {
    const r: CmsReturnsRead<CmsCloseReportPage> = await call('cms-close-report', 'rpc_cms_return_close_report',
      { p_report_id: reportId, p_after: after, p_limit: 1000 }, parseCmsCloseReportPage)
    if (!r.ok) return r
    if (pages.length && r.data.report.id !== pages[0].report.id) return { ok: false, error: 'QUERY_FAILED' }
    pages.push(r.data)
    total += r.data.lines.length
    if (total > maxLines) return { ok: false, error: 'QUERY_FAILED' }
    if (r.data.nextAfter === null) break
    after = r.data.nextAfter
  }
  const head = pages[0]
  const lines = pages.flatMap((p) => p.lines)
  // Đối chiếu đủ dòng với header (DB khai line_count) — lệch ⇒ lỗi, không hiện thiếu.
  if (lines.length !== head.report.lineCount) {
    console.error('[cms-close-report] LINE_COUNT_MISMATCH')
    return { ok: false, error: 'QUERY_FAILED' }
  }
  return { ok: true, data: { report: head.report, lines, nextAfter: null } }
}

/** Trang / link / XLSX trả hàng chỉ mở khi CMS_RETURNS_ENABLED (cùng program + earnings) — PM 14/11 CMS bán hàng phát hành trước. */
export const cmsReturnsPageEnabled = () => cmsReturnsPagesFromEnv(process.env)

export const cmsConfirmRestoredDeps: CmsConfirmRestoredDeps = {
  enabled: () => cmsCalcFlags().returns,
  qaReadonly: isCmsQaServer,
  access: getCmsAdminAccess,
  program: async (id) => {
    const p = await supabaseCmsImportRepo.getProgram(id)
    return p ? { isTest: p.isTest } : null
  },
  rpc: async (fn, args) => {
    const supabase = await createClient()
    const { data, error } = await supabase.rpc(fn, args)
    return { data, error: error ? { code: error.code, message: error.message } : null }
  },
}
