import { handleCmsRevisionCommit } from '@/lib/cms/revision/handler'
import { cmsRevisionDeps } from '@/lib/cms/server/revisionDeps'

// POST /api/cms/revision/commit — F-A: ghi revision đã preview (preview_id + config_version + digest + idempotency + lý do + xác nhận).
// Không nhận lại file / tóm tắt từ client; RPC 131 kiểm lại mọi điều kiện dưới khoá trong MỘT transaction. Không tự gọi đồng bộ.
export async function POST(request: Request) {
  return handleCmsRevisionCommit(request, cmsRevisionDeps())
}
