import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter, once } from 'node:events'
import { execFileSync, spawnSync } from 'node:child_process'
import { test, expect } from '@playwright/test'
import { CMS_QA_MARKER, cmsWriteGate } from './writeQaGates'
import {
  CMS_QA_EXIT_GRACE_MS, CmsQaServerNotStoppedError, cmsQaServerExitCode, runCmsQaServerLifecycle,
  CMS_QA_GIT_STATUS_ARGS, CMS_QA_GUARD_MINUTES_MIN, CMS_QA_POLL_MS, CMS_QA_TICK_MS, cmsQaTreeState, createCmsQaWatchdog,
  parseCmsQaGuardMinutes, startCmsQaWatchdogLoop,
  CMS_QA_GRANTED_BY, assertCmsQaProgramIds, cmsQaAckWarnings, cmsQaCloseCheck, cmsQaGrantSql, cmsQaManifestAddProgram, cmsQaPreflight,
  cmsQaRevokeSql, cmsQaStatusSql, cmsQaWatchdog, cmsVerifyV8Sql, evaluateCmsV8, maskCmsUuid, newCmsQaManifest, parseCmsQaManifest,
  CMS_VERIFY_PHASES, CMS_PHASE_FUNCTIONS, CMS_FN_MATRIX, CMS_FN_DEF_122, CMS_COL_122, CMS_TABLE_SHAPE_122, cmsFnCountBefore,
  CMS_FN_DEF_123, CMS_COL_123, CMS_TABLE_SHAPE_123, CMS_TRIGGERS_123, CMS_FN_SRC_123, CMS_TABLES_FROZEN_123, CMS_V8_PHASES, CMS_V8_RPC_CALLABLE,
  CMS_FN_DEF_124, CMS_COL_124, CMS_TABLE_SHAPE_124, CMS_TRIGGERS_124, CMS_FN_SRC_124, CMS_FN_CFG_124,
  CMS_FN_DEF_125, CMS_COL_125, CMS_TABLE_SHAPE_125, CMS_TRIGGERS_125, CMS_FN_SRC_125, CMS_FN_SRC_126, CMS_127_T11_ID, CMS_127_PM_RATES_MD5,
  CMS_FN_DEF_128, CMS_COL_128, CMS_TABLE_SHAPE_128, CMS_TRIGGERS_128, CMS_FN_SRC_128, CMS_128_UNIT_KEY_VERSION,
  evaluateCmsVerify,
  cmsVerifyAclSql, cmsVerifyV8Sql123, cmsV8ProvenKeys, cmsPostProvenKeys, CMS_VERIFY_SQL, CMS_PAYOUT_KEYS_TOP, CMS_PAYOUT_KEYS_TOP_SUPER, CMS_PAYOUT_KEYS_ROW,
  parseCmsQaTtlHours, parseCmsQaUserIds, pgMetaReadOnly, pgMetaReadOnlySnapshot, pgMetaWrite, toIsoUtc, type CmsQaProgramRow,
  type CmsQaStatusRow, type CmsV8Role,
} from './cmsQaTooling'
import { CMS_UNIT_KEY_VERSION } from '../lib/cms/unitKey'

// CMS P1-R1 / P1-R2 (review PM runbook P1 02/11) — công cụ QA ghi prod + VERIFY chỉ đọc. Spec THUẦN + CLI âm (không
// mạng: URL giả .invalid, mọi ca thoát 2 TRƯỚC IO) + QA PGlite (migration 120 / 121 thật, scripts/qa-cms-qa-tooling.mjs).

const WEBAPP = path.resolve(__dirname, '..')
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const P1 = '33333333-3333-4333-8333-333333333333'
const P2 = '44444444-4444-4444-8444-444444444444'
const URL_PROD_LIKE = 'https://db.example.test'

const gate = (env: Record<string, string | undefined>, envFileText: string | null = '', markerExists = false) =>
  cmsWriteGate({ env: { NEXT_PUBLIC_SUPABASE_URL: URL_PROD_LIKE, ...env }, envFileText, markerExists })

test.describe('CMS QA tooling · cmsWriteGate @desktop', () => {
  const OK = { E2E_CMS_WRITE_QA: 'YES', E2E_EXPECTED_SUPABASE_HOST: 'db.example.test' }

  test('đủ điều kiện ⇒ mở, trả host', () => {
    expect(gate(OK)).toEqual({ ok: true, host: 'db.example.test' })
    expect(gate(OK, null)).toEqual({ ok: true, host: 'db.example.test' })
    expect(gate(OK, 'CMS_PROGRAM_ENABLED=false\n')).toEqual({ ok: true, host: 'db.example.test' })
  })

  test('thiếu opt-in process ⇒ chặn', () => {
    for (const v of [undefined, '', 'yes', 'true', '1']) {
      const r = gate({ ...OK, E2E_CMS_WRITE_QA: v })
      expect(r.ok, String(v)).toBe(false)
      if (!r.ok) expect(r.reason).toContain('E2E_CMS_WRITE_QA=YES')
    }
  })

  test('cờ xác nhận hoặc CMS_PROGRAM_ENABLED=true nằm trong .env.local ⇒ chặn', () => {
    for (const text of ['E2E_CMS_WRITE_QA=YES', '  export E2E_EXPECTED_SUPABASE_HOST = db.example.test', 'X=1\nE2E_CMS_WRITE_QA=NO']) {
      const r = gate(OK, text)
      expect(r.ok, text).toBe(false)
      if (!r.ok) expect(r.reason).toContain('.env.local')
    }
    for (const text of ['CMS_PROGRAM_ENABLED=true', 'export CMS_PROGRAM_ENABLED="true"', "  CMS_PROGRAM_ENABLED = 'true'", 'CMS_PROGRAM_ENABLED=true # bật thử']) {
      const r = gate(OK, text)
      expect(r.ok, text).toBe(false)
      if (!r.ok) expect(r.reason).toContain('CMS_PROGRAM_ENABLED')
    }
  })

  test('sai host / thiếu URL / host thiếu port ⇒ chặn', () => {
    const wrong = gate({ ...OK, E2E_EXPECTED_SUPABASE_HOST: 'other.example.test' })
    expect(wrong.ok).toBe(false)
    const noUrl = cmsWriteGate({ env: { ...OK }, envFileText: null, markerExists: false })
    expect(noUrl.ok).toBe(false)
    const withPort = cmsWriteGate({ env: { ...OK, NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321' , E2E_EXPECTED_SUPABASE_HOST: 'localhost' }, envFileText: null, markerExists: false })
    expect(withPort.ok).toBe(false)
    const withPortOk = cmsWriteGate({ env: { ...OK, NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321', E2E_EXPECTED_SUPABASE_HOST: 'localhost:54321' }, envFileText: null, markerExists: false })
    expect(withPortOk).toEqual({ ok: true, host: 'localhost:54321' })
  })

  test('manifest run trước còn mở ⇒ chặn, chỉ đường đóng run', () => {
    const r = gate(OK, '', true)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('cms-qa-run.mjs close')
    expect(CMS_QA_MARKER).toBe('.qa-cms.json')
  })
})

test.describe('CMS QA tooling · tham số và SQL mẫu cố định @desktop', () => {
  test('user_id: chỉ UUID, không email; chuẩn hoá, bỏ trùng, giới hạn', () => {
    expect(parseCmsQaUserIds(`${B.toUpperCase()}, ${A},${A}`)).toEqual({ ok: true, value: [A, B] })
    expect(parseCmsQaUserIds('qa@example.test').ok).toBe(false)
    expect(parseCmsQaUserIds(`${A},abc`).ok).toBe(false)
    expect(parseCmsQaUserIds('').ok).toBe(false)
    expect(parseCmsQaUserIds(undefined).ok).toBe(false)
    expect(parseCmsQaUserIds(`${A}'); DROP TABLE x; --`).ok).toBe(false)
    const many = Array.from({ length: 21 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`).join(',')
    expect(parseCmsQaUserIds(many).ok).toBe(false)
  })

  test('TTL: số nguyên 1…168 giờ', () => {
    expect(parseCmsQaTtlHours('1')).toEqual({ ok: true, value: 1 })
    expect(parseCmsQaTtlHours('168')).toEqual({ ok: true, value: 168 })
    for (const bad of ['0', '169', '1.5', '-1', 'abc', '', undefined]) expect(parseCmsQaTtlHours(bad).ok, String(bad)).toBe(false)
  })

  test('builder kiểm lại đầu vào; SQL chỉ chứa giá trị đã kiểm', () => {
    expect(() => cmsQaGrantSql([A, 'x'], 2)).toThrow()
    expect(() => cmsQaGrantSql([A], 0)).toThrow()
    expect(() => cmsQaGrantSql([A], 169)).toThrow()
    expect(() => cmsQaRevokeSql([])).toThrow()
    expect(() => cmsVerifyV8Sql('not-a-uuid', 'staff')).toThrow()
    const g = cmsQaGrantSql([A, B], 24)
    expect(g).toContain(`'{${A},${B}}'::uuid[]`)
    expect(g).toContain('make_interval(hours => 24)')
    expect(g).toContain(`'${CMS_QA_GRANTED_BY}'`)
    expect(g).toContain("RAISE EXCEPTION 'CMS_QA_UNKNOWN_USER'")
    expect(cmsQaRevokeSql([A])).toBe(`DELETE FROM public.cms_qa_access WHERE user_id = ANY('{${A}}'::uuid[]) RETURNING user_id::text AS user_id`)
    expect(cmsQaStatusSql([A])).not.toMatch(/email|full_name|phone/i)
  })

  test('bọc đọc = READ ONLY … ROLLBACK; bọc ghi = BEGIN … COMMIT', () => {
    expect(pgMetaReadOnly('SELECT 1;')).toBe('BEGIN; SET TRANSACTION READ ONLY; SELECT 1; ROLLBACK;')
    expect(pgMetaWrite(cmsQaRevokeSql([A]))).toMatch(/^BEGIN; DELETE .* COMMIT;$/)
    expect(() => cmsVerifyV8Sql(A, 'root' as CmsV8Role)).toThrow()
    const v8 = pgMetaReadOnlySnapshot(cmsVerifyV8Sql(A, 'staff'))
    expect(v8.startsWith('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; DO $cmsv8$')).toBe(true)
    expect(v8).toContain("v_decl text := 'staff';")
    expect(v8).toContain('\nSET LOCAL ROLE authenticated;\n')
    expect(v8.endsWith('ROLLBACK;')).toBe(true)
    expect(v8).not.toMatch(/(^|\s)SET ROLE |RESET|COMMIT|secret|jwt_secret/i)
    // pg-meta trả result set CUỐI CÙNG CÓ DÒNG ⇒ trong V8 chỉ câu SELECT cuối được trả dòng (bước trước là DO / SET).
    expect(v8.split('\n').filter((l) => /^(SELECT|WITH) /.test(l)).map((l) => l.slice(0, 6))).toEqual(['WITH h', 'SELECT'])
  })

  test('timestamp DB ⇒ ISO UTC: text Postgres của pg-meta, ISO, Date; sai ⇒ lỗi', () => {
    expect(toIsoUtc('2026-11-02 04:09:18.373453+00')).toBe('2026-11-02T04:09:18.373Z')
    expect(toIsoUtc('2026-11-02 11:09:18+07')).toBe('2026-11-02T04:09:18.000Z')
    expect(toIsoUtc('2026-11-02 11:09:18.5+0700')).toBe('2026-11-02T04:09:18.500Z')
    expect(toIsoUtc('2026-11-02T04:09:18.373Z')).toBe('2026-11-02T04:09:18.373Z')
    expect(toIsoUtc(new Date(Date.UTC(2026, 10, 2, 4, 9, 18)))).toBe('2026-11-02T04:09:18.000Z')
    expect(() => toIsoUtc('hôm qua')).toThrow()
    expect(() => toIsoUtc(null)).toThrow()
  })

  test('che UUID trong log', () => {
    expect(maskCmsUuid(A)).toBe('11111111…')
    expect(maskCmsUuid('x')).toBe('—')
  })
})

const row = (o: Partial<CmsQaStatusRow>): CmsQaStatusRow => ({
  user_id: A, user_exists: true, role: 'admin', store_type: null, store_active: null, granted_by: 'qa-script:operator',
  granted_at: '2026-11-02T01:00:00.000Z', expires_at: '2026-11-02T05:00:00.000Z', db_now: '2026-11-02T02:00:00.000Z',
  active: true, remaining_s: 3 * 3600, ...o,
})

test.describe('CMS QA tooling · preflight, manifest, đóng run, id is_test @desktop', () => {
  test('preflight: thiếu tài khoản / không marker / hết hạn / còn ít hơn tối thiểu ⇒ chặn', () => {
    expect(cmsQaPreflight([row({})], [A], 60)).toMatchObject({ ok: true, dbNow: '2026-11-02T02:00:00.000Z' })
    const cases: Array<[Partial<CmsQaStatusRow>, RegExp]> = [
      [{ user_exists: false, role: null }, /không có tài khoản/],
      [{ active: false, expires_at: null, remaining_s: 0 }, /chưa có marker/],
      [{ active: false, remaining_s: 0 }, /đã hết hạn/],
      [{ remaining_s: 59 * 60 }, /tối thiểu 60/],
    ]
    for (const [o, re] of cases) {
      const r = cmsQaPreflight([row(o)], [A], 60)
      expect(r.ok, JSON.stringify(o)).toBe(false)
      if (!r.ok) {
        expect(r.reasons.join()).toMatch(re)
        expect(r.reasons.join()).not.toContain(A) // chỉ id che
      }
    }
    expect(cmsQaPreflight([row({})], [A, B], 60).ok).toBe(false) // thiếu dòng của B
  })

  const manifest = () => newCmsQaManifest({
    runId: 'cms-qa-x', mode: 'manual-localhost', host: 'db.example.test', dbNow: '2026-11-02 02:00:00.123456+00', // dạng pg-meta trả
    gitHead: 'a'.repeat(40), gitTree: 'b'.repeat(40), buildId: 'B1', port: 3120,
    users: [{ id: A, role: 'admin', markerExpiresAt: '2026-11-02 05:00:00+00', remainingS: 10800 }],
  })

  test('manifest: tạo / đọc lại; từ chối file hỏng', () => {
    const m = manifest()
    expect(m).toMatchObject({ status: 'open', startedAt: '2026-11-02T02:00:00.123Z', buildId: 'B1', serverPid: null, programs: [], closedAt: null })
    expect(parseCmsQaManifest(JSON.stringify({ ...m, port: 80 })).ok).toBe(false)
    expect(parseCmsQaManifest(JSON.stringify(m))).toEqual({ ok: true, value: m })
    expect(parseCmsQaManifest('{').ok).toBe(false)
    expect(parseCmsQaManifest(JSON.stringify({ ...m, kind: 'x' })).ok).toBe(false)
    expect(parseCmsQaManifest(JSON.stringify({ ...m, users: [] })).ok).toBe(false)
    expect(parseCmsQaManifest(JSON.stringify({ ...m, users: [{ id: 'qa@example.test' }] })).ok).toBe(false)
    expect(parseCmsQaManifest(JSON.stringify({ ...m, startedAt: '2026-11-02 02:00' })).ok).toBe(false)
  })

  const prog = (o: Partial<CmsQaProgramRow>): CmsQaProgramRow => ({ id: P1, status: 'draft', is_test: true, qa_touched: true, changed_in_run: true, ...o })

  test('đóng run: chương trình thật QA chạm ⇒ đỏ; người khác đổi ⇒ cảnh báo; sạch ⇒ manifest đóng có chương trình QA', () => {
    const m = manifest()
    const red = cmsQaCloseCheck(m, [prog({}), prog({ id: P2, is_test: false })], [row({})], [])
    expect(red.ok).toBe(false)
    expect(red.closed.closeCheck?.realProgramsTouchedByQaUsers).toEqual([P2])
    expect(red.reasons.join()).not.toContain(P2) // chỉ id che
    const warn = cmsQaCloseCheck(m, [prog({}), prog({ id: P2, is_test: false, qa_touched: false })], [row({ active: false })], [])
    expect(warn.ok).toBe(true)
    expect(warn.warnings).toHaveLength(1)
    expect(warn.closed).toMatchObject({ status: 'closed', programs: [{ id: P1, status: 'draft', isTest: true }], closedAt: '2026-11-02T02:00:00.000Z' })
    expect(warn.closed.closeCheck).toEqual({ realProgramsTouchedByQaUsers: [], realProgramsChangedByOthers: [P2], markerActiveAtClose: [] })
    const quiet = cmsQaCloseCheck(m, [prog({ id: P2, is_test: false, qa_touched: false, changed_in_run: false })], [row({})], [])
    expect(quiet.ok && quiet.warnings.length === 0).toBe(true)
    expect(quiet.closed.closeCheck?.markerActiveAtClose).toEqual([A])
  })

  test('đóng run: id ghi trong manifest phải còn trong DB và is_test = true (đọc lại cờ, không tin isTest ghi sẵn)', () => {
    const m = cmsQaManifestAddProgram(cmsQaManifestAddProgram(manifest(), P1), P2)
    const good = cmsQaCloseCheck(m, [], [row({})], [{ id: P1, is_test: true }, { id: P2, is_test: true }])
    expect(good.ok).toBe(true)
    expect(good.closed.programs.map((p) => p.id)).toEqual([P1, P2])
    const lied = cmsQaCloseCheck(m, [], [row({})], [{ id: P1, is_test: true }, { id: P2, is_test: false }])
    expect(lied.ok).toBe(false)
    expect(lied.reasons.join()).toContain('is_test = false')
    expect(lied.closed.programs.map((p) => p.id)).toEqual([P1]) // không khai chương trình thật là QA
    const gone = cmsQaCloseCheck(m, [], [row({})], [{ id: P1, is_test: true }])
    expect(gone.ok).toBe(false)
    expect(gone.reasons.join()).toContain('không còn trong DB')
  })

  test('QA tự động chỉ thao tác id đã chứng minh is_test và đã ghi vào run đang mở (manifest bắt buộc)', () => {
    const open = manifest()
    const m = cmsQaManifestAddProgram(open, P1)
    const real = assertCmsQaProgramIds([P1], [{ id: P1, is_test: false }], m)
    expect(real.ok).toBe(false)
    if (!real.ok) expect(real.reasons.join()).toContain('is_test = false')
    expect(assertCmsQaProgramIds([P1], [], m).ok).toBe(false)
    expect(assertCmsQaProgramIds([], [], m).ok).toBe(false)
    expect(assertCmsQaProgramIds(['../x'], [{ id: '../x', is_test: true }], m).ok).toBe(false)
    expect(assertCmsQaProgramIds([P1], [{ id: P1, is_test: true }], open).ok).toBe(false) // chưa ghi vào run
    expect(assertCmsQaProgramIds([P1], [{ id: P1, is_test: true }], null as unknown as typeof m).ok).toBe(false) // thiếu manifest
    expect(cmsQaManifestAddProgram(m, P1)).toBe(m) // ghi lặp không nhân đôi
    expect(assertCmsQaProgramIds([P1], [{ id: P1, is_test: true }], m)).toEqual({ ok: true })
    expect(assertCmsQaProgramIds([P2], [{ id: P2, is_test: true }], m).ok).toBe(false)
    expect(assertCmsQaProgramIds([P1], [{ id: P1, is_test: true }], { ...m, status: 'closed' }).ok).toBe(false)
    expect(() => cmsQaManifestAddProgram({ ...m, status: 'closed' }, P2)).toThrow()
    expect(() => cmsQaManifestAddProgram(m, 'x')).toThrow()
  })

  test('canh marker: còn trên ngưỡng ⇒ chạy; dưới ngưỡng / mất marker / thiếu dòng ⇒ dừng', () => {
    expect(cmsQaWatchdog([row({})], [A], 10)).toEqual({ stop: false, reasons: [] })
    expect(cmsQaWatchdog([row({ remaining_s: 9 * 60 })], [A], 10).stop).toBe(true)
    expect(cmsQaWatchdog([row({ active: false, remaining_s: 0 })], [A], 10).stop).toBe(true)
    expect(cmsQaWatchdog([row({ user_exists: false })], [A], 10).stop).toBe(true)
    expect(cmsQaWatchdog([row({})], [A, B], 10).stop).toBe(true)
  })

  test('V8: phiên / snapshot / super / RLS / tập id / từng bảng / riêng tư — mỗi lệch ⇒ đỏ; tổng = kỳ vọng ⇒ CHƯA CHỨNG MINH', () => {
    const good: Record<string, unknown> = {
      role_now: 'authenticated', uid: A, ro: 'on', iso: 'repeatable read', me_bypass: false, runner_bypass: true, user_role: 'staff', su: false, db_phase: '121',
      qa_db: false, qa: false, same_set: true, readable: 2,
      rls_cms_programs: true, rls_cms_program_stores: true, rls_cms_program_products: true, rls_cms_program_tiers: true,
      rls_cms_import_runs: true, rls_cms_product_master: true,
      seen_programs: 2, exp_programs: 2, total_programs: 5, seen_stores: 2, exp_stores: 2, total_stores: 6,
      seen_products: 3, exp_products: 3, total_products: 7, seen_tiers: 4, exp_tiers: 4, total_tiers: 9,
      seen_import_runs: 0, exp_import_runs: 0, total_import_runs: 2, seen_master: 0, exp_master: 0, total_master: 9,
      test_programs: 0, draft_programs: 0, out_programs: 0, out_stores: 0, out_products: 0, out_tiers: 0, out_import_runs: 0,
      read_qa_access: false, read_sync_runs: false, write_programs: false, private_tables: 0, rpc_callable: '',
    }
    // --require-proven: bảng yêu cầu đã chứng minh ⇒ đạt; CHƯA ⇒ đỏ (gate D3 do máy ép).
    expect(evaluateCmsV8(good, A, 'staff', { requireProven: ['programs', 'products'] }).every((c) => c.ok)).toBe(true)
    expect(evaluateCmsV8({ ...good, total_programs: 2 }, A, 'staff', { requireProven: ['programs'] }).filter((c) => !c.ok).map((c) => c.id))
      .toEqual(['v8-require-proven:programs'])
    const okRun = evaluateCmsV8(good, A, 'staff', { qa: false, readable: 2 })
    expect(okRun.filter((c) => !c.ok)).toEqual([])
    expect(okRun.filter((c) => c.id.startsWith('v8-table:')).every((c) => c.proven === true)).toBe(true)
    expect(evaluateCmsV8({ ...good, total_programs: 2 }, A, 'staff').find((c) => c.id === 'v8-table:programs')).toMatchObject({ ok: true, proven: false })
    expect(evaluateCmsV8({ ...good, user_role: 'store_manager' }, A, 'qlch').every((c) => c.ok)).toBe(true)
    const bad: Array<[Record<string, unknown>, CmsV8Role, string]> = [
      [{ user_role: '' }, 'staff', 'v8-user'], [{}, 'qlch', 'v8-user'],
      [{ su: true }, 'staff', 'v8-super'], [{ user_role: 'admin' }, 'super', 'v8-super'],
      [{ role_now: 'service_role' }, 'staff', 'v8-session'], [{ uid: B }, 'staff', 'v8-session'], [{ ro: 'off' }, 'staff', 'v8-session'],
      [{ iso: 'read committed' }, 'staff', 'v8-session'], [{ me_bypass: true }, 'staff', 'v8-session'], [{ runner_bypass: false }, 'staff', 'v8-session'],
      [{ rls_cms_program_tiers: false }, 'staff', 'v8-rls-active'],
      [{ same_set: false }, 'staff', 'v8-oracle-set'], [{ seen_programs: 3 }, 'staff', 'v8-oracle-set'], [{ exp_programs: 3 }, 'staff', 'v8-oracle-set'],
      [{ out_products: 1 }, 'staff', 'v8-outside'], [{ out_import_runs: 1 }, 'staff', 'v8-outside'],
      [{ seen_stores: 3 }, 'staff', 'v8-table:stores'], [{ seen_products: 2 }, 'staff', 'v8-table:products'], [{ seen_tiers: 5 }, 'staff', 'v8-table:tiers'],
      [{ seen_import_runs: 1 }, 'staff', 'v8-table:import_runs'], [{ seen_master: 1 }, 'staff', 'v8-table:master'],
      [{ qa: true }, 'staff', 'v8-oracle-qa'], [{ draft_programs: 1 }, 'staff', 'v8-no-draft'], [{ test_programs: 1 }, 'staff', 'v8-no-test-without-marker'],
      [{ read_qa_access: true }, 'staff', 'v8-private'], [{ write_programs: true }, 'staff', 'v8-private'], [{ rpc_callable: 'rpc_cms_result_rows' }, 'staff', 'v8-private'],
      [{ private_tables: 1 }, 'staff', 'v8-private'], [{ db_phase: '122' }, 'staff', 'v8-phase'], [{ db_phase: '' }, 'staff', 'v8-phase'],
    ]
    for (const [o, role, id] of bad) {
      const failedIds = evaluateCmsV8({ ...good, ...o }, A, role).filter((c) => !c.ok).map((c) => c.id)
      expect(failedIds, `${role} ${JSON.stringify(o)}`).toContain(id)
    }
  })

  test('V8 phase 122 (PM 03/11 §5): khai đúng phase; 4 RPC đọc gọi được; lộ / chặn sai / lỗi / excluded / tập dòng lệch ⇒ đỏ; results chưa cắt ⇒ CHƯA', () => {
    const g122: Record<string, unknown> = {
      role_now: 'authenticated', uid: A, ro: 'on', iso: 'repeatable read', me_bypass: false, runner_bypass: true, user_role: 'staff', su: false, db_phase: '122',
      qa_db: false, qa: false, same_set: true, readable: 1,
      rls_cms_programs: true, rls_cms_program_stores: true, rls_cms_program_products: true, rls_cms_program_tiers: true,
      rls_cms_import_runs: true, rls_cms_product_master: true,
      seen_programs: 1, exp_programs: 1, total_programs: 3, seen_stores: 1, exp_stores: 1, total_stores: 3,
      seen_products: 1, exp_products: 1, total_products: 3, seen_tiers: 1, exp_tiers: 1, total_tiers: 3,
      seen_import_runs: 0, exp_import_runs: 0, total_import_runs: 1, seen_master: 0, exp_master: 0, total_master: 3,
      test_programs: 0, draft_programs: 0, out_programs: 0, out_stores: 0, out_products: 0, out_tiers: 0, out_import_runs: 0,
      read_qa_access: false, read_sync_runs: false, write_programs: false, private_tables: 0,
      rpc_callable: 'rpc_cms_result_excluded,rpc_cms_result_header,rpc_cms_result_lines,rpc_cms_result_rows',
      rx_leak: 0, rx_deny: 0, rx_err: 0, rx_exc: 0, rx_seen_n: 1, rx_exp_n: 1, rx_total_n: 3, rx_same_set: true,
      rx_role: 'authenticated', rx_outsider: true, rx_outside: 2, rx_exc_calls: 3, rx_lleak: 0,
      rx_lseen_n: 2, rx_lexp_n: 2, rx_ltotal_n: 6, rx_lines_same: true, rx_catalog_same: true, rx_users_same: true,
    }
    const okRun = evaluateCmsV8(g122, A, 'staff', { phase: '122', requireProven: ['results', 'result_lines'] })
    expect(okRun.filter((c) => !c.ok)).toEqual([])
    expect(okRun.find((c) => c.id === 'v8-table:results')).toMatchObject({ ok: true, proven: true })
    expect(evaluateCmsV8({ ...g122, rx_total_n: 1 }, A, 'staff', { phase: '122', requireProven: ['results'] }).filter((c) => !c.ok).map((c) => c.id))
      .toEqual(['v8-require-proven:results'])
    // Chưa gọi excluded / không có chương trình ngoài tập / không có staff ngoài phạm vi ⇒ ĐẠT nhưng CHƯA CHỨNG MINH (không xanh oan).
    const unproven = evaluateCmsV8({ ...g122, rx_exc_calls: 0, rx_outside: 0, rx_outsider: false }, A, 'staff', { phase: '122' })
    expect(unproven.filter((c) => !c.ok)).toEqual([])
    expect(['v8-result-excluded', 'v8-result-rpc', 'v8-result-lines-user'].map((id) => unproven.find((c) => c.id === id)?.proven)).toEqual([false, false, false])
    // Không khai phase trên DB 122 / khai 121 ⇒ đỏ v8-phase (lời rõ); phase 121 cũng đỏ private (RPC 122 gọi được).
    const noPhase = evaluateCmsV8(g122, A, 'staff')
    expect(noPhase.filter((c) => !c.ok).map((c) => c.id)).toEqual(['v8-phase', 'v8-private'])
    expect(noPhase.find((c) => c.id === 'v8-phase')!.detail).toMatch(/PHASE KHÔNG PHÙ HỢP: DB phase 122 — không khai --phase/)
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ rx_leak: 1 }, 'v8-result-rpc'], [{ rx_deny: 1 }, 'v8-result-rpc'], [{ rx_err: 1 }, 'v8-result-rpc'], [{ rx_exc: 1 }, 'v8-result-excluded'],
      [{ rx_same_set: false }, 'v8-table:results'], [{ rx_seen_n: 2 }, 'v8-table:results'],
      [{ rpc_callable: 'rpc_cms_result_header,rpc_cms_result_lines,rpc_cms_result_rows' }, 'v8-private'],
      [{ rpc_callable: 'rpc_cms_result_excluded,rpc_cms_result_header,rpc_cms_result_lines,rpc_cms_result_rows,rpc_cms_sales_run_publish' }, 'v8-private'],
      [{ db_phase: '121' }, 'v8-phase'],
      // db-reviewer r1: lines (P1), vai DO #2, catalog / users (P2).
      [{ rx_role: 'postgres' }, 'v8-result-role'], [{ rx_lleak: 1 }, 'v8-result-lines-user'], [{ rx_lines_same: false }, 'v8-table:result_lines'],
      [{ rx_lseen_n: 3 }, 'v8-table:result_lines'], [{ rx_catalog_same: false }, 'v8-result-shape'], [{ rx_users_same: false }, 'v8-result-shape'],
    ]
    for (const [o, id] of bad) expect(evaluateCmsV8({ ...g122, ...o }, A, 'staff', { phase: '122' }).filter((c) => !c.ok).map((c) => c.id), JSON.stringify(o)).toContain(id)
    // SQL phase 122: khối DO thứ hai chạy SAU SET LOCAL ROLE authenticated; vẫn chỉ câu SELECT cuối trả dòng.
    const v8 = pgMetaReadOnlySnapshot(cmsVerifyV8Sql(A, 'staff', '122'))
    expect(v8.indexOf('SET LOCAL ROLE authenticated;')).toBeLessThan(v8.indexOf('DO $cmsv8r$'))
    expect(v8).toContain('public.rpc_cms_result_header(v_id)')
    expect(v8.split('\n').filter((l) => /^(SELECT|WITH) /.test(l)).map((l) => l.slice(0, 6))).toEqual(['WITH h', 'SELECT'])
    expect(cmsVerifyV8Sql(A, 'staff')).not.toContain('cmsv8r')
    // Phase lạ = 127 (126 sales-only nay là phase V8 hợp lệ — đổi có chủ đích khi mở phase 126, không nới kiểm).
    expect(() => cmsVerifyV8Sql(A, 'staff', '127' as never)).toThrow()
  })

  test('phase 127 (S0 T11 mức cố định / hộp): chỉ dữ liệu — kế thừa 126, marker + bất biến v127-flat / resync / t11-pm', () => {
    // 128 (CMS-UNIT) thêm sau — phần tử áp chót có chủ đích, không nới kiểm 127.
    expect(CMS_VERIFY_PHASES.at(-2)).toBe('127')
    expect(CMS_PHASE_FUNCTIONS['127']).toEqual([])
    expect(Object.entries(CMS_FN_MATRIX).filter(([, m]) => m.phase === '127')).toEqual([])
    expect(cmsPostProvenKeys('127')).toEqual(['v5', 'lock-preview', 'attest', 'uncapped', 'basis', 'resync'])
    expect(CMS_V8_PHASES).not.toContain('127')
    expect(CMS_VERIFY_SQL.markers).toContain("'127'")
    expect(cmsVerifyAclSql()).not.toContain('n_ex127')
    expect(CMS_VERIFY_SQL.inv127Flat).toContain("FROM public.app_migrations WHERE version = '127'")
    expect(CMS_VERIFY_SQL.inv127Flat).toContain('ORDER BY product_id COLLATE "C"')
    expect(CMS_127_T11_ID).toBe('942194ce-893f-4f62-a88a-bd9efa464bae')
    expect(CMS_127_PM_RATES_MD5).toMatch(/^[0-9a-f]{32}$/)
    // Bộ đánh giá: chỉ các mục 127 (input tối thiểu) — chuỗi đầy đủ chạy ở scripts/qa-cms-127.mjs.
    const base = { marker_at: '2026-11-08T10:00:00Z', program_id: CMS_127_T11_ID, rates_md5_marker: CMS_127_PM_RATES_MD5, rates_md5_db: CMS_127_PM_RATES_MD5,
      version_after: 4, products_marker: 17, program_n: 1, products_n: 17, not_flat: 0, config_version: 4, pointer_null: true, pointer_ok: null }
    const ev = (f: Record<string, unknown>) => {
      const cs = evaluateCmsVerify({ phase: '127', whoami: { u: 'x', bypass: true }, markers: [], maxNumeric: { max_v: 127 }, functions: [], policies: [],
        triggers: [], tableShape: [], tables: [], roles: [], oneRunningIndex: [], aclPost: {}, aclPre: {}, inv121: { overlap: [], tiers: [], catalog: [] },
        isolation: {}, p127: { invFlat: f } } as never)
      return Object.fromEntries(cs.filter((c) => c.id.startsWith('v127-')).map((c) => [c.id, c]))
    }
    let c = ev(base)
    expect(c['v127-flat'].ok && c['v127-resync'].ok && c['v127-t11-pm'].ok).toBe(true)
    expect(c['v127-resync'].proven).toBe(false)
    c = ev({ ...base, pointer_null: false, pointer_ok: true })
    expect(c['v127-resync'].ok && c['v127-resync'].proven).toBe(true)
    expect(ev({ ...base, pointer_null: false, pointer_ok: false })['v127-resync'].ok).toBe(false)
    expect(ev({ ...base, not_flat: 1 })['v127-flat'].ok).toBe(false)
    expect(ev({ ...base, rates_md5_db: 'x' })['v127-flat'].ok).toBe(false)
    expect(ev({ ...base, products_n: 16 })['v127-flat'].ok).toBe(false)
    expect(ev({ ...base, config_version: 3 })['v127-flat'].ok).toBe(false)
    // db-reviewer 127 P2-4: version > version sau 127 (chỉnh sửa hợp lệ về sau) ⇒ ĐẠT nhưng CHƯA chứng minh, không đỏ vĩnh viễn.
    c = ev({ ...base, config_version: 5, products_n: 18, not_flat: 1, rates_md5_db: 'x' })
    expect(c['v127-flat'].ok).toBe(true)
    expect(c['v127-flat'].proven).toBe(false)
    expect(ev(base)['v127-flat'].proven).toBe(true)
    expect(ev({ ...base, marker_at: null })['v127-flat'].ok).toBe(false)
    expect(ev({ ...base, program_id: '00000000-0000-4000-8000-000000000001' })['v127-t11-pm'].ok).toBe(false)
    expect(ev({ ...base, rates_md5_marker: 'x', rates_md5_db: 'x' })['v127-t11-pm'].ok).toBe(false)
  })

  test('phase 128 (CMS-UNIT capability, PM-r1): 7 helper chỉ owner + 17 thân thay + shape / cột 2 bảng + 2 trigger ALWAYS + V-128', () => {
    expect(CMS_VERIFY_PHASES.at(-1)).toBe('128')
    const m128 = Object.entries(CMS_FN_MATRIX).filter(([, m]) => m.phase === '128')
    expect(m128.map(([n]) => n).sort()).toEqual(['cms__basis_policy', 'cms__calc_snapshot', 'cms__programs_basis_guard', 'cms__qty_dec',
      'cms__runs_basis_guard', 'cms__unit_key', 'cms__units_invalid'])
    for (const [n, m] of m128) expect({ n, acl: m.acl, secdef: m.secdef, lock: m.lock, lock2: m.lock2, lock3: m.lock3, nestloop: m.nestloop })
      .toEqual({ n, acl: null, secdef: true, lock: false, lock2: undefined, lock3: undefined, nestloop: undefined })
    expect(Object.keys(CMS_FN_MATRIX)).toHaveLength(75)
    // 17 thân thay (r1: + import_commit / activate của 125 cho guard ĐV): đúng danh sách migration 128 §4, khác mọi kỳ vọng phase
    // trước, mọi hàm có từ trước 128.
    expect(Object.keys(CMS_FN_SRC_128).sort()).toEqual(['cms__attest_eval', 'cms__config_fp', 'cms__lock_eval', 'cms__sales_snapshot',
      'rpc_cms_import_commit', 'rpc_cms_program_activate',
      'rpc_cms_program_save', 'rpc_cms_result_header', 'rpc_cms_result_lines', 'rpc_cms_result_rows', 'rpc_cms_run_source_export',
      'rpc_cms_sales_run_finish', 'rpc_cms_sales_run_open', 'rpc_cms_sales_run_publish', 'rpc_cms_sales_run_seal_begin',
      'rpc_cms_sales_run_seal_step', 'rpc_cms_source_attest'])
    for (const [n, src] of Object.entries(CMS_FN_SRC_128)) {
      expect(Number(CMS_FN_MATRIX[n].phase), n).toBeLessThan(128)
      for (const prev of [CMS_FN_MATRIX[n].src, CMS_FN_SRC_123[n], CMS_FN_SRC_124[n], CMS_FN_SRC_125[n], CMS_FN_SRC_126[n]]) expect(src, n).not.toBe(prev)
    }
    expect(Object.keys(CMS_FN_DEF_128).sort()).toEqual(Object.keys(CMS_FN_MATRIX).sort())
    expect(Object.keys(CMS_FN_DEF_128).filter((n) => CMS_FN_DEF_128[n] !== CMS_FN_DEF_125[n]).sort()).toEqual(m128.map(([n]) => n).sort())
    expect(Object.keys(CMS_TABLE_SHAPE_128).filter((t) => JSON.stringify(CMS_TABLE_SHAPE_128[t]) !== JSON.stringify(CMS_TABLE_SHAPE_125[t])).sort())
      .toEqual(['cms_programs', 'cms_sync_runs'])
    for (const t of ['cms_programs', 'cms_sync_runs']) expect(CMS_TABLE_SHAPE_128[t].idx).toBe(CMS_TABLE_SHAPE_125[t].idx)
    expect(Object.keys(CMS_COL_128).filter((t) => CMS_COL_128[t] !== CMS_COL_125[t]).sort()).toEqual(['cms_programs', 'cms_sync_runs'])
    expect(CMS_TRIGGERS_128).toHaveLength(61)
    expect(CMS_TRIGGERS_128.filter((t) => !CMS_TRIGGERS_125.includes(t))).toEqual([
      'CREATE TRIGGER cms_programs_basis_guard BEFORE UPDATE OF quantity_basis ON cms_programs FOR EACH ROW EXECUTE FUNCTION cms__programs_basis_guard()|A',
      'CREATE TRIGGER cms_sync_runs_basis_guard BEFORE INSERT OR UPDATE ON cms_sync_runs FOR EACH ROW EXECUTE FUNCTION cms__runs_basis_guard()|A'])
    expect(cmsPostProvenKeys('128')).toEqual(['v5', 'lock-preview', 'attest', 'uncapped', 'basis', 'resync', 'unit'])
    expect(CMS_V8_PHASES).not.toContain('128')
    expect(CMS_VERIFY_SQL.markers).toContain("'128'")
    expect(cmsVerifyAclSql()).toContain('n_ex128')
    expect(CMS_128_UNIT_KEY_VERSION).toBe(CMS_UNIT_KEY_VERSION)
    expect(CMS_VERIFY_SQL.inv128Basis).toContain(`'${CMS_UNIT_KEY_VERSION}'`)
    // Bộ đánh giá V-128 (input tối thiểu) — chuỗi đầy đủ chạy ở scripts/qa-cms-128.mjs.
    const base = { marker_at: '2026-11-10T10:00:00Z', runs_n: 3, v1_n: 1, legacy_after: 0, snap_bad: 0, ptr_basis_bad: 0, ptr_bad_ids: '',
      unit_programs: 0, unit_published: 0 }
    const ev = (b: Record<string, unknown>) => {
      const cs = evaluateCmsVerify({ phase: '128', whoami: { u: 'x', bypass: true }, markers: [], maxNumeric: { max_v: 128 }, functions: [], policies: [],
        triggers: [], tableShape: [], tables: [], roles: [], oneRunningIndex: [], aclPost: {}, aclPre: {}, inv121: { overlap: [], tiers: [], catalog: [] },
        isolation: {}, p128: { invBasis: b } } as never)
      return Object.fromEntries(cs.filter((c) => c.id.startsWith('v128-')).map((c) => [c.id, c]))
    }
    let c = ev(base)
    expect(c['v128-run-basis'].ok && c['v128-pointer-basis'].ok && c['v128-unit-published'].ok).toBe(true)
    expect(c['v128-run-basis'].proven).toBe(true)
    expect(c['v128-unit-published'].proven).toBe(false)
    expect(ev({ ...base, v1_n: 0 })['v128-run-basis'].proven).toBe(false)
    expect(ev({ ...base, unit_programs: 1, unit_published: 2 })['v128-unit-published'].proven).toBe(true)
    expect(ev({ ...base, legacy_after: 1 })['v128-run-basis'].ok).toBe(false)
    expect(ev({ ...base, snap_bad: 1 })['v128-run-basis'].ok).toBe(false)
    expect(ev({ ...base, ptr_basis_bad: 1, ptr_bad_ids: '00000000-0000-4000-8000-000000000001' })['v128-pointer-basis'].ok).toBe(false)
    c = ev({ ...base, marker_at: null })
    expect(c['v128-run-basis'].ok || c['v128-pointer-basis'].ok || c['v128-unit-published'].ok).toBe(false)
    expect(ev({ ...base, runs_n: undefined })['v128-run-basis'].ok).toBe(false)
    // ACL POST 128 so n_ex128 (trừ 6 helper mới) với n_all PRE; thiếu n_ex128 ⇒ đỏ (không rơi về n_all — POST có thêm 6 hàm).
    const acl = (post: Record<string, unknown>, pre: Record<string, unknown>) => evaluateCmsVerify({ phase: '128', whoami: { u: 'x', bypass: true }, markers: [],
      maxNumeric: { max_v: 128 }, functions: [], policies: [], triggers: [], tableShape: [], tables: [], roles: [], oneRunningIndex: [], aclPost: post, aclPre: pre,
      inv121: { overlap: [], tiers: [], catalog: [] }, isolation: {} } as never).find((x) => x.id === 'acl-preexisting-functions')!
    const md = 'a'.repeat(32), md2 = 'b'.repeat(32)
    expect(acl({ n_all: 80, md5_all: md2, n_ex128: 74, md5_ex128: md }, { n_all: 74, md5_all: md }).ok).toBe(true)
    expect(acl({ n_all: 80, md5_all: md2 }, { n_all: 74, md5_all: md }).ok).toBe(false)
    expect(acl({ n_all: 80, md5_all: md2, n_ex128: 74, md5_ex128: md2 }, { n_all: 74, md5_all: md }).ok).toBe(false)
  })

  test('danh sách hàm theo phase = khoá CMS_FN_MATRIX cùng phase; đếm trước phase suy từ ma trận (db-reviewer P2-5)', () => {
    for (const ph of CMS_VERIFY_PHASES) {
      const fromMatrix = Object.entries(CMS_FN_MATRIX).filter(([, m]) => m.phase === ph).map(([n]) => n)
      // 124: rpc_cms_program_lock ĐỔI CHỮ KÝ ⇒ thuộc tập loại trừ khi so ACL hàm có trước (dù tên có từ 123).
      expect([...CMS_PHASE_FUNCTIONS[ph]].sort(), ph).toEqual([...fromMatrix, ...(ph === '124' ? ['rpc_cms_program_lock'] : [])].sort())
    }
    // 125 (CMS-UNCAPPED-1): trước 125 có đúng 67 hàm cms (55 + 12 của 124). 126 (sales-only): trước 126 có đúng 68 (126 không thêm
    // hàm) — phần tử cuối thêm có chủ đích khi mở phase 126, không phải nới kỳ vọng cũ.
    // 127 (S0 T11, PM 08/11): chỉ dữ liệu ⇒ trước 127 vẫn đúng 68 hàm.
    // 128 (CMS-UNIT): trước 128 vẫn đúng 68 hàm (127 chỉ dữ liệu).
    expect(CMS_VERIFY_PHASES.map((ph) => cmsFnCountBefore(ph))).toEqual([0, 7, 14, 37, 55, 67, 68, 68, 68])
    // 122: khoá định nghĩa = đúng các hàm có tới 122 (phase 123 thêm hàm ⇒ lọc theo phase; độ chặt cho 122 giữ nguyên).
    expect(Object.keys(CMS_FN_DEF_122).sort()).toEqual(Object.entries(CMS_FN_MATRIX).filter(([, m]) => Number(m.phase) <= 122).map(([n]) => n).sort())
    expect(Object.keys(CMS_COL_122).sort()).toEqual(Object.keys(CMS_TABLE_SHAPE_122).sort())
    // 123: 18 hàm mới (15 helper không cấp ai — 3 INVOKER; 2 service_role; 1 authenticated), tổng 55; 2 bảng mới; 46 trigger ALWAYS.
    expect(Object.keys(CMS_FN_DEF_123).sort()).toEqual(Object.entries(CMS_FN_MATRIX).filter(([, m]) => Number(m.phase) <= 123).map(([n]) => n).sort())
    // 124 (COMP-INT): 12 hàm mới (8 helper không cấp ai, 4 RPC authenticated — attest / revoke lock_timeout 2 s), tổng 67; 2 bảng mới;
    // 9 trigger ALWAYS; 6 thân thay (run_open / stage / cleanup / lock_eval / payout / lock 6 tham số); lock 3 s → 2 s.
    expect(Object.keys(CMS_FN_DEF_124).sort()).toEqual(Object.entries(CMS_FN_MATRIX).filter(([, m]) => Number(m.phase) <= 124).map(([n]) => n).sort())
    expect(Object.entries(CMS_FN_MATRIX).filter(([, m]) => Number(m.phase) <= 124)).toHaveLength(67)
    // 125 (CMS-UNCAPPED-1): 1 hàm mới (guard, không cấp ai, SECDEF) + 2 thân 121 thay (giữ ACL / lock 5 s); tổng 68; +1 constraint trigger
    // ALWAYS; shape đổi đúng cms_program_tiers (ràng buộc của constraint trigger); cột không đổi.
    expect(Object.keys(CMS_FN_DEF_125).sort()).toEqual(Object.entries(CMS_FN_MATRIX).filter(([, m]) => Number(m.phase) <= 125).map(([n]) => n).sort())
    expect(Object.entries(CMS_FN_MATRIX).filter(([, m]) => Number(m.phase) <= 127)).toHaveLength(68)
    expect(Object.entries(CMS_FN_MATRIX).filter(([, m]) => m.phase === '125')).toEqual([['cms__tiers_last_open_guard', { phase: '125', acl: null, secdef: true, lock: false, src: 'd83088c260633f520dac35cfe8169475' }]])
    expect(Object.keys(CMS_FN_SRC_125).sort()).toEqual(['rpc_cms_import_commit', 'rpc_cms_program_activate'])
    for (const [n, src] of Object.entries(CMS_FN_SRC_125)) expect(src, n).not.toBe(CMS_FN_MATRIX[n].src)
    expect(CMS_TRIGGERS_125).toHaveLength(59)
    expect(CMS_TRIGGERS_125.filter((t) => !CMS_TRIGGERS_124.includes(t))).toEqual(['CREATE CONSTRAINT TRIGGER cms_tiers_last_open AFTER INSERT OR DELETE OR UPDATE ON cms_program_tiers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cms__tiers_last_open_guard()|A'])
    expect(Object.keys(CMS_TABLE_SHAPE_125).filter((t) => JSON.stringify(CMS_TABLE_SHAPE_125[t]) !== JSON.stringify(CMS_TABLE_SHAPE_124[t]))).toEqual(['cms_program_tiers'])
    expect(CMS_TABLE_SHAPE_125.cms_program_tiers.idx).toBe(CMS_TABLE_SHAPE_124.cms_program_tiers.idx)
    expect(CMS_COL_125).toEqual(CMS_COL_124)
    expect(cmsPostProvenKeys('125')).toEqual(['v5', 'lock-preview', 'attest', 'uncapped'])
    expect(CMS_V8_RPC_CALLABLE['125']).toBe(CMS_V8_RPC_CALLABLE['124'])
    expect(CMS_VERIFY_SQL.markers).toContain("'125'")
    expect(cmsVerifyAclSql()).toContain('n_ex125')
    // 126 (sales-only, PM 06/11): 0 hàm mới (POST so TOÀN BỘ hàm với PRE ⇒ không có cột n_ex126 / NOT IN ()); chỉ thân 2 hàm 122 đổi
    // (CMS_FN_SRC_126 = generator scripts/gen-cms-verify-fp-126.mjs); định nghĩa / shape / cột / trigger kế thừa 125.
    expect(CMS_VERIFY_PHASES.at(-3)).toBe('126')
    expect(CMS_PHASE_FUNCTIONS['126']).toEqual([])
    expect(Object.entries(CMS_FN_MATRIX).filter(([, m]) => m.phase === '126')).toEqual([])
    expect(CMS_FN_SRC_126).toEqual({ cms__results_release_open: 'aebe1ff46ba51dcf533fe328af7ea2a0', rpc_cms_sales_run_publish: 'db2c97efad2bb5ee9d69399b99c7c258' })
    expect(CMS_FN_MATRIX.cms__results_release_open).toMatchObject({ phase: '122', acl: null, secdef: true, lock: false, src: 'd6b7f93f75ed7daafd9977463a3d0a3b' })
    expect(CMS_FN_MATRIX.rpc_cms_sales_run_publish).toMatchObject({ phase: '122', acl: 'service_role:EXECUTE', secdef: true, lock: true, src: 'a12d10f071ac6ef93d6a35f9fa623c12' })
    for (const n of Object.keys(CMS_FN_SRC_126)) expect(CMS_FN_SRC_124[n] ?? CMS_FN_SRC_125[n] ?? CMS_FN_SRC_123[n], n).toBeUndefined()
    expect(cmsPostProvenKeys('126')).toEqual(['v5', 'lock-preview', 'attest', 'uncapped', 'basis'])
    expect(CMS_V8_RPC_CALLABLE['126']).toBe(CMS_V8_RPC_CALLABLE['125'])
    expect(cmsV8ProvenKeys('126')).toEqual(cmsV8ProvenKeys('125'))
    expect(CMS_VERIFY_SQL.markers).toContain("'126'")
    expect(cmsVerifyAclSql()).not.toContain('n_ex126')
    expect(cmsVerifyAclSql()).not.toContain('NOT IN ()')
    expect(CMS_VERIFY_SQL.inv126RealBasis).toContain("r.kind = 'sales' AND NOT r.is_test AND r.published_at > m.applied_at")
    expect(CMS_VERIFY_SQL.inv126RealBasis).toContain("IS DISTINCT FROM 'sales_only_v1'")
    expect(Object.keys(CMS_COL_124).sort()).toEqual(Object.keys(CMS_TABLE_SHAPE_124).sort())
    expect(Object.keys(CMS_TABLE_SHAPE_124).filter((t) => !(t in CMS_TABLE_SHAPE_123)).sort()).toEqual(['cms_sales_source_lines', 'cms_source_attestations'])
    const p124 = Object.entries(CMS_FN_MATRIX).filter(([, m]) => m.phase === '124')
    expect(p124).toHaveLength(12)
    expect(p124.filter(([, m]) => m.acl === 'authenticated:EXECUTE').map(([n]) => n).sort()).toEqual(['rpc_cms_run_source_export', 'rpc_cms_source_attest', 'rpc_cms_source_attest_revoke', 'rpc_cms_source_attestations'])
    expect(p124.filter(([, m]) => m.lock2).map(([n]) => n).sort()).toEqual(['rpc_cms_source_attest', 'rpc_cms_source_attest_revoke'])
    expect(Object.keys(CMS_FN_SRC_124).sort()).toEqual(['cms__lock_eval', 'rpc_cms_payout', 'rpc_cms_program_lock', 'rpc_cms_sales_run_cleanup', 'rpc_cms_sales_run_open', 'rpc_cms_sales_run_stage'])
    for (const [n, src] of Object.entries(CMS_FN_SRC_124)) expect(src, n).not.toBe(CMS_FN_MATRIX[n].src)
    expect(CMS_FN_CFG_124).toEqual({ rpc_cms_program_lock: { lock3: false, lock2: true } })
    expect(CMS_TRIGGERS_124).toHaveLength(58)
    expect(CMS_TRIGGERS_124.filter((t) => t.endsWith('|A'))).toHaveLength(55)
    expect(new Set(CMS_TRIGGERS_124).size).toBe(58)
    expect(Object.entries(CMS_FN_MATRIX).filter(([, m]) => Number(m.phase) <= 123)).toHaveLength(55)
    expect(Object.keys(CMS_COL_123).sort()).toEqual(Object.keys(CMS_TABLE_SHAPE_123).sort())
    expect(Object.keys(CMS_TABLE_SHAPE_123).filter((t) => !(t in CMS_TABLE_SHAPE_122)).sort()).toEqual(['cms_payout_staff', 'cms_payouts'])
    for (const [n, def] of Object.entries(CMS_FN_DEF_122)) expect(CMS_FN_DEF_123[n], n).toBe(def)
    for (const [t, sh] of Object.entries(CMS_TABLE_SHAPE_122)) expect(CMS_TABLE_SHAPE_123[t], t).toEqual(sh)
    const p123 = Object.entries(CMS_FN_MATRIX).filter(([, m]) => m.phase === '123')
    expect(p123).toHaveLength(18)
    expect(p123.filter(([, m]) => !m.secdef).map(([n]) => n).sort()).toEqual(['cms__config_auth_guard', 'cms__payout_insert_guard', 'cms__run_auth_guard'])
    expect(p123.filter(([, m]) => m.acl === 'service_role:EXECUTE').map(([n]) => n).sort()).toEqual(['rpc_cms_lock_preview', 'rpc_cms_program_lock'])
    expect(p123.filter(([, m]) => m.acl === 'authenticated:EXECUTE').map(([n]) => n)).toEqual(['rpc_cms_payout'])
    expect(p123.filter(([n, m]) => n.startsWith('cms__') && m.acl === null)).toHaveLength(15)
    expect(p123.filter(([, m]) => m.lock || m.nestloop)).toHaveLength(0)
    expect(p123.filter(([, m]) => m.lock3).map(([n]) => n)).toEqual(['rpc_cms_program_lock'])
    // Thân thay ở 123 chỉ áp từ 123; kỳ vọng 120–122 của hàm đó giữ nguyên.
    expect(Object.keys(CMS_FN_SRC_123)).toEqual(['cms_readable_program_ids'])
    expect(CMS_FN_MATRIX.cms_readable_program_ids).toMatchObject({ phase: '120', src: '7043f93b323dbd2fc4c1f883181201d7' })
    expect(CMS_FN_SRC_123.cms_readable_program_ids).not.toBe(CMS_FN_MATRIX.cms_readable_program_ids.src)
    expect(CMS_TRIGGERS_123).toHaveLength(49)
    expect(CMS_TRIGGERS_123.filter((t) => t.endsWith('|A'))).toHaveLength(46)
    expect(CMS_TRIGGERS_123.filter((t) => t.endsWith('|O'))).toHaveLength(3)
    expect(new Set(CMS_TRIGGERS_123).size).toBe(49)
    expect(CMS_TRIGGERS_123.filter((t) => / REFERENCING .* FOR EACH STATEMENT /.test(t))).toHaveLength(15)
    expect(CMS_TRIGGERS_123.filter((t) => / BEFORE TRUNCATE ON /.test(t)).map((t) => / ON (\w+) /.exec(t)![1]).sort()).toEqual([...CMS_TABLES_FROZEN_123].sort())
    expect(cmsVerifyAclSql()).toMatch(/AS n_ex123,[\s\S]*AS md5_ex123/)
    // db-reviewer 123 P2: post --require-proven chỉ có ở 123; SQL mới đọc đúng khoá seal_expect của 122, quyền gián tiếp, V8 migration.
    expect(cmsPostProvenKeys('123')).toEqual(['v5', 'lock-preview'])
    expect((['120', '121', '122'] as const).map((p) => cmsPostProvenKeys(p).length)).toEqual([0, 0, 0])
    expect(CMS_VERIFY_SQL.invRunFrozen).toMatch(/seal_expect ->> 'sales_lines'[\s\S]*seal_expect ->> 'results'[\s\S]*seal_expect ->> 'catalog'[\s\S]*seal_expect ->> 'result_lines'/)
    expect(CMS_VERIFY_SQL.invPayoutStaff).toContain('FULL JOIN')
    expect(CMS_VERIFY_SQL.payoutReach).toContain("has_any_column_privilege(ro.n, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')")
    expect(CMS_VERIFY_SQL.payoutReach).toContain('pg_rewrite')
    expect(CMS_VERIFY_SQL.lockPreview).toContain("ARRAY['CMS_LOCK_RELEASE_GATE', 'CMS_LOCK_POLICY_PENDING']")
    for (const k of ['invPayoutStaff', 'invRunFrozen', 'payoutReach', 'lockPreview'] as const) {
      expect(CMS_VERIFY_SQL[k], k).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|GRANT|CREATE)\b(?! *,)|email|full_name|name_snapshot/)
    }
  })

  test('V8 phase 123 (Q-208 / Q-217): rpc_cms_payout gọi được; lộ / chặn sai / lỗi / email / tổng / tập dòng lệch ⇒ đỏ; chưa có payout ⇒ CHƯA; khoá JSON theo danh sách cho phép của vai; CLI v8 --phase=123', () => {
    const g123: Record<string, unknown> = {
      role_now: 'authenticated', uid: A, ro: 'on', iso: 'repeatable read', me_bypass: false, runner_bypass: true, user_role: 'store_manager', su: false, db_phase: '123',
      qa_db: false, qa: false, same_set: true, readable: 1,
      rls_cms_programs: true, rls_cms_program_stores: true, rls_cms_program_products: true, rls_cms_program_tiers: true,
      rls_cms_import_runs: true, rls_cms_product_master: true,
      seen_programs: 1, exp_programs: 1, total_programs: 3, seen_stores: 1, exp_stores: 1, total_stores: 3,
      seen_products: 1, exp_products: 1, total_products: 3, seen_tiers: 1, exp_tiers: 1, total_tiers: 3,
      seen_import_runs: 0, exp_import_runs: 0, total_import_runs: 1, seen_master: 0, exp_master: 0, total_master: 3,
      test_programs: 0, draft_programs: 0, out_programs: 0, out_stores: 0, out_products: 0, out_tiers: 0, out_import_runs: 0,
      read_qa_access: false, read_sync_runs: false, write_programs: false, private_tables: 0,
      rpc_callable: 'rpc_cms_payout,rpc_cms_result_excluded,rpc_cms_result_header,rpc_cms_result_lines,rpc_cms_result_rows',
      rx_leak: 0, rx_deny: 0, rx_err: 0, rx_exc: 0, rx_seen_n: 2, rx_exp_n: 2, rx_total_n: 3, rx_same_set: true,
      rx_role: 'authenticated', rx_outsider: true, rx_outside: 2, rx_exc_calls: 3, rx_lleak: 0,
      rx_lseen_n: 4, rx_lexp_n: 4, rx_ltotal_n: 6, rx_lines_same: true, rx_catalog_same: true, rx_users_same: true,
      py_role: 'authenticated', py_leak: 0, py_deny: 0, py_err: 0, py_nolock: 0, py_calls: 1, py_field: 0, py_prog_n: 1,
      py_seen_n: 2, py_exp_n: 2, py_total_n: 3, py_same_set: true, py_totals_same: true,
    }
    const okRun = evaluateCmsV8(g123, A, 'qlch', { phase: '123', requireProven: ['payout', 'results'] })
    expect(okRun.filter((c) => !c.ok)).toEqual([])
    expect(['v8-table:payout', 'v8-payout-rpc', 'v8-payout-fields'].map((id) => okRun.find((c) => c.id === id)?.proven)).toEqual([true, true, true])
    // Chưa có payout / chưa đọc được payout nào ⇒ ĐẠT nhưng CHƯA CHỨNG MINH; --require-proven=payout ⇒ đỏ.
    const empty = { ...g123, py_calls: 0, py_prog_n: 0, py_seen_n: 0, py_exp_n: 0, py_total_n: 0 }
    const un = evaluateCmsV8(empty, A, 'qlch', { phase: '123' })
    expect(un.filter((c) => !c.ok)).toEqual([])
    expect(['v8-table:payout', 'v8-payout-fields'].map((id) => un.find((c) => c.id === id)?.proven)).toEqual([false, false])
    expect(evaluateCmsV8(empty, A, 'qlch', { phase: '123', requireProven: ['payout'] }).filter((c) => !c.ok).map((c) => c.id)).toEqual(['v8-require-proven:payout'])
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ py_leak: 1 }, 'v8-payout-rpc'], [{ py_deny: 1 }, 'v8-payout-rpc'], [{ py_err: 1 }, 'v8-payout-rpc'], [{ py_role: 'postgres' }, 'v8-payout-role'],
      [{ py_same_set: false }, 'v8-table:payout'], [{ py_seen_n: 3 }, 'v8-table:payout'],
      [{ py_totals_same: false }, 'v8-payout-fields'], [{ py_field: 1 }, 'v8-payout-fields'],
      [{ rpc_callable: CMS_V8_RPC_CALLABLE['122'] }, 'v8-private'], [{ db_phase: '122' }, 'v8-phase'],
      [{ rx_same_set: false }, 'v8-table:results'], [{ rx_lleak: 1 }, 'v8-result-lines-user'],
    ]
    for (const [o, id] of bad) expect(evaluateCmsV8({ ...g123, ...o }, A, 'qlch', { phase: '123' }).filter((c) => !c.ok).map((c) => c.id), JSON.stringify(o)).toContain(id)
    // Khai phase 122 trên DB 123 ⇒ đỏ v8-phase (lời rõ) + v8-private (rpc_cms_payout gọi được).
    const as122 = evaluateCmsV8(g123, A, 'qlch', { phase: '122' })
    expect(as122.filter((c) => !c.ok).map((c) => c.id)).toEqual(['v8-phase', 'v8-private'])
    expect(as122.find((c) => c.id === 'v8-phase')!.detail).toMatch(/PHASE KHÔNG PHÙ HỢP: DB phase 123 — khai báo --phase=122/)
    // SQL 123: khối rpc_cms_payout chạy SAU SET LOCAL ROLE authenticated và sau khối 122; oracle SM gồm 'locked'; chỉ câu SELECT cuối trả dòng.
    const v8 = pgMetaReadOnlySnapshot(cmsVerifyV8Sql123(A, 'sm'))
    expect(v8.indexOf('SET LOCAL ROLE authenticated;')).toBeLessThan(v8.indexOf('DO $cmsv8r$'))
    expect(v8.indexOf('DO $cmsv8r$')).toBeLessThan(v8.indexOf('DO $cmsv8p$'))
    expect(v8).toContain('public.rpc_cms_payout(v_id)')
    expect(v8).toContain("WHERE (NOT p.is_test OR v_qa) AND p.status IN ('active', 'locked')\n       AND EXISTS (SELECT 1 FROM public.cms_program_stores ps\n                     JOIN public.sm_store_assignments")
    expect(v8.split('\n').filter((l) => /^(SELECT|WITH) /.test(l)).map((l) => l.slice(0, 6))).toEqual(['WITH h', 'SELECT'])
    const v8p122 = cmsVerifyV8Sql(A, 'sm', '122')
    expect(v8p122).not.toContain('cmsv8p')
    expect(v8p122).toContain("WHERE (NOT p.is_test OR v_qa) AND p.status = 'active'\n       AND EXISTS (SELECT 1 FROM public.cms_program_stores ps\n                     JOIN public.sm_store_assignments")
    expect(cmsV8ProvenKeys('123')).toContain('payout')
    expect(cmsV8ProvenKeys('122')).not.toContain('payout')
    const qsql = cmsVerifyV8Sql123(A, 'qlch'), ssql = cmsVerifyV8Sql123(A, 'super')
    const arr = (sql: string, v: string) => new RegExp(`${v} text\\[\\] := ([^;]*);`).exec(sql)![1]
    expect(qsql).toContain('v_sdecl boolean := false')
    expect(ssql).toContain('v_sdecl boolean := true')
    for (const k of CMS_PAYOUT_KEYS_TOP) { expect(arr(qsql, 'v_top_ok')).toContain(`'${k}'`); expect(arr(ssql, 'v_top_ok')).toContain(`'${k}'`) }
    for (const k of CMS_PAYOUT_KEYS_TOP_SUPER) { expect(arr(qsql, 'v_top_ok')).not.toContain(`'${k}'`); expect(arr(ssql, 'v_top_ok')).toContain(`'${k}'`) }
    for (const k of CMS_PAYOUT_KEYS_ROW) { expect(arr(qsql, 'v_row_ok')).toContain(`'${k}'`); expect(arr(ssql, 'v_row_ok')).toContain(`'${k}'`) }
    expect(arr(qsql, 'v_row_ok')).not.toContain("'email'")
    expect(arr(ssql, 'v_row_ok')).toContain("'email'")
    expect(qsql).not.toContain("v_p ? 'locked_by'")
    expect(qsql).toContain("has_any_column_privilege(c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')")
    expect(cmsVerifyV8Sql(A, 'qlch', '122')).not.toContain('has_any_column_privilege')
    // P3a: CLI nhận v8 --phase=123; 124 (COMP-INT) nhận --phase=124; 125 (CMS-UNCAPPED-1) nhận --phase=125; 126 (sales-only) nhận
    // --phase=126 (harness qa-cms-cli-exit.mjs §2b đổi "phase lạ" từ 126 sang 127 — 126 nay hợp lệ).
    expect(CMS_V8_PHASES).toEqual(['120', '121', '122', '123', '124', '125', '126'])
  })

  test('đóng run có cảnh báo: chỉ đóng khi xác nhận ĐÚNG tập chương trình bị cảnh báo', () => {
    expect(cmsQaAckWarnings([], undefined)).toEqual({ ok: true, reason: null, acked: [] })
    expect(cmsQaAckWarnings([], '11111111').ok).toBe(false)
    expect(cmsQaAckWarnings([P1, P2], undefined).ok).toBe(false)
    expect(cmsQaAckWarnings([P1, P2], '33333333').ok).toBe(false)
    expect(cmsQaAckWarnings([P1, P2], '33333333,44444444,55555555').ok).toBe(false)
    expect(cmsQaAckWarnings([P1, P2], ' 44444444 , 33333333 ')).toEqual({ ok: true, reason: null, acked: ['33333333…', '44444444…'] })
  })
})

test.describe('CMS QA tooling · launcher r2: cây Git gồm file chưa track (PM P1-1) @desktop', () => {
  test('repo Git tạm NGOÀI project: sạch qua; sửa tracked / source chưa track chặn; artifact ignore không làm đỏ', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-qa-tree-'))
    const g = (...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: dir, encoding: 'utf8' })
    try {
      g('init', '-q')
      fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1\n')
      fs.writeFileSync(path.join(dir, '.gitignore'), '*.log\n/.next/\n')
      g('add', 'a.ts', '.gitignore')
      g('-c', 'user.name=qa', '-c', 'user.email=qa@example.invalid', 'commit', '-q', '-m', 'init')
      const state = () => cmsQaTreeState(g(...CMS_QA_GIT_STATUS_ARGS))
      expect(state()).toEqual({ clean: true, entries: [] })
      fs.writeFileSync(path.join(dir, 'build.log'), 'x\n')
      fs.mkdirSync(path.join(dir, '.next'))
      fs.writeFileSync(path.join(dir, '.next', 'BUILD_ID'), 'b\n')
      expect(state().clean).toBe(true) // artifact đã ignore
      fs.writeFileSync(path.join(dir, 'unreviewed-source.ts'), 'export const evil = 1\n')
      expect(g('status', '--porcelain', '--untracked-files=no')).toBe('') // tham số cũ BỎ SÓT file chưa track (lỗi PM tái hiện)
      const s1 = state()
      expect(s1.clean).toBe(false)
      expect(s1.entries).toEqual(['?? unreviewed-source.ts'])
      fs.rmSync(path.join(dir, 'unreviewed-source.ts'))
      fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 2\n')
      expect(state()).toMatchObject({ clean: false, entries: [' M a.ts'] })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('launcher dùng đúng tham số chung và kiểm cây TRƯỚC mọi IO tới DB / manifest / server', () => {
    const src = fs.readFileSync(path.join(WEBAPP, 'scripts', 'cms-qa-run.mjs'), 'utf8')
    const start = src.indexOf('// ── start ──')
    const treeAt = src.indexOf('T.cmsQaTreeState(git(...T.CMS_QA_GIT_STATUS_ARGS))', start)
    expect(start).toBeGreaterThan(0)
    expect(treeAt).toBeGreaterThan(start)
    for (const later of ['await pgMeta(env, statusSql)', "fs.writeFileSync(MARKER, json(manifest), { flag: 'wx' })", "spawn(process.execPath, ['server.js']"]) {
      expect(src.indexOf(later, start), later).toBeGreaterThan(treeAt)
    }
    expect(src).not.toContain("'--untracked-files=no'")
    expect(CMS_QA_GIT_STATUS_ARGS).toEqual(['status', '--porcelain', '--untracked-files=all'])
  })
})

// Đồng hồ / timer giả cho vòng canh (PM P1-2: test phải đi qua logic điều phối timer / request treo, không chỉ verdict).
function fakeClock() {
  let now = 0
  let seq = 0
  const timers: { id: number; fn: () => void; ms: number; next: number }[] = []
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
  return {
    now: () => now,
    setInterval: (fn: () => void, ms: number) => { const id = ++seq; timers.push({ id, fn, ms, next: now + ms }); return id },
    clearInterval: (h: unknown) => { const i = timers.findIndex((t) => t.id === h); if (i >= 0) timers.splice(i, 1) },
    timers,
    async advanceTo(target: number) {
      for (;;) {
        const due = timers.filter((t) => t.next <= target).sort((a, b) => a.next - b.next || a.id - b.id)[0]
        if (!due) break
        now = due.next
        due.next += due.ms
        due.fn()
        await flush()
      }
      now = target
      await flush()
    },
  }
}
const statusRow = (remaining: number): CmsQaStatusRow => row({ remaining_s: remaining, active: remaining > 0 })

test.describe('CMS QA tooling · launcher r2: sàn guard + hạn dừng độc lập (PM P1-2) @desktop', () => {
  const GUARD = 10
  const GUARD_MS = GUARD * 60_000

  test('guard: sàn 10 phút; mặc định 10; số không hợp lệ bị từ chối', () => {
    expect(CMS_QA_GUARD_MINUTES_MIN).toBe(10)
    expect(parseCmsQaGuardMinutes(undefined)).toEqual({ ok: true, value: 10 })
    expect(parseCmsQaGuardMinutes('10')).toEqual({ ok: true, value: 10 })
    expect(parseCmsQaGuardMinutes('30')).toEqual({ ok: true, value: 30 })
    for (const bad of ['1', '9', '0', 'abc', '1.5']) expect(parseCmsQaGuardMinutes(bad).ok, bad).toBe(false)
  })

  test('kịch bản PM: đọc tốt ở t=60 s còn 661 s, lượt sau TREO mãi ⇒ dừng theo hạn độc lập, trước hạn marker ≥ guard', async () => {
    const c = fakeClock()
    const wd = createCmsQaWatchdog({ userIds: [A], guardMinutes: GUARD })
    wd.onResult([statusRow(3600)], 0) // preflight
    let calls = 0
    const poll = () => {
      calls += 1
      return calls === 1 ? Promise.resolve([statusRow(661)]) : new Promise<CmsQaStatusRow[]>(() => {}) // treo
    }
    let stoppedAt: number | null = null
    let reason = ''
    startCmsQaWatchdogLoop({ watchdog: wd, poll, now: c.now, setInterval: c.setInterval, clearInterval: c.clearInterval, onStop: (r) => { stoppedAt = c.now(); reason = r } })
    await c.advanceTo(30 * 60_000)
    const expiry = 60_000 + 661_000 // hạn marker theo lần đọc ở t=60 s (DB đo SAU lúc bắt đầu ⇒ hạn thật ≥ mốc này)
    expect(stoppedAt).not.toBeNull()
    expect(stoppedAt!).toBeLessThanOrEqual(expiry - GUARD_MS + CMS_QA_TICK_MS)
    expect(reason).toContain('tới hạn dừng an toàn')
    expect(calls).toBe(2) // request treo ⇒ không chồng request mới
    expect(c.timers).toHaveLength(0) // đã huỷ cả hai timer
  })

  test('mất DB (mọi lượt đọc lỗi): dừng sau 3 lỗi liên tiếp, sớm hơn hạn marker nhiều', async () => {
    const c = fakeClock()
    const wd = createCmsQaWatchdog({ userIds: [A], guardMinutes: GUARD })
    wd.onResult([statusRow(3600)], 0)
    let stoppedAt: number | null = null
    let reason = ''
    startCmsQaWatchdogLoop({ watchdog: wd, poll: () => Promise.reject(new Error('timeout')), now: c.now, setInterval: c.setInterval,
      clearInterval: c.clearInterval, onStop: (r) => { stoppedAt = c.now(); reason = r } })
    await c.advanceTo(10 * 60_000)
    expect(stoppedAt).toBe(3 * CMS_QA_POLL_MS)
    expect(reason).toContain('3 lần liên tiếp')
  })

  test('marker cạn dần (đọc đều): dừng trước hạn ≥ guard; preflight chưa có ⇒ dừng ngay (fail-closed)', async () => {
    const c = fakeClock()
    const wd = createCmsQaWatchdog({ userIds: [A], guardMinutes: GUARD })
    const expiry = 3600_000
    wd.onResult([statusRow(3600)], 0)
    let stoppedAt: number | null = null
    startCmsQaWatchdogLoop({ watchdog: wd, poll: () => Promise.resolve([statusRow(Math.floor((expiry - c.now()) / 1000))]),
      now: c.now, setInterval: c.setInterval, clearInterval: c.clearInterval, onStop: () => { stoppedAt = c.now() } })
    await c.advanceTo(expiry)
    expect(stoppedAt).not.toBeNull()
    expect(stoppedAt!).toBeLessThanOrEqual(expiry - GUARD_MS + CMS_QA_TICK_MS)
    const fresh = createCmsQaWatchdog({ userIds: [A], guardMinutes: GUARD })
    expect(fresh.tick(0)).toMatchObject({ stop: true })
  })

  test('quyết định dừng một chiều; mất marker giữa chừng ⇒ dừng ngay ở lượt đọc', () => {
    const wd = createCmsQaWatchdog({ userIds: [A, B], guardMinutes: GUARD })
    expect(wd.onResult([statusRow(3600), row({ user_id: B, remaining_s: 3000 })], 0).stop).toBe(false)
    expect(wd.stopAt).toBe(3000_000 - GUARD_MS)
    expect(wd.begin()).toBe(true)
    expect(wd.begin()).toBe(false) // đang chờ ⇒ bỏ lượt
    const v = wd.onResult([statusRow(3600), row({ user_id: B, active: false, remaining_s: 0 })], 60_000)
    expect(v.stop).toBe(true)
    expect(wd.onResult([statusRow(3600), row({ user_id: B, remaining_s: 3000 })], 120_000).stop).toBe(true) // không "hồi sinh"
    expect(wd.begin()).toBe(false)
  })
})

test.describe('CMS QA tooling · CLI âm (thoát 2 trước mọi IO) @desktop', () => {
  const run = (script: string, args: string[], extra: Record<string, string> = {}) => {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('E2E_CMS') && k !== 'E2E_EXPECTED_SUPABASE_HOST') env[k] = v
    Object.assign(env, { NEXT_PUBLIC_SUPABASE_URL: 'https://cms-qa-test.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test-only' }, extra)
    const r = spawnSync(process.execPath, [path.join(WEBAPP, 'scripts', script), ...args], { cwd: WEBAPP, env: env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 60_000 })
    return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout }
  }

  test('cms-qa-access: email / TTL / confirm thiếu hoặc sai host / tham số lạ ⇒ 2', () => {
    const cases: Array<[string[], RegExp]> = [
      [['grant', '--users=qa@example.test', '--ttl-hours=2'], /không nhận email/],
      [['grant', `--users=${A}`, '--ttl-hours=200'], /1…168/],
      [['grant', `--users=${A}`, '--ttl-hours=2', '--confirm'], /--expect-host=cms-qa-test\.invalid/],
      [['revoke', `--users=${A}`, '--confirm', '--expect-host=other.invalid'], /--expect-host=cms-qa-test\.invalid/],
      [['status', `--users=${A}`, '--confirm'], /không có chế độ ghi/],
      [['revoke', `--users=${A}`, '--ttl-hours=2'], /chỉ dùng với grant/],
      [['grant', `--users=${A}`, '--ttl-hours=2', '--sql=DROP'], /dùng:/],
      [['delete', `--users=${A}`], /dùng:/],
      [['revoke', `--users=${A}`, '--allow-admin'], /chỉ dùng với grant/],
    ]
    for (const [args, re] of cases) {
      const r = run('cms-qa-access.mjs', args)
      expect(r.code, args.join(' ') + '\n' + r.out).toBe(2)
      expect(r.out).toMatch(re)
      expect(r.out).not.toContain('test-only')
    }
  })

  test('cms-qa-run: thiếu opt-in / sai host / không có run để đóng ⇒ 2', () => {
    let r = run('cms-qa-run.mjs', ['start', `--users=${A}`])
    expect(r.code, r.out).toBe(2)
    expect(r.out).toContain('E2E_CMS_WRITE_QA=YES')
    r = run('cms-qa-run.mjs', ['start', `--users=${A}`], { E2E_CMS_WRITE_QA: 'YES', E2E_EXPECTED_SUPABASE_HOST: 'other.invalid' })
    expect(r.code, r.out).toBe(2)
    expect(r.out).toContain('E2E_EXPECTED_SUPABASE_HOST')
    r = run('cms-qa-run.mjs', ['start', `--users=${A}`, '--min-ttl-minutes=10', '--guard-minutes=10'],
      { E2E_CMS_WRITE_QA: 'YES', E2E_EXPECTED_SUPABASE_HOST: 'cms-qa-test.invalid' })
    expect(r.code, r.out).toBe(2)
    expect(r.out).toContain('lớn hơn --guard-minutes')
    // PM P1-2: cấu hình 2 / 1 phút bị từ chối trước IO (sàn guard 10 phút).
    r = run('cms-qa-run.mjs', ['start', `--users=${A}`, '--min-ttl-minutes=2', '--guard-minutes=1'],
      { E2E_CMS_WRITE_QA: 'YES', E2E_EXPECTED_SUPABASE_HOST: 'cms-qa-test.invalid' })
    expect(r.code, r.out).toBe(2)
    expect(r.out).toContain('--guard-minutes tối thiểu 10')
    r = run('cms-qa-run.mjs', ['close'], { E2E_EXPECTED_SUPABASE_HOST: 'cms-qa-test.invalid' })
    expect(r.code, r.out).toBe(2)
    expect(r.out).toContain('không có run')
    r = run('cms-qa-run.mjs', ['start', `--users=${A}`, '--ack-warnings=11111111'])
    expect(r.code, r.out).toBe(2)
    expect(r.out).toContain('chỉ dùng với close')
  })

  test('run đang mở: close từ chối khi cổng server còn mở; revoke --confirm từ chối user trong run; start bị gate chặn', async () => {
    const marker = path.join(WEBAPP, CMS_QA_MARKER)
    expect(fs.existsSync(marker), `đang có ${CMS_QA_MARKER} thật — đóng run trước khi chạy spec này`).toBe(false)
    const server = net.createServer().listen(0, 'localhost')
    await once(server, 'listening')
    const port = (server.address() as net.AddressInfo).port
    try {
      const m = newCmsQaManifest({
        runId: 'cms-qa-spec', mode: 'manual-localhost', host: 'cms-qa-test.invalid', dbNow: '2026-11-02T02:00:00Z',
        gitHead: 'a'.repeat(40), gitTree: 'b'.repeat(40), buildId: 'B1', port,
        users: [{ id: A, role: 'admin', markerExpiresAt: '2026-11-02T05:00:00Z', remainingS: 10800 }],
      })
      fs.writeFileSync(marker, JSON.stringify(m), { flag: 'wx' })
      let r = run('cms-qa-run.mjs', ['close'], { E2E_EXPECTED_SUPABASE_HOST: 'cms-qa-test.invalid' })
      expect(r.code, r.out).toBe(2)
      expect(r.out).toContain(`cổng ${port}`)
      r = run('cms-qa-access.mjs', ['revoke', `--users=${A}`, '--confirm', '--expect-host=cms-qa-test.invalid'])
      expect(r.code, r.out).toBe(2)
      expect(r.out).toContain('đang trong run QA mở')
      r = run('cms-qa-run.mjs', ['start', `--users=${B}`], { E2E_CMS_WRITE_QA: 'YES', E2E_EXPECTED_SUPABASE_HOST: 'cms-qa-test.invalid' })
      expect(r.code, r.out).toBe(2)
      expect(r.out).toContain('cms-qa-run.mjs close')
      expect(fs.readFileSync(marker, 'utf8')).toBe(JSON.stringify(m)) // không công cụ nào ghi đè / xoá manifest
    } finally {
      fs.rmSync(marker, { force: true })
      server.close()
    }
  })

  test('PM cli-exit §3: manifest ghi serverNotStopped ⇒ close chặn khi pid còn sống (dù cổng đã đóng); pid đã chết ⇒ qua bước này; cờ hỏng ⇒ manifest hỏng', () => {
    const marker = path.join(WEBAPP, CMS_QA_MARKER)
    expect(fs.existsSync(marker), `đang có ${CMS_QA_MARKER} thật — đóng run trước khi chạy spec này`).toBe(false)
    const base = newCmsQaManifest({
      runId: 'cms-qa-spec-ns', mode: 'manual-localhost', host: 'cms-qa-test.invalid', dbNow: '2026-11-02T02:00:00Z',
      gitHead: 'a'.repeat(40), gitTree: 'b'.repeat(40), buildId: 'B1', port: null,
      users: [{ id: A, role: 'admin', markerExpiresAt: '2026-11-02T05:00:00Z', remainingS: 10800 }],
    })
    const deadPid = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout)
    expect(Number.isInteger(deadPid) && deadPid > 0).toBe(true)
    const at = '2026-11-02T03:00:00.000Z'
    try {
      fs.writeFileSync(marker, JSON.stringify({ ...base, serverPid: process.pid, serverNotStopped: { pid: process.pid, at } }), { flag: 'wx' })
      let r = run('cms-qa-run.mjs', ['close'], { E2E_EXPECTED_SUPABASE_HOST: 'cms-qa-test.invalid' })
      expect(r.code, r.out).toBe(2)
      expect(r.out).toContain(`pid ${process.pid} được launcher ghi CHƯA DỪNG`)
      fs.rmSync(marker)
      fs.writeFileSync(marker, JSON.stringify({ ...base, serverNotStopped: { pid: null, at } }), { flag: 'wx' }) // không rõ pid ⇒ luôn chặn
      r = run('cms-qa-run.mjs', ['close'], { E2E_EXPECTED_SUPABASE_HOST: 'cms-qa-test.invalid' })
      expect(r.code, r.out).toBe(2)
      expect(r.out).toContain('(không rõ pid) được launcher ghi CHƯA DỪNG')
      fs.rmSync(marker)
      fs.writeFileSync(marker, JSON.stringify({ ...base, serverNotStopped: { pid: 2 ** 31, at } }), { flag: 'wx' }) // ngoài miền pid
      r = run('cms-qa-run.mjs', ['close'], { E2E_EXPECTED_SUPABASE_HOST: 'cms-qa-test.invalid' })
      expect(r.code, r.out).toBe(2)
      expect(r.out).toContain('manifest sai serverNotStopped')
      fs.rmSync(marker)
      fs.writeFileSync(marker, JSON.stringify({ ...base, serverPid: deadPid, serverNotStopped: { pid: deadPid, at } }), { flag: 'wx' })
      r = run('cms-qa-run.mjs', ['close'], { E2E_EXPECTED_SUPABASE_HOST: 'cms-qa-test.invalid' })
      expect(r.out).toContain(`pid ${deadPid} (launcher ghi CHƯA DỪNG`) // qua bước chặn ⇒ đối chiếu DB (host giả ⇒ LỖI DB, 1)
      expect(r.code, r.out).toBe(1)
      expect(fs.existsSync(marker)).toBe(true)
      fs.rmSync(marker)
      fs.writeFileSync(marker, JSON.stringify({ ...base, serverNotStopped: { pid: 'abc', at } }), { flag: 'wx' })
      r = run('cms-qa-run.mjs', ['close'], { E2E_EXPECTED_SUPABASE_HOST: 'cms-qa-test.invalid' })
      expect(r.code, r.out).toBe(2)
      expect(r.out).toContain('manifest sai serverNotStopped')
      expect(fs.existsSync(marker)).toBe(true) // không công cụ nào xoá manifest
    } finally {
      fs.rmSync(marker, { force: true })
    }
  })

  test('cms-verify: thiếu / sai host, phase, pre, user ⇒ 2; print-sql chỉ in khối READ ONLY', () => {
    for (const args of [['acl-snapshot'], ['post', '--phase=120', '--expect-host=other.invalid'],
      ['post', '--phase=122', '--expect-host=cms-qa-test.invalid'], ['post', '--phase=120', '--pre=khong-co.json', '--expect-host=cms-qa-test.invalid'],
      ['post', '--phase=123', '--expect-host=cms-qa-test.invalid'], ['post', '--phase=124', '--pre=khong-co.json', '--expect-host=cms-qa-test.invalid'],
      ['v8', '--user=abc', '--role=staff', '--expect-host=cms-qa-test.invalid'],
      ['v8', `--user=${A}`, '--expect-host=cms-qa-test.invalid'], // thiếu --role
      ['v8', `--user=${A}`, '--role=root', '--expect-host=cms-qa-test.invalid'],
      ['v8', `--user=${A}`, '--role=staff', '--expect-qa=yes', '--expect-host=cms-qa-test.invalid'],
      ['v8', `--user=${A}`, '--role=staff', '--require-proven=programs,nope', '--expect-host=cms-qa-test.invalid'],
      ['print-sql', '--what=v8', '--user=abc', '--role=staff'], ['print-sql', '--what=v8', `--user=${A}`]]) {
      const r = run('cms-verify.mjs', args)
      expect(r.code, args.join(' ') + '\n' + r.out).toBe(2)
    }
    // post --require-proven: khoá theo phase (123: v5 | lock-preview); 120–122 không có khoá ⇒ 2 trước IO.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-verify-rp-'))
    try {
      const preOf = (nCms: number) => {
        const fp = path.join(tmpDir, `pre-${nCms}.json`)
        fs.writeFileSync(fp, JSON.stringify({ kind: 'cms-acl-snapshot', host: 'cms-qa-test.invalid',
          acl: { db_now: '2026-11-03T00:00:00.000Z', n_all: 60 + nCms, n_old: 60, md5_all: 'a'.repeat(32), md5_old: 'b'.repeat(32) } }))
        return fp
      }
      const pre123 = preOf(37), pre122 = preOf(14)
      for (const [args, re] of [
        [['post', '--phase=123', `--pre=${pre123}`, '--require-proven=results', '--expect-host=cms-qa-test.invalid'], /--require-proven cho post --phase=123: <v5\|lock-preview>/],
        [['post', '--phase=123', `--pre=${pre123}`, '--require-proven=v5,nope', '--expect-host=cms-qa-test.invalid'], /--require-proven cho post --phase=123/],
        [['post', '--phase=122', `--pre=${pre122}`, '--require-proven=v5', '--expect-host=cms-qa-test.invalid'], /--require-proven cho post --phase=122: <\(không có khoá\)>/],
        // 126 (sales-only): PRE phải có đúng 68 hàm cms (126 không thêm hàm); khoá basis. 127 (S0) hợp lệ, PRE 68. 128 (CMS-UNIT) hợp lệ,
        // PRE 68 (6 helper mới chưa có), khoá unit; 129 là phase lạ.
        [['post', '--phase=126', `--pre=${preOf(67)}`, '--expect-host=cms-qa-test.invalid'], /không phải ảnh ngay trước 126 \(đang có 67 hàm cms\)/],
        [['post', '--phase=126', `--pre=${preOf(68)}`, '--require-proven=nope', '--expect-host=cms-qa-test.invalid'], /--require-proven cho post --phase=126: <v5\|lock-preview\|attest\|uncapped\|basis>/],
        [['post', '--phase=127', `--pre=${preOf(67)}`, '--expect-host=cms-qa-test.invalid'], /không phải ảnh ngay trước 127 \(đang có 67 hàm cms\)/],
        [['post', '--phase=127', `--pre=${preOf(68)}`, '--require-proven=nope', '--expect-host=cms-qa-test.invalid'], /--require-proven cho post --phase=127: <v5\|lock-preview\|attest\|uncapped\|basis\|resync>/],
        [['post', '--phase=128', `--pre=${preOf(74)}`, '--expect-host=cms-qa-test.invalid'], /không phải ảnh ngay trước 128 \(đang có 74 hàm cms\)/],
        [['post', '--phase=128', `--pre=${preOf(68)}`, '--require-proven=nope', '--expect-host=cms-qa-test.invalid'], /--require-proven cho post --phase=128: <v5\|lock-preview\|attest\|uncapped\|basis\|resync\|unit>/],
        [['post', '--phase=129', `--pre=${preOf(68)}`, '--expect-host=cms-qa-test.invalid'], /--phase=120\|121\|122\|123\|124\|125\|126\|127\|128/],
      ] as Array<[string[], RegExp]>) {
        const r = run('cms-verify.mjs', args)
        expect(r.code, args.join(' ') + '\n' + r.out).toBe(2)
        expect(r.out).toMatch(re)
      }
    } finally { fs.rmSync(tmpDir, { recursive: true, force: true }) }
    const p = run('cms-verify.mjs', ['print-sql', '--what=v8', `--user=${A}`, '--role=sm'])
    expect(p.code).toBe(0)
    // PM P2 cli-exit §5: SQL chỉ trên stdout (cảnh báo Node như NO_COLOR/FORCE_COLOR nằm ở stderr, không phải SQL).
    expect(p.stdout.trim()).toMatch(/^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; DO \$cmsv8\$[\s\S]*SET LOCAL ROLE authenticated;[\s\S]*ROLLBACK;$/)
  })
})

test('CMS QA tooling — SQL thật trên PGlite (migration 120 / 121 / 122, marker, V8, đóng run, VERIFY phase 122 + bắt lệch) @desktop', () => {
  test.setTimeout(300_000)
  // --part=base: đúng §1–§12 như trước (phase 123 tách sang test dưới để mỗi phần có hạn giờ riêng).
  const r = spawnSync(process.execPath, [path.join(WEBAPP, 'scripts', 'qa-cms-qa-tooling.mjs'), '--part=base'], { encoding: 'utf8', timeout: 290_000 })
  const out = `${r.stdout}\n${r.stderr}`
  expect(out, out.slice(-2000)).toMatch(/\n\d+ đạt · 0 lỗi/)
  expect(r.status).toBe(0)
})

test('CMS QA tooling — VERIFY phase 123 trên PGlite (120 → 121 → 122 → 123 thật: POST 123, phase sai, bắt lệch, bất biến V5 / V6, rollback ⇒ POST 122, V8 123) @desktop', () => {
  test.setTimeout(300_000)
  const r = spawnSync(process.execPath, [path.join(WEBAPP, 'scripts', 'qa-cms-qa-tooling.mjs'), '--part=123'], { encoding: 'utf8', timeout: 290_000 })
  const out = `${r.stdout}\n${r.stderr}`
  expect(out, out.slice(-2000)).toMatch(/\n\d+ đạt · 0 lỗi/)
  expect(out).toContain('13. VERIFY POST 123')
  expect(out).toContain('17. V8 phase 123')
  expect(r.status).toBe(0)
})

// PM `planning/reviews/2026-11-02-cms-b3-and-cli-exit-pm.md` §5 — mã thoát CLI đáng tin cậy (lỗi libuv Node 24 / Windows khi
// process.exit() ngay sau fetch: rc 127 trên prod B3). Tiến trình con thật, fetch thật tới shim pg-meta localhost trên PGlite.
test.describe('CMS QA tooling · mã thoát CLI (B3 rc 127) @desktop', () => {
  test('mã launcher: chỉ operator dừng mới thoát 0; canh marker dừng / server tự thoát ⇒ 1', () => {
    expect(cmsQaServerExitCode('operator')).toBe(0)
    expect(cmsQaServerExitCode('watchdog')).toBe(1)
    expect(cmsQaServerExitCode('error')).toBe(1)
    expect(cmsQaServerExitCode(null)).toBe(1)
    expect(CMS_QA_EXIT_GRACE_MS).toBeGreaterThan(0)
    expect(CMS_QA_EXIT_GRACE_MS).toBeLessThanOrEqual(2_000)
    const src = fs.readFileSync(path.join(WEBAPP, 'scripts', 'cms-qa-run.mjs'), 'utf8')
    expect(src).toContain('life = await T.runCmsQaServerLifecycle({')
    expect(src).toContain('return life.rc')
    // PM cli-exit §3: không xác nhận được đã dừng ⇒ ghi cờ cho close + mã 1 (kể cả nhánh setup lỗi ném CmsQaServerNotStoppedError)
    expect(src).toMatch(/if \(!life\.stopped\) \{\n\s+markNotStopped\(life\.pid\)[\s\S]*?return 1\n/)
    expect(src).toContain('if (e instanceof T.CmsQaServerNotStoppedError) markNotStopped(e.pid)')
  })

  // Vòng đời server với tiến trình con GIẢ + timer thật rút ngắn (security review P1-1 / P2-1, PM cli-exit §3): hành vi, không
  // grep nguồn. Mô phỏng ngữ nghĩa ChildProcess của Node 24 (đo 02/11): kill() lỗi ⇒ phát 'error' ĐỒNG BỘ rồi trả false;
  // tín hiệu không hỗ trợ ⇒ ném; spawn hỏng ⇒ pid undefined, exitCode âm, 'error' rồi 'close', KHÔNG có 'exit'.
  type KillMode = 'exit' | 'ignore-sigint' | 'sigint-error' | 'sigint-error-async' | 'kill-error' | 'kill-throws'
  class FakeChild extends EventEmitter {
    pid: number | undefined = 4242
    exitCode: number | null = null
    signalCode: string | null = null
    kills: string[] = []
    unrefs = 0
    constructor(private onKill: KillMode = 'exit') { super() }
    kill(sig: 'SIGINT' | 'SIGKILL') {
      this.kills.push(sig)
      if (this.pid === undefined || this.exitCode !== null || this.signalCode !== null) return false // Node: không handle ⇒ false
      const m = this.onKill
      if (m === 'kill-throws') throw new Error('kill EINVAL')
      if (m === 'kill-error' || (m === 'sigint-error' && sig === 'SIGINT')) { this.emit('error', new Error('kill EPERM')); return false }
      if (m === 'sigint-error-async' && sig === 'SIGINT') { setTimeout(() => this.emit('error', new Error('kill EPERM')), 1); return false }
      if (m === 'exit' || sig === 'SIGKILL') setTimeout(() => this.die(null, sig), 2)
      return true
    }
    unref() { this.unrefs++ }
    die(code: number | null, signal: string | null) {
      if (this.exitCode !== null || this.signalCode !== null) return
      this.exitCode = code; this.signalCode = signal
      this.emit('exit', code, signal)
    }
    get alive() { return this.exitCode === null && this.signalCode === null }
  }
  /** Spawn hỏng như Node thật: không pid; nextTick đặt exitCode âm, phát 'error' rồi 'close' — không 'exit'. */
  const failedSpawn = () => {
    const c = new FakeChild()
    c.pid = undefined
    process.nextTick(() => { c.exitCode = -4058; c.emit('error', new Error('spawn khong-co ENOENT')); c.emit('close', -4058, null) })
    return c
  }
  const good = [row({ user_id: A, remaining_s: 3 * 3600 })]
  const lifecycle = (child: FakeChild, o: { preRows?: CmsQaStatusRow[]; poll?: (s: AbortSignal) => Promise<CmsQaStatusRow[]>; setup?: () => void; graceMs?: number; killAfterMs?: number; killConfirmMs?: number } = {}) => {
    const handlers = new Map<string, () => void>()
    const signals: AbortSignal[] = []
    const logs: string[] = []
    let polls = 0
    const timers = new Set<unknown>()
    const p = runCmsQaServerLifecycle({
      child, watchdog: createCmsQaWatchdog({ userIds: [A], guardMinutes: 10 }), preRows: o.preRows ?? good, preStartedAt: Date.now(),
      poll: (s) => { polls++; signals.push(s); return o.poll ? o.poll(s) : Promise.resolve(good) },
      setup: o.setup ?? (() => {}), now: () => Date.now(),
      setInterval: (fn, ms) => { const h = setInterval(fn, ms); timers.add(h); return h },
      clearInterval: (h) => { clearInterval(h as ReturnType<typeof setInterval>); timers.delete(h) },
      setTimeout: (fn, ms) => { const h = setTimeout(() => { timers.delete(h); fn() }, ms); timers.add(h); return h },
      clearTimeout: (h) => { clearTimeout(h as ReturnType<typeof setTimeout>); timers.delete(h) },
      onSignal: (sig, fn) => { handlers.set(sig, fn) }, offSignal: (sig, fn) => { if (handlers.get(sig) === fn) handlers.delete(sig) },
      log: (l) => { logs.push(l) }, pollMs: 10, tickMs: 10, graceMs: o.graceMs ?? 15, killAfterMs: o.killAfterMs ?? 30,
      killConfirmMs: o.killConfirmMs ?? 40,
    })
    return { p, handlers, signals, logs, timers, polls: () => polls }
  }
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const lost = [row({ user_id: A, active: false, remaining_s: 0 })]

  test('vòng đời: Ctrl+C operator ⇒ 0; handler gỡ, poll đang chờ bị huỷ, không còn timer', async () => {
    const child = new FakeChild()
    const box: { pending: AbortSignal | null } = { pending: null }
    const L = lifecycle(child, { poll: (s) => { box.pending = s; return new Promise(() => {}) } }) // poll treo mãi
    await tick(40)
    expect(L.handlers.has('SIGINT') && L.handlers.has('SIGTERM')).toBe(true)
    L.handlers.get('SIGINT')!()
    const r = await L.p
    expect(r).toMatchObject({ rc: 0, stopKind: 'operator', childError: null, stopped: true })
    expect(child.kills).toEqual(['SIGINT'])
    expect(L.handlers.size).toBe(0)
    expect(box.pending?.aborted).toBe(true)
    expect(L.timers.size).toBe(0)
  })

  test('vòng đời: canh marker dừng (mất marker giữa chừng) ⇒ 1; preflight dưới ngưỡng ⇒ dừng ngay, 1', async () => {
    const c1 = new FakeChild()
    const L1 = lifecycle(c1, { poll: () => Promise.resolve(lost) })
    const r1 = await L1.p
    expect(r1).toMatchObject({ rc: 1, stopKind: 'watchdog', stopped: true })
    expect(c1.kills[0]).toBe('SIGINT')
    expect(L1.handlers.size).toBe(0)
    const c2 = new FakeChild()
    const L2 = lifecycle(c2, { preRows: [row({ user_id: A, remaining_s: 5 * 60 })] })
    const r2 = await L2.p
    expect(r2).toMatchObject({ rc: 1, stopKind: 'watchdog' })
    expect(L2.polls()).toBe(0)
  })

  test('vòng đời: server tự chết ⇒ 1 (không đổi thành 0); spawn hỏng (không pid, không exit) ⇒ tự kết thúc 1, không kill', async () => {
    const c1 = new FakeChild()
    const L1 = lifecycle(c1)
    await tick(30)
    c1.die(1, null)
    expect(await L1.p).toMatchObject({ rc: 1, stopKind: null, code: 1, stopped: true })
    expect(c1.kills).toEqual([])
    const c2 = failedSpawn()
    const L2 = lifecycle(c2)
    expect(await L2.p).toMatchObject({ rc: 1, childError: 'spawn khong-co ENOENT', stopped: true, pid: null })
    expect(c2.kills).toEqual([])
    expect(L2.handlers.size).toBe(0)
    expect(L2.timers.size).toBe(0)
  })

  test('PM cli-exit §3 — canh marker dừng → SIGINT lỗi EPERM (đồng bộ / trễ) → SIGKILL ngay → con THẬT SỰ thoát; timer / handler dọn', async () => {
    for (const mode of ['sigint-error', 'sigint-error-async'] as const) {
      const c = new FakeChild(mode)
      // killAfterMs dài: SIGKILL phải đến từ việc xử lý lỗi, không phải hạn SIGINT; timer hạn đó cũng phải bị huỷ.
      const L = lifecycle(c, { poll: () => Promise.resolve(lost), killAfterMs: 5_000 })
      const r = await L.p
      expect(r, mode).toMatchObject({ rc: 1, stopKind: 'watchdog', childError: 'kill EPERM', stopped: true, signal: 'SIGKILL', pid: 4242 })
      expect(c.kills, mode).toEqual(['SIGINT', 'SIGKILL'])
      expect(c.alive, mode).toBe(false)
      expect(c.unrefs, mode).toBe(0)
      expect(L.timers.size, mode).toBe(0)
      expect(L.handlers.size, mode).toBe(0)
    }
  })

  test('PM cli-exit §3 — operator Ctrl+C → SIGINT lỗi → SIGKILL → con thoát ⇒ 1 (có lỗi, không đổi thành 0); kill() ném ⇒ như error, hữu hạn', async () => {
    const c1 = new FakeChild('sigint-error')
    const L1 = lifecycle(c1, { killAfterMs: 5_000 })
    await tick(20)
    L1.handlers.get('SIGINT')!()
    expect(await L1.p).toMatchObject({ rc: 1, stopKind: 'operator', childError: 'kill EPERM', stopped: true, signal: 'SIGKILL' })
    expect(c1.kills).toEqual(['SIGINT', 'SIGKILL'])
    expect(c1.alive).toBe(false)
    expect(L1.timers.size).toBe(0)
    expect(L1.handlers.size).toBe(0)
    const c2 = new FakeChild('kill-throws')
    const L2 = lifecycle(c2, { killAfterMs: 5_000 })
    await tick(20)
    expect(() => L2.handlers.get('SIGTERM')!()).not.toThrow()
    expect(await L2.p).toMatchObject({ rc: 1, stopKind: 'operator', childError: 'kill EINVAL', stopped: false, pid: 4242 })
    expect(c2.kills).toEqual(['SIGINT', 'SIGKILL'])
    expect(c2.alive).toBe(true)
    expect(c2.unrefs).toBe(1)
    expect(L2.timers.size).toBe(0)
    expect(L2.handlers.size).toBe(0)
  })

  test('PM cli-exit §3 — không dừng được ở cấp OS (mọi kill lỗi) ⇒ CHƯA DỪNG rõ ràng, hữu hạn, không báo đã dọn; error / exit muộn không thoát ngoài kiểm soát', async () => {
    const c = new FakeChild('kill-error')
    const L = lifecycle(c, { poll: () => Promise.resolve(lost), killAfterMs: 5_000, killConfirmMs: 40 })
    const t0 = Date.now()
    const r = await L.p
    expect(r).toMatchObject({ rc: 1, stopKind: 'watchdog', childError: 'kill EPERM', stopped: false, pid: 4242, code: null, signal: null })
    expect(Date.now() - t0).toBeLessThan(2_000)
    expect(c.kills).toEqual(['SIGINT', 'SIGKILL'])
    expect(c.alive).toBe(true)
    expect(c.unrefs).toBe(1)
    expect(L.timers.size).toBe(0)
    expect(L.handlers.size).toBe(0)
    expect(L.logs.join('\n')).toContain('SERVER QA CHƯA DỪNG: pid 4242')
    expect(() => c.emit('error', new Error('kill EPERM lần 3'))).not.toThrow()
    expect(L.timers.size).toBe(0)
    expect(c.kills).toEqual(['SIGINT', 'SIGKILL']) // không gửi lại / không hẹn lại sau khi đã bỏ lại
    expect(() => c.die(null, 'SIGKILL')).not.toThrow()
    expect(L.timers.size).toBe(0)
  })

  test('PM cli-exit §3 — lỗi tiến trình con khi server còn sống, chưa ai dừng ⇒ bắt đầu dừng (error), con thoát thật ⇒ 1', async () => {
    const c = new FakeChild()
    const L = lifecycle(c)
    await tick(20)
    c.emit('error', new Error('channel closed'))
    expect(await L.p).toMatchObject({ rc: 1, stopKind: 'error', childError: 'channel closed', stopped: true, signal: 'SIGINT' })
    expect(c.kills).toEqual(['SIGINT'])
    expect(c.alive).toBe(false)
    expect(L.timers.size).toBe(0)
    expect(L.handlers.size).toBe(0)
  })

  test('vòng đời: setup lỗi sau spawn ⇒ GIẾT server ngay; SIGKILL thành công ⇒ ném lỗi gốc; SIGKILL lỗi ⇒ CmsQaServerNotStoppedError, không poll / handler / timer', async () => {
    const c1 = new FakeChild()
    const L1 = lifecycle(c1, { setup: () => { throw new Error('EPERM: ghi manifest') } })
    await expect(L1.p).rejects.toThrow('EPERM: ghi manifest')
    expect(c1.kills).toEqual(['SIGKILL'])
    expect(c1.signalCode).toBe('SIGKILL')
    expect(L1.polls()).toBe(0)
    expect(L1.handlers.size).toBe(0)
    expect(L1.timers.size).toBe(0)
    expect(L1.logs.join('\n')).toContain('GIẾT server QA')
    const c2 = new FakeChild('kill-error')
    const L2 = lifecycle(c2, { setup: () => { throw new Error('EPERM: ghi manifest') } })
    const e = await L2.p.then(() => null, (x: unknown) => x)
    expect(e).toBeInstanceOf(CmsQaServerNotStoppedError)
    expect((e as CmsQaServerNotStoppedError).pid).toBe(4242)
    expect(String((e as Error).message)).toMatch(/pid 4242 CHƯA DỪNG[\s\S]*EPERM: ghi manifest/)
    expect(c2.kills).toEqual(['SIGKILL'])
    expect(c2.alive).toBe(true)
    expect(c2.unrefs).toBe(1)
    expect(L2.polls()).toBe(0)
    expect(L2.handlers.size).toBe(0)
    expect(L2.timers.size).toBe(0)
    // spawn hỏng + setup lỗi: không treo chờ 'exit' không bao giờ tới ⇒ ném lỗi gốc
    const c3 = failedSpawn()
    const L3 = lifecycle(c3, { setup: () => { throw new Error('EPERM: ghi manifest') } })
    await expect(L3.p).rejects.toThrow('EPERM: ghi manifest')
    expect(L3.timers.size).toBe(0)
  })

  test('vòng đời: Ctrl+C tới cha SAU exit của con nhưng trong grace ⇒ 0; server lờ SIGINT ⇒ SIGKILL sau hạn', async () => {
    const c1 = new FakeChild()
    const L1 = lifecycle(c1, { graceMs: 60 })
    await tick(20)
    c1.die(null, 'SIGINT') // Windows: con nhận Ctrl+C trước
    await tick(10)
    L1.handlers.get('SIGINT')!() // cha nhận muộn, vẫn trong grace
    expect(await L1.p).toMatchObject({ rc: 0, stopKind: 'operator', stopped: true })
    expect(c1.kills).toEqual([]) // con đã thoát ⇒ không kill / không hẹn SIGKILL
    expect(L1.timers.size).toBe(0)
    const c2 = new FakeChild('ignore-sigint')
    const L2 = lifecycle(c2, { killAfterMs: 20 })
    await tick(20)
    L2.handlers.get('SIGTERM')!()
    expect(await L2.p).toMatchObject({ rc: 0, stopKind: 'operator', signal: 'SIGKILL', stopped: true })
    expect(c2.kills).toEqual(['SIGINT', 'SIGKILL'])
    expect(c2.alive).toBe(false)
    expect(L2.timers.size).toBe(0)
  })

  test('cms-verify / cms-qa-access / cms-qa-run thành tiến trình con: đúng mã 0 / 1 / 2, tự kết thúc, không UV_HANDLE_CLOSING', () => {
    test.setTimeout(180_000)
    const r = spawnSync(process.execPath, [path.join(WEBAPP, 'scripts', 'qa-cms-cli-exit.mjs')], { encoding: 'utf8', timeout: 170_000 })
    const out = `${r.stdout}\n${r.stderr}`
    expect(out, out.slice(-2500)).toMatch(/\n\d+ đạt · 0 lỗi/)
    expect(out).not.toMatch(/Assertion failed|UV_HANDLE_CLOSING/)
    expect(r.status).toBe(0)
  })
})
