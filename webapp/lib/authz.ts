// Super-admin gate. The app layer enforces service-role paths (createUser uses
// supabaseAdmin, bypassing RLS); the DB function public.is_super_admin() mirrors
// this for RLS-protected paths (prescription sync).
// TODO (later): replace the hardcoded allowlist with a users.is_super_admin column.
// Must stay in sync with public.is_super_admin() (migration 046 → synced in 066).
export const SUPER_ADMIN_EMAILS = [
  'hoangvudn96@gmail.com',
  'ngoc.ta@buymed.com',
  'thao@buymed.com',
  'son.kieu@buymed.com',
  'lan.pham@buymed.com',
  'vu@buymed.com',
]

export function isSuperAdminEmail(email: string | null | undefined): boolean {
  return !!email && SUPER_ADMIN_EMAILS.includes(email.toLowerCase())
}

// True for a super admin only (role=admin + an allowlisted email).
export function isSuperAdmin(
  email: string | null | undefined,
  role: string | null | undefined,
): boolean {
  return role === 'admin' && isSuperAdminEmail(email)
}

// Returns the list of store IDs assigned to an SM user.
// Must be called with a server-side Supabase client (not supabaseAdmin — SM has
// RLS SELECT on sm_store_assignments for their own rows).
export async function getSmStoreIds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  smUserId: string,
): Promise<string[]> {
  const { data } = await supabase
    .from('sm_store_assignments')
    .select('store_id')
    .eq('sm_user_id', smUserId)
  return (data ?? []).map((r: { store_id: string }) => r.store_id)
}

// True if the SM user has the given store in their assigned list.
export function smHasStore(storeIds: string[], storeId: string | null | undefined): boolean {
  return !!storeId && storeIds.includes(storeId)
}

// App-layer mirror of the DB own-scope RLS: a non-super admin may only act on
// tasks/broadcasts/schedules they created; the super admin may act on any.
// Used for defense-in-depth in server actions (RLS remains the primary gate).
export function canAdminManageOwn(args: {
  email: string | null | undefined
  role: string | null | undefined
  createdBy: string | null | undefined
  userId: string | null | undefined
}): boolean {
  if (args.role !== 'admin') return false
  if (isSuperAdminEmail(args.email)) return true
  return !!args.createdBy && args.createdBy === args.userId
}
