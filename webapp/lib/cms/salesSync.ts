// CMS P2-b — lõi đồng bộ bán + tính + công bố MỘT chương trình (kế hoạch PM 02/11 §5; docs/cms/SPEC.md §5–§6).
// Thuần: mọi I/O qua deps tiêm vào; dùng CHUNG cho cron /api/cron/sync-cms-sales và script operator
// scripts/cms-sales-sync.mjs (dry-run mặc định). Luồng (fail-closed, KHÔNG giữ transaction DB khi gọi BigQuery):
//   open (khoá + chụp cấu hình / mapping, trả snapshot) → đọc TOÀN KỲ đủ trang → chất lượng (trùng / lỗi dòng / chưa quy đổi /
//   rỗng sau dữ liệu / chưa gán > 20 %) → engine P2-a (KHÔNG tính lại ở đây) → kiểm miền số → dòng âm / điều chỉnh của chương trình
//   thật ⇒ held RETURNS_NOT_SUPPORTED_THIS_PHASE (trả hàng chưa triển khai — PM 06/11 sales-only §4.2) → cổng công bố kết quả
//   (releaseGate: SALES_ONLY_V1 từ 126; chế độ HOLD ⇒ chương trình thật dừng, lượt ghi còn bị chặn TRƯỚC open bằng snapshot chỉ đọc)
//   → stage theo khối có số → seal (begin + từng bước, DB đối chiếu độc lập) → publish (đổi pointer một lần; DB 126 kiểm lại cổng +
//   dòng điều chỉnh, đóng dấu results_basis) → dọn run cũ ở mọi nhánh đã mở run (best effort, có ngân sách).
// Nguồn 'qa' (writer QA / harness) CHỈ ghi chương trình is_test: kiểm bằng snapshot chỉ đọc TRƯỚC open và lại sau open ⇒ chương trình
//   thật bị từ chối held QA_SOURCE_REAL_PROGRAM với 0 run / 0 ghi (kể cả khi cổng kết quả thật đã mở).
// LỚP NGUỒN (migration 124, PM COMP-INT §5.A): opts.sourceCapture (cờ CMS_SOURCE_CAPTURE_ENABLED, mặc định OFF) ⇒ ngay sau mở run
//   đòi snapshot.sourceSchema = CMS_SOURCE_SCHEMA_SUPPORTED (giá trị THỰC DB trả) — thiếu / lạ ⇒ đóng run error
//   SOURCE_SCHEMA_UNSUPPORTED TRƯỚC khi đọc nguồn (không stage / publish, không tự hạ cấp thành run thiếu nguồn). Hỗ trợ ⇒ stage
//   part 'source_lines' = MỌI dòng hợp lệ đã đọc (kể cả ONLINE / chưa hoàn tất / không gán) SAU 4 part engine, TRƯỚC seal. OFF ⇒
//   không gửi 'source_lines' (run sau 124 không chứng nhận được — SOURCE_COUNT ở DB).
// NGÂN SÁCH (PM audit 03/11 P1-I2-1): `deadlineAt` là hạn cứng của cả chương trình. Mọi bước MỚI (đọc nguồn, khối stage,
// seal begin / bước, publish) chỉ bắt đầu khi còn ≥ CMS_RPC_START_MIN_MS trước `deadlineAt − CMS_SALES_STOP_RESERVE_MS`;
// phần dự phòng dành cho đóng run (finish). Mỗi RPC nhận timeout = min(60 s, thời gian còn lại). Hết ngân sách ⇒ held
// DEADLINE (đóng run, giữ pointer); RPC bị huỷ do hết giờ (không mã CMS_*) cũng là DEADLINE, không phải lỗi. Publish:
// DB trả mã CMS_* = từ chối xác định (transaction rollback) ⇒ báo đúng mã; mất phản hồi (không mã) ⇒ gọi lại một lần
// (idempotent); vẫn không rõ ⇒ PUBLISH_UNKNOWN, KHÔNG đóng run / không báo held / rollback (DB có thể đã commit — lượt sau
// đối soát). elapsedMs tính SAU cleanup.
// Mọi lỗi giữ pointer cũ (không công bố 0 thay dữ liệu lỗi). Đóng run thất bại KHÔNG bị nuốt ⇒ CLOSE_FAILED + cause.
// Kết quả / log chỉ số đếm + mã cố định — không email, không giá trị dòng, không message thô của nguồn.

import { createHash } from 'node:crypto'
import { computeCmsProgram, CmsEngineInputError } from './engine/compute'
import { CmsEngineConfigError, parseCmsEngineProgram } from './engine/config'
import { assessSalesSnapshot, findDuplicates } from './quality'
import {
  cmsAdjustmentBlocksRelease, cmsCanPublishResults, CMS_RESULTS_RELEASE_MODE, CMS_RETURNS_NOT_SUPPORTED, type CmsResultsReleaseMode,
} from './releaseGate'
import {
  buildCmsSourceStageRows, buildCmsStagePayload, chunkCmsStageRows, cmsSnapshotToEngineInput, cmsStageBoundsIssue, parseCmsSalesSnapshot,
  CMS_SOURCE_PART, CMS_SOURCE_SCHEMA_SUPPORTED, CMS_STAGE_CHUNK_DEFAULT, CMS_STAGE_PARTS,
  type CmsAnyStagePart, type CmsSalesSnapshot, type CmsStageExpect, type CmsStageRow,
} from './resultStage'
import { CMS_BQ_DEFAULT_DEADLINE_MS, fetchCmsSalesSnapshot, type CmsBqRunner } from './source/bigquery'
import { vnProgramWindowMicros } from './time'

/** Ngân sách tối thiểu còn lại để bắt đầu MỘT chương trình (đọc nguồn + stage). */
export const CMS_SALES_MIN_PROGRAM_MS = 30_000
/** Dự phòng cuối ngân sách chỉ để đóng run (finish) — không bắt đầu bước mới trong khoảng này. */
export const CMS_SALES_STOP_RESERVE_MS = 15_000
/**
 * Một RPC làm việc (stage / seal / publish) hoặc một lô cleanup chỉ BẮT ĐẦU khi còn ít nhất khoảng này trước mốc của nó:
 * statement_timeout PostgREST 8 s + mạng — RPC hợp lệ chạy hết, app không tự huỷ giữa chừng vì timeout kẹp quá ngắn.
 */
export const CMS_RPC_START_MIN_MS = 10_000
/** Timeout tối đa / tối thiểu của một RPC (timeout thực = min(tối đa, thời gian còn lại), không dưới tối thiểu). */
export const CMS_RPC_TIMEOUT_MAX_MS = 60_000
export const CMS_RPC_TIMEOUT_MIN_MS = 1_000
/** Cleanup theo lô: số dòng / lần gọi (≤ trần 100.000 của RPC) và số lần gọi tối đa / lượt. */
export const CMS_CLEANUP_BATCH_ROWS = 50_000
export const CMS_CLEANUP_MAX_CALLS = 20
/** Số bước seal của migration 122 (rpc_cms_sales_run_seal_step 1…10). */
export const CMS_SEAL_STEPS = 10

export type CmsSalesRunDetail = Record<string, string | number | boolean | null>
/** Tuỳ chọn I/O của một RPC: timeout tính từ ngân sách còn lại — số NGUYÊN ms dương (AbortSignal.timeout từ chối số lẻ). */
export interface CmsIo { timeoutMs: number }
export type CmsSealReply = { ok?: boolean; sealed?: boolean; status?: string; code?: string; already?: boolean }

export interface CmsSalesSyncDeps {
  /** View dòng bán đã validate (lib/cms/config.ts); null = chưa cấu hình. */
  table: string | null
  runner: CmsBqRunner
  /** rpc_cms_sales_snapshot — CHỈ ĐỌC (dry-run). */
  loadSnapshot(programId: string, io: CmsIo): Promise<unknown>
  /** rpc_cms_sales_run_open — throw Error(<mã CMS_*>) khi bận / không đủ điều kiện. */
  openRun(programId: string, detail: CmsSalesRunDetail, io: CmsIo): Promise<unknown>
  stage(runId: string, part: CmsAnyStagePart, chunkNo: number, rows: CmsStageRow[], io: CmsIo): Promise<number>
  sealBegin(runId: string, expect: CmsStageExpect, io: CmsIo): Promise<CmsSealReply>
  sealStep(runId: string, step: number, io: CmsIo): Promise<CmsSealReply>
  publish(runId: string, io: CmsIo): Promise<{ published: boolean; already?: boolean; code?: string }>
  finish(runId: string, status: 'held' | 'error', detail: CmsSalesRunDetail, io: CmsIo): Promise<void>
  /** Một lô rpc_cms_sales_run_cleanup. */
  cleanup(programId: string, maxRows: number, io: CmsIo): Promise<{ purged: number; deleted: number; more: boolean }>
  now(): number
}

export type CmsSalesSyncStatus = 'published' | 'dry_run' | 'held' | 'error' | 'busy' | 'skipped' | 'config_missing'

export interface CmsCleanupOutcome {
  purged: number
  /** Còn run cần dọn (lượt sau tiếp tục) — theo dõi retention. */
  more: boolean
  calls: number
  /** done = hết việc; budget = hết ngân sách; max_calls = chạm số lần tối đa; failed = RPC lỗi. */
  stoppedBy: 'done' | 'budget' | 'max_calls' | 'failed'
}

export interface CmsSalesSyncResult {
  programId: string
  status: CmsSalesSyncStatus
  /** Mã cố định (in hoa); null khi published / dry-run sạch. */
  code: string | null
  /** Mọi lý do held chất lượng (assessSalesSnapshot), theo thứ tự. */
  reasons: string[]
  runId: string | null
  isTest: boolean | null
  rowsRead: number | null
  rowsRejected: number | null
  candidates: number | null
  included: number | null
  unassigned: number | null
  outOfScope: number | null
  /** Tổng CMS của snapshot (chuỗi VND nguyên); null khi chưa tính tới. */
  amountVnd: string | null
  stagedRows: number
  /** Số dòng lớp nguồn đã stage (capture bật + run hỗ trợ); null = không capture. */
  sourceRows: number | null
  bytesProcessed: number | null
  /** sha256 của payload kết quả (so hai dry-run trên cùng snapshot nguồn). */
  resultHash: string | null
  /** Toàn bộ thời gian của lượt chương trình, GỒM cleanup. */
  elapsedMs: number
  /** Đóng run thất bại: kết quả dự định trước bước đóng (status = 'error', code = 'CLOSE_FAILED'). */
  cause: { status: 'held' | 'error'; code: string } | null
  cleanup: CmsCleanupOutcome | null
}

/** Mã mở run không phải lỗi hệ thống: chương trình chưa / không còn đủ điều kiện tính. */
const SKIP_CODES = new Set(['CMS_SALES_NOT_STARTED', 'CMS_SALES_PROGRAM_NOT_ACTIVE', 'CMS_PROGRAM_LOCKED', 'CMS_PROGRAM_NOT_FOUND'])

/** Lấy mã CMS_* từ lỗi deps (deps thật chỉ ném Error(mã)); khác ⇒ fallback. */
export function cmsRpcCode(e: unknown, fallback: string): string {
  const m = /\bCMS_[A-Z0-9_]+\b/.exec(String((e as Error)?.message ?? ''))
  return m ? m[0] : fallback
}

export type CmsSalesSyncOpts = {
  dryRun: boolean; source: 'cron' | 'operator' | 'qa'; chunkSize?: number; deadlineAt?: number
  /** Capture lớp nguồn (cờ CMS_SOURCE_CAPTURE_ENABLED) — mặc định false. */
  sourceCapture?: boolean
  /** CHỈ TEST: ép cổng kết quả về HOLD để kiểm nhánh đóng (chỉ ĐÓNG thêm — không mở được cổng). Route / script không truyền. */
  releaseHold?: boolean
}

/** Mã held: nguồn 'qa' trỏ vào chương trình thật (writer QA không bao giờ ghi chương trình thật — PM 06/11 AC08). */
export const CMS_QA_SOURCE_REAL_PROGRAM = 'QA_SOURCE_REAL_PROGRAM'

/**
 * Số dòng ỨNG VIÊN (INCLUDED + chưa gán + ngoài phạm vi) có lượng cơ sở hoặc GMV âm — dấu hiệu trả hàng / điều chỉnh từ nguồn.
 * TODO(Q-a): phạm vi "dòng âm bị held" là MẶC ĐỊNH Dev fail-closed (cả chưa gán / ngoài phạm vi — dòng âm chưa gán có thể là trả
 * của dòng bán đã tính tiền), chờ PM chốt (report 2026-11-07-cms-sales-only §7). Thu hẹp về chỉ INCLUDED ⇒ đổi CÙNG LÚC hàm này và
 * nhánh EXISTS của publish 126 (scripts/gen-cms-126.mjs CMS_126_PUBLISH_ADJ), sinh lại 126.
 */
export function cmsNegativeCandidateLines(out: Pick<ReturnType<typeof computeCmsProgram>, 'lines' | 'excluded'>): number {
  const Z = BigInt(0)
  let n = 0
  for (const l of out.lines) if (l.baseQuantityUnits < Z || l.gmvUnits < Z) n++
  for (const l of out.excluded) {
    if ((l.reason === 'UNASSIGNED' || l.reason === 'OUT_OF_SCOPE') && (l.baseQuantityUnits < Z || l.gmvUnits < Z)) n++
  }
  return n
}

/** Đồng hồ ngân sách của một lượt chương trình. Không có deadline ⇒ chỉ timeout RPC tối đa. */
export function cmsBudget(now: () => number, deadlineAt: number | undefined) {
  const workUntil = deadlineAt === undefined ? undefined : deadlineAt - CMS_SALES_STOP_RESERVE_MS
  // floor: đồng hồ có phần lẻ (writer QA dùng performance) vẫn cho timeout nguyên, không vượt phần còn lại (PM r2 §3).
  const clamp = (ms: number) => Math.floor(Math.max(CMS_RPC_TIMEOUT_MIN_MS, Math.min(CMS_RPC_TIMEOUT_MAX_MS, ms)))
  return {
    /** Còn được bắt đầu bước làm việc mới không (≥ CMS_RPC_START_MIN_MS trước mốc dừng làm việc). */
    canWork: () => workUntil === undefined || now() + CMS_RPC_START_MIN_MS <= workUntil,
    /** I/O của bước làm việc: không vượt mốc dừng làm việc (khi canWork: ≥ CMS_RPC_START_MIN_MS). */
    work: (): CmsIo => ({ timeoutMs: workUntil === undefined ? CMS_RPC_TIMEOUT_MAX_MS : clamp(workUntil - now()) }),
    /** I/O đóng run: dùng phần còn lại tới hạn cứng (gồm dự phòng). */
    stop: (): CmsIo => ({ timeoutMs: deadlineAt === undefined ? CMS_RPC_TIMEOUT_MAX_MS : clamp(deadlineAt - now()) }),
    /** Còn thời gian trước hạn cứng không (cleanup best effort). */
    beforeHard: (marginMs = 0) => deadlineAt === undefined || now() + marginMs < deadlineAt,
    /** BigQuery: hạn tổng theo mốc dừng làm việc. */
    sourceMs: () => (workUntil === undefined ? CMS_BQ_DEFAULT_DEADLINE_MS : Math.max(1, Math.floor(Math.min(CMS_BQ_DEFAULT_DEADLINE_MS, workUntil - now())))),
  }
}

export async function runCmsSalesSync(deps: CmsSalesSyncDeps, programId: string, opts: CmsSalesSyncOpts): Promise<CmsSalesSyncResult> {
  const t0 = deps.now()
  const budget = cmsBudget(deps.now, opts.deadlineAt)
  const r = await runCmsSalesSyncInner(deps, programId, opts, budget)
  // Dọn dữ liệu run cũ ở MỌI nhánh đã mở run (published / held / error — kể cả CLOSE_FAILED): best effort, CÓ ngân sách,
  // không đổi kết quả chính; còn việc ⇒ more = true cho lượt sau (cron summary cảnh báo).
  if (!opts.dryRun && r.runId !== null) r.cleanup = await runCmsCleanup(deps, programId, budget)
  r.elapsedMs = deps.now() - t0
  return r
}

/** Cleanup theo lô trong ngân sách: dừng khi hết việc / hết ngân sách / chạm số lần tối đa / RPC lỗi. */
export async function runCmsCleanup(deps: Pick<CmsSalesSyncDeps, 'cleanup' | 'now'>, programId: string,
  budget: ReturnType<typeof cmsBudget>): Promise<CmsCleanupOutcome> {
  let purged = 0
  for (let calls = 0; ; calls++) {
    if (calls >= CMS_CLEANUP_MAX_CALLS) return { purged, more: true, calls, stoppedBy: 'max_calls' }
    // Một lô chỉ bắt đầu khi còn ≥ CMS_RPC_START_MIN_MS trước hạn cứng (lô 50.000 dòng đo ~2 s, trần statement 8 s) — không
    // chạy lô sau hạn, không để timeout kẹp quá ngắn huỷ lô giữa chừng (pm-auditor r2.2 L3).
    if (!budget.beforeHard(CMS_RPC_START_MIN_MS)) return { purged, more: true, calls, stoppedBy: 'budget' }
    let r: { purged: number; deleted: number; more: boolean }
    try { r = await deps.cleanup(programId, CMS_CLEANUP_BATCH_ROWS, budget.stop()) } catch { return { purged, more: true, calls: calls + 1, stoppedBy: 'failed' } }
    purged += Number(r.purged) || 0
    if (!r.more) return { purged, more: false, calls: calls + 1, stoppedBy: 'done' }
  }
}

async function runCmsSalesSyncInner(deps: CmsSalesSyncDeps, programId: string, opts: CmsSalesSyncOpts,
  budget: ReturnType<typeof cmsBudget>): Promise<CmsSalesSyncResult> {
  const res: CmsSalesSyncResult = {
    programId, status: 'error', code: null, reasons: [], runId: null, isTest: null, rowsRead: null, rowsRejected: null,
    candidates: null, included: null, unassigned: null, outOfScope: null, amountVnd: null, stagedRows: 0, sourceRows: null,
    bytesProcessed: null, resultHash: null, elapsedMs: 0, cause: null, cleanup: null,
  }
  const done = (o: Partial<CmsSalesSyncResult>): CmsSalesSyncResult => ({ ...res, ...o })

  // Kết thúc bằng held / error: dry-run ⇒ chỉ báo mã; run thật ⇒ đóng run (giữ pointer), dùng phần dự phòng ngân sách.
  // Đóng lỗi ⇒ CLOSE_FAILED + cause.
  const stop = async (status: 'held' | 'error', code: string, extra: CmsSalesRunDetail = {}): Promise<CmsSalesSyncResult> => {
    if (opts.dryRun) return done({ status: 'dry_run', code })
    if (res.runId === null) return done({ status, code })
    const detail: CmsSalesRunDetail = { error_code: code, ...extra }
    if (res.rowsRead !== null) detail.rows_read = String(res.rowsRead)
    if (res.rowsRejected !== null) detail.rows_rejected = String(res.rowsRejected)
    if (res.bytesProcessed !== null) detail.bytes_processed = String(res.bytesProcessed)
    try {
      await deps.finish(res.runId, status, detail, budget.stop())
    } catch {
      return done({ status: 'error', code: 'CLOSE_FAILED', cause: { status, code } })
    }
    return done({ status, code })
  }

  if (!deps.table) return done({ status: 'config_missing', code: 'CONFIG_MISSING' })
  if (!budget.canWork()) return done({ status: 'held', code: 'DEADLINE' })

  const mode: CmsResultsReleaseMode = opts.releaseHold === true ? 'HOLD' : CMS_RESULTS_RELEASE_MODE
  const qaSource = opts.source === 'qa'
  // Lượt GHI chỉ mở run khi được phép (PM 03/11 REL-P1-1 + PM 06/11 AC08): cổng HOLD ⇒ chỉ chương trình QA; nguồn 'qa' ⇒ chỉ
  // chương trình QA (cả khi cổng kết quả thật đã mở). Kiểm namespace bằng snapshot CHỈ ĐỌC TRƯỚC openRun ⇒ bị từ chối với 0 run /
  // 0 ghi / 0 truy vấn nguồn. Cron / operator khi cổng mở ⇒ bỏ bước này; kiểm sau openRun / trước stage giữ nguyên.
  if (!opts.dryRun && (!cmsCanPublishResults(false, mode) || qaSource)) {
    let preRaw: unknown
    try { preRaw = await deps.loadSnapshot(programId, budget.work()) } catch (e) {
      const code = cmsRpcCode(e, 'SNAPSHOT_FAILED')
      return done({ status: SKIP_CODES.has(code) ? 'skipped' : 'error', code })
    }
    let pre: CmsSalesSnapshot
    try { pre = parseCmsSalesSnapshot(preRaw) } catch { return done({ status: 'error', code: 'SNAPSHOT_INVALID' }) }
    if (pre.programId !== programId) return done({ status: 'error', code: 'SNAPSHOT_INVALID' })
    res.isTest = pre.isTest
    if (!pre.isTest) return done({ status: 'held', code: qaSource ? CMS_QA_SOURCE_REAL_PROGRAM : 'RESULTS_RELEASE_GATE' })
    // Snapshot đọc trước có thể tiêu hết ngân sách ⇒ không mở run sau mốc làm việc (PM 03/11 QA-P1-1).
    if (!budget.canWork()) return done({ status: 'held', code: 'DEADLINE' })
  }

  let raw: unknown
  if (opts.dryRun) {
    try { raw = await deps.loadSnapshot(programId, budget.work()) } catch (e) { return done({ status: 'error', code: cmsRpcCode(e, 'SNAPSHOT_FAILED') }) }
  } else {
    try {
      raw = await deps.openRun(programId, { source: opts.source }, budget.work())
    } catch (e) {
      const code = cmsRpcCode(e, 'OPEN_FAILED')
      if (code === 'CMS_SYNC_BUSY') return done({ status: 'busy', code })
      if (SKIP_CODES.has(code)) return done({ status: 'skipped', code })
      return done({ status: 'error', code })
    }
  }
  // run_id lấy trước khi kiểm shape để vẫn đóng được run nếu snapshot hỏng.
  const rawRun = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).run_id : undefined
  if (!opts.dryRun && typeof rawRun === 'string') res.runId = rawRun
  let snap: CmsSalesSnapshot
  try {
    snap = parseCmsSalesSnapshot(raw)
    if (snap.programId !== programId || (!opts.dryRun && snap.runId === null)) throw new Error('mismatch')
  } catch {
    return stop('error', 'SNAPSHOT_INVALID')
  }
  res.isTest = snap.isTest
  // Lớp thứ hai cho nguồn 'qa': snapshot của chính run vừa mở là chương trình thật ⇒ đóng run trước khi đọc nguồn / stage.
  if (!opts.dryRun && qaSource && !snap.isTest) return stop('held', CMS_QA_SOURCE_REAL_PROGRAM)
  // Capability lớp nguồn: chỉ tin giá trị DB trả lúc mở run (cờ không phải chứng cứ DB hỗ trợ).
  const capture = !opts.dryRun && opts.sourceCapture === true
  if (capture && snap.sourceSchema !== CMS_SOURCE_SCHEMA_SUPPORTED) return stop('error', 'SOURCE_SCHEMA_UNSUPPORTED')

  let engineInput: ReturnType<typeof cmsSnapshotToEngineInput>
  let win: { fromMicros: bigint; toMicrosExclusive: bigint }
  try {
    engineInput = cmsSnapshotToEngineInput(snap)
    parseCmsEngineProgram(engineInput.program)
    win = vnProgramWindowMicros(snap.startDate, snap.endDate)
  } catch (e) {
    // CMS-Q-220: cấu hình bậc cuối hữu hạn (chưa chuyển đổi bằng migration 125) ⇒ mã riêng, KHÔNG tính theo trần; run đóng
    // 'error' ⇒ pointer / snapshot đã công bố giữ nguyên (fail-closed như CONFIG_INVALID).
    return stop('error', e instanceof CmsEngineConfigError && e.code === 'FINITE_LAST_TIER' ? 'CONFIG_FINITE_LAST_TIER' : 'CONFIG_INVALID')
  }
  if (!budget.canWork()) return stop('held', 'DEADLINE')

  const fetched = await fetchCmsSalesSnapshot(deps.runner, {
    table: deps.table, fromMicros: win.fromMicros, toMicrosExclusive: win.toMicrosExclusive,
    productIds: snap.products.map((p) => p.productId), deadlineMs: budget.sourceMs(),
  })
  if (!fetched.ok) {
    const held = fetched.reason === 'OVER_CAP' || fetched.reason === 'INCOMPLETE_PAGES'
    return stop(held ? 'held' : 'error', `SOURCE_${fetched.reason}`)
  }
  res.rowsRead = fetched.rowsRead
  res.rowsRejected = fetched.rowIssues.length
  res.bytesProcessed = fetched.bytesProcessed

  const lineIds = fetched.lines.map((l) => l.orderLineId)
  if (findDuplicates(lineIds).length) {
    res.reasons = ['DUPLICATE_LINE_ID']
    return stop('held', 'DUPLICATE_LINE_ID')
  }
  let out: ReturnType<typeof computeCmsProgram>
  try {
    out = computeCmsProgram({ program: engineInput.program, lines: fetched.lines, sellers: engineInput.sellers })
  } catch (e) {
    if (e instanceof CmsEngineInputError) { res.reasons = ['DUPLICATE_LINE_ID']; return stop('held', 'DUPLICATE_LINE_ID') }
    return stop('error', 'ENGINE_FAILED')
  }
  Object.assign(res, {
    candidates: out.totals.candidates, included: out.totals.included, unassigned: out.totals.unassigned,
    outOfScope: out.totals.outOfScope, amountVnd: out.totals.amountVnd.toString(),
  })
  const verdict = assessSalesSnapshot({
    rowsRead: fetched.rowsRead, totalRowsReported: fetched.totalRowsReported, pagesComplete: true,
    rowIssues: fetched.rowIssues.map((r) => r.issues), lineIds, candidates: out.totals.candidates,
    unassigned: out.totals.unassigned, previousPublishedRows: snap.previousRowsRead,
  })
  const qualityDetail: CmsSalesRunDetail = {
    candidates: out.totals.candidates, included: out.totals.included, unassigned: out.totals.unassigned,
    out_of_scope: out.totals.outOfScope,
  }
  if (verdict.status === 'held') {
    res.reasons = verdict.reasons
    return stop('held', verdict.reasons[0], { ...qualityDetail, reasons: verdict.reasons.join(',') })
  }
  if (cmsStageBoundsIssue(out, fetched.lines)) return stop('held', 'OVERFLOW', qualityDetail)
  // Trả hàng chưa triển khai (phase sau — PM 06/11 sales-only §4.2): chương trình thật có dòng ứng viên âm (engine ⇒ ADJUSTMENT) ⇒
  // held, KHÔNG stage / publish, pointer cũ giữ nguyên. Không bỏ dòng âm để công bố riêng phần dương, không clamp về 0. QA giữ fixture
  // điều chỉnh trong namespace test. DB 126 chặn lại ở publish (tổng điều chỉnh đã seal + dòng âm đã stage).
  const negative = cmsNegativeCandidateLines(out)
  if (negative > 0 && cmsAdjustmentBlocksRelease(snap.isTest)) {
    return stop('held', CMS_RETURNS_NOT_SUPPORTED, { ...qualityDetail, adjustment_lines: negative })
  }

  let payload: ReturnType<typeof buildCmsStagePayload>
  try {
    payload = buildCmsStagePayload(snap, fetched.lines, out, {
      rowsRead: fetched.rowsRead, rowsRejected: fetched.rowIssues.length, bytesProcessed: fetched.bytesProcessed,
      chunkSize: opts.chunkSize ?? CMS_STAGE_CHUNK_DEFAULT,
    })
  } catch {
    return stop('error', 'PAYLOAD_FAILED', qualityDetail)
  }
  res.resultHash = createHash('sha256').update(JSON.stringify(payload.parts)).update(payload.expect.amount_vnd).digest('hex')
  if (opts.dryRun) return done({ status: 'dry_run', code: null })

  // Cổng kết quả HOLD: chương trình thật chưa được công bố tiền ⇒ dừng TRƯỚC khi stage — không ghi email người bán / tiền thật vào
  // DB mỗi lượt cron khi chưa được phép công bố (security review P1-1). DB publish có cổng riêng (122 / 126) làm lớp thứ hai.
  if (!cmsCanPublishResults(snap.isTest, mode)) return stop('held', 'RESULTS_RELEASE_GATE', qualityDetail)

  const runId = res.runId!
  // RPC làm việc ném lỗi: mã CMS_* = DB từ chối xác định ⇒ error đúng mã; không mã (transport / huỷ do timeout) mà ngân sách
  // làm việc đã hết ⇒ held DEADLINE (bị huỷ vì hết giờ, không phải lỗi dữ liệu — pm-auditor r2.2 L2); còn lại ⇒ error fallback.
  const workFail = (e: unknown, fallback: string): { status: 'held' | 'error'; code: string } => {
    const code = cmsRpcCode(e, '')
    if (code) return { status: 'error', code }
    return budget.canWork() ? { status: 'error', code: fallback } : { status: 'held', code: 'DEADLINE' }
  }
  for (const part of CMS_STAGE_PARTS) {
    const chunks = chunkCmsStageRows(payload.parts[part], opts.chunkSize ?? CMS_STAGE_CHUNK_DEFAULT)
    for (let i = 0; i < chunks.length; i++) {
      if (!budget.canWork()) return stop('held', 'DEADLINE', qualityDetail)
      let n: number
      try { n = await deps.stage(runId, part, i, chunks[i], budget.work()) } catch (e) {
        const f = workFail(e, 'STAGE_FAILED')
        return stop(f.status, f.code, qualityDetail)
      }
      if (n !== chunks[i].length) return stop('error', 'STAGE_COUNT_MISMATCH', qualityDetail)
      res.stagedRows += n
    }
  }
  // Lớp nguồn (124): sau 4 part engine, TRƯỚC seal (seal_begin đóng băng khối). Cùng ngân sách / mã lỗi như part engine.
  if (capture) {
    const chunks = chunkCmsStageRows(buildCmsSourceStageRows(fetched.lines), opts.chunkSize ?? CMS_STAGE_CHUNK_DEFAULT)
    res.sourceRows = 0
    for (let i = 0; i < chunks.length; i++) {
      if (!budget.canWork()) return stop('held', 'DEADLINE', qualityDetail)
      let n: number
      try { n = await deps.stage(runId, CMS_SOURCE_PART, i, chunks[i], budget.work()) } catch (e) {
        const f = workFail(e, 'STAGE_FAILED')
        return stop(f.status, f.code, qualityDetail)
      }
      if (n !== chunks[i].length) return stop('error', 'STAGE_COUNT_MISMATCH', qualityDetail)
      res.sourceRows += n
    }
  }

  // Seal tách bước — kiểm ngân sách TRƯỚC mỗi RPC (không bắt đầu seal / bước kế khi đã hết ngân sách làm việc).
  const seal = await runCmsSealSteps({
    begin: () => deps.sealBegin(runId, payload.expect, budget.work()),
    step: (n) => deps.sealStep(runId, n, budget.work()),
    canContinue: budget.canWork,
  }).catch((e: unknown) => ({ sealed: false, ...workFail(e, 'SEAL_FAILED'), closed: false }))
  if (!seal.sealed) {
    // DB đã đóng run (seal_fail) ⇒ không đóng lần hai; app dừng (DEADLINE / lỗi transport / hết bước) ⇒ đóng run.
    if (seal.closed) return done({ status: seal.status === 'held' ? 'held' : 'error', code: seal.code ?? 'SEAL_FAILED' })
    return stop(seal.code === 'DEADLINE' ? 'held' : 'error', seal.code ?? 'SEAL_FAILED', qualityDetail)
  }

  if (!budget.canWork()) return stop('held', 'DEADLINE', qualityDetail)
  let pub: Awaited<ReturnType<CmsSalesSyncDeps['publish']>>
  try {
    pub = await deps.publish(runId, budget.work())
  } catch (e) {
    // DB trả mã CMS_* (vd CMS_RESULT_NOT_SEALED / CMS_SYNC_RUN_NOT_RUNNING) = phản hồi XÁC ĐỊNH, transaction đã rollback
    // (pm-auditor r2.2 L1) ⇒ báo đúng mã; run còn running ⇒ đóng error; run không còn running ⇒ không đóng lần hai.
    const code = cmsRpcCode(e, '')
    if (code === 'CMS_SYNC_RUN_NOT_RUNNING') return done({ status: 'error', code })
    if (code) return stop('error', code, qualityDetail)
    // Không mã: có thể đã commit nhưng mất phản hồi. Publish idempotent ⇒ gọi lại MỘT lần (cả khi đã qua mốc làm việc,
    // dùng phần dự phòng). Lần gọi lại nhận mã CMS_* ⇒ chắc chắn CHƯA công bố (đã công bố thì DB trả already) — báo mã,
    // không đóng run (lần đầu có thể đã đóng held). Vẫn không rõ ⇒ PUBLISH_UNKNOWN: không finish / không báo held hay
    // rollback (DB có thể đã đổi pointer); run chưa công bố sẽ thành STALE ở lượt open sau, run đã công bố giữ nguyên.
    try { pub = await deps.publish(runId, budget.stop()) } catch (e2) {
      const code2 = cmsRpcCode(e2, '')
      return done({ status: 'error', code: code2 || 'PUBLISH_UNKNOWN' })
    }
  }
  if (!pub.published) return done({ status: pub.code === 'STALE' ? 'error' : 'held', code: pub.code ?? 'PUBLISH_REJECTED' })
  return done({ status: 'published', code: null })
}

/**
 * Seal tách bước: begin (đóng băng staging, đủ dòng / khối) rồi từng bước 1…N. RPC thất bại trả {sealed: false, status,
 * code} và DB đã đóng run (closed = true) — dừng ngay. `canContinue` false trước một RPC ⇒ dừng DEADLINE (closed = false,
 * lõi đóng run). Lỗi transport ⇒ ném (lõi đóng run error SEAL_FAILED).
 */
export async function runCmsSealSteps(rpc: { begin(): Promise<CmsSealReply>; step(n: number): Promise<CmsSealReply>; canContinue?: () => boolean }):
  Promise<{ sealed: boolean; status?: string; code?: string; closed: boolean }> {
  const go = rpc.canContinue ?? (() => true)
  if (!go()) return { sealed: false, status: 'held', code: 'DEADLINE', closed: false }
  const b = await rpc.begin()
  if (!b?.ok) return { sealed: false, status: b?.status, code: b?.code ?? 'SEAL_FAILED', closed: true }
  for (let i = 1; i <= CMS_SEAL_STEPS; i++) {
    if (!go()) return { sealed: false, status: 'held', code: 'DEADLINE', closed: false }
    const r = await rpc.step(i)
    if (r?.sealed) return { sealed: true, closed: false }
    if (!r?.ok) return { sealed: false, status: r?.status, code: r?.code ?? 'SEAL_FAILED', closed: true }
  }
  return { sealed: false, status: 'error', code: 'SEAL_INCOMPLETE', closed: false }
}

/** Mã thoát script operator: 0 khi published / dry-run sạch; held · busy · skipped · lỗi ⇒ 1; thiếu cấu hình ⇒ 2. */
export function cmsSalesExitCode(r: Pick<CmsSalesSyncResult, 'status' | 'code'>): number {
  if (r.status === 'config_missing') return 2
  return (r.status === 'published' || r.status === 'dry_run') && r.code === null ? 0 : 1
}
