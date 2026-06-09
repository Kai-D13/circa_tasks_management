import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'

// Request-memoized current user + profile.
//
// The dashboard layout and each page both need the authenticated user and their
// profile row. Without dedup that's two auth.getUser() validations + two `users`
// queries per navigation — extra round-trips that hurt at mobile latency. React's
// cache() memoizes per render pass, and in the App Router the layout and page render
// in the SAME request, so all callers share one auth check + one profile query.
//
// Selects the full row (incl. stores) so the layout (which needs UserProfile) and
// pages (which need role/store_id) can both source from this single call.
export const getSessionProfile = cache(async () => {
  const supabase = await createClient()
  const { data: { user }, error: userErr } = await supabase.auth.getUser()
  // TEMP DIAGNOSTIC — remove after login bounce is resolved.
  console.log(`[AUTH-DEBUG] getSessionProfile getUser user=${user?.id ?? 'null'} err=${userErr?.message ?? 'none'}`)
  if (!user) return { user: null, profile: null }

  const { data: profile, error: profileErr } = await supabase
    .from('users')
    .select('*, stores(*)')
    .eq('id', user.id)
    .single()

  // TEMP DIAGNOSTIC — remove after login bounce is resolved.
  console.log(`[AUTH-DEBUG] getSessionProfile profile=${profile?.id ?? 'null'} role=${profile?.role ?? 'null'} err=${profileErr?.message ?? 'none'}`)

  return { user, profile }
})
