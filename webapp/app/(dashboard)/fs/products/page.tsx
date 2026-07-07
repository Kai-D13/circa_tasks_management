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
import { Boxes, ClipboardList, PackagePlus, CheckCircle2, AlertTriangle } from 'lucide-react'

// Landing for the FS "Sản phẩm" feature — Policy/super only in F2 (the FS
// store staff/manager wizard lands here in F4/F5). Two tabs: Tạo phiên (import)
// and Kết quả (session list). Progress is done/total (redo shown separately —
// a redo item is NOT counted as complete, stakeholder decision).

const STATUS_META: Record<string, { label: string; cls: string }> = {
  active:    { label: 'Đang xử lý', cls: 'bg-sky-100 text-sky-700' },
  completed: { label: 'Hoàn thành', cls: 'bg-green-100 text-green-700' },
  cancelled: { label: 'Đã huỷ',    cls: 'bg-muted text-muted-foreground' },
}

type StoreEmbed = { name?: string | null; code?: string | null }
function storeName(s: { store?: StoreEmbed | StoreEmbed[] | null }): string {
  const st = Array.isArray(s.store) ? s.store[0] : s.store
  return st?.name ?? '—'
}

export default async function FsProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; session?: string; created?: string }>
}) {
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')

  const isSuper = profile?.role === 'admin' && isSuperAdminEmail(user.email)
  const isPolicy = profile?.role === 'admin' && profile?.department_id === POLICY_DEPT_ID
  if (!isSuper && !isPolicy) redirect('/tasks')

  const params = await searchParams
  const tab = params.tab === 'result' ? 'result' : 'create'
  const newSessionId = params.session || null
  const createdCount = params.created && /^\d+$/.test(params.created) ? Number(params.created) : null

  const supabase = await createClient()

  // FS store list (for the import store picker).
  const { data: fsStores, error: storesErr } = await supabase
    .from('stores').select('id, name, code')
    .eq('store_type', 'fs').eq('is_active', true).order('name')

  // Sessions + item status for progress (RLS: super/Policy see all FS sessions).
  const { data: sessions, error: sessionsErr } = await supabase
    .from('fs_sessions')
    .select('id, name, status, created_at, created_by, claimed_by, store:stores(name, code)')
    .order('created_at', { ascending: false })

  const sessionIds = (sessions ?? []).map((s) => s.id)
  const [{ data: items, error: itemsErr }, { data: creators, error: creatorsErr }] = await Promise.all([
    sessionIds.length
      ? supabase.from('fs_session_items').select('session_id, status').in('session_id', sessionIds)
      : Promise.resolve({ data: [] as { session_id: string; status: string }[], error: null }),
    // Fetch creators by id (fs_sessions has TWO FKs to users — created_by AND
    // claimed_by — so a bare users(...) embed is ambiguous; a keyed lookup avoids it).
    sessionIds.length
      ? supabase.from('users').select('id, full_name').in('id', [...new Set((sessions ?? []).map((s) => s.created_by).filter(Boolean))] as string[])
      : Promise.resolve({ data: [] as { id: string; full_name: string }[], error: null }),
  ])

  // A failed query must NOT silently render as an empty list on an important
  // module — surface it (mirrors the campaigns list posture).
  const queryError = storesErr?.message ?? sessionsErr?.message ?? itemsErr?.message ?? creatorsErr?.message ?? null
  if (queryError) console.error('[fs-products] query failed:', queryError)

  const creatorName = new Map((creators ?? []).map((u) => [u.id, u.full_name]))
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

      {queryError && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>Lỗi tải dữ liệu: {queryError}</span>
        </div>
      )}

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
        <div className="space-y-3">
          {newSessionId && (
            <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700 flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>Đã tạo phiên mới{createdCount !== null ? ` · ${createdCount} sản phẩm` : ''}.</span>
            </div>
          )}
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40">
                    <tr className="text-left text-muted-foreground">
                      <th className="px-4 py-2.5 font-medium">Phiên</th>
                      <th className="px-4 py-2.5 font-medium">Cửa hàng</th>
                      <th className="px-4 py-2.5 font-medium">Người tạo</th>
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
                      const isNew = s.id === newSessionId
                      return (
                        <tr key={s.id} className={cn(isNew && 'bg-green-50/60')}>
                          <td className="px-4 py-2.5 font-medium">
                            <span className="inline-flex items-center gap-2">
                              {s.name}
                              {isNew && <Badge className="bg-green-100 text-green-700 text-[10px]">Mới tạo</Badge>}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-muted-foreground">{storeName(s)}</td>
                          <td className="px-4 py-2.5 text-muted-foreground">{creatorName.get(s.created_by) ?? '—'}</td>
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
                    {(sessions ?? []).length === 0 && !queryError && (
                      <tr><td colSpan={6} className="text-center text-muted-foreground py-8">Chưa có phiên nào. Sang tab “Tạo phiên” để nhập sản phẩm.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
