import fs from 'node:fs'
import path from 'node:path'

// CRM-CSKH B0 (SPEC B0 mục 6, audit r1.3 P1): nạp credential QA ngay TRONG
// tiến trình Playwright, chạy được y hệt trên PowerShell / Git Bash / CI.
//
// Vì sao không dùng recipe `set -a; . ./.env.local; set +a`:
//   · đó là cú pháp Bash — PowerShell (shell mặc định của repo) không chạy được;
//   · shell-source diễn giải giá trị: `$x` bị expand, `#` thành comment, khoảng
//     trắng/ngoặc làm vỡ dòng ⇒ mật khẩu có ký tự đặc biệt bị biến dạng im lặng
//     và lỗi đăng nhập trông như sai credential.
//
// Quy tắc parser (THUẦN, không IO — test được): `KEY=VALUE` mỗi dòng, bỏ dòng
// trống/`#`, cho phép tiền tố `export `, bỏ đúng MỘT cặp nháy bao ngoài ('…' hoặc
// "…"), KHÔNG expand biến, KHÔNG cắt `#` giữa giá trị, giữ `=` trong giá trị.
//
// Thứ tự ưu tiên: biến PROCESS (đặt tạm cho một lần chạy) > .env.local.
// Module này KHÔNG ghi process.env và KHÔNG log giá trị; nơi gọi chỉ được in
// TÊN biến (vd lý do skip), không bao giờ in value.

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = rawLine.trimStart()
    if (line === '' || line.startsWith('#')) continue
    const body = line.startsWith('export ') ? line.slice(7).trimStart() : line
    const eq = body.indexOf('=')
    if (eq <= 0) continue
    const key = body.slice(0, eq).trim()
    if (!KEY_RE.test(key)) continue
    let value = body.slice(eq + 1)
    const q = value.trimEnd()
    if (q.length >= 2 && (q[0] === '"' || q[0] === "'") && q[q.length - 1] === q[0]) {
      value = q.slice(1, -1)
    } else {
      value = value.trimEnd()
    }
    out[key] = value
  }
  return out
}

/** Đường dẫn .env.local của webapp (Playwright chạy với cwd = webapp/). */
export const ENV_LOCAL_PATH = path.resolve(__dirname, '..', '.env.local')

let cached: Record<string, string> | null | undefined

/** Nội dung .env.local đã parse; null nếu không có file. Đọc một lần mỗi worker. */
export function envLocal(): Record<string, string> | null {
  if (cached === undefined) {
    cached = fs.existsSync(ENV_LOCAL_PATH) ? parseEnvText(fs.readFileSync(ENV_LOCAL_PATH, 'utf8')) : null
  }
  return cached
}

/** Lấy các biến theo thứ tự process.env > .env.local; giá trị rỗng coi như thiếu. */
export function resolveEnv<K extends string>(
  keys: readonly K[],
  sources: { processEnv?: Record<string, string | undefined>; file?: Record<string, string> | null } = {},
): { values: Partial<Record<K, string>>; missing: K[] } {
  const processEnv = sources.processEnv ?? process.env
  const file = sources.file === undefined ? envLocal() : sources.file
  const values: Partial<Record<K, string>> = {}
  const missing: K[] = []
  for (const k of keys) {
    const v = processEnv[k] || file?.[k] || ''
    if (v) values[k] = v
    else missing.push(k)
  }
  return { values, missing }
}
