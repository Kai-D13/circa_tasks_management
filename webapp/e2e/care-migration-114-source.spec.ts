import { test, expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { CARE_OUTCOMES, CARE_OUTCOME_META } from '../lib/care/outcome'

// CRM-CSKH B1 — SOURCE-TEXT contract cho migration 114 + chạy QA PGlite.
//
// Migration không chạy trong CI ⇒ khoá bằng văn bản (pattern 105–112) những
// luật đã trả giá bằng sự cố prod: REVOKE đích danh mọi function, UPDATE/DELETE
// có WHERE (pg_safeupdate), policy không đọc thẳng bảng khác (047→049),
// header/preflight/marker/rollback, N3 r3.2 không có cột r3.1, outcome parity.
// Hành vi thật (RLS 5 vai trò, import, biên ngày, chuyển giao, báo cáo) nằm ở
// scripts/qa-care-114.mjs — test cuối chạy script đó nếu máy có PGlite.

const ROOT = path.join(__dirname, '..')
const SQL = fs.readFileSync(path.join(ROOT, '..', 'supabase', 'migrations', '114_care_crm_foundation.sql'), 'utf8')
  .replace(/\r\n/g, '\n')
const EXEC = SQL.slice(SQL.indexOf('\nBEGIN;'), SQL.lastIndexOf('\nCOMMIT;'))
// Bỏ comment dòng để kiểm "code thật".
const CODE = EXEC.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n')

function fnBody(name: string): string {
  const i = SQL.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
  expect(i, `không thấy ${name}`).toBeGreaterThan(-1)
  const j = SQL.indexOf('$$;', SQL.indexOf('$$', i) + 2)
  return SQL.slice(i, j + 3)
}
const quoted = (s: string) => [...s.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort()

test.describe('mig 114 source contract @desktop', () => {
  test('khung migration: header, preflight 113, BEGIN…COMMIT, marker 114 cuối transaction, rollback', () => {
    expect(SQL).toMatch(/^-- Chạy SAU 113\./m)
    expect(SQL).toContain("DELETE FROM public.app_migrations WHERE version = '114';")
    expect(EXEC).toMatch(/IF NOT EXISTS \(SELECT 1 FROM public\.app_migrations WHERE version = '113'\)/)
    const marker = EXEC.lastIndexOf("INSERT INTO public.app_migrations")
    expect(marker).toBeGreaterThan(EXEC.lastIndexOf('END $$;'))
    expect(EXEC.slice(marker)).toContain("ON CONFLICT (version) DO NOTHING")
    expect(SQL).toContain('-- ── VERIFY (chạy sau COMMIT')
    // dollar-quote cân
    const opens = (EXEC.match(/ AS \$\$$/gm) ?? []).length + (EXEC.match(/^DO \$\$$/gm) ?? []).length
    expect(opens).toBe((EXEC.match(/^(END )?\$\$;$/gm) ?? []).length)
  })

  test('mọi function care* đều nằm trong REVOKE … FROM PUBLIC, anon, authenticated', () => {
    // "name type [DEFAULT …]" ⇒ lấy type (token thứ 2) để dựng chữ ký như trong REVOKE.
    const sigs = [...CODE.matchAll(/CREATE OR REPLACE FUNCTION public\.(care\w+)\(([^)]*)\)/g)]
      .map((m) => `${m[1]}(${m[2].split(',').map((a) => a.trim()).filter(Boolean).map((a) => a.split(/\s+/)[1]).join(', ')})`)
    expect(sigs.length).toBe(36) // + care_assignee_uid (r1.1, Q-76/77) + care_staff_reads_task/customer (r1.2, Q-79) + care_staff_store_id (B4 r1.1, Q-82)
    const revoke = CODE.slice(CODE.indexOf('REVOKE ALL ON FUNCTION'), CODE.indexOf('FROM PUBLIC, anon, authenticated, service_role;'))
      .replace(/\s+/g, ' ')
    for (const s of sigs) expect(revoke, s).toContain(`public.${s}`)
    // care__* không bao giờ được GRANT.
    const grants = [...CODE.matchAll(/GRANT EXECUTE ON FUNCTION([\s\S]*?)TO /g)].map((m) => m[1]).join(' ')
    expect(grants).not.toMatch(/care__/)
    // Hệ thống chỉ service_role; RPC người dùng không cấp anon.
    expect(CODE).not.toMatch(/TO anon/)
  })

  test('pg_safeupdate: mọi UPDATE/DELETE có WHERE', () => {
    // Câu lệnh BẮT ĐẦU dòng bằng UPDATE/DELETE FROM (bỏ qua ON CONFLICT DO UPDATE,
    // trigger BEFORE UPDATE, policy FOR UPDATE, SELECT … FOR UPDATE).
    const all = [...CODE.matchAll(/^\s*(?:UPDATE\s+[\w.]+(?:\s+\w+)?\s+SET|DELETE\s+FROM\s+[\w.]+)[\s\S]*?;/gm)].map((m) => m[0])
    expect(all.length).toBeGreaterThanOrEqual(10)
    for (const s of all) expect(s, s.trim().slice(0, 80)).toMatch(/\bWHERE\b/)
  })

  test('policy không đọc thẳng bảng khác — chỉ cột + helper SECURITY DEFINER', () => {
    const policies = [...CODE.matchAll(/CREATE POLICY (\w+) ON public\.(\w+)[\s\S]*?;/g)]
    expect(policies.length).toBe(14) // care_access ×4 + 10 bảng SELECT
    for (const [text, name] of policies) {
      expect(text, name).not.toMatch(/\bFROM\b|\bJOIN\b|EXISTS\s*\(/)
    }
    // Helper dùng trong policy là SECURITY DEFINER STABLE với search_path cố định.
    for (const h of ['care_can_view_all', 'care_can_import', 'care_scope_store_ids', 'care_assignee_uid', 'care_staff_store_id', 'care_can_read_task', 'care_can_read_customer_history']) {
      expect(fnBody(h), h).toMatch(/STABLE SECURITY DEFINER SET search_path = public/)
    }
    // Q-76/77: QLCH không có scope; nhánh "assignee" chỉ mở cho app role staff — mọi chỗ so assignee
    // dùng care_assignee_uid(), không so thẳng auth.uid().
    expect(fnBody('care_scope_store_ids')).not.toMatch(/store_manager/)
    expect(fnBody('care_assignee_uid')).toMatch(/CASE WHEN public\.get_user_role\(\) = 'staff' THEN auth\.uid\(\) END/)
    expect(CODE).not.toMatch(/assignee_id\s*=\s*\(?\s*(select\s+)?auth\.uid\(\)/i)
    for (const f of ['care_can_read_task', 'care_can_read_customer_history', 'care_report', 'care_my_summary']) expect(fnBody(f), f).toContain('care_assignee_uid()')
    expect(CODE).toMatch(/CREATE POLICY care_tasks_select[\s\S]*?\(assignee_id = \(select public\.care_assignee_uid\(\)\) AND store_id = \(select public\.care_staff_store_id\(\)\)\)/)
    // Q-82 (B4 r1.1): MỌI nhánh assignee của staff đi kèm store task = care_staff_store_id() (OS active).
    expect(fnBody('care_staff_store_id')).toMatch(/u\.role = 'staff' AND s\.store_type = 'os' AND s\.is_active/)
    expect(fnBody('care_can_read_task')).toContain('(t.assignee_id = public.care_assignee_uid() AND t.store_id = public.care_staff_store_id())')
    expect(fnBody('care_can_read_customer_history')).toContain('(t.assignee_id = public.care_assignee_uid() AND t.store_id = public.care_staff_store_id())')
    expect(fnBody('care_report')).toContain('(t.assignee_id = me.uid AND t.store_id = me.staff_store)')
    expect(fnBody('care_report')).toContain('(a.assignee_id = me.uid AND a.store_id = me.staff_store)')
    expect(fnBody('care_my_summary')).toContain('t.assignee_id = me.uid AND t.store_id = me.store_id')
    expect(fnBody('care__record_interaction_at')).toContain('IF public.care_staff_store_id() IS DISTINCT FROM t.store_id THEN')
    // Mọi function so assignee với care_assignee_uid() (trực tiếp hoặc qua me.uid) đều có điều kiện store.
    const assigneeFns = [...CODE.matchAll(/CREATE OR REPLACE FUNCTION public\.(care\w+)\(/g)].map((m) => m[1])
      .filter((f) => /assignee_id = (public\.care_assignee_uid\(\)|me\.uid)/.test(fnBody(f)))
    expect(assigneeFns.sort()).toEqual(['care_can_read_customer_history', 'care_can_read_task', 'care_my_summary', 'care_report', 'care_staff_reads_customer', 'care_staff_reads_task'])
    for (const f of assigneeFns) expect(fnBody(f), f).toContain('care_staff_store_id()')
    expect(CODE).toMatch(/CREATE POLICY care_access_select[\s\S]*?\(select public\.get_user_role\(\)\) = 'admin' AND department_id/)
    // Q-79: SM đọc dữ liệu con theo store SNAPSHOT của dòng; nhánh staff qua helper chỉ-assignee.
    const pol = (name: string) => new RegExp(`CREATE POLICY ${name}[\\s\\S]*?;`).exec(CODE)![0]
    const SCOPE = 'ANY ((select public.care_scope_store_ids())::uuid[])'
    expect(pol('care_interactions_select')).toContain(`store_id = ${SCOPE}`)
    expect(pol('care_assignment_events_select')).toContain('ARRAY[from_store_id, to_store_id] && ((select public.care_scope_store_ids())::uuid[])')
    // Nhánh staff chặn sớm bằng InitPlan (SM/admin không gọi helper theo dòng — db-reviewer r1.2 P2).
    for (const p of ['care_interactions_select', 'care_assignment_events_select', 'care_store_refusals_select', 'care_order_attributions_select']) {
      expect(pol(p), p).toMatch(/\(\(select public\.care_assignee_uid\(\)\) IS NOT NULL AND public\.care_staff_reads_(task|customer)\(/)
    }
    // Chuyển giao: kiểm scope nguồn TRƯỚC trạng thái/kỳ (không lộ trạng thái task ngoài vùng).
    const tr = fnBody('care__transfer_tasks_at')
    expect(tr.indexOf('SM không quản lý cửa hàng nguồn')).toBeLessThan(tr.indexOf('chỉ chuyển task đang mở của kỳ hiện tại'))
    expect(pol('care_store_refusals_select')).toContain(`store_id = ${SCOPE}`)
    expect(pol('care_order_attributions_select')).toContain(`store_id = ${SCOPE}`)
    for (const p of ['care_interactions_select', 'care_assignment_events_select', 'care_store_refusals_select', 'care_order_attributions_select']) {
      expect(pol(p), p).not.toMatch(/care_can_read_task|care_can_read_customer_history/)
    }
    for (const f of ['care_staff_reads_task', 'care_staff_reads_customer']) {
      expect(fnBody(f), f).toMatch(/STABLE SECURITY DEFINER SET search_path = public/)
      expect(fnBody(f), f).toContain('t.assignee_id = public.care_assignee_uid()')
      expect(fnBody(f), f).toContain('t.store_id = public.care_staff_store_id()')
      expect(fnBody(f), f).not.toContain('care_scope_store_ids')
    }
    // Không policy nào mở cho staging / queue.
    expect(CODE).not.toMatch(/ON public\.care_import_staging FOR/)
    expect(CODE).not.toMatch(/ON public\.care_reconcile_queue FOR/)
  })

  test('care_orders đúng N3 r3.2; report không đọc care_orders', () => {
    const orders = CODE.slice(CODE.indexOf('CREATE TABLE IF NOT EXISTS public.care_orders'), CODE.indexOf('CREATE INDEX IF NOT EXISTS care_orders_customer_time_idx'))
    for (const c of ['order_key', 'customer_external_id', 'ordered_at', 'source_updated_at', 'net_amount', 'pos_code']) expect(orders).toContain(c)
    // Chỉ quét ĐỊNH NGHĨA bảng (khối hậu kiểm nhắc tên các cột này để kiểm chúng vắng mặt).
    expect(orders).not.toMatch(/is_valid_order|is_deleted|order_status|\bchannel\b|store_code/)
    expect(CODE).not.toMatch(/ALTER TABLE public\.care_orders\s+ADD/)
    expect(fnBody('care_report')).not.toMatch(/care_orders\b/)
    // Audit PM B1 P1: thẻ dược sĩ loại fixture QA như báo cáo.
    expect(fnBody('care_my_summary')).toContain('AND NOT t.is_test')
    expect(fnBody('care_report')).toMatch(/NOT t\.is_test/)
    // B5 chưa có mặt ở 114.
    expect(CODE).not.toMatch(/care_upsert_orders|care_recompute_attribution/)
  })

  test('outcome SQL ↔ lib/care/outcome.ts (6 mã, terminal, ngày hẹn, DNC)', () => {
    expect(quoted(fnBody('care_is_outcome'))).toEqual([...CARE_OUTCOMES].sort())
    expect(quoted(fnBody('care_is_terminal_outcome'))).toEqual(CARE_OUTCOMES.filter((o) => CARE_OUTCOME_META[o].terminal).sort())
    expect(quoted(fnBody('care_outcome_requires_date'))).toEqual(CARE_OUTCOMES.filter((o) => CARE_OUTCOME_META[o].requiresNextActionDate).sort())
    expect(quoted(fnBody('care_outcome_records_refusal'))).toEqual(CARE_OUTCOMES.filter((o) => CARE_OUTCOME_META[o].recordsStoreRefusal).sort())
    expect(SQL).toContain('TODO(Q-02)')
    expect(SQL).toContain('TODO(Q-03)')
  })

  test('một helper mốc trễ cho cả 3 đường; giờ VN không phụ thuộc server', () => {
    expect(fnBody('care_overdue_stamp')).toMatch(/p_next < p_today AND p_next < p_due/)
    for (const f of ['care__record_interaction_at', 'care__stamp_overdue_at', 'care__close_period_at']) {
      expect(fnBody(f), f).toContain('public.care_overdue_stamp(')
      expect(fnBody(f), f).not.toMatch(/next_action_date \+ 1/)
    }
    expect(fnBody('care_vn_date')).toContain("AT TIME ZONE 'Asia/Ho_Chi_Minh'")
    expect(fnBody('care_vn_today')).toContain('public.care_vn_date(now())')
    expect(CODE).not.toMatch(/CURRENT_DATE|now\(\)::date/)
  })

  test('ghi/chuyển giao/finalize khoá FOR UPDATE và kiểm toàn bộ trước khi ghi', () => {
    const tr = fnBody('care__transfer_tasks_at')
    expect(tr.indexOf('ORDER BY id FOR UPDATE')).toBeGreaterThan(-1)
    expect(tr.indexOf('INSERT INTO public.care_assignment_events')).toBeGreaterThan(tr.lastIndexOf('RAISE EXCEPTION'))
    const fin = fnBody('care__import_finalize_at')
    // Đóng kỳ / tạo khách chỉ xảy ra SAU nhánh rejected.
    expect(fin.indexOf("status = 'rejected'")).toBeLessThan(fin.indexOf('care__close_period_at(p_today)'))
    expect(fin.indexOf("status = 'rejected'")).toBeLessThan(fin.indexOf('INSERT INTO public.care_customers'))
    expect(fin).toContain('pg_advisory_xact_lock')
    // Audit PM B1 P0: email phải khớp ĐÚNG MỘT staff của store (không UPDATE … FROM users chọn tuỳ ý).
    expect(fin).toContain("'ASSIGNEE_AMBIGUOUS'")
    expect(fin).toContain('assignee_matches > 1')
    expect(fin).not.toMatch(/SET assignee_id = u\.id/)
    expect(fnBody('care__record_interaction_at')).toContain('FOR UPDATE')
  })

  test('QA PGlite (scripts/qa-care-114.mjs): 0 lỗi', () => {
    test.skip(!fs.existsSync(path.join(ROOT, 'node_modules', '@electric-sql', 'pglite')),
      'chưa cài PGlite — chạy: npm i --no-save @electric-sql/pglite@0.2.17 (trong webapp/)')
    test.skip(!fs.existsSync(path.join(ROOT, 'node_modules', 'xlsx')),
      'chưa cài dependency (xlsx) — chạy npm ci trong webapp/ (script dùng fixture Excel của e2e/careImportFixture.ts)')
    test.setTimeout(180_000)
    const r = spawnSync(process.execPath, ['scripts/qa-care-114.mjs'], { cwd: ROOT, encoding: 'utf8', timeout: 170_000 })
    const out = `${r.stdout}`
    const summary = out.match(/(\d+) đạt · (\d+) lỗi/)
    expect(summary, out.split('\n').filter((l) => l.includes('❌')).join('\n') || r.stderr.slice(-500)).not.toBeNull()
    expect(Number(summary![2]), out.split('\n').filter((l) => l.includes('❌')).join('\n')).toBe(0)
    expect(Number(summary![1])).toBeGreaterThanOrEqual(160)
    expect(r.status).toBe(0)
  })
})
