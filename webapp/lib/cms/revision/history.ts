// F-A — DTO lịch sử sửa chương trình (RPC 131 super-only: danh sách / chi tiết / số trước sửa). Thuần. Parser fail-closed: dòng lạ ⇒
// null cho cả phản hồi (trang hiện lỗi, không hiện số đoán). Số tiền giữ dạng chuỗi số nguyên (không qua number JS).

import { parseCmsRevisionDiff, type CmsRevisionDiff, type CmsRevisionTier } from './model'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const nn = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const INT_RE = /^-?[0-9]{1,20}$/
const NUM_RE = /^-?[0-9]{1,30}(\.[0-9]{1,9})?$/
const s = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const int = (v: unknown): string | null => (typeof v === 'string' && INT_RE.test(v) ? v : null)

export type CmsArchiveMode = 'none' | 'copied' | 'reused'
export interface CmsRevisionArchiveHead { mode: CmsArchiveMode; runId: string | null; runConfigVersion: number | null; rows: number | null; amountVnd: string | null }

function parseArchiveHead(v: unknown): CmsRevisionArchiveHead | null {
  if (!isObj(v)) return null
  if (v.mode !== 'none' && v.mode !== 'copied' && v.mode !== 'reused') return null
  return {
    mode: v.mode, runId: s(v.run_id), runConfigVersion: nn(v.run_config_version) ? v.run_config_version : null,
    rows: nn(v.rows) ? v.rows : null, amountVnd: int(v.amount_vnd),
  }
}

export interface CmsImpactTotalsView {
  beforeVnd: string; afterVnd: string; deltaVnd: string; publishedVnd: string | null; publishedRunId: string | null
  persons: number; up: number; down: number; same: number; productsBefore: number; productsAfter: number
}

export function parseCmsImpactTotals(v: unknown): CmsImpactTotalsView | null {
  if (!isObj(v)) return null
  const b = int(v.before_vnd), a = int(v.after_vnd), d = int(v.delta_vnd)
  if (b === null || a === null || d === null) return null
  for (const k of ['persons', 'up', 'down', 'same', 'products_before', 'products_after']) if (!nn(v[k])) return null
  return {
    beforeVnd: b, afterVnd: a, deltaVnd: d, publishedVnd: int(v.published_vnd), publishedRunId: s(v.published_run_id),
    persons: v.persons as number, up: v.up as number, down: v.down as number, same: v.same as number,
    productsBefore: v.products_before as number, productsAfter: v.products_after as number,
  }
}

export interface CmsRevisionListItem {
  id: string
  fromConfigVersion: number
  toConfigVersion: number
  committedAt: string | null
  committedByName: string | null
  reason: string
  counts: { add: number; readd: number; change: number; keep: number; remove: number; productsAfter: number }
  impact: CmsImpactTotalsView | null
  archive: CmsRevisionArchiveHead
}

export function parseCmsRevisionList(raw: unknown): CmsRevisionListItem[] | null {
  if (!Array.isArray(raw)) return null
  const out: CmsRevisionListItem[] = []
  for (const r of raw) {
    if (!isObj(r) || typeof r.id !== 'string' || !nn(r.from_config_version) || !nn(r.to_config_version) || typeof r.reason !== 'string' || !isObj(r.counts)) return null
    const c = r.counts
    for (const k of ['add', 'readd', 'change', 'keep', 'remove', 'products_after']) if (!nn(c[k])) return null
    const archive = parseArchiveHead(r.archive)
    if (!archive) return null
    out.push({
      id: r.id, fromConfigVersion: r.from_config_version, toConfigVersion: r.to_config_version, committedAt: s(r.committed_at),
      committedByName: s(r.committed_by_name), reason: r.reason,
      counts: { add: c.add as number, readd: c.readd as number, change: c.change as number, keep: c.keep as number, remove: c.remove as number, productsAfter: c.products_after as number },
      impact: r.impact === null || r.impact === undefined ? null : parseCmsImpactTotals(r.impact), archive,
    })
  }
  return out
}

export interface CmsRevisionDetail {
  id: string
  programId: string
  fromConfigVersion: number
  toConfigVersion: number
  committedAt: string | null
  committedByName: string | null
  reason: string
  fileSha256: string
  diff: CmsRevisionDiff
  impact: { status: string; code: string | null; path: string | null; computedAt: string | null; totals: CmsImpactTotalsView | null; truncated: boolean }
  source: { provider: string | null; rowsRead: number | null; asOf: string | null; fromDate: string | null; toDate: string | null; productIds: number | null; linesDigest: string | null }
  archive: CmsRevisionArchiveHead
}

export function parseCmsRevisionDetail(raw: unknown): CmsRevisionDetail | null {
  if (!isObj(raw) || typeof raw.id !== 'string' || typeof raw.program_id !== 'string' || !nn(raw.from_config_version) || !nn(raw.to_config_version)
      || typeof raw.reason !== 'string' || typeof raw.file_sha256 !== 'string') return null
  const diff = parseCmsRevisionDiff(raw.diff)
  const archive = parseArchiveHead(raw.archive)
  if (!diff || !archive || !isObj(raw.impact) || !isObj(raw.source)) return null
  const im = raw.impact, src = raw.source
  const tr = isObj(im.truncated) && (im.truncated.persons === true || im.truncated.products === true)
  return {
    id: raw.id, programId: raw.program_id, fromConfigVersion: raw.from_config_version, toConfigVersion: raw.to_config_version,
    committedAt: s(raw.committed_at), committedByName: s(raw.committed_by_name), reason: raw.reason, fileSha256: raw.file_sha256, diff,
    impact: {
      status: typeof im.status === 'string' ? im.status : 'error', code: s(im.code), path: s(im.path), computedAt: s(im.computed_at),
      totals: im.totals === null || im.totals === undefined ? null : parseCmsImpactTotals(im.totals), truncated: tr,
    },
    source: {
      provider: s(src.provider), rowsRead: nn(src.rows_read) ? src.rows_read : null, asOf: s(src.as_of), fromDate: s(src.from_date),
      toDate: s(src.to_date), productIds: nn(src.product_ids) ? src.product_ids : null, linesDigest: s(src.lines_digest),
    },
    archive,
  }
}

export interface CmsRevisionArchiveRow {
  userId: string
  fullName: string | null
  storeId: string | null
  productId: string
  /** K của chính run (không phải K hiện hành). */
  perUnit: string | null
  configBasis: 'exact' | 'unchanged_since_run' | 'unknown'
  unitCms: string | null
  tiers: CmsRevisionTier[] | null
  cmsQuantity: string | null
  amountVnd: string
  gateMet: boolean | null
}

export interface CmsRevisionArchivePage { mode: CmsArchiveMode; runId: string | null; runConfigVersion: number | null; total: number; amountVnd: string | null; rows: CmsRevisionArchiveRow[] }

export function parseCmsRevisionArchive(raw: unknown): CmsRevisionArchivePage | null {
  if (!isObj(raw) || (raw.mode !== 'none' && raw.mode !== 'copied' && raw.mode !== 'reused') || !nn(raw.total) || !Array.isArray(raw.rows)) return null
  const rows: CmsRevisionArchiveRow[] = []
  for (const r of raw.rows) {
    if (!isObj(r) || typeof r.user_id !== 'string' || typeof r.product_id !== 'string' || int(r.amount_vnd) === null) return null
    const cb = r.config_basis
    if (cb !== 'exact' && cb !== 'unchanged_since_run' && cb !== 'unknown') return null
    let tiers: CmsRevisionTier[] | null = null
    if (Array.isArray(r.tiers)) {
      tiers = []
      for (const t of r.tiers) {
        if (!isObj(t) || !nn(t.order) || !nn(t.from) || !(t.to === null || nn(t.to)) || typeof t.amount !== 'string') return null
        tiers.push({ order: t.order, from: t.from, to: t.to as number | null, amount: t.amount })
      }
    }
    rows.push({
      userId: r.user_id, fullName: s(r.full_name), storeId: s(r.store_id), productId: r.product_id,
      perUnit: typeof r.per_unit === 'string' && NUM_RE.test(r.per_unit) ? r.per_unit : null, configBasis: cb, unitCms: s(r.unit_cms), tiers,
      cmsQuantity: int(r.cms_quantity), amountVnd: r.amount_vnd as string, gateMet: typeof r.gate_met === 'boolean' ? r.gate_met : null,
    })
  }
  return {
    mode: raw.mode, runId: s(raw.run_id), runConfigVersion: nn(raw.run_config_version) ? raw.run_config_version : null,
    total: raw.total, amountVnd: int(raw.amount_vnd), rows,
  }
}
