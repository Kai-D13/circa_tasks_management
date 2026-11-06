// CMS P2-c — DTO đọc kết quả (RPC 122 rpc_cms_result_*) + view-model cho A1 / A3 / D1 / D2 / D3 / XLSX (kế hoạch PM 02/11 §6;
// docs/cms/SPEC.md §8). Hàm thuần, không I/O:
//  · parse*: kiểm shape jsonb (số dạng chuỗi, không float) — sai ⇒ throw CmsResultDtoError (server trả mã chung, không 0 giả).
//  · tổng hợp CỘNG số engine đã tính (tiền theo dược sĩ × SP) — KHÔNG áp lại bậc / gate trên tổng (CMS-Q1); chỉ số Q-212
//    dùng lại summarizeCmsProgram của engine P2-a.
//  · "Nếu bán thêm" dùng cùng hàm bậc của engine (cmsProgressiveAmount) — không công thức thứ hai.

import { CMS_DEC_FACTOR, parseCmsDecimal } from './decimal'
import type { CmsEngineProductResult } from './engine/compute'
import { summarizeCmsProgram, type CmsProgramSummary } from './engine/summary'
import { parsePositiveInt, type CmsEngineTier } from './engine/config'
import { cmsProgressiveAmount, cmsQuantityOf } from './engine/tiers'

const ZERO = BigInt(0)

export class CmsResultDtoError extends Error {
  constructor(detail: string) {
    super(`CMS kết quả không hợp lệ: ${detail}`)
    this.name = 'CmsResultDtoError'
  }
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const INT_RE = /^(0|[1-9][0-9]{0,18})$/
const SINT_RE = /^-?(0|[1-9][0-9]{0,18})$/
const DEC_RE = /^-?[0-9]{1,35}(\.[0-9]{1,9})?$/
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/

function s(o: Obj, k: string, re?: RegExp): string {
  const v = o[k]
  if (typeof v !== 'string' || (re && !re.test(v))) throw new CmsResultDtoError(k)
  return v
}
function sn(o: Obj, k: string, re?: RegExp): string | null {
  const v = o[k]
  return v === null || v === undefined ? null : s(o, k, re)
}
function b(o: Obj, k: string): boolean {
  if (typeof o[k] !== 'boolean') throw new CmsResultDtoError(k)
  return o[k] as boolean
}
function n(o: Obj, k: string): number {
  const v = o[k]
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new CmsResultDtoError(k)
  return v
}
function nn(o: Obj, k: string): number | null {
  return o[k] === null || o[k] === undefined ? null : n(o, k)
}
function arr(o: Obj, k: string): unknown[] {
  if (!Array.isArray(o[k])) throw new CmsResultDtoError(k)
  return o[k] as unknown[]
}

// ── Header ──────────────────────────────────────────────────────────────────
export type CmsResultViewer = 'super' | 'sm' | 'store_manager' | 'staff' | 'admin' | null
export interface CmsResultRunDto {
  id: string; configVersion: number; publishedAt: string | null; sourceMaxUpdatedAt: string | null; startedAt: string | null
  /** Chỉ super. */
  amountVnd: string | null; rowsRead: number | null; totals: Record<string, unknown> | null
}
export interface CmsResultAttemptDto { status: 'running' | 'ok' | 'held' | 'error'; startedAt: string | null; finishedAt: string | null; isCurrent: boolean; errorCode: string | null }
export interface CmsResultHeaderDto {
  programId: string
  configVersion: number
  viewer: CmsResultViewer
  run: CmsResultRunDto | null
  lastAttempt: CmsResultAttemptDto | null
  /** Chỉ super. */
  recentRuns: Array<{ id: string; status: string; errorCode: string | null; startedAt: string | null; finishedAt: string | null; rowsRead: number | null; amountVnd: string | null; configVersion: number; purged: boolean }> | null
}

export function parseCmsResultHeader(raw: unknown): CmsResultHeaderDto {
  if (!isObj(raw)) throw new CmsResultDtoError('header')
  const run = raw.run
  const last = raw.last_attempt
  const viewer = raw.viewer
  if (viewer !== null && !['super', 'sm', 'store_manager', 'staff', 'admin'].includes(viewer as string)) throw new CmsResultDtoError('viewer')
  const rr = raw.recent_runs
  return {
    programId: s(raw, 'program_id', UUID_RE),
    configVersion: n(raw, 'config_version'),
    viewer: viewer as CmsResultViewer,
    run: run === null || run === undefined ? null : (() => {
      if (!isObj(run)) throw new CmsResultDtoError('run')
      return {
        id: s(run, 'id', UUID_RE), configVersion: n(run, 'config_version'), publishedAt: sn(run, 'published_at', TS_RE),
        sourceMaxUpdatedAt: sn(run, 'source_max_updated_at', TS_RE), startedAt: sn(run, 'started_at', TS_RE),
        amountVnd: sn(run, 'amount_vnd', INT_RE), rowsRead: nn(run, 'rows_read'), totals: isObj(run.totals) ? run.totals : null,
      }
    })(),
    lastAttempt: last === null || last === undefined ? null : (() => {
      if (!isObj(last)) throw new CmsResultDtoError('last_attempt')
      const st = s(last, 'status')
      if (!['running', 'ok', 'held', 'error'].includes(st)) throw new CmsResultDtoError('last_attempt.status')
      return { status: st as CmsResultAttemptDto['status'], startedAt: sn(last, 'started_at', TS_RE), finishedAt: sn(last, 'finished_at', TS_RE),
        isCurrent: b(last, 'is_current'), errorCode: sn(last, 'error_code') }
    })(),
    recentRuns: rr === null || rr === undefined ? null : (rr as unknown[]).map((x) => {
      if (!isObj(x)) throw new CmsResultDtoError('recent_runs[]')
      return { id: s(x, 'id', UUID_RE), status: s(x, 'status'), errorCode: sn(x, 'error_code'), startedAt: sn(x, 'started_at', TS_RE),
        finishedAt: sn(x, 'finished_at', TS_RE), rowsRead: nn(x, 'rows_read'), amountVnd: sn(x, 'amount_vnd', INT_RE),
        configVersion: n(x, 'config_version'), purged: b(x, 'purged') }
    }),
  }
}

/**
 * Trạng thái dữ liệu cho UI (kế hoạch PM §6.2): chưa có / có / đang giữ bản cũ vì lượt sau lỗi / cấu hình đã đổi chờ tính lại /
 * `config_reset` — CMS-Q-220 (migration 125): đổi cấu hình bỏ trần đã VÔ HIỆU pointer kết quả (không hiện tiền theo trần cũ như
 * tiền hiện hành) nhưng chương trình đã từng có lần công bố ⇒ "Chưa có số liệu sau thay đổi cấu hình" tới khi tính lại, không 0₫ giả.
 * Publish luôn đặt pointer ⇒ không pointer mà có lần công bố 'ok' chỉ xảy ra khi pointer bị vô hiệu hoá.
 */
export type CmsResultState = 'none' | 'ok' | 'held_old' | 'config_pending' | 'config_reset'
export function cmsResultState(h: CmsResultHeaderDto): CmsResultState {
  if (!h.run) return h.lastAttempt?.status === 'ok' || (h.recentRuns ?? []).some((r) => r.status === 'ok') ? 'config_reset' : 'none'
  if (h.lastAttempt && !h.lastAttempt.isCurrent && (h.lastAttempt.status === 'held' || h.lastAttempt.status === 'error')) return 'held_old'
  if (h.configVersion !== h.run.configVersion) return 'config_pending'
  return 'ok'
}

/**
 * Run LỊCH SỬ có trần số lượng (cấu hình trước CMS-Q-220, snapshot đã đóng băng): có dòng kết quả mang cap_quantity / at_cap hoặc
 * dòng đơn AT_CAP. Run tính mới luôn false (engine ghi cap null / atCap false, không sinh AT_CAP). Chỉ dùng để HIỂN THỊ đúng snapshot
 * cũ (cột trần XLSX, nhãn lịch sử) — không phải cho phép cấu hình mới có trần.
 */
export function cmsRunHasLegacyCap(rows: readonly Pick<CmsResultRowDto, 'capQuantity' | 'atCap'>[], lines: readonly Pick<CmsResultLineDto, 'status'>[] = []): boolean {
  return rows.some((r) => r.capQuantity !== null || r.atCap) || lines.some((l) => l.status === 'AT_CAP')
}

/** Chữ khi CHƯA có run hiện hành (D1 / D2 / lịch sử): phân biệt "chưa tính lần nào" với "vừa đổi cấu hình, chờ tính lại". */
export const CMS_NO_RUN_TEXT = 'Chưa có số liệu — hệ thống chưa tính lần nào'
export const CMS_CONFIG_RESET_TEXT = 'Chưa có số liệu sau thay đổi cấu hình — hệ thống sẽ tính lại ở lượt tiếp theo'
export function cmsNoRunText(h: CmsResultHeaderDto): string {
  return cmsResultState(h) === 'config_reset' ? CMS_CONFIG_RESET_TEXT : CMS_NO_RUN_TEXT
}

// ── Rows ────────────────────────────────────────────────────────────────────
export interface CmsResultRowDto {
  userId: string; storeId: string; programProductId: string; productId: string; gmvBasis: 'product' | 'catalog' | 'none'
  baseQuantity: string; perUnit: string; cmsQuantity: string; rewardedQuantity: string; capQuantity: string | null; atCap: boolean
  gmvAmount: string; gateGmv: string | null; targetGmv: string | null; gateMet: boolean; gateMetAt: string | null
  potentialAmount: string; amountVnd: string; lineCount: number
}
export interface CmsCatalogRowDto { userId: string; storeId: string; catalogGmv: string; targetGmv: string; met: boolean; metAt: string | null; lineCount: number }
export interface CmsResultUserDto { id: string; fullName: string; storeId: string | null }
export interface CmsResultRowsDto { runId: string | null; results: CmsResultRowDto[]; catalog: CmsCatalogRowDto[]; users: CmsResultUserDto[] }

export function parseCmsResultRows(raw: unknown): CmsResultRowsDto {
  if (!isObj(raw)) throw new CmsResultDtoError('rows')
  const basis = (o: Obj) => {
    const v = s(o, 'gmv_basis')
    if (v !== 'product' && v !== 'catalog' && v !== 'none') throw new CmsResultDtoError('gmv_basis')
    return v
  }
  return {
    runId: sn(raw, 'run_id', UUID_RE),
    results: arr(raw, 'results').map((r) => {
      if (!isObj(r)) throw new CmsResultDtoError('results[]')
      return {
        userId: s(r, 'user_id', UUID_RE), storeId: s(r, 'store_id', UUID_RE), programProductId: s(r, 'program_product_id', UUID_RE),
        productId: s(r, 'product_id'), gmvBasis: basis(r), baseQuantity: s(r, 'base_quantity', DEC_RE), perUnit: s(r, 'per_unit', DEC_RE),
        cmsQuantity: s(r, 'cms_quantity', INT_RE), rewardedQuantity: s(r, 'rewarded_quantity', INT_RE), capQuantity: sn(r, 'cap_quantity', INT_RE),
        atCap: b(r, 'at_cap'), gmvAmount: s(r, 'gmv_amount', DEC_RE), gateGmv: sn(r, 'gate_gmv', DEC_RE), targetGmv: sn(r, 'target_gmv', INT_RE),
        gateMet: b(r, 'gate_met'), gateMetAt: sn(r, 'gate_met_at', TS_RE), potentialAmount: s(r, 'potential_amount', INT_RE),
        amountVnd: s(r, 'amount_vnd', INT_RE), lineCount: n(r, 'line_count'),
      }
    }),
    catalog: arr(raw, 'catalog').map((c) => {
      if (!isObj(c)) throw new CmsResultDtoError('catalog[]')
      return { userId: s(c, 'user_id', UUID_RE), storeId: s(c, 'store_id', UUID_RE), catalogGmv: s(c, 'catalog_gmv', DEC_RE),
        targetGmv: s(c, 'target_gmv', INT_RE), met: b(c, 'met'), metAt: sn(c, 'met_at', TS_RE), lineCount: n(c, 'line_count') }
    }),
    users: arr(raw, 'users').map((u) => {
      if (!isObj(u)) throw new CmsResultDtoError('users[]')
      return { id: s(u, 'id', UUID_RE), fullName: s(u, 'full_name'), storeId: sn(u, 'store_id', UUID_RE) }
    }),
  }
}

// ── Lines (D3 / XLSX) ───────────────────────────────────────────────────────
export type CmsLineStatus = 'WAITING_GATE' | 'ACCUMULATING' | 'RECORDED' | 'AT_CAP' | 'ADJUSTMENT'
export interface CmsResultLineDto {
  seq: number; orderLineId: string; orderCode: string; productId: string; programProductId: string; userId: string; storeId: string
  posCode: string | null; completedAt: string; quantityRaw: string | null; uomRaw: string | null; baseQuantity: string; gmvAmount: string
  baseBefore: string; baseAfter: string; qtyBefore: string; qtyAfter: string; amountVnd: string; status: CmsLineStatus
}
export interface CmsResultLinesPage { runId: string; rows: CmsResultLineDto[]; nextAfterSeq: number | null }
const LINE_STATUS = new Set(['WAITING_GATE', 'ACCUMULATING', 'RECORDED', 'AT_CAP', 'ADJUSTMENT'])

export function parseCmsResultLines(raw: unknown): CmsResultLinesPage {
  if (!isObj(raw)) throw new CmsResultDtoError('lines')
  const next = raw.next_after_seq
  if (next !== null && next !== undefined && (typeof next !== 'number' || !Number.isSafeInteger(next) || next < 0)) throw new CmsResultDtoError('next_after_seq')
  return {
    runId: s(raw, 'run_id', UUID_RE),
    nextAfterSeq: (next ?? null) as number | null,
    rows: arr(raw, 'rows').map((x) => {
      if (!isObj(x)) throw new CmsResultDtoError('rows[]')
      const st = s(x, 'status')
      if (!LINE_STATUS.has(st)) throw new CmsResultDtoError('status')
      return {
        seq: n(x, 'seq'), orderLineId: s(x, 'order_line_id'), orderCode: s(x, 'order_code'), productId: s(x, 'product_id'),
        programProductId: s(x, 'program_product_id', UUID_RE), userId: s(x, 'user_id', UUID_RE), storeId: s(x, 'store_id', UUID_RE),
        posCode: sn(x, 'pos_code'), completedAt: s(x, 'completed_at', TS_RE), quantityRaw: sn(x, 'quantity_raw'), uomRaw: sn(x, 'uom_raw'),
        baseQuantity: s(x, 'base_quantity', DEC_RE), gmvAmount: s(x, 'gmv_amount', DEC_RE), baseBefore: s(x, 'base_before', DEC_RE),
        baseAfter: s(x, 'base_after', DEC_RE), qtyBefore: s(x, 'qty_before', INT_RE), qtyAfter: s(x, 'qty_after', INT_RE),
        amountVnd: s(x, 'amount_vnd', SINT_RE), status: st as CmsLineStatus,
      }
    }),
  }
}

// ── Tổng hợp (cộng số engine, không áp lại bậc) ────────────────────────────
const units = (d: string): bigint => {
  const r = parseCmsDecimal(d, { allowNegative: true })
  if (!r.ok) throw new CmsResultDtoError('decimal')
  return r.units
}

/** DTO ⇒ shape kết quả engine (để dùng lại summarizeCmsProgram / cmsAmountByStore — không tính lại tiền). */
export function cmsResultRowToEngine(r: CmsResultRowDto): CmsEngineProductResult {
  return {
    userId: r.userId, storeId: r.storeId, productId: r.productId, gmvBasis: r.gmvBasis,
    baseQuantityUnits: units(r.baseQuantity), perUnitUnits: units(r.perUnit), cmsQuantity: BigInt(r.cmsQuantity),
    rewardedQuantity: BigInt(r.rewardedQuantity), capQuantity: r.capQuantity === null ? null : BigInt(r.capQuantity), atCap: r.atCap,
    gmvUnits: units(r.gmvAmount),
    gate: { gateGmvUnits: r.gateGmv === null ? null : units(r.gateGmv), targetVnd: r.targetGmv === null ? null : BigInt(r.targetGmv), met: r.gateMet, metAtMicros: null },
    potentialAmountVnd: BigInt(r.potentialAmount), amountVnd: BigInt(r.amountVnd), lineCount: r.lineCount,
  }
}

export function cmsResultSummary(rows: readonly CmsResultRowDto[], o: { productIds: readonly string[]; eligibleStaffIds?: readonly string[] | null }): CmsProgramSummary {
  return summarizeCmsProgram(rows.map(cmsResultRowToEngine), o)
}

export interface CmsProductAggregate {
  programProductId: string
  productId: string
  /** Σ tiền CMS (VND) của các dược sĩ trong phạm vi người xem. */
  amountVnd: bigint
  /** Σ lượng cơ sở (scale 9) — số lượng thực tế = Σ B / K (K cùng SP). */
  baseUnits: bigint
  perUnitUnits: bigint
  /** Σ Q (số đơn vị CMS nguyên đủ xét của từng người — không floor lại trên tổng). */
  cmsQuantity: bigint
  gmvUnits: bigint
  staffWithSales: number
  staffAchieved: number
}

export function cmsAggregateByProduct(rows: readonly CmsResultRowDto[]): CmsProductAggregate[] {
  const m = new Map<string, CmsProductAggregate>()
  for (const r of rows) {
    const a = m.get(r.programProductId) ?? {
      programProductId: r.programProductId, productId: r.productId, amountVnd: ZERO, baseUnits: ZERO, perUnitUnits: units(r.perUnit),
      cmsQuantity: ZERO, gmvUnits: ZERO, staffWithSales: 0, staffAchieved: 0,
    }
    a.amountVnd += BigInt(r.amountVnd)
    a.baseUnits += units(r.baseQuantity)
    a.cmsQuantity += BigInt(r.cmsQuantity)
    a.gmvUnits += units(r.gmvAmount)
    if (BigInt(r.cmsQuantity) >= BigInt(1)) a.staffWithSales += 1
    if (r.gateMet && BigInt(r.amountVnd) > ZERO) a.staffAchieved += 1
    m.set(r.programProductId, a)
  }
  return [...m.values()]
}

export interface CmsStaffAggregate { userId: string; fullName: string | null; storeId: string | null; amountVnd: bigint; productsWithCms: number; products: number }

/** Theo dược sĩ (A3 tab Dược sĩ, tổng QLCH / SM): cộng tiền cá nhân đã áp gate / bậc riêng. storeId = nhà thuốc HIỆN TẠI (users). */
export function cmsAggregateByStaff(rows: readonly CmsResultRowDto[], users: readonly CmsResultUserDto[]): CmsStaffAggregate[] {
  const u = new Map(users.map((x) => [x.id, x]))
  const m = new Map<string, CmsStaffAggregate>()
  for (const r of rows) {
    const a = m.get(r.userId) ?? { userId: r.userId, fullName: u.get(r.userId)?.fullName ?? null, storeId: u.get(r.userId)?.storeId ?? null,
      amountVnd: ZERO, productsWithCms: 0, products: 0 }
    a.amountVnd += BigInt(r.amountVnd)
    a.products += 1
    if (BigInt(r.amountVnd) > ZERO) a.productsWithCms += 1
    m.set(r.userId, a)
  }
  return [...m.values()].sort((x, y) => (x.amountVnd === y.amountVnd ? (x.fullName ?? '').localeCompare(y.fullName ?? '', 'vi') : x.amountVnd > y.amountVnd ? -1 : 1))
}

export function cmsTotalAmount(rows: readonly CmsResultRowDto[]): bigint {
  return rows.reduce((sum, r) => sum + BigInt(r.amountVnd), ZERO)
}

/** Phần đang cộng dồn (lượng cơ sở chưa đủ một đơn vị CMS): max(0, B) − Q·K, scale 9. */
export function cmsFractionUnits(r: Pick<CmsResultRowDto, 'baseQuantity' | 'perUnit' | 'cmsQuantity'>): bigint {
  const b = units(r.baseQuantity)
  const k = units(r.perUnit)
  const rest = (b > ZERO ? b : ZERO) - BigInt(r.cmsQuantity) * k
  return rest > ZERO ? rest : ZERO
}

/**
 * "Nếu bán thêm" (D2): thêm `extraUnits` đơn vị CMS vào lượng hiện tại ⇒ CMS tăng thêm bao nhiêu, dùng CÙNG hàm bậc engine.
 * Gate chưa đạt ⇒ trả potential (ghi rõ ở UI là "khi đạt target"). Trần ⇒ phần vượt không thêm CMS.
 */
export function cmsWhatIf(o: { baseQuantity: string; perUnit: string; tiers: readonly { from: number; to: number | null; amount: string }[]; extraUnits: number }): { amountNowVnd: bigint; amountAfterVnd: bigint; deltaVnd: bigint } {
  const tiers: CmsEngineTier[] = o.tiers.map((t) => {
    const amount = parsePositiveInt(t.amount)
    if (amount === null) throw new CmsResultDtoError('tier.amount')
    return { from: BigInt(t.from), to: t.to === null ? null : BigInt(t.to), amountVnd: amount }
  })
  const k = units(o.perUnit)
  const qNow = cmsQuantityOf(units(o.baseQuantity), k)
  const extra = BigInt(Math.max(0, Math.trunc(o.extraUnits)))
  const now = cmsProgressiveAmount(qNow, tiers)
  const after = cmsProgressiveAmount(qNow + extra, tiers)
  return { amountNowVnd: now, amountAfterVnd: after, deltaVnd: after - now }
}

/** Số lượng thực tế để hiển thị: B / K (chuỗi thập phân tối đa 2 chữ số, cắt — chỉ hiển thị, không dùng tính tiền). */
export function cmsActualQuantityText(baseQuantity: string, perUnit: string): string {
  const b = units(baseQuantity)
  const k = units(perUnit)
  if (k <= ZERO) return '—'
  const neg = b < ZERO
  const x = ((neg ? -b : b) * BigInt(100)) / k
  const int = x / BigInt(100)
  const frac = (x % BigInt(100)).toString().padStart(2, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${int}${frac ? `,${frac}` : ''}`
}

export const CMS_UNITS_FACTOR = CMS_DEC_FACTOR
