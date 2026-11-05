import * as XLSX from 'xlsx'
import { test, expect } from '@playwright/test'
import { cmsSourceCaptureFromEnv } from '../lib/cms/flags'
import {
  buildCmsSourceStageRows, parseCmsSalesSnapshot, CMS_SOURCE_PART, CMS_SOURCE_SCHEMA_SUPPORTED,
} from '../lib/cms/resultStage'
import { runCmsSalesSync, type CmsSalesSyncDeps } from '../lib/cms/salesSync'
import {
  CmsPayoutDtoError, cmsAttestStateLabel, cmsLockCodeLabel, cmsLockExpectedAttestation, cmsSourceBasisLabel, parseCmsLockPreview, parseCmsPayout,
} from '../lib/cms/payoutView'
import { runCmsLock, type CmsLockDeps } from '../lib/cms/lockAction'
import { CMS_LOCK_RECHECK_CODES, cmsLockConfirmFlow } from '../lib/cms/lockFlow'
import { buildCmsPayoutWorkbook } from '../lib/cms/exportPayouts'
import { normalizeSalesRow, type CmsRawRow } from '../lib/cms/source/contract'
import { createCmsFixtureRunner } from './cmsFixtureRunner'
import * as A from './cmsSourceAttest'
import * as R from './cmsQaResults'
import type { CmsI4CompareResult, CmsI4EvidenceMeta } from './cmsI4CompareSource'
import type { CmsQaRunManifest } from './cmsQaTooling'

// CMS COMP-INT (PM 2026-11-05-cms-comp-draft-pm.md §5) — phần THUẦN: capability source_schema (parser / cờ / lõi đồng bộ — ma
// trận app cũ / mới × DB cũ / mới × cờ), dòng lớp nguồn 14 trường, DTO preview / payout chứng nhận, lõi action chốt 6 tham số,
// luồng kiểm lại, XLSX metadata, lõi CLI chứng nhận (token, phân loại RPC, kiểm trang xuất, payload decision10, sổ / reconcile /
// close QA). Hành vi DB thật: scripts/qa-cms-124.mjs (PGlite, trong full suite) + 124-realpg-test.mjs (PG15).

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const P = uid(1), RUN = uid(2), ATT = uid(3), ATT2 = uid(4), ACTOR = uid(9)
const TS = '2026-11-02T01:00:00.000000Z'
const H = (c: string) => c.repeat(64)

// ── Snapshot / capability ────────────────────────────────────────────────────
const snapRaw = (o: Record<string, unknown> = {}) => ({
  program_id: P, status: 'active', is_test: true, config_version: 1, start_date: '2026-10-01', end_date: '2026-10-31', catalog_target_gmv: null,
  today_vn: '2026-11-05', current_result_run_id: null, previous_rows_read: null, store_ids: [uid(101)],
  products: [{ id: uid(201), product_id: '901', gmv_basis: 'none', target_gmv: null, base_quantity_cms: '2', tiers: [{ order: 1, from: 1, to: null, amount: '1000' }] }],
  sellers: [{ id: uid(301), email: 'ds.a@example.test', role: 'staff', store_id: uid(101) }], stores: [{ id: uid(101), store_type: 'os', is_active: true }],
  mapping_fp: 'a'.repeat(32), ...o,
})

test.describe('COMP-INT — capability source_schema @desktop', () => {
  test('parser: run_open có source_schema THỰC; snapshot chỉ đọc không có; key lạ / thiếu run_id ⇒ hỏng; app cũ bỏ qua key thêm', () => {
    expect(parseCmsSalesSnapshot(snapRaw({ run_id: RUN, source_schema: 1 })).sourceSchema).toBe(1)
    expect(parseCmsSalesSnapshot(snapRaw({ run_id: RUN })).sourceSchema).toBeNull() // DB trước 124
    expect(parseCmsSalesSnapshot(snapRaw()).sourceSchema).toBeNull() // snapshot chỉ đọc
    for (const bad of [{ source_schema: 1 }, { run_id: RUN, source_schema: '1' }, { run_id: RUN, source_schema: 0 }, { run_id: RUN, source_schema: 1.5 }]) {
      expect(() => parseCmsSalesSnapshot(snapRaw(bad)), JSON.stringify(bad)).toThrow()
    }
    expect(parseCmsSalesSnapshot(snapRaw({ run_id: RUN, source_schema: 2 })).sourceSchema).toBe(2) // DB mới hơn app ⇒ lõi từ chối capture
    expect(CMS_SOURCE_SCHEMA_SUPPORTED).toBe(1)
    expect(cmsSourceCaptureFromEnv({})).toBe(false)
    expect(cmsSourceCaptureFromEnv({ CMS_SOURCE_CAPTURE_ENABLED: 'TRUE' })).toBe(false)
    expect(cmsSourceCaptureFromEnv({ CMS_SOURCE_CAPTURE_ENABLED: 'true' })).toBe(true)
  })

  test('dòng lớp nguồn: 14 trường thô, thứ tự tất định theo order_line_id, số / micro giây dạng chuỗi', () => {
    const raw = (id: string, o: Partial<CmsRawRow> = {}): CmsRawRow => ({ order_line_id: id, order_id: 'O1', order_code: 'SO1', product_id: '901',
      seller_email: 'DS.A@example.test ', pos_code: null, order_type: 'ONLINE', order_status: 'AWAITING_CONFIRM', completed_at: '2026-10-05T03:00:00.000001Z',
      quantity_raw: '1', uom_raw: 'Hộp', base_quantity: '2.5', gmv_amount: '-0.000000001', source_updated_at: '2026-10-05T03:00:00.000002Z', ...o })
    const ls = [raw('b'), raw('a')].map((r) => { const n = normalizeSalesRow(r); if (!n.ok) throw new Error('x'); return n.value })
    const rows = buildCmsSourceStageRows(ls)
    expect(rows.map((r) => r.order_line_id)).toEqual(['a', 'b'])
    expect(Object.keys(rows[0]).sort()).toEqual(['base_quantity', 'completed_at', 'gmv_amount', 'order_code', 'order_id', 'order_line_id', 'order_status',
      'order_type', 'pos_code', 'product_id', 'quantity_raw', 'seller_email', 'source_updated_at', 'uom_raw'])
    expect(rows[0]).toMatchObject({ seller_email: 'ds.a@example.test', order_type: 'ONLINE', order_status: 'AWAITING_CONFIRM', base_quantity: '2.5',
      gmv_amount: '-0.000000001', completed_at: '2026-10-05T03:00:00.000001Z', pos_code: null })
  })

  // Ma trận app × DB × cờ trên lõi đồng bộ (deps giả, runner giả).
  function deps(o: { openExtra?: Record<string, unknown> } = {}) {
    const calls: { stage: string[]; finish: string[]; publish: number } = { stage: [], finish: [], publish: 0 }
    const rows: CmsRawRow[] = [
      { order_line_id: '1', order_id: 'O1', order_code: 'S1', product_id: '901', seller_email: 'ds.a@example.test', pos_code: 'P', order_type: 'OFFLINE',
        order_status: 'COMPLETED', completed_at: '2026-10-05T03:00:00.000000Z', quantity_raw: '1', uom_raw: 'Hộp', base_quantity: '2', gmv_amount: '1000', source_updated_at: '2026-10-05T03:00:00.000000Z' },
      { order_line_id: '2', order_id: 'O2', order_code: 'S2', product_id: '901', seller_email: 'ds.a@example.test', pos_code: 'P', order_type: 'ONLINE',
        order_status: 'COMPLETED', completed_at: '2026-10-06T03:00:00.000000Z', quantity_raw: '1', uom_raw: 'Hộp', base_quantity: '2', gmv_amount: '1000', source_updated_at: '2026-10-06T03:00:00.000000Z' },
    ]
    const d: CmsSalesSyncDeps = {
      table: 'qa-fake-source.cms_qa.fake_sales', runner: createCmsFixtureRunner({ sales: rows }),
      loadSnapshot: async () => snapRaw(), openRun: async () => snapRaw({ run_id: RUN, ...o.openExtra }),
      stage: async (_r, part, _c, rws) => { calls.stage.push(part); return rws.length },
      sealBegin: async () => ({ ok: true }), sealStep: async () => ({ sealed: true }),
      publish: async () => { calls.publish++; return { published: true } },
      finish: async (_r, status) => { calls.finish.push(status) }, cleanup: async () => ({ purged: 0, deleted: 0, more: false }), now: () => Date.now(),
    }
    return { d, calls }
  }
  test('lõi đồng bộ: cờ OFF ⇒ không gửi source_lines (app mới / DB 124 hoặc DB cũ); cờ ON + DB 124 ⇒ source_lines trước seal', async () => {
    const off = deps({ openExtra: { source_schema: 1 } })
    const r0 = await runCmsSalesSync(off.d, P, { dryRun: false, source: 'qa' })
    expect([r0.status, r0.sourceRows, off.calls.stage.includes(CMS_SOURCE_PART)]).toEqual(['published', null, false])
    const on = deps({ openExtra: { source_schema: 1 } })
    const r1 = await runCmsSalesSync(on.d, P, { dryRun: false, source: 'qa', sourceCapture: true })
    expect([r1.status, r1.sourceRows]).toEqual(['published', 2]) // gồm dòng ONLINE (engine bỏ, lớp nguồn giữ)
    expect(on.calls.stage[on.calls.stage.length - 1]).toBe(CMS_SOURCE_PART)
  })
  test('lõi đồng bộ: cờ ON + DB không trả source_schema (trước 124 / rollback) hoặc phiên bản lạ ⇒ đóng run error SOURCE_SCHEMA_UNSUPPORTED, 0 stage / publish', async () => {
    for (const extra of [{}, { source_schema: 2 }]) {
      const x = deps({ openExtra: extra })
      const r = await runCmsSalesSync(x.d, P, { dryRun: false, source: 'qa', sourceCapture: true })
      expect([r.status, r.code, x.calls.stage.length, x.calls.publish, x.calls.finish], JSON.stringify(extra)).toEqual(['error', 'SOURCE_SCHEMA_UNSUPPORTED', 0, 0, ['error']])
    }
    const dry = deps()
    expect((await runCmsSalesSync(dry.d, P, { dryRun: true, source: 'operator', sourceCapture: true })).status).toBe('dry_run') // dry-run không mở run
  })
})

// ── DTO / action chốt ────────────────────────────────────────────────────────
const previewRaw = (o: Record<string, unknown> = {}) => ({
  program_id: P, found: true, status: 'active', is_test: true, end_date: '2026-11-01', config_version: 3, run_id: RUN, run_started_at: TS,
  amount_vnd: '42000', results_amount_vnd: '42000', staff_rows: 6, staff_paid: 6, candidate_lines: 600, candidate_gmv: '9500000', unassigned_lines: 0,
  unassigned_gmv: '0', unassigned_over: false, needs_ack: false, policy: { label: 'QA_ONLY_ASSUMPTION', completeness: 'qa_assumption' }, policy_version: 1,
  mapping_fp_run: 'a'.repeat(32), mapping_fp_now: 'a'.repeat(32), source_complete_basis: 'qa_assumption', source_complete_through: null,
  earliest_lock_at: TS, blockers: [], ...o,
})
const validAtt = { id: ATT, scope_to: '2026-11-01', field_set: 'decision10', attested_at: TS, as_of: TS, code: null }

test.describe('COMP-INT — DTO / action chốt 6 tham số @desktop', () => {
  test('preview: DB trước 124 ⇒ unsupported (không gửi tham số); NONE; hợp lệ; không còn khớp; basis operator_reconciliation phải có chứng nhận hợp lệ', () => {
    const old = parseCmsLockPreview(previewRaw())
    expect([old.sourceAttestation, cmsLockExpectedAttestation(old)]).toEqual([{ state: 'unsupported' }, undefined])
    const none = parseCmsLockPreview(previewRaw({ source_attestation: { code: 'NONE' } }))
    expect([none.sourceAttestation.state, cmsLockExpectedAttestation(none)]).toEqual(['none', null])
    const ok = parseCmsLockPreview(previewRaw({ source_attestation: validAtt, source_complete_basis: 'operator_reconciliation', source_complete_through: '2026-11-01' }))
    expect([ok.sourceAttestation.state, cmsLockExpectedAttestation(ok)]).toEqual(['valid', ATT])
    const real = parseCmsLockPreview(previewRaw({ source_attestation: validAtt, source_complete_basis: null, blockers: ['CMS_LOCK_POLICY_PENDING'] }))
    expect(cmsLockExpectedAttestation(real)).toBeNull() // có chứng nhận nhưng không thành basis ⇒ không gửi id
    const inv = parseCmsLockPreview(previewRaw({ source_attestation: { ...validAtt, code: 'STALE_MAPPING' }, source_complete_basis: null, blockers: ['CMS_LOCK_ATTEST_INVALID'] }))
    expect(inv.sourceAttestation).toEqual({ state: 'invalid', id: ATT, code: 'STALE_MAPPING' })
    expect(() => parseCmsLockPreview(previewRaw({ source_attestation: { code: 'NONE' }, source_complete_basis: 'operator_reconciliation' }))).toThrow(CmsPayoutDtoError)
    expect(() => parseCmsLockPreview(previewRaw({ source_attestation: { id: 'x', code: null } }))).toThrow(CmsPayoutDtoError)
    expect(cmsLockCodeLabel('CMS_LOCK_EVIDENCE_CHANGED')).toMatch(/vừa thay đổi/)
    expect(cmsLockCodeLabel('CMS_LOCK_ATTEST_INVALID')).toMatch(/không còn khớp/)
    expect(cmsAttestStateLabel('FP_CHANGED')).toMatch(/dữ liệu nguồn/)
    expect(cmsSourceBasisLabel('operator_reconciliation')).toMatch(/decision10/)
  })

  function lockDeps(rpcData: unknown) {
    const calls: Record<string, unknown>[] = []
    const d: CmsLockDeps = {
      lockEnabled: () => true, qaReadonly: () => false, access: async () => ({ kind: 'ok', actorId: ACTOR, qa: true }),
      program: async () => ({ isTest: true }), rpc: async (_fn, args) => { calls.push(args); return { data: rpcData, error: null } },
    }
    return { d, calls }
  }
  const base = { programId: P, expectedRunId: RUN, expectedPolicyVersion: 1, ackReason: null }
  test('lock: chỉ gửi p_expected_attestation_id khi có id; phản hồi phải nói đúng chứng nhận đã dùng; id sai dạng ⇒ BAD_INPUT', async () => {
    const reply = (att: string | null | undefined) => ({ locked: true, already: false, program_id: P, run_id: RUN, amount_vnd: '1', policy_version: 1,
      ...(att === undefined ? {} : { source_attestation_id: att }) })
    const a = lockDeps(reply(ATT))
    expect(await runCmsLock(a.d, { ...base, expectedAttestationId: ATT })).toMatchObject({ ok: true, sourceAttestationId: ATT })
    expect(a.calls[0]).toMatchObject({ p_expected_attestation_id: ATT })
    for (const v of [null, undefined]) {
      const b = lockDeps(reply(v === null ? null : undefined)) // DB 124 trả null / DB cũ không trả khoá
      expect(await runCmsLock(b.d, { ...base, expectedAttestationId: v })).toMatchObject({ ok: true, sourceAttestationId: null })
      expect('p_expected_attestation_id' in b.calls[0]).toBe(false)
    }
    expect(await runCmsLock(lockDeps(reply(ATT2)).d, { ...base, expectedAttestationId: ATT })).toEqual({ ok: false, code: 'UNKNOWN_OUTCOME' })
    expect(await runCmsLock(lockDeps(reply(ATT)).d, { ...base, expectedAttestationId: null })).toEqual({ ok: false, code: 'UNKNOWN_OUTCOME' })
    const bad = lockDeps(reply(null))
    expect(await runCmsLock(bad.d, { ...base, expectedAttestationId: 'abc' })).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(bad.calls).toHaveLength(0)
  })
  test('luồng UI: EVIDENCE_CHANGED / ATTEST_INVALID ⇒ kiểm lại (tải preview mới), không giữ sẵn sàng cũ', async () => {
    expect(CMS_LOCK_RECHECK_CODES.has('CMS_LOCK_EVIDENCE_CHANGED') && CMS_LOCK_RECHECK_CODES.has('CMS_LOCK_ATTEST_INVALID')).toBe(true)
    const o = await cmsLockConfirmFlow({ lock: async () => ({ ok: false, code: 'CMS_LOCK_EVIDENCE_CHANGED' }), preview: async () => ({ ok: false, code: 'QUERY_FAILED' }) },
      { ...base, expectedAttestationId: ATT })
    expect(o.kind).toBe('recheck')
    if (o.kind === 'recheck') expect(o.reload.preview).toBeNull()
  })

  const payoutRaw = (o: Record<string, unknown> = {}) => ({
    program_id: P, run_id: RUN, is_test: true, locked_at: TS, policy_version: 1, viewer: 'super', program_total: '30000', scope_total: '30000',
    rows: [{ user_id: uid(11), store_id: uid(21), name: 'DS A', store_name: 'NT 1', amount_vnd: '30000', products_with_cms: 1, email: 'a@x.vn' }],
    locked_by: ACTOR, staff_rows: 1, staff_paid: 1, candidate_lines: 10, candidate_gmv: '100000', unassigned_lines: 0, unassigned_gmv: '0', ack_reason: null,
    policy: { label: 'QA_ONLY_ASSUMPTION' }, source_complete_basis: 'operator_reconciliation', source_complete_through: '2026-11-01', run_started_at: TS,
    source_attestation_id: ATT, source_attestation: { field_set: 'decision10', as_of: TS, reference_label: 'Nguồn độc lập QA', lines_compared: 10, attested_at: TS, run_rows_fp: H('a') },
    ...o,
  })
  test('payout super: id + tóm tắt chứng nhận; basis ⇔ id; XLSX super có metadata, SM không', () => {
    const p = parseCmsPayout(payoutRaw())
    expect(p.super?.sourceAttestation).toMatchObject({ fieldSet: 'decision10', linesCompared: 10, referenceLabel: 'Nguồn độc lập QA' })
    expect(() => parseCmsPayout(payoutRaw({ source_attestation_id: null }))).toThrow(CmsPayoutDtoError)
    expect(() => parseCmsPayout(payoutRaw({ source_complete_basis: 'qa_assumption' }))).toThrow(CmsPayoutDtoError)
    expect(() => parseCmsPayout(payoutRaw({ source_attestation: { ...payoutRaw().source_attestation, field_set: 'audit14' } }))).toThrow(CmsPayoutDtoError)
    // DB trước 124: không khoá ⇒ null, không lỗi.
    const { source_attestation_id: _a, source_attestation: _b, ...old } = payoutRaw({ source_complete_basis: 'qa_assumption' })
    expect(parseCmsPayout(old).super?.sourceAttestationId).toBeNull()
    const prog = { id: P, name: 'QA', startDate: '2026-10-01', endDate: '2026-11-01', status: 'locked', isTest: true }
    const b = buildCmsPayoutWorkbook({ program: prog, payout: p, exportedAt: new Date(TS), scope: 'super' })
    const rows = b.ok ? XLSX.utils.sheet_to_json<string[]>(XLSX.read(b.bytes).Sheets['Thong tin'], { header: 1 }) : []
    expect(rows.find((r) => r[0] === 'Chứng nhận đối soát nguồn (id)')?.[1]).toBe(ATT)
    expect(rows.find((r) => r[0] === 'Vân tay decision10 của lần tính')?.[1]).toBe(H('a'))
    expect(rows.some((r) => /chứng nhận/i.test(String(r[0])) && /người|email/i.test(String(r[0])))).toBe(false) // không người / email chứng nhận
  })
})

// ── Lõi CLI chứng nhận ───────────────────────────────────────────────────────
const jwt = (o: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(o)).toString('base64url')}.x`

test.describe('COMP-INT — lõi CLI chứng nhận @desktop', () => {
  test('token: thiếu / không JWT / sai vai / hết hạn ⇒ mã cố định; hợp lệ ⇒ sub', () => {
    const now = Date.parse(TS)
    expect(A.cmsAttestTokenClaims(undefined, now)).toMatchObject({ ok: false, code: 'TOKEN_MISSING' })
    expect(A.cmsAttestTokenClaims('abc', now)).toMatchObject({ ok: false, code: 'TOKEN_INVALID' })
    expect(A.cmsAttestTokenClaims(jwt({ sub: ACTOR, role: 'anon', exp: now / 1000 + 3600 }), now)).toMatchObject({ ok: false, code: 'TOKEN_INVALID' })
    expect(A.cmsAttestTokenClaims(jwt({ sub: ACTOR, role: 'authenticated', exp: now / 1000 + 30 }), now)).toMatchObject({ ok: false, code: 'TOKEN_EXPIRED' })
    expect(A.cmsAttestTokenClaims(jwt({ sub: ACTOR, role: 'authenticated', exp: now / 1000 + 3600 }), now)).toMatchObject({ ok: true, value: { sub: ACTOR } })
  })

  test('phân loại RPC: CMS_* / lock_timeout / quyền / JWT ⇒ từ chối xác định; timeout / mạng / 5xx ⇒ KHÔNG RÕ', () => {
    const c = (status: number | null, body: unknown, transportError = false) => A.cmsAttestRpcOutcome({ status, body, transportError })
    expect(c(200, { id: ATT })).toEqual({ kind: 'ok', data: { id: ATT } })
    expect(c(400, { code: 'P0001', message: 'CMS_ATTEST_NOT_MATCH' })).toEqual({ kind: 'rejected', code: 'CMS_ATTEST_NOT_MATCH' })
    expect(c(400, { code: '55P03' })).toEqual({ kind: 'rejected', code: 'BUSY' })
    expect(c(403, { code: '42501' })).toEqual({ kind: 'rejected', code: 'FORBIDDEN' })
    expect(c(401, { code: 'PGRST301' })).toEqual({ kind: 'rejected', code: 'TOKEN_REJECTED' })
    expect(c(404, { code: 'PGRST202' })).toEqual({ kind: 'rejected', code: 'REQUEST_REJECTED' })
    for (const [s, b] of [[500, { code: '57014' }], [503, { code: '08006' }], [502, null], [503, { code: 'PGRST000' }]] as const) expect(c(s, b).kind).toBe('unknown')
    expect(c(null, null, true)).toEqual({ kind: 'unknown', code: 'TRANSPORT' })
    expect(c(400, { code: '23505' })).toEqual({ kind: 'rejected', code: 'QUERY_FAILED' })
  })

  const row = (id: string): Record<string, string | null> => ({ order_line_id: id, order_id: 'O', order_code: 'S', product_id: '901', seller_email: null,
    pos_code: null, order_type: 'OFFLINE', order_status: 'COMPLETED', completed_at: TS, quantity_raw: null, uom_raw: null, base_quantity: '1', gmv_amount: '1',
    source_updated_at: TS })
  test('xuất: keyset byte tăng nghiêm ngặt, next_after đúng, đếm = total trang đầu; run / schema / khoá lạ ⇒ mã', () => {
    let s = A.newCmsAttestExportState(P, RUN)
    const p1 = A.cmsAttestExportPage(s, { run_id: RUN, source_schema: 1, rows: [row('a'), row('é')], next_after: 'é', total: 3 }, 2)
    expect(p1.ok && !p1.done).toBe(true)
    if (p1.ok) s = p1.state
    const p2 = A.cmsAttestExportPage(s, { run_id: RUN, source_schema: 1, rows: [row('𝟘')], next_after: null, total: null }, 2)
    expect(p2.ok && p2.done && p2.state.rows.length === 3).toBe(true)
    const st0 = A.newCmsAttestExportState(P, RUN)
    const bad: [unknown, string][] = [
      [{ run_id: uid(99), source_schema: 1, rows: [], next_after: null, total: 0 }, 'EXPORT_RUN'],
      [{ run_id: RUN, source_schema: null, rows: [], next_after: null, total: 0 }, 'EXPORT_RUN'],
      [{ run_id: RUN, source_schema: 1, rows: [row('b'), row('a')], next_after: 'a', total: 2 }, 'EXPORT_ORDER'],
      [{ run_id: RUN, source_schema: 1, rows: [row('a'), row('a')], next_after: 'a', total: 2 }, 'EXPORT_ORDER'],
      [{ run_id: RUN, source_schema: 1, rows: [row('a'), row('b')], next_after: 'a', total: 2 }, 'EXPORT_PAGING'],
      [{ run_id: RUN, source_schema: 1, rows: [row('a')], next_after: null, total: 2 }, 'EXPORT_COUNT'],
      [{ run_id: RUN, source_schema: 1, rows: [{ ...row('a'), extra: 'x' }], next_after: null, total: 1 }, 'EXPORT_SHAPE'],
      [{ run_id: RUN, source_schema: 1, rows: [], next_after: null }, 'EXPORT_SHAPE'],
    ]
    for (const [pg, code] of bad) expect(A.cmsAttestExportPage(st0, pg, 2), JSON.stringify(pg)).toMatchObject({ ok: false, code })
    expect(A.cmsUtf8Compare('￿', '𝟘')).toBeLessThan(0) // byte UTF-8 (không phải UTF-16)
    expect(A.cmsAttestExportCsv([row('a')]).split('\r\n')[0]).toBe('order_line_id,order_id,order_code,product_id,seller_email,pos_code,order_type,order_status,completed_at,quantity_raw,uom_raw,base_quantity,gmv_amount,source_updated_at')
  })

  const prog: A.CmsAttestProgram = { id: P, isTest: true, status: 'active', startDate: '2026-10-01', endDate: '2026-10-31', productIds: ['901'], currentRunId: RUN }
  const scope = { startDate: '2026-10-01', endDate: '2026-10-31', productIds: ['901'] }
  const meta = (o: Partial<CmsI4EvidenceMeta['reference']> = {}, oa: Partial<CmsI4EvidenceMeta['app']> = {}): CmsI4EvidenceMeta => ({ version: 1,
    reference: { inputKind: 'reference_source', source: 'Nguồn độc lập QA', exportedAt: TS, asOf: TS, fileSha256: H('1'), scope, runId: null, ...o },
    app: { inputKind: 'published_run', source: 'rpc_cms_run_source_export', exportedAt: TS, asOf: TS, fileSha256: H('2'), scope, runId: RUN, ...oa } })
  const side = { inputKind: null, fileSha256: null, rowsRead: 5, rowIssues: 0, issues: {}, duplicateLineIds: 0, nonCanonicalProductId: 0, outOfScope: 0, inScope: 5,
    candidates: 5, afterAsOf: 0, afterExportedAt: 0, rowsFp: H('c'), decisionFp: H('d') }
  const cmp = (o: Partial<CmsI4CompareResult> = {}): CmsI4CompareResult => ({
    version: 'cms-i4-compare-v1', fpVersion: 'cms-rows-fp-v1', verdict: 'MATCH', dataIssues: [], notProven: [], limits: [],
    scope: { startDate: '2026-10-01', endDate: '2026-10-31', products: 1, scopeHash: '' }, asOf: TS,
    reference: { ...side, inputKind: 'reference_source' }, app: { ...side, inputKind: 'published_run' },
    compare: { matched: 5, missing: 0, extra: 0, changed: 0, changedByField: {}, infoDiffByField: {} },
    totals: {} as CmsI4CompareResult['totals'], runBinding: { claimedRunId: RUN, verifiedAgainstDb: false }, details: { missing: [], extra: [], changed: [], duplicates: [] }, ...o,
  })
  test('payload: chỉ MATCH decision10 toàn kỳ / toàn SP của run hiện hành; mọi lệch ⇒ lý do, chưa gọi DB', async () => {
    const { cmsI4ScopeHash } = await import('./cmsI4CompareSource')
    const sh = cmsI4ScopeHash(scope)
    const good = cmp({ scope: { startDate: scope.startDate, endDate: scope.endDate, products: 1, scopeHash: sh } })
    const ok = A.cmsAttestBuildPayload({ program: prog, runId: RUN, compare: good, meta: meta(), refSha: H('1'), appSha: H('2'), ack: '  Đã đối soát nguồn QA  ' })
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.payload).toMatchObject({ field_set: 'decision10', run_rows_fp: H('d'), reference_rows_fp: H('d'), lines_compared: '5', ack_reason: 'Đã đối soát nguồn QA', tool_version: 'cms-i4-compare-v1' })
      expect(Object.keys(ok.payload)).not.toContain('actor')
    }
    const cases: [Parameters<typeof A.cmsAttestBuildPayload>[0], RegExp][] = [
      [{ program: prog, runId: RUN, compare: { ...good, verdict: 'MISMATCH', dataIssues: ['CHANGED:gmv'] }, meta: meta(), refSha: H('1'), appSha: H('2'), ack: 'Đã đối soát nguồn QA' }, /không MATCH/],
      [{ program: prog, runId: RUN, compare: { ...good, reference: { ...good.reference, decisionFp: H('e') } }, meta: meta(), refSha: H('1'), appSha: H('2'), ack: 'Đã đối soát nguồn QA' }, /decision10 hai bên/],
      [{ program: { ...prog, currentRunId: uid(77) }, runId: RUN, compare: good, meta: meta(), refSha: H('1'), appSha: H('2'), ack: 'Đã đối soát nguồn QA' }, /run hiện hành/],
      [{ program: prog, runId: RUN, compare: good, meta: meta({ scope: { ...scope, productIds: ['902'] } }), refSha: H('1'), appSha: H('2'), ack: 'Đã đối soát nguồn QA' }, /phạm vi/],
      [{ program: prog, runId: RUN, compare: good, meta: meta(), refSha: H('9'), appSha: H('2'), ack: 'Đã đối soát nguồn QA' }, /sha256/],
      [{ program: prog, runId: RUN, compare: good, meta: meta({}, { runId: uid(78) }), refSha: H('1'), appSha: H('2'), ack: 'Đã đối soát nguồn QA' }, /published_run của đúng run/],
      [{ program: prog, runId: RUN, compare: good, meta: meta(), refSha: H('1'), appSha: H('2'), ack: 'ngắn' }, /--ack/],
      [{ program: prog, runId: RUN, compare: { ...good, app: { ...good.app, outOfScope: 1 } }, meta: meta(), refSha: H('1'), appSha: H('2'), ack: 'Đã đối soát nguồn QA' }, /ngoài scope/],
      [{ program: { ...prog, status: 'locked' }, runId: RUN, compare: good, meta: meta(), refSha: H('1'), appSha: H('2'), ack: 'Đã đối soát nguồn QA' }, /locked/],
    ]
    for (const [i, re] of cases) {
      const r = A.cmsAttestBuildPayload(i)
      expect(r.ok, String(re)).toBe(false)
      if (!r.ok) expect(r.reasons.join(' | ')).toMatch(re)
    }
  })

  const op = (o: Partial<A.CmsAttestOp> = {}): A.CmsAttestOp => ({
    ...A.newCmsAttestOp({ operationId: 'a-0123456789ab', op: 'attest', qaRunId: 'cms-qa-20261105abcd-1a2b', host: 'h.example', pid: 4242, programId: P, runId: RUN,
      attestationId: null, idemKey: uid(500), payloadSha256: H('f'), actorId: ACTOR, startedAt: TS }), ...o })
  test('sổ: ý định hợp lệ / hỏng; outcome; chặn thao tác chưa khép; reconcile theo khoá idem (found / khác / chờ / lắng)', () => {
    expect(A.parseCmsAttestOp(JSON.stringify(op())).ok).toBe(true)
    for (const bad of [{ ...op(), idemKey: 'x' }, { ...op(), status: 'done', result: null }, { ...op(), kind: 'x' }]) expect(A.parseCmsAttestOp(JSON.stringify(bad)).ok).toBe(false)
    expect(() => A.newCmsAttestOp({ ...op(), op: 'attest', payloadSha256: null } as never)).toThrow()
    expect(A.cmsAttestOpOutcome({ kind: 'ok', data: {} }, true)).toBe('done')
    expect(A.cmsAttestOpOutcome({ kind: 'ok', data: {} }, false)).toBe('unknown')
    expect(A.cmsAttestOpOutcome({ kind: 'rejected', code: 'X' }, false)).toBe('rejected')
    expect(A.cmsAttestPendingOps([op(), op({ status: 'done', result: { code: null, attestationId: ATT, already: false } }), op({ status: 'unknown', result: { code: 'TRANSPORT', attestationId: null, already: false } })], P)).toHaveLength(2)
    const now = Date.parse(TS) + 120_000
    const probe = { can_see_all: true, hidden: 0, inflight: 0 }
    const e = op({ status: 'unknown', finishedAt: TS, result: { code: 'TRANSPORT', attestationId: null, already: false } })
    expect(A.cmsAttestReconcileCheck(e, [{ id: ATT, program_id: P, run_id: RUN, attested_by: ACTOR, revoked_by: null }], { nowMs: now, pidAlive: false, probe }))
      .toEqual({ ok: true, found: true, attestationId: ATT })
    expect(A.cmsAttestReconcileCheck(e, [{ id: ATT, program_id: P, run_id: uid(66), attested_by: ACTOR, revoked_by: null }], { nowMs: now, pidAlive: false, probe }).ok).toBe(false)
    expect(A.cmsAttestReconcileCheck(e, [], { nowMs: now, pidAlive: false, probe: { ...probe, inflight: 1 } })).toMatchObject({ ok: false, wait: true })
    expect(A.cmsAttestReconcileCheck(e, [], { nowMs: Date.parse(TS) + 1000, pidAlive: false, probe })).toMatchObject({ ok: false, wait: true })
    expect(A.cmsAttestReconcileCheck(e, [], { nowMs: now, pidAlive: false, probe: { ...probe, can_see_all: false } }).ok).toBe(false)
    expect(A.cmsAttestReconcileCheck(e, [], { nowMs: now, pidAlive: false, probe })).toEqual({ ok: true, found: false, attestationId: null })
    expect(A.cmsAttestReconcileCheck(op(), [], { nowMs: now, pidAlive: true, probe })).toMatchObject({ ok: false, wait: true })
  })

  test('close QA: intent / unknown / ngoài sổ / thật do QA ⇒ ĐỎ; thật do người khác ⇒ cảnh báo; sổ nói ghi mà DB không có ⇒ ĐỎ', () => {
    const QA = 'cms-qa-20261105abcd-1a2b'
    const m = { runId: QA, users: [{ id: ACTOR, role: 'admin', markerExpiresAt: TS }], programs: [{ id: P, status: 'active', isTest: true }] } as unknown as CmsQaRunManifest
    const f = (e: A.CmsAttestOp) => ({ name: `${e.operationId}.json`, text: JSON.stringify(e) })
    const done = op({ status: 'done', finishedAt: TS, result: { code: null, attestationId: ATT, already: false } })
    const rowA = { id: ATT, program_id: P, program_is_test: true, attested_by: ACTOR, idem_key: uid(500), attested_in_run: true, revoked_by: null, revoke_idem_key: null, revoked_in_run: false }
    const opts = { pidAlive: () => false, attestTable: true, programIdsInRun: [P] }
    expect(A.cmsQaAttestCloseCheck(m, [f(done)], [rowA], opts).reasons).toEqual([])
    expect(A.cmsQaAttestCloseCheck(m, [f(op())], [], opts).reasons.join()).toMatch(/không rõ kết thúc/)
    expect(A.cmsQaAttestCloseCheck(m, [], [rowA], opts).reasons.join()).toMatch(/ngoài sổ/)
    expect(A.cmsQaAttestCloseCheck(m, [f(done)], [], opts).reasons.join()).toMatch(/DB không có/)
    const real = A.cmsQaAttestCloseCheck(m, [], [{ ...rowA, program_id: uid(88), program_is_test: false }], opts)
    expect(real.reasons.join()).toMatch(/THẬT/)
    const other = A.cmsQaAttestCloseCheck(m, [], [{ ...rowA, program_id: uid(88), program_is_test: false, attested_by: uid(77) }], opts)
    expect([other.reasons, other.warningProgramIds]).toEqual([[], [uid(88)]])
    expect(A.cmsQaAttestCloseCheck(m, [{ name: 'a-0123456789ab.json', text: '{' }], [], opts).reasons.join()).toMatch(/hỏng/)
    expect(R.cmsQaLedgerPartition(['a-0123456789ab.json', 'x-0123456789ab.json']).attests).toEqual(['a-0123456789ab.json'])
    expect(R.cmsQaLedgerPartition(['x-0123456789ab.json']).exports).toEqual(['x-0123456789ab.json'])
    // Sổ xuất (security review P1-1): hỏng / khác run ⇒ ĐỎ; còn chạy ⇒ ĐỎ; xong ⇒ vào danh sách.
    const x = A.newCmsAttestExportRecord({ exportId: 'x-0123456789ab', qaRunId: QA, host: 'h', pid: 7, programId: P, runId: RUN, actorId: ACTOR, startedAt: TS })
    const xf = (e: unknown) => ({ name: 'x-0123456789ab.json', text: JSON.stringify(e) })
    expect(A.cmsQaExportsCloseCheck(m, [xf({ ...x, status: 'done', rows: 3, sha256: H('a') })], () => false)).toMatchObject({ reasons: [], entries: [{ rows: 3 }] })
    expect(A.cmsQaExportsCloseCheck(m, [xf(x)], () => true).reasons.join()).toMatch(/CÒN CHẠY/)
    expect(A.cmsQaExportsCloseCheck(m, [xf({ ...x, qaRunId: 'cms-qa-20261105zzzz-ffff' })], () => false).reasons.join()).toMatch(/run khác/)
    expect(A.cmsQaExportsCloseCheck(m, [xf({ ...x, status: 'done' })], () => false).reasons.join()).toMatch(/hỏng/)
    expect(JSON.stringify(x)).not.toMatch(/@/)
  })

  test('QA chốt: --expect-attestation chỉ cho lock, phải UUID; sổ chốt ghi id chứng nhận', () => {
    expect(R.parseCmsQaLockArgs({ actor: ACTOR, expectRun: RUN, policyVersion: '1', expectAttestation: ATT.toUpperCase() }, true))
      .toMatchObject({ ok: true, value: { expectedAttestationId: ATT } })
    expect(R.parseCmsQaLockArgs({ actor: ACTOR, expectRun: RUN, policyVersion: '1', expectAttestation: 'x' }, true).ok).toBe(false)
    expect(R.parseCmsQaLockArgs({ actor: ACTOR, expectAttestation: ATT }, false).ok).toBe(false)
    const e = R.newCmsQaLockEntry({ operationId: 'l-0123456789ab', qaRunId: 'cms-qa-20261105abcd-1a2b', pid: 1, programId: P, actorId: ACTOR, expectedRunId: RUN,
      policyVersion: 1, ack: false, now: TS, expectedAttestationId: ATT })
    expect(R.parseCmsQaLockEntry(JSON.stringify(e))).toMatchObject({ ok: true, value: { expectedAttestationId: ATT } })
    expect(R.parseCmsQaLockEntry(JSON.stringify({ ...e, expectedAttestationId: 'x' })).ok).toBe(false)
  })
})
