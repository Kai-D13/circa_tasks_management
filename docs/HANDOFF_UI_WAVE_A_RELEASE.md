# Handoff: UI Wave A Release (23/07/2026)

**SHA merge/deploy:** `259d692` (merge `feat/ui-wave-a@a582742` vào main, sau Affiliate Foundation `0507346`).

## Route đã migrate theo circa-ui design system (visual-only)
| Batch | Route | Nội dung chính |
|---|---|---|
| Pilot 1-2 (đã release trước, 4161dd1) | `/stores`, `/tasks` | PageHeader/DataToolbar/DataTableShell/StatusBadge |
| A1 | `/tasks/schedules` (+detail) | 44px touch, status tokens, per-section query errors |
| A2 | `/users` | ds StatCard, TagBadge roles, DataToolbar, 4 dialogs |
| A3 | `/logs` | ACTION_HUE, Pagination full-mode 44px mobile, ErrorState secondary queries |
| T1/T2 | `/targets` | tokens + ds shell (staff mobile + SM selector + super table) |

## Cam kết
- KHÔNG migration, KHÔNG đổi env, KHÔNG đổi query/URL param/filter/authz/RLS/business logic.
- Số KPI/campaign không đổi (QA đối chiếu trước/sau).
- Stakeholder QA PASS 23/07 trên build `a582742` (wave-a + foundation — đúng trạng thái lên prod).
- A4 `/dashboard` deferred (sau chương trình Affiliate).

## Sau release
- Batch UI Wave A ĐÓNG. Không restyle tiếp trong nhánh Affiliate (`feat/kpi-affiliate-phase3`).
- Mọi UI mới của Phase 3 Affiliate phải theo skill `webapp/.claude/skills/circa-ui`.
