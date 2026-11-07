#!/usr/bin/env node
// CMS P2-b — đồng bộ bán + tính MỘT chương trình theo lệnh operator (kế hoạch PM 02/11 §5, §7; SPEC §9). OPERATOR-ONLY.
// Dùng CHUNG lõi lib/cms/salesSync.ts + deps thật lib/cms/server/salesSyncDeps.ts (nạp qua jiti) với cron
// /api/cron/sync-cms-sales — không thuật toán thứ hai. KHÔNG bật / sửa cờ runtime, không mở đường public.
//
//   node scripts/cms-sales-sync.mjs --program=<uuid>                                  # DRY-RUN (mặc định): snapshot chỉ đọc +
//                                                                                     # đọc nguồn + engine, KHÔNG ghi DB
//   node scripts/cms-sales-sync.mjs --program=<uuid> --confirm --expect-host=<host>   # GHI: open → stage → seal → publish
//   node scripts/cms-sales-sync.mjs --self-check                                      # chỉ kiểm nạp module (không mạng / DB)
//
// Cổng kết quả theo hằng lib/cms/releaseGate.ts (SALES_ONLY_V1 từ 126: chương trình thật được công bố CMS tạm tính; dòng âm /
// điều chỉnh ⇒ held RETURNS_NOT_SUPPORTED_THIS_PHASE) — script không có tham số vượt / đổi cổng.
// Env (process env > webapp/.env.local; CMS_SALES_ENV_FILE=none để không đọc file):
//   CMS_BQ_SALES_TABLE (bắt buộc), BQ_SERVICE_ACCOUNT_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Thoát: 0 published / dry-run sạch · 1 held / busy / skipped / lỗi / CLOSE_FAILED · 2 sai tham số / thiếu cấu hình.
// Thoát bằng process.exitCode (KHÔNG process.exit sau fetch — Node 24 / Windows libuv abort rc 127, batch CLI exit r3).
// In: chế độ, host đích, view nguồn, số đếm, mã và hash kết quả — không email, giá trị dòng, key hay lỗi thô.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

async function main(args) {
  const has = (f) => args.includes(f)
  const val = (f) => args.find((a) => a.startsWith(`${f}=`))?.slice(f.length + 1)
  const known = new Set(['--confirm', '--self-check', '--help'])
  const bad = args.filter((a) => !known.has(a) && !a.startsWith('--expect-host=') && !a.startsWith('--program='))
  if (has('--help') || bad.length) {
    console.log('dùng: node scripts/cms-sales-sync.mjs --program=<uuid> [--confirm --expect-host=<host>] | --self-check')
    return bad.length ? 2 : 0
  }

  if (process.env.CMS_SALES_ENV_FILE !== 'none') {
    const f = path.join(ROOT, '.env.local')
    if (fs.existsSync(f)) {
      for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
        if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
      }
    }
  }
  delete process.env.SUPABASE_INTERNAL_URL

  let createJiti
  try { ({ createJiti } = await import('jiti')) } catch {
    console.log('LỖI: thiếu gói jiti (nạp lõi TypeScript) — chạy `npm ci` trong webapp/ rồi thử lại')
    return 2
  }
  const jiti = createJiti(import.meta.url, {
    alias: { '@': ROOT, 'server-only': path.join(HERE, 'cms-server-only-stub.mjs') },
    interopDefault: true,
  })

  if (has('--self-check')) {
    process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://self-check.invalid'
    process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'self-check'
    const core = await jiti.import(path.join(ROOT, 'lib/cms/salesSync.ts'))
    const depsMod = await jiti.import(path.join(ROOT, 'lib/cms/server/salesSyncDeps.ts'))
    const okCore = typeof core.runCmsSalesSync === 'function' && typeof depsMod.cmsSalesSyncDeps === 'function'
    console.log(`self-check: nạp lõi + deps ${okCore ? 'ĐẠT' : 'LỖI'}`)
    return okCore ? 0 : 1
  }

  const programId = val('--program')
  if (!programId || !UUID_RE.test(programId)) { console.log('LỖI: cần --program=<uuid chương trình>'); return 2 }
  const confirm = has('--confirm')
  let table
  try {
    const { cmsBqSalesTable } = await jiti.import(path.join(ROOT, 'lib/cms/config.ts'))
    table = cmsBqSalesTable(process.env)
  } catch {
    console.log('LỖI: CMS_BQ_SALES_TABLE sai định dạng (project.dataset.table)')
    return 2
  }
  if (!table) { console.log('LỖI: chưa cấu hình CMS_BQ_SALES_TABLE — không query'); return 2 }
  let host = null, proto = null
  try { const u = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL); host = u.host; proto = u.protocol } catch { /* dưới */ }
  if (!host || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.BQ_SERVICE_ACCOUNT_KEY) {
    console.log('LỖI: thiếu NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / BQ_SERVICE_ACCOUNT_KEY')
    return 2
  }
  if (confirm && val('--expect-host') !== host) {
    console.log(`LỖI: --confirm cần --expect-host=${host} khớp đúng host Supabase đích (chống ghi nhầm DB)`)
    return 2
  }

  console.log(`CMS đồng bộ bán · chế độ ${confirm ? 'GHI (--confirm)' : 'DRY-RUN (không ghi)'} · đích ${proto}//${host} · view ${table} · chương trình ${programId}`)
  const { runCmsSalesSync, cmsSalesExitCode } = await jiti.import(path.join(ROOT, 'lib/cms/salesSync.ts'))
  const { cmsSalesSyncDeps } = await jiti.import(path.join(ROOT, 'lib/cms/server/salesSyncDeps.ts'))
  // Capture lớp nguồn (124) theo cờ CMS_SOURCE_CAPTURE_ENABLED (lib/cms/flags.ts) — lõi vẫn đòi run_open trả source_schema = 1.
  const { cmsSourceCaptureFromEnv } = await jiti.import(path.join(ROOT, 'lib/cms/flags.ts'))
  const r = await runCmsSalesSync(cmsSalesSyncDeps(process.env), programId, { dryRun: !confirm, source: 'operator', sourceCapture: cmsSourceCaptureFromEnv(process.env) })
  console.log(JSON.stringify({
    status: r.status, code: r.code, reasons: r.reasons, runId: r.runId, isTest: r.isTest, rowsRead: r.rowsRead,
    rowsRejected: r.rowsRejected, candidates: r.candidates, included: r.included, unassigned: r.unassigned,
    outOfScope: r.outOfScope, amountVnd: r.amountVnd, stagedRows: r.stagedRows, sourceRows: r.sourceRows, bytesProcessed: r.bytesProcessed,
    resultHash: r.resultHash, elapsedMs: r.elapsedMs, cause: r.cause, cleanup: r.cleanup,
  }))
  return cmsSalesExitCode(r)
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code }, () => {
  console.log('LỖI: lỗi ngoài dự kiến (không in chi tiết thô)')
  process.exitCode = 1
})
