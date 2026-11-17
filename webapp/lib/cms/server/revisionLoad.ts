import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { parseCmsRevisionState, type CmsRevisionState } from '@/lib/cms/revision/model'
import {
  parseCmsRevisionArchive, parseCmsRevisionDetail, parseCmsRevisionList,
  type CmsRevisionArchivePage, type CmsRevisionDetail, type CmsRevisionListItem,
} from '@/lib/cms/revision/history'

// F-A — đọc lịch sử sửa bằng SESSION người gọi (RPC 131: super-only cho danh sách / chi tiết / số trước sửa; trạng thái che số cho
// mọi vai đọc được chương trình). Lỗi ⇒ { ok: false } (trang hiện lỗi, không danh sách rỗng giả). Chỉ gọi khi cmsRevisionReadable() (cổng đọc, r3 P1-02).

const TIMEOUT_MS = 30_000
type R<T> = { ok: true; data: T } | { ok: false; code: string }

async function call<T>(fn: string, args: Record<string, unknown>, parse: (raw: unknown) => T | null): Promise<R<T>> {
  try {
    const supabase = await createClient()
    const { data, error } = await supabase.rpc(fn, args).abortSignal(AbortSignal.timeout(TIMEOUT_MS))
    if (error) {
      const m = /\bCMS_[A-Z0-9_]+\b/.exec(String(error.message ?? ''))
      return { ok: false, code: m ? m[0] : 'LOAD_FAILED' }
    }
    const v = parse(data)
    return v === null ? { ok: false, code: 'DTO_INVALID' } : { ok: true, data: v }
  } catch {
    return { ok: false, code: 'LOAD_FAILED' }
  }
}

export const cmsLoadRevisionState = (programId: string): Promise<R<CmsRevisionState>> =>
  call('rpc_cms_program_revision_state', { p_program_id: programId }, parseCmsRevisionState)

export const cmsLoadRevisions = (programId: string): Promise<R<CmsRevisionListItem[]>> =>
  call('rpc_cms_program_revisions', { p_program_id: programId }, parseCmsRevisionList)

export const cmsLoadRevision = (revisionId: string): Promise<R<CmsRevisionDetail>> =>
  call('rpc_cms_program_revision', { p_revision_id: revisionId }, parseCmsRevisionDetail)

export const CMS_ARCHIVE_PAGE = 200

export const cmsLoadRevisionArchive = (revisionId: string, page: number): Promise<R<CmsRevisionArchivePage>> =>
  call('rpc_cms_program_revision_archive', { p_revision_id: revisionId, p_offset: Math.max(0, page - 1) * CMS_ARCHIVE_PAGE, p_limit: CMS_ARCHIVE_PAGE },
    parseCmsRevisionArchive)
