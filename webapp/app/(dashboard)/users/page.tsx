import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { CreateUserDialog } from '@/components/users/CreateUserDialog'
import { EditUserDialog } from '@/components/users/EditUserDialog'
import { ResetPasswordDialog } from '@/components/users/ResetPasswordDialog'
import { formatDate } from '@/lib/dateUtils'
import { isSuperAdminEmail } from '@/lib/authz'
import { AlertTriangle } from 'lucide-react'

const ROLE_COLORS: Record<string, string> = {
  admin:         'bg-red-100 text-red-700',
  store_manager: 'bg-blue-100 text-blue-700',
  staff:         'bg-green-100 text-green-700',
}

const ROLE_LABELS: Record<string, string> = {
  admin:         'Admin',
  store_manager: 'Quản lý',
  staff:         'Nhân viên',
}

export default async function UsersPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('users').select('role').eq('id', user.id).single()

  if (profile?.role !== 'admin') redirect('/dashboard')

  const isSuper = isSuperAdminEmail(user.email)

  const [{ data: users }, { data: stores }] = await Promise.all([
    supabase
      .from('users')
      .select('*, stores(name)')
      .order('created_at', { ascending: false }),
    supabase.from('stores').select('id, name').order('name'),
  ])

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Quản lý người dùng</h1>
        <CreateUserDialog stores={stores ?? []} />
      </div>

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
                    {u.role !== 'admin' && !u.store_id ? (
                      <span className="flex items-center gap-1 text-amber-600">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                        <span>Chưa có cửa hàng</span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">
                        {(u.stores as { name: string } | null)?.name ?? '—'}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDate(u.created_at)}
                  </TableCell>
                  <TableCell>
                    {/* Admin-target rows are manageable only by the super admin */}
                    {u.role === 'admin' && !isSuper ? (
                      <span className="text-xs text-muted-foreground">—</span>
                    ) : (
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
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {(users ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    Chưa có người dùng nào
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
