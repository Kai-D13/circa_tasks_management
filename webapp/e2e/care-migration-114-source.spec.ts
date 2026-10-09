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
    expect(sigs.length).toBe(41) // + care_assignee_uid (r1.1, Q-76/77) + care_staff_reads_task/customer (r1.2, Q-79) + care_staff_store_id (B4 r1.1, Q-82) + care_recompute_attribution/care_order_sync_status (B5a) + care_order_sync_candidates/apply/fail (B5b.2)
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
    expect(policies.length).toBe(12) // care_access ×4 + 8 bảng SELECT (attribution Q-95, đơn thô Q-101: không policy)
    expect(policies.map((p) => p[2])).not.toContain('care_order_attributions')
    expect(policies.map((p) => p[2])).not.toContain('care_orders')
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
    for (const p of ['care_interactions_select', 'care_assignment_events_select', 'care_store_refusals_select']) {
      expect(pol(p), p).toMatch(/\(\(select public\.care_assignee_uid\(\)\) IS NOT NULL AND public\.care_staff_reads_(task|customer)\(/)
    }
    // Chuyển giao: kiểm scope nguồn TRƯỚC trạng thái/kỳ (không lộ trạng thái task ngoài vùng).
    const tr = fnBody('care__transfer_tasks_at')
    expect(tr.indexOf('SM không quản lý cửa hàng nguồn')).toBeLessThan(tr.indexOf('chỉ chuyển task đang mở của kỳ hiện tại'))
    expect(pol('care_store_refusals_select')).toContain(`store_id = ${SCOPE}`)
    // Q-95: attribution KHÔNG còn policy/GRANT SELECT cho authenticated — chỉ đọc qua care_report DEFINER.
    expect(CODE).not.toMatch(/CREATE POLICY care_order_attributions_select/)
    expect(CODE).toContain('DROP POLICY IF EXISTS care_order_attributions_select ON public.care_order_attributions;')
    const grantSel = /GRANT SELECT ON ([\s\S]*?)\s+TO authenticated;/.exec(CODE)![1]
    expect(grantSel).not.toContain('care_order_attributions')
    expect(grantSel).not.toMatch(/care_orders\b/) // Q-101
    expect(grantSel).toContain('care_sync_state') // Q-101 không mở rộng sang trạng thái đồng bộ
    // Q-105: care_customers chỉ quyền CỘT (id, is_test, created_at) — mọi GRANT SELECT mức bảng cho
    // authenticated (kể cả câu GRANT khác) đều không được nhắc bảng này; external_id không bao giờ được cấp.
    for (const m of CODE.matchAll(/GRANT SELECT ON ([\s\S]*?)\s+TO ([\w, ]+);/g)) {
      if (/authenticated|anon|PUBLIC/.test(m[2])) expect(m[1], m[0]).not.toContain('care_customers')
    }
    expect(CODE).toContain('GRANT SELECT (id, is_test, created_at) ON public.care_customers TO authenticated;')
    expect(CODE).toContain('REVOKE SELECT (external_id) ON public.care_customers FROM PUBLIC, anon, authenticated;')
    expect(CODE).not.toMatch(/GRANT SELECT \([^)]*external_id[^)]*\) ON public\.care_customers/)
    expect(CODE).toContain("has_column_privilege('authenticated', a.attrelid, a.attnum, 'SELECT')\n                    IS DISTINCT FROM (a.attname IN ('id', 'is_test', 'created_at'))")
    expect(CODE).not.toMatch(/CREATE POLICY care_orders_select/)
    expect(CODE).toContain('DROP POLICY IF EXISTS care_orders_select ON public.care_orders;')
    expect(CODE).toMatch(/CREATE POLICY care_sync_state_select/)
    expect(CODE).toMatch(/v_t NOT IN \('care_import_staging', 'care_reconcile_queue', 'care_order_attributions', 'care_orders'\)/)
    expect(CODE).toMatch(/tablename LIKE 'care\\_%'\) <> 12 THEN/)
    expect(CODE).toContain("FOREACH v_t IN ARRAY ARRAY['care_order_attributions', 'care_orders'] LOOP")
    for (const p of ['care_interactions_select', 'care_assignment_events_select', 'care_store_refusals_select']) {
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

  test('care_orders đúng N3 r3.4 ba cột (Q-91/Q-93); attribution/sync_state không tiền/cursor; report không đọc care_orders', () => {
    const table = (name: string) => {
      const at = CODE.indexOf(`CREATE TABLE IF NOT EXISTS public.${name} (`)
      return CODE.slice(at, CODE.indexOf('\n);', at))
    }
    const cols = (body: string) => body.split('\n').slice(1).map((l) => /^\s+([a-z_]+)\s+/.exec(l)?.[1]).filter(Boolean)
    expect(cols(table('care_orders'))).toEqual(['order_key', 'customer_external_id', 'ordered_at', 'synced_at'])
    expect(table('care_orders')).toMatch(/ordered_at\s+timestamptz NOT NULL,/)                // completed_at không NULL (Q-93)
    expect(cols(table('care_order_attributions'))).toEqual(['order_key', 'interaction_id', 'task_id', 'customer_id', 'assignee_id', 'store_id', 'period_month', 'is_test', 'computed_at'])
    expect(cols(table('care_sync_state'))).toEqual(['source', 'last_success_at', 'last_error', 'updated_at'])
    // last_error chỉ nhận MÃ lỗi (care admin SELECT được bảng) — không message BigQuery thô/PII.
    expect(table('care_sync_state')).toContain("last_error          text CHECK (last_error ~ '^[A-Z][A-Z0-9_]{0,63}$')")
    // Không còn tiền / mốc sửa nguồn / mã POS / cursor trong DDL + function (trước khối hậu kiểm — khối đó
    // nhắc các tên này để kiểm chúng VẮNG mặt).
    const ddl = CODE.slice(0, CODE.indexOf("RAISE EXCEPTION '114 hậu kiểm"))
    expect(ddl.length).toBeGreaterThan(10_000)
    expect(ddl).not.toMatch(/net_amount|source_updated_at|pos_code|net_revenue|cursor_ts|cursor_key|bi_complete_through/)
    expect(CODE).not.toMatch(/CREATE INDEX IF NOT EXISTS care_orders_cursor_idx/)
    expect(CODE).toContain('CREATE INDEX IF NOT EXISTS care_orders_customer_time_idx ON public.care_orders (customer_external_id, ordered_at)')
    expect(table('care_orders')).not.toMatch(/is_valid_order|is_deleted|order_status|\bchannel\b|store_code|\bstatus\b/)
    expect(CODE).not.toMatch(/ALTER TABLE public\.care_orders\s+ADD/)
    expect(fnBody('care_report')).not.toMatch(/care_orders\b/)
    // care_report GĐ1: chỉ converted_tasks = COUNT(DISTINCT task_id) — không số đơn/tiền (Q-91).
    expect(CODE).toMatch(/overdue_in_period integer, closed_unfinished integer,\s+converted_tasks integer\)\s+LANGUAGE sql/)
    expect(fnBody('care_report')).toContain('count(DISTINCT a.task_id)::int AS conv_tasks')
    expect(fnBody('care_report')).not.toMatch(/count\(\*\)::int AS orders|sum\(/)
    // Audit PM B1 P1: thẻ dược sĩ loại fixture QA như báo cáo.
    expect(fnBody('care_my_summary')).toContain('AND NOT t.is_test')
    expect(fnBody('care_report')).toMatch(/NOT t\.is_test/)
    // B5b (đồng bộ nguồn) chưa có mặt ở 114; B5a chỉ có tính lại attribution + trạng thái đơn.
    expect(CODE).not.toMatch(/care_upsert_orders/)
    expect(table('care_orders')).toContain('order_key = btrim(order_key)')
    expect(table('care_orders')).toContain('customer_external_id = btrim(customer_external_id)')
    // Hậu kiểm: tập cột chính xác (bảng cũ sáu cột không lọt qua CREATE TABLE IF NOT EXISTS).
    expect(CODE).toContain("IS DISTINCT FROM 'customer_external_id,order_key,ordered_at,synced_at'")
    expect(CODE).toContain("IS DISTINCT FROM 'last_error,last_success_at,source,updated_at'")
  })

  test('B5a: care_recompute_attribution — lượt terminal gần nhất STRICT trước ordered_at, snapshot lượt, một câu lệnh, service_role only', () => {
    const f = fnBody('care_recompute_attribution')
    expect(f).toMatch(/LANGUAGE plpgsql SECURITY DEFINER SET search_path = public/)
    expect(f).toContain('i.is_terminal AND i.created_at < o.ordered_at')                 // strict <
    expect(f).toContain('ORDER BY i.created_at DESC, i.id DESC')                          // hoà ⇒ id lớn hơn
    expect(f).toContain('LIMIT 1')
    // Phạm vi: đơn theo khách/khoá + attribution đang gán cho khách (tra theo customer_id — dùng index).
    expect(f).toContain('WHERE a.customer_id IN (SELECT c.id FROM public.care_customers c WHERE c.external_id = ANY (v_ext))')
    expect(f).toContain('IF cardinality(v_ext) > 20000 OR cardinality(v_keys) > 20000 THEN')
    expect(SQL).toContain('TODO(Q-03): ghi công theo is_terminal')
    expect(SQL).not.toContain('TODO(Q-89)')                                                  // Q-89 đã chốt
    expect(SQL).toContain('Q-89 (đã chốt): REFUSED là terminal, VẪN ghi')
    expect(f).not.toMatch(/outcome/)                                                         // không loại outcome nào ngoài is_terminal
    // Hợp đồng sink B5b đã hiện thực ở 9c (B5b.2): mốc thành công không lùi, lượt cũ không xoá lỗi lượt mới.
    expect(SQL).not.toContain('TODO(B5b)')
    expect(SQL).toContain('last_success_at = GREATEST(cũ, snapshot), last_error chỉ xoá khi snapshot')
    // Hợp đồng B5b: queue chỉ bổ sung, không được quên task "Chưa thấy đơn".
    expect(SQL).toContain('drain queue không được làm quên task "Chưa thấy')
    // Snapshot người/store/tháng/task lấy từ LƯỢT (w.*), không từ care_tasks hiện tại.
    expect(f).toContain('w.task_id, w.customer_id, w.assignee_id, w.store_id,')
    expect(f).not.toMatch(/care_tasks|pos_code|net_amount/)
    expect(f).toContain("pg_advisory_xact_lock(hashtext('care_recompute_attribution'))")
    // Một câu lệnh WITH … del AS (DELETE …) , up AS (INSERT … ON CONFLICT) ⇒ tất cả-hoặc-không.
    expect(f).toMatch(/WITH scope AS \([\s\S]*?\), desired AS \([\s\S]*?\), del AS \(\s*DELETE FROM public\.care_order_attributions a\s+USING scope s\s+WHERE/)
    expect(f).toMatch(/ON CONFLICT \(order_key\) DO UPDATE[\s\S]*?IS DISTINCT FROM/)
    const revoke = CODE.slice(CODE.indexOf('REVOKE ALL ON FUNCTION'), CODE.indexOf('FROM PUBLIC, anon, authenticated, service_role;'))
    expect(revoke).toContain('public.care_recompute_attribution(text[], text[])')
    const grants = [...CODE.matchAll(/GRANT EXECUTE ON FUNCTION([\s\S]*?)TO ([\w, ]+);/g)].map((m) => ({ fns: m[1], to: m[2].trim() }))
    expect(grants.filter((g) => g.fns.includes('care_recompute_attribution')).map((g) => g.to)).toEqual(['service_role'])
    expect(grants.filter((g) => g.fns.includes('care_order_sync_status')).map((g) => g.to)).toEqual(['authenticated'])
    const st = fnBody('care_order_sync_status')
    expect(st).toMatch(/STABLE SECURITY DEFINER SET search_path = public/)
    expect(st).toContain('WHERE public.care_can_view_all() OR cardinality(public.care_scope_store_ids()) > 0')
    expect(st).not.toMatch(/last_error\s*[,)]|s\.cursor/)                                    // không trả lỗi thô / cursor
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

  test('collation (db-reviewer P0 B5b.2): không so thứ tự sắp xếp text với literal trừ khi COLLATE "C"; apply kiểm key theo TẬP', () => {
    // Prod datcollate = en_US.UTF-8 (bỏ qua '_' ở mức đầu ⇒ 'ordered_at' < 'order_key'); PGlite = C ⇒ QA không
    // thấy lỗi kiểu này. Mọi aggregate có ORDER BY trong code thật phải ghim COLLATE "C".
    const ordered = [...CODE.matchAll(/(array_agg|string_agg)\(([^()]|\([^()]*\))*?ORDER BY ([^)]*)\)/g)]
    expect(ordered.length).toBeGreaterThan(0)
    for (const m of ordered) expect(m[3], m[0]).toContain('COLLATE "C"')
    const apply = fnBody('care_order_sync_apply')
    expect(apply).toContain("NOT (e ?& ARRAY['customer_external_id', 'order_key', 'ordered_at'])")
    expect(apply).toContain('(SELECT count(*) FROM jsonb_object_keys(e)) <> 3')
    expect(apply).not.toMatch(/array_agg\(k ORDER BY k\)/)
    // Giá trị khớp CHECK care_orders được kiểm TRƯỚC khi ghi (không để CHECK ghi giá trị thô vào log Postgres).
    expect(apply).toContain("e ->> 'order_key' <> btrim(e ->> 'order_key')")
    expect(apply).toContain("e ->> 'customer_external_id' <> btrim(e ->> 'customer_external_id')")
    expect(apply).toContain("e ->> 'ordered_at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{6}Z$'")
    expect(apply.indexOf('phần tử đơn sai dạng')).toBeLessThan(apply.indexOf('INSERT INTO public.care_orders'))
    expect(fnBody('care_order_sync_fail')).toContain("IF p_code IS NULL OR p_code !~ '^[A-Z][A-Z0-9_]{0,63}$' THEN")
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
