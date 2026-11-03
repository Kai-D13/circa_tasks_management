import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { redirectIfFsStaff } from '@/lib/fs/isolation'
import { isCmsEarningsEnabled } from '@/lib/cms/flags'
import { cmsLoadHistoryPrograms, cmsLoadProgramProducts, cmsLoadResults } from '@/lib/cms/server/resultLoad'
import { cmsLoadResultLines } from '@/lib/cms/server/results'
import { CMS_Q206_RETURNS_CONTRACT } from '@/lib/cms/releaseGate'
import { cmsTodayVn } from '@/lib/cms/programStatus'
import { cmsParseHistoryParams, type CmsResultsLoad } from '@/lib/cms/resultUi'
import { ErrorState } from '@/components/ds/ErrorState'
import { CmsStaffHistoryView, type CmsHistoryLines } from '@/components/cms/staff/CmsStaffHistoryView'

// CMS P2-c (I3) · D3 /targets/cms/history?program=&product=&run=&after=&n= — staff / QLCH (cổng như /targets: đăng nhập,
// FS ⇒ module FS). Cần CẢ cờ CMS_PROGRAM_ENABLED + CMS_EARNINGS_ENABLED (isCmsEarningsEnabled) — OFF ⇒ 404, không query.
// Phạm vi: chương trình active đã bắt đầu đọc được qua RLS 120 (gồm Chờ chốt kỳ); dòng qua RPC 122 (staff = mình, QLCH = staff
// hiện thuộc nhà thuốc). `run` ghim phiên: khác run hiện hành / đã dọn ⇒ "dữ liệu đã thay đổi" (không nối hai phiên).
export default async function CmsStaffHistoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const { data: profile } = await supabase.from('users').select('role, store_id').eq('id', user.id).single()
  await redirectIfFsStaff(supabase, profile)
  if (!isCmsEarningsEnabled()) notFound()
  if (!(profile?.role === 'staff' || profile?.role === 'store_manager')) notFound()
  const manager = profile.role === 'store_manager'
  const today = cmsTodayVn(new Date())
  const params = cmsParseHistoryParams(sp)
  const returnsApproved = CMS_Q206_RETURNS_CONTRACT === 'APPROVED'
  const empty = { programs: [], selected: null, products: [], results: { kind: 'off' } as CmsResultsLoad, lines: { kind: 'none' } as CmsHistoryLines, userNames: new Map<string, string>() }
  const base = { params, manager, today, returnsApproved }
  if (!profile.store_id) return <CmsStaffHistoryView {...empty} {...base} />

  const progs = await cmsLoadHistoryPrograms(today)
  if (!progs.ok) {
    return (
      <div data-ui-v2="page" data-layout-width="centered" className="mx-auto max-w-2xl p-4">
        <ErrorState message="Không tải được chương trình CMS" hint="Thử tải lại trang." />
      </div>
    )
  }
  const selected = progs.data.find((p) => p.id === params.programId) ?? progs.data[0] ?? null
  if (!selected) return <CmsStaffHistoryView {...empty} {...base} programs={progs.data} />

  const [productsRes, results] = await Promise.all([cmsLoadProgramProducts(selected.id), cmsLoadResults(selected.id, { started: true })])
  const products = productsRes.ok ? productsRes.data : null
  const productId = params.productId && products?.some((p) => p.id === params.productId) ? params.productId : null
  const p = { ...base, params: { ...params, programId: selected.id, productId } }

  let lines: CmsHistoryLines = { kind: 'none' }
  const run = results.kind === 'loaded' ? results.header.run : null
  if (run && products) {
    if (params.run && params.run !== run.id) lines = { kind: 'stale' }
    else {
      const r = await cmsLoadResultLines({
        programId: selected.id, runId: run.id, programProductId: productId, userId: manager ? null : user.id,
        afterSeq: params.after, limit: params.n,
      })
      lines = r.ok && r.data.runId === run.id ? { kind: 'ok', rows: r.data.rows, nextAfterSeq: r.data.nextAfterSeq }
        : !r.ok && r.error === 'RUN_GONE' ? { kind: 'stale' } : { kind: 'error' }
    }
  }
  const userNames = new Map(results.kind === 'loaded' ? results.rows.users.map((u) => [u.id, u.fullName] as const) : [])
  return <CmsStaffHistoryView {...p} programs={progs.data} selected={selected} products={products} results={results} lines={lines} userNames={userNames} />
}
