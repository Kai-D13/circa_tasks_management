import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import * as XLSX from 'xlsx'
import {
  CARE_TZ, carePeriodOf, isDateInPeriod, isValidIsoDate, nextPeriod, overdueStampDate, periodLastDay,
  periodOfDate, periodRange, vnDateISO,
} from '../lib/care/time'
import {
  CARE_OUTCOMES, CARE_OUTCOME_META, CARE_TERMINAL_OUTCOMES, isCareOutcome, isTerminalOutcome,
  requiresNextActionDate,
} from '../lib/care/outcome'
import {
  CARE_IMPORT_DEFAULT_MAX_BYTES, careBqOrdersTable, careFlagsFromEnv, careImportMaxBytes,
} from '../lib/care/config'
import {
  BigQueryError, bqQueryAll, buildQueryParameters, type BqTransport,
} from '../lib/bigquery/query'
import { normalizeVnPhone } from '../lib/affiliate/phone'
import { parseEnvText, resolveEnv } from './envLocal'
import {
  CARE_IMPORT_HEADERS, CARE_IMPORT_SHEET, buildCareImportRows, buildCareImportXlsx,
} from './careImportFixture'
import { CARE_QA_MARKER, careWriteGate } from './writeQaGates'

// CRM-CSKH B0 — unit gate THUẦN (không DB, không mạng, không BigQuery thật).
// Map AC planning/SPEC.md §B0: thời gian kỳ VN · outcome một nguồn · cờ OFF ·
// client BigQuery (mock: nhiều trang, job chưa xong, timeout, lỗi giữ snapshot)
// · fixture Excel giả · loader credential · gate ghi QA.

const ROOT = path.resolve(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

test.describe('care B0 — kỳ theo giờ VN @desktop', () => {
  test('ranh giới 23:59:59 / 00:00 VN cuối tháng → đầu tháng', () => {
    // 31/10 23:59:59.999 VN = 16:59:59.999Z
    expect(vnDateISO(new Date('2026-10-31T16:59:59.999Z'))).toBe('2026-10-31')
    expect(carePeriodOf(new Date('2026-10-31T16:59:59.999Z'))).toBe('2026-10-01')
    // 01/11 00:00 VN = 31/10 17:00Z — theo UTC vẫn là 31/10
    expect(vnDateISO(new Date('2026-10-31T17:00:00.000Z'))).toBe('2026-11-01')
    expect(carePeriodOf(new Date('2026-10-31T17:00:00.000Z'))).toBe('2026-11-01')
  })

  test('bẫy UTC: 00:30 VN ngày 1 — toISOString ra tháng trước, vnDateISO ra đúng tháng', () => {
    const d = new Date('2026-11-01T00:30:00+07:00')
    expect(d.toISOString().slice(0, 10)).toBe('2026-10-31') // cách làm SAI
    expect(vnDateISO(d)).toBe('2026-11-01')
    expect(carePeriodOf(d)).toBe('2026-11-01')
    expect(CARE_TZ).toBe('Asia/Ho_Chi_Minh')
  })

  test('rollover năm: 31/12 23:59 VN vs 01/01 00:00 VN', () => {
    expect(carePeriodOf(new Date('2026-12-31T16:59:00Z'))).toBe('2026-12-01')
    expect(carePeriodOf(new Date('2026-12-31T17:00:00Z'))).toBe('2027-01-01')
    expect(nextPeriod('2026-12-01')).toBe('2027-01-01')
    expect(nextPeriod('2026-01-01')).toBe('2026-02-01')
  })

  test('ngày cuối kỳ (hạn chăm sóc): năm nhuận, thế kỷ, tháng 30/31', () => {
    expect(periodLastDay('2028-02-01')).toBe('2028-02-29')
    expect(periodLastDay('2026-02-01')).toBe('2026-02-28')
    expect(periodLastDay('2000-02-01')).toBe('2000-02-29')
    expect(periodLastDay('2100-02-01')).toBe('2100-02-28')
    expect(periodLastDay('2026-04-01')).toBe('2026-04-30')
    expect(periodLastDay('2026-10-01')).toBe('2026-10-31')
    expect(periodLastDay('2026-12-01')).toBe('2026-12-31')
  })

  test('ngày hẹn chỉ trong tháng task (Q-48)', () => {
    expect(isDateInPeriod('2026-10-01', '2026-10-01')).toBe(true)
    expect(isDateInPeriod('2026-10-31', '2026-10-01')).toBe(true)
    expect(isDateInPeriod('2026-11-01', '2026-10-01')).toBe(false)
    expect(isDateInPeriod('2026-09-30', '2026-10-01')).toBe(false)
    expect(isDateInPeriod('2028-02-29', '2028-02-01')).toBe(true)
    expect(isDateInPeriod('2026-02-29', '2026-02-01')).toBe(false) // không tồn tại
    expect(isDateInPeriod('31/10/2026', '2026-10-01')).toBe(false)
  })

  test('khoảng tuyệt đối của kỳ: from 00:00 VN ngày 1, to EXCLUSIVE 00:00 VN kỳ sau', () => {
    expect(periodRange('2026-10-01')).toEqual({ from: '2026-10-01T00:00:00+07:00', to: '2026-11-01T00:00:00+07:00' })
    expect(periodRange('2026-12-01').to).toBe('2027-01-01T00:00:00+07:00')
    const { from, to } = periodRange('2026-10-01')
    expect(carePeriodOf(new Date(from))).toBe('2026-10-01')
    expect(carePeriodOf(new Date(new Date(to).getTime() - 1))).toBe('2026-10-01')
    expect(carePeriodOf(new Date(to))).toBe('2026-11-01')
  })

  test('mốc trễ hẹn (B1 §2.8): hẹn 30/10 ⇒ 31/10; hẹn 31/10 ⇒ không bao giờ trễ trong kỳ', () => {
    expect(overdueStampDate('2026-10-30', '2026-10-31', '2026-10-30')).toBeNull() // chưa qua ngày hẹn
    expect(overdueStampDate('2026-10-30', '2026-10-31', '2026-10-31')).toBe('2026-10-31')
    expect(overdueStampDate('2026-10-31', '2026-10-31', '2026-11-01')).toBeNull() // chỉ Không hoàn thành
    expect(overdueStampDate('2026-10-10', '2026-10-31', '2026-11-01')).toBe('2026-10-11') // đóng kỳ vẫn ghi đúng mốc
    expect(overdueStampDate('2028-02-28', '2028-02-29', '2028-03-01')).toBe('2028-02-29') // năm nhuận
    expect(overdueStampDate(null, '2026-10-31', '2026-11-01')).toBeNull()
    expect(() => overdueStampDate('2026-10-32', '2026-10-31', '2026-11-01')).toThrow()
  })

  test('đầu vào sai ⇒ throw, không đoán', () => {
    expect(isValidIsoDate('2026-13-01')).toBe(false)
    expect(isValidIsoDate('2026-02-30')).toBe(false)
    expect(isValidIsoDate('2026-1-1')).toBe(false)
    expect(() => periodLastDay('2026-10-15')).toThrow(/đầu tháng/)
    expect(() => nextPeriod('2026-10')).toThrow()
    expect(() => periodOfDate('2026-02-30')).toThrow()
    expect(() => vnDateISO(new Date('không phải ngày'))).toThrow()
    expect(() => isDateInPeriod('2026-10-05', '2026-10-05')).toThrow()
  })
})

test.describe('care B0 — outcome một nguồn TS @desktop', () => {
  test('đúng sáu outcome CONTRACT R1, không trùng', () => {
    expect([...CARE_OUTCOMES].sort()).toEqual(
      ['CALLBACK', 'INTERESTED', 'NO_NEED', 'ORDERED', 'REFUSED', 'UNREACHABLE'],
    )
    const labels = CARE_OUTCOMES.map((o) => CARE_OUTCOME_META[o].label)
    expect(new Set(labels).size).toBe(6)
    expect(labels).toEqual([
      'Không liên hệ được', 'Đã liên hệ – chưa có nhu cầu', 'Khách quan tâm',
      'Hẹn chăm sóc lại', 'Đã đặt đơn', 'Từ chối chăm sóc',
    ])
  })

  test('tập kết thúc = NO_NEED, INTERESTED, ORDERED, REFUSED; còn mở cần ngày hẹn', () => {
    expect([...CARE_TERMINAL_OUTCOMES].sort()).toEqual(['INTERESTED', 'NO_NEED', 'ORDERED', 'REFUSED'])
    // Đã chốt: INTERESTED kết thúc, CALLBACK còn mở + bắt buộc ngày hẹn (Q-03/Q-48).
    expect(isTerminalOutcome('INTERESTED')).toBe(true)
    expect(isTerminalOutcome('CALLBACK')).toBe(false)
    expect(requiresNextActionDate('CALLBACK')).toBe(true)
    // Mặc định TODO(Q-03): UNREACHABLE còn mở + cần ngày hẹn.
    expect(isTerminalOutcome('UNREACHABLE')).toBe(false)
    expect(requiresNextActionDate('UNREACHABLE')).toBe(true)
    for (const o of CARE_TERMINAL_OUTCOMES) expect(requiresNextActionDate(o)).toBe(false)
    // Chỉ REFUSED ghi từ chối theo store (Q-54).
    expect(CARE_OUTCOMES.filter((o) => CARE_OUTCOME_META[o].recordsStoreRefusal)).toEqual(['REFUSED'])
  })

  test('giá trị lạ ⇒ fail-closed (không bao giờ là Hoàn thành)', () => {
    for (const v of ['interested', 'DONE', '', null, undefined, 1, {}]) {
      expect(isCareOutcome(v)).toBe(false)
      expect(isTerminalOutcome(v)).toBe(false)
    }
  })

  test('một nguồn: mã outcome không được khai báo lại ngoài lib/care/outcome.ts', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name)
        if (e.isDirectory()) { if (!['node_modules', '.next'].includes(e.name)) walk(rel); continue }
        if (!/\.(ts|tsx)$/.test(e.name) || rel.replace(/\\/g, '/') === 'lib/care/outcome.ts') continue
        if (/['"](NO_NEED|UNREACHABLE)['"]/.test(read(rel))) offenders.push(rel)
      }
    }
    for (const d of ['lib', 'app', 'components']) walk(d)
    expect(offenders, 'khai báo outcome trùng — import từ lib/care/outcome.ts').toEqual([])
  })
})

test.describe('care B0 — cờ và cấu hình (mặc định OFF) @desktop', () => {
  test('chỉ đúng chuỗi "true" mới bật; hai cờ độc lập', () => {
    expect(careFlagsFromEnv({})).toEqual({ enabled: false, syncEnabled: false })
    for (const v of ['1', 'TRUE', 'True', ' true', 'yes', '']) {
      expect(careFlagsFromEnv({ CARE_ENABLED: v, CARE_SYNC_ENABLED: v })).toEqual({ enabled: false, syncEnabled: false })
    }
    expect(careFlagsFromEnv({ CARE_ENABLED: 'true' })).toEqual({ enabled: true, syncEnabled: false })
    expect(careFlagsFromEnv({ CARE_SYNC_ENABLED: 'true' })).toEqual({ enabled: false, syncEnabled: true })
  })

  test('.env.example khai báo cờ OFF + cấu hình CRM, không có giá trị bí mật', () => {
    const ex = read('.env.example')
    expect(ex).toMatch(/^CARE_ENABLED=false$/m)
    expect(ex).toMatch(/^CARE_SYNC_ENABLED=false$/m)
    expect(ex).toMatch(/^CARE_BQ_ORDERS_TABLE=$/m)
    expect(ex).toMatch(/^CARE_IMPORT_MAX_BYTES=8388608$/m)
    expect(ex).not.toMatch(/^E2E_MKT_ADMIN_(EMAIL|PASSWORD)=/m)
  })

  test('flags.ts là server-only và đọc qua careFlagsFromEnv', () => {
    const src = read('lib/care/flags.ts')
    expect(src).toMatch(/^import 'server-only'/)
    expect(src).toContain('careFlagsFromEnv(process.env)')
  })

  test('cờ OFF không đổi module live: nav/proxy/tasks chưa tham chiếu CRM; route/page CRM (B2/B3) kiểm cờ trước tiên', () => {
    // B3: Sidebar + layout nối mục "Chăm sóc KH" — gate cờ kiểm ở care-browse-core.spec
    // (getCareNavPermissions trả null khi CARE_ENABLED OFF ⇒ careNav rỗng ⇒ không render).
    // B4: BottomNav (tab CSKH) + CTA /tasks — gate cờ kiểm ở care-my-core.spec (careEnabled từ server;
    // CTA chỉ khi isStaff && isCareEnabled()). B5 thêm cron ⇒ kiểm 503 khi CARE_SYNC_ENABLED OFF.
    const live = ['lib/layout/sidebarNav.ts', 'proxy.ts']
    for (const f of live) expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true)
    // Ngoại lệ DUY NHẤT (B5b.1): proxy bỏ qua đăng nhập cho route QA đọc VIEW N3 — chỉ khi development,
    // đúng một pathname; route tự kiểm UI_CATALOG + Bearer CRON_SECRET (care-b5b-source.spec).
    const QA_BYPASS = "  // CRM B5b QA đọc VIEW N3 thật — CHỈ development, đúng một pathname; route tự kiểm UI_CATALOG + Bearer CRON_SECRET.\n"
      + "  if (process.env.NODE_ENV === 'development' && pathname === '/api/qa/care-n3-view') return NextResponse.next()\n"
    expect(read('proxy.ts')).toContain(QA_BYPASS)
    for (const f of live) {
      const src = read(f).replace(QA_BYPASS, '')
      expect(src, f).not.toMatch(/lib\/care|CARE_ENABLED|\/care\b/)
    }
    expect(fs.existsSync(path.join(ROOT, 'app/api/cron/care-period-close'))).toBe(false)
    // B5b.2: cron care-orders-sync có route nhưng chặn bằng CARE_ENABLED + CARE_SYNC_ENABLED (care-b5b-sync.spec).
    expect(read('app/api/cron/care-orders-sync/route.ts')).toContain('if (!isCareEnabled() || !isCareSyncEnabled())')
    // B2: entry duy nhất là URL /care/assign + /api/care/import/* — page kiểm cờ ngay đầu,
    // route đi qua handler mà bước đầu là `if (!deps.enabled) return 404` (care-import-core.spec).
    expect(read('app/(dashboard)/care/assign/page.tsx')).toMatch(/export default async function[\s\S]*?\{\s*if \(!isCareEnabled\(\)\) notFound\(\)/)
    expect(read('lib/care/import/handler.ts')).toMatch(/async function guard[\s\S]*?\{\s*if \(!deps\.enabled\) return/)
    // B3: /care + /care/tasks + /care/tasks/[id] — mọi page đi qua requireCareViewer (cờ trước tiên).
    const careDirs = fs.readdirSync(path.join(ROOT, 'app/(dashboard)/care')).sort()
    expect(careDirs).toEqual(['assign', 'my', 'page.tsx', 'reports', 'tasks'])
    // B4: /care/my* — mọi page đi qua requireCareStaff (cờ trước tiên, chỉ dược sĩ OS).
    for (const f of ['app/(dashboard)/care/my/page.tsx', 'app/(dashboard)/care/my/[id]/page.tsx', 'app/(dashboard)/care/my/[id]/update/page.tsx']) {
      expect(read(f), f).toMatch(/export default async function[\s\S]*?\{\s*const me = await requireCareStaff\(\)/)
    }
    expect(read('lib/care/server/my.ts')).toMatch(/function requireCareStaff\(\)[\s\S]*?> \{\s*if \(!isCareEnabled\(\)\) notFound\(\)/)
    // B5a: /care/reports cùng cổng browser; export /api/export/care kiểm cờ trước tiên.
    for (const f of ['app/(dashboard)/care/page.tsx', 'app/(dashboard)/care/tasks/page.tsx', 'app/(dashboard)/care/tasks/[id]/page.tsx', 'app/(dashboard)/care/reports/page.tsx']) {
      expect(read(f), f).toMatch(/export default async function[\s\S]*?\{\s*const g = await requireCareViewer\(\)/)
    }
    expect(read('lib/care/server/pageGuard.ts')).toMatch(/function requireCareViewer\(\)[\s\S]*?> \{\s*if \(!isCareEnabled\(\)\) notFound\(\)/)
  })

  test('CARE_IMPORT_MAX_BYTES: mặc định 8MB, sai/ngoài khoảng ⇒ throw', () => {
    expect(careImportMaxBytes({})).toBe(CARE_IMPORT_DEFAULT_MAX_BYTES)
    expect(careImportMaxBytes({ CARE_IMPORT_MAX_BYTES: '' })).toBe(8 * 1024 * 1024)
    expect(careImportMaxBytes({ CARE_IMPORT_MAX_BYTES: '5242880' })).toBe(5 * 1024 * 1024)
    expect(() => careImportMaxBytes({ CARE_IMPORT_MAX_BYTES: '8MB' })).toThrow()
    expect(() => careImportMaxBytes({ CARE_IMPORT_MAX_BYTES: '-1' })).toThrow()
    expect(() => careImportMaxBytes({ CARE_IMPORT_MAX_BYTES: '100' })).toThrow()
    expect(() => careImportMaxBytes({ CARE_IMPORT_MAX_BYTES: String(11 * 1024 * 1024) })).toThrow()
  })

  test('CARE_BQ_ORDERS_TABLE: trống ⇒ null; chỉ chấp nhận project.dataset.table an toàn', () => {
    expect(careBqOrdersTable({})).toBeNull()
    expect(careBqOrdersTable({ CARE_BQ_ORDERS_TABLE: ' lakehouse-prod-394907.buymed_tech.care_orders ' }))
      .toBe('lakehouse-prod-394907.buymed_tech.care_orders')
    expect(careBqOrdersTable({ CARE_BQ_ORDERS_TABLE: 'lakehouse-prod-394907.buymed_tech.tech__circa_completed_order' }))
      .toBe('lakehouse-prod-394907.buymed_tech.tech__circa_completed_order') // VIEW Q-96
    for (const bad of ['buymed_tech.care_orders', '`p.d.t`', 'p.d.t; DROP', 'lakehouse-prod-394907.d.t x', 'lakehouse-prod-394907.ds.orders$20261001']) {
      expect(() => careBqOrdersTable({ CARE_BQ_ORDERS_TABLE: bad }), bad).toThrow()
    }
  })
})

// ─── BigQuery client (mock) ──────────────────────────────────────────────────
type Step = { status?: number; body?: unknown; hang?: boolean; networkError?: boolean }
type Call = { url: string; method: string; body: Record<string, unknown> | undefined }

function mockBq(steps: Step[], opts: { realClock?: boolean } = {}) {
  const clock = { t: 0 }
  const calls: Call[] = []
  const sleeps: number[] = []
  const queue = [...steps]
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const step = queue.shift()
    if (!step) throw new Error('mock BigQuery: hết bước')
    if (step.networkError) throw new TypeError('fetch failed')
    if (step.hang) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
      })
    }
    return new Response(JSON.stringify(step.body ?? {}), { status: step.status ?? 200 })
  }) as typeof fetch
  const transport: BqTransport = {
    fetch: fetchImpl,
    getToken: async () => 'mock-token',
    now: opts.realClock ? () => Date.now() : () => clock.t,
    sleep: async (ms) => { sleeps.push(ms); clock.t += ms },
  }
  return { transport, calls, sleeps, clock, remaining: () => queue.length }
}

const FIELDS = { fields: [{ name: 'customer_external_id' }, { name: 'order_key' }, { name: 'opt_value' }] }
const JOB = { projectId: 'p', jobId: 'job_1', location: 'asia-southeast1' }
const row = (c: string, k: string, v: string | null) => ({ f: [{ v: c }, { v: k }, { v }] })

test.describe('care B0 — BigQuery client phân trang/poll/timeout (mock) @desktop', () => {
  test('đọc đủ 3 trang, tham số NAMED, giữ location + pageToken, khớp totalRows', async () => {
    const m = mockBq([
      { body: { jobReference: JOB, jobComplete: true, schema: FIELDS, totalRows: '5', rows: [row('C1', 'O1', '100'), row('C1', 'O2', '0')], pageToken: 'tok2' } },
      { body: { jobReference: JOB, jobComplete: true, schema: FIELDS, totalRows: '5', rows: [row('C2', 'O3', '50.5'), row('C3', 'O4', null)], pageToken: 'tok3' } },
      { body: { jobReference: JOB, jobComplete: true, schema: FIELDS, totalRows: '5', rows: [row('C4', 'O5', '-20')] } },
    ])
    const res = await bqQueryAll(m.transport, {
      projectId: 'p', sql: 'SELECT 1', pageSize: 2,
      params: [
        { name: 'ids', type: 'ARRAY', arrayType: 'STRING', values: ['C1', 'C2'] },
        { name: 'from_ts', type: 'TIMESTAMP', value: '2026-10-01T00:00:00+07:00' },
      ],
    })
    expect(res.rows.map((r) => r.order_key)).toEqual(['O1', 'O2', 'O3', 'O4', 'O5'])
    expect(res.rows[3].opt_value).toBeNull() // NULL giữ NULL, không hoá 0
    expect(res.pages).toBe(3)
    expect(res.totalRows).toBe(5)
    expect(m.calls[0].method).toBe('POST')
    expect(m.calls[0].body).toMatchObject({
      useLegacySql: false, maxResults: 2, parameterMode: 'NAMED',
      queryParameters: [
        { name: 'ids', parameterType: { type: 'ARRAY', arrayType: { type: 'STRING' } }, parameterValue: { arrayValues: [{ value: 'C1' }, { value: 'C2' }] } },
        { name: 'from_ts', parameterType: { type: 'TIMESTAMP' }, parameterValue: { value: '2026-10-01T00:00:00+07:00' } },
      ],
    })
    expect(m.calls[1].url).toContain('/queries/job_1?')
    expect(m.calls[1].url).toContain('pageToken=tok2')
    expect(m.calls[1].url).toContain('location=asia-southeast1')
    expect(m.calls[2].url).toContain('pageToken=tok3')
  })

  test('job chưa xong ⇒ poll getQueryResults tới khi xong rồi mới đọc trang', async () => {
    const m = mockBq([
      { body: { jobReference: JOB, jobComplete: false } },
      { body: { jobReference: JOB, jobComplete: false } },
      { body: { jobReference: JOB, jobComplete: true, schema: FIELDS, totalRows: '1', rows: [row('C1', 'O1', '10')] } },
    ])
    const res = await bqQueryAll(m.transport, { projectId: 'p', sql: 'SELECT 1' })
    expect(res.rows).toHaveLength(1)
    expect(m.calls.map((c) => c.method)).toEqual(['POST', 'GET', 'GET'])
    expect(m.calls[1].url).not.toContain('pageToken')
    expect(m.sleeps.length).toBe(2)
  })

  test('job không bao giờ xong ⇒ BigQueryError timeout theo hạn tổng', async () => {
    const forever = Array.from({ length: 50 }, () => ({ body: { jobReference: JOB, jobComplete: false } }))
    const m = mockBq(forever)
    const err = await bqQueryAll(m.transport, { projectId: 'p', sql: 'SELECT 1', deadlineMs: 2_000 }).catch((e) => e)
    expect(err).toBeInstanceOf(BigQueryError)
    expect((err as BigQueryError).kind).toBe('timeout')
    expect(m.calls.length).toBeLessThan(10)
  })

  test('request treo ⇒ bị abort theo hạn, lỗi timeout (không treo handler)', async () => {
    const m = mockBq([{ hang: true }], { realClock: true })
    const started = Date.now()
    const err = await bqQueryAll(m.transport, { projectId: 'p', sql: 'SELECT 1', deadlineMs: 200 }).catch((e) => e)
    expect((err as BigQueryError).kind).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test('lỗi giữa chừng (trang 2 HTTP 403) ⇒ không trả gì, caller giữ nguyên snapshot', async () => {
    let snapshot = { rows: [{ order_key: 'OLD' }], syncedAt: 'T0' }
    async function syncOnce(t: BqTransport): Promise<string> {
      try {
        const r = await bqQueryAll(t, { projectId: 'p', sql: 'SELECT 1', pageSize: 1 })
        snapshot = { rows: r.rows.map((x) => ({ order_key: x.order_key ?? '' })), syncedAt: 'T1' }
        return 'ok'
      } catch (e) {
        return e instanceof BigQueryError ? e.kind : 'unknown'
      }
    }
    const m = mockBq([
      { body: { jobReference: JOB, jobComplete: true, schema: FIELDS, totalRows: '2', rows: [row('C1', 'NEW1', '1')], pageToken: 't2' } },
      { status: 403, body: { error: { message: 'Access Denied' } } },
    ])
    expect(await syncOnce(m.transport)).toBe('http')
    expect(snapshot).toEqual({ rows: [{ order_key: 'OLD' }], syncedAt: 'T0' })

    const net = mockBq([{ networkError: true }])
    expect(await syncOnce(net.transport)).toBe('http')
    expect(snapshot.syncedAt).toBe('T0')
  })

  test('HTTP lỗi giữ status; job lỗi cú pháp (400) cũng là lỗi, không phải 0 dòng', async () => {
    const m = mockBq([{ status: 400, body: { error: { message: 'Syntax error' } } }])
    const err = (await bqQueryAll(m.transport, { projectId: 'p', sql: 'SELEC' }).catch((e) => e)) as BigQueryError
    expect(err.kind).toBe('http')
    expect(err.status).toBe(400)
  })

  test('thiếu trang (rows < totalRows), schema lạ, giá trị lồng ⇒ malformed', async () => {
    const short = mockBq([{ body: { jobReference: JOB, jobComplete: true, schema: FIELDS, totalRows: '3', rows: [row('C1', 'O1', '1')] } }])
    expect(((await bqQueryAll(short.transport, { projectId: 'p', sql: 'x' }).catch((e) => e)) as BigQueryError).kind).toBe('malformed')

    const noJob = mockBq([{ body: { jobComplete: true, schema: FIELDS, totalRows: '0' } }])
    expect(((await bqQueryAll(noJob.transport, { projectId: 'p', sql: 'x' }).catch((e) => e)) as BigQueryError).kind).toBe('malformed')

    const noSchema = mockBq([{ body: { jobReference: JOB, jobComplete: true, totalRows: '0' } }])
    expect(((await bqQueryAll(noSchema.transport, { projectId: 'p', sql: 'x' }).catch((e) => e)) as BigQueryError).kind).toBe('malformed')

    const nested = mockBq([{ body: { jobReference: JOB, jobComplete: true, schema: FIELDS, totalRows: '1', rows: [{ f: [{ v: 'C1' }, { v: [{ v: 'x' }] }, { v: '1' }] }] } }])
    expect(((await bqQueryAll(nested.transport, { projectId: 'p', sql: 'x' }).catch((e) => e)) as BigQueryError).kind).toBe('malformed')
  })

  test('kết quả rỗng hợp lệ ⇒ 0 dòng (khác với lỗi)', async () => {
    const m = mockBq([{ body: { jobReference: JOB, jobComplete: true, schema: FIELDS, totalRows: '0' } }])
    const res = await bqQueryAll(m.transport, { projectId: 'p', sql: 'x' })
    expect(res.rows).toEqual([])
    expect(res.pages).toBe(1)
  })

  test('vượt trần dòng ⇒ row_limit, không trả dữ liệu cắt cụt', async () => {
    const m = mockBq([{ body: { jobReference: JOB, jobComplete: true, schema: FIELDS, totalRows: '10', rows: [] } }])
    const err = (await bqQueryAll(m.transport, { projectId: 'p', sql: 'x', maxRows: 5 }).catch((e) => e)) as BigQueryError
    expect(err.kind).toBe('row_limit')
  })

  test('maxRows = 0 (lô N3 sau khi đã gom đúng trần): 0 dòng ⇒ hợp lệ; 1 dòng ⇒ row_limit', async () => {
    const empty = mockBq([{ body: { jobReference: JOB, jobComplete: true, schema: FIELDS, totalRows: '0' } }])
    expect((await bqQueryAll(empty.transport, { projectId: 'p', sql: 'x', maxRows: 0 })).rows).toEqual([])
    const one = mockBq([{ body: { jobReference: JOB, jobComplete: true, schema: FIELDS, totalRows: '1', rows: [] } }])
    const err = (await bqQueryAll(one.transport, { projectId: 'p', sql: 'x', maxRows: 0 }).catch((e) => e)) as BigQueryError
    expect(err.kind).toBe('row_limit')
  })

  test('tham số: tên sai/trùng/không hữu hạn ⇒ config; NULL và BOOL đúng định dạng REST', () => {
    expect(() => buildQueryParameters([{ name: '1bad', type: 'STRING', value: 'x' }])).toThrow(BigQueryError)
    expect(() => buildQueryParameters([
      { name: 'a', type: 'STRING', value: 'x' }, { name: 'a', type: 'STRING', value: 'y' },
    ])).toThrow(/trùng/)
    expect(() => buildQueryParameters([{ name: 'n', type: 'NUMERIC', value: Number.NaN }])).toThrow()
    expect(buildQueryParameters([
      { name: 'z', type: 'STRING', value: null },
      { name: 'b', type: 'BOOL', value: false },
    ])).toEqual([
      { name: 'z', parameterType: { type: 'STRING' }, parameterValue: {} },
      { name: 'b', parameterType: { type: 'BOOL' }, parameterValue: { value: 'false' } },
    ])
  })

  test('client thật: server-only, dùng SA hiện có; cron KPI không bị sửa', () => {
    const client = read('lib/bigquery/client.ts')
    expect(client).toMatch(/^import 'server-only'/)
    expect(client).toContain("loadServiceAccount('BQ_SERVICE_ACCOUNT_KEY')")
    expect(client).toContain('bigquery.readonly')
    // runBigQuery KPI giữ nguyên hành vi (không phải nơi CRM gọi).
    expect(read('lib/targets/bigquery.ts')).toContain('maxResults: 1000')
    expect(read('lib/bigquery/query.ts')).not.toMatch(/from '@\/lib\/targets/)
  })
})

// ─── Fixture Excel giả ───────────────────────────────────────────────────────
test.describe('care B0 — fixture Excel giả (1 sheet, 10 header, 25 store) @desktop', () => {
  const buf = buildCareImportXlsx()
  const wb = XLSX.read(buf, { type: 'buffer' })
  const aoa = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[CARE_IMPORT_SHEET], { header: 1, raw: false, defval: '' })
  const header = aoa[0]
  const rows = aoa.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])))

  test('đúng một sheet KhachHang và 10 header đúng thứ tự data contract r3.2', () => {
    expect(wb.SheetNames).toEqual(['KhachHang'])
    expect(header).toEqual([...CARE_IMPORT_HEADERS])
    expect(header).toEqual([
      'customer_external_id', 'customer_name', 'customer_phone', 'target_store_code', 'assignee_email',
      'reason_type', 'reason_text', 'product_id', 'product_name', 'product_url',
    ])
  })

  test('25 store, nhiều sản phẩm trên một khách, cột khách nhất quán, (khách, sản phẩm) không trùng', () => {
    expect(new Set(rows.map((r) => r.target_store_code)).size).toBe(25)
    const byCustomer = new Map<string, Record<string, string>[]>()
    for (const r of rows) byCustomer.set(r.customer_external_id, [...(byCustomer.get(r.customer_external_id) ?? []), r])
    expect(byCustomer.size).toBe(100)
    expect([...byCustomer.values()].some((list) => list.length >= 3)).toBe(true)
    for (const list of byCustomer.values()) {
      for (const k of ['customer_name', 'customer_phone', 'target_store_code', 'assignee_email']) {
        expect(new Set(list.map((r) => r[k])).size, k).toBe(1)
      }
      const pids = list.map((r) => r.product_id)
      expect(new Set(pids).size).toBe(pids.length)
    }
  })

  test('đọc lại từ xlsx: SĐT là text giữ số 0 đầu và hợp lệ; ảnh chỉ host CDN hoặc trống', () => {
    for (const r of rows) {
      expect(r.customer_phone).toMatch(/^0\d{9}$/)
      expect(normalizeVnPhone(r.customer_phone)).toBe(r.customer_phone)
      if (r.product_url) expect(new URL(r.product_url).host).toBe('cdn-gcs.thuocsi.vn')
      for (const h of CARE_IMPORT_HEADERS) if (h !== 'product_url') expect(r[h], h).not.toBe('')
    }
    expect(rows.some((r) => r.product_url === '')).toBe(true)
  })

  test('không PII thật: tên/mã/email giả, email miền .invalid', () => {
    for (const r of rows) {
      expect(r.customer_name).toMatch(/^KH QA \d{5}$/)
      expect(r.customer_external_id).toMatch(/^QA-CUST-\d{5}$/)
      expect(r.assignee_email).toMatch(/@example\.invalid$/)
      expect(r.product_id).toMatch(/^QA-SKU-/)
    }
  })

  test('tất định: cùng tham số ⇒ cùng dòng; truyền store thật cho QA mà không sửa builder', () => {
    expect(buildCareImportRows()).toEqual(buildCareImportRows())
    const custom = buildCareImportRows({ stores: [{ code: 'POS0099', assigneeEmails: ['qa@example.invalid'] }], customersPerStore: 2 })
    expect(new Set(custom.map((r) => r.target_store_code))).toEqual(new Set(['POS0099']))
    expect(new Set(custom.map((r) => r.customer_external_id)).size).toBe(2)
  })
})

// ─── Loader credential + gate ghi QA ─────────────────────────────────────────
test.describe('care B0 — loader .env.local (PowerShell-safe) và gate ghi QA @desktop', () => {
  test('parser giữ nguyên ký tự đặc biệt mà shell-source sẽ làm hỏng', () => {
    const text = [
      '﻿# comment',
      'PLAIN=a$b#c d=e!',
      'DQ="has space $HOME"',
      "SQ='$(whoami)'",
      'export EXP=v1',
      'EMPTY=',
      '  INDENTED=ok  ',
      'bad key=x',
      'NOEQ',
      'CRLF=line\r',
    ].join('\n')
    const env = parseEnvText(text)
    expect(env.PLAIN).toBe('a$b#c d=e!')
    expect(env.DQ).toBe('has space $HOME')
    expect(env.SQ).toBe('$(whoami)')
    expect(env.EXP).toBe('v1')
    expect(env.EMPTY).toBe('')
    expect(env.INDENTED).toBe('ok')
    expect(env.CRLF).toBe('line')
    expect(Object.keys(env)).not.toContain('bad key')
    expect(Object.keys(env)).not.toContain('NOEQ')
  })

  test('process env thắng .env.local; rỗng coi như thiếu; chỉ trả TÊN biến thiếu', () => {
    const r = resolveEnv(['A', 'B', 'C', 'D'] as const, {
      processEnv: { A: 'from-process', C: '' },
      file: { A: 'from-file', B: 'file-b', C: '' },
    })
    expect(r.values).toEqual({ A: 'from-process', B: 'file-b' })
    expect(r.missing).toEqual(['C', 'D'])
    const none = resolveEnv(['X'] as const, { processEnv: {}, file: null })
    expect(none.missing).toEqual(['X'])
  })

  test('loader không log và không ghi process.env', () => {
    const src = read('e2e/envLocal.ts')
    expect(src).not.toMatch(/console\./)
    expect(src).not.toMatch(/process\.env\[[^\]]+\]\s*=/)
    expect(src).not.toMatch(/Object\.assign\(process\.env/)
  })

  test('careWriteGate: mọi nhánh từ chối + nhánh đạt', () => {
    const env = { NEXT_PUBLIC_SUPABASE_URL: 'https://db.example.test', E2E_CARE_WRITE_QA: 'YES', E2E_EXPECTED_SUPABASE_HOST: 'db.example.test' }
    expect(careWriteGate({ env, envFileText: null, markerExists: false })).toEqual({ ok: true, host: 'db.example.test' })
    expect(careWriteGate({ env: { ...env, E2E_CARE_WRITE_QA: 'yes' }, envFileText: null, markerExists: false }).ok).toBe(false)
    const leaked = careWriteGate({ env, envFileText: 'X=1\n  E2E_CARE_WRITE_QA=YES\n', markerExists: false })
    expect(leaked.ok).toBe(false)
    expect(!leaked.ok && leaked.reason).toContain('.env.local')
    expect(careWriteGate({ env: { ...env, E2E_EXPECTED_SUPABASE_HOST: 'other' }, envFileText: null, markerExists: false }).ok).toBe(false)
    expect(careWriteGate({ env: { ...env, NEXT_PUBLIC_SUPABASE_URL: 'x' }, envFileText: null, markerExists: false }).ok).toBe(false)
    const marker = careWriteGate({ env, envFileText: null, markerExists: true })
    expect(!marker.ok && marker.reason).toContain(CARE_QA_MARKER)
  })
})
