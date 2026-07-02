import 'server-only'

// KPI Campaign XLSX parser/validator (dynamic tiers). Kept SEPARATE from the
// weekly-targets normalizeRow (different shape) so a future template change only
// touches this module. Pure: takes raw rows + a pos_code→store_id map.
//
// Expected columns (canonicalized): pos_code, final_target, optional pos_name/note,
// and dynamic tier pairs tier_1_threshold_pct / tier_1_commission (FIXED AMOUNT,
// v2), tier_2_*, … The legacy header tier_N_commission_pct is still accepted as
// an alias so files made for Phase 1 don't break.

export interface CampaignTierInput { tier_order: number; threshold_pct: number; commission_amount: number }
export interface CampaignTargetInput {
  store_id: string
  pos_code: string
  final_target: number
  import_row: number
  note: string | null
  tiers: CampaignTierInput[]
}
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
  if (!headerKeys.has('finaltarget')) return { error: 'Thiếu cột final_target' }

  const valid: CampaignTargetInput[] = []
  const invalid: { row: number; pos_code: string | null; error: string }[] = []
  const unmatched = new Set<string>()
  const seen = new Set<string>()

  rawRows.forEach((raw, i) => {
    const rowNo = i + 2 // header = row 1
    const lo: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(raw)) lo[canon(k)] = v

    const posCode = str(lo['poscode'])?.toUpperCase() ?? null
    const finalTargetRaw = num(lo['finaltarget'])
    if (!posCode && finalTargetRaw === null) return // fully-empty row → skip

    if (!posCode) { invalid.push({ row: rowNo, pos_code: null, error: 'Thiếu pos_code' }); return }
    if (seen.has(posCode)) { invalid.push({ row: rowNo, pos_code: posCode, error: 'pos_code trùng trong file' }); return }
    seen.add(posCode)

    const storeId = byCode.get(posCode)
    if (!storeId) { unmatched.add(posCode); invalid.push({ row: rowNo, pos_code: posCode, error: 'pos_code không có trong hệ thống' }); return }

    if (finalTargetRaw === null || finalTargetRaw <= 0) { invalid.push({ row: rowNo, pos_code: posCode, error: 'final_target phải > 0' }); return }

    // Dynamic tiers: read pairs until both empty. Commission = fixed amount
    // (tier_N_commission); legacy tier_N_commission_pct accepted as alias.
    const tiers: CampaignTierInput[] = []
    let tierErr: string | null = null
    for (let n = 1; n <= MAX_TIERS; n++) {
      const th = num(lo[`tier${n}thresholdpct`])
      const cm = num(lo[`tier${n}commission`]) ?? num(lo[`tier${n}commissionpct`])
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

    valid.push({ store_id: storeId, pos_code: posCode, final_target: finalTargetRaw, import_row: rowNo, note: str(lo['note']), tiers })
  })

  return { valid, invalid, unmatched: [...unmatched] }
}
