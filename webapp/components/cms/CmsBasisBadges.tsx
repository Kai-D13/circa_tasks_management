import { StatusBadge } from '@/components/ds/StatusBadge'
import {
  CMS_BASIS_SOURCE_NOTE, CMS_QUANTITY_BASIS_LABEL, CMS_RETURNS_POLICY_LABEL, type CmsProgramBasis,
} from '@/lib/cms/calc/basisUi'

// CMS-CALC-RET-2 P5.1 (spec §8.1) — badge cách tính lượng + chính sách trả của CHƯƠNG TRÌNH (cấu hình hiện tại; nhãn của một run lịch
// sử đọc từ run đã ghim, không từ đây). undefined = DB trước 130 ⇒ không hiện gì (như cũ); null = không đọc được ⇒ nói rõ, không giả
// "cộng dồn". `withNote`: hiện ghi chú nguồn (chương trình cũ / chưa xác nhận).
export function CmsBasisBadges({ basis, withNote = false }: { basis: CmsProgramBasis | null | undefined; withNote?: boolean }) {
  if (basis === undefined) return null
  if (basis === null) {
    return <span data-cms-basis="unknown" className="contents"><StatusBadge tone="neutral">Cách tính: không đọc được</StatusBadge></span>
  }
  const note = withNote ? CMS_BASIS_SOURCE_NOTE[basis.source] : null
  return (
    <span data-cms-basis={basis.basis ?? 'pending'} data-cms-basis-source={basis.source} data-cms-returns-policy={basis.returnsPolicy} className="contents">
      {basis.basis
        ? <StatusBadge tone="info">{CMS_QUANTITY_BASIS_LABEL[basis.basis]}</StatusBadge>
        : <StatusBadge tone="warning">Chưa chọn cách tính</StatusBadge>}
      <StatusBadge tone={basis.returnsPolicy === 'net_returns_v1' ? 'info' : 'neutral'}>{CMS_RETURNS_POLICY_LABEL[basis.returnsPolicy]}</StatusBadge>
      {note && basis.basis !== null && <span className="text-[12px] text-muted-foreground">{note}</span>}
    </span>
  )
}
