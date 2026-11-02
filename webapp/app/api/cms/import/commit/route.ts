import { handleCmsImportCommit } from '@/lib/cms/import/handler'
import { cmsImportDeps } from '@/lib/cms/server/importDeps'

// POST /api/cms/import/commit — gửi lại file + run_id + sha256; server parse / validate LẠI, kết quả khác preview ⇒ 409;
// ghi atomic qua RPC rpc_cms_import_commit (migration 121). Logic ở lib/cms/import/handler.ts.
export async function POST(request: Request) {
  return handleCmsImportCommit(request, cmsImportDeps())
}
