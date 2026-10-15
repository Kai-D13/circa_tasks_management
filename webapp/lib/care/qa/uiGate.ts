import { careFlagsFromEnv } from '@/lib/care/config'
import type { CareImportLookups } from '@/lib/care/import/preview'
import type { CareQaIssueCode } from './labels'

// CRM-CSKH B6-qa-ui — cổng "chế độ QA browser" (THUẦN, không IO). PM audit 10/10 (b1-pilot §4–5).
//
// Mục đích: chạy đúng route/view/action CRM trên dev server LOCAL trỏ DB prod, nhưng chỉ với
// dữ liệu giả `is_test` của MỘT batch đã chuẩn bị bằng `scripts/care-qa-fixture.mjs prepare`.
//
// Ba trạng thái:
//   · off      — mọi build production + mọi dev server không bật CARE_QA_UI: hành vi production y nguyên.
//   · blocked  — có CARE_QA_UI nhưng thiếu/sai điều kiện ⇒ CRM TẮT trên server này (fail-closed: không
//                bao giờ rơi về chế độ thường, nơi file QA sẽ thành dữ liệu thật is_test=false).
//   · active   — đủ điều kiện ⇒ import QA ghi is_test=true, mọi màn chỉ thấy task của batch trong marker.
//
// Điều kiện active (tất cả):
//   1. NODE_ENV === 'development' (next dev; `next build` luôn production ⇒ không mở được trên Coolify);
//   2. CARE_QA_UI=YES; các biến QA chỉ ở env PROCESS (khai trong file .env* ⇒ chặn), CARE_ENABLED/
//      CARE_SYNC_ENABLED không được đặt `true` trong file .env*;
//   3. CARE_ENABLED=true, CARE_SYNC_ENABLED khác true (cron/N3 không chạy trên ID giả);
//   4. bind loopback (CARE_QA_UI_BIND do launcher đặt, kèm `next dev -H`), Host của từng request là loopback;
//   5. E2E_EXPECTED_SUPABASE_HOST gõ lại trùng host NEXT_PUBLIC_SUPABASE_URL;
//   6. marker `.qa-care.json` kind 'ui' hợp lệ, cùng host, cùng kỳ VN hiện tại, chưa tearing_down;
//   7. (theo request) người đăng nhập là một trong các tài khoản QA trong marker.

export const CARE_QA_MARKER_FILE = '.qa-care.json'
export const CARE_QA_LOCK_FILE = '.qa-care.json.lock'
export const CARE_QA_UI_FLAG = 'CARE_QA_UI'
export const CARE_QA_UI_BIND_ENV = 'CARE_QA_UI_BIND'
/** File env Next nạp ở chế độ development (thư mục app). */
export const CARE_QA_ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local'] as const
/** Chỉ được nằm trong env PROCESS của lần chạy QA. */
export const CARE_QA_UI_PROCESS_ONLY = [CARE_QA_UI_FLAG, CARE_QA_UI_BIND_ENV, 'E2E_CARE_WRITE_QA', 'E2E_EXPECTED_SUPABASE_HOST'] as const
/** Không được BẬT (=true) trong file env — chỉ bật trong process của server QA. */
const CARE_FLAGS_PROCESS_ONLY_TRUE = ['CARE_ENABLED', 'CARE_SYNC_ENABLED'] as const
export const CARE_QA_UI_ID_PREFIX = 'QA-UI-'
/**
 * Trần số khách giả trong MỘT marker. Bản sao QA từ file mẫu (`prepare`) tự giới hạn 200 khách; QA tải Q-121
 * (`prepare-load`, tới trần dòng của app — tối đa 20.000 dòng ~8.000 khách khi trần được nâng) cần marker lớn hơn ⇒ 10.000.
 */
export const CARE_QA_UI_MAX_CUSTOMERS = 10_000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const RUN_RE = /^[0-9a-f]{8}$/

/** ID khách giả của một lượt QA UI — suy ra từ runId (down kiểm lại đúng tập này). */
export function careQaUiExternalIds(runId: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${CARE_QA_UI_ID_PREFIX}${runId}-${String(i + 1).padStart(3, '0')}`)
}

export type CareQaUiPhase = 'reserved' | 'importing' | 'imported' | 'tearing_down'
export type CareQaUiImportResult = 'committed' | 'rejected' | 'duplicate' | 'failed'

export interface CareQaUiMarker {
  v: 2
  kind: 'ui'
  runId: string
  host: string
  createdAt: string
  /** Kỳ VN (YYYY-MM-01) lúc prepare — server chỉ active trong đúng kỳ này. */
  period: string
  phase: CareQaUiPhase
  /** ID batch định trước — import QA ghi đúng id này. */
  batchId: string
  /** sha256 của file QA đã sinh — server chỉ import đúng file này. */
  fileSha256: string
  externalIds: string[]
  accounts: { super: string; marketing: string; sm: string; staff: string[] }
  storeIds: string[]
  importResult?: CareQaUiImportResult
  customerIds?: string[]
  taskIds?: string[]
}

const uuidList = (a: unknown, min: number, max: number) =>
  Array.isArray(a) && a.length >= min && a.length <= max && a.every((x) => typeof x === 'string' && UUID_RE.test(x)) && new Set(a).size === a.length

/** Marker QA UI hợp lệ ⇒ object; sai bất kỳ trường nào ⇒ null (server chặn, CLI báo MARKER_INVALID). */
export function parseCareQaUiMarker(raw: unknown): CareQaUiMarker | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const m = raw as Record<string, unknown>
  if (m.v !== 2 || m.kind !== 'ui') return null
  if (typeof m.runId !== 'string' || !RUN_RE.test(m.runId)) return null
  if (typeof m.host !== 'string' || !m.host || typeof m.createdAt !== 'string') return null
  if (typeof m.period !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])-01$/.test(m.period)) return null
  if (!['reserved', 'importing', 'imported', 'tearing_down'].includes(m.phase as string)) return null
  if (typeof m.batchId !== 'string' || !UUID_RE.test(m.batchId)) return null
  if (typeof m.fileSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.fileSha256)) return null
  const ext = m.externalIds
  if (!Array.isArray(ext) || ext.length < 1 || ext.length > CARE_QA_UI_MAX_CUSTOMERS) return null
  const want = new Set(careQaUiExternalIds(m.runId, ext.length))
  if (new Set(ext).size !== ext.length || !ext.every((x) => typeof x === 'string' && want.has(x))) return null
  const a = m.accounts as Record<string, unknown> | null
  if (!a || typeof a !== 'object') return null
  const single = [a.super, a.marketing, a.sm]
  if (!single.every((x) => typeof x === 'string' && UUID_RE.test(x)) || !uuidList(a.staff, 1, 4)) return null
  const all = [...(single as string[]), ...(a.staff as string[])]
  if (new Set(all).size !== all.length) return null
  if (!uuidList(m.storeIds, 1, 4)) return null
  if (m.importResult !== undefined && !['committed', 'rejected', 'duplicate', 'failed'].includes(m.importResult as string)) return null
  if (m.customerIds !== undefined && !uuidList(m.customerIds, 0, CARE_QA_UI_MAX_CUSTOMERS)) return null
  if (m.taskIds !== undefined && !uuidList(m.taskIds, 0, CARE_QA_UI_MAX_CUSTOMERS)) return null
  return m as unknown as CareQaUiMarker
}

export const careQaUiAccountIds = (m: CareQaUiMarker) => [m.accounts.super, m.accounts.marketing, m.accounts.sm, ...m.accounts.staff]
export const careQaUiImporterIds = (m: CareQaUiMarker) => [m.accounts.super, m.accounts.marketing]

export type CareQaBlockReason =
  | 'NOT_QA_LAUNCH' | 'FLAG_VALUE' | 'FLAG_IN_ENV_FILE' | 'CARE_DISABLED' | 'SYNC_ON' | 'BIND' | 'HOST'
  | 'NO_MARKER' | 'MARKER_INVALID' | 'MARKER_HOST' | 'MARKER_PERIOD' | 'MARKER_TEARDOWN'

export type CareQaUiState =
  | { kind: 'off' }
  | { kind: 'blocked'; reason: CareQaBlockReason }
  | { kind: 'active'; marker: CareQaUiMarker }

export const CARE_QA_OFF: CareQaUiState = { kind: 'off' }

function urlHostname(url: string | undefined): string | null {
  if (!url) return null
  try { return new URL(url).hostname || null } catch { return null }
}

/** Loại marker trong file (không validate đầy đủ): 'ui' = lượt QA browser; 'unreadable' = file hỏng (coi như có thể là UI). */
function markerKind(markerText: string | null): string | null {
  if (markerText === null) return null
  try {
    const m = JSON.parse(markerText) as { kind?: unknown } | null
    return m && typeof m === 'object' && typeof m.kind === 'string' ? m.kind : null
  } catch {
    return 'unreadable'
  }
}

/** File env khai biến (kể cả dạng `export KEY=` và thụt đầu dòng). */
const declares = (text: string, key: string) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`, 'm').test(text)
const declaresTrue = (text: string, key: string) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*["']?true["']?\\s*$`, 'm').test(text)

/**
 * Đánh giá cổng (đồng bộ, không IO). `markerText` = nội dung `.qa-care.json` (null nếu không có),
 * `envFiles` = nội dung các file env Next nạp, `period` = kỳ VN hiện tại.
 */
export function evaluateCareQaUi(input: {
  nodeEnv: string | undefined
  env: Record<string, string | undefined>
  envFiles: readonly { name: string; text: string | null }[]
  markerText: string | null
  period: string
}): CareQaUiState {
  const { nodeEnv, env, envFiles, markerText, period } = input
  if (nodeEnv !== 'development') return CARE_QA_OFF
  const block = (reason: CareQaBlockReason): CareQaUiState => ({ kind: 'blocked', reason })
  const flag = env[CARE_QA_UI_FLAG]
  if (flag === undefined || flag === '') {
    // Security B6-qa-ui P1-1: còn marker QA UI mà dev server KHÔNG chạy qua `serve` (thiếu cờ) ⇒ không được
    // chạy ngữ nghĩa production — file QA sẽ thành dữ liệu thật is_test=false. Chặn CRM tới khi dọn marker.
    const kind = markerKind(markerText)
    return kind === 'ui' || kind === 'unreadable' ? block('NOT_QA_LAUNCH') : CARE_QA_OFF
  }
  if (flag !== 'YES') return block('FLAG_VALUE')
  for (const f of envFiles) {
    if (f.text === null) continue
    if (CARE_QA_UI_PROCESS_ONLY.some((k) => declares(f.text as string, k))) return block('FLAG_IN_ENV_FILE')
    if (CARE_FLAGS_PROCESS_ONLY_TRUE.some((k) => declaresTrue(f.text as string, k))) return block('FLAG_IN_ENV_FILE')
  }
  const flags = careFlagsFromEnv(env)
  if (!flags.enabled) return block('CARE_DISABLED')
  if (flags.syncEnabled) return block('SYNC_ON')
  if (!['127.0.0.1', '::1'].includes(env[CARE_QA_UI_BIND_ENV] ?? '')) return block('BIND')
  const host = urlHostname(env.NEXT_PUBLIC_SUPABASE_URL)
  if (!host || env.E2E_EXPECTED_SUPABASE_HOST !== host) return block('HOST')
  if (markerText === null) return block('NO_MARKER')
  let raw: unknown
  try { raw = JSON.parse(markerText) } catch { return block('MARKER_INVALID') }
  const marker = parseCareQaUiMarker(raw)
  if (!marker) return block('MARKER_INVALID')
  if (marker.host !== host) return block('MARKER_HOST')
  if (marker.period !== period) return block('MARKER_PERIOD')
  if (marker.phase === 'tearing_down') return block('MARKER_TEARDOWN')
  return { kind: 'active', marker }
}

/** Header Host là loopback (localhost / 127.0.0.1 / [::1], có hoặc không cổng). */
export function isLoopbackHostHeader(host: string | null | undefined): boolean {
  if (!host) return false
  const h = host.trim().toLowerCase()
  const name = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0]
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]'
}

/** Kiểm theo request khi QA active: Host loopback + tài khoản QA được chỉ định. */
export function careQaRequestAllowed(state: CareQaUiState, input: { hostHeader: string | null; userId: string }): boolean {
  if (state.kind === 'off') return true
  if (state.kind === 'blocked') return false
  return isLoopbackHostHeader(input.hostHeader) && careQaUiAccountIds(state.marker).includes(input.userId)
}

// ── Import QA ────────────────────────────────────────────────────────────────
/** Phần marker handler import cần (không đưa đường dẫn file/IO vào lõi handler). */
export interface CareImportQaMarker {
  batchId: string
  fileSha256: string
  externalIds: readonly string[]
  period: string
  phase: CareQaUiPhase
  importerIds: readonly string[]
  staffIds: readonly string[]
}

export function careImportQaMarker(m: CareQaUiMarker): CareImportQaMarker {
  return {
    batchId: m.batchId, fileSha256: m.fileSha256, externalIds: m.externalIds, period: m.period, phase: m.phase,
    importerIds: careQaUiImporterIds(m), staffIds: m.accounts.staff,
  }
}

/**
 * Lý do KHÔNG cho import QA (rỗng = được). File không phải bản QA ⇒ chỉ QA_FILE_NOT_MARKED (preview vẫn chạy
 * chỉ đọc theo ngữ nghĩa production). `lookups` phải nạp với isTest=true cho file QA.
 */
export function careQaCommitIssues(input: {
  marker: CareImportQaMarker
  sha256: string
  actorId: string
  period: string
  externalIds: readonly string[]
  /** Email dược sĩ (đã lower/trim) theo từng khách trong file. */
  emails: readonly string[]
  lookups: Pick<CareImportLookups, 'customers' | 'staff' | 'currentPeriodTaskCount' | 'openPreviousPeriodCount'>
}): CareQaIssueCode[] {
  const { marker, lookups } = input
  if (input.sha256 !== marker.fileSha256) return ['QA_FILE_NOT_MARKED']
  const out: CareQaIssueCode[] = []
  if (marker.phase !== 'reserved') out.push('QA_ALREADY_USED')
  if (input.period !== marker.period) out.push('QA_PERIOD')
  if (!marker.importerIds.includes(input.actorId)) out.push('QA_IMPORTER')
  const want = new Set(marker.externalIds)
  const got = new Set(input.externalIds)
  if (got.size !== want.size || [...got].some((x) => !want.has(x))) out.push('QA_IDS_MISMATCH')
  if ([...want].some((x) => lookups.customers.has(x)) || [...got].some((x) => lookups.customers.has(x))) out.push('QA_ID_CLASH')
  const staffOk = input.emails.every((e) => {
    const hits = lookups.staff.filter((s) => s.email === e)
    return hits.length > 0 && hits.every((s) => marker.staffIds.includes(s.id))
  })
  if (!staffOk) out.push('QA_ASSIGNEE')
  if (lookups.openPreviousPeriodCount > 0) out.push('QA_OPEN_PREVIOUS')
  if (lookups.currentPeriodTaskCount > 0) out.push('QA_TEST_TASKS_EXIST')
  return out
}
