import { test, expect } from '@playwright/test'
import * as T from './cmsQaTooling'
import type { CmsQaContinuationDonor, CmsQaContinuationRow, CmsQaRunManifest } from './cmsQaTooling'

// CMS P4-B (PM 22/11 `planning/reviews/2026-11-22-cms-qa-window1-result-next-pm.md` §4) — spec THUẦN cho đường tiếp tục từ archive
// ĐÃ ĐÓNG: tham số CLI, kiểm archive donor, kiểm trạng thái DB hiện tại, manifest cửa sổ mới. Không mạng, không DB. Phần tiến trình
// CLI thật trên DB cô lập: selftest-p4b-continue.mjs (ngoài Git).

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const PA = uid(1), PB = uid(2), REALP = uid(3), SUPER = uid(24), STAFF = uid(21), OTHER = uid(31)
const RA1 = uid(101), RA2 = uid(102), RB1 = uid(103)
const DONOR = 'cms-qa-20261122T043819-36c6', NEWRUN = 'cms-qa-20261122T090000-ab12'
const SHA = 'e'.repeat(64)
const HOST = 'db.example.test'
const STARTED = '2026-11-22T04:38:19.737Z', CLOSED = '2026-11-22T06:19:51.788Z'

function donorObj(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'cms-qa-run', version: 1, runId: DONOR, status: 'closed', mode: 'manual-headless', host: HOST, startedAt: STARTED, closedAt: CLOSED,
    gitHead: 'a'.repeat(40), gitTree: 'b'.repeat(40), buildId: null, port: null, serverPid: null, launcherPid: 4241, headless: { nonce: 'c'.repeat(32) }, lockUi: false,
    users: [{ id: SUPER, role: 'admin', markerExpiresAt: '2026-11-22T07:00:00.000Z' }, { id: STAFF, role: 'staff', markerExpiresAt: '2026-11-22T07:00:00.000Z' }],
    programs: [{ id: PA, status: 'active', isTest: true }, { id: PB, status: 'active', isTest: true }],
    closeCheck: { realProgramsTouchedByQaUsers: [], realProgramsChangedByOthers: [], markerActiveAtClose: [] },
    salesRuns: [], locks: [], payouts: [], attests: [], exports: [], closeReports: [],
    writers: [
      { writerId: 'w-0e39534ad568', programId: PA, status: 'done', runId: RA1, code: null },
      { writerId: 'w-8156237d314b', programId: PA, status: 'done', runId: RA2, code: null },
      { writerId: 'w-293a361b43c6', programId: PB, status: 'done', runId: RB1, code: null },
    ],
    ...over,
  }
}
const WANT = { runId: DONOR, sha256: SHA, programIds: [PA, PB] }
const check = (over: Record<string, unknown> = {}, i: Partial<Parameters<typeof T.cmsQaContinuationDonorCheck>[0]> = {}) =>
  T.cmsQaContinuationDonorCheck({ want: WANT, text: JSON.stringify(donorObj(over)), fileSha256: SHA, host: HOST, userIds: [STAFF, SUPER], ...i })
const reason = (r: { ok: boolean; reason?: string }) => (r.ok ? '' : String(r.reason))
const DONOR_OK: CmsQaContinuationDonor = { runId: DONOR, sha256: SHA, startedAt: STARTED, closedAt: CLOSED, programIds: [PA, PB], runIdsByProgram: { [PA]: [RA1, RA2], [PB]: [RB1] } }

const run = (id: string, us: string, o: Record<string, unknown> = {}) => ({ id, status: 'ok', is_test: true, cv: 6, basis: 'pos_base', policy: 'full_line_qty_refund_v1', kind: 'sales', qa_run_id: DONOR, started_us: us, ...o })
function rows(overA: Partial<CmsQaContinuationRow> = {}, overB: Partial<CmsQaContinuationRow> = {}): CmsQaContinuationRow[] {
  const p = (id: string, cur: string, runs: unknown[]): CmsQaContinuationRow => ({ id, is_test: true, status: 'active', qa_created: true, created_in_donor: true, config_version: 6,
    quantity_basis: 'pos_base', returns_policy: 'full_line_qty_refund_v1', current_run_id: cur, running: 0, not_locked: true, unchanged_since_close: true, donor_runs: runs })
  return [{ ...p(PA, RA2, [run(RA1, '1000'), run(RA2, '2000')]), ...overA }, { ...p(PB, RB1, [run(RB1, '1500')]), ...overB }]
}
const dbReasons = (r: ReturnType<typeof T.cmsQaContinuationDbCheck>) => (r.ok ? [] : r.reasons)

function newManifest(over: Partial<CmsQaRunManifest> = {}): CmsQaRunManifest {
  return { kind: 'cms-qa-run', version: 1, runId: NEWRUN, status: 'open', mode: 'manual-headless', host: HOST, startedAt: '2026-11-22T09:00:00.000Z', gitHead: 'a'.repeat(40), gitTree: 'b'.repeat(40),
    buildId: null, port: null, serverPid: null, launcherPid: 5151, headless: { nonce: 'd'.repeat(32) },
    users: [{ id: SUPER, role: 'admin', markerExpiresAt: '2026-11-22T11:00:00.000Z' }], programs: [], ...over } as CmsQaRunManifest
}

test.describe('CMS P4-B · tham số đường tiếp tục @desktop', () => {
  const parse = (from?: string, sha?: string, programs?: string, headless = true) => T.parseCmsQaContinueArgs({ from, sha, programs, headless })
  test('không tham số ⇒ start thường; đủ ba ⇒ nhận (id sắp xếp)', () => {
    expect(parse()).toEqual({ ok: true, value: null })
    expect(parse(DONOR, SHA, `${PB},${PA}`)).toEqual({ ok: true, value: { runId: DONOR, sha256: SHA, programIds: [PA, PB] } })
  })
  test('thiếu một trong ba / không headless / runId là đường dẫn / hash sai dạng / UUID trùng, sai, quá 4 ⇒ từ chối', () => {
    expect(reason(parse(DONOR, SHA))).toMatch(/cần ĐỦ/)
    expect(reason(parse(DONOR, undefined, PA))).toMatch(/cần ĐỦ/)
    expect(reason(parse(undefined, SHA, PA))).toMatch(/cần ĐỦ/)
    expect(reason(parse(DONOR, SHA, PA, false))).toMatch(/chỉ dùng với --headless/)
    for (const bad of ['../../x', 'cms-qa-20261122T043819-36c6.json', 'C:/x', 'cms-qa-20261122T043819-36C6', '']) expect(reason(parse(bad, SHA, PA))).toMatch(/không phải runId/)
    for (const bad of ['E'.repeat(64), 'e'.repeat(63), 'e'.repeat(65), 'sha256:' + 'e'.repeat(57)]) expect(reason(parse(DONOR, bad, PA))).toMatch(/64 hex/)
    for (const bad of [`${PA},${PA}`, 'abc', '', `${PA},`, [uid(1), uid(2), uid(3), uid(4), uid(5)].join(',')]) expect(reason(parse(DONOR, SHA, bad))).toMatch(/--expect-programs/)
  })
})

test.describe('CMS P4-B · archive donor (thuần) @desktop', () => {
  test('donor đóng sạch, đúng hash / host / tài khoản / chương trình ⇒ nhận; run theo chương trình giữ thứ tự sổ', () => {
    const r = check()
    expect(r).toEqual({ ok: true, value: DONOR_OK })
  })
  test('sai hash ⇒ từ chối TRƯỚC khi parse (kể cả nội dung hợp lệ)', () => {
    expect(reason(check({}, { fileSha256: 'f'.repeat(64) }))).toMatch(/sha256 tệp khác/)
    expect(reason(T.cmsQaContinuationDonorCheck({ want: WANT, text: 'không phải JSON', fileSha256: 'f'.repeat(64), host: HOST, userIds: [SUPER, STAFF] }))).toMatch(/sha256 tệp khác/)
  })
  test('archive mở / thiếu closedAt / không parse được ⇒ từ chối', () => {
    expect(reason(check({ status: 'open' }))).toMatch(/chưa đóng/)
    expect(reason(check({ closedAt: null }))).toMatch(/chưa đóng/)
    expect(reason(check({ startedAt: CLOSED }))).toMatch(/mốc mở không trước mốc đóng/)
    expect(reason(check({ startedAt: '2026-11-22T07:00:00.000Z' }))).toMatch(/mốc mở không trước mốc đóng/)
    expect(reason(check({ serverNotStopped: { pid: null, at: CLOSED } }))).toMatch(/còn cờ server QA chưa dừng/)
    expect(reason(T.cmsQaContinuationDonorCheck({ want: WANT, text: '{', fileSha256: SHA, host: HOST, userIds: [SUPER, STAFF] }))).toMatch(/archive donor: manifest không phải JSON/)
  })
  test('runId trong tệp khác / host khác / không headless / đã là run tiếp tục ⇒ từ chối', () => {
    expect(reason(check({ runId: NEWRUN }))).toMatch(/runId trong tệp khác/)
    expect(reason(check({}, { host: 'khac.example.test' }))).toMatch(/khác host/)
    expect(reason(check({ mode: 'manual-localhost', headless: undefined, port: 3120 }))).toMatch(/không phải run headless/)
    expect(reason(check({ continuedFrom: { runId: 'cms-qa-20261121T000000-0000', sha256: SHA, programs: [PA], closedAt: CLOSED } }))).toMatch(/đã là run tiếp tục/)
  })
  test('bộ tài khoản QA khác (thiếu / thừa / khác) ⇒ từ chối', () => {
    for (const ids of [[SUPER], [SUPER, STAFF, OTHER], [SUPER, OTHER]]) expect(reason(check({}, { userIds: ids }))).toMatch(/bộ tài khoản QA khác/)
  })
  test('closeCheck thiếu / có chương trình thật bị QA chạm ⇒ từ chối', () => {
    expect(reason(check({ closeCheck: null }))).toMatch(/closeCheck không sạch/)
    expect(reason(check({ closeCheck: { realProgramsTouchedByQaUsers: [REALP] } }))).toMatch(/closeCheck không sạch/)
  })
  test('danh sách chương trình ≠ --expect-programs (thừa UUID ngoài donor / thiếu) hoặc mục không is_test ⇒ từ chối', () => {
    expect(reason(check({}, { want: { ...WANT, programIds: [PA, PB, REALP] } }))).toMatch(/danh sách chương trình khác/)
    expect(reason(check({}, { want: { ...WANT, programIds: [PA] } }))).toMatch(/danh sách chương trình khác/)
    expect(reason(check({ programs: [{ id: PA, status: 'active', isTest: true }, { id: PB, status: 'active', isTest: false }] }))).toMatch(/không đánh dấu is_test/)
  })
  test('donor đã có chốt / payout / báo cáo sau chốt ⇒ từ chối (chỉ nhận donor chưa chốt)', () => {
    expect(reason(check({ locks: [{ operationId: 'l-000000000001' }] }))).toMatch(/đã có locks/)
    expect(reason(check({ payouts: [{ id: uid(9) }] }))).toMatch(/đã có payouts/)
    expect(reason(check({ closeReports: [{ operationId: 'r-000000000001' }] }))).toMatch(/đã có closeReports/)
  })
  test('writer: rỗng / chưa done / thiếu run / ngoài danh sách / chương trình không có run ⇒ từ chối', () => {
    const w = (donorObj().writers as Record<string, unknown>[])
    expect(reason(check({ writers: [] }))).toMatch(/không có writer/)
    expect(reason(check({ writers: [{ ...w[0], status: 'unknown' }, w[1], w[2]] }))).toMatch(/chưa done/)
    expect(reason(check({ writers: [{ ...w[0], runId: null }, w[1], w[2]] }))).toMatch(/thiếu run/)
    expect(reason(check({ writers: [...w, { writerId: 'w-000000000000', programId: REALP, status: 'done', runId: uid(104), code: null }] }))).toMatch(/ngoài danh sách chương trình/)
    expect(reason(check({ writers: [w[0], w[1]] }))).toMatch(/chưa có run đã công bố/)
    expect(reason(check({ writers: [w[0], w[1], { ...w[2], runId: RA1 }] }))).toMatch(/một run xuất hiện ở hai writer/)
  })
})

test.describe('CMS P4-B · trạng thái DB hiện tại so với donor @desktop', () => {
  test('SQL: một SELECT, chỉ id donor + run donor + tài khoản QA + cửa sổ donor; không lệnh ghi', () => {
    const sql = T.cmsQaContinuationSql(DONOR_OK, [SUPER, STAFF])
    expect(sql.trim().startsWith('SELECT')).toBe(true)
    expect(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|GRANT|TRUNCATE)\b/i.test(sql)).toBe(false)
    expect(sql.includes(';')).toBe(false)
    for (const x of [PA, PB, RA1, RA2, RB1, SUPER, STAFF, STARTED, CLOSED]) expect(sql).toContain(x)
    expect(sql).not.toContain(REALP)
    expect(T.pgMetaReadOnly(sql)).toContain('READ ONLY')
  })
  test('khớp donor ⇒ đạt', () => {
    expect(T.cmsQaContinuationDbCheck(DONOR_OK, rows())).toEqual({ ok: true })
  })
  test('chương trình THẬT / mất khỏi DB / không active / không do QA tạo trong cửa sổ donor / đang có run chạy ⇒ chặn', () => {
    expect(dbReasons(T.cmsQaContinuationDbCheck(DONOR_OK, rows({ is_test: false }))).join()).toMatch(/chương trình THẬT/)
    expect(dbReasons(T.cmsQaContinuationDbCheck(DONOR_OK, rows().slice(0, 1))).join()).toMatch(/không còn trong DB/)
    expect(dbReasons(T.cmsQaContinuationDbCheck(DONOR_OK, rows({ status: 'draft' }))).join()).toMatch(/trạng thái draft/)
    expect(dbReasons(T.cmsQaContinuationDbCheck(DONOR_OK, rows({ qa_created: false }))).join()).toMatch(/không do tài khoản QA tạo/)
    expect(dbReasons(T.cmsQaContinuationDbCheck(DONOR_OK, rows({ created_in_donor: false }))).join()).toMatch(/không do tài khoản QA tạo/)
    for (const v of [1, null, '', '0', undefined]) expect(dbReasons(T.cmsQaContinuationDbCheck(DONOR_OK, rows({}, { running: v }))).join()).toMatch(/đang có run chạy/)
  })
  test('đã chốt / bị sửa sau khi donor đóng ⇒ chặn', () => {
    expect(dbReasons(T.cmsQaContinuationDbCheck(DONOR_OK, rows({}, { status: 'locked', not_locked: false }))).join()).toMatch(/trạng thái locked.*đã chốt kỳ|đã chốt kỳ/)
    expect(dbReasons(T.cmsQaContinuationDbCheck(DONOR_OK, rows({ unchanged_since_close: false }))).join()).toMatch(/bị sửa sau khi cửa sổ donor đóng/)
    expect(dbReasons(T.cmsQaContinuationDbCheck(DONOR_OK, rows({ unchanged_since_close: null }))).join()).toMatch(/bị sửa sau khi cửa sổ donor đóng/)
  })
  test('con trỏ ≠ run MỚI NHẤT donor (trỏ run cũ / run lạ / null) ⇒ chặn', () => {
    for (const cur of [RA1, uid(999), null]) expect(dbReasons(T.cmsQaContinuationDbCheck(DONOR_OK, rows({ current_run_id: cur }))).join()).toMatch(/con trỏ kết quả hiện tại không phải run mới nhất/)
  })
  test('cv / cách tính / policy hiện tại ≠ hợp đồng của run đã đối soát ⇒ chặn', () => {
    for (const o of [{ config_version: 7 }, { quantity_basis: 'cms_unit' }, { returns_policy: 'sales_only_v1' }]) {
      expect(dbReasons(T.cmsQaContinuationDbCheck(DONOR_OK, rows(o))).join()).toMatch(/cấu hình \/ cách tính \/ policy hiện tại khác/)
    }
  })
  test('KHÔNG so null với null: cv / cách tính / policy thiếu ở chương trình hoặc run ⇒ chặn', () => {
    const nullRun = [run(RA1, '1000'), run(RA2, '2000', { cv: null, basis: null, policy: null })]
    expect(dbReasons(T.cmsQaContinuationDbCheck(DONOR_OK, rows({ config_version: null, quantity_basis: null, returns_policy: null, donor_runs: nullRun }))).join()).toMatch(/thiếu cấu hình \/ cách tính \/ policy/)
    expect(dbReasons(T.cmsQaContinuationDbCheck(DONOR_OK, rows({ quantity_basis: null, donor_runs: [run(RA1, '1000'), run(RA2, '2000', { basis: null })] }))).join()).toMatch(/thiếu cấu hình/)
    expect(dbReasons(T.cmsQaContinuationDbCheck(DONOR_OK, rows({ returns_policy: '', donor_runs: [run(RA1, '1000'), run(RA2, '2000', { policy: '' })] }))).join()).toMatch(/thiếu cấu hình/)
    expect(dbReasons(T.cmsQaContinuationDbCheck(DONOR_OK, rows({ config_version: 0, donor_runs: [run(RA1, '1000'), run(RA2, '2000', { cv: 0 })] }))).join()).toMatch(/thiếu cấu hình/)
  })
  test('run donor: thiếu trong DB / không ok / không is_test / sai kind / sai tag run ⇒ chặn', () => {
    expect(dbReasons(T.cmsQaContinuationDbCheck(DONOR_OK, rows({ donor_runs: [run(RA2, '2000')] }))).join()).toMatch(/không đọc đủ run donor/)
    expect(dbReasons(T.cmsQaContinuationDbCheck(DONOR_OK, rows({ donor_runs: 'x' }))).join()).toMatch(/không đọc đủ run donor/)
    for (const o of [{ status: 'error' }, { is_test: false }, { kind: 'engine' }, { qa_run_id: NEWRUN }, { qa_run_id: null }, { started_us: 'abc' }]) {
      expect(dbReasons(T.cmsQaContinuationDbCheck(DONOR_OK, rows({ donor_runs: [run(RA1, '1000'), run(RA2, '2000', o)] }))).join()).toMatch(/không còn ok \/ is_test \/ đúng tag run donor/)
    }
  })
  test('lệch ở chương trình này không che chương trình kia (báo đủ cả hai)', () => {
    const rs = dbReasons(T.cmsQaContinuationDbCheck(DONOR_OK, rows({ config_version: 7 }, { current_run_id: null })))
    expect(rs.some((x) => x.startsWith(T.maskCmsUuid(PA)))).toBe(true)
    expect(rs.some((x) => x.startsWith(T.maskCmsUuid(PB)))).toBe(true)
  })
})

test.describe('CMS P4-B · manifest cửa sổ mới @desktop', () => {
  test('nhận đúng chương trình donor (adopted), ghi continuedFrom; runId / startedAt / pid / nonce của manifest MỚI giữ nguyên', () => {
    const m = newManifest()
    const out = T.cmsQaManifestContinue(m, DONOR_OK)
    expect(out.programs).toEqual([{ id: PA, status: 'adopted', isTest: true }, { id: PB, status: 'adopted', isTest: true }])
    expect(out.continuedFrom).toEqual({ runId: DONOR, sha256: SHA, programs: [PA, PB], closedAt: CLOSED })
    expect([out.runId, out.startedAt, out.launcherPid, out.headless?.nonce]).toEqual([NEWRUN, m.startedAt, 5151, 'd'.repeat(32)])
    expect(m.programs).toEqual([])
    const back = T.parseCmsQaManifest(JSON.stringify(out))
    expect(back.ok && back.value.continuedFrom?.runId).toBe(DONOR)
  })
  test('lùi / trùng mốc đóng donor, trùng runId, manifest đã có chương trình / đã đóng / không headless ⇒ ném lỗi', () => {
    expect(() => T.cmsQaManifestContinue(newManifest({ startedAt: CLOSED }), DONOR_OK)).toThrow(/SAU mốc đóng donor/)
    expect(() => T.cmsQaManifestContinue(newManifest({ startedAt: STARTED }), DONOR_OK)).toThrow(/SAU mốc đóng donor/)
    expect(() => T.cmsQaManifestContinue(newManifest({ runId: DONOR }), DONOR_OK)).toThrow(/trùng runId donor/)
    expect(() => T.cmsQaManifestContinue(newManifest({ programs: [{ id: PA, status: 'created', isTest: true }] }), DONOR_OK)).toThrow(/chưa có chương trình/)
    expect(() => T.cmsQaManifestContinue(newManifest({ status: 'closed' }), DONOR_OK)).toThrow(/manifest mới mở/)
    expect(() => T.cmsQaManifestContinue(newManifest({ mode: 'manual-localhost', headless: undefined }), DONOR_OK)).toThrow(/chỉ cho run headless/)
  })
  test('close KHÔNG đổi gì: chương trình nhận không nằm trong truy vấn "đổi trong cửa sổ" vẫn được giữ trong archive, không đỏ', () => {
    const m = T.cmsQaManifestContinue(newManifest(), DONOR_OK)
    const c = T.cmsQaCloseCheck(m, [], [], [{ id: PA, is_test: true }, { id: PB, is_test: true }])
    expect(c.reasons).toEqual([])
    expect(c.closed.programs.map((p) => p.id)).toEqual([PA, PB])
    expect((c.closed as CmsQaRunManifest).continuedFrom?.sha256).toBe(SHA)
  })
  test('close: chương trình nhận nay là THẬT / mất khỏi DB ⇒ đỏ', () => {
    const m = T.cmsQaManifestContinue(newManifest(), DONOR_OK)
    expect(T.cmsQaCloseCheck(m, [], [], [{ id: PA, is_test: false }, { id: PB, is_test: true }]).reasons.join()).toMatch(/chương trình THẬT/)
    expect(T.cmsQaCloseCheck(m, [], [], [{ id: PA, is_test: true }]).reasons.join()).toMatch(/không còn trong DB/)
  })
})
