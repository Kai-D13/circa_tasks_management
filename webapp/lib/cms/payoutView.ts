// CMS P3a — DTO chốt kỳ / chi trả (migration 123: rpc_cms_lock_preview, rpc_cms_program_lock, rpc_cms_payout) + nhãn hiển thị.
// Hàm thuần, không I/O (test: e2e/cms-p3a-unit.spec.ts):
//  · parse*: kiểm shape jsonb; tiền là chuỗi số nguyên (không Number), GMV là chuỗi thập phân; sai shape ⇒ throw
//    CmsPayoutDtoError (server trả mã chung — không hiện 0 giả).
//  · parseCmsPayout kiểm thêm bất biến hiển thị: Σ tiền các dòng = scope_total; super ⇒ program_total = scope_total.
//  · Không tính lại tiền / ngưỡng ở client — preview / chốt / payout đều là số của DB (RPC 123).
//  · 124 (COMP-INT): preview có `source_attestation` (chứng nhận đối soát nguồn decision10 của run hiện hành, DB kiểm lại tại lúc
//    gọi); payout super có id + tóm tắt chứng nhận đã dùng. DB trước 124 không có các khoá này ⇒ 'unsupported' / null (app mới
//    chạy được trên DB cũ — không gửi p_expected_attestation_id).

export class CmsPayoutDtoError extends Error {
  constructor(detail: string) {
    super(`CMS chi trả không hợp lệ: ${detail}`)
    this.name = 'CmsPayoutDtoError'
  }
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const INT_RE = /^(0|[1-9][0-9]{0,18})$/
const DEC_RE = /^-?[0-9]{1,35}(\.[0-9]{1,9})?$/
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const FP_RE = /^[0-9a-f]{32}$/
const CODE_RE = /^CMS_[A-Z0-9_]{1,60}$/

function str(o: Obj, k: string, re?: RegExp): string {
  const v = o[k]
  if (typeof v !== 'string' || (re && !re.test(v))) throw new CmsPayoutDtoError(k)
  return v
}
function strN(o: Obj, k: string, re?: RegExp): string | null {
  return o[k] === null || o[k] === undefined ? null : str(o, k, re)
}
function bool(o: Obj, k: string): boolean {
  if (typeof o[k] !== 'boolean') throw new CmsPayoutDtoError(k)
  return o[k] as boolean
}
function int(o: Obj, k: string): number {
  const v = o[k]
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new CmsPayoutDtoError(k)
  return v
}
function intN(o: Obj, k: string): number | null {
  return o[k] === null || o[k] === undefined ? null : int(o, k)
}
function objN(o: Obj, k: string): Obj | null {
  if (o[k] === null || o[k] === undefined) return null
  if (!isObj(o[k])) throw new CmsPayoutDtoError(k)
  return o[k] as Obj
}

// ── Policy (cms__lock_policy nhánh áp dụng) ─────────────────────────────────
export interface CmsLockPolicyDto {
  /** 'QA_ONLY_ASSUMPTION' với chương trình QA; null với nhánh thật (pending). */
  label: string | null
  ready: boolean | null
  pending: string[]
  unassignedMaxGmvBp: number | null
  unassignedMaxLines: number | null
  waitHours: number | null
  completeness: string | null
}
function parsePolicy(raw: Obj | null): CmsLockPolicyDto {
  const p = raw ?? {}
  const num = (k: string) => (typeof p[k] === 'number' && Number.isSafeInteger(p[k]) && (p[k] as number) >= 0 ? (p[k] as number) : null)
  return {
    label: typeof p.label === 'string' ? p.label : null,
    ready: typeof p.ready === 'boolean' ? p.ready : null,
    pending: Array.isArray(p.pending) ? p.pending.filter((x): x is string => typeof x === 'string') : [],
    unassignedMaxGmvBp: num('unassigned_max_gmv_bp'),
    unassignedMaxLines: num('unassigned_max_lines'),
    waitHours: num('wait_hours'),
    completeness: typeof p.completeness === 'string' ? p.completeness : null,
  }
}

// ── Chứng nhận đối soát nguồn (124) ─────────────────────────────────────────
/** Trạng thái chứng nhận của run hiện hành trong preview. Mã `invalid` do DB tính lại (cấu hình / mapping / scope / lớp nguồn / vân tay). */
export type CmsSourceAttestationState =
  | { state: 'unsupported' }
  | { state: 'none' }
  | { state: 'valid'; id: string; scopeTo: string; asOf: string; attestedAt: string }
  | { state: 'invalid'; id: string; code: string }
const ATTEST_CODE_RE = /^[A-Z][A-Z0-9_]{1,40}$/
function parseAttestationState(raw: Obj): CmsSourceAttestationState {
  if (!('source_attestation' in raw)) return { state: 'unsupported' }
  const a = raw.source_attestation
  if (!isObj(a)) throw new CmsPayoutDtoError('source_attestation')
  if (a.code === 'NONE' && (a.id === undefined || a.id === null)) return { state: 'none' }
  const id = str(a, 'id', UUID_RE)
  if (a.code === null) return { state: 'valid', id, scopeTo: str(a, 'scope_to', DATE_RE), asOf: str(a, 'as_of', TS_RE), attestedAt: str(a, 'attested_at', TS_RE) }
  return { state: 'invalid', id, code: str(a, 'code', ATTEST_CODE_RE) }
}

// ── Preview chốt (rpc_cms_lock_preview — service_role, server đã kiểm super + cờ) ─────
export interface CmsLockPreviewDto {
  programId: string
  found: boolean
  status: 'draft' | 'active' | 'locked' | null
  isTest: boolean | null
  endDate: string | null
  configVersion: number | null
  runId: string | null
  runStartedAt: string | null
  amountVnd: string | null
  resultsAmountVnd: string | null
  staffRows: number | null
  staffPaid: number | null
  candidateLines: number
  candidateGmv: string
  unassignedLines: number
  unassignedGmv: string
  unassignedOver: boolean
  needsAck: boolean
  policy: CmsLockPolicyDto
  policyVersion: number | null
  mappingChanged: boolean
  sourceCompleteBasis: string | null
  earliestLockAt: string | null
  blockers: string[]
  /** 124: chứng nhận đối soát nguồn của run hiện hành ('unsupported' = DB trước 124). */
  sourceAttestation: CmsSourceAttestationState
}

export function parseCmsLockPreview(raw: unknown): CmsLockPreviewDto {
  if (!isObj(raw)) throw new CmsPayoutDtoError('preview')
  const programId = str(raw, 'program_id', UUID_RE)
  const blockersRaw = raw.blockers
  if (!Array.isArray(blockersRaw) || !blockersRaw.every((x) => typeof x === 'string' && CODE_RE.test(x))) throw new CmsPayoutDtoError('blockers')
  const blockers = blockersRaw as string[]
  if (raw.found === false) {
    return {
      programId, found: false, status: null, isTest: null, endDate: null, configVersion: null, runId: null, runStartedAt: null,
      amountVnd: null, resultsAmountVnd: null, staffRows: null, staffPaid: null, candidateLines: 0, candidateGmv: '0',
      unassignedLines: 0, unassignedGmv: '0', unassignedOver: false, needsAck: false, policy: parsePolicy(null), policyVersion: null,
      mappingChanged: false, sourceCompleteBasis: null, earliestLockAt: null, blockers, sourceAttestation: { state: 'unsupported' },
    }
  }
  if (raw.found !== true) throw new CmsPayoutDtoError('found')
  const status = raw.status
  if (status !== 'draft' && status !== 'active' && status !== 'locked') throw new CmsPayoutDtoError('status')
  const fpRun = strN(raw, 'mapping_fp_run', FP_RE)
  const fpNow = strN(raw, 'mapping_fp_now', FP_RE)
  const out: CmsLockPreviewDto = {
    programId, found: true, status, isTest: bool(raw, 'is_test'),
    endDate: str(raw, 'end_date', DATE_RE),
    configVersion: int(raw, 'config_version'),
    runId: strN(raw, 'run_id', UUID_RE),
    runStartedAt: strN(raw, 'run_started_at', TS_RE),
    amountVnd: strN(raw, 'amount_vnd', INT_RE),
    resultsAmountVnd: strN(raw, 'results_amount_vnd', DEC_RE),
    staffRows: intN(raw, 'staff_rows'),
    staffPaid: intN(raw, 'staff_paid'),
    candidateLines: int(raw, 'candidate_lines'),
    candidateGmv: str(raw, 'candidate_gmv', DEC_RE),
    unassignedLines: int(raw, 'unassigned_lines'),
    unassignedGmv: str(raw, 'unassigned_gmv', DEC_RE),
    unassignedOver: bool(raw, 'unassigned_over'),
    needsAck: bool(raw, 'needs_ack'),
    policy: parsePolicy(objN(raw, 'policy')),
    policyVersion: int(raw, 'policy_version'),
    mappingChanged: fpRun !== null && fpNow !== null && fpRun !== fpNow,
    sourceCompleteBasis: strN(raw, 'source_complete_basis'),
    earliestLockAt: strN(raw, 'earliest_lock_at', TS_RE),
    blockers,
    sourceAttestation: parseAttestationState(raw),
  }
  // basis operator_reconciliation chỉ có khi DB dùng chứng nhận hợp lệ — lệch ⇒ DTO hỏng (không đoán).
  if (out.sourceCompleteBasis === 'operator_reconciliation' && out.sourceAttestation.state !== 'valid') throw new CmsPayoutDtoError('source_attestation≠basis')
  // Run hiện hành ⇒ phải có tiền + staff (do DB tính); thiếu ⇒ DTO hỏng, không hiện 0 giả.
  if (out.runId !== null && (out.amountVnd === null || out.staffRows === null || out.staffPaid === null)) throw new CmsPayoutDtoError('run')
  return out
}

/** Chốt được ngay (không blocker). Lý do vẫn có thể bắt buộc (needsAck). */
export const cmsLockReady = (p: CmsLockPreviewDto): boolean => p.found && p.blockers.length === 0 && p.runId !== null && p.policyVersion !== null

/**
 * Id chứng nhận gửi kèm lệnh chốt (lock 6 tham số): chỉ khi preview chốt BẰNG chứng nhận (basis operator_reconciliation) ⇒ id
 * preview đã thấy (DB đổi / thu hồi giữa chừng ⇒ CMS_LOCK_EVIDENCE_CHANGED). DB trước 124 ('unsupported') ⇒ undefined: KHÔNG gửi
 * tham số (lock 5 tham số). Còn lại null (DB mặc định NULL — chốt không chứng nhận).
 */
export function cmsLockExpectedAttestation(p: CmsLockPreviewDto): string | null | undefined {
  if (p.sourceAttestation.state === 'unsupported') return undefined
  return p.sourceCompleteBasis === 'operator_reconciliation' && p.sourceAttestation.state === 'valid' ? p.sourceAttestation.id : null
}

// ── Payout (rpc_cms_payout — session, phạm vi HIỆN TẠI theo Q-208 / Q-217) ─────
export type CmsPayoutViewer = 'super' | 'sm' | 'store_manager' | 'staff' | 'admin' | null
export interface CmsPayoutRowDto {
  userId: string
  storeId: string
  name: string | null
  storeName: string | null
  amountVnd: string
  productsWithCms: number
  /** Chỉ super (DB không trả khoá này cho vai khác). */
  email: string | null
}
export interface CmsPayoutSuperDto {
  lockedBy: string
  staffRows: number
  staffPaid: number
  candidateLines: number
  candidateGmv: string
  unassignedLines: number
  unassignedGmv: string
  ackReason: string | null
  policy: CmsLockPolicyDto
  sourceCompleteBasis: string
  sourceCompleteThrough: string | null
  runStartedAt: string
  /** 124: id chứng nhận đã dùng chốt (basis operator_reconciliation); null = chốt không chứng nhận / DB trước 124. */
  sourceAttestationId: string | null
  /** 124: tóm tắt chứng nhận (không actor / email / hash file). */
  sourceAttestation: { fieldSet: string; asOf: string; referenceLabel: string; linesCompared: number; attestedAt: string; runRowsFp: string } | null
}
export interface CmsPayoutDto {
  programId: string
  runId: string
  isTest: boolean
  lockedAt: string
  policyVersion: number
  viewer: CmsPayoutViewer
  /** Chỉ super; vai khác null. */
  programTotal: string | null
  scopeTotal: string
  rows: CmsPayoutRowDto[]
  super: CmsPayoutSuperDto | null
}

export function parseCmsPayout(raw: unknown): CmsPayoutDto {
  if (!isObj(raw)) throw new CmsPayoutDtoError('payout')
  const viewer = raw.viewer
  if (viewer !== null && !['super', 'sm', 'store_manager', 'staff', 'admin'].includes(viewer as string)) throw new CmsPayoutDtoError('viewer')
  const isSuper = viewer === 'super'
  const rowsRaw = raw.rows
  if (!Array.isArray(rowsRaw)) throw new CmsPayoutDtoError('rows')
  const rows: CmsPayoutRowDto[] = rowsRaw.map((r, i) => {
    if (!isObj(r)) throw new CmsPayoutDtoError(`rows[${i}]`)
    if (!isSuper && 'email' in r) throw new CmsPayoutDtoError(`rows[${i}].email`) // email chỉ super
    return {
      userId: str(r, 'user_id', UUID_RE), storeId: str(r, 'store_id', UUID_RE), name: strN(r, 'name'), storeName: strN(r, 'store_name'),
      amountVnd: str(r, 'amount_vnd', INT_RE), productsWithCms: int(r, 'products_with_cms'), email: isSuper ? strN(r, 'email') : null,
    }
  })
  const scopeTotal = str(raw, 'scope_total', INT_RE)
  const programTotal = strN(raw, 'program_total', INT_RE)
  if (!isSuper && programTotal !== null) throw new CmsPayoutDtoError('program_total') // tổng toàn chương trình chỉ super
  const sum = rows.reduce((a, r) => a + BigInt(r.amountVnd), BigInt(0))
  if (sum !== BigInt(scopeTotal)) throw new CmsPayoutDtoError('scope_total≠Σ')
  if (isSuper && programTotal !== scopeTotal) throw new CmsPayoutDtoError('program_total≠scope_total')
  let sup: CmsPayoutSuperDto | null = null
  if (isSuper) {
    sup = {
      lockedBy: str(raw, 'locked_by', UUID_RE), staffRows: int(raw, 'staff_rows'), staffPaid: int(raw, 'staff_paid'),
      candidateLines: int(raw, 'candidate_lines'), candidateGmv: str(raw, 'candidate_gmv', DEC_RE),
      unassignedLines: int(raw, 'unassigned_lines'), unassignedGmv: str(raw, 'unassigned_gmv', DEC_RE),
      ackReason: strN(raw, 'ack_reason'), policy: parsePolicy(objN(raw, 'policy')),
      sourceCompleteBasis: str(raw, 'source_complete_basis'), sourceCompleteThrough: strN(raw, 'source_complete_through', DATE_RE),
      runStartedAt: str(raw, 'run_started_at', TS_RE),
      sourceAttestationId: strN(raw, 'source_attestation_id', UUID_RE),
      sourceAttestation: null,
    }
    const att = objN(raw, 'source_attestation')
    if (att) {
      sup.sourceAttestation = {
        fieldSet: str(att, 'field_set', /^decision10$/), asOf: str(att, 'as_of', TS_RE), referenceLabel: str(att, 'reference_label'),
        linesCompared: int(att, 'lines_compared'), attestedAt: str(att, 'attested_at', TS_RE), runRowsFp: str(att, 'run_rows_fp', /^[0-9a-f]{64}$/),
      }
    }
    if (sup.staffRows !== rows.length) throw new CmsPayoutDtoError('staff_rows≠rows')
    // basis operator_reconciliation ⇔ có id + tóm tắt chứng nhận (CHECK DB 124); DB trước 124 không có khoá ⇒ bỏ qua.
    if ('source_attestation_id' in raw && ((sup.sourceCompleteBasis === 'operator_reconciliation') !== (sup.sourceAttestationId !== null)
        || (sup.sourceAttestationId !== null) !== (sup.sourceAttestation !== null))) throw new CmsPayoutDtoError('source_attestation')
  }
  return {
    programId: str(raw, 'program_id', UUID_RE), runId: str(raw, 'run_id', UUID_RE), isTest: bool(raw, 'is_test'),
    lockedAt: str(raw, 'locked_at', TS_RE), policyVersion: int(raw, 'policy_version'), viewer: viewer as CmsPayoutViewer,
    programTotal, scopeTotal, rows, super: sup,
  }
}

// ── Nhãn ─────────────────────────────────────────────────────────────────────
/** Blocker của preview / lỗi của RPC chốt (mã DB) ⇒ câu cho super. Mã lạ ⇒ câu chung, kèm mã. */
export const CMS_LOCK_CODE_LABEL: Record<string, string> = {
  CMS_PROGRAM_NOT_FOUND: 'Không tìm thấy chương trình',
  CMS_PROGRAM_LOCKED: 'Chương trình đã chốt kỳ',
  CMS_LOCK_NOT_ENDED: 'Chương trình chưa kết thúc (chốt sau ngày kết thúc)',
  CMS_LOCK_RELEASE_GATE: 'Chưa mở cổng công bố kết quả cho chương trình thật (DB chưa áp migration 126)',
  CMS_LOCK_NO_RESULT: 'Chưa có kết quả đã công bố để chốt',
  CMS_LOCK_RUN_CHANGED: 'Kết quả vừa được cập nhật — kiểm tra lại trước khi chốt',
  CMS_LOCK_STALE_RUN: 'Kết quả hiện tại không còn khớp cấu hình — cần đồng bộ lại',
  CMS_LOCK_POLICY_CHANGED: 'Quy tắc chốt vừa thay đổi — kiểm tra lại trước khi chốt',
  CMS_LOCK_POLICY_PENDING: 'Quy tắc chốt cho chương trình thật chưa được chốt (Q-213 / Q-216)',
  CMS_LOCK_RUN_TOO_EARLY: 'Lần tính hiện tại bắt đầu trước khi kỳ kết thúc — cần đồng bộ lại sau ngày kết thúc',
  CMS_LOCK_SOURCE_INCOMPLETE: 'Chưa có xác nhận nguồn bán đã đủ tới hết kỳ',
  CMS_LOCK_ATTEST_INVALID: 'Chứng nhận đối soát nguồn không còn khớp lần tính hiện tại — cần đối soát và chứng nhận lại',
  CMS_LOCK_EVIDENCE_CHANGED: 'Chứng nhận đối soát nguồn vừa thay đổi — kiểm tra lại trước khi chốt',
  CMS_LOCK_STALE_MAPPING: 'Dữ liệu dược sĩ / nhà thuốc đã đổi sau lần tính — cần đồng bộ lại',
  CMS_LOCK_TOTAL_MISMATCH: 'Tổng tiền không khớp dữ liệu đã tính — cần kiểm tra',
  CMS_LOCK_POLICY_DATA: 'Số liệu dòng chưa gán không hợp lệ — cần kiểm tra',
  CMS_LOCK_UNASSIGNED_OVER: 'Dòng chưa gán vượt ngưỡng cho phép — xử lý mapping trước khi chốt',
  CMS_LOCK_ACK_REQUIRED: 'Cần nhập lý do xác nhận (10–1.000 ký tự) cho các dòng chưa gán',
  CMS_LOCK_BAD_INPUT: 'Yêu cầu chốt không hợp lệ',
  CMS_ISOLATION: 'Phiên cơ sở dữ liệu không hợp lệ — thử lại',
}
export const cmsLockCodeLabel = (code: string): string => CMS_LOCK_CODE_LABEL[code] ?? `Không chốt được (${code})`

/** Cơ sở "nguồn đầy đủ" (payout / preview) ⇒ nhãn. */
export function cmsSourceBasisLabel(basis: string | null): string {
  if (basis === 'qa_assumption') return 'Giả định QA (không phải xác nhận nguồn thật)'
  if (basis === 'operator_reconciliation') return 'Đối soát nguồn độc lập (chứng nhận decision10)'
  if (basis === 'bi_watermark') return 'Mốc dữ liệu BI'
  if (basis === 'lag_commitment') return 'Cam kết độ trễ nguồn'
  return basis ?? '—'
}

/** Lý do chứng nhận không dùng được (mã DB cms__attest_eval) ⇒ câu cho super. */
export const CMS_ATTEST_STATE_LABEL: Record<string, string> = {
  STALE_CONFIG: 'cấu hình chương trình đã đổi sau chứng nhận',
  STALE_MAPPING: 'dữ liệu dược sĩ / nhà thuốc đã đổi sau chứng nhận',
  STALE_SCOPE: 'kỳ / danh mục sản phẩm đã đổi sau chứng nhận',
  FP_CHANGED: 'dữ liệu nguồn của lần tính đã khác lúc chứng nhận',
  AS_OF: 'mốc dữ liệu đối soát trước khi kỳ kết thúc',
  COUNT: 'số dòng đã đối soát khác lớp nguồn của lần tính',
  SOURCE_REJECTED: 'lần tính có dòng nguồn bị từ chối (không coi là đủ)',
  FIELD_SET: 'chứng nhận không dùng bộ trường quyết định (decision10)',
  SOURCE_COUNT: 'lớp nguồn của lần tính thiếu / thừa dòng',
  SOURCE_SCOPE: 'lớp nguồn có dòng ngoài kỳ / sản phẩm',
  SOURCE_ENGINE_MISMATCH: 'lớp nguồn không khớp dữ liệu đã tính',
  SOURCE_ELIGIBLE_MISMATCH: 'số dòng đủ điều kiện của lớp nguồn khác dữ liệu đã tính',
  LEGACY_RUN: 'lần tính cũ không có lớp nguồn',
  NOT_SEALED: 'lần tính chưa hoàn tất',
  RUN_GONE: 'dữ liệu lần tính đã được dọn',
  RUN_NOT_FOUND: 'không tìm thấy lần tính',
}
export const cmsAttestStateLabel = (code: string): string => CMS_ATTEST_STATE_LABEL[code] ?? `chứng nhận không dùng được (${code})`

/** Kết quả action chốt — mã cố định cho UI / test (không message DB thô). */
export type CmsLockActionCode =
  | 'LOCK_DISABLED' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'UNAVAILABLE' | 'NOT_FOUND' | 'BAD_INPUT'
  | 'BUSY' | 'UNKNOWN_OUTCOME' | 'QUERY_FAILED' | string

export const CMS_LOCK_ACTION_LABEL: Record<string, string> = {
  LOCK_DISABLED: 'Tính năng chốt kỳ chưa được bật',
  UNAUTHENTICATED: 'Phiên đăng nhập đã hết hạn',
  FORBIDDEN: 'Chỉ super admin được chốt kỳ',
  UNAVAILABLE: 'Không kiểm tra được quyền — thử lại sau',
  NOT_FOUND: 'Không tìm thấy chương trình',
  BAD_INPUT: 'Yêu cầu chốt không hợp lệ',
  BUSY: 'Chương trình đang được cập nhật — thử lại sau ít phút',
  UNKNOWN_OUTCOME: 'Chưa xác định được kết quả chốt — tải lại trang để kiểm tra trước khi thử lại',
  QUERY_FAILED: 'Không tải được dữ liệu chốt kỳ — thử lại',
  QA_SERVER_READONLY: 'Server QA chỉ đọc — chốt chương trình QA bằng công cụ có sổ (cms-qa-results.mjs lock), không bấm trên giao diện',
}
export const cmsLockActionLabel = (code: string): string => CMS_LOCK_ACTION_LABEL[code] ?? cmsLockCodeLabel(code)

/** Lý do xác nhận: cắt khoảng trắng ASCII như DB (btrim E' \t\r\n\f\v'); hợp lệ khi 10–1.000 ký tự sau cắt. */
export function cmsNormalizeAck(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const t = raw.replace(/^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g, '')
  return t.length >= 10 && t.length <= 1000 ? t : null
}

/** Tỷ lệ GMV chưa gán (điểm cơ bản, 2 chữ số thập phân) — chỉ để hiển thị; ngưỡng do DB quyết. */
export function cmsUnassignedRatioText(unassignedGmv: string, candidateGmv: string): string {
  const scale = (s: string) => {
    const [i, f = ''] = s.replace(/^-/, '').split('.')
    return BigInt(i + f.padEnd(9, '0').slice(0, 9))
  }
  const num = scale(unassignedGmv), den = scale(candidateGmv)
  if (den === BigInt(0)) return num === BigInt(0) ? '0%' : '—'
  const bp100 = (num * BigInt(1000000)) / den // % × 10⁴
  const whole = bp100 / BigInt(10000), frac = (bp100 % BigInt(10000)) / BigInt(100)
  return `${whole},${String(frac).padStart(2, '0')}%`
}
