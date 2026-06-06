import { redirect } from 'next/navigation'

// Excel split import now lives inside the task creation flow (/tasks/new →
// Phát sinh + Nhiều CH/Toàn bộ + Cửa hàng nộp). This standalone route is kept
// only as a redirect so old links/bookmarks don't 404.
export default function ImportTasksPage() {
  redirect('/tasks/new')
}
