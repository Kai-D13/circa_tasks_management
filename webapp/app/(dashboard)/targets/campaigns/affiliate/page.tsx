import { notFound } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { isSuperAdminEmail, getSmStoreIds } from '@/lib/authz'
import { isKpiCampaignEnabled, isKpiAffiliateEnabled } from '@/lib/kpi/flags'
import { getAffiliateSyncHealth, supabaseAffiliateHealthDb } from '@/lib/affiliate/health'
import { vnDayRange } from '@/lib/kpi/engine'
import {
  reduceAffiliateAgg, reduceAffiliatePartnerAgg, parseOverviewRange, parseOverviewType,
  overviewDataState, overviewPageScope,
  canShowOwnOsGmv, smOverviewAllowed, type AffiliateAggInput, type PartnerAggInput,
} from '@/lib/affiliate/overview'
import {
  buildOverviewEntities, filterEntitiesByType, overviewEntityKey,
  type OverviewMappingRow,
} from '@/lib/affiliate/orders'
import { AffiliateOverviewView } from '@/components/affiliate/AffiliateOverviewView'

// P3-I r1.3 — Affiliate Overview (KHÔNG phụ thuộc campaign): đọc doanh số
// Affiliate đã sync trong Supabase qua rpc_aggregate_affiliate_gmv (DELIVERED
// + source_active, ngày VN theo completed_time). Role (user chốt 24/07):
// super = OS+FS · admin phòng cấp quyền (096) = toàn bộ OS · SM = store OS
// active phân công · QLCH = store OS mình · Staff/admin thường = notFound.
// DATA SCOPING = RLS (mappings session client) → storeIds cho RPC derive TỪ
// rows RLS cho thấy. HEALTH FAIL-CLOSED (r1.1): health TRƯỚC, chỉ aggregate
// khi READY; !ready → '—' + thông báo NGẮN (copy audit r1.3 — reason kỹ thuật
// vào log + tooltip super, KHÔNG hiện "stale N phút" trên UI chính). KHÔNG nút
// đồng bộ, KHÔNG Mongo, KHÔNG PII. r1.3 UI: ds PageHeader/DataToolbar/
// StatCard/DataTableShell; BỎ filter partner (partner_code = metadata nhỏ dưới
// tên store phục vụ đối soát); 3 KPI card.

// UI v2 Phase 2 · K-4: phần trình bày ở components/affiliate/AffiliateOverviewView (dùng chung fixture catalog);
// page giữ cổng quyền, phạm vi, truy vấn mapping, health fail-closed và 2 RPC aggregate — không đổi.

export default async function AffiliateOverviewPage({ searchParams }: {
  searchParams: Promise<{ from?: string; to?: string; type?: string; store?: string }>
}) {
  const { user, profile } = await getSessionProfile()
  if (!user) notFound()
  if (!(isKpiCampaignEnabled() && isKpiAffiliateEnabled())) notFound()

  // Membership phòng đọc qua admin client (RLS bảng access super-only) —
  // dữ liệu server tin cậy, mirror semantics is_affiliate_dept_admin().
  const isSuper = profile?.role === 'admin' && isSuperAdminEmail(user.email)
  const isAffiliateDeptAdmin = !isSuper && profile?.role === 'admin' && profile?.department_id
    ? !!(await supabaseAdmin
        .from('affiliate_department_access')
        .select('department_id')
        .eq('department_id', profile.department_id)
        .maybeSingle()).data
    : false
  const scope = overviewPageScope({
    flagEnabled: isKpiAffiliateEnabled(),
    isSuper,
    isAffiliateDeptAdmin,
    role: profile?.role,
  })
  if (scope === 'denied') notFound()
  const params = await searchParams
  const vnTodayISO = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)
  // r1 P2#3: ngày lịch THẬT, hoán vị khi ngược, clamp ≤366 ngày — URL sai
  // không đổ 500, không phá range.
  const { from, to, clamped } = parseOverviewRange(params.from, params.to, vnTodayISO)

  const supabase = await createClient()

  // r1.2a/r1.2b: biên scope kiểm TRƯỚC khi dựng trang — QLCH phải là store OS
  // active (FS QLCH gõ URL → notFound); SM phải có ≥1 store OS active trong
  // assignment (toàn FS/inactive/query lỗi → notFound fail-closed).
  if (scope === 'os-own') {
    const { data: ownStore } = await supabase
      .from('stores').select('store_type, is_active')
      .eq('id', profile?.store_id ?? '').maybeSingle()
    if (!canShowOwnOsGmv(ownStore as { store_type: string; is_active: boolean } | null)) notFound()
  }
  // Slice C: nhánh SM cần DANH SÁCH ĐẦY ĐỦ store OS active được phân công —
  // vừa là boundary (r1.2b), vừa là tập id DUY NHẤT cho query mapping qua
  // service role phía dưới (sau 097 SM không còn nhánh RLS đọc mapping).
  let smActiveOsIds: string[] = []
  if (scope === 'os-assigned') {
    const smIds = await getSmStoreIds(supabase, user.id)
    let activeOsCount: number | null = null
    if (smIds.length > 0) {
      const { data: osStores, error: osErr } = await supabase
        .from('stores').select('id')
        .in('id', smIds).eq('store_type', 'os').eq('is_active', true)
      activeOsCount = osErr ? null : (osStores?.length ?? 0)
      smActiveOsIds = ((osStores ?? []) as { id: string }[]).map((s) => s.id)
    }
    if (!smOverviewAllowed(smIds.length, activeOsCount)) notFound()
  }

  // Mappings: super/OPS/QLCH qua SESSION client (RLS scope theo role —
  // apm_select_super / dept_admin / store_qr). Slice C: nhánh SM đọc bằng
  // SERVICE ROLE (sau 097 SM hết nhánh RLS) — scope CỨNG theo smActiveOsIds đã
  // validate (không mở rộng ngoài assignment; query param không tham gia) và
  // CHỈ select cột non-QR (partner_code/partner_type/store_id/stores name+code
  // — TUYỆT ĐỐI không qr_image_url/qr_destination_url). External ngoài phạm vi.
  // FS-expansion (06/08): SUPER đọc CẢ mapping fs store_id NULL (FS partner
  // rows); OPS/QLCH giữ nguyên guard not-null (RLS của họ vốn chỉ lộ os).
  const mapRes = scope === 'os-assigned'
    ? await supabaseAdmin
        .from('affiliate_partner_mappings')
        .select('partner_code, partner_type, store_id, display_name, stores(name, code)')
        .in('store_id', smActiveOsIds)
        .eq('partner_type', 'os')
        .eq('is_active', true)
        .order('partner_code')
    : scope === 'os-fs'
      ? await supabase
          .from('affiliate_partner_mappings')
          .select('partner_code, partner_type, store_id, display_name, stores(name, code)')
          .in('partner_type', ['os', 'fs'])
          .eq('is_active', true)
          .order('partner_code')
      : await supabase
          .from('affiliate_partner_mappings')
          .select('partner_code, partner_type, store_id, display_name, stores(name, code)')
          .in('partner_type', ['os', 'fs'])
          .eq('is_active', true)
          .not('store_id', 'is', null)
          .order('partner_code')
  const mapRows = mapRes.data
  const mapErr = mapRes.error

  // r1 P1#2: mapping lỗi → FAIL-CLOSED — chỉ ErrorState, không số 0 giả.
  if (mapErr) {
    console.error('[affiliate-overview] mapping query failed:', mapErr.message)
    return <AffiliateOverviewView scope={scope} filter={null} body={{ kind: 'mapping-error', message: mapErr.message }} />
  }

  const mappings = ((mapRows ?? []) as unknown as OverviewMappingRow[])
  // FS-expansion (06/08): ROW MODEL 2 entity — OS/FS-có-store group theo
  // STORE (r1 P2#4 giữ nguyên: 1 store nhiều partner code = 1 dòng); FS
  // KHÔNG store (mapping fs + store_id NULL) = 1 dòng / partner_code.
  const entities = buildOverviewEntities(mappings)
  // Filter Loại: chỉ super chọn được; scope khác ÉP 'os' (query-string không
  // vượt RBAC — parseOverviewType có test khóa).
  const typeFilter = parseOverviewType(params.type, scope)
  const typed = filterEntitiesByType(entities, typeFilter)
  // Filter Cửa hàng/đối tác: value = key PHÂN NAMESPACE 'store:<uuid>' |
  // 'partner:<code>' (r1 audit P2#7 — partner_code tự do, raw value có thể
  // đụng uuid); đổi Loại làm param cũ không còn trong options → BỎ QUA (reset
  // server-side, không giữ key cũ — audit UI).
  const entityKey = overviewEntityKey
  const storeParam = params.store && typed.some((e) => entityKey(e) === params.store) ? params.store : undefined
  const filtered = typed.filter((e) => !storeParam || entityKey(e) === storeParam)
  const storeIds = filtered.flatMap((e) => (e.kind === 'store' ? [e.store_id] : []))
  const partnerCodes = filtered.flatMap((e) => (e.kind === 'partner' ? [e.partner_code] : []))

  const filter = { from, to, typeFilter, storeParam, options: typed }

  if (storeIds.length === 0 && partnerCodes.length === 0) {
    return <AffiliateOverviewView scope={scope} filter={filter} body={{ kind: 'empty' }} />
  }

  // r1.1 HEALTH FAIL-CLOSED: health TRƯỚC theo ĐÚNG scope hiển thị (store +
  // partner — FS-expansion: partnerCodes cho view FS-only, canary partner nằm
  // trong RPC aggregate partner); CHỈ ready mới aggregate; !ready → '—'.
  const health = await getAffiliateSyncHealth(
    supabaseAffiliateHealthDb(supabaseAdmin), storeIds, Date.now(), partnerCodes)
  let aggErrorMsg: string | null = null
  let byStore = new Map<string, { gmv: number; orders: number; lastDate: string | null }>()
  let byPartner = new Map<string, { gmv: number; orders: number; lastDate: string | null }>()
  let totals = { gmv: 0, orders: 0, points: 0 }
  if (health.ready) {
    const range = vnDayRange(from, to)
    if (storeIds.length > 0) {
      const { data: aggData, error: aggErr } = await supabaseAdmin
        .rpc('rpc_aggregate_affiliate_gmv', { p_store_ids: storeIds, p_from: range.from, p_to: range.to })
      if (aggErr) {
        console.error('[affiliate-overview] aggregate (store) failed:', aggErr.message)
        aggErrorMsg = aggErr.message
      } else {
        const r = reduceAffiliateAgg((aggData ?? []) as AffiliateAggInput[])
        byStore = r.byStore
        totals = { gmv: r.totals.gmv, orders: r.totals.orders, points: r.totals.storesWithSales }
      }
    }
    // FS partner (store_id NULL): aggregate theo partner_code — RPC 102, cùng
    // fail-closed completed_time như 092.
    if (partnerCodes.length > 0 && aggErrorMsg === null) {
      const { data: pData, error: pErr } = await supabaseAdmin
        .rpc('rpc_aggregate_affiliate_partner_gmv', { p_codes: partnerCodes, p_from: range.from, p_to: range.to })
      if (pErr) {
        console.error('[affiliate-overview] aggregate (partner) failed:', pErr.message)
        aggErrorMsg = pErr.message
      } else {
        const r = reduceAffiliatePartnerAgg((pData ?? []) as PartnerAggInput[])
        byPartner = r.byPartner
        totals = {
          gmv: totals.gmv + r.totals.gmv,
          orders: totals.orders + r.totals.orders,
          points: totals.points + r.totals.pointsWithSales,
        }
      }
    }
  } else {
    // r1.3: reason kỹ thuật vào LOG (+ tooltip super dưới) — UI chính chỉ
    // thông báo ngắn, không "stale N phút".
    console.warn('[affiliate-overview] source not ready:', health.reason)
  }
  const dataState = overviewDataState(health.ready, aggErrorMsg !== null)

  // 1 dòng / entity: store (agg theo store) hoặc FS partner (agg theo code).
  const rows = filtered
    .map((e) => ({
      entity: e,
      agg: (e.kind === 'store' ? byStore.get(e.store_id) : byPartner.get(e.partner_code))
        ?? { gmv: 0, orders: 0, lastDate: null },
    }))
    .sort((a, b) => b.agg.gmv - a.agg.gmv)

  return (
    <AffiliateOverviewView
      scope={scope}
      filter={filter}
      body={{
        kind: 'data', clamped, dataState, aggErrorMsg, totals, rows, filteredCount: filtered.length,
        healthReason: health.reason ?? null, healthLastSuccessAt: health.lastSuccessAt ?? null,
      }}
    />
  )
}
