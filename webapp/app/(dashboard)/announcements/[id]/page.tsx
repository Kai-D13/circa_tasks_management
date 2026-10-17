import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { MarkAnnouncementRead } from '@/components/announcements/MarkAnnouncementRead'
import { AnnouncementAdminActions } from '@/components/announcements/AnnouncementAdminActions'
import { AnnouncementDetailView } from '@/components/announcements/AnnouncementDetailView'
import type { OtherViewer, ReadStatsData } from '@/components/announcements/ReadStatsPanel'
import { buildStoreReadGroups, UNASSIGNED_STORE, type ReadMember } from '@/lib/announcements/readStats'
import { isSuperAdminEmail } from '@/lib/authz'

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
    return <AnnouncementDetailView data={{ kind: 'error' }} />
  }
  if (!ann) notFound()

  const cover = (assets ?? []).find((a) => a.kind === 'cover')?.url as string | undefined
  const carousel = (assets ?? []).filter((a) => a.kind === 'carousel').map((a) => a.url as string)
  const creator = (ann.creator as unknown as { full_name: string } | null)?.full_name ?? '—'
  // Edit/Delete only for the creator or a super admin (matches RLS ann_update/delete).
  const canManage = isAdmin && (ann.created_by === user.id || isSuperAdminEmail(user.email))

  // ── Admin read-receipt tree: audience (Store → Staff) read/unread ──────────
  // UI v2 A2: CÙNG ba truy vấn + cùng tập mẫu số như trước. Mới: lấy `error` của chính các truy vấn này — một truy vấn
  // lỗi ⇒ thống kê = lỗi (không dựng 0/0 hay số thiếu — PM P1). Sắp xếp/lọc chuyển sang lib/announcements/readStats.
  let stats: ReadStatsData | null = null
  if (isAdmin) {
    let targetStoreIds: string[] | null = null
    let statsErr: string | null = null
    if (ann.visibility === 'stores') {
      const { data: st, error: stErr } = await supabase.from('announcement_stores').select('store_id').eq('announcement_id', id)
      if (stErr) statsErr = `announcement_stores: ${stErr.message}`
      targetStoreIds = (st ?? []).map((s) => s.store_id as string)
    }
    let memQ = supabase.from('users')
      .select('id, full_name, store_id, stores!users_store_id_fkey(name)')
      .in('role', ['staff', 'store_manager'])
    if (targetStoreIds) memQ = memQ.in('store_id', targetStoreIds.length ? targetStoreIds : ['00000000-0000-0000-0000-000000000000'])
    const [{ data: members, error: memErr }, { data: reads, error: readsErr }] = await Promise.all([
      memQ,
      supabase.from('announcement_reads')
        .select('user_id, read_at, users(full_name, role, department_id, departments(name))')
        .eq('announcement_id', id),
    ])
    if (memErr) statsErr = `${statsErr ? `${statsErr}; ` : ''}users: ${memErr.message}`
    if (readsErr) statsErr = `${statsErr ? `${statsErr}; ` : ''}announcement_reads: ${readsErr.message}`

    if (statsErr) {
      console.error('[announcements] read stats query failed:', statsErr)
      stats = { kind: 'error' }
    } else {
      const readMap = new Map<string, string>()
      for (const r of reads ?? []) readMap.set(r.user_id as string, r.read_at as string)

      const mem: ReadMember[] = (members ?? []).map((m) => ({
        id: m.id as string,
        full_name: (m.full_name as string) ?? '—',
        store_id: (m.store_id as string | null) ?? null,
        store: (m.stores as unknown as { name: string } | null)?.name ?? UNASSIGNED_STORE,
      }))
      const { groups, total, read } = buildStoreReadGroups(mem, readMap)

      // Viewers outside the staff/store audience (other admins/PIC/super) — log role + dept.
      const memberIds = new Set(mem.map((m) => m.id))
      const others: OtherViewer[] = (reads ?? [])
        .filter((r) => !memberIds.has(r.user_id as string))
        .map((r) => {
          const u = r.users as unknown as { full_name: string; role: string; departments: { name: string } | null } | null
          return { user_id: r.user_id as string, full_name: u?.full_name ?? '—', role: u?.role ?? '', dept: u?.departments?.name ?? null, read_at: r.read_at as string }
        })
        .sort((a, b) => b.read_at.localeCompare(a.read_at))
      stats = { kind: 'ok', read, total, groups, others }
    }
  }

  return (
    <>
      {!isAdmin && <MarkAnnouncementRead announcementId={id} />}
      <AnnouncementDetailView
        data={{
          kind: 'ok',
          title: ann.title as string,
          creatorName: creator,
          publishedAt: ann.published_at as string,
          body: (ann.body as string | null) ?? null,
          coverUrl: cover ?? null,
          carousel,
        }}
        actions={canManage ? <AnnouncementAdminActions announcementId={id} /> : undefined}
        stats={stats}
      />
    </>
  )
}
