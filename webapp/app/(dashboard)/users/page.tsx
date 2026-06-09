import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { CreateUserDialog } from '@/components/users/CreateUserDialog'
import { EditUserDialog } from '@/components/users/EditUserDialog'
import { ResetPasswordDialog } from '@/components/users/ResetPasswordDialog'
import { UserFilters } from '@/components/users/UserFilters'
import { Pagination } from '@/components/common/Pagination'
import { formatDate } from '@/lib/dateUtils'
import { isSuperAdminEmail, getSmStoreIds } from '@/lib/authz'
import { AlertTriangle } from 'lucide-react'

const PAGE_SIZE = 30

const ROLE_COLORS: Record<string, string> = {
  admin:         'bg-red-100 text-red-700',
  store_manager: 'bg-blue-100 text-blue-700',
  staff:         'bg-green-100 text-green-700',
  sm:            'bg-purple-100 text-purple-700',
}

const ROLE_LABELS: Record<string, string> = {
  admin:         'Admin',
  store_manager: 'Quản lý',
  staff:         'Nhân viên',
  sm:            'SM',
}

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; role?: string; store_id?: string; missing_store?: string; page?: string }>
}) {
  const params   = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('users').select('role').eq('id', user.id).single()

  const isSm = profile?.role === 'sm'
  if (profile?.role !== 'admin' && !isSm) redirect('/dashboard')

  const isSuper = isSuperAdminEmail(user.email)

  // SM: pre-load assigned store IDs for filtering
  const smStoreIds = isSm ? await getSmStoreIds(supabase, user.id) : []
  if (isSm && smStoreIds.length === 0) {
    return (
      <div className="p-4 space-y-4">
        <h1 className="text-xl font-semibold">Người dùng</h1>
        <p className="text-sm text-muted-foreground">Chưa được phân công cửa hàng nào. Vui lòng liên hệ Admin.</p>
      </div>
    )
  }

  const page   = Math.max(1, parseInt(params.page ?? '1', 10) || 1)
  const offset = (page - 1) * PAGE_SIZE

  let query = supabase
    .from('users')
    // FK-disambiguated embed: sm_store_assignments (migration 045) added a second
    // users<->stores relationship, so a bare stores(name) embed now errors.
    .select('id, email, full_name, role, store_id, created_at, stores!users_store_id_fkey(name)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1)

  // SM: only see staff in their assigned stores
  if (isSm) {
    query = query.eq('role', 'staff').in('store_id', smStoreIds)
  } else {
    if (params.role) query = query.eq('role', params.role)
    if (params.store_id) query = query.eq('store_id', params.store_id)
    // Admins legitimately have no store, so exclude them from the missing-store filter.
    if (params.missing_store === 'true') query = query.is('store_id', null).neq('role', 'admin')
  }

  if (params.q) {
    // Sanitize before building the PostgREST or-filter: strip the characters that
    // would break its mini-syntax or act as ilike wildcards (, ( ) % * \).
    const safe = params.q.trim().replace(/[,()%*\\]/g, '')
    if (safe) query = query.or(`full_name.ilike.%${safe}%,email.ilike.%${safe}%`)
  }

  const [{ data: users, count }, { data: stores }] = await Promise.all([
    query,
    isSm
      ? supabase.from('stores').select('id, name, code').in('id', smStoreIds).order('name')
      : supabase.from('stores').select('id, name, code').order('name'),
  ])

  const totalRows  = count ?? 0
  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE))

  // Out-of-range page: redirect to page 1 (preserving filters) so the admin
  // doesn't land on an empty table that looks like "no results".
  if ((users ?? []).length === 0 && page > 1) {
    const q = new URLSearchParams()
    const carry = ['q', 'role', 'store_id', 'missing_store'] as const
    carry.forEach((k) => { if (params[k]) q.set(k, params[k]!) })
    const qs = q.toString()
    redirect(`/users${qs ? `?${qs}` : ''}`)
  }

  // Build a page href that preserves the active filters.
  function pageHref(p: number) {
    const q = new URLSearchParams()
    const carry = ['q', 'role', 'store_id', 'missing_store'] as const
    carry.forEach((k) => { if (params[k]) q.set(k, params[k]!) })
    if (p > 1) q.set('page', String(p))
    const qs = q.toString()
    return `/users${qs ? `?${qs}` : ''}`
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">
          {isSm ? 'Nhân viên cửa hàng' : 'Quản lý người dùng'}
        </h1>
        <CreateUserDialog stores={stores ?? []} />
      </div>

      {!isSm && <UserFilters stores={stores ?? []} currentParams={params} />}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Họ tên</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Phân quyền</TableHead>
                <TableHead>Cửa hàng</TableHead>
                <TableHead>Ngày tạo</TableHead>
                <TableHead className="w-[80px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(users ?? []).map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="font-medium">{u.full_name}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">{u.email}</TableCell>
                  <TableCell>
                    <Badge className={ROLE_COLORS[u.role] ?? ''}>
                      {ROLE_LABELS[u.role] ?? u.role}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm">
                    {u.role !== 'admin' && u.role !== 'sm' && !u.store_id ? (
                      <span className="flex items-center gap-1 text-amber-600">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                        <span>Chưa có cửa hàng</span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">
                        {(u.stores as unknown as { name: string } | null)?.name ?? '—'}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDate(u.created_at)}
                  </TableCell>
                  <TableCell>
                    {/* Edit / reset password: super admin only */}
                    {isSuper && !isSm ? (
                      <div className="flex items-center gap-1">
                        <EditUserDialog
                          userId={u.id}
                          userName={u.full_name}
                          currentRole={u.role}
                          currentStoreId={u.store_id}
                          stores={stores ?? []}
                        />
                        <ResetPasswordDialog
                          userId={u.id}
                          userName={u.full_name}
                        />
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {(users ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    Không tìm thấy người dùng nào
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Pagination
        page={page}
        totalPages={totalPages}
        totalRows={totalRows}
        pageSize={PAGE_SIZE}
        hrefForPage={pageHref}
      />
    </div>
  )
}
