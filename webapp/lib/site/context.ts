import 'server-only'
import { cache } from 'react'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { isSuperAdminEmail } from '@/lib/authz'
import { POLICY_DEPT_ID } from '@/lib/fs/constants'

// Site model (F5b): the app has two "sites" — OS (the whole current app) and FS
// (the FS module). Allowed sites are DERIVED server-side from role + store_type
// (+ user_site_permissions overrides). The `circa_site` cookie only picks which
// allowed site is CURRENT — it never grants access.
export type Site = 'os' | 'fs'
export const SITE_COOKIE = 'circa_site'

type SiteProfile = {
  role?: string | null; email?: string | null; department_id?: string | null; store_id?: string | null
  stores?: { store_type?: string | null } | { store_type?: string | null }[] | null
} | null

// Base sites from role + store_type (query-free — profile is already loaded/embedded).
export function baseAllowedSites(profile: SiteProfile): Set<Site> {
  const s = new Set<Site>()
  const role = profile?.role
  if (!role) return s
  const isSuper = role === 'admin' && isSuperAdminEmail(profile?.email ?? undefined)
  const isPolicy = role === 'admin' && profile?.department_id === POLICY_DEPT_ID
  if (isSuper || isPolicy) { s.add('os'); s.add('fs'); return s }
  if (role === 'admin' || role === 'sm') { s.add('os'); return s }
  if (role === 'staff' || role === 'store_manager') {
    const st = Array.isArray(profile?.stores) ? profile?.stores[0] : profile?.stores
    if (st?.store_type === 'fs') s.add('fs'); else s.add('os')
  }
  return s
}

export function siteHome(site: Site, role?: string | null): string {
  if (site === 'fs') return '/fs/products'
  return role === 'staff' ? '/tasks' : '/dashboard'
}

// Request-memoized site context: allowed sites + the current one (from the cookie
// when the user has >1). A single-site user's current is fixed (cookie ignored).
export const getSiteContext = cache(async (): Promise<{ allowed: Set<Site>; current: Site | null; role: string | null }> => {
  const { user, profile } = await getSessionProfile()
  const role = profile?.role ?? null
  if (!user || !profile) return { allowed: new Set<Site>(), current: null, role }

  const allowed = baseAllowedSites(profile as SiteProfile)
  // Grants can only ADD sites → skip the query when the user already has both.
  if (allowed.size < 2) {
    const { data: grants } = await supabaseAdmin
      .from('user_site_permissions').select('site').eq('user_id', user.id)
    for (const g of grants ?? []) if (g.site === 'os' || g.site === 'fs') allowed.add(g.site)
  }

  const cookieSite = (await cookies()).get(SITE_COOKIE)?.value
  const current: Site | null =
    allowed.size === 1 ? ([...allowed][0])
    : (cookieSite === 'os' || cookieSite === 'fs') && allowed.has(cookieSite) ? cookieSite
    : null
  return { allowed, current, role }
})

// Guard for a site's pages: no access → /login; dual + not chosen → /select-site;
// on the wrong site → that site's home. Replaces the role-based redirectIfFsStaff.
export async function requireSite(required: Site): Promise<void> {
  const { allowed, current, role } = await getSiteContext()
  if (allowed.size === 0) redirect('/login')
  if (current === null) redirect('/select-site')
  if (current !== required) redirect(siteHome(current, role))
}
