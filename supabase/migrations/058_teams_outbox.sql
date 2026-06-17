-- ============================================================
-- Migration 058: Teams notifications outbox (retry + decouple)
-- ============================================================
-- Task creation giờ chỉ ENQUEUE 1 dòng status='pending' vào
-- teams_notification_events; việc gửi n8n do cron /api/cron/teams-dispatch lo,
-- có retry + backoff. Thêm:
--   attempts        — số lần đã thử gửi (dừng retry khi >= 5)
--   next_attempt_at — thời điểm đủ điều kiện gửi lại (backoff) + dùng làm "lease"
--                     chống 2 lần chạy cron gửi trùng.
-- Status 'pending' đã có sẵn trong CHECK của migration 020. Idempotent.
-- ============================================================

alter table public.teams_notification_events
  add column if not exists attempts        int not null default 0,
  add column if not exists next_attempt_at  timestamptz;

-- Index cho truy vấn dispatcher (chỉ các dòng cần xử lý).
create index if not exists idx_tne_dispatch
  on public.teams_notification_events (next_attempt_at)
  where status in ('pending', 'failed');

insert into public.app_migrations (version, name)
values ('058', 'teams_outbox')
on conflict (version) do nothing;

-- ============================================================
-- Verify
-- ============================================================
-- 1) Cột mới có mặt:
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='teams_notification_events'
--   AND column_name IN ('attempts','next_attempt_at');  -- expect 2 rows
--
-- 2) Sau khi deploy + tạo task: có dòng 'pending', rồi cron đổi thành 'sent':
-- SELECT status, count(*) FROM public.teams_notification_events GROUP BY status;
--
-- 3) Migration recorded:
-- SELECT version FROM public.app_migrations WHERE version='058';
