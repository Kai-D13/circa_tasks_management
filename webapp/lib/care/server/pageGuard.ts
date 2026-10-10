import 'server-only'
import { notFound, redirect } from 'next/navigation'
import { isCareEnabled } from '@/lib/care/flags'
import { getCareViewAccess } from './browse'
import type { CarePermissions } from '@/lib/care/browse'

// Cổng chung cho trang browser CRM (SPEC B3 §1): cờ OFF ⇒ 404 TRƯỚC mọi đọc dữ liệu;
// chưa đăng nhập ⇒ /login; DB chưa có 114 ⇒ 'unavailable' (trang hiện thông báo,
// không dựng bảng rỗng như dữ liệu thật); không quyền xem ⇒ 404 (không lộ chức năng).
export async function requireCareViewer(): Promise<{ kind: 'unavailable' } | { kind: 'ok'; userId: string; perms: CarePermissions }> {
  if (!isCareEnabled()) notFound()
  const v = await getCareViewAccess()
  if (v.kind === 'anonymous') redirect('/login')
  if (v.kind === 'unavailable') return { kind: 'unavailable' }
  if (!v.perms.canView) notFound()
  return { kind: 'ok', userId: v.userId, perms: v.perms }
}
