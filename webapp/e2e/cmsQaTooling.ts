// CMS P1-R1 / P1-R2 (review PM runbook P1, 02/11/2026) — phần THUẦN của công cụ QA ghi prod và gói VERIFY chỉ đọc.
// Không IO / mạng / secret. Script operator (scripts/cms-qa-access.mjs, cms-qa-run.mjs, cms-verify.mjs) nạp file này
// qua jiti; test: e2e/cms-qa-tooling.spec.ts (thuần) + scripts/qa-cms-qa-tooling.mjs (PGlite, migration 120 / 121 thật).
//
// SQL ở đây là MẪU CỐ ĐỊNH. pg-meta không nhận tham số ⇒ chỉ chèn giá trị đã qua kiểm chặt (UUID theo regex, số nguyên
// trong khoảng, timestamp ISO UTC theo regex) và builder kiểm lại lần nữa trước khi chèn. Không có đường nhận SQL tự do.
// pg-meta (probe prod chỉ đọc 02/11): trả result set CUỐI CÙNG CÓ ≥ 1 DÒNG trong lô; chỉ có câu rỗng ⇒ []; timestamptz
// dạng text `2026-11-02 04:09:18.373453+00`. ⇒ Mỗi lô chỉ có MỘT câu trả dòng (bước trung gian dùng DO / PERFORM / SET).
// Đọc: `BEGIN; SET TRANSACTION READ ONLY; …; ROLLBACK;`. Ghi (chỉ cms_qa_access, chỉ script operator có --confirm): `BEGIN; …; COMMIT;`.
// Lọc tên hàm / bảng CMS bằng left(…) (không LIKE '\_' — không phụ thuộc standard_conforming_strings).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/

/** = CHECK cms_qa_access_ttl (migration 120): expires_at ≤ granted_at + 7 ngày, granted_at = now() của DB (trigger). */
export const CMS_QA_TTL_MAX_HOURS = 168
export const CMS_QA_MAX_USERS = 20
/** Nhãn người cấp — KHÔNG chứa email (CHECK 120: không có '@'). */
export const CMS_QA_GRANTED_BY = 'qa-script:operator'
export const CMS_QA_MIN_TTL_MINUTES_DEFAULT = 60
/** Launcher dừng server QA khi marker của bất kỳ tài khoản QA còn dưới ngưỡng này (marker hết hạn ⇒ chương trình THẬT). */
export const CMS_QA_GUARD_MINUTES_DEFAULT = 10

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string }

export function isCmsUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v)
}

/** Danh sách user_id (UUID) phân tách dấu phẩy. Không nhận email / tên — công cụ không in hay tra theo email. */
export function parseCmsQaUserIds(raw: string | undefined | null): Parsed<string[]> {
  if (raw === undefined || raw === null || raw.trim() === '') return { ok: false, reason: 'thiếu --users=<uuid,uuid,…>' }
  if (raw.includes('@')) return { ok: false, reason: '--users chỉ nhận user_id dạng UUID, không nhận email' }
  const ids = raw.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s !== '')
  const bad = ids.filter((s) => !UUID_RE.test(s))
  if (bad.length) return { ok: false, reason: `${bad.length} giá trị không phải UUID` }
  const uniq = [...new Set(ids)]
  if (uniq.length === 0) return { ok: false, reason: 'danh sách rỗng' }
  if (uniq.length > CMS_QA_MAX_USERS) return { ok: false, reason: `tối đa ${CMS_QA_MAX_USERS} tài khoản mỗi lần` }
  return { ok: true, value: uniq.sort() }
}

/** Hạn marker theo giờ, số nguyên 1…168 (≤ 7 ngày theo giờ DB). */
export function parseCmsQaTtlHours(raw: string | undefined | null): Parsed<number> {
  if (raw === undefined || raw === null || !/^[0-9]{1,4}$/.test(raw.trim())) return { ok: false, reason: '--ttl-hours phải là số nguyên giờ' }
  const n = Number(raw.trim())
  if (n < 1 || n > CMS_QA_TTL_MAX_HOURS) return { ok: false, reason: `--ttl-hours phải trong 1…${CMS_QA_TTL_MAX_HOURS} (≤ 7 ngày)` }
  return { ok: true, value: n }
}

export function parseCmsQaMinutes(raw: string | undefined | null, fallback: number): Parsed<number> {
  if (raw === undefined || raw === null) return { ok: true, value: fallback }
  if (!/^[0-9]{1,5}$/.test(raw.trim())) return { ok: false, reason: 'số phút phải là số nguyên' }
  const n = Number(raw.trim())
  if (n < 1 || n > CMS_QA_TTL_MAX_HOURS * 60) return { ok: false, reason: 'số phút ngoài khoảng' }
  return { ok: true, value: n }
}

/** Che UUID trong log / report: 8 ký tự đầu. */
export function maskCmsUuid(id: string): string {
  return isCmsUuid(id) ? `${id.slice(0, 8)}…` : '—'
}

function uuidArrayLiteral(ids: readonly string[]): string {
  if (ids.length === 0 || ids.length > CMS_QA_MAX_USERS * 10 || !ids.every(isCmsUuid) || new Set(ids).size !== ids.length) {
    throw new Error('CMS QA SQL: danh sách UUID không hợp lệ (rỗng / sai / trùng)')
  }
  return `'{${ids.join(',')}}'::uuid[]`
}

function isoUtcLiteral(ts: string): string {
  if (!ISO_UTC_RE.test(ts) || Number.isNaN(Date.parse(ts))) throw new Error('CMS QA SQL: timestamp không hợp lệ')
  return `'${ts}'::timestamptz`
}

export function pgMetaReadOnly(statements: string): string {
  return `BEGIN; SET TRANSACTION READ ONLY; ${statements.trim().replace(/;\s*$/, '')}; ROLLBACK;`
}
export function pgMetaWrite(statements: string): string {
  return `BEGIN; ${statements.trim().replace(/;\s*$/, '')}; COMMIT;`
}

const PG_TS_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}(?::?\d{2})?)$/

/**
 * Timestamp DB ⇒ ISO UTC (ms). Nhận Date (PGlite) hoặc chuỗi: ISO, hoặc text Postgres mà pg-meta trả
 * (`2026-11-02 04:09:18.373453+00`); tự chuẩn hoá thay vì dựa parser "legacy" của engine JS.
 */
export function toIsoUtc(ts: unknown): string {
  let d: Date
  if (ts instanceof Date) d = ts
  else {
    let s = String(ts).trim()
    const m = PG_TS_RE.exec(s)
    if (m) {
      let off = m[3]
      if (/^[+-]\d{2}$/.test(off)) off += ':00'
      else if (/^[+-]\d{4}$/.test(off)) off = `${off.slice(0, 3)}:${off.slice(3)}`
      const frac = m[2].includes('.') ? m[2].replace(/(\.\d{3})\d+$/, '$1') : m[2]
      s = `${m[1]}T${frac}${off}`
    }
    d = new Date(s)
  }
  if (Number.isNaN(d.getTime())) throw new Error('timestamp không hợp lệ')
  return d.toISOString()
}

// ── Marker QA (cms_qa_access) ────────────────────────────────────────────────

/** Trạng thái tài khoản + marker (chỉ id / vai / loại nhà thuốc — không email, không tên). Một câu SELECT. */
export function cmsQaStatusSql(ids: readonly string[]): string {
  return `SELECT r.id::text AS user_id, (u.id IS NOT NULL) AS user_exists, u.role::text AS role,
       s.store_type::text AS store_type, s.is_active AS store_active,
       q.granted_by, q.granted_at, q.expires_at, now() AS db_now,
       (q.expires_at IS NOT NULL AND q.expires_at > now()) AS active,
       CASE WHEN q.expires_at > now() THEN floor(extract(epoch FROM q.expires_at - now()))::int ELSE 0 END AS remaining_s
  FROM unnest(${uuidArrayLiteral(ids)}) WITH ORDINALITY AS r(id, ord)
  LEFT JOIN public.users u ON u.id = r.id
  LEFT JOIN public.stores s ON s.id = u.store_id
  LEFT JOIN public.cms_qa_access q ON q.user_id = r.id
 ORDER BY r.ord`
}

/**
 * Cấp / gia hạn marker: mọi id phải là tài khoản có thật (thiếu ⇒ RAISE, không cấp phần nào); expires_at = now() của
 * DB + H giờ; trigger 120 ép granted_at = now() ⇒ hạn neo giờ DB. Upsert theo PK user_id.
 */
export function cmsQaGrantSql(ids: readonly string[], ttlHours: number): string {
  if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > CMS_QA_TTL_MAX_HOURS) throw new Error('CMS QA SQL: TTL không hợp lệ')
  const arr = uuidArrayLiteral(ids)
  return `DO $cmsqa$
BEGIN
  IF (SELECT count(*) FROM public.users WHERE id = ANY(${arr})) <> ${ids.length} THEN
    RAISE EXCEPTION 'CMS_QA_UNKNOWN_USER';
  END IF;
END
$cmsqa$;
INSERT INTO public.cms_qa_access (user_id, granted_by, expires_at)
SELECT r.id, '${CMS_QA_GRANTED_BY}', now() + make_interval(hours => ${ttlHours})
  FROM unnest(${arr}) AS r(id)
ON CONFLICT (user_id) DO UPDATE SET granted_by = EXCLUDED.granted_by, expires_at = EXCLUDED.expires_at
RETURNING user_id::text AS user_id, granted_at, expires_at, now() AS db_now`
}

/** Thu marker: DELETE có WHERE theo đúng danh sách user_id (pg_safeupdate; không xoá rộng). */
export function cmsQaRevokeSql(ids: readonly string[]): string {
  return `DELETE FROM public.cms_qa_access WHERE user_id = ANY(${uuidArrayLiteral(ids)}) RETURNING user_id::text AS user_id`
}

export interface CmsQaStatusRow {
  user_id: string
  user_exists: boolean
  role: string | null
  store_type: string | null
  store_active: boolean | null
  granted_by: string | null
  granted_at: unknown
  expires_at: unknown
  db_now: unknown
  active: boolean
  remaining_s: number
}

export interface CmsQaPreflightUser { id: string; role: string | null; markerExpiresAt: string; remainingS: number }

/**
 * Preflight trước run QA ghi: mọi tài khoản QA phải tồn tại và có marker CÒN HẠN theo giờ DB, còn ≥ min phút (marker hết
 * hạn giữa run ⇒ super tạo chương trình THẬT thay vì is_test — cmsPrograms.ts lấy is_test theo marker lúc ghi).
 */
export function cmsQaPreflight(
  rows: readonly CmsQaStatusRow[], requested: readonly string[], minTtlMinutes: number,
): { ok: true; users: CmsQaPreflightUser[]; dbNow: string } | { ok: false; reasons: string[] } {
  const reasons: string[] = []
  const byId = new Map(rows.map((r) => [r.user_id, r]))
  if (rows.length !== requested.length || requested.some((id) => !byId.has(id))) reasons.push('kết quả trạng thái không khớp danh sách yêu cầu')
  const users: CmsQaPreflightUser[] = []
  for (const id of requested) {
    const r = byId.get(id)
    if (!r) continue
    const m = maskCmsUuid(id)
    if (!r.user_exists) { reasons.push(`${m}: không có tài khoản`); continue }
    if (!r.active || !r.expires_at) { reasons.push(`${m}: chưa có marker QA hoặc đã hết hạn`); continue }
    if (!Number.isInteger(r.remaining_s) || r.remaining_s < minTtlMinutes * 60) {
      reasons.push(`${m}: marker còn ${Math.floor((r.remaining_s || 0) / 60)} phút < tối thiểu ${minTtlMinutes} phút — gia hạn trước`)
      continue
    }
    users.push({ id, role: r.role, markerExpiresAt: toIsoUtc(r.expires_at), remainingS: r.remaining_s })
  }
  if (reasons.length) return { ok: false, reasons }
  return { ok: true, users, dbNow: toIsoUtc(rows[0].db_now) }
}

/**
 * Canh marker trong lúc server QA chạy (security review P1-1): dừng khi bất kỳ tài khoản QA của run không còn marker hoặc
 * còn dưới ngưỡng — trước khi marker hết hạn biến chương trình tạo ra thành THẬT.
 */
export function cmsQaWatchdog(rows: readonly CmsQaStatusRow[], userIds: readonly string[], guardMinutes: number): { stop: boolean; reasons: string[] } {
  const byId = new Map(rows.map((r) => [r.user_id, r]))
  const reasons: string[] = []
  for (const id of userIds) {
    const r = byId.get(id)
    if (!r || !r.user_exists) reasons.push(`${maskCmsUuid(id)}: không đọc được tài khoản`)
    else if (!r.active) reasons.push(`${maskCmsUuid(id)}: marker không còn hạn`)
    else if (r.remaining_s < guardMinutes * 60) reasons.push(`${maskCmsUuid(id)}: marker còn ${Math.floor(r.remaining_s / 60)} phút < ngưỡng canh ${guardMinutes} phút`)
  }
  return { stop: reasons.length > 0, reasons }
}

// ── Vòng canh marker (PM QA tooling r1 P1-2) ────────────────────────────────
// Ngân sách thời gian: poll 60 s, request timeout 60 s (lib-cms-ops), dừng sau 3 lỗi liên tiếp ⇒ mất DB có thể tới ~240 s
// mới đủ 3 lỗi. Vì vậy (1) guard có SÀN 10 phút (> 240 s + biên), không cho hạ; (2) thêm DEADLINE ĐỘC LẬP: mỗi lần đọc
// được trạng thái, hạn dừng = thời điểm BẮT ĐẦU request (đồng hồ máy, chỉ dùng chênh lệch — không phụ thuộc lệch giờ
// với DB) + (min remaining_s − guard) giây; nhịp tick 5 s không IO dừng server khi tới hạn, kể cả lúc request đang treo.
// DB đo remaining_s ở một thời điểm SAU lúc bắt đầu request ⇒ hạn dừng thật sự ≥ guard trước khi marker hết.

export const CMS_QA_GUARD_MINUTES_MIN = 10
export const CMS_QA_POLL_MS = 60_000
export const CMS_QA_TICK_MS = 5_000
export const CMS_QA_MAX_POLL_FAILURES = 3

/** --guard-minutes: số nguyên ≥ sàn 10 phút (ngân sách phát hiện mất DB); --min-ttl phải > guard (kiểm ở launcher). */
export function parseCmsQaGuardMinutes(raw: string | undefined | null): Parsed<number> {
  const p = parseCmsQaMinutes(raw, CMS_QA_GUARD_MINUTES_DEFAULT)
  if (!p.ok) return p
  if (p.value < CMS_QA_GUARD_MINUTES_MIN) return { ok: false, reason: `--guard-minutes tối thiểu ${CMS_QA_GUARD_MINUTES_MIN} (ngân sách phát hiện mất DB ~4 phút)` }
  return p
}

/** Tham số `git status` dùng cho kiểm cây sạch — GỒM file chưa track không bị ignore (PM P1-1). Dùng chung launcher + test. */
export const CMS_QA_GIT_STATUS_ARGS = ['status', '--porcelain', '--untracked-files=all'] as const

/** Cây sạch ⇔ `git status --porcelain --untracked-files=all` rỗng (artifact đã ignore không xuất hiện). */
export function cmsQaTreeState(porcelain: string): { clean: boolean; entries: string[] } {
  const entries = porcelain.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l !== '')
  return { clean: entries.length === 0, entries }
}

export interface CmsQaWatchdogVerdict { stop: boolean; reason: string | null }

/**
 * Bộ canh marker THUẦN (không timer / IO): lỗi đọc liên tiếp, verdict theo ngưỡng, và DEADLINE độc lập. Quyết định dừng
 * là một chiều (đã dừng thì giữ). `begin()` chặn chồng request (đang chờ ⇒ bỏ lượt poll).
 */
export function createCmsQaWatchdog(opts: { userIds: readonly string[]; guardMinutes: number; maxFailures?: number }) {
  const guardMs = opts.guardMinutes * 60_000
  const maxFailures = opts.maxFailures ?? CMS_QA_MAX_POLL_FAILURES
  let stopAt: number | null = null
  let failures = 0
  let inFlight = false
  let stopped: string | null = null
  const stop = (reason: string): CmsQaWatchdogVerdict => {
    if (stopped === null) stopped = reason
    return { stop: true, reason: stopped }
  }
  const state = (): CmsQaWatchdogVerdict => (stopped !== null ? { stop: true, reason: stopped } : { stop: false, reason: null })
  return {
    get stopAt() { return stopAt },
    get failures() { return failures },
    get inFlight() { return inFlight },
    /** Bắt đầu một lượt đọc; false ⇒ bỏ lượt (đang chờ request trước hoặc đã dừng). */
    begin(): boolean {
      if (inFlight || stopped !== null) return false
      inFlight = true
      return true
    },
    /** Kết quả đọc thành công của request bắt đầu lúc `startedAtMs` (đồng hồ máy). */
    onResult(rows: readonly CmsQaStatusRow[], startedAtMs: number): CmsQaWatchdogVerdict {
      inFlight = false
      if (stopped !== null) return state()
      failures = 0
      const v = cmsQaWatchdog(rows, opts.userIds, opts.guardMinutes)
      if (v.stop) return stop(v.reasons.join('; '))
      const minRemainingMs = Math.min(...opts.userIds.map((id) => (rows.find((r) => r.user_id === id)?.remaining_s ?? 0) * 1000))
      stopAt = startedAtMs + minRemainingMs - guardMs
      return state()
    },
    onError(): CmsQaWatchdogVerdict {
      inFlight = false
      if (stopped !== null) return state()
      failures += 1
      if (failures >= maxFailures) return stop(`không đọc được trạng thái marker ${failures} lần liên tiếp (fail-closed)`)
      return state()
    },
    /** Nhịp không IO: tới hạn dừng ⇒ dừng (kể cả khi request đang treo). Chưa từng đọc được ⇒ dừng (fail-closed). */
    tick(nowMs: number): CmsQaWatchdogVerdict {
      if (stopped !== null) return state()
      if (stopAt === null) return stop('chưa có lần đọc marker hợp lệ (fail-closed)')
      if (nowMs >= stopAt) return stop(`tới hạn dừng an toàn (marker còn ≤ ngưỡng ${opts.guardMinutes} phút theo lần đọc gần nhất)`)
      return state()
    },
  }
}

export type CmsQaWatchdog = ReturnType<typeof createCmsQaWatchdog>

/**
 * Điều phối timer cho bộ canh (đồng hồ / timer / poll TIÊM VÀO ⇒ test bằng đồng hồ giả). Poll mỗi `pollMs` (bỏ lượt
 * khi request trước chưa xong), tick mỗi `tickMs`; dừng ⇒ huỷ cả hai timer rồi gọi `onStop` đúng một lần.
 */
export function startCmsQaWatchdogLoop(d: {
  watchdog: CmsQaWatchdog
  poll: () => Promise<CmsQaStatusRow[]>
  now: () => number
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (h: unknown) => void
  onStop: (reason: string) => void
  pollMs?: number
  tickMs?: number
}): { stop(): void; dispose(): void } {
  let done = false
  const handles: unknown[] = []
  const fire = (v: CmsQaWatchdogVerdict) => {
    if (done || !v.stop) return
    done = true
    for (const h of handles) d.clearInterval(h)
    d.onStop(v.reason ?? 'dừng')
  }
  handles.push(d.setInterval(() => {
    if (done || !d.watchdog.begin()) return
    const startedAt = d.now()
    d.poll().then((rows) => d.watchdog.onResult(rows, startedAt), () => d.watchdog.onError()).then(fire)
  }, d.pollMs ?? CMS_QA_POLL_MS))
  handles.push(d.setInterval(() => { if (!done) fire(d.watchdog.tick(d.now())) }, d.tickMs ?? CMS_QA_TICK_MS))
  return {
    stop() { fire({ stop: true, reason: 'dừng thủ công' }) },
    /** Huỷ timer, KHÔNG gọi onStop (server đã tự thoát). */
    dispose() { done = true; for (const h of handles) d.clearInterval(h) },
  }
}

/**
 * Ai khởi phát việc dừng server QA: operator (Ctrl+C / SIGTERM), bộ canh marker, lỗi tiến trình con khi server còn sống
 * (`error` không phải bằng chứng đã thoát — PM `2026-11-02-cms-cli-exit-pm.md` §3), hoặc không ai (server tự thoát).
 */
export type CmsQaStopKind = 'operator' | 'watchdog' | 'error' | null

/**
 * Mã thoát launcher sau khi server QA đã dừng (PM `2026-11-02-cms-b3-and-cli-exit-pm.md` §5): **0 chỉ khi operator chủ động
 * dừng**; bộ canh marker dừng (marker sắp hết / lỗi đọc) hoặc server tự chết ⇒ 1 — không đổi lỗi thành 0. Mã / tín hiệu
 * của tiến trình con chỉ để in (Windows: kill ⇒ code null).
 */
export function cmsQaServerExitCode(stop: CmsQaStopKind): 0 | 1 {
  return stop === 'operator' ? 0 : 1
}

/** Thời gian chờ sau khi server con thoát rồi mới chốt mã: Ctrl+C trên Windows tới cả cha lẫn con, thứ tự sự kiện không cố định. */
export const CMS_QA_EXIT_GRACE_MS = 500
/** SIGINT chưa làm server thoát sau chừng này ⇒ cưỡng bức SIGKILL. */
export const CMS_QA_KILL_AFTER_MS = 10_000
/** Sau SIGKILL, chờ sự kiện 'exit' tối đa chừng này; quá hạn ⇒ kết luận server CHƯA DỪNG (launcher hữu hạn, mã 1). */
export const CMS_QA_KILL_CONFIRM_MS = 5_000

/** Phần tiến trình con launcher cần (ChildProcess của node thoả mãn; test dùng EventEmitter giả). */
export interface CmsQaChildLike {
  /** Node: undefined khi spawn thất bại (không có tiến trình). */
  readonly pid?: number
  readonly exitCode: number | null
  readonly signalCode: string | null
  /** Node phát 'error' ĐỒNG BỘ trong kill() khi gửi tín hiệu lỗi (EPERM …), ném khi tín hiệu không hỗ trợ. */
  kill(signal: 'SIGINT' | 'SIGKILL'): boolean
  on(event: 'exit', fn: (code: number | null, signal: string | null) => void): unknown
  on(event: 'error', fn: (e: Error) => void): unknown
  /** Bỏ giữ event loop của launcher khi phải bỏ lại server không dừng được (launcher vẫn kết thúc). */
  unref?(): void
}

export interface CmsQaServerLifecycleResult {
  rc: 0 | 1
  stopKind: CmsQaStopKind
  code: number | null
  signal: string | null
  /** Lỗi spawn / tiến trình con (sự kiện 'error' đầu tiên), đã rút gọn. */
  childError: string | null
  /**
   * true: có bằng chứng server không còn chạy — sự kiện 'exit', hoặc spawn thất bại không tạo tiến trình. false: SIGKILL
   * không được xác nhận trong `killConfirmMs` ⇒ server CÓ THỂ CÒN CHẠY ở pid `pid` (rc luôn 1; launcher ghi cờ, chặn close).
   */
  stopped: boolean
  pid: number | null
}

/** Lifecycle ném lỗi này khi setup lỗi sau spawn VÀ không xác nhận được server đã chết: server có thể còn chạy ở `pid`. */
export class CmsQaServerNotStoppedError extends Error {
  readonly pid: number | null
  constructor(pid: number | null, cause: string) {
    super(`server QA pid ${pid ?? '—'} CHƯA DỪNG sau lỗi dựng canh marker (${cause}) — tắt tay (Windows: taskkill /F /PID ${pid ?? '<pid>'}), KHÔNG QA tiếp, KHÔNG close run khi pid còn sống`)
    this.name = 'CmsQaServerNotStoppedError'
    this.pid = pid
  }
}

/**
 * Vòng đời server QA của launcher sau khi đã spawn (PM 02/11 B3 §5, security review P1-1, PM `2026-11-02-cms-cli-exit-pm.md`
 * §3). Nghe 'exit' / 'error' của con NGAY từ đầu, bằng `on` (lỗi lần hai không thoát ngoài kiểm soát).
 *
 * - Bằng chứng server đã thoát CHỈ là 'exit' (hoặc spawn thất bại: không pid / đã có exitCode). 'error' trên tiến trình còn
 *   sống (kill EPERM …) KHÔNG giải phóng cơ chế dừng: đang dừng ⇒ cưỡng bức SIGKILL ngay; chưa dừng ⇒ bắt đầu dừng
 *   (`stopKind` 'error').
 * - Dừng: SIGINT → quá `killAfterMs` ⇒ SIGKILL → chờ 'exit' tối đa `killConfirmMs`; quá hạn ⇒ `stopped: false` (server CÓ
 *   THỂ còn chạy): báo rõ, huỷ timer / handler, `unref` con để launcher kết thúc — không báo đã dọn xong.
 * - `setup()` (ghi manifest …) và dựng canh marker trong try — lỗi ⇒ SIGKILL ngay, chờ xác nhận như trên; đã thoát ⇒ ném lại
 *   lỗi gốc, không xác nhận được ⇒ ném `CmsQaServerNotStoppedError`.
 * - Chạy bình thường: con thoát ⇒ huỷ loop + poll đang chờ + timer ⇒ chờ `graceMs` (Ctrl+C Windows) ⇒ gỡ handler ⇒ mã theo
 *   người khởi phát dừng (`cmsQaServerExitCode`), có 'error' ⇒ 1. Mọi phụ thuộc tiêm vào ⇒ test bằng con / timer giả.
 */
export async function runCmsQaServerLifecycle(d: {
  child: CmsQaChildLike
  watchdog: CmsQaWatchdog
  preRows: readonly CmsQaStatusRow[]
  preStartedAt: number
  /** Đọc trạng thái marker; `signal` bị huỷ khi dọn dẹp. */
  poll: (signal: AbortSignal) => Promise<CmsQaStatusRow[]>
  setup: () => void
  now: () => number
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (h: unknown) => void
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (h: unknown) => void
  onSignal: (sig: 'SIGINT' | 'SIGTERM', fn: () => void) => void
  offSignal: (sig: 'SIGINT' | 'SIGTERM', fn: () => void) => void
  log: (line: string) => void
  pollMs?: number
  tickMs?: number
  graceMs?: number
  killAfterMs?: number
  killConfirmMs?: number
}): Promise<CmsQaServerLifecycleResult> {
  const short = (e: unknown) => String((e as Error)?.message ?? e).split('\n')[0].slice(0, 200)
  const pid = typeof d.child.pid === 'number' ? d.child.pid : null
  let childError: string | null = null
  let exit: { code: number | null; signal: string | null } | null = null
  let wake: () => void = () => {}
  const settled = new Promise<void>((r) => { wake = r })
  const alive = () => exit === null && d.child.exitCode === null && d.child.signalCode === null
  let stopKind: CmsQaStopKind = null
  let killTimer: unknown = null
  let confirmTimer: unknown = null
  let sigkillSent = false
  const clearKillTimers = () => {
    if (killTimer !== null) { d.clearTimeout(killTimer); killTimer = null }
    if (confirmTimer !== null) { d.clearTimeout(confirmTimer); confirmTimer = null }
  }
  const sendKill = (sig: 'SIGINT' | 'SIGKILL') => {
    try { d.child.kill(sig) } catch (e) { onChildError(e) } // node ném khi tín hiệu không hỗ trợ — xử lý như 'error'
  }
  const giveUp = () => {
    confirmTimer = null
    if (alive()) d.log(`SERVER QA CHƯA DỪNG: pid ${pid ?? '—'} không xác nhận thoát sau SIGKILL — DỪNG MỌI THAO TÁC QA; tắt tay (Windows: taskkill /F /PID ${pid ?? '—'}); KHÔNG close run khi pid còn sống`)
    wake() // luôn đánh thức: hạn xác nhận là mốc cuối, launcher không chờ vô hạn
  }
  const forceKill = (why: string) => {
    if (sigkillSent || !alive()) return
    sigkillSent = true
    if (killTimer !== null) { d.clearTimeout(killTimer); killTimer = null }
    d.log(`cưỡng bức SIGKILL server QA pid ${pid ?? '—'} (${why}); chờ xác nhận thoát tối đa ${d.killConfirmMs ?? CMS_QA_KILL_CONFIRM_MS} ms`)
    confirmTimer = d.setTimeout(giveUp, d.killConfirmMs ?? CMS_QA_KILL_CONFIRM_MS) // hẹn TRƯỚC khi gửi: kill() có thể phát 'error' đồng bộ
    sendKill('SIGKILL')
  }
  const stopServer = (why: string, kind: Exclude<CmsQaStopKind, null>) => {
    if (stopKind) return
    stopKind = kind
    d.log(`DỪNG server QA: ${why} — DỪNG MỌI THAO TÁC QA (kể cả trên trình duyệt prod) và xử lý theo runbook`)
    if (!alive()) return // con đã thoát (vd. Ctrl+C tới trong lúc chờ grace)
    killTimer = d.setTimeout(() => { killTimer = null; forceKill(`quá ${d.killAfterMs ?? CMS_QA_KILL_AFTER_MS} ms sau SIGINT`) }, d.killAfterMs ?? CMS_QA_KILL_AFTER_MS)
    sendKill('SIGINT')
  }
  function onChildError(e: unknown) {
    const msg = short(e)
    childError ??= msg
    if (exit !== null) return
    if (pid === null || !alive()) { // spawn thất bại: không có tiến trình (Node: pid undefined, exitCode âm, không phát 'exit')
      exit = { code: null, signal: null }
      wake()
      return
    }
    d.log(`LỖI tiến trình con server QA pid ${pid} khi server CÒN SỐNG: ${msg} — chưa coi là đã dừng`)
    if (!stopKind) stopServer(`lỗi tiến trình con: ${msg}`, 'error')
    else forceKill(`gửi tín hiệu dừng lỗi: ${msg}`)
  }
  d.child.on('exit', (code, signal) => { if (exit === null) { exit = { code, signal }; wake() } })
  d.child.on('error', (e) => onChildError(e))

  const pollAbort = new AbortController()
  let loop: { stop(): void; dispose(): void } | null = null
  const onSigint = () => { stopServer('Ctrl+C', 'operator'); loop?.dispose() }
  const onSigterm = () => { stopServer('SIGTERM', 'operator'); loop?.dispose() }
  let signalsOn = false
  const stopLoop = () => { loop?.dispose(); pollAbort.abort() }
  const signalsOff = () => {
    if (signalsOn) { d.offSignal('SIGINT', onSigint); d.offSignal('SIGTERM', onSigterm); signalsOn = false }
  }
  /** Bỏ lại server không dừng được: không giữ launcher, trạng thái rõ (không báo đã dọn xong). */
  const abandon = () => { clearKillTimers(); signalsOff(); try { d.child.unref?.() } catch { /* chỉ bỏ giữ event loop */ } }
  try {
    d.setup()
    const first = d.watchdog.onResult(d.preRows, d.preStartedAt)
    if (first.stop) stopServer(first.reason ?? 'marker không đủ hạn', 'watchdog')
    else if (d.watchdog.stopAt !== null) d.log(`canh marker: hạn dừng độc lập ${new Date(d.watchdog.stopAt).toISOString()}`)
    loop = startCmsQaWatchdogLoop({
      watchdog: d.watchdog, poll: () => d.poll(pollAbort.signal), now: d.now,
      setInterval: d.setInterval, clearInterval: d.clearInterval, onStop: (why) => stopServer(why, 'watchdog'),
      pollMs: d.pollMs, tickMs: d.tickMs,
    })
    d.onSignal('SIGINT', onSigint)
    d.onSignal('SIGTERM', onSigterm)
    signalsOn = true
  } catch (e) {
    d.log(`LỖI khi dựng canh marker sau spawn — GIẾT server QA ngay: ${short(e)}`)
    stopKind ??= 'error'
    stopLoop()
    signalsOff()
    forceKill('setup lỗi sau spawn')
    await settled
    if (alive()) { abandon(); throw new CmsQaServerNotStoppedError(pid, short(e)) }
    clearKillTimers()
    throw e
  }
  await settled
  stopLoop()
  if (alive()) { // hết hạn xác nhận sau SIGKILL mà chưa có 'exit'
    abandon()
    return { rc: 1, stopKind, code: null, signal: null, childError, stopped: false, pid }
  }
  clearKillTimers()
  // Handler tín hiệu còn nghe trong lúc chờ: Ctrl+C tới cha muộn hơn 'exit' của con vẫn được ghi là operator.
  await new Promise<void>((r) => { d.setTimeout(r, d.graceMs ?? CMS_QA_EXIT_GRACE_MS) })
  signalsOff()
  clearKillTimers()
  const { code, signal } = exit ?? { code: d.child.exitCode, signal: d.child.signalCode }
  return { rc: childError ? 1 : cmsQaServerExitCode(stopKind), stopKind, code, signal, childError, stopped: true, pid }
}

// ── Manifest run QA (.qa-cms.json) ───────────────────────────────────────────

export interface CmsQaRunManifest {
  kind: 'cms-qa-run'
  version: 1
  runId: string
  status: 'open' | 'closed'
  mode: 'manual-localhost' | 'automated'
  host: string
  /** Giờ DB lúc preflight (ISO UTC) — mốc lọc chương trình khi đóng run. */
  startedAt: string
  gitHead: string
  gitTree: string
  /** .next/BUILD_ID của server QA (null khi --no-server / spec tự động). */
  buildId: string | null
  port: number | null
  serverPid: number | null
  /**
   * Launcher không xác nhận được server QA đã chết (SIGKILL lỗi / không có 'exit' trong hạn — PM cli-exit §3): close từ chối
   * khi pid này còn sống. Vắng / null ⇒ server đã dừng có bằng chứng (hoặc chưa từng dựng).
   */
  serverNotStopped?: { pid: number | null; at: string } | null
  users: { id: string; role: string | null; markerExpiresAt: string }[]
  /** Spec tự động: ghi NGAY khi tạo. Khi đóng: mọi chương trình is_test tạo / sửa trong run (để lại, ẩn — H8). */
  programs: { id: string; status: string; isTest: boolean }[]
  closedAt: string | null
  closeCheck: {
    realProgramsTouchedByQaUsers: string[]; realProgramsChangedByOthers: string[]; markerActiveAtClose: string[]
    /** Id (che) chương trình thật đổi trong run mà operator đã soát tay và xác nhận khi đóng. */
    acknowledgedWarnings?: string[]
  } | null
}

/**
 * Cảnh báo khi đóng run (chương trình thật đổi trong run, không do tài khoản QA theo cột hiện tại) CHẶN đóng run trừ khi
 * operator đã soát tay và xác nhận ĐÚNG tập đó bằng `--ack-warnings=<8 ký tự đầu id>,…` (db-reviewer vòng 2 P2-6: lúc QA
 * D3 cờ prod OFF, server QA là đường ghi duy nhất — vd. một super khác đăng nhập server QA tạo chương trình thật).
 */
export function cmsQaAckWarnings(warningIds: readonly string[], ackRaw: string | undefined): { ok: boolean; reason: string | null; acked: string[] } {
  const want = [...new Set(warningIds.map((id) => id.slice(0, 8)))].sort()
  const got = ackRaw === undefined ? [] : [...new Set(ackRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))].sort()
  if (want.length === 0) return got.length ? { ok: false, reason: 'không có cảnh báo nào để xác nhận — bỏ --ack-warnings', acked: [] } : { ok: true, reason: null, acked: [] }
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    return { ok: false, reason: `${want.length} chương trình thật đổi trong run — soát tay từng chương trình rồi đóng bằng --ack-warnings=${want.join(',')}`, acked: [] }
  }
  return { ok: true, reason: null, acked: want.map((p) => `${p}…`) }
}

export function newCmsQaManifest(input: {
  runId: string; mode: CmsQaRunManifest['mode']; host: string; dbNow: unknown; gitHead: string; gitTree: string
  buildId: string | null; port: number | null; users: readonly CmsQaPreflightUser[]
}): CmsQaRunManifest {
  return {
    kind: 'cms-qa-run', version: 1, runId: input.runId, status: 'open', mode: input.mode, host: input.host,
    startedAt: toIsoUtc(input.dbNow), gitHead: input.gitHead, gitTree: input.gitTree, buildId: input.buildId,
    port: input.port, serverPid: null,
    users: input.users.map((u) => ({ id: u.id, role: u.role, markerExpiresAt: toIsoUtc(u.markerExpiresAt) })),
    programs: [], closedAt: null, closeCheck: null,
  }
}

/** Spec ghi tự động: ghi id chương trình is_test vào manifest ngay khi tạo (trước mọi thao tác tiếp theo trên nó). */
export function cmsQaManifestAddProgram(m: CmsQaRunManifest, id: string): CmsQaRunManifest {
  if (m.status !== 'open') throw new Error('manifest không ở trạng thái mở')
  if (!isCmsUuid(id)) throw new Error('id chương trình không phải UUID')
  if (m.programs.some((p) => p.id === id)) return m
  return { ...m, programs: [...m.programs, { id, status: 'created', isTest: true }] }
}

export function parseCmsQaManifest(text: string): Parsed<CmsQaRunManifest> {
  let m: unknown
  try { m = JSON.parse(text) } catch { return { ok: false, reason: 'manifest không phải JSON' } }
  const o = m as Partial<CmsQaRunManifest>
  if (!o || o.kind !== 'cms-qa-run' || o.version !== 1) return { ok: false, reason: 'manifest sai loại / phiên bản' }
  if (o.status !== 'open' && o.status !== 'closed') return { ok: false, reason: 'manifest sai trạng thái' }
  if (typeof o.host !== 'string' || !o.host) return { ok: false, reason: 'manifest thiếu host' }
  if (typeof o.startedAt !== 'string' || !ISO_UTC_RE.test(o.startedAt)) return { ok: false, reason: 'manifest thiếu startedAt ISO UTC' }
  if (!Array.isArray(o.users) || o.users.length === 0 || !o.users.every((u) => isCmsUuid(u?.id))) return { ok: false, reason: 'manifest sai danh sách tài khoản QA' }
  if (!Array.isArray(o.programs) || !o.programs.every((p) => isCmsUuid(p?.id))) return { ok: false, reason: 'manifest sai danh sách chương trình' }
  if (o.port !== null && o.port !== undefined && !(Number.isInteger(o.port) && o.port >= 1024 && o.port <= 65535)) return { ok: false, reason: 'manifest sai port' }
  const ns = o.serverNotStopped
  if (ns !== undefined && ns !== null && !(typeof ns === 'object' && (ns.pid === null || (Number.isInteger(ns.pid) && (ns.pid as number) > 0 && (ns.pid as number) <= 2_147_483_647)) && typeof ns.at === 'string')) {
    return { ok: false, reason: 'manifest sai serverNotStopped' }
  }
  return { ok: true, value: o as CmsQaRunManifest }
}

/**
 * Chương trình có hoạt động trong run (một câu SELECT). `qa_touched`: tài khoản QA tạo / sửa / kích hoạt / chốt chương
 * trình, hoặc preview / commit import trên nó, với MỐC CỦA CHÍNH HÀNH ĐỘNG ≥ mốc run (db-reviewer P2-1 — không đánh đỏ
 * chương trình QA đã tạo trước run rồi người khác sửa trong run). `changed_in_run`: có thay đổi bất kỳ ≥ mốc run.
 */
export function cmsQaRunProgramsSql(startedAt: string, userIds: readonly string[]): string {
  const ts = isoUtcLiteral(startedAt)
  const arr = uuidArrayLiteral(userIds)
  return `SELECT p.id::text AS id, p.status, p.is_test,
       ((p.created_by = ANY(${arr}) AND p.created_at >= ${ts})
         OR (p.updated_by = ANY(${arr}) AND p.updated_at >= ${ts})
         OR (p.activated_by = ANY(${arr}) AND p.activated_at >= ${ts})
         OR (p.locked_by = ANY(${arr}) AND p.locked_at >= ${ts})
         OR EXISTS (SELECT 1 FROM public.cms_import_runs r WHERE r.program_id = p.id
                     AND ((r.created_by = ANY(${arr}) AND r.created_at >= ${ts})
                       OR (r.committed_by = ANY(${arr}) AND r.committed_at >= ${ts})))) AS qa_touched,
       (p.created_at >= ${ts} OR p.updated_at >= ${ts} OR p.activated_at >= ${ts} OR p.locked_at >= ${ts}
         OR EXISTS (SELECT 1 FROM public.cms_import_runs r WHERE r.program_id = p.id
                     AND (r.created_at >= ${ts} OR r.committed_at >= ${ts}))) AS changed_in_run
  FROM public.cms_programs p
 WHERE p.created_at >= ${ts} OR p.updated_at >= ${ts} OR p.activated_at >= ${ts} OR p.locked_at >= ${ts}
    OR EXISTS (SELECT 1 FROM public.cms_import_runs r WHERE r.program_id = p.id AND (r.created_at >= ${ts} OR r.committed_at >= ${ts}))
 ORDER BY p.created_at, p.id`
}

export interface CmsQaProgramRow { id: string; status: string; is_test: boolean; qa_touched: boolean; changed_in_run: boolean }

/**
 * Đóng run: chương trình THẬT bị tài khoản QA chạm trong run ⇒ đỏ (không đóng, điều tra). Chương trình thật đổi trong run
 * mà không do tài khoản QA ⇒ cảnh báo soát tay (hoạt động bình thường của prod, hoặc sửa của QA bị người khác ghi đè).
 */
export function cmsQaCloseCheck(
  manifest: CmsQaRunManifest, programs: readonly CmsQaProgramRow[], status: readonly CmsQaStatusRow[],
  /** Cờ is_test THẬT (cmsQaProgramFlagsSql) của mọi id đã ghi trong manifest — không tin `isTest` ghi sẵn (db-reviewer vòng 3 P2-B). */
  recordedFlags: readonly { id: string; is_test: boolean }[],
): { ok: boolean; reasons: string[]; warnings: string[]; closed: CmsQaRunManifest } {
  const real = programs.filter((p) => !p.is_test && p.qa_touched)
  const others = programs.filter((p) => !p.is_test && !p.qa_touched && p.changed_in_run)
  const reasons = real.map((p) => `chương trình THẬT ${maskCmsUuid(p.id)} bị tài khoản QA tạo / sửa / kích hoạt / import trong run — dừng, báo PM / operator`)
  const flags = new Map(recordedFlags.map((r) => [r.id, r.is_test]))
  for (const p of manifest.programs) {
    if (!flags.has(p.id)) reasons.push(`chương trình ${maskCmsUuid(p.id)} ghi trong manifest không còn trong DB`)
    else if (flags.get(p.id) !== true) reasons.push(`chương trình ${maskCmsUuid(p.id)} ghi trong manifest là chương trình THẬT (is_test = false) — manifest khai sai, dừng`)
  }
  const warnings = others.map((p) => `chương trình thật ${maskCmsUuid(p.id)} có thay đổi trong run (không do tài khoản QA theo cột hiện tại) — soát tay`)
  const recorded = new Map(manifest.programs.filter((p) => flags.get(p.id) === true).map((p) => [p.id, { ...p, isTest: true }]))
  for (const p of programs.filter((x) => x.is_test)) recorded.set(p.id, { id: p.id, status: p.status, isTest: true })
  const closed: CmsQaRunManifest = {
    ...manifest,
    status: 'closed',
    programs: [...recorded.values()],
    closedAt: status[0]?.db_now ? toIsoUtc(status[0].db_now) : null,
    closeCheck: {
      realProgramsTouchedByQaUsers: real.map((p) => p.id),
      realProgramsChangedByOthers: others.map((p) => p.id),
      markerActiveAtClose: status.filter((s) => s.active).map((s) => s.user_id),
    },
  }
  return { ok: reasons.length === 0, reasons, warnings, closed }
}

/** Chương trình (id, is_test) theo danh sách id — dùng để chứng minh is_test trước mọi thao tác QA tự động. */
export function cmsQaProgramFlagsSql(ids: readonly string[]): string {
  return `SELECT p.id::text AS id, p.is_test FROM public.cms_programs p WHERE p.id = ANY(${uuidArrayLiteral(ids)}) ORDER BY 1`
}

/**
 * QA tự động chỉ thao tác chương trình ĐÃ CHỨNG MINH is_test qua DB (không lấy id thật từ URL tự do). Mọi id phải là
 * UUID, có trong kết quả DB, is_test = true, run phải mở và id phải đã được ghi vào run (`cmsQaManifestAddProgram` ngay
 * khi tạo). Manifest BẮT BUỘC (db-reviewer vòng 2 P2-8).
 */
export function assertCmsQaProgramIds(
  ids: readonly string[], rows: readonly { id: string; is_test: boolean }[], manifest: CmsQaRunManifest,
): { ok: true } | { ok: false; reasons: string[] } {
  const reasons: string[] = []
  if (ids.length === 0) reasons.push('không có id chương trình')
  if (!manifest || manifest.status !== 'open') reasons.push('cần manifest run QA đang mở')
  const byId = new Map(rows.map((r) => [r.id, r]))
  const inRun = new Set((manifest?.programs ?? []).map((p) => p.id))
  for (const id of ids) {
    if (!isCmsUuid(id)) { reasons.push('id không phải UUID'); continue }
    const r = byId.get(id)
    if (!r) reasons.push(`${maskCmsUuid(id)}: không tìm thấy trong DB`)
    else if (r.is_test !== true) reasons.push(`${maskCmsUuid(id)}: is_test = false — CẤM thao tác QA trên chương trình thật`)
    if (!inRun.has(id)) reasons.push(`${maskCmsUuid(id)}: chưa ghi vào run QA đang mở`)
  }
  return reasons.length ? { ok: false, reasons: [...new Set(reasons)] } : { ok: true }
}

// ── VERIFY chỉ đọc 120 / 121 + V8 (P1-R2) ───────────────────────────────────

/** Phase VERIFY CMS = số migration CMS đã chạy cuối cùng (120 nền · 121 import / kích hoạt · 122 kết quả P2-b · 123 chốt kỳ P3a · 124 chứng nhận nguồn
 *  · 125 bỏ trần bậc cuối · 126 sales-only: mở cổng kết quả bán tạm tính). */
export type CmsVerifyPhase = '120' | '121' | '122' | '123' | '124' | '125' | '126'
export const CMS_VERIFY_PHASES: readonly CmsVerifyPhase[] = ['120', '121', '122', '123', '124', '125', '126']
/** Số hàm CMS tích luỹ ngay TRƯỚC phase (PRE phải đúng ảnh trước migration của phase) — SUY từ CMS_FN_MATRIX (db-reviewer P2-5). */
export function cmsFnCountBefore(phase: CmsVerifyPhase): number {
  return Object.values(CMS_FN_MATRIX).filter((m) => Number(m.phase) < Number(phase)).length
}

/** Hàm mới của từng phase (tên) — dùng để so ACL các hàm ĐÃ CÓ trước phase với ảnh PRE. */
export const CMS_PHASE_FUNCTIONS: Record<CmsVerifyPhase, string[]> = {
  '120': ['cms_has_qa_access', 'cms_readable_program_ids', 'rpc_cms_sync_run_open', 'rpc_cms_product_master_upsert',
    'rpc_cms_sync_run_close', 'cms__qa_access_stamp', 'cms__programs_guard'],
  '121': ['cms__vn_today', 'cms__lock_catalog', 'cms__conflicts', 'rpc_cms_program_save', 'rpc_cms_import_preview_save',
    'rpc_cms_import_commit', 'rpc_cms_program_activate'],
  // 122 (PM 03/11 §5): 11 helper không cấp ai · 8 rpc_cms_sales_* service_role · 4 rpc_cms_result_* authenticated.
  '122': ['cms__str', 'cms__str_or_null', 'cms__ts', 'cms__norm_email', 'cms__mapping_fp', 'cms__sales_snapshot', 'cms__seal_fail',
    'cms__visible_result_users', 'cms__result_run', 'cms__programs_result_guard', 'cms__results_release_open',
    'rpc_cms_sales_snapshot', 'rpc_cms_sales_run_open', 'rpc_cms_sales_run_stage', 'rpc_cms_sales_run_seal_begin',
    'rpc_cms_sales_run_seal_step', 'rpc_cms_sales_run_publish', 'rpc_cms_sales_run_finish', 'rpc_cms_sales_run_cleanup',
    'rpc_cms_result_header', 'rpc_cms_result_rows', 'rpc_cms_result_lines', 'rpc_cms_result_excluded'],
  // 123 (P3a chốt kỳ): 15 helper cms__* không cấp ai (gồm 11 hàm trigger; 3 SECURITY INVOKER có chủ đích) · 2 rpc ghi / preview
  // service_role · 1 rpc đọc authenticated. Đổi thân cms_readable_program_ids (giữ ACL) — kỳ vọng thân riêng CMS_FN_SRC_123.
  '123': ['cms__lock_policy', 'cms__config_fp', 'cms__lock_eval', 'cms__frozen_runs_guard', 'cms__frozen_data_ins', 'cms__frozen_data_upd',
    'cms__frozen_data_del', 'cms__frozen_run_row', 'cms__payout_immutable', 'cms__payout_insert_guard', 'cms__config_lock_guard',
    'cms__programs_lock_guard', 'cms__frozen_truncate_guard', 'cms__config_auth_guard', 'cms__run_auth_guard',
    'rpc_cms_lock_preview', 'rpc_cms_program_lock', 'rpc_cms_payout'],
  // 124 (COMP-INT chứng nhận nguồn): 8 helper cms__* không cấp ai · 4 RPC authenticated. rpc_cms_program_lock ĐỔI CHỮ KÝ (5 → 6
  // tham số) ⇒ nằm trong tập loại trừ khi so ACL hàm có trước (sig khác PRE); thân 6 hàm thay ở CMS_FN_SRC_124.
  '124': ['cms__fp_j', 'cms__run_source_fp_text', 'cms__run_source_fp', 'cms__program_scope_hash', 'cms__run_source_check',
    'cms__attest_immutable', 'cms__attest_eval', 'cms__attest_truncate_guard', 'rpc_cms_source_attest', 'rpc_cms_source_attest_revoke',
    'rpc_cms_run_source_export', 'rpc_cms_source_attestations', 'rpc_cms_program_lock'],
  // 125 (CMS-UNCAPPED-1 — CMS-Q-220): 1 hàm trigger mới không cấp ai. rpc_cms_import_commit / rpc_cms_program_activate (121) thay bằng
  // CREATE OR REPLACE GIỮ chữ ký + ACL ⇒ thuộc tập "hàm có trước" khi so ACL với PRE; thân mới ở CMS_FN_SRC_125.
  '125': ['cms__tiers_last_open_guard'],
  // 126 (sales-only, PM 06/11): KHÔNG hàm mới — chỉ CREATE OR REPLACE 2 hàm 122 (cms__results_release_open, rpc_cms_sales_run_publish)
  // GIỮ chữ ký + ACL ⇒ POST 126 so TOÀN BỘ hàm public (n_all / md5_all) với PRE 126; thân mới ở CMS_FN_SRC_126. Tập rỗng ⇒
  // cmsVerifyAclSql KHÔNG sinh cột n_ex126 (NOT IN () là lỗi cú pháp).
  '126': [],
}

const isCmsFnSql = `(left(p.proname, 4) = 'cms_' OR left(p.proname, 8) = 'rpc_cms_')`

/**
 * Ảnh ACL hàm public (cùng công thức PRE lịch sử: md5 string_agg sig=proacl, ';', ORDER BY sig): toàn bộ, phần ngoài
 * cms (= V6 120 / V3 121), và phần TRỪ hàm mới của 120 / 121 / 122 / 123 (để POST so MỌI hàm có trước phase — gồm 14 hàm
 * 120 / 121 khi chạy 122, 37 hàm 120–122 khi chạy 123 — với PRE của phase đó). Kèm giờ DB.
 */
export function cmsVerifyAclSql(): string {
  const n120 = CMS_PHASE_FUNCTIONS['120'].map((n) => `'${n}'`).join(',')
  const n121 = CMS_PHASE_FUNCTIONS['121'].map((n) => `'${n}'`).join(',')
  const n122 = CMS_PHASE_FUNCTIONS['122'].map((n) => `'${n}'`).join(',')
  const n123 = CMS_PHASE_FUNCTIONS['123'].map((n) => `'${n}'`).join(',')
  const n124 = CMS_PHASE_FUNCTIONS['124'].map((n) => `'${n}'`).join(',')
  const n125 = CMS_PHASE_FUNCTIONS['125'].map((n) => `'${n}'`).join(',')
  return `SELECT now() AS db_now,
       count(*)::int AS n_all, md5(string_agg(f.sig || '=' || f.acl, ';' ORDER BY f.sig)) AS md5_all,
       count(*) FILTER (WHERE NOT f.cms)::int AS n_old, md5(string_agg(f.sig || '=' || f.acl, ';' ORDER BY f.sig) FILTER (WHERE NOT f.cms)) AS md5_old,
       count(*) FILTER (WHERE f.name NOT IN (${n120}))::int AS n_ex120,
       md5(string_agg(f.sig || '=' || f.acl, ';' ORDER BY f.sig) FILTER (WHERE f.name NOT IN (${n120}))) AS md5_ex120,
       count(*) FILTER (WHERE f.name NOT IN (${n121}))::int AS n_ex121,
       md5(string_agg(f.sig || '=' || f.acl, ';' ORDER BY f.sig) FILTER (WHERE f.name NOT IN (${n121}))) AS md5_ex121,
       count(*) FILTER (WHERE f.name NOT IN (${n122}))::int AS n_ex122,
       md5(string_agg(f.sig || '=' || f.acl, ';' ORDER BY f.sig) FILTER (WHERE f.name NOT IN (${n122}))) AS md5_ex122,
       count(*) FILTER (WHERE f.name NOT IN (${n123}))::int AS n_ex123,
       md5(string_agg(f.sig || '=' || f.acl, ';' ORDER BY f.sig) FILTER (WHERE f.name NOT IN (${n123}))) AS md5_ex123,
       count(*) FILTER (WHERE f.name NOT IN (${n124}))::int AS n_ex124,
       md5(string_agg(f.sig || '=' || f.acl, ';' ORDER BY f.sig) FILTER (WHERE f.name NOT IN (${n124}))) AS md5_ex124,
       count(*) FILTER (WHERE f.name NOT IN (${n125}))::int AS n_ex125,
       md5(string_agg(f.sig || '=' || f.acl, ';' ORDER BY f.sig) FILTER (WHERE f.name NOT IN (${n125}))) AS md5_ex125
  FROM (SELECT p.proname::text AS name, p.oid::regprocedure::text AS sig, coalesce(p.proacl::text, 'NULL') AS acl,
               ${isCmsFnSql} AS cms
          FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace) f`
}

const TABLE_PRIVS = ['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']
const privList = (role: string) =>
  `(SELECT string_agg(pr, ',' ORDER BY pr) FROM unnest(ARRAY[${TABLE_PRIVS.map((p) => `'${p}'`).join(',')}]) pr WHERE has_table_privilege('${role}', c.oid, pr))`

export const CMS_VERIFY_SQL = {
  whoami: `SELECT current_user::text AS u, current_database()::text AS db,
       (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`,
  // '123' … '126' có trong lọc ⇒ checker phase trước trên DB đã ở phase sau đỏ phase-match (lời rõ), không chỉ max-numeric.
  markers: `SELECT version, name, applied_at FROM public.app_migrations WHERE version IN ('119', '120', '121', '122', '123', '124', '125', '126') OR version !~ '^[0-9]+$' ORDER BY 1`,
  maxNumeric: `SELECT max(CASE WHEN version ~ '^[0-9]+$' THEN version::int END) AS max_v FROM public.app_migrations`,
  functions: `SELECT p.proname::text AS name, p.oid::regprocedure::text AS sig, p.prosecdef AS secdef,
       md5(replace(p.prosrc, E'\\r', '')) AS src_md5,
       'search_path=public' = ANY (coalesce(p.proconfig, '{}'::text[])) AS has_path,
       'lock_timeout=5s' = ANY (coalesce(p.proconfig, '{}'::text[])) AS has_lock,
       'lock_timeout=3s' = ANY (coalesce(p.proconfig, '{}'::text[])) AS has_lock3,
       'lock_timeout=2s' = ANY (coalesce(p.proconfig, '{}'::text[])) AS has_lock2,
       'enable_nestloop=off' = ANY (coalesce(p.proconfig, '{}'::text[])) AS has_nestloop,
       coalesce(array_length(p.proconfig, 1), 0) AS n_config,
       (SELECT r.rolsuper OR r.rolbypassrls FROM pg_roles r WHERE r.oid = p.proowner) AS owner_bypass,
       p.proacl IS NULL AS acl_default,
       (SELECT string_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END || ':' || x.privilege_type, ','
                          ORDER BY CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END, x.privilege_type)
          FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner) AS acl_extra,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc_x
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND ${isCmsFnSql}
 ORDER BY 2`,
  policies: `SELECT tablename::text AS t, policyname::text AS name, cmd::text AS cmd, roles::text AS roles,
       permissive::text AS permissive, coalesce(qual, '') AS qual, with_check
  FROM pg_policies WHERE schemaname = 'public' AND left(tablename, 4) = 'cms_' ORDER BY 1, 2`,
  tables: `SELECT c.relname::text AS t, c.relrowsecurity AS rls,
       ${privList('anon')} AS anon_p, ${privList('authenticated')} AS auth_p, ${privList('service_role')} AS svc_p,
       (SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
          AND (has_column_privilege('anon', c.oid, a.attnum, 'SELECT,INSERT,UPDATE,REFERENCES')
            OR has_column_privilege('authenticated', c.oid, a.attnum, 'INSERT,UPDATE,REFERENCES')
            OR (c.relname IN ('cms_qa_access', 'cms_sync_runs', 'cms_sync_run_chunks', 'cms_sales_lines', 'cms_results', 'cms_result_catalog', 'cms_result_lines')
                AND has_column_privilege('authenticated', c.oid, a.attnum, 'SELECT')))) AS col_leaks
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND left(c.relname, 4) = 'cms_' ORDER BY 1`,
  roles: `SELECT rolname::text AS r, rolsuper AS su, rolbypassrls AS bypass FROM pg_roles WHERE rolname IN ('anon', 'authenticated') ORDER BY 1`,
  oneRunningIndex: `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'cms_sync_runs_one_running'`,
  // 121 V4 / V5 / V6 — nguyên văn khối VERIFY của migration 121 (kỳ vọng 0 dòng).
  inv121Overlap: `SELECT a.product_id, a.program_id::text AS p1, b.program_id::text AS p2
  FROM public.cms_program_products a JOIN public.cms_programs pa ON pa.id = a.program_id
  JOIN public.cms_program_products b ON b.product_id = a.product_id AND b.program_id > a.program_id
  JOIN public.cms_programs pb ON pb.id = b.program_id
 WHERE pa.status IN ('active','locked') AND pb.status IN ('active','locked') AND pa.is_test = pb.is_test
   AND pa.start_date <= pb.end_date AND pb.start_date <= pa.end_date`,
  inv121Tiers: `SELECT program_product_id::text AS id FROM (SELECT program_product_id, tier_order, qty_from, qty_to,
    lag(qty_to) OVER w prev_to, count(*) OVER (PARTITION BY program_product_id) n
    FROM public.cms_program_tiers WINDOW w AS (PARTITION BY program_product_id ORDER BY tier_order)) t
 WHERE (tier_order = 1 AND qty_from <> 1) OR (tier_order > 1 AND (prev_to IS NULL OR qty_from <> prev_to + 1))
    OR (qty_to IS NULL AND tier_order <> n)`,
  inv121Catalog: `SELECT p.id::text AS id FROM public.cms_programs p WHERE p.status <> 'draft' AND p.catalog_target_gmv IS NULL
   AND EXISTS (SELECT 1 FROM public.cms_program_products pp WHERE pp.program_id = p.id AND pp.gmv_basis = 'catalog')`,
  // V7 121: isolation mặc định + không thiết lập đè ở DB hiện tại hoặc ở role liên quan RPC (pg_db_role_setting gồm cả
  // ALTER ROLE … IN DATABASE …); role không liên quan không làm đỏ oan.
  isolation: `SELECT current_setting('default_transaction_isolation') AS iso,
       (SELECT count(*)::int FROM pg_db_role_setting s, unnest(s.setconfig) c
         WHERE c LIKE 'default_transaction_isolation=%'
           AND (s.setdatabase = 0 OR s.setdatabase = (SELECT d.oid FROM pg_database d WHERE d.datname = current_database()))
           AND (s.setrole = 0 OR s.setrole IN (SELECT r.oid FROM pg_roles r
                 WHERE r.rolname IN ('authenticator', 'service_role', 'authenticated', 'anon')))) AS overrides`,
  // Trigger bất biến của 120 (hạn marker neo giờ DB; không lật is_test): đúng 2, đúng định nghĩa đầy đủ, đang bật.
  triggers: `SELECT replace(pg_get_triggerdef(t.oid), 'public.', '') AS def, t.tgenabled::text AS enabled
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
 WHERE c.relnamespace = 'public'::regnamespace AND left(c.relname, 4) = 'cms_' AND NOT t.tgisinternal ORDER BY 1`,
  // Hình dạng bảng: md5 ràng buộc (tên = định nghĩa) và index của từng bảng cms_* — bắt chạy nhầm bản migration cũ / mất CHECK.
  tableShape: `SELECT c.relname::text AS t,
       (SELECT md5(string_agg(k.conname || '=' || replace(pg_get_constraintdef(k.oid), 'public.', ''), ';' ORDER BY k.conname::text COLLATE "C"))
          FROM pg_constraint k WHERE k.conrelid = c.oid) AS con_md5,
       (SELECT md5(string_agg(replace(pg_get_indexdef(i.indexrelid), 'public.', ''), ';' ORDER BY replace(pg_get_indexdef(i.indexrelid), 'public.', '') COLLATE "C"))
          FROM pg_index i WHERE i.indrelid = c.oid) AS idx_md5
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND left(c.relname, 4) = 'cms_' ORDER BY 1`,
  // ── 122 (chỉ chạy với --phase=122) ──
  // Định nghĩa hàm ngoài thân (db-reviewer P2-1): chữ ký + DEFAULT tham số, kiểu trả về, volatility, strict, leakproof, ngôn ngữ.
  fnDefs: `SELECT p.proname::text AS name,
       md5(pg_get_function_arguments(p.oid) || '->' || pg_get_function_result(p.oid) || '|' || p.provolatile::text || '|'
           || p.proisstrict::text || '|' || p.proleakproof::text || '|' || l.lanname::text) AS def_md5
  FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
 WHERE p.pronamespace = 'public'::regnamespace AND (left(p.proname, 4) = 'cms_' OR left(p.proname, 8) = 'rpc_cms_') ORDER BY 1`,
  // Cột từng bảng (tên : kiểu : NOT NULL : DEFAULT) theo thứ tự cột — NOT NULL không nằm trong pg_constraint ở PG15.
  columns: `SELECT c.relname::text AS t,
       md5(string_agg(a.attname::text || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text || ':'
                      || coalesce(pg_get_expr(d.adbin, d.adrelid), ''), ';' ORDER BY a.attnum)) AS col_md5
  FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
 WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND left(c.relname, 4) = 'cms_' GROUP BY c.relname ORDER BY 1`,
  // Index tra bậc UNIQUE — cấu trúc pg_index (không chỉ tên / LIKE: partial / biểu thức / INCLUDE / đổi thứ tự cột đều lọt LIKE).
  tiersUnique: `SELECT i.indisunique AS uniq, i.indisvalid AS valid, i.indisready AS ready, i.indpred IS NULL AS no_pred,
       i.indexprs IS NULL AS no_expr, i.indnatts::int AS natts, i.indnkeyatts::int AS nkey,
       i.indrelid = 'public.cms_program_tiers'::regclass AS on_tiers,
       (SELECT string_agg(a.attname::text, ',' ORDER BY k.ord) FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) AS cols,
       (SELECT bool_and(o = 0) FROM unnest(i.indoption::int2[]) o) AS asc_default
  FROM pg_index i WHERE i.indexrelid = to_regclass('public.cms_program_tiers_product_from_idx')`,
  // FK kép pointer kết quả (chương trình ⇒ run sales của CHÍNH nó) — đúng một, đúng cột, đã validate.
  pointerFk: `SELECT k.conname::text AS name, replace(pg_get_constraintdef(k.oid), 'public.', '') AS def, k.convalidated AS valid
  FROM pg_constraint k WHERE k.conrelid = 'public.cms_programs'::regclass AND k.contype = 'f'
   AND k.confrelid = 'public.cms_sync_runs'::regclass ORDER BY 1`,
  // Cổng kết quả ở DB: phase 122–125 phải còn đóng (false); 126 (sales-only — migration riêng được duyệt) phải MỞ (true).
  releaseGate: `SELECT public.cms__results_release_open() AS open`,
  // Pointer hiện hành phải trỏ run sales 'ok' đã công bố, chưa dọn, của CHÍNH chương trình, cùng namespace (kỳ vọng 0 dòng).
  inv122Pointer: `SELECT p.id::text AS id FROM public.cms_programs p LEFT JOIN public.cms_sync_runs r ON r.id = p.current_result_run_id
 WHERE p.current_result_run_id IS NOT NULL AND (r.id IS NULL OR r.program_id IS DISTINCT FROM p.id OR r.kind <> 'sales' OR r.status <> 'ok'
    OR r.published_at IS NULL OR r.purged_at IS NOT NULL OR r.is_test IS DISTINCT FROM p.is_test)`,
  // ── 123 (chỉ chạy với --phase=123; khối VERIFY V0–V7 cuối migration 123, chỉ đọc) ──
  // V0 owner: MỘT owner cho mọi bảng cms_* và mọi hàm cms_* / rpc_cms_*, = owner các hàm 122 (guard chỉ-owner 123 dựa vào đây).
  owners: `SELECT
       (SELECT coalesce(string_agg(DISTINCT pg_get_userbyid(c.relowner)::text, ',' ORDER BY pg_get_userbyid(c.relowner)::text), '')
          FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND left(c.relname, 4) = 'cms_') AS table_owners,
       (SELECT coalesce(string_agg(DISTINCT pg_get_userbyid(p.proowner)::text, ',' ORDER BY pg_get_userbyid(p.proowner)::text), '')
          FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND ${isCmsFnSql}) AS fn_owners,
       (SELECT coalesce(string_agg(DISTINCT pg_get_userbyid(p.proowner)::text, ',' ORDER BY pg_get_userbyid(p.proowner)::text), '')
          FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (${CMS_PHASE_FUNCTIONS['122'].map((n) => `'${n}'`).join(',')})) AS fn122_owners`,
  // V7 (123): như isolation 121 + role quản trị postgres / role đang chạy; chỉ đếm thiết lập KHÁC read committed (đúng V7 của 123).
  isolation123: `SELECT current_setting('default_transaction_isolation') AS iso,
       (SELECT count(*)::int FROM pg_db_role_setting s, unnest(s.setconfig) c
         WHERE c ILIKE 'default_transaction_isolation=%' AND c NOT ILIKE '%read committed%'
           AND (s.setdatabase = 0 OR s.setdatabase = (SELECT d.oid FROM pg_database d WHERE d.datname = current_database()))
           AND (s.setrole = 0 OR s.setrole IN (SELECT r.oid FROM pg_roles r
                 WHERE r.rolname IN ('authenticator', 'service_role', 'authenticated', 'anon', 'postgres') OR r.rolname = current_user))) AS overrides`,
  // Hàm của từng trigger cms_* (bảng · tên · hàm · SECURITY DEFINER) — INVOKER / DEFINER đúng ma trận, hàm ở schema public.
  triggerFns: `SELECT c.relname::text AS t, t.tgname::text AS name, p.proname::text AS fn, p.pronamespace = 'public'::regnamespace AS fn_public, p.prosecdef AS secdef
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
 WHERE c.relnamespace = 'public'::regnamespace AND left(c.relname, 4) = 'cms_' AND NOT t.tgisinternal ORDER BY 1, 2`,
  // V4 policy chốt + cổng Q-206: nhánh thật chưa ready, version 1, cổng đóng.
  lockPolicy: `SELECT public.cms__lock_policy() -> 'real' ->> 'ready' AS real_ready, public.cms__lock_policy() ->> 'version' AS version,
       public.cms__results_release_open() AS release_open`,
  // V3 bảng payout: RLS, relacl / attacl không có PUBLIC / anon / authenticated / service_role.
  payoutAcl: `SELECT c.relname::text AS t, c.relrowsecurity AS rls,
       (SELECT count(*)::int FROM aclexplode(c.relacl) x
         WHERE x.grantee = 0 OR x.grantee IN (SELECT r.oid FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated', 'service_role'))) AS api_grants,
       (SELECT count(*)::int FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) y
         WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
           AND (y.grantee = 0 OR y.grantee IN (SELECT r.oid FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated', 'service_role')))) AS api_col_grants
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname IN ('cms_payouts', 'cms_payout_staff') ORDER BY 1`,
  // V5 bất biến mọi payout (MỘT dòng tổng hợp): payout = tiền run = Σ payout_staff = Σ cms_results của run; số staff = staff_rows
  // = số dược sĩ có kết quả; số staff > 0 đ = staff_paid; config_fp = cms__config_fp(chương trình); chương trình 'locked', pointer
  // = run của payout, cùng is_test.
  invPayout: `WITH x AS (
  SELECT p.program_id, p.is_test,
         (p.amount_vnd::numeric = r.amount_vnd::numeric
          AND p.amount_vnd::numeric = (SELECT coalesce(sum(s.amount_vnd), 0)::numeric FROM public.cms_payout_staff s WHERE s.program_id = p.program_id)
          AND p.amount_vnd::numeric = (SELECT coalesce(sum(z.amount_vnd), 0)::numeric FROM public.cms_results z WHERE z.run_id = p.run_id)
          AND p.staff_rows = (SELECT count(*) FROM public.cms_payout_staff s WHERE s.program_id = p.program_id)
          AND p.staff_rows = (SELECT count(DISTINCT z.user_id) FROM public.cms_results z WHERE z.run_id = p.run_id)
          AND p.staff_paid = (SELECT count(*) FROM public.cms_payout_staff s WHERE s.program_id = p.program_id AND s.amount_vnd > 0)
          AND p.config_fp = public.cms__config_fp(p.program_id)
          AND g.status = 'locked' AND g.current_result_run_id = p.run_id AND g.is_test = p.is_test) AS ok
    FROM public.cms_payouts p LEFT JOIN public.cms_sync_runs r ON r.id = p.run_id LEFT JOIN public.cms_programs g ON g.id = p.program_id)
SELECT count(*)::int AS n, count(*) FILTER (WHERE x.is_test)::int AS n_test, count(*) FILTER (WHERE x.ok IS NOT TRUE)::int AS bad,
       coalesce(string_agg(x.program_id::text, ',' ORDER BY x.program_id) FILTER (WHERE x.ok IS NOT TRUE), '') AS bad_ids
  FROM x`,
  // V6 chương trình 'locked' không payout: chỉ được là QA (dấu vết rollback 123, H8) — thật ⇒ đỏ. MỘT dòng tổng hợp.
  invLocked: `SELECT count(*) FILTER (WHERE NOT g.is_test)::int AS real_n, count(*) FILTER (WHERE g.is_test)::int AS qa_n,
       coalesce(string_agg(g.id::text, ',' ORDER BY g.id) FILTER (WHERE NOT g.is_test), '') AS real_ids
  FROM public.cms_programs g WHERE g.status = 'locked' AND NOT EXISTS (SELECT 1 FROM public.cms_payouts p WHERE p.program_id = g.id)`,
  // V5 theo TỪNG dược sĩ (db-reviewer 123 P2): tập (user_id, tiền) của cms_payout_staff = Σ cms_results theo dược sĩ của run chốt
  // (FULL JOIN — thừa / thiếu / lệch tiền đều tính); chuyển tiền giữa hai người hay đổi người cùng tiền không lọt qua tổng.
  invPayoutStaff: `WITH s AS (SELECT y.program_id, y.user_id, y.amount_vnd::numeric AS amt FROM public.cms_payout_staff y),
     r AS (SELECT p.program_id, z.user_id, sum(z.amount_vnd)::numeric AS amt
             FROM public.cms_payouts p JOIN public.cms_results z ON z.run_id = p.run_id GROUP BY p.program_id, z.user_id),
     d AS (SELECT DISTINCT coalesce(s.program_id, r.program_id)::text AS id
             FROM s FULL JOIN r ON r.program_id = s.program_id AND r.user_id = s.user_id WHERE s.amt IS DISTINCT FROM r.amt)
SELECT (SELECT count(*)::int FROM public.cms_payouts) AS n, (SELECT count(*)::int FROM d) AS bad,
       (SELECT coalesce(string_agg(d.id, ',' ORDER BY d.id), '') FROM d) AS bad_ids`,
  // Run đã chốt còn NGUYÊN như lúc seal: số dòng 4 bảng = seal_expect (khoá 122: sales_lines / results / catalog / result_lines)
  // và Σ cms_result_lines.amount_vnd = tiền run. Khoá thiếu / sai dạng ⇒ lệch (không ép kiểu lỗi).
  invRunFrozen: `WITH x AS (
  SELECT p.program_id,
         (r.seal_expect IS NOT NULL
          AND ${(['sales_lines:cms_sales_lines', 'results:cms_results', 'catalog:cms_result_catalog', 'result_lines:cms_result_lines'] as const).map((kt) => {
    const [k, t] = kt.split(':')
    return `(SELECT count(*) FROM public.${t} l WHERE l.run_id = r.id) = (CASE WHEN (r.seal_expect ->> '${k}') ~ '^[0-9]{1,18}$' THEN (r.seal_expect ->> '${k}')::bigint END)`
  }).join('\n          AND ')}
          AND (SELECT coalesce(sum(l.amount_vnd), 0)::numeric FROM public.cms_result_lines l WHERE l.run_id = r.id) = r.amount_vnd::numeric) AS ok
    FROM public.cms_payouts p LEFT JOIN public.cms_sync_runs r ON r.id = p.run_id)
SELECT count(*)::int AS n, count(*) FILTER (WHERE x.ok IS NOT TRUE)::int AS bad,
       coalesce(string_agg(x.program_id::text, ',' ORDER BY x.program_id) FILTER (WHERE x.ok IS NOT TRUE), '') AS bad_ids
  FROM x`,
  // Quyền GIÁN TIẾP trên 2 bảng payout: has_any_column_privilege tính cả PUBLIC + quyền thừa kế qua vai trung gian; và mọi quan hệ
  // (view / matview / rule) phụ thuộc bảng qua pg_rewrite — kênh đọc vòng qua RLS / ACL bảng. Chỉ tên quan hệ, không dữ liệu.
  payoutReach: `SELECT c.relname::text AS t,
       (SELECT count(*)::int FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) ro(n)
         WHERE has_any_column_privilege(ro.n, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')) AS api_any_col,
       (SELECT count(DISTINCT w.ev_class)::int FROM pg_depend d JOIN pg_rewrite w ON w.oid = d.objid
         WHERE d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass AND d.refobjid = c.oid AND w.ev_class <> c.oid) AS dep_rels,
       (SELECT coalesce(string_agg(DISTINCT w.ev_class::regclass::text, ',' ORDER BY w.ev_class::regclass::text), '') FROM pg_depend d JOIN pg_rewrite w ON w.oid = d.objid
         WHERE d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass AND d.refobjid = c.oid AND w.ev_class <> c.oid) AS dep_names
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname IN ('cms_payouts', 'cms_payout_staff') ORDER BY 1`,
  // VERIFY V8 của migration 123: MỌI chương trình THẬT có rpc_cms_lock_preview(...)->'blockers' chứa CMS_LOCK_RELEASE_GATE hoặc
  // CMS_LOCK_POLICY_PENDING ⇒ không có đường chốt thật. Hàm STABLE ⇒ chạy được trong READ ONLY; mỗi chương trình thật một lần gọi.
  lockPreview: `SELECT count(*)::int AS n_real,
       count(*) FILTER (WHERE NOT coalesce(x.b ?| ARRAY['CMS_LOCK_RELEASE_GATE', 'CMS_LOCK_POLICY_PENDING'], false))::int AS open_n,
       coalesce(string_agg(x.id::text, ',' ORDER BY x.id) FILTER (WHERE NOT coalesce(x.b ?| ARRAY['CMS_LOCK_RELEASE_GATE', 'CMS_LOCK_POLICY_PENDING'], false)), '') AS open_ids
  FROM (SELECT p.id, public.rpc_cms_lock_preview(p.id) -> 'blockers' AS b FROM public.cms_programs p WHERE NOT p.is_test) x`,
  // 124: mọi payout chốt bằng chứng nhận phải trỏ chứng nhận decision10 CỦA ĐÚNG chương trình + run, đã bị thay / thu hồi thì không
  // (bất biến sau chốt); payout khác basis không được mang id. 0 payout operator_reconciliation ⇒ CHƯA CHỨNG MINH.
  invAttest: `SELECT count(*) FILTER (WHERE p.source_complete_basis = 'operator_reconciliation')::int AS n,
       count(*) FILTER (WHERE (p.source_complete_basis = 'operator_reconciliation') IS DISTINCT FROM (p.source_attestation_id IS NOT NULL)
         OR (p.source_attestation_id IS NOT NULL AND (a.id IS NULL OR a.program_id <> p.program_id OR a.run_id <> p.run_id
             OR a.field_set <> 'decision10' OR a.reference_rows_fp <> a.run_rows_fp OR a.revoked_at IS NOT NULL OR a.superseded_by IS NOT NULL)))::int AS bad,
       coalesce(string_agg(p.program_id::text, ',' ORDER BY p.program_id) FILTER (WHERE p.source_attestation_id IS NOT NULL AND (a.id IS NULL
         OR a.run_id <> p.run_id OR a.revoked_at IS NOT NULL OR a.superseded_by IS NOT NULL)), '') AS bad_ids
  FROM public.cms_payouts p LEFT JOIN public.cms_source_attestations a ON a.id = p.source_attestation_id`,
  // ── 125 (CMS-Q-220, chỉ phase ≥ 125) — bất biến KHÔNG áp toàn bảng lịch sử (QA đã chốt có trần cũ giữ nguyên, không đỏ oan) ──
  // Cấu hình CHƯA CHỐT (draft / active) có bậc cuối hữu hạn (kỳ vọng 0 dòng). Bậc cuối = tier_order lớn nhất (PK).
  inv125LastTier: `SELECT g.id::text AS id, g.status, count(*)::int AS products FROM public.cms_programs g JOIN public.cms_program_products pp ON pp.program_id = g.id
 WHERE g.status IN ('draft', 'active')
   AND (SELECT t.qty_to FROM public.cms_program_tiers t WHERE t.program_product_id = pp.id ORDER BY t.tier_order DESC LIMIT 1) IS NOT NULL
 GROUP BY g.id, g.status ORDER BY 1`,
  // Run HIỆN HÀNH của chương trình chưa chốt mang trần (cap_quantity / at_cap / dòng AT_CAP) — kỳ vọng 0 dòng.
  inv125CurrentCap: `SELECT g.id::text AS id,
       (SELECT count(*)::int FROM public.cms_results x WHERE x.run_id = g.current_result_run_id AND (x.cap_quantity IS NOT NULL OR x.at_cap)) AS cap_rows,
       (SELECT count(*)::int FROM public.cms_result_lines y WHERE y.run_id = g.current_result_run_id AND y.status = 'AT_CAP') AS at_cap_lines
  FROM public.cms_programs g
 WHERE g.status IN ('draft', 'active') AND g.current_result_run_id IS NOT NULL
   AND (EXISTS (SELECT 1 FROM public.cms_results x WHERE x.run_id = g.current_result_run_id AND (x.cap_quantity IS NOT NULL OR x.at_cap))
        OR EXISTS (SELECT 1 FROM public.cms_result_lines y WHERE y.run_id = g.current_result_run_id AND y.status = 'AT_CAP'))
 ORDER BY 1`,
  // Số chương trình chưa chốt có run hiện hành (0 ⇒ bất biến run hiện hành CHƯA CHỨNG MINH — không xanh rỗng).
  inv125Current: `SELECT count(*)::int AS n FROM public.cms_programs WHERE status IN ('draft', 'active') AND current_result_run_id IS NOT NULL`,
  // ── 126 (sales-only, chỉ phase ≥ 126) — như V4 cuối migration 126: run bán của chương trình THẬT công bố SAU marker 126 phải mang
  // detail.results_basis = 'sales_only_v1' (dấu do DB đóng trong publish). MỘT dòng tổng hợp: marker_at NULL ⇒ thiếu marker (đỏ,
  // không xanh rỗng); n = số run thật công bố sau 126 (0 ⇒ CHƯA CHỨNG MINH); bad = số run thiếu dấu (kỳ vọng 0).
  inv126RealBasis: `WITH m AS (SELECT applied_at FROM public.app_migrations WHERE version = '126'),
x AS (SELECT r.id, ((r.detail ->> 'results_basis') IS DISTINCT FROM 'sales_only_v1' OR (r.detail ->> 'results_gate') IS DISTINCT FROM '126') AS bad
        FROM public.cms_sync_runs r CROSS JOIN m
       WHERE r.kind = 'sales' AND NOT r.is_test AND r.published_at > m.applied_at)
SELECT (SELECT max(m.applied_at) FROM m) AS marker_at, count(*)::int AS n, count(*) FILTER (WHERE x.bad)::int AS bad,
       coalesce(string_agg(x.id::text, ',' ORDER BY x.id) FILTER (WHERE x.bad), '') AS bad_ids
  FROM x`,
} as const

export type CmsV8Role = 'super' | 'admin' | 'sm' | 'staff' | 'qlch'
export const CMS_V8_ROLES: readonly CmsV8Role[] = ['super', 'admin', 'sm', 'staff', 'qlch']
const V8_DB_ROLE: Record<CmsV8Role, string> = { super: 'admin', admin: 'admin', sm: 'sm', staff: 'staff', qlch: 'store_manager' }

/** Bảng đo trong V8: tên cột kết quả ⇒ bảng. Bảng con lọc theo program_id; Product Master chỉ super. */
const V8_TABLES: Array<[string, string]> = [
  ['programs', 'cms_programs'], ['stores', 'cms_program_stores'], ['products', 'cms_program_products'],
  ['tiers', 'cms_program_tiers'], ['import_runs', 'cms_import_runs'], ['master', 'cms_product_master'],
]

/**
 * Bọc riêng cho V8: transaction READ ONLY ở REPEATABLE READ — khối DO (oracle) và câu SELECT (phiên authenticated) cùng
 * MỘT snapshot, cron / kích hoạt ghi xen giữa không làm đỏ oan / xanh oan (db-reviewer vòng 2 P2-1).
 */
export function pgMetaReadOnlySnapshot(statements: string): string {
  return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; ${statements.trim().replace(/;\s*$/, '')}; ROLLBACK;`
}

/** Phase khai báo cho V8: 120 / 121 (trước kết quả) · 122 (có 4 RPC đọc kết quả) · 123 (thêm rpc_cms_payout, SM thấy 'locked').
 *  Không khai ⇒ chỉ hợp lệ trên DB 120 / 121 (giữ nguyên lệnh runbook P1); DB đã chạy 122 bắt buộc khai --phase=122. */
export type CmsV8Phase = '120' | '121' | '122' | '123' | '124' | '125' | '126'
/**
 * Phase mà CLI `cms-verify v8 --phase=` / `print-sql --what=v8` NHẬN (và cmsVerifyV8Sql kiểm). 123 mở ở CLI (P3a): harness
 * scripts/qa-cms-cli-exit.mjs §2b dùng phase 127 làm ca "phase lạ" (126 nay hợp lệ); §7 chạy `v8 --phase=123` trên DB đã chốt QA.
 */
export const CMS_V8_PHASES: readonly CmsV8Phase[] = ['120', '121', '122', '123', '124', '125', '126']
/** RPC authenticated được gọi theo phase (tên, sắp C). */
export const CMS_V8_RPC_CALLABLE: Record<CmsV8Phase, string> = {
  '120': '',
  '121': '',
  '122': 'rpc_cms_result_excluded,rpc_cms_result_header,rpc_cms_result_lines,rpc_cms_result_rows',
  '123': 'rpc_cms_payout,rpc_cms_result_excluded,rpc_cms_result_header,rpc_cms_result_lines,rpc_cms_result_rows',
  // 124: + 4 RPC chứng nhận (authenticated; DB kiểm super + marker — vai khác gọi được nhưng nhận CMS_ATTEST_FORBIDDEN).
  '124': 'rpc_cms_payout,rpc_cms_result_excluded,rpc_cms_result_header,rpc_cms_result_lines,rpc_cms_result_rows,rpc_cms_run_source_export,rpc_cms_source_attest,rpc_cms_source_attest_revoke,rpc_cms_source_attestations',
  // 125: không thêm RPC authenticated (2 RPC thay vẫn service_role; guard không cấp ai).
  '125': 'rpc_cms_payout,rpc_cms_result_excluded,rpc_cms_result_header,rpc_cms_result_lines,rpc_cms_result_rows,rpc_cms_run_source_export,rpc_cms_source_attest,rpc_cms_source_attest_revoke,rpc_cms_source_attestations',
  // 126: không thêm RPC (2 hàm thay giữ ACL: cổng chỉ owner, publish service_role) ⇒ như 125.
  '126': 'rpc_cms_payout,rpc_cms_result_excluded,rpc_cms_result_header,rpc_cms_result_lines,rpc_cms_result_rows,rpc_cms_run_source_export,rpc_cms_source_attest,rpc_cms_source_attest_revoke,rpc_cms_source_attestations',
}
/**
 * Khoá JSON của rpc_cms_payout (migration 123 §6 — đọc từ thân hàm): cấp trên mọi vai (program_total = null với non-super),
 * thêm cho super, và khoá từng dòng (+ email chỉ super). V8 123 so ĐÚNG tập này theo vai khai báo (danh sách cho phép).
 */
export const CMS_PAYOUT_KEYS_TOP: readonly string[] = ['program_id', 'run_id', 'is_test', 'locked_at', 'policy_version', 'viewer', 'program_total', 'scope_total', 'rows']
export const CMS_PAYOUT_KEYS_TOP_SUPER: readonly string[] = ['locked_by', 'staff_rows', 'staff_paid', 'candidate_lines', 'candidate_gmv', 'unassigned_lines',
  'unassigned_gmv', 'ack_reason', 'policy', 'source_complete_basis', 'source_complete_through', 'run_started_at']
export const CMS_PAYOUT_KEYS_ROW: readonly string[] = ['user_id', 'store_id', 'name', 'store_name', 'amount_vnd', 'products_with_cms']
/** 124: rpc_cms_payout (super) thêm id + tóm tắt chứng nhận đã dùng chốt. */
export const CMS_PAYOUT_KEYS_TOP_SUPER_124: readonly string[] = ['source_attestation_id', 'source_attestation']

/**
 * V8 — phiên `authenticated` MÔ PHỎNG ở DB trong MỘT transaction READ ONLY + REPEATABLE READ (claim không ký, không đọc
 * secret), theo VAI KHAI BÁO và PHASE KHAI BÁO (bỏ trống = trước 122; 122 sau migration kết quả):
 * (1) khối DO (vai superuser của pg-meta) chụp vai thật của user, marker, vai chạy có bypass, phase CMS của DB, và TẬP id
 *     chương trình kỳ vọng tính ĐỘC LẬP từ bảng gốc theo H5 / H6 / H9b (oracle — không gọi helper), cùng số dòng kỳ vọng /
 *     tổng của từng bảng con (theo tập đó) và Product Master; phase 122: thêm tập người được xem kết quả (oracle độc lập với
 *     cms__visible_result_users) và vân tay TẬP dòng kết quả kỳ vọng (chương trình | run | dược sĩ | SP) của run hiện hành;
 * (2) SET LOCAL ROLE authenticated + claim; phase 122: khối DO CHẠY BẰNG authenticated gọi THẬT 4 RPC đọc cho MỌI chương
 *     trình trong DB (ngoài tập ⇒ phải CMS_RESULT_FORBIDDEN; trong tập ⇒ header được; rows của run hiện hành ⇒ gom tập dòng;
 *     excluded ⇒ chỉ super) — ghi số đếm / vân tay vào setting của transaction;
 * (3) MỘT SELECT đo: RLS đang áp, vai không bypass, cờ super thật, tập id helper = tập kỳ vọng (so mảng), số dòng thấy từng
 *     bảng = kỳ vọng, dòng ngoài mảng helper = 0, quyền riêng tư / ghi / RPC gọi được (đúng tên theo phase), kết quả 122.
 */
export function cmsVerifyV8Sql(userId: string, role: CmsV8Role, phase?: CmsV8Phase): string {
  if (phase !== undefined && !CMS_V8_PHASES.includes(phase)) throw new Error('CMS VERIFY V8: phase không hợp lệ')
  return buildCmsV8Sql(userId, role, phase)
}
/**
 * V8 phase 123 (P3a): như 122 + oracle SM thấy 'locked' + phiên authenticated gọi THẬT rpc_cms_payout cho MỌI chương trình —
 * ngoài tập ⇒ CMS_RESULT_FORBIDDEN; trong tập chưa chốt ⇒ CMS_PAYOUT_NOT_LOCKED; trong tập đã chốt ⇒ tập dòng (chương trình |
 * dược sĩ | tiền) = oracle phạm vi hiện tại (Q-208 / Q-217: super mọi dòng + program_total + email; SM / QLCH staff hiện thuộc
 * phạm vi, chỉ scope_total, không email; staff chính mình), tổng đúng, không lộ khoá chỉ-super. CLI: `v8 --phase=123`.
 */
export function cmsVerifyV8Sql123(userId: string, role: CmsV8Role): string {
  return buildCmsV8Sql(userId, role, '123')
}
function buildCmsV8Sql(userId: string, role: CmsV8Role, phase?: CmsV8Phase): string {
  if (!isCmsUuid(userId)) throw new Error('CMS VERIFY V8: user id không hợp lệ')
  if (!CMS_V8_ROLES.includes(role)) throw new Error('CMS VERIFY V8: vai không hợp lệ')
  const childCount = (table: string) => `(SELECT count(*) FROM public.${table} x WHERE x.program_id = ANY (v_exp))`
  const p124 = phase === '124' || phase === '125' || phase === '126'
  const p123 = phase === '123' || p124
  const p122 = phase === '122' || p123
  // Oracle người xem kết quả (122) — viết lại độc lập theo luật phạm vi hiện tại (kế hoạch PM §4.3), KHÔNG gọi helper 122.
  const oracle122 = !p122 ? '' : `
  IF v_decl = 'super' THEN
    v_vis := NULL;
  ELSIF v_decl = 'staff' THEN
    v_vis := ARRAY[v_uid];
  ELSIF v_decl = 'qlch' THEN
    SELECT coalesce(array_agg(u.id ORDER BY u.id), '{}'::uuid[]) INTO v_vis FROM public.users u JOIN public.stores s ON s.id = u.store_id
     WHERE u.role = 'staff' AND u.store_id = v_store AND s.store_type = 'os' AND s.is_active;
  ELSIF v_decl = 'sm' THEN
    SELECT coalesce(array_agg(DISTINCT u.id), '{}'::uuid[]) INTO v_vis FROM public.users u JOIN public.stores s ON s.id = u.store_id
      JOIN public.sm_store_assignments a ON a.store_id = u.store_id AND a.sm_user_id = v_uid
     WHERE u.role = 'staff' AND s.store_type = 'os' AND s.is_active;
  ELSE
    v_vis := '{}'::uuid[];
  END IF;
  SELECT count(*)::int, md5(coalesce(string_agg(q.t, ';' ORDER BY q.t COLLATE "C"), '')) INTO v_rn, v_rmd5
    FROM (SELECT p.id::text || '|' || r.run_id::text || '|' || r.user_id::text || '|' || r.program_product_id::text AS t
            FROM public.cms_programs p JOIN public.cms_results r ON r.run_id = p.current_result_run_id
           WHERE p.id = ANY (v_exp) AND (v_vis IS NULL OR r.user_id = ANY (v_vis))) q;
  SELECT count(*)::int INTO v_rtotal FROM public.cms_programs p JOIN public.cms_results r ON r.run_id = p.current_result_run_id
   WHERE p.id = ANY (v_exp);
  SELECT count(*)::int, md5(coalesce(string_agg(q.t, ';' ORDER BY q.t COLLATE "C"), '')) INTO v_ln, v_lmd5
    FROM (SELECT p.id::text || '|' || l.run_id::text || '|' || l.user_id::text || '|' || l.program_product_id::text || '|' || l.seq::text AS t
            FROM public.cms_programs p JOIN public.cms_result_lines l ON l.run_id = p.current_result_run_id
            JOIN public.cms_sales_lines sl ON sl.run_id = l.run_id AND sl.order_line_id = l.order_line_id
           WHERE p.id = ANY (v_exp) AND (v_vis IS NULL OR l.user_id = ANY (v_vis))) q;
  SELECT count(*)::int INTO v_ltotal FROM public.cms_programs p JOIN public.cms_result_lines l ON l.run_id = p.current_result_run_id
   WHERE p.id = ANY (v_exp);
  SELECT md5(coalesce(string_agg(q.t, ';' ORDER BY q.t COLLATE "C"), '')) INTO v_cmd5
    FROM (SELECT p.id::text || '|' || k.run_id::text || '|' || k.user_id::text AS t
            FROM public.cms_programs p JOIN public.cms_result_catalog k ON k.run_id = p.current_result_run_id
           WHERE p.id = ANY (v_exp) AND (v_vis IS NULL OR k.user_id = ANY (v_vis))) q;
  SELECT md5(coalesce(string_agg(q.t, ';' ORDER BY q.t COLLATE "C"), '')) INTO v_umd5
    FROM (SELECT DISTINCT p.id::text || '|' || u.id::text AS t
            FROM public.cms_programs p JOIN public.cms_results r ON r.run_id = p.current_result_run_id JOIN public.users u ON u.id = r.user_id
           WHERE p.id = ANY (v_exp) AND (v_vis IS NULL OR r.user_id = ANY (v_vis))) q;
  -- Một staff NGOÀI phạm vi người xem (non-super) — để thử rpc_cms_result_lines(p_user_id) phải FORBIDDEN.
  SELECT coalesce((SELECT u.id::text FROM public.users u WHERE v_vis IS NOT NULL AND u.role = 'staff' AND NOT (u.id = ANY (v_vis))
                    ORDER BY u.id LIMIT 1), '') INTO v_outsider;
  PERFORM set_config('cms_v8.all_ids', (SELECT coalesce(array_agg(p.id ORDER BY p.id), '{}'::uuid[]) FROM public.cms_programs p)::text, true);
  PERFORM set_config('cms_v8.rx_outside', ((SELECT count(*) FROM public.cms_programs p) - cardinality(v_exp))::text, true);
  PERFORM set_config('cms_v8.rx_exp_n', v_rn::text, true);
  PERFORM set_config('cms_v8.rx_exp_md5', v_rmd5, true);
  PERFORM set_config('cms_v8.rx_total_n', v_rtotal::text, true);
  PERFORM set_config('cms_v8.rx_lexp_n', v_ln::text, true);
  PERFORM set_config('cms_v8.rx_lexp_md5', v_lmd5, true);
  PERFORM set_config('cms_v8.rx_ltotal_n', v_ltotal::text, true);
  PERFORM set_config('cms_v8.rx_cexp_md5', v_cmd5, true);
  PERFORM set_config('cms_v8.rx_uexp_md5', v_umd5, true);
  PERFORM set_config('cms_v8.outsider', v_outsider, true);`
  // Oracle payout 123 (Q-208 / Q-217) — tập dòng (chương trình | dược sĩ | tiền) và tổng theo phạm vi HIỆN TẠI, độc lập với
  // rpc_cms_payout / cms__visible_result_users (dùng v_vis của oracle 122): super mọi dòng + program_total; còn lại scope_total.
  const oracle123 = !p123 ? '' : `
  SELECT count(*)::int, md5(coalesce(string_agg(q.t, ';' ORDER BY q.t COLLATE "C"), '')) INTO v_pn, v_pmd5
    FROM (SELECT p.id::text || '|' || s.user_id::text || '|' || s.amount_vnd::text AS t
            FROM public.cms_programs p JOIN public.cms_payout_staff s ON s.program_id = p.id
           WHERE p.id = ANY (v_exp) AND (v_vis IS NULL OR s.user_id = ANY (v_vis))) q;
  SELECT count(*)::int INTO v_ptotal FROM public.cms_programs p JOIN public.cms_payout_staff s ON s.program_id = p.id WHERE p.id = ANY (v_exp);
  SELECT count(*)::int, md5(coalesce(string_agg(q.t, ';' ORDER BY q.t COLLATE "C"), '')) INTO v_pprog, v_ptmd5
    FROM (SELECT p.id::text || '|' || (SELECT coalesce(sum(s.amount_vnd), 0) FROM public.cms_payout_staff s
                                        WHERE s.program_id = p.id AND (v_vis IS NULL OR s.user_id = ANY (v_vis)))::text
                 || '|' || CASE WHEN v_decl = 'super' THEN y.amount_vnd::text ELSE '' END AS t
            FROM public.cms_programs p JOIN public.cms_payouts y ON y.program_id = p.id WHERE p.id = ANY (v_exp)) q;
  PERFORM set_config('cms_v8.py_exp_n', v_pn::text, true);
  PERFORM set_config('cms_v8.py_exp_md5', v_pmd5, true);
  PERFORM set_config('cms_v8.py_total_n', v_ptotal::text, true);
  PERFORM set_config('cms_v8.py_prog_n', v_pprog::text, true);
  PERFORM set_config('cms_v8.py_texp_md5', v_ptmd5, true);`
  // Phiên authenticated gọi THẬT rpc_cms_payout cho MỌI chương trình (sau khối 122; thụt lề như khối 122). Khoá trả về so với
  // DANH SÁCH CHO PHÉP theo VAI KHAI BÁO (đúng tập khoá của rpc_cms_payout trong 123) — khoá lạ / thiếu / khoá chỉ-super ⇒ lệch.
  const sqlArr = (a: readonly string[]) => `ARRAY(SELECT k FROM unnest(ARRAY[${a.map((k) => `'${k}'`).join(', ')}]::text[]) k ORDER BY k COLLATE "C")`
  const superDecl = role === 'super'
  const topAllowed = superDecl ? [...CMS_PAYOUT_KEYS_TOP, ...CMS_PAYOUT_KEYS_TOP_SUPER, ...(p124 ? CMS_PAYOUT_KEYS_TOP_SUPER_124 : [])] : CMS_PAYOUT_KEYS_TOP
  const rowAllowed = superDecl ? [...CMS_PAYOUT_KEYS_ROW, 'email'] : CMS_PAYOUT_KEYS_ROW
  const rpc123 = !p123 ? '' : `DO $cmsv8p$
DECLARE
  v_all   uuid[] := current_setting('cms_v8.all_ids')::uuid[];
  v_exp   uuid[] := current_setting('cms_v8.exp_ids')::uuid[];
  v_sdecl boolean := ${superDecl ? 'true' : 'false'};
  v_top_ok text[] := ${sqlArr(topAllowed)};
  v_row_ok text[] := ${sqlArr(rowAllowed)};
  v_id    uuid; v_p jsonb;
  v_leak  int := 0; v_deny int := 0; v_err int := 0; v_nolock int := 0; v_calls int := 0; v_field int := 0;
  v_rows  text[] := '{}'::text[]; v_tot text[] := '{}'::text[];
BEGIN
  FOREACH v_id IN ARRAY v_all LOOP
    BEGIN
      v_p := public.rpc_cms_payout(v_id);
      IF NOT (v_id = ANY (v_exp)) THEN v_leak := v_leak + 1; END IF;
      v_calls := v_calls + 1;
      v_rows := v_rows || ARRAY(SELECT v_id::text || '|' || (e ->> 'user_id') || '|' || (e ->> 'amount_vnd') FROM jsonb_array_elements(v_p -> 'rows') e);
      v_tot := v_tot || (v_id::text || '|' || coalesce(v_p ->> 'scope_total', 'NULL') || '|' || coalesce(v_p ->> 'program_total', ''));
      -- Tập khoá cấp trên / từng dòng = đúng danh sách cho phép của vai khai báo (email chỉ super); non-super: program_total = null.
      IF ARRAY(SELECT k FROM jsonb_object_keys(v_p) k ORDER BY k COLLATE "C") IS DISTINCT FROM v_top_ok THEN v_field := v_field + 1; END IF;
      IF NOT v_sdecl AND jsonb_typeof(v_p -> 'program_total') IS DISTINCT FROM 'null' THEN v_field := v_field + 1; END IF;
      v_field := v_field + (SELECT count(*)::int FROM jsonb_array_elements(v_p -> 'rows') e
                             WHERE ARRAY(SELECT k FROM jsonb_object_keys(e) k ORDER BY k COLLATE "C") IS DISTINCT FROM v_row_ok);
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'CMS_RESULT_FORBIDDEN' THEN
        IF v_id = ANY (v_exp) THEN v_deny := v_deny + 1; END IF;
      ELSIF SQLERRM = 'CMS_PAYOUT_NOT_LOCKED' THEN
        IF v_id = ANY (v_exp) THEN v_nolock := v_nolock + 1; ELSE v_leak := v_leak + 1; END IF;
      ELSE
        v_err := v_err + 1;
      END IF;
    END;
  END LOOP;
  PERFORM set_config('cms_v8.py_role', current_user::text, true);
  PERFORM set_config('cms_v8.py_leak', v_leak::text, true);
  PERFORM set_config('cms_v8.py_deny', v_deny::text, true);
  PERFORM set_config('cms_v8.py_err', v_err::text, true);
  PERFORM set_config('cms_v8.py_nolock', v_nolock::text, true);
  PERFORM set_config('cms_v8.py_calls', v_calls::text, true);
  PERFORM set_config('cms_v8.py_field', v_field::text, true);
  PERFORM set_config('cms_v8.py_seen_n', cardinality(v_rows)::text, true);
  PERFORM set_config('cms_v8.py_seen_md5', (SELECT md5(coalesce(string_agg(t, ';' ORDER BY t COLLATE "C"), '')) FROM unnest(v_rows) t), true);
  PERFORM set_config('cms_v8.py_tseen_md5', (SELECT md5(coalesce(string_agg(t, ';' ORDER BY t COLLATE "C"), '')) FROM unnest(v_tot) t), true);
END
$cmsv8p$;
`
  const py123 = !p123 ? '' : `,
       current_setting('cms_v8.py_role') AS py_role, current_setting('cms_v8.py_leak')::int AS py_leak,
       current_setting('cms_v8.py_deny')::int AS py_deny, current_setting('cms_v8.py_err')::int AS py_err,
       current_setting('cms_v8.py_nolock')::int AS py_nolock, current_setting('cms_v8.py_calls')::int AS py_calls,
       current_setting('cms_v8.py_field')::int AS py_field, current_setting('cms_v8.py_prog_n')::int AS py_prog_n,
       current_setting('cms_v8.py_seen_n')::int AS py_seen_n, current_setting('cms_v8.py_exp_n')::int AS py_exp_n,
       current_setting('cms_v8.py_total_n')::int AS py_total_n,
       current_setting('cms_v8.py_seen_md5') = current_setting('cms_v8.py_exp_md5') AS py_same_set,
       current_setting('cms_v8.py_tseen_md5') = current_setting('cms_v8.py_texp_md5') AS py_totals_same`
  // Phiên authenticated gọi THẬT RPC đọc 122 cho MỌI chương trình (thụt lề: không dòng nào bắt đầu bằng SELECT / WITH ở cột 0).
  const rpc122 = !p122 ? '' : `DO $cmsv8r$
DECLARE
  v_all   uuid[] := current_setting('cms_v8.all_ids')::uuid[];
  v_exp   uuid[] := current_setting('cms_v8.exp_ids')::uuid[];
  v_out   text := current_setting('cms_v8.outsider');
  v_su    boolean := public.is_super_admin();
  v_id    uuid; v_h jsonb; v_r jsonb; v_l jsonb; v_run uuid; v_after integer; v_pages integer;
  v_leak  int := 0; v_deny int := 0; v_err int := 0; v_exc int := 0; v_exc_calls int := 0; v_lleak int := 0;
  v_tuples text[] := '{}'::text[]; v_lt text[] := '{}'::text[]; v_ct text[] := '{}'::text[]; v_ut text[] := '{}'::text[];
BEGIN
  FOREACH v_id IN ARRAY v_all LOOP
    BEGIN
      v_h := public.rpc_cms_result_header(v_id);
      IF NOT (v_id = ANY (v_exp)) THEN v_leak := v_leak + 1; END IF;
      IF jsonb_typeof(v_h -> 'run') = 'object' THEN
        v_run := (v_h -> 'run' ->> 'id')::uuid;
        v_r := public.rpc_cms_result_rows(v_id, v_run);
        v_tuples := v_tuples || ARRAY(
          SELECT v_id::text || '|' || (v_r ->> 'run_id') || '|' || (e ->> 'user_id') || '|' || (e ->> 'program_product_id')
            FROM jsonb_array_elements(v_r -> 'results') e);
        v_ct := v_ct || ARRAY(SELECT v_id::text || '|' || (v_r ->> 'run_id') || '|' || (e ->> 'user_id') FROM jsonb_array_elements(v_r -> 'catalog') e);
        v_ut := v_ut || ARRAY(SELECT v_id::text || '|' || (e ->> 'id') FROM jsonb_array_elements(v_r -> 'users') e);
        -- Dòng đơn: phân trang tới hết theo con trỏ seq (đúng cách D3 / XLSX đọc).
        v_after := NULL; v_pages := 0;
        LOOP
          v_l := public.rpc_cms_result_lines(v_id, v_run, NULL, NULL, v_after, 500);
          v_lt := v_lt || ARRAY(
            SELECT v_id::text || '|' || (v_l ->> 'run_id') || '|' || (e ->> 'user_id') || '|' || (e ->> 'program_product_id') || '|' || (e ->> 'seq')
              FROM jsonb_array_elements(v_l -> 'rows') e);
          v_pages := v_pages + 1;
          EXIT WHEN jsonb_typeof(v_l -> 'next_after_seq') IS DISTINCT FROM 'number' OR v_pages > 1000;
          v_after := (v_l ->> 'next_after_seq')::integer;
        END LOOP;
        IF v_pages > 1000 THEN v_err := v_err + 1; END IF;
        -- p_user_id ngoài phạm vi người xem ⇒ phải FORBIDDEN (nhánh quyền riêng của rpc_cms_result_lines).
        IF v_out <> '' THEN
          BEGIN
            PERFORM public.rpc_cms_result_lines(v_id, v_run, NULL, v_out::uuid, NULL, 1);
            v_lleak := v_lleak + 1;
          EXCEPTION WHEN OTHERS THEN
            IF SQLERRM <> 'CMS_RESULT_FORBIDDEN' THEN v_lleak := v_lleak + 1; END IF;
          END;
        END IF;
        IF v_su THEN
          BEGIN
            PERFORM public.rpc_cms_result_excluded(v_id, v_run, NULL, 1);
            v_exc_calls := v_exc_calls + 1;
          EXCEPTION WHEN OTHERS THEN
            v_exc := v_exc + 1;
          END;
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'CMS_RESULT_FORBIDDEN' THEN
        IF v_id = ANY (v_exp) THEN v_deny := v_deny + 1; END IF;
      ELSE
        v_err := v_err + 1;
      END IF;
    END;
    -- Non-super: excluded với run 0 cho MỌI chương trình ⇒ phải FORBIDDEN (kiểm super đứng TRƯỚC tra run — 122).
    IF NOT v_su THEN
      BEGIN
        PERFORM public.rpc_cms_result_excluded(v_id, '00000000-0000-0000-0000-000000000000'::uuid, NULL, 1);
        v_exc := v_exc + 1;
      EXCEPTION WHEN OTHERS THEN
        IF SQLERRM <> 'CMS_RESULT_FORBIDDEN' THEN v_exc := v_exc + 1; END IF;
      END;
      v_exc_calls := v_exc_calls + 1;
    END IF;
  END LOOP;
  PERFORM set_config('cms_v8.rx_role', current_user::text, true);
  PERFORM set_config('cms_v8.rx_leak', v_leak::text, true);
  PERFORM set_config('cms_v8.rx_deny', v_deny::text, true);
  PERFORM set_config('cms_v8.rx_err', v_err::text, true);
  PERFORM set_config('cms_v8.rx_exc', v_exc::text, true);
  PERFORM set_config('cms_v8.rx_exc_calls', v_exc_calls::text, true);
  PERFORM set_config('cms_v8.rx_lleak', v_lleak::text, true);
  PERFORM set_config('cms_v8.rx_seen_n', cardinality(v_tuples)::text, true);
  PERFORM set_config('cms_v8.rx_seen_md5', (SELECT md5(coalesce(string_agg(t, ';' ORDER BY t COLLATE "C"), '')) FROM unnest(v_tuples) t), true);
  PERFORM set_config('cms_v8.rx_lseen_n', cardinality(v_lt)::text, true);
  PERFORM set_config('cms_v8.rx_lseen_md5', (SELECT md5(coalesce(string_agg(t, ';' ORDER BY t COLLATE "C"), '')) FROM unnest(v_lt) t), true);
  PERFORM set_config('cms_v8.rx_cseen_md5', (SELECT md5(coalesce(string_agg(t, ';' ORDER BY t COLLATE "C"), '')) FROM unnest(v_ct) t), true);
  PERFORM set_config('cms_v8.rx_useen_md5', (SELECT md5(coalesce(string_agg(t, ';' ORDER BY t COLLATE "C"), '')) FROM unnest(v_ut) t), true);
END
$cmsv8r$;
`
  const rx122 = !p122 ? '' : `,
       current_setting('cms_v8.rx_role') AS rx_role, current_setting('cms_v8.outsider') <> '' AS rx_outsider,
       current_setting('cms_v8.rx_outside')::int AS rx_outside,
       current_setting('cms_v8.rx_leak')::int AS rx_leak, current_setting('cms_v8.rx_deny')::int AS rx_deny,
       current_setting('cms_v8.rx_err')::int AS rx_err, current_setting('cms_v8.rx_exc')::int AS rx_exc,
       current_setting('cms_v8.rx_exc_calls')::int AS rx_exc_calls, current_setting('cms_v8.rx_lleak')::int AS rx_lleak,
       current_setting('cms_v8.rx_seen_n')::int AS rx_seen_n, current_setting('cms_v8.rx_exp_n')::int AS rx_exp_n,
       current_setting('cms_v8.rx_total_n')::int AS rx_total_n,
       current_setting('cms_v8.rx_seen_md5') = current_setting('cms_v8.rx_exp_md5') AS rx_same_set,
       current_setting('cms_v8.rx_lseen_n')::int AS rx_lseen_n, current_setting('cms_v8.rx_lexp_n')::int AS rx_lexp_n,
       current_setting('cms_v8.rx_ltotal_n')::int AS rx_ltotal_n,
       current_setting('cms_v8.rx_lseen_md5') = current_setting('cms_v8.rx_lexp_md5') AS rx_lines_same,
       current_setting('cms_v8.rx_cseen_md5') = current_setting('cms_v8.rx_cexp_md5') AS rx_catalog_same,
       current_setting('cms_v8.rx_useen_md5') = current_setting('cms_v8.rx_uexp_md5') AS rx_users_same`
  return `DO $cmsv8$
DECLARE
  v_uid uuid := '${userId}';
  v_decl text := '${role}';
  v_role text; v_store uuid; v_store_ok boolean; v_qa boolean; v_exp uuid[];${p122 ? '\n  v_vis uuid[]; v_rn int; v_rmd5 text; v_rtotal int; v_ln int; v_lmd5 text; v_ltotal int; v_cmd5 text; v_umd5 text; v_outsider text;' : ''}${p123 ? '\n  v_pn int; v_pmd5 text; v_ptotal int; v_pprog int; v_ptmd5 text;' : ''}
BEGIN
  SELECT u.role::text, u.store_id INTO v_role, v_store FROM public.users u WHERE u.id = v_uid;
  SELECT coalesce(bool_or(s.store_type = 'os' AND s.is_active), false) INTO v_store_ok FROM public.stores s WHERE s.id = v_store;
  SELECT EXISTS (SELECT 1 FROM public.cms_qa_access q WHERE q.user_id = v_uid AND q.expires_at > now()) INTO v_qa;
  IF v_decl = 'super' THEN
    SELECT coalesce(array_agg(p.id ORDER BY p.id), '{}'::uuid[]) INTO v_exp FROM public.cms_programs p WHERE NOT p.is_test OR v_qa;
  ELSIF v_decl = 'sm' THEN
    SELECT coalesce(array_agg(p.id ORDER BY p.id), '{}'::uuid[]) INTO v_exp FROM public.cms_programs p
     WHERE (NOT p.is_test OR v_qa) AND p.status ${p123 ? "IN ('active', 'locked')" : "= 'active'"}
       AND EXISTS (SELECT 1 FROM public.cms_program_stores ps
                     JOIN public.sm_store_assignments a ON a.store_id = ps.store_id AND a.sm_user_id = v_uid
                     JOIN public.stores s ON s.id = a.store_id
                    WHERE ps.program_id = p.id AND s.store_type = 'os' AND s.is_active);
  ELSIF v_decl IN ('staff', 'qlch') THEN
    SELECT coalesce(array_agg(p.id ORDER BY p.id), '{}'::uuid[]) INTO v_exp FROM public.cms_programs p
     WHERE (NOT p.is_test OR v_qa) AND v_store_ok AND p.status IN ('active', 'locked')
       AND EXISTS (SELECT 1 FROM public.cms_program_stores ps WHERE ps.program_id = p.id AND ps.store_id = v_store);
  ELSE
    v_exp := '{}'::uuid[];
  END IF;
  PERFORM set_config('cms_v8.user_role', coalesce(v_role, ''), true);
  PERFORM set_config('cms_v8.qa_db', v_qa::text, true);
  PERFORM set_config('cms_v8.runner_bypass', (SELECT (r.rolsuper OR r.rolbypassrls)::text FROM pg_roles r WHERE r.rolname = current_user), true);
  PERFORM set_config('cms_v8.db_phase', CASE WHEN EXISTS (SELECT 1 FROM public.app_migrations m WHERE m.version = '126') THEN '126'
    WHEN EXISTS (SELECT 1 FROM public.app_migrations m WHERE m.version = '125') THEN '125'
    WHEN EXISTS (SELECT 1 FROM public.app_migrations m WHERE m.version = '124') THEN '124'
    WHEN EXISTS (SELECT 1 FROM public.app_migrations m WHERE m.version = '123') THEN '123'
    WHEN EXISTS (SELECT 1 FROM public.app_migrations m WHERE m.version = '122') THEN '122'
    WHEN EXISTS (SELECT 1 FROM public.app_migrations m WHERE m.version = '121') THEN '121'
    WHEN EXISTS (SELECT 1 FROM public.app_migrations m WHERE m.version = '120') THEN '120' ELSE '' END, true);
  PERFORM set_config('cms_v8.exp_ids', v_exp::text, true);
  PERFORM set_config('cms_v8.exp_programs', cardinality(v_exp)::text, true);
  PERFORM set_config('cms_v8.exp_stores', ${childCount('cms_program_stores')}::text, true);
  PERFORM set_config('cms_v8.exp_products', ${childCount('cms_program_products')}::text, true);
  PERFORM set_config('cms_v8.exp_tiers', ${childCount('cms_program_tiers')}::text, true);
  PERFORM set_config('cms_v8.exp_import_runs', (CASE WHEN v_decl = 'super' THEN ${childCount('cms_import_runs')} ELSE 0 END)::text, true);
  PERFORM set_config('cms_v8.exp_master', (CASE WHEN v_decl = 'super' THEN (SELECT count(*) FROM public.cms_product_master) ELSE 0 END)::text, true);
${V8_TABLES.map(([k, t]) => `  PERFORM set_config('cms_v8.total_${k}', (SELECT count(*) FROM public.${t})::text, true);`).join('\n')}${oracle122}${oracle123}
END
$cmsv8$;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '${userId}';
SET LOCAL request.jwt.claims = '{"sub":"${userId}","role":"authenticated"}';
${rpc122}${rpc123}WITH h AS (SELECT public.cms_readable_program_ids() AS ids)
SELECT current_user::text AS role_now, auth.uid()::text AS uid, current_setting('transaction_read_only') AS ro,
       current_setting('transaction_isolation') AS iso,
       (SELECT r.rolsuper OR r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user) AS me_bypass,
       current_setting('cms_v8.runner_bypass')::boolean AS runner_bypass,
       current_setting('cms_v8.user_role') AS user_role,
       current_setting('cms_v8.db_phase') AS db_phase,
       public.is_super_admin() AS su,
       current_setting('cms_v8.qa_db')::boolean AS qa_db,
       public.cms_has_qa_access() AS qa,
       (SELECT ids FROM h) = current_setting('cms_v8.exp_ids')::uuid[] AS same_set,
       cardinality((SELECT ids FROM h))::int AS readable,
       ${V8_TABLES.map(([, t]) => `row_security_active('public.${t}') AS rls_${t}`).join(',\n       ')},
${V8_TABLES.map(([k, t]) => `       (SELECT count(*)::int FROM public.${t}) AS seen_${k}, current_setting('cms_v8.exp_${k}')::int AS exp_${k}, current_setting('cms_v8.total_${k}')::int AS total_${k}`).join(',\n')},
       (SELECT count(*)::int FROM public.cms_programs WHERE is_test) AS test_programs,
       (SELECT count(*)::int FROM public.cms_programs WHERE status = 'draft') AS draft_programs,
       (SELECT count(*)::int FROM public.cms_programs x WHERE NOT x.id = ANY ((SELECT ids FROM h)::uuid[])) AS out_programs,
       (SELECT count(*)::int FROM public.cms_program_stores x WHERE NOT x.program_id = ANY ((SELECT ids FROM h)::uuid[])) AS out_stores,
       (SELECT count(*)::int FROM public.cms_program_products x WHERE NOT x.program_id = ANY ((SELECT ids FROM h)::uuid[])) AS out_products,
       (SELECT count(*)::int FROM public.cms_program_tiers x WHERE NOT x.program_id = ANY ((SELECT ids FROM h)::uuid[])) AS out_tiers,
       (SELECT count(*)::int FROM public.cms_import_runs x WHERE NOT x.program_id = ANY ((SELECT ids FROM h)::uuid[])) AS out_import_runs,
       has_table_privilege('public.cms_qa_access', 'SELECT') AS read_qa_access,
       has_table_privilege('public.cms_sync_runs', 'SELECT') AS read_sync_runs,
       has_table_privilege('public.cms_programs', 'INSERT,UPDATE,DELETE,TRUNCATE') AS write_programs,
       (SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND left(c.relname, 4) = 'cms_'
          AND c.relname NOT IN (${CMS_TABLES_READ.map((t) => `'${t}'`).join(', ')})
          AND ${p123 ? '(' : ''}has_table_privilege(c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')${p123 ? " OR has_any_column_privilege(c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))" : ''}) AS private_tables,
       (SELECT coalesce(string_agg(p.proname::text, ',' ORDER BY p.proname::text COLLATE "C"), '') FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace AND left(p.proname, 8) = 'rpc_cms_' AND has_function_privilege(p.oid, 'EXECUTE')) AS rpc_callable${rx122}${py123}`
}

/** Mục kiểm. `proven: false` = đạt về điều kiện nhưng CHƯA CHỨNG MINH (vd. dữ liệu chưa đủ để thấy RLS cắt bớt). */
export interface CmsVerifyCheck { id: string; ok: boolean; detail: string; proven?: boolean }

type Row = Record<string, unknown>

/**
 * Ma trận đã duyệt (120 hậu kiểm §7 + V4; 121 hậu kiểm + V2). ACL ngoài owner phải ĐÚNG chuỗi này (aclexplode).
 * `src` = md5 thân hàm (prosrc, bỏ \r) sinh từ file 120 / 121 THẬT trên PGlite; scripts/qa-cms-qa-tooling.mjs §1 (PGlite)
 * và planning/research/dev-tools/cms/qatool-realpg-verify.mjs (PostgreSQL 15) kiểm lại — bắt chạy nhầm bản migration cũ.
 */
export const CMS_FN_MATRIX: Record<string, { phase: CmsVerifyPhase; acl: 'authenticated:EXECUTE' | 'service_role:EXECUTE' | null; secdef: boolean; lock: boolean; lock3?: true; lock2?: true; nestloop?: true; src: string }> = {
  cms_has_qa_access: { phase: '120', acl: 'authenticated:EXECUTE', secdef: true, lock: false, src: '9cf26847ae399df151a0236c479742f2' },
  cms_readable_program_ids: { phase: '120', acl: 'authenticated:EXECUTE', secdef: true, lock: false, src: '7043f93b323dbd2fc4c1f883181201d7' },
  rpc_cms_sync_run_open: { phase: '120', acl: 'service_role:EXECUTE', secdef: true, lock: false, src: '77caaa38e761737951dd2d4ccab0ea1b' },
  rpc_cms_product_master_upsert: { phase: '120', acl: 'service_role:EXECUTE', secdef: true, lock: false, src: 'adca72f72f7db94bc2d5f9eac4c3be0c' },
  rpc_cms_sync_run_close: { phase: '120', acl: 'service_role:EXECUTE', secdef: true, lock: false, src: '91cfafdd7160485a4811524449e4e635' },
  cms__qa_access_stamp: { phase: '120', acl: null, secdef: false, lock: false, src: '0daa5cf809c6cac3daf61c9b1a68820b' },
  cms__programs_guard: { phase: '120', acl: null, secdef: false, lock: false, src: '4dae021fddc4ae654955d2a37e434eb7' },
  cms__vn_today: { phase: '121', acl: null, secdef: true, lock: false, src: '9498e89722d672238349c6c592907108' },
  cms__lock_catalog: { phase: '121', acl: null, secdef: true, lock: false, src: 'fecf90f6f288981191b6f7e693990839' },
  cms__conflicts: { phase: '121', acl: null, secdef: true, lock: false, src: '216655ef1643470997c122c8b07452b6' },
  rpc_cms_program_save: { phase: '121', acl: 'service_role:EXECUTE', secdef: true, lock: true, src: '5f9360e7c3c1d4dd828b50f8fc1c2115' },
  rpc_cms_import_preview_save: { phase: '121', acl: 'service_role:EXECUTE', secdef: true, lock: true, src: '64c490cf8ed565e598e31e28718c5b73' },
  rpc_cms_import_commit: { phase: '121', acl: 'service_role:EXECUTE', secdef: true, lock: true, src: 'f5924c03e1ffab041916401a359c76f3' },
  rpc_cms_program_activate: { phase: '121', acl: 'service_role:EXECUTE', secdef: true, lock: true, src: 'ecc2c134df07a2e89878ac50cc63c04a' },
  // 122 — md5 sinh từ file 122 THẬT (scripts/gen-cms-verify-fp-122.mjs, PGlite 120 → 121 → 122), kiểm lại PG15 thật.
  cms__str: { phase: '122', acl: null, secdef: true, lock: false, src: '92090745993707cde1633ef640f7af46' },
  cms__str_or_null: { phase: '122', acl: null, secdef: true, lock: false, src: 'a01c27f5ed04d728370d2c885cb5331e' },
  cms__ts: { phase: '122', acl: null, secdef: true, lock: false, src: '388244698548c5c75bc21d53cb9c5c8a' },
  cms__norm_email: { phase: '122', acl: null, secdef: true, lock: false, src: '3d516b4fa861f5ad89f2bc61b250b33a' },
  cms__mapping_fp: { phase: '122', acl: null, secdef: true, lock: false, src: 'dccfda328687f8c40eb002235b831161' },
  cms__sales_snapshot: { phase: '122', acl: null, secdef: true, lock: false, src: 'e22120f8a95af5308420914c441ca260' },
  cms__seal_fail: { phase: '122', acl: null, secdef: true, lock: false, src: '2f2a79fd21b3bf86ea9b60a2f0427cda' },
  cms__visible_result_users: { phase: '122', acl: null, secdef: true, lock: false, src: 'e805ebc0eca29a76dc61a254b6dc5378' },
  cms__result_run: { phase: '122', acl: null, secdef: true, lock: false, src: '25bb3fdec9ac322765beaa0abdcd9686' },
  cms__programs_result_guard: { phase: '122', acl: null, secdef: false, lock: false, src: '8784c4589f1d3875b50d015223fc7b93' },
  cms__results_release_open: { phase: '122', acl: null, secdef: true, lock: false, src: 'd6b7f93f75ed7daafd9977463a3d0a3b' },
  rpc_cms_sales_snapshot: { phase: '122', acl: 'service_role:EXECUTE', secdef: true, lock: false, src: 'deaeb6c03e7a65992d3614d562cd5968' },
  rpc_cms_sales_run_open: { phase: '122', acl: 'service_role:EXECUTE', secdef: true, lock: true, src: '4aa263fb8d4a526eb52d76bf561dbc59' },
  rpc_cms_sales_run_stage: { phase: '122', acl: 'service_role:EXECUTE', secdef: true, lock: true, src: '7815855f252939ddbd9961597b1d1823' },
  rpc_cms_sales_run_seal_begin: { phase: '122', acl: 'service_role:EXECUTE', secdef: true, lock: true, src: '327d53af6739ffdbf780363aa6460bcc' },
  rpc_cms_sales_run_seal_step: { phase: '122', acl: 'service_role:EXECUTE', secdef: true, lock: true, nestloop: true, src: '55462ce6e7a5b5e6ad26a2c1751ca726' },
  rpc_cms_sales_run_publish: { phase: '122', acl: 'service_role:EXECUTE', secdef: true, lock: true, src: 'a12d10f071ac6ef93d6a35f9fa623c12' },
  rpc_cms_sales_run_finish: { phase: '122', acl: 'service_role:EXECUTE', secdef: true, lock: true, src: '20a74c4806dfc520ce165c181e09c739' },
  // r2.3 (PM 03/11): trần lô cleanup 50.000 — vân tay sinh lại bằng scripts/gen-cms-verify-fp-122.mjs.
  rpc_cms_sales_run_cleanup: { phase: '122', acl: 'service_role:EXECUTE', secdef: true, lock: true, src: '72db7f1c3f562f5c841fcb68314c4e30' },
  rpc_cms_result_header: { phase: '122', acl: 'authenticated:EXECUTE', secdef: true, lock: false, src: '26abaac3902886c1e82c92a9dcf321ec' },
  rpc_cms_result_rows: { phase: '122', acl: 'authenticated:EXECUTE', secdef: true, lock: false, src: 'a63f54b3243637c2c8979d0bc24c9d81' },
  rpc_cms_result_lines: { phase: '122', acl: 'authenticated:EXECUTE', secdef: true, lock: false, src: 'c1bf6ff7c059a4b3fe13c140205306cd' },
  rpc_cms_result_excluded: { phase: '122', acl: 'authenticated:EXECUTE', secdef: true, lock: false, src: '5fa1aa66c4c013bd2ca4a2f72cde6978' },
  // 123 (P3a) — sinh bằng scripts/gen-cms-verify-fp-123.mjs từ file 120 → 121 → 122 → 123 trên PGlite sạch; kiểm lại PG15
  // (planning/research/dev-tools/cms/qatool-realpg-verify-123.mjs). 15 helper không cấp ai; 3 SECURITY INVOKER có chủ đích
  // (current_user = owner bảng); rpc_cms_program_lock: lock_timeout=3s (lock3), không phải 5s.
  cms__lock_policy: { phase: '123', acl: null, secdef: true, lock: false, src: 'de2e7ff49f9e0668087c365dd8974499' },
  cms__config_fp: { phase: '123', acl: null, secdef: true, lock: false, src: '08cf01ecc1809866eff314b5ec82d170' },
  cms__lock_eval: { phase: '123', acl: null, secdef: true, lock: false, src: 'c4a9c555e6c1cd85fb89e15a26155b0a' },
  cms__frozen_runs_guard: { phase: '123', acl: null, secdef: true, lock: false, src: 'af07c2c7b2319401104b2fff84544a01' },
  cms__frozen_data_ins: { phase: '123', acl: null, secdef: true, lock: false, src: '8741950a5cba388d449790f81b2a7104' },
  cms__frozen_data_upd: { phase: '123', acl: null, secdef: true, lock: false, src: 'dc28d7422bd0879e1706a13a2639b8cd' },
  cms__frozen_data_del: { phase: '123', acl: null, secdef: true, lock: false, src: '9ea42d1933a6edd66e36e17463f4babc' },
  cms__frozen_run_row: { phase: '123', acl: null, secdef: true, lock: false, src: '1387d97c1e20c861b77e1fc10d6d9bdf' },
  cms__payout_immutable: { phase: '123', acl: null, secdef: true, lock: false, src: '53676a772c7a142ea1fa54ee1ee4880f' },
  cms__payout_insert_guard: { phase: '123', acl: null, secdef: false, lock: false, src: 'b47232a20d58adb6a4c916a9ff67587c' },
  cms__config_lock_guard: { phase: '123', acl: null, secdef: true, lock: false, src: 'bcd7ae0e4b4857b42b5904d6570625d0' },
  cms__programs_lock_guard: { phase: '123', acl: null, secdef: true, lock: false, src: '23201e6389865e668665951d611e46de' },
  cms__frozen_truncate_guard: { phase: '123', acl: null, secdef: true, lock: false, src: '192c828e048ae4ff844f1d2db81e67b7' },
  cms__config_auth_guard: { phase: '123', acl: null, secdef: false, lock: false, src: 'd960d7d4465da96de1fdca09ecee3abf' },
  cms__run_auth_guard: { phase: '123', acl: null, secdef: false, lock: false, src: 'e556c9ddcf1bb3945cf506f4c8136a19' },
  rpc_cms_lock_preview: { phase: '123', acl: 'service_role:EXECUTE', secdef: true, lock: false, src: 'e33a879baf05f9235b7df0014d892507' },
  rpc_cms_program_lock: { phase: '123', acl: 'service_role:EXECUTE', secdef: true, lock: false, lock3: true, src: 'f71538167e3c48ae46bc87e1257ae7d3' },
  rpc_cms_payout: { phase: '123', acl: 'authenticated:EXECUTE', secdef: true, lock: false, src: '6b75e9a3c8b5fec978bc8a63d6579e5c' },
  // 124 (COMP-INT) — sinh bằng scripts/gen-cms-verify-fp-124.mjs từ file migration, kiểm lại PG15 (124-realpg-test.mjs).
  cms__fp_j: { phase: '124', acl: null, secdef: true, lock: false, src: '7a344888a3942c7006d5097f9b1c88d7' },
  cms__run_source_fp_text: { phase: '124', acl: null, secdef: true, lock: false, src: '39d9f2daf5c82da211847d401b304b6e' },
  cms__run_source_fp: { phase: '124', acl: null, secdef: true, lock: false, src: 'c3bfeb85f566afd863ce0b12eac6a758' },
  cms__program_scope_hash: { phase: '124', acl: null, secdef: true, lock: false, src: '8a4abd995e0a14fb55cb827a5c668a5e' },
  cms__run_source_check: { phase: '124', acl: null, secdef: true, lock: false, nestloop: true, src: 'cd97ae54dee9e5030bac5c1ded72218f' },
  cms__attest_immutable: { phase: '124', acl: null, secdef: true, lock: false, src: '2f1d6bf0b2febd796e90811d8553a12c' },
  cms__attest_eval: { phase: '124', acl: null, secdef: true, lock: false, src: 'a75e03e0b4c7a45c446af38698cf44e9' },
  cms__attest_truncate_guard: { phase: '124', acl: null, secdef: true, lock: false, src: '3ca8a3d0db2eb8ff3adf5b7f52913251' },
  rpc_cms_source_attest: { phase: '124', acl: 'authenticated:EXECUTE', secdef: true, lock: false, lock2: true, src: '32b51294e2837918377ba37007da38f1' },
  rpc_cms_source_attest_revoke: { phase: '124', acl: 'authenticated:EXECUTE', secdef: true, lock: false, lock2: true, src: '393bff684e5828313ddd87bb2534fd59' },
  rpc_cms_run_source_export: { phase: '124', acl: 'authenticated:EXECUTE', secdef: true, lock: false, src: '8f1d48eaf1b532490cfc3582a6312d18' },
  rpc_cms_source_attestations: { phase: '124', acl: 'authenticated:EXECUTE', secdef: true, lock: false, src: '76331df484afab31f25f4f32349e8d9c' },
  // 125 (CMS-UNCAPPED-1) — sinh bằng scripts/gen-cms-verify-fp-125.mjs từ file migration; kiểm lại PG15 (scripts/qa-cms-125.mjs --pg15).
  cms__tiers_last_open_guard: { phase: '125', acl: null, secdef: true, lock: false, src: 'd83088c260633f520dac35cfe8169475' },
}
/**
 * Thân hàm CÓ TRƯỚC phase mà migration của phase thay (CREATE OR REPLACE, giữ ACL) — kỳ vọng thân chỉ áp từ phase đó trở đi;
 * phase trước giữ nguyên `src` trong CMS_FN_MATRIX (không nới kỳ vọng 120–122). 123: SM thấy cả 'locked' (blueprint §2.4).
 */
export const CMS_FN_SRC_123: Record<string, string> = {
  cms_readable_program_ids: '8a1159cb1bedc275f5131b4c2184c19e',
}
/**
 * 124 thay 6 hàm có trước (OR REPLACE giữ ACL; rpc_cms_program_lock DROP 5 + CREATE 6 tham số): thân mới chỉ áp từ 124; phase trước
 * giữ kỳ vọng cũ. Sinh bằng scripts/gen-cms-verify-fp-124.mjs.
 */
export const CMS_FN_SRC_124: Record<string, string> = {
  rpc_cms_sales_run_open: 'a0123bc5abeefac9da1c8dbcd645a97a',
  rpc_cms_sales_run_stage: 'b19df838c787755c56c76cfd8ff48a3a',
  rpc_cms_sales_run_cleanup: 'bbea7ad89f57a054a998db7b72d854b3',
  cms__lock_eval: '6c38e2ca40f37d1cc5e715f8cd3e2bb5',
  rpc_cms_payout: '2b96b52d238885e72cfbefd7752cfd91',
  rpc_cms_program_lock: 'd6fff19d80bbb98a72bf43d90e6f289f',
}
/**
 * 125 thay 2 RPC 121 (OR REPLACE giữ chữ ký / ACL / lock_timeout 5 s): import commit chặn bậc cuối hữu hạn; kích hoạt kiểm thang bậc
 * hợp lệ + bậc cuối không giới hạn. Thân mới chỉ áp từ 125 (phase trước giữ src 121). Sinh bằng scripts/gen-cms-verify-fp-125.mjs.
 */
export const CMS_FN_SRC_125: Record<string, string> = {
  rpc_cms_import_commit: '65bd0b43e24fda590eec4cd764f959c2',
  rpc_cms_program_activate: '6ae92590bf7afc237c80cc3db15e5aad',
}
/**
 * 126 (sales-only, PM 06/11) thay 2 hàm 122 (OR REPLACE giữ chữ ký / owner / ACL / config): cổng cms__results_release_open false → true
 * (vẫn IMMUTABLE SECDEF, chỉ owner); rpc_cms_sales_run_publish thêm held RETURNS_NOT_SUPPORTED_THIS_PHASE + dấu results_basis /
 * results_gate cho chương trình thật (service_role, lock_timeout 5 s). Thân mới chỉ áp từ 126 (phase trước giữ src 122). Sinh bằng
 * scripts/gen-cms-verify-fp-126.mjs (PGlite 120 → 125 → 126): 0 hàm mới; định nghĩa / ACL / config, hình dạng / cột bảng, trigger
 * KHÔNG đổi ⇒ 126 kế thừa CMS_FN_DEF_125 / CMS_TABLE_SHAPE_125 / CMS_COL_125 / CMS_TRIGGERS_125.
 */
export const CMS_FN_SRC_126: Record<string, string> = {
  cms__results_release_open: 'aebe1ff46ba51dcf533fe328af7ea2a0',
  rpc_cms_sales_run_publish: 'db2c97efad2bb5ee9d69399b99c7c258',
}
/** 124: cấu hình đổi của hàm có trước — lock 6 tham số lock_timeout 3 s → 2 s (PM COMP-INT §4). */
export const CMS_FN_CFG_124: Record<string, { lock3: boolean; lock2: boolean }> = { rpc_cms_program_lock: { lock3: false, lock2: true } }

/** md5 ràng buộc / index theo bảng (chuẩn hoá bỏ `public.`), sinh từ 120 THẬT — kiểm lại trên PGlite + PostgreSQL 15. */
export const CMS_TABLE_SHAPE: Record<string, { con: string; idx: string }> = {
  cms_import_runs: { con: '35f7c62dff47ff26afdd1c3f19ae539d', idx: 'cfdb7e5edd4ca61b6cd809809a149cbb' },
  cms_product_master: { con: '9e5d4c0b9470f9c1e5992a40b0f7db1f', idx: 'dc7792981cf543247d13c47e1d110045' },
  cms_program_products: { con: '782af86ba55259ebfc1165fce7232243', idx: '9ff451b4ec49c44e621908f70b40d84a' },
  cms_program_stores: { con: '98a15abcf20c48609ec74d7ee5b9768a', idx: 'fba39958c865b99044d99bec158d2f95' },
  cms_program_tiers: { con: '497ae580bb28032215a704c61901ad25', idx: 'edad84e8cbb6925b7759b2d4f4475dbc' },
  cms_programs: { con: '16683c7aa544a6c3bda0c584006def41', idx: '3af58df33a04da4e89eb123a82f16df6' },
  cms_qa_access: { con: 'b6f30a4065276f1f8a83952968df4eb8', idx: 'be3ef11f935b5b49bfaf459d3efc51fe' },
  cms_sync_runs: { con: '252cfa072e647fa4e995113cc39e3e22', idx: '240b26454c424b54c140a8f310c912c3' },
}

/**
 * Hình dạng SAU 122 — bộ riêng (PM 03/11 §5: không nới kỳ vọng 120 / 121 thành wildcard). Sinh từ 120 → 121 → 122 THẬT
 * (scripts/gen-cms-verify-fp-122.mjs), kiểm lại PostgreSQL 15. Đổi so với 120: tiers (UNIQUE tra bậc), programs (FK pointer),
 * sync_runs (kind sales, cột run tính, FK đích kép, index chương trình) + 5 bảng snapshot / kết quả.
 */
export const CMS_TABLE_SHAPE_122: Record<string, { con: string; idx: string }> = {
  ...CMS_TABLE_SHAPE,
  cms_program_tiers: { con: '497ae580bb28032215a704c61901ad25', idx: '686f5597ac9dabbf27d86c0faf3d4981' },
  cms_programs: { con: 'e6cc20e6ff031d74121a66657a0bd174', idx: '3af58df33a04da4e89eb123a82f16df6' },
  cms_sync_runs: { con: 'c00bb0a5b2e97485f4cf35557f9b974e', idx: '08b2a6af404f0ad0ab3dc39b01527922' },
  cms_result_catalog: { con: '71be588c2a08fbab6f186ec41c267a01', idx: '96a9ce8a475c9758d29982fbdce0eb58' },
  cms_result_lines: { con: '1917e8192b15dd063bdac725d91f05e8', idx: 'ff3c0e774f9f6c0a8735bf8aed6ab21d' },
  cms_results: { con: 'df9b0cc0665dff48554f2d051adaab69', idx: '215426ba1718e1964abc2269ea925409' },
  cms_sales_lines: { con: '672a6a4c278795558b0b10359499e1d9', idx: '3b4b1fecbd52bb74cce597f7605cd36a' },
  cms_sync_run_chunks: { con: 'f0b06b2bfb50f23562facceff1b72c17', idx: '80fd27ec77de29ad519d5181857f65c6' },
}
/** md5 định nghĩa hàm (ngoài thân) SAU 122 — sinh từ file migration (scripts/gen-cms-verify-fp-122.mjs), kiểm lại PG15. */
export const CMS_FN_DEF_122: Record<string, string> = {
  cms__conflicts: 'f053bc7d9d94ecd2564e2614f625ef3f',
  cms__lock_catalog: '9ecc03cc55c4755df0c41b805e530163',
  cms__mapping_fp: '5b37f830e5acc7195615cd9a9e7849ed',
  cms__norm_email: 'd508b6203f84178db33c83bf18411fbf',
  cms__programs_guard: 'f38b7b9f842dcae4ee3eaacacca0b3fe',
  cms__programs_result_guard: 'f38b7b9f842dcae4ee3eaacacca0b3fe',
  cms__qa_access_stamp: 'f38b7b9f842dcae4ee3eaacacca0b3fe',
  cms__result_run: '2861a8ac77b37bcc49a1bd2cd4fc6df7',
  cms__results_release_open: '640f1c74d9f04b0fade33071b8f7d56c',
  cms__sales_snapshot: '1a2ef700ca5a13ef51002da436de1ebc',
  cms__seal_fail: '9d4ca8c4b8ae8aa0ab940839bd07677a',
  cms__str: '110b6d04bf1fe17dd9b5497f2465aaba',
  cms__str_or_null: '110b6d04bf1fe17dd9b5497f2465aaba',
  cms__ts: 'f918eaa8ca522e883f5c2c927d7e9877',
  cms__visible_result_users: '0f047d50ac0673f8938db4e5f7247bba',
  cms__vn_today: 'cbe9148475c06b826c8989ca75add105',
  cms_has_qa_access: '281eb147aef1a1886181b9588836e05d',
  cms_readable_program_ids: '0f047d50ac0673f8938db4e5f7247bba',
  rpc_cms_import_commit: 'd7051c8d6ffd559596fc56cb9376a941',
  rpc_cms_import_preview_save: '803d9ce531040ddf4257c301342fdf4c',
  rpc_cms_product_master_upsert: 'b1c86e310919c679a527790563762530',
  rpc_cms_program_activate: '5dbd479f09fe27c60ad2547b79907bcb',
  rpc_cms_program_save: '803d9ce531040ddf4257c301342fdf4c',
  rpc_cms_result_excluded: 'e1fe9ab4ae35a3dee0746ff2ceb7923e',
  rpc_cms_result_header: '92cd6203fa5016ac2c9ed4fcfd9cfc04',
  rpc_cms_result_lines: '80f1d9b8e9107576ea6b999766271126',
  rpc_cms_result_rows: '81971a1e6fe5142863bc758fec397225',
  rpc_cms_sales_run_cleanup: '11a3ae92b798168daca2fbee67b964a3',
  rpc_cms_sales_run_finish: 'd1fa006e3244b3938ef577ba5a50a09d',
  rpc_cms_sales_run_open: '38305046fc9561e6b6c4c22a54bf7980',
  rpc_cms_sales_run_publish: '98e733b4f6e7223c26d94ed13e6d8520',
  rpc_cms_sales_run_seal_begin: '3f43b97786b0d8b2a520e09b7b6e4896',
  rpc_cms_sales_run_seal_step: '07c6772b1f2e2eaa7974f0dedde0d2d6',
  rpc_cms_sales_run_stage: '0b87d06d127daad3fa1854348251b9c4',
  rpc_cms_sales_snapshot: '92cd6203fa5016ac2c9ed4fcfd9cfc04',
  rpc_cms_sync_run_close: 'd1fa006e3244b3938ef577ba5a50a09d',
  rpc_cms_sync_run_open: '62c3106d8885a4023b51b95814b0ce8f',
}
/** md5 cột (tên : kiểu : NOT NULL : DEFAULT) từng bảng cms_* SAU 122 — sinh từ file migration, kiểm lại PG15. */
export const CMS_COL_122: Record<string, string> = {
  cms_import_runs: 'b5f11b5366aa176e1a8172935d7eed48',
  cms_product_master: 'e680d39534425682ae317b7f45e3d5a8',
  cms_program_products: '988cd34d166089c1f4f0124a29c6b576',
  cms_program_stores: '3fd7fe8ef1b3658e06c1d30b91f9d4e1',
  cms_program_tiers: 'a40fe56d87f1221242010f4eb9145efa',
  cms_programs: '30c582186f7000b5e671f1ecd6380e29',
  cms_qa_access: '544ba4ec4771165d21b945726b0f6c1c',
  cms_result_catalog: 'e493f37ec281a62ba0bce4bacb4b3681',
  cms_result_lines: '9a8fabd3e8f351ca9ab4761a62ff49c6',
  cms_results: '9b0199e6f869f76c8b8475306b09e424',
  cms_sales_lines: '8bd732be0179471facc323776cf44122',
  cms_sync_run_chunks: 'dee07d4f0338dc39afe121f453611bf9',
  cms_sync_runs: '7ab6bb7dc4ca59473e52ae00a39fc4a6',
}
/**
 * SAU 123 — sinh từ 120 → 121 → 122 → 123 THẬT (scripts/gen-cms-verify-fp-123.mjs), kiểm lại PG15. 123 không đổi ràng buộc / index /
 * cột / định nghĩa hàm nào có trước (generator in "ĐỔI" nếu có) ⇒ bộ 122 + 2 bảng payout + 18 hàm mới.
 */
export const CMS_TABLE_SHAPE_123: Record<string, { con: string; idx: string }> = {
  ...CMS_TABLE_SHAPE_122,
  cms_payout_staff: { con: 'eaca3986fb16b2c0a09ce795865af894', idx: 'a64952d8f0b4844469cfa36543bdb734' },
  cms_payouts: { con: 'd8076fc354f1a0c08acd750ce8957d38', idx: '6218c3b4ff847f6db3852026a8c124a6' },
}
export const CMS_FN_DEF_123: Record<string, string> = {
  ...CMS_FN_DEF_122,
  cms__config_auth_guard: 'f38b7b9f842dcae4ee3eaacacca0b3fe',
  cms__config_fp: '2af6da12c007c498d7a00a6327c1132a',
  cms__config_lock_guard: 'f38b7b9f842dcae4ee3eaacacca0b3fe',
  cms__frozen_data_del: 'f38b7b9f842dcae4ee3eaacacca0b3fe',
  cms__frozen_data_ins: 'f38b7b9f842dcae4ee3eaacacca0b3fe',
  cms__frozen_data_upd: 'f38b7b9f842dcae4ee3eaacacca0b3fe',
  cms__frozen_run_row: 'f38b7b9f842dcae4ee3eaacacca0b3fe',
  cms__frozen_runs_guard: 'abff406705c7d5cbc736a524a0e7c9b5',
  cms__frozen_truncate_guard: 'f38b7b9f842dcae4ee3eaacacca0b3fe',
  cms__lock_eval: '59b1d78b683de33c6dac65399fa0ef2f',
  cms__lock_policy: 'e252f75ac6b0bdd423eff9dfe347bc56',
  cms__payout_immutable: 'f38b7b9f842dcae4ee3eaacacca0b3fe',
  cms__payout_insert_guard: 'f38b7b9f842dcae4ee3eaacacca0b3fe',
  cms__programs_lock_guard: 'f38b7b9f842dcae4ee3eaacacca0b3fe',
  cms__run_auth_guard: 'f38b7b9f842dcae4ee3eaacacca0b3fe',
  rpc_cms_lock_preview: '92cd6203fa5016ac2c9ed4fcfd9cfc04',
  rpc_cms_payout: '92cd6203fa5016ac2c9ed4fcfd9cfc04',
  rpc_cms_program_lock: '042ecfdc6e61f9816783228b68d5fbf9',
}
export const CMS_COL_123: Record<string, string> = {
  ...CMS_COL_122,
  cms_payout_staff: '7df942e5e32bdeeccb17d78cf3b213b1',
  cms_payouts: '35b400adaabc8cbe47900babca10b06b',
}
/**
 * SAU 124 — sinh từ 120 → 124 THẬT (scripts/gen-cms-verify-fp-124.mjs), kiểm lại PG15. Đổi so với 123: cms_sync_runs (cột
 * source_schema + CHECK), cms_sync_run_chunks (CHECK part + 'source_lines'), cms_payouts (cột + FK + CHECK basis / chứng nhận) + 2 bảng mới.
 */
export const CMS_TABLE_SHAPE_124: Record<string, { con: string; idx: string }> = {
  ...CMS_TABLE_SHAPE_123,
  cms_payouts: { con: '5eed8c261c1b16666391901d17263010', idx: '6218c3b4ff847f6db3852026a8c124a6' },
  cms_sales_source_lines: { con: 'dd322b598a6f883006de7de5f4db4215', idx: 'e83846aa7a469347f9c98e628bc2116e' },
  cms_source_attestations: { con: '6d88f8bbb9f1a6d0b47caa2c0dac7faf', idx: '17c787aae0e4a76c8c28885d445ca0f6' },
  cms_sync_run_chunks: { con: 'd39908a57d899cc8cdb9b9836177add5', idx: '80fd27ec77de29ad519d5181857f65c6' },
  cms_sync_runs: { con: '1f99bb21cc89bd2a832d8e4855efa781', idx: '08b2a6af404f0ad0ab3dc39b01527922' },
}
export const CMS_FN_DEF_124: Record<string, string> = {
  ...CMS_FN_DEF_123,
  cms__attest_eval: '1376b6de317c019fa5abb3000d90b259',
  cms__attest_immutable: 'f38b7b9f842dcae4ee3eaacacca0b3fe',
  cms__attest_truncate_guard: 'f38b7b9f842dcae4ee3eaacacca0b3fe',
  cms__fp_j: '613fab18d7427b388124b64a4f42cb09',
  cms__program_scope_hash: '2af6da12c007c498d7a00a6327c1132a',
  cms__run_source_check: '2208c52ac49c81b4dc071bd8ec283276',
  cms__run_source_fp: 'a0a0c09c871c25ade66fd204dfc7c876',
  cms__run_source_fp_text: 'a0a0c09c871c25ade66fd204dfc7c876',
  rpc_cms_run_source_export: 'cfc05319329a2fed7c60f2580865a87f',
  rpc_cms_source_attest: '156aed811bf2360b67fb64eade356521',
  rpc_cms_source_attest_revoke: '9e47c0e451c6d90a356cbf9fdf8ae763',
  rpc_cms_source_attestations: '92cd6203fa5016ac2c9ed4fcfd9cfc04',
  rpc_cms_program_lock: 'c755ce47e248a22e38a617b8f0964016',
}
export const CMS_COL_124: Record<string, string> = {
  ...CMS_COL_123,
  cms_payouts: 'f4757b3a3652a92fae71449421669cf6',
  cms_sales_source_lines: '9170928d18f3e922ce2ef71db3d16510',
  cms_source_attestations: 'f06d90dc2343fed76fc0232fca95f94a',
  cms_sync_runs: 'c5e4b7544aed63002c4b4b9b167a251f',
}
/**
 * SAU 125 — sinh từ 120 → 125 THẬT (scripts/gen-cms-verify-fp-125.mjs), kiểm lại PG15. Đổi so với 124: cms_program_tiers có thêm
 * ràng buộc của constraint trigger cms_tiers_last_open (pg_constraint contype 't'); index / cột không đổi.
 */
export const CMS_TABLE_SHAPE_125: Record<string, { con: string; idx: string }> = {
  ...CMS_TABLE_SHAPE_124,
  cms_program_tiers: { con: '3eceb15e673169b7698b812c1aec3a10', idx: '686f5597ac9dabbf27d86c0faf3d4981' },
}
export const CMS_FN_DEF_125: Record<string, string> = {
  ...CMS_FN_DEF_124,
  cms__tiers_last_open_guard: 'f38b7b9f842dcae4ee3eaacacca0b3fe',
}
export const CMS_COL_125: Record<string, string> = { ...CMS_COL_124 }
/** 2 bảng 124: RLS bật, KHÔNG policy, KHÔNG cấp anon / authenticated / service_role (ghi chỉ qua RPC stage / chứng nhận). */
export const CMS_TABLES_ATTEST_124 = ['cms_sales_source_lines', 'cms_source_attestations']
/** 5 bảng 122: RLS bật, KHÔNG policy, chỉ service_role (đủ 7 quyền); anon / authenticated ∅. */
const CMS_TABLES_RESULT = ['cms_result_catalog', 'cms_result_lines', 'cms_results', 'cms_sales_lines', 'cms_sync_run_chunks']
/** 2 bảng 123: RLS bật, KHÔNG policy, KHÔNG cấp anon / authenticated / service_role (ghi chỉ qua RPC chốt, đọc qua rpc_cms_payout). */
const CMS_TABLES_PAYOUT = ['cms_payout_staff', 'cms_payouts']
/** 12 bảng tập đóng băng 123: TRUNCATE thu hồi khỏi anon / authenticated / service_role + trigger BEFORE TRUNCATE. */
export const CMS_TABLES_FROZEN_123 = ['cms_programs', 'cms_program_products', 'cms_program_tiers', 'cms_program_stores', 'cms_sync_runs',
  'cms_sync_run_chunks', 'cms_sales_lines', 'cms_results', 'cms_result_catalog', 'cms_result_lines', 'cms_payouts', 'cms_payout_staff']
const CMS_MARKER_NAME: Record<CmsVerifyPhase, string> = { '120': 'cms_foundation', '121': 'cms_import_activation', '122': 'cms_results', '123': 'cms_payouts', '124': 'cms_source_attestation', '125': 'cms_uncapped_last_tier',
  '126': 'cms_sales_only_results_release' }

const CMS_TABLES_READ = ['cms_import_runs', 'cms_product_master', 'cms_program_products', 'cms_program_stores', 'cms_program_tiers', 'cms_programs']
const CMS_TABLES_NO_AUTH = ['cms_qa_access', 'cms_sync_runs']
/**
 * qual policy kỳ vọng — so KHỚP CHÍNH XÁC sau chuẩn hoá (bỏ `public.`, gộp khoảng trắng). Chuỗi deparse của PG;
 * deparse khác trên prod ⇒ đỏ (an toàn), chụp lại và trình PM — không nới thành "có chứa".
 */
const READ_IDS = '( SELECT cms_readable_program_ids() AS cms_readable_program_ids)::uuid[]'
const POLICY_QUAL: Record<string, string> = {
  cms_programs: `(id = ANY (${READ_IDS}))`,
  cms_program_stores: `(program_id = ANY (${READ_IDS}))`,
  cms_program_products: `(program_id = ANY (${READ_IDS}))`,
  cms_program_tiers: `(program_id = ANY (${READ_IDS}))`,
  cms_product_master: '( SELECT is_super_admin() AS is_super_admin)',
  cms_import_runs: `(( SELECT is_super_admin() AS is_super_admin) AND (program_id = ANY (${READ_IDS})))`,
}
export const normalizeCmsQual = (q: unknown) => String(q ?? '').replace(/public\./g, '').replace(/\s+/g, ' ').trim()
/** Định nghĩa trigger đầy đủ (kiểu / sự kiện / mức / hàm) sau chuẩn hoá — kèm trạng thái bật `O`. */
const CMS_TRIGGERS_120 = [
  'CREATE TRIGGER cms_programs_guard BEFORE UPDATE ON cms_programs FOR EACH ROW EXECUTE FUNCTION cms__programs_guard()|O',
  'CREATE TRIGGER cms_qa_access_stamp BEFORE INSERT OR UPDATE ON cms_qa_access FOR EACH ROW EXECUTE FUNCTION cms__qa_access_stamp()|O',
]
/** 122 thêm trigger bảo vệ pointer kết quả. So TẬP đã sắp ở JS (không phụ thuộc collation DB). */
const CMS_TRIGGERS_122 = [...CMS_TRIGGERS_120,
  'CREATE TRIGGER cms_programs_result_guard BEFORE INSERT OR UPDATE ON cms_programs FOR EACH ROW EXECUTE FUNCTION cms__programs_result_guard()|O']
/**
 * 123 thêm ĐÚNG 46 trigger, mọi trigger ENABLE ALWAYS (`A` — vẫn chạy khi session_replication_role = replica); 3 trigger 120 / 122
 * giữ nguyên `O`. Viết theo thiết kế migration 123 §4 (không chép từ DB); scripts/gen-cms-verify-fp-123.mjs đối chiếu với DB sạch.
 * 15 AFTER … FOR EACH STATEMENT + transition table trên 5 bảng dữ liệu run · 4 cms_config_auth_guard BEFORE ROW · 6
 * cms_run_auth_guard BEFORE STATEMENT · 3 cms_config_lock_guard BEFORE ROW · 12 BEFORE TRUNCATE · cms_frozen_run_row · 2 + 2 payout
 * · cms_programs_lock_guard.
 */
const CMS_RUN_DATA_123 = ['cms_sync_run_chunks', 'cms_sales_lines', 'cms_results', 'cms_result_catalog', 'cms_result_lines']
const CMS_CONFIG_CHILD_123 = ['cms_program_products', 'cms_program_tiers', 'cms_program_stores']
export const CMS_TRIGGERS_123: readonly string[] = [...CMS_TRIGGERS_122,
  ...CMS_RUN_DATA_123.flatMap((t) => [
    `CREATE TRIGGER cms_frozen_ins AFTER INSERT ON ${t} REFERENCING NEW TABLE AS cms_new FOR EACH STATEMENT EXECUTE FUNCTION cms__frozen_data_ins()|A`,
    `CREATE TRIGGER cms_frozen_upd AFTER UPDATE ON ${t} REFERENCING OLD TABLE AS cms_old NEW TABLE AS cms_new FOR EACH STATEMENT EXECUTE FUNCTION cms__frozen_data_upd()|A`,
    `CREATE TRIGGER cms_frozen_del AFTER DELETE ON ${t} REFERENCING OLD TABLE AS cms_old FOR EACH STATEMENT EXECUTE FUNCTION cms__frozen_data_del()|A`]),
  ...['cms_programs', ...CMS_CONFIG_CHILD_123].map((t) =>
    `CREATE TRIGGER cms_config_auth_guard BEFORE INSERT OR DELETE OR UPDATE ON ${t} FOR EACH ROW EXECUTE FUNCTION cms__config_auth_guard()|A`),
  ...['cms_sync_runs', ...CMS_RUN_DATA_123].map((t) =>
    `CREATE TRIGGER cms_run_auth_guard BEFORE INSERT OR DELETE OR UPDATE ON ${t} FOR EACH STATEMENT EXECUTE FUNCTION cms__run_auth_guard()|A`),
  ...CMS_CONFIG_CHILD_123.map((t) =>
    `CREATE TRIGGER cms_config_lock_guard BEFORE INSERT OR DELETE OR UPDATE ON ${t} FOR EACH ROW EXECUTE FUNCTION cms__config_lock_guard()|A`),
  ...CMS_TABLES_FROZEN_123.map((t) =>
    `CREATE TRIGGER cms_frozen_truncate BEFORE TRUNCATE ON ${t} FOR EACH STATEMENT EXECUTE FUNCTION cms__frozen_truncate_guard()|A`),
  'CREATE TRIGGER cms_frozen_run_row BEFORE DELETE OR UPDATE ON cms_sync_runs FOR EACH ROW EXECUTE FUNCTION cms__frozen_run_row()|A',
  ...CMS_TABLES_PAYOUT.flatMap((t) => [
    `CREATE TRIGGER cms_payout_immutable BEFORE DELETE OR UPDATE ON ${t} FOR EACH ROW EXECUTE FUNCTION cms__payout_immutable()|A`,
    `CREATE TRIGGER cms_payout_insert_guard BEFORE INSERT ON ${t} FOR EACH ROW EXECUTE FUNCTION cms__payout_insert_guard()|A`]),
  'CREATE TRIGGER cms_programs_lock_guard BEFORE INSERT OR DELETE OR UPDATE ON cms_programs FOR EACH ROW EXECUTE FUNCTION cms__programs_lock_guard()|A',
]
/**
 * 124 thêm ĐÚNG 9 trigger ALWAYS (viết theo thiết kế migration 124 §9, không chép từ DB; generator đối chiếu DB sạch): lớp nguồn dùng
 * lại 5 guard 123 (đóng băng sau chốt, chỉ owner / RPC ghi, TRUNCATE); chứng nhận: chỉ-owner + bất biến UPDATE / DELETE + chặn INSERT
 * sau chốt + TRUNCATE.
 */
export const CMS_TRIGGERS_124: readonly string[] = [...CMS_TRIGGERS_123,
  'CREATE TRIGGER cms_frozen_ins AFTER INSERT ON cms_sales_source_lines REFERENCING NEW TABLE AS cms_new FOR EACH STATEMENT EXECUTE FUNCTION cms__frozen_data_ins()|A',
  'CREATE TRIGGER cms_frozen_upd AFTER UPDATE ON cms_sales_source_lines REFERENCING OLD TABLE AS cms_old NEW TABLE AS cms_new FOR EACH STATEMENT EXECUTE FUNCTION cms__frozen_data_upd()|A',
  'CREATE TRIGGER cms_frozen_del AFTER DELETE ON cms_sales_source_lines REFERENCING OLD TABLE AS cms_old FOR EACH STATEMENT EXECUTE FUNCTION cms__frozen_data_del()|A',
  'CREATE TRIGGER cms_run_auth_guard BEFORE INSERT OR DELETE OR UPDATE ON cms_sales_source_lines FOR EACH STATEMENT EXECUTE FUNCTION cms__run_auth_guard()|A',
  'CREATE TRIGGER cms_frozen_truncate BEFORE TRUNCATE ON cms_sales_source_lines FOR EACH STATEMENT EXECUTE FUNCTION cms__frozen_truncate_guard()|A',
  'CREATE TRIGGER cms_run_auth_guard BEFORE INSERT OR DELETE OR UPDATE ON cms_source_attestations FOR EACH STATEMENT EXECUTE FUNCTION cms__run_auth_guard()|A',
  'CREATE TRIGGER cms_attest_immutable BEFORE DELETE OR UPDATE ON cms_source_attestations FOR EACH ROW EXECUTE FUNCTION cms__attest_immutable()|A',
  'CREATE TRIGGER cms_attest_insert_guard BEFORE INSERT ON cms_source_attestations FOR EACH ROW EXECUTE FUNCTION cms__attest_immutable()|A',
  'CREATE TRIGGER cms_attest_truncate BEFORE TRUNCATE ON cms_source_attestations FOR EACH STATEMENT EXECUTE FUNCTION cms__attest_truncate_guard()|A',
]
/**
 * 125 thêm ĐÚNG 1 constraint trigger ALWAYS (thiết kế migration 125 §2; generator đối chiếu DB sạch): guard bậc cuối không giới hạn ở
 * cuối transaction. Trigger pointer 122 (cms_programs_result_guard) bị tắt tạm trong 125 phải trở lại đúng `O` — đã có trong danh sách.
 */
export const CMS_TRIGGERS_125: readonly string[] = [...CMS_TRIGGERS_124,
  'CREATE CONSTRAINT TRIGGER cms_tiers_last_open AFTER INSERT OR DELETE OR UPDATE ON cms_program_tiers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cms__tiers_last_open_guard()|A',
]
const CMS_POINTER_FK = 'cms_programs_result_run_fk=FOREIGN KEY (current_result_run_id, id) REFERENCES cms_sync_runs(id, program_id)|true'

export interface CmsAclSnapshot {
  db_now: unknown
  n_all: number; md5_all: string
  n_old: number; md5_old: string
  n_ex120: number; md5_ex120: string
  n_ex121: number; md5_ex121: string
  /** Có từ phase122 tooling — ảnh PRE cũ (trước tooling này) thiếu ⇒ chỉ dùng được cho phase 120 / 121. */
  n_ex122?: number; md5_ex122?: string
  /** Có từ phase123 tooling — POST 123 so MỌI hàm có trước 123 (37 hàm cms + hàm ngoài cms) với n_all / md5_all của PRE 123. */
  n_ex123?: number; md5_ex123?: string
  /** Có từ phase124 tooling — POST 124 so MỌI hàm có trước 124 TRỪ rpc_cms_program_lock (đổi chữ ký) với n_ex124 / md5_ex124 của PRE. */
  n_ex124?: number; md5_ex124?: string
  /** Có từ phase125 tooling — POST 125 so MỌI hàm có trước 125 (2 RPC thay giữ chữ ký + ACL) với n_all / md5_all của PRE 125. */
  n_ex125?: number; md5_ex125?: string
  // 126: không có n_ex126 — 126 không thêm hàm ⇒ POST 126 so n_all / md5_all với n_all / md5_all của PRE 126 (mọi hàm public).
}

/**
 * Profile POST TƯỜNG MINH cho trạng thái sau rollback (PM 2026-11-05-cms-candidate-inventory-runbook-pm.md §3 INV-P1-1).
 * `after-rollback-124`: DB đã chạy 124 rồi `rollback/124_…` (có thể gỡ tiếp 123). Rollback 124 CỐ Ý giữ ràng buộc part của
 * `cms_sync_run_chunks` nhận 'source_lines' (khối của run đã chốt bị guard 123 đóng băng) ⇒ phase nền 123 / 122 thường đỏ đúng
 * một mục `table-shape:cms_sync_run_chunks`. Profile chỉ nhận ĐÚNG phần dư đó (md5 ràng buộc = bản 124; index như nền) — mọi
 * hàm / ACL / owner / policy / index / cột / trigger / bảng khác vẫn theo kỳ vọng của phase NỀN; marker 124 phải vắng.
 * Không dùng được với phase khác, DB còn 124, hay để che lệch khác. Phase thường KHÔNG chấp nhận thêm shape nào.
 */
export type CmsVerifyProfile = 'after-rollback-124'
export const CMS_VERIFY_PROFILES: readonly CmsVerifyProfile[] = ['after-rollback-124']
export const CMS_VERIFY_PROFILE_PHASES: Record<CmsVerifyProfile, readonly CmsVerifyPhase[]> = { 'after-rollback-124': ['123', '122'] }
export const CMS_VERIFY_PROFILE_RESIDUAL: Record<CmsVerifyProfile, Record<string, { con: string; idx: string }>> = {
  // con = ràng buộc 124 (sinh từ file migration, gen-cms-verify-fp-124 — rollback 124 không gỡ); idx GHIM bản nền 122 / 123 (124 không
  // đổi index chunks; nếu sau này đổi mà rollback không gỡ thì profile phải ĐỎ, không âm thầm nhận index 124 — db-reviewer P2-1).
  'after-rollback-124': { cms_sync_run_chunks: { con: CMS_TABLE_SHAPE_124.cms_sync_run_chunks.con, idx: CMS_TABLE_SHAPE_123.cms_sync_run_chunks.idx } },
}
export function cmsVerifyProfileValid(profile: string, phase: string): boolean {
  return (CMS_VERIFY_PROFILES as readonly string[]).includes(profile) && (CMS_VERIFY_PROFILE_PHASES[profile as CmsVerifyProfile] as readonly string[]).includes(phase)
}

export interface CmsVerifyInput {
  /** Profile hậu rollback (tuỳ chọn) — chỉ hợp lệ với phase nền trong CMS_VERIFY_PROFILE_PHASES. */
  profile?: CmsVerifyProfile
  phase: CmsVerifyPhase
  whoami: Row
  markers: Row[]
  maxNumeric: Row
  functions: Row[]
  policies: Row[]
  triggers: Row[]
  tableShape: Row[]
  tables: Row[]
  roles: Row[]
  oneRunningIndex: Row[]
  aclPost: CmsAclSnapshot
  /** Ảnh ACL đo NGAY TRƯỚC migration của phase (PRE mới, không dùng số cũ). */
  aclPre: CmsAclSnapshot
  inv121?: { overlap: Row[]; tiers: Row[]; catalog: Row[] }
  isolation?: Row
  /** Phase ≥ 122. */
  p122?: { tiersUnique: Row[]; pointerFk: Row[]; releaseGate: Row; inv122Pointer: Row[]; fnDefs?: Row[]; columns?: Row[] }
  /** Chỉ phase 123 (V0 / V3 / V4 / V5 / V6 / V7 + hàm trigger). */
  /** Phase ≥ 124: bất biến payout ↔ chứng nhận. */
  p124?: { invAttest: Row }
  /** Phase ≥ 125 (CMS-Q-220): cấu hình chưa chốt không còn bậc cuối hữu hạn; run hiện hành không mang trần. */
  p125?: { invLastTier: Row[]; invCurrentCap: Row[]; current?: Row }
  /** Phase ≥ 126 (sales-only): run bán thật công bố sau marker 126 mang results_basis = 'sales_only_v1' (CMS_VERIFY_SQL.inv126RealBasis). */
  p126?: { invRealBasis: Row }
  p123?: { owners: Row; isolation123: Row; triggerFns: Row[]; lockPolicy: Row; payoutAcl: Row[]; invPayout: Row; invLocked: Row
    invPayoutStaff?: Row; invRunFrozen?: Row; payoutReach?: Row[]; lockPreview?: Row }
  /** `post --require-proven=…` (như V8): khoá trong cmsPostProvenKeys(phase); mục CHƯA chứng minh ⇒ đỏ. */
  requireProven?: readonly string[]
}

/** Khoá `post --require-proven` theo phase ⇒ các mục phải ĐẠT và ĐÃ chứng minh (không CHƯA). */
const CMS_POST_PROVEN: Record<CmsVerifyPhase, Record<string, readonly string[]>> = {
  '120': {}, '121': {}, '122': {},
  '123': { v5: ['v5-payout-invariants', 'v5-payout-staff', 'v5-run-frozen'], 'lock-preview': ['lock-preview-blocked'] },
  '124': { v5: ['v5-payout-invariants', 'v5-payout-staff', 'v5-run-frozen'], 'lock-preview': ['lock-preview-blocked'], attest: ['v124-payout-attest'] },
  '125': { v5: ['v5-payout-invariants', 'v5-payout-staff', 'v5-run-frozen'], 'lock-preview': ['lock-preview-blocked'], attest: ['v124-payout-attest'],
    uncapped: ['v125-current-run-uncapped'] },
  '126': { v5: ['v5-payout-invariants', 'v5-payout-staff', 'v5-run-frozen'], 'lock-preview': ['lock-preview-blocked'], attest: ['v124-payout-attest'],
    uncapped: ['v125-current-run-uncapped'], basis: ['v126-real-basis'] },
}
export const cmsPostProvenKeys = (phase: CmsVerifyPhase): readonly string[] => Object.keys(CMS_POST_PROVEN[phase] ?? {})

const ms = (ts: unknown) => Date.parse(toIsoUtc(ts))

/**
 * Đánh giá POST 120 / 121 / 122 / 123 — bám hậu kiểm trong transaction + khối VERIFY của migration. Mọi lệch ⇒ ok = false.
 * Phase là phase KHAI BÁO; DB ở phase khác ⇒ mục `phase-match` đỏ với lời rõ (PM 03/11 §5: dùng nhầm phase không được
 * thành xanh giả; checker 120 / 121 / 122 không là bằng chứng POST của phase sau — mọi kỳ vọng tập hàm / bảng / trigger / hình
 * dạng theo phase). 123 thêm V0 owner / V3 bảng payout + TRUNCATE / V4 policy / V5 bất biến payout (0 payout ⇒ `proven: false`,
 * CHƯA CHỨNG MINH — không xanh rỗng) / V6 locked không payout / V7 isolation gồm postgres; kỳ vọng 120–122 không đổi.
 */
export function evaluateCmsVerify(v: CmsVerifyInput): CmsVerifyCheck[] {
  const out: CmsVerifyCheck[] = []
  const add = (id: string, ok: boolean, detail: string) => out.push({ id, ok, detail })
  const P = Number(v.phase)
  const marker = new Map(v.markers.map((r) => [String(r.version), r]))
  const dbPhase = (['126', '125', '124', '123', '122', '121', '120'] as CmsVerifyPhase[]).find((x) => marker.has(x)) ?? null
  add('phase-match', dbPhase === v.phase, dbPhase === v.phase ? `DB đang ở phase ${v.phase}`
    : `PHASE KHÔNG PHÙ HỢP: DB có marker CMS cao nhất ${dbPhase ?? '(chưa có)'} — khai báo --phase=${v.phase}; chạy đúng phase, không dùng kết quả phase khác làm bằng chứng`)
  add('runner', v.whoami.bypass === true, `chạy bằng ${String(v.whoami.u)} (superuser / BYPASSRLS ${String(v.whoami.bypass)})`)
  // Profile hậu rollback: chỉ phase nền hợp lệ + marker 124 vắng; phần dư chỉ áp khi profile hợp lệ (sai ⇒ đỏ, không nới).
  const profileOk = v.profile !== undefined && cmsVerifyProfileValid(v.profile, v.phase)
  if (v.profile !== undefined) {
    add('profile', profileOk, profileOk
      ? `PROFILE ${v.profile} — VERIFY phase NỀN ${v.phase} sau rollback 124 (không phải VERIFY DB 124); chỉ nhận phần dư có chủ đích: ${Object.keys(CMS_VERIFY_PROFILE_RESIDUAL[v.profile]).join(', ')}`
      : `profile ${String(v.profile)} không hợp lệ với --phase=${v.phase} (chỉ ${CMS_VERIFY_PROFILES.map((p) => `${p}: phase ${CMS_VERIFY_PROFILE_PHASES[p].join(' / ')}`).join(' · ')})`)
    add('profile-124-absent', !marker.has('124'), marker.has('124') ? 'DB CÒN marker 124 — profile hậu rollback không dùng được' : 'marker 124 vắng (đã rollback)')
  }
  const residual = profileOk ? CMS_VERIFY_PROFILE_RESIDUAL[v.profile as CmsVerifyProfile] : {}

  for (const ph of CMS_VERIFY_PHASES) {
    if (Number(ph) <= P) add(`marker-${ph}`, marker.get(ph)?.name === CMS_MARKER_NAME[ph], `${ph} = ${String(marker.get(ph)?.name ?? 'THIẾU')}`)
    else add(`marker-${ph}-absent`, !marker.has(ph), marker.has(ph) ? `${ph} đã có (DB đi trước phase khai báo)` : `${ph} chưa chạy (đúng phase)`)
  }
  add('max-numeric', Number(v.maxNumeric.max_v) === P, `max số = ${String(v.maxNumeric.max_v)}`)

  // PRE đúng thứ tự (db-reviewer P2-3 / security P2-10): chụp TRƯỚC khi migration của phase ghi marker và SAU phase liền trước.
  const applied = marker.get(v.phase)?.applied_at
  const prevPhase = P > 120 ? String(P - 1) : null
  let preOk = false
  let preDetail = 'thiếu applied_at'
  try {
    const pre = ms(v.aclPre.db_now)
    const ap = applied !== undefined ? ms(applied) : NaN
    const apPrev = prevPhase && marker.get(prevPhase)?.applied_at !== undefined ? ms(marker.get(prevPhase)!.applied_at) : null
    preOk = Number.isFinite(ap) && pre < ap && (prevPhase === null || (apPrev !== null && pre > apPrev))
    preDetail = `PRE ${toIsoUtc(v.aclPre.db_now)} · ${v.phase} chạy ${Number.isFinite(ap) ? new Date(ap).toISOString() : '?'}${prevPhase ? ` · ${prevPhase} chạy ${apPrev !== null ? new Date(apPrev).toISOString() : '?'}` : ''}`
  } catch { /* preOk false */ }
  add('pre-order', preOk, preDetail)

  // Hàm CMS: đúng tập theo phase, mỗi tên một chữ ký, ma trận ACL (aclexplode), SECDEF, config, owner bypass, vân tay thân hàm.
  const expected = Object.entries(CMS_FN_MATRIX).filter(([, m]) => Number(m.phase) <= P).map(([n]) => n).sort()
  const got = [...new Set(v.functions.map((f) => String(f.name)))].sort()
  add('fn-set', JSON.stringify(got) === JSON.stringify(expected), `hàm cms: ${got.length} (kỳ vọng ${expected.length})${
    got.filter((n) => !expected.includes(n)).map((n) => ` LẠ:${n}`).join('')}${expected.filter((n) => !got.includes(n)).map((n) => ` THIẾU:${n}`).join('')}`)
  add('fn-overload', v.functions.length === got.length, `${v.functions.length} chữ ký / ${got.length} tên (không overload lạ)`)
  for (const f of v.functions) {
    const name = String(f.name)
    const m0 = CMS_FN_MATRIX[name]
    if (!m0 || Number(m0.phase) > P) continue
    // 124 đổi cấu hình lock 6 tham số (lock_timeout 3 s → 2 s) — kỳ vọng mới chỉ từ 124.
    const cfg = P >= 124 ? CMS_FN_CFG_124[name] : undefined
    const m = cfg ? { ...m0, lock3: cfg.lock3 ? (true as const) : undefined, lock2: cfg.lock2 ? (true as const) : undefined } : m0
    const aclOk = f.acl_default === false && (f.acl_extra ?? null) === m.acl
    add(`fn-acl:${name}`, aclOk, `ACL ngoài owner ${String(f.acl_extra ?? '∅')}${f.acl_default ? ' (MẶC ĐỊNH — PUBLIC ngầm)' : ''} · kỳ vọng ${m.acl ?? '∅'}`)
    const execOk = f.anon_x === false && f.auth_x === (m.acl === 'authenticated:EXECUTE') && f.svc_x === (m.acl === 'service_role:EXECUTE')
    add(`fn-exec:${name}`, execOk, `EXECUTE anon ${String(f.anon_x)} · authenticated ${String(f.auth_x)} · service_role ${String(f.svc_x)}`)
    add(`fn-secdef:${name}`, f.secdef === m.secdef, `SECURITY DEFINER ${String(f.secdef)} (kỳ vọng ${m.secdef})`)
    const nConfig = 1 + (m.lock ? 1 : 0) + (m.lock3 ? 1 : 0) + (m.lock2 ? 1 : 0) + (m.nestloop ? 1 : 0)
    // lock_timeout=2s (124): cột has_lock2 có từ tooling 124 (ảnh cũ thiếu ⇒ chỉ đạt khi không kỳ vọng).
    const lock2Ok = f.has_lock2 === undefined ? !m.lock2 : f.has_lock2 === !!m.lock2
    // lock_timeout=3s (RPC chốt 123): kiểm khi kỳ vọng có, hoặc khi hàm lại mang 3s (cột has_lock3 có từ tooling 123).
    const lock3Ok = f.has_lock3 === undefined ? !m.lock3 : f.has_lock3 === !!m.lock3
    add(`fn-config:${name}`, f.has_path === true && f.has_lock === m.lock && lock3Ok && lock2Ok && f.has_nestloop === !!m.nestloop && Number(f.n_config) === nConfig,
      `search_path=public ${String(f.has_path)} · lock_timeout=5s ${String(f.has_lock)}${m.lock3 || f.has_lock3 === true ? ` · lock_timeout=3s ${String(f.has_lock3)} (kỳ vọng ${!!m.lock3})` : ''}${m.lock2 || f.has_lock2 === true ? ` · lock_timeout=2s ${String(f.has_lock2)} (kỳ vọng ${!!m.lock2})` : ''} · enable_nestloop=off ${String(f.has_nestloop)} · ${String(f.n_config)} mục config (kỳ vọng ${nConfig})`)
    add(`fn-owner:${name}`, f.owner_bypass === true, `owner superuser / BYPASSRLS ${String(f.owner_bypass)}`)
    const src = P >= 126 && CMS_FN_SRC_126[name] !== undefined ? CMS_FN_SRC_126[name]
      : P >= 125 && CMS_FN_SRC_125[name] !== undefined ? CMS_FN_SRC_125[name]
      : P >= 124 && CMS_FN_SRC_124[name] !== undefined ? CMS_FN_SRC_124[name]
      : P >= 123 && CMS_FN_SRC_123[name] !== undefined ? CMS_FN_SRC_123[name] : m.src
    add(`fn-src:${name}`, f.src_md5 === src, `thân hàm md5 ${String(f.src_md5)}${f.src_md5 === src ? '' : ` · kỳ vọng ${src} (bản migration khác / sửa tay?)`}`)
  }

  // Policy: đúng 6, SELECT, PERMISSIVE, TO authenticated, qual đúng helper; không có ở sync_runs / qa_access / 5 bảng 122.
  const polTables = v.policies.map((p) => String(p.t)).sort()
  add('policies', v.policies.length === 6 && JSON.stringify(polTables) === JSON.stringify(CMS_TABLES_READ)
    && v.policies.every((p) => p.cmd === 'SELECT' && p.roles === '{authenticated}' && p.permissive === 'PERMISSIVE' && (p.with_check ?? null) === null),
  `${v.policies.length} policy: ${polTables.join(',')}`)
  for (const p of v.policies) {
    const want = POLICY_QUAL[String(p.t)]
    const got = normalizeCmsQual(p.qual)
    add(`policy-qual:${String(p.t)}`, want !== undefined && got === want, `qual ${got.slice(0, 200)}${want !== undefined && got !== want ? ` · kỳ vọng ${want}` : ''}`)
  }
  // 126 KHÔNG đổi trigger / hình dạng / cột / định nghĩa hàm (scripts/gen-cms-verify-fp-126.mjs) ⇒ nhánh `P >= 125` phủ cả 126 (có chủ đích).
  const trgWant = [...(P >= 125 ? CMS_TRIGGERS_125 : P >= 124 ? CMS_TRIGGERS_124 : P >= 123 ? CMS_TRIGGERS_123 : P >= 122 ? CMS_TRIGGERS_122 : CMS_TRIGGERS_120)].sort()
  const trgGot = v.triggers.map((t) => `${normalizeCmsQual(t.def)}|${String(t.enabled)}`).sort()
  if (P >= 123) {
    // 49 dòng: in phần LỆCH thay vì cả danh sách (vẫn so TẬP chính xác).
    const miss = trgWant.filter((t) => !trgGot.includes(t)), extra = trgGot.filter((t) => !trgWant.includes(t))
    add('triggers', JSON.stringify(trgGot) === JSON.stringify(trgWant), `${trgGot.length} trigger cms_* (kỳ vọng ${trgWant.length}: 3 của 120 / 122 + 46 của 123${P >= 124 ? ' + 9 của 124' : ''}${P >= 125 ? ' + 1 của 125' : ''} ALWAYS)${
      miss.map((t) => ` · THIẾU ${t}`).join('')}${extra.map((t) => ` · LẠ ${t}`).join('')}`)
  } else add('triggers', JSON.stringify(trgGot) === JSON.stringify(trgWant), `trigger: ${trgGot.join(' ; ') || '(không có)'}`)
  const shapeWant = P >= 125 ? CMS_TABLE_SHAPE_125 : P >= 124 ? CMS_TABLE_SHAPE_124 : P >= 123 ? CMS_TABLE_SHAPE_123 : P >= 122 ? CMS_TABLE_SHAPE_122 : CMS_TABLE_SHAPE
  const shapes = new Map(v.tableShape.map((r) => [String(r.t), r]))
  for (const [t, base] of Object.entries(shapeWant)) {
    const got = shapes.get(t)
    const res = residual[t]
    const want = res ?? base
    add(`table-shape:${t}`, !!got && got.con_md5 === want.con && got.idx_md5 === want.idx,
      `ràng buộc ${String(got?.con_md5 ?? 'THIẾU')} · index ${String(got?.idx_md5 ?? 'THIẾU')}${res ? ` (profile ${String(v.profile)}: CHỈ nhận phần dư ${want.con} — nền ${base.con} KHÔNG được nhận)` : ''}`)
  }

  // Bảng: RLS; đủ 7 quyền: anon ∅; authenticated đúng SELECT ở 6 bảng đọc; service_role đủ 7; 0 quyền theo cột lọt.
  // 123: service_role mất TRUNCATE trên 10 bảng có trước thuộc tập đóng băng; 2 bảng payout không cấp service_role.
  const noAuth = [...CMS_TABLES_NO_AUTH, ...(P >= 122 ? CMS_TABLES_RESULT : []), ...(P >= 123 ? CMS_TABLES_PAYOUT : []), ...(P >= 124 ? CMS_TABLES_ATTEST_124 : [])]
  const tnames = v.tables.map((t) => String(t.t)).sort()
  add('tables', JSON.stringify(tnames) === JSON.stringify([...CMS_TABLES_READ, ...noAuth].sort()), `${tnames.length} bảng cms_* (kỳ vọng ${CMS_TABLES_READ.length + noAuth.length})`)
  const all7 = TABLE_PRIVS.join(',')
  const noTruncate = TABLE_PRIVS.filter((p) => p !== 'TRUNCATE').join(',')
  for (const t of v.tables) {
    const name = String(t.t)
    const wantAuth = CMS_TABLES_READ.includes(name) ? 'SELECT' : null
    const wantSvc = P < 123 ? all7 : CMS_TABLES_PAYOUT.includes(name) || CMS_TABLES_ATTEST_124.includes(name) ? null : CMS_TABLES_FROZEN_123.includes(name) ? noTruncate : all7
    const ok = t.rls === true && (t.anon_p ?? null) === null && (t.auth_p ?? null) === wantAuth && (t.svc_p ?? null) === wantSvc && Number(t.col_leaks) === 0
    add(`table:${name}`, ok, `rls ${String(t.rls)} · anon ${String(t.anon_p ?? '∅')} · authenticated ${String(t.auth_p ?? '∅')} · service_role ${String(t.svc_p ?? '∅')} · cột lọt ${String(t.col_leaks)}${
      P >= 123 && (t.svc_p ?? null) !== wantSvc ? ` · kỳ vọng service_role ${wantSvc ?? '∅'}` : ''}`)
  }

  add('roles', v.roles.length === 2 && v.roles.every((r) => r.su === false && r.bypass === false),
    v.roles.map((r) => `${String(r.r)} super ${String(r.su)} bypass ${String(r.bypass)}`).join(' · '))

  const idx = v.oneRunningIndex.map((r) => String(r.indexdef))
  add('index-one-running', idx.length === 1 && /UNIQUE INDEX/.test(idx[0]) && /NULLS NOT DISTINCT/.test(idx[0]) && /status = 'running'/.test(idx[0]),
    idx[0] ?? 'THIẾU')

  // ACL: (1) hàm ngoài cms = PRE; (2) MỌI hàm có trước phase (gồm hàm 120 / 121 khi chạy 122) = PRE của phase.
  add('acl-old-functions', v.aclPost.n_old === v.aclPre.n_old && v.aclPost.md5_old === v.aclPre.md5_old,
    `hàm ngoài cms ${v.aclPost.n_old} / ${v.aclPost.md5_old} · PRE ${v.aclPre.n_old} / ${v.aclPre.md5_old}`)
  // 126 không thêm hàm (2 hàm 122 thay giữ chữ ký + ACL) ⇒ POST so TOÀN BỘ hàm public (n_all / md5_all) với PRE.
  const nEx = v.phase === '120' ? v.aclPost.n_ex120 : v.phase === '121' ? v.aclPost.n_ex121 : v.phase === '122' ? v.aclPost.n_ex122 : v.phase === '123' ? v.aclPost.n_ex123
    : v.phase === '124' ? v.aclPost.n_ex124 : v.phase === '125' ? v.aclPost.n_ex125 : v.aclPost.n_all
  const mdEx = v.phase === '120' ? v.aclPost.md5_ex120 : v.phase === '121' ? v.aclPost.md5_ex121 : v.phase === '122' ? v.aclPost.md5_ex122 : v.phase === '123' ? v.aclPost.md5_ex123
    : v.phase === '124' ? v.aclPost.md5_ex124 : v.phase === '125' ? v.aclPost.md5_ex125 : v.aclPost.md5_all
  // 124 đổi chữ ký rpc_cms_program_lock ⇒ so trên tập TRỪ hàm đó ở cả PRE lẫn POST (PRE phải chụp bằng tooling 124 — có n_ex124).
  const nPre = v.phase === '124' ? v.aclPre.n_ex124 : v.aclPre.n_all
  const mdPre = v.phase === '124' ? v.aclPre.md5_ex124 : v.aclPre.md5_all
  add('acl-preexisting-functions', nEx !== undefined && nPre !== undefined && nEx === nPre && mdEx === mdPre,
    `mọi hàm có trước ${v.phase}${v.phase === '124' ? ' (trừ rpc_cms_program_lock đổi chữ ký)' : v.phase === '126' ? ' (126 không thêm hàm ⇒ toàn bộ hàm public)' : ''}: ${String(nEx)} / ${String(mdEx)} · PRE ${String(nPre)} / ${String(mdPre)}`)

  if (P >= 121) {
    const inv = v.inv121
    add('inv121-overlap', !!inv && inv.overlap.length === 0, `${inv?.overlap.length ?? 'THIẾU'} cặp trùng ProductID`)
    add('inv121-tiers', !!inv && inv.tiers.length === 0, `${inv?.tiers.length ?? 'THIẾU'} bậc sai`)
    add('inv121-catalog', !!inv && inv.catalog.length === 0, `${inv?.catalog.length ?? 'THIẾU'} chương trình thiếu target danh mục`)
    add('isolation', !!v.isolation && v.isolation.iso === 'read committed' && Number(v.isolation.overrides) === 0,
      `${String(v.isolation?.iso)} · ${String(v.isolation?.overrides)} thiết lập đè (role / DB)`)
  }

  if (P >= 122) {
    const q = v.p122
    const u = q?.tiersUnique ?? []
    const ix = u[0]
    add('index-tiers-unique', u.length === 1 && ix.uniq === true && ix.valid === true && ix.ready === true && ix.no_pred === true && ix.no_expr === true
      && Number(ix.natts) === 2 && Number(ix.nkey) === 2 && ix.on_tiers === true && ix.cols === 'program_product_id,qty_from' && ix.asc_default === true,
    ix ? `unique ${String(ix.uniq)} · valid ${String(ix.valid)} · ready ${String(ix.ready)} · không vị từ ${String(ix.no_pred)} · không biểu thức ${String(ix.no_expr)} · cột ${String(ix.cols)} (${String(ix.nkey)}/${String(ix.natts)}) · ASC ${String(ix.asc_default)}`
      : 'THIẾU cms_program_tiers_product_from_idx')
    const fk = (q?.pointerFk ?? []).map((r) => `${String(r.name)}=${normalizeCmsQual(r.def)}|${String(r.valid)}`)
    add('pointer-fk', fk.length === 1 && fk[0] === CMS_POINTER_FK, fk.join(' ; ') || 'THIẾU FK pointer kết quả')
    // 126 (sales-only, PM 06/11) là migration riêng được duyệt mở cổng kết quả bán tạm tính ⇒ phase ≥ 126 kỳ vọng true (mục đổi id
    // để báo cáo không nhầm); phase 122–125 giữ false. Chốt / chi trả thật vẫn do policy chặn (v4-lock-policy: real.ready = false).
    if (P >= 126) {
      add('release-gate-open', q?.releaseGate?.open === true,
        `cms__results_release_open() = ${String(q?.releaseGate?.open ?? 'THIẾU')} (126 sales-only ⇒ phải true — cổng kết quả bán tạm tính MỞ; trả hàng Q-206 phase sau)`)
    } else {
      add('release-gate-closed', q?.releaseGate?.open === false,
        `cms__results_release_open() = ${String(q?.releaseGate?.open ?? 'THIẾU')} (Q-206 HOLD ⇒ phải false; mở cổng = migration riêng được duyệt)`)
    }
    add('inv122-pointer', !!q && q.inv122Pointer.length === 0, `${q?.inv122Pointer.length ?? 'THIẾU'} chương trình trỏ run không hợp lệ`)
    // Vân tay định nghĩa hàm / cột sau 122 (db-reviewer P2-1) — sinh từ file migration, kiểm lại PG15.
    const defWant = P >= 125 ? CMS_FN_DEF_125 : P >= 124 ? CMS_FN_DEF_124 : P >= 123 ? CMS_FN_DEF_123 : CMS_FN_DEF_122
    const defs = new Map((q?.fnDefs ?? []).map((r) => [String(r.name), String(r.def_md5)]))
    add('fn-def-set', defs.size === Object.keys(defWant).length && Object.keys(defWant).every((n) => defs.has(n)), `${defs.size} định nghĩa hàm (kỳ vọng ${Object.keys(defWant).length})`)
    for (const [n, want] of Object.entries(defWant)) add(`fn-def:${n}`, defs.get(n) === want, `chữ ký / DEFAULT / trả về / volatility md5 ${defs.get(n) ?? 'THIẾU'}${defs.get(n) === want ? '' : ` · kỳ vọng ${want}`}`)
    const cols = new Map((q?.columns ?? []).map((r) => [String(r.t), String(r.col_md5)]))
    for (const [t, want] of Object.entries(P >= 125 ? CMS_COL_125 : P >= 124 ? CMS_COL_124 : P >= 123 ? CMS_COL_123 : CMS_COL_122)) add(`table-cols:${t}`, cols.get(t) === want, `cột (kiểu / NOT NULL / DEFAULT) md5 ${cols.get(t) ?? 'THIẾU'}${cols.get(t) === want ? '' : ` · kỳ vọng ${want}`}`)
  }

  if (P >= 123) {
    const q = v.p123
    // V0 owner — một owner cho mọi bảng cms_* + hàm cms_* / rpc_cms_*, trùng owner hàm 122 (guard chỉ-owner của 123 dựa vào đây).
    const o = q?.owners
    const tOwn = String(o?.table_owners ?? ''), fOwn = String(o?.fn_owners ?? ''), f122 = String(o?.fn122_owners ?? '')
    add('v0-owner', tOwn !== '' && !tOwn.includes(',') && tOwn === fOwn && fOwn === f122,
      `owner bảng cms_* [${tOwn || 'THIẾU'}] · hàm cms [${fOwn || 'THIẾU'}] · hàm 122 [${f122 || 'THIẾU'}] (kỳ vọng MỘT role, trùng nhau)`)
    // V7 — tiền điều kiện mọi đường ghi dữ liệu run / TRUNCATE (cả cron sync 122); chỉ đọc, không tự đổi cấu hình.
    add('v7-isolation-123', !!q?.isolation123 && q.isolation123.iso === 'read committed' && Number(q.isolation123.overrides) === 0,
      `${String(q?.isolation123?.iso ?? 'THIẾU')} · ${String(q?.isolation123?.overrides ?? 'THIẾU')} thiết lập khác read committed (DB / vai API / postgres / vai đang chạy)`)
    // Hàm của trigger: đúng hàm public trong ma trận, INVOKER / DEFINER đúng ma trận (3 guard chỉ-owner là INVOKER có chủ đích).
    const tf = q?.triggerFns ?? []
    const tfBad = tf.filter((r) => { const m = CMS_FN_MATRIX[String(r.fn)]; return !m || Number(m.phase) > P || r.fn_public !== true || r.secdef !== m.secdef })
    const trgN = (P >= 125 ? CMS_TRIGGERS_125 : P >= 124 ? CMS_TRIGGERS_124 : CMS_TRIGGERS_123).length
    add('trigger-fns', tf.length === trgN && tfBad.length === 0,
      `${tf.length} trigger (kỳ vọng ${trgN}) · hàm sai / sai INVOKER-DEFINER ${tfBad.length}${tfBad.slice(0, 5).map((r) => ` · ${String(r.t)}.${String(r.name)}→${String(r.fn)} secdef ${String(r.secdef)}`).join('')}`)
    // V4 — policy thật chưa ready + version 1; cổng kết quả đóng ở 123–125 (đã có release-gate-closed ở P ≥ 122), MỞ từ 126
    // (release-gate-open) — real.ready VẪN false ở mọi phase (126 không mở chốt / chi trả thật).
    const lp = q?.lockPolicy
    const gateWant = P >= 126
    add('v4-lock-policy', lp?.real_ready === 'false' && lp?.version === '1' && lp?.release_open === gateWant,
      `cms__lock_policy(): real.ready ${String(lp?.real_ready ?? 'THIẾU')} (kỳ vọng false) · version ${String(lp?.version ?? 'THIẾU')} (kỳ vọng 1) · cổng kết quả ${String(lp?.release_open ?? 'THIẾU')} (kỳ vọng ${gateWant}${gateWant ? ' — 126 sales-only' : ' — Q-206 HOLD'})`)
    // V3 — 2 bảng payout: RLS, relacl / attacl không có PUBLIC / anon / authenticated / service_role.
    const pa = q?.payoutAcl ?? []
    add('v3-payout-acl', pa.length === 2 && pa.every((r) => r.rls === true && Number(r.api_grants) === 0 && Number(r.api_col_grants) === 0),
      pa.map((r) => `${String(r.t)}: rls ${String(r.rls)} · grant bảng vai API ${String(r.api_grants)} · grant cột ${String(r.api_col_grants)}`).join(' ; ') || 'THIẾU bảng payout')
    // TRUNCATE thu hồi khỏi anon / authenticated / service_role trên 12 bảng (has_table_privilege — gồm cả PUBLIC).
    const byName = new Map(v.tables.map((t) => [String(t.t), t]))
    const trBad = CMS_TABLES_FROZEN_123.filter((n) => { const t = byName.get(n); return !t || [t.anon_p, t.auth_p, t.svc_p].some((p) => String(p ?? '').split(',').includes('TRUNCATE')) })
    add('v3-truncate-revoked', trBad.length === 0, `${CMS_TABLES_FROZEN_123.length - trBad.length} / ${CMS_TABLES_FROZEN_123.length} bảng tập đóng băng không còn TRUNCATE cho vai API${trBad.map((n) => ` · CÒN / THIẾU ${n}`).join('')}`)
    // V5 — bất biến mọi payout; chưa có payout ⇒ CHƯA CHỨNG MINH (không xanh rỗng).
    const ip = q?.invPayout
    const nPay = Number(ip?.n ?? NaN), badPay = Number(ip?.bad ?? NaN)
    const badIds = String(ip?.bad_ids ?? '').split(',').filter(Boolean).map((id) => maskCmsUuid(id))
    out.push({ id: 'v5-payout-invariants', ok: Number.isInteger(nPay) && badPay === 0,
      detail: `${Number.isInteger(nPay) ? nPay : 'THIẾU'} payout (QA ${String(ip?.n_test ?? '?')}) · lệch ${Number.isInteger(badPay) ? badPay : 'THIẾU'}${badIds.length ? ` (${badIds.join(', ')})` : ''}${nPay > 0 ? '' : ' — CHƯA CHỨNG MINH (chưa có payout nào)'}`,
      proven: nPay > 0 })
    // V6 — 'locked' không payout chỉ được là QA (dấu vết rollback 123, H8).
    const il = q?.invLocked
    add('v6-locked-without-payout', !!il && Number(il.real_n) === 0,
      `${String(il?.real_n ?? 'THIẾU')} chương trình THẬT locked không payout${String(il?.real_ids ?? '').split(',').filter(Boolean).map((id) => ` ${maskCmsUuid(id)}`).join('')} · QA ${String(il?.qa_n ?? '?')} (dấu vết rollback, cho phép)`)
    // V5 theo TỪNG dược sĩ + run đóng băng còn nguyên như lúc seal; chưa có payout ⇒ CHƯA (không xanh rỗng).
    const agg = (id: string, r: Row | undefined, what: string) => {
      const n = Number(r?.n ?? NaN), bad = Number(r?.bad ?? NaN)
      const ids = String(r?.bad_ids ?? '').split(',').filter(Boolean).map((x) => maskCmsUuid(x))
      out.push({ id, ok: Number.isInteger(n) && bad === 0, proven: n > 0,
        detail: `${Number.isInteger(n) ? n : 'THIẾU'} payout · ${what} lệch ${Number.isInteger(bad) ? bad : 'THIẾU'}${ids.length ? ` (${ids.join(', ')})` : ''}${n > 0 ? '' : ' — CHƯA CHỨNG MINH (chưa có payout nào)'}` })
    }
    agg('v5-payout-staff', q?.invPayoutStaff, 'chương trình có tập (dược sĩ, tiền) payout ≠ Σ cms_results theo dược sĩ —')
    agg('v5-run-frozen', q?.invRunFrozen, 'run chốt không còn như lúc seal (số dòng 4 bảng ≠ seal_expect / Σ dòng đơn ≠ tiền run) —')
    // Quyền GIÁN TIẾP (thừa kế vai / PUBLIC / theo cột) + view / matview / rule phụ thuộc 2 bảng payout.
    const pr = q?.payoutReach ?? []
    add('v3-payout-colpriv', pr.length === 2 && pr.every((r) => Number(r.api_any_col) === 0),
      pr.map((r) => `${String(r.t)}: vai API có quyền cột (kể cả gián tiếp) ${String(r.api_any_col)}`).join(' ; ') || 'THIẾU bảng payout')
    add('v3-payout-views', pr.length === 2 && pr.every((r) => Number(r.dep_rels) === 0),
      pr.map((r) => `${String(r.t)}: quan hệ phụ thuộc qua pg_rewrite ${String(r.dep_rels)}${r.dep_names ? ` [${String(r.dep_names)}]` : ''}`).join(' ; ') || 'THIẾU bảng payout')
    // VERIFY V8 của migration 123: chương trình thật không có đường chốt (cổng Q-206 / policy thật pending); 0 chương trình thật ⇒ CHƯA.
    const lk = q?.lockPreview
    const nReal = Number(lk?.n_real ?? NaN), openN = Number(lk?.open_n ?? NaN)
    out.push({ id: 'lock-preview-blocked', ok: Number.isInteger(nReal) && openN === 0, proven: nReal > 0,
      detail: `rpc_cms_lock_preview: ${Number.isInteger(nReal) ? nReal : 'THIẾU'} chương trình thật · thiếu chặn CMS_LOCK_RELEASE_GATE / CMS_LOCK_POLICY_PENDING ${Number.isInteger(openN) ? openN : 'THIẾU'}${
        String(lk?.open_ids ?? '').split(',').filter(Boolean).map((x) => ` ${maskCmsUuid(x)}`).join('')}${nReal > 0 ? '' : ' — CHƯA CHỨNG MINH (chưa có chương trình thật)'}` })
  }
  if (P >= 124) {
    // V-124: payout chốt bằng chứng nhận ⇔ id; chứng nhận decision10 của đúng chương trình + run, chưa bị thay / thu hồi.
    const ia = v.p124?.invAttest
    const n = Number(ia?.n ?? NaN), bad = Number(ia?.bad ?? NaN)
    out.push({ id: 'v124-payout-attest', ok: Number.isInteger(n) && bad === 0, proven: n > 0,
      detail: `${Number.isInteger(n) ? n : 'THIẾU'} payout chốt bằng chứng nhận · lệch ${Number.isInteger(bad) ? bad : 'THIẾU'}${String(ia?.bad_ids ?? '').split(',').filter(Boolean).map((x) => ` ${maskCmsUuid(x)}`).join('')}${n > 0 ? '' : ' — CHƯA CHỨNG MINH (chưa có payout operator_reconciliation)'}` })
  }
  if (P >= 125) {
    // V-125 (CMS-Q-220): cấu hình chưa chốt (draft / active) không còn bậc cuối hữu hạn; run HIỆN HÀNH không mang trần / AT_CAP. Run
    // lịch sử đã chốt (QA có trần cũ) KHÔNG nằm trong bất biến — không đỏ oan. 0 chương trình có run hiện hành ⇒ CHƯA CHỨNG MINH.
    const lt = v.p125?.invLastTier, cc = v.p125?.invCurrentCap
    add('v125-last-tier-open', Array.isArray(lt) && lt.length === 0,
      `${Array.isArray(lt) ? lt.length : 'THIẾU'} chương trình chưa chốt còn bậc cuối hữu hạn${(lt ?? []).slice(0, 5).map((r) => ` · ${maskCmsUuid(String(r.id))} ${String(r.status)} (${String(r.products)} SP)`).join('')}`)
    const nCur = Number(v.p125?.current?.n ?? NaN)
    out.push({ id: 'v125-current-run-uncapped', ok: Array.isArray(cc) && cc.length === 0 && Number.isInteger(nCur),
      detail: `${Array.isArray(cc) ? cc.length : 'THIẾU'} chương trình chưa chốt có run hiện hành mang trần / AT_CAP${(cc ?? []).slice(0, 5).map((r) => ` · ${maskCmsUuid(String(r.id))} cap ${String(r.cap_rows)} · AT_CAP ${String(r.at_cap_lines)}`).join('')} · ${Number.isInteger(nCur) ? nCur : 'THIẾU'} chương trình chưa chốt có run hiện hành${nCur > 0 ? '' : ' — CHƯA CHỨNG MINH (chưa có run hiện hành nào)'}`,
      proven: nCur > 0 })
  }
  if (P >= 126) {
    // V-126 (sales-only, = V4 cuối migration 126): run bán của chương trình THẬT công bố SAU marker 126 phải mang dấu DB
    // detail.results_basis = 'sales_only_v1'. Thiếu marker (marker_at NULL) ⇒ đỏ; 0 run thật công bố sau 126 ⇒ CHƯA CHỨNG MINH.
    const ib = v.p126?.invRealBasis
    const n = Number(ib?.n ?? NaN), bad = Number(ib?.bad ?? NaN)
    let markerAt: string | null = null
    try { if (ib?.marker_at !== undefined && ib?.marker_at !== null && ib?.marker_at !== '') markerAt = toIsoUtc(ib.marker_at) } catch { /* sai dạng ⇒ coi như thiếu */ }
    const hasMarker = markerAt !== null
    out.push({ id: 'v126-real-basis', ok: hasMarker && Number.isInteger(n) && bad === 0, proven: n > 0,
      detail: `${hasMarker ? `marker 126 ${markerAt}` : 'THIẾU marker 126'} · ${Number.isInteger(n) ? n : 'THIẾU'} run bán THẬT công bố sau 126 · thiếu results_basis = sales_only_v1 / results_gate = 126 ${Number.isInteger(bad) ? bad : 'THIẾU'}${
        String(ib?.bad_ids ?? '').split(',').filter(Boolean).slice(0, 5).map((x) => ` ${maskCmsUuid(x)}`).join('')}${n > 0 ? '' : ' — CHƯA CHỨNG MINH (chưa có run thật công bố sau 126)'}` })
  }
  // post --require-proven (như V8): mọi mục của khoá phải ĐẠT và ĐÃ chứng minh.
  for (const k of v.requireProven ?? []) {
    const ids = CMS_POST_PROVEN[v.phase]?.[k]
    const cs = (ids ?? []).map((id) => out.find((c) => c.id === id))
    const okK = !!ids && cs.every((c) => !!c && c.ok && c.proven === true)
    out.push({ id: `require-proven:${k}`, ok: okK,
      detail: !ids ? `khoá không hợp lệ cho phase ${v.phase}` : cs.map((c, i) => `${ids[i]} ${!c ? 'THIẾU' : !c.ok ? 'LỆCH' : c.proven === true ? 'đã chứng minh' : 'CHƯA chứng minh'}`).join(' · ') })
  }
  return out
}

/**
 * Đánh giá V8 theo VAI KHAI BÁO (bắt buộc; SQL dựng cho đúng vai đó): phiên thật sự bị RLS áp trong một snapshot, cờ super
 * thật khớp vai, TẬP id helper = tập oracle, số dòng thấy của TỪNG bảng = kỳ vọng tính từ tập oracle (và 0 dòng ngoài
 * mảng helper), không nháp với vai không phải super, không QA khi không marker, không đọc bảng riêng tư / ghi / gọi RPC.
 * Mỗi bảng có cờ `proven`: chỉ "chứng minh RLS cắt" khi tổng > kỳ vọng (ngược lại in CHƯA, không ĐẠT oan).
 */
/** Tên bảng V8 dùng được cho `--require-proven`. */
export const CMS_V8_TABLE_KEYS: readonly string[] = V8_TABLES.map(([k]) => k)
/** Khoá `--require-proven` theo phase: 122 thêm `results` (phạm vi dòng kết quả thật sự bị cắt). */
export const cmsV8ProvenKeys = (phase?: CmsV8Phase): readonly string[] => (phase === '123' || phase === '124' || phase === '125' || phase === '126' ? [...CMS_V8_TABLE_KEYS, 'results', 'result_lines', 'payout']
  : phase === '122' ? [...CMS_V8_TABLE_KEYS, 'results', 'result_lines'] : CMS_V8_TABLE_KEYS)

/**
 * Đánh giá V8 theo VAI và PHASE KHAI BÁO (SQL dựng cho đúng vai / phase đó): phase DB = phase khai báo (khác ⇒ đỏ rõ, không xanh
 * giả); phiên thật sự bị RLS áp trong một snapshot, cờ super thật khớp vai, TẬP id helper = tập oracle, số dòng thấy của TỪNG
 * bảng = kỳ vọng tính từ tập oracle (và 0 dòng ngoài mảng helper), không nháp với vai không phải super, không QA khi không
 * marker, không đọc bảng riêng tư / ghi, RPC gọi được ĐÚNG tên theo phase. Phase 122: RPC đọc kết quả gọi thật cho mọi chương
 * trình — ngoài tập ⇒ FORBIDDEN (không lộ), trong tập ⇒ đọc được, tập dòng kết quả = oracle phạm vi hiện tại, excluded chỉ super.
 * Mỗi bảng có cờ `proven`: chỉ "chứng minh RLS cắt" khi tổng > kỳ vọng (ngược lại in CHƯA, không ĐẠT oan).
 */
export function evaluateCmsV8(
  row: Row, userId: string, role: CmsV8Role,
  expect: { qa?: boolean; readable?: number; requireProven?: readonly string[]; phase?: CmsV8Phase } = {},
): CmsVerifyCheck[] {
  const out: CmsVerifyCheck[] = []
  const add = (id: string, ok: boolean, detail: string, proven?: boolean) => out.push(proven === undefined ? { id, ok, detail } : { id, ok, detail, proven })
  const declared = expect.phase
  const dbPhase = String(row.db_phase ?? '')
  const phaseOk = declared !== undefined ? dbPhase === declared : dbPhase === '120' || dbPhase === '121'
  add('v8-phase', phaseOk, phaseOk ? `DB phase ${dbPhase}${declared ? '' : ' (không khai --phase: hợp lệ trước 122)'}`
    : `PHASE KHÔNG PHÙ HỢP: DB phase ${dbPhase || '(chưa có)'} — ${declared ? `khai báo --phase=${declared}` : 'không khai --phase'}; chạy lại với --phase=${dbPhase || '?'}`)
  const phase: CmsV8Phase = declared ?? '121'
  add('v8-user', row.user_role === V8_DB_ROLE[role], `vai DB ${String(row.user_role) || '(không có tài khoản)'} · khai báo ${role}`)
  add('v8-super', row.su === (role === 'super'), `is_super_admin() ${String(row.su)} · khai báo ${role}`)
  add('v8-session', row.role_now === 'authenticated' && row.uid === userId && row.ro === 'on' && row.iso === 'repeatable read'
    && row.me_bypass === false && row.runner_bypass === true,
  `role ${String(row.role_now)} · uid ${row.uid === userId ? 'khớp' : 'LỆCH'} · read only ${String(row.ro)} · ${String(row.iso)} · bypass phiên ${String(row.me_bypass)} · bypass người chạy ${String(row.runner_bypass)}`)
  const rlsKeys = Object.keys(row).filter((k) => k.startsWith('rls_'))
  add('v8-rls-active', rlsKeys.length === 6 && rlsKeys.every((k) => row[k] === true), rlsKeys.map((k) => `${k.slice(4)} ${String(row[k])}`).join(' · '))
  add('v8-oracle-set', row.same_set === true && row.seen_programs === row.readable && row.readable === row.exp_programs,
    `tập id helper ${row.same_set === true ? '=' : '≠'} tập kỳ vọng theo vai ${role} · helper ${String(row.readable)} · qua RLS ${String(row.seen_programs)} · kỳ vọng ${String(row.exp_programs)}`)
  add('v8-outside', [row.out_programs, row.out_stores, row.out_products, row.out_tiers, row.out_import_runs].every((x) => x === 0),
    `dòng ngoài mảng helper: chương trình ${String(row.out_programs)}, nhà thuốc ${String(row.out_stores)}, SP ${String(row.out_products)}, bậc ${String(row.out_tiers)}, import ${String(row.out_import_runs)}`)
  for (const [k] of V8_TABLES) {
    const seen = Number(row[`seen_${k}`]), exp = Number(row[`exp_${k}`]), total = Number(row[`total_${k}`])
    const proven = total > exp
    add(`v8-table:${k}`, Number.isInteger(seen) && seen === exp, `thấy ${seen} · kỳ vọng ${exp} · tổng ${total}${proven ? '' : ' — CHƯA CHỨNG MINH CẮT (tổng = kỳ vọng)'}`, proven)
  }
  add('v8-oracle-qa', row.qa === row.qa_db, `marker qua helper ${String(row.qa)} · DB ${String(row.qa_db)}`)
  add('v8-no-draft', role === 'super' || row.draft_programs === 0, `nháp thấy ${String(row.draft_programs)}`)
  add('v8-no-test-without-marker', row.qa === true || row.test_programs === 0, `marker ${String(row.qa)} · chương trình QA thấy ${String(row.test_programs)}`)
  const wantRpc = CMS_V8_RPC_CALLABLE[phase]
  add('v8-private', row.read_qa_access === false && row.read_sync_runs === false && row.write_programs === false && row.private_tables === 0
    && row.rpc_callable === wantRpc,
  `cms_qa_access ${String(row.read_qa_access)} · cms_sync_runs ${String(row.read_sync_runs)} · ghi ${String(row.write_programs)} · bảng riêng tư đọc / ghi được ${String(row.private_tables)} · rpc_cms_* gọi được [${String(row.rpc_callable)}] (kỳ vọng [${wantRpc}])`)
  if (phase === '122' || phase === '123' || phase === '124' || phase === '125' || phase === '126') {
    add('v8-result-role', row.rx_role === 'authenticated', `khối gọi RPC chạy bằng vai ${String(row.rx_role)} (kỳ vọng authenticated)`)
    add('v8-result-rpc', row.rx_leak === 0 && row.rx_deny === 0 && row.rx_err === 0,
      `header ngoài tập đọc được ${String(row.rx_leak)} · trong tập bị chặn ${String(row.rx_deny)} · lỗi khác ${String(row.rx_err)} · chương trình ngoài tập ${String(row.rx_outside)}${Number(row.rx_outside) > 0 ? '' : ' — CHƯA CHỨNG MINH chặn (mọi chương trình đều trong tập)'}`,
      Number(row.rx_outside) > 0)
    add('v8-result-excluded', row.rx_exc === 0, `rpc_cms_result_excluded sai quyền ${String(row.rx_exc)} (chỉ super được đọc) · số lần gọi ${String(row.rx_exc_calls)}${Number(row.rx_exc_calls) > 0 ? '' : ' — CHƯA gọi lần nào'}`,
      Number(row.rx_exc_calls) > 0)
    const rTotal = Number(row.rx_total_n), rExp = Number(row.rx_exp_n)
    add('v8-table:results', row.rx_same_set === true && row.rx_seen_n === row.rx_exp_n,
      `tập dòng kết quả qua RPC ${row.rx_same_set === true ? '=' : '≠'} oracle phạm vi hiện tại · thấy ${String(row.rx_seen_n)} · kỳ vọng ${String(row.rx_exp_n)} · tổng ${String(row.rx_total_n)}${rTotal > rExp ? '' : ' — CHƯA CHỨNG MINH CẮT (tổng = kỳ vọng)'}`, rTotal > rExp)
    add('v8-result-shape', row.rx_catalog_same === true && row.rx_users_same === true,
      `mảng catalog ${row.rx_catalog_same === true ? '=' : '≠'} oracle · mảng users ${row.rx_users_same === true ? '=' : '≠'} oracle`)
    const lTotal = Number(row.rx_ltotal_n), lExp = Number(row.rx_lexp_n)
    add('v8-table:result_lines', row.rx_lines_same === true && row.rx_lseen_n === row.rx_lexp_n,
      `tập dòng đơn qua rpc_cms_result_lines ${row.rx_lines_same === true ? '=' : '≠'} oracle · thấy ${String(row.rx_lseen_n)} · kỳ vọng ${String(row.rx_lexp_n)} · tổng ${String(row.rx_ltotal_n)}${lTotal > lExp ? '' : ' — CHƯA CHỨNG MINH CẮT (tổng = kỳ vọng)'}`, lTotal > lExp)
    add('v8-result-lines-user', row.rx_lleak === 0,
      `rpc_cms_result_lines với p_user_id ngoài phạm vi trả dữ liệu ${String(row.rx_lleak)} lần${row.rx_outsider === true ? '' : ' — CHƯA CHỨNG MINH (không có staff ngoài phạm vi / super)'}`, row.rx_outsider === true)
  }
  if (phase === '123' || phase === '124' || phase === '125' || phase === '126') {
    // rpc_cms_payout gọi thật dưới authenticated cho MỌI chương trình (Q-208 / Q-217).
    add('v8-payout-role', row.py_role === 'authenticated', `khối gọi rpc_cms_payout chạy bằng vai ${String(row.py_role)} (kỳ vọng authenticated)`)
    add('v8-payout-rpc', row.py_leak === 0 && row.py_deny === 0 && row.py_err === 0,
      `ngoài tập trả dữ liệu / NOT_LOCKED ${String(row.py_leak)} · trong tập bị chặn ${String(row.py_deny)} · lỗi khác ${String(row.py_err)} · chưa chốt ${String(row.py_nolock)} · chương trình ngoài tập ${String(row.rx_outside)}${Number(row.rx_outside) > 0 ? '' : ' — CHƯA CHỨNG MINH chặn (mọi chương trình đều trong tập)'}`,
      Number(row.rx_outside) > 0)
    const pTotal = Number(row.py_total_n), pExp = Number(row.py_exp_n)
    add('v8-table:payout', row.py_same_set === true && row.py_seen_n === row.py_exp_n,
      `tập dòng chi trả qua rpc_cms_payout ${row.py_same_set === true ? '=' : '≠'} oracle phạm vi hiện tại · thấy ${String(row.py_seen_n)} · kỳ vọng ${String(row.py_exp_n)} · tổng ${String(row.py_total_n)}${pTotal > pExp ? '' : ' — CHƯA CHỨNG MINH CẮT (tổng = kỳ vọng)'}`, pTotal > pExp)
    add('v8-payout-fields', row.py_totals_same === true && row.py_field === 0,
      `scope_total / program_total ${row.py_totals_same === true ? '=' : '≠'} oracle (super: program_total; còn lại chỉ scope_total) · tập khoá ngoài danh sách cho phép của vai ${role} (cấp trên / dòng; email chỉ super) ${String(row.py_field)} · đã đọc ${String(row.py_calls)} / ${String(row.py_prog_n)} chương trình đã chốt${Number(row.py_calls) > 0 ? '' : ' — CHƯA CHỨNG MINH (chưa đọc được payout nào)'}`,
      Number(row.py_calls) > 0)
  }
  if (expect.qa !== undefined) add('v8-expect-qa', row.qa === expect.qa, `marker ${String(row.qa)} (kỳ vọng ${expect.qa})`)
  if (expect.readable !== undefined) add('v8-expect-readable', row.readable === expect.readable, `đọc được ${String(row.readable)} (kỳ vọng ${expect.readable})`)
  // Gate D3 (runbook): bảng được yêu cầu phải CHỨNG MINH RLS cắt (tổng > kỳ vọng) — CHƯA ⇒ đỏ (db-reviewer vòng 3 P2-C).
  for (const k of expect.requireProven ?? []) {
    const t = out.find((c) => c.id === `v8-table:${k}`)
    add(`v8-require-proven:${k}`, !!t && t.ok && t.proven === true, t ? (t.proven ? 'đã chứng minh RLS cắt' : 'CHƯA chứng minh (tổng = kỳ vọng)') : 'bảng không hợp lệ cho phase này')
  }
  return out
}
