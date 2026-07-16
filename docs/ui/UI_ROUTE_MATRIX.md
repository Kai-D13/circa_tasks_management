# UI Route Matrix — migration waves

> Mỗi route 1 commit. Giữ nguyên: query, URL param, filter logic, pagination logic, action, RLS/authz. Chỉ đổi className/JSX structure sang component ds/.

| Route | Persona chính | PageHeader | StatCard | StatusBadge | FilterTabs | DataToolbar | TableShell | Pagination | Empty/Error/Loading | DetailShell | Wave |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `/stores` | Admin desktop | ✓ | – | ✓ (region/FS/inactive) | – | – | ✓ | – | ✓ | – | **PILOT 1** |
| `/tasks` (list) | Staff mobile | ✓ | – | ✓ (qua TaskStatusBadge) | ✓ (pending/done pills) | ✓ | ✓ (admin tree giữ cấu trúc) | ✓ simple+full | ✓ | – | **PILOT 2** |
| `/tasks/schedules` (+[id]) | Admin | ✓ | – | ✓ (active/paused, mode) | – | ✓ | ✓ | – | ✓ | ✓ | A1 |
| `/users` | Admin | ✓ | ✓ (4 stat) | ✓ (role, dept chips giữ deptBadgeClass) | – | ✓ | ✓ | ✓ | ✓ | A2 |
| `/logs` | Admin | ✓ | – | ✓ (ACTION_COLORS→tone) | – | ✓ | ✓ | ✓ | ✓ | A3 |
| `/dashboard` | Admin | ✓ | ✓ (KPI 4 cards) | ✓ | – | – | ✓ (recent) | – | ✓ | A4 |
| `/prescriptions` (+[id], new) | Staff mobile + Admin | ✓ | – (strip nhắc giữ layout riêng) | ✓ (order/care/match labels) | ✓ (Tất cả/Có ngày dùng) | ✓ | ✓ | ✓ 2 mode | ✓ | ✓ detail | B1 |
| `/announcements` (+[id], new, edit) | Staff + Admin | ✓ | – | ✓ (unread) | – | – | – (card list) | ✓ | ✓ | ✓ | B2 |
| `/inventory` + `/inventory/trf` | Store + CycleCount | ✓ | – | ✓ (TRF pills) | ✓ | ✓ | – (board) | – | ✓ | – | B3 |
| `/tasks/[id]` (detail+submit) | Staff mobile | – | – | ✓ | – | – | – | – | ✓ | ✓ | B4 |
| `/targets` (+campaigns, [id]) | Staff + SM + Super | ✓ | ✓ (campaign 6-card) | ✓ (tier/status) | ✓ (period/campaign) | ✓ | ✓ | – | ✓ | ✓ | C1-C3 |
| `/fs/products` (+[id] detail) | Policy admin (super QA được) | ✓ | ✓ (4 summary) | ✓ (FS_SESSION_STATUS/FS_ITEM_STATUS→tone) | ✓ (result status) | ✓ | ✓ | ✓ | ✓ | ✓ | C4-C5 |
| `/fs/products/[id]/process` (FS staff wizard) | — | **LOẠI KHỎI SCOPE (r1)**: 2 persona QA đã chốt (super + OS staff) không đại diện được FS staff camera/upload. Chỉ quay lại nếu stakeholder duyệt ngoại lệ persona FS (staff1_nhitrung) ở wave riêng. | | | | | | | | | — |
| `/gioi-thieu` | Super | ✓ | – | – | – | – | ✓ | – | ✓ | – | C7 (nhẹ) |

## Ghi chú rủi ro theo wave
- **Pilot** chọn 1 admin-desktop (/stores — đơn giản nhất, ít state) + 1 staff-mobile (/tasks — phức tạp nhất về card/tree/badge) → phát hiện sớm lỗi responsive trước khi lan.
- **Wave B rủi ro cao**: nhiều trạng thái derive (careStatus, order_sync, match labels) + workflow mobile (submit/care/upload) — mỗi PR nhỏ, regression 2 persona.
- **FS staff process**: NGOÀI SCOPE (backlog — chỉ mở lại khi stakeholder duyệt persona FS riêng). Wave C chỉ gồm các surface admin QA được bằng super admin.
- KHÔNG đụng: Sidebar/BottomNav/MobileHeader structure (đã polish M0-M6 + FS), RichText editor, chart SVG (targets), export routes.
