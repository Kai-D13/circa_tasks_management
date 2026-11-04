// CMS Q-206 (trả hàng) — NGUYÊN MẪU adapter để chuẩn bị ca T1–T11 (checklist `planning/research/cms-i4-bi-checklist.md` §3.3–§3.5;
// PM 04/11 §I4 (3)). Q-206 đang HOLD: file này KHÔNG nằm trong lib/, KHÔNG được app / cron / action import, KHÔNG mở cổng công bố
// tiền hay chốt kỳ. Mục đích: (1) cho stakeholder thấy số thật của engine dưới từng phương án quy thuộc còn mở (B1 người bán gốc
// / người xử lý trả × D1 kỳ ngày bán / ngày trả); (2) thử các quy tắc an toàn không phụ thuộc B1 × D1 (phiên bản sự kiện, không
// trừ hai lần, không âm, không trừ người khác khi không tìm được dòng gốc, trả sau chốt tách riêng). Khi PM chốt contract, adapter
// thật được viết lại trong lib/ theo đúng contract + PM audit; các ca ở đây chuyển thành test nghiệm thu.
//
// Nhãn quyết định (PM audit 04/11 `planning/reviews/2026-11-04-cms-i4-offline-pm.md` §4 — quyết định KỸ THUẬT trong phạm vi, không
// phải stakeholder chốt B1 / D1; Q-206 vẫn HOLD, chỉ áp vào lib/runtime khi contract trả hàng được chốt):
//   (b) người phải chịu điều chỉnh không quy được ⇒ PM chọn held lượt của chương trình liên quan (TARGET_UNASSIGNED, T11b);
//   (c) dòng gốc ngoài kỳ ⇒ PM chọn hướng BI cung cấp đủ ngữ cảnh gốc qua nguồn logic trả (BI xác nhận khả thi); thiếu ⇒ held
//       (UNMATCHED_RETURN, T11c) — nguyên mẫu chưa đọc ngữ cảnh gốc ngoài snapshot vì contract chưa có;
//   (d) một sự kiện trả lỗi ⇒ PM chọn held CẢ lượt chương trình liên quan (BAD_EVENT …), không cô lập bỏ sự kiện rồi công bố;
//   (e) trừ người xử lý trả dù dòng gốc vốn chưa được tính CMS ⇒ nghiệp vụ Q-206.B1, stakeholder quyết (PM đề xuất người bán gốc /
//       kỳ bán gốc — CHƯA chốt); bảng 4 phương án dưới chỉ phục vụ thảo luận, không có mặc định.
// Các lý do held khác (VERSION_CONFLICT, SELLER_CONFLICT, OVER_RETURN, DOUBLE_MECHANISM) và cách tách "sau chốt" vẫn là ĐỀ XUẤT
// KỸ THUẬT CỦA DEV (fail-closed như quality.ts), chốt cùng contract trả hàng. P3b / sự kiện đến muộn / huỷ sau chốt phải chốt + test
// ở batch adapter thật, không suy từ nguyên mẫu này.
//
// Trường sự kiện = ĐỀ XUẤT ở §3.3 (BI thiết kế, CHƯA tồn tại) + `original_base_quantity` + `event_status` (E2 — CHỈ cần khi sự kiện
// có sửa / huỷ) + `return_handler_email` (CHỈ cần nếu B1 chọn người xử lý trả). `original_base_quantity` chỉ phát hiện bất nhất
// LƯỢNG trong kịch bản đã thử; KHÔNG bảo đảm phát hiện mọi cơ chế trừ kép (GMV gốc bị sửa mà lượng giữ nguyên lọt qua — test T9b):
// bảo đảm thật là cam kết E1 của BI (đúng một cơ chế giảm có hiệu lực).

import { normalizeCmsEmail, type CmsSalesLine } from '../lib/cms/source/contract'
import { mapSeller, type CmsSellerIndex } from '../lib/cms/mapping'
import { parseCmsDecimal } from '../lib/cms/decimal'
import { parseUtcMicros } from '../lib/cms/time'

export type CmsQ206Attribution = 'original_seller' | 'return_handler'
export type CmsQ206Period = 'sale_date' | 'return_date'
export interface CmsQ206Option { attribution: CmsQ206Attribution; period: CmsQ206Period }

/** Bốn tổ hợp B1 × D1 còn mở — KHÔNG có mặc định (Q-206 HOLD). */
export const CMS_Q206_OPTIONS: Record<string, CmsQ206Option> = {
  'O1 người bán gốc · kỳ ngày bán': { attribution: 'original_seller', period: 'sale_date' },
  'O2 người xử lý trả · kỳ ngày trả': { attribution: 'return_handler', period: 'return_date' },
  'O3 người bán gốc · kỳ ngày trả': { attribution: 'original_seller', period: 'return_date' },
  'O4 người xử lý trả · kỳ ngày bán': { attribution: 'return_handler', period: 'sale_date' },
}

export interface CmsQ206EventRaw {
  return_event_id: string
  event_version: string
  event_status: string
  original_order_line_id: string
  original_seller_email?: string | null
  original_base_quantity?: string | null
  return_handler_email: string | null
  return_recorded_at: string
  return_base_quantity: string
  return_gmv_amount: string
}

export type CmsQ206HoldReason =
  | 'BAD_EVENT'          // thiếu / sai dạng trường sự kiện
  | 'VERSION_CONFLICT'   // cùng return_event_id + event_version nhưng nội dung khác
  | 'UNMATCHED_RETURN'   // không tìm được dòng bán gốc trong snapshot (T11)
  | 'SELLER_CONFLICT'    // original_seller_email ≠ email trên dòng bán gốc
  | 'OVER_RETURN'        // Σ trả > lượng bán của dòng gốc (C3 / T10)
  | 'DOUBLE_MECHANISM'   // dòng gốc đã bị sửa giảm / đổi trạng thái VÀ có sự kiện trả (E1 / T9)
  | 'TARGET_UNASSIGNED'  // dòng bán gốc ĐÃ quy được cho dược sĩ nhưng người bị trừ (theo phương án) không quy được ⇒ tiền trả sẽ rơi
                         // vào "Chưa gán", không ai bị trừ (T11b) — PM 04/11 (b): held lượt chương trình liên quan

export interface CmsQ206Adapted {
  status: 'ok' | 'held'
  reasons: CmsQ206HoldReason[]
  /** Dòng bán + dòng điều chỉnh âm — đầu vào engine (chỉ có nghĩa khi status = ok). */
  lines: CmsSalesLine[]
  /** Sự kiện ghi nhận SAU mốc chốt ⇒ báo cáo riêng, không đổi số đã chốt (CMS-Q7). */
  afterLock: string[]
  unmatched: string[]
  superseded: number
  cancelled: number
}

const B = (n: number | string) => BigInt(n)

/**
 * Sự kiện trả ⇒ dòng điều chỉnh âm theo phương án. Fail-closed: mọi bất thường ⇒ held (giữ snapshot cũ như quality.ts), không
 * đoán. `lockAtMicros` = thời điểm chốt (null = chưa chốt). `sellers` (khuyến nghị luôn truyền): kiểm người bị trừ quy được như
 * người bán gốc — thiếu ⇒ không kiểm TARGET_UNASSIGNED.
 */
export function cmsQ206Adapt(sales: readonly CmsSalesLine[], events: readonly CmsQ206EventRaw[], opt: CmsQ206Option, lockAtMicros: bigint | null = null, sellers?: CmsSellerIndex): CmsQ206Adapted {
  const reasons = new Set<CmsQ206HoldReason>()
  const out: CmsQ206Adapted = { status: 'ok', reasons: [], lines: [...sales], afterLock: [], unmatched: [], superseded: 0, cancelled: 0 }
  // E2: giữ phiên bản cao nhất của mỗi sự kiện; cùng phiên bản khác nội dung ⇒ held.
  const latest = new Map<string, CmsQ206EventRaw>()
  for (const e of events) {
    if (!/^\d{1,9}$/.test(e.event_version ?? '') || !e.return_event_id) { reasons.add('BAD_EVENT'); continue }
    const cur = latest.get(e.return_event_id)
    if (!cur || Number(e.event_version) > Number(cur.event_version)) { if (cur) out.superseded++; latest.set(e.return_event_id, e) }
    else if (Number(e.event_version) === Number(cur.event_version)) { if (JSON.stringify(e) !== JSON.stringify(cur)) reasons.add('VERSION_CONFLICT') }
    else out.superseded++
  }
  const byId = new Map(sales.map((l) => [l.orderLineId, l]))
  const returned = new Map<string, bigint>()
  for (const e of [...latest.values()].sort((a, b) => a.return_event_id.localeCompare(b.return_event_id))) {
    if (e.event_status === 'CANCELLED') { out.cancelled++; continue }
    if (e.event_status !== 'ACTIVE') { reasons.add('BAD_EVENT'); continue }
    const at = parseUtcMicros(e.return_recorded_at ?? '')
    const qty = parseCmsDecimal(e.return_base_quantity ?? '')
    const gmv = parseCmsDecimal(e.return_gmv_amount ?? '')
    if (at === null || !qty.ok || !gmv.ok || qty.units === B(0)) { reasons.add('BAD_EVENT'); continue }
    if (lockAtMicros !== null && at > lockAtMicros) { out.afterLock.push(e.return_event_id); continue }
    const orig = byId.get(e.original_order_line_id)
    if (!orig) { out.unmatched.push(e.return_event_id); reasons.add('UNMATCHED_RETURN'); continue }
    const declaredSeller = normalizeCmsEmail(e.original_seller_email)
    if (declaredSeller !== null && declaredSeller !== orig.sellerEmail) reasons.add('SELLER_CONFLICT')
    if (orig.orderType !== 'OFFLINE' || orig.orderStatus !== 'COMPLETED') reasons.add('DOUBLE_MECHANISM')
    if (e.original_base_quantity) {
      const ob = parseCmsDecimal(e.original_base_quantity)
      if (!ob.ok) reasons.add('BAD_EVENT')
      else if (ob.units !== orig.baseQuantityUnits) reasons.add('DOUBLE_MECHANISM')
    }
    const sum = (returned.get(orig.orderLineId) ?? B(0)) + qty.units
    returned.set(orig.orderLineId, sum)
    if (sum > orig.baseQuantityUnits) reasons.add('OVER_RETURN')
    const target = opt.attribution === 'original_seller' ? orig.sellerEmail : normalizeCmsEmail(e.return_handler_email)
    if (sellers && mapSeller(orig.sellerEmail, sellers).ok && !mapSeller(target, sellers).ok) reasons.add('TARGET_UNASSIGNED')
    out.lines.push({
      orderLineId: `R:${e.return_event_id}`,
      orderId: `R:${e.return_event_id}`,
      orderCode: `R:${e.return_event_id}`,
      productId: orig.productId,
      sellerEmail: target,
      posCode: orig.posCode,
      orderType: 'OFFLINE',
      orderStatus: 'COMPLETED',
      completedAtMicros: opt.period === 'sale_date' ? orig.completedAtMicros : at,
      quantityRaw: null,
      uomRaw: null,
      baseQuantityUnits: -qty.units,
      gmvUnits: -gmv.units,
      sourceUpdatedAtMicros: at,
    })
  }
  out.reasons = [...reasons].sort()
  out.status = out.reasons.length ? 'held' : 'ok'
  return out
}
