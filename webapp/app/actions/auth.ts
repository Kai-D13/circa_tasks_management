'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { getDefaultRoute } from '@/lib/routes'
import { baseAllowedSites, SITE_COOKIE } from '@/lib/site/context'

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
  // Always clear the site cookie so a dual-site account re-chooses each login
  // (stakeholder: never auto-enter the last site).
  ;(await cookies()).delete(SITE_COOKIE)

  let role: string | null = null
  let redirectTo = getDefaultRoute(null)
  if (data.user) {
    const { data: profile } = await supabase
      .from('users').select('role, department_id, stores!users_store_id_fkey(store_type)')
      .eq('id', data.user.id).single()
    role = profile?.role ?? null
    const allowed = baseAllowedSites({ ...profile, email: data.user.email })
    if (allowed.size < 2) {
      const { data: grants } = await supabaseAdmin
        .from('user_site_permissions').select('site').eq('user_id', data.user.id)
      for (const g of grants ?? []) if (g.site === 'os' || g.site === 'fs') allowed.add(g.site)
    }
    redirectTo = allowed.size > 1 ? '/select-site'
      : allowed.has('fs') ? '/fs/products'
      : getDefaultRoute(role)
  }
  return { success: true, redirectTo }
}

export async function logout() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  ;(await cookies()).delete(SITE_COOKIE)
  redirect('/login')
}
