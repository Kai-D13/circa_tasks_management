'use client'

import { useActionState, useEffect, useState } from 'react'
import { login } from '@/app/actions/auth'
import { LoginScreen } from './LoginScreen'

export function LoginForm() {
  // The server action sets the Supabase auth cookies and returns { success,
  // redirectTo }. We perform a HARD navigation (window.location) rather than a
  // client-router push: a full top-level GET guarantees the freshly-committed
  // auth cookie is attached and bypasses any stale logged-out router cache, which
  // is what caused the post-login bounce back to /login. On failure the action
  // returns { error } which we render inline (survives on mobile w/o a Toaster).
  const [state, formAction, pending] = useActionState(login, null)
  const [redirecting, setRedirecting] = useState(false)

  useEffect(() => {
    if (state && 'success' in state && state.success) {
      setRedirecting(true)
      window.location.assign(state.redirectTo)
    }
  }, [state])

  const error = state && 'error' in state ? state.error : null
  const busy = pending || redirecting

  // UI v2 Login: phần trình bày ở LoginScreen (dùng chung fixture /login/ui-catalog); luồng auth ở trên không đổi.
  return <LoginScreen action={formAction} error={error} busy={busy} />
}
