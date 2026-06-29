import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { loadServiceAccount, getAccessToken } from '@/lib/google/auth'
import { createTrfTasks } from '@/lib/inventory/trf'
import { CYCLE_COUNT_DEPT_ID } from '@/lib/inventory/constants'

// GET /api/cron/pull-inventory-trf — Inventory → TRF. Reads a Google Sheet
// (pos_code_check, pos_name_check, TRF_code, reason, created_by), maps
// pos_code_check → stores.code, and creates ONE store-level task per NEW
// (store, TRF). Mirrors pull-referrals (Bearer CRON_SECRET, reuses the BigQuery
// service account with the Sheets read-only scope).
//
// Setup (manual): provision a Cycle Count system admin user → INVENTORY_TRF_CREATED_BY;
// set INVENTORY_TRF_SHEET_ID/RANGE/DEADLINE_HOURS; share the Sheet with the SA email
// as Viewer; add a Coolify Scheduled Task hitting this route with Bearer $CRON_SECRET
// (0 2 * * * = 09:00 Asia/Saigon).

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly'
const SHEET_ID     = process.env.INVENTORY_TRF_SHEET_ID    || ''
const SHEET_RANGE  = process.env.INVENTORY_TRF_SHEET_RANGE || 'Sheet1'

async function readSheetRows(): Promise<Record<string, unknown>[]> {
  const sa = loadServiceAccount('BQ_SERVICE_ACCOUNT_KEY')
  if (!sa) throw new Error('Google token: BQ_SERVICE_ACCOUNT_KEY chưa hợp lệ')
  if (!SHEET_ID) throw new Error('INVENTORY_TRF_SHEET_ID chưa cấu hình')
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

  // created_by is MANDATORY: a stable Cycle Count system admin (overdue notif +
  // dept stamp + owner tools). Abort rather than create tasks with created_by=null.
  const createdBy = process.env.INVENTORY_TRF_CREATED_BY
  if (!createdBy) {
    return NextResponse.json({ error: 'INVENTORY_TRF_CREATED_BY chưa cấu hình' }, { status: 503 })
  }
  const { data: owner, error: ownerErr } = await supabaseAdmin
    .from('users').select('role, department_id').eq('id', createdBy).maybeSingle()
  if (ownerErr) {
    return NextResponse.json({ error: `Không kiểm tra được system owner: ${ownerErr.message}` }, { status: 500 })
  }
  if (!owner || owner.role !== 'admin' || owner.department_id !== CYCLE_COUNT_DEPT_ID) {
    return NextResponse.json(
      { error: 'INVENTORY_TRF_CREATED_BY không hợp lệ — phải là user role=admin thuộc phòng Cycle Count' },
      { status: 503 },
    )
  }

  const deadlineHours = parseInt(process.env.INVENTORY_TRF_DEADLINE_HOURS ?? '48', 10) || 48

  // Open an import run for audit + as the FK target for inventory_trf_items.
  const { data: run, error: runErr } = await supabaseAdmin
    .from('inventory_trf_import_runs')
    .insert({
      status: 'running',
      sheet_id: SHEET_ID,
      sheet_range: SHEET_RANGE,
      deadline_hours: deadlineHours,
      created_by: createdBy,
    })
    .select('id').single()
  if (runErr || !run) {
    return NextResponse.json({ error: `Không tạo được import run: ${runErr?.message}` }, { status: 500 })
  }
  const runId = run.id as string

  try {
    const rawRows = await readSheetRows()
    const result = await createTrfTasks(rawRows, { runId, createdBy, deadlineHours })

    if ('error' in result) {
      // Header/duplicate validation failure → no partial write.
      await supabaseAdmin.from('inventory_trf_import_runs').update({
        status: 'failed', pulled: rawRows.length, error: { message: result.error },
        finished_at: new Date().toISOString(),
      }).eq('id', runId)
      return NextResponse.json({ error: result.error, pulled: rawRows.length }, { status: 422 })
    }

    // Summary notification per store (store managers only; staff get none) +
    // detect stores that received TRF but have NO store_manager (silent gap).
    const storesWithoutManager: string[] = []
    if (result.created > 0) {
      const { data: newItems } = await supabaseAdmin
        .from('inventory_trf_items').select('store_id').eq('source_run_id', runId)
      const countByStore = new Map<string, number>()
      for (const it of newItems ?? []) {
        countByStore.set(it.store_id, (countByStore.get(it.store_id) ?? 0) + 1)
      }
      const storeIds = [...countByStore.keys()]
      if (storeIds.length) {
        const { data: managers } = await supabaseAdmin
          .from('users').select('id, store_id').eq('role', 'store_manager').in('store_id', storeIds)
        const withManager = new Set((managers ?? []).map((m) => m.store_id))
        for (const sid of storeIds) if (!withManager.has(sid)) storesWithoutManager.push(sid)
        const notifs = (managers ?? []).map((m) => ({
          user_id: m.id,
          type: 'inventory_trf',
          task_id: null,
          title: 'Kiểm kho TRF',
          message: `Có ${countByStore.get(m.store_id) ?? 0} mã TRF mới cần kiểm tra`,
        }))
        if (notifs.length) {
          const { error: notifErr } = await supabaseAdmin.from('notifications').insert(notifs)
          if (notifErr) console.error('[inventory-trf] notif insert failed:', notifErr.message)
        }
        if (storesWithoutManager.length) {
          console.warn(`[inventory-trf] ${storesWithoutManager.length} store(s) got TRF but have no store_manager — no notification sent:`, storesWithoutManager)
        }
      }
    }

    await supabaseAdmin.from('inventory_trf_import_runs').update({
      status: 'success',
      pulled: result.pulled, created: result.created, skipped: result.skipped,
      unmatched: result.unmatched.length, duplicates: result.duplicates,
      error: (result.unmatched.length || storesWithoutManager.length)
        ? { unmatched: result.unmatched, stores_without_store_manager: storesWithoutManager }
        : null,
      finished_at: new Date().toISOString(),
    }).eq('id', runId)

    revalidatePath('/inventory')
    revalidatePath('/inventory/trf')
    return NextResponse.json({ ok: true, ...result, storesWithoutManager })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await supabaseAdmin.from('inventory_trf_import_runs').update({
      status: 'failed', error: { message: msg }, finished_at: new Date().toISOString(),
    }).eq('id', runId)
    const status = msg.includes('Sheets') || msg.includes('Google token') ? 502 : 500
    return NextResponse.json({ error: msg }, { status })
  }
}
