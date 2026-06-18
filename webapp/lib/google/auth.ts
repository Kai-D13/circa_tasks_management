import 'server-only'
import { createSign } from 'crypto'

// Shared Google service-account auth — no SDK. A signed JWT (RS256) is exchanged
// for an OAuth2 access token. Reused by BigQuery (lib/targets/bigquery.ts) and
// Google Cloud Storage (lib/storage/gcs.ts). Server-only.

export interface ServiceAccount {
  client_email: string
  private_key:  string
  project_id:   string
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

// Parse a service-account JSON from an env var. Accepts raw JSON or base64 —
// base64 is recommended because the JSON has quotes / \n / + / = that env editors
// (Coolify) routinely mangle, breaking JSON.parse. Returns null when unset/invalid.
export function loadServiceAccount(envVar: string): ServiceAccount | null {
  const raw = process.env[envVar]
  if (!raw) return null
  const trimmed = raw.trim()
  let json = trimmed
  if (!trimmed.startsWith('{')) {
    try { json = Buffer.from(trimmed, 'base64').toString('utf8') } catch { /* fall through */ }
  }
  try {
    const sa = JSON.parse(json) as ServiceAccount
    if (!sa.client_email || !sa.private_key || !sa.project_id) return null
    return sa
  } catch {
    return null
  }
}

// Module-level token cache (long-lived container) keyed by service-account +
// scope, so a burst (e.g. submitting 15-18 images) reuses one token instead of
// minting per file. Cached until ~5 min before expiry.
const tokenCache = new Map<string, { token: string; expiresAt: number }>()

// Client-credentials access token via signed JWT. `scope` is a space-delimited
// list of OAuth scopes (e.g. 'https://www.googleapis.com/auth/devstorage.read_write').
export async function getAccessToken(sa: ServiceAccount, scope: string): Promise<string> {
  const cacheKey = `${sa.client_email}|${scope}`
  const cached = tokenCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.token

  const now = Math.floor(Date.now() / 1000)
  const unsigned =
    b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' +
    b64url(JSON.stringify({
      iss:   sa.client_email,
      scope,
      aud:   'https://oauth2.googleapis.com/token',
      iat:   now,
      exp:   now + 3600,
    }))
  const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key)
  const assertion = `${unsigned}.${b64url(signature)}`

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Google token failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
  const { access_token, expires_in } = (await res.json()) as { access_token: string; expires_in?: number }
  const ttlMs = (typeof expires_in === 'number' ? expires_in : 3600) * 1000
  tokenCache.set(cacheKey, { token: access_token, expiresAt: Date.now() + ttlMs - 5 * 60_000 })
  return access_token
}
