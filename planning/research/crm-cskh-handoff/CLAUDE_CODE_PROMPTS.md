# Prompt dùng với Claude Code — theo thứ tự

> Chuẩn bị: copy cả thư mục `crm-cskh-handoff/` vào repo, ví dụ `docs/features/crm-cskh/`.
> Nguyên tắc: **không bảo Claude Code "build hết"** trong 1 lần. Đi theo từng bước, review rồi mới cho đi tiếp. Dùng Plan mode (Shift+Tab) cho bước 0–1.

---

## Bước 0 — Thêm vào `CLAUDE.md` của repo (1 lần)

```md
## Feature đang làm: Chăm sóc khách hàng (CRM-CSKH)
- Spec: docs/features/crm-cskh/SPEC.md (source of truth)
- Câu hỏi mở: docs/features/crm-cskh/OPEN_QUESTIONS.md
- Mockup: docs/features/crm-cskh/mockups/ (chỉ tham khảo bố cục, UI theo design system hiện có)
- Quyết định đã chốt: docs/features/crm-cskh/DECISIONS.md
- Quy ước: gặp chỗ [CẦN XÁC NHẬN Q-xx] → dùng mặc định trong SPEC, để dễ cấu hình, comment `// TODO(Q-xx)`.
- Không tự ý thêm tính năng Giai đoạn 2.
```

## Bước 1 — Khảo sát codebase & lập kế hoạch (KHÔNG code)

```
Đọc docs/features/crm-cskh/SPEC.md, OPEN_QUESTIONS.md và xem 4 ảnh trong mockups/.
Sau đó khảo sát codebase hiện tại và CHƯA viết code. Trả về:

1. Tóm tắt lại bằng lời của bạn: module này giải quyết vấn đề gì, ai dùng, luồng chính.
2. Mapping với codebase: stack, cấu trúc thư mục, auth/phân quyền hiện có, các entity
   đã có tương ứng (Customer, Order, Product, Store, User/Pharmacist), cách app đang
   lấy dữ liệu Circa, cơ chế job/cron, notification, upload file, export Excel, design system.
3. Cho từng bảng ở SPEC mục 8: tái dùng bảng nào, tạo mới bảng nào, migration ra sao.
4. Danh sách file sẽ tạo/sửa theo từng slice ở SPEC mục 15.
5. Những điểm trong SPEC mâu thuẫn với codebase hoặc chưa đủ thông tin để code
   (bổ sung vào OPEN_QUESTIONS nếu là câu hỏi mới, đánh số tiếp Q-21...).
6. Rủi ro kỹ thuật (import 10.000 dòng, đồng bộ Circa, timezone, phân quyền).

Ghi kết quả vào docs/features/crm-cskh/IMPLEMENTATION_PLAN.md.
```

👉 **Bạn review** `IMPLEMENTATION_PLAN.md`: kiểm tra Claude hiểu đúng nghiệp vụ (mục 1) và mapping (mục 2–3). Sửa trực tiếp nếu sai rồi mới sang bước 2.

## Bước 2+ — Code từng slice

```
Triển khai Slice <số> trong SPEC mục 15: <tên slice>.
Tuân thủ IMPLEMENTATION_PLAN.md và các BR/AC liên quan: <liệt kê, ví dụ BR-02, BR-03, BR-04, AC-05, AC-06>.
Yêu cầu:
- Viết test cho business rule và state machine trước, rồi code cho test pass.
- Phân quyền kiểm tra ở backend.
- Không đụng tới phần ngoài slice này.
- Xong thì: chạy test/lint, liệt kê file đã đổi, AC nào đã đạt, TODO(Q-xx) còn lại.
```

Gợi ý tham chiếu BR/AC theo slice:

| Slice | Nội dung | BR / AC |
|---|---|---|
| 1 | Schema, enum, state machine | Mục 6, BR-01, BR-04, BR-09 |
| 2 | Import & validate | Mục 7.1, BR-08, BR-09, AC-01 |
| 3 | Phân công + thông báo | Mục 7.2, AC-02, AC-03 |
| 4 | Mobile M1–M5 | Mục 9.1, BR-10, BR-11, AC-04 |
| 5 | Ghi nhận chăm sóc M6/W7 | Mục 6.1, BR-02, BR-03, BR-04, AC-05, AC-06, AC-10 |
| 6 | Jobs quá hạn & nhắc | BR-05, mục 11–12, AC-07 |
| 7 | Xác thực đơn | Mục 7.3, AC-08 |
| 8 | Điều chỉnh phân công | BR-07, AC-09 |
| 9 | Dashboard & export | Mục 10, AC-11, AC-12 |

## Khi stakeholder trả lời câu hỏi

```
Stakeholder đã chốt: Q-03 = <câu trả lời>, Q-14 = <...>.
Cập nhật DECISIONS.md và SPEC.md tương ứng, rồi tìm mọi TODO(Q-03), TODO(Q-14)
trong code, sửa theo quyết định mới, cập nhật test.
```

## Bước cuối — Tự kiểm tra theo AC

```
Đi qua từng AC-01..AC-12 trong SPEC mục 14. Với mỗi AC: đạt / chưa đạt / chưa test được,
kèm test hoặc bước kiểm tra thủ công tương ứng. Không sửa code ở bước này.
```
