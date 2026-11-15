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
import { CMS_CALC_CONTRACT_VERSION, CMS_QUANTITY_POLICY_VERSION, type CmsQuantityBasis, type CmsReturnsPolicy } from './calc/policy'
import { CMS_RETURN_STATUS_DICTIONARY_VERSION } from './calc/returns'
import { CMS_UNIT_KEY_VERSION } from './unitKey'

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

// ── Hợp đồng của run (CMS-CALC-RET-2 P5.2) ───────────────────────────────────
/**
 * Khối `contract` ghim TỪ RUN (cms__run_contract, migration 130) — nhãn cách tính / chính sách trả của số liệu đang xem KHÔNG suy từ
 * cờ hiện tại hay cấu hình chương trình. Run legacy (calc_contract_version NULL) = pos_base + sales_only_v1 (T11). Version hợp đồng /
 * luật lượng lạ ⇒ throw (app không diễn giải được run đó — không hiện số với nhãn sai).
 */
export interface CmsRunContractDto {
  legacy: boolean
  calcContractVersion: string | null
  quantityBasis: CmsQuantityBasis
  quantityPolicyVersion: string | null
  returnsPolicy: CmsReturnsPolicy
  unitKeyVersion: string | null
  statusDictionaryVersion: string | null
  /** µs UTC — as_of của snapshot trả (chỉ run net). */
  returnsAsOf: string | null
}
export const CMS_LEGACY_RUN_CONTRACT: CmsRunContractDto = Object.freeze({
  legacy: true, calcContractVersion: null, quantityBasis: 'pos_base', quantityPolicyVersion: null, returnsPolicy: 'sales_only_v1',
  unitKeyVersion: null, statusDictionaryVersion: null, returnsAsOf: null,
})

export function parseCmsRunContract(raw: unknown): CmsRunContractDto {
  if (!isObj(raw)) throw new CmsResultDtoError('contract')
  const legacy = b(raw, 'legacy')
  const basis = s(raw, 'quantity_basis')
  const policy = s(raw, 'returns_policy')
  if (legacy) {
    if (basis !== 'pos_base' || policy !== 'sales_only_v1' || raw.calc_contract_version !== null) throw new CmsResultDtoError('contract.legacy')
    return CMS_LEGACY_RUN_CONTRACT
  }
  if (basis !== 'pos_base' && basis !== 'cms_unit') throw new CmsResultDtoError('contract.quantity_basis')
  if (policy !== 'sales_only_v1' && policy !== 'net_returns_v1') throw new CmsResultDtoError('contract.returns_policy')
  // CHECK cms_sync_runs_contract_shape (130): run contract ⇔ cms_unit HOẶC net_returns_v1 — pos_base + sales_only chỉ có run legacy.
  if (basis === 'pos_base' && policy === 'sales_only_v1') throw new CmsResultDtoError('contract.legacy_shape')
  const ccv = s(raw, 'calc_contract_version')
  if (ccv !== CMS_CALC_CONTRACT_VERSION) throw new CmsResultDtoError('contract.calc_contract_version')
  const qpv = s(raw, 'quantity_policy_version')
  if (qpv !== CMS_QUANTITY_POLICY_VERSION[basis]) throw new CmsResultDtoError('contract.quantity_policy_version')
  // Cùng CHECK: mọi run contract (kể cả sales-only / pos_base net) ghi đủ unit_key_version + status_dictionary_version.
  const ukv = sn(raw, 'unit_key_version')
  if (ukv !== CMS_UNIT_KEY_VERSION) throw new CmsResultDtoError('contract.unit_key_version')
  const sdv = sn(raw, 'status_dictionary_version')
  if (sdv !== CMS_RETURN_STATUS_DICTIONARY_VERSION) throw new CmsResultDtoError('contract.status_dictionary_version')
  const asOf = sn(raw, 'returns_as_of', TS_RE)
  if ((policy === 'net_returns_v1') !== (asOf !== null)) throw new CmsResultDtoError('contract.returns_as_of')
  return {
    legacy: false, calcContractVersion: ccv, quantityBasis: basis, quantityPolicyVersion: qpv, returnsPolicy: policy,
    unitKeyVersion: ukv, statusDictionaryVersion: sdv, returnsAsOf: asOf,
  }
}

// ── Header ──────────────────────────────────────────────────────────────────
export type CmsResultViewer = 'super' | 'sm' | 'store_manager' | 'staff' | 'admin' | null
export interface CmsResultRunDto {
  id: string; configVersion: number; publishedAt: string | null; sourceMaxUpdatedAt: string | null; startedAt: string | null
  /** Chỉ super. */
  amountVnd: string | null; rowsRead: number | null; totals: Record<string, unknown> | null
  /** P5.2: hợp đồng của run (v1 ⇒ legacy — reader 122 chỉ trả run legacy). */
  contract: CmsRunContractDto
  /** P5.2 (super, run net): số dòng phiếu trả đã đọc + kết luận sổ trả của lượt. */
  returnsRowsRead?: number | null
  ledger?: CmsRunLedgerDto | null
}
/**
 * Khối sổ trả của run (chỉ super, reader v2). Mig 130 `cms__publish_contract` ghi verdict CLEAN + set_hash cho MỌI run contract, nhưng chỉ
 * run `net_returns_v1` có lần kiểm sổ (`ledger_eval_seq`) ⇒ run contract `sales_only_v1` trả `eval_seq: null` TƯỜNG MINH (FINAL-QA7-01).
 */
export interface CmsRunLedgerDto { verdict: string; evalSeq: number | null; setHash: string | null }
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

/**
 * Khối `run.ledger` của header v2 (FINAL-QA7-01). Vắng / null ⇒ null (run legacy, vai không super — hợp đồng cũ). Có khối ⇒ trường
 * `eval_seq` PHẢI có mặt; null chỉ hợp lệ khi run là contract `sales_only_v1` (hình dạng DB 130: CLEAN + set_hash, không lần kiểm sổ).
 * Run net / legacy có null, thiếu trường, số âm / lẻ / chuỗi ⇒ lỗi DTO như trước — không đổi null thành 0, không bỏ khối để né parse.
 */
function parseRunLedger(raw: unknown, contract: CmsRunContractDto): CmsRunLedgerDto | null {
  if (raw === null || raw === undefined) return null
  if (!isObj(raw)) throw new CmsResultDtoError('run.ledger')
  if (!Object.prototype.hasOwnProperty.call(raw, 'eval_seq')) throw new CmsResultDtoError('eval_seq')
  const salesOnlyContract = !contract.legacy && contract.returnsPolicy === 'sales_only_v1'
  const evalSeq = raw.eval_seq === null && salesOnlyContract ? null : n(raw, 'eval_seq')
  return { verdict: s(raw, 'verdict'), evalSeq, setHash: sn(raw, 'set_hash') }
}

/** `v` = phiên bản reader (1 = RPC 122, 2 = rpc_cms_result_header_v2). */
export function parseCmsResultHeader(raw: unknown, v: 1 | 2 = 1): CmsResultHeaderDto {
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
      // Hợp đồng của CHÍNH run parse trước — khối ledger kiểm theo hợp đồng đó (không theo cờ / cấu hình chương trình hiện tại).
      const contract = v === 2 ? parseCmsRunContract(run.contract) : CMS_LEGACY_RUN_CONTRACT
      return {
        id: s(run, 'id', UUID_RE), configVersion: n(run, 'config_version'), publishedAt: sn(run, 'published_at', TS_RE),
        sourceMaxUpdatedAt: sn(run, 'source_max_updated_at', TS_RE), startedAt: sn(run, 'started_at', TS_RE),
        amountVnd: sn(run, 'amount_vnd', INT_RE), rowsRead: nn(run, 'rows_read'), totals: isObj(run.totals) ? run.totals : null,
        contract,
        ...(v === 2 ? {
          returnsRowsRead: nn(run, 'returns_rows_read'),
          ledger: parseRunLedger(run.ledger, contract),
        } : {}),
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
  /** Run legacy: B. Run contract: B THẬT ròng (mọi dòng bán − mọi trả) — KHÔNG phải căn cứ Q ở cách tính nguyên. */
  baseQuantity: string; perUnit: string; cmsQuantity: string; rewardedQuantity: string; capQuantity: string | null; atCap: boolean
  /** Run contract: GMV ròng. */
  gmvAmount: string; gateGmv: string | null; targetGmv: string | null; gateMet: boolean; gateMetAt: string | null
  potentialAmount: string; amountVnd: string; lineCount: number
  /**
   * P5.2: lượng căn cứ Q (Q = floor(eligibleBase / K)). Legacy = baseQuantity; run contract = B đủ ròng (cách tính nguyên chỉ dòng đúng
   * đơn vị + nguyên; cộng dồn = B thật ròng). Mọi trình bày Q / phần lẻ / "nếu bán thêm" dùng trường này.
   */
  eligibleBase: string
  /** P5.2: cột ròng (chỉ run contract). */
  net: CmsResultNetDto | null
}
export interface CmsResultNetDto {
  saleBase: string; returnBase: string; eligibleSaleBase: string; eligibleReturnBase: string; countedSaleQty: string | null
  saleGmv: string; returnGmv: string; returnCount: number
}
export interface CmsCatalogRowDto { userId: string; storeId: string; catalogGmv: string; targetGmv: string; met: boolean; metAt: string | null; lineCount: number }
export interface CmsResultUserDto { id: string; fullName: string; storeId: string | null }
export interface CmsResultRowsDto {
  runId: string | null; results: CmsResultRowDto[]; catalog: CmsCatalogRowDto[]; users: CmsResultUserDto[]
  /** P5.2: hợp đồng của run (null ⇔ chưa có run). */
  contract: CmsRunContractDto | null
}

const parseNet = (x: unknown): CmsResultNetDto | null => {
  if (x === null || x === undefined) return null
  if (!isObj(x)) throw new CmsResultDtoError('net')
  return {
    saleBase: s(x, 'sale_base', DEC_RE), returnBase: s(x, 'return_base', DEC_RE), eligibleSaleBase: s(x, 'eligible_sale_base', DEC_RE),
    eligibleReturnBase: s(x, 'eligible_return_base', DEC_RE), countedSaleQty: sn(x, 'counted_sale_qty', INT_RE),
    saleGmv: s(x, 'sale_gmv', DEC_RE), returnGmv: s(x, 'return_gmv', DEC_RE), returnCount: n(x, 'return_count'),
  }
}

export function parseCmsResultRows(raw: unknown, v: 1 | 2 = 1): CmsResultRowsDto {
  if (!isObj(raw)) throw new CmsResultDtoError('rows')
  const runId = sn(raw, 'run_id', UUID_RE)
  const contract = runId === null ? null : v === 2 ? parseCmsRunContract(raw.contract) : CMS_LEGACY_RUN_CONTRACT
  const basis = (o: Obj) => {
    const v = s(o, 'gmv_basis')
    if (v !== 'product' && v !== 'catalog' && v !== 'none') throw new CmsResultDtoError('gmv_basis')
    return v
  }
  return {
    runId,
    contract,
    results: arr(raw, 'results').map((r) => {
      if (!isObj(r)) throw new CmsResultDtoError('results[]')
      const net = v === 2 ? parseNet(r.net) : null
      // Run contract luôn có cột ròng; run legacy không có (DB CHECK) — lệch ⇒ DTO sai.
      if (contract && !contract.legacy && net === null) throw new CmsResultDtoError('results[].net')
      if (contract?.legacy && net !== null) throw new CmsResultDtoError('results[].net.legacy')
      const base = s(r, 'base_quantity', DEC_RE)
      return {
        eligibleBase: net ? (() => { const x = r.net as Obj; return s(x, 'eligible_base', DEC_RE) })() : base,
        net,
        userId: s(r, 'user_id', UUID_RE), storeId: s(r, 'store_id', UUID_RE), programProductId: s(r, 'program_product_id', UUID_RE),
        productId: s(r, 'product_id'), gmvBasis: basis(r), baseQuantity: base, perUnit: s(r, 'per_unit', DEC_RE),
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
/** NOT_COUNTED / RETURN_REDUCED / RETURN_NO_CHANGE chỉ có ở run contract (sự kiện v2). */
export type CmsLineStatus = 'WAITING_GATE' | 'ACCUMULATING' | 'RECORDED' | 'AT_CAP' | 'ADJUSTMENT' | 'NOT_COUNTED' | 'RETURN_REDUCED' | 'RETURN_NO_CHANGE'
export type CmsQuantityClass = 'POS_BASE' | 'COUNTED' | 'OTHER_UNIT' | 'FRACTIONAL_QUANTITY' | 'ZERO_QUANTITY'
export interface CmsResultLineDto {
  seq: number; orderLineId: string; orderCode: string; productId: string; programProductId: string; userId: string; storeId: string
  /** RETURN: null (không trả POS / số lượng / đơn vị gốc cho vai thường). */
  posCode: string | null
  /** Thời điểm sự kiện (SALE: hoàn tất đơn; RETURN: ghi nhận trả). */
  completedAt: string; quantityRaw: string | null; uomRaw: string | null
  /** Thay đổi lượng cơ sở THẬT của sự kiện (RETURN âm). */
  baseQuantity: string
  /** Thay đổi GMV (RETURN âm). */
  gmvAmount: string
  /** Lượng căn cứ Q trước / sau sự kiện (legacy: B; cách tính nguyên: B đủ). */
  baseBefore: string; baseAfter: string; qtyBefore: string; qtyAfter: string; amountVnd: string; status: CmsLineStatus
  /** P5.2: loại sự kiện (v1 ⇒ SALE). */
  kind: 'SALE' | 'RETURN'
  /** P5.2: lớp lượng của dòng bán gốc (v1 ⇒ POS_BASE). */
  quantityClass: CmsQuantityClass
  /** P5.2: thay đổi lượng đủ điều kiện (căn cứ Q) của sự kiện. */
  eligibleDelta: string
  /** P5.2: mã phiếu trả (chỉ RETURN). */
  returnCode: string | null
  eventKey: string
}
export interface CmsResultLinesPage { runId: string; rows: CmsResultLineDto[]; nextAfterSeq: number | null; contract: CmsRunContractDto }
const LINE_STATUS = new Set(['WAITING_GATE', 'ACCUMULATING', 'RECORDED', 'AT_CAP', 'ADJUSTMENT'])
const EVENT_STATUS = new Set(['WAITING_GATE', 'ACCUMULATING', 'RECORDED', 'NOT_COUNTED', 'RETURN_REDUCED', 'RETURN_NO_CHANGE'])
const QCLASS = new Set(['POS_BASE', 'COUNTED', 'OTHER_UNIT', 'FRACTIONAL_QUANTITY', 'ZERO_QUANTITY'])

/**
 * Sự kiện v2 (rpc_cms_result_events_v2): SALE + RETURN; run legacy ⇒ SALE lớp POS_BASE với trạng thái của 122 (nhánh legacy trả nguyên
 * cms_result_lines.status — kể cả AT_CAP / ADJUSTMENT của snapshot cũ / QA; db-reviewer 14/11 P2-1). Run contract chỉ nhận tập sự kiện 130.
 */
export function parseCmsResultEvents(raw: unknown): CmsResultLinesPage {
  if (!isObj(raw)) throw new CmsResultDtoError('events')
  const next = raw.next_after_seq
  if (next !== null && next !== undefined && (typeof next !== 'number' || !Number.isSafeInteger(next) || next < 0)) throw new CmsResultDtoError('next_after_seq')
  const contract = parseCmsRunContract(raw.contract)
  return {
    runId: s(raw, 'run_id', UUID_RE),
    nextAfterSeq: (next ?? null) as number | null,
    contract,
    rows: arr(raw, 'rows').map((x) => {
      if (!isObj(x)) throw new CmsResultDtoError('rows[]')
      const st = s(x, 'status')
      if (!(contract.legacy ? LINE_STATUS : EVENT_STATUS).has(st)) throw new CmsResultDtoError('status')
      const kind = s(x, 'kind')
      if (kind !== 'SALE' && kind !== 'RETURN') throw new CmsResultDtoError('kind')
      const qc = s(x, 'quantity_class')
      if (!QCLASS.has(qc)) throw new CmsResultDtoError('quantity_class')
      if (contract.legacy && (kind !== 'SALE' || qc !== 'POS_BASE')) throw new CmsResultDtoError('legacy.kind')
      if ((kind === 'RETURN') !== st.startsWith('RETURN_') && !(kind === 'RETURN' && st === 'WAITING_GATE')) throw new CmsResultDtoError('kind.status')
      return {
        seq: n(x, 'seq'), orderLineId: s(x, 'order_line_id'), orderCode: s(x, 'order_code'), productId: s(x, 'product_id'),
        programProductId: s(x, 'program_product_id', UUID_RE), userId: s(x, 'user_id', UUID_RE), storeId: s(x, 'store_id', UUID_RE),
        posCode: sn(x, 'pos_code'), completedAt: s(x, 'event_at', TS_RE), quantityRaw: sn(x, 'quantity_raw'), uomRaw: sn(x, 'uom_raw'),
        baseQuantity: s(x, 'base_delta', DEC_RE), gmvAmount: s(x, 'gmv_delta', DEC_RE), baseBefore: s(x, 'eligible_before', DEC_RE),
        baseAfter: s(x, 'eligible_after', DEC_RE), qtyBefore: s(x, 'qty_before', INT_RE), qtyAfter: s(x, 'qty_after', INT_RE),
        amountVnd: s(x, 'amount_vnd', SINT_RE), status: st as CmsLineStatus,
        kind, quantityClass: qc as CmsQuantityClass, eligibleDelta: s(x, 'eligible_delta', DEC_RE),
        returnCode: kind === 'RETURN' ? sn(x, 'return_code') : null, eventKey: s(x, 'event_key'),
      }
    }),
  }
}

export function parseCmsResultLines(raw: unknown): CmsResultLinesPage {
  if (!isObj(raw)) throw new CmsResultDtoError('lines')
  const next = raw.next_after_seq
  if (next !== null && next !== undefined && (typeof next !== 'number' || !Number.isSafeInteger(next) || next < 0)) throw new CmsResultDtoError('next_after_seq')
  return {
    runId: s(raw, 'run_id', UUID_RE),
    nextAfterSeq: (next ?? null) as number | null,
    contract: CMS_LEGACY_RUN_CONTRACT,
    rows: arr(raw, 'rows').map((x) => {
      if (!isObj(x)) throw new CmsResultDtoError('rows[]')
      const st = s(x, 'status')
      if (!LINE_STATUS.has(st)) throw new CmsResultDtoError('status')
      const base = s(x, 'base_quantity', DEC_RE)
      return {
        kind: 'SALE' as const, quantityClass: 'POS_BASE' as const, eligibleDelta: base, returnCode: null,
        eventKey: `SALE:${s(x, 'order_line_id')}`,
        seq: n(x, 'seq'), orderLineId: s(x, 'order_line_id'), orderCode: s(x, 'order_code'), productId: s(x, 'product_id'),
        programProductId: s(x, 'program_product_id', UUID_RE), userId: s(x, 'user_id', UUID_RE), storeId: s(x, 'store_id', UUID_RE),
        posCode: sn(x, 'pos_code'), completedAt: s(x, 'completed_at', TS_RE), quantityRaw: sn(x, 'quantity_raw'), uomRaw: sn(x, 'uom_raw'),
        baseQuantity: base, gmvAmount: s(x, 'gmv_amount', DEC_RE), baseBefore: s(x, 'base_before', DEC_RE),
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
export function cmsFractionUnits(r: Pick<CmsResultRowDto, 'baseQuantity' | 'perUnit' | 'cmsQuantity'> & Partial<Pick<CmsResultRowDto, 'eligibleBase'>>): bigint {
  // P5.2: Q = floor(B đủ / K) ⇒ phần chưa đủ 1 đơn vị tính trên B đủ (run legacy: B đủ = B).
  const b = units(r.eligibleBase ?? r.baseQuantity)
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
