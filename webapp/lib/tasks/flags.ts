import 'server-only'

// T1-B: lưu trữ / khôi phục hàng loạt trên /tasks qua RPC 117 (rpc_set_tasks_archived). OFF = nút bulk ẩn + action trả lỗi
// trước mọi đọc/ghi — KHÔNG quay về đường ghi cũ (supabaseAdmin). Chỉ bật sau khi DB đã chạy 117 + VERIFY quyền RPC + QA.
// Server-only; TaskList (client) nhận giá trị qua prop từ trang /tasks.
export function isTasksArchiveRpcEnabled(): boolean {
  return process.env.TASKS_ARCHIVE_RPC_ENABLED === 'true'
}
