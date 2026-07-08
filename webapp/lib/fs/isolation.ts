import 'server-only'
import { redirect } from 'next/navigation'
import type { createClient } from '@/lib/supabase/server'

type ServerClient = Awaited<ReturnType<typeof createClient>>
// Loose embedded-store shape: different callers embed different columns (some just
// `name`), so allow any object and read store_type when present.
type Embedded = { store_type?: string | null; [k: string]: unknown }
type MiniProfile = { role?: string | null; store_id?: string | null; stores?: Embedded | Embedded[] | null } | null

// FS staff = role 'staff' whose store is an FS store. They must only ever see the
// FS "Quản lý sản phẩm" module — hidden from every OS surface. Gated to role
// 'staff', so OS admins / store_managers / sm skip it. When the caller's profile
// already embeds the store (getSessionProfile does: stores!users_store_id_fkey(*)),
// no query runs; otherwise a single-row PK lookup on stores.
export async function isFsStaffStore(supabase: ServerClient, profile: MiniProfile): Promise<boolean> {
  if (profile?.role !== 'staff') return false
  const embedded = Array.isArray(profile.stores) ? profile.stores[0] : profile.stores
  if (embedded && embedded.store_type != null) return embedded.store_type === 'fs'
  if (!profile.store_id) return false
  const { data } = await supabase.from('stores').select('store_type').eq('id', profile.store_id).maybeSingle()
  return data?.store_type === 'fs'
}

// Route-guard for OS pages: an FS staff who lands on an OS route is sent to their
// module (they reach an OS page at most once before being redirected).
export async function redirectIfFsStaff(supabase: ServerClient, profile: MiniProfile): Promise<void> {
  if (await isFsStaffStore(supabase, profile)) redirect('/fs/products')
}
