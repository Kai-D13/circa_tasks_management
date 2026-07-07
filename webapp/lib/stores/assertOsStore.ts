import { supabaseAdmin } from '@/lib/supabase/admin'

/**
 * Server-side FS/OS isolation boundary (mig 076, stakeholder P1).
 *
 * The OS store pickers already filter store_type='os', but a crafted request or
 * a direct server-action call could still pass an FS (franchise) store_id into
 * an OS write (task create/broadcast/schedule, user store assignment). UI
 * filtering is cosmetic; isolation is a business boundary — so every OS write
 * validates its store_id(s) here before persisting. FS-store users/tasks are
 * created only through the FS module (never these generic OS paths).
 *
 * Returns null when every id is an OS store (and active, if requireActive);
 * otherwise a ready-to-return Vietnamese error string. Null/empty ids are
 * ignored (an admin with no store, an 'all'-scope with no explicit ids).
 */
export async function assertOsStoreIds(
  storeIds: (string | null | undefined)[],
  opts: { requireActive?: boolean } = {},
): Promise<string | null> {
  const unique = [...new Set(storeIds.filter((s): s is string => !!s))]
  if (unique.length === 0) return null

  const { data, error } = await supabaseAdmin
    .from('stores').select('id, is_active, store_type').in('id', unique)
  if (error) return 'Không kiểm tra được cửa hàng: ' + error.message

  const byId = new Map((data ?? []).map((s) => [s.id, s]))
  for (const id of unique) {
    const s = byId.get(id)
    if (!s) return 'Cửa hàng không tồn tại.'
    if (s.store_type !== 'os')
      return 'Cửa hàng không thuộc hệ thống OS — không dùng được cho chức năng này.'
    if (opts.requireActive && s.is_active === false)
      return 'Cửa hàng đã ngừng hoạt động.'
  }
  return null
}
