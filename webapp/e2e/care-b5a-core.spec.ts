import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, expect } from '@playwright/test'
import { CARE_N3_COLUMNS, CARE_N3_MAX_ROWS, normalizeN3Timestamp, parseN3Rows, type CareN3Order } from '../lib/care/orders/n3'
import {
  CARE_ORDER_NO_DATA, CARE_ORDER_NOT_SEEN, CARE_REPORT_EXPORT_MAX_ROWS, careOrderDataState, careOrderNotSeenText,
  careReportConvertedTotal, careReportExportRows, careReportLines, careReportSummary, careStoreFilterInScope, vnDateTime,
  careReportExtrasKey, careReportGroups, careReportKey, carePeriodElapsed, carePct, CARE_REPORT_LINK_STATUS,
} from '../lib/care/reports'
import { carePermissions, careNavItems, type CareAccess, type CareReportRow } from '../lib/care/browse'
import { buildCareImportRows, defaultFixtureStores } from './careImportFixture'

// CRM-CSKH B5a r1.1 (SPEC §B5a r1.1, Q-91/Q-93) — (1) parser/validator BA cột N3 r3.4 + khung ingest ·
// (2) báo cáo/export thuần: chỉ "Khách có đơn" (DISTINCT task) + freshness, KHÔNG số đơn/tiền ·
// (3) source: cổng cờ/quyền, session-only, filter store ngoài scope không nới, không bảng nhạy cảm ·
// (4) PGlite 114: parser → care_orders → care_recompute_attribution (biên micro giây) → care_report →
// dòng báo cáo/export theo scope. Không BigQuery thật, không DB thật (B5b/B6).

const ROOT = path.resolve(__dirname, '..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n')
const HAS_PGLITE = fs.existsSync(path.join(ROOT, 'node_modules', '@electric-sql', 'pglite'))

const n3 = (o: Partial<Record<(typeof CARE_N3_COLUMNS)[number], unknown>> = {}) => ({
  customer_external_id: 'QA-K1', order_key: 'DHC-0001', ordered_at: '2026-10-05T03:00:00Z', ...o,
})

// HỢP ĐỒNG BI (tài liệu sống, KHÔNG phải code app — B5b mới nối nguồn thật): bảng N3 chỉ chứa đơn
// POS/online status='COMPLETED' có completed_at; ordered_at = completed_at UTC; created_at KHÔNG dùng.
// CANCELED/status khác không vào bảng; đơn có return nhưng status vẫn COMPLETED vẫn là một dòng (Q-93).
interface RawOrderFixture { code: string; customer_id: string; status: string; created_at: string; completed_at: string | null; has_return?: boolean }
const biProjectN3 = (raw: readonly RawOrderFixture[]) => raw
  .filter((o) => o.status === 'COMPLETED' && o.completed_at !== null)
  .map((o) => ({ customer_external_id: o.customer_id, order_key: o.code, ordered_at: o.completed_at }))

test.describe('care B5a r1.1 — parser BA cột N3 + khung ingest @desktop', () => {
  test('hợp đồng đúng ba cột; ISO có múi giờ ⇒ UTC micro giây', () => {
    expect(CARE_N3_COLUMNS).toEqual(['customer_external_id', 'order_key', 'ordered_at'])
    expect(normalizeN3Timestamp('2026-10-05T03:00:00Z')).toBe('2026-10-05T03:00:00.000000Z')
    expect(normalizeN3Timestamp('2026-10-05T10:00:00.000500+07:00')).toBe('2026-10-05T03:00:00.000500Z')      // giữ micro giây
    expect(normalizeN3Timestamp('2026-10-01 01:30:00.5-0500')).toBe('2026-10-01T06:30:00.500000Z')
    expect(normalizeN3Timestamp('2026-12-31T23:59:59.999999+00:00')).toBe('2026-12-31T23:59:59.999999Z')
    expect(normalizeN3Timestamp('2026-01-01T06:00:00+07:00')).toBe('2025-12-31T23:00:00.000000Z')           // qua năm
    for (const bad of ['2026-10-05T03:00:00', '2026-10-05', '1.7280576E9', '1728057600', '2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z',
      '2026-10-05T24:00:00Z', '2026-10-05T03:00:00.1234567Z', '2026-10-05T03:00:00+15:00', '0050-01-01T00:00:00Z', '1969-12-31T23:59:59Z', '2101-01-01T00:00:00Z', '', null, 1728057600]) {
      expect(normalizeN3Timestamp(bad), String(bad)).toBeNull()
    }
  })

  test('lô hợp lệ: đơn POS + online (khoá DHC chung) + trùng giống hệt bị bỏ; thứ tự giữ nguyên', () => {
    const r = parseN3Rows([
      n3(),
      n3({ order_key: 'DHC-ONL-0001', ordered_at: '2026-10-06T08:00:00+07:00' }),
      n3({ order_key: 'DHC-0002', customer_external_id: 'QA-K2' }),
      n3(),                                                                                 // trùng y hệt ⇒ bỏ
    ])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.duplicatesDropped).toBe(1)
    expect(r.orders satisfies CareN3Order[]).toEqual([
      { order_key: 'DHC-0001', customer_external_id: 'QA-K1', ordered_at: '2026-10-05T03:00:00.000000Z' },
      { order_key: 'DHC-ONL-0001', customer_external_id: 'QA-K1', ordered_at: '2026-10-06T01:00:00.000000Z' },
      { order_key: 'DHC-0002', customer_external_id: 'QA-K2', ordered_at: '2026-10-05T03:00:00.000000Z' },
    ])
    for (const o of r.orders) expect(Object.keys(o).sort()).toEqual(['customer_external_id', 'order_key', 'ordered_at'])
  })

  test('lỗi ⇒ CẢ lô ok:false; thiếu/sai/thừa cột/trùng mâu thuẫn; lỗi chỉ có vị trí + mã (không PII)', () => {
    const r = parseN3Rows([
      n3({ customer_external_id: '' }),                                // 0 ID rỗng
      n3({ customer_external_id: ' QA-K1' }),                          // 1 khoảng trắng đầu
      n3({ order_key: 'x'.repeat(201) }),                              // 2 key quá dài
      n3({ ordered_at: '2026-10-05T03:00:00' }),                       // 3 thiếu múi giờ
      n3({ ordered_at: '1.7280576E9' }),                               // 4 dạng giây số thực BQ
      n3({ ordered_at: null }),                                        // 5 completed_at NULL (Q-93: không được có)
      { ...n3(), order_net_amount: '500000' },                         // 6 cột tiền r3.2 cũ ⇒ thừa cột
      { ...n3(), status: 'COMPLETED' },                                // 7 cột status ⇒ thừa cột (BI lọc trước)
      (({ ordered_at: _t, ...rest }) => rest)(n3()),                   // 8 thiếu cột
      'không phải object',                                             // 9
      n3({ order_key: 'DUP', ordered_at: '2026-10-05T03:00:00Z' }),    // 10
      n3({ order_key: 'DUP', ordered_at: '2026-10-05T04:00:00Z' }),    // 11 cùng key, giờ khác ⇒ xung đột
      n3({ order_key: 'DUP2' }),                                       // 12
      n3({ order_key: 'DUP2', customer_external_id: 'QA-K9' }),        // 13 cùng key, khách khác ⇒ xung đột
    ])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toEqual([
      { row: 0, code: 'CUSTOMER_ID_INVALID' }, { row: 1, code: 'CUSTOMER_ID_INVALID' }, { row: 2, code: 'ORDER_KEY_INVALID' },
      { row: 3, code: 'ORDERED_AT_INVALID' }, { row: 4, code: 'ORDERED_AT_INVALID' }, { row: 5, code: 'ORDERED_AT_INVALID' },
      { row: 6, code: 'COLUMNS_MISMATCH' }, { row: 7, code: 'COLUMNS_MISMATCH' }, { row: 8, code: 'COLUMNS_MISMATCH' },
      { row: 9, code: 'ROW_NOT_OBJECT' }, { row: 10, code: 'ORDER_KEY_CONFLICT' }, { row: 11, code: 'ORDER_KEY_CONFLICT' },
      { row: 12, code: 'ORDER_KEY_CONFLICT' }, { row: 13, code: 'ORDER_KEY_CONFLICT' },
    ])
    expect(JSON.stringify(r)).not.toMatch(/QA-K|DHC-|DUP/)
    const tooMany = parseN3Rows(Array.from({ length: 4 }, (_, i) => n3({ order_key: `K${i}` })), 3)
    expect(tooMany).toEqual({ ok: false, errors: [{ row: 3, code: 'TOO_MANY_ROWS' }] })
    expect(CARE_N3_MAX_ROWS).toBe(20_000)
    // Trần một lô parser ≤ trần khách VÀ trần đơn của care_recompute_attribution (lô hợp lệ không bao giờ kẹt).
    const sql = fs.readFileSync(path.join(ROOT, '..', 'supabase', 'migrations', '114_care_crm_foundation.sql'), 'utf8')
    const cap = /IF cardinality\(v_ext\) > (\d+) OR cardinality\(v_keys\) > (\d+) THEN/.exec(sql)!
    expect(CARE_N3_MAX_ROWS).toBeLessThanOrEqual(Number(cap[1]))
    expect(CARE_N3_MAX_ROWS).toBeLessThanOrEqual(Number(cap[2]))
  })

  test('hợp đồng BI (tài liệu): chỉ COMPLETED, ordered_at = completed_at; CANCELED loại; return còn COMPLETED vẫn tính', () => {
    const raw: RawOrderFixture[] = [
      { code: 'DHC-A', customer_id: 'QA-K1', status: 'COMPLETED', created_at: '2026-10-01T02:00:00Z', completed_at: '2026-10-06T03:00:00Z' },
      { code: 'DHC-B', customer_id: 'QA-K1', status: 'CANCELED', created_at: '2026-10-02T02:00:00Z', completed_at: null },
      { code: 'DHC-C', customer_id: 'QA-K2', status: 'COMPLETED', created_at: '2026-10-03T02:00:00Z', completed_at: '2026-10-03T05:00:00Z', has_return: true },
      { code: 'DHC-D', customer_id: 'QA-K2', status: 'PROCESSING', created_at: '2026-10-04T02:00:00Z', completed_at: null },
    ]
    const r = parseN3Rows(biProjectN3(raw))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.orders.map((o) => o.order_key)).toEqual(['DHC-A', 'DHC-C'])
    // Mốc so với lượt chăm sóc = completed_at, KHÔNG phải created_at (đơn tạo 01/10, hoàn tất 06/10).
    expect(r.orders[0].ordered_at).toBe('2026-10-06T03:00:00.000000Z')
  })

  test('cấu hình nguồn N3 mặc định OFF/trống; một đường ingest (sync.ts, B5b.2); không tiền/status/cursor trong module', () => {
    // B5b.2 thay khung ingest B5a bằng lib/care/orders/sync.ts — không để hai đường ghi đơn song song.
    expect(fs.existsSync(path.join(ROOT, 'lib/care/orders/ingest.ts'))).toBe(false)
    expect(read('.env.example')).toMatch(/^CARE_SYNC_ENABLED=false$/m)
    expect(read('.env.example')).toMatch(/^CARE_BQ_ORDERS_TABLE=\s*$/m)
    // Module thuần: không Next/Supabase/BigQuery; không đoán tên cột nguồn raw; không cột tiền/status/cursor.
    for (const f of ['lib/care/orders/n3.ts', 'lib/care/orders/sync.ts', 'lib/care/reports.ts']) {
      expect(read(f), f).not.toMatch(/from ['"](next|@supabase|@\/lib\/supabase|@\/lib\/bigquery|server-only)/)
      expect(read(f), f).not.toMatch(/['"](order_net_amount|net_amount|pos_code|source_updated_at|status|net_revenue)['"]/)
    }
    expect(read('lib/care/orders/n3.ts')).not.toMatch(/['"](entity_id|total_amount|updated_at|completed_at|created_date|code|buymed_circa_v2)['"]/)
  })
})

const row = (o: Partial<CareReportRow> = {}): CareReportRow => ({
  store_id: 's1', assignee_id: 'u1', tasks_total: 10, completed: 6, open_not_cared: 2, open_in_progress: 2, overdue_in_period: 1,
  closed_unfinished: 0, converted_tasks: 3, ...o,
})

test.describe('care B5a r1.1 — báo cáo + export thuần: chỉ Khách có đơn, không giả 0 @desktop', () => {
  test('trạng thái dữ liệu đơn: chưa đồng bộ ⇒ none; đã đồng bộ ⇒ mốc + cờ lỗi; câu "chưa thấy đơn"', () => {
    expect(careOrderDataState(null)).toEqual({ kind: 'none' })
    expect(careOrderDataState({ has_synced: false, last_success_at: null, last_failed: false })).toEqual({ kind: 'none' })
    expect(careOrderDataState({ has_synced: true, last_success_at: '2026-10-20T01:05:00Z', last_failed: true }))
      .toEqual({ kind: 'synced', lastSuccessAt: '2026-10-20T01:05:00Z', lastFailed: true })
    expect(vnDateTime('2026-10-20T01:05:00Z')).toBe('08:05 20/10/2026')
    expect(vnDateTime('2026-10-19T23:00:00+00:00')).toBe('06:00 20/10/2026')
    expect(CARE_ORDER_NO_DATA).toBe('Chưa có dữ liệu đơn')
    expect(CARE_ORDER_NOT_SEEN).toBe('Chưa thấy đơn theo dữ liệu đến lần đồng bộ')
    expect(careOrderNotSeenText({ kind: 'synced', lastSuccessAt: '2026-10-20T01:05:00Z', lastFailed: true }))
      .toBe('Chưa thấy đơn theo dữ liệu đến lần đồng bộ 08:05 20/10/2026')                  // lỗi sau ⇒ vẫn mốc thành công cuối
  })

  test('dòng báo cáo: một dòng RPC = một dòng; sắp theo store rồi tên; tổng Khách có đơn = cộng task', () => {
    const stores = new Map([['s1', { code: 'QAOS02', name: 'B' }], ['s2', { code: 'QAOS01', name: 'A' }]])
    const names = new Map([['u1', 'Bình'], ['u2', 'An']])
    const lines = careReportLines([row(), row({ assignee_id: 'u2', converted_tasks: 1 }), row({ store_id: 's2', tasks_total: 5, converted_tasks: 0 }), row({ store_id: 'sX', assignee_id: 'uX' })], { stores, names })
    expect(lines.map((l) => `${l.storeCode}|${l.assigneeName}`)).toEqual(['QAOS01|Bình', 'QAOS02|An', 'QAOS02|Bình', '—|—'])
    const t = careReportSummary(lines)
    expect([t.tasks, t.completed, t.convertedTasks]).toEqual([35, 24, 7])
    // B8.2: thêm `contacted` (Q-113 — Đã liên hệ); vẫn không có khoá tiền/số đơn.
    expect(Object.keys(t).sort()).toEqual(['closedUnfinished', 'completed', 'contacted', 'convertedTasks', 'inProgress', 'notCared', 'overdueInPeriod', 'tasks'])
    expect(Object.keys(lines[0])).not.toEqual(expect.arrayContaining(['orders']))
    expect(careReportConvertedTotal([row(), row({ converted_tasks: 1 })])).toBe(4)
  })

  test('filter store ngoài scope: không nới thành toàn scope', () => {
    const scope = [{ id: 's1' }, { id: 's2' }]
    expect(careStoreFilterInScope(null, scope)).toBe(true)
    expect(careStoreFilterInScope('s2', scope)).toBe(true)
    expect(careStoreFilterInScope('s9', scope)).toBe(false)
    expect(careStoreFilterInScope('s1', [])).toBe(false)
  })

  test('export: cùng dòng màn hình + TỔNG; chỉ cột "Khách có đơn"; trước đồng bộ ghi "Chưa có dữ liệu đơn"; không SĐT/ID/tiền', () => {
    const lines = careReportLines([row(), row({ assignee_id: 'u2' })], { stores: new Map([['s1', { code: 'QAOS01', name: 'A' }]]), names: new Map([['u1', 'B'], ['u2', 'C']]) })
    const t = careReportSummary(lines)
    const none = careReportExportRows(lines, t, { kind: 'none' }, '10/2026')
    expect(none).toHaveLength(3)
    expect(Object.keys(none[0])).toEqual(['Kỳ chăm sóc', 'Cửa hàng', 'Tên cửa hàng', 'Dược sĩ', 'Khách (task)', 'Hoàn thành', 'Chưa chăm sóc',
      'Đang theo dõi', 'Từng trễ hẹn', 'Không hoàn thành', 'Khách có đơn', 'Dữ liệu đơn cập nhật'])
    expect(none[0]).toMatchObject({ 'Kỳ chăm sóc': '10/2026', 'Cửa hàng': 'QAOS01', 'Dược sĩ': 'B', 'Khách (task)': 10, 'Khách có đơn': CARE_ORDER_NO_DATA, 'Dữ liệu đơn cập nhật': CARE_ORDER_NO_DATA })
    expect(none[2]).toMatchObject({ 'Cửa hàng': 'TỔNG', 'Khách (task)': 20 })
    const synced = careReportExportRows(lines, t, { kind: 'synced', lastSuccessAt: '2026-10-20T01:05:00Z', lastFailed: false }, '10/2026')
    expect(synced[2]).toMatchObject({ 'Khách có đơn': 6, 'Dữ liệu đơn cập nhật': '08:05 20/10/2026' })
    const stale = careReportExportRows(lines, t, { kind: 'synced', lastSuccessAt: '2026-10-20T01:05:00Z', lastFailed: true }, '10/2026')
    expect(stale[0]).toMatchObject({ 'Khách có đơn': 3 })                                     // lỗi sau ⇒ giữ số cũ
    expect(stale[0]['Dữ liệu đơn cập nhật']).toContain('lần gần nhất lỗi')
    expect(careReportExportRows([], careReportSummary([]), { kind: 'none' }, '10/2026')).toEqual([])
    for (const k of Object.keys(synced[0])) expect(k).not.toMatch(/SĐT|phone|ID khách|external|Số đơn|Doanh thu|VND|tiền/i)
    expect(CARE_REPORT_EXPORT_MAX_ROWS).toBe(5000)
  })

  test('nav + quyền: "Báo cáo" chỉ cho người xem CRM; QLCH/staff/admin không quyền không có', () => {
    const acc = (o: Partial<CareAccess>): CareAccess => ({ role: null, is_super: false, can_import: false, can_view_all: false, scope_store_count: 0, ...o })
    expect(careNavItems(carePermissions(acc({ role: 'sm', scope_store_count: 2 }))).map((x) => x.href)).toContain('/care/reports')
    expect(careNavItems(carePermissions(acc({ role: 'admin', can_view_all: true }))).map((x) => x.href)).toContain('/care/reports')
    for (const a of [acc({ role: 'store_manager', scope_store_count: 1, can_view_all: true }), acc({ role: 'staff' }), acc({ role: 'admin', can_import: true })]) {
      expect(careNavItems(carePermissions(a)).map((x) => x.href)).not.toContain('/care/reports')
    }
  })
})

test.describe('care B8.2 — báo cáo /care/reports: Đã liên hệ, nhóm store, nhịp kỳ, link đúng tập @desktop', () => {
  const S = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const row = (store: number, a: number, o: Partial<CareReportRow>): CareReportRow => ({ store_id: S(store), assignee_id: S(a), tasks_total: 0, completed: 0,
    open_not_cared: 0, open_in_progress: 0, overdue_in_period: 0, closed_unfinished: 0, converted_tasks: 0, ...o })
  const ctx = { stores: new Map([[S(1), { code: 'QAOS01', name: 'A' }], [S(2), { code: 'QAOS02', name: 'B' }]]), names: new Map([[S(9), 'DS 9'], [S(8), 'DS 8'], [S(7), 'DS 7']]) }

  test('Đã liên hệ (Q-113) = Hoàn thành + Đang theo dõi + Không hoàn thành CÓ lượt (kỳ cũ); không tính chưa chăm sóc', () => {
    const cur = careReportLines([row(1, 9, { tasks_total: 10, completed: 3, open_in_progress: 2, open_not_cared: 5 })], ctx)
    expect(cur[0].contacted).toBe(5)
    const past = careReportLines([row(1, 9, { tasks_total: 10, completed: 3, closed_unfinished: 7 })], ctx, new Map([[careReportKey(S(1), S(9)), 4]]))
    expect(past[0].contacted).toBe(7)
    // Phòng thủ: touched không vượt closed_unfinished.
    expect(careReportLines([row(1, 9, { tasks_total: 2, closed_unfinished: 1 })], ctx, new Map([[careReportKey(S(1), S(9)), 5]]))[0].contacted).toBe(1)
    expect(careReportSummary([...cur, ...past]).contacted).toBe(12)
  })

  test('nhóm theo cửa hàng: tổng phụ = cộng đúng dòng của store; tổng chung = cộng mọi dòng (không cộng lại tổng phụ)', () => {
    const lines = careReportLines([row(1, 9, { tasks_total: 4, completed: 1 }), row(2, 7, { tasks_total: 6, completed: 2 }), row(1, 8, { tasks_total: 5, completed: 3 })], ctx)
    const g = careReportGroups(lines)
    expect(g.map((x) => [x.storeCode, x.lines.length, x.totals.tasks, x.totals.completed])).toEqual([['QAOS01', 2, 9, 4], ['QAOS02', 1, 6, 2]])
    expect(careReportSummary(lines).tasks).toBe(15)
  })

  test('nhịp kỳ (Q-114): ngày VN tính cả hôm nay; kỳ cũ = 100% "đã kết thúc"; tháng 2 và tháng 31 ngày', () => {
    expect(carePeriodElapsed('2026-10-01', '2026-10-13')).toEqual({ elapsedDays: 13, totalDays: 31, pct: 42, ended: false })
    expect(carePeriodElapsed('2026-10-01', '2026-10-31')).toEqual({ elapsedDays: 31, totalDays: 31, pct: 100, ended: false })
    expect(carePeriodElapsed('2026-09-01', '2026-10-01')).toEqual({ elapsedDays: 30, totalDays: 30, pct: 100, ended: true })
    expect(carePeriodElapsed('2027-02-01', '2027-02-14').totalDays).toBe(28)
    expect(carePct(210, 285)).toBe(74)
    expect(carePct(5, 0)).toBe(0)
  })

  test('link số liệu (PM B8 P1): chỉ cột có filter /care/tasks trả CÙNG tập; KHÔNG Từng trễ hẹn / Có đơn / Đã liên hệ', () => {
    expect(CARE_REPORT_LINK_STATUS).toEqual({ tasks: null, completed: 'completed', notCared: 'not_cared', inProgress: 'following', closedUnfinished: 'closed_unfinished' })
    for (const k of ['overdueInPeriod', 'convertedTasks', 'contacted']) expect(Object.keys(CARE_REPORT_LINK_STATUS)).not.toContain(k)
  })

  test('source: loader đọc Đã liên hệ + touched qua session/scope song song care_report; trang stream Kết quả; export KHÔNG thêm cột', () => {
    const b = read('lib/care/server/browse.ts')
    expect(b).toMatch(/export async function loadCareContactedCount[\s\S]*?withCareFilters\(supabase\.from\('care_tasks'\)\.select\('id', \{ count: 'exact', head: true \}\), \{ \.\.\.f, status: null \}, todayISO\)\s*\.not\('last_interaction_at', 'is', null\)/)
    expect(b).toMatch(/export async function loadCareClosedTouched[\s\S]*?\{ \.\.\.f, status: 'closed_unfinished' \}, todayISO\)\s*\.not\('last_interaction_at', 'is', null\)/)
    expect(b).toMatch(/export async function loadCareReportOutcomes[\s\S]*?CARE_OUTCOME_KEYS\.filter\(\(k\) => k !== 'none'\)[\s\S]*?\.eq\('last_outcome', k\)/)
    const l = read('lib/care/server/reports.ts')
    // Đường chính: care_report + sync_status + touched (chỉ kỳ đã đóng) — count KPI KHÔNG ở đây (stream ở trang).
    expect(l).toMatch(/const \[rep, st, touched\] = await Promise\.all\(\[/)
    expect(l).toContain('careReportLines(rows, { stores: storeMap, names }, touched)')
    expect(l).not.toMatch(/loadCareContactedCount\(/)
    expect(l.indexOf('if (!careStoreFilterInScope(f.storeId, stores))')).toBeLessThan(l.indexOf('loadCareClosedTouched(rf, today)'))
    // Kỳ đang mở không đọc touched (chưa có task đóng); export không đọc phần Đã liên hệ (cột Excel không có).
    expect(l).toContain('withContacted && f.month < carePeriodOf(new Date()) ? loadCareClosedTouched(rf, today) : Promise.resolve(new Map<string, number>())')
    expect(l).toContain('const rf = { month: f.month, storeId, assigneeId: null }')
    expect(read('app/api/export/care/route.ts')).toContain('loadCareReport(v.perms, f, { withContacted: false })')
    expect(read('app/(dashboard)/care/reports/page.tsx')).toContain('const d = await loadCareReport(g.perms, f)')
    const page = read('app/(dashboard)/care/reports/page.tsx')
    // "Đã liên hệ" + "Kết quả" tải SAU khi trang hiện (đo 14/10: 7 count trong Suspense tranh pool với render khung
    // ⇒ +100–130 ms) — MỘT server action qua provider; ô KPI/thanh nhịp/khối kết quả đọc chung.
    // PM B8.2 r1: `key` theo bộ lọc (kỳ/store/dược sĩ) ⇒ đổi bộ lọc là provider mới, không mang số bộ lọc cũ.
    expect(page).toContain('const extras = { month: f.month.slice(0, 7), store: scoped.storeId, assignee: scoped.assigneeId }')
    expect(page).toContain('<CareReportExtrasProvider key={careReportExtrasKey(extras)} load={loadCareReportExtras} params={extras}>')
    expect(careReportExtrasKey({ month: '2026-10', store: null, assignee: null })).toBe('2026-10||')
    expect(new Set([
      careReportExtrasKey({ month: '2026-10', store: 's1', assignee: null }), careReportExtrasKey({ month: '2026-10', store: null, assignee: 's1' }),
      careReportExtrasKey({ month: '2026-09', store: 's1', assignee: null }), careReportExtrasKey({ month: '2026-10', store: 's1', assignee: 'u1' }),
    ]).size).toBe(4)
    expect(page).toContain('contacted={{ kpi: <CareContactedKpiLive tasks={d.totals.tasks} />, pace: <CareContactedPaceLive tasks={d.totals.tasks} /> }}')
    expect(page).toContain('outcomes={<CareReportOutcomesLive />}')
    expect(page).not.toMatch(/loadCareContactedCount|loadCareReportOutcomes|Suspense/)
    expect(page).toContain("<CareReportExportLink href={careFilterHref('/api/export/care', scoped)} />")
    // Action: cờ TRƯỚC TIÊN → session care_my_access → canView → parser URL chung (chỉ thu hẹp) → đọc session/RLS.
    const act = read('app/actions/careReports.ts')
    expect(act).toMatch(/^'use server'/)
    const fn = /export async function loadCareReportExtras\([\s\S]*?\{\n([\s\S]*?)\n\}/.exec(act)![1]
    expect(fn.trimStart()).toMatch(/^if \(!isCareEnabled\(\)\) return/)
    expect(fn).toMatch(/const v = await getCareViewAccess\(\)\s*if \(v\.kind !== 'ok' \|\| !v\.perms\.canView\) return/)
    expect(fn.indexOf('parseCareFilters(')).toBeLessThan(fn.indexOf('loadCareContactedCount(rf, today)'))
    // Store ngoài phạm vi ⇒ lỗi (không trả 0), kiểm TRƯỚC khi đếm.
    expect(fn).toContain('if (f.storeId && !careStoreFilterInScope(f.storeId, await loadScopeStores(v.perms))) return { ok: false, message: CARE_REPORT_STORE_OUT_OF_SCOPE }')
    expect(fn.indexOf('careStoreFilterInScope(')).toBeLessThan(fn.indexOf('loadCareContactedCount(rf, today)'))
    expect(fn).toContain('await Promise.all([loadCareContactedCount(rf, today), loadCareReportOutcomes(rf, today)])')
    expect(act).not.toMatch(/supabaseAdmin|service_role|console\.(log|error|warn)|phone|customer_name/)
    // Client: lỗi ⇒ "—"/"Không tải được"; đang tải ⇒ "…" (không 0 giả); phản hồi cũ không ghi đè (seq).
    const ex = read('components/care/CareReportExtras.tsx')
    expect(ex).toMatch(/^'use client'/)
    expect(ex).toContain('if (s.kind === \'error\') return <CareKpiTile label={LABEL} value="—"')
    expect(ex).toContain('if (s.kind === \'loading\') return <CareKpiTile label={LABEL} value="…"')
    expect(ex).toContain('const done = (s: State) => { if (my === seq.current) setGot({ key, s }) }')
    // Chặn lúc render (không chỉ dựa `key`): kết quả chỉ dùng khi khoá khớp bộ lọc HIỆN TẠI, lệch ⇒ "đang tải".
    expect(ex).toContain("const state: State = got && got.key === key ? got.s : { kind: 'loading' }")
    expect(ex).toContain('const key = careReportExtrasKey(params)')
    expect(ex).not.toMatch(/setState\(|useState<State>/)
    expect(read('components/care/CareReportOutcomes.tsx')).not.toMatch(/server|loadCare/)
    // Catalog: action giả tự kiểm cổng (UI_CATALOG + super).
    const cat = read('app/(dashboard)/ui-catalog/care-reports/page.tsx')
    expect(cat).toContain('<CareReportExtrasProvider key={careReportExtrasKey(params)} load={fakeExtras} params={params}>')
    expect(cat).toMatch(/async function fakeExtras\([^)]*\) \{\s*'use server'\s*if \(!\(await gate\(\)\)\) return/)
    expect([...cat.matchAll(/async function (fake\w+)\(/g)].map((m) => m[1])).toEqual(['fakeExtras'])
    // Export giữ hợp đồng cột B5a (không tự thêm KPI Đã liên hệ).
    const exp = careReportExportRows(careReportLines([row(1, 9, { tasks_total: 3, completed: 1, open_in_progress: 1 })], ctx), careReportSummary([]), { kind: 'none' }, '10/2026')
    expect(Object.keys(exp[0])).toEqual(['Kỳ chăm sóc', 'Cửa hàng', 'Tên cửa hàng', 'Dược sĩ', 'Khách (task)', 'Hoàn thành', 'Chưa chăm sóc', 'Đang theo dõi', 'Từng trễ hẹn', 'Không hoàn thành', 'Khách có đơn', 'Dữ liệu đơn cập nhật'])
    // Link bảng: chỉ qua CARE_REPORT_LINK_STATUS (không tự dựng href cho cột khác).
    const v = read('components/care/CareReportView.tsx')
    expect(v).toContain("const status = CARE_REPORT_LINK_STATUS[link] as CareStatusFilter | null")
    expect(v).toContain("{n('contacted')}")
    expect(v).toContain("{n('overdueInPeriod')}")
    expect(v).toContain("{orderCell(t.convertedTasks, storeId, assigneeId)}") // E3: ô Có đơn thành link cohort chỉ khi conversionHref (parity)
    expect(v).toContain('if (!hasOrders) return \'—\'')
    expect(v).toContain('if (!conversionHref || v <= 0) return fmt(v)')
  })
})

test.describe('care B5a r1.1 — source: cổng cờ/quyền, session-only, cùng mapper, không tiền @desktop', () => {
  test('page /care/reports + export: cờ trước tiên → quyền xem CRM → loadCareReport (session); không service role', () => {
    const page = read('app/(dashboard)/care/reports/page.tsx')
    expect(page).toMatch(/export default async function \w+\([^)]*\)[^{]*\{\s*const g = await requireCareViewer\(\)/)
    const route = read('app/api/export/care/route.ts')
    const body = /export async function GET\(request: NextRequest\) \{\n([\s\S]*?)\n\}/.exec(route)![1]
    expect(body.trimStart()).toMatch(/^if \(!isCareEnabled\(\)\) return NextResponse\.json\(\{ error: 'Not found' \}, \{ status: 404 \}\)/)
    expect(body.indexOf('getCareViewAccess()')).toBeLessThan(body.indexOf('loadCareReport('))
    expect(body).toMatch(/if \(!v\.perms\.canView\) return NextResponse\.json\(\{ error: 'Không có quyền' \}, \{ status: 403 \}\)/)
    // Filter store ngoài scope ⇒ lỗi filter TRƯỚC khi xuất (không xuất toàn scope).
    expect(body).toMatch(/if \(d\.storeOutOfScope\) return NextResponse\.json\(\{ error: '[^']+' \}, \{ status: 400 \}\)/)
    expect(body.indexOf('d.storeOutOfScope')).toBeLessThan(body.indexOf('careReportExportRows('))
    expect(body).toContain('d.lines.length > CARE_REPORT_EXPORT_MAX_ROWS')
    expect(body).toContain('careReportExportRows(d.lines, d.totals, d.orderState, monthLabel)')
    for (const [f, src] of [['page', page], ['route', route]] as const) {
      expect(src, f).toContain('loadCareReport(')
      expect(src, f).toContain('parseCareFilters(')
    }
    expect(page).toMatch(/d\.storeOutOfScope \? \(/)
    for (const f of ['app/(dashboard)/care/reports/page.tsx', 'app/api/export/care/route.ts', 'lib/care/server/reports.ts', 'components/care/CareReportView.tsx', 'components/care/CareReportOutcomes.tsx', 'components/care/CareReportExtras.tsx', 'app/actions/careReports.ts', 'app/(dashboard)/ui-catalog/care-reports/page.tsx']) {
      expect(read(f), f).not.toMatch(/supabaseAdmin|supabase\/admin|SERVICE_ROLE|service_role/)
    }
    const loader = read('lib/care/server/reports.ts')
    expect(loader).toMatch(/^import 'server-only'/)
    expect(loader).toContain("supabase.rpc('care_report', { p_month: f.month, p_store_ids: storeId ? [storeId] : null, p_include_test: false })")
    expect(loader).toContain("supabase.rpc('care_order_sync_status')")
    // Store ngoài scope ⇒ trả RỖNG + cờ, KHÔNG gọi care_report với p_store_ids=null (âm thầm toàn scope).
    const guard = loader.indexOf('if (!careStoreFilterInScope(f.storeId, stores))')
    expect(guard).toBeGreaterThan(0)
    expect(guard).toBeLessThan(loader.indexOf("supabase.rpc('care_report'"))
    expect(loader).toMatch(/lines: \[\], totals: careReportSummary\(\[\]\)[^\n]*storeOutOfScope: true/)
    expect(loader).not.toMatch(/\? f\.storeId : null/)
    // /care dashboard: cùng luật.
    const dash = read('app/(dashboard)/care/page.tsx')
    expect(dash).toContain('careStoreFilterInScope(f.storeId, stores)')
    expect(dash).not.toContain('const scoped =')                                              // bản cũ: ngoài scope ⇒ storeId null
    expect(dash).toContain('loadCareDashboard(f, today, !isPast)')
    expect(dash).toContain('CARE_REPORT_STORE_OUT_OF_SCOPE')
  })

  test('UI/export/mobile CRM KHÔNG hiển thị số đơn / tiền / doanh thu (Q-90/Q-91)', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      if (!fs.existsSync(path.join(ROOT, dir))) return
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name).replace(/\\/g, '/')
        if (e.isDirectory()) { walk(rel); continue }
        if (/\.(ts|tsx)$/.test(e.name)) files.push(rel)
      }
    }
    for (const d of ['app/(dashboard)/care', 'components/care', 'lib/care', 'app/api/export/care', 'app/(dashboard)/ui-catalog/care-reports']) walk(d)
    expect(files.length).toBeGreaterThan(10)
    for (const f of files) {
      expect(read(f), f).not.toMatch(/Số đơn|Doanh thu|doanh thu ròng|net_revenue|netRevenue|net_amount|formatVnd|sumDecimal|₫|ShoppingBag/)
    }
    // E3: cờ UI E OFF ⇒ nhãn giữ "Khách có đơn"; ON ⇒ "Khách có đơn sau chăm sóc" (tách khỏi khối đơn sau import).
    expect(read('components/care/CareReportView.tsx')).toContain("label={importOrders ? 'Khách có đơn sau chăm sóc' : 'Khách có đơn'}")
    expect(read('components/care/CareDashboardView.tsx')).toContain('label="Khách có đơn"')
  })

  test('không đọc thẳng bảng nhạy cảm / không nguồn đơn thật trong app', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name).replace(/\\/g, '/')
        if (e.isDirectory()) { if (!['node_modules', '.next'].includes(e.name)) walk(rel); continue }
        if (!/\.(ts|tsx)$/.test(e.name)) continue
        if (/from\(['"](care_sync_state|care_orders|care_order_attributions)['"]\)|rpc\(['"]care_recompute_attribution['"]/.test(read(rel))) offenders.push(rel)
      }
    }
    for (const d of ['app', 'lib', 'components']) walk(d)
    expect(offenders).toEqual([])
  })
})

/* eslint-disable @typescript-eslint/no-explicit-any */
test.describe('care B5a r1.1 — PGlite 114: parser → care_orders → attribution → báo cáo/export theo scope @desktop', () => {
  test.skip(!HAS_PGLITE, 'chưa cài PGlite — npm i --no-save @electric-sql/pglite@0.2.17 (trong webapp/)')

  test('biên micro giây, 2 đơn cùng task = 1, is_test, scope SM/super, QLCH 0, trạng thái đơn', async () => {
    test.setTimeout(300_000)
    const { PGlite } = await import('@electric-sql/pglite')
    const L: any = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib-care-pglite.mjs')).href)
    const db: any = await L.freshDb(PGlite)
    const U = L.U, P10 = '2026-10-01'
    expect((await L.finalize(db, await L.stage(db, buildCareImportRows({ stores: defaultFixtureStores(2), customersPerStore: 2 }) as any, { period: P10 }), U.mkt, '2026-10-01')).status).toBe('committed')
    const tasks = (await db.query(`SELECT t.id, c.external_id, t.store_id FROM public.care_tasks t JOIN public.care_customers c ON c.id = t.customer_id ORDER BY c.external_id`)).rows
    expect(tasks.length).toBe(4)
    const [t1, t2, t3] = tasks
    const terminal = (taskId: string, at: string, outcome = 'INTERESTED') => db.query(`
      INSERT INTO public.care_interactions (task_id, customer_id, actor_id, assignee_id, store_id, period_month, outcome, is_terminal, note, is_test, created_at)
      SELECT id, customer_id, assignee_id, assignee_id, store_id, period_month, $3, true, 'QA B5a', is_test, $2::timestamptz FROM public.care_tasks WHERE id = $1`, [taskId, at, outcome])
    await terminal(t1.id, '2026-10-05T03:00:00.000400Z')
    await terminal(t2.id, '2026-10-06T00:00:00Z', 'REFUSED')                                   // Q-89: REFUSED vẫn ghi công
    await terminal(t3.id, '2026-10-07T00:00:00Z')

    // Đơn N3 (dạng BQ: chuỗi) ⇒ parser ⇒ ghi care_orders như sink B5b (superuser) ⇒ recompute (service_role).
    const parsed = parseN3Rows([
      n3({ customer_external_id: t1.external_id, order_key: 'O-EQ', ordered_at: '2026-10-05T10:00:00.000400+07:00' }),  // = lượt (micro) ⇒ KHÔNG
      n3({ customer_external_id: t1.external_id, order_key: 'O-AFTER', ordered_at: '2026-10-05T03:00:00.000500Z' }),    // POS
      n3({ customer_external_id: t1.external_id, order_key: 'O-AFTER-ONL', ordered_at: '2026-10-09T00:00:00Z' }),       // online, cùng task t1
      n3({ customer_external_id: t2.external_id, order_key: 'O-T2', ordered_at: '2026-10-08T00:00:00Z' }),
      n3({ customer_external_id: t3.external_id, order_key: 'O-T3', ordered_at: '2026-10-08T00:00:00Z' }),
    ])
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    for (const o of parsed.orders) {
      await db.query(`INSERT INTO public.care_orders (order_key, customer_external_id, ordered_at) VALUES ($1,$2,$3)`, [o.order_key, o.customer_external_id, o.ordered_at])
    }
    const scope = { customerExternalIds: [...new Set(parsed.orders.map((o) => o.customer_external_id))], orderKeys: parsed.orders.map((o) => o.order_key) }
    const recompute = () => L.as(db, null, async () => (await db.query(`SELECT public.care_recompute_attribution($1::text[], $2::text[]) r`, [scope.customerExternalIds, scope.orderKeys])).rows[0].r, 'service_role')
    expect(await recompute()).toEqual({ scope: 5, upserted: 4, deleted: 0 })
    expect(await recompute()).toEqual({ scope: 5, upserted: 0, deleted: 0 })                  // cron lặp ⇒ idempotent
    const keys = (await db.query(`SELECT order_key, task_id FROM public.care_order_attributions ORDER BY 1`)).rows
    expect(keys.map((k: any) => k.order_key)).toEqual(['O-AFTER', 'O-AFTER-ONL', 'O-T2', 'O-T3'])
    expect(keys.filter((k: any) => k.task_id === t1.id)).toHaveLength(2)

    // Báo cáo qua đúng mapper app, theo session từng vai trò.
    const reportAs = async (who: string) => {
      const rows: CareReportRow[] = await L.as(db, who, async () => (await db.query(`SELECT * FROM public.care_report($1::date, NULL, false)`, [P10])).rows)
      const st = await L.as(db, who, async () => (await db.query(`SELECT has_synced, last_success_at::text AS last_success_at, last_failed FROM public.care_order_sync_status()`)).rows[0] ?? null)
      return { rows, state: careOrderDataState(st) }
    }
    const sup = await reportAs(U.super)
    for (const r of sup.rows) expect(Object.keys(r)).not.toEqual(expect.arrayContaining(['orders']))
    const supT = careReportSummary(careReportLines(sup.rows, { stores: new Map(), names: new Map() }))
    expect([supT.tasks, supT.convertedTasks]).toEqual([4, 3])                                    // 4 đơn gán ⇒ 3 task Có đơn
    expect(sup.state).toEqual({ kind: 'none' })                                               // chưa có dòng sync ⇒ không trình bày số
    expect(careReportExportRows(careReportLines(sup.rows, { stores: new Map(), names: new Map() }), supT, sup.state, '10/2026').at(-1))
      .toMatchObject({ 'Khách có đơn': CARE_ORDER_NO_DATA })
    const sm2 = await reportAs(U.sm2)                                                          // SM2 chỉ QAOS01
    expect(sm2.rows.every((r) => r.store_id === L.storeId(1))).toBe(true)
    const sm2Conv = careReportSummary(careReportLines(sm2.rows, { stores: new Map(), names: new Map() })).convertedTasks
    expect(sm2Conv).toBe(await L.count(db, `SELECT count(DISTINCT task_id) FROM public.care_order_attributions WHERE store_id = $1 AND NOT is_test`, [L.storeId(1)]))
    expect(sm2Conv).toBeLessThan(3)
    // Q-95/Q-101: SM/super không SELECT thẳng attribution hay đơn thô — Có đơn chỉ qua care_report (đã kiểm ở trên).
    for (const who of [U.sm2, U.super]) {
      for (const t of ['care_order_attributions', 'care_orders']) {
        expect(await L.raises(L.as(db, who, () => db.query(`SELECT count(*) FROM public.${t}`)), 'permission denied'), `${who} ${t}`).toBe(true)
      }
    }
    const qlch = await reportAs(U.qlch1)
    expect(qlch.rows).toEqual([])
    expect(qlch.state).toEqual({ kind: 'none' })
    await db.query(`INSERT INTO public.care_sync_state (source, last_success_at) VALUES ('n3_orders', '2026-10-20T01:05:00Z')`)
    expect((await reportAs(U.sm)).state).toEqual({ kind: 'synced', lastSuccessAt: expect.any(String), lastFailed: false })
    expect((await reportAs(U.A)).state).toEqual({ kind: 'none' })                              // staff: không có trạng thái báo cáo
  })
})
