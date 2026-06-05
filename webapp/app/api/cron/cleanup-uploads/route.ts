import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/admin'

// GET /api/cron/cleanup-uploads
// Deletes orphan uploads (unlinked after 24 h) from Storage and marks them deleted.
// Called by Coolify Scheduled Tasks:
//   wget -qO- -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/cleanup-uploads
export async function GET(request: NextRequest) {
  const secret = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString()

  const { data: orphans, error: fetchErr } = await supabaseAdmin
    .from('task_uploaded_files')
    .select('id, path, thumbnail_path')
    .is('linked_at', null)
    .is('deleted_at', null)
    .lt('created_at', cutoff)
    .limit(200)

  if (fetchErr) {
    return NextResponse.json({ error: fetchErr.message }, { status: 500 })
  }

  const count = orphans?.length ?? 0
  if (count === 0) {
    return NextResponse.json({ ok: true, deleted: 0 })
  }

  // Collect all storage paths (original + thumbnail)
  const storagePaths: string[] = (orphans ?? []).flatMap((f) =>
    [f.path, f.thumbnail_path].filter((p): p is string => !!p)
  )

  // Remove from Storage — abort if delete fails so rows stay queryable for retry
  const { error: storageErr } = await supabaseAdmin.storage
    .from('task-uploads')
    .remove(storagePaths)
  if (storageErr) {
    console.error('[cleanup-uploads] storage.remove:', storageErr.message)
    return NextResponse.json({ error: 'Storage delete failed; will retry next run' }, { status: 500 })
  }

  // Mark rows deleted only after successful storage deletion
  const now = new Date().toISOString()
  const { error: dbErr } = await supabaseAdmin
    .from('task_uploaded_files')
    .update({ deleted_at: now })
    .in('id', (orphans ?? []).map((f) => f.id))
  if (dbErr) console.error('[cleanup-uploads] mark deleted:', dbErr.message)

  await supabaseAdmin.from('task_logs').insert({
    task_id:  null,
    action:   'cleanup_orphan_uploads',
    user_id:  null,
    metadata: { deleted: count, cutoff_hours: 24, ran_at: now },
  })

  return NextResponse.json({ ok: true, deleted: count })
}
