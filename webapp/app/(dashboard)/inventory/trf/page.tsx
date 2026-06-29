import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { createClient } from '@/lib/supabase/server'
import { isSuperAdminEmail } from '@/lib/authz'
import { CYCLE_COUNT_DEPT_ID } from '@/lib/inventory/constants'
import { Card, CardContent } from '@/components/ui/card'
import { getEffectiveStatus, formatDate } from '@/lib/dateUtils'
import { cn } from '@/lib/utils'
import { ClipboardCheck, ChevronRight } from 'lucide-react'

// Inventory → TRF. RLS scopes the same query per role:
//   super / Cycle Count admin → all stores (grouped accordion by store)
//   staff / store_manager     → their own store only (flat card list)
// Cards link to /tasks/[id] which renders the existing store-level submit form.

interface TrfTaskRow {
  id: string
  title: string
  status: string
  deadline: string | null
  store_id: string | null
  input_data: { trf_code?: string; reason?: string } | null
  stores: { name: string } | null
  completed_by_user: { full_name: string } | null
}

function statusInfo(status: string, deadline: string | null) {
  const eff = getEffectiveStatus(deadline, status)
  if (eff === 'done') return { label: 'Đã nộp', cls: 'bg-green-100 text-green-700' }
  if (eff === 'overdue') return { label: 'Quá hạn', cls: 'bg-red-100 text-red-700' }
  return { label: 'Chờ nộp', cls: 'bg-amber-100 text-amber-700' }
}

const trfCode = (r: TrfTaskRow) => r.input_data?.trf_code ?? r.title.replace(/^TRF\s+/i, '')

function TrfRow({ r }: { r: TrfTaskRow }) {
  const s = statusInfo(r.status, r.deadline)
  return (
    <Link
      href={`/tasks/${r.id}`}
      className="flex items-center gap-3 px-4 py-3 border-t hover:bg-muted/30 transition-colors"
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium text-sm truncate">{trfCode(r)}</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          {r.deadline ? `Hạn ${formatDate(r.deadline)}` : 'Không hạn'}
          {r.completed_by_user ? ` · ${r.completed_by_user.full_name}` : ''}
        </p>
      </div>
      <span className={cn('text-xs px-2 py-0.5 rounded font-medium shrink-0', s.cls)}>{s.label}</span>
      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
    </Link>
  )
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
  if (error) {
    console.error('[inventory/trf] query failed:', error.message)
    return (
      <div className="p-4">
        <p className="text-sm text-destructive">Không tải được dữ liệu TRF. Thử lại sau hoặc báo Admin.</p>
      </div>
    )
  }
  const rows = (data ?? []) as unknown as TrfTaskRow[]

  const header = (
    <div className="flex items-center gap-2">
      <ClipboardCheck className="h-5 w-5 text-primary" />
      <h1 className="text-xl font-semibold">{isAllStores ? 'TRF theo cửa hàng' : 'Kiểm kho TRF'}</h1>
    </div>
  )

  if (rows.length === 0) {
    return (
      <div className="p-4 md:p-6 space-y-4 max-w-3xl">
        {header}
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            <ClipboardCheck className="h-8 w-8 mx-auto mb-3 opacity-30" />
            Chưa có mã TRF nào cần kiểm tra.
          </CardContent>
        </Card>
      </div>
    )
  }

  // ── Staff / store_manager: flat list of their store's TRF ──────────────────
  if (!isAllStores) {
    return (
      <div className="p-4 space-y-4 max-w-xl mx-auto">
        {header}
        <Card>
          <CardContent className="p-0">
            {rows.map((r) => <TrfRow key={r.id} r={r} />)}
          </CardContent>
        </Card>
      </div>
    )
  }

  // ── Super / Cycle Count admin: grouped accordion by store ──────────────────
  const byStore = new Map<string, TrfTaskRow[]>()
  for (const r of rows) {
    const k = r.stores?.name ?? r.store_id ?? '—'
    if (!byStore.has(k)) byStore.set(k, [])
    byStore.get(k)!.push(r)
  }
  const groups = [...byStore.entries()].sort((a, b) => a[0].localeCompare(b[0], 'vi'))

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-3xl">
      {header}
      <p className="text-sm text-muted-foreground">{groups.length} cửa hàng · {rows.length} mã TRF</p>
      <Card>
        <CardContent className="p-0">
          {groups.map(([storeName, items], idx) => {
            const done = items.filter((r) => getEffectiveStatus(r.deadline, r.status) === 'done').length
            const allDone = done === items.length
            return (
              <details key={storeName} open={idx === 0} className="group border-b last:border-0">
                <summary className="flex items-center gap-2 px-4 py-3 cursor-pointer hover:bg-muted/30 list-none">
                  <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-90 shrink-0" />
                  <span className="font-medium text-sm flex-1 truncate">{storeName}</span>
                  <span className={cn(
                    'text-xs px-2 py-0.5 rounded font-medium shrink-0',
                    allDone ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700',
                  )}>
                    {done}/{items.length}
                  </span>
                </summary>
                <div className="bg-muted/10">
                  {items.map((r) => <TrfRow key={r.id} r={r} />)}
                </div>
              </details>
            )
          })}
        </CardContent>
      </Card>
    </div>
  )
}
