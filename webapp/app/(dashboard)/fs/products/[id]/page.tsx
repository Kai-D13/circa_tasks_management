import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { getSessionProfile } from '@/lib/auth/getSessionProfile'
import { createClient } from '@/lib/supabase/server'
import { isSuperAdminEmail } from '@/lib/authz'
import { POLICY_DEPT_ID, FS_SESSION_STATUS } from '@/lib/fs/constants'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { formatDateTime } from '@/lib/dateUtils'
import { cn } from '@/lib/utils'
import { ChevronLeft, Settings2, ClipboardList, AlertTriangle } from 'lucide-react'
import { FsResultTab, type FsReviewItem } from '@/components/fs/FsResultTab'
import { FsExportButton } from '@/components/fs/FsExportButton'
import { FsReleaseClaimButton } from '@/components/fs/FsReleaseClaimButton'

// Session detail (mirror of a KPI campaign detail): tabs Cấu hình (session
// metadata) + Kết quả (interactive product review — search/filter/pagination,
// per-item photo boxes, per-box/bulk resubmit, close/cancel).

const PAGE_SIZE = 50
type Embed = { name?: string | null; code?: string | null }
function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null)
}

export default async function FsSessionDetailPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string; q?: string; status?: string; page?: string }>
}) {
  const { user, profile } = await getSessionProfile()
  if (!user) redirect('/login')
  const isSuper = profile?.role === 'admin' && isSuperAdminEmail(user.email)
  const isPolicy = profile?.role === 'admin' && profile?.department_id === POLICY_DEPT_ID
  if (!isSuper && !isPolicy) redirect('/tasks')

  const { id } = await params
  const sp = await searchParams
  const tab = sp.tab === 'config' ? 'config' : 'result'
  const q = (sp.q ?? '').trim()
  const statusFilter = ['pending', 'done', 'redo', 'approved'].includes(sp.status ?? '') ? (sp.status as string) : ''
  const pageNum = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1)
  const supabase = await createClient()

  const { data: session, error: sErr } = await supabase
    .from('fs_sessions')
    .select('id, name, status, created_at, created_by, claimed_by, claimed_at, store:stores(name, code)')
    .eq('id', id).maybeSingle()
  if (sErr) console.error('[fs-session-detail] session query failed:', sErr.message)
  if (!session) {
    if (!sErr) notFound() // RLS-scoped: a non-authorized/absent session → 404
    return (
      <div className="p-4 space-y-4">
        <Link href="/fs/products" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-4 w-4" /> Danh sách phiên
        </Link>
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>Lỗi tải phiên: {sErr.message}</span>
        </div>
      </div>
    )
  }

  // Counts (all items, status only) for the progress strip + Cấu hình total.
  const [{ data: statusRows, error: cErr }, { data: run, error: rErr }, { data: people, error: pErr }] = await Promise.all([
    supabase.from('fs_session_items').select('status, approved_at').eq('session_id', id).is('removed_at', null),
    supabase.from('fs_import_runs')
      .select('file_name, sheet_name, row_count, success_count, created_at')
      .eq('session_id', id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('users').select('id, full_name, email')
      .in('id', [session.created_by, session.claimed_by].filter(Boolean) as string[]),
  ])

  // Result tab: filtered + paginated page of items + their photos.
  let reviewItems: FsReviewItem[] = []
  let filteredCount = 0
  let iErr: string | null = null
  if (tab === 'result') {
    let iq = supabase.from('fs_session_items')
      .select('id, product_id, product_name, status, dim_length_mm, dim_width_mm, dim_height_mm, resubmit_note, approved_at', { count: 'exact' })
      .eq('session_id', id).is('removed_at', null)
    if (statusFilter === 'approved') iq = iq.not('approved_at', 'is', null)
    // "Hoàn thành" = the QC queue: done but NOT yet approved (an approved item
    // keeps status='done', so without this it leaked into both tabs —
    // stakeholder 2026-07-13).
    else if (statusFilter === 'done') iq = iq.eq('status', 'done').is('approved_at', null)
    else if (statusFilter) iq = iq.eq('status', statusFilter)
    if (q) {
      const safe = q.replace(/[,()*%]/g, '').slice(0, 80) // strip PostgREST filter metachars
      if (safe) iq = iq.or(`product_id.ilike.%${safe}%,product_name.ilike.%${safe}%`)
    }
    const { data: pageItems, count, error } = await iq
      .order('created_at', { ascending: true })
      .range((pageNum - 1) * PAGE_SIZE, pageNum * PAGE_SIZE - 1)
    iErr = error?.message ?? null
    filteredCount = count ?? 0
    const ids = (pageItems ?? []).map((i) => i.id)
    const { data: photos } = ids.length
      ? await supabase.from('fs_item_photos').select('item_id, box_key, storage_path, status, resubmit_note').in('item_id', ids)
      : { data: [] as { item_id: string; box_key: number; storage_path: string; status: string; resubmit_note: string | null }[] }
    reviewItems = (pageItems ?? []).map((it) => ({
      ...it,
      photos: (photos ?? []).filter((p) => p.item_id === it.id)
        .map((p) => ({ box_key: p.box_key, storage_path: p.storage_path, status: p.status, resubmit_note: p.resubmit_note })),
    })) as FsReviewItem[]
  }

  const queryError = cErr?.message ?? rErr?.message ?? pErr?.message ?? iErr ?? null
  if (queryError) console.error('[fs-session-detail] query failed:', queryError)

  const store = one<Embed>(session.store)
  const byId = new Map((people ?? []).map((u) => [u.id, u]))
  const creator = byId.get(session.created_by)
  const claimer = session.claimed_by ? byId.get(session.claimed_by) : null

  const rows = (statusRows ?? []) as { status: string; approved_at: string | null }[]
  const total = rows.length
  const done = rows.filter((r) => r.status === 'done').length
  const redo = rows.filter((r) => r.status === 'redo').length
  const pending = rows.filter((r) => r.status === 'pending').length
  const approved = rows.filter((r) => r.approved_at != null).length
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  const isActive = session.status === 'active'
  // Session can be finalised only when every active item is done AND approved —
  // mirrors the DB guard in rpc_fs_close_session (Batch E).
  const canComplete = total > 0 && pending === 0 && redo === 0 && approved === total

  const meta = FS_SESSION_STATUS[session.status] ?? { label: session.status, cls: 'bg-muted text-muted-foreground' }
  const tabCls = (active: boolean) =>
    cn('px-3.5 py-1.5 rounded-md text-sm font-medium transition-colors',
      active ? 'bg-background text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground')

  return (
    <div className="p-4 space-y-4">
      <Link href="/fs/products" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronLeft className="h-4 w-4" /> Danh sách phiên
      </Link>

      {queryError && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>Lỗi tải dữ liệu phiên: {queryError}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{session.name}</h1>
        <Badge className={cn('text-[10px]', meta.cls)}>{meta.label}</Badge>
        <span className="text-sm text-muted-foreground">{store?.name}{store?.code ? ` · ${store.code}` : ''}</span>
        <div className="ml-auto"><FsExportButton sessionId={id} /></div>
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
        {/* QC queue = done but not yet approved (mirrors the "Hoàn thành" tab) */}
        {done - approved > 0 && <Badge className="bg-sky-100 text-sky-700 text-[10px]">Chờ duyệt {done - approved}</Badge>}
        <Badge className="bg-green-100 text-green-700 text-[10px]">Đã duyệt {approved}/{total}</Badge>
      </div>

      <div className="inline-flex rounded-lg border bg-muted/40 p-1 gap-1">
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
            <div className="grid sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <Row k="Cửa hàng">{store?.name ?? '—'}{store?.code ? ` (${store.code})` : ''}</Row>
              <Row k="Trạng thái"><Badge className={cn('text-[10px]', meta.cls)}>{meta.label}</Badge></Row>
              <Row k="Người tạo">{creator?.full_name ?? '—'}{creator?.email ? <span className="text-muted-foreground"> ({creator.email})</span> : null}</Row>
              <Row k="Ngày tạo">{formatDateTime(session.created_at)}</Row>
              <Row k="File import">{run?.file_name ?? '—'}</Row>
              <Row k="Sheet">{run?.sheet_name ?? '—'}</Row>
              <Row k="Số sản phẩm">{total}{run && run.row_count !== run.success_count ? ` (nạp ${run.success_count}/${run.row_count})` : ''}</Row>
              <Row k="Người đang xử lý">
                <span className="inline-flex flex-wrap items-center gap-2">
                  <span>
                    {claimer ? `${claimer.full_name}${claimer.email ? ` (${claimer.email})` : ''}` : 'Chưa có ai nhận'}
                    {session.claimed_at ? <span className="text-muted-foreground"> · từ {formatDateTime(session.claimed_at)}</span> : null}
                  </span>
                  {session.claimed_by && isActive && <FsReleaseClaimButton sessionId={id} />}
                </span>
              </Row>
            </div>
          </CardContent>
        </Card>
      ) : (
        <FsResultTab
          sessionId={id}
          isActive={isActive}
          canComplete={canComplete}
          items={reviewItems}
          page={pageNum}
          totalPages={Math.max(1, Math.ceil(filteredCount / PAGE_SIZE))}
          filteredCount={filteredCount}
          q={q}
          status={statusFilter}
        />
      )}
    </div>
  )
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{k}</span>
      <span className="font-medium">{children}</span>
    </div>
  )
}
