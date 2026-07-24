import { notFound } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { isSuperAdminEmail } from '@/lib/authz'
import { isKpiCampaignEnabled, isKpiAffiliateEnabled } from '@/lib/kpi/flags'
import { getAffiliateSyncHealth, supabaseAffiliateHealthDb } from '@/lib/affiliate/health'
import { vnDayRange } from '@/lib/kpi/engine'
import { reduceAffiliateAgg, parseOverviewRange, overviewDataState, overviewPageScope, canShowOwnOsGmv, type AffiliateAggInput } from '@/lib/affiliate/overview'
import { getSmStoreIds } from '@/lib/authz'
import Link from 'next/link'
import { CampaignsTabs } from '@/components/kpi/CampaignsTabs'
import { StatCard } from '@/components/ds/StatCard'
import { DataTableShell } from '@/components/ds/DataTableShell'
import { ErrorState } from '@/components/ds/ErrorState'
import { EmptyState } from '@/components/ds/EmptyState'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { buttonVariants } from '@/components/ui/button'
import { formatDate, formatDateTime } from '@/lib/dateUtils'
import { cn } from '@/lib/utils'
import { Link2, TrendingUp, Package, Store as StoreIcon, Activity } from 'lucide-react'

// P3-I r1.2 — Affiliate Overview (KHÔNG phụ thuộc campaign): đọc doanh số
// Affiliate đã sync trong Supabase qua rpc_aggregate_affiliate_gmv (DELIVERED
// + source_active, ngày VN theo completed_time). Role (user chốt 24/07):
// super = OS+FS · admin phòng cấp quyền (096) = toàn bộ OS · SM = store OS
// phân công · QLCH = store mình · Staff/admin thường = notFound. DATA SCOPING
// = RLS: mappings đọc bằng session client (apm_select_super / dept_admin /
// store_qr) → storeIds cho RPC service-role derive TỪ rows RLS cho thấy.
// KHÔNG nút đồng bộ — mọi sync qua cron/runbook. KHÔNG PII, không target/%/
// tier/commission. External = backlog.
// r1 (audit): mapping lỗi → FAIL-CLOSED (chỉ ErrorState, không số 0 giả);
// range ngày lịch thật + clamp ≤366 ngày; health theo ĐÚNG danh sách store
// đang hiển thị (OS + FS). Mapping 1 store : 1 partner đã preflight (0 rows
// trùng — user 24/07).

const vnd = (n: number) => `${new Intl.NumberFormat('vi-VN').format(Math.round(n))}₫`

interface MappingRow {
  partner_code: string
  partner_type: string
  store_id: string
  stores: { name: string; code: string | null } | null
}

// P3-I.2: nav theo role — super: tab Chiến dịch↔Affiliate; SM/QLCH: back-link
// về Doanh số (họ đến từ card GMV trên /targets); admin phòng OPS: không nav
// phụ (vào từ sidebar).
function PageShell({ nav, children }: { nav?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="p-4 md:p-6 max-w-5xl space-y-4">
      <div className="flex items-center gap-2">
        <Link2 className="h-5 w-5 text-primary" />
        <h1 className="text-xl font-semibold">Doanh số Affiliate — Circa Online</h1>
      </div>
      {nav}
      {children}
    </div>
  )
}

export default async function AffiliateOverviewPage({ searchParams }: {
  searchParams: Promise<{ from?: string; to?: string; store?: string; partner?: string }>
}) {
  const { user, profile } = await getSessionProfile()
  if (!user) notFound()
  if (!(isKpiCampaignEnabled() && isKpiAffiliateEnabled())) notFound()

  // P3-I.2 (user chốt 24/07): super (OS+FS) · admin phòng được cấp quyền
  // affiliate (toàn bộ OS — grant 096) · SM (store phân công) · QLCH (store
  // mình). Staff + admin thường → notFound. Membership phòng đọc qua admin
  // client (RLS bảng affiliate_department_access là super-only) — dữ liệu
  // server tin cậy, mirror semantics is_affiliate_dept_admin().
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
  // r1 (audit P2#3): ngày lịch THẬT (loại 2026-02-31/2026-99-99), hoán vị khi
  // ngược, clamp ≤366 ngày — URL sai không đổ 500, không phá range.
  const { from, to, clamped } = parseOverviewRange(params.from, params.to, vnTodayISO)

  const supabase = await createClient()

  // r1.2a (audit P2#2): biên scope kiểm TRƯỚC khi dựng trang —
  // · QLCH: store PHẢI là OS active — FS store_manager gõ thẳng URL → notFound
  //   (đúng isolation FS, không dựa vào empty-state RLS);
  // · SM: không có store OS được phân công → notFound (behavior thống nhất).
  if (scope === 'os-own') {
    const { data: ownStore } = await supabase
      .from('stores').select('store_type, is_active')
      .eq('id', profile?.store_id ?? '').maybeSingle()
    if (!canShowOwnOsGmv(ownStore as { store_type: string; is_active: boolean } | null)) notFound()
  }
  if (scope === 'os-assigned') {
    const smIds = await getSmStoreIds(supabase, user.id)
    if (smIds.length === 0) notFound()
  }

  // Mappings qua SESSION client — RLS scope theo role: super = os+fs (filter
  // dưới), admin phòng OPS = os active (apm_select_dept_admin, 096), SM =
  // store phân công, QLCH = store mình (apm_select_store_qr, 095). External
  // (store NULL) ngoài phạm vi v1. 1 FK duy nhất mappings→stores → bare embed.
  const { data: mapRows, error: mapErr } = await supabase
    .from('affiliate_partner_mappings')
    .select('partner_code, partner_type, store_id, stores(name, code)')
    .in('partner_type', ['os', 'fs'])
    .eq('is_active', true)
    .not('store_id', 'is', null)
    .order('partner_code')

  // r1 (audit P1#2): mapping lỗi → FAIL-CLOSED — chỉ ErrorState. Không
  // aggregate, không summary 0 giả, không empty state (0 trên màn hình tiền
  // phải là 0 THẬT).
  if (mapErr) {
    console.error('[affiliate-overview] mapping query failed:', mapErr.message)
    return (
      <PageShell nav={shellNav}>
        <ErrorState
          message="Không tải được danh sách mapping affiliate — không thể tổng hợp doanh số"
          hint={`${mapErr.message} — kiểm tra migration 090/095 và RLS, rồi tải lại.`}
        />
      </PageShell>
    )
  }

  const mappings = ((mapRows ?? []) as unknown as MappingRow[])
  const filtered = mappings.filter((m) =>
    (!params.store || m.store_id === params.store)
    && (!params.partner || m.partner_code === params.partner))
  const storeIds = [...new Set(filtered.map((m) => m.store_id))]

  const filterForm = (
    <form method="GET" className="flex flex-wrap items-end gap-2 text-sm">
      <label className="grid gap-1">
        <span className="text-xs text-muted-foreground">Từ ngày</span>
        <input type="date" name="from" defaultValue={from} className="h-9 rounded-lg border bg-card px-2.5 text-sm" />
      </label>
      <label className="grid gap-1">
        <span className="text-xs text-muted-foreground">Đến ngày</span>
        <input type="date" name="to" defaultValue={to} className="h-9 rounded-lg border bg-card px-2.5 text-sm" />
      </label>
      <label className="grid gap-1">
        <span className="text-xs text-muted-foreground">Cửa hàng</span>
        <select name="store" defaultValue={params.store ?? ''} className="h-9 rounded-lg border bg-card px-2 text-sm max-w-[220px]">
          <option value="">Tất cả</option>
          {mappings.map((m) => (
            <option key={m.store_id} value={m.store_id}>{m.stores?.name ?? m.partner_code}</option>
          ))}
        </select>
      </label>
      <label className="grid gap-1">
        <span className="text-xs text-muted-foreground">Partner code</span>
        <select name="partner" defaultValue={params.partner ?? ''} className="h-9 rounded-lg border bg-card px-2 text-sm max-w-[220px]">
          <option value="">Tất cả</option>
          {mappings.map((m) => (
            <option key={m.partner_code} value={m.partner_code}>{m.partner_code}</option>
          ))}
        </select>
      </label>
      <button type="submit" className={cn(buttonVariants({ size: 'sm' }), 'min-h-[36px]')}>Áp dụng</button>
    </form>
  )

  if (storeIds.length === 0) {
    return (
      <PageShell nav={shellNav}>
        {filterForm}
        <EmptyState className="py-12" icon={Link2} title="Không có mapping affiliate nào khớp bộ lọc." />
      </PageShell>
    )
  }

  // r1.1 (audit): HEALTH TRƯỚC — số tài chính CHỈ hiển thị khi nguồn READY.
  // Health theo ĐÚNG danh sách store đang hiển thị (OS + FS, dedupe — r1 P2#4).
  // !ready (run running/failed · stale >180' · rejected>0 · unmatched/unknown ·
  // note · canary completed_time · lỗi lookup) → KHÔNG gọi aggregate, không
  // render 0 giả — summary/bảng dùng '—' + lý do + lần sync thành công gần nhất.
  const health = await getAffiliateSyncHealth(supabaseAffiliateHealthDb(supabaseAdmin), storeIds)
  let aggErrorMsg: string | null = null
  let byStore = new Map<string, { gmv: number; orders: number; lastDate: string | null }>()
  let totals = { gmv: 0, orders: 0, storesWithSales: 0 }
  if (health.ready) {
    // Aggregate qua RPC (DB-side). FAIL-CLOSED RAISE (đơn DELIVERED thiếu
    // completed_time lọt giữa health-check và aggregate) vẫn chặn số thiếu.
    const range = vnDayRange(from, to)
    const { data: aggData, error: aggErr } = await supabaseAdmin
      .rpc('rpc_aggregate_affiliate_gmv', { p_store_ids: storeIds, p_from: range.from, p_to: range.to })
    if (aggErr) {
      console.error('[affiliate-overview] aggregate failed:', aggErr.message)
      aggErrorMsg = aggErr.message
    } else {
      const r = reduceAffiliateAgg((aggData ?? []) as AffiliateAggInput[])
      byStore = r.byStore
      totals = r.totals
    }
  }
  const dataState = overviewDataState(health.ready, aggErrorMsg !== null)
  const blocked = dataState !== 'ok'

  const rows = filtered
    .map((m) => ({ ...m, agg: byStore.get(m.store_id) ?? { gmv: 0, orders: 0, lastDate: null } }))
    .sort((a, b) => b.agg.gmv - a.agg.gmv)

  return (
    <PageShell nav={shellNav}>
      {filterForm}
      {clamped && (
        <p className="text-xs text-muted-foreground">
          Khoảng ngày vượt giới hạn 366 ngày — đã thu hẹp còn {formatDate(from)} – {formatDate(to)}.
        </p>
      )}

      {/* r1.1: fail-closed theo trạng thái nguồn — không bao giờ render 0 giả */}
      {dataState === 'source-not-ready' && (
        <ErrorState
          message="Nguồn Affiliate chưa sẵn sàng — số liệu tạm ẩn để tránh hiển thị sai"
          hint={`${health.reason ?? 'Không rõ lý do'}${health.lastSuccessAt ? ` · Sync thành công gần nhất: ${formatDateTime(health.lastSuccessAt)}` : ' · Chưa có lần sync thành công nào'}`}
        />
      )}
      {dataState === 'aggregate-error' && (
        <ErrorState message="Không tổng hợp được doanh số Affiliate" hint={aggErrorMsg ?? undefined} />
      )}

      {/* Summary — khoảng thời gian đang xem */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <StatCard label={`GMV Affiliate (${formatDate(from)} – ${formatDate(to)})`} value={blocked ? '—' : vnd(totals.gmv)} icon={TrendingUp} tone={!blocked && totals.gmv > 0 ? 'success' : 'default'} />
        <StatCard label="Đơn giao thành công" value={blocked ? '—' : totals.orders} icon={Package} />
        <StatCard label="Store có doanh số" value={blocked ? '—' : `${totals.storesWithSales}/${storeIds.length}`} icon={StoreIcon} />
        <StatCard
          label="Nguồn dữ liệu"
          value={health.ready ? 'Sẵn sàng' : 'Cảnh báo'}
          icon={Activity}
          tone={health.ready ? 'success' : 'warning'}
          hint={health.ready
            ? (health.lastSuccessAt ? `Đồng bộ ${formatDateTime(health.lastSuccessAt)}` : undefined)
            : (health.reason ?? undefined)}
        />
      </div>

      <DataTableShell>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Cửa hàng</TableHead>
              <TableHead>Partner code</TableHead>
              <TableHead className="text-right">Đơn giao thành công</TableHead>
              <TableHead className="text-right">GMV Affiliate</TableHead>
              <TableHead className="text-right pr-4">Đơn gần nhất</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const has = r.agg.orders > 0
              return (
                <TableRow key={r.partner_code}>
                  <TableCell className="pl-4">
                    <span className="font-medium">{r.stores?.name ?? '—'}</span>
                    <span className="text-xs text-muted-foreground"> · {r.stores?.code ?? '—'}</span>
                    {r.partner_type === 'fs' && (
                      <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground align-middle">FS</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.partner_code}</TableCell>
                  <TableCell className={cn('text-right tabular-nums', !has && 'text-muted-foreground')}>
                    {blocked ? '—' : r.agg.orders}
                  </TableCell>
                  <TableCell className={cn('text-right tabular-nums font-medium', !has && 'text-muted-foreground font-normal')}>
                    {blocked ? '—' : has || r.agg.gmv !== 0 ? vnd(r.agg.gmv) : '—'}
                  </TableCell>
                  <TableCell className="text-right pr-4 text-muted-foreground">
                    {blocked ? '—' : r.agg.lastDate ? formatDate(r.agg.lastDate) : '—'}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </DataTableShell>

      <p className="text-[11px] text-muted-foreground">
        Nguồn: Circa Online (đồng bộ định kỳ vào hệ thống) · chỉ tính đơn giao thành công (DELIVERED),
        ghi nhận theo mã đối tác · ngày theo giờ Việt Nam của thời điểm giao thành công. Không bao gồm
        đối tác ngoài hệ thống.
      </p>
    </PageShell>
  )
}
