CRM -- Quản lý và chăm sóc khách hàng, trong đó mỗi dược sĩ chịu trách
nhiệm về một danh sách khách hàng được phân công, có thời hạn hoàn thành
và được đo lường hiệu quả chăm sóc.

Điểm quan trọng là không chỉ quản lý việc dược sĩ đã gọi điện hay chưa,
mà còn phải đo lường được bao nhiêu khách hàng được chăm sóc thành công
và bao nhiêu khách hàng phát sinh đơn hàng mới.

Dưới đây là đề xuất thiết kế tính năng cho Circa.

**1. Cấu trúc tính năng**

Phân cơ bản thành 2 tính năng

![](media/image1.png){width="6.5in" height="0.48333333333333334in"}

**2. Giao diện dành cho dược sĩ**

![A screenshot of a phone AI-generated content may be
incorrect.](media/image2.png){width="5.90434820647419in"
height="6.778929352580928in"}

Dữ liệu khách hàng, đơn hàng, danh sách sản phẩm đã mua được cập nhật từ
Circa.\
Phần lịch sử chăm sóc sẽ được update mới trên hệ thống của
Duocsi.circa.vn

**4. Quy định trạng thái và thời hạn chăm sóc**

Trạng thái kết quả chăm sóc và trạng thái công việc để báo cáo chính
xác.

  -----------------------------------------------------------------------
  **Kết quả dược sĩ cập   **Xử lý của hệ thống**
  nhật**
  ----------------------- -----------------------------------------------
  Không liên hệ được      Yêu cầu chọn ngày liên hệ lại

  Đã liên hệ -- chưa có   Hoàn thành lượt chăm sóc
  nhu cầu

  Khách hàng quan tâm     Tạo lịch theo dõi tiếp theo

  Hẹn chăm sóc lại        Yêu cầu chọn ngày hẹn

  Đã đặt đơn              Liên kết mã đơn, ghi nhận chuyển đổi

  Từ chối chăm sóc        Kết thúc và cập nhật tùy chọn liên hệ theo yêu
                          cầu của khách
  -----------------------------------------------------------------------

Một khách hàng có thể được chăm sóc nhiều lần. Mỗi lần đều phải tạo một
bản ghi lịch sử mới, không ghi đè nội dung chăm sóc trước đó.

Quy tắc bắt buộc:

-   Mỗi nhiệm vụ có một dược sĩ phụ trách, ngày phân công và hạn hoàn
    thành.

-   Mỗi lần chăm sóc phải chọn kết quả và nhập ghi chú trước khi lưu.

-   Nếu chưa liên hệ thành công, phải có ngày xử lý tiếp theo.

-   Nhiệm vụ chưa hoàn thành khi hết hạn sẽ tự động chuyển sang quá hạn.

-   Đơn hàng chỉ được ghi nhận chuyển đổi khi **xác thực được với hệ
    thống bán hàng**.

-   Cho phép Store Manager điều chỉnh phân công khi dược sĩ nghỉ việc,
    chuyển cửa hàng hoặc nghỉ phép.

**5. Dashboard cho quản lý**

Quản lý cần xem được hiệu suất theo cửa hàng và theo từng dược sĩ.

Ngoài tỷ lệ hoàn thành, dashboard nên có doanh thu từ đơn hàng chăm sóc,
số lượng khách hàng quay lại và tỷ lệ khách hàng tiếp tục mua trong vòng
30 ngày.

Cần thống nhất cách tính chuyển đổi và khoảng thời gian ghi nhận đơn
hàng trước khi triển khai, tránh ghi nhận nhầm các đơn phát sinh tự
nhiên.

![](media/image3.png){width="6.5in"
height="3.654166666666667in"}![](media/image4.png){width="6.5in"
height="4.333333333333333in"}

**6. Đề xuất triển khai theo hai giai đoạn**

Giai đoạn 1

**Quản lý và kiểm soát công việc**

Mục tiêu: Đảm bảo dược sĩ thực sự thực hiện công việc chăm sóc được
giao.

-   Tự động phân công danh sách khách hàng.

-   Hiển thị lịch sử mua hàng ba tháng.

-   Ghi nhận lịch sử, kết quả và ghi chú chăm sóc.

-   Quản lý thời hạn và tự động nhắc việc.

-   Dashboard hiệu suất của từng dược sĩ.

Giai đoạn 2

**Tối ưu doanh thu và tự động hóa**

Mục tiêu: Tăng tỷ lệ khách hàng quay lại và phát sinh đơn hàng.

-   Tự động gợi ý khách hàng đến kỳ mua lại.

-   Gợi ý sản phẩm phù hợp để dược sĩ xem xét, dựa trên lịch sử mua hàng
    và nhu cầu thực tế.

-   Liên kết kết quả chăm sóc với đơn hàng POS/online.

-   Tự động phân tích hiệu quả chăm sóc và doanh thu.
