// CRM-CSKH B6-qa-ui — nhãn tiếng Việt cho mã lỗi của chế độ QA local (dùng cả server lẫn wizard client).

export const CARE_QA_ISSUE_CODES = [
  'QA_FILE_NOT_MARKED', 'QA_ALREADY_USED', 'QA_PERIOD', 'QA_IMPORTER', 'QA_IDS_MISMATCH',
  'QA_ID_CLASH', 'QA_ASSIGNEE', 'QA_OPEN_PREVIOUS', 'QA_TEST_TASKS_EXIST', 'QA_BUSY', 'QA_FILE_IN_PRODUCTION',
] as const
export type CareQaIssueCode = (typeof CARE_QA_ISSUE_CODES)[number]

export const CARE_QA_ISSUE_LABELS: Record<CareQaIssueCode, string> = {
  QA_FILE_NOT_MARKED: 'Chế độ QA: file này không phải bản QA đã chuẩn bị — chỉ xem trước, không import được.',
  QA_ALREADY_USED: 'Chế độ QA: bản QA này đã được import (hoặc đang import) — dọn rồi chuẩn bị lượt mới.',
  QA_PERIOD: 'Chế độ QA: kỳ hiện tại khác kỳ lúc chuẩn bị — dọn rồi chuẩn bị lại.',
  QA_IMPORTER: 'Chế độ QA: chỉ tài khoản super hoặc Marketing QA được import.',
  QA_IDS_MISMATCH: 'Chế độ QA: mã khách trong file không đúng bộ mã giả đã chuẩn bị.',
  QA_ID_CLASH: 'Chế độ QA: mã khách giả đã tồn tại trong hệ thống — dọn rồi chuẩn bị lại.',
  QA_ASSIGNEE: 'Chế độ QA: dược sĩ trong file không phải tài khoản QA được chỉ định.',
  QA_OPEN_PREVIOUS: 'Chế độ QA: còn task kỳ trước đang mở — import sẽ đóng chúng, dừng lại.',
  QA_TEST_TASKS_EXIST: 'Chế độ QA: kỳ này đã có task thử nghiệm khác — dọn lượt QA cũ trước.',
  QA_BUSY: 'Chế độ QA: đang có một lượt import khác — chờ xong rồi xem lịch sử import.',
  QA_FILE_IN_PRODUCTION: 'Chế độ QA: file có mã khách QA-UI-… là dữ liệu giả — chỉ import trên server QA local, không nhập thành dữ liệu thật.',
}
