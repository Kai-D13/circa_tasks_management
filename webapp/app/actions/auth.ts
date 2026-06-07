'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getDefaultRoute } from '@/lib/routes'

export type LoginState = { error: string } | null

// useActionState-compatible: (prevState, formData) => state. Signs in via the
// server-side Supabase client so the session is written as HTTP Set-Cookie on the
// redirect response (more reliable on iOS Safari than browser document.cookie).
export async function login(_prevState: LoginState, formData: FormData): Promise<LoginState> {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.signInWithPassword({
    email: formData.get('email') as string,
    password: formData.get('password') as string,
  })
  if (error) {
    // Friendlier copy for the overwhelmingly common case; pass through anything else.
    const friendly = error.message === 'Invalid login credentials'
      ? 'Email hoặc mật khẩu không đúng.'
      : error.message
    return { error: friendly }
  }
  let role: string | null = null
  if (data.user) {
    const { data: profile } = await supabase
      .from('users').select('role').eq('id', data.user.id).single()
    role = profile?.role ?? null
  }
  // redirect() throws NEXT_REDIRECT — Next performs the navigation and carries the
  // freshly-set auth cookies along on the redirect response.
  redirect(getDefaultRoute(role))
}

export async function logout() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect('/login')
}
