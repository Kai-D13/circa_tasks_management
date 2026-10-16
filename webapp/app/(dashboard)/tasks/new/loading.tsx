import { TaskFormSkeleton } from '@/components/tasks/TaskFormSkeleton'

// UI v2: khung chờ form tạo task (trước đây hiện skeleton danh sách của /tasks/loading.tsx).
export default function NewTaskLoading() {
  return <TaskFormSkeleton marker="task-new" />
}
