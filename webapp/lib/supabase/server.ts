import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { AUTH_COOKIE_OPTIONS } from './cookieOptions'

// Server-side requests go over the internal docker network when
// SUPABASE_INTERNAL_URL is set (app container shares the Supabase stack
// network → ~ms latency, no Cloudflare/tunnel hop). Falls back to the public
// URL when the env is absent, so the variable is the on/off switch.
const SUPABASE_URL =
  process.env.SUPABASE_INTERNAL_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!

// @supabase/ssr derives the auth cookie name from the client URL's first
// hostname segment (sb-<segment>-auth-token). The session cookie was minted
// against the PUBLIC host — pin the name explicitly so switching the client
// to the internal Kong URL can never strand every user's session.
const AUTH_COOKIE_NAME = `sb-${new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split('.')[0]}-auth-token`

export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: { ...AUTH_COOKIE_OPTIONS, name: AUTH_COOKIE_NAME },
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Called from a Server Component — session refresh handled by middleware
          }
        },
      },
    }
  )
}
