import 'server-only'
import { createSign } from 'crypto'
import { normalizeRow, type TargetRow } from './parse'

// Shared BigQuery client for the weekly-targets feed (buymed_n8n.fact_kpi_circa_weekly).
// Used by the cron pull route AND the live staff/super-admin reads. No Google SDK —
// a signed JWT gets a read-only access token. All fetches carry timeouts so a hung
// Google endpoint can never hold a handler open (the lag-investigation lesson).
//
// Required env:
//   BQ_SERVICE_ACCOUNT_KEY — service-account JSON (raw or base64). base64 is
//     recommended: the JSON has quotes / \n / + / = that env editors (Coolify)
//     routinely mangle, breaking JSON.parse.
//   BQ_QUERY (optional)            — override of DEFAULT_QUERY.
//   TARGETS_TTL_SECONDS (optional) — live-read cache TTL, default 3600 (1h).

export const DEFAULT_QUERY = `
  SELECT monday_of_week, pos_code, pos_name, gmv, target, weekly_target, kpi_pct
  FROM \`lakehouse-prod-394907.buymed_n8n.fact_kpi_circa_weekly\`
  WHERE pos_code NOT IN ("POS0001")
`

export interface ServiceAccount {
  client_email: string
  private_key:  string
  project_id:   string
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

// Reads + parses the service account from env (raw JSON or base64). Returns null
// when unset or invalid — callers decide whether that's a 503 or a soft empty.
export function loadServiceAccount(): ServiceAccount | null {
  const saRaw = process.env.BQ_SERVICE_ACCOUNT_KEY
  if (!saRaw) return null
  const trimmed = saRaw.trim()
  let saJson = trimmed
  if (!trimmed.startsWith('{')) {
    try { saJson = Buffer.from(trimmed, 'base64').toString('utf8') } catch { /* fall through */ }
  }
  try {
    const sa = JSON.parse(saJson) as ServiceAccount
    if (!sa.client_email || !sa.private_key || !sa.project_id) return null
    return sa
  } catch {
    return null
  }
}

// Client-credentials token via signed JWT.
export async function getAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const unsigned =
    b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' +
    b64url(JSON.stringify({
      iss:   sa.client_email,
      scope: 'https://www.googleapis.com/auth/bigquery.readonly',
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
  const { access_token } = (await res.json()) as { access_token: string }
  return access_token
}

// Runs a query and returns raw rows as { columnName: value } objects.
export async function runBigQuery(sa: ServiceAccount, sql: string): Promise<Record<string, unknown>[]> {
  const token = await getAccessToken(sa)
  const queryRes = await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${sa.project_id}/queries`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ query: sql, useLegacySql: false, timeoutMs: 30_000, maxResults: 1000 }),
      signal: AbortSignal.timeout(45_000),
    },
  )
  if (!queryRes.ok) {
    throw new Error(`BigQuery query failed (${queryRes.status}): ${(await queryRes.text()).slice(0, 300)}`)
  }
  const data = (await queryRes.json()) as {
    jobComplete?: boolean
    schema?: { fields?: { name: string }[] }
    rows?: { f: { v: unknown }[] }[]
  }
  if (!data.jobComplete) throw new Error('BigQuery job did not complete within 30s')
  const fields = (data.schema?.fields ?? []).map((f) => f.name)
  return (data.rows ?? []).map((r) =>
    Object.fromEntries(fields.map((name, i) => [name, r.f[i]?.v ?? null])),
  )
}

// ── Live read with a small in-memory TTL cache ──────────────────────────────
// The app runs as a long-lived Coolify container (not serverless), so a
// module-level cache is shared across requests: one BigQuery hit per TTL serves
// every staff/admin view. TTL default 1h (the stakeholder's cadence) — no cron
// or store_weekly_targets persistence needed for reads.
const TTL_MS = (() => {
  const n = Number(process.env.TARGETS_TTL_SECONDS)
  return Number.isFinite(n) && n > 0 ? n * 1000 : 3600_000
})()

let cache: { rows: TargetRow[]; expires: number } | null = null
let inFlight: Promise<TargetRow[]> | null = null

async function fetchLive(): Promise<TargetRow[]> {
  const sa = loadServiceAccount()
  if (!sa) throw new Error('BQ_SERVICE_ACCOUNT_KEY chưa cấu hình')
  const raw = await runBigQuery(sa, process.env.BQ_QUERY || DEFAULT_QUERY)
  const rows: TargetRow[] = []
  for (const r of raw) {
    const n = normalizeRow(r, { runRateIsFraction: true })
    if (!('error' in n)) rows.push(n)
  }
  return rows
}

// Returns all weekly-target rows from BigQuery (normalized), cached for TTL.
// Throws on a hard failure (no SA / BQ error) — callers render an error state.
export async function getWeeklyTargetsLive(): Promise<TargetRow[]> {
  if (cache && cache.expires > Date.now()) return cache.rows
  // Coalesce concurrent misses so a burst of page loads triggers one BQ call.
  if (inFlight) return inFlight
  inFlight = fetchLive()
    .then((rows) => {
      cache = { rows, expires: Date.now() + TTL_MS }
      return rows
    })
    .finally(() => { inFlight = null })
  return inFlight
}
