// Persistent auth-cookie options shared by all Supabase client factories
// (browser, server, middleware/proxy) so login, refresh, and reads all agree on
// ONE cookie that survives a full browser restart. Without an explicit maxAge the
// cookie can be written as session-only, which is the root of the "logged out
// after closing the browser" complaint on iOS Safari / mobile Chrome.
//
// secure is gated to production so local http dev login still works (a Secure
// cookie is dropped over plain http).
export const AUTH_COOKIE_OPTIONS = {
  maxAge: 60 * 60 * 24 * 365, // 1 year
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
}
