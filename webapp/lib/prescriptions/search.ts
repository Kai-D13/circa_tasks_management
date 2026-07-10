import 'server-only'

// Shared fuzzy-search resolver for the Toa thuốc list + export (mig 086+) so the
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

export interface PrescriptionSearchPageRow {
  id: string
  order_code: string
  submitted_at: string
  status: string
  is_chronic: boolean
  order_sync_status: string
  care_status: string
  reminder_date: string | null
  expected_refill_date: string | null
  order_created_at: string | null
  days_supply: number | null
  customer_name: string | null
  customer_phone: string | null
  notes: string | null
  order_products_raw: string | null
  store_name: string | null
  submitter_full_name: string | null
  image_count: number
  image_paths: string[]
  total_count: number
  match_source: 'order' | 'product_id' | 'product' | 'note' | null
  match_quality: 'exact' | 'token' | 'fuzzy' | null
  match_text: string | null
  match_score: number | null
}

export interface PrescriptionSearchPageArgs {
  q: string
  by: PrescriptionSearchBy
  limit: number
  offset: number
  orderSync?: string | null
  storeId?: string | null
  care?: string | null
  careState?: string | null
  ownerOnly?: boolean
  today?: string
  dateFrom?: string | null
  dateTo?: string | null
}

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

// Paged row RPC (mig 087; precision metadata in mig 089). This avoids the old
// ids -> .in(id, [...hundreds]) pattern, which can exceed PostgREST's URL
// length for broad DHC searches.
export async function searchPrescriptionsPage(
  supabase: RpcClient,
  args: PrescriptionSearchPageArgs,
): Promise<{ rows: PrescriptionSearchPageRow[]; total: number } | 'fallback'> {
  const { data, error } = await supabase.rpc('rpc_search_prescriptions_page', {
    p_q: args.q,
    p_by: args.by,
    p_limit: args.limit,
    p_offset: args.offset,
    p_order_sync: args.orderSync || null,
    p_store_id: args.storeId || null,
    p_care: args.care || null,
    p_care_state: args.careState || null,
    p_owner_only: Boolean(args.ownerOnly),
    p_today: args.today || null,
    p_date_from: args.dateFrom || null,
    p_date_to: args.dateTo || null,
  })
  if (error) {
    console.error('[prescriptions] paged search rpc failed (mig 087/089 chua chay?):', error.message)
    return 'fallback'
  }
  const rows = (data ?? []) as PrescriptionSearchPageRow[]
  return { rows, total: rows[0]?.total_count ?? 0 }
}
