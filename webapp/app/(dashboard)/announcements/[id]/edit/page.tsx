import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { buttonVariants } from '@/components/ui/button'
import { CreateAnnouncementForm } from '@/components/announcements/CreateAnnouncementForm'
import { isSuperAdminEmail } from '@/lib/authz'
import { ArrowLeft } from 'lucide-react'
import { cn } from '@/lib/utils'

export default async function EditAnnouncementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') redirect('/announcements')

  const [{ data: ann }, { data: stores }, { data: aStores }, { data: assets }] = await Promise.all([
    supabase.from('announcements').select('id, title, body, visibility, expires_at, created_by').eq('id', id).maybeSingle(),
    supabase.from('stores').select('id, name').order('name'),
    supabase.from('announcement_stores').select('store_id').eq('announcement_id', id),
    supabase.from('announcement_assets').select('kind, url, position').eq('announcement_id', id).order('position'),
  ])
  if (!ann) notFound()
  // Only the creator or a super admin may edit (matches RLS ann_update).
  if (ann.created_by !== user.id && !isSuperAdminEmail(user.email)) redirect(`/announcements/${id}`)

  const initial = {
    title: ann.title as string,
    body: (ann.body as string) ?? '',
    visibility: (ann.visibility as 'all' | 'stores') ?? 'all',
    storeIds: (aStores ?? []).map((s) => s.store_id as string),
    expiresAt: ann.expires_at ? String(ann.expires_at).slice(0, 10) : '',
    coverUrl: (assets ?? []).find((a) => a.kind === 'cover')?.url as string ?? null,
    carouselUrls: (assets ?? []).filter((a) => a.kind === 'carousel').map((a) => a.url as string),
  }

  return (
    <div className="p-4 md:p-6 max-w-2xl">
      <Link href={`/announcements/${id}`} className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'mb-2 -ml-2')}>
        <ArrowLeft className="h-4 w-4 mr-1" /> Quay lại
      </Link>
      <h1 className="text-xl font-semibold mb-4">Sửa thông báo</h1>
      <CreateAnnouncementForm stores={stores ?? []} mode="edit" announcementId={id} initial={initial} />
    </div>
  )
}
