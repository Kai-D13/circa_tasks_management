import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { CreateAnnouncementForm } from '@/components/announcements/CreateAnnouncementForm'

export default async function NewAnnouncementPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') redirect('/announcements')

  const { data: stores } = await supabase.from('stores').select('id, name').order('name')

  return (
    <div className="p-4 md:p-6 max-w-2xl">
      <h1 className="text-xl font-semibold mb-4">Tạo thông báo</h1>
      <CreateAnnouncementForm stores={stores ?? []} />
    </div>
  )
}
