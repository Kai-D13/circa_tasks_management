// CMS-CALC-RET-2 P4 — nhánh RUN CONTRACT (`cms-calc-ret2-v1`; Q-236: `cms-calc-ret2-v2` cho full_line_qty_refund_v1) của lõi đồng bộ bán (salesSync.ts). Gọi khi DB ghim hợp đồng cho run
// vừa mở (open 130 trả calc_contract_version) hoặc — dry-run — khi chương trình không còn là legacy (cms_unit / net_returns_v1).
// Thuần: mọi I/O qua deps của salesSync + provider nguồn tiêm vào (source/contractSource.ts; QA: e2e/cmsContractFixture.ts).
// Luồng (fail-closed, không giữ transaction DB khi gọi nguồn; cùng ngân sách / quy ước mã với đường legacy):
//   cờ (cms_unit cần CMS_CALC_MODES_ENABLED, net cần CMS_RETURNS_ENABLED — OFF ⇒ held, KHÔNG quay về legacy) → provider (fixture chỉ
//   cho chương trình is_test) → MỘT lần đọc nguồn ghim as_of (bán + trả cùng job) → chuẩn hoá (dòng bán lỗi ⇒ chất lượng như legacy;
//   phiếu trả lỗi bất kỳ ⇒ held RETURN_ROW_ISSUES, không bỏ phiếu) → computeCmsNet (hold ⇒ held mã CALC_<code>, kèm ≤ 20 ref kỹ thuật)
//   → chất lượng → cổng kết quả → stage 6 part theo thứ tự FK → seal begin + 13 bước → publish (ledger trả hàng dưới khoá ở DB:
//   MISMATCH / CONFLICT_OPEN / AS_OF_REGRESSION ⇒ held đúng mã DB trả, pointer giữ).
// Thiếu nguồn trả ≠ "0 phiếu trả": provider lỗi ⇒ held / error SOURCE_<mã>, không bao giờ stage net với returns = [].
// Kết quả / detail chỉ số đếm + mã cố định + ID kỹ thuật — không email, không giá trị dòng, không message thô của nguồn.

import { createHash } from 'node:crypto'
import { cmsContractCalcInput, buildCmsContractStagePayload, cmsRejectedDigest, parseCmsContractSnapshot, CMS_CONTRACT_SEAL_STEPS,
  type CmsContractPayload, type CmsContractSnapshot } from './calc/contractStage'
import { computeCmsNet, cmsCalcSaleLine, CmsCalcConfigError, type CmsCalcOutput, type CmsCalcSaleLine } from './calc/net'
import { cmsCalcContractVersionFor, cmsPolicyReadsReturns } from './calc/policy'
import { normalizeReturnRow, type CmsReturnRecord } from './calc/returns'
import { CmsEngineInputError } from './engine/compute'
import { CmsEngineConfigError } from './engine/config'
import { assessSalesSnapshot } from './quality'
import { cmsCanPublishResults, type CmsResultsReleaseMode } from './releaseGate'
import { chunkCmsStageRows, CMS_STAGE_CHUNK_DEFAULT } from './resultStage'
import type { CmsIo, CmsSalesRunDetail, CmsSalesSyncDeps, CmsSalesSyncOpts, CmsSalesSyncResult, CmsSealReply } from './salesSync'
import { CMS_SALES_COLUMNS, normalizeSalesRow, type CmsRowIssue } from './source/contract'
import type { CmsContractSourceCode, CmsContractSourceProvider } from './source/contractSource'
import { cmsEncodeUnitIssueSummary, cmsRowIssueContext, cmsSummarizeRowIssues, type CmsRowIssueContext } from './sourceDiagnostics'
import { vnProgramWindowMicros } from './time'

/** Mã nguồn contract dừng held (cần người / BI xử lý); còn lại (TIMEOUT / SOURCE_ERROR) là lỗi tạm ⇒ error. */
const HELD_SOURCE: ReadonlySet<CmsContractSourceCode> = new Set(['NOT_CONFIGURED', 'PERMISSION_DENIED', 'CONTRACT_MISMATCH', 'INCOMPLETE',
  'OVER_CAP', 'BYTES_LIMIT'])
/** Số ref kỹ thuật tối đa ghi vào detail khi engine HOLD. */
export const CMS_CONTRACT_HOLD_REFS_MAX = 20

/** Tóm tắt run contract trong kết quả lõi (null ⇔ run legacy). */
export interface CmsContractSummary {
  quantityBasis: string
  returnsPolicy: string
  provider: 'bq' | 'fixture' | null
  /** as_of của snapshot (µs UTC, chuỗi số nguyên) — null khi chưa đọc nguồn. */
  asOfMicros: string | null
  returnsRead: number | null
  returnsApplied: number | null
  returnsNotEffective: number | null
  holdCodes: string[]
}

/** Có phải chương trình / run contract không — theo dữ liệu DB trả (open: calc_contract_version; snapshot chỉ đọc: chế độ chương trình). */
export function cmsIsContractSnapshot(raw: unknown, fromOpen: boolean): boolean {
  if (typeof raw !== 'object' || raw === null) return false
  const o = raw as Record<string, unknown>
  if (fromOpen) return o.calc_contract_version !== null && o.calc_contract_version !== undefined
  const basis = o.quantity_basis, policy = o.returns_policy
  if (basis === undefined && policy === undefined) return false // DB trước 130
  return basis !== 'pos_base' || policy !== 'sales_only_v1'
}

export interface CmsContractPathCtx {
  deps: CmsSalesSyncDeps
  programId: string
  opts: CmsSalesSyncOpts
  budget: {
    canWork(): boolean
    work(): CmsIo
    stop(): CmsIo
    sourceMs(): number
  }
  res: CmsSalesSyncResult
  raw: unknown
  mode: CmsResultsReleaseMode
  stop(status: 'held' | 'error', code: string, extra?: CmsSalesRunDetail): Promise<CmsSalesSyncResult>
  done(o: Partial<CmsSalesSyncResult>): CmsSalesSyncResult
  /** Helper của salesSync (truyền vào để tránh import vòng lúc chạy). */
  rpcCode(e: unknown, fallback: string): string
  sealSteps(rpc: { begin(): Promise<CmsSealReply>; step(n: number): Promise<CmsSealReply>; canContinue?: () => boolean }, steps: number):
    Promise<{ sealed: boolean; status?: string; code?: string; closed: boolean }>
  qaRealProgramCode: string
}

export async function runCmsContractPath(c: CmsContractPathCtx): Promise<CmsSalesSyncResult> {
  const { deps, opts, budget, res } = c
  let snap: CmsContractSnapshot
  try {
    snap = parseCmsContractSnapshot(c.raw)
    if (snap.programId !== c.programId) throw new Error('mismatch')
    // DB ghim hợp đồng theo policy (132: full_line ⇒ v2); app phải tính đúng hợp đồng đó, không tự hạ về v1.
    if (!opts.dryRun && (snap.runId === null || snap.calcContractVersion !== cmsCalcContractVersionFor(snap.returnsPolicy))) throw new Error('mismatch')
  } catch {
    return c.stop('error', 'SNAPSHOT_INVALID')
  }
  res.isTest = snap.isTest
  // `net` = chương trình đọc nguồn trả (net_returns_v1 hoặc full_line_qty_refund_v1); cùng cờ CMS_RETURNS_ENABLED.
  const net = cmsPolicyReadsReturns(snap.returnsPolicy)
  const profile = cmsPolicyReadsReturns(snap.returnsPolicy) ? snap.returnsPolicy : null
  const summary: CmsContractSummary = {
    quantityBasis: snap.quantityBasis, returnsPolicy: snap.returnsPolicy, provider: null, asOfMicros: null, returnsRead: null,
    returnsApplied: null, returnsNotEffective: null, holdCodes: [],
  }
  res.contract = summary
  const flags = opts.calcFlags ?? { modes: false, returns: false }
  // Cờ OFF trên chương trình contract đã có ⇒ dừng có vết, KHÔNG chạy đường legacy (DB cũng chặn publish sales-only của chương trình net).
  if (snap.quantityBasis === 'cms_unit' && !flags.modes) return c.stop('held', 'CALC_MODES_DISABLED')
  if (net && !flags.returns) return c.stop('held', 'RETURNS_DISABLED')
  if (!opts.dryRun && opts.source === 'qa' && !snap.isTest) return c.stop('held', c.qaRealProgramCode)
  const provider: CmsContractSourceProvider | undefined = deps.contractProvider
  if (!provider) return c.stop('error', 'CONTRACT_PROVIDER_MISSING')
  // Nguồn giả chỉ cho chương trình QA (DB kiểm lại ở seal: provider fixture ⇒ run.is_test).
  if (provider.kind === 'fixture' && !snap.isTest) return c.stop('held', 'FIXTURE_REAL_PROGRAM')

  let win: { fromMicros: bigint; toMicrosExclusive: bigint }
  try { win = vnProgramWindowMicros(snap.startDate, snap.endDate) } catch { return c.stop('error', 'CONFIG_INVALID') }
  if (!budget.canWork()) return c.stop('held', 'DEADLINE')

  const asOf = deps.asOfMicros ? deps.asOfMicros() : BigInt(Date.now()) * BigInt(1000)
  const read = await provider.read({
    fromMicros: win.fromMicros, toMicrosExclusive: win.toMicrosExclusive, productIds: snap.products.map((p) => p.productId),
    asOfMicros: asOf, withReturns: net, ...(profile ? { returnsProfile: profile } : {}), deadlineMs: budget.sourceMs(),
  })
  if (!read.ok) {
    const extra: CmsSalesRunDetail = {}
    if (read.part) extra.source_part = read.part
    if (read.missing?.length) extra.source_missing = read.missing.slice(0, 20).join(',')
    if (typeof read.status === 'number') extra.source_status = read.status
    return c.stop(HELD_SOURCE.has(read.code) ? 'held' : 'error', `SOURCE_${read.code}`, extra)
  }
  // Provider phải trả đúng mốc đã ghim và đúng hình dạng theo chính sách (bảo vệ khỏi provider lỗi: không net với returns null / [] giả).
  if (read.asOfMicros !== asOf || read.provider !== provider.kind || (net ? read.returnsRaw === null : read.returnsRaw !== null)
      || (read.jobId === undefined) === (read.snapshotId === undefined)) {
    return c.stop('error', 'SOURCE_PIN_MISMATCH')
  }
  summary.provider = read.provider
  summary.asOfMicros = asOf.toString()

  // ── Chuẩn hoá ──
  const sales: CmsCalcSaleLine[] = []
  const rowIssues: { index: number; issues: CmsRowIssue[]; ctx: CmsRowIssueContext }[] = []
  const rejected: { position: number; values: (string | null)[] }[] = []
  read.salesRaw.forEach((r, index) => {
    const n = normalizeSalesRow(r)
    if (n.ok) sales.push(cmsCalcSaleLine(r, n.value))
    else {
      rowIssues.push({ index, issues: n.issues, ctx: cmsRowIssueContext(r) })
      rejected.push({ position: index, values: CMS_SALES_COLUMNS.map((k) => r[k] ?? null) })
    }
  })
  res.rowsRead = read.salesRaw.length
  res.rowsRejected = rowIssues.length
  res.bytesProcessed = read.bytesProcessed
  const returns: CmsReturnRecord[] = []
  const retKinds = new Set<string>()
  let retBad = 0
  for (const r of read.returnsRaw ?? []) {
    const n = normalizeReturnRow(r, profile ?? 'net_returns_v1')
    if (n.ok) returns.push(n.value)
    else { retBad++; for (const i of n.issues) retKinds.add(`${i.kind}:${i.field}`) }
  }
  summary.returnsRead = read.returnsRaw === null ? null : read.returnsRaw.length
  // Phiếu trả lỗi chuẩn hoá ⇒ HOLD cả lượt (digest trả phủ MỌI phiếu — r2 §4.3), không bỏ phiếu để công bố phần còn lại.
  if (retBad) return c.stop('held', 'RETURN_ROW_ISSUES', { return_issue_rows: retBad, return_issue_kinds: [...retKinds].sort().slice(0, 20).join(',') })

  // ── Tính ──
  let out: CmsCalcOutput
  try {
    out = computeCmsNet(cmsContractCalcInput(snap, sales, returns, asOf))
  } catch (e) {
    if (e instanceof CmsEngineInputError) { res.reasons = ['DUPLICATE_LINE_ID']; return c.stop('held', 'DUPLICATE_LINE_ID') }
    if (e instanceof CmsEngineConfigError) return c.stop('error', e.code === 'FINITE_LAST_TIER' ? 'CONFIG_FINITE_LAST_TIER' : 'CONFIG_INVALID')
    if (e instanceof CmsCalcConfigError) return c.stop('error', `CALC_CONFIG_${e.code}`)
    return c.stop('error', 'ENGINE_FAILED')
  }
  if (!out.ok) {
    const codes = [...new Set(out.holds.map((h) => h.code))].sort()
    summary.holdCodes = codes
    res.reasons = codes.map((x) => `CALC_${x}`)
    return c.stop('held', `CALC_${codes[0]}`, {
      hold_codes: codes.join(','), hold_count: out.holds.length,
      hold_refs: out.holds.slice(0, CMS_CONTRACT_HOLD_REFS_MAX).map((h) => h.ref).join(' '),
    })
  }
  const t = out.totals
  summary.returnsApplied = t.returnsApplied
  summary.returnsNotEffective = t.returnsNotEffective
  Object.assign(res, { candidates: t.candidates, included: t.included, unassigned: t.unassigned, outOfScope: t.outOfScope, amountVnd: t.amountVnd.toString() })
  const verdict = assessSalesSnapshot({
    rowsRead: read.salesRaw.length, totalRowsReported: read.salesRaw.length, pagesComplete: true, rowIssues: rowIssues.map((r) => r.issues),
    lineIds: sales.map((l) => l.orderLineId), candidates: t.candidates, unassigned: t.unassigned, previousPublishedRows: snap.previousRowsRead,
  })
  const qualityDetail: CmsSalesRunDetail = {
    candidates: t.candidates, included: t.included, unassigned: t.unassigned, out_of_scope: t.outOfScope,
    returns_read: t.returnsRead, returns_applied: t.returnsApplied,
  }
  if (verdict.status === 'held') {
    res.reasons = verdict.reasons
    const diag: CmsSalesRunDetail = {}
    if (rowIssues.length) {
      const s = cmsSummarizeRowIssues(rowIssues.map((x) => ({ ctx: x.ctx, issues: x.issues })))
      res.unitIssues = s
      diag.unit_issue_summary = cmsEncodeUnitIssueSummary(s)
      diag.unit_issue_rows = s.rows
      diag.unit_issue_groups_truncated = s.truncated
    }
    return c.stop('held', verdict.reasons[0], { ...qualityDetail, reasons: verdict.reasons.join(','), ...diag })
  }

  const chunkSize = opts.chunkSize ?? CMS_STAGE_CHUNK_DEFAULT
  let payload: CmsContractPayload
  try {
    payload = buildCmsContractStagePayload(snap, sales, returns, out, {
      rowsRead: read.salesRaw.length, rowsRejected: rejected.length, bytesProcessed: read.bytesProcessed, provider: read.provider,
      ...(read.jobId !== undefined ? { jobId: read.jobId } : { snapshotId: read.snapshotId }), asOfMicros: asOf,
      rejectedDigest: cmsRejectedDigest(rejected), chunkSize,
    })
  } catch {
    return c.stop('error', 'PAYLOAD_FAILED', qualityDetail)
  }
  res.resultHash = createHash('sha256').update(JSON.stringify(payload.parts)).update(String(payload.expect.amount_vnd)).digest('hex')
  if (opts.dryRun) return c.done({ status: 'dry_run', code: null })
  if (!cmsCanPublishResults(snap.isTest, c.mode)) return c.stop('held', 'RESULTS_RELEASE_GATE', qualityDetail)

  const runId = res.runId!
  const workFail = (e: unknown, fallback: string): { status: 'held' | 'error'; code: string } => {
    const code = c.rpcCode(e, '')
    if (code) return { status: 'error', code }
    return budget.canWork() ? { status: 'error', code: fallback } : { status: 'held', code: 'DEADLINE' }
  }
  for (const part of payload.stageParts) {
    const chunks = chunkCmsStageRows(payload.parts[part], chunkSize)
    for (let i = 0; i < chunks.length; i++) {
      if (!budget.canWork()) return c.stop('held', 'DEADLINE', qualityDetail)
      let n: number
      try { n = await deps.stage(runId, part, i, chunks[i], budget.work()) } catch (e) {
        const f = workFail(e, 'STAGE_FAILED')
        return c.stop(f.status, f.code, qualityDetail)
      }
      if (n !== chunks[i].length) return c.stop('error', 'STAGE_COUNT_MISMATCH', qualityDetail)
      // Như legacy: stagedRows = part engine; lớp nguồn đếm riêng (sourceRows).
      if (part === 'source_lines') res.sourceRows = (res.sourceRows ?? 0) + n
      else res.stagedRows += n
    }
  }
  const seal = await c.sealSteps({
    begin: () => deps.sealBegin(runId, payload.expect, budget.work()),
    step: (n) => deps.sealStep(runId, n, budget.work()),
    canContinue: budget.canWork,
  }, CMS_CONTRACT_SEAL_STEPS).catch((e: unknown) => ({ sealed: false, ...workFail(e, 'SEAL_FAILED'), closed: false }))
  if (!seal.sealed) {
    if (seal.closed) return c.done({ status: seal.status === 'held' ? 'held' : 'error', code: seal.code ?? 'SEAL_FAILED' })
    return c.stop(seal.code === 'DEADLINE' ? 'held' : 'error', seal.code ?? 'SEAL_FAILED', qualityDetail)
  }
  if (!budget.canWork()) return c.stop('held', 'DEADLINE', qualityDetail)
  let pub: Awaited<ReturnType<CmsSalesSyncDeps['publish']>>
  try {
    pub = await deps.publish(runId, budget.work())
  } catch (e) {
    // Như legacy: mã CMS_* = từ chối xác định (transaction rollback); không mã ⇒ gọi lại MỘT lần (publish idempotent — run ok ⇒ already).
    const code = c.rpcCode(e, '')
    if (code === 'CMS_SYNC_RUN_NOT_RUNNING') return c.done({ status: 'error', code })
    if (code) return c.stop('error', code, qualityDetail)
    try { pub = await deps.publish(runId, budget.stop()) } catch (e2) {
      return c.done({ status: 'error', code: c.rpcCode(e2, '') || 'PUBLISH_UNKNOWN' })
    }
  }
  // Publish contract tự đóng run held / error khi có mã (ledger / cổng / as_of) ⇒ không finish lần hai.
  if (!pub.published) return c.done({ status: pub.code === 'STALE' ? 'error' : 'held', code: pub.code ?? 'PUBLISH_REJECTED' })
  return c.done({ status: 'published', code: null })
}
