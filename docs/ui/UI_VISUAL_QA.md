# UI Visual QA Matrix — r1

> Gate BẮT BUỘC cho mỗi phase/route trước khi sang route kế.

## Personas (2 — ĐÃ KHÓA)
| Persona | Account | Surface chính |
|---|---|---|
| Super admin | `hoangvudn96@gmail.com` | Desktop 1366–1920 |
| Staff OS | `duocsi2@gmail.com` | Mobile 360–430 |

**FS staff process = NGOÀI SCOPE chương trình UI** (đã chốt r1 — 2 persona trên không đại diện được camera/upload FS). Admin FS surfaces (/fs/products + [id]) QA bằng super admin. Nếu sau này stakeholder duyệt ngoại lệ persona FS thì mở wave riêng — không thuộc chương trình này.

**Quy ước bắt buộc:** đổi account/role = Đăng xuất rồi login lại HOẶC cửa sổ ẩn danh riêng. Restart dev server KHÔNG xóa Supabase auth cookie. Credentials chỉ truyền qua env local — không ghi vào file tracked/test output; đổi lại password super tạm sau khi tạo xong baseline.

## Viewport × Theme
- **Automated gate = CHROMIUM** (r1): `360` (mobile-360) · `390` (mobile-390) · `1366` (desktop-chromium) — × `light` + `dark` (theme loop deterministic qua `localStorage.theme`, tên snapshot chứa theme).
- **WebKit = opt-in `@webkit`, NGOÀI gate** (không auth được qua http://localhost — xem mục Baseline). **Safari thật = manual gate** trên iPhone (https prod) mỗi wave.
- **Manual spot-check** (mỗi wave, không chụp máy): `430 · 768 · 1024 · 1440 · 1920` × light/dark — DevTools responsive, checklist dưới.

## Checklist từng route
- [ ] tsc + production build pass; KHÔNG migration mới; không đổi ENV
- [ ] 2 persona login + đi hết luồng chính của route (regression)
- [ ] Loading / error / empty / long-text / nhiều cột / pagination đều render đúng
- [ ] Không horizontal overflow ngoài vùng bảng (body không cuộn ngang)
- [ ] Bottom nav không che nội dung (pb clearance giữ nguyên)
- [ ] Focus keyboard nhìn thấy; contrast pastel dùng đúng token đã đo; touch ≥44px
- [ ] Mobile input font-size THẬT ≥16px (computed style, không tin class)
- [ ] Số query mỗi page KHÔNG tăng; không thêm profile fetch trùng
- [ ] Playwright screenshot diff vs baseline pass (3 project × 2 theme)

## Baseline tooling — 2 TẦNG (r2)
**⚠ LUẬT PII (r2A): screenshot route chứa DỮ LIỆU PRODUCTION (tên khách, SĐT, toa thuốc, email nhân viên) — TUYỆT ĐỐI KHÔNG COMMIT.** `e2e/__screenshots__/`, `test-results/`, `playwright-report/` đã vào `.gitignore` — artifacts LOCAL-ONLY, dùng cho stakeholder QA trước/sau rồi regenerate mỗi session.

1. **Route SHELL baseline (local-only)** — `webapp/e2e/ui-baseline.spec.ts`:
   - Mục tiêu: header/tabs/toolbar/table-header — **SHELL-CLIP** (r2.2): chỉ chụp dải trên ổn định (desktop 560px, mobile 430px) vì mask không chống được layout-shift khi số row đổi (drift gate 15→16/07 bắt được). Vùng DATA còn lọt clip bị MASK (tbody, list rows, mobile card lists, grids đếm số, badge, tên user). Pagination frame → CATALOG lo.
   - Snapshot path (`snapshotPathTemplate`): `webapp/e2e/__screenshots__/ui-baseline.spec.ts/<name>-<theme>-<project>.png` (gitignored).
   - Theme deterministic: set `localStorage.theme` → assert `html.dark` trước khi chụp; theme nằm trong tên snapshot.
   - Stable wait: heading đặc trưng từng route, NFC-normalize + case-insensitive (bẫy thật: "Quản lý người dùng" chữ n thường).
   - Tạo: `npm run build && npm start` →
     `E2E_STAFF_EMAIL=… E2E_STAFF_PASSWORD=… E2E_SUPER_EMAIL=… E2E_SUPER_PASSWORD=… npx playwright test e2e/ui-baseline.spec.ts --update-snapshots`
   - **Gate**: chạy lại KHÔNG flag → no-diff toàn projects; + 1 lần NGÀY KẾ TIẾP để đo data-drift (mask chưa phủ chỗ nào thì bổ sung mask, không nới ratio).
2. **Component baseline (commit được — regression dài hạn CHÍNH)** — catalog **`/ui-catalog`** (gate `UI_CATALOG=1` + super admin): fixtures mock cố định ("Nguyễn Văn A", `DHC_TEST_001`, `POS_TEST`) → deterministic 100%, không PII → snapshot ĐƯỢC commit tại `e2e/__screenshots__/ui-catalog.spec.ts/`. Spec unlock nested-scroll của dashboard shell CHỈ TRONG TEST để fullPage chụp trọn mọi section (r1.1). Card/row/badge/empty/error/loading regression sống ở đây, không phụ thuộc DB.

### Sidebar r2 — bộ test hành vi/hình học (`webapp/e2e/sidebar-r2.spec.ts`)
Tầng thứ 3, **KHÔNG snapshot ảnh**: đối chiếu thẩm mỹ với mockup vẫn là việc QA tay/stakeholder, spec này chỉ ĐO những con số đã chốt + kiểm hành vi nhị phân — thứ máy gác được và mắt hay bỏ sót. Bổ sung cho `e2e/sidebar-nav.spec.ts` (chỉ khoá contract *active-state*).

| # | Test (`@desktop`, super admin, route `/tasks`) | Khoá điều gì |
|---|---|---|
| 1 | kích thước: aside 232 ⇄ 64, header 56 ở cả hai trạng thái | bề rộng mockup + header KHÔNG đổi chiều cao (nav không nhảy) |
| 2 | persistence: trạng thái thu gọn sống qua reload | cookie `sidebar_collapsed` ghi đúng 1/0 **và đọc SERVER-SIDE** — đo ngay lúc `domcontentloaded`, HTML đầu tiên phải đã đúng bề rộng (không nháy 1 frame) |
| 3 | viewport thấp 1366×768: footer luôn thấy được, nav tự cuộn | footer nằm trọn trong viewport, `#sidebar-nav` bottom ≤ footer top (không đè), nav `overflow-y:auto` và cuộn được thật |
| 4 | thu gọn: tooltip nhãn bung khi hover VÀ khi tab bàn phím | IconTooltip portal (`[role="tooltip"]` ngoài `<aside>`); Tab THẬT chứ không `focus()` vì base-ui chỉ mở khi `:focus-visible` |
| 5 | thu gọn: nhãn nhóm mất chữ, badge Bảng tin thu về chấm | SectionLabel đổi hẳn sang gạch `aria-hidden`; badge = `aside span.absolute` (đúng selector mà `ui-baseline` mask) |
| 6 | dark mode: token nền/chữ của sidebar đổi, nền không còn trắng | token light ≠ dark + độ sáng RGB thật (nền tối, chữ tương phản) |
| 7 | không sinh scroll ngang @1366×900 ở cả hai trạng thái | thu gọn/mở rộng không đẩy document ra ngoài viewport |

- **Env**: `E2E_SUPER_EMAIL` + `E2E_SUPER_PASSWORD` + một server đang chạy (`E2E_BASE_URL`, mặc định `http://localhost:3000`). Thiếu env → **skip** (không fail), cùng cơ chế mọi spec browser khác.
- Chạy: `E2E_SUPER_EMAIL=… E2E_SUPER_PASSWORD=… npx playwright test e2e/sidebar-r2.spec.ts`
- **Dark mode dùng `localStorage.theme`, KHÔNG dùng `emulateMedia({ colorScheme })`**: ThemeProvider là next-themes `attribute="class"` + `enableSystem={false}` ⇒ app không đọc `prefers-color-scheme`, emulateMedia sẽ "pass" trên một trang vẫn đang sáng.
- **Chống flaky**: `transition-[width] duration-200` ⇒ mọi phép đo bề rộng đi qua `expect(...).toPass()` với 2 mẫu cách nhau 1 rAF **trong trang**, chỉ chấp nhận khi hai mẫu bằng nhau — không `waitForTimeout` cứng. Tolerance ±1px. Badge Bảng tin là dữ liệu sống (role admin luôn = 0) nên spec đọc trạng thái thật ở chế độ mở rộng rồi mới ràng buộc chế độ thu gọn phải nhất quán, không hardcode số.

- **WebKit (đã cài) = OPT-IN `@webkit`, KHÔNG nằm trong gate mặc định** (P1 finding, evidence 2026-07-15): WebKit từ chối GỬI Secure cookie qua `http://localhost` (cookie Supabase secure=true vì API là https) → mọi flow authed bounce về /login; Chromium thì trust localhost. Không phải bug app (prod = https). Không được "fix" bằng cách đổi cookie flags (guardrails cấm đụng auth). Bật lại khi có https staging target.
- iPhone thật (Safari thật, https prod) = coverage Safari chính: regression zoom input (16px) + spot-check mỗi wave.
