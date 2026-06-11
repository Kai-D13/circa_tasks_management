// Shared log constants — used by the logs page (server) and LogFilters (client).

export const LOGS_PAGE_SIZE = 50

export const ACTION_COLORS: Record<string, string> = {
  created:                     'bg-blue-100 text-blue-700',
  updated:                     'bg-yellow-100 text-yellow-700',
  deleted:                     'bg-red-100 text-red-700',
  submitted:                   'bg-green-100 text-green-700',
  status_changed:              'bg-purple-100 text-purple-700',
  reassigned:                  'bg-orange-100 text-orange-700',
  resubmit_requested:          'bg-amber-100 text-amber-700',
  review_note:                 'bg-indigo-100 text-indigo-700',
  schedule_created:            'bg-teal-100 text-teal-700',
  schedule_paused:             'bg-gray-100 text-gray-600',
  schedule_resumed:            'bg-teal-100 text-teal-700',
  schedule_deleted:            'bg-red-100 text-red-700',
  recurring_tasks_generated:   'bg-teal-100 text-teal-700',
  cron_run_failed:             'bg-red-100 text-red-700',
  deadline_extended:           'bg-orange-100 text-orange-700',
  staff_all_instruction_updated: 'bg-yellow-100 text-yellow-700',
}

export const ACTION_LABELS: Record<string, string> = {
  created:                     'Đã tạo',
  updated:                     'Cập nhật',
  deleted:                     'Đã xoá',
  submitted:                   'Đã nộp',
  status_changed:              'Đổi trạng thái',
  reassigned:                  'Phân công lại',
  resubmit_requested:          'Yêu cầu làm lại',
  review_note:                 'Ghi chú đánh giá',
  schedule_created:            'Tạo lịch định kỳ',
  schedule_paused:             'Tạm dừng lịch',
  schedule_resumed:            'Kích hoạt lại lịch',
  schedule_deleted:            'Xóa lịch định kỳ',
  recurring_tasks_generated:   'Tạo task định kỳ',
  cron_run_failed:             'Cron lỗi',
  deadline_extended:           'Gia hạn deadline',
  staff_all_instruction_updated: 'Cập nhật hướng dẫn (toàn bộ dược sĩ)',
}

export const ACTION_OPTIONS = Object.entries(ACTION_LABELS)

const STATUS_VI: Record<string, string> = {
  todo:        'Chờ thực hiện',
  in_progress: 'Đang thực hiện',
  done:        'Hoàn thành',
  overdue:     'Quá hạn',
}

type Meta = Record<string, unknown>

export function formatMeta(action: string, metadata: Meta | null): string {
  if (!metadata) return '—'
  switch (action) {
    case 'reassigned':
      if (metadata.assignee_name) return `→ ${metadata.assignee_name}`
      if (metadata.assigned_to)   return '→ (đã phân công)'
      return 'Bỏ phân công'
    case 'status_changed': {
      const from = STATUS_VI[metadata.from as string] ?? metadata.from
      const to   = STATUS_VI[metadata.to   as string] ?? STATUS_VI[metadata.status as string] ?? metadata.to ?? metadata.status
      return metadata.from ? `${from} → ${to}` : `→ ${to}`
    }
    case 'created':
      if (metadata.method === 'bulk_import') return `Import: ${metadata.file ?? '—'}`
      if (metadata.assignee_name)            return `Giao cho: ${metadata.assignee_name}`
      return metadata.title ? `"${metadata.title}"` : '—'
    case 'updated':
      if (metadata.assignee_name) return `Giao cho: ${metadata.assignee_name}`
      return metadata.title ? `"${metadata.title}"` : '—'
    case 'submitted': {
      const types = metadata.output_types as string[] | undefined
      return types?.length ? `Nộp: ${types.join(', ')}` : '—'
    }
    case 'resubmit_requested':
      return metadata.reason ? `Lý do: ${String(metadata.reason)}` : '—'
    case 'review_note': {
      const note = metadata.note as string | undefined
      return note ? note.slice(0, 80) : '—'
    }
    case 'schedule_created':
    case 'recurring_tasks_generated': {
      const freq: Record<string, string> = { daily: 'mỗi ngày', weekly: 'mỗi tuần', monthly: 'mỗi tháng' }
      const f = freq[metadata.frequency as string] ?? (metadata.frequency as string)
      const sc = metadata.store_count ? ` · ${metadata.store_count} cửa hàng` : ''
      return `"${metadata.title ?? '—'}" · ${f}${sc}`
    }
    case 'deadline_extended': {
      const from = metadata.from ? new Date(metadata.from as string).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : '—'
      const to   = metadata.to   ? new Date(metadata.to   as string).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : '—'
      return `${from} → ${to}`
    }
    case 'staff_all_instruction_updated': {
      const fieldVi: Record<string, string> = {
        title: 'tiêu đề', description: 'mô tả', category: 'phân loại',
        priority: 'ưu tiên', attachments: 'file đính kèm', links: 'link',
      }
      const fields = (metadata.changed_fields as string[] | undefined) ?? []
      const changed = fields.length ? fields.map((f) => fieldVi[f] ?? f).join(', ') : 'không đổi'
      const applied = metadata.applied_to ? ` · ${metadata.applied_to} task` : ''
      return `Sửa: ${changed}${applied}`
    }
    case 'cron_run_failed':
      return metadata.error_message ? String(metadata.error_message).slice(0, 80) : '—'
    default:
      return Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : '—'
  }
}
