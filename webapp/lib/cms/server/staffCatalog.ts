import 'server-only'
import { createClient } from '@/lib/supabase/server'
import type { CmsGmvBasis } from '@/lib/cms/display'
import type { CmsProgramDbStatus } from '@/lib/cms/programStatus'
import type { CmsProductView, CmsProgramRowView, CmsResult, CmsTierView } from '@/lib/cms/server/catalog'
import { cmsPickStaffProgram } from '@/lib/cms/staffView'
import { CmsQueryError, cmsQueryFailLine } from '@/lib/cms/queryLog'
import { cmsProgramBasisOf, cmsSelectWithBasis } from '@/lib/cms/programBasisCol'

// CMS P1-d — đọc danh mục cho staff / QLCH (D1 `/targets?tab=cms`, D2 `/targets/cms/products/[id]`) bằng SESSION client:
// RLS 120 đã giới hạn chương trình active / locked có nhà thuốc hiện tại của người xem (store OS đang hoạt động; QA chỉ
// với marker; chuyển ra ngoài chương trình ⇒ không đọc — Q-217). P3a r2 (PM r1 PKG-P1-1): đọc active (MỌI ngày — gồm Chờ
// chốt kỳ) + locked; D1 nhóm "Đã kết thúc" trong bộ chọn (H5: bộ lọc P1 không dùng để giấu lịch sử). Không nới RLS / vai.
// Không service role. Lỗi ⇒ log server + mã chung (không đưa message DB lên UI). File riêng P1-d — không sửa catalog.ts.
/** Trạng thái DB mở được ở D1 / D2 (nháp không bao giờ — RLS cũng không trả nháp cho staff / QLCH). */
export const CMS_STAFF_PROGRAM_STATUSES = ['active', 'locked'] as const

const PAGE = 1000
const MAX_PAGES = 100
type Q = (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { code?: string } | null }>
async function readAll<T>(query: Q): Promise<T[]> {
  const out: T[] = []
  for (let p = 0; p < MAX_PAGES; p++) {
    const { data, error } = await query(out.length, out.length + PAGE - 1)
    if (error) throw new CmsQueryError(error.code)
    const rows = (data ?? []) as T[]
    if (rows.length === 0) return out
    out.push(...rows)
  }
  throw new CmsQueryError('TOO_MANY_ROWS')
}
const fail = (e: unknown): { ok: false; error: string } => {
  console.error(cmsQueryFailLine('cms-staff-catalog', e)) // chỉ mã máy, không message DB (PM 03/11 §3.2)
  return { ok: false, error: 'QUERY_FAILED' }
}

type ProgramDb = {
  id: string; name: string; status: CmsProgramDbStatus; start_date: string; end_date: string; scope: 'all' | 'stores'
  is_test: boolean; catalog_target_gmv: string | null; config_version: number; activated_at: string | null; created_at: string
  /** CMS-UNIT (128): thiếu trên DB cũ ⇒ pos_base (cmsProgramBasisOf). */
  quantity_basis?: string
}
const PROGRAM_COLS = 'id, name, status, start_date, end_date, scope, is_test, catalog_target_gmv::text, config_version, activated_at, created_at'
const toProgram = (p: ProgramDb): CmsProgramRowView => ({
  id: p.id, name: p.name, status: p.status, startDate: p.start_date, endDate: p.end_date, scope: p.scope, isTest: p.is_test,
  catalogTargetGmv: p.catalog_target_gmv, configVersion: p.config_version, activatedAt: p.activated_at, createdAt: p.created_at,
  quantityBasis: cmsProgramBasisOf(p.quantity_basis),
})
type ProductDb = {
  id: string; program_id: string; product_id: string; gmv_basis: CmsGmvBasis; target_gmv: string | null; unit_cms: string
  base_quantity_cms: string; advice_text: string; name_snapshot: string; image_url_snapshot: string | null
  price_snapshot: string | null; added_after_start: boolean
}
const PRODUCT_COLS = 'id, program_id, product_id, gmv_basis, target_gmv::text, unit_cms, base_quantity_cms::text, advice_text, name_snapshot, image_url_snapshot, price_snapshot::text, added_after_start'
type TierDb = { program_product_id: string; tier_order: number; qty_from: number; qty_to: number | null; amount_per_unit: string }
const TIER_COLS = 'program_product_id, tier_order, qty_from, qty_to, amount_per_unit::text'

function attachTiers(products: ProductDb[], tiers: TierDb[]): CmsProductView[] {
  const byPp = new Map<string, CmsTierView[]>()
  for (const t of tiers) {
    const l = byPp.get(t.program_product_id) ?? []
    l.push({ order: t.tier_order, from: t.qty_from, to: t.qty_to, amount: t.amount_per_unit })
    byPp.set(t.program_product_id, l)
  }
  return products.map((p) => ({
    id: p.id, programId: p.program_id, productId: p.product_id, gmvBasis: p.gmv_basis, targetGmv: p.target_gmv, unitCms: p.unit_cms,
    baseQuantityCms: p.base_quantity_cms, adviceText: p.advice_text, nameSnapshot: p.name_snapshot,
    imageUrlSnapshot: p.image_url_snapshot, priceSnapshot: p.price_snapshot, addedAfterStart: p.added_after_start,
    tiers: (byPp.get(p.id) ?? []).sort((a, b) => a.order - b.order),
  }))
}

export interface CmsStaffCatalog {
  programs: CmsProgramRowView[]
  selected: CmsProgramRowView | null
  products: CmsProductView[]
}

export async function cmsLoadStaffCatalog(o: { today: string; programId: string | null }): Promise<CmsResult<CmsStaffCatalog>> {
  try {
    const supabase = await createClient()
    const programs = (await readAll<ProgramDb>((a, b) => cmsSelectWithBasis((x) => supabase.from('cms_programs').select(PROGRAM_COLS + x)
      .in('status', [...CMS_STAFF_PROGRAM_STATUSES]).order('start_date').order('id').range(a, b)))).map(toProgram)
    const selected = cmsPickStaffProgram(programs, o.today, o.programId)
    if (!selected) return { ok: true, data: { programs, selected: null, products: [] } }
    const [products, tiers] = await Promise.all([
      readAll<ProductDb>((a, b) => supabase.from('cms_program_products').select(PRODUCT_COLS).eq('program_id', selected.id)
        .order('created_at').order('id').range(a, b)),
      readAll<TierDb>((a, b) => supabase.from('cms_program_tiers').select(TIER_COLS).eq('program_id', selected.id)
        .order('program_product_id').order('tier_order').range(a, b)),
    ])
    return { ok: true, data: { programs, selected, products: attachTiers(products, tiers) } }
  } catch (e) {
    return fail(e)
  }
}

export interface CmsStaffProduct { program: CmsProgramRowView; product: CmsProductView }

/** D2: theo id dòng chương trình; ngoài RLS (nhà thuốc khác, QA không marker, nháp, đã chuyển ra ngoài — Q-217) ⇒ null
 *  (404). P3a r2: Sắp diễn ra / Đang chạy / Chờ chốt kỳ / Đã chốt đều mở được (deep link kiểm quyền bằng RLS phiên). */
export async function cmsLoadStaffProduct(programProductId: string): Promise<CmsResult<CmsStaffProduct | null>> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(programProductId)) return { ok: true, data: null }
  try {
    const supabase = await createClient()
    const { data: pp, error } = await supabase.from('cms_program_products').select(PRODUCT_COLS).eq('id', programProductId).maybeSingle()
    if (error) throw new CmsQueryError(error.code)
    if (!pp) return { ok: true, data: null }
    const prod = pp as unknown as ProductDb
    // Lọc trạng thái ngay ở truy vấn (phòng thủ chiều sâu, cùng điều kiện D1) + kiểm lại ở app bên dưới.
    const { data: prog, error: pErr } = await cmsSelectWithBasis((x) => supabase.from('cms_programs').select(PROGRAM_COLS + x).eq('id', prod.program_id)
      .in('status', [...CMS_STAFF_PROGRAM_STATUSES]).maybeSingle())
    if (pErr) throw new CmsQueryError(pErr.code)
    const program = prog ? toProgram(prog as unknown as ProgramDb) : null
    if (!program || !(CMS_STAFF_PROGRAM_STATUSES as readonly string[]).includes(program.status)) return { ok: true, data: null }
    const tiers = await readAll<TierDb>((a, b) => supabase.from('cms_program_tiers').select(TIER_COLS)
      .eq('program_product_id', programProductId).order('tier_order').range(a, b))
    return { ok: true, data: { program, product: attachTiers([prod], tiers)[0] } }
  } catch (e) {
    return fail(e)
  }
}
