import { cn } from '@/lib/utils'

// Categorical TAG chip (taxonomy: loại task, nguồn Định kỳ/Phát sinh, phương
// thức nộp…). NOT a status — semantic outcomes (thành công/lỗi/quá hạn…) must
// use StatusBadge tones instead. Hues are purely distinctive: they carry no
// good/bad meaning, so e.g. "Thu hồi" can stay red-family without implying an
// error (Pilot-2 review P1).
// Raw pastel classes are allowed ONLY inside components/ds/ — this file is the
// single home for categorical hues (light + dark pairs). Routes pick a hue per
// domain value and keep the mapping next to their labels.
export type TagHue =
  | 'blue' | 'red' | 'green' | 'amber' | 'teal'
  | 'indigo' | 'sky' | 'slate' | 'gray'

const HUE: Record<TagHue, string> = {
  blue:   'bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300',
  red:    'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
  green:  'bg-green-100 text-green-700 dark:bg-green-950/60 dark:text-green-300',
  amber:  'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
  teal:   'bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300',
  indigo: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300',
  sky:    'bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300',
  slate:  'bg-slate-100 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300',
  gray:   'bg-gray-100 text-gray-600 dark:bg-gray-800/60 dark:text-gray-300',
}

export function TagBadge({
  hue, children, className,
}: {
  hue: TagHue
  children: React.ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded whitespace-nowrap',
        HUE[hue],
        className,
      )}
    >
      {children}
    </span>
  )
}
