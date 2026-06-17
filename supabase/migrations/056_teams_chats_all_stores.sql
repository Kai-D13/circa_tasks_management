-- ============================================================
-- Migration 056: Seed store_teams_chats cho TẤT CẢ cửa hàng
-- ============================================================
-- Mở rộng Teams notifications từ MVP (chỉ POS0059, migration 020) ra toàn bộ
-- cửa hàng. Dữ liệu từ team cung cấp (list_chat_id) — mỗi store: chat 1:1 giữa
-- tài khoản gửi "Circa Tasks" (bb38c695-a049-484a-9027-b27bd4cf47ea /
-- circa.tasks@buymed.com) và tài khoản Teams của cửa hàng.
--   teams_user_id      = id_user (account cửa hàng để @mention)
--   teams_display_name = displayName
--   tenant_id          = 03dfe77f-0daf-487e-a6c7-2601e528133d (chung)
--   chat_id            = chat 1:1 với sender mới
-- LƯU Ý: chat_id của POS0059 ĐỔI so với migration 020 (sender cũ → "Circa Tasks")
-- nên ON CONFLICT sẽ ghi đè cho đúng. Match theo stores.code = pos_id.
-- Idempotent (upsert theo store_id). Không tạo store thiếu — entry không khớp
-- code sẽ bị bỏ qua an toàn.
-- ============================================================

with cfg(pos_id, id_user, display_name, chat_id) as (
  values
    ('POS0015','6d523a1a-789d-4591-871f-b15b857fa33d','Circa Elena','19:6d523a1a-789d-4591-871f-b15b857fa33d_bb38c695-a049-484a-9027-b27bd4cf47ea@unq.gbl.spaces'),
    ('POS0013','f7a8c701-2ebe-45e3-8dbc-0a4b8032b09f','Circa Mizuki','19:bb38c695-a049-484a-9027-b27bd4cf47ea_f7a8c701-2ebe-45e3-8dbc-0a4b8032b09f@unq.gbl.spaces'),
    ('POS0069','1224296a-a7a3-4a18-ace9-11ce87208162','Circa Rainbow','19:1224296a-a7a3-4a18-ace9-11ce87208162_bb38c695-a049-484a-9027-b27bd4cf47ea@unq.gbl.spaces'),
    ('POS0067','f0f05b53-1faa-42ff-b18a-8246ad9aa203','Circa Celadon','19:bb38c695-a049-484a-9027-b27bd4cf47ea_f0f05b53-1faa-42ff-b18a-8246ad9aa203@unq.gbl.spaces'),
    ('POS0073','2a3520e9-ffa5-495a-b6b1-d75a839456cd','Circa Eco Green','19:2a3520e9-ffa5-495a-b6b1-d75a839456cd_bb38c695-a049-484a-9027-b27bd4cf47ea@unq.gbl.spaces'),
    ('POS0012','fe1fe0cf-8bfb-492d-9578-586b6283c392','Circa Lumina','19:bb38c695-a049-484a-9027-b27bd4cf47ea_fe1fe0cf-8bfb-492d-9578-586b6283c392@unq.gbl.spaces'),
    ('POS0066','214c1e93-22e8-4d49-a517-97031d01571d','Circa Pharmaone','19:214c1e93-22e8-4d49-a517-97031d01571d_bb38c695-a049-484a-9027-b27bd4cf47ea@unq.gbl.spaces'),
    ('POS0014','d0b66b77-b3db-4374-a737-69197b1d09c7','Circa Sunrise Riverside','19:bb38c695-a049-484a-9027-b27bd4cf47ea_d0b66b77-b3db-4374-a737-69197b1d09c7@unq.gbl.spaces'),
    ('POS0011','01421030-981e-4b00-93e0-83fb103d9ca2','Circa Urban','19:01421030-981e-4b00-93e0-83fb103d9ca2_bb38c695-a049-484a-9027-b27bd4cf47ea@unq.gbl.spaces'),
    ('POS0070','5cefb67e-4cbb-419c-96d5-1d731820d21d','Circa Cityland','19:5cefb67e-4cbb-419c-96d5-1d731820d21d_bb38c695-a049-484a-9027-b27bd4cf47ea@unq.gbl.spaces'),
    ('POS0062','8b363b89-fee9-4e81-beee-0435b35a10c6','Circa Astoria','19:8b363b89-fee9-4e81-beee-0435b35a10c6_bb38c695-a049-484a-9027-b27bd4cf47ea@unq.gbl.spaces'),
    ('POS0065','fc1ca2e5-d8b5-41cb-a9db-8a80d815235e','Circa Symphony','19:bb38c695-a049-484a-9027-b27bd4cf47ea_fc1ca2e5-d8b5-41cb-a9db-8a80d815235e@unq.gbl.spaces'),
    ('POS0079','7cd3c21b-ff1f-4adb-b3e6-212a69db1459','Circa Ehome 3','19:7cd3c21b-ff1f-4adb-b3e6-212a69db1459_bb38c695-a049-484a-9027-b27bd4cf47ea@unq.gbl.spaces'),
    ('POS0016','a3066b15-e520-4152-84a3-ed36e36a0793','Circa Thong Nhat','19:a3066b15-e520-4152-84a3-ed36e36a0793_bb38c695-a049-484a-9027-b27bd4cf47ea@unq.gbl.spaces'),
    ('POS0080','d2115ae9-ebc5-47e5-b6d4-2cf11326ef05','Circa Akari','19:bb38c695-a049-484a-9027-b27bd4cf47ea_d2115ae9-ebc5-47e5-b6d4-2cf11326ef05@unq.gbl.spaces'),
    ('POS0019','209e386f-710d-4819-841e-02d64ac69466','Circa Mira','19:209e386f-710d-4819-841e-02d64ac69466_bb38c695-a049-484a-9027-b27bd4cf47ea@unq.gbl.spaces'),
    ('POS0068','20c5e36b-bdc8-495c-9575-b78459d02d02','Circa Florita','19:20c5e36b-bdc8-495c-9575-b78459d02d02_bb38c695-a049-484a-9027-b27bd4cf47ea@unq.gbl.spaces'),
    ('POS0063','79e091a5-94fb-493b-a6be-60199c16bbb8','Circa Medly','19:79e091a5-94fb-493b-a6be-60199c16bbb8_bb38c695-a049-484a-9027-b27bd4cf47ea@unq.gbl.spaces'),
    ('POS0058','b8997316-14d6-4406-b7c5-e40f1495af15','Circa Beverly – Vinhomes','19:b8997316-14d6-4406-b7c5-e40f1495af15_bb38c695-a049-484a-9027-b27bd4cf47ea@unq.gbl.spaces'),
    ('POS0009','b5e9ba53-8d91-4622-adcd-56a9211366a8','Circa Central','19:b5e9ba53-8d91-4622-adcd-56a9211366a8_bb38c695-a049-484a-9027-b27bd4cf47ea@unq.gbl.spaces'),
    ('POS0064','e77dd30c-df66-4602-babf-3bf5a3c4f359','Circa Mora','19:bb38c695-a049-484a-9027-b27bd4cf47ea_e77dd30c-df66-4602-babf-3bf5a3c4f359@unq.gbl.spaces'),
    ('POS0018','ccfde11e-cfd9-4feb-bdaa-d3eccf4589bf','Circa Signature','19:bb38c695-a049-484a-9027-b27bd4cf47ea_ccfde11e-cfd9-4feb-bdaa-d3eccf4589bf@unq.gbl.spaces'),
    ('POS0059','c8570b06-fa97-4082-9767-e3bafd13c0f9','Circa Tam Viet','19:bb38c695-a049-484a-9027-b27bd4cf47ea_c8570b06-fa97-4082-9767-e3bafd13c0f9@unq.gbl.spaces'),
    ('POS0085','9442be4d-5011-487a-ae4e-616d529714b4','Circa Belvita','19:9442be4d-5011-487a-ae4e-616d529714b4_bb38c695-a049-484a-9027-b27bd4cf47ea@unq.gbl.spaces'),
    ('POS0060','4cf851ee-498c-4520-b1f9-061c3a71c5d2','Circa Tam An','19:4cf851ee-498c-4520-b1f9-061c3a71c5d2_bb38c695-a049-484a-9027-b27bd4cf47ea@unq.gbl.spaces'),
    ('POS0077','580765a5-2024-44d3-9332-dd5224b71179','Circa Nam Viet','19:580765a5-2024-44d3-9332-dd5224b71179_bb38c695-a049-484a-9027-b27bd4cf47ea@unq.gbl.spaces')
)
insert into public.store_teams_chats (store_id, teams_user_id, teams_display_name, tenant_id, chat_id, is_active)
select s.id, c.id_user, c.display_name, '03dfe77f-0daf-487e-a6c7-2601e528133d', c.chat_id, true
from cfg c
join public.stores s on s.code = c.pos_id
on conflict (store_id) do update set
  teams_user_id      = excluded.teams_user_id,
  teams_display_name = excluded.teams_display_name,
  tenant_id          = excluded.tenant_id,
  chat_id            = excluded.chat_id,
  is_active          = true,
  updated_at         = now();

-- Record this migration.
insert into public.app_migrations (version, name)
values ('056', 'teams_chats_all_stores')
on conflict (version) do nothing;

-- ============================================================
-- Verify
-- ============================================================
-- 1) Số store đã cấu hình (kỳ vọng = số entry khớp code, tối đa 26):
-- SELECT count(*) FROM public.store_teams_chats WHERE is_active;
--
-- 2) Phát hiện pos_id trong file KHÔNG khớp stores.code (cần bổ sung store/code):
-- WITH cfg(pos_id) AS (VALUES ('POS0015'),('POS0013'),('POS0069'),('POS0067'),
--   ('POS0073'),('POS0012'),('POS0066'),('POS0014'),('POS0011'),('POS0070'),
--   ('POS0062'),('POS0065'),('POS0079'),('POS0016'),('POS0080'),('POS0019'),
--   ('POS0068'),('POS0063'),('POS0058'),('POS0009'),('POS0064'),('POS0018'),
--   ('POS0059'),('POS0085'),('POS0060'),('POS0077'))
-- SELECT c.pos_id FROM cfg c LEFT JOIN public.stores s ON s.code=c.pos_id WHERE s.id IS NULL;
-- (kỳ vọng: 0 dòng)
--
-- 3) Đối chiếu store ↔ chat:
-- SELECT s.code, s.name, t.teams_display_name, t.is_active
-- FROM public.store_teams_chats t JOIN public.stores s ON s.id=t.store_id ORDER BY s.code;
--
-- 4) Migration recorded:
-- SELECT version FROM public.app_migrations WHERE version='056';
