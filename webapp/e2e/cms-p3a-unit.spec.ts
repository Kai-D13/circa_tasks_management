import * as XLSX from 'xlsx'
import { test, expect } from '@playwright/test'
import { cmsFlagsFromEnv, cmsLockEnabledFromEnv } from '../lib/cms/flags'
import {
  CmsPayoutDtoError, cmsLockActionLabel, cmsLockCodeLabel, cmsLockReady, cmsNormalizeAck, cmsUnassignedRatioText, parseCmsLockPreview,
  parseCmsPayout,
} from '../lib/cms/payoutView'
import { cmsLockRpcCode, runCmsLock, runCmsLockPreview, type CmsLockDeps } from '../lib/cms/lockAction'
import { buildCmsPayoutWorkbook, handleCmsPayoutExport, type CmsPayoutExportDeps } from '../lib/cms/exportPayouts'

// CMS P3a — phần thuần của chốt kỳ / chi trả (work order P3a luồng C / D / E): DTO preview + payout (shape, tiền chuỗi, email
// chỉ super, Σ = scope_total), cờ ba lớp, lõi action chốt (thứ tự cổng, actor từ session, namespace QA, mã lỗi cố định —
// UNKNOWN_OUTCOME khi mất phản hồi, phản hồi lệch run), XLSX chi trả (cột / tổng / nhãn phạm vi / QA) + handler. Không DB —
// hành vi DB thật ở planning/research/dev-tools/cms/draft-p3/123-realpg-test.mjs (PG15) + scripts/qa-cms-123.mjs (PGlite).

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const P = uid(1), R = uid(2), R2 = uid(3), ACTOR = uid(9), A = uid(11), B = uid(12), S1 = uid(21), S2 = uid(22)
const TS = '2026-11-02T01:00:00.000000Z'

const previewRaw = (o: Record<string, unknown> = {}) => ({
  program_id: P, found: true, status: 'active', is_test: true, end_date: '2026-11-01', config_version: 3,
  run_id: R, run_started_at: TS, amount_vnd: '42000', results_amount_vnd: '42000', staff_rows: 6, staff_paid: 6,
  candidate_lines: 600, candidate_gmv: '9500000', unassigned_lines: 5, unassigned_gmv: '15000', unassigned_over: false, needs_ack: true,
  policy: { label: 'QA_ONLY_ASSUMPTION', unassigned_max_gmv_bp: 200, unassigned_max_lines: 20, wait_hours: 0, completeness: 'qa_assumption' },
  policy_version: 1, mapping_fp_run: 'a'.repeat(32), mapping_fp_now: 'a'.repeat(32), source_complete_basis: 'qa_assumption',
  source_complete_through: null, earliest_lock_at: TS, blockers: [], ...o,
})
const payoutRaw = (viewer: string, o: Record<string, unknown> = {}) => {
  const isSuper = viewer === 'super'
  const rows = [
    { user_id: A, store_id: S1, name: 'Dược sĩ A', store_name: 'NT 1', amount_vnd: '30000', products_with_cms: 2, ...(isSuper ? { email: 'a@x.vn' } : {}) },
    { user_id: B, store_id: S2, name: 'Dược sĩ B', store_name: 'NT 2', amount_vnd: '0', products_with_cms: 0, ...(isSuper ? { email: 'b@x.vn' } : {}) },
  ]
  return {
    program_id: P, run_id: R, is_test: false, locked_at: TS, policy_version: 1, viewer,
    program_total: isSuper ? '30000' : null, scope_total: '30000', rows,
    ...(isSuper ? {
      locked_by: ACTOR, staff_rows: 2, staff_paid: 1, candidate_lines: 10, candidate_gmv: '100000', unassigned_lines: 0, unassigned_gmv: '0',
      ack_reason: null, policy: { ready: false, pending: ['Q-206'] }, source_complete_basis: 'bi_watermark', source_complete_through: '2026-11-01',
      run_started_at: TS,
    } : {}),
    ...o,
  }
}

test.describe('CMS P3a — DTO / nhãn @desktop', () => {
  test('cờ: chốt cần CẢ ba cờ program + earnings + lock (chuỗi đúng "true")', () => {
    expect(cmsLockEnabledFromEnv({ CMS_PROGRAM_ENABLED: 'true', CMS_EARNINGS_ENABLED: 'true', CMS_LOCK_ENABLED: 'true' })).toBe(true)
    for (const env of [{}, { CMS_LOCK_ENABLED: 'true' }, { CMS_PROGRAM_ENABLED: 'true', CMS_LOCK_ENABLED: 'true' },
      { CMS_PROGRAM_ENABLED: 'true', CMS_EARNINGS_ENABLED: 'true', CMS_LOCK_ENABLED: 'TRUE' }]) {
      expect(cmsLockEnabledFromEnv(env), JSON.stringify(env)).toBe(false)
    }
    expect(cmsFlagsFromEnv({}).lock).toBe(false)
  })

  test('preview: shape đúng ⇒ DTO; chưa có run / không tìm thấy; sai shape ⇒ throw (không 0 giả)', () => {
    const p = parseCmsLockPreview(previewRaw())
    expect([p.runId, p.amountVnd, p.staffPaid, p.needsAck, p.policy.label, p.policyVersion, p.mappingChanged, cmsLockReady(p)])
      .toEqual([R, '42000', 6, true, 'QA_ONLY_ASSUMPTION', 1, false, true])
    expect(parseCmsLockPreview(previewRaw({ mapping_fp_now: 'b'.repeat(32) })).mappingChanged).toBe(true)
    const blocked = parseCmsLockPreview(previewRaw({ blockers: ['CMS_LOCK_STALE_MAPPING'] }))
    expect(cmsLockReady(blocked)).toBe(false)
    const none = parseCmsLockPreview(previewRaw({ run_id: null, run_started_at: null, amount_vnd: null, staff_rows: null, staff_paid: null, blockers: ['CMS_LOCK_NO_RESULT'] }))
    expect([none.runId, cmsLockReady(none)]).toEqual([null, false])
    const nf = parseCmsLockPreview({ program_id: P, found: false, blockers: ['CMS_PROGRAM_NOT_FOUND'] })
    expect([nf.found, nf.blockers]).toEqual([false, ['CMS_PROGRAM_NOT_FOUND']])
    for (const bad of [
      null, previewRaw({ amount_vnd: 42000 }), previewRaw({ amount_vnd: '4.2' }), previewRaw({ blockers: ['DROP TABLE'] }),
      previewRaw({ run_id: 'x' }), previewRaw({ staff_rows: null }), previewRaw({ status: 'open' }), previewRaw({ candidate_gmv: 1 }),
    ]) expect(() => parseCmsLockPreview(bad), JSON.stringify(bad)?.slice(0, 80)).toThrow(CmsPayoutDtoError)
  })

  test('payout: super có email + program_total; SM / QLCH / staff KHÔNG email, program_total null; Σ dòng = scope_total', () => {
    const s = parseCmsPayout(payoutRaw('super'))
    expect([s.programTotal, s.scopeTotal, s.rows[0].email, s.super?.staffPaid]).toEqual(['30000', '30000', 'a@x.vn', 1])
    for (const v of ['sm', 'store_manager', 'staff']) {
      const x = parseCmsPayout(payoutRaw(v))
      expect([x.programTotal, x.rows.every((r) => r.email === null), x.super]).toEqual([null, true, null])
    }
    // Vai không phải super mà DB trả email / program_total ⇒ từ chối (không rò ra UI / file).
    const leak = payoutRaw('sm')
    ;(leak.rows[0] as Record<string, unknown>).email = 'a@x.vn'
    expect(() => parseCmsPayout(leak)).toThrow(CmsPayoutDtoError)
    expect(() => parseCmsPayout(payoutRaw('sm', { program_total: '30000' }))).toThrow(CmsPayoutDtoError)
    expect(() => parseCmsPayout(payoutRaw('super', { scope_total: '30001', program_total: '30001' }))).toThrow(/scope_total/)
    expect(() => parseCmsPayout(payoutRaw('super', { program_total: '99' }))).toThrow(/program_total/)
    expect(() => parseCmsPayout(payoutRaw('super', { staff_rows: 3 }))).toThrow(/staff_rows/)
    // Tiền vượt Number an toàn vẫn đúng từng đồng (BigInt).
    const big = payoutRaw('super', { program_total: '9007199254740993', scope_total: '9007199254740993' })
    ;(big.rows[0] as Record<string, unknown>).amount_vnd = '9007199254740993'
    expect(parseCmsPayout(big).scopeTotal).toBe('9007199254740993')
  })

  test('lý do + tỷ lệ + nhãn: cắt khoảng trắng như DB; 10–1.000 ký tự; mã lạ có nhãn chung', () => {
    expect(cmsNormalizeAck('  Đã đối soát với vận hành  ')).toBe('Đã đối soát với vận hành')
    expect(cmsNormalizeAck('\n'.repeat(12) + '\t\t')).toBeNull()
    expect(cmsNormalizeAck('ngắn quá')).toBeNull()
    expect(cmsNormalizeAck('x'.repeat(1001))).toBeNull()
    expect(cmsUnassignedRatioText('20000', '1000000')).toBe('2,00%')
    expect(cmsUnassignedRatioText('1', '3')).toBe('33,33%')
    expect(cmsUnassignedRatioText('0', '0')).toBe('0%')
    expect(cmsLockCodeLabel('CMS_LOCK_RUN_CHANGED')).toMatch(/kiểm tra lại/)
    expect(cmsLockCodeLabel('CMS_LOCK_SOMETHING_NEW')).toContain('CMS_LOCK_SOMETHING_NEW')
    expect(cmsLockActionLabel('UNKNOWN_OUTCOME')).toMatch(/tải lại trang/)
  })
})

type Call = { fn: string; args: Record<string, unknown> }
function deps(o: Partial<CmsLockDeps> & { rpcData?: unknown; rpcError?: { code?: string; message?: string } | null; rpcThrow?: boolean } = {}) {
  const calls: Call[] = []
  const d: CmsLockDeps = {
    lockEnabled: () => true,
    qaReadonly: () => false,
    access: async () => ({ kind: 'ok', actorId: ACTOR, qa: true }),
    program: async () => ({ isTest: true }),
    rpc: async (fn, args) => {
      calls.push({ fn, args })
      if (o.rpcThrow) throw new Error('fetch failed')
      if (o.rpcError !== undefined && o.rpcError !== null) return { data: null, error: o.rpcError }
      return { data: 'rpcData' in o ? o.rpcData : (fn === 'rpc_cms_lock_preview' ? previewRaw() : { locked: true, already: false, program_id: P, run_id: R, amount_vnd: '42000', policy_version: 1 }), error: null }
    },
    ...o,
  }
  return { d, calls }
}
const INPUT = { programId: P, expectedRunId: R, expectedPolicyVersion: 1, ackReason: 'Đã đối soát với vận hành (QA)' }

test.describe('CMS P3a — lõi action chốt @desktop', () => {
  test('cổng: cờ OFF / chưa đăng nhập / không super / lỗi quyền / id sai / QA không marker ⇒ mã cố định, 0 RPC', async () => {
    const cases: Array<[Partial<CmsLockDeps>, unknown, string]> = [
      [{ lockEnabled: () => false }, INPUT, 'LOCK_DISABLED'],
      [{ access: async () => ({ kind: 'anonymous' }) }, INPUT, 'UNAUTHENTICATED'],
      [{ access: async () => ({ kind: 'forbidden' }) }, INPUT, 'FORBIDDEN'],
      [{ access: async () => ({ kind: 'unavailable' }) }, INPUT, 'UNAVAILABLE'],
      [{ access: async () => { throw new Error('x') } }, INPUT, 'UNAVAILABLE'],
      [{}, { ...INPUT, programId: 'abc' }, 'BAD_INPUT'],
      [{ program: async () => null }, INPUT, 'NOT_FOUND'],
      [{ access: async () => ({ kind: 'ok', actorId: ACTOR, qa: false }) }, INPUT, 'NOT_FOUND'],
      [{ program: async () => { throw new Error('db') } }, INPUT, 'QUERY_FAILED'],
      [{}, { ...INPUT, expectedRunId: 'x' }, 'BAD_INPUT'],
      [{}, { ...INPUT, expectedPolicyVersion: 1.5 }, 'BAD_INPUT'],
      [{}, { ...INPUT, expectedPolicyVersion: '1' }, 'BAD_INPUT'],
      [{}, { ...INPUT, ackReason: 'ngắn' }, 'CMS_LOCK_ACK_REQUIRED'],
      [{}, { ...INPUT, ackReason: 42 }, 'BAD_INPUT'],
    ]
    for (const [o, input, code] of cases) {
      const { d, calls } = deps(o)
      const r = await runCmsLock(d, input)
      expect([r.ok, r.ok ? null : r.code, calls.length], `${code}`).toEqual([false, code, 0])
    }
  })

  test('actor lấy từ SESSION (form gửi actor / tổng / is_test bị bỏ qua); expected run / policy / lý do đã cắt chuyển nguyên vào RPC', async () => {
    const { d, calls } = deps()
    const r = await runCmsLock(d, { ...INPUT, actor: uid(666), amountVnd: '999999', isTest: false, ackReason: '  Đã đối soát với vận hành (QA)  ' })
    expect(r).toEqual({ ok: true, already: false, programId: P, runId: R, amountVnd: '42000', policyVersion: 1, sourceAttestationId: null })
    expect(calls).toEqual([{ fn: 'rpc_cms_program_lock', args: { p_program_id: P, p_expected_run_id: R, p_expected_policy_version: 1, p_actor: ACTOR, p_ack_reason: 'Đã đối soát với vận hành (QA)' } }])
    const empty = deps()
    await runCmsLock(empty.d, { ...INPUT, ackReason: '   ' })
    expect(empty.calls[0].args.p_ack_reason).toBeNull() // rỗng ⇒ DB quyết có bắt buộc lý do không
    const again = deps({ rpcData: { locked: true, already: true, program_id: P, run_id: R, amount_vnd: '42000', policy_version: 1 } })
    expect(await runCmsLock(again.d, INPUT)).toMatchObject({ ok: true, already: true }) // bấm hai lần / gọi lại ⇒ idempotent
  })

  test('lỗi RPC: CMS_* ⇒ đúng mã; 55P03 ⇒ BUSY; timeout / mất kết nối / phản hồi lệch run ⇒ UNKNOWN_OUTCOME (không kết luận chưa chốt)', async () => {
    const cases: Array<[Parameters<typeof deps>[0], string]> = [
      [{ rpcError: { code: 'P0001', message: 'CMS_LOCK_RUN_CHANGED' } }, 'CMS_LOCK_RUN_CHANGED'],
      [{ rpcError: { code: 'P0001', message: 'error: CMS_LOCK_POLICY_PENDING at line 3' } }, 'CMS_LOCK_POLICY_PENDING'],
      [{ rpcError: { code: '55P03', message: 'canceling statement due to lock timeout' } }, 'BUSY'],
      [{ rpcError: { code: '57014', message: 'canceling statement due to statement timeout' } }, 'UNKNOWN_OUTCOME'],
      [{ rpcError: { code: '08006', message: 'connection failure' } }, 'UNKNOWN_OUTCOME'],
      [{ rpcError: { code: '', message: 'TypeError: fetch failed' } }, 'UNKNOWN_OUTCOME'],
      [{ rpcError: { code: '23514', message: 'new row violates check constraint "x" — chi tiết DB' } }, 'QUERY_FAILED'],
      [{ rpcThrow: true }, 'UNKNOWN_OUTCOME'],
      [{ rpcData: null }, 'UNKNOWN_OUTCOME'],
      [{ rpcData: { locked: true, already: false, program_id: P, run_id: R2, amount_vnd: '1', policy_version: 1 } }, 'UNKNOWN_OUTCOME'],
      [{ rpcData: { locked: true, already: false, program_id: P, run_id: R, amount_vnd: 42000, policy_version: 1 } }, 'UNKNOWN_OUTCOME'],
    ]
    for (const [o, code] of cases) {
      const r = await runCmsLock(deps(o).d, INPUT)
      expect(r.ok ? 'OK' : r.code, JSON.stringify(o).slice(0, 90)).toBe(code)
      if (!r.ok) expect(r.code).not.toMatch(/chi tiết DB|check constraint/) // không rò message DB
    }
    expect(cmsLockRpcCode(null)).toBe('UNKNOWN_OUTCOME')
    // PostgREST từ chối trước khi chạy hàm ⇒ chắc chắn chưa ghi; lỗi kết nối PostgREST ↔ DB ⇒ vẫn không rõ.
    expect(cmsLockRpcCode({ code: 'PGRST202', message: 'Could not find the function' })).toBe('QUERY_FAILED')
    expect(cmsLockRpcCode({ code: 'PGRST301', message: 'JWT' })).toBe('QUERY_FAILED')
    expect(cmsLockRpcCode({ code: 'PGRST001', message: 'connection' })).toBe('UNKNOWN_OUTCOME')
  })

  test('PM r1 PKG-P1-2: server QA (qaReadonly) ⇒ chốt bị từ chối TRƯỚC RPC (0 lời gọi); preview vẫn đọc được; cổng quyền vẫn đứng trước', async () => {
    const qa = deps({ qaReadonly: () => true })
    expect(await runCmsLock(qa.d, INPUT)).toEqual({ ok: false, code: 'QA_SERVER_READONLY' })
    expect(qa.calls).toEqual([])
    const pv = await runCmsLockPreview(qa.d, P)
    expect(pv.ok).toBe(true)
    expect(qa.calls.map((c) => c.fn)).toEqual(['rpc_cms_lock_preview'])
    // Không lộ chế độ QA cho người không đủ quyền: cờ / quyền vẫn trả mã của cổng.
    expect(await runCmsLock(deps({ qaReadonly: () => true, lockEnabled: () => false }).d, INPUT)).toEqual({ ok: false, code: 'LOCK_DISABLED' })
    expect(await runCmsLock(deps({ qaReadonly: () => true, access: async () => ({ kind: 'forbidden' }) }).d, INPUT)).toEqual({ ok: false, code: 'FORBIDDEN' })
    expect(cmsLockActionLabel('QA_SERVER_READONLY')).toMatch(/Server QA chỉ đọc/)
  })

  test('preview: cùng cổng; DTO hỏng / lỗi DB ⇒ QUERY_FAILED (preview chỉ đọc — không "kết quả không rõ")', async () => {
    const ok = deps()
    const r = await runCmsLockPreview(ok.d, P)
    expect(r.ok && r.preview.runId).toBe(R)
    expect(ok.calls[0]).toEqual({ fn: 'rpc_cms_lock_preview', args: { p_program_id: P } })
    expect(await runCmsLockPreview(deps({ lockEnabled: () => false }).d, P)).toEqual({ ok: false, code: 'LOCK_DISABLED' })
    expect(await runCmsLockPreview(deps({ rpcData: { program_id: P } }).d, P)).toEqual({ ok: false, code: 'QUERY_FAILED' })
    expect(await runCmsLockPreview(deps({ rpcThrow: true }).d, P)).toEqual({ ok: false, code: 'QUERY_FAILED' })
    expect(await runCmsLockPreview(deps({ rpcError: { code: '57014', message: 'timeout' } }).d, P)).toEqual({ ok: false, code: 'QUERY_FAILED' })
    expect(await runCmsLockPreview(deps({ access: async () => ({ kind: 'ok', actorId: ACTOR, qa: false }) }).d, P)).toEqual({ ok: false, code: 'NOT_FOUND' })
  })
})

const PROG = { id: P, name: 'CMS tháng 10', startDate: '2026-10-01', endDate: '2026-10-31', status: 'locked', isTest: false }
const read = (bytes: Uint8Array) => XLSX.read(bytes, { type: 'array' })
const rowsOf = (wb: XLSX.WorkBook, name: string) => XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, defval: '' })

test.describe('CMS P3a — XLSX chi trả @desktop', () => {
  test('super: cột email, tổng toàn chương trình = program_total, dòng 0 đ giữ lại, sheet thông tin có Q-213 / người chốt', () => {
    const b = buildCmsPayoutWorkbook({ program: PROG, payout: parseCmsPayout(payoutRaw('super')), exportedAt: new Date('2026-11-03T03:00:00Z'), scope: 'super' })
    expect(b.ok).toBe(true)
    if (!b.ok) return
    const wb = read(b.bytes)
    const pay = rowsOf(wb, 'Chi tra')
    expect(pay[0]).toEqual(['STT', 'Dược sĩ (lúc chốt)', 'Email (lúc chốt)', 'Nhà thuốc (lúc chốt)', 'Số SP có CMS', 'Tiền CMS (VND)'])
    expect(pay[1]).toEqual([1, 'Dược sĩ A', 'a@x.vn', 'NT 1', 2, 30000])
    expect(pay[2]).toEqual([2, 'Dược sĩ B', 'b@x.vn', 'NT 2', 0, 0])
    expect(pay[pay.length - 1]).toEqual(['', 'Tổng toàn chương trình', '', '', '', 30000])
    const info = rowsOf(wb, 'Thong tin').map((r) => String(r[0]))
    expect(info).toEqual(expect.arrayContaining(['Người chốt (id)', 'Dòng chưa gán', 'Lưu ý']))
    expect(b.totalVnd).toBe(BigInt(30000))
  })

  test('SM: KHÔNG cột email, nhãn "trong phạm vi của bạn", tổng = scope_total; QA ⇒ nhãn không chi trả; vai lệch / tổng lệch ⇒ không file', () => {
    const sm = buildCmsPayoutWorkbook({ program: { ...PROG, isTest: true }, payout: parseCmsPayout(payoutRaw('sm', { is_test: true })), exportedAt: new Date(), scope: 'sm' })
    expect(sm.ok).toBe(true)
    if (!sm.ok) return
    const wb = read(sm.bytes)
    const pay = rowsOf(wb, 'Chi tra')
    expect(pay[0]).not.toContain('Email (lúc chốt)')
    expect(JSON.stringify(pay)).not.toContain('a@x.vn')
    expect(pay[pay.length - 1]).toEqual(['', 'Tổng trong phạm vi của bạn', '', '', 30000])
    expect(JSON.stringify(rowsOf(wb, 'Thong tin'))).toContain('KHÔNG chi trả')
    expect(buildCmsPayoutWorkbook({ program: PROG, payout: parseCmsPayout(payoutRaw('sm')), exportedAt: new Date(), scope: 'super' })).toEqual({ ok: false, error: 'SCOPE_MISMATCH' })
    const tampered = parseCmsPayout(payoutRaw('sm'))
    tampered.rows[0].amountVnd = '1'
    expect(buildCmsPayoutWorkbook({ program: PROG, payout: tampered, exportedAt: new Date(), scope: 'sm' })).toEqual({ ok: false, error: 'TOTAL_MISMATCH' })
    expect(buildCmsPayoutWorkbook({ program: { ...PROG, id: uid(77) }, payout: parseCmsPayout(payoutRaw('sm')), exportedAt: new Date(), scope: 'sm' })).toEqual({ ok: false, error: 'PROGRAM_MISMATCH' })
  })

  test('handler: thứ tự cổng (401 / 403 cờ hoặc vai / 400 / 404 / 409 chưa chốt / 409 run ghim lệch) và 200 có file', async () => {
    const mk = (o: Partial<CmsPayoutExportDeps> = {}): CmsPayoutExportDeps => ({
      session: async () => ({ userId: ACTOR, role: 'admin', email: 'super@x.vn' }),
      lockEnabled: () => true,
      access: () => ({ view: true, manage: true }),
      program: async () => ({ ok: true, data: PROG }),
      payout: async () => ({ ok: true, data: parseCmsPayout(payoutRaw('super')) }),
      now: () => new Date('2026-11-03T03:00:00Z'),
      ...o,
    })
    const url = (q: string) => new Request(`http://localhost/api/export/cms/payout?${q}`)
    const cases: Array<[Partial<CmsPayoutExportDeps>, string, number, string]> = [
      [{ session: async () => null }, `program=${P}`, 401, 'UNAUTHENTICATED'],
      [{ lockEnabled: () => false }, `program=${P}`, 403, 'FORBIDDEN'],
      [{ access: () => ({ view: false, manage: false }) }, `program=${P}`, 403, 'FORBIDDEN'],
      [{}, 'program=abc', 400, 'BAD_REQUEST'],
      [{}, `program=${P}&run=x`, 400, 'BAD_REQUEST'],
      [{ program: async () => ({ ok: true, data: null }) }, `program=${P}`, 404, 'NOT_FOUND'],
      [{ payout: async () => ({ ok: false, error: 'NOT_LOCKED' }) }, `program=${P}`, 409, 'NOT_LOCKED'],
      [{ payout: async () => ({ ok: false, error: 'FORBIDDEN' }) }, `program=${P}`, 404, 'NOT_FOUND'],
      [{}, `program=${P}&run=${R2}`, 409, 'RUN_CHANGED'],
    ]
    for (const [o, q, status, code] of cases) {
      const res = await handleCmsPayoutExport(url(q), mk(o))
      expect([res.status, (await res.json()).error], `${code}`).toEqual([status, code])
    }
    const ok = await handleCmsPayoutExport(url(`program=${P}&run=${R}`), mk())
    expect(ok.status).toBe(200)
    expect(ok.headers.get('Content-Disposition')).toMatch(/cms-chi-tra-00000000-/)
  })
})

test.describe('CMS P3a — fixture UI qua parser DTO thật @desktop', () => {
  test('preview / payout fixture dựng qua parseCmsLockPreview / parseCmsPayout; tổng chốt = Σ kết quả giả cùng run; SM không email / không tổng toàn chương trình', async () => {
    const F = await import('../lib/cms/fixturesPayout')
    const R = await import('../lib/cms/fixturesResults')
    const PID = '00000000-0000-4000-8000-000000000001'
    // CMS-UI-1: Chốt kỳ ⇒ PG8 (QA hết kỳ), Số đã chốt ⇒ PG9 (QA đã chốt) — số = Σ kết quả engine CÙNG chương trình.
    const sum = (viewer: 'super' | 'sm', program = F.cmsFxP3Program('ready')) => {
      const r = R.cmsFxAdminResults('running', viewer, program)
      if (r.kind !== 'loaded') throw new Error('fx')
      return r.rows.results.reduce((a, x) => a + BigInt(x.amountVnd), BigInt(0)).toString()
    }
    void PID
    const ready = F.cmsFxLockPreview('ready')!
    expect(ready.blockers).toEqual([])
    expect(ready.needsAck).toBe(false)
    expect(ready.amountVnd).toBe(sum('super'))
    expect(ready.policy.label).toBe('QA_ONLY_ASSUMPTION')
    expect(F.cmsFxLockPreview('ack')).toMatchObject({ needsAck: true, unassignedLines: 8, blockers: [] }) // 8 = totals engine của run PG8
    expect(F.cmsFxLockPreview('blocked')?.blockers).toEqual(['CMS_LOCK_RUN_CHANGED', 'CMS_LOCK_UNASSIGNED_OVER'])
    expect(F.cmsFxLockPreview('pending')).toMatchObject({ isTest: false, blockers: ['CMS_LOCK_POLICY_PENDING'], policy: { ready: false, label: null } })
    expect(F.cmsFxLockPreview('error')).toBeNull()
    const sup = F.cmsFxPayout('locked')!
    const P9 = F.cmsFxP3Program('locked')
    expect(sup).toMatchObject({ viewer: 'super', programTotal: sum('super', P9), scopeTotal: sum('super', P9), isTest: true })
    expect(sup.rows.every((r) => r.email !== null)).toBe(true)
    const sm = F.cmsFxPayout('locked-sm')!
    expect(sm).toMatchObject({ viewer: 'sm', programTotal: null, scopeTotal: sum('sm', P9), super: null })
    expect(sm.rows.every((r) => r.email === null)).toBe(true)
    expect(sm.rows.length).toBeLessThan(sup.rows.length)
    expect(F.cmsFxPayout('locked-error')).toBeNull()
    expect(F.cmsFxParseP3('locked-sm')).toBe('locked-sm')
    expect(F.cmsFxParseP3('x')).toBeNull()
  })
})

test.describe('CMS P3a r2 — wiring server action chốt (module thật) @desktop', () => {
  test('server QA từ chối chốt trước RPC; app thường chốt; revalidate lỗi sau commit không thành lỗi (scripts/qa-cms-lock-wiring.mjs)', async () => {
    const { spawnSync } = await import('node:child_process')
    const path = await import('node:path')
    const r = spawnSync(process.execPath, [path.resolve(__dirname, '..', 'scripts', 'qa-cms-lock-wiring.mjs')], { encoding: 'utf8', timeout: 110_000 })
    const out = `${r.stdout}\n${r.stderr}`
    expect(out, out.slice(-2000)).toMatch(/\n\d+ đạt · 0 lỗi/)
    expect(r.status).toBe(0)
  })
})

test.describe('CMS P3a r2 — luồng hộp chốt phía trình duyệt (lib/cms/lockFlow, PM r1 PKG-P1-3) @desktop', () => {
  const PV = { ok: true as const, preview: { programId: P } as never }
  const IN = { programId: P, expectedRunId: R, expectedPolicyVersion: 1, ackReason: null }
  const io = (lock: () => Promise<unknown>, preview: () => Promise<unknown> = async () => PV) => {
    const calls = { lock: 0, preview: 0 }
    return {
      calls,
      io: {
        lock: async () => { calls.lock++; return lock() as never },
        preview: async () => { calls.preview++; return preview() as never },
      },
    }
  }
  test('chốt: ok / already ⇒ locked; UNKNOWN_OUTCOME và Promise REJECT (mất phản hồi) ⇒ unknown — không bao giờ "chưa chốt", không gọi lại', async () => {
    const { cmsLockConfirmFlow } = await import('../lib/cms/lockFlow')
    expect(await cmsLockConfirmFlow(io(async () => ({ ok: true, already: false, programId: P, runId: R, amountVnd: '1', policyVersion: 1 })).io, IN)).toEqual({ kind: 'locked', already: false })
    expect(await cmsLockConfirmFlow(io(async () => ({ ok: true, already: true, programId: P, runId: R, amountVnd: '1', policyVersion: 1 })).io, IN)).toEqual({ kind: 'locked', already: true })
    for (const lock of [async () => ({ ok: false, code: 'UNKNOWN_OUTCOME' }), async () => { throw new TypeError('Failed to fetch') }, () => Promise.reject(new Error('An unexpected response was received from the server.'))]) {
      const x = io(lock)
      const o = await cmsLockConfirmFlow(x.io, IN)
      expect(o.kind).toBe('unknown')
      if (o.kind === 'unknown') expect(o.notice).toMatch(/Chưa xác định được kết quả chốt/)
      expect(x.calls).toEqual({ lock: 1, preview: 0 })
    }
  })
  test('RECHECK (run / quy tắc / mapping đổi) ⇒ tải preview mới; tải lỗi hoặc REJECT ⇒ không có preview (UI khoá nút); mã khác ⇒ lỗi xác định', async () => {
    const { cmsLockConfirmFlow, CMS_LOCK_RECHECK_CODES } = await import('../lib/cms/lockFlow')
    for (const code of CMS_LOCK_RECHECK_CODES) {
      const ok = io(async () => ({ ok: false, code }))
      const o = await cmsLockConfirmFlow(ok.io, IN)
      expect(o.kind === 'recheck' && o.reload.preview !== null && o.reload.error === null, code).toBe(true)
      expect(ok.calls).toEqual({ lock: 1, preview: 1 })
    }
    const failRead = await cmsLockConfirmFlow(io(async () => ({ ok: false, code: 'CMS_LOCK_RUN_CHANGED' }), async () => ({ ok: false, code: 'QUERY_FAILED' })).io, IN)
    expect(failRead.kind === 'recheck' && failRead.reload.preview === null && /Không tải được/.test(failRead.reload.error ?? '')).toBe(true)
    const rejRead = await cmsLockConfirmFlow(io(async () => ({ ok: false, code: 'CMS_LOCK_POLICY_CHANGED' }), () => Promise.reject(new Error('network'))).io, IN)
    expect(rejRead.kind === 'recheck' && rejRead.reload.preview === null).toBe(true)
    for (const code of ['CMS_LOCK_ACK_REQUIRED', 'BUSY', 'QUERY_FAILED', 'FORBIDDEN', 'QA_SERVER_READONLY', 'CMS_PROGRAM_LOCKED']) {
      const x = io(async () => ({ ok: false, code }))
      const o = await cmsLockConfirmFlow(x.io, IN)
      expect(o.kind, code).toBe('error')
      expect(x.calls.preview, code).toBe(0)
    }
  })
  test('"Kiểm tra lại": ok ⇒ preview mới; lỗi / REJECT ⇒ lỗi đọc, không preview', async () => {
    const { cmsLockReloadFlow } = await import('../lib/cms/lockFlow')
    expect((await cmsLockReloadFlow({ preview: async () => PV as never }, P)).preview).not.toBeNull()
    expect(await cmsLockReloadFlow({ preview: async () => ({ ok: false, code: 'FORBIDDEN' }) as never }, P)).toEqual({ preview: null, error: 'Chỉ super admin được chốt kỳ' })
    expect((await cmsLockReloadFlow({ preview: () => Promise.reject(new Error('x')) }, P)).preview).toBeNull()
  })
  test('nguồn CmsLockPanel: mọi lời gọi action đi qua lockFlow (không await action trần ngoài try)', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'components', 'cms', 'admin', 'CmsLockPanel.tsx'), 'utf8')
    expect(src).not.toMatch(/await\s+(lockCmsProgram|previewCmsLock)\s*\(/)
    expect(src).toMatch(/cmsLockConfirmFlow\(io, input\)/)
    expect(src).toMatch(/cmsLockReloadFlow\(io, programId\)/)
    expect(src).toMatch(/data-cms-lock-check/)
  })
})

test.describe('CMS P3a r2 — lối đọc sau hết kỳ / đã chốt cho staff / QLCH (PM r1 PKG-P1-1) + lọc SM (Q-219) @desktop', () => {
  test('nhóm bộ chọn + chọn mặc định: đang chạy → sắp diễn ra → đã kết thúc gần nhất; Chờ chốt kỳ / Đã chốt không bị giấu', async () => {
    const SV = await import('../lib/cms/staffView')
    const FX = await import('../lib/cms/fixturesStaff')
    const T = FX.CMS_FX_TODAY
    const [p1, p2, p3] = FX.CMS_FX_STAFF_PROGRAMS
    const [ended, locked] = FX.CMS_FX_STAFF_ENDED
    const all = [locked, p3, ended, p2, p1]
    const g = SV.cmsGroupStaffPrograms(all, T)
    expect(g.current.map((p) => p.id)).toEqual([p1.id, p2.id, p3.id])
    expect(g.ended.map((p) => p.id)).toEqual([ended.id, locked.id]) // kết thúc gần nhất trước
    expect(SV.cmsPickStaffProgram(all, T, null)?.id).toBe(p1.id)
    expect(SV.cmsPickStaffProgram([locked, ended], T, null)?.id).toBe(ended.id) // hết kỳ vẫn có lối vào
    expect(SV.cmsPickStaffProgram([locked], T, null)?.id).toBe(locked.id)
    expect(SV.cmsPickStaffProgram(all, T, locked.id)?.id).toBe(locked.id) // deep link ?program= (quyền do RLS phiên)
    expect(SV.cmsIsClosedDisplay('waiting_close') && SV.cmsIsClosedDisplay('locked') && !SV.cmsIsClosedDisplay('running')).toBe(true)
  })
  test('nhãn theo trạng thái: tạm tính · chờ chốt · đã chốt (run đóng băng)', async () => {
    const SV = await import('../lib/cms/staffView')
    expect(SV.cmsStaffAmountTitle('running', 'own')).toBe('CMS tạm tính của bạn')
    expect(SV.cmsStaffAmountTitle('waiting_close', 'store')).toBe('CMS tạm tính của nhà thuốc')
    expect(SV.cmsStaffAmountTitle('locked', 'own')).toBe('CMS đã chốt của bạn')
    expect(SV.cmsStaffAmountTitle('locked', 'store')).toBe('CMS đã chốt của nhà thuốc')
    expect(SV.cmsStaffAmountTitle('locked', 'product')).toBe('CMS đã chốt')
    const at = '2026-11-15T01:05:00Z'
    expect(SV.cmsStaffUpdatedText('running', at)).toBe('Cập nhật 15/11/2026 08:05 · chưa chốt kỳ')
    expect(SV.cmsStaffUpdatedText('waiting_close', at)).toMatch(/chờ chốt kỳ — số tạm tính/)
    expect(SV.cmsStaffUpdatedText('locked', at)).toBe('Đã chốt kỳ · số theo lần tính 15/11/2026 08:05 (không đổi sau chốt)')
  })
  test('nguồn loader: D1 / D2 / D3 đọc active + locked qua SESSION (RLS — không nới vai, không service role); SM có lọc Đã chốt', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const read = (f: string) => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8')
    const sc = read('lib/cms/server/staffCatalog.ts')
    expect(sc).toContain(".in('status', [...CMS_STAFF_PROGRAM_STATUSES]).order('start_date')")
    expect(sc).not.toContain('supabaseAdmin')
    const rl = read('lib/cms/server/resultLoad.ts')
    expect(rl).toContain(".in('status', ['active', 'locked']).lte('start_date', today)")
    const { cmsStatusesFor } = await import('../lib/cms/programStatus')
    expect(cmsStatusesFor(false)).toEqual(['running', 'upcoming', 'waiting_close', 'locked'])
    expect(cmsStatusesFor(true)).toContain('draft')
  })
})
