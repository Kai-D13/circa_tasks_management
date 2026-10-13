import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, expect } from '@playwright/test'
import {
  CARE_STATUS_FILTERS, CARE_TRANSFER_MESSAGES, applyCareTaskFilters, careFilterHref, careNavItems,
  careOutcomeDistribution, carePermissions, careReportByStore, careReportTotals, careSearchTerm, careTaskState,
  isPastPeriod, mapCareTransferError, parseCareFilters, recentCarePeriods, validateTransferInput, careSafeImageUrl, CARE_OUTCOME_KEYS,
  careInteractionPage, CARE_INTERACTION_PAGE_SIZE, CARE_EXCLUDED_ROLES,
  careStatusChipTabs, careApptHint, careShortDateTime, careTransferConflicts, careOpenLoadByAssignee, parseCareOpenParam,
  careCurrentProductCount, CARE_STATUS_CHIP_LABELS,
  type CareAccess, type CareQueryBuilder, type CareReportRow, type CareTotals,
} from '../lib/care/browse'
import { buildCareImportRows } from './careImportFixture'

// CRM-CSKH B3 — browser Khách hàng/Chăm sóc + chuyển giao.
// (1) Unit thuần lib/care/browse.ts · (2) source: cờ trước tiên, session/RPC
// (không service role), FK embed tường minh · (3) PGlite 114: quyền từ
// care_my_access(), filter app chỉ THU HẸP RLS, thẻ (care_report) = trạng thái
// tính từ dòng đọc bằng session, phân trang không lặp/mất, map lỗi RAISE thật của
// care__transfer_tasks_at. Chưa phải QA DB thật — ma trận quyền/race trên prod ở B6.

const ROOT = path.resolve(__dirname, '..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n') // chịu checkout CRLF (Windows)
const HAS_PGLITE = fs.existsSync(path.join(ROOT, 'node_modules', '@electric-sql', 'pglite'))
const S = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const acc = (o: Partial<CareAccess>): CareAccess =>
  ({ role: null, is_super: false, can_import: false, can_view_all: false, scope_store_count: 0, ...o })

test.describe('care B3 — logic thuần @desktop', () => {
  test('quyền: can_import KHÔNG mở view/transfer; SM theo scope; QLCH/staff/FS không có browser', () => {
    expect(carePermissions(null)).toEqual({ canView: false, canViewAll: false, canTransfer: false, canImport: false })
    expect(carePermissions(acc({ role: 'admin', is_super: true, can_import: true, can_view_all: true })))
      .toEqual({ canView: true, canViewAll: true, canTransfer: true, canImport: true })
    // Marketing: import + view_all (seed Q-22) nhưng không chuyển giao.
    expect(carePermissions(acc({ role: 'admin', can_import: true, can_view_all: true })))
      .toEqual({ canView: true, canViewAll: true, canTransfer: false, canImport: true })
    // Phòng chỉ được cấp import.
    expect(carePermissions(acc({ role: 'admin', can_import: true })))
      .toEqual({ canView: false, canViewAll: false, canTransfer: false, canImport: true })
    expect(carePermissions(acc({ role: 'sm', scope_store_count: 2 })))
      .toEqual({ canView: true, canViewAll: false, canTransfer: true, canImport: false })
    expect(carePermissions(acc({ role: 'sm', scope_store_count: 0 })).canView).toBe(false)
    expect(carePermissions(acc({ role: 'sm', scope_store_count: 0 })).canTransfer).toBe(false)
    // Q-76/77: QLCH (tài khoản dùng chung) không tham gia CRM — fail-closed kể cả khi RPC
    // (lỗi/khác phiên bản) trả scope hay cờ phòng cho tài khoản này.
    const NONE = { canView: false, canViewAll: false, canTransfer: false, canImport: false }
    expect(carePermissions(acc({ role: 'store_manager', scope_store_count: 1 }))).toEqual(NONE)
    expect(carePermissions(acc({ role: 'store_manager', scope_store_count: 3, can_view_all: true, can_import: true }))).toEqual(NONE)
    expect(carePermissions(acc({ role: 'store_manager', scope_store_count: 0 }))).toEqual(NONE)
    expect(careNavItems(carePermissions(acc({ role: 'store_manager', scope_store_count: 1, can_import: true })))).toEqual([])
    expect(carePermissions(acc({ role: 'staff', scope_store_count: 0 })).canView).toBe(false)
    expect(carePermissions(acc({ role: 'admin' })).canView).toBe(false)
  })

  test('lịch sử Q-78: trang 10 lượt, con trỏ keyset, đánh dấu lượt của task đang xem', () => {
    expect(CARE_EXCLUDED_ROLES).toEqual(['store_manager'])
    expect(CARE_INTERACTION_PAGE_SIZE).toBe(10)
    const mk = (id: number, task = 'T') => ({ id, outcome: 'CALLBACK', note: `n${id}`, next_action_date: null, created_at: `2026-10-${String(id).padStart(2, '0')}T00:00:00Z`, task_id: task, actor: null })
    const eleven = Array.from({ length: 11 }, (_, k) => mk(30 - k, k < 3 ? 'T' : 'OLD'))
    const p = careInteractionPage(eleven, 'T', Date.parse('2026-10-31T00:00:00Z'))
    expect(p.rows).toHaveLength(10)
    expect(p.hasMore).toBe(true)
    expect(p.nextBefore).toBe(21)                                           // id nhỏ nhất của trang
    expect(p.rows.map((r) => r.isThisTask)).toEqual([true, true, true, false, false, false, false, false, false, false])
    expect('task_id' in p.rows[0]).toBe(false)
    // Q-85: cờ hết hạn ảnh tính theo nowMs do server truyền (lượt 10/2026: còn hạn 31/10, hết hạn 01/02/2027);
    // chỉ lượt CÓ ảnh hợp lệ mới "hết hạn", và khi hết hạn URL bị bỏ khỏi dữ liệu gửi xuống client.
    const url = 'https://storage.googleapis.com/duocsi-circa-vn/care-proof/00000000-0000-4000-8000-000000000700/1700000000001_abcd1201.jpg'
    const withProof = eleven.map((r, k) => ({ ...r, proof: k % 2 ? [{ url }] : null }))
    const fresh = careInteractionPage(withProof, 'T', Date.parse('2026-10-31T00:00:00Z'))
    expect(fresh.rows.every((r) => r.proofExpired === false)).toBe(true)
    expect(fresh.rows.filter((r) => r.proof?.[0]?.url === url)).toHaveLength(5)
    const old = careInteractionPage(withProof, 'T', Date.parse('2027-02-01T00:00:00Z'))
    expect(old.rows.map((r) => r.proofExpired)).toEqual(withProof.slice(0, 10).map((r) => r.proof !== null))
    expect(JSON.stringify(old)).not.toContain('care-proof/')
    expect(careInteractionPage([{ ...eleven[0], proof: [{ url: 'https://evil.example/x.jpg' }] }], 'T', Date.parse('2027-02-01T00:00:00Z')).rows[0].proofExpired).toBe(false)
    expect(careInteractionPage(eleven.slice(0, 10), 'T', Date.parse('2026-10-31T00:00:00Z'))).toMatchObject({ hasMore: false, nextBefore: null })
    expect(careInteractionPage(null, 'T', Date.now())).toEqual({ rows: [], hasMore: false, nextBefore: null })
  })

  test('nav: không nhóm rỗng; Phân công chỉ khi can_import; thứ tự Khách hàng → Phân công → Chăm sóc → Báo cáo', () => {
    expect(careNavItems(null)).toEqual([])
    expect(careNavItems(carePermissions(acc({ role: 'admin' })))).toEqual([])
    expect(careNavItems(carePermissions(acc({ role: 'admin', can_import: true }))).map((x) => x.href)).toEqual(['/care/assign'])
    expect(careNavItems(carePermissions(acc({ role: 'sm', scope_store_count: 1 }))).map((x) => x.href)).toEqual(['/care', '/care/tasks', '/care/reports'])
    expect(careNavItems(carePermissions(acc({ role: 'admin', is_super: true, can_import: true, can_view_all: true }))))
      .toEqual([{ href: '/care', label: 'Khách hàng' }, { href: '/care/assign', label: 'Phân công' }, { href: '/care/tasks', label: 'Chăm sóc' }, { href: '/care/reports', label: 'Báo cáo' }])
  })

  test('filter URL: tháng tương lai/sai ⇒ kỳ hiện tại; UUID/enum/page sai ⇒ bỏ; href không mang từ khoá tìm', () => {
    const cur = '2026-10-01'
    expect(parseCareFilters({}, cur)).toEqual({ month: cur, storeId: null, assigneeId: null, status: null, page: 1 })
    expect(parseCareFilters({ month: '2026-09' }, cur).month).toBe('2026-09-01')
    expect(parseCareFilters({ month: '2026-09-01' }, cur).month).toBe('2026-09-01')
    expect(parseCareFilters({ month: '2026-11' }, cur).month).toBe(cur)
    expect(parseCareFilters({ month: '2026-09-15' }, cur).month).toBe(cur)
    expect(parseCareFilters({ month: 'x' }, cur).month).toBe(cur)
    expect(parseCareFilters({ month: ['2026-09', '2026-08'] }, cur).month).toBe(cur)
    const id = S(101).toUpperCase()
    const f = parseCareFilters({ store: id, assignee: 'not-a-uuid', status: 'overdue_open', page: '3' }, cur)
    expect(f).toEqual({ month: cur, storeId: id.toLowerCase(), assigneeId: null, status: 'overdue_open', page: 3 })
    expect(parseCareFilters({ status: 'DROP TABLE' }, cur).status).toBeNull()
    expect(parseCareFilters({ page: '-5' }, cur).page).toBe(1)
    expect(parseCareFilters({ page: '99999999' }, cur).page).toBe(10_000)
    expect(careFilterHref('/care/tasks', f)).toBe(`/care/tasks?month=2026-10&store=${id.toLowerCase()}&status=overdue_open&page=3`)
    expect(careFilterHref('/care/tasks', f, { page: 1, status: null })).toBe(`/care/tasks?month=2026-10&store=${id.toLowerCase()}`)
    // Tìm kiếm (có thể là SĐT) KHÔNG bao giờ vào URL: href bỏ khoá lạ.
    expect(careFilterHref('/care/tasks', { ...f, q: '0390000001' } as never)).not.toContain('0390000001')
    expect(recentCarePeriods('2026-02-01', 3)).toEqual([
      { value: '2026-02', label: 'Tháng 02/2026' }, { value: '2026-01', label: 'Tháng 01/2026' }, { value: '2025-12', label: 'Tháng 12/2025' }])
    expect(isPastPeriod('2026-09-01', cur)).toBe(true)
    expect(isPastPeriod(cur, cur)).toBe(false)
  })

  test('trạng thái: Quá hạn đang mở ≠ từng trễ hẹn ≠ không hoàn thành; biên ngày cuối tháng', () => {
    const open = (last: string | null, next: string | null) => ({ status: 'open' as const, last_interaction_at: last, next_action_date: next })
    expect(careTaskState(open(null, null), '2026-10-10')).toEqual({ key: 'not_cared', overdueOpen: false })
    expect(careTaskState(open('2026-10-02T01:00:00Z', '2026-10-20'), '2026-10-10')).toEqual({ key: 'following', overdueOpen: false })
    expect(careTaskState(open('2026-10-02T01:00:00Z', '2026-10-09'), '2026-10-10')).toEqual({ key: 'following', overdueOpen: true })
    // Hẹn đúng ngày cuối tháng: hôm đó chưa quá hạn.
    expect(careTaskState(open('2026-10-02T01:00:00Z', '2026-10-31'), '2026-10-31').overdueOpen).toBe(false)
    expect(careTaskState({ status: 'completed', last_interaction_at: 'x', next_action_date: null }, '2026-10-31')).toEqual({ key: 'completed', overdueOpen: false })
    expect(careTaskState({ status: 'closed_unfinished', last_interaction_at: null, next_action_date: '2026-10-01' }, '2026-11-02'))
      .toEqual({ key: 'closed_unfinished', overdueOpen: false })
  })

  test('applyCareTaskFilters: luôn kỳ + is_test=false; mỗi filter chỉ THÊM điều kiện', () => {
    type FB = CareQueryBuilder<FB>
    const calls: string[] = []
    const b: FB = {
      eq: (c, v) => (calls.push(`eq ${c} ${v}`), b), is: (c) => (calls.push(`is ${c} null`), b),
      not: (c, op, v) => (calls.push(`not ${c} ${op} ${v}`), b), lt: (c, v) => (calls.push(`lt ${c} ${v}`), b),
    }
    const base = { month: '2026-10-01', storeId: null, assigneeId: null }
    const run = (status: (typeof CARE_STATUS_FILTERS)[number] | null, extra = {}) => { calls.length = 0; applyCareTaskFilters(b, { ...base, ...extra, status }, '2026-10-10'); return [...calls] }
    expect(run(null)).toEqual(['eq period_month 2026-10-01', 'eq is_test false'])
    expect(run(null, { storeId: S(1), assigneeId: S(2) })).toEqual(['eq period_month 2026-10-01', 'eq is_test false', `eq store_id ${S(1)}`, `eq assignee_id ${S(2)}`])
    expect(run('not_cared').slice(2)).toEqual(['eq status open', 'is last_interaction_at null'])
    expect(run('following').slice(2)).toEqual(['eq status open', 'not last_interaction_at is null'])
    expect(run('overdue_open').slice(2)).toEqual(['eq status open', 'lt next_action_date 2026-10-10'])
    expect(run('completed').slice(2)).toEqual(['eq status completed'])
    expect(run('closed_unfinished').slice(2)).toEqual(['eq status closed_unfinished'])
  })

  test('tìm kiếm: bỏ ký tự cú pháp PostgREST; ≥3 chữ số mới tìm SĐT; quá ngắn ⇒ null', () => {
    expect(careSearchTerm('a')).toBeNull()
    expect(careSearchTerm(' ,() ')).toBeNull()
    expect(careSearchTerm('Nguyễn Văn')).toEqual({ name: 'Nguyễn Văn', phone: null })
    expect(careSearchTerm('x,status.eq.completed)')).toEqual({ name: 'x status.eq.completed', phone: null })
    expect(careSearchTerm('*%\\"\':0901')).toEqual({ name: '0901', phone: '0901' })
    expect(careSearchTerm('090 123')).toEqual({ name: '090 123', phone: '090123' })
    expect(careSearchTerm('A'.repeat(200))!.name.length).toBe(80)
    // Wildcard LIKE `_` bị bỏ (không khớp mọi dòng); chuỗi rất dài cắt trước khi xử lý.
    expect(careSearchTerm('__')).toBeNull()
    expect(careSearchTerm('Lê_Văn')).toEqual({ name: 'Lê Văn', phone: null })
    expect(careSearchTerm('x'.repeat(1_000_000))!.name.length).toBe(80)
  })

  test('số liệu: cộng mỗi dòng RPC đúng một lần; theo store; phân bố outcome có "Chưa cập nhật"', () => {
    const r = (store: number, who: number, o: Partial<CareReportRow>): CareReportRow => ({
      store_id: S(store), assignee_id: S(who), tasks_total: 0, completed: 0, open_not_cared: 0, open_in_progress: 0,
      overdue_in_period: 0, closed_unfinished: 0, converted_tasks: 0, ...o })
    const rows = [
      r(1, 11, { tasks_total: 5, completed: 2, open_not_cared: 2, open_in_progress: 1, overdue_in_period: 1 }),
      r(1, 12, { tasks_total: 3, completed: 1, open_in_progress: 2 }),
      r(2, 21, { tasks_total: 4, closed_unfinished: 4, overdue_in_period: 2 }),
    ]
    expect(careReportTotals(rows)).toEqual({ tasks: 12, completed: 3, notCared: 2, inProgress: 3, overdueInPeriod: 3, closedUnfinished: 4 } satisfies CareTotals)
    expect(careReportTotals([])).toEqual({ tasks: 0, completed: 0, notCared: 0, inProgress: 0, overdueInPeriod: 0, closedUnfinished: 0 })
    const by = careReportByStore(rows)
    expect(by.map((x) => [x.storeId, x.totals.tasks])).toEqual([[S(1), 8], [S(2), 4]])
    const d = careOutcomeDistribution({ none: 2, CALLBACK: 2 })
    expect(d.map((x) => x.key)).toEqual([...CARE_OUTCOME_KEYS])
    expect(d.reduce((s, x) => s + x.count, 0)).toBe(4)
    expect(d.find((x) => x.key === 'none')).toEqual({ key: 'none', label: 'Chưa cập nhật', count: 2 })
    expect(d.find((x) => x.key === 'CALLBACK')!.count).toBe(2)
    expect(careOutcomeDistribution({}).every((x) => x.count === 0)).toBe(true)
  })

  test('ảnh sản phẩm: chỉ CDN đã chốt (chốt thứ hai sau CHECK 114)', () => {
    expect(careSafeImageUrl('https://cdn-gcs.thuocsi.vn/a/b.png')).toBe('https://cdn-gcs.thuocsi.vn/a/b.png')
    for (const bad of [null, undefined, '', 'http://cdn-gcs.thuocsi.vn/a.png', 'https://cdn-gcs.thuocsi.vn.evil.com/a.png',
      'https://cdn-gcs.thuocsi.vn@evil.com/a.png', 'https://evil.com/https://cdn-gcs.thuocsi.vn/', 'javascript:alert(1)',
      'https://cdn-gcs.thuocsi.vn/a"onerror=x.png', 'https://cdn-gcs.thuocsi.vn/a b.png']) expect(careSafeImageUrl(bad), String(bad)).toBeNull()
  })

  test('chuyển giao: validate đầu vào; map lỗi không lộ message gốc', () => {
    const ok = validateTransferInput({ taskIds: [S(1), S(2)], toUserId: S(9), note: '  nghỉ phép  ' })
    expect(ok).toEqual({ ok: true, taskIds: [S(1), S(2)], toUserId: S(9), note: 'nghỉ phép' })
    expect(validateTransferInput({ taskIds: [], toUserId: S(9), note: 'x' })).toEqual({ ok: false, code: 'BATCH_SIZE' })
    // Trùng id ⇒ gộp (RPC cũng DISTINCT) — không chuyển 2 lần.
    expect(validateTransferInput({ taskIds: [S(1), S(1)], toUserId: S(9), note: 'x' })).toEqual({ ok: true, taskIds: [S(1)], toUserId: S(9), note: 'x' })
    expect(validateTransferInput({ taskIds: [S(1), 'x'], toUserId: S(9), note: 'x' })).toEqual({ ok: false, code: 'BATCH_SIZE' })
    expect(validateTransferInput({ taskIds: 'x', toUserId: S(9), note: 'x' })).toEqual({ ok: false, code: 'BATCH_SIZE' })
    expect(validateTransferInput({ taskIds: Array.from({ length: 501 }, (_, i) => S(i + 1)), toUserId: S(9), note: 'x' })).toEqual({ ok: false, code: 'BATCH_SIZE' })
    expect(validateTransferInput({ taskIds: Array.from({ length: 500 }, (_, i) => S(i + 1)), toUserId: S(9999), note: 'x' }).ok).toBe(true)
    expect(validateTransferInput({ taskIds: [S(1)], toUserId: 'admin', note: 'x' })).toEqual({ ok: false, code: 'TARGET_INVALID' })
    expect(validateTransferInput({ taskIds: [S(1)], toUserId: S(9), note: '   ' })).toEqual({ ok: false, code: 'NOTE_REQUIRED' })
    expect(validateTransferInput({ taskIds: [S(1)], toUserId: S(9), note: 'x'.repeat(501) })).toEqual({ ok: false, code: 'NOTE_REQUIRED' })
    expect(validateTransferInput({ taskIds: [S(1)], toUserId: S(9), note: 'x'.repeat(500) }).ok).toBe(true)
    expect(mapCareTransferError(null)).toBe('TRANSFER_FAILED')
    expect(mapCareTransferError('connection reset; KH 0390000001')).toBe('TRANSFER_FAILED')
    for (const msg of Object.values(CARE_TRANSFER_MESSAGES)) expect(msg).not.toMatch(/care_|SQL|RAISE|\d{9}/)
  })
})

test.describe('care B8.1 — logic thuần /care/tasks @desktop', () => {
  const F = { month: '2026-10-01', storeId: S(101), assigneeId: S(901), status: 'following' as const, page: 3 }

  test('chip trạng thái: Tất cả + 5 filter; href giữ kỳ/store/dược sĩ, bỏ trang; không có từ khoá; số đếm null ⇒ không hiện số', () => {
    const tabs = careStatusChipTabs('/care/tasks', F, { all: 6, not_cared: 2, following: 2, overdue_open: 1, completed: 1, closed_unfinished: 1 })
    expect(tabs.map((t) => t.key)).toEqual(['all', ...CARE_STATUS_FILTERS])
    expect(tabs.map((t) => t.label)).toEqual(['Tất cả', ...CARE_STATUS_FILTERS.map((s) => CARE_STATUS_CHIP_LABELS[s])])
    expect(tabs[0].href).toBe(`/care/tasks?month=2026-10&store=${S(101)}&assignee=${S(901)}`)
    expect(tabs.find((t) => t.key === 'overdue_open')!.href).toBe(`/care/tasks?month=2026-10&store=${S(101)}&assignee=${S(901)}&status=overdue_open`)
    for (const t of tabs) expect(t.href).not.toMatch(/page=|q=|open=/)
    expect(tabs.map((t) => t.count)).toEqual([6, 2, 2, 1, 1, 1])
    // Không cộng chip thành tổng: overdue_open giao following — "Tất cả" là count riêng.
    expect(careStatusChipTabs('/care/tasks', F, null).every((t) => t.count === undefined)).toBe(true)
  })

  test('drawer ?open=: chỉ nhận uuid, chuẩn hoá chữ thường; sai ⇒ null', () => {
    expect(parseCareOpenParam({ open: S(500).toUpperCase() })).toBe(S(500))
    for (const v of ['0390000001', 'x', '', undefined, [S(500)]]) expect(parseCareOpenParam({ open: v as never })).toBeNull()
  })

  test('hẹn lại 2 dòng: hôm nay / còn n / quá n (chỉ task mở); lượt gần nhất giờ VN', () => {
    expect(careApptHint('2026-10-15', '2026-10-13', true)).toEqual({ date: '15/10/2026', hint: 'còn 2 ngày', overdue: false })
    expect(careApptHint('2026-10-13', '2026-10-13', true)).toEqual({ date: '13/10/2026', hint: 'hôm nay', overdue: false })
    expect(careApptHint('2026-10-02', '2026-10-13', true)).toEqual({ date: '02/10/2026', hint: 'quá 11 ngày', overdue: true })
    expect(careApptHint('2026-10-02', '2026-10-13', false)).toEqual({ date: '02/10/2026', hint: null, overdue: false })
    expect(careApptHint('2026-11-01', '2026-10-31', true)!.hint).toBe('còn 1 ngày')                  // qua tháng
    expect(careApptHint(null, '2026-10-13', true)).toBeNull()
    expect(careShortDateTime('2026-10-13T03:55:00Z')).toBe('10:55 13/10')                          // UTC+7
    expect(careShortDateTime('2026-10-12T17:30:00Z')).toBe('00:30 13/10')                          // qua ngày VN
    expect(careShortDateTime(null)).toBeNull()
  })

  test('sản phẩm hiện hành: chỉ đếm is_current (bỏ dòng revision cũ)', () => {
    expect(careCurrentProductCount([{ is_current: true }, { is_current: false }, { is_current: true }])).toBe(2)
    expect(careCurrentProductCount(null)).toBe(0)
  })

  test('chuyển giao (PM B8.1 P1): khoá đích giữ BẤT KỲ task trong lô; tải = open_not_cared + open_in_progress theo dược sĩ', () => {
    const c = careTransferConflicts([{ assigneeId: S(901) }, { assigneeId: S(903) }, { assigneeId: S(901) }])
    expect(Object.fromEntries(c)).toEqual({ [S(901)]: 2, [S(903)]: 1 })
    const row = (assignee: string, o: Partial<CareReportRow>): CareReportRow => ({ store_id: S(101), assignee_id: assignee, tasks_total: 99, completed: 50,
      open_not_cared: 0, open_in_progress: 0, overdue_in_period: 7, closed_unfinished: 9, converted_tasks: 3, ...o })
    const load = careOpenLoadByAssignee([row(S(901), { open_not_cared: 2, open_in_progress: 1 }), row(S(901), { store_id: S(102), open_not_cared: 1 }), row(S(903), {})])
    expect(Object.fromEntries(load)).toEqual({ [S(901)]: 4, [S(903)]: 0 })                         // không dùng tasks_total
  })
})

test.describe('care B3 — source: cờ, session/RPC, không service role @desktop', () => {
  const B3_FILES = [
    'app/actions/care.ts', 'lib/care/server/browse.ts', 'lib/care/server/pageGuard.ts',
    'app/(dashboard)/care/page.tsx', 'app/(dashboard)/care/tasks/page.tsx', 'app/(dashboard)/care/tasks/[id]/page.tsx',
    'components/care/CareDashboardView.tsx', 'components/care/CareFiltersBar.tsx', 'components/care/CareTaskTable.tsx',
    'components/care/CareTaskDetailView.tsx', 'components/care/CareTransferDialog.tsx', 'components/care/CareTaskTransferButton.tsx',
    'components/care/CareProductGallery.tsx', 'app/(dashboard)/ui-catalog/care-browse/page.tsx',
    'components/care/CareTaskDrawer.tsx', 'components/care/CareStatusChips.tsx',
  ]

  test('không file B3 nào dùng service role / supabaseAdmin', () => {
    for (const f of B3_FILES) {
      const src = read(f)
      expect(src, f).not.toMatch(/supabaseAdmin|supabase\/admin|SERVICE_ROLE|service_role/)
    }
  })

  test('server action: mọi export kiểm cờ trước tiên → care_my_access; chuyển giao = session rpc care_transfer_tasks', () => {
    const src = read('app/actions/care.ts')
    expect(src).toMatch(/^'use server'/)
    const fns = [...src.matchAll(/export async function (\w+)\([\s\S]*?\{\n([\s\S]*?)\n\}/g)]
    expect(fns.map((m) => m[1]).sort()).toEqual(['listCareTransferTargets', 'loadCareTaskPanel', 'loadMoreCareInteractions', 'searchCareTasks', 'transferCareTasks'])
    // B8.1 drawer (Q-115): canView → uuid → đọc lại task qua SESSION/RLS mỗi lần mở; ngoài phạm vi ⇒ NOT_FOUND;
    // không trả customer_id (chỉ trường hiển thị) — SĐT đủ chỉ của MỘT task vừa kiểm quyền.
    const pn = fns.find((m) => m[1] === 'loadCareTaskPanel')![2]
    expect(pn).toMatch(/if \(v\.kind !== 'ok' \|\| !v\.perms\.canView\) return/)
    expect(pn).toMatch(/UUID_RE\.test\(input\.taskId\)/)
    expect(pn.indexOf('UUID_RE.test(input.taskId)')).toBeLessThan(pn.indexOf('await loadCareTaskDetail(input.taskId)'))
    expect(pn).toMatch(/if \(!d\) return \{ ok: false, code: 'NOT_FOUND'/)
    expect(pn).not.toMatch(/customer_id|external_id|service_role/)
    // Thiếu care_my_access (lỗi mạng/timeout) không giả làm "thiếu cấu hình" (PM B8 hợp đồng).
    expect(pn).toMatch(/if \(v\.kind === 'unavailable'\) return \{ ok: false, code: 'FAILED', message: 'Tạm thời không đọc được dữ liệu — thử lại\.' \}/)
    // Xem thêm lịch sử (Q-78): kiểm canView, validate, rồi đọc lại task qua RLS (KHÔNG truyền `known`).
    const lm = fns.find((m) => m[1] === 'loadMoreCareInteractions')![2]
    expect(lm).toMatch(/if \(v\.kind !== 'ok' \|\| !v\.perms\.canView\) return/)
    expect(lm).toMatch(/UUID_RE\.test\(input\.taskId\)/)
    expect(lm).toMatch(/await loadCareInteractionsPage\(input\.taskId, before\)/)
    for (const m of fns) {
      expect(m[2].trimStart(), m[1]).toMatch(/^if \(!isCareEnabled\(\)\) return/)
      expect(m[2], m[1]).toContain('await getCareViewAccess()')
    }
    const tr = fns.find((m) => m[1] === 'transferCareTasks')![2]
    expect(tr).toMatch(/if \(!v\.perms\.canTransfer\) return/)
    expect(tr).toMatch(/validateTransferInput\(input\)/)
    expect(tr).toMatch(/const supabase = await createClient\(\)\s*\n\s*const \{ data, error \} = await supabase\.rpc\('care_transfer_tasks', \{/)
    // B6-qa-ui (security P1-2): chặn QA (chỉ task batch QA + đích dược sĩ QA; production null) SAU validate, TRƯỚC RPC.
    expect(tr.indexOf('validateTransferInput(input)')).toBeLessThan(tr.indexOf('await careQaTransferBlock(valid.taskIds, valid.toUserId)'))
    expect(tr.indexOf('await careQaTransferBlock(')).toBeLessThan(tr.indexOf("supabase.rpc('care_transfer_tasks'"))
    expect(tr).toMatch(/mapCareTransferError\(error\.message\)/)
    expect(tr).not.toMatch(/\.from\('care_tasks'\)|\.update\(|care_assignment_events/)
    expect(src).not.toMatch(/console\.(log|error|warn)/)
  })

  test('đọc dữ liệu: server-only, session client, FK embed tường minh, list không tải sản phẩm/ảnh', () => {
    const src = read('lib/care/server/browse.ts')
    expect(src).toMatch(/^import 'server-only'/)
    expect(src).toContain("import { createClient } from '@/lib/supabase/server'")
    for (const fk of ['stores!care_tasks_store_id_fkey', 'users!care_tasks_assignee_id_fkey', 'users!care_interactions_actor_id_fkey',
      'users!care_assignment_events_from_user_id_fkey', 'users!care_assignment_events_to_user_id_fkey', 'users!care_assignment_events_actor_id_fkey',
      'stores!care_assignment_events_from_store_id_fkey', 'stores!care_assignment_events_to_store_id_fkey']) expect(src).toContain(fk)
    // Không embed trần (vd. `stores(`) — bài học mig 045.
    expect(src).not.toMatch(/[:\s,](stores|users)\(/)
    const cols = /const TASK_COLUMNS = '([^']+)'/.exec(src)![1]
    expect(cols).not.toMatch(/image_url|product|care_customers|phone/)
    // Danh sách: SĐT che Ở SERVER (phone_norm không xuống client); không email dược sĩ.
    expect(src).toContain('phone_masked: maskVnPhone(phone_norm)')
    // B8.1: số sản phẩm — embed CHỈ cờ is_current qua FK tường minh, đếm hiện hành ở app (không tên/ảnh, không N+1).
    expect(src).toContain("const TASK_PRODUCT_FLAGS = 'care_task_products!care_task_products_task_id_fkey(is_current)'")
    expect(src).toContain('product_count: careCurrentProductCount(care_task_products)')
    // B8.1 chip: count head:true song song, cùng withCareFilters (kỳ/store/dược sĩ + careDataScope), "Tất cả" = count riêng.
    expect(src).toMatch(/const keys = \[null, \.\.\.CARE_STATUS_FILTERS\] as const\s*const counts = await Promise\.all\(keys\.map\(async \(status\) => \{\s*const \{ count, error \} = await withCareFilters\(supabase\.from\('care_tasks'\)\.select\('id', \{ count: 'exact', head: true \}\), \{ \.\.\.f, status \}, todayISO\)/)
    expect(src).toMatch(/if \(error \|\| count === null\) throw new Error\('care_status_counts_failed'\)/)
    // B8.1 tải dược sĩ nhận (PM P1-1): QA local qua loadCareQaReportRows; production RPC care_report session; một lần đọc.
    expect(src).toMatch(/async function loadCareReportRowsScoped\(month: string\)[^{]*\{\s*if \(careDataScope\(\)\.kind === 'qa'\) return loadCareQaReportRows\(\{ month, storeId: null \}\)/)
    expect(src).toMatch(/loadCareReportRowsScoped\(currentMonth\)\.then\(careOpenLoadByAssignee\)\.catch\(\(\) => null\)/)
    // Lỗi count ⇒ chip KHÔNG hiện số (không 0 giả): trang bắt lỗi thành null; careStatusChipTabs(null) ⇒ count undefined;
    // FilterTabs chỉ in số khi là number. List vẫn hiển thị (count chạy song song, lỗi không làm hỏng trang).
    // Đo 13/10: danh sách + 6 count cùng lúc tranh pool PostgREST (~800 ms vs ~230–300 ms) ⇒ chip stream SAU danh sách.
    const tp = read('app/(dashboard)/care/tasks/page.tsx')
    expect(tp).toMatch(/const \[stores, page\] = await Promise\.all\(\[loadScopeStores\(g\.perms\), loadCareTaskPage\(f, today\)\]\)/)
    expect(tp).toMatch(/<Suspense fallback=\{<CareStatusChipsBare path="\/care\/tasks" filters=\{f\} \/>\}>\s*<CareStatusChips path="\/care\/tasks" filters=\{f\} todayISO=\{today\} \/>/)
    expect(tp).not.toMatch(/loadCareStatusCounts/)
    const chipsSrc = read('components/care/CareStatusChips.tsx')
    expect(chipsSrc).toContain('const counts = await loadCareStatusCounts(filters, todayISO).catch(() => null)')
    expect(chipsSrc).toContain('tabs={careStatusChipTabs(path, filters, null)}')               // fallback: không số
    expect(read('components/ds/FilterTabs.tsx')).toContain("typeof t.count === 'number'")
    expect(src).not.toMatch(/select\('[^']*email/)
    // Phân bố outcome: đếm head:true ở DB, không tải dòng (SPEC B3 §2).
    expect(src).toMatch(/CARE_OUTCOME_KEYS\.map\(async \(k\) => \{\s*const base = withCareFilters\(supabase\.from\('care_tasks'\)\.select\('id', \{ count: 'exact', head: true \}\)/)
    expect(src).not.toMatch(/select\('id, last_outcome'/)
    const gallery = read('components/care/CareProductGallery.tsx')
    expect(gallery).not.toMatch(/src=\{(p|zoom)\.image_url\}/)
    expect((gallery.match(/referrerPolicy="no-referrer"/g) ?? []).length).toBe(2)
    expect(read('components/care/CareTransferDialog.tsx')).not.toMatch(/email/)
    expect(src).toContain(`p_include_test: false`)
    expect(src).not.toMatch(/care_orders/)
    // Dropdown store: OS + active (luật cứng §5).
    expect(src).toMatch(/from\('stores'\)\.select\('id, code, name'\)\.eq\('store_type', 'os'\)\.eq\('is_active', true\)\.order/)
    expect(src).toMatch(/let storeQ = supabase\.from\('stores'\)[^\n]*\.eq\('store_type', 'os'\)\.eq\('is_active', true\)/)
    expect(src).toMatch(/export async function getCareNavPermissions[^{]*\{\s*if \(!isCareEnabled\(\)/)
    // Q-76/77: nav không gọi care_my_access cho QLCH; import (B2) chặn thêm role ở app.
    expect(src).toContain("!['admin', 'sm'].includes(role)) return null")
    expect(read('lib/care/server/importAccess.ts')).toContain("a.can_import === true && a.role !== 'store_manager'")
    // Q-78: lịch sử 10 lượt/lần, keyset id ↓, không còn trần 200.
    expect(src).not.toMatch(/CARE_INTERACTION_LIMIT|limit\(200/)
    expect(src).toMatch(/if \(beforeId !== null\) q = q\.lt\('id', beforeId\)[\s\S]*?\.order\('id', \{ ascending: false \}\)\.limit\(CARE_INTERACTION_PAGE_SIZE \+ 1\)/)
    expect(read('components/care/CareTaskTable.tsx')).not.toMatch(/image_url|<img|CareProductGallery/)
  })

  test('sidebar/layout: nhóm "Chăm sóc KH" chỉ từ careNav server; staff/FS không tính; cờ OFF ⇒ rỗng', () => {
    const ly = read('app/(dashboard)/layout.tsx')
    expect(ly).toContain('const careNav = !isStaff && !isFsStore ? careNavItems(await getCareNavPermissions(profile.role)) : []')
    expect(ly).toContain('careNav={careNav}')
    const sb = read('components/layout/Sidebar.tsx')
    expect(sb).toContain('const careItems = isFsStore ? [] : careNav')
    expect(sb).toContain('const showCare = careItems.length > 0')
    expect(sb).toMatch(/\{key === 'ops' && showCare && \(/)
    expect(sb).toContain('...careItems.map((c) => c.href)')
    // B4: BottomNav chỉ có /care/my (staff, khi careEnabled) — không link browser /care, /care/tasks.
    expect(read('components/layout/BottomNav.tsx')).not.toMatch(/['"]\/care(\/tasks|\/assign)?['"]/)
  })

  test('catalog care-browse: UI_CATALOG + super; mỗi action giả tự kiểm cổng', () => {
    const src = read('app/(dashboard)/ui-catalog/care-browse/page.tsx')
    expect(src).toMatch(/export default async function \w+\([^)]*\) \{\s*if \(!catalogOn\(\)\) notFound\(\)/)
    // Cổng action giả = cùng điều kiện page: UI_CATALOG + session super.
    expect(src).toMatch(/async function gate\(\): Promise<boolean> \{\s*if \(!catalogOn\(\)\) return false[\s\S]*?isSuperAdminEmail\(user\.email\)\s*\}/)
    const fakes = [...src.matchAll(/async function (fake\w+)\([^)]*\)(?:: [^{]+)? \{\s*'use server'\s*if \(!\(await gate\(\)\)\) return/g)]
    expect(fakes.map((m) => m[1]).sort()).toEqual(['fakeLoadMore', 'fakePanel', 'fakeSearch', 'fakeTargets', 'fakeTransfer'])
    // Không có action giả nào khác ngoài danh sách đã kiểm cổng.
    expect([...src.matchAll(/async function (fake\w+)\(/g)].length).toBe(fakes.length)
    expect(src).toMatch(/example\.invalid/)
    // Chỉ SĐT giả 039000000x.
    for (const m of src.matchAll(/(?<!\d)0[35789]\d{8}(?!\d)/g)) expect(m[0]).toMatch(/^039000000\d$/)
  })
})

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

/** Builder SQL tối giản theo đúng CareQueryBuilder — chạy applyCareTaskFilters thật trên PGlite. */
class SqlWhere implements CareQueryBuilder<SqlWhere> {
  parts: string[] = []
  params: unknown[] = []
  private col(c: string) { if (!/^[a-z_]+$/.test(c)) throw new Error('col'); return c }
  private add(sql: string, v?: unknown) { if (v !== undefined) { this.params.push(v); sql = sql.replace('?', `$${this.params.length}`) } this.parts.push(sql); return this }
  eq(c: string, v: unknown) { return this.add(`${this.col(c)} = ?`, v) }
  is(c: string) { return this.add(`${this.col(c)} IS NULL`) }
  not(c: string, op: string, v: unknown) { if (op !== 'is' || v !== null) throw new Error('not'); return this.add(`${this.col(c)} IS NOT NULL`) }
  lt(c: string, v: string) { return this.add(`${this.col(c)} < ?`, v) }
  sql() { return this.parts.join(' AND ') }
}

test.describe('care B3 — parity browser ↔ migration 114 (PGlite) @desktop', () => {
  test.skip(!HAS_PGLITE, 'chưa cài PGlite — npm i --no-save @electric-sql/pglite@0.2.17 (trong webapp/)')

  test('quyền · thẻ = trạng thái dòng · filter chỉ thu hẹp · phân trang · chuyển giao + map lỗi thật', async () => {
    test.setTimeout(300_000)
    const { PGlite } = await import('@electric-sql/pglite')
    const L: any = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib-care-pglite.mjs')).href)
    const db: Db = await L.freshDb(PGlite)
    // Ghim "hôm nay VN" của DB vào kỳ fixture (helper lịch sử khách dùng care_vn_today()) ⇒ test không phụ thuộc ngày chạy thật.
    await db.exec(`CREATE OR REPLACE FUNCTION public.care_vn_today() RETURNS date LANGUAGE sql STABLE AS $$ SELECT DATE '2026-10-20' $$`)
    const U = L.U
    const P10 = '2026-10-01'

    // FK mà browse.ts embed phải tồn tại đúng tên (PostgREST !fkey).
    const fks = (await db.query(`SELECT conname FROM pg_constraint WHERE contype = 'f' AND conrelid::regclass::text LIKE 'care_%'`)).rows.map((r: any) => r.conname)
    for (const fk of ['care_tasks_store_id_fkey', 'care_tasks_assignee_id_fkey', 'care_interactions_actor_id_fkey',
      'care_assignment_events_from_user_id_fkey', 'care_assignment_events_to_user_id_fkey', 'care_assignment_events_actor_id_fkey',
      'care_assignment_events_from_store_id_fkey', 'care_assignment_events_to_store_id_fkey']) expect(fks, fk).toContain(fk)

    // Phòng OPS chỉ được import (không view_all) — kiểm "can_import không mở view".
    await db.query(`INSERT INTO public.care_access (department_id, can_import, can_view_all) VALUES ($1, true, false)`, [L.OPS_DEPT])

    // Quyền đọc từ care_my_access() thật → carePermissions.
    const permsOf = async (who: string) => carePermissions(await L.as(db, who, async () => (await db.query(`SELECT public.care_my_access() AS a`)).rows[0].a))
    expect(await permsOf(U.super)).toEqual({ canView: true, canViewAll: true, canTransfer: true, canImport: true })
    expect(await permsOf(U.mkt)).toEqual({ canView: true, canViewAll: true, canTransfer: false, canImport: true })
    expect(await permsOf(U.ops)).toEqual({ canView: false, canViewAll: false, canTransfer: false, canImport: true })
    expect(careNavItems(await permsOf(U.ops)).map((x) => x.href)).toEqual(['/care/assign'])
    expect(await permsOf(U.sm)).toEqual({ canView: true, canViewAll: false, canTransfer: true, canImport: false })
    expect(await permsOf(U.sm2)).toEqual({ canView: true, canViewAll: false, canTransfer: true, canImport: false })
    // Q-76/77: QLCH OS/FS — không quyền nào; kể cả QLCH cùng phòng Marketing (care admin).
    const NONE = { canView: false, canViewAll: false, canTransfer: false, canImport: false }
    expect(await permsOf(U.qlch1)).toEqual(NONE)
    expect(await permsOf(U.qlchFs)).toEqual(NONE)
    await db.query(`UPDATE public.users SET department_id = $1 WHERE id = $2`, [L.MKT_DEPT, U.qlch1])
    expect(await permsOf(U.qlch1)).toEqual(NONE)
    expect((await permsOf(U.A)).canView).toBe(false)

    // Fixture kỳ 10: 25 store × 10 khách (5/dược sĩ), 1–3 sản phẩm/khách (nhiều dòng sản phẩm/khách).
    const fixture = buildCareImportRows({ customersPerStore: 10 }) as unknown as Record<string, string>[]
    const res = await L.finalize(db, await L.stage(db, fixture, { period: P10 }), U.mkt, '2026-10-01')
    expect(res.status).toBe('committed')
    expect(res.created).toBe(250)
    const tasksOf = async (who: string) => (await db.query(`SELECT * FROM public.care_tasks WHERE assignee_id = $1 AND period_month = $2 ORDER BY id`, [who, P10])).rows
    const [a0, a1, a2] = await tasksOf(U.A)
    const [b0] = await tasksOf(U.B)
    const [c0, c1] = await tasksOf(U.C)
    await L.record(db, '2026-10-05', U.A, a0.id, 'CALLBACK', 'QA hẹn cuối tháng', '2026-10-31')
    await L.record(db, '2026-10-05', U.A, a1.id, 'CALLBACK', 'QA hẹn sớm', '2026-10-10')
    await L.record(db, '2026-10-05', U.A, a2.id, 'INTERESTED', 'QA quan tâm')
    await L.record(db, '2026-10-06', U.B, b0.id, 'UNREACHABLE', 'QA không nghe', '2026-10-30')
    await L.record(db, '2026-10-06', U.C, c0.id, 'NO_NEED', 'QA không cần')
    // Q-78: khách của a0 có 1 + 22 = 23 lượt ⇒ 3 trang (10 + 10 + 3).
    for (let k = 0; k < 22; k++) await L.record(db, '2026-10-06', U.A, a0.id, 'CALLBACK', `QA lượt thêm ${k}`, '2026-10-31')
    await db.query(`SELECT public.care__stamp_overdue_at('2026-10-31')`)

    /** Đọc như browser: session + applyCareTaskFilters (+ filter store/assignee/status). */
    const browse = async (who: string, f: { month: string; storeId?: string | null; assigneeId?: string | null; status?: any }, today: string, extra = '') => {
      const w = applyCareTaskFilters(new SqlWhere(), { storeId: null, assigneeId: null, status: null, ...f }, today)
      return L.as(db, who, async () => (await db.query(`SELECT id, status, last_interaction_at::text, next_action_date::text, first_overdue_on::text, last_outcome, store_id, assignee_id
        FROM public.care_tasks WHERE ${w.sql()} ${extra}`, w.params)).rows)
    }
    const report = async (who: string, month: string, stores: string[] | null = null) =>
      L.as(db, who, async () => (await db.query(`SELECT * FROM public.care_report($1::date, $2::uuid[], false)`, [month, stores])).rows) as Promise<CareReportRow[]>
    const derive = (rows: any[], today: string): CareTotals => {
      const t: CareTotals = { tasks: rows.length, completed: 0, notCared: 0, inProgress: 0, overdueInPeriod: 0, closedUnfinished: 0 }
      for (const r of rows) {
        const s = careTaskState(r, today)
        if (s.key === 'completed') t.completed++
        else if (s.key === 'closed_unfinished') t.closedUnfinished++
        else if (s.key === 'not_cared') t.notCared++
        else t.inProgress++
        if (r.first_overdue_on) t.overdueInPeriod++
      }
      return t
    }

    // Kỳ hiện tại, hôm nay 31/10: thẻ (RPC) = trạng thái tính từ dòng đọc bằng session, mọi vai trò xem được.
    const viewers: [string, string, number][] = [['super', U.super, 250], ['Marketing', U.mkt, 250], ['SM', U.sm, 20], ['SM2', U.sm2, 10], ['QLCH (Q-76/77)', U.qlch1, 0], ['QLCH FS', U.qlchFs, 0]]
    for (const [name, who, n] of viewers) {
      const rows = await browse(who, { month: P10 }, '2026-10-31')
      expect(rows.length, name).toBe(n)
      expect(careReportTotals(await report(who, P10)), name).toEqual(derive(rows, '2026-10-31'))
    }
    const all = await browse(U.super, { month: P10 }, '2026-10-31')
    const st = (id: string) => careTaskState(all.find((r: any) => r.id === id), '2026-10-31')
    expect(st(a0.id)).toEqual({ key: 'following', overdueOpen: false })            // hẹn 31/10, hôm nay 31/10
    expect(st(a1.id)).toEqual({ key: 'following', overdueOpen: true })
    expect(st(a2.id).key).toBe('completed')
    expect(st(b0.id)).toEqual({ key: 'following', overdueOpen: true })
    expect(st(c1.id)).toEqual({ key: 'not_cared', overdueOpen: false })
    // Phân bố outcome = đếm theo từng khoá (đúng cách server đếm head:true) — cộng lại đủ mẫu số.
    const oc: Record<string, number> = {}
    for (const k of CARE_OUTCOME_KEYS) {
      oc[k] = (await browse(U.super, { month: P10 }, '2026-10-31', k === 'none' ? 'AND last_outcome IS NULL' : `AND last_outcome = '${k}'`)).length
    }
    const dist = careOutcomeDistribution(oc)
    expect(dist.reduce((s, x) => s + x.count, 0)).toBe(250)
    expect(oc).toEqual({ UNREACHABLE: 1, NO_NEED: 1, INTERESTED: 1, CALLBACK: 2, ORDERED: 0, REFUSED: 0, none: 245 })
    // "Quá hạn đang mở" (filter) = đúng tập overdueOpen; khác first_overdue_on ở biên.
    const overdue = await browse(U.super, { month: P10, status: 'overdue_open' }, '2026-10-31')
    expect(overdue.map((r: any) => r.id).sort()).toEqual([a1.id, b0.id].sort())
    for (const s of CARE_STATUS_FILTERS) {
      const got = await browse(U.super, { month: P10, status: s }, '2026-10-31')
      const want = all.filter((r: any) => { const x = careTaskState(r, '2026-10-31'); return s === 'overdue_open' ? x.overdueOpen : x.key === s })
      expect(got.map((r: any) => r.id).sort(), s).toEqual(want.map((r: any) => r.id).sort())
    }

    // QLCH (cùng phòng Marketing ở đây) đọc trực tiếp MỌI bảng CRM ⇒ 0 dòng, dù store của QLCH có task kỳ này; RPC rỗng.
    for (const t of ['care_access', 'care_import_batches', 'care_customers', 'care_tasks', 'care_task_products', 'care_interactions',
      'care_assignment_events', 'care_store_refusals', 'care_sync_state']) {
      expect(await L.as(db, U.qlch1, () => L.count(db, `SELECT count(*) FROM public.${t}`)), t).toBe(0)
    }
    // Q-95/Q-101: attribution + đơn thô không còn SELECT cho authenticated ⇒ từ chối hẳn (không chỉ 0 dòng).
    for (const t of ['care_order_attributions', 'care_orders']) {
      expect(await L.raises(L.as(db, U.qlch1, () => db.query(`SELECT count(*) FROM public.${t}`)), 'permission denied'), t).toBe(true)
    }
    expect(await report(U.qlch1, P10)).toHaveLength(0)
    expect((await L.as(db, U.qlch1, async () => (await db.query(`SELECT * FROM public.care_my_summary()`)).rows[0])).assigned).toBe(0)
    // Filter chỉ THU HẸP: SM2 (QAOS01) lọc QAOS02 ⇒ rỗng cả list lẫn RPC.
    expect(await browse(U.sm2, { month: P10, storeId: L.storeId(2) }, '2026-10-31')).toHaveLength(0)
    expect(await report(U.sm2, P10, [L.storeId(2)])).toHaveLength(0)
    expect(await browse(U.qlch1, { month: P10, assigneeId: U.C }, '2026-10-31')).toHaveLength(0)
    expect((await browse(U.sm, { month: P10, storeId: L.storeId(2) }, '2026-10-31')).length).toBe(10)
    // Kỳ tương lai qua URL đã bị parseCareFilters chặn; staff/FS/OPS đọc trực tiếp vẫn bị RLS giới hạn.
    expect(await browse(U.ops, { month: P10 }, '2026-10-31')).toHaveLength(0)
    expect(await browse(U.qlchFs, { month: P10 }, '2026-10-31')).toHaveLength(0)

    // Phân trang ổn định (created_at ↓, id ↓) — 250 task, trang 30: không lặp, không mất.
    const seen: string[] = []
    for (let p = 0; p < 9; p++) {
      const page = await browse(U.super, { month: P10 }, '2026-10-31', `ORDER BY created_at DESC, id DESC LIMIT 30 OFFSET ${p * 30}`)
      seen.push(...page.map((r: any) => r.id))
    }
    expect(seen.length).toBe(250)
    expect(new Set(seen).size).toBe(250)
    // Bảng đếm task, không đếm dòng sản phẩm.
    expect(await L.count(db, `SELECT count(*) FROM public.care_task_products WHERE is_current`)).toBeGreaterThan(250)

    // B8.1 chip: count theo đúng filter app (kỳ/store/dược sĩ + RLS) — 4 nhóm rời nhau cộng = "Tất cả";
    // "Quá hạn" ⊂ "Đang theo dõi" (giao nhau ⇒ không cộng năm chip). Kiểm cả super lẫn SM (scope vùng).
    for (const [name, who] of [['super', U.super], ['SM', U.sm]] as const) {
      const ids = async (s: any) => (await browse(who, { month: P10, status: s }, '2026-10-31')).map((r: any) => r.id as string)
      const allIds = await ids(null)
      const parts = [...await ids('not_cared'), ...await ids('following'), ...await ids('completed'), ...await ids('closed_unfinished')]
      expect(parts.length, name).toBe(allIds.length)
      expect(new Set(parts).size, name).toBe(allIds.length)
      const following = new Set(await ids('following'))
      const overdueIds = await ids('overdue_open')
      for (const id of overdueIds) expect(following.has(id), name).toBe(true)
      if (name === 'super') expect(overdueIds.length).toBe(2)
    }

    // B8.1 tải dược sĩ nhận (PM P1-1 + security P2): care_report theo session SM chỉ chứa dược sĩ/task trong vùng SM;
    // tải = số task ĐANG MỞ SM đọc được của từng dược sĩ (không phải tải toàn chuỗi).
    const smOpen = await browse(U.sm, { month: P10 }, '2026-10-31', `AND status = 'open'`)
    const smLoad = careOpenLoadByAssignee(await report(U.sm, P10))
    const want = new Map<string, number>()
    for (const r of smOpen) want.set(r.assignee_id, (want.get(r.assignee_id) ?? 0) + 1)
    expect(Object.fromEntries([...smLoad].filter(([, n]) => n > 0))).toEqual(Object.fromEntries(want))
    const superLoad = careOpenLoadByAssignee(await report(U.super, P10))
    expect([...superLoad.values()].reduce((s, n) => s + n, 0)).toBeGreaterThan([...smLoad.values()].reduce((s, n) => s + n, 0))

    // B8.1 "n sản phẩm": cùng dữ liệu embed (task_id, is_current) đọc bằng session SM — dòng revision cũ
    // (is_current=false, chèn trực tiếp mô phỏng revision) KHÔNG được tính.
    const smTask = (await browse(U.sm, { month: P10 }, '2026-10-31', 'ORDER BY id LIMIT 1'))[0]
    await db.query(`INSERT INTO public.care_task_products (task_id, batch_id, product_id, product_name, reason_type, reason_text, is_current)
      SELECT task_id, batch_id, product_id, product_name, reason_type, reason_text, false FROM public.care_task_products WHERE task_id = $1 AND is_current LIMIT 1`, [smTask.id])
    const flags = await L.as(db, U.sm, async () => (await db.query(`SELECT is_current FROM public.care_task_products WHERE task_id = $1`, [smTask.id])).rows)
    const currentN = await L.count(db, `SELECT count(*) FROM public.care_task_products WHERE task_id = '${smTask.id}' AND is_current`)
    expect(flags.length).toBe(currentN + 1)
    expect(careCurrentProductCount(flags)).toBe(currentN)
    // FK embed của danh sách phải tồn tại đúng tên.
    expect(fks).toContain('care_task_products_task_id_fkey')

    // Q-78: lịch sử 10 lượt/lần, keyset id ↓ — cùng truy vấn với loadCareInteractionsPage, chạy bằng session
    // người xem (RLS). Trang 1→3 = 10 + 10 + 3, không trùng/mất; DB giữ đủ 23 lượt.
    const historyPages = async (who: string, taskId: string) => {
      const pages: number[] = []
      const seenIds: number[] = []
      let before: number | null = null
      for (let guard = 0; guard < 10; guard++) {
        const t = await L.as(db, who, async () => (await db.query(`SELECT id, customer_id FROM public.care_tasks WHERE id = $1 AND NOT is_test`, [taskId])).rows[0])
        if (!t) return null                                                 // RLS không cho thấy task ⇒ không trả gì
        const fetched = await L.as(db, who, async () => (await db.query(
          `SELECT id, outcome, note, next_action_date::text, created_at::text, task_id, NULL::jsonb AS actor FROM public.care_interactions
           WHERE customer_id = $1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`,
          [t.customer_id, before, CARE_INTERACTION_PAGE_SIZE + 1])).rows)
        const page = careInteractionPage(fetched, taskId, Date.now())
        pages.push(page.rows.length)
        seenIds.push(...page.rows.map((r) => r.id))
        if (!page.hasMore) break
        before = page.nextBefore
      }
      return { pages, seenIds }
    }
    for (const who of [U.A, U.sm, U.super]) {
      const h = await historyPages(who, a0.id)
      expect(h?.pages, who).toEqual([10, 10, 3])
      expect(new Set(h!.seenIds).size).toBe(23)
      expect([...h!.seenIds].sort((x, y) => y - x)).toEqual(h!.seenIds)
    }
    expect(await historyPages(U.qlch1, a0.id)).toBeNull()                 // QLCH: không thấy task ⇒ không nạp được lượt nào
    expect(await historyPages(U.C, a0.id)).toBeNull()                     // staff store khác
    expect(await L.count(db, `SELECT count(*) FROM public.care_interactions WHERE task_id = $1`, [a0.id])).toBe(23)

    // Chuyển giao: lỗi RAISE thật của care__transfer_tasks_at → mã an toàn.
    const tErr = async (actor: string | null, ids: string[], to: string, note = 'QA chuyển') => {
      try { await L.transfer(db, '2026-10-20', actor, ids, to, note); return 'OK' } catch (e: any) { return mapCareTransferError(e.message) }
    }
    const [a3, a4] = (await tasksOf(U.A)).slice(3)
    // Khách của a4 đã từ chối tại QAOS02 (gắn vào lượt có thật).
    await L.record(db, '2026-10-07', U.A, a4.id, 'CALLBACK', 'QA', '2026-10-25')
    const iA4 = await L.one(db, `SELECT id FROM public.care_interactions WHERE task_id = $1`, [a4.id])
    await db.query(`INSERT INTO public.care_store_refusals (customer_id, store_id, interaction_id) VALUES ($1, $2, $3)`, [a4.customer_id, L.storeId(2), iA4.id])
    expect(await tErr(null, [a3.id], U.C)).toBe('UNAUTHENTICATED')
    expect(await tErr(U.qlch1, [a3.id], U.B)).toBe('FORBIDDEN')
    expect(await tErr(U.mkt, [a3.id], U.B)).toBe('FORBIDDEN')
    expect(await tErr(U.A, [a3.id], U.B)).toBe('FORBIDDEN')
    expect(await tErr(U.sm, [a3.id], U.B, '   ')).toBe('NOTE_REQUIRED')
    expect(await tErr(U.sm, [], U.B)).toBe('BATCH_SIZE')
    expect(await tErr(U.sm, [a3.id], U.qlch1)).toBe('TARGET_INVALID')
    expect(await tErr(U.super, [a3.id], U.staffFs)).toBe('TARGET_INVALID')
    expect(await tErr(U.super, [a3.id], U.staffInactive)).toBe('TARGET_INVALID')
    expect(await tErr(U.sm2, [a3.id], U.C)).toBe('TARGET_OUT_OF_SCOPE')
    expect(await tErr(U.sm2, [c1.id], U.A)).toBe('SOURCE_OUT_OF_SCOPE')
    expect(await tErr(U.sm, [L.uid(777777)], U.B)).toBe('TASK_NOT_FOUND')
    expect(await tErr(U.sm, [a2.id], U.B)).toBe('TASK_NOT_OPEN')
    expect(await tErr(U.sm, [a3.id], U.A)).toBe('SAME_OWNER')
    expect(await tErr(U.sm, [a4.id], U.C)).toBe('REFUSED_AT_TARGET')
    // Batch có một task lỗi ⇒ nguyên tử: không task nào đổi, không event.
    expect(await tErr(U.sm, [a3.id, a2.id], U.C)).toBe('TASK_NOT_OPEN')
    expect((await L.one(db, `SELECT assignee_id FROM public.care_tasks WHERE id = $1`, [a3.id])).assignee_id).toBe(U.A)
    expect(await L.count(db, `SELECT count(*) FROM public.care_assignment_events WHERE kind = 'transferred'`)).toBe(0)

    // Thành công (khác store, cùng SM): kết quả có 'transferred' (action đọc), A mất task, C thấy task + lịch sử.
    const ok = await L.transfer(db, '2026-10-20', U.sm, [a1.id, a3.id], U.C, 'QA dược sĩ nghỉ phép')
    expect(ok.transferred).toBe(2)
    expect(await browse(U.A, { month: P10 }, '2026-10-20', `AND id IN ('${a1.id}', '${a3.id}')`)).toHaveLength(0)
    expect(await browse(U.C, { month: P10 }, '2026-10-20', `AND id IN ('${a1.id}', '${a3.id}')`)).toHaveLength(2)
    const hist = await L.as(db, U.C, async () => (await db.query(`SELECT outcome, note FROM public.care_interactions WHERE customer_id = $1`, [a1.customer_id])).rows)
    expect(hist).toEqual([{ outcome: 'CALLBACK', note: 'QA hẹn sớm' }])          // lượt cũ giữ nguyên
    const ev = await L.as(db, U.C, async () => (await db.query(`SELECT kind, note, from_user_id, to_user_id, actor_id, from_store_id, to_store_id FROM public.care_assignment_events WHERE task_id = $1 AND kind = 'transferred'`, [a1.id])).rows)
    expect(ev).toEqual([{ kind: 'transferred', note: 'QA dược sĩ nghỉ phép', from_user_id: U.A, to_user_id: U.C, actor_id: U.sm, from_store_id: L.storeId(1), to_store_id: L.storeId(2) }])
    // SM2 (chỉ QAOS01) không còn thấy task đã sang QAOS02.
    expect(await browse(U.sm2, { month: P10 }, '2026-10-20', `AND id = '${a1.id}'`)).toHaveLength(0)
    // Chuyển lại lần nữa cùng lệnh (race/double-submit sau khi đã chuyển) ⇒ SAME_OWNER, không event mới.
    expect(await tErr(U.sm, [a1.id, a3.id], U.C)).toBe('SAME_OWNER')
    expect(await L.count(db, `SELECT count(*) FROM public.care_assignment_events WHERE kind = 'transferred'`)).toBe(2)

    // ── Q-79: SM chỉ đọc dữ liệu gắn store mình quản lý (store SNAPSHOT của từng dòng) ──────────────
    // Khách của c1 ở X = QAOS02 (ngoài vùng SM2) có ghi chú/DNC/attribution tại X, rồi task chuyển X → Y = QAOS01
    // (vùng SM2). SM2 thấy task Y + lượt/event chạm Y, KHÔNG thấy note X kể cả cùng task / "Xem thêm" / SELECT thẳng.
    const X = L.storeId(2), Y = L.storeId(1)
    const SM3 = L.uid(4501)                                                   // SM chỉ quản lý X
    await db.query(`INSERT INTO public.users (id, email, full_name, role) VALUES ($1, 'qa.sm3@example.invalid', 'QA SM3', 'sm')`, [SM3])
    await db.query(`INSERT INTO public.sm_store_assignments (sm_user_id, store_id) VALUES ($1, $2)`, [SM3, X])
    await L.record(db, '2026-10-12', U.C, c1.id, 'CALLBACK', 'QA ghi chú tại X — sức khoẻ', '2026-10-25')
    const iX = await L.one(db, `SELECT id FROM public.care_interactions WHERE task_id = $1`, [c1.id])
    const cust = await L.one(db, `SELECT external_id FROM public.care_customers WHERE id = $1`, [c1.customer_id])
    await db.query(`INSERT INTO public.care_store_refusals (customer_id, store_id, interaction_id) VALUES ($1, $2, $3)`, [c1.customer_id, X, iX.id])
    await db.query(`INSERT INTO public.care_orders (order_key, customer_external_id, ordered_at) VALUES ('QA-O79', $1, now())`, [cust.external_id])
    await db.query(`INSERT INTO public.care_order_attributions (order_key, interaction_id, task_id, customer_id, assignee_id, store_id, period_month)
      VALUES ('QA-O79', $1, $2, $3, $4, $5, $6)`, [iX.id, c1.id, c1.customer_id, U.C, X, P10])
    expect((await L.transfer(db, '2026-10-20', U.super, [c1.id], U.A, 'QA chuyển X→Y')).transferred).toBe(1)
    await L.record(db, '2026-10-21', U.A, c1.id, 'CALLBACK', 'QA ghi chú tại Y', '2026-10-28')
    const see = async (who: string) => L.as(db, who, async () => ({
      task: Number((await db.query(`SELECT count(*) n FROM public.care_tasks WHERE id = $1`, [c1.id])).rows[0].n),
      notes: (await db.query(`SELECT note FROM public.care_interactions WHERE customer_id = $1 ORDER BY id`, [c1.customer_id])).rows.map((r: any) => r.note),
      events: (await db.query(`SELECT kind FROM public.care_assignment_events WHERE task_id = $1 ORDER BY id`, [c1.id])).rows.map((r: any) => r.kind),
      dnc: Number((await db.query(`SELECT count(*) n FROM public.care_store_refusals WHERE customer_id = $1`, [c1.customer_id])).rows[0].n),
    }))
    // Q-95: không ai đọc thẳng attribution; phần "attribution X/Y" của Q-79 kiểm qua care_report (store snapshot).
    const attrDenied = (who: string) => L.raises(L.as(db, who, () => db.query(`SELECT count(*) FROM public.care_order_attributions`)), 'permission denied')
    const NOTE_X = 'QA ghi chú tại X — sức khoẻ', NOTE_Y = 'QA ghi chú tại Y'
    // SM vùng Y: task Y + lượt Y + event chuyển (đích Y); KHÔNG note X (cùng task), event 'assigned' tại X, DNC X.
    expect(await see(U.sm2)).toEqual({ task: 1, notes: [NOTE_Y], events: ['transferred'], dnc: 0 })
    // "Xem thêm" (cùng truy vấn với loadCareInteractionsPage) cũng chỉ trả lượt Y.
    const hSm2 = await historyPages(U.sm2, c1.id)
    expect(hSm2?.pages).toEqual([1])
    // SM vùng X: không thấy task (đã sang Y) nhưng thấy dữ liệu gắn X (note X, event giao/chuyển chạm X, DNC X).
    expect(await see(SM3)).toEqual({ task: 0, notes: [NOTE_X], events: ['assigned', 'transferred'], dnc: 1 })
    // SM quản lý cả X và Y: thấy đủ.
    expect(await see(U.sm)).toEqual({ task: 1, notes: [NOTE_X, NOTE_Y], events: ['assigned', 'transferred'], dnc: 1 })
    // Staff mới phụ trách (A): giữ quyền lịch sử đã chốt — thấy cả note X. Staff cũ (C): mất task ⇒ không còn gì.
    expect(await see(U.A)).toEqual({ task: 1, notes: [NOTE_X, NOTE_Y], events: ['assigned', 'transferred'], dnc: 1 })
    expect(await see(U.C)).toEqual({ task: 0, notes: [], events: [], dnc: 0 })
    // Super / care admin toàn chuỗi; QLCH vẫn 0.
    for (const who of [U.super, U.mkt]) expect(await see(who)).toEqual({ task: 1, notes: [NOTE_X, NOTE_Y], events: ['assigned', 'transferred'], dnc: 1 })
    expect(await see(U.qlch1)).toEqual({ task: 0, notes: [], events: [], dnc: 0 })
    for (const who of [U.sm2, SM3, U.sm, U.A, U.C, U.super, U.mkt, U.qlch1]) expect(await attrDenied(who), who).toBe(true)
    // care_report theo store snapshot (Q-79) — kênh DUY NHẤT xem Có đơn (Q-95): attribution tại X không vào vùng Y.
    const conv = async (who: string) => (await report(who, P10)).reduce((n, r) => n + r.converted_tasks, 0)
    expect(await conv(U.sm2)).toBe(0)
    expect(await conv(SM3)).toBe(1)
    expect(await conv(U.sm)).toBe(1)
    expect(await conv(U.qlch1)).toBe(0)

    // Sang kỳ 11: kỳ 10 thành kỳ cũ — "Không hoàn thành" ≠ "Từng trễ hẹn"; không còn "quá hạn đang mở".
    await db.query(`SELECT public.care__close_period_at('2026-11-01')`)
    expect(await tErr(U.sm, [c1.id], U.D)).toBe('TASK_NOT_OPEN')
    const old = await browse(U.super, { month: P10 }, '2026-11-01')
    const tot = careReportTotals(await report(U.super, P10))
    expect(tot).toEqual(derive(old, '2026-11-01'))
    expect(tot.completed).toBe(2)
    expect(tot.closedUnfinished).toBe(248)
    expect(tot.overdueInPeriod).toBeGreaterThanOrEqual(3)          // a1, b0 trễ trong kỳ; a0 hẹn 31/10 trễ khi đóng kỳ
    expect(tot.overdueInPeriod).toBeLessThan(tot.closedUnfinished)
    expect(await browse(U.super, { month: P10, status: 'overdue_open' }, '2026-11-01')).toHaveLength(0)
    expect(old.every((r: any) => careTaskState(r, '2026-11-01').overdueOpen === false)).toBe(true)
  })
})
