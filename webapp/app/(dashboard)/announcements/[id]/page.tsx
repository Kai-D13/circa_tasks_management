import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { RichText } from '@/components/tasks/RichText'
import { MarkAnnouncementRead } from '@/components/announcements/MarkAnnouncementRead'
import { Card, CardContent } from '@/components/ui/card'
import { formatDateTime } from '@/lib/dateUtils'
import { Megaphone } from 'lucide-react'

interface ReadRow { user_id: string; read_at: string; users: { full_name: string } | null }

export default async function AnnouncementDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  const isAdmin = profile?.role === 'admin'

  const { data: ann } = await supabase
    .from('announcements')
    .select('id, title, body, visibility, published_at, creator:users!created_by(full_name)')
    .eq('id', id)
    .single()
  if (!ann) notFound()

  // Admin: read-receipt stats (who viewed).
  let reads: ReadRow[] = []
  if (isAdmin) {
    const { data } = await supabase
      .from('announcement_reads')
      .select('user_id, read_at, users(full_name)')
      .eq('announcement_id', id)
      .order('read_at', { ascending: false })
    reads = (data ?? []) as unknown as ReadRow[]
  }

  const creator = (ann.creator as unknown as { full_name: string } | null)?.full_name ?? '—'

  return (
    <div className="p-4 md:p-6 max-w-2xl space-y-4">
      {/* Non-admin viewing = a read receipt */}
      {!isAdmin && <MarkAnnouncementRead announcementId={id} />}

      <div>
        <div className="flex items-center gap-2 text-primary">
          <Megaphone className="h-5 w-5" />
          <span className="text-xs uppercase tracking-wide font-medium">Thông báo</span>
        </div>
        <h1 className="text-xl font-semibold mt-1">{ann.title}</h1>
        <p className="text-xs text-muted-foreground mt-1">
          {creator} · {formatDateTime(ann.published_at)}
        </p>
      </div>

      <Card>
        <CardContent className="py-4">
          <RichText value={ann.body} />
        </CardContent>
      </Card>

      {isAdmin && (
        <Card>
          <CardContent className="py-4">
            <p className="text-sm font-medium mb-2">Đã xem: {reads.length} người</p>
            {reads.length === 0 ? (
              <p className="text-sm text-muted-foreground">Chưa có ai xem.</p>
            ) : (
              <ul className="text-sm">
                {reads.map((r) => (
                  <li key={r.user_id} className="flex items-center justify-between border-b last:border-0 py-1.5">
                    <span>{(r.users as unknown as { full_name: string } | null)?.full_name ?? r.user_id}</span>
                    <span className="text-muted-foreground text-xs">{formatDateTime(r.read_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
