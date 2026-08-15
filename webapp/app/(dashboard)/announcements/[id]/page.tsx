import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { RichText } from '@/components/tasks/RichText'
import { MarkAnnouncementRead } from '@/components/announcements/MarkAnnouncementRead'
import { AnnouncementAdminActions } from '@/components/announcements/AnnouncementAdminActions'
import { Card, CardContent } from '@/components/ui/card'
import { formatDateTime } from '@/lib/dateUtils'
import { isSuperAdminEmail } from '@/lib/authz'
import { Megaphone, Check } from 'lucide-react'

interface Member { id: string; full_name: string; store_id: string | null; store: string }
interface OtherViewer { user_id: string; full_name: string; role: string; dept: string | null; read_at: string }

export default async function AnnouncementDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  const isAdmin = profile?.role === 'admin'

  const [{ data: ann, error: annErr }, { data: assets }] = await Promise.all([
    supabase.from('announcements')
      .select('id, title, body, visibility, published_at, created_by, creator:users!created_by(full_name)')
      .eq('id', id).maybeSingle(),
    supabase.from('announcement_assets').select('kind, url, position').eq('announcement_id', id).order('position'),
  ])
  if (annErr) {
    console.error('[announcements] detail query failed:', annErr.message)
    return <div className="p-4 md:p-6 max-w-2xl mx-auto"><p className="text-sm text-destructive">Không tải được thông báo. Vui lòng thử lại sau hoặc báo Admin.</p></div>
  }
  if (!ann) notFound()

  const cover = (assets ?? []).find((a) => a.kind === 'cover')?.url as string | undefined
  const carousel = (assets ?? []).filter((a) => a.kind === 'carousel').map((a) => a.url as string)
  const creator = (ann.creator as unknown as { full_name: string } | null)?.full_name ?? '—'
  // Edit/Delete only for the creator or a super admin (matches RLS ann_update/delete).
  const canManage = isAdmin && (ann.created_by === user.id || isSuperAdminEmail(user.email))

  // ── Admin read-receipt tree: audience (Store → Staff) read/unread ──────────
  let storeGroups: { store: string; members: (Member & { readAt: string | null })[]; read: number }[] = []
  let totalAudience = 0, totalRead = 0
  let otherViewers: OtherViewer[] = []
  if (isAdmin) {
    let targetStoreIds: string[] | null = null
    if (ann.visibility === 'stores') {
      const { data: st } = await supabase.from('announcement_stores').select('store_id').eq('announcement_id', id)
      targetStoreIds = (st ?? []).map((s) => s.store_id as string)
    }
    let memQ = supabase.from('users')
      .select('id, full_name, store_id, stores!users_store_id_fkey(name)')
      .in('role', ['staff', 'store_manager'])
    if (targetStoreIds) memQ = memQ.in('store_id', targetStoreIds.length ? targetStoreIds : ['00000000-0000-0000-0000-000000000000'])
    const [{ data: members }, { data: reads }] = await Promise.all([
      memQ,
      supabase.from('announcement_reads')
        .select('user_id, read_at, users(full_name, role, department_id, departments(name))')
        .eq('announcement_id', id),
    ])
    const readMap = new Map<string, string>()
    for (const r of reads ?? []) readMap.set(r.user_id as string, r.read_at as string)

    const mem: Member[] = (members ?? []).map((m) => ({
      id: m.id as string,
      full_name: (m.full_name as string) ?? '—',
      store_id: (m.store_id as string | null) ?? null,
      store: (m.stores as unknown as { name: string } | null)?.name ?? 'Chưa gán cửa hàng',
    }))
    totalAudience = mem.length
    const byStore = new Map<string, (Member & { readAt: string | null })[]>()
    for (const m of mem) {
      const readAt = readMap.get(m.id) ?? null
      if (readAt) totalRead++
      const arr = byStore.get(m.store) ?? []
      arr.push({ ...m, readAt })
      byStore.set(m.store, arr)
    }
    storeGroups = [...byStore.entries()]
      .map(([store, members]) => ({ store, members: members.sort((a, b) => a.full_name.localeCompare(b.full_name, 'vi')), read: members.filter((x) => x.readAt).length }))
      .sort((a, b) => a.store.localeCompare(b.store, 'vi'))

    // Viewers outside the staff/store audience (other admins/PIC/super) — log role + dept.
    const memberIds = new Set(mem.map((m) => m.id))
    otherViewers = (reads ?? [])
      .filter((r) => !memberIds.has(r.user_id as string))
      .map((r) => {
        const u = r.users as unknown as { full_name: string; role: string; departments: { name: string } | null } | null
        return { user_id: r.user_id as string, full_name: u?.full_name ?? '—', role: u?.role ?? '', dept: u?.departments?.name ?? null, read_at: r.read_at as string }
      })
      .sort((a, b) => b.read_at.localeCompare(a.read_at))
  }

  const ROLE_VI: Record<string, string> = { admin: 'Admin', sm: 'SM', store_manager: 'Quản lý', staff: 'Nhân viên' }

  return (
    <div className="p-4 md:p-6 max-w-2xl mx-auto space-y-4">
      {!isAdmin && <MarkAnnouncementRead announcementId={id} />}

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-primary">
            <Megaphone className="h-5 w-5" />
            <span className="text-xs uppercase tracking-wide font-medium">Thông báo</span>
          </div>
          <h1 className="text-xl font-semibold mt-1">{ann.title}</h1>
          <p className="text-xs text-muted-foreground mt-1">{creator} · {formatDateTime(ann.published_at)}</p>
        </div>
        {canManage && <AnnouncementAdminActions announcementId={id} />}
      </div>

      {cover && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={cover} alt="" className="w-full rounded-lg border object-cover max-h-72" />
      )}

      {(ann.body || carousel.length > 0) && (
        <Card><CardContent className="py-4 space-y-3">
          {ann.body && <RichText value={ann.body} />}
          {carousel.length > 0 && (
            <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
              {carousel.map((url) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={url} src={url} alt="" className="h-40 rounded border object-cover shrink-0" />
              ))}
            </div>
          )}
        </CardContent></Card>
      )}

      {isAdmin && (
        <Card><CardContent className="py-4">
          <p className="text-sm font-medium mb-3">Đã xem: {totalRead}/{totalAudience} <span className="text-muted-foreground font-normal">(đối tượng nhận)</span></p>
          {storeGroups.length === 0 ? (
            <p className="text-sm text-muted-foreground">Không có đối tượng nhận.</p>
          ) : (
            <div className="space-y-1.5">
              {storeGroups.map((g) => (
                <details key={g.store} className="rounded border">
                  <summary className="flex items-center justify-between px-3 py-2 cursor-pointer text-sm font-medium">
                    <span>{g.store}</span>
                    <span className={g.read === g.members.length ? 'text-green-600' : 'text-muted-foreground'}>{g.read}/{g.members.length} đã xem</span>
                  </summary>
                  <ul className="px-3 pb-2 text-sm divide-y">
                    {g.members.map((m) => (
                      <li key={m.id} className="flex items-center justify-between py-1.5">
                        <span className="flex items-center gap-1.5">
                          {m.readAt ? <Check className="h-3.5 w-3.5 text-green-600" /> : <span className="h-3.5 w-3.5 inline-block rounded-full border border-muted-foreground/40" />}
                          <span className={m.readAt ? '' : 'text-muted-foreground'}>{m.full_name}</span>
                        </span>
                        <span className="text-xs text-muted-foreground">{m.readAt ? formatDateTime(m.readAt) : 'Chưa xem'}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              ))}
            </div>
          )}

          {otherViewers.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Người khác đã xem ({otherViewers.length})</p>
              <ul className="text-sm divide-y">
                {otherViewers.map((v) => (
                  <li key={v.user_id} className="flex items-center justify-between py-1.5">
                    <span>{v.full_name} <span className="text-xs text-muted-foreground">· {ROLE_VI[v.role] ?? v.role}{v.dept ? ` · ${v.dept}` : ''}</span></span>
                    <span className="text-xs text-muted-foreground">{formatDateTime(v.read_at)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent></Card>
      )}
    </div>
  )
}
