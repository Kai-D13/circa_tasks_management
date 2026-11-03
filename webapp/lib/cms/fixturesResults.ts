// CMS P2-c (I3) — dữ liệu GIẢ cho fixture kết quả /ui-catalog/cms-v2 (dev-only, UI_CATALOG=1). Số tính bằng CHÍNH hàm bậc engine
// (cmsProgressiveAmount / cmsQuantityOf) để chia bậc / tổng dòng khớp như snapshot thật; id / tên / nhà thuốc giả, không gọi mạng.
// Kịch bản: running (đang chạy, có SP chưa đạt target + danh mục chưa đạt + phần cộng dồn) · top (bậc cao nhất / chạm trần) ·
// held (lần cập nhật sau lỗi — giữ số cũ) · none (chưa có snapshot) · error · gone · config (danh mục đổi chờ tính lại).
import { formatCmsDecimal, parseCmsDecimal } from './decimal'
import { cmsProgressiveAmount, cmsQuantityOf } from './engine/tiers'
import { CMS_FX_PRODUCTS } from './fixtures'
import type { CmsResultsLoad, CmsUiTier } from './resultUi'
import type { CmsCatalogRowDto, CmsLineStatus, CmsResultHeaderDto, CmsResultLineDto, CmsResultRowDto, CmsResultUserDto } from './resultView'

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
export const CMS_FX_RUN = uid(9500)
export const CMS_FX_PROGRAM = uid(1)
export const CMS_FX_USERS = { A: uid(7001), B: uid(7002), C: uid(7003), D: uid(7004) }
export const CMS_FX_STORES = { S1: uid(8001), S2: uid(8002) }
export const CMS_FX_STORE_NAMES = new Map([[CMS_FX_STORES.S1, 'Nhà thuốc mẫu 01'], [CMS_FX_STORES.S2, 'Nhà thuốc mẫu 02 — tên dài để kiểm tra xuống dòng']])
const NAMES: Record<string, string> = { [CMS_FX_USERS.A]: 'Dược sĩ mẫu A', [CMS_FX_USERS.B]: 'Dược sĩ mẫu B', [CMS_FX_USERS.C]: 'Dược sĩ mẫu C — tên rất dài để kiểm tra cắt dòng', [CMS_FX_USERS.D]: 'Dược sĩ mẫu D' }
const STORE_OF: Record<string, string> = { [CMS_FX_USERS.A]: CMS_FX_STORES.S1, [CMS_FX_USERS.B]: CMS_FX_STORES.S1, [CMS_FX_USERS.C]: CMS_FX_STORES.S1, [CMS_FX_USERS.D]: CMS_FX_STORES.S2 }

const units = (v: string) => { const r = parseCmsDecimal(v); if (!r.ok) throw new Error('fx decimal'); return r.units }
const engineTiers = (t: CmsUiTier[]) => t.map((x) => ({ from: BigInt(x.from), to: x.to === null ? null : BigInt(x.to), amountVnd: BigInt(x.amount) }))
const P = CMS_FX_PRODUCTS

/** Dòng kết quả giả cho (dược sĩ, SP): lượng cơ sở + GMV; gate do caller quyết (catalog dùng dòng gate danh mục). */
function row(user: string, idx: number, base: string, gmv: string, gate: { met: boolean; metAt?: string | null; gateGmv?: string | null; target?: string | null }, lineCount: number): CmsResultRowDto {
  const p = P[idx]
  const k = units(p.baseQuantityCms)
  const q = cmsQuantityOf(units(base), k)
  const tiers = engineTiers(p.tiers)
  const last = p.tiers[p.tiers.length - 1]
  const cap = last.to === null ? null : BigInt(last.to)
  const potential = cmsProgressiveAmount(q, tiers)
  return {
    userId: user, storeId: STORE_OF[user], programProductId: p.id, productId: p.productId, gmvBasis: p.gmvBasis, baseQuantity: base, perUnit: p.baseQuantityCms,
    cmsQuantity: q.toString(), rewardedQuantity: (cap !== null && q > cap ? cap : q).toString(), capQuantity: cap === null ? null : cap.toString(),
    atCap: cap !== null && q >= cap, gmvAmount: gmv, gateGmv: gate.gateGmv ?? (p.gmvBasis === 'none' ? null : gmv), targetGmv: gate.target ?? p.targetGmv,
    gateMet: gate.met, gateMetAt: gate.met ? gate.metAt ?? null : null, potentialAmount: potential.toString(), amountVnd: (gate.met ? potential : BigInt(0)).toString(), lineCount,
  }
}

const MET_AT = '2026-11-08T03:12:45.000000Z'
function staffRows(user: string, scenario: 'running' | 'top', scale = 1): CmsResultRowDto[] {
  const m = (v: number) => String(v * scale)
  if (scenario === 'top') {
    return [
      row(user, 0, m(750), m(21000000), { met: true, metAt: MET_AT }, 8),
      row(user, 2, m(600), m(3000000), { met: true }, 6),
    ]
  }
  return [
    row(user, 0, m(420), m(12500000), { met: true, metAt: MET_AT }, 6),
    row(user, 1, m(7), m(560000), { met: false, gateGmv: m(30000000), target: '50000000' }, 4),
    row(user, 2, m(125), m(625000), { met: true }, 5),
    row(user, 3, '3.5', '4200000', { met: false }, 3),
  ]
}

function catalogRow(user: string, gmv: string, met: boolean): CmsCatalogRowDto {
  return { userId: user, storeId: STORE_OF[user], catalogGmv: gmv, targetGmv: '50000000', met, metAt: met ? MET_AT : null, lineCount: 4 }
}

function header(o: { run?: boolean; held?: boolean; config?: boolean; viewer?: CmsResultHeaderDto['viewer']; totals?: Record<string, unknown> | null } = {}): CmsResultHeaderDto {
  const run = o.run === false ? null : {
    id: CMS_FX_RUN, configVersion: 3, publishedAt: '2026-11-15T01:05:00.000000Z', sourceMaxUpdatedAt: '2026-11-15T00:58:12.000000Z', startedAt: '2026-11-15T01:00:00.000000Z',
    amountVnd: null, rowsRead: null, totals: o.totals ?? null,
  }
  return {
    programId: CMS_FX_PROGRAM, configVersion: o.config ? 4 : 3, viewer: o.viewer ?? 'staff', run,
    lastAttempt: o.held ? { status: 'held', startedAt: '2026-11-15T03:00:00.000000Z', finishedAt: '2026-11-15T03:01:10.000000Z', isCurrent: false, errorCode: 'SOURCE_TIMEOUT' }
      : run ? { status: 'ok', startedAt: run.startedAt, finishedAt: run.publishedAt, isCurrent: true, errorCode: null } : null,
    recentRuns: null,
  }
}

const users = (ids: string[]): CmsResultUserDto[] => ids.map((id) => ({ id, fullName: NAMES[id], storeId: STORE_OF[id] }))

export type CmsFxResultScenario = 'running' | 'top' | 'held' | 'none' | 'error' | 'gone' | 'config'
export const CMS_FX_RESULT_SCENARIOS: CmsFxResultScenario[] = ['running', 'top', 'held', 'none', 'error', 'gone', 'config']

/** D1 / D2 staff (một dược sĩ). */
export function cmsFxStaffResults(s: CmsFxResultScenario): CmsResultsLoad {
  if (s === 'error') return { kind: 'error' }
  if (s === 'gone') return { kind: 'gone' }
  if (s === 'none') return { kind: 'loaded', header: header({ run: false }), rows: { runId: null, results: [], catalog: [], users: [] } }
  const A = CMS_FX_USERS.A
  const rows = staffRows(A, s === 'top' ? 'top' : 'running')
  return {
    kind: 'loaded', header: header({ held: s === 'held', config: s === 'config' }),
    rows: { runId: CMS_FX_RUN, results: rows, catalog: s === 'top' ? [] : [catalogRow(A, '30000000', false)], users: users([A]) },
  }
}

/** QLCH (U19): staff hiện thuộc nhà thuốc S1 (A, B, C). */
export function cmsFxStoreResults(s: CmsFxResultScenario): CmsResultsLoad {
  if (s === 'error' || s === 'gone') return { kind: s }
  if (s === 'none') return { kind: 'loaded', header: header({ run: false, viewer: 'store_manager' }), rows: { runId: null, results: [], catalog: [], users: [] } }
  const { A, B, C } = CMS_FX_USERS
  return {
    kind: 'loaded', header: header({ held: s === 'held', config: s === 'config', viewer: 'store_manager' }),
    rows: {
      runId: CMS_FX_RUN,
      results: [...staffRows(A, 'running'), ...staffRows(B, 'top'), row(C, 0, '90', '2700000', { met: false }, 2)],
      catalog: [catalogRow(A, '30000000', false)],
      users: users([A, B, C]),
    },
  }
}

/** A3 super (toàn bộ, có nhóm Chưa gán trong totals) / SM (chỉ S1). */
export function cmsFxAdminResults(s: CmsFxResultScenario, viewer: 'super' | 'sm' = 'super'): CmsResultsLoad {
  if (s === 'error' || s === 'gone') return { kind: s }
  if (s === 'none') return { kind: 'loaded', header: header({ run: false, viewer }), rows: { runId: null, results: [], catalog: [], users: [] } }
  const { A, B, C, D } = CMS_FX_USERS
  // D (nhà thuốc S2 — ngoài phạm vi SM): danh mục ĐẠT (gate danh mục 55 tr / 50 tr), bậc 3 SP 1, SP không target 25 vỉ.
  const dRows = [
    row(D, 0, '840', '25000000', { met: true, metAt: MET_AT }, 7),
    row(D, 1, '20', '1600000', { met: true, metAt: MET_AT, gateGmv: '55000000', target: '50000000' }, 5),
    row(D, 2, '250', '1250000', { met: true }, 4),
  ]
  const results = [...staffRows(A, 'running'), ...staffRows(B, 'top'), row(C, 0, '90', '2700000', { met: false }, 2), ...(viewer === 'super' ? dRows : [])]
  const totals = viewer === 'super' ? { unassigned: 7, unassigned_gmv: '1350000', unassigned_by_reason: { NOT_FOUND: 4, SHARED_ACCOUNT: 2, NO_EMAIL: 1 } } : null
  return {
    kind: 'loaded', header: header({ held: s === 'held', config: s === 'config', viewer, totals }),
    rows: {
      runId: CMS_FX_RUN, results,
      catalog: [catalogRow(A, '30000000', false), ...(viewer === 'super' ? [catalogRow(D, '55000000', true)] : [])],
      users: users(viewer === 'super' ? [A, B, C, D] : [A, B, C]),
    },
  }
}

/**
 * Dòng lịch sử khớp các dòng kết quả: chia lượng cơ sở / GMV đều theo line_count, thứ tự thời gian tăng dần, tiền dòng =
 * A(B_sau) − A(B_trước) khi đạt gate (không đạt ⇒ 0, WAITING_GATE) — Σ tiền dòng = tiền dòng kết quả.
 */
export function cmsFxLines(rows: readonly CmsResultRowDto[]): CmsResultLineDto[] {
  const out: CmsResultLineDto[] = []
  let seq = 0
  let t = Date.parse('2026-11-02T02:00:00Z')
  for (const r of rows) {
    const p = P.find((x) => x.id === r.programProductId)!
    const tiers = engineTiers(p.tiers)
    const k = units(r.perUnit)
    const total = units(r.baseQuantity)
    const gmv = units(r.gmvAmount)
    const cap = r.capQuantity === null ? null : BigInt(r.capQuantity)
    let before = BigInt(0)
    for (let i = 0; i < r.lineCount; i++) {
      const after = i === r.lineCount - 1 ? total : (total * BigInt(i + 1)) / BigInt(r.lineCount)
      const qb = cmsQuantityOf(before, k), qa = cmsQuantityOf(after, k)
      const amt = r.gateMet ? cmsProgressiveAmount(qa, tiers) - cmsProgressiveAmount(qb, tiers) : BigInt(0)
      const status: CmsLineStatus = !r.gateMet && r.gmvBasis !== 'none' ? 'WAITING_GATE' : qa === qb ? 'ACCUMULATING' : cap !== null && qa >= cap ? 'AT_CAP' : 'RECORDED'
      const lineGmv = i === r.lineCount - 1 ? gmv - (gmv * BigInt(i)) / BigInt(r.lineCount) : (gmv * BigInt(i + 1)) / BigInt(r.lineCount) - (gmv * BigInt(i)) / BigInt(r.lineCount)
      t += 3 * 3600_000 + seq * 61_000
      out.push({
        seq: seq++, orderLineId: `OL-${String(900000 + seq)}`, orderCode: `HD${String(250000 + seq)}`, productId: r.productId, programProductId: r.programProductId,
        userId: r.userId, storeId: r.storeId, posCode: 'POS-MAU', completedAt: new Date(t).toISOString().replace(/\.\d{3}Z$/, '.000000Z'),
        quantityRaw: formatCmsDecimal(after - before), uomRaw: 'đơn vị cơ sở', baseQuantity: formatCmsDecimal(after - before), gmvAmount: formatCmsDecimal(lineGmv),
        baseBefore: formatCmsDecimal(before), baseAfter: formatCmsDecimal(after), qtyBefore: qb.toString(), qtyAfter: qa.toString(), amountVnd: amt.toString(), status,
      })
      before = after
    }
  }
  return out.sort((a, b) => a.completedAt.localeCompare(b.completedAt) || a.orderLineId.localeCompare(b.orderLineId)).map((l, i) => ({ ...l, seq: i }))
}

export const cmsFxParseScenario = (v: string | undefined): CmsFxResultScenario | null =>
  (CMS_FX_RESULT_SCENARIOS as string[]).includes(v ?? '') ? (v as CmsFxResultScenario) : null
