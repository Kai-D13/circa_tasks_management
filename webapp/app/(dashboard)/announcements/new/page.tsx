import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { CreateAnnouncementForm } from '@/components/announcements/CreateAnnouncementForm'
import { AnnouncementFormView } from '@/components/announcements/AnnouncementFormView'

export default async function NewAnnouncementPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') redirect('/announcements')

  const { data: stores, error: storesErr } = await supabase.from('stores').select('id, name').eq('store_type', 'os').order('name')
  if (storesErr) console.error('[announcements] stores query failed:', storesErr.message)

  // UI v2 A3: lỗi danh sách cửa hàng ⇒ form vẫn gửi được cho "Tất cả" (như cũ), câu báo lỗi chuyển vào khối "Gửi cho"
  // và bộ chọn KHÔNG hiện rỗng giả "Chưa có cửa hàng." (PM P1).
  return (
    <AnnouncementFormView heading="Tạo thông báo" backHref="/announcements" backLabel="Bảng tin">
      <CreateAnnouncementForm stores={stores ?? []} storesError={!!storesErr} />
    </AnnouncementFormView>
  )
}
