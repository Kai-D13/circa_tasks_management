import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { isSuperAdminEmail } from '@/lib/authz'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { TargetUploadForm } from '@/components/targets/TargetUploadForm'
import { formatDateTime } from '@/lib/dateUtils'
import { cn } from '@/lib/utils'
import { TrendingUp } from 'lucide-react'

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

function ProgressBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div className="h-2.5 w-full rounded-full bg-muted overflow-hidden">
      <div
        className={cn('h-full rounded-full', clamped >= 100 ? 'bg-green-500' : 'bg-primary')}
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}

export default async function TargetsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('users').select('role, store_id, stores!users_store_id_fkey(name)').eq('id', user.id).single()

  const isSuper = profile?.role === 'admin' && isSuperAdminEmail(user.email)
  const isStaff = profile?.role === 'staff'
  if (!isStaff && !isSuper) redirect('/tasks')

  // ── Staff: own store's weekly card ─────────────────────────────────────────
  if (isStaff) {
    if (!profile?.store_id) {
      return (
        <div className="p-4">
          <p className="text-sm text-muted-foreground">Tài khoản chưa được gán cửa hàng. Vui lòng liên hệ Admin.</p>
        </div>
      )
    }
    const { data: rows } = await supabase
      .from('store_weekly_targets')
      .select('week_start, target, min_weekly_target, actual, run_rate, status, remaining_target, refreshed_at')
      .eq('store_id', profile.store_id)
      .order('week_start', { ascending: false })
      .limit(5)

    const current = (rows ?? [])[0] as TargetRecord | undefined
    const history = ((rows ?? []) as TargetRecord[]).slice(1)
    const storeName = (profile.stores as unknown as { name: string } | null)?.name ?? 'Cửa hàng của bạn'
    const pct = current ? (current.run_rate ?? (current.target > 0 ? (current.actual / current.target) * 100 : 0)) : 0

    return (
      <div className="p-4 space-y-4 max-w-xl mx-auto">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold">Doanh số tuần</h1>
        </div>

        {!current ? (
          <Card>
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              <TrendingUp className="h-8 w-8 mx-auto mb-3 opacity-30" />
              Chưa có dữ liệu doanh số cho cửa hàng của bạn.
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div>
                  <CardTitle className="text-base">{storeName}</CardTitle>
                  <p className="text-xs text-muted-foreground mt-0.5">{weekLabel(current.week_start)}</p>
                </div>
                <StatusBadge status={current.status} />
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between">
                  <span className="text-2xl font-semibold">{vnd(current.actual)}</span>
                  <span className="text-sm text-muted-foreground">/ {vnd(current.target)}</span>
                </div>
                <ProgressBar pct={pct} />
                <p className="text-xs text-muted-foreground text-right">
                  Đạt {current.run_rate !== null ? `${current.run_rate.toFixed(1)}%` : '—'} mục tiêu tuần
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">Mục tiêu tối thiểu (90%)</p>
                  <p className="font-medium mt-0.5">{vnd(current.min_weekly_target)}</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">Còn thiếu (so với tối thiểu)</p>
                  <p className={cn('font-medium mt-0.5', (current.remaining_target ?? 0) <= 0 ? 'text-green-600' : 'text-amber-600')}>
                    {(current.remaining_target ?? 0) <= 0 ? 'Đã đạt 🎉' : vnd(current.remaining_target)}
                  </p>
                </div>
              </div>

              <p className="text-[11px] text-muted-foreground">
                Cập nhật lúc {formatDateTime(current.refreshed_at)} · Nguồn: báo cáo BI
              </p>
            </CardContent>
          </Card>
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
      </div>
    )
  }

  // ── Super admin: all stores for the latest week + manual upload fallback ───
  const { data: allRows } = await supabase
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
