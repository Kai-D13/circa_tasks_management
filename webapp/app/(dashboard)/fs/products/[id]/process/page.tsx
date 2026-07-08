import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { createClient } from '@/lib/supabase/server'
import { isSuperAdminEmail } from '@/lib/authz'
import { POLICY_DEPT_ID, FS_SESSION_STATUS } from '@/lib/fs/constants'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { ChevronLeft, AlertTriangle } from 'lucide-react'
import { FsProcessWizard, type FsProcessItem } from '@/components/fs/FsProcessWizard'

// Staff processing view: claim the session, then photograph + measure each item.
// Admins (super/Policy) use the admin detail instead — they're redirected there.
type Embed = { name?: string | null; code?: string | null }

export default async function FsProcessPage({ params }: { params: Promise<{ id: string }> }) {
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  const { id } = await params
  const supabase = await createClient()

  const { data: session, error: sErr } = await supabase
    .from('fs_sessions')
    .select('id, name, status, store_id, claimed_by, store:stores(name, code)')
    .eq('id', id).maybeSingle()
  if (sErr) console.error('[fs-process] session query failed:', sErr.message)
  if (!session) notFound()

  const isSuper = profile?.role === 'admin' && isSuperAdminEmail(user.email)
  const isPolicy = profile?.role === 'admin' && profile?.department_id === POLICY_DEPT_ID
  if (isSuper || isPolicy) redirect(`/fs/products/${id}`) // admins review, not process
  // FS module is staff-only (F5) — only a 'staff' of the FS store processes. A
  // non-staff who can read the session (an FS store_manager) goes to the module
  // landing (→ no-access notice), never the OS app.
  const isStoreStaff = profile?.role === 'staff' && profile?.store_id === session.store_id
  if (!isStoreStaff) redirect('/fs/products')

  const [{ data: items, error: iErr }, { data: claimer }] = await Promise.all([
    supabase.from('fs_session_items')
      .select('id, product_id, product_name, status, dim_length_mm, dim_width_mm, dim_height_mm, resubmit_note')
      .eq('session_id', id).is('removed_at', null).order('created_at', { ascending: true }),
    session.claimed_by
      ? supabase.from('users').select('full_name, email').eq('id', session.claimed_by).maybeSingle()
      : Promise.resolve({ data: null }),
  ])
  if (iErr) console.error('[fs-process] items query failed:', iErr.message)

  const itemIds = (items ?? []).map((i) => i.id)
  const { data: allPhotos, error: phErr } = itemIds.length
    ? await supabase.from('fs_item_photos').select('item_id, box_key, storage_path, status, resubmit_note').in('item_id', itemIds)
    : { data: [] as { item_id: string; box_key: number; storage_path: string; status: string; resubmit_note: string | null }[], error: null }
  const queryError = iErr?.message ?? phErr?.message ?? null
  if (queryError) console.error('[fs-process] query failed:', queryError)

  const reviewItems: FsProcessItem[] = (items ?? []).map((it) => ({
    ...it,
    photos: (allPhotos ?? []).filter((p) => p.item_id === it.id)
      .map((p) => ({ box_key: p.box_key, storage_path: p.storage_path, status: p.status, resubmit_note: p.resubmit_note })),
  }))

  const store = Array.isArray(session.store) ? (session.store[0] as Embed) : (session.store as Embed | null)
  const meta = FS_SESSION_STATUS[session.status] ?? { label: session.status, cls: 'bg-muted text-muted-foreground' }
  const claimedByMe = session.claimed_by === user.id
  const claimedByOther = !!session.claimed_by && session.claimed_by !== user.id
  const claimerLabel = claimer ? `${claimer.full_name}${claimer.email ? ` (${claimer.email})` : ''}` : null
  const isActive = session.status === 'active'

  return (
    <div className="p-4 space-y-4 max-w-4xl">
      <Link href="/fs/products" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronLeft className="h-4 w-4" /> Danh sách sản phẩm bổ sung thông tin
      </Link>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{session.name}</h1>
        <Badge className={cn('text-[10px]', meta.cls)}>{meta.label}</Badge>
        <span className="text-sm text-muted-foreground">{store?.name}{store?.code ? ` · ${store.code}` : ''}</span>
      </div>

      {queryError && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>Lỗi tải dữ liệu phiên: {queryError}</span>
        </div>
      )}

      {!isActive ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>Danh sách này đã {meta.label.toLowerCase()} — không thể xử lý thêm.</span>
        </div>
      ) : (
        <FsProcessWizard
          sessionId={id}
          claimedByMe={claimedByMe}
          claimedByOther={claimedByOther}
          claimerLabel={claimerLabel}
          items={reviewItems}
        />
      )}
    </div>
  )
}
