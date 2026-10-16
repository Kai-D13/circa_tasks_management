import { TaskFormSkeleton } from '@/components/tasks/TaskFormSkeleton'

// UI v2: khung chờ form sửa task (nếu không có file này, route sẽ dùng skeleton chi tiết của [id]/loading.tsx).
export default function EditTaskLoading() {
  return <TaskFormSkeleton marker="task-edit" />
}
