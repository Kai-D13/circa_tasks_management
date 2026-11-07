import 'server-only'
import { createClient } from '@/lib/supabase/server'
import type { CmsGmvBasis } from '@/lib/cms/display'
import type { CmsProgramDbStatus } from '@/lib/cms/programStatus'
import { CmsQueryError, cmsQueryFailLine } from '@/lib/cms/queryLog'

// CMS P1 — đọc danh mục bằng SESSION client (SPEC §7: "Đọc danh mục (P1): bảng danh mục qua RLS"). RLS 120 quyết định
// phạm vi: super (mọi chương trình thật; QA chỉ khi có marker — H9b), SM (active có nhà thuốc phân công — H6),
// staff / QLCH (active + locked theo nhà thuốc hiện tại). KHÔNG dùng service role ở đây. Đọc đủ mọi trang (không dựa
// trần dòng PostgREST). Lỗi ⇒ trả lỗi để màn hiện ErrorState — không bao giờ trả danh sách rỗng / số 0 thay lỗi.

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

export interface CmsProgramRowView {
  id: string
  name: string
  status: CmsProgramDbStatus
  startDate: string
  endDate: string
  scope: 'all' | 'stores'
  isTest: boolean
  catalogTargetGmv: string | null
  configVersion: number
  activatedAt: string | null
  createdAt: string
}

export interface CmsImportRunView {
  id: string
  mode: 'replace' | 'append'
  status: 'previewed' | 'committed'
  rowsTotal: number
  rowsOk: number
  rowsError: number
  rowsWarning: number
  productsOk: number
  productsRejected: number
  createdAt: string
  committedAt: string | null
}

export interface CmsTierView { order: number; from: number; to: number | null; amount: string }

export interface CmsProductView {
  id: string
  programId: string
  productId: string
  gmvBasis: CmsGmvBasis
  targetGmv: string | null
  unitCms: string
  baseQuantityCms: string
  adviceText: string
  nameSnapshot: string
  imageUrlSnapshot: string | null
  priceSnapshot: string | null
  addedAfterStart: boolean
  tiers: CmsTierView[]
}

type ProgramDb = {
  id: string; name: string; status: CmsProgramDbStatus; start_date: string; end_date: string; scope: 'all' | 'stores'
  is_test: boolean; catalog_target_gmv: string | null; config_version: number; activated_at: string | null; created_at: string
}
const PROGRAM_COLS = 'id, name, status, start_date, end_date, scope, is_test, catalog_target_gmv::text, config_version, activated_at, created_at'
const toProgram = (p: ProgramDb): CmsProgramRowView => ({
  id: p.id, name: p.name, status: p.status, startDate: p.start_date, endDate: p.end_date, scope: p.scope, isTest: p.is_test,
  catalogTargetGmv: p.catalog_target_gmv, configVersion: p.config_version, activatedAt: p.activated_at, createdAt: p.created_at,
})

type RunDb = {
  id: string; program_id: string; mode: 'replace' | 'append'; status: 'previewed' | 'committed'; rows_total: number; rows_ok: number
  rows_error: number; rows_warning: number; products_ok: number; products_rejected: number; created_at: string; committed_at: string | null
}
const RUN_COLS = 'id, program_id, mode, status, rows_total, rows_ok, rows_error, rows_warning, products_ok, products_rejected, created_at, committed_at'
const toRun = (r: RunDb): CmsImportRunView => ({
  id: r.id, mode: r.mode, status: r.status, rowsTotal: r.rows_total, rowsOk: r.rows_ok, rowsError: r.rows_error,
  rowsWarning: r.rows_warning, productsOk: r.products_ok, productsRejected: r.products_rejected, createdAt: r.created_at,
  committedAt: r.committed_at,
})

export type CmsResult<T> = { ok: true; data: T } | { ok: false; error: string }
// Lỗi DB chỉ ghi log phía server; kết quả trả MÃ chung (không đưa message DB lên UI — security review P1-c P2-3).
const fail = (e: unknown): { ok: false; error: string } => {
  console.error(cmsQueryFailLine('cms-catalog', e)) // chỉ mã máy, không message DB (PM 03/11 §3.2)
  return { ok: false, error: 'QUERY_FAILED' }
}

// ── A1 ──────────────────────────────────────────────────────────────────────
export interface CmsAdminListItem extends CmsProgramRowView {
  productCount: number
  productIds: string[]
  /** Lần import ĐÃ GHI gần nhất (chỉ super đọc được import run — RLS); SM ⇒ null. */
  lastImport: CmsImportRunView | null
}

/** `manage`: chỉ super mới truy vấn import run (SM nhận 0 dòng qua RLS — bỏ hẳn truy vấn, PM review P1-c P2). */
export async function cmsLoadAdminList(o: { manage: boolean }): Promise<CmsResult<CmsAdminListItem[]>> {
  try {
    const supabase = await createClient()
    const programs = await readAll<ProgramDb>((a, b) => supabase.from('cms_programs').select(PROGRAM_COLS)
      .order('created_at', { ascending: false }).order('id').range(a, b))
    const products = await readAll<{ program_id: string; product_id: string }>((a, b) => supabase.from('cms_program_products')
      .select('program_id, product_id').order('program_id').order('product_id').range(a, b))
    const runs = !o.manage ? [] as RunDb[] : await readAll<RunDb>((a, b) => supabase.from('cms_import_runs').select(RUN_COLS)
      .eq('status', 'committed').order('committed_at', { ascending: false }).order('id').range(a, b))
    const byProgram = new Map<string, string[]>()
    for (const r of products) {
      const l = byProgram.get(r.program_id)
      if (l) l.push(r.product_id); else byProgram.set(r.program_id, [r.product_id])
    }
    const lastRun = new Map<string, CmsImportRunView>()
    for (const r of runs) if (!lastRun.has(r.program_id)) lastRun.set(r.program_id, toRun(r))
    return {
      ok: true,
      data: programs.map((p) => {
        const ids = byProgram.get(p.id) ?? []
        return { ...toProgram(p), productCount: ids.length, productIds: ids, lastImport: lastRun.get(p.id) ?? null }
      }),
    }
  } catch (e) {
    return fail(e)
  }
}

// ── A3 + sửa + import ───────────────────────────────────────────────────────
export interface CmsProgramDetail {
  program: CmsProgramRowView
  products: CmsProductView[]
  storeCount: number
  /** Tên nhà thuốc khi phạm vi 'stores' (null nếu không đọc được tên — chỉ hiện số). */
  storeNames: string[] | null
  storeIds: string[]
  /** Lịch sử import (chỉ super đọc được — RLS); SM ⇒ []. */
  runs: CmsImportRunView[]
}

type ProductDb = {
  id: string; program_id: string; product_id: string; gmv_basis: CmsGmvBasis; target_gmv: string | null; unit_cms: string
  base_quantity_cms: string; advice_text: string; name_snapshot: string; image_url_snapshot: string | null
  price_snapshot: string | null; added_after_start: boolean
}
const PRODUCT_COLS = 'id, program_id, product_id, gmv_basis, target_gmv::text, unit_cms, base_quantity_cms::text, advice_text, name_snapshot, image_url_snapshot, price_snapshot::text, added_after_start'
type TierDb = { program_product_id: string; tier_order: number; qty_from: number; qty_to: number | null; amount_per_unit: string }

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

/** `manage`: chỉ super (quản lý) mới tải lịch sử import + tên nhà thuốc (SM chỉ cần cấu hình — phòng thủ chiều sâu, RLS
 *  vẫn chặn import run với SM). */
export async function cmsLoadProgramDetail(id: string, o: { manage: boolean }): Promise<CmsResult<CmsProgramDetail | null>> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return { ok: true, data: null }
  try {
    const supabase = await createClient()
    const { data: prog, error } = await supabase.from('cms_programs').select(PROGRAM_COLS).eq('id', id).maybeSingle()
    if (error) throw new CmsQueryError(error.code)
    if (!prog) return { ok: true, data: null } // không tồn tại HOẶC ngoài phạm vi RLS (kể cả QA không marker) ⇒ 404
    const [products, tiers, storeRows, runs] = await Promise.all([
      readAll<ProductDb>((a, b) => supabase.from('cms_program_products').select(PRODUCT_COLS).eq('program_id', id)
        .order('created_at').order('id').range(a, b)),
      readAll<TierDb>((a, b) => supabase.from('cms_program_tiers').select('program_product_id, tier_order, qty_from, qty_to, amount_per_unit::text')
        .eq('program_id', id).order('program_product_id').order('tier_order').range(a, b)),
      readAll<{ store_id: string }>((a, b) => supabase.from('cms_program_stores').select('store_id').eq('program_id', id)
        .order('store_id').range(a, b)),
      !o.manage ? Promise.resolve([] as RunDb[]) : readAll<RunDb>((a, b) => supabase.from('cms_import_runs').select(RUN_COLS).eq('program_id', id)
        .order('created_at', { ascending: false }).order('id').range(a, b)),
    ])
    const storeIds = storeRows.map((s) => s.store_id)
    let storeNames: string[] | null = null
    if (o.manage && storeIds.length > 0 && storeIds.length <= 200) {
      const { data: st, error: stErr } = await supabase.from('stores').select('id, name').in('id', storeIds)
      if (!stErr && st) storeNames = (st as { id: string; name: string }[]).map((s) => s.name).sort((x, y) => x.localeCompare(y, 'vi'))
    }
    return {
      ok: true,
      data: {
        program: toProgram(prog as unknown as ProgramDb),
        products: attachTiers(products, tiers),
        storeCount: storeIds.length,
        storeNames,
        storeIds,
        runs: runs.map(toRun),
      },
    }
  } catch (e) {
    return fail(e)
  }
}

// ── Form: danh sách nhà thuốc OS đang hoạt động (phạm vi 'stores') ───────────
export interface CmsStoreOption { id: string; name: string; code: string }

/** Nhà thuốc ĐÃ CHỌN trong phạm vi chương trình nhưng không còn là OS đang hoạt động (ngừng / FS / không đọc được) — form
 *  sửa hiện để admin CHỦ ĐỘNG bỏ chọn (PM review P1-c P1). `reason` null khi không đọc được dòng nhà thuốc. */
export interface CmsInvalidStore { id: string; name: string | null; code: string | null; reason: 'inactive' | 'not_os' | 'unknown' }

export async function cmsLoadInvalidStores(ids: string[]): Promise<CmsResult<CmsInvalidStore[]>> {
  if (ids.length === 0) return { ok: true, data: [] }
  try {
    const supabase = await createClient()
    const rows: { id: string; name: string; code: string; store_type: string; is_active: boolean }[] = []
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await supabase.from('stores').select('id, name, code, store_type, is_active').in('id', ids.slice(i, i + 200))
      if (error) throw new CmsQueryError(error.code)
      rows.push(...((data ?? []) as typeof rows))
    }
    const byId = new Map(rows.map((r) => [r.id, r]))
    return {
      ok: true,
      data: ids.map((id) => {
        const r = byId.get(id)
        if (!r) return { id, name: null, code: null, reason: 'unknown' as const }
        return { id, name: r.name, code: r.code, reason: r.store_type !== 'os' ? 'not_os' as const : 'inactive' as const }
      }),
    }
  } catch (e) {
    return fail(e)
  }
}

export async function cmsLoadOsStores(): Promise<CmsResult<CmsStoreOption[]>> {
  try {
    const supabase = await createClient()
    const rows = await readAll<CmsStoreOption>((a, b) => supabase.from('stores').select('id, name, code')
      .eq('store_type', 'os').eq('is_active', true).order('name').order('id').range(a, b))
    return { ok: true, data: rows }
  } catch (e) {
    return fail(e)
  }
}
