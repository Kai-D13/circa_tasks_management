// F-A — kiểu phản hồi route revision phía client + logic trình bày thuần (cổng nút ghi, chuỗi bậc, nhãn thay đổi). Không import server.

import type { StatusTone } from '@/components/ds/StatusBadge'
import type { CmsImportIssueSummaryItem } from '@/lib/cms/import/issueSummary'
import type { CmsPreviewGroupOk, CmsPreviewGroupRejected, CmsPreviewKCheck, CmsPreviewStats } from '@/lib/cms/importView'
import { cmsTierRange, cmsVnd } from '@/lib/cms/display'
import type { CmsRevisionImpact, CmsRevisionSourceIdentity } from './impact'
import type { CmsRevisionAction, CmsRevisionPreviewReply, CmsRevisionTier } from './model'

export interface CmsRevisionAnalysis {
  sha256: string
  format: 'tiers' | 'simple'
  configVersion: number
  quantityBasis: 'pos_base' | 'cms_unit' | null
  ignoredFromRow: number | null
  stats: CmsPreviewStats
  groupsOk: CmsPreviewGroupOk[]
  groupsRejected: CmsPreviewGroupRejected[]
  issueSummary: CmsImportIssueSummaryItem[]
  kCheck?: CmsPreviewKCheck
}

export interface CmsRevisionPreviewBody {
  ok: true
  analysis: CmsRevisionAnalysis
  revision: CmsRevisionPreviewReply
  impact: CmsRevisionImpact
  source: CmsRevisionSourceIdentity
  /** Tên dược sĩ trong danh sách tác động (super). */
  names?: Record<string, string>
}

export interface CmsRevisionErrorBody {
  ok: false
  code: string
  message: string | null
  analysis?: CmsRevisionAnalysis
  productId?: string
  expectedFormat?: string
  detectedFormat?: string
  missing?: string[]
  column?: string
  duplicate?: string[]
}

export const CMS_REVISION_ACTION_LABEL: Record<CmsRevisionAction, string> = {
  add: 'Thêm', readd: 'Thêm lại', change: 'Đổi', keep: 'Giữ nguyên', remove: 'Bỏ',
}
export const CMS_REVISION_ACTION_TONE: Record<CmsRevisionAction, StatusTone> = {
  add: 'success', readd: 'success', change: 'warning', keep: 'neutral', remove: 'danger',
}

/** "1–9 hộp: 10.000₫ · Từ 10 hộp trở lên: 15.000₫"; một bậc từ 1 ⇒ "15.000₫/hộp". Không có ⇒ "—". */
export function cmsRevisionTiersText(tiers: readonly CmsRevisionTier[] | null, unit: string | null): string {
  if (!tiers || tiers.length === 0) return '—'
  const u = unit ?? undefined
  if (tiers.length === 1 && tiers[0].from === 1 && tiers[0].to === null) return `${cmsVnd(tiers[0].amount)}/${unit ?? 'đơn vị'}`
  return [...tiers].sort((a, b) => a.order - b.order).map((t) => `${cmsTierRange(t.from, t.to, u)}: ${cmsVnd(t.amount)}`).join(' · ')
}

export function cmsRevisionSameTiers(a: readonly CmsRevisionTier[] | null, b: readonly CmsRevisionTier[] | null): boolean {
  if (!a || !b || a.length !== b.length) return a === b
  return a.every((t, i) => t.order === b[i].order && t.from === b[i].from && t.to === b[i].to && t.amount === b[i].amount)
}

/** K so theo giá trị (DB trim_scale; file có thể "10.0"). */
export function cmsRevisionSameK(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b
  const n = (x: string) => { const [i, f = ''] = x.split('.'); return `${i.replace(/^0+(?=\d)/, '')}.${f.replace(/0+$/, '')}` }
  return n(a) === n(b)
}

export type CmsRevisionCommitBlock = 'NONE' | 'DONE' | 'BUSY' | 'IMPACT' | 'DIRTY' | 'REASON' | 'ACK' | 'REMOVED'

/**
 * Cổng nút "Ghi sửa đổi": đã ghi / đang gửi ⇒ khoá; impact không hợp lệ ⇒ khoá (DB cũng chặn); còn ý định K chưa gửi lại ⇒ khoá;
 * thiếu lý do / tick (không tick sẵn) / thiếu xác nhận danh sách SP bị bỏ ⇒ khoá. Server + DB kiểm lại toàn bộ.
 */
export function cmsRevisionCommitGate(i: {
  done: boolean; busy: boolean; impactOk: boolean; dirty: boolean; reasonOk: boolean; wholePeriod: boolean; mayDecrease: boolean
  removedCount: number; removedAck: boolean
}): CmsRevisionCommitBlock {
  if (i.done) return 'DONE'
  if (i.busy) return 'BUSY'
  if (!i.impactOk) return 'IMPACT'
  if (i.dirty) return 'DIRTY'
  if (!i.reasonOk) return 'REASON'
  if (!i.wholePeriod || !i.mayDecrease) return 'ACK'
  if (i.removedCount > 0 && !i.removedAck) return 'REMOVED'
  return 'NONE'
}

export const CMS_REVISION_BLOCK_TEXT: Record<Exclude<CmsRevisionCommitBlock, 'NONE'>, string> = {
  DONE: 'Đã ghi sửa đổi',
  BUSY: 'Đang xử lý…',
  IMPACT: 'Chưa có dự toán tác động hợp lệ — không ghi được',
  DIRTY: 'Còn xác nhận K chưa gửi — bấm Kiểm tra lại với xác nhận',
  REASON: 'Nhập lý do sửa (10–1.000 ký tự)',
  ACK: 'Tick đủ hai xác nhận',
  REMOVED: 'Xác nhận danh sách sản phẩm bị bỏ',
}

/** Dấu của chuỗi số nguyên (bigint) — 'up' / 'down' / 'same'. */
export function cmsDeltaSign(v: string): 'up' | 'down' | 'same' {
  return v.startsWith('-') ? 'down' : /^0+$/.test(v) ? 'same' : 'up'
}

/** "+15.000₫" / "−15.000₫" / "0₫". */
export function cmsDeltaVnd(v: string): string {
  const s = cmsDeltaSign(v)
  if (s === 'same') return cmsVnd('0')
  return s === 'up' ? `+${cmsVnd(v)}` : `−${cmsVnd(v.slice(1))}`
}
