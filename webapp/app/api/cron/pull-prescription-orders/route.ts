import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { loadServiceAccount, getAccessToken } from '@/lib/google/auth'
import { parseOrderRows } from '@/lib/prescriptions/orderSheet'

// GET /api/cron/pull-prescription-orders — pulls order/customer data for
// submitted prescriptions from a Google Sheet (BI extracts BigQuery → Sheet
// "Circa_prescription" / range order_data) and fills the ORDER-sync columns on
// prescription_submissions (mig 073): customer/pos fields, order_created_at,
// and — for chronic prescriptions — expected_refill_date (+days_supply) and
// reminder_date (-2 days). This is COMPLETELY SEPARATE from the legacy product
// sync (status/pending_sync→synced): only order_sync_* columns are written.
//
// Setup (manual): share the Sheet with the SA email as Viewer, set
// PRESCRIPTION_ORDER_SHEET_ID, and add a Coolify Scheduled Task `0 5,17 * * *`
// (= 12:00 & 24:00 Asia/Saigon) hitting this route with
// `Authorization: Bearer $CRON_SECRET`.

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly'
const SHEET_ID     = process.env.PRESCRIPTION_ORDER_SHEET_ID    || '1ia_TIFzOx3KsKlmLnTdYOd2VHTr8IMmyX0V2ortmdFs'
const SHEET_RANGE  = process.env.PRESCRIPTION_ORDER_SHEET_RANGE || 'order_data'

const DAY = 86400_000
const addDaysISO = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10)

// The Sheet lags BigQuery by hours — a submission younger than this stays
// 'pending' ("Chờ dữ liệu đơn") instead of flipping to a false "Lỗi DHC".
const ERROR_AFTER_MS = 24 * 3600_000
const UNMATCHED_HELP = 'Không tìm thấy mã DHC trong dữ liệu POS/Sheet. Vui lòng kiểm tra lại mã đơn trên POS.'

// Read the sheet's values and key each data row by the header row (row 0).
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
  if (values.length < 2) return []
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
  if (!SHEET_ID) {
    return NextResponse.json({ error: 'PRESCRIPTION_ORDER_SHEET_ID chưa cấu hình' }, { status: 503 })
  }

  // Open the audit run first — a crash mid-way still leaves a 'running'/'failed' trace.
  const { data: run, error: runErr } = await supabaseAdmin
    .from('prescription_order_sync_runs')
    .insert({ status: 'running' })
    .select('id')
    .single()
  if (runErr) return NextResponse.json({ error: `Không mở được sync run: ${runErr.message}` }, { status: 500 })
  const runId = run.id as string
  const failRun = async (message: string) => {
    await supabaseAdmin.from('prescription_order_sync_runs')
      .update({ status: 'failed', row_errors: [{ error: message }], finished_at: new Date().toISOString() })
      .eq('id', runId)
  }

  try {
    const rawRows = await readSheetRows()
    const parsed = parseOrderRows(rawRows)
    if ('error' in parsed) {
      await failRun(parsed.error)
      return NextResponse.json({ error: parsed.error, pulled: rawRows.length }, { status: 422 })
    }
    const { byCode, rowErrors } = parsed

    // Candidates = submissions still needing order data. Two sets, merged:
    //   A) order_sync_status IN (pending, error) — never synced, or flagged; error
    //      rows are retried so a corrected POS entry self-heals.
    //   B) chronic + synced but reminder_date still NULL — a row that synced
    //      before its created_date was readable, or was marked chronic after
    //      sync (super edit). Without this, such a row would never be revisited
    //      and its reminder date would stay null forever.
    const [{ data: setA, error: errA }, { data: setB, error: errB }] = await Promise.all([
      supabaseAdmin
        .from('prescription_submissions')
        .select('id, order_code, submitted_at, is_chronic, days_supply, order_sync_status')
        .in('order_sync_status', ['pending', 'error']),
      supabaseAdmin
        .from('prescription_submissions')
        .select('id, order_code, submitted_at, is_chronic, days_supply, order_sync_status')
        .eq('is_chronic', true)
        .eq('order_sync_status', 'synced')
        .is('reminder_date', null),
    ])
    if (errA || errB) {
      const m = (errA ?? errB)!.message
      await failRun(m)
      return NextResponse.json({ error: `Không đọc được submissions: ${m}` }, { status: 500 })
    }
    const pending = [...(setA ?? []), ...(setB ?? [])].filter(
      (r, i, arr) => arr.findIndex((x) => x.id === r.id) === i,
    )

    let matched = 0
    let flaggedError = 0
    const unmatchedCodes: string[] = []
    const writeErrors: { id: string; error: string }[] = []
    const now = Date.now()

    for (const sub of pending ?? []) {
      const code = String(sub.order_code ?? '').trim().toUpperCase()
      const row = byCode.get(code)
      if (row) {
        const patch: Record<string, unknown> = {
          order_created_at:   row.created_date,
          customer_name:      row.customer_name,
          customer_phone:     row.phone_number,
          pos_code:           row.pos_code,
          pos_name:           row.pos_name,
          order_products_raw: row.products_raw,
          order_sync_error:   null,
          expected_refill_date: null,
          reminder_date:        null,
        }
        if (!sub.is_chronic) {
          patch.order_sync_status = 'synced'
        } else if (Number(sub.days_supply) > 0 && row.created_date) {
          const expected = addDaysISO(row.created_date, Number(sub.days_supply))
          patch.expected_refill_date = expected
          patch.reminder_date = addDaysISO(expected, -2)
          patch.order_sync_status = 'synced'
        } else {
          // Chronic but no usable order date yet — DON'T mark synced, or the row
          // is never revisited and its reminder stays null. Keep it 'pending'
          // ("Chờ dữ liệu đơn") so the next cron retries when the Sheet fills in.
          patch.order_sync_status = 'pending'
          rowErrors.push({ row: 0, error: `Toa mạn tính ${code}: thiếu/không đọc được created_date — chờ dữ liệu đơn` })
        }
        const { error: upErr } = await supabaseAdmin
          .from('prescription_submissions').update(patch).eq('id', sub.id)
        if (upErr) writeErrors.push({ id: sub.id as string, error: upErr.message })
        else matched++
      } else {
        unmatchedCodes.push(code)
        // Only a still-'pending' row ages into a visible error (the Sheet lags
        // BigQuery by hours). 'error' rows stay error; already-'synced' set-B
        // rows are never downgraded to error on a transient miss.
        const age = now - Date.parse(sub.submitted_at as string)
        if (age > ERROR_AFTER_MS && sub.order_sync_status === 'pending') {
          const { error: upErr } = await supabaseAdmin
            .from('prescription_submissions')
            .update({ order_sync_status: 'error', order_sync_error: UNMATCHED_HELP })
            .eq('id', sub.id)
          if (upErr) writeErrors.push({ id: sub.id as string, error: upErr.message })
          else flaggedError++
        }
      }
    }

    await supabaseAdmin.from('prescription_order_sync_runs').update({
      status: 'success',
      pulled_count:    rawRows.length,
      matched_count:   matched,
      unmatched_count: unmatchedCodes.length,
      error_count:     writeErrors.length,
      row_errors:      rowErrors.length || writeErrors.length ? { sheet: rowErrors.slice(0, 100), writes: writeErrors.slice(0, 50) } : null,
      unmatched_codes: unmatchedCodes.length ? unmatchedCodes.slice(0, 500) : null,
      finished_at:     new Date().toISOString(),
    }).eq('id', runId)

    revalidatePath('/prescriptions')
    return NextResponse.json({
      ok: true,
      pulled: rawRows.length,
      candidates: (pending ?? []).length,
      matched,
      unmatched: unmatchedCodes.length,
      flaggedError,
      sheetRowErrors: rowErrors.length,
      writeErrors: writeErrors.length,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await failRun(msg)
    const status = msg.includes('Sheets') || msg.includes('Google token') ? 502 : 500
    return NextResponse.json({ error: msg }, { status })
  }
}
