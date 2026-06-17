# PLAN (pending) — Chuyển lưu trữ file/ảnh sang Google Cloud Storage (GCS)

> **Trạng thái: PENDING** — tạm hoãn để ưu tiên batch Microsoft Teams. Lưu lại để không trôi mất. Sẽ thực hiện ở batch sau.
> Quyết định chốt (2026-06-16): **Direct-to-GCS · Public + Cloud CDN · Dual-read**.
> Tài liệu yêu cầu DevOps đi kèm: [devops-gcs-storage-request.md](devops-gcs-storage-request.md).

## Vì sao
Stakeholder muốn file/ảnh/submission lưu ở **Google Cloud Storage** (công ty chuẩn hóa GCP, KHÔNG phải AWS) + **giảm tải server** (Supabase self-host trên Coolify). Hiện upload đi browser → Supabase storage-api (Kong) → backend, 1 bucket PUBLIC `task-uploads`. Đã có sẵn GCP service account (BigQuery) + code ký JWT Google (`lib/targets/bigquery.ts`) → tái dùng cho GCS, **không cần SDK nặng**.

## Kiến trúc chốt
- **Direct-to-GCS:** browser upload THẲNG lên GCS (server cấp phiên *resumable upload* sau khi kiểm quyền), bỏ qua Supabase → giảm disk + băng thông + CPU.
- **Public + Cloud CDN:** object public-read, serve qua CDN/public URL → component hiển thị KHÔNG đổi. Chỉ UPLOAD cần ủy quyền.
- **Dual-read:** file cũ vẫn đọc từ Supabase, chỉ file MỚI lên GCS. Không migrate, không downtime (DB lưu full URL nên render hỗn hợp tự chạy).
- **Provider flag** `STORAGE_PROVIDER=gcs|supabase` để bật/tắt nhanh.

"GCS có giảm tải không?" → CÓ với hướng direct (upload/download/disk rời khỏi Supabase). (Đổi STORAGE_BACKEND Supabase sang GCS chỉ giảm disk — đã loại.)

## Luồng upload (file mới)
1. Browser gọi server action `createUploadUrl({scope, taskId|storeId|uploadId, filename, contentType, size})`.
2. Server **kiểm quyền** (mirror RLS storage migration 033: `tasks/<id>/*`=assignee|store_manager; `task-inputs/*`=admin; `prescriptions/<storeId>/*`=staff/manager đúng store) + validate size/type (`validateAttachments`) + `safeStorageName`.
3. Server lấy OAuth token (tái dùng `getAccessToken`, scope `devstorage.read_write`) → khởi tạo resumable session (`POST .../upload/storage/v1/b/<bucket>/o?uploadType=resumable&name=<key>`, kèm `Origin`) → trả `{ sessionUrl, key, publicUrl }`.
4. Browser PUT bytes thẳng lên `sessionUrl` → lưu `publicUrl` như cũ (DB shape không đổi).

## Các bước build (phased)
- **P0** — Tách `getAccessToken`/`loadServiceAccount` từ `lib/targets/bigquery.ts` ra `lib/google/auth.ts` (thêm tham số scope); bigquery import lại. Không đổi hành vi.
- **P1** — `lib/storage/gcs.ts`: `createResumableUploadSession`, `publicUrlForKey`, `deleteObject`, `getObjectBytes`. Không SDK.
- **P2** — `app/actions/uploads.ts` `createUploadUrl()` — **ranh giới bảo mật mới thay storage RLS** → viết & test kỹ từng vai trò.
- **P3** — Đổi 5 chỗ client upload sau flag: `TaskInputAttachments`, `MultiImageUpload`, `FileUploadInput`, `PrescriptionImageUpload`, Excel import (`TaskForm`). Giữ nhánh Supabase khi flag=supabase.
- **P4** — Server ops GCS: Excel import đọc file (`tasks.ts`), cleanup cron + best-effort remove xóa theo `task_uploaded_files.bucket` (dual-provider).
- **P5** — `next.config.ts` thêm domain CDN vào `images.remotePatterns`; cập nhật `.env.example`. QA.
- **P6 (sau)** — migrate file cũ: hoãn (đã chọn dual-read).

## Phụ thuộc & rủi ro
- Cần DevOps hoàn tất: bucket + public-read (kiểm Org Policy Public Access Prevention) + Cloud CDN + service account `objectAdmin` (key base64) + CORS + env (`STORAGE_PROVIDER/GCS_BUCKET/GCP_PROJECT_ID/GCS_SA_KEY/GCS_PUBLIC_BASE_URL`).
- **Không thêm npm dep.** Rủi ro chính: chuyển upload-authz từ DB-RLS sang server action → phải mirror chính xác migration 033.

## Verify
Upload mới vào GCS (kiểm console) + DB lưu CDN URL + hiển thị OK; vai trò sai → bị từ chối. Dual-read: file cũ (Supabase) + mới (GCS) đều hiện. Excel import đọc từ GCS. Cleanup xóa đúng provider. Đo request `/storage/v1/*` của Supabase giảm.
