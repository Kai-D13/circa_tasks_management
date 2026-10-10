import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, expect } from '@playwright/test'
import {
  CARE_PROOF_MAX, CARE_PROOF_PUBLIC_BASE, CARE_PROOF_RETENTION_DAYS, CARE_RECORD_MESSAGES, applyMyTaskFilters, careMyBadge, careProofKey,
  careStaffTaskBlock, compareMyTasks, isCareProofDisplayUrl, isCareProofMime, isCareProofUrl, isProofExpired, mapCareRecordError, myFilterHref,
  pageMyTasks, parseMyFilters, validateInteractionInput, CARE_MY_FILTERS, CARE_MY_PAGE_SIZE, type CareMyFilter, type CareMySortKey,
} from '../lib/care/my'
import { CARE_OUTCOMES, CARE_OUTCOME_META } from '../lib/care/outcome'
import type { CareQueryBuilder } from '../lib/care/browse'
import { buildCareImportRows } from './careImportFixture'

// CRM-CSKH B4 — màn dược sĩ: (1) unit lib/care/my.ts · (2) source: cờ trước tiên, chỉ dược sĩ
// OS, session/RPC (không service role), upload care_proof, nav/CTA gate · (3) PGlite 114: ma
// trận quyền ghi lượt qua RPC trực tiếp, biên ngày/kỳ, submit đôi, chuyển giao giữa lúc mở form,
// REFUSED/DNC, proof đúng base + task (TS ↔ SQL), summary/list/thứ tự/phân trang, loại is_test.
// Chưa phải QA DB thật — B6.

const ROOT = path.resolve(__dirname, '..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n') // chịu checkout CRLF (Windows)
const HAS_PGLITE = fs.existsSync(path.join(ROOT, 'node_modules', '@electric-sql', 'pglite'))
const S = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const T = S(700)
const PB = `${CARE_PROOF_PUBLIC_BASE}/care-proof/`
const goodUrl = (task: string, k = 1) => `${PB}${task}/17000000000${String(k).padStart(2, '0')}_abcd12${String(k).padStart(2, '0')}.jpg`

test.describe('care B4 — logic thuần (dược sĩ) @desktop', () => {
  test('proof: key opaque theo task; URL hợp lệ = đúng base + prefix task + khoá app sinh', () => {
    expect(careProofKey(T, 'image/jpeg', 1_700_000_000_123, 'abcd1234')).toBe(`care-proof/${T}/1700000000123_abcd1234.jpg`)
    expect(careProofKey(T.toUpperCase(), 'image/webp', 1_700_000_000_123, 'abcd1234')).toBe(`care-proof/${T}/1700000000123_abcd1234.webp`)
    expect(careProofKey(T, 'image/svg+xml', 1_700_000_000_123, 'abcd1234')).toBeNull()
    expect(careProofKey(T, 'image/gif', 1_700_000_000_123, 'abcd1234')).toBeNull()
    // Khoá prototype không phải MIME hợp lệ (security r1.1 P2-1).
    for (const ct of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(isCareProofMime(ct), ct).toBe(false)
      expect(careProofKey(T, ct, 1_700_000_000_123, 'abcd1234'), ct).toBeNull()
    }
    expect(isCareProofMime('image/webp')).toBe(true)
    expect(careProofKey('../x', 'image/png', 1_700_000_000_123, 'abcd1234')).toBeNull()
    expect(careProofKey(T, 'image/png', 1_700_000_000_123, 'ten-khach')).toBeNull()
    expect(isCareProofUrl(goodUrl(T), T)).toBe(true)
    for (const bad of [
      goodUrl(S(701)), `https://storage.googleapis.com/duocsi-circa-vn.evil.com/care-proof/${T}/1700000000101_abcd1201.jpg`,
      `https://storage.googleapis.com/duocsi-circa-vn/tasks/${T}/1700000000101_abcd1201.jpg`, `${PB}${T}/../x/1700000000101_abcd1201.jpg`,
      `${PB}${T}/1700000000101_abcd1201.svg`, `${PB}${T}/ten-khach-0901.jpg`, `http://storage.googleapis.com/duocsi-circa-vn/care-proof/${T}/1700000000101_abcd1201.jpg`,
      `javascript:alert(1)`, 42, null,
    ]) expect(isCareProofUrl(bad, T), String(bad)).toBe(false)
    expect(isCareProofDisplayUrl(goodUrl(S(701)))).toBe(true)
    expect(isCareProofDisplayUrl('https://evil.example/care-proof/x.jpg')).toBe(false)
  })

  test('proof: base + đuôi khoá trong TS KHỚP điều kiện SQL của RPC 114', () => {
    const sql = fs.readFileSync(path.join(ROOT, '..', 'supabase', 'migrations', '114_care_crm_foundation.sql'), 'utf8').replace(/\r\n/g, '\n')
    const body = /FUNCTION public\.care__record_interaction_at[\s\S]*?END \$\$;/.exec(sql)![0]
    expect(body).toContain(`'${CARE_PROOF_PUBLIC_BASE}/care-proof/' || t.id::text || '/'`)
    expect(body).toContain(`'^[0-9]{13}_[0-9a-f]{8}[.](jpg|png|webp|heic|heif)$'`)
    expect(read('lib/care/my.ts')).toContain('const KEY_TAIL_RE = /^[0-9]{13}_[0-9a-f]{8}\\.(jpg|png|webp|heic|heif)$/')
    expect(read('../webapp/.env.example')).toContain(`GCS_PUBLIC_BASE_URL=${CARE_PROOF_PUBLIC_BASE}`)
  })

  test('danh sách: filter URL không PII; builder thêm đúng điều kiện; nhãn Quá hạn/Hẹn lại/Đang theo dõi', () => {
    expect(parseMyFilters({})).toEqual({ filter: 'all', page: 1 })
    expect(parseMyFilters({ filter: 'overdue', page: '3' })).toEqual({ filter: 'overdue', page: 3 })
    expect(parseMyFilters({ filter: 'x', page: '-1' })).toEqual({ filter: 'all', page: 1 })
    expect(myFilterHref('all')).toBe('/care/my')
    expect(myFilterHref('completed', 2)).toBe('/care/my?filter=completed&page=2')
    type FB = CareQueryBuilder<FB>
    const calls: string[] = []
    const b: FB = { eq: (c, v) => (calls.push(`eq ${c} ${v}`), b), is: (c) => (calls.push(`is ${c}`), b), not: (c) => (calls.push(`not ${c}`), b), lt: (c, v) => (calls.push(`lt ${c} ${v}`), b) }
    const run = (f: CareMyFilter) => { calls.length = 0; applyMyTaskFilters(b, S(9), S(10), '2026-10-01', f, '2026-10-10'); return [...calls] }
    // Q-82: luôn kèm ĐÚNG store hiện tại của dược sĩ (khớp RLS + care_my_summary).
    expect(run('all')).toEqual([`eq assignee_id ${S(9)}`, `eq store_id ${S(10)}`, 'eq period_month 2026-10-01', 'eq is_test false'])
    expect(run('not_cared').slice(4)).toEqual(['eq status open', 'is last_interaction_at'])
    expect(run('overdue').slice(4)).toEqual(['eq status open', 'lt next_action_date 2026-10-10'])
    expect(run('completed').slice(4)).toEqual(['eq status completed'])
    const t = (status: string, last: string | null, next: string | null) => ({ status, last_interaction_at: last, next_action_date: next })
    expect(careMyBadge(t('open', 'x', '2026-10-09'), '2026-10-10')).toEqual({ label: 'Quá hạn · hẹn 09/10', tone: 'danger' })
    expect(careMyBadge(t('open', 'x', '2026-10-10'), '2026-10-10')).toEqual({ label: 'Hẹn chăm sóc lại 10/10', tone: 'info' })   // hẹn hôm nay ≠ quá hạn
    expect(careMyBadge(t('open', 'x', '2026-10-31'), '2026-10-31').tone).toBe('info')
    expect(careMyBadge(t('open', 'x', null), '2026-10-10').label).toBe('Đang theo dõi')
    expect(careMyBadge(t('open', null, null), '2026-10-31').label).toBe('Chưa chăm sóc')          // chưa gọi, chưa hẹn ⇒ KHÔNG tự quá hạn
    expect(careMyBadge(t('completed', 'x', null), '2026-10-10').tone).toBe('success')
  })

  test('Q-84: thứ tự = hẹn gần hôm nay nhất (cùng khoảng cách ⇒ quá hạn trước) → chưa hẹn → đã kết thúc; sort toàn tập rồi mới cắt trang', () => {
    const k = (id: number, status: string, next: string | null): CareMySortKey => ({ id: S(id), status, next_action_date: next })
    const today = '2026-10-20'
    const keys = [
      k(9, 'closed_unfinished', null), k(8, 'completed', null), k(7, 'open', null), k(6, 'open', null),
      k(5, 'open', '2026-10-31'),          // hẹn xa (11 ngày)
      k(4, 'open', '2026-10-02'),          // quá hạn xa (18 ngày)
      k(3, 'open', '2026-10-21'),          // ngày mai (1)
      k(2, 'open', '2026-10-19'),          // hôm qua (1) ⇒ trước ngày mai
      k(1, 'open', '2026-10-20'),          // hôm nay (0)
      k(10, 'open', '2026-10-25'),         // 5 ngày
      k(11, 'open', '2026-10-15'),         // quá hạn 5 ngày ⇒ trước #10 (cùng 5)
      k(12, 'completed', null),            // id lớn hơn closed #9 ⇒ trong nhóm đã kết thúc chỉ theo id (không ưu tiên status)
    ]
    const sorted = [...keys].sort((a, b) => compareMyTasks(a, b, today)).map((x) => x.id)
    expect(sorted).toEqual([S(1), S(2), S(3), S(11), S(10), S(5), S(4), S(6), S(7), S(8), S(9), S(12)])
    // Cùng ngày hẹn ⇒ theo id; nhóm chưa hẹn / đã kết thúc ⇒ theo id (không phụ thuộc thứ tự đầu vào).
    expect(compareMyTasks(k(2, 'open', '2026-10-21'), k(1, 'open', '2026-10-21'), today)).toBeGreaterThan(0)
    expect([...keys].reverse().sort((a, b) => compareMyTasks(a, b, today)).map((x) => x.id)).toEqual(sorted)
    // Biên tháng/năm: khoảng cách tính theo ngày lịch, không theo chuỗi.
    expect(compareMyTasks(k(1, 'open', '2026-12-31'), k(2, 'open', '2027-01-02'), '2027-01-01')).toBeLessThan(0)
    // Phân trang: trang 3 dòng ⇒ 4 trang, không lặp/mất, trang 2 không sort lại riêng.
    const pages = [1, 2, 3, 4].map((p) => pageMyTasks(keys, p, today, 3))
    expect(pages.map((p) => p.total)).toEqual([12, 12, 12, 12])
    expect(pages.flatMap((p) => p.pageIds)).toEqual(sorted)
    expect(pageMyTasks(keys, 5, today, 3).pageIds).toEqual([])
    expect(pageMyTasks(keys, 1, today).pageIds).toHaveLength(Math.min(CARE_MY_PAGE_SIZE, keys.length))
  })

  test('Q-82: gate ghi lượt / cấp URL ảnh — assignee + ĐÚNG store task + mở + kỳ hiện tại', () => {
    const me = { userId: S(1), storeId: S(101) }
    const t = { assignee_id: S(1), store_id: S(101), status: 'open', period_month: '2026-10-01' }
    expect(careStaffTaskBlock(t, me, '2026-10-01')).toBeNull()
    expect(careStaffTaskBlock(null, me, '2026-10-01')).toBe('TASK_NOT_FOUND')                     // RLS không cho thấy
    expect(careStaffTaskBlock({ ...t, store_id: S(102) }, me, '2026-10-01')).toBe('NOT_ASSIGNEE') // staff đã sang store khác
    expect(careStaffTaskBlock(t, { ...me, storeId: S(102) }, '2026-10-01')).toBe('NOT_ASSIGNEE')
    expect(careStaffTaskBlock({ ...t, assignee_id: S(2) }, me, '2026-10-01')).toBe('NOT_ASSIGNEE')
    expect(careStaffTaskBlock({ ...t, status: 'completed' }, me, '2026-10-01')).toBe('TASK_CLOSED')
    expect(careStaffTaskBlock(t, me, '2026-11-01')).toBe('PERIOD_PASSED')
  })

  test('Q-85: ảnh minh chứng hết hạn lưu sau 90 ngày kể từ lượt', () => {
    expect(CARE_PROOF_RETENTION_DAYS).toBe(90)
    const at = '2026-07-01T03:00:00Z', day = 86_400_000
    expect(isProofExpired(at, Date.parse(at) + 90 * day)).toBe(false)          // đúng 90 ngày: chưa
    expect(isProofExpired(at, Date.parse(at) + 90 * day + 1)).toBe(true)
    expect(isProofExpired(at, Date.parse(at) + 30 * day)).toBe(false)
    expect(isProofExpired('không phải ngày', Date.now())).toBe(false)           // dữ liệu lạ ⇒ không ẩn ảnh (onError xử lý)
  })

  test('form: validate theo outcome (ngày hẹn hôm nay..hết tháng), ghi chú, proof', () => {
    const ctx = { taskId: T, todayISO: '2026-10-30', dueDate: '2026-10-31' }
    const v = (o: Partial<{ outcome: unknown; note: unknown; nextActionDate: unknown; proofUrls: unknown }>) =>
      validateInteractionInput({ outcome: 'CALLBACK', note: 'QA', nextActionDate: '2026-10-31', proofUrls: [], ...o }, ctx)
    for (const o of CARE_OUTCOMES) {
      const m = CARE_OUTCOME_META[o]
      expect(v({ outcome: o, nextActionDate: m.requiresNextActionDate ? '2026-10-30' : '' }).ok, o).toBe(true)
      if (m.requiresNextActionDate) {
        expect(v({ outcome: o, nextActionDate: '' }), o).toEqual({ ok: false, code: 'DATE_REQUIRED' })
      } else {
        expect(v({ outcome: o, nextActionDate: '2026-10-31' }), o).toEqual({ ok: false, code: 'DATE_NOT_ALLOWED' })
      }
    }
    expect(v({ nextActionDate: '2026-10-29' })).toEqual({ ok: false, code: 'DATE_RANGE' })
    expect(v({ nextActionDate: '2026-11-01' })).toEqual({ ok: false, code: 'DATE_RANGE' })
    expect(v({ nextActionDate: '31/10/2026' })).toEqual({ ok: false, code: 'DATE_RANGE' })
    expect(v({ outcome: 'DONE' })).toEqual({ ok: false, code: 'OUTCOME_INVALID' })
    expect(v({ note: '   ' })).toEqual({ ok: false, code: 'NOTE_REQUIRED' })
    expect(v({ note: 'x'.repeat(501) })).toEqual({ ok: false, code: 'NOTE_REQUIRED' })
    expect(v({ note: ` ${'x'.repeat(500)} ` }).ok).toBe(true)
    expect(v({ proofUrls: [goodUrl(T, 1), goodUrl(T, 2)] })).toMatchObject({ ok: true, proof: [{ url: goodUrl(T, 1) }, { url: goodUrl(T, 2) }] })
    expect(v({ proofUrls: Array.from({ length: CARE_PROOF_MAX + 1 }, (_, k) => goodUrl(T, k + 1)) })).toEqual({ ok: false, code: 'PROOF_INVALID' })
    expect(v({ proofUrls: [goodUrl(T, 1), goodUrl(T, 1)] })).toEqual({ ok: false, code: 'PROOF_INVALID' })
    expect(v({ proofUrls: [goodUrl(S(701))] })).toEqual({ ok: false, code: 'PROOF_INVALID' })
    expect(v({ proofUrls: 'x' })).toEqual({ ok: false, code: 'PROOF_INVALID' })
    expect(mapCareRecordError('connection reset')).toBe('RECORD_FAILED')
    expect(mapCareRecordError('care_record_interaction: lượt trùng vừa được ghi')).toBe('DUPLICATE')
    expect(mapCareRecordError('care_record_interaction: chỉ dược sĩ được giao task mới ghi nhận (không còn thuộc cửa hàng của task)')).toBe('NOT_ASSIGNEE')
    for (const m of Object.values(CARE_RECORD_MESSAGES)) expect(m).not.toMatch(/care_|SQL|RAISE|\d{9}/)
  })
})

test.describe('care B4 — source: cờ, dược sĩ OS, session/RPC, upload, nav/CTA @desktop', () => {
  const B4_FILES = [
    'lib/care/my.ts', 'lib/care/server/my.ts', 'app/actions/careMy.ts',
    'app/(dashboard)/care/my/page.tsx', 'app/(dashboard)/care/my/[id]/page.tsx', 'app/(dashboard)/care/my/[id]/update/page.tsx',
    'components/care/CareMyHome.tsx', 'components/care/CareMyTaskDetail.tsx', 'components/care/CareInteractionForm.tsx',
    'app/(dashboard)/ui-catalog/care-my/page.tsx',
  ]

  test('không file B4 nào dùng service role', () => {
    for (const f of B4_FILES) expect(read(f), f).not.toMatch(/supabaseAdmin|supabase\/admin|SERVICE_ROLE|service_role/)
  })

  test('guard: cờ OFF ⇒ 404 trước mọi đọc; chỉ role staff + store OS', () => {
    const src = read('lib/care/server/my.ts')
    expect(src).toMatch(/^import 'server-only'/)
    expect(src).toMatch(/export async function requireCareStaff\(\)[\s\S]*?> \{\s*if \(!isCareEnabled\(\)\) notFound\(\)/)
    expect(src).toContain("if (profile.role !== 'staff' || !profile.store_id || store?.store_type !== 'os' || store?.is_active === false) return { kind: 'forbidden' }")
    // Danh sách không tải sản phẩm/ảnh/timeline.
    const sels = [...src.matchAll(/from\('care_tasks'\)\.select\('([^']+)'/g)].map((m) => m[1])
    // + B6-qa-ui: thẻ tóm tắt ở chế độ QA local đếm từ task của mình (lib/care/qa/mirror.ts) — vẫn không PII/sản phẩm.
    expect(sels).toEqual(['status, last_interaction_at, next_action_date', 'id, status, next_action_date', 'id, customer_name, phone_norm, status, last_outcome, last_interaction_at, next_action_date, due_date'])
    for (const sel of sels) expect(sel).not.toMatch(/product|image|care_interactions|care_customers|proof/)
    expect(src).toContain('maskVnPhone(phone_norm)')
    // Q-84: khoá sort của TOÀN TẬP (fetchExact, có tìm kiếm) → pageMyTasks → đọc đúng trang theo id.
    const load = /export async function loadMyTaskPage[\s\S]*?\n\}/.exec(src)![0]
    expect(load).toMatch(/fetchExact<CareMySortKey>\([\s\S]*?query\.or\([\s\S]*?query\.order\('id'\)\.range\(from, to\)/)
    expect(load.indexOf('pageMyTasks(keys, page, todayISO)')).toBeGreaterThan(load.indexOf('fetchExact'))
    expect(load).toContain(".in('id', pageIds)")
    expect(load).not.toMatch(/order\('next_action_date'|CARE_MY_PAGE_SIZE - 1/)
    // Q-82: danh sách luôn lọc đúng store hiện tại (me.storeId) như RLS/summary.
    // B6-qa-ui: + phạm vi dữ liệu (production = is_test false như cũ; QA local = batch QA).
    expect(src).toContain('applyMyTaskFilters(q as unknown as LooseBuilder, me.userId, me.storeId, period, filter, todayISO, careDataScope())')
  })

  test('action: cờ → dược sĩ OS → validate → session rpc care_record_interaction; không ghi thẳng bảng', () => {
    const src = read('app/actions/careMy.ts')
    expect(src).toMatch(/^'use server'/)
    const fns = [...src.matchAll(/export async function (\w+)\([\s\S]*?\):\s*Promise<[\s\S]*?> \{\n([\s\S]*?)\n\}/g)]
    expect(fns.map((m) => m[1]).sort()).toEqual(['loadMoreMyCareInteractions', 'recordCareInteraction', 'searchMyCareTasks'])
    for (const m of fns) {
      expect(m[2].trimStart(), m[1]).toMatch(/^if \(!isCareEnabled\(\)\) return/)
      expect(m[2], m[1]).toContain('await getCareStaffAccess()')
    }
    const rec = fns.find((m) => m[1] === 'recordCareInteraction')![2]
    // Q-82: đọc task (gồm store_id) qua RLS → gate assignee + đúng store → validate → RPC.
    expect(rec).toContain(".select('id, assignee_id, store_id, status, period_month, due_date')")
    expect(rec.indexOf('careStaffTaskBlock(t, a, carePeriodOf(now))')).toBeLessThan(rec.indexOf('validateInteractionInput('))
    expect(rec.indexOf('validateInteractionInput(')).toBeLessThan(rec.indexOf("supabase.rpc('care_record_interaction'"))
    expect(rec).toMatch(/mapCareRecordError\(error\.message\)/)
    expect(src).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|care_interactions'\)|console\./)
    expect(fns.find((m) => m[1] === 'loadMoreMyCareInteractions')![2]).toMatch(/await loadCareInteractionsPage\(input\.taskId, before\)/)
  })

  test('upload care_proof: cờ, ảnh, base khớp, dược sĩ được giao task mở kỳ hiện tại, key opaque', () => {
    const src = read('app/actions/uploads.ts')
    const br = /input\.purpose === 'care_proof'\) \{([\s\S]*?)\n  \} else \{/.exec(src)![1]
    expect(br.trimStart()).toMatch(/^\/\/[\s\S]*?if \(!isCareEnabled\(\)\) return/)
    expect(br).toContain('if (!isCareProofMime(ct))')
    expect(br).not.toMatch(/ in CARE_PROOF_EXT/)                                  // `in` nhận cả khoá prototype (security r1.1 P2-1)
    expect(br).toContain('!== CARE_PROOF_PUBLIC_BASE')
    expect(br).toContain('await getCareStaffAccess()')
    expect(br).toContain("access.kind !== 'ok' || access.userId !== user.id")
    // Q-82: cùng gate với action ghi lượt — assignee + ĐÚNG store task + mở + kỳ hiện tại.
    expect(br).toContain(".select('id, assignee_id, store_id, status, period_month')")
    expect(br).toContain('const block = careStaffTaskBlock(ct0, access, carePeriodOf(new Date()))')
    expect(br.indexOf('careStaffTaskBlock(')).toBeLessThan(br.indexOf('careProofKey('))
    expect(br).toMatch(/if \(block === 'TASK_NOT_FOUND' \|\| block === 'NOT_ASSIGNEE'\) return \{ error:/)
    expect(br).toMatch(/if \(block\) return \{ error:/)
    expect(br).toMatch(/key = k$/m)
    // Nút/Form ghi lượt dùng cùng gate (UI chỉ ẩn thêm; RPC là chốt cuối).
    for (const f of ['app/(dashboard)/care/my/[id]/page.tsx', 'app/(dashboard)/care/my/[id]/update/page.tsx']) {
      expect(read(f), f).toMatch(/careStaffTaskBlock\(t, me, carePeriodOf\(now\)\) === null/)
    }
    expect(read('app/(dashboard)/care/my/[id]/update/page.tsx')).toContain("select('id, customer_name, assignee_id, store_id, status, period_month, due_date')")
    expect(br).not.toMatch(/safe|filename/)
    expect(read('components/care/CareInteractionForm.tsx')).toContain("uploadViaGcs(file, { purpose: 'care_proof', taskId, filename: 'proof' })")
  })

  test('nav + CTA: chỉ khi cờ ON (server truyền), staff OS; /tasks không query CRM', () => {
    const nav = read('components/layout/BottomNav.tsx')
    expect(nav).toContain("isStaffNav ? (careEnabled ? STAFF_NAV_CARE : STAFF_NAV)")
    expect(nav).toMatch(/STAFF_NAV_CARE: NavItem\[\] = \[\s*\.\.\.STAFF_NAV\.slice\(0, 4\),\s*\{ href: '\/care\/my',\s*label: 'CSKH'/)
    expect(nav).not.toMatch(/NEXT_PUBLIC_CARE|process\.env/)
    expect(read('app/(dashboard)/layout.tsx')).toContain('careEnabled={isStaff && !isFsStore && isCareEnabled()}')
    const tasks = read('app/(dashboard)/tasks/page.tsx')
    expect(tasks).toMatch(/\{isStaff && isCareEnabled\(\) && \(\s*<Link href="\/care\/my"/)
    expect(tasks).not.toMatch(/care_tasks|care_my_summary|rpc\('care|lib\/care\/server/)
  })

  test('catalog care-my: UI_CATALOG + super; mỗi action giả tự kiểm cổng', () => {
    const src = read('app/(dashboard)/ui-catalog/care-my/page.tsx')
    expect(src).toMatch(/export default async function \w+\(\) \{\s*if \(!catalogOn\(\)\) notFound\(\)/)
    const fakes = [...src.matchAll(/async function (fake\w+)\([^)]*\) \{\s*'use server'\s*if \(!\(await gate\(\)\)\) return/g)]
    expect(fakes.map((m) => m[1]).sort()).toEqual(['fakeLoadMore', 'fakeRecord', 'fakeSearch'])
    expect([...src.matchAll(/async function (fake\w+)\(/g)].length).toBe(fakes.length)
    for (const m of src.matchAll(/(?<!\d)0[35789]\d{8}(?!\d)/g)) expect(m[0]).toMatch(/^0390000\d{3}$/)
  })
})

/* eslint-disable @typescript-eslint/no-explicit-any */
class SqlWhere implements CareQueryBuilder<SqlWhere> {
  parts: string[] = []
  params: unknown[] = []
  private col(c: string) { if (!/^[a-z_]+$/.test(c)) throw new Error('col'); return c }
  private add(sql: string, v?: unknown) { if (v !== undefined) { this.params.push(v); sql = sql.replace('?', `$${this.params.length}`) } this.parts.push(sql); return this }
  eq(c: string, v: unknown) { return this.add(`${this.col(c)} = ?`, v) }
  is(c: string) { return this.add(`${this.col(c)} IS NULL`) }
  not(c: string) { return this.add(`${this.col(c)} IS NOT NULL`) }
  lt(c: string, v: string) { return this.add(`${this.col(c)} < ?`, v) }
  sql() { return this.parts.join(' AND ') }
}

test.describe('care B4 — PGlite 114: ghi lượt, quyền, proof, danh sách @desktop', () => {
  test.skip(!HAS_PGLITE, 'chưa cài PGlite — npm i --no-save @electric-sql/pglite@0.2.17 (trong webapp/)')

  test('ma trận quyền RPC trực tiếp · biên ngày/kỳ · submit đôi · chuyển giao · REFUSED · proof · summary/list', async () => {
    test.setTimeout(300_000)
    const { PGlite } = await import('@electric-sql/pglite')
    const L: any = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib-care-pglite.mjs')).href)
    const db: any = await L.freshDb(PGlite)
    await db.exec(`CREATE OR REPLACE FUNCTION public.care_vn_today() RETURNS date LANGUAGE sql STABLE AS $$ SELECT DATE '2026-10-20' $$`)
    const U = L.U, P10 = '2026-10-01'
    const res = await L.finalize(db, await L.stage(db, buildCareImportRows({ customersPerStore: 10 }) as any, { period: P10 }), U.mkt, '2026-10-01')
    expect(res.status).toBe('committed')
    const mine = async (who: string) => (await db.query(`SELECT * FROM public.care_tasks WHERE assignee_id = $1 AND period_month = $2 ORDER BY id`, [who, P10])).rows
    const [a0, a1, a2, a3, a4] = await mine(U.A)
    const [b0] = await mine(U.B)
    /** Gọi RPC như app: lỗi ⇒ mã an toàn qua mapCareRecordError. */
    const rec = async (today: string, who: string | null, task: string, outcome: string, note = 'QA', next: string | null = null, proof: any = null) => {
      try { await L.record(db, today, who, task, outcome, note, next, proof); return 'OK' } catch (e: any) { return mapCareRecordError(e.message) }
    }

    // Nền: a0 hẹn 10/10 (quá hạn ngày 20), a1 hẹn 31/10, a2 Hoàn thành; a3, a4 chưa chăm sóc.
    expect(await rec('2026-10-05', U.A, a0.id, 'CALLBACK', 'QA hẹn sớm', '2026-10-10')).toBe('OK')
    expect(await rec('2026-10-20', U.A, a1.id, 'CALLBACK', 'QA hẹn cuối', '2026-10-31')).toBe('OK')
    expect(await rec('2026-10-06', U.A, a2.id, 'INTERESTED', 'QA quan tâm')).toBe('OK')

    // 1) Ma trận quyền ghi (RPC trực tiếp): chỉ dược sĩ đang được giao.
    for (const [who, name] of [[U.B, 'staff khác'], [U.qlch1, 'QLCH'], [U.sm, 'SM'], [U.super, 'super'], [U.mkt, 'Marketing'], [U.staffFs, 'staff FS']]) {
      expect(await rec('2026-10-20', who, a3.id, 'INTERESTED'), name).toBe('NOT_ASSIGNEE')
    }
    expect(await rec('2026-10-20', null, a3.id, 'INTERESTED')).toBe('UNAUTHENTICATED')
    expect(await rec('2026-10-20', U.A, a2.id, 'CALLBACK', 'QA', '2026-10-25')).toBe('TASK_CLOSED')          // đã Hoàn thành
    expect(await rec('2026-11-01', U.A, a3.id, 'CALLBACK', 'QA', '2026-11-05')).toBe('PERIOD_PASSED')         // kỳ đã qua (chưa đóng)
    expect(await rec('2026-10-20', U.A, L.uid(999999), 'INTERESTED')).toBe('TASK_NOT_FOUND')

    // 2) Biên ngày/outcome — TS validate ↔ RPC cùng mã (task b0 của B, hạn 31/10, hôm nay 20/10).
    const ctx = { taskId: b0.id, todayISO: '2026-10-20', dueDate: '2026-10-31' }
    const cases: [string, string, string | null, any][] = [
      ['CALLBACK', 'QA', null, null], ['CALLBACK', 'QA', '2026-10-19', null], ['CALLBACK', 'QA', '2026-11-01', null],
      ['INTERESTED', 'QA', '2026-10-25', null], ['CALLBACK', '   ', '2026-10-25', null], ['CALLBACK', 'x'.repeat(501), '2026-10-25', null],
      ['DONE', 'QA', null, null],
      ['CALLBACK', 'QA', '2026-10-25', [{ url: 'https://example.invalid/p.jpg' }]],
      ['CALLBACK', 'QA', '2026-10-25', [{ url: goodUrl(a0.id) }]],                                         // ảnh của task khác
      ['CALLBACK', 'QA', '2026-10-25', Array.from({ length: 6 }, (_, k) => ({ url: goodUrl(b0.id, k + 1) }))],
      ['CALLBACK', 'QA', '2026-10-25', [{ url: `${PB}${b0.id}/1700000000101_abcd1201.svg` }]],
    ]
    for (const [o, note, next, proof] of cases) {
      const ts = validateInteractionInput({ outcome: o, note, nextActionDate: next ?? '', proofUrls: proof ? proof.map((p: any) => p.url) : [] }, ctx)
      const sql = await rec('2026-10-20', U.B, b0.id, o, note, next, proof)
      expect(ts.ok, `${o}/${next}/${note.length}`).toBe(false)
      expect(sql, `${o}/${next}/${note.length}`).toBe(ts.ok ? 'OK' : ts.code)
    }
    expect(await L.count(db, `SELECT count(*) FROM public.care_interactions WHERE task_id = $1`, [b0.id])).toBe(0)
    // Hợp lệ ở cả hai: hẹn đúng hôm nay; hẹn ngày cuối tháng; proof đúng base + task.
    const okInput = { outcome: 'CALLBACK', note: 'QA ok', nextActionDate: '2026-10-20', proofUrls: [goodUrl(b0.id, 1), goodUrl(b0.id, 2)] }
    expect(validateInteractionInput(okInput, ctx).ok).toBe(true)
    expect(await rec('2026-10-20', U.B, b0.id, 'CALLBACK', 'QA ok', '2026-10-20', okInput.proofUrls.map((url) => ({ url })))).toBe('OK')
    const stored = await L.one(db, `SELECT proof FROM public.care_interactions WHERE task_id = $1`, [b0.id])
    expect(stored.proof).toEqual(okInput.proofUrls.map((url) => ({ url })))
    expect(await rec('2026-10-30', U.A, a4.id, 'CALLBACK', 'QA', '2026-10-30')).toBe('OK')                    // hẹn 30/10 ngày 30/10
    expect(await rec('2026-10-31', U.A, a4.id, 'CALLBACK', 'QA', '2026-10-31')).toBe('OK')                    // hẹn 31/10 ngày 31/10
    expect(await rec('2026-10-31', U.A, a4.id, 'CALLBACK', 'QA', '2026-10-30')).toBe('DATE_RANGE')

    // 3) Submit đôi lượt kết thúc ⇒ lần 2 bị chặn; đúng một lượt kết thúc.
    expect(await rec('2026-10-20', U.A, a3.id, 'ORDERED', 'QA chốt')).toBe('OK')
    expect(await rec('2026-10-20', U.A, a3.id, 'ORDERED', 'QA chốt')).toBe('TASK_CLOSED')
    expect(await L.count(db, `SELECT count(*) FROM public.care_interactions WHERE task_id = $1 AND is_terminal`, [a3.id])).toBe(1)

    // 4) Chuyển giao giữa lúc A đang mở form: A ghi ⇒ NOT_ASSIGNEE; B (mới) ghi được. REFUSED ⇒ DNC theo store.
    await L.transfer(db, '2026-10-31', U.sm, [a4.id], U.B, 'QA chuyển ca')
    expect(await rec('2026-10-31', U.A, a4.id, 'INTERESTED', 'QA form cũ')).toBe('NOT_ASSIGNEE')
    expect(await rec('2026-10-31', U.B, a4.id, 'REFUSED', 'QA khách từ chối')).toBe('OK')
    expect(await L.count(db, `SELECT count(*) FROM public.care_store_refusals WHERE customer_id = $1 AND store_id = $2`, [a4.customer_id, a4.store_id])).toBe(1)

    // 4b) Retry cùng nội dung trong 2 phút (mạng rớt sau commit) ⇒ DUPLICATE, không nhân đôi lượt.
    expect(await rec('2026-10-20', U.A, a1.id, 'CALLBACK', 'QA hẹn cuối', '2026-10-31')).toBe('DUPLICATE')
    expect(await L.count(db, `SELECT count(*) FROM public.care_interactions WHERE task_id = $1`, [a1.id])).toBe(1)
    // 4c) Q-82: dược sĩ bị tháo store ⇒ không ghi dù còn là assignee.
    await db.query(`UPDATE public.users SET store_id = NULL WHERE id = $1`, [U.A])
    expect(await rec('2026-10-20', U.A, a1.id, 'CALLBACK', 'QA sau tháo store', '2026-10-31')).toBe('NOT_ASSIGNEE')
    // 4d) Q-82: A chuyển QAOS01 → QAOS02 (OS đang hoạt động) mà task vẫn ở QAOS01 ⇒ mất đọc + ghi + cấp URL ảnh.
    await db.query(`UPDATE public.users SET store_id = $1 WHERE id = $2`, [L.storeId(2), U.A])
    expect(await rec('2026-10-20', U.A, a1.id, 'CALLBACK', 'QA sau chuyển store', '2026-10-31')).toBe('NOT_ASSIGNEE')
    const asA = { userId: U.A, storeId: L.storeId(2) }
    const viaRls = await L.as(db, U.A, async () => (await db.query(`SELECT id, assignee_id, store_id, status, period_month::text FROM public.care_tasks WHERE id = $1`, [a1.id])).rows[0] ?? null)
    expect(viaRls).toBeNull()                                                                    // đọc như action/upload: RLS ẩn task
    expect(careStaffTaskBlock(viaRls, asA, P10)).toBe('TASK_NOT_FOUND')
    const raw = await L.one(db, `SELECT id, assignee_id, store_id, status, period_month::text FROM public.care_tasks WHERE id = $1`, [a1.id])
    expect(careStaffTaskBlock(raw, asA, P10)).toBe('NOT_ASSIGNEE')                              // kể cả nếu đọc được dòng
    expect(careStaffTaskBlock(raw, { userId: U.A, storeId: L.storeId(1) }, P10)).toBeNull()        // đối chứng: trước khi chuyển
    expect(await L.as(db, U.A, async () => (await db.query(`SELECT * FROM public.care_my_summary()`)).rows[0].assigned)).toBe(0)
    await db.query(`UPDATE public.users SET store_id = $1 WHERE id = $2`, [L.storeId(1), U.A])
    expect(await L.as(db, U.A, async () => (await db.query(`SELECT * FROM public.care_my_summary()`)).rows[0].assigned)).toBeGreaterThan(0)

    // 5) Fixture is_test của A không lọt summary/list thường.
    const tb = await L.stage(db, [L.row('QA-TEST-ONLY-1', 'QAOS01', L.EA, 'PT1')], { period: P10, actor: U.super, isTest: true })
    expect((await L.finalize(db, tb, U.super, '2026-10-02')).status).toBe('committed')

    // 6) Summary (care_my_summary, hôm nay ghim 20/10) = đếm qua filter danh sách (session A, RLS).
    const storeOf = async (who: string) => (await L.one(db, `SELECT store_id FROM public.users WHERE id = $1`, [who])).store_id
    const listOf = async (who: string, f: CareMyFilter, extra = '') => {
      const w = applyMyTaskFilters(new SqlWhere(), who, await storeOf(who), P10, f, '2026-10-20')
      return L.as(db, who, async () => (await db.query(`SELECT id, status, next_action_date::text, last_interaction_at::text, customer_name FROM public.care_tasks WHERE ${w.sql()} ${extra}`, w.params)).rows)
    }
    const sum = await L.as(db, U.A, async () => (await db.query(`SELECT * FROM public.care_my_summary()`)).rows[0])
    expect({ assigned: sum.assigned, notCared: sum.not_cared, completed: sum.completed, overdue: sum.overdue_live }).toEqual({
      assigned: (await listOf(U.A, 'all')).length, notCared: (await listOf(U.A, 'not_cared')).length,
      completed: (await listOf(U.A, 'completed')).length, overdue: (await listOf(U.A, 'overdue')).length,
    })
    expect(sum.assigned).toBe(4)                 // a0..a3 (a4 đã chuyển cho B; task is_test bị loại)
    expect((await listOf(U.A, 'overdue')).map((r: any) => r.id)).toEqual([a0.id])
    for (const f of CARE_MY_FILTERS) expect((await listOf(U.qlch1, f)).length, `QLCH ${f}`).toBe(0)
    expect((await listOf(U.B, 'all')).some((r: any) => r.id === a4.id)).toBe(true)

    // 7) Q-84 — thứ tự trên TOÀN TẬP đã lọc (như loadMyTaskPage: khoá sort qua RLS → pageMyTasks).
    //    Dược sĩ E (QAOS03) có 10 khách đủ ca: hôm nay, hôm qua, ngày mai, quá hạn xa, hẹn xa, 5 ngày,
    //    chưa gọi ×2, Hoàn thành, Không hoàn thành. Hôm nay ghim 20/10.
    const E = L.staffId(3, 'a'), EMAIL_E = L.STORES[2].assigneeEmails[0]
    const ord = Array.from({ length: 10 }, (_, k) => `QA-ORD-${String(k + 1).padStart(2, '0')}`)
    expect((await L.finalize(db, await L.stage(db, ord.map((e) => L.row(e, 'QAOS03', EMAIL_E, 'P1')), { period: P10 }), U.mkt, '2026-10-02')).status).toBe('committed')
    const o: Record<string, string> = {}
    for (const e of ord) o[e] = (await L.taskOf(db, e, P10)).id
    const plan: [string, string, string, string | null][] = [
      ['QA-ORD-01', '2026-10-20', 'CALLBACK', '2026-10-20'],   // hôm nay (0)
      ['QA-ORD-02', '2026-10-15', 'CALLBACK', '2026-10-19'],   // hôm qua (1, quá hạn)
      ['QA-ORD-03', '2026-10-20', 'CALLBACK', '2026-10-21'],   // ngày mai (1)
      ['QA-ORD-04', '2026-10-01', 'UNREACHABLE', '2026-10-02'], // quá hạn xa (18)
      ['QA-ORD-05', '2026-10-20', 'CALLBACK', '2026-10-31'],   // hẹn xa (11)
      ['QA-ORD-10', '2026-10-20', 'CALLBACK', '2026-10-25'],   // 5 ngày
      ['QA-ORD-08', '2026-10-20', 'INTERESTED', null],         // Hoàn thành
    ]
    for (const [e, day, outcome, next] of plan) expect(await rec(day, E, o[e], outcome, `QA ${e}`, next), e).toBe('OK')
    await db.query(`UPDATE public.care_tasks SET status = 'closed_unfinished', closed_at = now() WHERE id = $1`, [o['QA-ORD-09']])
    const ids = (xs: string[]) => xs.map((e) => o[e])
    const byId = (xs: string[]) => [...xs].sort((x, y) => (o[x] < o[y] ? -1 : 1))
    const expected = [...ids(['QA-ORD-01', 'QA-ORD-02', 'QA-ORD-03', 'QA-ORD-10', 'QA-ORD-05', 'QA-ORD-04']),
      ...ids(byId(['QA-ORD-06', 'QA-ORD-07'])), ...ids(byId(['QA-ORD-08', 'QA-ORD-09']))]
    // SQL mô phỏng cùng quy tắc ⇒ đối chứng hàm thuần.
    const SQL_ORDER = `ORDER BY CASE WHEN status <> 'open' THEN 2 WHEN next_action_date IS NULL THEN 1 ELSE 0 END,
      abs(next_action_date - DATE '2026-10-20'), next_action_date - DATE '2026-10-20', id`
    // E còn 5 khách từ import đầu kỳ ⇒ giới hạn đúng 10 khách QA-ORD (tập lọc vẫn sort TOÀN BỘ).
    const ORD_ONLY = `AND customer_name LIKE 'KH QA-ORD-%'`
    expect((await listOf(E, 'all', `${ORD_ONLY} ${SQL_ORDER}`)).map((r: any) => r.id)).toEqual(expected)
    const keysE = await listOf(E, 'all', ORD_ONLY)
    const pagesOf = (keys: CareMySortKey[], size: number) => {
      const out: string[][] = []
      for (let p = 1; p <= Math.ceil(keys.length / size) + 1; p++) out.push(pageMyTasks(keys, p, '2026-10-20', size).pageIds)
      return out
    }
    const pg = pagesOf(keysE, 4)                                                    // 4 + 4 + 2 + trang rỗng
    expect(pg.map((p) => p.length)).toEqual([4, 4, 2, 0])
    expect(pg.flat()).toEqual(expected)
    expect(new Set(pg.flat()).size).toBe(10)
    expect(careMyBadge(keysE.find((r: any) => r.id === o['QA-ORD-02']), '2026-10-20').tone).toBe('danger')
    // Có tìm kiếm: lọc trước (ILIKE như app), sort toàn tập con, phân trang không lặp/mất.
    const found = await listOf(E, 'all', `${ORD_ONLY} AND customer_name ILIKE '%ORD-0%'`)
    expect(found).toHaveLength(9)                                                    // QA-ORD-10 không khớp
    const pgf = pagesOf(found, 4)
    expect(pgf.flat()).toEqual(expected.filter((id) => id !== o['QA-ORD-10']))
    expect(pgf.map((p) => p.length)).toEqual([4, 4, 1, 0])
    // Bộ lọc Quá hạn cùng quy tắc: hôm qua trước quá hạn xa.
    expect(pageMyTasks(await listOf(E, 'overdue', ORD_ONLY), 1, '2026-10-20').pageIds).toEqual(ids(['QA-ORD-02', 'QA-ORD-04']))
  })
})
