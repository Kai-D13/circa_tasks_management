import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { AUTH_COOKIE_OPTIONS } from '@/lib/supabase/cookieOptions'

// Derive the exact cookie name Supabase SSR uses for THIS deployment.
// @supabase/ssr generates the key as: sb-<first-hostname-segment>-auth-token
// e.g. https://database-duocsi.circa.vn  →  sb-database-duocsi-auth-token
// Filtering by this exact name prevents cookies from a different project
// (e.g. an old Cloud project or a previously-pointed domain) from being
// picked up and garbling the expiry parse, which would otherwise trigger
// getUser() on every navigation and bring back mobile latency regression.
const SUPABASE_HOST_SEGMENT = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split('.')[0]
const AUTH_COOKIE_BASE = `sb-${SUPABASE_HOST_SEGMENT}-auth-token`

// Refresh a little before the real expiry so a request that's about to need a
// valid token triggers the refresh now instead of failing mid-flight.
const REFRESH_SKEW_SECONDS = 60

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Cron is self-protected via CRON_SECRET; /sw.js is the PWA cleanup worker and
  // must stay reachable without auth so old devices can unregister their SW.
  if (pathname.startsWith('/login'))     return NextResponse.next()
  if (pathname.startsWith('/api/cron/')) return NextResponse.next()
  if (pathname === '/sw.js')             return NextResponse.next()

  // Filter only the current project's auth cookies (base + any .0/.1 chunks).
  const allCookieNames = request.cookies.getAll().map((c) => c.name)
  const authCookies = request.cookies
    .getAll()
    .filter((c) => c.name === AUTH_COOKIE_BASE || c.name.startsWith(AUTH_COOKIE_BASE + '.'))

  // TEMP DIAGNOSTIC — remove after login bounce is resolved.
  console.log(`[AUTH-DEBUG] proxy path=${pathname} base=${AUTH_COOKIE_BASE} allCookies=[${allCookieNames.join(',')}] authCount=${authCookies.length}`)

  if (authCookies.length === 0) {
    console.log(`[AUTH-DEBUG] proxy REDIRECT->/login (no auth cookie) path=${pathname}`)
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  // Only pay for a session refresh when the access token is at/near expiry.
  // The rest of the time we return immediately on cookie existence alone — this
  // is what keeps mobile navigation fast on self-hosted Supabase, where the
  // symmetric JWT secret makes getUser()/getClaims() a network round-trip.
  if (!isExpiringSoon(authCookies)) {
    console.log(`[AUTH-DEBUG] proxy PASS (fresh cookie) path=${pathname}`)
    return NextResponse.next()
  }
  console.log(`[AUTH-DEBUG] proxy slow-path getUser path=${pathname}`)

  // Token expired/near-expiry: refresh once and persist the new cookies onto the
  // response so the session survives across cold opens (the iOS Safari / mobile
  // Chrome "logged out after closing the browser" bug). Server Components can't
  // write cookies, so the refresh + persistence has to happen here in middleware.
  const response = NextResponse.next({ request })
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: AUTH_COOKIE_OPTIONS,
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            request.cookies.set(name, value)
            response.cookies.set(name, value, options)
          })
        },
      },
    }
  )

  // Triggers a token refresh when needed; setAll above writes the refreshed
  // (rotated) tokens back to the browser with their persistent Max-Age.
  const { data: { user }, error: getUserErr } = await supabase.auth.getUser()

  // TEMP DIAGNOSTIC — remove after login bounce is resolved.
  console.log(`[AUTH-DEBUG] proxy slow-path getUser result user=${user?.id ?? 'null'} err=${getUserErr?.message ?? 'none'} path=${pathname}`)

  if (!user) {
    console.log(`[AUTH-DEBUG] proxy REDIRECT->/login (getUser null) path=${pathname}`)
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  return response
}

// Reads expires_at (unix seconds) from the Supabase auth cookie WITHOUT any
// network call or signature check — just enough to decide whether to refresh.
// @supabase/ssr stores the session JSON, `base64-`-prefixed. When the JSON fits
// in one cookie the base key is used; when it's too large it's split into chunks
// (.0, .1, ...). These are mutually exclusive — the base cookie takes priority.
function isExpiringSoon(authCookies: { name: string; value: string }[]): boolean {
  try {
    const raw = getSessionRaw(authCookies)
    const json = raw.startsWith('base64-')
      ? decodeBase64Url(raw.slice('base64-'.length))
      : raw

    const session = JSON.parse(json)
    // ssr has stored the session both as a bare object and (older) as a tuple.
    const expiresAt: unknown = Array.isArray(session)
      ? session[0]?.expires_at
      : session?.expires_at

    if (typeof expiresAt !== 'number') return true
    const now = Math.floor(Date.now() / 1000)
    return expiresAt - now <= REFRESH_SKEW_SECONDS
  } catch {
    // Any decode failure → treat as needs-refresh so a malformed/garbled cookie
    // can never strand a stale session on the fast path.
    return true
  }
}

// Mirrors @supabase/ssr combineChunks exactly:
//   1. If the base key exists → return it (ignore any stale chunks).
//   2. Otherwise iterate .0, .1, .2, ... and stop at the first missing index.
// The two forms are mutually exclusive in normal operation so we never
// concatenate a base value together with its chunks.
function getSessionRaw(authCookies: { name: string; value: string }[]): string {
  const base = authCookies.find((c) => c.name === AUTH_COOKIE_BASE)
  if (base) return base.value

  let combined = ''
  for (let i = 0; i < 20; i++) {
    const chunk = authCookies.find((c) => c.name === `${AUTH_COOKIE_BASE}.${i}`)
    if (!chunk) break
    combined += chunk.value
  }
  return combined
}

// base64url -> UTF-8 string (Edge-runtime safe). TextDecoder preserves multi-byte
// characters such as Vietnamese names carried in the session's user_metadata,
// which a naive atob() would corrupt and trip JSON.parse.
function decodeBase64Url(input: string): string {
  let b64 = input.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4
  if (pad) b64 += '='.repeat(4 - pad)
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
