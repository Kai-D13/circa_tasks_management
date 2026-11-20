// CMS-CALC-RET-2 P5.5 — DTO đọc ĐỐI SOÁT TRẢ HÀNG (rpc_cms_return_conflicts) + BÁO CÁO SAU CHỐT (rpc_cms_return_close_reports /
// _report / _report_events) của migration 130. Thuần, an toàn ở client; parse fail-closed: sai dạng ⇒ throw (UI hiện lỗi, không 0 giả).
// Báo cáo sau chốt KHÔNG phải lệnh thu / chi — DB đánh dấu `not_a_payment_order: true`, UI / XLSX nhắc lại.
// Q-236 (132): baseline fp v2 không có lượng (base_quantity null); báo cáo mang returns_profile (DB 130 / 131 không có ⇒ net_returns_v1).
// full_line: return_base của dòng báo cáo = lượng trừ theo quy ước CMS (Σ lượng dòng bán có phiếu), KHÔNG phải lượng BI.
// 132 r1: báo cáo có người lập (phiên) + lý do lập tay (đường ngày 31); dòng của run CONTRACT có phần trả ĐÃ TRỪ trong số chốt
// (frozen_return_*; NULL ⇔ run legacy). DB trước 132 không có khoá ⇒ null.

import type { CmsReturnProfile } from './calc/policy'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HEX_RE = /^[0-9a-f]{64}$/
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const DEC_RE = /^-?[0-9]{1,35}(\.[0-9]{1,9})?$/
const SINT_RE = /^-?(0|[1-9][0-9]{0,18})$/

export class CmsReturnsDtoError extends Error {
  constructor(k: string) { super(`CMS returns DTO: ${k}`); this.name = 'CmsReturnsDtoError' }
}
type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const s = (o: Obj, k: string, re?: RegExp): string => { const v = o[k]; if (typeof v !== 'string' || (re && !re.test(v))) throw new CmsReturnsDtoError(k); return v }
const sn = (o: Obj, k: string, re?: RegExp): string | null => (o[k] === null || o[k] === undefined ? null : s(o, k, re))
const n = (o: Obj, k: string): number => { const v = o[k]; if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new CmsReturnsDtoError(k); return v }
const nn = (o: Obj, k: string): number | null => (o[k] === null || o[k] === undefined ? null : n(o, k))
const b = (o: Obj, k: string): boolean => { const v = o[k]; if (typeof v !== 'boolean') throw new CmsReturnsDtoError(k); return v }
const arr = (o: Obj, k: string): unknown[] => { const v = o[k]; if (!Array.isArray(v)) throw new CmsReturnsDtoError(k); return v }

// ── Đối soát (conflict) ─────────────────────────────────────────────────────
export type CmsLedgerVerdict = 'CLEAN' | 'MISMATCH' | 'OPEN_CONFLICT_MATCH'
export interface CmsConflictObservation { version: number; evalSeq: number; verdict: string; observed: unknown; observedAt: string }
export interface CmsOpenConflict {
  /** bigint identity (DB) — JSON số. */
  conflictId: number; returnEventId: string; openedKind: string; openedEvalSeq: number; openedAt: string
  /** baseQuantity: lượng BI của baseline fp v1; null ở fp v2 (full_line — lượng không thuộc vân tay). */
  baseline: { returnDocumentId: string | null; originalOrderLineId: string | null; productId: string | null; baseQuantity: string | null; refundAmount: string; recordedAt: string | null }
  observations: CmsConflictObservation[]
}
export interface CmsReturnConflictsDto {
  programId: string
  returnsPolicy: string
  configVersion: number
  baselines: number
  openSetHash: string
  openCount: number
  openTruncated: boolean
  latestEval: { evalSeq: number; kind: string; verdict: string; returnsAsOf: string | null; evaluatedAt: string; mismatched: number | null; openConflicts: number | null } | null
  /** Có ⇔ DB thấy proof hợp lệ ngay lúc đọc (eval mới nhất OPEN_CONFLICT_MATCH + hash khớp). Nút xác nhận CHỈ hiện khi có. */
  proof: { evalSeq: number; openSetHash: string } | null
  open: CmsOpenConflict[]
  restorations: { id: string; proofEvalSeq: number; conflicts: number; reason: string; confirmedAt: string }[]
}

export function parseCmsReturnConflicts(raw: unknown): CmsReturnConflictsDto {
  if (!isObj(raw)) throw new CmsReturnsDtoError('conflicts')
  const le = raw.latest_eval
  const pr = raw.proof
  return {
    programId: s(raw, 'program_id', UUID_RE),
    returnsPolicy: s(raw, 'returns_policy'),
    configVersion: n(raw, 'config_version'),
    baselines: n(raw, 'baselines'),
    openSetHash: s(raw, 'open_set_hash', HEX_RE),
    openCount: n(raw, 'open_count'),
    openTruncated: b(raw, 'open_truncated'),
    latestEval: le === null || le === undefined ? null : (() => {
      if (!isObj(le)) throw new CmsReturnsDtoError('latest_eval')
      return { evalSeq: n(le, 'eval_seq'), kind: s(le, 'kind'), verdict: s(le, 'verdict'), returnsAsOf: sn(le, 'returns_as_of', TS_RE),
        evaluatedAt: s(le, 'evaluated_at', TS_RE), mismatched: nn(le, 'mismatched'), openConflicts: nn(le, 'open_conflicts') }
    })(),
    proof: pr === null || pr === undefined ? null : (() => {
      if (!isObj(pr)) throw new CmsReturnsDtoError('proof')
      const p = { evalSeq: n(pr, 'eval_seq'), openSetHash: s(pr, 'open_set_hash', HEX_RE) }
      if (p.evalSeq < 1) throw new CmsReturnsDtoError('proof.eval_seq')
      return p
    })(),
    open: arr(raw, 'open').map((x) => {
      if (!isObj(x) || !isObj(x.baseline)) throw new CmsReturnsDtoError('open[]')
      const bl = x.baseline
      const obs = x.observations === null || x.observations === undefined ? [] : (x.observations as unknown[])
      if (!Array.isArray(obs)) throw new CmsReturnsDtoError('observations')
      return {
        conflictId: n(x, 'conflict_id'), returnEventId: s(x, 'return_event_id'), openedKind: s(x, 'opened_kind'),
        openedEvalSeq: n(x, 'opened_eval_seq'), openedAt: s(x, 'opened_at', TS_RE),
        baseline: { returnDocumentId: sn(bl, 'return_document_id'), originalOrderLineId: sn(bl, 'original_order_line_id'), productId: sn(bl, 'product_id'),
          baseQuantity: sn(bl, 'base_quantity', DEC_RE), refundAmount: s(bl, 'refund_amount', DEC_RE), recordedAt: sn(bl, 'recorded_at', TS_RE) },
        observations: obs.map((o) => {
          if (!isObj(o)) throw new CmsReturnsDtoError('observations[]')
          return { version: n(o, 'version'), evalSeq: n(o, 'eval_seq'), verdict: s(o, 'verdict'), observed: o.observed ?? null, observedAt: s(o, 'observed_at', TS_RE) }
        }),
      }
    }),
    restorations: arr(raw, 'restorations').map((x) => {
      if (!isObj(x)) throw new CmsReturnsDtoError('restorations[]')
      return { id: s(x, 'id', UUID_RE), proofEvalSeq: n(x, 'proof_eval_seq'), conflicts: n(x, 'conflicts'), reason: s(x, 'reason'), confirmedAt: s(x, 'confirmed_at', TS_RE) }
    }),
  }
}

export const CMS_LEDGER_VERDICT_LABEL: Record<string, string> = {
  CLEAN: 'Sổ khớp', MISMATCH: 'Lệch sổ — giữ số cũ', OPEN_CONFLICT_MATCH: 'Nguồn đã khớp lại — chờ xác nhận',
}
export const CMS_OBSERVATION_LABEL: Record<string, string> = {
  MATCH: 'Khớp baseline', MISSING: 'Phiếu biến mất khỏi nguồn', CHANGED: 'Phiếu đổi nội dung', NOT_EFFECTIVE: 'Phiếu chuyển sang chưa hiệu lực',
}

// ── Báo cáo sau chốt ────────────────────────────────────────────────────────
/** returns_profile của báo cáo: thiếu (DB 130 / 131) ⇒ net_returns_v1; giá trị lạ ⇒ DTO lỗi (fail-closed). */
function profileOf(o: Obj): CmsReturnProfile {
  const v = o.returns_profile
  if (v === undefined || v === null) return 'net_returns_v1'
  if (v === 'net_returns_v1' || v === 'full_line_qty_refund_v1') return v
  throw new CmsReturnsDtoError('returns_profile')
}
export interface CmsCloseReportSummary {
  id: string; payoutRunId: string; evalSeq: number; returnsAsOf: string; frozenAmount: string; recomputedAmount: string; deltaAmount: string
  returnEvents: number; lineCount: number; createdVia: string; createdAt: string
  /** Q-236: full_line_qty_refund_v1 ⇒ lượng trừ = lượng dòng bán có phiếu; net_returns_v1 ⇒ lượng BI (lịch sử). */
  returnsProfile: CmsReturnProfile
  /** 132 r1: người lập (phiên super; cron ⇒ null) + lý do lập tay (chỉ đường ngày 31). DB trước 132 ⇒ null. */
  createdBy: string | null
  createdByName: string | null
  manualReason: string | null
}
/** Người lập / lý do (132 r1); lý do chỉ có ở báo cáo super lập tay — có lý do mà không phải super ⇒ DTO lỗi. */
function authorOf(o: Obj): { createdBy: string | null; createdByName: string | null; manualReason: string | null } {
  const a = { createdBy: sn(o, 'created_by', UUID_RE), createdByName: sn(o, 'created_by_name'), manualReason: sn(o, 'manual_reason') }
  if (a.manualReason !== null && (o.created_via !== 'super' || a.createdBy === null)) throw new CmsReturnsDtoError('manual_reason')
  return a
}
export function parseCmsCloseReports(raw: unknown): { programId: string; reports: CmsCloseReportSummary[] } {
  if (!isObj(raw)) throw new CmsReturnsDtoError('reports')
  return {
    programId: s(raw, 'program_id', UUID_RE),
    reports: arr(raw, 'reports').map((x) => {
      if (!isObj(x)) throw new CmsReturnsDtoError('reports[]')
      return {
        id: s(x, 'id', UUID_RE), payoutRunId: s(x, 'payout_run_id', UUID_RE), evalSeq: n(x, 'eval_seq'), returnsAsOf: s(x, 'returns_as_of', TS_RE),
        frozenAmount: s(x, 'frozen_amount', SINT_RE), recomputedAmount: s(x, 'recomputed_amount', SINT_RE), deltaAmount: s(x, 'delta_amount', SINT_RE),
        returnEvents: n(x, 'return_events'), lineCount: n(x, 'line_count'), createdVia: s(x, 'created_via'), createdAt: s(x, 'created_at', TS_RE),
        returnsProfile: profileOf(x), ...authorOf(x),
      }
    }),
  }
}

export interface CmsCloseReportLine {
  lineNo: number; userId: string; fullName: string | null; programProductId: string; productId: string; gmvBasis: string; perUnit: string
  frozenBase: string; frozenQty: string; frozenGmv: string; frozenGateMet: boolean; frozenAmount: string
  returnBase: string; returnGmv: string; returnEvents: number; eligibleBase: string; netGmv: string; gateMet: boolean
  recomputedQty: string; recomputedAmount: string; delta: string
  /** 132 r1: phần trả ĐÃ TRỪ trong số chốt (run contract); null ⇔ run legacy (số chốt là số bán). */
  frozenReturnBase: string | null; frozenReturnGmv: string | null
}
export interface CmsCloseReportPage {
  report: CmsCloseReportSummary & { programId: string; returnsDigest: string; notAPaymentOrder: true }
  lines: CmsCloseReportLine[]
  nextAfter: number | null
}
export function parseCmsCloseReportPage(raw: unknown): CmsCloseReportPage {
  if (!isObj(raw) || !isObj(raw.report)) throw new CmsReturnsDtoError('report')
  const r = raw.report
  if (r.not_a_payment_order !== true) throw new CmsReturnsDtoError('not_a_payment_order')
  const next = raw.next_after
  if (next !== null && next !== undefined && (typeof next !== 'number' || !Number.isSafeInteger(next) || next < 0)) throw new CmsReturnsDtoError('next_after')
  return {
    report: {
      id: s(r, 'id', UUID_RE), programId: s(r, 'program_id', UUID_RE), payoutRunId: s(r, 'payout_run_id', UUID_RE), evalSeq: n(r, 'eval_seq'),
      returnsAsOf: s(r, 'returns_as_of', TS_RE), returnsDigest: s(r, 'returns_digest', HEX_RE), frozenAmount: s(r, 'frozen_amount', SINT_RE),
      recomputedAmount: s(r, 'recomputed_amount', SINT_RE), deltaAmount: s(r, 'delta_amount', SINT_RE), returnEvents: n(r, 'return_events'),
      lineCount: n(r, 'line_count'), createdVia: s(r, 'created_via'), createdAt: s(r, 'created_at', TS_RE), notAPaymentOrder: true,
      returnsProfile: profileOf(r), ...authorOf(r),
    },
    lines: arr(raw, 'lines').map((x) => {
      if (!isObj(x)) throw new CmsReturnsDtoError('lines[]')
      return {
        lineNo: n(x, 'line_no'), userId: s(x, 'user_id', UUID_RE), fullName: sn(x, 'full_name'), programProductId: s(x, 'program_product_id', UUID_RE),
        productId: s(x, 'product_id'), gmvBasis: s(x, 'gmv_basis'), perUnit: s(x, 'per_unit', DEC_RE), frozenBase: s(x, 'frozen_base', DEC_RE),
        frozenQty: s(x, 'frozen_qty', SINT_RE), frozenGmv: s(x, 'frozen_gmv', DEC_RE), frozenGateMet: b(x, 'frozen_gate_met'), frozenAmount: s(x, 'frozen_amount', SINT_RE),
        returnBase: s(x, 'return_base', DEC_RE), returnGmv: s(x, 'return_gmv', DEC_RE), returnEvents: n(x, 'return_events'), eligibleBase: s(x, 'eligible_base', DEC_RE),
        netGmv: s(x, 'net_gmv', DEC_RE), gateMet: b(x, 'gate_met'), recomputedQty: s(x, 'recomputed_qty', SINT_RE), recomputedAmount: s(x, 'recomputed_amount', SINT_RE),
        delta: s(x, 'delta', SINT_RE), ...frozenReturnOf(x),
      }
    }),
    nextAfter: (next ?? null) as number | null,
  }
}

function frozenReturnOf(x: Obj): { frozenReturnBase: string | null; frozenReturnGmv: string | null } {
  const fb = sn(x, 'frozen_return_base', DEC_RE), fg = sn(x, 'frozen_return_gmv', DEC_RE)
  if ((fb === null) !== (fg === null)) throw new CmsReturnsDtoError('frozen_return')
  return { frozenReturnBase: fb, frozenReturnGmv: fg }
}

/** Báo cáo của run CONTRACT (số chốt đã là số RÒNG): có ít nhất một dòng mang phần trả đã trừ. */
export const cmsCloseReportIsContract = (lines: readonly CmsCloseReportLine[]): boolean => lines.some((l) => l.frozenReturnBase !== null)
/** Câu giải thích khi số chốt là số ròng (run contract): phiếu đã trừ trước chốt không trừ lại. */
export const CMS_CLOSE_REPORT_CONTRACT_NOTE = 'Số đã chốt là số RÒNG (đã trừ phiếu trả tới mốc dữ liệu của lần chốt). Báo cáo tính lại từ số bán gộp đã đóng băng trừ MỌI phiếu hiệu lực — phiếu đã trừ trước chốt không bị trừ lại.'
/** Cách lập báo cáo ⇒ nhãn ngắn. */
export function cmsCloseReportViaLabel(r: Pick<CmsCloseReportSummary, 'createdVia' | 'createdByName' | 'manualReason'>): string {
  if (r.createdVia === 'cron') return 'Tự động (job)'
  if (r.createdVia === 'super') return r.manualReason !== null ? `Lập tay ngày 31${r.createdByName ? ` — ${r.createdByName}` : ''}` : `Super${r.createdByName ? ` — ${r.createdByName}` : ''}`
  return r.createdVia
}

/** Nhãn cột lượng trả theo profile báo cáo (UI + XLSX dùng chung). */
export function cmsCloseReportReturnBaseLabel(p: CmsReturnProfile): string {
  return p === 'full_line_qty_refund_v1' ? 'Lượng trừ theo quy ước CMS' : 'SL cơ sở trả'
}
/** Có hậu tố " (VND)" như cột XLSX hiện có. */
export function cmsCloseReportReturnGmvLabel(p: CmsReturnProfile): string {
  return p === 'full_line_qty_refund_v1' ? 'GMV trừ theo tiền hoàn (VND)' : 'GMV trả (VND)'
}
/** Câu giải thích profile (một dòng, dưới tiêu đề báo cáo). */
export function cmsCloseReportProfileNote(p: CmsReturnProfile): string {
  return p === 'full_line_qty_refund_v1'
    ? 'Phiếu trả hoàn tất trừ đủ lượng của dòng bán được tham chiếu (một lần cho mỗi dòng); GMV trừ theo tiền hoàn thực tế của từng phiếu.'
    : 'Báo cáo theo quy tắc cũ (lượng trả theo nguồn) — chỉ còn để tra cứu.'
}

/** Câu bắt buộc trên màn / XLSX báo cáo sau chốt. */
export const CMS_CLOSE_REPORT_NOTE = 'Báo cáo tham khảo sau chốt: tính lại CMS khi trừ phiếu trả hoàn tất trên số đã chốt. Không phải lệnh thu / chi, không đổi số đã chốt.'
