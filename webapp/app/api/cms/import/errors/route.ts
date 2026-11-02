import { handleCmsImportErrors } from '@/lib/cms/import/handler'
import { cmsImportDeps } from '@/lib/cms/server/importDeps'

// GET /api/cms/import/errors?run_id=… — file lỗi .xlsx: toàn bộ dòng của các nhóm bị loại + cột Loi (SPEC §4.6).
export async function GET(request: Request) {
  return handleCmsImportErrors(request, cmsImportDeps())
}
