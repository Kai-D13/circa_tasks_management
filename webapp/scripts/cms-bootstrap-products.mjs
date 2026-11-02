#!/usr/bin/env node
// CMS — bootstrap Product Master trước khi bật cờ (docs/cms/SPEC.md §9, IMPLEMENTATION_PLAN §6 bước 6; PM PR-0).
// OPERATOR-ONLY. Dùng CHUNG lõi lib/cms/productSync.ts + deps thật lib/cms/server/productSyncDeps.ts (nạp qua jiti) với
// cron /api/cron/pull-cms-products — không thuật toán thứ hai. KHÔNG bật / sửa cờ runtime, không mở đường public.
//
//   node scripts/cms-bootstrap-products.mjs                       # DRY-RUN (mặc định): đọc nguồn + kiểm chất lượng, KHÔNG ghi DB
//   node scripts/cms-bootstrap-products.mjs --confirm --expect-host=<host Supabase>   # GHI qua RPC service_role
//   node scripts/cms-bootstrap-products.mjs --self-check          # chỉ kiểm nạp module (không mạng, không DB)
//
// Env (process env > webapp/.env.local; CMS_BOOTSTRAP_ENV_FILE=none để không đọc file):
//   CMS_BQ_PRODUCTS_TABLE (bắt buộc), BQ_SERVICE_ACCOUNT_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
//   SUPABASE_INTERNAL_URL bị bỏ qua (URL nội bộ docker không dùng được trên máy operator).
// Thoát: 0 ok / dry-run sạch · 1 held / busy / lỗi / CLOSE_FAILED / dry-run có mã held · 2 sai tham số / thiếu cấu hình.
// In: chế độ, host đích, view nguồn và số đếm — không in tên sản phẩm, URL ảnh, key hay lỗi thô.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const val = (f) => args.find((a) => a.startsWith(`${f}=`))?.slice(f.length + 1)
const known = new Set(['--confirm', '--self-check', '--help'])
const bad = args.filter((a) => !known.has(a) && !a.startsWith('--expect-host='))
if (has('--help') || bad.length) {
  console.log('dùng: node scripts/cms-bootstrap-products.mjs [--confirm --expect-host=<host>] | --self-check')
  process.exit(bad.length ? 2 : 0)
}

// Nạp env từ webapp/.env.local nếu biến chưa có ở process env.
if (process.env.CMS_BOOTSTRAP_ENV_FILE !== 'none') {
  const f = path.join(ROOT, '.env.local')
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
    }
  }
}
delete process.env.SUPABASE_INTERNAL_URL

// jiti khai báo trực tiếp trong devDependencies (PM review P1-a §2.2) — thiếu (vd. cài --omit=dev) ⇒ báo rõ, không chạy.
let createJiti
try { ({ createJiti } = await import('jiti')) } catch {
  console.log('LỖI: thiếu gói jiti (nạp lõi TypeScript) — chạy `npm ci` trong webapp/ rồi thử lại')
  process.exit(2)
}
const jiti = createJiti(import.meta.url, {
  alias: { '@': ROOT, 'server-only': path.join(HERE, 'cms-server-only-stub.mjs') },
  interopDefault: true,
})

if (has('--self-check')) {
  // lib/supabase/admin.ts tạo client lúc import (không kết nối) ⇒ giá trị giữ chỗ nếu chưa có env; không IO.
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://self-check.invalid'
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'self-check'
  const core = await jiti.import(path.join(ROOT, 'lib/cms/productSync.ts'))
  const depsMod = await jiti.import(path.join(ROOT, 'lib/cms/server/productSyncDeps.ts'))
  const okCore = typeof core.runCmsProductSync === 'function' && typeof depsMod.cmsProductSyncDeps === 'function'
  console.log(`self-check: nạp lõi + deps ${okCore ? 'ĐẠT' : 'LỖI'}`)
  process.exit(okCore ? 0 : 1)
}

const confirm = has('--confirm')
let table
try {
  const { cmsBqProductsTable } = await jiti.import(path.join(ROOT, 'lib/cms/config.ts'))
  table = cmsBqProductsTable(process.env)
} catch {
  console.log('LỖI: CMS_BQ_PRODUCTS_TABLE sai định dạng (project.dataset.table)')
  process.exit(2)
}
if (!table) { console.log('LỖI: chưa cấu hình CMS_BQ_PRODUCTS_TABLE — không query'); process.exit(2) }
const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
// So URL.host (gồm port) — hai môi trường cùng hostname khác port / tunnel localhost vẫn phân biệt được.
let host = null, proto = null
try { const u = new URL(sbUrl); host = u.host; proto = u.protocol } catch { /* xử lý dưới */ }
if (!host || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.BQ_SERVICE_ACCOUNT_KEY) {
  console.log('LỖI: thiếu NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / BQ_SERVICE_ACCOUNT_KEY')
  process.exit(2)
}
if (confirm && val('--expect-host') !== host) {
  console.log(`LỖI: --confirm cần --expect-host=${host} khớp đúng host Supabase đích (chống ghi nhầm DB)`)
  process.exit(2)
}

console.log(`CMS bootstrap Product Master · chế độ ${confirm ? 'GHI (--confirm)' : 'DRY-RUN (không ghi)'} · đích ${proto}//${host} · view ${table}`)
const { runCmsProductSync, cmsBootstrapExitCode } = await jiti.import(path.join(ROOT, 'lib/cms/productSync.ts'))
const { cmsProductSyncDeps } = await jiti.import(path.join(ROOT, 'lib/cms/server/productSyncDeps.ts'))
const r = await runCmsProductSync(cmsProductSyncDeps(process.env), { dryRun: !confirm, source: 'bootstrap' })
const out = {
  status: r.status, code: r.code, rowsRead: r.rowsRead, rowsValid: r.rowsValid, rowsRejected: r.rowsRejected,
  rowsWritten: r.rowsWritten, inactive: r.inactive, imageRejected: r.imageRejected, bytesProcessed: r.bytesProcessed, elapsedMs: r.elapsedMs,
  cause: r.cause,
}
console.log(JSON.stringify(out))
process.exit(cmsBootstrapExitCode(r))
