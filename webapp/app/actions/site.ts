'use server'

import { cookies } from 'next/headers'
import { getSiteContext, siteHome, SITE_COOKIE, type Site } from '@/lib/site/context'

// Pick the current site (dual-access users). Validates the site is allowed
// server-side (cookie never grants), sets circa_site, and returns the home path.
// The client does a HARD navigation (like login) so the just-set cookie is
// carried on the next request instead of racing a soft RSC navigation.
export async function chooseSite(site: Site): Promise<{ redirectTo: string } | { error: string }> {
  if (site !== 'os' && site !== 'fs') return { error: 'Site không hợp lệ' }
  const { allowed, role } = await getSiteContext()
  if (!allowed.has(site)) return { error: 'Bạn không có quyền vào site này' }
  ;(await cookies()).set(SITE_COOKIE, site, { path: '/', httpOnly: true, sameSite: 'lax' })
  return { redirectTo: siteHome(site, role) }
}
