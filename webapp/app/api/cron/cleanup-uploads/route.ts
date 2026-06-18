import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { deleteObject } from '@/lib/storage/gcs'

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
    .select('id, path, thumbnail_path, bucket')
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

  // Split by provider — GCS rows (bucket='gcs') delete via the GCS API; the rest
  // (default 'task-uploads') via Supabase Storage.
  type Orphan = { id: string; path: string | null; thumbnail_path: string | null; bucket: string | null }
  const rows = (orphans ?? []) as Orphan[]
  const gcsRows = rows.filter((f) => f.bucket === 'gcs')
  const supaRows = rows.filter((f) => f.bucket !== 'gcs')
  const deletedIds: string[] = []

  // Supabase: bulk remove; abort on error so rows stay queryable for retry.
  const supaPaths = supaRows.flatMap((f) => [f.path, f.thumbnail_path].filter((p): p is string => !!p))
  if (supaPaths.length > 0) {
    const { error: storageErr } = await supabaseAdmin.storage.from('task-uploads').remove(supaPaths)
    if (storageErr) {
      console.error('[cleanup-uploads] storage.remove:', storageErr.message)
      return NextResponse.json({ error: 'Storage delete failed; will retry next run' }, { status: 500 })
    }
  }
  deletedIds.push(...supaRows.map((f) => f.id))

  // GCS: delete each object; mark a row deleted only if all its keys are gone
  // (deleteObject returns true on 404 → idempotent). Failures retry next run.
  for (const f of gcsRows) {
    const keys = [f.path, f.thumbnail_path].filter((p): p is string => !!p)
    try {
      const results = await Promise.all(keys.map((k) => deleteObject(k)))
      if (results.every(Boolean)) deletedIds.push(f.id)
    } catch (e) {
      console.error('[cleanup-uploads] gcs delete:', e instanceof Error ? e.message : e)
    }
  }

  const now = new Date().toISOString()
  if (deletedIds.length > 0) {
    const { error: dbErr } = await supabaseAdmin
      .from('task_uploaded_files')
      .update({ deleted_at: now })
      .in('id', deletedIds)
    if (dbErr) console.error('[cleanup-uploads] mark deleted:', dbErr.message)
  }

  await supabaseAdmin.from('task_logs').insert({
    task_id:  null,
    action:   'cleanup_orphan_uploads',
    user_id:  null,
    metadata: { deleted: deletedIds.length, supabase: supaRows.length, gcs: gcsRows.length, cutoff_hours: 24, ran_at: now },
  })

  return NextResponse.json({ ok: true, deleted: deletedIds.length })
}
