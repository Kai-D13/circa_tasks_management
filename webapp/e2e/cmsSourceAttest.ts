// CMS 124 (COMP-INT §5.B) — công cụ CHỨNG NHẬN ĐỐI SOÁT NGUỒN. Phần THUẦN — không IO / mạng / secret; script
// scripts/cms-source-attest.mjs (export-run / attest / revoke / status / reconcile) nạp qua jiti; close của launcher QA
// (scripts/cms-qa-run.mjs) dùng cmsQaAttestCloseCheck. Test: e2e/cms-comp-int-unit.spec.ts + scripts/qa-cms-124.mjs (RPC thật PGlite).
//
// Nguyên tắc (PM 2026-11-05-cms-comp-draft-pm.md §5.B):
//  · CHỈ phiên authenticated super ghi (access token của phiên super hiện có, biến PROCESS CMS_SUPER_ACCESS_TOKEN — không đọc từ
//    .env.local, không truyền trên dòng lệnh, không lưu vào sổ / report / file). Không service_role, không actor trong payload.
//  · Export = SNAPSHOT lớp nguồn đã lưu (không phải chứng nhận): đọc đủ trang, run ghim, keyset theo byte tăng nghiêm ngặt, đếm =
//    total trang đầu; file chỉ hoàn tất khi đủ (ghi .partial rồi đổi tên).
//  · Attest: TÍNH LẠI compare-source từ ĐÚNG hai file + metadata (hash byte từ cùng buffer) — không nhận một JSON "MATCH" tự khai.
//    Bằng chứng = decision10 (PM COMP-P1-1): reference_rows_fp = run_rows_fp = decision10 của file run; DB tính lại từ lớp nguồn.
//  · Mặc định dry-run; ghi cần --write + --idem (do operator cấp, không tự sinh) + --expect-host đúng. Ý ĐỊNH vào sổ TRƯỚC request;
//    mất phản hồi ⇒ "chưa xác định" — reconcile đọc DB theo ĐÚNG khoá idem; gọi lại chỉ bằng CÙNG khoá + cùng payload.
//  · Run QA: thao tác chương trình is_test chỉ BÊN TRONG run QA đang mở (manifest / launcher / host / marker / sổ của run); close
//    đối chiếu mọi chứng nhận / thu hồi trong cửa sổ run với sổ (ngoài sổ ⇒ ĐỎ; còn intent / unknown ⇒ ĐỎ).

import { createHash } from 'node:crypto'
import { toCareCsv } from '../lib/care/import/csvCore'
import { cmsNormalizeAck } from '../lib/cms/payoutView'
import { CMS_SALES_COLUMNS, type CmsRawRow } from '../lib/cms/source/contract'
import { cmsI4ScopeHash, CMS_I4_COMPARE_VERSION, CMS_I4_ROWS_FP_VERSION, type CmsI4CompareResult, type CmsI4EvidenceMeta } from './cmsI4CompareSource'
import type { CmsI4Context } from './cmsI4Offline'
import {
  cmsQaAgeStatusRows, cmsQaIoTimeoutMs, cmsQaLockLocalCheck, cmsQaWriterDbCheck, cmsQaWriterProgramSql, type CmsQaWriterProgramRow,
} from './cmsQaResults'
import { CMS_QA_GUARD_MINUTES_MIN, cmsQaStatusSql, type CmsQaRunManifest, type CmsQaStatusRow } from './cmsQaTooling'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/
const HEX64 = /^[0-9a-f]{64}$/
const RUN_ID_RE = /^cms-qa-[0-9A-Za-z]{8,20}-[0-9a-f]{4}$/
const mask = (id: string | null | undefined) => (id && UUID_RE.test(id) ? `${id.slice(0, 8)}…` : '—')

/** Biến PROCESS chứa access token phiên super (không đọc từ .env.local). */
export const CMS_ATTEST_TOKEN_ENV = 'CMS_SUPER_ACCESS_TOKEN'
/** Trang export tối đa (RPC 124 nhận 1…5.000). */
export const CMS_ATTEST_PAGE_LIMIT = 5000
export const CMS_ATTEST_OP_ID_RE = /^a-[0-9a-f]{12}$/
/** Timeout một request ghi (client) — statement_timeout của role PostgREST (8 s) ngắn hơn ⇒ hết hạn này DB đã kết thúc câu lệnh. */
export const CMS_ATTEST_RPC_TIMEOUT_MS = 30_000
/** Reconcile chỉ kết luận "chưa ghi" khi đã qua thời gian lắng kể từ ý định (request có thể còn xếp hàng ở gateway). */
export const CMS_ATTEST_SETTLE_MS = 60_000
/** Mã duy nhất in ra khi lỗi ngoài dự kiến tới entrypoint CLI (PM COMPINT-P1-3) — không message / stack / cause / đường dẫn / giá trị. */
export const CMS_ATTEST_INTERNAL = 'CMS_ATTEST_INTERNAL'

export type CmsAttestResult<T> = { ok: true; value: T } | { ok: false; code: string; reason: string }
const fail = (code: string, reason: string) => ({ ok: false as const, code, reason })

// ── Token phiên super ────────────────────────────────────────────────────────

/** Đọc claim (KHÔNG xác minh chữ ký — PostgREST xác minh; đây chỉ để chặn sớm token hết hạn / sai vai và lấy uid cho guard QA). */
export function cmsAttestTokenClaims(token: string | undefined, nowMs: number): CmsAttestResult<{ sub: string; exp: number }> {
  if (!token) return fail('TOKEN_MISSING', `thiếu ${CMS_ATTEST_TOKEN_ENV} (biến PROCESS chứa access token phiên super — không đặt trong .env.local)`)
  const parts = token.split('.')
  if (parts.length !== 3) return fail('TOKEN_INVALID', 'access token không phải JWT')
  let o: Record<string, unknown>
  try {
    o = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
  } catch { return fail('TOKEN_INVALID', 'access token không đọc được') }
  if (o.role !== 'authenticated' || typeof o.sub !== 'string' || !UUID_RE.test(o.sub)) return fail('TOKEN_INVALID', 'access token không phải phiên authenticated của tài khoản')
  if (typeof o.exp !== 'number' || !Number.isFinite(o.exp)) return fail('TOKEN_INVALID', 'access token thiếu hạn')
  if (o.exp * 1000 <= nowMs + 60_000) return fail('TOKEN_EXPIRED', 'access token hết hạn / còn dưới 60 s — đăng nhập lại lấy phiên mới')
  return { ok: true, value: { sub: o.sub, exp: o.exp } }
}

// ── Phân loại phản hồi RPC (PostgREST) ──────────────────────────────────────

export type CmsAttestRpcOutcome = { kind: 'ok'; data: unknown } | { kind: 'rejected'; code: string } | { kind: 'unknown'; code: string }

/**
 * Phản hồi RPC ghi ⇒ ok / từ chối XÁC ĐỊNH (transaction đã rollback hoặc chưa chạy) / KHÔNG RÕ (có thể đã commit).
 * CMS_* ⇒ đúng mã · 55P03 lock_timeout ⇒ BUSY (rollback) · 42501 ⇒ FORBIDDEN · PGRST1xx–3xx (request / schema / JWT — trước khi chạy
 * hàm) ⇒ từ chối · 57014 / 57P / 08 / PGRST0xx / 5xx không mã / lỗi mạng ⇒ không rõ · SQLSTATE khác ⇒ QUERY_FAILED (từ chối).
 */
export function cmsAttestRpcOutcome(r: { transportError: boolean; status: number | null; body: unknown }): CmsAttestRpcOutcome {
  if (r.transportError || r.status === null) return { kind: 'unknown', code: 'TRANSPORT' }
  if (r.status >= 200 && r.status < 300) return { kind: 'ok', data: r.body }
  const b = (typeof r.body === 'object' && r.body !== null ? r.body : {}) as Record<string, unknown>
  const m = /\bCMS_[A-Z0-9_]+\b/.exec(String(b.message ?? ''))
  if (m) return { kind: 'rejected', code: m[0] }
  const c = String(b.code ?? '')
  if (c === '55P03') return { kind: 'rejected', code: 'BUSY' }
  if (c === '42501') return { kind: 'rejected', code: 'FORBIDDEN' }
  if (/^PGRST3[0-9]{2}$/.test(c) || r.status === 401) return { kind: 'rejected', code: 'TOKEN_REJECTED' }
  if (/^PGRST[12][0-9]{2}$/.test(c)) return { kind: 'rejected', code: 'REQUEST_REJECTED' }
  if (c === '' || c === '57014' || /^57P/.test(c) || /^08/.test(c) || /^PGRST0/.test(c) || !/^[0-9A-Z]{5}$/.test(c)) return { kind: 'unknown', code: c || `HTTP_${r.status}` }
  return { kind: 'rejected', code: 'QUERY_FAILED' }
}

// ── Export snapshot lớp nguồn ───────────────────────────────────────────────

/** So chuỗi theo BYTE UTF-8 (= COLLATE "C" của DB UTF8). */
export function cmsUtf8Compare(a: string, b: string): number {
  const x = Buffer.from(a, 'utf8'), y = Buffer.from(b, 'utf8')
  return Buffer.compare(x, y)
}

export interface CmsAttestExportState { programId: string; runId: string; rows: CmsRawRow[]; lastId: string | null; total: number | null; pages: number }
export const newCmsAttestExportState = (programId: string, runId: string): CmsAttestExportState =>
  ({ programId, runId, rows: [], lastId: null, total: null, pages: 0 })

/**
 * Kiểm + gộp MỘT trang rpc_cms_run_source_export. Sai ⇒ mã cố định (không file dở mang nhãn hoàn chỉnh):
 * EXPORT_SHAPE (sai dạng / khoá) · EXPORT_RUN (run khác / source_schema khác 1) · EXPORT_ORDER (id không tăng nghiêm ngặt theo byte
 * — trùng / sót / đảo) · EXPORT_PAGING (next_after sai) · EXPORT_COUNT (tổng dòng ≠ total trang đầu).
 */
export function cmsAttestExportPage(s: CmsAttestExportState, page: unknown, limit: number):
  { ok: true; state: CmsAttestExportState; done: boolean } | { ok: false; code: string } {
  if (typeof page !== 'object' || page === null || Array.isArray(page)) return { ok: false, code: 'EXPORT_SHAPE' }
  const p = page as Record<string, unknown>
  if (p.run_id !== s.runId || p.source_schema !== 1) return { ok: false, code: 'EXPORT_RUN' }
  if (!Array.isArray(p.rows) || p.rows.length > limit) return { ok: false, code: 'EXPORT_SHAPE' }
  const first = s.pages === 0
  if (first) {
    if (typeof p.total !== 'number' || !Number.isSafeInteger(p.total) || p.total < 0) return { ok: false, code: 'EXPORT_SHAPE' }
  } else if (p.total !== null && p.total !== undefined) return { ok: false, code: 'EXPORT_SHAPE' }
  const rows: CmsRawRow[] = []
  let last = s.lastId
  for (const r of p.rows) {
    if (typeof r !== 'object' || r === null || Array.isArray(r)) return { ok: false, code: 'EXPORT_SHAPE' }
    const o = r as Record<string, unknown>
    const keys = Object.keys(o).sort()
    if (JSON.stringify(keys) !== JSON.stringify([...CMS_SALES_COLUMNS].sort())) return { ok: false, code: 'EXPORT_SHAPE' }
    const row: CmsRawRow = {}
    for (const k of CMS_SALES_COLUMNS) {
      const v = o[k]
      if (v !== null && typeof v !== 'string') return { ok: false, code: 'EXPORT_SHAPE' }
      row[k] = v as string | null
    }
    const id = row.order_line_id
    if (typeof id !== 'string' || !id) return { ok: false, code: 'EXPORT_SHAPE' }
    if (last !== null && cmsUtf8Compare(id, last) <= 0) return { ok: false, code: 'EXPORT_ORDER' }
    last = id
    rows.push(row)
  }
  const full = p.rows.length === limit
  if (full ? p.next_after !== last : p.next_after !== null && p.next_after !== undefined) return { ok: false, code: 'EXPORT_PAGING' }
  const state: CmsAttestExportState = { ...s, rows: [...s.rows, ...rows], lastId: last, total: first ? (p.total as number) : s.total, pages: s.pages + 1 }
  if (state.total !== null && state.rows.length > state.total) return { ok: false, code: 'EXPORT_COUNT' }
  const done = !full
  if (done && state.rows.length !== state.total) return { ok: false, code: 'EXPORT_COUNT' }
  return { ok: true, state, done }
}

/** CSV chuẩn I4 (header 14 cột CMS_SALES_COLUMNS, RFC 4180, CRLF, không BOM; NULL = ô rỗng). */
export function cmsAttestExportCsv(rows: readonly CmsRawRow[]): string {
  return toCareCsv([[...CMS_SALES_COLUMNS], ...rows.map((r) => CMS_SALES_COLUMNS.map((k) => r[k] ?? ''))], false)
}

/** Phần `app` của evidence-meta cho file vừa xuất (operator ghép với phần `reference`; asOf = mốc M CỦA reference). */
export function cmsAttestAppSide(i: { runId: string; exportedAt: string; fileSha256: string; program: CmsAttestProgram }) {
  return {
    inputKind: 'published_run', source: 'rpc_cms_run_source_export', exportedAt: i.exportedAt, asOf: '<mốc M — giống reference.asOf>',
    fileSha256: i.fileSha256, scope: { startDate: i.program.startDate, endDate: i.program.endDate, productIds: [...i.program.productIds] }, runId: i.runId,
  }
}

// ── Chương trình (đọc chỉ đọc qua pg-meta) ──────────────────────────────────

export interface CmsAttestProgram {
  id: string; isTest: boolean; status: string; startDate: string; endDate: string; productIds: string[]; currentRunId: string | null
}

export function cmsAttestProgramSql(programId: string): string {
  if (!UUID_RE.test(programId)) throw new Error('programId không phải UUID')
  return `SELECT p.id::text AS id, p.is_test, p.status::text AS status, p.start_date::text AS start_date, p.end_date::text AS end_date,
       p.current_result_run_id::text AS current_run_id,
       COALESCE((SELECT array_agg(pp.product_id ORDER BY pp.product_id) FROM public.cms_program_products pp WHERE pp.program_id = p.id), '{}') AS product_ids
  FROM public.cms_programs p WHERE p.id = '${programId}'::uuid`
}

export function parseCmsAttestProgram(row: unknown): CmsAttestProgram | null {
  if (!row || typeof row !== 'object') return null
  const r = row as Record<string, unknown>
  if (typeof r.id !== 'string' || !UUID_RE.test(r.id) || typeof r.is_test !== 'boolean' || typeof r.status !== 'string') return null
  if (typeof r.start_date !== 'string' || typeof r.end_date !== 'string' || !Array.isArray(r.product_ids)) return null
  return {
    id: r.id, isTest: r.is_test, status: r.status, startDate: r.start_date, endDate: r.end_date,
    productIds: (r.product_ids as unknown[]).map(String).sort(), currentRunId: typeof r.current_run_id === 'string' ? r.current_run_id : null,
  }
}

/** Context compare-source chỉ cần kỳ + ProductID (không mapping — so nguồn không đánh giá gán người bán). */
export function cmsAttestContext(p: CmsAttestProgram): CmsI4Context {
  return {
    program: { startDate: p.startDate, endDate: p.endDate, catalogTargetGmv: null, storeIds: [],
      products: p.productIds.map((productId) => ({ productId, gmvBasis: 'none', targetGmv: null, baseQuantityCms: '1', tiers: [{ from: 1, to: null, amount: '1' }] })) },
    users: [], stores: [],
  } as unknown as CmsI4Context
}

// ── Đích của revoke (PM COMPINT-P1-1) ───────────────────────────────────────
// RPC thu hồi chỉ nhận id chứng nhận: DB xác thực super theo chương trình THẬT của chứng nhận, không biết CLI đã kiểm guard /
// ghi sổ theo `--program` nào. Vì vậy TRƯỚC khi chọn guard (QA / vận hành), dry-run, ghi ý định hay gửi RPC, CLI phải chứng minh
// chứng nhận thuộc ĐÚNG `--program` (và ghi run của nó vào sổ): (1) đọc chỉ đọc qua pg-meta chương trình / run thật của chứng
// nhận (bất biến); (2) sau guard preflight, đọc lịch sử chứng nhận của `--program` bằng PHIÊN super (rpc_cms_source_attestations
// — kiểm super + marker QA) và phải thấy đúng id + run. Lệch ⇒ rc 2, 0 RPC ghi, 0 thay đổi chứng nhận.

export interface CmsAttestTarget { id: string; programId: string; runId: string; programIsTest: boolean }

export function cmsAttestTargetSql(attestationId: string): string {
  if (!UUID_RE.test(attestationId)) throw new Error('attestationId không phải UUID')
  return `SELECT a.id::text AS id, a.program_id::text AS program_id, a.run_id::text AS run_id, p.is_test AS program_is_test
  FROM public.cms_source_attestations a JOIN public.cms_programs p ON p.id = a.program_id WHERE a.id = '${attestationId}'::uuid`
}

export function parseCmsAttestTarget(row: unknown): CmsAttestTarget | null {
  if (!row || typeof row !== 'object') return null
  const r = row as Record<string, unknown>
  if (typeof r.id !== 'string' || !UUID_RE.test(r.id) || typeof r.program_id !== 'string' || !UUID_RE.test(r.program_id)) return null
  if (typeof r.run_id !== 'string' || !UUID_RE.test(r.run_id) || typeof r.program_is_test !== 'boolean') return null
  return { id: r.id, programId: r.program_id, runId: r.run_id, programIsTest: r.program_is_test }
}

/** (1) Đích thật (pg-meta) phải là chứng nhận của ĐÚNG `--program`. Chạy TRƯỚC khi chọn guard QA / vận hành. */
export function cmsAttestRevokeTargetCheck(i: { programId: string; attestationId: string; rows: readonly unknown[] }):
  { ok: true; target: CmsAttestTarget } | { ok: false; code: 'ATTEST_NOT_FOUND' | 'ATTEST_PROGRAM_MISMATCH' | 'ATTEST_TARGET_SHAPE'; reason: string } {
  if (i.rows.length === 0) return { ok: false, code: 'ATTEST_NOT_FOUND', reason: `không có chứng nhận ${mask(i.attestationId)}` }
  const t = i.rows.length === 1 ? parseCmsAttestTarget(i.rows[0]) : null
  if (!t || t.id !== i.attestationId) return { ok: false, code: 'ATTEST_TARGET_SHAPE', reason: 'không đọc được chương trình / run của chứng nhận' }
  if (t.programId !== i.programId) {
    return { ok: false, code: 'ATTEST_PROGRAM_MISMATCH', reason: `chứng nhận ${mask(t.id)} thuộc chương trình ${mask(t.programId)}, KHÔNG phải --program ${mask(i.programId)} — không thu hồi; kiểm lại --program / --attestation` }
  }
  return { ok: true, target: t }
}

/** (2) Lịch sử chứng nhận của `--program` đọc bằng PHIÊN super (rpc_cms_source_attestations) phải có đúng id + run của đích. */
export function cmsAttestRevokeHistoryCheck(target: CmsAttestTarget, history: unknown):
  { ok: true } | { ok: false; code: 'ATTEST_NOT_IN_PROGRAM'; reason: string } {
  const list = Array.isArray(history) ? history : []
  const hit = list.filter((x) => typeof x === 'object' && x !== null && (x as Record<string, unknown>).id === target.id)
  if (hit.length !== 1 || (hit[0] as Record<string, unknown>).run_id !== target.runId) {
    return { ok: false, code: 'ATTEST_NOT_IN_PROGRAM', reason: `phiên super không thấy chứng nhận ${mask(target.id)} (run ${mask(target.runId)}) trong lịch sử của chương trình ${mask(target.programId)} — không thu hồi` }
  }
  return { ok: true }
}

// ── Payload chứng nhận (decision10) ─────────────────────────────────────────

export type CmsAttestPayload = Record<string, string>

/** Payload rpc_cms_source_attest từ kết quả compare-source TÍNH LẠI trên hai file + metadata. Sai ⇒ lý do (chưa gọi DB). */
export function cmsAttestBuildPayload(i: {
  program: CmsAttestProgram; runId: string; compare: CmsI4CompareResult; meta: CmsI4EvidenceMeta
  refSha: string; appSha: string; ack: string | undefined
}): { ok: true; payload: CmsAttestPayload; payloadSha256: string } | { ok: false; reasons: string[] } {
  const r: string[] = []
  const { program: p, compare: c, meta: m } = i
  if (!UUID_RE.test(i.runId)) r.push('run không phải UUID')
  if (p.status !== 'active') r.push(`chương trình ${p.status} — chỉ chứng nhận chương trình đang chạy chưa chốt`)
  if (p.currentRunId !== i.runId) r.push('run không phải run hiện hành của chương trình (đã có run mới công bố?) — xuất lại')
  if (c.verdict !== 'MATCH' || c.dataIssues.length || c.notProven.length) r.push(`compare-source không MATCH (${c.verdict}${[...c.dataIssues, ...c.notProven].length ? `: ${[...c.dataIssues, ...c.notProven].slice(0, 5).join(', ')}` : ''})`)
  if (c.compare.missing || c.compare.extra || c.compare.changed) r.push('còn dòng thiếu / thừa / lệch trường quyết định')
  if (c.version !== CMS_I4_COMPARE_VERSION || c.fpVersion !== CMS_I4_ROWS_FP_VERSION) r.push('phiên bản công cụ / vân tay khác bản DB nhận')
  if (m.app.inputKind !== 'published_run' || m.app.runId !== i.runId) r.push('metadata app phải là published_run của đúng run')
  if (m.reference.inputKind !== 'reference_source') r.push('metadata reference phải là reference_source (nguồn độc lập)')
  const scopeOk = (s: CmsI4EvidenceMeta['reference']['scope']) => s.startDate === p.startDate && s.endDate === p.endDate
    && JSON.stringify([...s.productIds].sort()) === JSON.stringify(p.productIds)
  if (!scopeOk(m.reference.scope) || !scopeOk(m.app.scope)) r.push('phạm vi metadata ≠ toàn kỳ / toàn SP của chương trình')
  if (m.reference.fileSha256 !== i.refSha || m.app.fileSha256 !== i.appSha || !HEX64.test(i.refSha) || !HEX64.test(i.appSha)) r.push('sha256 file ≠ metadata')
  if (c.reference.decisionFp !== c.app.decisionFp || !HEX64.test(c.app.decisionFp)) r.push('vân tay decision10 hai bên khác nhau')
  if (c.app.outOfScope !== 0 || c.app.rowIssues !== 0 || c.compare.matched !== c.app.rowsRead || c.compare.matched === 0) r.push('file run phải gồm đúng các dòng nguồn trong scope (không lỗi dòng / ngoài scope, > 0 dòng)')
  const scopeHash = cmsI4ScopeHash({ startDate: p.startDate, endDate: p.endDate, productIds: p.productIds })
  if (c.scope.scopeHash !== scopeHash) r.push('scopeHash compare ≠ chương trình')
  const ack = cmsNormalizeAck(i.ack)
  if (ack === null) r.push('--ack: lý do xác nhận 10…1.000 ký tự')
  const label = m.reference.source
  if (!label || label !== label.trim() || label.length < 3 || label.length > 200 || /[\x00-\x1f\x7f-\x9f]/.test(label)) r.push('reference.source (nhãn nguồn) 3–200 ký tự, không khoảng trắng đầu / cuối / ký tự điều khiển')
  for (const [k, v] of [['reference.asOf', m.reference.asOf], ['reference.exportedAt', m.reference.exportedAt], ['app.exportedAt', m.app.exportedAt]] as const) {
    if (!ISO_UTC_RE.test(v)) r.push(`${k} không phải ISO UTC`)
  }
  if (r.length) return { ok: false, reasons: r }
  const payload: CmsAttestPayload = {
    fp_version: CMS_I4_ROWS_FP_VERSION, field_set: 'decision10', scope_from: p.startDate, scope_to: p.endDate, scope_hash: scopeHash,
    run_rows_fp: c.app.decisionFp, run_file_sha256: i.appSha, reference_rows_fp: c.reference.decisionFp, reference_file_sha256: i.refSha,
    reference_label: label, as_of: m.reference.asOf, reference_exported_at: m.reference.exportedAt, run_exported_at: m.app.exportedAt,
    lines_compared: String(c.compare.matched), missing_lines: '0', extra_lines: '0', changed_lines: '0',
    tool_version: CMS_I4_COMPARE_VERSION, ack_reason: ack as string,
  }
  return { ok: true, payload, payloadSha256: cmsAttestPayloadSha(i.program.id, i.runId, payload) }
}

/** Băm ổn định của (chương trình, run, payload) — chỉ để sổ nhận diện lần gọi lại cùng nội dung (DB tự băm riêng). */
export function cmsAttestPayloadSha(programId: string, runId: string, payload: CmsAttestPayload): string {
  const sorted = Object.fromEntries(Object.keys(payload).sort().map((k) => [k, payload[k]]))
  return createHash('sha256').update(JSON.stringify({ program: programId, run: runId, payload: sorted })).digest('hex')
}

/** Phản hồi attest / revoke phải nói đúng thao tác vừa yêu cầu — lệch ⇒ không kết luận thành công. */
export function cmsAttestCheckReply(op: 'attest' | 'revoke', data: unknown, expect: { runId?: string; attestationId?: string }):
  { ok: true; id: string; already: boolean } | { ok: false } {
  if (typeof data !== 'object' || data === null) return { ok: false }
  const d = data as Record<string, unknown>
  if (typeof d.id !== 'string' || !UUID_RE.test(d.id) || typeof d.already !== 'boolean') return { ok: false }
  if (op === 'attest' && (d.attested !== true || d.run_id !== expect.runId)) return { ok: false }
  if (op === 'revoke' && (d.revoked !== true || d.id !== expect.attestationId)) return { ok: false }
  return { ok: true, id: d.id, already: d.already }
}

// ── Sổ thao tác (a-….json, ghi độc quyền + atomic) ──────────────────────────

export type CmsAttestOpStatus = 'intent' | 'done' | 'rejected' | 'unknown' | 'reconciled'
export interface CmsAttestOp {
  kind: 'cms-source-attest-op'
  version: 1
  operationId: string
  op: 'attest' | 'revoke'
  /** Run QA (cms-qa-…) khi thao tác chương trình QA; null = vận hành thật (ngoài run QA). */
  qaRunId: string | null
  host: string
  pid: number
  programId: string
  /** attest: run được chứng nhận · revoke: run THẬT của chứng nhận bị thu hồi (r4 — sổ cũ trước r4 có thể null). */
  runId: string | null
  /** revoke: chứng nhận bị thu hồi; attest: id nhận được (khi có). */
  attestationId: string | null
  idemKey: string
  payloadSha256: string | null
  /** uid của phiên super (claim sub) — không email / token. */
  actorId: string
  startedAt: string
  status: CmsAttestOpStatus
  finishedAt: string | null
  result: { code: string | null; attestationId: string | null; already: boolean } | null
  reconcile?: { at: string; found: boolean; attestationId: string | null } | null
}

export function newCmsAttestOp(i: Omit<CmsAttestOp, 'kind' | 'version' | 'status' | 'finishedAt' | 'result'>): CmsAttestOp {
  const bad = !CMS_ATTEST_OP_ID_RE.test(i.operationId) || (i.qaRunId !== null && !RUN_ID_RE.test(i.qaRunId)) || !i.host
    || !Number.isInteger(i.pid) || i.pid <= 0 || !UUID_RE.test(i.programId) || (i.runId !== null && !UUID_RE.test(i.runId))
    || (i.attestationId !== null && !UUID_RE.test(i.attestationId)) || !UUID_RE.test(i.idemKey) || !UUID_RE.test(i.actorId)
    || (i.payloadSha256 !== null && !HEX64.test(i.payloadSha256)) || i.runId === null
    || (i.op === 'attest' ? i.payloadSha256 === null || i.attestationId !== null : i.attestationId === null || i.payloadSha256 !== null)
  if (bad) throw new Error('mục sổ chứng nhận không hợp lệ')
  return { kind: 'cms-source-attest-op', version: 1, ...i, status: 'intent', finishedAt: null, result: null }
}

export function parseCmsAttestOp(text: string): { ok: true; value: CmsAttestOp } | { ok: false; reason: string } {
  let o: Partial<CmsAttestOp>
  try { o = JSON.parse(text) } catch { return { ok: false, reason: 'không phải JSON' } }
  if (!o || o.kind !== 'cms-source-attest-op' || o.version !== 1) return { ok: false, reason: 'sai loại / phiên bản' }
  if (typeof o.operationId !== 'string' || !CMS_ATTEST_OP_ID_RE.test(o.operationId)) return { ok: false, reason: 'operationId sai' }
  if (o.op !== 'attest' && o.op !== 'revoke') return { ok: false, reason: 'op sai' }
  if (o.qaRunId !== null && !(typeof o.qaRunId === 'string' && RUN_ID_RE.test(o.qaRunId))) return { ok: false, reason: 'qaRunId sai' }
  for (const k of ['programId', 'idemKey', 'actorId'] as const) if (typeof o[k] !== 'string' || !UUID_RE.test(o[k] as string)) return { ok: false, reason: `${k} sai` }
  for (const k of ['runId', 'attestationId'] as const) if (o[k] !== null && !(typeof o[k] === 'string' && UUID_RE.test(o[k] as string))) return { ok: false, reason: `${k} sai` }
  if (!Number.isInteger(o.pid) || (o.pid as number) <= 0) return { ok: false, reason: 'pid sai' }
  if (typeof o.startedAt !== 'string' || Number.isNaN(Date.parse(o.startedAt))) return { ok: false, reason: 'startedAt sai' }
  if (!['intent', 'done', 'rejected', 'unknown', 'reconciled'].includes(o.status as string)) return { ok: false, reason: 'trạng thái sai' }
  if ((o.status === 'done' || o.status === 'rejected' || o.status === 'unknown') && !o.result) return { ok: false, reason: 'thiếu kết quả' }
  if (o.status === 'reconciled' && (!o.reconcile || typeof o.reconcile.found !== 'boolean')) return { ok: false, reason: 'thiếu đối chiếu' }
  return { ok: true, value: o as CmsAttestOp }
}

export function cmsAttestOpOutcome(o: CmsAttestRpcOutcome, replyOk: boolean): 'done' | 'rejected' | 'unknown' {
  if (o.kind === 'ok') return replyOk ? 'done' : 'unknown'
  return o.kind === 'rejected' ? 'rejected' : 'unknown'
}

/** Thao tác CHƯA khép (intent / unknown) của cùng chương trình ⇒ chặn thao tác ghi mới tới khi reconcile. */
export function cmsAttestPendingOps(ops: readonly CmsAttestOp[], programId: string): CmsAttestOp[] {
  return ops.filter((e) => e.programId === programId && (e.status === 'intent' || e.status === 'unknown'))
}

/** Đã ghi (theo sổ): attest done / reconciled-found ⇒ id chứng nhận; revoke ⇒ id bị thu hồi. */
export function cmsAttestOpLanded(e: CmsAttestOp): string | null {
  if (e.status === 'done') return e.result?.attestationId ?? null
  if (e.status === 'reconciled' && e.reconcile?.found) return e.reconcile.attestationId
  return null
}

// ── Reconcile (đọc DB theo ĐÚNG khoá idem) ──────────────────────────────────

/** Có bảng chứng nhận chưa (DB trước 124 ⇒ close vẫn chạy, chỉ kiểm sổ). */
export const CMS_QA_HAS_ATTEST_SQL = `SELECT (to_regclass('public.cms_source_attestations') IS NOT NULL) AS has_attest`

export function cmsAttestReconcileSql(e: CmsAttestOp): string {
  if (!UUID_RE.test(e.idemKey)) throw new Error('idemKey không phải UUID')
  const col = e.op === 'attest' ? 'idem_key' : 'revoke_idem_key'
  return `SELECT a.id::text AS id, a.program_id::text AS program_id, a.run_id::text AS run_id, a.attested_by::text AS attested_by,
       a.revoked_by::text AS revoked_by
  FROM public.cms_source_attestations a WHERE a.${col} = '${e.idemKey}'::uuid`
}

/** Phiên DB đang chạy RPC chứng nhận / thu hồi (trừ chính phiên đọc). */
export const CMS_ATTEST_INFLIGHT_SQL = `SELECT
  (SELECT r.rolsuper OR pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER') FROM pg_roles r WHERE r.rolname = current_user) AS can_see_all,
  (SELECT count(*)::int FROM pg_stat_activity a WHERE a.pid <> pg_backend_pid() AND a.datname = current_database()
     AND a.backend_type = 'client backend' AND a.query = '<insufficient privilege>') AS hidden,
  (SELECT count(*)::int FROM pg_stat_activity a WHERE a.pid <> pg_backend_pid() AND a.datname = current_database()
     AND a.backend_type = 'client backend' AND a.state IS DISTINCT FROM 'idle' AND a.query ILIKE '%rpc\\_cms\\_source\\_attest%') AS inflight`

export interface CmsAttestReconcileRow { id: string; program_id: string; run_id: string; attested_by: string; revoked_by: string | null }

export function cmsAttestReconcileCheck(e: CmsAttestOp, rows: readonly CmsAttestReconcileRow[],
  o: { nowMs: number; pidAlive: boolean; probe: { can_see_all: boolean; hidden: number; inflight: number } | undefined }):
  { ok: true; found: boolean; attestationId: string | null } | { ok: false; wait?: true; reason: string } {
  if (e.status === 'done' || e.status === 'rejected' || e.status === 'reconciled') return { ok: false, reason: `thao tác ${e.operationId} đã có kết quả (${e.status}) — không cần reconcile` }
  if (e.status === 'intent' && o.pidAlive) return { ok: false, wait: true, reason: `thao tác ${e.operationId} (pid ${e.pid}) còn chạy — chờ xong` }
  const row = rows[0]
  if (row) {
    // Đủ bộ (PM COMPINT-P1-1): chương trình + run + người (+ id chứng nhận khi thu hồi) — không nhận chỉ vì đúng khoá idem.
    const same = e.op === 'attest'
      ? row.program_id === e.programId && row.run_id === e.runId && row.attested_by === e.actorId
      : row.id === e.attestationId && row.program_id === e.programId && row.revoked_by === e.actorId && (e.runId === null || row.run_id === e.runId)
    if (!same) return { ok: false, reason: `khoá idem của ${e.operationId} đã dùng cho thao tác KHÁC (chương trình / run / người khác sổ) — điều tra, không tự nhận` }
    return { ok: true, found: true, attestationId: row.id }
  }
  const pr = o.probe
  if (!pr || pr.can_see_all !== true || !Number.isInteger(pr.hidden) || pr.hidden > 0) {
    return { ok: false, reason: 'không chứng minh được không còn phiên chứng nhận (vai không thấy mọi phiên / có phiên ẩn) — chạy bằng vai superuser của pg-meta' }
  }
  if (!Number.isInteger(pr.inflight) || pr.inflight > 0) return { ok: false, wait: true, reason: `còn ${pr.inflight} phiên DB đang chạy RPC chứng nhận — chờ rồi chạy lại reconcile` }
  const left = CMS_ATTEST_SETTLE_MS - (o.nowMs - Date.parse(e.finishedAt ?? e.startedAt))
  if (left > 0) return { ok: false, wait: true, reason: `chưa đủ thời gian lắng — chờ thêm ${Math.ceil(left / 1000)} s rồi chạy lại reconcile` }
  return { ok: true, found: false, attestationId: null }
}

// ── Guard run QA hai pha (PM COMPINT-P1-2) ──────────────────────────────────
// Lỗi r3: guard kiểm manifest / Git / launcher TRƯỚC hai lượt chờ pg-meta rồi dùng lại trạng thái cũ; marker không trừ thời gian
// chờ; export chỉ guard một lần. Thiết kế r4 (cùng nguyên tắc writer cms-qa-results.mjs, chặt hơn ở bước cuối):
//  · ngân sách tính TỪ TRƯỚC guard (deadlineAt do bên gọi đặt, đồng hồ đơn điệu ms nguyên) — guard + gửi request cùng nằm trong
//    đó; không tự mở hạn mới sau khi guard chờ lâu;
//  · pha IO (async): kiểm nhanh cục bộ → đọc DB (chương trình + marker, timeout = min(10 s, phần còn lại)) → thăm cổng launcher
//    (async, TRƯỚC lần kiểm cục bộ cuối);
//  · pha cuối `final()` ĐỒNG BỘ — bên gọi gọi NGAY trước ghi ý định / gửi request, không còn await nào giữa: đọc lại manifest
//    (byte phải y nguyên), Git (sạch + HEAD / tree), pid launcher + server; marker trừ BẢO THỦ thời gian từ lúc bắt đầu IO; phần
//    ngân sách còn lại < 5 s ⇒ không gửi. Bên gọi tính lại timeout request từ `remainMs`.
// Mã: GUARD_BLOCKED (điều kiện cục bộ / DB không đạt) · GUARD_IO (không đọc được DB) · GUARD_DEADLINE (hết ngân sách).

/** Timeout một lượt đọc DB của guard (hai SELECT nhỏ). */
export const CMS_ATTEST_GUARD_IO_MS = 10_000
/** Ngân sách MỘT bước có guard (guard + gửi request), tính từ trước guard. */
export const CMS_ATTEST_QA_BUDGET_MS = 60_000
/** Phần ngân sách tối thiểu còn lại sau guard để còn gửi request. */
export const CMS_ATTEST_MIN_SEND_MS = 5_000

export type CmsAttestGuardOutcome =
  | { ok: true; remainMs: number }
  | { ok: false; code: 'GUARD_BLOCKED' | 'GUARD_IO' | 'GUARD_DEADLINE'; reasons: string[] }

export interface CmsAttestGuardDeps {
  /** Đồng hồ đơn điệu, ms nguyên (cmsQaMonoClock). */
  now(): number
  /** Đọc lại file manifest (đồng bộ); null nếu không còn. */
  manifestText(): string | null
  parseManifest(text: string): CmsQaRunManifest | null
  /** Trạng thái Git hiện tại (đồng bộ); null nếu không đọc được. */
  git(): { treeClean: boolean; gitHead: string; gitTree: string } | null
  pidAlive(pid: number): boolean
  portOpen(port: number): Promise<boolean>
  /** Một câu SELECT chỉ đọc qua pg-meta với timeout cho trước (ms nguyên). */
  read(sql: string, timeoutMs: number): Promise<unknown[]>
}

export interface CmsAttestGuardInput {
  /** Byte manifest lúc CLI bắt đầu — mọi thay đổi sau đó (đóng / ghi cờ / run khác) ⇒ chặn. */
  manifestText: string
  manifest: CmsQaRunManifest
  confirmRun: string
  host: string
  actorId: string
  programId: string
  deadlineAt: number
}

function cmsAttestGuardLocal(d: CmsAttestGuardDeps, i: CmsAttestGuardInput, portUp: boolean): string[] {
  const text = d.manifestText()
  if (text === null || text !== i.manifestText) return ['manifest run QA không còn / đã đổi so với lúc bắt đầu lệnh (đóng run, ghi cờ hoặc run khác) — không ghi']
  const cur = d.parseManifest(text)
  if (!cur || cur.status !== 'open') return ['manifest run QA không còn mở']
  const g = d.git()
  if (!g) return ['không đọc được Git']
  const c = cur as CmsQaRunManifest & { launcherPid?: unknown }
  const launcherAlive = portUp && c.port !== null && c.serverPid !== null && !c.serverNotStopped && Number.isInteger(c.launcherPid)
    && d.pidAlive(c.launcherPid as number) && d.pidAlive(c.serverPid as number)
  const local = cmsQaLockLocalCheck({ manifest: cur, confirmRun: i.confirmRun, host: i.host, ...g, launcherAlive, actorId: i.actorId })
  return local.ok ? [] : local.reasons
}

/** Pha IO của guard — trả `final()` ĐỒNG BỘ cho bước cuối (xem đầu mục). Không bao giờ ném; không tự ghi gì. */
export async function cmsAttestQaGuard(d: CmsAttestGuardDeps, i: CmsAttestGuardInput): Promise<{ final(): CmsAttestGuardOutcome }> {
  const fixed = (o: CmsAttestGuardOutcome) => ({ final: () => o })
  const left = () => i.deadlineAt - d.now()
  const deadline = (): CmsAttestGuardOutcome => ({ ok: false, code: 'GUARD_DEADLINE', reasons: [`hết ngân sách guard + gửi (còn ${Math.max(0, left())} ms < ${CMS_ATTEST_MIN_SEND_MS} ms) — không gửi`] })
  const t0 = d.now()
  if (left() < CMS_ATTEST_MIN_SEND_MS) return fixed(deadline())
  try {
    const pre = cmsAttestGuardLocal(d, i, true)
    if (pre.length) return fixed({ ok: false, code: 'GUARD_BLOCKED', reasons: pre })
  } catch { return fixed({ ok: false, code: 'GUARD_BLOCKED', reasons: ['không kiểm được điều kiện cục bộ'] }) }
  const uids = i.manifest.users.map((u) => u.id)
  let programRows: unknown[], statusRows: unknown[]
  try {
    const io = () => {
      const r = left()
      if (r < CMS_ATTEST_MIN_SEND_MS) throw new Error('GUARD_DEADLINE')
      return cmsQaIoTimeoutMs(CMS_ATTEST_GUARD_IO_MS, r - CMS_ATTEST_MIN_SEND_MS, 1_000)
    }
    programRows = await d.read(cmsQaWriterProgramSql(i.programId, i.manifest.startedAt, uids), io())
    statusRows = await d.read(cmsQaStatusSql(uids), io())
  } catch {
    return fixed(left() < CMS_ATTEST_MIN_SEND_MS ? deadline() : { ok: false, code: 'GUARD_IO', reasons: ['không đọc được DB (guard run QA)'] })
  }
  let portUp = false
  try { portUp = i.manifest.port !== null && (await d.portOpen(i.manifest.port)) } catch { portUp = false }
  return {
    final: (): CmsAttestGuardOutcome => {
      try {
        const reasons = cmsAttestGuardLocal(d, i, portUp)
        if (!reasons.length) {
          const aged = cmsQaAgeStatusRows(statusRows as CmsQaStatusRow[], d.now() - t0)
          const c = cmsQaWriterDbCheck({ manifest: i.manifest, programId: i.programId, programRows: programRows as CmsQaWriterProgramRow[], statusRows: aged,
            guardMinutes: CMS_QA_GUARD_MINUTES_MIN })
          if (!c.ok) reasons.push(...c.reasons)
        }
        if (reasons.length) return { ok: false, code: 'GUARD_BLOCKED', reasons }
        const remain = left()
        if (remain < CMS_ATTEST_MIN_SEND_MS) return deadline()
        return { ok: true, remainMs: remain }
      } catch { return { ok: false, code: 'GUARD_BLOCKED', reasons: ['không kiểm được điều kiện cuối'] } }
    },
  }
}

// ── Close run QA: sổ chứng nhận ↔ DB ────────────────────────────────────────

export function cmsQaRunAttestSql(startedAt: string): string {
  if (!ISO_UTC_RE.test(startedAt) || Number.isNaN(Date.parse(startedAt))) throw new Error('startedAt không hợp lệ')
  return `SELECT a.id::text AS id, a.program_id::text AS program_id, a.run_id::text AS run_id, p.is_test AS program_is_test,
       a.attested_by::text AS attested_by, a.idem_key::text AS idem_key, (a.attested_at >= '${startedAt}'::timestamptz) AS attested_in_run,
       a.revoked_by::text AS revoked_by, a.revoke_idem_key::text AS revoke_idem_key,
       (a.revoked_at IS NOT NULL AND a.revoked_at >= '${startedAt}'::timestamptz) AS revoked_in_run
  FROM public.cms_source_attestations a JOIN public.cms_programs p ON p.id = a.program_id
 WHERE a.attested_at >= '${startedAt}'::timestamptz OR a.revoked_at >= '${startedAt}'::timestamptz
 ORDER BY a.attested_at, a.id`
}

export interface CmsQaAttestRow {
  id: string; program_id: string; run_id: string; program_is_test: boolean; attested_by: string; idem_key: string; attested_in_run: boolean
  revoked_by: string | null; revoke_idem_key: string | null; revoked_in_run: boolean
}

/**
 * Mục sổ KHẲNG ĐỊNH đúng dòng DB cho thao tác `op` (PM COMPINT-P1-1 — đủ bộ, không chỉ một idem hoặc một id): cùng loại thao tác,
 * khoá idem, người, chương trình, id chứng nhận đã ghi / bị thu hồi, run (attest luôn; revoke khi sổ có run — sổ trước r4 null).
 */
export function cmsAttestOpMatchesRow(e: CmsAttestOp, op: 'attest' | 'revoke', r: CmsQaAttestRow): boolean {
  const idem = op === 'attest' ? r.idem_key : r.revoke_idem_key
  const actor = op === 'attest' ? r.attested_by : r.revoked_by
  if (e.op !== op || idem === null || e.idemKey !== idem || actor === null || e.actorId !== actor || e.programId !== r.program_id) return false
  if (cmsAttestOpLanded(e) !== r.id) return false
  if (op === 'attest') return e.runId === r.run_id
  return e.attestationId === r.id && (e.runId === null || e.runId === r.run_id)
}

/**
 * Close: sổ chứng nhận (a-…) của run + MỌI chứng nhận / thu hồi trong cửa sổ run:
 *  · sổ hỏng / khác run / sai tên / còn intent / unknown ⇒ ĐỎ (reconcile trước);
 *  · chương trình THẬT: tài khoản QA của run chứng nhận / thu hồi ⇒ ĐỎ; người khác ⇒ cảnh báo (soát tay + --ack-warnings);
 *  · chương trình QA: phải có thao tác trong sổ khẳng định ĐÚNG khoá idem + người; không có ⇒ ĐỎ (ghi ngoài sổ); chương trình QA
 *    không thuộc manifest ⇒ ĐỎ;
 *  · sổ khẳng định đã ghi nhưng DB không có ⇒ ĐỎ.
 */
export function cmsQaAttestCloseCheck(
  m: CmsQaRunManifest, files: readonly { name: string; text: string }[], rows: readonly CmsQaAttestRow[],
  o: { pidAlive: (pid: number) => boolean; attestTable: boolean; programIdsInRun: readonly string[] },
): { reasons: string[]; warningProgramIds: string[]; entries: CmsAttestOp[] } {
  const reasons: string[] = []
  const warn = new Set<string>()
  const entries: CmsAttestOp[] = []
  const rec = (id: string) => `chạy \`node scripts/cms-source-attest.mjs reconcile --op=${id} --confirm-run=${m.runId}\``
  for (const f of files) {
    const p = parseCmsAttestOp(f.text)
    if (!p.ok) { reasons.push(`sổ chứng nhận ${f.name} hỏng (${p.reason}) — không xoá tay; báo PM / operator`); continue }
    const e = p.value
    if (e.qaRunId !== m.runId) { reasons.push(`sổ chứng nhận ${e.operationId} thuộc run khác`); continue }
    if (`${e.operationId}.json` !== f.name) { reasons.push(`sổ chứng nhận ${f.name} sai tên file`); continue }
    if (e.status === 'intent') reasons.push(o.pidAlive(e.pid) ? `thao tác ${e.operationId} (pid ${e.pid}) CÒN CHẠY — chờ xong rồi mới close` : `thao tác ${e.operationId} không rõ kết thúc (sổ còn ý định) — ${rec(e.operationId)}`)
    else if (e.status === 'unknown') reasons.push(`thao tác ${e.operationId} KẾT QUẢ KHÔNG RÕ (${e.result?.code ?? '—'}) — ${rec(e.operationId)}`)
    entries.push(e)
  }
  const qa = new Set(m.users.map((u) => u.id))
  const inRun = new Set(o.programIdsInRun)
  const landed = (op: 'attest' | 'revoke', r: CmsQaAttestRow) => entries.some((e) => cmsAttestOpMatchesRow(e, op, r))
  for (const r of rows) {
    for (const [op, inWindow, actor] of [['attest', r.attested_in_run, r.attested_by], ['revoke', r.revoked_in_run, r.revoked_by]] as const) {
      if (!inWindow) continue
      if (r.program_is_test !== true) {
        if (actor !== null && qa.has(actor)) reasons.push(`chương trình THẬT ${mask(r.program_id)} bị tài khoản QA ${op === 'attest' ? 'chứng nhận' : 'thu hồi chứng nhận'} trong run — dừng, báo PM / operator`)
        else warn.add(r.program_id)
        continue
      }
      if (!inRun.has(r.program_id)) reasons.push(`chương trình QA ${mask(r.program_id)} ngoài run có ${op === 'attest' ? 'chứng nhận' : 'thu hồi'} trong cửa sổ — điều tra`)
      if (!landed(op, r)) reasons.push(`${op === 'attest' ? 'chứng nhận' : 'thu hồi'} ${mask(r.id)} của chương trình QA ${mask(r.program_id)} không có thao tác khẳng định trong sổ (đủ bộ id / chương trình / run / người / khoá) — ghi ngoài sổ, sổ lệch đích hoặc mất phản hồi chưa reconcile`)
    }
  }
  for (const e of entries) {
    const id = cmsAttestOpLanded(e)
    if (id === null) continue
    const inWindow = (r: CmsQaAttestRow) => (e.op === 'attest' ? r.attested_in_run : r.revoked_in_run)
    const ok = o.attestTable && rows.some((r) => inWindow(r) && cmsAttestOpMatchesRow(e, e.op, r))
    if (!ok) reasons.push(`sổ ${e.operationId} ghi đã ${e.op === 'attest' ? 'chứng nhận' : 'thu hồi'} ${mask(id)} nhưng DB không có dòng khớp đủ bộ (chương trình / run / người / khoá) trong cửa sổ run — điều tra`)
  }
  return { reasons, warningProgramIds: [...warn], entries }
}

// ── Sổ XUẤT (x-….json — security review P1-1): export-run trả CSV có email nhân viên ⇒ mỗi lần xuất để lại dấu vết chỉ-thêm ──

export const CMS_ATTEST_EXPORT_ID_RE = /^x-[0-9a-f]{12}$/
export interface CmsAttestExportRecord {
  kind: 'cms-source-export'
  version: 1
  exportId: string
  qaRunId: string | null
  host: string
  pid: number
  programId: string
  runId: string
  /** uid phiên super (claim sub) — không email / token. */
  actorId: string
  startedAt: string
  /** started = đang đọc (ghi TRƯỚC trang đầu) · done = file hoàn chỉnh · failed = không có file. */
  status: 'started' | 'done' | 'failed'
  finishedAt: string | null
  rows: number | null
  sha256: string | null
  code: string | null
}

export function newCmsAttestExportRecord(i: Pick<CmsAttestExportRecord, 'exportId' | 'qaRunId' | 'host' | 'pid' | 'programId' | 'runId' | 'actorId' | 'startedAt'>): CmsAttestExportRecord {
  if (!CMS_ATTEST_EXPORT_ID_RE.test(i.exportId) || (i.qaRunId !== null && !RUN_ID_RE.test(i.qaRunId)) || !i.host || !Number.isInteger(i.pid) || i.pid <= 0
      || !UUID_RE.test(i.programId) || !UUID_RE.test(i.runId) || !UUID_RE.test(i.actorId)) throw new Error('mục sổ xuất không hợp lệ')
  return { kind: 'cms-source-export', version: 1, ...i, status: 'started', finishedAt: null, rows: null, sha256: null, code: null }
}

export function parseCmsAttestExportRecord(text: string): { ok: true; value: CmsAttestExportRecord } | { ok: false; reason: string } {
  let o: Partial<CmsAttestExportRecord>
  try { o = JSON.parse(text) } catch { return { ok: false, reason: 'không phải JSON' } }
  if (!o || o.kind !== 'cms-source-export' || o.version !== 1) return { ok: false, reason: 'sai loại / phiên bản' }
  if (typeof o.exportId !== 'string' || !CMS_ATTEST_EXPORT_ID_RE.test(o.exportId)) return { ok: false, reason: 'exportId sai' }
  if (o.qaRunId !== null && !(typeof o.qaRunId === 'string' && RUN_ID_RE.test(o.qaRunId))) return { ok: false, reason: 'qaRunId sai' }
  for (const k of ['programId', 'runId', 'actorId'] as const) if (typeof o[k] !== 'string' || !UUID_RE.test(o[k] as string)) return { ok: false, reason: `${k} sai` }
  if (!['started', 'done', 'failed'].includes(o.status as string)) return { ok: false, reason: 'trạng thái sai' }
  if (o.status === 'done' && !(Number.isInteger(o.rows) && typeof o.sha256 === 'string' && HEX64.test(o.sha256))) return { ok: false, reason: 'thiếu số dòng / sha256' }
  return { ok: true, value: o as CmsAttestExportRecord }
}

/** Close QA: sổ xuất hỏng / khác run / sai tên ⇒ ĐỎ; còn `started` mà pid đã chết ⇒ cảnh báo trong danh sách (file có thể dở). */
export function cmsQaExportsCloseCheck(m: CmsQaRunManifest, files: readonly { name: string; text: string }[], pidAlive: (pid: number) => boolean):
  { reasons: string[]; entries: CmsAttestExportRecord[] } {
  const reasons: string[] = []
  const entries: CmsAttestExportRecord[] = []
  for (const f of files) {
    const p = parseCmsAttestExportRecord(f.text)
    if (!p.ok) { reasons.push(`sổ xuất ${f.name} hỏng (${p.reason}) — không xoá tay; báo PM / operator`); continue }
    const e = p.value
    if (e.qaRunId !== m.runId) { reasons.push(`sổ xuất ${e.exportId} thuộc run khác`); continue }
    if (`${e.exportId}.json` !== f.name) { reasons.push(`sổ xuất ${f.name} sai tên file`); continue }
    if (e.status === 'started' && pidAlive(e.pid)) reasons.push(`lệnh xuất ${e.exportId} (pid ${e.pid}) CÒN CHẠY — chờ xong rồi mới close`)
    entries.push(e)
  }
  return { reasons, entries }
}
