import { ChevronDown, Download } from 'lucide-react'
import { Panel } from '@/components/ds/Panel'
import { DataTableShell } from '@/components/ds/DataTableShell'
import { Notice } from '@/components/ds/Notice'
import { StatusBadge } from '@/components/ds/StatusBadge'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { cmsDateTime, cmsVnd } from '@/lib/cms/display'
import { cmsUnassignedRatioText, type CmsPayoutDto } from '@/lib/cms/payoutView'

// CMS P3a — số ĐÃ CHỐT trên A3 (rpc_cms_payout, SESSION — phạm vi hiện tại theo Q-208 / Q-217). Super: tổng toàn chương trình,
// thông tin chốt (Q-213, lý do, quy tắc); SM: chỉ tổng trong phạm vi được phân công, không email. Danh sách = định danh SNAPSHOT
// lúc chốt. Lỗi ⇒ thông báo, không 0 giả. Nút xuất file chi trả (cùng run đã chốt).
const BTN = 'h-[44px] md:h-[36px] gap-1.5 text-[13px]'

export function CmsPayoutPanel({ programId, payout, error }: { programId: string; payout: CmsPayoutDto | null; error: string | null }) {
  if (!payout) {
    return (
      <Panel title="Số đã chốt" className="v2:rounded-v2-panel">
        <Notice tone="danger" role="alert" title="Chưa tải được số đã chốt">
          {error === 'FORBIDDEN' ? 'Bạn không có quyền xem số chốt của chương trình này.' : 'Thử tải lại trang.'}
        </Notice>
      </Panel>
    )
  }
  const isSuper = payout.viewer === 'super'
  const exportHref = `/api/export/cms/payout?program=${encodeURIComponent(programId)}&run=${encodeURIComponent(payout.runId)}`
  return (
    <Panel
      title="Số đã chốt"
      className="v2:rounded-v2-panel"
      actions={(
        <a href={exportHref} data-cms-payout-export className={cn(buttonVariants({ variant: 'outline' }), BTN)}>
          <Download className="h-4 w-4" /> Xuất file chi trả
        </a>
      )}
    >
      <div data-cms-payout className="space-y-3">
        <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
          <StatusBadge tone="neutral">Đã chốt</StatusBadge>
          <span className="text-muted-foreground tabular-nums">lúc {cmsDateTime(payout.lockedAt)}</span>
          {payout.isTest && <StatusBadge tone="warning" size="sm">QA — không chi trả</StatusBadge>}
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
          <dt className="text-muted-foreground">{isSuper ? 'Tổng toàn chương trình' : 'Tổng trong phạm vi của bạn'}</dt>
          <dd data-cms-payout-total className="font-semibold tabular-nums">{cmsVnd(payout.scopeTotal)}</dd>
          <dt className="text-muted-foreground">Số dược sĩ{isSuper ? '' : ' trong phạm vi'}</dt>
          <dd className="tabular-nums">{payout.rows.length}{isSuper && payout.super ? ` (có tiền ${payout.super.staffPaid})` : ''}</dd>
          {isSuper && payout.super && (
            <>
              <dt className="text-muted-foreground">Dòng chưa gán lúc chốt</dt>
              <dd className="tabular-nums">{payout.super.unassignedLines} dòng · {cmsUnassignedRatioText(payout.super.unassignedGmv, payout.super.candidateGmv)} GMV</dd>
              {payout.super.ackReason && (<><dt className="text-muted-foreground">Lý do xác nhận</dt><dd className="break-words">{payout.super.ackReason}</dd></>)}
              <dt className="text-muted-foreground">Quy tắc</dt>
              <dd>{payout.super.policy.label === 'QA_ONLY_ASSUMPTION' ? 'Giả định QA' : `Phiên bản ${payout.policyVersion}`}</dd>
            </>
          )}
        </dl>
        {payout.rows.length > 0 && (
          <details data-cms-payout-rows className="group">
            <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-1 text-[13px] font-medium [&::-webkit-details-marker]:hidden">
              <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden="true" />
              Danh sách chi trả ({payout.rows.length}) — tên / nhà thuốc lúc chốt
            </summary>
            <DataTableShell className="mt-1">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[480px] text-[12px]">
                  <thead className="bg-muted text-left text-muted-foreground">
                    <tr className="whitespace-nowrap">
                      <th className="px-2.5 py-2 font-medium">Dược sĩ</th>
                      <th className="px-2.5 py-2 font-medium">Nhà thuốc</th>
                      <th className="px-2.5 py-2 text-right font-medium">CMS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payout.rows.map((r) => (
                      <tr key={r.userId} data-cms-payout-row className="border-t align-middle">
                        <td className="px-2.5 py-2"><span className="line-clamp-2 break-words">{r.name ?? '—'}</span></td>
                        <td className="px-2.5 py-2 text-muted-foreground"><span className="line-clamp-2 break-words">{r.storeName ?? '—'}</span></td>
                        <td className="px-2.5 py-2 text-right font-semibold tabular-nums">{cmsVnd(r.amountVnd)}</td>
                      </tr>
                    ))}
                    <tr className="border-t bg-muted/50 font-semibold">
                      <td className="px-2.5 py-2" colSpan={2}>{isSuper ? 'Tổng' : 'Tổng trong phạm vi'}</td>
                      <td className="px-2.5 py-2 text-right tabular-nums">{cmsVnd(payout.scopeTotal)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </DataTableShell>
          </details>
        )}
        <p className="text-[12px] text-muted-foreground">File chi trả dùng để đối soát, không phải lệnh chuyển tiền.</p>
      </div>
    </Panel>
  )
}
