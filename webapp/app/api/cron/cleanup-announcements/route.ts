import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/admin'

// GET /api/cron/cleanup-announcements — hard-delete announcements whose expiry
// passed more than 30 days ago. Expired announcements are already hidden from
// Staff/Store via RLS at expiry; this purge keeps read stats available for ~30
// days post-campaign, then frees the data (cascades to stores/assets/reads).
// The WHERE clause satisfies the pg_safeupdate guard. Run daily via Coolify.
export async function GET(request: NextRequest) {
  const secret = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString()
  const { data, error } = await supabaseAdmin
    .from('announcements')
    .delete()
    .not('expires_at', 'is', null)
    .lt('expires_at', cutoff)
    .select('id')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, deleted: data?.length ?? 0 })
}
