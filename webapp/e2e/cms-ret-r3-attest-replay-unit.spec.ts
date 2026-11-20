import { test, expect } from '@playwright/test'
import * as A from './cmsSourceAttest'

// CMS returns r3 — PM 20/11 `planning/reviews/2026-11-20-cms-returns-r2-audit-pm.md` §4.1.3: CLI gọi lại `already` (cùng --idem + cùng
// nội dung) phải đọc / đánh giá hiệu lực HIỆN TẠI; chứng nhận đã chết ⇒ sổ `already_dead`, rc ≠ 0, không ghi `done`; hiệu lực không xác
// định cũng không báo thành công. Phần THUẦN (không DB): phản hồi RPC → live; dòng hiệu lực (pg-meta chỉ đọc: còn sống / run hiện hành /
// cms__attest_eval) → phán quyết; sổ `already_dead` parse / không treo reconcile. Chuỗi CLI thật qua shim HTTP trên PGlite:
// scripts/qa-cms-124.mjs §7r3 (thu hồi / còn hiệu lực / hết hạn / cấu hình đổi / mất kết nối / bị thay / run đổi trong lúc gọi / trước khi gọi).

const RUN = '11111111-1111-4111-8111-111111111111'
const RUN2 = '66666666-6666-4666-8666-666666666666'
const ATT = '22222222-2222-4222-8222-222222222222'
const ATT2 = '33333333-3333-4333-8333-333333333333'
const PROG = '77777777-7777-4777-8777-777777777777'
const replyOf = (live: boolean | null) => ({ id: ATT, live })
const rowOf = (o: Partial<A.CmsAttestValidityRow> = {}): A.CmsAttestValidityRow =>
  ({ id: ATT, runId: RUN, live: true, currentRunId: RUN, eval: { id: ATT, code: null, scope_to: '2026-11-30' }, ...o })

test.describe('r3 — CLI gọi lại already: phản hồi + hiệu lực hiện tại @desktop', () => {
  test('phản hồi attest phải mang live (boolean); revoke không cần', () => {
    const base = { attested: true, already: true, id: ATT, run_id: RUN }
    expect(A.cmsAttestCheckReply('attest', { ...base, live: true }, { runId: RUN })).toEqual({ ok: true, id: ATT, already: true, live: true })
    expect(A.cmsAttestCheckReply('attest', { ...base, live: false }, { runId: RUN })).toEqual({ ok: true, id: ATT, already: true, live: false })
    for (const live of [undefined, null, 'true', 1]) {
      expect(A.cmsAttestCheckReply('attest', { ...base, live }, { runId: RUN })).toEqual({ ok: false })
    }
    expect(A.cmsAttestCheckReply('revoke', { revoked: true, already: false, id: ATT }, { attestationId: ATT })).toEqual({ ok: true, id: ATT, already: false, live: null })
  })

  test('còn hiệu lực: sống + run hiện hành + eval đúng id, code NULL ⇒ done', () => {
    expect(A.cmsAttestReplayVerdict(replyOf(true), rowOf())).toEqual({ status: 'done' })
  })

  test('đã thu hồi / đã bị thay ⇒ already_dead ATTEST_NOT_LIVE (phản hồi live false, hoặc dòng đọc lại không còn sống)', () => {
    expect(A.cmsAttestReplayVerdict(replyOf(false), null)).toEqual({ status: 'already_dead', code: 'ATTEST_NOT_LIVE' })
    expect(A.cmsAttestReplayVerdict(replyOf(false), rowOf())).toEqual({ status: 'already_dead', code: 'ATTEST_NOT_LIVE' })
    expect(A.cmsAttestReplayVerdict(replyOf(true), rowOf({ live: false, eval: null }))).toEqual({ status: 'already_dead', code: 'ATTEST_NOT_LIVE' })
  })

  test('hết hạn / cấu hình / mapping / phạm vi / số dòng / vân tay đổi (mã eval) ⇒ already_dead ATTEST_<mã>', () => {
    for (const code of ['AS_OF', 'STALE_CONFIG', 'STALE_SCOPE', 'STALE_MAPPING', 'FP_CHANGED', 'COUNT', 'FIELD_SET_BASIS', 'UNIT_SRC_ENGINE', 'SOURCE_SCOPE']) {
      expect(A.cmsAttestReplayVerdict(replyOf(true), rowOf({ eval: { id: ATT, code } }))).toEqual({ status: 'already_dead', code: `ATTEST_${code}` })
    }
  })

  test('run hiện hành đã đổi / chương trình không còn run ⇒ already_dead ATTEST_NOT_CURRENT', () => {
    expect(A.cmsAttestReplayVerdict(replyOf(true), rowOf({ currentRunId: RUN2, eval: null }))).toEqual({ status: 'already_dead', code: 'ATTEST_NOT_CURRENT' })
    expect(A.cmsAttestReplayVerdict(replyOf(true), rowOf({ currentRunId: null, eval: null }))).toEqual({ status: 'already_dead', code: 'ATTEST_NOT_CURRENT' })
  })

  test('mất kết nối / không thấy dòng / dạng lạ / mâu thuẫn / thiếu live ⇒ unknown VALIDITY_UNKNOWN (không báo thành công)', () => {
    const U = { status: 'unknown', code: 'VALIDITY_UNKNOWN' }
    expect(A.cmsAttestReplayVerdict(replyOf(true), null)).toEqual(U)
    expect(A.cmsAttestReplayVerdict(replyOf(null), rowOf())).toEqual(U)
    expect(A.cmsAttestReplayVerdict(replyOf(true), rowOf({ id: ATT2 }))).toEqual(U)
    for (const ev of [null, 'x', { code: 'NONE' }, { id: ATT2, code: null }, { id: ATT, code: 'thường' }, { id: ATT }]) {
      expect(A.cmsAttestReplayVerdict(replyOf(true), rowOf({ eval: ev }))).toEqual(U)
    }
  })

  test('dòng pg-meta: parse chặt (UUID / boolean / eval jsonb hoặc chuỗi JSON); sai ⇒ null', () => {
    const raw = { id: ATT, run_id: RUN, live: true, current_run_id: RUN, eval: { id: ATT, code: null } }
    expect(A.parseCmsAttestValidityRow(raw)).toEqual(rowOf({ eval: { id: ATT, code: null } }))
    expect(A.parseCmsAttestValidityRow({ ...raw, eval: JSON.stringify({ id: ATT, code: 'AS_OF' }) })?.eval).toEqual({ id: ATT, code: 'AS_OF' })
    expect(A.parseCmsAttestValidityRow({ ...raw, current_run_id: null, eval: null })).toEqual(rowOf({ currentRunId: null, eval: null }))
    for (const bad of [undefined, null, 'x', { ...raw, id: 'x' }, { ...raw, run_id: null }, { ...raw, live: 'true' }, { ...raw, current_run_id: 'x' }, { ...raw, eval: '{' }]) {
      expect(A.parseCmsAttestValidityRow(bad)).toBeNull()
    }
  })

  test('SQL hiệu lực: chỉ đọc, UUID kiểm trước khi chèn', () => {
    const q = A.cmsAttestValiditySql(PROG, ATT)
    expect(q).toContain(`a.id = '${ATT}' AND a.program_id = '${PROG}'`)
    expect(q).toContain('public.cms__attest_eval(p.id, a.run_id)')
    expect(q).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|GRANT)\b/i)
    expect(() => A.cmsAttestValiditySql("x' OR true --", ATT)).toThrow()
    expect(() => A.cmsAttestValiditySql(PROG, 'x')).toThrow()
  })
})

test.describe('r3 — sổ already_dead @desktop', () => {
  const op = (o: Record<string, unknown> = {}) => JSON.stringify({ kind: 'cms-source-attest-op', version: 1, operationId: 'a-0123456789ab', op: 'attest',
    qaRunId: null, host: 'db.example', pid: 42, programId: ATT2, runId: RUN, attestationId: null, idemKey: '44444444-4444-4444-8444-444444444444',
    payloadSha256: 'a'.repeat(64), actorId: '55555555-5555-4555-8555-555555555555', startedAt: '2026-11-20T10:00:00.000Z',
    status: 'already_dead', finishedAt: '2026-11-20T10:00:01.000Z', result: { code: 'ATTEST_NOT_LIVE', attestationId: ATT, already: true }, ...o })

  test('parse nhận already_dead đúng dạng; sai dạng ⇒ hỏng (không đoán)', () => {
    expect(A.parseCmsAttestOp(op()).ok).toBe(true)
    expect(A.parseCmsAttestOp(op({ result: null })).ok).toBe(false)
    expect(A.parseCmsAttestOp(op({ op: 'revoke' })).ok).toBe(false)
    expect(A.parseCmsAttestOp(op({ result: { code: 'ATTEST_NOT_LIVE', attestationId: ATT, already: false } })).ok).toBe(false)
    expect(A.parseCmsAttestOp(op({ result: { code: null, attestationId: ATT, already: true } })).ok).toBe(false)
  })

  test('already_dead đã khép: không chặn thao tác mới, không cần reconcile, không tính là đã ghi chứng nhận', () => {
    const p = A.parseCmsAttestOp(op())
    if (!p.ok) throw new Error(p.reason)
    expect(A.cmsAttestPendingOps([p.value], ATT2)).toEqual([])
    expect(A.cmsAttestOpLanded(p.value)).toBeNull()
    const c = A.cmsAttestReconcileCheck(p.value, [], { nowMs: Date.now(), pidAlive: false, probe: { can_see_all: true, hidden: 0, inflight: 0 } })
    expect(c.ok).toBe(false)
    expect(c.ok ? '' : c.reason).toMatch(/đã có kết quả \(already_dead\)/)
  })
})
