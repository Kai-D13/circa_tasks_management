'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export type SearchableOption = {
  value: string         // "" is valid (means none / all)
  label: string
  description?: string  // secondary line, e.g. role label or email
  keywords?: string[]   // extra search terms — aliases, store codes, emails
  disabled?: boolean    // renders muted and cannot be selected
}

export interface SearchableSelectProps {
  value: string
  options: SearchableOption[]
  onValueChange: (value: string) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  clearable?: boolean
  disabled?: boolean
  className?: string
  triggerClassName?: string
}

// Normalize Vietnamese: lowercase + strip combining diacritics + đ→d.
// Allows "tam viet" to match "Tâm Việt" and "pos059" to match "POS059".
function normalizeVN(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .trim()
}

export function SearchableSelect({
  value,
  options,
  onValueChange,
  placeholder = 'Chọn...',
  searchPlaceholder = 'Tìm kiếm...',
  emptyText = 'Không tìm thấy',
  clearable = false,
  disabled = false,
  className,
  triggerClassName,
}: SearchableSelectProps) {
  const [open,        setOpen]        = useState(false)
  const [query,       setQuery]       = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef     = useRef<HTMLInputElement>(null)
  const listRef      = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    if (!query.trim()) return options
    const q = normalizeVN(query)
    return options.filter((o) => {
      const haystack = normalizeVN(
        [o.label, o.description ?? '', ...(o.keywords ?? [])].join(' ')
      )
      return haystack.includes(q)
    })
  }, [options, query])

  const selectedOption = options.find((o) => o.value === value)
  const displayLabel   = selectedOption?.label ?? ''

  // Auto-focus search input when dropdown opens
  useEffect(() => {
    if (open) {
      setQuery('')
      setHighlighted(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // Scroll highlighted item into view
  useEffect(() => {
    if (!open) return
    const item = listRef.current?.children[highlighted] as HTMLElement | undefined
    item?.scrollIntoView({ block: 'nearest' })
  }, [highlighted, open])

  // Close on click outside
  useEffect(() => {
    function handleMousedown(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleMousedown)
    return () => document.removeEventListener('mousedown', handleMousedown)
  }, [])

  function select(opt: SearchableOption) {
    if (opt.disabled) return
    onValueChange(opt.value)
    setOpen(false)
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true) }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      // Skip disabled items
      let next = highlighted + 1
      while (next < filtered.length && filtered[next]?.disabled) next++
      if (next < filtered.length) setHighlighted(next)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      let prev = highlighted - 1
      while (prev >= 0 && filtered[prev]?.disabled) prev--
      if (prev >= 0) setHighlighted(prev)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (filtered[highlighted]) select(filtered[highlighted])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
    // Tab: propagates naturally — browser shifts focus, dropdown stays until click-outside
  }

  return (
    <div ref={containerRef} className={cn('relative', className)} onKeyDown={handleKeyDown}>
      {/* Trigger — explicit string aria-expanded satisfies strict ARIA linters */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 text-sm ring-offset-background',
          'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
          'disabled:cursor-not-allowed disabled:opacity-50',
          open && 'ring-2 ring-ring ring-offset-2',
          triggerClassName,
        )}
        aria-haspopup="listbox"
        aria-expanded={open ? 'true' : 'false'}
      >
        <span className={cn('truncate', !displayLabel && 'text-muted-foreground')}>
          {displayLabel || placeholder}
        </span>
        <span className="ml-2 flex shrink-0 items-center gap-1">
          {clearable && value !== '' && (
            <span
              role="button"
              tabIndex={-1}
              onClick={(e) => { e.stopPropagation(); onValueChange('') }}
              className="rounded p-0.5 text-muted-foreground hover:text-foreground"
              aria-label="Xóa"
            >
              <X className="h-3.5 w-3.5" />
            </span>
          )}
          <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
        </span>
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute left-0 z-50 mt-1 w-full min-w-[10rem] rounded-md border bg-popover shadow-md">
          {/* Search input */}
          <div className="flex items-center border-b px-3">
            <Search className="mr-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setHighlighted(0) }}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              title={searchPlaceholder}
              className="flex h-9 w-full bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>

          {/* Options — plain div list; visual cues (Check, opacity) convey state
              without strict listbox/option ARIA contracts that require string-literal
              aria-selected values incompatible with JSX expression linters */}
          <div ref={listRef} className="max-h-56 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-center text-sm text-muted-foreground">{emptyText}</div>
            ) : (
              filtered.map((opt, idx) => (
                <div
                  key={opt.value}
                  onClick={() => select(opt)}
                  onMouseEnter={() => !opt.disabled && setHighlighted(idx)}
                  className={cn(
                    'flex select-none items-center rounded-sm px-3 py-2 text-sm',
                    opt.disabled
                      ? 'cursor-not-allowed opacity-50'
                      : 'cursor-pointer',
                    !opt.disabled && idx === highlighted && 'bg-accent text-accent-foreground',
                    opt.value === value && 'font-medium',
                  )}
                >
                  <Check className={cn('mr-2 h-4 w-4 shrink-0', opt.value === value ? 'opacity-100' : 'opacity-0')} />
                  <span className="flex-1 truncate">{opt.label}</span>
                  {opt.description && (
                    <span className="ml-2 shrink-0 text-xs text-muted-foreground">{opt.description}</span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
