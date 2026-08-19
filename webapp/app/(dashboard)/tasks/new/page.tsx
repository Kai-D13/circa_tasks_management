import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { TaskForm } from '@/components/tasks/TaskForm'
import { EmptyState } from '@/components/ds/EmptyState'
import { getSmStoreIds } from '@/lib/authz'
import { canCreateTask } from '@/lib/tasks/smScope'
import { ClipboardList } from 'lucide-react'

export default async function NewTaskPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>
}) {
  const { mode } = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('users').select('role, store_id').eq('id', user.id).single()

  // Mig 108: Admin + SM tạo được task; store manager/staff là người thực hiện.
  if (!canCreateTask(profile?.role)) redirect('/tasks')
  const isSm = profile?.role === 'sm'

  // SM chỉ được thấy — và vì thế chỉ chọn được — cửa hàng mình phụ trách.
  // Danh sách derive Ở SERVER từ sm_store_assignments, không nhận từ client.
  // (Server action vẫn nạp lại phạm vi lúc submit; đây là lớp hiển thị.)
  const smStoreIds = isSm ? await getSmStoreIds(supabase, user.id) : []
  if (isSm && smStoreIds.length === 0) {
    return (
      <div className="p-4 md:p-6">
        <EmptyState
          icon={ClipboardList}
          title="Bạn chưa được phân công cửa hàng nào"
          hint="Liên hệ Admin để được phân công trước khi tạo task."
        />
      </div>
    )
  }

  // Only ACTIVE OS stores are assignable — deactivated (mig 074) and franchise
  // (mig 076) stores must not receive OS tasks.
  const storeQuery = supabase.from('stores')
    .select('id, name, code').eq('is_active', true).eq('store_type', 'os').order('name')
  const { data: stores } = await (isSm ? storeQuery.in('id', smStoreIds) : storeQuery)

  // Chỉ trả về nhân viên thuộc các cửa hàng SM được phép giao việc — form
  // không nên cầm danh sách toàn công ty rồi tự lọc ở client.
  const allowedStoreIds = (stores ?? []).map((s) => s.id)
  const userQuery = supabase.from('users')
    .select('id, full_name, email, store_id, role').order('full_name')
  const { data: users } = await (isSm ? userQuery.in('store_id', allowedStoreIds) : userQuery)

  return (
    <div className="flex flex-col h-full">
      <TaskForm
        stores={stores ?? []}
        users={users ?? []}
        currentUserRole={profile?.role ?? 'staff'}
        currentUserStoreId={profile?.store_id ?? null}
        initialTaskType={mode === 'recurring' && !isSm ? 'recurring' : undefined}
      />
    </div>
  )
}
