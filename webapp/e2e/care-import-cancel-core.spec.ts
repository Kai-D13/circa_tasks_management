import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, expect } from '@playwright/test'
import {
  CARE_CANCEL_MESSAGES, CARE_CANCEL_REVALIDATE, CARE_CANCEL_RPC_CODES, CARE_CANCEL_WARNING, careCancelBatchInScope, isCareBatchId, mapCancelRpcError,
  parseCareCommitSeq, readCancelPreview, readCancelResult, runCareCancel, runCareCancelPreview, type CareCancelDeps,
} from '../lib/care/importCancel'
import { careImportCancelEnabledFromEnv } from '../lib/care/config'

// CRM-CSKH D1 — huỷ import (Q-149–163, SPEC §Sau go-live D, thiết kế D0 r1.5 §7–§8). Unit THUẦN + pin nguồn (không DB / mạng).
// Phần DB (RPC, trigger, khôi phục, rollback) kiểm ở scripts/qa-care-115.mjs trên PGlite.

const ROOT = path.resolve(__dirname, '..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n')
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const counts = { tasks_deleted: 3, tasks_restored: 1, products_deleted: 5, products_restored: 2, events_deleted: 3, customers_deleted: 3 }

test.describe('care D1 — huỷ import: logic thuần @desktop', () => {
  test('cờ CARE_IMPORT_CANCEL_ENABLED: chỉ đúng chuỗi "true"; .env.example khai OFF', () => {
    expect(careImportCancelEnabledFromEnv({})).toBe(false)
    for (const v of ['1', 'TRUE', ' true', 'yes', '']) expect(careImportCancelEnabledFromEnv({ CARE_IMPORT_CANCEL_ENABLED: v })).toBe(false)
    expect(careImportCancelEnabledFromEnv({ CARE_IMPORT_CANCEL_ENABLED: 'true' })).toBe(true)
    expect(read('.env.example')).toMatch(/^CARE_IMPORT_CANCEL_ENABLED=false$/m)
  })

  test('commitSeq: chuỗi số nguyên dương trong miền bigint, so CHUỖI (không Number)', () => {
    for (const ok of ['1', '42', '9007199254740993', '9223372036854775807']) expect(parseCareCommitSeq(ok)).toBe(ok)
    for (const bad of ['0', '01', '-1', '1.0', '1e3', ' 1', '1 ', '', '9223372036854775808', '99999999999999999999', 'abc'])
      expect(parseCareCommitSeq(bad), bad).toBeNull()
    for (const bad of [1, 9007199254740993, null, undefined, {}, ['1']]) expect(parseCareCommitSeq(bad as unknown)).toBeNull()
    // 9007199254740993 (> 2^53) giữ nguyên từng chữ số — Number sẽ làm tròn thành ...992.
    expect(parseCareCommitSeq('9007199254740993')).toBe('9007199254740993')
  })

  test('batchId UUID; phạm vi: production chỉ batch thật, QA chỉ batch QA của marker', () => {
    expect(isCareBatchId('8705b628-0000-4000-8000-000000000001')).toBe(true)
    for (const bad of ['', 'x', '8705b628-0000-4000-8000-00000000000', null, 1]) expect(isCareBatchId(bad)).toBe(false)
    const real = { id: 'a', is_test: false }, test1 = { id: 'b', is_test: true }
    expect(careCancelBatchInScope(real, { kind: 'production' })).toBe(true)
    expect(careCancelBatchInScope(test1, { kind: 'production' })).toBe(false)
    expect(careCancelBatchInScope(null, { kind: 'production' })).toBe(false)
    expect(careCancelBatchInScope(test1, { kind: 'qa', batchId: 'b' })).toBe(true)
    expect(careCancelBatchInScope(test1, { kind: 'qa', batchId: 'c' })).toBe(false)
    expect(careCancelBatchInScope(real, { kind: 'qa', batchId: 'a' })).toBe(false)
  })

  test('đọc preview / kết quả RPC: đúng dạng mới nhận; sai dạng ⇒ FAILED (fail-closed); mã từ chối giữ nguyên', () => {
    expect(readCancelPreview({ status: 'ready', commit_seq: '12', kind: 'revision', ...counts })).toEqual({
      ok: true, commitSeq: '12', kind: 'revision',
      counts: { tasksDeleted: 3, tasksRestored: 1, productsDeleted: 5, productsRestored: 2, eventsDeleted: 3, customersDeleted: 3 },
    })
    expect(readCancelPreview({ status: 'ready', commit_seq: 12, kind: 'initial', ...counts })).toEqual({ ok: false, code: 'FAILED' })   // số, không phải chuỗi
    expect(readCancelPreview({ status: 'ready', commit_seq: '12', kind: 'initial', ...counts, tasks_deleted: -1 })).toEqual({ ok: false, code: 'FAILED' })
    expect(readCancelPreview({ status: 'ready', commit_seq: '12', kind: 'other', ...counts })).toEqual({ ok: false, code: 'FAILED' })
    for (const code of CARE_CANCEL_RPC_CODES) expect(readCancelPreview({ status: 'rejected', code })).toEqual({ ok: false, code })
    expect(readCancelPreview({ status: 'rejected', code: 'SQL_INJECTED' })).toEqual({ ok: false, code: 'FAILED' })
    expect(readCancelPreview(null)).toEqual({ ok: false, code: 'FAILED' })
    expect(readCancelResult({ status: 'cancelled', batch_id: 'x', kind: 'initial', ...counts }).ok).toBe(true)
    expect(readCancelResult({ status: 'cancelled', ...counts, customers_deleted: '3' })).toEqual({ ok: false, code: 'FAILED' })
    expect(readCancelResult({ status: 'rejected', code: 'NOT_LATEST' })).toEqual({ ok: false, code: 'NOT_LATEST' })
  })

  test('lỗi RPC: 55P03 / 40P01 ⇒ RETRYABLE; thiếu tham số ⇒ INVALID_INPUT; khác ⇒ FAILED; mọi mã có chữ an toàn', () => {
    expect(mapCancelRpcError({ code: '55P03', message: 'lock timeout' })).toBe('RETRYABLE')
    expect(mapCancelRpcError({ code: '40P01', message: 'deadlock' })).toBe('RETRYABLE')
    expect(mapCancelRpcError({ code: 'P0001', message: 'care_import_cancel: thiếu tham số' })).toBe('INVALID_INPUT')
    expect(mapCancelRpcError({ code: '42501', message: 'permission denied' })).toBe('FAILED')
    expect(mapCancelRpcError(null)).toBe('FAILED')
    for (const [k, v] of Object.entries(CARE_CANCEL_MESSAGES)) {
      expect(v.length, k).toBeGreaterThan(5)
      expect(v, k).not.toMatch(/SQL|select|batch_id|\bP0001\b/i)
    }
  })

  test('Q-157: câu cảnh báo cố định nguyên văn', () => {
    expect(CARE_CANCEL_WARNING).toBe('Huỷ file sẽ xoá các task chưa có lượt chăm sóc và hoàn nguyên thay đổi của file. Task kỳ trước đã đóng khi import sẽ không được mở lại.')
  })
})

test.describe('care D1 — huỷ import: pin nguồn @desktop', () => {
  test('server action: đúng 2 export, chỉ nối phụ thuộc THẬT (cờ, quyền session, phạm vi, service role, revalidate) vào luồng thuần', () => {
    const src = read('app/actions/careImportCancel.ts')
    const code = stripComments(src)
    expect(src).toMatch(/^'use server'/)
    expect([...code.matchAll(/export async function (\w+)/g)].map((m) => m[1]).sort()).toEqual(['cancelCareImport', 'previewCareImportCancel'])
    for (const s of ['enabled: isCareImportCancelEnabled,', 'access: getCareImportAccess,', 'scope: careDataScope,', 'revalidate: (p) => revalidatePath(p),',
      "supabaseAdmin.from('care_import_batches').select('id, is_test').eq('id', id).maybeSingle()", 'await supabaseAdmin.rpc(fn, args)',
      'return runCareCancelPreview(input, deps)', 'return runCareCancel(input, deps)']) expect(code, s).toContain(s)
    const lib = stripComments(read('lib/care/importCancel.ts'))
    for (const c of [code, lib]) {
      expect(c).not.toMatch(/Number\(|parseInt|parseFloat|BigInt\(/)
      expect(c).not.toMatch(/console\.(log|error|warn)/)
    }
    // Luồng thuần không phụ thuộc Next/Supabase (test được không cần server).
    expect(lib).not.toMatch(/from '(next|@supabase|@\/lib\/supabase)/)
  })

  test('luồng action (phụ thuộc giả): thứ tự cờ → input → quyền → phạm vi → RPC; mã lỗi đúng; commitSeq chuỗi nguyên văn; revalidate chỉ khi huỷ xong', async () => {
    const OK_ID = '8705b628-0000-4000-8000-000000000001'
    const make = (o: Partial<{ enabled: boolean; access: { kind: string; actorId?: string }; batch: { id: string; is_test: boolean } | null; loadError: unknown;
      scope: { kind: 'production' } | { kind: 'qa'; batchId: string }; data: unknown; error: { code?: string; message?: string } | null }> = {}) => {
      const calls: string[] = [], rpcArgs: unknown[] = [], revalidated: string[] = []
      const deps: CareCancelDeps = {
        enabled: () => { calls.push('enabled'); return o.enabled ?? true },
        access: async () => { calls.push('access'); return o.access ?? { kind: 'ok', actorId: 'actor-1' } },
        loadBatch: async () => { calls.push('load'); return { data: o.batch === undefined ? { id: OK_ID, is_test: false } : o.batch, error: o.loadError ?? null } },
        scope: () => o.scope ?? { kind: 'production' },
        rpc: async (fn, args) => { calls.push(`rpc:${fn}`); rpcArgs.push(args); return { data: o.data ?? null, error: o.error ?? null } },
        revalidate: (p) => { revalidated.push(p) },
      }
      return { deps, calls, rpcArgs, revalidated }
    }
    const ready = { status: 'ready', commit_seq: '9007199254740993', kind: 'revision', ...counts }
    // Cờ OFF ⇒ NOT_ENABLED, không đọc quyền / DB.
    let m = make({ enabled: false })
    expect(await runCareCancelPreview({ batchId: OK_ID }, m.deps)).toEqual({ ok: false, code: 'NOT_ENABLED' })
    expect(m.calls).toEqual(['enabled'])
    // Input sai ⇒ INVALID_INPUT trước khi đọc quyền.
    m = make()
    expect(await runCareCancel({ batchId: 'x', expectedCommitSeq: '1' }, m.deps)).toEqual({ ok: false, code: 'INVALID_INPUT' })
    expect(m.calls).toEqual(['enabled'])
    // Quyền: anonymous / unavailable / forbidden / ok thiếu actor ⇒ không đọc batch, không RPC.
    for (const [access, code] of [[{ kind: 'anonymous' }, 'UNAUTHENTICATED'], [{ kind: 'unavailable' }, 'UNAVAILABLE'], [{ kind: 'forbidden' }, 'FORBIDDEN'], [{ kind: 'ok' }, 'FORBIDDEN']] as const) {
      m = make({ access })
      expect(await runCareCancel({ batchId: OK_ID, expectedCommitSeq: '1' }, m.deps), code).toEqual({ ok: false, code })
      expect(m.calls, code).toEqual(['enabled', 'access'])
    }
    // Phạm vi: lỗi đọc ⇒ UNAVAILABLE; không có / is_test ở production / batch thật ở QA ⇒ NOT_FOUND; không RPC.
    for (const [o, code] of [[{ loadError: { code: 'x' } }, 'UNAVAILABLE'], [{ batch: null }, 'NOT_FOUND'], [{ batch: { id: OK_ID, is_test: true } }, 'NOT_FOUND'],
      [{ scope: { kind: 'qa', batchId: OK_ID } as const }, 'NOT_FOUND']] as const) {
      m = make(o)
      expect(await runCareCancelPreview({ batchId: OK_ID }, m.deps), code).toEqual({ ok: false, code })
      expect(m.calls.some((c) => c.startsWith('rpc:')), code).toBe(false)
    }
    // Preview ok: RPC 2 tham số, actor từ session (không từ input), commitSeq chuỗi giữ đủ chữ số.
    m = make({ data: ready })
    const p = await runCareCancelPreview({ batchId: OK_ID, p_actor: 'attacker' } as never, m.deps)
    expect(p).toMatchObject({ ok: true, commitSeq: '9007199254740993', kind: 'revision' })
    expect(m.rpcArgs).toEqual([{ p_batch_id: OK_ID, p_actor: 'actor-1' }])
    expect(m.calls).toEqual(['enabled', 'access', 'load', 'rpc:care_import_cancel_preview'])
    // Huỷ: commitSeq sai ⇒ INVALID_INPUT, không RPC; đúng ⇒ RPC 3 tham số nguyên văn chuỗi + revalidate 5 đường.
    for (const bad of [undefined, 9007199254740993, '0', '01', '9223372036854775808']) {
      m = make({ data: { status: 'cancelled', ...counts } })
      expect(await runCareCancel({ batchId: OK_ID, expectedCommitSeq: bad } as never, m.deps), String(bad)).toEqual({ ok: false, code: 'INVALID_INPUT' })
      expect(m.calls.some((c) => c.startsWith('rpc:')), String(bad)).toBe(false)
    }
    m = make({ data: { status: 'cancelled', batch_id: OK_ID, kind: 'revision', ...counts } })
    expect((await runCareCancel({ batchId: OK_ID, expectedCommitSeq: '9007199254740993' }, m.deps)).ok).toBe(true)
    expect(m.rpcArgs).toEqual([{ p_batch_id: OK_ID, p_actor: 'actor-1', p_expected_commit_seq: '9007199254740993' }])
    expect(m.revalidated).toEqual([...CARE_CANCEL_REVALIDATE])
    // RPC từ chối / lỗi ⇒ mã giữ nguyên hoặc map; KHÔNG revalidate.
    for (const [o, code] of [[{ data: { status: 'rejected', code: 'NOT_LATEST' } }, 'NOT_LATEST'], [{ data: { status: 'rejected', code: 'HAS_ACTIVITY' } }, 'HAS_ACTIVITY'],
      [{ error: { code: '55P03', message: 'lock' } }, 'RETRYABLE'], [{ error: { code: 'XX000', message: 'boom' } }, 'FAILED'], [{ data: { status: 'weird' } }, 'FAILED']] as const) {
      m = make(o)
      expect(await runCareCancel({ batchId: OK_ID, expectedCommitSeq: '5' }, m.deps), code).toEqual({ ok: false, code })
      expect(m.revalidated, code).toEqual([])
    }
  })

  test('PostgREST (db-reviewer D1 P2-7): journal 115 có FK tới care_tasks + care_import_batches ⇒ cấm embed TRẦN giữa 2 bảng (phải ghi !…_fkey)', () => {
    const files: string[] = []
    const walk = (d: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
        const p = `${d}/${e.name}`
        if (e.isDirectory()) { if (!['node_modules', '.next'].includes(e.name)) walk(p) } else if (/\.(ts|tsx)$/.test(e.name)) files.push(p)
      }
    }
    for (const d of ['app', 'lib', 'components']) walk(d)
    const bare = files.flatMap((f) => [...read(f).matchAll(/[\s,(:]care_(import_batches|tasks|import_revision_journal|cancel_tokens)\s*\(/g)].map((m) => `${f}: ${m[0].trim()}`))
    expect(bare).toEqual([])
    expect(files.length).toBeGreaterThan(50)
  })

  test('race 115 (Q-168): cổng CLI thoát 2 TRƯỚC mọi request + không tạo marker; lit chặn giá trị lạ; SQL không BEGIN/COMMIT, DELETE luôn có phạm vi', async () => {
    const { spawnSync } = await import('node:child_process')
    const run = (env: Record<string, string>, args: string[] = []) => spawnSync(process.execPath, ['scripts/qa-race-115.mjs', ...args],
      { cwd: ROOT, env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ...env } as unknown as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 20_000 })
    for (const [env, args, needle] of [
      [{}, [], 'QA_RACE_115_ALLOWED'],
      [{ QA_RACE_115_ALLOWED: 'YES', QA_EXPECTED_PROJECT_HOST: 'sai.example.test' }, [], 'QA_EXPECTED_PROJECT_HOST'],
      [{ QA_RACE_115_ALLOWED: 'YES' }, ['xoa-het'], 'dùng:'],
    ] as const) {
      const r = run(env as Record<string, string>, [...args])
      expect(r.status, needle).toBe(2)
      expect(r.stderr, needle).toContain(needle)
    }
    expect(fs.existsSync(path.join(ROOT, '.qa-race-115.json'))).toBe(false)
    const R = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib-race-115.mjs')).href)
    expect(() => R.lit("x'; DROP TABLE t; --", /^[0-9a-f-]{36}$/, 'id')).toThrow()
    expect(R.lit('00000000-0000-4000-8000-000000000001', /^[0-9a-f-]{36}$/, 'id')).toBe("'00000000-0000-4000-8000-000000000001'")
    expect(R.raceExternalIds('deadbeef', 'r1a', 2)).toEqual(['QA-R115-deadbeef-r1a-1', 'QA-R115-deadbeef-r1a-2'])
    const lib = read('scripts/lib-race-115.mjs'), cli = read('scripts/qa-race-115.mjs')
    for (const src of [lib, cli]) expect(src).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK)\s*;/)
    const dels = [...lib.matchAll(/DELETE FROM public\.(\w+) WHERE ([^;]+);/g)]
    expect(dels.length).toBe(10)
    for (const [, table, where] of dels) expect(where, table).toMatch(/is_test|= ANY \(\$\{bArr\}\)|IN \$\{C\}|IN \$\{T\}/)
    expect(lib).not.toMatch(/(INSERT INTO|DELETE FROM|UPDATE) public\.care_orders/)
    expect(lib).toContain("'[]'::jsonb")                                   // lượt ghi không kèm ảnh (không object GCS)
    expect(cli.indexOf('writeMarker(marker)')).toBeLessThan(cli.indexOf('await runRace115('))
  })

  test("race 115 preflight (PM D1 r1.1 P1): rào ENABLE ALWAYS ('A') được nhận; 'O' / 'D' / thiếu / sai định nghĩa / chưa 115 bị từ chối; khớp chính migration 115", async () => {
    const R = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib-race-115.mjs')).href)
    const good = { has_115: 1, barrier_state: 'A', barrier_ok: true }
    expect(R.judgeRaceBarrier(good)).toBeNull()
    for (const [row, needle] of [
      [undefined, 'migration 115 chưa áp'],
      [{ has_115: 0, barrier_state: null, barrier_ok: false }, 'migration 115 chưa áp'],
      [{ ...good, barrier_state: null, barrier_ok: false }, 'thiếu rào'],
      [{ ...good, barrier_state: 'O', barrier_ok: false }, "trạng thái 'O'"],
      [{ ...good, barrier_state: 'O', barrier_ok: true }, "trạng thái 'O'"],      // trạng thái quyết định, không tin barrier_ok
      [{ ...good, barrier_state: 'D', barrier_ok: false }, "trạng thái 'D'"],
      [{ ...good, barrier_state: 'R', barrier_ok: false }, "trạng thái 'R'"],
      [{ ...good, barrier_ok: false }, 'khác định nghĩa'],
    ] as const) expect(R.judgeRaceBarrier(row), needle).toContain(needle)
    expect(R.judgeRaceBarrier({ ...good, barrier_state: 'O' })).toContain('KHÔNG hạ / đổi trigger')
    // SQL preflight = điều kiện VERIFY V6: 'A', tgtype 23, định nghĩa chuẩn hoá, thân hàm — hằng số lấy từ CHÍNH file 115.
    const sql: string = R.RACE_PREFLIGHT_BARRIER_SQL
    expect(sql).toContain("g.tgenabled = 'A'")
    expect(sql).toContain('g.tgtype = 23')
    expect(sql).not.toMatch(/tgenabled\s*(=|IN)\s*\(?\s*'O'/)
    expect(sql).toContain(R.BARRIER_TRIGGER_DEF.split("'").join("''"))
    expect(sql).toContain(`= '${R.BARRIER_FN_MD5}'`)
    const mig = read('../supabase/migrations/115_care_import_cancel.sql')
    expect(mig).toContain('ALTER TABLE public.care_import_batches ENABLE ALWAYS TRIGGER care_import_batches_require_provenance;')
    const body = mig.match(/CREATE OR REPLACE FUNCTION public\.care__require_commit_provenance\(\)[^$]*? AS \$\$([\s\S]*?)\$\$;/)
    expect(body).not.toBeNull()
    expect(createHash('md5').update(body![1]).digest('hex')).toBe(R.BARRIER_FN_MD5)
    // CLI: preflight dùng chung lõi, chạy TRƯỚC marker / ghi; không tự viết điều kiện trigger, không bao giờ đổi trigger.
    const cli = read('scripts/qa-race-115.mjs'), lib = read('scripts/lib-race-115.mjs')
    expect(cli).toContain("mustRead(RACE_PREFLIGHT_BARRIER_SQL, 'preflight rào')")
    expect(cli).toMatch(/const notReady = judgeRaceBarrier\(barrier\)\n\s*if \(notReady\) throw new Error\(notReady\)\n/)
    expect(cli.indexOf('judgeRaceBarrier(barrier)')).toBeLessThan(cli.indexOf('writeMarker(marker)'))
    expect(cli).not.toMatch(/tgenabled/)
    // db-reviewer r1.2 P2-7: mọi request trước writeMarker chạy trong transaction READ ONLY.
    expect(cli).toContain('const mustRead = (sql, what) => must(`SET TRANSACTION READ ONLY; ${sql}`, what)')
    const preflight = cli.slice(cli.indexOf('// ── Preflight CHỈ ĐỌC'), cli.indexOf('writeMarker(marker)'))
    expect(preflight).not.toMatch(/[^d]must\(|exec\(/)
    expect((preflight.match(/mustRead\(/g) ?? []).length).toBe(4)
    // db-reviewer r1.2 P2-6: không đổi trigger / hàm / vai trò / chế độ replica dưới bất kỳ dạng nào.
    for (const src of [cli, lib].map(stripComments)) {
      expect(src).not.toMatch(/ALTER\s+(TABLE|FUNCTION|TRIGGER)|(ENABLE|DISABLE)\s+(ALWAYS\s+|REPLICA\s+)?TRIGGER|DROP\s+(TRIGGER|FUNCTION)|CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i)
      expect(src).not.toMatch(/session_replication_role|SET\s+(LOCAL\s+|SESSION\s+)?ROLE\b|TRUNCATE/i)
    }
    // db-reviewer r1.2 P2-4: B chỉ gửi khi DB đã thấy A ở pg_sleep (không đoán theo độ trễ mạng); hỏi B chờ 'Lock' tới trước lúc A nhả.
    const pair = lib.slice(lib.indexOf('async function pair('), lib.indexOf('const cancelSql'))
    expect(pair).toContain("watch(s.tag, 'A', (r) => r.wait_event === 'PgSleep'")
    expect(pair.indexOf("watch(s.tag, 'A'")).toBeLessThan(pair.indexOf('/* qa-r115:${runId}:${s.tag}:B */'))
    expect(pair).toContain("watch(s.tag, 'B', (r) => r.wait_event_type === 'Lock', tSeen + hold * 1000 - 500")
    expect(R.RACE_HOLD_S).toBeLessThanOrEqual(R.CANCEL_LOCK_TIMEOUT_S - 1)
  })

  test('flags: isCareImportCancelEnabled đòi cả CARE_ENABLED; server-only', () => {
    const src = read('lib/care/flags.ts')
    expect(src).toMatch(/^import 'server-only'/)
    expect(src).toMatch(/export function isCareImportCancelEnabled\(\): boolean \{\n\s+return isCareEnabled\(\) && careImportCancelEnabledFromEnv\(process\.env\)/)
  })

  test('trang /care/assign: chỉ truy vấn cột 115 khi cờ ON; batch mới nhất theo commit_seq, đúng phạm vi; truyền đúng 2 action', () => {
    const src = stripComments(read('app/(dashboard)/care/assign/page.tsx'))
    expect(src).toContain('const cancelOn = isCareImportCancelEnabled()')
    const i = src.indexOf('if (cancelOn) {')
    expect(i).toBeGreaterThan(0)
    expect(src.indexOf("not('provenance_version', 'is', null)")).toBeGreaterThan(i)
    expect(src.indexOf("order('commit_seq', { ascending: false, nullsFirst: false })")).toBeGreaterThan(i)
    expect(src.slice(0, i)).not.toMatch(/commit_seq|provenance_version/)
    // Lịch sử: cột 115 (người huỷ / lúc huỷ) chỉ khi cờ ON; embed người huỷ ghi FK (batch có 2 FK tới users — AGENTS §4.4).
    expect(src).toContain(".select(cancelOn ? `${HISTORY_COLS}, cancelled_at, canceller:users!care_import_batches_cancelled_by_fkey(full_name)` : HISTORY_COLS, { count: 'exact' })")
    expect(src.match(/HISTORY_COLS = '([^']+)'/)?.[1]).not.toMatch(/cancel|commit_seq|provenance/)
    expect(src).not.toMatch(/[^!]users\(full_name\)/)
    expect(src).toMatch(/latestQ = scope\.kind === 'qa' \? latestQ\.eq\('id', scope\.batchId\)\.eq\('is_test', true\) : latestQ\.eq\('is_test', false\)/)
    expect(src).toContain("cancelSlot = { batchId: latest.id, preview: previewCareImportCancel, cancel: cancelCareImport }")
    expect(src).toContain('<CareImportHistory rows={rows} cancel={cancelSlot} />')
  })

  test('UI: trạng thái "Đã huỷ"; nút chỉ ở dòng server chỉ định; hộp thoại 2 bước gửi commitSeq của chính preview; chống gửi đôi', () => {
    const h = read('components/care/CareImportHistory.tsx')
    expect(h).toContain("cancelled: { tone: 'neutral', label: 'Đã huỷ' }")
    // PM D1 r1 P1-2: trạng thái lạ không làm vỡ trang (DB mới hơn app).
    expect(h).toContain("const st = STATUS[r.status] ?? { tone: 'neutral' as const, label: 'Không xác định' }")
    expect(h).toMatch(/\{cancel\.batchId === r\.id \? <CareImportCancelButton/)
    const d = stripComments(read('components/care/CareImportCancelDialog.tsx'))
    expect(d).toContain('cancel({ batchId, expectedCommitSeq: step.preview.commitSeq })')
    expect(d).toMatch(/if \(step\.kind !== 'confirm' \|\| sending\.current\) return/)
    expect(d).toContain('{CARE_CANCEL_WARNING}')
    expect(d).not.toMatch(/Number\(|parseInt/)
    // Nút chạm ≥ 44px mobile.
    for (const m of d.matchAll(/<Button[^>]*>/g)) expect(m[0], m[0]).toContain('min-h-[44px]')
    expect(read('components/care/CareImportCancelButton.tsx')).toContain('min-h-[44px]')
  })

  test('Q-161: file_name do SERVER sinh (template kỹ thuật) — không lấy tên file upload; repo chỉ ghi giá trị đó', () => {
    const h = read('lib/care/import/handler.ts')
    expect(h).toContain('const fileName = `care-import-${period.slice(0, 7)}-${sha.slice(0, 12)}.csv`')
    expect(h).toMatch(/period, fileName, sha256: sha,/)
    const hc = stripComments(h)
    // fileName gán ĐÚNG MỘT lần, từ template; file.name chỉ dùng để kiểm đuôi .csv (không lưu).
    expect([...hc.matchAll(/\bfileName\s*=/g)].length).toBe(1)
    expect([...hc.matchAll(/file\.name/g)].length).toBe(1)
    expect(hc).toContain("if (!/\\.csv$/i.test(file.name) || !CSV_MIME.has(file.type.toLowerCase()))")
    expect(hc).not.toMatch(/\.name\s*\?\?|upload\w*\.name|originalName|file_name\s*:/)
    const repo = read('lib/care/server/importRepo.ts')
    expect(repo).toContain('file_name: fileName')
    // Mọi chỗ ghi cột file_name của care_import_batches (file nhắc bảng này) trong mã app/script đều thuộc danh sách đã duyệt.
    // (Tasks/KPI/FS có cột file_name của bảng riêng — ngoài phạm vi CRM.)
    const writers: string[] = []
    for (const dir of ['app', 'lib', 'scripts', 'components']) {
      const walk = (d: string) => {
        for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
          const p = path.join(d, e.name)
          if (e.isDirectory()) walk(p)
          else if (/\.(ts|tsx|mjs)$/.test(e.name) && /file_name\s*:/.test(read(p)) && read(p).includes('care_import_batches')) writers.push(p.replace(/\\/g, '/'))
        }
      }
      walk(dir)
    }
    expect(writers.sort()).toEqual(['lib/care/server/importRepo.ts', 'scripts/care-qa-fixture.mjs'])
    expect(read('scripts/care-qa-fixture.mjs')).toMatch(/export const FIXTURE_FILE_NAME = 'qa-b6-fixture\.xlsx'/)
  })
})
