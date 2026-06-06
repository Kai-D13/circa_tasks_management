import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ImportTasksClient } from '@/components/tasks/ImportTasksClient'

export default async function ImportTasksPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/tasks')

  // Import is admin-only (creates store tasks on behalf of operations).
  const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).single()
  if (profile?.role !== 'admin') redirect('/tasks')

  const { data: stores } = await supabase
    .from('stores').select('id, name, code').order('code')

  return <ImportTasksClient stores={stores ?? []} />
}
