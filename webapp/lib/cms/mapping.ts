// CMS — map người bán (Q-207, plan §2.1): order.updated_by → email nguồn →
// public.users.email. trim + lowercase hai phía; phải khớp ĐÚNG MỘT tài khoản;
// tài khoản phải là staff thuộc nhà thuốc OS đang hoạt động. Không fallback qua
// seller_code hay số điện thoại. Không khớp ⇒ "Chưa gán dược sĩ" kèm lý do.
// Phạm vi chương trình (nhà thuốc hiện tại ∈ phạm vi) xét SAU bước này.
// Hàm thuần, không I/O.

import { normalizeCmsEmail } from './source/contract'

export interface CmsUserRef {
  id: string
  email: string | null
  role: string | null
  storeId: string | null
}

export interface CmsStoreRef {
  id: string
  storeType: string | null
  isActive: boolean | null
}

export type CmsUnassignedReason =
  | 'NO_EMAIL'            // nguồn không có email người hoàn tất đơn
  | 'NOT_FOUND'           // email không khớp tài khoản nào
  | 'MULTIPLE'            // email khớp nhiều tài khoản
  | 'SHARED_ACCOUNT'      // khớp tài khoản dùng chung QLCH (store_manager)
  | 'NOT_STAFF'           // khớp admin / SM / vai khác — không phải người hưởng
  | 'STORE_NOT_ELIGIBLE'  // staff không có nhà thuốc, nhà thuốc FS hoặc ngừng hoạt động

export type CmsSellerMatch =
  | { ok: true; userId: string; storeId: string }
  | { ok: false; reason: CmsUnassignedReason }

export interface CmsSellerIndex {
  byEmail: Map<string, CmsUserRef[]>
  stores: Map<string, CmsStoreRef>
}

export function buildSellerIndex(users: readonly CmsUserRef[], stores: readonly CmsStoreRef[]): CmsSellerIndex {
  const byEmail = new Map<string, CmsUserRef[]>()
  for (const u of users) {
    const e = normalizeCmsEmail(u.email)
    if (e === null) continue
    const list = byEmail.get(e)
    if (list) list.push(u)
    else byEmail.set(e, [u])
  }
  return { byEmail, stores: new Map(stores.map((s) => [s.id, s])) }
}

export function mapSeller(email: string | null | undefined, index: CmsSellerIndex): CmsSellerMatch {
  const e = normalizeCmsEmail(email)
  if (e === null) return { ok: false, reason: 'NO_EMAIL' }
  const hits = index.byEmail.get(e) ?? []
  if (hits.length === 0) return { ok: false, reason: 'NOT_FOUND' }
  if (hits.length > 1) return { ok: false, reason: 'MULTIPLE' }
  const u = hits[0]
  if (u.role === 'store_manager') return { ok: false, reason: 'SHARED_ACCOUNT' }
  if (u.role !== 'staff') return { ok: false, reason: 'NOT_STAFF' }
  const store = u.storeId ? index.stores.get(u.storeId) : undefined
  if (!store || store.storeType !== 'os' || store.isActive !== true) return { ok: false, reason: 'STORE_NOT_ELIGIBLE' }
  return { ok: true, userId: u.id, storeId: store.id }
}

/** Email che cho log (không ghi email đầy đủ — SPEC §7): chỉ giữ domain, "***@buymed.com". */
export function maskCmsEmail(email: string | null | undefined): string {
  const e = normalizeCmsEmail(email)
  if (e === null) return '—'
  const at = e.indexOf('@')
  if (at <= 0) return '***'
  return `***${e.slice(at)}`
}
