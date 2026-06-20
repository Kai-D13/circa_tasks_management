import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { isSuperAdminEmail } from '@/lib/authz'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { TargetUploadForm } from '@/components/targets/TargetUploadForm'
import { ReferralCard, type ReferralItem } from '@/components/referral/ReferralCard'
import { formatDateTime } from '@/lib/dateUtils'
import { cn } from '@/lib/utils'
import { Flame, Target, TrendingUp } from 'lucide-react'

// Weekly sales targets from the BI feed (migration 051).
//   staff       → their store's card (the stakeholder feature)
//   super admin → all-stores table + manual upload fallback
//   everyone else (PIC / store_manager / SM) → no access per spec

const vnd = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : `${new Intl.NumberFormat('vi-VN').format(Math.round(n))}₫`

function weekLabel(weekStart: string): string {
  const start = new Date(`${weekStart}T00:00:00`)
  const end   = new Date(start.getTime() + 6 * 86400_000)
  const fmt = (d: Date) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
  return `Tuần ${fmt(start)} – ${fmt(end)}`
}

function StatusBadge({ status }: { status: string | null }) {
  const achieved = status?.toLowerCase() === 'achieved'
  return (
    <span className={cn(
      'text-xs px-2 py-0.5 rounded font-medium',
      achieved ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700',
    )}>
      {achieved ? 'Đã đạt mục tiêu' : 'Chưa đạt mục tiêu'}
    </span>
  )
}

interface TargetRecord {
  week_start:        string
  target:            number
  min_weekly_target: number | null
  actual:            number
  run_rate:          number | null
  status:            string | null
  remaining_target:  number | null
  refreshed_at:      string
  stores?:           { name: string } | null
}

// SVG completion ring for the "Hôm nay cần đạt" card — server-rendered, no JS.
function ProgressRing({ pct }: { pct: number }) {
  const r = 32
  const c = 2 * Math.PI * r
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div className="relative h-[84px] w-[84px] shrink-0">
      <svg width="84" height="84" viewBox="0 0 84 84" className="-rotate-90">
        <circle cx="42" cy="42" r={r} fill="none" strokeWidth="8" className="stroke-muted" />
        <circle
          cx="42" cy="42" r={r} fill="none" strokeWidth="8" strokeLinecap="round"
          className="stroke-primary"
          strokeDasharray={`${(clamped / 100) * c} ${c}`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-base font-bold leading-none">{Math.round(clamped)}%</span>
        <span className="text-[9px] text-muted-foreground mt-0.5">hoàn thành</span>
      </div>
    </div>
  )
}

export default async function TargetsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('users').select('role, store_id, phone_number, stores!users_store_id_fkey(name)').eq('id', user.id).single()

  const isSuper = profile?.role === 'admin' && isSuperAdminEmail(user.email)
  const isStaff = profile?.role === 'staff'
  if (!isStaff && !isSuper) redirect('/tasks')

  // ── Staff: own store's weekly card (from store_weekly_targets, fed by the
  //    BigQuery cron — Coolify Scheduled Task "Pull weekly targets") ──────────
  if (isStaff) {
    if (!profile?.store_id) {
      return (
        <div className="p-4">
          <p className="text-sm text-muted-foreground">Tài khoản chưa được gán cửa hàng. Vui lòng liên hệ Admin.</p>
        </div>
      )
    }
    const { data: rows, error: rowsError } = await supabase
      .from('store_weekly_targets')
      .select('week_start, target, min_weekly_target, actual, run_rate, status, remaining_target, refreshed_at')
      .eq('store_id', profile.store_id)
      .order('week_start', { ascending: false })
      .limit(5)
    if (rowsError) {
      // Operational failure ≠ "no data yet" — surface it so QA never reads a
      // broken page as an empty one. Details go to the server log only.
      console.error('[targets] staff query failed:', rowsError.message)
      return (
        <div className="p-4">
          <p className="text-sm text-destructive">
            Không tải được dữ liệu doanh số. Vui lòng thử lại sau hoặc báo Admin.
          </p>
        </div>
      )
    }

    const current = (rows ?? [])[0] as TargetRecord | undefined
    const history = ((rows ?? []) as TargetRecord[]).slice(1)
    const storeName = (profile.stores as unknown as { name: string } | null)?.name ?? 'Cửa hàng của bạn'

    // Referral campaign card (staff_referrals, uploaded by super admin; RLS
    // filters to this staff's normalized phone). Show only if the staff is in the
    // latest upload (≥1 row). Missing phone → prompt to add it.
    const staffPhone = (profile as { phone_number?: string | null }).phone_number ?? null
    let referral: { total: number; success: number; sameDay: number; noOrder: number; items: ReferralItem[] } | null = null
    let referralError = false
    if (staffPhone) {
      const { data: refRows, error: refErr } = await supabase
        .from('staff_referrals')
        .select('referred_phone, status, referral_date, same_day_order')
        .order('referral_date', { ascending: false, nullsFirst: false })
      if (refErr) {
        // Surface (log) instead of silently showing "no data" — e.g. migration 059
        // not applied yet, or an RLS error.
        console.error('[referral] staff query failed:', refErr.message)
        referralError = true
      } else if (refRows && refRows.length > 0) {
        const items = (refRows as ReferralItem[]).filter((r) => r.referred_phone)
        const success = items.filter((r) => (r.status ?? '').toUpperCase() === 'SUCCESS').length
        const sameDay = items.filter((r) => r.same_day_order).length
        referral = { total: items.length, success, sameDay, noOrder: items.length - sameDay, items }
      }
    }
    // Stakeholder pivot (2026-06-12): the staff view's "Mục tiêu tuần" is the
    // 90% MIN target, and ALL percentages use it as the denominator so the
    // numbers add up on screen (đã đạt + còn thiếu = mục tiêu; 48.0M/116M =
    // 41.4% ≈ the mock's 42%). BI's run_rate (vs the full target) stays on
    // the super-admin table only.
    const weekGoal = current?.min_weekly_target ?? current?.target ?? 0
    const pct = current && weekGoal > 0 ? (current.actual / weekGoal) * 100 : 0

    // ── "Hôm nay cần đạt" math (stakeholder spec 2026-06-12) ─────────────────
    // remaining ÷ days left in the week (today included, VN timezone), rounded
    // UP to the next 100k for display. remaining_target is vs the 90% MIN
    // target (BI semantics). Week over / achieved → celebratory states.
    const remaining = current?.remaining_target
      ?? (current?.min_weekly_target !== null && current?.min_weekly_target !== undefined
        ? Math.max(current.min_weekly_target - (current?.actual ?? 0), 0)
        : null)
    const vnTodayISO = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)
    const weekEndMs  = current ? Date.parse(current.week_start) + 6 * 86400_000 : 0
    const weekEndISO = current ? new Date(weekEndMs).toISOString().slice(0, 10) : ''
    const rawDaysLeft = current
      ? Math.floor((weekEndMs - Date.parse(vnTodayISO)) / 86400_000) + 1
      : 0
    const daysLeft  = Math.max(0, Math.min(7, rawDaysLeft))
    const achieved  = (remaining ?? 1) <= 0
    const weekOver  = daysLeft === 0
    const needToday = !achieved && remaining !== null
      ? Math.ceil(remaining / Math.max(daysLeft, 1) / 100_000) * 100_000
      : 0
    // Pace check: % of week elapsed vs % of target achieved.
    const expectedPct = ((7 - daysLeft) / 7) * 100
    const paceMessage = achieved
      ? '🎉 Cửa hàng đã đạt mục tiêu tuần — xuất sắc!'
      : weekOver
        ? 'Tuần đã kết thúc — chờ dữ liệu tuần mới.'
        : pct >= expectedPct
          ? 'Giữ nhịp này, bạn sẽ đạt mục tiêu tuần!'
          : 'Cần tăng tốc để kịp mục tiêu tuần!'
    const weekEndLabel = weekEndISO
      ? `${weekEndISO.slice(8, 10)}/${weekEndISO.slice(5, 7)}`
      : ''

    return (
      <div className="p-4 space-y-4 max-w-xl mx-auto">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-primary" />
            <h1 className="text-xl font-semibold">Doanh số tuần</h1>
          </div>
          <span className="text-sm text-muted-foreground">{storeName}</span>
        </div>

        {!current ? (
          <Card>
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              <TrendingUp className="h-8 w-8 mx-auto mb-3 opacity-30" />
              Chưa có dữ liệu doanh số cho cửa hàng của bạn.
            </CardContent>
          </Card>
        ) : (
          <>
            {/* ── Card 1: HÔM NAY CẦN ĐẠT ───────────────────────────────── */}
            <Card>
              <CardContent className="p-4 space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 font-semibold text-sm uppercase tracking-wide">
                      <Flame className="h-4 w-4 text-primary" />
                      Hôm nay cần đạt
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">Để kịp KPI tuần</p>
                    <p className="text-3xl font-bold text-primary mt-2 leading-tight">
                      {achieved ? 'Đã đạt 🎉' : weekOver ? '—' : vnd(needToday)}
                    </p>
                  </div>
                  <ProgressRing pct={pct} />
                </div>

                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-lg border p-2">
                    <p className="text-[10px] text-muted-foreground uppercase">Đã đạt hôm nay</p>
                    <p className="text-sm font-semibold mt-0.5 text-muted-foreground">—</p>
                  </div>
                  <div className="rounded-lg border p-2">
                    <p className="text-[10px] text-muted-foreground uppercase">Còn thiếu hôm nay</p>
                    <p className="text-sm font-semibold mt-0.5 text-muted-foreground">—</p>
                  </div>
                  <div className="rounded-lg border p-2">
                    <p className="text-[10px] text-muted-foreground uppercase">Thời gian còn lại</p>
                    <p className="text-sm font-semibold mt-0.5">{daysLeft} ngày</p>
                    <p className="text-[10px] text-muted-foreground">đến {weekEndLabel}</p>
                  </div>
                </div>

                <p className={cn(
                  'rounded-lg px-3 py-2 text-sm font-medium',
                  achieved || pct >= expectedPct
                    ? 'bg-green-100 text-green-700'
                    : 'bg-amber-100 text-amber-700',
                )}>
                  {paceMessage}
                </p>
                <p className="text-xs text-muted-foreground">* Không bao gồm đơn online</p>
              </CardContent>
            </Card>

            {/* ── Card 2: KPI TUẦN (gradient) ───────────────────────────── */}
            <div className="rounded-xl bg-gradient-to-br from-primary to-orange-600 text-white p-4 space-y-4 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="flex items-center gap-1.5 font-semibold text-sm uppercase tracking-wide">
                    <Target className="h-4 w-4" />
                    KPI tuần
                  </p>
                  <p className="text-xs text-white/80 mt-0.5">{weekLabel(current.week_start)}</p>
                </div>
                <StatusBadge status={current.status} />
              </div>

              <div>
                <p className="text-xs uppercase text-white/80">Còn thiếu</p>
                <p className="text-3xl font-bold leading-tight">
                  {achieved ? '0₫' : vnd(remaining)}
                </p>
                <p className="text-xs text-white/80 mt-0.5">
                  để đạt mục tiêu tuần và nhận thưởng
                </p>
              </div>

              <div className="space-y-1.5">
                <p className="text-right text-xs font-semibold">{pct.toFixed(1)}%</p>
                <div className="h-2.5 w-full rounded-full bg-white/25 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-white"
                    style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
                  />
                </div>
                <div className="flex items-end justify-between text-xs">
                  <div>
                    <p className="font-semibold text-sm">{vnd(current.actual)}</p>
                    <p className="text-white/80">Đã đạt</p>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold text-sm">{vnd(weekGoal)}</p>
                    <p className="text-white/80">Mục tiêu tuần</p>
                  </div>
                </div>
              </div>
            </div>

            <p className="text-[11px] text-muted-foreground">
              Cập nhật lúc {formatDateTime(current.refreshed_at)} · Nguồn: báo cáo BI
            </p>
          </>
        )}

        {history.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Các tuần trước</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {history.map((h) => (
                <div key={h.week_start} className="flex items-center justify-between px-4 py-2.5 border-t text-sm">
                  <span className="text-muted-foreground">{weekLabel(h.week_start)}</span>
                  <span className="font-medium">{vnd(h.actual)}</span>
                  <StatusBadge status={h.status} />
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Referral campaign ("Giới thiệu bạn bè") — under Doanh số */}
        {referral && <ReferralCard {...referral} />}
        {referralError && (
          <Card>
            <CardContent className="py-4 text-sm text-destructive">
              Không tải được dữ liệu chương trình giới thiệu. Vui lòng thử lại sau hoặc báo Admin.
            </CardContent>
          </Card>
        )}
        {staffPhone === null && (
          <Card>
            <CardContent className="py-4 text-sm text-muted-foreground">
              Cập nhật <span className="font-medium">số điện thoại</span> (biểu tượng &ldquo;Sửa thông tin&rdquo; ở đầu trang) để xem chương trình giới thiệu bạn bè.
            </CardContent>
          </Card>
        )}
      </div>
    )
  }

  // ── Super admin: all stores for the latest week + manual upload fallback ───
  const { data: allRows, error: allRowsError } = await supabase
    .from('store_weekly_targets')
    .select('week_start, target, min_weekly_target, actual, run_rate, status, remaining_target, refreshed_at, stores(name)')
    .order('week_start', { ascending: false })
    .order('refreshed_at', { ascending: false })
    .limit(120)

  const latestWeek = (allRows ?? [])[0]?.week_start as string | undefined
  const weekRows = ((allRows ?? []) as unknown as TargetRecord[])
    .filter((r) => r.week_start === latestWeek)
    .sort((a, b) => (a.stores?.name ?? '').localeCompare(b.stores?.name ?? '', 'vi'))

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-5xl">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold">Doanh số tuần theo cửa hàng</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {latestWeek
              ? `${weekLabel(latestWeek)} · ${weekRows.length} cửa hàng · cập nhật ${formatDateTime(weekRows[0]?.refreshed_at ?? '')}`
              : 'Chưa có dữ liệu — nạp file XLSX export từ Power BI hoặc kích hoạt feed tự động.'}
          </p>
          {allRowsError && (
            <p className="text-sm text-destructive mt-1">
              Lỗi truy vấn dữ liệu: {allRowsError.message} — kiểm tra migration 051/052 đã apply chưa.
            </p>
          )}
        </div>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Nạp thủ công (dự phòng — đường chính là feed tự động /api/targets/ingest)</CardTitle>
        </CardHeader>
        <CardContent>
          <TargetUploadForm />
        </CardContent>
      </Card>

      {weekRows.length > 0 && (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Cửa hàng</th>
                  <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">Mục tiêu</th>
                  <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">Thực đạt</th>
                  <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">% Run rate</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Trạng thái</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {weekRows.map((r) => (
                  <tr key={`${r.week_start}-${r.stores?.name}`} className="hover:bg-muted/30">
                    <td className="px-4 py-2.5 font-medium">{r.stores?.name ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right text-muted-foreground">{vnd(r.target)}</td>
                    <td className="px-4 py-2.5 text-right">{vnd(r.actual)}</td>
                    <td className="px-4 py-2.5 text-right">
                      {r.run_rate !== null ? `${r.run_rate.toFixed(1)}%` : '—'}
                    </td>
                    <td className="px-4 py-2.5"><StatusBadge status={r.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
