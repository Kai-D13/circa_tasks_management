import { NextResponse, type NextRequest } from 'next/server'

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Cron is self-protected via CRON_SECRET; /sw.js is the PWA cleanup worker and
  // must stay reachable without auth so old devices can unregister their SW.
  if (pathname.startsWith('/login'))     return NextResponse.next()
  if (pathname.startsWith('/api/cron/')) return NextResponse.next()
  if (pathname === '/sw.js')             return NextResponse.next()

  // Cookie-existence guard only — no auth round-trip. On self-hosted Supabase with
  // symmetric JWT_SECRET, getClaims() falls back to a network verify on every
  // navigation; reverting here while JWT key setup is confirmed avoids the mobile
  // latency regression. Session refresh will be re-enabled once asymmetric JWKS is
  // confirmed or the key is migrated.
  const hasSession = request.cookies.getAll()
    .some((c) => c.name.startsWith('sb-') && c.name.includes('-auth-token'))

  if (!hasSession) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
