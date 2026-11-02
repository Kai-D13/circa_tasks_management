import { handleCmsImportPreview } from '@/lib/cms/import/handler'
import { cmsImportDeps } from '@/lib/cms/server/importDeps'

// POST /api/cms/import/preview — kiểm file danh mục CMS (.xlsx, sheet IMPORT_CMS), lưu import run, KHÔNG ghi danh mục.
// Route Handler (Server Action giới hạn 1 MB). Thứ tự kiểm (cờ → super admin → byte-cap → parse) và toàn bộ logic ở
// lib/cms/import/handler.ts.
export async function POST(request: Request) {
  return handleCmsImportPreview(request, cmsImportDeps())
}
