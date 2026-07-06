import 'server-only'
import { fmtVN } from '@/lib/export/xlsx'
import { publicStorageUrl } from '@/lib/storage/publicUrl'
import { formatTaskCode } from '@/lib/taskCode'

// Shared task-export select + row shaping, used by BOTH the filter export
// (GET /api/export/tasks) and the selected-ids export (POST .../selected) so the
// two files never drift.

export const TASK_EXPORT_SELECT =
  'seq, title, status, priority, category, source_schedule_id, assignment_mode, deadline, created_at, completed_at, overdue_at, stores(name), department:departments(name), assignee:users!assigned_to(full_name), completed_by_user:users!completed_by(full_name), task_uploaded_files(bucket, path, deleted_at)'

const STATUS_VI: Record<string, string> = {
  todo: 'Chờ thực hiện', in_progress: 'Đang thực hiện', done: 'Hoàn thành', overdue: 'Quá hạn',
}
const PRIORITY_VI: Record<string, string> = { urgent: 'Khẩn cấp', normal: 'Bình thường' }
const CATEGORY_VI: Record<string, string> = {
  training: 'Training', recall: 'Thu hồi / Kiểm kê', display: 'Trưng bày', audit: 'Kiểm tra', other: 'Khác',
}

const effStatus = (status: string, deadline: string | null): string =>
  status !== 'done' && deadline && Date.parse(deadline) < Date.now() ? 'overdue' : status

export function shapeTaskRows(data: Record<string, unknown>[]): Record<string, unknown>[] {
  return data.map((t) => {
    const submitter = (t.completed_by_user as { full_name?: string } | null)?.full_name
    const assignee = (t.assignee as { full_name?: string } | null)?.full_name
    const files = (t.task_uploaded_files as { bucket: string; path: string; deleted_at: string | null }[] | null) ?? []
    const fileLinks = files.filter((f) => !f.deleted_at).map((f) => publicStorageUrl(f.bucket, f.path)).join('\n')
    return {
      'Mã':              formatTaskCode((t as { seq?: number | null }).seq),
      'Tiêu đề':         t.title as string,
      'Cửa hàng':        (t.stores as { name?: string } | null)?.name ?? '',
      'Phòng ban':       (t.department as { name?: string } | null)?.name ?? '',
      'Loại':            (t.source_schedule_id as string | null) ? 'Định kỳ' : 'Phát sinh',
      'Trạng thái':      STATUS_VI[effStatus(t.status as string, t.deadline as string | null)] ?? (t.status as string),
      'Ưu tiên':         PRIORITY_VI[t.priority as string] ?? (t.priority as string),
      'Danh mục':        CATEGORY_VI[t.category as string] ?? (t.category as string ?? ''),
      'Người thực hiện': submitter ?? assignee ?? '',
      'Deadline':        fmtVN(t.deadline as string | null),
      'Ngày tạo':        fmtVN(t.created_at as string),
      'Ngày hoàn thành': fmtVN(t.completed_at as string | null),
      'Link ảnh/file':   fileLinks,
    }
  })
}
