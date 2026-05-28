# Circa Task Management — Project Status

> **Đọc file này trước khi build bất cứ thứ gì.**
> Cập nhật lần cuối: 2026-05-28 | Commit hiện tại: main branch sau recurring MVP

---

## 1. Business Objective

Thay thế luồng email + Teams trong chuỗi dược phẩm **Circa** (~100 users, 25+ cửa hàng).

Admin tạo task vận hành (training, kiểm kê, trưng bày, audit) → giao xuống các store → staff nộp kết quả có bằng chứng (ảnh, file, ghi chú) → manager theo dõi + đánh giá.

**Recurring task** là trái tim dài hạn: Admin tạo lịch (daily/weekly/monthly) → cron tự tạo task thật theo lịch → store nhận và submit như task thường.

---

## 2. User Roles & Permissions

| Quyền | Admin | Store Manager | Staff |
|---|---|---|---|
| Tạo task phát sinh | ✅ | ✅ (own store) | ❌ |
| Tạo task định kỳ | ✅ | ❌ | ❌ |
| Xem tất cả task | ✅ | ❌ | ❌ |
| Xem task của store mình | ✅ | ✅ | ❌ |
| Submit task (assigned) | ✅ | ✅ | ✅ |
| Submit store-level (no assignee) | ✅ | ✅ | ❌ |
| Đổi trạng thái | ✅ | ✅ | ✅ (if assigned, not submitted) |
| Xem submissions | ✅ (all) | ✅ (own store) | ✅ (own only) |
| Yêu cầu làm lại | ✅ | ✅ | ❌ |
| Ghi chú review | ✅ | ✅ | đọc only |
| Quản lý lịch định kỳ | ✅ | ❌ | ❌ |
| Quản lý người dùng | ✅ | ❌ | ❌ |

---

## 3. Core Task Workflow

### 3a. Phát sinh (one-time)
```
Admin/Manager tạo task
  → assigned_to = null (store-level) hoặc = user_id (cá nhân)
  → Store Manager / Staff thấy task theo visibility + RLS
  → Người được giao submit (TaskSubmitForm → task_results insert)
  → supabaseAdmin cập nhật tasks.status = 'done'
  → Manager xem kết quả, có thể "Yêu cầu làm lại"
```

### 3b. Resubmit flow
```
Manager bấm "Yêu cầu làm lại"
  → tasks.status = 'todo', tasks.resubmit_requested_at = now()
  → Log: resubmit_requested
  → Notify: assigned_to (nếu có) HOẶC tất cả store_manager của store đó
  → Staff/Manager thấy banner lý do
  → Submit lại được (duplicate check chỉ block kết quả sau resubmit_requested_at)
```

### 3c. Broadcast task
```
Admin tạo "Nhiều CH" hoặc "Tất cả CH"
  → 1 task_broadcasts row
  → N tasks (1 per store), broadcast_id giống nhau, assigned_to = null
  → Mỗi store tự submit (store-level submit)
  → /tasks hiển thị 1 dòng cho cả broadcast (grouping theo broadcast_id)
```

### 3d. Recurring task
```
Admin tạo "Định kỳ" trong TaskForm
  → task_templates (nội dung) + task_schedules (lịch) + task_schedule_stores (stores)
  → Cron GET /api/cron/generate-recurring-tasks (01:00 UTC = 08:00 ICT)
    → Tìm schedules active với next_run_at <= now()
    → Tạo task_broadcasts + N tasks (như broadcast)
    → Unique index (source_schedule_id, store_id, scheduled_for) ngăn duplicate
    → Cập nhật last_run_at + next_run_at
    → Log: recurring_tasks_generated
  → Task thật flow qua submit/review như bình thường
```

---

## 4. Database Schema (toàn bộ)

```sql
-- Core
stores               (id, name, code, address, created_at)
users                (id → auth.users, email, full_name, role, store_id, created_at)
tasks                (id, title, description, priority, status, visibility,
                      category, store_id, assigned_to, created_by,
                      input_data jsonb, required_outputs jsonb,
                      start_date, deadline, broadcast_id,
                      resubmit_requested_at,
                      archived_at,                              ← migration 011
                      source_template_id, source_schedule_id,  ← migration 013
                      scheduled_for, assignment_mode,          ← migration 013
                      created_at, updated_at)
task_results         (id, task_id, user_id, output_data jsonb, submitted_at)
task_logs            (id, task_id NULLABLE, action, user_id, metadata jsonb, created_at)
task_broadcasts      (id, title, created_by, store_count, created_at)
notifications        (id, user_id, type, task_id, title, message, is_read, created_at)

-- Recurring
task_templates       (id, title, config jsonb, is_active, created_by, created_at, updated_at)
task_schedules       (id, template_id, frequency, timezone, run_time, weekdays int[],
                      month_day, start_date, end_date, deadline_offset_hours,
                      next_run_at, last_run_at, is_active, created_at, updated_at)
task_schedule_stores (schedule_id, store_id)  -- PK composite
task_generation_runs (id, schedule_id, scheduled_for, status, created_count,
                      error_message, idempotency_key UNIQUE, started_at, finished_at)
```

### RLS Summary
- `tasks`: Admin thấy tất cả; Manager thấy store mình + visibility=public; Staff thấy assigned + store-visibility
- `task_results`: Admin all; Manager own store's tasks; Staff own only ← **migration 010**
- `tasks UPDATE`: Staff chỉ qua `rpc_staff_update_task_status` SECURITY DEFINER ← **migration 010**
- `task_results INSERT`: Direct assignee OR store_manager của store đó (assigned_to IS NULL) ← **migration 012**
- `task_schedules/task_schedule_stores/task_generation_runs`: Admin full; Manager read own ← **migration 013**

### Enums (text, không phải ENUM type)
- `role`: admin | store_manager | staff
- `status`: todo | in_progress | done | overdue
- `priority`: urgent | normal
- `visibility`: public | store | private
- `category`: training | recall | display | audit | other
- `required_outputs`: text | image | video | file
- `frequency`: daily | weekly | monthly
- `run_status`: running | success | failed | skipped
- `assignment_mode`: store | user

---

## 5. Migrations (chạy theo thứ tự)

| File | Nội dung | Status |
|---|---|---|
| `001_init.sql` | Schema đầy đủ + RLS + triggers | ✅ Applied |
| `002_fixes.sql` | Fix admin role + visibility cũ | ✅ Applied |
| `003_storage.sql` | Bucket task-uploads | ✅ Applied |
| `004_start_date.sql` | Cột start_date vào tasks | ✅ Applied |
| `005_notifications.sql` | Bảng notifications + RLS + realtime | ✅ Applied |
| `006_task_categories.sql` | Cột category vào tasks | ✅ Applied |
| `007_broadcast.sql` | task_broadcasts table + broadcast_id | ✅ Applied |
| `008_staff_task_update.sql` | (Đã DROP trong 010 — không áp dụng lại) | ✅ Superseded |
| `009_review_notes.sql` | task_logs action=review_note | ✅ Applied |
| `010_resubmit_hardening.sql` | resubmit_requested_at, task_results RLS, RPC status update | ✅ Applied |
| `011_archive_tasks.sql` | archived_at column + index | ✅ Applied |
| `012_store_level_submit.sql` | tr_insert RLS cho store-level submit | ✅ Applied |
| `013_recurring_tasks.sql` | task_templates extend + task_schedules + stores + runs + tasks columns | ✅ Applied |

---

## 6. Files & Architecture quan trọng

### Key files
```
webapp/proxy.ts                          ← Auth middleware (KHÔNG phải middleware.ts)
                                          /api/cron/ được bypass, tự bảo vệ bằng CRON_SECRET
webapp/lib/supabase/admin.ts             ← supabaseAdmin (service role, bypass RLS)
webapp/lib/recurring.ts                  ← computeNextRunAt() — pure helper, được import bởi
                                            tasks.ts và cron route
webapp/app/actions/tasks.ts              ← TẤT CẢ server actions: createTask, updateTask,
                                            submitTask, createBroadcastTask, createTaskSchedule,
                                            pauseSchedule, resumeSchedule, archiveTasks, restoreTasks
webapp/app/api/cron/generate-recurring-tasks/route.ts  ← Cron endpoint
webapp/vercel.json                       ← Cron schedule: "0 1 * * *" (08:00 ICT)
webapp/types/index.ts                    ← Tất cả TypeScript types
```

### Key components
```
TaskForm.tsx          ← Create/edit task — Outlook compose style; Định kỳ chỉ show cho admin
TaskList.tsx          ← Server list với broadcast grouping; archive/restore checkboxes
TaskFilters.tsx       ← URL-param filters
ScheduleActions.tsx   ← Pause/resume client component cho schedules page
NotificationBell.tsx  ← Realtime bell icon
Sidebar.tsx           ← "Định kỳ" nav item chỉ admin thấy (/tasks/schedules)
```

### Routes
```
/tasks                       → Task list (broadcast grouped, no raw pagination)
/tasks/new                   → Tạo task mới (Phát sinh hoặc Định kỳ nếu admin)
/tasks/[id]                  → Task detail + submit + review
/tasks/[id]/edit             → Edit task
/tasks/schedules             → Danh sách lịch định kỳ (admin only)
/tasks/schedules/[id]        → Chi tiết lịch + run history + recent tasks
/dashboard                   → KPI + recurring summary (admin) + recent activity
/logs                        → Audit logs (action labels đầy đủ)
/users                       → User management (admin only)
/stores                      → Store list
/api/cron/generate-recurring-tasks  → Cron route (bypass middleware, CRON_SECRET protected)
```

---

## 7. Recurring Task Design

### Data flow
```
Admin → TaskForm (Định kỳ) → createTaskSchedule()
  → task_templates (title + config jsonb)
  → task_schedules (frequency, run_time, weekdays/month_day, next_run_at)
  → task_schedule_stores (schedule_id, store_id per store)

Cron (daily 08:00 ICT) → GET /api/cron/generate-recurring-tasks
  → Finds schedules WHERE is_active=true AND next_run_at <= now()
  → Creates task_generation_run (idempotency_key = scheduleId_YYYY-MM-DD)
  → Creates task_broadcasts + tasks (với source_schedule_id, scheduled_for)
  → Updates schedule: last_run_at, next_run_at
  → Notifies store managers
```

### computeNextRunAt (webapp/lib/recurring.ts)
- `daily`: advance from startDate until > afterMs
- `weekly`: walk forward from startDate, find first matching weekday > afterMs
- `monthly`: find first month >= startDate where monthDay exists and > afterMs
- Timezone: UTC+7 (Asia/Ho_Chi_Minh, no DST) — hardcoded offset

### Idempotency
- `UNIQUE (source_schedule_id, store_id, scheduled_for)` trong bảng tasks
- `idempotency_key = scheduleId_YYYY-MM-DD` trong task_generation_runs
- Cron có thể chạy lại an toàn — không tạo duplicate

---

## 8. What Has Been Tested

### Verified end-to-end ✅
- Tạo task phát sinh → submit → done → resubmit → submit lại
- Broadcast task (nhiều store) → grouping trên /tasks → mỗi store submit riêng
- Store-level submit (assigned_to = null, store manager submit thay)
- Resubmit notification đến đúng store manager (kể cả khi không assign cá nhân)
- Archive/restore task
- Import Excel → bulk tasks
- Notification realtime bell
- **Cron endpoint:**
  - Local curl với CRON_SECRET → tạo đúng số tasks = số stores
  - Idempotency: gọi lại 2 lần cùng ngày → total_created = 0
  - Tasks sau cron có: source_schedule_id, broadcast_id, scheduled_for, assignment_mode = 'store'
- Middleware bypass: `/api/cron/` không bị redirect /login

### Chưa test production
- Vercel cron trigger thực tế
- Vercel Environment: CRON_SECRET + SUPABASE_SERVICE_ROLE_KEY
- Schedule pause/resume flow
- Schedule detail page với dữ liệu thật

---

## 9. Known Risks & Technical Debt

| Mức | Vấn đề | Ảnh hưởng | Cách xử lý |
|---|---|---|---|
| P2 | `updateTask` không validate store_id rỗng nếu edit form bị tamper | Task mất store | Server đã có guard, edit form luôn pre-fill |
| P2 | Pagination /tasks bị remove (fetch all) | Scale issue khi > 200 tasks | Rebuild grouped pagination khi cần (xem roadmap) |
| P2 | `computeNextRunAt` dùng UTC+7 hardcode | Sai giờ nếu DST tồn tại | Vietnam không có DST — ổn lâu dài |
| P3 | task_generation_runs không có RLS cho manager xem lịch sử chạy của schedule mình | Manager không thấy run history | Admin-only detail page là đủ hiện tại |
| P3 | Không có "Tạo task lần đầu ngay" khi tạo schedule | Admin phải chờ đến ngày chạy | Có thể thêm sau |
| P3 | Không có edit schedule | Phải tạo lại lịch mới | Thêm vào sprint sau |
| P3 | Không có delete schedule | Chỉ có pause | Thêm vào sprint sau |

---

## 10. Next Priorities (chưa build)

### Sprint tiếp theo (khuyến nghị)
1. **Edit schedule** — `/tasks/schedules/[id]/edit` — cho phép sửa run_time, weekdays, stores, deadline offset
2. **Delete schedule** — soft delete hoặc is_active = false + ẩn khỏi danh sách
3. **"Tạo task ngay hôm nay"** button trên schedule detail — manual trigger cho 1 lần
4. **Grouped pagination** cho /tasks — query task_broadcasts + tasks WHERE broadcast_id IS NULL, merge, paginate theo logical item
5. **Mobile PWA** — manifest.json, offline-capable cho staff

### Dashboard improvements
- Recurring block hiện ẩn nếu 0 schedules → show luôn khi admin đã tạo ít nhất 1
- Thêm "số task định kỳ đã sinh hôm nay" vào KPI cards

### Log improvements
- Thêm link "Xem lịch" cho log entries có schedule_id trong metadata

---

## 11. Deployment Checklist (Vercel)

### Environment Variables cần có
```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=        ← dùng cho supabaseAdmin + cron
CRON_SECRET=                      ← bất kỳ string ngẫu nhiên đủ dài
```

### Vercel Settings
- Root Directory: `webapp`
- Framework: Next.js (auto-detect)
- `webapp/vercel.json` đã có cron: `"0 1 * * *"` (01:00 UTC = 08:00 ICT)

### Supabase
- Tất cả migrations 001–013 phải được apply
- Storage bucket `task-uploads` phải tồn tại và public
- `rpc_staff_update_task_status` SECURITY DEFINER function phải tồn tại (migration 010)
- `get_user_role()` và `get_user_store_id()` SECURITY DEFINER phải tồn tại (migration 001)

### Verify sau deploy
```bash
# Cron auth
curl https://your-domain.vercel.app/api/cron/generate-recurring-tasks
# Expected: 401 {"error":"Unauthorized"}

curl -H "Authorization: Bearer $CRON_SECRET" \
  https://your-domain.vercel.app/api/cron/generate-recurring-tasks
# Expected: {"ok":true,"total_created":...}

# Web route vẫn protected
curl https://your-domain.vercel.app/tasks
# Expected: redirect to /login
```

---

## 12. Code Patterns (đọc trước khi viết code)

### Server Actions file ('use server')
```typescript
// Mọi export phải là async function
// Không được export sync function (Next.js 16 rule)
// Helper functions không export thì được sync
// computeNextRunAt() nằm riêng ở lib/recurring.ts vì lý do này
```

### supabaseAdmin usage
```typescript
// Dùng khi cần bypass RLS:
// - submitTask: cập nhật task.status = 'done' (staff RLS đã drop trong 010)
// - Cron route: tạo tasks/broadcasts không có session
// KHÔNG dùng trong component client-side
```

### Supabase join cast
```typescript
// Joins luôn trả về array, cần double cast
const template = row.task_templates as unknown as { title: string } | null
```

### Select with count
```typescript
// Dùng khi cần total count
supabase.from('task_schedules').select('*', { count: 'exact', head: true }).eq('is_active', true)
// → { count: N, data: null }
```

### formatDate
```typescript
import { formatDate } from '@/lib/dateUtils'
// Dùng cho tất cả timestamp display — đã handle timezone
```

### Tailwind design tokens
```
bg-primary           → orange #FB743E
bg-sidebar-accent    → warm cream #FEF8ED (hover state cho nav items)
text-primary         → orange text
border-border        → rgb(218,218,218)
Font: Roboto 400/500/700, latin + vietnamese
No dark mode
```

---

## 13. Stack Summary

| Layer | Library | Ghi chú |
|---|---|---|
| Framework | Next.js 16 App Router | Dùng `proxy.ts` KHÔNG `middleware.ts` |
| UI | shadcn/ui v4 + @base-ui/react | Không có `asChild`, dùng `render` prop |
| Auth + DB | Supabase | PostgreSQL + RLS + Realtime + Storage |
| Styling | Tailwind CSS v4 | `@theme inline` trong globals.css, không có tailwind.config |
| Font | Roboto (next/font) | 400/500/700, latin+vietnamese |
| Toast | sonner | `toast.error()` / `toast.success()` |
| File upload | Supabase Storage | Bucket: `task-uploads` |
| Excel import | SheetJS (xlsx) | Client-side only |
| Cron | Vercel Cron | 01:00 UTC daily, route tự bảo vệ bằng CRON_SECRET |
