import 'server-only'

// Shared fuzzy-search resolver for the Toa thuốc list + export (mig 086) so the
// two can never diverge. rpc_search_prescription_ids is SECURITY INVOKER — the
// caller's RLS scopes the ids — so this must be called with the SESSION client,
// never supabaseAdmin.

export type PrescriptionSearchBy = 'all' | 'order' | 'product' | 'note'

export function parseSearchBy(v: string | null | undefined): PrescriptionSearchBy {
  return v === 'order' || v === 'product' || v === 'note' ? v : 'all'
}

// PostgREST rejects an empty in.() list — filter on this impossible uuid to
// express "search matched nothing" as a normal zero-row query.
export const NO_MATCH_ID = '00000000-0000-0000-0000-000000000000'

// Structural client type: keeps this helper decoupled from supabase-js generics.
type RpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) =>
    PromiseLike<{ data: unknown; error: { message: string } | null }>
}

// Returns matching submission ids (relevance-ordered, capped server-side), or
// 'fallback' when the RPC fails (e.g. migration 086 not applied yet) — callers
// then degrade to a plain order_code ilike so search never breaks the page.
export async function searchPrescriptionIds(
  supabase: RpcClient,
  q: string,
  by: PrescriptionSearchBy,
  limit = 300,
): Promise<string[] | 'fallback'> {
  const { data, error } = await supabase.rpc('rpc_search_prescription_ids', {
    p_q: q, p_by: by, p_limit: limit,
  })
  if (error) {
    console.error('[prescriptions] search rpc failed (mig 086 chưa chạy?):', error.message)
    return 'fallback'
  }
  return ((data ?? []) as { id: string }[]).map((r) => r.id)
}
