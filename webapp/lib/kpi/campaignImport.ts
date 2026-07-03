import 'server-only'

// KPI Campaign XLSX parser/validator (dynamic tiers). Kept SEPARATE from the
// weekly-targets normalizeRow (different shape) so a future template change only
// touches this module. Pure: takes raw rows + a pos_code→store_id map.
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

export function parseCampaignRows(
  rawRows: Record<string, unknown>[],
  byCode: Map<string, string>,
): CampaignImportResult | { error: string } {
  if (rawRows.length === 0) return { error: 'File không có dòng dữ liệu nào' }
  const headerKeys = new Set(Object.keys(rawRows[0]).map(canon))
  if (!headerKeys.has('poscode')) return { error: 'Thiếu cột pos_code' }
  if (!headerKeys.has('kpitarget') && !headerKeys.has('finaltarget')) return { error: 'Thiếu cột kpi_target' }
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
    const kpiTargetRaw = num(lo['kpitarget']) ?? num(lo['finaltarget']) // alias: v2 files
    if (!posCode && kpiTargetRaw === null) return // fully-empty row → skip

    if (!posCode) { invalid.push({ row: rowNo, pos_code: null, error: 'Thiếu pos_code' }); return }
    if (seen.has(posCode)) { invalid.push({ row: rowNo, pos_code: posCode, error: 'pos_code trùng trong file' }); return }
    seen.add(posCode)

    const storeId = byCode.get(posCode)
    if (!storeId) { unmatched.add(posCode); invalid.push({ row: rowNo, pos_code: posCode, error: 'pos_code không có trong hệ thống' }); return }

    if (kpiTargetRaw === null || kpiTargetRaw <= 0) { invalid.push({ row: rowNo, pos_code: posCode, error: 'kpi_target phải > 0' }); return }
    if (GROUP_BOUNDARIES.includes(kpiTargetRaw)) {
      invalid.push({ row: rowNo, pos_code: posCode, error: `kpi_target = ${kpiTargetRaw.toLocaleString('vi-VN')} trùng ranh giới nhóm KPI — chỉnh lại theo policy (nhóm bị chồng biên)` })
      return
    }

    const storeKpiGroup = str(lo['storekpigroup'])
    if (!storeKpiGroup) { invalid.push({ row: rowNo, pos_code: posCode, error: 'Thiếu store_kpi_group (phân loại Store)' }); return }

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

    valid.push({ store_id: storeId, pos_code: posCode, kpi_target: kpiTargetRaw, store_kpi_group: storeKpiGroup, import_row: rowNo, note: str(lo['note']), tiers })
  })

  return { valid, invalid, unmatched: [...unmatched] }
}
