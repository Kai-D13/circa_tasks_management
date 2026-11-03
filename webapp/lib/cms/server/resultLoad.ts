import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { isCmsEarningsEnabled } from '@/lib/cms/flags'
import { cmsLoadResultHeader, cmsLoadResultRows } from '@/lib/cms/server/results'
import { CmsQueryError, cmsQueryFailLine } from '@/lib/cms/queryLog'
import { cmsPinnedResults, type CmsResultsLoad } from '@/lib/cms/resultUi'
import type { CmsProductView, CmsProgramRowView, CmsTierView } from '@/lib/cms/server/catalog'
import type { CmsGmvBasis } from '@/lib/cms/display'
import type { CmsProgramDbStatus } from '@/lib/cms/programStatus'

// CMS P2-c (I3) — nạp kết quả cho màn D1 / D2 / D3 / A1 / A3 bằng SESSION client (RPC 122 SECDEF lọc phạm vi hiện tại +
// marker QA trong DB). Cờ CMS_EARNINGS_ENABLED OFF ⇒ KHÔNG gọi RPC nào (giữ nguyên UI / truy vấn P1). Lỗi ⇒ trạng thái
// lỗi, không bao giờ rỗng / 0 thay lỗi; log chỉ mã máy (lib/cms/queryLog).

/**
 * Header rồi rows GHIM run_id của header (lõi thuần `cmsPinnedResults` — test hành vi ở cms-p2c-unit): run đổi giữa hai lần
 * gọi ⇒ đọc lại một lần; vẫn đổi ⇒ 'gone' (UI: dữ liệu vừa đổi, tải lại). Cờ OFF ⇒ 'off', không gọi RPC.
 */
export function cmsLoadResults(programId: string, o: { started: boolean }): Promise<CmsResultsLoad> {
  return cmsPinnedResults({ enabled: isCmsEarningsEnabled(), header: cmsLoadResultHeader, rows: cmsLoadResultRows }, programId, o)
}

// ── Mẫu số Q-212: tài khoản staff hiện thuộc nhà thuốc hợp lệ trong phạm vi chương trình ∩ phạm vi người xem ──────────
// Cùng định nghĩa phạm vi với cms__visible_result_users (122): staff có store OS đang hoạt động; SM ∩ nhà thuốc được phân
// công; super = toàn bộ. Không cộng QLCH (store_manager) / vai khác. Lỗi ⇒ null (UI bỏ mẫu số, không ước lượng).
export async function cmsLoadEligibleStaffIds(o: { programStoreIds: string[]; viewer: { id: string; role: string | null; isSuper: boolean } }): Promise<string[] | null> {
  try {
    const supabase = await createClient()
    let storeIds = [...new Set(o.programStoreIds)]
    if (!o.viewer.isSuper) {
      if (o.viewer.role !== 'sm') return null
      const { data, error } = await supabase.from('sm_store_assignments').select('store_id').eq('sm_user_id', o.viewer.id)
      if (error) throw new CmsQueryError(error.code)
      const mine = new Set(((data ?? []) as { store_id: string }[]).map((x) => x.store_id))
      storeIds = storeIds.filter((s) => mine.has(s))
    }
    if (storeIds.length === 0) return []
    const valid: string[] = []
    for (let i = 0; i < storeIds.length; i += 200) {
      const { data, error } = await supabase.from('stores').select('id').in('id', storeIds.slice(i, i + 200))
        .eq('store_type', 'os').eq('is_active', true)
      if (error) throw new CmsQueryError(error.code)
      valid.push(...((data ?? []) as { id: string }[]).map((x) => x.id))
    }
    const ids: string[] = []
    for (let i = 0; i < valid.length; i += 200) {
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase.from('users').select('id').eq('role', 'staff').in('store_id', valid.slice(i, i + 200))
          .order('id').range(from, from + 999)
        if (error) throw new CmsQueryError(error.code)
        const rows = (data ?? []) as { id: string }[]
        ids.push(...rows.map((x) => x.id))
        if (rows.length < 1000) break
        if (from > 100_000) throw new CmsQueryError('TOO_MANY_ROWS')
      }
    }
    return [...new Set(ids)]
  } catch (e) {
    console.error(cmsQueryFailLine('cms-result-denominator', e))
    return null
  }
}

// ── D3: chương trình có lịch sử (Đang chạy + Chờ chốt kỳ) của người xem ──────────────────────────────────────────────
// RLS 120: staff / QLCH đọc chương trình active / locked có nhà thuốc hiện tại. D3 P2 đọc phiên kết quả hiện hành của
// chương trình active đã bắt đầu (kể cả đã hết ngày — Chờ chốt kỳ, UI §4.3); Đã chốt đọc payout là P3 (HOLD — U14).
type ProgramDb = {
  id: string; name: string; status: CmsProgramDbStatus; start_date: string; end_date: string; scope: 'all' | 'stores'
  is_test: boolean; catalog_target_gmv: string | null; config_version: number; activated_at: string | null; created_at: string
}
const PROGRAM_COLS = 'id, name, status, start_date, end_date, scope, is_test, catalog_target_gmv::text, config_version, activated_at, created_at'
const toProgram = (p: ProgramDb): CmsProgramRowView => ({
  id: p.id, name: p.name, status: p.status, startDate: p.start_date, endDate: p.end_date, scope: p.scope, isTest: p.is_test,
  catalogTargetGmv: p.catalog_target_gmv, configVersion: p.config_version, activatedAt: p.activated_at, createdAt: p.created_at,
})
type ProductDb = {
  id: string; program_id: string; product_id: string; gmv_basis: CmsGmvBasis; target_gmv: string | null; unit_cms: string
  base_quantity_cms: string; advice_text: string; name_snapshot: string; image_url_snapshot: string | null
  price_snapshot: string | null; added_after_start: boolean
}
const PRODUCT_COLS = 'id, program_id, product_id, gmv_basis, target_gmv::text, unit_cms, base_quantity_cms::text, advice_text, name_snapshot, image_url_snapshot, price_snapshot::text, added_after_start'
type TierDb = { program_product_id: string; tier_order: number; qty_from: number; qty_to: number | null; amount_per_unit: string }

async function readAll<T>(q: (a: number, b: number) => PromiseLike<{ data: unknown[] | null; error: { code?: string } | null }>): Promise<T[]> {
  const out: T[] = []
  for (let p = 0; p < 100; p++) {
    const { data, error } = await q(out.length, out.length + 999)
    if (error) throw new CmsQueryError(error.code)
    const rows = (data ?? []) as T[]
    if (rows.length === 0) return out
    out.push(...rows)
  }
  throw new CmsQueryError('TOO_MANY_ROWS')
}

export interface CmsHistoryPrograms { programs: CmsProgramRowView[] }

export async function cmsLoadHistoryPrograms(today: string): Promise<{ ok: true; data: CmsProgramRowView[] } | { ok: false }> {
  try {
    const supabase = await createClient()
    const rows = await readAll<ProgramDb>((a, b) => supabase.from('cms_programs').select(PROGRAM_COLS)
      .eq('status', 'active').lte('start_date', today).order('end_date', { ascending: false }).order('id').range(a, b))
    return { ok: true, data: rows.map(toProgram) }
  } catch (e) {
    console.error(cmsQueryFailLine('cms-history-programs', e))
    return { ok: false }
  }
}

/** Danh mục (SP + bậc) của một chương trình người xem đọc được qua RLS — để gắn tên / đơn vị vào dòng D3 / XLSX. */
export async function cmsLoadProgramProducts(programId: string): Promise<{ ok: true; data: CmsProductView[] } | { ok: false }> {
  try {
    const supabase = await createClient()
    const [products, tiers] = await Promise.all([
      readAll<ProductDb>((a, b) => supabase.from('cms_program_products').select(PRODUCT_COLS).eq('program_id', programId)
        .order('created_at').order('id').range(a, b)),
      readAll<TierDb>((a, b) => supabase.from('cms_program_tiers').select('program_product_id, tier_order, qty_from, qty_to, amount_per_unit::text')
        .eq('program_id', programId).order('program_product_id').order('tier_order').range(a, b)),
    ])
    const byPp = new Map<string, CmsTierView[]>()
    for (const t of tiers) {
      const l = byPp.get(t.program_product_id) ?? []
      l.push({ order: t.tier_order, from: t.qty_from, to: t.qty_to, amount: t.amount_per_unit })
      byPp.set(t.program_product_id, l)
    }
    return {
      ok: true,
      data: products.map((p) => ({
        id: p.id, programId: p.program_id, productId: p.product_id, gmvBasis: p.gmv_basis, targetGmv: p.target_gmv, unitCms: p.unit_cms,
        baseQuantityCms: p.base_quantity_cms, adviceText: p.advice_text, nameSnapshot: p.name_snapshot,
        imageUrlSnapshot: p.image_url_snapshot, priceSnapshot: p.price_snapshot, addedAfterStart: p.added_after_start,
        tiers: (byPp.get(p.id) ?? []).sort((x, y) => x.order - y.order),
      })),
    }
  } catch (e) {
    console.error(cmsQueryFailLine('cms-program-products', e))
    return { ok: false }
  }
}

/** Tên nhà thuốc theo id (A3 / XLSX). Lỗi ⇒ Map rỗng (UI hiện '—' cho tên, số liệu không đổi). */
export async function cmsLoadStoreNames(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const uniq = [...new Set(ids)]
  try {
    const supabase = await createClient()
    for (let i = 0; i < uniq.length; i += 200) {
      const { data, error } = await supabase.from('stores').select('id, name').in('id', uniq.slice(i, i + 200))
      if (error) throw new CmsQueryError(error.code)
      for (const s of (data ?? []) as { id: string; name: string }[]) out.set(s.id, s.name)
    }
  } catch (e) {
    console.error(cmsQueryFailLine('cms-store-names', e))
  }
  return out
}
