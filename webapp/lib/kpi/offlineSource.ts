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
import { allocateRoundedDaily, parseSourceNumber } from '@/lib/kpi/revenueSource'

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
      // r1.3 (audit P1): mọi field đọc từ BQ đều phải TỒN TẠI và ĐÚNG KIỂU.
      // `?? 0` / `|| 0` là cách schema-drift biến thành số 0 âm thầm trên màn
      // tiền — ở đây thiếu/sai kiểu luôn là LỖI NGUỒN.
      // 112.3: dùng CHUNG parser contract (lib/kpi/revenueSource) thay vì bản
      // sao cục bộ — hai bản song song là cách contract test xanh trong khi
      // production drift. Ở đây "ô trống" và "không đọc được" đều là lỗi nguồn
      // nên gộp về null; chỗ cần phân biệt (counter NULL) đã tách riêng.
      const numOrFail = (key: string): number | null => {
        const v = parseSourceNumber(r[key])
        return v === undefined || v === null ? null : v
      }

      const pos = String(r.pos_code ?? '').trim().toUpperCase()
      const date = String(r.date ?? '').slice(0, 10)
      // Ngày phải đúng ĐỊNH DẠNG và là ngày CÓ THẬT: '2026-13-99' khớp regex
      // nhưng không tồn tại — round-trip qua Date để loại.
      const dateTs = Date.parse(`${date}T00:00:00Z`)
      const realDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(dateTs)
        && new Date(dateTs).toISOString().slice(0, 10) === date
      if (!pos || !realDate) {
        // r1.3 (audit): KHÔNG `continue` im lặng — query đã lọc pos/date NOT
        // NULL nên row hỏng khóa nghĩa là nguồn/schema đã đổi.
        return {
          ok: false,
          reason: `Nguồn BQ có row sai khóa (pos_code=${String(r.pos_code)}, date=${String(r.date)}) — giữ snapshot cũ`,
        }
      }
      // ⚠ BQ-V2 (05/08): nguồn pre-aggregated 1 row/store/ngày. r1.3: THIẾU
      // alias source_row_count cũng là lỗi (trước đây mặc định 1 ⇒ drift vẫn
      // sync). Chỉ chấp nhận đúng số nguyên 1.
      const srcCount = numOrFail('source_row_count')
      if (srcCount === null || !Number.isInteger(srcCount) || srcCount !== 1) {
        return {
          ok: false,
          reason: `Nguồn BQ bất thường: ${pos}/${date} có source_row_count=${String(r.source_row_count)} (kỳ vọng đúng 1 row/store/ngày — bảng pre-aggregated); giữ snapshot cũ`,
        }
      }
      if (offlineByPos.get(pos)?.has(date)) {
        return { ok: false, reason: `Nguồn BQ trùng key ${pos}/${date} trong cùng lần pull — giữ snapshot cũ` }
      }
      // ⚠ Contract 30/07: field `gmv` từ campaignDailyQuery là alias của
      // SUM(COALESCE(net_revenue,0)) — luôn có giá trị khi row tồn tại. r1.3:
      // thiếu/NaN/chuỗi rác → LỖI NGUỒN (0đ và số ÂM vẫn hợp lệ: hoàn/điều chỉnh).
      // ── 112 (04/09): NULL nguồn Offline = nguồn CHƯA HỢP LỆ ────────────
      // Contract 04/09 điểm 6. Phải đếm RIÊNG vì SUM() của BigQuery bỏ qua
      // NULL: hai canary lệch-cặp bên dưới không thấy ca CẢ HAI field cùng
      // NULL, và tổng khi đó trông vẫn hợp lệ.
      const revNull = numOrFail('offline_revenue_null_count')
      if (revNull === null || !Number.isInteger(revNull) || revNull < 0) {
        return {
          ok: false,
          reason: `Nguồn BQ thiếu/sai canary offline_revenue_null_count tại ${pos}/${date} (=${String(r.offline_revenue_null_count)}) — query hoặc schema đã đổi; giữ snapshot cũ`,
        }
      }
      if (revNull > 0) {
        return {
          ok: false,
          reason: `Nguồn BQ có ${revNull} ô doanh thu Offline NULL tại ${pos}/${date} — nguồn chưa hoàn tất, KHÔNG coi là 0đ; giữ snapshot cũ`,
        }
      }
      const gmv = numOrFail('gmv')
      if (gmv === null) {
        return {
          ok: false,
          reason: `Nguồn BQ thiếu/sai doanh thu tại ${pos}/${date}: gmv=${String(r.gmv)} (kỳ vọng số hữu hạn, 0 và âm đều hợp lệ); giữ snapshot cũ`,
        }
      }
      if (!offlineByPos.has(pos)) offlineByPos.set(pos, new Map())
      offlineByPos.get(pos)!.set(date, gmv)

      // ── 105: canary SỐ ĐƠN — bắt lỗi TẠI NGUỒN, trước mọi làm tròn ──
      // r1.3: canary là output COUNTIF ⇒ BẮT BUỘC nguyên >= 0; giá trị âm/lẻ
      // nghĩa là query đã đổi, không được tin.
      const canary: Record<string, number> = {}
      let orderIssue: string | null = null
      for (const k of ['rev_without_order', 'order_without_rev', 'negative_order',
        'non_integer_order', 'revenue_with_zero_order', 'offline_order_null_count']) {
        const v = numOrFail(k)
        if (v === null) {
          orderIssue = `thiếu/sai field số đơn (${k}) — query hoặc schema đã đổi`
          break
        }
        if (!Number.isInteger(v) || v < 0) {
          orderIssue = `canary ${k} không hợp lệ: ${String(r[k])} (COUNTIF phải là số nguyên >= 0)`
          break
        }
        canary[k] = v
      }
      const ordNum = numOrFail('order_count')
      if (orderIssue === null && ordNum === null) {
        orderIssue = 'thiếu/sai field số đơn (order_count) — query hoặc schema đã đổi'
      } else if (orderIssue === null) {
        if (canary.offline_order_null_count > 0) {
          // Số đơn thiếu ⇒ chỉ số ĐƠN/AOV không tin được. GMV (không strict)
          // vẫn ghi tiền và degrade riêng POS này — doanh thu đã được canary
          // offline_revenue_null_count ở trên bảo chứng là đầy đủ.
          orderIssue = `số đơn Offline NULL (${canary.offline_order_null_count} row)`
        } else if (canary.non_integer_order > 0) {
          orderIssue = `offline_no_order KHÔNG NGUYÊN (${canary.non_integer_order} row)`
        } else if (canary.revenue_with_zero_order > 0) {
          // Có doanh thu mà 0 đơn ⇒ AOV vô định nhưng vẫn có tiền.
          orderIssue = `có doanh thu nhưng KHÔNG đơn nào (${canary.revenue_with_zero_order} row no_order=0, net_revenue≠0)`
        } else if (canary.rev_without_order > 0 || canary.order_without_rev > 0) {
          orderIssue = `lệch NULL: ${canary.rev_without_order} row có doanh thu thiếu no_order, ${canary.order_without_rev} row có no_order thiếu doanh thu`
        } else if (canary.negative_order > 0) {
          orderIssue = 'offline_no_order ÂM'
        } else if (!Number.isInteger(ordNum as number) || (ordNum as number) < 0) {
          orderIssue = `tổng số đơn không hợp lệ: ${String(r.order_count)}`
        }
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

  // ── 112.3 (audit P1#1): làm tròn theo TOÀN KHOẢNG ────────────────────────
  // Query trả giá trị THÔ. Contract 04/09 điểm 3 là ROUND(SUM(cả khoảng));
  // làm tròn từng ngày rồi cộng lại ra số khác (hai ngày 0,4đ → 0đ thay vì
  // 1đ). Làm tròn tổng một lần rồi dồn phần dư vào ngày cuối: daily vẫn là
  // VND nguyên và SUM(daily) = tổng kỳ đúng contract.
  const roundedByPos = new Map<string, Map<string, number>>()
  for (const [pos, byDate] of offlineByPos) roundedByPos.set(pos, allocateRoundedDaily(byDate))

  return { ok: true, offlineByPos: roundedByPos, ordersByPos, warnings }
}
