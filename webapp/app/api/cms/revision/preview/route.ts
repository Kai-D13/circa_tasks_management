import { handleCmsRevisionPreview } from '@/lib/cms/revision/handler'
import { cmsRevisionDeps } from '@/lib/cms/server/revisionDeps'

// POST /api/cms/revision/preview — F-A: kiểm file danh mục mong muốn (parser / validator / kiểm K của import) + dự toán tác động trước /
// sau trên cùng nguồn + RPC preview 131 (session super). KHÔNG đổi cấu hình. Cờ CMS_PROGRAM_REVISION_ENABLED OFF / DB chưa 131 ⇒ 404.
export async function POST(request: Request) {
  return handleCmsRevisionPreview(request, cmsRevisionDeps())
}
