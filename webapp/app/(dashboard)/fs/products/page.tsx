import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { createClient } from '@/lib/supabase/server'
import { isSuperAdminEmail } from '@/lib/authz'
import { POLICY_DEPT_ID, FS_SESSION_STATUS } from '@/lib/fs/constants'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { formatDate } from '@/lib/dateUtils'
import { cn } from '@/lib/utils'
import { Boxes, Plus, ChevronRight, AlertTriangle } from 'lucide-react'

// Landing = session list + overview (mirror of the KPI Campaign dashboard IA):
// summary cards + one row per session → click into /fs/products/[id]. Creating a
// session lives at /fs/products/new. Progress is done/total; redo shown apart
// (a redo item is NOT counted complete — stakeholder decision).

type StoreEmbed = { name?: string | null; code?: string | null }
function storeName(s: { store?: StoreEmbed | StoreEmbed[] | null }): string {
  const st = Array.isArray(s.store) ? s.store[0] : s.store
  return st?.name ?? '—'
}

export default async function FsProductsPage() {
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')

  const isSuper = profile?.role === 'admin' && isSuperAdminEmail(user.email)
  const isPolicy = profile?.role === 'admin' && profile?.department_id === POLICY_DEPT_ID
  const isAdmin = isSuper || isPolicy

  const supabase = await createClient()

  // FS store staff/manager also land here — but only if their store is an FS
  // store (an OS-store user must never reach the FS module). RLS then scopes the
  // session list to their store; their rows link to the processing wizard.
  let isFsStaff = false
  if (!isAdmin && (profile?.role === 'staff' || profile?.role === 'store_manager') && profile?.store_id) {
    const { data: st } = await supabase.from('stores').select('store_type').eq('id', profile.store_id).maybeSingle()
    isFsStaff = st?.store_type === 'fs'
  }
  if (!isAdmin && !isFsStaff) redirect('/tasks')

  const { data: sessions, error: sessionsErr } = await supabase
    .from('fs_sessions')
    .select('id, name, status, created_at, created_by, store:stores(name, code)')
    .order('created_at', { ascending: false })

  const sessionIds = (sessions ?? []).map((s) => s.id)
  const [{ data: items, error: itemsErr }, { data: creators, error: creatorsErr }] = await Promise.all([
    sessionIds.length
      ? supabase.from('fs_session_items').select('session_id, status').in('session_id', sessionIds)
      : Promise.resolve({ data: [] as { session_id: string; status: string }[], error: null }),
    // fs_sessions has TWO user FKs (created_by/claimed_by) → bare users(...) embed
    // is ambiguous; resolve creators by id instead.
    sessionIds.length
      ? supabase.from('users').select('id, full_name, email')
          .in('id', [...new Set((sessions ?? []).map((s) => s.created_by).filter(Boolean))] as string[])
      : Promise.resolve({ data: [] as { id: string; full_name: string; email: string }[], error: null }),
  ])

  const queryError = sessionsErr?.message ?? itemsErr?.message ?? creatorsErr?.message ?? null
  if (queryError) console.error('[fs-products] query failed:', queryError)

  const creator = new Map((creators ?? []).map((u) => [u.id, u]))
  const counts = new Map<string, { total: number; done: number; redo: number; pending: number }>()
  for (const it of items ?? []) {
    const c = counts.get(it.session_id) ?? { total: 0, done: 0, redo: 0, pending: 0 }
    c.total++
    if (it.status === 'done') c.done++
    else if (it.status === 'redo') c.redo++
    else c.pending++
    counts.set(it.session_id, c)
  }

  const list = sessions ?? []
  const total = list.length
  const activeN = list.filter((s) => s.status === 'active').length
  const completedN = list.filter((s) => s.status === 'completed').length
  const redoN = list.filter((s) => (counts.get(s.id)?.redo ?? 0) > 0).length

  const summary = [
    { label: 'Tổng phiên', value: total, cls: 'text-foreground' },
    { label: 'Đang xử lý', value: activeN, cls: 'text-sky-600' },
    { label: 'Hoàn thành', value: completedN, cls: 'text-green-600' },
    { label: 'Cần làm lại', value: redoN, cls: 'text-amber-600' },
  ]

  return (
    <div className="p-4 space-y-4 max-w-5xl">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Boxes className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold">Quản lý FS · Sản phẩm</h1>
        </div>
        {isAdmin && (
          <Link href="/fs/products/new" className={cn(buttonVariants({ size: 'sm' }), 'gap-1.5')}>
            <Plus className="h-4 w-4" /> Tạo phiên
          </Link>
        )}
      </div>

      {queryError && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>Lỗi tải dữ liệu: {queryError}</span>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {summary.map((c) => (
          <Card key={c.label}>
            <CardContent className="p-3">
              <p className="text-xs text-muted-foreground">{c.label}</p>
              <p className={cn('text-2xl font-semibold tabular-nums', c.cls)}>{c.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          {list.length === 0 && !queryError ? (
            <div className="text-center text-muted-foreground py-10 text-sm">
              {isAdmin ? <>Chưa có phiên nào. Bấm <b>Tạo phiên</b> để nhập sản phẩm từ file.</> : 'Cửa hàng chưa có danh sách sản phẩm cần bổ sung.'}
            </div>
          ) : (
            <div className="divide-y">
              {list.map((s) => {
                const c = counts.get(s.id) ?? { total: 0, done: 0, redo: 0, pending: 0 }
                const pct = c.total > 0 ? Math.round((c.done / c.total) * 100) : 0
                const meta = FS_SESSION_STATUS[s.status] ?? { label: s.status, cls: 'bg-muted text-muted-foreground' }
                const u = creator.get(s.created_by)
                return (
                  <Link
                    key={s.id}
                    href={isAdmin ? `/fs/products/${s.id}` : `/fs/products/${s.id}/process`}
                    prefetch={false}
                    className="flex items-center gap-4 px-4 py-3 hover:bg-muted/40 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{s.name}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {storeName(s)} · {u?.full_name ?? '—'}{u?.email ? ` (${u.email})` : ''} · {formatDate(s.created_at)}
                      </div>
                    </div>
                    <div className="hidden sm:flex items-center gap-2 w-40 shrink-0">
                      <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
                        <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-xs text-muted-foreground tabular-nums">{c.done}/{c.total}</span>
                    </div>
                    {c.redo > 0 && <span className="hidden sm:inline text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 shrink-0">Làm lại {c.redo}</span>}
                    <Badge className={cn('text-[10px] shrink-0', meta.cls)}>{meta.label}</Badge>
                    <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                  </Link>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
