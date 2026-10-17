import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { AnnouncementsListView } from '@/components/announcements/AnnouncementsListView'
import type { AnnouncementCardData } from '@/components/announcements/AnnouncementCard'
import { redirectIfFsStaff } from '@/lib/fs/isolation'

// Bảng tin / Thông báo — read-only broadcasts (migration 063). RLS scopes which
// announcements each role sees; admins see all + can create.
export default async function AnnouncementsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const { data: profile } = await supabase.from('users').select('role, store_id').eq('id', user.id).single()
  await redirectIfFsStaff(supabase, profile) // FS staff never see OS surfaces
  const isAdmin = profile?.role === 'admin'

  // Expiry is enforced in RLS (ann_select) — non-admin never receive expired
  // rows; admins see all (to manage), with an "Hết hạn" tag below.
  const { data: anns, error: annErr } = await supabase
    .from('announcements')
    .select('id, title, excerpt, visibility, published_at, expires_at, creator:users!created_by(full_name)')
    .order('published_at', { ascending: false })
    .limit(100)
  if (annErr) {
    // Surface (don't read a broken migration/RLS as "no announcements").
    console.error('[announcements] list query failed:', annErr.message)
    return <AnnouncementsListView canCreate={isAdmin} state={{ kind: 'error' }} now={new Date()} />
  }
  const list = anns ?? []

  // Unread highlight for non-admin viewers. If the reads query fails, DON'T mark
  // everything "Mới" (misleading) — skip the badge entirely.
  let readIds = new Set<string>()
  let readsOk = true
  if (!isAdmin && list.length) {
    const { data: reads, error: readsErr } = await supabase
      .from('announcement_reads')
      .select('announcement_id')
      .in('announcement_id', list.map((a) => a.id))
    if (readsErr) {
      console.error('[announcements] reads query failed:', readsErr.message)
      readsOk = false
    } else {
      readIds = new Set((reads ?? []).map((r) => r.announcement_id))
    }
  }

  // Cover thumbnails for the feed (same RLS path the detail page uses). One
  // indexed IN query over ≤100 ids; on failure just skip thumbnails (mirror the
  // reads-query posture) — the card degrades to text-only.
  const coverByAnn = new Map<string, string>()
  if (list.length) {
    const { data: covers, error: coverErr } = await supabase
      .from('announcement_assets')
      .select('announcement_id, url')
      .eq('kind', 'cover')
      .in('announcement_id', list.map((a) => a.id))
    if (coverErr) console.error('[announcements] covers query failed:', coverErr.message)
    for (const c of (covers ?? []) as { announcement_id: string; url: string }[]) {
      if (!coverByAnn.has(c.announcement_id)) coverByAnn.set(c.announcement_id, c.url)
    }
  }

  // UI v2 A1: chỉ đổi trình bày — mỗi dòng truy vấn trên thành một thẻ (AnnouncementCard) theo đúng các luật cũ:
  // chưa đọc chỉ khi KHÔNG phải admin VÀ truy vấn đọc thành công (admin / đọc lỗi ⇒ 'untracked', không "Mới");
  // hết hạn theo expires_at (RLS đã ẩn tin hết hạn với non-admin); ảnh bìa = ảnh cover đầu tiên đã tải.
  const items: AnnouncementCardData[] = list.map((a) => ({
    id: a.id,
    href: `/announcements/${a.id}`,
    title: a.title,
    excerpt: a.excerpt,
    creatorName: (a.creator as unknown as { full_name: string } | null)?.full_name ?? '—',
    publishedAt: a.published_at,
    byStore: a.visibility === 'stores',
    expired: !!a.expires_at && Date.parse(a.expires_at as string) < Date.now(),
    read: isAdmin || !readsOk ? 'untracked' : readIds.has(a.id) ? 'read' : 'unread',
    coverUrl: coverByAnn.get(a.id) ?? null,
  }))

  return (
    <AnnouncementsListView
      canCreate={isAdmin}
      state={{ kind: 'ok', items, reads: isAdmin ? 'untracked' : readsOk ? 'tracked' : 'error' }}
      now={new Date()}
    />
  )
}
