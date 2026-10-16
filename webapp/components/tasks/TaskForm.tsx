'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useUserStore } from '@/store/userStore'
import { toast } from 'sonner'
import { createTask, updateTask, createBroadcastTask, createTaskSchedule, createImportedStoreTasks } from '@/app/actions/tasks'
import { createClient as createBrowserClient } from '@/lib/supabase/client'
import { safeStorageName } from '@/lib/storage'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RichTextEditor } from '@/components/tasks/RichTextEditor'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SearchableSelect } from '@/components/ui/searchable-select'
import { Check, Plus, X, Paperclip, Link2, Settings } from 'lucide-react'
import { TaskInputAttachments, type TaskInputAttachmentsHandle } from '@/components/tasks/TaskInputAttachments'
import { TaskExcelSplitPanel, type ExcelSplitState } from '@/components/tasks/TaskExcelSplitPanel'
import { cn } from '@/lib/utils'
import { Panel } from '@/components/ds/Panel'
import { FILTER_ACTIVE } from '@/components/ds/DataToolbar'
import {
  Task, Store, UserProfile, RequiredOutput, UserRole,
  TaskPriority, TaskVisibility, TaskCategory, TaskAttachment,
} from '@/types'
import { canCreateRecurring, canCreateTask, canImportExcel } from '@/lib/tasks/smScope'

const OUTPUT_OPTIONS: { value: RequiredOutput; label: string }[] = [
  { value: 'text',  label: 'Ghi chú' },
  { value: 'image', label: 'Ảnh' },
  { value: 'video', label: 'Video' },
  { value: 'file',  label: 'File' },
]

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  urgent: 'Khẩn cấp',
  normal: 'Bình thường',
}
const CATEGORY_LABEL: Record<TaskCategory, string> = {
  training: 'Training',
  recall:   'Thu hồi / Kiểm kê',
  display:  'Trưng bày',
  audit:    'Kiểm tra',
  other:    'Khác',
}
const CATEGORY_DEFAULTS: Record<TaskCategory, {
  outputs: RequiredOutput[]; priority: TaskPriority; visibility: TaskVisibility
}> = {
  training: { outputs: ['text'],          priority: 'normal', visibility: 'store' },
  recall:   { outputs: ['text', 'image'], priority: 'urgent', visibility: 'store' },
  display:  { outputs: ['image'],         priority: 'normal', visibility: 'store' },
  audit:    { outputs: ['image', 'text'], priority: 'urgent', visibility: 'store' },
  other:    { outputs: [],               priority: 'normal', visibility: 'store' },
}

function splitDateTimeStr(value: string): [string, string] {
  if (!value) return ['', '']
  const t = value.indexOf('T')
  if (t === -1) return [value, '']
  return [value.slice(0, t), value.slice(t + 1, t + 6)]
}
function combineDateTimeStr(date: string, time: string): string {
  if (!date || !time) return ''
  return `${date}T${time}`
}

// Accent/case-insensitive search key so "duoc" matches "Dược" (Vietnamese staff).
const deburr = (s: string) =>
  s.normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/đ/gi, 'd').toLowerCase()

type Scope    = 'single' | 'multi' | 'all'
type TaskType = 'adhoc' | 'recurring'

// Recurring deadline-offset presets (hours); anything else uses the custom input.
const DEADLINE_PRESETS = [3, 6, 12, 24, 48, 72]

interface Props {
  stores: Pick<Store, 'id' | 'name' | 'code'>[]
  users: Pick<UserProfile, 'id' | 'full_name' | 'email' | 'store_id' | 'role'>[]
  currentUserRole: UserRole
  currentUserStoreId: string | null
  task?: Task
  // Preselects the task-type toggle (e.g. /tasks/new?mode=recurring from the
  // schedules page). Create mode only — edit always stays adhoc.
  initialTaskType?: TaskType
}

export function TaskForm({ stores, users, currentUserRole, currentUserStoreId, task, initialTaskType }: Props) {
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  const [category, setCategory]     = useState<TaskCategory>(task?.category ?? 'other')
  const [storeId, setStoreId]       = useState(task?.store_id ?? currentUserStoreId ?? '')
  const [assignedTo, setAssignedTo] = useState(task?.assigned_to ?? '')
  const [priority, setPriority]     = useState<TaskPriority>(task?.priority ?? 'normal')
  const [outputs, setOutputs]       = useState<RequiredOutput[]>(task?.required_outputs ?? [])
  // Description is now rich-text HTML (controlled) — fed to RichTextEditor + a
  // hidden input named "description" so form/draft plumbing is unchanged.
  const [description, setDescription] = useState<string>(task?.description ?? '')
  const [taskType, setTaskType]     = useState<TaskType>(!task && initialTaskType === 'recurring' ? 'recurring' : 'adhoc')
  // staff_all: each pharmacist in the store gets their own child task to submit.
  // Ad-hoc + single-store + new only.
  const [staffMode, setStaffMode]   = useState(false)
  // staff_all subset: ids the admin UNCHECKED (default = everyone selected, which
  // matches the legacy "all staff" behavior — an empty set sends no override).
  const [excludedStaff, setExcludedStaff] = useState<Set<string>>(new Set())
  // Global pharmacist search for the broadcast (multi-store) picker — one box that
  // filters across every store at once (each store has only 3-5 staff individually).
  const [staffQuery, setStaffQuery] = useState('')

  const [startDate, setStartDate]       = useState(task?.start_date ? new Date(task.start_date).toISOString().slice(0, 10) : '')
  const [startTime, setStartTime]       = useState(task?.start_date ? new Date(task.start_date).toISOString().slice(11, 16) : '')
  const [deadlineDate, setDeadlineDate] = useState(task?.deadline ? new Date(task.deadline).toISOString().slice(0, 10) : '')
  const [deadlineTime, setDeadlineTime] = useState(task?.deadline ? new Date(task.deadline).toISOString().slice(11, 16) : '')

  // Recurring-only config
  const [frequency, setFrequency]           = useState<'daily' | 'weekly' | 'monthly'>('weekly')
  const [runTime, setRunTime]               = useState('08:00')
  const [weekdays, setWeekdays]             = useState<number[]>([1])
  const [monthDay, setMonthDay]             = useState(1)
  const [schedStartDate, setSchedStartDate] = useState('')
  const [schedEndDate, setSchedEndDate]     = useState('')
  const [deadlineOffset, setDeadlineOffset] = useState(24)
  const [customDeadline, setCustomDeadline] = useState(false)

  // Recurring has no single-store scope (mirrors handleSetTaskType).
  // 108.5: SM không có scope 'single' (tạo task đơn lẻ vẫn admin-only ở
  // server) ⇒ mặc định 'multi', nếu không form sẽ mở ở một chế độ mà chính
  // họ không bấm sang được và submit sẽ bị server từ chối.
  const smOnlyBroadcast = currentUserRole === 'sm'
  const [scope, setScope]                       = useState<Scope>(
    !task && (initialTaskType === 'recurring' || currentUserRole === 'sm') ? 'multi' : 'single')
  const [selectedStoreIds, setSelectedStoreIds] = useState<string[]>([])

  // Excel split (broadcast + store-mode only): null = no file / plain broadcast.
  const [excelImport, setExcelImport] = useState<ExcelSplitState | null>(null)
  const handleExcelChange = useCallback((s: ExcelSplitState | null) => setExcelImport(s), [])

  const uploadIdRef       = useRef((task?.id) ?? crypto.randomUUID())
  const attachRef         = useRef<TaskInputAttachmentsHandle>(null)
  const existingInputData = task?.input_data as Record<string, unknown> | null
  const existingAttachments = (existingInputData?.attachments as TaskAttachment[]) ?? []

  const [attachments, setAttachments] = useState<TaskAttachment[]>(existingAttachments)
  // Attachment panel is visible by default when creating a task (or editing one
  // that already has attachments); the toolbar button just re-opens the picker.
  const [showAttachments, setShowAttachments]   = useState(!task || existingAttachments.length > 0)
  const [showLinks, setShowLinks]               = useState(false)
  const [showMobileConfig, setShowMobileConfig] = useState(false)
  const [links, setLinks] = useState<{ label: string; url: string }[]>(
    (existingInputData?.links as { label: string; url: string }[]) ?? []
  )

  // ── Draft (localStorage) — create mode only ──────────────────────────────
  const isCreate = !task
  const formRef  = useRef<HTMLFormElement>(null)
  const userId   = useUserStore((s) => s.profile?.id)
  const draftKey = isCreate && userId ? `circa.taskDraft.v1.${userId}` : null
  const [hasDraft, setHasDraft] = useState(false)
  const [dirtyTick, setDirtyTick] = useState(0)   // bumped by uncontrolled input onInput

  function collectDraft() {
    const f = formRef.current
    const dom = (name: string) =>
      ((f?.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | null)?.value) ?? ''
    return {
      taskType, category, priority, storeId, assignedTo, scope, selectedStoreIds, staffMode,
      outputs, links, attachments,
      frequency, runTime, weekdays, monthDay, schedStartDate, schedEndDate, deadlineOffset,
      title: dom('title'), description: dom('description'),
      start_date: combineDateTimeStr(startDate, startTime),
      deadline: combineDateTimeStr(deadlineDate, deadlineTime),
    }
  }

  // Detect existing draft (banner only — never auto-restore).
  // Keyed on draftKey, not [], because userId (hence the key) resolves from the
  // Zustand store only after the first render on a direct reload of /tasks/new —
  // a bare [] would run before the key exists and miss the saved draft.
  useEffect(() => {
    if (!draftKey) return
    try { setHasDraft(!!localStorage.getItem(draftKey)) } catch { /* ignore */ }
  }, [draftKey])

  // Debounced autosave; skips empty drafts so a bare visit doesn't create one.
  // Paused while an unrestored draft is pending (hasDraft): otherwise the empty
  // form on a fresh reload would overwrite — or, via the removeItem branch
  // below, delete — the saved draft before the user can hit "Khôi phục".
  useEffect(() => {
    if (!draftKey || hasDraft) return
    const t = setTimeout(() => {
      const d = collectDraft()
      const meaningful = !!(d.title || d.description || d.attachments.length ||
        d.links.some((l) => l.url.trim()) || d.storeId || d.selectedStoreIds.length || d.outputs.length)
      try {
        if (meaningful) localStorage.setItem(draftKey, JSON.stringify(d))
        else localStorage.removeItem(draftKey)
      } catch { /* ignore quota / disabled storage */ }
    }, 1000)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, hasDraft, dirtyTick, taskType, category, priority, storeId, assignedTo, scope,
      selectedStoreIds, staffMode, outputs, links, attachments, frequency, runTime, weekdays,
      monthDay, schedStartDate, schedEndDate, deadlineOffset, description,
      startDate, startTime, deadlineDate, deadlineTime])

  function clearDraft() {
    if (draftKey) { try { localStorage.removeItem(draftKey) } catch { /* ignore */ } }
  }

  // Submit-time draft safety: capture the current draft, clear it up-front (so a
  // successful submit that redirects leaves nothing behind), and write it back
  // verbatim if the server action returns an error so nothing is lost.
  function snapshotDraft(): string | null {
    if (!draftKey) return null
    try { return JSON.stringify(collectDraft()) } catch { return null }
  }
  function restoreDraftSnapshot(raw: string | null) {
    if (!draftKey || !raw) return
    // Re-persist the draft and flag it pending so the banner reappears and
    // autosave (paused while hasDraft) can't wipe it right after the error.
    try { localStorage.setItem(draftKey, raw); setHasDraft(true) } catch { /* ignore */ }
  }

  function discardDraft() {
    clearDraft()
    setHasDraft(false)
  }

  function restoreDraft() {
    if (!draftKey) return
    try {
      const raw = localStorage.getItem(draftKey)
      if (!raw) { setHasDraft(false); return }
      const d = JSON.parse(raw)
      setTaskType(d.taskType ?? 'adhoc')
      setCategory(d.category ?? 'other')
      setPriority(d.priority ?? 'normal')
      setStoreId(d.storeId ?? '')
      setAssignedTo(d.assignedTo ?? '')
      setScope(smOnlyBroadcast ? (d.scope === 'single' ? 'multi' : d.scope ?? 'multi') : d.scope ?? 'single')
      setSelectedStoreIds(d.selectedStoreIds ?? [])
      setStaffMode(d.staffMode ?? false)
      setOutputs(d.outputs ?? [])
      setLinks(d.links ?? [])
      setAttachments(d.attachments ?? [])
      setFrequency(d.frequency ?? 'weekly')
      setRunTime(d.runTime ?? '08:00')
      setWeekdays(d.weekdays ?? [1])
      setMonthDay(d.monthDay ?? 1)
      setSchedStartDate(d.schedStartDate ?? '')
      setSchedEndDate(d.schedEndDate ?? '')
      setDeadlineOffset(d.deadlineOffset ?? 24)
      setCustomDeadline(!DEADLINE_PRESETS.includes(d.deadlineOffset ?? 24))
      const [sd, st] = splitDateTimeStr(d.start_date ?? '')
      const [dd, dt] = splitDateTimeStr(d.deadline ?? '')
      setStartDate(sd); setStartTime(st)
      setDeadlineDate(dd); setDeadlineTime(dt)
      if (d.links?.length) setShowLinks(true)
      if (d.attachments?.length) setShowAttachments(true)
      setDescription(d.description ?? '')   // controlled rich-text field
      // Uncontrolled DOM fields
      const f = formRef.current
      if (f) {
        const setVal = (name: string, val: string) => {
          const el = f.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | null
          if (el) el.value = val ?? ''
        }
        setVal('title', d.title)
      }
      setHasDraft(false)
      toast.success('Đã khôi phục bản nháp')
    } catch {
      toast.error('Không đọc được bản nháp')
    }
  }

  function addLink() {
    setLinks((prev) => [...prev, { label: '', url: '' }])
    setShowLinks(true)
  }
  function updateLink(i: number, field: 'label' | 'url', val: string) {
    setLinks((prev) => prev.map((l, idx) => idx === i ? { ...l, [field]: val } : l))
  }
  function removeLink(i: number) {
    setLinks((prev) => prev.filter((_, idx) => idx !== i))
  }

  const isAdmin     = currentUserRole === 'admin'
  // Mig 108: SM tạo được task PHÁT SINH cho cửa hàng mình phụ trách.
  // `isAdmin` giữ nguyên nghĩa cũ (dùng cho những thứ SM KHÔNG có: định kỳ,
  // import Excel); `canCreate` là quyền tạo task nói chung. Tách hai khái niệm
  // ra thay vì nới `isAdmin` — nới sẽ mở luôn cả định kỳ lẫn Excel cho SM.
  const canCreate   = canCreateTask(currentUserRole)
  const canRecurring = canCreateRecurring(currentUserRole)
  const canExcel     = canImportExcel(currentUserRole)
  const isBroadcast = canCreate && !task && scope !== 'single'
  const isEditMode  = !!task
  const isRecurring = taskType === 'recurring' && !isEditMode

  // SM: `stores` đã được route lọc theo phân công nên hiện TẤT CẢ là đúng.
  const visibleStores  = canCreate ? stores : stores.filter((s) => s.id === currentUserStoreId)
  const storeUsers     = storeId ? users.filter((u) => u.store_id === storeId) : users
  const broadcastCount    = scope === 'all' ? visibleStores.length : selectedStoreIds.length
  const showMultiStore    = isBroadcast || isRecurring

  // staff_all: admin + new task. Works for all scopes (single/multi/all) AND for
  // recurring schedules (migration 062). For recurring it's dynamic — every
  // current pharmacist of each store at each run, so no per-store subset picker.
  const canStaffMode       = canCreate && !isEditMode
  const effectiveStaffMode = staffMode && canStaffMode
  // Single-store pharmacist list + selected count (selected = not unchecked).
  const singleStoreStaff   = storeId
    ? users.filter((u) => u.store_id === storeId && u.role === 'staff')
    : []
  const staffCount         = singleStoreStaff.length
  const staffSelectedCount = singleStoreStaff.filter((u) => !excludedStaff.has(u.id)).length

  // Multi-store staff breakdown: used when broadcast + effectiveStaffMode for the
  // per-pharmacist subset picker. Recurring staff_all is dynamic (all current
  // staff at each run) → no picker, so exclude recurring here.
  const activeStoreIds     = (isBroadcast && effectiveStaffMode && !isRecurring)
    ? (scope === 'all' ? visibleStores.map(s => s.id) : selectedStoreIds)
    : []
  const perStoreStaffInfo  = activeStoreIds.map(id => {
    const staff = users.filter(u => u.store_id === id && u.role === 'staff')
    return {
      id,
      name:  visibleStores.find(s => s.id === id)?.name ?? id,
      staff,
      count: staff.length,
      selectedCount: staff.filter(u => !excludedStaff.has(u.id)).length,
    }
  })
  // Selected total drives the "sẽ tạo N task con" preview; stores with no DB staff
  // are still a hard error (storesWithoutStaff), stores cleared via checkboxes skip.
  const broadcastStaffTotal = perStoreStaffInfo.reduce((sum, s) => sum + s.selectedCount, 0)
  const storesWithoutStaff  = perStoreStaffInfo.filter(s => s.count === 0)
  // Stores that HAVE pharmacists but the admin unchecked them all → skipped on
  // submit (product decision: skip, but warn visibly so it's never silent).
  const storesClearedBySelection = perStoreStaffInfo.filter(s => s.count > 0 && s.selectedCount === 0)

  // Excel split: adhoc + broadcast (multi/all) + store-mode (not per-pharmacist).
  // Excel split: admin-only (sinh task hàng loạt từ file, phạm vi không kiểm
  // lại được như luồng phát sinh).
  const showExcelSplit  = canExcel && isBroadcast && !isRecurring && !effectiveStaffMode
  const allowedStoreIds = scope === 'all' ? visibleStores.map((s) => s.id) : selectedStoreIds
  // Drop any staged import when the conditions stop applying (scope→single, staff
  // mode, recurring) so a hidden file can never leak into a different submit path.
  useEffect(() => {
    if (!showExcelSplit && excelImport) setExcelImport(null)
  }, [showExcelSplit, excelImport])

  function deriveVisibility(): TaskVisibility {
    return assignedTo ? 'private' : 'store'
  }

  function handleCategoryChange(v: string | null) {
    if (!v) return
    const cat = v as TaskCategory
    setCategory(cat)
    if (!task) {
      const d = CATEGORY_DEFAULTS[cat]
      setOutputs(d.outputs)
      setPriority(d.priority)
    }
  }

  function handleScopeChange(scopeVal: Scope) {
    setScope(smOnlyBroadcast && scopeVal === 'single' ? 'multi' : scopeVal)
    setSelectedStoreIds([])
    // staffMode intentionally preserved — staff_all works for all scopes
  }

  function handleSetTaskType(t: TaskType) {
    setTaskType(t)
    // staff_all is now allowed for recurring (dynamic all-staff); keep the toggle.
    if (t === 'recurring' && scope === 'single') setScope('multi')
  }

  function toggleWeekday(day: number) {
    setWeekdays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
    )
  }

  function toggleStoreSelection(id: string) {
    setSelectedStoreIds((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
    )
  }

  function toggleStaffExcluded(id: string) {
    setExcludedStaff((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  // Bulk select/clear a store's pharmacists (exclude = remove all from selection).
  function setStoreStaffExcluded(staffIds: string[], exclude: boolean) {
    setExcludedStaff((prev) => {
      const next = new Set(prev)
      staffIds.forEach((id) => (exclude ? next.add(id) : next.delete(id)))
      return next
    })
  }

  // Per-store subset payload for a staff_all broadcast. undefined when nothing is
  // unchecked → server keeps the legacy "all current staff" behavior.
  function buildSelectedByStore(ids: string[]): Record<string, string[]> | undefined {
    if (excludedStaff.size === 0) return undefined
    const out: Record<string, string[]> = {}
    let any = false
    for (const sid of ids) {
      const staff = users.filter((u) => u.store_id === sid && u.role === 'staff')
      if (staff.some((u) => excludedStaff.has(u.id))) {
        out[sid] = staff.filter((u) => !excludedStaff.has(u.id)).map((u) => u.id)
        any = true
      }
    }
    return any ? out : undefined
  }

  function handleStoreChange(v: string | null) {
    if (!v) return
    setStoreId(v)
    if (!users.find((u) => u.id === assignedTo && u.store_id === v)) setAssignedTo('')
  }

  function toggleOutput(val: RequiredOutput) {
    setOutputs((prev) =>
      prev.includes(val) ? prev.filter((o) => o !== val) : [...prev, val]
    )
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)

    // Every task must define at least one output, else staff get a submit form
    // with no upload widgets (the recurring "quên chọn output" incident). Applies
    // to both adhoc and recurring create paths.
    if (outputs.length === 0) {
      toast.error('Vui lòng chọn ít nhất một loại kết quả cần nộp (Ảnh, Ghi chú, File hoặc Video)')
      return
    }

    // ── Recurring path ────────────────────────────────────────────────────
    if (taskType === 'recurring') {
      const title       = (formData.get('title') as string)?.trim() ?? ''
      const description = (formData.get('description') as string) ?? ''
      if (!schedStartDate) { toast.error('Vui lòng chọn ngày bắt đầu lịch'); return }
      const storeIds = scope === 'all' ? visibleStores.map((s) => s.id) : selectedStoreIds
      if (!storeIds.length) { toast.error('Vui lòng chọn ít nhất một cửa hàng'); return }
      const draftSnapshot = snapshotDraft()
      clearDraft()
      startTransition(async () => {
        const result = await createTaskSchedule({
          title, description, category, priority,
          requiredOutputs: outputs,
          attachments,
          links: links.filter((l) => l.url.trim()),
          frequency,
          runTime,
          weekdays: frequency === 'weekly'  ? weekdays : null,
          monthDay: frequency === 'monthly' ? monthDay : null,
          startDate:           schedStartDate,
          endDate:             schedEndDate || null,
          deadlineOffsetHours: deadlineOffset,
          storeIds,
          assignmentMode:      effectiveStaffMode ? 'staff_all' : 'store',
        })
        if (result?.error) {
          restoreDraftSnapshot(draftSnapshot)
          toast.error(result.error)
        } else {
          toast.success('Đã tạo lịch task định kỳ')
          router.push('/tasks/schedules')
        }
      })
      return
    }

    // ── Phát sinh path ────────────────────────────────────────────────────
    formData.set('category',   category)
    formData.set('priority',   priority)
    formData.set('visibility', deriveVisibility())
    formData.delete('required_outputs')
    outputs.forEach((o) => formData.append('required_outputs', o))

    // Ad-hoc tasks must have start date + deadline (deadline after start).
    // The date fields live in the config panel (hidden on mobile) — open it on
    // failure so a mobile user can see where to fix the problem.
    const startDateVal = (formData.get('start_date') as string) || ''
    const deadlineVal  = (formData.get('deadline') as string) || ''
    const revealConfig = () => {
      if (typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches) {
        setShowMobileConfig(true)
      }
    }
    if (!startDateVal) { toast.error('Vui lòng chọn ngày bắt đầu'); revealConfig(); return }
    if (!deadlineVal)  { toast.error('Vui lòng chọn deadline'); revealConfig(); return }
    if (new Date(deadlineVal) <= new Date(startDateVal)) {
      toast.error('Deadline phải sau ngày bắt đầu'); revealConfig(); return
    }

    if (!isBroadcast && !storeId) {
      toast.error('Vui lòng chọn cửa hàng nhận task')
      return
    }

    // Per-pharmacist mode (single-store): needs at least one staff (server re-checks).
    if (effectiveStaffMode && !isBroadcast && staffCount === 0) {
      toast.error('Cửa hàng chưa có dược sĩ nào để giao task')
      return
    }
    if (effectiveStaffMode && !isBroadcast && staffSelectedCount === 0) {
      toast.error('Vui lòng chọn ít nhất một dược sĩ để giao task')
      return
    }

    if (isBroadcast) {
      const storeIds = scope === 'all' ? visibleStores.map((s) => s.id) : selectedStoreIds
      if (!storeIds.length) { toast.error('Vui lòng chọn ít nhất một cửa hàng'); return }

      // Excel split path: a file is staged → upload it, then create one task per
      // in-scope store (each with its own data slice). Same "Tạo Task" button.
      if (showExcelSplit && excelImport) {
        if (!excelImport.ready) {
          toast.error('File Excel chưa hợp lệ — kiểm tra sheet, cột POS và phạm vi cửa hàng')
          return
        }
        const importFile = excelImport.file
        const draftSnapshot = snapshotDraft()
        clearDraft()
        startTransition(async () => {
          const sb = createBrowserClient()
          const tmpId = crypto.randomUUID()
          const masterPath = `task-inputs/import/${tmpId}/${Date.now()}_${safeStorageName(importFile.name)}`
          const { error: upErr } = await sb.storage
            .from('task-uploads').upload(masterPath, importFile, { upsert: false })
          if (upErr) { restoreDraftSnapshot(draftSnapshot); toast.error(`Tải file lên thất bại: ${upErr.message}`); return }
          const result = await createImportedStoreTasks({
            masterPath,
            sheetName:       excelImport.sheetName,
            posColumn:       excelImport.posColumn,
            scope:           scope === 'all' ? 'all' : 'multi',
            allowedStoreIds: storeIds,
            title:           formData.get('title') as string,
            description:     (formData.get('description') as string) || '',
            category, priority,
            startDate:       (formData.get('start_date') as string) || '',
            deadline:        (formData.get('deadline') as string) || '',
            requiredOutputs: outputs,
          })
          if (result?.error) { restoreDraftSnapshot(draftSnapshot); toast.error(result.error) }
          else { toast.success(`Đã tạo ${result.count} task`); router.push('/tasks') }
        })
        return
      }

      // Per-pharmacist broadcast: block if any selected store has no staff at all
      if (effectiveStaffMode && storesWithoutStaff.length > 0) {
        const MAX_NAMES = 3
        const shown = storesWithoutStaff.slice(0, MAX_NAMES).map(s => s.name).join(', ')
        const extra = storesWithoutStaff.length > MAX_NAMES ? ` +${storesWithoutStaff.length - MAX_NAMES} cửa hàng khác` : ''
        toast.error(`Cửa hàng chưa có dược sĩ: ${shown}${extra}`)
        return
      }
      // …or if the admin unchecked everyone across all selected stores.
      if (effectiveStaffMode && broadcastStaffTotal === 0) {
        toast.error('Vui lòng chọn ít nhất một dược sĩ để giao task')
        return
      }
      const draftSnapshot = snapshotDraft()
      clearDraft()
      startTransition(async () => {
        const result = await createBroadcastTask({
          title:           formData.get('title') as string,
          description:     (formData.get('description') as string) || '',
          category, priority,
          visibility:      deriveVisibility(),
          storeIds,
          startDate:       (formData.get('start_date') as string) || null,
          deadline:        (formData.get('deadline') as string) || null,
          requiredOutputs: outputs,
          attachments,
          links: links.filter((l) => l.url.trim()),
          assignmentMode:  effectiveStaffMode ? 'staff_all' : 'store',
          selectedStaffByStore: effectiveStaffMode ? buildSelectedByStore(storeIds) : undefined,
        })
        if (result?.error) {
          restoreDraftSnapshot(draftSnapshot)
          toast.error(result.error)
        }
      })
      return
    }

    formData.set('store_id',          storeId)
    // staff_all generates one child per pharmacist server-side; the parent has no
    // single assignee, so clear assigned_to and flag the mode.
    if (effectiveStaffMode) {
      formData.set('assignment_mode', 'staff_all')
      formData.set('assigned_to', '')
      // Only send a subset when the admin actually unchecked someone in this store;
      // otherwise omit so the server creates for all current staff (legacy behavior).
      if (singleStoreStaff.some((u) => excludedStaff.has(u.id))) {
        const selected = singleStoreStaff.filter((u) => !excludedStaff.has(u.id)).map((u) => u.id)
        formData.set('selected_staff_ids', JSON.stringify(selected))
      }
    } else {
      formData.set('assigned_to', assignedTo)
    }
    formData.set('input_attachments', JSON.stringify(attachments))
    formData.set('input_links',       JSON.stringify(links.filter((l) => l.url.trim())))

    const draftSnapshot = snapshotDraft()
    if (!task) clearDraft()
    startTransition(async () => {
      const result = task
        ? await updateTask(task.id, formData)
        : await createTask(formData)
      if (result?.error) {
        restoreDraftSnapshot(draftSnapshot)
        toast.error(result.error)
      }
    })
  }

  // When an Excel split is staged + valid, the real count is the in-scope stores.
  const effectiveBroadcastCount = (showExcelSplit && excelImport?.ready)
    ? excelImport.inScopeCount
    : broadcastCount
  const submitLabel = pending
    ? 'Đang lưu...'
    : isRecurring
      ? 'Tạo lịch định kỳ'
      : isBroadcast
        ? `Tạo ${effectiveBroadcastCount > 0 ? effectiveBroadcastCount + ' ' : ''}Task`
        : task ? 'Cập nhật' : 'Tạo Task'

  // UI v2 P1.4 (artboard 03) — chỉ trình bày. Nhãn khối 13px đậm (không in hoa); segmented TRUNG TÍNH như
  // tab /tasks (cam chỉ dành cho nút hành động); chip đang bật = FILTER_ACTIVE (+ dấu ✓ để không chỉ dựa vào
  // màu). Cao control PIXEL vì root 15px (rem lừa): [44px] mobile, [36px] desktop; chữ ô nhập 16px trên
  // mobile (iOS không zoom).
  const sectionLabel = 'block text-[13px] font-semibold text-foreground'
  const fieldLabel = 'block mb-1.5 text-[12px] text-muted-foreground'
  const control = 'h-[44px] md:h-[36px] text-[16px] md:text-[13px] bg-background'
  const selectCtl = 'data-[size=default]:h-[44px] md:data-[size=default]:h-[36px] text-[16px] md:text-[13px] bg-background'
  const segWrap = 'flex gap-1 rounded-v2-control bg-muted p-1'
  const segBtn = (active: boolean) => cn(
    'flex-auto whitespace-nowrap min-h-[44px] md:min-h-0 md:h-[30px] px-3 rounded-[8px] border text-[13px] transition-colors',
    active
      ? 'border-input bg-card font-semibold text-foreground'
      : 'border-transparent font-medium text-muted-foreground hover:text-foreground',
  )
  const chipBtn = (active: boolean) => cn(
    'inline-flex items-center justify-center gap-1.5 min-h-[44px] md:min-h-0 md:h-[34px] px-3 rounded-v2-control border text-[13px] font-medium transition-colors',
    active ? FILTER_ACTIVE : 'border-input text-muted-foreground hover:text-foreground',
  )
  const toolBtn = (active: boolean) => cn(
    'inline-flex items-center gap-1.5 min-h-[44px] md:min-h-0 md:h-[32px] px-3 rounded-[8px] text-[13px] font-medium transition-colors',
    active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
  )
  const countChip = 'ml-0.5 rounded-v2-chip bg-muted-foreground/15 px-1.5 text-[11px] font-semibold leading-[18px] text-foreground'

  const WEEKDAY_LABELS: Record<number, string> = { 0: 'CN', 1: 'T2', 2: 'T3', 3: 'T4', 4: 'T5', 5: 'T6', 6: 'T7' }

  return (
    <form ref={formRef} onSubmit={handleSubmit} onInput={() => setDirtyTick((t) => t + 1)} className="flex flex-col h-full">

      {/* ── Header (64px, dính). Dưới sm: 2 hàng — tiêu đề, rồi [Cấu hình] … [Huỷ][Tạo] — để không cắt chữ ── */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 md:px-6 py-2 sm:py-0 sm:h-[64px] border-b bg-card sticky top-0 z-10 shrink-0">
        <h1 className="basis-full sm:basis-auto sm:flex-1 min-w-0 text-[18px] font-bold leading-tight break-words">
          {isEditMode ? 'Chỉnh sửa Task' : 'Tạo task mới'}
        </h1>
        <div className="flex w-full sm:w-auto shrink-0 items-center gap-1.5 md:gap-2">
          {/* Config toggle — mobile only */}
          <button
            type="button"
            aria-label="Cấu hình task"
            onClick={() => setShowMobileConfig(true)}
            className="lg:hidden max-sm:mr-auto inline-flex items-center gap-1.5 h-[44px] md:h-[36px] px-3 rounded-v2-control border border-input text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            <Settings className="h-4 w-4" />
            Cấu hình
          </button>
          <Button type="button" variant="ghost" onClick={() => router.back()} className="h-[44px] md:h-[36px] px-3 md:px-3.5 text-[13px] text-muted-foreground">
            Huỷ
          </Button>
          <Button type="submit" disabled={pending} className="h-[44px] md:h-[36px] px-4 text-[13px] font-semibold">
            {submitLabel}
          </Button>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="flex flex-1 min-h-0 overflow-auto flex-col lg:flex-row">

        {/* ── Left: compose area (các panel 12px trên nền canvas) ── */}
        {/* Khối thường (không flex-col): panel không bị co khi "Giao đến" dài — body là vùng cuộn. */}
        <div className="flex-1 min-w-0 space-y-4 p-4 md:p-6">

          {/* Draft restore banner — create mode only, no silent restore */}
          {isCreate && hasDraft && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-v2-panel border border-status-warning/30 bg-status-warning-bg px-4 py-2">
              <span className="text-[13px] font-medium text-status-warning">Có bản nháp chưa gửi</span>
              <div className="flex gap-2 shrink-0">
                <button
                  type="button"
                  onClick={restoreDraft}
                  className="min-h-[44px] md:min-h-0 md:h-[32px] px-3 rounded-v2-control border border-status-warning/40 text-[13px] font-medium text-status-warning hover:bg-status-warning/10"
                >
                  Khôi phục
                </button>
                <button
                  type="button"
                  onClick={discardDraft}
                  className="min-h-[44px] md:min-h-0 md:h-[32px] px-3 rounded-v2-control text-[13px] text-muted-foreground hover:text-destructive"
                >
                  Xóa
                </button>
              </div>
            </div>
          )}

          {/* Panel "Giao đến": phạm vi + cách nộp + cửa hàng / người thực hiện */}
          <Panel bodyClassName="space-y-3.5">
            {/* Scope pills — người tạo task + tạo mới; recurring ẩn "Một CH".
                108.5: SM cũng KHÔNG có "Một CH" — request đã chốt là BROADCAST,
                và tạo task đơn lẻ (createTask) vẫn admin-only ở server. Muốn giao
                một cửa hàng thì SM tick đúng một ô trong "Nhiều CH".
                Submit mode (Cửa hàng nộp / Từng dược sĩ nộp) nằm cùng hàng như artboard:
                canStaffMode ≡ canCreate && !isEditMode nên hiển thị đúng như trước. */}
            {canCreate && !isEditMode && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="text-[13px] font-semibold shrink-0">Giao đến:</span>
                <div className={cn(segWrap, 'w-full sm:w-auto')}>
                  {(['single', 'multi', 'all'] as Scope[]).map((s) => {
                    if (s === 'single' && (isRecurring || !isAdmin)) return null
                    const label = s === 'single' ? 'Một CH' : s === 'multi' ? 'Nhiều CH' : `Tất cả (${visibleStores.length})`
                    return (
                      <button
                        key={s}
                        type="button"
                        aria-pressed={scope === s}
                        onClick={() => handleScopeChange(s)}
                        className={cn(segBtn(scope === s), 'sm:flex-none')}
                      >
                        {label}
                      </button>
                    )
                  })}
                </div>
                {canStaffMode && (
                  <div className={cn(segWrap, 'w-full sm:w-auto')}>
                    {([['store', 'Cửa hàng nộp'], ['staff_all', 'Từng dược sĩ nộp']] as const).map(([val, label]) => {
                      const active = (val === 'staff_all') === staffMode
                      return (
                        <button
                          key={val}
                          type="button"
                          aria-pressed={active}
                          onClick={() => setStaffMode(val === 'staff_all')}
                          className={cn(segBtn(active), 'sm:flex-none')}
                        >
                          {label}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Store / assignee */}
            {showMultiStore ? (
              <div className="space-y-2.5">
                <p className="text-[13px] text-muted-foreground">
                  {scope === 'all'
                    ? `Tất cả ${visibleStores.length} cửa hàng ${isRecurring ? 'sẽ nhận task định kỳ' : 'sẽ nhận task này'}`
                    : `Chọn cửa hàng (${selectedStoreIds.length} đã chọn)`}
                </p>
                {scope !== 'all' && (
                  <div className="@container">
                    <div className="grid grid-cols-1 @sm:grid-cols-2 @xl:grid-cols-3 content-start gap-1.5 max-h-[176px] overflow-y-auto">
                      {visibleStores.map((s) => {
                        const on = selectedStoreIds.includes(s.id)
                        return (
                          <label
                            key={s.id}
                            className={cn(
                              'flex items-center gap-2.5 min-h-[44px] md:min-h-[36px] px-2.5 py-1.5 rounded-v2-control border cursor-pointer text-[13px] transition-colors',
                              on ? 'v2:border-v2-selected-line v2:bg-accent' : 'hover:bg-muted',
                            )}
                          >
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() => toggleStoreSelection(s.id)}
                              className="accent-primary h-4 w-4 shrink-0"
                            />
                            <span className="min-w-0 break-words">{s.name}</span>
                          </label>
                        )
                      })}
                    </div>
                  </div>
                )}
                {effectiveStaffMode && isRecurring && (
                  <p className="text-[13px] text-muted-foreground">
                    Mỗi lần chạy sẽ giao cho <span className="font-medium">tất cả dược sĩ hiện có</span> của mỗi cửa hàng (cửa hàng chưa có dược sĩ sẽ được bỏ qua).
                  </p>
                )}
                {effectiveStaffMode && !isRecurring && (
                  <p className={cn('text-[13px]', storesWithoutStaff.length > 0 ? 'text-destructive' : 'text-muted-foreground')}>
                    {activeStoreIds.length === 0
                      ? 'Chọn cửa hàng để xem số dược sĩ sẽ nhận task.'
                      : storesWithoutStaff.length > 0
                        ? `Cửa hàng chưa có dược sĩ: ${storesWithoutStaff.slice(0, 3).map(s => s.name).join(', ')}${storesWithoutStaff.length > 3 ? ` +${storesWithoutStaff.length - 3} khác` : ''}.`
                        : `Sẽ tạo ${broadcastStaffTotal} task con cho ${broadcastStaffTotal} dược sĩ trên ${perStoreStaffInfo.filter(s => s.selectedCount > 0).length} cửa hàng.`}
                  </p>
                )}
                {/* Cleared stores are skipped (not blocked) — warn so it's never silent */}
                {effectiveStaffMode && storesWithoutStaff.length === 0 && storesClearedBySelection.length > 0 && (
                  <p className="text-[13px] text-status-warning">
                    ⚠ Sẽ bỏ qua {storesClearedBySelection.length} cửa hàng chưa chọn dược sĩ: {storesClearedBySelection.slice(0, 3).map(s => s.name).join(', ')}{storesClearedBySelection.length > 3 ? ` +${storesClearedBySelection.length - 3} khác` : ''}.
                  </p>
                )}
                {/* Per-store pharmacist pickers — default all checked (legacy behavior).
                    Stores cleared to zero are skipped on submit. One global search
                    filters across every store (each store alone has only 3-5 staff). */}
                {effectiveStaffMode && activeStoreIds.length > 0 && storesWithoutStaff.length === 0 && (() => {
                  const gq = deburr(staffQuery.trim())
                  const matches = (u: { full_name: string; email?: string | null }) =>
                    !gq || deburr(u.full_name).includes(gq) || deburr(u.email ?? '').includes(gq)
                  const visiblePerStore = gq
                    ? perStoreStaffInfo.filter((s) => s.staff.some(matches))
                    : perStoreStaffInfo
                  return (
                    <div className="space-y-2">
                      <input
                        type="text"
                        value={staffQuery}
                        onChange={(e) => setStaffQuery(e.target.value)}
                        placeholder="Tìm dược sĩ theo tên / email (mọi cửa hàng)…"
                        className="w-full h-[44px] md:h-[36px] rounded-v2-control border border-input bg-background px-3 text-[16px] md:text-[13px] focus:outline-none focus:ring-1 focus:ring-primary/40"
                      />
                      <div className="space-y-2.5 max-h-72 overflow-y-auto pr-0.5">
                        {visiblePerStore.length === 0 ? (
                          <p className="text-[13px] text-muted-foreground px-0.5 py-2">Không tìm thấy dược sĩ phù hợp.</p>
                        ) : visiblePerStore.map((s) => (
                          <div key={s.id} className="space-y-1">
                            <p className="text-[12px] font-semibold text-foreground/80 px-0.5">{s.name}</p>
                            <StaffChecklist
                              staff={s.staff}
                              excluded={excludedStaff}
                              onToggle={toggleStaffExcluded}
                              onBulk={setStoreStaffExcluded}
                              externalQuery={staffQuery}
                              hideOwnSearch
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })()}
                {/* Excel split — store-mode broadcast only; per-store data slices */}
                {showExcelSplit && (
                  <TaskExcelSplitPanel
                    stores={visibleStores}
                    allowedStoreIds={allowedStoreIds}
                    onChange={handleExcelChange}
                  />
                )}
              </div>
            ) : (
              <div className="space-y-2.5">
                <div className="flex flex-col sm:flex-row gap-2.5">
                  <div className="flex-1">
                    <SearchableSelect
                      value={storeId}
                      options={visibleStores.map((s) => ({ value: s.id, label: s.name }))}
                      onValueChange={handleStoreChange}
                      placeholder="Cửa hàng..."
                      triggerClassName={cn(control, 'rounded-v2-control')}
                    />
                  </div>
                  {!effectiveStaffMode && (
                    <div className="flex-1">
                      <SearchableSelect
                        value={assignedTo}
                        options={[
                          { value: '', label: 'Chưa phân công' },
                          ...storeUsers.map((u) => ({
                            value: u.id,
                            label: u.full_name,
                            description: u.role.replace('_', ' '),
                          })),
                        ]}
                        onValueChange={(v) => setAssignedTo(v ?? '')}
                        placeholder="Người thực hiện..."
                        triggerClassName={cn(control, 'rounded-v2-control')}
                      />
                    </div>
                  )}
                </div>
                {/* Preview when per-pharmacist mode is active */}
                {effectiveStaffMode && (
                  <p className={cn('text-[13px]', storeId && staffSelectedCount === 0 ? 'text-destructive' : 'text-muted-foreground')}>
                    {!storeId
                      ? 'Chọn cửa hàng để xem số dược sĩ sẽ nhận task.'
                      : staffCount === 0
                        ? 'Cửa hàng này chưa có dược sĩ nào — không thể tạo task theo dược sĩ.'
                        : staffSelectedCount === 0
                          ? 'Chưa chọn dược sĩ nào — chọn ít nhất một người bên dưới.'
                          : `Sẽ tạo ${staffSelectedCount} task con cho ${staffSelectedCount} dược sĩ. Quản lý cửa hàng nhận thông báo tổng quan.`}
                  </p>
                )}
                {/* Per-pharmacist picker (default = all checked = legacy behavior) */}
                {effectiveStaffMode && storeId && staffCount > 0 && (
                  <StaffChecklist
                    staff={singleStoreStaff}
                    excluded={excludedStaff}
                    onToggle={toggleStaffExcluded}
                    onBulk={setStoreStaffExcluded}
                  />
                )}
              </div>
            )}
          </Panel>

          {/* Panel tiêu đề + mô tả (artboard: tiêu đề 20px, thanh công cụ editor nền muted, nội dung) */}
          <Panel flush>
            <div className="px-4 md:px-5 pt-[18px] pb-1.5">
              <Input
                name="title"
                defaultValue={task?.title}
                required
                placeholder="Tiêu đề task..."
                className="w-full text-[20px] md:text-[20px] font-semibold border-0 p-0 h-auto focus-visible:ring-0 shadow-none placeholder:text-muted-foreground/40 bg-transparent dark:bg-transparent"
              />
            </div>
            {/* Description — WYSIWYG (bold/size/highlight/underline/align).
                Controlled `description` HTML mirrored into a hidden input so the
                existing formData('description') + draft DOM-read paths are unchanged. */}
            <input type="hidden" name="description" value={description} />
            <RichTextEditor value={description} onChange={setDescription} flush />
          </Panel>

          {/* Panel Đính kèm / Link — 2 nút bật/tắt giữ nguyên hành vi; nội dung mở ngay dưới */}
          <Panel flush>
            <div className="flex items-center gap-1 px-2.5 py-1.5">
              <button
                type="button"
                onClick={() => { setShowLinks(false); setShowAttachments(true); attachRef.current?.openFilePicker() }}
                className={toolBtn(showAttachments)}
              >
                <Paperclip className="h-4 w-4" />
                Đính kèm
                {attachments.length > 0 && (
                  <span className={countChip}>
                    {attachments.length}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => { setShowLinks((v) => !v); if (isEditMode) setShowAttachments(false) }}
                className={toolBtn(showLinks)}
              >
                <Link2 className="h-4 w-4" />
                Link
                {links.filter((l) => l.url.trim()).length > 0 && (
                  <span className={countChip}>
                    {links.filter((l) => l.url.trim()).length}
                  </span>
                )}
              </button>
            </div>

            {/* Attachment panel — always mounted (hidden when inactive) so the
                toolbar button can open the file picker imperatively via ref */}
            <div className={cn('border-t px-4 md:px-5 py-4 space-y-2', !showAttachments && 'hidden')}>
              <p className="text-[12px] text-v2-text-3">Ảnh hướng dẫn, file Excel, PDF, audio...</p>
              <TaskInputAttachments
                ref={attachRef}
                uploadId={uploadIdRef.current}
                value={attachments}
                onChange={setAttachments}
              />
            </div>

            {/* Links panel */}
            {showLinks && (
              <div className="border-t px-4 md:px-5 py-4 space-y-2">
                {links.length === 0 && (
                  <p className="text-[12px] text-v2-text-3">Link đăng ký, meeting, tài liệu...</p>
                )}
                {links.map((link, i) => (
                  <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto] gap-2">
                    <Input placeholder="Nhãn" value={link.label} onChange={(e) => updateLink(i, 'label', e.target.value)} className={control} />
                    <Input placeholder="https://..." type="url" value={link.url} onChange={(e) => updateLink(i, 'url', e.target.value)} className={control} />
                    <button type="button" aria-label="Xoá link" onClick={() => removeLink(i)} className="h-[44px] w-[44px] md:h-[36px] md:w-[36px] inline-flex items-center justify-center rounded-v2-control text-muted-foreground hover:bg-muted hover:text-destructive">
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))}
                <Button type="button" variant="ghost" size="sm" onClick={addLink} className="min-h-[44px] md:min-h-0 md:h-[32px] gap-1 px-2.5 text-[13px] text-accent-foreground">
                  <Plus className="h-3.5 w-3.5" /> Thêm link
                </Button>
              </div>
            )}
          </Panel>
        </div>

        {/* ── Right: config panel ── */}
        {/* Desktop: always-visible sidebar. Mobile: hidden by default, overlay when showMobileConfig. */}
        <div data-task-config className={cn(
          'bg-card flex flex-col',
          'lg:w-[360px] lg:max-w-[360px] lg:shrink-0 lg:border-l',
          showMobileConfig
            ? 'fixed inset-0 z-50 overflow-y-auto'
            : 'hidden lg:flex'
        )}>
          {/* Panel heading + mobile close */}
          <div className="px-5 py-1 lg:pt-5 lg:pb-0 border-b lg:border-b-0 flex items-center justify-between min-h-[52px] lg:min-h-0 shrink-0">
            <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-v2-text-3">
              Cấu hình task
            </p>
            <button
              type="button"
              aria-label="Đóng"
              onClick={() => setShowMobileConfig(false)}
              className="lg:hidden -mr-2.5 inline-flex h-[44px] w-[44px] items-center justify-center rounded-v2-control text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-5 space-y-[20px]">

            {/* Loại task — admin + new only */}
            {/* Loại task: SM KHÔNG có 'Định kỳ' — cả khối ẩn khi chỉ còn một lựa chọn. */}
            {canRecurring && !isEditMode && (
              <div className="space-y-2">
                <span className={sectionLabel}>Loại task</span>
                <div className={segWrap}>
                  {(['adhoc', 'recurring'] as TaskType[]).map((t) => (
                    <button
                      key={t}
                      type="button"
                      aria-pressed={taskType === t}
                      onClick={() => handleSetTaskType(t)}
                      className={segBtn(taskType === t)}
                    >
                      {t === 'adhoc' ? 'Phát sinh' : 'Định kỳ'}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Lịch định kỳ — recurring mode only */}
            {isRecurring && (
              <div className="space-y-3">
                <span className={sectionLabel}>Lịch chạy</span>

                <div>
                  <p className={fieldLabel}>Tần suất</p>
                  <div className={segWrap}>
                    {(['daily', 'weekly', 'monthly'] as const).map((f) => (
                      <button
                        key={f}
                        type="button"
                        aria-pressed={frequency === f}
                        onClick={() => setFrequency(f)}
                        className={segBtn(frequency === f)}
                      >
                        {f === 'daily' ? 'Mỗi ngày' : f === 'weekly' ? 'Mỗi tuần' : 'Mỗi tháng'}
                      </button>
                    ))}
                  </div>
                </div>

                {frequency === 'weekly' && (
                  <div>
                    <p className={fieldLabel}>Ngày trong tuần</p>
                    <div className="grid grid-cols-7 gap-1 md:flex md:flex-wrap md:gap-1.5">
                      {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                        <button
                          key={d}
                          type="button"
                          aria-pressed={weekdays.includes(d)}
                          onClick={() => toggleWeekday(d)}
                          className={cn(chipBtn(weekdays.includes(d)), 'min-w-0 px-1 md:min-w-[38px] md:px-2')}
                        >
                          {WEEKDAY_LABELS[d]}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {frequency === 'monthly' && (
                  <div>
                    <label className={fieldLabel}>Ngày trong tháng (1–28)</label>
                    <Input
                      type="number" min={1} max={28} value={monthDay}
                      onChange={(e) => setMonthDay(Number(e.target.value))}
                      className={cn(control, 'w-[88px]')}
                    />
                  </div>
                )}

                <div>
                  <label className={fieldLabel}>Giờ tạo task</label>
                  <Input type="time" value={runTime} onChange={(e) => setRunTime(e.target.value)} className={cn(control, 'w-[150px] md:w-[120px]')} />
                </div>

                <div>
                  <label className={fieldLabel}>Deadline sau khi tạo</label>
                  <div className="flex items-center gap-2">
                    <Select
                      value={customDeadline ? 'custom' : String(deadlineOffset)}
                      onValueChange={(v) => {
                        if (!v) return
                        if (v === 'custom') { setCustomDeadline(true); return }
                        setCustomDeadline(false)
                        setDeadlineOffset(Number(v))
                      }}
                    >
                      <SelectTrigger className={cn(selectCtl, 'w-[132px]')}>
                        <SelectValue>{customDeadline ? 'Tùy chỉnh' : `${deadlineOffset}h`}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {DEADLINE_PRESETS.map((h) => (
                          <SelectItem key={h} value={String(h)}>{h}h</SelectItem>
                        ))}
                        <SelectItem value="custom">Tùy chỉnh…</SelectItem>
                      </SelectContent>
                    </Select>
                    {customDeadline && (
                      <div className="flex items-center gap-1.5">
                        <Input
                          type="number" min={1} max={168} value={deadlineOffset}
                          onChange={(e) => {
                            const n = Number(e.target.value)
                            if (Number.isFinite(n)) setDeadlineOffset(Math.max(1, Math.min(168, Math.round(n))))
                          }}
                          className={cn(control, 'w-[88px]')}
                        />
                        <span className="text-[13px] text-muted-foreground">giờ</span>
                      </div>
                    )}
                  </div>
                </div>

                <div>
                  <label className={fieldLabel}>Ngày bắt đầu *</label>
                  <Input type="date" value={schedStartDate} onChange={(e) => setSchedStartDate(e.target.value)} required={isRecurring} className={control} />
                </div>

                <div>
                  <label className={fieldLabel}>Ngày kết thúc (tuỳ chọn)</label>
                  <Input type="date" value={schedEndDate} onChange={(e) => setSchedEndDate(e.target.value)} className={control} />
                </div>
              </div>
            )}

            {/* Danh mục + Ưu tiên — 2 cột như artboard */}
            <div className="grid grid-cols-2 gap-3">
              <div className="min-w-0 space-y-2">
                <span className={sectionLabel}>Danh mục</span>
                <Select value={category} onValueChange={handleCategoryChange}>
                  <SelectTrigger className={cn(selectCtl, 'w-full')}>
                    <SelectValue>{CATEGORY_LABEL[category]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(CATEGORY_LABEL) as TaskCategory[]).map((c) => (
                      <SelectItem key={c} value={c}>{CATEGORY_LABEL[c]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="min-w-0 space-y-2">
                <span className={sectionLabel}>Ưu tiên</span>
                <Select value={priority} onValueChange={(v) => { if (v) setPriority(v as TaskPriority) }}>
                  <SelectTrigger className={cn(selectCtl, 'w-full')}>
                    <SelectValue>{PRIORITY_LABEL[priority]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="normal">Bình thường</SelectItem>
                    <SelectItem value="urgent">Khẩn cấp</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Thời gian — hidden for recurring */}
            {!isRecurring && (
              <div className="space-y-2.5">
                <span className={sectionLabel}>Thời gian</span>
                <div>
                  <label className={fieldLabel}>Ngày bắt đầu <span className="text-destructive">*</span></label>
                  <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-2">
                    <Input type="date" required value={startDate} onChange={(e) => setStartDate(e.target.value)} className={control} />
                    <Input type="time" required value={startTime} onChange={(e) => setStartTime(e.target.value)} className={control} />
                  </div>
                  <input type="hidden" name="start_date" value={combineDateTimeStr(startDate, startTime)} />
                </div>
                <div>
                  <label className={fieldLabel}>Deadline <span className="text-destructive">*</span></label>
                  <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-2">
                    <Input type="date" required value={deadlineDate} onChange={(e) => setDeadlineDate(e.target.value)} className={control} />
                    <Input type="time" required value={deadlineTime} onChange={(e) => setDeadlineTime(e.target.value)} className={control} />
                  </div>
                  <input type="hidden" name="deadline" value={combineDateTimeStr(deadlineDate, deadlineTime)} />
                </div>
              </div>
            )}

            {/* Output cần nộp — chips */}
            <div className="space-y-2">
              <span className={sectionLabel}>Output cần nộp <span className="text-destructive">*</span></span>
              <div className="flex flex-wrap gap-1.5">
                {OUTPUT_OPTIONS.map(({ value, label }) => {
                  const on = outputs.includes(value)
                  return (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleOutput(value)}
                      className={cn(chipBtn(on), 'px-2.5')}
                    >
                      {on
                        ? <Check aria-hidden="true" className="h-3.5 w-3.5" />
                        : <Plus aria-hidden="true" className="h-3.5 w-3.5" />}
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>

          </div>
        </div>
      </div>
    </form>
  )
}

// Pharmacist multi-select for staff_all mode. A checked box = that pharmacist gets
// a task; default is all checked (the legacy behavior). Selection is tracked by an
// "excluded" set in the parent, so an untouched form sends no override. A search
// box (shown when the list is long) filters by name/email; bulk select/clear acts
// on the currently-filtered rows so it composes with the search.
function StaffChecklist({ staff, excluded, onToggle, onBulk, externalQuery, hideOwnSearch }: {
  staff: { id: string; full_name: string; email?: string | null }[]
  excluded: Set<string>
  onToggle: (id: string) => void
  onBulk: (ids: string[], exclude: boolean) => void
  // Broadcast multi-store passes a single global search down (hideOwnSearch=true)
  // so we filter by it but don't render a per-store box. Single-store keeps its own.
  externalQuery?: string
  hideOwnSearch?: boolean
}) {
  const [internalQuery, setInternalQuery] = useState('')
  const activeQuery = hideOwnSearch ? (externalQuery ?? '') : internalQuery
  const q = deburr(activeQuery.trim())
  const filtered = q
    ? staff.filter((s) => deburr(s.full_name).includes(q) || deburr(s.email ?? '').includes(q))
    : staff
  const selectedCount = staff.filter((s) => !excluded.has(s.id)).length
  // Bulk acts on the filtered rows; the label reflects whether they're all selected.
  const filteredIds = filtered.map((s) => s.id)
  const allFilteredSelected = filtered.length > 0 && filtered.every((s) => !excluded.has(s.id))
  const showSearch = !hideOwnSearch && staff.length > 3
  return (
    <div className="rounded-v2-control border overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 border-b bg-muted">
        <span className="text-[12px] text-muted-foreground">{selectedCount}/{staff.length} dược sĩ</span>
        <button
          type="button"
          onClick={() => onBulk(filteredIds, allFilteredSelected)}
          className="min-h-[44px] md:min-h-[32px] px-1 text-[12px] font-medium text-accent-foreground hover:underline disabled:opacity-40 disabled:no-underline"
          disabled={filtered.length === 0}
        >
          {allFilteredSelected ? 'Bỏ chọn tất cả' : 'Chọn tất cả'}{q && filtered.length !== staff.length ? ` (${filtered.length})` : ''}
        </button>
      </div>
      {showSearch && (
        <div className="px-2 py-1.5 border-b">
          <input
            type="text"
            value={internalQuery}
            onChange={(e) => setInternalQuery(e.target.value)}
            placeholder="Tìm dược sĩ theo tên / email…"
            className="w-full h-[44px] md:h-[32px] rounded-v2-control border border-input bg-background px-2.5 text-[16px] md:text-[13px] focus:outline-none focus:ring-1 focus:ring-primary/40"
          />
        </div>
      )}
      <div className="max-h-[176px] overflow-y-auto divide-y">
        {filtered.length === 0 ? (
          <p className="px-3 py-2 text-[13px] text-muted-foreground">Không tìm thấy dược sĩ phù hợp.</p>
        ) : filtered.map((s) => (
          <label key={s.id} className="flex items-center gap-2.5 px-3 py-1 min-h-[44px] md:min-h-[34px] cursor-pointer hover:bg-muted text-[13px]">
            <input
              type="checkbox"
              checked={!excluded.has(s.id)}
              onChange={() => onToggle(s.id)}
              className="accent-primary h-4 w-4 shrink-0"
            />
            <span className="truncate">
              {s.full_name}
              {s.email ? <span className="text-v2-text-3 text-[12px]"> · {s.email}</span> : null}
            </span>
          </label>
        ))}
      </div>
    </div>
  )
}
