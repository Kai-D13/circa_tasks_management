import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { CreateUserDialog } from '@/components/users/CreateUserDialog'
import { EditUserDialog } from '@/components/users/EditUserDialog'
import { ResetPasswordDialog } from '@/components/users/ResetPasswordDialog'
import { ManageDepartmentsDialog } from '@/components/users/ManageDepartmentsDialog'
import { UserFilters } from '@/components/users/UserFilters'
import { Pagination } from '@/components/common/Pagination'
import { formatDate } from '@/lib/dateUtils'
import { isSuperAdminEmail, getSmStoreIds } from '@/lib/authz'
import { deptBadgeClass, type Department } from '@/lib/departments'
import { cn } from '@/lib/utils'
import { AlertTriangle, ShieldCheck, Store as StoreIcon, UserRound, Users as UsersIcon } from 'lucide-react'

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

// Avatar initials: first letter of the last word (Vietnamese given name) +
// first letter of the first word — "Nguyễn Văn An" → "AN".
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[parts.length - 1][0] + parts[0][0]).toUpperCase()
}

function StatCard({ icon, label, value, tint }: {
  icon: React.ReactNode; label: string; value: number; tint: string
}) {
  return (
    <Card>
      <CardContent className="px-4 py-3 flex items-center gap-3">
        <div className={cn('h-9 w-9 rounded-lg flex items-center justify-center shrink-0', tint)}>
          {icon}
        </div>
        <div className="min-w-0">
          <p className="text-xl font-semibold leading-tight">{value}</p>
          <p className="text-xs text-muted-foreground truncate">{label}</p>
        </div>
      </CardContent>
    </Card>
  )
}

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; role?: string; store_id?: string; missing_store?: string; department_id?: string; page?: string }>
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
    // departments has a single FK from users → bare embed is safe.
    .select('id, email, full_name, phone_number, role, store_id, department_id, created_at, stores!users_store_id_fkey(name), department:departments(id, name, color)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1)

  // SM: only see staff in their assigned stores
  if (isSm) {
    query = query.eq('role', 'staff').in('store_id', smStoreIds)
  } else {
    if (params.role) query = query.eq('role', params.role)
    if (params.store_id) query = query.eq('store_id', params.store_id)
    if (params.department_id) query = query.eq('department_id', params.department_id)
    // Admins legitimately have no store, so exclude them from the missing-store filter.
    if (params.missing_store === 'true') query = query.is('store_id', null).neq('role', 'admin')
  }

  if (params.q) {
    // Sanitize before building the PostgREST or-filter: strip the characters that
    // would break its mini-syntax or act as ilike wildcards (, ( ) % * \).
    const safe = params.q.trim().replace(/[,()%*\\]/g, '')
    if (safe) query = query.or(`full_name.ilike.%${safe}%,email.ilike.%${safe}%`)
  }

  // allProfiles: one lightweight pass (role + department per user) powers the
  // stat cards AND the department member counts — no per-card count queries.
  // limit(2000) is 10x+ the current ~150-account fleet; revisit (switch to
  // grouped count queries) if the user base ever approaches it.
  const [{ data: users, count }, { data: stores }, { data: departments }, { data: allProfiles }] = await Promise.all([
    query,
    isSm
      ? supabase.from('stores').select('id, name, code').in('id', smStoreIds).order('name')
      : supabase.from('stores').select('id, name, code').order('name'),
    isSm
      ? Promise.resolve({ data: [] as Department[] })
      : supabase.from('departments').select('id, name, color').order('name'),
    isSm
      ? Promise.resolve({ data: [] as { role: string; department_id: string | null }[] })
      : supabase.from('users').select('role, department_id').limit(2000),
  ])

  const totalRows  = count ?? 0
  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE))

  // Out-of-range page: redirect to page 1 (preserving filters) so the admin
  // doesn't land on an empty table that looks like "no results".
  if ((users ?? []).length === 0 && page > 1) {
    const q = new URLSearchParams()
    const carry = ['q', 'role', 'store_id', 'missing_store', 'department_id'] as const
    carry.forEach((k) => { if (params[k]) q.set(k, params[k]!) })
    const qs = q.toString()
    redirect(`/users${qs ? `?${qs}` : ''}`)
  }

  // Build a page href that preserves the active filters.
  function pageHref(p: number) {
    const q = new URLSearchParams()
    const carry = ['q', 'role', 'store_id', 'missing_store', 'department_id'] as const
    carry.forEach((k) => { if (params[k]) q.set(k, params[k]!) })
    if (p > 1) q.set('page', String(p))
    const qs = q.toString()
    return `/users${qs ? `?${qs}` : ''}`
  }

  const roleCounts = (allProfiles ?? []).reduce<Record<string, number>>((acc, p) => {
    acc[p.role] = (acc[p.role] ?? 0) + 1
    return acc
  }, {})
  const totalUsers = (allProfiles ?? []).length

  const deptMemberCounts = (allProfiles ?? []).reduce<Record<string, number>>((acc, p) => {
    if (p.department_id) acc[p.department_id] = (acc[p.department_id] ?? 0) + 1
    return acc
  }, {})
  const departmentsWithCounts = (departments ?? []).map((d) => ({
    ...d,
    memberCount: deptMemberCounts[d.id] ?? 0,
  }))

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-7xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold">
            {isSm ? 'Nhân viên cửa hàng' : 'Quản lý người dùng'}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {isSm
              ? `${totalRows} nhân viên trong các cửa hàng bạn quản lý`
              : `${totalUsers} tài khoản trong hệ thống`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isSuper && !isSm && <ManageDepartmentsDialog departments={departmentsWithCounts} />}
          <CreateUserDialog stores={stores ?? []} departments={departments ?? []} />
        </div>
      </div>

      {/* Stat cards — admin only (SM has a single-role scope, cards add nothing) */}
      {!isSm && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard
            icon={<UsersIcon className="h-4.5 w-4.5 text-primary" />}
            tint="bg-primary/10"
            label="Tổng tài khoản"
            value={totalUsers}
          />
          <StatCard
            icon={<ShieldCheck className="h-4.5 w-4.5 text-red-600" />}
            tint="bg-red-100"
            label="Admin / PIC"
            value={roleCounts['admin'] ?? 0}
          />
          <StatCard
            icon={<StoreIcon className="h-4.5 w-4.5 text-blue-600" />}
            tint="bg-blue-100"
            label="Quản lý & SM"
            value={(roleCounts['store_manager'] ?? 0) + (roleCounts['sm'] ?? 0)}
          />
          <StatCard
            icon={<UserRound className="h-4.5 w-4.5 text-green-600" />}
            tint="bg-green-100"
            label="Dược sĩ"
            value={roleCounts['staff'] ?? 0}
          />
        </div>
      )}

      {!isSm && (
        <UserFilters stores={stores ?? []} departments={departments ?? []} currentParams={params} />
      )}

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Người dùng</TableHead>
                <TableHead>Phân quyền</TableHead>
                {!isSm && <TableHead>Phòng ban</TableHead>}
                <TableHead>Cửa hàng</TableHead>
                <TableHead>Số điện thoại</TableHead>
                <TableHead>Ngày tạo</TableHead>
                <TableHead className="w-[80px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(users ?? []).map((u) => {
                const dept = u.department as unknown as Department | null
                return (
                  <TableRow key={u.id}>
                    <TableCell>
                      <div className="flex items-center gap-3 min-w-[200px]">
                        <div className="h-9 w-9 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-semibold shrink-0">
                          {initials(u.full_name || u.email)}
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium text-sm leading-tight truncate">
                            {u.full_name || '—'}
                            {u.id === user.id && (
                              <span className="ml-1.5 text-[10px] text-muted-foreground font-normal">(bạn)</span>
                            )}
                          </p>
                          <p className="text-xs text-muted-foreground truncate">{u.email}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge className={ROLE_COLORS[u.role] ?? ''}>
                        {ROLE_LABELS[u.role] ?? u.role}
                      </Badge>
                    </TableCell>
                    {!isSm && (
                      <TableCell>
                        {dept ? (
                          <span className={cn('text-xs px-2 py-0.5 rounded font-medium whitespace-nowrap', deptBadgeClass(dept.color))}>
                            {dept.name}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    )}
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
                    <TableCell className="text-sm whitespace-nowrap">
                      {(u as { phone_number?: string | null }).phone_number
                        ? <span className="font-mono text-xs">{(u as { phone_number?: string | null }).phone_number}</span>
                        : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                      {formatDate(u.created_at)}
                    </TableCell>
                    <TableCell>
                      {/* Edit / reset password: super admin only, never on your own
                          row (self-demote would break is_super_admin()). */}
                      {isSuper && !isSm && u.id !== user.id ? (
                        <div className="flex items-center gap-1">
                          <EditUserDialog
                            userId={u.id}
                            userName={u.full_name}
                            currentRole={u.role}
                            currentStoreId={u.store_id}
                            currentDepartmentId={u.department_id ?? null}
                            stores={stores ?? []}
                            departments={departments ?? []}
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
                )
              })}
              {(users ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={isSm ? 6 : 7} className="py-12">
                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                      <UsersIcon className="h-8 w-8 opacity-30" />
                      <p className="text-sm">Không tìm thấy người dùng nào</p>
                    </div>
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
