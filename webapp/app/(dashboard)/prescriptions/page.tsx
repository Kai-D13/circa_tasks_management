import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent } from '@/components/ui/card'
import { buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PrescriptionSyncForm } from '@/components/prescriptions/PrescriptionSyncForm'
import { Plus, CheckCircle2, Clock, Search } from 'lucide-react'
import { ExportButton } from '@/components/common/ExportButton'
import { cn } from '@/lib/utils'
import { formatDate, formatDateTime } from '@/lib/dateUtils'
import { isSuperAdminEmail } from '@/lib/authz'
import { deriveCareState } from '@/lib/prescriptions/careStatus'
import { PrescriptionDateRangeFilter } from '@/components/prescriptions/PrescriptionDateRangeFilter'

const PAGE_SIZE = 50

export default async function PrescriptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; store_id?: string; date_from?: string; date_to?: string; care?: string; care_state?: string; page?: string }>
}) {
  const params = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('users').select('role, store_id').eq('id', user.id).single()

  // SM has no access to prescriptions
  if (profile?.role === 'sm') redirect('/dashboard')

  const isStaff = profile?.role === 'staff'
  const isAdmin = profile?.role === 'admin'
  // Product sync is super-admin only (mirrors the DB is_super_admin() gate).
  const isSuper = isSuperAdminEmail(user.email)

  // Staff hit this list on mobile hot paths: smaller page, no exact count, and a
  // lighter select (drop the per-row prescription_images embed — the "Ảnh" column is
  // hidden for staff). The submitted_by filter mirrors the RLS policy ps_select_staff
  // (submitted_by = auth.uid()) so the planner can use the submitted_by index.
  const pageSize = isStaff ? 20 : PAGE_SIZE
  const page = Math.max(1, parseInt(params.page ?? '1', 10))
  const from = (page - 1) * pageSize
  const to   = isStaff ? from + pageSize : from + pageSize - 1   // staff: +1 row for next-page detection

  // Build filtered query. Select must be a single string literal so PostgREST's
  // compile-time parser keeps the row types. The prescription_images embed is a
  // cheap indexed lookup once idx_pi_submission exists (migration 036); the "Ảnh"
  // column is hidden for staff, so they don't render it. Staff skip the exact count.
  let query = supabase
    .from('prescription_submissions')
    .select('id, order_code, submitted_at, status, is_chronic, order_sync_status, care_status, reminder_date, expected_refill_date, order_created_at, customer_name, customer_phone, stores(name), submitter:users!submitted_by(full_name), prescription_images(id)', isStaff ? undefined : { count: 'exact' })
    .order('submitted_at', { ascending: false })
    .range(from, to)

  if (isStaff)          query = query.eq('submitted_by', user.id)
  if (params.status)    query = query.eq('status', params.status)
  if (params.store_id)  query = query.eq('store_id', params.store_id)
  if (params.q)         query = query.ilike('order_code', `%${params.q.trim()}%`)
  if (params.date_from) query = query.gte('submitted_at', params.date_from + 'T00:00:00+07:00')
  if (params.date_to)   query = query.lte('submitted_at', params.date_to   + 'T23:59:59+07:00')

  // Chronic-care (mig 073). Two axes, kept apart (review r-ui): a top-level TYPE
  // tab (care: Tất cả | Mạn tính) for everyone, and — for admin/SM only — a care
  // STATE dropdown (care_state). All states are chronic-scoped so they match the
  // per-row care chip (deriveCareState only labels chronic rows).
  const vnTodayISO = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)
  const care = params.care === 'chronic' ? 'chronic' : undefined
  const careState = !isStaff && ['waiting', 'due', 'done', 'error'].includes(params.care_state ?? '')
    ? params.care_state : undefined
  if (care === 'chronic') query = query.eq('is_chronic', true)
  // Mirror deriveCareState exactly so the dropdown filter == the on-screen chip.
  if (careState === 'waiting') {
    // chronic, uncared, not-error, and (not synced OR no reminder date yet)
    query = query.eq('is_chronic', true).eq('care_status', 'none').neq('order_sync_status', 'error')
      .or('order_sync_status.neq.synced,reminder_date.is.null')
  } else if (careState === 'due') {
    query = query.eq('is_chronic', true).eq('order_sync_status', 'synced').eq('care_status', 'none').lte('reminder_date', vnTodayISO)
  } else if (careState === 'done') {
    query = query.eq('is_chronic', true).eq('care_status', 'done')
  } else if (careState === 'error') {
    query = query.eq('is_chronic', true).eq('order_sync_status', 'error').eq('care_status', 'none')
  }

  const [{ data: submissions, count, error: listErr }, { data: stores }] = await Promise.all([
    query,
    isAdmin
      ? supabase.from('stores').select('id, name').order('name')
      : Promise.resolve({ data: [] }),
  ])
  // A failed query must NOT read as "no prescriptions" (missing migration/column
  // or RLS error) — surface it. Common cause here: migration 073 not yet run.
  if (listErr) console.error('[prescriptions] list query failed:', listErr.message)

  const totalPages   = Math.max(1, Math.ceil((count ?? 0) / pageSize))
  // Staff: no exact count — the (pageSize + 1)th row, if present, signals a next page.
  const rows         = submissions ?? []
  const pageRows     = isStaff ? rows.slice(0, pageSize) : rows
  const hasNextStaff = isStaff && rows.length > pageSize
  const pendingCount = isAdmin
    ? (await supabase.from('prescription_submissions').select('id', { count: 'exact', head: true }).eq('status', 'pending_sync')).count ?? 0
    : 0

  function buildUrl(patch: Record<string, string | undefined>) {
    const next = {
      status: params.status, q: params.q, store_id: params.store_id,
      date_from: params.date_from, date_to: params.date_to,
      care: params.care, care_state: params.care_state, page: params.page,
      ...patch,
    }
    const qs = Object.entries(next)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v!)}`)
      .join('&')
    return qs ? `/prescriptions?${qs}` : '/prescriptions'
  }

  // Shared status chip (mobile card + desktop table render the same rows).
  const statusBadge = (status: string) =>
    status === 'synced' ? (
      <Badge className="bg-green-100 text-green-700 gap-1 text-xs">
        <CheckCircle2 className="h-3 w-3" /> Đã đồng bộ
      </Badge>
    ) : (
      <Badge className="bg-amber-100 text-amber-700 gap-1 text-xs">
        <Clock className="h-3 w-3" /> Chờ đồng bộ
      </Badge>
    )

  return (
    <div className="p-4 space-y-4 pb-24">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-semibold">Toa thuốc</h1>
          {pendingCount > 0 && isAdmin && (
            <p className="text-sm text-amber-700 mt-0.5">{pendingCount} đơn chờ đồng bộ</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && <ExportButton endpoint="/api/export/prescriptions" />}
          {isStaff && (
            <Link href="/prescriptions/new" className={cn(buttonVariants({ size: 'sm' }), 'max-md:h-10 max-md:px-4')}>
              <Plus className="h-4 w-4 mr-1" />
              Nộp toa thuốc
            </Link>
          )}
        </div>
      </div>

      {/* Admin batch sync form */}
      {isSuper && <PrescriptionSyncForm />}

      {listErr && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
          <p className="font-medium text-destructive">Không tải được danh sách toa thuốc</p>
          <p className="text-muted-foreground mt-1">{listErr.message}</p>
          {(listErr.message.includes('care_status') || listErr.message.includes('is_chronic') || listErr.message.includes('order_sync')) && (
            <p className="text-muted-foreground mt-1">
              Có thể migration <code className="font-mono text-xs bg-muted px-1 rounded">073_prescription_chronic_care.sql</code> chưa được chạy.
            </p>
          )}
        </div>
      )}

      {/* Type tabs — only Tất cả | Mạn tính (review r-ui: states moved to the
          per-row chip + the admin/SM status dropdown below). */}
      <div className="inline-flex rounded-full border bg-muted/40 p-0.5">
        {([
          { key: undefined, label: 'Tất cả' },
          { key: 'chronic', label: 'Mạn tính' },
        ] as { key?: string; label: string }[]).map((t) => {
          const active = care === t.key
          return (
            <Link
              key={t.label}
              href={buildUrl({ care: t.key, care_state: undefined, page: undefined })}
              className={cn(
                'px-4 py-1.5 rounded-full text-sm font-medium transition-colors',
                active
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
            </Link>
          )
        })}
      </div>

      {/* Search + filters. Staff get only DHC search + a single date-range
          control; the compliance/care selects are admin/SM concerns (review
          r-ui3). The date range is a client control (navigates itself); a
          filter submit preserves it via hidden inputs. */}
      <div className="flex flex-wrap gap-2 items-end">
        <form method="GET" className="flex flex-wrap gap-2 items-end">
          {/* DHC search — 40px tall on mobile for touch, compact on desktop */}
          <div className="relative w-full sm:w-auto">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <input
              name="q"
              type="text"
              defaultValue={params.q ?? ''}
              placeholder="Tìm mã DHC..."
              aria-label="Tìm theo mã DHC"
              className="pl-8 h-10 md:h-8 w-full sm:w-44 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
            />
          </div>

          {/* Store filter (admin only) */}
          {isAdmin && (
            <select
              name="store_id"
              defaultValue={params.store_id ?? ''}
              aria-label="Lọc theo cửa hàng"
              className="h-10 md:h-8 rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm"
            >
              <option value="">Tất cả cửa hàng</option>
              {(stores ?? []).map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          )}

          {/* Product-sync status (compliance JSON) — admin/SM only */}
          {!isStaff && (
            <select name="status" defaultValue={params.status ?? ''} aria-label="Lọc theo trạng thái đồng bộ"
              className="h-10 md:h-8 rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm">
              <option value="">Tất cả trạng thái</option>
              <option value="pending_sync">Chờ đồng bộ</option>
              <option value="synced">Đã đồng bộ</option>
            </select>
          )}

          {/* Care status (mig 073) — admin/SM only; the states that used to be tabs */}
          {!isStaff && (
            <select name="care_state" defaultValue={params.care_state ?? ''} aria-label="Lọc theo trạng thái chăm sóc"
              className="h-10 md:h-8 rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm">
              <option value="">Chăm sóc: tất cả</option>
              <option value="waiting">Chờ dữ liệu đơn</option>
              <option value="due">Cần chăm sóc</option>
              <option value="done">Đã chăm sóc</option>
              <option value="error">Lỗi DHC</option>
            </select>
          )}

          {/* Hidden: preserve the active tab + date range across a filter submit */}
          {care && <input type="hidden" name="care" value={care} />}
          {params.date_from && <input type="hidden" name="date_from" value={params.date_from} />}
          {params.date_to && <input type="hidden" name="date_to" value={params.date_to} />}
          <input type="hidden" name="page" value="1" />
          {/* Staff have only the DHC search (submits on Enter) + the date range,
              so the explicit 'Lọc' button is redundant — it's for the admin/SM
              multi-dropdown row (review r-ui). */}
          {!isStaff && (
            <button type="submit" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-10 md:h-8')}>
              Lọc
            </button>
          )}
        </form>

        <PrescriptionDateRangeFilter />

        {(params.q || params.store_id || params.date_from || params.date_to || params.status || params.care_state) && (
          <Link href={buildUrl({ q: undefined, store_id: undefined, date_from: undefined, date_to: undefined, status: undefined, care_state: undefined, page: undefined })}
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'h-10 md:h-8')}>
            Xoá lọc
          </Link>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {/* Mobile: card list — the multi-column table is unreadable at 390px.
              Renders the SAME pageRows as the table below (no data drift). */}
          <div className="md:hidden divide-y">
            {pageRows.map((s) => {
              const storeName = (s.stores as unknown as { name: string } | null)?.name
              const careState = deriveCareState(s, vnTodayISO)
              return (
                <Link
                  key={`m-${s.id}`}
                  href={`/prescriptions/${s.id}`}
                  prefetch={false}
                  className="block p-3.5 active:bg-muted/50"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono font-semibold text-sm truncate">{s.order_code}</span>
                    <span className="flex items-center gap-1 shrink-0">
                      {careState && (
                        <span className={cn('text-[11px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap', careState.cls)}>
                          {careState.label}
                        </span>
                      )}
                      {/* Legacy product-sync status is an admin/compliance concern;
                          hide it from staff so it isn't confused with care sync. */}
                      {!isStaff && statusBadge(s.status)}
                    </span>
                  </div>
                  {/* Chronic rows read as a customer-care list: khách + SĐT, ngày
                      bán → hết thuốc, and a "Chăm sóc" affordance when due. */}
                  {s.is_chronic ? (
                    <div className="mt-1.5 space-y-0.5">
                      <p className="text-sm font-medium">{s.customer_name ?? 'Khách hàng —'}
                        {s.customer_phone && <span className="text-muted-foreground font-normal"> · {s.customer_phone}</span>}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {s.order_created_at ? `Bán ${formatDate(s.order_created_at)}` : 'Chờ dữ liệu đơn'}
                        {s.expected_refill_date ? ` · Hết thuốc ${formatDate(s.expected_refill_date)}` : ''}
                        {!isStaff && storeName ? ` · ${storeName}` : ''}
                      </p>
                      {careState?.key === 'due' && (
                        <p className="text-xs font-medium text-primary">Chăm sóc khách ngay →</p>
                      )}
                    </div>
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {!isStaff && storeName ? `${storeName} · ` : ''}{formatDateTime(s.submitted_at)}
                    </p>
                  )}
                </Link>
              )
            })}
            {pageRows.length === 0 && !listErr && (
              <p className="text-center text-sm text-muted-foreground py-10">
                {isStaff ? 'Bạn chưa nộp toa thuốc nào' : 'Không tìm thấy toa thuốc nào'}
              </p>
            )}
          </div>

          <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Mã DHC</TableHead>
                {!isStaff && <TableHead>Cửa hàng</TableHead>}
                {isAdmin  && <TableHead>Dược sĩ</TableHead>}
                <TableHead>Ngày nộp</TableHead>
                {!isStaff && <TableHead>Ảnh</TableHead>}
                <TableHead>Trạng thái</TableHead>
                <TableHead>Chăm sóc</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageRows.map((s) => (
                <TableRow key={s.id} className="cursor-pointer hover:bg-muted/50">
                  <TableCell className="font-mono font-medium">
                    <Link href={`/prescriptions/${s.id}`} target="_blank" rel="noopener noreferrer" prefetch={false} className="hover:underline">
                      {s.order_code}
                    </Link>
                  </TableCell>
                  {!isStaff && (
                    <TableCell className="text-sm text-muted-foreground">
                      {(s.stores as unknown as { name: string } | null)?.name ?? '—'}
                    </TableCell>
                  )}
                  {isAdmin && (
                    <TableCell className="text-sm text-muted-foreground">
                      {(s.submitter as unknown as { full_name: string } | null)?.full_name ?? '—'}
                    </TableCell>
                  )}
                  <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                    {formatDateTime(s.submitted_at)}
                  </TableCell>
                  {!isStaff && (
                    <TableCell className="text-sm text-muted-foreground">
                      {Array.isArray(s.prescription_images) ? s.prescription_images.length : 0} ảnh
                    </TableCell>
                  )}
                  <TableCell>{statusBadge(s.status)}</TableCell>
                  <TableCell>
                    {(() => {
                      const cs = deriveCareState(s, vnTodayISO)
                      return cs ? (
                        <span className={cn('text-[11px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap', cs.cls)}>
                          {cs.label}
                        </span>
                      ) : <span className="text-xs text-muted-foreground">—</span>
                    })()}
                  </TableCell>
                </TableRow>
              ))}
              {(submissions ?? []).length === 0 && !listErr && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-10">
                    {isStaff ? 'Bạn chưa nộp toa thuốc nào' : 'Không tìm thấy toa thuốc nào'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          </div>

          {/* Staff pagination — Prev/Next only (no exact count, so no total) */}
          {isStaff && (page > 1 || hasNextStaff) && (
            <div className="flex items-center justify-between px-4 py-3 border-t text-sm">
              <span className="text-muted-foreground">Trang {page}</span>
              <div className="flex gap-2">
                {page > 1 && (
                  <Link href={buildUrl({ page: String(page - 1) })} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
                    ← Trước
                  </Link>
                )}
                {hasNextStaff && (
                  <Link href={buildUrl({ page: String(page + 1) })} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
                    Tiếp →
                  </Link>
                )}
              </div>
            </div>
          )}

          {/* Admin/manager pagination — numbered, driven by the exact count */}
          {!isStaff && totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t text-sm">
              <span className="text-muted-foreground">
                Trang {page} / {totalPages} · {count ?? 0} bản ghi
              </span>
              <div className="flex gap-2">
                {page > 1 && (
                  <Link href={buildUrl({ page: String(page - 1) })} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
                    ← Trước
                  </Link>
                )}
                {page < totalPages && (
                  <Link href={buildUrl({ page: String(page + 1) })} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
                    Tiếp →
                  </Link>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
