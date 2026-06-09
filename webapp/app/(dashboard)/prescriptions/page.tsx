import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent } from '@/components/ui/card'
import { buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PrescriptionSyncForm } from '@/components/prescriptions/PrescriptionSyncForm'
import { Plus, CheckCircle2, Clock, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatDateTime } from '@/lib/dateUtils'
import { isSuperAdminEmail } from '@/lib/authz'

const PAGE_SIZE = 50

export default async function PrescriptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; store_id?: string; date_from?: string; date_to?: string; page?: string }>
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
    .select('id, order_code, submitted_at, status, stores(name), submitter:users!submitted_by(full_name), prescription_images(id)', isStaff ? undefined : { count: 'exact' })
    .order('submitted_at', { ascending: false })
    .range(from, to)

  if (isStaff)          query = query.eq('submitted_by', user.id)
  if (params.status)    query = query.eq('status', params.status)
  if (params.store_id)  query = query.eq('store_id', params.store_id)
  if (params.q)         query = query.ilike('order_code', `%${params.q.trim()}%`)
  if (params.date_from) query = query.gte('submitted_at', params.date_from + 'T00:00:00+07:00')
  if (params.date_to)   query = query.lte('submitted_at', params.date_to   + 'T23:59:59+07:00')

  const [{ data: submissions, count }, { data: stores }] = await Promise.all([
    query,
    isAdmin
      ? supabase.from('stores').select('id, name').order('name')
      : Promise.resolve({ data: [] }),
  ])

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
      date_from: params.date_from, date_to: params.date_to, page: params.page,
      ...patch,
    }
    const qs = Object.entries(next)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v!)}`)
      .join('&')
    return qs ? `/prescriptions?${qs}` : '/prescriptions'
  }

  return (
    <div className="p-4 space-y-4 pb-24">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-semibold">Toa thuốc</h1>
          {pendingCount > 0 && isAdmin && (
            <p className="text-sm text-amber-700 mt-0.5">{pendingCount} đơn chờ đồng bộ</p>
          )}
        </div>
        {isStaff && (
          <Link href="/prescriptions/new" className={cn(buttonVariants({ size: 'sm' }))}>
            <Plus className="h-4 w-4 mr-1" />
            Nộp toa thuốc
          </Link>
        )}
      </div>

      {/* Admin batch sync form */}
      {isSuper && <PrescriptionSyncForm />}

      {/* Search + filters */}
      <form method="GET" className="flex flex-wrap gap-2 items-end">
        {/* DHC search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <input
            name="q"
            type="text"
            defaultValue={params.q ?? ''}
            placeholder="Tìm mã DHC..."
            aria-label="Tìm theo mã DHC"
            className="pl-8 h-8 w-44 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
          />
        </div>

        {/* Store filter (admin only) */}
        {isAdmin && (
          <select
            name="store_id"
            defaultValue={params.store_id ?? ''}
            aria-label="Lọc theo cửa hàng"
            className="h-8 rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm"
          >
            <option value="">Tất cả cửa hàng</option>
            {(stores ?? []).map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        )}

        {/* Date range */}
        <input name="date_from" type="date" defaultValue={params.date_from ?? ''} aria-label="Từ ngày"
          className="h-8 rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm" />
        <input name="date_to"   type="date" defaultValue={params.date_to   ?? ''} aria-label="Đến ngày"
          className="h-8 rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm" />

        {/* Status filter */}
        <select name="status" defaultValue={params.status ?? ''} aria-label="Lọc theo trạng thái"
          className="h-8 rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm">
          <option value="">Tất cả trạng thái</option>
          <option value="pending_sync">Chờ đồng bộ</option>
          <option value="synced">Đã đồng bộ</option>
        </select>

        <input type="hidden" name="page" value="1" />
        <button type="submit" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-8')}>
          Lọc
        </button>
        {(params.q || params.store_id || params.date_from || params.date_to || params.status) && (
          <Link href="/prescriptions" className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'h-8')}>
            Xoá lọc
          </Link>
        )}
      </form>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Mã DHC</TableHead>
                {!isStaff && <TableHead>Cửa hàng</TableHead>}
                {isAdmin  && <TableHead>Dược sĩ</TableHead>}
                <TableHead>Ngày nộp</TableHead>
                {!isStaff && <TableHead>Ảnh</TableHead>}
                <TableHead>Trạng thái</TableHead>
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
                  <TableCell>
                    {s.status === 'synced' ? (
                      <Badge className="bg-green-100 text-green-700 gap-1 text-xs">
                        <CheckCircle2 className="h-3 w-3" /> Đã đồng bộ
                      </Badge>
                    ) : (
                      <Badge className="bg-amber-100 text-amber-700 gap-1 text-xs">
                        <Clock className="h-3 w-3" /> Chờ đồng bộ
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {(submissions ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-10">
                    {isStaff ? 'Bạn chưa nộp toa thuốc nào' : 'Không tìm thấy toa thuốc nào'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>

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
