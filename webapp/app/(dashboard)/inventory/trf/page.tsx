import { redirect } from 'next/navigation'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { createClient } from '@/lib/supabase/server'
import { isSuperAdminEmail } from '@/lib/authz'
import { embeddedName } from '@/lib/utils'
import { CYCLE_COUNT_DEPT_ID } from '@/lib/inventory/constants'
import { Card, CardContent } from '@/components/ui/card'
import { TrfBoard, type TrfRow } from '@/components/inventory/TrfBoard'
import { ClipboardCheck } from 'lucide-react'

// Inventory → TRF. RLS scopes the query per role: super / Cycle Count admin see
// all stores (grouped accordion); staff / store_manager see their own store
// (flat list). Interactivity (summary chips, status filter, search, sort) lives
// in the TrfBoard client component; this server page just fetches + maps rows.
interface RawTrf {
  id: string
  title: string
  status: string
  deadline: string | null
  store_id: string | null
  input_data: { trf_code?: string; reason?: string; internal_created_by?: string; pos_code_check?: string } | null
  stores: { name: string } | null
  completed_by_user: unknown
}

export default async function InventoryTrfPage() {
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')

  const role = profile?.role
  const deptId = (profile as { department_id?: string | null } | null)?.department_id ?? null
  const isSuper = role === 'admin' && isSuperAdminEmail(user.email)
  const isCycleCount = role === 'admin' && deptId === CYCLE_COUNT_DEPT_ID
  const isOwnStoreViewer = (role === 'staff' || role === 'store_manager') && !!profile?.store_id
  if (!isSuper && !isCycleCount && !isOwnStoreViewer) redirect('/tasks')
  const isAllStores = isSuper || isCycleCount

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('tasks')
    .select('id, title, status, deadline, store_id, input_data, stores(name), completed_by_user:users!completed_by(full_name)')
    .eq('source_type', 'inventory_trf')
    .order('deadline', { ascending: true })

  const header = (
    <div className="flex items-center gap-2">
      <ClipboardCheck className="h-5 w-5 text-primary" />
      <h1 className="text-xl font-semibold">{isAllStores ? 'TRF theo cửa hàng' : 'Kiểm kho TRF'}</h1>
    </div>
  )

  if (error) {
    console.error('[inventory/trf] query failed:', error.message)
    return (
      <div className="p-4 md:p-6 space-y-4">
        {header}
        <p className="text-sm text-destructive">Không tải được dữ liệu TRF. Thử lại sau hoặc báo Admin.</p>
      </div>
    )
  }

  const raw = (data ?? []) as unknown as RawTrf[]
  const rows: TrfRow[] = raw.map((t) => ({
    id: t.id,
    trf_code: t.input_data?.trf_code ?? t.title.replace(/^TRF\s+/i, ''),
    reason: t.input_data?.reason ?? null,
    internal_created_by: t.input_data?.internal_created_by ?? null,
    pos_code: t.input_data?.pos_code_check ?? null,
    store_name: t.stores?.name ?? null,
    store_id: t.store_id ?? null,
    status: t.status,
    deadline: t.deadline ?? null,
    completed_by_name: embeddedName(t.completed_by_user),
  }))

  return (
    <div className="p-4 md:p-6 space-y-4">
      {header}
      {rows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            <ClipboardCheck className="h-8 w-8 mx-auto mb-3 opacity-30" />
            Chưa có mã TRF nào cần kiểm tra.
          </CardContent>
        </Card>
      ) : (
        <TrfBoard rows={rows} isAllStores={isAllStores} />
      )}
    </div>
  )
}
