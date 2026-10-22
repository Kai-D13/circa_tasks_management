// CRM-CSKH E3 — cursor keyset ký HMAC (thiết kế E0 r3.4 §7): gắn user + ngữ cảnh (task / bộ lọc), chỉ đi qua server action
// POST, không vào URL. Sai chữ ký / khác người / khác ngữ cảnh ⇒ null (caller trả trang đầu hoặc lỗi), không đoán.
import { createHmac, timingSafeEqual } from 'node:crypto'

export interface CareCursorPayload { u: string; c: string; a: string; b: string }

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
const mac = (key: string, body: string) => createHmac('sha256', key).update(`care-order-cursor/v1.${body}`).digest('base64url')

export function signCareCursor(key: string, p: CareCursorPayload): string {
  if (!key) throw new Error('care_cursor_key_missing')
  const body = b64(JSON.stringify([p.u, p.c, p.a, p.b]))
  return `${body}.${mac(key, body)}`
}

export function verifyCareCursor(key: string, token: unknown, expect: { u: string; c: string }): { a: string; b: string } | null {
  if (!key || typeof token !== 'string' || token.length > 2_000) return null
  const [body, sig, extra] = token.split('.')
  if (!body || !sig || extra !== undefined) return null
  const want = Buffer.from(mac(key, body))
  const got = Buffer.from(sig)
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null
  let arr: unknown
  try { arr = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch { return null }
  if (!Array.isArray(arr) || arr.length !== 4 || !arr.every((x) => typeof x === 'string')) return null
  const [u, c, a, b] = arr as string[]
  return u === expect.u && c === expect.c ? { a, b } : null
}
