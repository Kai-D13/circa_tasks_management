# UI v2 — Màn đăng nhập (`/login`)

Nguồn thiết kế: 6 export L1 desktop tối · L2 desktop sáng · L3 trạng thái form · M1 mobile sáng · M2 mobile tối ·
M3 mobile lỗi. Spec PM: `planning/research/ui-v2-login-spec-2026-10-16.md`. Phát hành CÙNG RC chung với Tasks + KPI
(`planning/research/ui-v2-single-release-plan-2026-10-16.md`), không deploy riêng.

## 1. Phạm vi và ranh giới

- File: `app/(auth)/login/{page,LoginForm,LoginScreen}.tsx`, `app/(auth)/layout.tsx` (ThemeProvider), `lib/auth/loginCopy.ts`,
  biến màu `[data-login]` cuối `app/globals.css`, fixture `app/(auth)/login/ui-catalog/page.tsx`.
- **Không đổi:**
  - `app/actions/auth.ts`, `proxy.ts`, cookie Supabase, `dynamic = 'force-dynamic'`;
  - `useActionState(login)` + hard navigation `window.location.assign(redirectTo)`;
  - `name/type/required/autocomplete` của 2 ô.
- `LoginScreen` = phần trình bày, route thật và fixture dùng chung. `LoginForm` = luồng auth (như cũ).

## 2. Bố cục

| Màn | Bố cục |
|---|---|
| ≥1024px | Hai vùng ngang, không cuộn ngang:<br>• Panel cam trái (`flex 1 1 520px`, cao hết màn): logo C, "Circa Tasks", headline, 3 điểm giới thiệu, chú thích nội bộ, 2 khối trang trí.<br>• Form phải (`flex 1 1 480px`), tối đa 380px, căn giữa dọc. |
| <1024px | Panel cam 250px + safe-area trên (logo + headline; ẩn 3 điểm và chú thích).<br>Sheet form bo góc trên 24px, đè panel 28px. Trang cuộn dọc tự nhiên (không `overflow:hidden`, không chiều cao cố định) ⇒ màn thấp / bàn phím mở vẫn tới nút. Đệm dưới gồm safe-area. |

- **Số đo px literal** (root font 15px ⇒ class rem lệch artboard):
  - ô nhập 46px / chữ 15px (desktop), 50px / chữ 16px (mobile, iOS không phóng);
  - CTA 48px / 52px;
  - nút mắt 36px / 44px.

## 3. Màu

- **Token v2 sẵn có** dưới `[data-ui-v2]`:
  - canvas `#F7F6F4` / `#121110`; field `#FFFFFF` / `#1A1817`; line-strong; chữ 1/2/3;
  - CTA `--v2-action` `#C94A16` / `#F3743F`.
- **Lỗi** = cặp `--status-danger` đã đo (alert + viền ô mật khẩu).
- **Riêng Login**, chỉ trong `[data-login]`:
  - panel `--login-brand #F3743F`, `--login-brand-deep #E8622A`, `--login-brand-soft #F7925F`, chữ panel `--login-ink #141210`; panel giống nhau ở 2 theme;
  - nút bận `--login-action-busy` `#D9784F` / `#B9673F`.
- **Theme:** theo lựa chọn sáng/tối của app (next-themes, `localStorage.theme`, mặc định sáng, không theo HĐH). `app/(auth)/layout.tsx` dùng chung `ThemeProvider` với dashboard ⇒ không nháy theme.

## 4. Chữ (theo export, PM duyệt)

- "Đăng nhập" · "Dùng tài khoản Circa Tasks được cấp cho bạn." · nhãn "Email" / "Mật khẩu" · placeholder `ten@circa.vn` / "Nhập mật khẩu".
- Headline "Mọi việc ở nhà thuốc, gọn trong một nơi." + 3 điểm giới thiệu + "Hệ thống nội bộ Circa · chỉ dành cho tài khoản được cấp".
- "Quên mật khẩu? Liên hệ Admin hoặc Quản lý vùng để được cấp lại." là **chữ hướng dẫn**: không link, không luồng reset.
- Nút "Đăng nhập" / "Đang đăng nhập…". Nhãn nút mắt "Hiện mật khẩu" / "Ẩn mật khẩu". "© {năm} Circa". Tab: "Đăng nhập — Circa Tasks".

## 5. Trạng thái và tương tác

- **Lỗi:** hiện NGUYÊN chữ server action trả về, trong alert `role=alert` nằm giữa ô mật khẩu và nút.
  - Chỉ khi chữ đúng là `LOGIN_CREDENTIAL_ERROR` ("Email hoặc mật khẩu không đúng." — unit test khoá trùng với `auth.ts`) mới tô viền ô mật khẩu + `aria-invalid`.
  - Lỗi khác (giới hạn tần suất, mạng…) chỉ hiện alert.
- **Email giữ giá trị sau lỗi** (ô controlled; React tự reset ô uncontrolled sau mỗi action). Mật khẩu được xoá.
- **Bận** `pending || redirecting`: nút khoá + vòng quay + "Đang đăng nhập…" tới hết chuyển trang; không gửi hai lần.
- **Nút mắt:**
  - `type=button`, `aria-pressed`, `aria-controls="password"`;
  - đổi `type` của ô mật khẩu, không xoá giá trị, không gửi form;
  - thứ tự Tab: email → mật khẩu → mắt → nút.
- **Focus:** viền cam + vòng 3px (`focus-within`).

## 6. Test

- `e2e/ui-v2-login.spec.ts`:
  - route thật: chữ, hợp đồng ô, nút mắt, Tab, validation, 1 lần đăng nhập sai bằng email giả `@example.invalid`, đăng nhập thật tài khoản E2E staff (hard navigation);
  - fixture: credential / lỗi khác / bận, sáng + tối;
  - bố cục 1024/1280/1440 và 360/390;
  - 6 ảnh.
- `e2e/login-copy.spec.ts`: chữ lỗi credential trùng `auth.ts`.
- Test/setup đăng nhập qua UI đổi selector nút `/sign in/i` → `/^đăng nhập$/i` (9 file e2e). `webapp/scripts/care-qa-fixture.mjs` (nhánh CRM) cần đổi tương tự khi ghép.
