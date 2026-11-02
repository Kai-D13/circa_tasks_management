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

/** Hàm mới của từng phase (tên) — dùng để so ACL các hàm ĐÃ CÓ trước phase với ảnh PRE. */
export const CMS_PHASE_FUNCTIONS: Record<'120' | '121', string[]> = {
  '120': ['cms_has_qa_access', 'cms_readable_program_ids', 'rpc_cms_sync_run_open', 'rpc_cms_product_master_upsert',
    'rpc_cms_sync_run_close', 'cms__qa_access_stamp', 'cms__programs_guard'],
  '121': ['cms__vn_today', 'cms__lock_catalog', 'cms__conflicts', 'rpc_cms_program_save', 'rpc_cms_import_preview_save',
    'rpc_cms_import_commit', 'rpc_cms_program_activate'],
}

const isCmsFnSql = `(left(p.proname, 4) = 'cms_' OR left(p.proname, 8) = 'rpc_cms_')`

/**
 * Ảnh ACL hàm public (cùng công thức PRE lịch sử: md5 string_agg sig=proacl, ';', ORDER BY sig): toàn bộ, phần ngoài
 * cms (= V6 120 / V3 121), và phần TRỪ hàm mới của 120 / 121 (để POST 121 so cả 7 hàm của 120 với PRE 121). Kèm giờ DB.
 */
export function cmsVerifyAclSql(): string {
  const n120 = CMS_PHASE_FUNCTIONS['120'].map((n) => `'${n}'`).join(',')
  const n121 = CMS_PHASE_FUNCTIONS['121'].map((n) => `'${n}'`).join(',')
  return `SELECT now() AS db_now,
       count(*)::int AS n_all, md5(string_agg(f.sig || '=' || f.acl, ';' ORDER BY f.sig)) AS md5_all,
       count(*) FILTER (WHERE NOT f.cms)::int AS n_old, md5(string_agg(f.sig || '=' || f.acl, ';' ORDER BY f.sig) FILTER (WHERE NOT f.cms)) AS md5_old,
       count(*) FILTER (WHERE f.name NOT IN (${n120}))::int AS n_ex120,
       md5(string_agg(f.sig || '=' || f.acl, ';' ORDER BY f.sig) FILTER (WHERE f.name NOT IN (${n120}))) AS md5_ex120,
       count(*) FILTER (WHERE f.name NOT IN (${n121}))::int AS n_ex121,
       md5(string_agg(f.sig || '=' || f.acl, ';' ORDER BY f.sig) FILTER (WHERE f.name NOT IN (${n121}))) AS md5_ex121
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
  markers: `SELECT version, name, applied_at FROM public.app_migrations WHERE version IN ('119', '120', '121') OR version !~ '^[0-9]+$' ORDER BY 1`,
  maxNumeric: `SELECT max(CASE WHEN version ~ '^[0-9]+$' THEN version::int END) AS max_v FROM public.app_migrations`,
  functions: `SELECT p.proname::text AS name, p.oid::regprocedure::text AS sig, p.prosecdef AS secdef,
       md5(replace(p.prosrc, E'\\r', '')) AS src_md5,
       'search_path=public' = ANY (coalesce(p.proconfig, '{}'::text[])) AS has_path,
       'lock_timeout=5s' = ANY (coalesce(p.proconfig, '{}'::text[])) AS has_lock,
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
            OR (c.relname IN ('cms_qa_access', 'cms_sync_runs') AND has_column_privilege('authenticated', c.oid, a.attnum, 'SELECT')))) AS col_leaks
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
       (SELECT md5(string_agg(k.conname || '=' || replace(pg_get_constraintdef(k.oid), 'public.', ''), ';' ORDER BY k.conname))
          FROM pg_constraint k WHERE k.conrelid = c.oid) AS con_md5,
       (SELECT md5(string_agg(replace(pg_get_indexdef(i.indexrelid), 'public.', ''), ';' ORDER BY replace(pg_get_indexdef(i.indexrelid), 'public.', '')))
          FROM pg_index i WHERE i.indrelid = c.oid) AS idx_md5
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND left(c.relname, 4) = 'cms_' ORDER BY 1`,
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

/**
 * V8 — phiên `authenticated` MÔ PHỎNG ở DB trong MỘT transaction READ ONLY + REPEATABLE READ (claim không ký, không đọc
 * secret), theo VAI KHAI BÁO:
 * (1) khối DO (vai superuser của pg-meta) chụp vai thật của user, marker, vai chạy có bypass, và TẬP id chương trình kỳ
 *     vọng tính ĐỘC LẬP từ bảng gốc theo H5 / H6 / H9b (oracle — không gọi helper), cùng số dòng kỳ vọng / tổng của từng
 *     bảng con (theo tập đó) và Product Master;
 * (2) SET LOCAL ROLE authenticated + claim ⇒ MỘT SELECT đo: RLS đang áp, vai không bypass, cờ super thật, tập id helper
 *     = tập kỳ vọng (so mảng, không chỉ đếm — db-reviewer vòng 2 P1), số dòng thấy từng bảng = kỳ vọng, dòng ngoài mảng
 *     helper = 0, quyền riêng tư / ghi / RPC.
 */
export function cmsVerifyV8Sql(userId: string, role: CmsV8Role): string {
  if (!isCmsUuid(userId)) throw new Error('CMS VERIFY V8: user id không hợp lệ')
  if (!CMS_V8_ROLES.includes(role)) throw new Error('CMS VERIFY V8: vai không hợp lệ')
  const childCount = (table: string) => `(SELECT count(*) FROM public.${table} x WHERE x.program_id = ANY (v_exp))`
  return `DO $cmsv8$
DECLARE
  v_uid uuid := '${userId}';
  v_decl text := '${role}';
  v_role text; v_store uuid; v_store_ok boolean; v_qa boolean; v_exp uuid[];
BEGIN
  SELECT u.role::text, u.store_id INTO v_role, v_store FROM public.users u WHERE u.id = v_uid;
  SELECT coalesce(bool_or(s.store_type = 'os' AND s.is_active), false) INTO v_store_ok FROM public.stores s WHERE s.id = v_store;
  SELECT EXISTS (SELECT 1 FROM public.cms_qa_access q WHERE q.user_id = v_uid AND q.expires_at > now()) INTO v_qa;
  IF v_decl = 'super' THEN
    SELECT coalesce(array_agg(p.id ORDER BY p.id), '{}'::uuid[]) INTO v_exp FROM public.cms_programs p WHERE NOT p.is_test OR v_qa;
  ELSIF v_decl = 'sm' THEN
    SELECT coalesce(array_agg(p.id ORDER BY p.id), '{}'::uuid[]) INTO v_exp FROM public.cms_programs p
     WHERE (NOT p.is_test OR v_qa) AND p.status = 'active'
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
  PERFORM set_config('cms_v8.exp_ids', v_exp::text, true);
  PERFORM set_config('cms_v8.exp_programs', cardinality(v_exp)::text, true);
  PERFORM set_config('cms_v8.exp_stores', ${childCount('cms_program_stores')}::text, true);
  PERFORM set_config('cms_v8.exp_products', ${childCount('cms_program_products')}::text, true);
  PERFORM set_config('cms_v8.exp_tiers', ${childCount('cms_program_tiers')}::text, true);
  PERFORM set_config('cms_v8.exp_import_runs', (CASE WHEN v_decl = 'super' THEN ${childCount('cms_import_runs')} ELSE 0 END)::text, true);
  PERFORM set_config('cms_v8.exp_master', (CASE WHEN v_decl = 'super' THEN (SELECT count(*) FROM public.cms_product_master) ELSE 0 END)::text, true);
${V8_TABLES.map(([k, t]) => `  PERFORM set_config('cms_v8.total_${k}', (SELECT count(*) FROM public.${t})::text, true);`).join('\n')}
END
$cmsv8$;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '${userId}';
SET LOCAL request.jwt.claims = '{"sub":"${userId}","role":"authenticated"}';
WITH h AS (SELECT public.cms_readable_program_ids() AS ids)
SELECT current_user::text AS role_now, auth.uid()::text AS uid, current_setting('transaction_read_only') AS ro,
       current_setting('transaction_isolation') AS iso,
       (SELECT r.rolsuper OR r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user) AS me_bypass,
       current_setting('cms_v8.runner_bypass')::boolean AS runner_bypass,
       current_setting('cms_v8.user_role') AS user_role,
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
       (SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
          AND left(p.proname, 8) = 'rpc_cms_' AND has_function_privilege(p.oid, 'EXECUTE')) AS rpc_callable`
}

/** Mục kiểm. `proven: false` = đạt về điều kiện nhưng CHƯA CHỨNG MINH (vd. dữ liệu chưa đủ để thấy RLS cắt bớt). */
export interface CmsVerifyCheck { id: string; ok: boolean; detail: string; proven?: boolean }

type Row = Record<string, unknown>

/**
 * Ma trận đã duyệt (120 hậu kiểm §7 + V4; 121 hậu kiểm + V2). ACL ngoài owner phải ĐÚNG chuỗi này (aclexplode).
 * `src` = md5 thân hàm (prosrc, bỏ \r) sinh từ file 120 / 121 THẬT trên PGlite; scripts/qa-cms-qa-tooling.mjs §1 (PGlite)
 * và planning/research/dev-tools/cms/qatool-realpg-verify.mjs (PostgreSQL 15) kiểm lại — bắt chạy nhầm bản migration cũ.
 */
export const CMS_FN_MATRIX: Record<string, { phase: '120' | '121'; acl: 'authenticated:EXECUTE' | 'service_role:EXECUTE' | null; secdef: boolean; lock: boolean; src: string }> = {
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
}

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
const CMS_TRIGGERS = [
  'CREATE TRIGGER cms_programs_guard BEFORE UPDATE ON cms_programs FOR EACH ROW EXECUTE FUNCTION cms__programs_guard()|O',
  'CREATE TRIGGER cms_qa_access_stamp BEFORE INSERT OR UPDATE ON cms_qa_access FOR EACH ROW EXECUTE FUNCTION cms__qa_access_stamp()|O',
].join(';')

export interface CmsAclSnapshot {
  db_now: unknown
  n_all: number; md5_all: string
  n_old: number; md5_old: string
  n_ex120: number; md5_ex120: string
  n_ex121: number; md5_ex121: string
}

export interface CmsVerifyInput {
  phase: '120' | '121'
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
}

const ms = (ts: unknown) => Date.parse(toIsoUtc(ts))

/** Đánh giá POST 120 / 121 — bám hậu kiểm trong transaction + khối VERIFY của migration. Mọi lệch ⇒ ok = false. */
export function evaluateCmsVerify(v: CmsVerifyInput): CmsVerifyCheck[] {
  const out: CmsVerifyCheck[] = []
  const add = (id: string, ok: boolean, detail: string) => out.push({ id, ok, detail })
  add('runner', v.whoami.bypass === true, `chạy bằng ${String(v.whoami.u)} (superuser / BYPASSRLS ${String(v.whoami.bypass)})`)

  const marker = new Map(v.markers.map((r) => [String(r.version), r]))
  add('marker-120', marker.get('120')?.name === 'cms_foundation', `120 = ${String(marker.get('120')?.name ?? 'THIẾU')}`)
  if (v.phase === '121') add('marker-121', marker.get('121')?.name === 'cms_import_activation', `121 = ${String(marker.get('121')?.name ?? 'THIẾU')}`)
  else add('marker-121-absent', !marker.has('121'), marker.has('121') ? '121 đã có' : '121 chưa chạy (đúng phase)')
  add('max-numeric', Number(v.maxNumeric.max_v) === Number(v.phase), `max số = ${String(v.maxNumeric.max_v)}`)

  // PRE đúng thứ tự (db-reviewer P2-3 / security P2-10): chụp TRƯỚC khi migration của phase ghi marker (và sau 120 khi phase 121).
  const applied = marker.get(v.phase)?.applied_at
  let preOk = false
  let preDetail = 'thiếu applied_at'
  try {
    const pre = ms(v.aclPre.db_now)
    const ap = applied !== undefined ? ms(applied) : NaN
    const ap120 = v.phase === '121' && marker.get('120')?.applied_at !== undefined ? ms(marker.get('120')!.applied_at) : null
    preOk = Number.isFinite(ap) && pre < ap && (ap120 === null || pre > ap120)
    preDetail = `PRE ${toIsoUtc(v.aclPre.db_now)} · ${v.phase} chạy ${Number.isFinite(ap) ? new Date(ap).toISOString() : '?'}${ap120 !== null ? ` · 120 chạy ${new Date(ap120).toISOString()}` : ''}`
  } catch { /* preOk false */ }
  add('pre-order', preOk, preDetail)

  // Hàm CMS: đúng tập theo phase, mỗi tên một chữ ký, ma trận ACL (aclexplode), SECDEF, config, owner bypass.
  const expected = Object.entries(CMS_FN_MATRIX).filter(([, m]) => v.phase === '121' || m.phase === '120').map(([n]) => n).sort()
  const got = [...new Set(v.functions.map((f) => String(f.name)))].sort()
  add('fn-set', JSON.stringify(got) === JSON.stringify(expected), `hàm cms: ${got.length} (kỳ vọng ${expected.length})${
    got.filter((n) => !expected.includes(n)).map((n) => ` LẠ:${n}`).join('')}${expected.filter((n) => !got.includes(n)).map((n) => ` THIẾU:${n}`).join('')}`)
  add('fn-overload', v.functions.length === got.length, `${v.functions.length} chữ ký / ${got.length} tên (không overload lạ)`)
  for (const f of v.functions) {
    const name = String(f.name)
    const m = CMS_FN_MATRIX[name]
    if (!m) continue
    const aclOk = f.acl_default === false && (f.acl_extra ?? null) === m.acl
    add(`fn-acl:${name}`, aclOk, `ACL ngoài owner ${String(f.acl_extra ?? '∅')}${f.acl_default ? ' (MẶC ĐỊNH — PUBLIC ngầm)' : ''} · kỳ vọng ${m.acl ?? '∅'}`)
    const execOk = f.anon_x === false && f.auth_x === (m.acl === 'authenticated:EXECUTE') && f.svc_x === (m.acl === 'service_role:EXECUTE')
    add(`fn-exec:${name}`, execOk, `EXECUTE anon ${String(f.anon_x)} · authenticated ${String(f.auth_x)} · service_role ${String(f.svc_x)}`)
    add(`fn-secdef:${name}`, f.secdef === m.secdef, `SECURITY DEFINER ${String(f.secdef)} (kỳ vọng ${m.secdef})`)
    const nConfig = 1 + (m.lock ? 1 : 0)
    add(`fn-config:${name}`, f.has_path === true && f.has_lock === m.lock && Number(f.n_config) === nConfig,
      `search_path=public ${String(f.has_path)} · lock_timeout=5s ${String(f.has_lock)} · ${String(f.n_config)} mục config (kỳ vọng ${nConfig})`)
    add(`fn-owner:${name}`, f.owner_bypass === true, `owner superuser / BYPASSRLS ${String(f.owner_bypass)}`)
    add(`fn-src:${name}`, f.src_md5 === m.src, `thân hàm md5 ${String(f.src_md5)}${f.src_md5 === m.src ? '' : ` · kỳ vọng ${m.src} (bản migration khác?)`}`)
  }

  // Policy: đúng 6, SELECT, PERMISSIVE, TO authenticated, qual đúng helper; không có ở sync_runs / qa_access.
  const polTables = v.policies.map((p) => String(p.t)).sort()
  add('policies', v.policies.length === 6 && JSON.stringify(polTables) === JSON.stringify(CMS_TABLES_READ)
    && v.policies.every((p) => p.cmd === 'SELECT' && p.roles === '{authenticated}' && p.permissive === 'PERMISSIVE' && (p.with_check ?? null) === null),
  `${v.policies.length} policy: ${polTables.join(',')}`)
  for (const p of v.policies) {
    const want = POLICY_QUAL[String(p.t)]
    const got = normalizeCmsQual(p.qual)
    add(`policy-qual:${String(p.t)}`, want !== undefined && got === want, `qual ${got.slice(0, 200)}${want !== undefined && got !== want ? ` · kỳ vọng ${want}` : ''}`)
  }
  const trg = v.triggers.map((t) => `${normalizeCmsQual(t.def)}|${String(t.enabled)}`).join(';')
  add('triggers', trg === CMS_TRIGGERS, `trigger: ${trg || '(không có)'}`)
  const shapes = new Map(v.tableShape.map((r) => [String(r.t), r]))
  for (const [t, want] of Object.entries(CMS_TABLE_SHAPE)) {
    const got = shapes.get(t)
    add(`table-shape:${t}`, !!got && got.con_md5 === want.con && got.idx_md5 === want.idx,
      `ràng buộc ${String(got?.con_md5 ?? 'THIẾU')} · index ${String(got?.idx_md5 ?? 'THIẾU')}`)
  }

  // Bảng: 8 bảng RLS; đủ 7 quyền: anon ∅; authenticated đúng SELECT ở 6 bảng; service_role đủ 7; 0 quyền theo cột lọt.
  const tnames = v.tables.map((t) => String(t.t)).sort()
  add('tables', JSON.stringify(tnames) === JSON.stringify([...CMS_TABLES_READ, ...CMS_TABLES_NO_AUTH].sort()), `${tnames.length} bảng cms_*`)
  const all7 = TABLE_PRIVS.join(',')
  for (const t of v.tables) {
    const name = String(t.t)
    const wantAuth = CMS_TABLES_READ.includes(name) ? 'SELECT' : null
    const ok = t.rls === true && (t.anon_p ?? null) === null && (t.auth_p ?? null) === wantAuth && t.svc_p === all7 && Number(t.col_leaks) === 0
    add(`table:${name}`, ok, `rls ${String(t.rls)} · anon ${String(t.anon_p ?? '∅')} · authenticated ${String(t.auth_p ?? '∅')} · service_role ${String(t.svc_p ?? '∅')} · cột lọt ${String(t.col_leaks)}`)
  }

  add('roles', v.roles.length === 2 && v.roles.every((r) => r.su === false && r.bypass === false),
    v.roles.map((r) => `${String(r.r)} super ${String(r.su)} bypass ${String(r.bypass)}`).join(' · '))

  const idx = v.oneRunningIndex.map((r) => String(r.indexdef))
  add('index-one-running', idx.length === 1 && /UNIQUE INDEX/.test(idx[0]) && /NULLS NOT DISTINCT/.test(idx[0]) && /status = 'running'/.test(idx[0]),
    idx[0] ?? 'THIẾU')

  // ACL: (1) hàm ngoài cms = PRE (V6 120 / V3 121); (2) mọi hàm có trước phase (kể cả 7 hàm 120 khi chạy 121) = PRE.
  add('acl-old-functions', v.aclPost.n_old === v.aclPre.n_old && v.aclPost.md5_old === v.aclPre.md5_old,
    `hàm ngoài cms ${v.aclPost.n_old} / ${v.aclPost.md5_old} · PRE ${v.aclPre.n_old} / ${v.aclPre.md5_old}`)
  const nEx = v.phase === '120' ? v.aclPost.n_ex120 : v.aclPost.n_ex121
  const mdEx = v.phase === '120' ? v.aclPost.md5_ex120 : v.aclPost.md5_ex121
  add('acl-preexisting-functions', nEx === v.aclPre.n_all && mdEx === v.aclPre.md5_all,
    `mọi hàm có trước ${v.phase}: ${nEx} / ${mdEx} · PRE ${v.aclPre.n_all} / ${v.aclPre.md5_all}`)

  if (v.phase === '121') {
    const inv = v.inv121
    add('inv121-overlap', !!inv && inv.overlap.length === 0, `${inv?.overlap.length ?? 'THIẾU'} cặp trùng ProductID`)
    add('inv121-tiers', !!inv && inv.tiers.length === 0, `${inv?.tiers.length ?? 'THIẾU'} bậc sai`)
    add('inv121-catalog', !!inv && inv.catalog.length === 0, `${inv?.catalog.length ?? 'THIẾU'} chương trình thiếu target danh mục`)
    add('isolation', !!v.isolation && v.isolation.iso === 'read committed' && Number(v.isolation.overrides) === 0,
      `${String(v.isolation?.iso)} · ${String(v.isolation?.overrides)} thiết lập đè (role / DB)`)
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

export function evaluateCmsV8(
  row: Row, userId: string, role: CmsV8Role,
  expect: { qa?: boolean; readable?: number; requireProven?: readonly string[] } = {},
): CmsVerifyCheck[] {
  const out: CmsVerifyCheck[] = []
  const add = (id: string, ok: boolean, detail: string, proven?: boolean) => out.push(proven === undefined ? { id, ok, detail } : { id, ok, detail, proven })
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
  add('v8-private', row.read_qa_access === false && row.read_sync_runs === false && row.write_programs === false && row.rpc_callable === 0,
    `cms_qa_access ${String(row.read_qa_access)} · cms_sync_runs ${String(row.read_sync_runs)} · ghi ${String(row.write_programs)} · rpc_cms_* ${String(row.rpc_callable)}`)
  if (expect.qa !== undefined) add('v8-expect-qa', row.qa === expect.qa, `marker ${String(row.qa)} (kỳ vọng ${expect.qa})`)
  if (expect.readable !== undefined) add('v8-expect-readable', row.readable === expect.readable, `đọc được ${String(row.readable)} (kỳ vọng ${expect.readable})`)
  // Gate D3 (runbook): bảng được yêu cầu phải CHỨNG MINH RLS cắt (tổng > kỳ vọng) — CHƯA ⇒ đỏ (db-reviewer vòng 3 P2-C).
  for (const k of expect.requireProven ?? []) {
    const t = out.find((c) => c.id === `v8-table:${k}`)
    add(`v8-require-proven:${k}`, !!t && t.ok && t.proven === true, t ? (t.proven ? 'đã chứng minh RLS cắt' : 'CHƯA chứng minh (tổng = kỳ vọng)') : 'bảng không hợp lệ')
  }
  return out
}
