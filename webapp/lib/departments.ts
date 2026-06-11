// Department color presets — `departments.color` stores one of these KEYS
// (CHECK-constrained in migration 050); the classes live here so the DB never
// carries raw CSS. Same light-bg badge idiom as ROLE_COLORS / CATEGORY_STYLE.

export type DepartmentColor =
  | 'orange' | 'blue' | 'green' | 'purple' | 'teal' | 'pink' | 'amber' | 'slate'

export interface Department {
  id:    string
  name:  string
  color: string
}

export const DEPARTMENT_COLOR_KEYS: DepartmentColor[] = [
  'orange', 'blue', 'green', 'purple', 'teal', 'pink', 'amber', 'slate',
]

const BADGE: Record<DepartmentColor, string> = {
  orange: 'bg-orange-100 text-orange-700',
  blue:   'bg-blue-100 text-blue-700',
  green:  'bg-green-100 text-green-700',
  purple: 'bg-purple-100 text-purple-700',
  teal:   'bg-teal-100 text-teal-700',
  pink:   'bg-pink-100 text-pink-700',
  amber:  'bg-amber-100 text-amber-700',
  slate:  'bg-slate-100 text-slate-600',
}

// Solid dot used by the color picker and compact lists.
const DOT: Record<DepartmentColor, string> = {
  orange: 'bg-orange-500',
  blue:   'bg-blue-500',
  green:  'bg-green-500',
  purple: 'bg-purple-500',
  teal:   'bg-teal-500',
  pink:   'bg-pink-500',
  amber:  'bg-amber-500',
  slate:  'bg-slate-500',
}

export function deptBadgeClass(color: string | null | undefined): string {
  return BADGE[(color ?? '') as DepartmentColor] ?? 'bg-gray-100 text-gray-600'
}

export function deptDotClass(color: string | null | undefined): string {
  return DOT[(color ?? '') as DepartmentColor] ?? 'bg-gray-400'
}
