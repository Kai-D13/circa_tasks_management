import { handleCareCommit } from '@/lib/care/import/handler'
import { careImportDeps } from '@/lib/care/server/importDeps'

// POST /api/care/import/commit — gửi lại ĐÚNG file đã preview + sha256 + kỳ.
// Server tự tính lại, stage theo khối rồi gọi RPC care_import_finalize (114) —
// RPC là nguồn quyết định kết quả ghi (SPEC B2 §2).
export async function POST(request: Request) {
  return handleCareCommit(request, careImportDeps())
}
