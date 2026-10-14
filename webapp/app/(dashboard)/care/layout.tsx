import { careQaUiState } from '@/lib/care/server/qaUi'
import { CareQaBanner } from '@/components/care/CareQaBanner'

// B6-qa-ui: dải báo CHẾ ĐỘ QA trên mọi trang /care* — chỉ dev server local đủ cổng QA
// (lib/care/qa/uiGate.ts). Production: cổng luôn 'off' ⇒ layout chỉ render children.
// B7-ui (M08/F12): gọn 1 dòng; đủ nội dung PM yêu cầu nằm trong <details> "Chi tiết" (không JS).
// B7-ui r2: nội dung theo Q-107 (components/care/CareQaNotice); mobile 3 màn dược sĩ dùng chip ở header.
export default function CareLayout({ children }: { children: React.ReactNode }) {
  const qa = careQaUiState()
  return (
    <>
      {qa.kind === 'active' && (
        <CareQaBanner />
      )}
      {children}
    </>
  )
}
