import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// A PostgREST FK embed (e.g. users!completed_by(full_name)) can arrive as an
// object OR a 1-element array depending on how the relationship is resolved.
// Normalize to the full_name (or null).
export function embeddedName(v: unknown): string | null {
  if (Array.isArray(v)) return (v[0] as { full_name?: string } | undefined)?.full_name ?? null
  return (v as { full_name?: string } | null)?.full_name ?? null
}
