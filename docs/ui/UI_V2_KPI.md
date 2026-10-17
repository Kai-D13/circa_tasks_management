# UI v2 — Phase 2 "Chiến dịch KPI" (ngoại lệ circa-ui CÓ PHẠM VI)

> PM GO triển khai có giới hạn 16/10/2026 (`planning/research/ui-v2-campaigns-kpi-phase2-spec-2026-10-16.md`,
> `planning/reviews/2026-10-16-ui-v2-kpi-phase2-plan-pm.md`) · nhánh `feat/ui-v2-kpi` trên `feat/ui-v2-tasks` @ `20ee3ef`.
> Nguồn design: canvas Claude Design "Circa Tasks — Redesign v2 · Phase 2 Chiến dịch KPI" (K0 component · K1–K6 desktop ·
> M1–M6 mobile). Giá trị dưới đây COPY từ canvas, không tự chỉnh. **Kế thừa nguyên Foundation v2 của Tasks:**
> `docs/ui/UI_V2_TASKS.md` §1–§3 (cơ chế `data-ui-v2`, variant `v2:`, token nền, bán kính, portal/shell ngoài phạm vi).

## 1. Phạm vi
- Route (bật dần theo batch, `data-ui-v2="page"` ở page-root từng route, không đặt ở layout): `/targets/campaigns`,
  `/targets/campaigns/[id]` (`?tab=result|config`), `/targets/campaigns/new`, `/targets/campaigns/affiliate`, `/targets`
  (super · SM · QLCH · staff theo quyền hiện có). Catalog demo: **`/ui-catalog/kpi-v2`** (fixture, `UI_CATALOG=1` + super).
- **Visual-only:** giữ truy vấn, RPC, action, RLS, cờ, URL/search param (`?campaign=`, `?tab=`, `?period=`, filter
  Affiliate), redirect, export, import target (`CampaignImport` vẫn nhận `.xlsx/.xls/.csv` — KHÔNG đổi theo N1 CSKH),
  công thức KPI (`campaignDisplay`, `resultModel`, `performance`, `orderAov`, `orderBonus`) và quyền từng vai.
- **Chữ:** giữ wording đang chạy. ~30 câu mới trong artboard là đề xuất thiết kế, chờ stakeholder; nhãn đã có được
  phép dời chỗ.

## 2. Token KPI (bổ sung cho bộ v2 — chỉ dưới `[data-ui-v2]`, ngoài phạm vi rỗng)
| Token | Light | Dark | Dùng cho |
|---|---|---|---|
| `--v2-series` | `#E8622A` | `#F3743F` | chuỗi số liệu chính: thanh tiến độ đang chạy, cột biểu đồ (light **khác** action `#C94A16`) |
| `--v2-series-soft` | `#F6C2A9` | `#6B3A24` | nền phụ của chuỗi (dự phòng; K-0 chưa dùng trên route) |
| `--v2-ok` | `#2F9E5B` | `#5BBF7E` | đạt (≥ 100% theo model hoặc đạt bậc / `qualityKpiPass`) |
- Class: `bg-v2-series`, `fill-v2-series`, `bg-v2-ok`… — luôn đi kèm màu mặc định ngoài v2 (`bg-primary v2:bg-v2-series`)
  vì component KPI dùng chung giữa route đã/chưa chuyển v2.
- **Đã kết thúc:** KHÔNG có token `done` — dùng `--v2-text-3` theo theme (PM 16/10). Chỉ cho chiến dịch kết thúc **chưa đạt**; kết thúc mà **đạt thật** vẫn `--v2-ok` (PM audit K-1 §3). Badge trạng thái "Kết thúc" luôn trung tính.
- Trạng thái (Đang chạy/Tạm dừng/Nháp/Kết thúc/TEST, đồng bộ, nhịp độ) = ds `StatusBadge` (có chấm trong v2); loại
  chiến dịch = ds `TagBadge` hue blue (Doanh số) · teal (Số khách) · indigo (Chất lượng bán hàng).
- Chữ số luôn màu chữ (không màu chuỗi), `tabular-nums`.

## 3. Component K0 (miền KPI ở `components/kpi/`, khung dùng chung ở `components/ds/`)
| Component | Vai trò | Hợp đồng |
|---|---|---|
| ds `ProgressBar` | thanh tiến độ | thêm tone `series` · `ok` · `ended` và `size` 5/6/8/10/12px; mặc định (tone success, 5px) không đổi; `ariaLabel` bắt buộc |
| `lib/kpi/progressTone.kpiProgressTone` | chọn trạng thái hiển thị | từ CỜ model `{ synced, ended, reached }` — không suy từ số làm tròn; `unsynced` > `ok` (đạt THẬT, kể cả đã kết thúc) > `ended` (kết thúc chưa đạt, trung tính) > `series` — PM audit K-1 §3 (16/10), sửa ở K-2 |
| `KpiProgressMeter` | K0 "ProgressMeter 4 trạng thái" | nhãn + số + thanh + gợi ý; `unsynced` ⇒ khung nét đứt, không `role=progressbar`, số `—` (không 0% giả) |
| `TierTrack` | tiến độ + mốc thưởng | thang 0 → mốc cao nhất + 10 (`tierTrackScaleMax`, tối thiểu 100); vạch = ngưỡng thật; thẻ bậc ≤4 lưới / 5+ dọc; nhãn vạch quá gần ⇒ hàng 2; chữ "N%", "Thưởng: …"; dòng còn thiếu do caller truyền; commission là của STORE |
| `PaceBadge` | badge nhịp độ | `performanceStatusTone` cùng ngưỡng `performanceTone` (≥100 · ≥80 · còn lại); null ⇒ `—` trung tính |
| `CampaignDailyChart` | biểu đồ ngày | v2: cột `series`, hôm nay đậm/cột khác 55%, số màu chữ, ngày tương lai vạch thấp. Prop **`requiredPerDay`** (PM P1): đường nét đứt "Trung bình/ngày cần đạt" từ hôm nay → hết kỳ, **chỉ GMV**, chỉ khi giá trị thật > 0 và hôm nay trong kỳ; chú giải bằng chữ với số đầy đủ. Không truyền ⇒ DOM như cũ |
- Số rút gọn (trục biểu đồ) dùng `metricPresentation(...).compact` hiện có; số đầy đủ có ở ô/tile/chú giải bằng chữ.
  Tooltip cột vẫn là `<title>` (chuột) — xem giới hạn trong report K-0.

## 4. Nghiệm thu chung mỗi batch
Theo spec PM §5: tsc → spec liên quan → full Playwright → build → diff-check; số `.from/.rpc/.select/.eq/.order`,
`searchParams`, href, flag, action trước/sau (mốc: `planning/reports/2026-10-16-ui-v2-kpi-baseline-counts.txt`); ảnh
chỉ từ fixture; test theo vai super/SM/QLCH/staff/FS; null ≠ 0; Số đơn + AOV không gộp.

## 5. Fixture bất khả gọi action (PM 17/10 P1)
- Trang `/ui-catalog/kpi-v2/*` dựng CHÍNH component của route thật nên phải bọc **`<KpiFixtureBoundary>`**
  (`components/kpi/KpiFixtureBoundary.tsx`). Component có server action hoặc export gọi `useFixtureActionBlocked()` và
  `if (fixtureBlocked()) return` **ngay trước** lời gọi. Trong boundary: toast "Bản mẫu UI…", không action, không request.
  Ngoài boundary (route thật): luôn `false`, action giữ nguyên. Không dùng CSS (`pointer-events`) làm lớp bảo vệ.
- Route thật **không** import boundary. Component mới có `from '@/app/actions/…'` trong `components/kpi|affiliate`
  phải thêm guard; spec quét nguồn sẽ đỏ nếu thiếu.
- Test fixture dùng `e2e/fixtureGuard.ts` → `trapWrites`: ghi nhận rồi abort mọi request ghi ngay trong trình duyệt.
  Khẳng định bộ đếm `[data-kpi-fixture-blocked]` và **0 request**. Route thật chỉ kiểm "vẫn gửi đúng 1 server action"
  bằng request đã bị abort, không bao giờ tới máy chủ.
