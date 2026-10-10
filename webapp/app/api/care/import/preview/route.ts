import { handleCarePreview } from '@/lib/care/import/handler'
import { careImportDeps } from '@/lib/care/server/importDeps'

// POST /api/care/import/preview — kiểm file Excel N1, CHỈ ĐỌC (SPEC B2 §2).
// Route Handler (không Server Action: giới hạn 1 MB). Toàn bộ logic + thứ tự kiểm
// (cờ → quyền session → byte-cap → parse) ở lib/care/import/handler.ts.
export async function POST(request: Request) {
  return handleCarePreview(request, careImportDeps())
}
