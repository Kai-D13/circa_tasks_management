import { NextRequest, NextResponse } from 'next/server'
import { normalizeRow, type TargetRow } from '@/lib/targets/parse'
import { upsertTargetRows } from '@/lib/targets/ingest'

// DEPRECATED (2026-06-12): the Power BI service-principal path was abandoned
// (BI owner cannot support the tenant-level permission grant). Kept inert —
// it answers 503 unless the PBI_* envs are set, and they must NOT be set.
// The replacement source will be BigQuery (stakeholder builds the query;
// a future cron route will reuse lib/targets/ingest the same way).
//
// GET /api/cron/pull-targets — pulls the BI report data straight from the
// Power BI REST API (service principal + executeQueries) and upserts
// store_weekly_targets. Scheduled 3x/day like the other /api/cron/* routes.
//
// Required env (all five, else 503 with the missing names):
//   PBI_TENANT_ID     — Entra Directory (tenant) ID
//   PBI_CLIENT_ID     — App registration (client) ID
//   PBI_CLIENT_SECRET — App client secret
//   PBI_WORKSPACE_ID  — workspace (group) GUID from the dataset URL
//   PBI_DATASET_ID    — dataset GUID from the dataset URL
//   PBI_DAX_QUERY     — single-line DAX (EVALUATE ...) returning the 8 columns
//
// All upstream fetches carry timeouts — a hung Microsoft endpoint must never
// hold this handler open (the lag-investigation lesson).
export async function GET(request: NextRequest) {
  const secret = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const env = {
    PBI_TENANT_ID:     process.env.PBI_TENANT_ID,
    PBI_CLIENT_ID:     process.env.PBI_CLIENT_ID,
    PBI_CLIENT_SECRET: process.env.PBI_CLIENT_SECRET,
    PBI_WORKSPACE_ID:  process.env.PBI_WORKSPACE_ID,
    PBI_DATASET_ID:    process.env.PBI_DATASET_ID,
    PBI_DAX_QUERY:     process.env.PBI_DAX_QUERY,
  }
  const missing = Object.entries(env).filter(([, v]) => !v).map(([k]) => k)
  if (missing.length) {
    return NextResponse.json({ error: `Pull disabled — missing env: ${missing.join(', ')}` }, { status: 503 })
  }

  try {
    // 1) App-only token (client credentials).
    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${env.PBI_TENANT_ID}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type:    'client_credentials',
          client_id:     env.PBI_CLIENT_ID!,
          client_secret: env.PBI_CLIENT_SECRET!,
          scope:         'https://analysis.windows.net/powerbi/api/.default',
        }),
        signal: AbortSignal.timeout(15_000),
      },
    )
    if (!tokenRes.ok) {
      const detail = await tokenRes.text()
      return NextResponse.json(
        { error: `AAD token failed (${tokenRes.status})`, detail: detail.slice(0, 500) },
        { status: 502 },
      )
    }
    const { access_token } = (await tokenRes.json()) as { access_token: string }

    // 2) Run the DAX query against the dataset.
    const queryRes = await fetch(
      `https://api.powerbi.com/v1.0/myorg/groups/${env.PBI_WORKSPACE_ID}/datasets/${env.PBI_DATASET_ID}/executeQueries`,
      {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${access_token}`,
        },
        body: JSON.stringify({
          queries:            [{ query: env.PBI_DAX_QUERY }],
          serializerSettings: { includeNulls: true },
        }),
        signal: AbortSignal.timeout(60_000),
      },
    )
    if (!queryRes.ok) {
      const detail = await queryRes.text()
      return NextResponse.json(
        { error: `executeQueries failed (${queryRes.status})`, detail: detail.slice(0, 800) },
        { status: 502 },
      )
    }
    const data = (await queryRes.json()) as {
      results?: { tables?: { rows?: Record<string, unknown>[] }[] }[]
    }
    const rawRows = data.results?.[0]?.tables?.[0]?.rows ?? []
    if (rawRows.length === 0) {
      return NextResponse.json({ error: 'Query returned 0 rows — check PBI_DAX_QUERY' }, { status: 422 })
    }

    // 3) DAX keys come as 'Table[column]' / '[Measure]' — strip to the bare
    //    name so the shared normalizer's header aliases match.
    const rows: TargetRow[] = []
    const rowErrors: string[] = []
    for (const raw of rawRows) {
      const cleaned: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(raw)) {
        const m = k.match(/\[([^\]]+)\]$/)
        cleaned[m ? m[1] : k] = v
      }
      const r = normalizeRow(cleaned, { runRateIsFraction: false }) // scale auto-detected
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
