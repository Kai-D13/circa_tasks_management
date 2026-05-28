# Today / Next Steps

> Cập nhật file này khi bắt đầu và kết thúc mỗi ngày build.
> Đọc PROJECT_STATUS.md nếu cần context đầy đủ.

---

## Trạng thái hiện tại (2026-05-28 EOD)

### Đã xong hôm nay ✅
- Recurring MVP end-to-end: Admin tạo schedule → cron tạo task thật → 2/2 stores nhận task
- Idempotency verified: cùng ngày cron chạy lại → 0 task mới
- Schedule detail page `/tasks/schedules/[id]`: config, stores, run history, recent tasks
- Dashboard recurring summary block (admin only)
- Middleware bypass `/api/cron/` đúng — web routes vẫn protected
- TaskForm: "Định kỳ" toggle ẩn với Store Manager
- Pagination bug fixed: /tasks không còn cắt broadcast group qua page

### Build state sạch
- `npx tsc --noEmit`: pass
- `git diff --check`: không có whitespace error
- Không có code pending uncommitted (ngoài file tạm/docs)

---

## Commit tiếp theo cần stage

```powershell
git add -- `
  "webapp/lib/recurring.ts" `
  "webapp/proxy.ts" `
  "webapp/app/actions/tasks.ts" `
  "webapp/app/api/cron/generate-recurring-tasks/route.ts" `
  "webapp/app/(dashboard)/logs/page.tsx" `
  "webapp/app/(dashboard)/tasks/page.tsx" `
  "webapp/app/(dashboard)/tasks/schedules/page.tsx" `
  "webapp/app/(dashboard)/tasks/schedules/[id]/page.tsx" `
  "webapp/app/(dashboard)/dashboard/page.tsx" `
  "webapp/components/tasks/ScheduleActions.tsx" `
  "webapp/components/tasks/TaskForm.tsx" `
  "webapp/components/layout/Sidebar.tsx" `
  "webapp/types/index.ts" `
  "webapp/vercel.json" `
  "supabase/migrations/013_recurring_tasks.sql" `
  "PROJECT_STATUS.md" `
  "TODAY_NEXT_STEPS.md"
```

**Không add:** `Task Specification*.MD`, `USER_TEST_GUIDE*`, `build_logs_vercel.txt`, `circa-ui-guidelines.md`, `*.jpg`, `*.png`

---

## Sprint tiếp theo (theo thứ tự ưu tiên)

### P1 — Edit Schedule
- Route: `/tasks/schedules/[id]/edit`
- Cho phép sửa: run_time, weekdays/month_day, deadline_offset_hours, stores, end_date
- KHÔNG cho sửa: frequency (breaking change với next_run_at logic), template content
- Nếu muốn sửa content → tạo schedule mới

### P2 — Manual Trigger
- Button "Tạo task ngay hôm nay" trên `/tasks/schedules/[id]`
- Gọi cùng logic với cron nhưng dành cho 1 schedule cụ thể
- Admin có thể test trước khi schedule tự chạy

### P3 — Grouped Pagination
- Query `task_broadcasts` làm source cho broadcast groups
- Query `tasks WHERE broadcast_id IS NULL` cho task đơn lẻ
- Merge + sort + paginate theo logical item (không theo raw rows)
- Target: 20 logical items/page

### P4 — Delete Schedule
- Soft delete: `is_active = false` + `deleted_at = now()`
- Ẩn khỏi danh sách active
- Giữ task_generation_runs và tasks đã tạo (audit trail)

### P5 — Mobile UX
- manifest.json cho PWA
- Staff view `/tasks/my` — chỉ task assigned cho mình, sort theo deadline
- Camera-direct upload trên mobile

---

## Không làm tiếp theo (defer)

- Dashboard recurring nâng cao (schedule run logs timeline)
- Export CSV broadcast progress
- Edit template content của schedule đã tạo
- Multi-level notifications (email/push)
- Task template library UI

---

## Deployment Readiness

- [x] Migration 013 applied trên Supabase
- [x] middleware/proxy.ts bypass cron route
- [ ] `CRON_SECRET` env var thêm vào Vercel
- [ ] `SUPABASE_SERVICE_ROLE_KEY` env var verify trên Vercel
- [ ] Test cron production: `curl -H "Authorization: Bearer $CRON_SECRET" https://...`
- [ ] Verify /tasks sau deploy không có 500 từ archived_at migration
