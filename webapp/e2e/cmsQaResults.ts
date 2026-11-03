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
export function cmsQaWriterLocalCheck(i: {
  manifest: CmsQaRunManifest | null
  confirmRun: string | undefined
  host: string | null
  treeClean: boolean
  gitHead: string
  gitTree: string
  launcherAlive: boolean
  staffIds: readonly string[]
}): { ok: true } | { ok: false; reasons: string[] } {
  const m = i.manifest
  const reasons: string[] = []
  if (!m || m.status !== 'open') return { ok: false, reasons: ['không có run QA đang mở'] }
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
  const qaStaff = new Set(m.users.filter((u) => u.role === 'staff').map((u) => u.id))
  for (const id of i.staffIds) if (!qaStaff.has(id)) reasons.push(`${mask(id)} không phải tài khoản QA vai staff của run`)
  if (i.staffIds.length === 0) reasons.push('chưa chọn tài khoản staff QA')
  return reasons.length ? { ok: false, reasons } : { ok: true }
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
      a[a.length - 1] = { ...io, timeoutMs: Math.max(1, Math.min(io.timeoutMs, remain)) }
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
