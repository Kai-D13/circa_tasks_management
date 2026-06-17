-- ============================================================
-- Migration 057: Bổ sung Teams chat cho Circa Mora (sửa mã POS sai)
-- ============================================================
-- File list_chat_id ghi Mora = POS0064 (không tồn tại trong stores → bị bỏ qua
-- ở migration 056). Mã đúng của Circa Mora là POS0017 (đã verify). Thêm cấu hình
-- Teams cho Mora vào đúng code, dùng nguyên id_user/chat_id/displayName của Mora
-- từ file (account Teams của Mora không phụ thuộc mã POS).
-- Idempotent (upsert theo store_id).
-- ============================================================

insert into public.store_teams_chats (store_id, teams_user_id, teams_display_name, tenant_id, chat_id, is_active)
select s.id,
       'e77dd30c-df66-4602-babf-3bf5a3c4f359',
       'Circa Mora',
       '03dfe77f-0daf-487e-a6c7-2601e528133d',
       '19:bb38c695-a049-484a-9027-b27bd4cf47ea_e77dd30c-df66-4602-babf-3bf5a3c4f359@unq.gbl.spaces',
       true
from public.stores s
where s.code = 'POS0017'
on conflict (store_id) do update set
  teams_user_id      = excluded.teams_user_id,
  teams_display_name = excluded.teams_display_name,
  tenant_id          = excluded.tenant_id,
  chat_id            = excluded.chat_id,
  is_active          = true,
  updated_at         = now();

insert into public.app_migrations (version, name)
values ('057', 'teams_chat_mora')
on conflict (version) do nothing;

-- ============================================================
-- Verify
-- ============================================================
-- 1) Mora đã cấu hình:
-- SELECT s.code, s.name, t.teams_display_name, t.is_active
-- FROM public.store_teams_chats t JOIN public.stores s ON s.id=t.store_id WHERE s.code='POS0017';
--
-- 2) Tổng số store active (kỳ vọng 26):
-- SELECT count(*) FROM public.store_teams_chats WHERE is_active;
