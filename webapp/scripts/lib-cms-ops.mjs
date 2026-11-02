// CMS P1-R1 / P1-R2 — hạ tầng chung của 3 script operator (cms-qa-access / cms-qa-run / cms-verify). Không chứa SQL:
// mọi câu lệnh lấy từ e2e/cmsQaTooling.ts (mẫu cố định, đã test) — file này chỉ nạp env, nạp TS qua jiti và gửi
// đúng chuỗi được dựng sẵn tới pg-meta. Không in key / URL đầy đủ / lỗi thô có dữ liệu.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '..')
export const ENV_FILE = path.join(ROOT, '.env.local')

export function parseArgs(argv, { flags = [], values = [] } = {}) {
  const [cmd, ...rest] = argv
  const out = { cmd, flags: new Set(), values: {}, bad: [] }
  for (const a of rest) {
    const eq = a.indexOf('=')
    const key = eq < 0 ? a : a.slice(0, eq)
    if (eq < 0 && flags.includes(key)) out.flags.add(key)
    else if (eq > 0 && values.includes(key)) out.values[key] = a.slice(eq + 1)
    else out.bad.push(key)
  }
  return out
}

export function readEnvFileText() {
  return fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : null
}

/** process env > webapp/.env.local (không ghi đè biến đã có ở process). */
export function mergedEnv(envFileText) {
  const env = { ...process.env }
  if (envFileText) {
    for (const line of envFileText.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
      if (m && env[m[1]] === undefined) env[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
    }
  }
  delete env.SUPABASE_INTERNAL_URL // URL nội bộ docker không dùng được trên máy operator
  return env
}

/** `host[:port]` của NEXT_PUBLIC_SUPABASE_URL; null nếu thiếu / sai. */
export function supabaseHost(env) {
  try { return new URL(env.NEXT_PUBLIC_SUPABASE_URL).host || null } catch { return null }
}

export async function loadTooling() {
  let createJiti
  try { ({ createJiti } = await import('jiti')) } catch {
    console.log('LỖI: thiếu gói jiti — chạy `npm ci` trong webapp/ rồi thử lại')
    process.exit(2)
  }
  const jiti = createJiti(import.meta.url, { interopDefault: true })
  const T = await jiti.import(path.join(ROOT, 'e2e', 'cmsQaTooling.ts'))
  const G = await jiti.import(path.join(ROOT, 'e2e', 'writeQaGates.ts'))
  return { T, G }
}

/**
 * Gửi MỘT chuỗi lệnh đã dựng sẵn tới pg-meta (service role). Trả mảng dòng của câu SELECT / RETURNING cuối; lỗi DB ⇒
 * throw với mã + thông điệp rút gọn (không kèm key / body request).
 */
export async function pgMeta(env, query) {
  const base = String(env.NEXT_PUBLIC_SUPABASE_URL).replace(/\/$/, '')
  const r = await fetch(`${base}/pg/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(60_000),
  })
  let j
  try { j = await r.json() } catch { throw new Error(`pg-meta HTTP ${r.status}: phản hồi không phải JSON`) }
  if (!r.ok || !Array.isArray(j)) {
    const code = j && typeof j === 'object' ? (j.code ?? '') : ''
    const msg = j && typeof j === 'object' ? String(j.message ?? j.error ?? '').slice(0, 200) : ''
    throw new Error(`pg-meta HTTP ${r.status} ${code} ${msg}`.trim())
  }
  return j
}

/** Thoát với mã 2 (sai tham số / cấu hình) — trước mọi IO tới DB. */
export function die2(msg) {
  console.log(`LỖI: ${msg}`)
  process.exit(2)
}
