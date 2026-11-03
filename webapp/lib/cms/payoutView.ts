// CMS P3a — DTO chốt kỳ / chi trả (migration 123: rpc_cms_lock_preview, rpc_cms_program_lock, rpc_cms_payout) + nhãn hiển thị.
// Hàm thuần, không I/O (test: e2e/cms-p3a-unit.spec.ts):
//  · parse*: kiểm shape jsonb; tiền là chuỗi số nguyên (không Number), GMV là chuỗi thập phân; sai shape ⇒ throw
//    CmsPayoutDtoError (server trả mã chung — không hiện 0 giả).
//  · parseCmsPayout kiểm thêm bất biến hiển thị: Σ tiền các dòng = scope_total; super ⇒ program_total = scope_total.
//  · Không tính lại tiền / ngưỡng ở client — preview / chốt / payout đều là số của DB (RPC 123).

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
      mappingChanged: false, sourceCompleteBasis: null, earliestLockAt: null, blockers,
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
  }
  // Run hiện hành ⇒ phải có tiền + staff (do DB tính); thiếu ⇒ DTO hỏng, không hiện 0 giả.
  if (out.runId !== null && (out.amountVnd === null || out.staffRows === null || out.staffPaid === null)) throw new CmsPayoutDtoError('run')
  return out
}

/** Chốt được ngay (không blocker). Lý do vẫn có thể bắt buộc (needsAck). */
export const cmsLockReady = (p: CmsLockPreviewDto): boolean => p.found && p.blockers.length === 0 && p.runId !== null && p.policyVersion !== null

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
    }
    if (sup.staffRows !== rows.length) throw new CmsPayoutDtoError('staff_rows≠rows')
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
  CMS_LOCK_RELEASE_GATE: 'Chưa mở công bố tiền cho chương trình thật (chờ chốt Q-206)',
  CMS_LOCK_NO_RESULT: 'Chưa có kết quả đã công bố để chốt',
  CMS_LOCK_RUN_CHANGED: 'Kết quả vừa được cập nhật — kiểm tra lại trước khi chốt',
  CMS_LOCK_STALE_RUN: 'Kết quả hiện tại không còn khớp cấu hình — cần đồng bộ lại',
  CMS_LOCK_POLICY_CHANGED: 'Quy tắc chốt vừa thay đổi — kiểm tra lại trước khi chốt',
  CMS_LOCK_POLICY_PENDING: 'Quy tắc chốt cho chương trình thật chưa được chốt (Q-213 / Q-216)',
  CMS_LOCK_RUN_TOO_EARLY: 'Lần tính hiện tại bắt đầu trước khi kỳ kết thúc — cần đồng bộ lại sau ngày kết thúc',
  CMS_LOCK_SOURCE_INCOMPLETE: 'Chưa có xác nhận nguồn bán đã đủ tới hết kỳ',
  CMS_LOCK_STALE_MAPPING: 'Dữ liệu dược sĩ / nhà thuốc đã đổi sau lần tính — cần đồng bộ lại',
  CMS_LOCK_TOTAL_MISMATCH: 'Tổng tiền không khớp dữ liệu đã tính — cần kiểm tra',
  CMS_LOCK_POLICY_DATA: 'Số liệu dòng chưa gán không hợp lệ — cần kiểm tra',
  CMS_LOCK_UNASSIGNED_OVER: 'Dòng chưa gán vượt ngưỡng cho phép — xử lý mapping trước khi chốt',
  CMS_LOCK_ACK_REQUIRED: 'Cần nhập lý do xác nhận (10–1.000 ký tự) cho các dòng chưa gán',
  CMS_LOCK_BAD_INPUT: 'Yêu cầu chốt không hợp lệ',
  CMS_ISOLATION: 'Phiên cơ sở dữ liệu không hợp lệ — thử lại',
}
export const cmsLockCodeLabel = (code: string): string => CMS_LOCK_CODE_LABEL[code] ?? `Không chốt được (${code})`

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
