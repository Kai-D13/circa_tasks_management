import { createSign } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { normalizeRow, type TargetRow } from '@/lib/targets/parse'
import { upsertTargetRows } from '@/lib/targets/ingest'

// GET /api/cron/pull-targets — pulls weekly KPI rows from BigQuery
// (buymed_n8n.fact_kpi_circa_weekly) and upserts store_weekly_targets.
// Scheduled 3x/day like the other /api/cron/* routes.
// (This replaced the abandoned Power BI service-principal pull on 2026-06-13.)
//
// Required env:
//   BQ_SERVICE_ACCOUNT_KEY — full service-account JSON (one line, \n in key)
//                            needs BigQuery Data Viewer on the dataset and
//                            BigQuery Job User on the project
//   BQ_QUERY (optional)    — override of DEFAULT_QUERY below
//
// Column mapping (BQ → store_weekly_targets):
//   monday_of_week → week_start        pos_code → stores.code (exact match)
//   gmv → actual                       target → target
//   weekly_target → min_weekly_target  kpi_pct → run_rate (fraction, vs MIN)
//   status / remaining_target          → derived vs MIN target in normalizeRow
//
// All upstream fetches carry timeouts — a hung Google endpoint must never
// hold this handler open (the lag-investigation lesson).

const DEFAULT_QUERY = `
  SELECT monday_of_week, pos_code, gmv, target, weekly_target, kpi_pct
  FROM \`lakehouse-prod-394907.buymed_n8n.fact_kpi_circa_weekly\`
  WHERE pos_code NOT IN ("POS0001")
`

interface ServiceAccount {
  client_email: string
  private_key:  string
  project_id:   string
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

// Client-credentials token via signed JWT — no Google SDK dependency.
async function getAccessToken(sa: ServiceAccount): Promise<string> {
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

export async function GET(request: NextRequest) {
  const secret = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const saRaw = process.env.BQ_SERVICE_ACCOUNT_KEY
  if (!saRaw) {
    return NextResponse.json({ error: 'Pull disabled — BQ_SERVICE_ACCOUNT_KEY not set' }, { status: 503 })
  }
  // Accept either raw JSON or base64-encoded JSON. Base64 is the recommended
  // form: the service-account JSON has quotes / \n / + / = that env editors
  // (Coolify) routinely mangle, breaking JSON.parse.
  const trimmed = saRaw.trim()
  let saJson = trimmed
  if (!trimmed.startsWith('{')) {
    try { saJson = Buffer.from(trimmed, 'base64').toString('utf8') } catch { /* fall through */ }
  }
  let sa: ServiceAccount
  try {
    sa = JSON.parse(saJson) as ServiceAccount
    if (!sa.client_email || !sa.private_key || !sa.project_id) throw new Error('missing fields')
  } catch {
    return NextResponse.json(
      { error: 'BQ_SERVICE_ACCOUNT_KEY is not valid service-account JSON/base64 (cần client_email/private_key/project_id)' },
      { status: 503 },
    )
  }

  try {
    const token = await getAccessToken(sa)

    const queryRes = await fetch(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${sa.project_id}/queries`,
      {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          query:        process.env.BQ_QUERY || DEFAULT_QUERY,
          useLegacySql: false,
          timeoutMs:    30_000,
          maxResults:   1000,
        }),
        signal: AbortSignal.timeout(45_000),
      },
    )
    if (!queryRes.ok) {
      const detail = await queryRes.text()
      return NextResponse.json(
        { error: `BigQuery query failed (${queryRes.status})`, detail: detail.slice(0, 800) },
        { status: 502 },
      )
    }
    const data = (await queryRes.json()) as {
      jobComplete?: boolean
      schema?: { fields?: { name: string }[] }
      rows?: { f: { v: unknown }[] }[]
    }
    if (!data.jobComplete) {
      return NextResponse.json({ error: 'BigQuery job did not complete within 30s' }, { status: 504 })
    }
    const fields = (data.schema?.fields ?? []).map((f) => f.name)
    const rawRows = (data.rows ?? []).map((r) =>
      Object.fromEntries(fields.map((name, i) => [name, r.f[i]?.v ?? null]))
    )
    if (rawRows.length === 0) {
      return NextResponse.json({ error: 'Query returned 0 rows' }, { status: 422 })
    }

    const rows: TargetRow[] = []
    const rowErrors: string[] = []
    for (const raw of rawRows) {
      // kpi_pct is a fraction vs the MIN target; the normalizer's scale check
      // converts it to percent.
      const r = normalizeRow(raw, { runRateIsFraction: true })
      if ('error' in r) rowErrors.push(r.error)
      else rows.push(r)
    }
    if (rows.length === 0) {
      return NextResponse.json({ error: 'No valid rows after normalize', rowErrors }, { status: 422 })
    }

    const { upserted, unmatched, duplicates } = await upsertTargetRows(rows, 'api', null)
    return NextResponse.json({ ok: true, pulled: rawRows.length, upserted, unmatched, duplicates, rowErrors })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
