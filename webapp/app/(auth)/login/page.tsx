import { LoginForm } from './LoginForm'

// Force dynamic rendering so /login is NEVER prerendered or served with a long
// `s-maxage` from a shared cache. The page embeds a per-deploy Server Action ID
// (the login form action); if stale action-bearing HTML is cached and served
// after a redeploy, the POST resolves to an action ID the new server can't find
// and returns 500. Rendering per request keeps the action reference fresh.
export const dynamic = 'force-dynamic'

export default function LoginPage() {
  return <LoginForm />
}
