import { NextResponse, type NextRequest } from 'next/server'

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Allow login page and cron routes through — cron is self-protected via CRON_SECRET
  if (pathname.startsWith('/login'))     return NextResponse.next()
  if (pathname.startsWith('/api/cron/')) return NextResponse.next()

  // Check for Supabase session cookie — set by createBrowserClient after signInWithPassword
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
