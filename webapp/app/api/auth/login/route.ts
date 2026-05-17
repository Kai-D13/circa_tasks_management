import { createServerClient } from '@supabase/ssr'
import { NextRequest, NextResponse } from 'next/server'

export async function POST(request: NextRequest) {
  const formData = await request.formData()
  const email    = formData.get('email')    as string
  const password = formData.get('password') as string
  const next     = (formData.get('next') as string | null) ?? '/dashboard'

  // Build the redirect response first so we can set cookies directly on it.
  // Cookies set here are included in the browser's follow-up request — this
  // avoids the iOS WKWebView timing bug where JS-set cookies miss navigations.
  const successResponse = NextResponse.redirect(new URL(next, request.url), 303)

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value, options }) =>
            successResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { error } = await supabase.auth.signInWithPassword({ email, password })

  if (error) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(error.message)}`, request.url),
      303,
    )
  }

  return successResponse
}
