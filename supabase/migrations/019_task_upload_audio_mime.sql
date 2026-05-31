-- ============================================================
-- Migration 019: Allow audio uploads on task-uploads bucket
-- ============================================================
-- Appends audio MIME types to task-uploads.allowed_mime_types,
-- preserving all existing types. Idempotent: DISTINCT dedupes on re-run.
-- Skipped when allowed_mime_types is NULL (bucket already allows all).
-- ============================================================

UPDATE storage.buckets
SET allowed_mime_types = (
  SELECT array_agg(DISTINCT m)
  FROM unnest(
    allowed_mime_types || ARRAY[
      'audio/mpeg',   -- mp3
      'audio/wav',
      'audio/x-wav',
      'audio/webm',
      'audio/mp4',    -- m4a (standard)
      'audio/x-m4a',  -- m4a (iOS / some recorders)
      'audio/m4a',    -- m4a (alt)
      'audio/aac',
      'audio/ogg'
    ]::text[]
  ) AS m
)
WHERE id = 'task-uploads'
  AND allowed_mime_types IS NOT NULL;

-- Verify:
-- SELECT id, allowed_mime_types FROM storage.buckets WHERE id = 'task-uploads';
