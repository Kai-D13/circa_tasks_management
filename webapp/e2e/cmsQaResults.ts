// CMS — QA KẾT QUẢ trên DB production bằng dữ liệu bán GIẢ, có gate (PM 03/11 review I4/P3/runbook REL-P1-1; quyết định
// operator: QA trên prod dùng bán giả gắn tài khoản QA, đối soát nguồn thật làm offline). Phần THUẦN — không IO / mạng /
// secret; script scripts/cms-qa-results.mjs (writer) và scripts/cms-qa-run.mjs (close) nạp file này qua jiti; test:
// e2e/cms-qa-results.spec.ts + scripts/qa-cms-qa-results-cli.mjs.
//
// Writer chỉ chạy BÊN TRONG run QA đang mở của launcher (manifest .qa-cms.json): xác nhận runId + host + candidate (HEAD /
// tree sạch = manifest) + launcher còn sống (cổng + pid) + chương trình is_test thuộc run + marker mọi tài khoản QA còn ≥
// ngưỡng canh. Kiểm lại trước MỖI bước ghi (open / stage / seal / publish / cleanup) — mất điều kiện ⇒ CMS_QA_GUARD_LOST:
// lõi đóng run error (finish = đường thu hồi lỗi tối thiểu, không công bố), pointer giữ nguyên.
// Nguồn bán giả: sinh TẤT ĐỊNH từ snapshot chương trình + tài khoản staff QA chọn rõ (email lấy từ snapshot, KHÔNG in);
// mã dòng / đơn có tiền tố QA- (không giả mạo giao dịch nguồn thật); không bao giờ là fallback của cron / app production.
// Sổ writer (qa-artifacts/cms-qa/<runId>.writers/<writerId>.json, ghi độc quyền + atomic) cho close đối chiếu: writer còn
// chạy / không rõ kết thúc ⇒ close từ chối; mọi run sales QA trong cửa sổ phải đi qua writer; run sales của chương trình
// thật trong cửa sổ ⇒ ĐỎ khi Q-206 HOLD.

import type { CmsQaRunManifest, CmsQaStatusRow } from './cmsQaTooling'
import { cmsCanPublishResults } from '../lib/cms/releaseGate'
import { CMS_DEC_FACTOR, formatCmsDecimal, parseCmsDecimal } from '../lib/cms/decimal'
import type { CmsSalesSyncDeps } from '../lib/cms/salesSync'
import type { CmsRawRow } from '../lib/cms/source/contract'
import { formatUtcMicros, isCmsIsoDate, parseUtcMicros } from '../lib/cms/time'
import { cmsLockEnabledFromEnv } from '../lib/cms/flags'
import { cmsNormalizeAck } from '../lib/cms/payoutView'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/
const RUN_ID_RE = /^cms-qa-[0-9A-Za-z]{8,20}-[0-9a-f]{4}$/
const WRITER_ID_RE = /^w-[0-9a-f]{12}$/
const mask = (id: string) => (UUID_RE.test(id) ? `${id.slice(0, 8)}…` : '—')

/** `detail.source` của run sales do writer mở (lib/cms/salesSync.ts CmsSalesSyncOpts.source). */
export const CMS_QA_WRITER_SOURCE = 'qa' as const
/** Tên view giả (chỉ để qua kiểm tên FQN của adapter — runner giả không đọc SQL, không có BigQuery). */
export const CMS_QA_FAKE_TABLE = 'qa-fake-source.cms_qa.fake_sales'
export const CMS_QA_FAKE_PREFIX = 'QA-'
/** Email KHÔNG thuộc tài khoản nào (miền .invalid — RFC 2606) cho nhóm "Chưa gán" NOT_FOUND. */
export const CMS_QA_FAKE_UNKNOWN_EMAIL = 'qa-not-found@example.invalid'
export const CMS_QA_WRITER_MAX_LINES_PER_STAFF = 500
export const CMS_QA_WRITER_MAX_STAFF = 10
/** Ngân sách một lượt writer (cùng ngân sách cron một lượt). */
export const CMS_QA_WRITER_BUDGET_MS = 240_000
export const CMS_QA_GUARD_LOST = 'CMS_QA_GUARD_LOST'
/** Ngân sách làm việc không còn đủ trước / sau guard ⇒ không bắt đầu bước ghi. */
export const CMS_QA_GUARD_DEADLINE = 'CMS_QA_GUARD_DEADLINE'
/** Không ghi được sổ writer ngay sau openRun ⇒ dừng trước stage (run còn running ⇒ reconcile). */
export const CMS_QA_LEDGER_FAILED = 'CMS_QA_LEDGER_FAILED'

// ── Nguồn bán giả ────────────────────────────────────────────────────────────

export interface CmsQaFakeInput {
  /** runId của manifest — vào tiền tố mã dòng (truy vết, không đụng mã thật). */
  qaRunId: string
  startDate: string
  endDate: string
  /** Ngày VN hôm nay theo DB (snapshot.todayVn) — không sinh đơn tương lai. */
  todayVn: string
  products: readonly { productId: string; baseQuantityCms: string }[]
  /** Tài khoản staff QA đã chọn rõ: email lấy từ snapshot (không in, không ghi file). */
  staff: readonly { id: string; email: string }[]
  linesPerStaff: number
  /** Thêm 2 dòng "Chưa gán": không email + email không tồn tại. */
  unassigned: boolean
}

/** Bội số K (× 1/2) theo vòng: 1 đơn vị · nửa · 2 · 1,5 · 3 — có dòng lẻ cộng dồn và dòng nguyên. */
const HALVES = [2, 1, 4, 3, 6]

export function cmsQaFakeSalesRows(i: CmsQaFakeInput): CmsRawRow[] {
  if (!RUN_ID_RE.test(i.qaRunId)) throw new Error('qaRunId không hợp lệ')
  if (!isCmsIsoDate(i.startDate) || !isCmsIsoDate(i.endDate) || !isCmsIsoDate(i.todayVn) || i.endDate < i.startDate) throw new Error('kỳ không hợp lệ')
  const lastDay = i.endDate < i.todayVn ? i.endDate : i.todayVn
  if (lastDay < i.startDate) throw new Error('chương trình chưa bắt đầu — không có ngày để sinh đơn')
  if (i.products.length === 0) throw new Error('chương trình chưa có sản phẩm')
  if (i.staff.length === 0 || i.staff.length > CMS_QA_WRITER_MAX_STAFF) throw new Error('số tài khoản staff QA không hợp lệ')
  if (!Number.isInteger(i.linesPerStaff) || i.linesPerStaff < 1 || i.linesPerStaff > CMS_QA_WRITER_MAX_LINES_PER_STAFF) throw new Error('lines-per-staff không hợp lệ')
  const day0 = parseUtcMicros(`${i.startDate}T00:00:00Z`)!
  const dayN = parseUtcMicros(`${lastDay}T00:00:00Z`)!
  const DAY = BigInt(86_400_000_000)
  const days = Number((dayN - day0) / DAY) + 1
  const tag = i.qaRunId.slice(-4)
  const ks = i.products.map((p) => {
    const k = parseCmsDecimal(p.baseQuantityCms)
    if (!k.ok || k.units <= BigInt(0)) throw new Error('base_quantity_CMS không hợp lệ')
    return k.units
  })
  const rows: CmsRawRow[] = []
  const at = (dayIdx: number, seq: number) => {
    // 02:00 UTC (= 09:00 VN) + seq giây + seq micro giây ⇒ thứ tự xác định, trong ngày VN đã chọn.
    const t = day0 + BigInt(dayIdx) * DAY + BigInt(2 * 3600) * BigInt(1_000_000) + BigInt(seq) * BigInt(1_000_001)
    return formatUtcMicros(t)
  }
  let seq = 0
  i.staff.forEach((s, si) => {
    for (let j = 0; j < i.linesPerStaff; j++) {
      const pi = (j + si) % i.products.length
      const units = (ks[pi] * BigInt(HALVES[j % HALVES.length])) / BigInt(2)
      const base = units > BigInt(0) ? units : BigInt(1)
      // GMV giả: 10.000–70.000 đ / dòng (số nguyên), đủ để có SP đạt / chưa đạt target tùy cấu hình QA.
      const gmv = BigInt(10_000 * ((j % 7) + 1)) * CMS_DEC_FACTOR
      const when = at((j + si) % days, seq++)
      rows.push({
        order_line_id: `${CMS_QA_FAKE_PREFIX}${tag}-${si}-${j}`,
        order_id: `${CMS_QA_FAKE_PREFIX}O-${tag}-${si}-${Math.floor(j / 2)}`,
        order_code: `${CMS_QA_FAKE_PREFIX}${tag}-${si}-${Math.floor(j / 2)}`,
        product_id: i.products[pi].productId,
        seller_email: s.email,
        pos_code: 'QA',
        // Một dòng / 11 là ONLINE ⇒ kiểm nhánh loại (không ứng viên).
        order_type: j % 11 === 10 ? 'ONLINE' : 'OFFLINE',
        order_status: 'COMPLETED',
        completed_at: when,
        quantity_raw: formatCmsDecimal(base),
        uom_raw: 'QA',
        base_quantity: formatCmsDecimal(base),
        gmv_amount: formatCmsDecimal(gmv),
        source_updated_at: when,
      })
    }
  })
  if (i.unassigned) {
    for (const [n, email] of [[0, null], [1, CMS_QA_FAKE_UNKNOWN_EMAIL]] as const) {
      const when = at(n % days, seq++)
      rows.push({
        order_line_id: `${CMS_QA_FAKE_PREFIX}${tag}-u-${n}`, order_id: `${CMS_QA_FAKE_PREFIX}O-${tag}-u-${n}`,
        order_code: `${CMS_QA_FAKE_PREFIX}${tag}-u-${n}`, product_id: i.products[0].productId, seller_email: email,
        pos_code: 'QA', order_type: 'OFFLINE', order_status: 'COMPLETED', completed_at: when, quantity_raw: '1', uom_raw: 'QA',
        base_quantity: formatCmsDecimal(ks[0]), gmv_amount: '10000', source_updated_at: when,
      })
    }
  }
  return rows
}

// ── Preflight writer ─────────────────────────────────────────────────────────

export function parseCmsQaStaffIds(raw: string | undefined): { ok: true; value: string[] } | { ok: false; reason: string } {
  if (!raw) return { ok: false, reason: 'thiếu --staff=<uuid staff QA,…>' }
  const ids = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (ids.length === 0 || ids.length > CMS_QA_WRITER_MAX_STAFF) return { ok: false, reason: `--staff cần 1…${CMS_QA_WRITER_MAX_STAFF} UUID` }
  if (!ids.every((id) => UUID_RE.test(id)) || new Set(ids).size !== ids.length) return { ok: false, reason: '--staff có UUID sai / trùng' }
  return { ok: true, value: ids }
}

export function parseCmsQaLinesPerStaff(raw: string | undefined): { ok: true; value: number } | { ok: false; reason: string } {
  if (raw === undefined) return { ok: true, value: 30 }
  const n = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n < 1 || n > CMS_QA_WRITER_MAX_LINES_PER_STAFF) return { ok: false, reason: `--lines-per-staff phải là số nguyên 1…${CMS_QA_WRITER_MAX_LINES_PER_STAFF}` }
  return { ok: true, value: n }
}

/**
 * Điều kiện cục bộ (không DB) để writer được chạy trong run đang mở: xác nhận đúng runId, host = manifest, run có server
 * (launcher QA tay — chế độ có canh marker) và launcher còn sống, cây sạch + HEAD / tree = candidate của run, staff chọn
 * là tài khoản QA vai staff của run.
 */
export interface CmsQaRunLocalInput {
  manifest: CmsQaRunManifest | null
  confirmRun: string | undefined
  host: string | null
  treeClean: boolean
  gitHead: string
  gitTree: string
  launcherAlive: boolean
}

export function cmsQaWriterLocalCheck(i: CmsQaRunLocalInput & { staffIds: readonly string[] }): { ok: true } | { ok: false; reasons: string[] } {
  const base = cmsQaRunLocalReasons(i)
  if (base === null) return { ok: false, reasons: ['không có run QA đang mở'] }
  const m = i.manifest as CmsQaRunManifest
  const reasons = [...base]
  const qaStaff = new Set(m.users.filter((u) => u.role === 'staff').map((u) => u.id))
  for (const id of i.staffIds) if (!qaStaff.has(id)) reasons.push(`${mask(id)} không phải tài khoản QA vai staff của run`)
  if (i.staffIds.length === 0) reasons.push('chưa chọn tài khoản staff QA')
  return reasons.length ? { ok: false, reasons } : { ok: true }
}

/** Điều kiện cục bộ chung của mọi lệnh GHI trong run (writer kết quả, thao tác chốt). null ⇒ không có run mở. */
function cmsQaRunLocalReasons(i: CmsQaRunLocalInput): string[] | null {
  const m = i.manifest
  const reasons: string[] = []
  if (!m || m.status !== 'open') return null
  if (!i.confirmRun) reasons.push(`thiếu --confirm-run=<runId> (run đang mở: ${m.runId}) — gõ lại runId để xác nhận ghi`)
  else if (i.confirmRun !== m.runId) reasons.push(`--confirm-run (${i.confirmRun}) khác run đang mở (${m.runId})`)
  if (!i.host || i.host !== m.host) reasons.push(`host hiện tại (${i.host ?? '—'}) khác host của run (${m.host})`)
  if (m.mode !== 'manual-localhost' || m.port === null) reasons.push('run không có server QA (--no-server / automated) — writer chỉ chạy trong run launcher có canh marker')
  const launcherPid = (m as CmsQaRunManifest & { launcherPid?: unknown }).launcherPid
  if (!Number.isInteger(launcherPid) || (launcherPid as number) <= 0) reasons.push('manifest không ghi launcherPid (launcher cũ) — mở run mới bằng launcher hiện hành')
  if (m.serverNotStopped) reasons.push('launcher đã ghi server CHƯA DỪNG — run không còn hợp lệ cho ghi mới')
  else if (!i.launcherAlive) reasons.push('launcher / server QA của run không còn chạy (pid launcher, pid server hoặc cổng) — canh marker không còn hiệu lực, không ghi')
  if (!i.treeClean) reasons.push('cây Git không sạch — writer phải chạy trên đúng candidate của run')
  if (i.gitHead !== m.gitHead || i.gitTree !== m.gitTree) reasons.push('HEAD / tree hiện tại khác candidate của run')
  return reasons
}

/** Chương trình + mốc run (một câu SELECT chỉ đọc). */
export function cmsQaWriterProgramSql(programId: string, startedAt: string, userIds: readonly string[]): string {
  if (!UUID_RE.test(programId)) throw new Error('programId không phải UUID')
  if (!ISO_UTC_RE.test(startedAt) || Number.isNaN(Date.parse(startedAt))) throw new Error('startedAt không hợp lệ')
  if (userIds.length === 0 || !userIds.every((u) => UUID_RE.test(u)) || new Set(userIds).size !== userIds.length) throw new Error('userIds không hợp lệ')
  return `SELECT p.id::text AS id, p.is_test, p.status,
       (p.created_by = ANY('{${userIds.join(',')}}'::uuid[]) AND p.created_at >= '${startedAt}'::timestamptz) AS qa_created_in_run
  FROM public.cms_programs p WHERE p.id = '${programId}'::uuid`
}

export interface CmsQaWriterProgramRow { id: string; is_test: boolean; status: string; qa_created_in_run: boolean }

/**
 * Điều kiện DB trước MỖI bước ghi: chương trình is_test, active, thuộc run (ghi trong manifest hoặc do tài khoản QA của run
 * tạo sau mốc run); marker MỌI tài khoản QA của run còn ≥ ngưỡng canh (cùng ngưỡng launcher).
 */
export function cmsQaWriterDbCheck(i: {
  manifest: CmsQaRunManifest
  programId: string
  programRows: readonly CmsQaWriterProgramRow[]
  statusRows: readonly CmsQaStatusRow[]
  guardMinutes: number
}): { ok: true } | { ok: false; reasons: string[] } {
  const reasons: string[] = []
  const p = i.programRows.find((r) => r.id === i.programId)
  if (!p) reasons.push(`${mask(i.programId)}: không có chương trình`)
  else {
    if (p.is_test !== true) reasons.push(`${mask(i.programId)}: chương trình THẬT (is_test = false) — CẤM ghi kết quả QA`)
    if (p.status !== 'active') reasons.push(`${mask(i.programId)}: chương trình chưa kích hoạt / đã chốt (${p.status})`)
    const inManifest = i.manifest.programs.some((x) => x.id === i.programId)
    if (!inManifest && p.qa_created_in_run !== true) reasons.push(`${mask(i.programId)}: không thuộc run (không ghi trong manifest, không do tài khoản QA của run tạo sau mốc run)`)
  }
  const byId = new Map(i.statusRows.map((r) => [r.user_id, r]))
  for (const u of i.manifest.users) {
    const r = byId.get(u.id)
    if (!r || !r.user_exists) reasons.push(`${mask(u.id)}: không đọc được tài khoản QA`)
    else if (!r.active) reasons.push(`${mask(u.id)}: marker QA không còn hạn`)
    else if (!Number.isInteger(r.remaining_s) || r.remaining_s < i.guardMinutes * 60) reasons.push(`${mask(u.id)}: marker còn ${Math.floor((r.remaining_s || 0) / 60)} phút < ngưỡng canh ${i.guardMinutes} phút`)
  }
  return reasons.length ? { ok: false, reasons } : { ok: true }
}

/** Đồng hồ ngân sách của writer: cùng mốc làm việc với lõi (deadlineAt − CMS_SALES_STOP_RESERVE_MS), đồng hồ đơn điệu. */
export interface CmsQaGuardClock { now(): number; workUntil: number; minStartMs: number }

/**
 * Đồng hồ đơn điệu của writer theo thang epoch ms, số NGUYÊN (floor — vẫn không giảm): mọi hiệu thời gian / timeout tính từ
 * nó là số nguyên. Node từ chối `AbortSignal.timeout(số lẻ)` (ERR_OUT_OF_RANGE) — PM r2 §3.
 */
export function cmsQaMonoClock(perf: { timeOrigin: number; now(): number } = performance): () => number {
  return () => Math.floor(perf.timeOrigin + perf.now())
}

/** Timeout I/O = số nguyên hữu hạn, max(sàn, floor(min(muốn, còn lại))) — không vượt phần còn lại khi còn lại ≥ sàn; NaN ⇒ ném. */
export function cmsQaIoTimeoutMs(wantMs: number, remainMs: number, floorMs = 1): number {
  const v = Math.floor(Math.min(wantMs, remainMs))
  if (!Number.isFinite(v)) throw new Error(CMS_QA_GUARD_DEADLINE)
  return Math.max(floorMs, v)
}

/**
 * Bọc các bước GHI của deps lõi (PM 03/11 QA-P1-1 / QA-P1-2):
 *  · trước open / stage / seal / publish / cleanup: hết ngân sách ⇒ CMS_QA_GUARD_DEADLINE (không ghi); gọi `guard(step,
 *    ngânSáchCònLạiMs)` — guard ném ⇒ CMS_QA_GUARD_LOST (không ghi); guard tiêu hết ngân sách ⇒ CMS_QA_GUARD_DEADLINE;
 *  · timeout của bước ghi TÍNH LẠI sau guard (min(timeout lõi, phần còn lại tới mốc làm việc)) — không dùng timeout cũ;
 *  · openRun: gắn `qa_run_id` + `qa_writer_id` vào detail của run (liên kết run ↔ writer cho close / reconcile — chống nhầm
 *    thao tác, không phải chữ ký chống giả mạo service_role); nhận `run_id` ⇒ `onOpened` ghi sổ NGAY; ghi sổ lỗi ⇒
 *    CMS_QA_LEDGER_FAILED (lõi dừng trước stage; run còn running ⇒ reconcile thu hồi theo liên kết).
 * Lõi đóng run error khi bước sau open ném (finish không bọc — đường thu hồi lỗi tối thiểu, không công bố); pointer giữ.
 */
export function cmsQaGuardedDeps<D extends Pick<CmsSalesSyncDeps, 'openRun' | 'stage' | 'sealBegin' | 'sealStep' | 'publish' | 'cleanup'>>(
  deps: D, guard: (step: string, budgetMs: number) => Promise<void>,
  opts: { clock: CmsQaGuardClock; tag?: { qaRunId: string; writerId: string }; onOpened?: (runId: string) => Promise<void> },
): D {
  const { clock } = opts
  const left = () => clock.workUntil - clock.now()
  const wrap = <K extends 'openRun' | 'stage' | 'sealBegin' | 'sealStep' | 'publish' | 'cleanup'>(k: K): D[K] => {
    const orig = deps[k] as unknown as (...a: unknown[]) => Promise<unknown>
    return (async (...a: unknown[]) => {
      if (left() < clock.minStartMs) throw new Error(CMS_QA_GUARD_DEADLINE)
      try { await guard(k, left()) } catch { throw new Error(CMS_QA_GUARD_LOST) }
      const remain = left()
      if (remain < clock.minStartMs) throw new Error(CMS_QA_GUARD_DEADLINE)
      const io = a[a.length - 1] as { timeoutMs: number }
      a[a.length - 1] = { ...io, timeoutMs: cmsQaIoTimeoutMs(io.timeoutMs, remain) }
      if (k === 'openRun' && opts.tag) a[1] = { ...(a[1] as object), qa_run_id: opts.tag.qaRunId, qa_writer_id: opts.tag.writerId }
      const out = await orig(...a)
      if (k === 'openRun' && opts.onOpened) {
        const id = (out as { run_id?: unknown } | null)?.run_id
        if (typeof id === 'string') {
          try { await opts.onOpened(id) } catch { throw new Error(CMS_QA_LEDGER_FAILED) }
        }
      }
      return out
    }) as unknown as D[K]
  }
  return { ...deps, openRun: wrap('openRun'), stage: wrap('stage'), sealBegin: wrap('sealBegin'), sealStep: wrap('sealStep'), publish: wrap('publish'), cleanup: wrap('cleanup') }
}

/**
 * Marker còn hạn theo lần đọc DB, trừ BẢO THỦ thời gian từ LÚC BẮT ĐẦU đọc tới bây giờ (DB đo remaining_s ở một thời điểm
 * sau lúc bắt đầu request) — không coi phản hồi cũ như vừa đo (PM 03/11 QA-P1-1, cùng nguyên tắc watchdog r3).
 */
export function cmsQaAgeStatusRows(rows: readonly CmsQaStatusRow[], elapsedMs: number): CmsQaStatusRow[] {
  const s = Math.ceil(Math.max(0, elapsedMs) / 1000)
  return rows.map((r) => ({ ...r, remaining_s: Number.isInteger(r.remaining_s) ? r.remaining_s - s : r.remaining_s }))
}

// ── Sổ writer ────────────────────────────────────────────────────────────────

/** Kết quả lõi KHÔNG xác định được run đã / chưa ghi gì ⇒ sổ `unknown`, close đòi reconcile. */
export const CMS_QA_UNKNOWN_CODES: ReadonlySet<string> = new Set(['OPEN_FAILED', 'PUBLISH_UNKNOWN', 'CLOSE_FAILED', 'INTERNAL', CMS_QA_LEDGER_FAILED])

export interface CmsQaWriterEntry {
  kind: 'cms-qa-writer'
  version: 1
  writerId: string
  qaRunId: string
  pid: number
  programId: string
  staff: string[]
  lines: number
  startedAt: string
  status: 'running' | 'done' | 'unknown' | 'reconciled'
  /** run_id nhận được từ openRun — ghi NGAY khi nhận (trước stage). */
  openedRunId: string | null
  finishedAt: string | null
  result: {
    status: string; code: string | null; runId: string | null; stagedRows: number; rowsRead: number | null
    candidates: number | null; included: number | null; unassigned: number | null
    /** Dòng lớp nguồn (124) đã stage; null = không capture. Sổ cũ không có khoá này. */
    sourceRows?: number | null
  } | null
  /** reconcile: run sales LIÊN KẾT với writer (detail.qa_writer_id) trong DB lúc đối chiếu. */
  reconcile?: { at: string; runs: { id: string; status: string; errorCode: string | null }[]; finishedOrphan: string | null } | null
}

export function newCmsQaWriterEntry(i: { writerId: string; qaRunId: string; pid: number; programId: string; staff: readonly string[]; lines: number; now: string }): CmsQaWriterEntry {
  if (!WRITER_ID_RE.test(i.writerId) || !RUN_ID_RE.test(i.qaRunId) || !UUID_RE.test(i.programId) || !Number.isInteger(i.pid) || i.pid <= 0) throw new Error('mục sổ writer không hợp lệ')
  return {
    kind: 'cms-qa-writer', version: 1, writerId: i.writerId, qaRunId: i.qaRunId, pid: i.pid, programId: i.programId,
    staff: [...i.staff], lines: i.lines, startedAt: i.now, status: 'running', openedRunId: null, finishedAt: null, result: null,
  }
}

/** Trạng thái sổ sau khi lõi trả kết quả: mã không xác định ⇒ `unknown`. */
export function cmsQaWriterOutcome(r: { status: string; code: string | null }): 'done' | 'unknown' {
  return r.code !== null && CMS_QA_UNKNOWN_CODES.has(r.code) ? 'unknown' : 'done'
}

export function parseCmsQaWriterEntry(text: string): { ok: true; value: CmsQaWriterEntry } | { ok: false; reason: string } {
  let o: Partial<CmsQaWriterEntry>
  try { o = JSON.parse(text) } catch { return { ok: false, reason: 'không phải JSON' } }
  if (!o || o.kind !== 'cms-qa-writer' || o.version !== 1) return { ok: false, reason: 'sai loại / phiên bản' }
  if (typeof o.writerId !== 'string' || !WRITER_ID_RE.test(o.writerId)) return { ok: false, reason: 'writerId sai' }
  if (typeof o.qaRunId !== 'string' || !RUN_ID_RE.test(o.qaRunId)) return { ok: false, reason: 'qaRunId sai' }
  if (typeof o.programId !== 'string' || !UUID_RE.test(o.programId)) return { ok: false, reason: 'programId sai' }
  if (!Number.isInteger(o.pid) || (o.pid as number) <= 0) return { ok: false, reason: 'pid sai' }
  if (!['running', 'done', 'unknown', 'reconciled'].includes(o.status as string)) return { ok: false, reason: 'trạng thái sai' }
  if (o.openedRunId !== null && o.openedRunId !== undefined && !(typeof o.openedRunId === 'string' && UUID_RE.test(o.openedRunId))) return { ok: false, reason: 'openedRunId sai' }
  return { ok: true, value: { ...o, openedRunId: o.openedRunId ?? null } as CmsQaWriterEntry }
}

/** Sổ writer có biết run này không (run mở, kết quả cuối, hoặc đối chiếu khi reconcile). */
export function cmsQaWriterKnowsRun(e: CmsQaWriterEntry, runId: string): boolean {
  return e.openedRunId === runId || e.result?.runId === runId || (e.reconcile?.runs ?? []).some((x) => x.id === runId)
}

/**
 * Close: writer còn chạy (pid sống), không rõ kết thúc (running + pid chết, hoặc `unknown`) ⇒ từ chối, chỉ reconcile mới
 * gỡ. Sổ hỏng / thuộc run khác / sai tên ⇒ từ chối (không tự bỏ qua).
 */
export function cmsQaWritersCloseCheck(
  qaRunId: string, files: readonly { name: string; text: string }[], pidAlive: (pid: number) => boolean,
): { reasons: string[]; entries: CmsQaWriterEntry[] } {
  const reasons: string[] = []
  const entries: CmsQaWriterEntry[] = []
  const rec = (id: string) => `chạy \`node scripts/cms-qa-results.mjs reconcile --writer=${id}\``
  for (const f of files) {
    const p = parseCmsQaWriterEntry(f.text)
    if (!p.ok) { reasons.push(`sổ writer ${f.name} hỏng (${p.reason}) — không xoá tay; báo PM / operator`); continue }
    const e = p.value
    if (e.qaRunId !== qaRunId) { reasons.push(`sổ writer ${e.writerId} thuộc run khác (${e.qaRunId})`); continue }
    if (`${e.writerId}.json` !== f.name) { reasons.push(`sổ writer ${f.name} sai tên file`); continue }
    if (e.status === 'running') {
      if (pidAlive(e.pid)) reasons.push(`writer ${e.writerId} (pid ${e.pid}) CÒN CHẠY — chờ xong rồi mới close`)
      else reasons.push(`writer ${e.writerId} (pid ${e.pid}) không rõ kết thúc — ${rec(e.writerId)}`)
    } else if (e.status === 'unknown') {
      reasons.push(`writer ${e.writerId} kết thúc KHÔNG RÕ (${e.result?.code ?? '—'}; run có thể đã ghi / công bố) — ${rec(e.writerId)}`)
    }
    entries.push(e)
  }
  return { reasons, entries }
}

// ── Run sales trong cửa sổ run QA ────────────────────────────────────────────

export function cmsQaRunSalesRunsSql(startedAt: string): string {
  if (!ISO_UTC_RE.test(startedAt) || Number.isNaN(Date.parse(startedAt))) throw new Error('startedAt không hợp lệ')
  return `SELECT r.id::text AS id, r.program_id::text AS program_id, r.is_test, r.status, r.detail ->> 'source' AS source, r.error_code,
       r.detail ->> 'qa_run_id' AS qa_run_id, r.detail ->> 'qa_writer_id' AS qa_writer_id
  FROM public.cms_sync_runs r WHERE r.kind = 'sales' AND r.started_at >= '${startedAt}'::timestamptz ORDER BY r.started_at, r.id`
}

export interface CmsQaSalesRunRow {
  id: string; program_id: string; is_test: boolean; status: string; source: string | null; error_code: string | null
  qa_run_id?: string | null; qa_writer_id?: string | null
}

/**
 * Đối chiếu run sales mở trong cửa sổ run QA (so theo RUN + liên kết writer — security review P1-2, PM QA-P1-2):
 *  · chương trình THẬT: do writer QA (source / qa_writer_id) ⇒ ĐỎ; khi Q-206 HOLD mọi run thật ⇒ ĐỎ; cổng mở ⇒ cảnh báo
 *    (cron thật), cần --ack-warnings;
 *  · run QA `running` ⇒ ĐỎ;
 *  · run QA hợp lệ CHỈ KHI source = 'qa', qa_run_id = run QA này, qa_writer_id là writer có sổ, và sổ của đúng writer đó
 *    biết run (openedRunId / result.runId / reconcile). Thiếu liên kết ⇒ ĐỎ — không tự nhận run chỉ vì cùng chương trình /
 *    cùng source. Liên kết là nhãn trong p_detail: chống sai sót thao tác, không phải chữ ký chống giả mạo service_role.
 */
export function cmsQaSalesRunsCheck(
  rows: readonly CmsQaSalesRunRow[], writers: readonly CmsQaWriterEntry[], opts: { qaRunId: string; releaseOpen?: boolean },
): { reasons: string[]; warningProgramIds: string[]; runs: { id: string; programId: string; isTest: boolean; status: string; source: string | null; errorCode: string | null; writerId: string | null }[] } {
  const releaseOpen = opts.releaseOpen ?? cmsCanPublishResults(false)
  const byWriter = new Map(writers.map((w) => [w.writerId, w]))
  const reasons: string[] = []
  const warn = new Set<string>()
  for (const r of rows) {
    const fromQa = r.source === CMS_QA_WRITER_SOURCE || !!r.qa_writer_id
    if (!r.is_test) {
      if (fromQa) reasons.push(`run sales ${mask(r.id)} của chương trình THẬT ${mask(r.program_id)} do writer QA mở — dừng, báo PM / operator`)
      else if (!releaseOpen) reasons.push(`run sales ${mask(r.id)} của chương trình THẬT ${mask(r.program_id)} trong khi Q-206 HOLD — bất thường, dừng, báo PM / operator (rollback 122 sẽ từ chối)`)
      else warn.add(r.program_id)
      continue
    }
    if (r.status === 'running') reasons.push(`run sales QA ${mask(r.id)} còn running — chờ writer xong / reconcile`)
    const w = r.qa_writer_id ? byWriter.get(r.qa_writer_id) : undefined
    if (r.source !== CMS_QA_WRITER_SOURCE || r.qa_run_id !== opts.qaRunId || !r.qa_writer_id) {
      reasons.push(`run sales QA ${mask(r.id)} trên chương trình ${mask(r.program_id)} không do writer của run này (source ${r.source ?? '—'}) — ghi QA không qua scripts/cms-qa-results.mjs`)
    } else if (!w) {
      reasons.push(`run sales QA ${mask(r.id)} gắn writer ${r.qa_writer_id} không có sổ trong run — điều tra, không tự nhận`)
    } else if (w.programId !== r.program_id) {
      reasons.push(`run sales QA ${mask(r.id)} gắn writer ${w.writerId} nhưng khác chương trình của sổ — điều tra`)
    } else if (!cmsQaWriterKnowsRun(w, r.id)) {
      reasons.push(`run sales QA ${mask(r.id)} của writer ${w.writerId} chưa có trong sổ (mất phản hồi?) — chạy \`node scripts/cms-qa-results.mjs reconcile --writer=${w.writerId}\``)
    }
  }
  return {
    reasons, warningProgramIds: [...warn],
    runs: rows.map((r) => ({ id: r.id, programId: r.program_id, isTest: r.is_test, status: r.status, source: r.source, errorCode: r.error_code, writerId: r.qa_writer_id ?? null })),
  }
}

/**
 * Reconcile một writer (PM QA-P1-2): chỉ xét run LIÊN KẾT đúng writer (qa_writer_id = writerId, qa_run_id = run, cùng
 * chương trình, is_test). Được khi sổ `running` + pid chết, `unknown`, hoặc `done` nhưng DB có run liên kết sổ chưa biết.
 * Không cần launcher sống (thu hồi lỗi của writer đã chết).
 */
export function cmsQaReconcileCheck(e: CmsQaWriterEntry, rows: readonly CmsQaSalesRunRow[], writerAlive: boolean):
  { ok: true; linked: CmsQaSalesRunRow[]; orphan: string | null } | { ok: false; reason: string } {
  if (e.status === 'reconciled') return { ok: false, reason: `writer ${e.writerId} đã reconciled` }
  if (e.status === 'running' && writerAlive) return { ok: false, reason: `writer ${e.writerId} (pid ${e.pid}) còn sống — chờ xong` }
  const linked = rows.filter((r) => r.qa_writer_id === e.writerId)
  const bad = linked.filter((r) => r.qa_run_id !== e.qaRunId || r.program_id !== e.programId || !r.is_test || r.source !== CMS_QA_WRITER_SOURCE)
  if (bad.length) return { ok: false, reason: `run ${bad.map((r) => mask(r.id)).join(', ')} gắn writer ${e.writerId} nhưng sai run QA / chương trình / namespace — điều tra, không tự nhận` }
  if (e.status === 'done' && linked.every((r) => cmsQaWriterKnowsRun(e, r.id))) return { ok: false, reason: `writer ${e.writerId} đã done, mọi run liên kết đã có trong sổ — không cần reconcile` }
  const running = linked.filter((r) => r.status === 'running')
  if (running.length > 1) return { ok: false, reason: `${running.length} run running cùng gắn writer ${e.writerId} — báo PM / operator` }
  return { ok: true, linked, orphan: running[0]?.id ?? null }
}

// ── QA CHỐT (P3a) — thao tác chốt có gate + sổ ý định ─────────────────────────
// Work order P3a §4.2: chỉ trong run QA đang mở (cùng manifest / launcher / candidate / marker / ngân sách đơn điệu của writer);
// chương trình is_test thuộc run, đã hết kỳ (QA-C); actor = super QA của run (allowlist app — canManageCms), không phải người
// gõ lệnh. Cờ PROGRAM + EARNINGS + LOCK chỉ ở biến PROCESS của lệnh (LOCK trong .env.local ⇒ gate chặn).
// Thứ tự một lần chốt: guard (đọc DB → kiểm lại manifest + launcher SAU IO) → ghi Ý ĐỊNH vào sổ (đồng bộ, độc quyền `wx`,
// không await giữa guard cuối và RPC) → RPC 123 → ghi kết quả (atomic). Mất phản hồi / lưu sổ sau RPC lỗi ⇒ `unknown` / sổ
// còn `intent` ⇒ rc 1; KHÔNG kết luận chưa chốt. `reconcile --writer=l-…` đọc payout theo program / run / actor của sổ: có ⇒
// đã chốt; không có ⇒ chỉ kết luận CHƯA chốt khi không còn phiên DB nào đang chạy rpc_cms_program_lock và đã qua thời gian
// lắng. close đối chiếu mọi payout trong cửa sổ run với sổ (chốt ngoài sổ — kể cả bấm trên UI — ⇒ ĐỎ).

export const CMS_QA_LOCK_ID_RE = /^l-[0-9a-f]{12}$/
/** Timeout phía client của RPC chốt (DB tự lock_timeout 3 s). Hết ⇒ không rõ (UNKNOWN_OUTCOME). */
export const CMS_QA_LOCK_RPC_TIMEOUT_MS = 30_000
/** Ngân sách guard + RPC của một lần chốt (đồng hồ đơn điệu). */
export const CMS_QA_LOCK_BUDGET_MS = 120_000
/**
 * Thời gian lắng (tính từ lúc lệnh chốt kết thúc / bắt đầu nếu tiến trình chết) trước khi reconcile được kết luận "CHƯA chốt":
 * request có thể còn xếp hàng ở gateway / pool PostgREST (mặc định chờ pool 10 s) dù client đã bỏ.
 */
export const CMS_QA_LOCK_SETTLE_MS = 30_000
export const CMS_QA_LOCK_FLAGS = ['CMS_PROGRAM_ENABLED', 'CMS_EARNINGS_ENABLED', 'CMS_LOCK_ENABLED'] as const

/** Cờ chốt bật bằng biến PROCESS của chính lệnh (không lấy từ .env.local). */
export function cmsQaLockFlagsOk(processEnv: Record<string, string | undefined>): { ok: true } | { ok: false; reason: string } {
  if (cmsLockEnabledFromEnv(processEnv)) return { ok: true }
  const off = CMS_QA_LOCK_FLAGS.filter((k) => processEnv[k] !== 'true')
  return { ok: false, reason: `cần ${off.join(', ')}=true là biến PROCESS của lệnh này (cờ LOCK chỉ bật trong process QA, không .env.local / Coolify)` }
}

/**
 * Launcher (security review P3a P1-1): server QA kế thừa env của shell ⇒ CMS_LOCK_ENABLED trong process mở nút "Chốt kỳ" trên
 * UI (đường action không có guard run / sổ của công cụ). Chỉ cho khi operator opt-in `start --with-lock` (QA chốt — runbook
 * §4.4) cùng EARNINGS; ngược lại chặn trước IO. Opt-in còn phải qua cmsQaLauncherLockDbCheck (policy chốt THẬT còn khoá).
 */
export function cmsQaLauncherLockCheck(i: { processEnv: Record<string, string | undefined>; withLock: boolean; server: boolean }):
  { ok: true; lock: boolean } | { ok: false; reason: string } {
  const on = i.processEnv.CMS_LOCK_ENABLED === 'true'
  if (on && !i.withLock) {
    return { ok: false, reason: 'CMS_LOCK_ENABLED=true đang ở process — server QA sẽ mở nút "Chốt kỳ" trên UI. Chỉ dùng cho QA chốt (runbook §4.4) bằng `start --with-lock`; còn lại bỏ biến này khỏi shell rồi chạy lại' }
  }
  if (!i.withLock) return { ok: true, lock: false }
  if (!i.server) return { ok: false, reason: '--with-lock chỉ dùng khi dựng server QA (không kèm --no-server)' }
  if (!on || i.processEnv.CMS_EARNINGS_ENABLED !== 'true') return { ok: false, reason: '--with-lock cần CMS_EARNINGS_ENABLED=true và CMS_LOCK_ENABLED=true là biến PROCESS của lệnh start' }
  return { ok: true, lock: true }
}

/** 123 đã có (hàm policy). Câu riêng: gọi hàm chưa tồn tại làm hỏng cả câu. */
export const CMS_QA_HAS_LOCK_POLICY_SQL = `SELECT (to_regprocedure('public.cms__lock_policy()') IS NOT NULL) AS has_policy`
export const CMS_QA_REAL_LOCK_READY_SQL = `SELECT (public.cms__lock_policy() -> 'real' ->> 'ready') AS real_ready`

/** `--with-lock` chỉ khi DB đã có 123 và policy chốt THẬT còn khoá (real.ready = false) ⇒ UI server QA không chốt được chương trình thật. */
export function cmsQaLauncherLockDbCheck(hasPolicy: unknown, realReady: unknown): { ok: true } | { ok: false; reason: string } {
  if (hasPolicy !== true) return { ok: false, reason: 'DB chưa có migration 123 (cms__lock_policy) — không cần / không dùng --with-lock' }
  if (realReady !== 'false') return { ok: false, reason: `policy chốt THẬT không còn khoá (real.ready = ${String(realReady)}) — server QA có LOCK sẽ chốt được chương trình thật bằng UI; không dùng --with-lock, báo PM / operator` }
  return { ok: true }
}

export interface CmsQaLockArgs {
  actorId: string; expectedRunId: string | null; policyVersion: number | null; ack: string | null
  /** 124: id chứng nhận preview đã thấy khi preview chốt bằng chứng nhận (basis operator_reconciliation); null = không gửi. */
  expectedAttestationId: string | null
}

/** Tham số lệnh `lock` (forLock) / `lock-preview`. Lý do (Q-213, giả định QA) chuẩn hoá như action; sai ⇒ chặn trước IO. */
export function parseCmsQaLockArgs(v: { actor?: string; expectRun?: string; policyVersion?: string; ack?: string; expectAttestation?: string }, forLock: boolean):
  { ok: true; value: CmsQaLockArgs } | { ok: false; reason: string } {
  const actor = v.actor?.trim().toLowerCase()
  if (!actor || !UUID_RE.test(actor)) return { ok: false, reason: 'cần --actor=<uuid super QA của run>' }
  if (!forLock) {
    if (v.expectRun !== undefined || v.policyVersion !== undefined || v.ack !== undefined || v.expectAttestation !== undefined) {
      return { ok: false, reason: 'lock-preview không nhận --expect-run / --policy-version / --ack / --expect-attestation' }
    }
    return { ok: true, value: { actorId: actor, expectedRunId: null, policyVersion: null, ack: null, expectedAttestationId: null } }
  }
  const run = v.expectRun?.trim().toLowerCase()
  if (!run || !UUID_RE.test(run)) return { ok: false, reason: 'cần --expect-run=<run_id hiện hành gõ lại từ lock-preview>' }
  if (v.policyVersion === undefined || !/^[1-9][0-9]{0,8}$/.test(v.policyVersion)) return { ok: false, reason: 'cần --policy-version=<số nguyên dương từ lock-preview>' }
  let ack: string | null = null
  if (v.ack !== undefined) {
    ack = cmsNormalizeAck(v.ack)
    if (ack === null) return { ok: false, reason: '--ack phải dài 10…1.000 ký tự sau khi bỏ khoảng trắng hai đầu' }
  }
  let att: string | null = null
  if (v.expectAttestation !== undefined) {
    att = v.expectAttestation.trim().toLowerCase()
    if (!UUID_RE.test(att)) return { ok: false, reason: '--expect-attestation phải là id chứng nhận (UUID) gõ lại từ lock-preview' }
  }
  return { ok: true, value: { actorId: actor, expectedRunId: run, policyVersion: Number(v.policyVersion), ack, expectedAttestationId: att } }
}

/** Điều kiện cục bộ của thao tác chốt: như writer + actor là tài khoản QA vai admin của run (super kiểm ở DB + allowlist app). */
export function cmsQaLockLocalCheck(i: CmsQaRunLocalInput & { actorId: string }): { ok: true } | { ok: false; reasons: string[] } {
  const base = cmsQaRunLocalReasons(i)
  if (base === null) return { ok: false, reasons: ['không có run QA đang mở'] }
  const m = i.manifest as CmsQaRunManifest
  const reasons = [...base]
  if (!m.users.some((u) => u.id === i.actorId && u.role === 'admin')) reasons.push(`${mask(i.actorId)} không phải tài khoản QA vai admin của run — chỉ super QA của run được chốt chương trình QA`)
  return reasons.length ? { ok: false, reasons } : { ok: true }
}

/** Vai + email của actor (đọc chỉ để kiểm super bằng allowlist app — không in). */
export function cmsQaActorSql(actorId: string): string {
  if (!UUID_RE.test(actorId)) throw new Error('actorId không phải UUID')
  return `SELECT u.id::text AS id, u.role::text AS role, u.email FROM public.users u WHERE u.id = '${actorId}'::uuid`
}

export type CmsQaLockStatus = 'intent' | 'done' | 'rejected' | 'unknown' | 'reconciled'
export interface CmsQaPayoutRef { programId: string; runId: string; lockedBy: string; lockedAt: string; isTest: boolean }

export interface CmsQaLockEntry {
  kind: 'cms-qa-lock'
  version: 1
  operationId: string
  qaRunId: string
  pid: number
  programId: string
  actorId: string
  expectedRunId: string
  policyVersion: number
  /** Có gửi lý do xác nhận (Q-213) — nội dung lý do nằm ở DB (cms_payouts.ack_reason), sổ không chép. */
  ack: boolean
  /** 124: id chứng nhận gửi kèm lệnh chốt (null = không gửi). Sổ cũ không có khoá này. */
  expectedAttestationId?: string | null
  startedAt: string
  status: CmsQaLockStatus
  finishedAt: string | null
  result: { ok: boolean; code: string | null; already: boolean; runId: string | null; amountVnd: string | null } | null
  reconcile?: { at: string; locked: boolean; payout: CmsQaPayoutRef | null } | null
}

/** Mục sổ Ý ĐỊNH — ghi TRƯỚC RPC (qa_run_id, operation_id, program_id, expected_run_id, policy_version). */
export function newCmsQaLockEntry(i: { operationId: string; qaRunId: string; pid: number; programId: string; actorId: string; expectedRunId: string; policyVersion: number; ack: boolean; now: string; expectedAttestationId?: string | null }): CmsQaLockEntry {
  if (i.expectedAttestationId !== undefined && i.expectedAttestationId !== null && !UUID_RE.test(i.expectedAttestationId)) throw new Error('mục sổ chốt không hợp lệ')
  if (!CMS_QA_LOCK_ID_RE.test(i.operationId) || !RUN_ID_RE.test(i.qaRunId) || !UUID_RE.test(i.programId) || !UUID_RE.test(i.actorId)
      || !UUID_RE.test(i.expectedRunId) || !Number.isSafeInteger(i.policyVersion) || i.policyVersion < 1 || !Number.isInteger(i.pid) || i.pid <= 0) {
    throw new Error('mục sổ chốt không hợp lệ')
  }
  return {
    kind: 'cms-qa-lock', version: 1, operationId: i.operationId, qaRunId: i.qaRunId, pid: i.pid, programId: i.programId,
    actorId: i.actorId, expectedRunId: i.expectedRunId, policyVersion: i.policyVersion, ack: i.ack,
    expectedAttestationId: i.expectedAttestationId ?? null, startedAt: i.now,
    status: 'intent', finishedAt: null, result: null,
  }
}

export function parseCmsQaLockEntry(text: string): { ok: true; value: CmsQaLockEntry } | { ok: false; reason: string } {
  let o: Partial<CmsQaLockEntry>
  try { o = JSON.parse(text) } catch { return { ok: false, reason: 'không phải JSON' } }
  if (!o || o.kind !== 'cms-qa-lock' || o.version !== 1) return { ok: false, reason: 'sai loại / phiên bản' }
  if (typeof o.operationId !== 'string' || !CMS_QA_LOCK_ID_RE.test(o.operationId)) return { ok: false, reason: 'operationId sai' }
  if (typeof o.qaRunId !== 'string' || !RUN_ID_RE.test(o.qaRunId)) return { ok: false, reason: 'qaRunId sai' }
  for (const k of ['programId', 'actorId', 'expectedRunId'] as const) {
    if (typeof o[k] !== 'string' || !UUID_RE.test(o[k] as string)) return { ok: false, reason: `${k} sai` }
  }
  if (!Number.isSafeInteger(o.policyVersion) || (o.policyVersion as number) < 1) return { ok: false, reason: 'policyVersion sai' }
  if (o.expectedAttestationId !== undefined && o.expectedAttestationId !== null && !(typeof o.expectedAttestationId === 'string' && UUID_RE.test(o.expectedAttestationId))) {
    return { ok: false, reason: 'expectedAttestationId sai' }
  }
  if (!Number.isInteger(o.pid) || (o.pid as number) <= 0) return { ok: false, reason: 'pid sai' }
  if (typeof o.startedAt !== 'string' || Number.isNaN(Date.parse(o.startedAt))) return { ok: false, reason: 'startedAt sai' }
  if (!['intent', 'done', 'rejected', 'unknown', 'reconciled'].includes(o.status as string)) return { ok: false, reason: 'trạng thái sai' }
  if (o.status !== 'intent' && (o.result === null || o.result === undefined) && o.status !== 'reconciled') return { ok: false, reason: 'thiếu kết quả' }
  if (o.status === 'reconciled' && (!o.reconcile || typeof o.reconcile.locked !== 'boolean')) return { ok: false, reason: 'thiếu đối chiếu' }
  return { ok: true, value: o as CmsQaLockEntry }
}

/** Kết quả lõi action (lib/cms/lockAction) ⇒ trạng thái sổ: thành công ⇒ done; UNKNOWN_OUTCOME ⇒ unknown; mã khác ⇒ rejected (DB / cổng từ chối xác định). */
export function cmsQaLockOutcome(r: { ok: boolean; code?: string }): 'done' | 'rejected' | 'unknown' {
  if (r.ok) return 'done'
  return r.code === 'UNKNOWN_OUTCOME' ? 'unknown' : 'rejected'
}

/** Sổ khẳng định chương trình đã chốt (thành công trực tiếp hoặc reconcile thấy payout) — run nào. */
export function cmsQaLockClaimedRun(e: CmsQaLockEntry): string | null {
  if (e.status === 'done' && e.result?.ok) return e.result.runId
  if (e.status === 'reconciled' && e.reconcile?.locked) return e.reconcile.payout?.runId ?? null
  return null
}

/** Thao tác chốt CHƯA khép của một chương trình (intent / unknown) — chặn lần chốt mới tới khi reconcile. */
export function cmsQaPendingLockOps(entries: readonly CmsQaLockEntry[], programId: string): CmsQaLockEntry[] {
  return entries.filter((e) => e.programId === programId && (e.status === 'intent' || e.status === 'unknown'))
}

/** Bảng payout có chưa (DB trước 123 ⇒ close vẫn chạy, chỉ kiểm sổ). */
export const CMS_QA_HAS_PAYOUTS_SQL = `SELECT (to_regclass('public.cms_payouts') IS NOT NULL) AS has_payouts`

/** Payout chốt TRONG cửa sổ run QA (chỉ đọc). Chỉ gọi khi bảng tồn tại. */
export function cmsQaRunPayoutsSql(startedAt: string): string {
  if (!ISO_UTC_RE.test(startedAt) || Number.isNaN(Date.parse(startedAt))) throw new Error('startedAt không hợp lệ')
  return `SELECT p.program_id::text AS program_id, p.run_id::text AS run_id, p.locked_by::text AS locked_by, p.locked_at,
       p.is_test, g.is_test AS program_is_test, g.status::text AS program_status
  FROM public.cms_payouts p JOIN public.cms_programs g ON g.id = p.program_id
 WHERE p.locked_at >= '${startedAt}'::timestamptz ORDER BY p.locked_at, p.program_id`
}

export interface CmsQaPayoutRow {
  program_id: string; run_id: string; locked_by: string; locked_at: string; is_test: boolean; program_is_test: boolean; program_status: string
}

/**
 * Lượt 1 của reconcile (db-review P2-3): dò phiên ghi payout có thể chưa commit — chạy TRƯỚC khi đọc payout (lượt 2 có snapshot
 * mới, READ COMMITTED). Chỉ kết luận "CHƯA chốt" khi: vai thấy được query của mọi phiên (superuser / pg_read_all_stats),
 * track_activities bật, 0 phiên ẩn, 0 phiên client đang chạy chốt (kể cả `idle in transaction` sau câu chốt — bắt qua khoá),
 * 0 phiên giữ RowExclusiveLock trên bảng payout (INSERT chưa commit giữ khoá tới hết transaction, không phụ thuộc chữ query).
 */
export const CMS_QA_LOCK_PROBE_SQL = `SELECT
  (SELECT r.rolsuper OR pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER') FROM pg_roles r WHERE r.rolname = current_user) AS can_see_all,
  current_setting('track_activities') = 'on' AS tracking,
  (SELECT count(*)::int FROM pg_stat_activity a WHERE a.pid <> pg_backend_pid() AND a.datname = current_database()
     AND a.backend_type = 'client backend' AND a.query = '<insufficient privilege>') AS hidden,
  (SELECT count(*)::int FROM pg_stat_activity a WHERE a.pid <> pg_backend_pid() AND a.datname = current_database()
     AND a.backend_type = 'client backend' AND a.state IS DISTINCT FROM 'idle' AND a.query ILIKE '%rpc\\_cms\\_program\\_lock%') AS inflight,
  (SELECT count(*)::int FROM pg_locks l WHERE l.pid <> pg_backend_pid() AND l.locktype = 'relation' AND l.mode = 'RowExclusiveLock'
     AND l.relation IN ('public.cms_payouts'::regclass, 'public.cms_payout_staff'::regclass)) AS payout_writers`

export interface CmsQaLockProbeRow { can_see_all: boolean; tracking: boolean; hidden: number; inflight: number; payout_writers: number }

/** Lượt 2 của reconcile: chương trình + payout (nếu có) — đọc SAU lượt dò. */
export function cmsQaLockStateSql(programId: string): string {
  if (!UUID_RE.test(programId)) throw new Error('programId không phải UUID')
  return `SELECT g.id::text AS program_id, g.status::text AS status, g.is_test, p.run_id::text AS run_id, p.locked_by::text AS locked_by, p.locked_at
  FROM public.cms_programs g LEFT JOIN public.cms_payouts p ON p.program_id = g.id WHERE g.id = '${programId}'::uuid`
}

export interface CmsQaLockStateRow {
  program_id: string; status: string; is_test: boolean; run_id: string | null; locked_by: string | null; locked_at: string | null
}

/**
 * Reconcile một thao tác chốt (work order §4.2): chỉ khi sổ `intent` (tiến trình đã chết) hoặc `unknown`. Payout khớp ĐÚNG
 * chương trình + run + actor của sổ ⇒ đã chốt (lệnh mất phản hồi sau commit). Payout lệch ⇒ điều tra, không tự nhận. Không có
 * payout ⇒ CHƯA chốt chỉ khi không còn phiên DB đang chạy chốt và đã qua thời gian lắng; chưa đủ ⇒ chờ rồi chạy lại.
 */
export function cmsQaLockReconcileCheck(e: CmsQaLockEntry, row: CmsQaLockStateRow | undefined, o: { pidAlive: boolean; nowMs: number; probe: CmsQaLockProbeRow | undefined }):
  { ok: true; locked: boolean; payout: CmsQaPayoutRef | null } | { ok: false; reason: string; wait?: true } {
  if (e.status === 'reconciled') return { ok: false, reason: `thao tác chốt ${e.operationId} đã reconciled` }
  if (e.status === 'done' || e.status === 'rejected') return { ok: false, reason: `thao tác chốt ${e.operationId} đã có kết quả xác định (${e.status}${e.result?.code ? ` ${e.result.code}` : ''}) — không cần reconcile` }
  if (e.status === 'intent' && o.pidAlive) return { ok: false, reason: `thao tác chốt ${e.operationId} (pid ${e.pid}) còn chạy — chờ xong`, wait: true }
  if (!row) return { ok: false, reason: `không có chương trình ${mask(e.programId)}` }
  if (row.is_test !== true) return { ok: false, reason: `chương trình ${mask(e.programId)} không phải is_test — dừng, báo PM / operator` }
  if (row.run_id !== null) {
    if (row.run_id === e.expectedRunId && row.locked_by === e.actorId && row.status === 'locked') {
      return { ok: true, locked: true, payout: { programId: e.programId, runId: row.run_id, lockedBy: row.locked_by, lockedAt: String(row.locked_at), isTest: true } }
    }
    return { ok: false, reason: `chương trình ${mask(e.programId)} đã chốt nhưng KHÔNG khớp thao tác ${e.operationId} (run / người chốt khác sổ) — điều tra, không tự nhận` }
  }
  if (row.status === 'locked') return { ok: false, reason: `chương trình ${mask(e.programId)} locked mà không có payout — bất thường, báo PM / operator` }
  const pr = o.probe
  if (!pr || pr.can_see_all !== true || pr.tracking !== true || !Number.isInteger(pr.hidden) || pr.hidden > 0) {
    return { ok: false, reason: 'không chứng minh được không còn phiên chốt (vai không thấy query mọi phiên / track_activities tắt / có phiên ẩn) — chạy reconcile bằng vai superuser của pg-meta; báo PM / operator nếu vẫn vậy' }
  }
  if (!Number.isInteger(pr.inflight) || pr.inflight > 0) return { ok: false, reason: `còn ${pr.inflight} phiên DB đang chạy rpc_cms_program_lock — chờ rồi chạy lại reconcile`, wait: true }
  if (!Number.isInteger(pr.payout_writers) || pr.payout_writers > 0) return { ok: false, reason: `còn ${pr.payout_writers} phiên giữ khoá ghi bảng payout (transaction chốt chưa kết thúc) — chờ rồi chạy lại reconcile`, wait: true }
  const since = Date.parse(e.finishedAt ?? e.startedAt)
  const left = CMS_QA_LOCK_SETTLE_MS - (o.nowMs - since)
  if (!Number.isFinite(since) || left > 0) return { ok: false, reason: `chưa đủ thời gian lắng — chờ thêm ${Math.ceil(Math.max(left, 0) / 1000)} s rồi chạy lại reconcile (request có thể còn xếp hàng ở gateway)`, wait: true }
  return { ok: true, locked: false, payout: null }
}

/** Close: thao tác chốt còn chạy / không rõ ⇒ từ chối (chỉ reconcile gỡ). Sổ hỏng / thuộc run khác / sai tên ⇒ từ chối. */
export function cmsQaLocksCloseCheck(
  qaRunId: string, files: readonly { name: string; text: string }[], pidAlive: (pid: number) => boolean,
): { reasons: string[]; entries: CmsQaLockEntry[] } {
  const reasons: string[] = []
  const entries: CmsQaLockEntry[] = []
  const rec = (id: string) => `chạy \`node scripts/cms-qa-results.mjs reconcile --writer=${id}\``
  for (const f of files) {
    const p = parseCmsQaLockEntry(f.text)
    if (!p.ok) { reasons.push(`sổ chốt ${f.name} hỏng (${p.reason}) — không xoá tay; báo PM / operator`); continue }
    const e = p.value
    if (e.qaRunId !== qaRunId) { reasons.push(`sổ chốt ${e.operationId} thuộc run khác (${e.qaRunId})`); continue }
    if (`${e.operationId}.json` !== f.name) { reasons.push(`sổ chốt ${f.name} sai tên file`); continue }
    if (e.status === 'intent') {
      if (pidAlive(e.pid)) reasons.push(`thao tác chốt ${e.operationId} (pid ${e.pid}) CÒN CHẠY — chờ xong rồi mới close`)
      else reasons.push(`thao tác chốt ${e.operationId} (pid ${e.pid}) không rõ kết thúc (sổ còn ý định) — ${rec(e.operationId)}`)
    } else if (e.status === 'unknown') {
      reasons.push(`thao tác chốt ${e.operationId} KẾT QUẢ KHÔNG RÕ (${e.result?.code ?? '—'}; có thể đã chốt) — ${rec(e.operationId)}`)
    }
    entries.push(e)
  }
  return { reasons, entries }
}

/**
 * Close: đối chiếu MỌI payout chốt trong cửa sổ run với sổ chốt (work order §4.2):
 *  · chương trình THẬT: actor là tài khoản QA của run ⇒ ĐỎ; người khác ⇒ cảnh báo (soát tay + --ack-warnings);
 *  · chương trình QA: phải có thao tác trong sổ khẳng định đã chốt ĐÚNG run + actor; không có ⇒ ĐỎ (chốt ngoài sổ — UI / công
 *    cụ khác / mất phản hồi chưa reconcile);
 *  · sổ khẳng định đã chốt nhưng DB không có payout tương ứng trong cửa sổ ⇒ ĐỎ.
 */
export function cmsQaPayoutsCloseCheck(
  rows: readonly CmsQaPayoutRow[], locks: readonly CmsQaLockEntry[], opts: { qaUserIds: readonly string[]; payoutsTable: boolean },
): { reasons: string[]; warningProgramIds: string[]; payouts: { programId: string; runId: string; isTest: boolean; lockedAt: string; operationId: string | null }[] } {
  const reasons: string[] = []
  const warn = new Set<string>()
  const qa = new Set(opts.qaUserIds)
  const payouts: { programId: string; runId: string; isTest: boolean; lockedAt: string; operationId: string | null }[] = []
  for (const r of rows) {
    const isTest = r.is_test === true && r.program_is_test === true
    let op: CmsQaLockEntry | undefined
    if (!isTest) {
      if (qa.has(r.locked_by)) reasons.push(`chương trình THẬT ${mask(r.program_id)} bị tài khoản QA của run chốt — dừng, báo PM / operator`)
      else warn.add(r.program_id)
    } else {
      op = locks.find((e) => e.programId === r.program_id && e.actorId === r.locked_by && cmsQaLockClaimedRun(e) === r.run_id)
      if (!op) reasons.push(`chương trình QA ${mask(r.program_id)} được chốt (run ${mask(r.run_id)}) mà sổ chốt của run không khẳng định — chốt ngoài sổ (UI / công cụ khác) hoặc mất phản hồi chưa reconcile; điều tra, không tự nhận`)
    }
    payouts.push({ programId: r.program_id, runId: r.run_id, isTest, lockedAt: String(r.locked_at), operationId: op?.operationId ?? null })
  }
  for (const e of locks) {
    const run = cmsQaLockClaimedRun(e)
    if (run === null) continue
    if (!opts.payoutsTable || !rows.some((r) => r.program_id === e.programId && r.run_id === run && r.locked_by === e.actorId)) {
      reasons.push(`sổ chốt ${e.operationId} ghi đã chốt ${mask(e.programId)} nhưng DB không có payout tương ứng trong cửa sổ run — điều tra`)
    }
  }
  return { reasons, warningProgramIds: [...warn], payouts }
}

/** Phân loại tệp trong thư mục sổ của run: writer (w-…), chốt (l-…), chứng nhận nguồn 124 (a-…), xuất lớp nguồn 124 (x-…), lạ (từ chối — không tự bỏ qua). */
export function cmsQaLedgerPartition(names: readonly string[]): { writers: string[]; locks: string[]; attests: string[]; exports: string[]; other: string[] } {
  const writers: string[] = [], locks: string[] = [], attests: string[] = [], exports: string[] = [], other: string[] = []
  for (const n of names) {
    if (/^w-[0-9a-f]{12}\.json$/.test(n)) writers.push(n)
    else if (/^l-[0-9a-f]{12}\.json$/.test(n)) locks.push(n)
    else if (/^a-[0-9a-f]{12}\.json$/.test(n)) attests.push(n)
    else if (/^x-[0-9a-f]{12}\.json$/.test(n)) exports.push(n)
    else other.push(n)
  }
  return { writers, locks, attests, exports, other }
}
