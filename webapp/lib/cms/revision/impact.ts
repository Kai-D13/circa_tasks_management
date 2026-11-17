// F-A (PM spec 17/11 §2.5) — dự toán tác động tiền của một revision: tính cấu hình TRƯỚC và SAU trên CÙNG một lần đọc nguồn (hợp
// danh mục trước ∪ sau — SP thêm có nguồn đủ, không dùng source run cũ vốn chỉ chứa SP cũ) và CÙNG mapping người bán (snapshot chỉ đọc
// rpc_cms_sales_snapshot: mapping_fp + config_version ghim — preview DB so lại cả hai). Engine / hai mode giữ nguyên: legacy
// computeCmsProgram, contract computeCmsNet (sales_only). Thuần: mọi I/O qua deps (route nối BigQuery / service role thật; test tiêm).
// Fail-closed: nguồn lỗi / HOLD chất lượng / dòng âm chương trình thật / cấu hình lạ ⇒ status 'error' + mã, KHÔNG có số 0 giả; DB từ
// chối commit khi impact không 'ok'. Số tiền đang công bố (run hiện hành) đi riêng có run_id để không nhầm delta nguồn mới với delta
// cấu hình. Không email / mã đơn / người bán thô trong output — chỉ UUID người dùng / cửa hàng, ProductID, số đếm, digest.

import { createHash } from 'node:crypto'
import { computeCmsProgram, CmsEngineInputError, type CmsEngineOutput } from '../engine/compute'
import { CmsEngineConfigError, parseCmsEngineProgram } from '../engine/config'
import { computeCmsNet, cmsCalcSaleLine, CmsCalcConfigError, type CmsCalcSaleLine } from '../calc/net'
import { cmsContractCalcInput, parseCmsContractSnapshot, type CmsContractSnapshot } from '../calc/contractStage'
import { cmsIsContractSnapshot } from '../contractSync'
import { assessSalesSnapshot, findDuplicates } from '../quality'
import { cmsAdjustmentBlocksRelease } from '../releaseGate'
import { cmsSnapshotToEngineInput, cmsStageBoundsIssue, parseCmsSalesSnapshot, type CmsSalesSnapshot } from '../resultStage'
import { cmsNegativeCandidateLines } from '../salesSync'
import { fetchCmsSalesSnapshot, type CmsBqRunner, type CmsRowIssueAt } from '../source/bigquery'
import { normalizeSalesRow, type CmsSalesLine } from '../source/contract'
import type { CmsContractSourceProvider } from '../source/contractSource'
import { cmsRowIssueContext } from '../sourceDiagnostics'
import { vnProgramWindowMicros } from '../time'
import type { CmsPublishedLoad } from './published'

export const CMS_REVISION_IMPACT_VERSION = 'cms-revision-impact-v1'
/** Trần số dòng người / SP lưu trong impact (DB ≤ 256 KB). Vượt ⇒ cắt + cờ truncated (tổng vẫn đủ). */
export const CMS_REVISION_IMPACT_LIST_MAX = 800

export interface CmsRevisionDesiredProduct {
  product_id: string
  gmv_basis: 'product' | 'catalog' | 'none'
  target_gmv: string | null
  unit_cms: string
  base_quantity_cms: string
  tiers: { order: number; from: number; to: number | null; amount: string }[]
}

export interface CmsRevisionImpactDeps {
  /** View dòng bán (legacy); null = chưa cấu hình. */
  table: string | null
  runner: CmsBqRunner
  contractProvider?: CmsContractSourceProvider
  /** rpc_cms_sales_snapshot — CHỈ ĐỌC (service role, người gọi đã kiểm super). */
  loadSnapshot(programId: string): Promise<unknown>
  /** Số đã công bố của run pointer (service role) — đọc ĐỦ + kiểm (published.ts cmsLoadPublished); thiếu / lệch ⇒ ném. */
  loadPublished(programId: string, runId: string): Promise<CmsPublishedLoad>
  /** Cờ CMS_CALC_MODES_ENABLED (chương trình cms_unit cần). */
  calcModes: boolean
  deadlineMs: number
  asOfMicros?: () => bigint
  now(): Date
}

export interface CmsRevisionImpactPerson {
  user_id: string
  store_id: string
  published_vnd: string | null
  before_vnd: string
  after_vnd: string
  delta_vnd: string
}

export interface CmsRevisionImpactProduct {
  product_id: string
  before_vnd: string
  after_vnd: string
  delta_vnd: string
  before_qty: string
  after_qty: string
}

export interface CmsRevisionImpactTotals {
  before_vnd: string
  after_vnd: string
  delta_vnd: string
  published_vnd: string | null
  published_run_id: string | null
  /** r3 (P1-03): version cấu hình + mốc công bố của run pointer (NULL khi chưa có run). */
  published_config_version: number | null
  published_at: string | null
  /** true = run pointer cùng version cấu hình hiện hành (đang hiển thị); false = bản công bố TRƯỚC thay đổi cấu hình (đã bị che,
   *  chưa có run mới); null = chưa có run. */
  published_current: boolean | null
  persons: number
  up: number
  down: number
  same: number
  products_before: number
  products_after: number
  rows_read: number
  candidates_after: number
  unassigned_after: number
}

export interface CmsRevisionImpact {
  version: typeof CMS_REVISION_IMPACT_VERSION
  status: 'ok' | 'error'
  /** Mã lỗi cố định khi status 'error'. */
  code: string | null
  from_config_version: number
  /** not_started = chưa tới ngày bắt đầu / nháp ⇒ không có số (0 thật, không đọc nguồn). */
  path: 'not_started' | 'legacy' | 'contract'
  computed_at: string
  totals: CmsRevisionImpactTotals | null
  persons: CmsRevisionImpactPerson[]
  products: CmsRevisionImpactProduct[]
  truncated: { persons: boolean; products: boolean }
}

export interface CmsRevisionSourceIdentity {
  mapping_fp: string
  provider: 'bq' | 'fixture' | 'none'
  rows_read: number | null
  /** sha256 các dòng bán chuẩn hoá (mã dòng + SP + thời điểm + lượng + GMV), xếp theo mã dòng — không email. */
  lines_digest: string | null
  as_of: string | null
  from_date: string
  to_date: string
  /** Số ProductID đã đọc nguồn (hợp trước ∪ sau). */
  product_ids: number
}

export type CmsRevisionImpactResult =
  | { ok: true; impact: CmsRevisionImpact; source: CmsRevisionSourceIdentity; snapshot: CmsSalesSnapshot }
  | { ok: false; code: 'SNAPSHOT_FAILED' | 'SNAPSHOT_INVALID' }

const Z = BigInt(0)

function linesDigest(lines: readonly CmsSalesLine[]): string {
  const h = createHash('sha256')
  const sorted = [...lines].sort((a, b) => (a.orderLineId < b.orderLineId ? -1 : a.orderLineId > b.orderLineId ? 1 : 0))
  for (const l of sorted) h.update(`${l.orderLineId}|${l.productId}|${l.completedAtMicros}|${l.baseQuantityUnits}|${l.gmvUnits}\n`)
  return h.digest('hex')
}

/** Snapshot với danh mục thay bằng danh mục mong muốn (kỳ / scope / mapping / người bán giữ nguyên). */
function withProducts<S extends CmsSalesSnapshot>(snap: S, desired: readonly CmsRevisionDesiredProduct[]): S {
  return {
    ...snap,
    products: desired.map((p) => ({
      id: '', productId: p.product_id, gmvBasis: p.gmv_basis, targetGmv: p.target_gmv, baseQuantityCms: p.base_quantity_cms,
      tiers: p.tiers.map((t) => ({ order: t.order, from: t.from, to: t.to, amount: t.amount })),
    })),
  }
}

interface Side { results: { userId: string; storeId: string; productId: string; amountVnd: bigint; cmsQuantity: bigint }[]; total: bigint; candidates: number; unassigned: number }

/** Số đã công bố đi kèm dự toán: NULL toàn bộ khi chưa có run (không giả 0). */
export interface CmsRevisionPublishedRef {
  amountVnd: string | null
  runId: string | null
  byUser: Map<string, bigint> | null
  configVersion: number | null
  publishedAt: string | null
  current: boolean | null
}
export const CMS_REVISION_NO_PUBLISHED: CmsRevisionPublishedRef = { amountVnd: null, runId: null, byUser: null, configVersion: null, publishedAt: null, current: null }

/** Gộp trước / sau / đã công bố theo người + theo SP. */
export function cmsRevisionAggregate(before: Side, after: Side, published: CmsRevisionPublishedRef,
  meta: { productsBefore: number; productsAfter: number; rowsRead: number }) {
  const persons = new Map<string, { storeId: string; before: bigint; after: bigint }>()
  const touch = (u: string, s: string) => {
    let p = persons.get(u)
    if (!p) { p = { storeId: s, before: Z, after: Z }; persons.set(u, p) }
    return p
  }
  const products = new Map<string, { before: bigint; after: bigint; bq: bigint; aq: bigint }>()
  const prod = (id: string) => {
    let p = products.get(id)
    if (!p) { p = { before: Z, after: Z, bq: Z, aq: Z }; products.set(id, p) }
    return p
  }
  for (const r of before.results) { touch(r.userId, r.storeId).before += r.amountVnd; const p = prod(r.productId); p.before += r.amountVnd; p.bq += r.cmsQuantity }
  for (const r of after.results) { touch(r.userId, r.storeId).after += r.amountVnd; const p = prod(r.productId); p.after += r.amountVnd; p.aq += r.cmsQuantity }
  let up = 0, down = 0, same = 0
  const personRows: CmsRevisionImpactPerson[] = []
  for (const [u, p] of persons) {
    const d = p.after - p.before
    if (d > Z) up++; else if (d < Z) down++; else same++
    const pub = published.byUser ? published.byUser.get(u) ?? Z : null
    personRows.push({ user_id: u, store_id: p.storeId, published_vnd: pub === null ? null : pub.toString(), before_vnd: p.before.toString(), after_vnd: p.after.toString(), delta_vnd: d.toString() })
  }
  // Giảm nhiều nhất trước (super cần thấy ai bị giảm), hoà theo user_id.
  personRows.sort((a, b) => {
    const da = BigInt(a.delta_vnd), db = BigInt(b.delta_vnd)
    return da < db ? -1 : da > db ? 1 : a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0
  })
  const productRows: CmsRevisionImpactProduct[] = [...products.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, p]) => ({ product_id: id, before_vnd: p.before.toString(), after_vnd: p.after.toString(), delta_vnd: (p.after - p.before).toString(), before_qty: p.bq.toString(), after_qty: p.aq.toString() }))
  const totals: CmsRevisionImpactTotals = {
    before_vnd: before.total.toString(), after_vnd: after.total.toString(), delta_vnd: (after.total - before.total).toString(),
    published_vnd: published.amountVnd, published_run_id: published.runId,
    published_config_version: published.configVersion, published_at: published.publishedAt, published_current: published.current,
    persons: persons.size, up, down, same, products_before: meta.productsBefore, products_after: meta.productsAfter,
    rows_read: meta.rowsRead, candidates_after: after.candidates, unassigned_after: after.unassigned,
  }
  return {
    totals,
    persons: personRows.slice(0, CMS_REVISION_IMPACT_LIST_MAX),
    products: productRows.slice(0, CMS_REVISION_IMPACT_LIST_MAX),
    truncated: { persons: personRows.length > CMS_REVISION_IMPACT_LIST_MAX, products: productRows.length > CMS_REVISION_IMPACT_LIST_MAX },
  }
}

const legacySide = (o: CmsEngineOutput): Side => ({
  results: o.results.map((r) => ({ userId: r.userId, storeId: r.storeId, productId: r.productId, amountVnd: r.amountVnd, cmsQuantity: r.cmsQuantity })),
  total: o.totals.amountVnd, candidates: o.totals.candidates, unassigned: o.totals.unassigned,
})

/** Dòng lỗi thuộc danh mục (ProductID không đọc được ⇒ tính cho cả hai phía). */
const issuesFor = (issues: readonly CmsRowIssueAt[], ids: ReadonlySet<string>) =>
  issues.filter((r) => !r.ctx || r.ctx.productId === null || ids.has(r.ctx.productId))

export async function computeCmsRevisionImpact(deps: CmsRevisionImpactDeps, programId: string,
  desired: readonly CmsRevisionDesiredProduct[]): Promise<CmsRevisionImpactResult> {
  let raw: unknown
  try { raw = await deps.loadSnapshot(programId) } catch { return { ok: false, code: 'SNAPSHOT_FAILED' } }
  const contract = cmsIsContractSnapshot(raw, false)
  let snap: CmsSalesSnapshot | CmsContractSnapshot
  try {
    snap = contract ? parseCmsContractSnapshot(raw) : parseCmsSalesSnapshot(raw)
    if (snap.programId !== programId || snap.runId !== null) throw new Error('mismatch')
  } catch {
    return { ok: false, code: 'SNAPSHOT_INVALID' }
  }
  const beforeIds = new Set(snap.products.map((p) => p.productId))
  const afterIds = new Set(desired.map((p) => p.product_id))
  const union = [...new Set([...beforeIds, ...afterIds])].sort()
  const source: CmsRevisionSourceIdentity = {
    mapping_fp: snap.mappingFp, provider: 'none', rows_read: null, lines_digest: null, as_of: null,
    from_date: snap.startDate, to_date: snap.endDate, product_ids: union.length,
  }
  const base = (path: CmsRevisionImpact['path']): CmsRevisionImpact => ({
    version: CMS_REVISION_IMPACT_VERSION, status: 'error', code: null, from_config_version: snap.configVersion, path,
    computed_at: deps.now().toISOString(), totals: null, persons: [], products: [], truncated: { persons: false, products: false },
  })
  const fail = (path: CmsRevisionImpact['path'], code: string): CmsRevisionImpactResult => ({ ok: true, impact: { ...base(path), code }, source, snapshot: snap })

  const notStarted = snap.status === 'draft' || snap.todayVn < snap.startDate
  const pathOf = (): CmsRevisionImpact['path'] => (notStarted ? 'not_started' : contract ? 'contract' : 'legacy')

  // Số đã công bố của run pointer (đi riêng — không trộn vào delta cấu hình). r3 (P1-03): đọc TRƯỚC mọi nhánh (kể cả chưa tới ngày
  // bắt đầu mà đã có run) để totals.published_run_id luôn = pointer app ghim (DB preview đối chiếu); đọc thiếu / lệch / purge ⇒
  // PUBLISHED_UNAVAILABLE (status 'error', không ghi được). Chưa có run ⇒ NULL (không giả 0). Pointer còn trỏ run của version cấu hình
  // trước (đã sửa, chưa có run mới) ⇒ current false: UI gọi là bản công bố trước thay đổi, không gọi "đang công bố".
  let published: CmsRevisionPublishedRef = CMS_REVISION_NO_PUBLISHED
  if (snap.currentResultRunId) {
    try {
      const p = await deps.loadPublished(programId, snap.currentResultRunId)
      published = { amountVnd: p.amountVnd, runId: snap.currentResultRunId, byUser: p.byUser, configVersion: p.configVersion, publishedAt: p.publishedAt,
        current: p.configVersion === snap.configVersion }
    } catch {
      return fail(pathOf(), 'PUBLISHED_UNAVAILABLE')
    }
  }

  // Nháp / chưa tới ngày bắt đầu: chưa có dòng bán trong kỳ ⇒ tác động 0 THẬT (không đọc nguồn).
  if (notStarted) {
    const zero: Side = { results: [], total: Z, candidates: 0, unassigned: 0 }
    const agg = cmsRevisionAggregate(zero, zero, published, { productsBefore: beforeIds.size, productsAfter: afterIds.size, rowsRead: 0 })
    return { ok: true, impact: { ...base('not_started'), status: 'ok', ...agg }, source, snapshot: snap }
  }

  let win: { fromMicros: bigint; toMicrosExclusive: bigint }
  try { win = vnProgramWindowMicros(snap.startDate, snap.endDate) } catch { return fail(contract ? 'contract' : 'legacy', 'CONFIG_INVALID') }
  const meta = { productsBefore: beforeIds.size, productsAfter: afterIds.size }

  if (contract) {
    const cs = snap as CmsContractSnapshot
    if (cs.returnsPolicy !== 'sales_only_v1') return fail('contract', 'NET_UNSUPPORTED')
    if (cs.quantityBasis === 'cms_unit' && !deps.calcModes) return fail('contract', 'CALC_MODES_DISABLED')
    const provider = deps.contractProvider
    if (!provider) return fail('contract', 'CONTRACT_PROVIDER_MISSING')
    if (provider.kind === 'fixture' && !cs.isTest) return fail('contract', 'FIXTURE_REAL_PROGRAM')
    const asOf = deps.asOfMicros ? deps.asOfMicros() : BigInt(Date.now()) * BigInt(1000)
    const read = await provider.read({ fromMicros: win.fromMicros, toMicrosExclusive: win.toMicrosExclusive, productIds: union, asOfMicros: asOf, withReturns: false, deadlineMs: deps.deadlineMs })
    if (!read.ok) return fail('contract', `SOURCE_${read.code}`)
    if (read.asOfMicros !== asOf || read.provider !== provider.kind || read.returnsRaw !== null) return fail('contract', 'SOURCE_PIN_MISMATCH')
    const sales: CmsCalcSaleLine[] = []
    const issues: CmsRowIssueAt[] = []
    read.salesRaw.forEach((r, index) => {
      const n = normalizeSalesRow(r)
      if (n.ok) sales.push(cmsCalcSaleLine(r, n.value))
      else issues.push({ index, issues: n.issues, ctx: cmsRowIssueContext(r) })
    })
    source.provider = read.provider
    source.rows_read = read.salesRaw.length
    source.lines_digest = linesDigest(sales)
    source.as_of = asOf.toString()
    const afterSnap: CmsContractSnapshot = { ...withProducts(cs, desired), unitCms: new Map(desired.map((p) => [p.product_id, p.unit_cms])) }
    const sides: Side[] = []
    for (const [s, ids] of [[cs, beforeIds], [afterSnap, afterIds]] as const) {
      const mine = sales.filter((l) => ids.has(l.productId))
      let out
      try {
        out = computeCmsNet(cmsContractCalcInput(s, mine, [], asOf))
      } catch (e) {
        if (e instanceof CmsEngineInputError) return fail('contract', 'DUPLICATE_LINE_ID')
        if (e instanceof CmsEngineConfigError || e instanceof CmsCalcConfigError) return fail('contract', 'CONFIG_INVALID')
        return fail('contract', 'ENGINE_FAILED')
      }
      if (!out.ok) return fail('contract', `CALC_${[...new Set(out.holds.map((h) => h.code))].sort()[0]}`)
      const v = assessSalesSnapshot({
        rowsRead: read.salesRaw.length, totalRowsReported: read.salesRaw.length, pagesComplete: true, rowIssues: issuesFor(issues, ids).map((x) => x.issues),
        lineIds: mine.map((l) => l.orderLineId), candidates: out.totals.candidates, unassigned: out.totals.unassigned, previousPublishedRows: cs.previousRowsRead,
      })
      if (v.status === 'held') return fail('contract', v.reasons[0])
      sides.push({
        results: out.results.map((r) => ({ userId: r.userId, storeId: r.storeId, productId: r.productId, amountVnd: r.amountVnd, cmsQuantity: r.cmsQuantity })),
        total: out.totals.amountVnd, candidates: out.totals.candidates, unassigned: out.totals.unassigned,
      })
    }
    const agg = cmsRevisionAggregate(sides[0], sides[1], published, { ...meta, rowsRead: read.salesRaw.length })
    return { ok: true, impact: { ...base('contract'), status: 'ok', ...agg }, source, snapshot: snap }
  }

  if (!deps.table) return fail('legacy', 'SOURCE_CONFIG_MISSING')
  let beforeIn: ReturnType<typeof cmsSnapshotToEngineInput>
  let afterIn: ReturnType<typeof cmsSnapshotToEngineInput>
  try {
    beforeIn = cmsSnapshotToEngineInput(snap)
    afterIn = cmsSnapshotToEngineInput(withProducts(snap, desired))
    parseCmsEngineProgram(beforeIn.program)
    parseCmsEngineProgram(afterIn.program)
  } catch {
    return fail('legacy', 'CONFIG_INVALID')
  }
  const fetched = await fetchCmsSalesSnapshot(deps.runner, {
    table: deps.table, fromMicros: win.fromMicros, toMicrosExclusive: win.toMicrosExclusive, productIds: union, deadlineMs: deps.deadlineMs,
  })
  if (!fetched.ok) return fail('legacy', `SOURCE_${fetched.reason}`)
  source.provider = 'bq'
  source.rows_read = fetched.rowsRead
  source.lines_digest = linesDigest(fetched.lines)
  if (findDuplicates(fetched.lines.map((l) => l.orderLineId)).length) return fail('legacy', 'DUPLICATE_LINE_ID')
  const sides: Side[] = []
  for (const [input, ids] of [[beforeIn, beforeIds], [afterIn, afterIds]] as const) {
    const mine = fetched.lines.filter((l) => ids.has(l.productId))
    let out: CmsEngineOutput
    try {
      out = computeCmsProgram({ program: input.program, lines: mine, sellers: input.sellers })
    } catch (e) {
      return fail('legacy', e instanceof CmsEngineInputError ? 'DUPLICATE_LINE_ID' : 'ENGINE_FAILED')
    }
    const v = assessSalesSnapshot({
      rowsRead: fetched.rowsRead, totalRowsReported: fetched.totalRowsReported, pagesComplete: true,
      rowIssues: issuesFor(fetched.rowIssues, ids).map((r) => r.issues), lineIds: mine.map((l) => l.orderLineId),
      candidates: out.totals.candidates, unassigned: out.totals.unassigned, previousPublishedRows: snap.previousRowsRead,
    })
    if (v.status === 'held') return fail('legacy', v.reasons[0])
    if (cmsStageBoundsIssue(out, mine)) return fail('legacy', 'OVERFLOW')
    if (cmsNegativeCandidateLines(out) > 0 && cmsAdjustmentBlocksRelease(snap.isTest)) return fail('legacy', 'RETURNS_NOT_SUPPORTED')
    sides.push(legacySide(out))
  }
  const agg = cmsRevisionAggregate(sides[0], sides[1], published, { ...meta, rowsRead: fetched.rowsRead })
  return { ok: true, impact: { ...base('legacy'), status: 'ok', ...agg }, source, snapshot: snap }
}
