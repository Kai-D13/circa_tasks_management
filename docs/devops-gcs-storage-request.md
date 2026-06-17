# Yêu cầu DevOps — Thiết lập Google Cloud Storage (GCS) cho lưu trữ file/ảnh

**Người yêu cầu:** team Circa Tasks (app `https://duocsi.circa.vn`)
**Ngày:** 2026-06-16
**Mục tiêu:** Chuyển nơi lưu trữ file/ảnh/submission của app từ **Supabase Storage (self-host trên Coolify)** sang **Google Cloud Storage**, để (1) chuẩn hóa theo hạ tầng GCP của công ty và (2) **giảm tải server** (đưa upload/download/disk ra khỏi server Supabase).

---

## 1. Tóm tắt cách app sẽ dùng GCS (để DevOps hiểu ngữ cảnh)

- **Upload:** Trình duyệt người dùng **upload THẲNG lên GCS**, không đi qua server Supabase nữa.
  - App (server) sẽ kiểm tra quyền của user → **khởi tạo một phiên "resumable upload"** trên GCS bằng OAuth token của service account → trả về cho trình duyệt một **session URL** (trên `storage.googleapis.com`).
  - Trình duyệt **PUT** trực tiếp dữ liệu file lên session URL đó (cross-origin → **cần CORS**).
- **Serve (xem file):** object để **public-read**, app lưu URL công khai và hiển thị trực tiếp (qua **Cloud CDN** nếu có, hoặc tạm `https://storage.googleapis.com/<bucket>/<key>`).
- **Xóa file / đọc file phía server:** app (server) gọi GCS JSON API bằng token của service account (cleanup file rác, đọc file Excel import).
- **Xác thực:** dùng **service account key (JSON)** ở phía **server** để lấy OAuth token (scope `devstorage.read_write`). **Key không bao giờ lộ ra trình duyệt.** (App đã làm y hệt cách này cho BigQuery rồi.)

> App **không dùng SDK nặng** — chỉ gọi REST API của Google bằng token, giống tích hợp BigQuery hiện có.

---

## 2. CẦN DevOps tạo / cấu hình (checklist)

### 2.1. Bucket
- [ ] Tạo **1 bucket GCS**. Tên đề xuất: `circa-tasks-prod` (tên phải duy nhất toàn cầu — nếu trùng, thêm hậu tố, vd `circa-tasks-prod-vn`).
- [ ] **Region:** `asia-southeast1` (Singapore) — gần VN nhất.
- [ ] **Uniform bucket-level access:** BẬT (quản quyền bằng IAM, không dùng ACL từng file).
- [ ] **Object Versioning:** tùy chọn (khuyến nghị tắt để tiết kiệm, hoặc bật nếu cần khôi phục).
- [ ] Cho biết bucket thuộc **project GCP nào** (cùng project BigQuery `lakehouse-prod-394907` hay project khác?).

### 2.2. Quyền truy cập công khai (Public read)
- [ ] Cấp `roles/storage.objectViewer` cho `allUsers` trên bucket → mọi object public-read.
  - Lệnh: `gsutil iam ch allUsers:objectViewer gs://circa-tasks-prod`
- [ ] **QUAN TRỌNG — kiểm tra Org Policy "Public Access Prevention":** nếu tổ chức **bắt buộc** (enforced) chặn public access thì KHÔNG thể public bucket. **Vui lòng xác nhận giúp.** Nếu bị chặn → app sẽ chuyển sang **private + signed URL** (báo lại để bên dev đổi cấu hình tương ứng).

### 2.3. Cloud CDN (tùy chọn nhưng mong muốn)
- [ ] Tạo **External HTTPS Load Balancer + Backend Bucket** trỏ vào bucket, bật **Cloud CDN**.
- [ ] Gắn **domain** (vd `cdn.circa.vn`) + **SSL cert** (Google-managed) + bản ghi DNS.
- [ ] Trả về **domain CDN** để app dùng làm `GCS_PUBLIC_BASE_URL`.
- [ ] *Ghi chú:* CDN **không bắt buộc để chạy**. Có thể launch trước với `https://storage.googleapis.com/<bucket>`, gắn CDN sau (chỉ đổi 1 biến env).

### 2.4. Service Account (SA) + IAM
- [ ] **Cách A (đơn giản):** dùng lại SA BigQuery hiện có, **thêm** role `roles/storage.objectAdmin` **trên bucket** này.
- [ ] **Cách B (sạch hơn, khuyến nghị):** tạo SA riêng vd `circa-storage@<project>.iam.gserviceaccount.com`, cấp `roles/storage.objectAdmin` **trên bucket** (không cần project-wide).
- [ ] Tạo **JSON key** cho SA đó, rồi **encode base64** trước khi đưa cho dev:
  - Lệnh: `base64 -w0 key.json` (Linux) → chuỗi 1 dòng.
  - Lý do base64: JSON có dấu nháy / `\n` / `+` / `=` hay bị editor env (Coolify) làm hỏng → base64 an toàn (BigQuery đang dùng đúng cách này).
- [ ] `objectAdmin` đủ cho: tạo (upload), đọc, xóa object. (Không cần `signBlob` vì app dùng resumable-session-token, không ký V4.)

### 2.5. CORS trên bucket (BẮT BUỘC — để trình duyệt upload thẳng)
- [ ] Áp file CORS sau: `gsutil cors set cors.json gs://circa-tasks-prod`

`cors.json`:
```json
[
  {
    "origin": ["https://duocsi.circa.vn"],
    "method": ["GET", "PUT", "POST", "HEAD", "OPTIONS"],
    "responseHeader": ["Content-Type", "Content-Range", "Content-Length", "x-goog-resumable", "Location", "Range", "ETag"],
    "maxAgeSeconds": 3600
  }
]
```
> Nếu sau này có domain khác (staging…) thì thêm vào `origin`.

### 2.6. (Tùy chọn) Lifecycle / Encryption
- [ ] Lifecycle rule xóa object rác (nếu muốn) — app cũng có cron tự dọn.
- [ ] CMEK (KMS) nếu compliance yêu cầu mã hóa bằng key riêng (mặc định Google đã mã hóa at-rest).

---

## 3. Biến môi trường cần cấp lại cho app (đặt trong Coolify → service app → Environment Variables, **server-only**, KHÔNG prefix `NEXT_PUBLIC_`)

| Biến | Ví dụ giá trị | Ghi chú |
|---|---|---|
| `STORAGE_PROVIDER` | `gcs` | Bật GCS cho upload mới (mặc định `supabase` nếu chưa set) |
| `GCS_BUCKET` | `circa-tasks-prod` | Tên bucket |
| `GCP_PROJECT_ID` | `lakehouse-prod-394907` | Project chứa bucket |
| `GCS_SA_KEY` | `<chuỗi base64 của JSON key>` | SA có `objectAdmin` trên bucket (có thể dùng lại key BQ nếu SA chung) |
| `GCS_PUBLIC_BASE_URL` | `https://cdn.circa.vn` hoặc `https://storage.googleapis.com/circa-tasks-prod` | Tiền tố URL công khai để app dựng link hiển thị |

> Đặt `GCS_SA_KEY` dạng **secret**. Nếu dùng SA chung với BigQuery, có thể trỏ app đọc cùng key — sẽ thống nhất với bên dev khi tích hợp.

---

## 4. Các endpoint Google mà app sẽ gọi (để DevOps nắm luồng mạng / egress)

| Mục đích | Phương thức & URL | Bên gọi |
|---|---|---|
| Lấy OAuth token | `POST https://oauth2.googleapis.com/token` | App server |
| Khởi tạo upload | `POST https://storage.googleapis.com/upload/storage/v1/b/<bucket>/o?uploadType=resumable&name=<key>` (kèm header `Origin: https://duocsi.circa.vn`) | App server |
| Upload dữ liệu | `PUT <session URL trả về ở bước trên>` | **Trình duyệt** (cần CORS) |
| Xóa object | `DELETE https://storage.googleapis.com/storage/v1/b/<bucket>/o/<key>` | App server |
| Đọc object (Excel import) | `GET https://storage.googleapis.com/storage/v1/b/<bucket>/o/<key>?alt=media` | App server |
| Hiển thị file | `GET https://<GCS_PUBLIC_BASE_URL>/<key>` | Trình duyệt (public/CDN) |

Cấu trúc key (đường dẫn) sẽ giữ như hiện tại: `tasks/<taskId>/...`, `task-inputs/<id>/...`, `prescriptions/<storeId>/<submissionId>/...`.

---

## 5. Q&A — câu DevOps hay hỏi & câu trả lời

**Q: Bucket public hay private?**
A: **Public-read** (theo quyết định nghiệp vụ hiện tại — dữ liệu task vốn đang public). Nếu Org Policy chặn public → chuyển sang **private + signed URL**, báo lại để bên dev đổi cấu hình.

**Q: App xác thực với GCS thế nào? Có an toàn không?**
A: Dùng **service account key ở server** để lấy OAuth token (scope `devstorage.read_write`). Key **không** xuất hiện ở trình duyệt. Trình duyệt chỉ nhận một session URL ngắn hạn, chỉ dùng được cho **đúng 1 object**.

**Q: Sao phải mở CORS? Có rủi ro không?**
A: Vì trình duyệt PUT thẳng file lên `storage.googleapis.com` (khác origin với app). CORS chỉ cho phép **origin `https://duocsi.circa.vn`**; không mở rộng cho origin lạ. Quyền ghi vẫn do app kiểm soát (chỉ app mới tạo được session upload).

**Q: Cần cấp quyền gì cho service account?**
A: `roles/storage.objectAdmin` **trên bucket** (tạo/đọc/xóa object). Cho public-read: `allUsers:objectViewer`. Không cần quyền project-wide.

**Q: Dùng lại service account của BigQuery được không?**
A: Được — chỉ cần thêm role `storage.objectAdmin` cho SA đó trên bucket mới. Hoặc tạo SA riêng (sạch hơn).

**Q: Giới hạn dung lượng / loại file?**
A: App tự giới hạn phía client + server: ảnh ≤ 5MB, audio ≤ 15MB, file khác ≤ 10MB, tổng ≤ 30MB/task. DevOps không cần ép thêm (có thể đặt lifecycle nếu muốn).

**Q: CDN có bắt buộc không?**
A: Không. Có thể chạy trước bằng `https://storage.googleapis.com/<bucket>`; gắn Cloud CDN sau, chỉ đổi `GCS_PUBLIC_BASE_URL`.

**Q: Bucket region nên ở đâu?**
A: `asia-southeast1` (Singapore) — gần người dùng VN nhất.

**Q: File cũ đang ở Supabase có cần chuyển sang GCS không?**
A: **Không (đợt này).** App dùng cơ chế "dual-read": file cũ vẫn đọc từ Supabase, chỉ file MỚI lên GCS. Không downtime, không cần migrate. (Có thể migrate sau nếu muốn gom 1 nguồn.)

**Q: Chi phí?**
A: Gồm lưu trữ (theo GB/tháng) + egress (băng thông tải về). Cloud CDN giúp giảm egress nhờ cache. Quy mô hiện tại nhỏ (ảnh/file task), chi phí thấp.

**Q: Khi nào cần xong?**
A: Bên dev có thể build sẵn phần code không phụ thuộc bucket. Cần DevOps cung cấp **bucket + SA key (base64) + CORS + env** trước khi bật `STORAGE_PROVIDER=gcs` trên prod.

---

## 6. Bàn giao — DevOps gửi lại cho bên dev

- [ ] Tên **bucket** + **project id** + **region**.
- [ ] Xác nhận **public-read đã bật** (hoặc trạng thái Org Policy nếu bị chặn).
- [ ] **CORS** đã áp (xác nhận).
- [ ] **Service account JSON key (base64)** — gửi qua kênh bảo mật (không dán chat công khai).
- [ ] **Domain CDN** (hoặc "tạm dùng storage.googleapis.com").
- [ ] Giá trị 5 biến env ở mục 3.
- [ ] (Bonus) Xác nhận **STORAGE_BACKEND hiện tại của Supabase** (local disk hay S3/minio) — để bên dev ước lượng mức giảm tải disk sau khi chuyển.

---

## 7. Bảo mật & lưu ý
- SA key là bí mật → lưu dạng secret trong Coolify, không commit vào git, không gửi qua kênh công khai.
- Public bucket = mức công khai **giống hiện trạng** (Supabase task-uploads vốn đã public). Nếu cần siết ảnh nhạy cảm (đơn thuốc) → chuyển nhóm đó sang private + signed URL ở pha sau.
- Quyền ghi vào bucket **chỉ qua app** (app kiểm tra vai trò người dùng trước khi cấp session upload) — đây là lớp kiểm soát thay cho RLS của Supabase Storage.
