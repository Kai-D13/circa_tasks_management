import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/components/ds/PageHeader'
import { DataTableShell } from '@/components/ds/DataTableShell'
import { StatusBadge, type StatusTone } from '@/components/ds/StatusBadge'
import { EmptyState } from '@/components/ds/EmptyState'
import { formatDate } from '@/lib/dateUtils'
import { getSmStoreIds } from '@/lib/authz'
import { canSeeFs } from '@/lib/fs/access'
import { cn } from '@/lib/utils'
import { Store } from 'lucide-react'

// PILOT 1 (UI design system): visual-only migration to components/ds/ —
// queries, RBAC (canSeeFs), SM scoping and wording are byte-identical.
const REGION_LABEL: Record<string, string> = {
  north:   'Miền Bắc',
  central: 'Miền Trung',
  south:   'Miền Nam',
}
// Region is categorical — tones chosen to keep the pre-migration hues
// (blue/amber/green) while sourcing colors from the status tokens.
const REGION_TONE: Record<string, StatusTone> = {
  north:   'info',
  central: 'warning',
  south:   'success',
}

export default async function StoresPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('users').select('role, department_id').eq('id', user.id).single()

  if (profile?.role === 'staff') redirect('/dashboard')

  const isSm = profile?.role === 'sm'
  // OS/FS visibility (RBAC): only super admin / Policy-dept admin see FS stores;
  // every other admin/SM is OS-only. Filter at the query, not just the badge.
  const showFs = canSeeFs({ role: profile?.role, department_id: profile?.department_id, email: user.email })

  const smStoreIds = isSm ? await getSmStoreIds(supabase, user.id) : []
  if (isSm && smStoreIds.length === 0) {
    return (
      <div className="p-4 space-y-4">
        <PageHeader title="Cửa hàng" icon={Store} />
        <EmptyState title="Chưa được phân công cửa hàng nào" hint="Vui lòng liên hệ Admin." />
      </div>
    )
  }

  let query = supabase.from('stores').select('*').order('name')
  if (isSm) query = query.in('id', smStoreIds)
  if (!showFs) query = query.eq('store_type', 'os')

  const { data: stores } = await query

  return (
    <div className="p-4 space-y-4">
      <PageHeader title="Danh sách cửa hàng" icon={Store} />
      <DataTableShell>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tên cửa hàng</TableHead>
              <TableHead>Mã POS</TableHead>
              <TableHead>Vùng</TableHead>
              <TableHead>Địa chỉ</TableHead>
              <TableHead>Ngày tạo</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(stores ?? []).map((s) => (
              <TableRow key={s.id} className={cn(s.is_active === false && 'opacity-60')}>
                {/* Long-text contract: name truncates (title = full text),
                    badges never shrink; address capped + truncated below. */}
                <TableCell className="font-medium max-w-[320px]">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="truncate" title={s.name}>{s.name}</span>
                    {/* Read-only badge (mig 076) — FS stores are managed in the FS
                        module; they never appear in OS pickers/workflows. */}
                    {(s as { store_type?: string }).store_type === 'fs' && (
                      <StatusBadge tone="info" size="sm" className="shrink-0">FS</StatusBadge>
                    )}
                    {s.is_active === false && (
                      <StatusBadge tone="neutral" size="sm" className="shrink-0">Ngừng hoạt động</StatusBadge>
                    )}
                  </span>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground font-mono">{s.code}</TableCell>
                <TableCell>
                  {s.region ? (
                    <StatusBadge tone={REGION_TONE[s.region] ?? 'neutral'}>
                      {REGION_LABEL[s.region] ?? s.region}
                    </StatusBadge>
                  ) : (
                    <span className="text-xs text-muted-foreground">Chưa gán</span>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground max-w-[280px]">
                  <span className="block truncate" title={s.address ?? undefined}>{s.address ?? '—'}</span>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground whitespace-nowrap">{formatDate(s.created_at)}</TableCell>
              </TableRow>
            ))}
            {(stores ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                  Chưa có cửa hàng nào
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </DataTableShell>
    </div>
  )
}
