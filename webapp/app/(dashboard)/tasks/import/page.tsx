import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ImportTasksClient } from '@/components/tasks/ImportTasksClient'

export default async function ImportTasksPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('users').select('role').eq('id', user.id).single()

  if (profile?.role === 'staff') redirect('/tasks')

  const { data: stores } = await supabase
    .from('stores')
    .select('id, name, code')
    .order('name')

  return <ImportTasksClient stores={stores ?? []} />
}
