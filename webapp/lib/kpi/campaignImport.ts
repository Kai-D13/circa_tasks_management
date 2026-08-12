// KPI Campaign XLSX parser/validator (dynamic tiers). Kept SEPARATE from the
// weekly-targets normalizeRow (different shape) so a future template change only
// touches this module. Pure: takes raw rows + a pos_code→store_id map.
// Mig 103: BỎ 'server-only' để unit-test được (pattern engine/syncCampaignCore
// — module THUẦN không secret/IO; caller duy nhất vẫn là server action).
//
// v3 policy-model columns (canonicalized): pos_code, kpi_target, store_kpi_group
// (REQUIRED — the store's policy classification label, free text), optional
// pos_name/note, and dynamic tier pairs tier_N_threshold_pct /
// tier_N_commission_amount (fixed amount = the STORE's commission POOL at that
// tier). Transition aliases still read: final_target, tier_N_commission,
// tier_N_commission_pct — but the UI/template only advertise the new format.

export interface CampaignTierInput { tier_order: number; threshold_pct: number; commission_amount: number }
export interface CampaignTargetInput {
  store_id: string
  pos_code: string
  kpi_target: number
  store_kpi_group: string
  import_row: number
  note: string | null
  tiers: CampaignTierInput[]
  // Mig 106 — CHỈ campaign "Chất lượng bán hàng": 4 chỉ số sàn/mục tiêu.
  // Campaign GMV/Số khách KHÔNG set (RPC 106 reverse-guard sẽ RAISE nếu có).
  order_floor?: number
  aov_floor?: number
  order_target?: number
  aov_target?: number
}

// The policy email defines groups with OVERLAPPING boundaries (200tr sits in both
// "<200tr" and "<300tr") — a target exactly on a boundary is ambiguous, so the
// import BLOCKS it and the admin nudges the number per policy.
const GROUP_BOUNDARIES = [200_000_000, 300_000_000, 500_000_000, 800_000_000, 1_000_000_000]
export interface CampaignImportResult {
  valid: CampaignTargetInput[]
  invalid: { row: number; pos_code: string | null; error: string }[]
  unmatched: string[]
}

const MAX_TIERS = 20
const canon = (k: string) => k.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(String(v).replace(/[,\s]/g, ''))
  return Number.isFinite(n) ? n : null
}
function str(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

// Mig 103: parser nhận metricType (đọc từ DB — caller không tin client).
//   · gmv (default): hành vi CŨ NGUYÊN VẸN — kể cả rule ranh giới tiền.
//   · affiliate_customer_count: kpi_target = SỐ KHÁCH → bắt buộc SỐ NGUYÊN
//     dương; BỎ rule GROUP_BOUNDARIES (ranh giới VNĐ vô nghĩa với đơn vị
//     khách); store_kpi_group VẪN bắt buộc nhưng chỉ là NHÃN import (chốt
//     stakeholder 06/08 — không áp monetary boundary). Tier %/commission tiền
//     giữ nguyên cả hai loại.
// Mig 106: + offline_order_aov ("Chất lượng bán hàng") — file CHỈ có 4 chỉ số
// order_floor/aov_floor/order_target/aov_target (KHÔNG có kpi_target: hệ thống
// tự chuẩn hóa = 100; KHÔNG có net_revenue: chỉ tham khảo của Finance, không
// phải cấu hình). Cũng BỎ rule GROUP_BOUNDARIES (ranh giới VNĐ của GMV vô
// nghĩa ở đây và có thể trúng oan giá trị AOV như 190.540 / 194.046).
const AOV_COLUMNS: [key: string, label: string][] = [
  ['orderfloor', 'order_floor'],
  ['aovfloor', 'aov_floor'],
  ['ordertarget', 'order_target'],
  ['aovtarget', 'aov_target'],
]

export function parseCampaignRows(
  rawRows: Record<string, unknown>[],
  byCode: Map<string, string>,
  opts: { metricType?: string } = {},
): CampaignImportResult | { error: string } {
  const isCustomer = opts.metricType === 'affiliate_customer_count'
  const isAov = opts.metricType === 'offline_order_aov'
  if (rawRows.length === 0) return { error: 'File không có dòng dữ liệu nào' }
  const headerKeys = new Set(Object.keys(rawRows[0]).map(canon))
  if (!headerKeys.has('poscode')) return { error: 'Thiếu cột pos_code' }
  if (isAov) {
    for (const [key, label] of AOV_COLUMNS) {
      if (!headerKeys.has(key)) return { error: `Thiếu cột ${label} (chiến dịch Chất lượng bán hàng cần đủ 4 chỉ số)` }
    }
    // Chặn NHẦM LẪN ngay ở tầng file: 2 cột này không phải cấu hình của loại này.
    if (headerKeys.has('kpitarget') || headerKeys.has('finaltarget')) {
      return { error: 'File Chất lượng bán hàng KHÔNG được có cột kpi_target — hệ thống tự chuẩn hóa = 100%' }
    }
    if (headerKeys.has('netrevenue')) {
      return { error: 'File Chất lượng bán hàng KHÔNG được có cột net_revenue — đây là số tham khảo, không phải cấu hình (AOV đã làm tròn VNĐ nên net ≠ order_target × aov_target)' }
    }
  } else if (!headerKeys.has('kpitarget') && !headerKeys.has('finaltarget')) {
    return { error: 'Thiếu cột kpi_target' }
  }
  if (!headerKeys.has('storekpigroup')) return { error: 'Thiếu cột store_kpi_group (phân loại Store theo KPI)' }

  const valid: CampaignTargetInput[] = []
  const invalid: { row: number; pos_code: string | null; error: string }[] = []
  const unmatched = new Set<string>()
  const seen = new Set<string>()

  rawRows.forEach((raw, i) => {
    const rowNo = i + 2 // header = row 1
    const lo: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(raw)) lo[canon(k)] = v

    const posCode = str(lo['poscode'])?.toUpperCase() ?? null
    // Chất lượng bán hàng: kpi_target là ĐIỂM CHUẨN HÓA do hệ thống ép = 100
    // (RPC 106 cũng ép lại — file không quyết định).
    const kpiTargetRaw = isAov ? 100 : (num(lo['kpitarget']) ?? num(lo['finaltarget'])) // alias: v2 files
    const aovCells = AOV_COLUMNS.map(([k]) => num(lo[k]))
    if (!posCode && kpiTargetRaw === null && aovCells.every((v) => v === null)) return // dòng trống → bỏ qua

    if (!posCode) { invalid.push({ row: rowNo, pos_code: null, error: 'Thiếu pos_code' }); return }
    if (seen.has(posCode)) { invalid.push({ row: rowNo, pos_code: posCode, error: 'pos_code trùng trong file' }); return }
    seen.add(posCode)

    const storeId = byCode.get(posCode)
    if (!storeId) { unmatched.add(posCode); invalid.push({ row: rowNo, pos_code: posCode, error: 'pos_code không có trong hệ thống' }); return }

    if (kpiTargetRaw === null || kpiTargetRaw <= 0) { invalid.push({ row: rowNo, pos_code: posCode, error: 'kpi_target phải > 0' }); return }
    if (isCustomer && !Number.isInteger(kpiTargetRaw)) {
      invalid.push({ row: rowNo, pos_code: posCode, error: `kpi_target phải là số nguyên dương (số khách) — nhận ${kpiTargetRaw}` })
      return
    }
    // r1 (audit): rule ranh giới TIỀN chỉ áp cho campaign GMV — campaign khách
    // (đơn vị khách) và Chất lượng bán hàng (điểm 100) đều KHÔNG áp.
    if (!isCustomer && !isAov && GROUP_BOUNDARIES.includes(kpiTargetRaw)) {
      invalid.push({ row: rowNo, pos_code: posCode, error: `kpi_target = ${kpiTargetRaw.toLocaleString('vi-VN')} trùng ranh giới nhóm KPI — chỉnh lại theo policy (nhóm bị chồng biên)` })
      return
    }

    const storeKpiGroup = str(lo['storekpigroup'])
    if (!storeKpiGroup) { invalid.push({ row: rowNo, pos_code: posCode, error: 'Thiếu store_kpi_group (phân loại Store)' }); return }

    // ── Mig 106: 4 chỉ số Order/AOV (mirror validate của RPC — chặn sớm ở UI) ──
    let aovFields: Pick<CampaignTargetInput, 'order_floor' | 'aov_floor' | 'order_target' | 'aov_target'> = {}
    if (isAov) {
      const [orderFloor, aovFloor, orderTarget, aovTarget] = aovCells
      const missing = AOV_COLUMNS.filter((_, k) => aovCells[k] === null).map(([, label]) => label)
      if (missing.length > 0) {
        invalid.push({ row: rowNo, pos_code: posCode, error: `Thiếu ${missing.join(', ')}` }); return
      }
      const vals: [number, string][] = [
        [orderFloor as number, 'order_floor'], [aovFloor as number, 'aov_floor'],
        [orderTarget as number, 'order_target'], [aovTarget as number, 'aov_target'],
      ]
      for (const [v, label] of vals) {
        if (v <= 0) { invalid.push({ row: rowNo, pos_code: posCode, error: `${label} phải > 0` }); return }
        if (!Number.isInteger(v)) {
          invalid.push({
            row: rowNo, pos_code: posCode,
            error: label.startsWith('order') ? `${label} phải là số nguyên (số đơn)` : `${label} phải là số nguyên (VNĐ)`,
          })
          return
        }
      }
      if ((orderTarget as number) < (orderFloor as number)) {
        invalid.push({ row: rowNo, pos_code: posCode, error: 'order_target phải >= order_floor' }); return
      }
      if ((aovTarget as number) < (aovFloor as number)) {
        invalid.push({ row: rowNo, pos_code: posCode, error: 'aov_target phải >= aov_floor' }); return
      }
      aovFields = {
        order_floor: orderFloor as number, aov_floor: aovFloor as number,
        order_target: orderTarget as number, aov_target: aovTarget as number,
      }
    }

    // Dynamic tiers: read pairs until both empty. Commission = fixed POOL amount
    // (tier_N_commission_amount); v2/v1 aliases accepted.
    const tiers: CampaignTierInput[] = []
    let tierErr: string | null = null
    for (let n = 1; n <= MAX_TIERS; n++) {
      const th = num(lo[`tier${n}thresholdpct`])
      const cm = num(lo[`tier${n}commissionamount`]) ?? num(lo[`tier${n}commission`]) ?? num(lo[`tier${n}commissionpct`])
      if (th === null && cm === null) break
      if (th === null || cm === null) { tierErr = `Bậc ${n}: thiếu mốc % hoặc tiền thưởng`; break }
      if (th <= 0) { tierErr = `Bậc ${n}: mốc % phải > 0`; break }
      if (cm < 0) { tierErr = `Bậc ${n}: tiền thưởng phải ≥ 0`; break }
      tiers.push({ tier_order: n, threshold_pct: th, commission_amount: cm })
    }
    if (tierErr) { invalid.push({ row: rowNo, pos_code: posCode, error: tierErr }); return }
    if (tiers.length === 0) { invalid.push({ row: rowNo, pos_code: posCode, error: 'Cần ít nhất 1 bậc target' }); return }
    for (let k = 1; k < tiers.length; k++) {
      if (tiers[k].threshold_pct <= tiers[k - 1].threshold_pct) {
        invalid.push({ row: rowNo, pos_code: posCode, error: 'Threshold các bậc phải tăng dần' })
        return
      }
    }

    valid.push({
      store_id: storeId, pos_code: posCode, kpi_target: kpiTargetRaw,
      store_kpi_group: storeKpiGroup, import_row: rowNo, note: str(lo['note']), tiers,
      ...aovFields,
    })
  })

  return { valid, invalid, unmatched: [...unmatched] }
}
