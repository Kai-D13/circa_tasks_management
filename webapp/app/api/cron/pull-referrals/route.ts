import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { loadServiceAccount, getAccessToken } from '@/lib/google/auth'
import { parseReferralRows } from '@/lib/referrals/parse'

// GET /api/cron/pull-referrals — pulls the "Giới thiệu bạn bè" feed from a Google
// Sheet (BI auto-extracts BigQuery → Sheet) and REPLACES staff_referrals, same as
// the manual JSON upload (app/actions/referrals.ts). Reuses the BigQuery service
// account (BQ_SERVICE_ACCOUNT_KEY) with the Sheets read-only scope.
//
// Setup (manual): share the Sheet with the SA email as Viewer, enable the Google
// Sheets API on the project, set REFERRAL_SHEET_ID, and add a Coolify Scheduled
// Task hitting this route with `Authorization: Bearer $CRON_SECRET`.

const SHEETS_SCOPE  = 'https://www.googleapis.com/auth/spreadsheets.readonly'
const SHEET_ID      = process.env.REFERRAL_SHEET_ID    || '1rpaudp3nFcL2JPSDcU9cZqqT-O77fLon_-XCpDb9HwI'
const SHEET_RANGE   = process.env.REFERRAL_SHEET_RANGE || 'Sheet1'

// Read a sheet's values and key each data row by the header row (row 0).
async function readSheetRows(): Promise<Record<string, unknown>[]> {
  const sa = loadServiceAccount('BQ_SERVICE_ACCOUNT_KEY')
  if (!sa) throw new Error('Google token: BQ_SERVICE_ACCOUNT_KEY chưa hợp lệ')
  const token = await getAccessToken(sa, SHEETS_SCOPE)
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SHEET_ID)}` +
    `/values/${encodeURIComponent(SHEET_RANGE)}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(45_000),
  })
  if (!res.ok) {
    throw new Error(`Sheets read failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
  }
  const data = (await res.json()) as { values?: unknown[][] }
  const values = data.values ?? []
  if (values.length < 2) return [] // header only / empty sheet
  const headers = values[0].map((h) => String(h ?? ''))
  return values.slice(1).map((row) => {
    const obj: Record<string, unknown> = {}
    headers.forEach((h, i) => { obj[h] = row[i] ?? null })
    return obj
  })
}

export async function GET(request: NextRequest) {
  const secret = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const rawRows = await readSheetRows()
    const parsed = parseReferralRows(rawRows)
    if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 422 })
    const rows = parsed.rows

    // Atomic replace via RPC (delete-all + insert in one transaction). No user in
    // the cron context → uploaded_by = null (column is nullable).
    const { data: inserted, error: rpcErr } = await supabaseAdmin.rpc('replace_staff_referrals', {
      p_rows: rows,
      p_uploaded_by: null,
    })
    if (rpcErr) return NextResponse.json({ error: `Ghi dữ liệu lỗi: ${rpcErr.message}` }, { status: 500 })

    revalidatePath('/gioi-thieu')
    revalidatePath('/targets')
    const staffCount = new Set(rows.map((r) => r.phone_number)).size
    return NextResponse.json({
      ok: true,
      pulled: rawRows.length,
      inserted: (inserted as number | null) ?? rows.length,
      staffCount,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Sheets/token errors → 502 (upstream Google); everything else → 500.
    const status = msg.includes('Sheets') || msg.includes('Google token') ? 502 : 500
    return NextResponse.json({ error: msg }, { status })
  }
}
