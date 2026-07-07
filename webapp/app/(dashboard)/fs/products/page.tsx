import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { createClient } from '@/lib/supabase/server'
import { isSuperAdminEmail } from '@/lib/authz'
import { POLICY_DEPT_ID } from '@/lib/fs/constants'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { formatDate } from '@/lib/dateUtils'
import { cn } from '@/lib/utils'
import { FsImportWizard } from '@/components/fs/FsImportWizard'
import { Boxes, ClipboardList, PackagePlus } from 'lucide-react'

// Landing for the FS "Sản phẩm" feature — Policy/super only in F2 (the FS
// store staff/manager wizard lands here in F4/F5). Two tabs: Tạo phiên (import)
// and Kết quả (session list). Progress is done/total (redo shown separately —
// a redo item is NOT counted as complete, stakeholder decision).

const STATUS_META: Record<string, { label: string; cls: string }> = {
  active:    { label: 'Đang xử lý', cls: 'bg-sky-100 text-sky-700' },
  completed: { label: 'Hoàn thành', cls: 'bg-green-100 text-green-700' },
  cancelled: { label: 'Đã huỷ',    cls: 'bg-muted text-muted-foreground' },
}

function storeName(s: { store?: { name?: string | null; code?: string | null } | { name?: string | null; code?: string | null }[] | null }): string {
  const st = Array.isArray(s.store) ? s.store[0] : s.store
  return st?.name ?? '—'
}

export default async function FsProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>
}) {
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')

  const isSuper = profile?.role === 'admin' && isSuperAdminEmail(user.email)
  const isPolicy = profile?.role === 'admin' && profile?.department_id === POLICY_DEPT_ID
  if (!isSuper && !isPolicy) redirect('/tasks')

  const params = await searchParams
  const tab = params.tab === 'result' ? 'result' : 'create'

  const supabase = await createClient()

  // FS store list (for the import store picker).
  const { data: fsStores } = await supabase
    .from('stores').select('id, name, code')
    .eq('store_type', 'fs').eq('is_active', true).order('name')

  // Sessions + item status for progress (RLS: super/Policy see all FS sessions).
  const { data: sessions } = await supabase
    .from('fs_sessions')
    .select('id, name, status, created_at, claimed_by, store:stores(name, code)')
    .order('created_at', { ascending: false })

  const sessionIds = (sessions ?? []).map((s) => s.id)
  const { data: items } = sessionIds.length
    ? await supabase.from('fs_session_items').select('session_id, status').in('session_id', sessionIds)
    : { data: [] as { session_id: string; status: string }[] }

  const counts = new Map<string, { total: number; done: number; redo: number; pending: number }>()
  for (const it of items ?? []) {
    const c = counts.get(it.session_id) ?? { total: 0, done: 0, redo: 0, pending: 0 }
    c.total++
    if (it.status === 'done') c.done++
    else if (it.status === 'redo') c.redo++
    else c.pending++
    counts.set(it.session_id, c)
  }

  const tabCls = (active: boolean) =>
    cn('px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
      active ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')

  return (
    <div className="p-4 space-y-4 max-w-5xl">
      <div className="flex items-center gap-2">
        <Boxes className="h-5 w-5 text-primary" />
        <h1 className="text-xl font-semibold">Quản lý FS · Sản phẩm</h1>
      </div>

      <div className="flex border-b">
        <Link href="/fs/products?tab=create" className={tabCls(tab === 'create')}>
          <span className="inline-flex items-center gap-1.5"><PackagePlus className="h-4 w-4" /> Tạo phiên</span>
        </Link>
        <Link href="/fs/products?tab=result" className={tabCls(tab === 'result')}>
          <span className="inline-flex items-center gap-1.5"><ClipboardList className="h-4 w-4" /> Kết quả</span>
        </Link>
      </div>

      {tab === 'create' ? (
        <Card>
          <CardContent className="p-4">
            <FsImportWizard fsStores={fsStores ?? []} />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr className="text-left text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">Phiên</th>
                    <th className="px-4 py-2.5 font-medium">Cửa hàng</th>
                    <th className="px-4 py-2.5 font-medium">Trạng thái</th>
                    <th className="px-4 py-2.5 font-medium">Tiến độ (hoàn thành / tổng)</th>
                    <th className="px-4 py-2.5 font-medium">Ngày tạo</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {(sessions ?? []).map((s) => {
                    const c = counts.get(s.id) ?? { total: 0, done: 0, redo: 0, pending: 0 }
                    const pct = c.total > 0 ? Math.round((c.done / c.total) * 100) : 0
                    const meta = STATUS_META[s.status] ?? { label: s.status, cls: 'bg-muted text-muted-foreground' }
                    return (
                      <tr key={s.id}>
                        <td className="px-4 py-2.5 font-medium">{s.name}</td>
                        <td className="px-4 py-2.5 text-muted-foreground">{storeName(s)}</td>
                        <td className="px-4 py-2.5"><Badge className={cn('text-[10px]', meta.cls)}>{meta.label}</Badge></td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 w-24 rounded-full bg-muted overflow-hidden">
                              <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                            </div>
                            <span className="text-xs text-muted-foreground tabular-nums">{c.done}/{c.total}</span>
                            {c.redo > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">Làm lại {c.redo}</span>}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">{formatDate(s.created_at)}</td>
                      </tr>
                    )
                  })}
                  {(sessions ?? []).length === 0 && (
                    <tr><td colSpan={5} className="text-center text-muted-foreground py-8">Chưa có phiên nào. Sang tab “Tạo phiên” để nhập sản phẩm.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
