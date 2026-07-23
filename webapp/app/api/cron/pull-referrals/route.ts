import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { loadServiceAccount, getAccessToken } from '@/lib/google/auth'
import { isReferralEnabled } from '@/lib/affiliate/flags'
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
  // Program has ended — the flag gates every entry point (stakeholder audit
  // P1), so even a still-scheduled Coolify task becomes a no-op.
  if (!isReferralEnabled()) {
    return NextResponse.json({ error: 'Referral disabled (REFERRAL_ENABLED=false)' }, { status: 503 })
  }

  try {
    const rawRows = await readSheetRows()
    const parsed = parseReferralRows(rawRows)
    if ('error' in parsed) return NextResponse.json({ error: parsed.error, pulled: rawRows.length }, { status: 422 })
    const rows = parsed.rows

    // Safety guard — this is a REPLACE-ALL. A broken/empty Sheet must never wipe a
    // healthy snapshot. Abort (don't replace) if the new set is suspiciously small
    // vs. what's already stored, or below an optional floor. Manual JSON upload
    // stays available to recover.
    const minRows = parseInt(process.env.REFERRAL_MIN_ROWS ?? '1', 10) || 1
    if (rows.length < minRows) {
      return NextResponse.json(
        { error: `Chỉ có ${rows.length} dòng hợp lệ (< ${minRows}) — bỏ qua để khỏi ghi đè. Kiểm tra Google Sheet.`, pulled: rawRows.length },
        { status: 422 },
      )
    }
    const { count: currentCount, error: countErr } = await supabaseAdmin
      .from('staff_referrals').select('*', { count: 'exact', head: true })
    // If we can't read the current count, the shrink guard would silently no-op —
    // abort rather than risk overwriting with a smaller set.
    if (countErr) return NextResponse.json({ error: `Không đọc được số dòng hiện tại: ${countErr.message}` }, { status: 500 })
    if ((currentCount ?? 0) >= 20 && rows.length < (currentCount ?? 0) * 0.5) {
      return NextResponse.json(
        { error: `Số dòng mới (${rows.length}) thấp bất thường so với hiện có (${currentCount}) — bỏ qua để tránh ghi đè dữ liệu sai. Kiểm tra query/Google Sheet rồi chạy lại.`, pulled: rawRows.length },
        { status: 422 },
      )
    }

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
