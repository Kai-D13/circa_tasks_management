import { FlaskConical } from 'lucide-react'
import { careQaUiState } from '@/lib/care/server/qaUi'

// B6-qa-ui: dải báo CHẾ ĐỘ QA trên mọi trang /care* — chỉ dev server local đủ cổng QA
// (lib/care/qa/uiGate.ts). Production: cổng luôn 'off' ⇒ layout chỉ render children.
export default function CareLayout({ children }: { children: React.ReactNode }) {
  const qa = careQaUiState()
  return (
    <>
      {qa.kind === 'active' && (
        <div role="note" data-testid="care-qa-banner"
          className="mx-4 mt-4 flex items-start gap-2 rounded-lg border border-status-warning/40 bg-status-warning-bg p-3 text-sm md:mx-6">
          <FlaskConical className="mt-0.5 size-4 shrink-0 text-status-warning" aria-hidden />
          <span>
            <strong>Chế độ QA trên máy này</strong> — import và lượt chăm sóc chỉ dùng dữ liệu giả (is_test) của lượt QA
            đang chạy. Xem trước file gốc là thao tác <strong>đọc dữ liệu thật</strong> và không import được. Số liệu tổng
            hợp tính theo đường QA, không phải báo cáo vận hành; không tải ảnh, không gọi/nhắn số giả.
          </span>
        </div>
      )}
      {children}
    </>
  )
}
