import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/admin'

// Inventory → TRF ingest. Reads canonicalized Sheet rows, maps pos_code_check →
// stores.code, and creates ONE store-level task + one inventory_trf_items row per
// NEW (store, trf). Two phases so we NEVER write partially:
//   preflightTrf() — validate headers, normalize, match store, detect in-Sheet
//                    duplicates (hard error), split existing-skip vs new.
//   createTrfTasks() — bump last_seen on skips, then atomic create via
//                      rpc_create_inventory_trf_items (task+item per row, no orphan).
// Append-only feed (no replace-all / shrink guard). Service-role writes.

const canon = (k: string) => k.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

// canon header → human label (for the "missing column" message).
const REQUIRED: [string, string][] = [
  ['poscodecheck', 'pos_code_check'],
  ['posnamecheck', 'pos_name_check'],
  ['trfcode', 'TRF_code'],
  ['reason', 'reason'],
  ['createdby', 'created_by'],
]

export interface TrfNewItem {
  store_id: string
  pos_code_check: string
  pos_name_check: string | null
  trf_code: string
  reason: string | null
  internal_created_by: string | null
}

export interface TrfPreflight {
  newItems: TrfNewItem[]
  skippedItemIds: string[] // inventory_trf_items.id to bump last_seen_at
  skipped: number
  unmatched: string[]
}

export interface TrfResult {
  pulled: number
  created: number
  skipped: number
  unmatched: string[]
  duplicates: number
}

// Read-only validation + classification. Returns an error string BEFORE any write
// for a missing header or an in-Sheet (store, trf) duplicate.
export async function preflightTrf(
  rawRows: Record<string, unknown>[],
): Promise<TrfPreflight | { error: string }> {
  if (rawRows.length === 0) return { newItems: [], skippedItemIds: [], skipped: 0, unmatched: [] }

  const headerKeys = new Set(Object.keys(rawRows[0]).map(canon))
  const missing = REQUIRED.filter(([c]) => !headerKeys.has(c)).map(([, label]) => label)
  if (missing.length) return { error: `Thiếu cột: ${missing.join(', ')} — kiểm tra lại Google Sheet` }

  const { data: stores, error: storesErr } = await supabaseAdmin.from('stores').select('id, code')
  if (storesErr) return { error: `Không đọc được stores: ${storesErr.message}` }
  const byCode = new Map(
    (stores ?? []).filter((s) => s.code).map((s) => [String(s.code).trim().toUpperCase(), s.id]),
  )

  type Cand = TrfNewItem & { key: string }
  const cands: Cand[] = []
  const unmatched: string[] = []
  const seen = new Map<string, number>()

  for (const raw of rawRows) {
    const lo: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(raw)) lo[canon(k)] = v
    const posCode = str(lo['poscodecheck'])?.toUpperCase() ?? null
    const trfCode = str(lo['trfcode'])
    if (!posCode || !trfCode) continue // blank/trailing Sheet row
    const posName = str(lo['posnamecheck'])
    const storeId = byCode.get(posCode)
    if (!storeId) { unmatched.push(`${posName ?? '?'} (${posCode})`); continue }
    const key = `${storeId}|${trfCode.toUpperCase()}`
    seen.set(key, (seen.get(key) ?? 0) + 1)
    cands.push({
      key,
      store_id: storeId,
      pos_code_check: posCode,
      pos_name_check: posName,
      trf_code: trfCode,
      reason: str(lo['reason']),
      internal_created_by: str(lo['createdby']),
    })
  }

  // In-Sheet duplicate (same store+trf appears ≥2 times) → hard 422, no partial.
  const dups = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k)
  if (dups.length) {
    return { error: `Trùng (store, TRF) trong cùng Sheet: ${dups.slice(0, 10).join(', ')}${dups.length > 10 ? '…' : ''}` }
  }

  // Existing-skip: any (store, trf) already in inventory_trf_items.
  const storeIds = [...new Set(cands.map((c) => c.store_id))]
  let existing = new Map<string, string>()
  if (storeIds.length) {
    const { data: items, error: itErr } = await supabaseAdmin
      .from('inventory_trf_items').select('id, store_id, trf_code').in('store_id', storeIds)
    if (itErr) return { error: `Không đọc được inventory_trf_items: ${itErr.message}` }
    existing = new Map((items ?? []).map((i) => [`${i.store_id}|${String(i.trf_code).toUpperCase()}`, i.id]))
  }

  const newItems: TrfNewItem[] = []
  const skippedItemIds: string[] = []
  for (const c of cands) {
    const exId = existing.get(c.key)
    if (exId) { skippedItemIds.push(exId); continue }
    newItems.push({
      store_id: c.store_id,
      pos_code_check: c.pos_code_check,
      pos_name_check: c.pos_name_check,
      trf_code: c.trf_code,
      reason: c.reason,
      internal_created_by: c.internal_created_by,
    })
  }

  return { newItems, skippedItemIds, skipped: skippedItemIds.length, unmatched }
}

// Write phase: bump last_seen on skips, atomic create of the new items.
export async function createTrfTasks(
  rawRows: Record<string, unknown>[],
  opts: { runId: string; createdBy: string; deadlineHours: number },
): Promise<TrfResult | { error: string }> {
  const pre = await preflightTrf(rawRows)
  if ('error' in pre) return pre

  if (pre.skippedItemIds.length) {
    // Has a WHERE (id IN ...) → pg_safeupdate-safe. Best-effort; not fatal.
    const { error: upErr } = await supabaseAdmin
      .from('inventory_trf_items')
      .update({ last_seen_at: new Date().toISOString() })
      .in('id', pre.skippedItemIds)
    if (upErr) console.error('[inventory-trf] last_seen_at update failed:', upErr.message)
  }

  let created = 0
  if (pre.newItems.length) {
    const { data, error } = await supabaseAdmin.rpc('rpc_create_inventory_trf_items', {
      p_items: pre.newItems,
      p_created_by: opts.createdBy,
      p_deadline_hours: opts.deadlineHours,
      p_run_id: opts.runId,
    })
    if (error) return { error: `Tạo task TRF lỗi: ${error.message}` }
    created = (data as number | null) ?? pre.newItems.length
  }

  return { pulled: rawRows.length, created, skipped: pre.skipped, unmatched: pre.unmatched, duplicates: 0 }
}
