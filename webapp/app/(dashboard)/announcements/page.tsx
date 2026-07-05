import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent } from '@/components/ui/card'
import { buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Megaphone, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatDateTime } from '@/lib/dateUtils'

// Bảng tin / Thông báo — read-only broadcasts (migration 063). RLS scopes which
// announcements each role sees; admins see all + can create.
export default async function AnnouncementsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
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
    return (
      <div className="p-4 md:p-6 max-w-3xl">
        <p className="text-sm text-destructive">Không tải được bảng tin. Vui lòng thử lại sau hoặc báo Admin.</p>
      </div>
    )
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

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Megaphone className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold">Bảng tin</h1>
        </div>
        {isAdmin && (
          <Link href="/announcements/new" className={cn(buttonVariants({ size: 'sm' }))}>
            <Plus className="h-4 w-4 mr-1" /> Tạo thông báo
          </Link>
        )}
      </div>

      {list.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            <Megaphone className="h-8 w-8 mx-auto mb-3 opacity-30" />
            Chưa có thông báo nào.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {list.map((a) => {
            const unread = !isAdmin && readsOk && !readIds.has(a.id)
            const creator = (a.creator as unknown as { full_name: string } | null)?.full_name ?? '—'
            const expired = !!a.expires_at && Date.parse(a.expires_at as string) < Date.now()
            const cover = coverByAnn.get(a.id)
            return (
              <Link
                key={a.id}
                href={`/announcements/${a.id}`}
                className={cn(
                  'block rounded-xl border bg-card p-4 hover:bg-muted/40 active:bg-muted/40 transition-colors',
                  unread && 'border-primary/40 bg-primary/5',
                )}
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-medium">{a.title}</p>
                      <span className="flex items-center gap-1 shrink-0">
                        {expired && <Badge className="bg-muted text-muted-foreground text-[10px]">Hết hạn</Badge>}
                        {unread && <Badge className="bg-primary text-white text-[10px]">Mới</Badge>}
                      </span>
                    </div>
                    {a.excerpt && <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{a.excerpt}</p>}
                    <p className="text-xs text-muted-foreground mt-1.5">
                      {creator} · {formatDateTime(a.published_at)}
                      {a.visibility === 'stores' && ' · theo cửa hàng'}
                    </p>
                  </div>
                  {cover && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={cover}
                      alt=""
                      loading="lazy"
                      className="h-14 w-14 rounded-lg border object-cover shrink-0"
                    />
                  )}
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
