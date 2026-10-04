# CONTRACT — Chăm sóc khách hàng (CRM-CSKH)

> Hợp đồng nghiệp vụ. Chỉ ghi điều **đã chốt với stakeholder**; mọi thứ khác nằm ở `research/crm-cskh-handoff/OPEN_QUESTIONS.md`.
> Trạng thái: **DRAFT v0 — chưa có mục nào được chốt**. Nguồn: `research/crm-cskh-handoff/00_SOURCE_stakeholder_raw.md` (CMS.docx, 04/10/2026).

## 1. Mục tiêu (từ tài liệu gốc)
Mỗi dược sĩ chịu trách nhiệm một danh sách khách được phân công, có hạn hoàn thành. Đo được: (a) bao nhiêu khách được chăm sóc thành công, (b) bao nhiêu khách phát sinh đơn mới (chuyển đổi, doanh thu).

## 2. Phạm vi
- **GĐ1 (build)**: phân công danh sách khách · lịch sử mua 3 tháng · ghi nhận kết quả + ghi chú · hạn & tự chuyển quá hạn + nhắc việc · dashboard theo dược sĩ/cửa hàng.
- **GĐ2 (không build)**: gợi ý khách đến kỳ mua lại, gợi ý sản phẩm, tự khớp đơn POS/online, phân tích tự động.
- **Ngoài phạm vi**: thuật toán chọn khách cần chăm sóc ("logic ở bên ngoài" — admin chuẩn bị file).

## 3. Quy tắc stakeholder đã nêu (chờ xác nhận lại từng dòng)
| # | Quy tắc | Trạng thái |
|---|---|---|
| R1 | 6 kết quả chăm sóc: Không liên hệ được · Đã liên hệ–chưa có nhu cầu · Khách quan tâm · Hẹn chăm sóc lại · Đã đặt đơn · Từ chối | nêu trong docx |
| R2 | Mỗi lượt chăm sóc = 1 bản ghi mới, không ghi đè (append-only) | nêu trong docx |
| R3 | Mỗi nhiệm vụ: đúng 1 dược sĩ, ngày phân công, hạn hoàn thành | nêu trong docx |
| R4 | Mỗi lượt phải chọn kết quả + nhập ghi chú; chưa liên hệ được thì phải có ngày xử lý tiếp | nêu trong docx |
| R5 | Hết hạn chưa xong → tự chuyển Quá hạn | nêu trong docx |
| R6 | Đơn chỉ tính chuyển đổi khi **xác thực được với hệ thống bán hàng** | nêu trong docx |
| R7 | Store Manager được điều chỉnh phân công (nghỉ việc / chuyển cửa hàng / nghỉ phép) | nêu trong docx — "Store Manager" là ai trên app: **Q-21** |

## 4. Chưa chốt — chặn thiết kế (🔴)
| Mã | Câu hỏi | Người trả lời |
|---|---|---|
| Q-23 | Nguồn dữ liệu khách / lịch sử mua 3 tháng / đơn để xác thực — app hiện **không có** | BI + stakeholder |
| Q-21 | "Store Manager" = tài khoản QLCH dùng chung hay `sm` quản lý vùng? | stakeholder |
| Q-22 | Phòng nào sở hữu module (gate admin theo phòng)? | stakeholder |
| Q-24 | File import có sẵn cửa hàng + dược sĩ (email) không? | stakeholder + BI |
| Q-27 | Quan hệ với module Toa có ngày dùng (tránh nhắc trùng) | stakeholder |
| Q-01/03/14/15 | Phân công tự động? Khi nào task Hoàn thành? Cửa sổ tính chuyển đổi? GĐ1 có xác thực đơn? | stakeholder |

## 5. Khi chốt
Ghi vào `research/crm-cskh-handoff/DECISIONS.md` (mã Q, ngày, quyết định, người chốt) rồi cập nhật mục 3–4 ở đây. Mục nào chốt xong mới được đưa vào `SPEC.md`.
