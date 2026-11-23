import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import {
  CARE_REASON_MAX, careFilterHref, careReasonKey, careReasonLabel, careStatusChipTabs, careTaskReasons,
  parseCareFilters, parseCareReason,
} from '../lib/care/browse'

// PM 22/11/2026 — nhãn + lọc "Lý do" trên /care/tasks; migration 133 (NO_NEED hẹn lại + care_reason_options).
// Logic thuần + pin nguồn ở đây; hành vi SQL thật (RLS theo vai, lọc imatch, ACL, rollback) ở scripts/qa-care-133.mjs (test cuối).

const ROOT = path.resolve(__dirname, '..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n')

test.describe('care PM 22/11 — Lý do chăm sóc: logic thuần @desktop', () => {
  test('một phép chuẩn hoá: trim + chữ thường; rỗng / quá dài / không phải chuỗi ⇒ null', () => {
    expect(careReasonKey(' Chronic ')).toBe('chronic')
    expect(careReasonKey('PROMOTION')).toBe('promotion')
    expect(careReasonKey('Tái khám Định Kỳ')).toBe('tái khám định kỳ')
    for (const bad of ['', '   ', null, undefined, 5, ['chronic'], 'x'.repeat(CARE_REASON_MAX + 1)]) expect(careReasonKey(bad), String(bad)).toBeNull()
    expect(careReasonKey('x'.repeat(CARE_REASON_MAX))).toHaveLength(CARE_REASON_MAX)
  })

  test('nhãn: chronic → Mãn tính, promotion → Khuyến mãi; ngoài mẫu hiện theo file; khoá kiểu __proto__ không lấy nhầm thuộc tính', () => {
    expect(careReasonLabel('chronic', 'Chronic')).toBe('Mãn tính')
    expect(careReasonLabel('promotion')).toBe('Khuyến mãi')
    expect(careReasonLabel('tái khám', ' Tái khám ')).toBe('Tái khám')
    expect(careReasonLabel('tái khám')).toBe('tái khám')
    expect(careReasonLabel('constructor', 'Constructor')).toBe('Constructor')
    expect(careReasonLabel('__proto__')).toBe('__proto__')
  })

  test('nhãn của task: hai lý do ⇒ hai nhãn; lặp / khác hoa thường ⇒ một nhãn; sản phẩm cũ (is_current=false) và lý do trống không tính', () => {
    const p = (reason_type: string | null, is_current = true) => ({ is_current, reason_type })
    expect(careTaskReasons([p('Chronic'), p('promotion')])).toEqual([{ key: 'promotion', label: 'Khuyến mãi' }, { key: 'chronic', label: 'Mãn tính' }])
    expect(careTaskReasons([p('Chronic'), p('chronic'), p(' CHRONIC ')])).toEqual([{ key: 'chronic', label: 'Mãn tính' }])
    expect(careTaskReasons([p('chronic'), p('promotion', false)])).toEqual([{ key: 'chronic', label: 'Mãn tính' }])
    expect(careTaskReasons([p('promotion', false)])).toEqual([])
    expect(careTaskReasons([p(null), p(''), p('   ')])).toEqual([])
    expect(careTaskReasons(null)).toEqual([])
    // Ngoài mẫu: theo file; hai biến thể hoa / thường ⇒ một nhãn, chọn ổn định (không phụ thuộc thứ tự dòng).
    const a = careTaskReasons([p('tái khám'), p('Tái khám')]), b = careTaskReasons([p('Tái khám'), p('tái khám')])
    expect(a).toEqual(b)
    expect(a).toEqual([{ key: 'tái khám', label: 'Tái khám' }])
  })

  test('URL: ?reason= cùng chuẩn hoá; sai ⇒ không lọc; parseCareFilters dùng chung KHÔNG nhận reason (tổng quan / báo cáo / export không đổi)', () => {
    expect(parseCareReason({ reason: ' Chronic ' })).toBe('chronic')
    expect(parseCareReason({ reason: '' })).toBeNull()
    expect(parseCareReason({ reason: ['chronic', 'promotion'] })).toBeNull()
    expect(parseCareReason({})).toBeNull()
    expect(parseCareReason({ reason: 'x'.repeat(60) })).toBeNull()
    expect('reason' in parseCareFilters({ reason: 'chronic' }, '2026-11-01')).toBe(false)
    const f = { ...parseCareFilters({ month: '2026-11', status: 'not_cared', page: '3' }, '2026-11-01'), reason: 'chronic' }
    expect(careFilterHref('/care/tasks', f)).toBe('/care/tasks?month=2026-11&status=not_cared&reason=chronic&page=3')
    expect(careFilterHref('/care/tasks', f, { reason: null, page: 1 })).toBe('/care/tasks?month=2026-11&status=not_cared')
    expect(careFilterHref('/care/tasks', { ...f, reason: 'tái khám' }, { page: 1 })).toContain('reason=t%C3%A1i+kh%C3%A1m')
    // Chip trạng thái giữ lý do đang lọc, về trang 1.
    const tabs = careStatusChipTabs('/care/tasks', f, null)
    expect(tabs.length).toBeGreaterThan(1)
    for (const t of tabs) { expect(t.href, t.href).toContain('reason=chronic'); expect(t.href).not.toContain('page=') }
  })

  test('không còn lọc bằng regex / embed: app chỉ gửi KHOÁ đã chuẩn hoá cho RPC (so bằng lower(btrim) trong SQL)', () => {
    const lib = read('lib/care/browse.ts'), srv = read('lib/care/server/browse.ts')
    // Chỉ còn nhắc tới trong chú thích giải thích lý do bỏ — không còn trong mã.
    expect((lib + srv).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')).not.toMatch(/careReasonPattern|imatch|!inner/)
    expect(srv).toContain("return key ? { p_period: f.month, p_reason: key, p_is_test: careDataScope().kind === 'qa' } : null")
  })
})

test.describe('care PM 22/11 — Lý do chăm sóc: pin nguồn @desktop', () => {
  test('/care/tasks: trang + tìm kiếm + bộ lọc + bảng dùng CÙNG khoá; đổi lọc về trang 1; nhãn xuống dòng trên mobile', () => {
    const page = read('app/(dashboard)/care/tasks/page.tsx')
    expect(page).toContain('const f = { ...parseCareFilters(sp, current), reason: parseCareReason(sp) }')
    expect(page).toContain('reasons={reasons ?? []}')                                  // lỗi đọc danh sách ⇒ vẫn hiện trang (không sập)
    expect(read('app/actions/care.ts')).toContain('reason: parseCareReason(input.params ?? {}) }')
    const bar = read('components/care/CareFiltersBar.tsx')
    expect(bar).toContain("{ value: '', label: 'Tất cả lý do' }")
    expect(bar).toContain('onValueChange={(v) => go({ reason: v || null })}')
    expect(bar).toContain('go({ storeId: null, assigneeId: null, status: null, reason: null })')
    expect(bar).toMatch(/const go = [\s\S]{0,200}page: 1/)
    const table = read('components/care/CareTaskTable.tsx')
    expect(table).toContain("reason: filters.reason ?? ''")
    expect(table).toMatch(/data-testid="care-task-reasons"[\s\S]{0,200}<StatusBadge key=\{x\.key\} tone="info" size="sm" className="max-w-full break-words whitespace-normal">/)
    expect(table).toMatch(/className="mt-1 flex flex-wrap gap-1" data-testid="care-task-reasons"/)
    // Các màn dùng chung CareFilters không đọc / không truyền lý do.
    for (const f of ['app/(dashboard)/care/page.tsx', 'app/(dashboard)/care/reports/page.tsx', 'app/api/export/care/route.ts', 'lib/care/server/reports.ts']) {
      expect(read(f), f).not.toMatch(/parseCareReason|loadCareReasonOptions|care_reason_options/)
    }
  })

  test('migration 133: khung, REVOKE đích danh + GRANT, không backfill / không sửa dữ liệu, rollback có chặn', () => {
    const sql = fs.readFileSync(path.join(ROOT, '..', 'supabase', 'migrations', '133_care_no_need_callback.sql'), 'utf8').replace(/\r\n/g, '\n')
    const exec = sql.slice(sql.indexOf('\nBEGIN;'), sql.lastIndexOf('\nCOMMIT;')).split('\n').map((l) => l.replace(/--.*$/, '')).join('\n')
    expect(exec).toMatch(/INSERT INTO public\.app_migrations[\s\S]*'133'/)
    expect(exec).not.toMatch(/\b(UPDATE|DELETE FROM|TRUNCATE|ALTER TABLE|DROP)\b/)       // chỉ định nghĩa hàm + marker
    // Hai helper outcome KHÔNG definer; hai hàm lý do SECURITY DEFINER STABLE + search_path cố định + phạm vi tường minh = policy care_tasks_select.
    expect(exec.match(/LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS/g)).toHaveLength(2)
    expect(exec.match(/LANGUAGE sql IMMUTABLE AS/g)).toHaveLength(2)
    expect(exec).not.toMatch(/SECURITY INVOKER/)
    const SCOPE = "((t.assignee_id = (select public.care_assignee_uid()) AND t.store_id = (select public.care_staff_store_id()))\n         OR (select public.care_can_view_all())\n         OR t.store_id = ANY ((select public.care_scope_store_ids())::uuid[]))"
    expect(exec.split(SCOPE)).toHaveLength(3)                                          // đúng hai hàm, cùng một điều kiện
    const pol = /CREATE POLICY care_tasks_select ON public\.care_tasks FOR SELECT TO authenticated[\s\S]*?;/.exec(fs.readFileSync(path.join(ROOT, '..', 'supabase', 'migrations', '114_care_crm_foundation.sql'), 'utf8').replace(/\r\n/g, '\n'))![0]
    const norm = (x: string) => x.replace(/--.*$/gm, '').replace(/\bt\./g, '').replace(/\s+/g, ' ')
    expect(norm(pol)).toContain(norm(SCOPE))                                           // chép NGUYÊN điều kiện USING của 114
    expect(exec).toMatch(/care_reason_options\(p_period date, p_is_test boolean DEFAULT false\)[\s\S]*?STABLE SECURITY DEFINER SET search_path = public/)
    expect(exec).toMatch(/care_tasks_by_reason\(p_period date, p_reason text, p_is_test boolean DEFAULT false\)\s*RETURNS SETOF public\.care_tasks\s*LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public/)
    expect(exec).toContain('LOCK TABLE public.care_tasks IN EXCLUSIVE MODE;')
    expect(exec).toContain('lower(btrim(p.reason_type)) = lower(btrim(p_reason))')
    expect(exec).toMatch(/lower\(btrim\(/)
    for (const fn of ['care_is_terminal_outcome(text)', 'care_outcome_requires_date(text)', 'care_reason_options(date, boolean)', 'care_tasks_by_reason(date, text, boolean)']) {
      expect(exec, fn).toContain(`public.${fn}`)
    }
    expect(exec).toMatch(/REVOKE ALL ON FUNCTION[\s\S]*?FROM PUBLIC, anon, authenticated, service_role/)
    // PM 23/11 §4 d: hai helper outcome giữ ma trận 114 (authenticated + service_role); hai RPC lý do CHỈ authenticated.
    const grants = exec.match(/GRANT EXECUTE ON FUNCTION[^;]*;/g) ?? []
    expect(grants).toHaveLength(2)
    expect(grants[0]!.replace(/\s+/g, ' ')).toBe('GRANT EXECUTE ON FUNCTION public.care_is_terminal_outcome(text), public.care_outcome_requires_date(text) TO authenticated, service_role;')
    expect(grants[1]!.replace(/\s+/g, ' ')).toBe('GRANT EXECUTE ON FUNCTION public.care_reason_options(date, boolean), public.care_tasks_by_reason(date, text, boolean) TO authenticated;')
    // Tiền kiểm so NGUYÊN biểu thức policy (không còn LIKE theo tên helper) + chỉ một policy đọc, PERMISSIVE, đúng role.
    expect(exec).not.toMatch(/pol\.qual LIKE/)
    expect(exec).toContain("regexp_replace(replace(pol.qual, 'public.', ''), '[[:space:]]+', '', 'g')")
    expect(exec).toContain("pol.permissive = 'PERMISSIVE' AND pol.roles = ARRAY['authenticated']::name[]")
    const pinned = /= '(\(\(\(assignee_id=[^']+)'\) THEN/.exec(exec)![1]
    // Chuỗi chuẩn = điều kiện SCOPE của hai hàm (bỏ "t.", "public.", khoảng trắng; PG thêm ngoặc + bí danh cột cho từng subselect).
    const bare = (x: string) => x.replace(/\bt\./g, '').replace(/public\./g, '').replace(/AS\w+(?=\))/g, '').replace(/[\s()]/g, '').toLowerCase()
    expect(bare(pinned.replace(/SELECT/g, 'select'))).toBe(bare(SCOPE))
    expect(exec).not.toMatch(/GRANT[^;]*\banon\b/)
    expect(exec).toMatch(/has_function_privilege/)
    const rb = fs.readFileSync(path.join(ROOT, '..', 'supabase', 'migrations', 'rollback', '133_care_no_need_callback_rollback.sql'), 'utf8')
    expect(rb).toContain("WHERE outcome = 'NO_NEED' AND NOT is_terminal")
    expect(rb).toContain("DELETE FROM public.app_migrations WHERE version = '133'")
    expect(rb).toContain('DROP FUNCTION IF EXISTS public.care_reason_options(date, boolean)')
    expect(rb).toContain('DROP FUNCTION IF EXISTS public.care_tasks_by_reason(date, text, boolean)')
    expect(rb).toContain('LOCK TABLE public.care_tasks IN EXCLUSIVE MODE;')
    // PM 23/11 §4 g: chú thích nêu đủ hai hàm bị DROP; hậu kiểm theo TÊN (mọi chữ ký); câu R0 kiểm điều kiện chặn TRƯỚC khi hạ app.
    expect(rb).toContain('--   3. DROP FUNCTION care_tasks_by_reason(date, text, boolean);')
    expect(rb).toContain("p.proname IN ('care_reason_options', 'care_tasks_by_reason')")
    expect(rb).toMatch(/-- R0\) SELECT count\(\*\) AS no_need_kieu_moi/)
  })

  test('QA PGlite (scripts/qa-care-133.mjs): 0 lỗi', () => {
    test.skip(!fs.existsSync(path.join(ROOT, 'node_modules', '@electric-sql', 'pglite')),
      'chưa cài PGlite — chạy: npm i --no-save @electric-sql/pglite@0.2.17 (trong webapp/)')
    test.setTimeout(180_000)
    const r = spawnSync(process.execPath, ['scripts/qa-care-133.mjs'], { cwd: ROOT, encoding: 'utf8', timeout: 170_000 })
    const out = `${r.stdout}`
    const bad = out.split('\n').filter((l) => l.includes('❌')).join('\n')
    const summary = out.match(/(\d+) đạt · (\d+) lỗi/)
    expect(summary, bad || r.stderr.slice(-500)).not.toBeNull()
    expect(Number(summary![2]), bad).toBe(0)
    expect(Number(summary![1])).toBeGreaterThanOrEqual(70)
  })
})
