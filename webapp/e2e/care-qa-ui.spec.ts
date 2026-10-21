import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, expect } from '@playwright/test'
import { CARE_IMPORT_HEADERS, CARE_IMPORT_MAX_ROWS } from '../lib/care/import/contract'
import { parseCareImportCsv } from '../lib/care/import/parse'
import { fixtureCsv } from './careImportFixture'
import { validateCareRows } from '../lib/care/import/validate'
import { handleCareCommit, handleCarePreview, type CareImportDeps, type CareImportQa, type CareImportRepo } from '../lib/care/import/handler'
import { CARE_QA_ISSUE_CODES, CARE_QA_ISSUE_LABELS } from '../lib/care/qa/labels'
import {
  CARE_QA_LOCK_FILE, CARE_QA_MARKER_FILE, CARE_QA_UI_MAX_CUSTOMERS, careImportQaMarker, careQaCommitIssues, careQaRequestAllowed, careQaUiExternalIds,
  evaluateCareQaUi, isLoopbackHostHeader, parseCareQaUiMarker, type CareQaUiMarker,
} from '../lib/care/qa/uiGate'
import { beginCareQaImport, finishCareQaImport } from '../lib/care/qa/uiMarkerIo'
import { careQaMySummary, careQaReportRows } from '../lib/care/qa/mirror'
import { CARE_PRODUCTION_SCOPE, type CareDataScope } from '../lib/care/scope'
import { applyCareTaskFilters } from '../lib/care/browse'
import { applyMyTaskFilters } from '../lib/care/my'
import { pgliteGateway, pgliteImportRepo } from './careQaPglite'

// CRM-CSKH B6-qa-ui (PM audit 10/10 b1-pilot §4–5) — chế độ QA browser trên dev server local trỏ DB prod.
// Không chạm DB/Supabase thật: PGlite + migration 114 THẬT, handler import THẬT, script CLI THẬT.
//   1. Cổng QA (thuần): production build không mở được; thiếu/sai điều kiện ⇒ blocked (CRM tắt), không rơi về thường.
//   2. Handler: server tự đặt is_test=true cho đúng file QA, bỏ qua tham số client, khoá marker TRƯỚC ghi DB đầu.
//   3. Vòng đời: prepare (chỉ đọc, sinh file giả + marker) → preview/import từ "browser" → 5 vai theo RLS + bộ lọc
//      app → chuyển giao/ghi lượt (proof []) → số liệu QA khớp care_report/care_my_summary → down sạch, dữ liệu thật nguyên.
//   4. Crash/retry, marker trộn batch, ID thật lẫn vào, import song song.

const ROOT = path.resolve(__dirname, '..')
const HAS_PGLITE = fs.existsSync(path.join(ROOT, 'node_modules', '@electric-sql', 'pglite'))
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n')

/* eslint-disable @typescript-eslint/no-explicit-any */
const HOST = 'db.example.test'
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const NOW_MID_MONTH = Date.parse('2026-10-15T05:00:00Z') // chỉ cho cổng giao tháng của CLI

const QA_ENV = {
  CARE_QA_UI: 'YES', CARE_ENABLED: 'true', CARE_SYNC_ENABLED: 'false', CARE_QA_UI_BIND: '127.0.0.1',
  NEXT_PUBLIC_SUPABASE_URL: `https://${HOST}`, E2E_EXPECTED_SUPABASE_HOST: HOST,
}

function sampleMarker(over: Partial<CareQaUiMarker> = {}): CareQaUiMarker {
  return {
    v: 2, kind: 'ui', runId: 'a1b2c3d4', host: HOST, createdAt: '2026-10-10T03:00:00.000Z', period: '2026-10-01', phase: 'reserved',
    batchId: UUID(900), fileSha256: 'f'.repeat(64), externalIds: careQaUiExternalIds('a1b2c3d4', 3),
    accounts: { super: UUID(1), marketing: UUID(2), sm: UUID(3), staff: [UUID(4), UUID(5)] }, storeIds: [UUID(10), UUID(11)], ...over,
  }
}
const gate = (over: { nodeEnv?: string; env?: Record<string, string | undefined>; envFiles?: { name: string; text: string | null }[]; marker?: unknown; markerText?: string | null; period?: string } = {}) =>
  evaluateCareQaUi({
    nodeEnv: 'nodeEnv' in over ? over.nodeEnv : 'development', env: { ...QA_ENV, ...over.env }, envFiles: over.envFiles ?? [{ name: '.env.local', text: 'NEXT_PUBLIC_SUPABASE_URL=x\n' }],
    markerText: over.markerText !== undefined ? over.markerText : JSON.stringify(over.marker ?? sampleMarker()), period: over.period ?? '2026-10-01',
  })

// ── 1. Cổng QA (thuần) ────────────────────────────────────────────────────────
test.describe('care B6-qa-ui — cổng chế độ QA (thuần) @desktop', () => {
  test('production build / không bật CARE_QA_UI ⇒ off (hành vi production y nguyên) dù mọi điều kiện khác đủ', () => {
    expect(gate({ nodeEnv: 'production' })).toEqual({ kind: 'off' })
    expect(gate({ nodeEnv: 'test' })).toEqual({ kind: 'off' })
    expect(gate({ nodeEnv: undefined as any })).toEqual({ kind: 'off' })
    expect(gate({ env: { CARE_QA_UI: undefined }, markerText: null })).toEqual({ kind: 'off' })
    expect(gate({ env: { CARE_QA_UI: '' }, markerText: null })).toEqual({ kind: 'off' })
    expect(gate({ env: { CARE_QA_UI: undefined }, marker: { v: 1, runId: 'deadbeef' } })).toEqual({ kind: 'off' }) // fixture v1: không phải lượt UI
    expect(gate({ nodeEnv: 'production', env: { CARE_QA_UI: undefined } })).toEqual({ kind: 'off' })
    expect(gate()).toMatchObject({ kind: 'active', marker: { batchId: UUID(900) } })
  })

  test('bật CARE_QA_UI nhưng thiếu/sai điều kiện ⇒ blocked với mã (fail-closed, KHÔNG về chế độ thường)', () => {
    const cases: [string, Parameters<typeof gate>[0], string][] = [
      // security P1-1: còn marker QA UI mà dev server không chạy qua serve (thiếu cờ) ⇒ KHÔNG chạy production trên file QA.
      ['marker UI còn, thiếu cờ', { env: { CARE_QA_UI: undefined } }, 'NOT_QA_LAUNCH'],
      ['marker UI còn, thiếu cờ, đang dọn', { env: { CARE_QA_UI: undefined }, marker: sampleMarker({ phase: 'tearing_down' }) }, 'NOT_QA_LAUNCH'],
      ['marker hỏng, thiếu cờ', { env: { CARE_QA_UI: undefined }, markerText: '{' }, 'NOT_QA_LAUNCH'],
      ['giá trị cờ khác YES', { env: { CARE_QA_UI: 'yes' } }, 'FLAG_VALUE'],
      ['CARE_QA_UI trong .env.local', { envFiles: [{ name: '.env.local', text: 'CARE_QA_UI=YES\n' }] }, 'FLAG_IN_ENV_FILE'],
      ['export … trong .env', { envFiles: [{ name: '.env', text: '  export E2E_EXPECTED_SUPABASE_HOST = x\n' }] }, 'FLAG_IN_ENV_FILE'],
      ['CARE_QA_UI_BIND trong .env.development', { envFiles: [{ name: '.env.development', text: 'CARE_QA_UI_BIND=127.0.0.1\n' }] }, 'FLAG_IN_ENV_FILE'],
      ['CARE_ENABLED=true trong file env', { envFiles: [{ name: '.env.local', text: 'CARE_ENABLED="true"\n' }] }, 'FLAG_IN_ENV_FILE'],
      ['CARE_SYNC_ENABLED=true trong file env', { envFiles: [{ name: '.env.development.local', text: 'CARE_SYNC_ENABLED=true\n' }] }, 'FLAG_IN_ENV_FILE'],
      ['CARE_ENABLED tắt', { env: { CARE_ENABLED: 'false' } }, 'CARE_DISABLED'],
      ['sync bật', { env: { CARE_SYNC_ENABLED: 'true' } }, 'SYNC_ON'],
      ['bind 0.0.0.0', { env: { CARE_QA_UI_BIND: '0.0.0.0' } }, 'BIND'],
      ['bind thiếu', { env: { CARE_QA_UI_BIND: undefined } }, 'BIND'],
      ['host gõ lại sai', { env: { E2E_EXPECTED_SUPABASE_HOST: 'khac.vn' } }, 'HOST'],
      ['không có marker', { markerText: null }, 'NO_MARKER'],
      ['marker không phải JSON', { markerText: '{' }, 'MARKER_INVALID'],
      ['marker fixture v1', { marker: { v: 1, runId: 'deadbeef' } }, 'MARKER_INVALID'],
      ['marker host khác', { marker: sampleMarker({ host: 'khac.vn' }) }, 'MARKER_HOST'],
      ['marker kỳ trước', { period: '2026-11-01' }, 'MARKER_PERIOD'],
      ['marker đang dọn', { marker: sampleMarker({ phase: 'tearing_down' }) }, 'MARKER_TEARDOWN'],
    ]
    for (const [name, over, reason] of cases) expect(gate(over), name).toEqual({ kind: 'blocked', reason })
    // CARE_ENABLED=false trong file vẫn được (process bật đè) — chỉ cấm BẬT trong file.
    expect(gate({ envFiles: [{ name: '.env.local', text: 'CARE_ENABLED=false\nCARE_SYNC_ENABLED=false\n' }] }).kind).toBe('active')
  })

  test('marker: mọi trường sai ⇒ không hợp lệ (ID giả phải suy ra từ runId, tài khoản khác nhau, uuid/sha/kỳ đúng dạng)', () => {
    expect(parseCareQaUiMarker(sampleMarker())).not.toBeNull()
    const bad: Partial<CareQaUiMarker>[] = [
      { runId: 'xyz' }, { period: '2026-10-02' }, { phase: 'ready' as any }, { batchId: 'b' }, { fileSha256: 'abc' },
      { externalIds: ['QA-UI-a1b2c3d4-001', 'KH-THAT-1'] }, { externalIds: careQaUiExternalIds('deadbeef', 3) }, { externalIds: [] },
      { externalIds: ['QA-UI-a1b2c3d4-001', 'QA-UI-a1b2c3d4-001'] },
      { accounts: { super: UUID(1), marketing: UUID(1), sm: UUID(3), staff: [UUID(4)] } }, { accounts: { super: UUID(1), marketing: UUID(2), sm: UUID(3), staff: [] } },
      { storeIds: [] }, { importResult: 'ok' as any }, { taskIds: ['x'] },
    ]
    for (const b of bad) expect(parseCareQaUiMarker(sampleMarker(b)), JSON.stringify(b)).toBeNull()
  })

  test('theo request: Host loopback + đúng tài khoản QA; production luôn qua; blocked luôn chặn', () => {
    for (const h of ['localhost:3100', '127.0.0.1:3100', '[::1]:3100', 'LOCALHOST']) expect(isLoopbackHostHeader(h), h).toBe(true)
    for (const h of ['192.168.1.5:3100', 'duocsi.circa.vn', 'localhost.evil.vn', '', null]) expect(isLoopbackHostHeader(h), String(h)).toBe(false)
    const active = gate()
    const m = sampleMarker()
    for (const uid of [m.accounts.super, m.accounts.marketing, m.accounts.sm, ...m.accounts.staff]) {
      expect(careQaRequestAllowed(active, { hostHeader: 'localhost:3100', userId: uid })).toBe(true)
    }
    expect(careQaRequestAllowed(active, { hostHeader: 'localhost:3100', userId: UUID(99) })).toBe(false) // QLCH/người khác
    expect(careQaRequestAllowed(active, { hostHeader: '192.168.1.5:3100', userId: m.accounts.super })).toBe(false)
    expect(careQaRequestAllowed({ kind: 'off' }, { hostHeader: 'duocsi.circa.vn', userId: UUID(99) })).toBe(true)
    expect(careQaRequestAllowed({ kind: 'blocked', reason: 'HOST' }, { hostHeader: 'localhost', userId: m.accounts.super })).toBe(false)
  })

  test('lý do không cho import file QA (thuần)', () => {
    const m = careImportQaMarker(sampleMarker())
    const lookups = { customers: new Map(), staff: [{ id: UUID(4), storeId: UUID(10), email: 'a@x', fullName: 'A' }], currentPeriodTaskCount: 0, openPreviousPeriodCount: 0 }
    const base = { marker: m, sha256: m.fileSha256, actorId: UUID(2), period: '2026-10-01', externalIds: [...m.externalIds], emails: ['a@x', 'a@x', 'a@x'], lookups }
    expect(careQaCommitIssues(base)).toEqual([])
    expect(careQaCommitIssues({ ...base, sha256: '0'.repeat(64) })).toEqual(['QA_FILE_NOT_MARKED'])
    expect(careQaCommitIssues({ ...base, actorId: UUID(3) })).toEqual(['QA_IMPORTER']) // SM không import
    expect(careQaCommitIssues({ ...base, externalIds: [...m.externalIds.slice(0, 2), 'KH-THAT-1'] })).toEqual(['QA_IDS_MISMATCH'])
    expect(careQaCommitIssues({ ...base, lookups: { ...lookups, customers: new Map([[m.externalIds[0], { id: UUID(50), isTest: false }]]) } })).toEqual(['QA_ID_CLASH'])
    expect(careQaCommitIssues({ ...base, emails: ['a@x', 'khac@x', 'a@x'] })).toEqual(['QA_ASSIGNEE'])
    expect(careQaCommitIssues({ ...base, lookups: { ...lookups, staff: [{ id: UUID(77), storeId: UUID(10), email: 'a@x', fullName: 'X' }] } })).toEqual(['QA_ASSIGNEE'])
    expect(careQaCommitIssues({ ...base, lookups: { ...lookups, openPreviousPeriodCount: 2 } })).toEqual(['QA_OPEN_PREVIOUS'])
    expect(careQaCommitIssues({ ...base, lookups: { ...lookups, currentPeriodTaskCount: 1 } })).toEqual(['QA_TEST_TASKS_EXIST'])
    expect(careQaCommitIssues({ ...base, marker: { ...m, phase: 'imported' } })).toEqual(['QA_ALREADY_USED'])
    expect(careQaCommitIssues({ ...base, period: '2026-11-01' })).toEqual(['QA_PERIOD'])
    for (const c of CARE_QA_ISSUE_CODES) expect(CARE_QA_ISSUE_LABELS[c], c).toMatch(/^Chế độ QA: /)
  })

  test('phạm vi dữ liệu: production = is_test false (mặc định, mọi bộ lọc cũ y nguyên); QA = is_test true + đúng batch', () => {
    const rec = () => { const calls: string[] = []; const b: any = { eq: (c: string, v: unknown) => { calls.push(`${c}=${v}`); return b }, is: () => b, not: () => b, lt: () => b }; return { b, calls } }
    const f = { month: '2026-10-01', storeId: null, assigneeId: null, status: null }
    const p = rec(); applyCareTaskFilters(p.b, f, '2026-10-10')
    expect(p.calls).toEqual(['period_month=2026-10-01', 'is_test=false'])
    const q = rec(); applyCareTaskFilters(q.b, f, '2026-10-10', { kind: 'qa', batchId: UUID(900) })
    expect(q.calls).toEqual(['period_month=2026-10-01', 'is_test=true', `batch_id=${UUID(900)}`])
    const my = rec(); applyMyTaskFilters(my.b, UUID(4), UUID(10), '2026-10-01', 'all', '2026-10-10', { kind: 'qa', batchId: UUID(900) })
    expect(my.calls).toEqual([`assignee_id=${UUID(4)}`, `store_id=${UUID(10)}`, 'period_month=2026-10-01', 'is_test=true', `batch_id=${UUID(900)}`])
    const my0 = rec(); applyMyTaskFilters(my0.b, UUID(4), UUID(10), '2026-10-01', 'all', '2026-10-10')
    expect(my0.calls).toContain('is_test=false')
  })

  test('nguồn: production không mở được; mọi đọc task qua phạm vi; QA không nhận proof/GCS; handler không đọc is_test từ client', () => {
    const qaUi = read('lib/care/server/qaUi.ts')
    const body = qaUi.slice(qaUi.indexOf('export function careQaUiState'))
    expect(body.split('\n')[1].trim()).toBe("if (process.env.NODE_ENV !== 'development') return CARE_QA_OFF") // trước mọi đọc file
    expect(read('lib/care/flags.ts')).toContain("careFlagsFromEnv(process.env).enabled && careQaUiState().kind !== 'blocked'")
    // Không còn lọc is_test cứng ở đường đọc task — tất cả qua careDataScope (lib/care/scope.ts).
    for (const f of ['lib/care/server/browse.ts', 'lib/care/server/my.ts', 'lib/care/server/reports.ts', 'app/actions/careMy.ts', 'app/actions/care.ts',
      'app/(dashboard)/care/my/[id]/update/page.tsx', 'app/(dashboard)/care/my/[id]/page.tsx', 'app/(dashboard)/care/tasks/[id]/page.tsx']) {
      expect(read(f), f).not.toMatch(/\.eq\('is_test'/)
    }
    expect(read('app/actions/careMy.ts')).toMatch(/isCareQaActive\(\) && Array\.isArray\(input\?\.proofUrls\) && input\.proofUrls\.length > 0/)
    // security P1-2: chuyển giao ở QA chỉ task batch QA + đích là dược sĩ QA (action + danh sách đích).
    const careActions = read('app/actions/care.ts')
    expect(careActions.indexOf('await careQaTransferBlock(valid.taskIds, valid.toUserId)')).toBeGreaterThan(0)
    expect(careActions.indexOf('await careQaTransferBlock(')).toBeLessThan(careActions.indexOf("supabase.rpc('care_transfer_tasks'"))
    const block = /export async function careQaTransferBlock[\s\S]*?\n\}/.exec(read('lib/care/server/browse.ts'))![0]
    expect(block).toMatch(/if \(scope\.kind !== 'qa'\) return null\n/) // production: không đọc gì
    expect(block).toContain("if (!(careQaStaffIds() ?? []).includes(toUserId)) return 'TARGET_INVALID'")
    expect(block).toContain("return error || count !== taskIds.length ? 'TASK_NOT_FOUND' : null")
    expect(read('lib/care/server/browse.ts')).toContain('.filter((u) => qaStaff === null || qaStaff.includes(u.id))')
    // Q-107 (B7-ui r1.1, thay PM r1 P1): QA cũng mở tel:/sms: — số là phone_norm của task đang xem; trang chi tiết
    // chỉ đọc task qua loadCareTaskDetail (withScope ⇒ applyCareScope(careDataScope()): QA = is_test + batch marker)
    // nên luôn là số bản sao QA.
    // Hai trang chỉ truyền cờ hiển thị dòng nhận biết QA; không còn nhánh nào bỏ/giả liên kết.
    for (const f of ['app/(dashboard)/care/my/[id]/page.tsx', 'app/(dashboard)/care/tasks/[id]/page.tsx']) {
      expect(read(f), f).toContain('qa={isCareQaActive()}')
      expect(read(f), f).toContain('detail = await loadCareTaskDetail(id)')
      expect(read(f), f).not.toMatch(/contactLinks|phone_(raw|norm)/)
    }
    const browse = read('lib/care/server/browse.ts')
    expect(browse).toContain('return applyCareScope(q as unknown as LooseBuilder, careDataScope()) as unknown as T')
    expect(/export async function loadCareTaskDetail[\s\S]*?\n\}/.exec(browse)![0]).toMatch(/const \{ data: task, error \} = await withScope\(supabase\.from\('care_tasks'\)/)
    // Đếm trên MÃ (bỏ comment): mọi tel:/sms: trong code đều là href từ phone_norm của task đang xem.
    const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '')
    const myDetail = code('components/care/CareMyTaskDetail.tsx')
    expect(myDetail).not.toMatch(/contactLinks|aria-disabled/)
    expect(myDetail.match(/href=\{`(tel|sms):\$\{t\.phone_norm\}`\}/g)).toHaveLength(2) // đúng 2 link, đều từ phone_norm của task
    expect(myDetail.match(/(tel|sms):/g)).toHaveLength(2)
    const adminDetail = code('components/care/CareTaskDetailView.tsx')
    expect(adminDetail).not.toMatch(/contactLinks/)
    expect(adminDetail.match(/href=\{`tel:\$\{t\.phone_norm\}`\}/g)).toHaveLength(1)
    expect(adminDetail.match(/(tel|sms):/g)).toHaveLength(1)
    expect(read('app/actions/uploads.ts')).toMatch(/if \(isCareQaActive\(\)\) return \{ error: 'Chế độ QA không nhận ảnh minh chứng' \}/)
    const handler = read('lib/care/import/handler.ts')
    expect(handler).not.toMatch(/form\.get\('(is_?test|isTest|qa|batch)/i)
    expect(handler).toContain('isTest: qa !== null')
    // care_report/care_my_summary production vẫn loại is_test (114 không đổi); QA tính lại qua mirror.
    expect(read('lib/care/server/browse.ts')).toContain('p_include_test: false')
    expect(read('lib/care/server/reports.ts')).toContain('p_include_test: false')
  })
})

// ── 2. Handler import ở chế độ QA (repo giả) ───────────────────────────────────
/** File N1 CSV UTF-8 (Q-124) — như Excel "CSV UTF-8" và file mẫu của app. */
function textCsv(rows: Record<string, string>[]): Uint8Array<ArrayBuffer> {
  const bytes = new TextEncoder().encode(fixtureCsv([[...CARE_IMPORT_HEADERS], ...rows.map((r) => CARE_IMPORT_HEADERS.map((h) => r[h] ?? ''))]))
  const out = new Uint8Array(new ArrayBuffer(bytes.byteLength))
  out.set(bytes)
  return out
}
const row = (ext: string, i: number, store: string, email: string, pid = `P${i}`) => ({
  customer_external_id: ext, customer_name: `KH QA ${i}`, customer_phone: `039001${String(i).padStart(4, '0')}`, target_store_code: store,
  assignee_email: email, reason_type: 'chronic', reason_text: 'Dùng thuốc định kỳ', product_id: pid, product_name: `SP ${pid}`, product_url: '',
})
async function request(bytes: Uint8Array, fields: Record<string, string> = {}) {
  const fd = new FormData()
  fd.append('file', new File([new Uint8Array(bytes)], 'ban-qa.csv', { type: 'text/csv' }))
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  const tmp = new Request('http://localhost/x', { method: 'POST', body: fd })
  const body = new Uint8Array(await tmp.arrayBuffer())
  return new Request('http://localhost/x', { method: 'POST', headers: { 'content-type': tmp.headers.get('content-type')!, 'content-length': String(body.byteLength) }, body, duplex: 'half' } as RequestInit)
}
const sha = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex')
const vnPeriod = () => `${new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 7)}-01`

test.describe('care B6-qa-ui — handler import chế độ QA (repo giả) @desktop', () => {
  const STORE = 'QAOS01', EMAIL = 'qa.care.s01a@example.invalid'
  function fakeWorld(bytes: Uint8Array, over: { actor?: string; customers?: Map<string, any>; openPrev?: number; curTest?: number; begin?: boolean } = {}) {
    const marker = sampleMarker({ fileSha256: sha(bytes), period: vnPeriod() })
    const calls: string[] = []
    const lookups = () => ({
      storesByCode: new Map([[STORE, { id: UUID(10), code: STORE, name: 'QA 1' }]]),
      staff: [{ id: UUID(4), storeId: UUID(10), email: EMAIL, fullName: 'DS QA' }],
      customers: over.customers ?? new Map(), refusals: new Set<string>(), currentTasks: new Map(),
      currentPeriodTaskCount: over.curTest ?? 0, openPreviousPeriodCount: over.openPrev ?? 0,
    })
    const repo: CareImportRepo = {
      loadLookups: async (i) => { calls.push(`loadLookups:isTest=${i.isTest}`); return lookups() },
      createBatch: async (i) => { calls.push(`createBatch:${JSON.stringify({ isTest: i.isTest, id: i.id ?? null })}`); return i.id ?? 'prod-batch' },
      stageRows: async () => { calls.push('stageRows') },
      finalize: async (id) => { calls.push('finalize'); return { status: 'committed', batch_id: id } },
      discardBatch: async () => { calls.push('discardBatch') },
      purgeStaleStaging: async () => { calls.push('purgeStaleStaging') },
    }
    const qa: CareImportQa = {
      marker: careImportQaMarker(marker),
      begin: async () => { calls.push('begin'); return over.begin ?? true },
      finish: async (r) => { calls.push(`finish:${r}`) },
    }
    const deps: CareImportDeps = { enabled: true, maxBytes: 8 * 1024 * 1024, getAccess: async () => ({ kind: 'ok', actorId: over.actor ?? UUID(2) }), repo, now: () => new Date(), qa }
    return { marker, calls, deps }
  }
  const qaRows = careQaUiExternalIds('a1b2c3d4', 3).map((x, i) => row(x, i + 1, STORE, EMAIL))
  const qaFile = textCsv(qaRows)

  test('file QA: server tự đặt is_test=true + batch id marker, BỎ QUA is_test/batch client gửi; khoá TRƯỚC ghi đầu; không dọn staging ngoài phạm vi', async () => {
    const { calls, deps, marker } = fakeWorld(qaFile)
    const res = await handleCareCommit(await request(qaFile, { sha256: sha(qaFile), period: vnPeriod(), is_test: 'false', isTest: '0', batch_id: UUID(1) }), deps)
    expect(res.status, await res.clone().text()).toBe(200)
    expect(calls).toEqual(['loadLookups:isTest=true', 'begin', `createBatch:${JSON.stringify({ isTest: true, id: marker.batchId })}`, 'stageRows', 'finalize', 'finish:committed'])
  })

  test('preview file QA ⇒ commitAllowed; file KHÁC (bản gốc) ⇒ preview production chỉ đọc + QA_FILE_NOT_MARKED; commit file khác bị chặn trước mọi đọc DB', async () => {
    const { calls, deps } = fakeWorld(qaFile)
    const p1 = await (await handleCarePreview(await request(qaFile), deps)).json()
    expect(p1).toMatchObject({ ok: true, qa: { commitAllowed: true, issues: [] } })
    const other = textCsv([row('KH-THAT-1', 1, STORE, EMAIL)])
    const p2 = await (await handleCarePreview(await request(other), deps)).json()
    expect(p2).toMatchObject({ ok: true, qa: { commitAllowed: false, issues: ['QA_FILE_NOT_MARKED'] } })
    expect(calls).toEqual(['loadLookups:isTest=true', 'loadLookups:isTest=false'])
    calls.length = 0
    const c = await handleCareCommit(await request(other, { sha256: sha(other), period: vnPeriod() }), deps)
    expect(c.status).toBe(409)
    expect(await c.json()).toMatchObject({ code: 'QA_FILE_NOT_MARKED' })
    expect(calls).toEqual([])
  })

  test('mọi lý do QA ⇒ 409 TRƯỚC khi khoá/ghi; khoá bận ⇒ QA_BUSY không ghi; lỗi giữa chừng ⇒ dọn batch staged + finish failed', async () => {
    const cases: [string, Parameters<typeof fakeWorld>[1], string][] = [
      ['SM không import', { actor: UUID(3) }, 'QA_IMPORTER'],
      ['ID giả đã tồn tại', { customers: new Map([[careQaUiExternalIds('a1b2c3d4', 1)[0], { id: UUID(60), isTest: true }]]) }, 'QA_ID_CLASH'],
      ['còn task mở kỳ trước', { openPrev: 1 }, 'QA_OPEN_PREVIOUS'],
      ['kỳ này có task test khác', { curTest: 2 }, 'QA_TEST_TASKS_EXIST'],
    ]
    for (const [name, over, code] of cases) {
      const { calls, deps } = fakeWorld(qaFile, over)
      const res = await handleCareCommit(await request(qaFile, { sha256: sha(qaFile), period: vnPeriod() }), deps)
      expect(res.status, name).toBe(409)
      expect((await res.json()).code, name).toBe(code)
      expect(calls.filter((c) => !c.startsWith('loadLookups')), name).toEqual([])
    }
    const busy = fakeWorld(qaFile, { begin: false })
    const r2 = await handleCareCommit(await request(qaFile, { sha256: sha(qaFile), period: vnPeriod() }), busy.deps)
    expect((await r2.json()).code).toBe('QA_BUSY')
    expect(busy.calls).toEqual(['loadLookups:isTest=true', 'begin'])
    const boom = fakeWorld(qaFile)
    boom.deps.repo.stageRows = async () => { boom.calls.push('stageRows'); throw new Error('x') }
    const r3 = await handleCareCommit(await request(qaFile, { sha256: sha(qaFile), period: vnPeriod() }), boom.deps)
    expect((await r3.json()).code).toBe('STAGING_FAILED')
    expect(boom.calls.slice(-3)).toEqual(['stageRows', 'discardBatch', 'finish:failed'])
  })

  test('production (qa null) không đổi: is_test=false, không id, có dọn staging cơ hội; file QA-UI-… bị từ chối (security P1-1)', async () => {
    const realFile = textCsv([row('KH-1', 1, STORE, EMAIL), row('KH-2', 2, STORE, EMAIL)])
    const { calls, deps } = fakeWorld(realFile)
    deps.qa = null
    const res = await handleCareCommit(await request(realFile, { sha256: sha(realFile), period: vnPeriod(), is_test: 'true' }), deps)
    expect(res.status).toBe(200)
    expect(calls).toEqual(['loadLookups:isTest=false', 'purgeStaleStaging', `createBatch:${JSON.stringify({ isTest: false, id: null })}`, 'stageRows', 'finalize'])
    expect(JSON.stringify(await (await handleCarePreview(await request(realFile), deps)).json())).not.toContain('"qa"')
    calls.length = 0
    const p = await (await handleCarePreview(await request(qaFile), deps)).json()
    expect(p).toMatchObject({ ok: true, qa: { commitAllowed: false, issues: ['QA_FILE_IN_PRODUCTION'] } })
    const c = await handleCareCommit(await request(qaFile, { sha256: sha(qaFile), period: vnPeriod() }), deps)
    expect(c.status).toBe(409)
    expect((await c.json()).code).toBe('QA_FILE_IN_PRODUCTION')
    expect(calls.filter((x) => !x.startsWith('loadLookups'))).toEqual([]) // không ghi gì
  })
})

// ── 3–4. Vòng đời trên PGlite (114 thật) ───────────────────────────────────────
test.describe('care B6-qa-ui — vòng đời prepare → import browser → 5 vai → down trên PGlite (114 thật) @desktop', () => {
  test.skip(!HAS_PGLITE, 'chưa cài PGlite — npm i --no-save @electric-sql/pglite@0.2.17 (trong webapp/)')
  test.setTimeout(300_000)

  /** File N1 "gốc" giả lập: 13 dòng / 12 khách / 13 sản phẩm, store/dược sĩ khác QA, một reason_text chứa SĐT. */
  function originalFile(L: any) {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      customer_external_id: `KH-THAT-${i + 1}`, customer_name: `Nguyen Van ${i + 1}`, customer_phone: `09${String(10_000_000 + i)}`,
      target_store_code: 'QAOS05', assignee_email: L.STORES[4].assigneeEmails[0], reason_type: 'chronic',
      reason_text: i === 3 ? 'Gọi lại số 0912345678 sau 18h' : 'Dùng thuốc định kỳ, sắp hết liều', product_id: `SKU-${i + 1}`,
      product_name: `San pham ${i + 1}`, product_url: `https://cdn-gcs.thuocsi.vn/qa-fixture/SKU-${i + 1}.png`,
    }))
    rows.push({ ...rows[2], product_id: 'SKU-3B', product_name: 'San pham 3B', product_url: '' })
    return { rows, bytes: textCsv(rows) }
  }

  async function setup() {
    const { PGlite } = await import('@electric-sql/pglite')
    const L: any = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib-care-pglite.mjs')).href)
    const F: any = await import(pathToFileURL(path.join(ROOT, 'scripts', 'care-qa-fixture.mjs')).href)
    const db: any = await L.freshDb(PGlite)
    await db.query(`INSERT INTO public.app_migrations (version, name) VALUES ('114', 'care_crm_foundation') ON CONFLICT DO NOTHING`)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'care-qa-ui-'))
    const markerPath = path.join(dir, CARE_QA_MARKER_FILE)
    const env = {
      NEXT_PUBLIC_SUPABASE_URL: `https://${HOST}`, E2E_CARE_WRITE_QA: 'YES', E2E_EXPECTED_SUPABASE_HOST: HOST,
      E2E_SUPER_EMAIL: L.SUPER_EMAIL, E2E_MKT_ADMIN_EMAIL: 'qa.mkt@example.invalid', E2E_SM_EMAIL: 'qa.sm@example.invalid',
      E2E_STAFF_EMAIL: L.EA, E2E_CARE_TRANSFER_TO_EMAIL: L.EC,
    }
    const gw = pgliteGateway(db, L, {})
    const { today, period } = F.vnToday()
    let out: Uint8Array | null = null
    const ctx = { gw, env, envFileText: 'NEXT_PUBLIC_SUPABASE_URL=x\n', markerPath, nowMs: NOW_MID_MONTH, writeOut: (b: Uint8Array) => { out = b } }
    const totalTest = async () => Number((await db.query(`SELECT
      (SELECT count(*) FROM public.care_import_batches WHERE is_test) + (SELECT count(*) FROM public.care_customers WHERE is_test)
      + (SELECT count(*) FROM public.care_tasks WHERE is_test) + (SELECT count(*) FROM public.care_interactions WHERE is_test)
      + (SELECT count(*) FROM public.care_assignment_events WHERE is_test) + (SELECT count(*) FROM public.care_store_refusals WHERE is_test)
      + (SELECT count(*) FROM public.care_task_products p JOIN public.care_tasks t ON t.id = p.task_id WHERE t.is_test)
      + (SELECT count(*) FROM public.care_import_staging s JOIN public.care_import_batches b ON b.id = s.batch_id WHERE b.is_test) AS n`)).rows[0].n)
    const real = async () => (await db.query(`SELECT
      (SELECT count(*) FROM public.care_tasks WHERE NOT is_test)::int AS tasks, (SELECT count(*) FROM public.care_customers WHERE NOT is_test)::int AS customers,
      (SELECT count(*) FROM public.care_interactions WHERE NOT is_test)::int AS interactions, (SELECT count(*) FROM public.care_import_batches WHERE NOT is_test)::int AS batches`)).rows[0]
    const marker = () => JSON.parse(fs.readFileSync(markerPath, 'utf8'))
    const prepared = () => { if (!out) throw new Error('chưa prepare'); return out }
    /** Deps handler như lib/care/server/importDeps.ts ở chế độ QA, IO marker THẬT trên thư mục tạm. */
    const qaDeps = (actorId: string, repo: CareImportRepo = pgliteImportRepo(db, L, today)): CareImportDeps => {
      const m = parseCareQaUiMarker(marker())!
      return {
        enabled: true, maxBytes: 8 * 1024 * 1024, getAccess: async () => ({ kind: 'ok', actorId }), repo, now: () => new Date(),
        qa: { marker: careImportQaMarker(m), begin: async () => beginCareQaImport(dir, m.batchId), finish: async (r) => finishCareQaImport(dir, m.batchId, r) },
      }
    }
    return { db, L, F, gw, env, ctx, dir, markerPath, today, period, totalTest, real, marker, prepared, qaDeps }
  }

  /** Dữ liệu THẬT (is_test=false) đa dạng ở store 1/2/3 — phải còn nguyên sau down, và dùng cho parity mirror ↔ SQL. */
  async function seedReal(db: any, L: any, today: string, period: string) {
    const rows = [
      L.row('REAL-1', 'QAOS01', L.EA, 'R1'), L.row('REAL-2', 'QAOS01', L.EB, 'R2'), L.row('REAL-3', 'QAOS02', L.EC, 'R3'),
      L.row('REAL-4', 'QAOS02', L.ED, 'R4'), L.row('REAL-5', 'QAOS03', L.STORES[2].assigneeEmails[0], 'R5'),
    ]
    expect((await L.finalize(db, await L.stage(db, rows, { period }), L.U.mkt, today)).status).toBe('committed')
    const t = async (ext: string) => (await L.taskOf(db, ext, period)).id
    await L.record(db, today, L.U.A, await t('REAL-1'), 'CALLBACK', 'hẹn lại', today)
    await L.record(db, today, L.U.C, await t('REAL-3'), 'NO_NEED', 'không cần')
    await L.transfer(db, today, L.U.sm, [await t('REAL-4')], L.U.A, 'chuyển')
  }

  const ROLES = (L: any) => ({ super: L.U.super, marketing: L.U.mkt, sm: L.U.sm, duocsi2: L.U.A, duocsi3: L.U.C, qlch: L.U.qlch1 })

  /** Đọc task QUA RLS của vai, với ĐÚNG điều kiện bộ lọc app (applyCareTaskFilters) dịch sang SQL. */
  async function rlsTasks(db: any, L: any, uid: string, period: string, scope: CareDataScope, extra: (b: any) => any = (b) => b) {
    const conds: [string, unknown][] = []
    const b: any = { eq: (c: string, v: unknown) => { conds.push([c, v]); return b }, is: () => b, not: () => b, lt: () => b }
    extra(applyCareTaskFilters(b, { month: period, storeId: null, assigneeId: null, status: null }, period, scope))
    const sql = `SELECT id, store_id, assignee_id, status, last_interaction_at, first_overdue_on, next_action_date FROM public.care_tasks
                 WHERE ${conds.map(([c], i) => `${c} = $${i + 1}`).join(' AND ')} ORDER BY id`
    return L.as(db, uid, async () => (await db.query(sql, conds.map(([, v]) => v))).rows.map((r: any) => ({
      ...r, next_action_date: r.next_action_date instanceof Date ? r.next_action_date.toISOString().slice(0, 10) : r.next_action_date,
      first_overdue_on: r.first_overdue_on instanceof Date ? r.first_overdue_on.toISOString().slice(0, 10) : r.first_overdue_on,
    })))
  }
  const sqlReport = (db: any, L: any, uid: string, period: string, includeTest: boolean, storeIds: string[] | null = null) =>
    L.as(db, uid, async () => (await db.query(`SELECT * FROM public.care_report($1::date, $2::uuid[], $3)`, [period, storeIds, includeTest])).rows)
  const strip = (rows: any[]) => rows.map(({ converted_tasks: _c, ...r }) => r)

  test('trọn luồng: prepare (chỉ đọc) → preview gốc/QA → import QA → 5 vai + chuyển giao + ghi lượt → số liệu QA khớp SQL → down sạch, dữ liệu thật nguyên', async () => {
    const { db, L, F, ctx, markerPath, dir, today, period, totalTest, real, marker, prepared, qaDeps } = await setup()
    await seedReal(db, L, today, period)
    const realBefore = await real()
    const orig = originalFile(L)

    // prepare: KHÔNG ghi DB; marker v2 hợp lệ cả hai phía (CLI + server); file giả đúng cấu trúc.
    const dbBefore = Number((await db.query(`SELECT (SELECT count(*) FROM public.care_import_batches) + (SELECT count(*) FROM public.care_customers) AS n`)).rows[0].n)
    const prep = await F.cmdPrepare({ ...ctx, originalBytes: orig.bytes })
    expect(prep).toEqual({ ok: true, period, rows: 13, customers: 12, products: 13, stores: 1, assignees: 1, reasonText: 'mẫu QA' })
    expect(Number((await db.query(`SELECT (SELECT count(*) FROM public.care_import_batches) + (SELECT count(*) FROM public.care_customers) AS n`)).rows[0].n)).toBe(dbBefore)
    const m = parseCareQaUiMarker(marker())!
    expect(m).toMatchObject({ v: 2, kind: 'ui', phase: 'reserved', period, host: HOST, fileSha256: sha(prepared()) })
    expect(F.validUiMarker(marker())).toBe(true)
    expect(m.accounts).toEqual({ super: L.U.super, marketing: L.U.mkt, sm: L.U.sm, staff: [L.U.A, L.U.C] })
    expect(evaluateCareQaUi({ nodeEnv: 'development', env: QA_ENV, envFiles: [], markerText: fs.readFileSync(markerPath, 'utf8'), period })).toMatchObject({ kind: 'active' })
    const parsed = parseCareImportCsv(new Uint8Array(prepared()) as Uint8Array<ArrayBuffer>)
    if (!parsed.ok) throw new Error(parsed.fileError)
    const v = validateCareRows(parsed.rows)
    expect([parsed.rows.length, v.customers.length, parsed.errors.length + v.errors.length]).toEqual([13, 12, 0])
    expect(new Set(v.customers.map((c) => c.externalId))).toEqual(new Set(m.externalIds))
    expect(parsed.rows.every((r) => r.target_store_code === 'QAOS01' && r.assignee_email === L.EA.toLowerCase() && /^KH QA \d{3}$/.test(r.customer_name) && /^039001\d{4}$/.test(r.customer_phone))).toBe(true)
    expect(parsed.rows.map((r) => r.product_id)).toEqual(orig.rows.map((r) => r.product_id)) // sản phẩm giữ nguyên
    expect(parsed.rows.every((r) => r.reason_text.startsWith('QA — ') && r.reason_type === 'chronic')).toBe(true) // lý do luôn là câu mẫu
    expect(JSON.stringify(parsed.rows)).not.toMatch(/KH-THAT|Nguyen Van|0912345678|0910000|QAOS05|Dùng thuốc|Gọi lại/) // không còn dữ liệu gốc
    expect(JSON.stringify(prep)).not.toMatch(/QA-UI-|@example|039001|[0-9a-f]{8}-[0-9a-f]{4}-/) // output CLI không ID/PII

    // preview bản GỐC trên server QA: chỉ đọc, không commit được; preview bản QA: được.
    const mkt = qaDeps(L.U.mkt)
    const pOrig = await (await handleCarePreview(await request(orig.bytes), mkt)).json()
    expect(pOrig).toMatchObject({ ok: true, qa: { commitAllowed: false, issues: ['QA_FILE_NOT_MARKED'] }, preview: { rowCount: 13, customerCount: 12 } })
    const cOrig = await handleCareCommit(await request(orig.bytes, { sha256: sha(orig.bytes), period }), mkt)
    expect((await cOrig.json()).code).toBe('QA_FILE_NOT_MARKED')
    const pQa = await (await handleCarePreview(await request(prepared()), mkt)).json()
    expect(pQa).toMatchObject({ ok: true, qa: { commitAllowed: true }, preview: { rowCount: 13, customerCount: 12, errorCount: 0, counts: { created: 12, closed_previous_period: 0 } } })
    expect(await totalTest()).toBe(0)

    // import QA (Marketing) — client gửi is_test=false vẫn bị bỏ qua; batch = id marker; marker imported, khoá nhả.
    const imp = await handleCareCommit(await request(prepared(), { sha256: sha(prepared()), period, is_test: 'false' }), mkt)
    expect(imp.status, await imp.clone().text()).toBe(200)
    expect((await imp.json()).result).toMatchObject({ status: 'committed', batch_id: m.batchId, created: 12 })
    expect(marker()).toMatchObject({ phase: 'imported', importResult: 'committed' })
    expect(fs.existsSync(path.join(dir, CARE_QA_LOCK_FILE))).toBe(false)
    expect((await db.query(`SELECT count(*)::int n FROM public.care_tasks WHERE is_test AND batch_id = $1`, [m.batchId])).rows[0].n).toBe(12)
    expect((await db.query(`SELECT is_test FROM public.care_import_batches WHERE id = $1`, [m.batchId])).rows[0].is_test).toBe(true)
    const again = await handleCareCommit(await request(prepared(), { sha256: sha(prepared()), period }), qaDeps(L.U.super))
    expect((await again.json()).code).toBe('QA_ALREADY_USED') // một marker = một lượt import

    // 5 vai — bộ lọc QA của app + RLS: chỉ task QA, đúng phạm vi; production scope không thấy QA; QA không thấy thật.
    const R = ROLES(L)
    const QA: CareDataScope = { kind: 'qa', batchId: m.batchId }
    const n = async (uid: string, scope: CareDataScope) => (await rlsTasks(db, L, uid, period, scope)).length
    expect({ super: await n(R.super, QA), marketing: await n(R.marketing, QA), sm: await n(R.sm, QA), duocsi2: await n(R.duocsi2, QA), duocsi3: await n(R.duocsi3, QA), qlch: await n(R.qlch, QA) })
      .toEqual({ super: 12, marketing: 12, sm: 12, duocsi2: 12, duocsi3: 0, qlch: 0 })
    expect(await n(R.super, CARE_PRODUCTION_SCOPE)).toBe(5) // màn production (Coolify) không bao giờ thấy QA
    // Q-107: nút Gọi/Nhắn ở QA dùng phone_norm của task trong batch marker ⇒ 12 số bản sao QA (039001…); không số nào
    // của file gốc (khách thật) hay task thật lọt vào phạm vi dược sĩ thấy.
    const qaPhones: string[] = await L.as(db, R.duocsi2, async () => (await db.query(
      `SELECT phone_norm FROM public.care_tasks WHERE is_test AND batch_id = $1`, [m.batchId])).rows.map((r: any) => r.phone_norm))
    expect(qaPhones).toHaveLength(12)
    expect(qaPhones.every((p) => /^039001\d{4}$/.test(p))).toBe(true)
    const realPhones = new Set<string>([...orig.rows.map((r) => r.customer_phone),
      ...(await db.query(`SELECT phone_norm FROM public.care_tasks WHERE NOT is_test`)).rows.map((r: any) => r.phone_norm)])
    expect(qaPhones.filter((p) => realPhones.has(p))).toEqual([])

    // SM chuyển 4 task duocsi2 → duocsi3 (store khác trong vùng); duocsi2 ghi lượt hẹn lại / kết thúc / từ chối (proof null ⇒ []).
    const qaIds = (await rlsTasks(db, L, R.super, period, QA)).map((t: any) => t.id)
    expect((await L.transfer(db, today, L.U.sm, qaIds.slice(0, 4), L.U.C, 'QA chuyển'))?.transferred).toBe(4)
    expect({ duocsi2: await n(R.duocsi2, QA), duocsi3: await n(R.duocsi3, QA), sm: await n(R.sm, QA) }).toEqual({ duocsi2: 8, duocsi3: 4, sm: 12 })
    expect((await L.record(db, today, L.U.A, qaIds[4], 'CALLBACK', 'QA hẹn', today)).status).toBe('open')
    expect((await L.record(db, today, L.U.A, qaIds[5], 'NO_NEED', 'QA xong')).status).toBe('completed')
    expect((await L.record(db, today, L.U.A, qaIds[6], 'REFUSED', 'QA từ chối')).status).toBe('completed')
    expect((await L.record(db, today, L.U.C, qaIds[0], 'CALLBACK', 'QA hẹn 2', today)).status).toBe('open')
    expect(Number((await db.query(`SELECT count(*) n FROM public.care_interactions WHERE is_test AND proof <> '[]'::jsonb`)).rows[0].n)).toBe(0)

    // Số liệu đường QA (mirror) ≡ SQL: (a) mỗi vai trên dữ liệu THẬT (scope production) = care_report(false);
    // (b) super trên dữ liệu QA store 1 = care_report(include_test) − care_report(không test) của store 1.
    for (const [name, uid] of Object.entries(R)) {
      expect(strip(careQaReportRows(await rlsTasks(db, L, uid, period, CARE_PRODUCTION_SCOPE))), `parity ${name}`).toEqual(strip(await sqlReport(db, L, uid, period, false)))
    }
    const s1 = L.storeId(1)
    const withTest = strip(await sqlReport(db, L, R.super, period, true, [s1]))
    const realOnly = strip(await sqlReport(db, L, R.super, period, false, [s1]))
    const qaS1 = strip(careQaReportRows((await rlsTasks(db, L, R.super, period, QA)).filter((t: any) => t.store_id === s1)))
    const diff = withTest.map((r: any) => {
      const x: any = realOnly.find((y: any) => y.store_id === r.store_id && y.assignee_id === r.assignee_id)
      return x ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? v - x[k] : v])) : r
    }).filter((r: any) => r.tasks_total > 0)
    expect(qaS1).toEqual(diff)
    expect(qaS1.reduce((a, r) => a + r.tasks_total, 0)).toBe(8)
    // Thẻ "CSKH của tôi": mirror ≡ care_my_summary trên dữ liệu thật; trên QA đếm đúng tay.
    const mine = async (uid: string, store: string, scope: CareDataScope) => {
      const conds: [string, unknown][] = []
      const b: any = { eq: (c: string, v: unknown) => { conds.push([c, v]); return b }, is: () => b, not: () => b, lt: () => b }
      applyMyTaskFilters(b, uid, store, period, 'all', today, scope)
      return L.as(db, uid, async () => (await db.query(`SELECT status, last_interaction_at, next_action_date::text FROM public.care_tasks WHERE ${conds.map(([c], i) => `${c} = $${i + 1}`).join(' AND ')}`, conds.map(([, v]) => v))).rows)
    }
    const sqlMy = (await L.as(db, L.U.A, async () => (await db.query(`SELECT assigned, not_cared, completed, overdue_live FROM public.care_my_summary()`)).rows[0]))
    expect(careQaMySummary(await mine(L.U.A, s1, CARE_PRODUCTION_SCOPE), today)).toEqual({ assigned: sqlMy.assigned, notCared: sqlMy.not_cared, completed: sqlMy.completed, overdueLive: sqlMy.overdue_live })
    expect(careQaMySummary(await mine(L.U.A, s1, QA), today)).toEqual({ assigned: 8, notCared: 5, completed: 2, overdueLive: 0 })
    expect(careQaMySummary(await mine(L.U.C, L.storeId(2), QA), today)).toEqual({ assigned: 4, notCared: 3, completed: 0, overdueLive: 0 })

    // status ⇒ down: dọn đúng phạm vi marker; dữ liệu thật nguyên vẹn; marker xoá; server QA bị chặn (không marker).
    const st = await F.cmdStatus(ctx)
    expect(st).toMatchObject({ ok: true, marker: true, kind: 'ui', phase: 'imported', importResult: 'committed', lock: 'none' })
    expect(st.counts).toMatchObject({ care_import_batches: 1, care_customers: 12, care_tasks: 12, care_task_products: 13, care_interactions: 4, care_store_refusals: 1, care_orders: 0 })
    const down = await F.cmdDown(ctx)
    expect(down).toMatchObject({ ok: true, remaining: 0, deleted: { care_tasks: 12, care_customers: 12, care_interactions: 4, care_store_refusals: 1, care_import_batches: 1 } })
    expect(down.deleted.care_assignment_events).toBe(16) // assigned ×12 + transferred ×4
    expect(fs.existsSync(markerPath)).toBe(false)
    expect(await totalTest()).toBe(0)
    expect(await real()).toEqual(realBefore)
    expect(evaluateCareQaUi({ nodeEnv: 'development', env: QA_ENV, envFiles: [], markerText: null, period })).toEqual({ kind: 'blocked', reason: 'NO_MARKER' })
    expect(JSON.stringify([st, down])).not.toMatch(/QA-UI-|@example|039001|[0-9a-f]{8}-[0-9a-f]{4}-/)
    await db.close()
  })

  test('Q-121 QA tải: prepare-load đúng trần dòng (mặc định, 2,5 SP/khách; chỉ đọc) → load qua handler QA thật (preview ×2 → commit → preview lại → commit lại) → status → down sạch, dữ liệu thật nguyên', async () => {
    const { db, L, F, env, ctx, markerPath, today, period, totalTest, real, marker, prepared, qaDeps } = await setup()
    await db.exec('SET enable_seqscan = on') // PGlite mặc định off (≠ prod) ⇒ finalize nhiều nghìn dòng chậm bậc hai
    const R = F.LOAD_DEFAULT_ROWS as number, C = F.LOAD_DEFAULT_CUSTOMERS as number
    expect([R, C]).toEqual([CARE_IMPORT_MAX_ROWS, CARE_IMPORT_MAX_ROWS / 2.5])
    await seedReal(db, L, today, period)
    const realBefore = await real()
    const outsideBefore = (await F.cmdStatus(ctx)).outside
    expect(outsideBefore).toMatchObject({ test_tasks_all: 0, staging_rows_all: 0 })
    expect(outsideBefore.real_tasks).toBeGreaterThan(0)
    // Kích thước sai ⇒ dừng TRƯỚC mọi đọc DB / marker.
    await expect(F.cmdPrepareLoad({ ...ctx, customers: C, rows: R + 1 })).rejects.toMatchObject({ code: 'LOAD_SIZE' })
    await expect(F.cmdPrepareLoad({ ...ctx, customers: 10_001, rows: R })).rejects.toMatchObject({ code: 'LOAD_SIZE' })
    expect(fs.existsSync(markerPath)).toBe(false)

    const prep = await F.cmdPrepareLoad({ ...ctx, runId: 'c0ffee01' })
    expect(prep).toMatchObject({ ok: true, profile: 'load', rows: R, customers: C, products: R })
    expect(prep.fileMb).toBeLessThan(8)
    const m0 = marker()
    expect([m0.phase, m0.externalIds.length, parseCareQaUiMarker(m0) !== null, F.validUiMarker(m0)]).toEqual(['reserved', C, true, true])
    const parsed = parseCareImportCsv(prepared())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const ids = parsed.rows.map((x) => x.customer_external_id)
    expect(new Set(ids).size).toBe(C)
    expect(ids.filter((x, i) => i > 0 && x !== ids[i - 1]).length).toBe(C - 1) // mọi dòng của một khách liền nhau
    expect(parsed.rows.every((x) => /^03900\d{5}$/.test(x.customer_phone) && /^KH QA \d{5}$/.test(x.customer_name)
      && x.target_store_code === 'QAOS01' && x.assignee_email === L.EA.toLowerCase() && x.product_url.startsWith('https://cdn-gcs.thuocsi.vn/qa-fixture/'))).toBe(true)

    // Client = handler THẬT ở chế độ QA (repo PGlite) + cùng serializer multipart với CLI.
    const client = {
      async post(p: string, fields: Record<string, unknown>) {
        const { body, contentType } = await F.multipartBody(fields)
        const r = new Request(`http://localhost:3100${p}`, {
          method: 'POST', headers: { 'content-type': contentType, 'content-length': String(body.byteLength) }, body, duplex: 'half',
        } as RequestInit)
        const res = await (p.endsWith('/commit') ? handleCareCommit : handleCarePreview)(r, qaDeps(L.U.mkt))
        return { status: res.status, timing: res.headers.get('server-timing'), body: await res.json() }
      },
    }
    const out = await F.cmdLoad({ env, markerPath, fileBytes: prepared(), client })
    expect(out).toMatchObject({
      ok: true, rows: R, customers: C,
      preview: { status: 200, errorCount: 0, created: C, commitAllowed: true },
      commit: { status: 200, result: { status: 'committed', kind: 'initial', rows: R, customers: C, created: C } },
      preview_after: { status: 200, created: 0, updated: 0, unchanged: C },
      recommit: { status: 409, code: 'QA_ALREADY_USED' },
    })
    expect(Object.keys(out.preview.server)).toEqual(expect.arrayContaining(['parse', 'lookups', 'preview', 'rss', 'rss_peak']))
    expect(Object.keys(out.commit.server)).toEqual(expect.arrayContaining(['parse', 'lookups', 'stage', 'finalize', 'rss_peak']))
    expect(JSON.stringify(out)).not.toMatch(/QA-UI-|@example|03900|KH QA|[0-9a-f]{8}-[0-9a-f]{4}-/)
    expect(marker()).toMatchObject({ phase: 'imported', importResult: 'committed' })
    await expect(F.cmdLoad({ env, markerPath, fileBytes: prepared(), client })).rejects.toMatchObject({ code: 'PHASE' }) // một lượt / marker

    const n = async (sql: string) => Number(Object.values((await db.query(sql, [m0.batchId])).rows[0])[0])
    expect(await n(`SELECT count(*) FROM public.care_tasks WHERE is_test AND batch_id = $1`)).toBe(C)
    expect(await n(`SELECT count(*) FROM public.care_task_products WHERE is_current AND batch_id = $1`)).toBe(R)
    expect(await n(`SELECT count(*) FROM public.care_import_staging WHERE batch_id = $1`)).toBe(0)
    expect(await real()).toEqual(realBefore)

    const st = await F.cmdStatus(ctx)
    expect(st.counts).toMatchObject({ care_import_batches: 1, care_customers: C, care_tasks: C, care_task_products: R, care_import_staging: 0, care_interactions: 0 })
    expect(st.outside).toEqual({ ...outsideBefore, test_tasks_all: C })
    const down = await F.cmdDown(ctx)
    expect(down).toMatchObject({ ok: true, remaining: 0, deleted: { care_tasks: C, care_customers: C, care_task_products: R, care_assignment_events: C, care_import_batches: 1 } })
    expect(fs.existsSync(markerPath)).toBe(false)
    expect(await totalTest()).toBe(0)
    expect(await real()).toEqual(realBefore)
    expect(await F.cmdStatus(ctx)).toEqual({ ok: true, marker: false, outside: outsideBefore })
    expect(JSON.stringify([st, down])).not.toMatch(/QA-UI-|@example|03900|[0-9a-f]{8}-[0-9a-f]{4}-/)
    await db.close()
  })

  test('prepare: cổng/tài khoản/phạm vi SM/kỳ có test khác/ID giả trùng ⇒ dừng TRƯỚC khi tạo marker; marker độc quyền', async () => {
    const { db, L, F, ctx, markerPath, period, today } = await setup()
    const orig = originalFile(L).bytes
    const run = (over: any = {}) => F.cmdPrepare({ ...ctx, originalBytes: orig, ...over })
    const bad: [string, any, string][] = [
      ['thiếu cờ', { env: { ...ctx.env, E2E_CARE_WRITE_QA: undefined } }, 'GATE'],
      ['cờ trong .env.local', { envFileText: 'E2E_CARE_WRITE_QA=YES\n' }, 'GATE'],
      ['thiếu tài khoản Marketing', { env: { ...ctx.env, E2E_MKT_ADMIN_EMAIL: undefined } }, 'ACCOUNT_MISSING'],
      ['Marketing là admin phòng không có quyền import', { env: { ...ctx.env, E2E_MKT_ADMIN_EMAIL: 'qa.ops@example.invalid' } }, 'ACCOUNT_ROLE'],
      ['dược sĩ thứ hai ngoài vùng SM', { env: { ...ctx.env, E2E_CARE_TRANSFER_TO_EMAIL: L.STORES[2].assigneeEmails[0] } }, 'SM_SCOPE'],
      ['trùng tài khoản', { env: { ...ctx.env, E2E_CARE_TRANSFER_TO_EMAIL: L.EA } }, 'ACCOUNT_DUPLICATE'],
      ['file .xlsx (không phải CSV)', { originalBytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]) }, 'FILE_INVALID'],
      ['CSV sai tiêu đề', { originalBytes: new TextEncoder().encode('a,b,c') }, 'FILE_INVALID'],
      ['giao tháng', { nowMs: Date.parse('2026-10-31T17:05:00Z') }, 'MONTH_BOUNDARY'],
    ]
    for (const [name, over, code] of bad) {
      await expect(run(over), name).rejects.toMatchObject({ code })
      expect(fs.existsSync(markerPath), name).toBe(false)
    }
    // ID giả trùng: runId cố định, khách QA-UI-<run>-001 đã tồn tại.
    await L.finalize(db, await L.stage(db, [L.row('QA-UI-deadbeef-001', 'QAOS01', L.EA, 'X1')], { period, isTest: true }), L.U.mkt, today)
    await expect(run({ runId: 'deadbeef' })).rejects.toMatchObject({ code: 'TEST_TASKS_EXIST' }) // kỳ này đã có task test
    expect(fs.existsSync(markerPath)).toBe(false)
    // Marker độc quyền: marker khác vừa xuất hiện ⇒ GATE (không ghi đè).
    await db.query(`DELETE FROM public.care_task_products WHERE task_id IN (SELECT id FROM public.care_tasks WHERE is_test)`)
    await db.query(`DELETE FROM public.care_assignment_events WHERE is_test`)
    await db.query(`DELETE FROM public.care_tasks WHERE is_test`)
    await expect(run({ runId: 'deadbeef' })).rejects.toMatchObject({ code: 'ID_CLASH' }) // khách QA-UI-deadbeef-001 còn
    fs.writeFileSync(markerPath, '{"v":1}')
    await expect(run()).rejects.toMatchObject({ code: 'GATE' })
    expect(fs.readFileSync(markerPath, 'utf8')).toBe('{"v":1}')
    fs.rmSync(markerPath)
    // Ghi file ra lỗi ⇒ bỏ marker (chưa ghi DB nào).
    await expect(run({ writeOut: () => { throw new Error('EEXIST') } })).rejects.toMatchObject({ code: 'OUT_WRITE' })
    expect(fs.existsSync(markerPath)).toBe(false)
    await db.close()
  })

  test('crash/retry: chết sau staging (khoá stale) ⇒ status thấy, down chờ khoá sống, dọn khi khoá chết; chết sau finalize trước finish; down lỗi giữa chừng ⇒ tearing_down chặn server, chạy lại xong', async () => {
    const { db, L, F, ctx, markerPath, dir, today, period, totalTest, marker, prepared, qaDeps } = await setup()
    await F.cmdPrepare({ ...ctx, originalBytes: originalFile(L).bytes })
    const m = parseCareQaUiMarker(marker())!
    // (a) Process chết sau createBatch + stage, trước finalize: marker importing + khoá của pid đã chết.
    expect(beginCareQaImport(dir, m.batchId)).toBe(true)
    expect(marker().phase).toBe('importing')
    expect(beginCareQaImport(dir, m.batchId)).toBe(false) // khoá độc quyền: lượt thứ hai không vào được
    const repo = pgliteImportRepo(db, L, today)
    await repo.createBatch({ period, fileName: 'x.csv', sha256: m.fileSha256, rowCount: 13, actorId: L.U.mkt, isTest: true, id: m.batchId })
    const parsed: any = parseCareImportCsv(new Uint8Array(prepared()) as Uint8Array<ArrayBuffer>)
    await repo.stageRows(m.batchId, parsed.rows.map((r: any) => ({ row_no: r.rowNo, payload: Object.fromEntries(CARE_IMPORT_HEADERS.map((h) => [h, r[h]])) })))
    const st = await F.cmdStatus(ctx)
    expect(st).toMatchObject({ phase: 'importing', counts: { care_import_batches: 1, care_import_staging: 13, care_tasks: 0 } })
    await expect(F.cmdDown({ ...ctx, isPidAlive: () => true })).rejects.toMatchObject({ code: 'IMPORT_RUNNING' })
    expect(await totalTest()).toBe(14)
    // Server khởi động lại: marker importing ⇒ không import lại được (QA_ALREADY_USED/khoá).
    const r = await handleCareCommit(await request(prepared(), { sha256: sha(prepared()), period }), qaDeps(L.U.mkt))
    expect(['QA_ALREADY_USED', 'QA_BUSY']).toContain((await r.json()).code)
    expect(await F.cmdDown({ ...ctx, isPidAlive: () => false })).toMatchObject({ ok: true, remaining: 0 })
    expect(fs.existsSync(path.join(dir, CARE_QA_LOCK_FILE))).toBe(false)
    expect(await totalTest()).toBe(0)

    // (b) Chết SAU finalize, trước finish (marker vẫn importing): down tìm theo batch/ID giả, dọn sạch.
    await F.cmdPrepare({ ...ctx, originalBytes: originalFile(L).bytes })
    const m2 = parseCareQaUiMarker(marker())!
    expect(beginCareQaImport(dir, m2.batchId)).toBe(true)
    const deps = qaDeps(L.U.mkt)
    deps.qa = { ...deps.qa!, begin: async () => true, finish: async () => { throw new Error('process chết trước finish') } }
    const res = await handleCareCommit(await request(prepared(), { sha256: sha(prepared()), period }), { ...deps, qa: { ...deps.qa!, marker: { ...deps.qa!.marker, phase: 'reserved' } } })
    expect(res.status).toBe(200)
    expect(marker().phase).toBe('importing')
    expect((await F.cmdStatus(ctx)).counts).toMatchObject({ care_tasks: 12, care_customers: 12 })
    // (c) down lỗi giữa chừng sau khi đã xoá task ⇒ tearing_down; server QA chặn; chạy lại xong.
    let failOnce = true
    const origDel = ctx.gw.svc.del
    let beganDuringDown: boolean | null = null
    ctx.gw.svc.del = async (t: string, f: any) => {
      if (beganDuringDown === null) beganDuringDown = beginCareQaImport(dir, m2.batchId) // server thử import giữa lúc down đang xoá
      if (failOnce && t === 'care_customers') { failOnce = false; throw Object.assign(new Error('chết'), { code: 'SIMULATED' }) }
      return origDel(t, f)
    }
    await expect(F.cmdDown({ ...ctx, isPidAlive: () => false })).rejects.toBeTruthy()
    expect(marker().phase).toBe('tearing_down')
    expect(beganDuringDown).toBe(false) // down giữ khoá wx ⇒ import không chen vào (security P2-1)
    expect(fs.existsSync(path.join(dir, CARE_QA_LOCK_FILE))).toBe(false) // down lỗi vẫn nhả khoá của chính nó
    expect(evaluateCareQaUi({ nodeEnv: 'development', env: QA_ENV, envFiles: [], markerText: fs.readFileSync(markerPath, 'utf8'), period })).toEqual({ kind: 'blocked', reason: 'MARKER_TEARDOWN' })
    expect((await F.cmdStatus(ctx)).counts).toMatchObject({ care_tasks: 0, care_customers: 12 })
    expect(await F.cmdDown({ ...ctx, isPidAlive: () => false })).toMatchObject({ ok: true, remaining: 0 })
    expect(await totalTest()).toBe(0)
    await db.close()
  })

  test('phạm vi trộn ⇒ dừng TRƯỚC mọi DELETE: batch thật / ID thật lẫn vào / batch QA khác / khách có task batch khác; import song song chỉ một lượt ghi', async () => {
    const { db, L, F, ctx, markerPath, today, period, totalTest, marker, prepared, qaDeps } = await setup()
    await seedReal(db, L, today, period)
    const realBatch = (await db.query(`SELECT id FROM public.care_import_batches WHERE NOT is_test`)).rows[0].id
    await F.cmdPrepare({ ...ctx, originalBytes: originalFile(L).bytes })
    const A = marker()
    // Import song song hai request: đúng MỘT lượt ghi, lượt kia QA_BUSY / QA_ALREADY_USED.
    const [r1, r2] = await Promise.all([1, 2].map(async () => handleCareCommit(await request(prepared(), { sha256: sha(prepared()), period }), qaDeps(L.U.mkt))))
    const codes = [await r1.json(), await r2.json()].map((b: any) => (b.ok ? 'OK' : b.code)).sort()
    expect(codes[0]).toBe('OK')
    expect(['QA_ALREADY_USED', 'QA_BUSY']).toContain(codes[1])
    expect((await db.query(`SELECT count(*)::int n FROM public.care_import_batches WHERE is_test`)).rows[0].n).toBe(1)
    const before = await totalTest()
    const realBefore = Number((await db.query(`SELECT count(*) n FROM public.care_tasks WHERE NOT is_test`)).rows[0].n)
    const tamper = async (why: string, patch: any, code: string, extraRows = 0) => {
      fs.writeFileSync(markerPath, JSON.stringify({ ...A, ...patch }))
      await expect(F.cmdDown({ ...ctx, isPidAlive: () => false }), why).rejects.toMatchObject({ code })
      expect(await totalTest(), why).toBe(before + extraRows)
      expect(Number((await db.query(`SELECT count(*) n FROM public.care_tasks WHERE NOT is_test`)).rows[0].n), why).toBe(realBefore)
      expect(fs.existsSync(markerPath), why).toBe(true)
    }
    await tamper('batch của marker là batch THẬT', { batchId: realBatch }, 'SCOPE_NOT_TEST')
    await tamper('sha256 khác (batch không phải file QA này)', { fileSha256: '0'.repeat(64) }, 'SCOPE_MISMATCH')
    await tamper('taskIds lẫn task thật', { phase: 'imported', taskIds: [(await db.query(`SELECT id FROM public.care_tasks WHERE NOT is_test LIMIT 1`)).rows[0].id] }, 'SCOPE_MISMATCH')
    await tamper('ID khách không suy ra từ runId', { runId: 'deadbeef' }, 'MARKER_INVALID')
    // ID THẬT lẫn vào: khách không-test mang một ID giả của marker ⇒ SCOPE_NOT_TEST.
    const fake13 = careQaUiExternalIds(A.runId, 13)[12]
    // 116 khoá external_id (trigger care_customers_freeze_external_id) ⇒ chèn một khách thật mang ID giả thay vì đổi ID.
    await db.query(`INSERT INTO public.care_customers (external_id, is_test) VALUES ($1, false)`, [fake13])
    await tamper('ID thật mang mã giả', { externalIds: careQaUiExternalIds(A.runId, 13) }, 'SCOPE_NOT_TEST')
    await db.query(`DELETE FROM public.care_customers WHERE external_id = $1 AND NOT is_test`, [fake13])
    // Khách QA có task ở batch KHÁC (lượt test khác chạm cùng khách) ⇒ SCOPE_MISMATCH.
    const [{ id: otherBatch }] = (await db.query(`INSERT INTO public.care_import_batches (period_month, file_name, file_sha256, row_count, created_by, is_test)
      VALUES ($1, 'khac.csv', $2, 1, $3, true) RETURNING id`, [period, 'e'.repeat(64), L.U.mkt])).rows
    const [{ id: moved }] = (await db.query(`SELECT id FROM public.care_tasks WHERE batch_id = $1 LIMIT 1`, [A.batchId])).rows
    await db.query(`UPDATE public.care_tasks SET batch_id = $1 WHERE id = $2`, [otherBatch, moved])
    await tamper('khách QA có task ở batch khác', {}, 'SCOPE_MISMATCH', 1) // +1 = batch phụ test vừa chèn
    await db.query(`UPDATE public.care_tasks SET batch_id = $1 WHERE id = $2`, [A.batchId, moved])
    await db.query(`DELETE FROM public.care_import_batches WHERE id = $1`, [otherBatch])
    fs.writeFileSync(markerPath, JSON.stringify(A))
    expect(await F.cmdDown({ ...ctx, isPidAlive: () => false })).toMatchObject({ ok: true, remaining: 0 }) // marker đúng ⇒ dọn được
    expect(Number((await db.query(`SELECT count(*) n FROM public.care_tasks WHERE NOT is_test`)).rows[0].n)).toBe(realBefore)
    await db.close()
  })

  test('serve: chỉ lệnh next dev bind 127.0.0.1, cờ CRM chỉ trong env con (sync OFF), không NODE_ENV; thiếu cờ/marker ⇒ từ chối', async () => {
    const F: any = await import(pathToFileURL(path.join(ROOT, 'scripts', 'care-qa-fixture.mjs')).href)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'care-qa-serve-'))
    const markerPath = path.join(dir, CARE_QA_MARKER_FILE)
    const env = { NEXT_PUBLIC_SUPABASE_URL: `https://${HOST}`, E2E_CARE_WRITE_QA: 'YES', E2E_EXPECTED_SUPABASE_HOST: HOST, NODE_ENV: 'production' }
    expect(() => F.cmdServe({ env, envFileText: '', markerPath })).toThrow(/prepare/)
    fs.writeFileSync(markerPath, JSON.stringify(sampleMarker()))
    const s = F.cmdServe({ env, envFileText: '', markerPath, port: 3100, appDir: dir })
    expect(s.args.slice(1)).toEqual(['dev', '-H', '127.0.0.1', '-p', '3100'])
    expect(s.env).toMatchObject({ CARE_ENABLED: 'true', CARE_SYNC_ENABLED: 'false', CARE_QA_UI: 'YES', CARE_QA_UI_BIND: '127.0.0.1' })
    expect(s.env.NODE_ENV).toBeUndefined()
    // B7-ui r2: cache dev cũ từng giữ CSS cũ ⇒ serve dọn đúng .next/dev của app trước khi chạy.
    expect(s.clean).toBe(path.join(dir, '.next', 'dev'))
    expect(() => F.cmdServe({ env: { ...env, E2E_CARE_WRITE_QA: undefined }, envFileText: '', markerPath })).toThrow()
    expect(() => F.cmdServe({ env, envFileText: 'E2E_EXPECTED_SUPABASE_HOST=x\n', markerPath })).toThrow()
    fs.writeFileSync(markerPath, JSON.stringify(sampleMarker({ phase: 'tearing_down' })))
    expect(() => F.cmdServe({ env, envFileText: '', markerPath })).toThrow(/tearing_down/)
  })

  test('hợp đồng CLI ↔ app: header/sheet N1 trùng contract; marker hợp lệ/không hợp lệ giống nhau hai phía', async () => {
    const F: any = await import(pathToFileURL(path.join(ROOT, 'scripts', 'care-qa-fixture.mjs')).href)
    expect(F.CARE_IMPORT_HEADERS).toEqual([...CARE_IMPORT_HEADERS])
    expect(F.uiExternalIds('a1b2c3d4', 3)).toEqual(careQaUiExternalIds('a1b2c3d4', 3))
    expect(path.basename(F.DEFAULT_MARKER_PATH)).toBe(CARE_QA_MARKER_FILE)
    // Q-121: trần marker / trần dòng hai phía trùng nhau; bản sao từ file mẫu vẫn tối đa 200 khách.
    expect([F.UI_MAX_CUSTOMERS, F.CARE_IMPORT_MAX_ROWS, F.UI_COPY_MAX_CUSTOMERS]).toEqual([CARE_QA_UI_MAX_CUSTOMERS, CARE_IMPORT_MAX_ROWS, 200])
    const big = (k: number) => sampleMarker({ externalIds: careQaUiExternalIds('a1b2c3d4', k) })
    for (const k of [8000, CARE_QA_UI_MAX_CUSTOMERS, CARE_QA_UI_MAX_CUSTOMERS + 1]) {
      expect([F.validUiMarker(big(k)), parseCareQaUiMarker(big(k)) !== null], String(k)).toEqual(Array(2).fill(k <= CARE_QA_UI_MAX_CUSTOMERS))
    }
    const tooMany = Array.from({ length: 201 }, (_, i) => ({ ...Object.fromEntries(CARE_IMPORT_HEADERS.map((h) => [h, 'x'])), customer_external_id: `K${i}` }))
    expect(() => F.uiRows(tooMany, 'a1b2c3d4', 'QAOS01', 'a@b')).toThrow(/1–200 khách/)
    expect(F.loadProductCounts(F.LOAD_DEFAULT_CUSTOMERS, F.LOAD_DEFAULT_ROWS).reduce((a: number, b: number) => a + b, 0)).toBe(F.LOAD_DEFAULT_ROWS)
    expect(Math.max(...F.loadProductCounts(F.LOAD_DEFAULT_CUSTOMERS, F.LOAD_DEFAULT_ROWS))).toBeLessThanOrEqual(F.LOAD_MAX_PRODUCTS)
    expect(() => F.loadProductCounts(4000, CARE_IMPORT_MAX_ROWS + 1)).toThrow()
    // Tham số CLI prepare-load + trần byte đọc từ env (review Q-121: regex số từng mất dấu \).
    expect([F.loadArg(undefined, 8000), F.loadArg('5000', 8000), F.loadArg('20000', 1), F.loadArg('5e3', 1), F.loadArg('-1', 1), F.loadArg('', 1)])
      .toEqual([8000, 5000, 20_000, Number.NaN, Number.NaN, Number.NaN])
    expect([F.loadMaxBytes({}), F.loadMaxBytes({ CARE_IMPORT_MAX_BYTES: ' 5242880 ' }), F.loadMaxBytes({ CARE_IMPORT_MAX_BYTES: '8MB' })])
      .toEqual([8 * 1024 * 1024, 5 * 1024 * 1024, 8 * 1024 * 1024])
    const variants: any[] = [sampleMarker(), sampleMarker({ phase: 'imported', importResult: 'committed' }), sampleMarker({ runId: 'x' }), sampleMarker({ externalIds: ['KH-1'] }),
      sampleMarker({ storeIds: [] }), sampleMarker({ taskIds: [UUID(1)] }), { ...sampleMarker(), kind: 'fixture' }, null]
    for (const v of variants) expect(F.validUiMarker(v), JSON.stringify(v)).toBe(parseCareQaUiMarker(v) !== null)
  })
})
