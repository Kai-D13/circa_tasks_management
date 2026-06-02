import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { TaskForm } from '@/components/tasks/TaskForm'

export default async function NewTaskPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('users').select('role, store_id').eq('id', user.id).single()

  // Task creation is admin-only — store managers/staff are executors.
  if (profile?.role !== 'admin') redirect('/tasks')

  const [{ data: stores }, { data: users }] = await Promise.all([
    supabase.from('stores').select('id, name').order('name'),
    supabase.from('users').select('id, full_name, email, store_id, role').order('full_name'),
  ])

  return (
    <div className="flex flex-col h-full">
      <TaskForm
        stores={stores ?? []}
        users={users ?? []}
        currentUserRole={profile?.role ?? 'staff'}
        currentUserStoreId={profile?.store_id ?? null}
      />
    </div>
  )
}
