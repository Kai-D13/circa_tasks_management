import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { TaskForm } from '@/components/tasks/TaskForm'
import { isSuperAdminEmail } from '@/lib/authz'
import { Task } from '@/types'

export default async function EditTaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [{ data: task }, { data: profile }] = await Promise.all([
    supabase.from('tasks').select('*').eq('id', id).single(),
    supabase.from('users').select('role, store_id').eq('id', user.id).single(),
  ])

  if (!task) notFound()

  // Admin-only + own-scope: super admin any task, sub-admin only ones they created.
  const canEdit = profile?.role === 'admin'
    && (isSuperAdminEmail(user.email) || task.created_by === user.id)

  if (!canEdit) redirect(`/tasks/${id}`)

  const [{ data: stores }, { data: users }] = await Promise.all([
    supabase.from('stores').select('id, name, code').order('name'),
    supabase.from('users').select('id, full_name, email, store_id, role').order('full_name'),
  ])

  return (
    <div className="flex flex-col h-full">
      <TaskForm
        task={task as Task}
        stores={stores ?? []}
        users={users ?? []}
        currentUserRole={profile?.role ?? 'staff'}
        currentUserStoreId={profile?.store_id ?? null}
      />
    </div>
  )
}
