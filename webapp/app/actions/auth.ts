'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getDefaultRoute } from '@/lib/routes'

export type LoginState =
  | { error: string }
  | { success: true; redirectTo: string }
  | null

// useActionState-compatible: (prevState, formData) => state. Signs in via the
// server-side Supabase client so the session is written as HTTP Set-Cookie on the
// action response (more reliable on iOS Safari than browser document.cookie).
//
// IMPORTANT: we do NOT redirect() from the action. A server-action redirect is a
// soft client-router navigation, and the RSC fetch for the destination can race
// the just-committed auth cookie (and reuse router-cache state from the logged-out
// prefetch) — the navigation reaches middleware with no cookie and bounces back to
// /login. Instead we return the target and let the client do a HARD navigation
// (window.location), which makes a fresh top-level GET that always carries the
// freshly-set cookie and bypasses the router cache.
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
  return { success: true, redirectTo: getDefaultRoute(role) }
}

export async function logout() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect('/login')
}
