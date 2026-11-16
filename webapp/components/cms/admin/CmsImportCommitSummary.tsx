'use client'

import { Notice } from '@/components/ds/Notice'
import type { CmsCommitBlock, CmsImportPlan } from '@/lib/cms/kAckPlan'

// UX-KACK-1 (PM 15/11 §4 AC1–AC3) — khối ngay trên nút ghi: N trong file · M sẽ ghi · U không ghi + lý do theo kết quả preview CỦA
// SERVER (không suy từ tick chưa gửi). Ghi một phần: người dùng phải tick xác nhận đúng số SP bị bỏ trước khi nút ghi mở. Còn ý định
// xác nhận K chưa gửi: nút ghi khoá + hướng dẫn "Kiểm tra lại với xác nhận" (không ghi kết quả kiểm cũ).

export function CmsImportCommitSummary({ plan, mode, block, pendingCount, partialConfirmed, onPartialConfirmed, hasKCheck, busy }: {
  plan: CmsImportPlan
  mode: 'replace' | 'append'
  block: CmsCommitBlock
  /** Số ý định xác nhận K đã tick nhưng preview chưa nhận lại. */
  pendingCount: number
  partialConfirmed: boolean
  onPartialConfirmed: (v: boolean) => void
  hasKCheck: boolean
  busy: boolean
}) {
  const reasons: [string, number, string][] = [
    ['k-ack', plan.skipKAck, 'chỉ thiếu bằng chứng K — xác nhận tay ở bảng Kiểm K rồi “Kiểm tra lại với xác nhận”, không cần sửa file'],
    ['k-blocked', plan.skipKBlocked, 'K chưa đạt (LỆCH / NGUỒN LỖI / cần nhập K đề xuất) — sửa K trong file hoặc làm việc với BI; không xác nhận tay được'],
    ['file', plan.skipFile, 'lỗi dữ liệu trong file — sửa theo tab “Lỗi & cảnh báo” rồi kiểm tra lại'],
  ]
  if (plan.write === 0) {
    return (
      <Notice tone="warning" role="status">
        <span data-cms-commit-none className="block">
          Không có sản phẩm hợp lệ để ghi{plan.skipKAck > 0
            ? '.'
            : ' — sửa file theo danh sách lỗi rồi kiểm tra lại.'}
        </span>
        {plan.skipKAck > 0 && (
          <span data-cms-commit-none-kack className="mt-1 block">
            {plan.skipKAck} sản phẩm chỉ thiếu bằng chứng K: xác nhận K tay kèm nguồn căn cứ ở bảng Kiểm K rồi bấm “Kiểm tra lại với xác nhận”, hoặc kiểm tra lại sau
            khi có dữ liệu bán. Không cần sửa file cho các sản phẩm này.
          </span>
        )}
        {plan.skipKAck > 0 && plan.skipFile > 0 && <span className="mt-1 block">{plan.skipFile} sản phẩm có lỗi dữ liệu — sửa file theo tab “Lỗi & cảnh báo”.</span>}
        {plan.skipKBlocked > 0 && <span className="mt-1 block">{plan.skipKBlocked} sản phẩm K lệch / nguồn lỗi / cần nhập K đề xuất — không xác nhận tay được.</span>}
      </Notice>
    )
  }
  return (
    <div data-cms-commit-summary data-total={plan.total} data-write={plan.write} data-skip={plan.skip} className="space-y-2 rounded-v2-panel border bg-card p-4 text-[13px]">
      <p className="font-semibold">Trước khi ghi</p>
      <ul className="space-y-1 text-muted-foreground">
        <li>File có <b className="text-foreground tabular-nums">{plan.total}</b> sản phẩm.</li>
        <li data-cms-commit-write>
          <b className="text-foreground tabular-nums">{plan.write}</b> sản phẩm sẽ được ghi —{' '}
          {mode === 'append'
            ? 'chương trình đã bắt đầu: đây là BỔ SUNG, các sản phẩm đang có trong chương trình giữ nguyên (không sửa, không xoá).'
            : 'danh mục hiện có của chương trình sẽ được THAY bằng các sản phẩm này.'}
        </li>
        {plan.skip > 0 && (
          <li data-cms-commit-skip>
            <b className="text-status-danger tabular-nums">{plan.skip}</b> sản phẩm sẽ KHÔNG được ghi lần này:
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {reasons.filter(([, n]) => n > 0).map(([k, n, t]) => <li key={k} data-cms-commit-skip-reason={k}><b className="tabular-nums">{n}</b> {t}</li>)}
            </ul>
          </li>
        )}
      </ul>
      {block === 'DIRTY' && (
        <Notice tone="warning" role="status">
          <span data-cms-commit-locked>
            Còn {pendingCount} xác nhận K đã tick nhưng chưa gửi. Bấm “Kiểm tra lại với xác nhận” ở bảng Kiểm K phía trên để hệ thống nhận, hoặc bỏ
            tick — nút ghi đang khoá để không ghi kết quả kiểm trước đó.
          </span>
        </Notice>
      )}
      {plan.skip > 0 && block !== 'DIRTY' && (
        <label className="flex min-h-[44px] items-start gap-2">
          <input
            type="checkbox" className="mt-1 h-4 w-4 shrink-0" checked={partialConfirmed} disabled={busy} data-cms-partial-ack
            onChange={(e) => onPartialConfirmed(e.target.checked)}
          />
          <span>
            Tôi đã xem: <b className="tabular-nums">{plan.skip}</b> sản phẩm trong file sẽ KHÔNG được ghi lần này.
            {hasKCheck && plan.skipKAck > 0 && <span className="block text-[12px] text-muted-foreground">Muốn ghi cả {plan.skipKAck} sản phẩm chỉ thiếu bằng chứng K: xác nhận K tay rồi kiểm tra lại trước khi ghi.</span>}
          </span>
        </label>
      )}
    </div>
  )
}
