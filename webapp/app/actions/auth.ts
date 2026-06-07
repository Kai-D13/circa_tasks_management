'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getDefaultRoute } from '@/lib/routes'

export async function login(formData: FormData) {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.signInWithPassword({
    email: formData.get('email') as string,
    password: formData.get('password') as string,
  })
  if (error) {
    return { error: error.message }
  }
  let role: string | null = null
  if (data.user) {
    const { data: profile } = await supabase
      .from('users').select('role').eq('id', data.user.id).single()
    role = profile?.role ?? null
  }
  redirect(getDefaultRoute(role))
}

export async function logout() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect('/login')
}
