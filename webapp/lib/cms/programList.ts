// CMS P1-c — dựng model A1 từ danh sách chương trình (thuần; route + fixture dùng chung một nguồn). Đếm theo TOÀN TẬP
// người xem đọc được (không theo tab); thống kê thật loại chương trình QA (U20); tìm theo tên (không phân biệt hoa
// thường) hoặc ĐÚNG ProductID.
import { CMS_STATUS_ORDER, cmsDisplayStatus, cmsStatusesFor, type CmsDisplayStatus } from './programStatus'
import type { CmsAdminListItem } from './server/catalog'

export type CmsListFilter = 'all' | CmsDisplayStatus

export interface CmsListModelRow {
  id: string
  name: string
  display: CmsDisplayStatus
  startDate: string
  endDate: string
  isTest: boolean
  productCount: number
  lastImport: CmsAdminListItem['lastImport']
}

export function cmsParseListFilter(raw: string | undefined, canManage: boolean): CmsListFilter {
  const allowed = new Set<string>(cmsStatusesFor(canManage))
  return raw && allowed.has(raw) ? (raw as CmsDisplayStatus) : 'all'
}

export function cmsBuildListModel(items: CmsAdminListItem[], o: { canManage: boolean; today: string; filter: CmsListFilter; q: string }) {
  const all = items.map((p) => ({
    id: p.id, name: p.name, display: cmsDisplayStatus(p, o.today), startDate: p.startDate, endDate: p.endDate, isTest: p.isTest,
    productCount: p.productCount, lastImport: o.canManage ? p.lastImport : null, productIds: p.productIds,
  }))
  const counts = { all: all.length } as Record<CmsListFilter, number>
  for (const s of CMS_STATUS_ORDER) counts[s] = all.filter((r) => r.display === s).length
  const q = o.q.trim()
  const ql = q.toLowerCase()
  const rows: CmsListModelRow[] = all
    .filter((r) => o.filter === 'all' || r.display === o.filter)
    .filter((r) => !q || r.name.toLowerCase().includes(ql) || r.productIds.includes(q))
    .map(({ productIds: _ids, ...r }) => { void _ids; return r })
  const running = all.filter((r) => r.display === 'running' && !r.isTest)
  const stats = { running: running.length, productsRunning: new Set(running.flatMap((r) => r.productIds)).size }
  return { counts, rows, hasAny: all.length > 0, stats }
}
