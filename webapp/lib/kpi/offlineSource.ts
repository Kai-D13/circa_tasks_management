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
import { REVENUE_SNAP_EPSILON, parseSourceNumber, snapRevenue } from '@/lib/kpi/revenueSource'

export interface OfflineSourceInput {
  sa: unknown
  startISO: string
  effEndISO: string
  /** pos_code của TẤT CẢ target (dùng cho expected-coverage). */
  targetPosCodes: (string | null)[]
  /** true = số đơn là KPI (preserve khi canary lỗi); false = degrade. */
  strict: boolean
  /**
   * Hôm nay theo giờ VN. Chỉ dùng để phân biệt ngày ĐÃ KẾT THÚC với ngày đang
   * diễn ra: gate "toàn bộ POS cùng NULL = nghi ETL" chỉ áp cho ngày đã xong,
   * vì lúc 00:05 mọi cửa hàng đều chưa bán gì và đó là số ĐÚNG.
   */
  todayVnISO: string
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
  const { sa, startISO, effEndISO, targetPosCodes, strict, todayVnISO, runBqChunk } = input
  const offlineByPos = new Map<string, Map<string, number>>()
  const ordersByPos = new Map<string, Map<string, number>>()
  // POS có nguồn số đơn hỏng (chỉ dùng khi KHÔNG strict).
  const orderIssuePos = new Map<string, string>()
  // A+ : ngày → POS "không phát sinh giao dịch" (cả doanh thu lẫn số đơn NULL).
  // Dùng cho gate ETL sau vòng lặp + warning cho người trực.
  const noTxByDate = new Map<string, Set<string>>()
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
      // ── CONTRACT A+ (112.4, chốt 04/09 sau khi BI nạp tháng 9) ──────────
      // View mã hoá "KHÔNG PHÁT SINH GIAO DỊCH" bằng NULL, chứ không bằng số 0
      // (đo toàn view 04/09: 0/7.139 dòng DAY có giá trị 0). NULL cục bộ ở ngày
      // quá khứ là chuyện BÌNH THƯỜNG — Tết 16–20/02 có 6–8/27 POS NULL, 20/05
      // có 3/28, trong đó 9 POS vẫn đang hoạt động. Bản 112.3 coi mọi NULL là
      // "nguồn hỏng" nên sẽ ĐÓNG BĂNG VĨNH VIỄN mọi campaign phủ Tết.
      //   · doanh thu + số đơn CÙNG NULL → 0đ / 0 đơn (+ warning)
      //   · doanh thu NULL mà số đơn KHÔNG NULL → CÓ ĐƠN mà THIẾU TIỀN → PRESERVE
      //   · thiếu hẳn row → coverage → PRESERVE (kiểm sau vòng lặp)
      //   · TOÀN BỘ POS cùng NULL ở ngày ĐÃ KẾT THÚC → nghi ETL → PRESERVE
      // Ngày TƯƠNG LAI không bao giờ vào đây: effEnd = min(end_date, hôm nay).
      //
      // ⚠ Lệch có chủ ý so với chữ nghĩa A+ điểm 2 ("chỉ một field NULL → luôn
      // fail-closed"): chiều "CÓ TIỀN, thiếu số đơn" giữ nguyên policy 105 r1.3
      // — strict=true (Chất lượng bán hàng, số đơn LÀ KPI) vẫn preserve, còn
      // campaign GMV degrade riêng POS đó và VẪN ghi tiền. Fail-closed cả hai
      // chiều sẽ làm một cửa hàng thiếu số đơn đóng băng doanh thu của TOÀN BỘ
      // campaign — chặt hơn nhưng tệ hơn cho tiền thưởng. Muốn đúng chữ A+ thì
      // đổi nhánh `orderIssue` bên dưới thành return.
      const nullCount: Record<string, number> = {}
      for (const k of ['offline_revenue_null_count', 'offline_order_null_count']) {
        const v = numOrFail(k)
        if (v === null || !Number.isInteger(v) || v < 0 || v > srcCount) {
          return {
            ok: false,
            reason: `Nguồn BQ thiếu/sai canary ${k} tại ${pos}/${date} (=${String(r[k])}, source_row_count=${srcCount}) — COUNTIF phải là số nguyên trong [0, source_row_count]; query hoặc schema đã đổi; giữ snapshot cũ`,
          }
        }
        nullCount[k] = v
      }
      const revNull = nullCount.offline_revenue_null_count
      const ordNull = nullCount.offline_order_null_count

      // ── 105: canary SỐ ĐƠN — kiểm KIỂU trước, dùng cho CẢ HAI nhánh ──
      // r1.3: canary là output COUNTIF ⇒ BẮT BUỘC nguyên >= 0; giá trị âm/lẻ
      // nghĩa là query đã đổi, không được tin.
      const canary: Record<string, number> = {}
      let orderIssue: string | null = null
      for (const k of ['rev_without_order', 'order_without_rev', 'negative_order',
        'non_integer_order', 'revenue_with_zero_order']) {
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

      if (revNull > 0) {
        if (ordNull !== revNull) {
          // Ca NGUY HIỂM duy nhất: có đơn mà không có tiền ⇒ ghi 0đ là ghi sai.
          return {
            ok: false,
            reason: `Nguồn BQ thiếu TIỀN tại ${pos}/${date}: doanh thu NULL ${revNull}/${srcCount} dòng trong khi số đơn NULL ${ordNull} — có giao dịch mà thiếu doanh thu, KHÔNG coi là 0đ; giữ snapshot cũ`,
          }
        }
        // Cả hai field NULL trên MỌI dòng nguồn ⇒ không phát sinh giao dịch.
        // Mọi COUNTIF còn lại BẮT BUỘC = 0 theo định nghĩa, và SUM() của toàn
        // NULL phải ra NULL — khác đi là query đã drift, không được đoán.
        if (orderIssue !== null) {
          return { ok: false, reason: `Nguồn BQ ${orderIssue} tại ${pos}/${date} — giữ snapshot cũ` }
        }
        const dirty = Object.entries(canary).filter(([, v]) => v !== 0)
        if (dirty.length > 0
          || parseSourceNumber(r.gmv) !== null || parseSourceNumber(r.order_count) !== null) {
          return {
            ok: false,
            reason: `Nguồn BQ tự mâu thuẫn tại ${pos}/${date}: cả hai field NULL nhưng gmv=${String(r.gmv)}, order_count=${String(r.order_count)}${dirty.length ? `, canary khác 0 (${dirty.map(([k, v]) => `${k}=${v}`).join(', ')})` : ''}; giữ snapshot cũ`,
          }
        }
        if (!offlineByPos.has(pos)) offlineByPos.set(pos, new Map())
        offlineByPos.get(pos)!.set(date, 0)
        if (!ordersByPos.has(pos)) ordersByPos.set(pos, new Map())
        ordersByPos.get(pos)!.set(date, 0)
        if (!noTxByDate.has(date)) noTxByDate.set(date, new Set())
        noTxByDate.get(date)!.add(pos)
        continue
      }

      // ⚠ 112: field `gmv` là alias của SUM(CAST(offline_net_revenue AS
      // NUMERIC)) — giá trị THÔ, KHÔNG COALESCE. r1.3: thiếu/NaN/chuỗi rác →
      // LỖI NGUỒN (0đ và số ÂM vẫn hợp lệ: hoàn/điều chỉnh).
      const gmv = numOrFail('gmv')
      if (gmv === null) {
        return {
          ok: false,
          reason: `Nguồn BQ thiếu/sai doanh thu tại ${pos}/${date}: gmv=${String(r.gmv)} (kỳ vọng số hữu hạn, 0 và âm đều hợp lệ); giữ snapshot cũ`,
        }
      }
      // 112.4 (audit P1#1): snap về ĐỒNG NGUYÊN ngay tại đây. Nguồn không có
      // phần lẻ VND thật (đo 04/09: lệch tối đa 9,3e-10đ trên 7.139 dòng) nên
      // mọi daily là số nguyên ⇒ SUM của MỌI khoảng con đều bằng
      // ROUND(SUM(raw)) — không cần phân bổ phần dư (cách cũ làm tổng cả kỳ
      // đúng nhưng khoảng con sai). Lệch quá tolerance = BI đổi contract.
      const snapped = snapRevenue(gmv)
      if (snapped === undefined) {
        return {
          ok: false,
          reason: `Nguồn BQ có phần lẻ VND tại ${pos}/${date}: gmv=${String(r.gmv)} (lệch quá ${REVENUE_SNAP_EPSILON}đ so với số nguyên — nguồn đã đổi contract, KHÔNG tự làm tròn tiền); giữ snapshot cũ`,
        }
      }
      if (!offlineByPos.has(pos)) offlineByPos.set(pos, new Map())
      offlineByPos.get(pos)!.set(date, snapped)

      // ── 105: đường BÌNH THƯỜNG của số đơn (doanh thu đã biết) ──
      // Kiểu của canary đã kiểm ở trên; ở đây chỉ diễn giải.
      const ordNum = numOrFail('order_count')
      if (orderIssue === null && ordNum === null) {
        orderIssue = 'thiếu/sai field số đơn (order_count) — query hoặc schema đã đổi'
      } else if (orderIssue === null) {
        if (ordNull > 0) {
          // CÓ TIỀN mà thiếu số đơn ⇒ chỉ số ĐƠN/AOV không tin được, nhưng
          // doanh thu vẫn đúng. strict=true (số đơn LÀ KPI) → preserve;
          // campaign GMV → degrade riêng POS này, tiền VẪN ghi (policy 105 r1.3).
          orderIssue = `số đơn Offline NULL (${ordNull} row) trong khi có doanh thu`
        } else if (canary.non_integer_order > 0) {
          orderIssue = `offline_no_order KHÔNG NGUYÊN (${canary.non_integer_order} row)`
        } else if (canary.revenue_with_zero_order > 0) {
          // Có doanh thu mà 0 đơn ⇒ AOV vô định nhưng vẫn có tiền.
          orderIssue = `có doanh thu nhưng KHÔNG đơn nào (${canary.revenue_with_zero_order} row offline_no_order=0, offline_net_revenue≠0)`
        } else if (canary.rev_without_order > 0 || canary.order_without_rev > 0) {
          orderIssue = `lệch NULL: ${canary.rev_without_order} row có doanh thu thiếu offline_no_order, ${canary.order_without_rev} row có offline_no_order thiếu doanh thu`
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

  // ⚠ BQ-V2 r1 (audit P1#2): EXPECTED COVERAGE — view có row cho MỌI ngày
  // trong kỳ (kể cả ngày chưa tới, đã kiểm 04/09: tháng 9 đủ 25 POS × 30 ngày).
  // Vì vậy mỗi (target POS × ngày) từ start → effectiveEnd PHẢI có row; thiếu ô
  // nào (kể cả 1 ngày giữa kỳ) = nguồn lỗi → PRESERVE, tuyệt đối không ghi
  // snapshot thấp hơn thực tế. Row KHÔNG tồn tại là LỖI; row tồn tại mà doanh
  // thu NULL được xử lý riêng ở vòng đọc bên trên.
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

  // ── A+ : GATE SỰ CỐ ETL ──────────────────────────────────────────────────
  // Cửa hàng đóng cửa là chuyện CỤC BỘ (cao nhất từng thấy: 8/27 POS dịp Tết).
  // Nguồn CHƯA NẠP thì TOÀN BỘ POS cùng NULL trong ngày đó (tháng 9 chưa tới:
  // 25/25). Hai chữ ký không giao nhau ⇒ chỉ chặn khi toàn bộ POS cùng trống,
  // và CHỈ với ngày ĐÃ KẾT THÚC (ngày đang diễn ra trống lúc sáng sớm là đúng).
  if (targetPos.length > 0) {
    for (let d = startISO; d <= effEndISO; d = nextDayISO(d)) {
      if (d >= todayVnISO) continue
      const noTx = noTxByDate.get(d)
      if (noTx && targetPos.every((p) => noTx.has(p))) {
        return {
          ok: false,
          reason: `Nguồn BQ: TOÀN BỘ ${targetPos.length} cửa hàng đều không có giao dịch ngày ${d} (ngày đã kết thúc) — nghi nguồn chưa nạp, KHÔNG ghi 0đ hàng loạt; giữ snapshot cũ`,
        }
      }
    }
  }

  // Warning cho người trực: từng ô 0đ do không phát sinh giao dịch ở ngày đã
  // kết thúc. Ngày đang diễn ra KHÔNG cảnh báo (sẽ là nhiễu mỗi sáng).
  const noTxCells: string[] = []
  for (const d of [...noTxByDate.keys()].sort()) {
    if (d >= todayVnISO) continue
    for (const p of [...(noTxByDate.get(d) as Set<string>)].sort()) noTxCells.push(`${p}/${d}`)
  }
  if (noTxCells.length > 0) {
    const sample = noTxCells.slice(0, 10).join(', ')
    warnings.push(
      `${noTxCells.length} ô (cửa hàng × ngày) KHÔNG phát sinh giao dịch — ghi 0đ/0 đơn: ${sample}${noTxCells.length > 10 ? ', …' : ''}`,
    )
  }

  // DEGRADE (chỉ khi !strict): bỏ số đơn của POS có nguồn hỏng — bỏ CẢ POS để
  // không gửi payload nửa vời (RPC 105 đòi mọi ngày của store phải có count);
  // tiền của POS đó VẪN được ghi bình thường.
  for (const [pos, reason] of orderIssuePos) {
    ordersByPos.delete(pos)
    warnings.push(`Số đơn/AOV Offline tạm ẩn cho ${pos} — nguồn BQ ${reason}. GMV/commission KHÔNG bị ảnh hưởng.`)
  }

  // Giá trị đã được snap về đồng nguyên NGAY khi đọc từng row (112.4) — không
  // còn bước làm tròn tập thể nào ở đây, nên SUM(daily) của mọi khoảng con đều
  // khớp ROUND(SUM(raw)) của chính khoảng đó.
  return { ok: true, offlineByPos, ordersByPos, warnings }
}
