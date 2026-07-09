import 'server-only'
import { redirect } from 'next/navigation'
import type { createClient } from '@/lib/supabase/server'

type ServerClient = Awaited<ReturnType<typeof createClient>>
// Loose embedded-store shape: different callers embed different columns (some just
// `name`), so allow any object and read store_type when present.
type Embedded = { store_type?: string | null; [k: string]: unknown }
type MiniProfile = { role?: string | null; store_id?: string | null; stores?: Embedded | Embedded[] | null } | null

// An FS-store user = a store-level account (staff or store_manager) whose store is
// an FS store. They must only ever see the FS "Quản lý sản phẩm" module — hidden
// from every OS surface. (Only 'staff' is an operator; a store_manager of an FS
// store is contained here too so they can't leak into the OS app — F5 r1.) Gated
// to store-level roles, so OS admins / sm skip it. When the profile already embeds
// the store (getSessionProfile does: stores!users_store_id_fkey(*)) no query runs;
// otherwise a single-row PK lookup on stores.
export async function isFsStoreUser(supabase: ServerClient, profile: MiniProfile): Promise<boolean> {
  if (profile?.role !== 'staff' && profile?.role !== 'store_manager') return false
  const embedded = Array.isArray(profile.stores) ? profile.stores[0] : profile.stores
  if (embedded && embedded.store_type != null) return embedded.store_type === 'fs'
  if (!profile.store_id) return false
  const { data } = await supabase.from('stores').select('store_type').eq('id', profile.store_id).maybeSingle()
  return data?.store_type === 'fs'
}

// Route-guard for OS pages: an FS-store user who lands on an OS route is sent to
// their module (they reach an OS page at most once before being redirected).
export async function redirectIfFsStaff(supabase: ServerClient, profile: MiniProfile): Promise<void> {
  if (await isFsStoreUser(supabase, profile)) redirect('/fs/products')
}
