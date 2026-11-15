import 'server-only'
import { cmsCalcFlags } from '@/lib/cms/flags'
import { cmsBasisSelectable, type CmsBasisEnv } from '@/lib/cms/programBasisPlan'
import type { CmsProgramBasis } from '@/lib/cms/calc/basisUi'
import { cmsLoadProgramBasis, cmsProgramModesPath, getCmsCapabilityState } from './capabilities'

// CMS-CALC-RET-2 P5.1 — môi trường cách tính cho trang quản trị (cờ + năng lực DB) và cách tính của chương trình để hiển thị.
// `basis` của một chương trình: undefined = DB trước 130 (không có khái niệm); null = DB 130 nhưng không đọc được / năng lực lệch
// (trang hiện "không đọc được", không giả cộng dồn); object = đọc được.

export async function cmsBasisEnv(): Promise<CmsBasisEnv & { selectable: boolean }> {
  const s = await getCmsCapabilityState()
  const env: CmsBasisEnv = { modesOn: cmsCalcFlags().modes, caps: s.kind, modesPath: cmsProgramModesPath(s) }
  return { ...env, selectable: cmsBasisSelectable(env) }
}

export async function cmsProgramBasisFor(env: CmsBasisEnv, ids: readonly string[]): Promise<Map<string, CmsProgramBasis | null> | undefined> {
  if (env.caps === 'pre130') return undefined
  const out = new Map<string, CmsProgramBasis | null>(ids.map((id) => [id, null]))
  if (env.caps !== 'ok' || !env.modesPath || ids.length === 0) return out
  const r = await cmsLoadProgramBasis(ids)
  if (!r.ok) return out
  for (const [id, b] of r.data) out.set(id, b)
  return out
}
