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
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { user: null, profile: null }

  // Disambiguate the stores embed by the FK constraint name. Migration 045 added
  // sm_store_assignments (FK to both users and stores), so a bare stores(*) embed
  // is now ambiguous ("more than one relationship was found") and errors out —
  // which made profile null and bounced every login back to /login. The
  // users_store_id_fkey hint pins it to the direct users.store_id -> stores FK.
  const { data: profile } = await supabase
    .from('users')
    .select('*, stores!users_store_id_fkey(*)')
    .eq('id', user.id)
    .single()

  return { user, profile }
})
