import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { buttonVariants } from '@/components/ui/button'
import { CreateAnnouncementForm } from '@/components/announcements/CreateAnnouncementForm'
import { ArrowLeft } from 'lucide-react'
import { cn } from '@/lib/utils'

export default async function NewAnnouncementPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') redirect('/announcements')

  const { data: stores, error: storesErr } = await supabase.from('stores').select('id, name').eq('store_type', 'os').order('name')
  if (storesErr) console.error('[announcements] stores query failed:', storesErr.message)

  return (
    <div className="p-4 md:p-6 max-w-2xl">
      <Link href="/announcements" className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'mb-2 -ml-2')}>
        <ArrowLeft className="h-4 w-4 mr-1" /> Bảng tin
      </Link>
      <h1 className="text-xl font-semibold mb-4">Tạo thông báo</h1>
      {storesErr && (
        <p className="text-sm text-destructive mb-3">
          Không tải được danh sách cửa hàng — chỉ có thể gửi cho “Tất cả”. Thử lại sau hoặc báo Admin.
        </p>
      )}
      <CreateAnnouncementForm stores={stores ?? []} />
    </div>
  )
}
