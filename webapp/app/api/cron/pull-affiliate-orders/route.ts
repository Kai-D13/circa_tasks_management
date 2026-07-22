import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { isAffiliateSyncEnabled } from '@/lib/affiliate/flags'
import { fetchAffiliateOrdersSnapshot } from '@/lib/affiliate/mongo'
import { dedupeByOrderId, validateSourceOrder, type AffiliateOrderRow } from '@/lib/affiliate/normalize'

// GET /api/cron/pull-affiliate-orders — đồng bộ đơn Affiliate từ MongoDB Circa
// Online về affiliate_orders. CONTRACT F1/F2 (stakeholder khóa 22/07):
//   • Vòng đời qua ĐÚNG 3 RPC: rpc_start (lease race-safe) → upsert batch →
//     rpc_finish (mark-missing + safety-floor TRONG DB) / rpc_fail khi lỗi.
//     KHÔNG UPDATE rời rạc bằng service role.
//   • Pull TOÀN BỘ snapshot vào memory trước khi ghi; dedupe theo order_id;
//     pulled = upserted + rejected (RPC finish enforce, seen đo trong DB).
//   • Mỗi row upsert set last_seen_run_id + source_active=true + synced_at.
//   • Row thiếu/sai field bắt buộc → REJECT (không ghi 0); total_price ÂM vẫn
//     hợp lệ (user 22/07 — giữ để phát hiện QA thực tế).
//   • rejected>0 → HTTP 200 + status:'warning' + console.warn (run vẫn success
//     ở DB nhưng response/log thể hiện KHÔNG xanh tuyệt đối; non-2xx sẽ làm
//     scheduled task báo fail như sync sập — nhiễu monitoring). Lỗi thật
//     (Mongo/upsert) → rpc_fail + 502. Lease bận → 409.
//   • Gate: CRON_SECRET (401) → AFFILIATE_SYNC_ENABLED (503) — flag SYNC tách
//     khỏi AFFILIATE_ENABLED (UI) để backfill chạy được khi UI còn tắt (F5).
//   • Mongo timeout 15s/60s → tổng thời gian route << lease 15 phút.
// Coolify Scheduled Task (0 */2 * * *) CHỈ tạo ở F5 sau khi backfill + đối
// soát pass — chưa cấu hình bây giờ.

const UPSERT_CHUNK = 500
const GROWTH_WARN_THRESHOLD = 3_000 // plan §3: >3k → cảnh báo, ticket chuyển incremental

export async function GET(request: NextRequest) {
  const secret = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isAffiliateSyncEnabled()) {
    return NextResponse.json({ error: 'Affiliate sync disabled (AFFILIATE_SYNC_ENABLED=false)' }, { status: 503 })
  }

  // DRY-RUN (?dry=1 — QA gate stakeholder): đọc snapshot + dedupe + validate +
  // resolve rồi BÁO CÁO, không lease, KHÔNG GHI GÌ vào DB. Dùng để đối soát
  // totals với Mongo trước first-write.
  if (request.nextUrl.searchParams.get('dry') === '1') {
    try {
      const rawDocs = await fetchAffiliateOrdersSnapshot()
      const { unique, duplicates } = dedupeByOrderId(rawDocs)
      const rejected: { order_id: unknown; reason: string }[] = []
      const statusCount: Record<string, number> = {}
      const codeCount: Record<string, number> = {}
      let valid = 0
      for (const doc of unique) {
        const r = validateSourceOrder(doc)
        if (!r.ok) { rejected.push({ order_id: r.orderId, reason: r.reason }); continue }
        valid++
        statusCount[r.row.raw_status] = (statusCount[r.row.raw_status] ?? 0) + 1
        codeCount[r.row.partner_code] = (codeCount[r.row.partner_code] ?? 0) + 1
      }
      return NextResponse.json({
        ok: true, dry: true,
        raw_fetched: rawDocs.length, duplicates, pulled: unique.length,
        would_upsert: valid, would_reject: rejected.length,
        rejected_reasons: rejected.slice(0, 20),
        status_distribution: statusCount, partner_code_distribution: codeCount,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Mongo error'
      return NextResponse.json({ error: `Mongo (dry): ${msg}` }, { status: 502 })
    }
  }

  // 1) Lease — NULL nghĩa là run khác đang giữ: trả 409, KHÔNG đụng Mongo.
  const { data: runId, error: startErr } = await supabaseAdmin.rpc('rpc_start_affiliate_sync')
  if (startErr) {
    return NextResponse.json({ error: `Không mở được sync run: ${startErr.message}` }, { status: 500 })
  }
  if (!runId) {
    return NextResponse.json({ error: 'Sync đang chạy (lease đang được giữ)' }, { status: 409 })
  }

  const failRun = async (msg: string) => {
    const { error } = await supabaseAdmin.rpc('rpc_fail_affiliate_sync', { p_run_id: runId, p_error: msg })
    if (error) console.error('[affiliate-sync] rpc_fail cũng lỗi:', error.message)
  }

  try {
    // 2) Snapshot toàn bộ subset vào memory (Mongo lỗi/timeout → fail run + 502).
    let rawDocs
    try {
      rawDocs = await fetchAffiliateOrdersSnapshot()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Mongo error'
      await failRun(`Mongo: ${msg}`)
      return NextResponse.json({ error: `Mongo: ${msg}` }, { status: 502 })
    }
    const rawFetched = rawDocs.length
    if (rawFetched > GROWTH_WARN_THRESHOLD) {
      console.warn(`[affiliate-sync] subset=${rawFetched} vượt ngưỡng ${GROWTH_WARN_THRESHOLD} — tạo ticket chuyển incremental theo last_updated_time (plan §3)`)
    }

    // 3) Dedupe theo order_id → pulled = unique = upserted + rejected.
    const { unique, duplicates } = dedupeByOrderId(rawDocs)

    // 4) Validate + normalize; row hỏng → rejected (không upsert âm thầm).
    const rows: AffiliateOrderRow[] = []
    const rejectedReasons: { order_id: unknown; reason: string }[] = []
    for (const doc of unique) {
      const r = validateSourceOrder(doc)
      if (r.ok) rows.push(r.row)
      else rejectedReasons.push({ order_id: r.orderId, reason: r.reason })
    }

    // 5) Resolve store qua mapping (partner_code → store_id, chỉ mapping active).
    const { data: mappings, error: mapErr } = await supabaseAdmin
      .from('affiliate_partner_mappings')
      .select('partner_code, store_id, is_active')
    if (mapErr) {
      await failRun(`Đọc mappings: ${mapErr.message}`)
      return NextResponse.json({ error: `Đọc mappings: ${mapErr.message}` }, { status: 500 })
    }
    const storeByCode = new Map(
      (mappings ?? []).filter((m) => m.is_active).map((m) => [m.partner_code, m.store_id]),
    )
    const unmatchedCodes = new Set<string>()
    const unknownStatuses = new Set<string>()
    const nowIso = new Date().toISOString()
    const upsertRows = rows.map((r) => {
      const storeId = storeByCode.get(r.partner_code) ?? null
      if (!storeByCode.has(r.partner_code)) unmatchedCodes.add(r.partner_code)
      if (r.status_norm === 'other') unknownStatuses.add(r.raw_status)
      return {
        ...r,
        store_id: storeId,
        last_seen_run_id: runId,   // contract: SEEN đo trong DB theo cột này
        source_active: true,
        synced_at: nowIso,
      }
    })

    // 6) Upsert batch theo order_id — batch lỗi → rpc_fail, TUYỆT ĐỐI không finish.
    for (let i = 0; i < upsertRows.length; i += UPSERT_CHUNK) {
      const chunk = upsertRows.slice(i, i + UPSERT_CHUNK)
      const { error: upErr } = await supabaseAdmin
        .from('affiliate_orders')
        .upsert(chunk, { onConflict: 'order_id' })
      if (upErr) {
        await failRun(`Upsert batch ${i / UPSERT_CHUNK + 1}: ${upErr.message}`)
        return NextResponse.json({ error: `Upsert: ${upErr.message}` }, { status: 502 })
      }
    }

    // 7) Finish — mark-missing + safety floor + đóng run trong 1 transaction ở DB.
    const { data: finish, error: finErr } = await supabaseAdmin.rpc('rpc_finish_affiliate_sync', {
      p_run_id: runId,
      p_pulled: unique.length,
      p_upserted: upsertRows.length,
      p_rejected: rejectedReasons.length,
      p_unmatched: unmatchedCodes.size ? [...unmatchedCodes] : null,
      p_unknown: unknownStatuses.size ? [...unknownStatuses] : null,
    })
    if (finErr) {
      // Contract bị vi phạm (finish RAISE) → đóng run failed cho sạch lease.
      await failRun(`rpc_finish RAISE: ${finErr.message}`)
      return NextResponse.json({ error: `Finish: ${finErr.message}` }, { status: 500 })
    }

    // 8) Response + log vận hành. rejected>0 = WARNING rõ ràng, không xanh tuyệt đối.
    const hasWarning = rejectedReasons.length > 0 || unmatchedCodes.size > 0 || unknownStatuses.size > 0
    if (rejectedReasons.length > 0) {
      console.warn(`[affiliate-sync] ${rejectedReasons.length} row REJECTED (không upsert):`,
        JSON.stringify(rejectedReasons.slice(0, 10)))
    }
    if (unmatchedCodes.size > 0) {
      console.warn('[affiliate-sync] partner_code chưa map (store_id=NULL, chỉ super thấy):', [...unmatchedCodes].join(', '))
    }
    if (unknownStatuses.size > 0) {
      console.warn('[affiliate-sync] status lạ → other:', [...unknownStatuses].join(', '))
    }

    revalidatePath('/targets')

    return NextResponse.json({
      ok: true,
      status: rejectedReasons.length > 0 ? 'warning' : hasWarning ? 'success_with_notes' : 'success',
      run_id: runId,
      raw_fetched: rawFetched,
      duplicates,
      pulled: unique.length,
      upserted: upsertRows.length,
      rejected: rejectedReasons.length,
      rejected_reasons: rejectedReasons.slice(0, 20),
      deactivated: (finish as { deactivated?: number } | null)?.deactivated ?? 0,
      finish_note: (finish as { note?: string | null } | null)?.note ?? null,
      unmatched_codes: [...unmatchedCodes],
      unknown_statuses: [...unknownStatuses],
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown'
    await failRun(msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
