# HANDOFF — Tách site "OS" và "FS" (site-selector) + Báo cáo hạ tầng

> Bản plan kỹ thuật + kiến trúc + phân quyền để **stakeholder duyệt** trước khi build.
> Nguyên tắc: build/test trên localhost, additive, KHÔNG phá luồng OS đang chạy production.
> Kèm mục "Hạ tầng & DevOps" (server/Supabase/Coolify/Docker) để stakeholder nắm bức tranh vận hành.
> Ngày: 2026-07-09 · Trạng thái FS: **ĐÃ GO-LIVE prod** (commit e261f9d).

---

## 1. Mục tiêu & bối cảnh

Module **FS · Quản lý sản phẩm** đã go-live. Hiện việc "cô lập FS khỏi OS" (F5) làm **theo role +
store_type**: một `staff` của cửa hàng FS chỉ thấy đúng 1 tab "Quản lý sản phẩm", bị redirect khỏi
mọi route OS. Cơ chế này đủ cho giai đoạn 1 nhưng **chưa phải "site" thực sự**.

Stakeholder muốn nâng lên **mô hình 2 SITE tách bạch**:
- **Site OS** = toàn bộ app hiện tại (Tasks, Doanh số/KPI, Toa thuốc, Tồn kho, Bảng tin, Người dùng,
  Cửa hàng, Nhật ký…) cho hệ thống cửa hàng OS.
- **Site FS** = module FS (hiện tại: "Quản lý sản phẩm"; về sau mở rộng).

**Trải nghiệm mong muốn** (ảnh mẫu `docs/UI_site_OS_FS_request_stakeholder.jpg`):
- Account **chỉ 1 site** → login xong **vào thẳng** site của mình (không hỏi).
- Account có **cả 2 site** (quyền cao) → login xong thấy **màn chọn site** (OS / FS) → chọn → vào; có
  thể **đổi site** bất kỳ lúc nào.
- Admin/super → được **phân quyền** site nào được vào.

**Vì sao làm bây giờ:** FS sẽ áp dụng cho nhiều FS hơn; cần một "khung site" sạch để mở rộng, thay vì
tiếp tục chắp vá theo role. Đây là refactor **tầng điều hướng/phiên (routing/session)** — KHÔNG đổi
nghiệp vụ OS hay FS.

---

## 2. Hiện trạng đã có (F5 — nền tảng để nâng cấp)

- `stores.store_type` = `'os' | 'fs'` (mig 076); mọi OS picker/matcher đã filter `store_type='os'`.
- Guard cô lập: `lib/fs/isolation.ts` → `isFsStoreUser()` / `redirectIfFsStaff()` (dùng store đã
  embed sẵn trong `getSessionProfile` → **query-free**; fallback 1 PK lookup).
- Route guard đã gắn ở các trang OS staff-reachable (tasks/targets/prescriptions/announcements/inventory).
- Nav: `layout.tsx` tính `isFsStore` (query-free) → `BottomNav`/`Sidebar` thu về **1 item FS** cho user FS.
- FS module staff-only (mig 081); claim lifecycle + release UI (F5.1).

→ F5b **tổng quát hoá** cơ chế role-based này thành **site-based** + thêm **màn chọn site** cho account 2 quyền.

---

## 3. Kiến trúc "Site" đề xuất

### 3.1 Xác định site được phép (allowed sites) — theo role + store_type
| Account | OS site | FS site | Sau login |
|---|---|---|---|
| Super admin | ✅ | ✅ | **Màn chọn site** |
| Admin dept **Policy** (quản lý FS) | ✅ | ✅ | **Màn chọn site** |
| Admin (phòng khác) / SM | ✅ | ✖ | Vào thẳng OS |
| Staff / Store_manager của **OS store** | ✅ | ✖ | Vào thẳng OS |
| Staff của **FS store** (operator) | ✖ | ✅ | Vào thẳng FS |
| Store_manager của **FS store** | ✖ | ✅ | Vào thẳng FS (màn no-access hiện có) |

- **Chỉ super admin + Policy admin có cả 2 site** → nhóm duy nhất thấy màn chọn. Mọi account khác 1 site → vào thẳng.
- Allowed sites suy ra **query-free** từ `getSessionProfile` (role + `stores.store_type` đã embed) — không thêm tải DB.

### 3.2 Site hiện hành (current site) + ghi nhớ
- Lưu lựa chọn trong **cookie** `circa_site = os|fs` (đọc được ở server component; không chứa dữ liệu nhạy cảm).
- Quy tắc resolve mỗi request:
  1. Nếu allowed sites chỉ 1 → current site = site đó (bỏ qua cookie).
  2. Nếu 2 site: current site = cookie (nếu hợp lệ ∈ allowed); nếu cookie thiếu/không hợp lệ → **redirect `/select-site`**.
- **Đổi site:** nút "Đổi site" trên nav (chỉ hiện với account 2 site) → set lại cookie → về home của site mới.

### 3.3 Điều hướng & guard (tổng quát hoá F5)
- Chuẩn hoá "route thuộc site nào": tiền tố `/fs/*` = FS; còn lại (tasks/targets/…) = OS.
- Guard 1 chiều mỗi bên (mở rộng `redirectIfFsStaff` thành `enforceSite`):
  - current site = **fs** mà vào route OS → redirect `/fs/products`.
  - current site = **os** mà vào `/fs/*` → redirect OS home.
- Nav render theo current site: site OS = nav OS như cũ; site FS = chỉ "Quản lý sản phẩm" (đã có).
- **Không middleware nặng:** determination nằm ở layout (đã có `getSessionProfile` memoized) + helper site-context → **không thêm query**; cookie chỉ là 1 lần đọc.

### 3.4 Màn chọn site `/select-site` (mới)
- Chỉ cho account 2 site; 1-site truy cập → redirect thẳng vào site của họ.
- 2 thẻ lớn: **OS (Circa Tasks)** + **FS (Quản lý sản phẩm)** — bấm → set cookie → vào home site.
- Theo brand Circa (coral, card bo tròn) — mẫu `UI_site_OS_FS_request_stakeholder.jpg`.

---

## 4. Phân quyền & bảo mật (giữ nguyên nền RLS)
- **KHÔNG đổi RLS/DB.** Site chỉ là lớp điều hướng/nav phía app. Quyền dữ liệu vẫn do RLS + guard server-action
  hiện có quyết định (isolation FS đã có ở DB/route).
- Cookie site **không cấp quyền** — chỉ chọn "khung hiển thị". Kể cả sửa cookie tay, RLS + route guard vẫn chặn
  (vd FS staff set cookie=os → route OS vẫn redirect vì allowed sites không có OS).
- Allowed sites tính server-side từ profile mỗi request (không tin cookie cho việc cấp quyền).

---

## 5. Kế hoạch build (đề xuất 2 phase, mỗi phase commit/push từng batch, KHÔNG deploy tới khi QA)

**F5b-1 — Site infrastructure + selector (lõi):**
1. `lib/site/context.ts`: `getAllowedSites(profile)` (query-free) + `resolveCurrentSite(profile, cookie)`.
2. `enforceSite(site, pathname)` — tổng quát hoá `redirectIfFsStaff`; thay các guard OS hiện tại.
3. `/select-site` page + server action `chooseSite(site)` (set cookie, validate ∈ allowed).
4. `layout.tsx`: resolve current site → render nav theo site + nút "Đổi site" (account 2 site).
5. Cập nhật login-landing/`/` → điều hướng theo allowed sites (1 → thẳng; 2 → /select-site nếu chưa có cookie).

**F5b-2 — Polish + mở rộng (sau khi F5b-1 QA):**
- Đồng bộ UI 2 site, ghi nhớ site cuối, (tuỳ chọn) badge/nhãn site trên header.
- Chuẩn bị khung để thêm feature FS mới vào site FS mà không đụng OS.

**Không migration DB** cho F5b-1 (thuần routing/session/UI). Không cron/env mới.

---

## 6. Tác động hiệu năng (đánh giá dựa trên số liệu thực đo)
- Site resolution = đọc 1 cookie + suy ra từ `getSessionProfile` (đã memoized, có embed store) → **0 query thêm**.
- Không thêm bảng, không thêm RLS, không thêm cron.
- DB hiện **cực nhẹ** (mục 7) → dư địa rất lớn; F5b không tạo tải đáng kể.
- Rủi ro chính = **điều hướng sai** (account 2 site kẹt vòng redirect) → mitigate bằng: allowed-sites tính từ
  profile (không tin cookie), fallback `/select-site`, QA ma trận đủ role.

---

## 7. 📊 HẠ TẦNG & DEVOPS — số liệu vận hành hiện tại (cho stakeholder nắm)

**Nền tảng:** Self-hosted Supabase + app Next.js trên **Coolify 4.1.1**, host **LXC/Proxmox** (CT 8 core / 16GB;
docker báo 32GB là mức của host). Ảnh dùng **Google Cloud Storage** (bucket `duocsi-circa-vn`) — ảnh KHÔNG đi
qua app server, không phình DB.

**Sức khoẻ (đo 2026-07-08/09):**
| Hạng mục | Số đo | Đánh giá |
|---|---|---|
| App Circa (container) | RAM 119MB · CPU ~0% · restart 0 | ✅ Rất khoẻ |
| Latency app nội bộ | TTFB 12–24ms | ✅ Rất nhanh |
| Latency qua Cloudflare | TTFB ~0.5–0.7s | ✅ OK cho SSR |
| Postgres cache hit | table 99.93% · index 99.94% | ✅ Xuất sắc |
| Connections | 46 (2 active / 36 idle / **0 idle-in-tx**) | ✅ Không rò rỉ |
| DB size | Bảng lớn nhất **10MB** (auth audit); tổng ~vài chục MB | ✅ Tí hon |
| Dead tuples / autovacuum | Tối thiểu, autovacuum chạy đều | ✅ Không bloat |
| Query app | Tối đa ~17ms (tasks list) | ✅ Không query chậm |
| Container crash | restarts = 0 toàn bộ | ✅ Ổn định |

**2 điểm cần lưu ý (không chặn F5b):**
1. **🔴 Kong RAM leak** — `supabase-kong` ~9.2GB RAM (máy 16GB). Nghi root cause: nginx `worker_processes auto`
   trong LXC đọc CPU host (80) → đẻ thừa worker. Đã config `KONG_NGINX_MAIN_WORKER_PROCESSES=4` (đang verify sau
   redeploy 2–3 ngày). Lưới an toàn: cron restart Kong hàng tuần 3–4h sáng (Kong stateless, restart ~vài giây).
   *Đây là vấn đề hạ tầng THỰC SỰ DUY NHẤT hiện tại; không liên quan code app/FS.*
2. **🟡 Realtime đã TẮT** (trước chiếm ~96% tải DB) — đúng chủ trương, app không dùng realtime. Logical-replication
   còn lại là của **Logflare/Analytics** (Studio Logs), giữ ~185MB WAL, ~3% CPU — lành mạnh; **tuỳ chọn** tắt
   analytics nếu không dùng Studio Logs để cắt thêm ~4–5% query volume.

**Kết luận hạ tầng:** App + DB + latency đều xanh, dư địa tải rất lớn ở scale hiện tại. FS module (ảnh ở GCS, DB chỉ
metadata) **không làm nặng hệ thống**. Việc tách site OS/FS là thay đổi tầng điều hướng, **không thêm tải DB**.

---

## 8. Câu hỏi cần chốt trước khi build
1. **Account có cả 2 site** (thấy màn chọn) = **super admin + admin dept Policy** — đúng chưa? Có account nào khác
   cần vào được cả OS lẫn FS không?
2. **Ghi nhớ site:** dùng cookie nhớ site cuối + nút "Đổi site" (đề xuất) — hay mỗi lần login đều hỏi lại?
3. **Phạm vi site FS phase này:** chỉ gồm "Quản lý sản phẩm" (đúng hiện trạng) — đúng chưa?
4. Có muốn hiển thị **nhãn site hiện hành** trên header (vd "Site: FS") để đỡ nhầm khi đổi qua lại không?

---

## 9. Ngoài phạm vi (làm sau, không thuộc F5b)
- Chuyển FS thành hệ dữ liệu hoàn toàn tách biệt (đã có `fs_*` tables riêng; chưa cần tách DB vật lý).
- Thêm feature FS mới (ngoài "Quản lý sản phẩm").
- Backlog vận hành: cron 24h quét orphan `fs-products/` trên GCS (trước khi mở rộng nhiều FS).

> Sau khi stakeholder duyệt tài liệu này + trả lời mục 8 → dev-team build F5b-1 (localhost, commit/push từng
> batch để audit) → QA ma trận role → deploy 1 lần. Không đụng gì tới lúc đó.
