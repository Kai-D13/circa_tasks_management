export type UserRole = 'admin' | 'store_manager' | 'staff'
export type TaskPriority = 'urgent' | 'normal'
export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'overdue'
export type TaskVisibility = 'public' | 'store' | 'private'
export type RequiredOutput = 'image' | 'video' | 'file' | 'text'
export type TaskCategory = 'training' | 'recall' | 'display' | 'audit' | 'other'

export interface TaskAttachment {
  url: string
  name: string
  type: string  // mime type
  size?: number
}

export interface Store {
  id: string
  name: string
  code: string
  address: string | null
  region: 'north' | 'central' | 'south' | null
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
  category: TaskCategory
  store_id: string | null
  assigned_to: string | null
  created_by: string | null
  input_data: Record<string, unknown> | null
  required_outputs: RequiredOutput[]
  start_date: string | null
  deadline: string | null
  broadcast_id: string | null
  resubmit_requested_at: string | null
  // Recurring-origin fields (nullable for ad-hoc tasks)
  source_template_id?: string | null
  source_schedule_id?: string | null
  scheduled_for?: string | null
  assignment_mode?: 'store' | 'user'
  created_at: string
  updated_at: string
  stores?: Store
  assignee?: UserProfile
  creator?: UserProfile
}

export interface TaskBroadcast {
  id: string
  title: string
  created_by: string | null
  store_count: number
  created_at: string
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
    category: TaskCategory
    priority: TaskPriority
    visibility: TaskVisibility
    required_outputs: RequiredOutput[]
    input_data?: Record<string, unknown>
  }
  is_active: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface TaskSchedule {
  id: string
  template_id: string
  frequency: 'daily' | 'weekly' | 'monthly'
  timezone: string
  run_time: string           // "HH:MM"
  weekdays: number[] | null  // 0=Sun 1=Mon … 6=Sat
  month_day: number | null   // 1–28
  start_date: string
  end_date: string | null
  deadline_offset_hours: number
  next_run_at: string
  last_run_at: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface TaskGenerationRun {
  id: string
  schedule_id: string | null
  scheduled_for: string
  status: 'running' | 'success' | 'failed' | 'skipped'
  created_count: number
  error_message: string | null
  idempotency_key: string
  started_at: string
  finished_at: string | null
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
