// Shared log constants — used by the logs page (server) and LogFilters (client).
import type { TagHue } from '@/components/ds/TagBadge'

export const LOGS_PAGE_SIZE = 50

// Log action = TAXONOMY (which operation happened), not a status → ds TagBadge
// hues. Same hue families as the previous pastels; the palette has no
// yellow/purple/orange, so those map to their nearest neighbours
// (yellow→amber, purple→indigo, orange→sky).
export const ACTION_HUE: Record<string, TagHue> = {
  created:                     'blue',
  updated:                     'amber',
  deleted:                     'red',
  submitted:                   'green',
  status_changed:              'indigo',
  reassigned:                  'sky',
  resubmit_requested:          'amber',
  review_note:                 'indigo',
  schedule_created:            'teal',
  schedule_paused:             'gray',
  schedule_resumed:            'teal',
  schedule_deleted:            'red',
  recurring_tasks_generated:   'teal',
  cron_run_failed:             'red',
  deadline_extended:           'sky',
  staff_all_instruction_updated: 'amber',
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
