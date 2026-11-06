# CMS theo sản phẩm — kế hoạch triển khai (PR / batch), AC và nghiệm thu

> Nghiệp vụ: `docs/plan-cms-product-commission.md` · Kỹ thuật: `docs/cms/SPEC.md` · Quyết định: `docs/cms/DECISIONS.md` · UI: `docs/ui/UI_V2_CMS.md`.
> Nguồn: spec r2 §4–§5 + review PM intake 01/11 + intake Dev `planning/reports/2026-11-01-cms-r2-dev-intake.md` §4.

> Quy ước đường dẫn: `lib/…`, `app/…`, `components/…`, `e2e/…`, `scripts/…`, `public/…` nằm trong `webapp/`; `supabase/…`, `docs/…` ở gốc repo. Nhãn **[Dev đề xuất]** = chi tiết Dev thêm để thực hiện r2, chờ PM audit.

## 1. Cách làm

- **Nhánh:** `feat/cms` lấy từ `main` `01a9185`; worktree ngoài repo `C:/circa-cms`, `npm ci` riêng (không junction `node_modules`). P2-a làm trên nhánh con `feat/cms-p2` (từ `feat/cms`), để bản phát hành P1 không mang engine (**[PM H11]** đồng ý về kỹ thuật).
- **Trước khi đóng baseline mỗi batch có SQL** (r2 §4.1): kiểm lại Git (`main` / `origin/main` / nhánh) và `app_migrations` thực tế bằng wrapper chỉ đọc; ghi kết quả vào report.
- **"PR" = batch commit trên nhánh** kèm report `planning/reports/<ngày>-cms-<batch>.md` để PM audit; không mở GitHub Pull Request (H11). Vòng audit `r1`, `r1.1`…
- **Commit message:** `feat|fix|test|docs(cms): <batch> — <việc>`, không dòng Co-Authored-By.
- **Quyền Git / prod:** mỗi commit, push, merge, DDL prod, deploy, bật cờ cần lệnh operator riêng; PM GO không phải quyền Git.
- **`main` luôn deploy được:** chỉ merge `feat/cms` → `main` (`--no-ff`) khi bộ P1 xong và PM GO phát hành.
- Không mang thay đổi ngoài CMS (ví dụ file 119a) sang nhánh; `planning/` không vào nhánh.

## 2. Danh sách PR

| PR | Phạm vi chính | File chính (dự kiến) | Điều kiện nghiệm thu |
|---|---|---|---|
| **PR-0** | Chuyển r2 thành bộ tài liệu repo; DECISIONS Q-206…Q-213; UI CMS r1 + redline r2; mockup + mẫu r1 | `docs/plan-cms-product-commission.md`, `docs/cms/{SPEC,IMPLEMENTATION_PLAN,DECISIONS}.md`, `docs/ui/UI_V2_CMS.md`, `docs/ui/mockups/cms/*`, `docs/cms/samples/*` | PM đối chiếu khớp r2 + review intake; không đổi nghiệp vụ |
| **P0-a** | Hợp đồng nguồn, adapter JSON fixture và BigQuery, mapping email, báo cáo chất lượng | `lib/cms/source/*`, `lib/cms/mapping.ts`, `lib/cms/quality.ts`, `scripts/cms-source-report.mjs`, `e2e/cms-source*.spec.ts`, fixture giả | Mapping đúng, không dùng seller/phone, không có dữ liệu thật trong fixture Git |
| **P1-a** | Migration 120: nền CMS, quyền, flags, helper cấu hình và cron sản phẩm | `supabase/migrations/120_cms_foundation.sql` + rollback, `lib/cms/flags.ts`, `lib/cms/config.ts`, `app/api/cron/pull-cms-products/route.ts`, `.env.example` | PGlite + PG15, ACL đúng, flag OFF không query nguồn |
| **P1-b** | Migration 121: import/activation RPC; parser, preview, commit, file lỗi, template 9 cột | `121_cms_import_activation.sql` + rollback, `lib/cms/import/*`, `app/api/cms/import/*`, `app/actions/cmsPrograms.ts`, `public/templates/Circa_Import_CMS.xlsx` | Partial theo nhóm, reparse, atomic, chống race và commit lặp |
| **P1-c** | A1/A2/A3 phần danh mục; tab CMS; loading/error/empty | `app/(dashboard)/targets/campaigns/cms/**`, `components/cms/admin/*`, `components/kpi/CampaignsTabs.tsx`, fixture `/ui-catalog/cms-v2` | Đúng trạng thái, đúng quyền, fixture bất khả ghi |
| **P1-d** | D1/D2 danh mục; QLCH đọc danh mục; mobile | `app/(dashboard)/targets/page.tsx` (nhánh `tab=cms`), `app/(dashboard)/targets/cms/products/[programProductId]/*`, `components/cms/staff/*` | 360/390 light/dark, không lộ số thực tế chưa bật |
| **P2-a** | Engine thuần, quy đổi, gate, lũy tiến, trần, phân bổ dòng | `lib/cms/engine/*`, `e2e/cms-engine.spec.ts` (nhánh `feat/cms-p2`) | Đúng từng số trong bảng AC và các ca số lẻ |
| **P2-b** (I1 + I2) | Migration 122: snapshot đầu vào / kết quả theo run, stage → seal → publish atomic qua pointer, RPC đọc theo phạm vi hiện tại; lõi đồng bộ bán + cron + script operator; cổng Q-206 | `supabase/migrations/122_cms_results.sql` + rollback, `lib/cms/{resultStage,salesSync,cronSales,releaseGate}.ts`, `lib/cms/server/salesSyncDeps.ts`, `app/api/cron/sync-cms-sales/route.ts`, `scripts/cms-sales-sync.mjs`, `scripts/qa-cms-122.mjs`, `e2e/cms-{122-pglite,sales-sync}.spec.ts` | **Giao 02/11** (kế hoạch tích hợp PM — `planning/research/cms-consolidated-implementation-plan-2026-11-02.md` §4–§5). PGlite + PG15 thật (race / quy mô), ACL 21 hàm, nguồn giả; chương trình thật chưa công bố tiền khi Q-206 HOLD |
| **P2-c** (I3) | D1/D2 có số, D3, A1/A3 kết quả, QLCH/SM, export XLSX cùng `run_id`; log mã cố định ở `server/{catalog,staffCatalog}.ts` (PM 03/11 §3.2) | `lib/cms/{resultUi,queryLog,exportResults,fixturesResults}.ts`, `lib/cms/server/resultLoad.ts`, `components/cms/{staff,admin}/**`, `app/(dashboard)/targets/cms/history/*`, `app/api/export/cms/route.ts`, `/ui-catalog/cms-v2/*?p2=`, `e2e/{cms-p2c-unit,ui-v2-cms-p2c}.spec.ts` | **Giao 02/11** (kế hoạch tích hợp PM §6) — r1 Dev 03/11 chờ PM audit (SPEC §8.1 "Hiện thực P2-c"); fixture theo DTO 122, UI / XLSX / lịch sử lệch 0đ; cờ earnings OFF ⇒ P1 nguyên trạng |
| P3a (I5) | Chốt kỳ + payout: migration 123 (đóng băng run, payout theo dược sĩ có định danh snapshot, policy DB, guard dữ liệu run / cấu hình / TRUNCATE / chỉ RPC ghi), action preview → xác nhận (`app/actions/cmsPayouts.ts`, lõi `lib/cms/lockAction.ts`), A3 khối Chốt kỳ / Số đã chốt, XLSX chi trả `GET /api/export/cms/payout`, VERIFY phase 123, công cụ QA chốt | `supabase/migrations/123_cms_payouts.sql` + rollback, `lib/cms/{payoutView,lockAction,exportPayouts}.ts`, `lib/cms/server/payouts.ts`, `components/cms/admin/Cms{Lock,Payout}Panel.tsx`, `scripts/qa-cms-123.mjs`, `e2e/cms-p3a-unit.spec.ts` | Local, cờ `CMS_LOCK_ENABLED` OFF. Chốt **thật** chặn tới khi Q-206 + Q-213 + Q-216 + hợp đồng nguồn đầy đủ + P3b (CMS-Q7) chốt; QA chốt `is_test` là vĩnh viễn (H8) |
| P3b | Báo cáo phát sinh sau chốt (CMS-Q7) | — | Thiết kế chờ hợp đồng Q-206 |

Phát hành gộp (kế hoạch PM §10): không deploy theo từng batch; một candidate tích hợp + một cửa sổ migration 121 → 122 → 123 (P3a) → migration mở cổng Q-206 (số chốt khi gom candidate) → QA → deploy → smoke.

Phụ thuộc: PR-0 → (P0-a ∥ P1-a, sau khi khóa interface nguồn) → P1-b → (P1-c ∥ P1-d). P2-a độc lập khi dùng đúng contract đã chốt; P2-b phụ thuộc engine và nền DB. Không còn migration hoặc UI `users.employee_code` trong P0-a.

## 3. AC chi tiết theo batch

### 3.1. P0-a — nguồn và mapping

- Contract kiểu: số là chuỗi thập phân ≤ 9 chữ số sau dấu chấm; timestamp UTC micro giây (SQL `FORMAT_TIMESTAMP(... %E6S ...)`); ProductID text số nguyên canonical.
- Adapter BigQuery: tên bảng qua env, validate; query có tham số (kỳ, danh sách ProductID); đọc đủ trang; trần 200.000 dòng ⇒ held; thiếu trường bắt buộc ⇒ từ chối; không fallback JSON.
- Adapter JSON fixture chỉ dùng trong test/QA, không thể bật ở production.
- Mapping email: trim + lowercase; khớp đúng 1 user; staff thuộc OS active; không seller_code, không phone. **[Dev đề xuất]** mã lý do khi không gán: `NO_EMAIL`, `NOT_FOUND`, `MULTIPLE`, `SHARED_ACCOUNT` (`store_manager`), `NOT_STAFF` (admin/SM), `STORE_NOT_ELIGIBLE` (FS / inactive / không store).
- Chất lượng: trùng `order_line_id`, số/timestamp sai, thiếu trang, rỗng bất thường, chưa gán > 20% ⇒ held; thiếu `base_quantity` ⇒ "Chưa quy đổi đơn vị".
- Script đo chỉ đọc (khi nguồn đọc được bằng SA): số dòng, bytes, thời gian, % chưa gán, theo kỳ mẫu. Không ghi DB, không log email đầy đủ.
- Fixture trong Git: định danh giả nhất quán, không email/đơn/response thật.

### 3.2. P1-a — migration 120

- Header theo mẫu 112/113: chạy sau 119 (số), contract, idempotency, ROLLBACK kèm `DELETE FROM app_migrations`; `BEGIN…COMMIT`; preflight max version số = 119 (`CASE WHEN version ~ '^[0-9]+$'`), chưa có `120`; marker cuối; block VERIFY.
- Bảng §3.1 SPEC; CHECK ràng buộc; `is_test`; `config_version`.
- RLS + helper SECDEF STABLE `search_path=public`, không tham chiếu vòng; ma trận đọc §3.1 SPEC; marker QA.
- REVOKE đích danh PUBLIC/anon/authenticated trên mọi bảng + hàm mới; GRANT đúng ma trận; VERIFY `has_function_privilege` / `has_table_privilege`.
- RPC upsert Product Master chỉ service role; fail-closed: nguồn lỗi ⇒ không ghi, `cms_sync_runs` error. **[Dev đề xuất]** áp quy tắc "rỗng bất thường sau snapshot có dữ liệu ⇒ held" của dòng bán (r2 §3.6) cho Product Master: kết quả rỗng khi cache đã có dữ liệu ⇒ held, giữ bản cũ.
- RLS: chương trình `is_test` chỉ hiện với user có marker QA còn hạn — **kể cả super admin** (H9); test âm cho super admin không marker.
- Cron `pull-cms-products`: `Bearer CRON_SECRET`; cờ `CMS_PROGRAM_ENABLED` OFF ⇒ trả sớm, không query BigQuery; env thiếu ⇒ lỗi cấu hình.
- Bootstrap operator-only `scripts/cms-bootstrap-products.mjs` theo SPEC §9: dry-run mặc định, `--confirm` mới ghi; cùng core/validation/RPC với cron. Cho phép nạp cache trước khi bật cờ production; không thêm endpoint hoặc query param bỏ qua cờ. Test dry-run không ghi và public cron OFF không query.
- Test: PGlite (logic) + PostgreSQL 15 thật (RLS theo vai, ACL với default privileges như prod, rollback chạy được).

### 3.3. P1-b — import và kích hoạt (migration 121)

Ca bắt buộc (r2 §5.1):

- File hợp lệ với ba loại gate.
- Thiếu hai cột quy cách mới (mẫu r1 ⇒ báo thiếu cột).
- Cùng ProductID khác target, đơn vị, quy cách hoặc tư vấn.
- Bậc hở, chồng, cận sai, cận vô hạn ở giữa.
- Bậc cuối hữu hạn.
- Hai nhóm catalog khác target.
- Một nhóm lỗi, nhóm khác vẫn nạp.
- Nạp lại draft; sửa active chưa bắt đầu.
- Từ ngày bắt đầu, sửa sản phẩm cũ bị chặn.
- Bổ sung ProductID mới tính hồi tố.
- Preview rồi cấu hình/nguồn thay đổi ⇒ xung đột, yêu cầu preview lại.
- Hai request kích hoạt/import cùng ProductID giao ngày (PG15 thật, 2 kết nối) ⇒ đúng 1 thành công.
- Commit lặp không tạo thêm dữ liệu.
- File lỗi giữ đủ các dòng của nhóm bị loại.

Bổ sung từ review PM:

- Parser: ProductID numeric nguyên an toàn / text chữ số; từ chối phân số, text số mũ, ô mất độ chính xác; tiền text có dấu phân cách ⇒ lỗi; ô numeric có format nghìn ⇒ hợp lệ; ô công thức trong cột hợp đồng ⇒ lỗi; công thức cột thừa bỏ qua; `base_quantity_CMS` > 9 chữ số thập phân ⇒ lỗi.
- Hành động theo trạng thái đúng bảng SPEC §4.7 (sửa thông tin / nạp lại chỉ khi nháp hoặc đã kích hoạt chưa bắt đầu; đã bắt đầu chỉ thêm SP; đã chốt bất biến); mỗi ô "Không" có test bị từ chối.
- Kích hoạt khi ngày bắt đầu đã qua ⇒ cho phép, kiểm lại ngày/trạng thái trong transaction (H7).
- Namespace `is_test` nhất quán ở preview/commit/activation/sửa, kể cả đồng thời; client không đổi được `is_test` (H9).
- Không có action/RPC xóa, hủy, quay về nháp (H8).
- Giới hạn 5 MiB / 2.000 dòng; Route Handler kiểm cờ → quyền → byte → parse.
- Staff/SM/QLCH gọi trực tiếp route import / action kích hoạt ⇒ bị từ chối.

### 3.4. P1-c / P1-d — UI danh mục

- A1/A2/A3 + sửa thông tin `/targets/campaigns/cms/[id]/edit` (super admin quản lý; SM chỉ đọc theo `sm_store_assignments`, thấy Sắp diễn ra / Đang chạy / Chờ chốt kỳ, không thấy nháp/test — H6).
- Import hai bước theo UI U16: kiểm tra file (preview) → xác nhận ghi (nhãn theo trạng thái) → kích hoạt là hành động riêng.
- P1 không render cột/ô **kết quả thực tế** ở A1/A3 (CMS đã kiếm, GMV/SL bán, tiến độ/lượt/người đạt; không ô 0 hoặc thanh rỗng). Vẫn hiển thị số chương trình/SP, target, bậc, mức CMS/đơn vị, hệ số quy đổi và thống kê import. Thống kê thật A1 loại chương trình QA.
- User thật (kể cả super admin không marker) không thấy chương trình QA qua route, RPC, RLS, export (H9).
- D1/D2 cho staff/QLCH: Sắp diễn ra (ghi ngày bắt đầu) và Đang chạy trong phạm vi nhà thuốc hiện tại (H5); thang bậc `đồng/unit_CMS`, target, loại gate, tư vấn; không có số thực tế, không 0 giả.
- Tab CMS độc lập với cờ Affiliate; `tab=cms` rẽ trước query KPI; cờ OFF giữ hành vi KPI cũ (test khóa 2 chiều).
- Ảnh: Next Image + `remotePatterns` `cdn-gcs.thuocsi.vn/thuocsi-live/images/**`; URL khác ⇒ ảnh dự phòng.
- FS không truy cập được CMS; admin thường không có quyền CMS.
- Light/dark, 360/390/1280/1440; loading, empty, error, long text; touch ≥ 44px, input 16px mobile; `data-ui-v2="page"`.
- Fixture `/ui-catalog/cms-v2?fx=` dùng component thật, boundary chặn action/export, trap request ghi: 0 request ghi/export thật.
- Không đổi BottomNav.

### 3.5. P2-a — engine

Ca bắt buộc (r2 §5.2):

- Toàn bộ bảng số §2.9 nghiệp vụ (Q 9/10/11/14/20/25) + bảng CMS-Q-220 (Q 0/1/8/9/10/18/19/20/49/50/51/99/100/101/100.000; không trần — thay ca "trần 50" của Q-210a).
- Gate thiếu 1đ, bằng target và vượt target.
- Gate danh mục cộng nhiều sản phẩm.
- Không target.
- Hai lần nửa hộp bằng một hộp.
- Cộng nhiều dòng lẻ rồi mới floor.
- Một dòng đi qua hai bậc.
- Trên mốc bậc cuối cũ (50 / 100) vẫn cộng mức bậc cuối; cấu hình bậc cuối hữu hạn ⇒ `FINITE_LAST_TIER` (CMS-Q-220).
- Tổng tiền dòng bằng tổng dược sĩ × sản phẩm.
- Cùng đầu vào, khác thứ tự nhận từ nguồn vẫn cho kết quả giống nhau.
- Timestamp microsecond và tie-break bằng item ID.
- Tính lại sau bổ sung sản phẩm hồi tố.
- Giá trị 0 hợp lệ được phân biệt với thiếu dữ liệu.
- `Q = floor(max(0, B) / K)` không âm; `K` thập phân 9 chữ số chia chính xác; vượt precision ⇒ lỗi.

Fixture điều chỉnh âm chỉ chứng minh số học trên sự kiện đã chuẩn hóa; không thay thế việc chốt quy thuộc trả hàng (Q-206).

### 3.6. Tích hợp, quyền (áp dụng dần theo batch; P2-b/c đã giao 02/11 — ma trận chi tiết ở kế hoạch PM §9.2)

- Staff A không đọc được số của staff B.
- QLCH không có payout cá nhân trên tài khoản dùng chung.
- SM/QLCH không xem được người ngoài phạm vi hiện tại.
- Staff gọi trực tiếp import, kích hoạt, sync hoặc chốt bị từ chối.
- Authenticated không đọc được raw sales hoặc staging chưa công bố.
- FS không truy cập được CMS.
- Không trộn chương trình QA vào cron hoặc báo cáo thật; user thật (kể cả super admin không marker) không thấy chương trình QA qua route, RPC, RLS, export.
- Sync lỗi giữa stage và publish giữ nguyên snapshot trước.
- Cấu hình đổi trong lúc tính làm run cũ bị từ chối.
- Dữ liệu vượt một trang Supabase/BigQuery không bị cắt.
- Export quá giới hạn phải báo lỗi, không xuất file thiếu.
- A3, D3 và export cùng run có tổng lệch 0đ.
- Cờ CMS OFF không làm thay đổi query/luồng KPI hiện có.

Playwright là runner duy nhất. DB cần cả PGlite và PostgreSQL thật cho RLS, ACL và tranh chấp transaction.

## 4. Kỷ luật migration

- 120: yêu cầu nền số 119; marker chữ (`118a`, `119a`) bỏ qua theo quy tắc `CASE WHEN version ~ '^[0-9]+$'`.
- 121: yêu cầu 120.
- 122: yêu cầu 121.
- Số cho P3 được dành khi P3 được duyệt. P-K1 (trước giữ 120) đánh số lại khi mở lại.
- Mỗi migration có transaction, preflight, marker, VERIFY và rollback tương ứng (`supabase/migrations/rollback/`).
- Không định nghĩa lại allowlist super admin (từ 113 hoặc bản cũ); kiểm helper app và SQL hiện hành trước rollout.
- Rollback trước khi có dữ liệu thật có thể dùng file đã kiểm thử. Sau khi có chương trình hoặc kết quả thật, ưu tiên tắt cờ và xử lý tiến; không tự drop bảng chứa dữ liệu nghiệp vụ.

## 5. Gate mỗi batch và báo cáo Dev

```text
tsc → spec liên quan → full Playwright → build → git diff --check
```

Thêm cho batch có SQL: PGlite + PG15 thật (RLS, ACL ma trận, race), db-reviewer; batch chạm quyền/PII: security-reviewer; trước khi gửi PM: pm-auditor. Reviewer sub-agent chỉ đọc source/diff + DB kiểm thử, cấm gọi prod. Full gate cần ≥ 4 GB RAM trống.

Báo cáo Dev phải có:

- Base/head SHA và phạm vi.
- AC đã đạt, chưa đạt.
- Kết quả gate và giải thích mọi skip/fail.
- Kết quả kiểm ACL nếu có SQL.
- Bằng chứng transaction/race nếu có ghi nhạy cảm.
- Bằng chứng fixture không ghi và ảnh chỉ dùng dữ liệu giả.
- Việc operator phải làm về migration, env, cron.
- Rủi ro và điều kiện GO/NO-GO.

Dữ liệu mẫu thật, email nhân viên và response POS không được commit. Fixture dùng định danh giả nhất quán.

## 6. Rollout P1 (phát hành đầu tiên — chỉ danh mục)

| Bước | Ai | Việc |
|---|---|---|
| 1 | Dev → PM | Gate P1-a…P1-d đạt, PM audit GO phát hành; Dev kiểm lại Git + `app_migrations` thực tế (chỉ đọc) trước khi đóng baseline |
| 2 | Operator (lệnh) | Merge `feat/cms` → `main` (`--no-ff`), push; deploy Coolify với cờ OFF |
| 3 | Operator | Chạy 120 rồi 121 trong Studio (nguyên file); Dev VERIFY chỉ đọc (marker, ACL ma trận, RLS) |
| 4 | Operator / BI | Cung cấp tên nguồn Product Master trong `buymed_tech` như đã bảo đảm; cấu hình và kiểm chứng đọc bằng SA ngay tại rollout, không yêu cầu gửi bảng/query ở các vòng code trước đó |
| 5 | Operator | Env `CMS_BQ_PRODUCTS_TABLE`; tạo Coolify Scheduled Task `pull-cms-products` `30 22 * * *` (UTC) |
| 6 | Dev / operator | Operator chạy bootstrap Product Master (`--confirm`, SPEC §9), cờ production vẫn OFF; QA import/RLS tại localhost có cờ local phù hợp và safety gate, dùng chương trình `is_test` + marker; không mong public route production đang OFF thực hiện sync/import |
| 7 | Operator | Bật `CMS_PROGRAM_ENABLED`, reload env |
| 8 | Dev / operator | Smoke super admin, SM, QLCH, staff và FS |

Thứ tự theo r2 §4.6 (deploy cờ OFF → migration → đồng bộ nguồn thật); gate nguồn (bước 4) đứng ngay trước đồng bộ, không chặn merge/deploy cờ OFF.

Rollback P1: tắt `CMS_PROGRAM_ENABLED` (không cần rollback app/DB khi chưa có dữ liệu thật hỏng); rollback SQL 121/120 chỉ trước khi có chương trình thật.

## 7. Rủi ro đã biết

| Rủi ro | Ảnh hưởng | Xử lý |
|---|---|---|
| SA app 403 trên nguồn thô (01/11) | Chặn phát hành P1 (Product Master) và số đo P0 | Operator/BI cung cấp nguồn trong dataset SA được phép; không nới quyền SA trong batch |
| Quy mô Product Master chưa biết | Thời gian/bytes cron P1 | Đo ở P0 khi có nguồn; pull đầy đủ, đọc đủ trang |
| Điều kiện `item.created_date = o.created_date` | Có thể mất dòng thêm muộn | Kiểm chứng trước feed production (P0/P2) |
| Q-206 chưa chốt | Chặn bật tiền thật | Engine chỉ số học sự kiện đã chuẩn hóa; không adapter trả hàng |
| RAM máy Dev thấp | Full gate dừng giữa chừng | Cần ≥ 4 GB trống trước full Playwright / build |
| `/targets/page.tsx` lớn (842 dòng) | Rẽ nhánh `tab=cms` có thể kéo theo query KPI | Rẽ sớm sau auth/FS; test cờ OFF giữ query cũ |
