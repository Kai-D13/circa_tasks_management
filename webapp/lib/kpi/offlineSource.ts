// Mig 106 bước D — ĐỌC NGUỒN OFFLINE (BigQuery) DÙNG CHUNG cho 2 loại campaign,
// khác nhau ĐÚNG MỘT THAM SỐ `strict`:
//   · campaign GMV (strict=false)  → số đơn/AOV là chỉ số PHỤ: nguồn số đơn
//     hỏng thì DEGRADE đúng POS đó (tiền vẫn ghi) + warning.
//   · campaign Chất lượng bán hàng (strict=true) → số đơn/AOV CHÍNH LÀ KPI:
//     bất kỳ canary nào lỗi đều PRESERVE toàn snapshot, không ghi gì.
// Guard của TIỀN (source_row_count, trùng key, thiếu ô coverage) preserve cho
// CẢ HAI — không phụ thuộc `strict`.
//
// Tách ra file riêng (audit P2 vòng 105 r1.3): trước đây policy nằm ở một
// constant `strictOrderMetrics = false` trong orchestrator; loại campaign mới
// KHÔNG được "đổi constant toàn cục thành true" vì sẽ kéo GMV về hành vi cũ.
// THUẦN: không import supabase/BQ client — nhận runBqChunk qua tham số.

import { monthChunks, nextDayISO } from '@/lib/kpi/engine'

export interface OfflineSourceInput {
  sa: unknown
  startISO: string
  effEndISO: string
  /** pos_code của TẤT CẢ target (dùng cho expected-coverage). */
  targetPosCodes: (string | null)[]
  /** true = số đơn là KPI (preserve khi canary lỗi); false = degrade. */
  strict: boolean
  runBqChunk(sa: unknown, chunkStart: string, chunkEnd: string): Promise<Record<string, unknown>[]>
}

export type OfflineSourceOutcome =
  | {
    ok: true
    offlineByPos: Map<string, Map<string, number>>
    /** CHỈ chứa POS có nguồn số đơn LÀNH (POS lỗi đã bị loại khi !strict). */
    ordersByPos: Map<string, Map<string, number>>
    warnings: string[]
  }
  | { ok: false; reason: string }

export async function readOfflineSource(input: OfflineSourceInput): Promise<OfflineSourceOutcome> {
  const { sa, startISO, effEndISO, targetPosCodes, strict, runBqChunk } = input
  const offlineByPos = new Map<string, Map<string, number>>()
  const ordersByPos = new Map<string, Map<string, number>>()
  // POS có nguồn số đơn hỏng (chỉ dùng khi KHÔNG strict).
  const orderIssuePos = new Map<string, string>()
  const warnings: string[] = []

  for (const [chunkStart, chunkEnd] of monthChunks(startISO, effEndISO)) {
    let rows: Record<string, unknown>[]
    try {
      rows = await runBqChunk(sa, chunkStart, chunkEnd)
    } catch (err) {
      // Nguồn BQ trục trặc → giữ snapshot cũ, không partial (QA gate).
      return { ok: false, reason: `BigQuery lỗi: ${err instanceof Error ? err.message : String(err)}` }
    }
    for (const r of rows) {
      const pos = String(r.pos_code ?? '').trim().toUpperCase()
      const date = String(r.date ?? '').slice(0, 10)
      if (!pos || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
      // ⚠ BQ-V2 (05/08): nguồn pre-aggregated 1 row/store/ngày — source_row_count
      // != 1 hoặc key (pos, ngày) lặp lại nghĩa là NGUỒN SAI → preserve
      // (fail-closed, không ghi số khả nghi).
      const srcCount = Number(r.source_row_count ?? 1)
      if (!Number.isFinite(srcCount) || srcCount !== 1) {
        return {
          ok: false,
          reason: `Nguồn BQ bất thường: ${pos}/${date} có source_row_count=${String(r.source_row_count)} (kỳ vọng 1 row/store/ngày — bảng pre-aggregated); giữ snapshot cũ`,
        }
      }
      if (offlineByPos.get(pos)?.has(date)) {
        return { ok: false, reason: `Nguồn BQ trùng key ${pos}/${date} trong cùng lần pull — giữ snapshot cũ` }
      }
      if (!offlineByPos.has(pos)) offlineByPos.set(pos, new Map())
      // ⚠ Contract 30/07: field `gmv` từ campaignDailyQuery là alias của
      // SUM(net_revenue) — giá trị Offline của campaign = Net Revenue.
      offlineByPos.get(pos)!.set(date, Number(r.gmv ?? 0) || 0)

      // ── 105: canary SỐ ĐƠN — bắt lỗi TẠI NGUỒN, trước mọi làm tròn ──
      const numOrFail = (key: string): number | null => {
        const raw = r[key]
        if (raw === undefined || raw === null) return null
        const n = Number(raw)
        return Number.isFinite(n) ? n : null
      }
      const revNoOrder = numOrFail('rev_without_order')
      const orderNoRev = numOrFail('order_without_rev')
      const negOrder = numOrFail('negative_order')
      const nonIntOrder = numOrFail('non_integer_order')
      const revZeroOrder = numOrFail('revenue_with_zero_order')
      const ordNum = numOrFail('order_count')

      let orderIssue: string | null = null
      if (revNoOrder === null || orderNoRev === null || negOrder === null
          || nonIntOrder === null || revZeroOrder === null || ordNum === null) {
        // KHÔNG mặc định 0 khi field vắng — query/schema drift sẽ âm thầm ghi
        // "0 đơn".
        orderIssue = 'thiếu/sai field số đơn (order_count/canary) — query hoặc schema đã đổi'
      } else if (nonIntOrder > 0) {
        orderIssue = `no_order KHÔNG NGUYÊN (${nonIntOrder} row)`
      } else if (revZeroOrder > 0) {
        // Có doanh thu mà 0 đơn ⇒ AOV vô định nhưng vẫn có tiền.
        orderIssue = `có doanh thu nhưng KHÔNG đơn nào (${revZeroOrder} row no_order=0, net_revenue≠0)`
      } else if (revNoOrder > 0 || orderNoRev > 0) {
        orderIssue = `lệch NULL: ${revNoOrder} row có doanh thu thiếu no_order, ${orderNoRev} row có no_order thiếu doanh thu`
      } else if (negOrder > 0) {
        orderIssue = 'no_order ÂM'
      } else if (!Number.isInteger(ordNum) || ordNum < 0) {
        orderIssue = `tổng số đơn không hợp lệ: ${String(r.order_count)}`
      }

      if (orderIssue !== null) {
        if (strict) {
          return { ok: false, reason: `Nguồn BQ ${orderIssue} tại ${pos}/${date} — giữ snapshot cũ` }
        }
        orderIssuePos.set(pos, `${pos}/${date}: ${orderIssue}`)
      } else {
        if (!ordersByPos.has(pos)) ordersByPos.set(pos, new Map())
        ordersByPos.get(pos)!.set(date, ordNum as number)
      }
    }
  }

  // ⚠ BQ-V2 r1 (audit P1#2): EXPECTED COVERAGE — bảng mới có row cho MỌI ngày
  // trong kỳ (kể cả tương lai, net_revenue NULL → 0). Vì vậy mỗi (target POS ×
  // ngày) từ start → effectiveEnd PHẢI có row; thiếu ô nào (kể cả 1 ngày giữa
  // kỳ) = nguồn lỗi → PRESERVE, tuyệt đối không ghi snapshot thấp hơn thực tế.
  // Row tồn tại với net_revenue NULL là HỢP LỆ (=0); row KHÔNG tồn tại là LỖI.
  const targetPos = [...new Set(
    targetPosCodes.map((p) => String(p ?? '').trim().toUpperCase()).filter(Boolean),
  )]
  const missing: string[] = []
  for (const pos of targetPos) {
    const byDate = offlineByPos.get(pos)
    for (let d = startISO; d <= effEndISO; d = nextDayISO(d)) {
      if (!byDate?.has(d)) missing.push(`${pos}/${d}`)
    }
  }
  if (missing.length > 0) {
    const sample = missing.slice(0, 5).join(', ')
    return {
      ok: false,
      reason: `Nguồn BQ THIẾU ${missing.length} ô dữ liệu (POS×ngày) trong kỳ — vd: ${sample}${missing.length > 5 ? ', …' : ''}; giữ snapshot cũ`,
    }
  }

  // DEGRADE (chỉ khi !strict): bỏ số đơn của POS có nguồn hỏng — bỏ CẢ POS để
  // không gửi payload nửa vời (RPC 105 đòi mọi ngày của store phải có count);
  // tiền của POS đó VẪN được ghi bình thường.
  for (const [pos, reason] of orderIssuePos) {
    ordersByPos.delete(pos)
    warnings.push(`Số đơn/AOV Offline tạm ẩn cho ${pos} — nguồn BQ ${reason}. GMV/commission KHÔNG bị ảnh hưởng.`)
  }

  return { ok: true, offlineByPos, ordersByPos, warnings }
}
