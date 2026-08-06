import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { isSuperAdminEmail, getSmStoreIds } from '@/lib/authz'
import { isKpiCampaignEnabled, isKpiAffiliateEnabled } from '@/lib/kpi/flags'
import { getAffiliateSyncHealth, supabaseAffiliateHealthDb } from '@/lib/affiliate/health'
import { vnDayRange } from '@/lib/kpi/engine'
import {
  reduceAffiliateAgg, reduceAffiliatePartnerAgg, parseOverviewRange, parseOverviewType,
  salesPointsLabel, overviewDataState, overviewPageScope,
  canShowOwnOsGmv, smOverviewAllowed, type AffiliateAggInput, type PartnerAggInput,
} from '@/lib/affiliate/overview'
import {
  drilldownEnabled, buildOverviewEntities, filterEntitiesByType, overviewEntityKey,
  type OverviewMappingRow,
} from '@/lib/affiliate/orders'
import { AffiliateStoreOrdersRow } from '@/components/affiliate/AffiliateStoreOrdersRow'
import { CampaignsTabs } from '@/components/kpi/CampaignsTabs'
import { PageHeader } from '@/components/ds/PageHeader'
import { DataToolbar } from '@/components/ds/DataToolbar'
import { StatCard } from '@/components/ds/StatCard'
import { DataTableShell } from '@/components/ds/DataTableShell'
import { ErrorState } from '@/components/ds/ErrorState'
import { EmptyState } from '@/components/ds/EmptyState'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { buttonVariants } from '@/components/ui/button'
import { formatDate, formatDateTime } from '@/lib/dateUtils'
import { cn } from '@/lib/utils'
import { Link2, TrendingUp, Package, Store as StoreIcon } from 'lucide-react'

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

const vnd = (n: number) => `${new Intl.NumberFormat('vi-VN').format(Math.round(n))}₫`

function PageShell({ nav, children }: { nav?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="p-4 md:p-6 max-w-5xl space-y-4">
      <PageHeader title="Doanh số Affiliate — Circa Online" icon={Link2} />
      {nav}
      {children}
    </div>
  )
}

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
  const shellNav = scope === 'os-fs'
    ? <CampaignsTabs active="affiliate" affiliateEnabled />
    : (scope === 'os-assigned' || scope === 'os-own')
      ? <Link href="/targets" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground min-h-[44px] md:min-h-0">← Doanh số</Link>
      : null

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
    return (
      <PageShell nav={shellNav}>
        <ErrorState
          message="Không tải được danh sách mapping affiliate — không thể tổng hợp doanh số"
          hint={`${mapErr.message} — kiểm tra migration 090/095/096 và RLS, rồi tải lại.`}
        />
      </PageShell>
    )
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

  const filterForm = (
    <DataToolbar
      filters={
        <form method="GET" className="flex flex-wrap items-end gap-2 text-sm">
          <label className="grid gap-1">
            <span className="text-xs text-muted-foreground">Từ ngày</span>
            <input type="date" name="from" defaultValue={from} className="h-9 rounded-lg border bg-card px-2.5 text-sm" />
          </label>
          <label className="grid gap-1">
            <span className="text-xs text-muted-foreground">Đến ngày</span>
            <input type="date" name="to" defaultValue={to} className="h-9 rounded-lg border bg-card px-2.5 text-sm" />
          </label>
          {/* FS-expansion: filter Loại GIỮA thời gian và Cửa hàng — CHỈ super */}
          {scope === 'os-fs' && (
            <label className="grid gap-1">
              <span className="text-xs text-muted-foreground">Loại</span>
              <select name="type" defaultValue={typeFilter === 'all' ? '' : typeFilter} className="h-9 rounded-lg border bg-card px-2 text-sm">
                <option value="">Tất cả</option>
                <option value="os">OS</option>
                <option value="fs">FS</option>
              </select>
            </label>
          )}
          <label className="grid gap-1">
            <span className="text-xs text-muted-foreground">Cửa hàng</span>
            <select name="store" defaultValue={storeParam ?? ''} className="h-9 rounded-lg border bg-card px-2 text-sm max-w-[220px]">
              <option value="">Tất cả</option>
              {/* Option theo entity của Loại đang chọn (store đã dedupe;
                  partner theo display_name) */}
              {typed.map((e) => (
                <option key={entityKey(e)} value={entityKey(e)}>
                  {e.kind === 'store' ? (e.name ?? e.partnerCodes[0]) : e.display_name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={cn(buttonVariants({ size: 'sm' }), 'min-h-[36px]')}>Áp dụng</button>
        </form>
      }
    />
  )

  if (storeIds.length === 0 && partnerCodes.length === 0) {
    return (
      <PageShell nav={shellNav}>
        {filterForm}
        <EmptyState className="py-12" icon={Link2} title="Không có mapping affiliate nào khớp bộ lọc." />
      </PageShell>
    )
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
  const blocked = dataState !== 'ok'

  // 1 dòng / entity: store (agg theo store) hoặc FS partner (agg theo code).
  const rows = filtered
    .map((e) => ({
      entity: e,
      agg: (e.kind === 'store' ? byStore.get(e.store_id) : byPartner.get(e.partner_code))
        ?? { gmv: 0, orders: 0, lastDate: null },
    }))
    .sort((a, b) => b.agg.gmv - a.agg.gmv)

  return (
    <PageShell nav={shellNav}>
      {filterForm}
      {clamped && (
        <p className="text-xs text-muted-foreground">
          Khoảng ngày vượt giới hạn 366 ngày — đã thu hẹp còn {formatDate(from)} – {formatDate(to)}.
        </p>
      )}

      {/* Fail-closed theo trạng thái nguồn — không bao giờ render 0 giả */}
      {dataState === 'source-not-ready' && (
        <div title={scope === 'os-fs' ? (health.reason ?? undefined) : undefined}>
          <ErrorState
            message="Dữ liệu Affiliate chưa được cập nhật. Số liệu đang tạm ẩn."
            hint={health.lastSuccessAt
              ? `Đồng bộ gần nhất: ${formatDateTime(health.lastSuccessAt)}`
              : 'Chưa có lần đồng bộ thành công nào.'}
          />
        </div>
      )}
      {dataState === 'aggregate-error' && (
        <ErrorState message="Không tổng hợp được doanh số Affiliate" hint={aggErrorMsg ?? undefined} />
      )}

      {/* r1.3: đúng 3 KPI card cho khoảng thời gian đang xem — FS-expansion:
          card 3 đếm ĐIỂM (store + đối tác) khi view có FS */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <StatCard label={`GMV Affiliate (${formatDate(from)} – ${formatDate(to)})`} value={blocked ? '—' : vnd(totals.gmv)} icon={TrendingUp} tone={!blocked && totals.gmv > 0 ? 'success' : 'default'} />
        <StatCard label="Đơn giao thành công" value={blocked ? '—' : totals.orders} icon={Package} />
        <StatCard label={salesPointsLabel(typeFilter)} value={blocked ? '—' : `${totals.points}/${filtered.length}`} icon={StoreIcon} />
      </div>

      <DataTableShell>
        <Table>
          <TableHeader>
            <TableRow>
              {/* Drill-down (28/07): cột chevron — mở danh sách đơn DELIVERED */}
              <TableHead className="w-10 pl-1 pr-0" />
              <TableHead>Cửa hàng</TableHead>
              <TableHead className="text-right">Đơn thành công</TableHead>
              <TableHead className="text-right">GMV Affiliate</TableHead>
              <TableHead className="text-right pr-4">Đơn gần nhất</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ entity: e, agg }) => {
              const has = agg.orders > 0
              const numberCells = (
                <>
                  <TableCell className={cn('text-right tabular-nums', !has && 'text-muted-foreground')}>
                    {blocked ? '—' : agg.orders}
                  </TableCell>
                  <TableCell className={cn('text-right tabular-nums font-medium', !has && 'text-muted-foreground font-normal')}>
                    {blocked ? '—' : has || agg.gmv !== 0 ? vnd(agg.gmv) : '—'}
                  </TableCell>
                  <TableCell className="text-right pr-4 text-muted-foreground">
                    {blocked ? '—' : agg.lastDate ? formatDate(agg.lastDate) : '—'}
                  </TableCell>
                </>
              )
              // Drill-down: client row lazy-load — store qua RPC 099 (mọi scope
              // hợp lệ), FS partner qua RPC 102 (CHỈ super — chevron cũng chỉ
              // render ở scope os-fs); chevron CHỈ khi số parent thật
              // (!blocked) + có đơn; key gồm from/to → đổi filter hủy state.
              if (e.kind === 'store') {
                return (
                  <AffiliateStoreOrdersRow
                    key={`s-${e.store_id}-${from}-${to}`}
                    storeId={e.store_id}
                    from={from}
                    to={to}
                    canDrill={drilldownEnabled({ blocked, orders: agg.orders })}
                    expectedOrders={agg.orders}
                    expectedGmv={agg.gmv}
                    parentCells={
                      <>
                        <TableCell>
                          <span className="font-medium">{e.name ?? '—'}</span>
                          <span className="text-xs text-muted-foreground"> · {e.code ?? '—'}</span>
                          {e.isFs && (
                            <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground align-middle">FS</span>
                          )}
                          {/* r1.3 + r1 P2#4: partner codes = metadata đối soát */}
                          <span className="block font-mono text-[11px] text-muted-foreground">{e.partnerCodes.join(' · ')}</span>
                        </TableCell>
                        {numberCells}
                      </>
                    }
                  />
                )
              }
              // FS partner (không store): KHÔNG QR, KHÔNG liên quan FS Products.
              return (
                <AffiliateStoreOrdersRow
                  key={`p-${e.partner_code}-${from}-${to}`}
                  partnerCode={e.partner_code}
                  from={from}
                  to={to}
                  canDrill={scope === 'os-fs' && drilldownEnabled({ blocked, orders: agg.orders })}
                  expectedOrders={agg.orders}
                  expectedGmv={agg.gmv}
                  parentCells={
                    <>
                      <TableCell>
                        <span className="font-medium">{e.display_name}</span>
                        <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground align-middle">FS</span>
                        <span className="block font-mono text-[11px] text-muted-foreground">{e.partner_code}</span>
                      </TableCell>
                      {numberCells}
                    </>
                  }
                />
              )
            })}
          </TableBody>
        </Table>
      </DataTableShell>

      {/* r1 P2#4: footer 1 câu — chi tiết nguồn nằm ở source contract docs */}
      <p className="text-[11px] text-muted-foreground">Nguồn: Circa Online · Chỉ tính đơn DELIVERED.</p>
    </PageShell>
  )
}
