-- ============================================================
-- Patch 003 — Supabase Storage bucket for task file uploads
-- Run this in Supabase SQL Editor
-- ============================================================

-- Create the task-uploads bucket (public so uploaded URLs are directly accessible)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'task-uploads',
  'task-uploads',
  true,
  52428800,   -- 50 MB per file
  ARRAY[
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif',
    'video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/zip', 'application/x-rar-compressed',
    'text/plain', 'text/csv'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- Allow authenticated users to upload files
CREATE POLICY "task_uploads_insert"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'task-uploads');

-- Allow public read (so staff can view their uploaded files via public URL)
CREATE POLICY "task_uploads_select"
ON storage.objects FOR SELECT TO public
USING (bucket_id = 'task-uploads');

-- Allow authenticated users to replace/update their uploads
CREATE POLICY "task_uploads_update"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'task-uploads');

-- Verify: check bucket was created
SELECT id, name, public, file_size_limit FROM storage.buckets WHERE id = 'task-uploads';
