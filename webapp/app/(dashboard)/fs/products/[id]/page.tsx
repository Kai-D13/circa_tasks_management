import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { createClient } from '@/lib/supabase/server'
import { isSuperAdminEmail } from '@/lib/authz'
import { POLICY_DEPT_ID, FS_SESSION_STATUS, FS_ITEM_STATUS } from '@/lib/fs/constants'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { formatDate, formatDateTime } from '@/lib/dateUtils'
import { cn } from '@/lib/utils'
import { ChevronLeft, Settings2, ClipboardList } from 'lucide-react'

// Session detail (mirror of a KPI campaign detail): tabs Cấu hình (session
// metadata) + Kết quả (product/item list + progress). F3 extends Kết quả with
// per-item photos, per-box/bulk resubmit, and Excel export.

type Embed = { name?: string | null; code?: string | null }
function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null)
}
const dims = (l: number | null, w: number | null, h: number | null) =>
  l || w || h ? `${l ?? '—'} × ${w ?? '—'} × ${h ?? '—'} mm` : '—'

export default async function FsSessionDetailPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string }>
}) {
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  const isSuper = profile?.role === 'admin' && isSuperAdminEmail(user.email)
  const isPolicy = profile?.role === 'admin' && profile?.department_id === POLICY_DEPT_ID
  if (!isSuper && !isPolicy) redirect('/tasks')

  const { id } = await params
  const tab = (await searchParams).tab === 'config' ? 'config' : 'result'
  const supabase = await createClient()

  const { data: session, error: sErr } = await supabase
    .from('fs_sessions')
    .select('id, name, status, created_at, created_by, claimed_by, claimed_at, store:stores(name, code)')
    .eq('id', id).maybeSingle()
  if (sErr) console.error('[fs-session-detail] session query failed:', sErr.message)
  if (!session) notFound() // RLS-scoped: a non-authorized/absent session → 404

  const [{ data: items, error: iErr }, { data: run }, { data: people }] = await Promise.all([
    supabase.from('fs_session_items')
      .select('id, product_id, product_name, status, dim_length_mm, dim_width_mm, dim_height_mm, processed_by, processed_at, resubmit_note')
      .eq('session_id', id).order('created_at', { ascending: true }),
    supabase.from('fs_import_runs')
      .select('file_name, sheet_name, row_count, success_count, created_at')
      .eq('session_id', id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('users').select('id, full_name, email')
      .in('id', [session.created_by, session.claimed_by].filter(Boolean) as string[]),
  ])
  if (iErr) console.error('[fs-session-detail] items query failed:', iErr.message)

  const store = one<Embed>(session.store)
  const byId = new Map((people ?? []).map((u) => [u.id, u]))
  const creator = byId.get(session.created_by)
  const claimer = session.claimed_by ? byId.get(session.claimed_by) : null

  const all = items ?? []
  const done = all.filter((i) => i.status === 'done').length
  const redo = all.filter((i) => i.status === 'redo').length
  const pending = all.filter((i) => i.status === 'pending').length
  const total = all.length
  const pct = total > 0 ? Math.round((done / total) * 100) : 0

  const meta = FS_SESSION_STATUS[session.status] ?? { label: session.status, cls: 'bg-muted text-muted-foreground' }
  const tabCls = (active: boolean) =>
    cn('px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
      active ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')

  return (
    <div className="p-4 space-y-4 max-w-5xl">
      <Link href="/fs/products" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronLeft className="h-4 w-4" /> Danh sách phiên
      </Link>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{session.name}</h1>
        <Badge className={cn('text-[10px]', meta.cls)}>{meta.label}</Badge>
        <span className="text-sm text-muted-foreground">{store?.name}{store?.code ? ` · ${store.code}` : ''}</span>
      </div>

      {/* progress strip */}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <div className="flex items-center gap-2">
          <div className="h-2 w-40 rounded-full bg-muted overflow-hidden">
            <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
          </div>
          <span className="tabular-nums text-muted-foreground">{done}/{total} hoàn thành ({pct}%)</span>
        </div>
        {redo > 0 && <Badge className="bg-amber-100 text-amber-700 text-[10px]">Cần làm lại {redo}</Badge>}
        {pending > 0 && <Badge className="bg-muted text-muted-foreground text-[10px]">Chưa xử lý {pending}</Badge>}
      </div>

      <div className="flex border-b">
        <Link href={`/fs/products/${id}?tab=config`} className={tabCls(tab === 'config')}>
          <span className="inline-flex items-center gap-1.5"><Settings2 className="h-4 w-4" /> Cấu hình</span>
        </Link>
        <Link href={`/fs/products/${id}?tab=result`} className={tabCls(tab === 'result')}>
          <span className="inline-flex items-center gap-1.5"><ClipboardList className="h-4 w-4" /> Kết quả</span>
        </Link>
      </div>

      {tab === 'config' ? (
        <Card>
          <CardContent className="p-4">
            <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <Row k="Cửa hàng">{store?.name ?? '—'}{store?.code ? ` (${store.code})` : ''}</Row>
              <Row k="Trạng thái"><Badge className={cn('text-[10px]', meta.cls)}>{meta.label}</Badge></Row>
              <Row k="Người tạo">{creator?.full_name ?? '—'}{creator?.email ? <span className="text-muted-foreground"> ({creator.email})</span> : null}</Row>
              <Row k="Ngày tạo">{formatDateTime(session.created_at)}</Row>
              <Row k="File import">{run?.file_name ?? '—'}</Row>
              <Row k="Sheet">{run?.sheet_name ?? '—'}</Row>
              <Row k="Số sản phẩm">{total}{run && run.row_count !== run.success_count ? ` (nạp ${run.success_count}/${run.row_count})` : ''}</Row>
              <Row k="Người đang xử lý">
                {claimer ? `${claimer.full_name}${claimer.email ? ` (${claimer.email})` : ''}` : 'Chưa có ai nhận'}
                {session.claimed_at ? <span className="text-muted-foreground"> · từ {formatDateTime(session.claimed_at)}</span> : null}
              </Row>
            </dl>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr className="text-left text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium w-32">product_id</th>
                    <th className="px-4 py-2.5 font-medium">Tên sản phẩm</th>
                    <th className="px-4 py-2.5 font-medium">Kích thước (D×R×C)</th>
                    <th className="px-4 py-2.5 font-medium">Trạng thái</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {all.map((it) => {
                    const im = FS_ITEM_STATUS[it.status] ?? { label: it.status, cls: 'bg-muted text-muted-foreground' }
                    return (
                      <tr key={it.id}>
                        <td className="px-4 py-2.5 font-mono">{it.product_id}</td>
                        <td className="px-4 py-2.5">
                          {it.product_name}
                          {it.resubmit_note && <div className="text-xs text-amber-700 mt-0.5">Ghi chú làm lại: {it.resubmit_note}</div>}
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">{dims(it.dim_length_mm, it.dim_width_mm, it.dim_height_mm)}</td>
                        <td className="px-4 py-2.5"><Badge className={cn('text-[10px]', im.cls)}>{im.label}</Badge></td>
                      </tr>
                    )
                  })}
                  {all.length === 0 && (
                    <tr><td colSpan={4} className="text-center text-muted-foreground py-8">Phiên chưa có sản phẩm.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="px-4 py-3 text-xs text-muted-foreground border-t">
              Ảnh sản phẩm, yêu cầu làm lại từng box và xuất Excel sẽ có ở bước tiếp theo (F3/F4).
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{k}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  )
}
