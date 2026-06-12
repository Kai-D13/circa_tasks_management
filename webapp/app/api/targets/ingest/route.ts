import { NextRequest, NextResponse } from 'next/server'
import { normalizeRow, type TargetRow } from '@/lib/targets/parse'
import { upsertTargetRows } from '@/lib/targets/ingest'

// POST /api/targets/ingest — automated feed from the BI side (Power Automate
// flow or any script the report owner controls). Exempted from the auth proxy
// like /api/cron/*; protected by a shared secret instead.
//
//   curl -X POST https://duocsi.circa.vn/api/targets/ingest \
//     -H "Authorization: Bearer $TARGETS_INGEST_SECRET" \
//     -H "Content-Type: application/json" \
//     -d '{"rows":[{"pos_name":"CIRCA THỐNG NHẤT","week":"2026-06-08",
//          "target":51022050,"min_weekly_target":46000000,"actual":38260620,
//          "run_rate":74.99,"status":"Not Achieved","remaining_target":7739380}]}'
//
// week: 'YYYY-MM-DD' or 'MM/DD/YYYY'; run_rate: PERCENT (74.99, not 0.7499).
// Response: { ok, upserted, unmatched: [pos_name...], rowErrors: [...] }
export async function POST(request: NextRequest) {
  const secret = process.env.TARGETS_INGEST_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'Ingest disabled (TARGETS_INGEST_SECRET not set)' }, { status: 503 })
  }
  const auth = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!auth || auth !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 })
  }
  const rawRows = (body as { rows?: unknown })?.rows
  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    return NextResponse.json({ error: 'Body must be { rows: [...] } with at least one row' }, { status: 400 })
  }
  if (rawRows.length > 1000) {
    return NextResponse.json({ error: 'Too many rows (max 1000)' }, { status: 400 })
  }

  const rows: TargetRow[] = []
  const rowErrors: string[] = []
  for (const raw of rawRows) {
    if (typeof raw !== 'object' || raw === null) { rowErrors.push('Dòng không phải object'); continue }
    const r = normalizeRow(raw as Record<string, unknown>, { runRateIsFraction: false })
    if ('error' in r) rowErrors.push(r.error)
    else rows.push(r)
  }
  if (rows.length === 0) {
    return NextResponse.json({ error: 'No valid rows', rowErrors }, { status: 422 })
  }

  try {
    const { upserted, unmatched } = await upsertTargetRows(rows, 'api', null)
    return NextResponse.json({ ok: true, upserted, unmatched, rowErrors })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
