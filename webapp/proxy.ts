import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Cron is self-protected via CRON_SECRET; /sw.js is the PWA cleanup worker and
  // must stay reachable without auth so old devices can unregister their SW.
  if (pathname.startsWith('/api/cron/')) return NextResponse.next()
  if (pathname === '/sw.js')             return NextResponse.next()

  // Bind a server-side Supabase client to this request's cookies. setAll() runs
  // when the access token is refreshed: it writes the rotated cookies onto the
  // outgoing response so the browser persists the new session. Do not insert code
  // between client creation and getClaims() below — it must run back-to-back to
  // avoid session desync (Supabase SSR requirement).
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // getClaims() verifies the access token (locally via JWKS when the project uses
  // asymmetric JWT keys) and, when it is expired, exchanges the refresh token and
  // rotates the cookies through setAll above. This is what keeps iOS Safari logged
  // in across app close/reopen — the old cookie-existence check never refreshed.
  const { data } = await supabase.auth.getClaims()
  const isAuthed = !!data?.claims

  // Login page stays reachable regardless of auth state.
  if (pathname.startsWith('/login')) return response

  if (!isAuthed) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  return response
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
