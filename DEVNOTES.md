# Task Management Platform — Developer Notes

Tài liệu này dùng để debug, rebuild, hoặc onboard developer mới. Cập nhật mỗi khi có thay đổi lớn.

---

## Stack

| Layer | Thư viện | Ghi chú |
|---|---|---|
| Frontend | Next.js 16 App Router | Dùng `proxy.ts` (KHÔNG phải `middleware.ts`) |
| UI | shadcn/ui v4 + @base-ui/react | KHÔNG dùng `asChild` — dùng `render={<Component />}` |
| Auth + DB | Supabase | Auth + PostgreSQL + RLS + Realtime |
| Supabase client | @supabase/ssr v0.10.x | `createBrowserClient` (client), `createServerClient` (server) |
| State | Zustand v5 | `useUserStore` — lưu profile người dùng |
| File upload | Supabase Storage | Bucket: `task-uploads` (public) |
| Excel parse | SheetJS (xlsx) | Chỉ dùng client-side trong ImportTasksClient |

---

## Cấu trúc thư mục quan trọng

```
webapp/
  app/
    (auth)/login/           ← Trang đăng nhập
    (dashboard)/
      layout.tsx            ← Fetch profile + wrap UserProvider + Sidebar
      dashboard/            ← KPI + recent tasks
      tasks/                ← Danh sách tasks
      tasks/[id]/           ← Chi tiết task + reassign + submit
      tasks/[id]/edit/      ← Chỉnh sửa task
      tasks/new/            ← Tạo task mới
      tasks/import/         ← Import hàng loạt từ Excel/CSV
      users/                ← Quản lý người dùng (admin only)
      stores/               ← Danh sách cửa hàng
      logs/                 ← Nhật ký hoạt động
  proxy.ts                  ← Route protection (Next.js 16 — KHÔNG phải middleware.ts)
  components/
    layout/
      Sidebar.tsx           ← Nav + user info + đăng xuất + NotificationBell
      NotificationBell.tsx  ← Bell icon với Realtime subscription, unread count badge
    providers/
      ThemeProvider.tsx     ← Dark/light mode (localStorage + .dark class trên <html>)
    tasks/
      TaskForm.tsx          ← Tạo/sửa task (fully controlled selects, start_date field)
      TaskSubmitForm.tsx    ← Nộp kết quả (chỉ assignee mới thấy)
      TaskReassignForm.tsx  ← Phân công lại (admin/manager)
      TaskReviewNote.tsx    ← Ghi chú quản lý (admin/store_manager) → task_logs action=review_note
      FileUploadInput.tsx   ← Upload file từ điện thoại/máy tính
      TaskFilters.tsx       ← Bộ lọc tasks
      TaskStatusSelector.tsx ← Đổi trạng thái inline (lọc "Quá hạn" cho non-admin, note prompt khi staff chọn Đang thực hiện)
      ImportTasksClient.tsx ← Import Excel → tạo task hàng loạt
      InputDataDisplay.tsx  ← Hiển thị dữ liệu từ Excel
    users/
      CreateUserDialog.tsx  ← Tạo người dùng mới (admin only)
  app/actions/
    tasks.ts                ← Server actions: createTask, updateTask, reassignTask, submitTask, createBulkTasks, addReviewNote
    users.ts                ← Server actions: createUser, updateUserRole
  lib/supabase/
    client.ts               ← Browser client (createBrowserClient)
    server.ts               ← Server client (createServerClient + cookies)
    admin.ts                ← Service role client (bỏ qua RLS — chỉ dùng server-side)
  store/userStore.ts        ← Zustand store
  types/index.ts            ← Tất cả TypeScript types
supabase/                    ← ở root C:\webapp_management\supabase\, KHÔNG phải trong webapp\
  migrations/
    001_init.sql            ← Schema + RLS + triggers
    002_fixes.sql           ← Fix admin role + visibility cho tasks cũ
    003_storage.sql         ← Tạo bucket task-uploads
    004_start_date.sql      ← Thêm cột start_date vào tasks
    005_notifications.sql   ← Bảng notifications + RLS + realtime
```

---

## Database Schema tóm tắt

```
stores     (id, name, code, address, created_at)
users      (id → auth.users, email, full_name, role, store_id, created_at)
tasks      (id, title, description, priority, status, visibility, store_id,
            assigned_to, created_by, input_data jsonb, required_outputs jsonb,
            start_date, deadline, created_at, updated_at)
task_results  (id, task_id, user_id, output_data jsonb, submitted_at)
task_logs     (id, task_id, action, user_id, metadata jsonb, created_at)
notifications (id, user_id, type, task_id, title, message, is_read, created_at)
```

**Roles:** `admin` | `store_manager` | `staff`
**Task status:** `todo` | `in_progress` | `done` | `overdue`
**Task priority:** `urgent` | `normal`
**Task visibility:** `public` | `store` | `private`
**Required outputs:** `text` | `image` | `video` | `file`

---

## Business Logic quan trọng

### Phân quyền Submit Task
> Chỉ người được `assigned_to` mới thấy và nộp được kết quả.
> Admin và Store Manager KHÔNG có nút "Nộp kết quả".
> Logic trong: `tasks/[id]/page.tsx` → `const canSubmit = task.status !== 'done' && task.assigned_to === user.id`

### Visibility tự động
> Khi giao task cho ai đó → `visibility` tự set thành `'private'`
> Khi bỏ trống assignee → `visibility` set thành `'store'`
> Logic trong: `TaskForm.tsx` (handleAssigneeChange) + `reassignTask` action

### Nhật ký hoạt động
> Store Manager chỉ thấy logs của tasks trong store mình.
> Logic trong: `logs/page.tsx` — filter app-layer bằng task IDs của store.
> RLS cũng có nhưng app-layer là backup chắc chắn.

### File Upload
> Dùng Supabase Storage bucket `task-uploads` (public).
> Component: `FileUploadInput.tsx` — upload từ điện thoại/máy tính.
> Path: `tasks/{taskId}/{outputType}/{timestamp}.{ext}`
> **Cần chạy `003_storage.sql` trong Supabase SQL Editor trước khi dùng.**

---

## Patterns quan trọng (tránh bugs)

### shadcn v4 / @base-ui/react — SelectValue phải có children
```tsx
// ❌ SAI — SelectValue không tự hiển thị text từ items (portal issue)
<SelectValue />

// ✅ ĐÚNG — Truyền text hiện tại làm children
<SelectValue>{selectedName ?? <span className="text-muted-foreground">Placeholder</span>}</SelectValue>
```

### shadcn v4 — KHÔNG có asChild
```tsx
// ❌ SAI
<DialogTrigger asChild><Button /></DialogTrigger>

// ✅ ĐÚNG
<DialogTrigger render={<Button />}>Label</DialogTrigger>

// ✅ HOẶC dùng buttonVariants trực tiếp trên Link
<Link className={cn(buttonVariants({ size: 'sm' }))}>Label</Link>
```

### Select onValueChange nhận `string | null`
```tsx
// ✅ Luôn guard null
onValueChange={(v) => { if (v) setVal(v) }}
// Hoặc
onValueChange={(v) => setVal(v ?? '')}
```

### Next.js 16 — proxy.ts (KHÔNG phải middleware.ts)
```ts
// ✅ webapp/proxy.ts — export đúng tên
export { proxy } from '@supabase/ssr'
// hoặc custom proxy function
```

### Supabase joined relations — TypeScript cast
```ts
// Supabase infer là array nhưng single join thực ra là object
(task.stores as unknown as { name: string } | null)?.name
```

---

## SQL cần chạy (theo thứ tự)

1. `001_init.sql` — Schema + RLS (đã chạy khi setup)
2. `002_fixes.sql` — Fix admin role + visibility (chạy 1 lần)
3. `003_storage.sql` — Storage bucket (chạy 1 lần trước khi upload file)
4. `004_start_date.sql` — Thêm cột `start_date` vào bảng tasks
5. `005_notifications.sql` — Tạo bảng notifications + RLS + realtime

### Fix nhanh nếu cần reset admin
```sql
UPDATE public.users SET role = 'admin' WHERE email = 'your@email.com';
```

### Fix tasks cũ có visibility sai
```sql
UPDATE public.tasks SET visibility = 'private'
WHERE assigned_to IS NOT NULL AND visibility = 'store';
```

### Xem RLS policies hiện tại
```sql
SELECT schemaname, tablename, policyname, cmd, qual
FROM pg_policies WHERE schemaname = 'public'
ORDER BY tablename, policyname;
```

---

## Môi trường

File `.env.local` (không commit):
```
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...   ← Chỉ dùng server-side (admin.ts)
```

---

## Lịch sử thay đổi

### 2026-05-17 — Session 4
- Submission display: ảnh hiển thị thumbnail + click phóng to; file/video hiển thị tên file ngắn (bỏ URL prefix)
- Chỉ Admin mới có nút "Chỉnh sửa" và "Xoá" task
- Store Manager: thay Edit bằng "Ghi chú quản lý" (TaskReviewNote → task_logs action=review_note)
- TaskStatusSelector: Store Manager + Staff không thấy tùy chọn "Quá hạn"
- Staff chọn "Đang thực hiện" → hiện ô note tùy chọn (lưu vào task_logs metadata.note)
- Thêm trường "Ngày bắt đầu" (start_date) vào TaskForm + tasks table (`004_start_date.sql`)
- Hệ thống thông báo in-app: bảng `notifications` + Realtime (`005_notifications.sql`)
  - createTask / updateTask: thông báo khi assign task mới
  - reassignTask: thông báo người được phân công mới
  - updateTaskStatus: thông báo creator khi status thay đổi
  - submitTask: thông báo creator khi task được nộp
  - NotificationBell trong Sidebar với unread count + dropdown realtime
- Brand theme Circa: --primary orange oklch(0.64 0.19 44), dark mode toggle (Sidebar)
- ThemeProvider: localStorage persistence + prefers-color-scheme fallback

### 2026-05-17 — Session 3
- Fix UUID hiển thị trong Select dropdowns (tất cả components)
- Fix canSubmit: chỉ assignee mới nộp được, admin/manager không thấy "Nộp kết quả"
- Fix validate required outputs trước khi submit
- Thêm tính năng reassign: admin/manager phân công lại task cho staff
- Chuẩn hóa toàn bộ UI sang tiếng Việt
- File upload thực sự từ thiết bị (Supabase Storage)
- Nhật ký: Store Manager chỉ thấy logs của store mình
- Nhật ký: Hiển thị chi tiết có nghĩa (tên người được giao, trạng thái cũ → mới...)
- Thêm "Phân công bởi [tên]" trên trang chi tiết task
- Cải thiện metadata của tất cả log entries

### 2026-05-16 — Session 1 & 2
- Setup Next.js 16 + Supabase + shadcn/ui v4
- Schema + RLS + triggers (001_init.sql)
- Auth: login, proxy.ts, session refresh
- Task CRUD: tạo, sửa, xoá, xem chi tiết
- Import hàng loạt từ Excel với auto-detect POS Code column
- User management: admin tạo user với role + store
- Dashboard KPI
- Audit logs
- 29 stores import vào Supabase
