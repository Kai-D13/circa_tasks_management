export type UserRole = 'admin' | 'store_manager' | 'staff'
export type TaskPriority = 'urgent' | 'normal'
export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'overdue'
export type TaskVisibility = 'public' | 'store' | 'private'
export type RequiredOutput = 'image' | 'video' | 'file' | 'text'

export interface Store {
  id: string
  name: string
  code: string
  address: string | null
  created_at: string
}

export interface UserProfile {
  id: string
  email: string
  full_name: string
  role: UserRole
  store_id: string | null
  created_at: string
  stores?: Store
}

export interface Task {
  id: string
  title: string
  description: string | null
  priority: TaskPriority
  status: TaskStatus
  visibility: TaskVisibility
  store_id: string | null
  assigned_to: string | null
  created_by: string | null
  input_data: Record<string, unknown> | null
  required_outputs: RequiredOutput[]
  start_date: string | null
  deadline: string | null
  created_at: string
  updated_at: string
  stores?: Store
  assignee?: UserProfile
  creator?: UserProfile
}

export interface TaskAssignment {
  id: string
  task_id: string
  user_id: string
  assigned_by: string | null
  assigned_at: string
  users?: UserProfile
}

export interface TaskResult {
  id: string
  task_id: string
  user_id: string
  output_data: Record<string, unknown>
  submitted_at: string
  users?: Pick<UserProfile, 'id' | 'full_name' | 'email'>
}

export interface TaskTemplate {
  id: string
  title: string
  config: {
    description?: string
    priority: TaskPriority
    visibility: TaskVisibility
    required_outputs: RequiredOutput[]
    input_data?: Record<string, unknown>
  }
  created_by: string | null
  created_at: string
}

export interface TaskLog {
  id: string
  task_id: string | null
  action: string
  user_id: string | null
  metadata: Record<string, unknown> | null
  created_at: string
  tasks?: Pick<Task, 'id' | 'title'>
  users?: Pick<UserProfile, 'id' | 'full_name' | 'email'>
}
