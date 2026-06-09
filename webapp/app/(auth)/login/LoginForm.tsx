'use client'

import { useActionState, useEffect, useState } from 'react'
import { login } from '@/app/actions/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

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

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/40">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Task Manager</CardTitle>
          <CardDescription>Sign in to your account</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={formAction} className="flex flex-col gap-4">
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                placeholder="you@example.com"
                required
                autoComplete="email"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                required
                autoComplete="current-password"
              />
            </div>
            {error && (
              <p className="text-sm text-destructive" role="alert">{error}</p>
            )}
            <Button type="submit" disabled={busy} className="w-full mt-2">
              {busy ? 'Signing in...' : 'Sign In'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
