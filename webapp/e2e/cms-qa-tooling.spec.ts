import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { execFileSync, spawnSync } from 'node:child_process'
import { test, expect } from '@playwright/test'
import { CMS_QA_MARKER, cmsWriteGate } from './writeQaGates'
import {
  CMS_QA_GIT_STATUS_ARGS, CMS_QA_GUARD_MINUTES_MIN, CMS_QA_POLL_MS, CMS_QA_TICK_MS, cmsQaTreeState, createCmsQaWatchdog,
  parseCmsQaGuardMinutes, startCmsQaWatchdogLoop,
  CMS_QA_GRANTED_BY, assertCmsQaProgramIds, cmsQaAckWarnings, cmsQaCloseCheck, cmsQaGrantSql, cmsQaManifestAddProgram, cmsQaPreflight,
  cmsQaRevokeSql, cmsQaStatusSql, cmsQaWatchdog, cmsVerifyV8Sql, evaluateCmsV8, maskCmsUuid, newCmsQaManifest, parseCmsQaManifest,
  parseCmsQaTtlHours, parseCmsQaUserIds, pgMetaReadOnly, pgMetaReadOnlySnapshot, pgMetaWrite, toIsoUtc, type CmsQaProgramRow,
  type CmsQaStatusRow, type CmsV8Role,
} from './cmsQaTooling'

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
      role_now: 'authenticated', uid: A, ro: 'on', iso: 'repeatable read', me_bypass: false, runner_bypass: true, user_role: 'staff', su: false,
      qa_db: false, qa: false, same_set: true, readable: 2,
      rls_cms_programs: true, rls_cms_program_stores: true, rls_cms_program_products: true, rls_cms_program_tiers: true,
      rls_cms_import_runs: true, rls_cms_product_master: true,
      seen_programs: 2, exp_programs: 2, total_programs: 5, seen_stores: 2, exp_stores: 2, total_stores: 6,
      seen_products: 3, exp_products: 3, total_products: 7, seen_tiers: 4, exp_tiers: 4, total_tiers: 9,
      seen_import_runs: 0, exp_import_runs: 0, total_import_runs: 2, seen_master: 0, exp_master: 0, total_master: 9,
      test_programs: 0, draft_programs: 0, out_programs: 0, out_stores: 0, out_products: 0, out_tiers: 0, out_import_runs: 0,
      read_qa_access: false, read_sync_runs: false, write_programs: false, rpc_callable: 0,
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
      [{ read_qa_access: true }, 'staff', 'v8-private'], [{ write_programs: true }, 'staff', 'v8-private'], [{ rpc_callable: 1 }, 'staff', 'v8-private'],
    ]
    for (const [o, role, id] of bad) {
      const failedIds = evaluateCmsV8({ ...good, ...o }, A, role).filter((c) => !c.ok).map((c) => c.id)
      expect(failedIds, `${role} ${JSON.stringify(o)}`).toContain(id)
    }
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
    return { code: r.status, out: `${r.stdout}${r.stderr}` }
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

  test('cms-verify: thiếu / sai host, phase, pre, user ⇒ 2; print-sql chỉ in khối READ ONLY', () => {
    for (const args of [['acl-snapshot'], ['post', '--phase=120', '--expect-host=other.invalid'],
      ['post', '--phase=122', '--expect-host=cms-qa-test.invalid'], ['post', '--phase=120', '--pre=khong-co.json', '--expect-host=cms-qa-test.invalid'],
      ['v8', '--user=abc', '--role=staff', '--expect-host=cms-qa-test.invalid'],
      ['v8', `--user=${A}`, '--expect-host=cms-qa-test.invalid'], // thiếu --role
      ['v8', `--user=${A}`, '--role=root', '--expect-host=cms-qa-test.invalid'],
      ['v8', `--user=${A}`, '--role=staff', '--expect-qa=yes', '--expect-host=cms-qa-test.invalid'],
      ['v8', `--user=${A}`, '--role=staff', '--require-proven=programs,nope', '--expect-host=cms-qa-test.invalid'],
      ['print-sql', '--what=v8', '--user=abc', '--role=staff'], ['print-sql', '--what=v8', `--user=${A}`]]) {
      const r = run('cms-verify.mjs', args)
      expect(r.code, args.join(' ') + '\n' + r.out).toBe(2)
    }
    const p = run('cms-verify.mjs', ['print-sql', '--what=v8', `--user=${A}`, '--role=sm'])
    expect(p.code).toBe(0)
    expect(p.out.trim()).toMatch(/^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; DO \$cmsv8\$[\s\S]*SET LOCAL ROLE authenticated;[\s\S]*ROLLBACK;$/)
  })
})

test('CMS QA tooling — SQL thật trên PGlite (migration 120 / 121, marker, V8, đóng run, VERIFY bắt lệch) @desktop', () => {
  test.setTimeout(180_000)
  const r = spawnSync(process.execPath, [path.join(WEBAPP, 'scripts', 'qa-cms-qa-tooling.mjs')], { encoding: 'utf8', timeout: 170_000 })
  const out = `${r.stdout}\n${r.stderr}`
  expect(out, out.slice(-2000)).toMatch(/\n\d+ đạt · 0 lỗi/)
  expect(r.status).toBe(0)
})
