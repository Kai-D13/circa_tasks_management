import { handleCareTemplate } from '@/lib/care/import/handler'
import { buildCareImportTemplate } from '@/lib/care/import/template'
import { careImportDeps } from '@/lib/care/server/importDeps'

// GET /api/care/import/template — file mẫu (dữ liệu giả), cùng cổng cờ + quyền import.
export async function GET() {
  return handleCareTemplate(careImportDeps(), buildCareImportTemplate)
}
