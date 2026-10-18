import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { CreateAnnouncementForm } from '@/components/announcements/CreateAnnouncementForm'
import { AnnouncementFormView } from '@/components/announcements/AnnouncementFormView'
import { isSuperAdminEmail } from '@/lib/authz'
import { editLoadDecision } from '@/lib/announcements/editLoad'

export default async function EditAnnouncementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') redirect('/announcements')

  const [{ data: ann, error: annErr }, { data: stores, error: storesErr }, { data: aStores, error: aStoresErr }, { data: assets, error: assetsErr }] = await Promise.all([
    supabase.from('announcements').select('id, title, body, visibility, expires_at, created_by').eq('id', id).maybeSingle(),
    supabase.from('stores').select('id, name').eq('store_type', 'os').order('name'),
    supabase.from('announcement_stores').select('store_id').eq('announcement_id', id),
    supabase.from('announcement_assets').select('kind, url, position').eq('announcement_id', id).order('position'),
  ])
  // UI v2 A3 (PM P1): dùng `error` của CHÍNH các truy vấn trên — không thêm truy vấn.
  //   · tải tin lỗi ⇒ ErrorState (trước: không có dữ liệu ⇒ 404 gây hiểu nhầm); tin thật sự không tồn tại vẫn 404.
  //   · cửa hàng đích / ảnh của tin lỗi ⇒ ErrorState, KHÔNG dựng form thiếu dữ liệu (lưu form đó sẽ xóa ảnh / bỏ
  //     cửa hàng đích của tin) — fail-closed.
  //   · danh sách cửa hàng để chọn lỗi: tin gửi THEO CỬA HÀNG ⇒ ErrorState (không đối chiếu được tập cửa hàng đang
  //     lưu — R1-01); tin gửi TẤT CẢ ⇒ form mở, chỉ giữ "Tất cả" (nút chọn cửa hàng tắt) + báo lỗi trong khối "Gửi cho".
  //   Thứ tự giữ quyền như cũ: tin lỗi → không có tin (404) → không phải tác giả/super (redirect) → dữ liệu phụ
  //   (lib/announcements/editLoad — hàm thuần, test được mọi nhánh).
  const errorView = (err: { message: string }) => {
    console.error('[announcements] edit query failed:', err.message)
    return <AnnouncementFormView heading="Sửa thông báo" backHref={`/announcements/${id}`} backLabel="Quay lại" error />
  }
  if (annErr) return errorView(annErr)
  if (!ann) notFound()
  // Only the creator or a super admin may edit (matches RLS ann_update).
  if (ann.created_by !== user.id && !isSuperAdminEmail(user.email)) redirect(`/announcements/${id}`)
  const load = editLoadDecision({
    aStoresErr: !!aStoresErr, assetsErr: !!assetsErr, storesErr: !!storesErr,
    visibility: (ann.visibility as 'all' | 'stores') ?? 'all',
  })
  if (load.kind === 'error') return errorView((aStoresErr ?? assetsErr ?? storesErr)!)
  if (storesErr) console.error('[announcements] stores query failed:', storesErr.message)

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
    <AnnouncementFormView heading="Sửa thông báo" backHref={`/announcements/${id}`} backLabel="Quay lại">
      <CreateAnnouncementForm stores={stores ?? []} mode="edit" announcementId={id} initial={initial} storesError={load.storesError} />
    </AnnouncementFormView>
  )
}
