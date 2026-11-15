import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { Panel } from '@/components/ds/Panel'
import { Notice } from '@/components/ds/Notice'
import { StatusBadge, type StatusTone } from '@/components/ds/StatusBadge'
import { EmptyState } from '@/components/ds/EmptyState'
import { DataTableShell } from '@/components/ds/DataTableShell'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { CmsConfirmRestoredForm } from '@/components/cms/admin/CmsConfirmRestoredForm'
import { cmsDateTime, cmsVnd } from '@/lib/cms/display'
import { formatCmsDecimal, parseCmsDecimal } from '@/lib/cms/decimal'
import { CMS_RETURNS_POLICY_LABEL } from '@/lib/cms/calc/basisUi'
import { cmsNavHref, type CmsNav } from '@/lib/cms/fixtureNav'
import {
  CMS_CLOSE_REPORT_NOTE, CMS_LEDGER_VERDICT_LABEL, CMS_OBSERVATION_LABEL,
  type CmsCloseReportSummary, type CmsReturnConflictsDto,
} from '@/lib/cms/returnsView'

// CMS-CALC-RET-2 P5.5 — trang super "Trả hàng" của một chương trình CMS (/targets/campaigns/cms/[id]/returns). Hai khối:
//  · Đối soát nguồn trả: chính sách, lần kiểm sổ mới nhất, conflict mở (baseline đã nhận ↔ quan sát mới nhất), lịch sử xác nhận. Nút
//    "Xác nhận nguồn đã phục hồi" CHỈ khi DB trả proof. Không có nút nhận số mới / sửa tiền.
//  · Báo cáo sau chốt (chương trình đã chốt): danh sách báo cáo tham khảo, không phải lệnh thu / chi.

const VERDICT_TONE: Record<string, StatusTone> = { CLEAN: 'success', MISMATCH: 'danger', OPEN_CONFLICT_MATCH: 'warning' }
const dec = (v: string) => { const r = parseCmsDecimal(v, { allowNegative: true }); return r.ok ? formatCmsDecimal(r.units).replace('.', ',') : '—' }
const vndDec = (v: string) => { const r = parseCmsDecimal(v, { allowNegative: true }); return r.ok ? cmsVnd(r.units / BigInt(1_000_000_000)) : '—' }

export function CmsReturnsAdminView({ program, conflicts, reports, confirm, nav }: {
  program: { id: string; name: string; status: string }
  conflicts: { ok: true; data: CmsReturnConflictsDto } | { ok: false }
  reports: { ok: true; data: CmsCloseReportSummary[] } | { ok: false } | null
  /** idem sinh ở server lúc render + lý do khoá nút (cờ returns OFF / server QA). */
  confirm: { idem: string; disabledReason: string | null }
  /** Fixture /ui-catalog: link CMS ở lại catalog (mặc định href thật). */
  nav?: CmsNav
}) {
  const c = conflicts.ok ? conflicts.data : null
  const href = (h: string) => cmsNavHref(nav, h)
  return (
    <div data-ui-v2="page" data-layout-width="centered" data-cms-returns-admin className="mx-auto max-w-4xl space-y-4 p-4 md:p-6">
      <Link href={href(`/targets/campaigns/cms/${program.id}`)} className="inline-flex min-h-[44px] items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> {program.name}
      </Link>
      <h1 className="text-[20px] font-bold leading-snug">Trả hàng</h1>

      <Panel title="Đối soát nguồn trả" className="v2:rounded-v2-panel">
        {!c ? (
          <Notice tone="danger" role="alert" title="Không tải được đối soát">Thử tải lại trang.</Notice>
        ) : (
          <div className="space-y-3" data-cms-conflicts={c.openCount}>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
              <dt className="text-muted-foreground">Chính sách trả</dt>
              <dd>{CMS_RETURNS_POLICY_LABEL[c.returnsPolicy as keyof typeof CMS_RETURNS_POLICY_LABEL] ?? c.returnsPolicy}</dd>
              <dt className="text-muted-foreground">Phiếu đã nhận (baseline)</dt>
              <dd className="tabular-nums">{c.baselines.toLocaleString('vi-VN')}</dd>
              <dt className="text-muted-foreground">Lần kiểm sổ mới nhất</dt>
              <dd className="flex flex-wrap items-center gap-1.5">
                {c.latestEval ? (
                  <>
                    <span data-cms-ledger-verdict={c.latestEval.verdict}>
                      <StatusBadge tone={VERDICT_TONE[c.latestEval.verdict] ?? 'neutral'} size="sm">{CMS_LEDGER_VERDICT_LABEL[c.latestEval.verdict] ?? c.latestEval.verdict}</StatusBadge>
                    </span>
                    <span className="tabular-nums text-muted-foreground">#{c.latestEval.evalSeq} · {c.latestEval.kind === 'report' ? 'báo cáo sau chốt' : 'lượt tính'} · {cmsDateTime(c.latestEval.evaluatedAt)}</span>
                  </>
                ) : <span className="text-muted-foreground">Chưa có</span>}
              </dd>
              <dt className="text-muted-foreground">Conflict mở</dt>
              <dd className="tabular-nums">{c.openCount.toLocaleString('vi-VN')}{c.openTruncated ? ' (hiện 500 phiếu đầu)' : ''}</dd>
            </dl>

            {c.openCount > 0 && !c.proof && (
              <Notice tone="warning" role="status" title="Đang giữ số liệu cũ">
                Có phiếu trả đã nhận bị mất / đổi / chuyển chưa hiệu lực ở nguồn. Lượt tính và báo cáo mới bị giữ cho tới khi nguồn khớp lại đúng
                baseline — xử lý ở nguồn (BI), hệ thống tự kiểm lại ở lượt sau.
              </Notice>
            )}
            {c.proof && (
              <Notice tone="info" role="status" title="Nguồn đã khớp lại baseline">
                <span className="block">Lần kiểm #{c.proof.evalSeq} thấy mọi phiếu conflict khớp lại đúng nội dung đã nhận. Super xác nhận để đóng conflict.</span>
                <span className="mt-2 block">
                  <CmsConfirmRestoredForm programId={program.id} proof={c.proof} idem={confirm.idem} disabledReason={confirm.disabledReason} openCount={c.openCount} />
                </span>
              </Notice>
            )}

            {c.open.length > 0 ? (
              <DataTableShell>
                <Table aria-label="Conflict trả hàng đang mở">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Phiếu</TableHead>
                      <TableHead>Lý do mở</TableHead>
                      <TableHead className="text-right">Baseline (SL cơ sở · tiền)</TableHead>
                      <TableHead>Quan sát mới nhất</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {c.open.map((x) => {
                      const last = x.observations[0]
                      return (
                        <TableRow key={x.conflictId} data-cms-conflict={x.openedKind}>
                          <TableCell className="max-w-[180px] truncate font-medium" title={x.returnEventId}>{x.returnEventId}</TableCell>
                          <TableCell>{CMS_OBSERVATION_LABEL[x.openedKind] ?? x.openedKind}<span className="block text-[12px] text-muted-foreground tabular-nums">{cmsDateTime(x.openedAt)}</span></TableCell>
                          <TableCell className="text-right tabular-nums">{dec(x.baseline.baseQuantity)} · {vndDec(x.baseline.refundAmount)}<span className="block text-[12px] text-muted-foreground">SP {x.baseline.productId ?? '—'}</span></TableCell>
                          <TableCell>
                            {last ? (
                              <>
                                <StatusBadge tone={last.verdict === 'MATCH' ? 'success' : 'warning'} size="sm">{CMS_OBSERVATION_LABEL[last.verdict] ?? last.verdict}</StatusBadge>
                                <span className="block text-[12px] text-muted-foreground tabular-nums">#{last.evalSeq} · {cmsDateTime(last.observedAt)}</span>
                              </>
                            ) : '—'}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </DataTableShell>
            ) : (
              <p className="text-[13px] text-muted-foreground">Không có conflict mở.</p>
            )}

            {c.restorations.length > 0 && (
              <div className="space-y-1">
                <h3 className="text-[13px] font-semibold">Lịch sử xác nhận phục hồi</h3>
                <ul className="divide-y text-[13px]" data-cms-restorations>
                  {c.restorations.map((r) => (
                    <li key={r.id} className="py-2">
                      <span className="tabular-nums">{cmsDateTime(r.confirmedAt)} · lần kiểm #{r.proofEvalSeq} · {r.conflicts} phiếu</span>
                      <span className="block text-[12px] text-muted-foreground break-words">{r.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Panel>

      {reports !== null && (
        <Panel title="Báo cáo sau chốt" className="v2:rounded-v2-panel">
          <div className="space-y-3">
            <p className="text-[13px] text-muted-foreground" data-cms-close-report-note>{CMS_CLOSE_REPORT_NOTE}</p>
            {!reports.ok ? (
              <Notice tone="danger" role="alert" title="Không tải được báo cáo">Thử tải lại trang.</Notice>
            ) : reports.data.length === 0 ? (
              <EmptyState className="py-8 rounded-v2-panel border border-dashed border-input bg-card" title="Chưa có báo cáo sau chốt" />
            ) : (
              <DataTableShell>
                <Table aria-label="Báo cáo sau chốt">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Dữ liệu trả đến</TableHead>
                      <TableHead className="text-right">Phiếu</TableHead>
                      <TableHead className="text-right">CMS đã chốt</TableHead>
                      <TableHead className="text-right">CMS tính lại</TableHead>
                      <TableHead className="text-right">Chênh lệch</TableHead>
                      <TableHead><span className="sr-only">Mở</span></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {reports.data.map((r) => (
                      <TableRow key={r.id} data-cms-close-report={r.id}>
                        <TableCell className="tabular-nums">{cmsDateTime(r.returnsAsOf)}<span className="block text-[12px] text-muted-foreground">{r.createdVia === 'cron' ? 'Job định kỳ' : 'Super'}</span></TableCell>
                        <TableCell className="text-right tabular-nums">{r.returnEvents.toLocaleString('vi-VN')}</TableCell>
                        <TableCell className="text-right tabular-nums">{cmsVnd(r.frozenAmount)}</TableCell>
                        <TableCell className="text-right tabular-nums">{cmsVnd(r.recomputedAmount)}</TableCell>
                        <TableCell className="text-right tabular-nums font-semibold">{cmsVnd(r.deltaAmount)}</TableCell>
                        <TableCell>
                          <Link href={href(`/targets/campaigns/cms/${program.id}/returns/${r.id}`)} className="inline-flex min-h-[44px] items-center px-2 text-[13px] font-semibold underline-offset-2 hover:underline">Xem</Link>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </DataTableShell>
            )}
          </div>
        </Panel>
      )}
    </div>
  )
}
