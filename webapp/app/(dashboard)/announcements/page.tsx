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

  const { data: anns } = await supabase
    .from('announcements')
    .select('id, title, excerpt, visibility, published_at, creator:users!created_by(full_name)')
    .order('published_at', { ascending: false })
    .limit(100)
  const list = anns ?? []

  // Unread highlight for non-admin viewers.
  let readIds = new Set<string>()
  if (!isAdmin && list.length) {
    const { data: reads } = await supabase
      .from('announcement_reads')
      .select('announcement_id')
      .in('announcement_id', list.map((a) => a.id))
    readIds = new Set((reads ?? []).map((r) => r.announcement_id))
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
            const unread = !isAdmin && !readIds.has(a.id)
            const creator = (a.creator as unknown as { full_name: string } | null)?.full_name ?? '—'
            return (
              <Link
                key={a.id}
                href={`/announcements/${a.id}`}
                className={cn(
                  'block rounded-lg border p-4 hover:bg-muted/40 transition-colors',
                  unread && 'border-primary/40 bg-primary/5',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium">{a.title}</p>
                  {unread && <Badge className="bg-primary text-white text-[10px] shrink-0">Mới</Badge>}
                </div>
                {a.excerpt && <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{a.excerpt}</p>}
                <p className="text-xs text-muted-foreground mt-1.5">
                  {creator} · {formatDateTime(a.published_at)}
                  {a.visibility === 'stores' && ' · theo cửa hàng'}
                </p>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
