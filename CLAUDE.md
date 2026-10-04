# Circa Tasks Management — hướng dẫn cho agent (Claude Code / Codex)

> Đọc file này trước khi làm bất cứ việc gì. Hiện trạng deploy/migration/việc đang mở: `planning/STATE.md`.
> Trả lời user bằng **tiếng Việt**; code, SQL, tên cột giữ nguyên.

## 1. Dự án là gì
Nền tảng vận hành nội bộ cho chuỗi nhà thuốc **Circa** (~25 cửa hàng OS + vài cửa hàng nhượng quyền FS, ~100 user) tại `duocsi.circa.vn`.
Module: Tasks (lõi) · Bảng tin · Doanh số `/targets` · Chiến dịch KPI `/targets/campaigns` · Affiliate · Toa thuốc `/prescriptions` · Tồn kho→TRF `/inventory` · Sản phẩm FS `/fs/products` · Users/Stores/Logs.
Repo: `webapp/` (Next.js) · `supabase/migrations/` (SQL, chạy tay trên prod) · `docs/` (plan/handoff/runbook cũ) · `planning/` (CONTRACT · SPEC · STATE · research/ của module đang làm).

## 2. Stack & hạ tầng
- **Next.js 16** App Router (`webapp/proxy.ts` thay cho middleware), React 19, Tailwind 4, **shadcn v4 trên @base-ui** (không có `asChild` → dùng `render`), Zustand, zod, Tiptap 3. Đọc `node_modules/next/dist/docs` trước khi dùng API Next lạ.
- Backend = Server Actions `webapp/app/actions/*.ts` + Route Handlers `webapp/app/api/{cron,export}/*`. Không có server riêng.
- **Supabase self-host** (`database-duocsi.circa.vn`): Postgres + Auth + Storage. **Realtime đã tắt** (thông báo poll 60s). Phân quyền = RLS + RPC `SECURITY DEFINER`.
- Tích hợp: BigQuery (SA chỉ có dataset `buymed_tech`), Google Sheets, MongoDB Circa Online (chỉ đọc, dev cần VPN), GCS (`STORAGE_PROVIDER=gcs`), n8n→Teams.
- Deploy: Docker standalone → **Coolify deploy tay từ `main` HEAD**. Cron = Coolify Scheduled Tasks gọi `/api/cron/*` với `Bearer CRON_SECRET` (`vercel.json` là di sản).
- Test: **Playwright** là runner duy nhất (unit/contract/e2e theo vai trò, ~700 test). `npm run test:e2e` cần server đang chạy ở `localhost` (không phải 127.0.0.1). Xem `webapp/e2e/{auth.setup,dbFixtures,writeQaGates}.ts`.

## 3. Vai trò & phân quyền
| role | nghĩa |
|---|---|
| super admin | `role='admin'` **và** email trong allowlist — allowlist ở **2 chỗ**: `webapp/lib/authz.ts` + SQL `is_super_admin()` (mig 046/066/…/113); test `e2e/super-admin-allowlist.spec.ts` ép khớp |
| `admin` (PIC) | chỉ sửa/xoá task mình tạo; xem task cùng phòng ban; một số phòng là "cổng quyền": Policy→FS, Cycle Count→TRF, OPS→Affiliate (`department_id` + helper SECDEF) |
| `sm` | quản lý vùng, nhiều store qua `sm_store_assignments` |
| `store_manager` | **tài khoản dùng chung của cửa hàng (QLCH)**, không phải cá nhân; nộp thay staff phải chọn người thực hiện |
| `staff` | dược sĩ, **mobile-only** (không có sidebar desktop; bottom nav 5 tab cố định) |
User thuộc store FS chỉ thấy module FS (`redirectIfFsStaff`). Helper: `lib/authz.ts`, `lib/tasks/smScope.ts`, `lib/kpi/campaignAccess.ts`, `lib/fs/{access,isolation}.ts`.

## 4. Luật cứng khi viết DB (đã trả giá bằng sự cố prod)
1. Policy RLS **không được tham chiếu bảng RLS khác** → dùng helper `SECURITY DEFINER STABLE SET search_path=public`; viết dạng `(select auth.uid())` / `(select public.fn())`. Vẽ đồ thị tham chiếu trước (sự cố 047→048/049).
2. Function mới: `REVOKE ALL ... FROM PUBLIC, anon, authenticated` **đích danh**, rồi GRANT đúng role; verify bằng `has_function_privilege` (mig 091).
3. Prod bật `pg_safeupdate`: UPDATE/DELETE luôn có WHERE (`WHERE true` nếu cần) (059→061).
4. Embed PostgREST phải ghi FK khi có bảng nối: `stores!users_store_id_fkey(*)` (từng sập login, mig 045).
5. `public.users` chỉ super ghi được; self-edit phải qua RPC (`update_own_profile`).
6. Migration: file `NNN_ten.sql` trong `supabase/migrations/`, template như **112/113**: header (chạy sau N, contract, idempotency, ROLLBACK kèm `DELETE FROM app_migrations`), `BEGIN…COMMIT`, preflight `IF NOT EXISTS version=N-1 THEN RAISE`, cuối cùng `INSERT INTO app_migrations`, block VERIFY. Thử trên PGlite trước (`webapp/scripts/qa-kpi-order-bonus-112.mjs` là mẫu). **Nguồn sự thật về migration đã chạy = bảng `app_migrations`**, không phải header "DRAFT".
7. Ghi tài chính/định danh phải atomic qua RPC: khoá dòng `FOR UPDATE`, validate toàn bộ trước khi xoá/ghi, fail-closed (không bao giờ ghi số 0 giả; nguồn lỗi → giữ snapshot cũ).
8. Số điện thoại = identity khách: `normalizeVnPhone()` (`lib/affiliate/phone.ts`) / SQL `normalize_phone`; log phải `maskVnPhone`.

## 5. Luật cứng khi viết app
- Mọi truy vấn store OS phải lọc `store_type='os'` + `is_active=true`; ghi vào `tasks` phải qua `assertOsStoreIds`; task "chuyên biệt" dùng `tasks.source_type` để không lẫn vào `/tasks` (tiền lệ TRF, mig 068).
- Kiểm quyền ở **server** (action/RPC/RLS), UI chỉ ẩn thêm. Ghi nhạy cảm dùng `supabaseAdmin` **sau** khi đã check quyền ở app.
- Upload qua `createUploadUrl` (`app/actions/uploads.ts`) → GCS; không tạo đường upload riêng.
- Thông báo: in-app (`notifications`, staff **không** nhận — thiết kế), Teams qua outbox `teams_notification_events` (không kèm PII).
- Tính năng mới chạy sau **cờ env mặc định OFF** (`lib/kpi/flags.ts` là mẫu), khai báo trong `webapp/.env.example`.
- **UI: load skill `webapp/.claude/skills/circa-ui` trước khi sửa bất kỳ `.tsx`** (StatusBadge, DataTableShell, 44px touch target, không hardcode màu).
- Staff mobile: thêm entry point phải quyết định vị trí trên bottom nav 5 tab (`components/layout/BottomNav.tsx`).

## 6. Quy trình làm việc
- Vai trò: user = operator/relay (chạy DDL prod, deploy Coolify, VPN, nạp file) · PM = spec/audit · agent = dev team.
- **`main` luôn deploy được.** Module lớn → nhánh `feat/<module>`, merge `--no-ff` khi QA xong. Commit: `feat|fix|test|docs(scope): <batch>.<step> — <việc>`; vòng audit `r1`, `r1.1`…
- Gate mỗi commit: `npx tsc --noEmit` → spec liên quan → full Playwright → `npm run build` → `git diff --check`. Không commit khi user chưa yêu cầu.
- Rollout chuẩn: deploy flag-off → migration (user chạy, agent VERIFY đọc qua pg-meta `POST $SUPABASE_URL/pg/query`) → backfill/dry-run ×2 → QA fixture `is_test` → bật cờ → smoke theo vai trò. **Không có staging**: QA ghi trên prod phải có safety gate (`e2e/writeQaGates.ts`).
- Báo cáo batch cho PM: SHA, phạm vi, bằng chứng test/QA, rủi ro, câu hỏi mở. Câu hỏi nghiệp vụ → hỏi user để chuyển stakeholder, không tự quyết.
- Sub-agent (`.claude/agents/`): `db-reviewer` (opus — RLS/grant/migration), `security-reviewer` (sonnet — leo quyền/PII), `pm-auditor` (sonnet — đối chiếu CONTRACT/SPEC). Khảo sát/tìm file → Explore với sonnet/haiku; chỉ dùng opus cho suy luận DB/kiến trúc. Chạy 3 reviewer song song trên cùng diff rồi tổng hợp trước khi gửi PM.
- Hook (`.claude/settings.json` → `hooks/guard.mjs`): `git commit` tự chạy `tsc --noEmit` (lỗi = chặn); sửa `.tsx` được nhắc skill `circa-ui`.
- Không commit ảnh prod/PII/secret; secret lọt vào chat thì phải rotate.

## 7. Feature đang làm: Chăm sóc khách hàng (CRM-CSKH) — giai đoạn DEFINE
- `planning/CONTRACT.md` — nghiệp vụ **đã chốt** với stakeholder (source of truth khi có mâu thuẫn).
- `planning/SPEC.md` — kỹ thuật, viết sau khi CONTRACT chốt.
- `planning/research/crm-cskh-handoff/` — đầu vào chưa final: tài liệu gốc stakeholder, 4 mockup (chỉ bố cục), SPEC nháp của BA, `OPEN_QUESTIONS.md` (Q-01…Q-32), `DECISIONS.md` (ghi khi stakeholder chốt).
- Quy ước khi code: gặp `[CẦN XÁC NHẬN Q-xx]` → dùng mặc định trong OPEN_QUESTIONS, để dễ đổi (config/enum), comment `// TODO(Q-xx)`. Không tự thêm tính năng GĐ2.
- **Chưa code** cho tới khi CONTRACT chốt mục 🔴 và IMPLEMENTATION_PLAN được PM duyệt. Migration tiếp theo **114**, nhánh `feat/crm-cskh`.
