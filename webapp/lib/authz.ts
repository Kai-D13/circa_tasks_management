// Super-admin gate. The app layer enforces service-role paths (createUser uses
// supabaseAdmin, bypassing RLS); the DB function public.is_super_admin() mirrors
// this for RLS-protected paths (prescription sync).
// TODO (later): replace the hardcoded email with a users.is_super_admin column.
export const SUPER_ADMIN_EMAIL = 'hoangvudn96@gmail.com'

export function isSuperAdminEmail(email: string | null | undefined): boolean {
  return !!email && email.toLowerCase() === SUPER_ADMIN_EMAIL
}
