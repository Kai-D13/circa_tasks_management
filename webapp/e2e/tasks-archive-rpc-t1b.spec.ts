import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { test, expect } from '@playwright/test'
import {
  ARCHIVE_DISABLED_MESSAGE, ARCHIVE_MAX_IDS, ARCHIVE_MAX_RAW, ARCHIVE_RPC, archiveErrorMessage, archiveSuccessMessage, normalizeArchiveIds,
  parseArchiveResult, runArchiveRpc,
} from '../lib/tasks/archiveRpc'

// T1-B (PM 24/10 `planning/reviews/2026-10-24-tasks-integrity-lag-brief-pm.md`): lưu trữ / khôi phục hàng loạt chỉ qua RPC 117.
// Test thuần (không DB thật): chuẩn hoá ID, ánh xạ lỗi, kiểm kết quả, client RPC giả; test nguồn khoá action không còn đường ghi
// supabaseAdmin và cờ OFF dừng trước mọi đọc/ghi; hợp đồng quyền / atomic của RPC chạy bằng QA PGlite 117 (scripts/qa-tasks-archive-117.mjs).

const ROOT = path.resolve(__dirname, '..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n')
const uuids = (n: number) => Array.from({ length: n }, () => crypto.randomUUID())

type Call = { fn: string; args: { p_ids: string[]; p_action: string } }
function fakeClient(reply: { data: unknown; error: { message?: string; code?: string } | null } | Error) {
  const calls: Call[] = []
  return {
    calls,
    rpc: (fn: string, args: Call['args']) => {
      calls.push({ fn, args })
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply)
    },
  }
}

test.describe('tasks T1-B — lưu trữ / khôi phục hàng loạt qua RPC 117 @desktop', () => {
  test('chuẩn hoá ID: rỗng / không phải mảng / sai UUID ⇒ lỗi; loại trùng + chữ thường; trần 1.000 sau loại trùng', () => {
    expect(normalizeArchiveIds([])).toEqual({ error: 'Không có task nào được chọn' })
    expect(normalizeArchiveIds('x')).toEqual({ error: 'Không có task nào được chọn' })
    expect('error' in normalizeArchiveIds(['khong-phai-uuid'])).toBe(true)
    expect('error' in normalizeArchiveIds([crypto.randomUUID(), null])).toBe(true)
    const a = crypto.randomUUID()
    expect(normalizeArchiveIds([a.toUpperCase(), a, a])).toEqual({ ids: [a] })
    const two = uuids(522)
    expect(normalizeArchiveIds(two)).toEqual({ ids: two })
    expect(normalizeArchiveIds(uuids(ARCHIVE_MAX_IDS))).toHaveProperty('ids')
    expect(normalizeArchiveIds(uuids(ARCHIVE_MAX_IDS + 1))).toEqual({ error: 'Chọn tối đa 1.000 task mỗi lần — bỏ bớt rồi thử lại' })
    expect(normalizeArchiveIds([...Array(1500).fill(a)])).toEqual({ ids: [a] })
  })

  test('trần mảng thô 5.000 (như RPC) kiểm TRƯỚC khi duyệt / loại trùng: 5.000 ⇒ qua; 5.001 ⇒ lỗi, kể cả toàn bản trùng hay phần tử rác', async () => {
    expect(ARCHIVE_MAX_RAW).toBe(5000)
    const a = crypto.randomUUID()
    expect(normalizeArchiveIds(Array(ARCHIVE_MAX_RAW).fill(a))).toEqual({ ids: [a] })
    const tooMany = { error: 'Chọn tối đa 1.000 task mỗi lần — bỏ bớt rồi thử lại' }
    expect(normalizeArchiveIds(Array(ARCHIVE_MAX_RAW + 1).fill(a))).toEqual(tooMany)
    expect(normalizeArchiveIds(Array(ARCHIVE_MAX_RAW + 1).fill('rac'))).toEqual(tooMany)
    const c = fakeClient({ data: { target_count: 1, changed_count: 1 }, error: null })
    expect(await runArchiveRpc(c, Array(ARCHIVE_MAX_RAW + 1).fill(a), 'archive')).toEqual(tooMany)
    expect(c.calls).toHaveLength(0)
    expect(await runArchiveRpc(c, Array(ARCHIVE_MAX_RAW).fill(a), 'archive')).toEqual({ success: true, count: 1, target: 1 })
    expect(c.calls[0].args.p_ids).toEqual([a])
  })

  test('toast thành công = số task THỰC SỰ đổi (changed_count); 0 ⇒ câu trung tính; TaskList không dùng số ID đã chọn', () => {
    expect(archiveSuccessMessage('archive', 3)).toBe('Đã lưu trữ 3 task')
    expect(archiveSuccessMessage('restore', 261)).toBe('Đã khôi phục 261 task')
    expect(archiveSuccessMessage('archive', 0)).toBe('Không có task nào cần lưu trữ')
    expect(archiveSuccessMessage('restore', 0)).toBe('Không có task nào cần khôi phục')
    const tl = read('components/tasks/TaskList.tsx')
    expect(tl).toContain("import { archiveSuccessMessage } from '@/lib/tasks/archiveRpc'")
    for (const [fn, action] of [['handleArchive', 'archive'], ['handleRestore', 'restore']]) {
      const start = tl.indexOf(`function ${fn}()`)
      const body = tl.slice(start, tl.indexOf('\n  }\n', start))
      // Lỗi ⇒ toast lỗi, giữ selection; thành công ⇒ toast theo changed_count rồi mới xoá selection.
      expect(body).toMatch(new RegExp(`if \\(!result\\.success\\) \\{\\s*toast\\.error\\(result\\.error\\)\\s*\\} else \\{\\s*toast\\.success\\(archiveSuccessMessage\\('${action}', result\\.count\\)\\)\\s*setSelected\\(new Set\\(\\)\\)`))
      expect(body).not.toContain('ids.length')
      expect(body).not.toContain('??')
    }
  })

  test('ánh xạ lỗi RPC: thông báo ngắn, không lộ ID / chi tiết DB; mã rollback ⇒ "chưa … task nào"', () => {
    const leak = '00000000-0000-4000-8000-000000000042'
    const cases: [string, string | undefined, RegExp][] = [
      ['TASKS_ARCHIVE_OUT_OF_SCOPE', '42501', /^Có task ngoài quyền của bạn — chưa lưu trữ task nào/],
      ['TASKS_ARCHIVE_NOT_FOUND', 'P0001', /^Có task không còn tồn tại — chưa lưu trữ task nào/],
      ['TASKS_ARCHIVE_TOO_MANY', 'P0001', /tối đa 1\.000 task chọn, 5\.000 task kể cả task con/],
      ['TASKS_ARCHIVE_CONCURRENT_CHANGE', 'P0001', /^Task đang được thao tác khác thay đổi — chưa lưu trữ task nào/],
      ['TASKS_ARCHIVE_COUNT_MISMATCH', 'P0001', /^Không lưu trữ được — kết quả ghi không khớp, chưa task nào thay đổi/],
      ['canceling statement due to lock timeout', '55P03', /^Task đang được thao tác khác thay đổi/],
      ['canceling statement due to statement timeout', '57014', /^Task đang được thao tác khác thay đổi/],
      ['deadlock detected', '40P01', /^Task đang được thao tác khác thay đổi/],
      ['TASKS_ARCHIVE_FORBIDDEN', '42501', /^Bạn không có quyền lưu trữ task$/],
      ['TASKS_ARCHIVE_UNAUTHENTICATED', '42501', /^Phiên đăng nhập đã hết/],
      ['TASKS_ARCHIVE_BAD_INPUT', '22023', /^Danh sách task không hợp lệ/],
      ['Could not find the function public.rpc_set_tasks_archived', 'PGRST202', /chưa sẵn sàng — chưa task nào thay đổi/],
    ]
    for (const [message, code, re] of cases) {
      const msg = archiveErrorMessage('archive', { message: `${message} (task ${leak})`, code })
      expect(msg, message).toMatch(re)
      expect(msg).not.toContain(leak)
      expect(msg).not.toContain('TASKS_ARCHIVE')
    }
    expect(archiveErrorMessage('restore', { message: 'TASKS_ARCHIVE_OUT_OF_SCOPE' })).toMatch(/chưa khôi phục task nào/)
    // Lỗi không nhận ra (mạng, …): không khẳng định "chưa thay đổi".
    const unknown = archiveErrorMessage('archive', { message: 'fetch failed' })
    expect(unknown).toBe('Không lưu trữ được — tải lại trang để xem trạng thái rồi thử lại')
    expect(archiveErrorMessage('archive', null)).toBe(unknown)
  })

  test('kết quả RPC phải đúng hợp đồng: số nguyên, 0 ≤ changed ≤ target, target ≥ số ID chọn', () => {
    expect(parseArchiveResult({ target_count: 522, changed_count: 522 }, 2)).toEqual({ target: 522, changed: 522 })
    expect(parseArchiveResult({ target_count: 522, changed_count: 0 }, 2)).toEqual({ target: 522, changed: 0 })
    for (const bad of [null, [], 'x', {}, { target_count: 1, changed_count: 2 }, { target_count: 1, changed_count: 1 },
      { target_count: 2.5, changed_count: 1 }, { target_count: '522', changed_count: 1 }, { target_count: 5, changed_count: -1 }]) {
      expect(parseArchiveResult(bad, 2), JSON.stringify(bad)).toBeNull()
    }
  })

  test('runArchiveRpc: ID lỗi ⇒ KHÔNG gọi RPC; 2 nhóm 261 ⇒ một lời gọi (body, không chia chunk) ⇒ count = changed', async () => {
    const bad = fakeClient({ data: null, error: null })
    expect(await runArchiveRpc(bad, ['x'], 'archive')).toHaveProperty('error')
    expect(await runArchiveRpc(bad, uuids(1001), 'archive')).toHaveProperty('error')
    expect(bad.calls).toHaveLength(0)

    const ids = uuids(522)
    const okc = fakeClient({ data: { target_count: 522, changed_count: 500 }, error: null })
    expect(await runArchiveRpc(okc, ids, 'restore')).toEqual({ success: true, count: 500, target: 522 })
    expect(okc.calls).toEqual([{ fn: ARCHIVE_RPC, args: { p_ids: ids, p_action: 'restore' } }])
  })

  test('runArchiveRpc: lỗi RPC / kết quả sai / client ném lỗi ⇒ trả lỗi (UI giữ selection), không báo thành công', async () => {
    const ids = uuids(3)
    const scope = await runArchiveRpc(fakeClient({ data: null, error: { message: 'TASKS_ARCHIVE_OUT_OF_SCOPE', code: '42501' } }), ids, 'archive')
    expect(scope).toEqual({ error: archiveErrorMessage('archive', { message: 'TASKS_ARCHIVE_OUT_OF_SCOPE' }) })
    const shape = await runArchiveRpc(fakeClient({ data: { target_count: 1, changed_count: 1 }, error: null }), ids, 'archive')
    expect(shape).toEqual({ error: 'Không xác nhận được kết quả lưu trữ — tải lại trang để kiểm tra' })
    const thrown = await runArchiveRpc(fakeClient(new Error('socket hang up')), ids, 'archive')
    expect(thrown.error).toBe(archiveErrorMessage('archive', null))
  })

  test('nguồn action: cờ OFF dừng TRƯỚC createClient; chỉ gọi runArchiveRpc bằng session; không còn supabaseAdmin / .update / .in', () => {
    const src = read('app/actions/tasks.ts')
    const i = src.indexOf('async function setTasksArchived(')
    expect(i).toBeGreaterThan(0)
    const body = src.slice(i, src.indexOf('\n}\n', i))
    const flag = body.indexOf('if (!isTasksArchiveRpcEnabled()) return { error: ARCHIVE_DISABLED_MESSAGE }')
    expect(flag).toBeGreaterThan(0)
    expect(flag).toBeLessThan(body.indexOf('await createClient()'))
    expect(body).toContain('const result = await runArchiveRpc(supabase, ids, action)')
    for (const banned of ['supabaseAdmin', ".from('tasks')", '.update(', '.in(', 'getSmStoreIds', 'smHasStore']) expect(body, banned).not.toContain(banned)
    expect(src).toMatch(/export async function archiveTasks\(ids: string\[\]\) \{\n  return setTasksArchived\(ids, 'archive'\)\n\}/)
    expect(src).toMatch(/export async function restoreTasks\(ids: string\[\]\) \{\n  return setTasksArchived\(ids, 'restore'\)\n\}/)
    // Không còn chỗ nào trong actions ghi archived_at của tasks trực tiếp.
    expect(src).not.toMatch(/update\(\{\s*archived_at/)
    expect(ARCHIVE_DISABLED_MESSAGE).toMatch(/tạm dừng — chưa task nào thay đổi/)
  })

  test('cờ TASKS_ARCHIVE_RPC_ENABLED: mặc định OFF (chỉ "true" mới bật), khai báo trong .env.example; OFF ⇒ ẩn nút bulk', () => {
    const flags = read('lib/tasks/flags.ts')
    expect(flags).toContain("import 'server-only'")
    expect(flags).toContain("return process.env.TASKS_ARCHIVE_RPC_ENABLED === 'true'")
    expect(read('.env.example')).toMatch(/^TASKS_ARCHIVE_RPC_ENABLED=false$/m)
    const page = read('app/(dashboard)/tasks/page.tsx')
    expect(page).toContain('const bulkArchiveEnabled = isTasksArchiveRpcEnabled()')
    expect(page).toContain('bulkArchiveEnabled={bulkArchiveEnabled}')
    const tl = read('components/tasks/TaskList.tsx')
    expect(tl).toContain('bulkArchiveEnabled = false')
    expect(tl).toContain('{canArchive && bulkArchiveEnabled && (')
    expect(tl).toContain('{canRestore && bulkArchiveEnabled && (')
    expect(tl.match(/handleArchive|handleRestore/g)?.length).toBe(4) // định nghĩa + onClick, chỉ trong nút đã gate
  })

  test('migration 117: hợp đồng RPC (SECURITY DEFINER, search_path, quyền chỉ authenticated, preflight 116, marker) — QA PGlite ALL PASS', () => {
    const mig = read('../supabase/migrations/117_tasks_archive_rpc.sql')
    expect(mig).toContain('CREATE OR REPLACE FUNCTION public.rpc_set_tasks_archived(p_ids uuid[], p_action text)')
    expect(mig).toMatch(/SECURITY DEFINER\nSET search_path = public\nSET lock_timeout = '4s'/)
    expect(mig).toContain('REVOKE ALL ON FUNCTION public.rpc_set_tasks_archived(uuid[], text) FROM PUBLIC, anon, authenticated, service_role;')
    expect(mig).toContain('GRANT EXECUTE ON FUNCTION public.rpc_set_tasks_archived(uuid[], text) TO authenticated;')
    expect(mig).toContain("IF NOT EXISTS (SELECT 1 FROM public.app_migrations WHERE version = '116') THEN")
    expect(mig).toMatch(/INSERT INTO public\.app_migrations \(version, name, notes\)\nVALUES \('117', 'tasks_archive_rpc'/)
    const r = spawnSync(process.execPath, ['scripts/qa-tasks-archive-117.mjs'], { cwd: ROOT, encoding: 'utf8', timeout: 180_000 })
    const tail = (r.stdout ?? '').split('\n').filter(Boolean).slice(-3).join('\n')
    expect(r.status, tail + (r.stderr ?? '').slice(0, 500)).toBe(0)
    expect(r.stdout).toMatch(/ALL PASS \d+\/0/)
  })
})
